#!/usr/bin/env python3
"""Validate sidething FCPXML resources, edits, stacked takes and recorder bounds.

Usage: python3 -I pipeline/fcpxml_check.py <file.fcpxml> [...]
Checks all events and resource sequences, including disabled clips and bin clips.
Recorder bounds are checked against ffprobe as well as the XML declaration.
"""
import math
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET


def parse_time(text):
    text = (text or "0s").removesuffix("s")
    if "/" in text:
        n, d = text.split("/", 1)
        value = float(n) / float(d)
    else:
        value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"non-finite time {text}")
    return value


def check(path):
    errors = []
    try:
        root = ET.parse(path).getroot()
    except Exception as exc:
        return [f"not well-formed XML: {exc}"]
    if root.tag != "fcpxml" or root.get("version") not in {"1.9", "1.10", "1.11"}:
        errors.append(f"unsupported root/version: {root.tag} {root.get('version')}")
    resources = root.find("resources")
    if resources is None:
        return errors + ["no resources"]
    ids = [r.get("id") for r in resources]
    if len(ids) != len(set(ids)):
        errors.append("duplicate resource IDs")
    assets = {r.get("id"): r for r in resources.findall("asset")}
    media = {r.get("id"): r for r in resources.findall("media")}
    formats = {r.get("id") for r in resources.findall("format")}
    durations = {}
    for aid, asset in assets.items():
        fmt = asset.get("format")
        if fmt and fmt not in formats:
            errors.append(f"asset {aid} references missing format {fmt}")
        durations[aid] = parse_time(asset.get("duration"))
        reps = asset.findall("media-rep")
        if not reps:
            errors.append(f"asset {aid} has no media-rep")
        for rep in reps:
            uri = urlparse(rep.get("src", ""))
            if uri.scheme != "file" or uri.netloc not in {"", "localhost"}:
                errors.append(f"asset {aid} has no local file:// path")
                continue
            source = Path(unquote(uri.path))
            if not source.is_file():
                errors.append(f"asset {aid} path does not exist: {source}")
                continue
            if asset.get("hasVideo") == "0" and asset.get("hasAudio") == "1":
                try:
                    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                             "-of", "default=noprint_wrappers=1:nokey=1", str(source)],
                                            capture_output=True, text=True, check=True, timeout=30)
                    actual = float(result.stdout.strip())
                    if not math.isfinite(actual) or actual <= 0:
                        raise ValueError("invalid physical duration")
                    if durations[aid] > actual + .001:
                        errors.append(f"recorder {aid} declares {durations[aid]:.6f}s, file only {actual:.6f}s")
                    durations[aid] = min(durations[aid], actual)
                except (OSError, ValueError, subprocess.SubprocessError) as exc:
                    errors.append(f"cannot verify recorder {aid}: {exc}")
    # Check resource references and source bounds for every occurrence, not just
    # the audible spine (bins and disabled alternates must be safe too).
    for clip in list(root.iter("asset-clip")) + list(root.iter("ref-clip")):
        ref = clip.get("ref")
        resource = assets.get(ref) if clip.tag == "asset-clip" else media.get(ref)
        if resource is None:
            errors.append(f"{clip.tag} {clip.get('name')} references missing resource {ref}")
            continue
        start, dur = parse_time(clip.get("start")), parse_time(clip.get("duration"))
        if clip.tag == "ref-clip":
            seq = resource.find("sequence")
            if seq is None:
                errors.append(f"media {ref} has no sequence")
                continue
            origin, length = parse_time(seq.get("tcStart")), parse_time(seq.get("duration"))
        else:
            origin, length = parse_time(resource.get("start")), durations[ref]
        if dur <= 0 or start < origin - 1e-6 or start + dur > origin + length + 1e-6:
            label = "mic/recorder" if resource.get("hasVideo") == "0" else "source"
            errors.append(f"{label} {ref} range {start:.6f} + {dur:.6f} outside {origin:.6f}–{origin + length:.6f}")
        if clip.tag == "asset-clip" and resource.get("hasVideo") == "1" and clip.get("srcEnable", "all") != "video":
            routing = {s.get("srcCh"): s.get("role") for s in clip.findall("audio-channel-source")}
            for channel in range(1, min(2, int(resource.get("audioChannels", "0"))) + 1):
                if routing.get(str(channel)) != f"dialogue.cam-{channel}":
                    errors.append(f"camera {ref} lacks cam-{channel} routing")
    for seq in root.iter("sequence"):
        if seq.get("format") not in formats:
            errors.append(f"sequence references missing format {seq.get('format')}")
        spine = seq.find("spine")
        if spine is None or not len(spine):
            errors.append("sequence has no spine clips")
            continue
        prev_end = 0
        for child in spine:
            off, dur = parse_time(child.get("offset")), parse_time(child.get("duration"))
            if off < prev_end - 1e-6:
                errors.append(f"spine item at {off:.6f}s overlaps previous end {prev_end:.6f}s")
            prev_end = max(prev_end, off + dur)
        if abs(prev_end - parse_time(seq.get("duration"))) > 1e-6:
            errors.append(f"sequence duration differs from spine end {prev_end:.6f}s")
    projects = root.findall("./library/event/project") + root.findall("./event/project")
    if not projects:
        errors.append("no project timeline")
    for project in projects:
        spine = project.find("sequence/spine")
        if spine is None:
            errors.append("project has no spine")
            continue
        occupied = {}
        for main in spine:
            if main.tag == "gap":
                continue
            if main.find("marker") is None:
                errors.append(f"main take {main.get('name')} has no marker")
            main_line = re.match(r"^(\d+) ", main.get("name", ""))
            for alt in main:
                if alt.tag not in {"asset-clip", "ref-clip", "sync-clip"} or alt.get("enabled") != "0":
                    continue
                lane = int(alt.get("lane", "0"))
                if lane <= 0:
                    errors.append(f"disabled alternate {alt.get('name')} is not above main lane")
                if abs(parse_time(alt.get("offset")) - parse_time(main.get("start"))) > 1e-6:
                    errors.append(f"disabled alternate {alt.get('name')} does not align with its main-lane line")
                alt_line = re.match(r"^(\d+) ", alt.get("name", ""))
                if not main_line or not alt_line or main_line[1] != alt_line[1]:
                    errors.append(f"disabled alternate {alt.get('name')} belongs to a different line")
                off, dur = parse_time(main.get("offset")), parse_time(alt.get("duration"))
                if occupied.get(lane, 0) > off + 1e-6:
                    errors.append(f"alternate lane {lane} overlaps a preceding alternate")
                occupied[lane] = off + dur
        # Every disabled connected lane clip must have been checked above.
        checked = {id(a) for m in spine for a in m if a.get("enabled") == "0"}
        for alt in project.iter():
            if int(alt.get("lane", "0")) > 0 and alt.get("enabled") == "0" and id(alt) not in checked:
                errors.append(f"disabled alternate {alt.get('name')} is not attached to a main-lane line")
    # Synced compounds must route picture-only camera plus an in-bounds mic.
    for sync in root.iter("sync-clip"):
        pictures = [c for c in sync.findall("asset-clip") if assets.get(c.get("ref")) is not None
                    and assets[c.get("ref")].get("hasVideo") == "1"]
        recorders = [c for c in sync.findall("asset-clip") if assets.get(c.get("ref")) is not None
                     and assets[c.get("ref")].get("hasVideo") == "0"]
        if not pictures or not recorders:
            errors.append("synchronized take lacks picture or recorder")
        for picture in pictures:
            if picture.get("srcEnable") != "video":
                errors.append("synchronized camera audio is not off")
        for mic in recorders:
            off, dur = parse_time(mic.get("offset")), parse_time(mic.get("duration"))
            if mic.get("lane") != "-1" or off < 0 or off + dur > parse_time(sync.get("duration")) + 1e-6:
                errors.append("mic connection falls outside synchronized take")
    return errors


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    bad = 0
    for path in sys.argv[1:]:
        try:
            errors = check(path)
        except (ValueError, ZeroDivisionError, OSError) as exc:
            errors = [f"invalid FCPXML: {exc}"]
        if errors:
            bad = 1
            print(f"FAIL {path}")
            for error in errors:
                print(f"  - {error}")
        else:
            print(f"PASS {path}")
    return bad


if __name__ == "__main__":
    sys.exit(main())
