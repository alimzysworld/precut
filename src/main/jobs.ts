import { retainOpenShoot, shootHasOtherWriter, withShootWriter } from "./writer-lock";
import { clipName } from "../shared/clip-name";
import { mkdirInShootSync } from "./shoot-dir";
import { scheduleScreenRead } from './screen-recordings';
// Job runner: queues shoots, runs pipeline/setup.py then pipeline/process.py
// (venv python, -I), one shoot at a time, forwards progress to the renderer.
import { cutSummaries } from "./cut-summaries";
import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkoutFile } from "./bundle-paths";
import { createHash, randomUUID } from "node:crypto";
import type { Clip, Shoot, Stage, ShootSummary, ProcessingStage, ProcessingStageId, OptionalCheck, OptionalCheckId } from "../shared/schema";
import { judgeShoot } from "./judge";
import { keepBundleSealed, supportDir, tool, toolEnvironment } from "./tools";
import { getPreferences } from "./settings";
import * as appSettings from "./settings";
import { STAGE_NEEDS_AI } from "../shared/stage-words";
import { engineProblemOf } from "../shared/engine-problem";
import { begin, runActivity, listActivity, cancelActivity } from "./activity";
import { governor } from "./resource-governor";
import { makeOriginalPosters } from "./thumbnails";
import { startProcessingClock, updateProcessingClock, overallProcessing, finishProcessingClock, markProcessingStage, clearProcessingClock, configureProcessingWork, updateProcessingClip, pauseProcessingPhase, resumeProcessingPhase, processingStartedAt } from "./processing-clock";
import { withScenes } from "./scenes";
import { lanePolicy, runStreaming } from "./streaming";
import { assignClipIds, discoverMedia, isPhoto } from "./media-scan";
import { displayedClip } from "../shared/media";
import { setRethinkScheduler } from "./left-out";
import { setModelPaceDirectory } from "./model-pace";
import { mergeLeftOut } from "./left-out-state";
import { shootFilesChanged, folderChanges } from "./shoot-files";
import { prepareFolderImport, restoreFolderSplit } from "./folder-shape";
import { scheduleLibraryUpgrade, libraryUpgradePending } from "./library-upgrade";
import { withoutMissingErrors } from "./missing-status";

setModelPaceDirectory(() => app.getPath("userData"));
setRethinkScheduler(enqueueRethink);

export interface ProgressEvent {
  root: string;
  clipId: string;
  stage: Stage;
  pct: number;
  note?: string;
}

type ProgressForwarder = (e: ProgressEvent) => void;
let forwarder: ProgressForwarder = () => {};
export function setProgressForwarder(fn: ProgressForwarder): void {
  forwarder = fn;
}


function venvDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "precut", "venv");
}
export function venvPython(): string {
  keepBundleSealed();
  return path.join(venvDir(), "bin", "python");
}

export function pipelineFile(name: string): string {
  const candidates = [
    path.join(app.getAppPath(), "pipeline", name),
    checkoutFile(path.join("pipeline", name)),
    path.join(process.cwd(), "pipeline", name),
  ];
  if (process.resourcesPath) {
    candidates.splice(1, 0, path.join(process.resourcesPath, "pipeline", name));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function shootsStorePath(): string {
  return path.join(app.getPath("userData"), "shoots.json");
}

interface StoredShoot {
  root: string;
  name: string;
  footage?: { id: string; file: string; size: number }[];
}

function readStore(): StoredShoot[] {
  try {
    const raw = fs.readFileSync(shootsStorePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is StoredShoot =>
        typeof e === "object" && e !== null &&
        typeof (e as StoredShoot).root === "string" &&
        typeof (e as StoredShoot).name === "string",
    );
  } catch {
    return [];
  }
}

function writeStore(entries: StoredShoot[]): void {
  fs.mkdirSync(path.dirname(shootsStorePath()), { recursive: true });
  fs.writeFileSync(shootsStorePath(), JSON.stringify(entries, null, 1));
}

function rememberShoot(root: string): void {
  const entries = readStore();
  if (!entries.some((e) => e.root === root)) {
    entries.push({ root, name: path.basename(root) });
    writeStore(entries);
  }
}

// D1: only the library registry changes. Processing and every shoot file stay intact.
export async function forgetShoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  writeStore(readStore().filter(entry => path.resolve(entry.root) !== resolved));
  libraryTotals.delete(resolved);
  // This is a library change, not a processing checkpoint. The checkpoint
  // forwarder can resume queued requests, so notify the renderer directly.
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try { window.webContents.send("api:steps-changed", resolved); } catch { /* window closed */ }
    }
  }
}

// Additive D1 summary fields until Claude folds them into the shared contract.
// Duration counts video once; bytes cover the indexed original video and audio.
type LibraryTotals = { durationS: number | null; sizeBytes: number | null };
const libraryTotals = new Map<string, { key: string; at: number; value: Promise<LibraryTotals> }>();
async function shootTotals(root: string, shoot: Shoot): Promise<LibraryTotals> {
  const key = JSON.stringify([shoot.updatedAt, shoot.clips.map(c => [c.file, c.meta?.durationS]), (shoot.audio ?? []).map(a => a.file)]);
  const cached = libraryTotals.get(root);
  if (cached?.key === key && Date.now() - cached.at < 60_000) return cached.value;
  const value = (async () => {
    const known = shoot.clips.every(c => c.meta && Number.isFinite(c.meta.durationS) && c.meta.durationS >= 0);
    const files = [...new Set([...shoot.clips.map(c => c.file), ...(shoot.audio ?? []).map(a => a.file)])];
    const sizes = await Promise.all(files.map(async file => {
      try { const stat = await fs.promises.stat(path.resolve(root, file)); return stat.isFile() ? stat.size : null; }
      catch { return null; }
    }));
    return { durationS: known ? shoot.clips.reduce((n, c) => n + c.meta!.durationS, 0) : null,
      sizeBytes: sizes.every((n): n is number => n !== null) ? sizes.reduce((n, size) => n + size, 0) : null };
  })();
  libraryTotals.set(root, { key, at: Date.now(), value });
  return value;
}

async function stubShoot(root: string, existing: { id: string; file: string; photo?: { file: string } }[] = []): Promise<Shoot> {
  const preferences = await getPreferences();
  const files = discoverMedia(root, preferences.output?.exportFolder).clips;
  const ids = assignClipIds(files, existing);
  const clips: Shoot["clips"] = files.map(file => ({
    id: ids.get(file)!, file, stage: "probe", meta: null, transcript: null,
    shake: null, frames: [], proxy: null, judgement: null,
    ...(isPhoto(file) ? { photo: { file, takenAt: null } } : {}),
  }));
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    name: path.basename(root),
    root,
    createdAt: now,
    updatedAt: now,
    script: [],
    scriptSource: "none",
    clips,
    audio: [],
    takes: [],
  };
}

const openedShoots = new Set<string>();
const lastFileCheck = new Map<string, number>(), lastSourceCheck = new Map<string, number>();
export async function refreshOpenedShoots(): Promise<void> {
  for (const root of openedShoots) { lastFileCheck.delete(root); await loadShoot(root); }
}
export async function loadShoot(root: string): Promise<Shoot | null> {
  const resolved = path.resolve(root);
  const indexPath = path.join(resolved, ".sidething", "index.json");
  try {
    const raw = await fs.promises.readFile(indexPath, "utf8");
    await retainOpenShoot(resolved);
    const shoot = await mergeLeftOut({ ...JSON.parse(raw), root: resolved } as Shoot);
    if (await shootHasOtherWriter(resolved)) return withScenes(shoot);
    openedShoots.add(resolved);
    const changes = folderChanges(resolved, shoot, (await getPreferences()).output?.exportFolder);
    const pictureSourcesChanged = changes.changedFiles.length > 0;
    if (!isShootProcessing(resolved) && Date.now() - (lastFileCheck.get(resolved) ?? 0) > 3000) {
      lastFileCheck.set(resolved, Date.now());
      const failedRethink = processing.get(resolved)?.judge?.state === "failed" || processing.get(resolved)?.ideas?.state === "failed";
      if (!failedRethink && fs.existsSync(path.join(resolved, ".sidething/rethink.json"))) enqueueRethink(resolved);
    }
    // A swapped source an edit uses is read again without waiting for Add, ahead of anything new.
    // Its old preview is never remade from the old read first (it would carry the old metadata).
    const { changedSources } = await import("./source-changes");
    let sourcesChanged = false;
    // Receipt checks are synchronous filesystem reads. A large background
    // refresh must leave time for the editor's input and undo acknowledgements.
    for (let i = 0; i < shoot.clips.length && !sourcesChanged; i += 16) {
      await new Promise<void>(resolve => setImmediate(resolve));
      sourcesChanged = changedSources(resolved, { ...shoot, clips: shoot.clips.slice(i, i + 16) }).length > 0;
    }
    if (sourcesChanged && !isShootProcessing(resolved) && Date.now() - (lastSourceCheck.get(resolved) ?? 0) > 3000) {
      lastSourceCheck.set(resolved, Date.now());
      void queueChangedSources(resolved, shoot).catch(error => console.error(`[jobs] could not queue changed clips for ${resolved}:`, error));
    }
    // Opening an existing shoot returns immediately; migration is background
    // work and must not race a Python stage writing the same shoot's index.
    if (!pictureSourcesChanged && !sourcesChanged && shoot.clips.some(c => c.meta && c.stage !== "error") && !active.has(resolved) && !queue.includes(resolved)) {
      schedulePreviews(resolved);
    }
    const entries = readStore();
    const stored = entries.find(e => e.root === resolved), footage = footageOf(shoot);
    if (stored && footage && JSON.stringify(footage) !== JSON.stringify(stored.footage)) { stored.footage = footage; writeStore(entries); }
    const missing = new Set(changes.missingClipIds);
    if (!isShootProcessing(resolved)) scheduleLibraryUpgrade(shoot, { python: venvPython(), file: pipelineFile, changed: () => {
      forwarder({ root: resolved, clipId: "", stage: "done", pct: 100 });
    } });
    if (!isShootProcessing(resolved)) scheduleScreenRead({ ...shoot, clips:shoot.clips.map(c => ({...c,missing:missing.has(c.id)})) }, () => forwarder({ root:resolved, clipId:"", stage:"done", pct:100 }));
    const { previewHealth } = await import("./proxies");
    const { canVideoToolboxDecode } = await import("./video-decode");
    const clips: Clip[] = [];
    let slice = performance.now();
    for (const c of shoot.clips) {
      const display = { ...displayedClip(c), previewHealth: { ...previewHealth(resolved, c), requiresValidation: !canVideoToolboxDecode(c.meta?.codec) }, missing: missing.has(c.id) };
      clips.push(display);
      if (performance.now() - slice > 8) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now(); }
    }
    return withScenes({ ...shoot, folderChanges: changes, clips, root: resolved });
  } catch (error) {
    if (fs.existsSync(indexPath)) throw error;
    if (fs.existsSync(resolved)) return withScenes(await stubShoot(resolved));
    return null;
  }
}

