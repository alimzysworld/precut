import { needsSoundResolution, migrateSounds as migrateSoundList } from './sound-attachments';
import { withShootWriter, shootHasOtherWriter, trackSave, WriterBusyError, ownsOpenShoot } from "./writer-lock";
import { validateSavedContent } from "./cut-validation";
import { isDeepStrictEqual } from "node:util";
import { handMovedPieces } from "./shot-order";
import { legacyBalanceVersion } from "../shared/clip-balance";
import { DEFAULT_DETAIL, detailReadme } from "../renderer/src/components/finish/detailMath";
import { saveLook } from "./look-saves";
import { validateCover, coverDuration } from "./cover";
import { SOUND_LANES, laneStep, allClipSound, newEditClipSound } from '../shared/lane-levels';
import { getPreferences } from "./settings";
import { repairDraftLength, lengthWarning } from "./draft-length";
import { gradeForLook } from "./grade";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { app, BrowserWindow } from "electron";
import type { Cut, CutEdit, CutVersion, EditorId, PrecutResult, ReelIdea, Shoot, SidekickContext, SidekickMessage, Template, TitleTrack, VideoType, Word } from "../shared/schema";
import { designTitles, styleCaptions, rebuildSubtitles } from "./titles";
import { measureModelWork } from "./model-pace";
import { runModel, SIDEKICK_READ_ONLY_TOOLS } from "./ai";
import { getEditor, getEngine, getAutopilot } from "./settings";
import { reportStage } from "./jobs";
import { effectiveShoot, stepsChanged } from "./steps";
import { listSkills, skillTemplate } from "./skills";
import { assembleReel, measureReelVoice, reelCatalog, reelIds, resolveReelPieces, type ReelAnswer, type ReelAssembly, type ReelResult } from "./reel";
import { buildCutList, cutPieceGroups, sourceWords, snapCutStarts, listTemplates, saveTemplate, type CutItem, type Segment } from "./export";
import { exportForEditor } from "./editors";
import { buildSidekickContext, shootBriefContext } from "./sidekick-context";
import { addQuestion, getBrief, listQuestions } from "./brief";
import { folderHints } from "./folder-shape";
import { parseSidekick, ReplyShapeError } from "./sidekick-validation";
import { finishingProgress } from "./preview";
import { runActivity, currentActivity, withRenderSlot, independentPreparation } from "./activity";
import { editFx, planFx, retimeVersion, carryJoinCraft, carryClipSound, syncFxMetadata } from "./edits-fx";
import { editWords } from "./edits-words";
import { editOverlays, overlayReadme } from "./overlays";
import { applyFinishPlan, finishCatalog } from "./finish-plan";
import { dayFacts, dayOrder, finishVideoType, footageProfile, isVideoType, prepareVideoType, typePlanDefaults, TYPE_LOGIC, VIDEO_TYPE_PROMPT, VIDEO_TYPE_PROMPT_MARKER, type DayFacts } from "./video-types";
import { DEFAULT_CAPTION_STYLE } from "./titles/captions";
import { addRequest, listRequests, processRequests, requestBrief } from "./requests";
import { isStoredCut, slimCut, hydrateCut, readCutFile, readCutVersion, writeJsonAtomic, readLogHead, readLoggedVersion, headFields, appendLogVersions, writeLoggedCut, writeLoggedCache, migrateToLog, recoverLogTail, retireOldFile, logPaths, lightEntry, type LogHead } from "./cut-storage";
import { noteCutWritten, noteCutAppended } from "./cut-summaries";
import { retimeScript } from "./voiceover-retime";
import { keptBeatsFor, anchorKeptBeats, seedKeptBeats, restoreKeptBeats, type KeptBeat } from "./kept-beats";
import { noteCutWrite, commitEdit, markMilestone, currentVersion, outsideCommit, insideCommit, refusedWrite, RevisionConflictError, assertBase } from "./revisions";
import type { EditCutOptions } from "../shared/schema";

// In memory assemblies are full; disk uses index references (see cut-storage).
// Exact spans, templates, music and finishing stay fixed; shoot/clip metadata
// follows the current index, as freshen() does for previews and exports.
export interface StoredVersion extends CutVersion {
  /** Explicit parent of new snapshots; legacy versions predate this field. */
  baseVersion?: number;
  keptBeats?: KeptBeat[];
  keptBeatOrigin?: number;
  keptBeatRestorations?: string[];
  jumpScales?: (number | null)[]; // J4: finish-plan scale decisions, constrained by the measured face box
  soundDesign?: { suppressed: string[]; authored?: import("../shared/schema").SfxItem[] };
  assembly: { shoot: Shoot; template: Template; cutList: CutItem[]; reel: ReelAssembly };
  voiceMixNeedsMeasure?: boolean;
  previewRev?: number;
}
// Bump when the saved draft sound/framing contract needs rebuilding.
export const PREVIEW_REV = 4; // live pictures + cached sound; preview is legacy fallback only
const previewRevision = (_v: CutVersion) => PREVIEW_REV;
// A batch stages existing handlers in memory, including structural edits. Only
// its final snapshot is published; failed validation never changes history.
const batchDraft = new AsyncLocalStorage<{ file: string; cut: StoredCut }>();
/** PRO1: whether this work runs inside a batch's staged draft, whose version numbers are not on disk. */
export const stagedDraft = (): boolean => !!batchDraft.getStore();
/** A batch already owns the edit lock; never wait behind a queued live save
 * that itself needs that lock. Its final snapshot is the one undoable save. */
export function savePlaybackChange(root: string, cutId: string, version: number,
  work: (base: number) => Promise<{ cutId: string; version: number; baseVersion?: number }>,
  targets: (record: StoredVersion) => string = record => JSON.stringify([record.pieces?.map(p => [p.id,p.clipId,p.s,p.e]), record.voiceover?.lines.map(l => [l.id,l.s,l.take])])) {
  return batchDraft.getStore() || insideCommit(root, cutId) ? work(version) : saveLook(root, cutId, version, base =>
    serial(cutFile(path.resolve(root), cutId), () => commitEdit(root, cutId, base, { targets }, async from => ({ ...await work(from), baseVersion: from }))));
}
// VO7-5: the revision each new snapshot was built from, so a voiceover sidecar written for a later
// (undone) revision is never retimed onto it.
const builtFrom = new WeakMap<StoredVersion, number>();
const handSnapshots = new WeakMap<object, CutVersion>();
/** OPEN1: the public snapshot a save's result carries (set by finishStoredVersion and editPiece), for the page. */
export const savedSnapshot = (result: object): CutVersion | undefined => handSnapshots.get(result);
const finishingDraft = new AsyncLocalStorage<{ root: string; cutId: string; source: number;
  record: StoredVersion; assembly: StoredVersion["assembly"]; previous: StoredVersion }>();

// Finishing shares a per-cut queue with edits, title design and preview healing.
// The existing designer can supply a track inside this transaction without
// committing its own intermediate version or broadcasting an unfinished draft.
export function finishStoredVersion<T>(root: string, cutId: string, version: number, create: boolean,
  work: (record: StoredVersion, assembly: StoredVersion["assembly"], baseVersion: number) => Promise<T>, _followLiveSave = false): Promise<T> {
  root = path.resolve(root);
  if (!Number.isInteger(version) || version < 1) return Promise.reject(new Error("Every saved edit must name its base version."));
  return serial(cutFile(root, cutId), () => withShootWriter(root, async () => {
    const signal = currentActivity()?.signal;
    signal?.throwIfAborted();
    // An anchored immutable parent needs one snapshot. Append preserves every
    // old byte; only rewrites need whole-history content validation.
    const staged = !!batchDraft.getStore() || !!finishingDraft.getStore();
    // ARCH2: a log knows its numbers from the head; a cache rewrite reads and writes only this version.
    const head = staged ? null : await writableLog(root, cutId);
    const entry = create && !staged ? head ? { numbers: head.versionLog.index.map(e => e.v) } : await primeRevisionText(cutFile(root, cutId)).catch(() => null) : null;
    const parent = entry ? await loadRevision(root, cutId, version, { light: true }) : null;
    const append = !!parent?.keptBeats && parent.keptBeatOrigin === parent.version;
    const single = !create && !!head && head.versionLog.index.some(e => e.v === version);
    const cut = append ? { cutId, versions: [parent!], exported: [] } : single ? { cutId, versions: [await loadRevision(root, cutId, version, { light: true })], exported: [] } : await readCut(root, cutId);
    const previous = cut.versions.find(v => v.version === version);
    if (!previous?.assembly) throw new Error("Could not find that edit version's saved assembly.");
    if (create && !batchDraft.getStore() && !insideCommit(root, cutId)) await assertBase(root, cutId, version);
    const assembly = await freshen(root, structuredClone(previous.assembly));
    const record: StoredVersion = { ...structuredClone(previous),
      ...(create && !previous.pieces ? { pieces: resolveReelPieces(previous.assembly.shoot, previous.assembly.template, previous.assembly.cutList, previous.assembly.reel) } : {}),
      ...(create ? { keptBeats: await keptBeatsFor(root, cut, previous.version), keptBeatOrigin: previous.version,
        baseVersion: version, version: Math.max(...(append ? entry!.numbers : cut.versions.map((v) => v.version))) + 1,
        createdAt: new Date().toISOString(), preview: null, finished: null } : {}) };
    if (!create && readViews.has(previous)) readViews.set(record, readViews.get(previous)!);
    currentActivity()?.update({ target: { cutId, version: record.version } });
    const result = await finishingDraft.run({ root, cutId, source: previous.version, record, assembly, previous }, () => work(record, assembly, previous.version));
    migrateSounds(record);
    // PRO5: a word asked to sit behind him is checked against his outline on the frames it covers, after every change.
    if (record.overlays?.some(o => o.graphic?.layer === "behind" || o.graphic?.behindNote) || (record.titles as { personMattes?: { behindWord?: true }[] } | null | undefined)?.personMattes?.some(m => m.behindWord))
      await (await import("./titles/mattes")).holdBehindWords(root, record, record.assembly ?? assembly, previous);
    if(create)await (await import('./music-arrange')).pinMusicForHandEdit(root,previous,record);
    signal?.throwIfAborted();
    if (create) { cut.versions.push(record); builtFrom.set(record, previous.version); }
    else cut.versions[cut.versions.indexOf(previous)] = record;
    if (append) await appendRevision(root, cutId, previous, async () => record);
    else if (single) await rewriteCache(root, cutId, previous, record, signal);
    else await atomic(cutFile(root, cutId), cut, signal);
    changed(root, create ? { cutId, version: record.version } : undefined);
    if(create && record.grade?.preset && record.grade.preset!==previous.grade?.preset && !Object.keys(previous.balances ?? {}).length) {
      // Draft publication applies automatically. A later hand-chosen look only prepares offers.
      setImmediate(()=>{void detachedEditWork(()=>import("./balance").then(m=>m.prepareHandClips(root,cutId,record.version))).catch(()=>{});});
    } else if(create && JSON.stringify(record.pieces?.map(p=>p.clipId))!==JSON.stringify(previous.pieces?.map(p=>p.clipId))) {
      setImmediate(()=>{void detachedEditWork(()=>import("./balance").then(m=>m.prepareHandClips(root,cutId,record.version))).catch(()=>{});});
    }
    if (create && result && typeof result === "object") handSnapshots.set(result, publicVersion(record));
    return result;
  }));
}

// Stage preparation on the exact snapshot being saved. Publication starts work
// in a detached async context, after the atomic write, outside the edit queue.
const previewJobs = new WeakMap<StoredVersion, () => void>();
const previewWorker = new AsyncResource('preview-worker');
const preparingPreviews = new Set<string>();
export async function renderStoredPreview(root: string, cutId: string, record: StoredVersion,
  assembly: StoredVersion["assembly"]): Promise<void> {
  if (batchDraft.getStore()) return;
  const context = finishingDraft.getStore();
  if (context?.root === root && context.cutId === cutId) return prepareStoredPreview(root, cutId, record, assembly, context.previous);
  const head = await logHead(root, cutId);
  if (head) {
    // ARCH2: one version, not the history. VO7-2: the current revision it was built from, else the newest snapshot.
    const numbers = head.versionLog.index.map(e => e.v);
    const on = context?.source === undefined ? await currentVersion(root, cutId).catch(() => undefined) : undefined, wanted = context?.source ?? on;
    const pick = wanted !== undefined && numbers.includes(wanted) ? wanted : numbers.at(-1);  // at(-1): no history yet
    return prepareStoredPreview(root, cutId, record, assembly, pick === undefined ? undefined : await loadRevision(root, cutId, pick, { light: true }));
  }
  const savedCut = await readCut(root,cutId).catch(error=>{if((error as NodeJS.ErrnoException).code === "ENOENT")return null;throw error;});
  // VO7-2: a new snapshot follows the current revision (it was built from it), not the newest one.
  const on = savedCut && context?.source === undefined ? await currentVersion(root, cutId).catch(() => undefined) : undefined;
  const previous = savedCut?.versions.find(v=>v.version === (context?.source ?? on)) ?? savedCut?.versions.at(-1);  // at(-1): no history yet
  return prepareStoredPreview(root, cutId, record, assembly, previous);
}
/** VO7-1: the same preparation, given the snapshot it follows, so a commit never rehydrates history. */
export async function prepareStoredPreview(root: string, cutId: string, record: StoredVersion,
  assembly: StoredVersion["assembly"], previous: StoredVersion | undefined): Promise<void> {
  if (batchDraft.getStore()) return;
  migrateSounds(record);
  const structure = (v: StoredVersion) => JSON.stringify([v.assembly.cutList.map(c=>({piece:c.piece,clip:c.seg?.clip.id,in:c.inFrames,out:c.outFrames,length:c.durTimelineFrames})),v.assembly.reel.broll.map(o=>({...o,seg:{...o.seg,clip:{...o.seg.clip,transcript:undefined}}})),
    v.overlays?.map(o=>[o.id,o.sound,o.s,o.e]),v.sfx?.map(s=>[s.id,s.file]),[v.audio?.clean ?? true,v.audio?.denoise ?? .6,v.audio?.auto ?? true,v.audio?.breaths ?? true],v.energy,v.faceMatch,v.framing,v.transition,v.joins,v.layouts,v.angleCuts,v.pieceFx?.flatMap((p,piece)=>p && [p.speed,p.reverse,p.framing,p.background].some(value=>value!==undefined) ? [{piece,speed:p.speed,reverse:p.reverse,framing:p.framing,background:p.background}] : []) ?? []]);
  if (previous && structure(previous) === structure({...record,assembly})) {
    // Adjustment layers save silently. They need no playback media worker.
    record.previewRev = PREVIEW_REV;
    return;
  }
  record.previewRev = 0;
  previewJobs.set(record, () => previewWorker.runInAsyncScope(() => {
    const key = `${root}|${cutId}|${record.version}`;
    if (preparingPreviews.has(key)) return;
    preparingPreviews.add(key);
    const snapshot = structuredClone({ ...record, assembly });
    void runActivity({ kind: "render", root, target: { cutId, version: record.version }, label: "Preparing edit playback", cancelable: true }, async activity => {
      await withRenderSlot(activity, async () => {
        await (await import("./sound-design")).refreshSoundDesign(root, snapshot);
        const { cutList, template } = snapshot.assembly;
        await (await import("./live-sound")).liveSound(root,snapshot,planFx(cutList,template.fps,snapshot));
      }, "background");
      activity.signal.throwIfAborted();
      // Merge only preparation-owned fields into the latest file. Never publish
      // a stale copy of history over another hand edit.
      await serial(cutFile(root, cutId), async () => {
        const head = await logHead(root, cutId);
        // ARCH2: on a log the merge reads one version and writes only its cache overlay.
        const cut = head ? null : await readCut(root, cutId);
        const saved = head ? head.versionLog.index.some(e => e.v === snapshot.version) ? await loadRevision(root, cutId, snapshot.version, { light: true }) : undefined
          : cut!.versions.find(v => v.version === snapshot.version);
        if (!saved) return;
        const merge = (r: StoredVersion) => {
          r.sfx = snapshot.sfx?.length || saved.sfx !== undefined ? snapshot.sfx : undefined; r.warnings = snapshot.warnings;
          r.music = snapshot.music; r.assembly.reel.music = snapshot.assembly.reel.music;
          r.assembly.reel.voiceLUFS = snapshot.assembly.reel.voiceLUFS;
          delete r.voiceMixNeedsMeasure;
          r.previewRev = previewRevision(r);
        };
        const proposal = structuredClone(saved); merge(proposal);
        if (!cacheRewriteAllowed(saved, proposal)) {
          await finishStoredVersion(root, cutId, snapshot.version, true, async r => { merge(r); });
        } else if (head) await rewriteCache(root, cutId, saved, proposal, activity.signal);
        else { merge(saved); await atomic(cutFile(root, cutId), cut, activity.signal); }
        changed(root);
      });
      // Warm picture measurements incrementally too. Each helper takes its own
      // background slot; never hold a media slot while waiting for a cut lock.
      const clips = snapshot.assembly.cutList.flatMap(c => c.seg ? [c.seg.clip] : []);
      if (clips.length && (await Promise.all(clips.map(c => c.proxy ? fs.access(path.join(root, '.sidething/proxies', c.proxy)).then(() => true, () => false) : false))).every(Boolean)) {
        await (await import('./draft')).draftTimeline(root, cutId, snapshot.version);
        changed(root);
      }
      finishingProgress(root, cutId, 100);
    }, { renderLane: "background", deferRenderSlot: true }).catch(error => {
      // runActivity already reports failure, including cancellation, in place.
      console.warn("Could not prepare edit playback:", error);
    }).finally(() => preparingPreviews.delete(key));
  }));
}

function migrateSounds(record: StoredVersion): StoredVersion {
  if (!needsSoundResolution(record)) return record;
  return migrateSoundList(record, planFx(record.assembly.cutList, record.assembly.template.fps, record), record.assembly.template.fps);
}
function legacySoundVersion(version: StoredVersion): StoredVersion {
  const balanced = legacyBalanceVersion(version);
  if (!balanced.assembly) return balanced;
  const migrated = migrateSounds({ ...balanced, warnings: [...balanced.warnings ?? []] });
  return JSON.stringify([balanced.sfx, balanced.joins, balanced.transition, balanced.overlays]) === JSON.stringify([migrated.sfx, migrated.joins, migrated.transition, migrated.overlays]) ? balanced : migrated;
}

