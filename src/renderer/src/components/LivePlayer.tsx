import { transformGLSL, paintTransform } from './transformGpu';
import { layerMainGLSL, layerUniformsGLSL } from "../../../shared/layer-glsl";
import { visualTransform } from './transformPreview';
import { sourceTime, sourceRate, opacityAt, blurAt, frameAtTime } from "../../../shared/picture-keys";
import { correctionArrival } from "../motion";
import { LayoutHandles } from './LayoutHandles';
import { visualLayout } from './layoutPreview';
import { LayoutBackdropPass } from './layoutBackdropGpu';
import { GRADE_VERTEX_GLSL, TABLE_AT_GLSL, lookGLSL } from "../../../shared/look-scalar";
import { gradeForPiece, lookParameters, type UniformTimeline } from "./finish/uniformGrade";
import { desiredRotation, observeRotationShoot, rotationClip, subscribeRotation } from "./clipRotation";
import { proxyRotation, quarterTurn, mediaUrl } from "../../../shared/media";
import { mixerDelta, mixerPreviewGLSL } from "./finish/mixerPreview";
import { LiveMix, liveSoundPreviews, listenLiveSound, type LiveSoundTimeline } from "./liveMix";
import { appleLayerPlan, applePlayerDecision, appleRegionAspect, appleTransformNumbers, APPLE_OFF_REASON, APPLE_ON_REASON, type AppleLookPayload } from "../../../shared/apple-playback";
import { createAppleHole } from "./appleHole";
import { playbackExtent, voicePlayback, withBeyondCaptions } from "./liveTimeline";
import type { LaneVisibility } from "./timeline/model";
import { TITLE_CARD_BASE, type LayoutPicture } from '../../../main/layout-math';
import { Tile } from "./ui";
import { histogram, isHistogramActive } from "./finish/Histogram";
import { DetailPass } from "./finish/detailGpu";
import { normalizeDetail, detailActive, NO_DETAIL } from "./finish/detailMath";
import { GrainPlate } from "./finish/grainGpu";
import { grainGLSL, normalizeGrain, normalizeVignette } from "./finish/grainMath";
import { BASIC_KEYS, basicDelta, basicsGLSL } from "./finish/basicsMath";
import { normalizeBasic } from "../../../main/basics";
import { OverlayHandles, useOverlaySession } from "./OverlayHandles";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowsIn, ArrowsOut, Pause, Play, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import type { BasicAdjust, Clip, DraftPiece, DraftTimeline, Shoot, TitleTrack, Grade, DetailChoice, GrainChoice, VignetteChoice } from "../../../shared/schema";
import { formatDuration, frameAt, getApi } from "../data";
import { PreviewPlaceholder, usePreviewProgress } from "./ClipDrawer";
import { isTextField, type StageHandle } from "./Stage";
import { FOCUS, Slider } from "./ui";
import { usePageActive } from "../hooks/usePageActivity";
import titleTemplate from "../../../main/titles/template.html?raw";
import outfit600 from "@fontsource/outfit/files/outfit-latin-600-normal.woff2?inline";
import outfit700 from "@fontsource/outfit/files/outfit-latin-700-normal.woff2?inline";
import outfit800 from "@fontsource/outfit/files/outfit-latin-800-normal.woff2?inline";
import outfit900 from "@fontsource/outfit/files/outfit-latin-900-normal.woff2?inline";
import inter from "@fontsource-variable/inter/files/inter-latin-standard-normal.woff2?inline";
import interItalic from "@fontsource-variable/inter/files/inter-latin-standard-italic.woff2?inline";

import captionFont0 from "@fontsource/montserrat/files/montserrat-latin-800-normal.woff2?inline";
import captionFont1 from "@fontsource/poppins/files/poppins-latin-800-normal.woff2?inline";
import captionFont2 from "@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?inline";
import captionFont3 from "@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff2?inline";
import captionFont4 from "@fontsource/caveat/files/caveat-latin-700-normal.woff2?inline";
import captionItalic0 from "@fontsource/montserrat/files/montserrat-latin-800-italic.woff2?inline";
import captionItalic1 from "@fontsource/montserrat/files/montserrat-latin-900-italic.woff2?inline";
import captionItalic2 from "@fontsource/poppins/files/poppins-latin-800-italic.woff2?inline";
import captionItalic3 from "@fontsource/poppins/files/poppins-latin-900-italic.woff2?inline";

import outfitExtended600 from "@fontsource/outfit/files/outfit-latin-ext-600-normal.woff2?inline";
import outfitExtended700 from "@fontsource/outfit/files/outfit-latin-ext-700-normal.woff2?inline";
import outfitExtended800 from "@fontsource/outfit/files/outfit-latin-ext-800-normal.woff2?inline";
import outfitExtended900 from "@fontsource/outfit/files/outfit-latin-ext-900-normal.woff2?inline";
import interExtended from "@fontsource-variable/inter/files/inter-latin-ext-standard-normal.woff2?inline";
import interExtendedItalic from "@fontsource-variable/inter/files/inter-latin-ext-standard-italic.woff2?inline";

export type LiveLook = string[] | null;
const STAGE_MESSAGE_MS = 5000;
const PLAIN_VIDEO = "Live colour is unavailable here. Showing plain video.";
type Lut = Awaited<ReturnType<ReturnType<typeof getApi>["liveLut"]>>;
type LiveGrade = NonNullable<Awaited<ReturnType<ReturnType<typeof getApi>["liveGrade"]>>>;
const gradeReady = new Map<string, LiveGrade>();
/** AV2: recipes asked for on the Apple player's behalf (its pieces' numbers), so each is asked once. */
const recipeAsked = new Set<string>();
/** AV2: read a piece's recipe when the Chrome painter has not (the Apple player is showing), then call `ready`. */
function askRecipe(id: string, ready: () => void) {
  if (gradeReady.has(id) || recipeAsked.has(id) || !id.startsWith("piece:")) return;
  recipeAsked.add(id);
  if (recipeAsked.size > 4096) recipeAsked.clear();
  // A recipe main has not registered yet (the new version's timeline is still being read) is asked again next time.
  try { void getApi().liveGrade?.(id)?.then(recipe => { if (!recipe) { recipeAsked.delete(id); return; } if (!gradeReady.has(id)) { gradeReady.set(id, recipe); recipesArrived(ready); } }).catch(() => recipeAsked.delete(id)); } catch { recipeAsked.delete(id); }
}
/** Recipes arrive one reply at a time; the Apple player hears them together, once. */
let recipesTimer: ReturnType<typeof setTimeout> | null = null;
function recipesArrived(ready: () => void) {
  if (recipesTimer !== null) return;
  recipesTimer = setTimeout(() => { recipesTimer = null; ready(); }, 16);
}
export const lookInputTimes = new WeakMap<string[], number>();
export const lookBasics = new WeakMap<string[], BasicAdjust>();
type BasicPreview = { saved?: { balances?: UniformTimeline["uniformBalances"]; correctionKey?: number; grade: Grade; pieceLooks?: UniformTimeline["uniformPieceLooks"] }; grade?: { target: Grade; piece?: number; clipLook?: import("../../../shared/schema").PieceLook; clipLooks?: Record<number,import("../../../shared/schema").PieceLook> }; mixer?: {target:Grade["mixer"];baseline:Grade["mixer"]}; intensity?: {target:number;baseline:number;clean:string[]}; target: BasicAdjust; baseline: BasicAdjust; inputAt?: number; changed?: () => void };
const basicPreviews = new WeakMap<DraftTimeline, BasicPreview>();
/** AV2: the live grade one piece shows (its recipe's, the saved grade with its clip look and balance, or a draft
 * being dragged). One rule, read by this viewer's shader and by the Apple player's numbers. */
function pieceLiveGrade(content: DraftPiece, recipe: LiveGrade | undefined, adjustment: BasicPreview | undefined) {
  const rawLook = adjustment?.saved?.pieceLooks ? adjustment.saved.pieceLooks[content.lookPiece ?? content.piece ?? -1]
    : content.liveLook !== undefined ? content.liveLook : recipe?.pieceLook;
  const balance=adjustment?.saved?.balances?.[content.clipId];
  const pieceLook=balance ? {...rawLook,basic:balance.basic} : rawLook;
  let live = recipe ? adjustment?.saved ? gradeForPiece(adjustment.saved.grade,pieceLook) : recipe.grade : undefined;
  const draftGrade = adjustment?.grade;
  if (recipe && draftGrade) {
    if (draftGrade.piece === undefined) {
      live = gradeForPiece(draftGrade.target,pieceLook);
    } else if(content.piece!==undefined && draftGrade.clipLooks?.[content.piece]) live=gradeForPiece(draftGrade.target,draftGrade.clipLooks[content.piece]);
    else if (content.piece === draftGrade.piece) live = gradeForPiece(draftGrade.target,draftGrade.clipLook);
  }
  return live;
}
/** AV2: the clip look that decides a piece's diffusion (shared by both players, as above). */
function pieceDiffusionLook(content: DraftPiece, id: string | undefined, adjustment: BasicPreview | undefined) {
  const draft = adjustment?.grade;
  if(content.piece!==undefined && draft?.clipLooks?.[content.piece])return draft.clipLooks[content.piece];
  if (draft?.piece !== undefined && content.piece === draft.piece) return draft.clipLook;
  if (adjustment?.saved?.pieceLooks) return adjustment.saved.pieceLooks[content.lookPiece ?? content.piece ?? -1];
  return content.liveLook !== undefined ? content.liveLook : id ? gradeReady.get(id)?.pieceLook : undefined;
}
/** AV2: whether diffusion is drawn per piece (the viewer's scopedDiffusion), from the same rule as its draw. */
function scopedDiffusionOf(pieces: DraftPiece[], ids: (string | undefined)[], adjustment: BasicPreview | undefined, texture: TexturePreview | undefined) {
  return !!texture && pieces.some((p, i) => pieceDiffusionLook(p, ids[i], adjustment)?.diffusion !== undefined)
    && (!!texture.detail?.diffusion || pieces.some((p, i) => (pieceDiffusionLook(p, ids[i], adjustment)?.diffusion ?? 0) > 0));
}
export function setBasicPreview(timeline: DraftTimeline, target: BasicAdjust, baseline: BasicAdjust, inputAt?: number) {
  const state = basicPreviews.get(timeline) ?? { target, baseline };
  Object.assign(state, { target, baseline, inputAt }); basicPreviews.set(timeline, state); state.changed?.();
}
export function setColourPreview(timeline: DraftTimeline, mixer: BasicPreview['mixer'], intensity?: BasicPreview['intensity']) {
  const state = basicPreviews.get(timeline) ?? {target:normalizeBasic(),baseline:normalizeBasic()};
  Object.assign(state,{mixer,intensity});basicPreviews.set(timeline,state);state.changed?.();
}
/** Full values, never post-LUT differences. This call only mutates renderer state. */
export function setGradePreview(timeline: DraftTimeline, target?: Grade, piece?: number, clipLook?: import("../../../shared/schema").PieceLook, inputAt?: number, clipLooks?: Record<number,import("../../../shared/schema").PieceLook>) {
  const state = basicPreviews.get(timeline) ?? {target:normalizeBasic(),baseline:normalizeBasic()};
  state.grade = target ? {target,piece,clipLook,clipLooks} : undefined;
  state.inputAt = inputAt; basicPreviews.set(timeline,state); state.changed?.();
}
const lutCache = new Map<string, Promise<Lut>>();
// LK1: LUTs that have arrived, so a prepared look (a Look tile under the pointer) goes up in the frame that asks for it.
const lutReady = new Map<string, Lut>();
// Per-piece grades can share one immutable basis. Validate its large sample
// array once, rather than walking it again for every shot in the edit.
const validatedLuts = new WeakSet<Lut>();
// R8b: an edit's first picture goes first. Look galleries and other LUT callers wait until every player that is
// opening has drawn (never longer than OPEN_GATE_MS), so their transfers never compete with the first frame.
const opening = new Set<object>();
let openWaiters: (() => void)[] = [];
export const OPEN_GATE_MS = 2500;
export function markOpening(owner: object, open: boolean) {
  if (open) { opening.add(owner); return; }
  opening.delete(owner);
  if (opening.size) return;
  const waiters = openWaiters; openWaiters = []; waiters.forEach(resolve => resolve());
}
function afterFirstFrame(): Promise<void> {
  if (!opening.size || typeof window.setTimeout !== "function") return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { window.clearTimeout(timer); resolve(); };
    const timer = window.setTimeout(() => { openWaiters = openWaiters.filter(waiter => waiter !== done); resolve(); }, OPEN_GATE_MS);
    openWaiters.push(done);
  });
}
export function cachedLiveLut(id: string): Promise<Lut> {
  return lutCache.get(id) ?? (opening.size ? afterFirstFrame().then(() => playerLut(id)) : playerLut(id));
}
/** The stage's own requests: never wait behind the open gate. */
function playerLut(id: string): Promise<Lut> {
  let result = lutCache.get(id);
  if (!result) {
    result = (async (): Promise<Lut> => {
      if (id.startsWith("piece:") && getApi().liveGrade) {
        const recipe = await getApi().liveGrade(id);
        if (recipe) {
          gradeReady.set(id,recipe);
          const basis = await playerLut(recipe.baseId);
          return basis;
        }
      }
      return getApi().liveLut(id);
    })().then(lut => {
      if (!validatedLuts.has(lut)) {
        if (!Number.isInteger(lut.size) || lut.size < 2 || lut.data.length !== lut.size ** 3 * 3 || !lut.data.every(Number.isFinite)) throw new Error("Invalid live LUT");
        validatedLuts.add(lut);
      }
      if (lutCache.get(id) === result) lutReady.set(id, lut);
      return lut;
    }).catch(error => { lutCache.delete(id); throw error; });
    lutCache.set(id, result);
    if (lutCache.size > 1024) { const oldest = lutCache.keys().next().value!; lutCache.delete(oldest); lutReady.delete(oldest); gradeReady.delete(oldest); }
  }
  return result;
}

/** A piece's position in a timeline by what it is, not by object identity: the
 * timeline is rebuilt (proxy revisions, live looks) while decoders keep the piece
 * they loaded. An identity miss once left every frame cleared to black. */
export function pieceIndex(pieces: DraftPiece[], piece: DraftPiece): number {
  const same = pieces.indexOf(piece);
  if (same >= 0) return same;
  return pieces.findIndex(p => p.layer === piece.layer && p.clipId === piece.clipId && Math.abs(p.startS - piece.startS) < 1e-6 && Math.abs(p.inS - piece.inS) < 1e-6);
}
export function pieceAt(pieces: DraftPiece[], time: number): DraftPiece | undefined {
  let chosen: DraftPiece | undefined;
  for (const piece of pieces) if (time >= piece.startS && time < piece.endS && (!chosen || piece.startS >= chosen.startS)) chosen = piece;
  return chosen;
}
/** Legacy unsafe-camera previews may be playable but missing pictures. Do not
 * present them as normal motion while their validation or repair is queued. */
export function needsSmoothPreview(clip: Clip): boolean {
  return !clip.proxy || clip.previewHealth?.state === 'missing' || clip.previewHealth?.state === 'incomplete'
    || !!clip.previewHealth?.requiresValidation && clip.previewHealth.state !== 'healthy';
}
export { sourceTime, sourceRate, opacityAt, blurAt, frameAtTime } from "../../../shared/picture-keys";
// PS1: stand-in stills. PS2 keeps a 5 fps, 540 px strip per clip, made from its proxy, and main serves frame N as
// thumbs/strip:<clipId>:<N>.jpg (shared/media standInUrl; 404 until the strip exists). The player builds the same URL
// from the piece's own proxy URL, so it needs no new import, and draws that still while the layer's decoder seeks.
const STRIP_FPS = 5;
export function standInFor(piece: DraftPiece, sourceS: number): string | null {
  const at = piece.proxy?.indexOf("/proxies/") ?? -1;
  if (at < 0 || !piece.clipId) return null;
  const frame = Math.round((Number.isFinite(sourceS) ? Math.max(0, sourceS) : 0) * STRIP_FPS) + 1;
  const clip = (() => { try { return rotationClip(decodeURIComponent(new URL(piece.proxy).pathname.split('/')[1]), piece.clipId); } catch { return undefined; } })();
  const rev = /[?&]preview=([^&]+)/.exec(piece.proxy)?.[1];
  return `${piece.proxy.slice(0, at)}/thumbs/${encodeURIComponent(`strip:${piece.clipId}:${frame}${clip?.pictureStrip ? `:${clip.pictureStrip.key}` : ""}.jpg`)}${rev ? `?rev=${rev}` : ""}`;
}
/** Strip stills decoded once into small ImageBitmaps (about 200 kept). Only the newest few requests are kept
 * waiting, so a fast scrub never queues the positions it has already passed. A clip without a strip is asked again
 * after a few seconds, never on every frame. */
export class StandIns {
  private images = new Map<string, ImageBitmap>();
  private loading = new Set<string>();
  private queue: string[] = [];
  private missing = new Map<string, number>();
  private listeners = new Set<() => void>();
  constructor(public limit = 200, public load: ((url: string) => Promise<ImageBitmap>) | null = defaultStandInLoad()) {}
  get(url: string): ImageBitmap | undefined {
    const image = this.images.get(url);
    if (image) { this.images.delete(url); this.images.set(url, image); }
    return image;
  }
  want(url: string) {
    if (!this.load || this.images.has(url) || this.loading.has(url)) return;
    const clip = url.replace(/%3A\d+\.jpg.*$/, "");
    if ((this.missing.get(clip) ?? 0) > Date.now()) return;
    this.queue = [url, ...this.queue.filter(waiting => waiting !== url)].slice(0, 4);
    this.pump();
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  clear() { this.images.forEach(image => image.close?.()); this.images.clear(); this.queue = []; this.missing.clear(); }
  private pump() {
    while (this.load && this.loading.size < 3 && this.queue.length) {
      const url = this.queue.shift()!;
      this.loading.add(url);
      void this.load(url).then(image => {
        this.images.set(url, image);
        while (this.images.size > this.limit) { const [oldest, old] = this.images.entries().next().value!; old.close?.(); this.images.delete(oldest); }
        this.listeners.forEach(listener => listener());
      }, () => { this.missing.set(url.replace(/%3A\d+\.jpg.*$/, ""), Date.now() + 4000); })
        .finally(() => { this.loading.delete(url); this.pump(); });
    }
  }
}
function defaultStandInLoad(): ((url: string) => Promise<ImageBitmap>) | null {
  if (typeof fetch !== "function" || typeof createImageBitmap !== "function") return null;
  return async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("No stand-in yet");
    const full = await createImageBitmap(await response.blob());
    // Kept small: 360 px on the short side is enough for the few frames a stand-in is on screen.
    const scale = 360 / Math.min(full.width, full.height);
    if (scale >= 1) return full;
    const small = await createImageBitmap(full, { resizeWidth: Math.round(full.width * scale), resizeHeight: Math.round(full.height * scale), resizeQuality: "medium" });
    full.close();
    return small;
  };
}
export const standIns = new StandIns();

