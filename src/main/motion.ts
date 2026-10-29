// Proxy-only, translation-only measurements. Originals are never opened here.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { AsyncResource } from "node:async_hooks";
import type { Clip, CutVersion } from "../shared/schema";
import { runActivity, threads } from "./activity";
import { tool } from "./tools";

export interface MotionSample { t: number; x: number; y: number }
export interface MotionAnalysis { revision: 1; receipt: string; width: number; height: number; fps: number; samples: MotionSample[] }
const pending = new Map<string, Promise<void>>();
// Created at module load, outside any finish transaction or render slot.
const background = new AsyncResource("motion-background");
const middle = (a: number[]) => { a.sort((x, y) => x - y); const n = a.length; return n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : 0; };
const safeId = (id: string) => { if (!/^[\w-]+$/.test(id)) throw new Error("Invalid clip id."); return id; };
const cacheFile = (root: string, clip: Clip) => path.join(root, ".sidething/motion", `${safeId(clip.id)}.json`);
async function proxyReceipt(root: string, clip: Clip) {
  if (!clip.proxy) throw new Error("The preview is not ready.");
  const directory = path.resolve(root, ".sidething/proxies"), file = path.resolve(directory, clip.proxy);
  if (!file.startsWith(directory + path.sep)) throw new Error("Proxy outside cache.");
  const stat = await fs.stat(file), receipt = await fs.readFile(`${file}.proxy.json`, "utf8");
  return { file, key: createHash("sha256").update(JSON.stringify([receipt, stat.size, stat.mtimeMs])).digest("hex") };
}
export async function readMotion(root: string, clip: Clip): Promise<MotionAnalysis | undefined> {
  try {
    const receipt = await proxyReceipt(root, clip), cached: MotionAnalysis = JSON.parse(await fs.readFile(cacheFile(root, clip), "utf8"));
    if (cached.revision === 1 && cached.receipt === receipt.key && cached.samples.length &&
        [cached.width, cached.height, cached.fps].every(n => Number.isFinite(n) && n > 0) &&
        cached.samples.every(p => [p.t, p.x, p.y].every(Number.isFinite))) return cached;
  } catch { /* A missing/stale receipt or interrupted cache is not ready. */ }
  return undefined;
}

/** vidstab local displacements describe this frame relative to the previous.
 * A median rejects independent subject motion; rotation is deliberately ignored. */
