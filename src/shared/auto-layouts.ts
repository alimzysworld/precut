import type { LayoutChoice, Shoot } from './schema';
import { LAYOUTS, type LayoutId } from './layout-presets';
import { matchScreen } from './screen-match';
import type { MusicGrid } from './music-grid';
import {clipDimensions} from './media';

export type LayoutWord = { s: number; e: number; w: string };
export type LayoutPacket = { durationS: number; words: LayoutWord[]; cameras: { clipId: string; s: number; e: number; sourceS: number }[] };
export type LayoutReply = { s: number; e: number; id: LayoutId; clipId?: string; sourceS?: number; sourceE?: number; reason: string; transition?: 'smooth'|'cut' };
export const wordSafe = (t:number, words:LayoutWord[]) => !words.some(w=>t>w.s+1e-7&&t<w.e-1e-7);
/** The nearest legal musical join wins. Word safety and minimum holds take precedence
 * when the measured music offers no legal join. No invented beats. */
export function layoutBoundary(at:number, low:number, high:number, words:LayoutWord[], grid?:MusicGrid, joins:number[]=[]):number|undefined {
  const legal=(t:number)=>Number.isFinite(t)&&t>=low-1e-7&&t<=high+1e-7&&wordSafe(t,words);
  const nearest=(values:number[])=>values.filter(legal).sort((a,b)=>Math.abs(a-at)-Math.abs(b-at)||a-b)[0];
  return nearest(grid?.beats??[])??nearest([...joins,...words.flatMap(w=>[w.s,w.e]),low,high,...(wordSafe(at,words)?[at]:[])]);
}
export function readLayoutReply(value:unknown):LayoutReply[] {
  const ranges=(value as {ranges?:unknown})?.ranges;
  if(!Array.isArray(ranges)||!ranges.length||ranges.length>256)throw Error('Could not read the chosen layouts.');
  return ranges.filter(r=>r&&Number.isFinite(r.s)&&Number.isFinite(r.e)&&r.e>r.s&&LAYOUTS.some(l=>l[0]===r.id)&&typeof r.reason==='string'&&r.reason.trim()).map(r=>({...r,reason:r.reason.trim().slice(0,1000)})).sort((a,b)=>a.s-b.s);
}
/** Decisions come from the reply. Code repairs coverage, source bounds and timing. */
export function guaranteeLayouts(reply:LayoutReply[],packet:LayoutPacket,shoot:Shoot,grid?:MusicGrid):LayoutChoice[] {
  const duration=packet.durationS;
  if(!reply.length||duration<=0)throw Error('Could not read the chosen layouts.');
  const min=Math.min(1.5,duration),picked=[reply[0]],edges=[0];
  for(const r of reply.slice(1)){
    const at=layoutBoundary(r.s,edges.at(-1)!+min,duration-min,packet.words,grid);
    if(grid?.beats.length&&(at===undefined||!grid.beats.includes(at))){
      // A musical change that would cut a word is merged into a neighbouring hold.
      if(r.id!=='camera-only')picked[picked.length-1]={...r,reason:r.reason+' Kept together because no safe beat was available.'};
      continue;
    }
    if(at===undefined||at<=edges.at(-1)!+1e-7)continue;
    edges.push(at);picked.push(r);
  }
  edges.push(duration);
  return picked.map((r,i)=>{
    const s=edges[i],e=edges[i+1],topic=packet.words.filter(w=>w.s<e&&w.e>s).map(w=>w.w).join(' ');
    const matches=matchScreen(shoot,topic).filter(m=>shoot.clips.some(c=>c.id===m.clipId&&c.proxy&&c.meta&&c.meta.durationS>0));
    const portrait=r.id.startsWith('phone')?matches.find(m=>{const d=clipDimensions(shoot.clips.find(c=>c.id===m.clipId)!);return d.height>d.width;}):undefined;
    const selected=matches.find(m=>m.clipId===r.clipId&&Number.isFinite(r.sourceS)&&r.sourceS!>=m.s&&r.sourceS!<m.e)??portrait??matches[0];
    const camera=packet.cameras.find(c=>c.s<=s+1e-7&&c.e>s+1e-7)??packet.cameras[0];
    const out:LayoutChoice={kind:'scene',id:r.id,s,e,auto:true,followCamera:true,reason:r.reason,transition:r.transition==='cut'?'cut':'smooth',radius:16,padding:.04,sources:{}};
    if(r.id!=='camera-only'){
      if(!selected)throw Error('Add a ready screen recording to choose layouts.');
      const clip=shoot.clips.find(c=>c.id===selected.clipId)!;
      const frameS=Math.min(clip.meta!.durationS,1/(clip.meta!.fps||30));
      const start=Math.max(0,Math.min(clip.meta!.durationS-frameS,selected.clipId===r.clipId&&Number.isFinite(r.sourceS)?r.sourceS!:selected.s));
      const end=Math.max(start+frameS,Math.min(clip.meta!.durationS,Number.isFinite(r.sourceE)&&r.sourceE!>start?r.sourceE!:selected.e));
      out.sources!.a={clipId:selected.clipId,s:start};
      if(end-start<e-s-1e-7){out.screenLoop={s:start,e:end};out.reason+=' Repeats this screen segment to fill the range.';}
      if(selected.clipId!==r.clipId)out.reason+=` ${selected.reason}`;
    }
    if(!['screen-only','phone-only'].includes(r.id)){
      if(!camera)throw Error('Add a camera clip to choose this layout.');
      out.sources!.b={clipId:camera.clipId,s:camera.sourceS+s-camera.s};
    }
    return out;
  });
}

/** Advance independent looping sources when a hand split retains the right side. */
export function advanceLayout(l:LayoutChoice,at:number,advance?:(ref:{clipId:string;s:number},from:number,to:number)=>number):LayoutChoice {
  const delta=at-l.s!;
  return {...l,s:at,sources:l.sources?Object.fromEntries(Object.entries(l.sources).map(([key,ref])=>[key,{...ref,s:key==='a'&&l.screenLoop?l.screenLoop.s+((ref.s-l.screenLoop.s+delta)%(l.screenLoop.e-l.screenLoop.s)+(l.screenLoop.e-l.screenLoop.s))%(l.screenLoop.e-l.screenLoop.s):advance?advance(ref,l.s!,at):ref.s+delta}])):undefined};
}
