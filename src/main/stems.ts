// V23a: shared local engine, deliberately no edit mutation or automatic install.
import { app } from "electron";
import * as fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { totalmem } from "node:os";
import type { ExtensionInfo } from "../shared/schema";
import { readExtension } from "./extensions";
import { runActivity, withRenderSlot, type ActivityHandle } from "./activity";
import { availableMemoryShare, governor } from "./resource-governor";
import { tool, toolEnvironment } from "./tools";

export const STEMS_MODEL_VERSION = "htdemucs-mlx-1.6.1-df-0.5.6-v1-stream2";
export const STEMS_EXTENSION_ID = "sound-separation";
export type StemsSpan = { s: number; e: number };
export type StemsFiles = { vocals: string; drums: string; bass: string; other: string };
export type StemsInstallRequired = { status: "install_required"; extension: ExtensionInfo };
export type StemsResult = StemsFiles & { status: "ready"; key: string; cached: boolean; modelVersion: string };
export type VoiceIsolationResult = { status: "ready"; voice: string; key: string; cached: boolean; modelVersion: string };
type Mode = "stems" | "voice";
type Options = { root?: string; signal?: AbortSignal };
type Receipt = { key: string; modelVersion: string; mode: Mode; span: StemsSpan | null; sourceHash: string; durationS: number; files: Record<string, { hash: string; bytes: number }> };
type Command = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; progress?: (value: { completed: number; total: number; etaS?: number }) => void };

// Kill only our own detached process group and wait for close before deleting
// staging. Python's denoiser child inherits the group, including during pause.
export async function runStemsCommand(input: Command): Promise<string> {
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", pending = "", launchError: Error | undefined;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } };
    input.signal.addEventListener("abort", kill, { once: true });
    child.once("spawn", () => { if (input.signal.aborted) kill(); });
    child.stdout.on("data", chunk => {
      output = (output + chunk).slice(-65536);
      pending = (pending + chunk).slice(-65536);
      const lines = pending.split("\n"); pending = lines.pop()!;
      for (const line of lines) {
        try { const p = JSON.parse(line); if (Number.isFinite(p.completed) && Number.isFinite(p.total) && p.completed >= 0 && p.total > 0) input.progress?.(p); } catch { /* Other stdout is never UI copy. */ }
      }
    });
    child.stderr.on("data", () => { /* Drain diagnostics; never expose source names or Python traces. */ });
    child.once("error", error => { launchError = error; });
    child.once("close", code => {
      input.signal.removeEventListener("abort", kill);
      if (input.signal.aborted) reject(input.signal.reason);
      else if (launchError || code !== 0) reject(new Error("Could not separate this sound. Try again or reinstall Sound separation."));
      else resolve(output);
    });
    if (input.signal.aborted) kill();
  });
}

