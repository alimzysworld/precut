import { useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Shoot } from '../../../../shared/schema';
import type { MusicGrid } from '../../../../shared/music-grid';
import { sourceWindowTransition } from '../../motion';
import { frameAt, proxySrc } from '../../data';
import { clipRotation, proxyRotation } from '../../../../shared/media';
import { useShortcuts, useShuttle } from '../../hooks/useShortcuts';
import { Pause, Play, Close, Grip } from '../icons';
import { RotatingImage } from '../RotatingImage';
import { takeThumbnail } from '../footage/thumbnail';
import { InlineError, Tile } from '../ui';
import { markSource, sourceFps, sourceLengths, writeSourceDrag, type SourceRange } from './source';
import './source.css';

export type SourcePreviewProps = {
  shoot: Shoot; clip: Clip; range: SourceRange; onRange: (range: SourceRange) => void;
  onClose: () => void; onInsert: (append: boolean) => void; busy: boolean; focused: boolean;
  musicGrid?: MusicGrid; landing?: number; destination?: string;
};
export function SourcePreview({ shoot, clip, range: initialRange, onRange, onClose, onInsert, busy, focused, musicGrid, landing, destination }: SourcePreviewProps) {
  const [range,setRange] = useState(initialRange);
  const [selected,setSelected] = useState('best');
  const selectedNow=useRef(selected);
  const choices=useMemo(()=>sourceLengths(clip,initialRange,musicGrid,landing,shoot),[clip,initialRange,musicGrid,landing,shoot.takes]);
  const preferenceKey=`precut.source-length:${shoot.root}`;
  const video = useRef<HTMLVideoElement>(null), bar = useRef<HTMLDivElement>(null);
  // Reuse the card's cached picture while the source seeks to its first frame.
  const poster = useRef(takeThumbnail(shoot,{clip,s:range.s}));
  const [time,setTime] = useState(range.s), [playing,setPlaying] = useState(false), [error,setError] = useState('');
  const clock = useRef(range.s), marks = useRef(range); marks.current = range;
  const duration = clip.meta?.durationS ?? 0, fps = sourceFps(clip);
  const transport = useRef({
    seek: (t: number) => { video.current?.pause(); if(video.current) video.current.currentTime=t; clock.current=t; setTime(t); },
    pause: () => video.current?.pause(),
    play: (rate=1) => {
      const v=video.current; if(!v)return;
      if(v.currentTime>=marks.current.e) v.currentTime=marks.current.s;
      v.playbackRate=rate; void v.play().then(()=>setError('')).catch(cause=>{if(cause?.name!=='AbortError')setError('Could not play this clip. Try again.');});
    },
    togglePlayback: () => { if(video.current?.paused) transport.current.play(); else transport.current.pause(); },
  });
  const shuttle = useShuttle(transport,time,duration,clip.id);
  useEffect(()=>{
    let remembered='best';try{remembered=window.localStorage.getItem(preferenceKey) ?? 'best';}catch{/* Storage can be unavailable. */}
    const choice=choices.find(c=>c.id===remembered) ?? choices.find(c=>c.id==='best');
    const next=choice?.range ?? initialRange;selectedNow.current=remembered;setSelected(choice?.id ?? 'best');marks.current=next;setRange(next);onRange(next);
    if(video.current && video.current.readyState>=1){transport.current.seek(next.s);if(focused)transport.current.play();}
  },[initialRange,preferenceKey]);
  // A measured grid may arrive while the source is already open.
  useEffect(()=>{if(selectedNow.current==='custom')return;const choice=choices.find(c=>c.id===selectedNow.current) ?? choices.find(c=>c.id==='best');if(choice){setSelected(choice.id);if(choice.range.s!==marks.current.s || choice.range.e!==marks.current.e){marks.current=choice.range;setRange(choice.range);onRange(choice.range);transport.current.seek(choice.range.s);}}},[choices]);
  useEffect(()=>{ if(!focused) video.current?.pause(); },[focused]);
  useEffect(()=>{
    if(!focused)return;
    let frame=0;
    const tick=()=>{
      const v=video.current;
      if(v && !v.paused){
        if(v.currentTime>=marks.current.e){v.pause();v.currentTime=marks.current.e;}
        clock.current=v.currentTime;setTime(v.currentTime);
      }
      frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[focused]);
  const choose = (index:number) => {const choice=choices[index];if(!choice)return;selectedNow.current=choice.id;setSelected(choice.id);marks.current=choice.range;setRange(choice.range);onRange(choice.range);transport.current.seek(choice.range.s);try{window.localStorage.setItem(preferenceKey,choice.id);}catch{/* Keep the choice for this preview. */}};
  const mark = (edge:'s'|'e', t=clock.current) => { const next=markSource(clip,marks.current,edge,t);selectedNow.current='custom';setSelected('custom');marks.current=next;setRange(next);onRange(next);return next; };
  useShortcuts('precuts',[
    ...choices.map((choice,i)=>({id:`source-length-${i+1}`,keys:[String(i+1)],label:`Insert length: ${choice.label}`,scope:'precuts',handler:()=>choose(i)})),
    {id:'source-in',keys:['i'],label:'Mark source in',scope:'precuts',handler:()=>mark('s')},
    {id:'source-out',keys:['o'],label:'Mark source out',scope:'precuts',handler:()=>mark('e')},
    {id:'source-insert',keys:['e'],label:'Insert source after playhead clip',scope:'precuts',enabled:!busy,handler:()=>onInsert(false)},
    {id:'source-append',keys:['Shift+e'],label:'Append source',scope:'precuts',enabled:!busy,handler:()=>onInsert(true)},
    {id:'source-play',keys:['Space'],label:'Play source',scope:'precuts',handler:shuttle.toggle},
    {id:'source-back',keys:['j'],label:'Shuttle source backward',scope:'precuts',handler:()=>shuttle.shuttle(-1)},
    {id:'source-pause',keys:['k'],label:'Pause source',scope:'precuts',handler:()=>shuttle.shuttle(0)},
    {id:'source-forward',keys:['l'],label:'Shuttle source forward',scope:'precuts',handler:()=>shuttle.shuttle(1)},
  ],focused);
  const seek = (x:number) => { const box=bar.current?.getBoundingClientRect(); if(!box?.width)return 0;return Math.max(0,Math.min(duration,(x-box.left)/box.width*duration)); };
  const src = clip.proxy ? proxySrc(shoot.root,clip.proxy) : undefined;
  const rotation = clipRotation(clip)-proxyRotation(clip.proxy,clip.meta?.rotation ?? 0);
  const musicEnd=landing===undefined ? 0 : musicGrid?.bars.find(t=>t>landing+range.e-range.s+1/fps) ?? musicGrid?.beats.at(-1) ?? landing+range.e-range.s;
  const musicWidth=Math.max(range.e-range.s,musicEnd-(landing ?? 0));
  return <div data-source-preview className="source-preview">
    <header><span className="source-tag">Source · {clip.id}</span><button aria-label="Return to edit" title="Return to edit (Esc)" onClick={onClose}><Close size={16}/></button></header>
    <div className="source-picture" data-source-picture draggable={!busy} onDragStart={event=>{transport.current.pause();writeSourceDrag(event.dataTransfer,shoot.root,marks.current);}}>
      <span className="source-drag-grip"><Grip size={14}/> Drag into the edit</span>
      <video ref={video} draggable={false} src={src} poster={poster.current ?? undefined} style={{transform:`rotate(${rotation}deg)`}} playsInline preload="auto" aria-label={`Source ${clip.id}`} onLoadedMetadata={event=>{event.currentTarget.currentTime=range.s;clock.current=range.s;setTime(range.s);if(focused)transport.current.play();}}
        onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onTimeUpdate={event=>{clock.current=event.currentTarget.currentTime;setTime(clock.current);if(clock.current>=marks.current.e)event.currentTarget.pause();}} onError={()=>setError('Could not play this clip. Choose another clip or try again.')} />
      {!clip.proxy && clip.photo && <RotatingImage root={shoot.root} clip={clip} src={frameAt(shoot,clip.id,range.s) ?? ''} alt="" />}
      {!clip.proxy && !clip.photo && <p role="status">This clip is not ready to preview yet.</p>}
    </div>
    <div className="source-controls">
      <div className="source-transport"><button aria-label={playing?'Pause source':'Play source'} title="Play or pause (Space)" onClick={shuttle.toggle}>{playing?<Pause size={16}/>:<Play size={16}/>}</button><span className="tnum">{time.toFixed(2)} s</span><span className="tnum" data-source-length>{(range.e-range.s).toFixed(1)} s</span></div>
      <div className="source-lengths" role="group" aria-label="Insert length">
        {choices.map((choice,i)=><Tile key={choice.id} data-source-chip={choice.id} selected={selected===choice.id} title={`${choice.label} (${i+1})`} onClick={()=>choose(i)}>{choice.label}</Tile>)}
        {selected==='custom' && <span className="source-custom">Custom · {(range.e-range.s).toFixed(1)} s</span>}
        <button disabled={busy || range.e<=range.s} className="st-button-primary" title="Insert after playhead clip (E), append (Shift E)" onClick={()=>onInsert(false)}>Insert</button>
      </div>
      {destination && <div data-source-destination className="source-destination" title={destination}><span>{destination.slice(0,destination.lastIndexOf(', '))}</span><span>{destination.slice(destination.lastIndexOf(', '))}</span></div>}
      <div ref={bar} data-source-bar className="source-bar" draggable={!busy} onDragStart={event=>{transport.current.pause();writeSourceDrag(event.dataTransfer,shoot.root,marks.current);}} onClick={event=>{if(!(event.target as HTMLElement).closest('[role=slider]'))transport.current.seek(seek(event.clientX));}} title="Drag marked span into the edit">
        {(clip.judgement?.usableSpans ?? []).map(([s,e],i)=><span key={`good${i}`} className="source-usable" style={{left:`${s/duration*100}%`,width:`${(e-s)/duration*100}%`}}/>)}
        {(clip.shake?.shakySpans ?? []).map(([s,e],i)=><span key={`shake${i}`} className="source-shaky" style={{left:`${s/duration*100}%`,width:`${(e-s)/duration*100}%`}}/>)}
        <span className="source-marked" style={{left:`${range.s/duration*100}%`,width:`${(range.e-range.s)/duration*100}%`,transition:selected==='custom'?'none':sourceWindowTransition}}/>
        <span className="source-clock" style={{left:`${time/duration*100}%`}}/>
        {(['s','e'] as const).map(edge=><button key={edge} data-source-handle data-editor-widget draggable={false} role="slider" aria-label={edge==='s'?'Source in':'Source out'} aria-valuemin={edge==='s'?0:range.s+1/fps} aria-valuemax={edge==='s'?range.e-1/fps:duration} aria-valuenow={range[edge]} aria-valuetext={`${range[edge].toFixed(2)} seconds`} title={edge==='s'?'Mark in (I)':'Mark out (O)'} style={{left:`${range[edge]/duration*100}%`,transition:selected==='custom'?'none':sourceWindowTransition}}
          onPointerDown={event=>{event.preventDefault();event.stopPropagation();selectedNow.current='custom';setSelected('custom');event.currentTarget.setPointerCapture(event.pointerId);}}
          onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId)){const next=mark(edge,seek(event.clientX));transport.current.seek(next[edge]);}}}
          onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
          onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();mark(edge,event.key==='Home'?0:event.key==='End'?duration:range[edge]+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?1:1/fps));}}} />)}
      </div>
      {musicGrid?.beats.length && landing!==undefined ? <div className="source-music" data-source-music>
        <span>Music · Insert at {landing.toFixed(1)} s</span>
        <div className="source-music-strip" role="img" aria-label={`Music, insert from ${landing.toFixed(2)} to ${(landing+range.e-range.s).toFixed(2)} seconds`}>
          <span className="source-music-window" style={{left:'0%',width:`${(range.e-range.s)/musicWidth*100}%`}}/>
          {musicGrid.beats.filter(t=>t>=landing && t<=musicEnd).map(t=><i key={t} data-bar={musicGrid.bars.some(b=>Math.abs(b-t)<.001) || undefined} style={{left:`${(t-landing)/musicWidth*100}%`}}/>)}
        </div>
      </div> : null}
      {!!musicGrid?.beats.length && landing===undefined && <span className="source-readout">Choose another join for beat lengths.</span>}
      <div className="source-readout tnum"><span>In {range.s.toFixed(2)} s · I</span><span>Out {range.e.toFixed(2)} s · O</span></div>
      {error && <InlineError>{error}</InlineError>}
    </div>
  </div>;
}
