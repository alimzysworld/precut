// AV1 (stage 1): one decision and one composition plan for the Apple player.
// The Chrome viewer (LivePlayer, liveTimeline, liveMix) stays the source of
// truth for what plays when. This module only reads a DraftTimeline and its
// LiveSound plan and says, in plain words, whether AVFoundation can show the
// same edit today, and if so which file spans, levels and crops it must play.
// No file access and no DOM here, so the renderer, main and tests share it.

import type { ClipTransform, DetailChoice, DraftPiece, DraftTimeline, GrainChoice, LiveSoundPiece, VignetteChoice } from "./schema";
import { transformGeometry } from "./clip-transform";
import { duckGainAt, musicDuckKeys, stemDuckKeys } from "./music-duck";
import { laneDb, laneMuted, duckedUnder, heardPiece, mixOutputDb, musicEnd, musicStems } from "./lane-levels";
import { blurAt, frameAtTime, opacityAt } from "./picture-keys";
import { gradientParameters, rgb } from "./layout-effects";
import { TITLE_CARD_BASE, type LayoutPicture } from "../main/layout-math";
import type { LayoutBackground } from "./layout-presets";

export type ApplePlayerKind = "apple" | "chrome";

export interface ApplePlaybackState {
  player: ApplePlayerKind;
  /** Plain line for under the viewer and for MCP. Sentence case, no dashes. */
  reason: string;
  appleEnabled: boolean;
}

export interface AppleEligibilityInput {
  appleEnabled: boolean;
  /** Kept for callers from stage 1. Since AV2 the Look plays natively, so this no longer decides. */
  lookActive?: boolean;
}

export const APPLE_OFF_REASON = "Apple player is off. Turn it on in Settings, Playback.";
export const APPLE_ON_REASON = "Apple player";
/** Stage 1 wording, kept so saved state files and older tests still read. AV2 plays the Look natively. */
export const APPLE_LOOK_REASON = "Apple player is off for this edit: Look comes in the next update";
export const APPLE_LAYOUT_REASON = "Apple player is off for this edit: layouts come in a later update";
export const APPLE_OVERLAY_REASON = "Apple player is off for this edit: overlays come in a later update";
export const APPLE_SPEED_REASON = "Apple player is off for this edit: speed changes come in a later update";
/** AV3: speed and ramps play natively; a clock that runs backwards inside a piece does not (a reversed clip has its own file). */
export const APPLE_REVERSE_REASON = "Apple player is off for this edit: a clip that plays backwards comes in a later update";
export const APPLE_TRANSITION_REASON = "Apple player is off for this edit: transitions come in a later update";
export const APPLE_TRANSFORM_REASON = "Apple player is off for this edit: transforms come in a later update";
export const APPLE_BLEEP_REASON = "Apple player is off for this edit: bleeps come in a later update";
export const APPLE_PREVIEW_REASON = "Apple player is off for this edit: a preview is still being made";
export const APPLE_EMPTY_REASON = "Apple player is off for this edit: there is no picture to play";
export const APPLE_FILE_REASON = "Apple player is off for this edit: a picture or sound file is not ready";
export const APPLE_UNAVAILABLE_REASON = "Apple player could not start on this Mac. The standard player plays this edit.";

/** The piecewise linear reel to source rule, the same one liveTimeline uses. */
export function appleSourceTime(piece: Pick<DraftPiece, "startS" | "inS" | "timeMap">, time: number): number {
  if (!piece.timeMap?.length) return piece.inS + time - piece.startS;
  const keys = piece.timeMap;
  const right = keys.findIndex(k => k.t > time);
  const i = right < 0 ? keys.length - 2 : Math.max(0, right - 1);
  const a = keys[Math.max(0, i)], b = keys[Math.min(keys.length - 1, Math.max(0, i) + 1)];
  const mix = Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t || 1)));
  return a.s + (b.s - a.s) * mix;
}

