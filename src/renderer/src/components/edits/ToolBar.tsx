import { useRef, useState } from "react";
import { Duplicate, Split, Delete, Icon, type IconProps } from "../icons";

// VO7-8: Select and Blade in precut's own stroke family (the timeline uses no other icon set).
function Pointer(props: IconProps) { return <Icon {...props}><path d="M6.5 4.5 18 11l-5.2 1.6L10 18z" /></Icon>; }
function Blade(props: IconProps) { return <Icon {...props}><path d="M4.5 19.5 16.8 7.2a2.1 2.1 0 0 1 3 3L8 19.5z" /><path d="M11 13.5l2.5 2.5" /></Icon>; }
import { shortcutKeys } from "../../hooks/useShortcuts";
import { FOCUS, Tile } from "../ui";

export function readPane<T>(key: string, fallback: T): T {
  try { const value = window.localStorage.getItem(`sidething.edits.${key}`); return value === null ? fallback : JSON.parse(value); } catch { return fallback; }
}
export function savePane(key: string, value: unknown) {
  try { window.localStorage.setItem(`sidething.edits.${key}`, JSON.stringify(value)); } catch { /* Session remains usable without storage. */ }
}
export function usePane(key: string, fallback: number, min: number, max: number) {
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const [value, setValue] = useState(() => clamp(readPane(key, fallback)));
  return [value, (next: number) => { const safe = clamp(next); setValue(safe); savePane(key, safe); }] as const;
}
export function PaneHandle({ label, value, onChange, min, max, reset, horizontal = false, reverse = false }: {
  label: string; value: number; onChange: (value: number) => void; min: number; max: number; reset: number; horizontal?: boolean; reverse?: boolean;
}) {
  const drag = useRef<{ id: number; start: number; value: number } | null>(null);
  const change = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  return <div data-editor-widget role="separator" tabIndex={0} aria-label={label} aria-orientation={horizontal ? "horizontal" : "vertical"} aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max}
    onDoubleClick={() => change(reset)} onKeyDown={event => {
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
      if (direction) { event.preventDefault(); event.stopPropagation(); change(value + direction * (reverse ? -1 : 1) * 16); }
      if (event.key === "Home") { event.preventDefault(); change(reset); }
    }} onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); drag.current = { id: event.pointerId, start: horizontal ? event.clientY : event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => { const d = drag.current; if (d?.id === event.pointerId) change(d.value + ((horizontal ? event.clientY : event.clientX) - d.start) * (reverse ? -1 : 1)); }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { const d = drag.current; drag.current = null; if (d) change(d.value); }} onLostPointerCapture={() => { drag.current = null; }}
    className={`shrink-0 rounded-full hover:bg-accent/15 focus-visible:bg-accent/15 ${horizontal ? "h-2 w-full cursor-row-resize" : "h-full w-2 cursor-col-resize"} ${FOCUS}`} style={{ touchAction: "none" }} />;
}
export type TimelineTool = "select" | "blade";
/** VO7-8: Select (A) and Blade (B) toggle like Resolve's, with a soft fill on the active one. Trim is a
 * drag on an edge (in and out stay in the piece panel as Clip details), so it has no button here. */
export function ToolBar({ disabled, canSplit, canRemove, onSplit, onRemove, onDuplicate, tool = "select", onTool }: {
  onDuplicate?: () => void; disabled: boolean; canSplit: boolean; canRemove: boolean; onSplit: () => void; onRemove: () => void;
  tool?: TimelineTool; onTool?: (tool: TimelineTool) => void;
}) {
  const modes = [
    { id: "select" as const, label: "Select", icon: Pointer, keys: "A" },
    { id: "blade" as const, label: "Blade", icon: Blade, keys: "B" },
  ];
  const tools = [
    { id: "split", label: "Split", icon: Split, reason: !canSplit ? "Select a piece to split" : "", keys: "S / Cmd+B", action: onSplit },
    { id: "duplicate", label: "Duplicate", icon: Duplicate, reason: !onDuplicate ? "Select a piece to duplicate" : "", keys: "Cmd+D", action: onDuplicate },
    { id: "remove", label: "Delete", icon: Delete, reason: !canRemove ? "Select a piece" : "", keys: "Delete / Backspace", action: onRemove },
  ];
  return <div role="toolbar" aria-label="Edit tools" className="st-timeline-tools">
    {onTool && modes.map(mode => { const keys = shortcutKeys(`tool-${mode.id}`, "precuts") ?? mode.keys, on = tool === mode.id;
      return <Tile key={mode.id} type="button" data-timeline-tool={mode.id} aria-pressed={on} title={`${mode.label} (${keys})`} aria-label={mode.label} onClick={() => onTool(mode.id)}
        className={`st-timeline-tool ${on ? "bg-accent/15 text-accent" : ""} ${FOCUS}`}><mode.icon size={15} /><span>{mode.label}</span></Tile>; })}
    {tools.map(tool => { const reason = disabled ? "Wait for this edit to finish saving" : tool.reason; const keys = shortcutKeys(tool.id, "precuts") ?? tool.keys;
      return <button key={tool.id} type="button" disabled={!!reason} title={`${tool.label} (${keys})${reason ? `: ${reason}` : ""}`} aria-label={tool.label} onClick={tool.action}
        className={`st-timeline-tool ${FOCUS}`}><tool.icon size={15} /><span>{tool.label}</span></button>; })}
  </div>;
}
