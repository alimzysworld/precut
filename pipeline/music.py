#!/usr/bin/env python3
"""Read-only music measurements. JSON on stdout; cache lives in app userData.

Usage: python -I pipeline/music.py FOLDER --cache USERDATA/music-cache.json
The energy curve is one RMS dBFS value per second (mono, 22050 Hz).
Integrated LUFS measures the original track's selected audio stream in stereo,
matching the preview mix's channel layout.
Build/drop are energy-curve estimates, not a claim about musical structure.
"""
import argparse
import json
import math
import os
from pathlib import Path
import sys; sys.path.insert(0, str(Path(__file__).resolve().parent)); from setup import tool
import subprocess
import sys
import tempfile
from source_audio import audio_input

EXTENSIONS = {'.mp3', '.m4a', '.aac', '.wav', '.aiff', '.aif', '.flac', '.ogg', '.opus', '.mp4'}
VERSION = 3


def analyse(file):
    import librosa
    import numpy as np
    sr = 22050
    decoded = subprocess.run([tool('ffmpeg'), '-v', 'error', *audio_input(file), '-vn',
                              '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'],
                             check=True, capture_output=True)
    y = np.frombuffer(decoded.stdout, dtype='<f4').copy()
    if not len(y):
        raise ValueError('empty audio')
    measured = subprocess.run([tool('ffmpeg'), '-hide_banner', '-nostats', *audio_input(file),
                               '-vn', '-af',
                               'aresample=48000,aformat=channel_layouts=stereo,'
                               'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
                               '-f', 'null', '-'], check=True, capture_output=True, text=True)
    # loudnorm's final JSON is on stderr, after ffmpeg's input/output headers.
    report = measured.stderr[measured.stderr.rfind('{'):measured.stderr.rfind('}') + 1]
    integrated_lufs = float(json.loads(report)['input_i'])
    if not math.isfinite(integrated_lufs):
        raise ValueError('track has no measurable integrated loudness')
    duration = len(y) / sr
    envelope = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, frames = librosa.beat.beat_track(onset_envelope=envelope, sr=sr)
    beats = librosa.frames_to_time(frames, sr=sr)
    loudness = np.array([20 * math.log10(max(1e-6, float(np.sqrt(np.mean(y[i:i+sr] ** 2)))))
                         for i in range(0, len(y), sr)])
    # Three-second smoothing; exclude fade-in/out and require a sustained rise.
    smooth = np.convolve(np.pad(loudness, (1, 1), mode='edge'), np.ones(3)/3, mode='valid')
    candidates = []
    for t in range(4, max(4, len(smooth) - 3)):
        before = float(np.mean(smooth[max(0, t-6):t]))
        after = float(np.mean(smooth[t:t+3]))
        if after - before >= 2 and after >= float(np.percentile(smooth, 55)):
            candidates.append((after - before, t))
    drop = max(candidates)[1] if candidates else None
    build = None
    if drop is not None:
        start = max(0, drop - 16)
        build = start + int(np.argmin(smooth[start:drop]))
    clock = lambda t: f'{int(t)//60}:{int(t)%60:02d}'
    if drop is not None:
        opening = f'quiet intro to {clock(build)}' if build <= 16 else f'quieter passage at {clock(build)}'
        energy = f'{opening}, builds, drop at {clock(drop)}'
    elif float(np.ptp(smooth)) < 4:
        energy = 'steady energy throughout; no clear build or drop'
    else:
        energy = f'energy peaks near {clock(int(np.argmax(smooth)))}; no clear build or drop'
    return {'file': str(file), 'name': file.name, 'durationS': round(duration, 4),
            'integratedLUFS': integrated_lufs,
            'tempo': round(float(np.asarray(tempo).reshape(-1)[0]), 2),
            'beats': [round(float(t), 5) for t in beats if t < duration],
            'loudnessDb': [round(float(v), 2) for v in loudness],
            'moments': {'buildS': build, 'dropS': drop}, 'energy': energy}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path, nargs='?')
    parser.add_argument('--files', type=Path, nargs='*', default=[])
    parser.add_argument('--cache', type=Path, default=Path.home() / 'Library/Application Support/precut/music-cache.json')
    args = parser.parse_args()
    folder = args.folder.resolve() if args.folder else None
    cache_file = args.cache.resolve()
    if folder and (cache_file == folder or folder in cache_file.parents):
        raise ValueError('Music cache must be outside the music folder')
    try:
        cache = json.loads(cache_file.read_text())
        if cache.get('version') != VERSION or not isinstance(cache.get('entries'), dict):
            cache = {'version': VERSION, 'entries': {}}
    except (OSError, ValueError, AttributeError):
        cache = {'version': VERSION, 'entries': {}}
    tracks, errors = [], []
    files = set(folder.rglob('*')) if folder and folder.is_dir() else set()
    files.update(file.resolve() for file in args.files)
    for file in sorted(files):
        if not file.is_file() or file.suffix.lower() not in EXTENSIONS:
            continue
        file = file.resolve()
        try:
            stat = file.stat()
            key = json.dumps([str(file), stat.st_size, stat.st_mtime_ns], separators=(',', ':'))
            result = cache['entries'].get(key)
            if result is None:
                result = analyse(file)
                # Remove stale versions of this path, retain other folders' tracks.
                cache['entries'] = {k: v for k, v in cache['entries'].items() if v.get('file') != str(file)}
                cache['entries'][key] = result
            tracks.append(result)
        except Exception as exc:
            errors.append(f'{file.name}: {exc}')
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=cache_file.parent, delete=False) as f:
            temp = f.name
            json.dump(cache, f, allow_nan=False)
        os.replace(temp, cache_file)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)
    print(json.dumps({'tracks': tracks, 'warnings': errors}, allow_nan=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
