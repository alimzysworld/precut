// Cheap summaries of saved edits for the polled readers (shoot list, progress).
// Edit files can be tens of MB each (every version keeps its assembly), and the
// shoot list and progress are polled every couple of seconds from several places.
// Parsing them all on every poll ran main out of memory (16 Oct). Parse a file
// once per change (size + mtime) and keep only the few fields those readers use.
import * as fs from "node:fs";
import * as path from "node:path";

export interface CutSummary { cutId: string; versionCount: number; versionTimes: string[]; exportTimes: string[] }
const cache = new Map<string, { stamp: string; summary: CutSummary | null }>();

async function summarise(file: string): Promise<CutSummary | null> {
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(file); } catch { cache.delete(file); return null; }
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.summary;
  let summary: CutSummary | null = null;
  try { summary = summaryOf(file, JSON.parse(await fs.promises.readFile(file, "utf8")) as Written); } catch { summary = null; }
  cache.set(file, { stamp, summary });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return summary;
}

// OPEN1: the writers know what they just wrote. Every save of his 45 MB edit made the next shoot-list poll parse
// the whole file again (0.7 to 1 s of main, while the saved version was trying to draw). A writer hands over the
// same fields summarise() would read back, stamped with the file it left on disk.
type Written = { cutId?: unknown; versions?: { createdAt?: unknown }[]; exported?: { at?: unknown }[] };
const summaryOf = (file: string, cut: Written): CutSummary => {
  const versions = Array.isArray(cut?.versions) ? cut.versions : [];
  return { cutId: (cut?.cutId ?? path.basename(file, ".json")) as string, versionCount: versions.length,
    versionTimes: versions.map(v => v?.createdAt).filter((t): t is string => typeof t === "string"),
    exportTimes: (Array.isArray(cut?.exported) ? cut.exported : []).map(x => x?.at).filter((t): t is string => typeof t === "string") };
};
/** A whole edit file was just written with exactly this value. */
export async function noteCutWritten(file: string, cut: Written): Promise<void> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (stat) cache.set(file, { stamp: `${stat.size}:${stat.mtimeMs}`, summary: summaryOf(file, cut) });
}
/** One version was appended to a file whose bytes were `before`; only a summary of exactly that file is extended. */
export async function noteCutAppended(file: string, before: { size: number; mtimeMs: number }, createdAt: unknown): Promise<void> {
  const hit = cache.get(file), stat = await fs.promises.stat(file).catch(() => null);
  if (!stat || hit?.stamp !== `${before.size}:${before.mtimeMs}` || !hit.summary) { cache.delete(file); return; }
  cache.set(file, { stamp: `${stat.size}:${stat.mtimeMs}`, summary: { ...hit.summary, versionCount: hit.summary.versionCount + 1,
    versionTimes: typeof createdAt === "string" ? [...hit.summary.versionTimes, createdAt] : hit.summary.versionTimes } });
}

/** Summaries of every saved edit in a shoot; unreadable or partial files are skipped. */
export async function cutSummaries(root: string): Promise<CutSummary[]> {
  const folder = path.join(root, ".sidething", "sidekick", "cuts");
  const names = await fs.promises.readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
  const summaries = await Promise.all(names.filter(n => n.endsWith(".json")).map(n => summarise(path.join(folder, n))));
  return summaries.filter((s): s is CutSummary => !!s);
}
