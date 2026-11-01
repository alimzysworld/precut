import {withClipTransforms} from '../shared/clip-transform';
import { balancedLook } from "../shared/clip-balance";
import { liveSound, liveVoicePeaks } from "./live-sound";
import { app } from "electron";
import type { SoundTimeline } from "./live-sound-types";
import { activeBackground } from './backgrounds';
import { presentTitles } from './titles/ul1';
import { layoutPictures } from './layouts';
import { anglePictures, angleFxPiece } from './angles';
import { reverseDraftPictures } from './reverse';
import { draftCover } from "./cover";
import { planFx, fxPictures } from "./edits-fx";
import { cutPieceGroups, type CutItem } from "./export";
import { buildTitlesInput, captionSourceForInput } from "./titles";
import { captionSafeArea, type CaptionSource } from "./titles/captions";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { BasicAdjust, Clip, DraftPiece, DraftTimeline, LookPreset, Grade, PieceLook } from "../shared/schema";
import { overlayMedia } from "./overlays";
import { mediaUrl } from "../shared/media";
import { energyBeats, energyFraming, framingPlans, framingReference, type Energy, type EnergyBeat } from "./framing";
import { framingMotion, type MotionAnalysis } from "./motion";
import { estimateAutoBasic, measureBasicHistogram, exposureSpans, livePieceId, normalizePieceLook, gradeForLook, gradeForPiece, isLookPreset, lookIntensity, pieceColour, COLOUR_MEASUREMENT_REVISION, validateMatchRef, validMixer, normalizeMixer, type PieceCorrection, type NeutralBase, type LookGrade } from "./grade";
import { independentPreparation, runActivity, withRenderSlot, currentActivity } from "./activity";
import { normalizeBasic, validBasic } from "./basics";
import { getPreferences } from "./settings";
import { cutFraming, joinFraming, framingRectAt, matchedFraming, type CutFraming } from "./preview";
import { loadDraftVersion, type StoredVersion } from "./sidekick";
import { draftGeometry, unknownDraftSize } from "./draft-geometry";

/** Open-path timings for qa/R8: off unless a harness installs a sink. */
export const phaseSink: { current: ((name: string, ms: number) => void) | null } = { current: null };
async function phase<T>(name: string, work: () => Promise<T> | T): Promise<T> {
  const sink = phaseSink.current;
  if (!sink) return work();
  const started = performance.now();
  try { return await work(); } finally { sink(name, performance.now() - started); }
}

/** Sample the compositor's eased pan/push at each output frame. The player
 * interpolates rects, so endpoint-only keys would change both easing curves. */
export function draftFrame(clip: Clip, inS: number, length: number, startS: number,
  out: { w: number; h: number }, fps: number, energy: Energy, beat?: EnergyBeat, planned?: CutFraming): DraftPiece["frame"] {
  const plan: CutFraming = planned ?? energyFraming(clip, inS, inS + length, out, energy, beat);
  if (!plan.crop) return null;
  const width = clip.meta!.width, height = clip.meta!.height;
  if (plan.rects) return plan.rects.map(r => ({ t: startS + r.t, x: r.x / width, y: r.y / height, w: r.w / width, h: r.h / height }));
  const moving = plan.match ? plan.match.duration > 0 : !!plan.crop.keyframes?.length || plan.push > 0;
  const times = moving ? [...Array.from({ length: Math.ceil(length * fps) }, (_, i) => i / fps), length] : [0, length];
  return times.map(t => {
    const rect = framingRectAt(plan, t)!;
    return { t: startS + t, x: rect.x / width, y: rect.y / height, w: rect.w / width, h: rect.h / height };
  });
}

/** Picture-only assembly, kept separate so source/timeline parity is testable
 * without decoding media. Black gaps have an empty proxy and occupy layer 0. */
