#!/usr/bin/env python3
"""Measure person mattes, without changing originals or the shoot index.

Crop JSON is framing.ts CropPath: source pixels, top-left, and optional {t,x}
keyframes in piece-relative seconds with cropPathFor's 15% endpoint easing.
Output is lossless FFV1, 8-bit gray, in Matroska (use an .mkv suffix).
"""
import argparse
import fcntl
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
import sys; sys.path.insert(0, str(Path(__file__).resolve().parent)); from setup import tool

VERSION = 1


def emit(clip_id='', stage='matte', pct=0, **extra):
    print(json.dumps({'clipId': clip_id, 'stage': stage, 'pct': pct, **extra}, allow_nan=False), flush=True)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


@contextmanager
def locked(path):
    # A different clip/key may render concurrently; same-key jobs share the result.
    with path.open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def atomic_bytes(path, data):
    fd, name = tempfile.mkstemp(prefix='matte-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError('must be finite and positive')
    return number


def size_value(value):
    try:
        w, h = map(int, value.lower().split('x'))
        if not (0 < w <= 8192 and 0 < h <= 8192):
            raise ValueError()
        return [w, h]
    except ValueError as error:
        raise argparse.ArgumentTypeError('size must be WIDTHxHEIGHT (1..8192)') from error


def finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def crop_value(rect, path, duration):
    if rect is not None:
        values = list(map(float, rect.split(',')))
        if len(values) != 4:
            raise ValueError('--crop needs x,y,w,h')
        crop = dict(zip(('x', 'y', 'w', 'h'), values))
    elif path is not None:
        # Accept an inline object or a JSON file, without imposing shell expansion.
        crop = json.loads(path if path.lstrip().startswith('{') else Path(path).expanduser().read_text())
    else:
        return None
    if not isinstance(crop, dict) or set(crop) - {'x', 'y', 'w', 'h', 'keyframes'}:
        raise ValueError('crop must be a CropPath object')
    if not all(finite_number(crop.get(k)) for k in ('x', 'y', 'w', 'h')):
        raise ValueError('crop coordinates must be finite numbers')
    if crop['x'] < 0 or crop['y'] < 0 or crop['w'] <= 0 or crop['h'] <= 0:
        raise ValueError('crop origin must be nonnegative and size positive')
    result = {k: float(crop[k]) for k in ('x', 'y', 'w', 'h')}
    if 'keyframes' in crop:
        keys = crop['keyframes']
        if not isinstance(keys, list):
            raise ValueError('keyframes must be an array')
        last = -1
        for key in keys:
            if (not isinstance(key, dict) or set(key) != {'t', 'x'}
                    or not all(finite_number(key[k]) for k in ('t', 'x'))
                    or not last < key['t'] <= duration + 1e-6 or key['t'] < 0 or key['x'] < 0):
                raise ValueError('keyframes need increasing piece-relative times and nonnegative x')
            last = key['t']
        result['keyframes'] = [{'t': float(k['t']), 'x': float(k['x'])} for k in keys]
    return result


def inside(path, directory):
    return path.resolve().is_relative_to(directory.resolve())


def source_clip(root, clip_id):
    directory = root / '.sidething'
    index = directory / 'index.json'
    if directory.is_symlink() or index.is_symlink():
        raise RuntimeError('refusing a symlinked .sidething directory or index')
    clips = json.loads(index.read_text())['clips']
    matches = [c for c in clips if c['id'] == clip_id]
    if not matches:
        matches = [c for c in clips if c['id'].endswith('_' + clip_id)]
    if len(matches) != 1:
        raise ValueError('clip ID must identify exactly one clip')
    clip = matches[0]
    relative = Path(clip['file'])
    if relative.is_absolute() or '..' in relative.parts or '.sidething' in relative.parts:
        raise ValueError('clip file must name an original relative to the shoot')
    # Read the original, never the proxy: crop geometry refers to original pixels.
    source = root / relative
    if not source.is_file():
        raise ValueError(f'original not found: {source}')
    return clip, source


def stat_key(source):
    stat = source.stat()
    return {'path': str(source.resolve()), 'size': stat.st_size, 'mtimeNs': stat.st_mtime_ns}


def signature(source, args, crop, ffmpeg):
    return {'version': VERSION, 'source': stat_key(source), 's': args.s, 'e': args.e,
            'fps': args.fps, 'size': args.size, 'crop': crop, 'format': 'ffv1-gray-matroska',
            'tool': hashlib.sha256(Path(tool('matte')).read_bytes() + Path(__file__).read_bytes()).hexdigest(),
            'encoder': stat_key(Path(ffmpeg)), 'os': list(os.uname())[:3]}


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def valid_cache(path, meta, key):
    if path.is_symlink() or meta.is_symlink():
        raise RuntimeError('refusing symlinked matte cache entries')
    try:
        row = json.loads(meta.read_text())
        return row if (row['inputs'] == key and path.stat().st_size > 0
                       and row['sha256'] == sha256(path)) else None
    except (OSError, ValueError, KeyError):
        return None


def destination(out, root, directory, source):
    out = out.expanduser().absolute()
    if out.is_symlink() or out.resolve() == source.resolve():
        raise ValueError('output must not replace original media or a symlink')
    if inside(out, root) and not inside(out, directory):
        raise ValueError('outputs inside a shoot must stay in .sidething/mattes/')
    if out.exists() and not out.is_file():
        raise ValueError('output must be a file')
    return out


def publish(path, out):
    if out.resolve() == path.resolve():
        return
    if out.exists():
        if sha256(out) == sha256(path):
            return
        raise ValueError(f'output already exists with different contents: {out}')
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='matte-copy-', suffix='.tmp', dir=out.parent)
    os.close(fd)
    try:
        shutil.copyfile(path, temporary)
        # Link is atomic and refuses a concurrent creator; never overwrite a file.
        os.link(temporary, out)
    finally:
        Path(temporary).unlink(missing_ok=True)