export function parseShake(text: string, fps: number): MotionSample[] {
  let x = 0, y = 0;
  return [...text.matchAll(/^Frame (\d+) \(List[^\n]*$/gm)].map(frame => {
    const moves = [...frame[0].matchAll(/\(LM ([-\d.]+) ([-\d.]+) /g)].map(m => [Number(m[1]), Number(m[2])]);
    // LM is the backwards match (current to previous); source crop follows
    // the visible forward displacement, hence the sign reversal.
    x -= middle(moves.map(m => m[0])); y -= middle(moves.map(m => m[1]));
    return { t: (Number(frame[1]) - 1) / fps, x, y };
  });
}

/** Remove high-frequency movement, retaining deliberate camera travel. */
export function shakeCorrections(samples: MotionSample[], radiusS = .5): MotionSample[] {
  let low = 0, high = 0, x = 0, y = 0;
  return samples.map(p => {
    while (high < samples.length && samples[high].t <= p.t + radiusS + 1e-7) { x += samples[high].x; y += samples[high++].y; }
    while (low < high && samples[low].t < p.t - radiusS - 1e-7) { x -= samples[low].x; y -= samples[low++].y; }
    return { t: p.t, x: p.x - x / (high - low), y: p.y - y / (high - low) };
  });
}

export function queueMotion(root: string, clip: Clip): Promise<void> {
  root = path.resolve(root);
  const id = JSON.stringify([root, clip.id]);
  const existing = pending.get(id);
  if (existing) return existing;
  // Leave the caller's render slot/transaction before starting background work.
  const task = background.runInAsyncScope(() => new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    if (await readMotion(root, clip)) return;
    await runActivity({ kind: "render", root, target: { clipId: clip.id }, label: "Measuring shake", cancelable: true }, async activity => {
      const receipt = await proxyReceipt(root, clip), directory = path.dirname(cacheFile(root, clip));
      await fs.mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `${safeId(clip.id)}-${randomUUID()}`), transforms = `${temporary}.trf`;
      try {
        const probe = await new Promise<string>((resolve, reject) => {
          const child = spawn(tool("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", receipt.file], { signal: activity.signal });
          let output = ""; child.stdout.on("data", d => output += d); child.stderr.resume();
          child.once("error", reject); child.once("close", code => code === 0 ? resolve(output) : reject(new Error("Could not read preview shape.")));
        });
        const stream = JSON.parse(probe).streams[0], [num, den] = stream.avg_frame_rate.split("/").map(Number), fps = num / den;
        if (![stream.width, stream.height, fps].every(n => Number.isFinite(n) && n > 0)) throw new Error("Invalid preview shape.");
        await new Promise<void>((resolve, reject) => {
          // cwd makes the filter filename safe even when shoot paths contain quotes.
          const child = spawn(tool("ffmpeg"), ["-hide_banner", "-nostdin", "-v", "error", "-threads", String(threads(2)), "-filter_threads", "1", "-i", receipt.file,
            "-an", "-vf", `vidstabdetect=result=${path.basename(transforms)}:fileformat=ascii:shakiness=5:accuracy=15`, "-f", "null", "-"],
          { cwd: directory, signal: activity.signal, killSignal: "SIGKILL", env: { ...process.env, OMP_NUM_THREADS: "1" } });
          let error = ""; child.stdout.resume(); child.stderr.on("data", d => error = (error + d).slice(-2000));
          child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`Could not measure shake: ${error}`)));
        });
        const samples = parseShake(await fs.readFile(transforms, "utf8"), fps);
        if (!samples.length) throw new Error("No shake measurements were produced.");
        if ((await proxyReceipt(root, clip)).key !== receipt.key) throw new Error("Preview changed while measuring shake. Try again.");
        const result: MotionAnalysis = { revision: 1, receipt: receipt.key, width: stream.width, height: stream.height, fps, samples };
        activity.signal.throwIfAborted();
        await fs.writeFile(`${temporary}.json`, JSON.stringify(result));
        activity.signal.throwIfAborted();
        await fs.rename(`${temporary}.json`, cacheFile(root, clip));
      } finally { await Promise.all([transforms, `${temporary}.json`].map(file => fs.rm(file, { force: true }))); }
    });
  })).finally(() => pending.delete(id));
  pending.set(id, task);
  // Background failures belong to the activity bus, never an unhandled rejection.
  void task.catch(() => {});
  return task;
}

export async function motionStatus(root: string, clipIds: string[]): Promise<Record<string, "ready" | "measuring" | "none">> {
  root = path.resolve(root);
  const shoot = JSON.parse(await fs.readFile(path.join(root, ".sidething/index.json"), "utf8"));
  return Object.fromEntries(await Promise.all(clipIds.map(async id => {
    const clip: Clip | undefined = shoot.clips.find((c: Clip) => c.id === id);
    return [id, clip && await readMotion(root, clip) ? "ready" : pending.has(JSON.stringify([root, id])) ? "measuring" : "none"];
  })));
}

export async function framingMotion(root: string, cuts: { piece?: number; seg: { clip: Clip } | null }[], version: Pick<CutVersion, "framing" | "pieceFx">): Promise<Map<string, MotionAnalysis>> {
  const result = new Map<string, MotionAnalysis>();
  for (const [i, cut] of cuts.entries()) {
    if (!cut.seg || (version.pieceFx?.[cut.piece ?? i]?.framing ?? version.framing)?.mode !== "steady") continue;
    const clip = cut.seg.clip, ready = await readMotion(root, clip);
    if (ready) result.set(clip.id, ready); else void queueMotion(root, clip).catch(() => {});
  }
  return result;
}
