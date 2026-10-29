import { NamedMessage, SourceNames } from "./ClipNames";
import { formatPercent, formatEta, formatTimeLeft, formatDuration, processingOverall } from "./processingFormat";
import { useEffect, useRef, useState } from "react";
import type { Activity, OptionalCheckId, ProcessingStageId, ShootProgress, ResourceState } from "../../../shared/schema";
import { STAGE_FAILED_TEXT, STAGE_NEEDS_AI, needsAi } from "../../../shared/stage-words";
import { activityPercent, activityEta, ActivityRing } from "./Activity";
import { InlineError } from "./ui";
import { go, readHash } from "../nav";
import { useFolderSplitStatus } from "./splitStatus";

const STAGES: Partial<Record<Activity["kind"], ProcessingStageId[]>> = {
  process: ["index", "transcribe", "group"], judge: ["judge"], ideas: ["ideas"], cut: ["drafts"], edit: ["drafts"],
};

export const statusEta = formatEta;
const silent = (a: Activity) => a.kind === "looks" || a.kind === "edit" || /thumbnail|waveform|cover|isolating voice|softening breaths|matching voice levels|measuring edit voice|measuring clip colour|measuring sound|measuring shake|preparing background|reversing clip|preparing sound|updating transcript|preparing edit playback|saving your look|saving sound|saving edit|measuring music/i.test(a.label);
const priority = (a: Activity) => ({ export: 0, render: 1, process: 2, setup: 2, cut: 3 } as Partial<Record<Activity["kind"], number>>)[a.kind] ?? 4;


// Counts are currently plain detail text in the contract. Preserve their meaning,
// including "clip" versus "ready", rather than deriving counts from percentages.
function countDetail(detail: string | null | undefined): string | null {
  const match = detail?.match(/(?:^|[·,;]\s*)\s*((?:clip\s+)?(\d+) of (\d+)(?: ready| read)?)\s*(?:$|[·,;])/i);
  return match && Number(match[2]) <= Number(match[3]) && Number(match[3]) > 0 ? match[1] : null;
}

// Plain words per stage; the stage's own message stays behind "Details".
const failedText: Record<ProcessingStageId, string> = STAGE_FAILED_TEXT;
const stateWord: Record<string, string> = { done: "Done", queued: "Waiting", failed: "Couldn't finish" };
// PF1b: optional checks never stop edits; each names itself (the headline is its first sentence).
const optionalText: Record<OptionalCheckId, string> = { framing: "Couldn't check framing. Edits were made without it.",
  quality: "Couldn't check focus and sound. Edits were made without it.", fillers: "Couldn't find ums. Edits were made without it." };
function failuresOf(progress: ShootProgress | undefined): { id: ProcessingStageId | OptionalCheckId; text: string; headline: string; detail: string | null }[] {
  // FIX3: one failure, one line. Grouping takes and checking performances are one model call: same words, one block.
  const failed = (progress?.stages ?? []).filter(stage => stage.state === "failed");
  return [...failed.filter((stage, index) => failed.findIndex(other => failedText[other.id] === failedText[stage.id] && other.detail === stage.detail) === index)
    .map(stage => ({ id: stage.id, text: failedText[stage.id], headline: failedText[stage.id], detail: stage.detail })),
    ...(progress?.optional ?? []).filter(check => optionalText[check.id]).map(check => ({ id: check.id, text: optionalText[check.id], headline: optionalText[check.id].split(". ")[0] + ".", detail: check.detail }))];
}