function timeMapRate(keys: { t: number; s: number }[] | undefined, fallbackLength: number): number[] {
  if (!keys || keys.length < 2) return [1];
  const rates: number[] = [];
  for (let i = 1; i < keys.length; i++) rates.push((keys[i].s - keys[i - 1].s) / (keys[i].t - keys[i - 1].t || 1));
  return rates.length ? rates : [fallbackLength > 0 ? 1 : 1];
}

/** AV3: true when a clock is plain 1x (nothing for the composition to scale). */
export function plainClock(keys: { t: number; s: number }[] | undefined): boolean {
  return timeMapRate(keys, 0).every(r => Number.isFinite(r) && Math.abs(r - 1) <= 0.001);
}

/**
 * AV3: a piece's clip transform as the Chrome viewer's shader takes it (transformGpu paintTransform: clipAffine is
 * cos/scale, sin/scale, x, y; clipCrop l, t, r, b; clipFlip), then the output aspect it was solved for. The maths is
 * transformGeometry (src/shared/clip-transform.ts), the one the viewer and the export read; this only packs its
 * numbers in the uniforms' order for the Apple compositor, which runs the viewer's own clipPoint (apple-shader.ts).
 * Null when the piece has no transform (the viewer then draws it untransformed too).
 */
export function appleTransformNumbers(transform: ClipTransform | undefined | null, aspect: number): number[] | null {
  if (!transform) return null;
  const g = transformGeometry(transform, aspect);
  return [g.c / g.scale, g.s / g.scale, g.x, g.y, g.crop.l, g.crop.t, g.crop.r, g.crop.b, g.flipH ? 1 : 0, g.flipV ? 1 : 0, g.aspect];
}

/** Decide per edit, before any file is touched. The first matching reason wins. AV4: layouts, the overlay lane,
 * every join (dissolve, whip, ease, zoom, snap, their motion blur), overlays and lower thirds (drawn by the page's
 * titles layer above the picture) and bleeps play natively. What still hands over says why. */
export function applePlayerDecision(timeline: DraftTimeline, input: AppleEligibilityInput): ApplePlaybackState {
  const chrome = (reason: string): ApplePlaybackState => ({ player: "chrome", reason, appleEnabled: input.appleEnabled });
  if (!input.appleEnabled) return chrome(APPLE_OFF_REASON);
  // AV2: the Look (grade, balances, LUT, grain, detail, vignette) plays in the Apple compositor.
  const pieces = timeline.pieces ?? [];
  if (!pieces.some(p => p.layer === 0 && p.endS > p.startS)) return chrome(APPLE_EMPTY_REASON);
  for (const piece of pieces) {
    if (piece.clipId && !piece.proxy) return chrome(APPLE_PREVIEW_REASON);
    // AV3: speed, ramps and holds play natively; a clock running backwards does not.
    const rates = timeMapRate(piece.timeMap, piece.endS - piece.startS);
    if (rates.some(r => !Number.isFinite(r))) return chrome(APPLE_SPEED_REASON);
    if (rates.some(r => r < -0.001)) return chrome(APPLE_REVERSE_REASON);
  }
  for (const piece of timeline.liveSound?.pieces ?? []) if (timeMapRate(piece.timeMap, 0).some(r => !Number.isFinite(r) || r < -0.001)) return chrome(APPLE_REVERSE_REASON);
  return { player: "apple", reason: APPLE_ON_REASON, appleEnabled: true };
}

/** AV4: one moment of a picture layer as the viewer draws it (LivePlayer drawLayer), every number from the viewer's
 * own functions (frameAtTime, opacityAt, blurAt, visualLayout): its framing rect (null: fitted), its layout region
 * (null: the whole frame), its dissolve opacity and layout shape opacity, its blur vector (in the viewer's shader
 * units), its corner radius in output pixels and its mask's pixel size. */
export interface AppleLayerKey { t: number; rect: number[] | null; region: number[] | null; opacity: number; shape: number; blur: [number, number]; radius: number; pixels: [number, number] }
/** AV4: a layout background as the viewer's backdrop pass takes it (layout-effects gradientParameters): kind 0 a
 * gradient or colour, 1 the layer's own picture, 2 an image; blur and dim as its uniforms; stops in linear 0..1. */
