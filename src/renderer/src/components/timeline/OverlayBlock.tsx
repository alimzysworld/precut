import { useRef, useState } from "react";
import type { CutEdit, OverlayItem } from "../../../../shared/schema";
import { FOCUS } from "../ui";
import { Image } from "../icons";
import { retimeOverlay } from "./model";
import { beatPosition, beatTime, elementLine, resolveMotion, wordsInSpan, type MotionElementChange } from "../../../../shared/motion";
import { graphicMotion, templateInfo } from "../../../../main/graphics/templates";
import { motionContextOf, motionUpdate, pickElement, useKept, usePickedElement, type MotionSource } from "../finish/MotionControls";

/** MOT1b: where a dragged tick lands: the nearest grid line (half beats by default, plus the offset) or word start; free
 *  with Option. Grid lines carry their beat, word starts their word, so the drop anchors the element to what it hit. */
export function snapTick(t: number, ctx: ReturnType<typeof motionContextOf>, motion: { grid: number; offsetBeats: number }, free: boolean): { t: number; change: Omit<MotionElementChange, "id"> } {
  const lo = ctx.itemS, hi = ctx.itemE - 1 / (ctx.fps || 30), at = Math.max(lo, Math.min(hi, t));
  if (free) return { t: at, change: { at: at - ctx.itemS } };
  const options: { t: number; change: Omit<MotionElementChange, "id"> }[] = wordsInSpan(ctx).filter(w => w.s <= hi).map(w => ({ t: Math.max(lo, w.s), change: { word: w.id } }));
  if (ctx.beats.length) {
    const g = motion.grid, off = motion.offsetBeats, first = Math.ceil((beatPosition(ctx.beats, lo) - off) / g - 1e-6), last = Math.floor((beatPosition(ctx.beats, hi) - off) / g + 1e-6);
    for (let n = Math.max(0, first); n <= last && n - first < 400; n++) options.push({ t: beatTime(ctx.beats, n * g + off), change: { beat: n * g } });
  }
  return options.reduce<{ t: number; change: Omit<MotionElementChange, "id"> } | null>((best, o) => !best || Math.abs(o.t - at) < Math.abs(best.t - at) ? o : best, null) ?? { t: at, change: { at: at - ctx.itemS } };
}

