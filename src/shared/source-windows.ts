import type { Clip, Shoot } from './schema';
import type { MusicGrid } from './music-grid';

export type SourceRange = { clipId: string; s: number; e: number };
export type SourceLength = { id: string; label: string; range: SourceRange; beats?: number };
export function sourceFps(clip: Clip) {
  const fps = clip.meta?.fps;
  return fps && Number.isFinite(fps) && fps > 0 ? fps : 25;
}
const wordsFor = (clip: Clip) => (clip.transcript ?? []).flatMap(s=>s.words ?? []).filter(w=>Number.isFinite(w.s) && Number.isFinite(w.e) && w.e>w.s).sort((a,b)=>a.s-b.s);
/** The peak's usable span wins; older judgements use their longest span. */
export function sourceRange(clip: Clip, attempt?: { s: number; e: number | null }): SourceRange {
  const duration=clip.meta?.durationS ?? 0, fps=sourceFps(clip);
  if(!Number.isFinite(duration) || duration<=0)return {clipId:clip.id,s:0,e:0};
  const spans=(clip.judgement?.usableSpans ?? []).filter(([s,e])=>Number.isFinite(s) && Number.isFinite(e) && e>s && s<duration && e>0).map(([s,e])=>[Math.max(0,s),Math.min(duration,e)]);
  const peak=clip.judgement?.peakS;
  const best=attempt?.e!=null ? [attempt.s,attempt.e] : spans.find(([s,e])=>peak!==undefined && peak>=s && peak<=e) ?? spans.reduce<number[]|null>((a,b)=>!a || b[1]-b[0]>a[1]-a[0] ? b : a,null) ?? [0,duration];
  let s=Math.ceil(Math.max(0,best[0])*fps-1e-7)/fps, e=Math.floor(Math.min(duration,best[1])*fps+1e-7)/fps;
  // Stay inside usable footage and never cut through a measured word.
  for(const w of wordsFor(clip))if(s>w.s+1e-7 && s<w.e-1e-7)s=Math.ceil(w.e*fps-1e-7)/fps;
  for(const w of wordsFor(clip).reverse())if(e>w.s+1e-7 && e<w.e-1e-7)e=Math.floor(w.s*fps+1e-7)/fps;
  return {clipId:clip.id,s,e:Math.max(s,e)};
}
/** Saved judge peak, then the judge's quoted words, then an honest legacy midpoint. */
export function sourcePeak(clip: Clip, usable: SourceRange, shoot?: Pick<Shoot,'takes'>): number {
  const peak=clip.judgement?.peakS;
  if(peak!==undefined && Number.isFinite(peak) && peak>=usable.s && peak<=usable.e)return peak;
  const normalize=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const words=wordsFor(clip).filter(w=>w.s>=usable.s && w.e<=usable.e);
  for(const take of shoot?.takes ?? [])for(const a of take.attempts)if(a.clipId===clip.id && a.soundbite && !a.practice){
    const quote=normalize(a.soundbite);if(!quote)continue;
    for(let i=0;i<words.length;i++){let phrase='';for(let j=i;j<words.length;j++){phrase=normalize(`${phrase} ${words[j].w}`);if(phrase===quote)return (words[i].s+words[j].e)/2;if(phrase.length>=quote.length)break;}}
  }
  return (usable.s+usable.e)/2;
}
/** Exact frame lengths, all growing around one fixed peak. Impossible word-safe lengths hide. */
export function sourceLengths(clip: Clip, usable: SourceRange, grid?: MusicGrid, landing?: number, shoot?: Pick<Shoot,'takes'>): SourceLength[] {
  const fps=sourceFps(clip), peak=sourcePeak(clip,usable,shoot), total=Math.round((usable.e-usable.s)*fps);
  if(total<1)return [];
  const words=wordsFor(clip), speech:{s:number;e:number}[]=[];
  for(const w of words){const last=speech.at(-1);if(last && w.s<last.e-1e-7)last.e=Math.max(last.e,w.e);else speech.push({s:w.s,e:w.e});}
  const insideWord=(t:number)=>{let a=0,b=speech.length;while(a<b){const m=(a+b)>>>1;if(speech[m].s<t-1e-7)a=m+1;else b=m;}return a>0 && t<speech[a-1].e-1e-7;};
  // Keep the chosen join fixed. The outgoing edge reaches the measured grid,
  // even when the incoming join falls between beats.
  const beatIndex=grid && landing!==undefined ? grid.beats.findIndex(t=>t>=landing-1/fps) : -1;
  const barIndex=grid && landing!==undefined ? grid.bars.findIndex(t=>t>=landing-1/fps) : -1;
  const specs: {id:string;label:string;seconds:number;beats?:number}[]=[];
  if(grid?.beats.length){
    if(beatIndex>=0)for(const n of [1,2])if(grid.beats[beatIndex+n]!==undefined)specs.push({id:`${n} beat${n===1?'':'s'}`,label:`${n} beat${n===1?'':'s'}`,seconds:grid.beats[beatIndex+n]-landing!,beats:n});
    if(barIndex>=0)for(const n of [1,2])if(grid.bars[barIndex+n]!==undefined){const end=grid.bars[barIndex+n];specs.push({id:`${n} bar${n===1?'':'s'}`,label:`${n} bar${n===1?'':'s'}`,seconds:end-landing!,beats:grid.beats.filter(t=>t>=grid.bars[barIndex]-1e-7 && t<end-1e-7).length});}
  }
  // No musical length fits this landing (e.g. the last bar of the song): offer plain seconds rather than nothing.
  if(!specs.length)for(const n of [1,2,3,5])specs.push({id:`${n} s`,label:`${n} s`,seconds:n});
  let previous={s:peak,e:peak};
  const result:SourceLength[]=[];
  for(const spec of specs.sort((a,b)=>a.seconds-b.seconds)){
    const frames=Math.round(spec.seconds*fps), length=frames/fps;
    if(frames<1 || frames>total)continue;
    const low=Math.ceil(Math.max(usable.s,previous.e-length)*fps-1e-7), high=Math.floor(Math.min(usable.e-length,previous.s)*fps+1e-7);
    const ideal=(peak-length/2)*fps;
    // Word boundaries describe every allowed interval, so no per-frame search is needed.
    const candidates=[low,high,Math.round(ideal),...words.flatMap(w=>[Math.floor(w.s*fps+1e-7),Math.ceil(w.e*fps-1e-7),Math.floor(w.s*fps+1e-7)-frames,Math.ceil(w.e*fps-1e-7)-frames])];
    const start=candidates.filter(f=>f>=low && f<=high && !insideWord(f/fps) && !insideWord((f+frames)/fps)).sort((a,b)=>Math.abs(a-ideal)-Math.abs(b-ideal) || a-b)[0];
    if(start===undefined)continue;
    const range={clipId:clip.id,s:start/fps,e:(start+frames)/fps};previous=range;
    result.push({id:spec.id,label:spec.beats!==undefined?`${spec.label} · ${length.toFixed(1)} s`:spec.label,range,beats:spec.beats});
  }
  result.push({id:'best',label:`Best bit · ${(usable.e-usable.s).toFixed(1)} s`,range:usable});
  return result;
}