// ---- VO7-1: append-friendly history writes (revisions.ts commit is the caller).
// The edit file stays one slim JSON document, so every reader works unchanged. A commit appends its
// snapshot by splicing its JSON in before the versions array closes: older snapshots' bytes are
// copied verbatim, never re-serialised, and only the small tail (exports, storage pool) is rebuilt.
interface RevisionText {
  identity: string; text: string;
  spans: [number, number][];            // where each version's JSON sits, in array order
  numbers: number[]; byNumber: Map<number, number>;
  close: number;                        // index of the "]" closing the versions array
  after: [string, unknown][];           // top-level fields after versions, in file order
  lastVoiceover: number | null;         // array index of the last version with placed voiceover lines
}
const revisionText = new Map<string, RevisionText>();
const fileIdentity = (s: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) => JSON.stringify([s.ino, s.size, s.mtimeMs, s.ctimeMs]);
const tailOf = (fields: [string, unknown][]) => fields.map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`).join("") + "}\n";
/** Index the file once per outside change: parse it, and prove the layout byte for byte. null = use the whole-file path. */
async function primeRevisionText(file: string): Promise<RevisionText | null> {
  if (await readLogHead(file).catch(() => null)) return null;  // ARCH2: a log appends lines (appendLogged)
  const before = await fs.stat(file), identity = fileIdentity(before), cached = revisionText.get(file);
  if (cached?.identity === identity) { revisionText.delete(file); revisionText.set(file, cached); return cached; }
  // A retained fat backup means slimming has not been verified yet; readCutFile owns that file.
  if (await fs.access(`${file}.fat-backup`).then(() => true, () => false)) return null;
  const text = await fs.readFile(file, "utf8");
  if (fileIdentity(await fs.stat(file)) !== identity) return null;
  const raw = JSON.parse(text) as Record<string, unknown> & { versions?: StoredVersion[]; storage?: { format?: string } };
  if (raw.storage?.format !== "slim-v1" || !Array.isArray(raw.versions)) return null;
  const keys = Object.keys(raw), at = keys.indexOf("versions");
  const head = `{${keys.slice(0, at).map(k => `${JSON.stringify(k)}:${JSON.stringify(raw[k])}`).join(",")}${at ? "," : ""}"versions":[`;
  if (at < 0 || !text.startsWith(head)) return null;
  const spans: [number, number][] = [];
  let pos = head.length, lastVoiceover: number | null = null, slice = performance.now();
  for (const [i, version] of raw.versions.entries()) {
    if (i) { if (text[pos] !== ",") return null; pos++; }
    const json = JSON.stringify(version);
    if (!text.startsWith(json, pos)) return null;
    spans.push([pos, pos + json.length]); pos += json.length;
    if (version.voiceover?.lines?.length) lastVoiceover = i;
    if (performance.now() - slice > 8) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now(); }
  }
  const after = keys.slice(at + 1).map(k => [k, raw[k]] as [string, unknown]);
  if (text[pos] !== "]" || text.slice(pos + 1) !== tailOf(after)) return null;
  const numbers = raw.versions.map(v => v.version);
  const entry: RevisionText = { identity, text, spans, numbers, byNumber: new Map(numbers.map((n, i) => [n, i])), close: pos, after, lastVoiceover };
  revisionText.set(file, entry);
  // Two edits' text at most: a 22 MB history is held once, not per open panel.
  while (revisionText.size > 2) revisionText.delete(revisionText.keys().next().value!);
  return entry;
}
async function trashedSourceCheck(raw: unknown, current?: Shoot) {
  // Same rule as cut-storage's readers (ST1): a trashed original never becomes an opaque missing-index error.
  if (!current) return;
  const review = await fs.readFile(path.join(current.root, ".sidething/junk.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return '{"trashed":[]}';
  });
  const removed = (JSON.parse(review).trashed ?? []) as import("../shared/schema").Clip[];
  if (!removed.length) return;
  const references = JSON.stringify(raw);
  for (const clip of removed) if (!current.clips.some(c => c.id === clip.id) &&
      (references.includes(`"id":${JSON.stringify(clip.id)}`) || references.includes(`"clipId":${JSON.stringify(clip.id)}`)))
    throw Object.assign(new Error(`The shot "${clip.judgement?.summary || clip.id}" was moved to the Trash. Restore it and read the shoot again to use this edit.`), { code: "ST1_TRASHED_SOURCE" });
}
// The shoot index (7 MB on a real shoot) parsed once per change, for revision internals that only read it.
const indexReads = new Map<string, { identity: string; shoot: Shoot }>();
async function sharedIndex(root: string): Promise<Shoot | undefined> {
  const stat = await fs.stat(path.join(root, ".sidething/index.json")).catch(() => null);
  if (!stat) return undefined;
  const identity = fileIdentity(stat), cached = indexReads.get(root);
  if (cached?.identity === identity) return cached.shoot;
  const shoot = await currentIndex(root);
  if (!shoot) return undefined;
  indexReads.set(root, { identity, shoot });
  while (indexReads.size > 2) indexReads.delete(indexReads.keys().next().value!);
  return shoot;
}
/** One revision, as loadDraftVersion returns it, read from the indexed text without parsing the whole history.
 * light: read-only internal use (retiming, target checks): shares the cached index and skips freshen. */
export async function loadRevision(root: string, cutId: string, version: number, options?: { light?: boolean; view?: boolean }): Promise<StoredVersion> {
  root = path.resolve(root);
  const file = cutFile(root, cutId);
  if (batchDraft.getStore() || finishingDraft.getStore()) return loadDraftVersion(root, cutId, version);
  return serial(file, async () => {
    // ARCH2: on a log, one line. view: what readCut holds for this version (an owned index, not freshened), for writers.
    const head = await readLogHead(file).catch(() => null), logged = head && await readLoggedVersion(file, head, version);
    if (head && logged) {
      const shoot = options?.light ? await sharedIndex(root) : await currentIndex(root), fields = headFields(head);
      await trashedSourceCheck(logged, shoot);
      const hydrated = hydrateCut({ ...fields, storage: structuredClone(fields.storage), cutId, versions: [logged] } as unknown as StoredCut, shoot).versions[0];
      const record = legacySoundVersion(await repairVoiceStarts(hydrated));
      if (!record?.assembly) throw new Error("Could not find that edit version's saved assembly.");
      if (options?.light || options?.view) return record;
      const loaded = { ...record, assembly: await freshen(root, record.assembly, shoot) };
      if(loaded.balanceReference===undefined && loaded.grade?.matchClips && loaded.grade.matchRef!=null)loaded.balanceReference=loaded.pieces?.[loaded.grade.matchRef]?.clipId ?? null;
      return loaded;
    }
    if (head) return loadDraftVersion(root, cutId, version);
    const entry = await primeRevisionText(file).catch(() => null), index = entry?.byNumber.get(version);
    if (!entry || index === undefined) return loadDraftVersion(root, cutId, version);
    // A full load owns its parse of the index, as loadDraftVersion does; hydrate and freshen share it.
    const shoot = options?.light ? await sharedIndex(root) : await currentIndex(root), slim = JSON.parse(entry.text.slice(...entry.spans[index]));
    await trashedSourceCheck(slim, shoot);
    const hydrated = hydrateCut({ ...Object.fromEntries(entry.after), cutId, versions: [slim] } as unknown as StoredCut, shoot).versions[0];
    const record = legacySoundVersion(await repairVoiceStarts(hydrated));
    if (!record?.assembly) throw new Error("Could not find that edit version's saved assembly.");
    if (options?.light || options?.view) return record;
    const loaded = { ...record, assembly: await freshen(root, record.assembly, shoot) };
    if(loaded.balanceReference===undefined && loaded.grade?.matchClips && loaded.grade.matchRef!=null)loaded.balanceReference=loaded.pieces?.[loaded.grade.matchRef]?.clipId ?? null;
    return loaded;
  });
}
/** OPEN1: an append adds one snapshot. The listing kept for the bytes before it gains that one snapshot's public
 * view, built the way readCut builds it from what was written (hydrated against the current index, repaired,
 * made public), instead of the next listing re-reading and rebuilding all 569 (1 to 2 s on his edit, while the
 * new version waits to draw). Only when that listing was of exactly the file before this append and the index
 * has not changed since; anything else leaves the cache empty and the next listing reads the file. */
async function extendPublic(root: string, file: string, prior: { identity: string; cut: Cut } | undefined, before: string, json: string, after: [string, unknown][]) {
  if (!prior) return;
  const [ino, size, mtimeMs, ctimeMs] = JSON.parse(before) as number[], [priorFile, priorIndex] = JSON.parse(prior.identity) as unknown[];
  const identity = await cutIdentity(root, file), [, indexNow] = JSON.parse(identity) as unknown[];
  if (JSON.stringify(priorFile) !== JSON.stringify([size, mtimeMs, ctimeMs, ino]) || JSON.stringify(priorIndex) !== JSON.stringify(indexNow)) return;
  const shoot = await currentIndex(root), slim = JSON.parse(json);
  await trashedSourceCheck(slim, shoot);
  const hydrated = hydrateCut({ ...Object.fromEntries(after), cutId: prior.cut.cutId, versions: [slim] } as unknown as StoredCut, shoot).versions[0];
  const projected = legacySoundVersion(await repairVoiceStarts(hydrated, shoot ? new Map() : undefined));
  if (identity !== await cutIdentity(root, file)) return;
  publicSnapshots.delete(file);
  publicSnapshots.set(file, { identity, cut: { ...prior.cut, versions: [...prior.cut.versions, structuredClone(publicVersion(projected))] } });
}
async function writeTextAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, text, { flag: "wx" }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
// ---- ARCH2: the log-format writers (cut-storage.ts holds the format). Every caller holds the edit's queue and lease.
/** The head of an edit kept as a log, or null (one-file format, or no file yet). */
async function logHead(root: string, cutId: string): Promise<LogHead | null> {
  return readLogHead(cutFile(path.resolve(root), cutId)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
}
/** A writer's view of a log: an interrupted save is settled first, so the next number is the next free one. */
async function writableLog(root: string, cutId: string): Promise<LogHead | null> {
  const head = await logHead(root, cutId);
  return head && settledLog(path.resolve(root), cutId, cutFile(path.resolve(root), cutId), head);
}
/** A save interrupted between its line and the head: index it when it is whole and names its base, and let the
 * history decide (it becomes current only when its base still is). */
async function settledLog(root: string, cutId: string, file: string, head: LogHead): Promise<LogHead> {
  const { head: settled, recovered } = await recoverLogTail(file, head);
  if (recovered.length) {
    const bases = Object.fromEntries(settled.versions.filter(v => recovered.includes(v.version)).map(v => [v.version, v.baseVersion as number]));
    await noteCutWrite(root, cutId, { versions: settled.versionLog.index.map(e => e.v), bases, exported: (settled.exported ?? []) as StoredCut["exported"] });
  }
  return settled;
}
/** appendRevisionOwned on a log: the same snapshot rules as the one-file splice, written as one new line. */
async function appendLogged(root: string, cutId: string, file: string, head: LogHead, base: StoredVersion,
  make: (base: StoredVersion, next: number) => Promise<StoredVersion>, whole: (record?: StoredVersion) => Promise<number>): Promise<number> {
  head = await settledLog(root, cutId, file, head);
  const numbers = head.versionLog.index.map(e => e.v), next = Math.max(0, ...numbers) + 1, record = await make(base, next);
  record.baseVersion = base.version; builtFrom.set(record, base.version);
  record.version = next; record.createdAt = new Date().toISOString();
  const anchored = (v: StoredVersion) => !!v.keptBeats && v.keptBeatOrigin === v.version;
  // Kept beats walk history; from an anchored base (or snapshot) one step is the same walk. make() may have written.
  if (record.assembly && !anchored(base) && !anchored(record) || await readLogHead(file) !== head) return whole(record);
  forgetListings(file);
  const job = previewJobs.get(record);
  previewJobs.delete(record);
  if (record.assembly) {
    record.keptBeats = anchorKeptBeats(record, await keptBeatsFor(root, { cutId, versions: [base, record] }, record.version));
    record.keptBeatOrigin = record.version;
  }
  const onDisk = await fs.readFile(path.join(root, ".sidething/voiceover", `${cutId}.json`), "utf8")
    .then(raw => JSON.parse(raw) as import("../shared/schema").VoiceoverScript, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  const lastVoice = [...head.versionLog.index].reverse().find(e => e.vo)?.v;
  // VO7-5: a sidecar from a later revision than this one's base (an undone one) is not this edit's voice.
  const script = (onDisk && onDisk.version <= base.version ? onDisk : null) ?? record.voiceover ?? (lastVoice === undefined ? undefined : (await loadRevision(root, cutId, lastVoice, { light: true })).voiceover);
  if (script && script.version < record.version && (record.voiceover?.version !== record.version || record.keptBeatRestorations?.length)) {
    const source = numbers.includes(script.version) ? await loadRevision(root, cutId, script.version, { light: true }) : undefined;
    record.voiceover = retimeScript(script, source, record, {
      before: source ? planFx(source.assembly.cutList, source.assembly.template.fps, source) : undefined,
      after: planFx(record.assembly.cutList, record.assembly.template.fps, record),
    });
    // 0.7.1: a picture edit that moved the voice moves its captions in this same save.
    if (record.assembly && record.titles) await (await import("./caption-realign")).followCaptionsToVoice(root, record);
  }
  const slim = slimCut({ cutId, versions: [record] } as unknown as StoredCut, await sharedIndex(root));
  if (!insideCommit(root, cutId)) await assertBase(root, cutId, base.version);
  const written = await appendLogVersions(file, head, [slim.versions[0] as unknown as Record<string, unknown> & { version: number }], slim.storage);
  await noteCutWritten(file, written as unknown as Parameters<typeof noteCutWritten>[1]);
  await noteCutWrite(root, cutId, { versions: [...numbers, next], bases: { [next]: base.version }, exported: (written.exported ?? []) as StoredCut["exported"] });
  if (job) setImmediate(job);
  if (record.autoLayouts?.enabled) setImmediate(() => { void import('./auto-layouts').then(m => m.queueAutoLayouts(root, cutId, record.version)); });
  return next;
}
const CACHE_FIELDS = ["previewRev", "preview", "finished", "warnings", "voiceMixNeedsMeasure", "autoLayouts", "sfx"] as const;
/** ARCH1's in-place rule on a log: `after` may differ from `before` only in cache fields, and only those are written,
 * as an overlay for that version. The saved line is never rewritten. */
async function rewriteCache(root: string, cutId: string, before: StoredVersion, after: StoredVersion, signal?: AbortSignal): Promise<void> {
  if (before.version !== after.version || !cacheRewriteAllowed(before, after)) throw new Error("Saved edit content needs a new version with a base.");
  const file = cutFile(path.resolve(root), cutId), head = await readLogHead(file);
  if (!head) throw new Error("This edit is not kept as a log.");
  const stored = await readLoggedVersion(file, head, after.version);
  if (!stored) throw new Error("That edit version does not exist.");
  const job = previewJobs.get(after);
  previewJobs.delete(after);
  const plain = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const desired = JSON.parse(JSON.stringify(stored)) as Record<string, unknown> & { version: number; assembly?: { reel?: Record<string, unknown> } };
  for (const key of CACHE_FIELDS) { const value = plain((after as unknown as Record<string, unknown>)[key]); if (value === undefined) delete desired[key]; else desired[key] = value; }
  if (desired.assembly?.reel && after.assembly?.reel) for (const key of ["voiceLUFS", "why"] as const) {
    const value = plain(after.assembly.reel[key]);
    if (value === undefined) delete desired.assembly.reel[key]; else desired.assembly.reel[key] = value;
  }
  signal?.throwIfAborted();
  await writeLoggedCache(file, head, [desired]);
  forgetListings(file);
  if (job) setImmediate(job);
}
/** A day after the move, an open that reads the whole log cleanly retires <id>.json.pre-arch2. */
async function retireOld(root: string, file: string): Promise<void> {
  if (!await fs.access(`${file}.pre-arch2`).then(() => true, () => false)) return;
  await withShootWriter(root, async () => {
    const head = await readLogHead(file);
    if (head && await retireOldFile(file, head)) console.log(`[edit history] removed ${path.basename(file)}.pre-arch2: the log has read cleanly for a day`);
  }).catch(error => { if (!(error instanceof WriterBusyError)) console.warn("[edit history]", error); });
}
/** First open of an edit in the one-file format, by the app that owns the shoot: move it to the log, verified. */
const migrationRefused = new Map<string, string>();
async function migrateEdit(root: string, file: string, shoot: Shoot | undefined): Promise<void> {
  // QA only (qa/ARCH2): keep one-file edits as they are, to compare the two formats in one build.
  if (!ownsOpenShoot(root) || process.env.PRECUT_QA_ARCH2_ONE_FILE === "1") return;
  // QA only (qa/ARCH2): make the read-back check fail on this version number, to prove a mismatch keeps the old file.
  const forced = Number(process.env.PRECUT_QA_ARCH2_MISMATCH ?? NaN);
  const stat = await fs.stat(file).catch(() => null), identity = stat ? fileIdentity(stat) : "";
  if (!stat || migrationRefused.get(file) === identity) return;
  // Readers see each version's public view (hydrated, repaired, made public): it must be the same string before and after.
  const view = async (fields: Record<string, unknown>, version: Record<string, unknown>, starts?: Map<string, number>) => {
    const hydrated = hydrateCut({ ...fields, versions: [version] } as unknown as StoredCut, shoot).versions[0];
    return JSON.stringify(publicVersion(legacySoundVersion(await repairVoiceStarts(hydrated, starts))));
  };
  let fields: Record<string, unknown> | null = null;
  const before = shoot ? new Map<string, number>() : undefined, after = shoot ? new Map<string, number>() : undefined;
  const result = await withShootWriter(root, async () => {
    fields ??= (({ versions: _v, ...rest }) => rest)(JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>);
    return migrateToLog(file, async (version, old, moved) => {
      if (version === forced || await view(fields!, old, before) !== await view(fields!, moved, after)) throw new Error(`v${version} reads differently`);
    });
  }).catch(error => { if (error instanceof WriterBusyError) return null; throw error; });
  if (!result) return;
  forgetListings(file); revisionText.delete(file);
  if (result.migrated) console.log(`[edit history] ${path.basename(file)} now saves by appending: ${result.versions} versions read back identically in ${result.ms} ms; the old file is kept as ${path.basename(file)}.pre-arch2`);
  else if (result.reason !== "already in the log format") { migrationRefused.set(file, identity); console.warn(`[edit history] kept ${path.basename(file)} in the one-file format: ${result.reason}`); }
}
/** Append one snapshot built by make(base, next). Caller holds the cut lock (revisions.commit).
 * Does for this snapshot exactly what atomic() does for the newest one; falls back to atomic's
 * whole-file write whenever the fast layout cannot be proven. Returns the new version number. */
export async function appendRevision(root: string, cutId: string, base: StoredVersion,
  make: (base: StoredVersion, next: number) => Promise<StoredVersion>): Promise<number> {
  if (!Number.isInteger(base?.version)) throw new Error("Every saved edit must name its base version.");
  return serial(cutFile(path.resolve(root), cutId), () => withShootWriter(root, () => appendRevisionOwned(root, cutId, base, make)));
}
async function appendRevisionOwned(root: string, cutId: string, base: StoredVersion,
  make: (base: StoredVersion, next: number) => Promise<StoredVersion>): Promise<number> {
  root = path.resolve(root);
  if (!insideCommit(root, cutId)) await assertBase(root, cutId, base.version);
  const file = cutFile(root, cutId);
  const whole = async (record?: StoredVersion) => {
    const cut = await readCut(root, cutId), next = Math.max(0, ...cut.versions.map(v => v.version)) + 1;
    const built = record ?? await make(base, next);
    // Only if the file changed under the lock: keep a voiceover that make() tagged as this revision's.
    if (record && built.voiceover?.version === built.version) built.voiceover = { ...built.voiceover, version: next };
    built.baseVersion = base.version; builtFrom.set(built, base.version);
    built.version = next; built.createdAt = new Date().toISOString();
    cut.versions.push(built);
    await atomic(file, cut);
    return next;
  };
  const head = batchDraft.getStore() || finishingDraft.getStore() ? null : await readLogHead(file).catch(() => null);
  if (head) return appendLogged(root, cutId, file, head, base, make, whole);
  const entry = batchDraft.getStore() || finishingDraft.getStore() ? null : await primeRevisionText(file).catch(() => null);
  if (!entry) return whole();
  const next = Math.max(0, ...entry.numbers) + 1, record = await make(base, next);
  record.baseVersion = base.version; builtFrom.set(record, base.version);
  record.version = next; record.createdAt = new Date().toISOString();
  const anchored = (v: StoredVersion) => !!v.keptBeats && v.keptBeatOrigin === v.version;
  // Kept beats walk history; from an anchored base (or snapshot) one step is the same walk.
  if (fileIdentity(await fs.stat(file)) !== entry.identity || record.assembly && !anchored(base) && !anchored(record)) return whole(record);
  const priorPublic = publicSnapshots.get(file);
  publicSnapshots.delete(file);
  const job = previewJobs.get(record);
  previewJobs.delete(record);
  if (record.assembly) {
    record.keptBeats = anchorKeptBeats(record, await keptBeatsFor(root, { cutId, versions: [base, record] }, record.version));
    record.keptBeatOrigin = record.version;
  }
  const onDisk = await fs.readFile(path.join(root, ".sidething/voiceover", `${cutId}.json`), "utf8")
    .then(raw => JSON.parse(raw) as import("../shared/schema").VoiceoverScript, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  // VO7-5: a sidecar from a later revision than this one's base (an undone one) is not this edit's voice.
  const script = (onDisk && onDisk.version <= base.version ? onDisk : null) ?? record.voiceover ?? (entry.lastVoiceover === null ? undefined : (await loadRevision(root, cutId, entry.numbers[entry.lastVoiceover], { light: true })).voiceover);
  if (script && script.version < record.version && (record.voiceover?.version !== record.version || record.keptBeatRestorations?.length)) {
    const source = entry.byNumber.has(script.version) ? await loadRevision(root, cutId, script.version, { light: true }) : undefined;
    record.voiceover = retimeScript(script, source, record, {
      before: source ? planFx(source.assembly.cutList, source.assembly.template.fps, source) : undefined,
      after: planFx(record.assembly.cutList, record.assembly.template.fps, record),
    });
    // 0.7.1: a picture edit that moved the voice moves its captions in this same save.
    if (record.assembly && record.titles) await (await import("./caption-realign")).followCaptionsToVoice(root, record);
  }
  const slim = slimCut({ cutId, versions: [record] } as unknown as StoredCut, await sharedIndex(root));
  const after = entry.after.map(([k, v]) => k !== "storage" ? [k, v] as [string, unknown] : [k, { ...v as object, format: "slim-v1",
    clips: { ...(v as typeof slim.storage).clips, ...slim.storage.clips }, shoots: { ...(v as typeof slim.storage).shoots, ...slim.storage.shoots } }] as [string, unknown]);
  const json = JSON.stringify(slim.versions[0]), start = entry.close + (entry.numbers.length ? 1 : 0);
  const text = entry.text.slice(0, entry.close) + (entry.numbers.length ? "," : "") + json + "]" + tailOf(after);
  if (!insideCommit(root, cutId)) await assertBase(root, cutId, base.version);
  await writeTextAtomic(file, text);
  { const [, size, mtimeMs] = JSON.parse(entry.identity) as number[]; await noteCutAppended(file, { size, mtimeMs }, record.createdAt); }  // OPEN1
  await extendPublic(root, file, priorPublic, entry.identity, json, after).catch(() => publicSnapshots.delete(file));
  const numbers = [...entry.numbers, next];
  revisionText.set(file, { identity: fileIdentity(await fs.stat(file)), text, spans: [...entry.spans, [start, start + json.length]], numbers,
    byNumber: new Map(entry.byNumber).set(next, numbers.length - 1), close: start + json.length, after,
    lastVoiceover: record.voiceover?.lines?.length ? numbers.length - 1 : entry.lastVoiceover });
  await noteCutWrite(root, cutId, { versions: numbers, bases: { [next]: base.version }, exported: (Object.fromEntries(after).exported ?? []) as StoredCut["exported"] });
  if (job) setImmediate(job);
  if (record.autoLayouts?.enabled) setImmediate(() => { void import('./auto-layouts').then(m => m.queueAutoLayouts(root, cutId, record.version)); });
  return next;
}

/** Read an immutable version and refresh only its clip metadata, as exports do. */
export async function loadDraftVersion(root: string, cutId: string, version: number | 'latest'): Promise<StoredVersion> {
  const file = cutFile(root, cutId), staged = batchDraft.getStore();
  let current: Shoot | undefined;
  // 'latest' (and its at(-1)) is the newest snapshot by design; callers acting on an edit pass currentVersion.
  const record = staged?.file === file ? structuredClone(version === 'latest' ? staged.cut.versions.at(-1) : staged.cut.versions.find(v => v.version === version))
    : await serial(file, async () => {
      current = await currentIndex(root);
      // OPEN1: right after an append the history's text is already indexed in memory (revisionText, kept by the
      // writer). Read the one version from its span instead of parsing the whole 45 MB file again; the same
      // checks, hydration and repairs as readCutVersion's slim path, so the record is the same.
      const text = revisionText.get(file), at = text && (version === 'latest' ? text.numbers.length - 1 : text.byNumber.get(version));
      if (text && at !== undefined && at >= 0 && fileIdentity(await fs.stat(file)) === text.identity) {
        const selected = JSON.parse(text.text.slice(...text.spans[at])) as StoredVersion, fields = Object.fromEntries(text.after) as { storage?: unknown };
        await trashedSourceCheck([selected], current);
        return legacySoundVersion(await repairVoiceStarts(hydrateCut({ ...fields, storage: structuredClone(fields.storage), cutId, versions: [selected] } as unknown as StoredCut, current).versions[0]));
      }
      return legacySoundVersion(await repairVoiceStarts(await readCutVersion(file, version, current, { ownedIndex: true })));
    });
  if (!record?.assembly) throw new Error("Could not find that edit version's saved assembly.");
  const loaded={ ...record, assembly: await freshen(root, record.assembly, current) };
  // Read legacy reference choices without starting a model or rewriting history.
  if(loaded.balanceReference===undefined && loaded.grade?.matchClips && loaded.grade.matchRef!=null)loaded.balanceReference=loaded.pieces?.[loaded.grade.matchRef]?.clipId ?? null;
  return loaded;
}

// A saved assembly holds the clips as they were when it was cut. Swap in the
// shoot's current clips (subject track, matched mic) so a re-render or an
// export uses what is known now; the cut points themselves never change.
async function freshen(root: string, assembly: StoredVersion["assembly"], current?: Shoot): Promise<StoredVersion["assembly"]> {
  let shoot: Shoot;
  try { shoot = current ?? effectiveShoot(JSON.parse(await fs.readFile(path.join(root, ".sidething/index.json"), "utf8"))); }
  catch { return assembly; }
  shoot = (await import('./layout-media')).withLayoutMedia(assembly,shoot);
  const byId = new Map(shoot.clips.map((c) => [c.id, c]));
  // Cuts saved before sub-items existed carry no piece index: their position is the piece.
  const swap = (raw: CutItem, index: number): CutItem => {
    const item = raw.piece === undefined ? { ...raw, piece: index } : raw;
    return item.seg && byId.has(item.seg.clip.id) ? { ...item, seg: { ...item.seg, clip: byId.get(item.seg.clip.id)! } } : item;
  };
  return { ...assembly, shoot, cutList: assembly.cutList.map(swap), reel: { ...assembly.reel,
    broll: assembly.reel.broll.map((overlay) => ({ ...overlay,
      seg: { ...overlay.seg, clip: byId.get(overlay.seg.clip.id) ?? overlay.seg.clip } })) } };
}
export interface StoredCut extends Omit<Cut, "versions"> { versions: StoredVersion[] }
const folder = (root: string) => path.join(root, ".sidething", "sidekick");
const queues = new Map<string, Promise<unknown>>();
const activeQueue = new AsyncLocalStorage<ReadonlySet<string>>();
function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  // A routed title request shares its chat turn's transaction and notifications.
  if (activeQueue.getStore()?.has(key)) return work();
  const next = (queues.get(key) ?? Promise.resolve()).then(() => activeQueue.run(new Set([...(activeQueue.getStore() ?? []), key]), work));
  const settled = next.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return trackSave(next);  // FIX2: quit waits for queued saves
}
/** Public mutation queues take the process lease; private reader queues stay readable. */
export function withShootLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  key = path.resolve(key);
  const marker = key.indexOf(`${path.sep}.sidething${path.sep}`);
  const root = marker < 0 ? key : key.slice(0, marker);
  return serial(key, () => withShootWriter(root, work));
}
export { atomic as saveCutFile, cutFile, readCut, freshen };
// Background correction must leave every edit/batch context, including an expired lock owner.
export function detachedEditWork<T>(work:()=>Promise<T>):Promise<T> {
  // VO7-2: and the commit that started it, so its own writes publish as its own commit.
  return outsideCommit(()=>activeQueue.exit(()=>batchDraft.exit(()=>finishingDraft.exit(()=>independentPreparation(work)))));
}

function serialWithCut<T>(root: string, cutId: string | undefined, work: () => Promise<T>): Promise<T> {
  return serial(root, () => serial(cutId ? cutFile(root, cutId) : root, work));
}

async function atomic(file: string, value: unknown, signal?: AbortSignal): Promise<void> {
  const root = path.resolve(path.dirname(file), "../../..");
  if (isStoredCut(value)) return serial(file, () => withShootWriter(root, () => atomicOwned(file, value, signal)));
  return atomicOwned(file, value, signal);
}

/** Cache fields are derived playback artifacts or model reply/status, never editorial choices. */
function contentView(version: StoredVersion) {
    const { previewRev, preview, finished, warnings, voiceMixNeedsMeasure, autoLayouts, assembly, sfx, ...rest } = version;
    // Do not clone shoot/clip metadata for every old snapshot just to omit it.
    const seg = (s: StoredVersion["assembly"]["reel"]["broll"][number]["seg"]) => ({ ...s, clip: { id: s.clip.id } });
    const a = assembly && { ...assembly, shoot: { root: assembly.shoot.root },
      cutList: assembly.cutList.map(c => ({ ...c, seg: c.seg ? seg(c.seg) : c.seg })),
      reel: { ...assembly.reel, why: assembly.reel.why?.replace(/\n\n\[Energy framing\][\s\S]*?\[\/Energy framing\]/g, ""), voiceLUFS: undefined, broll: assembly.reel.broll.map(c => ({ ...c, seg: seg(c.seg) })) } };
    // autoSounds derives these playback rows from joins, caption landings,
    // bleeps and soundDesign.authored. Hand sounds remain immutable content.
    const manualSounds = sfx?.filter(sound => !sound.auto);
    return { ...rest, ...(manualSounds?.length ? { sfx: manualSounds } : {}), ...(a ? { assembly: a } : {}),
      ...(autoLayouts ? { autoLayouts: { enabled: autoLayouts.enabled, offerOnly: autoLayouts.offerOnly } } : {}) };
}
const savedContent = (version: StoredVersion) => JSON.parse(JSON.stringify(contentView(version)));
export function cacheRewriteAllowed(before: StoredVersion, after: StoredVersion): boolean {
  return isDeepStrictEqual(savedContent(before), savedContent(after));
}
// A legacy repair is a read view. Keep its stored source so a metadata/cache save
// cannot accidentally persist that content repair into an immutable undo snapshot.
const readViews = new WeakMap<StoredVersion, { stored: StoredVersion; content: string }>();
const contentKey = (v: StoredVersion) => createHash("sha256").update(JSON.stringify(savedContent(v))).digest("hex");
function storedView(v: StoredVersion): StoredVersion {
  const view = readViews.get(v);
  if (!view || view.stored.version !== v.version) return v;
  if (contentKey(v) !== view.content) throw new Error("Saved edit content needs a new version with a base.");
  const stored = { ...view.stored };
  for (const key of ["previewRev", "preview", "finished", "warnings", "voiceMixNeedsMeasure", "autoLayouts", "sfx"] as const) {
    if (key === "sfx" && (v.sfx?.some(s => s.legacyMix) || JSON.stringify([view.stored.joins, view.stored.transition, view.stored.overlays]) !== JSON.stringify([v.joins, v.transition, v.overlays]))) continue;
    if (Object.hasOwn(v, key)) (stored as unknown as Record<string, unknown>)[key] = v[key];
    else delete stored[key];
  }
  if (stored.assembly) stored.assembly = { ...stored.assembly, reel: { ...stored.assembly.reel, why: v.assembly.reel.why, voiceLUFS: v.assembly.reel.voiceLUFS } };
  return stored;
}
async function validateCutWrite(root: string, cut: StoredCut): Promise<Set<number>> {
  const index = await currentIndex(root);
  const checked = await validateSavedContent(cutFile(root, cut.cutId), cut.versions, index?.root, contentView, index?.clips.map(clip => clip.id));
  const added = new Set(checked.added);
  if (checked.existing && !insideCommit(root, cut.cutId)) for (const v of cut.versions) if (added.has(v.version)) await assertBase(root, cut.cutId, v.baseVersion!);
  return added;
}
/** What saving does to the snapshot it appends: its kept beats anchored, the voiceover retimed to the new picture and
 * the captions following the voice. PRO2b: exported so a staged draft (Produce's review) is watched as it will be saved. */
export async function settleSnapshot(root: string, saved: StoredCut, latest: StoredVersion): Promise<void> {
  const onDisk = await fs.readFile(path.join(root, ".sidething/voiceover", `${saved.cutId}.json`), "utf8")
    .then(raw => JSON.parse(raw) as import("../shared/schema").VoiceoverScript, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  if (latest.assembly) {
    migrateSounds(latest);
    latest.keptBeats = anchorKeptBeats(latest,await keptBeatsFor(root, saved, latest.version));
    latest.keptBeatOrigin = latest.version;
  }
  const from = builtFrom.get(latest);
  const sidecar = onDisk && from !== undefined && onDisk.version > from ? null : onDisk;
  const script = sidecar ?? latest.voiceover ?? [...saved.versions].reverse().find(v => v.voiceover?.lines.length)?.voiceover;
  if (script && script.version < latest.version && (latest.voiceover?.version !== latest.version || latest.keptBeatRestorations?.length)) {
    const source = saved.versions.find(v => v.version === script.version);
    latest.voiceover = retimeScript(script, source, latest, {
      before: source ? planFx(source.assembly.cutList, source.assembly.template.fps, source) : undefined,
      after: planFx(latest.assembly.cutList, latest.assembly.template.fps, latest),
    });
    // 0.7.1: a picture edit that moved the voice moves its captions in this same save.
    if (latest.titles) await (await import("./caption-realign")).followCaptionsToVoice(root, latest);
  }
}
async function atomicOwned(file: string, value: unknown, signal?: AbortSignal): Promise<void> {
  const staged = batchDraft.getStore();
  if (staged?.file === file) { staged.cut = value as StoredCut; return; }
  const cut = isStoredCut(value);
  publicSnapshots.delete(file);
  const jobs = cut ? (value as StoredCut).versions.flatMap(record => { const job = previewJobs.get(record); previewJobs.delete(record); return job ? [[record.version, job] as const] : []; }) : [];
  let logWrite = false;
  // VO7-19: what each new snapshot was built on, so one built on a revision that is no longer current stays hidden.
  const bases = cut ? Object.fromEntries((value as StoredCut).versions.flatMap(record => { const base = record.baseVersion; return base === undefined ? [] : [[record.version, base]]; })) : {};
  if (cut) {
    const source = value as StoredCut, root = path.resolve(path.dirname(file), "../../..");
    const versions: StoredVersion[] = [];
    let slice = performance.now();
    for (const version of source.versions) {
      versions.push(storedView(version));
      if (performance.now() - slice > 8) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now(); }
    }
    const saved = { ...source, versions };
    // ARCH2: a log (or a new edit, which starts as one) is checked against its index; the one-file format keeps its worker check.
    const head = await readLogHead(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    const fresh = !head && !await fs.access(file).then(() => true, () => false);
    logWrite = !!head || fresh;
    const known = new Set(head?.versionLog.index.map(e => e.v) ?? []);
    const added = logWrite ? new Set(saved.versions.filter(v => !known.has(v.version)).map(v => v.version)) : await validateCutWrite(root, saved);
    if (logWrite && known.size && !insideCommit(root, saved.cutId)) for (const v of saved.versions) if (added.has(v.version)) await assertBase(root, saved.cutId, v.baseVersion!);
    const latest = saved.versions.at(-1);  // at(-1) stays: the snapshot this write just appended
    if (latest && added.has(latest.version)) await settleSnapshot(root, saved, latest);
    value = slimCut(saved, await currentIndex(root));
  }
  if (logWrite) {
    const { head } = await writeLoggedCut(file, value as Parameters<typeof writeLoggedCut>[1], contentView as (version: never) => unknown, signal);
    forgetListings(file);
    await noteCutWritten(file, head as unknown as StoredCut);
  } else await writeJsonAtomic(file, value, signal, cut ? undefined : 2);
  revisionText.delete(file);
  if (cut && !logWrite) await noteCutWritten(file, value as StoredCut);  // OPEN1: the shoot list's summary of exactly what was written
  // Every writer reports the same explicit bases to the strict history path.
  const named = cut && path.basename(file) === `${(value as StoredCut).cutId}.json`, cutRoot = path.resolve(path.dirname(file), "../../..");
  if (named) await noteCutWrite(cutRoot, (value as StoredCut).cutId,
    { versions: (value as StoredCut).versions.map(v => v.version), exported: (value as StoredCut).exported, bases });
  const refusals = named ? Object.keys(bases).map(Number).flatMap(v => { const conflict = refusedWrite(cutRoot, (value as StoredCut).cutId, v); return conflict ? [[v, conflict] as const] : []; }) : [];
  for (const [version, job] of jobs) if (!refusals.some(([v]) => v === version)) setImmediate(job);
  // The snapshot is saved, as a hidden revision; the writer hears why it did not apply.
  if (refusals.length) throw Object.assign(new RevisionConflictError(refusals[0][1]), { refusedWrite: true });
  // at(-1) stays: auto layouts complete the snapshot this write just appended.
  if(cut){const saved=value as StoredCut,latest=saved.versions.at(-1);if(latest?.autoLayouts?.enabled)setImmediate(()=>{void import('./auto-layouts').then(m=>m.queueAutoLayouts(path.resolve(path.dirname(file),'../../..'),saved.cutId,latest.version));});}
}
export function changed(root: string, cut?: { cutId: string; version: number }): void {
  if (batchDraft.getStore()) return;
  if (!cut) stepsChanged(root);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try { win.webContents.send("api:sidekick-changed", root, cut); } catch { /* window closed */ }
    }
  }
}
function cutFile(root: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("That edit id is invalid.");
  return path.join(folder(root), "cuts", `${id}.json`);
}
async function currentIndex(root: string): Promise<Shoot | undefined> {
  try { return effectiveShoot(JSON.parse(await fs.readFile(path.join(root, ".sidething/index.json"), "utf8"))); }
  catch { return undefined; }
}
// Repeated UI refreshes need only public decisions. Avoid rehydrating and
// repairing every old assembly while background preparation publishes updates.
const publicSnapshots = new Map<string, { identity: string; cut: Cut }>();
async function cutIdentity(root: string, file: string): Promise<string> {
  // ARCH2: a log's cache overlays change what a listing shows without touching its head.
  return JSON.stringify(await Promise.all([file, path.join(root, '.sidething/index.json'), logPaths(file).cache].map(f =>
    fs.stat(f).then(s => [s.size, s.mtimeMs, s.ctimeMs, s.ino], () => null))));
}
/** ARCH2: listings of a log keep light old versions; anything written to an edit drops what was kept of it. */
const lightListings = new Map<string, { key: string; cut: Cut }>();
function forgetListings(file: string) { publicSnapshots.delete(file); lightListings.delete(file); }
// Versions the page asked for in full (loadCutVersion, a drawn plan): listings keep them full for a while.
const shownVersions = new Map<string, number[]>();
export function noteShownVersion(root: string, cutId: string, version: number): void {
  if (!Number.isInteger(version) || !/^[a-zA-Z0-9_-]+$/.test(cutId)) return;
  const file = cutFile(path.resolve(root), cutId), list = (shownVersions.get(file) ?? []).filter(v => v !== version);
  list.push(version); shownVersions.set(file, list.slice(-12));
  while (shownVersions.size > 64) shownVersions.delete(shownVersions.keys().next().value!);
}
/** The versions a light listing carries in full: the newest snapshots, the undo path around the current revision, and
 * what the page showed recently. Every other version carries the versions menu's fields (`light: true`). */
async function fullVersions(root: string, cutId: string, numbers: number[]): Promise<Set<number>> {
  const known = new Set(numbers), full = new Set(numbers.slice(-3));  // slice(-3): the newest snapshots, by design
  const near = await import("./revisions").then(m => m.nearbyRevisions(root, cutId, 8)).catch(() => [] as number[]);
  for (const v of [...near, ...shownVersions.get(cutFile(root, cutId)) ?? []]) if (known.has(v)) full.add(v);
  return full;
}
// A whole version's public view, kept while what it is built from is unchanged: its saved line (or the one file), its
// cache overlays, the shoot index it hydrates against and the junk review. A listing after a save builds one new version.
const publicVersions = new Map<string, { stamp: string; version: CutVersion }>();
async function publicFull(root: string, cutId: string, version: number): Promise<CutVersion> {
  const file = cutFile(root, cutId), head = await logHead(root, cutId);
  const stamp = JSON.stringify(await Promise.all([head ? logPaths(file, head.versionLog).cache : file, path.join(root, ".sidething/index.json"), path.join(root, ".sidething/junk.json")]
    .map(f => fs.stat(f).then(s => [s.size, s.mtimeMs, s.ctimeMs, s.ino], () => null)))) + (head && head.versionLog.index.some(e => e.v === version)
    ? `|${await fs.stat(logPaths(file, head.versionLog).log).then(s => s.ino, () => 0)}` : "|unindexed");  // a log only grows: its inode changes only when it is replaced
  const key = `${file}|${version}`, hit = publicVersions.get(key);
  if (hit?.stamp === stamp) return hit.version;
  const value = publicVersion(await loadRevision(root, cutId, version, { light: true }));
  publicVersions.delete(key); publicVersions.set(key, { stamp, version: value });
  while (publicVersions.size > 256) publicVersions.delete(publicVersions.keys().next().value!);
  return value;
}
/** One edit for the page: light old versions, full ones where fullVersions says. A one-file edit gets the same shape. */
async function lightCut(root: string, file: string, cutId: string): Promise<Cut> {
  const head = await readLogHead(file);
  const source: Record<string, unknown> & { versions: { version: number }[] } = head ?? JSON.parse(await fs.readFile(file, "utf8"));
  const numbers = head ? head.versionLog.index.map(e => e.v) : source.versions.map(v => v.version);
  const full = await fullVersions(root, cutId, numbers);
  const key = JSON.stringify([await cutIdentity(root, file), [...full].sort((a, b) => a - b)]), hit = lightListings.get(file);
  if (hit?.key === key) return { ...hit.cut };
  const { versionLog: _log, storage: _storage, ...fields } = source as Record<string, unknown>;
  const versions: CutVersion[] = [];
  for (const entry of source.versions as unknown as (Record<string, unknown> & { version: number })[]) {
    if (!full.has(entry.version)) { versions.push((head ? { ...entry } : lightEntry(entry)) as unknown as CutVersion); continue; }
    try { versions.push(await publicFull(root, cutId, entry.version)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ST1_TRASHED_SOURCE") throw error;
      // ST1: one missing shot must not hide this edit; opening its player reports the recovery message.
      const { assembly: _assembly, ...light } = head ? entry : lightEntry(entry);
      versions.push({ ...light, warnings: [...(light.warnings as string[] ?? []), (error as Error).message] } as unknown as CutVersion);
    }
  }
  const cut = { ...fields, versions } as unknown as Cut;
  if (key === JSON.stringify([await cutIdentity(root, file), [...full].sort((a, b) => a - b)])) {
    lightListings.delete(file); lightListings.set(file, { key, cut });
    while (lightListings.size > 32) lightListings.delete(lightListings.keys().next().value!);
  }
  return { ...cut };
}
/** ARCH2 (additive IPC): one saved version in full, for the page when a listing gave it light. */
export async function loadCutVersion(root: string, cutId: string, version: number): Promise<CutVersion> {
  root = path.resolve(root);
  if (typeof cutId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(cutId) || !Number.isInteger(version)) throw new Error("Choose a saved version of this edit.");
  noteShownVersion(root, cutId, version);
  const saved = structuredClone(await publicFull(root, cutId, version)), defaults = (await getPreferences()).look;
  return { ...saved, grade: { ...(saved.grade ?? gradeForLook("rec709", defaults)), matchClips: saved.grade?.matchClips ?? false } };
}
// OPEN1: the snapshot is cloned once, when it is kept (its source is the caller's to mutate). It is handed out
// read-only: listCutsSnapshot copies only the top level it changes, and listCuts gives each caller its own copy.
// Two more whole-history clones per listing (0.5 to 0.7 s each on his edit) are gone.
function rememberPublic(file: string, identity: string, cut: StoredCut): Cut {
  const snapshot = structuredClone(publicCut(cut));
  publicSnapshots.set(file, { identity, cut: snapshot });
  if (publicSnapshots.size > 32) publicSnapshots.delete(publicSnapshots.keys().next().value!);
  return snapshot;
}
async function readCut(root: string, id: string, current?: Shoot): Promise<StoredCut> {
  const file = cutFile(root, id);
  const staged = batchDraft.getStore();
  if (staged?.file === file) return structuredClone(staged.cut);
  // Migration shares the edit queue, so it cannot overwrite a newer version.
  return serial(file, async () => {
    try {
      const identity = current ? undefined : await cutIdentity(root, file);
      const shoot = current ?? await currentIndex(root);
      const cut = await readCutFile(file, shoot), starts = shoot ? new Map<string, number>() : undefined;
      // ARCH2: the app's first open of a one-file edit moves it to the log, verified; the content read here is the same.
      if (ownsOpenShoot(root) && !await readLogHead(file).catch(() => null)) await migrateEdit(path.resolve(root), file, shoot).catch(error => console.warn("[edit history]", error));
      else if (ownsOpenShoot(root)) await retireOld(path.resolve(root), file);
      const versions: StoredVersion[] = [];
      let slice = performance.now();
      for (const version of cut.versions) {
        const projected = legacySoundVersion(await repairVoiceStarts(version, starts));
        if (projected !== version) readViews.set(projected, { stored: version, content: contentKey(projected) });
        versions.push(projected);
        if (performance.now() - slice > 8) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now(); }
      }
      const result = { ...cut, versions };
      if (identity && identity === await cutIdentity(root, file)) rememberPublic(file, identity, result);
      return result;
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = error instanceof Error ? error.message : "Unknown read error";
      throw Object.assign(new Error(code === "ENOENT" && (!(error as NodeJS.ErrnoException).path || path.resolve((error as NodeJS.ErrnoException).path!) === path.resolve(file)) ? `The saved edit file is missing: ${path.basename(file)}. Restore the edit or make a new one.`
        : code === "EACCES" || code === "EPERM" ? `Permission was denied reading the saved edit: ${path.basename(file)}.`
        : `Could not read the saved edit ${path.basename(file)}: ${reason}`, { cause: error }), { code, path: (error as NodeJS.ErrnoException).path });
    }
  });
}

// Old assemblies can predate the take-local words. Repair only partial first
// words in memory; all live, transcript and export readers share this assembly.
export async function repairVoiceStarts(record: StoredVersion, starts?: Map<string, number>): Promise<StoredVersion> {
  const a = record.assembly;
  if (!a) return record;
  const cutList = snapCutStarts(a.shoot, a.cutList, a.template.fps, starts);
  if (cutList === a.cutList) return record;
  const next = { ...record, assembly: { ...a, cutList, reel: { ...a.reel, cuts: a.reel.cuts.map((c, index) => {
    const items = cutPieceGroups(cutList).find(g => g.piece === index)?.items;
    if (!items?.length) return c;
    return { ...c, s: items[0].inFrames / (items[0].clipFpsR.num / items[0].clipFpsR.den),
      offsetS: items[0].offsetFrames / a.template.fps, lengthS: items.reduce((n, item) => n + item.durTimelineFrames / a.template.fps, 0) };
  }) } }, preview: null, finished: null };
  const resolved = resolveReelPieces(a.shoot, a.template, cutList, next.assembly.reel);
  next.pieces = resolved.map((p, index) => ({ ...record.pieces?.[index], ...p,
    ...(p.kind === "voice" && record.pieces?.[index]?.words ? { words: record.pieces[index].words } : {}) }));
  retimeVersion(next, planFx(a.cutList, a.template.fps, record), planFx(cutList, a.template.fps, next));
  if (next.titles) next.titles = await rebuildSubtitles(a.shoot, next, a.template, cutList, true);
  if (next.overlays?.some(o => o.graphic?.words?.length)) next.overlays = await (await import("./graphics/edit")).retimeGraphicOverlays(next);  // GFX1: graphics stay on their words
  return next;
}
/** Renaming is metadata only, serialized with cut edits; immutable versions retain their titles. */
export async function renameCut(root: string, cutId: string, title: string): Promise<void> {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 240 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error("Use a title between 1 and 240 characters.");
  root = path.resolve(root);
  await serial(cutFile(root, cutId), async () => {
    const cut = await readCut(root, cutId);
    await atomic(cutFile(root, cutId), { ...cut, title: title.trim() });
    changed(root);
  });
}

/** BUG1: the cut the model reads holds only the version on screen. A long-lived edit keeps hundreds of
 * snapshots (a real edit's: 569 versions, 29.8 MB of JSON), which pushed every typed note in the
 * cut chat past the prompt budget before the model could read it. */
function promptCut(cut: StoredCut, version?: number): Cut {
  const shown = publicCut(cut);
  const on = shown.versions.find(v => v.version === version) ?? shown.versions.at(-1);  // at(-1): no version on screen named
  return { ...shown, versions: on ? [on] : [] };
}
function publicCut(cut: StoredCut): Cut {
  return { ...cut, versions: cut.versions.map(publicVersion) };
}
function publicVersion({ assembly, ...version }: StoredVersion): CutVersion {
  return {
    ...version,
    ...(assembly ? {
      pieces: timedPieces(assembly, version.pieces),
      music: version.music && assembly.reel.music ? { ...version.music, gainDb: assembly.reel.music.gainDb } : version.music,
    } : {}),
  };
}

// LxAy ids can move after regrouping. A saved piece's clip and span are its
// identity; never use today's same-numbered attempt on a different source.
function pieceSegment(assembly: StoredVersion["assembly"], index: number): Segment | undefined {
  const seg = cutPieceGroups(assembly.cutList)[index]?.items[0]?.seg;
  if (!seg) return;
  const takeId = /^L(\d+)A(\d+):/.exec(seg.marker);
  const attempt = takeId ? assembly.shoot.takes.find(t => t.lineIndex === Number(takeId[1]) - 1)?.attempts[Number(takeId[2]) - 1] : undefined;
  const matches = attempt?.clipId === seg.clip.id && seg.s >= attempt.s - .75 && seg.e <= attempt.e + .75;
  return matches || !takeId ? seg : { ...seg, marker: seg.marker.replace(/^L\d+A\d+:\s*/, "") };
}
function pieceWords(assembly: StoredVersion["assembly"], index: number): Word[] {
  const seg = pieceSegment(assembly, index);
  if (!seg || seg.lineIndex === null) return [];
  // The verbatim pass may already have words before speech-edge measurements
  // are available. Keep the same source/span checks as the saved piece.
  const cache = (assembly.shoot as Shoot & { _cache?: { fillerAttempts?: Record<string, {
    key: { clipId: string; s: number; e: number; audio: { source: string; offsetS: number; durationS: number } }; words?: Word[];
  }> } })._cache;
  const local = Object.values(cache?.fillerAttempts ?? {}).filter(({ key, words }) => words?.length &&
    key.clipId === seg.clip.id && key.s <= seg.s + .75 && key.e >= seg.e - .75 && key.s < seg.e && key.e > seg.s &&
    key.audio.source.endsWith(path.sep + (seg.clip.sound?.file ?? seg.clip.file)) &&
    key.audio.offsetS === (seg.clip.sound?.offsetS ?? 0) && key.audio.durationS === seg.clip.meta?.durationS)
    .sort((a, b) => Math.abs(a.key.s - seg.s) + Math.abs(a.key.e - seg.e)
      - Math.abs(b.key.s - seg.s) - Math.abs(b.key.e - seg.e))[0];
  return sourceWords(assembly.shoot, local ? { ...seg, speechWords: local.words } : seg);
}
function timedPieces(assembly: StoredVersion["assembly"], pieces?: CutVersion["pieces"]) {
  return (pieces ?? resolveReelPieces(assembly.shoot, assembly.template, assembly.cutList, assembly.reel))
    .map((piece, index) => ({ ...piece, timedWords: pieceWords(assembly, index) }));
}

// Retain the old envelope validator, then read the quiet composer's fields.
// B-roll-led pieces use the same catalog as assembly, without changing its ids.
type ParsedReply = Omit<ReturnType<typeof parseSidekick>, "reply"> & {
  canMake?: string;  // VT1
  reply: Omit<ReturnType<typeof parseSidekick>["reply"], "cut"> & {
    cut: (NonNullable<ReturnType<typeof parseSidekick>["reply"]["cut"]> & { targetS?: number; skills?: string[]; ideaId?: string; keptBeatIds?: string[]; finish?: unknown; type?: VideoType }) | null;
  };
};
export function parseReply(raw: string, shoot: Shoot): ParsedReply {
  let value: { cut?: { voice?: unknown; targetS?: unknown; skills?: unknown; ideaId?: unknown; keptBeatIds?: unknown; finish?: unknown; type?: unknown }; ideas?: { pick?: unknown; type?: unknown }[]; canMake?: unknown } | null;
  try { value = JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw.trim()); }
  catch { return parseSidekick(raw, shoot); }
  const ids = value?.cut?.voice;
  const { broll } = reelIds(shoot);
  let parsed: ParsedReply;
  if (Array.isArray(ids) && ids.every((id): id is string => typeof id === "string") && ids.some((id) => broll.has(id))) {
    parsed = parseSidekick(JSON.stringify({ ...value, cut: { ...value!.cut, voice: ids.filter((id) => !broll.has(id)) } }), shoot);
    if (parsed.reply.cut) {
      const validTakes = new Set(parsed.reply.cut.voice.map((v) => v.id));
      parsed.reply.cut.voice = ids.filter((id) => broll.has(id) || validTakes.has(id)).map((id) => ({ id }));
    }
  } else parsed = parseSidekick(raw, shoot);
  if (parsed.reply.cut && value?.cut) {
    if (Array.isArray(value.cut.keptBeatIds)) parsed.reply.cut.keptBeatIds = value.cut.keptBeatIds.filter((id): id is string => typeof id === "string");
    // Finish validation is forgiving and happens against the assembled pieces.
    if (value.cut.finish !== undefined) parsed.reply.cut.finish = value.cut.finish;
    const { targetS, skills } = value.cut;
    if (value.cut.ideaId !== undefined && value.cut.ideaId !== null) {
      if (typeof value.cut.ideaId !== "string") throw new ReplyShapeError("cut.ideaId must be an existing idea id.");
      parsed.reply.cut.ideaId = value.cut.ideaId;
    }
    if (targetS !== undefined) {
      if (typeof targetS !== "number" || !Number.isFinite(targetS) || targetS <= 0) throw new ReplyShapeError("cut.targetS must be positive seconds.");
      parsed.reply.cut.targetS = targetS;
    }
    if (skills !== undefined) {
      if (!Array.isArray(skills) || !skills.every((id): id is string => typeof id === "string")) throw new ReplyShapeError("cut.skills must be skill ids.");
      parsed.reply.cut.skills = skills;
    }
    // VT1: an unknown type is dropped, never guessed.
    if (isVideoType(value.cut.type)) parsed.reply.cut.type = value.cut.type;
  }
  parsed.reply.ideas?.forEach((idea, index) => {
    const pick = value?.ideas?.[index]?.pick;
    if (pick !== undefined && typeof pick !== "boolean") throw new ReplyShapeError("ideas.pick must be a boolean.");
    if (typeof pick === "boolean") idea.pick = pick;
    const type = value?.ideas?.[index]?.type;
    if (isVideoType(type)) idea.type = type;
  });
  if (typeof value?.canMake === "string" && value.canMake.trim()) parsed.canMake = value.canMake.trim().replace(/\s+/g, " ").slice(0, 240);
  return parsed;
}
export function sidekickThread(root: string): Promise<SidekickMessage[]> {
  const key = path.resolve(root);
  // Atomic saves let Ideas show completed results while a later call is still
  // drafting. Leave legacy backfill writes to the next locked transaction.
  if (queues.has(key) && !activeQueue.getStore()?.has(key)) return readThread(root, false);
  return serial(root, () => readThread(root));
}
async function readThread(root: string, persist = true): Promise<SidekickMessage[]> {
  try {
    const thread: unknown = JSON.parse(await fs.readFile(path.join(folder(root), "thread.json"), "utf8"));
    if (!Array.isArray(thread)) throw new Error("Invalid thread");
    const messages = (thread as SidekickMessage[]).map((message) => ({ ...message,
      ...(message.ideas ? { ideas: message.ideas.map((idea, index) => ({ ...idea, id: idea.id ?? `${message.id}:${index}` })) } : {}),
    }));
    const ideas = new Map(messages.flatMap(m => m.ideas ?? []).map(idea => [idea.id, idea]));
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role !== "sidekick" || !message.cut) continue;
      const user = messages[index - 1];
      const ideaId = message.ideaId ?? (user?.role === "user" ? user.ideaId : undefined);
      const idea = ideaId ? ideas.get(ideaId) : undefined;
      if (idea && !idea.cutId) idea.cutId = message.cut.cutId;
      // Older records sometimes kept the produced cut alongside a single idea.
      if (!ideaId && message.ideas?.length === 1 && !message.ideas[0].cutId) message.ideas[0].cutId = message.cut.cutId;
    }
    if (persist && JSON.stringify(messages) !== JSON.stringify(thread)) await saveThread(root, messages);
    return messages;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Could not read the precut conversation. Your saved thread has been kept.");
  }
}
async function saveThread(root: string, thread: SidekickMessage[]): Promise<void> {
  await atomic(path.join(folder(root), "thread.json"), thread);
  changed(root);
}
// Legacy MCP/CLI focus remains readable; each new non-empty input is a request.
export async function getShootFocus(root: string): Promise<string> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(path.resolve(root), ".sidething/focus.json"), "utf8"));
    return typeof value === "string" ? value : "";
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
export function setShootFocus(root: string, focus: string): Promise<{ appliesTo: "now" | "next" }> {
  root = path.resolve(root);
  if (typeof focus !== "string" || focus.length > 10_000) return Promise.reject(new Error("Keep the shoot focus under 10,000 characters."));
  return (async () => {
    let hasIdeas = false;
    try {
      const thread: SidekickMessage[] = JSON.parse(await fs.readFile(path.join(root, ".sidething/sidekick/thread.json"), "utf8"));
      hasIdeas = thread.some(m => m.ideas?.length);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (focus.trim()) await addRequest(root, focus);
    await atomic(path.join(root, ".sidething/focus.json"), focus.trim());
    changed(root);
    return { appliesTo: hasIdeas ? "next" as const : "now" as const };
  })();
}

// Both import automation and stage retries use the normal conversation/cut
// transaction. Model picks and missing footage determine what can be drafted.
const autopilots = new Map<string, Promise<void>>();
const ideasOnlyAutopilots = new WeakSet<Promise<void>>();
// A progress notification can originate inside a chat transaction. Background
// work must leave its async-local lock context before joining the shoot queue.
export function queueAutopilot(root: string): Promise<void> {
  return activeQueue.exit(async () => {
    await continueAutopilot(root);
    // A click can arrive after the current run's last drain, before it settles.
    await processRequests(root);
  });
}
export function continueAutopilot(root: string, start: "ideas" | "drafts" = "ideas", opts: { early?: boolean; ideasOnly?: boolean } = {}): Promise<void> {
  root = path.resolve(root);
  const existing = autopilots.get(root);
  // PF1b: joining an ideas-only run must not swallow a request for first edits; wait, then draft.
  if (existing && ideasOnlyAutopilots.has(existing) && !opts.ideasOnly) return existing.catch(() => {}).then(() => continueAutopilot(root, start, opts));
  if (existing) return existing;
  const work = Promise.resolve().then(async () => {
    const settings = await getAutopilot(root);
    const requests = await listRequests(root); // Migrate focus before the first automatic ideas arrive.
    const paused = settings.stopAt.includes("clips") || settings.stopAt.includes("folder");
    const shoot = JSON.parse(await fs.readFile(path.join(root, ".sidething/index.json"), "utf8")) as Shoot;
    if (!shoot.clips.some(c => c.stage !== "error")) {
      for (const id of ["ideas", "drafts"] as const) reportStage(root, id, "skipped", "No clips could be read.");
      return;
    }
    if (paused) {
      for (const id of ["ideas", "drafts"] as const) reportStage(root, id, "skipped", "Paused in your settings.");
    }
    let thread = await sidekickThread(root);
    if (start === "ideas" && !paused && !requests.some(r => !r.fromIdea) && !thread.some(m => m.ideas !== undefined && !("requestId" in m) && m.ideas.every(i => !i.requestId))) {
      const reply = await sidekickSend(root, "Find video ideas grounded in this shoot. Mark the strongest feasible ideas with pick: true.", { addIdeas: true, ...(opts.early ? { early: true } : {}) });
      if (reply.error) throw new Error(reply.error);
    }
    await processRequests(root);
    if (paused) return;
    if (settings.stopAt.includes("ideas")) { reportStage(root, "drafts", "skipped", "Paused at ideas."); return; }
    if (opts.ideasOnly) return;
    thread = await sidekickThread(root);
    // A person's brief owns the first edit. processRequests chooses from that
    // reply; a previously saved board must never compete with it afterwards.
    if ((await listRequests(root)).some(r => !r.fromIdea)) return;
    const orderedIdeas = new Map(thread.flatMap(m => (m.ideas ?? []).map((idea, index) =>
      [idea.id ?? `${m.id}:${index}`, { idea, index, messageId: m.id }] as const)));
    const candidates = [...orderedIdeas.values()]
      // `pick` is the model's judgement that the idea can be cut now; `missing` lists shots that would make it
      // better and become placeholders in the cut, so it never blocks a first edit on its own.
      .filter(({ idea }) => !idea.requestId && idea.pick && !idea.passed).slice(0, settings.cutCount)
      .filter(({ idea }) => !idea.cutId);
    if (!candidates.length) reportStage(root, "drafts", "skipped");
    for (const { idea, messageId, index } of candidates) {
      const reply = await sidekickSend(root, `Draft this idea: ${idea.title}`, { fromIdea: { messageId, index }, ...(opts.early ? { early: true } : {}) });
      if (reply.error) throw new Error(reply.error);
      await processRequests(root);
    }
  });
  autopilots.set(root, work);
  if (opts.ideasOnly) ideasOnlyAutopilots.add(work);
  void work.finally(() => { if (autopilots.get(root) === work) autopilots.delete(root); }).catch(() => {});
  return work;
}

export async function retryGeneration(root: string, stage: "ideas" | "drafts"): Promise<void> {
  let last: { step?: string; text?: string; context?: SidekickContext } | null = null;
  try { last = JSON.parse(await fs.readFile(path.join(root, ".sidething/sidekick/last-call.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (last?.step === (stage === "ideas" ? "ideas" : "precut") && last.text && last.context) {
    const reply = await sidekickSend(root, last.text, last.context);
    if (reply.error) throw new Error(reply.error);
    if (stage === "drafts" && !reply.cut) throw new Error("This request did not create an edit. Open the idea to review what footage it needs.");
  } else if (stage === "ideas") {
    const reply = await sidekickSend(root, "Find more video ideas grounded in this footage.", { addIdeas: true });
    if (reply.error) throw new Error(reply.error);
  } else throw new Error("No draft request is saved to retry. Open an idea and create its edit first.");
}

// PF1: performance checks finished and moved the takes. Early ideas are reworked in
// place (their own history keeps the first wording) and each early edit gets a new
// version; nothing is replaced, so what the person is looking at stays valid.
export async function refreshAfterJudging(root: string): Promise<void> {
  root = path.resolve(root);
  const settings = await getAutopilot(root);
  const thread = await sidekickThread(root);
  const ideas = thread.filter(m => m.early).flatMap(m => m.ideas ?? [])
    .filter(idea => idea.id && !idea.requestId && idea.pick && !idea.passed).slice(0, settings.cutCount);
  for (const idea of ideas) {
    const reply = await sidekickSend(root, "Performance checks are finished and the strongest takes may have changed. Revise this idea only where they did; keep it as it is otherwise.", { ideaId: idea.id, afterJudging: true });
    if (reply.error) throw new Error(reply.error);
  }
  const cutIds = [...new Set(thread.filter(m => m.early && m.cut).map(m => m.cut!.cutId))].slice(0, settings.cutCount);
  for (const cutId of cutIds) {
    const reply = await sidekickSend(root, "Performance checks are finished and the strongest takes may have changed. Make a new version with the strongest takes; keep the story.", { cutId, afterJudging: true });
    if (reply.error) throw new Error(reply.error);
    if (reply.cut) improveInBackground(root, reply.cut);  // MB1: an early draft's first real cut
  }
}
// MB1: every first cut is watched and improved once, in the background, outside any caller's lock.
function improveInBackground(root: string, cut: { cutId: string; version: number }): void {
  void activeQueue.exit(() => independentPreparation(() => import("./critique").then(m => m.improveFirstCut(root, cut.cutId, cut.version)))).catch(() => {});
}

async function promptTemplate(): Promise<string> {
  const candidates = [path.join(process.cwd(), "prompts/sidekick.md"), path.join(app.getAppPath(), "prompts/sidekick.md"),
    path.join(process.resourcesPath ?? "", "prompts/sidekick.md")];
  for (const file of candidates) { try { return await fs.readFile(file, "utf8"); } catch { /* next */ } }
  throw new Error("Could not find precut's instructions. Reinstall precut.");
}
// BUG2: failures from deeper code whose own words carry ids, in the words the person can act on.
const PLAIN_FAILURES: [prefix: string, plain: string][] = [
  ["No non-overlapping span for ", "Two takes in this clip overlap, so precut couldn't place one of them."],  // export.ts buildCutList
];
function plainError(error: unknown): string {
  if (error instanceof ReplyShapeError) return "precut could not format its answer after two tries. Please try again.";
  const message = error instanceof Error ? error.message : "";
  console.error("[sidekick]", error);  // the person sees a plain line; the cause stays in the log
  const known = PLAIN_FAILURES.find(([prefix]) => message.startsWith(prefix));
  if (known) return known[1];
  // ONB2: every engine's own words pass through plainly (Codex was missing, so its errors became the generic line).
  if (/Claude Code|Codex|Muse|No AI chosen|timed out|unavailable|Could not|could not|couldn't finish|returned no answer|too large|Template|known footage|positive|empty/i.test(message) && message.length < 400) return message;
  return "precut could not finish this request. Check the shoot drive and your AI engine, then try again.";
}

/** V62/BUG1: one ask-first Make it better turn, whether the offer row, Cmd+Shift+B or the model's route for typed words opened it. */
async function proposeInChat(root: string, cutId: string, version: number, message: SidekickMessage): Promise<void> {
  const proposal = await (await import("./critique")).proposeBetter(root, cutId, version);
  message.better = proposal;
  message.text = proposal.issues.length
    ? "Here's what I'd change. Nothing changes until you press Apply."
    : "It already holds up.";
}
async function betterReply(root: string, text: string, ctx: SidekickContext): Promise<SidekickMessage> {
  const thread = await sidekickThread(root);
  const user: SidekickMessage = { id: randomUUID(), role: "user", text: text.trim(), at: new Date().toISOString() };
  await saveThread(root, [...thread, user]);
  const message: SidekickMessage = { id: randomUUID(), role: "sidekick", text: "", at: new Date().toISOString() };
  try {
    if (!ctx.cutId) { message.text = "Open an edit, then ask me to make it better."; }
    else {
      const cut = await readCut(root, ctx.cutId), on = await currentVersion(root, ctx.cutId);
      const latest = cut.versions.find(v => v.version === on);  // VO7-2: the current revision
      if (!latest) throw new Error("Could not find that edit version.");
      await proposeInChat(root, ctx.cutId, latest.version, message);
    }
  } catch (error) {
    message.error = plainError(error);
    message.text = message.error;
  }
  message.at = new Date().toISOString();
  await saveThread(root, [...thread, user, message]);
  return message;
}

// WR3: `afterJudging` marks the refresh once performance checks finish; like an ideas turn, it may raise questions.
export function sidekickSend(root: string, text: string, ctx: SidekickContext & { requestId?: string; afterJudging?: boolean; supersedeIdeas?: boolean } = {}): Promise<SidekickMessage> {
  root = path.resolve(root);
  // V62: the Make it better offer and its shortcut propose first and never make a version.
  if (ctx.better) return serialWithCut(root, ctx.cutId, () => betterReply(root, text, ctx));
  const stage = ctx.cutId || ctx.fromIdea || ctx.templateId ? "drafts" : "ideas";
  let firstCut: { cutId: string; version: number } | null = null;  // MB1
  return serialWithCut(root, ctx.cutId, () => runActivity({ kind: ctx.cutId || ctx.fromIdea || ctx.templateId ? "cut" : "ideas", root,
    cancelable: true,
    target: ctx.cutId ? { cutId: ctx.cutId } : ctx.ideaId ? { ideaId: ctx.ideaId } : null,
    label: ctx.cutId || ctx.fromIdea || ctx.templateId ? "Creating your edit" : "Finding ideas" }, async activity => {
    reportStage(root, stage, "running");
    const thread = await sidekickThread(root);
    const linkedIdea = ctx.fromIdea ? thread.find(m => m.id === ctx.fromIdea!.messageId)?.ideas?.[ctx.fromIdea.index] : undefined;
    // Stable identity also covers a crash after the cut was saved but before
    // its thread link or request completion could be written.
    const ideaCutId = linkedIdea ? `idea-${createHash("sha256").update(linkedIdea.id ?? `${ctx.fromIdea!.messageId}:${ctx.fromIdea!.index}`).digest("hex").slice(0, 32)}` : undefined;
    const existingCutId = linkedIdea?.cutId ?? (ideaCutId && await fs.access(cutFile(root, ideaCutId)).then(() => ideaCutId, () => undefined));
    if (existingCutId) {
      const saved = await readCut(root, existingCutId), on = await currentVersion(root, existingCutId).catch(() => undefined);
      const latest = saved.versions.find(v => v.version === on);  // VO7-2: the current revision
      if (latest) {
        if (linkedIdea && !linkedIdea.cutId) { linkedIdea.cutId = saved.cutId; await saveThread(root, thread); changed(root); }
        const reply: SidekickMessage = { id: randomUUID(), role: "sidekick", text: "Edit ready", at: new Date().toISOString(), cut: { cutId: saved.cutId, version: latest.version } };
        reportStage(root, stage, "done");
        return reply;
      }
    }
    const originId = ctx.ideaId ?? (ctx.fromIdea ? thread.find(m => m.id === ctx.fromIdea!.messageId)?.ideas?.[ctx.fromIdea.index]?.id : undefined);
    const user: SidekickMessage = { id: randomUUID(), role: "user", text: text.trim(), at: new Date().toISOString(),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}), ...(originId ? { ideaId: originId } : {}) };
    await saveThread(root, [...thread, user]);
    const message: SidekickMessage = { id: randomUUID(), role: "sidekick", text: "", at: new Date().toISOString(),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}), ...(originId ? { ideaId: originId } : {}), ...(ctx.early ? { early: true } : {}) };
    try {
      if (!user.text) throw new Error("Your message is empty. Ask about the shoot or describe an edit first.");
      const idea = ctx.ideaId ? thread.flatMap((turn) => turn.ideas ?? []).find((idea) => idea.id === ctx.ideaId) : undefined;
      if (ctx.ideaId && !idea) throw new Error("Could not find that idea. Open the latest ideas and try again.");
      if (idea) activity.update({ label: `Reworking ${idea.title}` });
      let shoot: Shoot;
      try { shoot = effectiveShoot(JSON.parse(await fs.readFile(path.join(root, ".sidething/index.json"), "utf8"))); }
      catch { throw new Error("Could not read this shoot. Check the drive is connected and try again."); }
      const contextShoot = { ...shoot, root };
      shoot = { ...shoot, clips: shoot.clips.filter(c => c.stage !== "error" && !c.leftOut) };
      const editing = ctx.cutId ? await readCut(root, ctx.cutId) : null;
      const previousRef = [...thread].reverse().find((m) => m.cut)?.cut;
      const reference = editing ?? (previousRef ? await readCut(root, previousRef.cutId) : null);
      // VO7-2: a re-cut builds on the current revision, the one on screen, never simply the newest.
      const onScreen = editing ? await currentVersion(root, editing.cutId) : undefined;
      const last = editing?.versions.find(v => v.version === onScreen);
      if (last) activity.update({ label: `Creating ${last.title}`, target: { cutId: editing!.cutId, version: last.version } });
      const sourceIdea = ctx.fromIdea ? thread.find((m) => m.id === ctx.fromIdea!.messageId)?.ideas?.[ctx.fromIdea.index] : undefined;
      if (ctx.fromIdea && (!Number.isInteger(ctx.fromIdea.index) || !sourceIdea)) throw new Error("Could not find that idea. Open the latest ideas and try again.");
      if (sourceIdea) activity.update({ label: `Cutting ${sourceIdea.title}`, target: { ideaId: sourceIdea.id } });
      if (sourceIdea?.id) user.ideaId = message.ideaId = sourceIdea.id;
      const skills = (await listSkills()).sort((a, b) => Number(b.global) - Number(a.global));
      const knownSkills = new Set(skills.map((s) => s.id));
      let skillIds = (editing?.skillIds ?? ctx.skillIds ?? []).filter((id) => knownSkills.has(id));
      let lengthS = ctx.lengthS ?? editing?.targetLengthS ?? sourceIdea?.lengthS ?? 30;
      if (!Number.isFinite(lengthS) || lengthS <= 0) throw new Error("Choose a positive target length in seconds.");
      const templateId = ctx.templateId ?? last?.templateId ?? "reel-9-16";
      const fallback = last?.assembly.template ?? (await listTemplates()).find((t) => t.id === templateId || t.name === templateId);
      if (!fallback) throw new Error(`Template not found: ${templateId}`);
      const defaults = await getPreferences();
      const catalog = await reelCatalog();
      const candidates = typeof ctx.musicFile === "string" ? catalog.tracks.filter((t) => t.file === ctx.musicFile) : catalog.tracks.slice(0, 12);
      if (typeof ctx.musicFile === "string" && !candidates.length) throw new Error("That track is unavailable in your music folder. Choose another track.");
      const brief = ctx.requestId ? [] : await requestBrief(root);
      // VT1: what the footage measures as (kinds, recorded times, places) and the type's editing logic.
      let day: DayFacts | null = null;
      try { day = await dayFacts(root, shoot); } catch (error) { console.warn("[sidekick] Could not read recorded times:", error); }
      const footage = day ? footageProfile(shoot, day) : null;
      const askedType = isVideoType(ctx.videoType) ? ctx.videoType : undefined;
      const hasTalking = shoot.clips.some(c => (c.byHand?.kind ?? c.judgement?.kind) === "talking" || (c.transcript?.some(s => s.text.trim()) ?? false)) || shoot.takes.length > 0;
      const voiceoverQuestion = (await listQuestions(root).catch(() => [])).find(q => q.text.toLowerCase().replace(/[?.!]+$/, "") === "will you add a voiceover");
      const voiceoverWanted = !hasTalking && (voiceoverQuestion?.answer?.length ? voiceoverQuestion.answer : voiceoverQuestion?.guess)?.some(a => a.toLowerCase() === "yes");
      const priorType = askedType ?? (voiceoverWanted ? "voiceover" : undefined) ?? sourceIdea?.type ?? last?.videoType;
      const ideasTurn = !!(ctx.addIdeas || ctx.ideaId);
      const typeRequest = { footage, videoTypes: TYPE_LOGIC,
        ...(ideasTurn ? {} : { videoType: priorType ? { type: priorType, logic: TYPE_LOGIC[priorType], ...(askedType && askedType !== last?.videoType ? { asked: true } : {}) } : null }),
        ...(day && footage?.recorded && (priorType === "vlog" || (!priorType && (footage.recorded.scenes >= 2 || footage.recorded.hours >= 1))) ? { day: dayOrder(shoot, day) } : {}) };
      const template = await promptTemplate();
      // WR3: the brief, the questions already asked and where they usually post go to every call.
      const mayAsk = !!(ctx.addIdeas || ctx.afterJudging);
      const shootBrief = await Promise.all([getBrief(root), listQuestions(root), folderHints(root)]).then(([b, q, folders]) => shootBriefContext(b, q, defaults.output.posts, folders)).catch((error) => { console.warn("[sidekick] Could not read the shoot's brief:", error); return null; });
      const engine = await getEngine();
      const libraryTools = engine !== "muse";
      const finishing = ctx.addIdeas ? null : await finishCatalog(root, shoot, candidates);
      const prompt = buildSidekickContext(`${template.includes(VIDEO_TYPE_PROMPT_MARKER) ? template : `${template}\n${VIDEO_TYPE_PROMPT}`}\nWhen making a new cut from a board idea, include cut.ideaId with that idea's exact stable id. Omit it for an unrelated new cut.`, contextShoot,
        skills.map((s) => ({ id: s.id, name: s.name, description: s.description, global: s.global, type: s.type ?? "video", format: s.format ?? null, markdown: s.body })),
        candidates, reference ? promptCut(reference, editing ? last?.version : previousRef?.version) : null, thread,
        { text: user.text, targetLengthS: ctx.lengthS ?? editing?.targetLengthS ?? sourceIdea?.lengthS ?? null,
          template: skillTemplate(skills, skillIds, shoot, fallback, editing ? undefined : defaults.output.fps), skillIds, fromIdea: sourceIdea ?? null,
          keptBeats: editing && last ? await keptBeatsFor(root, editing, last.version) : [],
          keptBeatInstruction: "Keep the chosen idea's hook picture, ending and named shots. Include cut.keptBeatIds with footage ids explicitly promised by the idea, brief or person. Opening stays opening and ending stays ending. Trim or swap takes of the same shot. A person's explicit removal or move wins. Voiceover lines follow their picture beat.",
          musicMode: typeof ctx.musicFile === "string" ? "fixed track" : ctx.musicFile === null ? "pick for me" : "decide from the words and skills; keep current music when revising unless asked otherwise",
          revisingCutId: ctx.cutId ?? null, addIdeas: ctx.addIdeas ?? false, ideaId: ctx.ideaId ?? null, ...(mayAsk ? { mayAsk: true, mayAskVoiceover: !hasTalking } : {}),
          currentIdea: idea ?? null,
          ...(ctx.requestId ? { requestInstruction: ctx.addIdeas
            ? "Make ideas for this request in addition to the automatic suggestions. Judge their number and shape. Order them strongest first and mark the strongest feasible choice with pick: true. Name any missing footage honestly. If none can be cut, explain why in text in plain words."
            : "Draft the saved request idea using the available footage. If it cannot be cut, return cut: null and explain why in text in plain words. Do not substitute unrelated footage or invent an edit." } : {}),
          // Keep choices and music at hand; footage measurements and caption
          // word indices come from get_clip rather than a second shoot dump.
          ...(finishing ? { finishCatalog: libraryTools ? { sfx: finishing.sfx, choices: finishing.choices, music: finishing.music,
            coverAtS: finishing.coverAtS, angles: finishing.angles } : finishing } : {}),
          ...typeRequest,
          ...(brief.length ? { editorialBrief: brief } : {}),
          focusInstruction: "The current explicit request takes priority. Earlier requests are separate work, not a direction that replaces this shoot's automatic suggestions." + (brief.length ? " editorialBrief is what the person told precut they are making: let it shape the ideas and edits you have not made yet." : "") }, 300_000, shootBrief, libraryTools);
      // Ideas and drafts query the same library as Ask. Ideas can also read references.
      const extraReadOnlyTools = ctx.cutId || ctx.fromIdea || ctx.templateId ? undefined : SIDEKICK_READ_ONLY_TOOLS;
      let raw = await (ctx.addIdeas ? measureModelWork("ideas", shoot.clips.length, () => runModel({ engine, prompt, images: [], cwd: root, extraReadOnlyTools, libraryTools })) : runModel({ engine, prompt, images: [], cwd: root, extraReadOnlyTools, libraryTools }));
      const validate = (raw: string): ParsedReply => {
        const parsed = parseReply(raw, shoot);
        if (parsed.reply.cut?.ideaId && !thread.some(m => m.ideas?.some(i => i.id === parsed.reply.cut!.ideaId))) {
          throw new ReplyShapeError("cut.ideaId must name an existing board idea by its exact id.");
        }
        if ((ctx.addIdeas || ctx.ideaId) && parsed.reply.cut) throw new ReplyShapeError("An idea conversation cannot render a cut. Return cut: null.");
        if (parsed.reply.titles && (!editing || ctx.addIdeas || ctx.ideaId)) throw new ReplyShapeError("Titles need a current cut conversation. Return titles: null.");
        if (ctx.ideaId && (parsed.reply.ideas?.length ?? 0) > 1) throw new ReplyShapeError("Rework only currentIdea, or return ideas: null for an answer without a change.");
        if (parsed.reply.better && (!editing || ctx.addIdeas || ctx.ideaId)) throw new ReplyShapeError("Make it better needs a current cut conversation. Return better: null.");
        return parsed;
      };
      let parsed: ParsedReply;
      try { parsed = validate(raw); }
      catch (error) {
        if (!(error instanceof ReplyShapeError)) throw error;
        raw = await runModel({ engine, images: [], cwd: root, extraReadOnlyTools, libraryTools,
          prompt: `${prompt}\nYour previous answer failed JSON shape validation: ${error.message}\nReturn a corrected JSON object only. Previous answer (may be truncated):\n${raw.slice(0, 3500)}` });
        parsed = validate(raw);
      }
      const { reply, warnings } = parsed;
      if (parsed.dropped.length) console.warn("[sidekick] Dropped questions:", parsed.dropped.join(" "));
      // WR3: questions never hold anything back; the work in this reply already follows each guess.
      if (mayAsk) for (const question of reply.questions) {
        if (hasTalking && /voice[ -]?over/i.test(question.text)) continue;
        await addQuestion(root, question).catch((error) => console.warn("[sidekick] Could not save a question:", error));
      } else if (reply.questions.length) console.warn("[sidekick] Ignored questions outside an ideas turn.");
      const cutIdea = sourceIdea ?? (!editing && reply.cut?.ideaId
        ? thread.flatMap(m => m.ideas ?? []).find(i => i.id === reply.cut!.ideaId) : undefined);
      if (cutIdea?.id) user.ideaId = message.ideaId = cutIdea.id;
      message.text = reply.text;
      message.clips = reply.clips;
      message.missing = reply.missing;
      if (idea && reply.ideas?.length) {
        const { id, earlier, cutId, pick, passed, ...wording } = idea;
        const revision = reply.ideas[0];
        // Only editorial fields come from the model. Identity and user choices
        // survive even when the model omits them or tries to replace them.
        Object.assign(idea, { title: revision.title, concept: revision.concept, hook: revision.hook,
          lengthS: revision.lengthS, uses: revision.uses, missing: revision.missing,
          ...(revision.type ?? idea.type ? { type: revision.type ?? idea.type } : {}),
          id, cutId, pick, passed, earlier: [...(earlier ?? []), { ...wording, pick, passed }] });
      } else if (!idea && reply.ideas) {
        if (ctx.supersedeIdeas) for (const turn of thread) for (const old of turn.ideas ?? []) { old.passed = true; old.pick = false; }
        message.ideas = reply.ideas.map((idea, index): ReelIdea => ({ ...idea, id: `${message.id}:${index}`,
          ...((ctx.requestId ?? sourceIdea?.requestId) ? { requestId: ctx.requestId ?? sourceIdea?.requestId } : {}) }));
        if (ctx.addIdeas && parsed.canMake) message.canMake = parsed.canMake;
        if (message.ideas[0]?.id) activity.update({ target: { ideaId: message.ideas[0].id } });
      }
      if (warnings.length) message.text += ` ${warnings.join(" ")}`;
      activity.progress(null, "Preparing your result");
      if (reply.better && editing && last) {
        // BUG1: the model read these words as asking for the edit to be improved; they land in the
        // same ask-first flow as the offer row and Cmd+Shift+B. Nothing changes until Apply.
        activity.update({ kind: "finish", label: "Checking this edit", target: { cutId: editing.cutId, version: last.version } });
        message.clips = []; message.missing = [];
        await proposeInChat(root, editing.cutId, last.version, message);
      } else if (reply.titles && editing && last) {
        activity.update({ kind: "titles", label: "Adding titles" });
        message.cut = await designTitles(root, editing.cutId, last.version, reply.titles);
      } else if (reply.cut) {
        lengthS = ctx.lengthS ?? (editing ? reply.cut.targetS ?? editing.targetLengthS : cutIdea?.lengthS ?? reply.cut.targetS) ?? lengthS;
        if (reply.cut.skills !== undefined) {
          skillIds = [...new Set(reply.cut.skills.filter((id) => knownSkills.has(id)))];
          for (const id of reply.cut.skills) if (!knownSkills.has(id)) warnings.push(`Dropped unknown skill ${id}.`);
        }
        const template = skillTemplate(skills, skillIds, shoot, fallback, editing ? undefined : defaults.output.fps);
        if (template.id !== fallback.id) await saveTemplate(template);
        const cut: StoredCut = editing ?? { cutId: ideaCutId ?? randomUUID(), concept: reply.cut.concept, skillIds, targetLengthS: lengthS, versions: [], exported: [] };
        const version = (cut.versions.at(-1)?.version ?? 0) + 1;  // at(-1) stays: allocates the next snapshot number
        activity.update({ kind: "cut", label: `Creating ${reply.cut.title}`, target: { cutId: cut.cutId, version, ...(sourceIdea?.id ? { ideaId: sourceIdea.id } : {}) } });
        const preferences = await getPreferences();
        let promisedDraft: StoredVersion | undefined;
        const prepareDraft = async (answer: NonNullable<ParsedReply["reply"]["cut"]>, candidateParsed: ParsedReply) => {
          const handOrder = editing && last && handMovedPieces(last,editing.versions).size ? last.pieces?.map(p=>p.id) : undefined;
          const assembled = await assembleReel(root, shoot, template, answer, { lengthS, musicFile: ctx.musicFile, shotOrder: !handOrder, handOrder }, candidates, catalog.warnings);
          assembled.reel.warnings.push(...candidateParsed.warnings);
          assembled.reel.missing = candidateParsed.reply.missing;
          const record: StoredVersion = {
            audio: editing ? last?.audio : { ...defaults.voice },
            grade: editing ? last?.grade : { ...gradeForLook("rec709", defaults.look), matchClips: true, detail: defaults.look.detail === false ? null : { ...DEFAULT_DETAIL } },
            faceMatch: last?.faceMatch ?? "ease",
            sfx: last?.sfx?.filter(item => !item.auto).map(item => ({ ...item })),
            ...(last?.soundDesign ? { soundDesign: { suppressed: [...last.soundDesign.suppressed] } } : {}),
            baseVersion: last?.version ?? 0, version, createdAt: new Date().toISOString(), title: answer.title,
            voice: assembled.reel.cuts.map((c) => c.id),
            broll: assembled.reel.broll.map(({ id, over }) => ({ id, over })),
            music: assembled.reel.music ? { file: assembled.reel.music.file, startS: assembled.reel.music.startS, gainDb: assembled.reel.music.gainDb, fit: last?.music?.fit ?? true, followStory: last?.music?.followStory } : null,
            pieces: resolveReelPieces(shoot, template, assembled.cutList, assembled.reel),
            templateId: template.id, lengthS: assembled.lengthS, preview: null, why: answer.why,
            warnings: assembled.reel.warnings, missing: candidateParsed.reply.missing, feedback: editing ? user.text : null,
            assembly: { shoot, template, cutList: assembled.cutList, reel: assembled.reel },
            previewRev: 0,
          };
          if (record.grade?.detail) record.assembly.reel.why += `\n\n[Detail]\n${detailReadme}\n${JSON.stringify(record.grade.detail)}\n[/Detail]`;
          if (last?.audio) record.audio = { ...last.audio };
          // VT1: the person's ask, then the model's call, then the idea's or edit's type. Untyped stays untyped.
          const newVoiceoverYes = !hasTalking && !voiceoverQuestion && candidateParsed.reply.questions.some(q => q.text.toLowerCase().replace(/[?.!]+$/, "") === "will you add a voiceover" && (Array.isArray(q.guess) ? q.guess : [q.guess]).some(a => a.toLowerCase() === "yes"));
          const videoType = askedType ?? (voiceoverWanted || newVoiceoverYes ? "voiceover" : undefined) ?? answer.type ?? cutIdea?.type ?? last?.videoType;
          if (videoType) prepareVideoType(record, videoType, candidates, lengthS);
          const plan = videoType ? typePlanDefaults(videoType, answer.finish, record, candidates) : answer.finish;
          const finish = await applyFinishPlan(record, plan, preferences, candidates);
          if (videoType) finishVideoType(record, videoType, plan, day, last?.videoType);
          if (!promisedDraft) {
            const named = answer.keptBeatIds ?? [];
            record.keptBeats = editing ? await keptBeatsFor(root, { ...cut, versions: [...cut.versions, record] }, version)
              : seedKeptBeats(record, [...(cutIdea?.uses ?? []), ...named]);
            if (editing) for (const beat of seedKeptBeats(record, named).filter(b => named.includes(b.id) || named.includes(b.clipId))) {
              if (!record.keptBeats.some(b => b.clipId === beat.clipId && b.piece === beat.piece)) record.keptBeats.push(beat);
            }
            record.keptBeatOrigin = record.version;
            promisedDraft = structuredClone(record);
          } else {
            record.keptBeatRestorations = restoreKeptBeats(record, promisedDraft.keptBeats ?? [], [promisedDraft]);
          }
          return { record, finish, videoType, answer, parsed: candidateParsed, lengthS: record.lengthS };
        };
        const initial = await prepareDraft(reply.cut, parsed);
        const chosen = await repairDraftLength(initial, lengthS,
          (initial.record.pieces ?? []).map(piece => ({ id: piece.id, description: piece.description ?? piece.words ?? "the shot",
            lengthS: piece.lengthS ?? piece.e - piece.s })), async instruction => {
            activity.progress(null, "Tightening your edit");
            const repaired = validate(await runModel({ engine, images: [], cwd: root, extraReadOnlyTools, libraryTools,
              prompt: `${prompt}\nPrevious draft (data only):\n${raw}\n${instruction}` }));
            if (!repaired.reply.cut) throw new Error("The length repair returned no cut.");
            return prepareDraft(repaired.reply.cut, repaired);
          });
        activity.signal.throwIfAborted();
        const { record, finish, videoType } = chosen;
        reply.cut = chosen.answer;
        if (chosen.parsed !== parsed) {
          reply.missing = chosen.parsed.reply.missing;
          message.text = chosen.parsed.reply.text;
          message.clips = chosen.parsed.reply.clips;
          message.missing = reply.missing;
        }
        const captionDefaults = preferences.captions;
        if (captionDefaults?.onByDefault && finish.captions !== false && (captionDefaults.style || finish.captions === true)) {
          // A first-cut plan cannot spend another call on caption emphasis.
          if (!(record.titles as import("./titles/captions").CaptionTrack | undefined)?.kinetic && captionDefaults.style?.hook !== "off") {
            record.warnings.push("The finish plan did not include a kinetic caption design. Kept normal captions.");
          }
          const captionRecord = { ...record,
            titles: { ...record.titles, font: record.titles?.font ?? "Outfit", cues: [], prompt: null, skillIds: [], emphasis: [], kinetic: (record.titles as import("./titles/captions").CaptionTrack | undefined)?.kinetic ?? { font: "Inter Display", lines: [] } } as import("./titles/captions").CaptionTrack };
          record.titles = await styleCaptions(root, shoot, captionRecord, template, record.assembly.cutList, { ...(captionDefaults.style ?? DEFAULT_CAPTION_STYLE), hook: captionDefaults.style?.hook ?? "auto" });
        }
        const durationWarning = lengthWarning(record.lengthS, lengthS);
        if (durationWarning) record.warnings.push(durationWarning);
        if (last) carryClipSound(last,record);
        else newEditClipSound(record,preferences.clipSoundNewEdits);
        await (await import("./balance")).reuseBalances(root,record);
        if((await import('../shared/screen-match')).listScreenRecordings(shoot).length){
          const previous=last;
          record.autoLayouts={...previous?.autoLayouts,enabled:previous?.autoLayouts?.enabled??true};
          if(previous?.layouts?.some(l=>l&&!l.auto))record.layouts=structuredClone(previous.layouts);
        }
        if (record.assembly.cutList.length) await renderStoredPreview(root, cut.cutId, record, await freshen(root, record.assembly));
        else record.previewRev = PREVIEW_REV;
        cut.versions.push(record);
        cut.targetLengthS = lengthS;
        cut.skillIds = skillIds;
        await atomic(cutFile(root, cut.cutId), cut);
        // VO7-1: a draft precut made is a version that matters.
        await markMilestone(root, cut.cutId, version, { kind: "draft", name: "Draft by precut" }).catch(error => console.warn("[revisions]", error));
        message.cut = { cutId: cut.cutId, version };
        if (videoType === "voiceover") {
          try { await (await import("./voiceover-script")).writeVoiceoverScript(root, cut.cutId, version); }
          catch (error) {
            record.warnings.push("Could not write the voiceover. Open Voiceover to try again.");
            await atomic(cutFile(root, cut.cutId), cut);
            console.warn("[voiceover]", error);
          }
        }
        if (!editing && !ctx.early) firstCut = message.cut;
        if (cutIdea) cutIdea.cutId = cut.cutId;
      }
    } catch (error) {
      message.error = plainError(error);
      activity.fail(message.error);
      message.text = message.text ? `${message.text} ${message.error}` : message.error;
    }
    await atomic(path.join(folder(root), "last-call.json"), { messageId: message.id,
      step: ctx.addIdeas || ctx.ideaId ? "ideas" : ctx.cutId || ctx.fromIdea || ctx.templateId || message.cut ? "precut" : "ideas",  // FIX3: a concept edit is an edit, as `stage` says
      text: user.text, context: ctx });
    message.at = new Date().toISOString();
    await saveThread(root, [...thread, user, message]);
    if (message.cut) activity.update({ target: message.cut });
    return message;
  })).then(message => {
    reportStage(root, stage, message.error ? "failed" : message.cut || message.ideas?.length ? "done" : "queued", message.error ?? null);
    if (message.cut && !message.error) {
      const made=message.cut;
      void detachedEditWork(async()=>{
        const balance=await import("./balance");
        try { await balance.correctDraftInBackground(root,made.cutId,made.version); } catch(error) { console.warn("[auto correct]",error); }
        if(firstCut) {
          const latest=await currentVersion(root,made.cutId).catch(()=>made.version);  // VO7-2: after Auto correct, the current revision
          improveInBackground(root,{cutId:made.cutId,version:latest});
        }
      }).catch(()=>{});
    }
    return message;
  }, error => {
    reportStage(root, stage, "failed", error instanceof Error ? error.message : "Could not finish this request. Try again.");
    throw error;
  }).finally(() => stepsChanged(root));
}
/** Source choices changed: retire suggestions locally; saved edits and history remain. */
export function retireIdeas(root: string): Promise<void> {
  return serial(root, async () => {
    const thread = await sidekickThread(root);
    for (const turn of thread) for (const idea of turn.ideas ?? []) { idea.passed = true; idea.pick = false; }
    await saveThread(root, thread);
  });
}
export function passIdea(root: string, messageId: string, index: number, passed: boolean): Promise<void> {
  root = path.resolve(root);
  return serial(root, async () => {
    const thread = await sidekickThread(root);
    const idea = thread.find((m) => m.id === messageId)?.ideas?.[index];
    if (!Number.isInteger(index) || !idea || typeof passed !== "boolean") throw new Error("Could not find that idea. Open the latest ideas and try again.");
    idea.passed = passed;
    await saveThread(root, thread);
  });
}
const listingReads = new Map<string, Promise<Cut[]>>();
export async function listCuts(root: string): Promise<Cut[]> {
  root = path.resolve(root);
  // Transaction readers must keep their own lock context. Other overlapping
  // readers share the work before parsing a shoot or waiting on an edit lock.
  if (activeQueue.getStore()?.size) return structuredClone(await listCutsSnapshot(root));
  let pending = listingReads.get(root);
  if (!pending) {
    pending = listCutsSnapshot(root);
    listingReads.set(root, pending);
    const release = () => { if (listingReads.get(root) === pending) listingReads.delete(root); };
    void pending.then(release, release);
  }
  return structuredClone(await pending);
}
const lightReads = new Map<string, Promise<Cut[]>>();
/** ARCH2: what the page lists (api:listCuts). Old versions carry the versions menu's fields; the current revision, its
 * undo neighbours, the newest snapshots and what the page showed recently come in full. loadCutVersion gives the rest. */
