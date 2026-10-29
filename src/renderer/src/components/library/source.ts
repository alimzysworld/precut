import type { Clip, CutVersion, DraftTimeline, Shoot } from '../../../../shared/schema';
import { sourceFps, type SourceRange } from '../../../../shared/source-windows';
export { sourceFps, sourceRange, sourcePeak, sourceLengths, type SourceRange } from '../../../../shared/source-windows';
export { sourcePlacement, sourceDestination } from '../../../../shared/source-placement';

export const SOURCE_DRAG_TYPE = 'application/x-precut-source-span';
export function markSource(clip: Clip, range: SourceRange, edge: 's' | 'e', time: number): SourceRange {
  const fps = sourceFps(clip), last = Math.floor((clip.meta?.durationS ?? 0)*fps+1e-7), frame = Math.round(time*fps);
  return edge === 's' ? { ...range, s: Math.max(0,Math.min(Math.round(range.e*fps)-1,frame))/fps }
    : { ...range, e: Math.min(last,Math.max(Math.round(range.s*fps)+1,frame))/fps };
}
/** Joins use playback positions after speed, overlaps and transcript cuts. */
export function sourceInsertAt(version: CutVersion, timeline: DraftTimeline | null | undefined, time: number): number {
  const pieces = version.pieces ?? [];
  const joins = timeline ? pieces.map((_,i) => timeline.pieces.find(p => p.layer === 0 && p.piece === i)?.startS ?? Infinity)
    : pieces.map(p => p.timelineS);
  joins.push(timeline?.durationS ?? version.lengthS);
  return joins.reduce((best,t,i) => Math.abs(t-time) < Math.abs(joins[best]-time) ? i : best, 0);
}
export function writeSourceDrag(transfer: DataTransfer, root: string, source: SourceRange) {
  transfer.setData(SOURCE_DRAG_TYPE, JSON.stringify({ root, ...source })); transfer.effectAllowed = 'copy';
}
export function readSourceDrag(transfer: DataTransfer, shoot: Shoot): SourceRange {
  const source = JSON.parse(transfer.getData(SOURCE_DRAG_TYPE));
  const clip = shoot.clips.find(c => c.id === source.clipId);
  if (source.root !== shoot.root || !clip || clip.leftOut || clip.missing || ![source.s,source.e].every(Number.isFinite) || source.s < 0 || source.e <= source.s || source.e > (clip.meta?.durationS ?? 0)) throw new Error('Choose a valid source span from this shoot.');
  return { clipId: clip.id, s: source.s, e: source.e };
}
