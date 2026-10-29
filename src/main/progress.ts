// Six truthful stages over the existing pipeline and its saved checkpoints.
import { markMissing } from "./missing-status";
import { SORTING_FOOTAGE } from "./library-upgrade";
import { overallProcessing } from "./processing-clock";
import { cutSummaries } from "./cut-summaries";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Activity, Autopilot, Cut, ProcessingFinding, ProcessingStage, ProcessingStageId, Shoot, ShootProgress, SidekickMessage, WaitingRoomState } from "../shared/schema";
import { getAutopilot } from "./settings";
import { processingSnapshot, activityStages, optionalChecks, isQuietRead, statusIndex } from "./jobs";
import { listActivity } from "./activity";
import { discoveriesOf, discoveryFeed, wordsAreTheirs, type Discovery } from "./discoveries";

const labels: Record<ProcessingStageId, string> = {
  index: "Reading footage and metadata", transcribe: "Transcribing dialogue", group: "Grouping takes",
  judge: "Checking performances", ideas: "Generating video ideas", drafts: "Assembling draft edits",
};
const ids = Object.keys(labels) as ProcessingStageId[];
const timecode = (t: number) => `${Math.floor(t / 60).toString().padStart(2, "0")}:${Math.floor(t % 60).toString().padStart(2, "0")}`;
const factId = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 20);

