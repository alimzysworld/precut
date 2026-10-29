"""VO8: the warm voiceover transcriber.

src/main/voiceover-worker.ts starts this when the Voiceover panel opens and stops it when the panel closes.
The speech model loads once. While a take records, every finished 30 s Whisper window of the growing take is
decoded. At Stop, process.py's own transcribe_clip runs on the saved take, the same function
`process.py --transcribe-audio` runs today, and each window whose exact input (the mel bytes and the decode
options) was already decoded is reused instead of decoded again. Stop only decodes the tail, and the words are
the ones today's path gives on the same file: a window whose input changed is simply decoded again.

stdin, one JSON object per line:
  {"op": "follow", "id": ..., "root": ..., "file": ...}   a take started recording (shoot-relative file)
  {"op": "finish", "id": ..., "root": ..., "file": ...}   the take is saved: transcribe it now
  {"op": "cancel", "id": ...}                             forget that take
stdout, one JSON object per line: {"ready": true}, {"id", "transcript", "reused", "decoded"} or {"id", "error"}.
The worker exits when stdin closes.
"""
import hashlib
import json
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process as P  # noqa: E402

OUT = sys.stdout
sys.stdout = sys.stderr  # library prints never reach the protocol stream
STEP_S = 2.0             # how often a recording take is checked for a newly finished window
WINDOW_S = 30.0


def emit(value):
    OUT.write(json.dumps(value) + "\n")
    OUT.flush()


class StopPrefix(Exception):
    """A window of the growing take reaches past what has been recorded."""


class Reuse:
    """Decode and word-timing results keyed by their exact inputs, for one take."""

    def __init__(self):
        self.prefix = False   # True while decoding the growing take
        self.waiting = None   # a queue; a waiting command ends prefix work early
        self.clear()

    def clear(self):
        self.decodes, self.words = {}, {}
        self.reused = self.decoded = 0


reuse = Reuse()
speech_checks = ThreadPoolExecutor(max_workers=1)
early = {}


def digest(array):
    import numpy as np
    return hashlib.sha1(np.array(array).tobytes()).hexdigest()


def install(model):
    """Wrap the three seams mlx_whisper's own transcribe loop calls. The loop itself is never copied."""
    import importlib
    T = importlib.import_module("mlx_whisper.transcribe")  # the module; mlx_whisper.transcribe is also the function
    if not (hasattr(T, "pad_or_trim") and hasattr(T, "add_word_timestamps") and callable(getattr(model, "decode", None))):
        return False
    decode, pad_or_trim, add_word_timestamps = model.decode, T.pad_or_trim, T.add_word_timestamps

    def cached_decode(segment, options):
        key = (digest(segment), repr(options))
        hit = reuse.decodes.get(key)
        if hit is not None:
            reuse.reused += 1
            return hit
        if reuse.prefix and reuse.waiting is not None and not reuse.waiting.empty():
            raise StopPrefix()  # Stop arrived: the take's own pass decodes this window
        reuse.decoded += 1
        result = decode(segment, options)
        reuse.decodes[key] = result
        return result

    def partial_window(array, length=T.N_SAMPLES, *, axis=-1):
        if reuse.prefix and array.shape[axis] < length:
            raise StopPrefix()
        return pad_or_trim(array, length, axis=axis)

    def cached_word_timestamps(*, segments, mel, num_frames, last_speech_timestamp, **kwargs):
        key = (digest(mel), num_frames, last_speech_timestamp, kwargs.get("prepend_punctuations"), kwargs.get("append_punctuations"),
               json.dumps([[s["seek"], s["start"], s["end"], list(s["tokens"])] for s in segments]))
        hit = reuse.words.get(key)
        if hit is None:
            add_word_timestamps(segments=segments, mel=mel, num_frames=num_frames, last_speech_timestamp=last_speech_timestamp, **kwargs)
            reuse.words[key] = json.loads(json.dumps(segments))
            return
        for segment, saved in zip(segments, json.loads(json.dumps(hit))):
            segment.clear()
            segment.update(saved)

    model.decode = cached_decode
    T.pad_or_trim = partial_window
    T.add_word_timestamps = cached_word_timestamps
    return True


