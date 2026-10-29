#!/usr/bin/env python3
"""Local quality facts: python -I pipeline/quality.py SHOOT [--force].

Only .sidething/index.json and Application Support/precut/bin are written.
No transcription, language model, network call, verdict, or original-media write.
"""
import argparse
import hashlib
from functools import lru_cache
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from setup import tool
from source_audio import audio_stream

VERSION = 1
RATE = 16000
HOP = 0.02


def emit(clip_id="", pct=0, **extra):
    print(json.dumps({"clipId": clip_id, "stage": "frames", "pct": pct,
                      "note": "checking focus and sound", **extra}, allow_nan=False), flush=True)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def inside(path, directory):
    return path.resolve().is_relative_to(directory.resolve())


def index_path(root):
    directory = root / ".sidething"
    path = directory / "index.json"
    if directory.is_symlink() or path.is_symlink() or not inside(path, directory):
        raise RuntimeError("refusing an index outside the shoot's own .sidething")
    if not path.is_file():
        raise RuntimeError(f"index not found: {path}")
    return path


def source_path(root, relative):
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError("media paths must be relative to the shoot")
    return root / relative


@lru_cache(maxsize=1024)
def video_duration(file, size, mtime_ns):
    result = subprocess.run([tool("ffprobe"), "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=duration", "-of", "json", str(file)], capture_output=True, text=True, check=True)
    return float(json.loads(result.stdout)["streams"][0].get("duration", "nan"))


def picture_sources(root, clip):
    original = source_path(root, clip["file"])
    source = original
    if clip.get("proxy"):
        proxy = root / ".sidething" / "proxies" / clip["proxy"]
        if inside(proxy, root / ".sidething" / "proxies") and proxy.is_file():
            # V4: old VideoToolbox previews can have a shorter video track than
            # their audio/container. Vision cannot sample those missing frames.
            # Measure the intact original instead; never omit quality rows.
            original_duration, proxy_duration = video_duration(original, original.stat().st_size, original.stat().st_mtime_ns), video_duration(proxy, proxy.stat().st_size, proxy.stat().st_mtime_ns)
            fps = min(60, float((clip.get("meta") or {}).get("fps") or 25))
            if not math.isfinite(original_duration) or proxy_duration + 1 / fps + .005 >= original_duration:
                source = proxy
    profile = re.sub(r"[^a-z0-9]", "", ((clip.get("meta") or {}).get("pictureProfile") or "").lower())
    if "slog3" in profile:
        curve = "slog3"
    elif "slog2" in profile:
        curve = "slog2"
    elif "log" in profile or "hlg" in profile:
        raise RuntimeError("exposure curve is unsupported; refusing display-value exposure facts")
    else:
        curve = "rec709"
    # process.py bakes LOG_LIFT into log proxies; it cannot be inverted reliably.
    return original, source, original if curve != "rec709" else source, curve


def quality_tool():
    swift = Path(__file__).with_suffix(".swift")
    version = hashlib.sha256(swift.read_bytes() + Path(__file__).read_bytes()).hexdigest()
    bundled = Path(tool("quality"))
    if bundled.is_file():
        return bundled, hashlib.sha256(bundled.read_bytes() + version.encode()).hexdigest()
    directory = Path(os.environ.get("PRECUT_QUALITY_BIN_DIR", str(
        Path.home() / "Library" / "Application Support" / "precut" / "bin")))
    directory.mkdir(parents=True, exist_ok=True)
    binary = directory / ("quality-" + version[:16])
    if binary.is_file():
        return binary, version
    compiler = shutil.which("swiftc")
    if not compiler:
        raise RuntimeError("Swift compiler missing: install Xcode Command Line Tools")
    # A fresh cache on the retry recovers stale Swift/SDK module versions.
    for attempt in range(2):
        with tempfile.TemporaryDirectory(prefix="quality-build-", dir=directory) as work:
            cache = Path(work) / "modules" if attempt else directory / "quality-modules"
            cache.mkdir(exist_ok=True)
            output = Path(work) / "quality"
            result = subprocess.run([compiler, "-O", "-module-cache-path", str(cache), str(swift), "-o", str(output)],
                                    stdout=sys.stderr, stderr=sys.stderr)
            if result.returncode == 0:
                os.replace(output, binary)
                return binary, version
    raise RuntimeError("could not compile quality measurements; see stderr")


