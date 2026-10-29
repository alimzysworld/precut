// Originals move only through the desktop review's explicit action. No MCP writes.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { shell } from "electron";
import type { Api, Clip, Shoot } from "../shared/schema";
import { listActivity } from "./activity";
import { stepsChanged } from "./steps";
import { clearClipCaches } from "./storage";
import { writeJsonAtomic } from "./cut-storage";

interface State { kept: string[]; trashed: Clip[] }
const stateFile = (root: string) => path.join(root, ".sidething/junk.json");
const indexFile = (root: string) => path.join(root, ".sidething/index.json");
const queues = new Map<string, Promise<unknown>>();
function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(work);
  queues.set(root, job);
  void job.finally(() => { if (queues.get(root) === job) queues.delete(root); }).catch(() => {});
  return job;
}
async function safeRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  if (await fs.realpath(resolved) !== resolved || await fs.realpath(path.join(resolved, ".sidething")) !== path.join(resolved, ".sidething"))
    throw new Error("Choose the shoot folder itself, without links.");
  return resolved;
}
async function state(root: string): Promise<State> {
  try {
    const value = JSON.parse(await fs.readFile(stateFile(root), "utf8"));
    if (!Array.isArray(value.kept) || !value.kept.every((id: unknown) => typeof id === "string") || !Array.isArray(value.trashed)) throw new Error("Invalid review");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kept: [], trashed: [] };
    throw new Error("Your saved review could not be read. Nothing was moved.");
  }
}
async function index(root: string): Promise<Shoot> { return JSON.parse(await fs.readFile(indexFile(root), "utf8")); }

/** Check every component, including the final file. Never follow a directory link. */
async function source(root: string, relative: string): Promise<{ file: string; size: number }> {
  const file = path.resolve(root, relative), rel = path.relative(root, file);
  if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel === ".." ||
      rel.split(path.sep).some(part => part.startsWith(".") || part.toLowerCase() === "sidething precuts"))
    throw new Error("This file is outside the shoot's original footage.");
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Linked files cannot be moved to the Trash.");
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error("This is not an original footage file.");
  return { file, size: stat.size };
}
async function filesFor(root: string, clip: Clip, listings?: Map<string, string[]>) {
  const original = clip.photo?.file ?? clip.file, main = await source(root, original);
  const ext = path.extname(original), stem = path.basename(original, ext), dir = path.dirname(original);
  const directory = path.join(root, dir);
  const names = listings?.get(directory) ?? await fs.readdir(directory);
  listings?.set(directory, names);
  const pairs = names.filter(name => {
    const lower = name.toLowerCase();
    return lower === `${stem}M01.XML`.toLowerCase() ||
      ([".mov", ".mp4"].includes(ext.toLowerCase()) && [".heic", ".heif"].some(e => lower === `${stem}${e}`.toLowerCase())) ||
      (clip.photo && lower === `${stem}.mov`.toLowerCase());
  });
  // Pairs first. If one fails, the original remains available for a retry.
  const result = [];
  for (const name of pairs) result.push(await source(root, path.join(dir, name)));
  return [...result, main];
}