export interface AppleLayerBackground { kind: 0 | 1 | 2; blur: number; dim: number; stops: number[][]; direction: [number, number]; image?: string }
/** AV4: how one picture piece is drawn: its draw order and scene (the viewer's group), its masks, its dim card, its
 * background, its quarter turn and its keys over time. The player interpolates between keys; every key is a moment
 * the viewer's own functions were sampled at (every knot of every key list, so the straight lines between are exact). */
export interface AppleLayerPlan {
  order: number; owner: string; region: boolean; circle: boolean; sceneMask: boolean; dim: boolean; colour: number[];
  background: AppleLayerBackground | null;
  /** rect: the keys' rect; centre: a damaged index with no framing keys, centre crop by the decoded picture's aspect. */
  framing: "rect" | "centre";
  turn: number;
  keys: AppleLayerKey[];
}

/** The viewer's layout of a picture at a moment (renderer layoutPreview visualLayout, the function LivePlayer draws
 * with): the page passes its own, so the plan reads the very numbers the viewer draws. */
export type AppleVisualLayout = (p: LayoutPicture, time: number, w: number, h: number) => { region?: { x: number; y: number; w: number; h: number }; circle: boolean; radius: number; opacity: number; background?: LayoutBackground; image?: string; order: number };
/** Without the page's function (a plan made in main alone, tests): the saved layout as the piece carries it. */
const savedLayout: AppleVisualLayout = p => ({ region: p.layoutRegion, circle: !!p.layoutCircle, radius: p.layoutRadius ?? 0, opacity: 1, background: p.layoutBackground, image: p.layoutImage, order: p.layer });

/** AV4: the output shape a piece's transform is solved for: its layout region's (as LivePlayer passes it to
 * paintTransform), else the frame's. */
export function appleRegionAspect(plan: Pick<AppleLayerPlan, "keys"> | null | undefined, timeline: Pick<DraftTimeline, "width" | "height">): number {
  const region = plan?.keys[0]?.region;
  return region ? region[2] * timeline.width / (region[3] * timeline.height) : timeline.width / timeline.height;
}

/** AV4: a picture piece's layer plan, from the viewer's own functions at every knot of its keys. `turn` is the
 * picture's quarter turn as the viewer draws it (pictureTurn). The background image rides as its URL; main swaps in
 * its file. */
export function appleLayerPlan(piece: DraftPiece, timeline: Pick<DraftTimeline, "width" | "height">, turn = 0, visualLayout: AppleVisualLayout = savedLayout): AppleLayerPlan {
  const p = piece as LayoutPicture, width = timeline.width, height = timeline.height;
  const times = new Set<number>([piece.startS, piece.endS]);
  const within = (t: number) => t > piece.startS && t < piece.endS;
  for (const list of [piece.frame, piece.opacity, piece.blur, p.layoutRegionKeys, p.layoutShapeKeys] as ({ t: number }[] | null | undefined)[]) for (const k of list ?? []) if (within(k.t)) times.add(k.t);
  const at = (t: number): AppleLayerKey => {
    const visual = visualLayout(p, t, width, height), region = visual.region ?? null;
    const rect = frameAtTime(piece, t), blur = blurAt(piece, t);
    // LivePlayer drawLayer: layoutPixels, the radius in output pixels and the blur vector, as it sets its uniforms.
    const pixels: [number, number] = p.layoutScene ? [Math.round(width * (region?.w ?? 1)), Math.round(height * (region?.h ?? 1))] : [960 * (region?.w ?? 1), 960 * height / width * (region?.h ?? 1)];
    return { t, rect: rect ? [rect.x, rect.y, rect.w, rect.h] : null, region: region ? [region.x, region.y, region.w, region.h] : null,
      opacity: opacityAt(piece, t), shape: visual.opacity, blur: [Math.cos(blur.angle) * blur.amount, Math.sin(blur.angle) * blur.amount * width / height],
      radius: visual.radius * width / (p.layoutReferenceWidth ?? width), pixels };
  };
  const keys = [...times].sort((a, b) => a - b).map(at);
  // A piece whose numbers never change keeps one key.
  const same = (a: AppleLayerKey, b: AppleLayerKey) => JSON.stringify({ ...a, t: 0 }) === JSON.stringify({ ...b, t: 0 });
  const kept = keys.every(k => same(k, keys[0])) ? [keys[0]] : keys;
  const first = visualLayout(p, piece.startS, width, height), bg = first.background;
  let background: AppleLayerBackground | null = null;
  if (bg) {
    const g = gradientParameters(bg);
    background = { kind: bg.kind === "screen" ? 1 : bg.kind === "image" ? 2 : 0, blur: (bg.blur ?? 0) * 0.0005, dim: g.dim, stops: g.colours, direction: [g.cos, g.sin], ...(first.image ? { image: first.image } : {}) };
  }
  return { order: first.order, owner: piece.piece !== undefined ? String(piece.piece) : `${piece.clipId}:${piece.startS}`, region: !!p.layoutRegion, circle: first.circle, sceneMask: !!p.layoutScene,
    dim: !!p.layoutDim, colour: rgb(p.layoutColour ?? TITLE_CARD_BASE), background, framing: piece.frame?.length === 0 ? "centre" : "rect", turn: ((turn % 360) + 360) % 360, keys: kept };
}