// Persist real stage outcomes so a restart can distinguish failure/interruption
// from a shoot which has never been processed. Running belongs to this process.
type StageCheckpoint = ProcessingStage & { at?: string };
const processing = new Map<string, Partial<Record<ProcessingStageId, StageCheckpoint>>>();
let changed: (root: string, urgent?: boolean) => void = () => {};
let stageFailed: (root: string, id: ProcessingStageId, detail: string | null) => void = () => {};
/** Main wires this to a Mac notification; it only speaks when the window is behind. */
export function setStageFailureHandler(fn: typeof stageFailed): void { stageFailed = fn; }
export function setStepsChangedForwarder(fn: (root: string, urgent?: boolean) => void): void { changed = fn; }
export function reportStage(root: string, id: ProcessingStageId, state: ProcessingStage["state"],
  detail: string | null = null, pct: number | null = null): void {
  root = path.resolve(root);
  const stages = processing.get(root) ?? {};
  const previous = stages[id];
  stages[id] = { id, label: id, state, detail, pct, at: new Date().toISOString() };
  processing.set(root, stages);
  // Progress stays in memory; checkpoint transitions are durable and atomic.
  if (previous?.state !== state) {
    try {
      const dir = path.join(root, ".sidething");
      mkdirInShootSync(dir);  // FIX3: never recreate a renamed or moved shoot folder
      const temporary = path.join(dir, "processing.json.tmp");
      fs.writeFileSync(temporary, JSON.stringify(stages));
      fs.renameSync(temporary, path.join(dir, "processing.json"));
    } catch (error) { console.error("[jobs] Could not save processing state:", error); }
  }
  // A failed stage reaches the indicator at once (and the person, if the window is behind);
  // a retry clears it the moment it starts.
  if (state === "failed" || previous?.state === "failed" && (state === "running" || state === "done")) markProcessingStage(root, id, state);
  if (state === "failed" && previous?.state !== "failed") stageFailed(root, id, detail);
  if (id === "ideas" || id === "drafts") updateProcessingClock(root, id === "ideas" ? "Ideas" : "First edits",
    state === "done" ? id === "drafts" ? .99 : 1 : (pct ?? 0) / 100,
    state);
  changed(root, state === "failed" && previous?.state !== "failed");
}
// PF1b: framing, focus and sound checks and filler finding refine edits; they never stop
// them. A failure is kept (and saved) here with its own words, never as a stage failure.
const optionalFailures = new Map<string, Partial<Record<OptionalCheckId, OptionalCheck>>>();
const OPTIONAL_IDS: readonly OptionalCheckId[] = ["framing", "quality", "fillers"];
export function isOptionalCheck(id: string): id is OptionalCheckId { return (OPTIONAL_IDS as readonly string[]).includes(id); }
export function reportOptional(root: string, id: OptionalCheckId, detail: string | null, failed = true): void {
  root = path.resolve(root);
  const checks = { ...(optionalFailures.get(root) ?? readOptional(root)) };
  if (failed) checks[id] = { id, detail }; else if (checks[id]) delete checks[id]; else return;
  optionalFailures.set(root, checks);
  try {
    const file = path.join(root, ".sidething", "optional-checks.json");
    mkdirInShootSync(path.dirname(file));  // FIX3: never recreate a moved shoot
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(checks)); fs.renameSync(`${file}.tmp`, file);
  } catch (error) { console.error("[jobs] Could not save optional checks:", error); }
  changed(root, failed);
}
function readOptional(root: string): Partial<Record<OptionalCheckId, OptionalCheck>> {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(root, ".sidething", "optional-checks.json"), "utf8")) as Record<string, OptionalCheck>;
    return Object.fromEntries(Object.entries(saved).filter(([id, check]) => isOptionalCheck(id) && check?.id === id));
  } catch { return {}; }
}
export function optionalChecks(root: string): OptionalCheck[] {
  root = path.resolve(root);
  const checks = optionalFailures.get(root) ?? readOptional(root);
  return OPTIONAL_IDS.flatMap(id => checks[id] ? [checks[id]!] : []);
}
// Polled status readers never mutate or publish the index itself.
// Share one parsed snapshot per atomic identity, including overlapping polls.
const statusIndexes = new Map<string, { identity: string; read: Promise<Shoot> }>();
export async function statusIndex(root: string): Promise<Shoot | null> {
  const file = path.join(root, '.sidething/index.json');
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(file); }
  catch (error) { statusIndexes.delete(file); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const identity = JSON.stringify([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  const cached = statusIndexes.get(file);
  if (cached?.identity === identity) return cached.read;
  const read = fs.promises.readFile(file, 'utf8').then(raw => JSON.parse(raw) as Shoot);
  const entry = { identity, read };
  statusIndexes.set(file, entry);
  if (statusIndexes.size > 4) statusIndexes.delete(statusIndexes.keys().next().value!);
  void read.catch(() => { if (statusIndexes.get(file) === entry) statusIndexes.delete(file); });
  return read;
}
export async function processingSnapshot(root: string): Promise<Partial<Record<ProcessingStageId, StageCheckpoint>>> {
  root = path.resolve(root);
  const live = processing.get(root);
  let saved: Partial<Record<ProcessingStageId, StageCheckpoint>> = {};
  try { saved = JSON.parse(await fs.promises.readFile(path.join(root, ".sidething/processing.json"), "utf8")); }
  catch { /* no checkpoint yet */ }
  let stages = { ...saved, ...live };
  try {
    const shoot = await statusIndex(root);
    // A source can disappear after this process recorded its failure too.
    // Filter the merged view, retaining both checkpoints for a future relink.
    if (shoot) stages = withoutMissingErrors(root, shoot, stages);
  } catch { /* no index yet */ }
  const known = ["index", "transcribe", "group", "judge", "ideas", "drafts"];
  return Object.fromEntries(Object.entries(stages).filter(([id, stage]) =>
    known.includes(id) && stage && ["queued", "running", "done", "failed", "skipped"].includes(stage.state)).map(([id, stage]) => [id,
    stage.state === "running" && !live?.[id as ProcessingStageId] ? { ...stage, state: "failed", pct: null,
      detail: "Processing was interrupted. Retry this stage to continue." } : stage]));
}

// Reconcile the activity stream with durable stage outcomes. Outer pipeline
// capsules use synthetic weights, so only the stage checkpoints supply its %.
export function activityStages(root: string, checkpoints: Partial<Record<ProcessingStageId, StageCheckpoint>>,
  activities: import("../shared/schema").Activity[], shoot: Shoot | null = null): ProcessingStage[] {
  const stages: Partial<Record<ProcessingStageId, StageCheckpoint>> = { ...checkpoints };
  const latest = new Map<ProcessingStageId, import("../shared/schema").Activity>();
  for (const a of activities) {
    if (a.root !== root) continue;
    // A hand edit or background edit job (music arranging, caption styling) that fails says so in its own place.
    // It never made a draft, so it must not read as "Couldn't make your edits".
    if (a.kind === "edit" && a.state === "failed") continue;
    const id = a.kind === "ideas" ? "ideas" : a.kind === "cut" || a.kind === "edit" ? "drafts"
      : a.kind === "judge" ? "judge" : a.kind === "process" && a.label === "Making previews" ? "index" : null;
    if (id) latest.set(id, a);
  }
  for (const [id, a] of latest) {
    const checkpoint = stages[id];
    if (checkpoint?.state === "running" || checkpoint?.at && checkpoint.at >= (a.endedAt ?? a.startedAt)) continue;
    stages[id] = { id, label: id, state: a.state === "done" && (id === "ideas" || id === "drafts") ? "queued" : a.state,
      detail: a.note, pct: a.pct };
  }
  return Object.values(shoot ? withoutMissingErrors(root, shoot, stages) : stages);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.promises.readFile(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
export function shootStatus(online: boolean, stages: ProcessingStage[], ideaCount: number, cutCount: number): ShootSummary["status"] {
  if (!online) return "offline";
  if (stages.some(s => s.state === "running")) return "processing";
  if (stages.some(s => s.state === "failed")) return "failed";
  return cutCount ? "edits" : ideaCount ? "ideas" : "new";
}
function footageOf(shoot: Shoot): StoredShoot["footage"] {
  const cached = (shoot as Shoot & { _cache?: { clips?: Record<string, { size?: number }> } })._cache?.clips;
  // REL2: a photo's manifest entry names the photo, so its size is the photo's (the read receipt), not the size of the
  // short movie precut made from it (meta). Before, every shoot with photos failed to relink: "different footage".
  const footage = (shoot.clips ?? []).map(c => ({ id: c.id, file: c.photo?.file ?? c.file, size: (c.photo ? cached?.[c.id]?.size ?? c.meta?.sizeBytes : c.meta?.sizeBytes ?? cached?.[c.id]?.size) ?? -1 }));
  return footage.length && footage.every(c => Number.isSafeInteger(c.size) && c.size >= 0) ? footage : undefined;
}

const thumbnails = new Map<string, Promise<string | null>>();
async function shootThumbnail(root: string, shoot: Shoot): Promise<string | null> {
  const opening = shoot.takes?.find(t => t.lineIndex === 0);
  const attempts = (opening?.attempts ?? []).map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => !attempt.practice && shoot.clips.some(c => c.id === attempt.clipId && c.meta))
    .sort((a, b) => Number(b.index === opening?.starred) - Number(a.index === opening?.starred)
      || (a.attempt.measures?.flags.length ?? 0) - (b.attempt.measures?.flags.length ?? 0)
      || (b.attempt.measures?.faceQuality ?? -1) - (a.attempt.measures?.faceQuality ?? -1));
  const attempt = attempts[0]?.attempt;
  const clip = attempt ? shoot.clips.find(c => c.id === attempt.clipId)
    : shoot.clips.find(c => (c.byHand?.kind ?? c.judgement?.kind) === "talking") ?? shoot.clips[0];
  if (!clip) return null;
  const base = path.join(root, ".sidething");
  const at = attempt ? (attempt.s + attempt.e) / 2 : (clip.meta?.durationS ?? 0) * .4;
  const url = (name: string) => `st-media://local/${encodeURIComponent(root)}/frames/${encodeURIComponent(name)}`;
  const fallback = () => {
    // Smart frames carry their measured sample time; older caches were even.
    // Avoid the first still, which is often camera startup/black.
    const frames = (clip.frames ?? []).map((name, index) => ({ name: name.replace(/^frames\//, ""), index,
      t: Number(name.match(/_t(\d+(?:\.\d+)?)\.jpg$/)?.[1] ?? (index + .5) * (clip.meta?.durationS ?? 0) / clip.frames.length) }))
      .filter(({ name, index }) => (index > 0 || clip.frames.length === 1) && fs.existsSync(path.join(base, "frames", name)))
      .sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at));
    return frames[0] ? url(frames[0].name) : null;
  };
  if (!clip.proxy || !Number.isFinite(at) || at <= 0) return fallback();
  const proxy = path.join(base, "proxies", clip.proxy);
  let stamp: fs.Stats;
  try { stamp = await fs.promises.stat(proxy); } catch { return fallback(); }
  const key = createHash("sha256").update(JSON.stringify([root, proxy, stamp.size, stamp.mtimeMs, at])).digest("hex").slice(0, 24);
  const name = `shoot-${key}.jpg`, file = path.join(base, "frames", name);
  if (fs.existsSync(file)) return url(name);
  const pending = thumbnails.get(key);
  if (pending) return pending;
  const work = (async () => {
    const temporary = path.join(base, "frames", `shoot-${key}-${randomUUID()}.jpg`);
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(tool("ffmpeg"), ["-v", "error", "-y", "-ss", String(at), "-i", proxy,
          "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3", temporary], { stdio: "ignore" });
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Thumbnail timed out")); }, 30_000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Thumbnail decode failed")); });
      });
      if (!fs.existsSync(temporary)) return fallback();
      await fs.promises.rename(temporary, file);
      return url(name);
    } catch { return fallback(); }
    finally { thumbnails.delete(key); await fs.promises.unlink(temporary).catch(() => {}); }
  })();
  thumbnails.set(key, work);
  return work;
}

