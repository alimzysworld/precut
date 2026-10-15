#!/usr/bin/env python3
"""Create the precut venv and check system tools.

Creates ~/Library/Application Support/precut/venv (path mandated
by the brief) and installs mlx-whisper, opencv-python-headless, numpy.
Prints one JSON progress line per event on stdout; tool output goes to
stderr so stdout stays parseable.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

VENV = Path.home() / "Library" / "Application Support" / "precut" / "venv"
PACKAGES = ["mlx-whisper", "opencv-python-headless", "numpy", "librosa"]
TOOLS = {"ffmpeg": "brew install ffmpeg", "ffprobe": "brew install ffmpeg",
         "exiftool": "brew install exiftool"}


def emit(stage, pct, message=""):
    line = {"stage": stage, "pct": pct}
    if message:
        line["message"] = message
    print(json.dumps(line), flush=True)


def run(cmd):
    return subprocess.run(cmd, stdout=sys.stderr, stderr=sys.stderr)


def venv_python():
    return VENV / "bin" / "python"


def main():
    missing = []
    for tool, brew in TOOLS.items():
        if shutil.which(tool) is None:
            missing.append(tool)
            emit("setup", 0, f"missing {tool}: {brew}")
    if missing:
        emit("setup", 0, "install the missing tools, then run setup again")
        return 1
    emit("setup", 10, "ffmpeg, ffprobe and exiftool found")

    py = venv_python()
    if not py.exists():
        emit("setup", 20, f"creating venv at {VENV}")
        VENV.parent.mkdir(parents=True, exist_ok=True)
        if run([sys.executable, "-m", "venv", str(VENV)]).returncode != 0:
            emit("setup", 20, "venv creation failed")
            return 1
    else:
        emit("setup", 20, "venv already exists")

    check = subprocess.run(
        [str(py), "-c", "import mlx_whisper, cv2, numpy"],
        capture_output=True, text=True)
    if check.returncode == 0:
        emit("setup", 100, "venv ready")
        return 0

    emit("setup", 40, "installing packages: " + " ".join(PACKAGES))
    if run([str(py), "-m", "pip", "install", "--upgrade", "pip"]).returncode != 0:
        emit("setup", 40, "pip upgrade failed")
        return 1
    emit("setup", 60, "downloading packages (this can take a while)")
    if run([str(py), "-m", "pip", "install", *PACKAGES]).returncode != 0:
        emit("setup", 60, "package install failed")
        return 1
    check = subprocess.run(
        [str(py), "-c", "import mlx_whisper, cv2, numpy; print('ok')"],
        capture_output=True, text=True)
    if check.returncode != 0:
        emit("setup", 90, f"install finished but imports fail: {check.stderr.strip()[:200]}")
        return 1
    emit("setup", 100, "venv ready")
    return 0


if __name__ == "__main__":
    sys.exit(main())
