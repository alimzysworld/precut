#!/usr/bin/env python3
"""Conservative many-to-many waveform sync; originals are read-only.

python -I pipeline/sync.py <shoot> [--force] [--audio <file>]
python -I pipeline/sync.py <shoot> --audio-file <wav> [--clip <id>]

GCC-PHAT uses whole files at 8 kHz. A clear blind match establishes the
recorder/camera time-of-day difference (dates need not agree). Subsequent
matches search +/-6 s around that prediction. Clocks never accept a match:
waveform separation, signal/noise and independent phase coherence must pass.
JSON lines include progress, each clip's decision and 1000's endpoint drift.
The index cache fingerprints actual media, XML clocks and hand selections.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True

SR = 8000
VERSION = 2
WINDOW_S = 6.0
RATIO_MIN = 2.0
SNR_MIN = 12.0
COHERENCE_MIN = 0.01
MIN_OVERLAP_S = 3.0
GUARD_S = 0.25


def emit(**event):
    print(json.dumps(event, allow_nan=False), flush=True)


def find_file(root, name):
    direct = root / name
    if direct.is_file():
        return direct
    matches = [p for p in root.rglob(Path(name).name)
               if ".sidething" not in p.parts and p.is_file()]
    return matches[0] if len(matches) == 1 else None


def sidecar(path):
    if not path:
        return None
    name = (path.stem + "M01.XML").lower()
    return next((p for p in path.parent.iterdir() if p.name.lower() == name), None)


def time_of_day(value):
    match = re.search(r"(?:T|^)(\d{2}):?(\d{2}):?(\d{2}(?:\.\d+)?)", value or "")
    if not match:
        return None
    h, m, s = map(float, match.groups())
    return h * 3600 + m * 60 + s


def camera_clock(clip, path):
    xml = sidecar(path)
    if xml:
        try:
            for el in ET.parse(xml).getroot().iter():
                if el.tag.split("}")[-1] == "CreationDate":
                    value = time_of_day(el.get("value") or el.text)
                    if value is not None:
                        return value
        except (ET.ParseError, OSError):
            pass
    meta = clip.get("meta") or {}
    value = time_of_day(meta.get("createdAt"))
    return value if value is not None else time_of_day(meta.get("startTimecode"))


def recorder_clock(name):
    match = re.search(r"_\d{8}_(\d{6})(?:\D|$)", Path(name).name)
    return time_of_day(match[1]) if match else None


def recorder_group(name):
    # Consecutive DJI recordings share a transmitter clock. Other naming
    # conventions stay independent until they establish their own anchor.
    match = re.match(r"(TX\d+)_MIC", Path(name).name, re.I)
    return match[1].upper() if match else name


def clock_delta(seconds):
    return (seconds + 43200) % 86400 - 43200


def decode(path):
    if not path:
        return np.zeros(0, dtype=np.float32)
    result = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn",
                             "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                            capture_output=True)
    if result.returncode:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(result.stdout, dtype=np.float32).copy()
    return np.nan_to_num(samples)


def phase_coherence(x, y):
    """Independent check on just the chosen overlap, not the search FFT."""
    a, b = np.fft.rfft(x), np.fft.rfft(y)
    a /= np.maximum(np.abs(a), 1e-12)
    b /= np.maximum(np.abs(b), 1e-12)
    freq = np.fft.rfftfreq(len(x), 1 / SR)
    mask = (freq >= 300) & (freq <= 3400)
    return abs(float(np.mean((a * b.conj())[mask]).real))


def correlate(mic, clip, predicted=None):
    """Positive offset means camera t=0 lies inside the mic recording.

    Negative offsets and truncated tails are legal. Require >=70% of short
    clips, or 30 s of long clips; never accept a tiny coincidental overlap.
    """
    empty = {"offsetS": None, "bestPeak": 0.0, "secondPeak": 0.0,
             "ratio": 0.0, "snr": 0.0, "coherence": 0.0, "confidence": 0.0,
             "overlapS": 0.0, "accepted": False}
    minimum = max(int(MIN_OVERLAP_S * SR), min(30 * SR, int(.7 * len(clip))))
    if min(len(mic), len(clip)) < minimum:
        return {**empty, "reason": "less than required waveform overlap"}
    start, end = 0, len(mic)
    if predicted is not None:
        start = max(0, int((predicted - WINDOW_S) * SR))
        end = min(len(mic), int((predicted + len(clip) / SR + WINDOW_S) * SR))
    if end - start < minimum:
        return {**empty, "reason": "recording does not cover clip at calibrated clock time"}
    x = mic[start:end]
    if np.sqrt(np.mean(x * x)) < 1e-6 or np.sqrt(np.mean(clip * clip)) < 1e-6:
        return {**empty, "reason": "silent audio"}
    size = 1 << (len(x) + len(clip) - 1).bit_length()
    cross = np.fft.rfft(x, size) * np.fft.rfft(clip, size).conj()
    cross /= np.maximum(np.abs(cross), 1e-12)
    freq = np.fft.rfftfreq(size, 1 / SR)
    cross[(freq < 300) | (freq > 3400)] = 0
    corr = np.abs(np.fft.irfft(cross, size))
    del cross, freq
    low, high = -len(clip) + minimum, len(x) - minimum
    if predicted is not None:
        low = max(low, math.ceil((predicted - WINDOW_S) * SR) - start)
        high = min(high, math.floor((predicted + WINDOW_S) * SR) - start)
    if high < low:
        return {**empty, "reason": "recording does not cover clip at calibrated clock time"}
    lags = np.arange(low, high + 1)
    values = corr[lags % size]
    k = int(np.argmax(values))
    lag, peak = int(lags[k]), float(values[k])
    other = values[np.abs(lags - lag) > int(GUARD_S * SR)]
    second = float(other.max()) if other.size else 0.0
    ratio = peak / max(second, 1e-12)
    snr = peak / max(float(np.sqrt(np.mean(corr * corr))), 1e-12)
    m0, c0 = max(0, lag), max(0, -lag)
    overlap = min(len(x) - m0, len(clip) - c0)
    coherence = phase_coherence(x[m0:m0 + overlap], clip[c0:c0 + overlap])
    accepted = ratio >= RATIO_MIN and snr >= SNR_MIN and coherence >= COHERENCE_MIN
    # Conservative evidence score, not a claimed probability of correctness.
    confidence = min(1.0, ratio / 5, snr / 40, coherence / .04) if accepted else 0.0
    reasons = []
    if ratio < RATIO_MIN:
        reasons.append("ambiguous waveform: winner does not beat runner-up by 2x")
    if snr < SNR_MIN:
        reasons.append("waveform peak below 12x noise floor")
    if coherence < COHERENCE_MIN:
        reasons.append("overlap phase coherence below 0.01")
    return {"offsetS": round((start + lag) / SR, 6), "bestPeak": round(peak, 7),
            "secondPeak": round(second, 7), "ratio": round(ratio, 4),
            "snr": round(snr, 3), "coherence": round(coherence, 5),
            "confidence": round(confidence, 4), "overlapS": round(overlap / SR, 4),
            "accepted": accepted, "reason": "; ".join(reasons) if reasons else "clear waveform match"}


def choose(candidates):
    if not candidates:
        return {"sound": None, "confidence": 0.0, "ratio": 0.0,
                "reason": "no separate recordings"}
    # Compare all recordings, including a competing recording's winning peak.
    ordered = sorted(candidates, key=lambda r: r["coherence"] if r["accepted"] else 0, reverse=True)
    best = ordered[0] if ordered[0]["accepted"] else max(candidates, key=lambda r: r["snr"])
    competing = [r for r in candidates if r is not best and r["accepted"]]
    if competing:
        return {**best, "sound": None, "confidence": 0.0,
                "reason": "multiple recordings pass: no unambiguous recorder choice",
                "candidates": candidates}
    sound = {"file": best["file"], "offsetS": best["offsetS"],
             "confidence": best["confidence"]} if best["accepted"] else None
    return {**best, "sound": sound, "candidates": candidates}


def media_signature(root, index):
    def stamp(path):
        if not path:
            return None
        stat = path.stat()
        return [stat.st_size, stat.st_mtime_ns]
    clips = []
    for clip in index.get("clips", []):
        path = find_file(root, clip["file"])
        clips.append([clip["id"], clip["file"], clip.get("meta"), stamp(path),
                      stamp(sidecar(path)), clip.get("sound", "unchecked"),
                      ])
    audios = [[a["file"], stamp(find_file(root, a["file"]))] for a in index.get("audio", [])]
    return hashlib.sha256(json.dumps([VERSION, clips, audios], sort_keys=True).encode()).hexdigest()


def save_index(path, index):
    index["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, indent=1, allow_nan=False))
    tmp.replace(path)


def refresh_transcripts(root, index, index_path):
    spec = importlib.util.spec_from_file_location("sound_process", Path(__file__).with_name("process.py"))
    processing = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(processing)
    failures = processing.refresh_sound_transcripts(root, index, lambda: save_index(index_path, index))
    return 1 if failures else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("shoot")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--audio")
    ap.add_argument("--audio-file")
    ap.add_argument("--clip")
    args = ap.parse_args()
    root = Path(args.shoot).expanduser().resolve()
    index_path = root / ".sidething/index.json"
    if not index_path.is_file():
        emit(error=f"no index at {index_path}")
        return 1
    index = json.loads(index_path.read_text())
    readonly = bool(args.clip or args.audio_file or args.audio)
    cache = index.get("_syncCache") or {}
    fingerprint = media_signature(root, index)
    if not readonly and not args.force and cache.get("fingerprint") == fingerprint and cache.get("version") == VERSION:
        for result in cache["results"]:
            emit(**result, cached=True)
        if cache.get("drift"):
            emit(**cache["drift"], cached=True)
        return refresh_transcripts(root, index, index_path)

    clips = [c for c in index.get("clips", []) if not args.clip or c["id"] == args.clip or c["id"].endswith(args.clip)]
    entries = [{"file": args.audio_file}] if args.audio_file else [
        a for a in index.get("audio", []) if not args.audio or a["file"] == args.audio]
    paths = {c["id"]: find_file(root, c["file"]) for c in clips}
    clocks = {c["id"]: camera_clock(c, paths[c["id"]]) for c in clips}
    waves = {}

    def camera(clip):
        cid = clip["id"]
        if cid not in waves:
            waves[cid] = decode(paths[cid]) if (clip.get("meta") or {}).get("audioChannels") else np.zeros(0, np.float32)
        return waves[cid]

    mics = {a["file"]: decode(find_file(root, a["file"])) for a in entries}
    anchors, group_offsets = {}, {}
    # Long talking clips offer the clearest anchor. No time-of-day or date is
    # trusted before a blind whole-file waveform match establishes the offset.
    ordered = sorted(clips, key=lambda c: ((c.get("judgement") or {}).get("kind") == "talking",
                     (c.get("meta") or {}).get("durationS", 0)), reverse=True)
    for entry in entries:
        name = entry["file"]
        emit(clipId="", stage="audio", pct=0, note="lining up sound", file=name)
        if len(mics[name]) < MIN_OVERLAP_S * SR:
            continue
        group = recorder_group(name)
        if group in group_offsets:
            continue
        for clip in ordered:
            result = correlate(mics[name], camera(clip))
            if result["accepted"] and result["ratio"] >= 3:
                anchors[name] = {"clipId": clip["id"], **result}
                ctime, mtime = clocks[clip["id"]], recorder_clock(name)
                if ctime is not None and mtime is not None:
                    group_offsets[group] = clock_delta(ctime - mtime - result["offsetS"])
                emit(anchor=True, file=name, clipId=clip["id"], clockOffsetS=group_offsets.get(group), **result)
                break

    results = []
    for i, clip in enumerate(clips):
        if (clip.get("sound") or {}).get("byHand"):
            result = {"clipId": clip["id"], "sound": clip["sound"], "confidence": clip["sound"]["confidence"],
                      "ratio": None, "reason": "hand selection preserved"}
        elif len(camera(clip)) < MIN_OVERLAP_S * SR:
            result = {"clipId": clip["id"], "sound": None, "confidence": 0.0, "ratio": 0.0,
                      "reason": "camera audio missing, silent, undecodable or shorter than 3 s"}
        else:
            candidates = []
            for entry in entries:
                name = entry["file"]
                ctime, mtime = clocks[clip["id"]], recorder_clock(name)
                delta = group_offsets.get(recorder_group(name))
                predicted = clock_delta(ctime - mtime - delta) if None not in (ctime, mtime, delta) else None
                match = correlate(mics[name], camera(clip), predicted)
                candidates.append({"file": name, "predictedS": predicted, **match})
            result = {"clipId": clip["id"], **choose(candidates)}
            if result["sound"] is None:
                result["reason"] += "; camera sound, couldn't line up the mic"
        if not readonly:
            clip["sound"] = result["sound"]
        results.append(result)
        emit(**result, cached=False, stage="audio", pct=round((i + 1) / max(1, len(clips)) * 100))

    drift = None
    for clip in clips:
        result = next(r for r in results if r["clipId"] == clip["id"])
        sound = result["sound"]
        if not clip["id"].endswith("1000") or not sound or sound["file"] not in mics:
            continue
        y = camera(clip)
        if len(y) < 60 * SR:
            continue
        head = correlate(mics[sound["file"]], y[:30 * SR], sound["offsetS"])
        tail_start = len(y) / SR - 30
        tail = correlate(mics[sound["file"]], y[-30 * SR:], sound["offsetS"] + tail_start)
        valid = head["accepted"] and tail["accepted"]
        drift = {"drift": True, "clipId": clip["id"], "first30": head, "last30": tail,
                 "disagreementMs": round((tail["offsetS"] - tail_start - head["offsetS"]) * 1000, 3) if valid else None,
                 "reason": "last minus first offset; no stretch applied" if valid else "endpoint evidence insufficient; drift unknown"}
        emit(**drift)

    if readonly:
        return 0
    for entry in index.get("audio", []):
        matched = [c for c in index["clips"] if (c.get("sound") or {}).get("file") == entry["file"]]
        entry["clips"] = [c["id"] for c in matched]
        # Keep the legacy mic-zero-in-camera convention for the existing export.
        entry["syncedTo"] = {"clipId": matched[0]["id"], "offsetS": -matched[0]["sound"]["offsetS"]} if matched else None
    index["_syncCache"] = {"version": VERSION, "fingerprint": media_signature(root, index),
                            "results": results, "anchors": anchors, "clockOffsets": group_offsets, "drift": drift}
    save_index(index_path, index)
    return refresh_transcripts(root, index, index_path)


if __name__ == "__main__":
    sys.exit(main())