export type LookFrame = { image: HTMLCanvasElement; piece: DraftPiece; time: number };
const liveFrames = new WeakMap<DraftTimeline, () => LookFrame | null>();

/** Capture ungraded pixels once, so a tile never grades the player's graded output again. */
function copyLookFrame(video: HTMLVideoElement | VideoFrame, piece: DraftPiece, time: number): LookFrame {
  const image = document.createElement("canvas");
  const width = "displayWidth" in video ? video.displayWidth : video.videoWidth, height = "displayHeight" in video ? video.displayHeight : video.videoHeight;
  const scale = Math.min(1, 320 / Math.max(width, height));
  image.width = Math.max(1, Math.round(width * scale));
  image.height = Math.max(1, Math.round(height * scale));
  const context = image.getContext("2d");
  if (!context) throw new Error("Couldn't capture this frame.");
  context.drawImage(video, 0, 0, image.width, image.height);
  return { image, piece, time };
}

/** Prefer the decoded live frame; otherwise seek one proxy, never one decoder per look. */
export async function grabLookFrame(timeline: DraftTimeline, time: number, signal: AbortSignal): Promise<LookFrame> {
  signal.throwIfAborted();
  const live = liveFrames.get(timeline)?.();
  if (live && Math.abs(live.time - time) < .08) return live;
  const piece = pieceAt(timeline.pieces.filter(p => p.layer === 1), time)
    ?? pieceAt(timeline.pieces.filter(p => p.layer === 0), time);
  if (!piece?.proxy) throw new Error("Seek to a piece to see its looks.");
  const video = document.createElement("video");
  video.muted = true; video.preload = "auto"; video.crossOrigin = "anonymous";
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        video.onloadedmetadata = video.onseeked = video.onloadeddata = video.onerror = null;
        error ? reject(error) : resolve();
      };
      const ready = () => { if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < .08) finish(); };
      const abort = () => finish(signal.reason);
      const target = sourceTime(piece, time);
      const timer = setTimeout(() => finish(new Error("Couldn't load this frame. Check the footage is connected.")), 10000);
      signal.addEventListener("abort", abort, { once: true });
      video.onloadedmetadata = () => { video.currentTime = target; ready(); };
      video.onseeked = video.onloadeddata = ready;
      video.onerror = () => finish(new Error("Couldn't load this frame. Check the footage is connected."));
      video.src = piece.proxy; video.load();
    });
    signal.throwIfAborted();
    return copyLookFrame(video, piece, time);
  } finally { video.pause(); video.removeAttribute("src"); video.load(); }
}

type BufferedPicture = { image: VideoFrame; time: number };
type DecodedPicture = { video: HTMLVideoElement; piece: DraftPiece; frame?: VideoFrame };
// Decode a little ahead of the sound clock: resuming a paused Chromium video
// costs one or two frames even when its seek finished seconds before the join.
const DECODE_LEAD_S = .12;
const MAX_BUFFERED_FRAMES = 24;
type Slot = { primeTarget?: number; leadS?: number; frames: BufferedPicture[]; video: HTMLVideoElement; piece?: DraftPiece; ready: boolean; token: number; callback?: number; target: number; issued?: number; frameS: number; lastMediaTime?: number };
/** Each layer owns exactly two decoders. A slot is only published after its seeked frame arrives. */
export class LiveLayer {
  private slots: Slot[];
  private active: Slot[] = [];
  /** PS1: pieces on screen now whose decoder isn't ready yet. The stage draws their stand-in or the held frame. */
  waiting: DraftPiece[] = [];
  constructor(private pieces: DraftPiece[], videos: HTMLVideoElement[], private changed: () => void, private failed: () => void,
    private blocked: (piece: DraftPiece) => boolean = () => false, private buffered: () => boolean = () => true) {
    this.slots = videos.map(video => ({ video, frames: [], ready: false, token: 0, target: 0, frameS: 1 / 25 }));
  }
  private clearFrames(slot: Slot) {
    slot.frames.forEach(frame => frame.image.close()); slot.frames = [];
  }
  private remember(slot: Slot) {
    if (!this.buffered() || typeof VideoFrame === "undefined" || slot.video.readyState < 2 || slot.video.seeking) return;
    try {
      // A late callback can describe the previous picture. Keep the captured
      // image's native PTS, including a paused seek between source frames.
      const image = new VideoFrame(slot.video), time = image.timestamp / 1e6;
      if (slot.frames.some(frame => frame.image.timestamp === image.timestamp)) { image.close(); return; }
      slot.frames.push({ image, time });
      while (slot.frames.length > MAX_BUFFERED_FRAMES) slot.frames.shift()!.image.close();
    } catch { /* Browsers without frame capture keep the ordinary decoder path. */ }
  }
  private observe(slot: Slot) {
    if (slot.callback !== undefined || !slot.ready || slot.video.paused || !slot.video.requestVideoFrameCallback) return;
    const token = slot.token;
    slot.callback = slot.video.requestVideoFrameCallback((_now, metadata) => {
      if (slot.token !== token) return;
      slot.callback = undefined;
      const step = metadata.mediaTime - (slot.lastMediaTime ?? metadata.mediaTime);
      if (step > .003 && step < .1) slot.frameS = step;
      slot.lastMediaTime = metadata.mediaTime;
      this.remember(slot);
      if (slot.primeTarget !== undefined && metadata.mediaTime >= slot.primeTarget - slot.frameS / 2) slot.video.pause();
      this.observe(slot); this.changed();
    });
  }
  private advance(slot: Slot, piece: DraftPiece, time: number, playing: boolean, playbackRate: number) {
    if (!slot.ready) return;
    // A pre-rolling decoder can reach the file's end before the edit clock.
    // Its queued tail is still current; play() here would restart it at zero.
    const shown = sourceTime(piece, time);
    if (!playing && slot.primeTarget !== undefined && slot.frames[0]?.time <= shown + .000001 && slot.frames.at(-1)!.time >= shown - .000001) return;
    if (playing && slot.primeTarget !== undefined) {
      // Play can arrive before priming finishes. Use only the lead actually
      // captured, otherwise the first tick would seek past its own queue.
      slot.leadS = Math.min(slot.leadS ?? 0, Math.max(0, ((slot.frames.at(-1)?.time ?? shown) - shown) / Math.max(.001, sourceRate(piece, time))));
      slot.primeTarget = undefined;
    }
    if (playing && slot.video.ended && slot.frames.length && shown >= slot.frames[0].time - .001 && shown <= slot.video.currentTime + .001) return;
    // Frame capture is optional. The fallback keeps PS1's exact paused seeks.
    if (slot.video.paused && playing) slot.leadS = time < piece.startS && slot.frames.length ? DECODE_LEAD_S : slot.leadS ?? 0;
    const lead = playing ? (slot.leadS ?? 0) * playbackRate : 0;
    const target = sourceTime(piece, time + lead), delta = target - slot.video.currentTime;
    const rate = sourceRate(piece, time + lead);
    const covered = slot.frames[0]?.time <= shown + .000001 && slot.frames.at(-1)!.time + slot.frameS > shown;
    if (playing && Math.abs(delta) > .15 && !slot.video.seeking && !covered) this.prepare(slot, piece, shown);
    else if (!playing && Math.abs(delta) > slot.frameS * 1.5 && !slot.video.seeking
      && !(slot.frames.length && slot.frames[0].time <= shown + .000001 && slot.frames[slot.frames.length-1].time >= shown - .000001)) this.prepare(slot, piece, shown);
    else {
      const correction = Math.abs(delta) > slot.frameS ? delta > 0 ? 1.05 : .95 : 1;
      slot.video.playbackRate = Math.max(1 / 16, Math.min(16, rate * correction * playbackRate));
      if (playing && rate > 0 && slot.video.paused) void slot.video.play().catch(this.failed);
      if (!playing || rate <= 0) slot.video.pause();
    }
    if (playing) this.observe(slot);
  }
  private continues(before: DraftPiece, after: DraftPiece) {
    return !!before.proxy && before.proxy === after.proxy && before.layer === after.layer
      && Math.abs(before.endS - after.startS) < 1e-6
      && Math.abs(sourceTime(before, before.endS) - sourceTime(after, after.startS)) < 1e-6;
  }
  private warm(slot: Slot | undefined, piece: DraftPiece | undefined, time: number, playing: boolean, playbackRate: number) {
    if (!slot || !piece) return;
    if (this.buffered() && slot.ready && slot.video.paused && !slot.frames.length) this.remember(slot);
    if (this.blocked(piece) || !playing && slot.primeTarget === undefined) slot.video.pause();
    else if (slot.frames.length && time + (slot.primeTarget === undefined ? DECODE_LEAD_S * playbackRate : 0) >= piece.startS) this.advance(slot, piece, time, true, playbackRate);
  }
  /** Fill a bounded startup queue while the paused in-picture stays on screen. */
  prime(time: number, futureOnly = false) {
    if (!this.buffered() || typeof VideoFrame === 'undefined') return;
    for (const slot of this.slots) {
      const piece = slot.piece;
      if (!piece || !slot.ready || slot.video.seeking || this.blocked(piece) || !slot.frames.length) continue;
      if (futureOnly && time >= piece.startS) continue;
      const at = Math.max(time, piece.startS), rate = sourceRate(piece, at);
      if (at >= piece.endS || rate <= 0) continue;
      const lead = Math.min(.24, (MAX_BUFFERED_FRAMES - 2) * slot.frameS / rate);
      slot.primeTarget = sourceTime(piece, at + lead); slot.leadS = lead;
      if (slot.frames.at(-1)!.time >= slot.primeTarget - slot.frameS / 2 || slot.video.ended) { slot.video.pause(); continue; }
      slot.video.playbackRate = Math.max(1 / 16, Math.min(16, rate));
      if (slot.video.paused) void slot.video.play().catch(this.failed);
      this.observe(slot);
    }
  }
  private picture(slot: Slot, piece: DraftPiece, time: number): DecodedPicture {
    const target = sourceTime(piece, time);
    // Keep the last frame at/before the composition clock, plus the bounded future
    // frames. Never show the decoder's ahead-of-time picture at a cut or a scrub.
    let selected = 0;
    for (let i = 1; i < slot.frames.length; i++) if (slot.frames[i].time <= target + .000001) selected = i;
    slot.frames.splice(0, selected).forEach(frame => frame.image.close());
    return { video: slot.video, piece, frame: slot.frames[0]?.image };
  }
  private prepare(slot: Slot, piece: DraftPiece, target: number) {
    const video = slot.video;
    // PS1: a seek still in flight on this piece only moves its target. The decoder finishes the seek it is on, then
    // goes straight to the newest target, so a scrub never decodes the positions it has already passed.
    if (!slot.ready && slot.piece && slot.piece.proxy === piece.proxy && pieceIndex([slot.piece], piece) === 0 && video.seeking && video.getAttribute("src") === piece.proxy) {
      slot.piece = piece; slot.target = target; return;
    }
    const token = ++slot.token;
    this.clearFrames(slot);
    if (slot.callback !== undefined) video.cancelVideoFrameCallback?.(slot.callback);
    slot.callback = undefined;
    slot.piece = piece; slot.ready = false; slot.target = target; slot.lastMediaTime = undefined; slot.leadS = 0; slot.primeTarget = undefined;
    video.pause(); video.playbackRate = 1;
    const publish = (settled = false) => {
      if (slot.token !== token || slot.ready) return;
      // A paused decoder seeked to where it already rests presents no new frame, so a
      // pending frame callback never fires and the layer stays unpublished: the canvas
      // cleared to black every frame (opening Look seeks to the current time). Once the
      // seek has settled on the target, the decoded frame is the right one.
      if (settled && video.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - slot.target) <= slot.frameS * 1.5) {
        if (slot.callback !== undefined) { video.cancelVideoFrameCallback?.(slot.callback); slot.callback = undefined; }
        slot.ready = true; this.remember(slot); this.changed(); return;
      }
      if (slot.callback !== undefined) return;
      if (video.requestVideoFrameCallback) slot.callback = video.requestVideoFrameCallback((_now, metadata) => {
        if (slot.token !== token) return;
        slot.callback = undefined;
        // A callback from before a seek is not the requested source frame.
        if (video.seeking || Math.abs(metadata.mediaTime - slot.target) > slot.frameS * 1.5) { publish(); return; }
        slot.callback = undefined; slot.ready = true; this.remember(slot); this.changed();
      });
      else if (video.readyState >= 2 && !video.seeking) { slot.ready = true; this.remember(slot); this.changed(); }
    };
    const seekTo = (at: number) => { slot.issued = at; video.currentTime = at; };
    video.onloadedmetadata = () => { if (slot.token === token) { seekTo(slot.target); publish(); } };
    video.onseeked = () => {
      if (slot.token !== token) return;
      // The target moved while this seek ran (a scrub): go to the newest one now.
      if (slot.issued !== slot.target && !slot.ready) { seekTo(slot.target); return; }
      if (slot.ready) { this.remember(slot); this.changed(); }
      else publish(true);
    };
    // PS1: the open tail (1 open in 12, 6 in 12 on the talking edit). A slot could be published while its decoder
    // had no frame data (readyState 1 after a seek); the stage then skipped it, and nothing asked for another draw
    // once the data came, so the cover stayed up forever. Data arriving now publishes a pending slot, or redraws a
    // published one, whichever applies.
    video.onloadeddata = video.oncanplay = () => { if (slot.token !== token) return; if (slot.ready) { if (video.paused) this.remember(slot); this.changed(); } else publish(true); };
    video.onerror = () => { if (slot.token === token) this.failed(); };
    if (video.getAttribute("src") !== piece.proxy) { video.src = piece.proxy; video.load(); }
    else if (video.readyState >= 1) { seekTo(target); publish(); }
  }
  replace(pieces: DraftPiece[]) { this.pieces = pieces; }
  update(time: number, playing: boolean, seek = false): DecodedPicture | null {
    return this.updateAll(time, playing, seek)[0] ?? null;
  }
  updateAll(time: number, playing: boolean, seek = false, playbackRate = 1): DecodedPicture[] {
    const wanted = this.pieces.filter(piece => time >= piece.startS && time < piece.endS && !this.blocked(piece)).sort((a, b) => a.startS - b.startS);
    const matches = (slot: Slot, piece: DraftPiece) => slot.piece !== undefined && pieceIndex([slot.piece], piece) === 0 && slot.piece.proxy === piece.proxy;
    // Plain-video fallback displays the decoder itself. Retire the lead and seek
    // back to the composition clock before exposing it after a lost GL context.
    if (!this.buffered()) for (const slot of this.slots) if (slot.frames.length) {
      const ahead = slot.leadS; this.clearFrames(slot); slot.leadS = 0;
      const piece = wanted.find(piece => matches(slot, piece)) ?? (slot.piece && time < slot.piece.startS ? slot.piece : undefined);
      if (ahead && piece) this.prepare(slot, piece, sourceTime(piece, time));
    }
    // Layouts can divide one continuous source clock into several picture spans.
    // Retain its decoder and queued frames when a neighbouring span takes over.
    for (const slot of this.active) {
      const before = slot.piece;
      if (!before || !slot.ready || slot.video.seeking || wanted.some(piece => matches(slot, piece))) continue;
      const continuation = wanted.find(piece => this.continues(before, piece));
      if (continuation) slot.piece = continuation;
    }
    // Stop the outgoing slot when its picture leaves the composition.
    this.active.filter(slot => !wanted.some(piece => matches(slot, piece))).forEach(slot => slot.video.pause());
    if (!wanted.length) {
      this.active = []; this.waiting = [];
      const next = this.pieces.find(piece => piece.startS > time);
      if (next && !this.blocked(next) && !this.slots.some(slot => matches(slot, next))) this.prepare(this.slots[0], next, sourceTime(next, next.startS));
      const incoming = next && this.slots.find(slot => matches(slot, next));
      this.slots.filter(slot => slot !== incoming).forEach(slot => slot.video.pause());
      this.warm(incoming, next, time, playing, playbackRate);
      return [];
    }
    const pictures: DecodedPicture[] = [];
    const used: Slot[] = [];
    for (const piece of wanted) {
      let slot = this.active.find(candidate => matches(candidate, piece)) ?? this.slots.find(candidate => matches(candidate, piece));
      if (!slot) {
        const available = this.slots.filter(candidate => !wanted.some(other => matches(candidate, other)) && !used.includes(candidate));
        slot = available.find(candidate => !this.active.includes(candidate)) ?? available[0];
        if (!slot) continue;
        this.prepare(slot, piece, sourceTime(piece, time));
      } else if (seek) {
        this.prepare(slot, piece, sourceTime(piece, time));
      }
      slot.piece = piece; used.push(slot);
      if (slot.ready) {
        this.advance(slot, piece, time, playing, playbackRate);
        // A published decoder with no frame data yet isn't a picture: its stand-in or the held frame shows instead.
        if (slot.ready && slot.video.readyState >= 2) pictures.push(this.picture(slot, piece, time));
      }
    }
    let next = this.pieces.find(piece => piece.startS > time);
    let through = wanted[wanted.length - 1];
    while (next && through && next.startS > through.startS && this.continues(through, next)) {
      through = next; const end = next.endS;
      next = this.pieces.find(piece => piece.startS >= end - 1e-6);
    }
    if (next && !this.blocked(next) && !this.slots.some(candidate => matches(candidate, next))) {
      const spare = this.slots.find(candidate => !used.includes(candidate));
      // Retain the outgoing decoded picture until the incoming one is ready.
      if (spare && (!this.active.includes(spare) || used.every(slot => slot.ready))) this.prepare(spare, next, sourceTime(next, next.startS));
    }
    const incoming = next && this.slots.find(candidate => matches(candidate, next));
    this.warm(incoming, next, time, playing, playbackRate);
    for (const idle of this.slots) if (!used.includes(idle) && idle !== incoming) idle.video.pause();
    // Keep the outgoing decoder moving while a replacement seeks in the spare.
    if (!pictures.length) for (const old of this.active) {
      if (used.includes(old) || !old.ready || old.video.readyState < 2 || !old.piece || time < old.piece.startS || time >= old.piece.endS) continue;
      if (playing && old.video.paused) void old.video.play().catch(this.failed);
      pictures.push(this.picture(old, old.piece, time));
    }
    this.active = pictures.length && !used.some(slot => slot.ready) ? this.active : used;
    this.waiting = wanted.filter(piece => piece.proxy && !pictures.some(picture => pieceIndex([picture.piece], piece) === 0));
    return pictures;
  }
  nextPictureTime(time: number): number {
    let next = this.pieces.find(piece => piece.startS > time && !this.blocked(piece))?.startS ?? Infinity;
    for (const slot of this.active) {
      const piece = slot.piece;
      if (!piece || !slot.ready || this.blocked(piece)) continue;
      // A decoder notification can arrive after a cut but before its queued
      // timer. That cut is still due, even if the next source frame is past EOF.
      if (time >= piece.endS) return time;
      if (slot.frames[1]?.time <= sourceTime(piece, time) + .000001) return time;
      const frame = slot.frames.find(frame => frame.time > sourceTime(piece, time) + .000001);
      if (!frame) continue;
      const map = piece.timeMap?.length ? piece.timeMap : [{t:piece.startS,s:piece.inS},{t:piece.endS,s:piece.inS+piece.endS-piece.startS}];
      for (let i = 1; i < map.length; i++) {
        const a = map[i-1], b = map[i];
        if (b.t <= time || b.s <= a.s || frame.time < a.s || frame.time > b.s) continue;
        const at = a.t + (frame.time-a.s)*(b.t-a.t)/(b.s-a.s);
        if (at > time && at <= piece.endS) next = Math.min(next, at);
      }
    }
    return next;
  }
  pause() { this.slots.forEach(slot => slot.video.pause()); }
  suspend() {
    this.pause();
    this.slots.forEach(slot => {
      if (slot.callback !== undefined) slot.video.cancelVideoFrameCallback?.(slot.callback);
      slot.callback = undefined;
      this.clearFrames(slot);
      // An unfinished seek is retried on return, with no hidden frame callbacks.
      if (!slot.ready) { slot.token++; slot.piece = undefined; }
    });
  }
  dispose() {
    this.active = []; this.waiting = [];
    this.slots.forEach(slot => {
      slot.token++; slot.video.pause(); this.clearFrames(slot);
      if (slot.callback !== undefined) slot.video.cancelVideoFrameCallback?.(slot.callback);
      slot.callback = undefined; slot.piece = undefined; slot.ready = false;
      slot.video.onloadedmetadata = slot.video.onloadeddata = slot.video.oncanplay = slot.video.onseeked = slot.video.onerror = null;
      slot.video.removeAttribute("src"); slot.video.load();
    });
  }
}

