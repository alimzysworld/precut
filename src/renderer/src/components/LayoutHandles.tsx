import { TransformHandles } from './TransformHandles';
import { transformSessions } from './transformPreview';
import {useEffect,useRef,useState,type PointerEvent} from 'react';
import type {DraftTimeline,LayoutChoice} from '../../../shared/schema';
import type {LayoutPicture} from '../../../main/layout-math';
import {sceneBoxes,type LayoutBoxes,type Box} from '../../../shared/layout-presets';
import {dragBox,layoutSessions,previewLayout,visualLayout,viewerGesture} from './layoutPreview';
import {InlineError} from './ui';
export function LayoutHandles({timeline,time,pause}:{timeline:DraftTimeline;time:number;pause:()=>void}){
  const [,refresh]=useState(0);
  useEffect(()=>{const change=()=>refresh(n=>n+1);document.addEventListener('precut:layout-session',change);return()=>document.removeEventListener('precut:layout-session',change);},[]);
  const host=useRef<HTMLDivElement>(null),drag=useRef<{pointer:number;x:number;y:number;w:number;h:number;box:Box;slot:'a'|'b';corner?:string;layout:LayoutChoice;boxes:LayoutBoxes}|null>(null);
  const next=useRef<LayoutChoice|null>(null),[error,setError]=useState<string|null>(null);
  const session=layoutSessions.get(timeline),p=(timeline.pieces as LayoutPicture[]).find(p=>p.layoutScene&&p.startS<=time&&p.endS>time);
  if(transformSessions.get(timeline))return <TransformHandles timeline={timeline} time={time} pause={pause}/>;
  if(!session?.enabled||!p?.layoutScene)return null;
  const layout=p.layoutScene,boxes=sceneBoxes(layout,timeline.width,timeline.height,p.layoutPhoneAspect);
  function start(event:PointerEvent<HTMLButtonElement>,slot:'a'|'b',corner?:string){
    if(session!.busy||!host.current)return;
    const gesture=viewerGesture(event,host.current,pause);setError(null);
    const current=visualLayout((timeline.pieces as LayoutPicture[]).find(p=>p.layoutScene?.s===layout.s&&p.layoutScene?.e===layout.e&&p.layoutSlot===slot&&p.startS<=time&&p.endS>time)!,time,timeline.width,timeline.height).region as Box;
    const box={...current,circle:boxes[slot]?.circle};
    drag.current={...gesture,box,slot,corner,layout,boxes};next.current=null;
  }
  function move(event:PointerEvent<HTMLButtonElement>){
    const d=drag.current;if(!d||d.pointer!==event.pointerId)return;
    const box=dragBox(d.box,(event.clientX-d.x)/d.w,(event.clientY-d.y)/d.h,d.corner,timeline.width/timeline.height);
    const value={...d.layout,boxes:{...d.boxes,[d.slot]:box}};next.current=value;
    previewLayout(timeline,value);
    const target=host.current?.querySelector<HTMLElement>(`[data-layout-box="${d.slot}"]`);
    if(target)Object.assign(target.style,{left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`});
  }
  async function end(event:PointerEvent<HTMLButtonElement>,cancel=false){
    const d=drag.current;if(!d||d.pointer!==event.pointerId)return;drag.current=null;
    if(!cancel&&next.current){try{const result=await session!.edit({kind:'layoutRange',s:d.layout.s!,e:d.layout.e!,layout:next.current});if(result===false)throw new Error("Couldn't save the layout.");}catch(e){setError(e instanceof Error?e.message:"Couldn't save the layout.");previewLayout(timeline,null);}}
    else {previewLayout(timeline,null);refresh(n=>n+1);}
    next.current=null;
  }
  const handlers={onPointerMove:move,onPointerUp:(e:PointerEvent<HTMLButtonElement>)=>void end(e),onPointerCancel:(e:PointerEvent<HTMLButtonElement>)=>void end(e,true),onLostPointerCapture:(e:PointerEvent<HTMLButtonElement>)=>void end(e,true)};
  return <div ref={host} data-layout-handles className="pointer-events-none absolute inset-0 z-[6]">
    {(['a','b'] as const).map(slot=>{const box=boxes[slot];if(!box)return null;return <div key={slot} data-layout-box={slot} className="absolute" style={{left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`}}>
      <button type="button" aria-label={`Move ${slot==='a'?'screen':'camera'} picture`} disabled={session.busy} onPointerDown={e=>start(e,slot)} {...handlers} className="pointer-events-auto absolute inset-0 cursor-move bg-transparent" style={{touchAction:'none'}} onKeyDown={e=>{
        if(!e.key.startsWith('Arrow'))return;e.preventDefault();const step=e.shiftKey?.02:.002;const b=dragBox(box,e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0);
        void session.edit({kind:'layoutRange',s:layout.s!,e:layout.e!,layout:{...layout,boxes:{...boxes,[slot]:b}}});
      }}/>
      {['tl','tr','bl','br'].map(corner=><button key={corner} type="button" aria-label={`Resize ${slot==='a'?'screen':'camera'} ${corner}`} disabled={session.busy} onPointerDown={e=>start(e,slot,corner)} {...handlers} className="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full bg-accent" style={{left:corner.endsWith('l')?0:'100%',top:corner.startsWith('t')?0:'100%',touchAction:'none'}} />)}
    </div>;})}
    {error?<InlineError className="absolute inset-x-3 top-12 bg-surface p-2">{error}</InlineError>:null}
  </div>;
}
