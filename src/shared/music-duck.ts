import type { MusicShapeMark } from './music-shape';
/** One bounded, timeline-clock envelope for live playback, delivery and editors. */
export const MUSIC_DUCK = { speechDb: 10, ambienceDb: 6, attackS: .08, holdS: .45, releaseS: .7 } as const;
export type DuckSpan = { startS: number; endS: number; muted?: boolean; duckDb?: number };
export type DuckKey = { t: number; gain: number };
export function duckDepth(value: number = MUSIC_DUCK.speechDb): number { return Math.max(0, Math.min(24, Number.isFinite(value) ? value : MUSIC_DUCK.speechDb)); }
/** PRO3a: shape (music-shape.ts) multiplies the duck. Without one the keys are exactly as before. */
export function musicDuckKeys(spans: DuckSpan[], duration: number, depth?: number, shape?: readonly MusicShapeMark[]): DuckKey[] {
  const keys = speechDuckKeys(spans, duration, depth);
  return shape?.length ? shapeKeys(keys, shape, duration) : keys;
}
function speechDuckKeys(spans: DuckSpan[], duration: number, depth?: number): DuckKey[] {
  const active = spans.filter(p => !p.muted && p.endS > p.startS).map(p => ({ ...p, db: duckDepth(depth) * (p.duckDb ?? MUSIC_DUCK.speechDb) / MUSIC_DUCK.speechDb })).sort((a,b)=>a.startS-b.startS);
  const merged: typeof active = [];
  for (const span of active) { const last = merged.at(-1); if(last && last.db===span.db && span.startS-last.endS<=MUSIC_DUCK.holdS) last.endS=Math.max(last.endS,span.endS); else merged.push({...span}); }
  const keys: DuckKey[] = [];
  for(let frame=0;frame<=Math.ceil(duration*50);frame++) {
    const t=Math.min(duration,frame/50);
    const db=merged.reduce((max,p)=>Math.max(max,p.db*Math.max(0,Math.min(1,(t-p.startS+MUSIC_DUCK.attackS)/MUSIC_DUCK.attackS,(p.endS+MUSIC_DUCK.holdS+MUSIC_DUCK.releaseS-t)/MUSIC_DUCK.releaseS))),0);
    const key={t,gain:10**(-db/20)};
    if(keys.length>1 && Math.abs(keys.at(-1)!.gain-key.gain)<1e-10 && Math.abs(keys.at(-2)!.gain-key.gain)<1e-10) keys[keys.length-1]=key; else keys.push(key);
  }
  return keys;
}
export function duckGainAt(keys: DuckKey[], t: number): number {
  if(!keys.length)return 1;
  if(t<=keys[0].t)return keys[0].gain;
  if(t>=keys.at(-1)!.t)return keys.at(-1)!.gain;
  let lo=0,hi=keys.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(t<keys[mid].t)hi=mid;else lo=mid;}
  const a=keys[lo],b=keys[hi];return a.gain+(b.gain-a.gain)*(t-a.t)/(b.t-a.t);
}
/** Balanced expression tree keeps long edits below the filter parser's nesting limit. */
export function musicDuckFilter(keys: DuckKey[]): string {
  function expression(lo:number,hi:number):string {
    if(lo===hi)return String(keys[lo].gain);
    if(hi-lo===1){const a=keys[lo],b=keys[hi];return `${a.gain}+(${b.gain-a.gain})*clip((t-${a.t})/${b.t-a.t},0,1)`;}
    const mid=(lo+hi)>>1;return `if(lt(t,${keys[mid].t}),${expression(lo,mid)},${expression(mid,hi)})`;
  }
  const e=keys.length ? expression(0,keys.length-1) : '1';return `aeval=exprs='val(0)*(${e})|val(1)*(${e})'`;
}

/** The duck times the shape, sampled at the union of both envelopes' bends. The result remembers its parts so a stem's
 * envelope eases only the duck (stemDuckKeys) and keeps the whole stillness or hit. */
