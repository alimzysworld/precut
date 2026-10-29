import { useRef, useState } from "react";
import type { CutEdit, OverlayItem } from "../../../../shared/schema";
import { FOCUS } from "../ui";
import { Image } from "../icons";
import { retimeOverlay } from "./model";
export function OverlayBlock({ item, duration, scale, busy, onEdit, onSelect }: {
  item: OverlayItem; duration: number; scale: number; busy: boolean; onEdit: (edit: CutEdit) => void; onSelect: (id: string) => void;
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
  return <div data-editor-widget data-overlay-block={item.id} className="st-timeline-block st-timeline-overlay absolute flex overflow-hidden rounded-lg" style={{ left: shown.s * scale, width: Math.max(4, (shown.e - shown.s) * scale) }}>
    {(["start", "move", "end"] as const).map(mode => <button key={mode} type="button" disabled={busy} aria-label={`${mode === "move" ? "Move" : mode === "start" ? "Trim start of" : "Trim end of"} overlay ${item.id}`} onPointerDown={event => begin(event, mode)} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} onClick={() => onSelect(item.id)}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation(); const patch = retimeOverlay(item, mode, (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : .1), duration);
        if (patch.s !== item.s || patch.e !== item.e) onEdit({ kind: "overlay", op: "update", id: item.id, patch });
      }} className={`${mode === "move" ? "min-w-0 flex-1 cursor-grab truncate text-left text-micro" : "w-2 shrink-0 cursor-ew-resize bg-accent/10"} ${FOCUS}`} style={{ touchAction: "none" }}>{mode === "move" ? <><Image size={13} className="mr-1 inline shrink-0" />{item.file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "")}</> : ""}</button>)}
  </div>;
}
