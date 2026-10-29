#!/usr/bin/env python3
"""Download the speech model in the background, with real byte progress.

Runs with the managed venv Python (-I). The model lands in precut's own cache, the
same place process.py reads. A lock file tells process.py to wait for it at the one
step that needs the model, and nothing else waits.
"""
import json
import os
import sys
import threading
import time
from pathlib import Path

REPO = "mlx-community/whisper-large-v3-turbo"
# REL2: the exact model revision precut is tested with (process.py reads the same one).
REVISION = "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"
SUPPORT = Path.home() / "Library" / "Application Support" / "precut"
CACHE = SUPPORT / "models" / "hub"
LOCK = SUPPORT / "models" / ".downloading"


def emit(**event):
    print(json.dumps(event), flush=True)


def cached_bytes():
    folder = CACHE / ("models--" + REPO.replace("/", "--"))
    total = 0
    for item in folder.rglob("*") if folder.exists() else []:
        try:
            if item.is_file() and not item.is_symlink():
                total += item.stat().st_size
        except OSError:
            pass
    return total


def main():
    os.environ["HF_HOME"] = str(SUPPORT / "models")
    os.environ["HF_HUB_CACHE"] = str(CACHE)
    CACHE.mkdir(parents=True, exist_ok=True)
    from huggingface_hub import HfApi, snapshot_download
    try:
        info = HfApi().model_info(REPO, revision=REVISION, files_metadata=True)
        total = sum(s.size or 0 for s in info.siblings)
    except Exception:
        emit(error="Could not reach the download server. Check your connection.")
        return 1
    LOCK.write_text(str(os.getpid()))
    result = {}

    def work():
        try:
            snapshot_download(REPO, revision=REVISION)
            result["ok"] = True
        except Exception:
            result["ok"] = False

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    try:
        while thread.is_alive():
            emit(bytes=cached_bytes(), total=total)
            thread.join(1.0)
    finally:
        LOCK.unlink(missing_ok=True)
    if not result.get("ok"):
        emit(error="The speech model download stopped. It will try again.")
        return 1
    emit(bytes=total, total=total, done=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
