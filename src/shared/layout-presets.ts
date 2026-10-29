import type { CutVersion, LayoutChoice, Shoot } from './schema';
import { clipDimensions } from './media';
export type Box = { x: number; y: number; w: number; h: number; circle?: boolean };
export type LayoutBoxes = { a?: Box; b?: Box };
export type LayoutBackground = { kind: 'screen' | 'gradient' | 'image' | 'colour'; blur?: number; dim?: number; colour?: string; stops?: string[]; angle?: number; image?: string; fromClip?: boolean };
export const LAYOUTS = [
  ['screen-camera', 'Screen + camera', 'Screen'], ['camera-screen', 'Camera + screen', 'Screen'],
  ['side-by-side', 'Side by side', 'Screen'], ['screen-bubble', 'Screen + bubble', 'Screen'],
  ['bubble-left', 'Bubble left', 'Screen'], ['bubble-top', 'Bubble top', 'Screen'], ['screen-only', 'Screen only', 'Screen'],
  ['phone-only', 'Phone only', 'Phone'], ['phone-camera', 'Phone + camera', 'Phone'], ['phone-bubble', 'Phone + bubble', 'Phone'],
  ['phone-over-camera', 'Phone over camera', 'Phone'], ['camera-only', 'Camera only', 'Camera'],
  ['clip-over-camera', 'Clip over camera', 'Clip on clip'], ['camera-over-clip', 'Camera over clip', 'Clip on clip'],
] as const;
export type LayoutId = typeof LAYOUTS[number][0];
export function isLayoutCamera(scene:LayoutChoice,slot:'a'|'b'|undefined){return slot===(scene.swap?'a':'b');}
export const LAYOUT_TRANSITION_S = .48;
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export function cleanBox(b: Box): Box {
  if (!b || ![b.x,b.y,b.w,b.h].every(Number.isFinite)) throw new Error('Choose a valid picture position.');
  const w=clamp(b.w,.04,1),h=clamp(b.h,.04,1);
  return { x:clamp(b.x,0,1-w),y:clamp(b.y,0,1-h),w,h,...(b.circle?{circle:true}:{}) };
}
/** Normalized destination boxes. Square and portrait stack the two columns. */
export function layoutGeometry(id: LayoutId, width: number, height: number, padding = .04, phoneAspect = 9/19.5): LayoutBoxes {
  const p=clamp(padding,0,.12), py=p*width/height, gap=p/2, gy=gap*width/height;
  const full={x:p,y:py,w:1-2*p,h:Math.max(.04,1-2*py)}, ar=width/height;
  const fit=(r:Box,aspect:number):Box=>{const w=Math.min(r.w,r.h*aspect/ar),h=w*ar/aspect;return {x:r.x+(r.w-w)/2,y:r.y+(r.h-h)/2,w,h};};
  const phone=(r:Box)=>fit(r,phoneAspect);
  const circle=(x:number,y:number,w=.22):Box=>({x,y,w,h:w*ar,circle:true});
  const inset={x:.67,y:.64,w:.27,h:.29};
  let boxes:LayoutBoxes;
  switch(id){
    case 'screen-only':boxes={a:full};break;
    case 'camera-only':boxes={b:full};break;
    case 'phone-only':boxes={a:phone(full)};break;
    case 'side-by-side':case 'screen-camera':case 'camera-screen':case 'phone-camera':{
      const equal=id==='side-by-side', first=id==='camera-screen'?.36:equal?.5:.64;
      boxes=width>height ? {a:{x:p,y:py,w:(full.w-gap)*first,h:full.h},b:{x:p+(full.w-gap)*first+gap,y:py,w:(full.w-gap)*(1-first),h:full.h}}
        : {a:{x:p,y:py,w:full.w,h:(full.h-gy)*.58},b:{x:p,y:py+(full.h-gy)*.58+gy,w:full.w,h:(full.h-gy)*.42}};
      if(id==='camera-screen') [boxes.a,boxes.b]=[boxes.b,boxes.a];
      if(id==='phone-camera')boxes.a=phone(boxes.a!);
      break;
    }
    case 'phone-over-camera':boxes={a:phone({x:.64,y:.12,w:.3,h:.76}),b:{x:0,y:0,w:1,h:1}};break;
    case 'clip-over-camera':boxes={a:inset,b:{x:0,y:0,w:1,h:1}};break;
    case 'camera-over-clip':boxes={a:full,b:inset};break;
    default:{
      const w=Math.min(.23, .3/ar),h=w*ar;
      const b=circle(id==='bubble-left'?p:1-p-w,id==='bubble-top'?py:1-py-h,w);
      boxes={a:id==='phone-bubble'?phone(full):full,b};break;
    }
  }
  return boxes;
}
export function sceneBoxes(layout: LayoutChoice, w:number,h:number,phoneAspect?:number):LayoutBoxes {
  const base=layoutGeometry(layout.id ?? legacyId(layout),w,h,layout.padding ?? .04,phoneAspect);
  return {...base,...layout.boxes};
}
export function legacyId(l:LayoutChoice):LayoutId {
  return l.id ?? (l.kind==='screen'?'screen-only':l.kind==='split'?'side-by-side':l.kind==='bubble'?'screen-bubble':'camera-only');
}
/** Read projection: never rewrites history or drops title/placeholder information. */
export function migrateLayouts(version: Pick<CutVersion,'layouts'|'pieces'|'lengthS'>,aspect=16/9):LayoutChoice[] {
  return (version.layouts ?? []).flatMap((l,i)=>{
    if(!l)return [];
    if(l.kind==='scene')return [{...l}];
    const piece=version.pieces?.[i];if(!piece)return [];
    let boxes:LayoutBoxes|undefined;
    if(l.kind==='bubble'){
      const size=l.bubble?.size??.3,corner=l.bubble?.corner??'br',margin=.025;
      boxes={a:{x:0,y:0,w:1,h:1},b:{x:corner.endsWith('l')?margin:1-margin-size,y:corner.startsWith('t')?margin*aspect:1-(margin+size)*aspect,w:size,h:size*aspect,circle:true}};
    }else if(l.kind==='split')boxes=aspect>=1?{b:{x:0,y:0,w:.5,h:1},a:{x:.5,y:0,w:.5,h:1}}:{b:{x:0,y:0,w:1,h:.5},a:{x:0,y:.5,w:1,h:.5}};
    return [{...l,id:legacyId(l),padding:0,radius:0,transition:'cut',boxes,s:piece.timelineS ?? version.pieces!.slice(0,i).reduce((n,p)=>n+p.lengthS,0),e:(piece.timelineS ?? version.pieces!.slice(0,i).reduce((n,p)=>n+p.lengthS,0))+piece.lengthS,
      sources:{...(l.screen?{a:l.screen}:{}),...(piece.clipId?{b:{clipId:piece.clipId,s:piece.s}}:{})}}];
  });
}
export function layoutAt(layouts:LayoutChoice[],t:number):LayoutChoice|undefined {
  return [...layouts].reverse().find(l=>l.s!==undefined && l.e!==undefined && t>=l.s && t<l.e);
}
/** Piece titles/placeholders share the collection without truncating timed scenes. */
export function withPieceLayout(layouts:(LayoutChoice|null)[]|undefined,count:number,index:number,value:LayoutChoice|null){
  return [...Array.from({length:count},(_,i)=>i===index?value:layouts?.[i]?.kind==='scene'?null:layouts?.[i]??null),...(layouts??[]).filter(l=>l?.kind==='scene')];
}
export function sourceStart(shoot:Shoot,version:Pick<CutVersion,'pieces'>,clipId:string,at:number,preferred=0,clock?:{layoutClock?:import('./schema').DraftTimeline['layoutClock'];pieces:(Pick<import('./schema').DraftPiece,'clipId'|'startS'|'endS'|'inS'|'timeMap'> & {layer?:number;layoutScene?:LayoutChoice;layoutSlot?:'a'|'b';layoutDeparting?:boolean})[]}):number {
  const piece=version.pieces?.find(p=>at>=(p.timelineS ?? 0)&&at<(p.timelineS ?? 0)+p.lengthS) ?? version.pieces?.[0];
  const visible=clock?.pieces.filter(p=>at>=p.startS&&at<p.endS),picture=clock?.layoutClock?.find(p=>at>=p.startS&&at<p.endS)??visible?.find(p=>p.layoutScene?isLayoutCamera(p.layoutScene,p.layoutSlot)&&!p.layoutDeparting:(p.layer??0)===0),base=picture?.clipId??piece?.clipId;
  let time=piece?piece.s+at-(piece.timelineS??0):preferred;
  if(picture){time=picture.inS+at-picture.startS;const keys=picture.timeMap;if(keys?.length){const right=keys.findIndex(k=>k.t>=at);if(right<=0)time=keys[right<0?keys.length-1:0].s;else {const a=keys[right-1],b=keys[right];time=a.s+(b.s-a.s)*(at-a.t)/(b.t-a.t||1);}}}
  if(base===clipId)return time;
  const group=shoot.angles?.find(g=>g.clips.some(c=>c.clipId===clipId)&&g.clips.some(c=>c.clipId===base));
  if(group&&base)return time+group.clips.find(c=>c.clipId===base)!.offsetS-group.clips.find(c=>c.clipId===clipId)!.offsetS;
  return preferred;
}
export function phoneRatio(shoot:Shoot,l:LayoutChoice):number|undefined {
  const clip=shoot.clips.find(c=>c.id===l.sources?.a?.clipId);if(!clip?.meta)return;
  const d=clipDimensions(clip);return d.width/d.height;
}
export function mixBoxes(a:LayoutBoxes,b:LayoutBoxes,u:number):LayoutBoxes {
  const out:LayoutBoxes={};for(const key of ['a','b'] as const){const next=b[key];if(!next)continue;const before=a[key]??next;
    out[key]={...next,x:before.x+(next.x-before.x)*u,y:before.y+(next.y-before.y)*u,w:before.w+(next.w-before.w)*u,h:before.h+(next.h-before.h)*u};}
  return out;
}
/** Material emphasized decelerate: solve x before evaluating y. */
export function layoutEase(progress:number):number {
  const x=clamp(progress,0,1);let lo=0,hi=1;
  const cubic=(t:number,a:number,b:number)=>3*(1-t)*(1-t)*t*a+3*(1-t)*t*t*b+t*t*t;
  for(let n=0;n<24;n++){const t=(lo+hi)/2;if(cubic(t,.05,.1)<x)lo=t;else hi=t;}
  return x===0?0:x===1?1:cubic((lo+hi)/2,.7,1);
}
const sourceSlot=(l:LayoutChoice,key:'a'|'b')=>l.swap?(key==='a'?'b':'a'):key;
export type LayoutMorphPicture={slot:'a'|'b';sourceSlot:'a'|'b';sourceScene:LayoutChoice;box:Box;radius:number;opacity:number;bubble:number;departing:boolean};
/** Match the actual recording across swaps and slot changes, never dissolve whole scenes. */
export function layoutMorph(l:LayoutChoice,previous:LayoutChoice|undefined,t:number,w:number,h:number,aspect?:number,previousAspect=aspect):LayoutMorphPicture[]{
  const target=sceneBoxes(l,w,h,aspect),before=previous?sceneBoxes(previous,w,h,previousAspect):{};
  const active=!!previous&&l.transition!=='cut'&&l.s!==undefined&&t<=l.s+LAYOUT_TRANSITION_S;
  const u=active?layoutEase((t-l.s!)/LAYOUT_TRANSITION_S):1,used=new Set<string>();
  const radius=(scene:LayoutChoice,box:Box)=>box.circle?Math.min(box.w*w,box.h*h)/2:scene.radius??16;
  const shrink=(box:Box):Box=>({...box,x:box.x+box.w*.03,y:box.y+box.h*.03,w:box.w*.94,h:box.h*.94});
  const interpolate=(a:Box,b:Box):Box=>({...b,circle:!!a.circle&&!!b.circle,x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u,w:a.w+(b.w-a.w)*u,h:a.h+(b.h-a.h)*u});
  const out:LayoutMorphPicture[]=[];
  const order=l.id==='phone-over-camera'||l.id==='clip-over-camera'?['b','a'] as const:['a','b'] as const;
  for(const slot of order){
    const box=target[slot];if(!box)continue;
    const source=sourceSlot(l,slot),ref=l.sources?.[source];
    // Auto ranges follow the edited camera, including cuts within a range.
    // Both layouts therefore share that clock even if their opening clip ids differ.
    const match=previous?(['a','b'] as const).find(key=>before[key]&&!used.has(key)&&
      (l.followCamera&&previous.followCamera&&source==='b'&&sourceSlot(previous,key)==='b'||(ref?previous.sources?.[sourceSlot(previous,key)]?.clipId===ref.clipId:key===slot))):undefined;
    if(match)used.add(match);
    const old=match?before[match]!:shrink(box),r=radius(l,box),oldR=match?radius(previous!,old):r*.94;
    out.push({slot,sourceSlot:source,sourceScene:l,box:active?interpolate(old,box):box,radius:active?oldR+(r-oldR)*u:r,opacity:active&&!match?u:1,bubble:active?Number(!!old.circle)+(Number(!!box.circle)-Number(!!old.circle))*u:Number(!!box.circle),departing:false});
  }
  if(active&&previous)for(const slot of ['a','b'] as const){
    const box=before[slot],source=sourceSlot(previous,slot);if(!box||used.has(slot)||!previous.sources?.[source])continue;
    out.push({slot,sourceSlot:source,sourceScene:previous,box:interpolate(box,shrink(box)),radius:radius(previous,box)*(1-.06*u),opacity:1-u,bubble:Number(!!box.circle),departing:true});
  }
  return out;
}
export function boxesAt(l:LayoutChoice,previous:LayoutChoice|undefined,t:number,w:number,h:number,aspect?:number):LayoutBoxes {
  return Object.fromEntries(layoutMorph(l,previous,t,w,h,aspect).filter(p=>!p.departing).map(p=>[p.slot,p.box]));
}
export type LayoutSourceAdvance=(ref:{clipId:string;s:number},from:number,to:number)=>number;
function rangeSource(l:LayoutChoice,key:string,ref:{clipId:string;s:number},at:number,advance?:LayoutSourceAdvance){
  const loop=key==='a'?l.screenLoop:undefined;
  if(loop){const n=loop.e-loop.s;return loop.s+((ref.s-loop.s+at-l.s!)%n+n)%n;}
  return advance?advance(ref,l.s!,at):ref.s+at-l.s!;
}
export function replaceLayoutRange(layouts:(LayoutChoice|null)[],s:number,e:number,next:LayoutChoice|null,advance?:LayoutSourceAdvance):(LayoutChoice|null)[] {
  const out=layouts.flatMap(l=>{
    if(!l||l.kind!=='scene'||l.s===undefined||l.e===undefined||l.e<=s||l.s>=e)return [l];
    const shift=(at:number):LayoutChoice=>({...l,s:at,sources:l.sources?Object.fromEntries(Object.entries(l.sources).map(([k,v])=>[k,{...v,s:rangeSource(l,k,v,at,advance)}])):undefined});
    return [...(l.s<s?[{...l,e:s}]:[]),...(l.e>e?[{...shift(e),e:l.e}]:[])];
  });
  if(next)out.push({...next,kind:'scene',s,e});
  return out;
}
/** Magnetic edits keep range decoration attached to the retained picture spans. */
export function remapLayoutRanges(layouts:(LayoutChoice|null)[]|undefined,mapping:{oldS:number;oldE:number;s:number;e:number}[],advance?:LayoutSourceAdvance):LayoutChoice[]{
  return (layouts??[]).flatMap(l=>{
    if(l?.kind!=='scene'||l.s===undefined||l.e===undefined)return [];
    return mapping.flatMap(m=>{
      const a=Math.max(l.s!,m.oldS),b=Math.min(l.e!,m.oldE);if(b<=a||m.oldE<=m.oldS)return [];
      const scale=(m.e-m.s)/(m.oldE-m.oldS);
      return [{...l,s:m.s+(a-m.oldS)*scale,e:m.s+(b-m.oldS)*scale,sources:l.sources?Object.fromEntries(Object.entries(l.sources).map(([k,v])=>[k,{...v,s:rangeSource(l,k,v,a,advance)}])):undefined}];
    });
  });
}
