// VO7-1 (briefs/VO7-voiceover-editing-SPIKE-v3.md, "Undo and versions", "Concurrent writes").
// Every numbered snapshot in .sidething/sidekick/cuts/<cutId>.json stays immutable, as a hidden
// revision. This module is the only writer of cut history: it owns the current revision, the undo
// cursor and milestones, kept in a small sidecar so ⌘Z and ⌘⇧Z never rewrite the edit file.
//
// The sidecar lives at .sidething/sidekick/history/<cutId>.json, beside the cuts folder rather
// than inside it: eight readers outside this stage list cuts/*.json and parse every match as an
// edit (transcript.ts iterates its versions), so a .json there would break them.
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { randomUUID } from "node:crypto";
import { withShootWriter, WriterBusyError, ownsOpenShoot, trackSave } from "./writer-lock";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeJsonAtomic } from "./cut-storage";
import type { CutEdit, MilestoneKind, RevisionConflict, RevisionMilestone, RevisionState } from "../shared/schema";
import type { StoredVersion } from "./sidekick";

const FORMAT = "precut-history-v1";
const PATH_LIMIT = 5000;  // undo steps kept on the path; snapshots themselves are never dropped
const KINDS: readonly MilestoneKind[] = ["draft", "before-auto", "export", "saved"];

interface History {
  format: typeof FORMAT;
  cutId: string;
  current: number;          // the revision every editor writes against
  path: number[];           // the undo path, oldest first; path[cursor] === current
  cursor: number;
  milestones: RevisionMilestone[];
  seen: number;             // the highest snapshot number this history has accounted for
  epoch: number;            // bumps on every undo and redo: a result computed across one never publishes
  cutStamp: string | null;  // identity of the edit file this history last accounted for
  migrated: { at: string; versions: number; latest: number; current: "last-opened" | "latest" };
  // FIX4: follow-on version -> the version it completes (captions realigned onto the voice after an edit). On the path
  // right after its base, the two are one undo step. Additive: older sidecars have none.
  followOns?: Record<number, number>;
}
export interface CutWriteInfo {
  versions: number[]; exported?: { version: number; at?: string }[];
  /** Every newly appended snapshot names its source revision (version -> base). Legacy history may have no entries. */
  bases: Record<number, number>;
}
export type CommitResult = { ok: true; version: number } | { ok: false; conflict: RevisionConflict };

const ID = /^[a-zA-Z0-9_-]+$/;
const keyOf = (root: string, cutId: string) => {
  if (!ID.test(cutId)) throw new Error("That edit id is invalid.");
  return JSON.stringify([path.resolve(root), cutId]);
};
export const historyFile = (root: string, cutId: string) => { keyOf(root, cutId); return path.join(path.resolve(root), ".sidething/sidekick/history", `${cutId}.json`); };
const cutPath = (root: string, cutId: string) => path.join(path.resolve(root), ".sidething/sidekick/cuts", `${cutId}.json`);

// ---- History lock: short, leaf-level. Nothing that holds it ever waits for the cut lock.
const locks = new Map<string, Promise<unknown>>();
function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(work);
  const settled = next.catch(() => {});
  locks.set(key, settled);
  void settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return next;
}