/**
 * AV2: one piece's Look as numbers, never a second copy of the grade maths.
 * `uniform`: `lutFile` holds the base table from `liveLut` (raw Float32, red
 * fastest, `lutSize` cubed by 3) and the compositor applies exposure, basics,
 * the look parameters and the mixer with the same values the Chrome viewer
 * sends its shader. `full`: `lutFile` holds the piece's whole composed table
 * from `liveLut`, for a piece with no live recipe. A live slider drag replaces
 * only these numbers (see the look update in apple-player), never the picture.
 */
export interface AppleSegmentLook {
  /** pending: its tables are still being read (the player holds its picture there until they arrive). */
  mode: "uniform" | "full" | "pending";
  lutFile: string; lutSize: number;
  params?: number[]; basic?: number[]; mixer?: number[];
  exposure?: [number, number, number];
  diffusion?: number;
}

/** AV2: the edit-wide finish the compositor draws after the grade. Same choices the Chrome viewer draws; `scoped`
 * is the viewer's per piece diffusion rule (scopedDiffusion), decided by the viewer. */
export interface AppleFinishPlan { grain: GrainChoice | null; vignette: VignetteChoice | null; detail: DetailChoice | null; scoped?: boolean }

/** AV2: one picture piece's Look as the viewer shows it now: where it sits (its start, as in the plan), its colour
 * table id, and the numbers the viewer's shader takes. Without numbers (its recipe not read yet), main uses the
 * recipe's own. */
export interface AppleLookSegment { start: number; lutId: string | null; diffusion: number | null; params?: number[]; basic?: number[]; mixer?: number[]; exposure?: number[]
  /** AV3: the piece's clip transform as the viewer draws it now (a drag's preview included), appleTransformNumbers. */
  transform?: number[] | null;
  /** AV4: its lane (pieces on two lanes can start together); absent is the spine. */
  layer?: number }
/** AV2: the whole Look the viewer is showing, sent with the plan and again on every change. `bypass`: Look off (Shift+D). */
export interface AppleLookPayload { segments: AppleLookSegment[]; finish: AppleFinishPlan | null; bypass: boolean; version?: number; sentAt?: number }

/** AV2: bus processing the mixed segments cannot carry: the voice EQ, whether effects level under voice (Audio Auto),
 * and the mix's output level every segment carries (the voice is measured before it, as the Chrome analyser does). */
export interface AppleSoundPlan { eq: [number, number, number]; auto: boolean; outDb?: number }

