import type { CutEdit, DraftTimeline } from './schema';
import type { MusicGrid } from './music-grid';
import { beatAt } from './music-grid';

/** Measured only: the nearest join hint is at most three output frames away. */
export function joinBeat(grid:MusicGrid,at:number,fps:number) {
  const aligned=beatAt(grid,at,.5/fps);
  if(aligned!==undefined)return {at:aligned,frames:0};
  let closest:number|undefined;
  for(const times of [grid.beats,grid.bars,grid.hits]) {
    let low=0,high=times.length;
    while(low<high){const mid=(low+high)>>>1;if(times[mid]<at)low=mid+1;else high=mid;}
    for(const t of [times[low-1],times[low]])if(t!==undefined && Math.abs(t-at)<=3/fps+1e-7 && (closest===undefined || Math.abs(t-at)<Math.abs(closest-at)))closest=t;
  }
  return closest===undefined ? undefined : {at:closest,frames:Math.max(1,Math.round(Math.abs(closest-at)*fps))};
}
/** The button and MCP use exactly the same source-frame/word-safe trim. */
export function beatJoinTrim(plan:DraftTimeline,index:number,grid:MusicGrid,fpsFor:(piece:number)=>number):Extract<CutEdit,{kind:'trim'}>|undefined {
  const groups=new Map<number,typeof plan.pieces>();
  for(const p of plan.pieces)if(p.layer===0 && p.piece!==undefined)groups.set(p.piece,[...(groups.get(p.piece) ?? []),p]);
  const spans=[...groups.entries()].map(([piece,parts])=>({piece,parts,startS:parts[0].startS,endS:parts.at(-1)!.endS})).sort((a,b)=>a.startS-b.startS);
  const prior=spans[index-1],next=spans[index],fps=plan.fps ?? 25;
  if(!prior || !next || Math.abs(prior.endS-next.startS)>1e-6)return;
  const target=joinBeat(grid,next.startS,fps);if(!target?.frames)return;
  const first=prior.parts[0],last=prior.parts.at(-1)!,keys=last.timeMap;
  const s=first.inS,e=keys?.at(-1)?.s ?? last.inS+last.endS-last.startS;
  const speed=keys && keys.length>1 ? (keys.at(-1)!.s-keys[0].s)/(keys.at(-1)!.t-keys[0].t) : 1;
  if(speed<=0 || prior.parts.some(p=>p.timeMap?.some((k,i,all)=>i>0 && Math.abs((k.s-all[i-1].s)/(k.t-all[i-1].t)-speed)>.001)))return;
  const sourceFps=fpsFor(prior.piece),edge=Math.round((e+(target.at-prior.endS)*speed)*sourceFps)/sourceFps;
  const bounds=plan.musicTrimBounds?.[prior.piece];
  if(!bounds || edge<bounds.low-1e-7 || edge>bounds.high+1e-7 || !bounds.safe.some(([a,b])=>edge>=a-1e-7 && edge<=b+1e-7) || edge-s<1/sourceFps-1e-7 || bounds.lockedDuration!==null && Math.abs(edge-s-bounds.lockedDuration)>1e-7)return;
  if(Math.abs(prior.endS+(edge-e)/speed-target.at)>.5/fps+1e-7)return;
  return {kind:'trim',piece:prior.piece,s,e:edge,magnetic:true};
}