// ---- Sidecar storage, cached by file identity.
const stampOf = (stat: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const stamp = (file: string): Promise<string | null> => {
  if (ownsOpenShoot(path.resolve(path.dirname(file), "../../.."))) {
    try { return Promise.resolve(stampOf(fsSync.statSync(file))); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? Promise.resolve(null) : Promise.reject(error); }
  }
  return fs.stat(file).then(stampOf, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
};
const cache = new Map<string, { identity: string; history: History }>();
async function loadSidecar(file: string): Promise<History | null> {
  const identity = await stamp(file);
  if (!identity) return null;
  const cached = cache.get(file);
  if (cached?.identity === identity) return structuredClone(cached.history);
  const raw = await fs.readFile(file, "utf8").then(text => JSON.parse(text) as History).catch(() => null);
  if (raw?.format !== FORMAT || !Array.isArray(raw.path) || !raw.path.length || !Number.isInteger(raw.current) || raw.path[raw.cursor] !== raw.current) {
    // Never stuck: an unreadable history is kept aside for recovery and rebuilt from the edit file.
    // Snapshots are untouched; only the undo path and hand-saved names start again.
    await withShootWriter(path.resolve(path.dirname(file), "../../.."), () => fs.rename(file, `${file}.unreadable-${Date.now()}`)).catch(error => { if (!(error instanceof WriterBusyError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    console.warn(`[revisions] rebuilt an unreadable undo history: ${path.basename(file)}`);
    return null;
  }
  cache.set(file, { identity, history: structuredClone(raw) });
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  return raw;
}
async function saveSidecar(file: string, history: History): Promise<void> {
  const root = path.resolve(path.dirname(file), "../../..");
  if (ownsOpenShoot(root)) {
    saveOwnedSidecar(file, history);
    return;
  }
  try { await withShootWriter(root, () => writeJsonAtomic(file, history, undefined, 2)); }
  catch (error) { if (error instanceof WriterBusyError) return; throw error; }
  const identity = await stamp(file);
  if (identity) cache.set(file, { identity, history: structuredClone(history) });
}
function saveOwnedSidecar(file: string, history: History): void {
  // A few KB, under the retained shoot lease and history queue. Do not yield
  // to a whole-shoot refresh between moving the cursor and saving it.
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fsSync.writeFileSync(temporary, JSON.stringify(history, null, 2) + "\n", { flag: "wx" }); fsSync.renameSync(temporary, file); }
  finally { try { fsSync.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  cache.set(file, { identity: stampOf(fsSync.statSync(file)), history: structuredClone(history) });
}

// ---- Reading what the edit file holds, without hydrating any assembly.
async function readInfo(root: string, cutId: string): Promise<CutWriteInfo & { createdAt: Map<number, string> }> {
  const raw = JSON.parse(await fs.readFile(cutPath(root, cutId), "utf8")) as { versions?: { version: number; createdAt?: string; baseVersion?: number }[]; exported?: { version: number; at?: string }[] };
  const versions = (raw.versions ?? []).map(v => v.version).filter(Number.isInteger);
  return { versions, bases: Object.fromEntries((raw.versions ?? []).filter(v => v.baseVersion !== undefined).map(v => [v.version, v.baseVersion!])), exported: raw.exported ?? [], createdAt: new Map((raw.versions ?? []).map(v => [v.version, v.createdAt ?? ""])) };
}
async function precutDrafts(root: string, cutId: string): Promise<Set<number>> {
  // The thread records every draft precut made (message.cut). That is a fact, not a guess from wording.
  const thread = await fs.readFile(path.join(path.resolve(root), ".sidething/sidekick/thread.json"), "utf8")
    .then(text => JSON.parse(text) as { cut?: { cutId?: string; version?: number } }[], () => []);
  return new Set(thread.flatMap(m => m?.cut?.cutId === cutId && Number.isInteger(m.cut.version) ? [m.cut.version!] : []));
}

/** Run once, lazily, on first open: v1..vN stay untouched; exported versions, v1 and precut's
 * drafts become milestones; the undo path starts with just current. No past order is invented. */
async function migrate(root: string, cutId: string, info: CutWriteInfo & { createdAt?: Map<number, string> }): Promise<History> {
  const versions = [...new Set(info.versions)].sort((a, b) => a - b);
  if (!versions.length) throw new Error("This edit has no saved versions yet.");
  // versions.at(-1) stays: migration starts current at the newest snapshot (spec, "Migration").
  const latest = versions.at(-1)!, drafts = await precutDrafts(root, cutId), now = new Date().toISOString();
  // No stored "last opened version" exists in main today (the renderer keeps only the open edit id),
  // so current starts as the latest snapshot.
  const history: History = { format: FORMAT, cutId, current: latest, path: [latest], cursor: 0, milestones: [], seen: latest, epoch: 0,
    cutStamp: null, migrated: { at: now, versions: versions.length, latest, current: "latest" } };
  const at = (v: number) => info.createdAt?.get(v) || now;
  addMilestone(history, { version: versions[0], kind: "draft", name: drafts.has(versions[0]) ? "Draft by precut" : "First version", at: at(versions[0]) });
  for (const v of versions) if (drafts.has(v) && v !== versions[0]) addMilestone(history, { version: v, kind: "draft", name: "Draft by precut", at: at(v) });
  noteExports(history, info.exported ?? []);
  return history;
}
function addMilestone(history: History, milestone: RevisionMilestone): RevisionMilestone {
  const existing = history.milestones.find(m => m.version === milestone.version && m.kind === milestone.kind);
  if (existing) { existing.name = milestone.name; existing.at = milestone.at; return existing; }
  history.milestones.push(milestone);
  history.milestones.sort((a, b) => a.version - b.version || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  return milestone;
}
function noteExports(history: History, exported: { version: number; at?: string }[]) {
  for (const entry of exported) if (Number.isInteger(entry?.version) && !history.milestones.some(m => m.version === entry.version && m.kind === "export"))
    addMilestone(history, { version: entry.version, kind: "export", name: "Exported", at: entry.at || new Date().toISOString() });
}

// ---- Placing snapshots on the undo path.
/** A new snapshot becomes current. Editing after an undo discards the redo path (the snapshots stay). */
function place(history: History, version: number, base?: number) {
  if (base !== undefined && base !== history.current) {
    const at = history.path.lastIndexOf(base);
    // The renderer's own undo (until VO7 stage 3) opens an earlier number and edits it.
    if (at >= 0 && at <= history.cursor) history.cursor = at;
    // Off the path, or an undone step (a version reopened from the redo side): it goes after current, so ⌘Z
    // from the new snapshot returns to the version it was made on, as the screen does.
    else { history.path = [...history.path.slice(0, history.cursor + 1), base]; history.cursor = history.path.length - 1; }
  }
  history.path = [...history.path.slice(0, history.cursor + 1), version];
  if (history.path.length > PATH_LIMIT) history.path = history.path.slice(-PATH_LIMIT);
  history.cursor = history.path.length - 1;
  history.current = version;
  history.seen = Math.max(history.seen, version);
  if (history.followOns) {
    const kept = new Set(history.path);
    for (const v of Object.keys(history.followOns).map(Number)) if (!kept.has(v)) delete history.followOns[v];
    if (!Object.keys(history.followOns).length) delete history.followOns;
  }
}
// FIX4: a position whose next step is its follow-on is not a stop of its own: ⌘Z and ⌘⇧Z pass over it.
const absorbed = (h: History, i: number) => i + 1 < h.path.length && h.followOns?.[h.path[i + 1]] === h.path[i];
/** Where ⌘Z (-1) or ⌘⇧Z (1) lands from the cursor; -1 or path.length when there is nowhere to go. */
function stepTo(h: History, step: -1 | 1): number {
  let to = h.cursor + step;
  while (to >= 0 && to < h.path.length && absorbed(h, to)) to += step;
  return to;
}
const state = (h: History): RevisionState => {
  const back = stepTo(h, -1), forward = stepTo(h, 1);
  return { version: h.current, cursor: h.cursor, canUndo: back >= 0, canRedo: forward < h.path.length,
    undoTo: h.path[back] ?? null, redoTo: h.path[forward] ?? null };
};

// ---- Ownership of in-flight commits. A snapshot written inside a commit waits for that commit
// to publish it. Any other write (a background job, a writer outside the hand-edit queue) becomes current
// at once only when it was built on the current revision; one built on any other revision stays hidden.
interface Owner { key: string; token: symbol }
const owning = new AsyncLocalStorage<Owner>();
// FIX4: a background job that only completes one revision (captions realigned to the voice it already has).
const following = new AsyncLocalStorage<{ key: string; base: number }>();
/** Run work whose new snapshot completes `base`: when it lands while base is current, ⌘Z takes back the edit that made
 * base and this together, in one step, and the redo path is untouched by it. Elsewhere it is an ordinary write. */
export function followOn<T>(root: string, cutId: string, base: number, work: () => Promise<T>): Promise<T> {
  return following.run({ key: keyOf(path.resolve(root), cutId), base }, work);
}
const active = new Set<symbol>();
const unplaced = new Map<string, { version: number; base: number; token: symbol }[]>();
function takeOwned(key: string, token: symbol): number[] {
  const list = unplaced.get(key) ?? [];
  const mine = list.filter(e => e.token === token).map(e => e.version);
  const rest = list.filter(e => e.token !== token);
  if (rest.length) unplaced.set(key, rest); else unplaced.delete(key);
  return [...new Set(mine)].sort((a, b) => a - b);
}

// VO7-19: snapshots refused by apply, until their writer asks (refusedWrite): version -> the conflict.
const refused = new Map<string, Map<number, RevisionConflict>>();
/** A snapshot this process just wrote outside any commit and apply kept hidden: its writer's conflict, once. */
export function refusedWrite(root: string, cutId: string, version: number): RevisionConflict | null {
  const key = keyOf(path.resolve(root), cutId), list = refused.get(key), conflict = list?.get(version) ?? null;
  if (list && conflict) { list.delete(version); if (!list.size) refused.delete(key); }
  return conflict;
}

function apply(history: History, info: CutWriteInfo, cutStamp: string | null, key: string, owner?: Owner) {
  const known = new Set(info.versions), latest = Math.max(0, ...info.versions);
  if (latest && (latest < history.seen || !known.has(history.current))) {
    // The file was replaced by an older copy (a restore from the trash or a backup): keep what still exists.
    history.path = history.path.filter(v => known.has(v));
    if (!history.path.length) history.path = [latest];
    const at = history.path.lastIndexOf(history.current);
    history.cursor = at >= 0 ? at : history.path.length - 1; history.current = history.path[history.cursor];
    history.milestones = history.milestones.filter(m => known.has(m.version));
    history.seen = latest;
  }
  const fresh = [...new Set(info.versions.filter(v => v > history.seen))].sort((a, b) => a - b);
  if (fresh.length) {
    for (const v of fresh) if (!Number.isInteger(info.bases?.[v])) throw new Error("Every saved edit must name its base version.");
    history.seen = Math.max(history.seen, ...fresh);
    if (owner && active.has(owner.token)) unplaced.set(owner.key, [...unplaced.get(owner.key) ?? [], ...fresh.map(version => ({ version, base: info.bases![version], token: owner.token }))]);
    else for (const v of fresh) {
      // VO7-19: a result computed on a revision that is no longer current (it read its base before a newer
      // edit, an undo or a redo landed) never becomes current over it. It stays a hidden revision; its writer
      // learns of it through refusedWrite. Every new snapshot must name its base.
      const base = info.bases?.[v];
      if (base !== undefined && base !== history.current) {
        const list = refused.get(key) ?? new Map<number, RevisionConflict>();
        list.set(v, conflictOf(where(history, base) === "ahead" ? "undone" : "stale", base, history.current));
        while (list.size > 64) list.delete(list.keys().next().value!);
        refused.set(key, list);
        console.warn(`[revisions] kept v${v} hidden: it was built on v${base}, and v${history.current} is current`);
        continue;
      }
      // FIX4: work that only completes the current step (captions realigned after his edit) joins that step.
      const follow = following.getStore();
      const joins = follow?.key === key && follow.base === base && base === history.current;
      place(history, v);
      if (joins) history.followOns = { ...history.followOns, [v]: base! };
    }
  }
  noteExports(history, info.exported ?? []);
  history.cutStamp = cutStamp;
}

/** Caller holds the history lock. Migrates lazily and accounts for writes this process did not see. */
async function ensure(root: string, cutId: string): Promise<History | null> {
  const file = historyFile(root, cutId), known = cache.get(file);
  if (known && ownsOpenShoot(root)) {
    // All writers in this retained shoot report through noteCutWrite. Its
    // queued publication, rather than an uncommitted file stamp, is the truth.
    try { if (stampOf(fsSync.statSync(file)) === known.identity) return structuredClone(known.history); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const cutStampNow = await stamp(cutPath(root, cutId));
  let history = await loadSidecar(file);
  if (!history) {
    if (!cutStampNow) return null;
    history = await migrate(root, cutId, await readInfo(root, cutId));
    history.cutStamp = cutStampNow;
    await saveSidecar(file, history);
    return history;
  }
  if (cutStampNow && history.cutStamp !== cutStampNow) {
    apply(history, await readInfo(root, cutId), cutStampNow, keyOf(root, cutId), owning.getStore()?.key === keyOf(root, cutId) ? owning.getStore() : undefined);
    await saveSidecar(file, history);
  }
  return history;
}
async function required(root: string, cutId: string): Promise<History> {
  const history = await ensure(root, cutId);
  if (!history) throw new Error(`The saved edit file is missing: ${cutId}.json. Restore the edit or make a new one.`);
  return history;
}

/** Every edit write reports its explicit bases. Persisted bases also recover a missed note after a crash. */
export async function noteCutWrite(root: string, cutId: string, info: CutWriteInfo): Promise<void> {
  const key = keyOf(root, cutId), owner = owning.getStore();
  await locked(key, async () => {
      const file = historyFile(root, cutId), cutStampNow = await stamp(cutPath(root, cutId));
      let history = await loadSidecar(file);
      if (!history) { history = await migrate(root, cutId, info); history.cutStamp = cutStampNow; }
      else apply(history, info, cutStampNow, key, owner?.key === key ? owner : undefined);
      await saveSidecar(file, history);
  });
}

// ---- Public API.
export async function current(root: string, cutId: string): Promise<RevisionState> {
  return locked(keyOf(root, cutId), async () => state(await required(root, cutId)));
}
const sidecarSyncs = new Map<string, Set<Promise<void>>>();
function trackSidecar(root: string, pending: Promise<void>) {
  const group = sidecarSyncs.get(root) ?? new Set<Promise<void>>();
  group.add(pending); sidecarSyncs.set(root, group); void trackSave(pending);  // FIX2: quit waits for it
  void pending.then(() => { group.delete(pending); if (!group.size) sidecarSyncs.delete(root); });
}
/** Derived voice writes hold their own writer lease. Teardown can drain them. */
export async function waitForRevisionSidecars(root?: string): Promise<void> {
  do {
    const pending = root ? [...sidecarSyncs.get(path.resolve(root)) ?? []] : [...sidecarSyncs.values()].flatMap(set => [...set]);
    if (!pending.length) return;
    await Promise.all(pending);
  } while (true);
}
async function syncMovedVoice(root: string, cutId: string): Promise<void> {
  root = path.resolve(root);
  const pending = (await sidekick()).detachedEditWork(() => withShootWriter(root, async () => {
    await (await import("./voiceover-script")).syncVoiceoverSidecar(root, cutId);
  })).catch(error => { console.warn("[voiceover]", error); });
  trackSidecar(root, pending);
  return pending;
}
function moveOwned(root: string, cutId: string, step: -1 | 1): RevisionState | null {
  root = path.resolve(root);
  if (!ownsOpenShoot(root) || locks.has(keyOf(root, cutId))) return null;
  const file = historyFile(root, cutId), known = cache.get(file);
  if (!known) return null;
  try { if (stampOf(fsSync.statSync(file)) !== known.identity) return null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const history = structuredClone(known.history), to = stepTo(history, step);  // FIX4: a follow-on moves with its step
  if (to < 0 || to >= history.path.length) return state(history);
  history.cursor = to; history.current = history.path[to]; history.epoch++;
  // No other history job owns the queue, and this synchronous transaction
  // finishes before another job can enter. The existing retained lease is held.
  saveOwnedSidecar(file, history);
  const pending = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    await (await sidekick()).detachedEditWork(() => withShootWriter(root, async () => {
      await (await import("./voiceover-script")).syncVoiceoverSidecar(root, cutId);
    }));
  }).catch(error => { console.warn("[voiceover]", error); });
  trackSidecar(root, pending);
  return state(history);
}
async function move(root: string, cutId: string, step: -1 | 1): Promise<RevisionState> {
  let moved = false;
  const result = await locked(keyOf(root, cutId), async () => {
    const history = await required(root, cutId), to = stepTo(history, step);  // FIX4: a follow-on moves with its step
    if (to < 0 || to >= history.path.length) return state(history);
    history.cursor = to; history.current = history.path[to]; history.epoch++;
    await saveSidecar(historyFile(root, cutId), history);
    moved = true;
    return state(history);
  });
  // The cursor is durable. Voice is derived from it under independent ownership.
  // The acknowledgement waits briefly for that derivation (about 10 ms when the
  // writer queue is free, so a caller reading the sidecar next sees the revision
  // undo landed on), but never queues behind a held writer: the tracked sync
  // still lands, and waitForRevisionSidecars drains it. The owned renderer
  // path (moveOwned) keeps its immediate ack; its lane already shows the move.
  if (moved) await Promise.race([syncMovedVoice(root, cutId), new Promise(resolve => setTimeout(resolve, 100))]);
  return result;
}
/** ⌘Z: moves the cursor back along the undo path. Touches only the sidecar. */
export const undo = async (root: string, cutId: string) => {
  const saved = moveOwned(root, cutId, -1);
  return saved ?? trackSave(withShootWriter(root, () => move(root, cutId, -1)));  // FIX2: quit waits for it
};
/** ⌘⇧Z: moves it forward again, until an edit discards the redo path. */
export const redo = async (root: string, cutId: string) => {
  const saved = moveOwned(root, cutId, 1);
  return saved ?? trackSave(withShootWriter(root, () => move(root, cutId, 1)));  // FIX2: quit waits for it
};

export async function markMilestone(root: string, cutId: string, version: number, mark: { kind: MilestoneKind; name: string }): Promise<RevisionMilestone> {
  if (!KINDS.includes(mark?.kind)) throw new Error("Choose a draft, before-auto, export or saved version.");
  const name = typeof mark.name === "string" ? mark.name.trim() : "";
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Give the version a name up to 120 characters.");
  return trackSave(withShootWriter(root, () => locked(keyOf(root, cutId), async () => {  // FIX2: quit waits for it
    const history = await required(root, cutId);
    if (!Number.isInteger(version) || version < 1 || version > history.seen) throw new Error("That edit version does not exist.");
    const milestone = addMilestone(history, { version, kind: mark.kind, name, at: new Date().toISOString() });
    await saveSidecar(historyFile(root, cutId), history);
    return { ...milestone };
  })));
}
/** ARCH2: the versions on the undo path within `steps` of the cursor (the current one included), for listings to carry in full. */
export async function nearbyRevisions(root: string, cutId: string, steps: number): Promise<number[]> {
  return locked(keyOf(root, cutId), async () => {
    const h = await ensure(root, cutId);
    return h ? h.path.slice(Math.max(0, h.cursor - steps), h.cursor + steps + 1) : [];
  });
}
export async function listMilestones(root: string, cutId: string): Promise<RevisionMilestone[]> {
  return locked(keyOf(root, cutId), async () => (await required(root, cutId)).milestones.map(m => ({ ...m })));
}
/** ⌘S, "Save version": the current revision becomes a named milestone. */
export async function saveVersion(root: string, cutId: string, name?: string): Promise<RevisionMilestone> {
  const { version } = await current(root, cutId);
  return markMilestone(root, cutId, version, { kind: "saved", name: typeof name === "string" && name.trim() ? name : "Saved version" });
}

// ---- Conflicts and retries.
const MESSAGES: Record<RevisionConflict["reason"], string> = {
  undone: "Something else changed this edit. Try again.",
  stale: "Something else changed this edit. Try again.",
  changed: "Something else changed this edit. Try again.",
};
export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
  constructor(readonly conflict: RevisionConflict) { super(conflict.message); }
}
const conflictOf = (reason: RevisionConflict["reason"], expected: number, currentVersion: number): RevisionConflict =>
  ({ reason, expected, current: currentVersion, message: MESSAGES[reason] });
/** Where `version` sits relative to the cursor: an undone step, an earlier step, or off the path. */
function where(h: Pick<History, "path" | "cursor">, version: number): "ahead" | "behind" | "absent" {
  const at = h.path.lastIndexOf(version);
  return at < 0 ? "absent" : at > h.cursor ? "ahead" : "behind";
}

/** Refuse an unowned snapshot before its bytes land. Owned commits check again when publishing. */
export async function assertBase(root: string, cutId: string, base: number): Promise<void> {
  if (!Number.isInteger(base)) throw new Error("Every saved edit must name its base version.");
  await locked(keyOf(root, cutId), async () => {
    const h = await required(root, cutId);
    if (h.current !== base) throw new RevisionConflictError(conflictOf(where(h, base) === "ahead" ? "undone" : "stale", base, h.current));
  });
}

/** What an edit touches: the identities and source ranges of its targets. A stale write retries on
 * the current revision only when this is unchanged between the revision it was made on and current. */
export function editTargets(edit: CutEdit, record: StoredVersion): string {
  const pieces = record.pieces ?? [];
  const piece = (i: number) => { const p = pieces[i]; return p ? [i, p.id, p.kind, p.clipId, p.s, p.e, p.removed ?? null] : [i, null]; };
  const spine = () => pieces.map((_, i) => piece(i));
  const lines = record.voiceover?.lines ?? [];
  const line = (id: string) => { const l = lines.find(x => x.id === id); return l ? [l.id, l.s, l.take ?? null] : [id, null]; };
  const voice = () => lines.map(l => [l.id, l.s, l.take ?? null]);
  const byId = (items: { id: string }[] | undefined, id: string) => items?.find(item => item.id === id) ?? null;
  const parts = (e: CutEdit): unknown => {
    switch (e.kind) {
      case "batch": return e.edits.map(parts);
      case "laneLevel": return ["lane", e.lane];
      case "cover": return ["cover"];
      case "autoLayouts": return ["autoLayouts"];
      case "format": return ["format", e.aspect];
      // Ripple (voice-edit.ts, not yet in the CutEdit union) moves every later piece, so it depends on all voice.
      case "voiceover": {
        const v = e as { op: string; line: string; lines?: string[] };
        if (v.op === "placeAsIs" || v.op === "ripple") return ["voice", voice()];
        // SCRIPT1: a Script panel voice cut or restore reads every piece and the kept cuts.
        if (v.op === "cutWords" || v.op === "restoreCut") return ["voice", voice(), record.voiceCuts ?? null];
        // VO7-10: a multi-piece remove depends on every piece it deletes, not just the first.
        // VO7-13: so does a group move, on every piece it moves.
        if (v.op === "remove" || v.op === "move" && v.lines?.length) return ["lines", [...new Set([v.line, ...(v.lines ?? [])])].map(line)];
        return ["line", line(v.line)];
      }
      case "overlay": return e.op === "add" ? ["overlays", (record.overlays ?? []).map(o => o.id)] : ["overlay", byId(record.overlays, e.id)];
      case "lowerThird": return e.op === "add" ? ["lowerThirds", (record.lowerThirds ?? []).map(o => o.id)] : ["lowerThird", byId(record.lowerThirds, e.id)];
      case "sfx": return e.op === "add" ? ["sfx", (record.sfx ?? []).map(o => o.id)] : ["sfx", byId(record.sfx, e.id)];
      case "join": return ["join", piece(e.join), piece(e.join + 1)];
      case "clipSound": return e.piece === undefined ? ["clip-sound"] : ["piece", piece(e.piece)];
      case "cutWords": case "bleep": return [...new Set(e.spans.map(s => s.piece))].map(piece);
      case "transform": case "duplicate": return e.pieces.map(piece);
      // SCRIPT1: restoring a whole cut piece depends on that cut piece and the spine it goes back into.
      case "restoreWords": return e.cut ? ["cutPiece", e.cut, (record.cutPieces ?? []).find(t => t.id === e.cut) ?? null, spine()] : ["piece", piece(e.piece)];
      case "move": case "trim": case "swap": case "remove": case "keepFiller": case "split": case "pieceFx": case "layout": case "replace":
        return ["piece", piece(e.piece)];
      // Edits placed by reel time, or that touch everything, depend on the whole spine and voice.
      default: return ["all", spine(), voice()];
    }
  };
  return JSON.stringify(parts(edit));
}

type Sidekick = typeof import("./sidekick");
const sidekick = (): Promise<Sidekick> => import("./sidekick");

/** The commit primitive. Under the existing cut lock: checks `expected` against current, builds the
 * next immutable snapshot with make(base), appends it, moves current to it and truncates the redo
 * path (its snapshots stay). A stale `expected` retries on current only when `targets` is unchanged. */
export async function commit(root: string, cutId: string, options: {
  expected: number;
  make: (base: StoredVersion, next: number) => Promise<StoredVersion>;
  targets?: (record: StoredVersion) => string;
}): Promise<CommitResult> {
  if (!Number.isInteger(options.expected)) throw new Error("Every saved edit must name its base version.");
  root = path.resolve(root);
  const key = keyOf(root, cutId), sk = await sidekick(), token = Symbol("commit");
  return sk.withShootLock(sk.cutFile(root, cutId), async () => {
    active.add(token);
    try {
      const pre = await locked(key, async () => { const h = await required(root, cutId); return { current: h.current, epoch: h.epoch, path: [...h.path], cursor: h.cursor }; });
      let base = options.expected;
      if (base !== pre.current) {
        const position = where(pre, base);
        if (position === "ahead") return { ok: false, conflict: conflictOf("undone", base, pre.current) };
        if (position === "absent" || !options.targets) return { ok: false, conflict: conflictOf("stale", base, pre.current) };
        const [was, now] = await Promise.all([sk.loadRevision(root, cutId, base, { light: true }), sk.loadRevision(root, cutId, pre.current, { light: true })]);
        if (options.targets(was) !== options.targets(now)) return { ok: false, conflict: conflictOf("changed", base, pre.current) };
        base = pre.current;
      }
      const baseRecord = await sk.loadRevision(root, cutId, base);
      const written = await owning.run({ key, token }, () => sk.appendRevision(root, cutId, baseRecord, options.make));
      const outcome = await locked(key, async (): Promise<CommitResult> => {
        const history = await required(root, cutId), mine = takeOwned(key, token);
        if (history.epoch !== pre.epoch || history.current !== base) {
          // The snapshot stays as a hidden revision; it never becomes current by itself.
          return { ok: false, conflict: conflictOf(history.epoch !== pre.epoch ? "undone" : "stale", base, history.current) };
        }
        for (const v of mine.includes(written) ? mine : [...mine, written].sort((a, b) => a - b)) place(history, v, v === written ? base : undefined);
        await saveSidecar(historyFile(root, cutId), history);
        return { ok: true, version: written };
      });
      if (outcome.ok) sk.changed(root);
      return outcome;
    } finally { await release(root, cutId, token); }
  });
}
async function release(root: string, cutId: string, token: symbol) {
  active.delete(token);
  const key = keyOf(root, cutId);
  if (!(unplaced.get(key) ?? []).some(e => e.token === token)) return;
  // A commit that failed after writing: its snapshots stay hidden revisions.
  await locked(key, async () => { takeOwned(key, token); });
}

/** Every edit checks its explicit base. Hand edits can retry against unchanged targets. */
export async function commitEdit<T extends { cutId: string; version: number; baseVersion?: number }>(root: string, cutId: string, base: number,
  options: { strict?: boolean; edit?: CutEdit; targets?: (record: StoredVersion) => string }, run: (base: number) => Promise<T>): Promise<T> {
  root = path.resolve(root);
  if (!Number.isInteger(base)) throw new Error("Every saved edit must name its base version.");
  const key = keyOf(root, cutId), outer = owning.getStore();
  // Nested edits inside one commit (a transform that becomes a batch) belong to that commit.
  if (outer?.key === key && active.has(outer.token)) return run(base);
  const token = Symbol("edit");
  active.add(token);
  try {
    for (let attempt = 0; ; attempt++) {
      const pre = await locked(key, async () => { const h = await ensure(root, cutId); return h && { current: h.current, epoch: h.epoch, path: [...h.path], cursor: h.cursor }; });
      // A missing edit keeps today's error from the edit's own read.
      if (!pre) return await owning.run({ key, token }, () => run(base));
      let from = base;
      if (base !== pre.current) {
        const position = where(pre, base);
        if (position === "ahead") throw new RevisionConflictError(conflictOf("undone", base, pre.current));
        from = await retryBase(root, cutId, position, base, pre.current, options.edit, options.targets);
      }
      const result = await owning.run({ key, token }, () => run(from));
      const basedOn = unplaced.get(key)?.find(entry => entry.token === token && entry.version === result.version)?.base ?? result.baseVersion ?? from;
      // The ordered playback queue may already have replayed this hand edit on its
      // preceding save. Validate those targets and publish the base it actually read.
      if (basedOn !== from) await retryBase(root, cutId, "behind", from, basedOn, options.edit, options.targets);
      const outcome = await locked(key, async (): Promise<"done" | "retry" | RevisionConflict> => {
        const history = await ensure(root, cutId), mine = takeOwned(key, token);
        if (!history) return "done";  // the edit was deleted meanwhile; nothing to publish onto
        // A returned number nobody wrote (or one already placed) is never put on the path.
        const fresh = result.version !== basedOn && result.version <= history.seen && !history.path.includes(result.version);
        if (!mine.length && !fresh) return "done";  // unchanged: nothing new to publish
        if (history.epoch !== pre.epoch) return conflictOf("undone", from, history.current);
        if (history.current !== basedOn) return attempt < 2 ? "retry" : conflictOf("stale", basedOn, history.current);
        for (const v of [...new Set([...mine, ...(fresh ? [result.version] : [])])].sort((a, b) => a - b)) place(history, v, v === result.version ? basedOn : undefined);
        await saveSidecar(historyFile(root, cutId), history);
        return "done";
      });
      if (outcome === "done") return Object.assign(result, { baseVersion: basedOn });
      if (outcome !== "retry") throw new RevisionConflictError(outcome);
      // Another commit landed while this one ran: retry on it, under the same target rule.
      base = from;
    }
  } finally { await release(root, cutId, token); }
}
async function retryBase(root: string, cutId: string, position: "behind" | "absent", base: number, currentVersion: number, edit?: CutEdit, namedTargets?: (record: StoredVersion) => string): Promise<number> {
  const targets = namedTargets ?? (edit ? (record: StoredVersion) => editTargets(edit, record) : undefined);
  if (position === "absent" && !namedTargets || !targets) throw new RevisionConflictError(conflictOf("stale", base, currentVersion));
  const sk = await sidekick();
  const [was, now] = await Promise.all([sk.loadRevision(root, cutId, base, { light: true }), sk.loadRevision(root, cutId, currentVersion, { light: true })]);
  if (targets(was) !== targets(now)) throw new RevisionConflictError(conflictOf("changed", base, currentVersion));
  return currentVersion;
}

/** One undoable commit whose content equals that milestone. Renders are rebuilt, not shared. */
export async function restore(root: string, cutId: string, milestoneVersion: number): Promise<CommitResult> {
  root = path.resolve(root);
  const milestones = await listMilestones(root, cutId), milestone = milestones.find(m => m.version === milestoneVersion);
  if (!milestone) throw new Error("Choose one of this edit's saved versions to restore.");
  const sk = await sidekick(), { version: expected } = await current(root, cutId);
  const make = async (base: StoredVersion, next: number): Promise<StoredVersion> => {
    const saved = await sk.loadRevision(root, cutId, milestoneVersion);
    const record: StoredVersion = { ...structuredClone(saved), version: next, createdAt: new Date().toISOString(),
      feedback: `Restored v${milestoneVersion}`, preview: null, finished: null };
    // The voiceover belongs to this revision now, so later saves keep it rather than retiming another.
    if (record.voiceover) record.voiceover = { ...record.voiceover, version: next };
    // Its kept beats are the milestone's own, not a walk from the revision it replaces.
    if (record.keptBeats) record.keptBeatOrigin = next;
    await sk.prepareStoredPreview(root, cutId, record, record.assembly, base);
    return record;
  };
  const withScript = (await sk.loadRevision(root, cutId, milestoneVersion)).voiceover;
  if (!withScript?.lines.length) return commit(root, cutId, { expected, make });
  // The voiceover sidecar is what later saves retime onto new versions; it follows the restored one.
  const { saveHandVoiceover } = await import("./voiceover-script");
  let refused: CommitResult | undefined;
  try {
    return await saveHandVoiceover(root, cutId, async () => {
      const result = await commit(root, cutId, { expected, make });
      // A conflict leaves the sidecar exactly as it was: throwing skips its write.
      if (!result.ok) { refused = result; throw result.conflict; }
      return { script: (await sk.loadRevision(root, cutId, result.version)).voiceover!, result };
    });
  } catch (error) { if (refused) return refused; throw error; }
}
// ---- VO7-2: every writer acts on the current revision.
/** The version to act on: the current revision, never simply the newest snapshot. */
export async function currentVersion(root: string, cutId: string): Promise<number> {
  return (await current(path.resolve(root), cutId)).version;
}
/** An optional version from a caller (MCP, CLI, sidekick): the one given, or the current revision.
 * `newest` is the caller's own listing of the edit: an edit with no file on disk has no history to undo,
 * so its current version is its newest (the migration rule); with a file, history always decides. */
export async function versionOr(root: string, cutId: string, version: number | undefined | null, newest?: number): Promise<number> {
  if (typeof version === "number") return version;
  if (newest !== undefined && ID.test(cutId) && !await stamp(cutPath(root, cutId))) return newest;
  return currentVersion(root, cutId);
}
/** The newest snapshot number in a listing (for versionOr's no-file rule; never the version to act on by itself). */
export const newestListed = (cut: { versions: { version: number }[] } | undefined | null): number | undefined =>
  cut?.versions.length ? cut.versions.reduce((n, v) => Math.max(n, v.version), 0) : undefined;

/** A background job's pin: the revision it computes against, what was current then, and the undo epoch. */
export interface RevisionPin { cutId: string; version: number; current: number; epoch: number }
/** Pin a revision for a background job (Auto correct, Make it better). Omit version for the current one. */
export async function pinRevision(root: string, cutId: string, version?: number): Promise<RevisionPin> {
  root = path.resolve(root);
  return locked(keyOf(root, cutId), async () => {
    const h = await required(root, cutId);
    return { cutId, version: version ?? h.current, current: h.current, epoch: h.epoch };
  });
}
/** The same pin, moved on to a result the job itself just published (a second round builds on its first). */
export const advancePin = (pin: RevisionPin, version: number): RevisionPin => ({ ...pin, version, current: version });
/** VO7-19: whether this async context is inside a commit of that edit (its writes are the commit's to publish). */
export function insideCommit(root: string, cutId: string): boolean {
  const owner = owning.getStore();
  try { return !!owner && owner.key === keyOf(path.resolve(root), cutId) && active.has(owner.token); } catch { return false; }
}
/** Work started from inside a commit that must not belong to it (a detached background job). */
export const outsideCommit = <T>(work: () => T): T => owning.exit(work);
export const isRevisionConflict = (error: unknown): error is RevisionConflictError => (error as { code?: string } | null)?.code === "REVISION_CONFLICT";

/** A background job's commit, with expected = its pinned revision. A result computed before an undo or
 * redo never publishes by itself: the snapshot stays a hidden revision and the job gets a conflict.
 * When another commit landed since the pin, it is a conflict too, unless `onCurrent` (the job's own
 * per-target checks make it safe to land on the current revision; Auto correct's per-clip guards). */
export async function commitPinned<T extends { cutId: string; version: number; baseVersion?: number } | null>(root: string, cutId: string, pin: RevisionPin,
  options: { onCurrent?: boolean }, run: (base: number) => Promise<T>): Promise<T> {
  root = path.resolve(root);
  const key = keyOf(root, cutId), outer = owning.getStore();
  if (outer?.key === key && active.has(outer.token)) return run(pin.version);
  const token = Symbol("pinned");
  active.add(token);
  try {
    const base = await locked(key, async () => {
      const h = await required(root, cutId);
      if (h.epoch !== pin.epoch || where(h, pin.version) === "ahead") throw new RevisionConflictError(conflictOf("undone", pin.version, h.current));
      if (h.current === pin.version) return pin.version;
      if (!options.onCurrent) throw new RevisionConflictError(conflictOf("stale", pin.version, h.current));
      return h.current;
    });
    const result = await owning.run({ key, token }, () => run(base));
    const conflict = await locked(key, async (): Promise<RevisionConflict | null> => {
      const h = await ensure(root, cutId), actualBase = result && unplaced.get(key)?.find(entry => entry.token === token && entry.version === result.version)?.base, mine = takeOwned(key, token);
      if (!h || !result) return null;
      const from = actualBase ?? result.baseVersion ?? base;
      const fresh = result.version !== from && result.version <= h.seen && !h.path.includes(result.version);
      if (!mine.length && !fresh) return null;
      // The snapshot stays a hidden revision; it never becomes current by itself.
      if (h.epoch !== pin.epoch || where(h, from) === "ahead") return conflictOf("undone", from, h.current);
      if (h.current !== from) return conflictOf("stale", from, h.current);
      for (const v of [...new Set([...mine, ...(fresh ? [result.version] : [])])].sort((a, b) => a - b)) place(h, v, v === result.version ? from : undefined);
      await saveSidecar(historyFile(root, cutId), h);
      return null;
    });
    if (conflict) throw new RevisionConflictError(conflict);
    return result;
  } finally { await release(root, cutId, token); }
}

/** IPC: restore, throwing the conflict's plain message. */
export async function restoreVersion(root: string, cutId: string, version: number): Promise<{ cutId: string; version: number }> {
  const result = await restore(root, cutId, version);
  if (!result.ok) throw new RevisionConflictError(result.conflict);
  return { cutId, version: result.version };
}