export async function listCutsLight(root: string): Promise<Cut[]> {
  root = path.resolve(root);
  if (activeQueue.getStore()?.size) return structuredClone(await listCutsSnapshot(root, true));
  let pending = lightReads.get(root);
  if (!pending) {
    pending = listCutsSnapshot(root, true);
    lightReads.set(root, pending);
    const release = () => { if (lightReads.get(root) === pending) lightReads.delete(root); };
    void pending.then(release, release);
  }
  return structuredClone(await pending);
}
async function listCutsSnapshot(root: string, light = false): Promise<Cut[]> {
  if (!await shootHasOtherWriter(root).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; })) await (await import("./cuts")).purgeDeletedCuts(root);
  let entries: string[];
  try { entries = await fs.readdir(path.join(folder(root), "cuts")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  let shoot: Shoot | undefined, parsed = false;
  const indexFile = path.join(root, ".sidething/index.json"), indexIdentity = await cutIdentity(root, indexFile);
  // ARCH2: a light listing of logs never needs the whole index here (each whole version hydrates from the shared one).
  const indexed = async () => {
    if (!parsed) { parsed = true; try { shoot = effectiveShoot(JSON.parse(await fs.readFile(path.join(root, ".sidething/index.json"), "utf8"))); } catch { /* An offline shoot can still return its saved pieces and words. */ } }
    return shoot;
  };
  if (!light) await indexed();
  const cuts: Cut[] = [];
  // Bound first-read migration memory to one legacy file at a time.
  for (const f of entries.filter((f) => f.endsWith(".json"))) {
    const file = path.join(folder(root), 'cuts', f), identity = await cutIdentity(root, file);
    if (light) {
      // The app's first open moves a one-file edit to the log (readCut); either way the page gets light old versions.
      if (ownsOpenShoot(root) && !await readLogHead(file).catch(() => null)) await readCut(root, f.slice(0, -5)).catch(() => null);
      else if (ownsOpenShoot(root)) await retireOld(root, file);
      try { cuts.push(await lightCut(root, file, f.slice(0, -5))); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; console.warn("[edit history] listing in full:", error instanceof Error ? error.message : error); }
    }
    const cached = publicSnapshots.get(file);
    if (cached?.identity === identity) cuts.push({ ...cached.cut });
    else {
      try {
        const stored = await readCut(root, f.slice(0, -5), indexIdentity === await cutIdentity(root, indexFile) ? await indexed() : undefined);
        cuts.push(identity === await cutIdentity(root, file) ? { ...rememberPublic(file, identity, stored) } : publicCut(stored));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ST1_TRASHED_SOURCE") throw error;
        // ST1: one missing shot must not hide this edit or the rest of the library.
        // Opening its player reports the precise recovery message from readCutFile.
        const { storage: _storage, versionLog: _log, ...saved } = JSON.parse(await fs.readFile(file, "utf8"));
        cuts.push({ ...saved, versions: saved.versions.map(({ assembly: _assembly, ...version }: StoredVersion) => ({
          ...version, warnings: [...version.warnings ?? [], (error as Error).message],
        })) });
      }
    }
  }
  if (!await shootHasOtherWriter(root)) void healPreviews(root, cuts);
  // Publish the legacy default explicitly. The renderer defaults new edits to
  // Matched; an older saved grade must show the same off state its LUT uses.
  const defaults = (await getPreferences()).look;
  for (const cut of cuts) cut.versions = cut.versions.map(version => ({ ...version,
    grade: { ...(version.grade ?? gradeForLook("rec709", defaults)), matchClips: version.grade?.matchClips ?? false },
  }));
  // at(-1) stays: edits list by when anything was last saved to them, the newest snapshot.
  return cuts.sort((a, b) => (b.versions.at(-1)?.createdAt ?? "").localeCompare(a.versions.at(-1)?.createdAt ?? "") || b.cutId.localeCompare(a.cutId));
}
// Repair only the current edit on listing. Old undo versions prepare their own
// sound when opened; listing 323 versions must not enqueue 323 background saves.
const healing = new Set<string>();
async function healPreviews(root: string, cuts: Cut[]): Promise<void> {
  // slice(-1) stays: listing heals the newest snapshot only; an undone-to revision prepares its sound when opened.
  for (const cut of cuts) for (const v of cut.versions.slice(-1)) {
    const key = `${path.resolve(root)}|${cut.cutId}|${v.version}`;
    // OPEN1: a version whose playback preparation is already running is not healed beside it. That heal re-read
    // and rewrote the whole 569-version file (1 to 2 s) right after every save, holding the edit's queue while the
    // new version waited to load and draw; the preparation sets the same revision when it finishes. A failed
    // preparation leaves previewRev behind, so the next listing still heals it.
    if ((v as StoredVersion).previewRev === previewRevision(v) || healing.has(key) || preparingPreviews.has(key)) continue;
    healing.add(key);
    try {
      await serial(cutFile(root, cut.cutId), async () => {
        const head = await logHead(root, cut.cutId);
        if (head) {
          // ARCH2: one version read, its cache overlay written; the history is never re-read or rewritten.
          if (!head.versionLog.index.some(e => e.v === v.version)) return;
          const saved = await loadRevision(root, cut.cutId, v.version, { light: true });
          if (!saved.assembly || saved.previewRev === previewRevision(saved)) return;
          const record = structuredClone(saved);
          if (record.assembly.cutList.length) await renderStoredPreview(root, cut.cutId, record, await freshen(root, record.assembly));
          else record.previewRev = PREVIEW_REV;
          record.warnings = record.warnings.filter((w) => !w.startsWith("The preview could not be rendered"));
          await rewriteCache(root, cut.cutId, saved, record);
          changed(root);
          return;
        }
        const stored = await readCut(root, cut.cutId);
        const record = stored.versions.find((x) => x.version === v.version);
        if (!record?.assembly || (record.previewRev === previewRevision(record))) return;
        if (record.assembly.cutList.length) await renderStoredPreview(root, cut.cutId, record, await freshen(root, record.assembly));
        else record.previewRev = PREVIEW_REV;
        record.warnings = record.warnings.filter((w) => !w.startsWith("The preview could not be rendered"));
        await atomic(cutFile(root, cut.cutId), stored);
        changed(root);
      });
    } catch {
      // End the rendering state without hiding the last playable preview.
      await serial(cutFile(root, cut.cutId), async () => {
        if (await logHead(root, cut.cutId)) {
          const saved = await loadRevision(root, cut.cutId, v.version, { light: true });
          if (saved.warnings.some((w) => w.startsWith("The preview could not be rendered"))) return;
          await rewriteCache(root, cut.cutId, saved, { ...structuredClone(saved), warnings: [...saved.warnings, "The preview could not be rendered here. You can still export this version to Resolve."] });
          changed(root);
          return;
        }
        const stored = await readCut(root, cut.cutId);
        const record = stored.versions.find((x) => x.version === v.version);
        if (record && !record.warnings.some((w) => w.startsWith("The preview could not be rendered"))) {
          record.warnings.push("The preview could not be rendered here. You can still export this version to Resolve.");
          await atomic(cutFile(root, cut.cutId), stored);
          changed(root);
        }
      }).catch(() => {});
    }
  }
}

/** Append batch history under the same lock as edit mutations. */
export async function recordCutExport(root: string, cutId: string, version: number, folder: string): Promise<void> {
  root = path.resolve(root);
  await serial(cutFile(root, cutId), async () => {
    const cut = await readCut(root, cutId);
    if (!cut.versions.some(item => item.version === version)) throw new Error("That edit version does not exist.");
    if (cut.exported.some(item => item.folder === folder)) return;
    cut.exported.push({ version, folder, at: new Date().toISOString() });
    await atomic(cutFile(root, cutId), cut);
    changed(root);
  });
}

export function exportSidekickCut(root: string, cutId: string, version: number, outputFolder?: string, editor?: EditorId): Promise<ReelResult> {
  root = path.resolve(root);
  return serial(cutFile(root, cutId), async () => {
    const selected = editor ?? await getEditor();
    const name = { resolve: "Resolve", premiere: "Premiere Pro", finalcut: "Final Cut Pro", capcut: "CapCut" }[selected];
    return runActivity({ kind: "export", root, target: { cutId, version }, label: `Exporting to ${name}` }, async () => {
      const cut = await readCut(root, cutId);
      const record = cut.versions.find((v) => v.version === version);
      if (!record) throw new Error("That edit version does not exist.");
      // VO7-2: the export is pinned to this revision (record) before rendering; it becomes an export milestone on success.
      const { shoot, template, cutList, reel } = await freshen(root, record.assembly);
      const composed=!!record.angleCuts?.length||!!record.layouts?.some(l=>l?.kind==='scene');
      if (composed && !record.finished) record.finished = await runActivity({kind:'render',root,target:{cutId,version},label:'Rendering picture',cancelable:true}, async () =>
        (await import('./preview')).renderFinishingPreview(root,cutList,{name:`${cutId}-v${version}`,template,version:{...record,assembly:{shoot,template,cutList,reel}},reel,full:true}),{renderLane:'finished'});
      const result = await exportForEditor(selected, { root, shoot, kind: "reel", template, cutList,
        opts: { reel: { ...reel, why: reel.why + overlayReadme(record.overlays) }, outputFolder: outputFolder ?? path.join(root, "sidething precuts"),
          folderName: `${record.title} v${record.version}`, existingPreview: record.preview, ...(composed ? {finishing:record} : {}) },
        previewPath: record.preview, activityTarget: { cutId, version } });
      await (await import("./export")).writeExportCover(root, cutId, { ...record, assembly: { shoot, template, cutList, reel } }, result.folder);
      await (await import("./translate")).writeDeliveryText(root, record, result.folder, path.basename(result.folder));
      if (composed && record.finished) await fs.copyFile(record.finished,path.join(result.folder,'Finished.mp4'));
      await (await import('./angles')).writeAngleDelivery(result.folder,record.angleCuts,shoot);
      cut.exported.push({ version, folder: result.folder, at: new Date().toISOString() });
      await atomic(cutFile(root, cutId), cut);
      await markMilestone(root, cutId, version, { kind: "export", name: "Exported" }).catch(error => console.warn("[revisions]", error));
      changed(root);
      return { ...result, reel };
    });
  });
}

// The title designer supplies a validated track. Retain the exact assembly;
// invalidate only this version's preview so healing includes the new layers.
export function editTitleTrack(root: string, cutId: string, version: number,
  design: (shoot: Shoot, template: Template, previous: CutVersion, cutList: CutItem[]) => Promise<TitleTrack>): Promise<{ cutId: string; version: number }> {
  root = path.resolve(root);
  return serial(cutFile(root, cutId), () => runActivity({ kind: "titles", root, target: { cutId, version }, label: "Adding titles" }, async activity => {
    const draft = finishingDraft.getStore();
    if (draft?.root === root && draft.cutId === cutId && draft.source === version) {
      const { shoot, template, cutList } = draft.assembly;
      activity.update({ target: { cutId, version: draft.record.version } });
      draft.record.titles = await design(shoot, template, draft.record, cutList);
      return { cutId, version: draft.record.version };
    }
    const cut = await readCut(root, cutId);
    const previous = cut.versions.find((v) => v.version === version);
    if (!previous?.assembly) throw new Error("Could not find that edit version's saved assembly.");
    const { shoot, template, cutList } = await freshen(root, previous.assembly);
    const pieces = previous.pieces ?? resolveReelPieces(previous.assembly.shoot, template, previous.assembly.cutList, previous.assembly.reel);
    const titles = await design(shoot, template, { ...previous, pieces }, cutList);
    const next = Math.max(...cut.versions.map((v) => v.version)) + 1;
    activity.update({ target: { cutId, version: next } });
    const record: StoredVersion = { ...previous, pieces, version: next, createdAt: new Date().toISOString(), titles, preview: null,
      previewRev: 0, finished: null, feedback: "Added titles" };
    record.baseVersion = previous.version; builtFrom.set(record, previous.version);
    await renderStoredPreview(root, cutId, record, await freshen(root, record.assembly));
    cut.versions.push(record);
    await atomic(cutFile(root, cutId), cut);
    changed(root);
    return { cutId, version: next };
  }));
}

// Repair by source identity, never an old LxAy id. Preserve untouched sub-items
// verbatim, including trims and put-back fillers, when no clean take exists.
async function replacePractice(root: string, cut: StoredCut, previous: StoredVersion,
  pieces: NonNullable<CutVersion["pieces"]>, place?: { next: number; save: (record: StoredVersion) => Promise<void> }): Promise<{ cutId: string; version: number }> {
  const assembly = await freshen(root, previous.assembly);
  const { shoot, template } = assembly;
  const { voice } = reelIds(shoot);
  const warnings: string[] = [];
  let swapped = 0;
  const replacements = new Map<number, { id: string; items: CutItem[] }>();
  pieces.forEach((piece, index) => {
    if (piece.kind !== "voice") return;
    const matches = shoot.takes.flatMap((take) => take.attempts.map((attempt) => ({ take, attempt,
      overlap: attempt.clipId === piece.clipId ? Math.max(0, Math.min(piece.e, attempt.e) - Math.max(piece.s, attempt.s)) : 0,
    }))).filter(({ attempt, overlap }) => attempt.practice && overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.take.lineIndex - b.take.lineIndex);
    const take = matches[0]?.take;
    if (!take) return;
    const clean = take.attempts.map((attempt, n) => ({ attempt, n, id: `L${take.lineIndex + 1}A${n + 1}` }))
      .filter(({ attempt, id }) => !attempt.practice && voice.has(id))
      .sort((a, b) => Number(b.n === take.starred) - Number(a.n === take.starred)
        || (a.attempt.measures?.flags.length ?? 0) - (b.attempt.measures?.flags.length ?? 0)
        || (b.attempt.measures?.faceQuality ?? -1) - (a.attempt.measures?.faceQuality ?? -1)
        || (b.attempt.measures?.eyeContact ?? -1) - (a.attempt.measures?.eyeContact ?? -1)
        || (a.attempt.measures?.pauseS ?? Infinity) - (b.attempt.measures?.pauseS ?? Infinity)
        || a.n - b.n);
    const best = clean[0];
    const items = best ? buildCutList(shoot, "reel", template, [voice.get(best.id)!], previous.keptFillers) : [];
    if (!best || !items.length) {
      warnings.push(`Line ${take.lineIndex + 1} has no clean take. Kept its practice take.`);
      return;
    }
    replacements.set(index, { id: best.id, items });
    swapped++;
  });
  const groups = cutPieceGroups(assembly.cutList);
  let offsetFrames = 0;
  const cutList = groups.flatMap(({ items }, index) => (replacements.get(index)?.items ?? items).map((item) => {
    const next = { ...item, piece: index, offsetFrames };
    offsetFrames += item.durTimelineFrames;
    return next;
  }));
  const reel: ReelAssembly = { ...assembly.reel,
    warnings: [...previous.warnings.filter((w) => !w.startsWith("The preview could not be rendered")), ...warnings],
    cuts: groups.map((_, index) => {
      const items = cutList.filter((item) => item.piece === index);
      const first = items[0], last = items.at(-1)!;
      const fps = first.clipFpsR.num / first.clipFpsR.den;
      return { ...assembly.reel.cuts[index], id: replacements.get(index)?.id ?? pieces[index].id,
        clipId: first.seg!.clip.id, s: first.inFrames / fps, e: last.outFrames / fps,
        offsetS: first.offsetFrames / template.fps,
        lengthS: items.reduce((sum, item) => sum + item.durTimelineFrames / template.fps, 0),
        ...(replacements.has(index) ? { beatDeltaS: 0, beatS: null } : {}) };
    }),
    broll: assembly.reel.broll.map((overlay) => ({ ...overlay,
      over: replacements.get(overlay.voiceIndex)?.id ?? pieces[overlay.voiceIndex].id })),
  };
  reel.model = { ...reel.model, voice: reel.cuts.map(({ id }) => ({ id })),
    broll: reel.broll.map(({ id, over }) => ({ id, over })) };
  if (reel.music && swapped) {
    reel.voiceLUFS = await measureReelVoice(root, cutList.filter((item) => item.seg?.lineIndex !== null), template);
    if (reel.voiceLUFS !== null) reel.music = { ...reel.music,
      gainDb: Math.round((reel.voiceLUFS - 15 - reel.music.musicLUFS) * 100) / 100 };
  }
  const resolved = resolveReelPieces(shoot, template, cutList, reel).map((piece, index) =>
    replacements.has(index) ? piece : { ...pieces[index], timelineS: piece.timelineS, overlay: piece.overlay });
  const next = place?.next ?? Math.max(...cut.versions.map((v) => v.version)) + 1;
  const record: StoredVersion = { version: next, createdAt: new Date().toISOString(), title: previous.title,
    grade: previous.grade, audio: previous.audio, energy: previous.energy, titles: previous.titles, faceMatch: previous.faceMatch, cover: previous.cover, overlays: previous.overlays,
    ...(previous.videoType ? { videoType: previous.videoType } : {}),
    voice: reel.cuts.map(({ id }) => id), broll: reel.broll.map(({ id, over }) => ({ id, over })),
    music: reel.music ? { file: reel.music.file, startS: reel.music.startS, gainDb: reel.music.gainDb, duckDepthDb: previous.music?.duckDepthDb, duck: previous.music?.duck, fit: previous.music?.fit, followStory: previous.music?.followStory, ...(previous.music?.shape ? { shape: previous.music.shape } : {}) } : null,
    pieces: resolved, keptFillers: [...(previous.keptFillers ?? [])], templateId: template.id,
    lengthS: offsetFrames / template.fps, preview: null, previewRev: 0, why: previous.why,
    warnings: reel.warnings, missing: [...previous.missing],
    feedback: `Swapped ${swapped} practice ${swapped === 1 ? "take" : "takes"} for clean ones`,
    assembly: { shoot, template, cutList, reel } };
  carryJoinCraft(previous, record, resolved.map((_, i) => i));
  if (record.overlays?.some(o => o.graphic?.words?.length)) record.overlays = await (await import("./graphics/edit")).retimeGraphicOverlays(record).catch(() => record.overlays);  // GFX1: graphics stay on their words
  record.baseVersion = previous.version; builtFrom.set(record, previous.version);
  await renderStoredPreview(root, cut.cutId, record, record.assembly);
  if (place) await place.save(record);  // ARCH2: editPiece's save (one appended line on a log)
  else { cut.versions.push(record); await atomic(cutFile(root, cut.cutId), cut); }
  changed(root);
  return { cutId: cut.cutId, version: next };
}

// Work on saved source spans: rebuilding unrelated takes would undo hand trims
// and turn each half of a split back into the whole take.
function slicePiece(items: CutItem[], s: number, e: number, fps: number): CutItem[] {
  const removed = items.flatMap(item => item.removed ?? []).filter(f => f.s >= s && f.e <= e);
  const result: CutItem[] = items.flatMap(item => {
    const rate = item.clipFpsR.num / item.clipFpsR.den;
    const start = Math.max(item.inFrames / rate, s), end = Math.min(item.outFrames / rate, e);
    return end > start + 1e-9 ? [{ ...item, inFrames: start * rate, outFrames: end * rate,
      durTimelineFrames: (end - start) * fps, removed: undefined }] : [];
  });
  if (result.length) result[0].removed = removed;
  return result;
}
function nearestEdge(value: number, edges: number[]): number {
  return edges.reduce((best, edge) => Math.abs(value - edge) < Math.abs(value - best) ? edge : best);
}

async function editBatch(root: string, cutId: string, version: number, edit: Extract<CutEdit, { kind: "batch" }>) {
  if (!edit.label?.trim() || edit.label.length > 240 || !Array.isArray(edit.edits) || !edit.edits.length || edit.edits.length > 500) throw new Error("Give the batch a label and 1 to 500 edits.");
  if (edit.edits.some(e => e.kind === "batch")) throw new Error("Put edits in one batch without nested batches.");
  return runBatch(root, cutId, version, edit.label, edit.edits) as Promise<{ cutId: string; version: number }>;
}
/** MB1: a batch step is a hand edit, or a finishing call (music level, caption place) staged in the same draft. */
export type BatchStep = CutEdit | ((version: number) => Promise<{ version: number }>);
/** The UL1 batch. `accept` sees the finished draft before it is saved; false keeps history exactly as it was (null). */
export function runBatch(root: string, cutId: string, version: number, label: string, steps: BatchStep[],
  accept?: (record: StoredVersion) => Promise<boolean>): Promise<{ cutId: string; version: number } | null> {
  root = path.resolve(root);
  return serial(cutFile(root, cutId), () => runActivity({ kind: "edit", root, target: { cutId, version }, label, cancelable: true }, async activity => {
    const cut = await readCut(root, cutId), previous = cut.versions.find(v => v.version === version);
    if (!previous) throw new Error("That edit version does not exist.");
    const next = Math.max(...cut.versions.map(v => v.version)) + 1;
    const staged = { file: cutFile(root, cutId), cut: { ...cut, versions: [structuredClone(previous)] } };
    let current = version;
    await batchDraft.run(staged, async () => {
      for (const [index, change] of steps.entries()) {
        activity.signal.throwIfAborted();
        try {
          current = (typeof change === "function" ? await change(current) : await editCut(root, cutId, current, change)).version;
          // Retain just the evolving draft, not a full shoot per intermediate edit.
          staged.cut.versions = [staged.cut.versions.find(v => v.version === current)!];
        }
        catch (cause) { throw new Error(`Edit ${index + 1} (${typeof change === "function" ? "finish" : change.kind}): ${cause instanceof Error ? cause.message : cause}`); }
      }
    });
    const record = staged.cut.versions.find(v => v.version === current)!;
    // A voice edit in the batch tagged the voiceover as its staged revision's; it is this revision's now, or the
    // save would take it for an older one and retime the sidecar's voice over it (losing the batch's voice edits).
    if (record.voiceover?.version === record.version) record.voiceover = { ...record.voiceover, version: next };
    record.baseVersion = version; builtFrom.set(record, version);
    record.version = next; record.feedback = label.trim(); record.createdAt = new Date().toISOString();
    if(label.trim()==="Made it better" && record.music)record.music={...record.music,pinnedArrangement:undefined};
    if (accept && !await accept(record)) return null;
    activity.signal.throwIfAborted();
    await renderStoredPreview(root, cutId, record, record.assembly);
    activity.signal.throwIfAborted();
    // VO7-1/2: before Make it better applies, the state before it stays one click away in the version menu.
    if(label.trim()==="Made it better")await markMilestone(root, cutId, version, { kind: "before-auto", name: "Before Make it better" }).catch(error => console.warn("[revisions]", error));
    cut.versions.push(record);
    await atomic(cutFile(root, cutId), cut, activity.signal); changed(root);
    if(label.trim()==="Made it better")setImmediate(()=>{void detachedEditWork(()=>import("./balance").then(m=>m.correctDraftInBackground(root,cutId,next))).catch(()=>{});});
    return { cutId, version: next };
  }));
}

/** VO7-1: every edit saves through the revisions commit (revisions.ts). It returns the version
 * number exactly as before, so the renderer works unchanged until it moves to the undo cursor. */
export async function editCut(root: string, cutId: string, version: number, edit: CutEdit, options?: EditCutOptions): Promise<{ cutId: string; version: number; snapshot?: CutVersion }> {
  root = path.resolve(root);
  // A batch or finishing transaction stages its steps in memory; only its final snapshot is one commit.
  if (batchDraft.getStore() || finishingDraft.getStore() || insideCommit(root, cutId)) return dispatchEdit(root, cutId, version, edit);
  if (typeof cutId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(cutId)) throw new Error("That edit id is invalid.");
  // VO7-2: Add clean read keeps the state before it as a version (a before-auto milestone).
  const before = edit.kind === "voiceover" && (edit as { op: string; identity?: unknown }).op === "placePlan" && (edit as { identity?: unknown }).identity ? "Before Add clean read" : null;
  // Reserve the hand edit before the asynchronous history check, in the same
  // release queue as finishing controls. Its original target still decides rebase.
  let wrote: object | undefined;
  const result = await saveLook(root, cutId, version, () => commitEdit(root, cutId, version, { strict: true, edit }, async base => {
    if (before) await markMilestone(root, cutId, base, { kind: "before-auto", name: before }).catch(error => console.warn("[revisions]", error));
    const saved = await dispatchEdit(root, cutId, base, edit); wrote = saved;
    return { ...saved, baseVersion: base };
  }));
  // VO7-5: the voiceover sidecar is derived from the committed revision, after the commit.
  await import("./voiceover-script").then(m => {
    const voice = wrote && m.committedVoice.get(wrote);
    if (voice?.version === result.version) m.committedVoice.set(result, voice);
    return m.syncVoiceoverSidecar(root, cutId, { voice: edit.kind === "voiceover", result });
  }).catch(error => console.warn("[voiceover]", error));
  const snapshot = wrote && handSnapshots.get(wrote);
  return options?.snapshot && snapshot?.version === result.version ? { ...result, snapshot } : result;
}
async function dispatchEdit(root: string, cutId: string, version: number, edit: CutEdit): Promise<{ cutId: string; version: number }> {
  if (edit.kind === "transform") return import("./clip-transform").then(m => m.editTransform(root, cutId, version, edit));
  if (edit.kind === "captionWord" || edit.kind === "retimeCaptions") return import("./caption-edits").then(m => m.editCaption(root, cutId, version, edit));
  if (edit.kind === "move" || edit.kind === "duplicate" || edit.kind === "shotOrder") return import("./edits-move").then(m => m.movePiece(root, cutId, version, edit));
  if (edit.kind === "laneLevel") {
    if (!SOUND_LANES.includes(edit.lane) || edit.db !== undefined && (!Number.isFinite(edit.db) || edit.db < -60 || edit.db > 6) || edit.muted !== undefined && typeof edit.muted !== 'boolean' || edit.db === undefined && edit.muted === undefined) throw new Error("Choose a valid lane level.");
    return savePlaybackChange(root,cutId,version,base => runActivity({kind:"edit",root,target:{cutId,version:base},label:"Updating sound level"}, () => finishStoredVersion(root,cutId,base,true,async (record,assembly,baseVersion) => {
      record.assembly=assembly;
      if(edit.db !== undefined) record.laneLevels={...record.laneLevels,[edit.lane]:laneStep(edit.db)};
      if(edit.muted !== undefined) {
        if(edit.lane === 'clip-sound') record.clipSoundMuted=edit.muted;
        else record.laneMuted={...record.laneMuted,[edit.lane]:edit.muted};
      }
      record.feedback="Changed lane level";record.previewRev=PREVIEW_REV;
      return {cutId,version:record.version,baseVersion};
    },true)));
  }
  if (edit.kind === "clipSound") {
    if (edit.clean !== undefined && !['none','remove_music','isolate_voice'].includes(edit.clean)) throw new Error("Choose a clip sound cleanup.");
    if (edit.clean !== undefined && (edit.piece === undefined || edit.all !== undefined)) throw new Error("Choose a clip to clean.");
    if (edit.clean && edit.clean !== 'none') await (await import('./stem-mix')).requireSoundSeparation();
    if (edit.layer !== undefined && edit.layer !== 0 && edit.layer !== 1) throw new Error("Choose a clip sound lane.");
    if (edit.muted !== undefined && typeof edit.muted !== "boolean" || edit.gainDb !== undefined && (!Number.isFinite(edit.gainDb) || edit.gainDb < -12 || edit.gainDb > 12)) throw new Error("Choose a valid clip sound setting.");
    if (edit.all !== undefined && (edit.all !== "on" && edit.all !== "off" || edit.piece !== undefined || edit.muted !== undefined || edit.gainDb !== undefined || edit.layer !== undefined)) throw new Error("Choose all clips on or off.");
    if (edit.all === undefined && edit.muted === undefined && edit.gainDb === undefined && edit.clean === undefined) throw new Error("Choose a clip sound setting.");
    if (edit.all === undefined && edit.piece === undefined && (edit.layer === 1 || typeof edit.muted !== "boolean" || edit.gainDb !== undefined)) throw new Error("Choose whether to mute clip sound.");
    return savePlaybackChange(root,cutId,version,base => runActivity({kind:"edit",root,target:{cutId,version:base},label:"Updating clip sound"}, () => finishStoredVersion(root,cutId,base,true,async (record,assembly,baseVersion) => {
      record.assembly = assembly;
      if (edit.all) allClipSound(record,edit.all === "on");
      else if (edit.piece === undefined) record.clipSoundMuted = edit.muted;
      else {
        if (!Number.isInteger(edit.piece) || edit.piece < 0 || !assembly.cutList.some((c,i)=>(c.piece ?? i)===edit.piece)) throw new Error("Choose a clip in this cut.");
        record.pieceFx = [...record.pieceFx ?? []];
        if (edit.layer===1 && !assembly.reel.broll.some(p=>p.voiceIndex===edit.piece)) throw new Error("Choose an attached b-roll clip.");
        const cleanPatch = edit.clean === undefined ? {} : {clean:edit.clean};
        record.pieceFx[edit.piece] = edit.layer===1 ? {...record.pieceFx[edit.piece],overlaySound:{...record.pieceFx[edit.piece]?.overlaySound,...cleanPatch,...(edit.muted===undefined ? {} : {muted:edit.muted}),...(edit.gainDb===undefined ? {} : {gainDb:edit.gainDb})}} : {...record.pieceFx[edit.piece],...cleanPatch,...(edit.muted === undefined ? {} : {muted:edit.muted}),...(edit.gainDb === undefined ? {} : {gainDb:edit.gainDb})};
      }
      record.feedback = "Changed clip sound";
      record.previewRev = PREVIEW_REV;
      return {cutId,version:record.version,baseVersion};
    },true)));
  }
  if (edit.kind === "batch") {
    // Selection adjustments share the single-clip release queue. The batch's
    // internal handlers already bypass it while the staged draft owns the lock.
    if(edit.edits.length && edit.edits.every(e=>e.kind==='clipSound' || e.kind==='laneLevel' || e.kind==='pieceFx'))return savePlaybackChange(root,cutId,version,async base=>({...await editBatch(root,cutId,base,edit),baseVersion:base}));
    return editBatch(root, cutId, version, edit);
  }
  if (edit.kind === "voiceover") return import("./voiceover-place").then(m => m.editVoiceover(root, cutId, version, edit));
  if (edit.kind === "voiceWords") return import("./voiceover-place").then(m => m.editVoiceWords(root, cutId, version, edit));
  if (edit.kind === "extendPicture") return import("./extend-picture").then(m => m.extendToVoice(root, cutId, version, edit.mode));
  if (edit.kind === "angles") return import("./angles").then(m => m.editAngles(root, cutId, version, edit.cuts));
  if (edit.kind === "layout") return import("./layouts").then(m => m.editLayout(root, cutId, version, edit));
  if (edit.kind === "layoutRange") return import("./layout-ranges").then(m => m.editLayoutRange(root, cutId, version, edit));
  if (edit.kind === 'autoLayouts'||edit.kind === 'layoutBoundary'||edit.kind === 'layoutJoin'||edit.kind === 'layoutSplit') return import('./auto-layouts').then(m=>m.editAutoLayout(root,cutId,version,edit));
  if (edit.kind === "bleep" || edit.kind === "lowerThird") return import("./edits-ul1").then(m => m.editUl1(root, cutId, version, edit));
  if (edit.kind === "sfx") return import("./sound-design").then(({ editSounds }) => editSounds(root, cutId, version, edit));
  if (edit.kind === "produce") return import("./produce-pass").then(m => m.editProduce(root, cutId, version, edit));  // PRO1: one version through runBatch
  if (edit.kind === "bigLine") return import("./titles").then(({ setBigLine }) => setBigLine(root, cutId, version, edit.s, edit.big));
  if (edit.kind === "replace") return import("./cuts").then(m => m.replaceClip(root, cutId, version, edit));
  if (edit.kind === "insert") return import("./cuts").then(({ insertClip }) => insertClip(root, cutId, version, edit));
  if (edit.kind === "pieceFx" || edit.kind === "join") return editFx(root, cutId, version, edit);
  if (edit.kind === "overlay") return editOverlays(root, cutId, version, edit);
  if (["cutWords", "restoreWords", "removeFillers", "tightenPauses", "keepFiller"].includes(edit.kind)) {
    return editWords(root, cutId, version, edit as Parameters<typeof editWords>[3]);
  }
  if (edit.kind === 'trim' && 'magnetic' in edit && edit.magnetic) return savePlaybackChange(root,cutId,version,base=>editPiece(root,cutId,base,edit));
  return editPiece(root,cutId,version,edit);
}
async function editPiece(root: string, cutId: string, version: number, edit: CutEdit): Promise<{cutId:string;version:number}> {
  return serial(cutFile(root, cutId), () => runActivity({ kind: "edit", root, target: { cutId, version }, label: "Updating your edit" }, async activity => {
    // ARCH2: on a log the edit reads its base version only and appends one line (appendRevision), never the history.
    const head = batchDraft.getStore() ? null : await writableLog(root, cutId);
    if (head && !head.versionLog.index.some(e => e.v === version)) throw new Error("That edit version does not exist.");
    const cut: StoredCut = head ? { ...headFields(head) as unknown as StoredCut, versions: [await loadRevision(root, cutId, version, { view: true })] } : await readCut(root, cutId);
    const numbers = head ? head.versionLog.index.map(e => e.v) : cut.versions.map(v => v.version);
    const save = async (record: StoredVersion, signal?: AbortSignal) => {
      if (!head) { cut.versions.push(record); return atomic(cutFile(root, cutId), cut, signal); }
      await appendRevision(root, cutId, previous!, async (_base, next) => { if (next !== record.version) throw new Error("Something else changed this edit. Try again."); return record; });
    };
    const previous = cut.versions.find((v) => v.version === version);
    if (!previous) throw new Error("That edit version does not exist.");
    if (edit.kind === "cover") {
      const cover = validateCover(edit.cover, coverDuration(previous));
      const next = (numbers.at(-1) ?? 0) + 1;  // at(-1) stays: allocates the next snapshot number
      await save({ ...previous, baseVersion: previous.version, version: next, createdAt: new Date().toISOString(), cover,
        finished: null, feedback: cover ? "Changed cover" : "Restored automatic cover" }, activity.signal);
      changed(root); activity.update({ target: { cutId, version: next } });
      return { cutId, version: next };
    }
    if (!previous.assembly?.reel?.model) throw new Error("This edit has no saved assembly to edit. Make a new edit first.");
    const pieces = previous.pieces ?? resolveReelPieces(previous.assembly.shoot, previous.assembly.template,
      previous.assembly.cutList, previous.assembly.reel);
    activity.update({ label: `Updating ${previous.title}` });
    if (edit.kind === "replacePractice") {
      const result = await replacePractice(root, cut, previous, pieces, { next: (numbers.at(-1) ?? 0) + 1, save });  // at(-1): the next snapshot number
      activity.update({ target: result });
      return result;
    }
    const piece = "piece" in edit && edit.piece !== undefined && Number.isInteger(edit.piece) ? pieces[edit.piece] : undefined;
    if (!piece) throw new Error("That piece is not in this edit. Open the edit again and try again.");
    const fresh = await freshen(root, previous.assembly);
    const { shoot, template } = fresh;
    const savedGroups = cutPieceGroups(fresh.cutList).map(group => group.items);
    let replacement: CutItem[][] | null = null;
    const { voice } = reelIds(shoot);
    let overlays = previous.assembly.reel.broll.map(({ id, voiceIndex }) => ({ id, voiceIndex }));
    // Use the saved model's choices, restricted to the pieces actually assembled.
    // A dropped model id must not return when the user edits another piece.
    const answer: ReelAnswer = {
      ...previous.assembly.reel.model,
      voice: pieces.map(({ id }) => ({ id })),
      broll: previous.assembly.reel.broll.map(({ id, over }) => ({ id, over })),
      music: previous.music ? { file: previous.music.file, startS: previous.music.startS } : null,
      why: previous.why,
      warnings: [...previous.assembly.reel.model.warnings],
    };
    const keptFillers = [...(previous.keptFillers ?? [])];
    const line = /^L([1-9]\d*)A([1-9]\d*)$/.exec(piece.id);
    let feedback: string;
    if (edit.kind === "swap") {
      if (piece.kind !== "voice" || !line) throw new Error("Only a spoken line can be swapped to another take.");
      const take = typeof edit.take === "string" ? /^L([1-9]\d*)A([1-9]\d*)$/.exec(edit.take) : null;
      if (!take || take[1] !== line[1]) throw new Error("Choose another take of the same line.");
      const attempt = shoot.takes.find((t) => t.lineIndex === Number(take[1]) - 1)?.attempts[Number(take[2]) - 1];
      if (attempt?.practice) throw new Error("That take is a practice run. Choose a finished take of this line.");
      if (!attempt || !voice.has(edit.take)) throw new Error("That take is not available in this shoot. Choose another take of this line.");
      answer.voice[edit.piece] = { id: edit.take };
      feedback = `Swapped line ${line[1]} to take ${take[2]}`;
    } else if (edit.kind === "trim" || edit.kind === "split") {
      const segment = pieceSegment(fresh, edit.piece);
      if (!segment) throw new Error("That footage is no longer available.");
      const original = savedGroups[edit.piece];
      const magnetic = edit.kind === "trim" && "magnetic" in edit && edit.magnetic;
      const sourceRate = original[0].clipFpsR.num / original[0].clipFpsR.den;
      const full = magnetic ? [{ ...original[0], inFrames: 0, outFrames: Math.floor(segment.clip.meta!.durationS * sourceRate),
        durTimelineFrames: Math.floor(segment.clip.meta!.durationS * sourceRate) / sourceRate * template.fps, removed: undefined }]
        : edit.kind === "trim" ? buildCutList(shoot, "reel", template, [segment], keptFillers) : original;
      // Preserve every existing transcript hole while allowing the exposed edges
      // to extend into source footage. A drag never restores words cut by hand.
      const available = magnetic ? [...slicePiece(full, 0, original[0].inFrames / sourceRate, template.fps), ...original,
        ...slicePiece(full, original.at(-1)!.outFrames / sourceRate, segment.clip.meta!.durationS, template.fps)] : full;
      if (!available.length) throw new Error("That piece has no available source frames.");
      const rate = available[0].clipFpsR.num / available[0].clipFpsR.den;
      const low = available[0].inFrames / rate, high = available.at(-1)!.outFrames / rate;
      const words = pieceWords(fresh, edit.piece).filter(w => available.some(item =>
        w.s >= item.inFrames / rate - 1e-6 && w.e <= item.outFrames / rate + 1e-6));
      if (edit.kind === "trim") {
        if (![edit.s, edit.e].every(Number.isFinite) || edit.s >= edit.e) throw new Error("Choose a valid in and out point.");
        const starts = words.filter(w => !words.some(other => other.s < w.s && other.e > w.s)).map(w => w.s);
        const ends = words.filter(w => !words.some(other => other.s < w.e && other.e > w.e)).map(w => w.e);
        if (!magnetic && piece.kind === "voice" && (!starts.length || !ends.length)) throw new Error("This take has no measured words to trim safely.");
        const start = !magnetic && piece.kind === "voice" ? nearestEdge(edit.s, starts) : Math.max(low, Math.min(high, Math.round(edit.s * sourceRate) / sourceRate));
        const end = !magnetic && piece.kind === "voice" ? nearestEdge(edit.e, ends) : Math.max(low, Math.min(high, Math.round(edit.e * sourceRate) / sourceRate));
        if (start >= end) throw new Error("Keep at least one complete word in this piece.");
        replacement = [slicePiece(available, start, end, template.fps)];
        if (magnetic) replacement = replacement.map(items=>items.map(item=>({...item,handTrim:true})));
        feedback = `Trimmed ${line ? `line ${line[1]}` : "b-roll"}`;
      } else {
        if (!Number.isFinite(edit.at)) throw new Error("Choose a split point inside this piece.");
        const gaps = words.slice(0, -1).flatMap((w, i) => {
          const next = words[i + 1];
          const edge = (w.e + next.s) / 2;
          return next.s >= w.e && !words.some(other => other.s < edge && other.e > edge) ? [edge] : [];
        });
        if (piece.kind === "voice" && !gaps.length) throw new Error("This piece needs two complete words to split.");
        const at = piece.kind === "voice" ? nearestEdge(edit.at, gaps) : edit.at;
        if (at <= low || at >= high) throw new Error("Split inside the piece, leaving footage on both sides.");
        replacement = [slicePiece(original, low, at, template.fps), slicePiece(original, at, high, template.fps)];
        if (replacement.some(items => !items.length)) throw new Error("Split inside the piece, leaving footage on both sides.");
        // A split can land in an already removed filler. Keep its restoration
        // action on exactly one half, even when it lies outside playable spans.
        const removed = original.flatMap(item => item.removed ?? []);
        replacement.forEach((items, half) => { items[0].removed = removed.filter(filler => (filler.s < at ? 0 : 1) === half); });
        answer.voice.splice(edit.piece, 1, { id: piece.id }, { id: piece.id });
        overlays = overlays.flatMap(overlay => overlay.voiceIndex === edit.piece ? [overlay, { ...overlay, voiceIndex: edit.piece + 1 }]
          : [{ ...overlay, voiceIndex: overlay.voiceIndex > edit.piece ? overlay.voiceIndex + 1 : overlay.voiceIndex }]);
        feedback = `Split ${line ? `line ${line[1]}` : "b-roll"}`;
      }
    } else if (edit.kind === "remove") {
      if (pieces.length === 1) throw new Error("An edit cannot be empty. Keep at least one piece.");
      answer.voice.splice(edit.piece, 1);
      overlays = overlays.filter((overlay) => overlay.voiceIndex !== edit.piece)
        .map((overlay) => ({ ...overlay, voiceIndex: overlay.voiceIndex > edit.piece ? overlay.voiceIndex - 1 : overlay.voiceIndex }));
      feedback = line ? `Removed line ${line[1]}` : `Removed b-roll: ${piece.description ?? piece.id}`;
    } else if (edit.kind === "keepFiller") {
      const filler = Number.isFinite(edit.at) ? piece.removed?.find((f) => f.s === edit.at) : undefined;
      if (piece.kind !== "voice" || !line || !filler) throw new Error("That filler is not listed as removed from this piece. Open the edit again and try again.");
      const key = `${piece.clipId}@${edit.at.toFixed(2)}`;
      if (!keptFillers.includes(key)) keptFillers.push(key);
      const word = filler.text?.trim();
      const description = filler.kind === "pause" ? "a pause" : word ? `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}` : "a filler";
      feedback = `Put back ${description} in line ${line[1]}`;
    } else throw new Error("Choose a take swap, a piece to remove, or a filler to put back.");
    answer.broll = overlays.map(({ id, voiceIndex }) => ({ id, over: answer.voice[voiceIndex].id }));
    // Hand edits rebuild only their target. Reassembling the entire model here
    // would drop practice/missing ids and can remap old ids to new footage.
    let rebuilt: CutItem[] = [];
    if (edit.kind === "swap" || edit.kind === "keepFiller") {
      const segment = edit.kind === "swap" ? voice.get(edit.take) : pieceSegment(fresh, edit.piece);
      if (!segment) throw new Error("That footage is no longer available.");
      rebuilt = buildCutList(shoot, "reel", template, [segment], keptFillers);
      if (!rebuilt.length) throw new Error("That piece has no available source frames.");
    }
    const assembled = { cutList: [] as CutItem[], lengthS: 0, reel: {
      ...fresh.reel, model: answer, warnings: [...previous.warnings],
      music: fresh.reel.music ? { ...fresh.reel.music } : undefined,
    } };
    const groups = savedGroups.flatMap((items, index) => {
      if (index !== edit.piece) return [items];
      if (edit.kind === "remove") return [];
      if (replacement) return replacement;
      if (edit.kind === "swap") return [rebuilt];
      // Keep hand-trimmed boundaries, extending only for a filler assigned to
      // this half when a split landed in an existing removal.
      const filler = edit.kind === "keepFiller" ? piece.removed?.find(f => f.s === edit.at) : undefined;
      return [slicePiece(rebuilt, Math.min(piece.s, filler?.s ?? piece.s),
        Math.max(piece.e, filler?.e ?? piece.e), template.fps)];
    });
    const missingUnchangedSource = async () => {
      if (edit.kind !== "remove") {
        for (const item of groups[edit.piece] ?? []) {
          const clip = item.seg?.clip;
          if (!clip) continue;
          try { await fs.access(path.resolve(root, clip.sound?.file ?? clip.file)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
        }
      }
      for (const [index, items] of savedGroups.entries()) {
        if (index === edit.piece) continue;
        for (const item of items) {
          const clip = item.seg?.clip;
          if (!clip) continue;
          try { await fs.access(path.resolve(root, clip.sound?.file ?? clip.file)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
        }
      }
      return false;
    };
    let offsetFrames = 0;
    assembled.cutList = groups.flatMap((items, index) => items.map(item => {
      const result = { ...item, piece: index, offsetFrames };
      offsetFrames += item.durTimelineFrames;
      return result;
    }));
    assembled.lengthS = offsetFrames / template.fps;
    assembled.reel.cuts = cutPieceGroups(assembled.cutList).map(({ piece: index, items }) => {
      const first = items[0], last = items.at(-1)!;
      const rate = first.clipFpsR.num / first.clipFpsR.den;
      const oldIndex = edit.kind === "remove" && index >= edit.piece ? index + 1
        : edit.kind === "split" && index > edit.piece ? index - 1 : index;
      return { ...fresh.reel.cuts[oldIndex], id: answer.voice[index].id, clipId: first.seg!.clip.id, s: first.inFrames / rate, e: last.outFrames / rate,
        offsetS: first.offsetFrames / template.fps, lengthS: items.reduce((sum, item) => sum + item.durTimelineFrames / template.fps, 0),
        ...(oldIndex === edit.piece ? { beatDeltaS: 0, beatS: null } : {}) };
    });
    if (assembled.reel.music) {
      try { assembled.reel.voiceLUFS = await measureReelVoice(root, assembled.cutList.filter(item => item.seg?.lineIndex !== null), template); }
      catch (error) {
        activity.signal.throwIfAborted();
        if (!await missingUnchangedSource()) throw error;
        assembled.reel.voiceLUFS = null;
      }
      if (assembled.reel.voiceLUFS !== null) assembled.reel.music.gainDb = Math.round((assembled.reel.voiceLUFS - 15 - assembled.reel.music.musicLUFS) * 100) / 100;
      const warning = "The music ends before the voice; the remaining reel is voice only.";
      assembled.reel.warnings = assembled.reel.warnings.filter(w => w !== warning);
      if (assembled.reel.music.durationS - assembled.reel.music.startS < assembled.lengthS) assembled.reel.warnings.push(warning);
    }
    // Saved piece positions disambiguate repeated takes. The model's `over`
    // ids alone would attach every overlay to the first occurrence of a take.
    assembled.reel.broll = overlays.flatMap(({ id, voiceIndex }) => {
      const oldIndex = edit.kind === "remove" && voiceIndex >= edit.piece ? voiceIndex + 1
        : edit.kind === "split" && voiceIndex > edit.piece ? voiceIndex - 1 : voiceIndex;
      const prior = fresh.reel.broll.find(overlay => overlay.voiceIndex === oldIndex && overlay.id === id);
      if (!prior) return [];
      let seg = prior.seg;
      if (replacement && (voiceIndex === edit.piece || (edit.kind === "split" && voiceIndex === edit.piece + 1))) {
        const first = groups[voiceIndex][0], rate = first.clipFpsR.num / first.clipFpsR.den;
        const newStart = first.inFrames / rate;
        const prefix = savedGroups[edit.piece].reduce((sum, item) => {
          const fps = item.clipFpsR.num / item.clipFpsR.den;
          return sum + Math.max(0, Math.min(item.outFrames / fps, newStart) - item.inFrames / fps);
        }, 0);
        const s = seg.s + prefix;
        const e = Math.min(seg.e, seg.s + (piece.lengthS ?? piece.e - piece.s));
        if (s >= e) return [];
        seg = { ...seg, s, e };
      }
      const overlayFps = seg.clip.meta?.fps || template.fps;
      if (Math.floor(seg.e * overlayFps) <= Math.ceil(seg.s * overlayFps)) return [];
      return [{ id, voiceIndex, over: answer.voice[voiceIndex].id, seg }];
    });
    assembled.reel.missing = [...previous.missing];
    const nextVersion = (numbers.at(-1) ?? 0) + 1;  // at(-1) stays: allocates the next snapshot number
    const record: StoredVersion = {
      version: nextVersion, createdAt: new Date().toISOString(), title: previous.title,
      grade: previous.grade, audio: previous.audio, energy: previous.energy, titles: previous.titles, faceMatch: previous.faceMatch, cover: previous.cover, overlays: previous.overlays,
      ...(previous.videoType ? { videoType: previous.videoType } : {}),
      voice: assembled.reel.cuts.map((c) => c.id),
      broll: assembled.reel.broll.map(({ id, over }) => ({ id, over })),
      music: assembled.reel.music ? { file: assembled.reel.music.file, startS: assembled.reel.music.startS, gainDb: assembled.reel.music.gainDb, duckDepthDb: previous.music?.duckDepthDb, duck: previous.music?.duck, fit: previous.music?.fit, followStory: previous.music?.followStory, ...(previous.music?.shape ? { shape: previous.music.shape } : {}) } : null,
      pieces: resolveReelPieces(shoot, template, assembled.cutList, assembled.reel).map((resolved, index) => {
        const oldIndex = edit.kind === "remove" && index >= edit.piece ? index + 1
          : edit.kind === "split" && index > edit.piece ? index - 1 : index;
        if (oldIndex !== edit.piece) return { ...pieces[oldIndex], timelineS: resolved.timelineS, overlay: resolved.overlay };
        if (resolved.kind !== "voice") return resolved;
        const words = pieceWords({ shoot, template, cutList: assembled.cutList, reel: assembled.reel }, index)
          .filter(w => groups[index].some(item => {
            const rate = item.clipFpsR.num / item.clipFpsR.den;
            return w.s >= item.inFrames / rate - 1e-6 && w.e <= item.outFrames / rate + 1e-6;
          })).map(w => w.w.trim()).join(" ");
        return { ...resolved, words: words || resolved.words };
      }), keptFillers,
      templateId: template.id, lengthS: assembled.lengthS, preview: null, why: previous.why,
      warnings: assembled.reel.warnings, missing: [...previous.missing], feedback,
      assembly: { shoot, template, cutList: assembled.cutList, reel: assembled.reel }, previewRev: 0,
    };
    // PRO1: carryClipSound carries only sound, so every clip lost its own look, framing, speed and transform on any trim,
    // removal, split or swap. Each piece keeps the picture settings of the piece it came from; sound (overlaySound
    // included) stays carryClipSound's to decide. Then timing comes from the playback plan, so lengths, positions and the
    // scene ranges carried next are measured with speed back on.
    if (previous.pieceFx) {
      const from = record.pieces!.map((_, index) => edit.kind === "remove" && index >= edit.piece ? index + 1 : edit.kind === "split" && index > edit.piece ? index - 1 : index);
      record.pieceFx = from.map(old => { const fx = previous.pieceFx?.[old]; if (!fx) return null;
        const { muted: _m, gainDb: _g, clean: _c, overlaySound: _o, ...picture } = structuredClone(fx); return Object.keys(picture).length ? picture : null; });
      // A trim keeps every piece in place, so its joins (which retimeMagneticTrim would copy later) shape this timing too.
      if (edit.kind === "trim" && previous.joins && record.joins === undefined) record.joins = structuredClone(previous.joins);
      syncFxMetadata(record);
    }
    carryJoinCraft(previous, record, record.pieces!.map((_, index) => edit.kind === "remove" && index >= edit.piece ? index + 1
      : edit.kind === "split" && index > edit.piece ? index - 1 : index));
    // PRO1: the playback plan's timing (speed and joins included) once everything that shapes it is carried.
    if (previous.pieceFx) syncFxMetadata(record);
    record.pieces = timedPieces(record.assembly, record.pieces);
    if (edit.kind === "trim" && "magnetic" in edit) (await import("./edits-move")).retimeMagneticTrim({...previous,pieces}, record, edit.piece);
    await (await import('./music-arrange')).pinMusicForHandEdit(root,previous,record);
    if (record.overlays?.some(o => o.graphic?.words?.length)) record.overlays = await (await import("./graphics/edit")).retimeGraphicOverlays(record).catch(() => record.overlays);  // GFX1: graphics stay on their words
    record.baseVersion = previous.version; builtFrom.set(record, previous.version);
    try { await renderStoredPreview(root, cutId, record, record.assembly); }
    catch (error) {
      activity.signal.throwIfAborted();
      if (!await missingUnchangedSource()) throw error;
      record.warnings.push("Saved the edit. Sound could not be refreshed because another piece's footage is unavailable. Reconnect it to refresh sound.");
    }
    try { await save(record); }
    catch (error) { if (error instanceof RevisionConflictError || error instanceof WriterBusyError) throw error; throw new Error("Could not save this edit. Check the shoot drive is connected and try again."); }
    // OPEN1: the notice names the version it saved (as finishStoredVersion's does), so the page that made it shows
    // its snapshot instead of treating its own save as another writer's and listing all 569 versions first.
    changed(root, { cutId, version: nextVersion }); stepsChanged(root);
    if(JSON.stringify(previous.pieces?.map(p=>p.clipId))!==JSON.stringify(record.pieces?.map(p=>p.clipId)))setImmediate(()=>{void detachedEditWork(()=>import("./balance").then(m=>m.prepareHandClips(root,cutId,nextVersion))).catch(()=>{});});
    activity.update({ target: { cutId, version: nextVersion } });
    // OPEN1: the page shows the saved step from this snapshot at once (as finishStoredVersion's edits already do),
    // instead of listing all 569 versions first.
    const out = { cutId, version: nextVersion };
    handSnapshots.set(out, publicVersion(record));
    return out;
  }));
}
export async function exportCut(root: string, cutId: string, version: number, editor?: EditorId): Promise<PrecutResult> {
  const { folder, preview, lengthS } = await exportSidekickCut(root, cutId, version, undefined, editor);
  return { folder, preview, lengthS };
}
