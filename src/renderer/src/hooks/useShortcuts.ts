import { useEffect,useRef,useState } from "react";
import { usePageActive } from "./usePageActivity";

export type Shortcut = { id: string; keys: string[]; label: string; scope: string;
  handler: (event: KeyboardEvent) => void; enabled?: boolean; repeat?: boolean; inDialog?: boolean };
export function isShortcutTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [data-transcript], [data-ask-composer], [role='dialog'], [role='menu'], [role='tablist'], [aria-haspopup='menu'], [data-editor-widget]");
}
function matches(event: KeyboardEvent, binding: string) {
  const parts = binding.toLowerCase().split("+");
  const key = parts.at(-1);
  return event.metaKey === parts.includes("cmd") && event.ctrlKey === parts.includes("ctrl") &&
    event.altKey === parts.includes("alt") && (key === "?" || event.shiftKey === parts.includes("shift")) &&
    (key === "space" ? event.code === "Space" || event.key === " " : event.key.toLowerCase() === key);
}
/** Exported separately so screens and tests use exactly the same dispatch rules. */
export function dispatchShortcut(event: KeyboardEvent, shortcuts: Shortcut[], scope: string): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  // Let the open hint dismiss before Escape reaches a panel or editor action.
  if (event.key === "Escape" && (event.target as Node | null)?.ownerDocument?.querySelector("[data-precut-tooltip]")) return false;
  // Terminal UI owns all keys, including Escape, /, model commands and Cmd-K.
  // Only the explicitly registered terminal clear action and Claude's show/hide (CH2, ⌘L) can intercept one.
  // xterm's own hidden textarea does not count as a text field; any other field does.
  const target = event.target as HTMLElement | null;
  if (target?.closest?.("[data-ask-terminal]") && !target.closest("input, select, textarea:not(.xterm-helper-textarea), [contenteditable]:not([contenteditable='false']), [role='textbox']")) {
    const clear = shortcuts.find(s => (s.id === "terminal-clear" || s.id === "claude-toggle") && s.enabled !== false && s.keys.some(key => matches(event, key)));
    if (!clear) return false;
    event.preventDefault(); clear.handler(event); return true;
  }
  const dialogKey = !target?.closest?.("input, textarea, select, [contenteditable], [role='menu']") && !!target?.closest?.("[role='dialog']") && shortcuts.some(s => s.inDialog && s.enabled !== false && s.keys.some(key => matches(event, key)));
  const globalSearch = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
  // CH2: ⌘L shows or hides Claude from anywhere, a text field included, like ⌘K.
  const claudeKey = shortcuts.some(s => s.id === "claude-toggle" && s.enabled !== false && s.keys.some(key => matches(event, key)));
  // 0.9: ⌘E exports from anywhere, Claude's composer included (it is always on screen now); ⌘E edits no text.
  const exportKey = event.metaKey && shortcuts.some(s => s.id === "export" && s.enabled !== false && s.keys.some(key => matches(event, key)));
  const sheetKey = shortcuts.some(s => s.id.startsWith("panel-") && s.keys.some(key => matches(event, key)));
  const field = !!(event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='dialog'], [role='menu']");
  const panelKey = sheetKey && !field;
  const bypassField = !!target?.closest?.("input:not([type=range]), textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='dialog'], [role='menu']");
  const lookKey = shortcuts.some(s => (s.id === "clipping-preview" && !field || s.id === "bypass-look" && !bypassField) && s.enabled !== false && s.keys.some(key => matches(event, key)));
  const zoomKey = !bypassField && shortcuts.some(s => (s.id === "zoom-fit" || s.id === "viewer-pan-space") && s.enabled !== false && s.keys.some(key => matches(event, key)));
  const timelineKey = !bypassField && !!target?.closest?.('[data-editor-timeline]') && shortcuts.some(s=>(s.id==='timeline-snapping' || s.id==='timeline-audio-scrub' || s.id.startsWith('timeline-select') || s.id==='timeline-clear-selection' || s.id==='mute-clip-sound' || s.id==='remove' || s.id==='duplicate') && s.enabled!==false && s.keys.some(key=>matches(event,key)));
  const textField = !!(event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
  const transcriptKey = !textField && !!(event.target as HTMLElement | null)?.closest?.("[data-transcript]") && shortcuts.some(s => s.id === "transcript-bleep" && s.enabled !== false && s.keys.some(key => matches(event, key)));
  const pageKey = !textField && shortcuts.some(s => s.scope === "global" && s.id.startsWith("page-") && s.keys.some(key => matches(event, key)));
  const source = [...shortcuts].reverse().find(s=>s.id.startsWith('source-') && s.enabled !== false && s.scope === scope && (!event.repeat || s.repeat) && s.keys.some(key=>matches(event,key)));
  // VO7-14: the take viewer sits inside the edit's panel (an editor widget), yet while it has focus its keys win.
  const takeViewer = !!target?.closest?.('[data-take-viewer]') && !target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
  if(source && (!isShortcutTyping(event.target) || !!target?.closest?.('[data-source-handle]') || takeViewer && source.id.startsWith('source-take-'))) { event.preventDefault();source.handler(event);return true; }
  // The open library owns card navigation and search, including Esc from its search field.
  const library = [...shortcuts].reverse().find(s => s.id.startsWith("library-") && s.enabled !== false && s.scope === scope && (!event.repeat || s.repeat) && s.keys.some(key => matches(event, key)));
  if (library && (!isShortcutTyping(event.target) || library.id === "library-close" || library.id === "library-search" && event.metaKey)) {
    event.preventDefault(); library.handler(event); return true;
  }
  if (isShortcutTyping(event.target) && !globalSearch && !claudeKey && !exportKey && !panelKey && !pageKey && !lookKey && !zoomKey && !timelineKey && !transcriptKey && !dialogKey) return false;
  const ordered = [...shortcuts.filter(s => s.id !== "clipping-preview" && s.id !== "cancel-timeline-drag" && s.id !== "timeline-clear-selection" && s.id !== "viewer-pan-space"), ...shortcuts.filter(s => s.id === "clipping-preview"), ...shortcuts.filter(s => s.id === "viewer-pan-space"), ...shortcuts.filter(s => s.id === "timeline-clear-selection"), ...shortcuts.filter(s => s.id === "cancel-timeline-drag")];
  const shortcut = ordered.reverse().find(s => s.enabled !== false && (s.scope === scope || s.scope === "global") &&
    (!isShortcutTyping(event.target) || timelineKey && (s.id==='timeline-snapping' || s.id==='timeline-audio-scrub' || s.id.startsWith('timeline-select') || s.id==='timeline-clear-selection' || s.id==='mute-clip-sound' || s.id==='remove' || s.id==='duplicate') || zoomKey && (s.id === "zoom-fit" || s.id === "viewer-pan-space") || dialogKey && s.inDialog || transcriptKey && s.id === "transcript-bleep" || lookKey && (s.id === "clipping-preview" || s.id === "bypass-look") || pageKey && s.id.startsWith("page-") || panelKey && s.id.startsWith("panel-") || s.scope === "global" && s.id === "command-search" || claudeKey && s.id === "claude-toggle" || exportKey && s.id === "export") &&
    (!event.repeat || s.repeat) && s.keys.some(key => matches(event, key)));
  if (!shortcut) return false;
  event.preventDefault(); shortcut.handler(event); return true;
}
const registrations = new Map<symbol, Shortcut[]>(), listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());
export function registeredShortcuts(scope: string): Shortcut[] {
  return [...registrations.values()].flat().filter(s => s.scope === scope || s.scope === "global");
}
/** SCRIPT1: run a registered, enabled shortcut by id, for a text surface that keeps its keys (the Script panel
 * passes ⌘Z and ⇧⌘Z to the edit's own Undo and Redo after its saves land). False when none is registered. */
