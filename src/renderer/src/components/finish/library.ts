import type { CutEdit, CutVersion, DraftTimeline, Shoot } from "../../../../shared/schema";
import { sourceRange } from "../../../../shared/source-windows";
import { storyboard } from "../edits/model";
import { addOverlayFiles, type OverlaySession } from "../OverlayHandles";

export const LIBRARY_DRAG_TYPE = "application/x-precut-library";
export const isStill = (file: string) => /\.(png|jpe?g|webp|hei[cf]|tiff?|gif)$/i.test(file);
export function shootLibrary(shoot: Shoot) {
  return shoot.clips.filter(clip => isStill(clip.file) || String(clip.byHand?.kind ?? clip.judgement?.kind).replace("-", "") === "broll")
    .map(clip => ({ clip, still: isStill(clip.file), description: clip.judgement?.summary || clip.file.split(/[\\/]/).pop() || clip.id }));
}
/** Insert is a piece-index contract: at the piece under the clock, or append at the end. */
export function libraryInsertIndex(shoot: Shoot, version: CutVersion, timeline: DraftTimeline | null | undefined, time: number): number {
  const pieces = storyboard(shoot, version).pieces;
  if (timeline) {
    const spine = timeline.pieces.filter(p => p.layer === 0);
    const span = [...spine].reverse().find(p => p.startS <= time && time < p.endS);
    if (span) return span.piece ?? spine.indexOf(span);
    if (time >= timeline.durationS) return pieces.length;
    return spine.find(p => p.startS > time)?.piece ?? 0;
  }
  let end = 0;
  const index = pieces.findIndex(p => { end = (p.timelineS ?? end) + (p.lengthS ?? p.e - p.s); return time < end; });
  return index < 0 ? pieces.length : index;
}
export async function addLibraryItem(shoot: Shoot, version: CutVersion, timeline: DraftTimeline | null | undefined, clipId: string, time: number,
  edit: (change: CutEdit) => unknown, session?: OverlaySession) {
  const item = shootLibrary(shoot).find(item => item.clip.id === clipId);
  if (!item) throw new Error("That media is no longer in this shoot.");
  const piece = libraryInsertIndex(shoot,version,timeline,time);
  if (version.layouts?.[piece]?.kind === 'placeholder') {
    const source = item.still ? (item.clip.file.startsWith('/') ? item.clip.file : `${shoot.root}/${item.clip.file}`) : clipId;
    await edit(fillPlaceholderEdit(piece,source)); return;
  }
  if (item.still) {
    if (!session) throw new Error("Wait for the edit to load before adding an image.");
    const source = item.clip.file.startsWith("/") ? item.clip.file : `${shoot.root}/${item.clip.file}`;
    await addOverlayFiles(session, [source], time);
  } else {
    const e = item.clip.meta?.durationS;
    if (!e || e <= 0) throw new Error("This clip has no measured duration yet.");
    await edit({ kind: "insert", at: libraryInsertIndex(shoot, version, timeline, time), source: sourceRange(item.clip) });
  }
}
export function overlayName(file: string) { return file.split(/[\\/]/).pop() || "Image"; }
export function fillPlaceholderEdit(piece:number,clipId:string): CutEdit { return {kind:'layout',piece,layout:{kind:'screen',screen:{clipId,s:0}}}; }
