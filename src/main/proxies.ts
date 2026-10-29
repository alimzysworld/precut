import { sourceAudio } from './source-audio';
import { canVideoToolboxDecode } from './video-decode';
// Playable camera conversion only. Originals, WB, looks and exposure are untouched.
import { promisify } from "node:util";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Clip, Shoot } from "../shared/schema";
import { clipRotation, clipRotationFilter, displayedClip } from "../shared/media";
import { cameraConversionFilter, readGradeMetadata } from "./grade";
import { tool, toolEnvironment } from "./tools";
import { currentActivity, restBetweenClips, threads, runActivity, withRenderSlot, listActivity, backgroundWorkWaiting } from "./activity";
import { governor } from "./resource-governor";
import { makeStandInStrips } from "./thumbnails";

export const PROXY_REV = 1;
type Stamp = { size: number; mtimeMs: number };
type Receipt = { proxyRev: number; source: string; sourceStamp: Stamp; proxyStamp: Stamp; conversion: string; conversionKey?: string; rotation?: number; pictureComplete?: boolean; pictureRevision?: number; health?: PreviewHealth; softwareCamera?: boolean; timing?: { totalMs: number; transcodeMs: number; verificationMs: number } };
const PICTURE_REVISION = 2;
const CAMERA_PROXY_CRF = 6;
const CAMERA_PROXY_QUALITY = 85;
const CAMERA_PROXY_ENCODING = `videotoolbox-quality-${CAMERA_PROXY_QUALITY}-rgb-turn`;
export type PreviewHealth = { state: 'healthy' | 'incomplete' | 'unchecked' | 'missing'; stale?: boolean; sourceFrames?: number; previewFrames?: number; expectedFrames?: number; sourceDurationS?: number; previewDurationS?: number };
const measuredHealth = new Map<string, PreviewHealth>();
export function previewHealth(root: string, clip: Clip): PreviewHealth {
  if (!clip.proxy) return { state: 'missing' };
  try {
    const file = proxyPath(root, clip);
    if (!fs.existsSync(file)) return { state: 'missing' };
    // A swapped source: the preview shows the old picture, so it is not a preview of this clip.
    if (previewSourceChanged(root, clip)) return { state: 'missing', stale: true };
    if (!current(root, clip)) return { state: 'unchecked' };
    const measured = measuredHealth.get(file);
    if (measured) return measured;
    const receipt = JSON.parse(fs.readFileSync(receiptPath(file), 'utf8')) as Receipt;
    return receipt.pictureRevision === PICTURE_REVISION && receipt.health ? receipt.health : { state: 'unchecked' };
  } catch { return { state: 'unchecked' }; }
}
export interface ProxyProgress { clipId: string; completed: number; total: number; error?: string }
export interface ProxyOptions {
  force?: boolean;
  priority?: readonly string[];
  onStart?: (total: number, pending: readonly Clip[]) => void;
  onProgress?: (progress: ProxyProgress) => void;
  onEncodeProgress?: (progress: ProxyProgress & { pct: number }) => void;
  onStatus?: (progress: PreviewRepairProgress) => void;
  /** ANA1: a new shoot's reading makes the stand-in strips after its first edits, not beside its transcripts. */
  deferStrips?: boolean;
}
export type PreviewRepairProgress = {
  phase: 'checking' | 'repairing' | 'done' | 'failed'; checked: number; checking: number;
  total: number; completed: number; failed: number; pending: number; active: string[];
  priorityIds: string[]; editPending: string[]; paused: boolean; etaS: number | null; editEtaS: number | null; elapsedS: number; workers: number;
};
type RepairState = { phase: PreviewRepairProgress['phase']; checking: number; checked: number; clips: Clip[];
  finished: Set<string>; failed: Set<string>; active: Map<string, number>; started: number; pausedMs: number; pausedAt?: number;
  notify?: ProxyOptions['onStatus'] };
