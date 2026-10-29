// Receipt-keyed, disposable JPEGs. Never decode a video in the renderer for a tile.
import * as atomicFs from "node:fs";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Clip, Shoot } from "../shared/schema";
import { runActivity, withRenderSlot } from "./activity";
import { tool, toolEnvironment } from "./tools";
import { STRIP_FPS, clipRotation, clipRotationFilter } from "../shared/media";

const pending = new Map<string, Promise<void>>();
const indexes = new Map<string, { stamp: string; shoot: Promise<Shoot> }>();
async function thumbnailIndex(root: string): Promise<Shoot> {
  const index = path.join(root, ".sidething/index.json"), stat = await fs.stat(index), stamp = `${stat.size}:${stat.mtimeMs}`;
  const hit = indexes.get(index); if (hit?.stamp === stamp) return hit.shoot;
  const shoot = fs.readFile(index, "utf8").then(text => JSON.parse(text) as Shoot);
  indexes.set(index, { stamp, shoot });
  if (indexes.size > 100) indexes.delete(indexes.keys().next().value!);
  void shoot.catch(() => { if (indexes.get(index)?.shoot === shoot) indexes.delete(index); });
  return shoot;
}
const exists = async (file: string) => { try { return (await fs.stat(file)).size > 0; } catch { return false; } };
export async function takeThumbnail(root: string, clipId: string, seconds: number, tiny = false, requestedProxy?: string): Promise<string> {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid thumbnail time.");
  const strip = /^strip:(.+):(\d+)(?::([a-f0-9]{64}))?$/.exec(clipId);
  if (strip) return standInFrame(root, strip[1], Number(strip[2]), strip[3]);
  const shoot = await thumbnailIndex(root).catch(() => null);
  const indexed = shoot?.clips.find(clip => clip.id === clipId);
  const clip = indexed && requestedProxy ? { ...indexed, proxy: requestedProxy } : indexed;
  if (!clip?.proxy) {
    const posters = JSON.parse(await fs.readFile(path.join(root, ".sidething/thumbs/posters.json"), "utf8").catch(() => "{}")) as Record<string, { file: string; key: string }>;
    const poster = posters[clipId];
    if (!poster || !/^[a-f0-9]{64}$/.test(poster.key)) throw new Error("No preview for this clip.");
    const source = path.resolve(root, poster.file);
    if (!(await fs.realpath(source)).startsWith((await fs.realpath(root)) + path.sep)) throw new Error("Invalid original path.");
    const stat = await fs.stat(source);
    if (originalKey(poster.file, stat, clip) !== poster.key) throw new Error("Still is being updated.");
    return path.join(root, ".sidething/thumbs", `${poster.key}${tiny ? "-tiny" : ""}.jpg`);
  }
  if (!clip?.proxy || !clip.meta?.width) throw new Error("No preview for this clip.");
  const dir = path.resolve(root, ".sidething/proxies"), proxy = path.resolve(dir, clip.proxy);
  if (!proxy.startsWith(dir + path.sep)) throw new Error("Invalid proxy path.");
  const [realDir, realProxy] = await Promise.all([fs.realpath(dir), fs.realpath(proxy)]);
  if (!realProxy.startsWith(realDir + path.sep)) throw new Error("Invalid proxy path.");
  const receipt = await fs.readFile(`${proxy}.proxy.json`, "utf8"), stat = await fs.stat(proxy);
  const saved = JSON.parse(receipt) as { proxyStamp: { size: number; mtimeMs: number }; source: string };
  if (saved.source !== clip.file || saved.proxyStamp.size !== stat.size || saved.proxyStamp.mtimeMs !== stat.mtimeMs) throw new Error("Preview is being updated.");
  const time = Math.min(seconds, Math.max(0, clip.meta.durationS - .04));
  const key = createHash("sha256").update(JSON.stringify({ receipt, time, revision: 1 })).digest("hex");
  const cache = path.join(root, ".sidething/thumbs"), full = path.join(cache, `${key}.jpg`), low = path.join(cache, `${key}-tiny.jpg`);
  if (await exists(full) && await exists(low)) return tiny ? low : full;
  let job = pending.get(full);
  if (!job) {
    job = runActivity({ kind: "process", root, target: { clipId }, label: `Preparing footage thumbnails for ${clip.file}`, cancelable: true },
      activity => withRenderSlot(activity, async () => {
        activity.signal.throwIfAborted();
        if (await exists(full) && await exists(low)) return;
        await fs.mkdir(cache, { recursive: true });
        const temp = path.join(cache, `${key}.${randomUUID()}.jpg`), tempLow = `${temp}.tiny.jpg`;
        try {
          await new Promise<void>((resolve, reject) => execFile(tool("ffmpeg"), ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-threads", "1", "-ss", String(time), "-i", proxy,
            "-filter_complex_threads", "1", "-filter_complex", "[0:v]scale=320:-2:out_range=full,format=yuvj420p,split[full][small];[small]scale=24:-2,format=yuvj420p[tiny]",
            "-map", "[full]", "-frames:v", "1", "-q:v", "4", temp, "-map", "[tiny]", "-frames:v", "1", "-q:v", "7", tempLow],
            { env: toolEnvironment(), signal: activity.signal, maxBuffer: 256 * 1024 }, error => error ? reject(error) : resolve()));
          activity.signal.throwIfAborted();
          if (receipt !== await fs.readFile(`${proxy}.proxy.json`, "utf8")) throw new Error("Preview changed while making thumbnails.");
          await fs.rename(tempLow, low); await fs.rename(temp, full);
        } finally { await Promise.all([fs.rm(temp, { force: true }), fs.rm(tempLow, { force: true })]); }
      }, "background"), { renderLane: "background" });
    pending.set(full, job);
    void job.finally(() => pending.delete(full)).catch(() => {});
  }
  await job;
  return tiny ? low : full;
}

