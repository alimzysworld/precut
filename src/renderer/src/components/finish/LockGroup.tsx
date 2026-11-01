import { useEffect, useState } from "react";
import { formatPercent } from "../processingFormat";
import type { CutVersion, DraftTimeline } from "../../../../shared/schema";
import { LOCK_DEFAULTS } from "../../../../shared/pin-keys";
import { FOCUS, SectionHeader, Segments, Slider, Switch } from "../ui";
import { lockCall, lockPickId, pinWaiting, startLockPick, cancelPick, useOverlaySession, usePinState } from "../OverlayHandles";

// TRK2 (docs/plans/produced/tracking-spike.md, story 4): the clip's Lock group. "Lock on something" picks the thing on
// the stage (the same pick as sticking a word: a box, or a flat thing's four corners) and main steadies the picture on
// it (MCP lock_on). Once locked, the knobs are MCP update_lock's, by the same names and units: anchor (least zoom or
// where picked), keep size (scale), max zoom 1 to 2. Each change is one undoable version and never tracks again. The
// cost is said plainly. Soft fills only: focus and selection are a fill change, never a stroke.
const ANCHORS = [{ value: "least", label: "Least zoom" }, { value: "picked", label: "Where picked" }] as const;
const softButton = `rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] text-ink hover:bg-ink/[0.1] focus-visible:bg-ink/[0.14] disabled:opacity-40 ${FOCUS}`;

export function LockGroup({ version, index, timeline, busy }: { version: CutVersion; index: number; timeline?: DraftTimeline | null; busy: boolean }) {
  const session = useOverlaySession(timeline), { pick, run, note } = usePinState();
  const lock = version.pieceFx?.[index]?.lock, summary = timeline?.locks?.find(l => l.piece === index);
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => setZoom(null), [lock?.maxZoom, version.version]);
  const spans = timeline?.pieces.filter(p => p.layer === 0 && p.piece === index) ?? [];
  const span = spans.length ? { s: Math.min(...spans.map(p => p.startS)), e: Math.max(...spans.map(p => p.endS)) } : null;
  const off = busy || !session || !span || pinWaiting(session), id = lockPickId(index);
  const picking = pick?.itemId === id, running = run?.itemId === id && run.state === "running";
  const said = note?.itemId === id ? note.text : null;
  const change = (knobs: Record<string, unknown>) => { if (session && !off) void lockCall(session, index, "update_lock", knobs); };
  const pickButton = (again: boolean) => <button type="button" data-lock-pick aria-pressed={picking} disabled={!picking && (off || !span)}
    onClick={() => picking ? cancelPick() : session && span && startLockPick(session, index, span, again, lock?.thing ?? "")} className={softButton}>{picking ? "Picking the thing…" : again ? "Pick again" : "Lock on something"}</button>;
  if (!lock) return <section aria-label="Lock" data-lock-controls className="space-y-1.5">
    <SectionHeader as="h4" className="font-medium">Lock</SectionHeader>
    <p className="text-[11px] text-muted">Hold the picture still on a thing in the shot: pick it on the video.</p>
    <div className="flex flex-wrap gap-1">{pickButton(false)}</div>
    {running ? <p role="status" className="text-[11px] tabular-nums text-muted">Following {run!.thing ? `the ${run!.thing}` : "it"}…{run!.pct != null ? ` ${formatPercent(run!.pct)}` : ""}</p> : null}
    {said ? <p aria-live="polite" className="rounded-lg bg-ink/[0.05] px-2 py-1.5 text-[11px] text-muted">{said}</p> : null}
  </section>;
  const max = zoom ?? lock.maxZoom;
  return <section aria-label="Lock" data-lock-controls className="space-y-2.5 rounded-xl bg-ink/[0.04] p-2.5">
    <div className="flex items-baseline justify-between gap-2"><SectionHeader as="h4" className="text-[12px] font-semibold">Lock</SectionHeader><span className="truncate text-[11px] text-muted">{lock.thing ? `Locked on the ${lock.thing}` : "Locked on a thing"}</span></div>
    {summary ? <div data-lock-note role="status" className="space-y-1 rounded-lg bg-ink/[0.05] px-2 py-1.5 text-[11px]"><p className="text-ink">{summary.note}</p>{summary.lost ? <p className="text-muted">{summary.lost}.</p> : null}</div> : null}
    <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">Anchor</span>
      <Segments label="Anchor" variant="compact" value={lock.anchor} options={ANCHORS.map(a => ({ value: a.value, label: a.label, disabled: off }))} onChange={value => value !== lock.anchor && change({ anchor: value })} /></div>
    <label className="flex items-center justify-between gap-2 text-[11px]"><span className="text-muted">Keep size</span><Switch label="Keep size" checked={lock.scale} disabled={off} onChange={event => change({ scale: event.target.checked })} /></label>
    <Slider label="Max zoom" min={1} max={2} step={0.05} unit="x" defaultValue={LOCK_DEFAULTS.maxZoom} value={max} disabled={off}
      onChange={value => setZoom(value)} onRelease={value => { if (Math.abs(value - lock.maxZoom) > 1e-6) change({ maxZoom: value }); else setZoom(null); }} />
    <div className="flex flex-wrap gap-1">
      {pickButton(true)}
      <button type="button" data-lock-unlock disabled={off} onClick={() => session && void lockCall(session, index, "unlock")} className={softButton}>Unlock</button>
    </div>
    {running ? <p role="status" className="text-[11px] tabular-nums text-muted">Following {run!.thing ? `the ${run!.thing}` : "it"}…{run!.pct != null ? ` ${formatPercent(run!.pct)}` : ""}</p> : null}
    {said ? <p aria-live="polite" className="rounded-lg bg-ink/[0.05] px-2 py-1.5 text-[11px] text-muted">{said}</p> : null}
  </section>;
}