async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  signal?.throwIfAborted();
  return hash.digest("hex");
}
async function noLink(file: string): Promise<void> {
  try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("The sound cache cannot be a link."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function inside(root: string, file: string): boolean { const relative = path.relative(root, file); return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function validSpan(span?: StemsSpan): void {
  if (span && (!Number.isFinite(span.s) || !Number.isFinite(span.e) || span.s < 0 || span.e <= span.s)) throw new Error("Choose a valid sound span.");
}
async function waitForPrevious(previous: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal!.reason);
    signal?.addEventListener("abort", abort, { once: true });
    previous.catch(() => {}).then(() => { signal?.removeEventListener("abort", abort); resolve(); });
  });
}
async function sourceRoot(file: string, userData: string, requested?: string): Promise<string | null> {
  if (requested) {
    const root = await fs.realpath(requested);
    if (!inside(root, file)) throw new Error("This sound is outside the shoot.");
    await noLink(path.join(root, ".sidething"));
    if (!(await fs.stat(path.join(root, ".sidething"))).isDirectory()) throw new Error("Choose a shoot first.");
    return root;
  }
  // Catalogued music is always in userData, even if kept inside another shoot.
  let tracks: string[] = [];
  try { tracks = JSON.parse(await fs.readFile(path.join(userData, "music-tracks.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const track of tracks) if (await fs.realpath(track).catch(() => null) === file) return null;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const state = path.join(dir, ".sidething");
    if (await fs.stat(path.join(state, "index.json")).then(s => s.isFile(), () => false)) { await noLink(state); return dir; }
    if (path.dirname(dir) === dir) break;
  }
  throw new Error("Choose sound from a shoot or your music library.");
}

export function createStemsEngine(deps: {
  userData: string; extension?: () => Promise<ExtensionInfo>; command?: typeof runStemsCommand;
  activity?: typeof runActivity; slot?: typeof withRenderSlot; rootFor?: typeof sourceRoot;
  memoryShare?: () => number; modelVersion?: string; helper?: string;
}) {
  const userData = path.resolve(deps.userData), addon = path.join(userData, "extensions", STEMS_EXTENSION_ID);
  const modelVersion = deps.modelVersion ?? STEMS_MODEL_VERSION;
  const extension = deps.extension ?? (() => readExtension(STEMS_EXTENSION_ID, userData));
  const command = deps.command ?? runStemsCommand;
  const pending = new Map<string, Promise<unknown>>();
  const jobs = new Map<string, { key: string; root: string | null; mode: Mode }>();
  const digests = new Map<string, { stamp: string; hash: string }>();
  async function digest(file: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    // Content keys remain SHA-256. Reuse the digest only while the OS's inode,
    // length and nanosecond modification/change stamps prove no write occurred.
    // ctime also invalidates a write followed by restoring the old mtime.
    const stampOf = async () => { const s = await fs.stat(file, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":"); };
    const stamp = await stampOf(), hit = digests.get(file);
    if (hit?.stamp === stamp) return hit.hash;
    const hash = await hashFile(file, signal);
    if (await stampOf() !== stamp) throw new Error("The source sound changed. Try again.");
    digests.delete(file); digests.set(file, { stamp, hash });
    if (digests.size > 256) digests.delete(digests.keys().next().value!);
    return hash;
  }
  const baseFor = (root: string | null) => root ? path.join(root, ".sidething/stems") : path.join(userData, "stems");
  function outputs(folder: string, mode: Mode): Record<string, string> {
    return Object.fromEntries((mode === "stems" ? ["vocals", "drums", "bass", "other"] : ["voice"]).map(name => [name, path.join(folder, `${name}.wav`)]));
  }
  async function receipt(folder: string, key: string, mode: Mode, signal?: AbortSignal): Promise<Receipt | null> {
    try {
      await noLink(folder); await noLink(path.join(folder, "result.json"));
      const record: Receipt = JSON.parse(await fs.readFile(path.join(folder, "result.json"), "utf8"));
      if (record.key !== key || record.modelVersion !== modelVersion || record.mode !== mode || !record.files) return null;
      for (const [name, file] of Object.entries(outputs(folder, mode))) {
        await noLink(file);
        if ((await fs.stat(file)).size !== record.files[name]?.bytes || await digest(file, signal) !== record.files[name]?.hash) return null;
      }
      return record;
    } catch (error) { signal?.throwIfAborted(); if ((error as Error).message === "The sound cache cannot be a link.") throw error; return null; }
  }
  async function prepareBase(root: string | null): Promise<string> {
    const parent = root ? path.join(root, ".sidething") : userData;
    await noLink(parent);
    const base = baseFor(root); await noLink(base); await fs.mkdir(base, { recursive: true }); return base;
  }
  async function run(file: string, mode: Mode, span?: StemsSpan, options: Options = {}) {
    validSpan(span); options.signal?.throwIfAborted();
    const source = await fs.realpath(file);
    if (!(await fs.stat(source)).isFile()) throw new Error("Choose a sound file.");
    const root = await (deps.rootFor ?? sourceRoot)(source, userData, options.root);
    const info = await extension();
    if (info.state !== "installed") return { status: "install_required" as const, extension: info };
    return (deps.activity ?? runActivity)({ kind: "render", root, target: null, label: mode === "stems" ? "Separating music" : "Cleaning sound", cancelable: true }, async activity => {
      const signal = options.signal ? AbortSignal.any([activity.signal, options.signal]) : activity.signal;
      // Include content hashing in the same cancelable status, before a large
      // source read. Refine the measured first-use estimate after probing duration.
      activity.progress(null, "", 60);
      const sourceHash = await digest(source, signal);
      const key = createHash("sha256").update(JSON.stringify({ sourceHash, modelVersion, mode, span: span ?? null })).digest("hex");
      const base = baseFor(root), destination = path.join(base, key);
      const result = (cached: boolean) => ({ status: "ready" as const, ...outputs(destination, mode), key, modelVersion, cached });
      // Queue same-key callers without tying a second person's cancellation to the
      // first. Recheck the receipt after admission; a cache hit runs no model.
      const previous = pending.get(destination);
      const work = (async () => {
        if (previous) await waitForPrevious(previous, signal);
        signal.throwIfAborted();
        await noLink(base);
        if (await receipt(destination, key, mode, signal)) return result(true);
        const handle: ActivityHandle = { ...activity, signal };
        return (deps.slot ?? withRenderSlot)(handle, async () => {
          signal.throwIfAborted();
          await governor.whenMemoryAllows(signal);
          const reserve = mode === "stems" ? 4 * 1024 ** 3 : 256 * 1024 ** 2;
          while ((deps.memoryShare ?? availableMemoryShare)() < .2 + reserve / totalmem()) {
            activity.progress(null, "Waiting for memory", null); await delay(1000, undefined, { signal });
          }
          const base = await prepareBase(root);
          const disk = await fs.statfs(base);
          if (disk.bavail * disk.bsize < 16e9) throw new Error("Free some space before separating sound.");
          const staging = path.join(base, `.work-${randomUUID()}`);
          await fs.mkdir(staging);
          jobs.set(destination, { key, root, mode });
          try {
            const env = { ...toolEnvironment(), HOME: addon, TMPDIR: staging, XDG_CACHE_HOME: path.join(addon, "cache"),
              PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", DEMUCS_MLX_NO_DOWNLOAD: "1", HF_HUB_OFFLINE: "1", OMP_NUM_THREADS: "4", VECLIB_MAXIMUM_THREADS: "4" };
            const probe = JSON.parse(await command({ command: tool("ffprobe"), args: ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", source], cwd: staging, env, signal }));
            const duration = Number(probe.format?.duration);
            if (!probe.streams?.some((s: { codec_type: string }) => s.codec_type === "audio") || !Number.isFinite(duration) || duration <= 0) throw new Error("This file has no sound to separate.");
            if (span && span.e > duration + .001) throw new Error("The sound span ends outside this file.");
            const durationS = span ? span.e - span.s : duration;
            // Float outputs plus staging PCM; keep at least 15 GB available.
            if (disk.bavail * disk.bsize - durationS * 44100 * 2 * 20 < 15e9 || durationS > 3600) throw new Error("Choose a shorter sound span or free some space.");
            if (mode === "voice") {
              // The native denoiser can hold whole-file float buffers. Reserve
              // their duration-dependent cost, including input/output working
              // copies, before decoding a long recording.
              const voiceReserve = 256 * 1024 ** 2 + durationS * 48000 * 2 * 4 * 3;
              while ((deps.memoryShare ?? availableMemoryShare)() < .2 + voiceReserve / totalmem()) {
                activity.progress(null, "Waiting for memory", null); await delay(1000, undefined, { signal });
              }
            }
            // First-use shader setup was 53 s. Give an honest Approx estimate
            // immediately; subsequent chunk reports use measured throughput.
            activity.progress(null, "", 60 + durationS * (mode === "voice" ? .9 : .35));
            const input = path.join(staging, "input.wav");
            await command({ command: tool("ffmpeg"), args: ["-nostdin", "-v", "error", ...(span ? ["-ss", String(span.s)] : []), "-i", source, ...(span ? ["-t", String(durationS)] : []), "-map", "0:a:0", "-vn", "-ac", "2", "-ar", mode === "voice" ? "48000" : "44100", "-c:a", "pcm_s16le", input], cwd: staging, env, signal });
            const helper = deps.helper ?? [app.isPackaged && path.join(process.resourcesPath, "pipeline/stems.py"), path.resolve(__dirname, "../../pipeline/stems.py")].find(p => p && existsSync(p));
            if (!helper) throw new Error("Update precut to separate sound.");
            await command({ command: path.join(addon, "venv/bin/python"), args: ["-I", "-B", helper, "--input", input, "--output", staging, "--addon", addon, "--mode", mode], cwd: staging, env, signal,
              progress: p => activity.progress(Math.min(99, p.completed / p.total * 100), "", p.etaS ?? null) });
            const files: Receipt["files"] = {};
            for (const [name, file] of Object.entries(outputs(staging, mode))) {
              await noLink(file);
              const stat = await fs.stat(file);
              if (stat.size < 44) throw new Error("The separated sound is incomplete. Try again.");
              files[name] = { hash: await digest(file, signal), bytes: stat.size };
            }
            if (await digest(source, signal) !== sourceHash) throw new Error("The source sound changed. Try again.");
            await fs.unlink(input);
            await fs.writeFile(path.join(staging, "result.json"), JSON.stringify({ key, modelVersion, sourceHash, mode, span: span ?? null, durationS, files } satisfies Receipt), { flag: "wx" });
            signal.throwIfAborted();
            await noLink(destination); await fs.rm(destination, { recursive: true, force: true });
            await fs.rename(staging, destination);
            for (const [name, oldFile] of Object.entries(outputs(staging, mode))) {
              const known = digests.get(oldFile);
              if (known) digests.set(outputs(destination, mode)[name], known);
              digests.delete(oldFile);
            }
            return result(false);
          } finally { jobs.delete(destination); await fs.rm(staging, { recursive: true, force: true }); }
        }, "background");
      })();
      // A canceled waiter must not remove the still-running producer's barrier.
      const settled = previous ? Promise.allSettled([previous, work]) : work;
      pending.set(destination, settled);
      const clear = () => { if (pending.get(destination) === settled) pending.delete(destination); };
      void settled.then(clear, clear);
      return work;
    }, { deferRenderSlot: true, renderLane: "background" });
  }
  return {
    separate: (file: string, span?: StemsSpan, options?: Options) => run(file, "stems", span, options) as Promise<StemsResult | StemsInstallRequired>,
    isolateVoice: (file: string, span?: StemsSpan, options?: Options) => run(file, "voice", span, options) as Promise<VoiceIsolationResult | StemsInstallRequired>,
    async status(root: string | null = null) {
      const info = await extension();
      if (root) root = await fs.realpath(root);
      const base = baseFor(root);
      await noLink(path.dirname(base)); await noLink(base);
      const entries = await fs.readdir(base).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      const cached = [];
      for (const key of entries.filter(k => /^[a-f0-9]{64}$/.test(k)).slice(0, 200)) {
        const folder = path.join(base, key);
        // Verify local receipts: status never starts a process or creates caches.
        await noLink(folder); await noLink(path.join(folder, "result.json"));
        try {
          const record: Receipt = JSON.parse(await fs.readFile(path.join(folder, "result.json"), "utf8"));
          if (["stems", "voice"].includes(record.mode) && await receipt(folder, key, record.mode)) cached.push({ key, mode: record.mode, span: record.span, durationS: record.durationS, files: outputs(folder, record.mode) });
        } catch { /* Incomplete or obsolete cache is not ready. */ }
      }
      return { extension: info, modelVersion, running: [...jobs.values()].filter(j => j.root === root), cached, truncated: entries.length > 200 };
    },
  };
}
let engine: ReturnType<typeof createStemsEngine> | undefined;
function stemsEngine() { return engine ??= createStemsEngine({ userData: process.env.SIDETHING_USER_DATA ?? app.getPath("userData") }); }
export const separate = (file: string, span?: StemsSpan, options?: Options) => stemsEngine().separate(file, span, options);
export const isolateVoice = (file: string, span?: StemsSpan, options?: Options) => stemsEngine().isolateVoice(file, span, options);
export const getStemsStatus = (root?: string | null) => stemsEngine().status(root);