export function shootStatusLine(root: string | null | undefined, progress: ShootProgress | undefined, activities: readonly Activity[]) {
  const running = activities.filter(item => item.root === root && item.state === "running");
  const edits = new Map<string, Activity>();
  for (const item of running.filter(a => a.kind === "cut")) {
    const key = item.target?.ideaId ?? item.target?.cutId ?? item.id;
    if (!edits.has(key) || !item.label.startsWith("Queued:")) edits.set(key, item);
  }
  const edit = [...edits.values()][0];
  const editTitle = edit?.label.replace(/^(?:Queued: |Cutting |Creating |Making )/, "");
  const editHeadline = edits.size > 1 ? `Working on ${edits.size} edits` : edit && editTitle && !/^(?:your edit|your first edit)$/i.test(editTitle)
    ? `${edit.label.startsWith("Queued:") ? "Queued" : "Making"} '${editTitle}'` : "Making your edit";
  const activity = running.filter(item => !silent(item))
    .sort((a, b) => priority(a) - priority(b) || Number(a.label.startsWith("Queued:")) - Number(b.label.startsWith("Queued:")) || a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))[0];
  // A quiet read of new or changed files (a shoot with ideas or edits) says what it reads, ahead of sorting.
  const quietLabel = progress?.root === root ? progress?.reading?.label : undefined;
  const quiet = quietLabel ? running.find(a => a.kind === "process" && a.label === quietLabel) : undefined;
  if (quiet) return { activity: quiet, root, kind: "process" as const, headline: quiet.label, details: [...new Set(running.map(item => [item.id === quiet.id ? null : item.label, item.note, statusEta(item.etaS)].filter(Boolean).join(" · ")).filter(Boolean))], long: true, target: null,
    pct: activityPercent(quiet.pct), counts: countDetail(quiet.note), eta: statusEta(quiet.etaS), failed: false, stages: null, failures: [] as ReturnType<typeof failuresOf>, wait: false };
  const sorting = running.find(a => a.label === "Sorting your footage into places and shots");
  if (sorting) return { activity: sorting, root, kind: "process" as const, headline: sorting.label, details: [sorting.label], long: true, target: null, pct: sorting.pct, counts: null, eta: statusEta(sorting.etaS), failed: false, stages: null, failures: [] as ReturnType<typeof failuresOf>, wait: false };
  const overall = progress?.root === root ? processingOverall(progress) : undefined;
  const stages = progress && progress.root === root ? progress.stages : [];
  const rethinking = running.some(a => a.label.startsWith("Rethinking")) || stages.some(s => s.state === "running" && (s.detail?.startsWith("Rethinking without ") || s.detail === "Rethinking with your clips"));
  const reading = running.some(a => a.kind === "process" && a.label === "Reading your footage") || stages.some(s => ["index", "transcribe", "group"].includes(s.id) && s.state === "running");
  const drafting = stages.some(s => s.id === "drafts" && s.state === "running");
  const headline = drafting ? editHeadline : rethinking && !reading ? "Rethinking your shots" : "Reading your footage";
  const failures = progress?.root === root ? failuresOf(progress) : [];
  const previews = running.find(a => /^(?:Checking previews|Making \d+(?: more)? clips? smooth)$/.test(a.label));
  if (previews && activity?.kind !== 'export' && activity?.kind !== 'render') return {
    activity: previews, root, kind: 'process' as const, headline: previews.label, details: [previews.label],
    long: true, target: null, pct: null, counts: null, eta: statusEta(previews.etaS),
    failed: false, stages: null, failures: [] as ReturnType<typeof failuresOf>, wait: false,
  };
  // A failed stage replaces the countdown at once; work that stopped has no time left.
  if (failures.length && !activity && !(overall?.running && !overall.failed)) return {
    activity, root, kind: "process" as const, headline: failures[0].headline, details: failures.map(f => f.text), long: false, target: null,
    pct: overall?.pct ?? null, counts: null, eta: null, failed: true, stages: overall?.stages ?? null, failures, wait: false,
  };
  if (overall && !overall.complete && (overall.running || overall.failed) && activity?.kind !== "export") return {
    activity, root, kind: "process" as const, headline: overall.failed ? (failures[0]?.headline ?? "Couldn't finish everything.") : `${headline}. ${formatTimeLeft(overall.etaS)}.`,
    details: overall.stages.map(stage => `${stage.label}: ${stage.state === "skipped" && progress?.stages.some(item => needsAi(item)) ? STAGE_NEEDS_AI : stage.state}`), long: false, target: null, pct: overall.pct, counts: null, eta: null,
    failed: !!overall.failed, stages: overall.stages, failures,
    wait: !overall.failed,  // WR2: while the shoot processes, the line opens its waiting room
    needsAi: !!progress?.stages.some(item => needsAi(item)),  // ONB2: skipped AI stages read "Needs your AI"
  };
  if (overall?.complete && !edits.size && (!activity || ["process", "judge", "ideas", "cut"].includes(activity.kind))) return null;
  if (root === undefined || !activity) return null;
  const stage = progress?.root === root ? progress.stages.find(item => item.state === "running" && STAGES[activity.kind]?.includes(item.id)) : undefined;
  return {
    activity,
    root: activity.root,
    kind: activity.kind,
    headline: activity.kind === "export" || activity.kind === "render" && /finished video/i.test(activity.label) ? "Exporting" : edits.size || drafting ? editHeadline : rethinking && !reading ? `Rethinking your shots. ${formatTimeLeft(activity.etaS ?? null)}.` : activity.label,
    details: running.map(item => [item.label, item.note, item.etaS == null ? null : statusEta(item.etaS)].filter(Boolean).join(" · ")),
    long: activity.kind === "export" || activity.kind === "process" || activity.kind === "render" && /finished video/i.test(activity.label),
    target: activity.target,
    pct: activityPercent(activity.pct) ?? activityPercent(stage?.pct),
    counts: countDetail(activity.note) ?? countDetail(stage?.detail),
    eta: statusEta(activity.etaS), failed: false, stages: null, failures: [] as ReturnType<typeof failuresOf>, wait: false,
  };
}

export const ProgressRing = ActivityRing;
const currentRoute = () => { try { return typeof window === "undefined" ? null : readHash(); } catch { return null; } };

