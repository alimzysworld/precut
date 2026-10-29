import { filmedAt, filmedTime } from "./filmed-time";
import { SHOT_ORDER_INSTRUCTION } from "./shot-order";
import { musicStems, pieceSoundSettings, STEM_NAMES } from './stem-mix';
import { stemDuckKeys } from '../shared/music-duck';
import { DEFAULT_AUDIO_FINISH, prepareVoicePiece } from './audio';
import { cutMusicKeys } from './music-duck';
import { attachedClipSounds } from './clip-sound';
import { duckGainAt } from '../shared/music-duck';
import { footageStarred } from "./footage-stars";
import { sourceAudioInput } from './source-audio';
import { keptBeatsFor, keptBeatPacket, narratedKeptBeats, restoreKeptBeats } from './kept-beats';
import { retimeScript } from './voiceover-retime';
// MB1: "Make it better". Watch a version locally (words, pacing, sound, captions,
// joins and a small contact sheet), ask the person's engine once for concrete issues
// with fixes made of existing edit operations, apply them as ONE batch version, then
// re-watch and keep only fixes that measurably landed. At most two rounds, one engine
// call each; the person's own edits are never undone.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { app } from "electron";
import type { CutEdit, CutVersion, JoinChoice, SfxItem, TransitionKind, TransitionSound } from "../shared/schema";
import { runActivity, type ActivityHandle } from "./activity";
import { runModel, parseModelJson } from "./ai";
import { SOUND_LANES, laneDb, laneMuted } from '../shared/lane-levels';
import { getEngine, getPreferences } from "./settings";
import { listSkills } from "./skills";
import { planFx, fxWords, mapTime, mapSource, type FxPlan } from "./edits-fx";
import type { CutItem } from "./export";
import { resolveReelPieces } from "./reel";
import { takeThumbnail } from "./thumbnails";
import { tool, toolEnvironment } from "./tools";
import { buildTitlesInput, captionSourceForInput } from "./titles";
import type { StoredCut, StoredVersion, BatchStep } from "./sidekick";
import { advancePin, commitPinned, currentVersion, isRevisionConflict, pinRevision, type RevisionPin } from "./revisions";

// VO7-2: Make it better computes against a pinned revision and commits with expected = that revision.
// A result computed before an undo, or after another change landed, never publishes by itself.
const CHANGED = "You changed this edit while precut was improving it, so your version stays as it is.";
const plainConflict = (error: unknown): never => { throw isRevisionConflict(error) ? new Error(CHANGED) : error; };
/** What is current now, for the accept checks below (the current revision, not the newest snapshot). */
const currentNow = (root: string, cutId: string) => currentVersion(root, cutId).catch(() => null);
import type { CaptionTrack } from "./titles/captions";

export const MAX_ROUNDS = 2;
const WINDOW = .5, PAUSE = .35, MAX_FRAMES = 24, FRAME_EVERY = 1.5;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const db = (amplitude: number) => amplitude > 1e-6 ? 20 * Math.log10(amplitude) : -120;
const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const plain = (text: string) => text.replace(/[–—]/g, ", ").replace(/\s+/g, " ").trim();
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ---- the packet: everything the engine reads, measured here

export type PacketWord = { i: number; piece: number; text: string; s: number; e: number };
export interface PacketLine { starred?: boolean; piece: number; kind: "voice" | "broll"; take: string | null; startS: number; endS: number; text: string; wordsPerSecond: number | null; longestPauseS: number; yours: boolean; description?: string }
export interface AudioSpan { piece: number; startS: number; endS: number; voiceDb: number | null; musicDb: number | null; marginDb: number | null; worstAtS: number | null }
export interface Packet {
  version: number; lengthS: number; targetS: number | null; frame: { width: number; height: number };
  lines: PacketLine[]; words: PacketWord[];
  hook: { firstWordS: number | null; firstSentence: string; sentenceEndS: number | null };
  ending: { text: string; lastWordE: number | null; tailS: number | null };
  pacing: { wordsPerSecond: number | null; pauseTotalS: number; longestPause: { atS: number; lengthS: number } | null; pauses: { atS: number; lengthS: number }[] };
  audio: { lanes?: {lane:import("../shared/schema").SoundLane;db:number;muted:boolean}[]; narration?: {id:string;startS:number;endS:number;muted:boolean;levelDb:number|null;text?:string}[]; measured: boolean; voiceLUFS: number | null; music: { name: string; gainDb: number; duck: boolean; stemDucking?: boolean; rhythmDipDb?:number } | null; spans: AudioSpan[]; clipping: number[]; note: string };
  captions: { on: boolean; position: string | null; collisions: { s: number; e: number; text: string; with: "face" | "safe area" }[]; bigLines: { s: number; text: string; big: boolean }[] };
  transitions: { join: number; atS: number; kind: string; sound: string | null; auto: boolean; between: [string, string] }[];
  takes: { piece: number; current: string; others: { take: string; text: string; note: string; starred: boolean }[] }[];
  frames: { atS: number; file: string }[];
  yours: string[];   // what the person changed by hand, in plain words; never touched
}
/** The packet plus what only main needs (source spans for word edits). */
export interface Watch { packet: Packet; sources: { piece: number; clipId: string; s: number; e: number }[]; record: StoredVersion; pieces: NonNullable<CutVersion["pieces"]>; fx: FxPlan; guard: Guard }

