#!/usr/bin/env python3
"""Measure subjects with Apple Vision: python -I pipeline/subject.py <shoot> [--force].

The only shoot writes are atomic index replacements inside .sidething/. The
Swift executable is bundled at build time; runtime compilation is never needed.
Missing detections are not invented; decode/Vision failures are not cached.
"""
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
import sys; sys.path.insert(0, str(Path(__file__).resolve().parent)); from setup import tool

RATE = 2
CACHE_VERSION = 2  # Face pose, with contract pitch sign (negative = down).


def emit(clip_id="", stage="subject", pct=0, **extra):
    print(json.dumps({"clipId": clip_id, "stage": stage, "pct": pct, **extra}), flush=True)


def subject_tool():
    binary = Path(tool("subject"))
    if not binary.is_file():
        raise RuntimeError("The bundled subject detector is missing. Reinstall precut.")
    version = hashlib.sha256(binary.read_bytes() + Path(__file__).read_bytes()).hexdigest()
    return binary, version


def inside(path, directory):
    return path.resolve().is_relative_to(directory.resolve())


def index_path(root):
    directory = root / ".sidething"
    path = directory / "index.json"
    if directory.is_symlink() or path.is_symlink() or not inside(path, directory):
        raise RuntimeError("refusing an index outside the shoot's own .sidething directory")
    if not path.is_file():
        raise RuntimeError(f"index not found: {path}")
    return path


def media(root, clip):
    relative = Path(clip["file"])
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError("clip file must be relative to the shoot")
    original = root / relative
    proxy = clip.get("proxy")
    if proxy:
        candidate = root / ".sidething" / "proxies" / proxy
        if inside(candidate, root / ".sidething" / "proxies") and candidate.is_file():
            return original, candidate
    return original, original


def signature(original, source, version):
    def stat_key(path):
        stat = path.stat()
        return {"size": stat.st_size, "mtimeNs": stat.st_mtime_ns}
    return {"file": str(original), **stat_key(original), "tool": version, "version": CACHE_VERSION,
            "rate": RATE, "input": str(source), "inputStat": stat_key(source)}


def measure(binary, source, clip_id):
    samples = []
    last_t = -1
    # stderr goes straight to the caller; stdout is exclusively the JSONL protocol.
    proc = subprocess.Popen([str(binary), str(source), str(RATE)],
                            stdout=subprocess.PIPE, text=True)
    try:
        for line in proc.stdout:
            row = json.loads(line)
            t = row["t"]
            if not isinstance(t, (int, float)) or not math.isfinite(t) or t <= last_t:
                raise RuntimeError("invalid sample time from subject tool")
            last_t = t
            if row.get("subject", "found") is None:
                continue
            if row.get("kind") not in {"face", "body", "salient"}:
                raise RuntimeError("invalid subject kind from subject tool")
            for name in ("x", "y", "w", "h"):
                value = row[name]
                if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                    raise RuntimeError(f"invalid subject {name} from subject tool")
            if row["w"] <= 0 or row["h"] <= 0:
                raise RuntimeError("empty subject box from subject tool")
            sample = {name: row[name] for name in ("t", "x", "y", "w", "h", "kind")}
            if row["kind"] == "face":
                for name in ("yaw", "pitch"):
                    if name not in row:
                        continue
                    value = row[name]
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                        raise RuntimeError(f"invalid face {name} from subject tool")
                    sample[name] = value
            samples.append(sample)
            if int(t * RATE) % 60 == 0:
                emit(clip_id, message=f"measuring at {t:g}s")
        if proc.wait():
            raise RuntimeError(f"subject tool failed for {source.name} (exit {proc.returncode}); see stderr")
        if last_t < 0:
            raise RuntimeError("subject tool returned no samples")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
    return {"samples": samples} if samples else None


def save_result(root, clip, subject, key, version):
    """Re-read after each measurement so tags/transcripts from other jobs survive."""
    path = index_path(root)
    before = path.read_bytes()
    index = json.loads(before)
    current = next((c for c in index["clips"] if c["id"] == clip["id"]), None)
    if current is None or current["file"] != clip["file"]:
        raise RuntimeError("clip changed during measurement; retry")
    original, source = media(root, current)
    if signature(original, source, version) != key:
        raise RuntimeError("media changed during measurement; retry")
    current["subject"] = subject
    index.setdefault("_cache", {}).setdefault("subject", {})[clip["id"]] = key
    index["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    fd, temporary = tempfile.mkstemp(prefix="subject-", suffix=".json.tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(index, handle, indent=1, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        if path.read_bytes() != before:
            raise RuntimeError("index changed during save; retry")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shoot")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    root = Path(args.shoot).expanduser().resolve()
    try:
        path = index_path(root)
        index = json.loads(path.read_bytes())
        binary, version = subject_tool()
    except (OSError, ValueError, RuntimeError) as error:
        emit(stage="error", pct=100, error=str(error))
        return 1
    from media_changes import source_wanted
    clips = [c for c in index["clips"] if source_wanted(root, c)]
    cache = index.get("_cache", {}).get("subject", {})
    failed, cached, measured = 0, 0, 0
    for n, clip in enumerate(clips):
        clip_id = clip["id"]
        try:
            original, source = media(root, clip)
            key = signature(original, source, version)
            if not args.force and "subject" in clip and cache.get(clip_id) == key:
                cached += 1
                emit(clip_id, pct=100, cached=True)
                continue
            emit(clip_id, message=f"framing {n + 1} of {len(clips)}", input=str(source))
            try:
                subject = measure(binary, source, clip_id)
            except RuntimeError:
                if source == original:
                    raise
                # PF1b: a preview the decoder can't read; the original may still read.
                subject = measure(binary, original, clip_id)
            save_result(root, clip, subject, key, version)
            measured += 1
            emit(clip_id, pct=100, samples=len(subject["samples"]) if subject else 0)
        except (OSError, ValueError, KeyError, RuntimeError) as error:
            failed += 1
            emit(clip_id, stage="error", pct=100, error=str(error))
    emit(pct=100, measured=measured, cached=cached, failed=failed)
    # PF1b: one clip that can't be read is left without framing; the others keep theirs.
    # The step fails only when no clip could be framed at all.
    return 1 if failed and not (measured or cached) else 0


if __name__ == "__main__":
    sys.exit(main())
