// One in-memory stream for local work. The injected clock/sinks keep the bus
// testable without starting Electron or invoking any model.
import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe } from "node:diagnostics_channel";
import { setPriority } from "node:os";
import { basename } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Activity, ActivityStage } from "../shared/schema";
import { governor } from "./resource-governor";

// Node publishes this channel when a ChildProcess is created, before it has a
// pid. Apply niceness on spawn, covering execFile as well as spawn callers in
// grading, titles and processing. Python/Swift descendants inherit priority.
let priorityWarningShown = false;
subscribe("child_process", message => {
  const child = (message as { process: ChildProcess }).process;
  const slot = renderSlot.getStore();
  if (!current.getStore() && !slot?.active) return;
  if (!personStarted()) backgroundChildren.add(child);
  if (slot?.active) {
    slot.children.add(child);
    childSlots.set(child, slot);
    child.once("close", () => slot.children.delete(child));
  }
  // V14: critical heat holds all activity children, including exports.
  if (current.getStore() || slot?.active) {
    heldChildren.add(child);
    child.once("close", () => heldChildren.delete(child));
    const handle = current.getStore();
    handle?.signal.addEventListener("abort", () => { try { child.kill("SIGCONT"); } catch { /* gone */ } }, { once: true });
  }
  child.once("spawn", () => syncChildPause(child));
  child.once("spawn", () => {
    if (!child.pid || !/^(?:ffmpeg|python(?:\d+(?:\.\d+)*)?|swift(?:c)?|matte|subject|quality|screen-read|track)$/.test(basename(child.spawnfile))) return;
    const task = requestedTask.getStore();
    if (task?.active && (task.awaiting || governor.isFullSpeedTask(task.id))) return;
    try { setPriority(child.pid, 10); }
    catch (error) {
      // A short probe may have exited; restricted hosts can deny renicing.
      const code = (error as NodeJS.ErrnoException & { info?: { code?: string } }).info?.code ?? (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && !priorityWarningShown) {
        priorityWarningShown = true;
        console.warn(`Could not lower media process priority (${code}).`);
      }
    }
  });
});

const heldChildren = new Set<ChildProcess>();
const backgroundChildren = new WeakSet<ChildProcess>();
const childSlots = new WeakMap<ChildProcess, RenderSlot>();
function syncChildPause(child: ChildProcess) {
  // DEAD1: shared work a running render awaits is never held by that render's lane or by playback; heat still holds it.
  const slot = childSlots.get(child), lent = !!slot && lentTo(slot.shares, new Set([slot]));
  const paused = !lent && (slot?.paused || backgroundChildren.has(child) && governor.playbackBusy)
    || heldChildren.has(child) && governor.profile.pauseBackground;
  if (child.pid) { try { child.kill(paused ? "SIGSTOP" : "SIGCONT"); } catch { /* gone */ } }
}
// A quit during playback must not strand one of our workers in SIGSTOP after
// its parent exits. Only children registered by this process are signaled.
process.once("exit", () => {
  for (const child of heldChildren) {
    try { child.kill("SIGTERM"); child.kill("SIGCONT"); } catch { /* already exited */ }
  }
});
governor.onChange((_profile, state) => {
  for (const child of heldChildren) syncChildPause(child);
  advanceRenderLane();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) { try { win.webContents.send("api:resourceState", state); } catch { /* closed */ } }
  }
});

export type ActivityInput = Pick<Activity, "kind" | "root" | "target" | "label" | "cancelable">;
/** EXP1: a staged task's stages in order, each with its rough share of the task's time. */
export type StagePlan = readonly (readonly [ActivityStage, number])[];
export type StageDetail = { doneS?: number | null; lengthS?: number | null; part?: readonly [index: number, count: number] };
export interface ActivityHandle {
  signal: AbortSignal;
  progress(pct: number | null, note?: string, etaS?: number | null): void;
  update(patch: Partial<Pick<Activity, "kind" | "label" | "target">>): void;
  done(note?: string): void;
  fail(message: string): void;
  /** EXP1: the current stage and how far through it (0..1). Under a stage plan (runActivity's `stages`) the task's
   * pct is worked out from here and only rises, plain progress() keeps its note but no longer moves pct, and the
   * time left comes from the picture's own pace. Without a plan it only names the stage. */
  stage?(stage: ActivityStage, fraction?: number | null, detail?: StageDetail): void;
}
const snapshot = (a: Activity): Activity => ({ ...a, target: a.target ? { ...a.target } : null });

