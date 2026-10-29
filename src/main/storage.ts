// R6: what precut keeps on disk for a shoot, what it can rebuild, and keeping that small.
// Only files inside <shoot>/.sidething/<cache folders> are ever removed. Originals, the
// edits themselves, indexes and "sidething precuts/" (exports) are never touched.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Clip } from "../shared/schema";

/** ST1: clear only this removed clip's named caches. Never sweep other clips. */
export async function clearClipCaches(root: string, clip: Clip): Promise<void> {
  const base = path.join(await fs.realpath(root), ".sidething");
  const safeRemove = async (file: string): Promise<void> => {
    if (!file.startsWith(base + path.sep) || await fs.realpath(file).then(real => real !== file, () => true)) return;
    const stat = await fs.lstat(file);
    if (stat.isFile()) await fs.unlink(file);
    else if (stat.isDirectory()) {
      for (const name of await fs.readdir(file)) await safeRemove(path.join(file, name));
      await fs.rmdir(file).catch(() => {}); // A skipped link is left intact.
    }
  };
  const candidates = [...clip.frames.map(frame => frame.startsWith("frames/") ? frame : `frames/${path.basename(frame)}`),
    ...(clip.proxy ? [`proxies/${clip.proxy.replace(/^proxies\//, "")}`, `proxies/${clip.proxy.replace(/^proxies\//, "")}.proxy.json`] : []),
    ...(clip.photo && clip.file.startsWith(".sidething/") ? [clip.file.slice(".sidething/".length)] : [])];
  for (const relative of new Set(candidates)) {
    const file = path.resolve(base, relative), rel = path.relative(base, file);
    if (rel.startsWith("..") || path.isAbsolute(rel) || !/^(frames|proxies|photos)\//.test(rel)) continue;
    // Reject links at any level, including the cache directory itself.
    if (await fs.realpath(file).then(real => real !== file, () => true)) continue;
    await safeRemove(file);
  }
  const thumbs = path.join(base, "thumbs"), manifest = path.join(thumbs, "posters.json");
  if (await fs.realpath(thumbs).then(real => real !== thumbs, () => true)) return;
  const posters = JSON.parse(await fs.readFile(manifest, "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return "{}";
  })) as Record<string, { key: string }>;
  const poster = posters[clip.id];
  if (poster && /^[a-f0-9]+$/i.test(poster.key)) {
    await safeRemove(path.join(thumbs, `${poster.key}.jpg`));
    await safeRemove(path.join(thumbs, `${poster.key}-tiny.jpg`));
    delete posters[clip.id];
    // Re-read before the small manifest change so other clips' new posters stay.
    const fresh = JSON.parse(await fs.readFile(manifest, "utf8")); delete fresh[clip.id];
    const temp = `${manifest}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(fresh)); await fs.rename(temp, manifest);
  }
  const strips = path.join(thumbs, "strips"), id = encodeURIComponent(clip.id);
  if (await fs.realpath(strips).then(real => real !== strips, () => true)) return;
  for (const name of await fs.readdir(strips)) if (id !== "." && id !== ".." && (name === id || name.startsWith(`${id}-`))) await safeRemove(path.join(strips, name));
}

export const CACHE_BUDGET_BYTES = 3 * 1024 ** 3;
/** Files used this recently may belong to a render or a player that is running now. */
const IN_USE_MS = 15 * 60_000;
const CLEAR_GRACE_MS = 60_000;
const KEPT_VERSIONS = 3;
const FOLDERS = ["audio", "editor-layers", "finish-cache", "mattes", "finished", "precuts", "proxies"] as const;
type Folder = typeof FOLDERS[number];

interface Entry { file: string; size: number; use: number; folder: Folder; keep: boolean; superseded: boolean; side?: string[] }
interface EditFacts { latest: number; oldestKept: number; superseded: Set<number>; newestAt: number }

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await sizeOf(file);
    else if (entry.isFile()) total += (await fs.lstat(file).catch(() => null))?.size ?? 0;
  }
  return total;
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return null; }
}

async function editFacts(base: string): Promise<Map<string, EditFacts>> {
  const dir = path.join(base, "sidekick", "cuts"), result = new Map<string, EditFacts>();
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const cut = await readJson<{ cutId?: string; versions?: { version: number; createdAt?: string }[] }>(path.join(dir, name));
    if (!cut?.cutId || !Array.isArray(cut.versions) || !cut.versions.length) continue;
    const versions = [...cut.versions].sort((a, b) => a.version - b.version);
    const kept = versions.slice(-KEPT_VERSIONS), time = (v?: { createdAt?: string }) => Date.parse(v?.createdAt ?? "") || 0;
    result.set(cut.cutId, {
      // at(-1) stays: storage ages renders by snapshot number and time; no edit is acted on.
      latest: versions.at(-1)!.version,
      // Older than the last three versions: nothing the person can step back to needs it.
      superseded: new Set(versions.slice(0, -KEPT_VERSIONS).map(v => v.version)),
      oldestKept: versions.length > KEPT_VERSIONS ? time(kept[0]) : 0,
      newestAt: time(versions.at(-1)),  // at(-1) stays: when anything was last saved
    });
  }
  return result;
}

/** Lists every regenerable file. Sidecar receipts travel with the file they describe. */
async function scan(root: string): Promise<{ entries: Entry[]; protectedSince: number }> {
  const base = path.join(await fs.realpath(root), ".sidething");
  const edits = await editFacts(base);
  const index = await readJson<{ clips?: { proxy?: string | null }[] }>(path.join(base, "index.json"));
  const playback = new Set((index?.clips ?? []).map(c => c.proxy).filter((p): p is string => !!p).flatMap(p => [p, `${p}.proxy.json`]));
  // The newest edit stands in for the one that is open: everything it has used since its latest version stays.
  const protectedSince = Math.max(0, ...[...edits.values()].map(e => e.newestAt));
  // Hashed caches don't say which edit they serve, so "superseded" needs every edit to have moved on.
  const supersededBefore = edits.size ? Math.min(...[...edits.values()].map(e => e.oldestKept)) : 0;
  const entries: Entry[] = [];
  for (const folder of FOLDERS) {
    const top = path.join(base, folder);
    if (await fs.realpath(top).then(r => r !== top, () => true)) continue;  // missing or a symlink: leave alone
    const walk = async (dir: string): Promise<void> => {
      for (const dirent of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(dir, dirent.name);
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) { await walk(file); continue; }
        if (!dirent.isFile()) continue;
        const stat = await fs.lstat(file).catch(() => null);
        if (!stat) continue;
        const rel = path.relative(top, file), use = Math.max(stat.atimeMs, stat.mtimeMs);
        let keep = false, superseded = false;
        if (folder === "proxies") keep = playback.has(rel);
        else if (folder === "finished" || folder === "precuts") {
          // Named after the edit and version they show.
          const m = /^(.+)-v(\d+)(?:\D|$)/.exec(dirent.name), facts = m && edits.get(m[1]);
          if (facts && m) {
            keep = Number(m[2]) === facts.latest;
            superseded = facts.superseded.has(Number(m[2]));
          }
        } else superseded = supersededBefore > 0 && use < supersededBefore;
        entries.push({ file, size: stat.size, use, folder, keep, superseded });
      }
    };
    await walk(top);
  }
  // Fold receipts (x.wav.json, x.mp4.proxy.json) into the file they belong to.
  const byFile = new Map(entries.map(e => [e.file, e]));
  const folded = entries.filter(e => {
    const owner = [".proxy.json", ".json"].map(s => e.file.endsWith(s) ? byFile.get(e.file.slice(0, -s.length)) : undefined).find(Boolean);
    if (!owner || owner === e) return true;
    owner.size += e.size; owner.side = [...owner.side ?? [], e.file];
    return false;
  });
  return { entries: folded, protectedSince };
}

const remove = async (entry: Entry): Promise<number> => {
  let freed = 0;
  for (const file of [entry.file, ...entry.side ?? []]) {
    const size = (await fs.lstat(file).catch(() => null))?.size ?? 0;
    if (await fs.rm(file, { force: true }).then(() => true, () => false)) freed += size;
  }
  return freed;
};

export interface StorageUsage { cacheBytes: number; exportBytes: number; footageBytes: number }
export async function storageUsage(root: string): Promise<StorageUsage> {
  const resolved = await fs.realpath(root), index = await readJson<{ clips?: { file: string }[] }>(path.join(resolved, ".sidething", "index.json"));
  let footageBytes = 0;
  for (const clip of index?.clips ?? []) footageBytes += (await fs.stat(path.resolve(resolved, clip.file)).catch(() => null))?.size ?? 0;
  return { cacheBytes: await sizeOf(path.join(resolved, ".sidething")), exportBytes: await sizeOf(path.join(resolved, "sidething precuts")), footageBytes };
}

/** Removes everything precut can rebuild. Playback proxies, edits and exports stay. */
export async function clearCaches(root: string, now = Date.now()): Promise<{ freedBytes: number }> {
  let freedBytes = 0;
  for (const entry of (await scan(root)).entries) {
    if (entry.folder === "proxies" ? entry.keep : false) continue;
    if (now - entry.use < CLEAR_GRACE_MS) continue;
    freedBytes += await remove(entry);
  }
  return { freedBytes };
}

const running = new Map<string, Promise<{ freedBytes: number; bytes: number }>>();
/** Keeps regenerable cache under the budget: superseded first, then least recently used.
 * The newest version of each edit, playback proxies and anything in use are never evicted. */
export function enforceBudget(root: string, budget = CACHE_BUDGET_BYTES, now = Date.now()): Promise<{ freedBytes: number; bytes: number }> {
  const key = path.resolve(root), old = running.get(key);
  if (old) return old;
  const job = (async () => {
    const { entries, protectedSince } = await scan(root);
    const countable = entries.filter(e => !(e.folder === "proxies" && e.keep));
    let bytes = countable.reduce((sum, e) => sum + e.size, 0), freedBytes = 0;
    const candidates = countable.filter(e => !e.keep && now - e.use >= IN_USE_MS && (e.superseded || e.use < protectedSince || e.folder === "proxies" || !protectedSince))
      .sort((a, b) => Number(b.superseded) - Number(a.superseded) || a.use - b.use);
    for (const entry of candidates) {
      if (bytes <= budget) break;
      const freed = await remove(entry);
      bytes -= freed; freedBytes += freed;
    }
    return { freedBytes, bytes };
  })().finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

/** Fire and forget, quiet: runs after a render finishes and when the app starts. */
const timers = new Map<string, NodeJS.Timeout>();
export function scheduleEnforce(root: string, delayMs = 30_000): void {
  const key = path.resolve(root);
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => { timers.delete(key); void enforceBudget(root).catch(() => {}); }, delayMs);
  timer.unref?.();
  timers.set(key, timer);
}
