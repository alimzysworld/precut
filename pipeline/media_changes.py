"""Explicit incremental imports never reread existing sources or absent originals."""
import json
from pathlib import Path


def accepted_files(root):
    receipt = Path(root) / '.sidething/add-files.json'
    if not receipt.exists():
        return None
    files = json.loads(receipt.read_text())
    if not isinstance(files, list) or any(not isinstance(f, str) for f in files):
        raise ValueError('Could not read the added files request')
    return set(files)


def source_wanted(root, clip):
    file = (clip.get('photo') or {}).get('file') or clip['file']
    files = accepted_files(root)
    return (Path(root) / file).is_file() and (files is None or file in files)


def reread_files(root):
    """Sources whose content changed under a receipt that still matches (an older retry
    stamped it without reading). Read fresh once, then cleared by consume_reread."""
    receipt = Path(root) / '.sidething/reread.json'
    try:
        files = json.loads(receipt.read_text())
    except (OSError, ValueError):
        return set()
    return {f for f in files if isinstance(f, str)} if isinstance(files, list) else set()


def consume_reread(root, done):
    receipt = Path(root) / '.sidething/reread.json'
    if not done or not receipt.exists():
        return
    left = sorted(reread_files(root) - set(done))
    if left:
        temporary = receipt.with_name('reread.json.tmp')
        temporary.write_text(json.dumps(left))
        temporary.replace(receipt)
    else:
        receipt.unlink(missing_ok=True)
