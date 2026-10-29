// PERF1: precut is gentle with the Mac. One place decides how hard background
// work may push: heat (macOS thermal state), battery, low-power mode, whether
// the person is playing or dragging, and free memory. Pure and injectable so
// the policy is testable without Electron; main/index.ts feeds it powerMonitor.
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import type { ResourceState } from "../shared/schema";

export type ThermalState = "nominal" | "fair" | "serious" | "critical" | "unknown";
export type ProfileName = "full" | "fair" | "serious" | "critical" | "busy";

/** Every threshold lives here, nowhere else. Plugged in, cool and idle is `full`:
 * no cap, so jobs keep their own existing thread ceiling and first processing stays fast. */
export const GOVERNOR = {
  /** Share of cores per profile; `full` keeps whatever the caller asked for. */
  coreShare: { fair: 1 / 2, serious: 1 / 4, critical: 1 / 4, busy: 1 / 8 },
  /** Background decode-heavy jobs allowed at once, per profile. */
  backgroundJobs: { full: 2, fair: 1, serious: 1, critical: 0, busy: 1 },
  /** Wait before background work speeds up again after the person stops. */
  busyResumeMs: 4000,
  /** Background jobs skip starting below this share of memory free. */
  minFreeMemory: 0.20,
  /** Retry delay while memory is short. */
  memoryRetryMs: 5000,
  /** Pause between clips at serious heat so fans can settle. */
  seriousClipPauseMs: 1500,
} as const;

export interface GovernorInputs {
  thermal: ThermalState;
  onBattery: boolean;
  lowPower: boolean;
  /** The person is playing or dragging right now (or did a moment ago). */
  busy: boolean;
  foreground?: boolean;
  awaiting?: boolean;
  batteryPercent?: number;
  fullSpeed?: boolean;
}
export interface Profile {
  name: ProfileName;
  /** Thread cap for background work; `null` = no cap (the caller's own ceiling). */
  threadShare: number | null;
  backgroundJobs: number;
  /** Background work is paused entirely until things cool down. */
  pauseBackground: boolean;
  /** Analysis waits a moment between clips. */
  pauseBetweenClips: boolean;
}

const RANK: Record<ProfileName, number> = { full: 0, fair: 1, serious: 2, critical: 3, busy: 2 };

/** The profile for background work. Pure. */
export function profileFor(input: GovernorInputs): Profile {
  const candidates: ProfileName[] = ["full"];
  if (input.thermal === "fair" || input.thermal === "serious" || input.thermal === "critical") candidates.push(input.thermal);
  const batteryLimited = input.onBattery && !(input.fullSpeed || input.foreground && input.awaiting && (input.batteryPercent ?? 0) > 30);
  if (batteryLimited) candidates.push("fair");
  if (input.onBattery && (input.batteryPercent ?? 100) <= 30 && !input.fullSpeed) candidates.push("fair");
  if (input.lowPower && !input.fullSpeed) candidates.push("serious");
  let name = candidates.reduce((worst, next) => RANK[next] > RANK[worst] ? next : worst);
  // The lowest profile while the person plays or drags, unless heat is worse.
  if (input.busy && !input.awaiting && name !== "critical") name = "busy";
  return {
    name,
    threadShare: name === "full" ? null : GOVERNOR.coreShare[name],
    backgroundJobs: GOVERNOR.backgroundJobs[name],
    pauseBackground: name === "critical",
    pauseBetweenClips: name === "serious" || name === "critical" || name === "busy",
  };
}

/** Threads for one job under a profile: the profile's share of what the job would
 * use cool (so a 4-thread job halves to 2 even on a 16-core Mac), never above that
 * share of the cores. Awaited work still respects heat and battery safety. */
export function threadsFor(requested: number, profile: Profile, cores: number, personStarted: boolean): number {
  const want = Math.max(1, Math.floor(requested));
  const share = personStarted && profile.name === "busy" ? null : profile.threadShare;
  if (share === null) return want;
  return Math.max(1, Math.min(Math.ceil(want * share), Math.ceil(cores * share)));
}

/** Share of memory the Mac can hand out now. macOS keeps "free" tiny on purpose
 * (cache fills the rest), so count free, inactive, speculative and purgeable pages. */
