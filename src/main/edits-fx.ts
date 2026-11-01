import { mapTime, mapSource } from './time-map';
export { mapTime, mapSource } from './time-map';
import { pieceName } from "../shared/clip-name";
import { validTransform } from '../shared/clip-transform';
import { lockAt, lockChoice, lockRect, sanitizeLock, shownFrame, type PieceLock, type TrackFile } from '../shared/pin-keys';
import { lockTrackFor } from './tracking/lock-tracks';
import * as fs from "node:fs/promises";
import { remapLayoutRanges, sourceStart as layoutSourceStart, type LayoutSourceAdvance } from '../shared/layout-presets';
import { prepareLookSave } from "./look-saves";
import { planAudioHandles, type AudioHandle } from './join-audio';
import { planCraft, craftRect, craftAbout, craftFace, motionScale, zoomAbout, type CraftVersion, type CraftPlan } from './emphasis-framing';
import { retimeKinetic } from "./titles/captions";
import type { CutEdit, CutVersion, DraftPiece, DraftTimeline, JoinChoice, PieceFx, Word } from '../shared/schema';
import type { CutItem } from './export';
import type { StoredVersion } from './sidekick';

import { clipLaneDb, defaultClipMuted } from '../shared/lane-levels';
export type FxVersion = Pick<CutVersion, 'faceMatch' | 'transition' | 'joins' | 'pieceFx' | 'clipSoundMuted' | 'voiceover' | 'laneLevels' | 'laneMuted' | 'clipSoundDefaultOn'> & CraftVersion;
export type TimeKey = { t: number; s: number };
export type FxItem = { piece: number; startS: number; endS: number; timeMap: TimeKey[]; overlap: number; gainDb: number; muted?: boolean; soundEnabled?: boolean; reverse?: boolean; audio?: AudioHandle; exposure?: { t: number; k: number }[]; lock?: FxLock };
/** TRK2: a locked clip's lock, the track it reads and the source span its picture shows (all of its items). */
export type FxLock = { lock: PieceLock; track: TrackFile; span: [number, number] };
export type FxPlan = { items: FxItem[]; joins: NonNullable<DraftTimeline['joins']>; durationS: number; craft?: CraftPlan };
const kinds = ['cut', 'snap', 'ease', 'zoom', 'whip', 'dissolve', 'ramp'];
const sounds = ['whoosh', 'hit', 'pop', 'riser'];
export function validJoin(value: unknown): value is JoinChoice {
  const v = value as JoinChoice;
  return !!v && kinds.includes(v.kind) && (v.sound === null || sounds.includes(v.sound)) && validJoinAudio(v.audio);
}
export function validJoinAudio(value: unknown): value is JoinChoice['audio'] {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, n]) => ['leadS', 'trailS'].includes(key) && typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1.5);
}
export function validPieceFx(value: unknown): value is PieceFx {
  const v = value as PieceFx;
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    (v.transform === undefined || validTransform(v.transform)) &&
    (v.clean === undefined || ["none","remove_music","isolate_voice"].includes(v.clean)) &&
    (v.overlaySound?.clean === undefined || ["none","remove_music","isolate_voice"].includes(v.overlaySound.clean)) &&
    (v.overlaySound === undefined || typeof v.overlaySound === "object" && v.overlaySound !== null && !Array.isArray(v.overlaySound) && (v.overlaySound.muted === undefined || typeof v.overlaySound.muted === "boolean") && (v.overlaySound.gainDb === undefined || Number.isFinite(v.overlaySound.gainDb) && v.overlaySound.gainDb >= -12 && v.overlaySound.gainDb <= 12)) &&
    (v.muted === undefined || typeof v.muted === 'boolean') &&
    (v.reverse === undefined || typeof v.reverse === 'boolean') &&
    (v.speed === undefined || Number.isFinite(v.speed) && v.speed >= .1 && v.speed <= 10) &&
    (v.gainDb === undefined || Number.isFinite(v.gainDb) && v.gainDb >= -12 && v.gainDb <= 12) &&
    (v.framing === undefined || !!v.framing && ['off', 'steady', 'face'].includes(v.framing.mode) && (v.framing.tight === undefined || Number.isFinite(v.framing.tight) && v.framing.tight >= 0 && v.framing.tight <= 1)) &&
    (v.punches === undefined || validPunches(v.punches)) && (v.exposure === undefined || validExposure(v.exposure)) && (v.lock === undefined || validLock(v.lock));
}
/** TRK2: a locked frame's pick and knobs (pin-keys.ts sanitizeLock), already clamped. */
export function validLock(value: unknown): value is NonNullable<PieceFx['lock']> {
  try { return !!sanitizeLock(value); } catch { return false; }
}
export const PUNCH_MAX = 1.6;
const finite = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
/** PRO3b: a punch settles over 1 to 60 frames, creeps under 0.5% a frame. CAP4: it scales 1 to 1.6 (the inspector's
 * Punch row and Ask's hard emotional punch-in). */
