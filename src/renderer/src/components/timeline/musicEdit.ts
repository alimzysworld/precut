import type { CutVersion } from '../../../../shared/schema';
export type MusicChoice=NonNullable<CutVersion['music']>;
export function musicGesture(base:MusicChoice,mode:'start'|'end'|'slip',delta:number,duration:number,sourceDuration:number,bars:number[],snap=true):MusicChoice {
  const nearest=(at:number,low:number,high:number)=>{
    const target=Math.max(low,Math.min(high,at));
    const candidates=bars.filter(t=>Number.isFinite(t)&&t>=low&&t<=high);
    return snap && candidates.length ? candidates.reduce((best,t)=>Math.abs(t-target)<Math.abs(best-target)?t:best,candidates[0]) : target;
  };
  const end=Math.min(duration,base.endS ?? duration);
  if(mode==='end')return {...base,endS:nearest(end+delta,.1,duration),fit:false,followStory:false};
  return {...base,startS:nearest(base.startS+delta,0,Math.max(0,sourceDuration-.1)),fit:false,followStory:false};
}