export interface AppleVideoSegment {
  file: string;
  timelineStart: number; timelineEnd: number;
  sourceStart: number; sourceEnd: number;
  crop: { x: number; y: number; w: number; h: number } | null;
  rotation: number;
  clipId: string;
  /** The piece's `liveLut` id, so main resolves the same table the Chrome viewer shows. */
  lutId?: string;
  look?: AppleSegmentLook | null;
  /** AV3: reel to file seconds, only when the clock is not plain 1x (speed, a ramp, a hold). */
  timeMap?: { t: number; s: number }[];
  /** AV3: the saved clip transform, appleTransformNumbers (a live drag's numbers arrive with the Look). */
  transform?: number[];
  /** AV4: the piece's lane (0 the spine, 1 the overlay lane, 2 and 3 a layout's outgoing pictures). */
  layer?: number;
  /** AV4: how it is drawn over time (appleLayerPlan). */
  visual?: AppleLayerPlan;
}

export interface AppleAudioSegment {
  file: string;
  timelineStart: number; timelineEnd: number;
  sourceStart: number; sourceEnd: number;
  gainDb: number;
  fadeInS?: number; fadeOutS?: number;
  /** AV4: "tone" is a bleep's beep, heard as the viewer plays it (into the mix's output, not under the voice). */
  kind: "clip" | "voiceover" | "music" | "effect" | "tone";
  volumeKeys?: { t: number; gain: number }[];
  /** A looped effect (room tone): the file repeats to fill the span. */
  loop?: boolean;
  /** AV3: reel to file seconds when the sound's clock is not plain 1x (it keeps its pitch). */
  timeMap?: { t: number; s: number }[];
}

/** One placed voice line as the Chrome viewer schedules it (liveTimeline.voicePlayback): reel span, file offset, join fades. */
export interface AppleVoicePiece { id: string; url: string; startS: number; endS: number; offset: number; fadeInS: number; fadeOutS: number }

export interface AppleManifest {
  version: 1;
  width: number; height: number; fps: number; durationS: number;
  video: AppleVideoSegment[];
  audio: AppleAudioSegment[];
  finish?: AppleFinishPlan | null;
  sound?: AppleSoundPlan;
  /** AV2: the Look shader (src/main/apple-shader.ts): the viewer's GLSL in Metal, compiled once per run by its hash. */
  shader?: { source: string; hash: string; detailSteps: number[] };
}

const gainOf = (db: number) => 10 ** (db / 20);

/** AV4: the shortest picture piece the plan carries. */
export const APPLE_MIN_PIECE_S = 0.0001;
/** AV4: the bleep tone's file (main writes one second of 1 kHz, a whole number of cycles, so it loops cleanly). */
export const APPLE_BEEP_URL = "apple:beep";
/** liveMix moves a bleep's levels with a 5 ms time constant (setTargetAtTime): a 5 ms ramp here. */
export const APPLE_BLEEP_FADE_S = 0.005;
/** AV4: a spine sound piece's level over its span (keys from its start, 0..1 of its gain): its fades, and silence
 * under each bleep, as liveMix plays it (spanGain, redacted). Null when no bleep touches it. */
export function appleBleepKeys(piece: Pick<LiveSoundPiece, "startS" | "endS" | "fadeInS" | "fadeOutS">, bleeps: { s: number; e: number }[]): { t: number; gain: number }[] | null {
  const near = bleeps.filter(b => b.e > piece.startS && b.s < piece.endS);
  if (!near.length) return null;
  const f = APPLE_BLEEP_FADE_S;
  const fade = (t: number) => Math.max(0, Math.min(1, piece.fadeInS ? (t - piece.startS) / piece.fadeInS : 1, piece.fadeOutS ? (piece.endS - t) / piece.fadeOutS : 1));
  const hole = (t: number) => Math.min(1, ...near.map(b => t <= b.s ? 1 : t <= b.s + f ? 1 - (t - b.s) / f : t <= b.e ? 0 : t <= b.e + f ? (t - b.e) / f : 1));
  const times = new Set([piece.startS, piece.endS, piece.startS + (piece.fadeInS ?? 0), piece.endS - (piece.fadeOutS ?? 0), ...near.flatMap(b => [b.s, b.s + f, b.e, b.e + f])]);
  return [...times].filter(t => t >= piece.startS && t <= piece.endS).sort((a, b) => a - b).map(t => ({ t: t - piece.startS, gain: fade(t) * hole(t) }));
}

