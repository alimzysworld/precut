"""Offline measurements and sample-preserving music assembly. No stretching.

All destinations are supplied by the app's disposable staging directory.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from setup import tool
import numpy as np

SR = 48000


def decode(file, rate=SR):
    data = subprocess.run([tool('ffmpeg'), '-v', 'error', '-nostdin', '-i', file,
                           '-vn', '-ar', str(rate), '-ac', '2', '-f', 'f32le', '-'],
                          capture_output=True, check=True).stdout
    return np.frombuffer(data, dtype='<f4').reshape(-1, 2)


def section_facts(music, rate, sections, hits, duration):
    facts = []
    for index, start in enumerate(sections):
        end = sections[index+1] if index+1 < len(sections) else duration
        samples = music[round(start*rate):round(end*rate)]
        rms = float(np.sqrt(np.mean(samples**2))) if len(samples) else 0
        facts.append({'index': index, 's': start, 'e': end,
                      'rmsDb': round(20*np.log10(max(1e-6, rms)), 2),
                      'strongHits': sum(start <= t < end for t in hits)})
    return facts


def analyse(file, drums=None):
    import librosa
    rate = 22050
    duration = len(decode(file))/SR
    music = decode(file, rate).mean(axis=1)
    rhythm = decode(drums, rate).mean(axis=1) if drums else music
    onset = librosa.onset.onset_strength(y=rhythm, sr=rate)
    _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=rate, trim=False)
    times = librosa.frames_to_time(frames, sr=rate)
    if len(times) < 5:
        raise ValueError('Could not find reliable bars in this track. Choose another track.')
    # Estimate 4/4 phase from repeated accent strength, not from tempo alone.
    phase = max(range(4), key=lambda p: float(np.mean(onset[frames[p::4]])))
    bars = times[phase::4]
    bars = bars[(bars > .03) & (bars < len(music)/rate-.03)]
    if len(bars) < 2:
        raise ValueError('This track is too short to arrange on bars.')
    chroma = librosa.feature.chroma_stft(y=music, sr=rate)
    features = []
    for a, b in zip(bars[:-1], bars[1:]):
        x, y = int(a*rate/512), max(int(a*rate/512)+1, int(b*rate/512))
        features.append(chroma[:, x:y].mean(axis=1))
    changes = [float(np.linalg.norm(b-a)) for a, b in zip(features[:-1], features[1:])]
    threshold = float(np.percentile(changes, 75)) if changes else float('inf')
    sections = [float(bars[0])] + [float(bars[i+1]) for i, value in enumerate(changes)
                                                   if value > threshold]
    strengths = onset[frames]
    hits = times[strengths >= np.percentile(strengths, 65)]
    return {'beats': times.tolist(), 'durationS': duration, 'bars': bars.tolist(), 'sections': sections,
            'sectionFacts': section_facts(music, rate, sections, hits.tolist(), duration),
            'hits': hits.tolist(), 'metre': 'estimated 4/4 accent phase',
            'rhythmSource': 'drums' if drums else 'mix'}


def render(spec):
    import soundfile as sf
    count = round(spec['durationS']*SR)
    stems = spec.get('sources') or {'mix': spec['file']}
    mix = np.zeros((count, 2), dtype=np.float32)
    for name, file in stems.items():
        source = decode(file)
        output = np.zeros_like(mix)
        for part in spec['parts']:
            start, end, at = (round(part[k]*SR) for k in ('sourceS', 'sourceE', 'atS'))
            length = min(end-start, count-at)
            chunk = source[start:start+length]
            output[at:at+len(chunk)] = chunk
        # Centred short crossfades use source handles, keeping the bar's clock
        # and exact sample count. Neighbouring untouched samples stay identical.
        for previous, part in zip(spec['parts'][:-1], spec['parts'][1:]):
            at, left, right = (round(v*SR) for v in (part['atS'], previous['sourceE'], part['sourceS']))
            h = min(576, at, count-at, left, right, len(source)-left, len(source)-right,
                    round((previous['sourceE']-previous['sourceS'])*SR/4),
                    round((part['sourceE']-part['sourceS'])*SR/4))
            if h > 0:
                weight = np.linspace(0, 1, 2*h, dtype=np.float32)[:, None]
                output[at-h:at+h] = source[left-h:left+h]*(1-weight)+source[right-h:right+h]*weight
        # Model-selected stem levels interpolate over 30 ms at each exact
        # story boundary; no inferred default story and no hard gain steps.
        points = spec.get('shape', [])
        if name != 'mix' and points:
            x, y = [0], [10**(points[0]['levels'][name]/20)]
            for point in points[1:]:
                at = round(point['atS']*SR)
                x.extend([max(x[-1], at-720), min(count, at+720)])
                y.extend([y[-1], 10**(point['levels'][name]/20)])
            output *= np.interp(np.arange(count), x, y).astype(np.float32)[:, None]
        if not np.isfinite(output).all():
            raise ValueError('Invalid arranged audio')
        sf.write(str(Path(spec['directory']) / (name+'.wav')), output, SR, subtype='FLOAT')
        mix += output
    if 'mix' not in stems:
        sf.write(str(Path(spec['directory']) / 'mix.wav'), mix, SR, subtype='FLOAT')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['analyse', 'render'])
    parser.add_argument('input')
    parser.add_argument('output', nargs='?')
    parser.add_argument('--drums')
    args = parser.parse_args()
    if args.mode == 'analyse':
        Path(args.output).write_text(json.dumps(analyse(args.input, args.drums), allow_nan=False))
    else:
        render(json.loads(Path(args.input).read_text()))
