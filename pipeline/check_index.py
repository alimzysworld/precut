#!/usr/bin/env python3
"""Tiny shape check: does an index.json match Shoot in src/shared/schema.ts?

Usage: python -I pipeline/check_index.py <shoot-or-index.json>
Exits 0 and prints PASS when the shape holds, else prints each problem.
"""
import json
import sys
from pathlib import Path

STAGES = {"probe", "audio", "transcript", "shake", "frames", "proxy",
          "judge", "done", "error"}
META_KEYS = {"camera": (str, type(None)), "width": int, "height": int,
             "fps": (int, float), "codec": str,
             "pictureProfile": (str, type(None)), "iso": (int, type(None)),
             "shutter": (str, type(None)), "aperture": (int, float, type(None)),
             "focalLength": (int, float, type(None)),
             "startTimecode": (str, type(None)), "audioChannels": int,
             "sampleRate": int, "durationS": (int, float), "sizeBytes": int,
             "createdAt": (str, type(None))}


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check(path):
    errors = []
    target = Path(path)
    index_path = target / ".sidething" / "index.json" if target.is_dir() else target
    if not index_path.exists():
        return [f"no index at {index_path}"]
    try:
        d = json.loads(index_path.read_text())
    except Exception as exc:
        return [f"index is not valid JSON: {exc}"]
    for key, typ in [("schemaVersion", int), ("name", str), ("root", str),
                     ("createdAt", str), ("updatedAt", str), ("script", list),
                     ("scriptSource", str), ("clips", list), ("audio", list),
                     ("takes", list)]:
        if key not in d:
            errors.append(f"shoot missing {key}")
        elif not isinstance(d[key], typ):
            errors.append(f"shoot.{key} should be {typ.__name__}")
    if d.get("scriptSource") not in ("pasted", "inferred", "none"):
        errors.append("shoot.scriptSource invalid")
    for clip in d.get("clips", []):
        cid = clip.get("id", "?")
        for key in ("id", "file", "stage", "meta", "transcript", "shake",
                    "frames", "proxy", "judgement"):
            if key not in clip:
                errors.append(f"clip {cid} missing {key}")
        if clip.get("stage") not in STAGES:
            errors.append(f"clip {cid} stage invalid: {clip.get('stage')}")
        meta = clip.get("meta")
        if meta is not None:
            if not isinstance(meta, dict):
                errors.append(f"clip {cid} meta not an object")
            else:
                for key, typ in META_KEYS.items():
                    if key not in meta:
                        errors.append(f"clip {cid} meta missing {key}")
                    elif not isinstance(meta[key], typ):
                        errors.append(f"clip {cid} meta.{key} wrong type")
        transcript = clip.get("transcript")
        if transcript is not None:
            if not isinstance(transcript, list):
                errors.append(f"clip {cid} transcript not a list")
            else:
                for seg in transcript:
                    if not (is_num(seg.get("s")) and is_num(seg.get("e"))
                            and isinstance(seg.get("text"), str)
                            and isinstance(seg.get("words"), list)):
                        errors.append(f"clip {cid} bad segment {seg}")
                        break
                    for w in seg.get("words", []):
                        if not (is_num(w.get("s")) and is_num(w.get("e"))
                                and isinstance(w.get("w"), str)):
                            errors.append(f"clip {cid} bad word {w}")
                            break
        shake = clip.get("shake")
        if shake is not None:
            if not isinstance(shake.get("measured"), bool):
                errors.append(f"clip {cid} shake.measured not bool")
            if not isinstance(shake.get("perSecond"), list):
                errors.append(f"clip {cid} shake.perSecond not a list")
            if not isinstance(shake.get("shakySpans"), list):
                errors.append(f"clip {cid} shake.shakySpans not a list")
            for span in shake.get("shakySpans", []):
                if not (isinstance(span, list) and len(span) == 2
                        and all(is_num(v) for v in span)):
                    errors.append(f"clip {cid} bad shakySpan {span}")
        if not isinstance(clip.get("frames"), list):
            errors.append(f"clip {cid} frames not a list")
        if clip.get("proxy") is not None and not isinstance(clip.get("proxy"), str):
            errors.append(f"clip {cid} proxy not a string")
    for entry in d.get("audio", []):
        if not (isinstance(entry.get("file"), str)
                and is_num(entry.get("durationS"))
                and isinstance(entry.get("channels"), int)
                and "syncedTo" in entry):
            errors.append(f"bad audio entry {entry}")
    return errors


def main():
    if len(sys.argv) != 2:
        print("usage: check_index.py <shoot-or-index.json>")
        return 2
    errors = check(sys.argv[1])
    if errors:
        for e in errors:
            print(f"FAIL {e}")
        return 1
    print("PASS index.json matches the Shoot shape")
    return 0


if __name__ == "__main__":
    sys.exit(main())