export async function listShoots(): Promise<ShootSummary[]> {
  const activities = await listActivity();
  const entries = readStore();
  let storeChanged = false;
  const summaries = await Promise.all(entries.map(async e => {
    const root = path.resolve(e.root), base = path.join(root, ".sidething");
    let online = false;
    try { online = (await fs.promises.stat(root)).isDirectory(); await fs.promises.access(root, fs.constants.R_OK); }
    catch { /* drive disconnected or inaccessible */ }
    const shoot = online ? await statusIndex(root).catch(() => null) : null;
    const thread = online ? await readJson<import("../shared/schema").SidekickMessage[]>(path.join(base, "sidekick/thread.json"), []).catch(() => []) : [];
    // Summaries cached per file change: full edit files are large and this is polled.
    const validCuts = online ? (await cutSummaries(root).catch(() => [])).filter(c => c.versionCount > 0) : [];
    const stages = activityStages(root, await processingSnapshot(root), activities, shoot);
    if (!stages.some(s => s.state === "running") && shoot?.clips.some(c => c.stage === "error" && fs.existsSync(path.join(root, c.photo?.file ?? c.file)))) {
      stages.push({ id: "index", label: "Footage", state: "failed", detail: null, pct: null });
    }
    const lastReply = [...thread].reverse().find(m => m.role === "sidekick");
    // As in progress.ts: a failed Make it better proposal (not the last ideas or edit call) fails nothing here.
    const lastCallId = lastReply?.error ? (await readJson<{ messageId?: string } | null>(path.join(base, "sidekick/last-call.json"), null).catch(() => null))?.messageId : undefined;
    if (lastReply?.error && (!lastCallId || lastCallId === lastReply.id) && !stages.some(s => s.state === "running")) {
      stages.push({ id: "ideas", label: "Generation", state: "failed", detail: lastReply.error, pct: null });
    }
    const ideaCount = thread.reduce((n, m) => n + (m.ideas?.length ?? 0), 0);
    const cutCount = validCuts.length;
    const status = shootStatus(online, stages, ideaCount, cutCount);
    const times = [shoot?.updatedAt, ...thread.map(m => m.at), ...validCuts.flatMap(c => [...c.versionTimes, ...c.exportTimes]),
    ].filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t)));
    times.sort((a, b) => Date.parse(b) - Date.parse(a));
    const thumb = shoot ? await shootThumbnail(root, shoot) : null;
    const footage = shoot && footageOf(shoot);
    if (footage && JSON.stringify(footage) !== JSON.stringify(e.footage)) { e.footage = footage; storeChanged = true; }
    // There is no defensible percentage for the whole model + media pipeline.
    // A single active measured stage can still report its own progress.
    const activeStages = stages.filter(s => s.state === "running");
    const activeStage = activeStages.length === 1 ? activeStages[0] : null;
    let measured = activeStage?.pct ?? null;
    if (measured === null && activeStage && shoot?.clips.length) {
      const complete = activeStage.id === "index" ? shoot.clips.filter(c => c.meta && c.frames?.length > 0 && c.proxy).length
        : activeStage.id === "transcribe" ? shoot.clips.filter(c => c.transcript != null).length : null;
      if (complete !== null) measured = complete / shoot.clips.length * 100;
    }
    const totals = shoot ? await shootTotals(root, shoot) : { durationS: null, sizeBytes: null };
    return { ...totals, root, name: shoot?.name ?? e.name, online, status, thumb, clipCount: shoot?.clips.length ?? 0,
      ideaCount, cutCount, lastActivityAt: times[0] ?? null, progressPct: status === "processing" ? measured : null };
  }));
  if (storeChanged) {
    // A folder may have been added/relinked while these indexes were read.
    writeStore(readStore().map(entry => ({ ...entry,
      footage: entries.find(e => e.root === entry.root)?.footage ?? entry.footage })));
  }
  return summaries;
}

export async function relinkShoot(oldRoot: string, newRoot: string): Promise<ShootSummary> {
  oldRoot = path.resolve(oldRoot); newRoot = path.resolve(newRoot);
  const entries = readStore(), entry = entries.find(e => path.resolve(e.root) === oldRoot);
  if (!entry) throw new Error("That shoot is not in your library.");
  if (active.has(oldRoot) || queue.includes(oldRoot) || lazyPreviews.has(oldRoot)
    || (await listActivity()).some(a => a.root === oldRoot && a.state === "running")) {
    throw new Error("Wait for this shoot to finish processing before relinking it.");
  }
  if (oldRoot === newRoot) {
    const summary = (await listShoots()).find(e => e.root === oldRoot)!;
    if (!summary.online) throw new Error("That folder is not reachable. Connect the drive and try again.");
    return summary;
  }
  if (entries.some(e => e !== entry && path.resolve(e.root) === newRoot)) throw new Error("That folder is already in your library.");
  const oldSide = path.join(oldRoot, ".sidething"), newSide = path.join(newRoot, ".sidething");
  const oldIndex = await readJson<Shoot | null>(path.join(oldSide, "index.json"), null);
  const newIndex = await readJson<Shoot | null>(path.join(newSide, "index.json"), null);
  // A moved folder carries its original index. Older library records may not
  // have a manifest yet, so require the index to name the original root.
  // REL2: a library record written by an older build can carry wrong photo sizes. When the moved folder's own index
  // names exactly the same clips and files, its sizes are used; every file is still checked on disk below.
  const moved = newIndex && path.resolve(newIndex.root) === oldRoot ? footageOf(newIndex) : undefined;
  const files = (items?: StoredShoot["footage"]) => JSON.stringify((items ?? []).map(i => [i.id, i.file]).sort());
  const expected = (oldIndex && footageOf(oldIndex)) ?? (moved && (!entry.footage || files(moved) === files(entry.footage)) ? moved : entry.footage) ?? moved;
  if (!expected?.length) throw new Error("Could not verify this shoot. Choose the original folder including its .sidething data.");
  const signature = (items: NonNullable<StoredShoot["footage"]>) => JSON.stringify([...items].sort((a, b) => a.file.localeCompare(b.file)));
  if (newIndex && signature(footageOf(newIndex) ?? []) !== signature(expected)) throw new Error("That folder contains different footage. Choose the folder for this shoot.");
  const actual = (await stubShoot(newRoot, expected)).clips.filter(c =>
    // Default editor handoffs are generated media, not extra camera originals.
    !c.file.startsWith(`sidething precuts${path.sep}`) || expected.some(e => e.file === c.file));
  if (actual.length !== expected.length || actual.some(c => !expected.some(e => e.id === c.id && e.file === c.file))) {
    throw new Error("That folder contains different footage. Choose the folder for this shoot.");
  }
  for (const clip of expected) {
    const file = path.resolve(newRoot, clip.file);
    if (!file.startsWith(newRoot + path.sep)) throw new Error("Could not verify the footage paths in this shoot.");
    const source = oldIndex?.clips.find(c => c.id === clip.id);
    const receipt = (oldIndex as (Shoot & { _cache?: { clips?: Record<string, { mtime: number }> } }) | null)?._cache?.clips?.[clip.id];
    if (!await (await import("./relink-media")).verifyRelinkFile(file, clip.size, receipt?.mtime, source?.photo ? undefined : source?.meta?.durationS)) {
      throw new Error("That folder contains different or missing footage. Choose the folder for this shoot.");
    }
  }
  if (!newIndex) {
    if (!oldIndex) throw new Error("This folder is missing the shoot's .sidething data. Restore it and try again.");
    if (fs.existsSync(newSide)) throw new Error("This folder already has .sidething data. Choose a folder with the original shoot data.");
    await fs.promises.cp(oldSide, newSide, { recursive: true, force: false, errorOnExist: true });
  } else if (oldIndex) {
    throw new Error("Both folders contain shoot data. Move the original folder with its .sidething data, then relink it.");
  }
  // Saved assemblies and export/finished paths can contain absolute paths.
  // Rebase path values, keeping every version, preference and analysis file.
  const rebase = (value: unknown): unknown => {
    if (typeof value === "string") return value === oldRoot || value.startsWith(oldRoot + path.sep) ? newRoot + value.slice(oldRoot.length) : value;
    if (Array.isArray(value)) return value.map(rebase);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v)]));
    return value;
  };
  const updates: { file: string; text: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.name.endsWith(".json")) {
        const original = await fs.promises.readFile(file, "utf8");
        // Cached measurements and fingerprints should retain their exact bytes.
        if (!original.includes(oldRoot) && !original.includes(JSON.stringify(oldRoot).slice(1, -1))) continue;
        const data: unknown = JSON.parse(original);
        const rebased = rebase(data);
        // REL2: keep the file's own layout. An ARCH2 edit head must start with {"versionLog": to be read as a log;
        // written pretty, every version of a relinked edit read as a light entry ("Could not find ... saved assembly").
        if (JSON.stringify(rebased) !== JSON.stringify(data)) updates.push({ file, text: (original.startsWith("{\n") ? JSON.stringify(rebased, null, 2) : JSON.stringify(rebased)) + "\n" });
      }
    }
  };
  await walk(newSide);
  for (const { file, text } of updates) {
    const temporary = `${file}.relink.tmp`;
    try { await fs.promises.writeFile(temporary, text); await fs.promises.rename(temporary, file); }
    finally { await fs.promises.rm(temporary, { force: true }); }
  }
  // REL2: edit history lines (ARCH2 logs) are never rewritten, so the roots this shoot lived at are kept; readers
  // resolve a saved path under any of them against the new root. Written after the rebase above, which must not touch it.
  {
    const file = path.join(newSide, "previous-roots.json"), temporary = `${file}.relink.tmp`;
    const known = await readJson<{ roots?: string[] }>(file, {});
    const roots = [...new Set([...(known.roots ?? []), oldRoot])].filter(r => r !== newRoot);
    try { await fs.promises.writeFile(temporary, JSON.stringify({ roots }, null, 2) + "\n"); await fs.promises.rename(temporary, file); }
    finally { await fs.promises.rm(temporary, { force: true }); }
    (await import("./cut-storage")).forgetPreviousRoots(newRoot);
  }
  const current = readStore();
  const stored = current.find(e => path.resolve(e.root) === oldRoot);
  if (!stored) throw new Error("This shoot changed in your library. Open the library and try relinking again.");
  if (current.some(e => e !== stored && path.resolve(e.root) === newRoot)) throw new Error("That folder is already in your library.");
  stored.root = newRoot; stored.footage = expected;
  writeStore(current);
  processing.delete(oldRoot);
  changed(oldRoot); changed(newRoot);
  return (await listShoots()).find(e => e.root === newRoot)!;
}

export async function pickFolder(): Promise<string | null> {
  // Attached to the window, so macOS shows it as a sheet, not a separate window.
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const opts = { properties: ["openDirectory" as const], buttonLabel: "Add shoot" };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

export async function revealInFinder(target: string): Promise<void> {
  const resolved = path.resolve(target);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      await shell.openPath(resolved);
      return;
    }
  } catch {
    // fall through to showItemInFolder for files and missing paths
  }
  shell.showItemInFolder(resolved);
}