export function draftPictures(assembly: StoredVersion["assembly"], energy: Energy = "subtle", faceMatch: import("../shared/schema").CutVersion["faceMatch"] = "ease",
  framing: Pick<StoredVersion, "framing" | "pieceFx" | "transition" | "joins" | "titles" | "layouts" | "angleCuts" | "energy"> = {}, motions = new Map<string, MotionAnalysis>(), referenceOut?: { w: number; h: number }): DraftPiece[] {
  assembly = draftGeometry(assembly);
  const { cutList: cuts, template, reel } = assembly, fps = template.fps;
  if (!cuts.length || ![fps, template.width, template.height].every(n => Number.isFinite(n) && n > 0)) throw new Error("Invalid draft frame shape or cut list.");
  const reference = referenceOut && [referenceOut.w, referenceOut.h].every(n => Number.isFinite(n) && n > 0) ? referenceOut : framingReference(template);
  // A scene's crop must not change when a proxy player is larger than export.
  const out = framing.layouts?.some(Boolean) ? reference : { w: 960, h: Math.round(960 * template.height / template.width / 2) * 2 };
  const beats = energyBeats(cuts, fps), plans = joinFraming(cuts, fps, out, energy, { ...framing, faceMatch }, motions, reference);
  const pieces: DraftPiece[] = [];
  const add = (clip: Clip | null, inS: number, length: number, startS: number, layer: 0 | 1, beat?: EnergyBeat, planned?: CutFraming, piece?: number) => {
    if (!(length > 0) || ![inS, length, startS].every(Number.isFinite)) throw new Error("Invalid draft piece span.");
    pieces.push({ startS, endS: startS + length, layer, clipId: clip?.id ?? "", inS,
      proxy: clip ? mediaUrl(assembly.shoot.root, "proxies", clip.proxy ?? `${clip.id}.mp4`) : "",
      frame: clip ? draftFrame(clip, inS, length, startS, out, fps, energy, beat, planned) : null,
      lut: "", piece });
  };
  let at = 0;
  cuts.forEach((cut, i) => {
    const length = cut.durTimelineFrames / fps;
    add(cut.seg?.clip ?? null, cut.seg ? cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den) : 0, length, at, 0, beats[i], plans[i], cut.piece ?? i);
    at += length;
  });
  for (const overlay of reel.broll) {
    const piece = cuts.filter((c, index) => (c.piece ?? index) === overlay.voiceIndex);
    if (!piece.length) throw new Error(`Missing picture piece for overlay ${overlay.id}.`);
    const sourceFps = overlay.seg.clip.meta?.fps || fps;
    const start = Math.ceil(overlay.seg.s * sourceFps) / sourceFps;
    const length = Math.min(Math.floor(overlay.seg.e * sourceFps) / sourceFps - start, piece.reduce((n, c) => n + c.durTimelineFrames / fps, 0));
    const overlayCut: CutItem = { ...piece[0], seg: overlay.seg, inFrames: start * sourceFps,
      clipFpsR: { num: sourceFps, den: 1 }, durTimelineFrames: length * fps };
    const plan = framingPlans({ plan: cutFraming, at: framingRectAt }, [overlayCut], fps, out, energy, "off", framing, motions, reference)[0];
    add(overlay.seg.clip, start, length, piece[0].offsetFrames / fps, 1, undefined, plan, overlay.voiceIndex);
  }
  const pictures = layoutPictures(anglePictures(fxPictures(pieces, cuts, fps, planFx(cuts, fps, { ...framing, faceMatch, energy }), matchedFraming(cuts, plans)), { ...framing, energy, assembly }, motions, referenceOut), { layouts: framing.layouts, titles: framing.titles, pieceFx: framing.pieceFx, assembly });
  const unknown = new Set([...cuts.flatMap(c => c.seg ? [c.seg.clip] : []), ...reel.broll.map(o => o.seg.clip)]
    .filter(unknownDraftSize).map(c => c.id));
  // Empty frame keys request a centre crop from the decoder's real aspect.
  return withClipTransforms(pictures,framing.pieceFx).map(p => unknown.has(p.clipId) ? { ...p, frame: [] } : p);
}

type ColourPiece = { base: NeutralBase | null; exposure: PieceCorrection };
// Saved cut/index and source fingerprints identify measurements; look changes reuse
// both the refreshed assembly and per-span measurements, never decode again.
// partial: some pieces are not measured yet (identity, or an earlier save's value for the same span) and will change.
type ColourContext = { record: StoredVersion; pieces: DraftPiece[]; colours: ColourPiece[]; matched: ColourPiece[]; sources: string[]; fingerprint: string; partial?: boolean };
// Shared measurements must not inherit a superseded playback worker's signal.
const contexts = new Map<string, Promise<ColourContext>>();
const readyContexts = new Map<string, ColourContext>();
const liveContextJobs = new Set<string>();
const colourRetryAfter = new Map<string, number>();
// A context includes immutable version decisions and source fingerprints. Never
// share results across a changed index/source, even at the same version number.
const colourMeasurements = new Map<string, Promise<ColourPiece>>();
const pieceLutResults = new WeakMap<ColourContext, Map<string, string[]>>();
// LK1: the latest measured colour of each edit (any version or save), for answers that cannot wait for a measurement.
const latestColours = new Map<string, ColourContext>();
const latestKey = (root: string, cutId: string, matchRef?: number | null) => JSON.stringify([root, cutId, matchRef === undefined ? "saved" : matchRef]);
const unmeasuredColour: ColourPiece = { base: null, exposure: { stops: 0, rolloff: .63 } };
/** LK1: colour known now, never waiting or measuring. A piece measured in an earlier save of this edit keeps that
 * measurement (same clip and span); anything else is identity until its measurement lands. */