def measure(binary, source, args, crop, ffmpeg, output, clip_id):
    command = [str(binary), str(source), str(args.s), str(args.e), str(args.fps),
               *map(str, args.size), canonical(crop), ffmpeg, str(output)]
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
    final = None
    expected = math.ceil((args.e - args.s) * args.fps - 1e-7)
    last = 0
    try:
        for line in proc.stdout:
            row = json.loads(line)
            frames = row.get('frames')
            if (not isinstance(frames, int) or not last <= frames <= expected
                    or not finite_number(row.get('pct')) or not 0 <= row['pct'] <= 100):
                raise RuntimeError('invalid progress from matte tool')
            last = frames
            if row['pct'] == 100:
                if (frames != expected or not finite_number(row.get('seconds')) or row['seconds'] <= 0
                        or not finite_number(row.get('fps')) or row['fps'] <= 0):
                    raise RuntimeError('invalid final measurement from matte tool')
                final = row
            emit(clip_id, **row)
        if proc.wait():
            raise RuntimeError(f'matte tool failed (exit {proc.returncode}); see stderr')
        if final is None or not output.is_file() or not output.stat().st_size:
            raise RuntimeError('matte tool did not finish a nonempty output')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
    return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('shoot')
    parser.add_argument('--clip', required=True)
    parser.add_argument('--s', type=float, required=True)
    parser.add_argument('--e', type=float, required=True)
    parser.add_argument('--fps', type=positive, default=25)
    parser.add_argument('--size', type=size_value, default=[1080, 1920])
    crops = parser.add_mutually_exclusive_group()
    crops.add_argument('--crop')
    crops.add_argument('--crop-path')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--preview', action='store_true', help='measure the managed playback proxy')
    parser.add_argument('--force', action='store_true', help='remeasure even if cached (for timing)')
    args = parser.parse_args()
    clip_id = args.clip
    try:
        if not (math.isfinite(args.s) and math.isfinite(args.e) and 0 <= args.s < args.e and args.fps <= 240):
            raise ValueError('span must be finite, 0 <= s < e, and fps <= 240')
        crop = crop_value(args.crop, args.crop_path, args.e - args.s)
        root = Path(args.shoot).expanduser().resolve()
        clip, source = source_clip(root, args.clip)
        clip_id = clip['id']
        if args.preview:
            directory = root / '.sidething' / 'proxies'
            proxy = clip.get('proxy')
            if not proxy or directory.is_symlink():
                raise ValueError('managed preview is unavailable')
            source = directory / proxy
            if source.is_symlink() or not inside(source, directory) or not source.is_file():
                raise ValueError('preview must stay inside the managed proxy cache')
            if crop is not None:
                raise ValueError('preview masks use the whole proxy')
        duration = clip.get('meta', {}).get('durationS')
        if finite_number(duration) and args.e > duration + 1e-6:
            raise ValueError('span exceeds indexed source duration')
        directory = root / '.sidething' / 'mattes'
        if directory.is_symlink() or not inside(directory, root / '.sidething'):
            raise ValueError('refusing a matte cache outside the shoot .sidething directory')
        out = destination(args.out, root, directory, source)
        ffmpeg = str(tool('ffmpeg'))
        if not ffmpeg:
            raise RuntimeError('ffmpeg is required on PATH')
        key = signature(source, args, crop, ffmpeg)
        digest = hashlib.sha256(canonical(key).encode()).hexdigest()
        directory.mkdir(parents=True, exist_ok=True)
        path, meta = directory / (digest + '.mkv'), directory / (digest + '.json')
        # Keep --out away from metadata, locks, or another generated cache key.
        if inside(out, directory) and out.resolve() != path.resolve():
            reserved = len(out.stem) == 64 and all(c in '0123456789abcdef' for c in out.stem)
            if out.suffix.lower() != '.mkv' or reserved:
                raise ValueError('named outputs in mattes must use .mkv and avoid reserved cache-key names')
        lock = directory / (digest + '.lock')
        if lock.is_symlink():
            raise RuntimeError('refusing a symlinked cache lock')
        with locked(lock):
            result = valid_cache(path, meta, key)
            cached = bool(result) and not args.force
            if not cached:
                binary = tool('matte')
                fd, temporary = tempfile.mkstemp(prefix='matte-', suffix='.mkv.tmp', dir=directory)
                os.close(fd)
                started = time.monotonic()
                try:
                    stats = measure(binary, source, args, crop, ffmpeg, Path(temporary), clip_id)
                    if signature(source, args, crop, ffmpeg) != key:
                        raise RuntimeError('input or tool changed during measurement; retry')
                    result = {'inputs': key, 'stats': stats, 'wallSeconds': time.monotonic() - started,
                              'sha256': sha256(Path(temporary))}
                    result['wallFps'] = stats['frames'] / result['wallSeconds']
                    os.replace(temporary, path)
                    atomic_bytes(meta, (canonical(result) + '\n').encode())
                finally:
                    Path(temporary).unlink(missing_ok=True)
            publish(path, out)
            emit(clip_id, pct=100, cached=cached, out=str(out), cache=str(path),
                 **{k: v for k, v in result['stats'].items() if k != 'pct'},
                 wallSeconds=result['wallSeconds'], wallFps=result['wallFps'])
        return 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        emit(clip_id, stage='error', pct=100, error=str(error))
        return 1


if __name__ == '__main__':
    sys.exit(main())
