import { withShootWriter, WriterBusyError } from "./writer-lock";
import { clipName } from "../shared/clip-name";
// Disk-only edit representation. App code always receives full assemblies.
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Clip, Shoot } from "../shared/schema";
import type { StoredCut, StoredVersion } from "./sidekick";
import type { Segment } from "./export";
import { withLayoutMedia } from './layout-media';

type ClipRef = { id: string; snapshot?: string };
type ShootRef = { index: true } | { snapshot: string };
type SlimSegment = Omit<Segment, "clip"> & { clip: ClipRef };
type Assembly = StoredVersion["assembly"];
type SlimAssembly = Omit<Assembly, "shoot" | "cutList" | "reel"> & {
  shoot: ShootRef;
  cutList: (Omit<Assembly["cutList"][number], "seg"> & { seg: SlimSegment | null })[];
  reel: Omit<Assembly["reel"], "broll"> & { broll: (Omit<Assembly["reel"]["broll"][number], "seg"> & { seg: SlimSegment })[] };
};
type ShootSnapshot = Omit<Shoot, "clips"> & { clips: ClipRef[] };
interface SlimCut extends Omit<StoredCut, "versions"> {
  storage: { format: "slim-v1"; clips: Record<string, Clip>; shoots: Record<string, ShootSnapshot> };
  versions: (Omit<StoredVersion, "assembly"> & { assembly: SlimAssembly })[];
}
function isSlim(cut: StoredCut | SlimCut): cut is SlimCut {
  return "storage" in cut && cut.storage?.format === "slim-v1";
}
export function isStoredCut(value: unknown): value is StoredCut {
  return !!value && typeof value === "object" && "cutId" in value && "versions" in value && Array.isArray(value.versions);
}

/** Only clip/shoot metadata follows the index, just as freshen() already does.
 * Source spans, template, reel, words and every finishing field stay verbatim. */
export function slimCut(cut: StoredCut, current?: Shoot): SlimCut {
  const storage: SlimCut["storage"] = { format: "slim-v1", clips: {}, shoots: {} };
  const byId = new Set(current?.clips.map(c => c.id));
  const snapshot = <T>(pool: Record<string, T>, value: T): string => {
    const key = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    pool[key] ??= value;
    return key;
  };
  const clipRef = (clip: Clip): ClipRef => byId.has(clip.id) ? { id: clip.id }
    : { id: clip.id, snapshot: snapshot(storage.clips, clip) };
  const segRef = (seg: Segment): SlimSegment => ({ ...seg, clip: clipRef(seg.clip) });
  const versions = cut.versions.map(version => {
    if (!version.assembly) return version as unknown as SlimCut["versions"][number];
    const a = version.assembly;
    const shoot: ShootRef = current ? { index: true } : { snapshot: snapshot(storage.shoots,
      { ...a.shoot, clips: a.shoot.clips.map(clipRef) }) };
    return { ...version, assembly: { ...a, shoot,
      cutList: a.cutList.map((item, index) => ({ ...item,
        ...(current && item.piece === undefined ? { piece: index } : {}),
        seg: item.seg ? segRef(item.seg) : null })),
      reel: { ...a.reel, broll: a.reel.broll.map(item => ({ ...item, seg: segRef(item.seg) })) } } };
  });
  return { ...cut, storage, versions };
}

export function hydrateCut(cut: StoredCut | SlimCut, current?: Shoot): StoredCut {
  const slim = isSlim(cut) ? cut : undefined;
  const byId = new Map(current?.clips.map(c => [c.id, c]));
  const clip = (ref: ClipRef | Clip): Clip => {
    const found = byId.get(ref.id) ?? (slim ? slim.storage.clips[(ref as ClipRef).snapshot ?? ""] : ref as Clip);
    if (!found) {
      const piece = cut.versions.flatMap(v => v.pieces ?? []).find(p => p.clipId === ref.id);
      throw new Error(`Could not find the footage for ${clipName(undefined, piece)}. Reconnect it and try again.`);
    }
    return found;
  };
  const versions = cut.versions.map(version => {
    if (!version.assembly) return version as StoredVersion;
    const a = version.assembly;
    const ref = a.shoot as ShootRef;
    const saved = slim && "snapshot" in ref ? slim.storage.shoots[ref.snapshot] : undefined;
    const baseShoot = current ?? (slim ? saved && { ...saved, clips: saved.clips.map(clip) } : a.shoot as Shoot);
    const shoot = baseShoot ? withLayoutMedia(a as Assembly,baseShoot) : undefined;
    if (!shoot) throw new Error("Could not load this edit's shoot index. Check the drive is connected and try again.");
    return { ...version, assembly: { ...a, shoot,
      cutList: a.cutList.map((item, index) => ({ ...item,
        ...(current && item.piece === undefined ? { piece: index } : {}),
        seg: item.seg ? { ...item.seg, clip: clip(item.seg.clip) } : null })),
      reel: { ...a.reel, broll: a.reel.broll.map(item => ({ ...item, seg: { ...item.seg, clip: clip(item.seg.clip) } })) } } };
  });
  // The format envelope is private to disk, never copied into another version.
  const { storage: _storage, ...plain } = cut as SlimCut;
  return { ...plain, versions } as StoredCut;
}

export async function writeJsonAtomic(file: string, value: unknown, signal?: AbortSignal, indent?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, indent) + "\n", { flag: "wx" });
    signal?.throwIfAborted();
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