const repairStates = new Map<string, RepairState>();
export function previewRepairProgress(root: string): PreviewRepairProgress | null {
  root = path.resolve(root);
  const s = repairStates.get(root);
  if (!s) return null;
  const paused = !!governor.playbackBusy || governor.busyUntil > Date.now() || !!governor.profile?.pauseBackground;
  const elapsedS = Math.max(0, ((s.pausedAt ?? Date.now()) - s.started - s.pausedMs) / 1000);
  const weight = (c: Clip) => Math.max(.1, c.meta?.durationS ?? 1);
  const total = s.clips.reduce((n, c) => n + weight(c), 0);
  const done = s.clips.reduce((n, c) => n + weight(c) * (s.finished.has(c.id) ? 1 : (s.active.get(c.id) ?? 0) / 100), 0);
  const ids = priorities.get(root) ?? [];
  const waitingForOtherShoot = priorityRoot !== root && previewTasks.some(t => t.root === priorityRoot);
  const editClips = s.clips.filter(c => ids.includes(c.id) && !s.finished.has(c.id));
  const editLeft = editClips.reduce((n, c) => n + weight(c) * (1 - (s.active.get(c.id) ?? 0) / 100), 0);
  const canEstimate = s.phase === 'repairing' && !paused && !waitingForOtherShoot && elapsedS >= 1 && done > 0;
  return { phase: s.phase, checked: s.checked, checking: s.checking, total: s.clips.length,
    completed: s.finished.size - s.failed.size, failed: s.failed.size, pending: s.clips.length - s.finished.size,
    active: [...s.active.keys()], priorityIds: [...ids], editPending: editClips.map(c => c.id),
    paused, etaS: s.phase === 'done' ? 0 : canEstimate ? Math.ceil(elapsedS * Math.max(0, total - done) / done) : null,
    editEtaS: canEstimate ? Math.ceil(elapsedS * editLeft / done) : null,
    elapsedS, workers: previewWorkers() };
}
function notifyRepair(root: string): void {
  const s = repairStates.get(root), progress = previewRepairProgress(root);
  if (s && progress) s.notify?.(progress);
}
governor.onChange?.(() => {
  wakePreviewWorkers();
  const paused = !!governor.playbackBusy || governor.busyUntil > Date.now() || !!governor.profile?.pauseBackground;
  for (const [root, s] of repairStates) {
    if (s.phase === 'done' || s.phase === 'failed') continue;
    if (paused && s.pausedAt === undefined) s.pausedAt = Date.now();
    else if (!paused && s.pausedAt !== undefined) { s.pausedMs += Date.now() - s.pausedAt; s.pausedAt = undefined; }
    notifyRepair(root);
  }
});
const stamp = (file: string): Stamp => {
  const { size, mtimeMs } = fs.statSync(file);
  return { size, mtimeMs };
};
const same = (a: Stamp, b: Stamp): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs;
const receiptPath = (file: string): string => `${file}.proxy.json`;
function proxyPath(root: string, clip: Clip): string {
  const dir = path.resolve(root, ".sidething/proxies");
  const file = path.resolve(dir, clip.proxy || `${clip.id}.mp4`);
  if (!file.startsWith(dir + path.sep) || file === path.resolve(root, clip.file)) throw new Error("Invalid preview cache path.");
  return file;
}
/** The original changed (size or time) since its preview was made. A missing original is not a change. */
export function previewSourceChanged(root: string, clip: Clip): boolean {
  if (!clip.proxy) return false;
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath(proxyPath(root, clip)), "utf8")) as Receipt;
    return receipt.source === clip.file && !same(receipt.sourceStamp, stamp(path.resolve(root, clip.file)));
  } catch { return false; }
}
function current(root: string, clip: Clip): boolean {
  try {
    if (!clip.proxy) return false;
    const file = proxyPath(root, clip);
    const receipt = JSON.parse(fs.readFileSync(receiptPath(file), "utf8")) as Receipt;
    return (receipt.rotation ?? 0) === clipRotation(clip) && receipt.proxyRev === PROXY_REV && receipt.source === clip.file &&
      same(receipt.sourceStamp, stamp(path.resolve(root, clip.file))) &&
      receipt.proxyStamp.size > 0 && same(receipt.proxyStamp, stamp(file));
  } catch { return false; }
}

// PS2: the sync check above cannot see the camera conversion (it needs the LUT builder). `conversion` in a
// receipt hashes the filter with the cache folder's path inside it, and on a healthy 12-clip shoot none of the
// old hashes matched a fresh one (measured), so enforcing them would remake every proxy on upgrade. New receipts
// also carry `conversionKey`, which ignores where the LUT lives; only those are compared. Older ones stay valid.
export const conversionKey = (filter: string, clip?: Clip): string =>
  createHash("sha256").update(filter.replace(/lut3d=file=(?:\\.|[^:])+/, m => `lut3d=file=${path.basename(m.replace(/\\(.)/g, "$1"))}`) + (clip && (clipRotation(clip) || clipRotationFilter(clip)) ? `:rotation=${clipRotation(clip)}:${clipRotationFilter(clip)}` : "")).digest("hex");
async function conversionCurrent(root: string, clip: Clip, cache: string): Promise<boolean> {
  try {
    const receipt = JSON.parse(await fs.promises.readFile(receiptPath(proxyPath(root, clip)), "utf8")) as Receipt;
    if (!receipt.pictureComplete || !canVideoToolboxDecode(clip.meta?.codec) && receipt.pictureRevision !== PICTURE_REVISION) {
      try { await completePicture(path.resolve(root, clip.file), proxyPath(root, clip), clip.meta?.fps ?? 25); }
      catch (error) { currentActivity()?.signal.throwIfAborted(); return false; }
      // Healthy legacy receipts are validated once, with their cache keys intact.
      if (current(root, clip)) {
        const receiptFile = receiptPath(proxyPath(root, clip)), temporary = `${receiptFile}.${randomUUID()}.tmp`;
        try { await fs.promises.writeFile(temporary, JSON.stringify({ ...receipt, pictureComplete: true, pictureRevision: PICTURE_REVISION, health: measuredHealth.get(proxyPath(root, clip)) })); await fs.promises.rename(temporary, receiptFile); }
        finally { await fs.promises.rm(temporary, { force: true }); }
      }
    }
    if (!receipt.conversionKey) return true;
    await readGradeMetadata(clip, root, cache);
    return receipt.conversionKey === conversionKey(await cameraConversionFilter(clip, cache), clip);
  } catch (error) { return !(error instanceof Error && error.message === "Preview picture is incomplete."); /* cannot tell: keep the proxy, never churn on a doubt */ }
}
/** PS2: new proxies take min(source fps, 60). Existing ones are left alone. */
export const PROXY_MAX_FPS = 60;
export const proxyFpsFilter = (fps: number | undefined): string => fps && fps > PROXY_MAX_FPS + .01 ? `fps=${PROXY_MAX_FPS},` : "";

