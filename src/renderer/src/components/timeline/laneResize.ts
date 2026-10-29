import { useLayoutEffect, useRef } from 'react';
import type { LaneId } from './model';
const key='precut.timeline-lane-heights';
const limit=(height:number)=>Math.max(22,Math.min(240,Math.round(height)));
/** Height is painted on the mounted timeline; moves never call a React setter. */
export function useLaneResize() {
  const ref=useRef<HTMLElement>(null),heights=useRef<Record<string,number>>({});
  const drag=useRef<{pointer:number;y:number;height:number;id:LaneId;before?:number}|null>(null);
  const property=(id:string)=>`--timeline-${id}-size`;
  function persist(){try{window.localStorage.setItem(key,JSON.stringify(heights.current));}catch{/* This window can still resize when storage is unavailable. */}}
  useLayoutEffect(()=>{
    try{const saved=JSON.parse(window.localStorage.getItem(key) ?? '{}');for(const [id,value]of Object.entries(saved))if(['layouts','video','clip-sound','broll-sound','captions','voice','music','overlays','sound-effects'].includes(id) && typeof value==='number' && Number.isFinite(value)){heights.current[id]=limit(value);ref.current?.style.setProperty(property(id),`${limit(value)}px`);}}catch{/* Keep defaults. */}
  },[]);
  function hit(event:React.PointerEvent|React.MouseEvent) {
    // Pointer capture retargets click/double-click to the section. Resolve the
    // physical edge as well so a double-click still resets the row beneath it.
    const node=(event.target as HTMLElement).closest<HTMLElement>('[data-lane],[data-lane-size]')
      ?? ref.current?.ownerDocument?.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-lane],[data-lane-size]');
    if(!node || node.dataset.hidden==='true')return;
    const box=node.getBoundingClientRect();
    if(event.clientY<box.bottom-5 || event.clientY>box.bottom+2)return;
    const id=(node.dataset.laneSize ?? node.dataset.lane) as LaneId;
    return {node,box,id};
  }
  function move(event:React.PointerEvent) {
    const d=drag.current;if(!d || d.pointer!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();
    const height=limit(d.height+event.clientY-d.y);heights.current[d.id]=height;ref.current?.style.setProperty(property(d.id),`${height}px`);
  }
  function end(event:React.PointerEvent,cancel=false) {
    const d=drag.current;if(!d || d.pointer!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();if(!cancel)move(event);drag.current=null;
    if(cancel){if(d.before===undefined){delete heights.current[d.id];ref.current?.style.removeProperty(property(d.id));}else{heights.current[d.id]=d.before;ref.current?.style.setProperty(property(d.id),`${d.before}px`);}}else persist();
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return {ref,
    onPointerDownCapture:(event:React.PointerEvent)=>{if(!event.isPrimary || event.button!==0)return;const h=hit(event);if(!h)return;event.preventDefault();event.stopPropagation();drag.current={pointer:event.pointerId,y:event.clientY,height:h.box.height,id:h.id,before:heights.current[h.id]};event.currentTarget.setPointerCapture(event.pointerId);},
    onPointerMoveCapture:move,onPointerUpCapture:(event:React.PointerEvent)=>end(event),onPointerCancelCapture:(event:React.PointerEvent)=>end(event,true),onLostPointerCapture:(event:React.PointerEvent)=>end(event,true),
    onDoubleClickCapture:(event:React.MouseEvent)=>{const h=hit(event);if(!h)return;event.preventDefault();event.stopPropagation();delete heights.current[h.id];ref.current?.style.removeProperty(property(h.id));persist();},
  };
}
