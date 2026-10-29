"""Read-only photo originals, with restartable still videos under .sidething."""
import json
import re
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from setup import tool

PHOTO_EXTS = {".heic", ".heif", ".jpg", ".jpeg", ".png"}
FPS, FRAMES = 30, 180


def original_file(clip):
    return (clip.get("photo") or {}).get("file", clip["file"])


def command(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Could not read this photo: " + result.stderr.strip()[-500:])
    return result.stdout


def exif(path):
    try:
        return json.loads(command([tool("exiftool"), "-j", "-n", "-Orientation",
                                   "-DateTimeOriginal", "-OffsetTimeOriginal", str(path)]))[0]
    except (OSError, ValueError, RuntimeError):
        return {}


def iso_date(value):
    text = re.sub(r"^(\d{4}):(\d{2}):(\d{2})", r"\1-\2-\3", str(value).strip())
    try:
        date = datetime.fromisoformat(text.replace("Z", "+00:00"))
        # EXIF without an offset is the camera's local wall time.
        return date.astimezone().isoformat() if date.tzinfo is None else date.isoformat()
    except ValueError:
        return None


def taken_at(path, metadata=None):
    metadata = exif(path) if metadata is None else metadata
    value = metadata.get("DateTimeOriginal")
    if value:
        date = iso_date(str(value) + str(metadata.get("OffsetTimeOriginal") or ""))
        if date:
            return date
    for args in (["sips", "-g", "creation", str(path)],
                 ["mdls", "-raw", "-name", "kMDItemContentCreationDate", str(path)]):
        try:
            output = command(args)
            value = output.split("creation:", 1)[-1].strip()
            date = iso_date(value)
            if date:
                return date
        except (OSError, RuntimeError):
            pass
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()


def push_filter(width, height):
    # Even scale sizes keep chroma and the centred crop aligned. Rounding is
    # at most 1px at 2560, or 0.422px at 1080. Include both push endpoints.
    return ("format=yuv420p,scale=w='2*round(iw*(1+0.06*n/179)/2)':"
            "h='2*round(ih*(1+0.06*n/179)/2)':eval=frame:flags=bicubic,"
            f"crop={width}:{height}:(iw-ow)/2:(ih-oh)/2")


def ensure_still(root, source, clip_id):
    directory = root / ".sidething" / "stills"
    # Never follow a cache symlink back to somebody's originals.
    if (root / ".sidething").is_symlink() or directory.is_symlink():
        raise RuntimeError("Photo cache must be inside this shoot's .sidething")
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory / (clip_id + ".mov")
    receipt = directory / (clip_id + ".json")
    stat = source.stat()
    key = {"file": str(source.relative_to(root)), "size": stat.st_size, "mtimeNs": stat.st_mtime_ns}
    try:
        saved = json.loads(receipt.read_text())
        if saved.get("source") == key and dest.is_file() and not dest.is_symlink():
            return str(dest.relative_to(root)), saved["takenAt"], False
    except (OSError, ValueError, KeyError):
        pass
    metadata = exif(source)
    date = taken_at(source, metadata)
    with tempfile.TemporaryDirectory(prefix="photo-", dir=directory) as work:
        work = Path(work)
        decoded = source
        if source.suffix.lower() in {".heic", ".heif"}:
            decoded = work / "decoded.jpg"
            command(["sips", "-s", "format", "jpeg", str(source), "--out", str(decoded)])
            metadata = exif(decoded)
        turn = {2: "hflip,", 3: "hflip,vflip,", 4: "vflip,", 5: "transpose=clock,hflip,",
                6: "transpose=clock,", 7: "transpose=clock,vflip,", 8: "transpose=cclock,"}.get(metadata.get("Orientation"), "")
        # Decode/rescale just once. The loop repeats a small, upright image.
        upright = work / "upright.png"
        command([tool("ffmpeg"), "-v", "error", "-nostdin", "-noautorotate", "-i", str(decoded),
                 "-vf", turn + "scale=w='min(2560,iw)':h='min(2560,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,sidedata=mode=delete:type=DISPLAYMATRIX",
                 "-map_metadata", "-1", "-frames:v", "1", "-update", "1", str(upright)])
        video = work / "still.mov"
        with upright.open("rb") as image:
            width, height = struct.unpack(">II", image.read(24)[16:24])
        encoder = (["-c:v", "h264_videotoolbox", "-b:v", "24M"] if sys.platform == "darwin"
                   else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"])
        command([tool("ffmpeg"), "-v", "error", "-nostdin", "-threads", "1", "-noautorotate", "-framerate", str(FPS),
                 "-i", str(upright), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                 "-filter_threads", "2", "-vf", "loop=loop=-1:size=1:start=0,setpts=N/(30*TB)," + push_filter(width, height) + ",format=yuv420p", *encoder,
                 "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-ar", "48000", "-ac", "2",
                 "-t", "6", "-r", str(FPS), "-map_metadata", "-1", "-movflags", "+faststart", str(video)])
        current = source.stat()
        if (current.st_size, current.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
            raise RuntimeError("Photo changed while reading it; try again")
        video.replace(dest)
        saved = work / "receipt.json"
        saved.write_text(json.dumps({"source": key, "takenAt": date}))
        saved.replace(receipt)
    return str(dest.relative_to(root)), date, True