export function createActivityBus(deps: {
  now?: () => number;
  broadcast: (activity: Activity) => void;
  finished?: (activity: Activity) => void;
}) {
  const now = deps.now ?? Date.now;
  const activities = new Map<string, Activity>();
  const handles = new Map<string, ActivityHandle>();
  const controllers = new Map<string, AbortController>();
  const finishedIds: string[] = [];
  function publish(a: Activity) {
    try { deps.broadcast(snapshot(a)); } catch { /* A closing window cannot fail work. */ }
  }
  return {
    list(): Activity[] { return [...activities.values()].map(snapshot); },
    cancel(id: string): void {
      const activity = activities.get(id);
      if (activity?.state === "running" && activity.cancelable) controllers.get(id)?.abort();
    },
    progressForTarget(root: string, cutId: string, pct: number, note?: string) {
      for (const a of activities.values()) if (a.state === "running" && a.root === root && a.target?.cutId === cutId) {
        handles.get(a.id)?.progress(pct, note);
      }
    },
    begin(input: ActivityInput, parentSignal?: AbortSignal, stages?: StagePlan): ActivityHandle {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const started = now();
      const a: Activity = { ...input, target: input.target ? { ...input.target } : null,
        id: randomUUID(), state: "running", pct: null, etaS: null, note: null,
        startedAt: new Date(started).toISOString(), endedAt: null,
        ...(stages?.length ? { stage: stages[0][0], stagePct: 0, pct: 0 } : {}) };
      let baseline: { pct: number; time: number } | null = null;
      // EXP1: staged progress. The pace is measured from the picture's first frames, never from preparation.
      const plan = stages?.length ? stages : null;
      const total = plan ? plan.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0) || 1 : 1;
      let part: readonly [number, number] = [0, 1];
      let pace: { pct: number; time: number } | null = null, told: { etaS: number; time: number } | null = null;
      const finish = (state: "done" | "failed", note?: string) => {
        if (a.state !== "running") return;
        a.state = state;
        a.note = note ?? null;
        a.etaS = null;
        if (state === "done") a.pct = 100;
        a.endedAt = new Date(now()).toISOString();
        handles.delete(a.id);
        controllers.delete(a.id);
        parentSignal?.removeEventListener("abort", abort);
        finishedIds.push(a.id);
        while (finishedIds.length > 20) activities.delete(finishedIds.shift()!);
        publish(a);
        if (!controller.signal.aborted && note !== "Canceled" && now() - started > 15_000) {
          try { deps.finished?.(snapshot(a)); } catch { /* OS notifications are optional. */ }
        }
      };
      const handle: ActivityHandle = {
        signal: controller.signal,
        progress(pct, note, etaS) {
          if (a.state !== "running") return;
          if (plan) { if (note !== undefined) { a.note = note; publish(a); } return; }
          const value = pct === null || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, pct));
          if (value === null || (baseline && value < baseline.pct) || (a.pct !== null && value !== null && value < a.pct)) baseline = null;
          if (value !== null && !baseline) baseline = { pct: value, time: now() };
          a.pct = value;
          if (note !== undefined) a.note = note;
          a.etaS = value !== null && baseline && value > baseline.pct && now() - baseline.time >= 1000
            ? Math.ceil((100 - value) * (now() - baseline.time) / (value - baseline.pct) / 1000) : null;
          if (etaS !== undefined) a.etaS = etaS !== null && Number.isFinite(etaS) ? Math.max(0, etaS) : null;
          publish(a);
        },
        update(patch) {
          if (a.state !== "running") return;
          if (patch.kind !== undefined) a.kind = patch.kind;
          if (patch.label !== undefined) a.label = patch.label;
          if (patch.target !== undefined) a.target = patch.target ? { ...patch.target } : null;
          publish(a);
        },
        done: note => finish("done", note),
        fail: message => finish("failed", message),
        stage(name, fraction, detail) {
          if (a.state !== "running") return;
          const f = fraction === null || fraction === undefined || !Number.isFinite(fraction) ? null : Math.max(0, Math.min(1, fraction));
          if (detail?.part) { const [index, count] = detail.part; if (count >= 1 && index >= 0 && index < count) part = [index, count]; }
          a.stage = name; a.stagePct = f === null ? null : Math.round(f * 1000) / 10;
          if (detail?.doneS !== undefined) a.doneS = detail.doneS === null ? null : Math.max(0, detail.doneS);
          if (detail?.lengthS !== undefined) a.lengthS = detail.lengthS;
          const at = plan?.findIndex(([stage]) => stage === name) ?? -1;
          if (plan && at >= 0) {
            const before = plan.slice(0, at).reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
            const within = (before + Math.max(0, plan[at][1]) * (f ?? 0)) / total;
            const value = Math.max(a.pct ?? 0, Math.min(100, (part[0] + within) / part[1] * 100));
            a.pct = Math.round(value * 10) / 10;
            const time = now();
            if (!pace && name === "picture" && (f ?? 0) > 0) pace = { pct: value, time };
            // EXP2: frames arrive sooner now (fused LUT, software decode), so the time left
            // settles after a fiftieth of the picture and three seconds of pace. It still
            // needs half a percent of measured progress and only counts down calmly.
            const settled = name !== "picture" || ((f ?? 0) >= .02 && time - (pace?.time ?? time) >= 3_000);
            if (pace && settled && value - pace.pct >= 0.5) {
              const measured = (100 - value) * (time - pace.time) / (value - pace.pct) / 1000;
              // One calm number: it counts down, and only rises when the work is clearly slower than it said.
              const projected = told ? told.etaS - (time - told.time) / 1000 : null;
              const etaS = projected === null || measured <= projected || measured > projected * 1.2 ? measured : Math.max(0, projected);
              told = { etaS, time }; a.etaS = Math.ceil(etaS);
            }
          }
          publish(a);
        },
      };
      activities.set(a.id, a);
      handles.set(a.id, handle);
      controllers.set(a.id, controller);
      controller.signal.addEventListener("abort", () => finish("failed", "Canceled"), { once: true });
      publish(a);
      parentSignal?.addEventListener("abort", abort, { once: true });
      if (parentSignal?.aborted) abort();
      return handle;
    },
  };
}