// Playback/status readers need one assembly, never a rehydrated undo history.
// Atomic replacement identity invalidates the parsed disk snapshot. Keep only a
// small raw cache; callers receive an owned copy of the requested version.
const versionReads = new Map<string, { identity: string; raw: SlimCut; versions: Map<number, SlimCut['versions'][number]> }>();
export async function readCutVersion(file: string, version: number | 'latest', current?: Shoot, options?: { ownedIndex?: true }): Promise<StoredVersion> {
  // ARCH2: a log reads one line, not the history.
  const head = await readLogHead(file);
  if (head) {
    const selected = await readLoggedVersion(file, head, version);
    if (!selected?.assembly) throw new Error("Could not find that edit version's saved assembly.");
    const fields = headFields(head), cut = { ...fields, storage: structuredClone(fields.storage), versions: [selected] } as unknown as SlimCut;
    await checkTrashedSources(cut, current);
    // The line was parsed for this call and the pools cloned: the hydrated version owns everything but the index's clips.
    const hydrated = hydrateCut(cut, current).versions[0];
    return options?.ownedIndex && current ? hydrated : structuredClone(hydrated);
  }
  const stat = await fs.stat(file);
  const identity = JSON.stringify([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  let raw = versionReads.get(file)?.identity === identity ? versionReads.get(file)!.raw : undefined;
  if (!raw) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as StoredCut | SlimCut;
    // The existing verified migration/recovery path still owns legacy files.
    if (!isSlim(parsed) || await fs.access(`${file}.fat-backup`).then(() => true, () => false)) {
      const cut = await readCutFile(file, current);
      // 'latest' (at(-1)) is the newest snapshot by design; callers acting on an edit pass currentVersion.
      const record = version === 'latest' ? cut.versions.at(-1) : cut.versions.find(v => v.version === version);
      if (!record?.assembly) throw new Error("Could not find that edit version's saved assembly.");
      return record;
    }
    raw = parsed;
    versionReads.set(file, { identity, raw, versions: new Map(raw.versions.map(v => [v.version, v])) });
    if (versionReads.size > 4) versionReads.delete(versionReads.keys().next().value!);
  }
  const selected = version === 'latest' ? raw.versions.at(-1) : versionReads.get(file)!.versions.get(version);  // 'latest': newest by design
  if (!selected?.assembly) throw new Error("Could not find that edit version's saved assembly.");
  const cut = { ...raw, versions: [selected] };
  await checkTrashedSources(cut, current);
  // A freshly parsed, operation-owned index needs no second large clone.
  // Cached editorial fields and fallback metadata always remain isolated.
  if (options?.ownedIndex && current) {
    const owned = structuredClone({ version: selected, storage: raw.storage });
    return hydrateCut({ ...raw, storage: owned.storage, versions: [owned.version] }, current).versions[0];
  }
  return structuredClone(hydrateCut(cut, current).versions[0]);
}

async function checkTrashedSources(raw: StoredCut | SlimCut, current?: Shoot) {
  if (!current) return;
  const review = await fs.readFile(path.join(current.root, ".sidething/junk.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return '{"trashed":[]}';
  });
  const removed = (JSON.parse(review).trashed ?? []) as Clip[];
  if (!removed.length) return;
  const references = JSON.stringify(raw.versions);
  for (const clip of removed) if (!current.clips.some(c => c.id === clip.id) &&
      (references.includes(`"id":${JSON.stringify(clip.id)}`) || references.includes(`"clipId":${JSON.stringify(clip.id)}`)))
    throw Object.assign(new Error(`The shot "${clip.judgement?.summary || clip.id}" was moved to the Trash. Restore it and read the shoot again to use this edit.`), { code: "ST1_TRASHED_SOURCE" });
}

/** Caller holds the same per-cut queue used for all edit writes. */
export async function readCutFile(file: string, current?: Shoot, signal?: AbortSignal): Promise<StoredCut> {
  // ARCH2: a log is assembled from its lines (each checked against its hash); there is nothing to slim.
  if (await readLogHead(file)) {
    const doc = await readCutDocument(file);
    await checkTrashedSources(doc as unknown as SlimCut, current);
    return hydrateCut(doc as unknown as SlimCut, current);
  }
  const source = await fs.readFile(file, "utf8");
  const raw: StoredCut | SlimCut = JSON.parse(source);
  // ST1: removing an original never becomes an opaque missing-index error.
  // Saved versions stay on disk; the person can recover the shot from the Trash.
  await checkTrashedSources(raw, current);
  let loaded = hydrateCut(raw, current);
  const backup = `${file}.fat-backup`;
  if (isSlim(raw) && !await fs.access(backup).then(() => true, () => false)) return loaded;
  try { await withShootWriter(path.resolve(path.dirname(file), "../../.."), async () => {
  const newest = await fs.readFile(file, "utf8");
  if (newest !== source) { loaded = hydrateCut(JSON.parse(newest), current); return; }
  if (!isSlim(raw)) {
    const slim = slimCut(raw, current);
    // Validate the complete loaded version before replacing any bytes.
    if (!isDeepStrictEqual(hydrateCut(slim, current), loaded)) throw new Error("The saved edit could not be made smaller safely.");
    await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await writeJsonAtomic(file, slim, signal);
    const reloaded = hydrateCut(JSON.parse(await fs.readFile(file, "utf8")), current);
    if (!isDeepStrictEqual(reloaded, loaded)) throw new Error("The smaller edit could not be verified. Its backup has been kept.");
  } else {
    // After a crash, verify against the retained original before discarding it.
    // A parseable but damaged replacement must never erase the recovery copy.
    const original = await fs.readFile(backup, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (original && !isDeepStrictEqual(hydrateCut(JSON.parse(original), current), loaded)) {
      throw new Error("The smaller edit does not match its original. Its backup has been kept.");
    }
  }
  // A crash after rename leaves the backup. A successful slim reload clears it.
  await fs.unlink(backup).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }); } catch (error) { if (!(error instanceof WriterBusyError)) throw error; }
  return loaded;
}

// ---- ARCH2 (briefs/ARCH2-append-only-history.md): the history as an append-only log.
// cuts/<id>.json becomes a small head: the edit's own fields, one light entry per version (what the versions menu, the
// shoot list, storage, junk review and older precut builds read) and the index of the log. Each saved version is one
// line of cuts/<id>.versions.jsonl, written once and never rewritten. Cache fields that change after a save (playback
// preparation, heals, auto layout status) are overlays in cuts/<id>.cache.jsonl, keyed by version, the last one wins.
// Neither sidecar ends in .json, so every reader that lists cuts/*.json sees only heads. A version's line keeps the
// cache fields it was saved with; an overlay replaces exactly those fields, so a migrated version reads back byte for
// byte as it was. The head's first key is versionLog, so the format is known from the first bytes.
export const LOG_FORMAT = "precut-log-v1";
export interface LogEntry { v: number; at: number; n: number; h: string; vo?: 1 }
export interface VersionLog {
  format: typeof LOG_FORMAT; file: string; cache: string; end: number;
  pools: { clips: Record<string, Clip>; shoots: Record<string, ShootSnapshot> };
  index: LogEntry[]; migratedAt?: string;
}
export type LogHead = { versionLog: VersionLog; cutId: string; versions: (Record<string, unknown> & { version: number })[] } & Record<string, unknown>;
type Overlay = { v: number; o: Record<string, unknown>; d: string[] };
type Doc = Record<string, unknown> & { cutId: string; versions: Record<string, unknown>[] };
/** The only fields an overlay may change: contentView's cache fields (sidekick.ts). Everything else is immutable. */
export const CACHE_PATHS = ["previewRev", "preview", "finished", "warnings", "voiceMixNeedsMeasure", "autoLayouts", "sfx", "assembly.reel.voiceLUFS", "assembly.reel.why"] as const;
const LIGHT_KEYS = ["version", "createdAt", "title", "feedback", "lengthS", "baseVersion", "videoType", "templateId"];
const LOG_NAME = /^[A-Za-z0-9_-]+\.(?:versions|cache)\.jsonl$/;
const LOG_PREFIX = '{"versionLog":';

export const isLogHead = (raw: unknown): raw is LogHead => {
  const log = (raw as { versionLog?: VersionLog } | null)?.versionLog;
  return !!log && log.format === LOG_FORMAT && Array.isArray(log.index) && Array.isArray((raw as LogHead).versions) && LOG_NAME.test(log.file) && LOG_NAME.test(log.cache);
};
/** The versions menu's fields of a saved version, as listings return old versions (`light: true`): its number, base, time,
 * title, what made it, length, the first sentence of its reason (all the menu shows of it), and its pieces as which clip
 * and span sits where (what footage usage, clip names and insert positions read). Words, looks, sound and captions are not. */
export function lightEntry(version: Record<string, unknown>): Record<string, unknown> & { version: number } {
  const out: Record<string, unknown> = {};
  for (const key of LIGHT_KEYS) if (version[key] !== undefined) out[key] = version[key];
  if (typeof version.why === "string") out.why = version.why.trim().split(/\n|(?<=[.!?])\s/)[0]?.trim().slice(0, 240) ?? "";
  type Span = { id?: string; kind?: string; clipId?: string; s?: number; e?: number; timelineS?: number; lengthS?: number; overlay?: { id?: string; clipId?: string; s?: number; e?: number } | null };
  if (Array.isArray(version.pieces)) out.pieces = (version.pieces as Span[]).map(p => ({ id: p?.id, kind: p?.kind, clipId: p?.clipId, s: p?.s, e: p?.e, timelineS: p?.timelineS, lengthS: p?.lengthS,
    ...(p?.overlay ? { overlay: { id: p.overlay.id, clipId: p.overlay.clipId, s: p.overlay.s, e: p.overlay.e } } : {}) }));
  const critique = version.critique as { rounds?: number; at?: string; from?: number; issues?: { fixed?: boolean }[] } | null | undefined;
  if (critique) out.critique = { rounds: critique.rounds, at: critique.at, from: critique.from, issues: (critique.issues ?? []).filter(issue => issue?.fixed).slice(0, 1) };
  return { title: "", voice: [], broll: [], why: "", missing: [], templateId: "", lengthS: 0, feedback: null, ...out,
    music: null, preview: null, warnings: [], light: true } as unknown as Record<string, unknown> & { version: number };
}
// ---- REL2: paths inside the shoot are stored relative to it ("./.sidething/sfx/roomtone.wav"), so a moved, relinked or
// copied shoot still plays and exports its room tone, voiceover takes and other files. Lines saved before REL2 hold
// absolute paths; they are resolved against the shoot's current root when read: a path under a root the shoot was
// relinked from (.sidething/previous-roots.json), or one inside another folder's .sidething or "sidething precuts" whose
// counterpart exists in this shoot. Paths outside the shoot (a music folder) stay absolute. Lines are never rewritten.
const SHOOT_ANCHORS = [`${path.sep}.sidething${path.sep}`, `${path.sep}sidething precuts${path.sep}`];
const RELATIVE = `.${path.sep}`;
/** <root> for <root>/.sidething/sidekick/cuts/<id>.json, else null (no path is touched). */
export function shootRootOfCut(file: string): string | null {
  const cuts = path.dirname(path.resolve(file)), sidekick = path.dirname(cuts), side = path.dirname(sidekick);
  return path.basename(cuts) === "cuts" && path.basename(sidekick) === "sidekick" && path.basename(side) === ".sidething" ? path.dirname(side) : null;
}
const previousRootsMemo = new Map<string, string[]>();
export function forgetPreviousRoots(root?: string): void { if (root) previousRootsMemo.delete(path.resolve(root)); else previousRootsMemo.clear(); }
function previousRoots(root: string): string[] {
  let roots = previousRootsMemo.get(root);
  if (!roots) {
    try { const raw = JSON.parse(fsSync.readFileSync(path.join(root, ".sidething", "previous-roots.json"), "utf8")); roots = Array.isArray(raw?.roots) ? raw.roots.filter((r: unknown) => typeof r === "string" && path.isAbsolute(r) && r !== root) : []; }
    catch { roots = []; }
    previousRootsMemo.set(root, roots!);
  }
  return roots!;
}
function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, change));
  if (value && typeof value === "object") { const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, change); return out; }
  return value;
}
const jsonText = (text: string) => JSON.stringify(text).slice(1, -1);
/** Stored form: absolute paths under `root` become "./<path inside the shoot>". */
export function storedPaths<T>(value: T, root: string | null): T {
  if (!root) return value;
  const prefix = root + path.sep;
  if (!JSON.stringify(value).includes(jsonText(prefix))) return value;
  return mapStrings(value, text => text.startsWith(prefix) && text.length > prefix.length ? RELATIVE + text.slice(prefix.length) : text) as T;
}
/** Live form: "./..." and paths under a previous root of this shoot resolve to absolute paths under `root`. */
export function livePaths<T>(value: T, root: string | null, line?: string): T {
  if (!root) return value;
  const text = line ?? JSON.stringify(value), previous = previousRoots(root), prefix = root + path.sep;
  const relative = text.includes(`"${jsonText(RELATIVE)}`);
  const foreign = previous.some(p => text.includes(jsonText(p + path.sep))) || SHOOT_ANCHORS.some(anchor => {
    const needle = jsonText(anchor);
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) if (!text.slice(0, at + 1).endsWith(jsonText(root) + jsonText(path.sep))) return true;
    return false;
  });
  if (!relative && !foreign) return value;
  const exists = new Map<string, boolean>();
  return mapStrings(value, s => {
    if (s.startsWith(RELATIVE) && s.length > RELATIVE.length) return path.join(root, s.slice(RELATIVE.length));
    if (!path.isAbsolute(s) || s.startsWith(prefix)) return s;
    for (const p of previous) if (s.startsWith(p + path.sep)) return root + s.slice(p.length);
    for (const anchor of SHOOT_ANCHORS) {
      const at = s.indexOf(anchor);
      if (at <= 0) continue;
      const candidate = root + s.slice(at);
      if (!exists.has(candidate)) exists.set(candidate, fsSync.existsSync(candidate));
      if (exists.get(candidate)) return candidate;
    }
    return s;
  }) as T;
}
/** One stored line in its canonical stored form (old absolute paths of this shoot made relative), for comparisons. */
const canonicalLine = (line: string, root: string | null): Record<string, unknown> => storedPaths(livePaths(JSON.parse(line), root, line), root);