const derivedPictureTurns = new Map<string, number>();
export function pictureTurn(piece: DraftPiece): { turn: number; framingTurn: number } {
  try {
    const url = new URL(piece.proxy);
    if (url.protocol !== 'st-media:') return { turn: 0, framingTurn: 0 };
    const root = decodeURIComponent(url.pathname.split('/')[1]);
    const clip = rotationClip(root, piece.clipId);
    const name = decodeURIComponent(url.pathname.split('/').at(-1)!);
    const ordinary = url.pathname.includes('/proxies/') && (name === `${piece.clipId}.mp4` || name.startsWith(`${piece.clipId}.r`));
    // Background/reverse assets already bake the turn. Their content URL stays stable while a new one is prepared.
    if (!ordinary) {
      if (!clip) return { turn: 0, framingTurn: 0 };
      const wanted = desiredRotation(root, piece.clipId), key = piece.proxy.split('?')[0];
      let baked = derivedPictureTurns.get(key);
      if (baked === undefined) {
        baked = wanted; derivedPictureTurns.set(key, baked);
        if (derivedPictureTurns.size > 128) derivedPictureTurns.delete(derivedPictureTurns.keys().next().value!);
      }
      return { turn: quarterTurn(wanted-baked), framingTurn: quarterTurn(wanted-baked) };
    }
    const baked = proxyRotation(piece.proxy, clip?.meta?.containerRotation ?? clip?.meta?.rotation);
    const wanted = desiredRotation(root, piece.clipId, baked);
    return { turn: quarterTurn(wanted - baked), framingTurn: quarterTurn(wanted - ((piece as DraftPiece & { rotationFrame?: number }).rotationFrame ?? baked)) };
  } catch { return { turn: 0, framingTurn: 0 }; }
}

