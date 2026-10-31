import type { CutVersion, DraftPiece } from '../shared/schema';
import type { CutItem } from './export';
import type { FxPlan } from './edits-fx';
import type { CaptionTrack } from './titles/captions';

export type CraftVersion = Pick<CutVersion, 'energy' | 'titles' | 'pieceFx'> & { jumpScales?: (number | null)[] };
/** PRO3b: an authored punch on cut item `item`, on the reel clock (atS is the frame it lands on). */
export type CraftMotion = { item: number; atS: number; endS: number; scale: number; style: 'settle' | 'hold'; frames: number; creep: number };
export type CraftPlan = { punchScale: number; scales: number[]; punches: { atS: number; endS: number; line: string }[]; rolls: { s: number; e: number }[]; motions?: CraftMotion[] };
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
  // PRO3b: authored punches are his (or a pass's) choice, on any clip, whatever the energy.
  const motions = craftMotions(fx, fps, version);
  if (motions.length) result.motions = motions;
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

/** PRO3b: each authored punch lands on the frame showing its source second (skipped when that frame is trimmed away
 * or plays backwards) and runs to the end of its cut item (hold: for lengthS). */
function craftMotions(fx: FxPlan, fps: number, version: CraftVersion): CraftMotion[] {
  const out: CraftMotion[] = [];
  fx.items.forEach((item, i) => {
    if (item.reverse) return;
    for (const p of version.pieceFx?.[item.piece]?.punches ?? []) {
      const first = item.timeMap[0].s, last = item.timeMap.at(-1)!.s;
      if (!(p.sourceS >= first - 1e-6 && p.sourceS < last - 1e-6)) continue;
      const atS = item.startS + Math.max(0, Math.round((timeAt(item.timeMap, p.sourceS) - item.startS) * fps)) / fps;   // on the item's own frame clock, as the export draws it
      if (atS >= item.endS - 1e-6) continue;
      const style = p.style ?? 'settle', frames = Math.max(1, Math.round(p.frames ?? fps * .2)), creep = p.creep ?? 0;
      const until = style === 'hold' && p.lengthS ? atS + p.lengthS : Infinity;
      // A clip can be several items (a trim that runs past its first span adds one): the punch carries on through the
      // ones that follow it on the reel, on the same count of frames since the hit.
      for (let j = i; j < fx.items.length && fx.items[j].piece === item.piece && !fx.items[j].reverse && (j === i || Math.abs(fx.items[j].startS - fx.items[j - 1].endS) < 1e-6); j++) {
        if (fx.items[j].startS >= until - 1e-7) break;
        out.push({ item: j, atS, endS: Math.min(fx.items[j].endS, until), scale: p.scale, style, frames, creep });
      }
    }
  });
  return out.sort((a, b) => a.atS - b.atS);
}
function timeAt(keys: { t: number; s: number }[], s: number) {
  for (let i = 1; i < keys.length; i++) if (s <= keys[i].s) return keys[i - 1].t + (keys[i].t - keys[i - 1].t) * (s - keys[i - 1].s) / (keys[i].s - keys[i - 1].s || 1);
  return keys.at(-1)!.t;
}
/** PRO3b: the scale an authored punch puts on reel second t (1 outside it). Settle is the launch video's
 * (remotion/src/precut/kit.tsx settle): scale eased to 1 over `frames` with out cubic, times 1 + creep per frame. */
export function motionScale(motions: CraftMotion[], item: number, t: number, fps: number): number {
  let scale = 1;
  for (const m of motions) {
    if (m.item !== item || t < m.atS - .5 / fps || t >= m.endS - 1e-7) continue;
    const n = Math.max(0, Math.round((t - m.atS) * fps));
    scale = m.style === 'hold' ? m.scale : (m.scale + (1 - m.scale) * (1 - Math.pow(1 - Math.min(1, n / m.frames), 3))) * (1 + m.creep * n);
  }
  return scale;
}
/** PRO3b: zoom a framing rect by `scale` about a point that stays put on screen (the face, else the centre). The rect
 * stays inside the base, so the scale is exact. */
export function zoomAbout(base: NonNullable<DraftPiece['frame']>[number], cut: CutItem, sourceS: number, scale: number) {
  if (scale === 1) return base;
  const track = faces(cut).sort((a, b) => a.t - b.t);
  let n = track.findIndex(p => p.t >= sourceS); if (n < 0) n = track.length - 1;
  const face = track[n], inside = (v: number, lo: number, size: number) => Math.max(lo, Math.min(lo + size, v));
  const ax = face ? inside(face.x, base.x, base.w) : base.x + base.w / 2, ay = face ? inside(face.y, base.y, base.h) : base.y + base.h / 2;
  return { ...base, x: ax - (ax - base.x) / scale, y: ay - (ay - base.y) / scale, w: base.w / scale, h: base.h / scale };
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