// Facts with the key that names what they are about, so a discovery saying the same
// thing (the takes of a line, a stumble at one moment) is shown once.
type Fact = ProcessingFinding & { key: string; rank: number };
const clipsOf = (first: string | undefined, rest: string[]) => [...new Set([...(first ? [first] : []), ...rest])].slice(0, 6);
function factsOf(shoot: Shoot | null): Fact[] {
  if (!shoot) return [];
  const findings: Fact[] = [];
  const add = (key: unknown[], rank: number, text: string, clipIds: string[], clipId?: string, t?: number) => findings.push({ id: factId(...key), text,
    ...(clipId === undefined ? {} : { clipId }), ...(t === undefined ? {} : { t }), clipIds: clipsOf(clipId, clipIds),
    key: key[0] === "takes" ? `takes:${key[1]}` : key[0] === "stumble" ? `stumble:${key[1]}:${key[2]}` : `fact:${factId(...key)}`, rank });
  for (const take of [...(shoot.takes ?? [])].sort((a, b) => a.lineIndex - b.lineIndex)) {
    const attempts = take.attempts;
    const takeClips = attempts.map(a => a.clipId);
    if (attempts.length) add(["takes", take.lineIndex], 1,
      take.lineIndex === 0 ? `Found ${attempts.length} ${attempts.length === 1 ? "take" : "takes"} of your opening line`
        : `Found ${attempts.length} ${attempts.length === 1 ? "take" : "takes"} of line ${take.lineIndex + 1}`, takeClips, attempts[0].clipId, attempts[0].s);
    const practice = attempts.filter(a => a.practice);
    if (practice.length) add(["practice", take.lineIndex], 3, `Found ${practice.length} practice ${practice.length === 1 ? "take" : "takes"} for line ${take.lineIndex + 1}`,
      practice.map(a => a.clipId));
    // Practice is an explicit pipeline flag. A subjective note or a quality
    // measurement alone is not proof that no clean delivery exists.
    if (attempts.length && attempts.every(a => a.practice)) add(["no-clean", take.lineIndex], 4, `No clean take for line ${take.lineIndex + 1}`, takeClips);
    for (const a of [...attempts].sort((a, b) => a.clipId.localeCompare(b.clipId) || a.s - b.s)) {
      if (/\b(stumbles?|stumbled|stumbling)\b/i.test(a.note) && !/\b(no|not|without|never|didn't|doesn't)\s+(?:\w+\s+)?stumbl/i.test(a.note)
        && wordsAreTheirs(shoot.clips?.find(c => c.id === a.clipId)) !== false) {
        add(["stumble", a.clipId, a.s], 5, `Detected a stumble at ${timecode(a.s)}`, takeClips, a.clipId, a.s);
      }
    }
  }
  // WR4: an um is only worth telling once the judge has heard the words as the person's.
  for (const clip of [...(shoot.clips ?? [])].sort((a, b) => a.id.localeCompare(b.id)).filter(c => wordsAreTheirs(c) === true)) {
    for (const f of [...(clip.fillers ?? [])].sort((a, b) => a.s - b.s)) {
      if (f.kind !== "pause") add(["filler", clip.id, f.kind, f.s], 8, `Detected a filler at ${timecode(f.s)}`, [], clip.id, f.s);
    }
  }
  // Stable order and IDs across refreshes; don't evict the opening findings as
  // later analysis arrives. All wording above is derived from explicit facts.
  return [...new Map(findings.map(f => [f.id, f])).values()];
}
const plain = ({ key: _key, rank: _rank, ...finding }: Fact): ProcessingFinding => finding;
export function processingFindings(shoot: Shoot | null): ProcessingFinding[] {
  return factsOf(shoot).slice(0, 12).map(plain);
}
// WR: one list for the waiting room. Facts and discoveries about the same thing are told
// once; the order is what a person would care about first, with fillers last, so the cap
// drops the least telling. Same shoot data, same list, same ids.
// WR4: what the judge noticed, with its detail line, after the code facts (see the return). When
// there are notices, counts of shot types say less than they do and are left out.
const discoveryRank: Record<Discovery["kind"], number> = { rotation: 0, mic: 0, takes: 1, best: 2, stumble: 5, screen: 6, broll: 7 };
const saysLess = new Set<Discovery["kind"]>(["broll", "screen"]);
export function noticeFindings(shoot: Shoot | null): ProcessingFinding[] {
  const seen = new Set<string>();
  return (shoot?.noticed ?? []).flatMap(n => {
    const text = typeof n?.text === "string" ? n.text.trim() : "";
    const id = `notice:${factId("notice", text)}`;
    if (!text || seen.has(id)) return [];
    seen.add(id);
    const clipIds = [...new Set((Array.isArray(n.clipIds) ? n.clipIds : []).filter(c => typeof c === "string"))].slice(0, 6);
    return [{ id, text, detail: typeof n.detail === "string" && n.detail.trim() ? n.detail.trim() : null, clipIds, ...(clipIds[0] ? { clipId: clipIds[0] } : {}) }];
  }).slice(0, 4);
}
export function mergedFindings(shoot: Shoot | null): ProcessingFinding[] {
  const notices = noticeFindings(shoot);
  const facts = factsOf(shoot);
  const known = new Set(facts.map(f => f.key));
  const extra: Fact[] = discoveriesOf(shoot).filter(d => !known.has(d.id) && !(notices.length && saysLess.has(d.kind))).map(d => ({ id: d.id, text: d.text,
    ...(d.clipId === undefined ? {} : { clipId: d.clipId }), ...(d.t === undefined ? {} : { t: d.t }),
    clipIds: d.clipIds ?? (d.clipId ? [d.clipId] : []), key: d.id, rank: discoveryRank[d.kind] }));
  const ranked = [...facts, ...extra].map((f, i) => ({ f, i })).sort((a, b) => a.f.rank - b.f.rank || a.i - b.i).map(({ f }) => plain(f));
  // The room opens on the newest (last) finding, so the judge's notices go last, strongest last:
  // a person sees what matters first and steps back through the rest.
  return [...ranked.slice(0, Math.max(0, 12 - notices.length)), ...notices.slice(0, 12).reverse()];
}

