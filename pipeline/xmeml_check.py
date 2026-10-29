#!/usr/bin/env python3
"""Validate FCP 7 XML v5 edits, local media, source bounds and reciprocal links.
Usage: python3 -I pipeline/xmeml_check.py timeline.xml [...]
"""
import json
import math
from pathlib import Path
import sys; sys.path.insert(0, str(Path(__file__).resolve().parent)); from setup import tool
import re
import subprocess
import sys
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET


def fps(node):
    r = node.find('rate')
    if r is None:
        raise ValueError('missing rate')
    base = int(r.findtext('timebase', '0'))
    ntsc = r.findtext('ntsc')
    if base <= 0 or ntsc not in {'TRUE', 'FALSE'}:
        raise ValueError('invalid timebase/ntsc')
    if ntsc == 'TRUE' and base not in {24, 30, 60}:
        raise ValueError('invalid NTSC timebase')
    return base * 1000 / 1001 if ntsc == 'TRUE' else base


def integer(node, tag):
    text = node.findtext(tag, '')
    if not re.fullmatch(r'-?\d+', text):
        raise ValueError(f'{node.get("id")} {tag} is not integer frames')
    return int(text)


def check(path):
    errors = []
    root = ET.parse(path).getroot()
    if root.tag != 'xmeml' or root.get('version') != '5':
        return ['expected xmeml version 5']
    files = {}
    physical = {}
    for file in root.iter('file'):
        if file.find('pathurl') is None:
            continue
        fid = file.get('id')
        if fid in files:
            errors.append(f'duplicate full file declaration {fid}')
        files[fid] = file
        raw = file.findtext('pathurl', '')
        uri = urlparse(raw)
        source = Path(unquote(uri.path))
        if uri.scheme != 'file' or uri.netloc not in {'', 'localhost'} or not source.is_absolute() or any(c in raw for c in ' []#'):
            errors.append(f'{fid}: pathurl must be an absolute percent-encoded file URL')
        if not source.is_file():
            errors.append(f'{fid}: missing media {source}')
            continue
        try:
            probe = json.loads(subprocess.run([tool('ffprobe'), '-v', 'error', '-show_entries',
                'format=duration:stream=codec_type,codec_name,pix_fmt,channels', '-of', 'json', str(source)],
                check=True, capture_output=True, text=True, timeout=30).stdout)
            still = file.findtext('media/video/stillframe') == 'TRUE'
            image = next((s for s in probe['streams'] if s.get('codec_type') == 'video'), {})
            if still and image.get('codec_name') in {'png', 'mjpeg', 'webp', 'tiff'} and 'duration' not in probe.get('format', {}):
                # Native stills have no physical duration. Their XML hold sets
                # the duration, while ffprobe still validates the image codec.
                actual = integer(file, 'duration') / fps(file)
            else:
                actual = float(probe['format']['duration'])
            if not math.isfinite(actual) or actual <= 0:
                raise ValueError('invalid duration')
            physical[fid] = (actual, probe['streams'])
            if integer(file, 'duration') / fps(file) > actual + 1 / fps(file):
                errors.append(f'{fid}: declared file duration exceeds real media')
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            errors.append(f'{fid}: cannot probe media: {exc}')
    clips = {}
    positions = {}
    starts = {}
    ranges = {}
    for seq in root.findall('.//sequence'):
        seqfps = fps(seq)
        for typ in ['video', 'audio']:
            for ti, track in enumerate(seq.findall(f'media/{typ}/track'), 1):
                prev_end = 0
                alternate_ends = {}
                rows = list(track)
                for ci, clip in enumerate(track.findall('clipitem'), 1):
                    cid = clip.get('id')
                    if cid in clips:
                        errors.append(f'duplicate clip ID {cid}')
                    clips[cid] = clip
                    positions[cid] = (typ, ti, ci)
                    start, end, sin, sout = [integer(clip, t) for t in ['start', 'end', 'in', 'out']]
                    row = rows.index(clip)
                    incoming = rows[row - 1] if row and rows[row - 1].tag == 'transitionitem' else None
                    outgoing = rows[row + 1] if row + 1 < len(rows) and rows[row + 1].tag == 'transitionitem' else None
                    if start == -1 and incoming is not None:
                        start = integer(incoming, 'start')
                    if end == -1 and outgoing is not None:
                        end = integer(outgoing, 'end')
                    starts[cid] = start
                    ranges[cid] = (start, end)
                    overlap = integer(incoming, 'end') - integer(incoming, 'start') if incoming is not None else 0
                    if start < prev_end - overlap or end <= start or sin < 0 or sout <= sin:
                        errors.append(f'{cid}: overlapping/invalid edit')
                    prev_end = end
                    file = clip.find('file')
                    fid = file.get('id') if file is not None else None
                    full = files.get(fid)
                    if full is None:
                        errors.append(f'{cid}: unresolved file {fid}')
                        continue
                    fr = fps(clip)
                    if abs(fr - fps(full)) > 1e-5:
                        errors.append(f'{cid}: file and clip frame rates differ')
                    if sout > integer(full, 'duration'):
                        errors.append(f'{cid}: source overrun')
                    retime = clip.find('filter/effect[effectid="timeremap"]')
                    if retime is not None:
                        keys = retime.findall('parameter[parameterid="graphdict"]/keyframe')
                        when = [int(k.findtext('when', '-1')) for k in keys]
                        values = [float(k.findtext('value', '-1')) for k in keys]
                        if len(keys) < 2 or any(b <= a for a, b in zip(when, when[1:])) or min(values) < -1e-6 or max(values) > integer(full, 'duration') + 1e-6:
                            errors.append(f'{cid}: invalid native retime curve or source overrun')
                    elif abs((sout - sin) / fr - (end - start) / seqfps) > 1 / fr + 1 / seqfps + 1e-6:
                        errors.append(f'{cid}: unexplained source/timeline retime')
                    if fid in physical:
                        actual, streams = physical[fid]
                        name = clip.findtext('name', '')
                        if typ == 'video' and name.startswith(('Title front:', 'Title behind:', 'Person cut-out')):
                            picture = next((s for s in streams if s['codec_type'] == 'video'), {})
                            if picture.get('codec_name') != 'prores' or not picture.get('pix_fmt', '').startswith('yuva'):
                                errors.append(f'{cid}: finishing layer is not ProRes with alpha')
                            if clip.findtext('alphatype') != 'straight' or ti <= 1:
                                errors.append(f'{cid}: alpha layer lacks straight alpha or upper track')
                        if name.startswith('Original voice:') and clip.findtext('enabled') != 'FALSE':
                            errors.append(f'{cid}: original voice is not disabled')
                        if sout / fr > actual + 1 / fr:
                            errors.append(f'{cid}: physical source overrun')
                        if typ == 'audio':
                            channel = integer(clip.find('sourcetrack'), 'trackindex')
                            available = max([s.get('channels', 0) for s in streams if s['codec_type'] == 'audio'] or [0])
                            if not 1 <= channel <= available:
                                errors.append(f'{cid}: nonexistent audio channel')
                    if clip.findtext('enabled') not in {'TRUE', 'FALSE'}:
                        errors.append(f'{cid}: missing enabled state')
                    if typ == 'video' and clip.find('marker') is None:
                        errors.append(f'{cid}: missing line marker')
                    if typ == 'video' and clip.findtext('enabled') == 'FALSE':
                        if ti <= 1:
                            errors.append(f'{cid}: alternate on V1')
                        name = re.match(r'^(\d+) ', clip.findtext('name', ''))
                        mains = seq.findall('media/video/track[1]/clipitem')
                        candidates = [m for m in mains if name and re.match(r'^' + name[1] + r' ', m.findtext('name', ''))]
                        # Filler sub-items continue after the line's first frame.
                        alt_name = clip.findtext('name', '')
                        expected_start = alternate_ends.get(alt_name, min([starts.get(m.get('id'), integer(m, 'start')) for m in candidates] or [-1]))
                        if not candidates or start != expected_start:
                            errors.append(f'{cid}: alternate not aligned with its line')
                        alternate_ends[alt_name] = end
    for cid, clip in clips.items():
        for link in clip.findall('link'):
            ref = link.findtext('linkclipref')
            other = clips.get(ref)
            if other is None:
                errors.append(f'{cid}: dangling link {ref}')
                continue
            expected = (link.findtext('mediatype'), integer(link, 'trackindex'), integer(link, 'clipindex'))
            if positions[ref] != expected:
                errors.append(f'{cid}: wrong link coordinates for {ref}')
            if cid not in [l.findtext('linkclipref') for l in other.findall('link')]:
                errors.append(f'{cid}: non-reciprocal link {ref}')
            if clip.findtext('enabled') != other.findtext('enabled'):
                errors.append(f'{cid}: linked picture/sound enabled states differ')
            if positions[cid][0] == 'video' and positions[ref][0] == 'audio':
                if ranges[ref][0] < ranges[cid][0] or ranges[ref][1] > ranges[cid][1]:
                    errors.append(f'{cid}: linked sound outside picture')
    if not clips:
        errors.append('no clips')
    return errors


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    bad = False
    for path in sys.argv[1:]:
        try:
            errors = check(path)
        except (ValueError, TypeError, OSError, ET.ParseError) as exc:
            errors = [str(exc)]
        print(('FAIL ' if errors else 'PASS ') + path)
        for error in errors:
            print('  - ' + error)
        bad |= bool(errors)
    return int(bad)


if __name__ == '__main__':
    sys.exit(main())