/** File spans for one sound piece. Null when its clock runs backwards (the decision hands those to Chrome). AV3: a
 * clock that is not plain 1x (speed, a ramp, a hold) rides along in file seconds. */
function audioSpan(piece: LiveSoundPiece): { timelineStart: number; timelineEnd: number; sourceStart: number; sourceEnd: number; timeMap?: { t: number; s: number }[] } | null {
  const keys = piece.timeMap?.length ? piece.timeMap : [{ t: piece.startS, s: piece.startS }, { t: piece.endS, s: piece.endS }];
  if (timeMapRate(keys, piece.endS - piece.startS).some(r => !Number.isFinite(r) || r < -0.001)) return null;
  const offset = piece.sourceStart ?? 0;
  return { timelineStart: piece.startS, timelineEnd: piece.endS, sourceStart: keys[0].s - offset, sourceEnd: keys[keys.length - 1].s - offset,
    ...(plainClock(keys) ? {} : { timeMap: keys.map(k => ({ t: k.t, s: k.s - offset })) }) };
}

/**
 * Build the AVFoundation plan from the same timeline and mix the Chrome viewer
 * plays. `fileFor` maps a media URL to a file on disk, or null when it is not
 * ready. Rotation is degrees clockwise for the piece, as the viewer shows it.
 * `voice` is the placed voice exactly as the Chrome viewer schedules it; without
 * it the plan's own voiceover pieces stand in. Levels follow the shared live mix
 * rules (src/shared/lane-levels.ts): lanes, even out, output level, music fade.
 */