// One bounded group owns the background render/decode lane. Work from a newly
// opened shoot can enter at the next clip boundary, without restarting readers.
const pending = new Map<string, Promise<number>>();
const priorities = new Map<string, string[]>();
let priorityRoot: string | undefined;
export function prioritizePreviews(root: string, ids: readonly string[]): void {
  root = path.resolve(root);
  priorityRoot = root;
  priorities.set(root, [...new Set(ids)]);
  notifyRepair(root);
  wakePreviewWorkers();
}
type PreviewTask = { root: string; clip: Clip; rank: number; work: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void };
const previewTasks: PreviewTask[] = [];
const runningPreviewTasks = new Set<PreviewTask>();
const previewWaiters = new Set<() => void>();
function wakePreviewWorkers(): void { for (const wake of [...previewWaiters]) wake(); }
function waitForPreviewWork(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = () => { previewWaiters.delete(wake); signal.removeEventListener('abort', abort); };
    const wake = () => { clean(); resolve(); };
    const abort = () => { clean(); reject(signal.reason); };
    previewWaiters.add(wake); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
let draining = false;
/** Six-clip M3 benchmark: 1x4 44.03 s, 2x4 30.62 s, 3x4 22.60 s.
 * These are workers inside one decode permit, not independent render lanes. */
export function previewWorkers(cores = governor.cores): number {
  return Math.min(3, Math.max(1, Math.floor((cores || 4) / 4)));
}
async function waitForPreviewPlayback(signal?: AbortSignal): Promise<void> {
  while (governor.busyUntil > Date.now()) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, 250);
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
function drainPreviewTasks(): void {
  if (draining || !previewTasks.length) return;
  draining = true;
  void runActivity({ kind: 'process', root: null, target: null, label: 'Preparing picture', cancelable: true }, async activity => {
    while (previewTasks.length) await withRenderSlot(activity, async () => {
      const release = await governor.acquireDecode(activity.signal);
      let yielding = false;
      try {
        await Promise.all(Array.from({ length: previewWorkers() }, () => (async () => {
          while (previewTasks.length) {
            await waitForPreviewPlayback(activity.signal);
            await restBetweenClips(activity.signal);
            await governor.whenMemoryAllows(activity.signal);
            // Music and other draft dependencies share this lane. Let their
            // producer run before taking another clip, without killing readers.
            if (yielding || backgroundWorkWaiting?.()) { yielding = true; return; }
            // Keep one job at serious heat; idle workers return when it cools.
            if (governor.profile?.pauseBackground || governor.profile?.name === 'serious' && runningPreviewTasks.size >= 1) {
              await waitForPreviewWork(activity.signal); continue;
            }
            previewTasks.sort((a, b) => {
              const rootOrder = Number(b.root === priorityRoot) - Number(a.root === priorityRoot);
              if (rootOrder) return rootOrder;
              const rank = (task: PreviewTask) => {
                const ids = priorities.get(task.root) ?? [], i = ids.indexOf(task.clip.id);
                return i >= 0 ? i - ids.length - 3 : task.rank;
              };
              // ANA1: same rank, longest work first (a 4K software decode costs about three times a hardware one), so
              // the slowest clip never starts last and holds the lane alone at the end.
              return rank(a) - rank(b) || previewCost(b.clip) - previewCost(a.clip);
            });
            const next = previewTasks[0];
            if (!next) return;
            const requested = (task: PreviewTask) => task.root === priorityRoot && (priorities.get(task.root) ?? []).includes(task.clip.id);
            // Idle capacity is kept for the edit until its last in-flight clip
            // is healthy. Lower-priority work must not slow that long tail.
            if (!requested(next) && [...runningPreviewTasks].some(requested)) {
              await waitForPreviewWork(activity.signal); continue;
            }
            const task = previewTasks.shift();
            if (!task) return;
            runningPreviewTasks.add(task);
            try { await task.work(); task.resolve(); } catch (error) { task.reject(error); }
            finally { runningPreviewTasks.delete(task); wakePreviewWorkers(); }
          }
        })()));
      } finally { release(); }
    }, 'background');
  }, { renderLane: 'background' })
    .catch(error => { for (const task of previewTasks.splice(0)) task.reject(error); })
    .finally(() => { draining = false; drainPreviewTasks(); });
}
const previewCost = (clip: Clip): number => (clip.meta?.durationS ?? 1) * (canVideoToolboxDecode(clip.meta?.codec) ? 1 : 3);
function previewTask(root: string, clip: Clip, rank: number, work: () => Promise<void>): Promise<void> {
  const result = new Promise<void>((resolve, reject) => previewTasks.push({ root, clip, rank, work, resolve, reject }));
  wakePreviewWorkers();
  drainPreviewTasks();
  return result;
}
export function previewRank(clip: Clip, shoot: Shoot, priority: readonly string[], picked: ReadonlySet<string> = new Set()): number {
  const requested = priority.indexOf(clip.id);
  if (requested >= 0) return requested - priority.length - 2;
  if (picked.has(clip.id)) return -1;
  if (clip.judgement?.verdict === "unusable" || clip.judgement?.junk) return 2;
  return clip.judgement?.verdict === "best" || clip.judgement?.verdict === "alt" ? 0 : 1;
}
export async function pickedPreviewIds(shoot: Shoot): Promise<Set<string>> {
  try {
    const ideas = JSON.parse(fs.readFileSync(path.join(shoot.root, ".sidething/sidekick/thread.json"), "utf8"))
      .flatMap((m: { ideas?: { pick?: boolean; passed?: boolean; uses: string[] }[] }) => m.ideas ?? []);
    const uses = new Set<string>(ideas.filter((i: { pick?: boolean; passed?: boolean }) => i.pick && !i.passed).flatMap((i: { uses: string[] }) => i.uses));
    if (!uses.size) return new Set();
    const { reelIds } = await import("./reel");
    const catalog = reelIds(shoot);
    return new Set([...uses].flatMap(id => [catalog.voice.get(id)?.clip.id ?? catalog.broll.get(id)?.clip.id ?? id]));
  } catch { return new Set(); }
}
function writeVisualSession(root: string, ids: readonly string[]): void {
  const marker = path.join(root, ".sidething/visual/session.json"), temporary = `${marker}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, pending: ids })); fs.renameSync(temporary, marker); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function prepareVisualSession(root: string): void {
  const shoot = JSON.parse(fs.readFileSync(path.join(root, ".sidething/index.json"), "utf8")) as Shoot;
  const dir = path.join(root, ".sidething/visual");
  fs.mkdirSync(dir, { recursive: true });
  writeVisualSession(root, shoot.clips.filter(c => c.meta && !(c as Clip & { _metaNeedsRefresh?: boolean })._metaNeedsRefresh && c.stage !== "error").map(c => c.id));
}
export function makeShootProxies(root: string, options: ProxyOptions = {}): Promise<number> {
  root = path.resolve(root);
  if (options.priority) prioritizePreviews(root, options.priority);
  const existing = pending.get(root);
  if (existing) return existing;
  const job = makeProxies(root, options);
  pending.set(root, job);
  void job.finally(() => {
    pending.delete(root);
    const marker = path.join(root, ".sidething/visual/session.json");
    if (fs.existsSync(marker)) writeVisualSession(root, []);
  }).catch(() => {});
  void job.catch(() => { const s = repairStates.get(root); if (s) { s.phase = 'failed'; notifyRepair(root); } });
  return job;
}

function encode(args: string[], durationS: number, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // activity.ts's AA4 spawn subscriber applies priority 10, also on fallback.
    const child = spawn(tool("ffmpeg"), ["-progress", "pipe:1", "-nostats", ...args], { env: toolEnvironment(), signal: currentActivity()?.signal, stdio: ["ignore", "pipe", "pipe"] });
    let diskError: Error | undefined;
    if (child.stdout) createInterface({ input: child.stdout }).on("line", line => {
      const [key, value] = line.split("=");
      let seconds = NaN;
      if (key === "out_time_us" || key === "out_time_ms") seconds = Number(value) / 1_000_000;
      else if (key === "out_time" && /^\d+:\d+:\d+(?:\.\d+)?$/.test(value)) {
        const [h, m, s] = value.split(":").map(Number);
        seconds = h * 3600 + m * 60 + s;
      }
      // Reserve completion for the atomic file/index/receipt commit.
      if (Number.isFinite(seconds) && durationS > 0) {
        const output = args.find(a => a.endsWith('.tmp.mp4'));
        if (output && !diskError) {
          const disk = fs.statfsSync(path.dirname(output));
          if (disk.bavail * disk.bsize < 15.5e9) {
            diskError = new Error('Free up some space to finish these previews.');
            child.kill('SIGTERM');
          }
        }
        onProgress(Math.max(0, Math.min(99, seconds / durationS * 100)));
      }
    });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-6000); });
    child.once("error", reject);
    child.once("close", code => diskError ? reject(diskError) : code === 0 ? resolve() : reject(new Error(`Could not encode preview (${code}): ${stderr}`)));
  });
}


// ANA1: the camera conversion is a 16-bit RGB round trip through a cube. When that cube is the identity (Rec.709
// sources), the same picture is one YUV resize. Returns the scale input options, or null to keep the cube.
const identityCubes = new Map<string, Promise<boolean>>();
export async function identityConversion(conversion: string): Promise<string | null> {
  const m = /^scale=(in_color_matrix=bt709(?::in_range=(?:full|tv))?):out_range=full,format=gbrp16le,lut3d=file=((?:\\.|[^:])+):interp=tetrahedral,format=gbrp16le$/.exec(conversion);
  if (!m) return null;
  const file = m[2].replace(/\\(.)/g, "$1").replace(/\\(.)/g, "$1");
  let known = identityCubes.get(file);
  if (!known) {
    known = fs.promises.readFile(file, "utf8").then(text => {
      const size = Number(/^LUT_3D_SIZE\s+(\d+)/m.exec(text)?.[1]);
      const rows = text.split("\n").filter(line => /^[-\d.]/.test(line.trim())).map(line => line.trim().split(/\s+/).map(Number));
      if (!(size > 1) || rows.length !== size ** 3 || /DOMAIN_MIN\s+(?!0 0 0)|DOMAIN_MAX\s+(?!1 1 1)/.test(text)) return false;
      let i = 0;
      for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++, i++) {
        const [x, y, z] = rows[i];
        if (Math.abs(x - r / (size - 1)) > 7e-6 || Math.abs(y - g / (size - 1)) > 7e-6 || Math.abs(z - b / (size - 1)) > 7e-6) return false;
      }
      return true;
    }).catch(() => false);
    identityCubes.set(file, known);
  }
  return await known ? m[1] : null;
}

// A successful VideoToolbox exit can still leave a truncated video track (1006
// had 96/120 frames while its audio/container still said 4.8s). Recover through
// software before publishing that preview or passing it to Vision.
const pictureFacts = new Map<string, Promise<{ frames: number; duration: number; fullRange: boolean }>>();
export async function completePicture(source: string, preview: string, fps: number): Promise<boolean> {
  const facts = async (file: string) => {
    const key = JSON.stringify([file, stamp(file)]);
    const existing = pictureFacts.get(key);
    if (existing) return existing;
    const work = (async () => {
    const read = async (count = false) => {
      const { stdout } = await promisify(execFile)(tool("ffprobe"), ["-v", "error", ...(count ? ['-threads', String(threads(4)), '-count_frames'] : []), "-select_streams", "v:0", "-show_entries", "stream=duration,nb_frames,nb_read_frames,color_range", "-of", "json", file], { env: toolEnvironment(), signal: currentActivity()?.signal });
      return JSON.parse(stdout).streams?.[0];
    };
    let info = await read();
    if (!(Number(info?.nb_frames) > 0)) info = await read(true);
    const frames = Number(info?.nb_read_frames ?? info?.nb_frames), duration = Number(info?.duration);
    if (!(frames > 0) || !(duration > 0)) throw new Error('Could not verify preview picture.');
    return { frames, duration, fullRange: info.color_range === 'pc' };
    })();
    pictureFacts.set(key, work);
    if (pictureFacts.size > 1024) pictureFacts.delete(pictureFacts.keys().next().value!);
    void work.catch(() => { pictureFacts.delete(key); });
    return work;
  };
  const [a, b] = await Promise.all([facts(source), facts(preview)]);
  const converted = fps > PROXY_MAX_FPS + .01;
  const expected = converted ? Math.round(a.duration * PROXY_MAX_FPS) : a.frames;
  const healthy = Math.abs(b.frames - expected) <= (converted ? 1 : 0) && Math.abs(a.duration - b.duration) <= 1 / Math.min(fps || 25, PROXY_MAX_FPS) + .005;
  measuredHealth.set(preview, { state: healthy ? 'healthy' : 'incomplete', sourceFrames: a.frames, previewFrames: b.frames, expectedFrames: expected, sourceDurationS: a.duration, previewDurationS: b.duration });
  if (!healthy) throw new Error("Preview picture is incomplete.");
  return a.fullRange;
}

// Read the latest index at the commit boundary; never save the stale snapshot
// held during a long encode over someone's transcript, tags or take choices.
function recordProxy(root: string, clip: Clip, sourceStamp: Stamp, file: string): void {
  const index = path.join(root, ".sidething/index.json");
  const shoot = JSON.parse(fs.readFileSync(index, "utf8")) as Shoot;
  const live = shoot.clips.find(c => c.id === clip.id && c.file === clip.file);
  if (!live || clipRotation(live) !== clipRotation(clip) || !same(sourceStamp, stamp(path.resolve(root, clip.file)))) throw new Error("Clip changed while making its preview. Try again.");
  live.meta = displayedClip(live).meta;
  live.proxy = path.relative(path.join(root, ".sidething/proxies"), file);
  shoot.updatedAt = new Date().toISOString();
  const temp = `${index}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(shoot, null, 1)); fs.renameSync(temp, index); }
  finally { fs.rmSync(temp, { force: true }); }
}