def words_for(clip):
    return sorted((word for seg in clip.get("transcript") or [] for word in seg.get("words") or []
                   if isinstance(word.get("s"), (int, float)) and isinstance(word.get("e"), (int, float))
                   and math.isfinite(word["s"]) and math.isfinite(word["e"]) and word["e"] > word["s"]
                   and str(word.get("w", "")).strip()), key=lambda word: (word["s"], word["e"]))


def stat_key(path, missing=False):
    try:
        stat = path.stat()
        return {"path": str(path), "size": stat.st_size, "mtimeNs": stat.st_mtime_ns}
    except FileNotFoundError:
        if missing:
            return {"path": str(path), "missing": True}
        raise


def signature(root, clip, version):
    original, source, exposure, curve = picture_sources(root, clip)
    sound = clip.get("sound")
    voice = source_path(root, sound["file"] if sound else clip["file"])
    duration = float((clip.get("meta") or {})["durationS"])
    offset = float(sound["offsetS"]) if sound else 0
    if not math.isfinite(duration) or duration <= 0 or not math.isfinite(offset):
        raise RuntimeError("invalid duration or sound offset")
    return {"version": VERSION, "tool": version, "original": stat_key(original),
            "picture": stat_key(source), "exposure": stat_key(exposure), "curve": curve,
            "voice": stat_key(voice, missing=bool(sound)), "sound": sound, "duration": duration,
            "audioChannels": (clip.get("meta") or {}).get("audioChannels"),
            "transcript": clip.get("transcript"), "subject": clip.get("subject")}


def measure_picture(binary, source, exposure, curve, clip_id):
    rows, summary, last = [], None, -1
    proc = subprocess.Popen([str(binary), str(source), str(exposure), curve], stdout=subprocess.PIPE, text=True)
    try:
        for line in proc.stdout:
            row = json.loads(line)
            if row.get("done"):
                summary = row
                continue
            t = row["t"]
            if not isinstance(t, (int, float)) or not math.isfinite(t) or t <= last:
                raise RuntimeError("invalid quality sample time")
            for name, value in row.items():
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise RuntimeError(f"invalid quality {name}")
            last = t
            rows.append(row)
            if len(rows) % 60 == 0:
                emit(clip_id, message=f"picture at {t:g}s")
        if proc.wait() or not rows or summary is None:
            raise RuntimeError("picture measurements failed; see stderr")
        if len(rows) != math.ceil(float(summary["duration"]) * 2):
            raise RuntimeError("incomplete picture measurements")
        return rows, summary
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()


def spans_from_frames(times, values, matches, kind, duration, minimum=0, step=HOP, bridge=0):
    """An absent/neutral sample breaks a run; never stretch over unknown gaps."""
    runs, active = [], []
    def flush():
        if active:
            s, e = active[0][0], min(duration, active[-1][0] + step)
            if e > s and e - s + 1e-7 >= minimum:
                # Arithmetic mean retains units (ratios, dBFS, quality).
                runs.append({"s": round(s, 4), "e": round(e, 4), "kind": kind,
                             "value": round(sum(v for _, v in active) / len(active), 6)})
            active.clear()
    for t, value, match in zip(times, values, matches):
        if match:
            if active and t - (active[-1][0] + step) > bridge + 1e-7:
                flush()
            active.append((t, value))
        elif bridge == 0:
            flush()
    flush()
    return runs


def picture_spans(samples, duration):
    import numpy as np
    times = [row["t"] for row in samples]
    qualities = [row.get("faceQuality") for row in samples if row.get("faceQuality") is not None]
    best = float(np.percentile(qualities, 90)) if qualities else 0
    face = [row.get("faceQuality", 0) for row in samples]
    # Capture quality includes lighting/pose as well as focus: a relative fact,
    # not an optical sharpness score or a reason to reject a performance.
    spans = spans_from_frames(times, face, ["faceQuality" in row and best > 0.1 and
        row["faceQuality"] < best * 0.5 for row in samples], "soft-focus", duration, 1, 0.5)
    clipped = [max(row.get("frameClipped", 0), row.get("faceClipped", 0)) for row in samples]
    spans += spans_from_frames(times, clipped, [row.get("frameClipped", 0) >= 0.02 or
        row.get("faceClipped", 0) >= 0.01 for row in samples], "blown-highlights", duration, 0.5, 0.5)
    lumas = [row["faceLuma"] for row in samples if "faceLuma" in row]
    best_luma = float(np.percentile(lumas, 90)) if lumas else 0
    values = [row.get("faceLuma", 0) for row in samples]
    spans += spans_from_frames(times, values, ["faceLuma" in row and row["faceLuma"] < 0.015 and
        (row["faceLuma"] < 0.005 or row["faceLuma"] < best_luma * 0.3) for row in samples],
        "too-dark", duration, 1, 0.5)
    return spans


