import { useRef, useState } from "react";
import { Duplicate, Split, Delete, Icon, type IconProps } from "../icons";

// VO7-8: Select and Blade in precut's own stroke family (the timeline uses no other icon set).
function Pointer(props: IconProps) { return <Icon {...props}><path d="M6.5 4.5 18 11l-5.2 1.6L10 18z" /></Icon>; }
function Blade(props: IconProps) { return <Icon {...props}><path d="M4.5 19.5 16.8 7.2a2.1 2.1 0 0 1 3 3L8 19.5z" /><path d="M11 13.5l2.5 2.5" /></Icon>; }
// CH4: the timeline's switches, drawn on the same 24 px grid and 1.5 stroke.
export function Magnet(props: IconProps) { return <Icon {...props}><path d="M6 4.5v7.5a6 6 0 0 0 12 0V4.5h-3.5V12a2.5 2.5 0 0 1-5 0V4.5Z" /><path d="M6 8h3.5M14.5 8H18" /></Icon>; }
export function CloseGap(props: IconProps) { return <Icon {...props}><path d="M4 6v12M20 6v12M7 12h3.5m-1.8-2 1.8 2-1.8 2M17 12h-3.5m1.8-2-1.8 2 1.8 2" /></Icon>; }
export function AudioScrub(props: IconProps) { return <Icon {...props}><path d="M3.5 12h1M6.5 9.5v5M9 7v10M15 8v8M17.5 10v4M20 11.5v1" /><path d="M12 3.5v17" /></Icon>; }
export function FitView(props: IconProps) { return <Icon {...props}><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></Icon>; }
import { shortcutKeys } from "../../hooks/useShortcuts";
import { FOCUS, Tile } from "../ui";
import { Tooltip } from "../ui/InfoTip";

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
export function PaneHandle({ label, value, onChange, min, max, reset, horizontal = false, reverse = false, className, title }: {
  label: string; value: number; onChange: (value: number) => void; min: number; max: number; reset: number; horizontal?: boolean; reverse?: boolean;
  /** CH2: replaces the handle's look (the Claude gutter is a band of tone, not a pill). */
  className?: string; title?: string;
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
      // POLISH1: the drag follows the window's pointer, so a handle that moves with what it resizes (Claude's line)
      // never drops it; data-dragging holds the "while dragging" fill.
      event.preventDefault();
      const handle = event.currentTarget, d = { id: event.pointerId, start: horizontal ? event.clientY : event.clientX, value };
      drag.current = d; handle.setAttribute("data-dragging", "");
      try { handle.setPointerCapture(event.pointerId); } catch { /* the window listeners carry the drag */ }
      const move = (e: PointerEvent) => { if (drag.current === d && e.pointerId === d.id) change(d.value + ((horizontal ? e.clientY : e.clientX) - d.start) * (reverse ? -1 : 1)); };
      const end = (e: PointerEvent) => {
        if (e.pointerId !== d.id) return;
        if (e.type === "pointercancel" && drag.current === d) change(d.value);
        if (drag.current === d) drag.current = null;
        handle.removeAttribute("data-dragging");
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
    }}
    title={title} className={`${className ?? `shrink-0 rounded-full hover:bg-accent/15 focus-visible:bg-accent/15 ${horizontal ? "h-2 w-full cursor-row-resize" : "h-full w-2 cursor-col-resize"}`} ${FOCUS}`} style={{ touchAction: "none" }} />;
}
export type TimelineTool = "select" | "blade";
const GLYPHS: Record<string, string> = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", delete: "⌫", backspace: "⌫", escape: "Esc", space: "Space", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", "-": "−" };
/** CH4: a registered binding as the Mac writes it ("Cmd+Shift+z" is ⇧⌘Z), the first of several. */
export function keyGlyphs(keys?: string): string | undefined {
  const first = keys?.split(" / ")[0];
  if (!first) return undefined;
  const parts = first.split("+"), key = parts.at(-1)!.toLowerCase(), mods = parts.slice(0, -1).map(m => m.toLowerCase());
  return ["ctrl", "alt", "shift", "cmd"].filter(m => mods.includes(m)).map(m => GLYPHS[m]).join("") + (GLYPHS[key] ?? key.toUpperCase());
}
/** VO7-8: Select (A) and Blade (B) toggle like Resolve's. CH4: one segmented pair, the active one a neutral fill
 * (never blue); Split, Duplicate and Delete are icons that dim in place, so selecting a clip moves nothing. Trim is
 * a drag on an edge (in and out stay in the piece panel as Clip details), so it has no button here. */
export function ToolBar({ disabled, canSplit, canRemove, onSplit, onRemove, onDuplicate, tool = "select", onTool }: {
  onDuplicate?: () => void; disabled: boolean; canSplit: boolean; canRemove: boolean; onSplit: () => void; onRemove: () => void;
  tool?: TimelineTool; onTool?: (tool: TimelineTool) => void;
}) {
  const modes = [
    { id: "select" as const, label: "Select", icon: Pointer, keys: "A" },
    { id: "blade" as const, label: "Blade", icon: Blade, keys: "B" },
  ];
  const tools = [
    { id: "split", label: "Split", tip: "Split at playhead", icon: Split, ready: canSplit, keys: shortcutKeys("split-cmd-b", "precuts") ?? shortcutKeys("split", "precuts") ?? "Cmd+b", action: onSplit },
    { id: "duplicate", label: "Duplicate", tip: "Duplicate", icon: Duplicate, ready: !!onDuplicate, keys: shortcutKeys("duplicate", "precuts") ?? "Cmd+d", action: onDuplicate },
    { id: "remove", label: "Delete", tip: "Delete", icon: Delete, ready: canRemove, keys: shortcutKeys("remove", "precuts") ?? "Backspace", action: onRemove },
  ];
  return <div role="toolbar" aria-label="Edit tools" className="st-timeline-tools st-timeline-edit-tools">
    {onTool && <div role="group" aria-label="Timeline tool" className="st-timeline-seg">{modes.map(mode => { const on = tool === mode.id;
      return <Tooltip key={mode.id} label={mode.label} shortcut={keyGlyphs(shortcutKeys(`tool-${mode.id}`, "precuts") ?? mode.keys)}><Tile type="button" data-timeline-tool={mode.id} aria-pressed={on} aria-label={mode.label} onClick={() => onTool(mode.id)}
        className={`st-timeline-seg-button ${FOCUS}`}><mode.icon size={14} /><span>{mode.label}</span></Tile></Tooltip>; })}</div>}
    <div className="st-timeline-group">{tools.map(tool => { const reason = disabled ? "waits for the save to finish" : tool.ready ? "" : "select a piece first";
      return <Tooltip key={tool.id} label={tool.tip} state={reason || undefined} shortcut={keyGlyphs(tool.keys)}><button type="button" data-timeline-action={tool.id} disabled={!!reason} aria-label={tool.label} onClick={tool.action}
        className={`st-timeline-icon ${FOCUS}`}><tool.icon size={16} /></button></Tooltip>; })}</div>
  </div>;
}
