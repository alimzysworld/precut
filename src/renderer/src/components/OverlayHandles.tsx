import { InlineError } from "./ui";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { CutEdit, DraftTimeline, OverlayItem } from "../../../shared/schema";
import { getApi } from "../data";
import { FOCUS } from "./ui";

type Edit = (edit: CutEdit, baseVersion?: number) => void | Promise<{ cutId: string; version: number } | undefined>;
export type OverlaySession = { root: string; selected: string | null; preview: OverlayItem | null; version: number; busy: boolean; timeline: DraftTimeline; edit: Edit; seek: (time: number) => void };
type Session = OverlaySession;
const sessions = new Map<string, Session>();
const timelines = new WeakMap<DraftTimeline, Session>();
const listeners = new Set<() => void>();
let revision = 0;
const publish = () => { revision++; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useOverlaySession(timeline?: DraftTimeline | null): Session | undefined {
  const [, refresh] = useState(revision);
  useEffect(() => { const stop = subscribe(() => refresh(revision)); refresh(revision); return stop; }, []);
  return timeline ? timelines.get(timeline) : undefined;
}
export function useOverlayEditor(root: string, cutId: string | undefined, version: number, timeline: DraftTimeline | null | undefined, edit: Edit | undefined, busy: boolean, seek: (time: number) => void) {
  const latest = useRef({ edit, seek }); latest.current = { edit, seek };
  useEffect(() => {
    if (!cutId || !timeline || !edit) return;
    const key = `${root}\0${cutId}`;
    const prior = sessions.get(key);
    const newest = timeline.overlays?.find(item => !prior?.timeline.overlays?.some(old => old.id === item.id));
    const session: Session = { root, selected: newest?.id ?? (timeline.overlays?.some(item => item.id === prior?.selected) ? prior!.selected : null), preview: null, version, timeline, busy,
      edit: (change, base) => latest.current.edit?.(change, base), seek: t => latest.current.seek(t) };
    sessions.set(key, session); timelines.set(timeline, session); publish();
    return () => { if (timelines.get(timeline) === session) { timelines.delete(timeline); publish(); } };
  }, [root, cutId, version, timeline, edit !== undefined, busy]);
  return useOverlaySession(timeline);
}
export function previewOverlay(session: Session, item: OverlayItem | null) { session.preview=item; publish(); }
export function selectOverlay(session: Session, id: string) {
  session.selected = id; session.preview = null;
  const item = session.timeline.overlays?.find(item => item.id === id);
  if (item) session.seek(Math.min(item.e - .001, item.s + .3));
  publish();
}
export async function addOverlayFiles(session: Session, files: string[], time: number) {
  if (session.busy) return;
  let base = session.version;
  for (const source of files) {
    const result = await session.edit({ kind: "overlay", op: "add", source, item: { s: time, e: time + 2, x: .5, y: .42, w: .7, corner: "round", enter: "pop", exit: "fade", sound: "pop" } }, base);
    if (!result) break;
    base = result.version;
  }
}

export function OverlayHandles({ timeline, time, pause }: { timeline: DraftTimeline; time: number; pause: () => void }) {
  const session = useOverlaySession(timeline);
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; item: OverlayItem; resize: boolean; width: number; height: number } | null>(null);
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const selected = timeline.overlays?.find(item => item.id === session?.selected);
  const shown = session?.preview ?? selected;
  const active = !!shown && time >= shown.s && time < shown.e && shown.graphic?.frame !== "full";
  function start(event: PointerEvent<HTMLButtonElement>, resize: boolean) {
    if (!session || session.busy || !shown || !container.current) return;
    event.preventDefault(); event.stopPropagation(); pause();
    const rect = container.current.getBoundingClientRect();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, item: shown, resize, width: rect.width, height: rect.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || !session || d.id !== event.pointerId) return;
    const dx = (event.clientX - d.x) / d.width, dy = (event.clientY - d.y) / d.height;
    session.preview = d.resize ? { ...d.item, w: Math.max(.05, Math.min(1, d.item.w + dx * 2)) }
      : { ...d.item, x: Math.max(0, Math.min(1, d.item.x + dx)), y: Math.max(0, Math.min(1, d.item.y + dy)) };
    publish();
  }
  function end(event: PointerEvent<HTMLButtonElement>, cancel = false) {
    const d = drag.current;
    if (!d || !session || d.id !== event.pointerId) return;
    drag.current = null;
    const item = session.preview;
    session.preview = null; publish();
    if (!cancel && item && (item.x !== d.item.x || item.y !== d.item.y || item.w !== d.item.w)) void session.edit({ kind: "overlay", op: "update", id: item.id, patch: { x: item.x, y: item.y, w: item.w } });
  }
  const handlers = { onPointerMove: move, onPointerUp: (e: PointerEvent<HTMLButtonElement>) => end(e), onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => end(e, true), onLostPointerCapture: (e: PointerEvent<HTMLButtonElement>) => end(e, true) };
  return <div ref={container} className="pointer-events-none absolute inset-0 z-[5]" onDragOver={event => {
    if (session && !session.busy && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  }} onDrop={event => {
    if (!session || session.busy) return;
    event.preventDefault(); event.stopPropagation();
    const paths = Array.from(event.dataTransfer.files).map(file => getApi().pathForFile(file)).filter(Boolean);
    if (!paths.length) { setError("Drop images in the desktop app, or use Add image."); return; }
    setError(null); void addOverlayFiles(session, paths, time).catch(e => setError(e instanceof Error ? e.message : "Couldn't add the images."));
  }}>
    {/* The drop target covers the picture, leaving controls above it. */}
    {session ? <div className="pointer-events-auto absolute inset-0" aria-label="Drop images on the player" /> : null}
    {(timeline.overlays ?? []).map(item => <img key={item.id} src={item.url} alt="" className="hidden" onLoad={event => {
      const image = event.currentTarget; setAspects(prior => prior[item.id] === image.naturalWidth / image.naturalHeight ? prior : { ...prior, [item.id]: image.naturalWidth / image.naturalHeight });
    }} />)}
    {session && shown && active && aspects[shown.id] ? <div className="absolute" style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.w * 100}%`, aspectRatio: aspects[shown.id], transform: `translate(-50%, -50%) rotate(${shown.rotate ?? 0}deg)` }}>
      <button type="button" aria-label="Move selected image" disabled={session.busy} onPointerDown={event => start(event, false)} {...handlers}
        onKeyDown={event => { if (!event.key.startsWith("Arrow")) return; event.preventDefault(); const step = event.shiftKey ? .05 : .01; void session.edit({ kind: "overlay", op: "update", id: shown.id, patch: { x: shown.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), y: shown.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) } }); }}
        className={`pointer-events-auto absolute inset-0 cursor-move rounded outline outline-1 outline-white/80 ${FOCUS}`} style={{ touchAction: "none", background: "transparent" }} />
      <button type="button" aria-label="Resize selected image" disabled={session.busy} onPointerDown={event => start(event, true)} {...handlers}
        onKeyDown={event => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); void session.edit({ kind: "overlay", op: "update", id: shown.id, patch: { w: shown.w + (event.key === "ArrowRight" ? .02 : -.02) } }); }}
        className={`pointer-events-auto absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-full bg-white ${FOCUS}`} style={{ touchAction: "none" }} />
    </div> : null}
    {error ? <InlineError className="absolute inset-x-2 top-12 rounded bg-black/80 p-2 text-micro text-white">{error}</InlineError> : null}
  </div>;
}