/** The mark and visible copy update at most once a second, including task switches. */
export function StatusLine({ status, calm, resourceState: resource, onFullSpeed, onOpen, onRetry }: { status: ReturnType<typeof shootStatusLine>; calm?: string | null; resourceState?: ResourceState; onFullSpeed?: (taskId: string) => Promise<boolean>; onOpen?: () => void; onRetry?: (stage: ProcessingStageId | OptionalCheckId) => Promise<void> }) {
  const splitMessage = useFolderSplitStatus();
  const [shown, setShown] = useState(status), [open, setOpen] = useState(false), [retrying, setRetrying] = useState<ProcessingStageId | OptionalCheckId | null>(null), [retryError, setRetryError] = useState("");
  const latest = useRef(status); latest.current = status;
  // The waiting room shows this shoot's reading status itself, so the top bar doesn't say it twice there.
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => { if (typeof window === "undefined") return; const on = () => setRoute(currentRoute()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  const last = useRef(Date.now());
  useEffect(() => {
    const remaining = Math.max(0, 1000 - (Date.now() - last.current));
    const timer = setTimeout(() => { last.current = Date.now(); setShown(latest.current); }, remaining);
    return () => clearTimeout(timer);
  }, [status]);
  if (splitMessage && route?.page === "shoots") return <div role="status" data-folder-split-status className="min-w-0 flex-1 truncate text-right text-micro text-muted">{splitMessage}</div>;
  if (!shown || shown.wait && route?.page === "wait" && route.params.shoot === shown.root) return null;
  const detail = shown.details.join("\n");
  return <div className="relative min-w-0 flex-1">
    <button type="button" data-shoot-status data-opens-wait={shown.wait || undefined} onClick={() => {
      // WR2: processing opens the waiting room; once there (or for Preparing/Exporting) it shows the details.
      if (shown.wait && shown.root && !(readHash().page === "wait" && readHash().params.shoot === shown.root)) { setOpen(false); go("wait", { shoot: shown.root }); }
      else setOpen(value => !value);
    }} aria-expanded={open} aria-label={`Open ${shown.headline}`} title={detail}
      className="flex h-8 w-full min-w-0 items-center justify-end gap-2 overflow-hidden text-micro text-muted outline-none focus-visible:underline">
      {shown.failed ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-danger" /> : /^(?:Checking previews|Making \d+(?: more)? clips? smooth)$/.test(shown.headline) ? null : <ProgressRing pct={shown.long ? shown.pct : null} label={shown.headline} />}
      <span role="status" className="truncate">{shown.headline}</span>
      {shown.long && (shown.counts || shown.pct !== null) && <span className="tnum shrink-0">{` · ${shown.counts ?? formatPercent(shown.pct!)}`}</span>}
      {shown.long && shown.eta && <span className="tnum shrink-0">{shown.eta}</span>}
    </button>
    {open ? <SourceNames root={shown.root}><div role="region" aria-label="Task details" className="absolute right-0 top-full z-50 min-w-64 rounded-lg bg-ground p-3 text-micro text-muted">
      {calm ? <p data-calm className="mb-2">{calm}</p> : null}
      {resource && resource.mode !== "full" && resource.canFullSpeed && resource.taskId && onFullSpeed ? <button type="button"
        className="mb-2 rounded-full bg-ink/[0.06] px-3 py-1 text-ink hover:bg-ink/[0.1] focus-visible:underline"
        onClick={() => { void onFullSpeed(resource.taskId!).catch(() => setRetryError("Couldn't change speed. Try again.")); }}>Full speed</button> : null}
      {shown.stages ? <ul aria-label="Progress" className="space-y-1">{shown.stages.map(stage => <li key={stage.label} data-state={stage.state} className="flex justify-between gap-6"><span>{stage.label}</span><span className={`tnum ${stage.state === "skipped" && (shown as { needsAi?: boolean }).needsAi ? "text-accent" : ""}`}>{stage.state === "running" ? formatPercent(stage.pct) : stage.state === "skipped" && (shown as { needsAi?: boolean }).needsAi ? STAGE_NEEDS_AI : stateWord[stage.state] ?? ""}</span></li>)}</ul>
        : shown.failures.length ? null : shown.details.map((text, index) => <p key={index}><NamedMessage>{text}</NamedMessage></p>)}
      {shown.failures.map(failure => <div key={failure.id} data-failure={failure.id} className="mt-3">
        <p className="text-ink">{failure.text}</p>
        {failure.detail ? <details><summary className="cursor-pointer">Details</summary><p className="mt-1 whitespace-pre-wrap"><NamedMessage>{failure.detail}</NamedMessage></p></details> : null}
        {onRetry ? <button type="button" disabled={retrying !== null} className="mt-1 rounded-full bg-ink/[0.06] px-3 py-1 text-ink hover:bg-ink/[0.1] disabled:opacity-45"
          onClick={() => { setRetrying(failure.id); setRetryError(""); void onRetry(failure.id).catch(e => setRetryError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+':\s*/i, "") : "Couldn't retry. Try again.")).finally(() => setRetrying(null)); }}>{retrying === failure.id ? "Retrying" : "Retry"}</button> : null}
      </div>)}
      {retryError ? <InlineError className="mt-2 text-danger">{retryError}</InlineError> : null}
      {onOpen ? <button type="button" onClick={onOpen} className="mt-2 underline focus-visible:underline">Open task</button> : null}
      <button type="button" onClick={() => setOpen(false)} className="ml-3 mt-2 underline">Close</button>
    </div></SourceNames> : null}
  </div>;
}
