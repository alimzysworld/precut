import { useEffect, useRef, useState } from 'react';
/** A filled volume line with vertical pointer travel and one save on release. */
export function VolumeLine({ label, value, min = -12, max = 12, endInset = 4, disabled, onPreview, onCommit }: {
  label: string; value: number; min?: number; max?: number; endInset?: number; disabled?: boolean;
  onPreview: (value: number | null) => void; onCommit: (value: number) => unknown;
}) {
  const [draft,setDraft]=useState<number | null>(null), drag=useRef<{pointer:number;y:number;value:number;latest:number} | null>(null);
  useEffect(()=>{setDraft(null);},[value]);
  const shown=draft ?? value;
  async function commit(value:number) { try {await onCommit(value);} finally {setDraft(null);} }
  function finish(event: React.PointerEvent, cancel=false) {
    const active=drag.current;if(!active || active.pointer!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();drag.current=null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if(cancel){setDraft(null);onPreview(null);return;}
    if(active.latest!==active.value) void commit(active.latest);else {setDraft(null);onPreview(null);}
  }
  return <div role="slider" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={shown} aria-valuetext={`${shown} dB`} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
    title={`${label}: ${shown} dB. Drag up or down`} className="absolute inset-x-1 z-20 cursor-ns-resize touch-none"
    style={{right:endInset,top:`clamp(7px, ${12+(max-shown)/(max-min)*60}%, calc(100% - 7px))`,height:14,transform:'translateY(-50%)',outline:'none'}}
    onClick={event=>event.stopPropagation()}
    onPointerDown={event=>{event.preventDefault();event.stopPropagation();if(disabled || event.button!==0)return;drag.current={pointer:event.pointerId,y:event.clientY,value:shown,latest:shown};setDraft(shown);event.currentTarget.setPointerCapture(event.pointerId);}}
    onPointerMove={event=>{const active=drag.current;if(!active || active.pointer!==event.pointerId)return;event.preventDefault();event.stopPropagation();const next=Math.max(min,Math.min(max,Math.round((active.value+(active.y-event.clientY)*.5)*2)/2));active.latest=next;setDraft(next);onPreview(next);}}
    onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onLostPointerCapture={event=>{if(drag.current)finish(event,true);}}
    onKeyDown={event=>{if(disabled || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();event.stopPropagation();const next=Math.max(min,Math.min(max,shown+(['ArrowUp','ArrowRight'].includes(event.key) ? .5 : -.5)));onPreview(next);void commit(next);}}>
    <span className="absolute inset-x-0 top-1.5 rounded bg-current" style={{height:2}} />
    {draft!==null && <span className="absolute right-1 top-0 rounded bg-surface px-1 text-micro text-ink tabular-nums">{shown>0 ? '+' : ''}{shown} dB</span>}
  </div>;
}
