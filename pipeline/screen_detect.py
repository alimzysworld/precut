"""The same screen evidence as shared/screen.ts; no decoding or model call."""
import json
import re
from pathlib import Path
_rules_path = Path(__file__).resolve().parent.parent / 'src/shared/screen-rules.ts'
if not _rules_path.is_file():
    _rules_path = Path(__file__).resolve().parent / 'screen-rules.ts'
RULES = json.loads(_rules_path.read_text().split('export const screenRules = ', 1)[1].strip().removesuffix(';'))
def is_screen(c):
    meta = c.get('meta') or {}
    if c.get('photo') or (meta and (meta.get('width') == 0 or meta.get('height') == 0)):
        return False
    if c.get('screen') or re.search(RULES['name'], c.get('file', ''), re.I) or re.search(RULES['description'], (c.get('judgement') or {}).get('summary', ''), re.I):
        return True
    tags = [t['label'].lower() for t in (c.get('quality') or {}).get('tags', []) if t.get('confidence', 0) >= .5]
    return any(t in RULES['tags'] for t in tags) or bool(meta and not meta.get('camera') and 0 < meta.get('fps', 0) <= 120 and ([meta.get('width'), meta.get('height')] in RULES['displays'] or any(t in RULES['uiTags'] for t in tags)))