// ---------------------------------------------------------------- queue ----
const queue: string[] = [];
const active = new Set<string>();
const splitParents = new Set<string>();
let running = false;
const lazyPreviews = new Map<string, Promise<void>>();

function schedulePreviews(root: string): void {
  if (lazyPreviews.has(root)) return;
  const job = Promise.resolve().then(async () => {
    // A shoot with ideas or edits remakes previews in the background, never as a processing stage.
    const quiet = await (await import("./source-changes")).establishedShoot(root);
    if (!splitParents.has(root) && !active.has(root) && !queue.includes(root)) await makePreviews(root, quiet);
  }).catch(error => { console.error(`[jobs] previews failed for ${root}:`, error); })
    .finally(() => { lazyPreviews.delete(root); });
  lazyPreviews.set(root, job);
}

/** Await previews already scheduled by reads, including writer release. Stop reads before draining all shoots. */
export async function waitForPreviews(root?: string): Promise<void> {
  await Promise.all(root === undefined ? [...lazyPreviews.values()] : [lazyPreviews.get(path.resolve(root))]);
}

export async function requestPreviews(root: string, clipIds: readonly string[]): Promise<void> {
  const { prioritizePreviews } = await import("./proxies");
  prioritizePreviews(root, clipIds);
  // An open edit asking for its shots in a shoot with ideas or edits is background work, not a processing stage.
  await makePreviews(root, await (await import("./source-changes")).establishedShoot(root));
  (await import("./sidekick")).changed(root);
}

/** quiet: no processing stage, clock or status-line task of its own (the caller's note says what is happening). */
async function makePreviews(root: string, quiet = false, deferStrips = false): Promise<void> {
  return withShootWriter(root, () => makePreviewsOwned(root, quiet, deferStrips));
}
async function makePreviewsOwned(root: string, quiet: boolean, deferStrips = false): Promise<void> {
  const namingShoot = await readJson<Shoot | null>(path.join(root, ".sidething/index.json"), null);
  const names = new Map(namingShoot?.clips.map(c => [c.id, clipName(c)]));
  const { makeShootProxies } = await import("./proxies");
  let activity: ReturnType<typeof begin> | undefined;
  let previewLabel = 'Making previews';
  try {
    await makeShootProxies(root, {
      deferStrips,
      onStatus: status => {
        // ANA1 (TEST1 #15): while a shoot's reading clock runs, it owns the one time left. A second "Making N clips
        // smooth · Approx" in the top bar disagreed with the waiting room's (7 min against 18 min).
        const clock = overallProcessing(root);
        if (quiet || clock && !clock.complete && !clock.failed || status.phase !== 'repairing' || !status.pending) return;
        const inEdit = status.editPending.length > 0, count = inEdit ? status.editPending.length : status.pending;
        const more = !inEdit && status.priorityIds.length > 0 ? ' more' : '';
        const label = `Making ${count}${more} clip${count === 1 ? '' : 's'} smooth`;
        activity ??= begin({ kind: 'process', root, target: null, label });
        activity.update({ label, target: null });
        activity.progress(null, '', inEdit ? status.editEtaS : status.etaS);
      },
      onStart: (total, pending) => {
        previewLabel = pending.every(clip => !!clip.proxy) ? `Repairing ${total} preview${total === 1 ? '' : 's'}` : 'Making previews';
        if (!quiet) {
          configureProcessingWork(root, pending, "Previews");
          reportStage(root, "index", "running", previewLabel, 0);
          activity ??= begin({ kind: "process", root, target: null, label: previewLabel });
          activity.progress(0, `0 of ${total}`);
        }
        forwarder({ root, clipId: "", stage: "proxy", pct: 0, note: `${previewLabel} · 0 of ${total}` });
      },
      onEncodeProgress: ({ clipId, completed, total, pct }) => {
        const note = `${previewLabel} · ${names.get(clipId) ?? clipName()} · ${completed} of ${total} ready`;
        activity?.update({ target: { clipId } });
        if (!quiet) updateProcessingClip(root, "Previews", clipId, pct / 100);
        if (!quiet) reportStage(root, "index", "running", note, (completed + pct / 100) / total * 100);
        activity?.progress((completed + pct / 100) / total * 100, note);
        forwarder({ root, clipId, stage: "proxy", pct, note });
      },
      onProgress: ({ clipId, completed, total, error }) => {
        if (!error) updateProcessingClip(root, "Previews", clipId, 1);
        const note = `${error ? "Could not make a preview for" : "Preview ready for"} ${names.get(clipId) ?? clipName()} · ${completed} of ${total}${error ? `: ${error}` : ""}`;
        activity?.update({ target: null });
        activity?.progress(completed / total * 100, note);
        forwarder({ root, clipId, stage: error ? "error" : "done", pct: 100, note });
        // The open edit and its timeline reload the shoot now and swap to the new preview.
        if (quiet) changed(root);
      },
    });
    activity?.done();
    if (activity) reportStage(root, "index", "done");
    if (activity) forwarder({ root, clipId: "", stage: "done", pct: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not make previews. Try again.";
    activity?.fail(message);
    reportStage(root, "index", "failed", message);
    if (activity) forwarder({ root, clipId: "", stage: "done", pct: 100 });
    throw error;
  }
}

// Choice changes share the single shoot queue, never the Python clip stages.
const rethinkRoots = new Set<string>();
const newFileRoots = new Set<string>();
export function enqueueNewFiles(root: string): void {
  root = path.resolve(root);
  newFileRoots.add(root);
  enqueueShoot(root);
  changed(root);
}
export function enqueueRethink(root: string): void {
  root = path.resolve(root);
  rethinkRoots.add(root);
  enqueueShoot(root);
  changed(root);
}
async function remakeIdeas(root: string, detail = "Rethinking ideas"): Promise<void> {
  reportStage(root, "ideas", "running", detail);
  const { sidekickSend } = await import("./sidekick");
  const reply = await sidekickSend(root, "The available footage changed. Remake the video ideas using only the footage available now. Earlier ideas are superseded. Keep existing edits as saved.", { addIdeas: true, supersedeIdeas: true });
  if (reply.error) throw new Error(reply.error);
  reportStage(root, "ideas", "done");
}
async function rethinkShoot(root: string, shoot: Shoot): Promise<void> {
  const count = shoot.clips.filter(c => c.leftOut).length;
  const detail = count ? `Rethinking without ${count} clip${count === 1 ? "" : "s"}` : "Rethinking with your clips";
  startProcessingClock(root, shoot.clips.filter(c => !c.leftOut).length, false);
  for (const phase of ["Stills", "Previews", "Transcripts"] as const) updateProcessingClock(root, phase, 1, "done");
  reportStage(root, "judge", "running", detail);
  updateProcessingClock(root, "Takes", 0);
  await (await import("./sidekick")).retireIdeas(root);
  const judged = await runActivity({ kind: "judge", root, target: null, label: detail }, () => judgeShoot(root));
  updateProcessingClock(root, "Takes", 1, "done");
  reportStage(root, "judge", "done");
  if (judged.shoot.clips.some(c => !c.leftOut && c.stage !== "error")) {
    await remakeIdeas(root, detail);
    await (await import("./sidekick")).continueAutopilot(root, "drafts");
  } else {
    reportStage(root, "ideas", "skipped", "Put clips back to find ideas.");
    reportStage(root, "drafts", "skipped", "Put clips back to make an edit.");
  }
}

export function enqueueShoot(root: string): void {
  const resolved = path.resolve(root);
  if (splitParents.has(resolved) || active.has(resolved) || queue.includes(resolved)) return;
  queue.push(resolved);
  void processQueue();
}

export function isShootProcessing(root: string): boolean { return active.has(path.resolve(root)) || queue.includes(path.resolve(root)); }

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const root = queue.shift() as string;
      active.add(root);
      let ownsWrite = false;
      try {
        await withShootWriter(root, async () => {
        ownsWrite = true;
        await libraryUpgradePending(root);
        const rethinking = !newFileRoots.has(root) && (rethinkRoots.has(root) || fs.existsSync(path.join(root, ".sidething/rethink.json")));
        // Adding to (or resuming) a shoot that already has ideas or edits reads quietly. See readQuietly.
        if (!rethinking && (quietRoots.has(root) || newFileRoots.has(root)) && fs.existsSync(path.join(root, ".sidething/index.json"))
          && await (await import("./source-changes")).establishedShoot(root)) {
          quietRoots.delete(root); newFileRoots.delete(root);
          await readQuietly(root);
          return;
        }
        const label = rethinking ? "Rethinking your shots" : "Reading your footage";
        await runActivity({ kind: rethinking ? "judge" : "process", root, target: null, label }, async activity => {
          const tick = () => { const overall = overallProcessing(root); if (overall) activity.progress(overall.pct, label, overall.etaS); };
          const timer = setInterval(tick, 1000);
          try {
            await runShoot(root);
            const failed = Object.values(processing.get(root) ?? {}).some(stage => stage.state === "failed" && (!rethinking || stage.id === "judge" || stage.id === "ideas"));
            finishProcessingClock(root, failed); tick(); changed(root);
            if (failed) throw new Error("Some steps couldn't finish. Open Details to retry.");
          } finally { clearInterval(timer); }
        });
        });
      } catch (err) {
        if (!ownsWrite) { console.warn(`[jobs] ${root}:`, err); continue; }
        if (splitParents.has(root)) continue;
        finishProcessingClock(root, true);
        const state = processing.get(root);
        const failed = Object.values(state ?? {}).filter(s => s.state === "running");
        // Blame what was actually unfinished; "Couldn't read your footage" only when it wasn't read.
        const order: ProcessingStageId[] = ["index", "transcribe", "group", "judge", "ideas", "drafts"];
        const unfinished = order.find(id => state?.[id]?.state !== "done" && state?.[id]?.state !== "skipped");
        // FIX3: a stage that failed has said so in its own words. What it stopped did not fail; it waits for the retry.
        const told = Object.values(state ?? {}).some(s => s.state === "failed");
        for (const stage of told ? [] : failed.length ? failed : unfinished ? [{ id: unfinished }] : []) {
          reportStage(root, stage.id, "failed", err instanceof Error ? err.message : "Could not finish processing. Try again.");
        }
        if (told) for (const stage of failed) reportStage(root, stage.id, "queued");
        console.error(`[jobs] processing failed for ${root}:`, err);
      } finally {
        active.delete(root);
        if (ownsWrite && !splitParents.has(root)) void import("./vocabulary").then(m => m.scheduleVocabulary(root));
        if (ownsWrite && (rethinkRoots.has(root) || quietRoots.has(root))) enqueueShoot(root);
      }
    }
  } finally {
    running = false;
  }
}