// Posters are independent of Python's index and proxy receipts. Publish each
// atomic cache pair before notifying tiles; never put derived files by originals.
const originalKey = (file: string, stat: { size: number; mtimeMs: number }, clip?: Clip) =>
  createHash("sha256").update(JSON.stringify([file, stat.size, stat.mtimeMs, "poster-v1", ...(clip && (clipRotation(clip) || clipRotationFilter(clip)) ? [clipRotation(clip), clipRotationFilter(clip)] : [])])).digest("hex");
export async function makeOriginalPosters(root: string, clips: Clip[], onStill: (clip: Clip, completed: number) => void): Promise<void> {
  const cache = path.join(root, ".sidething/thumbs");
  await fs.mkdir(cache, { recursive: true });
  const manifest = path.join(cache, "posters.json");
  let posters: Record<string, { file: string; key: string }> = {};
  try { posters = JSON.parse(await fs.readFile(manifest, "utf8")); } catch { /* first pass */ }
  await runActivity({ kind: "process", root, target: null, label: "Preparing footage thumbnails", cancelable: true }, activity =>
    withRenderSlot(activity, async () => {
      let completed = 0, saving = Promise.resolve();
      const ready = new Set<number>();
      const poster = async (clip: Clip, index: number) => {
        activity.signal.throwIfAborted();
        // A clip whose original is gone from disk is missing: it gets no still and never stops the stage.
        const gone = (error: NodeJS.ErrnoException) => { if (error?.code === "ENOENT") return null; throw error; };
        const source = path.resolve(root, clip.file), realRoot = await fs.realpath(root), realSource = await fs.realpath(source).catch(gone);
        if (realSource !== null && !realSource.startsWith(realRoot + path.sep)) throw new Error("Invalid original path.");
        const stat = realSource === null ? null : await fs.stat(source).catch(gone), key = stat ? originalKey(clip.file, stat, clip) : "";
        const full = path.join(cache, `${key}.jpg`), tiny = path.join(cache, `${key}-tiny.jpg`);
        // A clip whose still can't be read must never stop processing: it waits for its preview-based thumbnail instead.
        let stillOk = stat !== null;
        try {
        if (stat && (!await exists(full) || !await exists(tiny))) {
          const run = (name: "ffmpeg" | "ffprobe" | "sips", args: string[]) => new Promise<string>((resolve, reject) =>
            execFile(tool(name), args, { env: toolEnvironment(), signal: activity.signal, maxBuffer: 256 * 1024 }, (error, output) => error ? reject(error) : resolve(output)));
          const photo = /\.(heic|heif|jpe?g|png)$/i.test(source);
          const duration = photo ? 0 : clip.meta?.durationS ?? Number(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", source]));
          const temp = path.join(cache, `${key}.${randomUUID()}.jpg`), low = `${temp}.tiny.jpg`;
          const decoded = /\.hei[cf]$/i.test(source) ? `${temp}.decoded.jpg` : null;
          try {
            if (decoded) await run("sips", ["-s", "format", "jpeg", source, "--out", decoded]);
            await run("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-threads", "1", ...(photo ? [] : ["-noaccurate_seek", "-ss", String(Number.isFinite(duration) ? Math.max(0, duration * .1) : 0)]), "-i", decoded ?? source,
              "-filter_complex_threads", "1", "-filter_complex", `[0:v]${clipRotationFilter(clip)}scale=320:-2:out_range=full,format=yuvj420p,split[full][small];[small]scale=24:-2,format=yuvj420p[tiny]`, "-map", "[full]", "-frames:v", "1", "-q:v", "4", temp, "-map", "[tiny]", "-frames:v", "1", "-q:v", "7", low]);
            if (!await exists(temp)) throw new Error("Could not read a still from this clip.");
            if (originalKey(clip.file, await fs.stat(source), clip) !== key) throw new Error("Original changed while reading its still.");
            await fs.rename(low, tiny); await fs.rename(temp, full);
          } finally { await Promise.all([fs.rm(temp, { force: true }), fs.rm(low, { force: true }), ...(decoded ? [fs.rm(decoded, { force: true })] : [])]); }
        }
        } catch (error) { if (activity.signal.aborted) throw error; stillOk = false; }
        if (stillOk) posters[clip.id] = { file: clip.file, key };
        // Manifest writes are serialised so concurrent stills never interleave.
        saving = saving.then(async () => {
          const temporary = `${manifest}.${randomUUID()}.tmp`;
          await fs.writeFile(temporary, JSON.stringify(posters)); await fs.rename(temporary, manifest);
          // Tiles are told in on-screen order even when a later seek finishes first.
          ready.add(index);
          while (ready.has(completed)) { const done = completed++; activity.progress(completed / clips.length * 100); onStill(clips[done], completed); }
        });
        await saving;
      };
      // Small single-threaded keyframe seeks, started in on-screen order. ANA1: six at a time, not three (nothing
      // else runs this early; TEST1 saw 44 s to a first still on 11 clips and 256 s on 220 under load).
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(6, clips.length) }, async () => {
        while (next < clips.length) { const index = next++; await poster(clips[index], index); }
      }));
    }, "background"), { renderLane: "background" });
}