export function runShortcut(id: string, scope: string): boolean {
  const shortcut = registeredShortcuts(scope).find(s => s.id === id && s.enabled !== false);
  shortcut?.handler((typeof KeyboardEvent === "function" ? new KeyboardEvent("keydown") : undefined) as KeyboardEvent);
  return !!shortcut;
}
export function shortcutKeys(id: string, scope: string): string | undefined {
  return registeredShortcuts(scope).find(s => s.id === id)?.keys.join(" / ");
}
/** Each screen registers its controls here; a capture listener wins over legacy player keys. */
export function useShortcuts(scope: string, shortcuts: Shortcut[], enabled = true) {
  enabled = usePageActive() && enabled;
  const token = useRef(Symbol(scope)), latest = useRef(shortcuts); latest.current = shortcuts;
  const [, refresh] = useState(0);
  useEffect(() => {
    const update = () => refresh(n => n + 1); listeners.add(update);
    if (enabled) registrations.set(token.current, shortcuts.map(s => ({ ...s, handler: event => latest.current.find(next => next.id === s.id)?.handler(event) })));
    notify();
    return () => { registrations.delete(token.current); listeners.delete(update); notify(); };
  }, [scope, enabled, shortcuts.map(s => `${s.id}:${s.keys.join(",")}:${s.enabled}`).join("|")]);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]:not([inert] *, [hidden] *), [role="menu"]:not([inert] *, [hidden] *)')) {
        dispatchShortcut(event, registeredShortcuts(scope).filter(s => s.inDialog || s.scope === "global" && s.id.startsWith("page-")), scope);
        return;
      }
      // Only the active screen dispatches; the sheet uses the same registry.
      dispatchShortcut(event, registeredShortcuts(scope), scope);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [scope, enabled]);
  return registeredShortcuts(scope);
}

