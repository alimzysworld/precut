import type { CutVersion, DraftPiece } from '../shared/schema';
import type { CutItem } from './export';
import type { FxPlan } from './edits-fx';
import type { CaptionTrack } from './titles/captions';

export type CraftVersion = Pick<CutVersion, 'energy' | 'titles'> & { jumpScales?: (number | null)[] };
export type CraftPlan = { punchScale: number; scales: number[]; punches: { atS: number; endS: number; line: string }[]; rolls: { s: number; e: number }[] };
const faces = (c: CutItem) => (c.seg?.clip.subject?.samples ?? []).filter(p => p.kind === 'face' && [p.t, p.x, p.y, p.w, p.h].every(Number.isFinite) && p.w > 0 && p.h > 0);
function matching(a: CutItem, b: CutItem) {
  if (!a.seg || !b.seg || a.seg.lineIndex === null || b.seg.lineIndex === null) return false;
  if (a.seg.clip.id === b.seg.clip.id) return true;
  const x = faces(a).at(-1), y = faces(b)[0];
  return !!x && !!y && Math.abs(x.x - y.x) < .06 && Math.abs(x.y - y.y) < .06 && Math.abs(x.w - y.w) < .025 && Math.abs(x.h - y.h) < .035 &&
    Math.abs(a.seg.clip.meta!.width / a.seg.clip.meta!.height - b.seg.clip.meta!.width / b.seg.clip.meta!.height) < .02;
}
/** Reuse judged emphasis and big lines. No extra editorial model call. */
export function planCraft(cuts: CutItem[], fx: FxPlan, fps: number, version: CraftVersion): CraftPlan {
  const result: CraftPlan = { punchScale: version.energy === 'punchy' ? 1.12 : 1.08, scales: cuts.map(() => 1), punches: [], rolls: [] };
  if (version.energy === 'off') return result;
  const track = version.titles as CaptionTrack | null | undefined, cues = track?.cues ?? [];
  // Hold the base framing for the entire rolled cue, including its exit.
  result.rolls = cues.filter(c => c.enter === 'roll').map(c => ({ s: c.s, e: c.e }));
  let punched = false;
  cuts.forEach((cut, i) => {
    if (i && matching(cuts[i - 1], cut)) punched = !punched; else punched = false;
    const scale = version.jumpScales?.[fx.items[i].piece];
    result.scales[i] = typeof scale === "number" && Number.isFinite(scale) && scale >= 1 && scale <= 1.18 ? scale : punched ? 1.12 : 1;
  });
  const source = track?.captionSource?.words ?? [];
  const used = new Set<string>();
  const candidates = [
    ...(track?.emphasis ?? []).flatMap(id => source[Number(id)] ? [source[Number(id)].s] : []),
    ...cues.flatMap(c => (c.words ?? []).filter(w => w.accent).map(w => w.s)),
    ...cues.filter(c => c.role === 'title' && c.size >= .08).map(c => c.words?.[0]?.s ?? c.s),
  ].sort((a, b) => a - b);
  for (const s of candidates) {
    const atS = Math.ceil((s - 1e-8) * fps) / fps;
    const i = fx.items.findIndex(p => atS >= p.startS && atS < p.endS);
    if (i < 0 || fx.items[i].reverse || cuts[i].seg?.lineIndex === null) continue;
    const c = cuts[i], line = c.seg?.lineIndex == null ? `piece-${fx.items[i].piece}` : `line-${c.seg.lineIndex}`;
    if (used.has(line) || result.rolls.some(r => atS >= r.s - 1 / fps && atS < r.e)) continue;
    const cueEnd = Math.max(atS + .3, ...cues.filter(cue => cue.s <= s && cue.e > s).map(cue => cue.e));
    const endS = Math.min(fx.items[i].endS, cueEnd, ...result.rolls.filter(r => r.s > atS).map(r => r.s));
    result.punches.push({ atS, endS, line }); used.add(line);
  }
  return result;
}

/** Face box plus headroom constrains every crop, including tracking motion. */
export function craftRect(base: NonNullable<DraftPiece['frame']>[number], cut: CutItem, sourceS: number, scale: number) {
  if (scale <= 1) return base;
  const track = faces(cut).sort((a, b) => a.t - b.t);
  if (!track.length) return base;
  let n = track.findIndex(p => p.t >= sourceS); if (n < 0) n = track.length - 1;
  const b = track[n], a = track[Math.max(0, n - 1)], u = a === b ? 0 : Math.max(0, Math.min(1, (sourceS - a.t) / (b.t - a.t)));
  const face = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: Math.max(a.w, b.w), h: Math.max(a.h, b.h) };
  const left = face.x - face.w * .7, right = face.x + face.w * .7, top = face.y - face.h, bottom = face.y + face.h * .7;
  scale = Math.min(scale, base.w / (right - left), base.h / (bottom - top));
  const w = base.w / scale, h = base.h / scale;
  const lowX = Math.max(base.x, right - w), highX = Math.min(base.x + base.w - w, left);
  const lowY = Math.max(base.y, bottom - h), highY = Math.min(base.y + base.h - h, top);
  if (scale <= 1 || lowX > highX || lowY > highY) return base;
  return { ...base, x: Math.max(lowX, Math.min(highX, face.x - w / 2)), y: Math.max(lowY, Math.min(highY, face.y - h / 2)), w, h };
}
