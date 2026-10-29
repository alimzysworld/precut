import {useRef,useState} from 'react';
import {InlineError,Tile} from '../ui';
import type {CutEdit,CutVersion,DraftTimeline,LayoutChoice} from '../../../../shared/schema';
import {LAYOUTS,migrateLayouts} from '../../../../shared/layout-presets';
import {layoutBoundary} from '../../../../shared/auto-layouts';

export function LayoutLane({version,draft,time,scale,busy,hidden,style,onEdit,onSelect}:{version:CutVersion;draft?:DraftTimeline|null;time:number;scale:number;busy:boolean;hidden?:boolean;style:React.CSSProperties;onEdit:(edit:CutEdit)=>unknown;onSelect:(time:number)=>void}){
  const ranges=migrateLayouts(version).filter(l=>l.kind==='scene').sort((a,b)=>a.s!-b.s!);
  const [error,setError]=useState<string|null>(null),saving=useRef(false),lane=useRef<HTMLDivElement>(null);
  const drag=useRef<{pointer:number;x:number;at:number;to:number;left:LayoutChoice;right:LayoutChoice;leftNode:HTMLElement;rightNode:HTMLElement}|null>(null);
  async function save(edit:CutEdit){if(busy||saving.current)return;saving.current=true;setError(null);try{const result=await onEdit(edit);if(result===false)throw Error('Could not change this layout.');}catch(e){setError(e instanceof Error?e.message:'Could not change this layout.');}finally{saving.current=false;}}
  function move(event:React.PointerEvent){const d=drag.current;if(!d||d.pointer!==event.pointerId)return;event.stopPropagation();
    const words=(draft?.captionSource?.words??[]).map(w=>({s:w.s,e:w.e,w:w.text}));
    const at=layoutBoundary(d.at+(event.clientX-d.x)/scale,d.left.s!+1.5,d.right.e!-1.5,words,draft?.musicGrid,ranges.flatMap(l=>[l.s!,l.e!]));
    if(at===undefined)return;d.to=at;d.leftNode.style.width=`${(at-d.left.s!)*scale}px`;d.rightNode.style.left=`${at*scale}px`;d.rightNode.style.width=`${(d.right.e!-at)*scale}px`;
  }
  function end(event:React.PointerEvent,cancel=false){const d=drag.current;if(!d||d.pointer!==event.pointerId)return;event.stopPropagation();if(!cancel)move(event);drag.current=null;d.leftNode.style.width=`${(d.left.e!-d.left.s!)*scale}px`;d.rightNode.style.left=`${d.right.s!*scale}px`;d.rightNode.style.width=`${(d.right.e!-d.right.s!)*scale}px`;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(!cancel&&Math.abs(d.to-d.at)>1e-7)void save({kind:'layoutBoundary',at:d.at,to:d.to});}
  const add=()=>{if(!ranges.length)void save({kind:'batch',label:'Added layout',edits:[{kind:'layoutRange',s:0,e:version.lengthS,layout:{kind:'scene',id:'camera-only',followCamera:true}},{kind:'layoutSplit',at:time}]});else void save({kind:'layoutSplit',at:time});};
  return <div ref={lane} data-lane="layouts" data-hidden={!!hidden} className="st-timeline-lane relative" style={style} onPointerDown={e=>e.stopPropagation()}>
    {!hidden&&ranges.map((l,i)=><div key={`${l.s}:${l.e}`} data-layout-block={i} className="absolute top-1 bottom-1 rounded-md bg-accent/15 text-accent" style={{left:l.s!*scale,width:(l.e!-l.s!)*scale}}>
      <Tile type="button" disabled={busy} aria-label={`Layout ${LAYOUTS.find(row=>row[0]===l.id)?.[1]??'Camera'}`} aria-pressed={time>=l.s!&&time<l.e!} title={l.reason} onClick={()=>onSelect(l.s!)} className="h-full w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-3 text-left text-[10px] focus-visible:bg-accent/25 aria-pressed:bg-accent/20">{LAYOUTS.find(row=>row[0]===l.id)?.[1]??'Camera'}</Tile>
      {i>0?<><button type="button" disabled={busy} aria-label={`Retime layout join at ${l.s}`} title="Drag to retime layout" className="absolute -left-1 top-0 bottom-0 z-10 w-2 cursor-ew-resize rounded-sm bg-accent/20 focus-visible:bg-accent/40" style={{touchAction:'none'}}
        onPointerDown={e=>{if(busy)return;e.preventDefault();e.stopPropagation();const nodes=lane.current!.querySelectorAll<HTMLElement>('[data-layout-block]');drag.current={pointer:e.pointerId,x:e.clientX,at:l.s!,to:l.s!,left:ranges[i-1],right:l,leftNode:nodes[i-1],rightNode:nodes[i]};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={move} onPointerUp={e=>end(e)} onPointerCancel={e=>end(e,true)} onLostPointerCapture={e=>end(e,true)}/>
        <button type="button" disabled={busy} aria-label={`${l.transition==='cut'?'Hard cut':'Smooth'} layout join at ${l.s}`} title={`${l.transition==='cut'?'Hard cut':'Smooth'}. Click to change`} onClick={()=>void save({kind:'layoutJoin',at:l.s!,transition:l.transition==='cut'?'smooth':'cut'})} style={{width:14,height:14,lineHeight:'14px',padding:0,top:-8,left:-7}} className={`absolute z-20 rounded text-[10px] focus-visible:bg-accent/30 ${l.transition==='cut'?'bg-accent text-surface':'bg-ground text-accent'}`}>◆</button></>:null}
    </div>)}
    {!hidden?<button type="button" disabled={busy} onClick={add} aria-label="Add layout" title="Split the layout at the playhead" className="absolute right-1 top-1 bottom-1 z-20 rounded-md bg-surface/90 px-2 text-[10px] text-muted hover:bg-accent/15 focus-visible:bg-accent/15">Add layout</button>:null}
    {error?<InlineError className="absolute right-1 top-full z-30 rounded bg-surface px-2 text-micro text-danger">{error}</InlineError>:null}
  </div>;
}
