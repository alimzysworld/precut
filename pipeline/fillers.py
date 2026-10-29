#!/usr/bin/env python3
"""Find fillers without replacing transcripts: python -I pipeline/fillers.py SHOOT [--force].

Only .sidething is written. Silence/energy are measurements; the product rule
to remove fillers is already decided. This step makes no take/quality decisions.
"""
import argparse
import array
import hashlib
import importlib.util
import json
import math
import os
import re
import sys
import tempfile
import wave
from datetime import datetime, timezone
from pathlib import Path
import sys; sys.path.insert(0, str(Path(__file__).resolve().parent)); from setup import tool
from source_audio import audio_input, audio_stream

INITIAL_PROMPT = "Um, so, uh, I was like, erm, you know... Er, ah, hmm, mm, umm, uhh."
MIN_GAP_S = 0.15
PAUSE_S = 0.6
FRAME_S = 0.01
TAKE_CACHE_VERSION = 2  # energy edges and pauses, rather than verbatim word edges
TAKE_PAUSE_S = 0.35
EDGE_QUIET_S = 0.12
EDGE_SEARCH_S = 1.2
MIN_VOICE_S = 0.18  # an um or uh lasts 150 ms or more; shorter energy is a breath, a click or a word tail
RUN_BRIDGE_S = 0.06  # one filler can dip for a moment; join runs this close
WORD_GUARD_S = 0.05  # word timings are approximate: never call the edge of a word a filler
FLOOR_RATIO = 10.0  # power relative to this clip's measured floor, never fixed dB
FILLER_TOKEN = re.compile(r"(?:u+m+|u+h+|e+r+m*|a+h+|h+m+|m{2,})", re.I)
_PROCESSING = None
_MLX_IMPORT_ERROR = None
_MODEL = None


def processing():
    global _PROCESSING
    if _PROCESSING is None:
        spec = importlib.util.spec_from_file_location("filler_process", Path(__file__).with_name("process.py"))
        _PROCESSING = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_PROCESSING)
    return _PROCESSING


def emit(clip_id="", pct=0, **extra):
    print(json.dumps({"clipId": clip_id, "stage": "transcript", "pct": pct,
                      "note": "finding ums", **extra}), flush=True)


def index_path(root):
    directory = root / ".sidething"
    path = directory / "index.json"
    if directory.is_symlink() or path.is_symlink():
        raise RuntimeError("refusing an index outside the shoot's own .sidething")
    return path


def source_path(root, relative):
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError("media must be relative to the shoot")
    return root / path


def has_speech(clip):
    return any((seg.get("text") or "").strip() or seg.get("words")
               for seg in clip.get("transcript") or [])