// ------------------------------------------------------------ quiet reads ----
// 25-26 Oct (a real shoot): swapping one clip for a blurred copy threw a finished edit back into
// the waiting room, re-checked every take and queued new ideas and first edits. Adding to a shoot that
// already has ideas or edits, and resuming its reading after a quit, is now quiet: only the new and
// changed files are read, in the background, with one note in the status line. No waiting room, no
// re-checked takes, no new ideas or edits; those are for a new shoot, or when the person asks for
// them. A changed source an edit uses goes first (metadata, then its preview), so the open edit
// swaps to the new picture within moments.
const quietRoots = new Set<string>();
const quietLabels = new Map<string, string>();
/** The status-line task of a quiet read ("Reading 35 new clips", "Updating <clip>"). */
export function isQuietRead(activity: Pick<import("../shared/schema").Activity, "root" | "kind" | "label">): boolean {
  return activity.kind === "process" && !!activity.root && quietLabels.get(activity.root) === activity.label;
}
export function enqueueQuietRead(root: string): void {
  root = path.resolve(root);
  quietRoots.add(root);
  enqueueShoot(root);
  changed(root);
}
// A source re-read once per version of the file this session, so a failed read never loops.
const triedSources = new Map<string, Set<string>>();
function sourceVersion(root: string, clip: Clip): string {
  try { const stat = fs.statSync(path.join(root, clip.photo?.file ?? clip.file)); return `${clip.id}:${stat.size}:${stat.mtimeMs}`; }
  catch { return `${clip.id}:gone`; }
}
/** A changed source an edit uses is read again without waiting for Add. Returns how many were queued. */
async function queueChangedSources(root: string, shoot: Shoot): Promise<number> {
  const { changedInEdits } = await import("./source-changes");
  const tried = triedSources.get(root) ?? new Set<string>();
  const fresh = (await changedInEdits(root, shoot)).filter(clip => !tried.has(sourceVersion(root, clip)));
  if (!fresh.length) return 0;
  for (const clip of fresh) tried.add(sourceVersion(root, clip));
  triedSources.set(root, tried);
  enqueueQuietRead(root);
  return fresh.length;
}
async function writeListAtomic(file: string, list: string[]): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.promises.writeFile(temporary, JSON.stringify(list)); await fs.promises.rename(temporary, file); }
  finally { await fs.promises.rm(temporary, { force: true }); }
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function readQuietly(root: string): Promise<void> {
  const side = path.join(root, ".sidething"), addFile = path.join(side, "add-files.json"), rereadFile = path.join(side, "reread.json");
  let previewsFailed = false;
  try {
    // A lazy preview remake must not race this pass writing the same index.
    await lazyPreviews.get(root);
    const shoot = await readJson<Shoot | null>(path.join(side, "index.json"), null);
    if (!shoot) return;
    // A stage a quit left running is being picked up, not interrupted.
    const saved = await readJson<Partial<Record<ProcessingStageId, StageCheckpoint>>>(path.join(side, "processing.json"), {}).catch((): Partial<Record<ProcessingStageId, StageCheckpoint>> => ({}));
    const resumed = (Object.keys(saved) as ProcessingStageId[]).filter(id => saved[id]?.state === "running" && !processing.get(root)?.[id]);
    for (const id of resumed) reportStage(root, id, "queued");
    const { changedInEdits, originalOf } = await import("./source-changes");
    const first = await changedInEdits(root, { ...shoot, root });
    const firstFiles = new Set(first.map(originalOf));
    // What this pass reads: the Add request (or, re-added or resumed without one, whatever is new or
    // changed), plus any clip a quit left half read. A missing original is skipped by every step.
    const asked = await readJson<string[] | null>(addFile, null).catch(() => null);
    const changes = asked === null ? folderChanges(root, { ...shoot, root }, (await getPreferences()).output?.exportFolder) : null;
    const unfinished = shoot.clips.filter(clip => needsProcessing(root, clip)).map(originalOf);
    const pending = new Set([...(asked ?? [...changes!.newFiles, ...changes!.changedFiles, ...changes!.newAudio]), ...unfinished]);
    for (const file of firstFiles) pending.delete(file);
    const rest = pending.size;
    if (first.length) {
      // An older retry could stamp a swapped source as read without reading it: read these fresh once.
      const reread = await readJson<string[]>(rereadFile, []).catch(() => [] as string[]);
      await writeListAtomic(rereadFile, [...new Set([...(Array.isArray(reread) ? reread : []), ...firstFiles])]);
    }
    const files = [...new Set([...firstFiles, ...pending])];
    if (files.length && (asked === null || files.some(file => !asked.includes(file)))) await writeListAtomic(addFile, files);
    // An Add pressed while this reads changes the request, so it reads again after.
    const request = await fs.promises.readFile(addFile, "utf8").catch(() => null);
    if (!first.length && !rest) {
      if (request !== null) await fs.promises.unlink(addFile).catch(() => {});
      for (const id of resumed) if (id === "index" || id === "transcribe") reportStage(root, id, "done");
      return;
    }
    if (!fs.existsSync(path.join(venvDir(), ".precut-ready"))) throw new Error("Set up precut before adding clips.");
    const firstLabel = first.length === 1 ? `Updating ${clipName(first[0])}` : `Updating ${plural(first.length, "changed clip")}`;
    const restLabel = `Reading ${plural(rest, "new clip")}`;
    await runActivity({ kind: "process", root, target: null, label: first.length ? firstLabel : restLabel }, async activity => {
      quietLabels.set(root, first.length ? firstLabel : restLabel);
      let note = "", lastChange = 0;
      const read = new Set<string>();
      const total = first.length + rest;
      const py = async (args: string[], attempt = 1): Promise<void> => {
        const code = await runProcess(venvPython(), ["-I", pipelineFile("process.py"), root, ...args], line => {
          try {
            const event = JSON.parse(line) as { clipId?: string; stage?: string; pct?: number };
            if (typeof event.clipId !== "string" || !event.clipId || typeof event.stage !== "string") return;
            if (event.stage === "done" || event.stage === "error") read.add(event.clipId);
            forwarder({ root, clipId: event.clipId, stage: heardStage(event.stage), pct: typeof event.pct === "number" ? event.pct : 0, note });
            activity.progress(Math.min(99, read.size / Math.max(1, total) * 100), `${Math.min(read.size, total)} of ${total}`);
            if (Date.now() - lastChange > 1000) { lastChange = Date.now(); changed(root); }
          } catch { /* Non-JSON tool output is not a progress event. */ }
        });
        // Its reads are saved clip by clip, so a retry carries on (another writer can win the index
        // three times in a row while previews and edits save beside it).
        if (code !== 0 && attempt < 3) { console.error(`[jobs] reading new footage: process.py exited ${code}, retrying`); return py(args, attempt + 1); }
        if (code !== 0) throw new Error("Could not read the new footage. Check the files and try again.");
      };
      const previews = async () => {
        // A preview that can't be made is told on the footage stage; it never stops the reading.
        try { await makePreviews(root, true); } catch (error) { previewsFailed = true; console.error(`[jobs] previews failed for ${root}:`, error); }
      };
      const posters = async (wanted: (clip: Clip) => boolean) => {
        const current = await readJson<Shoot | null>(path.join(side, "index.json"), null);
        const clips = (current?.clips ?? []).filter(wanted);
        if (clips.length) await makeOriginalPosters(root, clips, clip => { forwarder({ root, clipId: clip.id, stage: "frames", pct: 100, note: "Still ready" }); changed(root); });
      };
      if (first.length) {
        note = firstLabel;
        const ids = first.map(clip => clip.id);
        for (const id of ids) await py(["--clip", id, "--prepare-only"]);
        (await import("./proxies")).prioritizePreviews(root, ids);
        await previews();
        await posters(clip => ids.includes(clip.id));
        for (const id of ids) await py(["--clip", id]);
        changed(root);
      }
      if (rest) {
        note = restLabel;
        quietLabels.set(root, restLabel);
        activity.update({ label: restLabel, target: null });
        await py(["--prepare-only"]);
        await posters(clip => pending.has(originalOf(clip)));
        await previews();
        await py([]);
        if ([...pending].some(file => /\.(wav|mp3|m4a|aac|aif|aiff|flac)$/i.test(file))) {
          // New sound to line up with the clips; never a reason to stop.
          const code = await runProcess(venvPython(), ["-I", pipelineFile("sync.py"), root]).catch(() => 1);
          if (code !== 0) console.error(`[jobs] lining up sound skipped for ${root}`);
        }
        await (await import("./library-storage")).persistLibrary(root);
        (await import("./proxies")).relinkProxies(root);
        await previews();
      }
      activity.progress(100, `${total} of ${total}`);
    });
    // Done: clear what this pass read. An Add pressed meanwhile merged more files, so it runs again.
    if (request !== null) {
      if (request === await fs.promises.readFile(addFile, "utf8").catch(() => null)) await fs.promises.unlink(addFile).catch(() => {});
      else quietRoots.add(root);
    }
    if (!previewsFailed) for (const id of resumed) if (id === "index" || id === "transcribe") reportStage(root, id, "done");
  } catch (error) {
    console.error(`[jobs] reading new footage failed for ${root}:`, error);
    reportStage(root, "index", "failed", error instanceof Error ? error.message : "Could not read the new footage. Try again.");
  } finally { quietLabels.delete(root); changed(root); }
}

/** Reading a quit left unfinished picks up on the next launch, as does a changed source an edit uses. */
export async function resumeReading(): Promise<void> {
  const { establishedShoot } = await import("./source-changes");
  for (const entry of readStore()) {
    const root = path.resolve(entry.root), side = path.join(root, ".sidething");
    try {
      if (!fs.existsSync(path.join(side, "index.json")) || isShootProcessing(root) || splitParents.has(root)) continue;
      await retainOpenShoot(root);
      if (await shootHasOtherWriter(root)) continue;
      const saved = await readJson<Partial<Record<ProcessingStageId, StageCheckpoint>>>(path.join(side, "processing.json"), {}).catch((): Partial<Record<ProcessingStageId, StageCheckpoint>> => ({}));
      const reading = (["index", "transcribe", "group", "judge"] as const).some(id => saved[id]?.state === "running");
      const adding = fs.existsSync(path.join(side, "add-files.json"));
      if (await establishedShoot(root)) {
        if (reading || adding) enqueueQuietRead(root);
        else {
          const shoot = await readJson<Shoot | null>(path.join(side, "index.json"), null);
          if (shoot) await queueChangedSources(root, { ...shoot, root });
        }
      } else if (reading || adding) {
        // A new shoot's own run was cut short: it carries on where its saved reads stopped.
        if (adding) newFileRoots.add(root);
        enqueueShoot(root);
      }
    } catch (error) { console.error(`[jobs] could not resume reading ${root}:`, error); }
  }
}

/** ANA1: "transcribing" progress is the transcript stage to everything outside the clock. */
const heardStage = (stage: string): Stage => (stage === "transcribing" ? "transcript" : stage) as Stage;
function runProcess(
  command: string,
  args: string[],
  onLine?: (line: string) => void,
): Promise<number> {
  return getPreferences().then(preferences => new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...toolEnvironment(), SIDETHING_VOCABULARY: JSON.stringify(preferences.vocabulary), PRECUT_EXPORT_FOLDER: preferences.output?.exportFolder ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    if (onLine && child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", onLine);
    } else {
      child.stdout?.resume();
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  }));
}

let preparing: Promise<void> | undefined;
export function preparePython(onProgress: (message: string) => void = () => {}): Promise<void> {
  return preparing ??= installPython(onProgress).finally(() => { preparing = undefined; });
}

