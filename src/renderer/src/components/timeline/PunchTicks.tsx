import { useRef, useState } from "react";
import type { CutEdit, DraftTimeline, PieceFx } from "../../../../shared/schema";
import { punchSourceAt, punchTimeOf } from "../../../../shared/punch-keys";
import { FOCUS } from "../ui";

// CAP4: a tick on the clip block for each of its punches, where it lands. Drag one along the clip to move it (it snaps
// to a caption word's start within a few pixels; hold Option for any frame); arrow keys move it a frame. The drop is
// the clip's settings with that punch on its new source frame: one pieceFx edit, one undoable version, the record
// set_clip_punch and the inspector's Punch row write (shared/punch-keys.ts). MOT1b's element ticks work the same way.

/** Where a dragged tick lands: the nearest word start within 8 px (free with Option), on the edit's frame clock. */
export function snapPunch(t: number, lo: number, hi: number, fps: number, words: readonly number[], scale: number, free: boolean): number {
  const at = Math.max(lo, Math.min(hi, t));
  const word = free ? undefined : words.filter(s => s >= lo && s <= hi && Math.abs(s - at) * scale <= 8).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
  return Math.max(lo, Math.min(hi, Math.ceil(((word ?? at) - 1e-8) * fps) / fps));
}

export function PunchTicks({ piece, fx, startS, endS, scale, timeline, words, busy, onEdit, onSelect }: {
  piece: number; fx: PieceFx | null | undefined; startS: number; endS: number; scale: number; timeline: DraftTimeline | null | undefined;
  words: readonly number[]; busy: boolean; onEdit: (edit: CutEdit) => unknown; onSelect: () => void;
}) {
  const [moving, setMoving] = useState<{ i: number; t: number } | null>(null);
  const drag = useRef<{ pointer: number; x: number; i: number; t0: number; t: number; moved: boolean } | null>(null);
  const punches = fx?.punches ?? [], spans = timeline?.pieces ?? [], fps = timeline?.fps || 30;
  if (!punches.length || !timeline || fx?.reverse) return null;
  const width = (endS - startS) * scale, last = endS - 1 / fps;
  function move(i: number, t: number) {
    if (busy) return;
    let sourceS: number;
    try { sourceS = punchSourceAt(spans, piece, t, fps); } catch { return; }
    if (Math.abs(sourceS - punches[i].sourceS) < 1e-6) return;
    const list = punches.map((p, n) => n === i ? { ...p, sourceS } : p).sort((a, b) => a.sourceS - b.sourceS);
    void onEdit({ kind: "pieceFx", piece, fx: { ...fx, punches: list } });
  }
  function pointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current; if (!d || d.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    d.moved ||= Math.abs(event.clientX - d.x) > 2;
    d.t = snapPunch(d.t0 + (event.clientX - d.x) / scale, startS, last, fps, words, scale, event.altKey);
    setMoving({ i: d.i, t: d.t });
  }
  function pointerEnd(event: React.PointerEvent<HTMLButtonElement>, cancel = false) {
    const d = drag.current; if (!d || d.pointer !== event.pointerId) return;
    if (!cancel) pointerMove(event);
    drag.current = null; setMoving(null);
    if (!cancel && d.moved) move(d.i, d.t);
  }
  return <>{punches.map((p, i) => {
    const landed = punchTimeOf(spans, piece, p.sourceS, fps);
    if (landed === null || landed < startS - 1e-6 || landed >= endS) return null;
    const t = moving?.i === i ? moving.t : landed, push = p.scale <= 1.0001;
    return <button key={`${p.sourceS}-${i}`} type="button" disabled={busy} data-punch-tick={i} data-moving={moving?.i === i || undefined}
      aria-label={`${push ? "Push" : "Punch"} ${i + 1} at ${t.toFixed(2)} s, ${p.scale.toFixed(2)}x. Drag or use arrow keys to move it`} title={`${push ? "Push" : `Punch ${p.scale.toFixed(2)}x`} · drag to move, Option for any frame`}
      onPointerDown={event => {
        if (busy || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); onSelect();
        drag.current = { pointer: event.pointerId, x: event.clientX, i, t0: landed, t: landed, moved: false };
      }} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)} onLostPointerCapture={event => pointerEnd(event, true)}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation();
        move(i, Math.max(startS, Math.min(last, landed + (event.key === "ArrowLeft" ? -1 : 1) / fps)));
      }}
      className={`st-punch-tick absolute top-[3px] z-10 h-3 w-[6px] -translate-x-1/2 cursor-ew-resize rounded-sm ${FOCUS}`}
      style={{ left: Math.max(4, Math.min(width - 4, (t - startS) * scale)), touchAction: "none" }} />;
  })}</>;
}
