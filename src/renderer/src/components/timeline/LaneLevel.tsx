import { useEffect, useRef, useState } from 'react';
import { laneStep } from '../../../../shared/lane-levels';
/** One release saves one version; Option reduces pointer sensitivity tenfold. */
export function LaneLevel({label,value,disabled,onPreview,onCommit}:{label:string;value:number;disabled?:boolean;onPreview:(db:number|null)=>void;onCommit:(db:number)=>unknown}) {
  const [draft,setDraft]=useState<string|null>(null), input=useRef<HTMLInputElement>(null);
  const drag=useRef<{pointer:number;y:number;lastY:number;db:number;start:number;moved:boolean}|null>(null), skipBlur=useRef(false),saveRevision=useRef(0);
  useEffect(()=>{if(drag.current)onPreview(laneStep(drag.current.db));else setDraft(null);},[value]);
  useEffect(()=>()=>{onPreview(null);},[]);
  const typed=()=>draft!==null && draft.trim()!=='' && Number.isFinite(Number(draft)) ? Number(draft) : value;
  function cancel(){drag.current=null;setDraft(null);onPreview(null);}
  async function save(db:number,blur=false){const revision=++saveRevision.current;if(blur){skipBlur.current=true;input.current?.blur();skipBlur.current=false;}try{await onCommit(laneStep(db));}finally{if(revision===saveRevision.current && !drag.current){setDraft(null);onPreview(null);}}}
  function finish(event:React.PointerEvent<HTMLInputElement>,cancelled=false){
    const active=drag.current;if(!active || active.pointer!==event.pointerId)return;
    drag.current=null;event.currentTarget.releasePointerCapture?.(event.pointerId);
    if(cancelled){cancel();return;}
    if(active.moved){void save(active.db);}else{event.currentTarget.focus();event.currentTarget.select();}
  }
  return <input ref={input} type="text" inputMode="decimal" role="slider" aria-label={label} aria-valuemin={-60} aria-valuemax={6} aria-valuenow={typed()} aria-valuetext={`${draft ?? value} dB`}
    className="st-lane-level" disabled={disabled} value={draft ?? `${value>0?'+':''}${value} dB`}
    title={`${label}. Click to type, drag to adjust, Option for fine control, double-click to reset`}
    onChange={event=>setDraft(event.target.value)}
    onFocus={()=>setDraft(String(value))} onBlur={()=>{if(skipBlur.current)return;const n=Number(draft);if(draft!==null && draft.trim()!=='' && Number.isFinite(n) && laneStep(n)!==value)void save(n);else cancel();}}
    onDoubleClick={event=>{event.preventDefault();drag.current=null;void save(0,true);}}
    onPointerDown={event=>{if(disabled || event.button!==0)return;event.preventDefault();drag.current={pointer:event.pointerId,y:event.clientY,lastY:event.clientY,db:typed(),start:value,moved:false};event.currentTarget.setPointerCapture(event.pointerId);}}
    onPointerMove={event=>{const active=drag.current;if(!active || active.pointer!==event.pointerId)return;if(Math.abs(event.clientY-active.y)>2)active.moved=true;if(!active.moved)return;active.db=Math.max(-60,Math.min(6,active.db+(active.lastY-event.clientY)*(event.altKey?.05:.5)));active.lastY=event.clientY;setDraft(String(laneStep(active.db)));onPreview(laneStep(active.db));}}
    onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onLostPointerCapture={event=>{if(drag.current)finish(event,true);}}
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();skipBlur.current=true;event.currentTarget.blur();skipBlur.current=false;cancel();}else if(event.key==='Enter'){event.preventDefault();const n=Number(draft);if(draft?.trim() && Number.isFinite(n))void save(n,true);else cancel();}else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?-60:event.key==='End'?6:laneStep(typed()+(['ArrowUp','ArrowRight'].includes(event.key)?.5:-.5));setDraft(String(next));onPreview(next);void save(next);}}} />;
}
