import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Clip, Shoot } from '../../../shared/schema';
import { clipTurn, quarterTurn } from '../../../shared/media';
import type { HistoryStep } from '../hooks/useEditHistory';
import { useShortcuts } from '../hooks/useShortcuts';
import { getApi } from '../data';
import { ContextMenu } from './ContextMenu';
import { InlineError, MenuOption } from './ui';
import { rotationItems, observeRotationShoot, previewRotation, rotationClip, rotationRevision, subscribeRotation } from './clipRotation';

export { rotationItems } from "./clipRotation";
const queues = new Map<string, Promise<unknown>>();
export function ClipMenu({ shoot, onShootChange, history, children, onReplace, canReplace, onAutoCorrect, onShotOrder, onShowWhatISay, selectedClipIds = [] }: {
  onShowWhatISay?: (piece: number) => void;  // BROLL2: cutaways for what is said over these clips
  selectedClipIds?: string[];
  onShotOrder?: (piece: number) => void;
  onAutoCorrect?: (piece: number) => Promise<unknown>;
  onReplace?: (piece: number, anchor: HTMLElement) => void; canReplace?: (piece: number) => boolean;
  shoot: Shoot; onShootChange: (shoot: Shoot) => void; history?: { stage: (step: HistoryStep) => void }; children: ReactNode;
}) {
  const [context, setContext] = useState<{ id: string; x: number; y: number; target: HTMLElement }>();
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<HistoryStep>();
  useShortcuts('clips', [{ id: 'clip-rotation-undo', scope: 'clips', keys: ['Cmd+z'], label: 'Undo clip rotation', enabled: !!undo,
    handler: () => { undo?.undo(); setUndo(undefined); } }], !history);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const latest = useRef(shoot); latest.current = shoot;
  useSyncExternalStore(subscribeRotation, rotationRevision);
  useEffect(() => { observeRotationShoot(shoot); }, [shoot]);
  function save(id: string, tag: Clip['byHand']) {
    const base = rotationClip(shoot.root, id, latest.current.clips.find(c => c.id === id));
    if (!base) return;
    const { rotate: _old, ...otherTags } = base.byHand ?? {};
    const byHand = { ...otherTags, ...(tag?.rotate === undefined ? {} : { rotate: tag.rotate }) };
    const clear = previewRotation(shoot.root, { ...base, byHand });
    // Writes are ordered even when turns/Undo arrive before the previous save finishes.
    const previous = queues.get(shoot.root) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const fresh = await getApi().loadShoot(shoot.root);
      const { rotate: _old, ...other } = fresh?.clips.find(c => c.id === id)?.byHand ?? {};
      const nextTag = { ...other, ...(tag?.rotate === undefined ? {} : { rotate: tag.rotate }) };
      return getApi().setClipTag(shoot.root, id, Object.keys(nextTag).length ? nextTag : null);
    });
    queues.set(shoot.root, task);
    void task.then(next => { observeRotationShoot(next); if (mounted.current && latest.current.root === next.root) onShootChange(next); }, e => setError(e instanceof Error ? e.message : 'Could not turn this clip.')).finally(() => { clear(); if (queues.get(shoot.root) === task) queues.delete(shoot.root); });
  }
  function turn(label: string) {
    if (!context) return;
    const clip = rotationClip(shoot.root, context.id, shoot.clips.find(c => c.id === context.id));
    if (!clip) return;
    const before = clip.byHand, after = { ...before, rotate: label === 'Back to original' ? 0 as const : quarterTurn(clipTurn(clip) + (label === 'Rotate right' ? 90 : -90)) };
    setError(''); setContext(undefined); save(clip.id, after);
    const step = { label: 'Rotate clip', undo: () => save(clip.id, before), redo: () => save(clip.id, after) };
    if (history) history.stage(step); else setUndo(step);
  }
  async function changeIncluded() {
    if (!context) return;
    const clip = latest.current.clips.find(c => c.id === context.id);
    if (!clip) return;
    const ids = selectedClipIds.includes(clip.id) ? [...new Set(selectedClipIds)] : [clip.id];
    setContext(undefined); setError('');
    try { const next = await getApi().leaveOut(shoot.root, ids, !clip.leftOut); if (mounted.current && latest.current.root === next.root) onShootChange(next); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Could not change these clips.'); }
  }
  const clip = context && rotationClip(shoot.root, context.id, shoot.clips.find(c => c.id === context.id));
  return <div className="contents" onContextMenu={event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-clip-menu]');
    if (!target || !shoot.clips.some(c => c.id === target.dataset.clipMenu)) return;
    event.preventDefault(); event.stopPropagation();
    setContext({ id: target.dataset.clipMenu!, x: event.clientX, y: event.clientY, target });
  }} onKeyDown={event => {
    if (!(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-clip-menu]');
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); const box = target.getBoundingClientRect();
    setContext({ id: target.dataset.clipMenu!, x: box.left, y: box.bottom, target });
  }}>
    {children}
    {context && clip && <ContextMenu x={context.x} y={context.y} label="Clip actions" onClose={() => setContext(undefined)} returnFocus={context.target}>
      {context.target.dataset.replacePiece !== undefined && canReplace?.(Number(context.target.dataset.replacePiece)) ? <MenuOption type="button" role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left text-small outline-none hover:bg-ink/[0.06] focus:bg-ink/[0.08]" onClick={() => { onReplace?.(Number(context.target.dataset.replacePiece), context.target); setContext(undefined); }}>Replace</MenuOption> : null}
      {context.target.dataset.replacePiece !== undefined && onAutoCorrect ? <MenuOption type="button" role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left text-small hover:bg-ink/[0.06] focus:bg-ink/[0.08]" onClick={() => { const piece=Number(context.target.dataset.replacePiece); setContext(undefined); void onAutoCorrect(piece).catch(e=>setError(e instanceof Error ? e.message : "Could not auto correct. Try again.")); }}>Auto correct this clip</MenuOption> : null}
      {context.target.dataset.replacePiece !== undefined && onShotOrder ? <MenuOption type="button" role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left text-small hover:bg-ink/[0.06] focus:bg-ink/[0.08]" onClick={()=>{onShotOrder(Number(context.target.dataset.replacePiece));setContext(undefined);}}>Put in shot order</MenuOption> : null}
      {context.target.dataset.replacePiece !== undefined && onShowWhatISay ? <MenuOption type="button" role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left text-small outline-none hover:bg-ink/[0.06] focus:bg-ink/[0.08]" onClick={() => { onShowWhatISay(Number(context.target.dataset.replacePiece)); setContext(undefined); }}>Show what I say here</MenuOption> : null}
      {rotationItems(clip).map(label => <MenuOption key={label} type="button" role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left text-small hover:bg-ink/[0.06] focus:bg-ink/[0.08] outline-none" onClick={() => turn(label)}>{label}</MenuOption>)}
      <MenuOption type="button" role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left text-small hover:bg-ink/[0.06] focus:bg-ink/[0.08] outline-none" onClick={() => void changeIncluded()}>{clip.leftOut ? 'Put back' : 'Leave out of this video'}</MenuOption>
    </ContextMenu>}
    {error && <InlineError className="fixed bottom-4 left-4 z-[90] rounded-xl bg-surface p-3 text-small text-danger">{error}</InlineError>}
    {undo && <div role="status" className="st-pop fixed bottom-4 left-4 z-[90] flex gap-3 rounded-xl p-3 text-small">Clip turned<button type="button" className="rounded px-2 text-accent outline-none hover:bg-ink/[0.06] focus:bg-ink/[0.08]" onClick={() => { undo.undo(); setUndo(undefined); }}>Undo</button></div>}
  </div>;
}
