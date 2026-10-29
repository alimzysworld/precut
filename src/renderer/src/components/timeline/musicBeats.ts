import {beatJoinTrim} from '../../../../shared/music-join';
import type { CutEdit, DraftTimeline } from '../../../../shared/schema';
import type { MusicGrid, MusicTrimBounds } from '../../../../shared/music-grid';
import { magneticPreview, magneticSpans, trimEdge, type TrimEdge } from './model';

export type MusicTick = { at: number; kind: 'beat' | 'bar' | 'hit' };
/** A binary search keeps pointer work independent of song length. */
function near(times: number[], at: number, radius: number): number[] {
  let a=0,b=times.length;
  while(a<b){const m=(a+b)>>>1;if(times[m]<at-radius)a=m+1;else b=m;}
  const result:number[]=[];
  for(let i=a;i<times.length && times[i]<=at+radius;i++)result.push(times[i]);
  return result.sort((x,y)=>Math.abs(x-at)-Math.abs(y-at));
}
export function musicSnap(at: number, grid: MusicGrid, scale: number, targets: number[] = [], allowed: (t: number)=>boolean = ()=>true) {
  const radius=8/Math.max(.001,scale);
  // Downbeats have priority, then the nearest measured beat, hit or existing snap.
  return near(grid.bars,at,radius).find(allowed) ?? [...near(grid.beats,at,radius),...near(grid.hits,at,radius),...targets.filter(t=>Math.abs(t-at)<=radius)]
    .sort((a,b)=>Math.abs(a-at)-Math.abs(b-at)).find(allowed);
}
export function musicTicks(grid: MusicGrid, scale: number): MusicTick[] {
  const gaps=grid.beats.slice(1).map((t,i)=>t-grid.beats[i]).filter(t=>t>0).sort((a,b)=>a-b);
  const detailed=(gaps[Math.floor(gaps.length/2)] ?? 0)*scale>=24;
  const candidates=[...grid.bars.map(at=>({at,kind:'bar' as const})),...(detailed ? [...grid.hits.map(at=>({at,kind:'hit' as const})),...grid.beats.map(at=>({at,kind:'beat' as const}))] : [])];
  const kept:MusicTick[]=[];
  // Priority order prevents a beat from hiding a bar. Bucket neighbours avoid quadratic thinning.
  const buckets=new Set<number>();
  for(const tick of candidates){const x=tick.at*scale,bucket=Math.floor(x/10);if(tick.kind!=='bar' && (buckets.has(bucket)||buckets.has(bucket-1)||buckets.has(bucket+1)))continue;kept.push(tick);buckets.add(bucket);}
  // A measured hit coincident with a bar strengthens that bar rather than hiding it.
  return kept.map(t=>({...t,kind:t.kind==='bar' && near(grid.hits,t.at,.001).length ? 'hit' : t.kind})).sort((a,b)=>a.at-b.at);
}
export {joinBeat} from '../../../../shared/music-join';
export function snapJoinToBeat(plan:DraftTimeline,index:number,grid:MusicGrid,fpsFor:(piece:number)=>number) {
  const trim=beatJoinTrim(plan,index,grid,fpsFor);
  return trim ? {trim,plan:magneticPreview(plan,trim)} : undefined;
}
export function safeSourceEdge(value: number, bounds: MusicTrimBounds | undefined, s: number, e: number, edge: TrimEdge, fps: number) {
  if(!bounds || value<bounds.low-1e-7 || value>bounds.high+1e-7 || !bounds.safe.some(([a,b])=>value>=a-1e-7 && value<=b+1e-7))return false;
  const length=edge==='start' ? e-value : value-s;
  return length>=1/fps-1e-7 && (bounds.lockedDuration===null || Math.abs(length-bounds.lockedDuration)<1e-7);
}
export function musicalTrim(piece: {s:number;e:number;timelineS:number;lengthS:number}, edge: TrimEdge, delta: number,
  duration: number, speed: number, fps: number, grid: MusicGrid, targets: number[], scale: number, disabled: boolean, bounds?: MusicTrimBounds) {
  const raw=trimEdge(piece,edge,delta,duration,speed,fps,[],scale,true);
  if(disabled)return {...raw,snap:undefined};
  const end=piece.timelineS+piece.lengthS, wanted=end+(edge==='end'?delta:-delta);
  const source=(t:number)=>Math.round(((edge==='end'?piece.e:piece.s)+(edge==='end'?t-end:end-t)*speed)*fps)/fps;
  const snap=musicSnap(wanted,grid,scale,targets,t=>safeSourceEdge(source(t),bounds,piece.s,piece.e,edge,fps)
    && Math.abs((source(t)-(edge==='end'?piece.e:piece.s))/speed-(edge==='end'?t-end:end-t))<=.5/fps+1e-7);
  if(snap===undefined)return {...raw,snap};
  return {s:edge==='start'?source(snap):piece.s,e:edge==='end'?source(snap):piece.e,limit:null,snap};
}
/** Gapless moves and source drops fit the preceding handle to a nearby beat.
 * Never create a gap or slide an entire spoken clip off its chosen source. */
export function fitPlacement(plan: DraftTimeline, index: number, grid: MusicGrid, scale: number, fpsFor: (piece:number)=>number, disabled: boolean) {
  const spans=magneticSpans(plan), prior=spans[index-1];
  if(disabled || !prior)return;
  const pictures=plan.pieces.filter(p=>p.layer===0 && p.piece===prior.piece), first=pictures[0], last=pictures.at(-1)!;
  const s=first.inS,e=last.timeMap?.at(-1)?.s ?? last.inS+last.endS-last.startS;
  const keys=last.timeMap,speed=keys && keys.length>1 ? (keys.at(-1)!.s-keys[0].s)/(keys.at(-1)!.t-keys[0].t) : 1;
  // Ramps and overlaps have nonlinear join clocks; leave those joins in place.
  if(speed<=0 || pictures.some(p=>p.timeMap?.some((k,i,all)=>i>0 && Math.abs((k.s-all[i-1].s)/(k.t-all[i-1].t)-speed)>.001)) || index<spans.length && spans[index].startS<prior.endS-1e-6)return;
  const fps=fpsFor(prior.piece),bounds=plan.musicTrimBounds?.[prior.piece];
  const result=musicalTrim({s,e,timelineS:prior.startS,lengthS:prior.endS-prior.startS},'end',0,bounds?.high ?? e,speed,fps,grid,[],scale,false,bounds);
  if(result.snap===undefined)return;
  const trim:CutEdit={kind:'trim',piece:prior.piece,s:result.s,e:result.e,magnetic:true};
  return {trim,plan:magneticPreview(plan,trim),snap:result.snap};
}
