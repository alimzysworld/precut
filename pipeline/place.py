"""GPS and cached Apple place names. Writes only the shoot's .sidething cache."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
from setup import tool


def coordinate(lat, lon):
    try:
        lat, lon = float(lat), float(lon)
        return {"lat": lat, "lon": lon} if math.isfinite(lat) and math.isfinite(lon) and abs(lat) <= 90 and abs(lon) <= 180 else None
    except (ValueError, TypeError):
        return None


def iso6709(value):
    match = re.match(r"^([+-]\d{2}(?:\.\d+)?)([+-]\d{3}(?:\.\d+)?)(?:[+-][\d.]+)?/?$", str(value or ""))
    return coordinate(*match.groups()) if match else None


def photo_gps(path):
    result = subprocess.run([tool("exiftool"), "-j", "-n", "-GPSLatitude", "-GPSLongitude", str(path)], capture_output=True, text=True, timeout=10)
    row = json.loads(result.stdout)[0] if result.returncode == 0 else {}
    return coordinate(row.get("GPSLatitude"), row.get("GPSLongitude"))


def tagged_gps(data):
    for row in [data.get("format", {}), *data.get("streams", [])]:
        tags = row.get("tags") or {}
        gps = iso6709(tags.get("com.apple.quicktime.location.ISO6709") or tags.get("location"))
        if gps:
            return gps
    return None


def video_gps(path):
    result = subprocess.run([tool("ffprobe"), "-v", "quiet", "-show_entries", "format_tags:stream_tags", "-of", "json", str(path)], capture_output=True, text=True, timeout=10)
    return tagged_gps(json.loads(result.stdout)) if result.returncode == 0 else None


def place_tool():
    source = Path(__file__).with_suffix(".swift")
    bundled = Path(tool("place"))
    if bundled.is_file():
        return bundled
    directory = Path(os.environ.get("PRECUT_PLACE_BIN_DIR", str(Path.home() / "Library/Application Support/precut/bin")))
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory / ("place-" + hashlib.sha256(source.read_bytes()).hexdigest()[:16])
    if not dest.is_file():
        with tempfile.TemporaryDirectory(prefix="place-build-", dir=directory) as work:
            output = Path(work) / "place"
            subprocess.run(["swiftc", "-O", "-module-cache-path", str(directory / "place-modules"), str(source), "-o", str(output)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=90)
            os.replace(output, dest)
    return dest


def named_place(root, gps):
    if not gps:
        return None
    directory = root / ".sidething"
    cache_file = directory / "places.json"
    if directory.is_symlink() or cache_file.is_symlink():
        raise RuntimeError("Place cache must stay inside .sidething")
    directory.mkdir(parents=True, exist_ok=True)
    try:
        cache = json.loads(cache_file.read_text())
    except (OSError, ValueError):
        cache = {}
    key = f"{gps['lat']:.3f},{gps['lon']:.3f}"
    if key not in cache:
        try:
            output = subprocess.run([str(place_tool()), str(gps["lat"]), str(gps["lon"])], capture_output=True, text=True, timeout=6, check=True)
            cache[key] = json.loads(output.stdout).get("name")
        except (OSError, ValueError, subprocess.SubprocessError):
            cache[key] = None  # Offline is a cached honest coordinate, never a guessed name.
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, prefix="places-", delete=False) as handle:
            json.dump(cache, handle, allow_nan=False)
        os.replace(handle.name, cache_file)
    return {**gps, "name": cache[key]}