export function logPaths(file: string, log?: Pick<VersionLog, "file" | "cache">): { log: string; cache: string } {
  const dir = path.dirname(file), base = path.basename(file, ".json");
  return { log: path.join(dir, log?.file ?? `${base}.versions.jsonl`), cache: path.join(dir, log?.cache ?? `${base}.cache.jsonl`) };
}
const lineHash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const identityOf = (s: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const plainJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function startsLikeLog(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r");
  try { const buffer = Buffer.alloc(LOG_PREFIX.length); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead).toString("utf8") === LOG_PREFIX; }
  finally { await handle.close(); }
}
function startsLikeLogSync(file: string): boolean {
  const fd = fsSync.openSync(file, "r");
  try { const buffer = Buffer.alloc(LOG_PREFIX.length); const read = fsSync.readSync(fd, buffer, 0, buffer.length, 0); return buffer.subarray(0, read).toString("utf8") === LOG_PREFIX; }
  finally { fsSync.closeSync(fd); }
}
// Heads are small (a few MB at most for hundreds of versions); parse each once per change. Read-only to callers.
const heads = new Map<string, { identity: string; head: LogHead | null }>();
/** The head of an edit in the log format, or null for an edit still in the one-file format. Never mutate the result. */
export async function readLogHead(file: string): Promise<LogHead | null> {
  const identity = identityOf(await fs.stat(file)), hit = heads.get(file);
  if (hit?.identity === identity) return hit.head;
  let head: LogHead | null = null;
  if (await startsLikeLog(file)) {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isLogHead(raw)) throw new Error(`The saved edit ${path.basename(file)} could not be read: its history index is damaged.`);
    head = raw;
  }
  heads.delete(file); heads.set(file, { identity, head });
  while (heads.size > 16) heads.delete(heads.keys().next().value!);
  return head;
}
export async function isLoggedCut(file: string): Promise<boolean> {
  return startsLikeLog(file).catch(() => false);
}