type Levels = { rms: number[]; peak: number[] };
/** RMS and peak per half second, decoded once and cached by the file's identity. Never writes near originals. */
async function levels(root: string, file: string, startS: number, durationS: number, signal?: AbortSignal, filter = ''): Promise<Levels | null> {
  if (durationS <= .05) return { rms: [], peak: [] };
  let stat;
  try { stat = await fs.stat(file); } catch { return null; }
  const lead = Math.max(0, -startS), start = Math.max(0, startS), length = durationS - lead;
  const cache = path.join(root, ".sidething/mb1/levels", `${digest({ rev: 2, filter, file, size: stat.size, mtime: stat.mtimeMs, s: round(startS, 3), d: round(durationS, 3) })}.json`);
  try { return JSON.parse(await fs.readFile(cache, "utf8")); } catch { /* measure */ }
  if (length <= .05) return { rms: [], peak: [] };
  const input = await sourceAudioInput(file);
  const pcm = await new Promise<Buffer>((resolve, reject) => execFile(tool("ffmpeg"), ["-v", "error", "-nostdin", "-ss", String(start), "-t", String(length), ...input,
    "-vn", ...(filter ? ["-af",filter] : []), "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { env: toolEnvironment(), encoding: "buffer", maxBuffer: 256 * 1024 * 1024, signal }, (error, stdout) => error ? reject(error) : resolve(stdout as Buffer)))
    .catch(error => { if (signal?.aborted) throw error; return null; });
  if (!pcm) return null;
  const result: Levels = { rms: [], peak: [] }, step = 16000 * WINDOW * 2;
  for (let k = 0; k < Math.round(lead / WINDOW); k++) { result.rms.push(-120); result.peak.push(-120); }
  for (let at = 0; at + 2 <= pcm.length; at += step) {
    let sum = 0, peak = 0, n = 0;
    for (let k = at; k + 2 <= Math.min(pcm.length, at + step); k += 2) { const v = pcm.readInt16LE(k) / 32768; sum += v * v; peak = Math.max(peak, Math.abs(v)); n++; }
    result.rms.push(round(db(Math.sqrt(sum / n)), 1)); result.peak.push(round(db(peak), 1));
  }
  await fs.mkdir(path.dirname(cache), { recursive: true });
  const temporary = `${cache}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(result)); await fs.rename(temporary, cache); } finally { await fs.rm(temporary, { force: true }); }
  return result;
}

const pieceKey = (p: { clipId: string; s: number; e: number }) => `${p.clipId}@${p.s.toFixed(2)}-${p.e.toFixed(2)}`;
const sourceRate = (c: CutItem) => c.clipFpsR.num / c.clipFpsR.den;

// ---- the person's own edits

export interface Guard { pieces: Set<string>; joins: Set<string>; music: boolean; captions: boolean; bigLines: boolean; order: boolean; words: string[] }
/** Every version after the first that precut did not make here is the person's (hand edits and their chat notes). */
export function protectedEdits(cut: Pick<StoredCut, "versions">, upTo: number): Guard {
  const guard: Guard = { pieces: new Set(), joins: new Set(), music: false, captions: false, bigLines: false, order: false, words: [] };
  const versions = cut.versions.filter(v => v.version <= upTo).sort((a, b) => a.version - b.version);
  const sig = (p: NonNullable<CutVersion["pieces"]>[number]) => `${pieceKey(p)}|${JSON.stringify(p.removed ?? [])}|${p.id}`;
  for (let i = 1; i < versions.length; i++) {
    const v = versions[i], before = versions[i - 1];
    if (v.critique) continue;
    const now = v.pieces ?? [], then = before.pieces ?? [], old = new Set(then.map(sig));
    now.forEach((p, index) => {
      const changed = !old.has(sig(p)) || JSON.stringify(v.pieceFx?.[index] ?? null) !== JSON.stringify(before.pieceFx?.[then.findIndex(o => sig(o) === sig(p))] ?? null)
        || JSON.stringify(v.layouts?.[index] ?? null) !== JSON.stringify(before.layouts?.[then.findIndex(o => sig(o) === sig(p))] ?? null);
      if (changed) guard.pieces.add(pieceKey(p));
    });
    for (let j = 0; j + 1 < now.length; j++) if (JSON.stringify(v.joins?.[j] ?? null) !== JSON.stringify(before.joins?.[then.findIndex(o => sig(o) === sig(now[j]))] ?? null) && v.joins?.[j] != null)
      guard.joins.add(`${pieceKey(now[j])}>${pieceKey(now[j + 1])}`);
    const order = (list: typeof now) => list.map(pieceKey).filter(k => then.some(p => pieceKey(p) === k) && now.some(p => pieceKey(p) === k)).join("|");
    if (order(now) !== order(then)) guard.order = true;
    if (JSON.stringify(v.music ?? null) !== JSON.stringify(before.music ?? null)) guard.music = true;
    if (JSON.stringify(v.titles?.captionStyle ?? null) !== JSON.stringify(before.titles?.captionStyle ?? null)) guard.captions = true;
    if (JSON.stringify(v.bigLines ?? null) !== JSON.stringify(before.bigLines ?? null)) guard.bigLines = true;
  }
  if (guard.pieces.size) guard.words.push(`${guard.pieces.size === 1 ? "one clip" : `${guard.pieces.size} clips`} you changed`);
  if (guard.joins.size) guard.words.push("transitions you picked");
  if (guard.order) guard.words.push("the order you set");
  if (guard.music) guard.words.push("your music choice and level");
  if (guard.captions) guard.words.push("your caption style");
  if (guard.bigLines) guard.words.push("your big caption lines");
  return guard;
}

// ---- watch

function reelSource(record: StoredVersion, fx: FxPlan, t: number) {
  const { cutList, reel } = record.assembly;
  const i = fx.items.map((item, index) => t >= item.startS && t < item.endS ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
  const timing = fx.items[i], item = cutList[i];
  if (!timing || !item?.seg) return null;
  let clipId = item.seg.clip.id, sourceS = mapSource(timing.timeMap, timing.reverse ? timing.startS + timing.endS - t : t);
  const ownerStart = fx.items.find(x => x.piece === timing.piece)!.startS;
  const overlay = reel.broll.find(o => o.voiceIndex === timing.piece && t - ownerStart < o.seg.e - o.seg.s);
  if (overlay) { clipId = overlay.seg.clip.id; sourceS = overlay.seg.s + t - ownerStart; }
  return { clipId, sourceS };
}

function captionBox(cue: { x: number; y: number; size: number; text: string; align: string }, ratio: number, safe: { left: number; right: number }) {
  // Measured layout lives in the renderer; this is the same box the titles validator guards, estimated.
  let w = cue.text.length * cue.size * .58 * ratio;
  const rows = Math.max(1, Math.ceil(w / Math.max(.1, safe.right - safe.left))), h = cue.size * 1.45 * rows;
  w = Math.min(w, safe.right - safe.left);
  const left = cue.align === "left" ? cue.x : cue.align === "right" ? cue.x - w : cue.x - w / 2;
  return { left, right: left + w, top: cue.y - h / 2, bottom: cue.y + h / 2 };
}

export async function watchVersion(root: string, cut: Pick<StoredCut, "versions" | "targetLengthS">, record: StoredVersion,
  opts: { frames: boolean; signal?: AbortSignal; guard?: Guard; safeArea?: string; outputHeight?: number } = { frames: false }): Promise<Watch> {
  const { cutList, template, reel, shoot } = record.assembly;
  if (!cutList.length) throw new Error("Add some footage to this edit first.");
  // Stars are live shoot preferences; edit assemblies retain older snapshots.
  const currentStars = await (await import("./ask-read")).readShoot(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return shoot;
    throw error;
  });
  const fx = planFx(cutList, template.fps, record);
  const pieces = record.pieces?.length ? record.pieces : resolveReelPieces(shoot, template, cutList, reel);
  const guard = opts.guard ?? protectedEdits(cut as StoredCut, record.version);
  // Words: the source-exact kept speech (as Ask reads it), on the reel clock.
  const words: PacketWord[] = [], sources: Watch["sources"] = [];
  cutList.forEach((item, i) => {
    if (!item.seg || item.seg.lineIndex === null || fx.items[i].muted || fx.items[i].reverse) return;
    const timing = fx.items[i], s = item.inFrames / sourceRate(item), e = item.outFrames / sourceRate(item);
    for (const w of fxWords(item).filter(w => w.s >= s - 1e-6 && w.e <= e + 1e-6 && w.w.trim())) {
      words.push({ i: 0, piece: timing.piece, text: w.w.trim(), s: round(mapTime(timing.timeMap, w.s)), e: round(mapTime(timing.timeMap, w.e)) });
      sources.push({ piece: timing.piece, clipId: item.seg.clip.id, s: w.s, e: w.e });
    }
  });
  const order = words.map((w, i) => i).sort((a, b) => words[a].s - words[b].s);
  const sortedWords = order.map((i, n) => ({ ...words[i], i: n })), sortedSources = order.map(i => sources[i]);
  const pauses: { atS: number; lengthS: number; piece: number }[] = [];
  for (let n = 1; n < sortedWords.length; n++) {
    const gap = sortedWords[n].s - sortedWords[n - 1].e;
    if (gap >= PAUSE) pauses.push({ atS: sortedWords[n - 1].e, lengthS: round(gap), piece: sortedWords[n].piece });
  }
  const lines: PacketLine[] = pieces.map((p, index) => {
    const items = fx.items.filter(item => item.piece === index), own = sortedWords.filter(w => w.piece === index);
    const startS = items[0]?.startS ?? p.timelineS, endS = items.at(-1)?.endS ?? p.timelineS + p.lengthS;
    const speech = own.length ? own.at(-1)!.e - own[0].s : 0;
    return { piece: index, starred: footageStarred(currentStars, /^L\d+A\d+$/.test(p.id) ? p.id : p.clipId ?? p.id), kind: p.kind, take: /^L\d+A\d+$/.test(p.id) ? p.id : null, startS: round(startS), endS: round(endS),
      text: items.every(i=>i.muted || i.reverse) ? "" : own.map(w => w.text).join(" ") || p.words || "", wordsPerSecond: speech > .3 ? round(own.length / speech, 1) : null,
      longestPauseS: Math.max(0, ...pauses.filter(x => x.piece === index && x.atS >= startS - 1e-6).map(x => x.lengthS)), yours: guard.pieces.has(pieceKey(p)),
      ...(p.kind === "broll" && p.description ? { description: p.description } : {}) };
  });
  const sentenceEnd = sortedWords.findIndex((w, n) => /[.!?]["'’”)]?$/.test(w.text) || n >= 24);
  const last = sortedWords.at(-1), lastLine = [...lines].reverse().find(l => l.kind === "voice");
  const speechS = sortedWords.length ? sortedWords.at(-1)!.e - sortedWords[0].s : 0;
  // Captions against the face and the app's safe area (portrait only, like the titles validator).
  const preferences = await getPreferences();
  let faces: { s: number; e: number; box: { left: number; right: number; top: number; bottom: number } }[] = [];
  let safe = { left: 0, right: 1, top: 0, bottom: 1 };
  try {
    const source = captionSourceForInput(buildTitlesInput(shoot, record, template, cutList, preferences.captions.safeArea, preferences.output.height));
    faces = source.faces; safe = source.safeArea;
  } catch { faces = (record.titles as CaptionTrack | undefined)?.captionSource?.faces ?? []; }
  const cues = (record.titles?.cues ?? []).filter(c => c.layer !== "behind" && c.text.trim());
  const ratio = template.height / template.width, collisions: Packet["captions"]["collisions"] = [];
  for (const cue of cues) {
    const box = captionBox(cue, ratio, safe);
    const face = faces.find(f => f.s < cue.e && f.e > cue.s && Math.max(0, Math.min(box.right, f.box.right) - Math.max(box.left, f.box.left)) * Math.max(0, Math.min(box.bottom, f.box.bottom) - Math.max(box.top, f.box.top)) > .15 * (box.right - box.left) * (box.bottom - box.top));
    const outside = box.left < safe.left - .01 || box.right > safe.right + .01 || box.top < safe.top - .01 || box.bottom > safe.bottom + .01;
    if (face || outside) collisions.push({ s: round(cue.s), e: round(cue.e), text: cue.text, with: face ? "face" : "safe area" });
  }
  const kinetic = (record.titles as CaptionTrack | undefined)?.kinetic?.lines ?? [];
  const bigLines = kinetic.map(line => ({ s: line.s, text: line.cues.map(c => c.text).join(" "), big: record.titles?.cues.some(c => c.id.startsWith("kinetic-") && c.s >= line.s - 1e-6 && c.s < line.e) ?? false }));
  // Sound per piece: voice from its own source (separate mic when matched), music at its saved gain.
  const music = laneMuted(record,"music") ? null : record.music !== undefined ? record.music : reel.music ?? null;
  const musicGain = music ? (record.music?.gainDb ?? reel.music?.gainDb ?? -18) + laneDb(record,'music') : 0, duck = music ? record.music?.duck !== false : false;
  const duckKeys = cutMusicKeys(cutList, fx, {...record, music}, attachedClipSounds(reel.broll,fx,record,template.fps));
  const duckDbAt = (t:number) => duck ? -20*Math.log10(duckGainAt(duckKeys,t)) : 0;
  const musicLevels = music ? await levels(root, path.resolve(root, music.file), music.startS, fx.durationS, opts.signal) : null;
  const spans: AudioSpan[] = [], clipping: number[] = [];
  let measured = !music || !!musicLevels;
  const stems = music && record.music?.stemDucking !== false && duck ? await musicStems(root,path.resolve(root,music.file),true,{s:music.startS,e:music.startS+fx.durationS}) : undefined;
  const stemLevels = stems ? await Promise.all(STEM_NAMES.map(async name=>({name,levels:await levels(root,stems[name],0,fx.durationS,opts.signal)}))) : null;
  if(stemLevels?.some(p=>!p.levels))measured=false;
  const musicAt = (t: number) => {
    if(!stemLevels)return musicLevels?.rms[Math.floor(t/WINDOW)];
    // Estimate combined RMS from stem powers; separation stems are correlated,
    // so this estimate is labelled explicitly in the packet below.
    return 10*Math.log10(Math.max(1e-12,stemLevels.reduce((sum,p)=>sum+10**((p.levels?.rms[Math.floor(t/WINDOW)] ?? -120)/10)*duckGainAt(stemDuckKeys(duckKeys,p.name),t)**2,0)));
  };
  const musicDipAt = (t:number) => stems ? 0 : duckDbAt(t);
  for (const [index, line] of lines.entries()) {
    const voice: { t: number; v: number }[] = [];
    for (const [i, item] of cutList.entries()) {
      const timing = fx.items[i], clip = item.seg?.clip;
      if (timing.piece !== index || !clip || item.seg!.lineIndex === null || timing.muted || timing.reverse || (!clip.sound && !(clip.meta?.audioChannels ?? 0))) continue;
      const s = item.inFrames / sourceRate(item), e = item.outFrames / sourceRate(item), offset = clip.sound?.offsetS ?? 0;
      const settings=pieceSoundSettings({...DEFAULT_AUDIO_FINISH,...record.audio},record.pieceFx?.[timing.piece],true);
      const prepared=await prepareVoicePiece(root,path.resolve(root,clip.sound?.file ?? clip.file),settings.audio,Math.max(0,s+offset),e-s,settings.clean);
      const read = await levels(root,prepared.file,s+offset-(prepared.sourceStart ?? 0),e-s,opts.signal,prepared.filter);
      if (!read) { measured = false; continue; }
      read.rms.forEach((v, k) => {
        const source = s + (k + .5) * WINDOW;
        if (source > e) return;
        const t = mapTime(timing.timeMap, source);
        if (sortedWords.some(w => w.piece === index && w.s < t + WINDOW / 2 && w.e > t - WINDOW / 2)) voice.push({ t, v: v + timing.gainDb });
        if (read.peak[k] >= -.3) clipping.push(round(t, 1));
      });
      for (const span of clip.quality?.spans ?? []) if (span.kind === "clipping" && span.s < e && span.e > s) clipping.push(round(mapTime(timing.timeMap, Math.max(s, span.s)), 1));
    }
    const musicWindows = musicLevels ? Array.from({ length: Math.max(1, Math.round((line.endS - line.startS) / WINDOW)) }, (_, k) => musicAt(line.startS + k * WINDOW)).filter((v): v is number => v !== undefined) : [];
    const margins = voice.flatMap(({ t, v }) => { const m = musicAt(t); return m === undefined ? [] : [{ t, margin: v - (m + musicGain - musicDipAt(t)) }]; });
    const worst = margins.reduce<typeof margins[number] | null>((a, b) => !a || b.margin < a.margin ? b : a, null);
    const musicDb = median(musicWindows);
    spans.push({ piece: index, startS: line.startS, endS: line.endS, voiceDb: voice.length ? round(median(voice.map(v => v.v))!, 1) : null,
      musicDb: musicDb === null ? null : round(musicDb + musicGain - musicDipAt((line.startS+line.endS)/2), 1),
      marginDb: worst ? round(worst.margin, 1) : null, worstAtS: worst ? round(worst.t, 1) : null });
  }
  const narration: NonNullable<Packet['audio']['narration']> = [];
  for(const line of record.voiceover?.lines ?? []) {
    if(!line.take)continue;
    const muted=laneMuted(record,'voice'),take=line.take;
    const read=muted ? null : await levels(root,path.resolve(root,take.file),take.s,take.e-take.s,opts.signal);
    if(!muted && !read)measured=false;
    const level=read ? median(read.rms) : null;
    narration.push({id:line.id,startS:line.s,endS:Math.min(fx.durationS,line.s+take.e-take.s),muted,levelDb:level===null ? null : round(level+laneDb(record,'voice'),1),text:line.text});  // V66: the words he actually said
  }
  const transitions = fx.joins.map((j, index) => ({ join: index, atS: round(j.atS), kind: j.choice.kind, sound: j.choice.sound, auto: j.auto, between: j.between }));
  // Other takes of each spoken line (finished takes only).
  const takes = lines.flatMap(line => {
    const m = line.take ? /^L(\d+)A(\d+)$/.exec(line.take) : null, take = m ? currentStars.takes.find(t => t.lineIndex === Number(m[1]) - 1) : undefined;
    if (!m || !take) return [];
    const others = take.attempts.flatMap((a, k) => k + 1 === Number(m[2]) || a.practice ? [] : [{ take: `L${m[1]}A${k + 1}`, text: a.text, note: a.note, starred: k === take.starred }]).slice(0, 4);
    return others.length ? [{ piece: line.piece, current: line.take!, others }] : [];
  });
  // A small contact sheet from the thumbnail cache, at most 24 stills.
  const frames: Packet["frames"] = [];
  if (opts.frames && preferences.aiSeesFrames !== false) {
    const count = Math.min(MAX_FRAMES, Math.max(1, Math.floor(fx.durationS / FRAME_EVERY)));
    for (let k = 0; k < count; k++) {
      opts.signal?.throwIfAborted();
      const t = round((k + .5) * fx.durationS / count, 2), at = reelSource(record, fx, t);
      if (!at) continue;
      try { frames.push({ atS: t, file: await takeThumbnail(root, at.clipId, at.sourceS) }); }
      catch (error) { if (opts.signal?.aborted) throw error; /* a still that can't be read is left out */ }
    }
  }
  const packet: Packet = {
    version: record.version, lengthS: round(fx.durationS), targetS: cut.targetLengthS ?? null, frame: { width: template.width, height: template.height },
    lines, words: sortedWords,
    hook: { firstWordS: sortedWords[0]?.s ?? null, firstSentence: sortedWords.slice(0, sentenceEnd < 0 ? 25 : sentenceEnd + 1).map(w => w.text).join(" "), sentenceEndS: sortedWords[sentenceEnd < 0 ? Math.min(24, sortedWords.length - 1) : sentenceEnd]?.e ?? null },
    ending: { text: lastLine?.text ?? "", lastWordE: last?.e ?? null, tailS: last ? round(fx.durationS - last.e) : null },
    pacing: { wordsPerSecond: speechS > 1 ? round(sortedWords.length / speechS, 1) : null, pauseTotalS: round(pauses.reduce((n, p) => n + p.lengthS, 0)),
      longestPause: pauses.length ? pauses.reduce((a, b) => b.lengthS > a.lengthS ? b : a) : null, pauses: pauses.map(({ atS, lengthS }) => ({ atS, lengthS })) },
    audio: { lanes:SOUND_LANES.map(lane=>({lane,db:laneDb(record,lane),muted:laneMuted(record,lane)})),narration, measured, voiceLUFS: reel.voiceLUFS ?? null, music: music ? { name: path.basename(music.file).replace(/\.[^.]+$/, ""), gainDb: round(musicGain, 1), duck,...(stems ? {stemDucking:true,rhythmDipDb:2} : {}) } : null,
      spans, clipping: [...new Set(clipping)].sort((a, b) => a - b),
      note: (stems ? "Stem music RMS is estimated from separate stem powers with the saved per-stem envelopes; correlated stem phase is not measured. " : "") + "Levels are dBFS RMS per half second of each source; music includes its gain and the saved bounded envelope under audible clip sound. marginDb is the voice over the music at its worst moment in that piece." },
    captions: { on: cues.some(c => c.role === "subtitle"), position: record.titles?.captionStyle?.position ?? null, collisions, bigLines },
    transitions, takes, frames, yours: guard.words,
  };
  if (packet.pacing.longestPause) packet.pacing.longestPause = { atS: packet.pacing.longestPause.atS, lengthS: packet.pacing.longestPause.lengthS };
  return { packet, sources: sortedSources, record, pieces, fx, guard };
}

// ---- measures used to verify a fix

export type MeasureKind = "hook" | "music" | "pause" | "pace" | "captions" | "clipping" | "voice" | "ending" | "length" | "take";
export interface Measure { kind: MeasureKind; claim?: string; take?: string }
const norm = (text: string) => text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
export function claimStart(packet: Packet, claim: string): number | null {
  const needle = norm(claim);
  if (!needle.length) return null;
  const tokens = packet.words.flatMap(w => norm(w.text).map(text => ({ text, s: w.s })));
  for (let i = 0; i + needle.length <= tokens.length; i++) if (needle.every((t, j) => tokens[i + j].text === t)) return tokens[i].s;
  return null;
}
const worstMargin = (p: Packet) => { const m = p.audio.spans.flatMap(s => s.marginDb === null ? [] : [s.marginDb]); return m.length ? Math.min(...m) : null; };
const voiceSpread = (p: Packet) => { const v = p.audio.spans.flatMap(s => s.voiceDb === null ? [] : [s.voiceDb]); return v.length > 1 ? Math.max(...v) - Math.min(...v) : null; };
export function measureValue(p: Packet, m: Measure): number | string | null {
  switch (m.kind) {
    case "hook": return m.claim ? claimStart(p, m.claim) : p.hook.sentenceEndS;
    case "music": return worstMargin(p);
    case "pause": return p.pacing.longestPause?.lengthS ?? 0;
    case "pace": return p.pacing.pauseTotalS;
    case "captions": return p.captions.collisions.length;
    case "clipping": return p.audio.clipping.length;
    case "voice": return voiceSpread(p);
    case "ending": return `${p.ending.text}|${p.ending.tailS ?? 0}`;
    case "length": return p.targetS ? Math.abs(p.lengthS - p.targetS) : null;
    case "take": return m.take && p.lines.some(l => l.take === m.take) ? 1 : 0;
  }
}
/** Did the fix measurably land? Plain words for what moved, from the measurements only. */
export function verifyIssue(m: Measure, before: Packet, after: Packet): { landed: boolean; detail: string } {
  const b = measureValue(before, m), a = measureValue(after, m), s = (n: number) => `${round(n, 1)} s`;
  if (a === null || b === null) return { landed: false, detail: m.kind === "hook" && b !== null ? "the point was cut" : "couldn't measure it" };
  if (typeof a === "string" || typeof b === "string") {
    const tailA = after.ending.tailS ?? 0, tailB = before.ending.tailS ?? 0;
    const landed = after.ending.text !== before.ending.text || tailA < tailB - .2;
    return { landed, detail: after.ending.text !== before.ending.text ? `now ends on "${after.ending.text.split(" ").slice(-6).join(" ")}"` : `ends ${s(tailB - tailA)} sooner after the last word` };
  }
  switch (m.kind) {
    case "hook": return { landed: a < b - .2, detail: `the point lands at ${s(a)}, was ${s(b)}` };
    case "music": return { landed: a >= b + 1.5 || (a >= 9 && b < 9), detail: `voice sits ${round(a, 1)} dB over the music, was ${round(b, 1)} dB` };
    case "pause": return { landed: a < b - .15, detail: `longest pause ${s(a)}, was ${s(b)}` };
    case "pace": return { landed: a < b - .3, detail: `${s(a)} of pauses, was ${s(b)}` };
    case "captions": return { landed: a < b, detail: `${a} caption ${a === 1 ? "clash" : "clashes"}, was ${b}` };
    case "clipping": return { landed: a < b, detail: `${a} clipped ${a === 1 ? "moment" : "moments"}, was ${b}` };
    case "voice": return { landed: a < b - 1, detail: `voice level varies ${round(a, 1)} dB, was ${round(b, 1)} dB` };
    case "length": return { landed: a < b - .5, detail: `${s(after.lengthS)} long for a ${s(after.targetS!)} target, was ${s(before.lengthS)}` };
    case "take": return { landed: a === 1, detail: a === 1 ? "uses the stronger take" : "the take didn't change" };
    default: return { landed: false, detail: "couldn't measure it" };
  }
}

/** A round must not trade one problem for another the packet can see. */
export function regressions(before: Packet, after: Packet): string[] {
  const out: string[] = [], mb = worstMargin(before), ma = worstMargin(after);
  if (mb !== null && ma !== null && ma < mb - 3) out.push("the music balance");
  if (after.captions.collisions.length > before.captions.collisions.length) out.push("the captions");
  if (after.audio.clipping.length > before.audio.clipping.length) out.push("clipping");
  if (before.targetS && Math.abs(after.lengthS - before.targetS) > Math.abs(before.lengthS - before.targetS) + 3) out.push("the length");
  if (before.words.length && !after.words.length) out.push("the speech");
  return out;
}

// ---- the engine's critique

export type FixOp =
  | { op: "trimShot"; piece: number; s: number; e: number }
  | { op: "swapTake"; piece: number; take: string }
  | { op: "trim"; piece: number; fromWord: number; toWord: number }
  | { op: "cutWords"; fromWord: number; toWord: number }
  | { op: "removePiece"; piece: number }
  | { op: "move"; piece: number; to: number; shotOrderReason?: string }
  | { op: "join"; join: number; kind: TransitionKind; sound: TransitionSound | null }
  | { op: "musicGain"; gainDb: number }
  | { op: "captionPosition"; position: "bottom" | "middle" | "top" }
  | { op: "bigLine"; s: number; big: boolean }
  | { op: "punchIn"; piece: number; tight: number }
  | { op: "voiceGain"; piece: number; gainDb: number }
  | { op: "sfx"; kind: SfxItem["kind"]; atS: number; gainDb?: number }
  | { op: "removeFillers" } | { op: "tightenPauses" };
export interface Issue { id: string; round: number; what: string; severity: "high" | "medium" | "low"; measure: Measure; change: string; fixes: FixOp[]; dropped: string[]; fixed: boolean; detail?: string }
const KINDS: MeasureKind[] = ["hook", "music", "pause", "pace", "captions", "clipping", "voice", "ending", "length", "take"];
const JOINS: TransitionKind[] = ["cut", "snap", "ease", "zoom", "whip", "dissolve", "ramp"];
const SOUNDS: TransitionSound[] = ["whoosh", "hit", "pop", "riser"];
const SFX_KINDS: SfxItem["kind"][] = ["whoosh", "hit", "pop", "riser", "impact", "ambience", "roomtone", "ui", "other"];
const int = (v: unknown, low: number, high: number) => Number.isInteger(v) && (v as number) >= low && (v as number) <= high;
const num = (v: unknown, low: number, high: number) => typeof v === "number" && Number.isFinite(v) && v >= low && v <= high;

/** Lenient per issue: a malformed issue or fix is dropped, never the whole review. Copy is checked mechanically. */
export function validateCritique(value: unknown, watch: Watch, roundNumber: number): Issue[] {
  const { packet, guard, pieces } = watch, lines = packet.lines;
  const raw = (value as { issues?: unknown })?.issues;
  if (!Array.isArray(raw)) throw new Error("precut couldn't read its review. Try again.");
  const keyOf = (piece: number) => pieces[piece] ? pieceKey(pieces[piece]) : "";
  return raw.slice(0, 8).flatMap((item: Record<string, unknown>, n): Issue[] => {
    const what = typeof item?.what === "string" ? plain(item.what) : "", change = typeof item?.change === "string" ? plain(item.change) : "";
    const severity = ["high", "medium", "low"].includes(item?.severity as string) ? item.severity as Issue["severity"] : null;
    const m = item?.measure as Record<string, unknown> | undefined;
    if (!what || what.length > 240 || !change || change.length > 160 || !severity || !m || !KINDS.includes(m.kind as MeasureKind)) return [];
    const measure: Measure = { kind: m.kind as MeasureKind, ...(typeof m.claim === "string" && m.claim.trim() ? { claim: m.claim.trim().slice(0, 200) } : {}), ...(typeof m.take === "string" ? { take: m.take } : {}) };
    if (measure.kind === "hook" && measure.claim && claimStart(packet, measure.claim) === null) return [];
    if (measure.kind === "take" && !packet.takes.some(t => t.others.some(o => o.take === measure.take))) return [];
    const dropped: string[] = [], fixes: FixOp[] = [];
    for (const f of Array.isArray(item.fixes) ? item.fixes.slice(0, 12) as Record<string, unknown>[] : []) {
      const piece = f?.piece as number, voice = int(piece, 0, lines.length - 1) && lines[piece].kind === "voice";
      const mine = int(piece, 0, lines.length - 1) && guard.pieces.has(keyOf(piece));
      const ok = (() => { switch (f?.op) {
        case "trimShot": return int(piece,0,lines.length-1) && num(f.s,pieces[piece].s,pieces[piece].e) && num(f.e,pieces[piece].s,pieces[piece].e) && (f.e as number)>(f.s as number);
        case "swapTake": return voice && packet.takes.some(t => t.piece === piece && t.others.some(o => o.take === f.take));
        case "trim": return voice && int(f.fromWord, 0, packet.words.length - 1) && int(f.toWord, 1, packet.words.length) && (f.fromWord as number) < (f.toWord as number)
          && packet.words.slice(f.fromWord as number, f.toWord as number).every(w => w.piece === piece);
        case "cutWords": return int(f.fromWord, 0, packet.words.length - 1) && int(f.toWord, 1, packet.words.length) && (f.fromWord as number) < (f.toWord as number) && (f.toWord as number) - (f.fromWord as number) <= 60;
        case "removePiece": return int(piece, 0, lines.length - 1) && lines.length > 1;
        case "move": return int(piece, 0, lines.length - 1) && int(f.to, 0, lines.length - 1) && f.to !== piece;
        case "join": return int(f.join, 0, packet.transitions.length - 1) && JOINS.includes(f.kind as TransitionKind) && (f.sound === null || f.sound === undefined || SOUNDS.includes(f.sound as TransitionSound));
        case "musicGain": return !!packet.audio.music && num(f.gainDb, -40, 0);
        case "captionPosition": return packet.captions.on && ["bottom", "middle", "top"].includes(f.position as string);
        case "bigLine": return typeof f.big === "boolean" && packet.captions.bigLines.some(l => Math.abs(l.s - (f.s as number)) < 1e-3);
        case "punchIn": return voice && num(f.tight, .2, .9);
        case "voiceGain": return voice && num(f.gainDb, -12, 12);
        case "sfx": return SFX_KINDS.includes(f.kind as SfxItem["kind"]) && num(f.atS, 0, packet.lengthS - .05) && (f.gainDb === undefined || num(f.gainDb, -24, 0));
        case "removeFillers": case "tightenPauses": return true;
        default: return false;
      } })();
      if (!ok) { dropped.push(`${String(f?.op ?? "unknown")} was not a valid change`); continue; }
      const orderReason=f.op==='move' && typeof f.shotOrderReason==='string' ? plain(f.shotOrderReason).slice(0,1000) : '';
      if(orderReason)f.shotOrderReason=orderReason;
      if(f.op==='move' && !orderReason && !/\b(hook|flash[ -]?forward|flash[ -]?back)\b/i.test(`${what} ${change}`)) {
        const clocks=pieces.map(p=>filmedTime(watch.record?.assembly.shoot.clips.find(c=>c.id===p.clipId)));
        const inversions=(values:(number|null)[])=>values.reduce<number>((sum,t,i)=>sum+(t===null?0:values.slice(i+1).filter(n=>n!==null && n<t).length),0);
        const moved=[...clocks], [clock]=moved.splice(piece,1);moved.splice(f.to as number,0,clock);
        if(inversions(moved)>=inversions(clocks)){dropped.push('Kept capture-time order');continue;}
      }
      // Never touch what the person set by hand.
      const touches = (() => { switch (f.op) {
        case "swapTake": case "trim": case "trimShot": case "removePiece": case "punchIn": case "voiceGain": return mine;
        case "move": return mine || guard.order;
        case "cutWords": return packet.words.slice(f.fromWord as number, f.toWord as number).some(w => guard.pieces.has(keyOf(w.piece)));
        case "join": { const j = f.join as number; return guard.joins.has(`${keyOf(j)}>${keyOf(j + 1)}`); }
        case "musicGain": return guard.music;
        case "captionPosition": return guard.captions;
        case "bigLine": return guard.bigLines;
        case "removeFillers": case "tightenPauses": return guard.pieces.size > 0;
        default: return false;
      } })();
      if (touches) { dropped.push("left your own change as it is"); continue; }
      if (f.op === "move" && (pieces[piece]?.removed ?? []).some(r => r.kind === "cut")) { dropped.push("a clip with cut words can't move without losing them"); continue; }
      const { op, ...rest } = f;
      fixes.push({ op, ...Object.fromEntries(Object.entries(rest).filter(([key]) => ["piece", "take", "fromWord", "toWord", "to", "join", "kind", "sound", "gainDb", "position", "s", "e", "big", "tight", "atS"].includes(key))) } as FixOp);
    }
    return [{ id: `${roundNumber}-${n}`, round: roundNumber, what, severity, measure, change, fixes, dropped, fixed: false }];
  });
}

/** Map fixes onto existing edit operations, ordered so piece indexes keep meaning what was watched. */
export async function planSteps(root: string, cutId: string, watch: Watch, issues: Issue[]): Promise<{ steps: BatchStep[]; owners: string[][] }> {
  const { record, sources, packet } = watch;
  const buckets: { rank: number; owner: string; step: BatchStep | null; piece?: number; to?: number }[] = [];
  const fxByPiece = new Map<number, { fx: NonNullable<CutVersion["pieceFx"]>[number]; owners: string[] }>();
  const swapped = new Set(issues.flatMap(i => i.fixes.flatMap(f => f.op === "swapTake" ? [f.piece] : [])));
  const removed = new Set<number>();
  const { soundLibrary } = await import("./sound-design");
  const library = issues.some(i => i.fixes.some(f => f.op === "sfx")) ? await soundLibrary() : [];
  const { finishCut } = await import("./finish");
  const spansOf = (from: number, to: number) => {
    const spans: { piece: number; s: number; e: number }[] = [];
    for (let n = from; n < to; n++) {
      const src = sources[n], last = spans.at(-1);
      if (last && last.piece === src.piece && n > from && sources[n - 1].piece === src.piece) last.e = src.e;
      else spans.push({ piece: src.piece, s: src.s, e: src.e });
    }
    return spans;
  };
  for (const issue of issues) for (const f of issue.fixes) {
    const owner = issue.id;
    switch (f.op) {
      case "trimShot": if (!swapped.has(f.piece)) buckets.push({rank:1,owner,step:{kind:"trim",piece:f.piece,s:f.s,e:f.e}}); break;
      case "punchIn": case "voiceGain": {
        const entry = fxByPiece.get(f.piece) ?? { fx: { ...record.pieceFx?.[f.piece] }, owners: [] };
        if (f.op === "punchIn") entry.fx = { ...entry.fx, framing: { mode: "face", tight: f.tight } }; else entry.fx = { ...entry.fx, gainDb: f.gainDb };
        entry.owners.push(owner); fxByPiece.set(f.piece, entry); break;
      }
      case "swapTake": buckets.push({ rank: 1, owner, step: { kind: "swap", piece: f.piece, take: f.take } }); break;
      case "trim": if (!swapped.has(f.piece)) buckets.push({ rank: 1, owner, step: { kind: "trim", piece: f.piece, s: sources[f.fromWord].s, e: sources[f.toWord - 1].e } }); break;
      case "join": {
        const current = watch.fx.joins[f.join]?.choice;
        buckets.push({ rank: 2, owner, step: { kind: "join", join: f.join, choice: { kind: f.kind, sound: f.sound ?? null, ...(current?.audio ? { audio: current.audio } : {}) } as JoinChoice } }); break;
      }
      case "bigLine": buckets.push({ rank: 3, owner, step: { kind: "bigLine", s: f.s, big: f.big } }); break;
      case "sfx": {
        const sound = library.find(s => s.kind === f.kind);
        if (sound) buckets.push({ rank: 3, owner, step: { kind: "sfx", op: "add", item: { file: sound.id, name: sound.name, kind: f.kind, atS: f.atS, gainDb: f.gainDb ?? -12, reason: issue.what } } });
        break;
      }
      case "cutWords": {
        // A cut covering every kept word of a clip is that clip's removal (indexes then shift last).
        const spans = spansOf(f.fromWord, f.toWord).filter(s => !swapped.has(s.piece));
        for (const piece of new Set(spans.map(s => s.piece))) {
          const kept = packet.words.filter(w => w.piece === piece), cut = packet.words.slice(f.fromWord, f.toWord).filter(w => w.piece === piece);
          if (kept.length && cut.length === kept.length && packet.lines.length - removed.size > 1) { removed.add(piece); buckets.push({ rank: 6, owner, step: null, piece }); }
        }
        const rest = spans.filter(s => !removed.has(s.piece));
        if (rest.length) buckets.push({ rank: 4, owner, step: { kind: "cutWords", spans: rest } });
        break;
      }
      case "removeFillers": buckets.push({ rank: 5, owner, step: { kind: "removeFillers" } }); break;
      case "tightenPauses": buckets.push({ rank: 5, owner, step: { kind: "tightenPauses" } }); break;
      case "removePiece": if (!removed.has(f.piece) && packet.lines.length - removed.size > 1) { removed.add(f.piece); buckets.push({ rank: 6, owner, step: null, piece: f.piece }); } break;
      case "move": buckets.push({ rank: 7, owner, step: null, piece: f.piece, to: f.to }); break;
      case "musicGain": {
        const music = record.music ?? (record.assembly.reel.music ? { file: record.assembly.reel.music.file, startS: record.assembly.reel.music.startS } : null);
        if (music) buckets.push({ rank: 8, owner, step: v => finishCut(root, cutId, v, { audio: {}, music: { file: music.file, startS: music.startS, gainDb: f.gainDb, duck: record.music?.duck !== false } }) });
        break;
      }
      case "captionPosition": {
        const style = record.titles?.captionStyle;
        if (style) buckets.push({ rank: 8, owner, step: v => finishCut(root, cutId, v, { audio: {}, captions: { ...style, position: f.position } }) });
        break;
      }
    }
  }
  // One pieceFx edit per clip even when two issues share it.
  for (const [piece, { fx }] of fxByPiece) buckets.push({ rank: 0, owner: "", step: { kind: "pieceFx", piece, fx }, piece });
  const ordered = buckets.sort((a, b) => a.rank - b.rank || (a.rank === 6 ? (b.piece! - a.piece!) : 0));
  // Moves run after removals, one at a time: insert a copy of the clip's kept span, then remove the original.
  const moves = ordered.filter(b => b.rank === 7);
  const steps: BatchStep[] = [], owners: string[][] = [];
  for (const b of ordered) {
    if (b.rank === 6) { steps.push({ kind: "remove", piece: b.piece! }); owners.push([b.owner]); continue; }
    if (b.rank === 7) {
      if (removed.size || moves.length > 1) continue;  // keep it simple and honest: one move, and only when nothing is removed
      const p = watch.pieces[b.piece!], at = b.to! > b.piece! ? b.to! + 1 : b.to!;
      steps.push({ kind: "insert", at, source: { clipId: p.clipId, s: p.s, e: p.e } }); owners.push([b.owner]);
      steps.push({ kind: "remove", piece: b.to! > b.piece! ? b.piece! : b.piece! + 1 }); owners.push([b.owner]);
      continue;
    }
    steps.push(b.step!);
    owners.push(b.rank === 0 ? fxByPiece.get(b.piece!)!.owners : [b.owner]);
  }
  // Swaps, trims and removals re-level the music to the voice. Put back a level the person chose.
  const music = record.music;
  if (watch.guard.music && music && steps.some(s => typeof s !== "function" && ["swap", "trim", "remove", "insert", "cutWords"].includes(s.kind))) {
    steps.push(v => finishCut(root, cutId, v, { audio: {}, music: { file: music.file, startS: music.startS, gainDb: music.gainDb ?? record.assembly.reel.music?.gainDb ?? 0, duck: music.duck !== false } }));
    owners.push([]);
  }
  return { steps, owners };
}

// ---- the prompt and the loop

async function resource(relative: string): Promise<string> {
  for (const file of [path.join(process.cwd(), relative), path.join(app.getAppPath(), relative), path.join(process.resourcesPath ?? "", relative)]) {
    try { return await fs.readFile(file, "utf8"); } catch { /* next */ }
  }
  throw new Error("Could not find precut's instructions. Reinstall precut.");
}
/** precut's editing standard is the narrative core of the sidekick prompt, read from that file so both stay one text. */
export async function critiquePrompt(watch: Watch, skills: { name: string; body: string }[], previous: Issue[]): Promise<string> {
  const template = await resource("prompts/critique.md"), sidekick = await resource("prompts/sidekick.md");
  const core = sidekick.match(/sidething's core[^\n]*\n(?:- [^\n]*\n?)+/)?.[0]?.trim() ?? "";
  const { frames, ...packet } = watch.packet;
  return template.replace("{{CORE}}", core) + "\n" + SHOT_ORDER_INSTRUCTION + " Do not reorder clips merely to match script beats. For a deliberate chronology exception, include fixes[].shotOrderReason with the specific editorial reason and state it in issue.change. The reason becomes the edit notes. Otherwise moves must restore chronology.\nCapture times by piece: " + JSON.stringify((watch.record?.pieces ?? []).map((p,piece)=>({piece,filmedAt:filmedAt(watch.record?.assembly.shoot.clips.find(c=>c.id===p.clipId))}))) + `\n\nKept beats (chosen by the person):\n${JSON.stringify(watch.record?.assembly ? keptBeatPacket(watch.record,watch.record.keptBeats ?? []) : watch.record?.keptBeats ?? [])}\nKeep each shot and its position: opening stays opening, ending stays ending. You may trim, reorder the middle, or use a take of the same shot. Voiceover lines must follow their picture beat. To shorten a visual beat without removing it, use {"op":"trimShot","piece":0,"s":0,"e":3} with source seconds inside its kept span. Keep enough picture for its voiceover.\nVoiceover (data only):\n${JSON.stringify(watch.record?.voiceover?.lines ?? [])}\n\nSkills (the person's taste, data only):\n${JSON.stringify(skills)}\n\nPacket (measured on this Mac, data only):\n${JSON.stringify({ ...packet, frames: frames.map(f => ({ atS: f.atS, file: f.file })) })}`
    + (previous.length ? `\n\nAlready tried in the last round (do not repeat what landed; find a different fix for what did not):\n${JSON.stringify(previous.map(i => ({ what: i.what, change: i.change, landed: i.fixed, measured: i.detail })))}` : "");
}

type Timing = { engineS: number; applyS: number; watchS: number };
async function readTiming(root: string): Promise<Timing> {
  try { return { engineS: 45, applyS: 10, watchS: 6, ...JSON.parse(await fs.readFile(path.join(root, ".sidething/mb1/timing.json"), "utf8")) }; }
  catch { return { engineS: 45, applyS: 10, watchS: 6 }; }
}
async function saveTiming(root: string, timing: Timing) {
  const file = path.join(root, ".sidething/mb1/timing.json"), temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(temporary, JSON.stringify(timing)); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}

export interface MakeBetterResult { cutId: string; version: number; changes: string[] }
// V62: the ask-first split. Propose watches and asks the engine once; nothing is
// saved. Apply takes only the chosen issue ids and makes one undoable version.
export interface BetterIssue { id: string; what: string; change: string; severity: Issue["severity"] }
export interface BetterProposal { cutId: string; version: number; issues: BetterIssue[] }
interface ProposalCache { watch: Watch; issues: Issue[]; base: number; latestAtStart: number }  // latestAtStart: the current revision when it was watched
const proposals = new Map<string, ProposalCache>();
const runningProposals = new Map<string, Promise<BetterProposal>>();
const runningApplies = new Map<string, Promise<MakeBetterResult>>();
const proposalKey = (root: string, cutId: string, version: number) => `${path.resolve(root)}|${cutId}|${version}`;
const publicIssue = (issue: Issue): BetterIssue => ({ id: issue.id, what: issue.what, change: issue.change, severity: issue.severity });

/** Watch one saved version exactly as the automatic pass does, with no engine call and no save. */
async function prepareWatch(root: string, cutId: string, base: number, activity: ActivityHandle) {
  const sidekick = await import("./sidekick");
  const cut = await sidekick.readCut(root, cutId);
  const start = cut.versions.find(v => v.version === base);
  if (!start?.assembly) throw new Error("Could not find that edit version.");
  const latestAtStart = (await pinRevision(root, cutId, base)).current;
  const guard = protectedEdits(cut, base);
  const keptBeats = await keptBeatsFor(root, cut, base);
  let record = { ...start, assembly: await sidekick.freshen(root, start.assembly) };
  record.keptBeats = keptBeats;
  const script: import("../shared/schema").VoiceoverScript | null = await fs.readFile(path.join(root, ".sidething/voiceover", `${cutId}.json`), "utf8")
    .then(JSON.parse, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return start.voiceover ?? null; throw error; });
  if (script) {
    record.voiceover = retimeScript(script, cut.versions.find(v => v.version === script.version), record);
    record.keptBeats = narratedKeptBeats(record, record.voiceover, keptBeats);
  }
  const watch = await (await import("./activity")).withRenderSlot(activity, () => watchVersion(root, cut, record, { frames: true, signal: activity.signal, guard }), "background");
  return { sidekick, cut, record, watch, guard, keptBeats, latestAtStart };
}

export function proposeBetter(root: string, cutId: string, version: number): Promise<BetterProposal> {
  root = path.resolve(root);
  if (!Number.isInteger(version) || version < 1) return Promise.reject(new Error("Choose a saved version of this edit."));
  const key = proposalKey(root, cutId, version);
  const existing = runningProposals.get(key);
  if (existing) return existing;
  const work = (async (): Promise<BetterProposal> => {
    const cached = proposals.get(key);
    if (cached) {
      // A cached list holds while the edit is still on that revision.
      const latest = await currentNow(root, cutId);
      if (latest === version) return { cutId, version, issues: cached.issues.map(publicIssue) };
      proposals.delete(key);
    }
    return runActivity({ kind: "finish", root, target: { cutId, version }, label: "Checking this edit", cancelable: true }, async activity => {
      activity.progress(5, "Watching the edit", 30);
      const { watch, latestAtStart } = await prepareWatch(root, cutId, version, activity);
      const cut = await (await import("./sidekick")).readCut(root, cutId);
      const skills = (await listSkills()).filter(s => s.global || cut.skillIds.includes(s.id)).map(s => ({ name: s.name, body: s.body }));
      const engine = await getEngine();
      activity.progress(40, "Finding what to improve", 30);
      const raw = await runModel({ engine, prompt: await critiquePrompt(watch, skills, [])
          + `\n\nLibrary scope (use shootRoot as shoot, cutId as cut): ${JSON.stringify({ shootRoot: root, cutId, version })}`,
        images: watch.packet.frames.map(f => f.file), cwd: root, signal: activity.signal, libraryTools: true });
      let parsed: unknown;
      try { parsed = parseModelJson(raw); } catch { throw new Error("precut couldn't read its review. Try again."); }
      const actionable = validateCritique(parsed, watch, 1).filter(i => i.fixes.length);
      proposals.set(key, { watch, issues: actionable, base: version, latestAtStart });
      activity.progress(100, actionable.length ? `${actionable.length} ${actionable.length === 1 ? "change" : "changes"} to check` : "Nothing to change");
      return { cutId, version, issues: actionable.map(publicIssue) };
    }, { groupChildren: true });
  })();
  runningProposals.set(key, work);
  void work.finally(() => { if (runningProposals.get(key) === work) runningProposals.delete(key); }).catch(() => {});
  return work;
}

export function applyBetter(root: string, cutId: string, version: number, issueIds: string[]): Promise<MakeBetterResult> {
  root = path.resolve(root);
  if (!Number.isInteger(version) || version < 1) return Promise.reject(new Error("Choose a saved version of this edit."));
  if (!Array.isArray(issueIds) || issueIds.some(id => typeof id !== "string" || !id)) return Promise.reject(new Error("Choose at least one change to apply."));
  const chosenIds = [...new Set(issueIds)];
  if (!chosenIds.length) return Promise.resolve({ cutId, version, changes: [] });
  const key = proposalKey(root, cutId, version);
  const existing = runningApplies.get(key);
  if (existing) return existing;
  const work = runActivity({ kind: "finish", root, target: { cutId, version }, label: LABEL, cancelable: true }, async activity => {
    const cached = proposals.get(key);
    if (!cached) throw new Error("That list is out of date. Ask again so precut can look fresh.");
    const chosen = cached.issues.filter(i => chosenIds.includes(i.id));
    if (!chosen.length) throw new Error("That list is out of date. Ask again so precut can look fresh.");
    activity.progress(20, "Making the changes", 15);
    const sidekick = await import("./sidekick");
    const all: Issue[] = [];
    let pin = await pinRevision(root, cutId, version);
    const result = await applyRound(root, cutId, version, cached.watch, chosen, cached.latestAtStart, version, all, 1, sidekick, pin);
    if (result) pin = advancePin(pin, result.version);
    let current = result?.version ?? version;
    const restored = new Set<string>(result?.restored ?? []);
    if (result) {
      const history = await sidekick.readCut(root, cutId);
      const selected = history.versions.find(v => v.version === current);
      if (selected) {
        const repairs = restoreKeptBeats(structuredClone(selected), cached.watch.record.keptBeats ?? [], history.versions);
        if (repairs.length) {
          const saved = await commitPinned(root, cutId, pin, {}, () => sidekick.runBatch(root, cutId, current, "Kept the chosen beats", [], async staged => {
            const latest = await currentNow(root, cutId);
            if (latest !== cached.latestAtStart && latest !== current) throw new Error(CHANGED);
            staged.keptBeatRestorations = restoreKeptBeats(staged, cached.watch.record.keptBeats ?? [], history.versions);
            staged.critique = { rounds: 1, from: version, at: new Date().toISOString(), issues: staged.keptBeatRestorations.map(what => ({ what, fixed: true, how: "Kept the chosen story beat." })) };
            return true;
          })).catch(plainConflict);
          if (saved) { current = saved.version; repairs.forEach(change => restored.add(change)); }
        }
      }
    }
    proposals.delete(key);
    const changes = [...all.filter(i => i.fixed).map(i => `${i.change} (${i.detail})`), ...restored];
    activity.progress(100, changes.length ? `${changes.length} ${changes.length === 1 ? "change" : "changes"}` : "Nothing to change");
    return { cutId, version: result ? current : version, changes };
  }, { groupChildren: true });
  runningApplies.set(key, work);
  void work.finally(() => { if (runningApplies.get(key) === work) runningApplies.delete(key); }).catch(() => {});
  return work;
}

const running = new Map<string, Promise<MakeBetterResult>>();
const LABEL = "Making it better";

export function makeBetter(root: string, cutId: string, version: number): Promise<MakeBetterResult> {
  root = path.resolve(root);
  if (!Number.isInteger(version) || version < 1) return Promise.reject(new Error("Choose a saved version of this edit."));
  const key = `${root}|${cutId}`;
  const existing = running.get(key);
  if (existing) return existing;
  const work = runActivity({ kind: "finish", root, target: { cutId, version }, label: LABEL, cancelable: true },
    activity => improve(root, cutId, version, activity), { groupChildren: true });
  running.set(key, work);
  void work.finally(() => { if (running.get(key) === work) running.delete(key); }).catch(() => {});
  return work;
}

async function improve(root: string, cutId: string, base: number, activity: ActivityHandle): Promise<MakeBetterResult> {
  const sidekick = await import("./sidekick");
  const keep = (pct: number, note: string, eta: number) => { activity.update({ kind: "finish", label: LABEL }); activity.progress(pct, note, Math.max(1, Math.round(eta))); };
  const timing = await readTiming(root), began = Date.now();
  const estimate = () => timing.watchS + timing.engineS + timing.applyS + 3;
  keep(2, "Watching the edit", estimate());
  const cut = await sidekick.readCut(root, cutId);
  const start = cut.versions.find(v => v.version === base);
  if (!start?.assembly) throw new Error("Could not find that edit version.");
  let pin = await pinRevision(root, cutId, base);
  const latestAtStart = pin.current;
  const guard = protectedEdits(cut, base);
  const keptBeats = await keptBeatsFor(root, cut, base);
  const skills = (await listSkills()).filter(s => s.global || cut.skillIds.includes(s.id)).map(s => ({ name: s.name, body: s.body }));
  const engine = await getEngine();
  let current = base, record = { ...start, assembly: await sidekick.freshen(root, start.assembly) };
  record.keptBeats = keptBeats;
  const script: import('../shared/schema').VoiceoverScript | null = await fs.readFile(path.join(root,'.sidething/voiceover',`${cutId}.json`),'utf8')
    .then(JSON.parse,error=>{if(error.code==='ENOENT')return start.voiceover ?? null;throw error;});
  if (script) {
    record.voiceover=retimeScript(script,cut.versions.find(v=>v.version===script.version),record);
    record.keptBeats=narratedKeptBeats(record,record.voiceover,keptBeats);
  }
  let watch = await (await import("./activity")).withRenderSlot(activity, () => watchVersion(root, cut, record, { frames: true, signal: activity.signal, guard }), "background");
  timing.watchS = (Date.now() - began) / 1000;
  const all: Issue[] = [];
  const restoredChanges = new Set<string>();
  let rounds = 0;
  for (let roundNumber = 1; roundNumber <= MAX_ROUNDS; roundNumber++) {
    activity.signal.throwIfAborted();
    const left = (roundNumber === 1 ? 0 : timing.watchS) + timing.engineS + timing.applyS + 3;
    keep(roundNumber === 1 ? 10 : 55, "Finding what to improve", left);
    const asked = Date.now();
    const raw = await runModel({ engine, prompt: await critiquePrompt(watch, skills, roundNumber > 1 ? all.filter(i => i.round === roundNumber - 1) : [])
        + `\n\nLibrary scope (use shootRoot as shoot, cutId as cut): ${JSON.stringify({ shootRoot: root, cutId, version: current })}`,
      images: watch.packet.frames.map(f => f.file), cwd: root, signal: activity.signal, libraryTools: true });
    timing.engineS = (Date.now() - asked) / 1000;
    let parsed: unknown;
    try { parsed = parseModelJson(raw); } catch { throw new Error("precut couldn't read its review. Try again."); }
    const issues = validateCritique(parsed, watch, roundNumber);
    const actionable = issues.filter(i => i.fixes.length);
    // Stopping rule: round 1 acts on any real issue; a second round only chases high ones that did not land.
    if (!actionable.length || (roundNumber > 1 && !actionable.some(i => i.severity === "high"))) { all.push(...issues); break; }
    all.push(...issues.filter(i => !actionable.includes(i)));
    keep(roundNumber === 1 ? 45 : 80, "Making the changes", timing.applyS + 3);
    const applied = Date.now();
    const result = await applyRound(root, cutId, current, watch, actionable, latestAtStart, base, all, roundNumber, sidekick, pin);
    timing.applyS = (Date.now() - applied) / 1000;
    if (!result) break;  // nothing measurably better: keep what the person has
    rounds++; current = result.version; pin = advancePin(pin, current);
    for (const change of result.restored) restoredChanges.add(change);
    if (!all.some(i => i.round === roundNumber && i.severity === "high" && !i.fixed) || roundNumber === MAX_ROUNDS) break;
    // Re-watch for the second review only now (frames included), never for verification alone.
    const saved = await sidekick.readCut(root, cutId);
    const next = saved.versions.find(v => v.version === current)!;
    record = { ...next, assembly: await sidekick.freshen(root, next.assembly) };
    watch = await (await import("./activity")).withRenderSlot(activity, () => watchVersion(root, saved, record, { frames: true, signal: activity.signal, guard }), "background");
  }
  // An older automatic pass may already have lost a promised shot. A review
  // with no measurable fix must still repair that known constraint violation.
  const history = await sidekick.readCut(root,cutId), selected = history.versions.find(v=>v.version===current)!;
  const checked = structuredClone(selected);
  const repairs = restoreKeptBeats(checked,record.keptBeats ?? keptBeats,history.versions);
  if (repairs.length) {
    const saved = await commitPinned(root,cutId,pin,{},()=>sidekick.runBatch(root,cutId,current,"Kept the chosen beats",[],async staged=>{
      const latest=await currentNow(root,cutId);
      if (latest!==latestAtStart && latest!==current) throw new Error(CHANGED);
      staged.keptBeatRestorations=restoreKeptBeats(staged,record.keptBeats ?? keptBeats,history.versions);
      staged.critique={rounds:1,from:base,at:new Date().toISOString(),issues:staged.keptBeatRestorations.map(what=>({what,fixed:true,how:"Kept the chosen story beat."}))};
      return true;
    })).catch(plainConflict);
    if (saved) { current=saved.version; rounds++; repairs.forEach(change=>restoredChanges.add(change)); }
  }
  await saveTiming(root, timing).catch(() => {});
  const changes = [...all.filter(i => i.fixed).map(i => `${i.change} (${i.detail})`), ...restoredChanges];
  activity.progress(100, changes.length ? `${changes.length} ${changes.length === 1 ? "change" : "changes"}` : "Nothing to change");
  return { cutId, version: rounds ? current : base, changes };
}

/** One round's batch: verify on the staged draft before it is saved; if some fixes did not land, try once more with only the ones that did. */
async function applyRound(root: string, cutId: string, from: number, watch: Watch, issues: Issue[], latestAtStart: number, base: number, all: Issue[], roundNumber: number,
  sidekick: typeof import("./sidekick"), pin: RevisionPin): Promise<{ version: number; restored: string[] } | null> {
  let candidates = issues;
  for (let pass = 0; pass < 3 && candidates.length; pass++) {
    const { steps, owners } = await planSteps(root, cutId, watch, candidates);
    if (!steps.length) { for (const i of candidates) { i.fixed = false; i.detail = "couldn't apply it"; } break; }
    let verdicts = new Map<string, { landed: boolean; detail: string }>();
    let failedOwner: string[] | null = null, worse: string[] = [];
    let restorations: string[] = [];
    const saved = await commitPinned(root, cutId, pin, {}, () => sidekick.runBatch(root, cutId, from, "Made it better", steps, async staged => {
      // planSteps represents the single accepted move as an insert/remove pair.
      const moved=steps.some(step=>typeof step!=='function' && step.kind==='insert');
      const orderNotes=moved ? candidates.flatMap(issue=>issue.fixes.flatMap(f=>f.op==='move' ? [f.shotOrderReason || `${issue.change} ${issue.what}`] : [])) : [];
      if(orderNotes.length)staged.why += `\n${orderNotes.join(' ')}`;
      const latest = await currentNow(root, cutId);
      if (latest !== latestAtStart && latest !== from) throw new Error(CHANGED);
      const cut = await sidekick.readCut(root, cutId);
      if (watch.record.voiceover) staged.voiceover = watch.record.voiceover;
      const restored = restoreKeptBeats(staged, watch.record.keptBeats ?? [], cut.versions);
      restorations = restored;
      staged.keptBeatRestorations = restored;
      await (await import("./balance")).reuseBalances(root,staged);
      const after = await watchVersion(root, cut, staged, { frames: false, guard: watch.guard });
      verdicts = new Map(candidates.map(i => [i.id, verifyIssue(i.measure, watch.packet, after.packet)]));
      worse = regressions(watch.packet, after.packet);
      if (worse.length || ![...verdicts.values()].some(v => v.landed)) return false;
      if ([...verdicts.values()].some(v => !v.landed) && pass < 2) return false;  // retry with only what landed
      for (const i of candidates) { const v = verdicts.get(i.id)!; i.fixed = v.landed; i.detail = v.detail; }
      const kept = [...all, ...issues];
      staged.critique = { rounds: roundNumber, from: base, at: new Date().toISOString(),
        issues: kept.map(i => ({ what: i.what, fixed: i.fixed, ...(i.fixed ? { how: `${i.change} (${i.detail})` } : i.dropped.length ? { how: i.dropped[0] } : i.detail ? { how: i.detail } : {}) })) };
      staged.critique.issues.push(...restored.map(what => ({ what, fixed: true, how: "Kept the chosen story beat." })));
      return true;
    }).catch(error => {
      const index = /^Edit (\d+) \(/.exec(error instanceof Error ? error.message : "")?.[1];
      if (!index) throw error;
      failedOwner = owners[Number(index) - 1] ?? null;
      return null;
    })).catch(plainConflict);
    if (saved) { all.push(...issues); return { ...saved, restored: restorations }; }
    if (failedOwner) {  // a fix the handlers refused: drop that issue and try the rest
      const refused = failedOwner as string[];
      if (!refused.length) break;  // keeping the person's music level failed: change nothing
      for (const i of candidates.filter(c => refused.includes(c.id))) { i.fixed = false; i.detail = "couldn't apply it"; }
      candidates = candidates.filter(c => !refused.includes(c.id));
      continue;
    }
    for (const i of candidates) { const v = verdicts.get(i.id); i.fixed = false; i.detail = worse.length ? `it made ${worse[0]} worse` : v?.detail ?? "couldn't measure it"; }
    if (worse.length) break;
    const landed = candidates.filter(i => verdicts.get(i.id)?.landed);
    if (!landed.length || landed.length === candidates.length) break;
    candidates = landed;
  }
  all.push(...issues);
  return null;
}

/** After every first cut (setting on by default): only while the person hasn't touched it yet. */
export async function improveFirstCut(root: string, cutId: string, version: number): Promise<MakeBetterResult | null> {
  if ((await getPreferences()).improveFirstCuts === false) return null;
  const { readCut } = await import("./sidekick");
  const cut = await readCut(root, cutId).catch(() => null);
  // Untouched: nothing newer was ever saved (the newest snapshot), and it is still the current revision.
  if (!cut || cut.versions.reduce((n, v) => Math.max(n, v.version), 0) !== version || cut.versions.some(v => v.critique) || await currentNow(root, cutId) !== version) return null;
  return makeBetter(root, cutId, version).catch(error => { console.warn("[make it better]", error); return null; });
}
