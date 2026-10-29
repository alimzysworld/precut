/** One bounded, timeline-clock envelope for live playback, delivery and editors. */
export const MUSIC_DUCK = { speechDb: 10, ambienceDb: 6, attackS: .08, holdS: .45, releaseS: .7 } as const;
export type DuckSpan = { startS: number; endS: number; muted?: boolean; duckDb?: number };
export type DuckKey = { t: number; gain: number };
export function duckDepth(value: number = MUSIC_DUCK.speechDb): number { return Math.max(0, Math.min(24, Number.isFinite(value) ? value : MUSIC_DUCK.speechDb)); }
export function musicDuckKeys(spans: DuckSpan[], duration: number, depth?: number): DuckKey[] {
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

/** Preserve motion in the rhythm section while clearing the voice range.
 * Transform the existing linear-amplitude envelope, preserving its exact clock. */
const rhythmEnvelopes = new WeakMap<DuckKey[],DuckKey[]>();
export function stemDuckKeys(keys: DuckKey[], stem: 'vocals' | 'other' | 'drums' | 'bass'): DuckKey[] {
  if (stem === 'vocals' || stem === 'other') return keys;
  const cached=rhythmEnvelopes.get(keys);if(cached)return cached;
  const floor = 10 ** (-2 / 20), minimum = keys.reduce((value,key)=>Math.min(value,key.gain),1);
  if (minimum >= 1) return keys;
  const result=keys.map(k => ({t:k.t, gain:1-(1-k.gain)*(1-Math.max(floor,minimum))/(1-minimum)}));
  rhythmEnvelopes.set(keys,result);return result;
}
