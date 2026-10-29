// Adding footage to a shoot that already has ideas or edits is quiet, and a swapped source an
// edit uses is re-read first (25-26 Oct, a real shoot). These readers only stat files and
// read saved JSON: they never decode, judge or write.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Clip, Shoot } from "../shared/schema";
import { cutSummaries } from "./cut-summaries";
import { previewSourceChanged } from "./proxies";

/** A shoot is new until it has an idea or an edit. Only a new shoot gets the waiting room and the autopilot. */
export async function establishedShoot(root: string): Promise<boolean> {
  root = path.resolve(root);
  if ((await cutSummaries(root).catch(() => [])).some(c => c.versionCount > 0)) return true;
  try {
    const thread = JSON.parse(await fs.promises.readFile(path.join(root, ".sidething/sidekick/thread.json"), "utf8")) as { ideas?: unknown[] }[];
    return Array.isArray(thread) && thread.some(m => (m?.ideas?.length ?? 0) > 0);
  } catch { return false; }
}

// Of these clips, the ones an edit's current version names anywhere (pieces, b-roll, overlays, layouts).
// Edit files can be tens of MB (44 MB parses in about 0.4 s), so a raw text check comes first and a
// file is parsed only when a candidate appears in it, once per change of that file.
type CutCache = { stamp: string; mentioned: Map<string, boolean>; used?: Set<string> };
const cuts = new Map<string, CutCache>();
function collect(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) collect(item, ids); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "assembly") continue;  // the saved model assembly lists every clip in the shoot, not the edit's
    if (key === "clipId" && typeof item === "string") ids.add(item);
    else collect(item, ids);
  }
}
const escape = (text: string) => text.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
const mentions = (text: string, id: string) => new RegExp('"clipId":\\s*' + escape(JSON.stringify(id))).test(text);
export async function editClipIds(root: string, candidates: readonly string[]): Promise<Set<string>> {
  const folder = path.join(path.resolve(root), ".sidething/sidekick/cuts");
  const names = await fs.promises.readdir(folder).catch(() => [] as string[]);
  const found = new Set<string>();
  for (const name of names.filter(n => n.endsWith(".json"))) {
    const file = path.join(folder, name);
    try {
      const stat = await fs.promises.stat(file), stamp = `${stat.size}:${stat.mtimeMs}`;
      let entry = cuts.get(file);
      if (entry?.stamp !== stamp) { entry = { stamp, mentioned: new Map() }; cuts.set(file, entry); if (cuts.size > 200) cuts.delete(cuts.keys().next().value!); }
      const unknown = candidates.filter(id => !entry!.mentioned.has(id));
      // ARCH2: an edit kept as a log names its current version in one line; the head holds only light entries.
      const storage = await import("./cut-storage"), head = await storage.readLogHead(file);
      const read = async () => head ? JSON.stringify({ versions: [await storage.readLoggedVersion(file, head, "latest")] }) : fs.promises.readFile(file, "utf8");
      if (unknown.length) {
        const text = await read();
        for (const id of unknown) entry.mentioned.set(id, mentions(text, id));
      }
      const hits = candidates.filter(id => entry!.mentioned.get(id));
      if (!hits.length) continue;
      if (!entry.used) {
        const cut = JSON.parse(await read()) as { versions?: unknown[] };
        entry.used = new Set();
        collect(Array.isArray(cut?.versions) ? cut.versions.at(-1) : undefined, entry.used);
      }
      for (const id of hits) if (entry.used.has(id)) found.add(id);
    } catch { /* an edit mid-save is read on the next look */ }
  }
  return found;
}

type Receipt = { size: number; mtime: number };
export const originalOf = (clip: Pick<Clip, "file" | "photo">): string => clip.photo?.file ?? clip.file;
/** Clips whose original changed (size or time) since it was read or since its preview was made. A missing original is not a change. */
export function changedSources(root: string, shoot: Shoot): Clip[] {
  const receipts = (shoot as Shoot & { _cache?: { clips?: Record<string, Receipt> } })._cache?.clips ?? {};
  return shoot.clips.filter(clip => {
    let stat: fs.Stats;
    try { stat = fs.statSync(path.join(root, originalOf(clip))); } catch { return false; }
    const receipt = receipts[clip.id];
    return !!receipt && (receipt.size !== stat.size || Math.abs(receipt.mtime * 1000 - stat.mtimeMs) > 1)
      || !clip.photo && !!clip.meta?.sizeBytes && clip.meta.sizeBytes !== stat.size
      || previewSourceChanged(root, clip);
  });
}
/** Changed sources an edit uses: they are read again at once, ahead of anything new. */
export async function changedInEdits(root: string, shoot: Shoot): Promise<Clip[]> {
  const changed = changedSources(root, shoot);
  if (!changed.length) return [];
  const ids = await editClipIds(root, changed.map(clip => clip.id));
  return changed.filter(clip => ids.has(clip.id));
}