// ---- Overlays (cache fields), last one per version wins. A torn last line is skipped.
const overlayReads = new Map<string, { identity: string; map: Map<number, Overlay>; lines: number }>();
function parseOverlays(text: string): { map: Map<number, Overlay>; lines: number } {
  const map = new Map<number, Overlay>();
  let lines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const overlay = JSON.parse(line) as Overlay;
      if (!Number.isInteger(overlay?.v) || !overlay.o || typeof overlay.o !== "object" || !Array.isArray(overlay.d)) continue;
      if (Object.keys(overlay.o).some(p => !(CACHE_PATHS as readonly string[]).includes(p)) || overlay.d.some(p => !(CACHE_PATHS as readonly string[]).includes(p))) continue;
      map.set(overlay.v, overlay); lines++;
    } catch { /* a torn line from an interrupted write: it never applied */ }
  }
  return { map, lines };
}
async function readOverlays(cacheFile: string): Promise<{ map: Map<number, Overlay>; lines: number }> {
  const stat = await fs.stat(cacheFile).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) { overlayReads.delete(cacheFile); return { map: new Map(), lines: 0 }; }
  const identity = identityOf(stat), hit = overlayReads.get(cacheFile);
  if (hit?.identity === identity) return hit;
  const parsed = parseOverlays(await fs.readFile(cacheFile, "utf8"));
  overlayReads.delete(cacheFile); overlayReads.set(cacheFile, { identity, ...parsed });
  while (overlayReads.size > 16) overlayReads.delete(overlayReads.keys().next().value!);
  return parsed;
}
function readOverlaysSync(cacheFile: string): Map<number, Overlay> {
  try { return parseOverlays(fsSync.readFileSync(cacheFile, "utf8")).map; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw error; }
}
function lookup(target: unknown, dotted: string): [boolean, unknown] {
  const keys = dotted.split(".");
  let value = target;
  for (const key of keys) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value as object, key)) return [false, undefined];
    value = (value as Record<string, unknown>)[key];
  }
  return [true, value];
}
function parentOf(target: Record<string, unknown>, dotted: string): [Record<string, unknown> | null, string] {
  const keys = dotted.split("."), last = keys.pop()!;
  let value: unknown = target;
  for (const key of keys) {
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    if (!value || typeof value !== "object") return [null, last];
  }
  return [value as Record<string, unknown>, last];
}
/** Apply a version's overlay in place: an existing field keeps its position, as an in-place rewrite always did. */
function applyOverlay(version: Record<string, unknown>, overlay: Overlay | undefined): Record<string, unknown> {
  if (!overlay) return version;
  for (const [dotted, value] of Object.entries(overlay.o)) {
    const [parent, key] = parentOf(version, dotted);
    if (parent) parent[key] = plainJson(value);
  }
  for (const dotted of overlay.d) { const [parent, key] = parentOf(version, dotted); if (parent) delete parent[key]; }
  return version;
}
/** The overlay that turns a saved line into `desired`, when they differ only in cache fields; null when they differ elsewhere. */
function overlayBetween(version: number, line: Record<string, unknown>, desired: Record<string, unknown>): Overlay | null {
  const overlay: Overlay = { v: version, o: {}, d: [] };
  for (const dotted of CACHE_PATHS) {
    const [had, before] = lookup(line, dotted), [has, after] = lookup(desired, dotted);
    if (has) { if (!had || !isDeepStrictEqual(before, after)) overlay.o[dotted] = after; }
    else if (had) overlay.d.push(dotted);
  }
  return isDeepStrictEqual(applyOverlay(plainJson(line), overlay), desired) ? overlay : null;
}