async function installPython(onProgress: (message: string) => void): Promise<void> {
  const home = supportDir();
  fs.mkdirSync(home, { recursive: true });
  const uv = tool("uv");
  onProgress("Downloading Python 3.12…");
  if (await runProcess(uv, ["python", "install", "3.12", "--no-bin", "--no-progress"]) !== 0) throw new Error("Python download failed. Try setup again.");
  if (!fs.existsSync(venvPython())) {
    onProgress("Creating the Python environment…");
    if (await runProcess(uv, ["venv", "--python", "3.12", venvDir()]) !== 0) throw new Error("Could not create the Python environment.");
  }
  const setup = pipelineFile("setup.py");
  const code = await runProcess(venvPython(), ["-I", setup], line => {
    try {
      const event = JSON.parse(line);
      if (typeof event.message === "string") onProgress(event.message);
    } catch { /* only fixed progress messages reach the setup screen */ }
  });
  if (code !== 0 || !fs.existsSync(path.join(venvDir(), ".precut-ready"))) {
    throw new Error("Python setup did not finish. Press Set up precut to retry.");
  }
}

// Match process.py's core cache check, independently of the proxy receipt.
// A preview migration must never turn into a new processing/judging pass.
function needsProcessing(root: string, clip: Clip): boolean {
  if (clip.stage === "error") return false;
  return clip.stage !== "done" || !clip.meta || clip.transcript == null || clip.shake == null
    || !!clip.photo && !fs.existsSync(path.join(root, clip.file))
    || (clip as Clip & { _transcriptNeedsRefresh?: boolean })._transcriptNeedsRefresh === true
    || (clip.frames?.length ?? 0) < 8 || clip.frames.length > 16
    || clip.frames.some(frame => !fs.existsSync(path.join(root, ".sidething/frames", frame)));
}