def same_numbers(value):
    """ANA1: the app rewrites the index from JavaScript, where 2.0 is written 2. The words are the same, so the
    key must be too (it re-heard every clip with a whole-second time: 40 of 66 talking clips on a real shoot)."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, list):
        return [same_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: same_numbers(item) for key, item in value.items()}
    return value


def signature(root, clip):
    tool = processing()
    sound = clip.get("sound")
    source = source_path(root, sound["file"] if sound else clip["file"])
    stat = source.stat()
    duration = float(clip["meta"]["durationS"])
    offset = float(sound["offsetS"]) if sound else 0.0
    if not math.isfinite(duration) or duration <= 0 or not math.isfinite(offset):
        raise RuntimeError("invalid clip duration or sound offset")
    # A failed sync/transcription must not label camera words with mic detections.
    if "_transcriptSound" in clip and tool.transcript_source(root, clip) != clip["_transcriptSound"]:
        raise RuntimeError("voice source changed; refresh its transcript before finding fillers")
    return {"source": str(source), "size": stat.st_size, "mtimeNs": stat.st_mtime_ns,
            "offsetS": offset, "durationS": duration, "sampleRate": 16000,
            "model": tool.WHISPER_MODEL, "language": tool.TRANSCRIPTION_LANGUAGE,
            "initialPrompt": INITIAL_PROMPT, "wordTimestamps": True,
            "conditionOnPreviousText": False, "vocabulary": processing().vocabulary_prompt(),
            "transcript": hashlib.sha256(json.dumps(same_numbers(clip.get("transcript")), sort_keys=True).encode()).hexdigest(),
            "tool": hashlib.sha256(Path(__file__).read_bytes() + Path(tool.__file__).read_bytes()).hexdigest()}


def verbatim(audio, sidething):
    global _MLX_IMPORT_ERROR, _MODEL
    if _MLX_IMPORT_ERROR is not None:
        raise RuntimeError(f"MLX import failed earlier; retry in a fresh process: {_MLX_IMPORT_ERROR}")
    tool = processing()
    if _MODEL is None:
        _MODEL = tool.whisper_model(sidething)
    model = _MODEL  # mlx-whisper's ModelHolder reuses this model path in memory.
    try:
        import mlx_whisper
    except ImportError as exc:
        # Native imports can partially register types; reimporting can abort Python.
        _MLX_IMPORT_ERROR = str(exc)
        raise
    result = mlx_whisper.transcribe(
        str(audio), path_or_hf_repo=model, word_timestamps=True,
        initial_prompt=" ".join(filter(None, [INITIAL_PROMPT, tool.vocabulary_prompt()])), condition_on_previous_text=False,
        language=tool.TRANSCRIPTION_LANGUAGE, verbose=False)
    # Do not use the cleaned-transcript WPS filter: a single real "um" can
    # occupy a long segment. Retain Whisper's joint no-speech/logprob evidence.
    words = []
    for seg in result.get("segments", []):
        if (float(seg.get("no_speech_prob") or 0) > tool.NO_SPEECH_DROP
                and float(seg.get("avg_logprob") or 0) < tool.LOGPROB_LOW):
            continue
        for word in seg.get("words") or []:
            words.append({"s": float(word["start"]), "e": float(word["end"]),
                          "w": word.get("word", "")})
    if not words:
        raise RuntimeError("verbatim pass found no words in a clip with speech; retry")
    return words


def read_audio(path):
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise RuntimeError("expected mono PCM16 voice audio")
        rate = audio.getframerate()
        samples = array.array("h", audio.readframes(audio.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples, rate


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[int((len(ordered) - 1) * fraction)] if ordered else 0.0


def energy_envelope(samples, rate):
    if not samples:
        raise RuntimeError("empty voice audio")
    frame = max(1, round(rate * FRAME_S))
    powers = [sum(float(s) ** 2 for s in samples[i:i + frame]) / len(samples[i:i + frame])
              for i in range(0, len(samples), frame)]
    floor = percentile(powers, 0.2)
    threshold = max(floor * FLOOR_RATIO, max(powers) * 0.00001)
    return powers, frame / rate, floor, threshold


def take_energy(samples, rate, words, real, start, attempt):
    """Use word identities as anchors; locate their edges and gaps in PCM.

    Short energy dips belong to the same word. A 120 ms quiet run ends it;
    the next region is a new onset, even when Whisper smears its timestamp
    back across the last word. Times returned here are camera seconds.
    """
    powers, step, floor, threshold = energy_envelope(samples, rate)
    active = [i for i, power in enumerate(powers) if power > threshold]
    if not active:
        raise RuntimeError("take has no measurable voice energy")
    regions = []
    first = previous = active[0]
    for i in active[1:]:
        if (i - previous - 1) * step + 1e-9 >= EDGE_QUIET_S:
            regions.append((first, previous + 1))
            first = i
        previous = i
    regions.append((first, previous + 1))

    def anchor(word, last=False):
        candidates = [i for i in active if start + (i + .5) * step >= word["s"] - step
                      and start + i * step <= word["e"] + step]
        if not candidates:
            # Zero-duration or slightly misplaced word: use nearby audio only.
            centre = (word["s"] + word["e"]) / 2
            nearest = min(active, key=lambda i: abs(start + (i + .5) * step - centre))
            if abs(start + (nearest + .5) * step - centre) > .35:
                raise RuntimeError("no voice energy near take word; check its edges")
            return nearest
        return candidates[-1] if last else candidates[0]

    first_anchor, last_anchor = anchor(real[0]), anchor(real[-1], last=True)
    first_region = next(r for r in regions if r[0] <= first_anchor < r[1])
    last_region = next(r for r in regions if r[0] <= last_anchor < r[1])
    # A labelled neighbouring word may start after less than 120 ms of quiet.
    # Use its centre to identify an energy run, never its smeared start as a
    # hard cut guard. Bridge brief phoneme dips in the same way as voiced ums.
    runs = []
    first = previous = active[0]
    for i in active[1:]:
        if (i - previous - 1) * step + 1e-9 >= RUN_BRIDGE_S:
            runs.append((first, previous + 1))
            first = i
        previous = i
    runs.append((first, previous + 1))
    next_word = next((w for w in words if (w["s"] + w["e"]) / 2 > attempt["e"]), None)
    next_run = None
    if next_word:
        centre = (next_word["s"] + next_word["e"]) / 2
        probe = next((i for i in active if start + (i + .5) * step >= centre), None)
        if probe is not None:
            candidate = next(r for r in runs if r[0] <= probe < r[1])
            if last_anchor < candidate[0] < last_region[1]:
                next_run = candidate
                last_region = (last_region[0], max(i for i in active if i < candidate[0]) + 1)
    previous_word = next((w for w in reversed(words) if (w["s"] + w["e"]) / 2 < attempt["s"]), None)
    if previous_word:
        centre = (previous_word["s"] + previous_word["e"]) / 2
        probe = next((i for i in reversed(active) if start + (i + .5) * step <= centre), None)
        if probe is not None:
            candidate = next(r for r in runs if r[0] <= probe < r[1])
            if first_region[0] < candidate[1] <= first_anchor:
                first_region = (next(i for i in active if i >= candidate[1]), first_region[1])
    speech_s = max(start, attempt["s"] - EDGE_SEARCH_S, start + first_region[0] * step)
    speech_e = min(attempt["e"] + EDGE_SEARCH_S, start + last_region[1] * step)
    if speech_e <= speech_s:
        raise RuntimeError("no ordered voice energy inside the take")
    result = {"speechS": round(speech_s, 6), "speechE": round(speech_e, 6),
              "energy": {"frameS": step, "noiseFloor": floor, "threshold": threshold}}
    following = next_run or next((r for r in regions if r[0] >= last_region[1]), None)
    if following:
        result["nextOnsetS"] = round(start + following[0] * step, 6)

    pauses = []
    quiet = None
    for i in range(len(powers) + 1):
        low = i < len(powers) and powers[i] <= threshold
        if low and quiet is None:
            quiet = i
        if not low and quiet is not None:
            s = max(attempt["s"], start + quiet * step)
            e = min(attempt["e"], start + i * step)
            if e - s + 1e-9 >= TAKE_PAUSE_S:
                pauses.append({"s": round(s, 6), "e": round(e, 6), "kind": "pause"})
            quiet = None
    return result, pauses


def merge_fillers(items, duration):
    bounded = []
    for item in items:
        s, e = float(item["s"]), float(item["e"])
        if not math.isfinite(s) or not math.isfinite(e):
            continue
        s, e = round(max(0, s), 4), round(min(duration, e), 4)
        if e > s:
            bounded.append({**item, "s": s, "e": e})
    merged = []
    priority = {"pause": 0, "voiced": 1, "word": 2}
    for item in sorted(bounded, key=lambda f: (f["s"], f["e"])):
        if not merged or item["s"] >= merged[-1]["e"]:
            merged.append(item)
            continue
        previous = merged[-1]
        kind = max((previous["kind"], item["kind"]), key=priority.get)
        texts = [f["text"] for f in (previous, item) if f.get("text")]
        merged[-1] = {"s": previous["s"], "e": max(previous["e"], item["e"]), "kind": kind}
        if texts:
            merged[-1]["text"] = " ".join(dict.fromkeys(texts))
    return merged


def detect(samples, rate, words, duration):
    """Words and the shared, padded WAV are already in camera seconds.

    Measure 10ms mean-square energy and the bottom quintile as the noise floor.
    Each >=150ms inter-word gap is split at sustained energy boundaries. Store
    each entire silent gap over 600ms, never its proposed shortened cut.
    """
    if not samples:
        raise RuntimeError("empty voice audio")
    frame = max(1, round(rate * FRAME_S))
    powers = [sum(float(s) ** 2 for s in samples[i:i + frame]) / len(samples[i:i + frame])
              for i in range(0, len(samples), frame)]
    floor = percentile(powers, 0.2)
    # Scale-free epsilon handles digital zero; the peak term prevents tiny
    # codec residue on a digital-silence floor from becoming a voiced filler.
    threshold = max(floor * FLOOR_RATIO, max(powers) * 0.00001)
    ordered = sorted((w for w in words if math.isfinite(w["s"]) and math.isfinite(w["e"])
                      and w["e"] > w["s"] and w["e"] > 0 and w["s"] < duration),
                     key=lambda w: (w["s"], w["e"]))
    if not ordered:
        raise RuntimeError("verbatim pass has no valid words inside the clip")
    items = []
    for word in ordered:
        token = re.sub(r"[^a-z]", "", word["w"].lower())
        if FILLER_TOKEN.fullmatch(token):
            items.append({"s": word["s"], "e": word["e"], "kind": "word", "text": word["w"].strip()})
    previous_end = None
    for word in ordered:
        start = max(0.0, word["s"])
        if previous_end is not None and start - previous_end >= MIN_GAP_S:
            end = min(start, duration)
            gap_start = previous_end
            first, last = math.ceil(gap_start * rate / frame), math.floor(end * rate / frame)
            active = []
            run_start = None
            for i in range(first, last + 1):
                voiced = i < last and i < len(powers) and powers[i] > threshold
                if voiced and run_start is None:
                    run_start = i * frame / rate
                if not voiced and run_start is not None:
                    run_end = i * frame / rate
                    if active and run_start - active[-1][1] < RUN_BRIDGE_S:
                        active[-1] = (active[-1][0], run_end)
                    else:
                        active.append((run_start, run_end))
                    run_start = None
            active = [(s, e) for s, e in active
                      if e - s + 1e-9 >= MIN_VOICE_S and s - gap_start >= WORD_GUARD_S and end - e >= WORD_GUARD_S]
            cursor = gap_start
            for s, e in active:
                if s - cursor > PAUSE_S:
                    items.append({"s": cursor, "e": s, "kind": "pause"})
                items.append({"s": s, "e": e, "kind": "voiced"})
                cursor = e
            if end - cursor > PAUSE_S:
                items.append({"s": cursor, "e": end, "kind": "pause"})
        previous_end = max(previous_end or 0, min(word["e"], duration))
    return merge_fillers(items, duration)


def corrected_words(words, clip):
    duration = (clip.get("meta") or {}).get("durationS", 0)
    segments = processing().keep_hand_words(
        [{"s": 0, "e": duration, "text": "", "words": words}], clip.get("transcript"))
    return sorted((w for seg in segments for w in seg["words"]), key=lambda w: (w["s"], w["e"]))


def protect_hand_fillers(items, clip):
    # Even a cached take pass must never cut through a person's corrected words.
    protected = [w for seg in clip.get("transcript") or [] for w in seg["words"] if w.get("byHand")]
    return [f for f in items if f["kind"] == "pause" or
            not any(w["s"] < f["e"] and w["e"] > f["s"] for w in protected)]


def fill_clip(root, clip, cache, force=False):
    """Shared optional step; mutate only this clip's fillers and cache entry."""
    if clip.get("photo"):
        clip["fillers"] = []
        cache.pop(clip["id"], None)
        return False
    if not has_speech(clip):
        clip.pop("fillers", None)
        cache.pop(clip["id"], None)
        return False
    try:
        key = signature(root, clip)
        if not force and isinstance(clip.get("fillers"), list) and cache.get(clip["id"]) == key:
            return False
        clip.pop("fillers", None)
        cache.pop(clip["id"], None)
        source_path(root, clip["file"])
        sidething = index_path(root).parent
        if audio_stream(key["source"]) is None:
            clip["fillers"] = []
            cache[clip["id"]] = key
            return True
        with processing().voice_audio(root / clip["file"], sidething, clip.get("sound"), key["durationS"]) as audio:
            words = corrected_words(verbatim(audio, sidething), clip)
            samples, rate = read_audio(audio)
            found = protect_hand_fillers(detect(samples, rate, words, key["durationS"]), clip)
        if signature(root, clip) != key:
            raise RuntimeError("audio source changed during filler detection; retry")
        clip["fillers"] = found
        cache[clip["id"]] = key
        return True
    except Exception:
        clip.pop("fillers", None)
        cache.pop(clip["id"], None)
        raise