export function deriveProgress(root: string, shoot: Shoot | null, thread: SidekickMessage[], cuts: Cut[],
  checkpoints: Partial<Record<ProcessingStageId, ProcessingStage>> = {}, activities: Activity[] = [],
  failedGeneration: "ideas" | "drafts" = "ideas", lastCallId?: string): ShootProgress {
  const clips = (shoot?.clips ?? []).filter(c => !c.missing);
  const usable = clips.filter(c => c.stage !== "error");
  const ideas = thread.flatMap(m => m.ideas ?? []);
  const done: Record<ProcessingStageId, boolean> = {
    index: clips.length > 0 && usable.length > 0 && usable.every(c => !!c.meta && c.frames?.length > 0 && !!c.proxy),
    transcribe: usable.length > 0 && usable.every(c => c.transcript != null),
    group: !!shoot && (shoot.takes?.length > 0 || usable.length > 0 && usable.every(c => !!c.judgement) && shoot.scriptSource !== "none"),
    judge: usable.length > 0 && usable.every(c => !!c.judgement),
    ideas: ideas.length > 0,
    drafts: cuts.some(c => c.versions?.length > 0),
  };
  const observed = Object.fromEntries(activityStages(root, checkpoints, activities, shoot).map(s => [s.id, s]));
  const stages = ids.map((id): ProcessingStage => {
    const checkpoint = observed[id];
    // FIX3: footage every clip of which is read is not a failed read, whatever stopped the run around it
    // (older shoots saved a model failure against "Reading footage"). Clips that couldn't be read still fail below.
    const readAnyway = checkpoint?.state === "failed" && done[id] && (id === "index" || id === "transcribe");
    const state = !readAnyway && (checkpoint?.state === "running" || checkpoint?.state === "failed" || checkpoint?.state === "skipped")
      ? checkpoint!.state : done[id] || checkpoint?.state === "done" ? "done" : "queued";
    const total = clips.length;
    const completed = id === "index" ? clips.filter(c => c.meta && c.frames?.length > 0 && c.proxy).length
      : id === "transcribe" ? clips.filter(c => c.transcript != null).length
      : id === "judge" ? clips.filter(c => c.judgement).length : null;
    return { id, label: labels[id], state,
      detail: (readAnyway ? null : checkpoint?.detail) ?? (completed !== null && total ? `${completed} of ${total} clips` : null),
      pct: state === "running" ? checkpoint?.pct ?? (id !== "judge" && completed !== null && total ? completed / total * 100 : null)
        : state === "done" ? 100 : null };
  });
  const lastReply = [...thread].reverse().find(m => m.role === "sidekick");
  // Only the reply to the last ideas or edit call can fail a stage. A failed Make it better proposal
  // (its reply is not the last call) is answered in Ask and made no edit.
  // FIX3: one failure, one line. A reply whose failure a stage already tells (a failed edit's drafts) fails nothing else.
  if (lastReply?.error && (!lastCallId || lastReply.id === lastCallId) && !stages.some(s => s.state === "failed" && s.detail === lastReply.error)) {
    const stage = stages.find(s => s.id === (lastReply.cut ? "drafts" : failedGeneration))!;
    if (stage.state !== "running") { stage.state = "failed"; stage.detail = lastReply.error; stage.pct = null; }
  }
  const error = clips.find(c => c.stage === "error");
  if (error && !stages.some(s => s.state === "running")) {
    const stage = stages.find(s => s.id === (!error.meta ? "index" : error.transcript == null ? "transcribe" : "judge"))!;
    stage.state = "failed"; stage.detail = error.error ?? "Could not process this clip. Check the source file and retry."; stage.pct = null;
  }
  return { root, running: stages.some(s => s.state === "running"), stages, findings: mergedFindings(shoot).filter(f => !(f.clipIds?.length || f.clipId) || (f.clipIds ?? [f.clipId!]).some(id => clips.some(c => c.id === id))) };
}

