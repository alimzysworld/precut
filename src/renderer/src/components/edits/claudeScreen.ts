import { useEffect, useSyncExternalStore } from "react";
import type { AskScreenContext } from "../../terminal-api";

/** CH2b: one Claude pane for the whole window. Each page says what Claude sees while it is the active one (Edits the
 * edit, playhead and selection; Ideas the idea being talked about), and the pane reads the active page's screen. */
export type ClaudeScreen = { cutId?: string; version: number; screenContext?: AskScreenContext };
const screens = new Map<string, { screen: ClaudeScreen; key: string }>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function publishClaudeScreen(page: string, screen: ClaudeScreen | undefined) {
  if (!screen) { if (screens.delete(page)) notify(); return; }
  const key = JSON.stringify(screen);
  if (screens.get(page)?.key === key) return;
  screens.set(page, { screen, key });
  notify();
}
/** A page's screen for Claude, kept while the page is active; it is forgotten when the page goes (a new shoot). */
export function useClaudeScreen(page: string, screen: ClaudeScreen, active: boolean) {
  const key = JSON.stringify(screen);
  useEffect(() => { if (active) publishClaudeScreen(page, screen); }, [page, key, active]);
  useEffect(() => () => publishClaudeScreen(page, undefined), [page]);
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useActiveClaudeScreen(page: string): ClaudeScreen | undefined {
  return useSyncExternalStore(subscribe, () => screens.get(page)?.screen);
}
