import {wheelPixels} from './viewZoom';
import {cropGesture,transformHandlePoints} from '../../../shared/transform-gesture';
import {useEffect,useRef,useState,type PointerEvent} from 'react';
import type {ClipTransform,DraftTimeline} from '../../../shared/schema';
import {levelAngle,transformValue} from '../../../shared/clip-transform';
import {viewerGesture,visualLayout} from './layoutPreview';
import type {LayoutPicture} from '../../../main/layout-math';
import {transformSessions,previewTransform,saveTransform,visualTransform} from './transformPreview';
import {InlineError} from './ui';
import {Rotate} from './icons';
export function TransformHandles({timeline,time,pause}:{timeline:DraftTimeline;time:number;pause:()=>void}){
 const host=useRef<HTMLDivElement>(null),gesture=useRef<ReturnType<typeof viewerGesture>&{kind:string;value:ReturnType<typeof transformValue>}|null>(null),next=useRef<ClipTransform|null>(null),wheelTimer=useRef<ReturnType<typeof setTimeout>>(),wheelValue=useRef<ClipTransform>(),line=useRef<SVGLineElement>(null),[error,setError]=useState(''),[,refresh]=useState(0);
 const s=transformSessions.get(timeline),pictures=(timeline.pieces as LayoutPicture[]).filter(p=>s?.pieces.includes(p.piece??-1)&&p.startS<=time&&p.endS>time),p=pictures.find(p=>!p.layoutScreen)??pictures[0];
 const region=p?visualLayout(p,time,timeline.width,timeline.height).region:undefined,aspect=timeline.width*(region?.w??1)/(timeline.height*(region?.h??1))||timeline.width/timeline.height;
 const wheelHandler=useRef<(e:WheelEvent)=>void>();
 const paintHandles=useRef<()=>void>();
 paintHandles.current=()=>{if(!p)return;for(const [kind,point] of Object.entries(transformHandlePoints(visualTransform(p),aspect))){const dot=host.current?.querySelector<HTMLElement>(`[data-transform-dot="${kind}"]`);if(dot)Object.assign(dot.style,{left:`${point.x*100}%`,top:`${point.y*100}%`});}};
 useEffect(()=>{const player=host.current?.closest('[data-live-player]');const paint=()=>paintHandles.current?.();player?.addEventListener('precut:layout-preview',paint);return()=>player?.removeEventListener('precut:layout-preview',paint);},[timeline,!!s,!!p]);
 wheelHandler.current=e=>{if(!s||!p||s.busy)return;e.preventDefault();e.stopPropagation();pause();const v=transformValue(wheelValue.current??p.transform);wheelValue.current={zoom:Math.max(.5,Math.min(4,v.zoom*Math.exp(-wheelPixels(e,host.current?.clientHeight??timeline.height)*(e.ctrlKey ? .01 : .002))))};previewTransform(timeline,s.pieces,wheelValue.current);clearTimeout(wheelTimer.current);wheelTimer.current=setTimeout(()=>{const value=wheelValue.current;wheelValue.current=undefined;if(value)void saveTransform(timeline,value).catch(e=>{setError(e.message);previewTransform(timeline,s.pieces,null);});},180);};
 useEffect(()=>{const element=host.current;if(!element)return;const wheel=(e:WheelEvent)=>wheelHandler.current?.(e);element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);},[timeline,!!s,!!p]);
 useEffect(()=>()=>{clearTimeout(wheelTimer.current);previewTransform(timeline,s?.pieces??[],null);},[timeline]);
 if(!s||!p)return null;
 function start(e:PointerEvent<HTMLButtonElement>,kind:string){if(s!.busy||!host.current)return;setError('');gesture.current={...viewerGesture(e,host.current,pause),kind,value:transformValue(visualTransform(p!))};next.current=null;}
 function move(e:PointerEvent<HTMLButtonElement>){const g=gesture.current;if(!g||g.pointer!==e.pointerId)return;
  const dx=(e.clientX-g.x)/g.w,dy=(e.clientY-g.y)/g.h,v=g.value;
  let patch:ClipTransform;
  if(g.kind==='level'){const r=host.current!.getBoundingClientRect();if(line.current){line.current.setAttribute('x1',String(g.x-r.left));line.current.setAttribute('y1',String(g.y-r.top));line.current.setAttribute('x2',String(e.clientX-r.left));line.current.setAttribute('y2',String(e.clientY-r.top));}if(Math.hypot(e.clientX-g.x,e.clientY-g.y)<8)return;patch={rotate:Math.max(-45,Math.min(45,v.rotate+levelAngle(dx*g.w,dy*g.h)))};}
  else if(g.kind==='move')patch={x:Math.max(-2,Math.min(2,v.x+dx)),y:Math.max(-2,Math.min(2,v.y+dy))};
  else if(g.kind==='rotate'){const cx=g.left+(.5+v.x)*g.w,cy=g.top+(.5+v.y)*g.h;let a=(Math.atan2(e.clientY-cy,e.clientX-cx)-Math.atan2(g.y-cy,g.x-cx))*180/Math.PI;while(a>180)a-=360;while(a< -180)a+=360;patch={rotate:Math.max(-45,Math.min(45,Math.round((v.rotate+a)*10)/10))};}
  else patch=cropGesture(v,g.kind,dx,dy,aspect);
  next.current=patch;previewTransform(timeline,s!.pieces,patch);
  const points=transformHandlePoints({...v,...patch,crop:{...v.crop,...patch.crop}},aspect);for(const [kind,point] of Object.entries(points)){const dot=host.current?.querySelector<HTMLElement>(`[data-transform-dot="${kind}"]`);if(dot)Object.assign(dot.style,{left:`${point.x*100}%`,top:`${point.y*100}%`});}
 }
 async function finish(e:PointerEvent<HTMLButtonElement>,cancel=false){const g=gesture.current;if(!g||g.pointer!==e.pointerId)return;gesture.current=null;if(line.current)line.current.setAttribute('x2',line.current.getAttribute('x1')??'0');const patch=next.current;next.current=null;if(!cancel&&patch)try{await saveTransform(timeline,patch);}catch(e){setError((e as Error).message);previewTransform(timeline,s!.pieces,null);}else previewTransform(timeline,s!.pieces,null);refresh(n=>n+1);}
 const points=transformHandlePoints(visualTransform(p),aspect);
 const handlers={onPointerMove:move,onPointerUp:(e:PointerEvent<HTMLButtonElement>)=>void finish(e),onPointerCancel:(e:PointerEvent<HTMLButtonElement>)=>void finish(e,true),onLostPointerCapture:(e:PointerEvent<HTMLButtonElement>)=>void finish(e,true)};
 return <div ref={host} data-transform-handles className="pointer-events-none absolute z-[7]" style={{left:`${(region?.x??0)*100}%`,top:`${(region?.y??0)*100}%`,width:`${(region?.w??1)*100}%`,height:`${(region?.h??1)*100}%`}}>
  <button type="button" disabled={s.busy} aria-label={s.level?'Draw a level line':'Move clip picture'} onPointerDown={e=>start(e,s.level?'level':'move')} {...handlers} onDoubleClick={()=>void saveTransform(timeline,null).catch(e=>setError(e.message))} className="pointer-events-auto absolute inset-0 bg-transparent" style={{touchAction:'none',cursor:s.level?'crosshair':'move'}} />
  {!s.level?['tl','t','tr','l','r','bl','b','br','rotate'].map(kind=><button key={kind} data-transform-dot={kind} type="button" disabled={s.busy} aria-label={kind==='rotate'?'Rotate clip':`Crop clip ${kind}`} onPointerDown={e=>start(e,kind)} {...handlers} title={kind==='rotate'?'Rotate clip':undefined} className={`pointer-events-auto absolute grid place-items-center -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ${kind==='rotate'?'size-5 text-ground':'size-3'}`} style={{left:`${points[kind].x*100}%`,top:`${points[kind].y*100}%`,touchAction:'none',cursor:kind==='rotate'?'ew-resize':'crosshair'}}>{kind==='rotate'?<Rotate size={13}/>:null}</button>):<svg className="pointer-events-none absolute size-full"><line ref={line} stroke="var(--accent)" strokeWidth="2" /></svg>}
  {error?<InlineError className="absolute inset-x-3 top-12 bg-surface p-2">{error}</InlineError>:null}
 </div>;
}