def decode_voice(root, clip):
    import numpy as np
    sound = clip.get("sound")
    source = source_path(root, sound["file"] if sound else clip["file"])
    duration = float(clip["meta"]["durationS"])
    count = int(math.ceil(duration * RATE))
    result = np.zeros(count, dtype=np.float32)
    if sound and not source.is_file():
        return result
    if not sound and clip["meta"].get("audioChannels", 0) == 0:
        return result
    offset = float(sound["offsetS"]) if sound else 0
    start = min(count, max(0, int(round(-offset * RATE))))
    if start >= count:
        return result
    stream = audio_stream(source)
    if stream is None:
        return result
    command = [tool("ffmpeg"), "-nostdin", "-v", "error", "-ss", str(max(0, offset)), "-i", str(source),
               "-t", str((count - start) / RATE), "-map", f"0:{stream['index']}", "-vn", "-ac", "1", "-ar", str(RATE),
               "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]
    decoded = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if decoded.returncode:
        raise RuntimeError("voice decode failed: " + decoded.stderr.decode(errors="replace")[-500:])
    data = np.frombuffer(decoded.stdout, dtype="<f4")[:count - start]
    if not np.isfinite(data).all():
        raise RuntimeError("nonfinite voice samples")
    result[start:start + len(data)] = data
    return result


def audio_qc(signal, rate, words, duration, matched_mic=False):
    """QC on the selected, unprocessed voice. Values retain their stated units.

    40 ms Hann FFT / 20 ms hop. Wind is low/speech power ratio, clipping is
    full-scale sample share, rustle is broadband excess dB over clip median,
    noisy is inter-word RMS dBFS, no-mic is RMS dBFS during timed words.
    """
    import numpy as np
    x = np.asarray(signal, dtype=np.float64)
    if x.ndim != 1 or rate < 8000 or not np.isfinite(x).all():
        raise ValueError("expected finite mono audio at >=8kHz")
    hop, size = int(round(rate * HOP)), int(round(rate * 0.04))
    times = np.arange(int(math.ceil(duration / HOP))) * HOP
    padded = np.pad(x, (0, max(0, len(times) * hop + size - len(x))))
    frames = np.lib.stride_tricks.sliding_window_view(padded, size)[::hop][:len(times)]
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    db = 20 * np.log10(np.maximum(rms, 1e-6))
    spectrum = abs(np.fft.rfft(frames * np.hanning(size), axis=1)) ** 2
    freq = np.fft.rfftfreq(size, 1 / rate)
    low = spectrum[:, (freq >= 20) & (freq < 120)].sum(axis=1)
    speech = spectrum[:, (freq >= 120) & (freq < 4000)].sum(axis=1)
    ratio = low / np.maximum(speech, 1e-12)
    band = spectrum[:, (freq >= 120) & (freq < 7000)] + 1e-18
    flat = np.exp(np.mean(np.log(band), axis=1)) / np.mean(band, axis=1)
    high_share = spectrum[:, freq >= 2000].sum(axis=1) / np.maximum(spectrum.sum(axis=1), 1e-12)
    near_full = np.mean(abs(frames) >= 0.999, axis=1)
    near_full = np.maximum(near_full, np.where(np.mean(abs(frames) >= 0.985, axis=1) >= 0.02,
                                              np.mean(abs(frames) >= 0.985, axis=1), 0))
    word_mask = np.zeros(len(times), dtype=bool)
    guarded = np.zeros(len(times), dtype=bool)
    for word in words:
        word_mask |= (times < word["e"]) & (times + 0.04 > word["s"])
        guarded |= (times < word["e"] + 0.08) & (times + 0.04 > word["s"] - 0.08)
    quiet = ~guarded
    floor = float(np.percentile(db[quiet], 20)) if quiet.any() else -120
    typical = float(np.median(db)) if len(db) else -120
    spans = spans_from_frames(times, near_full, near_full >= 1 / size, "clipping", duration, 0.02)
    spans += spans_from_frames(times, ratio, (ratio >= 8) & (db > -40), "wind", duration, 0.6, bridge=0.04)
    excess = db - typical
    spans += spans_from_frames(times, excess, (~guarded) & (flat > 0.2) & (high_share > 0.15) &
                               (excess > 12) & (db > -32), "rustle", duration, 0.02, bridge=0.04)
    # Absolute audibility plus a clip-relative increase. An entirely noisy clip
    # also registers above -32 dBFS, even with no cleaner baseline to compare.
    spans += spans_from_frames(times, db, bool(words) & quiet & (db > -42) & ((db > floor + 6) | (db > -32)),
                               "noisy", duration, 0.3, bridge=0.04)
    if matched_mic:
        spans += spans_from_frames(times, db, word_mask & (db < -65), "no-mic", duration, 0.15)
    # 100 ms loudness readings for per-take dynamics, excluding measured silence.
    loudness = [{"t": round(float(t), 4), "db": round(float(d), 6)}
                for t, d, voice in zip(times[::5], db[::5], word_mask[::5] if words else db[::5] > floor + 6)
                if voice and d > -65]
    return sorted(spans, key=lambda span: (span["s"], span["kind"])), loudness


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    n = (len(ordered) - 1) * p
    lo, hi = math.floor(n), math.ceil(n)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (n - lo)


def take_measures(clip, attempt, samples, loudness):
    s, e = attempt["s"], attempt["e"]
    words = [w for w in words_for(clip) if w["e"] > s and w["s"] < e]
    intervals = []
    for word in words:
        a, b = max(s, word["s"]), min(e, word["e"])
        if intervals and a <= intervals[-1][1]:
            intervals[-1][1] = max(b, intervals[-1][1])
        else:
            intervals.append([a, b])
    # Same upright baseline as judge.ts facePoseSpans: upper pitch quartile,
    # clamped near level. Both yaw and pitch must be present to measure contact.
    faces = [row for row in (clip.get("subject") or {}).get("samples", []) if row.get("kind") == "face"]
    pitches = sorted(row["pitch"] for row in faces if isinstance(row.get("pitch"), (int, float))
                     and math.isfinite(row["pitch"]))
    upright = min(0.15, max(-0.1, pitches[min(len(pitches) - 1, math.floor(len(pitches) * 0.75))])) if pitches else 0
    poses = [row for row in faces if s <= row["t"] < e and all(
        isinstance(row.get(k), (int, float)) and math.isfinite(row[k]) for k in ("yaw", "pitch"))]
    qualities = [row["faceQuality"] for row in samples if s <= row["t"] < e and "faceQuality" in row]
    levels = [row["db"] for row in loudness if s <= row["t"] < e]
    return {"faceQuality": percentile(qualities, 0.5),
            "eyeContact": sum(abs(row["yaw"]) < 0.35 and abs(row["pitch"] - upright) < 0.12 for row in poses) / len(poses) if poses else None,
            "wpm": len(words) * 60 / (e - s) if words and e > s else None,
            "pauseS": max(0, e - s - sum(b - a for a, b in intervals)) if words else None,
            "energyDb": percentile(levels, 0.9) - percentile(levels, 0.1) if len(levels) >= 2 else None,
            "flags": sorted({span["kind"] for span in (clip.get("quality") or {}).get("spans", [])
                             if span["s"] < e and span["e"] > s})}


def aggregate_takes(index):
    clips = {clip["id"]: clip for clip in index["clips"]}
    cache = index.get("_cache", {}).get("quality", {})
    for take in index.get("takes", []):
        for attempt in take["attempts"]:
            clip = clips.get(attempt["clipId"])
            raw = cache.get(attempt["clipId"])
            if clip is not None and raw:
                attempt["measures"] = take_measures(clip, attempt, raw["samples"], raw["loudness"])


def save(root, update):
    """Re-read immediately before merging owned fields; refuse concurrent writes."""
    path = index_path(root)
    before = path.read_bytes()
    index = json.loads(before)
    update(index)
    aggregate_takes(index)
    index["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    fd, temporary = tempfile.mkstemp(prefix="quality-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(index, handle, indent=1, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        if path.read_bytes() != before:
            raise RuntimeError("index changed during quality save; retry")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def save_clip(root, clip, key, version, samples, summary, spans, loudness):
    def update(index):
        current = next((c for c in index["clips"] if c["id"] == clip["id"]), None)
        if current is None or current["file"] != clip["file"] or signature(root, current, version) != key:
            raise RuntimeError("quality inputs changed while measuring; retry")
        current["quality"] = {"tags": summary["tags"], "spans": sorted(spans, key=lambda row: (row["s"], row["kind"]))}
        index.setdefault("_cache", {}).setdefault("quality", {})[clip["id"]] = {
            "key": key, "samples": samples, "loudness": loudness, "prints": summary["prints"]}
    save(root, update)


def update_duplicates(root, binary, version, publish_duplicates=True, focus=None):
    path = index_path(root)
    index = json.loads(path.read_bytes())
    cache = index.get("_cache", {}).get("quality", {})
    valid = {c["id"]: cache[c["id"]] for c in index["clips"] if c["id"] in cache and
             signature(root, c, version) == cache[c["id"]].get("key") and c.get("quality") is not None}
    manifest = [{"id": c["id"], "duration": c["meta"]["durationS"], "prints": valid[c["id"]]["prints"], "fresh": c["id"] == focus}
                for c in index["clips"] if c["id"] in valid]
    # Manifest is inside .sidething, never beside originals or in a shared filename.
    with tempfile.NamedTemporaryFile(mode="w", prefix="quality-prints-", suffix=".json", dir=path.parent) as handle:
        json.dump(manifest, handle); handle.flush()
        result = subprocess.run([str(binary), "--compare" if focus else "--duplicates", handle.name], stdout=subprocess.PIPE, text=True)
    if result.returncode:
        raise RuntimeError("feature print comparison failed")
    comparison = json.loads(result.stdout)
    duplicates = comparison["duplicates"]
    def update(fresh):
        fresh_cache = fresh.get("_cache", {}).get("quality", {})
        for clip in fresh["clips"]:
            if clip["id"] in valid:
                if (fresh_cache.get(clip["id"]) != valid[clip["id"]] or
                        signature(root, clip, version) != valid[clip["id"]]["key"]):
                    raise RuntimeError("quality inputs changed during duplicate comparison; retry")
                if publish_duplicates:
                    clip["quality"]["duplicateOf"] = duplicates.get(clip["id"])
        prior = fresh.get("_cache", {}).get("featurePairs", []) if focus else []
        retained = [p for p in prior if p["a"] in valid and p["b"] in valid and focus not in (p["a"], p["b"])]
        fresh.setdefault("_cache", {})["featurePairs"] = retained + comparison.get("pairs", [])
    save(root, update)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shoot")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    root = Path(args.shoot).expanduser().resolve()
    try:
        index = json.loads(index_path(root).read_bytes())
        binary, version = quality_tool()
        failed = cached = measured = 0
        cache = index.get("_cache", {}).get("quality", {})
        from media_changes import source_wanted
        for n, clip in enumerate(index["clips"]):
            if not source_wanted(root, clip):
                continue
            try:
                key = signature(root, clip, version)
                if not args.force and clip.get("quality") is not None and cache.get(clip["id"], {}).get("key") == key:
                    cached += 1
                    emit(clip["id"], 100, cached=True)
                    continue
                emit(clip["id"], message=f"checking focus and sound {n + 1} of {len(index['clips'])}")
                _, source, exposure, curve = picture_sources(root, clip)
                samples, summary = measure_picture(binary, source, exposure, curve, clip["id"])
                duration = key["duration"]
                spans, loudness = audio_qc(decode_voice(root, clip), RATE, words_for(clip), duration,
                                           bool(clip.get("sound")) or clip["meta"].get("audioChannels", 0) == 0)
                spans += picture_spans(samples, duration)
                save_clip(root, clip, key, version, samples, summary, spans, loudness)
                # Compare only the new observation against cached prints. This
                # fills Similar now, while the rest of a long shoot is reading.
                update_duplicates(root, binary, version, publish_duplicates=False, focus=clip["id"])
                measured += 1
                emit(clip["id"], 100, spans=len(spans))
            except (OSError, ValueError, KeyError, RuntimeError) as error:
                failed += 1
                emit(clip["id"], 100, error=str(error))
        # Successful prints still fill Similar when another clip fails. Keep the
        # existing rule against duplicate conclusions from a partial shoot run.
        update_duplicates(root, binary, version, publish_duplicates=not failed)
        emit(pct=100, measured=measured, cached=cached, failed=failed)
        return 1 if failed else 0
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        emit(pct=100, error=str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