function knownColours(root: string, cutId: string, matchRef: number | null | undefined, record: StoredVersion,
  pieces = draftPictures(record.assembly, record.energy ?? "subtle", record.faceMatch, record), stored: (ColourPiece | undefined)[][] = []): ColourContext {
  const last = latestColours.get(latestKey(root, cutId, matchRef));
  const span = (p: DraftPiece) => JSON.stringify([p.clipId, p.inS, p.endS - p.startS]);
  const measured = new Map(last?.pieces.map((p, i) => [span(p), i]));
  // PS4: a piece measured by content (this save or any other) wins; then the same span from the last save; then identity.
  const pick = (list: ColourPiece[], which: 0 | 1) => pieces.map((p, i) => stored[i]?.[which] ?? list[measured.get(span(p)) ?? -1] ?? unmeasuredColour);
  return { record, pieces, colours: pick(last?.colours ?? [], 0), matched: pick(last?.matched ?? [], 1), sources: [], fingerprint: "", partial: true };
}
async function sourceFingerprint(files: string[]): Promise<string> {
  return JSON.stringify(await Promise.all(files.map(async file => {
    try { const stat = await fs.stat(file); return [file, stat.size, stat.mtimeMs, stat.ctimeMs]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [file, null]; throw error; }
  })));
}
// PS4: colour is keyed by what is in each piece (the clip, its span and the measuring settings), never by the edit's
// file, version or save time. A look, grain, music or lower-third save measures nothing; a trim measures the changed
// piece. Each finished piece is kept in memory and on disk, so a cancel or a restart keeps what was measured (R8b).
const COLOUR_REVISION = `piece-colour-1/${COLOUR_MEASUREMENT_REVISION}`;
type PieceRequest = { key: string; clip: Clip; options: { root: string; s: number; e: number; neighbours: ReturnType<typeof exposureSpans> }; matching: boolean; reference: number | null };
type ColourPlan = { record: StoredVersion; pieces: DraftPiece[]; cache: string; sources: string[]; fingerprint: string; requests: [PieceRequest | null, PieceRequest | null][] };
const colourResults = new Map<string, ColourPiece>();
const keepColour = (key: string, value: ColourPiece) => {
  colourResults.delete(key); colourResults.set(key, value);
  if (colourResults.size > 4096) colourResults.delete(colourResults.keys().next().value!);
};
const finiteList = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
function validColour(value: unknown): value is ColourPiece {
  const v = value as ColourPiece | null;
  if (!v || typeof v !== "object" || !v.exposure || !Number.isFinite(v.exposure.stops) || !Number.isFinite(v.exposure.rolloff)) return false;
  if (v.exposure.gains !== undefined && !finiteList(v.exposure.gains, 3)) return false;
  return v.base === null || (typeof v.base === "object" && finiteList(v.base.gains, 3) && finiteList(v.base.neutralRatios, 3) &&
    [v.base.vibrance, v.base.mid, v.base.black, v.base.confidence, v.base.measuredMid, v.base.measuredBlack].every(Number.isFinite));
}
async function colourPlan(root: string, record: StoredVersion, matchRef?: number | null): Promise<ColourPlan> {
  const assembly = record.assembly;
  const pieces = draftPictures(assembly, record.energy ?? "subtle", record.faceMatch, record);
  const reference = matchRef === undefined ? (record.grade?.matchClips ? record.grade.matchRef ?? null : null) : matchRef;
  validateMatchRef(reference);
  if (reference != null && (!pieces[reference]?.clipId)) throw new Error("Choose a reference clip in this edit.");
  const cache = path.join(root, ".sidething", "finish-cache");
  const neighbours = exposureSpans(assembly.cutList, assembly.reel.broll, assembly.template.fps);
  const clips = new Map(assembly.shoot.clips.map(c => [c.id, c]));
  const used = [...new Set([...pieces.map(p => p.clipId), ...neighbours.map(n => n.clipId)])].filter(id => clips.has(id));
  const sources = [...new Set(used.map(id => path.resolve(root, clips.get(id)!.file)))];
  const fingerprint = await sourceFingerprint(sources);
  const stats = new Map((JSON.parse(fingerprint) as [string, number, number, number][]).map(([file, size, mtime]) => [file, [size, mtime]]));
  // What a clip contributes to its colour: its file and its picture data, never its transcript or judgement. The
  // camera name is left out: measuring fills it in from the file itself, which the file's size and time already cover.
  const content = (id: string) => { const clip = clips.get(id); return clip ? [clip.id, clip.file, clip.meta && { ...clip.meta, camera: undefined }, clip.subject ?? null, stats.get(path.resolve(root, clip.file)) ?? null] : null; };
  // The unmatched base follows the edit's dominant camera file (grade.ts matchCutBase), not every neighbour.
  const totals = new Map<string, number>();
  for (const span of neighbours) if (Number.isFinite(span.s) && Number.isFinite(span.e) && span.e > span.s) totals.set(span.clipId, (totals.get(span.clipId) ?? 0) + span.e - span.s);
  const dominant = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const everyone = [...new Set(neighbours.map(n => n.clipId))].sort().map(content);
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const requests = pieces.map((piece): [PieceRequest | null, PieceRequest | null] => {
    const clip = clips.get(piece.clipId);
    if (!clip) return [null, null];
    const options = { root, s: piece.inS, e: piece.inS + piece.endS - piece.startS, neighbours };
    const own = [content(clip.id), options.s, options.e];
    return [
      { key: hash([COLOUR_REVISION, "piece", own, dominant && dominant !== clip.id ? content(dominant) : null]), clip, options, matching: false, reference },
      // Matching compares every piece with the others (or the chosen reference), so its key holds the whole set.
      { key: hash([COLOUR_REVISION, "matched", own, reference, neighbours, everyone]), clip, options, matching: true, reference },
    ];
  });
  return { record, pieces, cache, sources, fingerprint, requests };
}
/** A measurement already made for this content, from memory or the shoot's cache. Never measures. */
async function storedColour(cache: string, request: PieceRequest | null): Promise<ColourPiece | undefined> {
  if (!request) return unmeasuredColour;
  const memory = colourResults.get(request.key);
  if (memory) return memory;
  try {
    const value = JSON.parse(await fs.readFile(path.join(cache, `piece-colour-${request.key}.json`), "utf8"));
    if (validColour(value)) { keepColour(request.key, value); return value; }
  } catch { /* not measured yet */ }
  return undefined;
}
function measureColour(activity: Parameters<typeof withRenderSlot>[0], cache: string, request: PieceRequest): Promise<ColourPiece> {
  let work = colourMeasurements.get(request.key);
  if (!work) {
    // R8b: measuring is optional work. It always yields to opening and playing an edit (identity colour until it lands).
    work = withRenderSlot(activity, async () => {
      const value = await pieceColour(request.clip, cache, request.options, request.matching, request.reference);
      keepColour(request.key, value);
      const file = path.join(cache, `piece-colour-${request.key}.json`), temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try { await fs.mkdir(cache, { recursive: true }); await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file); }
      catch { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return value;
    }, "background");
    colourMeasurements.set(request.key, work);
    if (colourMeasurements.size > 512) colourMeasurements.delete(colourMeasurements.keys().next().value!);
    const settled = work;
    settled.then(() => { if (colourMeasurements.get(request.key) === settled) colourMeasurements.delete(request.key); },
      () => { if (colourMeasurements.get(request.key) === settled) colourMeasurements.delete(request.key); });
  }
  return work;
}
function plannedContext(plan: ColourPlan, values: ColourPiece[][]): ColourContext {
  return { record: plan.record, pieces: plan.pieces, colours: values.map(v => v[0]), matched: values.map(v => v[1]), sources: plan.sources, fingerprint: plan.fingerprint };
}
const storedValues = (plan: ColourPlan) => Promise.all(plan.requests.map(pair => Promise.all(pair.map(r => storedColour(plan.cache, r)))));
const complete = (values: (ColourPiece | undefined)[][]): values is ColourPiece[][] => values.every(pair => pair.every(Boolean));
function rememberReady(root: string, cutId: string, matchRef: number | null | undefined, key: string, ready: ColourContext): ColourContext {
  readyContexts.set(key, ready);
  if (readyContexts.size > 8) readyContexts.delete(readyContexts.keys().next().value!);
  latestColours.delete(latestKey(root, cutId, matchRef)); latestColours.set(latestKey(root, cutId, matchRef), ready);
  if (latestColours.size > 8) latestColours.delete(latestColours.keys().next().value!);
  return ready;
}
/** Measure what is missing. Only now is there something to do, so only now is there an activity to show. */
function measuredContext(key: string, cutId: string, version: number, root: string, plan: ColourPlan): Promise<ColourContext> {
  let context = contexts.get(key);
  if (!context) {
    context = independentPreparation(() => runActivity({ kind: "looks", root, target: { cutId, version }, label: "Measuring clip colour", cancelable: true }, async activity => {
      await fs.mkdir(plan.cache, { recursive: true });
      const values: ColourPiece[][] = [];
      for (const pair of plan.requests) {
        currentActivity()?.signal.throwIfAborted();
        const measured: ColourPiece[] = [];
        for (const request of pair) measured.push(await storedColour(plan.cache, request) ?? await measureColour(activity, plan.cache, request!));
        values.push(measured);
        activity.progress(values.length / plan.requests.length * 100);
      }
      return plannedContext(plan, values);
    }, { renderLane: "background" }));
    contexts.set(key, context);
    if (contexts.size > 8) contexts.delete(contexts.keys().next().value!);
    const settled = context;
    settled.catch(() => { if (contexts.get(key) === settled) contexts.delete(key); });
  }
  return context;
}
async function colourContext(root: string, cutId: string, version: number, matchRef?: number | null, live: boolean | "known" = false, preloaded?: StoredVersion): Promise<ColourContext> {
  // Legacy storage may migrate on read. Fingerprint the resulting file so the
  // first measured result can be reused by the immediately following player.
  // The live open path already holds the record: reading and freshening it again costs a full parse.
  const loadedRecord = preloaded ?? await loadDraftVersion(root, cutId, version);
  const files = [path.join(root, ".sidething", "sidekick", "cuts", `${cutId}.json`), path.join(root, ".sidething", "index.json")];
  const key = JSON.stringify([root, cutId, version, matchRef === undefined ? "saved" : matchRef, ...await Promise.all(files.map(file => fs.stat(file).then(stat => [stat.size, stat.mtimeMs, stat.ctimeMs]).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error;
  })))]);
  if (live) {
    const ready = readyContexts.get(key);
    if (ready && ready.fingerprint === await sourceFingerprint(ready.sources)) return ready;
    readyContexts.delete(key);
    // Cold measurements never hold up the first picture. Refresh on completion.
    const record = loadedRecord;
    record.assembly.shoot = { ...record.assembly.shoot, root };
    const plan = await colourPlan(root, record, matchRef).catch(() => null);
    const stored = plan ? await storedValues(plan) : [];
    // PS4: a save that changed no piece (look, grain, music, lower third) finds every piece measured: answer at once.
    if (plan && complete(stored)) return rememberReady(root, cutId, matchRef, key, plannedContext(plan, stored));
    // "known" (a look hover) only reads what is measured: measuring starts with the edit's open, never on hover.
    if (live !== "known" && !liveContextJobs.has(key) && Date.now() >= (colourRetryAfter.get(key) ?? 0)) {
      liveContextJobs.add(key);
      const work = new Promise<void>(resolve => setImmediate(resolve)).then(() => plan
        ? measuredContext(key, cutId, version, root, plan).then(ready => rememberReady(root, cutId, matchRef, key, ready))
        : independentPreparation(() => colourContext(root, cutId, version, matchRef)));
      void work.then(() => { colourRetryAfter.delete(key); return import('./sidekick').then(m => m.changed(root)); }, error => {
        // R8b: a cancel is not a failure. Finished pieces stay cached, so the next open picks up where this stopped.
        if (error instanceof Error && error.name === 'AbortError') return;
        colourRetryAfter.set(key, Date.now() + 30_000); console.warn('Could not measure clip colour:', error);
      }).finally(() => liveContextJobs.delete(key));
    }
    // Pieces measured already show their colour now (a trim keeps every other piece's); the rest are identity until measured.
    return knownColours(root, cutId, matchRef, record, plan?.pieces, stored);
  }
  let context = contexts.get(key);
  if (context) {
    const cached = await context;
    if (cached.fingerprint !== await sourceFingerprint(cached.sources)) {
      contexts.delete(key); return colourContext(root, cutId, version, matchRef);
    }
  }
  const ready = context ? await context : await independentPreparation(async () => {
    const record = loadedRecord;
    record.assembly.shoot = { ...record.assembly.shoot, root };
    const plan = await colourPlan(root, record, matchRef);
    const stored = await storedValues(plan);
    return complete(stored) ? plannedContext(plan, stored) : measuredContext(key, cutId, version, root, plan);
  });
  return rememberReady(root, cutId, matchRef, key, ready);
}
async function savedGrade(record: StoredVersion): Promise<LookGrade> {
  return record.grade ?? gradeForLook("rec709", (await getPreferences()).look);
}
/** `now` (LK1, a look hover or pick): answer with the colour known now instead of waiting for a measurement. */
export async function pieceLuts(root: string, cutId: string, version: number, look: { preset: LookPreset; intensity: number; basic?: BasicAdjust; matchClips?: boolean; matchRef?: number | null; mixer?: Grade["mixer"] | null; previewPiece?: number; previewLook?: PieceLook | null; now?: boolean }): Promise<string[]> {
  if (!isLookPreset(look.preset) || !Number.isFinite(look.intensity) || look.intensity < 0 || look.intensity > 1) throw new Error("Choose a gallery look and intensity from 0 to 1.");
  if (look.basic !== undefined && !validBasic(look.basic)) throw new Error("Choose valid Basic adjustments.");
  if (look.matchClips !== undefined && typeof look.matchClips !== "boolean") throw new Error("Choose whether to match clips.");
  validateMatchRef(look.matchRef);
  if (look.mixer != null && !validMixer(look.mixer)) throw new Error("Choose valid colour mixer adjustments.");
  root = path.resolve(root);
  const known = look.now === true ? "known" as const : false;
  const context = await colourContext(root, cutId, version, undefined, known);
  const { record, colours, matched, pieces } = context;
  if (look.previewPiece !== undefined && (!Number.isInteger(look.previewPiece) || !pieces.some(p => p.piece === look.previewPiece))) throw new Error("Choose a clip in this edit.");
  const grade = look.previewPiece === undefined ? { ...await savedGrade(record), preset: look.preset, intensity: look.intensity,
    ...(look.basic !== undefined ? { basic: normalizeBasic(look.basic) } : {}),
    ...(look.matchClips !== undefined ? { matchClips: look.matchClips } : {}),
    ...(look.matchRef !== undefined ? { matchRef: look.matchRef } : {}),
    ...(look.mixer !== undefined ? { mixer: normalizeMixer(look.mixer) } : {}) } : await savedGrade(record);
  if (grade.matchRef != null && !pieces[grade.matchRef]?.clipId) throw new Error("Choose a reference clip in this edit.");
  const pieceLooks = pieces.map(p => balancedLook(record,p.clipId,angleFxPiece(record,p.clipId,p.piece ?? 0),look.previewPiece !== undefined && p.piece === look.previewPiece ? normalizePieceLook(look.previewLook) : undefined));
  const key = JSON.stringify([grade, pieceLooks]);
  const results = pieceLutResults.get(context) ?? new Map<string, string[]>();
  pieceLutResults.set(context, results);
  const cached = results.get(key);
  if (cached) { results.delete(key); results.set(key, cached); return cached.slice(); }
  const active = grade.matchClips && (grade.matchRef ?? null) !== (record.grade?.matchClips ? record.grade.matchRef ?? null : null)
    ? (await colourContext(root, cutId, version, grade.matchRef ?? null, known)).matched : matched;
  // V15: register immutable recipes only. Cube evaluation happens in the colour worker on first use.
  const ids: string[] = [];
  let slice = performance.now();
  for (const [i, c] of (grade.matchClips ? active : colours).entries()) {
    if (performance.now() - slice > 8) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now(); }
    ids.push(livePieceId(c.base, gradeForPiece(grade, pieceLooks[i]), c.exposure, grade, pieceLooks[i]));
  }
  results.set(key, ids);
  if (results.size > 160) results.delete(results.keys().next().value!);
  return ids.slice();
}
/** Explicit Auto action: measurements only, never persists or calls a model. */
export async function autoBasic(root: string, cutId: string, version: number): Promise<BasicAdjust> {
  root = path.resolve(root);
  const { record, pieces, colours } = await colourContext(root, cutId, version);
  const clips = new Map([...record.assembly.cutList.flatMap(c => c.seg ? [c.seg.clip] : []),
    ...record.assembly.reel.broll.map(o => o.seg.clip)].map(c => [c.id, c]));
  const cache = path.join(root, ".sidething", "finish-cache");
  const measurements = [];
  for (const [i, piece] of pieces.entries()) {
    const clip = clips.get(piece.clipId);
    if (!clip) continue;
    measurements.push(await measureBasicHistogram(clip, cache, { root, s: piece.inS,
      e: piece.inS + piece.endS - piece.startS }, colours[i].base, colours[i].exposure));
  }
  return estimateAutoBasic(measurements);
}
/** A superseded cache owner can be cancelled while the current caller is
 * awaiting it. Retry that immutable request after the failed cache is evicted. */
