#!/usr/bin/env python3
"""Upgrade library measurements only. Never reads dialogue or judgement pictures."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from quality import index_path, quality_tool, source_path
from place import named_place, video_gps, photo_gps


def receipt(root, clip, version):
    source = source_path(root, clip['file'])
    stat = source.stat()
    return {'tool': version, 'file': clip['file'], 'size': stat.st_size,
            'mtimeNs': str(stat.st_mtime_ns), 'rotation': (clip.get('meta') or {}).get('rotation', 0)}


def same_stamp(left, right):
    # Old quality receipts used JSON numbers. A JS index writer can round a
    # nanosecond integer by a few hundred ns; new receipts use lossless strings.
    try:
        return left.get('size') == right['size'] and abs(int(left['mtimeNs']) - int(right['mtimeNs'])) <= 1000
    except (KeyError, TypeError, ValueError):
        return False


def cached_prints(index, clip, key):
    row = index.get('_cache', {}).get('libraryPrints', {}).get(clip['id'], {})
    old_key = row.get('key', {})
    if (same_stamp(old_key, key) and all(old_key.get(f) == key.get(f) for f in ('tool', 'file', 'rotation'))
            and len(row.get('prints', [])) == 3):
        return row['prints']
    row = index.get('_cache', {}).get('quality', {}).get(clip['id'], {})
    old = row.get('key', {})
    original = old.get('original', {})
    # Absolute paths change when a folder moves. Content receipts and tool
    # revision are the evidence; a transcript change cannot invalidate prints.
    if (old.get('tool') == key['tool'] and same_stamp(original, key)
            and str(original.get('path', '')).endswith('/' + clip['file']) and len(row.get('prints', [])) == 3):
        return row['prints']
    return None


def save(root, update):
    path = index_path(root)
    before = path.read_bytes()
    fresh = json.loads(before)
    update(fresh)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='library-', delete=False) as handle:
        json.dump(fresh, handle, allow_nan=False)
    try:
        if path.read_bytes() != before:
            raise RuntimeError('Footage changed while sorting. Open it again to retry.')
        os.replace(handle.name, path)
    finally:
        Path(handle.name).unlink(missing_ok=True)


def upgrade(root, revision, progress=lambda row: None):
    start = time.monotonic()
    index = json.loads(index_path(root).read_bytes())
    binary, version = quality_tool()
    left_file = root / '.sidething/left-out.json'
    left_out = set(json.loads(left_file.read_text())) if left_file.is_file() else set()
    clips = [c for c in index['clips'] if c.get('meta') and not c.get('leftOut') and c['id'] not in left_out
             and source_path(root, c.get('photo', {}).get('file', c['file'])).is_file()]
    manifest, measured, cached, failures = [], [], [], []
    for n, clip in enumerate(clips):
        try:
            if not clip.get('_placeRead'):
                original = source_path(root, clip.get('photo', {}).get('file', clip['file']))
                gps = photo_gps(original) if clip.get('photo') else video_gps(original)
                place = named_place(root, gps)
                def put_place(fresh):
                    current = next(c for c in fresh['clips'] if c['id'] == clip['id'])
                    current.update(place=place, _placeRead=True)
                save(root, put_place)
            key = receipt(root, clip, version)
            prints = cached_prints(index, clip, key)
            if prints is None:
                # Three Vision observations only. No contact sheets, smart
                # frames, audio decode, transcription or model task.
                source = source_path(root, clip['file'])
                if clip.get('proxy'):
                    proxy = root / '.sidething/proxies' / clip['proxy']
                    if proxy.is_file():
                        source = proxy
                result = subprocess.run([str(binary), '--prints', str(source)], capture_output=True, text=True, timeout=60, check=True)
                prints = json.loads(result.stdout)['prints']
                if len(prints) != 3:
                    raise RuntimeError('Incomplete picture measurements')
                measured.append(clip['id'])
            else:
                cached.append(clip['id'])
            def put_prints(fresh):
                fresh.setdefault('_cache', {}).setdefault('libraryPrints', {})[clip['id']] = {'key': key, 'prints': prints}
            save(root, put_prints)
            manifest.append({'id': clip['id'], 'duration': clip['meta']['durationS'], 'prints': prints})
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
            failures.append({'id': clip['id'], 'error': str(error)})
        elapsed = time.monotonic() - start
        progress({'pct': (n + 1) / max(1, len(clips)) * 95,
                  'etaS': elapsed / (n + 1) * (len(clips) - n - 1), 'completed': n + 1})
    with tempfile.NamedTemporaryFile(mode='w', dir=index_path(root).parent, prefix='library-prints-') as handle:
        json.dump(manifest, handle); handle.flush()
        result = subprocess.run([str(binary), '--duplicates', handle.name], capture_output=True, text=True, timeout=120, check=True)
    pairs = json.loads(result.stdout)['pairs']
    def finish(fresh):
        cache = fresh.setdefault('_cache', {})
        cache['featurePairs'] = pairs
        if not failures:
            cache['libraryUpgrade'] = revision
    save(root, finish)
    report = {'wallS': time.monotonic() - start, 'measured': measured, 'cached': cached, 'failures': failures, 'pairs': len(pairs)}
    progress({'pct': 100, 'etaS': 0, 'report': report})
    return report


if __name__ == '__main__':
    report = upgrade(Path(sys.argv[1]).resolve(), sys.argv[2], lambda row: print(json.dumps(row), flush=True))
    sys.exit(1 if report['failures'] else 0)
