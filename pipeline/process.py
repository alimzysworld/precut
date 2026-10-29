#!/usr/bin/env python3
"""Turn a shoot folder into <shoot>/.sidething/index.json (schema Shoot).

Run as: python -I pipeline/process.py <shoot> [--clip <id>]
Or: python -I pipeline/process.py <shoot> --clean-words-only
One clip at a time; index written after every stage. Progress is one JSON
line per event on stdout: {"clipId","stage","pct"}. Originals never touched.
Ports reference/proven-scripts/shake.py and transcribe/words.py.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import string
import subprocess
import sys
import tempfile
import time
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sys; sys.path.insert(0, str(Path(__file__).resolve().parent)); from setup import tool
from photos import PHOTO_EXTS, ensure_still, original_file
from source_audio import select_audio, audio_stream, audio_input

SCHEMA_VERSION = 1
CLIP_EXTS = {".mp4", ".mov", ".mxf", ".mts", ".m4v"}
AUDIO_EXTS = {".wav", ".mp3", ".m4a"}
LOG_LIFT = "eq=contrast=1.35:saturation=1.4:gamma=0.85"
WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"
WHISPER_REVISION = "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"  # REL2: pinned, as model.py downloads it
TRANSCRIPTION_LANGUAGE = "en"
WORD_PUNCTUATION = frozenset(string.punctuation + "‘’“”‚„‐‑‒–—―…")

# Hallucination filters use Whisper's own signals, never word lists.
NO_SPEECH_DROP = 0.6        # segment no_speech_prob above this ...
LOGPROB_LOW = -1.0          # ... together with avg_logprob below this
COMPRESSION_DROP = 2.4      # compression_ratio above this
WPS_MIN = 0.2               # words per second below this is not speech
WPS_MAX = 6.0               # words per second above this is not human speech
# PF1b: large-v3-turbo's no_speech_prob is ~0 on every segment (measured on 24
# real clips), so the no-speech rule above never fires. Two measured checks do:
# - Whisper retries a segment at higher temperatures until avg_logprob >= LOGPROB_LOW
#   and compression <= COMPRESSION_DROP; a segment that still fails is its last random
#   sample (measured -5 to -8 on room and street sound), not a reading of the audio.
# - The Mac's sound classifier (pipeline/voice.swift) measures speech under the words.
#   A segment with no window it scores as speech is dropped. SPEECH_PRESENT is the
#   classifier's own decision point (speech more likely present than not).
SPEECH_PRESENT = 0.5

# Darkness: signalstats YAVG (8-bit) under this for most sampled frames means
# too dark to measure shake. Spec said ~16; the real S-Log3 black clip (0985)
# measures 24.6 because log raises the black pedestal, while lit night clips
# measure ~82, so 32 separates them. See qa/S2/REPORT.md.
DARK_YAVG_THRESHOLD = 32.0
DARK_FRACTION = 0.5

# Shake: high-frequency jitter (px at 320px width) above this for a second
# marks that second shaky. Picked from the real shoot, see REPORT.md.
SHAKY_JITTER_PX = 1.0

STAGES = ["probe", "transcript", "shake", "frames"]
STAGE_PCT = {"probe": 10, "transcript": 40, "shake": 60, "frames": 80,
             "proxy": 95, "done": 100, "error": 100}
_FILLERS_MODULE = None


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
        r = run([tool("exiftool"), "-ee", "-j", "-s", "-G", str(path)])
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


def orientation_turn(value, exif=False):
    """Only explicit right-angle orientation; never infer from frame shape."""
    text = str(value).strip().lower()
    labels = {"normal": 0, "top-left": 0, "bottom-right": 180,
              "right-top": 90, "left-bottom": 270}
    if text in labels:
        return labels[text]
    try:
        n = float(text)
        if exif and n in (1, 3, 6, 8):  # EXIF orientation, excluding mirrored variants
            return {1: 0, 3: 180, 6: 90, 8: 270}[n]
        return int(n) % 360 if n % 90 == 0 else None
    except (ValueError, TypeError):
        return None


def probe_sidecar(path):
    """Sony M01.XML sidecar: picture profile + camera fallback."""
    result = {"pictureProfile": None, "camera": None, "rotation": None}
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
            field = el.attrib.get("name", el.tag.split("}")[-1]).lower()
            if field in ("orientation", "rotation", "imagerotation", "displayrotation"):
                turn = orientation_turn(el.attrib.get("value", el.text or ""), exif=field == "orientation")
                if turn is not None:
                    result["rotation"] = turn
            for key, value in el.attrib.items():
                if key.lower() in ("orientation", "rotation", "imagerotation", "displayrotation"):
                    turn = orientation_turn(value, exif=key.lower() == "orientation")
                    if turn is not None:
                        result["rotation"] = turn
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
    r = run([tool("ffprobe"), "-v", "quiet", "-print_format", "json",
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
    audio = select_audio(streams)
    fmt = data.get("format", {})

    fps = parse_fraction(video.get("avg_frame_rate")) or \
        parse_fraction(video.get("r_frame_rate"))
    pix = video.get("pix_fmt") or ""
    chroma = "4:2:2" if "422" in pix else "4:2:0" if "420" in pix else \
        "4:4:4" if "444" in pix else ""
    bits = "12-bit" if "12" in pix or str(video.get("bits_per_raw_sample")) == "12" \
        else "10-bit" if "10" in pix or str(video.get("bits_per_raw_sample")) == "10" \
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

    # iPhone's local capture date includes its UTC offset; prefer it to the
    # generic QuickTime creation clock (Sony normally supplies UTC there).
    for source in [fmt, video, audio]:
        capture = ((source or {}).get("tags") or {}).get("com.apple.quicktime.creationdate")
        if not capture:
            continue
        try:
            date = datetime.fromisoformat(capture.replace("Z", "+00:00"))
            if date.tzinfo is not None:
                created = date.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                break
        except (ValueError, TypeError):
            pass

    duration = to_float(fmt.get("duration")) or to_float(video.get("duration")) or 0.0
    exif = probe_exif(path)
    sidecar = probe_sidecar(path)
    camera = exif["camera"] or sidecar["camera"]
    profile = sidecar["pictureProfile"]

    # ffprobe's display-matrix angle is counterclockwise. Legacy rotate tags
    # are clockwise. ffmpeg applies either before the explicit frame filters.
    matrix = next((s.get("rotation") for s in video.get("side_data_list", [])
                   if s.get("rotation") is not None), None)
    container_turn = orientation_turn(-float(matrix)) if matrix is not None else orientation_turn((video.get("tags") or {}).get("rotate", 0))
    container_turn = container_turn or 0
    rotation = container_turn if matrix is not None or "rotate" in (video.get("tags") or {}) else sidecar["rotation"] or 0
    coded_w, coded_h = int(video.get("width") or 0), int(video.get("height") or 0)

    meta = {
        "camera": camera,
        "width": coded_h if rotation % 180 else coded_w,
        "height": coded_w if rotation % 180 else coded_h,
        "codedWidth": coded_w, "codedHeight": coded_h,
        "rotation": rotation, "containerRotation": container_turn,
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
    from place import tagged_gps
    meta["_gps"] = tagged_gps(data)
    return meta, is_log


def probe_audio(path):
    r = run([tool("ffprobe"), "-v", "quiet", "-print_format", "json",
             "-show_streams", "-show_format", str(path)])
    duration, channels = 0.0, 0
    try:
        data = json.loads(r.stdout)
        duration = float(data.get("format", {}).get("duration") or 0)
        a = select_audio(data.get("streams", []))
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


def transcript_text(words):
    return " ".join(w["w"].strip() for w in words if w["w"].strip())


def keep_hand_words(segments, previous):
    """Overlay exact hand words (including silent deletion markers) on a fresh pass."""
    protected = [dict(w) for seg in previous or [] for w in seg.get("words", []) if w.get("byHand")]
    if not protected:
        return segments
    # Consecutive corrected words protect their whole span, including timing gaps.
    spans = []
    for seg in previous or []:
        for word in seg.get("words", []):
            if word.get("byHand"):
                if spans and spans[-1][2]:
                    spans[-1][1] = max(spans[-1][1], word["e"])
                else:
                    spans.append([word["s"], word["e"], True])
            elif spans:
                spans[-1][2] = False
    result = []
    for seg in segments or []:
        words = [dict(w) for w in seg.get("words", [])
                 if not any(w["s"] < e and w["e"] > s or w["s"] == w["e"] and s <= w["s"] < e
                            for s, e, _ in spans)]
        if words:
            result.append({**seg, "words": words, "text": transcript_text(words)})
    for word in protected:
        owner = next((seg for seg in result if seg["s"] <= word["s"] < seg["e"]), None)
        if owner is None:
            owner = {"s": word["s"], "e": word["e"], "text": "", "words": []}
            result.append(owner)
        owner["words"].append(word)
    for seg in result:
        seg["words"].sort(key=lambda w: (w["s"], w["e"]))
        seg.update(s=seg["words"][0]["s"], e=max(w["e"] for w in seg["words"]),
                   text=transcript_text(seg["words"]))
    return sorted(result, key=lambda seg: seg["s"])


def refresh_hand_attempts(index):
    clips = {c["id"]: c for c in index.get("clips", [])}
    for take in index.get("takes", []):
        for attempt in take.get("attempts", []):
            words = [w for seg in clips.get(attempt["clipId"], {}).get("transcript") or []
                     for w in seg.get("words", []) if w["s"] < attempt["e"] and w["e"] > attempt["s"]]
            if any(w.get("byHand") for w in words):
                attempt["text"] = transcript_text(words)


def clean_transcript_words(segments, language):
    """Script measurement only; other transcription languages pass through."""
    if language.lower() not in {"en", "english"}:
        return segments
    cleaned = []
    for seg in segments:
        words = [w for w in seg["words"] if w.get("byHand") or is_latin_word(w["w"])]
        # Whisper word strings carry their own leading spaces/punctuation.
        text = transcript_text(words) if any(w.get("byHand") for w in words) else "".join(w["w"] for w in words).strip()
        if text or any(w.get("byHand") for w in words):
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
                           if not word.get("byHand") and not is_latin_word(word["w"]))
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
    if logprob < LOGPROB_LOW:  # every retry failed Whisper's own check: a random sample
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


def voice_tool():
    """pipeline/voice.swift, bundled with the app or compiled once (like quality.py)."""
    swift = Path(__file__).with_name("voice.swift")
    bundled = Path(tool("voice"))
    if bundled.is_absolute() and bundled.parent.name == "tools" and bundled.is_file():
        return bundled
    directory = Path(os.environ.get("PRECUT_VOICE_BIN_DIR") or (
        Path.home() / "Library" / "Application Support" / "precut" / "bin"))
    directory.mkdir(parents=True, exist_ok=True)
    binary = directory / ("voice-" + hashlib.sha256(swift.read_bytes()).hexdigest()[:16])
    if binary.is_file():
        return binary
    compiler = shutil.which("swiftc")
    if not compiler:
        raise RuntimeError("Swift compiler missing")
    # Share quality.py's module cache: it is already warm after the first shoot.
    for attempt in range(2):
        with tempfile.TemporaryDirectory(prefix="voice-build-", dir=directory) as work:
            cache = Path(work) / "modules" if attempt else directory / "quality-modules"
            cache.mkdir(exist_ok=True)
            output = Path(work) / "voice"
            built = subprocess.run([compiler, "-O", "-module-cache-path", str(cache), str(swift), "-o", str(output)],
                                   stdout=sys.stderr, stderr=sys.stderr)
            if built.returncode == 0:
                os.replace(output, binary)
                return binary
    raise RuntimeError("could not compile the speech check")


def measured_speech(wav):
    """[(start, end, speech confidence)] for 1 s windows, or None when not measured.

    Optional: if the check cannot run, the transcript keeps Whisper's own filters.
    """
    try:
        result = subprocess.run([str(voice_tool()), str(wav)], capture_output=True, timeout=600)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode(errors="replace")[-300:])
        rows = [(float(r["s"]), float(r["e"]), float(r["speech"])) for r in json.loads(result.stdout or b"[]")]
        return rows or None  # under one window of audio: nothing measured
    except Exception as exc:
        print(f"speech check skipped: {exc}", file=sys.stderr, flush=True)
        return None


def heard(segments, windows):
    """Keep only segments with measured speech under their words."""
    if windows is None:
        return segments
    kept = []
    for seg in segments:
        spans = [(w["s"], w["e"]) for w in seg.get("words") or []] or [(seg["s"], seg["e"])]
        if any(speech >= SPEECH_PRESENT and ws < e and we > s
               for s, e in spans for ws, we, speech in windows):
            kept.append(seg)
    return kept


@contextmanager
def voice_audio(path, sidething, sound=None, duration=None, span=None):
    """One camera-aligned WAV for both the transcript and verbatim filler pass."""
    tmp = None
    try:
        sidething.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(suffix=".wav", dir=sidething)
        os.close(fd)
        source = path
        args = [tool("ffmpeg"), "-y", "-v", "error"]
        if span:
            args += ["-ss", str(max(0.0, span[0])), "-t", str(max(0.01, span[1] - span[0]))]
        if sound:
            source = sidething.parent / sound["file"]
            offset = float(sound["offsetS"])
            args += ["-ss", str(max(0, offset))]
        args += audio_input(source, duration) + ["-vn", "-ac", "1", "-ar", "16000"]
        if sound and duration is not None:
            # Silence before/after a partial recording preserves camera-relative
            # word times. Never pull words from outside this clip's mic slice.
            delay = max(0, -offset)
            args += ["-af", f"adelay={delay * 1000}:all=1,apad,atrim=duration={duration}",
                     "-t", str(duration)]
        r = run(args + ["-c:a", "pcm_s16le", tmp])
        if r.returncode != 0:
            raise RuntimeError("could not extract audio for transcription")
        yield tmp
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def wait_for_model_download(sidething):
    """The first-run download runs beside the app; only transcription waits for it."""
    lock = sidething / "models" / ".downloading"
    deadline = time.time() + 60 * 60
    while lock.exists() and time.time() < deadline:
        try:
            os.kill(int(lock.read_text().strip()), 0)
        except (OSError, ValueError):
            return
        time.sleep(2)


def whisper_model(sidething):
    sidething = Path.home() / "Library" / "Application Support" / "precut"
    # Reuse an installed model read-only; all new caches belong to the shoot.
    snapshots = Path.home() / ".cache/huggingface/hub" / ("models--" + WHISPER_MODEL.replace("/", "--")) / "snapshots"
    local_models = sorted(snapshots.glob("*")) if snapshots.exists() else []
    wait_for_model_download(sidething)
    os.environ["HF_HOME"] = str(sidething / "models")
    os.environ["HF_HUB_CACHE"] = str(sidething / "models/hub")
    os.environ["TIKTOKEN_CACHE_DIR"] = str(sidething / "tokenizers")
    os.environ["NUMBA_CACHE_DIR"] = str(sidething / "numba")
    # REL2: the pinned revision, wherever it is cached; an older local copy only when the pinned one is not there.
    folder = "models--" + WHISPER_MODEL.replace("/", "--")
    for hub in (sidething / "models/hub", Path.home() / ".cache/huggingface/hub"):
        pinned = hub / folder / "snapshots" / WHISPER_REVISION
        if (pinned / "config.json").exists():
            return str(pinned)
    if local_models:
        return str(local_models[-1])
    try:
        from huggingface_hub import snapshot_download
        return snapshot_download(WHISPER_MODEL, revision=WHISPER_REVISION)
    except Exception:
        return WHISPER_MODEL


def vocabulary_prompt():
    """Local spelling hints from Preferences; no speech/model request of its own."""
    try:
        words = json.loads(os.environ.get("SIDETHING_VOCABULARY", "[]"))
    except (ValueError, TypeError):
        return ""
    if not isinstance(words, list):
        return ""
    return ", ".join(word.strip() for word in words if isinstance(word, str) and word.strip())[:4000]


# ANA1: how far each whisper pass has heard, as {"stage": "transcribing", "pct"} events, so a long clip's
# time left counts down. Whisper's own progress bar is replaced; what it transcribes is not touched.
HEARD = {"clip": None, "lo": 0.0, "hi": 100.0}


class _Heard:
    def __init__(self, total=0, **_):
        self.total, self.n, self.sent = max(1, int(total or 0)), 0, -100.0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def update(self, n=1):
        self.n += n
        clip = HEARD["clip"]
        if not clip:
            return
        pct = HEARD["lo"] + (HEARD["hi"] - HEARD["lo"]) * min(1.0, self.n / self.total)
        if pct - self.sent >= 5 or (pct >= HEARD["hi"] and self.sent < HEARD["hi"]):
            self.sent = pct
            print(json.dumps({"clipId": clip, "stage": "transcribing", "pct": round(pct, 1)}), flush=True)


def report_hearing():
    module = sys.modules.get("mlx_whisper.transcribe")
    if module is not None and getattr(module, "tqdm", None) is not None and not getattr(module.tqdm, "_precut", False):
        import types
        module.tqdm = types.SimpleNamespace(tqdm=_Heard, _precut=True)


def warm_speech_model(sidething):
    """ANA1: load the speech model and build its kernels on a second of silence, greedy only (temperature 0 draws
    no random numbers, so later transcripts are unchanged). Optional: any failure leaves it to the first clip."""
    try:
        import numpy as np
        model = whisper_model(sidething)
        if not Path(model).is_dir():
            return  # never starts a download: the first clip waits for the model as before
        import mlx_whisper
        report_hearing()
        mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=model, word_timestamps=True,
                               condition_on_previous_text=False, language=TRANSCRIPTION_LANGUAGE,
                               temperature=0.0, verbose=False)
    except Exception as exc:
        print(f"speech model warm-up skipped: {exc}", file=sys.stderr, flush=True)


def transcribe_clip(path, has_audio, sidething, sound=None, duration=None, span=None):
    """span=(s, e): only that stretch of the file, in file seconds (a voice piece heard again on its own)."""
    if not has_audio or audio_stream(sidething.parent / sound["file"] if sound else path) is None:
        return []
    with voice_audio(path, sidething, sound, duration, span) as tmp:
        model = whisper_model(sidething)
        import mlx_whisper
        report_hearing()
        result = mlx_whisper.transcribe(
            tmp, path_or_hf_repo=model, word_timestamps=True,
            initial_prompt=vocabulary_prompt() or None,
            condition_on_previous_text=False, language=TRANSCRIPTION_LANGUAGE,
            logprob_threshold=LOGPROB_LOW, compression_ratio_threshold=COMPRESSION_DROP,
            verbose=False)
        windows = measured_speech(tmp)
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
    cleaned = clean_transcript_words(heard(segments, windows), TRANSCRIPTION_LANGUAGE)
    if span:
        # Back on the file's clock, the same as a whole-file transcript.
        shift = lambda t: round(t + span[0], 3)
        cleaned = [{**seg, "s": shift(seg["s"]), "e": shift(seg["e"]),
                    "words": [{**w, "s": shift(w["s"]), "e": shift(w["e"])} for w in seg["words"]]} for seg in cleaned]
    return cleaned


def find_clip_fillers(root, clip, index):
    """Optional enrichment; the CLI and initial processing share one detector.

    Load by file so this also works with the job runner's isolated Python (-I).
    """
    global _FILLERS_MODULE
    if clip.get("photo"):
        clip["fillers"] = []
        return
    try:
        if _FILLERS_MODULE is None:
            spec = importlib.util.spec_from_file_location("clip_fillers", Path(__file__).with_name("fillers.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _FILLERS_MODULE = module
        _FILLERS_MODULE.fill_clip(root, clip, index.setdefault("_cache", {}).setdefault("fillers", {}))
    except Exception as exc:
        clip.pop("fillers", None)
        index.setdefault("_cache", {}).setdefault("fillers", {}).pop(clip["id"], None)
        print(json.dumps({"clipId": clip["id"], "stage": "transcript", "pct": 100,
                          "note": "finding ums", "error": f"fillers skipped: {exc}"}), flush=True)


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
    from media_changes import source_wanted
    for clip in index.get("clips", []):
        if not source_wanted(root, clip) or clip.get("photo"):
            continue
        try:
            source = transcript_source(root, clip)
            if source == clip.get("_transcriptSound") and clip.get("transcript") is not None:
                continue
            if source is None and clip.get("_transcriptSound") is None:
                continue
            emit(clip["id"], "transcript")
            meta = clip.get("meta") or {}
            clip["transcript"] = keep_hand_words(transcribe_clip(
                root / clip["file"], bool(meta.get("audioChannels")),
                root / ".sidething", clip.get("sound"), meta.get("durationS")), clip.get("transcript"))
            refresh_hand_attempts(index)
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
        r = run([tool("ffmpeg"), "-v", "info", "-ss", str(round(t, 2)),
                 "-i", str(path), "-an", "-vf",
                 "format=yuv420p,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
                 "-frames:v", "2", "-f", "null", "-"])
        for line in (r.stderr or "").splitlines():
            if "lavfi.signalstats.YAVG=" in line:
                try:
                    values.append(float(line.split("YAVG=")[1]))
                except ValueError:
                    pass
    return values


def measure_shake(path, fps, duration, candidate_dir=None, candidate_vf=None, gray_path=None, full_range=None):
    unmeasured = {"measured": False, "meanPx": None, "p95Px": None,
                  "perSecond": [], "shakySpans": []}
    if not math.isfinite(duration) or duration < 1:
        return unmeasured
    if full_range is None:
        info = json.loads(run([tool("ffprobe"), "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=color_range", "-of", "json", str(path)]).stdout)
        full_range = info["streams"][0].get("color_range") == "pc"
    import cv2
    import numpy as np
    from smart_frames import CANDIDATE_NAMES, CANDIDATE_OUTPUT
    width, height = 320, 180
    frame_bytes = width * height
    command = [tool("ffmpeg"), "-y", "-v", "error", "-i", str(path)]
    if candidate_dir is not None:
        command += ["-filter_complex", "[0:v]split=2[shake][pictures];[shake]scale=320:180,format=gray[gray];"
                    + "[pictures]" + candidate_vf + "[frames]", "-map", "[gray]", "-an", "-f", "rawvideo", "pipe:1",
                    "-map", "[frames]", "-an", *CANDIDATE_OUTPUT, "-q:v", "3", str(candidate_dir / CANDIDATE_NAMES)]
    else:
        command += ["-vf", "scale=320:180,format=gray", "-an", "-f", "rawvideo", "pipe:1"]
    proc = None if gray_path else subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    stream = open(gray_path, 'rb') if gray_path else proc.stdout
    prev, deltas, lumas = None, [], []
    assert stream is not None
    while True:
        buf = stream.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        gray = np.frombuffer(buf, np.uint8).reshape(height, width).astype(np.float32)
        # gray is full range. Match the old signalstats sample's source range:
        # Sony log is full range, while a legal-range input needs its pedestal.
        mean = float(gray.mean())
        lumas.append(mean if full_range else 16 + mean * 219 / 255)
        if prev is not None:
            (dx, dy), _ = cv2.phaseCorrelate(prev, gray)
            deltas.append((dx, dy))
        prev = gray
    stream.close()
    if proc:
        proc.wait()
    # Preserve the ten mid-bin samples, two frames per sample, the threshold,
    # and strict > fraction. No independent luma seeks or source opens.
    yavgs = [lumas[min(len(lumas) - 1, max(0, int(round((i + .5) * duration / 10 * fps)) + j))]
             for i in range(10) for j in range(2)] if lumas else []
    if yavgs and sum(v < DARK_YAVG_THRESHOLD for v in yavgs) / len(yavgs) > DARK_FRACTION:
        return unmeasured
    # Trust decoded frame counts, not container duration or rounded frame rate.
    # np.convolve(mode="same") returns max(signal, kernel) rows.
    if (proc and proc.returncode != 0) or len(deltas) < 13:
        return unmeasured
    d = np.array(deltas)
    if not np.isfinite(d).all():
        return unmeasured
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
    per_frame_fps = max(1, int(round(fps))) if fps and math.isfinite(fps) and fps > 0 else 25
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
def extract_frames(path, clip_id, duration, is_log, out_dir, turn=0, shake=None, candidates=None):
    from smart_frames import extract_smart_frames
    return extract_smart_frames(path, clip_id, duration, is_log, out_dir, turn, shake, tool, LOG_LIFT, candidates)


def picture_work(root, frames_dir, clip, path, meta, is_log, duration):
    """ANA1: shake and stills for one clip, in a worker process (its own GIL). Reads the clip; never writes the index."""
    turn = (clip_rotation(clip) - meta.get("containerRotation", 0)) % 360
    frames_ok = 8 <= len(clip.get("frames") or []) <= 16 and clip.get("_smartFramesVersion") == 1 and all(
        (frames_dir / f).exists() for f in clip["frames"]) and clip.get("_framesRotation") == clip_rotation(clip)
    # V4 supplies the original, upright timestamped candidates. V1 owns
    # selection; no preview pixels are used for judgement or shake.
    from shared_visual import shared_visual
    shared = shared_visual(root, clip) if clip.get("shake") is None or not frames_ok else None
    frames_dir.mkdir(parents=True, exist_ok=True)
    found = {}
    with tempfile.TemporaryDirectory(prefix="candidates-", dir=frames_dir) as work:
        from smart_frames import candidate_filter, candidate_rate, candidate_rows
        rate = candidate_rate(duration)
        candidate_dir = Path(work)
        shake = clip.get("shake")
        if shake is None:
            rotation = {90: "transpose=clock,", 180: "hflip,vflip,", 270: "transpose=cclock,"}.get(turn, "")
            vf = rotation + candidate_filter(rate) + ",scale=480:-2" + ("," + LOG_LIFT if is_log else "")
            shake = found["shake"] = measure_shake(path, float(meta.get("fps") or 25), duration,
                                                   candidate_dir if not frames_ok else None, vf, shared["gray"] if shared else None, shared.get("fullRange") if shared else None)
        if not frames_ok:
            candidates = shared["candidates"] if shared else candidate_rows(candidate_dir)
            found["frames"] = extract_frames(path, clip["id"], duration, is_log, frames_dir, turn, shake, candidates or None)
            found["_framesRotation"] = clip_rotation(clip)
            found["_smartFramesVersion"] = 1
    if shared:
        # Raw full-rate pictures are large. Selection has copied its
        # chosen JPEGs, so release this handoff as soon as consumed.
        shutil.rmtree(Path(shared["gray"]).parent)
    return found


def clip_rotation(clip):
    # Mirror src/shared/media.ts clipTurn at this Python IO boundary.
    extra = (clip.get("byHand") or {}).get("rotate", (clip.get("judgement") or {}).get("rotate", 0))
    return ((clip.get("meta") or {}).get("rotation", 0) + extra) % 360


# --------------------------------------------------------------- index io ----
def discover(root, export_folder=None):
    """Prune generated media and card housekeeping before visiting files."""
    root = Path(root)
    configured = export_folder or os.environ.get("PRECUT_EXPORT_FOLDER")
    excluded = Path(configured).expanduser().resolve() if configured else None
    clips, audios = [], []
    for directory, folders, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        def allowed(name):
            full = parent / name
            if name.startswith(".") or full.is_symlink():
                return False
            if name.lower() in {"sidething precuts", "proxy", "proxies", "thmbnl", "thumbnail", "thumbnails"}:
                return False
            if name.lower() == "sub" and parent.name.lower() in {"m4root", "xdroot"}:
                return False
            return full.resolve() != excluded
        folders[:] = sorted(name for name in folders if allowed(name))
        for name in sorted(files):
            if not allowed(name):
                continue
            p = parent / name
            suffix = p.suffix.lower()
            if suffix in CLIP_EXTS or suffix in PHOTO_EXTS:
                clips.append(p)
            elif suffix in AUDIO_EXTS:
                audios.append(p)
    videos = {(p.parent, p.stem.casefold()) for p in clips if p.suffix.lower() in CLIP_EXTS}
    clips = [p for p in clips if p.suffix.lower() not in PHOTO_EXTS or (p.parent, p.stem.casefold()) not in videos]
    return sorted(clips), sorted(audios)


def safe_clip_id(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", value)
    value = re.sub(r"\s+", " ", value).strip(" .") or "clip"
    return value.encode("utf-8")[:160].decode("utf-8", errors="ignore").rstrip(" .")


def clip_id_key(value):
    # Cache filenames live on case-insensitive, normalization-insensitive disks.
    return unicodedata.normalize("NFD", value).upper().lower()


def assign_clip_ids(paths, root, existing=()):
    """Identity follows the indexed relative path, never discovery order."""
    previous = {original_file(c): c["id"] for c in existing}
    used = {clip_id_key(c["id"]) for c in existing}  # also reserve removed clips' cache keys
    ids = {str(p.relative_to(root)): previous[str(p.relative_to(root))]
           for p in paths if str(p.relative_to(root)) in previous}
    new = sorted((p for p in paths if str(p.relative_to(root)) not in ids),
                 key=lambda p: str(p.relative_to(root)))
    def candidate(p, depth):
        folders = p.relative_to(root).parts[:-1]
        return safe_clip_id(" ".join([*folders[-depth:], p.stem]) if depth else p.stem)
    counts = {}
    def unique(p, depth):
        if depth not in counts:
            counts[depth] = Counter(clip_id_key(candidate(other, depth)) for other in paths)
        return counts[depth][clip_id_key(candidate(p, depth))] == 1
    # Reserve unique stems first so a qualified name cannot steal a flat id.
    for p in new:
        stem = candidate(p, 0)
        if clip_id_key(stem) not in used and unique(p, 0):
            ids[str(p.relative_to(root))] = stem
            used.add(clip_id_key(stem))
    for p in new:
        rel = str(p.relative_to(root))
        if rel in ids:
            continue
        folders = p.relative_to(root).parts[:-1]
        for depth in range(1, len(folders) + 1):
            value = candidate(p, depth)
            if clip_id_key(value) not in used and unique(p, depth):
                break
        else:
            base = candidate(p, len(folders))
            digest = hashlib.sha256(rel.encode("utf-8")).hexdigest()
            size = 8
            value = f"{base} {digest[:size]}"
            while clip_id_key(value) in used:
                size += 1
                value = f"{base} {digest[:size]}" if size <= 64 else f"{base} {digest} {size - 64}"
        ids[rel] = value
        used.add(clip_id_key(value))
    return ids


def empty_clip(path, root, clip_id=None):
    return {"id": clip_id if clip_id is not None else path.stem, "file": str(path.relative_to(root)),
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


def merge_recordings(sidething, index):
    """Recordings are originals, journaled separately from pipeline snapshots."""
    journal = sidething / "voiceovers.json"
    if not journal.exists():
        return
    entries = {a["file"]: a for a in index.get("audio", [])}
    for take in json.loads(journal.read_text()):
        file = sidething.parent / take["file"]
        if not is_recording(take["file"]) or not file.is_file() or file.resolve() != file:
            continue
        previous = entries.get(take["file"], {})
        transcript = take.get("transcript") if take.get("transcript") is not None else previous.get("transcript")
        previous.update(take, transcript=transcript)
        entries[take["file"]] = previous
    index["audio"] = list(entries.values())


def is_recording(file):
    p = Path(file)
    # FIX2: takes recorded from 28 Oct live in .sidething/recordings; earlier ones stay in the exports folder.
    return p.parts[:2] in (("sidething precuts", "recordings"), (".sidething", "recordings")) and len(p.parts) == 3 and p.suffix.lower() == ".wav"


def refresh_voiceover_transcripts(root, index, save):
    failures = 0
    for entry in index.get("audio", []):
        matched = [c for c in index.get("clips", []) if (c.get("sound") or {}).get("file") == entry["file"]]
        entry["role"] = "voiceover" if is_recording(entry["file"]) or not matched and not entry.get("syncedTo") else "sync"
        if entry["role"] != "voiceover" or entry.get("transcript") is not None:
            continue
        try:
            entry["transcript"] = transcribe_clip(root / entry["file"], True, root / ".sidething", duration=entry.get("durationS"))
        except Exception as exc:
            failures += 1
            print(json.dumps({"clipId": "", "stage": "transcript", "pct": 100,
                              "error": f"voiceover transcription failed: {exc}"}), flush=True)
        save()
    save()
    return failures


def save_index(sidething, index):
    # Reconcile at the write boundary, including a correction made while a long
    # stage was running. Retry if a renderer saves during our temporary write.
    sidething.mkdir(parents=True, exist_ok=True)
    live_path = sidething / "index.json"
    # The app saves beside a running stage (preview links, stand-in strips, rotations), at times
    # several in a row: back off and merge again rather than fail the whole read.
    for attempt in range(40):
        if attempt:
            time.sleep(min(.5, .02 * attempt))
        before = live_path.read_bytes() if live_path.exists() else None
        live = json.loads(before) if before is not None else {}
        merge_recordings(sidething, index)
        saved = {c["id"]: c for c in live.get("clips", [])}
        for clip in index.get("clips", []):
            # Previews are linked by the app while transcription runs; never drop one.
            if not clip.get("proxy") and saved.get(clip["id"], {}).get("proxy"):
                clip["proxy"] = saved[clip["id"]]["proxy"]
            previous = saved.get(clip["id"], {}).get("transcript")
            if clip.get("photo"):
                clip["transcript"] = []
            elif clip.get("transcript") is not None:
                clip["transcript"] = keep_hand_words(clip["transcript"], previous)
            elif any(w.get("byHand") for seg in previous or [] for w in seg["words"]):
                clip["transcript"] = previous
                clip["_transcriptNeedsRefresh"] = True
        refresh_hand_attempts(index)
        index["updatedAt"] = now_iso()
        fd, name = tempfile.mkstemp(prefix="index-", suffix=".tmp", dir=sidething)
        tmp = Path(name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(index, output, indent=1)
            current = live_path.read_bytes() if live_path.exists() else None
            if current != before:
                continue
            tmp.replace(live_path)
            return
        finally:
            tmp.unlink(missing_ok=True)
    raise RuntimeError("shoot changed while saving the pipeline; retry")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("shoot")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--clip", default=None)
    mode.add_argument("--transcribe-audio", help="transcribe one shoot-relative audio file; return words without changing the index")
    mode.add_argument("--clean-words-only", action="store_true",
                      help="clean existing English transcript words; run no stages")
    parser.add_argument("--prepare-only", action="store_true", help="save metadata before previews, without transcription")
    parser.add_argument("--after", default=None,
                        help="load and warm the speech model, then wait for this marker file: go, or stop (ANA1)")
    parser.add_argument("--no-pictures", action="store_true",
                        help="never wait for a preview: stills whose shared decode has not landed wait for a later pass (ANA1)")
    parser.add_argument("--span", nargs=2, type=float, metavar=("S", "E"), default=None,
                        help="with --transcribe-audio: only this stretch of the file, in file seconds")
    args = parser.parse_args()
    root = Path(args.shoot).expanduser().resolve()
    if not root.is_dir():
        print(json.dumps({"clipId": "", "stage": "error", "pct": 100,
                          "error": f"shoot folder not found: {root}"}), flush=True)
        return 1
    if args.after:
        # Started beside the metadata read: the model is loaded and its kernels built while that runs.
        warm_speech_model(root / ".sidething")
        marker = Path(args.after)
        while not marker.exists():
            time.sleep(.1)
        if marker.read_text().strip() != "go":
            return 0
    if args.clean_words_only:
        return clean_existing_words(root)
    if args.transcribe_audio:
        source = (root / args.transcribe_audio).resolve()
        if not source.is_relative_to(root) or not source.is_file():
            raise ValueError("audio must be inside this shoot")
        span = tuple(args.span) if args.span else None
        if span and not (0 <= span[0] < span[1]):
            raise ValueError("choose a stretch inside the audio")
        transcript = transcribe_clip(source, True, root / ".sidething", span=span)
        print(json.dumps({"transcript": transcript}), flush=True)
        return 0
    sidething = root / ".sidething"
    frames_dir = sidething / "frames"
    index = load_index(root, sidething)
    index.setdefault("_cache", {"clips": {}, "audio": {}})
    index["_cache"].setdefault("clips", {})
    index["_cache"].setdefault("audio", {})
    index["name"] = root.name
    index["root"] = str(root)
    index.setdefault("script", [])
    index.setdefault("scriptSource", "none")
    index.setdefault("takes", [])

    from media_changes import accepted_files, source_wanted, reread_files, consume_reread
    accepted = accepted_files(root)
    reread, reread_done = reread_files(root), []
    clip_files, audio_files = discover(root)
    old_clips = {original_file(c): c for c in index.get("clips", [])}
    ids = assign_clip_ids(clip_files, root, index.get("clips", []))
    cache = index["_cache"]["clips"]

    clips = []
    for path in clip_files:
        rel = str(path.relative_to(root))
        clip_id = ids[rel]
        if accepted is not None and rel not in accepted:
            if rel in old_clips:
                clips.append(old_clips[rel])
            continue
        stat = path.stat()
        key = {"size": stat.st_size, "mtime": stat.st_mtime}
        if path.suffix.lower() in PHOTO_EXTS:
            key["mtimeNs"] = stat.st_mtime_ns
        old = old_clips.get(rel)
        if old is not None and cache.get(clip_id) == key and rel not in reread:
            clips.append(old)
        else:
            if rel in reread:
                reread_done.append(rel)
            fresh = empty_clip(path, root, clip_id)
            if old is not None:
                # Discovery is published before probing. Readers of an existing
                # edit must keep its last complete geometry throughout a reread.
                fresh["meta"] = old.get("meta")
                fresh["_metaNeedsRefresh"] = True
                if old.get("photo"):
                    fresh["file"] = old["file"]
                    fresh["photo"] = old["photo"]
                fresh["judgement"] = old.get("judgement")
                if any(w.get("byHand") for seg in old.get("transcript") or [] for w in seg["words"]):
                    fresh["transcript"] = old["transcript"]
                    fresh["_transcriptNeedsRefresh"] = True
                if old.get("_transcriptSound") is not None:
                    fresh["_transcriptSound"] = old["_transcriptSound"]
                if (old.get("sound") or {}).get("byHand"):
                    fresh["sound"] = old["sound"]
                if "byHand" in old:
                    fresh["byHand"] = old["byHand"]
            cache[clip_id] = key
            clips.append(fresh)
    # Keep absent cards and their reads/proxies, in their existing order.
    by_file = {original_file(c): c for c in clips}
    previous = list(old_clips)
    clips = [by_file.pop(file, old_clips[file]) for file in previous] + list(by_file.values())
    index["clips"] = clips
    clip_by_id = {c["id"]: c for c in clips}
    source_by_id = {ids[str(p.relative_to(root))]: p for p in clip_files}

    # separate audio files
    # NF1 deliberately excludes exports from discovery. Only this original-media
    # directory is opted back in, including playable takes left by a crash.
    for recordings in (root / "sidething precuts" / "recordings", root / ".sidething" / "recordings"):
        if recordings.is_dir() and recordings.resolve() == recordings:
            audio_files = sorted(set(audio_files) | {p for p in recordings.glob("*.wav") if p.is_file() and not p.is_symlink() and p.stat().st_size > 44})
    old_audio = {a["file"]: a for a in index.get("audio", [])}
    acache = index["_cache"]["audio"]
    audios = []
    for path in audio_files:
        rel = str(path.relative_to(root))
        if accepted is not None and rel not in accepted:
            if rel in old_audio:
                audios.append(old_audio[rel])
            continue
        stat = path.stat()
        key = {"size": stat.st_size, "mtime": stat.st_mtime}
        if rel in old_audio and acache.get(rel) == key:
            audios.append(old_audio[rel])
        else:
            entry = probe_audio(path)
            entry["file"] = rel
            if is_recording(rel):
                entry.update(role="voiceover", transcript=old_audio.get(rel, {}).get("transcript"))
            acache[rel] = key
            audios.append(entry)
    seen_audio = {a["file"] for a in audios}
    audios += [a for file, a in old_audio.items() if file not in seen_audio]
    index["audio"] = audios
    save_index(sidething, index)
    # The fresh cards and their new receipts are saved: a changed source is read once.
    consume_reread(root, reread_done)

    def wanted(clip):
        if args.clip is None:
            return True
        return clip["id"] == args.clip

    # ANA1: shake and stills come from each clip's preview decode. Transcripts never wait for it,
    # and pictures are taken in whichever order the decodes land (no clip waits behind another's).
    later = []

    def failed(clip, exc):
        clip["stage"] = "error"
        clip["error"] = str(exc) if isinstance(exc, RuntimeError) else f"{type(exc).__name__}: {exc}"
        save_index(sidething, index)
        emit(clip["id"], "error")

    def apply_pictures(clip, found):
        """On the main thread, the only index writer: the same saves and events as before, in one step."""
        clip_id = clip["id"]
        try:
            clip.update(found)
            if "shake" in found:
                emit(clip_id, "shake")
            if "frames" in found:
                emit(clip_id, "frames")
            # Playable proxies are made once by src/main/proxies.ts after
            # readGradeMetadata, using the device-agnostic camera conversion.
            clip["stage"] = "done"
            clip.pop("error", None)
            save_index(sidething, index)
            emit(clip_id, "done")
        except Exception as exc:  # one bad clip must not stop the shoot
            failed(clip, exc)

    # Pictures are worked out in a few worker processes while this one transcribes (threads fought the speech
    # model for the GIL: the first transcript took 62 s instead of 25); results are applied here, one index writer.
    pictures_pool, running = None, {}

    def take_pictures(block):
        nonlocal pictures_pool
        from shared_visual import visual_session, visual_waiting
        while True:
            for future in [f for f in running if f.done()]:
                clip = running.pop(future)[0]
                try:
                    apply_pictures(clip, future.result())
                except Exception as exc:  # one bad clip must not stop the shoot
                    failed(clip, exc)
            if later and len(running) < 3:
                session = visual_session(root)
                for item in [item for item in later if not visual_waiting(root, item[0], session)][:3 - len(running)]:
                    later.remove(item)
                    if pictures_pool is None:
                        import multiprocessing
                        from concurrent.futures import ProcessPoolExecutor
                        pictures_pool = ProcessPoolExecutor(max_workers=3, mp_context=multiprocessing.get_context("spawn"))
                    running[pictures_pool.submit(picture_work, root, frames_dir, *item)] = item
            if not block or not later and not running:
                return
            time.sleep(.1 if running else .2)

    # ANA1: probing is ffprobe + exiftool per clip (about 0.6 s each, one after another). Read the videos that
    # need it a few at a time up front; the results are applied below in order, exactly as before.
    def needs_probe(clip):
        path = source_by_id.get(clip["id"])
        return (path is not None and path.suffix.lower() not in PHOTO_EXTS and wanted(clip) and source_wanted(root, clip)
                and clip.get("stage") != "done" and not (clip.get("stage") == "error" and not clip.get("_metaNeedsRefresh"))
                and (clip.get("_metaNeedsRefresh") or clip.get("meta") is None or "codedWidth" not in clip["meta"]))
    probes, stills = {}, {}
    pending_probes = [clip for clip in clips if needs_probe(clip)]
    # Photos become a short still clip each (sips, then two ffmpeg passes), on their own lane.
    pending_stills = [clip for clip in clips if wanted(clip) and source_wanted(root, clip) and clip["id"] in source_by_id
                      and source_by_id[clip["id"]].suffix.lower() in PHOTO_EXTS]
    if len(pending_probes) + len(pending_stills) > 1:
        from concurrent.futures import ThreadPoolExecutor

        def read_probe(clip):
            try:
                return probe_clip(source_by_id[clip["id"]])
            except Exception as exc:  # raised again in order, by the clip's own step below
                return exc

        def make_still(clip):
            try:
                made = ensure_still(root, source_by_id[clip["id"]], clip["id"])
            except Exception as exc:
                return exc, None
            meta = clip.get("meta")
            if not (made[2] or clip.get("_metaNeedsRefresh") or meta is None or "codedWidth" not in meta):
                return made, None
            try:
                return made, probe_clip(root / made[0])
            except Exception as exc:
                return made, exc
        # Photo stills stay one at a time, beside the probes: VideoToolbox encodes running together come out with
        # slightly different pixels (measured 1.1 to 1.9/255), one after another they are the same every time.
        with ThreadPoolExecutor(max_workers=8) as pool, ThreadPoolExecutor(max_workers=1) as still_lane:
            probes_done = pool.map(read_probe, pending_probes)
            stills_done = still_lane.map(make_still, pending_stills)
            probes = dict(zip([clip["id"] for clip in pending_probes], probes_done))
            for clip, (made, probed) in zip(pending_stills, stills_done):
                stills[clip["id"]] = made
                if probed is not None:
                    probes[clip["id"]] = probed

    for clip in clips:
        if not wanted(clip) or not source_wanted(root, clip):
            continue
        clip_id = clip["id"]
        path = source_by_id[clip_id]
        # Metadata-only migration for cached media; never re-read its pictures.
        if "_placeRead" not in clip and (clip.get("meta") or path.suffix.lower() in PHOTO_EXTS):
            from place import photo_gps, video_gps, named_place
            try:
                gps = photo_gps(path) if path.suffix.lower() in PHOTO_EXTS else video_gps(path)
                clip["place"] = named_place(root, gps)
                clip["_placeRead"] = True
                save_index(sidething, index)
            except Exception as exc:
                print(f"Place metadata unavailable: {exc}", file=sys.stderr)
        if path.suffix.lower() in PHOTO_EXTS:
            try:
                made = stills.pop(clip_id, None)
                if isinstance(made, Exception):
                    raise made
                file, date, rebuilt = made if made is not None else ensure_still(root, path, clip_id)
                if rebuilt:
                    clip.update(_metaNeedsRefresh=True, frames=[], proxy=None, quality=None, stage="probe")
                clip.update(file=file, photo={"file": str(path.relative_to(root)), "takenAt": date},
                            transcript=[], fillers=[], sound=None,
                            shake={"measured": True, "meanPx": 0.0, "p95Px": 0.0, "perSecond": [], "shakySpans": []})
                clip.pop("_transcriptNeedsRefresh", None)
                clip.pop("_transcriptSound", None)
                path = root / file
            except Exception as exc:
                clip.update(stage="error", error=str(exc))
                save_index(sidething, index)
                emit(clip_id, "error")
                continue
        if clip.get("stage") == "done":
            # fully cached: verify outputs still on disk, else redo missing
            ok = (clip.get("meta") is not None and clip.get("transcript") is not None
                  and clip.get("shake") is not None and 8 <= len(clip.get("frames") or []) <= 16
                  and clip.get("_smartFramesVersion") == 1
                  and not clip.get("_metaNeedsRefresh")
                  and not clip.get("_transcriptNeedsRefresh")
                  and "codedWidth" in (clip.get("meta") or {})
                  and clip.get("_framesRotation") == clip_rotation(clip)
                  and all((frames_dir / f).exists() for f in clip["frames"]))
            if ok:
                if not args.prepare_only:
                    find_clip_fillers(root, clip, index)
                    save_index(sidething, index)
                continue
        if clip.get("stage") == "error" and not clip.get("_metaNeedsRefresh"):
            continue  # terminal until the source file changes (cache key)
        try:
            # probe
            if clip.get("_metaNeedsRefresh") or clip.get("meta") is None or "codedWidth" not in clip["meta"]:
                clip["stage"] = "probe"
                probed = probes.pop(clip_id, None)
                if isinstance(probed, Exception):
                    raise probed
                meta, is_log = probed if probed is not None else probe_clip(path)
                if not all(isinstance(meta.get(k), (int, float)) and math.isfinite(meta[k]) and meta[k] > 0
                           for k in ("width", "height")):
                    raise RuntimeError("Could not read source dimensions")
                from place import named_place
                gps = meta.pop("_gps", None)
                if "_placeRead" not in clip:
                    clip["place"] = named_place(root, gps)
                    clip["_placeRead"] = True
                clip["meta"] = meta
                clip.pop("_metaNeedsRefresh", None)
                if clip.get("photo"):
                    meta["createdAt"] = clip["photo"]["takenAt"]
                clip.pop("error", None)
                save_index(sidething, index)
                emit(clip_id, "probe")
            else:
                meta = clip["meta"]
                is_log = bool(meta.get("pictureProfile")
                              and "log" in meta["pictureProfile"].lower())
            duration = float(meta.get("durationS") or 0)
            total = clip_rotation(clip)
            rotated = meta.get("rotation", 0) % 180
            meta.setdefault("codedWidth", meta["height"] if rotated else meta["width"])
            meta.setdefault("codedHeight", meta["width"] if rotated else meta["height"])
            meta["width"], meta["height"] = ((meta["codedHeight"], meta["codedWidth"]) if total % 180 else (meta["codedWidth"], meta["codedHeight"]))
            has_audio = int(meta.get("audioChannels") or 0) > 0
            if args.prepare_only:
                continue
            # transcript
            if clip.get("transcript") is None or clip.get("_transcriptNeedsRefresh"):
                clip["stage"] = "transcript"
                HEARD.update(clip=clip_id, lo=0.0, hi=50.0)
                clip["transcript"] = keep_hand_words(
                    transcribe_clip(path, has_audio, sidething, clip.get("sound"), duration),
                    clip.get("transcript"))
                clip.pop("_transcriptNeedsRefresh", None)
                clip["_transcriptSound"] = transcript_source(root, clip)
                save_index(sidething, index)
                emit(clip_id, "transcript")
            HEARD.update(clip=clip_id, lo=50.0, hi=100.0)  # the verbatim pass for ums hears the clip again
            find_clip_fillers(root, clip, index)
            HEARD["clip"] = None
            save_index(sidething, index)
            print(json.dumps({"clipId": clip_id, "stage": "transcribing", "pct": 100}), flush=True)
            later.append((clip, path, meta, is_log, duration))
            take_pictures(block=False)
        except Exception as exc:  # one bad clip must not stop the shoot
            failed(clip, exc)
    # --no-pictures: transcripts never wait for a preview; the stills whose decode has not landed are left for the
    # pass after lining up sound (only what is already running is finished here).
    if args.no_pictures:
        later.clear()
    take_pictures(block=True)
    if pictures_pool is not None:
        pictures_pool.shutdown(wait=True)
    return 0


if __name__ == "__main__":
    # Standalone launches get the same priority as app launches. All ffmpeg,
    # model and Vision children inherit it, including Popen streaming readers.
    try:
        os.setpriority(os.PRIO_PROCESS, 0, 10)
    except OSError as exc:
        print(f"Could not lower pipeline priority: {exc}", file=sys.stderr)
    sys.exit(main())