export function OverlayBlock({ item, duration, scale, busy, onEdit, onSelect, motion }: {
  item: OverlayItem; duration: number; scale: number; busy: boolean; onEdit: (edit: CutEdit) => void; onSelect: (id: string) => void; motion?: MotionSource | null;
}) {
  const [preview, setPreview] = useState<{ s: number; e: number } | null>(null);
  const drag = useRef<{ id: number; x: number; mode: "move" | "start" | "end"; patch: { s: number; e: number }; moved: boolean } | null>(null);
  const shown = preview ?? item;
  function begin(event: React.PointerEvent<HTMLButtonElement>, mode: "move" | "start" | "end") {
    if (busy || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    drag.current = { id: event.pointerId, x: event.clientX, mode, patch: { s: item.s, e: item.e }, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId); onSelect(item.id);
  }
  function move(event: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current; if (!d || d.id !== event.pointerId) return;
    d.patch = retimeOverlay(item, d.mode, (event.clientX - d.x) / scale, duration);
    d.moved ||= Math.abs(event.clientX - d.x) > 2; setPreview(d.patch);
  }
  function end(event: React.PointerEvent<HTMLButtonElement>, cancel = false) {
    const d = drag.current; if (!d || d.id !== event.pointerId) return;
    if (!cancel) move(event);
    drag.current = null; setPreview(null);
    if (!cancel && d.moved && (d.patch.s !== item.s || d.patch.e !== item.e)) onEdit({ kind: "overlay", op: "update", id: item.id, patch: d.patch });
  }
  // PRO5: a graphic that can sit behind the person says where it is; one asked to sit behind but drawn in front says why.
  const g = item.graphic as (OverlayItem["graphic"] & { behindNote?: string }) | null | undefined;
  // TRK1b: a pinned item says so, and when the tracker lost its thing while it is on, where and why.
  const pinned = !!item.pin, lost = item.pinKeys?.lost;
  const layerable = !!g && g.frame === "overlay", note = [g?.behindNote, lost].filter(Boolean).join(" ") || undefined;
  const word = g?.template === "key-word" ? /<div class="w">([^<]*)<\/div>/.exec(g.html)?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&") : undefined;
  // MOT1b: a scene is named for what it is ("Beat words"), not its picture file
  const name = word ?? (item.graphic && graphicMotion(item.graphic) ? templateInfo(item.graphic.template ?? "")?.name : undefined) ?? item.file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "");
  const wide = (shown.e - shown.s) * scale >= 96;
  function switchLayer() {
    if (!g || busy) return;
    const { behindNote: _note, behindCheck: _check, ...same } = g as typeof g & { behindCheck?: unknown };
    onEdit({ kind: "overlay", op: "update", id: item.id, patch: { graphic: { ...same, layer: g.layer === "behind" ? "front" : "behind" } } });
  }
  // MOT1b: a tick for each element of a motion graphic, where it lands; drag one to retime it, arrows nudge a grid step.
  const moving = useKept(() => item.graphic ? graphicMotion(item.graphic) : null, [item.graphic]);
  const ctx = useKept(() => moving ? motionContextOf(motion, item) : null, [moving, motion, item.s, item.e]);
  const landed = useKept(() => moving && ctx ? resolveMotion(moving.motion, ctx).times : [], [moving, ctx]);
  const picked = usePickedElement(item.id);
  const [tick, setTick] = useState<{ id: string; t: number } | null>(null);
  const tickDrag = useRef<{ pointer: number; x: number; id: string; t0: number; t: number; change: Omit<MotionElementChange, "id">; moved: boolean } | null>(null);
  const blockW = (shown.e - shown.s) * scale, ticks = moving && ctx && blockW >= Math.max(48, moving.motion.elements.length * 8);
  function retime(change: MotionElementChange) {
    if (!ctx || busy) return;
    try { const out = motionUpdate(item, { elements: [change] }, ctx); if (out.edit) onEdit(out.edit); } catch { /* the inspector says why */ }
  }
  function tickMove(event: React.PointerEvent<HTMLButtonElement>) {
    const d = tickDrag.current; if (!d || d.pointer !== event.pointerId || !ctx || !moving) return;
    event.preventDefault(); event.stopPropagation();
    d.moved ||= Math.abs(event.clientX - d.x) > 2;
    const snapped = snapTick(d.t0 + (event.clientX - d.x) / scale, ctx, moving.motion, event.altKey);
    d.t = snapped.t; d.change = snapped.change; setTick({ id: d.id, t: snapped.t });
  }
  function tickEnd(event: React.PointerEvent<HTMLButtonElement>, cancel = false) {
    const d = tickDrag.current; if (!d || d.pointer !== event.pointerId) return;
    if (!cancel) tickMove(event);
    tickDrag.current = null; setTick(null);
    if (!cancel && d.moved) retime({ id: d.id, ...d.change });
  }
  const tickRow = ticks ? moving!.motion.elements.map((e, i) => {
    const t = tick?.id === e.id ? tick.t : landed[i], on = picked === e.id, label = moving!.labels[i];
    return <button key={e.id} type="button" disabled={busy} data-motion-tick={e.id} data-selected={on || undefined} aria-label={`${label}: ${elementLine(moving!.motion, i, Math.max(0, landed[i] - item.s), ctx!)}`} title={`${label}: ${(t - item.s).toFixed(2)} s`}
      onPointerDown={event => {
        if (busy || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
        pickElement(item.id, e.id); onSelect(item.id);
        tickDrag.current = { pointer: event.pointerId, x: event.clientX, id: e.id, t0: landed[i], t: landed[i], change: {}, moved: false };
      }} onPointerMove={tickMove} onPointerUp={event => tickEnd(event)} onPointerCancel={event => tickEnd(event, true)} onLostPointerCapture={event => tickEnd(event, true)}
      onClick={event => event.stopPropagation()} onFocus={() => pickElement(item.id, e.id)}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation(); retime({ id: e.id, nudge: event.key === "ArrowLeft" ? -1 : 1 });
      }}
      className={`st-motion-tick absolute bottom-[3px] z-10 h-2.5 w-[5px] -translate-x-1/2 cursor-ew-resize rounded-sm ${FOCUS}`}
      style={{ left: Math.max(5, Math.min(blockW - 5, (t - item.s) * scale)), touchAction: "none" }} />;
  }) : null;
  return <div data-editor-widget data-overlay-block={item.id} data-layer={layerable ? g!.layer ?? "front" : undefined} data-behind-note={g?.behindNote} data-pinned={pinned || undefined} data-pin-note={lost} title={note} className="st-timeline-block st-timeline-overlay absolute flex overflow-hidden rounded-lg" style={{ left: shown.s * scale, width: Math.max(4, (shown.e - shown.s) * scale) }}>
    {(["start", "move", "end"] as const).map(mode => <button key={mode} type="button" disabled={busy} aria-label={`${mode === "move" ? "Move" : mode === "start" ? "Trim start of" : "Trim end of"} overlay ${item.id}`} onPointerDown={event => begin(event, mode)} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} onClick={() => onSelect(item.id)}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation(); const patch = retimeOverlay(item, mode, (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : .1), duration);
        if (patch.s !== item.s || patch.e !== item.e) onEdit({ kind: "overlay", op: "update", id: item.id, patch });
      }} className={`${mode === "move" ? "min-w-0 flex-1 cursor-grab truncate text-left text-micro" : "w-2 shrink-0 cursor-ew-resize bg-accent/10"} ${FOCUS}`} style={{ touchAction: "none" }}>{mode === "move" ? <><Image size={13} className="mr-1 inline shrink-0" />{note ? `${name ? `${name}. ` : ""}${note}` : name}</> : ""}</button>).flatMap((button, i) => i === 1 && layerable && wide
      ? [button, <button key="layer" type="button" disabled={busy} data-overlay-layer={item.id} aria-label={note ? `Put ${name ?? "it"} behind you again` : g!.layer === "behind" ? `Put ${name ?? "it"} in front of you` : `Put ${name ?? "it"} behind you`}
        onClick={event => { event.stopPropagation(); switchLayer(); }} className={`my-0.5 shrink-0 rounded px-1.5 text-micro ${g!.layer === "behind" ? "bg-accent/25 text-accent" : "bg-white/10 text-muted"} transition-colors hover:bg-accent/30 focus-visible:bg-accent/30 ${FOCUS}`}>{g!.layer === "behind" ? "Behind" : "In front"}</button>]
      : [button]).flatMap((button, i) => i === 1 && pinned && wide
      ? [button, <span key="pin" data-overlay-pin={item.id} className="my-0.5 mr-1 flex shrink-0 items-center rounded bg-white/10 px-1.5 text-micro text-muted">Pinned</span>] : [button])}
    {tickRow}
  </div>;
}