let completion: ((activity: Activity) => void) | undefined;
export function setActivityCompletionHandler(handler: (activity: Activity) => void): void { completion = handler; }
const bus = createActivityBus({
  broadcast(activity) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        try { win.webContents.send("api:activity", activity); } catch { /* closed */ }
      }
    }
  },
  finished: activity => completion?.(activity),
});
export const begin = bus.begin;
export const progressForTarget = bus.progressForTarget;
export async function listActivity(): Promise<Activity[]> { return bus.list(); }
export async function cancelActivity(id: string): Promise<void> { bus.cancel(id); }
const current = new AsyncLocalStorage<ActivityHandle>();
const requestedTask = new AsyncLocalStorage<{ id: string; active: boolean; awaiting: boolean } | undefined>();
// PERF1: what the person started is never paused or delayed; the rest is background.
const activityKinds = new WeakMap<ActivityHandle, Activity["kind"]>();
const BACKGROUND_KINDS: ReadonlySet<Activity["kind"]> = new Set(["process", "judge", "ideas", "setup", "looks"]);
export function isBackgroundActivity(kind: Activity["kind"] | undefined, lane?: string): boolean {
  return lane !== undefined ? lane === "background" : !kind || BACKGROUND_KINDS.has(kind);
}
function personStarted(): boolean {
  // Shared preparation awaited inside a render reuses that render's lane.
  const slot = renderSlot.getStore();
  if (slot?.active) return slot.lane !== "background";
  const handle = current.getStore();
  if (!handle) return true;
  return !isBackgroundActivity(activityKinds.get(handle), activityLanes.get(handle));
}
/** Thread count for an ffmpeg or encoder job here, under the current heat, power and playback state. */
export function threads(requested: number): number {
  const task = requestedTask.getStore();
  return governor.threads(requested, task?.active ? task.awaiting : personStarted(), task?.active ? task.id : undefined);
}
/** Background analysis rests between clips when the Mac is warm or the person is watching. */
export function restBetweenClips(signal?: AbortSignal): Promise<void> {
  return personStarted() ? Promise.resolve() : governor.betweenClips(signal);
}
const groupedActivity = new AsyncLocalStorage<boolean>();
export function currentActivity(): ActivityHandle | undefined { return current.getStore(); }
/** PRO2b: run helper work with a stand-in as its current activity (the stand-in carries the task's own signal), so a
 * helper's own progress reports (a window render's 0 to 100) reach the stand-in, which folds them into the task's. */
