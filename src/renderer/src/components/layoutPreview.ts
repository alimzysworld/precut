import type { DraftTimeline, LayoutChoice } from '../../../shared/schema';
import type { LayoutPicture, Rect } from '../../../main/layout-math';
import { sceneBoxes, type Box } from '../../../shared/layout-presets';
const previews=new Map<string,LayoutChoice>();
type Session={enabled:boolean;busy:boolean;edit:(edit:import('../../../shared/schema').CutEdit)=>unknown};
const exactSessions=new WeakMap<DraftTimeline,Session>(),retainedSessions=new Map<string,{timeline:DraftTimeline;session:Session}>(),identities=new WeakMap<DraftTimeline,string>();
const pictureKey=(p:LayoutPicture)=>JSON.stringify([p.proxy?.split('/proxies/')[0],p.piece,p.startS,p.endS,p.layoutSlot,p.layoutScene]);
function timelineKey(timeline:DraftTimeline){let key=identities.get(timeline);if(!key){key=JSON.stringify([timeline.width,timeline.height,timeline.durationS,timeline.pieces.map(pictureKey)]);identities.set(timeline,key);}return key;}
/** Prepared player copies and waveform-only updates keep the same edit session. */
export const layoutSessions={
  set(timeline:DraftTimeline,session:Session){exactSessions.set(timeline,session);retainedSessions.set(timelineKey(timeline),{timeline,session});},
  get(timeline:DraftTimeline){return exactSessions.get(timeline)??retainedSessions.get(timelineKey(timeline))?.session;},
  delete(timeline:DraftTimeline){exactSessions.delete(timeline);const key=timelineKey(timeline);if(retainedSessions.get(key)?.timeline===timeline)retainedSessions.delete(key);},
};
export function previewLayout(timeline:DraftTimeline|undefined|null,layout:LayoutChoice|null){
  if(!timeline)return;
  // A half-typed hex stays in the field while the viewer holds its last valid colour.
  if(layout?.background?.kind==='colour'&&!/^#[0-9a-f]{6}$/i.test(layout.background.colour??''))return;
  for(const p of timeline.pieces as LayoutPicture[])if(p.layoutScene&&(!layout||p.layoutScene.s===layout.s&&p.layoutScene.e===layout.e)){if(layout)previews.set(pictureKey(p),layout);else previews.delete(pictureKey(p));}
  if(typeof document!=='undefined')document.querySelectorAll('[data-live-player]').forEach(view=>view.dispatchEvent(new Event('precut:layout-preview')));
}
export function visualLayout(p:LayoutPicture,time:number,w:number,h:number):{region?:Rect;circle:boolean;radius:number;opacity:number;background:LayoutChoice['background'];image?:string;preview:boolean;visible:boolean;order:number}{
  const candidate=previews.get(pictureKey(p));
  const compatible=candidate&&!(candidate.background?.kind==='image'&&candidate.background.image!==p.layoutScene?.background?.image)&&(['a','b'] as const).every(key=>!candidate.sources?.[key]||candidate.sources[key]?.clipId===p.layoutScene?.sources?.[key]?.clipId&&candidate.sources[key]?.s===p.layoutScene?.sources?.[key]?.s);
  const next=compatible&&!p.layoutDeparting?candidate:undefined;
  const boxes=next?sceneBoxes(next,w,h,p.layoutPhoneAspect):undefined;
  const order=next?.id==='phone-over-camera'||next?.id==='clip-over-camera'?['b','a']:['a','b'];
  const first=order.find(slot=>boxes?.[slot as 'a'|'b']);
  let region=p.layoutRegion;
  if(next&&p.layoutSlot)region=boxes?.[p.layoutSlot];
  else if(p.layoutRegionKeys?.length){
    const keys=p.layoutRegionKeys,right=keys.findIndex(k=>k.t>=time);
    if(right<=0)region=keys[right<0?keys.length-1:0];else {const a=keys[right-1],b=keys[right],u=(time-a.t)/(b.t-a.t||1);region={x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u,w:a.w+(b.w-a.w)*u,h:a.h+(b.h-a.h)*u};}
  }
  let radius=p.layoutRadius??0,opacity=1;
  if(p.layoutShapeKeys?.length){const keys=p.layoutShapeKeys,right=keys.findIndex(k=>k.t>=time);if(right<=0){const k=keys[right<0?keys.length-1:0];radius=k.radius;opacity=k.opacity;}else{const a=keys[right-1],b=keys[right],u=(time-a.t)/(b.t-a.t||1);radius=a.radius+(b.radius-a.radius)*u;opacity=a.opacity+(b.opacity-a.opacity)*u;}}
  return {region,circle:next?!!(region as Box|undefined)?.circle:!p.layoutShapeKeys&&!!p.layoutCircle,radius:next?.radius??radius,opacity:next?((next.swap?p.layoutSlot==='b':p.layoutSlot==='a')?next.opacity??1:1):opacity,background:next?(first===p.layoutSlot?next.background:undefined):p.layoutBackground,image:p.layoutImage,preview:!!next,visible:(!next||!!region)&&!(candidate&&p.layoutDeparting),order:next&&p.layoutSlot?order.indexOf(p.layoutSlot):p.layer};
}
/** Pointer math shared by the viewer and performance checks. */
export function dragBox(box:Box,dx:number,dy:number,corner?:string,aspect=1):Box {
  if(!corner)return {...box,x:Math.max(0,Math.min(1-box.w,box.x+dx)),y:Math.max(0,Math.min(1-box.h,box.y+dy))};
  const left=corner.includes('l'),top=corner.includes('t');
  let w=Math.max(.04,Math.min(left?box.x+box.w:1-box.x,box.w+(left?-dx:dx)));
  let h=Math.max(.04,Math.min(top?box.y+box.h:1-box.y,box.h+(top?-dy:dy)));
  if(box.circle){w=Math.max(.04,.04/aspect,Math.min(w,h/aspect));h=w*aspect;}
  return {...box,x:left?box.x+box.w-w:box.x,y:top?box.y+box.h-h:box.y,w,h};
}

/** V37 pointer capture recipe, shared by layout and clip transform handles. */
export function viewerGesture(event:{clientX:number;clientY:number;pointerId:number;preventDefault:()=>void;stopPropagation:()=>void;currentTarget:{setPointerCapture:(id:number)=>void}},host:HTMLElement,pause:()=>void){
  event.preventDefault();event.stopPropagation();pause();
  const r=host.getBoundingClientRect();event.currentTarget.setPointerCapture(event.pointerId);
  return {pointer:event.pointerId,x:event.clientX,y:event.clientY,w:r.width,h:r.height,left:r.left,top:r.top};
}
