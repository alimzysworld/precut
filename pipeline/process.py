#!/usr/bin/env python3
"""Turn a shoot folder into <shoot>/.sidething/index.json (schema Shoot).

Run as: python -I pipeline/process.py <shoot> [--clip <id>]
Or: python -I pipeline/process.py <shoot> --clean-words-only
One clip at a time; index written after every stage. Progress is one JSON
line per event on stdout: {"clipId","stage","pct"}. Originals never touched.
Ports reference/proven-scripts/shake.py and transcribe/words.py.
"""
import argparse
import json
import math
import os
import re
import string
import subprocess
import sys
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
CLIP_EXTS = {".mp4", ".mov", ".mxf", ".mts", ".m4v"}
AUDIO_EXTS = {".wav", ".mp3", ".m4a"}
LOG_LIFT = "eq=contrast=1.35:saturation=1.4:gamma=0.85"
WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"
TRANSCRIPTION_LANGUAGE = "en"
WORD_PUNCTUATION = frozenset(string.punctuation + "‘’“”‚„‐‑‒–—―…")

# Hallucination filters use Whisper's own signals, never word lists.
NO_SPEECH_DROP = 0.6        # segment no_speech_prob above this ...
LOGPROB_LOW = -1.0          # ... together with avg_logprob below this
COMPRESSION_DROP = 2.4      # compression_ratio above this
WPS_MIN = 0.2               # words per second below this is not speech
WPS_MAX = 6.0               # words per second above this is not human speech

# Darkness: signalstats YAVG (8-bit) under this for most sampled frames means
# too dark to measure shake. Spec said ~16; the real S-Log3 black clip (0985)
# measures 24.6 because log raises the black pedestal, while lit night clips
# measure ~82, so 32 separates them. See qa/S2/REPORT.md.
DARK_YAVG_THRESHOLD = 32.0
DARK_FRACTION = 0.5

# Shake: high-frequency jitter (px at 320px width) above this for a second
# marks that second shaky. Picked from the real shoot, see REPORT.md.
SHAKY_JITTER_PX = 1.0

STAGES = ["probe", "transcript", "shake", "frames", "proxy"]
STAGE_PCT = {"probe": 10, "transcript": 40, "shake": 60, "frames": 80,
             "proxy": 95, "done": 100, "error": 100}