export function buildAppleManifest(
  timeline: DraftTimeline,
  fileFor: (url: string) => string | null,
  rotationFor: (piece: DraftPiece) => number = () => 0,
  voice?: AppleVoicePiece[],
  /** AV4: each picture piece's layer plan as the page made it (appleLayerPlan with the viewer's visualLayout), by
   * index into timeline.pieces; a missing one is made here from the saved layout. */
  layers?: (AppleLayerPlan | null | undefined)[],
): AppleManifest | null {
  const sound = timeline.liveSound;
  const video: AppleVideoSegment[] = [];
  const order = timeline.pieces.map((piece, index) => ({ piece, index })).sort((a, b) => a.piece.startS - b.piece.startS || a.piece.layer - b.piece.layer);
  for (const { piece, index } of order) {
    // A sliver shorter than a tenth of a millisecond (an edit's rounding at a layout's edge) shows no picture in the
    // viewer, and a composition cannot hold one (AVFoundation refuses an empty time range: -12780).
    if (piece.endS - piece.startS < APPLE_MIN_PIECE_S) continue;
    if (!piece.clipId) continue; // A black gap: the composition leaves it black.
    const file = fileFor(piece.proxy);
    if (!file) return null;
    const frame = piece.frame?.length ? piece.frame.reduce((best, k) => (k.t <= piece.startS + 1e-6 ? k : best), piece.frame[0]) : null;
    // A frame that is the whole picture needs no composition work at all.
    const crop = frame && (frame.x > 0.001 || frame.y > 0.001 || frame.w < 0.999 || frame.h < 0.999)
      ? { x: frame.x, y: frame.y, w: frame.w, h: frame.h } : null;
    const rotation = ((rotationFor(piece) % 360) + 360) % 360;
    const visual = layers?.[index] ?? appleLayerPlan(piece, timeline, rotation);
    // The viewer solves a piece's transform for its layout region's shape (paintTransform with the region's aspect).
    const transform = appleTransformNumbers(piece.transform, appleRegionAspect(visual, timeline));
    if (visual.background?.image) {
      // The background image's file (the page names it by URL).
      const image = fileFor(visual.background.image);
      if (!image) return null;
      visual.background = { ...visual.background, image };
    }
    video.push({
      file, timelineStart: piece.startS, timelineEnd: piece.endS,
      sourceStart: appleSourceTime(piece, piece.startS), sourceEnd: appleSourceTime(piece, piece.endS),
      crop,
      rotation, clipId: piece.clipId,
      lutId: piece.lut,
      ...(piece.timeMap?.length && !plainClock(piece.timeMap) ? { timeMap: piece.timeMap.map(k => ({ t: k.t, s: k.s })) } : {}),
      ...(transform ? { transform } : {}),
      layer: piece.layer,
      visual,
    });
  }
  if (!video.length) return null;
  const audio: AppleAudioSegment[] = [];
  if (sound) {
    const outDb = mixOutputDb(sound);
    const pushSound = (piece: LiveSoundPiece, kind: AppleAudioSegment["kind"], laneGainDb = 0) => {
      if (piece.muted || piece.endS <= piece.startS) return true;
      const span = audioSpan(piece);
      const file = fileFor(piece.url);
      if (!span || !file) return false;
      audio.push({ file, ...span, gainDb: piece.gainDb + laneGainDb + outDb, fadeInS: piece.fadeInS, fadeOutS: piece.fadeOutS, kind, ...(piece.loop ? { loop: true } : {}) });
      return true;
    };
    // Clip sound, as the Chrome viewer hears it (levels, even out, Clean). Placed voice plays from its own schedule.
    // AV4: a spine piece is silent under a bleep (liveMix: redacted), and the bleep's beep plays over it.
    for (const original of sound.pieces) {
      if (original.id.startsWith("voiceover:")) continue;
      const heard = heardPiece(sound, original), count = audio.length;
      if (!pushSound(heard, "clip")) return null;
      if (audio.length > count && (heard.layer ?? 0) === 0) {
        const keys = appleBleepKeys(heard, sound.bleeps ?? []);
        if (keys) audio[audio.length - 1].volumeKeys = keys;
      }
    }
    const beeps = (sound.bleeps ?? []).filter(b => b.sound === "beep" && b.e > b.s);
    if (beeps.length) {
      const file = fileFor(APPLE_BEEP_URL);
      if (!file) return null;
      // liveMix updateBleep: a 1 kHz tone at SQRT2 * 0.1 times the clip sound lane, into the mix's output.
      for (const b of beeps) audio.push({ file, timelineStart: b.s, timelineEnd: b.e, sourceStart: 0, sourceEnd: b.e - b.s, loop: true,
        gainDb: 20 * Math.log10(Math.SQRT2 * 0.1) + laneDb(sound, "clip-sound") + outDb, fadeInS: APPLE_BLEEP_FADE_S, fadeOutS: APPLE_BLEEP_FADE_S, kind: "tone" });
    }
    const narrationMuted = laneMuted(sound, "voice");
    if (voice) {
      if (!narrationMuted) for (const line of voice) {
        if (line.endS <= line.startS) continue;
        const file = fileFor(line.url);
        if (!file) return null;
        audio.push({ file, timelineStart: line.startS, timelineEnd: line.endS, sourceStart: line.offset, sourceEnd: line.offset + (line.endS - line.startS),
          gainDb: laneDb(sound, "voice") + outDb, fadeInS: line.fadeInS, fadeOutS: line.fadeOutS, kind: "voiceover" });
      }
    } else {
      for (const original of sound.pieces) {
        if (!original.id.startsWith("voiceover:")) continue;
        if (!pushSound(heardPiece(sound, original), "voiceover")) return null;
      }
    }
    // Effects on their bus: its lane level and mute.
    if (!laneMuted(sound, "effects")) for (const piece of sound.effects ?? []) {
      if (!pushSound(piece, "effect", laneDb(sound, "effects"))) return null;
    }
    const music = sound.music;
    if (music && !laneMuted(sound, "music")) {
      const { endS: musicEndS, fadeOutS } = musicEnd(sound);
      const endS = Math.min(timeline.durationS, musicEndS);
      if (endS > 0) {
        const keys = music.duck === false ? [] : musicDuckKeys(duckedUnder(sound, narrationMuted), sound.durationS, music.duckDepthDb);
        // The music's level over time: its duck and its fade to the end, sampled where the shape bends.
        const shaped = (stem?: "vocals" | "other" | "drums" | "bass") => {
          const duck = stem ? stemDuckKeys(keys, stem) : keys;
          const fade = (t: number) => Math.max(0, Math.min(1, (endS - t) / Math.max(1e-6, fadeOutS)));
          const sampled: { t: number; gain: number }[] = [];
          const fadeFrom = endS - fadeOutS;
          for (let t = 0; t < fadeFrom; t += 0.25) sampled.push({ t, gain: duckGainAt(duck, t) * fade(t) });
          for (let i = 0; i <= 8; i++) { const t = fadeFrom + (fadeOutS * i) / 8; sampled.push({ t, gain: duckGainAt(duck, t) * fade(t) }); }
          return sampled;
        };
        const gainDb = (music.gainDb ?? -18) + laneDb(sound, "music") + outDb;
        const stems = musicStems(sound);
        if (stems) {
          for (const name of ["vocals", "other", "drums", "bass"] as const) {
            const file = fileFor(stems[name]);
            if (!file) return null;
            const sourceStart = music.startS - (music.stemsStartS ?? music.startS);
            audio.push({ file, timelineStart: 0, timelineEnd: endS, sourceStart, sourceEnd: sourceStart + endS, gainDb, kind: "music", volumeKeys: shaped(name) });
          }
        } else {
          const file = fileFor(music.url);
          if (!file) return null;
          audio.push({ file, timelineStart: 0, timelineEnd: endS, sourceStart: music.startS, sourceEnd: music.startS + endS, gainDb, kind: "music", volumeKeys: shaped() });
        }
      }
    }
  }
  const eq = sound?.audio?.eq;
  return { version: 1, width: timeline.width, height: timeline.height, fps: timeline.fps ?? 25, durationS: timeline.durationS, video, audio,
    finish: null, sound: { eq: [eq?.low ?? 0, eq?.mid ?? 0, eq?.high ?? 0], auto: sound?.audio?.auto !== false, outDb: sound ? mixOutputDb(sound) : 0 } };
}

