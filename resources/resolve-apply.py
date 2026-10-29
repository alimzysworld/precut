"""Run in Resolve Studio's Python scripting console after importing the FCPXML.

Set EXPORT_FOLDER when pasting this script into the console. As a script file,
it discovers its own export folder. Studio scripting must be enabled. The
script never touches source media and stops on ambiguous clip assignments.
"""
import json
from pathlib import Path


def apply(resolve, folder):
    folder = Path(folder).resolve()
    project = resolve.GetProjectManager().GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    if timeline is None:
        raise RuntimeError('Open the imported precut timeline first.')
    manifest = json.loads((folder / 'LUTs' / 'clips.json').read_text())
    if not project.RefreshLUTList():
        raise RuntimeError("Resolve could not refresh the LUT list.")
    missing, applied = [], []
    # Traverse only compound timelines reachable from the selected import.
    # Other open timelines can contain identical camera names.
    available = {}
    for index in range(1, project.GetTimelineCount() + 1):
        candidate = project.GetTimelineByIndex(index)
        media = candidate.GetMediaPoolItem()
        if media:
            available[media.GetUniqueId()] = candidate
    timelines, pending, visited = [], [timeline], set()
    while pending:
        sequence = pending.pop()
        if sequence.GetUniqueId() in visited:
            continue
        visited.add(sequence.GetUniqueId())
        timelines.append(sequence)
        for track in range(1, sequence.GetTrackCount('video') + 1):
            for clip in sequence.GetItemListInTrack('video', track) or []:
                media = clip.GetMediaPoolItem()
                child = available.get(media.GetUniqueId()) if media else None
                if child:
                    pending.append(child)
    for entry in manifest['entries']:
        matches = []
        for sequence in timelines:
            for track in range(1, sequence.GetTrackCount('video') + 1):
                for clip in sequence.GetItemListInTrack('video', track) or []:
                    if clip.GetName() != entry['name']:
                        continue
                    # Compound picture sequences use the parent's local clock.
                    # Intermediate source wrappers must not receive the LUT too.
                    nested = sequence.GetUniqueId() != timeline.GetUniqueId()
                    if nested and sequence.GetName() != entry.get('parentName'):
                        continue
                    start = clip.GetStart() - sequence.GetStartFrame()
                    expected = entry.get('localStartFrame', 0) if nested else entry['startFrame']
                    if abs(start - expected) <= 1:
                        matches.append(clip)
        if len(matches) != 1:
            missing.append(entry['name'])
            continue
        clip = matches[0]
        if not clip.SetLUT(1, str(folder / entry['lut'])):
            raise RuntimeError('Resolve could not load ' + entry['lut'] + '. Add this export LUTs folder to Resolve custom LUT locations and refresh LUTs, then run again.')
        applied.append(entry['name'])
    if missing:
        raise RuntimeError('LUTs applied to %d clips. Open/decompose imported picture compounds and rerun for unmatched clips: %s' % (len(applied), ', '.join(missing)))
    subtitles = folder / 'Subtitles.srt'
    subtitle_tracks = timeline.GetTrackCount('subtitle')
    already_imported = any(timeline.GetTrackName('subtitle', index) == 'precut subtitles'
                           for index in range(1, subtitle_tracks + 1))
    if subtitles.exists() and not already_imported:
        # The documented importer only guarantees AAF. Try SRT, and report
        # a manual import requirement if this installed version rejects it.
        if not timeline.ImportIntoTimeline(str(subtitles), {'insertAdditionalTracks': True, 'insertWithOffset': '00:00:00:00'}):
            raise RuntimeError('This Resolve version did not import SRT through scripting. Use File > Import > Subtitle at timeline zero.')
        for index in range(subtitle_tracks + 1, timeline.GetTrackCount('subtitle') + 1):
            timeline.SetTrackName('subtitle', index, 'precut subtitles')
    print('precut: applied %d clip LUTs and imported available subtitles.' % len(applied))


if __name__ == '__main__':
    try:
        resolve
    except NameError:
        import DaVinciResolveScript as dvr
        resolve = dvr.scriptapp('Resolve')
    export_folder = globals().get('EXPORT_FOLDER')
    if not export_folder:
        if '__file__' not in globals():
            raise RuntimeError('Set EXPORT_FOLDER to the exported package folder before pasting into the console.')
        export_folder = Path(__file__).resolve().parent
    apply(resolve, export_folder)