# The speech check (voice.swift) reads only the finished 16 kHz file, so it runs beside the tail decode.
voice_audio, measured_speech = P.voice_audio, P.measured_speech


@contextmanager
def voice_audio_early(*args, **kwargs):
    with voice_audio(*args, **kwargs) as tmp:
        if not reuse.prefix:
            early[tmp] = speech_checks.submit(measured_speech, tmp)
        try:
            yield tmp
        finally:
            pending = early.pop(tmp, None)
            if pending is not None:
                try:
                    pending.result()
                except Exception:
                    pass


def measured_speech_early(wav):
    if reuse.prefix:
        return None
    pending = early.get(wav)
    return pending.result() if pending is not None else measured_speech(wav)


P.voice_audio, P.measured_speech = voice_audio_early, measured_speech_early


def take_path(command):
    root = Path(command["root"]).resolve()
    source = (root / command["file"]).resolve()
    if not source.is_relative_to(root) or source.suffix.lower() != ".wav":
        raise ValueError("audio must be inside this shoot")
    return root, source


def recorded_seconds(source):
    """The recorder rewrites a valid header after every chunk; its data size is what is committed."""
    with open(source, "rb") as f:
        header = f.read(44)
    if len(header) < 44 or header[36:40] != b"data":
        return 0.0
    return int.from_bytes(header[40:44], "little") / (48000 * 2)


def main():
    commands = queue.Queue()

    def read():
        for line in sys.stdin:
            try:
                commands.put(json.loads(line))
            except ValueError:
                continue
        commands.put(None)

    threading.Thread(target=read, daemon=True).start()
    reuse.waiting = commands

    import numpy as np
    import mlx.core as mx
    import mlx_whisper
    from mlx_whisper.transcribe import ModelHolder
    model_path = P.whisper_model(None)
    streaming = install(ModelHolder.get_model(model_path, mx.float16))
    # One short silent pass loads the weights and compiles the GPU kernels before the first take.
    mlx_whisper.transcribe(np.zeros(16000, np.float32), path_or_hf_repo=model_path, language=P.TRANSCRIPTION_LANGUAGE,
                           word_timestamps=True, condition_on_previous_text=False, verbose=None)
    reuse.clear()
    emit({"ready": True, "streaming": streaming})

    following, checked_s, checked_at = None, 0.0, 0.0
    while True:
        try:
            command = commands.get(timeout=0.5 if following else None)
        except queue.Empty:
            command = False
        if command is None:
            return
        if command:
            op, take = command.get("op"), command.get("id")
            if op == "follow":
                following, checked_s, checked_at = command, 0.0, 0.0
                reuse.clear()
            elif op == "cancel":
                if following and following.get("id") == take:
                    following = None
                    reuse.clear()
            elif op == "finish":
                try:
                    root, source = take_path(command)
                    reuse.reused = reuse.decoded = 0
                    transcript = P.transcribe_clip(source, True, root / ".sidething")
                    emit({"id": take, "transcript": transcript, "reused": reuse.reused, "decoded": reuse.decoded})
                except Exception as exc:
                    emit({"id": take, "error": str(exc)[-300:]})
                if following and following.get("id") == take:
                    following = None
                reuse.clear()
                try:
                    mx.clear_cache()  # give the decode buffers back between takes
                except Exception:
                    pass
            continue
        if not streaming or not following or time.monotonic() - checked_at < STEP_S:
            continue
        checked_at = time.monotonic()
        try:
            root, source = take_path(following)
            seconds = recorded_seconds(source)
            # A new window can finish only once a full 30 s past the last one is recorded; check as it grows.
            if seconds < WINDOW_S + 0.5 or seconds - checked_s < STEP_S:
                continue
            checked_s = seconds
            reuse.prefix = True
            P.transcribe_clip(source, True, root / ".sidething")
        except StopPrefix:
            pass
        except Exception as exc:
            print(f"voice stream: {exc}", file=sys.stderr, flush=True)
        finally:
            reuse.prefix = False


if __name__ == "__main__":
    main()
