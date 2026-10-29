"""V4 preview decode handoff. Only derived .sidething files are read/written."""
import json
import os
import time
from pathlib import Path


def shared_visual(root, clip, wait=True):
    directory = Path(root) / '.sidething/visual'
    marker = directory / 'session.json'
    source = Path(root) / clip['file']
    stat = source.stat()
    rotation = ((clip.get('byHand') or {}).get('rotate', (clip.get('judgement') or {}).get('rotate', 0)) + clip['meta'].get('rotation', 0)) % 360
    while True:
        try:
            row = json.loads((directory / (clip['id'] + '.json')).read_text())
            if (row['source'] == clip['file'] and row['rotation'] == rotation
                    and row['sourceStamp']['size'] == stat.st_size
                    and abs(row['sourceStamp']['mtimeMs'] - stat.st_mtime * 1000) < .01
                    and Path(row['gray']).parent.name.startswith('decode-')
                    and Path(row['gray']).resolve().is_relative_to(directory.resolve())
                    and Path(row['gray']).is_file()
                    and all(Path(c['path']).resolve().is_relative_to(Path(row['gray']).parent.resolve()) and Path(c['path']).is_file() for c in row['candidates'])):
                return row
        except (OSError, ValueError, KeyError):
            pass
        if not wait:
            return None
        try:
            session = json.loads(marker.read_text())
            if clip['id'] not in session['pending']:
                return None
            os.kill(session['pid'], 0)  # probe only; never signal another process
        except (OSError, ValueError, KeyError):
            return None
        time.sleep(.1)



def visual_session(root):
    """ANA1: the preview session as (pending ids, pid), read once per sweep; None when there is none."""
    try:
        session = json.loads((Path(root) / '.sidething/visual/session.json').read_text())
        return set(session['pending']), int(session['pid'])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def visual_waiting(root, clip, session=None):
    """ANA1: True while this clip's shared decode is still coming (listed as pending by a live preview session)."""
    session = visual_session(root) if session is None else session
    if not session or clip['id'] not in session[0]:
        return False
    try:
        manifest = Path(root) / '.sidething/visual' / (clip['id'] + '.json')
        if manifest.exists() and shared_visual(root, clip, wait=False) is not None:
            return False
        os.kill(session[1], 0)  # probe only; never signal another process
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False