// ONB2: shoots read without an AI to use this run (their AI stages say "Needs your AI").
const needsAiRoots = new Set<string>();
async function runShoot(root: string): Promise<void> {
  const saved = await readJson<Shoot | null>(path.join(root, ".sidething/index.json"), null);
  const filesChanged = !!saved && shootFilesChanged(root, saved, (await getPreferences()).output?.exportFolder);
  const addFile = path.join(root, ".sidething/add-files.json");
  const added = await fs.promises.readFile(addFile, "utf8").catch(() => null);
  const receiptFile = path.join(root, ".sidething/rethink.json");
  const receipt = await fs.promises.readFile(receiptFile, "utf8").catch(() => null);
  const rethink = rethinkRoots.delete(root) || receipt !== null;
  const adding = newFileRoots.delete(root);
  if (rethink && saved && !adding) {
    await rethinkShoot(root, await mergeLeftOut({ ...saved, root }));
    if (receipt === await fs.promises.readFile(receiptFile, "utf8").catch(() => null)) await fs.promises.unlink(receiptFile).catch(() => {});
    return;
  }
  if (filesChanged || rethink) await (await import("./sidekick")).retireIdeas(root);
  // ONB1: the tools install may still be running from first launch; the speech model is waited for inside the transcribe step.
  // ONB2: offline, reading waits for the tools with one plain line and carries on by itself when they arrive.
  const onboarding = await import("./onboarding");
  await (onboarding.ensureToolsWhenOnline ? onboarding.ensureToolsWhenOnline(line => reportStage(root, "index", "running", line)) : onboarding.ensureTools());
  // Finish a lazy remake before Python takes its snapshot of this index.
  await lazyPreviews.get(root);
  const initial = await loadShoot(root);
  if (!filesChanged && initial?.clips.length && initial.clips.every(c => c.stage === "error")) {
    reportStage(root, "index", "failed", "Couldn't read your clips. Retry in Footage.");
    for (const id of ["ideas", "drafts"] as const) reportStage(root, id, "skipped", "No clips could be read.");
    return;
  }
  if (!filesChanged && !rethink && initial && fs.existsSync(path.join(root, ".sidething/index.json"))
    && !initial.clips.some(c => c.stage === "error")
    && !initial.clips.some(clip => needsProcessing(root, clip))) {
    await makePreviews(root);
    await (await import('./angles')).measureAngles(root);
    return;
  }
  const name = initial?.name || path.basename(root);
  // Previews run beside transcription, so only the lane that owns "index" moves it.
  const streaming = lanePolicy() === "parallel";
  const preflight = overallProcessing(root);
  const hasStills = !!preflight && !preflight.complete && !preflight.failed && preflight.stages.find(s => s.label === "Stills")?.state === "done";
  if (!hasStills) startProcessingClock(root, initial?.clips.length ?? 1, streaming);
  if (!hasStills) {
    updateProcessingClock(root, "Stills", 0);
    reportStage(root, "index", "running", "Stills");
    await makeOriginalPosters(root, initial?.clips ?? [], (clip, completed) => {
      updateProcessingClock(root, "Stills", completed / Math.max(1, initial?.clips.length ?? 1));
      forwarder({ root, clipId: clip.id, stage: "frames", pct: 100, note: "Still ready" }); changed(root);
    });
    updateProcessingClock(root, "Stills", 1, "done");
  }
  await runActivity({ kind: "process", root, target: null, label: `Processing ${name}` }, async activity => {
    // A shoot can download its speech model, but never silently install software.
    if (!fs.existsSync(path.join(venvDir(), ".precut-ready"))) throw new Error("Set up precut before adding a shoot.");
    await governor.whenMemoryAllows(activity.signal);  // PERF1: under 15% free memory, wait and retry
    let shoot: Shoot | null = null;
    let clipCount = 1;
    // ANA1: process.py runs twice. Transcripts first (never waiting for a preview), then stills and shake as each
    // preview's shared decode lands, in whichever order they land.
    const stages: { file: string; stage?: Stage; note: string; optional?: OptionalCheckId; args?: string[]; pictures?: boolean }[] = [
      { file: "process.py", note: "Processing clips", args: ["--no-pictures"] },
      { file: "sync.py", stage: "audio", note: "Lining up sound" },
      ...(fs.existsSync(pipelineFile("subject.py"))
        ? [{ file: "subject.py", stage: "frames" as const, note: "Framing", optional: "framing" as const }] : []),
      ...(fs.existsSync(pipelineFile("quality.py"))
        ? [{ file: "quality.py", stage: "frames" as const, note: "Checking focus and sound", optional: "quality" as const }] : []),
      { file: "fillers.py", stage: "transcript", note: "Finding ums", optional: "fillers" },
      { file: "process.py", note: "Choosing stills", pictures: true },
    ];
    const runTask = async (task: typeof stages[number], extraArgs: string[] = []): Promise<void> => {
      const index = stages.indexOf(task);
      const stageId: ProcessingStageId = task.file === "process.py" ? "index"
        : task.file === "sync.py" || task.file === "fillers.py" ? "transcribe" : "judge";
      if (!task.pictures) reportStage(root, stageId, "running", task.note);
      const progress = new Map<string, number>();
      const unfinished = shoot?.clips.filter(clip => needsProcessing(root, clip)) ?? [];
      const scopes = task.file === "process.py" && unfinished.length > 0 && unfinished.length < (shoot?.clips.length ?? 0)
        ? unfinished.map(clip => ["--clip", clip.id]) : [[]];
      const currentShoot = task.file === "fillers.py" ? await loadShoot(root) : shoot;
      const fillerCount = task.file === "fillers.py" ? Math.max(1,
        (currentShoot?.clips.filter(c => c.transcript?.some(segment => segment.text.trim() || segment.words?.length)).length ?? 0)
        + (currentShoot?.takes.reduce((n, take) => n + take.attempts.length, 0) ?? 0)) : 0;
      const expectedCount = () => fillerCount || clipCount;  // ANA1: the transcripts pass starts before the clips are counted
      let fraction = 0;
      const heard = new Set<string>();
      let coreStage: ProcessingStageId = streaming ? "transcribe" : "index";
      const step = begin({ kind: "process", root, target: null, label: `${task.note} in ${name}` });
      activity.progress(index / stages.length * 100, task.note);
      if (task.stage) forwarder({ root, clipId: "", stage: task.stage, pct: 0, note: task.note });
      try {
        let code = 0;
        for (const scope of scopes) {
          code = await runProcess(venvPython(), ["-I", pipelineFile(task.file), root, ...(task.args ?? []), ...extraArgs, ...scope], line => {
            try {
              const event = JSON.parse(line) as { clipId?: string; stage?: string; pct?: number; attemptS?: number; error?: string; note?: string };
              if (typeof event.pct === "number" && Number.isFinite(event.pct)) {
                const key = `${event.clipId ?? ""}${event.attemptS === undefined ? "" : `:${event.attemptS}`}`;
                // Sync reports a shoot-wide percentage; other tools report per
                // clip/attempt. Ignore process.py's filler diagnostic percentage.
                if (!(task.file === "process.py" && event.note === "finding ums")) {
                  progress.set(key, Math.max(progress.get(key) ?? 0, Math.max(0, Math.min(100, event.pct))));
                  const measured = task.file === "sync.py" || !event.clipId ? Math.max(0, Math.min(100, event.pct)) / 100
                    : Math.min(1, [...progress.values()].reduce((n, pct) => n + pct, 0) / expectedCount() / 100);
                  fraction = Math.max(fraction, measured);
                }
                const note = `${task.note}${event.clipId ? ` · ${clipName(saved?.clips.find(c => c.id === event.clipId))}` : ""}${event.error ? `: ${event.error}` : ""}`;
                if (task.pictures) { /* stills follow the previews lane, which owns "index" */ }
                else if (task.file === "process.py") {
                  // Core events are emitted AFTER each unit is saved. The
                  // following work, rather than its fixed 10/40/60/80 weights,
                  // determines the stage shown as active.
                  const upcoming: ProcessingStageId = task.args?.includes("--no-pictures") ? "transcribe" : event.stage === "probe" ? "transcribe"
                    : event.stage === "transcript" ? "judge" : "index";
                  const next: ProcessingStageId = streaming && upcoming === "index" ? "transcribe" : upcoming;
                  // A clip's saved error belongs to that clip. Fail the stage
                  // below only when none of the footage could be read.
                  if (event.stage !== "error" && event.note !== "finding ums") {
                    if (next !== coreStage && processing.get(root)?.[coreStage]?.state === "running") reportStage(root, coreStage, "queued");
                    coreStage = next;
                    reportStage(root, next, "running", note, null);
                  }
                } else reportStage(root, stageId, "running", event.error ?? note, fraction * 100);
                step.progress(fraction * 100, note);
                activity.progress((index + fraction) / stages.length * 100, note);
              }
              // ANA1: whisper reports how far it has heard each clip (transcript, then the ums pass), so a long
              // clip's share counts down instead of jumping from 0 to 1 at the end.
              if (task.file === "process.py" && event.clipId && event.stage === "transcribing" && typeof event.pct === "number") {
                heard.add(event.clipId);
                updateProcessingClip(root, "Transcripts", event.clipId, Math.min(1, event.pct / 100));
              } else if (task.file === "process.py" && event.clipId && (event.stage === "transcript" || event.stage === "done")) {
                updateProcessingClip(root, "Transcripts", event.clipId, event.stage === "transcript" && heard.has(event.clipId) ? .5 : 1);
              }
              if (typeof event.clipId === "string" && typeof event.stage === "string") {
                forwarder({ root, clipId: event.clipId, stage: task.stage ?? heardStage(event.stage),
                  pct: typeof event.pct === "number" ? event.pct : 0, note: task.note });
              }
            } catch { /* Non-JSON tool output is not a progress event. */ }
          });
          if (code !== 0) break;
        }
        if (task.file === "quality.py") await (await import("./library-storage")).persistLibrary(root);
        if (code !== 0) throw new Error(`Could not finish ${task.note.toLowerCase()}. Check the shoot files and try again.`);
        if (task.file === "process.py") await (await import("./library-storage")).persistLibrary(root);
        step.done();
        if (task.file === "process.py") {
          const indexed = await loadShoot(root);
          if (indexed?.clips.length && indexed.clips.every(c => c.stage === "error")) {
            const clip = indexed.clips.find(c => c.stage === "error")!;
            const id = !clip.meta ? "index" : clip.transcript == null ? "transcribe" : "judge";
            reportStage(root, id, "failed", clip.error ?? "Could not process this clip. Check the source and retry.");
          }
          // Playable previews are made by the previews lane (metadata and the
          // clean camera conversion are owned by TS, before framing and quality).
          const current = processing.get(root);
          if (!task.pictures && current?.transcribe?.state !== "failed") reportStage(root, "transcribe", "queued");
          if (!task.pictures && current?.judge?.state !== "failed") reportStage(root, "judge", "queued");
        } else if (task.file === "fillers.py") reportStage(root, "transcribe", "done");
        else reportStage(root, stageId, "queued");
        if (task.optional) reportOptional(root, task.optional, null, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not finish this step. Try again.";
        step.fail(message);
        if (!task.optional) { reportStage(root, stageId, "failed", message); throw err; }
        // An optional check: the stage carries on without it, and says so in its own words.
        console.error(`[jobs] ${task.file} skipped for ${root}:`, err);
        reportOptional(root, task.optional, message);
        reportStage(root, stageId, task.file === "fillers.py" ? "done" : "queued");
      } finally {
        if (task.stage) forwarder({ root, clipId: "", stage: "done", pct: 100 });
      }
    };
    const only = (...files: string[]) => stages.filter(task => files.includes(task.file));
    const takesFailure = Symbol("takes");
    let draftsFailure: unknown = null;  // BUG2: first edits failing is that stage's failure only
    // ANA1: the transcripts pass starts with the reading: it loads and warms the speech model while metadata is read,
    // then waits for this marker ("go" once metadata and the visual session are saved, "stop" if reading failed).
    const prepared = path.join(root, ".sidething", `prepared-${randomUUID()}`);
    let transcripts: Promise<void> | null = null;
    const timeline = await runStreaming({
      prepare: async () => {
        transcripts = runTask(stages[0], ["--after", prepared]);
        void transcripts.catch(() => {});
        try {
          if (await runProcess(venvPython(), ["-I", pipelineFile("process.py"), root, "--prepare-only"], () => changed(root)) !== 0) throw new Error("Could not read the footage.");
          shoot = await loadShoot(root);
          clipCount = Math.max(1, shoot?.clips.length ?? 1);
          configureProcessingWork(root, shoot?.clips ?? []);
          const { prepareVisualSession } = await import("./proxies");
          prepareVisualSession(root);
          fs.writeFileSync(prepared, "go");
        } catch (error) {
          try { fs.writeFileSync(prepared, "stop"); } catch { /* the folder is gone: the waiting pass gives up on its own */ }
          await transcripts.catch(() => {});
          throw error;
        }
      },
      previews: async () => {
        updateProcessingClock(root, "Previews", 0);
        await makePreviews(root, false, true);
        // Whoever else saved the index meanwhile (sync, judging) must not leave a clip unlinked.
        const { relinkProxies } = await import("./proxies");
        relinkProxies(root);
        updateProcessingClock(root, "Previews", 1, "done");
        if (processing.get(root)?.index?.state !== "failed") reportStage(root, "index", "done");
      },
      audio: async () => {
        updateProcessingClock(root, "Transcripts", 0);
        forwarder({ root, clipId: "", stage: "transcript", pct: 0, note: "Speech model: about 1.6 GB on the first shoot" });
        activity.progress(null, "Speech model: about 1.6 GB on the first shoot");
        try { await (transcripts ?? runTask(stages[0])); } finally { fs.rmSync(prepared, { force: true }); }
        for (const task of only("sync.py", "fillers.py")) await runTask(task);
        updateProcessingClock(root, "Transcripts", 1, "done");
      },
      // Stills and shake: each clip as soon as its preview's decode lands (serial: after the previews).
      pictures: () => runTask(stages.find(task => task.pictures)!),
      takes: async () => {
        if (!(await loadShoot(root))?.clips.some(c => c.stage !== "error")) {
          for (const id of ["group", "judge"] as const) reportStage(root, id, "skipped", "No clips could be read.");
          updateProcessingClock(root, "Takes", 1, "skipped");
          return;
        }
        // ONB2: no AI to use is not a failure. Takes, ideas and first edits say "Needs your AI"; the local work carries on.
        const withoutAi = () => {
          for (const id of ["group", "judge", "ideas", "drafts"] as const) reportStage(root, id, "skipped", STAGE_NEEDS_AI);
          for (const phase of ["Takes", "Ideas", "First edits"] as const) updateProcessingClock(root, phase, 1, "skipped");
          needsAiRoots.add(root);
        };
        needsAiRoots.delete(root);
        if ((appSettings as { aiOff?: () => boolean }).aiOff?.()) { withoutAi(); return; }
        updateProcessingClock(root, "Takes", 0);
        try {
          reportStage(root, "group", "running", "Grouping takes and checking performances");
          reportStage(root, "judge", "running", "Checking takes");
          const count = Math.max(1, (await loadShoot(root))?.clips.length ?? 1);
          const completed = new Set<string>();
          await runActivity({ kind: "judge", root, target: null, label: `Checking takes in ${name}` }, async judging => judgeShoot(root, { force: adding, onProgress: e => {
            forwarder({ root: e.root, clipId: e.clipId, stage: e.stage, pct: e.pct });
            if (e.stage === "done") completed.add(e.clipId);
            const pct = completed.size / count * 100;
            // These receipts arrive together after one model call. They are
            // counts, not per-clip throughput samples for the clock.
            reportStage(root, "judge", "running", "Checking takes", e.stage === "done" ? pct : null);
            judging.progress(Math.min(100, pct), "Checking takes");
          } }));
          // Takes exist now. Performance checks keep refining them while ideas begin.
          updateProcessingClock(root, "Takes", .5);
          pauseProcessingPhase(root, "Takes");
          reportStage(root, "group", "done");
          reportStage(root, "judge", "running", "Checking performances", null);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Could not check performances. Try again.";
          const problem = engineProblemOf(message);
          if (problem === "none" || problem === "not-installed" || problem === "signed-out") { console.info(`[jobs] takes need the AI for ${root}: ${message}`); withoutAi(); return; }
          // A real failure: ideas and first edits wait for it, and say so.
          for (const id of ["ideas", "drafts"] as const) reportStage(root, id, "skipped", "Takes need a retry.");
          if (processing.get(root)?.group?.state === "running") reportStage(root, "group", "failed", message);
          if (processing.get(root)?.judge?.state === "running") reportStage(root, "judge", "failed", message);
          // Clips are already processed; a judge failure must not fail the shoot.
          console.error(`[jobs] judging failed for ${root}:`, err);
          throw Object.assign(new Error(message), { [takesFailure]: true });
        }
      },
      ideas: async () => {
        if (needsAiRoots.has(root)) return;
        if (!(await loadShoot(root))?.clips.some(c => c.stage !== "error")) {
          reportStage(root, "ideas", "skipped", "No clips could be read."); return;
        }
        const { continueAutopilot } = await import("./sidekick");
        if (filesChanged || rethink) await remakeIdeas(root);
        else await continueAutopilot(root, "ideas", { early: true, ideasOnly: true });
      },
      drafts: async () => {
        if (needsAiRoots.has(root)) return;
        if (processing.get(root)?.ideas?.state === "failed") {
          reportStage(root, "drafts", "skipped", "Ideas need a retry."); return;
        }
        if (!(await loadShoot(root))?.clips.some(c => c.stage !== "error")) {
          reportStage(root, "drafts", "skipped", "No clips could be read."); return;
        }
        const { continueAutopilot } = await import("./sidekick");
        // BUG2: performance checks still finish; the shoot fails on this stage alone, after them.
        try { await continueAutopilot(root, "drafts", { early: true }); }
        catch (err) {
          draftsFailure = err;
          if (processing.get(root)?.drafts?.state !== "failed") reportStage(root, "drafts", "failed", err instanceof Error ? err.message : "Could not make the first edits. Try again.");
        }
      },
      measures: async () => {
        if (!(await loadShoot(root))?.clips.some(c => c.stage !== "error")) return;
        resumeProcessingPhase(root, "Takes");
        // The stand-in strips the previews lane held back: beside framing and quality, after the first edits.
        void import("./thumbnails").then(m => m.makeStandInStrips(root)).catch(() => {});
        for (const task of only("subject.py", "quality.py")) await runTask(task);
        const screenShoot = await loadShoot(root);
        if (screenShoot) scheduleScreenRead(screenShoot, () => forwarder({ root, clipId:"", stage:"done", pct:100 }));
        // Matching camera angles is a refinement too: never a reason to stop.
        try { await (await import('./angles')).measureAngles(root); }
        catch (err) { console.error(`[jobs] angles skipped for ${root}:`, err); }
      },
      judge: async () => {
        if (!(await loadShoot(root))?.clips.some(c => c.stage !== "error")) return { changed: false };
        // V1: the whole-shoot judgement already ran in takes. Late focus,
        // sound and subject facts enrich edits and Ask without another call.
        // ONB2: framing and quality report under "judge" while they run; once they are done it says "Needs your AI" again.
        if (needsAiRoots.has(root)) { reportStage(root, "judge", "skipped", STAGE_NEEDS_AI); return { changed: false }; }
        updateProcessingClock(root, "Takes", 1, "done");
        reportStage(root, "judge", "done");
        return { changed: false };
      },
      refresh: async () => {
        const { refreshAfterJudging } = await import("./sidekick");
        if (!filesChanged && !rethink) await refreshAfterJudging(root);
      },
    }, { mode: streaming ? "parallel" : "serial" }).catch(err => { if ((err as Record<symbol, unknown>)?.[takesFailure]) return []; throw err; });
    if (draftsFailure) throw draftsFailure;
    // ONB2: "N h N min of footage watched in N min, on this Mac", measured from this shoot's own reading.
    try {
      const read = await loadShoot(root);
      const footageS = (read?.clips ?? []).filter(c => c.stage !== "error" && !c.photo).reduce((n, c) => n + (c.meta?.durationS ?? 0), 0);
      const started = processingStartedAt(root);
      if (started && footageS > 0) fs.writeFileSync(path.join(root, ".sidething/read-time.json"), JSON.stringify({ footageS: Math.round(footageS), tookS: Math.round((Date.now() - started) / 1000), clips: read?.clips.length ?? 0, at: new Date().toISOString() }));
    } catch { /* a missing measurement never fails the shoot */ }
    try {
      const file = path.join(root, ".sidething/processing-timeline.json");
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(timeline, null, 1)); fs.renameSync(`${file}.tmp`, file);
    } catch { /* a missing timeline never fails the shoot */ }
  });
  updateProcessingClock(root, "Transcripts", 1, "done");
  if (added !== null && added === await fs.promises.readFile(addFile, "utf8").catch(() => null)) await fs.promises.unlink(addFile).catch(() => {});
  if (receipt === await fs.promises.readFile(receiptFile, "utf8").catch(() => null)) await fs.promises.unlink(receiptFile).catch(() => {});
}