export function validPunches(value: unknown): value is NonNullable<PieceFx['punches']> {
  return Array.isArray(value) && value.length <= 32 && value.every(p => !!p && typeof p === 'object' && finite(p.sourceS, 0, 1e6) && finite(p.scale, 1, PUNCH_MAX) &&
    (p.style === undefined || p.style === 'settle' || p.style === 'hold') && (p.frames === undefined || Number.isInteger(p.frames) && p.frames >= 1 && p.frames <= 60) &&
    (p.creep === undefined || finite(p.creep, 0, .005)) && (p.lengthS === undefined || finite(p.lengthS, .01, 600)));
}
/** PRO3b: an exposure key holds 1 to 30 levels, each 0.25 to 4 (1 = as graded). */
export function validExposure(value: unknown): value is NonNullable<PieceFx['exposure']> {
  return Array.isArray(value) && value.length <= 32 && value.every(e => !!e && typeof e === 'object' && finite(e.sourceS, 0, 1e6) &&
    Array.isArray(e.levels) && e.levels.length >= 1 && e.levels.length <= 30 && e.levels.every((k: unknown) => finite(k, .25, 4)));
}
const sourceRate = (c: CutItem) => c.clipFpsR.num / c.clipFpsR.den;
const sourceStart = (c: CutItem) => c.inFrames / sourceRate(c);
const sourceEnd = (c: CutItem) => c.outFrames / sourceRate(c);
const kindOf = (c: CutItem) => c.seg?.lineIndex === null ? 'broll' as const : 'voice' as const;
export function fxWords(c: CutItem): Word[] {
  return (c.seg?.speechWords ?? c.seg?.clip.transcript?.flatMap(p => p.words) ?? [])
    .filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s);
}
export function joinChoices(cuts: CutItem[], version: FxVersion): FxPlan['joins'] {
  const result: FxPlan['joins'] = [];
  for (let i = 1; i < cuts.length; i++) {
    if ((cuts[i - 1].piece ?? i - 1) === (cuts[i].piece ?? i)) continue;
    const index = result.length, between: ['voice' | 'broll', 'voice' | 'broll'] = [kindOf(cuts[i - 1]), kindOf(cuts[i])];
    const automatic: JoinChoice = between.includes('broll') ? { kind: 'cut', sound: null } :
      version.transition ?? { kind: version.faceMatch === 'off' ? 'cut' : version.faceMatch ?? 'ease', sound: null };
    const override = version.joins?.[index];
    const choice = override ?? automatic;
    if (!validJoin(choice)) throw new Error('Choose a valid transition and sound.');
    result.push({ index, atS: 0, choice: { ...choice }, auto: override == null, between });
  }
  return result;
}
/** Measured room only. Unknown voice timings cannot justify a speed ramp. */
function room(c: CutItem, edge: 'head' | 'tail'): number {
  const s = sourceStart(c), e = sourceEnd(c);
  if (kindOf(c) === 'broll') return e - s;
  const words = fxWords(c);
  if (!words.length) return 0;
  const touching = words.filter(w => w.s < e && w.e > s);
  if (!touching.length) return e - s;
  return Math.max(0, edge === 'head' ? Math.min(...touching.map(w => w.s)) - s - .03 : e - Math.max(...touching.map(w => w.e)) - .03);
}
/** The single timing plan consumed by draft pictures, sound and full export. */
export function planFx(cuts: CutItem[], fps: number, version: FxVersion = {}): FxPlan {
  const joins = joinChoices(cuts, version), heads = new Map<number, number>(), tails = new Map<number, number>();
  const overlaps = new Map<number, number>();
  let j = 0;
  for (let i = 1; i < cuts.length; i++) {
    if ((cuts[i - 1].piece ?? i - 1) === (cuts[i].piece ?? i)) continue;
    const join = joins[j++], a = cuts[i - 1], b = cuts[i];
    if (join.choice.kind === 'ramp') {
      const tail = Math.min(.2, room(a, 'tail'), (sourceEnd(a) - sourceStart(a)) / 3);
      const head = Math.min(.2, room(b, 'head'), (sourceEnd(b) - sourceStart(b)) / 3);
      if (tail + head < .2 - 1e-7 || tail < .04 || head < .04) throw new Error('This join needs at least 0.2 seconds of measured silence for a speed ramp.');
      if ([a, b].some((c, k) => kindOf(c) === 'voice' && (version.pieceFx?.[c.piece ?? i - 1 + k]?.speed ?? 1) !== 1)) throw new Error('Set voice speed to 1x before adding a silent speed ramp.');
      tails.set(i - 1, tail); heads.set(i, head);
    }
    if (join.choice.kind === 'dissolve') overlaps.set(i, Math.min(.3, a.durTimelineFrames / fps / (version.pieceFx?.[a.piece]?.speed ?? 1) / 3, b.durTimelineFrames / fps / (version.pieceFx?.[b.piece]?.speed ?? 1) / 3));
  }
  let at = 0; j = 0;
  const items = cuts.map((c, i): FxItem => {
    const piece = c.piece ?? i, fx = version.pieceFx?.[piece];
    if (fx != null && !validPieceFx(fx)) throw new Error('Choose speed from 0.1x to 10x and volume from -12 to 12 dB.');
    const speed = fx?.speed ?? 1, s = sourceStart(c), e = c.seg ? sourceEnd(c) : s + c.durTimelineFrames / fps, head = heads.get(i) ?? 0, tail = tails.get(i) ?? 0;
    const spans: { s: number; e: number; speed: number }[] = [];
    for (let n = 0; n < 5 && head; n++) spans.push({ s: s + head * n / 5, e: s + head * (n + 1) / 5, speed: speed * (2 - n / 4) });
    if (e - tail > s + head) spans.push({ s: s + head, e: e - tail, speed });
    for (let n = 0; n < 5 && tail; n++) spans.push({ s: e - tail + tail * n / 5, e: e - tail + tail * (n + 1) / 5, speed: speed * (1 + n / 4) });
    const overlap = overlaps.get(i) ?? 0;
    at -= overlap;
    if (i && piece !== (cuts[i - 1].piece ?? i - 1)) joins[j++].atS = at;
    const startS = at, timeMap: TimeKey[] = [{ t: at, s }];
    for (const span of spans) { at += (span.e - span.s) / span.speed; timeMap.push({ t: at, s: span.e }); }
    return { piece, startS, endS: at, timeMap, overlap, gainDb: clipLaneDb(version, fx?.gainDb ?? 0), muted: !!version.clipSoundMuted || (fx?.muted ?? defaultClipMuted(version,kindOf(c) === 'broll')), soundEnabled: fx?.muted === false || !!version.clipSoundDefaultOn || kindOf(c) !== 'broll', ...(fx?.reverse ? { reverse: true } : {}) };
  });
  const plan: FxPlan = { items, joins, durationS: at };
  items.forEach(item => { const keys = exposureKeys(item, fps, version.pieceFx?.[item.piece]?.exposure); if (keys) item.exposure = keys; });
  // TRK2: a locked clip steadies on its thing. Its track is in memory once tracking/lock.ts has read it; until then (or on
  // a clip played backwards) the picture is as framed.
  if (version.pieceFx?.some(fx => fx?.lock)) {
    const spans = new Map<number, [number, number]>();
    for (const item of items) { const s = item.timeMap.map(k => k.s), was = spans.get(item.piece); spans.set(item.piece, [Math.min(was?.[0] ?? Infinity, ...s), Math.max(was?.[1] ?? -Infinity, ...s)]); }
    items.forEach((item, i) => {
      const saved = version.pieceFx?.[item.piece]?.lock, track = saved && lockTrackFor(saved.track.key);
      if (!saved || !track || item.reverse || track.clipId !== cuts[i].seg?.clip.id) return;
      try { item.lock = { lock: sanitizeLock(saved)!, track, span: spans.get(item.piece)! }; } catch { /* an unreadable lock draws as framed */ }
    });
  }
  planAudioHandles(cuts, plan);
  plan.craft = planCraft(cuts, plan, fps, version);
  return plan;
}
/** PRO3b: a clip's exposure keys on its item's own frame clock (the frames the export draws): each level holds one
 * frame from the frame showing its source second, then back to 1. Keys trimmed away or on a backwards clip are left out. */