const VERTEX = `#version 300 es
in vec2 position; out vec2 uv;
void main(){ uv=vec2((position.x+1.)*.5,(1.-position.y)*.5); gl_Position=vec4(position,0.,1.); }`;
const FRAGMENT = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 color;
uniform sampler2D picture; uniform sampler3D pieceLut;
uniform bool bypassLook; uniform bool clipping; uniform float lutSize; uniform float opacity; uniform vec2 blurVector;
uniform int pictureTurn;
uniform vec4 rect; uniform float sourceAspect; uniform float outputAspect; uniform bool fitted;
${layerUniformsGLSL}${transformGLSL}
uniform float basicDeltaValues[10];
uniform float mixerDeltaValues[24]; uniform sampler3D neutralLut; uniform float intensityRatio; uniform bool intensityPreview;
${basicsGLSL()}
${mixerPreviewGLSL}
${lookGLSL()}
uniform bool uniformGrade; uniform float lookParams[18];
uniform vec4 exposureGain;
${TABLE_AT_GLSL}
${GRADE_VERTEX_GLSL}
vec3 gradeVertex(vec3 basis){ return gradeVertexWith(basis,exposureGain,basicDeltaValues,lookParams,mixerDeltaValues); }
vec3 stagedGrade(vec3 rgb){
  vec3 basis=tableAt(pieceLut,rgb,lutSize,0),p=clamp(basis,0.,1.)*32.;
  ivec3 lo=min(ivec3(floor(p)),ivec3(31));vec3 f=p-vec3(lo);ivec3 a;ivec3 b;vec3 w;
  if(f.r>=f.g){if(f.g>=f.b){a=ivec3(1,0,0);b=ivec3(1,1,0);w=f.rgb;}else if(f.r>=f.b){a=ivec3(1,0,0);b=ivec3(1,0,1);w=f.rbg;}else{a=ivec3(0,0,1);b=ivec3(1,0,1);w=f.brg;}}
  else{if(f.r>=f.b){a=ivec3(0,1,0);b=ivec3(1,1,0);w=f.grb;}else if(f.g>=f.b){a=ivec3(0,1,0);b=ivec3(0,1,1);w=f.gbr;}else{a=ivec3(0,0,1);b=ivec3(0,1,1);w=f.bgr;}}
  vec3 c0=gradeVertex(vec3(lo)/32.),c1=gradeVertex(vec3(lo+a)/32.),c2=gradeVertex(vec3(lo+b)/32.),c3=gradeVertex(vec3(lo+ivec3(1))/32.);
  return c0+w.x*(c1-c0)+w.y*(c2-c1)+w.z*(c3-c2);
}
vec3 grade(vec3 rgb){
  if(bypassLook) return rgb;
  if(uniformGrade) return stagedGrade(rgb);
  vec3 p=clamp(rgb,0.,1.)*(lutSize-1.);
  ivec3 lo=min(ivec3(floor(p)),ivec3(int(lutSize)-2));
  vec3 f=p-vec3(lo);
  ivec3 a; ivec3 b; vec3 w;
  if(f.r>=f.g){
    if(f.g>=f.b){a=ivec3(1,0,0);b=ivec3(1,1,0);w=f.rgb;}
    else if(f.r>=f.b){a=ivec3(1,0,0);b=ivec3(1,0,1);w=f.rbg;}
    else{a=ivec3(0,0,1);b=ivec3(1,0,1);w=f.brg;}
  }else{
    if(f.r>=f.b){a=ivec3(0,1,0);b=ivec3(1,1,0);w=f.grb;}
    else if(f.g>=f.b){a=ivec3(0,1,0);b=ivec3(0,1,1);w=f.gbr;}
    else{a=ivec3(0,0,1);b=ivec3(0,1,1);w=f.bgr;}
  }
  vec3 c0=texelFetch(pieceLut,lo,0).rgb;
  vec3 c1=texelFetch(pieceLut,lo+a,0).rgb;
  vec3 c2=texelFetch(pieceLut,lo+b,0).rgb;
  vec3 c3=texelFetch(pieceLut,lo+ivec3(1),0).rgb;
  vec3 graded=c0+w.x*(c1-c0)+w.y*(c2-c1)+w.z*(c3-c2);
  if(intensityPreview){
    vec3 n0=texelFetch(neutralLut,lo,0).rgb,n1=texelFetch(neutralLut,lo+a,0).rgb,n2=texelFetch(neutralLut,lo+b,0).rgb,n3=texelFetch(neutralLut,lo+ivec3(1),0).rgb;
    vec3 neutral=n0+w.x*(n1-n0)+w.y*(n2-n1)+w.z*(n3-n2);
    graded=clamp(mix(neutral,graded,intensityRatio),0.,1.);
  }
  return mixerPreview(basicPreview(graded,basicDeltaValues),mixerDeltaValues);
}
vec2 turned(vec2 p){
  if(pictureTurn==90) return vec2(p.y,1.-p.x);
  if(pictureTurn==180) return 1.-p;
  if(pictureTurn==270) return vec2(1.-p.y,p.x);
  return p;
}
vec3 pictureAt(vec2 at){
  vec3 rgb;
  if(!fitted) rgb=grade(texture(picture,turned(rect.xy+at*rect.zw)).rgb);
  else {
    vec2 fit=sourceAspect>outputAspect?vec2(1.,outputAspect/sourceAspect):vec2(sourceAspect/outputAspect,1.);
    vec2 point=(at-.5)/fit+.5;
    if(all(greaterThanEqual(point,vec2(0.)))&&all(lessThanEqual(point,vec2(1.)))) rgb=grade(texture(picture,turned(point)).rgb);
    else { rgb=vec3(0.);
    }
  }
  return rgb;
}
${layerMainGLSL}`;

type Surface = { texture: WebGLTexture; aspect: number; filled: boolean; piece?: DraftPiece; uploaded?: unknown; uploadTime?: number; uploadUrl?: string };
/** A layer for the painter: a decoder, a stand-in still, or null (draw the frame this layer last showed). */
export type StageLayer = { video: HTMLVideoElement | HTMLCanvasElement | ImageBitmap | VideoFrame | null; piece: DraftPiece; key?: unknown };
type SourcePlan = { surface: Surface; piece: DraftPiece; upload: HTMLVideoElement | HTMLCanvasElement | ImageBitmap | VideoFrame | null; aspect: number; id: string | undefined; lutSize: number };
/** PS1: how long the stage holds its last whole picture while a layer catches up, before it draws what it has. */
const HOLD_MS = 1000;
type TexturePreview = { detail?: DetailChoice | null; maskOnly?: boolean; grain?: GrainChoice | null; vignette?: VignetteChoice | null; width: number; height: number; fps: number };
const FINISH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv; out vec4 color;
uniform sampler2D composed,grainPlate;
uniform vec2 outputShape; uniform float outputFrame;
uniform float grainAmount,grainSize,grainRoughness,grainColour,grainShadows,grainHighlights;
uniform float vignetteAmount,vignetteMidpoint,vignetteFeather; uniform bool clipping;
${grainGLSL(true)}
void main(){
  vec3 rgb=texture(composed,vec2(uv.x,1.0-uv.y)).rgb;
  rgb=h4_finish(rgb,uv*outputShape-.5,outputShape,outputFrame,grainAmount,grainSize,grainRoughness,grainColour,grainShadows,grainHighlights,vignetteAmount,vignetteMidpoint,vignetteFeather);
  if(clipping){if(max(max(rgb.r,rgb.g),rgb.b)>=.995)rgb=vec3(1.,0.,0.);else if(min(min(rgb.r,rgb.g),rgb.b)<=.005)rgb=vec3(0.,.2,1.);}
  color=vec4(rgb,1.0);
}`;
export class LiveCanvas {
  private gl: WebGL2RenderingContext;
  clipping = false;
  private program!: WebGLProgram;
  private uniformLocations = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private detailPass?: DetailPass;
  private finishProgram!: WebGLProgram;
  private grainPlate?: GrainPlate;
  private framebuffer!: WebGLFramebuffer;
  private composed!: WebGLTexture;
  private composedWidth = 0;
  private composedHeight = 0;
  private buffer!: WebGLBuffer;
  private picture!: WebGLTexture;
  private scene?: { program: WebGLProgram; framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number };
  private textures = new Map<string, { texture: WebGLTexture; size: number }>();
  private waiting = new Set<string>();
  private layoutBackdrop?:LayoutBackdropPass;
  private layoutsWarmed = false;
  private layoutImages=new Map<string,{image:HTMLImageElement;texture?:WebGLTexture}>();
  // PS1: every picture source uploads into its own texture, so a layer whose decoder is seeking can draw the frame it
  // last showed (held) instead of a stage cleared to black.
  private surfaces = new Map<unknown, Surface>();
  private held = new Map<number, { surface: Surface; piece: DraftPiece }>();
  private wholeAt = 0;
  private histogramReadback?: { buffer: WebGLBuffer; framebuffer: WebGLFramebuffer; texture: WebGLTexture; fence?: WebGLSync; bytes: Uint8Array };
  private disposed = false;
  private contextLost = false;
  private generation = 0;
  constructor(private canvas: HTMLCanvasElement, private changed: () => void, private failed: () => void) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.initialize();
  }
  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let locations = this.uniformLocations.get(program);
    if (!locations) { locations = new Map(); this.uniformLocations.set(program, locations); }
    // Optimized-out uniforms return null, which is a cached result too.
    if (!locations.has(name)) locations.set(name, this.gl.getUniformLocation(program, name));
    return locations.get(name)!;
  }
  private initialize() {
    const gl = this.gl;
    this.histogramReadback = undefined;
    this.uniformLocations.clear();
    this.scene = undefined; this.layoutBackdrop=undefined;this.layoutsWarmed=false;this.layoutImages.forEach(entry=>{entry.texture=undefined;});this.surfaces.clear(); this.held.clear();
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(log ?? "Shader failed"); }
      return shader;
    };
    this.program = gl.createProgram()!;
    const shaders = [compile(gl.VERTEX_SHADER, VERTEX), compile(gl.FRAGMENT_SHADER, FRAGMENT)];
    shaders.forEach(shader => gl.attachShader(this.program, shader)); gl.bindAttribLocation(this.program, 0, "position"); gl.linkProgram(this.program);
    shaders.forEach(shader => gl.deleteShader(shader));
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error("Shader link failed");
    this.finishProgram = gl.createProgram()!;
    const finishShaders = [compile(gl.VERTEX_SHADER, VERTEX), compile(gl.FRAGMENT_SHADER, FINISH_FRAGMENT)];
    finishShaders.forEach(shader => gl.attachShader(this.finishProgram, shader));
    gl.bindAttribLocation(this.finishProgram, 0, "position"); gl.linkProgram(this.finishProgram);
    finishShaders.forEach(shader => gl.deleteShader(shader));
    if (!gl.getProgramParameter(this.finishProgram, gl.LINK_STATUS)) throw new Error("Grain shader link failed");
    this.framebuffer = gl.createFramebuffer()!; this.composed = gl.createTexture()!;
    this.detailPass = undefined;
    this.composedWidth = this.composedHeight = 0;
    gl.useProgram(this.program);
    this.buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, "position"); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.picture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.picture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  }
  suspend() {
    this.contextLost = true; this.generation++;
    this.histogramReadback = undefined;
    this.uniformLocations.clear();
    this.textures.clear(); this.waiting.clear(); this.activeLuts = []; this.surfaces.clear(); this.held.clear();
  }
  restore() {
    if (this.disposed) return;
    this.initialize(); this.contextLost = false;
  }
  get histogramPending(): boolean { return !!this.histogramReadback?.fence; }
  cancelHistogram() {
    const sample = this.histogramReadback;
    if (sample?.fence) { this.gl.deleteSync(sample.fence); sample.fence = undefined; }
  }
  requestHistogram(): boolean {
    if (this.disposed || this.contextLost || !this.pictureDrawn || this.histogramPending) return false;
    const gl = this.gl;
    let sample = this.histogramReadback;
    if (!sample) {
      const buffer = gl.createBuffer(), framebuffer = gl.createFramebuffer(), texture = gl.createTexture();
      if (!buffer || !framebuffer || !texture) {
        if (buffer) gl.deleteBuffer(buffer); if (framebuffer) gl.deleteFramebuffer(framebuffer); if (texture) gl.deleteTexture(texture);
        throw new Error("Histogram buffer unavailable");
      }
      sample = this.histogramReadback = { buffer, framebuffer, texture, bytes: new Uint8Array(128 * 72 * 4) };
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 128, 72, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteBuffer(buffer); gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture);
        this.histogramReadback = undefined; throw new Error("Histogram framebuffer unavailable");
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, sample.bytes.byteLength, gl.STREAM_READ);
    }
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sample.framebuffer);
      gl.blitFramebuffer(0, 0, this.canvas.width, this.canvas.height, 0, 0, 128, 72, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sample.framebuffer); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, sample.buffer);
      // Offset zero targets the GPU buffer. No CPU pixel copy waits here.
      gl.readPixels(0, 0, 128, 72, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      sample.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? undefined;
      gl.flush(); return !!sample.fence;
    } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  }
  readHistogram(): Uint8ClampedArray | null {
    const sample = this.histogramReadback;
    if (!sample?.fence || this.disposed || this.contextLost) return null;
    const gl = this.gl, status = gl.clientWaitSync(sample.fence, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) return null;
    this.cancelHistogram();
    if (status === gl.WAIT_FAILED) return null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, sample.buffer);
    try { gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, sample.bytes); }
    finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    return new Uint8ClampedArray(sample.bytes.buffer);
  }
  private activeLuts: string[] = [];
  private sceneTarget(width: number,height: number) {
    const gl=this.gl;
    if (!this.scene) {
      const program=gl.createProgram()!;
      for (const [kind,source] of [[gl.VERTEX_SHADER,VERTEX],[gl.FRAGMENT_SHADER,`#version 300 es
precision highp float; in vec2 uv; out vec4 color; uniform sampler2D scene; uniform float opacity;
void main(){color=vec4(texture(scene,vec2(uv.x,1.-uv.y)).rgb,opacity);}`]] as const) {
        const shader=gl.createShader(kind)!;gl.shaderSource(shader,source);gl.compileShader(shader);
        if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Scene shader failed');
        gl.attachShader(program,shader);gl.deleteShader(shader);
      }
      gl.bindAttribLocation(program,0,'position');gl.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error('Scene shader link failed');
      this.scene={program,framebuffer:gl.createFramebuffer()!,texture:gl.createTexture()!,width:0,height:0};
    }
    const scene=this.scene;
    gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,scene.texture);
    const resized = scene.width !== width || scene.height !== height;
    if (resized) {
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      scene.width=width;scene.height=height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,scene.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,scene.texture,0);
    if (resized && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Scene framebuffer unavailable');
    return scene;
  }
  private correctionBasics = new Map<string,{key?:number;value:BasicAdjust;from?:BasicAdjust;at:number}>();
  private warmLayouts(width: number, height: number) {
    // First-use shader and driver compilation must finish on the paused opening
    // picture, rather than blocking the sound clock at a later layout boundary.
    // Draw only into the existing reusable 1px scene/backdrop targets.
    const gl = this.gl, destination = gl.getParameter(gl.FRAMEBUFFER_BINDING), program = gl.getParameter(gl.CURRENT_PROGRAM);
    const scene = this.sceneTarget(1, 1), backdrop = this.layoutBackdrop ??= new LayoutBackdropPass(gl);
    this.layoutsWarmed = true;
    try {
      backdrop.target(1, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.framebuffer);
      backdrop.draw({kind:'colour',colour:'#000000'}, 1, 1);
      gl.useProgram(this.program); gl.viewport(0, 0, 1, 1);
      const uniform = (name: string) => this.uniform(this.program, name);
      gl.uniform1i(uniform('layoutCircle'), 1); gl.uniform1i(uniform('layoutSceneMask'), 1);
      gl.uniform1f(uniform('layoutRadius'), 1); gl.uniform2f(uniform('layoutPixels'), 1, 1);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      backdrop.target(1, 1); gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.useProgram(scene.program); gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, scene.texture);
      gl.uniform1i(this.uniform(scene.program, 'scene'), 4);
      gl.uniform1f(this.uniform(scene.program, 'opacity'), 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.finish();
    } finally {
      gl.disable(gl.BLEND); gl.bindFramebuffer(gl.FRAMEBUFFER, destination); gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0); gl.viewport(0, 0, width, height);
    }
  }
  private arrivingBasic(clipId:string,basic:BasicAdjust,key:number|undefined) {
    const old=this.correctionBasics.get(clipId),now=performance.now();
    let state=old;
    if(!old || old.key!==key || JSON.stringify(old.value)!==JSON.stringify(basic) && !old.from) {
      state={key,value:basic,from:old && key!==undefined && old.key!==key ? old.value : undefined,at:now};
      this.correctionBasics.set(clipId,state);
      if(this.correctionBasics.size>128)this.correctionBasics.delete(this.correctionBasics.keys().next().value!);
    }
    if(!state?.from)return basic;
    const progress=correctionArrival.progress(now-state.at);
    if(progress===1){delete state.from;return basic;}
    this.changed();
    return normalizeBasic(Object.fromEntries(Object.keys(basic).map(k=>[k,state!.from![k as keyof BasicAdjust]+(basic[k as keyof BasicAdjust]-state!.from![k as keyof BasicAdjust])*progress])));
  }
  private activeBasic = normalizeBasic();
  private pictureDrawn = false;
  hasDrawn(look: string[]): boolean { return this.pictureDrawn && this.activeLuts === look; }
  pictureWasDrawn(): boolean { return this.pictureDrawn; }
  private upload(id: string, lut: Lut) {
    const gl = this.gl, texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, texture);
    // Manual tetrahedral sampling needs only core float texelFetch.
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    for (const direction of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, direction, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, new Float32Array(lut.data));
    this.textures.set(id, { texture, size: lut.size });
  }
  private table(id: string, unit: number) {
    const gl = this.gl, arrived = this.textures.has(id) ? undefined : lutReady.get(id);
    if (arrived) this.upload(id, arrived);
    const entry = this.textures.get(id);
    gl.activeTexture(gl.TEXTURE0 + unit);
    if (entry) { gl.bindTexture(gl.TEXTURE_3D, entry.texture); return entry.size; }
    if (!this.waiting.has(id)) {
      this.waiting.add(id);
      const generation = this.generation;
      void playerLut(id).then(lut => {
        if (this.disposed || this.contextLost || generation !== this.generation) return;
        this.upload(id, lut); this.waiting.delete(id); this.changed();
      }).catch(() => { if (!this.disposed && generation === this.generation) { this.waiting.delete(id); this.failed(); } });
    }
    return 0;
  }
  private surface(key: unknown): Surface {
    let surface = this.surfaces.get(key);
    if (surface) return surface;
    const gl = this.gl, texture = key === "scratch" ? this.picture : gl.createTexture()!;
    if (key !== "scratch") {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    surface = { texture, aspect: 16 / 9, filled: false };
    this.surfaces.set(key, surface);
    return surface;
  }
  /** What a layer shows now: its decoded frame or stand-in (uploaded), else the last frame its decoder or layer drew. */
  private source(layer: StageLayer, pieces: DraftPiece[], bypassLook = false): SourcePlan | null {
    const picture = layer.video, video = picture && "readyState" in picture ? picture : null;
    let surface: Surface | undefined, piece = layer.piece, upload: SourcePlan["upload"] = null, aspect = 0;
    if (picture && !(video && video.readyState < 2)) {
      surface = this.surface(layer.key ?? video ?? "scratch"); upload = picture;
      aspect = video ? video.videoWidth / video.videoHeight : "displayWidth" in picture ? picture.displayWidth / picture.displayHeight : picture.width / picture.height;
      const stable=video?.paused||'naturalWidth' in picture||'timestamp' in picture,time=video?.currentTime??('timestamp' in picture?picture.timestamp:undefined),url=video?.currentSrc??('src' in picture?picture.src:'');
      if(stable&&surface.filled&&surface.uploaded===picture&&surface.uploadTime===time&&surface.uploadUrl===url)upload=null;
    } else {
      const own = video ? this.surfaces.get(video) : undefined, held = this.held.get(layer.piece.layer);
      if (own?.filled) { surface = own; piece = own.piece ?? piece; }
      else if (held) { surface = held.surface; piece = held.piece; }
      if (surface) aspect = surface.aspect;
    }
    if (!surface) return null;
    const index = pieceIndex(pieces, piece);
    // A look chosen for an older plan can be shorter than this one: a piece it doesn't cover keeps its own colour.
    const id = (index < 0 ? undefined : this.activeLuts[index]) ?? piece.lut;
    return { surface, piece, upload, aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9, id, lutSize: bypassLook ? 1 : id ? this.table(id, 1) : 0 };
  }
  draw(layers: (StageLayer | null)[], time: number, pieces: DraftPiece[], look: LiveLook | undefined, width: number, height: number, adjustment?: BasicPreview, previewPiece?: number, texture?: TexturePreview, bypassLook = false) {
    this.pictureDrawn = false;
    if (this.disposed || this.contextLost) return;
    const gl = this.gl;
    if (bypassLook) texture = undefined;
    const diffusionLook = (content: DraftPiece, id = content.lut) => pieceDiffusionLook(content, id, adjustment);
    const scopedDiffusion = !bypassLook && scopedDiffusionOf(pieces, pieces.map(p => p.lut), adjustment, texture);
    if (scopedDiffusion && texture) { width = texture.width; height = texture.height; }
    if (detailActive(texture?.detail) || texture?.maskOnly) { width = texture!.width; height = texture!.height; }
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    const requested = look ?? pieces.map(piece => piece.lut);
    // Load the entire choice before publishing any piece; old textures remain
    // visible while IPC and GPU uploads complete, even during paused playback.
    const ready = !bypassLook && requested.map(id => this.table(id, 1)).every(Boolean);
    if (ready && requested !== this.activeLuts) {
      this.activeLuts = requested;
      this.activeBasic = lookBasics.get(requested) ?? adjustment?.baseline ?? normalizeBasic();
      if (this.textures.size > 64) for (const [id, entry] of this.textures) {
        if (requested.includes(id)) continue;
        gl.deleteTexture(entry.texture); this.textures.delete(id);
        if (this.textures.size <= 64) break;
      }
    }
    if (!bypassLook && !this.activeLuts.length) return;
    const visible = pieces.filter(p => p.proxy && p.startS <= time && p.endS > time);
    if (visible.some(p => (p as LayoutPicture).layoutRegion) && visible.some(p => !layers.some(l => l && l.piece === p))) return;
    for(const piece of visible){
      const visual=visualLayout(piece as LayoutPicture,time,width,height);
      if(visual.background?.kind!=='image'||!visual.image)continue;
      let entry=this.layoutImages.get(visual.image);
      if(!entry){
        const img=new Image();img.crossOrigin='anonymous';entry={image:img};this.layoutImages.set(visual.image,entry);
        img.onload=()=>{if(!this.disposed)this.changed();};img.onerror=()=>{if(!this.disposed)this.failed();};img.src=visual.image;
        if(this.layoutImages.size>16){const old=this.layoutImages.keys().next().value!;const previous=this.layoutImages.get(old)!;previous.image.onload=null;previous.image.onerror=null;if(previous.texture)gl.deleteTexture(previous.texture);this.layoutImages.delete(old);}
      }
      if(!entry.image.complete||!entry.image.naturalWidth)return;
    }
    // PS1: never clear while a layer has no picture or colour yet. Hold the stage as it is, so a pending layer never
    // flashes black; past HOLD_MS draw what is there rather than freeze. Black is left only where there is no picture.
    const present = layers.filter((layer): layer is StageLayer => !!layer);
    const plans = new Map(present.map(layer => [layer, this.source(layer, pieces, bypassLook)] as const));
    const whole = present.every(layer => plans.get(layer)?.lutSize);
    if (visible.length && ![...plans.values()].some(Boolean)) return;
    if (!whole && this.wholeAt && Date.now() - this.wholeAt < HOLD_MS) return;
    const finishing = scopedDiffusion || !!(texture?.grain?.amount || texture?.vignette?.amount || detailActive(texture?.detail) || texture?.maskOnly);
    if (finishing) {
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.composed);
      const resized = this.composedWidth !== width || this.composedHeight !== height;
      if (resized) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.composedWidth = width; this.composedHeight = height;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.composed, 0);
      if (resized && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Grain framebuffer unavailable");
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(this.program);
    const uniform = (name: string) => this.uniform(this.program, name);
    const drawLayer = (layer: (typeof layers)[number], opaque = false) => {
      const plan = layer && plans.get(layer);
      if (!layer || !plan) return;
      if(!visualLayout(layer.piece as LayoutPicture,time,width,height).visible)return;
      gl.useProgram(this.program);
      // The picture's own piece (a held frame can be an earlier one) decides its colour and crop; the layer's
      // place on the timeline decides opacity, blur and layout.
      const content = plan.piece;
      // Logical piece ids can cover several transcript spans and an overlay.
      // Scope per layer so dissolving neighbours never receive this clip's delta.
      gl.uniform1i(uniform("bypassLook"), bypassLook ? 1 : 0);
      const scoped = !bypassLook && (previewPiece === undefined || content.piece === previewPiece);
      const baked = previewPiece === undefined || scoped && lookBasics.has(this.activeLuts) ? this.activeBasic : adjustment?.baseline ?? this.activeBasic;
      gl.uniform1fv(uniform("basicDeltaValues[0]"), basicDelta(scoped ? adjustment?.target ?? baked : baked, baked));
      const id = plan.id;
      const colour = scoped ? adjustment : undefined;
      gl.uniform1fv(uniform("mixerDeltaValues[0]"),mixerDelta(colour?.mixer?.target,colour?.mixer?.baseline));
      const cleanId=colour?.intensity?.clean[pieceIndex(pieces,content)];
      const neutralSize=!bypassLook && cleanId ? this.table(cleanId,5) : 0;
      gl.uniform1i(uniform("neutralLut"),neutralSize ? 5 : 1); gl.uniform1i(uniform("intensityPreview"),neutralSize ? 1 : 0);
      gl.uniform1f(uniform("intensityRatio"),colour?.intensity ? colour.intensity.target/Math.max(.001,colour.intensity.baseline) : 1);
      const recipe = id ? gradeReady.get(id) : undefined;
      const live = pieceLiveGrade(content, recipe, adjustment);
      const draftGrade = adjustment?.grade;
      gl.uniform1i(uniform("uniformGrade"),recipe && live ? 1 : 0);
      if (recipe && live) {
        gl.uniform1fv(uniform("basicDeltaValues[0]"),basicDelta(this.arrivingBasic(content.clipId,normalizeBasic(live.basic),draftGrade ? undefined : adjustment?.saved?.correctionKey),normalizeBasic()));
        gl.uniform1fv(uniform("mixerDeltaValues[0]"),mixerDelta(live.mixer,undefined));
        gl.uniform1fv(uniform("lookParams[0]"),lookParameters(live));
        const correction=recipe.exposure,stops=Math.min(correction.matched ? .7 : 0,Math.max(-1,correction.stops || 0));
        gl.uniform4f(uniform("exposureGain"),...([0,1,2].map(ch=>2**stops*(correction.gains?.[ch] ?? 1)) as [number,number,number]),0);
      }
      const lutSize = bypassLook ? 1 : id ? this.table(id, 1) : 0;
      if (!lutSize) return;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, plan.surface.texture);
      if (plan.upload) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, plan.upload);
        plan.surface.filled = true; plan.surface.aspect = plan.aspect; plan.surface.piece = content;
        plan.surface.uploaded=plan.upload;plan.surface.uploadTime='currentTime' in plan.upload?plan.upload.currentTime:'timestamp' in plan.upload?plan.upload.timestamp:undefined;plan.surface.uploadUrl=String('currentSrc' in plan.upload?plan.upload.currentSrc:'src' in plan.upload?plan.upload.src:'');
        this.held.set(layer.piece.layer, { surface: plan.surface, piece: content });
      }
      gl.uniform1i(uniform("picture"), 0); gl.uniform1i(uniform("pieceLut"), 1);
      gl.uniform1f(uniform("lutSize"), lutSize); gl.uniform1i(uniform("clipping"), this.clipping && !bypassLook && !finishing ? 1 : 0);
      const blur = blurAt(layer.piece, time);
      const layout = layer.piece as LayoutPicture, visual=visualLayout(layout,time,width,height), region = visual.region;
      const opacity = (opaque ? 1 : opacityAt(layer.piece, time))*visual.opacity;
      gl.viewport(region ? Math.round(width*region.x) : 0,region ? height-Math.round(height*region.y)-Math.round(height*region.h) : 0,region ? Math.round(width*region.w) : width,region ? Math.round(height*region.h) : height);
      gl.uniform1i(uniform('layoutCircle'),visual.circle ? 1 : 0);gl.uniform1i(uniform('layoutSceneMask'),layout.layoutScene?1:0);
      gl.uniform1i(uniform('layoutDim'),layout.layoutDim ? 1 : 0);
      gl.uniform1f(uniform('layoutRadius'),visual.radius*width/(layout.layoutReferenceWidth??width));
      const cardColour = layout.layoutColour ?? TITLE_CARD_BASE;
      gl.uniform3f(uniform('layoutColour'), ...([1,3,5].map(i => parseInt(cardColour.slice(i,i+2),16)/255) as [number,number,number]));
      gl.uniform2f(uniform('layoutPixels'),layout.layoutScene ? Math.round(width*(region?.w ?? 1)) : 960*(region?.w ?? 1),layout.layoutScene ? Math.round(height*(region?.h ?? 1)) : 960*height/width*(region?.h ?? 1));
      gl.uniform1f(uniform("opacity"), opacity);
      gl.uniform2f(uniform("blurVector"), Math.cos(blur.angle) * blur.amount, Math.sin(blur.angle) * blur.amount * width / height);
      const rotation = pictureTurn(content);
      gl.uniform1i(uniform("pictureTurn"), rotation.turn);
      const aspect = rotation.turn % 180 ? 1 / plan.aspect : plan.aspect;
      let rect = frameAtTime(content, time);
      // A damaged index can lack source dimensions. Empty keys request a
      // centre crop using the decoded picture, preserving its real aspect.
      if (content.frame?.length === 0) {
        const target = region ? region.w * width / (region.h * height) : width / height;
        const w = Math.min(1, target / aspect), h = Math.min(1, aspect / target);
        rect = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
      }
      if(visual.preview&&rect&&region){
        const ar=region.w*width/(region.h*height);let h=visual.circle===!!layout.layoutCircle?rect.h:Math.min(1,aspect/ar),w=h*ar/aspect;if(w>1){w=1;h=aspect/ar;}
        rect={x:Math.max(0,Math.min(1-w,rect.x+rect.w/2-w/2)),y:Math.max(0,Math.min(1-h,rect.y+rect.h/2-h/2)),w,h};
      }
      if (rect && rotation.framingTurn % 180) {
        const w = Math.min(1, (width / height) / aspect), h = Math.min(1, aspect / (width / height));
        rect = { x: (1-w)/2, y: (1-h)/2, w, h };
      }
      gl.uniform4f(uniform("rect"), rect?.x ?? 0, rect?.y ?? 0, rect?.w ?? 1, rect?.h ?? 1);
      gl.uniform1i(uniform("fitted"), rect ? 0 : 1);
      gl.uniform1f(uniform("sourceAspect"), aspect); gl.uniform1f(uniform("outputAspect"), region ? region.w*width/(region.h*height) : width / height);
      paintTransform(gl,uniform,undefined,region ? region.w*width/(region.h*height) : width/height);
      if(visual.background){
        const bg=visual.background,pass=this.layoutBackdrop??=new LayoutBackdropPass(gl),destination=gl.getParameter(gl.FRAMEBUFFER_BINDING);
        pass.target(width,height);
        if(bg.kind==='screen'){
          const h=Math.min(1,aspect/(width/height)),w=h*(width/height)/aspect;
          gl.useProgram(this.program);gl.viewport(0,0,width,height);gl.uniform4f(uniform('rect'),(1-w)/2,(1-h)/2,w,h);gl.uniform1i(uniform('fitted'),0);gl.uniform1i(uniform('layoutCircle'),0);gl.uniform1f(uniform('layoutRadius'),0);gl.uniform1f(uniform('opacity'),1);gl.drawArrays(gl.TRIANGLES,0,6);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER,destination);
        let imageTexture:WebGLTexture|undefined,imageAspect=1;
        if(visual.image){
          let entry=this.layoutImages.get(visual.image);
          if(!entry){const img=new Image();img.crossOrigin='anonymous';entry={image:img};this.layoutImages.set(visual.image,entry);img.onload=()=>{if(!this.disposed)this.changed();};img.src=visual.image;}
          if(entry.image.complete&&entry.image.naturalWidth){
            if(!entry.texture){entry.texture=gl.createTexture()!;gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,entry.texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,entry.image);}
            imageTexture=entry.texture;imageAspect=entry.image.naturalWidth/entry.image.naturalHeight;
          }
        }
        pass.draw(bg,width,height,imageTexture,imageAspect);
        gl.useProgram(this.program);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,plan.surface.texture);
        gl.uniform4f(uniform('rect'),rect?.x??0,rect?.y??0,rect?.w??1,rect?.h??1);gl.uniform1i(uniform('fitted'),rect?0:1);gl.uniform1i(uniform('layoutCircle'),visual.circle?1:0);gl.uniform1f(uniform('layoutRadius'),visual.radius*width/(layout.layoutReferenceWidth??width));gl.uniform1f(uniform('opacity'),opacity);
        gl.viewport(region?Math.round(width*region.x):0,region?height-Math.round(height*region.y)-Math.round(height*region.h):0,region?Math.round(width*region.w):width,region?Math.round(height*region.h):height);
      }
      paintTransform(gl,uniform,visualTransform(content),region ? region.w*width/(region.h*height) : width/height);
      if (opacity < 1 || visual.circle || visual.radius>0) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
      gl.drawArrays(gl.TRIANGLES, 0, 6); this.pictureDrawn = true;
      if (opacity < 1 || visual.circle || visual.radius>0) gl.disable(gl.BLEND);
    };
    // Dissolve a finished scene once, rather than blending its screen and face
    // independently. One reusable texture avoids extra video decoders/contexts.
    if (scopedDiffusion || layers.some(l => (l?.piece as LayoutPicture)?.layoutRegion) && layers.some(l => l && opacityAt(l.piece,time)<1)) {
      const groups=new Map<number|string,NonNullable<(typeof layers)[number]>[]>();
      for (const layer of layers) if(layer){const piece=layer.piece,owner=piece.piece ?? `${piece.clipId}:${piece.startS}`;const id=scopedDiffusion && !(piece as LayoutPicture).layoutRegion ? `${owner}:${piece.layer}` : owner;groups.set(id,[...groups.get(id) ?? [],layer]);}
      for (const group of [...groups.values()].sort((a,b)=>a[0].piece.startS-b[0].piece.startS)) {
        const scene=this.sceneTarget(width,height);gl.viewport(0,0,width,height);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
        group.sort((a,b)=>visualLayout(a.piece as LayoutPicture,time,width,height).order-visualLayout(b.piece as LayoutPicture,time,width,height).order).forEach(layer=>drawLayer(layer,true));
        const content = plans.get(group[0]);
        const diffusion = content ? diffusionLook(content.piece,content.id)?.diffusion ?? (previewPiece === undefined ? texture?.detail?.diffusion : adjustment?.saved?.grade.detail?.diffusion) ?? 0 : 0;
        const sceneTexture = scopedDiffusion && diffusion ? (this.detailPass ??= new DetailPass(gl)).draw(scene.texture,width,height,{...NO_DETAIL,diffusion}) : scene.texture;
        gl.bindFramebuffer(gl.FRAMEBUFFER,finishing ? this.framebuffer : null);gl.viewport(0,0,width,height);gl.useProgram(scene.program);
        gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,sceneTexture);gl.uniform1i(this.uniform(scene.program,'scene'),4);
        gl.uniform1f(this.uniform(scene.program,'opacity'),opacityAt(group[0].piece,time));
        gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.drawArrays(gl.TRIANGLES,0,6);gl.disable(gl.BLEND);
      }
    } else [...layers].sort((a,b)=>a&&b?visualLayout(a.piece as LayoutPicture,time,width,height).order-visualLayout(b.piece as LayoutPicture,time,width,height).order:0).forEach(layer=>drawLayer(layer));
    if (whole && this.pictureDrawn) this.wholeAt = Date.now();
    gl.viewport(0,0,width,height);
    if (finishing && texture) {
      const globalDetail = scopedDiffusion && texture.detail ? {...texture.detail,diffusion:0} : texture.detail;
      const detailed = detailActive(globalDetail) || texture.maskOnly
        ? (this.detailPass ??= new DetailPass(gl)).draw(this.composed, width, height, globalDetail ?? null, texture.maskOnly) : this.composed;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.useProgram(this.finishProgram);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, detailed);
      const uniform = (name: string) => this.uniform(this.finishProgram, name);
      gl.uniform1i(uniform("composed"), 2); gl.uniform2f(uniform("outputShape"), texture.width, texture.height);
      gl.uniform1f(uniform("outputFrame"), Math.floor(time * texture.fps + 1e-6));
      const g = texture.maskOnly ? null : texture.grain, v = texture.maskOnly ? null : texture.vignette;
      if (g?.amount) { (this.grainPlate ??= new GrainPlate(gl)).bind(g, 3); gl.uniform1i(uniform("grainPlate"), 3); }
      for (const [name, value] of Object.entries({ grainAmount: g?.amount ?? 0, grainSize: g?.size ?? 0, grainRoughness: g?.roughness ?? 0, grainColour: g?.colour ?? 0, grainShadows: g?.shadows ?? 0, grainHighlights: g?.highlights ?? 0,
        vignetteAmount: v?.amount ?? 0, vignetteMidpoint: v?.midpoint ?? 50, vignetteFeather: v?.feather ?? 70 })) gl.uniform1f(uniform(name), value);
      gl.uniform1i(uniform("clipping"), this.clipping ? 1 : 0); gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (this.pictureDrawn && !this.layoutsWarmed && pieces.some(piece => (piece as LayoutPicture).layoutRegion)) this.warmLayouts(width, height);
  }
  async thumbnail(frame: LookFrame, id: string, width = 160, height = 120): Promise<string> {
    const lut = await cachedLiveLut(id);
    if (this.disposed) throw new Error("Thumbnail renderer closed");
    if (!this.textures.has(id)) this.upload(id, lut);
    this.draw([{ video: frame.image, piece: frame.piece }], frame.time, [frame.piece], [id], width, height);
    // Copy synchronously before another look draws into the shared GL canvas.
    const tile = document.createElement("canvas"); tile.width = width; tile.height = height;
    const context = tile.getContext("2d");
    if (!context) throw new Error("Couldn't copy the look preview.");
    context.drawImage(this.canvas, 0, 0);
    return tile.toDataURL("image/png");
  }
  dispose(releaseContext = false) {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    this.uniformLocations.clear();
    const gl = this.gl;
    if (this.histogramReadback) {
      this.cancelHistogram(); gl.deleteBuffer(this.histogramReadback.buffer); gl.deleteFramebuffer(this.histogramReadback.framebuffer); gl.deleteTexture(this.histogramReadback.texture);
      this.histogramReadback = undefined;
    }
    this.textures.forEach(entry => gl.deleteTexture(entry.texture)); this.textures.clear(); this.waiting.clear();
    this.layoutImages.forEach(entry=>{entry.image.onload=null;if(entry.texture)gl.deleteTexture(entry.texture);});this.layoutImages.clear();
    this.surfaces.forEach(surface => { if (surface.texture !== this.picture) gl.deleteTexture(surface.texture); }); this.surfaces.clear(); this.held.clear();
    this.layoutBackdrop?.dispose();
    this.detailPass?.dispose();
    if(this.scene){gl.deleteTexture(this.scene.texture);gl.deleteFramebuffer(this.scene.framebuffer);gl.deleteProgram(this.scene.program);}
    gl.deleteTexture(this.picture); gl.deleteTexture(this.composed); gl.deleteFramebuffer(this.framebuffer); gl.deleteProgram(this.finishProgram); this.grainPlate?.dispose(); gl.deleteBuffer(this.buffer); gl.deleteProgram(this.program);
    if (releaseContext) gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

let sharedThumbnails: { renderer: LiveCanvas; users: number } | null = null;
/** All mounted galleries lease ONE offscreen GL context; the last close frees it. */
export function createLookThumbnailRenderer() {
  const shared = sharedThumbnails ??= { renderer: new LiveCanvas(document.createElement("canvas"), () => {}, () => {}), users: 0 };
  shared.users++;
  let closed = false;
  return { async thumbnail(frame: LookFrame, id: string, width?: number, height?: number) {
    if (closed) throw new Error("Thumbnail renderer closed");
    return shared.renderer.thumbnail(frame, id, width, height);
  }, dispose() {
    if (closed) return;
    closed = true;
    if (--shared.users === 0) { shared.renderer.dispose(true); sharedThumbnails = null; }
  } };
}

type TitleRenderer = { init(track: TitleTrack, options: { width: number; height: number; layer: "all"; live?: boolean; at?: number; overlays: NonNullable<DraftTimeline["overlays"]> }): Promise<void>; seek(time: number): Promise<void> };
type TitleWindow = Window & { titleRenderer?: TitleRenderer };
// Import the SAME fixed interpreter as the exported title renderer, including word timing and motion.
const latinRange = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const extendedRange = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0300-0303,U+0305-0307,U+0309-0328,U+032A-036F,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const titleFonts = [outfit600, outfit700, outfit800, outfit900].map((url, index) => `@font-face{font-family:Outfit;font-style:normal;font-weight:${600 + index * 100};src:url('${url}');unicode-range:${latinRange}}`).join("")
  + `@font-face{font-family:'Inter Display';font-style:normal;font-weight:100 900;src:url('${inter}');unicode-range:${latinRange}}@font-face{font-family:Inter;font-style:normal;font-weight:100 900;src:url('${inter}');unicode-range:${latinRange}}@font-face{font-family:'Inter Display';font-style:italic;font-weight:100 900;src:url('${interItalic}');unicode-range:${latinRange}}@font-face{font-family:Inter;font-style:italic;font-weight:100 900;src:url('${interItalic}');unicode-range:${latinRange}}`;
const extendedTitleFonts = [outfitExtended600, outfitExtended700, outfitExtended800, outfitExtended900].map((url, index) => `@font-face{font-family:Outfit;font-style:normal;font-weight:${600 + index * 100};src:url('${url}');unicode-range:${extendedRange}}`).join("")
  + `@font-face{font-family:'Inter Display';font-style:normal;font-weight:100 900;src:url('${interExtended}');unicode-range:${extendedRange}}@font-face{font-family:'Inter Display';font-style:italic;font-weight:100 900;src:url('${interExtendedItalic}');unicode-range:${extendedRange}}`;
const captionFonts = `@font-face{font-family:"Montserrat";font-weight:100 900;src:url('${captionFont0}')}` + `@font-face{font-family:"Poppins";font-weight:100 900;src:url('${captionFont1}')}` + `@font-face{font-family:"Bebas Neue";font-weight:100 900;src:url('${captionFont2}')}` + `@font-face{font-family:"Archivo Black";font-weight:100 900;src:url('${captionFont3}')}` + `@font-face{font-family:"Caveat";font-weight:100 900;src:url('${captionFont4}')}`
  // The opening caption is italic and heavy: the same real italic faces the export template embeds (electron.vite.config.ts).
  + `@font-face{font-family:"Montserrat";font-style:italic;font-weight:100 800;src:url('${captionItalic0}')}@font-face{font-family:"Montserrat";font-style:italic;font-weight:900;src:url('${captionItalic1}')}`
  + `@font-face{font-family:"Poppins";font-style:italic;font-weight:100 800;src:url('${captionItalic2}')}@font-face{font-family:"Poppins";font-style:italic;font-weight:900;src:url('${captionItalic3}')}`;
export const titleDocument = titleTemplate.replace("/*__TITLE_FONTS__*/", titleFonts + extendedTitleFonts + captionFonts);

interface Props {
  visibility?: LaneVisibility;
  bypassLook?: boolean;
  savedGrade?: Grade | null; previewDetail?: DetailChoice | null; previewGrain?: GrainChoice | null; previewVignette?: VignetteChoice | null;
  timeline: DraftTimeline; look?: LiveLook; liveTitles?: TitleTrack | null; label: string; focused: boolean;
  /** A voiceover take owns the keyboard (Space, Esc); playback itself keeps running. */
  recording?: boolean;
  /** Still shown until the first composited frame, so opening an edit is never black. */
  cover?: string | null;
  /** Logical piece index. setBasicPreview target/baseline apply only to its spans. */
  previewPiece?: number;
  size: { width: number; height: number }; fullscreen: boolean; onFullscreen: () => void;
  onTime?: (time: number) => void; onAspect: (aspect: number) => void;
  /** AV1b: the open edit and version, named in the Apple player's state for MCP. */
  cutId?: string; cutVersion?: number;
}
export const LivePlayer = forwardRef<StageHandle, Props>(function LivePlayer({ timeline: sourceTimeline, look, liveTitles, label, focused, cover, size, fullscreen, onFullscreen, onTime, onAspect, previewPiece, savedGrade, previewDetail, previewGrain, previewVignette, visibility, bypassLook = false, recording = false, cutId, cutVersion }, ref) {
  const layerCount=Math.max(2,...sourceTimeline.pieces.map(p=>p.layer+1));
  const active = usePageActive();
  focused = focused && active;
  const overlaySession = useOverlaySession(sourceTimeline);
  const overlayPreview = overlaySession?.preview;
  const root = useMemo(() => {
    const src = sourceTimeline.pieces.find(piece => piece.proxy.startsWith("st-media:"))?.proxy;
    if (!src) return new URLSearchParams(window.location.hash.split("?")[1]).get("shoot");
    try { return decodeURIComponent(new URL(src).pathname.split("/")[1]); } catch { return null; }
  }, [sourceTimeline]);
  const previews = usePreviewProgress(root);
  const pending = useRef(previews.pending); pending.current = { ...previews.pending };
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const preparingIds = new Set(shoot?.root === root ? shoot.clips.filter(needsSmoothPreview).map(clip => clip.id) : []);
  for (const piece of sourceTimeline.pieces) if (preparingIds.has(piece.clipId)) pending.current[piece.clipId] ??= 0;
  // The shoot only supplies stills for clips whose preview is still being made.
  const waitingOnPreview = Object.keys(previews.pending).length > 0;
  useEffect(() => {
    if (!root) return;
    let alive = true;
    const load = (quiet = false) => { void (quiet ? refreshShootWhenQuiet(root) : getApi().loadShoot(root)).then(value => { if (alive && value) { setShoot(value); observeRotationShoot(value); } }).catch(() => {}); };
    load(shoot?.root === root);
    const off = getApi().onStepsChanged(changed => { if (changed === root) load(true); });
    const progressOff = getApi().onProgress?.(event => {
      const note = (event as typeof event & { note?: string }).note;
      // A receipt is published before this event. Refresh this shot now rather
      // than keeping it covered until the entire shoot's repair has finished.
      if (event.root === root && event.clipId && event.stage === 'done'
        && (note?.startsWith('Preview ready for') || note?.startsWith('Making previews'))) load(true);
    });
    return () => { alive = false; off(); progressOff?.(); };
  }, [root, previews.revision, waitingOnPreview]);
  const timeline = useMemo(() => ({ ...sourceTimeline, pieces: sourceTimeline.pieces.map(piece => {
    const clip = shoot?.clips.find(c => c.id === piece.clipId);
    let proxy = piece.proxy;
    // Only ordinary footage proxies follow the shoot. Reverse and background assets keep their own source.
    const name = (() => { try { return decodeURIComponent(new URL(proxy).pathname.split('/').at(-1)!); } catch { return ''; } })();
    if (clip?.proxy && (name === `${clip.id}.mp4` || name.startsWith(`${clip.id}.r`))) proxy = mediaUrl(shoot!.root, 'proxies', clip.proxy);
    return { ...piece, rotationFrame: proxyRotation(piece.proxy, clip?.meta?.containerRotation ?? clip?.meta?.rotation),
      proxy: proxy && previews.clipRevisions?.[piece.clipId] ? `${proxy}${proxy.includes('?') ? '&' : '?'}preview=${previews.clipRevisions?.[piece.clipId]}` : proxy };
  }) }), [sourceTimeline, previews.clipRevisions, shoot]);
  const trimming = useRef<DraftTimeline | null>(null);
  const timelineRef = useRef<DraftTimeline>(timeline); timelineRef.current = trimming.current ?? timeline;
  const sourceTimelineRef = useRef(sourceTimeline); sourceTimelineRef.current = sourceTimeline;
  const pictureAt = (at: number) => pieceAt(timelineRef.current.pieces.filter(piece => piece.layer === 1), at)
    ?? pieceAt(timelineRef.current.pieces.filter(piece => piece.layer === 0), at);
  const mix = useRef<LiveMix | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null), sound = useRef<HTMLAudioElement>(null), titles = useRef<HTMLIFrameElement>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]), audition = useRef<HTMLVideoElement>(null);
  const layers = useRef<LiveLayer[]>([]), painter = useRef<LiveCanvas | null>(null);
  const clock = useRef({ time: 0, anchor: 0, playing: false });
  const resumePreparedTimeline = useRef(false);
  const auditionEnd = useRef(0), auditionToken = useRef(0);
  const titleReady = useRef(false), lastTitleTime = useRef(-1), titleGeneration = useRef(0);
  const [playing, setPlaying] = useState(false), [muted, setMuted] = useState(false), [time, setTime] = useState(0);
  const [fallback, setFallback] = useState(false), [message, setShownMessage] = useState<string | null>(null), [previewing, setPreviewing] = useState(false);
  // R8b: stage messages are short-lived. One about something that won't change (missing music, no live colour)
  // shows once per open and goes; a failed action (play, take preview) says so every time it is tried.
  const told = useRef(new Set<string>()), messageTimer = useRef<number>();
  const setMessage = useRef((text: string | null, again = false) => {
    if (text !== null && !again && told.current.has(text)) return;
    if (messageTimer.current !== undefined) window.clearTimeout(messageTimer.current);
    setShownMessage(text);
    if (text === null) return;
    told.current.add(text);
    if (typeof window.setTimeout === "function") messageTimer.current = window.setTimeout(() => setShownMessage(null), STAGE_MESSAGE_MS);
  }).current;
  useEffect(() => () => { if (messageTimer.current !== undefined) window.clearTimeout(messageTimer.current); }, []);
  const [titleLoaded, setTitleLoaded] = useState(0);
  const [covered, setCovered] = useState(true), coveredRef = useRef(true);
  useEffect(() => {
    if (!covered || !active) return;
    const owner = {}; markOpening(owner, true);
    return () => markOpening(owner, false);
  }, [covered, active]);
  useEffect(() => () => { window.dispatchEvent(new CustomEvent("sidething:playing", { detail: false })); }, []);
  const [detailMask, setDetailMask] = useState(false);
  useEffect(() => { const read = (event: Event) => { setDetailMask(!!(event as CustomEvent).detail); }; window.addEventListener("sidething:detail-mask", read); return () => window.removeEventListener("sidething:detail-mask", read); }, []);
  const texture: TexturePreview = { detail: normalizeDetail(previewDetail === undefined ? savedGrade?.detail : previewDetail), maskOnly: detailMask, grain: normalizeGrain(previewGrain === undefined ? savedGrade?.grain : previewGrain),
    vignette: normalizeVignette(previewVignette === undefined ? savedGrade?.vignette : previewVignette), width: timeline.width, height: timeline.height, fps: timeline.fps ?? 25 };
  const latest = useRef({ look, focused, active, onTime, size, previewPiece, texture, bypassLook }); latest.current = { look, focused, active, onTime, size, previewPiece, texture, bypassLook };
  const lifecycle = useRef<{ start: () => void; stop: () => void; release: () => void }>();
  const hiddenSince = useRef<number | null>(null);
  // Paused, the picture only changes when something does: the loop skips idle frames.
  const dirty = useRef(true);
  const histogramPending = useRef(false);
  const histogramActive = useRef(isHistogramActive()), clippingPreview = useRef(false), lastHistogram = useRef(0);
  useEffect(() => {
    histogramActive.current = isHistogramActive();
    const reportPlaying = () => window.dispatchEvent(new CustomEvent("sidething:playing", { detail: clock.current.playing }));
    window.addEventListener("sidething:playing-request", reportPlaying);
    const active = (event: Event) => { histogramActive.current = !!(event as CustomEvent).detail; if (!histogramActive.current) painter.current?.cancelHistogram(); lastHistogram.current = 0; histogramPending.current = true; dirty.current = true; };
    const clipping = (event: Event) => { clippingPreview.current = !!(event as CustomEvent).detail; dirty.current = true; };
    window.addEventListener("sidething:histogram-active", active); window.addEventListener("sidething:clipping", clipping);
    return () => { window.removeEventListener("sidething:playing-request", reportPlaying); window.removeEventListener("sidething:histogram-active", active); window.removeEventListener("sidething:clipping", clipping); };
  }, []);
  useEffect(() => { dirty.current = true; }, [bypassLook, look, size.width, size.height, liveTitles, previewPiece, savedGrade?.grain, savedGrade?.vignette, savedGrade?.detail, previewDetail, detailMask, previewGrain, previewVignette]);
  useEffect(() => { queueAppleLook(); }, [look, savedGrade, previewGrain, previewVignette, previewDetail, timeline, bypassLook, cutVersion]);
  const fallbackRef = useRef(false), previewRef = useRef(false);
  const shuttleRate = useRef(1);
  const readClock = () => clock.current.playing ? !((timelineRef.current as LiveSoundTimeline).liveSound) && timelineRef.current.sound && sound.current ? sound.current.currentTime : clock.current.time + (performance.now() - clock.current.anchor) / 1000 * shuttleRate.current : clock.current.time;
  // AV1/AV1b: the Apple player. Its picture is a native view inside this window, below the page. Once its first
  // picture is up, the page leaves the picture rect transparent (appleHole), its clock drives the playhead, and the
  // Chrome picture and mix stay paused underneath, so switching never loses the place. Until then, and whenever the
  // plan changes, the Chrome viewer shows the picture: never a black or empty frame.
  const [appleEnabled, setAppleEnabled] = useState(false);
  const [appleOn, setAppleOn] = useState(false);
  const [appleShowing, setAppleShowing] = useState(false);
  const [appleLine, setAppleLine] = useState(APPLE_OFF_REASON);
  const appleNote = appleLine && appleLine !== APPLE_OFF_REASON && appleLine !== APPLE_ON_REASON ? appleLine : "";
  const appleOnRef = useRef(false), appleLiveRef = useRef(false), appleUpRef = useRef(false);
  // Layout effects place the Apple picture in the same frame as the layout that moved it. (Test renderers without
  // them get a plain effect.)
  const useBeforePaint = typeof useLayoutEffect === "function" ? useLayoutEffect : useEffect;
  // The viewer's own box, found from the canvas (no extra ref on the root element).
  const appleRoot = () => (canvas.current?.closest?.("[data-live-player]") as HTMLElement | null) ?? null;
  // AV2: the Look plays natively, so it no longer decides.
  const appleDecision = applePlayerDecision(timeline, { appleEnabled });
  // AV2: the Settings switch reaches this already open viewer, on and off, with no reopen: Settings says so the moment
  // it saves, and a change made elsewhere (MCP set_settings) is read when the window comes back to the front.
  useEffect(() => {
    let alive = true;
    const read = () => { try { void getApi().getPreferences?.().then(p => { if (alive) setAppleEnabled(!!p?.playback?.applePlayer); }).catch(() => {}); } catch { /* no settings here: the Chrome viewer plays */ } };
    const saved = (event: Event) => { if (alive) setAppleEnabled(!!(event as CustomEvent<boolean>).detail); };
    const page = typeof document === "undefined" ? undefined : document;
    const back = () => { if (page?.visibilityState !== "hidden") read(); };
    read();
    window.addEventListener?.("sidething:apple-player", saved);
    window.addEventListener?.("focus", back);
    page?.addEventListener?.("visibilitychange", back);
    return () => { alive = false; window.removeEventListener?.("sidething:apple-player", saved); window.removeEventListener?.("focus", back); page?.removeEventListener?.("visibilitychange", back); };
  }, []);
  // The placed voice exactly as this viewer schedules it: the Apple plan plays the same lines.
  const appleVoice = useMemo(() => voicePlayback(timeline, root ?? null), [timeline, root]);
  // AV4: each picture piece as this viewer draws it (its layout, masks, background, dissolve and blur over time), from
  // the viewer's own visualLayout, so the Apple plan reads the same numbers. By piece index.
  const appleLayers = useMemo(() => appleDecision.player === "apple" ? timeline.pieces.map(piece => piece.clipId && piece.endS > piece.startS ? appleLayerPlan(piece, timeline, pictureTurn(piece).turn, visualLayout) : null) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, appleDecision.player]);
  // Rebuild the native plan only when what it plays changes, never on a new object identity.
  const appleKey = useMemo(() => {
    const sound = (timeline as LiveSoundTimeline).liveSound;
    const span = (p: { id: string; url: string; startS: number; endS: number; gainDb: number; normalizeDb?: number; muted?: boolean; fadeInS?: number; fadeOutS?: number; loop?: boolean; timeMap?: { t: number; s: number }[] }) =>
      [p.id, p.url, p.startS, p.endS, p.gainDb, p.normalizeDb ?? 0, p.muted ? 1 : 0, p.fadeInS ?? 0, p.fadeOutS ?? 0, p.loop ? 1 : 0, p.timeMap?.[0]?.s ?? 0, p.timeMap?.at(-1)?.s ?? 0];
    const music = sound?.music;
    // Not the version: a new version that only changes the Look (or titles) keeps the loaded plan, and the Look
    // reaches it as numbers (sendAppleLook). Rotations come from the pieces.
    return JSON.stringify([appleDecision.player, appleDecision.reason, appleEnabled, root, cutId, timeline.durationS, timeline.width, timeline.height, timeline.fps,
      timeline.pieces.map(p => [p.clipId, p.startS, p.endS, p.inS, p.proxy, p.layer, p.frame ?? null, p.timeMap ?? null, pictureTurn(p).turn]),
      // PAR1: the export's master stage too: it can land after the plan (once an export made this sound) and sets the level.
      sound ? [sound.pieces.map(span), sound.effects.map(span), sound.audio, sound.laneLevels ?? null, sound.laneMuted ?? null, sound.bleeps.length, sound.master ?? null,
        music ? [music.url, music.startS, music.endS ?? null, music.gainDb ?? null, music.duck ?? null, music.duckDepthDb ?? null, music.stems ?? null, music.stemsStartS ?? null, music.stemDucking ?? null, music.arrangementState ?? null] : null] : null,
      appleVoice, appleLayers]);
  }, [timeline, appleDecision.player, appleDecision.reason, appleEnabled, root, cutId, appleVoice, appleLayers]);
  const appleKeyRef = useRef("");
  /** The native picture is up (behind the page, at the viewer's rect): show it and hand it the clock. */
  const appleGoLive = () => {
    if (appleLiveRef.current) return;
    const wasPlaying = clock.current.playing;
    if (wasPlaying) clock.current.time = Math.min(extentNow(), readClock());
    mix.current?.pause(); layers.current.forEach(layer => layer.pause()); sound.current?.pause();
    appleLiveRef.current = true; setAppleShowing(true); setAppleLine(APPLE_ON_REASON);
    sendAppleLook();
    const api = getApi();
    if (wasPlaying) { clock.current.anchor = performance.now(); void api.appleControl?.("play", { at: clock.current.time, rate: shuttleRate.current }); }
    else void api.appleControl?.("seek", { at: clock.current.time });
  };
  /** Back to the Chrome picture at the current time: the page closes the hole over a drawn frame. */
  const appleStandDown = () => {
    if (!appleLiveRef.current) return;
    const wasPlaying = clock.current.playing;
    if (wasPlaying) clock.current.time = Math.min(extentNow(), readClock());
    void getApi().appleControl?.("pause");
    appleLiveRef.current = false; setAppleShowing(false);
    clock.current.playing = false;
    if (latest.current.active) layers.current.forEach(layer => layer.updateAll(clock.current.time, false, true));
    dirty.current = true;
    // Playing carries on in the Chrome viewer from the same moment; the Apple player takes it back when it is ready.
    if (wasPlaying) play(shuttleRate.current);
  };
  // AV2: the Look as the Apple compositor takes it: for each picture piece, where it sits, its colour table id and
  // the numbers this viewer's shader would take (look parameters, basics, mixer, exposure gains, diffusion), from
  // the same rules (pieceLiveGrade, pieceDiffusionLook), plus the edit's detail, grain and vignette. Read through a
  // ref, so a slider callback always builds from the newest props.
  const appleLookPayload = useRef<() => AppleLookPayload>(() => ({ segments: [], finish: null, bypass: true }));
  const appleLayersRef = useRef(appleLayers); appleLayersRef.current = appleLayers;
  appleLookPayload.current = () => {
    const adjustment = basicPreviews.get(sourceTimeline);
    const ids = timeline.pieces.map((piece, index) => look?.[index] ?? piece.lut);
    const finish = { grain: texture.grain ?? null, vignette: texture.vignette ?? null, detail: texture.detail ?? null,
      scoped: scopedDiffusionOf(timeline.pieces, ids, adjustment, texture) };
    // AV4: every lane's pictures (a layout's, the overlay lane's), each named by where it starts and its lane.
    const segments = timeline.pieces.map((piece, index) => ({ piece, id: ids[index], index }))
      .filter(({ piece }) => piece.clipId && piece.endS > piece.startS)
      .map(({ piece, id, index }) => {
        const recipe = id ? gradeReady.get(id) : undefined;
        // A new version's pieces (a saved slider) carry new ids the hidden Chrome painter has not read: read them here.
        if (id && !recipe) askRecipe(id, () => sendAppleLookRef.current());
        const live = pieceLiveGrade(piece, recipe, adjustment);
        const diffusion = pieceDiffusionLook(piece, id, adjustment)?.diffusion ?? null;
        // AV3: the clip transform this viewer draws (a drag's preview included), in its shader's numbers.
        const transform = appleTransformNumbers(visualTransform(piece), appleRegionAspect(appleLayersRef.current?.[index], timeline));
        const layer = piece.layer;
        if (!recipe || !live) return { start: piece.startS, layer, lutId: id ?? null, diffusion, transform };
        const basic = normalizeBasic(live.basic), correction = recipe.exposure;
        const stops = Math.min(correction.matched ? .7 : 0, Math.max(-1, correction.stops || 0));
        return { start: piece.startS, layer, lutId: id ?? null, diffusion, transform, params: lookParameters(live), basic: BASIC_KEYS.map(key => basic[key]),
          mixer: mixerDelta(live.mixer, undefined), exposure: [0, 1, 2].map(ch => 2 ** stops * (correction.gains?.[ch] ?? 1)) };
      });
    return { segments, finish, bypass: bypassLook, version: cutVersion ?? 0 };
  };
  // A Look slider, a balance, a clip look or the finish moved: only the numbers go (no reload, no black picture,
  // the sound carries on). Sent at once; identical payloads are dropped.
  const appleLookSent = useRef("");
  const sendAppleLook = () => {
    if (!appleOnRef.current) return;
    const look = appleLookPayload.current(), payload = JSON.stringify(look);
    if (payload === appleLookSent.current) return;
    appleLookSent.current = payload;
    // When it left the page, so QA can time a slider step from input to the picture.
    void getApi().appleControl?.("look", { look: JSON.stringify({ ...look, sentAt: Date.now() }) });
  };
  const queueAppleLook = () => sendAppleLook();
  // AV3: a trim drag previews its edge frame on every move in the Chrome viewer (its layers follow the drag), so the
  // Apple picture steps aside for the drag and takes over again with the saved version (it swaps in natively), or
  // after a moment if the drag changed nothing.
  const appleDragRef = useRef(false), appleDragTimer = useRef<number>();
  const appleTrimPreview = (dragging: boolean) => {
    if (dragging) {
      if (appleDragTimer.current !== undefined) { window.clearTimeout(appleDragTimer.current); appleDragTimer.current = undefined; }
      if (!appleDragRef.current && appleLiveRef.current) { appleDragRef.current = true; appleStandDown(); }
      return;
    }
    if (!appleDragRef.current || appleDragTimer.current !== undefined) return;
    appleDragTimer.current = window.setTimeout(() => {
      appleDragTimer.current = undefined;
      appleDragRef.current = false;
      if (appleOnRef.current && appleUpRef.current) appleGoLive();
    }, 600);
  };
  useEffect(() => () => { if (appleDragTimer.current !== undefined) window.clearTimeout(appleDragTimer.current); }, []);
  // AV3: a transform or layout handle being dragged previews on the viewer (precut:layout-preview): the Apple picture
  // takes the new transform numbers the same way it takes a Look slider's.
  useEffect(() => {
    const viewer = canvas.current?.closest?.("[data-cut-player]");
    if (!viewer) return;
    // AV4: a layout handle being dragged (a box, a corner, a background) previews in this viewer's own layout; the Apple
    // picture steps aside for it, as for a trim drag, and takes over again with the saved version.
    const changed = () => {
      const tl = timelineRef.current;
      const layoutDrag = tl.pieces.some(p => (p as LayoutPicture).layoutScene && visualLayout(p as LayoutPicture, p.startS, tl.width, tl.height).preview);
      if (layoutDrag) appleTrimPreviewRef.current(true);
      else { if (appleDragRef.current) appleTrimPreviewRef.current(false); sendAppleLookRef.current(); }
    };
    viewer.addEventListener("precut:layout-preview", changed);
    return () => viewer.removeEventListener("precut:layout-preview", changed);
  }, []);
  const sendAppleLookRef = useRef(sendAppleLook); sendAppleLookRef.current = sendAppleLook;
  const appleTrimPreviewRef = useRef(appleTrimPreview); appleTrimPreviewRef.current = appleTrimPreview;
  useEffect(() => {
    if (appleKeyRef.current === appleKey) return;
    appleKeyRef.current = appleKey;
    let alive = true;
    const api = getApi();
    if (!api.appleSetEdit) { setAppleLine(appleDecision.reason); return; }
    const rotations = Object.fromEntries(timeline.pieces.map(piece => [piece.clipId, pictureTurn(piece).turn]));
    const apple = appleDecision.player === "apple";
    // AV3: the plan needs pictures and sound, not captions or waveform peaks: they stay out of the message (an edit's
    // plan crosses to main on every edit).
    const liveSound = (timeline as LiveSoundTimeline).liveSound;
    const planTimeline = { ...timeline, titles: null, ...(liveSound ? { liveSound: { ...liveSound, pieces: liveSound.pieces.map(({ peaks: _peaks, ...piece }) => piece), effects: liveSound.effects.map(({ peaks: _peaks, ...piece }) => piece) } } : {}) } as DraftTimeline;
    // AV3: a new version of an edit the Apple player is showing (a trim, split, insert, delete, reorder, take swap,
    // undo or redo) swaps in natively: its picture and sound carry on, playing or paused, and the old version stays
    // up until the new one's picture is ready. Only a version it cannot play hands over to the Chrome viewer.
    const live = appleLiveRef.current && apple;
    if (live) {
      const sentAt = Date.now();
      void api.appleSetEdit(root ?? "", cutId ?? "", cutVersion ?? 0, { timeline: planTimeline, player: "apple", reason: appleDecision.reason, appleEnabled, rotations, at: clock.current.time, voice: appleVoice, look: appleLookPayload.current(), sentAt, layers: appleLayers ?? undefined })
        .then(reply => { if (alive && reply.player !== "apple") { appleStandDown(); appleOnRef.current = false; setAppleOn(false); setAppleLine(reply.reason); } })
        .catch(() => { if (alive) { appleStandDown(); appleOnRef.current = false; setAppleOn(false); setAppleLine(appleDecision.reason); } });
      return () => { alive = false; };
    }
    // A new plan: the Chrome picture covers until the native one says its first picture is up.
    const wasLive = appleLiveRef.current;
    appleStandDown();
    appleUpRef.current = false;
    const send = () => void api.appleSetEdit!(root ?? "", cutId ?? "", cutVersion ?? 0, { timeline: apple ? planTimeline : null, player: appleDecision.player, reason: appleDecision.reason, appleEnabled, rotations, at: clock.current.time, ...(apple ? { voice: appleVoice, look: appleLookPayload.current(), sentAt: Date.now(), layers: appleLayers ?? undefined } : {}) })
      .then(reply => {
        if (!alive) return;
        const on = reply.player === "apple";
        appleOnRef.current = on; setAppleOn(on);
        // Until its first picture is up, the Chrome viewer shows and the line names no player it is not using. (The
        // picture can be up before this reply lands: then the line stays "Apple player".)
        setAppleLine(on ? (appleLiveRef.current ? APPLE_ON_REASON : "") : reply.reason);
        if (on && appleUpRef.current) appleGoLive();
      }).catch(() => { if (alive) { appleOnRef.current = false; setAppleOn(false); setAppleLine(appleDecision.reason); } });
    // The page must show the Chrome picture (hole closed) before the native item is replaced: two frames.
    if (wasLive && typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(() => { if (alive) send(); }));
    else send();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appleKey]);
  useEffect(() => {
    const api = getApi();
    if (!api.onAppleEvent) return;
    return api.onAppleEvent(event => {
      if (event.type === "display" || event.type === "swapped") {
        // The reply that the plan loaded and this event can arrive in either order. AV3: a new version swapped in
        // natively (after a drag the Chrome viewer previewed) is up as well.
        appleUpRef.current = true;
        // After a trim drag (the Chrome viewer previewed it), the saved version swapping in ends the hand-off.
        if (event.type === "swapped" && appleDragRef.current && appleDragTimer.current !== undefined) { window.clearTimeout(appleDragTimer.current); appleDragTimer.current = undefined; appleDragRef.current = false; }
        if (appleOnRef.current && !appleDragRef.current) appleGoLive();
      } else if (event.type === "time" && typeof event.time === "number" && appleLiveRef.current) {
        clock.current.time = Math.max(0, Math.min(extentNow(), event.time));
        clock.current.anchor = performance.now();
        if (reported.current !== clock.current.time) { reported.current = clock.current.time; latest.current.onTime?.(clock.current.time); }
        setTime(clock.current.time);
        if (titleReady.current && titles.current && lastTitleTime.current !== clock.current.time) {
          lastTitleTime.current = clock.current.time;
          void (titles.current.contentWindow as TitleWindow | null)?.titleRenderer?.seek(clock.current.time);
        }
      } else if (event.type === "ended" && appleLiveRef.current) {
        clock.current.playing = false; setPlaying(false);
        window.dispatchEvent(new CustomEvent("sidething:playing", { detail: false }));
      } else if (event.type === "failed" && appleOnRef.current) {
        appleStandDown();
        appleOnRef.current = false; setAppleOn(false);
        setAppleLine(event.message?.startsWith("Apple player is off") ? event.message : "Apple player could not play this edit. The standard player takes over.");
        if (event.message) setMessage(event.message, true);
        dirty.current = true;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Where the native picture sits: the viewer's rect, sent as soon as the plan loads (so the first picture lands in
  // place behind the still opaque page) and again in the same frame as any layout change that moves it.
  const appleRect = useRef<() => void>();
  useBeforePaint(() => {
    const el = appleRoot();
    if (!appleOn || !el) { appleRect.current = undefined; return; }
    const api = getApi();
    if (!api.appleControl) { appleRect.current = undefined; return; }
    let last = "";
    const send = (rect: DOMRect) => {
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (key === last) return;
      last = key;
      // The page's new layout reaches the screen about two display refreshes after this callback (Chromium's
      // compositor and GPU process); the native view one refresh after it moves. So the picture moves two refreshes
      // on, counted by the display in main (a busy page thread cannot delay it): AV1b measured 0 of 136 misaligned
      // composited frames through move, resize and full display, against 15 of 136 moved at once
      // (qa/AV1b/results/geometry*.json). QA may set window.__appleRectFrames to compare.
      const frames = (window as unknown as { __appleRectFrames?: number }).__appleRectFrames ?? 2;
      void api.appleControl!("rect", { x: rect.x, y: rect.y, w: rect.width, h: rect.height, frames });
    };
    appleRect.current = () => send(el.getBoundingClientRect());
    appleRect.current();
    void api.appleControl("visible", { visible: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => appleRect.current?.()) : null;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) observer?.observe(node);
    const onResize = () => appleRect.current?.();
    window.addEventListener("resize", onResize);
    // Anything that moves the viewer without resizing a box it sits in: a quiet second check.
    const timer = window.setInterval(onResize, 1000);
    return () => { observer?.disconnect(); window.removeEventListener("resize", onResize); window.clearInterval(timer); appleRect.current = undefined; void api.appleControl?.("visible", { visible: false }); };
  }, [appleOn]);
  // The hole in the page, only while the native picture shows. Same frame as the rect: both follow layout.
  useBeforePaint(() => {
    const el = appleRoot();
    if (!appleShowing || !el) return;
    const hole = createAppleHole(el);
    const follow = () => { hole.update(); appleRect.current?.(); };
    follow();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : null;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) observer?.observe(node);
    window.addEventListener("resize", follow);
    // A theme change repaints the page's colours: read them again.
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const recolour = () => { hole.refresh(); };
    scheme?.addEventListener?.("change", recolour);
    const themes = typeof MutationObserver === "function" ? new MutationObserver(recolour) : null;
    themes?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => { observer?.disconnect(); window.removeEventListener("resize", follow); scheme?.removeEventListener?.("change", recolour); themes?.disconnect(); hole.release(); };
  }, [appleShowing]);
  useBeforePaint(() => { appleRect.current?.(); }, [size.width, size.height]);
  // The viewer's mute button mutes the Apple player too.
  useEffect(() => { if (appleOn) void getApi().appleControl?.("muted", { muted }); }, [appleOn, muted]);
  function stopPreview() {
    auditionToken.current++; audition.current?.pause(); previewRef.current = false; setPreviewing(false);
  }
  // VO7-9: play, scrub and seek run to the end of the last voice piece, past the picture's end, over black.
  const extentNow = () => playbackExtent(timelineRef.current);
  const lastSeek = useRef(0);
  // VO7-11: the last time handed to onTime. The host paints its timeline from every report (no render of
  // its own per frame), so playback reports each drawn frame; a seek's report is not repeated by the draw after it.
  const reported = useRef(-1);
  function pause() {
    const wasPlaying = clock.current.playing;
    clock.current.time = Math.min(extentNow(), readClock()); clock.current.playing = false;
    if (wasPlaying) window.dispatchEvent(new CustomEvent("sidething:playing", { detail: false }));
    if (appleLiveRef.current) void getApi().appleControl?.("pause");
    sound.current?.pause(); mix.current?.pause(); layers.current.forEach(layer => layer.pause()); setPlaying(false); dirty.current = true;
    // The transport re-renders at most 30 times a second while playing: at rest it shows the clock exactly.
    if (wasPlaying) setTime(clock.current.time);
  }
  function seek(seconds: number) {
    stopPreview(); pause();
    clock.current.time = Math.max(0, Math.min(extentNow(), seconds));
    if (appleLiveRef.current) void getApi().appleControl?.("seek", { at: clock.current.time });
    if (sound.current && timeline.sound) sound.current.currentTime = clock.current.time;
    if (latest.current.active && !appleLiveRef.current) layers.current.forEach(layer => layer.updateAll(clock.current.time, false, true));
    // A scrub moves the timeline's playhead in this frame: the host paints it from onTime, without a render.
    const at = clock.current.time;
    lastSeek.current = performance.now(); reported.current = at;
    setTime(at); latest.current.onTime?.(at);
    dirty.current = true;
  }
  function play(rate = 1) {
    if (!latest.current.focused) return;
    stopPreview(); if (clock.current.time >= extentNow() - 1e-6) seek(0);
    if (appleLiveRef.current) {
      clock.current.time = readClock(); shuttleRate.current = rate;
      clock.current.anchor = performance.now(); clock.current.playing = true; setPlaying(true); setMessage(null);
      window.dispatchEvent(new CustomEvent("sidething:playing", { detail: true }));
      void getApi().appleControl?.("play", { at: clock.current.time, rate });
      return;
    }
    if (root && shoot?.root !== root || timelineRef.current.pieces.some(piece => clock.current.time >= piece.startS && clock.current.time < piece.endS && pending.current[piece.clipId] !== undefined)) {
      dirty.current = true; return;
    }
    clock.current.time = readClock(); shuttleRate.current = rate;
    mix.current?.stopReverse();
    if (sound.current) sound.current.playbackRate = rate;
    clock.current.anchor = performance.now(); clock.current.playing = true; setPlaying(true); setMessage(null);
    window.dispatchEvent(new CustomEvent("sidething:playing", { detail: true }));
    mix.current?.sync(clock.current.time, true, rate);
    if (!(timelineRef.current as LiveSoundTimeline).liveSound && timeline.sound && sound.current) void sound.current.play().catch(() => { pause(); setMessage("Couldn't play the sound. Try play again.", true); });
  }
  useImperativeHandle(ref, () => ({
    seek, stopPreview, play, pause,
    // VO7-14: the sound under the playhead while scrubbing, frame stepping and playing backwards, cut from the live
    // mix (same plan, levels, mutes and buses as playback). None of these moves the clock; the caller seeks.
    scrubAudio(seconds) { if (latest.current.active && !clock.current.playing) mix.current?.scrub(seconds === null ? null : Math.max(0, Math.min(extentNow(), seconds)), liveSoundPreviews.get(sourceTimelineRef.current)); },
    blip(seconds, length) { if (latest.current.active) mix.current?.blip(Math.max(0, Math.min(extentNow(), seconds)), length, liveSoundPreviews.get(sourceTimelineRef.current)); },
    reverseAudio(seconds, rate) { if (latest.current.active) mix.current?.reverse(Math.max(0, Math.min(extentNow(), seconds)), rate, liveSoundPreviews.get(sourceTimelineRef.current)); },
    stopReverseAudio() { mix.current?.stopReverse(); },
    // A caption style change draws at once, before React carries the same track here: the captions around the
    // playhead first, so the next frame shows them; the full track follows through liveTitles.
    previewTitles(track) {
      void titleInit.current(track, 3);
      // If no render carries a track here (the change was a no-op), restore the whole current track.
      const generation = titleGeneration.current;
      window.setTimeout(() => { if (titleGeneration.current === generation) void titleInit.current(shownTitles.current); }, 400);
    },
    trimPreview(plan, seconds) {
      appleTrimPreview(!!plan);
      const next = plan ? {...plan,pieces:plan.pieces.map(piece=>{
        const shown=timeline.pieces.find(p=>p.clipId===piece.clipId && p.piece===piece.piece && p.layer===piece.layer && p.proxy.split('?')[0]===piece.proxy.split('?')[0])
          ?? timeline.pieces.find(p=>p.clipId===piece.clipId && p.piece===piece.piece && p.layer===piece.layer);
        return {...piece,rotationFrame:shown?.rotationFrame,proxy:shown?.proxy ?? piece.proxy};
      })} : timeline;
      trimming.current = plan ? next : null;
      timelineRef.current = next;
      layers.current.forEach((layer, index) => layer.replace(next.pieces.filter(piece => piece.layer === index)));
      if (seconds !== undefined) clock.current.time = Math.max(0, Math.min(playbackExtent(next), seconds));
      dirty.current = true;
    },
    togglePlayback: () => clock.current.playing ? pause() : play(),
    preview(src, start, end) {
      if (!latest.current.focused || !audition.current) return;
      pause(); stopPreview(); const token = ++auditionToken.current, element = audition.current;
      auditionEnd.current = end; previewRef.current = true; setPreviewing(true);
      element.onloadedmetadata = () => { if (token === auditionToken.current) { element.currentTime = start; void element.play().catch(() => { if (token === auditionToken.current) { stopPreview(); setMessage("Couldn't play that take.", true); } }); } };
      element.src = src; element.load();
    },
  }));
  useEffect(() => {
    layers.current.forEach((layer, index) => { layer.replace(timeline.pieces.filter(piece => piece.layer === index).sort((a,b) => a.startS - b.startS)); if(latest.current.active)layer.updateAll(readClock(),clock.current.playing,false,shuttleRate.current); });
    dirty.current = true;
    const adjustment = basicPreviews.get(sourceTimeline) ?? {target:normalizeBasic(),baseline:normalizeBasic()};
    adjustment.saved = savedGrade ? {balances:(timeline as UniformTimeline).uniformBalances,correctionKey:(timeline as UniformTimeline).correctionKey,grade:savedGrade,pieceLooks:(timeline as UniformTimeline).uniformPieceLooks} : undefined;
    basicPreviews.set(sourceTimeline,adjustment); adjustment.changed = () => { dirty.current = true; sendAppleLookRef.current(); };
    const plan = (timeline as LiveSoundTimeline).liveSound;
    if (plan) { mix.current ??= new LiveMix(setMessage); mix.current.update(plan); mix.current.updateVoice(voicePlayback(timeline, root)); }
  }, [timeline, savedGrade]);
  useEffect(() => { mix.current?.setMuted(muted, !!visibility?.music, !!visibility?.voice); }, [muted, visibility?.voice, visibility?.music]);
  useEffect(() => listenLiveSound(sourceTimeline, () => {
    if (latest.current.active) mix.current?.sync(readClock(), clock.current.playing && !previewRef.current, shuttleRate.current, liveSoundPreviews.get(sourceTimeline));
    dirty.current = true;
  }), [sourceTimeline]);
  useEffect(() => {
    const fail = () => { if (!Object.keys(pending.current).length) setMessage("Couldn't decode this clip's preview. Try making its preview again."); };
    let drawFrame = () => {}, schedulePicture = () => {};
    let drawing = false;
    // Native frame delivery publishes paused pictures immediately. During play
    // RAF and picture deadlines share the GPU with continuous layout animation.
    const redraw = () => {
      // Decoder notifications arm their deadline. Painting the unchanged Look
      // here as well as on RAF and the deadline starves those very deadlines.
      if (clock.current.playing && !previewRef.current) {
        if (latest.current.active && !drawing) schedulePicture();
        return;
      }
      dirty.current = true; if (latest.current.active && !drawing) drawFrame();
    };
    const adjustment = basicPreviews.get(sourceTimeline) ?? { target: normalizeBasic(), baseline: normalizeBasic() };
    basicPreviews.set(sourceTimeline, adjustment); adjustment.changed = () => { dirty.current = true; sendAppleLookRef.current(); };
    layers.current = Array.from({length:layerCount},(_,n)=>n).map(layer => new LiveLayer(timeline.pieces.filter(piece => piece.layer === layer).sort((a,b) => a.startS - b.startS), videos.current.slice(layer * 2, layer * 2 + 2) as HTMLVideoElement[], redraw, fail,
      piece => pending.current[piece.clipId] !== undefined, () => !fallbackRef.current));
    const useFallback = () => { painter.current?.dispose(); painter.current = null; fallbackRef.current = true; setFallback(true); setMessage(PLAIN_VIDEO); };
    fallbackRef.current = false; setFallback(false); setMessage(null);
    try { painter.current = new LiveCanvas(canvas.current!, redraw, () => setMessage("Couldn't load the live colour. Check the connection and reopen this cut.")); }
    catch { useFallback(); }
    const element = canvas.current!;
    const viewer = element.closest?.('[data-cut-player]');
    viewer?.addEventListener('precut:viewer-zoom', redraw);
    viewer?.addEventListener('precut:layout-preview',redraw);
    const lost = (event: Event) => {
      event.preventDefault(); painter.current?.suspend();
      fallbackRef.current = true; setFallback(true); setMessage(PLAIN_VIDEO); redraw();
    };
    const restored = () => {
      try {
        if (painter.current) painter.current.restore();
        else painter.current = new LiveCanvas(element, redraw, fail);
        fallbackRef.current = false; setFallback(false);
        videos.current.forEach(video => { if (video) video.style.visibility = "hidden"; });
        redraw();
      } catch { useFallback(); }
    };
    element.addEventListener("webglcontextlost", lost);
    element.addEventListener("webglcontextrestored", restored);
    onAspect(timeline.width / timeline.height);
    let currentFrame: (DecodedPicture & { time: number }) | null = null;
    const capture = () => currentFrame && !currentFrame.video.seeking && currentFrame.video.readyState >= 2
      ? copyLookFrame(currentFrame.frame ?? currentFrame.video, currentFrame.piece, currentFrame.time) : null;
    liveFrames.set(sourceTimeline, capture);
    const stopStandIns = standIns.subscribe(redraw);
    const stopRotation = subscribeRotation(redraw);
    let raf = 0, lastUpdate = -1, pictureTimer: number | undefined, pictureDeadline = Infinity, pictureRate = 1;
    const clearPictureTimer = () => { if (pictureTimer !== undefined) window.clearTimeout(pictureTimer); pictureTimer = undefined; pictureDeadline = Infinity; };
    schedulePicture = () => {
      if (!latest.current.active || !clock.current.playing || previewRef.current) { clearPictureTimer(); return; }
      const now = readClock(), at = Math.min(...layers.current.map(layer => layer.nextPictureTime(now)));
      // Readiness/RAF must not postpone the same already-armed deadline. Keep an
      // overdue timer queued too, rather than replacing it with another delay.
      if (pictureTimer !== undefined && pictureRate === shuttleRate.current && (Math.abs(at-pictureDeadline) < .000001 || at <= now && pictureDeadline <= now)) return;
      clearPictureTimer();
      if (Number.isFinite(at)) {
        pictureDeadline = at; pictureRate = shuttleRate.current;
        pictureTimer = window.setTimeout(() => {
          pictureTimer = undefined; pictureDeadline = Infinity;
          if (latest.current.active && clock.current.playing) drawFrame();
        }, Math.max(1, Math.ceil((at-now)*1000/shuttleRate.current)));
      }
    };
    drawFrame = () => {
      if (!latest.current.active) return;
      if (appleLiveRef.current) {
        // The native clock reports through onAppleEvent. Titles still follow it here.
        const now = Math.min(playbackExtent(timelineRef.current), readClock());
        if (titleReady.current && lastTitleTime.current !== now) {
          lastTitleTime.current = now;
          void (titles.current?.contentWindow as TitleWindow | null)?.titleRenderer?.seek(now);
        }
        return;
      }
      drawing = true;
      const timeline = timelineRef.current;
      const adjustment = basicPreviews.get(sourceTimelineRef.current) ?? { target: normalizeBasic(), baseline: normalizeBasic() };
      const extent = playbackExtent(timeline);
      let now = Math.min(extent, readClock());
      if (now >= extent && extent > 0) {
        if (clock.current.playing) pause();
        // The transport can reach the end while the visible picture retains
        // the final source frame. No piece owns the exact end timestamp.
        // Past the picture's end (voice runs on) no piece is under the clock: the stage is black.
        now = Math.max(0, extent - .000001);
      }
      const preparing = timeline.pieces.find(piece => now >= piece.startS && now < piece.endS && pending.current[piece.clipId] !== undefined);
      if (clock.current.playing && preparing) {
        // Stop at the exact boundary, with sound held too. Otherwise each play
        // attempt can skip another fraction of a shot while it is preparing.
        pause(); clock.current.time = now = preparing.startS;
        setTime(now); reported.current = now; latest.current.onTime?.(now); lastUpdate = now;
        if (sound.current && timeline.sound) sound.current.currentTime = preparing.startS;
        mix.current?.sync(preparing.startS, false, shuttleRate.current);
      }
      mix.current?.sync(now, clock.current.playing && !previewRef.current, shuttleRate.current, liveSoundPreviews.get(sourceTimelineRef.current));
      if (clock.current.playing && now >= extent) pause();
      const decoded = layers.current.map(layer => layer.updateAll(now, clock.current.playing && !previewRef.current, false, shuttleRate.current));
      const pictures = decoded.flat();
      // PS1: a piece whose decoder isn't ready shows its stand-in still (the strip frame nearest its source time), or
      // with no strip yet the frame its layer last showed. Looks, crop and overlays go on top as usual.
      const stage: StageLayer[] = decoded.flatMap((ready, index) => {
        const waiting = layers.current[index].waiting;
        const shown = ready.map(({video, piece, frame}) => ({video:frame ?? video, piece, key:video}));
        if (!waiting.length) return shown;
        const standIn = waiting.map((piece, k): StageLayer => {
          const url = standInFor(piece, sourceTime(piece, now));
          const image = url ? standIns.get(url) : undefined;
          if (url && !image) standIns.want(url);
          const clip = root ? rotationClip(root, piece.clipId) : undefined;
          const stripPiece = clip?.pictureStrip ? { ...piece, proxy: piece.proxy.replace(/[^/]+(?=\?|$)/, `${encodeURIComponent(piece.clipId)}.r${clip.pictureStrip.rotation}-00.mp4`) } : piece;
          return { video: image ?? null, piece: stripPiece, key: `stand-in:${index}:${k}` };
        });
        return [...shown, ...standIn].sort((a, b) => a.piece.startS - b.piece.startS);
      });
      const visible = pictures[pictures.length - 1];
      currentFrame = visible ? { ...visible, time: now } : null;
      if (fallbackRef.current) videos.current.forEach(video => {
        if (!video) return;
        video.style.visibility = pictures.some(picture => picture?.video === video) ? "visible" : "hidden";
        video.style.objectFit = "contain";
        const picture = pictures.find(picture => picture.video === video);
        video.style.opacity = String(picture ? opacityAt(picture.piece, now) : 1);
        video.style.zIndex = String(picture ? pictures.indexOf(picture) : 0);
      });
      else try {
        const viewScale = Number((viewer as HTMLElement | null)?.dataset.viewScale) || 1;
        const scale = Math.min(1, Math.min(latest.current.size.width / timeline.width, latest.current.size.height / timeline.height) * (window.devicePixelRatio || 1) * viewScale);
        if (painter.current) painter.current.clipping = clippingPreview.current;
        painter.current?.draw(stage, now, timeline.pieces, latest.current.look, Math.max(1, Math.round(timeline.width * scale)), Math.max(1, Math.round(timeline.height * scale)), adjustment, latest.current.previewPiece, latest.current.texture, latest.current.bypassLook);
        if (adjustment.inputAt !== undefined && painter.current?.pictureWasDrawn()) {
          const inputAt = adjustment.inputAt; adjustment.inputAt = undefined;
          window.dispatchEvent(new CustomEvent("sidething:basic-drawn", { detail: { inputAt, drawAt: performance.now(), latencyMs: performance.now() - inputAt } }));
        }
        const inputAt = latest.current.look ? lookInputTimes.get(latest.current.look) : undefined;
        if (inputAt !== undefined && latest.current.look && painter.current?.hasDrawn(latest.current.look)) {
          lookInputTimes.delete(latest.current.look!);
          window.dispatchEvent(new CustomEvent("sidething:look-drawn", { detail: { inputAt, drawAt: performance.now(), latencyMs: performance.now() - inputAt } }));
        }
        if (histogramActive.current && painter.current?.pictureWasDrawn() && !painter.current.histogramPending && performance.now() - lastHistogram.current > 125 && canvas.current) {
          lastHistogram.current = performance.now(); histogramPending.current = false;
          try {
            // Sample the unmarked preview, then restore clipping on the stage.
            if (clippingPreview.current) { painter.current.clipping = false; painter.current.draw(stage, now, timeline.pieces, latest.current.look, canvas.current.width, canvas.current.height, adjustment, latest.current.previewPiece, latest.current.texture, latest.current.bypassLook); }
            try { painter.current.requestHistogram(); }
            finally { if (clippingPreview.current) { painter.current.clipping = true; painter.current.draw(stage, now, timeline.pieces, latest.current.look, canvas.current.width, canvas.current.height, adjustment, latest.current.previewPiece, latest.current.texture, latest.current.bypassLook); } }
          } catch { /* Cross-origin media cannot be measured; retain no fabricated bins. */ }
        }
      }
      catch { useFallback(); }
      if (coveredRef.current && (fallbackRef.current ? pictures.length > 0 : painter.current?.pictureWasDrawn())) { coveredRef.current = false; setCovered(false); }
      if (titleReady.current && lastTitleTime.current !== now) {
        lastTitleTime.current = now;
        void (titles.current?.contentWindow as TitleWindow | null)?.titleRenderer?.seek(now);
      }
      if (!trimming.current && now !== reported.current) {
        reported.current = now; latest.current.onTime?.(now);
        // This player's own transport (time, seek bar, stage handles) re-renders at most 30 times a second.
        if (Math.abs(now - lastUpdate) > 1 / 30) { setTime(now); lastUpdate = now; }
      }
      if (!previewRef.current) layers.current.forEach(layer => layer.prime(now, clock.current.playing));
      if (previewRef.current && audition.current && audition.current.currentTime >= auditionEnd.current) audition.current.pause();
      drawing = false;
      schedulePicture();
    };
    const tick = () => {
      raf = 0;
      if (!latest.current.active) return;
      if (histogramActive.current) try {
        const pixels = painter.current?.readHistogram();
        if (pixels) window.dispatchEvent(new CustomEvent("sidething:histogram", { detail: histogram(pixels) }));
      } catch { /* Keep the last measured bins if a GPU sample is unavailable. */ }
      if (clock.current.playing || previewRef.current || dirty.current || histogramActive.current && histogramPending.current && performance.now() - lastHistogram.current > 125) { if (dirty.current || clock.current.playing) histogramPending.current = true; dirty.current = false; drawFrame(); }
      raf = requestAnimationFrame(tick);
    };
    let released = false;
    lifecycle.current = {
      stop() { cancelAnimationFrame(raf); clearPictureTimer(); raf = 0; currentFrame = null; painter.current?.cancelHistogram(); layers.current.forEach(layer => layer.suspend()); },
      release() {
        released = true; clearPictureTimer(); currentFrame = null; mix.current?.dispose();
        layers.current.forEach(layer => layer.dispose());
        [sound.current, audition.current].forEach(media => { if (media) { media.pause(); media.removeAttribute("src"); media.load(); } });
      },
      start() {
        if (released && sound.current && timeline.sound) {
          sound.current.onloadedmetadata = () => { if (sound.current) sound.current.currentTime = clock.current.time; };
          sound.current.src = timeline.sound; sound.current.load();
        }
        released = false; dirty.current = true;
        if (!raf) tick();
      },
    };
    if (resumePreparedTimeline.current) { resumePreparedTimeline.current = false; if (latest.current.active) play(shuttleRate.current); }
    if (latest.current.active) lifecycle.current.start();
    return () => { resumePreparedTimeline.current = clock.current.playing; lifecycle.current = undefined; adjustment.changed = undefined; liveFrames.delete(sourceTimeline); stopStandIns(); stopRotation(); drawFrame = () => {}; cancelAnimationFrame(raf); clearPictureTimer(); pause(); stopPreview(); layers.current.forEach(layer => layer.dispose()); painter.current?.dispose(); painter.current = null; element.removeEventListener("webglcontextlost", lost); element.removeEventListener("webglcontextrestored", restored); viewer?.removeEventListener("precut:viewer-zoom", redraw); viewer?.removeEventListener("precut:layout-preview",redraw); };
  }, [layerCount]);
  useEffect(() => () => { mix.current?.dispose(); mix.current = null; }, []);
  useEffect(() => {
    if (active) { hiddenSince.current = null; lifecycle.current?.start(); return; }
    hiddenSince.current ??= Date.now();
    pause(); stopPreview(); lifecycle.current?.stop();
    const timer = window.setTimeout(() => lifecycle.current?.release(), Math.max(0, 5 * 60 * 1000 - (Date.now() - hiddenSince.current)));
    return () => window.clearTimeout(timer);
  }, [active, timeline]);
  useEffect(() => { if (!focused) { pause(); stopPreview(); } }, [focused]);
  // One preparation for the effect below and for previewTitles, so an optimistic preview draws exactly what follows it.
  const titleInit = useRef<(source: TitleTrack | null | undefined, window?: number) => Promise<void> | undefined>(() => undefined);
  titleInit.current = (source, window) => {
    const generation = ++titleGeneration.current;
    titleReady.current = false; lastTitleTime.current = -1;
    const renderer = (titles.current?.contentWindow as TitleWindow | null)?.titleRenderer;
    if (!renderer) return undefined;
    // VO7-9: words heard past the picture's end caption the black too, the way Extend will make them.
    let track = withBeyondCaptions(source ?? { font: "Outfit", cues: [], prompt: null, skillIds: [] }, timeline.durationS);
    track = visibility?.captions ? { ...track, cues: track.cues.filter(cue => cue.role !== "subtitle" && !cue.id.startsWith("kinetic-")) } : visibility?.overlays ? { ...track, cues: track.cues.filter(cue => !cue.id.startsWith("lower-third:")) } : track;
    const at = clock.current.time;
    if (window !== undefined) {
      // Only the captions around the playhead, with every cue they share screen time with (placement depends on them).
      let start = at - 1, end = at + window, near = track.cues.filter(c => c.s < end && c.e > start);
      for (let size = -1; size !== near.length;) { size = near.length; start = Math.min(start, ...near.map(c => c.s)); end = Math.max(end, ...near.map(c => c.e)); near = track.cues.filter(c => c.s < end && c.e > start); }
      track = { ...track, cues: near };
    }
    return renderer.init(track, { width: timeline.width, height: timeline.height, layer: "all", live: true, at, overlays: (visibility?.overlays ? [] : timeline.overlays ?? []).map(item => overlayPreview?.id === item.id ? { ...item, ...overlayPreview } : item) }).then(() => {
      if (generation === titleGeneration.current) { titleReady.current = true; dirty.current = true; }
    }).catch(() => { if (generation === titleGeneration.current) setMessage("Couldn't load the titles on this draft."); });
  };
  const shownTitles = useRef<TitleTrack | null | undefined>(null);
  shownTitles.current = liveTitles === undefined ? timeline.titles : liveTitles;
  // Saved snapshots copy these objects. Equal captions must keep their prepared
  // layout while a voice split, delete or undo changes only the sound lane.
  const titleSignature = useMemo(() => JSON.stringify([liveTitles === undefined ? timeline.titles : liveTitles,
    timeline.durationS, timeline.overlays, timeline.width, timeline.height, overlayPreview, visibility?.captions, visibility?.overlays]),
  [timeline.titles, liveTitles, timeline.durationS, timeline.overlays, timeline.width, timeline.height, overlayPreview, visibility?.captions, visibility?.overlays]);
  useEffect(() => {
    void titleInit.current(liveTitles === undefined ? timeline.titles : liveTitles);
    return () => { titleGeneration.current++; titleReady.current = false; };
  }, [titleSignature, titleLoaded]);
  useEffect(() => {
    if (!focused || recording) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTextField(event.target) || document.querySelector('[role="dialog"]:not([inert] *, [hidden] *), [role="menu"]:not([inert] *, [hidden] *)')) return;
      if (event.code === "Space") { event.preventDefault(); if (clock.current.playing) pause(); else play(); }
      else if (["j", "k", "l"].includes(event.key.toLowerCase())) { event.preventDefault(); if (event.key.toLowerCase() === "k") pause(); else { const resume = clock.current.playing; seek(readClock() + (event.key.toLowerCase() === "j" ? -5 : 5)); if (resume) play(); } }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [focused, timeline, recording]);
  const width = Math.min(size.width, size.height * timeline.width / timeline.height);
  const extent = playbackExtent(timeline);
  const currentPiece = pictureAt(time);
  const missingPreviewIds = [...new Set(timeline.pieces.map(p => p.clipId).filter(id => id && shoot?.clips.some(c => c.id === id && !c.proxy)))];
  const preparingPiece = timeline.pieces.find(piece => time >= piece.startS && time < piece.endS && pending.current[piece.clipId] !== undefined);
  const previewPct = preparingPiece ? pending.current[preparingPiece.clipId] : currentPiece && missingPreviewIds.includes(currentPiece.clipId) ? 0 : undefined;
  for (const id of missingPreviewIds) pending.current[id] ??= 0;
  const gettingReady = `Getting ${missingPreviewIds.length} ${missingPreviewIds.length === 1 ? "shot" : "shots"} ready`;
  const still = shoot?.root === root && currentPiece ? frameAt(shoot, currentPiece.clipId, sourceTime(currentPiece, time)) : null;
  const control = `flex size-8 shrink-0 items-center justify-center rounded-full st-player-control ${FOCUS}`;
  return <div data-cut-player data-live-player data-apple-player={appleShowing ? "apple" : "chrome"} data-drawn={covered && !appleShowing ? undefined : ""} className="relative overflow-hidden rounded-xl bg-[var(--primary-ink)]" style={{ width, height: width * timeline.height / timeline.width, "--player-gutter": `${(size.width - width) / 2}px`, "--player-bottom": `${(size.height - width * timeline.height / timeline.width) / 2}px` } as React.CSSProperties}>
    <div data-view-picture className="absolute inset-0">
    {Array.from({length:layerCount*2},(_,n)=>n).map(index => <video key={index} ref={element => { videos.current[index] = element; }} playsInline muted crossOrigin="anonymous" preload="auto" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" style={{ visibility: "hidden", zIndex: Math.floor(index / 2) }} />)}
    <canvas ref={canvas} aria-label={label} className={`absolute inset-0 z-[2] h-full w-full ${fallback || appleShowing ? "hidden" : ""}`} />
    {covered && cover && !appleShowing ? <img data-open-cover src={cover} alt="" draggable={false} className="pointer-events-none absolute inset-0 z-[2] h-full w-full object-cover" /> : null}
    {/* The title page has no color-scheme; a dark-scheme iframe element around it makes Chromium paint an opaque white backdrop. */}
    <iframe ref={titles} title="Draft titles" srcDoc={titleDocument} onLoad={() => setTitleLoaded(n => n + 1)} tabIndex={-1} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-[3] origin-top-left border-0" style={{ width: timeline.width, height: timeline.height, transform: `scale(${width / timeline.width})`, colorScheme: "normal", background: "transparent" }} />
    {visibility?.video && <div data-hidden-video-preview className="pointer-events-none absolute inset-0 z-[2] bg-[var(--primary-ink)]" />}
    {!visibility?.overlays && <OverlayHandles timeline={sourceTimeline} time={time} pause={pause} />}
    <LayoutHandles timeline={sourceTimeline} time={time} pause={pause}/>
    <audio ref={sound} src={(timeline as LiveSoundTimeline).liveSound ? undefined : timeline.sound ?? undefined} muted={muted || !!visibility?.voice} preload="auto" onEnded={pause} onError={() => { if (timeline.sound) { pause(); setMessage("Couldn't load this draft's sound. Check the drive is connected."); } }} />
    <video ref={audition} playsInline muted aria-label="Take preview" onError={() => { stopPreview(); setMessage("Couldn't play that take.", true); }} className={`absolute inset-0 z-[4] h-full w-full object-contain ${previewing ? "" : "hidden"}`} />
    </div>
    {/* R8b: notes sit just above the transport, clear of the format, Crop and full screen controls over the picture's top edge. */}
    {previewing || message || appleNote ? <div data-stage-messages className="pointer-events-none absolute inset-x-2 bottom-14 z-10 flex flex-col items-center gap-1">
      {previewing ? <span className="st-pop rounded-full px-3 py-1 text-micro text-ink">Take preview · muted</span> : null}
      {message ? <p role="status" className="rounded-lg bg-[var(--scrim)] px-2 py-1 text-center text-micro text-[var(--media-ink)]">{message}</p> : null}
      {appleNote ? <p className="rounded-lg bg-[var(--scrim)] px-2 py-1 text-center text-micro text-[var(--media-ink)]">{appleNote}</p> : null}
    </div> : null}
    {/* The plain on and off lines stay out of the picture; only a reason the Apple player could not play shows. */}
    {/* REL2: the Apple player is off by default, so its off line is not announced or shown on the stage; the reason stays in data-apple-reason for QA. */}
    <p data-apple-status data-apple-reason={appleLine} className="sr-only">{appleLine === APPLE_OFF_REASON ? "" : appleLine}</p>
    {missingPreviewIds.length > 0 && previewPct === undefined ? <p role="status" className="pointer-events-none absolute inset-x-2 bottom-14 z-10 text-center text-micro text-[var(--media-ink)]">{gettingReady}</p> : null}
    {previewPct !== undefined || root && shoot?.root !== root ? <PreviewPlaceholder pct={previewPct ?? 0} src={still ?? undefined} message="Preparing smooth preview" /> : null}
    <div className="st-player-transport absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 rounded-xl px-3 py-2" aria-label="Player controls">

        <button type="button" aria-label={`${playing ? "Pause" : "Play"} ${label}`} onClick={() => playing ? pause() : play()} className={control}>{playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}</button>
        <span className="tnum whitespace-nowrap text-micro text-[var(--media-ink)]">{formatDuration(time)} / {formatDuration(extent)}</span>
      <Slider compact label={`Seek ${label}`} min={0} max={extent || 1} step={.01} value={Math.min(time, extent)} aria-valuetext={`${formatDuration(time)} of ${formatDuration(extent)}`} onChange={value => { const resume = clock.current.playing; seek(value); if (resume) play(); }} />
        <Tile type="button" aria-label={muted ? "Unmute preview" : "Mute preview"} aria-pressed={muted} onClick={() => setMuted(value => !value)} className={control}>{muted ? <SpeakerSlash size={18} /> : <SpeakerHigh size={18} />}</Tile>
        <button type="button" aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={onFullscreen} className={control}>{fullscreen ? <ArrowsIn size={18} /> : <ArrowsOut size={18} />}</button>
    </div>
  </div>;
});
import { refreshShootWhenQuiet } from "../hooks/quietShoot";
