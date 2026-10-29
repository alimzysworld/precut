#!/usr/bin/env python3
"""Validate sidething FCPXML resources, edits, stacked takes and recorder bounds.

Usage: python3 -I pipeline/fcpxml_check.py <file.fcpxml> [...]
Checks all events and resource sequences, including disabled clips and bin clips.
Recorder bounds are checked against ffprobe as well as the XML declaration.
"""
import math
from pathlib import Path
import sys; sys.path.insert(0, str(Path(__file__).resolve().parent)); from setup import tool
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
            if asset.get("name", "").startswith(("Title front:", "Title behind:", "Person cut-out")):
                try:
                    result = subprocess.run([tool("ffprobe"), "-v", "error", "-select_streams", "v:0",
                                             "-show_entries", "stream=codec_name,pix_fmt:format=duration",
                                             "-of", "json", str(source)], capture_output=True, text=True,
                                            check=True, timeout=30)
                    import json
                    probe = json.loads(result.stdout)
                    stream = probe["streams"][0]
                    if stream.get("codec_name") != "prores" or not stream.get("pix_fmt", "").startswith("yuva"):
                        errors.append(f"layer {aid} is not ProRes with alpha")
                    if durations[aid] > float(probe["format"]["duration"]) + .001:
                        errors.append(f"layer {aid} duration exceeds physical file")
                except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError) as exc:
                    errors.append(f"cannot verify alpha layer {aid}: {exc}")
            if asset.get("hasVideo") == "0" and asset.get("hasAudio") == "1":
                try:
                    result = subprocess.run([tool("ffprobe"), "-v", "error", "-show_entries", "format=duration",
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
        keys = clip.findall('timeMap/timept')
        source_start = min((parse_time(k.get('value')) for k in keys), default=start)
        source_end = max((parse_time(k.get('value')) for k in keys), default=start + dur)
        if keys:
            times = [parse_time(k.get('time')) for k in keys]
            if len(keys) < 2 or any(b <= a for a, b in zip(times, times[1:])):
                errors.append(f'{ref}: invalid retime curve')
        if dur <= 0 or source_start < origin - 1e-6 or source_end > origin + length + 1e-6:
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
    for caption in root.iter("caption"):
        if parse_time(caption.get("duration")) <= 0 or parse_time(caption.get("offset")) < 0:
            errors.append("caption has invalid timing")
        if "?captionFormat=ITT." not in caption.get("role", "") or caption.find("text") is None:
            errors.append("caption lacks ITT role or text")
        definitions = {style.get("id") for style in caption.findall("text-style-def")}
        for style in caption.findall("text/text-style"):
            if style.get("ref") and style.get("ref") not in definitions:
                errors.append("caption references missing text style")
    projects = root.findall("./library/event/project") + root.findall("./event/project")
    if not projects:
        errors.append("no project timeline")
    for project in projects:
        spine = project.find("sequence/spine")
        if spine is None:
            errors.append("project has no spine")
            continue
        occupied = {}
        finishing_lanes = {}
        transitions = {round(parse_time(c.get('offset')) + parse_time(c.get('duration')), 6): parse_time(c.get('duration')) for c in spine if c.tag == 'transition'}
        for main in spine:
            for layer in main:
                name = layer.get("name", "")
                if layer.tag == "asset-clip" and name.startswith(("Title front:", "Title behind:", "Person cut-out", "Clean voice:")):
                    lane = int(layer.get("lane", "0"))
                    off = parse_time(main.get("offset")) + parse_time(layer.get("offset")) - parse_time(main.get("start"))
                    dur = parse_time(layer.get("duration"))
                    finishing_lanes.setdefault(lane, []).append((off, off + dur))
                    if (name.startswith("Clean voice:") and lane >= 0) or (not name.startswith("Clean voice:") and lane <= 0):
                        errors.append(f"finishing clip {name} has wrong lane")
                if name.startswith("Original voice:") and layer.get("enabled") != "0":
                    errors.append("original voice must be disabled when clean voice is present")
            if main.tag in {"gap", "transition"}:
                continue
            if main.find("marker") is None:
                errors.append(f"main take {main.get('name')} has no marker")
            main_line = re.match(r"^(\d+) ", main.get("name", ""))
            for alt in main:
                if alt.tag not in {"asset-clip", "ref-clip", "sync-clip"} or alt.get("enabled") != "0":
                    continue
                lane = int(alt.get("lane", "0"))
                if lane < 0 and alt.get("name", "").startswith("Original voice:"):
                    if alt.get("srcEnable") != "audio":
                        errors.append("original voice clip must be audio only")
                    continue
                if lane <= 0:
                    errors.append(f"disabled alternate {alt.get('name')} is not above main lane")
                incoming = transitions.get(round(parse_time(main.get('offset')), 6), 0)
                if abs(parse_time(alt.get("offset")) - (parse_time(main.get("start")) - incoming)) > 1e-6:
                    errors.append(f"disabled alternate {alt.get('name')} does not align with its main-lane line")
                alt_line = re.match(r"^(\d+) ", alt.get("name", ""))
                if not main_line or not alt_line or main_line[1] != alt_line[1]:
                    errors.append(f"disabled alternate {alt.get('name')} belongs to a different line")
                off, dur = parse_time(main.get("offset")), parse_time(alt.get("duration"))
                if occupied.get(lane, 0) > off + 1e-6:
                    errors.append(f"alternate lane {lane} overlaps a preceding alternate")
                occupied[lane] = off + dur
        for lane, spans in finishing_lanes.items():
            previous = 0
            for start, end in sorted(spans):
                if start < previous - 1e-6:
                    errors.append(f"finishing lane {lane} overlaps itself")
                previous = end
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