// ---- Reading lines. Offsets and lengths are bytes; every line is checked against its hash.
const damaged = (file: string, version: number) => new Error(`Version ${version} of the saved edit ${path.basename(file)} is damaged on disk. Its other versions are safe.`);
function lineAt(bytes: Buffer, entry: LogEntry, file: string): string {
  const slice = bytes.subarray(entry.at, entry.at + entry.n);
  if (slice.length !== entry.n || lineHash(slice) !== entry.h) throw damaged(file, entry.v);
  return slice.toString("utf8");
}
async function readLineAt(logFile: string, entry: LogEntry): Promise<string> {
  const handle = await fs.open(logFile, "r");
  try {
    const buffer = Buffer.alloc(entry.n), { bytesRead } = await handle.read(buffer, 0, entry.n, entry.at);
    return lineAt(buffer.subarray(0, bytesRead), { ...entry, at: 0 }, logFile);
  } finally { await handle.close(); }
}
function documentOf(head: LogHead, versions: Record<string, unknown>[]): Doc {
  const doc: Record<string, unknown> = {}, pools = head.versionLog.pools;
  for (const [key, value] of Object.entries(head)) {
    if (key === "versionLog") continue;
    doc[key] = key === "versions" ? versions : key === "storage" ? { format: "slim-v1", clips: pools.clips, shoots: pools.shoots } : value;
  }
  doc.storage ??= { format: "slim-v1", clips: pools.clips, shoots: pools.shoots };
  return doc as Doc;
}
/** The edit's own fields (no versions), with the clip/shoot pools hydration needs: what a one-version read hydrates against. */
export function headFields(head: LogHead): Record<string, unknown> {
  const { versions: _versions, ...fields } = documentOf(head, []);
  return fields;
}
/** One saved version (its stored form, overlay applied), or undefined when the log has no such number. */
export async function readLoggedVersion(file: string, head: LogHead, version: number | "latest"): Promise<Record<string, unknown> & { version: number } | undefined> {
  // 'latest' is the newest snapshot by design (the last line appended), as at(-1) was in the one-file format.
  const entry = version === "latest" ? head.versionLog.index.at(-1) : head.versionLog.index.find(e => e.v === version);
  if (!entry) return undefined;
  const { log, cache } = logPaths(file, head.versionLog);
  const [line, overlays] = await Promise.all([readLineAt(log, entry), readOverlays(cache)]);
  const parsed = JSON.parse(line) as Record<string, unknown> & { version: number };
  if (parsed.version !== entry.v) throw damaged(file, entry.v);
  const overlay = overlays.map.get(entry.v);
  return livePaths(applyOverlay(parsed, overlay), shootRootOfCut(file), overlay ? line + JSON.stringify(overlay.o) : line) as Record<string, unknown> & { version: number };
}
/** One saved version as stored (clip references, not hydrated), in either format: a log reads one line. */
export async function readStoredVersion(file: string, version: number): Promise<Record<string, unknown> & { version: number } | undefined> {
  const head = await readLogHead(file);
  if (head) return readLoggedVersion(file, head, version);
  return (JSON.parse(await fs.readFile(file, "utf8")) as Doc).versions.find(v => v.version === version) as (Record<string, unknown> & { version: number }) | undefined;
}
/** The whole edit in the one-file shape every reader parses today: what `JSON.parse(cuts/<id>.json)` returned before ARCH2. */
export async function readCutDocument(file: string): Promise<Doc> {
  const text = await fs.readFile(file, "utf8"), raw = JSON.parse(text);
  if (!isLogHead(raw)) return raw as Doc;
  const { log, cache } = logPaths(file, raw.versionLog);
  const [bytes, overlays] = await Promise.all([fs.readFile(log), readOverlays(cache)]), root = shootRootOfCut(file);
  return documentOf(raw, raw.versionLog.index.map(entry => {
    const line = lineAt(bytes, entry, log), parsed = JSON.parse(line), overlay = overlays.map.get(entry.v);
    if (parsed?.version !== entry.v) throw damaged(file, entry.v);
    return livePaths(applyOverlay(parsed, overlay), root, overlay ? line + JSON.stringify(overlay.o) : line);
  }));
}
export function readCutDocumentSync(file: string): Doc {
  const raw = JSON.parse(fsSync.readFileSync(file, "utf8"));
  if (!isLogHead(raw)) return raw as Doc;
  const { log, cache } = logPaths(file, raw.versionLog), bytes = fsSync.readFileSync(log), overlays = readOverlaysSync(cache), root = shootRootOfCut(file);
  return documentOf(raw, raw.versionLog.index.map(entry => {
    const line = lineAt(bytes, entry, log), parsed = JSON.parse(line), overlay = overlays.get(entry.v);
    if (parsed?.version !== entry.v) throw damaged(file, entry.v);
    return livePaths(applyOverlay(parsed, overlay), root, overlay ? line + JSON.stringify(overlay.o) : line);
  }));
}