const shapedKeys = new WeakMap<DuckKey[], { duck: DuckKey[]; shape: readonly MusicShapeMark[]; duration: number }>();
function shapeKeys(duck: DuckKey[], shape: readonly MusicShapeMark[], duration: number): DuckKey[] {
  const times = [...new Set([...duck.map(k => k.t), ...musicShapeTimes(shape).filter(t => t > 0 && t < duration)])].sort((a, b) => a - b);
  const keys = times.map(t => ({ t, gain: duckGainAt(duck, t) * musicShapeGain(shape, t) }));
  shapedKeys.set(keys, { duck, shape, duration });
  return keys;
}

/** Preserve motion in the rhythm section while clearing the voice range.
 * Transform the existing linear-amplitude envelope, preserving its exact clock. */
const rhythmEnvelopes = new WeakMap<DuckKey[],DuckKey[]>();
export function stemDuckKeys(keys: DuckKey[], stem: 'vocals' | 'other' | 'drums' | 'bass'): DuckKey[] {
  if (stem === 'vocals' || stem === 'other') return keys;
  const cached=rhythmEnvelopes.get(keys);if(cached)return cached;
  const shaped=shapedKeys.get(keys);
  if (shaped) { const result=shapeKeys(stemDuckKeys(shaped.duck,stem),shaped.shape,shaped.duration);rhythmEnvelopes.set(keys,result);return result; }
  const floor = 10 ** (-2 / 20), minimum = keys.reduce((value,key)=>Math.min(value,key.gain),1);
  if (minimum >= 1) return keys;
  const result=keys.map(k => ({t:k.t, gain:1-(1-k.gain)*(1-Math.max(floor,minimum))/(1-minimum)}));
  rhythmEnvelopes.set(keys,result);return result;
}

// PRO3a: the music shape's gain (shared/music-shape.ts has its type and checks). Here, beside the duck it multiplies,
// because this module has no runtime imports.
/** The launch video's moves (remotion/src/precut/Sfx.tsx musicVolume): music 0.6, 0.22 in a stillness (-8.7 dB),
 * 0.6x at a heavy hit (-4.4 dB; 0.45x, -6.9 dB, under the drop), back to full over 9 frames at 30 fps. */
export const MUSIC_SHAPE = {
  stillDb: -8.7, hitDb: -4.4, dropDb: -6.9, recoverS: 0.3,
  /** Into a stillness: one frame of the trailer's 30 fps, half way on its first frame. */
  stepS: 1 / 30,
  /** Back out on the hit: as fast as stays click-free. The level is full again exactly at endS. */
  snapS: 0.005,
  maxMarks: 64,
} as const;

/** One mark's linear gain at t (1 outside it). */
function markGain(m: MusicShapeMark, t: number): number {
  if (m.kind === 'still') {
    if (t <= m.atS || t >= m.endS) return 1;
    const g = 10 ** ((m.db ?? MUSIC_SHAPE.stillDb) / 20);
    return 1 - (1 - g) * Math.min(1, (t - m.atS) / MUSIC_SHAPE.stepS, (m.endS - t) / MUSIC_SHAPE.snapS);
  }
  const g = 10 ** ((m.db ?? MUSIC_SHAPE.hitDb) / 20), r = m.recoverS ?? MUSIC_SHAPE.recoverS;
  if (t <= m.atS - MUSIC_SHAPE.snapS || t >= m.atS + r) return 1;
  return t < m.atS ? 1 - (1 - g) * (t - m.atS + MUSIC_SHAPE.snapS) / MUSIC_SHAPE.snapS : g + (1 - g) * (t - m.atS) / r;
}
/** Overlapping marks take the deeper one, as the trailer's stillness-then-hit does. */
export function musicShapeGain(shape: readonly MusicShapeMark[] | undefined, t: number): number {
  let gain = 1;
  for (const m of shape ?? []) gain = Math.min(gain, markGain(m, t));
  return gain;
}
/** Every time the shape bends, so a piecewise linear envelope through them is the shape. */
export function musicShapeTimes(shape: readonly MusicShapeMark[] | undefined): number[] {
  return (shape ?? []).flatMap(m => m.kind === 'still'
    ? [m.atS, Math.min(m.endS, m.atS + MUSIC_SHAPE.stepS), Math.max(m.atS, m.endS - MUSIC_SHAPE.snapS), m.endS]
    : [m.atS - MUSIC_SHAPE.snapS, m.atS, m.atS + (m.recoverS ?? MUSIC_SHAPE.recoverS)]);
}