export function asActivity<T>(handle: ActivityHandle, work: () => Promise<T>): Promise<T> { return current.run(handle, work); }
/** Shared immutable measurements belong to their own activity, regardless of
 * which playback request first imports this module or starts the work. */
export function independentPreparation<T>(work: () => Promise<T>): Promise<T> {
  // Retain a nested media slot: an export may be awaiting this preparation
  // while holding it. Reacquiring the same lane would deadlock the export.
  return current.exit(() => groupedActivity.exit(work));
}


// Two owners: waited work never queues behind a cache. Drafts retain their
// priority within the waited lane; "finished" remains a compatible waited name.
type RenderLane = "draft" | "finished" | "waited" | "background";
// Covers and voice envelopes are optional caches. Their nested slot calls must
// inherit this lane too, including callers that explicitly requested finished.
const activityLanes = new WeakMap<ActivityHandle, RenderLane>();
const pinnedBackground = new WeakSet<ActivityHandle>();
type RenderSlot = { active: boolean; paused: boolean; lane: RenderLane; children: Set<ChildProcess>;
  /** DEAD1: the shared work this slot runs, and the shared work it is waiting on. */
  shares?: Set<SharedWork>; lends?: Set<SharedWork> };
const renderSlot = new AsyncLocalStorage<RenderSlot>();
let owner: RenderSlot | undefined;
let suspended: RenderSlot | undefined;
let backgroundOwner: RenderSlot | undefined;
const renderWaiters: { lane: RenderLane; slot: RenderSlot; start: (lent?: boolean) => void }[] = [];
/** Long-lived worker pools yield at a clip boundary for other cache producers. */
export function backgroundWorkWaiting(): boolean { return renderWaiters.some(waiter => waiter.lane === 'background'); }
function pauseSlot(slot: RenderSlot, paused: boolean) {
  if (slot.paused === paused) return;
  slot.paused = paused;
  syncSlot(slot);
}
function syncSlot(slot: RenderSlot, seen = new Set<RenderSlot>()) {
  if (seen.has(slot)) return;
  seen.add(slot);
  for (const child of slot.children) syncChildPause(child);
  for (const work of slot.lends ?? []) for (const producer of work.slots) syncSlot(producer, seen);
}

