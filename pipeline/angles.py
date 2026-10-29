"""Read-only multicam measurement using the recorder sync's GCC-PHAT gates."""
import json
import sys
import hashlib
import os
import tempfile
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sync import correlate, decode
from screen_detect import is_screen as screen

root = Path(sys.argv[1])
shoot = json.loads((root / '.sidething/index.json').read_text())
clips = sorted([c for c in shoot['clips'] if not c.get('photo') and c.get('meta') and c.get('proxy') and c.get('stage') != 'error' and (root / c['file']).is_file()], key=lambda c: c['id'])
# Cache negative matches too. Adding a camera only measures its new pairs;
# removing or changing one source cannot leave a stale edge in an old group.
cache_file = root / '.sidething/angles-pairs.json'
if cache_file.is_symlink():
    raise ValueError('refusing redirected camera measurement cache')
try:
    pair_cache = json.loads(cache_file.read_text())
except (OSError, ValueError):
    pair_cache = {}
next_cache = {}
def identity(c):
    def stamp(file):
        p = root / file
        try:
            stat = p.stat()
            return [str(p.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
        except FileNotFoundError:
            return None
    sound = c.get('sound') or {}
    return [c['id'], stamp(c['file']), [c['meta'].get(k) for k in ('durationS', 'audioChannels', 'createdAt')],
            sound, stamp(sound['file']) if sound.get('file') else None, screen(c)]
waves = {}
def wave(c):
    if c['id'] not in waves:
        waves[c['id']] = decode(root / c['file'])
    return waves[c['id']]
def clock(c):
    from datetime import datetime
    try:
        return datetime.fromisoformat(c['meta']['createdAt'].replace('Z', '+00:00')).timestamp()
    except (KeyError, TypeError, ValueError):
        return None
edges = {c['id']: [] for c in clips}
for i, a in enumerate(clips):
    for b in clips[i+1:]:
        pair = hashlib.sha256(json.dumps(['V4-waveforms', identity(a), identity(b)], sort_keys=True).encode()).hexdigest()
        if pair in pair_cache:
            offset = pair_cache[pair]
            next_cache[pair] = offset
            if offset is not None:
                edges[a['id']].append((b['id'], offset))
                edges[b['id']].append((a['id'], -offset))
            continue
        offset = None
        sa, sb = a.get('sound') or {}, b.get('sound') or {}
        if sa.get('file') and sa.get('file') == sb.get('file'):
            offset = sb['offsetS'] - sa['offsetS']
        elif a['meta'].get('audioChannels') and b['meta'].get('audioChannels'):
            match = correlate(wave(a), wave(b))
            if match['accepted']:
                offset = match['offsetS']
        if offset is None and (screen(a) or screen(b)):
            ca, cb = clock(a), clock(b)
            if ca is not None and cb is not None:
                offset = cb - ca
        if offset is not None and min(a['meta']['durationS'], offset + b['meta']['durationS']) - max(0, offset) < 3:
            offset = None
        next_cache[pair] = offset
        if offset is None:
            continue
        edges[a['id']].append((b['id'], offset))
        edges[b['id']].append((a['id'], -offset))
groups, seen = [], set()
for clip in clips:
    cid = clip['id']
    if cid in seen or not edges[cid]:
        continue
    offsets, pending = {cid: 0}, [cid]
    while pending:
        current = pending.pop()
        seen.add(current)
        for other, delta in edges[current]:
            if other not in offsets:
                offsets[other] = offsets[current] + delta
                pending.append(other)
    zero = min(offsets.values())
    groups.append({'id': 'angles-' + cid, 'clips': [{'clipId': c['id'], 'offsetS': round(offsets[c['id']] - zero, 6), 'kind': 'screen' if screen(c) else 'camera'} for c in clips if c['id'] in offsets]})
fd, name = tempfile.mkstemp(prefix='angles-', suffix='.tmp', dir=cache_file.parent)
try:
    with os.fdopen(fd, 'w') as handle:
        json.dump(next_cache, handle, allow_nan=False)
    os.replace(name, cache_file)
finally:
    Path(name).unlink(missing_ok=True)
print(json.dumps(groups, allow_nan=False))