export type EditShortcutActions = {
  toggle: () => void; shuttle: (direction: -1 | 0 | 1, event?: KeyboardEvent) => void; step: (seconds: number, blip?: boolean) => void;
  split: () => void; remove: () => void; undo: () => void; redo: () => void;
  search: () => void; help: () => void; bypassLook?: () => void;
};
export function editShortcuts(actions: EditShortcutActions, fps = 25): Shortcut[] {
  const item = (id: string, keys: string[], label: string, handler: Shortcut["handler"], repeat = false): Shortcut => ({ id, keys, label, scope: "precuts", handler, repeat });
  return [
    ...(actions.bypassLook ? [item("bypass-look", ["Shift+d"], "Toggle look bypass", actions.bypassLook)] : []),
    item("play", ["Space"], "Play or pause", actions.toggle),
    // VO7-14: J and L repeat (held, with K held, they creep); the shuttle ignores a held key otherwise.
    item("reverse", ["j"], "Play backward, again for 2x, 4x or 8x. Hold K for slow motion", event => actions.shuttle(-1, event), true),
    item("pause", ["k"], "Stop", event => actions.shuttle(0, event)),
    item("forward", ["l"], "Play forward, again for 2x, 4x or 8x. Hold K for slow motion", event => actions.shuttle(1, event), true),
    ...([-1, 1] as const).flatMap(direction => [
      // VO7-14: each frame step plays that frame's sound; holding the arrow repeats it.
      item(`frame-${direction}`, [direction < 0 ? "ArrowLeft" : "ArrowRight"], direction < 0 ? "Previous frame" : "Next frame", () => actions.step(direction / fps, true), true),
      item(`second-${direction}`, [direction < 0 ? "Shift+ArrowLeft" : "Shift+ArrowRight"], direction < 0 ? "Back one second" : "Forward one second", () => actions.step(direction)),
    ]),
    item("split", ["s"], "Split at playhead", actions.split),
    item("remove", ["Delete", "Backspace"], "Remove selected clip", actions.remove),
    item("undo", ["Cmd+z"], "Undo", actions.undo), item("redo", ["Cmd+Shift+z"], "Redo", actions.redo),
    item("shortcuts", ["?"], "Keyboard shortcuts", actions.help),
  ];
}

export type ShuttleTransport = { seek: (time: number) => void; play?: (rate?: number) => void; pause?: () => void; togglePlayback?: () => void;
  /** VO7-14, optional: one frame's sound, and reversed sound from a time back to 0 (the edit's player has them). */
  blip?: (time: number, length: number) => void; reverseAudio?: (time: number, rate: number) => void; stopReverseAudio?: () => void };
/** VO7-14 J K L, as Resolve: L plays forward, each L again doubles to 8x; J the same backwards, its sound reversed.
 * K stops. Hold K and tap L (or J) to step one frame with its sound; keep holding L (or J), once the Mac's own key
 * repeat starts, and it creeps that way at SLOW_RATE, with sound, until a key is let go. Forward keeps the player's
 * sound clock; reverse seeks the picture each frame while the mix plays reversed on the audio clock. Shuttle stops
 * at 0 and at `duration` (the end of the voice). */
export const SHUTTLE_RATES = [1, 2, 4, 8] as const;
/** K+L / K+J creep. Resolve calls it slow motion and doesn't document the speed; 1/4 is what was asked for and
 * the slow speed Avid and Final Cut editors expect, slow enough to hear where a word ends. */
export const SLOW_RATE = 0.25;
/** `time` may be a reader of the player's clock (VO7-11: React's time lags it while playing), so a nudge or a
 * shuttle starts from where the playhead really is. */