// DEAD1: cache work several callers await (one recorder WAV's sound scan) runs in whichever lane started it, usually
// background. A render that awaits it lends it its own lane: while that render runs, the work's slots run too (a held
// one continues, a queued one starts at once), so an export never waits on work its own slot paused (31 Oct: a 290 MB
// scan a timeline read started stayed stopped for 24 min under the export that needed it). Work nobody running awaits
// still yields as before.
type SharedWork = { slots: Set<RenderSlot>; lenders: Map<RenderSlot, number>; wake: Set<() => void> };
const sharedWork = new AsyncLocalStorage<SharedWork>();
const sharedJobs = new WeakMap<Promise<unknown>, SharedWork>();
/** Slots started for a render that awaited them: no lane owner, held like the background owner once nobody waits. */
const borrowed = new Set<RenderSlot>();
function running(slot: RenderSlot, seen: Set<RenderSlot>): boolean {
  if (seen.has(slot)) return false;
  seen.add(slot);
  return slot.active && (!slot.paused || lentTo(slot.shares, seen));
}
function lentTo(works: Iterable<SharedWork> | undefined, seen = new Set<RenderSlot>()): boolean {
  for (const work of works ?? []) for (const slot of work.lenders.keys()) if (running(slot, seen)) return true;
  return false;
}
/** Run cache work other callers may await with awaitShared. */
export function shareWork<T>(work: () => Promise<T>): Promise<T> {
  const shared: SharedWork = { slots: new Set(), lenders: new Map(), wake: new Set() };
  const slot = renderSlot.getStore();
  if (slot?.active) { shared.slots.add(slot); (slot.shares ??= new Set()).add(shared); }
  const job = sharedWork.run(shared, work);
  sharedJobs.set(job, shared);
  return job;
}
/** Await shared work. Inside a render slot it runs in that slot's lane until it settles or the render ends. */
export async function awaitShared<T>(job: Promise<T>): Promise<T> {
  const work = sharedJobs.get(job), slot = renderSlot.getStore();
  if (!work || !slot?.active) return job;
  work.lenders.set(slot, (work.lenders.get(slot) ?? 0) + 1);
  (slot.lends ??= new Set()).add(work);
  relend(work);
  try { return await job; }
  finally {
    const count = (work.lenders.get(slot) ?? 1) - 1;
    if (count) work.lenders.set(slot, count);
    else { work.lenders.delete(slot); slot.lends.delete(work); }
    relend(work);
  }
}
function relend(work: SharedWork) {
  if (lentTo([work])) for (const wake of [...work.wake]) wake();
  advanceRenderLane();
  for (const slot of work.slots) syncSlot(slot);
}
/** A lane or playback wait that ends early once a running render awaits this shared work. Other work waits exactly
 * as before (the same promise, no extra turns: lane order between simultaneous requests depends on it). */
function unlessLent(work: SharedWork | undefined, wait: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
  if (!work) return wait(signal);
  if (lentTo([work])) return Promise.resolve();
  const lent = new AbortController(), wake = () => lent.abort();
  work.wake.add(wake);
  return wait(AbortSignal.any([signal, lent.signal])).catch(error => { if (signal.aborted || !lent.signal.aborted) throw error; })
    .finally(() => work.wake.delete(wake));
}