// PS2: the stand-in strip. 5 frames a second at 540 px (short side), made once from the proxy, never the 4K original.
// Keyed by the proxy file (path, size, mtime) plus these settings, so a remade proxy remakes the strip.
// Lives in thumbs/ (never evicted with proxies) and is served through the thumbs kind of st-media.
const STRIP = { fps: STRIP_FPS, short: 540, quality: 7, revision: 1 };
type StripMeta = { key: string; count: number };
const stripDir = (root: string, clipId: string) => path.join(root, ".sidething/thumbs/strips", encodeURIComponent(clipId));
export async function stripKey(root: string, clip: Clip): Promise<string | null> {
  if (!clip.proxy || !clip.meta?.width) return null;
  const dir = path.resolve(root, ".sidething/proxies"), proxy = path.resolve(dir, clip.proxy);
  if (!proxy.startsWith(dir + path.sep)) return null;
  const stat = await fs.stat(proxy).catch(() => null);
  if (!stat || !stat.size) return null;
  return createHash("sha256").update(JSON.stringify({ proxy: clip.proxy, size: stat.size, mtimeMs: stat.mtimeMs, rotation: clipRotation(clip), ...STRIP })).digest("hex");
}
async function stripMeta(root: string, clipId: string): Promise<StripMeta | null> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(stripDir(root, clipId), "meta.json"), "utf8")) as StripMeta;
    return typeof meta.key === "string" && Number.isInteger(meta.count) && meta.count > 0 ? meta : null;
  } catch { return null; }
}
/** A stable content path to the nearest complete stand-in frame. */
async function standInFrame(root: string, clipId: string, index: number, key?: string): Promise<string> {
  const clip = (await thumbnailIndex(root).catch(() => null))?.clips.find(c => c.id === clipId);
  const directory = await fs.realpath(`${stripDir(root, clipId)}${key ? `-${key}` : ""}`).catch(() => null);
  const meta = clip && directory ? JSON.parse(await fs.readFile(path.join(directory, "meta.json"), "utf8")) as StripMeta : null;
  if (!meta) throw new Error("Stand-in strip is not ready.");
  // Keep the last complete strip usable while its successor is being made.
  return path.join(directory!, `f${String(Math.min(Math.max(1, index), meta.count)).padStart(5, "0")}.jpg`);
}
const stripJobs = new Map<string, Promise<void>>();
const stripAgain = new Set<string>();
/** Makes whatever strips are missing or stale for clips that have a current proxy. Quiet background work; never throws. */
export function makeStandInStrips(root: string): Promise<void> {
  root = path.resolve(root);
  const running = stripJobs.get(root);
  if (running) { stripAgain.add(root); return running; }
  const job = (async () => {
    do {
      stripAgain.delete(root);
      const shoot = await fs.readFile(path.join(root, ".sidething/index.json"), "utf8").then(text => JSON.parse(text) as Shoot).catch(() => null);
      for (const clip of shoot?.clips ?? []) {
        try {
          const key = await stripKey(root, clip);
          const receipt = JSON.parse(await fs.readFile(path.resolve(root, ".sidething/proxies", `${clip.proxy}.proxy.json`), "utf8").catch(() => "{}"));
          if ((receipt.rotation ?? 0) !== clipRotation(clip)) continue;
          if (!key) continue;
          if ((await stripMeta(root, clip.id))?.key === key && await exists(path.join(`${stripDir(root, clip.id)}-${key}`, 'meta.json'))) {
            // OPEN1: already published in the index this pass read; skip publishStrip's sync re-read of the whole index.
            if (clip.pictureStrip?.key !== key) publishStrip(root, clip, key);
            continue;
          }
          await makeStrip(root, clip, key);
        } catch { /* a strip is a stand-in: the next pass tries again */ }
      }
    } while (stripAgain.has(root));
  })();
  stripJobs.set(root, job);
  void job.finally(() => { if (stripJobs.get(root) === job) stripJobs.delete(root); });
  return job;
}
function publishStrip(root: string, clip: Clip, key: string): void {
  // Synchronous read/rename keeps concurrent tags. No write for an unchanged receipt.
  const index = path.join(root, ".sidething/index.json");
  const fresh = JSON.parse(atomicFs.readFileSync(index, "utf8")) as Shoot;
  const live = fresh.clips.find(c => c.id === clip.id);
  if (!live || live.proxy !== clip.proxy || live.pictureStrip?.key === key) return;
  live.pictureStrip = { key, rotation: clipRotation(clip) };
  fresh.updatedAt = new Date().toISOString();
  const temporary = `${index}.${randomUUID()}.tmp`;
  try { atomicFs.writeFileSync(temporary, JSON.stringify(fresh, null, 1)); atomicFs.renameSync(temporary, index); }
  finally { atomicFs.rmSync(temporary, { force: true }); }
}
async function makeStrip(root: string, clip: Clip, key: string): Promise<void> {
  const proxy = path.resolve(root, ".sidething/proxies", clip.proxy!), parent = path.join(root, ".sidething/thumbs/strips");
  await runActivity({ kind: "process", root, target: { clipId: clip.id }, label: `Preparing footage thumbnails for ${clip.file}`, cancelable: true },
    activity => withRenderSlot(activity, async () => {
      activity.signal.throwIfAborted();
      await fs.mkdir(parent, { recursive: true });
      const temp = path.join(parent, `.${randomUUID()}.tmp`);
      await fs.mkdir(temp);
      try {
        const { short, quality, fps } = STRIP;
        await new Promise<void>((resolve, reject) => execFile(tool("ffmpeg"), ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-threads", "2", "-i", proxy, "-an", "-sn",
          "-vf", `fps=${fps},scale=w='if(gt(iw,ih),-2,${short})':h='if(gt(iw,ih),${short},-2)':flags=bicubic:out_range=full,format=yuvj420p`, "-q:v", String(quality), "-start_number", "1", path.join(temp, "f%05d.jpg")],
          { env: toolEnvironment(), signal: activity.signal, maxBuffer: 256 * 1024 }, error => error ? reject(error) : resolve()));
        activity.signal.throwIfAborted();
        const count = (await fs.readdir(temp)).filter(name => /^f\d{5}\.jpg$/.test(name)).length;
        if (!count) throw new Error("No stand-in frames were made.");
        if (await stripKey(root, clip) !== key) throw new Error("Preview changed while making the stand-in strip.");
        await fs.writeFile(path.join(temp, "meta.json"), JSON.stringify({ key, count } satisfies StripMeta));
        const final = stripDir(root, clip.id), version = `${final}-${key}`;
        if (!(await fs.stat(version).catch(() => null))) await fs.rename(temp, version);
        // Swap one symlink atomically; readers of the old content path stay valid.
        const link = `${final}.${randomUUID()}.link`;
        await fs.symlink(path.basename(version), link);
        const previous = await fs.lstat(final).catch(() => null);
        if (previous && !previous.isSymbolicLink()) await fs.rename(final, `${final}.legacy-${randomUUID()}`);
        await fs.rename(link, final);
        publishStrip(root, clip, key);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    }, "background"), { renderLane: "background" });
}
