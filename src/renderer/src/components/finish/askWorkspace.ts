import { useSyncExternalStore } from "react";
import type { AskScreenContext } from "../../terminal-api";

type AskWorkspace = { open: boolean; idea?: AskScreenContext["idea"] };
const workspaces = new Map<string, AskWorkspace>();
const listeners = new Set<() => void>();
const read = (root: string) => {
  if (!workspaces.has(root)) workspaces.set(root, { open: false });
  return workspaces.get(root)!;
};
export function setAskWorkspace(root: string, change: Partial<AskWorkspace>) {
  workspaces.set(root, { ...read(root), ...change });
  listeners.forEach(listener => listener());
}
export function useAskWorkspace(root: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => read(root));
}