async function cutFiles(root: string): Promise<string[]> {
  const dir = path.join(root, ".sidething/sidekick/cuts");
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const result = names.filter(name => name.endsWith(".json")).map(name => path.join(dir, name));
  // Removing an edit from the library never removes its delivered packages.
  const trash = path.join(root, ".sidething/trash");
  const archived = await fs.readdir(trash, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  for (const entry of archived) if (entry.isDirectory() && !entry.isSymbolicLink()) {
    const file = path.join(trash, entry.name, "edit.json");
    if (await fs.stat(file).then(s => s.isFile(), () => false)) result.push(file);
  }
  return result;
}
function mentions(value: unknown, clip: Clip): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => mentions(item, clip));
  const obj = value as Record<string, unknown>;
  return obj.clipId === clip.id || obj.id === clip.id || obj.file === (clip.photo?.file ?? clip.file) ||
    Object.entries(obj).some(([key, item]) => key !== "shoot" && key !== "storage" && mentions(item, clip));
}
async function exported(root: string, clip: Clip, files: { file: string }[]): Promise<boolean> {
  const referencedMedia = [...files, { file: path.resolve(root, clip.file) },
    ...(clip.proxy ? [{ file: path.resolve(root, ".sidething/proxies", clip.proxy.replace(/^proxies\//, "")) }] : [])];
  const folders = new Set([path.join(root, "sidething precuts")]);
  for (const file of await cutFiles(root)) {
    // ARCH2: the whole edit (head + log), so a clip an exported version used is found wherever that version names it.
    const cut = await (await import("./cut-storage")).readCutDocument(file).catch(async () => JSON.parse(await fs.readFile(file, "utf8")));
    for (const receipt of cut.exported ?? []) {
      if (receipt.folder) folders.add(receipt.folder);
      const version = cut.versions?.find((v: { version: number }) => v.version === receipt.version);
      if (version && mentions(version, clip)) return true;
    }
  }
  // Includes old selects and exports predating saved-cut receipts. Read only.
  const walk = async (dir: string): Promise<boolean> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("An export contains a link. Nothing was moved.");
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (await walk(file)) return true; }
      else if (/\.(xml|fcpxml|json)$/i.test(entry.name)) {
        let text = await fs.readFile(file, "utf8");
        try { text = decodeURIComponent(text); } catch { /* unescaped document */ }
        text = text.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\\\//g, "/");
        if (referencedMedia.some(item => text.includes(item.file) || text.includes(item.file.replace(/ /g, "%20")))) return true;
      }
    }
    return false;
  };
  for (const folder of folders) if (await walk(folder)) return true;
  return false;
}

export const junkReview: Api["junkReview"] = async root => {
  root = await safeRoot(root);
  const [shoot, saved] = await Promise.all([index(root), state(root)]), clips = [];
  const listings = new Map<string, string[]>();
  for (const clip of shoot.clips) {
    if (!clip.judgement?.junk || saved.kept.includes(clip.id)) continue;
    try {
      const files = await filesFor(root, clip, listings);
      clips.push({ clipId: clip.id, file: clip.photo?.file ?? clip.file, reason: clip.judgement.junk, sizeBytes: files.reduce((sum, file) => sum + file.size, 0) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { clips, sizeBytes: clips.reduce((sum, clip) => sum + clip.sizeBytes, 0) };
};

export const keepClips: Api["keepClips"] = async (root, ids) => {
  root = await safeRoot(root);
  return serial(root, async () => {
    const saved = await state(root), shoot = await index(root);
    saved.kept = [...new Set([...saved.kept, ...ids.filter(id => shoot.clips.some(clip => clip.id === id))])];
    await writeJsonAtomic(stateFile(root), saved); stepsChanged(root);
  });
};

export const trashClips: Api["trashClips"] = async (root, ids) => {
  root = await safeRoot(root);
  return serial(root, async () => {
    const result: Awaited<ReturnType<Api["trashClips"]>> = { trashed: [], failed: [], freedBytes: 0 };
    for (const clipId of new Set(ids)) {
      let moved = false;
      try {
        const saved = await state(root), shoot = await index(root), clip = shoot.clips.find(c => c.id === clipId);
        if (!clip?.judgement?.junk || saved.kept.includes(clipId)) throw new Error("This clip is no longer in the junk review.");
        if ((await listActivity()).some(a => path.resolve(a.root ?? "") === root && a.state === "running"))
          throw new Error("This shoot is busy. Try again when it finishes.");
        const files = await filesFor(root, clip);
        if (await exported(root, clip, files)) throw new Error("An export uses this shot. Keep its original on disk.");
        // Recovery metadata lands before the first original moves, even on a crash.
        saved.trashed = [...saved.trashed.filter(c => c.id !== clipId), clip];
        await writeJsonAtomic(stateFile(root), saved);
        for (const item of files) {
          try {
            if ((await listActivity()).some(a => path.resolve(a.root ?? "") === root && a.state === "running"))
              throw new Error("This shoot is busy.");
            await safeRoot(root);
            await source(root, path.relative(root, item.file));
            await shell.trashItem(item.file);
            result.freedBytes += item.size;
          } catch { throw new Error(`Could not move ${path.basename(item.file)} to the Trash. Other files may already have moved.`); }
        }
        moved = true; result.trashed.push(clipId);
        // Re-read after the OS work, preserving unrelated index updates.
        const fresh = await index(root);
        fresh.clips = fresh.clips.filter(c => c.id !== clipId);
        // Keep take identities and the judge's picks intact for saved edits.
        // Footage already skips attempts whose clip is no longer in the index.
        fresh.updatedAt = new Date().toISOString();
        await writeJsonAtomic(indexFile(root), fresh);
        await clearClipCaches(root, clip);
      } catch (error) {
        result.failed.push({ clipId, error: `${moved ? "Original moved. Could not finish updating the shoot: " : ""}${error instanceof Error ? error.message : "Could not move this clip."}` });
      }
    }
    stepsChanged(root); return result;
  });
};