// ---- Writing. Every caller holds the edit's queue and the shoot writer lease (sidekick.ts).
/** Append whole lines; a torn tail from an interrupted write is fenced off by a newline. Returns each line's byte offset. */
async function appendLines(target: string, lines: string[]): Promise<number[]> {
  const handle = await fs.open(target, "a+");
  try {
    let size = (await handle.stat()).size;
    const chunks: Buffer[] = [], offsets: number[] = [];
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) { chunks.push(Buffer.from("\n")); size++; }
    }
    for (const line of lines) { const bytes = Buffer.from(line + "\n", "utf8"); offsets.push(size); chunks.push(bytes); size += bytes.length; }
    if (chunks.length) await handle.writeFile(Buffer.concat(chunks));
    await handle.sync();
    return offsets;
  } finally { await handle.close(); }
}
async function writeHead(file: string, head: LogHead, signal?: AbortSignal): Promise<LogHead> {
  await writeJsonAtomic(file, head, signal);
  heads.delete(file); heads.set(file, { identity: identityOf(await fs.stat(file)), head });
  return head;
}
function nextHead(head: LogHead, fields: Record<string, unknown> | null, added: { version: Record<string, unknown> & { version: number }; entry: LogEntry }[], pools: VersionLog["pools"] | null): LogHead {
  const log: VersionLog = { ...head.versionLog, index: [...head.versionLog.index, ...added.map(a => a.entry)],
    end: Math.max(head.versionLog.end, ...added.map(a => a.entry.at + a.entry.n + 1)),
    pools: pools ? { clips: { ...head.versionLog.pools.clips, ...pools.clips }, shoots: { ...head.versionLog.pools.shoots, ...pools.shoots } } : head.versionLog.pools };
  const next: Record<string, unknown> = { versionLog: log };
  const source = fields ? { ...fields } : headFields(head);
  delete source.versions; delete source.storage; delete source.versionLog;
  // The edit's own fields keep their order; versions stays where it was, storage marks the shape for older builds.
  const order = [...Object.keys(head).filter(k => k !== "versionLog" && (k === "versions" || k === "storage" || Object.hasOwn(source, k))), ...Object.keys(source).filter(k => !Object.hasOwn(head, k))];
  for (const key of order) next[key] = key === "versions" ? [...head.versions, ...added.map(a => lightEntry(a.version))] : key === "storage" ? { format: "slim-v1", clips: {}, shoots: {} } : source[key];
  next.versions ??= [...head.versions, ...added.map(a => lightEntry(a.version))];
  next.storage ??= { format: "slim-v1", clips: {}, shoots: {} };
  return next as LogHead;
}
/** Append saved versions (stored form) as new lines, then publish them in the head. Returns the new head. */
export async function appendLogVersions(file: string, head: LogHead, versions: (Record<string, unknown> & { version: number })[],
  pools?: VersionLog["pools"] | null, fields?: Record<string, unknown> | null, signal?: AbortSignal): Promise<LogHead> {
  const known = new Set(head.versionLog.index.map(e => e.v));
  for (const version of versions) {
    if (!Number.isInteger(version.version) || known.has(version.version)) throw new Error("Saved edit versions cannot be replaced.");
    if (!Number.isInteger(version.baseVersion)) throw new Error("Every saved edit must name its base version.");
    known.add(version.version);
  }
  const root = shootRootOfCut(file), lines = versions.map(v => JSON.stringify(storedPaths(v, root))), { log } = logPaths(file, head.versionLog);
  const offsets = lines.length ? await appendLines(log, lines) : [];
  signal?.throwIfAborted();
  const added = versions.map((version, i) => ({ version, entry: { v: version.version, at: offsets[i], n: Buffer.byteLength(lines[i]), h: lineHash(lines[i]),
    ...((version.voiceover as { lines?: unknown[] } | undefined)?.lines?.length ? { vo: 1 as const } : {}) } }));
  return writeHead(file, nextHead(head, fields ?? null, added, pools ?? null), signal);
}
/** New cache values for saved versions. Refused (thrown) when anything but a cache field would change. */
export async function writeLoggedCache(file: string, head: LogHead, desired: (Record<string, unknown> & { version: number })[]): Promise<number> {
  const { log, cache } = logPaths(file, head.versionLog), byNumber = new Map(head.versionLog.index.map(e => [e.v, e])), root = shootRootOfCut(file);
  const overlays: Overlay[] = [];
  for (const version of desired) {
    const entry = byNumber.get(version.version);
    if (!entry) throw new Error("That edit version does not exist.");
    // REL2: compared and written in the stored form, so a line saved with an older absolute path still matches.
    const line = canonicalLine(await readLineAt(log, entry), root), overlay = overlayBetween(entry.v, line, storedPaths(plainJson(version), root));
    if (!overlay) throw new Error("Saved edit content needs a new version with a base.");
    overlays.push(overlay);
  }
  if (!overlays.length) return 0;
  await appendLines(cache, overlays.map(o => JSON.stringify(o)));
  overlayReads.delete(cache);
  await compactCache(cache, head);
  return overlays.length;
}
async function compactCache(cache: string, head: LogHead): Promise<void> {
  const { map, lines } = await readOverlays(cache);
  if (lines <= head.versionLog.index.length * 2 + 64) return;
  const text = [...map.values()].sort((a, b) => a.v - b.v).map(o => JSON.stringify(o) + "\n").join("");
  const temp = `${cache}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, text, { flag: "wx" }); const h = await fs.open(temp, "r"); try { await h.sync(); } finally { await h.close(); } await fs.rename(temp, cache); }
  finally { await fs.unlink(temp).catch(() => {}); }
  overlayReads.delete(cache);
}
/** A whole-edit write (the one-file writers' path) on a log: unchanged versions stay as they are, new versions are appended,
 * a version whose cache fields changed gets an overlay, and the edit's own fields go to the head. A content change to a
 * saved version, or a removed version, is refused before anything is written. `project` is contentView. */
export async function writeLoggedCut(file: string, doc: Doc, project: (version: never) => unknown, signal?: AbortSignal): Promise<{ added: number[]; head: LogHead }> {
  const exists = await fs.stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  let head = exists ? await readLogHead(file) : null;
  if (exists && !head) throw new Error("This edit is still in the one-file format.");
  const pools = (doc.storage as VersionLog["pools"] | undefined) ?? { clips: {}, shoots: {} };
  if (!head) {
    const base = path.basename(file, ".json"), dir = path.dirname(file);
    if (!LOG_NAME.test(`${base}.versions.jsonl`)) throw new Error("That edit id is invalid.");
    await fs.mkdir(dir, { recursive: true });
    // A brand-new log starts empty; a leftover with the same name (an interrupted create) is replaced, never extended.
    for (const name of [`${base}.versions.jsonl`, `${base}.cache.jsonl`]) await fs.unlink(path.join(dir, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    head = { versionLog: { format: LOG_FORMAT, file: `${base}.versions.jsonl`, cache: `${base}.cache.jsonl`, end: 0, pools: { clips: {}, shoots: {} }, index: [] },
      ...Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "storage")), versions: [], storage: { format: "slim-v1", clips: {}, shoots: {} } } as unknown as LogHead;
  }
  const byNumber = new Map(head.versionLog.index.map(e => [e.v, e])), seen = new Set<number>();
  const { log, cache } = logPaths(file, head.versionLog);
  const bytes = byNumber.size ? await fs.readFile(log) : Buffer.alloc(0), overlays = byNumber.size ? (await readOverlays(cache)).map : new Map<number, Overlay>();
  const added: (Record<string, unknown> & { version: number })[] = [], changes: Overlay[] = [];
  const root = shootRootOfCut(file);
  let slice = performance.now();
  for (const version of doc.versions as (Record<string, unknown> & { version: number })[]) {
    if (seen.has(version.version)) throw new Error("Saved edit versions cannot be replaced.");
    seen.add(version.version);
    // REL2: compared in the stored form (paths inside the shoot relative); appendLogVersions stores new lines that way.
    const entry = byNumber.get(version.version), text = JSON.stringify(storedPaths(version, root));
    if (!entry) {
      if (!Number.isInteger(version.baseVersion)) throw new Error("Every saved edit must name its base version.");
      if (!byNumber.size && version.baseVersion !== 0) throw new Error("A new edit must name base version 0.");
      added.push(JSON.parse(text)); continue;
    }
    const raw = lineAt(bytes, entry, log), overlay = overlays.get(entry.v), line = JSON.stringify(canonicalLine(raw, root));
    if ((overlay ? JSON.stringify(applyOverlay(JSON.parse(line), overlay)) : line) === text) continue;
    const saved = applyOverlay(JSON.parse(line), overlay), desired = JSON.parse(text);
    if (!isDeepStrictEqual(plainJson(project(livePaths(saved, root) as never)), plainJson(project(livePaths(desired, root) as never)))) throw new Error("Saved edit content needs a new version with a base.");
    const next = overlayBetween(entry.v, JSON.parse(line), desired);
    if (!next) throw new Error("Saved edit content needs a new version with a base.");
    if (!overlay || !isDeepStrictEqual(overlay, next)) changes.push(next);
    if (performance.now() - slice > 8) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now(); }
  }
  if ([...byNumber.keys()].some(v => !seen.has(v))) throw new Error("Saved edit versions cannot be removed.");
  signal?.throwIfAborted();
  if (changes.length) { await appendLines(cache, changes.map(o => JSON.stringify(o))); overlayReads.delete(cache); }
  const fields = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "versions" && k !== "storage"));
  head = await appendLogVersions(file, head, added, pools, fields, signal);
  if (changes.length) await compactCache(cache, head);
  return { added: added.map(v => v.version), head };
}

// ---- Migration from the one-file format. Nothing switches until every version reads back identically; any doubt keeps
// the old file as it is. The old file is kept as <id>.json.pre-arch2 until an open a day later reads the log cleanly.
export const PRE_ARCH2 = ".pre-arch2";
const migrationTemp = (target: string) => `${target}.arch2-${randomUUID()}.tmp`;
export interface MigrationResult { migrated: boolean; versions: number; reason?: string; ms: number }
/** `check(version, originalStored, migratedStored)` compares what readers see (sidekick's public view); throw to refuse. */
export async function migrateToLog(file: string, check?: (version: number, before: Record<string, unknown>, after: Record<string, unknown>) => Promise<void>): Promise<MigrationResult> {
  const started = performance.now(), dir = path.dirname(file), base = path.basename(file, ".json");
  const result = (migrated: boolean, versions: number, reason?: string): MigrationResult => ({ migrated, versions, reason, ms: Math.round(performance.now() - started) });
  if (await isLoggedCut(file)) return result(false, 0, "already in the log format");
  if (await fs.access(`${file}.fat-backup`).then(() => true, () => false)) return result(false, 0, "an unverified fat backup is still kept");
  // Leftovers of an interrupted migration of this edit (only this edit's own arch2 temp files).
  for (const name of await fs.readdir(dir)) if (name.startsWith(`${base}.`) && /\.arch2-[0-9a-f-]{36}\.tmp$/.test(name)) await fs.unlink(path.join(dir, name)).catch(() => {});
  const text = await fs.readFile(file, "utf8"), original = JSON.parse(text) as Doc & { storage?: SlimCut["storage"] };
  if (!isSlim(original as unknown as SlimCut) || !Array.isArray(original.versions)) return result(false, 0, "not a slim edit file");
  const versions = original.versions as (Record<string, unknown> & { version: number })[];
  if (versions.some(v => !Number.isInteger(v?.version)) || new Set(versions.map(v => v.version)).size !== versions.length) return result(false, versions.length, "version numbers are not unique integers");
  const logName = `${base}.versions.jsonl`, cacheName = `${base}.cache.jsonl`, logFile = path.join(dir, logName), cacheFile = path.join(dir, cacheName);
  const lines = versions.map(v => JSON.stringify(v));
  // 1. The log, complete and synced under a temporary name.
  const tempLog = migrationTemp(logFile), tempHead = migrationTemp(file);
  try {
    const chunks: Buffer[] = [], index: LogEntry[] = [];
    let at = 0;
    for (const [i, line] of lines.entries()) {
      const bytes = Buffer.from(line + "\n", "utf8");
      index.push({ v: versions[i].version, at, n: bytes.length - 1, h: lineHash(bytes.subarray(0, bytes.length - 1)), ...((versions[i].voiceover as { lines?: unknown[] } | undefined)?.lines?.length ? { vo: 1 as const } : {}) });
      chunks.push(bytes); at += bytes.length;
    }
    { const handle = await fs.open(tempLog, "wx"); try { await handle.writeFile(Buffer.concat(chunks)); await handle.sync(); } finally { await handle.close(); } }
    const storage = original.storage!;
    const head = { versionLog: { format: LOG_FORMAT, file: logName, cache: cacheName, end: at, pools: { clips: storage.clips ?? {}, shoots: storage.shoots ?? {} }, index, migratedAt: new Date().toISOString() } } as Record<string, unknown>;
    for (const [key, value] of Object.entries(original)) head[key] = key === "versions" ? versions.map(lightEntry) : key === "storage" ? { format: "slim-v1", clips: {}, shoots: {} } : value;
    // 2. Read the temporary log back from disk and prove every version is the old file's version, byte for byte.
    const back = await fs.readFile(tempLog);
    for (const [i, entry] of index.entries()) {
      const line = lineAt(back, entry, tempLog);
      if (line !== lines[i] || !isDeepStrictEqual(JSON.parse(line), versions[i])) return result(false, versions.length, `v${entry.v} did not read back identically`);
    }
    // 3. The whole document as the new readers assemble it equals the old document.
    const rebuilt = documentOf(head as LogHead, index.map(entry => JSON.parse(lineAt(back, entry, tempLog))));
    if (!isDeepStrictEqual(rebuilt, original)) return result(false, versions.length, "the rebuilt edit differs from the original");
    // 4. What readers see of each version (the caller's public view), old against new.
    if (check) for (const [i, entry] of index.entries()) {
      try { await check(entry.v, versions[i], JSON.parse(lineAt(back, entry, tempLog))); }
      catch (error) { return result(false, versions.length, `v${entry.v}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // 5. Switch: keep the old file, put the log in place (nothing reads it yet), then the head in one rename.
    if (await fs.readFile(file, "utf8") !== text) return result(false, versions.length, "the edit changed while it was being moved");
    await fs.writeFile(tempHead, JSON.stringify(head) + "\n", { flag: "wx" });
    { const handle = await fs.open(tempHead, "r"); try { await handle.sync(); } finally { await handle.close(); } }
    const backupTemp = migrationTemp(`${file}${PRE_ARCH2}`);
    await fs.copyFile(file, backupTemp, fs.constants.COPYFILE_EXCL);
    await fs.rename(backupTemp, `${file}${PRE_ARCH2}`);
    await fs.unlink(cacheFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await fs.rename(tempLog, logFile);
    await fs.rename(tempHead, file);
    heads.delete(file); overlayReads.delete(cacheFile);
    // 6. Read the live files the way every reader will. A mismatch puts the old file straight back.
    const live = await readCutDocument(file).catch(() => null), root = shootRootOfCut(file);
    // REL2: readers resolve this shoot's paths against its current root; the original is compared the same way.
    const expected = { ...original, versions: versions.map(v => livePaths(v, root)) };
    if (!live || !isDeepStrictEqual(live, expected)) {
      await fs.copyFile(`${file}${PRE_ARCH2}`, tempHead + ".restore");
      await fs.rename(tempHead + ".restore", file);
      heads.delete(file);
      return result(false, versions.length, "the switched edit did not read back identically; the old file is back");
    }
    return result(true, versions.length);
  } finally {
    await fs.unlink(tempLog).catch(() => {}); await fs.unlink(tempHead).catch(() => {});
  }
}
/** After a day of clean opens, the pre-ARCH2 copy goes. Only when the log reads in full. */
export async function retireOldFile(file: string, head: LogHead, now = Date.now()): Promise<boolean> {
  const backup = `${file}${PRE_ARCH2}`, stat = await fs.stat(backup).catch(() => null);
  const at = Date.parse(head.versionLog.migratedAt ?? "") || stat?.mtimeMs || now;
  if (!stat || now - at < 24 * 60 * 60 * 1000) return false;
  await readCutDocument(file);  // throws on any damaged line: the copy stays
  await fs.unlink(backup);
  return true;
}
/** A line appended after the head's last indexed byte (a save interrupted between the line and the head). It is
 * indexed when it is one whole, valid next version that names its base; anything else is left unread. */