// OPEN1: a save that lands asks for the same plan from several places at once (the lane, the panel, the
// preparation after a save), and each built it from scratch: on his 569-version edit, two or three 2 to 5 s
// loads of one immutable version. Requests from the page (no activity of their own to cancel) share one build.
const building = new Map<string, Promise<SoundTimeline & { captionSource: CaptionSource }>>();
export function draftTimeline(root: string, cutId: string, version: number): Promise<SoundTimeline & { captionSource: CaptionSource }> {
  if (currentActivity()) return draftTimelineOnce(root, cutId, version);
  const key = JSON.stringify([path.resolve(root), cutId, version]);
  let work = building.get(key);
  if (!work) {
    const started = draftTimelineOnce(root, cutId, version);
    building.set(key, work = started);
    void started.finally(() => { if (building.get(key) === started) building.delete(key); }).catch(() => {});
  }
  return work;
}
async function draftTimelineOnce(root: string, cutId: string, version: number): Promise<SoundTimeline & { captionSource: CaptionSource }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await buildDraftTimeline(root, cutId, version); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
      if (currentActivity()?.signal.aborted) break;
    }
  }
  throw new Error("Playback preparation was interrupted. Open this edit again.");
}
/** TRK1b: the version's overlays and titles, the pinned ones with their keys through these pictures, and the tracks the
 * pins read (a missing one tracks again in the background; its item draws at its pick placement until then). */
