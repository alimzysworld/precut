// Disk-derived workflow state. Autopilot can extend this one reducer later.
import { BrowserWindow } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Clip, Shoot, ShootSteps, SidekickMessage, Stage, StepId } from "../shared/schema";
import { mergeLeftOutSync } from "./left-out-state";
import { displayedClip } from "../shared/media";

// Project the person's tags without replacing the measured or judged data on disk.
export function effectiveClip(clip: Clip): Clip {
  clip = displayedClip(clip);
  const { byHand } = clip;
  if (!byHand) return clip;
  const judgement = byHand.kind === undefined ? clip.judgement : {
    ...(clip.judgement ?? { verdict: "maybe" as const, shot: "unknown" as const, summary: "Tagged by you", usableSpans: [], model: "" }),
    kind: byHand.kind,
    // A hand-tagged non-b-roll clip must not re-enter the b-roll catalog via
    // the old "maybe, summary says b-roll" fallback. Keep raw spans on disk.
    ...(byHand.kind !== "broll" && clip.judgement?.verdict === "maybe" && /b-?roll/i.test(clip.judgement.summary)
      ? { usableSpans: [] } : {}),
  };
  const shake = byHand.shaky === undefined ? clip.shake : {
    ...(clip.shake ?? { meanPx: null, p95Px: null, perSecond: [] }), measured: true,
    shakySpans: byHand.shaky ? [[0, clip.meta?.durationS ?? 0] as [number, number]] : [],
  };
  return { ...clip, judgement, shake };
}
export function effectiveShoot(shoot: Shoot): Shoot {
  return { ...shoot, clips: mergeLeftOutSync(shoot).clips.map(effectiveClip) };
}

const progress = new Map<string, { judging: boolean; stages: Map<string, Stage>; note?: string }>();
const stopped = new Map<string, Partial<Record<StepId, string>>>();
export function stopStep(root: string, step: StepId, error: unknown): void {
  const key = path.resolve(root);
  const message = error instanceof Error ? error.message : "Could not finish this step. Try again.";
  stopped.set(key, { ...stopped.get(key), [step]: message });
  stepsChanged(key);
}
export function trackProgress(e: { root: string; clipId: string; stage: Stage; pct: number; note?: string }): void {
  const root = path.resolve(e.root);
  const state = progress.get(root) ?? { judging: false, stages: new Map<string, Stage>(), note: undefined };
  if (e.note !== undefined) state.note = e.note;
  if (e.clipId === "" && e.stage === "done") delete state.note;
  state.stages.set(e.clipId, e.stage);
  if (e.stage === "judge") state.judging = true;
  if (e.stage === "done" && ![...state.stages.values()].includes("judge")) state.judging = false;
  progress.set(root, state);
  stopped.delete(root);
  stepsChanged(root);
}

// Leading plus trailing notification: no more than one per second per shoot,
// while still delivering the final change in a burst.
const notifications = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout> }>();
let resumeRequests: (root: string) => void = () => {};
export function setRequestWake(fn: (root: string) => void): void { resumeRequests = fn; }
export function stepsChanged(root: string, urgent = false): void {
  root = path.resolve(root);
  resumeRequests(root);
  const state = notifications.get(root) ?? { at: 0 };
  notifications.set(root, state);
  const send = () => {
    if (state.timer) clearTimeout(state.timer);
    state.at = Date.now();
    state.timer = undefined;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        try { win.webContents.send("api:steps-changed", root); } catch { /* window closed */ }
      }
    }
  };
  // A failure never waits behind the once-a-second throttle.
  if (urgent) { send(); return; }
  if (state.timer) return;
  const remaining = 1000 - (Date.now() - state.at);
  if (remaining <= 0) send();
  else { state.timer = setTimeout(send, remaining); state.timer.unref(); }
}

async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
export async function shootSteps(root: string): Promise<ShootSteps> {
  root = path.resolve(root);
  const base = path.join(root, ".sidething");
  const [shoot, thread, entries, lastCall] = await Promise.all([
    import("./jobs").then(jobs => jobs.statusIndex(root)),
    json<SidekickMessage[]>(path.join(base, "sidekick/thread.json"), []),
    fs.readdir(path.join(base, "sidekick/cuts")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    }),
    json<{ messageId: string; step: "ideas" | "precut" } | null>(path.join(base, "sidekick/last-call.json"), null),
  ]);
  const cuts = entries.some((name) => name.endsWith(".json")) || thread.some((m) => m.cut);
  // Instant precuts are exported folders rather than sidekick cut records.
  const precuts = cuts || (await fs.readdir(path.join(root, "sidething precuts")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  })).length > 0;
  const latestIdeas = thread.flatMap(m => m.ideas ?? []);
  const clips = shoot?.clips ?? [];
  const state = progress.get(root);
  const tagged = clips.filter((c) => ["done", "error"].includes(c.stage)).length;
  const steps: ShootSteps = {
    folder: { status: "done" },
    clips: !shoot ? { status: "todo" } : state?.note ? { status: "working", note: state.note }
      : state?.judging || clips.some((c) => c.stage === "judge")
      ? { status: "working", note: "judging" } : tagged < clips.length
      ? { status: "working", note: `tagging ${tagged} of ${clips.length}` }
      : { status: "done" },
    // ONB2/REL1: an edit made by hand is not ideas done. Ideas tick only when there are ideas.
    ideas: latestIdeas.length && (precuts || latestIdeas.some((i) => i.cutId)) ? { status: "done" }
      : latestIdeas?.length ? { status: "waiting", note: "pick what to cut" } : { status: "todo" },
    precut: { status: precuts ? "done" : "todo" },
  };
  for (const [step, note] of Object.entries(stopped.get(root) ?? {})) {
    steps[step as StepId] = { status: "stopped", note };
  }
  const lastReply = [...thread].reverse().find((m) => m.role === "sidekick");
  if (lastReply?.error) {
    const step = lastCall?.messageId === lastReply.id ? lastCall.step : "ideas";
    steps[step] = { status: "stopped", note: lastReply.error };
  }
  return steps;
}
