import { useSyncExternalStore } from "react";
import { readPane, savePane } from "./ToolBar";

/** CH2: Claude is its own pane at the window's right edge, top to bottom, split from the editor by a hairline (POLISH1).
 * Open by default and remembered, as is its width: 300 px up to half the window. Below NARROW_WINDOW it keeps its
 * 300 px minimum (there is no pin yet, so it never hides itself). The layout lands on <body> as CSS variables, so
 * the window's own chrome (App's editor surface, the top bar) follows without a React render. */
export const CLAUDE_MIN = 300, CLAUDE_RESET = 340, CLAUDE_GUTTER = 1;  // POLISH1: the hairline
const NARROW_WINDOW = 1100, EDITOR_NARROW = 1280, SLIDE_MS = 220;
type State = { open: boolean; width: number; present: boolean; viewport: number };
const stored = Number(readPane<number>("claude-width", CLAUDE_RESET));
let state: State = { open: readPane<boolean>("claude-open", true) !== false, width: Number.isFinite(stored) ? stored : CLAUDE_RESET, present: false,
  viewport: typeof window === "undefined" ? 1440 : window.innerWidth };
const listeners = new Set<() => void>();
let slide = 0;

export const claudeMax = (viewport: number) => Math.max(CLAUDE_MIN, Math.floor(viewport / 2));
export function claudeLayout(s: State = state) {
  const width = s.viewport < NARROW_WINDOW ? CLAUDE_MIN : Math.max(CLAUDE_MIN, Math.min(claudeMax(s.viewport), Math.round(s.width)));
  const shown = s.present && s.open, reserve = shown ? width + CLAUDE_GUTTER : 0;
  return { open: s.open, present: s.present, viewport: s.viewport, width, shown, reserve, editorNarrow: s.viewport - reserve < EDITOR_NARROW };
}
function apply() {
  if (typeof document === "undefined" || !document.body) return;
  const layout = claudeLayout(), body = document.body;
  body.style.setProperty("--claude-reserve", `${layout.reserve}px`);
  body.style.setProperty("--claude-width", `${layout.width}px`);
  body.toggleAttribute("data-claude-pane", layout.shown);
  // The top bar is as wide as the editor pane, so it tightens with it (Claude widened, or a small window).
  const bar = layout.viewport - layout.reserve;
  body.setAttribute("data-top-bar", [bar < 1240 && "snug", bar < 1040 && "tight", bar < 900 && "tighter", bar < 680 && "tightest"].filter(Boolean).join(" "));
}
function set(change: Partial<State>) {
  const before = claudeLayout();
  state = { ...state, ...change };
  const after = claudeLayout();
  if (before.width === after.width && before.shown === after.shown && before.editorNarrow === after.editorNarrow && before.open === after.open && before.viewport === after.viewport) return;
  apply();
  listeners.forEach(listener => listener());
}
// The window's width is watched while anything shows the layout (the pane and the top bar always do, so in the app it
// is always watched); nothing is left listening once the last screen using it is gone.
const resize = () => set({ viewport: window.innerWidth });
function watch(on: boolean) {
  if (typeof window === "undefined") return;
  if (!on) { window.removeEventListener("resize", resize); return; }
  window.addEventListener("resize", resize);
  if (typeof window.innerWidth === "number") resize();
}
apply();

/** Show or hide. Only this gesture slides; a page switch or a resize lands at once. */
export function setClaudeOpen(open: boolean) {
  if (open === state.open) return;
  savePane("claude-open", open);
  if (typeof document !== "undefined" && state.present && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.body.setAttribute("data-claude-sliding", "");
    window.clearTimeout(slide);
    slide = window.setTimeout(() => document.body.removeAttribute("data-claude-sliding"), SLIDE_MS + 40);
  }
  set({ open });
}
export const toggleClaude = () => setClaudeOpen(!state.open);
/** Put the cursor in Claude: the chat's message box (CH3), or the terminal while the engine is Codex or Muse. */
export function focusClaude() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>("#claude-pane [data-claude-input], #claude-pane .xterm-helper-textarea")?.focus());
}
/** CH2b: what opened Ask on any page shows Claude: shown already, the cursor goes to its message box. */
export function showClaude() { if (state.open) focusClaude(); else setClaudeOpen(true); }
export function setClaudeWidth(width: number) {
  const next = Math.max(CLAUDE_MIN, Math.min(claudeMax(state.viewport), Math.round(width)));
  savePane("claude-width", next);
  set({ width: next });
}
/** The Edits page holds the pane while it is the active page. */
export const setClaudePresent = (present: boolean) => set({ present });

const subscribe = (listener: () => void) => {
  if (!listeners.size) watch(true);
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) watch(false); };
};
export function useClaudeLayout() {
  useSyncExternalStore(subscribe, () => state);
  return claudeLayout();
}
/** For screens that only care whether the editor pane is narrower than 1280 px (the edits list collapses). */
export const useEditorNarrow = () => useSyncExternalStore(subscribe, () => claudeLayout().editorNarrow);