function exposureKeys(item: FxItem, fps: number, keys: PieceFx['exposure']): FxItem['exposure'] {
  if (!keys?.length || item.reverse) return undefined;
  const levels = new Map<number, number>(), first = item.timeMap[0].s, last = item.timeMap.at(-1)!.s, frames = Math.round((item.endS - item.startS) * fps);
  for (const key of keys) {
    if (!(key.sourceS >= first - 1e-6 && key.sourceS < last - 1e-6)) continue;
    const at = Math.max(0, Math.round((mapTime(item.timeMap, key.sourceS) - item.startS) * fps));
    key.levels.forEach((k, n) => { if (at + n < frames) levels.set(at + n, k); });
  }
  if (![...levels.values()].some(k => k !== 1)) return undefined;
  const frameList = [...levels.keys()].sort((a, b) => a - b), out: { t: number; k: number }[] = [];
  for (let n = frameList[0], current = 1; n <= frameList.at(-1)! + 1 && n < frames; n++) {
    const k = levels.get(n) ?? 1;
    if (k !== current) { out.push({ t: item.startS + n / fps, k }); current = k; }
  }
  return out;
}
/** Source seconds per reel second at reel second t (the segment to the right at a knot). */
function timeRate(keys: TimeKey[], t: number) {
  let i = keys.findIndex(k => k.t > t); i = i < 0 ? keys.length - 1 : Math.max(1, i);
  const a = keys[i - 1] ?? keys[0], b = keys[i] ?? keys[0];
  return (b.s - a.s) / (b.t - a.t || 1);
}
function sampleFrame(frame: NonNullable<DraftPiece['frame']>, t: number) {
  let i = frame.findIndex(k => k.t >= t); if (i < 0) i = frame.length - 1;
  if (!i) return { ...frame[0], t };
  const a = frame[i - 1], b = frame[i], u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return { t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
}
type Rect = { x: number; y: number; w: number; h: number };
/** FACE1: a face-matched cut's framing (fractions of its source, piece seconds): the matched rect it starts on, how long
 * it takes to settle (0 = holds), and the framing it settles to. */
export type MatchedFraming = { from: Rect; duration: number; planned: (t: number) => Rect | null };
/** The craft pass changes this cut item's framing (a jump-cut scale, an emphasis punch or an authored punch). */
export function craftTouches(plan: FxPlan, i: number): boolean {
  const craft = plan.craft, item = plan.items[i];
  return !!craft && !!item && (craft.scales[i] > 1 || craft.punches.some(p => p.atS < item.endS && p.endS > item.startS) || !!craft.motions?.some(m => m.item === i));
}
/** FACE1: the face-matched cuts framed in fxPictures, after the craft pass: the craft touches the cut or the one before
 * it, or the one before was framed here too (its last picture is no longer the one the match measured). */
export function matchComposes(plan: FxPlan, matched: (i: number) => MatchedFraming | undefined): boolean[] {
  const composes: boolean[] = [];
  plan.items.forEach((_, i) => composes.push(!!matched(i) && (craftTouches(plan, i) || i > 0 && (craftTouches(plan, i - 1) || composes[i - 1]))));
  return composes;
}
/** Rects are sampled after source retiming. N3 and ffmpeg consume these keys. `matched` (FACE1) gives face-matched cuts'
 * framing, so the face lands where the picture before the cut showed it, punches included. */
export function fxPictures(pictures: DraftPiece[], cuts: CutItem[], fps: number, plan: FxPlan, matched?: (i: number) => MatchedFraming | undefined): DraftPiece[] {
  const done: DraftPiece[] = [], composes = matched ? matchComposes(plan, matched) : [];
  return pictures.map((p, i) => done[i] = fxPicture(p, i));
  function fxPicture(p: DraftPiece, i: number): DraftPiece {
    if (p.layer !== 0 || !plan.items[i]) {
      const owners = plan.items.filter(c => c.piece === p.piece), owner = owners[0], old = cuts.find(c => c.piece === p.piece);
      if (!owner || !old) return p;
      const shift = owner.startS - old.offsetFrames / fps;
      return { ...p, startS: p.startS + shift, endS: Math.min(owners.at(-1)!.endS, p.endS + shift), frame: p.frame?.map(k => ({ ...k, t: k.t + shift })) ?? null };
    }
    const item = plan.items[i], end = item.endS, start = item.startS;
    const incoming = plan.joins.find(j => Math.abs(j.atS - start) < 1e-7);
    const outgoing = plan.joins.find(j => Math.abs(j.atS - (end - (plan.items[i + 1]?.overlap ?? 0))) < 1e-7);
    const effect = incoming?.choice.kind === 'zoom' || incoming?.choice.kind === 'whip' || outgoing?.choice.kind === 'zoom' || outgoing?.choice.kind === 'whip';
    const craft = plan.craft, moving = !!craft?.motions?.some(m => m.item === i), locked = item.lock;
    const crafted = craftTouches(plan, i);
    // A locked clip keeps its own framing: face matching composes only unlocked cuts.
    const match = locked ? undefined : matchedFace(i), composed = !!match;
    const times = new Set([start, end, ...item.timeMap.map(k => k.t)]);
    // TRK2: a locked clip's keys sit on the reel's own frame clock, so every output frame reads its lock exactly (a key
    // between two frames would blend the locks of two source frames: 1 to 12 px blips on the phone, 31 Oct).
    if (locked) for (let n = Math.ceil(start * fps - 1e-6); n / fps < end - 1e-9; n++) times.add(n / fps);
    else if (effect || crafted || composed) for (let t = start; t < end; t += 1 / fps) times.add(t);
    else if (item.reverse) for (let t = start; t < end; t += 1 / fps) times.add(t);
    else for (const k of p.frame ?? []) times.add(mapTime(item.timeMap, p.inS + k.t - p.startS));
    if (crafted && craft) for (const punch of craft.punches) for (const t of [punch.atS - 1 / fps, punch.atS, punch.endS - 1 / fps, punch.endS]) if (t >= start && t <= end) times.add(t);
    const blur: NonNullable<DraftPiece['blur']> = [];
    const frame = [...times].sort((a, b) => a - b).map(t => {
      const mapped = mapSource(item.timeMap, t);
      const source = item.reverse ? Math.max(item.timeMap[0].s, item.timeMap.at(-1)!.s - 1 / sourceRate(cuts[i]) - (mapped - item.timeMap[0].s)) : mapped;
      let base = sampleFrame(p.frame ?? [{ t: p.startS, x: 0, y: 0, w: 1, h: 1 }], p.startS + source - p.inS);
      // TRK2: after framing, before the punches and the clip transform: the rect under the steadied picture, sampled on
      // the source frame this output frame shows (the encoder's rounding), so the picture and its lock step together.
      if (locked) { const key = lockAt(locked.track, lockChoice(locked.lock, locked.span), shownFrame(locked.track, source, timeRate(item.timeMap, t), fps)); if (key) base = lockRect(base, key); }
      const punched = crafted && craft && !craft.rolls.some(r => t >= r.s && t < r.e);
      const zoom = punched ? craft.scales[i] * (craft.punches.some(p => t >= p.atS - 1e-8 && t < p.endS) ? craft.punchScale : 1) : 1;
      if (match) {
        // FACE1: from the matched rect (snap holds it; ease settles into the planned framing), punched about the face, so
        // the face stays where the last picture showed it and the frame tightens around it.
        const local = source - p.inS, planned = match.framing.planned(local) ?? base, from = match.from;
        const u = match.framing.duration ? Math.max(0, Math.min(1, local / match.framing.duration)) : 0, ease = u * u * (3 - 2 * u);
        base = { t: base.t, x: from.x + (planned.x - from.x) * ease, y: from.y + (planned.y - from.y) * ease, w: from.w + (planned.w - from.w) * ease, h: from.h + (planned.h - from.h) * ease };
        base = craftAbout(base, craftFace(cuts[i], source), zoom);
      } else if (punched) base = craftRect(base, cuts[i], source, zoom);
      if (moving && craft?.motions) base = zoomAbout(base, cuts[i], source, motionScale(craft.motions, i, t, fps));   // PRO3b
      let amount = 0, whip = false, direction = 0;
      for (const [join, distance, sign] of [[incoming, t - start, 1], [outgoing, end - t, -1]] as const) {
        if (!join || !['zoom', 'whip'].includes(join.choice.kind) || distance > .125) continue;
        const u = Math.max(0, 1 - distance / .125); amount = Math.max(amount, u); whip ||= join.choice.kind === 'whip'; direction = sign;
      }
      const scale = 1 + amount * (whip ? .3 : .2), w = base.w / scale, h = base.h / scale;
      blur.push({ t, amount: amount * (whip ? .035 : .012), angle: whip ? 0 : Math.PI / 4 });
      return { t, x: Math.max(0, Math.min(1 - w, base.x + (base.w - w) * (.5 + (whip ? direction * amount * .5 : 0)))), y: base.y + (base.h - h) / 2, w, h };
    });
    const unchanged = !crafted && !composed && !locked && !item.reverse && !effect && Math.abs(start - p.startS) < 1e-10 && Math.abs(end - p.endS) < 1e-10 && item.timeMap.length === 2;
    const opacity = item.overlap ? [{ t: start, a: 0 }, { t: start + item.overlap, a: 1 }, { t: end, a: 1 }] : undefined;
    return { ...p, startS: start, endS: end, timeMap: item.timeMap, frame: unchanged ? p.frame : p.frame || effect || crafted || composed || locked ? frame : null, ...(effect ? { blur } : {}), ...(opacity ? { opacity } : {}), ...(item.exposure ? { exposure: item.exposure } : {}) };
  }
  /** FACE1: the matched rect moved so the incoming face sits where the outgoing face is on the last frame before the cut,
   * measured on that frame's final rect (its punch included). Only for the cuts matchComposes picks. */
  function matchedFace(i: number) {
    const framing = matched?.(i), item = plan.items[i], before = plan.items[i - 1], shown = done[i - 1]?.frame;
    if (!framing || !composes[i] || !item || !before || !shown?.length || item.reverse || before.reverse || item.overlap) return undefined;
    const at = item.startS - 1 / fps, last = sampleFrame(shown, at);
    const a = craftFace(cuts[i - 1], mapSource(before.timeMap, at)), b = craftFace(cuts[i], mapSource(item.timeMap, item.startS));
    if (!a || !b) return undefined;
    const sx = (a.x - last.x) / last.w, sy = (a.y - last.y) / last.h;
    let { w, h } = framing.from;
    // A rect as tall (or wide) as the source cannot slide that way: tighten it a little, at most 6%, so the face can land.
    const fit = Math.min(1, ...[b.x / (sx * w), (1 - b.x) / ((1 - sx) * w), b.y / (sy * h), (1 - b.y) / ((1 - sy) * h)].filter(n => n > 0 && Number.isFinite(n)));
    if (fit < 1) { w *= Math.max(fit, 1 / 1.06); h *= Math.max(fit, 1 / 1.06); }
    const from = { x: Math.max(0, Math.min(1 - w, b.x - sx * w)), y: Math.max(0, Math.min(1 - h, b.y - sy * h)), w, h };
    return { framing, from };
  }
}
/** Invert a source-time map into ffmpeg setpts (seconds -> seconds). */
export function fxSetpts(item: FxItem): string {
  const keys = item.timeMap, s = keys[0].s;
  let expr = `${item.endS - item.startS}`;
  for (let i = keys.length - 1; i > 0; i--) {
    const a = keys[i - 1], b = keys[i], slope = (b.t - a.t) / (b.s - a.s);
    expr = `if(lt(PTS*TB,${b.s - s}),${a.t - item.startS}+(PTS*TB-${a.s - s})*${slope},${expr})`;
  }
  return `setpts='(${expr})/TB'`;
}
export function fxAudioSegments(item: FxItem): { sourceS: number; sourceE: number; speed: number }[] {
  const spans: { sourceS: number; sourceE: number; speed: number }[] = [];
  item.timeMap.slice(1).forEach((b, i) => {
    const a = item.timeMap[i], speed = (b.s - a.s) / (b.t - a.t), previous = spans.at(-1);
    if (previous && Math.abs(previous.speed - speed) < 1e-7) previous.sourceE = b.s;
    else spans.push({ sourceS: a.s, sourceE: b.s, speed });
  });
  return spans;
}
export function remapFxTime(t: number, cuts: CutItem[], fps: number, before: FxPlan, after: FxPlan): number {
  let i = before.items.findIndex(c => t >= c.startS - 1e-7 && t < c.endS - 1e-7);
  if (i < 0) return t >= before.durationS ? after.durationS : 0;
  return mapTime(after.items[i].timeMap, mapSource(before.items[i].timeMap, t));
}
export function retimeVersion(record: StoredVersion, before: FxPlan, after: FxPlan): void {
  const cuts = record.assembly.cutList, fps = record.assembly.template.fps;
  const time = (t: number) => remapFxTime(t, cuts, fps, before, after);
  if(record.layouts)record.layouts=record.layouts.map(l=>l?.kind==='scene'?{...l,s:time(l.s!),e:time(l.e!)}:l);
  if (record.angleCuts) record.angleCuts = record.angleCuts.map(c => ({...c,atS:Math.round(time(c.atS)*fps)/fps}));
  if (record.bigLines?.length || (record.titles as import("./titles/captions").CaptionTrack | undefined)?.kinetic) retimeKinetic(record, time);
  if (record.titles) record.titles = { ...record.titles, cues: record.titles.cues.map(c => ({ ...c, s: time(c.s), e: time(c.e), words: c.words?.map(w => ({ ...w, s: time(w.s), e: time(w.e) })) })) };
  const track = record.titles as import('./titles/captions').CaptionTrack | null | undefined;
  if (track?.speechOnsets) track.speechOnsets = track.speechOnsets.map(time);
  if (track?.captionSource) track.captionSource = { ...track.captionSource, words: track.captionSource.words.map(w => ({ ...w, s: time(w.s), e: time(w.e) })), faces: track.captionSource.faces.map(f => ({ ...f, s: time(f.s), e: time(f.e) })) };
  if (record.lowerThirds) record.lowerThirds = record.lowerThirds.map(o => ({ ...o, s: time(o.s), e: time(o.e) }));
  if (record.overlays) record.overlays = record.overlays.map(o => ({ ...o, s: time(o.s), e: time(o.e) }));
  if (record.soundDesign?.authored) record.soundDesign = { ...record.soundDesign, authored: record.soundDesign.authored.map(s => ({ ...s, atS: time(s.atS), ...(s.lengthS === undefined ? {} : { lengthS: Math.max(1 / 48000, time(s.atS + s.lengthS) - time(s.atS)) }) })) };
  syncFxMetadata(record, after);
}
export function syncFxMetadata(record: StoredVersion, after = planFx(record.assembly.cutList, record.assembly.template.fps, record)): void {
  record.lengthS = after.durationS;
  if (record.angleCuts) record.angleCuts = record.angleCuts.filter(c => c.atS < after.durationS);
  record.pieces = record.pieces?.map((p, index) => {
    const items = after.items.filter(i => i.piece === index);
    return items.length ? { ...p, timelineS: items[0].startS, lengthS: items.at(-1)!.endS - items[0].startS } : p;
  });
}
/** Advance pinned sources over actual edits, including removed source spans. */
export function layoutRangeAdvance(record:StoredVersion):LayoutSourceAdvance {
  const {shoot,cutList,template}=record.assembly,version={pieces:structuredClone(record.pieces)};
  const clock={pieces:planFx(cutList,template.fps,record).items.map((item,i)=>({...item,clipId:cutList[i].seg?.clip.id??'',inS:item.timeMap[0].s}))};
  return (ref,from,to)=>ref.s+layoutSourceStart(shoot,version,ref.clipId,to,ref.s+to-from,clock)-layoutSourceStart(shoot,version,ref.clipId,from,ref.s,clock);
}
/** A new draft matches source identities; structural edits provide their exact
 * old indexes so split halves and replacement takes retain the person's choice. */
function soundSourceOverlap(before:{id:string;clipId?:string;s:number;e:number}, after:typeof before):number {
  if (!before.clipId || before.clipId!==after.clipId) return 0;
  // Legacy assemblies without source bounds can only retain an exact identity.
  if (![before.s,before.e,after.s,after.e].every(Number.isFinite)) return before.id===after.id ? 1 : 0;
  const overlap=Math.max(0,Math.min(before.e,after.e)-Math.max(before.s,after.s));
  return overlap/Math.max(before.e-before.s,after.e-after.s,1e-9);
}
export function carryClipSound(previous:Pick<CutVersion,'pieces'|'pieceFx'|'clipSoundMuted'|'laneLevels'|'laneMuted'|'clipSoundDefaultOn'>, record:Pick<CutVersion,'pieces'|'pieceFx'|'clipSoundMuted'|'laneLevels'|'laneMuted'|'clipSoundDefaultOn'>, oldIndexes?:number[]) {
  // B-roll catalog ids can change on re-read; split halves can share one id.
  // Prefer the closest source span, using the catalog id only to break a tie.
  oldIndexes ??= record.pieces?.map(piece=>{
    let best=-1, score=0;
    previous.pieces?.forEach((old,index)=>{
      const match=old.kind===piece.kind ? soundSourceOverlap(old,piece) : 0;
      if (match>score || match>0 && match===score && old.id===piece.id && previous.pieces?.[best]?.id!==piece.id) {best=index;score=match;}
    });
    return best;
  }) ?? [];
  record.clipSoundDefaultOn=previous.clipSoundDefaultOn;
  record.clipSoundMuted=previous.clipSoundMuted;
  record.laneLevels=previous.laneLevels ? {...previous.laneLevels} : record.laneLevels;
  record.laneMuted=previous.laneMuted ? {...previous.laneMuted} : record.laneMuted;
  if (!previous.pieceFx) return;
  record.pieceFx=oldIndexes.map((old,index)=>{
    const sound=previous.pieceFx?.[old], fx=record.pieceFx?.[index];
    const before=previous.pieces?.[old]?.overlay, after=record.pieces?.[index]?.overlay;
    const overlaySound=before && after && soundSourceOverlap(before,after)>0 ? sound?.overlaySound : undefined;
    if (!sound || sound.muted===undefined && sound.gainDb===undefined && sound.clean===undefined && !overlaySound) return fx ?? null;
    return {...fx,
      ...(sound.clean===undefined ? {} : {clean:sound.clean}),
      ...(sound.muted===undefined ? {} : {muted:sound.muted}),
      ...(sound.gainDb===undefined ? {} : {gainDb:sound.gainDb}),
      ...(overlaySound ? {overlaySound:structuredClone(overlaySound)} : {})};
  });
}

/** Structural edits keep authored handles only when the two old neighbours
 * still meet. A new adjacency goes back to measured automatic audio (none). */
export function carryJoinCraft(previous: StoredVersion, record: StoredVersion, oldIndexes: number[]): void {
  if(previous.balances && !record.balances)record.balances=structuredClone(previous.balances);
  if(previous.balanceReference!==undefined && record.balanceReference===undefined)record.balanceReference=previous.balanceReference;
  if(previous.balanceUndo!==undefined && record.balanceUndo===undefined)record.balanceUndo=previous.balanceUndo;
  // PRO1: the edit's produced pass outlives structural edits (trim, remove, split, swap), which build their version field by field.
  if(previous.produce!==undefined && record.produce===undefined)record.produce=structuredClone(previous.produce);
  carryClipSound(previous,record,oldIndexes);
  if (previous.angleCuts) record.angleCuts = previous.angleCuts.filter(c => c.atS < record.lengthS).map(c => ({...c}));
  const media = (previous.assembly as import('./layout-media').LayoutAssembly).layoutMedia;
  if (media) Object.assign(record.assembly,{layoutMedia:structuredClone(media)});
  if (previous.layouts) record.layouts = oldIndexes.map((i,piece) => {
    const layout = previous.layouts?.[i] && previous.layouts[i]!.kind!=='scene' ? structuredClone(previous.layouts[i]) : null;
    const before=previous.pieces?.[i],after=record.pieces?.[piece];
    if (layout?.screen && before && after && before.id === after.id && before.clipId === after.clipId && after.s > before.s) layout.screen.s += (after.s-before.s)/(previous.pieceFx?.[i]?.speed ?? 1);
    return layout;
  });
  if(previous.layouts?.some(l=>l?.kind==='scene'))record.layouts=[...record.layouts??[],...remapLayoutRanges(previous.layouts,oldIndexes.flatMap((old,piece)=>{
    const a=previous.pieces?.[old],b=record.pieces?.[piece];if(!a||!b)return [];
    const offset=a.clipId===b.clipId&&a.id===b.id?Math.max(0,(b.s-a.s)/(previous.pieceFx?.[old]?.speed??1)):0;
    const scale=(record.pieceFx?.[piece]?.speed??1)/(previous.pieceFx?.[old]?.speed??1);
    return [{oldS:a.timelineS+offset,oldE:a.timelineS+offset+Math.min(a.lengthS-offset,b.lengthS*scale),s:b.timelineS,e:b.timelineS+b.lengthS}];
  }),layoutRangeAdvance(previous))];
  if (previous.lowerThirds) record.lowerThirds = structuredClone(previous.lowerThirds).filter(t => t.s < record.lengthS).map(t => ({ ...t, e: Math.min(t.e, record.lengthS) }));
  if (previous.bleeps) record.bleeps = oldIndexes.flatMap((old, piece) => (previous.bleeps ?? []).filter(b => b.piece === old).map(b => {
    if (previous.pieces?.[old]?.id === record.pieces?.[piece]?.id && previous.pieces?.[old]?.clipId === record.pieces?.[piece]?.clipId) return { ...b, piece };
    // A replacement take has different source seconds. Carry only one exact,
    // unambiguous measured phrase; never silently expose redacted speech.
    const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const oldWords = previous.assembly.cutList.filter(c => c.piece === old).flatMap(fxWords).filter(w => w.s < b.e && w.e > b.s);
    const words = record.assembly.cutList.filter(c => c.piece === piece).flatMap(c => fxWords(c).filter(w => w.s >= sourceStart(c) - 1e-6 && w.e <= sourceEnd(c) + 1e-6));
    const needle = [...new Map(oldWords.map(w => [w.s, w])).values()].map(w => normalized(w.w));
    const candidates = words.flatMap((w, i) => needle.length && needle.every((text, j) => words[i + j] && normalized(words[i + j].w) === text) ? [{ s: w.s, e: words[i + needle.length - 1].e }] : []);
    if (candidates.length !== 1) throw new Error('Could not safely carry bleeped words to the replacement take. Remove this bleep before swapping, then bleep the new words.');
    return { ...b, piece, ...candidates[0] };
  }));
  if (previous.jumpScales) record.jumpScales = oldIndexes.map(i => previous.jumpScales?.[i] ?? null);
  if (previous.joins?.some(j => j?.audio)) record.joins = oldIndexes.slice(1).map((right, i) =>
    right === oldIndexes[i] + 1 ? previous.joins?.[oldIndexes[i]] ?? null : null);
  if (previous.transition?.audio) record.transition = structuredClone(previous.transition);
}
export const fxReadme = 'Reverse is in the finished video with the reversed clip sound muted. Resolve receives reverse time maps; confirm reverse playback and muted sound after import. Other editor paths may keep forward clips: reapply reverse from the saved clip effects when unsupported. Speed, ramps, transitions, clip volume, clip look overrides and transition sounds are in the finished video. Resolve keeps original ungraded media, so reapply clip looks there. Reapply effects listed in joins.json when the editor cannot carry them.';
export async function editFx(root: string, cutId: string, version: number, edit: Extract<CutEdit, { kind: 'pieceFx' | 'join' }>) {
  return prepareLookSave(root,cutId,async () => {
  const { normalizePieceLook } = await import('./grade');
  const { runActivity, withRenderSlot } = await import('./activity');
  const { finishStoredVersion, renderStoredPreview, savePlaybackChange, PREVIEW_REV } = await import('./sidekick');
  const save = (base: number) => runActivity({ kind: 'edit', root, target: { cutId, version: base }, label: 'Updating clip effects', cancelable: true }, activity =>
    finishStoredVersion(root, cutId, base, true, async (record, assembly, baseVersion) => {
      record.assembly = assembly;
      const before = planFx(assembly.cutList, assembly.template.fps, record);
      if (edit.kind === 'pieceFx') {
        if (!Number.isInteger(edit.piece) || !before.items.some(p => p.piece === edit.piece)) throw new Error('Choose a clip in this cut.');
        if (edit.fx !== null && !validPieceFx(edit.fx)) throw new Error('Choose speed from 0.1x to 10x and volume from -12 to 12 dB.');
        const fx = lookOnly && edit.kind === 'pieceFx' ? { ...record.pieceFx?.[edit.piece], look: edit.fx?.look }
          : soundOnly && edit.kind === 'pieceFx' ? { ...record.pieceFx?.[edit.piece], ...soundPatch } : edit.fx && structuredClone(edit.fx);
        if (fx) {
          const look = normalizePieceLook(fx.look);
          if (look) fx.look = look; else delete fx.look;
          if (!soundOnly && fx.background !== undefined) {
            const { normalizeBackground } = await import('./backgrounds');
            fx.background = await normalizeBackground(root, fx.background);
          }
        }
        record.pieceFx = [...record.pieceFx ?? []];
        record.pieceFx[edit.piece] = fx && Object.keys(fx).length ? fx : null;
        if(lookChanged && edit.kind === 'pieceFx') {
          await (await import('./balance')).saveHandBalance(root,record,edit.piece,fx?.look?.basic);
        }
      } else {
        if (!Number.isInteger(edit.join) || !before.joins[edit.join]) throw new Error('Choose a join in this cut.');
        if (edit.choice !== null && !validJoin(edit.choice)) throw new Error('Choose a valid transition and sound.');
        record.joins = [...record.joins ?? []]; record.joins[edit.join] = edit.choice && { ...edit.choice };
      }
      const after = planFx(assembly.cutList, assembly.template.fps, record);
      if (edit.kind === 'join') (await import('./sound-attachments')).setJoinSound(record, after, edit.join, edit.choice?.sound ?? null);
      retimeVersion(record, before, after);
      record.feedback = edit.kind === 'join' ? `Updated transition${after.joins[edit.join]?.choice.audio ? `: J ${after.joins[edit.join].choice.audio!.leadS ?? 0} s, L ${after.joins[edit.join].choice.audio!.trailS ?? 0} s, measured from word timings` : ''}` : 'Updated clip settings';
      if (soundOnly) record.feedback = 'Changed clip sound';
      else if (edit.kind === 'pieceFx' && edit.fx?.background !== undefined) record.feedback = `Background ${record.pieceFx?.[edit.piece]?.background?.mode ?? 'off'} on ${pieceName(record.assembly.shoot, record, edit.piece)}`;
      else if (edit.kind === 'pieceFx' && JSON.stringify(edit.fx?.lock ?? null) !== JSON.stringify(source?.pieceFx?.[edit.piece]?.lock ?? null))   // TRK2
        record.feedback = edit.fx?.lock ? `Locked the frame${edit.fx.lock.thing ? ` on the ${edit.fx.lock.thing}` : ''}` : 'Unlocked the frame';
      if (!assembly.reel.why.includes(fxReadme)) assembly.reel.why += `\n\n${fxReadme}`;
      if (soundOnly) record.previewRev = PREVIEW_REV;
      else await renderStoredPreview(root, cutId, record, assembly);
      return { cutId, version: record.version, baseVersion };
    }, lookOnly || soundOnly));
  // The Look panel sends the existing clip effects plus its changed look.
  const { cutFile, stagedDraft, loadDraftVersion } = await import('./sidekick');
  // PRO1: inside a batch the version is the staged draft's number, which is not on disk (or is another, undone snapshot):
  // compare against the draft itself, or a sound-only change merges onto the wrong clip settings.
  const source = stagedDraft() ? await loadDraftVersion(root, cutId, version)
    : await (await import('./cut-storage')).readStoredVersion(cutFile(root, cutId), version) as unknown as import('./sidekick').StoredVersion | undefined;  // ARCH2: one line of the log
  if(edit.kind==='pieceFx') {
    const previous=source?.pieceFx?.[edit.piece];
    if(edit.fx?.clean && edit.fx.clean!=='none' && edit.fx.clean!==previous?.clean || edit.fx?.overlaySound?.clean && edit.fx.overlaySound.clean!=='none' && edit.fx.overlaySound.clean!==previous?.overlaySound?.clean) await (await import('./stem-mix')).requireSoundSeparation();
  }
  const lookChanged=edit.kind==='pieceFx' && JSON.stringify(edit.fx?.look)!==JSON.stringify(source?.pieceFx?.[edit.piece]?.look);
  if(lookChanged && edit.kind==='pieceFx') {
    const clipId=source?.pieces?.[edit.piece]?.clipId ?? source?.assembly.cutList.find((c,i)=>(c.piece ?? i)===edit.piece)?.seg?.clip.id;
    if(clipId)await (await import('./balance')).balanceHand(root,clipId).catch(()=>{});
  }
  const withoutLook = (fx: import('../shared/schema').PieceFx | null | undefined) => { const next = { ...fx }; delete next.look; return JSON.stringify(next); };
  const lookOnly = edit.kind === 'pieceFx' && withoutLook(edit.fx) === withoutLook(source?.pieceFx?.[edit.piece]);
  const soundKeys = ['gainDb', 'muted', 'overlaySound', 'clean'] as const;
  const withoutSound = (fx: import('../shared/schema').PieceFx | null | undefined) => { const next = { ...fx }; for (const key of soundKeys) delete next[key]; return JSON.stringify(next); };
  const soundOnly = edit.kind === 'pieceFx' && withoutSound(edit.fx) === withoutSound(source?.pieceFx?.[edit.piece]) && !lookOnly;
  const soundPatch = edit.kind === 'pieceFx' ? Object.fromEntries(soundKeys.filter(key => JSON.stringify(edit.fx?.[key]) !== JSON.stringify(source?.pieceFx?.[edit.piece]?.[key])).map(key => [key, edit.fx?.[key]])) : {};
  return { result: soundOnly ? savePlaybackChange(root, cutId, version, save) : lookOnly ? savePlaybackChange(root, cutId, version, save) : save(version) };
  });
}