// WR: what the waiting room shows, from the same saved data and the overall clock.
type Overall = ReturnType<typeof overallProcessing>;
export function waitingRoom(shoot: Shoot | null, thread: SidekickMessage[], progress: ShootProgress,
  overall: Overall, activities: Activity[] = [], autopilot: Pick<Autopilot, "stopAt" | "cutCount"> = { stopAt: [], cutCount: 3 }): WaitingRoomState {
  const usable = (shoot?.clips ?? []).filter(c => c.stage !== "error");
  // Read = its stills and its transcript are saved. A clip that could not be read is not counted either way.
  const read = usable.filter(c => c.frames?.length > 0 && c.transcript != null).length;
  const stage = (id: ProcessingStageId) => progress.stages.find(s => s.id === id)?.state;
  const complete = overall ? overall.complete : !progress.running && progress.stages.every(s => s.state === "done" || s.state === "skipped");
  const ideas = thread.flatMap(m => m.ideas ?? []);
  let editsMaking = 0;
  // Only while work is actually going: after a restart mid-run nothing is making them.
  const live = !complete && (progress.running || !!overall && !overall.failed);
  if (live && stage("drafts") !== "failed" && stage("drafts") !== "skipped") {
    // The ideas autopilot drafts on its own: the model's picks, not passed, not made for a request.
    const picks = ideas.filter(i => i.pick && !i.passed && !i.requestId);
    const cutting = new Set(activities.filter(a => a.state === "running" && a.kind === "cut" && a.target?.cutId).map(a => a.target!.cutId!));
    const recutting = picks.filter(i => i.cutId && cutting.has(i.cutId)).length;
    const paused = autopilot.stopAt.some(step => step === "ideas" || step === "clips" || step === "folder");
    const waiting = paused ? 0 : Math.min(picks.filter(i => !i.cutId).length, Math.max(0, autopilot.cutCount));
    editsMaking = recutting + waiting;
  }
  return { clips: { read, total: usable.length }, etaS: overall?.etaS ?? null, ideasReady: ideas.length,
    ideasDone: stage("ideas") === "done", editsMaking, complete };
}

async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
export async function shootProgress(root: string): Promise<ShootProgress> {
  root = path.resolve(root);
  const base = path.join(root, ".sidething");
  const [shoot, thread, summaries, checkpoints, activities, lastCall] = await Promise.all([
    statusIndex(root),
    json<SidekickMessage[]>(path.join(base, "sidekick/thread.json"), []),
    cutSummaries(root),
    processingSnapshot(root), listActivity(),
    json<{ step: string; messageId?: string } | null>(path.join(base, "sidekick/last-call.json"), null),
  ]);
  // Progress only needs whether each edit has versions; full edit files are large and this is polled.
  const cuts = summaries.map(c => ({ cutId: c.cutId, versions: Array.from({ length: c.versionCount }) }) as unknown as Cut);
  const located = shoot ? markMissing({ ...shoot, root }) : null;
  const progress = deriveProgress(root, located, thread, cuts, checkpoints, activities, lastCall?.step === "precut" ? "drafts" : "ideas", lastCall?.messageId);
  const overall = overallProcessing(root);
  // PF1: verified discoveries, one at a time. Quiet unless work is actually running.
  const live = progress.running || !!overall && !overall.complete && !overall.failed;
  const { toast, told } = discoveryFeed(root).poll(discoveriesOf(located), live);
  const autopilot = await getAutopilot(root).catch(() => undefined);
  progress.waiting = waitingRoom(located, thread, progress, overall, activities.filter(a => a.root === root), autopilot);
  const sorting = activities.find(a => a.root === root && a.label === SORTING_FOOTAGE && a.state === "running");
  // A shoot with ideas or edits sorts new footage in the background; only a new shoot waits for it.
  const established = cuts.some(c => (c.versions?.length ?? 0) > 0) || thread.some(m => (m.ideas?.length ?? 0) > 0);
  if (sorting && !established) { progress.running = true; progress.waiting = { ...progress.waiting!, complete: false, etaS: sorting.etaS }; progress.stages = [...progress.stages.filter(s => s.id !== "group"), { id: "group", label: SORTING_FOOTAGE, state: "running", pct: sorting.pct, detail: SORTING_FOOTAGE }]; }
  // A quiet read (new or changed files in a shoot with ideas or edits) is told here and in the status line only.
  const reading = activities.find(a => a.root === root && a.state === "running" && isQuietRead(a));
  if (reading) progress.reading = { label: reading.label, pct: reading.pct ?? null, note: reading.note ?? null };
  const sound = activities.find(a => a.root === root && a.state === "running" && (a.label === "Separating music" || a.label === "Cleaning sound"));
  if (sound) {
    // Background sound is visible without sending a ready shoot back to wait.
    progress.waiting = { ...progress.waiting!,
      sound: { label: sound.label === "Separating music" ? "Separating music" : "Cleaning sound", etaS: sound.etaS } };
  }
  return Object.assign(progress, { discoveries: told, toast, optional: optionalChecks(root) }, overall ? { overall: { ...overall, ideaCount: thread.reduce((n, m) => n + (m.ideas?.length ?? 0), 0), editCount: cuts.length } } : {});
}
