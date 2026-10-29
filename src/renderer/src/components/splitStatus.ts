import { useEffect, useState } from "react";

let message: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const completed = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

/** Called only after the registry confirms the parent has gone. Once per import. */
export function announceFolderSplit(root: string, count: number): void {
  if (count < 2 || completed.has(root)) return;
  completed.add(root);
  message = `Split into ${count} shoots`;
  clearTimeout(timer);
  timer = setTimeout(() => { message = null; emit(); }, 6000);
  emit();
}
export function useFolderSplitStatus(): string | null {
  const [shown, setShown] = useState(message);
  useEffect(() => {
    const update = () => setShown(message);
    listeners.add(update); update();
    return () => { listeners.delete(update); };
  }, []);
  return shown;
}
