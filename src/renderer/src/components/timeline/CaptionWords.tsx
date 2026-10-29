import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CutEdit, TitleTrack } from '../../../../shared/schema';
import { isCaptionCue, retimeCaptionEdge, timedCaptionWords, type TimedCaptionWord } from '../../../../shared/caption-words';

type Props = { track: TitleTrack | null | undefined; scale: number; time: number; duration: number; fps: number; busy: boolean;
  blocks: { id: string; s: number; e: number; text: string; big: boolean }[];
  inspect?: (id: string) => void; seek: (time: number) => void; save: (edit: CutEdit) => unknown; error: (message: string) => void;
  preview: (edit: Extract<CutEdit, {kind:'captionWord'}> | null) => void };

export function CaptionWords({ track, scale, time, duration, fps, busy, blocks, inspect, seek, save, preview, error }: Props) {
  const cache = useRef<{ track: Props['track']; words: TimedCaptionWord[] }>();
  if (!cache.current || cache.current.track !== track) cache.current = { track, words: timedCaptionWords(track) };
  const words = cache.current.words;
  const lane = useRef<HTMLDivElement>(null);
  const drawing = useRef<{deps:unknown[];tree:React.ReactNode}>();
  useLayoutEffect(() => {
    const root=lane.current;if(!root)return;
    root.querySelectorAll<HTMLElement>('[data-active="true"]').forEach(node=>{node.dataset.active='false';});
    for(const word of words)if(time>=word.s && time<word.e){const node=root.querySelector<HTMLElement>(`[data-caption-word="${word.index}"]`);if(node)node.dataset.active='true';}
    root.querySelectorAll<HTMLElement>('[data-caption-block]').forEach(node=>{node.dataset.active=String(time>=Number(node.dataset.s) && time<Number(node.dataset.e));});
  },[time,track,scale]);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [retiming, setRetiming] = useState(false);
  const click = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{ pointer: number; x: number; index: number; edge: 's' | 'e'; node: HTMLElement; value: number; moved: boolean; words: TimedCaptionWord[]; scale: number } | null>(null);
  const targets = useRef<number[]>([]);
  useEffect(() => { targets.current = (track as TitleTrack & {speechOnsets?:number[]} | undefined)?.speechOnsets ?? words.filter(w => !w.estimated).flatMap(w => [w.s, w.e]); }, [words]);
  useEffect(() => { setEditing(null); }, [track]);
  useEffect(() => () => { if (click.current) clearTimeout(click.current); if (drag.current) preview(null); }, []);
  async function persist(edit: CutEdit) {
    try { const result = await save(edit); if (result === undefined || result === false) error('Could not save that word. Try again.'); }
    catch (e) { error(e instanceof Error ? e.message : 'Could not save that word. Try again.'); }
  }
  function beginEdit(word: TimedCaptionWord) { if (!busy) { seek(word.s); setEditing({ index: word.index, text: word.text }); } }
  function start(event: React.PointerEvent, word: TimedCaptionWord, edge: 's' | 'e') {
    event.preventDefault(); event.stopPropagation();
    if (busy || event.button !== 0) return;
    if (click.current) clearTimeout(click.current);
    const node = event.currentTarget.parentElement!;
    drag.current = { pointer: event.pointerId, x: event.clientX, index: word.index, edge, node, value: word[edge], moved: false, words, scale };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent) {
    const d = drag.current; if (!d || event.pointerId !== d.pointer) return;
    event.preventDefault(); event.stopPropagation();
    const word = d.words[d.index];
    d.moved ||= Math.abs(event.clientX - d.x) >= 1;
    d.value = retimeCaptionEdge(d.words, d.index, d.edge, word[d.edge] + (event.clientX - d.x) / d.scale, fps, duration, d.scale, targets.current, !event.altKey);
    const s = d.edge === 's' ? d.value : word.s, e = d.edge === 'e' ? d.value : word.e;
    if(s < (d.words[d.index-1]?.e ?? 0) - 1e-7 || e > (d.words[d.index+1]?.s ?? duration) + 1e-7) { d.value=word[d.edge]; return; }
    d.node.style.left = `${s * d.scale}px`; d.node.style.width = `${(e - s) * d.scale}px`;
    preview({ kind: 'captionWord', index: d.index, [d.edge]: d.value });
  }
  function end(event: React.PointerEvent, cancel = false) {
    const d = drag.current; if (!d || d.pointer !== event.pointerId) return;
    if (!cancel) move(event);
    drag.current = null; preview(null);
    const word = d.words[d.index];
    d.node.style.left = `${word.s * d.scale}px`; d.node.style.width = `${(word.e - word.s) * d.scale}px`;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && d.moved && d.value !== word[d.edge]) void persist({ kind: 'captionWord', index: d.index, [d.edge]: d.value });
  }
  // Readable density depends on actual speech duration, not an arbitrary zoom level.
  const detailed = words.length > 0 && (track?.cues ?? []).filter(isCaptionCue).every(cue => !!cue.words?.length) && words.filter(w => (w.e - w.s) * scale >= 24).length / words.length >= .65;
  const lineBlocks = [...new Map((track?.cues ?? []).filter(c => c.role === 'subtitle').map(c => [JSON.stringify([c.s,c.e,c.text]), { ...c, big: false }])).values()];
  const coarse = lineBlocks.length ? [...lineBlocks, ...blocks.filter(b => b.big)] : blocks;
  const estimated = words.some(w => w.estimated);
  // The clock changes only tint. Retain the 400 chip elements across scrub frames.
  const deps=[track,scale,busy,editing,retiming,blocks];
  if(!drawing.current || deps.some((value,index)=>!Object.is(value,drawing.current!.deps[index]))) drawing.current={deps,tree:<div ref={lane} className="absolute inset-0">
    {detailed ? words.map(word => <div key={word.index} role="button" tabIndex={0} data-caption-word={word.index} data-active={time >= word.s && time < word.e} data-accent={!!word.accent} data-estimated={word.estimated}
      aria-label={`${word.text}${word.estimated ? ', approximate timing' : ''}${word.accent ? ', accented' : ''}`}
      title={`${word.text}${word.estimated ? ' · Approximate timing' : ''} · Click to edit · Double-click to accent`}
      className="st-timeline-block st-timeline-caption st-caption-word absolute rounded-lg"
      style={{ left: word.s * scale, width: (word.e - word.s) * scale }}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (click.current) clearTimeout(click.current); if (event.detail < 2) click.current = setTimeout(() => { click.current = null; beginEdit(word); }, 240); }}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); if (click.current) clearTimeout(click.current); setEditing(null); if (!busy) void persist({ kind: 'captionWord', index: word.index, accent: !word.accent }); }}
      onKeyDown={event => { if (event.key === 'Enter' && !editing) { event.preventDefault(); event.stopPropagation(); beginEdit(word); } }}>
      <span className="st-caption-word-label">{word.estimated ? '≈ ' : ''}{word.text}</span>
      {(['s', 'e'] as const).map(edge => <span key={edge} data-caption-edge={edge} className="st-caption-edge" onClick={event => event.stopPropagation()} onPointerDown={event => start(event, word, edge)} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} />)}
    </div>) : coarse.map(cue => <button key={cue.id} type="button" data-caption-block data-s={cue.s} data-e={cue.e} data-big={cue.big} data-active={time >= cue.s && time < cue.e} title={`${cue.text} · Double-click to fix its words`} aria-label={cue.big ? `${cue.text} (big)` : cue.text}
      onPointerDown={event => event.stopPropagation()} onClick={() => {seek(cue.s);inspect?.(cue.id);}}
      // The Text panel opens on the first click; the second opens this caption's words there, ready to fix.
      onDoubleClick={event => { event.stopPropagation(); if (!busy) window.dispatchEvent(new CustomEvent('sidething:fix-caption', { detail: { id: cue.id } })); }} className="st-timeline-block st-timeline-caption absolute rounded-lg px-2 text-left" style={{ left: cue.s * scale, width: Math.max(2, (cue.e - cue.s) * scale) }}><span className="block truncate">{cue.text}</span></button>)}
    {editing && <input key={editing.index} data-caption-editor data-editor-widget autoFocus aria-label="Caption word" value={editing.text} maxLength={120} className="st-caption-editor absolute rounded-lg px-2" style={{ left: words[editing.index].s * scale, width: Math.max(110, (words[editing.index].e - words[editing.index].s) * scale) }}
      onFocus={event => event.currentTarget.select()} onPointerDown={event => event.stopPropagation()} onChange={event => setEditing({ ...editing, text: event.target.value })}
      onBlur={() => setEditing(null)} onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); setEditing(null); }
        if (event.key === 'Enter') { event.preventDefault(); const edit = editing; setEditing(null); if (edit.text.trim() !== words[edit.index].text) void persist({kind:'captionWord',index:edit.index,text:edit.text}); }
      }} />}
    {estimated && <button type="button" data-editor-widget disabled={busy || retiming} className="st-caption-retime sticky left-2 rounded-lg px-2" onPointerDown={event => event.stopPropagation()} onClick={async () => { setRetiming(true); try { await persist({kind:'retimeCaptions'}); } finally { setRetiming(false); } }}>{retiming ? 'Re-timing words' : 'Re-time words'}</button>}
  </div>};
  return drawing.current.tree;
}