def save_result(root, clip, key):
    """Re-read after MLX to preserve tags, judgement and other enrichments."""
    path = index_path(root)
    before = path.read_bytes()
    index = json.loads(before)
    current = next((c for c in index["clips"] if c["id"] == clip["id"]), None)
    if current is None or current["file"] != clip["file"]:
        raise RuntimeError("clip changed while finding fillers; retry")
    if key is not None and signature(root, current) != key:
        raise RuntimeError("voice source/transcript changed while finding fillers; retry")
    cache = index.setdefault("_cache", {}).setdefault("fillers", {})
    base = index["_cache"].setdefault("fillerBase", {})
    if key is None:
        current.pop("fillers", None)
        cache.pop(clip["id"], None)
        base.pop(clip["id"], None)
    else:
        current["fillers"] = clip["fillers"]
        cache[clip["id"]] = key
        base[clip["id"]] = {"key": key, "fillers": clip["fillers"]}
    atomic_index(path, before, index)


def atomic_index(path, before, index):
    index["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    fd, temporary = tempfile.mkstemp(prefix="fillers-", suffix=".json.tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(index, handle, indent=1, allow_nan=False)
        if path.read_bytes() != before:
            raise RuntimeError("index changed during save; retry")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def attempts(index):
    for take in index.get("takes", []):
        if isinstance(take, dict):
            yield from take.get("attempts", [])


def attempt_key(root, clip, attempt):
    # Transcript/judgement edits do not change this take's own audio.
    source = signature(root, clip)
    source.pop("transcript")
    s, e = float(attempt["s"]), float(attempt["e"])
    if not math.isfinite(s) or not math.isfinite(e) or s < 0 or e <= s or e > source["durationS"]:
        raise RuntimeError("invalid take span")
    key = {"version": TAKE_CACHE_VERSION, "clipId": clip["id"], "s": s, "e": e, "audio": source}
    token = hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()
    return token, key


def measure_attempt(root, clip, attempt):
    """Decode only this take's voice slice, padding a recorder that starts late."""
    duration = float(clip["meta"]["durationS"])
    start = max(0, attempt["s"] - EDGE_SEARCH_S - EDGE_QUIET_S)
    end = min(duration, attempt["e"] + EDGE_SEARCH_S + EDGE_QUIET_S)
    sidething = index_path(root).parent
    start = round(start * 16000) / 16000
    sound = clip.get("sound")
    source = source_path(root, sound["file"] if sound else clip["file"])
    position = start + (float(sound["offsetS"]) if sound else 0)
    if audio_stream(source) is None:
        return {"words": [], "fillers": [], "silent": True}
    delay = max(0, -position)
    fd, sliced = tempfile.mkstemp(suffix=".wav", dir=sidething)
    os.close(fd)
    try:
        result = processing().run([
            tool("ffmpeg"), "-y", "-v", "error", "-ss", str(max(0, position)), *audio_input(source, end - start),
            "-vn", "-ac", "1", "-ar", "16000", "-af",
            f"adelay={delay * 1000}:all=1,apad,atrim=duration={end - start}",
            "-t", str(end - start), "-c:a", "pcm_s16le", sliced])
        if result.returncode != 0:
            raise RuntimeError("could not extract take voice audio")
        local = verbatim(sliced, sidething)
        samples, rate = read_audio(sliced)
    finally:
        os.unlink(sliced)
    words = [{**w, "s": round(start + max(0, w["s"]), 6),
              "e": round(min(end, start + w["e"]), 6)} for w in local
             if math.isfinite(w["s"]) and math.isfinite(w["e"]) and w["e"] >= w["s"]
             and w["e"] >= 0 and w["s"] <= end - start]
    words = corrected_words(words, clip)
    words = [w for w in words if w["s"] < end and w["e"] > start]
    real = [w for w in words if re.sub(r"[^a-z]", "", w["w"].lower())
            and not FILLER_TOKEN.fullmatch(re.sub(r"[^a-z]", "", w["w"].lower()))
            and (w["s"] + w["e"]) / 2 >= attempt["s"]
            and (w["s"] + w["e"]) / 2 <= attempt["e"]]
    if not real or real[-1]["e"] <= real[0]["s"]:
        raise RuntimeError("take verbatim pass found no real words inside the attempt")
    edges, pauses = take_energy(samples, rate, words, real, start, attempt)
    local_words = [{**w, "s": w["s"] - start, "e": w["e"] - start} for w in words]
    # Keep lexical ums and untranscribed voiced fillers from the existing detector.
    # Its transcript-gap pauses are superseded by the PCM measurement.
    found = [{**item, "s": round(start + item["s"], 6), "e": round(start + item["e"], 6)}
             for item in detect(samples, rate, local_words, end - start) if item["kind"] != "pause"]
    # A timestamp gap can contain the extended tail of our final word. It is
    # measured speech, not an untranscribed um after the take.
    found = [item for item in found if item["kind"] != "voiced" or
             item["e"] <= real[-1]["e"] or item["s"] >= edges["speechE"]]
    return {"words": words, "fillers": merge_fillers(found + pauses, duration), **edges}


def save_attempts(root, results):
    """Reconcile against live takes: never restore an attempt removed by a re-judge."""
    path = index_path(root)
    before = path.read_bytes()
    index = json.loads(before)
    clips = {c["id"]: c for c in index.get("clips", [])}
    live = {}
    from media_changes import source_wanted
    for attempt in attempts(index):
        clip = clips.get(attempt["clipId"])
        if clip and not source_wanted(root, clip):
            continue
        attempt.pop("speechS", None)
        attempt.pop("speechE", None)
        attempt.pop("nextOnsetS", None)
        clip = clips.get(attempt["clipId"])
        try:
            token, key = attempt_key(root, clip, attempt)
        except Exception:
            continue
        result = results.get(token)
        if result and result["key"] == key:
            live[token] = result
            attempt.update({k: result[k] for k in ("speechS", "speechE")})
            if "nextOnsetS" in result:
                attempt["nextOnsetS"] = result["nextOnsetS"]
    cache = index.setdefault("_cache", {})
    cache["fillerAttempts"] = live
    bases = cache.setdefault("fillerBase", {})
    for clip in clips.values():
        if not source_wanted(root, clip):
            continue
        measured = [result for result in live.values() if result["key"]["clipId"] == clip["id"]]
        extra = [f for result in measured
                 for f in result["fillers"]]
        if isinstance(clip.get("fillers"), list) or extra:
            key = cache.get("fillers", {}).get(clip["id"])
            base = bases.get(clip["id"], {})
            try:
                current_key = signature(root, clip) if key is not None else None
            except Exception:
                current_key = None
            # process.py also calls fill_clip. Adopt its fresh whole-clip result
            # without confusing it with a previous run's merged take fillers.
            if key is not None and key == current_key and base.get("key") != key:
                base = bases[clip["id"]] = {"key": key, "fillers": clip.get("fillers", [])}
            base = base.get("fillers", []) if key is not None and key == current_key and base.get("key") == key else []
            # Whole-clip timestamp gaps must not override measured voice inside a take.
            for result in measured:
                if not result.get("energy"):
                    continue
                s = min(result["key"]["s"], result["speechS"])
                e = max(result["key"]["e"], result["speechE"])
                base = [part for item in base for part in (
                    [item] if item["kind"] != "pause" or item["e"] <= s or item["s"] >= e else
                    [{**item, "e": s}, {**item, "s": e}]) if part["e"] > part["s"]]
            clip["fillers"] = protect_hand_fillers(merge_fillers(base + extra, clip["meta"]["durationS"]), clip)
    atomic_index(path, before, index)


def fill_attempts(root, force=False, measure=True):
    index = json.loads(index_path(root).read_bytes())
    clips = {c["id"]: c for c in index.get("clips", [])}
    previous = index.get("_cache", {}).get("fillerAttempts", {})
    results, pending = {}, {}
    failed = 0
    from media_changes import source_wanted
    for attempt in attempts(index):
        try:
            clip = clips[attempt["clipId"]]
            if not source_wanted(root, clip):
                results.update({token: result for token, result in previous.items() if result["key"]["clipId"] == clip["id"]})
                continue
            token, key = attempt_key(root, clip, attempt)
            if not force and previous.get(token, {}).get("key") == key:
                results[token] = previous[token]
            else:
                pending[token] = (clip, attempt, key)
        except Exception as exc:
            failed += 1
            emit(attempt.get("clipId", ""), pct=100, error=str(exc))
    # Clear obsolete edges/fillers before entering native MLX, including --force.
    save_attempts(root, results)
    if not measure:
        return failed
    for token, (clip, attempt, key) in pending.items():
        try:
            result = measure_attempt(root, clip, attempt)
            if result.get("silent"):
                emit(clip["id"], pct=100, skipped="No source sound", attemptS=attempt["s"])
                continue
            if attempt_key(root, clip, attempt) != (token, key):
                raise RuntimeError("take audio changed during measurement; retry")
            results[token] = {"key": key, **result}
            save_attempts(root, results)
            emit(clip["id"], pct=100, attemptS=attempt["s"], attemptE=attempt["e"])
        except RuntimeError as exc:
            # A take with no measurable speech (garbled, off-mic) keeps its ordinary
            # word-snapped edges in the cut. That is an outcome, not a failure.
            if "no real words" in str(exc) or "no voice energy" in str(exc):
                emit(clip["id"], pct=100, skipped=str(exc), attemptS=attempt["s"])
            else:
                failed += 1
                emit(clip["id"], pct=100, error=str(exc))
        except Exception as exc:
            failed += 1
            emit(clip["id"], pct=100, error=str(exc))
    return failed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shoot")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    root = Path(args.shoot).expanduser().resolve()
    try:
        index = json.loads(index_path(root).read_bytes())
    except (OSError, ValueError, RuntimeError) as exc:
        emit(pct=100, error=str(exc))
        return 1
    cache = index.setdefault("_cache", {}).setdefault("fillers", {})
    # A crash in the whole-clip native pass must not leave obsolete take edges.
    fill_attempts(root, args.force, measure=False)
    failed = 0
    candidates = []
    # Invalidate all obsolete persisted results before entering native MLX.
    # Even a native process crash must not leave old camera/mic detections live.
    from media_changes import source_wanted
    for clip in index.get("clips", []):
        if not source_wanted(root, clip):
            continue
        try:
            if clip.get("photo"):
                continue
            if not has_speech(clip):
                if "fillers" in clip or clip["id"] in cache:
                    save_result(root, clip, None)
                continue
            key = signature(root, clip)
            cached = isinstance(clip.get("fillers"), list) and cache.get(clip["id"]) == key
            if (args.force or not cached) and ("fillers" in clip or clip["id"] in cache):
                save_result(root, clip, None)
            candidates.append(clip)
        except Exception as exc:
            failed += 1
            try:
                save_result(root, clip, None)
            except Exception as save_error:
                emit(clip["id"], pct=100, error=f"could not clear stale fillers: {save_error}")
            emit(clip["id"], pct=100, error=str(exc))
    for clip in candidates:
        try:
            emit(clip["id"])
            changed = fill_clip(root, clip, cache, args.force)
            if changed:
                save_result(root, clip, cache[clip["id"]])
            emit(clip["id"], pct=100, cached=not changed, fillers=len(clip["fillers"]))
        except Exception as exc:
            failed += 1
            # Stale results must never look like a successful empty detection.
            try:
                save_result(root, clip, None)
            except Exception as save_error:
                emit(clip["id"], pct=100, error=f"could not clear stale fillers: {save_error}")
            emit(clip["id"], pct=100, error=str(exc))
    failed += fill_attempts(root, args.force)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
