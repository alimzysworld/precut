import { filmedTime } from './filmed-time';
import type { Clip, CutVersion } from '../shared/schema';

type Piece = NonNullable<CutVersion['pieces']>[number];
export const SHOT_ORDER_INSTRUCTION = "Keep footage in capture-time order across cameras and days by default: day one before day two, then the order events happened. filmedAt is the shared UTC capture clock, never filename or script-beat order. A deliberate opening hook or flash-forward may break chronology only when you explain that specific choice in the edit notes (cut.why). Never undo the person's hand moves. For a new cut with a deliberate exception, return cut.shotOrderReason with that same specific reason. Missing capture clocks are unknown, not permission to guess.";

export function shotOrder(clips: readonly (Clip | undefined)[], selected?: number[], protectedPieces: ReadonlySet<number> = new Set()): number[] {
  if (selected !== undefined && (!Array.isArray(selected) || !selected.length || selected.length > 500 || selected.some(i => !Number.isInteger(i) || i < 0 || i >= clips.length))) throw Error('Choose clips in this edit.');
  const slots = [...new Set(selected ?? clips.map((_, i) => i))].sort((a,b) => a-b).filter(i => !protectedPieces.has(i) && filmedTime(clips[i]) !== null);
  const sorted = [...slots].sort((a,b) => filmedTime(clips[a])! - filmedTime(clips[b])! || a-b);
  const order = clips.map((_,i) => i);
  slots.forEach((slot,i) => { order[slot] = sorted[i]; });
  return order;
}
const key = (p: Piece) => JSON.stringify([p.id,p.clipId]);
/** Older versions predate handMoved. Compare saved occurrences only when the
 * saved reason says this was a hand move/insert, never an automatic draft. */
export function handMovedPieces(current: CutVersion, history: CutVersion[]): Set<number> {
  const keys = new Set((current.pieces ?? []).filter(p => p.handMoved).map(key));
  const explicit=new Map<string,boolean>();
  for(const version of history.filter(v=>v.version<=current.version).sort((a,b)=>a.version-b.version)) {
    const flags=new Map<string,boolean>();
    for(const p of version.pieces ?? [])if(p.handMoved!==undefined)flags.set(key(p),(flags.get(key(p)) ?? false)||p.handMoved);
    for(const [id,moved]of flags)explicit.set(id,moved);
  }
  const resetAt=Math.max(current.shotOrderResetAt ?? 0,...history.filter(v=>v.version<=current.version).map(v=>v.shotOrderResetAt ?? 0));
  for (let v=1;v<history.length;v++) {
    const after=history[v], before=history[v-1];
    if (after.version<=resetAt || after.version>current.version || !/^(Moved a clip|Moved selected clips|Move \d+ clips|Inserted|Added .*clip)/i.test(after.feedback ?? '')) continue;
    const a=after.pieces ?? [], b=before.pieces ?? [];
    // Ambiguous legacy moves protect all changed positions, including duplicates.
    a.forEach((p,i) => { if (key(p)!==(b[i] && key(b[i]))) keys.add(key(p)); });
  }
  return new Set((current.pieces ?? []).flatMap((p,i) => (p.handMoved ?? explicit.get(key(p)) ?? keys.has(key(p))) ? [i] : []));
}
export function defaultShotIds<T extends {id:string}>(items: T[], clipOf: (item:T)=>Clip | undefined, reason?: string): T[] {
  if (reason?.trim()) return items;
  return shotOrder(items.map(clipOf)).map(i=>items[i]);
}