export async function addShoot(root: string): Promise<Shoot> {
  const resolved = path.resolve(root);
  rememberShoot(resolved);
  const existing = await loadShoot(resolved);
  if (await restoreFolderSplit(resolved)) return existing ?? stubShoot(resolved);
  if (existing && fs.existsSync(path.join(resolved, ".sidething/index.json")) && await (await import("./source-changes")).establishedShoot(resolved)) {
    // A shoot with ideas or edits reads what is new or changed quietly: no folder questions, waiting room, takes check, ideas or edits.
    if (!isShootProcessing(resolved) && !folderImports.has(resolved)
      && (existing.clips.some(clip => needsProcessing(resolved, clip)) || shootFilesChanged(resolved, existing, (await getPreferences()).output?.exportFolder))) enqueueQuietRead(resolved);
    return existing;
  }
  if (!fs.existsSync(path.join(resolved, ".sidething/index.json"))
    || existing?.clips.some(clip => needsProcessing(resolved, clip))
    || existing && shootFilesChanged(resolved, existing, (await getPreferences()).output?.exportFolder)) {
    // Import returns immediately. Folder judgement runs through the activity bus
    // before any parent pipeline is queued, with one call per imported folder.
    if (!folderImports.has(resolved) && !isShootProcessing(resolved)) {
      reportStage(resolved, "index", "running", "Getting to know your folders");
      const work = runActivity({ kind: "process", root: resolved, target: null, label: "Getting to know your folders" }, async activity => {
        // Stills land before a model or slow metadata probe can hold them up.
        startProcessingClock(resolved, existing?.clips.length ?? 1, lanePolicy() === "parallel");
        updateProcessingClock(resolved, "Stills", 0);
        await makeOriginalPosters(resolved, existing?.clips ?? [], (clip, completed) => {
          updateProcessingClock(resolved, "Stills", completed / Math.max(1, existing?.clips.length ?? 1));
          forwarder({ root: resolved, clipId: clip.id, stage: "frames", pct: 100, note: "Still ready" }); changed(resolved);
        });
        updateProcessingClock(resolved, "Stills", 1, "done");
        const together = await prepareFolderImport(resolved);
        activity.signal.throwIfAborted();
        reportStage(resolved, "index", "queued");
        if (together) enqueueShoot(resolved);
        else clearProcessingClock(resolved);
      });
      folderImports.set(resolved, work);
      void work.catch(error => { if (!splitParents.has(resolved)) reportStage(resolved, "index", "failed", error instanceof Error ? error.message : "Could not read these folders. Try again."); })
        .finally(() => { if (folderImports.get(resolved) === work) folderImports.delete(resolved); changed(resolved); });
    }
  }
  return existing ?? stubShoot(resolved);
}

const folderImports = new Map<string, Promise<unknown>>();
export async function stopParentForSplit(root: string): Promise<void> {
  root = path.resolve(root);
  splitParents.add(root);
  clearProcessingClock(root);
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i] === root) queue.splice(i, 1);
  for (const activity of await listActivity()) {
    if (activity.root === root && activity.state === "running") await cancelActivity(activity.id);
  }
}

// process.py's command runs all core stages. Retry uses its own functions so a
// failed transcript does not re-probe, re-extract stills or redo shake analysis.
const RETRY_CORE = `
import runpy, sys, json
from pathlib import Path
p = runpy.run_path(sys.argv[1])
root, stage = Path(sys.argv[2]), sys.argv[3]
side = root / ".sidething"
index = p["load_index"](root, side)
if not index.get("clips"):
    files, _ = p["discover"](root)
    ids = p["assign_clip_ids"](files, root)
    index["clips"] = [p["empty_clip"](f, root, ids[str(f.relative_to(root))]) for f in files]
failed = False
for clip in index["clips"]:
    source = root / clip["file"]
    previous_error = clip.get("error") if clip.get("stage") == "error" else None
    failed_stage = "index" if clip.get("meta") is None else "transcribe" if clip.get("transcript") is None or clip.get("_transcriptNeedsRefresh") else "judge" if clip.get("shake") is None else "index"
    try:
        meta = clip.get("meta")
        if stage == "index":
            if meta is None:
                meta, is_log = p["probe_clip"](source)
                clip["meta"] = meta
            else:
                is_log = "log" in (meta.get("pictureProfile") or "").lower()
            frames = clip.get("frames") or []
            if not 8 <= len(frames) <= 16 or not all((side / "frames" / f).exists() for f in frames):
                turn = (p["clip_rotation"](clip) - meta.get("containerRotation", 0)) % 360
                clip["frames"] = p["extract_frames"](source, clip["id"], float(meta.get("durationS") or 0), is_log, side / "frames", turn, clip.get("shake"))
                clip["_framesRotation"] = p["clip_rotation"](clip)
                clip["_smartFramesVersion"] = 1
        elif stage == "transcribe":
            if meta is None:
                raise RuntimeError("Read the footage metadata before retrying dialogue.")
            if clip.get("transcript") is None or clip.get("_transcriptNeedsRefresh"):
                clip["transcript"] = p["keep_hand_words"](p["transcribe_clip"](source, int(meta.get("audioChannels") or 0) > 0, side, clip.get("sound"), float(meta.get("durationS") or 0)), clip.get("transcript"))
                clip["_transcriptSound"] = p["transcript_source"](root, clip)
                clip.pop("_transcriptNeedsRefresh", None)
        elif stage == "judge":
            if meta is None:
                raise RuntimeError("Read the footage metadata before retrying performance checks.")
            if clip.get("shake") is None:
                clip["shake"] = p["measure_shake"](source, float(meta.get("fps") or 25), float(meta.get("durationS") or 0))
        # A core retry clears only an error whose required data now exists.
        ready = clip.get("meta") is not None and clip.get("transcript") is not None and clip.get("shake") is not None and 8 <= len(clip.get("frames") or []) <= 16
        clip["stage"] = "done" if ready else "transcript" if clip.get("transcript") is None else "shake" if clip.get("shake") is None else "frames"
        if previous_error and failed_stage != stage:
            clip["stage"], clip["error"] = "error", previous_error
        else:
            clip.pop("error", None)
        # The receipt is the original's (a photo's HEIC, not its still), and a retry only fills a
        # missing one: restamping a changed source here hid the change from every later read.
        original = root / ((clip.get("photo") or {}).get("file") or clip["file"])
        stat = original.stat()
        receipt = {"size": stat.st_size, "mtime": stat.st_mtime, **({"mtimeNs": stat.st_mtime_ns} if clip.get("photo") else {})}
        index.setdefault("_cache", {}).setdefault("clips", {}).setdefault(clip["id"], receipt)
    except Exception as error:
        failed = True
        clip["stage"], clip["error"] = "error", str(error)
    p["save_index"](side, index)
    print(json.dumps({"clipId": clip["id"], "stage": "error" if clip.get("error") else "done", "error": clip.get("error")}), flush=True)
sys.exit(1 if failed else 0)
`;

// Rerun measurements only. A person's explicit re-judge is a separate action.
async function retryOptional(root: string, id: OptionalCheckId): Promise<void> {
  if (active.has(root) || queue.includes(root) || lazyPreviews.has(root)
    || (await listActivity()).some(a => a.root === root && a.state === "running")) {
    throw new Error("This shoot is still working. Wait for the current stage to finish before retrying.");
  }
  const file = { framing: "subject.py", quality: "quality.py", fillers: "fillers.py" }[id];
  active.add(root);
  try {
    await runActivity({ kind: id === "fillers" ? "process" : "judge", root, target: null,
      label: { framing: "Checking framing", quality: "Checking focus and sound", fillers: "Finding ums" }[id] }, async () => {
      if (!fs.existsSync(path.join(venvDir(), ".precut-ready"))) throw new Error("Set up precut before retrying this check.");
      const code = await runProcess(venvPython(), ["-I", pipelineFile(file), root]);
      if (id === "quality") await (await import("./library-storage")).persistLibrary(root);
      if (code !== 0) throw new Error("Couldn't finish this check. Try again.");
      changed(root);
    });
    reportOptional(root, id, null, false);
  } catch (error) {
    reportOptional(root, id, error instanceof Error ? error.message : "Couldn't finish this check. Try again.");
    throw error;
  } finally { active.delete(root); changed(root); }
}

export async function retryStage(root: string, id: ProcessingStageId | OptionalCheckId): Promise<void> {
  root = path.resolve(root);
  if (isOptionalCheck(id)) return retryOptional(root, id);
  if (!["index", "transcribe", "group", "judge", "ideas", "drafts"].includes(id)) throw new Error("Choose a processing stage to retry.");
  if (active.has(root) || queue.includes(root) || lazyPreviews.has(root)
    || (await listActivity()).some(a => a.root === root && a.state === "running")) {
    throw new Error("This shoot is still working. Wait for the current stage to finish before retrying.");
  }
  if (["judge", "group", "ideas"].includes(id) && fs.existsSync(path.join(root, ".sidething/rethink.json"))) { enqueueRethink(root); return; }
  active.add(root);
  reportStage(root, id, "running");
  try {
    if (id === "ideas" || id === "drafts") {
      const { retryGeneration } = await import("./sidekick");
      await retryGeneration(root, id);
    } else {
      await runActivity({ kind: id === "group" || id === "judge" ? "judge" : "process", root, target: null,
        label: `Retrying ${id === "index" ? "footage and metadata" : id === "transcribe" ? "dialogue" : "takes and performances"}` }, async activity => {
        if (!fs.existsSync(path.join(venvDir(), ".precut-ready"))) throw new Error("Set up precut before retrying this stage.");
        const local = async (file: string) => {
          activity.progress(null, `Running ${file.replace(".py", "")}`);
          const code = await runProcess(venvPython(), ["-I", pipelineFile(file), root]);
          if (file === "quality.py") await (await import("./library-storage")).persistLibrary(root);
          if (code !== 0) throw new Error(`Could not finish ${file.replace(".py", "")}. Check the footage and retry.`);
          changed(root);
        };
        const core = async () => {
          if (await runProcess(venvPython(), ["-I", "-c", RETRY_CORE, pipelineFile("process.py"), root, id], () => changed(root)) !== 0) {
            throw new Error("Some clips could not finish this stage. Check the footage and retry.");
          }
        };
        if (id === "index") { await core(); await makePreviews(root); }
        else if (id === "transcribe") {
          await local("sync.py"); await core();
          try { await local("fillers.py"); reportOptional(root, "fillers", null, false); }
          catch (err) { reportOptional(root, "fillers", err instanceof Error ? err.message : null); }
        }
        else {
          if (id === "judge") {
            await core();
            for (const [file, check] of [["subject.py", "framing"], ["quality.py", "quality"]] as const) if (fs.existsSync(pipelineFile(file))) {
              try { await local(file); reportOptional(root, check, null, false); }
              catch (err) { reportOptional(root, check, err instanceof Error ? err.message : null); }
            }
          }
          // Grouping and performance recommendations share the existing judge
          // request. Its writer preserves the person's script and hand picks.
          await judgeShoot(root, { force: true, onProgress: e => {
            forwarder(e); changed(root);
          } });
          reportStage(root, "group", "done"); reportStage(root, "judge", "done");
        }
      });
    }
    reportStage(root, id, "done");
  } catch (error) {
    reportStage(root, id, "failed", error instanceof Error ? error.message : "Could not finish this stage. Try again.");
    throw error;
  } finally { active.delete(root); changed(root); if (id === "transcribe") void import("./vocabulary").then(m => m.scheduleVocabulary(root)); }
}