// Another writer may have saved the index from an older snapshot and dropped a
// preview link. A valid receipt on disk is enough to restore it without encoding.
export function relinkProxies(root: string): number {
  const index = path.join(root, ".sidething/index.json");
  const shoot = JSON.parse(fs.readFileSync(index, "utf8")) as Shoot;
  let linked = 0;
  for (const clip of shoot.clips) {
    if (clip.proxy || !clip.meta) continue;
    try {
      const file = proxyPath(root, clip);
      if (!fs.existsSync(file) || !current(root, { ...clip, proxy: path.basename(file) })) continue;
      recordProxy(root, clip, stamp(path.resolve(root, clip.file)), file);
      linked++;
    } catch { /* no usable preview: it is made on the next pass */ }
  }
  return linked;
}

async function makeProxies(root: string, options: ProxyOptions): Promise<number> {
  const index = path.join(root, ".sidething/index.json");
  relinkProxies(root);
  const shoot = JSON.parse(await fs.promises.readFile(index, "utf8")) as Shoot;
  const cache = path.join(root, ".sidething/finish-cache");
  await fs.promises.mkdir(cache, { recursive: true });
  const clips: Clip[] = [];
  const visualDir = path.join(root, ".sidething/visual");
  fs.mkdirSync(visualDir, { recursive: true });
  const picked = await pickedPreviewIds(shoot);
  const activeEdits = new Set((await listActivity()).filter(a => a.root === root && a.state === 'running'
    && (a.kind === 'cut' || a.kind === 'edit')).flatMap(a => a.target?.cutId ? [a.target.cutId] : []));
  const editIds: string[] = [];
  try {
    const cuts = path.join(root, '.sidething/sidekick/cuts');
    for (const name of activeEdits.size ? fs.readdirSync(cuts).filter(n => activeEdits.has(path.basename(n, '.json'))) : []) {
      const cut = JSON.parse(fs.readFileSync(path.join(cuts, name), 'utf8'));
      // at(-1) stays: a proxy priority hint for an edit being made; nothing is written to the edit.
      editIds.push(...(cut.versions?.at(-1)?.pieces ?? []).flatMap((p: { clipId?: string }) => p.clipId ? [p.clipId] : []));
    }
  } catch { /* a draft may still be saving */ }
  if (editIds.length && !priorities.has(root)) priorities.set(root, [...new Set(editIds)]);
  const baseRank = (c: Clip) => previewRank(c, shoot, [], picked);
  const eligible = shoot.clips.filter(c => {
    // Retained geometry is for existing readers, not permission to decode a
    // replacement before its probe (and a photo's still conversion) finishes.
    if (!c.meta || (c as Clip & { _metaNeedsRefresh?: boolean })._metaNeedsRefresh || c.stage === "error" || !fs.existsSync(path.resolve(root, c.file))) return false;
    const request = path.join(root, ".sidething/add-files.json");
    // An add reads only its files, but a clip an edit is waiting on (a swapped source) always comes first.
    return !fs.existsSync(request) || (priorities.get(root) ?? []).includes(c.id) || (JSON.parse(fs.readFileSync(request, "utf8")) as string[]).includes(c.photo?.file ?? c.file);
  });
  // Unverified unsafe receipts are real outstanding work even if their old URL
  // remains playable. Supported healthy caches keep their silent re-open.
  clips.push(...eligible.filter(c => options.force || !current(root, c)
    || !canVideoToolboxDecode(c.meta?.codec) && previewHealth(root, c).state !== 'healthy'));
  const goalIds = new Set(clips.map(c => c.id));
  const repairState: RepairState = { phase: 'checking', checking: eligible.length, checked: 0, clips, finished: new Set(), failed: new Set(), active: new Map(), started: Date.now(), pausedMs: 0, notify: options.onStatus };
  repairStates.set(root, repairState);
  // Retain a small diagnostic history, never an unbounded shoot library.
  for (const [oldRoot, state] of repairStates) {
    if (repairStates.size <= 32) break;
    if (state.phase === 'done' || state.phase === 'failed') repairStates.delete(oldRoot);
  }
  notifyRepair(root);
  // PS2: stand-in strips follow the proxies, quietly, in the background lane.
  const strips = () => { void makeStandInStrips(root).catch(() => {}); };
  const remaining = new Set(clips.map(c => c.id));
  const session = () => writeVisualSession(root, [...remaining]);
  session();
  let announced = false;
  const announce = () => {
    if (!announced && clips.length) {
      announced = true; options.onStart?.(clips.length, clips);
      repairState.phase = 'repairing'; repairState.started = Date.now();
    }
    notifyRepair(root);
  };
  announce();
  let completed = 0, made = 0;
  const failures: string[] = [];
  const repairClip = async (clip: Clip) => {
    const began = Date.now();
    let transcodeMs = 0, verificationMs = 0;
    let pct = 0;
    const report = (value: number) => {
      if (value <= pct) return;
      pct = value;
      options.onEncodeProgress?.({ clipId: clip.id, completed, total: clips.length, pct });
      repairState.active.set(clip.id, pct); notifyRepair(root);
    };
    options.onEncodeProgress?.({ clipId: clip.id, completed, total: clips.length, pct: 0 });
    repairState.active.set(clip.id, 0); notifyRepair(root);
    let error: string | undefined;
    let temp: string | undefined;
    let visualWork: string | undefined;
    let fullRange = false;
    try {
      const source = path.resolve(root, clip.file), sourceStamp = stamp(source);
      await readGradeMetadata(clip, root, cache);
      const conversion = await cameraConversionFilter(clip, cache);
      // A repaired camera preview gets its own immutable URL. Existing readers
      // retain the old inode until the new decoder is ready, including ranges.
      const repair = !canVideoToolboxDecode(clip.meta?.codec);
      const file = proxyPath(root, { ...clip, proxy: repair || clipRotation(clip) || /\.r\d+-/.test(clip.proxy ?? "")
        ? `${clip.id}.r${clipRotation(clip)}-${createHash("sha256").update(JSON.stringify([sourceStamp, conversionKey(conversion, clip), ...(repair ? [PICTURE_REVISION, CAMERA_PROXY_ENCODING] : [])])).digest("hex").slice(0, 12)}.mp4` : clip.proxy });
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const candidate = { ...clip, proxy: path.basename(file) };
      if (!options.force && file !== proxyPath(root, clip) && current(root, candidate) && await conversionCurrent(root, candidate, cache)) {
        recordProxy(root, clip, sourceStamp, file);
        remaining.delete(clip.id); session();
        completed++;
        made++;
        options.onProgress?.({ clipId: clip.id, completed, total: clips.length });
        repairState.active.delete(clip.id); repairState.finished.add(clip.id); notifyRepair(root);
        return;
      }
      // Preserve aspect and timing. Even dimensions are required by 4:2:0;
      // floor (rather than round) also prevents upscaling odd small sources.
      const scale = "scale=w='max(2,trunc(iw*min(1,1080/min(iw,ih))/2)*2)':h='max(2,trunc(ih*min(1,1080/min(iw,ih))/2)*2)':out_color_matrix=bt709:out_range=tv";
      // LUT/RGB filters can clear frame colour properties. Set them explicitly
      // as well as the encoder flags, so both bitstream and container are 709.
      // Shrink before the camera LUT: a quarter of the pixels for 4K, measured
      // 37 s -> 5 s per 10 s of 4K S-Log3 at 4 threads, PSNR 49 dB vs LUT-first.
      const size = "w='max(2,trunc(iw*min(1,1080/min(iw,ih))/2)*2)':h='max(2,trunc(ih*min(1,1080/min(iw,ih))/2)*2)':flags=bicubic";
      const shrunk = conversion.startsWith("scale=") ? `scale=${size}:${conversion.slice(6)}` : `scale=${size},${conversion}`;
      const wantsVisual = clip.shake == null || (clip.frames?.length ?? 0) < 8
        || clip.stage !== 'done' && (clip as Clip & { _framesRotation?: number })._framesRotation !== clipRotation(clip);
      // Resize/convert the coded raster first and turn the small picture after: a 4K transpose is one
      // serial filter thread (ANA1: a 16 s vertical Sony clip 50 s -> 11 s wall, 73 -> 49 CPU-s; previews
      // within 0.4/255, shake spans and chosen stills unchanged). Shake and stills turn after their own scale.
      const turnAll = clipRotationFilter({ ...clip, meta: { ...clip.meta!, containerRotation: 0 } });
      const lateTurn = !!turnAll || !!((clip.meta?.containerRotation ?? 0) % 360);  // the container's turn is never applied twice
      const turnPicture = turnAll;
      // ANA1: an identity camera cube (Rec.709 sources) is one YUV resize, not a 16-bit RGB round trip.
      const direct = await identityConversion(conversion);
      const picture = direct === null ? `${shrunk},${turnPicture}${scale},format=yuv420p` : `scale=${size}:${direct}:out_color_matrix=bt709:out_range=tv,format=yuv420p,${turnPicture.replace(/,$/, '')}`;
      const vf = `${proxyFpsFilter(clip.meta?.fps)}${picture.replace(/,$/, '')},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`;
      temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp.mp4`);
      // The 62 s Sony sample measured 34.15 s at four filter/decode threads,
      // 23.19 s at eight. Short clips gain little from the wider thread pool.
      const wantedThreads = repair && !wantsVisual && (governor.cores ?? 0) >= 12 && clip.meta!.durationS >= 30 ? 8 : 4;
      const workerThreads = Math.min(wantedThreads, threads(wantedThreads * 2));
      const base = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-threads", String(workerThreads), "-filter_threads", String(workerThreads)];
      const sound = await sourceAudio(source);
      const disk = await fs.promises.statfs(visualDir);
      const rawBytes = wantsVisual ? clip.meta!.durationS * (Math.max(120, clip.meta!.fps || 25) * 320 * 180 + 1_000_000) : 0;
      if (disk.bavail * disk.bsize - rawBytes < 15e9) throw new Error("Free up some disk space before preparing these shots.");
      visualWork = await fs.promises.mkdtemp(path.join(visualDir, "decode-"));
      const rate = Math.max(2, 9 / Math.max(.001, clip.meta!.durationS));
      const lift = /log/i.test(clip.meta?.pictureProfile ?? "") ? ",eq=contrast=1.35:saturation=1.4:gamma=0.85" : "";
      // Shake and stills are measured on the same pixels as before. Shake turns the full picture and then scales it, as
      // the decoder's own turn did (a full-range 10-bit camera turns only its luma plane: bit-identical, measured, and
      // without the 4:2:2 repack). Stills turn only the two chosen pictures a second.
      // The decoder's turn was the container's only (a person's turn never reached shake), exactly as ffmpeg inserts it.
      const containerTurn = ({ 90: "transpose=clock,", 180: "hflip,vflip,", 270: "transpose=cclock," } as Record<number, string>)[((clip.meta?.containerRotation ?? 0) % 360 + 360) % 360] ?? "";
      const lumaOnly = repair && /in_range=full/.test(conversion);
      const graph = `[0:v:0]split=3[p][s][f];[p]${vf}[preview];[s]${containerTurn && lumaOnly ? 'extractplanes=y,' : ''}${containerTurn}scale=320:180,format=gray[shake];[f]select='gte(t*${rate}\\,selected_n)',${turnAll}scale=480:-2${lift}[frames]`;  // BUG2: keep each picture's own time (pipeline/smart_frames.py)
      const input = [...(lateTurn ? ['-noautorotate', '-display_rotation', '0'] : []), "-i", source, ...(wantsVisual ? ["-filter_complex_threads", String(threads(4)), "-filter_complex", graph, "-map", "[preview]"] : ["-map", "0:v:0", "-vf", vf]), ...(sound ? ["-map", `0:${sound.index}`] : ["-an"]), "-map_metadata", "-1", "-fps_mode", "passthrough"];
      const output = ["-pix_fmt", "yuv420p", "-g", "12", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", temp,
        ...(wantsVisual ? ["-map", "[shake]", "-an", "-c:v", "rawvideo", "-pix_fmt", "gray", "-f", "rawvideo", path.join(visualWork, "shake.gray"),
        "-map", "[frames]", "-an", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-frame_pts", "1", "-q:v", "3", path.join(visualWork, "%012d.jpg")] : [])];
      // All workers share the group's background lane and decode permit.
      {
        const activity = currentActivity();
        const verifiedEncode = async (args: string[]) => {
          const encoding = Date.now();
          try { await encode(args, clip.meta!.durationS, report); }
          finally { transcodeMs += Date.now() - encoding; }
          const checking = Date.now();
          try { fullRange = await completePicture(source, temp!, clip.meta!.fps); }
          finally { verificationMs += Date.now() - checking; }
        };
          const software = [...base, ...input, "-c:v", "libx264", "-preset", repair ? "veryfast" : "medium", "-crf", repair ? String(CAMERA_PROXY_CRF) : "20", "-threads", String(threads(4)), "-keyint_min", "12", "-sc_threshold", "0", ...output];
          try {
            await verifiedEncode([...base, ...(!repair ? ["-hwaccel", "videotoolbox"] : []), ...input, "-c:v", "h264_videotoolbox",
              ...(repair ? ["-q:v", String(CAMERA_PROXY_QUALITY), "-allow_sw", "0"] : ["-b:v", "6M"]), ...output]);
          } catch (error) {
            activity?.signal.throwIfAborted();
            if (error instanceof Error && error.message === 'Free up some space to finish these previews.') throw error;
            // If hardware decoding itself is unavailable, software must recover too.
            await verifiedEncode(software);
          }
      }
      if (!stamp(temp).size || !same(sourceStamp, stamp(source))) throw new Error("Source changed or preview is empty. Try again.");
      if (wantsVisual) {
        const candidates = (await fs.promises.readdir(visualWork)).filter(f => /\.jpg$/.test(f)).sort().map(f => ({ t: Number(f.slice(0, -4)) / 1e6, path: path.join(visualWork!, f) }));
        const manifest = path.join(visualDir, `${clip.id}.json`), manifestTemp = `${manifest}.${randomUUID()}.tmp`;
        await fs.promises.writeFile(manifestTemp, JSON.stringify({ source: clip.file, sourceStamp, rotation: clipRotation(clip), fullRange, gray: path.join(visualWork, "shake.gray"), candidates }));
        await fs.promises.rename(manifestTemp, manifest);
        visualWork = undefined; // reader owns these derived files after publication
      }
      // Only complete encodes replace a playable old file. A receipt includes
      // the output stamp so an interrupted file/receipt commit is retried.
      await fs.promises.rename(temp, file);
      measuredHealth.set(file, measuredHealth.get(temp)!); measuredHealth.delete(temp);
      const receipt: Receipt = { proxyRev: PROXY_REV, source: clip.file, sourceStamp, proxyStamp: stamp(file),
        conversion: createHash("sha256").update(conversion).digest("hex"), conversionKey: conversionKey(conversion, clip), rotation: clipRotation(clip), pictureComplete: true, pictureRevision: PICTURE_REVISION, health: measuredHealth.get(file), ...(repair ? { softwareCamera: true } : {}), timing: { totalMs: Date.now() - began, transcodeMs, verificationMs } };
      const receiptTemp = `${receiptPath(file)}.${randomUUID()}.tmp`;
      try { await fs.promises.writeFile(receiptTemp, JSON.stringify(receipt)); await fs.promises.rename(receiptTemp, receiptPath(file)); }
      finally { await fs.promises.rm(receiptTemp, { force: true }); }
      // Index watchers must never see an unsafe replacement before its healthy
      // receipt exists, even when playback is already using the previous URL.
      recordProxy(root, clip, sourceStamp, file);
      made++;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      failures.push(`${clip.id}: ${error}`);
    } finally {
      if (temp) { measuredHealth.delete(temp); await fs.promises.rm(temp, { force: true }); }
      if (visualWork) await fs.promises.rm(visualWork, { recursive: true, force: true });
      remaining.delete(clip.id); session();
    }
    completed++;
    options.onProgress?.({ clipId: clip.id, completed, total: clips.length, ...(error ? { error } : {}) });
    repairState.active.delete(clip.id); repairState.finished.add(clip.id); if (error) repairState.failed.add(clip.id); notifyRepair(root);
  };
  // Check and repair each requested clip in the same task. No edit waits for
  // unrelated shoot receipts to finish scanning before its first encode.
  await Promise.all(eligible.map(clip => previewTask(root, clip, baseRank(clip), async () => {
    const needsRepair = options.force || !current(root, clip) || !(await conversionCurrent(root, clip, cache));
    repairState.checked++;
    if (needsRepair) {
      if (!goalIds.has(clip.id)) { goalIds.add(clip.id); clips.push(clip); remaining.add(clip.id); session(); }
      announce();
      await repairClip(clip);
    } else if (goalIds.has(clip.id)) {
      remaining.delete(clip.id); session();
      completed++; repairState.finished.add(clip.id);
      options.onProgress?.({ clipId: clip.id, completed, total: clips.length });
    }
    notifyRepair(root);
  })));
  if (!options.deferStrips) strips();
  repairState.phase = failures.length ? 'failed' : 'done'; notifyRepair(root);
  if (failures.length) throw new Error(`Could not make ${failures.length} preview(s). ${failures.join("\n")}`);
  return made;
}