def emit(clip_id, stage):
    print(json.dumps({"clipId": clip_id, "stage": stage,
                      "pct": STAGE_PCT.get(stage, 0)}), flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def parse_fraction(text):
    try:
        if not text or text == "0/0":
            return 0.0
        if "/" in text:
            num, den = text.split("/", 1)
            den = float(den)
            return float(num) / den if den else 0.0
        return float(text)
    except (ValueError, ZeroDivisionError):
        return 0.0


def first_key(d, suffixes):
    """First value in exiftool dict whose key ends with any ':<suffix>'."""
    for suffix in suffixes:
        for key, val in d.items():
            if key.endswith(":" + suffix) and val not in (None, ""):
                return val
    return None


def to_float(val):
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    m = re.search(r"-?\d+(?:\.\d+)?", str(val))
    return float(m.group(0)) if m else None


def to_int(val):
    f = to_float(val)
    return int(f) if f is not None else None


# ---------------------------------------------------------------- probe ----
def probe_exif(path):
    out = {"camera": None, "iso": None, "shutter": None,
           "aperture": None, "focalLength": None}
    try:
        r = run(["exiftool", "-ee", "-j", "-s", "-G", str(path)])
        if r.returncode != 0 or not r.stdout.strip():
            return out
        d = json.loads(r.stdout)[0]
    except Exception:
        return out
    model = first_key(d, ["DeviceModelName", "Model", "CameraModelName"])
    make = first_key(d, ["Make", "DeviceManufacturer", "Manufacturer"])
    if model:
        model = str(model)
        out["camera"] = model if (make and str(make).lower() in model.lower()) \
            else (f"{make} {model}" if make else model)
    out["iso"] = to_int(first_key(d, ["ISO", "ISOSpeed", "RecommendedExposureIndex"]))
    shutter = first_key(d, ["ShutterSpeed", "ExposureTime"])
    out["shutter"] = str(shutter) if shutter is not None else None
    out["aperture"] = to_float(first_key(d, ["FNumber", "Aperture", "ApertureValue"]))
    focal = first_key(d, ["FocalLength"])
    if focal is None:
        focal = first_key(d, ["FocalLengthIn35mmFormat"])
    out["focalLength"] = to_float(focal)
    return out


def probe_sidecar(path):
    """Sony M01.XML sidecar: picture profile + camera fallback."""
    result = {"pictureProfile": None, "camera": None}
    sidecar = path.with_name(path.stem + "M01.XML")
    if not sidecar.exists():
        # also try <stem>M01.xml case variants
        for cand in path.parent.iterdir():
            if cand.name.lower() == (path.stem + "m01.xml").lower():
                sidecar = cand
                break
        else:
            return result
    try:
        root = ET.parse(sidecar).getroot()
        items = {}
        for el in root.iter():
            if el.attrib.get("name") and "value" in el.attrib:
                items[el.attrib["name"]] = el.attrib["value"]
            if el.tag.endswith("Device"):
                model = el.attrib.get("modelName")
                maker = el.attrib.get("manufacturer")
                if model:
                    result["camera"] = f"{maker} {model}" if maker else model
        gamma = items.get("CaptureGammaEquation")
        primaries = items.get("CaptureColorPrimaries")
        if gamma and primaries:
            result["pictureProfile"] = f"{gamma} / {primaries}"
        elif gamma:
            result["pictureProfile"] = gamma
    except Exception:
        pass
    return result


def probe_clip(path):
    """Return (meta dict, is_log). Raise RuntimeError if undecodable."""
    r = run(["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", "-show_format", str(path)])
    if r.returncode != 0:
        raise RuntimeError("can't read this format yet")
    try:
        data = json.loads(r.stdout)
    except Exception:
        raise RuntimeError("can't read this format yet")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise RuntimeError("can't read this format yet")
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format", {})

    fps = parse_fraction(video.get("avg_frame_rate")) or \
        parse_fraction(video.get("r_frame_rate"))
    pix = video.get("pix_fmt") or ""
    chroma = "4:2:2" if "422" in pix else "4:2:0" if "420" in pix else \
        "4:4:4" if "444" in pix else ""
    bits = "10-bit" if "10" in pix or str(video.get("bits_per_raw_sample")) == "10" \
        else "8-bit"
    codec = video.get("codec_name") or "unknown"
    codec_str = f"{codec} {chroma} {bits}".strip() if chroma else codec

    timecode = None
    for s in streams:
        tc = (s.get("tags") or {}).get("timecode")
        if tc:
            timecode = tc
            break
    if not timecode:
        timecode = (fmt.get("tags") or {}).get("timecode")

    created = None
    for s in [video, audio]:
        if s and (s.get("tags") or {}).get("creation_time"):
            created = s["tags"]["creation_time"]
            break
    if not created:
        created = (fmt.get("tags") or {}).get("creation_time")

    duration = to_float(fmt.get("duration")) or to_float(video.get("duration")) or 0.0
    exif = probe_exif(path)
    sidecar = probe_sidecar(path)
    camera = exif["camera"] or sidecar["camera"]
    profile = sidecar["pictureProfile"]

    meta = {
        "camera": camera,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": round(fps, 3) if fps else 0,
        "codec": codec_str,
        "pictureProfile": profile,
        "iso": exif["iso"],
        "shutter": exif["shutter"],
        "aperture": exif["aperture"],
        "focalLength": exif["focalLength"],
        "startTimecode": timecode,
        "audioChannels": int(audio.get("channels") or 0) if audio else 0,
        "sampleRate": int(audio.get("sample_rate") or 0) if audio else 0,
        "durationS": round(float(duration), 3),
        "sizeBytes": path.stat().st_size,
        "createdAt": created,
    }
    is_log = bool(profile and "log" in profile.lower())
    return meta, is_log


def probe_audio(path):
    r = run(["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", "-show_format", str(path)])
    duration, channels = 0.0, 0
    try:
        data = json.loads(r.stdout)
        duration = float(data.get("format", {}).get("duration") or 0)
        a = next((s for s in data.get("streams", [])
                  if s.get("codec_type") == "audio"), None)
        if a:
            channels = int(a.get("channels") or 0)
    except Exception:
        pass
    return {"file": path.name, "durationS": round(duration, 3),
            "channels": channels, "syncedTo": None}


# ------------------------------------------------------------ transcript ----
def is_latin_word(word):
    """Allow Latin letters/accents, decimal digits, spacing and common punctuation."""
    latin_base = False
    for char in unicodedata.normalize("NFC", word):
        if unicodedata.category(char).startswith("L") and \
                "LATIN" in unicodedata.name(char, ""):
            latin_base = True
        elif latin_base and "\u0300" <= char <= "\u036f" and \
                unicodedata.category(char).startswith("M"):
            continue  # decomposed Latin accents that NFC cannot compose
        elif char.isspace() or char.isdecimal() or char in WORD_PUNCTUATION:
            latin_base = False
        else:
            return False
    return True


def clean_transcript_words(segments, language):
    """Script measurement only; other transcription languages pass through."""
    if language.lower() not in {"en", "english"}:
        return segments
    cleaned = []
    for seg in segments:
        words = [w for w in seg["words"] if is_latin_word(w["w"])]
        # Whisper word strings carry their own leading spaces/punctuation.
        text = "".join(w["w"] for w in words).strip()
        if text:
            cleaned.append({**seg, "words": words, "text": text})
    return cleaned


def clean_existing_words(root):
    """Edit only existing transcripts; bypass discovery, stages and save_index."""
    index_path = root / ".sidething" / "index.json"
    original = index_path.read_bytes()
    index = json.loads(original)
    changed = False
    removed = []
    for clip in index.get("clips", []):
        segments = clip.get("transcript")
        if segments is None:
            continue
        if TRANSCRIPTION_LANGUAGE.lower() in {"en", "english"}:
            removed.extend({"clipId": clip["id"], **word}
                           for seg in segments for word in seg["words"]
                           if not is_latin_word(word["w"]))
        cleaned = clean_transcript_words(segments, TRANSCRIPTION_LANGUAGE)
        if cleaned != segments:
            clip["transcript"] = cleaned
            changed = True
    if changed:
        # Preserve updatedAt, caches, takes, judgement and every other field.
        if index_path.read_bytes() != original:
            raise RuntimeError("index changed during word cleanup; retry")
        tmp = index_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(index, indent=1), encoding="utf-8")
        tmp.replace(index_path)
    print(json.dumps({"cleanWordsOnly": True, "changed": changed,
                      "removedWords": removed}, ensure_ascii=False), flush=True)
    return 0


