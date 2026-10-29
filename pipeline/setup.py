#!/usr/bin/env python3
"""Install precut's Python dependencies using bundled uv, after an explicit click.

The requirements and readiness marker belong to Application Support/precut.
This script runs with the managed venv Python; it never needs system Python.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

SUPPORT = Path.home() / "Library" / "Application Support" / "precut"
VENV = SUPPORT / "venv"
# REL2: the whole stack is locked with hashes in requirements.txt beside this script (top level: mlx-whisper 0.4.3,
# opencv-python-headless 4.12.0.88, numpy 2.2.6, librosa 0.11.0), so every Mac gets exactly what precut is tested on.
LOCK = Path(__file__).resolve().with_name("requirements.txt")


def tool(name):
    """Python subprocess counterpart of main/tools.ts (also works with -I)."""
    bundled = Path(__file__).resolve().parent.parent / "tools"
    if not bundled.is_dir():
        bundled = Path(__file__).resolve().parent.parent / "build" / "tools"
    candidate = bundled / ("exiftool/exiftool" if name == "exiftool" else name)
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return str(candidate)
    return shutil.which(name) or name


def emit(stage, pct, message=""):
    print(json.dumps({"stage": stage, "pct": pct, "message": message}), flush=True)


def main():
    SUPPORT.mkdir(parents=True, exist_ok=True)
    requirements = SUPPORT / "requirements.txt"
    locked = LOCK.read_text()
    requirements.write_text(locked)
    marker = VENV / ".precut-ready"
    marker.unlink(missing_ok=True)
    emit("setup", 40, "Downloading speech and video packages…")
    # sync: exactly the lock (hash-checked, wheels only); anything else in precut's own venv is removed.
    installed = subprocess.run([tool("uv"), "pip", "sync", "--python", sys.executable,
                                "--only-binary", ":all:", "--require-hashes", str(requirements)],
                               stdout=sys.stderr, stderr=sys.stderr)
    if installed.returncode:
        emit("setup", 40, "Package download failed. Press Set up precut to retry.")
        return 1
    emit("setup", 90, "Checking the Python environment…")
    # Importing mlx_whisper initializes Metal. Setup validates installed modules
    # without opening the GPU; the first shoot is where speech processing runs.
    check = subprocess.run([sys.executable, "-I", "-c",
                            "import cv2, numpy, librosa; import importlib.util as u; "
                            "from importlib.metadata import version; "
                            "assert u.find_spec('mlx_whisper'); assert u.find_spec('mlx.core'); "
                            "version('mlx-whisper'); version('mlx')"],
                           stdout=sys.stderr, stderr=sys.stderr)
    if check.returncode:
        return 1
    marker.write_text(locked)
    emit("setup", 100, "Python environment ready")
    return 0


if __name__ == "__main__":
    sys.exit(main())
