import { useEffect, useRef, useState } from "react";
import type { ShootProgress } from "../../../shared/schema";
import { Close, Wand } from "./icons";

export type DiscoveryToastData = { id: string; text: string; clipId?: string; t?: number };
/** main picks what to tell and when (one per ~20 s, only verified facts); this only shows it. */
export function toastOf(progress: ShootProgress | undefined): DiscoveryToastData | null {
  return (progress as (ShootProgress & { toast?: DiscoveryToastData | null }) | undefined)?.toast ?? null;
}

/** BUG1: where every toast sits: top right under the top bar, left of the Edits tool rail (80 px wide) and clear of the
 * timeline and its lanes. Discoveries and Export finished share it; measured in qa/BUG1 at 1512x945 and 1280x800. */
export const TOAST_PLACEMENT = "fixed right-[96px] top-[68px]";
/** One small toast at a time, top right. Gone after about five seconds; a click jumps to the footage. */
export function DiscoveryToast({ toast, onOpen, showMs = 5000 }: { toast: DiscoveryToastData | null; onOpen: (toast: DiscoveryToastData) => void; showMs?: number }) {
  const [shown, setShown] = useState<DiscoveryToastData | null>(null);
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (!toast || told.current.has(toast.id)) return;
    told.current.add(toast.id); setShown(toast);
    const timer = window.setTimeout(() => setShown(current => current?.id === toast.id ? null : current), showMs);
    return () => window.clearTimeout(timer);
  }, [toast?.id, showMs]);
  if (!shown) return null;
  return <div role="status" data-discovery-toast={shown.id} className={`glass-floating ${TOAST_PLACEMENT} z-[55] flex max-w-[360px] items-center gap-3 rounded-2xl py-2.5 pl-3 pr-2`}>
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-accent"><Wand size={16} /></span>
    <button type="button" onClick={() => { onOpen(shown); setShown(null); }} className="min-w-0 flex-1 rounded-lg px-1 py-0.5 text-left text-small font-medium text-ink hover:bg-ink/[0.06]">{shown.text}</button>
    <button type="button" aria-label="Dismiss" onClick={() => setShown(null)} className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-ink"><Close size={14} /></button>
  </div>;
}