function advanceRenderLane() {
  for (const waiter of [...renderWaiters]) if (lentTo(waiter.slot.shares, new Set([waiter.slot]))) {
    renderWaiters.splice(renderWaiters.indexOf(waiter), 1); waiter.start(true);
  }
  if (!owner) {
    const draft = renderWaiters.findIndex(w => w.lane === "draft");
    if (draft >= 0) renderWaiters.splice(draft, 1)[0].start();
    else if (suspended?.active) {
      owner = suspended; suspended = undefined; pauseSlot(owner, false);
    } else {
      suspended = undefined;
      const waited = renderWaiters.findIndex(w => w.lane !== "background");
      if (waited >= 0) renderWaiters.splice(waited, 1)[0].start();
    }
  }
  // A thermal change must never continue a child still held by the other lane.
  if (backgroundOwner) pauseSlot(backgroundOwner, !!owner || governor.playbackBusy);
  for (const slot of borrowed) if (slot.lane === "background") pauseSlot(slot, !!owner || governor.playbackBusy);
  if (!owner && !backgroundOwner && !governor.profile.pauseBackground && !governor.playbackBusy) renderWaiters.shift()?.start();
}
export async function withRenderSlot<T>(activity: ActivityHandle, work: () => Promise<T>,
  lane: RenderLane = activityLanes.get(activity) ?? "background"): Promise<T> {
  if (renderSlot.getStore()?.active) return work();
  // Optional cache work stays behind playback even when a nested helper asks
  // for the finished lane explicitly.
  if (pinnedBackground.has(activity)) lane = "background";
  // Make it better groups its render helpers into the person-started task,
  // including older helpers which explicitly asked for background scheduling.
  else if (groupedActivity.getStore() && activityLanes.has(activity)) lane = activityLanes.get(activity)!;
  const slot: RenderSlot = { active: true, paused: false, lane, children: new Set() };
  const shared = sharedWork.getStore();
  if (shared) { shared.slots.add(slot); slot.shares = new Set([shared]); }
  if (lane === "background") {
    await unlessLent(shared, signal => governor.whenMemoryAllows(signal), activity.signal);
    await unlessLent(shared, signal => governor.whenRunnable({ signal }), activity.signal);
  }
  await new Promise<void>((resolve, reject) => {
    activity.signal.throwIfAborted();
    const waiter = { lane, slot, start: (lent?: boolean) => {
      if (lent) borrowed.add(slot);
      else if (lane === "background") backgroundOwner = slot;
      else owner = slot;
      activity.signal.removeEventListener("abort", abort);
      activity.progress(null, ""); resolve();
    } };
    const abort = () => {
      const index = renderWaiters.indexOf(waiter);
      if (index >= 0) renderWaiters.splice(index, 1);
      slot.active = false; reject(activity.signal.reason); advanceRenderLane();
    };
    renderWaiters.push(waiter);
    activity.progress(null, "Waiting");
    activity.signal.addEventListener("abort", abort, { once: true });
    if (activity.signal.aborted) { abort(); return; }
    if (lane === "draft" && owner && owner.lane !== "draft") {
      suspended = owner; pauseSlot(owner, true); owner = undefined;
    }
    advanceRenderLane();
  });
  try {
    activity.signal.throwIfAborted();
    return await renderSlot.run(slot, work);
  } finally {
    slot.active = false;
    // A stopped child may be canceled while a draft owns the lane.
    if (owner === slot) owner = undefined;
    if (suspended === slot) { pauseSlot(slot, false); suspended = undefined; }
    if (backgroundOwner === slot) { pauseSlot(slot, false); backgroundOwner = undefined; }
    if (borrowed.delete(slot)) pauseSlot(slot, false);
    shared?.slots.delete(slot);
    advanceRenderLane();
    // Shared work this render was waiting on yields again.
    for (const work of slot.lends ?? []) for (const producer of work.slots) syncSlot(producer);
  }
}
/** Await a shared sound cache without holding the slot its producer needs.
 * Restore the same owner's slot before the caller resumes encoding. */
export async function awaitSoundPreparation<T>(prepare: () => Promise<T>): Promise<T> {
  const slot=renderSlot.getStore(), activity=currentActivity();
  if(!slot?.active || slot.lane==='background' || !activity)return prepare();
  slot.active=false;
  if(owner===slot)owner=undefined;
  if(suspended===slot)suspended=undefined;
  pauseSlot(slot,true);advanceRenderLane();
  try { return await renderSlot.exit(prepare); }
  finally {
    await renderSlot.exit(()=>withRenderSlot(activity,async()=>{
      const borrowed=renderSlot.getStore()!;
      slot.active=true;slot.lane=borrowed.lane;
      if(owner===borrowed)owner=slot;
      pauseSlot(slot,false);
    },slot.lane));
  }
}

