"""V1: sharp, steady, changing frames from decoded 2 Hz candidates.

V4/shared decoders can call select_frames directly with timestamped JPEGs. The
fallback is one sequential source read, never one seek/decode per selected frame.
"""
import hashlib
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path


def frame_count(duration):
    return 16 if duration > 20 else 8


def candidate_rate(duration):
    # Very short clips need more than 2 Hz to offer eight distinct pictures.
    return max(2.0, 9.0 / max(.001, duration))


# BUG2: a still is labelled with the time of the picture it holds. fps= put each
# picture on its own grid, so a label could sit up to a frame after its picture
# (every Sony 25p still). select keeps each picture's time; the file is named by
# it in microseconds, zero padded so names sort in time order.
def candidate_filter(rate):
    return f"select='gte(t*{rate}\\,selected_n)'"


CANDIDATE_OUTPUT = ["-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-frame_pts", "1"]
CANDIDATE_NAMES = "%012d.jpg"


def candidate_rows(directory):
    return [{"t": int(file.stem) / 1e6, "path": str(file)} for file in sorted(Path(directory).glob("*.jpg"))]


def vision_tool(tool):
    bundled = Path(tool("smart-frames"))
    if bundled.is_file():
        return bundled
    source = Path(__file__).with_name("smart-frames.swift")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    directory = Path.home() / "Library/Application Support/precut/py-cache/tools"  # REL2: not "cache" (Chromium's Cache)
    directory.mkdir(parents=True, exist_ok=True)
    binary = directory / ("smart-frames-" + digest)
    if not binary.exists():
        with tempfile.TemporaryDirectory(prefix="smart-frames-build-", dir=directory) as work:
            output = Path(work) / "smart-frames"
            subprocess.run(["xcrun", "swiftc", "-O", "-module-cache-path", str(Path(work) / "modules"),
                            str(source), "-o", str(output)], check=True, stdout=subprocess.DEVNULL)
            output.replace(binary)
    return binary


def select_frames(candidates, clip_id, duration, out_dir, turn, shake, tool):
    import cv2
    rows = []
    readings = (shake or {}).get("perSecond") or []
    for candidate in candidates:
        t, file = candidate["t"], Path(candidate["path"])
        if not math.isfinite(t) or not 0 <= t < max(duration, .001):
            continue
        image = cv2.imread(str(file), cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise RuntimeError("unreadable smart-frame candidate")
        image = cv2.resize(image, (320, max(4, round(image.shape[0] * 320 / image.shape[1]))))
        sharpness = float(cv2.Laplacian(image, cv2.CV_64F).var())
        value = readings[int(t)] if int(t) < len(readings) else 0
        rows.append({"t": t, "path": str(file), "sharpness": sharpness,
                     "shake": float(value) if math.isfinite(value) else 0})
    if not rows:
        raise RuntimeError("no smart-frame candidates decoded")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", dir=out_dir) as manifest:
        json.dump({"candidates": rows, "duration": duration, "count": frame_count(duration)}, manifest)
        manifest.flush()
        result = subprocess.run([str(vision_tool(tool)), manifest.name], check=True, capture_output=True, text=True)
    chosen = json.loads(result.stdout)
    # Tiny clips can contain fewer than eight distinct decoded candidates. Retain
    # those real timestamps, without pretending to have measured more pictures.
    names = []
    for n, row in enumerate(chosen):
        name = f"{clip_id}_r{turn % 360}_{n}_t{row['t']:.6f}.jpg"
        shutil.copyfile(row["path"], out_dir / name)
        names.append(name)
    return names


def extract_smart_frames(path, clip_id, duration, is_log, out_dir, turn, shake, tool, log_lift, candidates=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    if candidates is not None:
        return select_frames(candidates, clip_id, duration, out_dir, turn, shake, tool)
    rotation = {90: "transpose=clock,", 180: "hflip,vflip,", 270: "transpose=cclock,"}.get(turn % 360, "")
    with tempfile.TemporaryDirectory(prefix="candidates-", dir=out_dir) as work:
        rate = candidate_rate(duration)
        filters = rotation + candidate_filter(rate) + ",scale=480:-2" + ("," + log_lift if is_log else "")
        subprocess.run([tool("ffmpeg"), "-y", "-v", "error", "-i", str(path), "-an", "-vf", filters,
                        *CANDIDATE_OUTPUT, "-q:v", "3", str(Path(work) / CANDIDATE_NAMES)], check=True)
        return select_frames(candidate_rows(work), clip_id, duration, out_dir, turn, shake, tool)
