import type { CutVersion, DraftPiece, DraftTimeline } from '../../../../shared/schema';

/** Remove document holes from available media immediately. No decoder, renderer
 * or IPC call is needed; the confirmed frame-snapped plan replaces this preview. */
export function transcriptTimeline(timeline: DraftTimeline, version: CutVersion): DraftTimeline {
  const holes: { s: number; e: number }[] = [];
  for (const picture of timeline.pieces.filter(p => p.layer === 0)) {
    const piece = version.pieces?.[picture.piece ?? -1];
    if (!piece?.removed?.length) continue;
    const keys = picture.timeMap ?? [{t:picture.startS,s:picture.inS},{t:picture.endS,s:picture.inS+picture.endS-picture.startS}];
    const time = (s: number) => {
      for (let i=1;i<keys.length;i++) if (s >= Math.min(keys[i-1].s,keys[i].s) && s <= Math.max(keys[i-1].s,keys[i].s)) {
        const a=keys[i-1],b=keys[i]; return a.t+(b.t-a.t)*(s-a.s)/(b.s-a.s || 1);
      }
      return Math.abs(s-keys[0].s) <= Math.abs(s-keys.at(-1)!.s) ? picture.startS : picture.endS;
    };
    for (const gap of piece.removed.flatMap(g => (g as typeof g & {ranges?:{s:number;e:number}[]}).ranges ?? [g])) {
      const a=time(gap.s), b=time(gap.e);
      const s=Math.max(picture.startS,Math.min(a,b)),e=Math.min(picture.endS,Math.max(a,b));
      if(e>s)holes.push({s,e});
    }
  }
  const merged: typeof holes = [];
  for(const gap of holes.sort((a,b)=>a.s-b.s)) { const last=merged.at(-1);if(last && gap.s<=last.e)last.e=Math.max(last.e,gap.e);else merged.push({...gap}); }
  const map = (t:number) => t-merged.reduce((n,h)=>n+Math.max(0,Math.min(t,h.e)-h.s),0);
  const spans = (s:number,e:number) => {
    const kept:{s:number;e:number}[]=[];let at=s;
    for(const gap of merged){if(gap.s>at)kept.push({s:at,e:Math.min(gap.s,e)});at=Math.max(at,gap.e);if(at>=e)break;}
    if(at<e)kept.push({s:at,e});return kept.filter(p=>p.e>p.s);
  };
  const sample=(keys:{t:number;s:number}[],t:number)=>{for(let i=1;i<keys.length;i++)if(t<=keys[i].t){const a=keys[i-1],b=keys[i];return a.s+(b.s-a.s)*(t-a.t)/(b.t-a.t||1);}return keys.at(-1)!.s;};
  const pictures=timeline.pieces.flatMap(p=>spans(p.startS,p.endS).map(span=>{
    const keys=p.timeMap ?? [{t:p.startS,s:p.inS},{t:p.endS,s:p.inS+p.endS-p.startS}];
    return {...p,startS:map(span.s),endS:map(span.e),inS:sample(keys,span.s),timeMap:[{t:map(span.s),s:sample(keys,span.s)},...keys.filter(k=>k.t>span.s && k.t<span.e).map(k=>({...k,t:map(k.t)})),{t:map(span.e),s:sample(keys,span.e)}],frame:p.frame?.map(k=>({...k,t:map(k.t)})) ?? null} as DraftPiece;
  }));
  const durationS=map(timeline.durationS);
  type Sound={durationS:number;pieces:{startS:number;endS:number;timeMap:{t:number;s:number}[]}[]};
  const live=(timeline as DraftTimeline & {liveSound?:Sound}).liveSound;
  const liveSound=live ? {...live,durationS,pieces:live.pieces.flatMap(p=>spans(p.startS,p.endS).map(span=>({...p,startS:map(span.s),endS:map(span.e),timeMap:[{t:map(span.s),s:sample(p.timeMap,span.s)},...p.timeMap.filter(k=>k.t>span.s && k.t<span.e).map(k=>({...k,t:map(k.t)})),{t:map(span.e),s:sample(p.timeMap,span.e)}]})))} : undefined;
  return {...timeline,durationS,pieces:pictures,...(liveSound?{liveSound}:{}),titles:version.titles ?? (timeline.titles ? {...timeline.titles,cues:timeline.titles.cues.flatMap(c=>spans(c.s,c.e).map(span=>({...c,s:map(span.s),e:map(span.e)})))} : null)};
}