export async function runActivity<T>(input: ActivityInput, work: (activity: ActivityHandle) => Promise<T>,
  options: { deferRenderSlot?: boolean; renderLane?: RenderLane; groupChildren?: boolean; stages?: StagePlan } = {}): Promise<T> {
  const parent = currentActivity();
  if (parent && groupedActivity.getStore()) {
    parent.signal.throwIfAborted();
    return work(parent);
  }
  const activity = begin(input, currentActivity()?.signal, options.stages);
  const parentSlot = renderSlot.getStore();
  const parentLane = parentSlot?.active ? parentSlot.lane : parent && activityLanes.get(parent);
  const optionalCache = input.label === "Making cover" || input.label === "Preparing voice waveform" || input.label === "Measuring shake";
  const background = optionalCache || parentLane === "background" && !requestedTask.getStore()?.awaiting;
  const lane: RenderLane = background ? "background" : options.renderLane ?? (input.label === "Preparing sound" ? "draft" : isBackgroundActivity(input.kind) ? "background" : "waited");
  activityLanes.set(activity, lane);
  if (background || options.renderLane === "background") pinnedBackground.add(activity);
  activityKinds.set(activity, input.kind);
  const inheritedTask = requestedTask.getStore();
  const waited = !background && (inheritedTask?.awaiting || options.renderLane !== "background" && (lane !== "background" || /^Rethinking\b/.test(input.label)));
  const task = inheritedTask?.active && !optionalCache ? inheritedTask : { id: randomUUID(), active: true, awaiting: !!waited };
  const priority = ({ export: 0, render: 1, process: 2, setup: 2, cut: 3 } as Partial<Record<Activity["kind"], number>>)[input.kind] ?? 4;
  const releaseTask = task !== inheritedTask ? governor.beginTask(task.id, task.awaiting, priority) : undefined;
  try {
    activity.signal.throwIfAborted();
    await unlessLent(sharedWork.getStore(), signal => governor.whenRunnable({ personStarted: !!waited, signal }), activity.signal);
    const result = await requestedTask.run(task, () => current.run(activity, () => groupedActivity.run(!!options.groupChildren, () => input.kind === "render" && !options.deferRenderSlot
      ? withRenderSlot(activity, () => work(activity), lane) : work(activity))));
    activity.signal.throwIfAborted();
    activity.done();
    return result;
  } catch (error) {
    const canceled = activity.signal.aborted || (error instanceof Error && error.name === "AbortError");
    activity.fail(canceled ? "Canceled" : error instanceof Error ? error.message : "Could not finish this task. Try again.");
    throw error;
  } finally {
    if (releaseTask && task) { task.active = false; releaseTask(); }
  }
}

export function activityHash(activity: Activity): string {
  const params = new URLSearchParams();
  if (activity.root) params.set("shoot", activity.root);
  const keys = { cutId: "cut", version: "v", ideaId: "idea", clipId: "clip" };
  for (const [key, value] of Object.entries(activity.target ?? {})) if (value !== undefined) params.set(keys[key as keyof typeof keys], String(value));
  const page = activity.kind === "setup" ? "shoots" : activity.target?.cutId ? "precuts"
    : activity.kind === "ideas" ? "ideas" : "clips";
  return `#/${page}${params.size ? `?${params}` : ""}`;
}
export function activityNotificationBody(activity: Activity): string {
  if (activity.label === "Making it better") return activity.state === "failed" ? `Couldn't make it better: ${activity.note ?? "Try again."}` : "Make it better is done. See what changed";  // MB1
  if (activity.state === "failed") {
    const task = ({ titles: "titles", finish: "finishing the cut", render: "rendering the video", export: "the export",
      process: "processing the shoot", judge: "checking takes", ideas: "finding ideas", cut: "the cut", edit: "the edit",
      setup: "setup", looks: "the look previews" } as const)[activity.kind];
    return `Couldn't finish ${task}: ${activity.note ?? "Try again."}`;
  }
  if (activity.kind === "render") return activity.label === "Rendering finished video" ? "Your video is ready to watch"
    : `${activity.label.replace(/^Rendering /, "")} is ready to watch`;
  if (activity.kind === "cut") return `${activity.label.replace(/^Cutting /, "")} is ready to watch`;
  if (activity.kind === "setup") return "precut is ready";
  if (activity.kind === "export") return `${activity.label.replace(/^Exporting to /, "Export to ")} is ready`;
  if (activity.kind === "ideas") return "Your ideas are ready";
  if (activity.kind === "titles") return "Your titles are ready";
  if (activity.kind === "finish") return `${activity.label.replace(/^Finishing /, "")} is ready to watch`;
  if (activity.kind === "edit") return "Your cut has been updated";
  if (activity.kind === "judge") return "Your takes are ready";
  if (activity.kind === "looks") return "Your look previews are ready";
  return `${activity.label.replace(/^Processing /, "")} is ready`;
}
