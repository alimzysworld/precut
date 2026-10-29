// One geometry recipe for the live GPU and the finishing compositor.
import { LAYOUT_TRANSITION_S } from '../shared/layout-presets';
import type { Clip, DraftPiece, LayoutChoice, SubjectSample } from '../shared/schema';

export type Rect = { x: number; y: number; w: number; h: number };
export type LayoutPicture = DraftPiece & { layoutRegion?: Rect; layoutCircle?: boolean; layoutDim?: boolean; layoutColour?: string; layoutScreen?: boolean;
  layoutRadius?: number; layoutReferenceWidth?: number; layoutPhoneAspect?: number; layoutRegionKeys?: (Rect & {t:number})[]; layoutSlot?: 'a'|'b'; layoutScene?: LayoutChoice;
  layoutShapeKeys?: {t:number;radius:number;opacity:number}[]; layoutDeparting?: boolean;
  layoutRaster?: {w:number;h:number;cropped?:boolean}; // export-only, fixed-size graded morph raster
  layoutBackground?: import('../shared/layout-presets').LayoutBackground; layoutImage?: string };
export const TITLE_CARD_BASE = '#15141a';
export function titleCardColour(accent = '#7672ee'): string {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) accent = '#7672ee';
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(TITLE_CARD_BASE.slice(i, i + 2), 16) * .95 + parseInt(accent.slice(i, i + 2), 16) * .05).toString(16).padStart(2, '0')).join('');
}
export const fullRegion: Rect = { x: 0, y: 0, w: 1, h: 1 };
/** Adjacent layout spans on the same 1x source clock can share one decode. */
export function layoutDecodeGroups(pictures:LayoutPicture[]){
  const buckets=new Map<string,{clipId:string;offset:number;s:number;e:number}[]>();
  for(const p of pictures){
    if(!p.layoutScene||p.timeMap?.some((k,i,a)=>i>0&&Math.abs((k.s-a[i-1].s)-(k.t-a[i-1].t))>1e-6))continue;
    const offset=p.inS-p.startS,key=JSON.stringify([p.clipId,Number(offset.toFixed(6))]),span={clipId:p.clipId,offset,s:p.inS,e:p.inS+p.endS-p.startS};
    buckets.set(key,[...buckets.get(key)??[],span]);
  }
  return [...buckets.values()].flatMap(spans=>{
    const out:typeof spans=[];for(const span of spans.sort((a,b)=>a.s-b.s)){const last=out.at(-1);if(last&&span.s<=last.e+1e-6)last.e=Math.max(last.e,span.e);else out.push({...span});}return out;
  });
}
export { isScreenClip } from '../shared/screen';
export function layoutRegions(layout: LayoutChoice, width: number, height: number): { face?: Rect; screen?: Rect; circle?: boolean } {
  if (layout.kind === 'screen') return { screen: fullRegion };
  if (layout.kind === 'split') return width >= height
    ? { face: { x: 0, y: 0, w: .5, h: 1 }, screen: { x: .5, y: 0, w: .5, h: 1 } }
    : { face: { x: 0, y: 0, w: 1, h: .5 }, screen: { x: 0, y: .5, w: 1, h: .5 } };
  if (layout.kind === 'bubble') {
    const size = layout.bubble?.size ?? .3, h = size * width / height, corner = layout.bubble?.corner ?? 'br';
    const margin = .025, my = margin * width / height;
    return { screen: fullRegion, circle: true, face: { x: corner.endsWith('l') ? margin : 1 - margin - size,
      y: corner.startsWith('t') ? my : 1 - my - h, w: size, h } };
  }
  return { face: fullRegion };
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export function layoutFaceAt(clip: Clip, time: number): SubjectSample | undefined {
  const samples = (clip.subject?.samples ?? []).filter(p => p.kind === 'face' && [p.t,p.x,p.y,p.w,p.h].every(Number.isFinite) && p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1 && p.w>0 && p.h>0).sort((a,b) => a.t-b.t);
  const right = samples.findIndex(p => p.t >= time);
  if (right === 0) return samples[0];
  if (right < 0) return samples.at(-1);
  const a = samples[right - 1], b = samples[right], t = (time - a.t) / (b.t - a.t || 1);
  return { ...a, x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t, w: a.w+(b.w-a.w)*t, h: a.h+(b.h-a.h)*t };
}
export function layoutCrop(clip: Clip, time: number, aspect: number, bubble: boolean | number = false): Rect {
  const meta = clip.meta!, sourceAspect = meta.width / meta.height, face = layoutFaceAt(clip, time);
  let h = Math.min(1, sourceAspect / aspect), w = h * aspect / sourceAspect;
  if (bubble && face) {
    h += (Math.min(h, Math.max(face.h * 2.8, face.w * sourceAspect * 2.8))-h)*Number(bubble); w = h * aspect / sourceAspect;
  }
  return { x: clamp((face?.x ?? .5)-w/2, 0, 1-w), y: clamp((face?.y ?? .5)-h/2, 0, 1-h), w, h };
}
export function layoutSourceTime(piece: DraftPiece, time: number): number {
  const map = piece.timeMap;
  if (!map?.length) return piece.inS + time - piece.startS;
  const right = map.findIndex(p => p.t >= time);
  if (right === 0) return map[0].s;
  if (right < 0) return map.at(-1)!.s;
  const a = map[right-1], b = map[right], t = (time-a.t)/(b.t-a.t || 1);
  return a.s+(b.s-a.s)*t;
}
export function layoutFrames(piece: DraftPiece, clip: Clip, region: Rect, width: number, height: number, fps: number, bubble: boolean, reverse = false): NonNullable<DraftPiece['frame']> {
  const length = piece.endS-piece.startS, frames = Math.ceil(length*fps);
  return Array.from({ length: frames+1 }, (_, n) => {
    const t = Math.min(piece.endS, piece.startS+n/fps);
    const source = layoutSourceTime(piece,t), first = piece.timeMap?.[0]?.s ?? piece.inS, end = piece.timeMap?.at(-1)?.s ?? piece.inS+length;
    return { t, ...layoutCrop(clip, reverse ? Math.max(first,end-1/fps-(source-first)) : source, region.w*width/(region.h*height), bubble) };
  });
}
/** Export only: bake the short moving part, then use a static crop/mask for the hold. */
export function splitLayoutTransitions(pictures:LayoutPicture[]):LayoutPicture[]{
  const sample=(keys:(Rect&{t:number})[],time:number):Rect&{t:number}=>{
    const right=keys.findIndex(k=>k.t>=time);if(right<=0)return {...keys[right<0?keys.length-1:0],t:time};
    const a=keys[right-1],b=keys[right],u=(time-a.t)/(b.t-a.t||1);return {t:time,x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u,w:a.w+(b.w-a.w)*u,h:a.h+(b.h-a.h)*u};
  };
  const shape=(keys:NonNullable<LayoutPicture['layoutShapeKeys']>,t:number)=>{
    const right=keys.findIndex(k=>k.t>=t);if(right<=0)return {...keys[right<0?keys.length-1:0],t};
    const a=keys[right-1],b=keys[right],u=(t-a.t)/(b.t-a.t||1);return {t,radius:a.radius+(b.radius-a.radius)*u,opacity:a.opacity+(b.opacity-a.opacity)*u};
  };
  return pictures.flatMap(p=>{
    const moving=p.layoutRegionKeys?.some(k=>['x','y','w','h'].some(key=>Math.abs(k[key as 'x']-p.layoutRegionKeys![0][key as 'x'])>1e-7))||p.layoutShapeKeys?.some(k=>Math.abs(k.radius-p.layoutShapeKeys![0].radius)>1e-7||Math.abs(k.opacity-p.layoutShapeKeys![0].opacity)>1e-7);
    if(!moving)return [p];
    const end=p.layoutScene?.s===undefined?0:p.layoutScene.s+LAYOUT_TRANSITION_S;
    if(end<=p.startS+1e-7||end>=p.endS-1e-7)return [p];
    const part=(s:number,e:number):LayoutPicture=>({...p,startS:s,endS:e,inS:layoutSourceTime(p,s),timeMap:p.timeMap?[{t:s,s:layoutSourceTime(p,s)},...p.timeMap.filter(k=>k.t>s&&k.t<e),{t:e,s:layoutSourceTime(p,e)}]:undefined,
      frame:p.frame?.length?[sample(p.frame,s),...p.frame.filter(k=>k.t>s&&k.t<e),sample(p.frame,e)]:p.frame,
      layoutShapeKeys:p.layoutShapeKeys?.length?[shape(p.layoutShapeKeys,s),...p.layoutShapeKeys.filter(k=>k.t>s&&k.t<e),shape(p.layoutShapeKeys,e)]:undefined,
      layoutRegionKeys:p.layoutRegionKeys?.length?[sample(p.layoutRegionKeys,s),...p.layoutRegionKeys.filter(k=>k.t>s&&k.t<e),sample(p.layoutRegionKeys,e)]:undefined});
    return [part(p.startS,end),part(end,p.endS)];
  });
}