/** The media URLs a plan will read, so main resolves only those (muted pieces never open a file). */
export function appleManifestUrls(timeline: DraftTimeline, voice?: AppleVoicePiece[], layers?: (AppleLayerPlan | null | undefined)[]): string[] {
  const urls = new Set<string>();
  for (const piece of timeline.pieces) if (piece.clipId && piece.proxy && piece.endS > piece.startS) {
    urls.add(piece.proxy);
  }
  for (const plan of layers ?? []) if (plan?.background?.image) urls.add(plan.background.image);
  for (const piece of timeline.pieces) { const image = (piece as LayoutPicture).layoutImage; if (image && !layers) urls.add(image); }
  const sound = timeline.liveSound;
  if (sound) {
    for (const original of sound.pieces) {
      if (voice && original.id.startsWith("voiceover:")) continue;
      const heard = heardPiece(sound, original);
      if (!heard.muted && heard.endS > heard.startS) urls.add(heard.url);
    }
    for (const line of voice ?? []) urls.add(line.url);
    for (const piece of sound.effects ?? []) if (!piece.muted) urls.add(piece.url);
    if ((sound.bleeps ?? []).some(b => b.sound === "beep" && b.e > b.s)) urls.add(APPLE_BEEP_URL);
    if (sound.music) {
      const stems = musicStems(sound);
      if (stems) Object.values(stems).forEach(u => urls.add(u)); else urls.add(sound.music.url);
    }
  }
  return [...urls];
}

export { gainOf as appleGainOf };
