"""Offline, bounded-memory sound separation. Only writes to the supplied work dir.

The add-on is installed separately. There is deliberately no installation or
model-download fallback here. stdout is a small JSON-lines progress protocol.
"""
import argparse
import json
import os
from pathlib import Path
import struct
import subprocess
import time
import wave


def report(completed, total, started):
    elapsed = time.monotonic() - started
    eta = elapsed * (total - completed) / completed if completed else None
    print(json.dumps(dict(completed=completed, total=total, etaS=eta)), flush=True)


class FloatWav:
    """Streaming IEEE float WAV, preserving stem gain without normalising each part."""
    def __init__(self, file, frames, rate):
        size = frames * 2 * 4
        if size + 36 >= 2**32:
            raise ValueError("Choose a shorter sound span.")
        self.file = open(file, "xb")
        self.file.write(struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", size + 36,
                                   b"WAVE", b"fmt ", 16, 3, 2, rate,
                                   rate * 8, 8, 32, b"data", size))

    def write(self, audio):
        import numpy as np
        if not np.isfinite(audio).all():
            raise ValueError("The model returned invalid sound.")
        self.file.write(np.asarray(audio.T, dtype="<f4").tobytes())

    def close(self):
        self.file.close()


def separate(source, output, addon):
    # Set this before importing the port. Its loader validates the local model;
    # missing/corrupt weights fail locally, with no conversion/download fallback.
    os.environ["DEMUCS_MLX_CACHE_DIR"] = str(addon / "models")
    os.environ["DEMUCS_MLX_NO_DOWNLOAD"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    import numpy as np
    from demucs_mlx import Separator

    started = time.monotonic()
    with wave.open(str(source), "rb") as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (44100, 2, 2):
            raise ValueError("Expected prepared stereo sound.")
        rate, total = audio.getframerate(), audio.getnframes()
        if total <= 0:
            raise ValueError("There is no sound in this span.")
        names = ("vocals", "drums", "bass", "other")
        writers = {name: FloatWav(output / (name + ".wav"), total, rate) for name in names}
        try:
            with Separator(model="htdemucs", shifts=1, seed=0, batch_size=1) as model:
                # Bound input/output tensors for long tracks. Two seconds of
                # shared context on each side, and a one-second crossfade,
                # prevent a hard join at our 30-second streaming boundaries.
                step, context, fade = 30 * rate, 2 * rate, rate
                held = None
                at = 0
                while at < total:
                    start = max(0, at - context)
                    end = min(total, at + step + context + fade)
                    audio.setpos(start)
                    samples = np.frombuffer(audio.readframes(end - start), dtype="<i2")
                    samples = samples.reshape(-1, 2).T.astype(np.float32) / 32768
                    _, stems = model.separate_tensor(samples)
                    count = min(step, total - at)
                    offset = at - start
                    current = {n: np.asarray(stems[n])[:, offset:offset + count + fade].copy() for n in names}
                    if held is not None:
                        nfade = min(fade, count)
                        weight = np.linspace(0, 1, nfade, dtype=np.float32)[None, :]
                        for name in names:
                            current[name][:, :nfade] = held[name][:, :nfade] * (1 - weight) + current[name][:, :nfade] * weight
                    for name in names:
                        writers[name].write(current[name][:, :count])
                    held = {name: current[name][:, count:count + fade] for name in names}
                    at += count
                    report(at, total, started)
        finally:
            for writer in writers.values():
                writer.close()


def isolate(source, output, addon):
    # The native binary includes its model. Delay compensation keeps source time.
    started = time.monotonic()
    padded = output / "padded.wav"
    with wave.open(str(source), "rb") as audio, wave.open(str(padded), "wb") as tail:
        params = audio.getparams()
        tail.setparams(params)
        while True:
            chunk = audio.readframes(48000)
            if not chunk:
                break
            tail.writeframesraw(chunk)
        # -D discards the model's leading latency and otherwise loses the last
        # 30 ms. Supply real trailing context, then keep exactly the source span.
        tail.writeframesraw(bytes(params.framerate * params.nchannels * params.sampwidth))
    destination = output / "denoised"
    destination.mkdir()
    subprocess.run([str(addon / "deep-filter"), "-D", "-o", str(destination), str(padded)],
                   check=True, stdout=subprocess.DEVNULL)
    denoised = destination / padded.name
    with wave.open(str(denoised), "rb") as audio, wave.open(str(output / "voice.wav"), "wb") as voice:
        if (audio.getframerate(), audio.getnchannels()) != (params.framerate, params.nchannels) or audio.getnframes() < params.nframes:
            raise ValueError("The cleaned sound is incomplete.")
        voice.setparams(audio.getparams()._replace(nframes=params.nframes))
        remaining = params.nframes
        while remaining:
            frames = min(48000, remaining)
            voice.writeframesraw(audio.readframes(frames))
            remaining -= frames
    padded.unlink()
    denoised.unlink()
    destination.rmdir()
    report(1, 1, started)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--addon", type=Path, required=True)
    parser.add_argument("--mode", choices=["stems", "voice"], required=True)
    args = parser.parse_args()
    if args.mode == "stems":
        separate(args.input, args.output, args.addon)
    else:
        isolate(args.input, args.output, args.addon)


if __name__ == "__main__":
    main()