def is_hallucination(seg):
    no_speech = float(seg.get("no_speech_prob") or 0)
    logprob = float(seg.get("avg_logprob") or 0)
    if no_speech > NO_SPEECH_DROP and logprob < LOGPROB_LOW:
        return True
    if float(seg.get("compression_ratio") or 0) > COMPRESSION_DROP:
        return True
    start, end = float(seg.get("start") or 0), float(seg.get("end") or 0)
    dur = end - start
    if dur > 0:
        words = seg.get("words") or []
        count = len(words) if words else len((seg.get("text") or "").split())
        wps = count / dur
        if wps < WPS_MIN or wps > WPS_MAX:
            return True
    return False


def transcribe_clip(path, has_audio, sidething, sound=None, duration=None):
    if not has_audio:
        return []
    tmp = None
    try:
        sidething.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(suffix=".wav", dir=sidething)
        os.close(fd)
        source = path
        args = ["ffmpeg", "-y", "-v", "error"]
        if sound:
            source = sidething.parent / sound["file"]
            offset = float(sound["offsetS"])
            args += ["-ss", str(max(0, offset))]
        args += ["-i", str(source), "-vn", "-ac", "1", "-ar", "16000"]
        if sound and duration is not None:
            # Silence before/after a partial recording preserves camera-relative
            # word times. Never pull words from outside this clip's mic slice.
            delay = max(0, -offset)
            args += ["-af", f"adelay={delay * 1000}:all=1,apad,atrim=duration={duration}",
                     "-t", str(duration)]
        r = run(args + ["-c:a", "pcm_s16le", tmp])
        if r.returncode != 0:
            raise RuntimeError("could not extract audio for transcription")
        # Reuse an installed model read-only; new downloads/caches belong to
        # this shoot, as do the extracted WAV and tokenizer cache.
        snapshots = Path.home() / ".cache/huggingface/hub" / ("models--" + WHISPER_MODEL.replace("/", "--")) / "snapshots"
        local_models = sorted(snapshots.glob("*")) if snapshots.exists() else []
        model = str(local_models[-1]) if local_models else WHISPER_MODEL
        os.environ["HF_HOME"] = str(sidething / "models")
        os.environ["HF_HUB_CACHE"] = str(sidething / "models/hub")
        os.environ["TIKTOKEN_CACHE_DIR"] = str(sidething / "tokenizers")
        os.environ["NUMBA_CACHE_DIR"] = str(sidething / "numba")
        import mlx_whisper
        result = mlx_whisper.transcribe(
            tmp, path_or_hf_repo=model, word_timestamps=True,
            condition_on_previous_text=False, language=TRANSCRIPTION_LANGUAGE,
            verbose=False)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    segments = []
    for seg in result.get("segments", []):
        if is_hallucination(seg):
            continue
        words = [{"s": round(float(w["start"]), 2),
                  "e": round(float(w["end"]), 2),
                  "w": w.get("word", "")}
                 for w in seg.get("words", []) if w.get("word")]
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        segments.append({"s": round(float(seg["start"]), 2),
                         "e": round(float(seg["end"]), 2),
                         "text": text, "words": words})
    return clean_transcript_words(segments, TRANSCRIPTION_LANGUAGE)