async function pinned<O extends { s: number; e: number; pin?: import('../shared/pin-keys').PinChoice }>(root: string, record: StoredVersion, pieces: DraftPiece[], frame: { width: number; height: number; fps: number }, overlays: O[], titles: DraftTimeline['titles']) {
  const items = [...record.overlays ?? [], ...record.titles?.cues ?? []].filter(item => item.pin);
  if (!items.length) return { overlays, titles };
  const pin = await import('./tracking/pin'), pinTracks = await pin.pinTracks(root, items, record.assembly.shoot.clips, false).catch(() => ({}));
  return { overlays: pin.withPinKeys(overlays, pieces, pinTracks, frame), titles: titles && { ...titles, cues: pin.withPinKeys(titles.cues, pieces, pinTracks, frame) }, pinTracks };
}
async function buildDraftTimeline(root: string, cutId: string, version: number): Promise<SoundTimeline & { captionSource: CaptionSource }> {
  const began = performance.now();
  root = path.resolve(root);
  const stored = await loadDraftVersion(root, cutId, version);
  stored.assembly = draftGeometry(stored.assembly);
  const { prioritizePreviews } = await import("./proxies");
  const needed = [...new Set([...stored.assembly.cutList.flatMap(c => c.seg ? [c.seg.clip.id] : []), ...stored.assembly.reel.broll.map(b => b.seg.clip.id), ...(stored.angleCuts ?? []).map(a => a.clipId)])];
  const visibleIds = [...(stored.pieces ?? [])].sort((a, b) => a.timelineS - b.timelineS).flatMap(p => [p.clipId, ...(p.overlay ? [p.overlay.clipId] : [])]);
  prioritizePreviews(root, [...new Set(visibleIds.length ? visibleIds : stored.assembly.cutList.flatMap(c => c.seg ? [c.seg.clip.id] : []))]);
  if (stored.assembly.shoot.clips.some(c => needed.includes(c.id) && !c.proxy)) void import("./jobs").then(m => m.requestPreviews(root, visibleIds.length ? visibleIds : needed)).catch(error => console.error("[draft] previews:", error));
  phaseSink.current?.("loadVersion", performance.now() - began);
  if (!stored.assembly.cutList.length) return { captionSource: { words: [], faces: [], safeArea: captionSafeArea((await getPreferences()).captions.safeArea) }, durationS: 0, width: stored.assembly.template.width, height: stored.assembly.template.height, fps: stored.assembly.template.fps, pieces: [], sound: null, voice: null, look: null, titles: stored.titles ?? null, overlays: [] };
  const colourState = await phase("colourContext", () => colourContext(root, cutId, version, undefined, true, stored));
  const { record, colours, matched } = colourState;
  const { template, cutList, reel } = record.assembly;
  // Everything below that does not feed the pictures starts now and overlaps with
  // them: the saved grade, preferences and the live sound plan.
  // A failure of one of these reaches the awaiting line; the early copies stay quiet.
  const fx = planFx(cutList, template.fps, record), durationS = fx.durationS;
  const gradeWork = phase("savedGrade", () => savedGrade(record));
  const preferencesWork = phase("preferences", () => getPreferences());
  const soundWork = phase("liveSound", () => liveSound(root, record, fx));
  for (const work of [gradeWork, preferencesWork, soundWork]) work.catch(() => {});
  const grade = await gradeWork;
  const activeColours = grade.matchClips ? matched : colours;
  // A newly completed shake receipt updates framing without repeating colour
  // measurements or invalidating a saved version's immutable edit decisions.
  const preferences = await preferencesWork;
  const motions = await phase("framingMotion", () => framingMotion(root, [...cutList, ...reel.broll.map(o => ({ piece: o.voiceIndex, seg: o.seg }))], record));
  // TRK2: the locked clips' tracks into memory before the pictures are framed (a missing one tracks again in the
  // background; its clip plays as framed until the timeline is read again).
  if (record.pieceFx?.some(f => f?.lock)) await (await import('./tracking/lock')).loadLockTracks(root, record.pieceFx, record.assembly.shoot.clips, false).catch(error => console.error('[lock] tracks:', error));
  const frames = await phase("draftPictures", () => draftPictures(record.assembly, record.energy ?? "subtle", record.faceMatch, record, motions, framingReference(template, preferences.output.height)));
  const unmeasured: ColourPiece = { base: null, exposure: { stops: 0, rolloff: .63 } };
  let pieces: DraftPiece[] = frames.map((piece, i) => {
    const lookPiece = angleFxPiece(record,piece.clipId,piece.piece ?? 0), liveLook = balancedLook(record,piece.clipId,lookPiece);
    return { ...piece, lookPiece, liveLook,
      lut: livePieceId((activeColours[i] ?? unmeasured).base, gradeForPiece(grade,liveLook), (activeColours[i] ?? unmeasured).exposure, grade, liveLook) };
  });
  const backgroundClips = new Map(record.assembly.shoot.clips.map(c => [c.id,c]));
  if (record.pieceFx?.some(p => activeBackground(p?.background))) pieces = await phase("backgrounds", async () => (await import('./backgrounds')).backgroundPictures(root, backgroundClips, pieces, record.pieceFx, true));
  // Playback never requests a mixed master. Export/editor WAVs retain their chain.
  const sound: string | null = null, loudness = null;
  if (fx.items.some(item => item.reverse)) {
    let forwards = draftPictures(record.assembly, record.energy ?? "subtle", record.faceMatch,
      { ...record, pieceFx: record.pieceFx?.map(p => p ? { ...p, reverse: false } : p) }, motions, framingReference(template, preferences.output.height));
    const reverseCuts = [...cutList];
    const reverseFx = { ...fx, items: [...fx.items] };
    if (record.pieceFx?.some(p => activeBackground(p?.background))) {
      forwards = await (await import('./backgrounds')).backgroundPictures(root, backgroundClips, forwards, record.pieceFx, true);
      for (const [i, cut] of reverseCuts.entries()) if (cut.seg && activeBackground(record.pieceFx?.[cut.piece ?? i]?.background) && pieces[i]?.proxy.includes('/background-')) {
        const offset = cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den);
        reverseFx.items[i] = { ...fx.items[i], timeMap: fx.items[i].timeMap.map(k => ({ ...k, s: k.s - offset })) };
        reverseCuts[i] = { ...cut, seg: { ...cut.seg, clip: { ...cut.seg.clip, proxy: decodeURIComponent(new URL(pieces[i].proxy).pathname.split('/').at(-1)!) } } };
      }
    }
    // A missing ordinary preview is already represented by its still. Derived
    // reverse preparation starts when requestPreviews refreshes this draft.
    reverseFx.items = reverseFx.items.map((item, i) => reverseCuts[i]?.seg?.clip.proxy ? item : { ...item, reverse: false });
    pieces = await phase("reverse", () => reverseDraftPictures(root, cutId, version, reverseCuts, reverseFx, template.fps, pieces, forwards));
  }
  // Older immutable versions can contain only the assembly. Derive measured
  // caption spans without requiring a write/migration just to play their LUTs.
  const captionVersion = { ...record, lengthS: durationS, pieces: record.pieces?.length ? record.pieces : cutPieceGroups(cutList).flatMap(({ piece, items }) => {
    const first = items[0], last = items.at(-1)!;
    if (!first.seg) return [];
    const sourceFps = first.clipFpsR.num / first.clipFpsR.den;
    return [{ id: record.voice?.[piece] ?? `piece-${piece}`, kind: first.seg.lineIndex === null ? "broll" as const : "voice" as const,
      clipId: first.seg.clip.id, s: first.inFrames / sourceFps, e: last.outFrames / sourceFps,
      timelineS: first.offsetFrames / template.fps, lengthS: items.reduce((n, c) => n + c.durTimelineFrames / template.fps, 0),
      overlay: null, beatSnapS: 0 }];
  }) };
  const captionSource: CaptionSource = await phase("captions", () => captionVersion.pieces.length && durationS > 0
    ? captionSourceForInput(buildTitlesInput(record.assembly.shoot, captionVersion, template, cutList, preferences.captions.safeArea, preferences.output.height))
    : { words: [], faces: [], safeArea: captionSafeArea(preferences.captions.safeArea) });
  if (record.captionLanguage && (record.titles as import('./titles/captions').CaptionTrack | undefined)?.captionSource) captionSource.words = (record.titles as import('./titles/captions').CaptionTrack).captionSource!.words;
  // 0.7.1: captions saved before they moved with the voice heal on open, in one new version (never by a crash).
  else void import("./caption-realign").then(m => m.realignOnOpen(root, cutId, version, record, captionSource.words as never)).catch(() => {});
  // PS4: the cover is the stage's own picture at the cover frame, so it is planned from the finished pieces (cheap: a
  // key and a file check). A missing one is made later from the proxy, never on this path.
  const coverWork = phase("cover", () => draftCover(root, cutId, record, { pieces, width: template.width, height: template.height }, !colourState.partial));
  coverWork.catch(() => {});
  const livePlan = await soundWork;
  const musicGrid = await (await import('./music-timeline')).timelineMusic(root,record,fx,true).catch(() => undefined);
  if(record.autoLayouts?.enabled)void import('./auto-layouts').then(m=>m.observeLayoutInputs(root,cutId,record.version,musicGrid?.beats??[],m.layoutSourceKey(record)));
  const musicTrimBounds: NonNullable<DraftTimeline['musicTrimBounds']> = {};
  const { cutMusicBounds } = await import('./cut-to-music');
  for (const [i,item] of cutList.entries()) {
    try { musicTrimBounds[item.piece ?? i] = cutMusicBounds(item,cutList[i+1]); } catch { /* Unmeasured footage cannot attract a musical snap. */ }
  }
  // Legacy beat caches remain useful while the richer local grid is measured.
  let musicBeatsS: number[] = [];
  if (record.music && !record.music.fit && !record.music.followStory && !musicGrid) {
    try {
      const cache = JSON.parse(await fs.readFile(path.join(app.getPath("userData"),"music-cache.json"),"utf8"));
      const file = path.resolve(root,record.music.file), stat = await fs.stat(file,{bigint:true});
      const entry = Object.entries(cache.entries ?? {}).find(([key]) => { const [source,size,mtime] = JSON.parse(key); return source===file && BigInt(size)===stat.size && Math.abs(Number(mtime)-Number(stat.mtimeNs))<1e6; })?.[1] as {beats?:number[]} | undefined;
      musicBeatsS = (entry?.beats ?? []).map(t=>t-record.music!.startS).filter(t=>Number.isFinite(t) && t>=0 && t<=durationS);
    } catch { /* No measured beats yet. Cuts and the playhead still snap. */ }
  }
  return { musicGrid, musicTrimBounds, voiceover: record.voiceover?.lines, liveSound: livePlan, captionSource, durationS, fps: template.fps, musicBeatsS: musicGrid?.beats ?? musicBeatsS, voice:{url:null,peaks:liveVoicePeaks(livePlan)}, loudness, joins: fx.joins,
    ...(record.layouts?.some(l=>l?.kind==='scene')?{layoutClock:fx.items.map((item,i)=>({clipId:cutList[i].seg?.clip.id??'',startS:item.startS,endS:item.endS,inS:item.timeMap[0].s,timeMap:item.timeMap}))}:{}),
    width: template.width, height: template.height, pieces,
    sound,
    look: { preset: grade.preset ?? "clean", intensity: lookIntensity(grade.intensity) },
    ...(record.pieceFx?.some(f => f?.lock) ? { locks: (await import('./tracking/lock')).lockSummaries(record, planFx(cutList, template.fps, record), pieces) } : {}),
    ...await pinned(root, record, pieces, { width: template.width, height: template.height, fps: template.fps }, overlayMedia(root, record.overlays), record.titles || record.bleeps?.length || record.lowerThirds?.length || record.layouts?.some(l => l?.kind === 'title') ? presentTitles(record, cutList, template.fps, captionSource) : record.titles ?? null), cover: await coverWork };
}

