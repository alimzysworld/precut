import { formatEta } from "./processingFormat";
import { formatPercent, formatDuration } from "./processingFormat";
import { DialogSurface } from "./ui";
import { ProgressRing as ActivityRing } from "./ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import type { Activity } from "../../../shared/schema";
import { getApi } from "../data";

export interface ActivityFilter {
  root?: string | null;
  kind?: Activity["kind"] | readonly Activity["kind"][];
  target?: NonNullable<Activity["target"]>;
  state?: Activity["state"];
}

const RECENT_MS = 5 * 60_000;
const TICK_MS = 5_000;
let snapshot: Activity[] = [];
const byId = new Map<string, Activity>();
const listeners = new Set<() => void>();
let disconnect: (() => void) | undefined;

function publish() {
  const cutoff = Date.now() - RECENT_MS;
  for (const [id, activity] of byId) {
    if (activity.state !== "running" && Date.parse(activity.endedAt ?? activity.startedAt) < cutoff) byId.delete(id);
  }
  snapshot = [...byId.values()].sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    let alive = true;
    const changed = new Set<string>();
    const api = getApi();
    const off = api.onActivity(activity => {
      if (!alive) return;
      changed.add(activity.id);
      byId.set(activity.id, activity);
      publish();
    });
    // Subscribe first: a late initial response must never overwrite live progress.
    void api.listActivity().then(activities => {
      if (!alive) return;
      const listed = new Set(activities.map(activity => activity.id));
      for (const id of byId.keys()) if (!changed.has(id) && !listed.has(id)) byId.delete(id);
      for (const activity of activities) if (!changed.has(activity.id)) byId.set(activity.id, activity);
      publish();
    }).catch(() => { /* Live events still work if the initial list is unavailable. */ });
    const timer = window.setInterval(publish, 1000);
    disconnect = () => { alive = false; off(); window.clearInterval(timer); };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { disconnect?.(); disconnect = undefined; }
  };
}

/** All consumers share one IPC subscription and one map, including across pages. */
export function useActivity(filter: ActivityFilter = {}): Activity[] {
  const activities = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return activities.filter(activity =>
    (filter.root === undefined || activity.root === filter.root) &&
    (filter.kind === undefined || (typeof filter.kind === "string" ? activity.kind === filter.kind : filter.kind.includes(activity.kind))) &&
    (filter.state === undefined || activity.state === filter.state) &&
    (!filter.target || Object.entries(filter.target).every(([key, value]) => activity.target?.[key as keyof NonNullable<Activity["target"]>] === value)));
}

export function activityPercent(pct: number | null | undefined): number | null {
  return pct != null && Number.isFinite(pct) ? Math.round(Math.max(0, Math.min(100, pct))) : null;
}

export function activityEta(etaS: number | null): string | null { return formatEta(etaS); }

export function ActivitySpinner({ className = "" }: { className?: string }) {
  return <CircleNotch aria-hidden="true" size={14} className={`shrink-0 motion-safe:animate-spin ${className}`} />;
}

export function ActivityProgress({ pct, label, className = "" }: { pct: number | null; label: string; className?: string }) {
  const reduced = useReducedMotion();
  const value = activityPercent(pct);
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}
    className={`h-0.5 overflow-hidden rounded-full bg-current/10 ${className}`}>
    <motion.div initial={false} animate={value === null ? reduced ? { opacity: .5 } : { x: ["-100%", "350%"] } : { width: `${value}%`, x: 0, opacity: 1 }}
      transition={value === null && !reduced ? { duration: 2, repeat: Infinity, ease: "easeInOut" } : { type: "spring", stiffness: 170, damping: 28 }}
      style={{ width: value === null ? "30%" : undefined }} className="h-full rounded-full bg-current opacity-70" />
  </div>;
}

export function ActivityShimmer() {
  const reduced = useReducedMotion();
  return <motion.span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-ink/[0.045] to-transparent"
    animate={reduced ? { opacity: .5 } : { x: ["-100%", "100%"] }} transition={{ duration: 2.4, repeat: reduced ? 0 : Infinity, ease: "easeInOut" }} />;
}

export { ProgressRing as ActivityRing } from "./ui";

export function ActivityTyping({ note }: { note?: string | null }) {
  const reduced = useReducedMotion();
  return <div role="status" className="flex items-center gap-2 px-4 py-3 text-small text-muted">
    <span className="flex gap-1" aria-hidden="true">{[0, 1, 2].map(index => <motion.span key={index} className="size-1 rounded-full bg-current"
      animate={reduced ? { opacity: .6 } : { opacity: [.3, 1, .3] }} transition={{ duration: 1.2, delay: index * .15, repeat: reduced ? 0 : Infinity }} />)}</span>
    {note || "Thinking"}
  </div>;
}