def transcript_source(root, clip):
    """Fingerprint the audio actually transcribed, independent of match confidence."""
    sound = clip.get("sound")
    if not sound:
        return None
    source = root / sound["file"]
    stat = source.stat()
    return {"version": 1, "file": sound["file"], "offsetS": sound["offsetS"],
            "durationS": (clip.get("meta") or {}).get("durationS"),
            "size": stat.st_size, "mtimeNs": stat.st_mtime_ns}


def refresh_sound_transcripts(root, index, save):
    """Called after sync; completed clips get their mic transcript exactly once.

    A changed/rejected match also refreshes a previous mic transcript. Failures
    keep the source marker stale so a later run retries, rather than caching a
    camera transcript as though it came from the mic.
    """
    failures = []
    for clip in index.get("clips", []):
        try:
            source = transcript_source(root, clip)
            if source == clip.get("_transcriptSound") and clip.get("transcript") is not None:
                continue
            if source is None and clip.get("_transcriptSound") is None:
                continue
            emit(clip["id"], "transcript")
            meta = clip.get("meta") or {}
            clip["transcript"] = transcribe_clip(
                root / clip["file"], bool(meta.get("audioChannels")),
                root / ".sidething", clip.get("sound"), meta.get("durationS"))
            clip["_transcriptSound"] = source
            save()
        except Exception as exc:
            failures.append(clip["id"])
            print(json.dumps({"clipId": clip["id"], "stage": "error", "pct": 100,
                              "error": "mic transcription failed: " + str(exc)}), flush=True)
            # A failed native MLX import leaves partially registered native
            # types. Reimporting it can abort Python; retry in a fresh run.
            if isinstance(exc, ImportError):
                return failures
    return failures