export function parseVmStat(text: string, total = os.totalmem()): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  if (!size) return null;
  const available = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * size;
  return Math.min(1, available / total);
}
let memoryCache: { at: number; share: number } | undefined;
export function availableMemoryShare(): number {
  const t = Date.now();
  if (memoryCache && t - memoryCache.at < 3000) return memoryCache.share;
  let share = os.freemem() / os.totalmem();
  if (process.platform === "darwin") {
    try { share = parseVmStat(execFileSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 1000 })) ?? share; } catch { /* keep os.freemem */ }
  }
  memoryCache = { at: t, share };
  return share;
}

export interface GovernorDeps {
  cores?: number;
  freeShare?: () => number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export function createGovernor(deps: GovernorDeps = {}) {
  const cores = deps.cores ?? os.cpus().length;
  const freeShare = deps.freeShare ?? availableMemoryShare;
  const now = deps.now ?? Date.now;
  const later = deps.setTimeout ?? setTimeout, cancel = deps.clearTimeout ?? clearTimeout;
  const raw = { thermal: "nominal" as ThermalState, onBattery: false, lowPower: false, foreground: false, batteryPercent: undefined as number | undefined };
  const tasks = new Map<string, { awaiting: boolean; fullSpeed: boolean; priority: number }>();
  const currentTask = () => [...tasks].sort((a, b) => Number(b[1].awaiting) - Number(a[1].awaiting) || a[1].priority - b[1].priority)[0];
  const inputs = (awaiting = currentTask()?.[1].awaiting ?? false, taskId = currentTask()?.[0]): GovernorInputs => ({ ...raw, busy, awaiting,
    fullSpeed: taskId ? tasks.get(taskId)?.fullSpeed === true : false });
  let busy = false, busyTimer: ReturnType<typeof setTimeout> | undefined, busyUntil = 0;
  let profile = profileFor({ ...raw, busy });
  const listeners = new Set<(profile: Profile, state: ResourceState) => void>();
  const waiters = new Set<() => void>();
  let decodeHolder = 0; const decodeQueue: (() => void)[] = [];
  let backgroundRunning = 0; const backgroundQueue: (() => void)[] = [];

  const stateOf = (p: Profile): ResourceState => {
    const reason: ResourceState["reason"] = p.name === "busy" ? "busy"
      : raw.thermal === "fair" || raw.thermal === "serious" || raw.thermal === "critical" ? "warm"
      : raw.lowPower || raw.onBattery ? "battery" : null;
    return { mode: p.name === "full" ? "full" : p.pauseBackground ? "paused" : p.name === "fair" ? "calm" : "quiet", reason,
      batteryContext: raw.lowPower ? "low-power" : raw.batteryPercent === undefined ? undefined : raw.batteryPercent <= 30 ? "low" : !raw.foreground ? "background" : "preparation",
      taskId: currentTask()?.[0] ?? null, canFullSpeed: tasks.size > 0 && (raw.onBattery || raw.lowPower) && !currentTask()?.[1].fullSpeed };
  };
  let lastBusy = false;
  function recompute() {
    const previousState = JSON.stringify(stateOf(profile));
    const next = profileFor(inputs());
    const changed = next.name !== profile.name || previousState !== lastState || busy !== lastBusy;
    lastBusy = busy;
    profile = next;
    lastState = JSON.stringify(stateOf(profile));
    if (changed) {
      for (const listener of [...listeners]) { try { listener(profile, stateOf(profile)); } catch { /* observers never break work */ } }
      for (const wake of [...waiters]) wake();
      drainBackground();
    }
  }
  let lastState = JSON.stringify(stateOf(profile));
  function drainBackground() {
    const backgroundProfile = profileFor(inputs(false, ""));
    while (backgroundQueue.length && !backgroundProfile.pauseBackground && backgroundRunning < backgroundProfile.backgroundJobs) {
      backgroundRunning++; backgroundQueue.shift()!();
    }
  }
  return {
    get profile(): Profile { return profile; },
    get playbackBusy(): boolean { return busy; },
    get state(): ResourceState { return stateOf(profile); },
    cores,
    setThermal(state: ThermalState) { raw.thermal = state; recompute(); },
    setPower(power: { onBattery?: boolean; lowPower?: boolean; batteryPercent?: number }) {
      if (power.onBattery !== undefined) raw.onBattery = power.onBattery;
      if (power.lowPower !== undefined) raw.lowPower = power.lowPower;
      if (power.batteryPercent !== undefined) raw.batteryPercent = power.batteryPercent;
      recompute();
    },
    setForeground(value: boolean) { raw.foreground = value; recompute(); },
    beginTask(id: string, awaiting = true, priority = 0): () => void {
      tasks.set(id, { awaiting, fullSpeed: false, priority }); recompute();
      return () => { tasks.delete(id); recompute(); };
    },
    fullSpeedForTask(id: string): boolean {
      const task = tasks.get(id);
      if (!task) return false;
      task.fullSpeed = true; recompute(); return true;
    },
    isFullSpeedTask(id: string): boolean { return tasks.get(id)?.fullSpeed === true; },
    /** The person is playing or dragging: drop to the lowest profile, resume a few seconds after. */
    setBusy(value: boolean) {
      if (busyTimer) { cancel(busyTimer); busyTimer = undefined; }
      if (value) { busy = true; busyUntil = Infinity; recompute(); return; }
      busyUntil = now() + GOVERNOR.busyResumeMs;
      busyTimer = later(() => { busyTimer = undefined; busy = false; recompute(); }, GOVERNOR.busyResumeMs);
      (busyTimer as { unref?: () => void }).unref?.();
    },
    get busyUntil() { return busyUntil; },
    onChange(listener: (profile: Profile, state: ResourceState) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    threads(requested: number, personStarted = false, taskId?: string): number {
      return threadsFor(requested, profileFor({ ...raw, busy, awaiting: personStarted, fullSpeed: taskId ? tasks.get(taskId)?.fullSpeed === true : false }), cores, personStarted);
    },
    /** Critical heat holds every task, cancelably, until the cooling event. */
    async whenRunnable(options: { personStarted?: boolean; signal?: AbortSignal } = {}): Promise<void> {
      while (profile.pauseBackground || busy && !options.personStarted) {
        options.signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const done = () => { waiters.delete(wake); options.signal?.removeEventListener("abort", onAbort); };
          const wake = () => { done(); resolve(); };
          const onAbort = () => { done(); reject(options.signal!.reason); };
          waiters.add(wake); options.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
    /** Between clips: a short rest when serious, critical or the person is busy. */
    async betweenClips(signal?: AbortSignal): Promise<void> {
      await this.whenRunnable({ signal });
      if (!profile.pauseBetweenClips) return;
      await new Promise<void>((resolve, reject) => {
        const timer = later(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, GOVERNOR.seriousClipPauseMs);
        (timer as { unref?: () => void }).unref?.();
        const onAbort = () => { cancel(timer); reject(signal!.reason); };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    /** Background jobs start only with enough free memory; they retry later. */
    async whenMemoryAllows(signal?: AbortSignal): Promise<void> {
      while (freeShare() < GOVERNOR.minFreeMemory) {
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const timer = later(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, GOVERNOR.memoryRetryMs);
          (timer as { unref?: () => void }).unref?.();
          const onAbort = () => { cancel(timer); reject(signal!.reason); };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
    /** How many background jobs the profile admits at once. Resolves with a release function. */
    async admitBackground(signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted();
      await this.whenMemoryAllows(signal);
      await new Promise<void>((resolve, reject) => {
        const start = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => { const i = backgroundQueue.indexOf(start); if (i >= 0) backgroundQueue.splice(i, 1); reject(signal!.reason); };
        backgroundQueue.push(start); signal?.addEventListener("abort", onAbort, { once: true });
        drainBackground();
      });
      let released = false;
      return () => { if (released) return; released = true; backgroundRunning--; drainBackground(); };
    },
    /** Never more than one decode-heavy job at a time. Resolves with a release function. */
    async acquireDecode(signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted();
      if (decodeHolder) await new Promise<void>((resolve, reject) => {
        const start = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => { const i = decodeQueue.indexOf(start); if (i >= 0) decodeQueue.splice(i, 1); reject(signal!.reason); };
        decodeQueue.push(start); signal?.addEventListener("abort", onAbort, { once: true });
      }); else decodeHolder = 1;
      let released = false;
      return () => { if (released) return; released = true; const next = decodeQueue.shift(); if (next) next(); else decodeHolder = 0; };
    },
    get decodeBusy(): boolean { return decodeHolder > 0; },
  };
}

export type Governor = ReturnType<typeof createGovernor>;
export const governor: Governor = createGovernor();