export function navigateToActivity(activity: Activity) {
  const target = activity.target;
  const page = target?.cutId || ["cut", "edit", "titles", "finish", "render", "export"].includes(activity.kind) ? "precuts"
    : target?.clipId || activity.kind === "process" || activity.kind === "judge" ? "clips" : activity.kind === "ideas" ? "ideas" : "shoots";
  const query = new URLSearchParams();
  if (activity.root) query.set("shoot", activity.root);
  if (target?.cutId) query.set("cut", target.cutId);
  if (target?.version !== undefined) query.set("v", String(target.version));
  if (target?.clipId) query.set("clip", target.clipId);
  if (target?.ideaId) query.set("idea", target.ideaId);
  if (activity.kind === "setup" || activity.kind === "looks" && !target?.cutId) query.set("settings", "general");
  window.location.hash = `/${page}?${query}`;
}

export function ActivityCapsule({ excludeRoot }: { excludeRoot?: string } = {}) {
  const activities = useActivity().filter(activity => !excludeRoot || activity.root !== excludeRoot);
  const running = activities.filter(activity => activity.state === "running");
  // A refused hand edit leaves the saved cut intact and explains itself beside the storyboard.
  // Retain it in activity history without announcing that the edit has stopped.
  const justFinished = activities.filter(activity => activity.state !== "running"
    && !(activity.kind === "edit" && activity.state === "failed")
    && Date.now() - Date.parse(activity.endedAt ?? activity.startedAt) < TICK_MS);
  const [open, setOpen] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => getApi().onNavigate?.(hash => { setOpen(false); window.location.hash = hash; }), []);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => { if (!area.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    const navigate = () => setOpen(false);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key); window.addEventListener("hashchange", navigate);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); window.removeEventListener("hashchange", navigate); };
  }, [open]);
  const visible = running.length > 0 || justFinished.length > 0 || open;
  return <div ref={area} className="relative min-w-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
    <AnimatePresence>{visible && <motion.div initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .96 }} transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 340, damping: 30 }}>
      <button ref={trigger} type="button" aria-label={running.length ? `${running.length} running tasks` : "Recent activity"} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-small text-ink/70 outline-none hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06]">
        {running.length ? <ActivitySpinner /> : justFinished.some(activity => activity.state === "failed") ? <WarningCircle size={14} /> : <Check size={14} />}
        <span className="tnum">{running.length || (justFinished.some(activity => activity.state === "failed") ? "Stopped" : "Done")}</span>
      </button>
    </motion.div>}</AnimatePresence>
    <AnimatePresence>{open && <DialogSurface ref={panel} aria-label="Activity" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
      transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 340, damping: 30 }} className="st-pop absolute right-0 top-[calc(100%+14px)] z-[100] w-[340px] max-w-[calc(100vw-24px)] overflow-hidden rounded-3xl p-2 text-ink"
      onClose={() => setOpen(false)}>
      <p className="px-3 py-2 text-small font-medium">Activity</p>
      <div className="max-h-[min(420px,60vh)] overflow-y-auto">{[...running, ...activities.filter(activity => activity.state !== "running")].map(activity => {
        const pct = activityPercent(activity.pct), eta = activityEta(activity.etaS);
        return <button key={activity.id} type="button" onClick={() => { setOpen(false); navigateToActivity(activity); }} className="flex w-full items-start gap-2.5 rounded-2xl px-3 py-3 text-left outline-none hover:bg-ink/[0.045] focus-visible:bg-ink/[0.045]">
          <span className="mt-0.5">{activity.state === "running" ? <ActivitySpinner /> : activity.state === "done" ? <Check size={14} /> : <WarningCircle size={14} />}</span>
          <span className="min-w-0 flex-1"><span className="block text-small font-medium">{activity.label}</span>
            {activity.note && <span className="mt-1 block text-micro text-muted">{activity.note}</span>}
            {activity.state === "running" ? <><span className="tnum mt-1 block text-micro text-muted">{[pct !== null ? formatPercent(pct) : "Working…", eta].filter(Boolean).join(" · ")}</span><ActivityProgress label={activity.label} pct={activity.pct} className="mt-2 text-accent" /></> : <span className="mt-1 block text-micro text-muted">{activity.state === "done" ? "Finished" : "Couldn't finish"}</span>}
          </span>
        </button>;
      })}{!activities.length && <p className="px-3 py-3 text-small text-muted">All caught up</p>}</div>
    </DialogSurface>}</AnimatePresence>
  </div>;
}