# ----------------------------------------------------------------- shake ----
def sample_yavg(path, duration):
    """Mean luma via signalstats on short seeked samples across the clip."""
    values = []
    steps = 10
    for i in range(steps):
        t = (i + 0.5) * duration / steps if duration > 0 else 0
        r = run(["ffmpeg", "-v", "info", "-ss", str(round(t, 2)),
                 "-i", str(path), "-vf",
                 "format=yuv420p,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
                 "-frames:v", "2", "-f", "null", "-"])
        for line in (r.stderr or "").splitlines():
            if "lavfi.signalstats.YAVG=" in line:
                try:
                    values.append(float(line.split("YAVG=")[1]))
                except ValueError:
                    pass
    return values


def measure_shake(path, fps, duration):
    yavgs = sample_yavg(path, duration)
    if yavgs:
        dark = sum(1 for v in yavgs if v < DARK_YAVG_THRESHOLD) / len(yavgs)
        if dark > DARK_FRACTION:
            return {"measured": False, "meanPx": None, "p95Px": None,
                    "perSecond": [], "shakySpans": []}
    import cv2
    import numpy as np
    width, height = 320, 180
    frame_bytes = width * height
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf",
         "scale=320:180,format=gray", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    prev, deltas = None, []
    assert proc.stdout is not None
    while True:
        buf = proc.stdout.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        gray = np.frombuffer(buf, np.uint8).reshape(height, width).astype(np.float32)
        if prev is not None:
            (dx, dy), _ = cv2.phaseCorrelate(prev, gray)
            deltas.append((dx, dy))
        prev = gray
    proc.wait()
    if len(deltas) < 4:
        return {"measured": True, "meanPx": 0.0, "p95Px": 0.0,
                "perSecond": [], "shakySpans": []}
    d = np.array(deltas)
    path_xy = np.cumsum(d, axis=0)
    k = 13
    kernel = np.ones(k) / k
    smooth = np.stack([np.convolve(path_xy[:, i], kernel, mode="same")
                       for i in (0, 1)], axis=1)
    jitter = np.linalg.norm(path_xy - smooth, axis=1)
    if len(path_xy) > 2 * k:
        jitter = jitter[k:-k]
    if len(jitter) == 0:
        jitter = np.array([0.0])
    per_frame_fps = int(round(fps)) if fps and fps > 0 else 25
    per_second = [round(float(jitter[i:i + per_frame_fps].mean()), 2)
                  for i in range(0, len(jitter), per_frame_fps)
                  if len(jitter[i:i + per_frame_fps]) > 0]
    spans = []
    start = None
    for idx, val in enumerate(per_second):
        if val > SHAKY_JITTER_PX and start is None:
            start = idx
        elif val <= SHAKY_JITTER_PX and start is not None:
            spans.append([float(start), float(idx)])
            start = None
    if start is not None:
        spans.append([float(start), float(len(per_second))])
    return {"measured": True,
            "meanPx": round(float(jitter.mean()), 2),
            "p95Px": round(float(np.percentile(jitter, 95)), 2),
            "perSecond": per_second,
            "shakySpans": spans}


# ---------------------------------------------------------- frames/proxy ----
def extract_frames(path, clip_id, duration, is_log, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    vf = "scale=480:-2" + ("," + LOG_LIFT if is_log else "")
    names = []
    for n in range(8):
        name = f"{clip_id}_{n}.jpg"
        dest = out_dir / name
        t = (n + 0.5) * duration / 8 if duration > 0 else n * 1.0
        r = run(["ffmpeg", "-y", "-v", "error", "-ss", str(round(t, 3)),
                 "-i", str(path), "-vf", vf, "-frames:v", "1",
                 "-q:v", "3", str(dest)])
        if r.returncode != 0 or not dest.exists():
            raise RuntimeError(f"could not extract frame {n}")
        names.append(name)
    return names


def make_proxy(path, clip_id, is_log, has_audio, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{clip_id}.mp4"
    dest = out_dir / name
    vf = "scale=-2:720,format=yuv420p" + ("," + LOG_LIFT if is_log else "")
    # lift must run before format conversion for 10-bit sources; rebuild chain
    vf = ("scale=-2:720" + ("," + LOG_LIFT if is_log else "") + ",format=yuv420p")
    base = ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-vf", vf,
            "-c:v", "h264_videotoolbox", "-b:v", "6M"]
    # faststart puts the index at the front so the drawer can seek anywhere at once.
    tail = (["-c:a", "aac", "-b:a", "128k"] if has_audio else ["-an"]) + ["-movflags", "+faststart", str(dest)]
    r = run(base + tail)
    if r.returncode != 0 or not dest.exists():
        # videotoolbox unavailable on this machine: fall back so playback works
        base_fb = ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-vf", vf,
                   "-c:v", "libx264", "-preset", "medium", "-b:v", "6M"]
        r = run(base_fb + tail)
        if r.returncode != 0 or not dest.exists():
            raise RuntimeError("could not encode proxy")
    return name


