"""One source-sound rule, shared by transcription, fillers and matching."""
import json
import subprocess
from setup import tool


def select_audio(streams):
    playable = [s for s in streams if s.get("codec_type") == "audio"
                and s.get("codec_name", "unknown") not in {"unknown", "none", "", None}]
    return next((s for s in playable if (s.get("disposition") or {}).get("default")),
                playable[0] if playable else None)


def audio_stream(path):
    result = subprocess.run([tool("ffprobe"), "-v", "error", "-show_streams", "-of", "json", str(path)],
                            capture_output=True, text=True)
    return select_audio(json.loads(result.stdout).get("streams", []))


def audio_input(path, duration=None):
    """Single audio-only input and explicit map, or bounded digital silence."""
    stream = audio_stream(path)
    if stream is not None:
        return ["-i", str(path), "-map", f"0:{stream['index']}"]
    if duration is None:
        result = subprocess.run([tool("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
                                capture_output=True, text=True)
        duration = float(json.loads(result.stdout).get("format", {}).get("duration") or 0)
    return ["-f", "lavfi", "-t", str(max(0.001, duration)), "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:a:0"]
