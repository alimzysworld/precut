import { useEffect, useRef, useState } from 'react';
import type { DraftTimeline } from '../../../../shared/schema';
import { Tile } from '../ui';
import { Waveform } from './Waveform';
import { timelineTime } from './model';
import { musicGesture, type MusicChoice } from './musicEdit';
import { previewLiveSound, clearLiveSoundPreview } from '../liveMix';
export function MusicBlock({music,draft,duration,scale,snapping,busy,onChange,onInspect,onPause}:{music:MusicChoice;draft?:DraftTimeline|null;duration:number;scale:number;snapping:boolean;busy:boolean;onChange?:(music:MusicChoice)=>Promise<unknown>;onInspect:()=>void;onPause:()=>void}) {
  const block=useRef<HTMLDivElement>(null),raw=useRef<HTMLSpanElement>(null),arranged=useRef<HTMLSpanElement>(null),readout=useRef<HTMLSpanElement>(null),previewBars=useRef<HTMLSpanElement>(null);
  const drag=useRef<{pointer:number;x:number;scale:number;mode:'start'|'end'|'slip';next:MusicChoice;moved:boolean}|null>(null),saving=useRef(false),suppress=useRef(false);
  const [note,setNote]=useState<string|null>(null);
  const sound=draft?.liveSound?.music,sourceDuration=sound?.sourceDurationS;
  const bars=sound?.sourceBars ?? (music.fit || music.followStory ? [] : (draft?.musicGrid?.bars ?? []).map(t=>t+music.startS));
  const end=Math.min(duration,music.endS ?? duration),fitted=!!(music.fit || music.followStory);
  useEffect(()=>{if(!fitted)return;setNote(null);},[music.file,fitted]);
  useEffect(()=>()=>{if(draft)clearLiveSoundPreview(draft,'music');},[draft]);
  function paint(next:MusicChoice,manual:boolean) {
    const node=block.current;if(!node)return;
    const e=Math.min(duration,next.endS ?? duration);node.style.width=`${e*scale}px`;
    const level=node.parentElement?.querySelector<HTMLElement>('[aria-label="Music volume"]');if(level)level.style.right=`${Math.max(4,(duration-e)*scale+4)}px`;
    node.style.setProperty('--timeline-music-fade',`${Math.min(1.5,e)*scale}px`);
    if(raw.current){raw.current.style.left=`${-next.startS*scale}px`;raw.current.style.visibility=manual || !fitted ? 'visible':'hidden';}
    if(arranged.current)arranged.current.style.visibility=manual ? 'hidden':'visible';
    if(readout.current){readout.current.hidden=!manual;readout.current.textContent=drag.current?.mode==='end' ? `Ends at ${timelineTime(e)}` : `Starts ${timelineTime(next.startS)} into the song`;}
    // A paused live graph gets the same source clock; no renderer state update.
    if(manual && draft && sound){const url=sound.rawUrl ?? sound.url;previewLiveSound(draft,{music:{...sound,...next,url,stems:undefined,arrangementState:undefined}});}
    const marks=node.parentElement?.querySelector<HTMLElement>('.st-music-marks');if(marks)marks.style.visibility=manual?'hidden':'visible';
    if(previewBars.current){previewBars.current.style.left=`${-next.startS*scale}px`;previewBars.current.style.visibility=manual?'visible':'hidden';}
    node.dataset.musicDragging=String(manual);
  }
  function begin(event:React.PointerEvent,mode:'start'|'end'|'slip') {
    if(!event.isPrimary || event.button!==0 || busy || saving.current || !onChange || mode!=='end' && sourceDuration===undefined)return;
    event.preventDefault();event.stopPropagation();onPause();suppress.current=false;
    drag.current={pointer:event.pointerId,x:event.clientX,scale,mode,next:music,moved:false};event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event:React.PointerEvent) {
    const d=drag.current;if(!d || d.pointer!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();const delta=(event.clientX-d.x)/d.scale;
    if(Math.abs(event.clientX-d.x)<2 && !d.moved)return;d.moved=true;suppress.current=true;
    // Right-edge bars are on the edit clock. Start/slip bars are source times.
    d.next=musicGesture(music,d.mode,delta,duration,sourceDuration ?? duration,d.mode==='end' ? bars.map(t=>t-music.startS) : bars,snapping&&!event.altKey);
    paint(d.next,true);
  }
  async function finish(event:React.PointerEvent,cancel=false) {
    const d=drag.current;if(!d || d.pointer!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();if(!cancel)move(event);drag.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(cancel || !d.moved || d.next.startS===music.startS && d.next.endS===music.endS){paint(music,false);if(draft)clearLiveSoundPreview(draft,'music');return;}
    saving.current=true;
    try{const result=await onChange?.(d.next);if(result===false || result===undefined)throw Error('Could not save music. Try again.');setNote(fitted ? 'Fit and Follow the story turned off for this edit.' : null);}
    catch(error){paint(music,false);setNote(error instanceof Error?error.message:'Could not save music. Try again.');}
    finally{if(block.current){block.current.dataset.musicDragging="false";const marks=block.current.parentElement?.querySelector<HTMLElement>('.st-music-marks');if(marks)marks.style.visibility='visible';}if(previewBars.current)previewBars.current.style.visibility='hidden';saving.current=false;if(draft)clearLiveSoundPreview(draft,'music');if(readout.current)readout.current.hidden=true;}
  }
  const handlers={onPointerMove:move,onPointerUp:(e:React.PointerEvent)=>void finish(e),onPointerCancel:(e:React.PointerEvent)=>void finish(e,true),onLostPointerCapture:(e:React.PointerEvent)=>{if(drag.current)void finish(e,true);}};
  return <><div ref={block} data-music-block className="st-music-edit st-timeline-music st-lane-music overflow-hidden absolute inset-y-0 left-0 rounded-lg" style={{width:end*scale,'--timeline-music-fade':`${Math.min(fitted && sound?.arrangementState==='ready' ? .012 : 1.5,end)*scale}px`} as React.CSSProperties}>
    <Tile type="button" aria-label="Slip music" title="Drag to choose which part of the song plays. Option skips bar snapping" className="absolute inset-0 overflow-hidden rounded-lg text-left" onPointerDown={e=>begin(e,'slip')} {...handlers} onClick={()=>{if(suppress.current){suppress.current=false;return;}onInspect();}}>
      <span aria-hidden="true" className="st-music-wave absolute inset-0 overflow-hidden">
        <span ref={raw} data-music-source-wave className="absolute inset-y-0" style={{left:-music.startS*scale,width:(sourceDuration ?? duration)*scale,visibility:fitted?'hidden':'visible'}}><Waveform measured={sound?.sourcePeaks ?? (!fitted ? sound?.peaks : undefined)} label="Music waveform" /></span>
        {fitted && <span ref={arranged} className="absolute inset-y-0 left-0" style={{width:(sound?.waveformDurationS ?? duration)*scale}}><Waveform measured={sound?.peaks} label="Fitted music waveform" /></span>}
      </span>
      <span className="st-music-name absolute left-3 top-1 max-w-[85%] truncate rounded px-1 text-micro">{music.file.split(/[\\/]/).pop()}</span>
    </Tile>
    <span ref={previewBars} aria-hidden="true" className="st-music-marks pointer-events-none absolute inset-y-0" style={{left:-music.startS*scale,width:(sourceDuration ?? duration)*scale,visibility:'hidden'}}>{bars.map(at=><span key={at} className="st-music-tick absolute bottom-0" data-music-preview-bar data-music-tick="bar" style={{left:at*scale}} />)}</span>
    {onChange && <>{(['start','end'] as const).map(edge=><Tile key={edge} type="button" data-music-edge={edge} disabled={busy || edge==='start' && sourceDuration===undefined} aria-label={edge==='start'?'Trim music start':'Trim music end'} title={edge==='start'?'Skip the start of the song. Music stays at 0:00':'End music earlier'} className={`st-music-edge absolute inset-y-0 z-30 ${edge==='start'?'left-0':'right-0'}`} onClick={e=>e.stopPropagation()} onPointerDown={e=>begin(e,edge)} {...handlers}><span /></Tile>)}</>}
    <span ref={readout} role="status" data-music-readout hidden className="st-music-readout pointer-events-none absolute left-3 top-1 z-40 rounded bg-surface px-2 text-micro text-ink" />
  </div>{note && <span role="status" className="pointer-events-none absolute bottom-3 left-3 z-30 rounded bg-surface px-2 text-micro text-ink">{note}</span>}</>;
}