# --------------------------------------------------------------- index io ----
def discover(root):
    clips, audios = [], []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or ".sidething" in p.parts:
            continue
        suffix = p.suffix.lower()
        if suffix in CLIP_EXTS:
            clips.append(p)
        elif suffix in AUDIO_EXTS:
            audios.append(p)
    return clips, audios


def empty_clip(path, root):
    return {"id": path.stem, "file": str(path.relative_to(root)),
            "stage": "probe", "meta": None, "transcript": None,
            "shake": None, "frames": [], "proxy": None, "judgement": None}


def load_index(root, sidething):
    index_path = sidething / "index.json"
    if index_path.exists():
        try:
            data = json.loads(index_path.read_text())
            if isinstance(data, dict) and "clips" in data:
                return data
        except Exception:
            pass
    return {"schemaVersion": SCHEMA_VERSION, "name": root.name,
            "root": str(root), "createdAt": now_iso(), "updatedAt": now_iso(),
            "script": [], "scriptSource": "none", "clips": [],
            "audio": [], "takes": [], "_cache": {"clips": {}, "audio": {}}}


def save_index(sidething, index):
    index["updatedAt"] = now_iso()
    sidething.mkdir(parents=True, exist_ok=True)
    tmp = sidething / "index.json.tmp"
    tmp.write_text(json.dumps(index, indent=1))
    tmp.replace(sidething / "index.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("shoot")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--clip", default=None)
    mode.add_argument("--clean-words-only", action="store_true",
                      help="clean existing English transcript words; run no stages")
    args = parser.parse_args()
    root = Path(args.shoot).expanduser().resolve()
    if not root.is_dir():
        print(json.dumps({"clipId": "", "stage": "error", "pct": 100,
                          "error": f"shoot folder not found: {root}"}), flush=True)
        return 1
    if args.clean_words_only:
        return clean_existing_words(root)
    sidething = root / ".sidething"
    frames_dir = sidething / "frames"
    proxies_dir = sidething / "proxies"
    index = load_index(root, sidething)
    index.setdefault("_cache", {"clips": {}, "audio": {}})
    index["_cache"].setdefault("clips", {})
    index["_cache"].setdefault("audio", {})
    index["name"] = root.name
    index["root"] = str(root)
    index.setdefault("script", [])
    index.setdefault("scriptSource", "none")
    index.setdefault("takes", [])

    clip_files, audio_files = discover(root)
    old_clips = {c["id"]: c for c in index.get("clips", [])}
    cache = index["_cache"]["clips"]

    clips = []
    for path in clip_files:
        clip_id = path.stem
        stat = path.stat()
        key = {"size": stat.st_size, "mtime": stat.st_mtime}
        old = old_clips.get(clip_id)
        if old is not None and cache.get(clip_id) == key:
            clips.append(old)
        else:
            fresh = empty_clip(path, root)
            if old is not None:
                fresh["judgement"] = old.get("judgement")
                if old.get("_transcriptSound") is not None:
                    fresh["_transcriptSound"] = old["_transcriptSound"]
                if (old.get("sound") or {}).get("byHand"):
                    fresh["sound"] = old["sound"]
                if "byHand" in old:
                    fresh["byHand"] = old["byHand"]
            cache[clip_id] = key
            clips.append(fresh)
    index["clips"] = clips
    clip_by_id = {c["id"]: c for c in clips}
    path_by_id = {p.stem: p for p in clip_files}

    # separate audio files
    old_audio = {a["file"]: a for a in index.get("audio", [])}
    acache = index["_cache"]["audio"]
    audios = []
    for path in audio_files:
        rel = str(path.relative_to(root))
        stat = path.stat()
        key = {"size": stat.st_size, "mtime": stat.st_mtime}
        if rel in old_audio and acache.get(rel) == key:
            audios.append(old_audio[rel])
        else:
            entry = probe_audio(path)
            entry["file"] = rel
            acache[rel] = key
            audios.append(entry)
    index["audio"] = audios
    save_index(sidething, index)

    def wanted(clip):
        if args.clip is None:
            return True
        return clip["id"] == args.clip or clip["id"].endswith(args.clip)

    for clip in clips:
        if not wanted(clip):
            continue
        clip_id = clip["id"]
        path = path_by_id[clip_id]
        if clip.get("stage") == "done":
            # fully cached: verify outputs still on disk, else redo missing
            ok = (clip.get("meta") is not None and clip.get("transcript") is not None
                  and clip.get("shake") is not None and len(clip.get("frames") or []) == 8
                  and clip.get("proxy")
                  and (proxies_dir / clip["proxy"]).exists()
                  and all((frames_dir / f).exists() for f in clip["frames"]))
            if ok:
                continue
        if clip.get("stage") == "error":
            continue  # terminal until the source file changes (cache key)
        try:
            # probe
            if clip.get("meta") is None:
                clip["stage"] = "probe"
                meta, is_log = probe_clip(path)
                clip["meta"] = meta
                clip.pop("error", None)
                save_index(sidething, index)
                emit(clip_id, "probe")
            else:
                meta = clip["meta"]
                is_log = bool(meta.get("pictureProfile")
                              and "log" in meta["pictureProfile"].lower())
            duration = float(meta.get("durationS") or 0)
            has_audio = int(meta.get("audioChannels") or 0) > 0
            # transcript
            if clip.get("transcript") is None:
                clip["stage"] = "transcript"
                clip["transcript"] = transcribe_clip(path, has_audio, sidething, clip.get("sound"), duration)
                clip["_transcriptSound"] = transcript_source(root, clip)
                save_index(sidething, index)
                emit(clip_id, "transcript")
            # shake
            if clip.get("shake") is None:
                clip["stage"] = "shake"
                clip["shake"] = measure_shake(path, float(meta.get("fps") or 25), duration)
                save_index(sidething, index)
                emit(clip_id, "shake")
            # frames
            frames_ok = len(clip.get("frames") or []) == 8 and all(
                (frames_dir / f).exists() for f in clip["frames"])
            if not frames_ok:
                clip["stage"] = "frames"
                clip["frames"] = extract_frames(path, clip_id, duration, is_log, frames_dir)
                save_index(sidething, index)
                emit(clip_id, "frames")
            # proxy
            proxy_ok = bool(clip.get("proxy")) and (proxies_dir / (clip.get("proxy") or "")).exists()
            if not proxy_ok:
                clip["stage"] = "proxy"
                clip["proxy"] = make_proxy(path, clip_id, is_log, has_audio, proxies_dir)
                save_index(sidething, index)
                emit(clip_id, "proxy")
            clip["stage"] = "done"
            clip.pop("error", None)
            save_index(sidething, index)
            emit(clip_id, "done")
        except RuntimeError as exc:
            clip["stage"] = "error"
            clip["error"] = str(exc)
            save_index(sidething, index)
            emit(clip_id, "error")
        except Exception as exc:  # one bad clip must not stop the shoot
            clip["stage"] = "error"
            clip["error"] = f"{type(exc).__name__}: {exc}"
            save_index(sidething, index)
            emit(clip_id, "error")
    return 0


if __name__ == "__main__":
    sys.exit(main())