export function useShuttle(transport: React.RefObject<ShuttleTransport>, time: number | (() => number), duration: number, selection: string, fps = 25) {
  const active = usePageActive();
  const state = useRef({ direction: 0, rate: 1, frame: 0, time: 0, last: 0, kHeld: false, creep: 0 });
  const latest = useRef({ time, duration, fps }); latest.current = { time, duration, fps };
  const now = () => { const t = latest.current.time; return typeof t === "function" ? t() : t; };
  const report = () => { const s = state.current; (globalThis as { __precutShuttle?: unknown }).__precutShuttle = { direction: s.direction, rate: s.rate, creep: s.creep, kHeld: s.kHeld }; };
  function stop() {
    const s = state.current;
    cancelAnimationFrame(s.frame);
    if (s.direction < 0) transport.current?.stopReverseAudio?.();
    s.direction = 0; s.creep = 0; report();
  }
  /** Backwards at `rate`: the picture seeks every frame, the sound plays reversed from here on the audio clock. */
  function reverse(rate: number) {
    const s = state.current;
    Object.assign(s, { direction: -1, rate, time: now(), last: performance.now() }); report();
    transport.current?.reverseAudio?.(s.time, rate);
    const tick = (at: number) => {
      const next = Math.max(0, s.time - (at - s.last) / 1000 * s.rate);
      s.last = at; s.time = next; transport.current?.seek(next);
      if (next > 0 && s.direction < 0) s.frame = requestAnimationFrame(tick);
      else stop();
    };
    s.frame = requestAnimationFrame(tick);
  }
  function step(seconds: number, blip = false) {
    stop(); const to = Math.max(0, Math.min(latest.current.duration, now() + seconds));
    transport.current?.seek(to);
    if (blip) transport.current?.blip?.(to, 1 / latest.current.fps);
  }
  useEffect(() => {
    if (!active) { stop(); transport.current?.pause?.(); }
    // Letting go of K, or of the L or J that is creeping, ends the creep. Leaving the window lets go of everything.
    const up = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase(), s = state.current;
      if (key !== "k" && key !== "l" && key !== "j") return;
      if (key === "k") s.kHeld = false;
      if (s.creep && (key === "k" || (key === "l") === s.creep > 0)) { stop(); transport.current?.pause?.(); }
      report();
    };
    const blur = () => { const s = state.current; s.kHeld = false; if (s.creep) { stop(); transport.current?.pause?.(); } };
    window.addEventListener("keyup", up, true); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keyup", up, true); window.removeEventListener("blur", blur); stop(); transport.current?.pause?.(); };
  }, [selection, active]);
  return {
    toggle() { const reversing = state.current.direction < 0; stop(); if (reversing) transport.current?.play?.(1); else transport.current?.togglePlayback?.(); },
    step,
    shuttle(direction: -1 | 0 | 1, event?: KeyboardEvent) {
      const s = state.current;
      if (!direction) { if (!event?.repeat) { stop(); transport.current?.pause?.(); } s.kHeld = true; report(); return; }
      if (s.kHeld) {
        // K held: a press steps one frame with its sound; the key's own repeat (it is being held) starts the creep.
        if (!event?.repeat) { step(direction / latest.current.fps, true); return; }
        if (s.creep === direction) return;
        stop(); transport.current?.pause?.();
        if (direction > 0) { Object.assign(s, { direction: 1, rate: SLOW_RATE }); transport.current?.play?.(SLOW_RATE); }
        else reverse(SLOW_RATE);
        s.creep = direction; report();
        return;
      }
      // A held J or L is one press: only a new press changes speed.
      if (event?.repeat) return;
      const rate = s.direction === direction && !s.creep ? SHUTTLE_RATES[Math.min(SHUTTLE_RATES.length - 1, SHUTTLE_RATES.indexOf(s.rate as typeof SHUTTLE_RATES[number]) + 1)] : 1;
      stop(); transport.current?.pause?.();
      if (direction > 0) { Object.assign(s, { direction: 1, rate }); report(); transport.current?.play?.(rate); return; }
      reverse(rate);
    },
  };
}


/** Shared by the rail, its tooltips and the keyboard help sheet. */
export const EDIT_PANELS = [
  // RAIL1: Layout and footage live in Clips; Cover lives in Export. SCRIPT1: eight items, Script replaces Text and
  // Voiceover (camera speech and voiceover in one document), and the keys follow the rail's order.
  { id: "script", label: "Script", key: "1" },
  { id: "captions", label: "Captions", key: "2" },
  { id: "look", label: "Look", key: "3" },
  { id: "sound", label: "Sound", key: "4" },
  { id: "pace", label: "Pace", key: "5" },
  { id: "clips", label: "Clips", key: "6" },
  { id: "search", label: "Search", key: "/" },
] as const;
/** CH2: Ask left the rail for Claude's own pane. "ask" stays a destination (search, links, Make it better) that
 * shows that pane instead of opening a sheet. Its old key, 7, shows or hides Claude. */
export type EditsPanel = typeof EDIT_PANELS[number]["id"] | "ask";
export const CLIP_PANELS: readonly EditsPanel[] = ["look", "sound"];
export function panelShortcuts(toggle: (panel: EditsPanel) => void, close: () => void, toggleClaude?: () => void): Shortcut[] {
  return [
    ...EDIT_PANELS.map(panel => ({ id: `panel-${panel.id}`, keys: [panel.key], label: panel.label, scope: "precuts", handler: () => toggle(panel.id) })),
    ...(toggleClaude ? [{ id: "panel-claude", keys: ["7"], label: "Show or hide Claude", scope: "precuts", handler: toggleClaude }] : []),
    { id: "panel-close", keys: ["Escape"], label: "Close panel", scope: "precuts", handler: close },
  ];
}