export async function recoverLogTail(file: string, head: LogHead): Promise<{ head: LogHead; recovered: number[] }> {
  const { log } = logPaths(file, head.versionLog), stat = await fs.stat(log).catch(() => null);
  if (!stat || stat.size <= head.versionLog.end) return { head, recovered: [] };
  const handle = await fs.open(log, "r");
  let tail: Buffer;
  try { tail = Buffer.alloc(stat.size - head.versionLog.end); await handle.read(tail, 0, tail.length, head.versionLog.end); }
  finally { await handle.close(); }
  const known = new Set(head.versionLog.index.map(e => e.v)), recovered: (Record<string, unknown> & { version: number })[] = [], entries: LogEntry[] = [];
  let offset = head.versionLog.end, next = Math.max(0, ...known) + 1;
  for (const raw of tail.toString("utf8").split("\n").slice(0, -1)) {   // the last piece has no newline: never whole
    const bytes = Buffer.byteLength(raw), at = offset;
    offset += bytes + 1;
    if (!raw.trim()) continue;
    let parsed: (Record<string, unknown> & { version: number }) | null = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || parsed.version !== next || !Number.isInteger(parsed.baseVersion) || !known.has(parsed.baseVersion as number)) { console.warn(`[edit history] left an unfinished save unread in ${path.basename(log)}`); break; }
    recovered.push(parsed); entries.push({ v: parsed.version, at, n: bytes, h: lineHash(raw), ...((parsed.voiceover as { lines?: unknown[] } | undefined)?.lines?.length ? { vo: 1 as const } : {}) });
    known.add(parsed.version); next++;
  }
  if (!recovered.length) return { head, recovered: [] };
  const updated = await writeHead(file, nextHead(head, null, recovered.map((version, i) => ({ version, entry: entries[i] })), null));
  console.warn(`[edit history] indexed ${recovered.length} interrupted save(s) in ${path.basename(file)}`);
  return { head: updated, recovered: recovered.map(v => v.version) };
}
