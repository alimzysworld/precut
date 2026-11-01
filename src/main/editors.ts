import { clipName } from "../shared/clip-name";
import { pieceSoundSettings } from './stem-mix';
import { clipDuckDb } from './music-duck';
import { SOUND_LANES, laneDb, laneMuted } from '../shared/lane-levels';
import type { SoundLane } from '../shared/schema';
import { attachedClipSounds } from './clip-sound';
import { sourceAudioChannels, mapSourceAudioGraph } from './source-audio';
import { clipTransformXml, displayedClip, clipFileDimensions } from "../shared/media";
import { editorTitleTrack } from "./titles/captions";
import { tool } from "./tools";
// Editor interchange is a mechanical projection of an already judged cut.
// This module deliberately does not rank takes or make editorial decisions.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";
import { runActivity, currentActivity, type ActivityHandle, threads } from "./activity";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkoutFile } from "./bundle-paths";
import { pathToFileURL } from "node:url";
import type { CutItem, ExportFinishing, exportCutList } from "./export";
import type { SelectsPlan } from "./selects";
import type { Clip, PrecutResult } from "../shared/schema";
import { editorChannelSources, measureSourceAudio } from "./voice-isolation";
import { mapTime, mapSource, fxSetpts, fxAudioSegments, type FxItem } from './edits-fx';
import { editorPlan, editorTimeKeys, premiereTimeMap, retimed } from './editor-timeline';
import { editorPictures, flattenedLayouts, fcpxPictureTransform, premierePictureTransform, pictureTiming, flattenedTransforms, premierePictureTimeMap, premierePictureLanes, preparePictureAssets, type PictureClip } from './editor-picture';
import { presentTitles } from './titles/ul1';
import { audioSpan } from './audio';
import { prepareEditorAudio, gainAt, type EditorAudioClip } from './editor-audio';

export type Editor = "resolve" | "premiere" | "finalcut" | "capcut";
type ExportArgs = Parameters<typeof exportCutList>;
/** The existing exportCutList arguments, named, plus its completed preview.
 * Pass selects when the caller has already planned them, avoiding another call.
 * previewPath is an absolute path (or a path relative to root/.sidething/precuts).
 * XML writers return text; writeCapCutPack writes into the supplied folder.
 */
export interface EditorInput {
  root: ExportArgs[0]; shoot: ExportArgs[1]; kind: ExportArgs[2];
  template: ExportArgs[3]; cutList: ExportArgs[4]; opts?: ExportArgs[5];
  previewPath: string | null;
  activityTarget?: { cutId: string; version: number };
  selects?: SelectsPlan;
  /** The already judged version. This export path never designs titles or looks. */
  finishing?: ExportFinishing;
  /** Prepared local assets, shared by the two interchange writers. */
  layers?: ExportLayers;
  pictures?: PictureClip[];
}
const exportContext = new AsyncLocalStorage<EditorInput>();
interface LayerClip { file: string; name: string; s: number; d: number; track: number; kind: "front" | "behind" | "person" | "voice" | "transition" }
interface ExportLayers { video: LayerClip[]; voice: EditorAudioClip[]; audio?: EditorAudioClip[]; readme: string[] }
const finishingOf = (i: EditorInput) => {
  const version = i.finishing ?? i.opts?.finishing;
  return version && (version.lowerThirds?.length || version.layouts?.some(l => l?.kind === 'title'))
    ? { ...version, titles: presentTitles(version, i.selects?.cuts ?? i.cutList, i.template.fps) } : version;
};
const attachedSoundOf = (i:EditorInput, plan=audioPlan(i)) => attachedClipSounds(i.opts?.reel?.broll ?? [],plan,finishingOf(i) ?? {},i.template.fps);
const audioPlan = (i: EditorInput) => editorPlan(i.selects?.cuts ?? i.cutList, i.template.fps, finishingOf(i));
const hasJoinAudio = (i: EditorInput) => audioPlan(i).items.some(p => p.audio && (p.audio.leadS > 0 || p.audio.trailS > 0));

/** Separate original audio edits, with source handles and unchanged word sync.
 * Connected lanes alternate so overlapping handles never replace each other. */
export async function joinAudioXml(i: EditorInput): Promise<{ resources: string[]; clips: string[] }> {
  const resources: string[] = [], clips: string[] = [], plan = audioPlan(i);
  if (!hasJoinAudio(i)) return { resources, clips };
  for (const [n, c] of (i.selects?.cuts ?? i.cutList).entries()) {
    if (!c.seg || !plan.items[n].soundEnabled || plan.items[n].muted || plan.items[n].reverse) continue;
    const clip = c.seg.clip, span = audioSpan(plan.items[n]), mic = micFor(i, clip);
    const file = mic?.file ?? clip.file, inventory = await sourceAudioChannels(await mediaPath(i, file)), channels = inventory.stream ? inventory.channels : 0;
    if (!channels) continue;
    const sourceOffset = mic?.offsetS ?? 0;
    const source = Math.max(0, span.timeMap[0].s + sourceOffset);
    const startAt = mapTime(span.timeMap, source - sourceOffset);
    const endAt = mapTime(span.timeMap, Math.min(span.timeMap.at(-1)!.s, (mic?.durationS ?? clip.meta!.durationS) - sourceOffset));
    const tc = (clip.meta!.startTimecode ?? "00:00:00:00").split(/[:;]/).map(Number);
    const origin = mic ? 0 : tc[0] * 3600 + tc[1] * 60 + tc[2] + tc[3] / clip.meta!.fps;
    const d = endAt - startAt;
    if (d <= 0) continue;
    const id = `jl-audio-${n}`, fade = plan.items[n].audio;
    resources.push(`<asset id="${id}" name="${esc(path.basename(file))}" start="${time(origin)}" duration="${time(mic?.durationS ?? clip.meta!.durationS)}" hasVideo="0" hasAudio="1" audioSources="${inventory.sources}" audioChannels="${channels}" audioRate="48000"><media-rep kind="original-media" src="${await url(i, file)}"/></asset>`);
    const retime = span.timeMap.length > 2 || Math.abs((span.timeMap.at(-1)!.s - span.timeMap[0].s) - (span.endS - span.startS)) > 1e-7
      ? `<timeMap frameSampling="floor">${span.timeMap.map(k => `<timept time="${time(k.t - startAt)}" value="${time(origin + k.s + (mic?.offsetS ?? 0))}" interp="linear"/>`).join('')}</timeMap>` : '';
    clips.push(`<asset-clip ref="${id}" name="${esc(`J/L voice: ${c.seg.marker}`)}" lane="${-5 - n % 2}" offset="${time(startAt)}" start="${time(origin + Math.max(0, source))}" duration="${time(d)}" srcEnable="audio" audioRole="dialogue.jl">${retime}<adjust-volume amount="${plan.items[n].gainDb}dB"><param name="amount">${fade?.fadeInS ? `<fadeIn type="linear" duration="${time(fade.fadeInS)}"/>` : ''}${fade?.fadeOutS ? `<fadeOut type="linear" duration="${time(fade.fadeOutS)}"/>` : ''}</param></adjust-volume>${await editorChannelSources(i.root, await mediaPath(i, file), mic ? 'mic' : 'cam')}</asset-clip>`);
  }
  return { resources, clips };
}
type Rate = { num: number; den: number };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
function rate(fps: number): Rate {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Invalid frame rate: ${fps}`);
  for (const num of [24000, 30000, 60000]) if (Math.abs(fps - num / 1001) < .002) return { num, den: 1001 };
  return { num: Math.round(fps * 1000), den: 1000 };
}
const hz = (r: Rate) => r.num / r.den;
function gcd(a: number, b: number): number { while (b) [a, b] = [b, a % b]; return Math.abs(a) || 1; }
function time(s: number): string {
  const n = Math.round(s * 1e9), d = gcd(n, 1000000000);
  return n === 0 ? "0s" : `${n / d}/${1000000000 / d}s`;
}
function frameTime(frames: number, r: Rate): string {
  if (Math.abs(frames - Math.round(frames)) > 1e-6) return time(frames / hz(r));
  const n = Math.round(frames) * r.den, d = gcd(n, r.num);
  return n === 0 ? "0s" : `${n / d}/${r.num / d}s`;
}
const soundLaneName = (lane:SoundLane) => ({'clip-sound':'Clip sound',voice:'Voice',music:'Music',effects:'Effects'})[lane];
function fcpxVolume(layer: EditorAudioClip, sourceStart = 0): string {
  const db = (gain: number) => gain <= 0 ? '-96dB' : `${20 * Math.log10(gain)}dB`;
  return `<adjust-volume amount="${layer.muted ? -96 : layer.gainDb ?? 0}dB"><param name="amount">${layer.fadeInS ? `<fadeIn type="linear" duration="${time(layer.fadeInS)}"/>` : ''}${layer.fadeOutS ? `<fadeOut type="linear" duration="${time(layer.fadeOutS)}"/>` : ''}${layer.keys?.length ? `<keyframeAnimation>${layer.keys.map(k => `<keyframe time="${time(sourceStart + k.t)}" value="${db(layer.muted ? 0 : k.gain * 10 ** ((layer.gainDb ?? 0) / 20))}" interp="linear" curve="linear"/>`).join('')}</keyframeAnimation>` : ''}</param></adjust-volume>`;
}
function premiereVolume(layer: EditorAudioClip, fps: number): string {
  const times = new Set([0, layer.d, ...(layer.keys ?? []).map(k => k.t)]);
  if (layer.fadeInS) times.add(layer.fadeInS);
  if (layer.fadeOutS) times.add(layer.d - layer.fadeOutS);
  // Ducking and native fades share xmeml's level envelope. Evaluate the product
  // at every sequence frame so fading ducked music retains its shape.
  if (layer.keys?.length && (layer.fadeInS || layer.fadeOutS)) for (let n = 0; n < layer.d * fps; n++) times.add(n / fps);
  const keys = new Map<number, number>();
  const indices = new Map(layer.keys?.map((k, n) => [k.t, n]));
  for (const t of [...times].sort((a, b) => a - b)) {
    const edge = indices.get(t) ?? -1;
    const next = edge >= 0 ? layer.keys?.[edge + 1] : undefined;
    const hardEdge = next && next.t - t <= 1.1 / 48000 && next.gain !== layer.keys![edge].gain;
    keys.set(Math.max(0, hardEdge ? Math.round(next.t * fps) - 1 : Math.round(t * fps)),
    (layer.muted ? 0 : gainAt(layer.keys, t) * 10 ** ((layer.gainDb ?? 0) / 20)) *
    (layer.fadeInS ? Math.min(1, t / layer.fadeInS) : 1) *
    (layer.fadeOutS ? Math.min(1, (layer.d - t) / layer.fadeOutS) : 1));
  }
  return `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audio</effectcategory><effecttype>audio</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name>${[...keys].map(([when, value]) => `<keyframe><when>${when}</when><value>${value}</value><interpolation><name>FCPCurve</name></interpolation></keyframe>`).join('')}</parameter></effect></filter>`;
}
const sourceS = (c: CutItem) => c.inFrames / hz(c.clipFpsR);
const length = (c: CutItem, i: EditorInput) => c.durTimelineFrames / i.template.fps;
const cutsOf = (i: EditorInput) => i.selects?.cuts ?? i.cutList;
function placeholder(i: EditorInput, c: CutItem): string | null {
  const layout = finishingOf(i)?.layouts?.[c.piece];
  return layout?.kind === 'placeholder' ? `Shot needed: ${layout.note || 'Add this shot'}` : null;
}
const duration = (i: EditorInput) => audioPlan(i).durationS;
const timingOf = (i: EditorInput, c: CutItem) => audioPlan(i).items[cutsOf(i).indexOf(c)];
const playLength = (i: EditorInput, c: CutItem) => { const p = timingOf(i, c); return p ? p.endS - p.startS : length(c, i); };
const title = (i: EditorInput) => i.opts?.reel?.title ?? `${i.shoot.name || path.basename(i.root)} - ${i.kind}`;
const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 170) || "cut";
async function mediaPath(i: EditorInput, file: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(i.root, file));
  if (!(await fs.stat(resolved)).isFile()) throw new Error(`Not a media file: ${resolved}`);
  return resolved;
}
async function url(i: EditorInput, file: string): Promise<string> { return esc(pathToFileURL(await mediaPath(i, file)).href); }
function checkCut(c: CutItem, i: EditorInput): void {
  if (![c.offsetFrames, c.durTimelineFrames, c.inFrames, c.outFrames, c.clipFpsR.num, c.clipFpsR.den].every(Number.isFinite) ||
      c.offsetFrames < 0 || c.durTimelineFrames <= 0 || c.clipFpsR.num <= 0 || c.clipFpsR.den <= 0) throw new Error("Invalid cut timing.");
  if (!c.seg) return;
  const meta = c.seg.clip.meta;
  if (!meta || c.inFrames < 0 || c.outFrames <= c.inFrames || c.outFrames / hz(c.clipFpsR) > meta.durationS + 1e-5 ||
      Math.abs((c.outFrames - c.inFrames) / hz(c.clipFpsR) - length(c, i)) > 1 / i.template.fps + 1e-5) {
    throw new Error(`Invalid source bounds or unsupported retime: ${c.seg.marker}`);
  }
}
function micFor(i: EditorInput, clip: Clip) {
  if (!clip.sound) return null;
  const audio = i.shoot.audio.find((a) => a.file === clip.sound!.file);
  if (!audio || !Number.isFinite(audio.durationS) || audio.durationS <= 0 || !Number.isFinite(clip.sound.offsetS) || audio.channels < 1) {
    throw new Error(`Missing recorder metadata for ${clip.id}`);
  }
  return { ...audio, offsetS: clip.sound.offsetS };
}
function micRange(i: EditorInput, c: CutItem) {
  const mic = micFor(i, c.seg!.clip);
  if (!mic) return null;
  const start = sourceS(c) + mic.offsetS;
  const delay = Math.max(0, -start);
  const s = Math.max(0, start), d = Math.min(length(c, i) - delay, mic.durationS - s);
  if (!(d > 0)) throw new Error(`Mic does not cover ${c.seg!.marker}`);
  return { ...mic, s, d, delay };
}
interface Placed { cut: CutItem; track: number; disabled: boolean; start: number }
/** Tracks are allocated by occupied duration: a long alternate must not collide
 * with the next line on the same upper track. All sub-items stay together. */
function placed(i: EditorInput): Placed[] {
  const result = cutsOf(i).filter((c) => c.seg).map((cut) => ({ cut, track: 0, disabled: false, start: timingOf(i, cut).startS }));
  const ends: number[] = [];
  for (const line of i.selects?.lines ?? []) {
    const anchor = line.main[0];
    if (!anchor) continue;
    for (const group of line.alternates) {
      let track = i.opts?.reel?.broll.length ? 2 : 1;
      const start = timingOf(i, anchor).startS;
      while ((ends[track] ?? 0) > start + 1e-6) track++;
      let at = start;
      for (const cut of group) { result.push({ cut, track, disabled: true, start: at }); at += length(cut, i); }
      ends[track] = at;
    }
  }
  return result;
}
function overlays(i: EditorInput): Placed[] {
  const result: Placed[] = [];
  for (const b of i.opts?.reel?.broll ?? []) {
    const layout = finishingOf(i)?.layouts?.[b.voiceIndex];
    if (layout && !['face','placeholder'].includes(layout.kind)) continue;
    const group = cutsOf(i).filter((c) => c.piece === b.voiceIndex);
    if (!group.length) continue;
    const r = rate(b.seg.clip.meta!.fps), start = Math.ceil(b.seg.s * hz(r)), end = Math.floor(b.seg.e * hz(r));
    const d = Math.min((end - start) / hz(r), Math.max(...group.map(c => timingOf(i, c).endS)) - timingOf(i, group[0]).startS);
    if (d <= 0) continue;
    const cut: CutItem = { piece: b.voiceIndex, seg: b.seg, inFrames: start, outFrames: start + d * hz(r),
      clipFpsR: r, offsetFrames: timingOf(i, group[0]).startS * i.template.fps, durTimelineFrames: d * i.template.fps };
    result.push({ cut, track: 1, disabled: false, start: timingOf(i, group[0]).startS });
  }
  return result;
}

async function pipelineFile(name: string): Promise<string> {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  for (const base of [resources, process.cwd(), checkoutFile(".")]) {
    if (!base) continue;
    const file = path.join(base, "pipeline", name);
    if (await fs.stat(file).then(s => s.isFile(), () => false)) return file;
  }
  throw new Error(`Missing pipeline/${name}`);
}
// Export tools inherit the batch's signal, including the processes in CapCut packs.
function cancelExportProcess(child: import("node:child_process").ChildProcess, signal: AbortSignal) {
  const abort = () => { child.kill("SIGTERM"); child.kill("SIGCONT"); };
  signal.addEventListener("abort", abort, { once: true });
  child.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
}
function command(binary: string, args: string[]): Promise<void> {
  const input = exportContext.getStore();
  return runActivity({ kind: "render", root: input?.root ?? null, target: input?.activityTarget ?? null,
    label: "Preparing person cut-out" }, async activity => {
    await new Promise<void>((resolve, reject) => {
      activity.signal.throwIfAborted();
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      cancelExportProcess(child, activity.signal);
      let error = "";
      createInterface({ input: child.stdout }).on("line", line => {
        try {
          const event = JSON.parse(line);
          if (typeof event.pct === "number") activity.progress(event.pct, "Preparing person cut-out");
          if (typeof event.error === "string") error = (error + "\n" + event.error).slice(-16000);
        } catch { /* diagnostic */ }
      });
      child.stderr.on("data", b => { error = (error + b.toString()).slice(-16000); });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`Could not prepare the person cut-out. ${error.trim().slice(-300)}`)));
    });
  });
}

const pendingLayers = new Map<string, Promise<string>>();
async function cachedLayer(i: EditorInput, inputs: unknown, extension: string, render: (out: string) => Promise<void>): Promise<string> {
  const cache = path.join(i.root, ".sidething", "editor-layers");
  const key = createHash("sha256").update(JSON.stringify({ revision: 1, inputs })).digest("hex");
  const out = path.join(cache, key + extension);
  const old = pendingLayers.get(out); if (old) return old;
  const job = (async () => {
    await fs.mkdir(cache, { recursive: true });
    if (await fs.stat(out).then(s => s.size > 0, () => false)) { const now = new Date(); void fs.utimes(out, now, now).catch(() => {}); return out; }  // R6: last use, for the cache budget
    const temporary = path.join(cache, `${key}.${randomUUID()}${extension}`);
    try {
      await render(temporary);
      if (!(await fs.stat(temporary)).size) throw new Error("Empty editor layer render");
      await fs.rename(temporary, out);
    } finally { await fs.rm(temporary, { force: true }); }
    return out;
  })();
  pendingLayers.set(out, job);
  try { return await job; } finally { pendingLayers.delete(out); }
}
async function fingerprint(i: EditorInput, file: string) {
  const resolved = await mediaPath(i, file), stat = await fs.stat(resolved);
  return { file: resolved, size: stat.size, mtimeMs: stat.mtimeMs };
}
function subtitleSrt(i: EditorInput): string {
  const stamp = (s: number) => {
    const ms = Math.round(s * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return (finishingOf(i)?.titles?.cues ?? []).filter(c => c.role === "subtitle").sort((a, b) => a.s - b.s)
    .map((c, n) => `${n + 1}\n${stamp(c.s)} --> ${stamp(c.e)}\n${c.text.replace(/\r/g, "")}\n`).join("\n");
}
/** Fixed rendering and interchange only. All choices arrive on the version. */
export async function prepareEditorLayers(i: EditorInput, folder: string): Promise<ExportLayers> {
  const finishing = finishingOf(i) ?? { audio: { clean: false, auto: false, breaths: false, denoise: 0, loudnessLUFS: -16 } };
  const layers: ExportLayers = { video: [], voice: [], readme: [] };
  const cues = finishing.titles?.cues ?? [];
  for (const cue of cues) if (![cue.s, cue.e].every(Number.isFinite) || cue.s < 0 || cue.e <= cue.s || cue.e > duration(i) + 1e-6) {
    throw new Error(`Title cue outside the cut: ${cue.id}`);
  }
  await fs.mkdir(path.join(folder, "Layers"), { recursive: true });
  const copy = async (cached: string, name: string) => {
    const out = path.join(folder, "Layers", name); await fs.copyFile(cached, out); return out;
  };
  const pictureTop = Math.max(0, ...placed(i).map(p => p.track), ...overlays(i).map(p => p.track), ...(i.pictures ?? []).map(p=>p.track));
  const behindTrack = pictureTop + 1;
  // These custom joins have no portable native equivalent. Render just the
  // picture around the join, underneath the independently editable graphics.
  const plan = audioPlan(i);
  for (const join of plan.joins) {
    if(flattenedLayouts(finishing.layouts))continue;
    if (!['snap', 'ease', 'zoom', 'whip'].includes(join.choice.kind)) continue;
    const right = plan.items.findIndex(p => Math.abs(p.startS - join.atS) < 1e-7);
    if (right < 1 || !cutsOf(i)[right - 1].seg || !cutsOf(i)[right].seg) continue;
    // An implicit face match has no picture effect without measured subjects.
    if (join.auto && !finishing.transition && !finishing.faceMatch &&
      ![right - 1, right].some(n => cutsOf(i)[n].seg?.clip.subject?.samples?.length)) continue;
    const radius = join.choice.kind === 'ease' ? .6 : .125;
    const s = Math.max(plan.items[right - 1].startS, Math.floor((join.atS - radius) * i.template.fps) / i.template.fps);
    const e = Math.min(plan.items[right].endS, Math.ceil((join.atS + radius) * i.template.fps) / i.template.fps);
    const sources = await Promise.all([right - 1, right].map(n => fingerprint(i, cutsOf(i)[n].seg!.clip.file)));
    const cached = await cachedLayer(i, { kind: 'transition-v2', sources, plan, right, s, e, template: i.template, framing: finishing.framing, pieceFx: finishing.pieceFx, energy: finishing.energy }, '.mov', async out => {
      const { joinFraming, renderFxPictures, previewFraming, fxBlurFilter } = await import('./preview');
      const { framingMotion } = await import('./motion');
      const cuts = cutsOf(i), shape = { w: i.template.width, h: i.template.height };
      const motions = await framingMotion(i.root, cuts, finishing);
      const plans = joinFraming(cuts, i.template.fps, shape, finishing.energy ?? 'subtle', finishing, motions);
      const pictures = renderFxPictures(cuts, i.template.fps, plans, plan);
      const args: string[] = [], filters: string[] = [];
      for (const [input, n] of [right - 1, right].entries()) {
        const c = cuts[n], p = plan.items[n], clip = c.seg!.clip, picture = pictures[n];
        const sourceLength = p.timeMap.at(-1)!.s - p.timeMap[0].s;
        args.push('-ss', String(sourceS(c)), '-t', String(sourceLength), '-i', sources[input].file);
        const framed = plans[n] && picture.frame ? { ...plans[n]!, rects: picture.frame.map(k => ({ t: k.t - p.startS, x: k.x * clip.meta!.width, y: k.y * clip.meta!.height, w: k.w * clip.meta!.width, h: k.h * clip.meta!.height })) } : plans[n];
        filters.push(`[${input}:v]setpts=PTS-STARTPTS,${p.reverse ? 'reverse,' : ''}${fxSetpts(p)},fps=${i.template.fps}[raw${input}]`);
        filters.push(...previewFraming(clip, sourceS(c), sourceS(c) + sourceLength, shape, `raw${input}`, `frame${input}`, finishing.energy ?? 'subtle', undefined, i.template.fps, undefined, framed));
        const firstFrame = Math.round(Math.max(s, p.startS) * i.template.fps) - Math.round(p.startS * i.template.fps);
        const count = Math.round(Math.min(e, p.endS) * i.template.fps) - Math.round(Math.max(s, p.startS) * i.template.fps);
        filters.push(`[frame${input}]${picture.blur ? fxBlurFilter(picture.blur, p.startS, shape.w, `ex${input}`) + ',' : ''}trim=start_frame=${firstFrame},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${count}[v${input}]`);
      }
      filters.push('[v0][v1]concat=n=2:v=1:a=0[v]');
      await ffmpeg([...args, '-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[v]', '-an', '-c:v', 'prores_ks', '-profile:v', '3', '-threads', String(threads(2)), '-frames:v', String(Math.round((e - s) * i.template.fps)), out], e - s);
    });
    layers.video.push({ file: await copy(cached, `Transition ${join.index + 1} ${join.choice.kind}.mov`), name: `Rendered ${join.choice.kind} transition ${join.index + 1}`, s, d: e - s, track: behindTrack, kind: 'transition' });
  }
  for (const [n, cue] of cues.entries()) {
    if (cue.role === "subtitle") continue;
    // One cue, local time zero. Preserve per-word timing and every judged style.
    const track = editorTitleTrack(finishing.titles!, cue);
    const local = track.cues[0];
    const options = { width: i.template.width, height: i.template.height, fps: i.template.fps,
      durationS: local.e, layer: cue.layer };
    const cached = await cachedLayer(i, { kind: "title", track, options }, ".mov", async out => {
      const { renderTitleTrack } = await import("./titles/render");
      await renderTitleTrack(track, { ...options, out });
    });
    layers.video.push({ file: await copy(cached, `${String(n + 1).padStart(3, "0")} ${cue.layer} ${safeName(cue.id)}.mov`),
      name: `Title ${cue.layer}: ${cue.text}`, s: cue.s, d: local.e, track: behindTrack + (layers.video.some(l => l.kind === 'transition') ? 1 : 0), kind: cue.layer });
  }
  // GFX1: each motion graphic is one alpha clip (ProRes 4444) on the title lanes, drawn at full frame size so its place and
  // size are baked in; its html, css and js go to graphics/ so it can be re-rendered. Full-frame ones cover the picture.
  const graphics = (finishing.overlays ?? []).filter(o => o.graphic);
  for (const [n, o] of graphics.entries()) {
    const g = o.graphic!, d = o.e - o.s;
    if (![o.s, o.e].every(Number.isFinite) || o.s < 0 || d <= 0 || o.e > duration(i) + 1e-6) throw new Error(`Graphic outside the cut: ${o.id}`);
    // PRO4b: a card's picture is drawn in from the shoot's card cache. SCN1b: a scene's frames the same way.
    const { cardMediaUrl } = await import("./overlays");
    const local = { ...o, s: 0, e: d, ...(g.media ? { mediaUrl: cardMediaUrl(i.root, g.media) } : {}), ...(g.frames?.length ? { framesUrl: g.frames.map(f => cardMediaUrl(i.root, f)) } : {}) };
    const options = { width: i.template.width, height: i.template.height, fps: i.template.fps, durationS: d, layer: "all" as const, overlays: [local as typeof local & { url: string }] };
    const track = { font: "Outfit", cues: [], prompt: null, skillIds: [] };
    const cached = await cachedLayer(i, { kind: "graphic-prores", track, options: { ...options, overlays: [{ ...local, url: "" }] } }, ".mov", async out => {
      const { renderTitleTrack } = await import("./titles/render");
      const source = `${out}.alpha.mov`;
      try {
        await renderTitleTrack(track, { ...options, overlays: [{ ...local, url: "" }], out: source });
        await ffmpeg(["-i", source, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-threads", String(threads(2)), "-an", out], d);
      } finally { await fs.rm(source, { force: true }); }
    });
    const behindGraphic = g.layer === "behind";
    const name = `${String(n + 1).padStart(3, "0")} graphic ${g.template ?? "custom"}`;
    layers.video.push({ file: await copy(cached, `${name}.mov`), name: `Graphic: ${g.template ?? "custom"}`, s: o.s, d, track: behindTrack, kind: behindGraphic ? "behind" : "front" });
    const sources = path.join(folder, "graphics", name);
    await fs.mkdir(sources, { recursive: true });
    // PRO4b: a card's picture goes beside its html, which shows it from there. SCN1b: a scene's frames too.
    if (g.media) await fs.copyFile(path.join(i.root, ".sidething", "overlays", g.media), path.join(sources, "picture.webp"));
    for (const [k, f] of (g.frames ?? []).entries()) await fs.copyFile(path.join(i.root, ".sidething", "overlays", f), path.join(sources, `frame-${k}.webp`));
    const html = (g.frames ?? []).reduce((h, _f, k) => h.split(`src="#frame-${k}"`).join(`src="frame-${k}.webp"`), g.media ? g.html.split('src="#card-media"').join('src="picture.webp"') : g.html);
    await fs.writeFile(path.join(sources, "graphic.html"), `<!doctype html><meta charset="utf-8"><style>${g.css}</style><div id="gfx">${html}</div>${g.js ? `<script>${g.js}</script>` : ""}`);
    await fs.writeFile(path.join(sources, "composition.json"), JSON.stringify({ ...g, placement: { x: o.x, y: o.y, w: o.w, rotate: o.rotate ?? 0 }, startS: o.s, endS: o.e }, null, 1));
  }
  // Allocate the behind tracks first, then person, then front. Each cue is one clip.
  const ends: number[] = [];
  for (const layer of layers.video.filter(l => l.kind === "behind").sort((a, b) => a.s - b.s)) {
    let lane = layer.track; while ((ends[lane] ?? 0) > layer.s + 1e-6) lane++;
    layer.track = lane; ends[lane] = layer.s + layer.d;
  }
  const personLane = Math.max(behindTrack, ...layers.video.filter(l => l.kind === "behind").map(l => l.track)) + 1;
  const frontEnds: number[] = [];
  for (const layer of layers.video.filter(l => l.kind === "front").sort((a, b) => a.s - b.s)) {
    let lane = personLane + 1; while ((frontEnds[lane] ?? 0) > layer.s + 1e-6) lane++;
    layer.track = lane; frontEnds[lane] = layer.s + layer.d;
  }
  const groups = new Map<number, CutItem[]>();
  for (const c of cutsOf(i)) if (c.seg) { const group = groups.get(c.piece) ?? []; group.push(c); groups.set(c.piece, group); }
  for (const [piece, group] of groups) {
    const first = timingOf(i, group[0]), last = timingOf(i, group.at(-1)!);
    const s = first.startS, d = last.endS - s;
    if (!cues.some(c => c.role === "title" && c.layer === "behind" && c.s < s + d && c.e > s) && !graphics.some(o => o.graphic!.layer === "behind" && o.s < s + d && o.e > s)) continue;
    const spans: { cut: CutItem; source: number; d: number; outputD: number; timing?: FxItem; native?: PictureClip }[] = [];
    for (const c of group) {
      const item = timingOf(i, c), start = item.startS, end = item.endS;
      const b = overlays(i).find(p => p.cut.piece === piece);
      const boundary = b ? Math.max(start, Math.min(end, b.start + length(b.cut, i))) : start;
      if (b && boundary > start) spans.push({ cut: b.cut, source: sourceS(b.cut) + start - b.start, d: boundary - start, outputD: boundary - start });
      if (boundary < end) {
        const keys = [{ t: boundary, s: mapSource(item.timeMap, boundary) }, ...item.timeMap.filter(k => k.t > boundary && k.t < end), { t: end, s: mapSource(item.timeMap, end) }];
        const sourceLength = keys.at(-1)!.s - keys[0].s;
        const source = item.reverse ? item.timeMap[0].s + item.timeMap.at(-1)!.s - keys.at(-1)!.s : keys[0].s;
        spans.push({ cut: c, source, d: sourceLength, outputD: end - boundary,
          ...(retimed(item) ? { timing: { ...item, startS: boundary, endS: end, timeMap: keys } } : {}) });
      }
    }
    if (i.pictures) {
      const layout=finishing.layouts?.[piece];
      if(layout?.kind==='screen' || layout?.kind==='title')continue;
      const candidates=i.pictures.filter(p=>p.piece===piece && !p.still && (p.owner>=0 || p.owner===-2) && (p.colourClip ?? p.clip).id!==layout?.screen?.clipId);
      const boundaries=[...new Set([s,s+d,...candidates.flatMap(p=>[p.s,p.s+p.d]).filter(t=>t>s && t<s+d)])].sort((a,b)=>a-b).filter((t,n,all)=>!n || t-all[n-1]>1e-7);
      const nativeSpans: typeof spans=[];
      for(let n=0;n<boundaries.length-1;n++) {
        const start=boundaries[n],end=boundaries[n+1];
        const p=candidates.filter(p=>p.s<=start+1e-7 && p.s+p.d>=end-1e-7).sort((a,b)=>b.track-a.track)[0];
        if(!p)continue;
        const keys=[{t:0,s:mapSource(p.keys,start-p.s)},...p.keys.filter(k=>k.t>start-p.s && k.t<end-p.s).map(k=>({...k,t:k.t+p.s-start})),{t:end-start,s:mapSource(p.keys,end-p.s)}];
        const source=Math.min(...keys.map(k=>k.s)),sourceD=Math.max(...keys.map(k=>k.s))-source+(keys[0].s>keys.at(-1)!.s?1/p.clip.meta!.fps:0);
        const cut={...group[0],seg:{...group[0].seg!,clip:p.clip}};
        nativeSpans.push({cut,source,d:Math.max(1/p.clip.meta!.fps,sourceD),outputD:end-start,timing:pictureTiming({...p,s:start,d:end-start,keys}),native:p});
      }
      if(nativeSpans.length && Math.abs(nativeSpans.reduce((sum,p)=>sum+p.outputD,0)-d)<1e-6)spans.splice(0,spans.length,...nativeSpans);
    }
    const sources = await Promise.all(spans.map(p => fingerprint(i, p.cut.seg!.clip.file)));
    const cached = await cachedLayer(i, { kind: "person-framed-v6", grade:finishing.grade, pieceFx:finishing.pieceFx, sources, spans: spans.map(p => ({ source: p.source, d: p.d, timing: p.timing, native:p.native ? {frames:p.native.frames,region:p.native.region,alpha:p.native.alpha} : null })), template: i.template }, ".mov", async out => {
      const script = await pipelineFile("matte.py");
      await fs.mkdir(path.join(i.root, ".sidething", "mattes"), { recursive: true });
      const args: string[] = [], filters: string[] = [], labels: string[] = [], mattes: string[] = [];
      try {
        for (const [n, span] of spans.entries()) {
          const meta = span.cut.seg!.clip.meta!;
          const w = meta.width, h = meta.height;
          const matte = path.join(i.root, ".sidething", "mattes", `editor-${randomUUID()}.mkv`); mattes.push(matte);
          if(!span.native?.alpha) await command(tool("python3"), ["-I", script, i.root, "--clip", span.cut.seg!.clip.id,
            "--s", String(span.source), "--e", String(span.source + span.d), "--fps", String(i.template.fps),
            "--size", `${w}x${h}`, "--out", matte]);
          args.push("-ss", String(span.source), "-t", String(span.d), "-i", sources[n].file,
            ...(span.native?.alpha ? ["-ss",String(span.source),"-t",String(span.d),"-i",sources[n].file] : ["-i",matte]));
          filters.push(`[${n * 2}:v]setpts=PTS-STARTPTS,fps=${i.template.fps},scale=${w}:${h},setsar=1,format=rgb24[p${n}]`);
          filters.push(`[${n * 2 + 1}:v]setpts=PTS-STARTPTS,${span.native?.alpha?'alphaextract,':''}scale=${w}:${h},format=gray[m${n}]`);
          filters.push(`[p${n}][m${n}]alphamerge,trim=duration=${span.d},setpts=PTS-STARTPTS,${span.timing?.reverse ? 'reverse,' : ''}${span.timing ? fxSetpts(span.timing) + ',' : ''}fps=${i.template.fps},trim=duration=${span.outputD}[alpha${n}]`);
          const timelineS = s + spans.slice(0,n).reduce((sum,p)=>sum+p.outputD,0);
          const native = span.native ?? i.pictures?.find(p=>(p.colourClip ?? p.clip).id===span.cut.seg!.clip.id && p.s<=timelineS+1e-6 && p.s+p.d>timelineS+1e-6);
          const { previewFraming } = await import('./preview');
          const plan = native ? {crop:null,scale:1,push:0,x:.5,y:.5,elapsed:0,duration:span.outputD,rects:native.frames.map(k=>({t:k.t+native.s-timelineS,x:k.x*w,y:k.y*h,w:k.w*w,h:k.h*h}))} : undefined;
          // The picture framer deliberately emits opaque YUV. Frame colour
          // and the mask separately, then restore alpha after the same crop.
          filters.push(`[alpha${n}]split=2[colour${n}][extract${n}]`, `[extract${n}]alphaextract[maskRaw${n}]`);
          // This rendered title mask sits over editable, LUT-graded pictures.
          // Its person pixels must use the same source grade, including angle
          // overrides, or an ungraded face would cover the graded camera clip.
          const { pieceGradeFilter, gradeForPiece, gradeForLook, exposureSpans } = await import('./grade');
          const sourceClip=native?.colourClip ?? span.cut.seg!.clip;
          const settings=finishing.angleCuts?.length ? (await import('./angles')).angleFxPiece({assembly:{cutList:cutsOf(i)} as import('./sidekick').StoredVersion['assembly'],pieceFx:finishing.pieceFx},sourceClip.id,piece) : piece;
          const grade=finishing.grade ?? gradeForLook('unknown',(await (await import('./settings')).getPreferences()).look);
          const sourceKeys=native?.colourKeys;
          const colourStart=sourceKeys ? Math.min(...sourceKeys.map(k=>k.s)) : span.source;
          const colourEnd=sourceKeys ? Math.max(...sourceKeys.map(k=>k.s))+(sourceKeys[0].s>sourceKeys.at(-1)!.s?1/sourceClip.meta!.fps:0) : span.source+span.d;
          const colour=await pieceGradeFilter(structuredClone(sourceClip),gradeForPiece(grade,finishing.pieceFx?.[settings]?.look),path.join(i.root,'.sidething','finish-cache'),{root:i.root,s:colourStart,e:colourEnd,neighbours:exposureSpans(cutsOf(i),i.opts?.reel?.broll ?? [],i.template.fps)});
          filters.push(`[colour${n}]${colour}[graded${n}]`);
          const shape={w:Math.max(2,Math.round((native?.region.w ?? 1)*i.template.width/2)*2),h:Math.max(2,Math.round((native?.region.h ?? 1)*i.template.height/2)*2)};
          const pad=`pad=${i.template.width}:${i.template.height}:${Math.round((native?.region.x ?? 0)*i.template.width)}:${Math.round((native?.region.y ?? 0)*i.template.height)}:color=black`;
          filters.push(...previewFraming(span.cut.seg!.clip,span.source,span.source+span.d,shape,`graded${n}`,`colourFramed${n}`,'off',undefined,i.template.fps,undefined,plan));
          filters.push(...previewFraming(span.cut.seg!.clip,span.source,span.source+span.d,shape,`maskRaw${n}`,`maskFramed${n}`,'off',undefined,i.template.fps,undefined,plan));
          filters.push(`[colourFramed${n}]${pad}[colourOut${n}]`, `[maskFramed${n}]format=gray,${pad}[maskOut${n}]`, `[colourOut${n}][maskOut${n}]alphamerge,tpad=stop_mode=clone:stop_duration=${2/i.template.fps},trim=duration=${span.outputD}[a${n}]`);
          labels.push(`[a${n}]`);
        }
        filters.push(`${labels.join("")}concat=n=${spans.length}:v=1:a=0[v]`);
        await ffmpeg([...args, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), "-map", "[v]", "-an",
          "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-threads", String(threads(4)), out], d);
      } finally { await Promise.all(mattes.map(file => fs.rm(file, { force: true }))); }
    });
    const personName = clipName(spans[0].cut.seg!.clip, { marker: spans[0].cut.seg!.marker, timelineS: s, lengthS: d });
    const personFile = `${safeName("Person " + personName)}.mov`;
    layers.video.push({ file: await copy(cached, personFile), name: `Person cut-out: ${personName}`, s, d, track: personLane, kind: "person" });
    let elapsed = 0;
    layers.readme.push(`${personFile} source sections (local seconds): ${spans.map(span => {
      const start = elapsed; elapsed += span.outputD;
      return `${start.toFixed(6)} to ${elapsed.toFixed(6)} uses ${span.cut.seg!.clip.file}`;
    }).join("; ")}.`);
  }
  const audio = await import("./audio");
  const finishAudio = finishing.audio ?? audio.DEFAULT_AUDIO_FINISH;
  {
    const clean = audio.cleanVoiceFile;
    if (!clean) throw new Error("Layered export needs A2's cleanVoiceFile(input, output, finish) in src/main/audio.ts.");
    const grouped=!!(finishing.laneLevels || finishing.laneMuted);
    const sourceVersion=grouped ? {...finishing,clipSoundMuted:false} : finishing;
    const sourcePlan=grouped ? editorPlan(cutsOf(i),i.template.fps,sourceVersion) : plan;
    const attached=attachedClipSounds(i.opts?.reel?.broll ?? [],sourcePlan,sourceVersion,i.template.fps), soundCuts=[...cutsOf(i),...attached.map(p=>p.cut)], soundPlan={...sourcePlan,items:[...sourcePlan.items,...attached.map(p=>p.item)]};
    for (const [n, c] of soundCuts.entries()) {
      if (!c.seg || !soundPlan.items[n].soundEnabled || soundPlan.items[n].muted || soundPlan.items[n].reverse) continue;
      const fx = soundPlan, span = audioSpan(fx.items[n]);
      const rate = hz(c.clipFpsR), extended = span ? { ...c, inFrames: span.timeMap[0].s * rate, outFrames: span.timeMap.at(-1)!.s * rate,
        durTimelineFrames: (span.timeMap.at(-1)!.s - span.timeMap[0].s) * i.template.fps } : c;
      const mic = micRange(i, extended), file = mic?.file ?? c.seg.clip.file;
      if (!mic && !c.seg.clip.meta!.audioChannels) continue;
      const source = await fingerprint(i, file), start = mic?.s ?? sourceS(extended), d = mic?.d ?? length(extended, i);
      const settings = pieceSoundSettings(finishAudio,finishing.pieceFx?.[fx.items[n].piece],clipDuckDb(c,fx.items[n])===10,n>=cutsOf(i).length ? 1 : 0);
      const voiceFacts = await audio.prepareVoicePiece(i.root, source.file, settings.audio, start, d,settings.clean);
      const bleepLevelDb = finishing.bleeps?.some(b => b.piece === c.piece && b.sound === 'beep')
        ? await audio.bleepVoiceLevel(i.root, voiceFacts, start, d) : undefined;
      // Let A2 validate its own filter/model/source cache on EVERY export.
      const cleanKey = createHash("sha256").update(JSON.stringify({ source, start, d, finishAudio, settings })).digest("hex");
      const cached = path.join(i.root, ".sidething", "editor-layers", `clean-${cleanKey}.wav`);
      await clean(source.file, cached, settings.audio, { root: i.root, start, duration: d, clean:settings.clean });
      let prepared = cached;
      let placedS = fx.items[n].startS + (mic?.delay ?? 0), placedD = d;
      if (span && retimed(span)) {
        const { tempoChain } = await import('./music-space');
        placedS = span.startS; placedD = span.endS - span.startS;
        prepared = await cachedLayer(i, { kind: 'retimed-voice-native-fades', source: await fingerprint(i, cached), span, delay: mic?.delay ?? 0 }, '.wav', out => {
          const segments = fxAudioSegments(span), filters: string[] = [];
          // Restore recorder leading silence before segmenting in camera time.
          filters.push(`[0:a]adelay=${Math.round((mic?.delay ?? 0) * 48000)}S:all=1,apad,atrim=duration=${span.timeMap.at(-1)!.s - span.timeMap[0].s},asplit=${segments.length}${segments.map((_, n) => `[split${n}]`).join('')}`);
          segments.forEach((segment, n) => filters.push(`[split${n}]atrim=start=${segment.sourceS - span.timeMap[0].s}:end=${segment.sourceE - span.timeMap[0].s},asetpts=PTS-STARTPTS,${tempoChain(segment.speed)},apad,atrim=duration=${(segment.sourceE - segment.sourceS) / segment.speed}[part${n}]`));
          filters.push(`${segments.map((_, n) => `[part${n}]`).join('')}concat=n=${segments.length}:v=0:a=1[a]`);
          return ffmpeg(['-i', cached, '-filter_complex', filters.join(';'), '-map', '[a]', '-c:a', 'pcm_s24le', out]);
        });
      } else {
        placedS = span.startS + (mic?.delay ?? 0);
      }
      layers.voice.push({ file: await copy(prepared, `Clean voice ${String(n + 1).padStart(3, "0")}.wav`), name: `Clean voice: ${c.seg.marker}`,
        s: placedS, d: placedD, track: n % 2, kind: "voice", item: n, clipLayer:n>=cutsOf(i).length ? 1 : 0, soundLane:'clip-sound', muted:grouped && !!finishing.clipSoundMuted, gainDb: fx.items[n].gainDb, bleepLevelDb, peakDb: voiceFacts.peakDb,
        fadeInS: (fx.items.some(p => p.audio) ? fx.items[n].audio?.fadeInS : fx.items[n].overlap) || undefined,
        fadeOutS: (fx.items.some(p => p.audio) ? fx.items[n].audio?.fadeOutS : fx.items[n + 1]?.overlap) || undefined });
    }
  }
  layers.audio = await prepareEditorAudio(finishingOf(i) ? i : { ...i, finishing }, folder, layers.voice, (key, ext, render) => cachedLayer(i, key, ext, render), ffmpeg);
  // Allocate each visual family above the preceding one; adjacent transition
  // windows, dissolving people and overlapping title cues can share no lane.
  let nextLane = pictureTop + 1;
  for (const kind of ['transition', 'behind', 'person', 'front'] as const) {
    const ends: number[] = [];
    const group = layers.video.filter(l => l.kind === kind).sort((a, b) => a.s - b.s);
    for (const layer of group) {
      let lane = nextLane; while ((ends[lane] ?? 0) > layer.s + 1e-6) lane++;
      layer.track = lane; ends[lane] = layer.s + layer.d;
    }
    if (group.length) nextLane = Math.max(...group.map(l => l.track)) + 1;
  }
  layers.readme = [];
  if (plan.items.some(p => p.reverse)) layers.readme.push('Native reverse time maps are included, with reversed clip sound muted.');
  if (hasJoinAudio(i)) layers.readme.push('J/L cuts use separate prepared voice WAVs with measured source handles and crossfades.');
  if (layers.video.some(l => l.kind === 'transition')) layers.readme.push('Custom transitions are short rendered picture clips on upper lanes, named Rendered <kind> transition. They can be moved or removed; their internal animation is baked in.');
  if (layers.video.some(l => l.kind !== 'transition')) layers.readme.push('Title graphics and person cut-outs are separate ProRes 4444 alpha clips. Text animation, segmentation and the source colour of behind-person title cut-outs are baked into those graphics.');
  if (finishing.overlays?.some(o=>o.corner==='round') || finishing.layouts?.some(l=>l?.kind==='bubble')) layers.readme.push('Rounded corners and bubble masks are baked into alpha sources; clip position and scale remain editable.');
  if (finishing.layouts?.some(l=>l?.kind==='title')) layers.readme.push('Title cards use a solid colour still and a separate alpha title; the still, title placement and timing remain editable.');
  if (finishing.pieceFx?.some(p=>p?.background && p.background.mode !== 'blur')) layers.readme.push('Person segmentation is baked into separate alpha sources over colour or image backgrounds; their timing, crop, position and scale remain editable.');
  if (finishing.pieceFx?.some(p=>p?.background?.mode === 'blur')) layers.readme.push('Saved legacy blur backgrounds export as Off, keeping the original picture.');
  if (layers.voice.length) layers.readme.push('Voice cleanup is in the prepared WAVs; original dialogue stays disabled on separate tracks.');
  if (graphics.length) layers.readme.push('Motion graphics are separate ProRes 4444 alpha clips on the upper lanes, with their place and size baked in; full-frame ones cover the picture. Their source compositions (html, css, js and timing) are in graphics/ for re-rendering. Their animation is baked in.');
  if(finishing.laneLevels) layers.readme.push('Sound lanes are separate audio compounds/nested sequences. Each outer native volume controls the lane; inner clips retain their own volumes and fades. Saved lane levels: '+JSON.stringify(finishing.laneLevels)+'.');
  layers.readme.push('The final loudness and true-peak master remain in the finished video.');
  if (finishAudio.auto !== false) layers.readme.push('The shared effects limiter is prepared in WAVs. Volume, bounded music ducking, redactions and fades remain editable.');
  if (cues.some(c => c.role === 'subtitle')) await fs.writeFile(path.join(folder, 'Subtitles.srt'), subtitleSrt(i));
  return layers;
}

/** FCP 7 XML v5, the interchange format Premiere imports. */
export async function writePremiereXml(i: EditorInput): Promise<string> {
  i = { ...i, pictures: i.pictures ?? await editorPictures(i) };
  const seqRate = rate(i.template.fps), plan = audioPlan(i);
  i.pictures = premierePictureLanes(i.pictures!,plan,hz(seqRate));
  const rateXml = (r: Rate) => `<rate><timebase>${Math.round(hz(r))}</timebase><ntsc>${r.den === 1001 ? "TRUE" : "FALSE"}</ntsc></rate>`;
  const all = [...placed(i), ...(i.pictures?.some(p=>p.owner===-2) ? [] : overlays(i))];
  const video: string[][] = [[]], audio: string[][] = [[], []];
  const files = new Map<string, string>();
  let serial = 0;
  const mainVideoIds = new Map<number,string>(), mainLinks = new Map<number,string>();
  async function fileXml(file: string, r: Rate, d: number, channels: number, clip?: Clip): Promise<string> {
    const id = files.get(file);
    if (id) return `<file id="${id}"/>`;
    const fid = `file-${files.size + 1}`; files.set(file, fid);
    const meta = clip?.meta, still = /\.(png|jpe?g|webp|tiff?)$/i.test(file);
    if (channels) { const inventory = await sourceAudioChannels(await mediaPath(i, file)); channels = inventory.stream ? inventory.channels : 0; }
    return `<file id="${fid}"><name>${esc(path.basename(file))}</name><pathurl>${await url(i, file)}</pathurl>${rateXml(r)}<duration>${Math.floor(d * hz(r) + 1e-6)}</duration><media>${meta ? `<video>${still ? '<stillframe>TRUE</stillframe>' : ''}<samplecharacteristics>${rateXml(r)}<width>${meta.width}</width><height>${meta.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>` : ""}${channels ? `<audio><samplecharacteristics><depth>24</depth><samplerate>${meta?.sampleRate || 48000}</samplerate></samplecharacteristics><channelcount>${channels}</channelcount></audio>` : ""}</media></file>`;
  }
  for (const p of all) {
    const { cut: c } = p; checkCut(c, i);
    const clip = c.seg!.clip, meta = clip.meta!;
    const overlay = !p.disabled && p.track > 0;
    const timing = !overlay && !p.disabled ? timingOf(i, c) : undefined;
    const incoming = timing?.overlap ?? 0, outgoing = timing ? plan.items[cutsOf(i).indexOf(c) + 1]?.overlap ?? 0 : 0;
    const mic = overlay ? null : micRange(i, c);
    const start = Math.round(p.start * hz(seqRate)), end = Math.round((p.start + playLength(i, c)) * hz(seqRate));
    if (end <= start) throw new Error(`Cut is shorter than one timeline frame: ${c.seg!.marker}`);
    const vin = Math.round(c.inFrames), vout = Math.round(c.outFrames);
    const vid = `video-${++serial}`;
    if (!p.disabled && !overlay) mainVideoIds.set(cutsOf(i).indexOf(c),vid);
    const selected = await sourceAudioChannels(await mediaPath(i, mic?.file ?? clip.file));
    const channels = overlay || timing?.reverse ? 0 : Math.min(2, selected.stream?.channels ?? 0);
    const channelFacts = channels ? await measureSourceAudio(i.root, await mediaPath(i, mic?.file ?? clip.file)) : null;
    const sourceTrack = selected;
    const sourceChannel = (n: number) => (sourceTrack?.firstChannel ?? 1) - 1 + (channelFacts && channelFacts.route !== "stereo" ? (channelFacts.channelDb[1] > channelFacts.channelDb[0] ? 2 : 1) : n + 1);
    const trackBase = p.track === 0 ? cutsOf(i).indexOf(c) % 2 * 2 : (p.track + 1) * 2;
    const cleanHere = !p.disabled && p.track === 0 && (timing?.muted || timing?.reverse || hasJoinAudio(i) || (i.layers?.voice ?? []).some(v => v.item === cutsOf(i).indexOf(c) || (v.item === undefined && v.s >= p.start - 1e-6 && v.s < p.start + playLength(i, c) - 1e-6)));
    const aid = Array.from({ length: channels }, (_, n) => `audio-${serial}-${n + 1}`);
    const linkRows = [{ id: vid, type: "video", track: p.track + 1, index: p.track === 0 && !p.disabled ? i.pictures!.filter(q=>q.track===0).findIndex(q=>q.owner===cutsOf(i).indexOf(c))+1 : (video[p.track]?.filter(row => row.startsWith("<clipitem")).length ?? 0) + 1 },
      ...(cleanHere ? [] : aid.map((id, n) => ({ id, type: "audio", track: trackBase + n + 1, index: (audio[trackBase + n]?.length ?? 0) + 1 })))];
    const links = linkRows.map((l) => `<link><linkclipref>${l.id}</linkclipref><mediatype>${l.type}</mediatype><trackindex>${l.track}</trackindex><clipindex>${l.index}</clipindex>${l.type === "audio" ? "<groupindex>1</groupindex>" : ""}</link>`).join("");
    if (!p.disabled && !overlay) mainLinks.set(cutsOf(i).indexOf(c),links);
    const enabled = p.disabled ? "FALSE" : "TRUE";
    const common = `<name>${esc(c.seg!.marker)}</name><enabled>${enabled}</enabled>`;
    const marker = `<marker><name>${esc(c.seg!.marker)}</name><comment>${esc(c.seg!.marker)}</comment><in>${vin}</in><out>-1</out></marker>`;
    if (incoming) (video[p.track] ??= []).push(`<transitionitem><name>Cross dissolve</name>${rateXml(seqRate)}<start>${start}</start><end>${Math.round((p.start + incoming) * hz(seqRate))}</end><alignment>center</alignment><effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype><wipecode>0</wipecode><wipeaccuracy>100</wipeaccuracy><startratio>0</startratio><endratio>1</endratio><reverse>FALSE</reverse></effect></transitionitem>`);
    if (p.disabled || overlay) (video[p.track] ??= []).push(`<clipitem id="${vid}">${common}<duration>${Math.floor(meta.durationS * hz(c.clipFpsR))}</duration>${rateXml(c.clipFpsR)}<start>${incoming ? -1 : start}</start><end>${outgoing ? -1 : end}</end><in>${vin}</in><out>${vout}</out>${await fileXml(clip.file, c.clipFpsR, meta.durationS, meta.audioChannels, clip)}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>${links}${marker}${timing ? premiereTimeMap(timing, hz(c.clipFpsR), hz(seqRate)) : ""}</clipitem>`);
    for (let n = 0; n < channels; n++) {
      const ar = mic ? seqRate : c.clipFpsR;
      let audioTiming = timing;
      if (timing && mic) {
        const first = Math.max(timing.timeMap[0].s, -mic.offsetS);
        const last = Math.min(timing.timeMap.at(-1)!.s, mic.durationS - mic.offsetS);
        const startS = mapTime(timing.timeMap, first), endS = mapTime(timing.timeMap, last);
        audioTiming = { ...timing, startS, endS, timeMap: [{ t: startS, s: first }, ...timing.timeMap.filter(k => k.s > first && k.s < last), { t: endS, s: last }] };
      }
      const astart = audioTiming ? Math.round(audioTiming.startS * hz(seqRate)) : start + Math.round((mic?.delay ?? 0) * hz(seqRate));
      const aend = audioTiming ? Math.round(audioTiming.endS * hz(seqRate)) : mic ? Math.min(end, astart + Math.round(mic.d * hz(seqRate))) : end;
      const ain = mic ? Math.round(mic.s * hz(ar)) : vin;
      const aout = mic ? ain + Math.round(mic.d * hz(ar)) : vout;
      (audio[trackBase + n] ??= []).push(`<clipitem id="${aid[n]}">${cleanHere ? `<name>${esc(`Original voice: ${c.seg!.marker}`)}</name><enabled>FALSE</enabled>` : common}<duration>${Math.floor((mic?.durationS ?? meta.durationS) * hz(ar))}</duration>${rateXml(ar)}<start>${astart}</start><end>${aend}</end><in>${ain}</in><out>${aout}</out>${await fileXml(mic?.file ?? clip.file, ar, mic?.durationS ?? meta.durationS, mic?.channels ?? meta.audioChannels, mic ? undefined : clip)}<sourcetrack><mediatype>audio</mediatype><trackindex>${sourceChannel(n)}</trackindex></sourcetrack>${cleanHere ? "" : links}${audioTiming ? premiereTimeMap(audioTiming, hz(ar), hz(seqRate), mic?.offsetS ?? 0, "audio") : ""}${premiereVolume({ file: "", name: "", kind: "voice", track: 0, s: 0, d: (aend - astart) / hz(seqRate), gainDb: timing?.gainDb ?? 0 }, hz(seqRate))}</clipitem>`);
    }
  }
  const pictureStarts = new Map<string,number>();
  for (const [n, p] of i.pictures!.entries()) {
    const m = p.clip.meta!, r = rate(m.fps);
    const low = Math.min(...p.keys.map(k => k.s)), high = Math.max(...p.keys.map(k => k.s));
    const first = i.pictures!.findIndex(q => q.owner === p.owner) === n;
    const id = first && p.owner >= 0 ? mainVideoIds.get(p.owner)! : `picture-${n}`;
    pictureStarts.set(id,Math.round(p.s*hz(seqRate)));
    const start = Math.round(p.s * hz(seqRate)), end = Math.round((p.s + p.d) * hz(seqRate));
    const incoming = p.track === 0 && p.owner >= 0 && Math.abs(p.s - plan.items[p.owner].startS) < 1e-7 ? plan.items[p.owner].overlap : 0;
    const outgoing = p.track === 0 && p.owner >= 0 && Math.abs(p.s + p.d - plan.items[p.owner].endS) < 1e-7 ? plan.items[p.owner + 1]?.overlap ?? 0 : 0;
    (video[p.track] ??= []).push(`<clipitem id="${id}"><name>${esc(p.name)}</name><enabled>TRUE</enabled><duration>${Math.ceil(m.durationS * hz(r))}</duration>${rateXml(r)}<start>${incoming ? -1 : start}</start><end>${outgoing ? -1 : end}</end><in>${p.still ? 0 : Math.round(low * hz(r))}</in><out>${p.still ? end-start : Math.round(high * hz(r)) + (p.keys[0].s > p.keys.at(-1)!.s ? 1 : 0)}</out>${await fileXml(p.clip.file,r,m.durationS,0,p.clip)}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>${p.still ? '' : premierePictureTimeMap(p,hz(seqRate))}${premierePictureTransform(p,i.template.width,i.template.height,hz(seqRate))}${first ? mainLinks.get(p.owner) ?? '' : ''}<marker><name>${esc(cutsOf(i)[p.owner]?.seg?.marker ?? p.name)}</name><in>${Math.round(low*hz(r))}</in><out>-1</out></marker>${p.alpha ? '<alphatype>straight</alphatype>' : ''}</clipitem>`);
  }
  for (const lane of video) lane?.sort((a,b) => {
    const at = (s: string) => pictureStarts.get(/<clipitem id="([^"]+)"/.exec(s)?.[1] ?? '') ?? Number(/<start>([-\d]+)<\/start>/.exec(s)?.[1] ?? 0);
    return at(a)-at(b) || Number(b.startsWith('<transitionitem'))-Number(a.startsWith('<transitionitem'));
  });
  for (const layer of [...(i.layers?.video ?? [])].sort((a, b) => a.s - b.s)) {
    const start = Math.round(layer.s * hz(seqRate)), end = Math.round((layer.s + layer.d) * hz(seqRate));
    const frames = Math.ceil(layer.d * hz(seqRate) - 1e-6);
    const clip = { meta: { width: i.template.width, height: i.template.height } } as Clip;
    (video[layer.track] ??= []).push(`<clipitem id="layer-${++serial}"><name>${esc(layer.name)}</name><enabled>TRUE</enabled><duration>${frames}</duration>${rateXml(seqRate)}<start>${start}</start><end>${end}</end><in>0</in><out>${end - start}</out>${await fileXml(layer.file, seqRate, frames / hz(seqRate), 0, clip)}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack><alphatype>straight</alphatype><marker><name>${esc(layer.name)}</name><in>0</in><out>-1</out></marker></clipitem>`);
  }
  if (!i.layers) for (const [n,{cut,item}] of attachedSoundOf(i,plan).entries()) {
    const clip=cut.seg!.clip, mic=micRange(i,cut), file=mic?.file ?? clip.file, source=mic?.s ?? sourceS(cut), d=mic?.d ?? item.endS-item.startS, inventory=await sourceAudioChannels(await mediaPath(i,file));
    const track=audio.length;
    for(let ch=0;ch<Math.min(2,inventory.stream?.channels ?? 0);ch++) (audio[track+ch] ??= []).push(`<clipitem id="attached-${n}-${ch}"><name>${esc('B-roll sound: '+cut.seg!.marker)}</name><enabled>${item.muted ? 'FALSE':'TRUE'}</enabled>${rateXml(seqRate)}<duration>${Math.round((mic?.durationS ?? clip.meta!.durationS)*hz(seqRate))}</duration><start>${Math.round((item.startS+(mic?.delay ?? 0))*hz(seqRate))}</start><end>${Math.round((item.startS+(mic?.delay ?? 0)+d)*hz(seqRate))}</end><in>${Math.round(source*hz(seqRate))}</in><out>${Math.round((source+d)*hz(seqRate))}</out>${await fileXml(file,seqRate,mic?.durationS ?? clip.meta!.durationS,inventory.channels,mic?undefined:clip)}<sourcetrack><mediatype>audio</mediatype><trackindex>${inventory.firstChannel+ch}</trackindex></sourcetrack>${premiereVolume({file,name:'',s:0,d,track:0,kind:'voice',gainDb:item.gainDb},hz(seqRate))}</clipitem>`);
  }
  if (hasJoinAudio(i) && !i.layers?.voice.length) {
    const plan = audioPlan(i), trackBase = audio.length;
    for (const [n, c] of cutsOf(i).entries()) {
      if (!c.seg || !plan.items[n].soundEnabled || plan.items[n].muted || plan.items[n].reverse) continue;
      const span = audioSpan(plan.items[n]), clip = c.seg.clip, mic = micFor(i, clip);
      const file = mic?.file ?? clip.file, inventory = await sourceAudioChannels(await mediaPath(i, file)), channels = Math.min(2, inventory.stream?.channels ?? 0);
      const source = span.timeMap[0].s + (mic?.offsetS ?? 0), delay = Math.max(0, -source);
      const s = span.startS + delay, d = Math.min(span.endS - s, (mic?.durationS ?? clip.meta!.durationS) - Math.max(0, source));
      if (d <= 0) continue;
      const ar = mic ? seqRate : c.clipFpsR;
      const start = Math.round(s * hz(seqRate)), end = Math.round((s + d) * hz(seqRate)), ain = Math.round(Math.max(0, source) * hz(ar)), aout = ain + Math.round(d * hz(ar));
      const h = plan.items[n].audio, frames = end - start, gain = 10 ** (plan.items[n].gainDb / 20);
      const keys = [[0, h?.fadeInS ? 0 : gain], [Math.round((h?.fadeInS ?? 0) * hz(seqRate)), gain], [frames - Math.round((h?.fadeOutS ?? 0) * hz(seqRate)), gain], [frames, h?.fadeOutS ? 0 : gain]];
      for (let ch = 0; ch < channels; ch++) (audio[trackBase + n % 2 * 2 + ch] ??= []).push(`<clipitem id="jl-${n}-${ch}"><name>${esc(`J/L voice: ${c.seg.marker}`)}</name><enabled>TRUE</enabled>${rateXml(ar)}<duration>${Math.floor((mic?.durationS ?? clip.meta!.durationS) * hz(ar))}</duration><start>${start}</start><end>${end}</end><in>${ain}</in><out>${aout}</out>${await fileXml(file, ar, mic?.durationS ?? clip.meta!.durationS, channels, mic ? undefined : clip)}<sourcetrack><mediatype>audio</mediatype><trackindex>${inventory.firstChannel + ch}</trackindex></sourcetrack><filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audio</effectcategory><effecttype>audio</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${gain}</value>${keys.map(([when, value]) => `<keyframe><when>${when}</when><value>${value}</value></keyframe>`).join('')}</parameter></effect></filter></clipitem>`);
    }
  }
  const cleanTrack = audio.length, laneRows = new Map<SoundLane,string[][]>();
  const savedLanes = finishingOf(i);
  // XMEML has no track filter element. A nested audio sequence gives each
  // sound lane one native volume envelope while its inner clips keep theirs.
  for (const layer of [...(i.layers?.voice ?? []), ...(i.layers?.audio ?? []).map(l => ({ ...l, track: l.track + 2 }))]) {
    const lane = (savedLanes?.laneLevels || savedLanes?.laneMuted) && layer.soundLane;
    const inner = lane ? {...layer,gainDb:(layer.gainDb ?? 0)-laneDb(savedLanes!,lane),muted:false} : layer;
    const rows = lane ? laneRows.get(lane) ?? [] : audio;
    if(lane)laneRows.set(lane,rows);
    const start = Math.round(layer.s * hz(seqRate)), end = Math.round((layer.s + layer.d) * hz(seqRate));
    const frames = Math.ceil(layer.d * hz(seqRate) - 1e-6);
    const firstId=serial+1,firstTrack=(lane ? 0 : cleanTrack)+layer.track*2;
    const clipIndexes=[0,1].map(n=>(rows[firstTrack+n]?.length ?? 0)+1);
    const links=lane ? [0,1].map(n=>`<link><linkclipref>clean-${firstId+n}</linkclipref><mediatype>audio</mediatype><trackindex>${firstTrack+n+1}</trackindex><clipindex>${clipIndexes[n]}</clipindex><groupindex>1</groupindex></link>`).join('') : '';
    for (let n = 0; n < 2; n++) (rows[(lane ? 0 : cleanTrack)+layer.track*2+n] ??= []).push(`<clipitem id="clean-${++serial}"><name>${esc(layer.name)}</name><enabled>${inner.muted ? 'FALSE':'TRUE'}</enabled><duration>${frames}</duration>${rateXml(seqRate)}<start>${start}</start><end>${end}</end><in>0</in><out>${end - start}</out>${await fileXml(layer.file, seqRate, frames / hz(seqRate), 2)}<sourcetrack><mediatype>audio</mediatype><trackindex>${n + 1}</trackindex></sourcetrack>${premiereVolume(inner, hz(seqRate))}${links}</clipitem>`);
  }
  for(const [lane,rows] of laneRows) {
    const frames=Math.round(duration(i)*hz(seqRate)),id=`sound-lane-${lane}`,firstTrack=audio.length;
    const tracks=Array.from({length:rows.length},(_,n)=>`<track>${(rows[n] ?? []).join('')}<enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${n%2+1}</outputchannelindex></track>`).join('');
    const sequence=`<sequence id="${id}"><name>${soundLaneName(lane)} lane</name><duration>${frames}</duration>${rateXml(seqRate)}<media><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>24</depth><samplerate>48000</samplerate></samplecharacteristics></format>${tracks}</audio></media></sequence>`;
    for(let channel=0;channel<2;channel++)audio.push([`<clipitem id="${id}-${channel}"><name>${soundLaneName(lane)} lane</name><enabled>${laneMuted(savedLanes!,lane)?'FALSE':'TRUE'}</enabled><duration>${frames}</duration>${rateXml(seqRate)}<start>0</start><end>${frames}</end><in>0</in><out>${frames}</out>${channel===0?sequence:`<sequence id="${id}"/>`}<sourcetrack><mediatype>audio</mediatype><trackindex>${channel+1}</trackindex></sourcetrack>${premiereVolume({file:'',name:lane,s:0,d:duration(i),track:0,kind:'voice',gainDb:laneDb(savedLanes!,lane)},hz(seqRate))}${[0,1].map(n=>`<link><linkclipref>${id}-${n}</linkclipref><mediatype>audio</mediatype><trackindex>${firstTrack+n+1}</trackindex><clipindex>1</clipindex><groupindex>1</groupindex></link>`).join('')}</clipitem>`]);
  }
  const music = i.layers?.audio ? null : i.opts?.reel?.music;
  if (music) {
    const d = Math.min(duration(i), music.endS ?? Infinity, music.durationS - music.startS);
    if (d <= 0) throw new Error("Music does not cover the reel.");
    for (let n = 0; n < 2; n++) {
      const index = audio.length;
      audio[index] = [`<clipitem id="music-${n}"><name>${esc(path.basename(music.file))}</name><enabled>TRUE</enabled><duration>${Math.floor(music.durationS * hz(seqRate))}</duration>${rateXml(seqRate)}<start>0</start><end>${Math.round(d * hz(seqRate))}</end><in>${Math.round(music.startS * hz(seqRate))}</in><out>${Math.round((music.startS + d) * hz(seqRate))}</out>${await fileXml(music.file, seqRate, music.durationS, 2)}<sourcetrack><mediatype>audio</mediatype><trackindex>${n + 1}</trackindex></sourcetrack><filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audio</effectcategory><effecttype>audio</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${10 ** (music.gainDb / 20)}</value><keyframe><when>0</when><value>${10 ** (music.gainDb / 20)}</value></keyframe><keyframe><when>${Math.max(0, Math.round((d - 1) * hz(seqRate)))}</when><value>${10 ** (music.gainDb / 20)}</value></keyframe><keyframe><when>${Math.round(d * hz(seqRate))}</when><value>0</value></keyframe></parameter></effect></filter></clipitem>`];
    }
  }
  const markers = cutsOf(i).flatMap((c, n) => placeholder(i, c) ? [`<marker><name>${esc(placeholder(i, c)!)}</name><comment>${esc(placeholder(i, c)!)}</comment><in>${Math.round(plan.items[n].startS * hz(seqRate))}</in><out>-1</out></marker>`] : []).join('');
  const tracks = (rows: string[][]) => Array.from({ length: rows.length }, (_, n) => `<track>${(rows[n] ?? []).join("\n")}<enabled>TRUE</enabled><locked>FALSE</locked></track>`).join("\n");
  const bins: string[] = [];
  if (i.selects) {
    for (const [name, cuts] of [['Lines', i.selects.lines.flatMap(l => [...l.main, ...l.alternates.flat()])], ['B-roll', i.selects.broll]] as const) {
      const clips: string[] = [];
      for (const c of cuts) if (c.seg) {
        const meta = c.seg.clip.meta!;
        clips.push(`<clip id="bin-${++serial}"><name>${esc(c.seg.marker)}</name><duration>${Math.floor(meta.durationS * hz(c.clipFpsR))}</duration>${rateXml(c.clipFpsR)}<in>${Math.round(c.inFrames)}</in><out>${Math.round(c.outFrames)}</out>${await fileXml(c.seg.clip.file, c.clipFpsR, meta.durationS, meta.audioChannels, c.seg.clip)}</clip>`);
      }
      bins.push(`<bin><name>${name}</name><children>${clips.join('')}</children></bin>`);
    }
  }
  const projectStart = bins.length ? `<project><name>${esc(title(i))}</name><children>` : '';
  const projectEnd = bins.length ? `${bins.join('')}</children></project>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">${projectStart}<sequence id="sequence-1"><name>${esc(title(i))}</name><duration>${Math.round(duration(i) * hz(seqRate))}</duration>${rateXml(seqRate)}<timecode>${rateXml(seqRate)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video><format><samplecharacteristics>${rateXml(seqRate)}<width>${i.template.width}</width><height>${i.template.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${tracks(video)}</video><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>24</depth><samplerate>48000</samplerate></samplecharacteristics></format>${tracks(audio)}</audio></media>${markers}</sequence>${projectEnd}</xmeml>\n`;
}

/** FCPXML 1.10 is supported by Final Cut Pro 10.6+. Use explicit source formats,
 * media representations and ordinary synchronized clips, with no Resolve data. */
export async function writeFinalCutXml(i: EditorInput, embedCaptions = true): Promise<string> {
  i = { ...i, pictures: i.pictures ?? await editorPictures(i) };
  const sr = rate(i.template.fps), plan = audioPlan(i);
  const seqTime = (s: number) => frameTime(Math.round(s * hz(sr)), sr);
  const formats: string[] = [], assets: string[] = [], media: string[] = [];
  const formatIds = new Map<string, string>(), assetIds = new Map<string, { id: string; origin: number; rate: Rate }>();
  const fmt = (w: number, h: number, r: Rate) => {
    const key = `${w}:${h}:${hz(r)}`;
    let id = formatIds.get(key);
    if (!id) { id = `r${formatIds.size + 1}`; formatIds.set(key, id); formats.push(`<format id="${id}" frameDuration="${frameTime(1, r)}" width="${w}" height="${h}" colorSpace="1-1-1 (Rec. 709)"/>`); }
    return id;
  };
  const seqFormat = fmt(i.template.width, i.template.height, sr);
  if (plan.items.some(p => p.overlap)) assets.push('<effect id="dissolve" name="Cross Dissolve" uid=".../Transitions.localized/Dissolves.localized/Cross Dissolve.localized/Cross Dissolve.motr"/>');
  async function camera(clip: Clip) {
    const old = assetIds.get(clip.file); if (old) return old;
    const m = { ...clip.meta!, ...clipFileDimensions(clip) }, r = rate(m.fps), parts = (m.startTimecode || "00:00:00:00").replace(";", ":").split(":").map(Number);
    const originFrames = ((parts[0] * 3600 + parts[1] * 60 + parts[2]) * Math.round(hz(r))) + parts[3];
    const inventory = await sourceAudioChannels(await mediaPath(i, clip.file));
    m.audioChannels = inventory.stream ? inventory.channels : 0;
    const a = { id: `a${assetIds.size + 1}`, origin: originFrames / hz(r), rate: r }; assetIds.set(clip.file, a);
    assets.push(`<asset id="${a.id}" name="${esc(clip.id)}" start="${frameTime(originFrames, r)}" duration="${frameTime(Math.floor(m.durationS * hz(r) + 1e-6), r)}" format="${fmt(m.width, m.height, r)}" hasVideo="1" hasAudio="${m.audioChannels ? 1 : 0}"${m.audioChannels ? ` audioSources="${inventory.sources}" audioChannels="${m.audioChannels}" audioRate="${m.sampleRate || 48000}"` : ""}><media-rep kind="original-media" src="${await url(i, clip.file)}"/></asset>`);
    return a;
  }
  async function sound(file: string, d: number, channels: number) {
    const old = assetIds.get(file); if (old) return old.id;
    const inventory = await sourceAudioChannels(await mediaPath(i, file));
    channels = inventory.stream ? inventory.channels : 0;
    const id = `a${assetIds.size + 1}`; assetIds.set(file, { id, origin: 0, rate: sr });
    assets.push(`<asset id="${id}" name="${esc(path.basename(file))}" start="0s" duration="${time(d)}" format="${seqFormat}" hasVideo="0" hasAudio="1" audioSources="${inventory.sources}" audioChannels="${channels}" audioRate="48000"><media-rep kind="original-media" src="${await url(i, file)}"/></asset>`);
    return id;
  }
  const marker = (name: string, start = "0s") => `<marker start="${start}" duration="${frameTime(1, sr)}" value="${esc(name)}"/>`;
  async function item(c: CutItem, offset: string, muteVoice = false): Promise<string> {
    checkCut(c, i);
    if (!c.seg) return `<gap offset="${offset}" start="0s" duration="${time(length(c, i))}"/>`;
    const a = await camera(c.seg.clip), d = time(length(c, i));
    const start = time(a.origin + sourceS(c)), name = esc(c.seg.marker), rotation = clipTransformXml(c.seg.clip);
    if (muteVoice) return `<asset-clip ref="${a.id}" name="${name}" offset="${offset}" start="${start}" duration="${d}" srcEnable="video">${rotation}${marker(c.seg.marker, start)}</asset-clip>`;
    const mic = micRange(i, c);
    if (mic) return `<sync-clip name="${name}" offset="${offset}" start="0s" duration="${d}" format="${seqFormat}"><asset-clip ref="${a.id}" offset="0s" start="${start}" duration="${d}" srcEnable="video">${rotation}</asset-clip><asset-clip ref="${await sound(mic.file, mic.durationS, mic.channels)}" lane="-1" offset="${time(mic.delay)}" start="${time(mic.s)}" duration="${time(mic.d)}" audioRole="dialogue.mic">${fcpxVolume({ file: "", name: "", kind: "voice", track: 0, s: 0, d: mic.d, gainDb: timingOf(i, c)?.gainDb ?? 0 }, mic.s)}${await editorChannelSources(i.root, await mediaPath(i, mic.file), "mic")}</asset-clip>${marker(c.seg.marker)}</sync-clip>`;
    const channels = c.seg.clip.meta!.audioChannels && (c.seg.lineIndex !== null || timingOf(i,c)?.soundEnabled) ? await editorChannelSources(i.root, await mediaPath(i, c.seg.clip.file), "cam") : "";
    return `<asset-clip ref="${a.id}" name="${name}" offset="${offset}" start="${start}" duration="${d}">${rotation}${fcpxVolume({ file: "", name: "", kind: "voice", track: 0, s: 0, d: length(c, i), gainDb: timingOf(i, c)?.gainDb ?? 0 }, a.origin + sourceS(c))}${marker(c.seg.marker, start)}${channels}</asset-clip>`;
  }
  async function picture(p: PictureClip, offset: number, lane = p.track): Promise<string> {
    const a = await camera(p.clip), m = p.clip.meta!, id = `picture-source-${media.length + 1}`;
    const low = Math.min(...p.keys.map(k => k.s)), high = Math.max(...p.keys.map(k => k.s));
    const sourceLength = p.still ? Math.ceil(p.d*hz(sr)-1e-7)/hz(sr) : Math.max(1 / m.fps, high - low + (p.keys[0].s > p.keys.at(-1)!.s ? 1 / m.fps : 0));
    const nativeFormat = fmt(m.width,m.height,rate(m.fps));
    media.push(`<media id="${id}" name="${esc(p.name)}"><sequence format="${nativeFormat}" duration="${time(sourceLength)}" tcStart="0s"><spine><asset-clip ref="${a.id}" offset="0s" start="${time(a.origin + low)}" duration="${time(sourceLength)}" srcEnable="video">${clipTransformXml(p.clip)}</asset-clip></spine></sequence></media>`);
    const timed = `${id}-output`;
    const remap = p.still ? '' : `<timeMap frameSampling="floor">${p.keys.map(k => `<timept time="${time(k.t)}" value="${time(k.s-low)}" interp="linear"/>`).join('')}</timeMap>`;
    media.push(`<media id="${timed}" name="${esc(p.name)}"><sequence format="${nativeFormat}" duration="${time(Math.max(p.d,Math.round(p.d*hz(sr))/hz(sr)))}" tcStart="0s"><spine><ref-clip ref="${id}" offset="0s" start="0s" duration="${time(Math.max(p.d,Math.round(p.d*hz(sr))/hz(sr)))}" srcEnable="video">${remap}</ref-clip></spine></sequence></media>`);
    return `<ref-clip ref="${timed}" name="${esc(p.name)}" offset="${seqTime(offset)}" start="0s" duration="${seqTime(p.d)}"${lane ? ` lane="${lane}"` : ''} srcEnable="video">${fcpxPictureTransform(p,i.template.width,i.template.height,time)}</ref-clip>`;
  }
  async function compound(group: CutItem[], offset: number, extra = "", anchors = "", muteVoice = false, timing?: FxItem, outgoing = 0) {
    const id = `take${media.length + 1}`, name = group[0].seg?.marker ?? "Gap";
    let at = 0; const content: string[] = [];
    for (const c of group) { content.push(await item(c, time(at), muteVoice)); at += length(c, i); }
    media.push(`<media id="${id}" name="${esc(name)}"><sequence format="${seqFormat}" duration="${time(at)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${content.join("")}</spine></sequence></media>`);
    let ref = id;
    if (timing && retimed(timing)) {
      ref = `${id}-timed`;
      const length = (Math.round(timing.endS * hz(sr)) - Math.round(timing.startS * hz(sr))) / hz(sr);
      const sourceKeys = editorTimeKeys(timing, hz(group[0].clipFpsR));
      const keys = [...sourceKeys.filter(k => k.t < length - 1e-7), { t: length, s: sourceKeys.at(-1)!.s }];
      const remap = `<timeMap frameSampling="floor" preservesPitch="1">${keys.map(k => `<timept time="${time(k.t)}" value="${time(k.s)}" interp="linear"/>`).join('')}</timeMap>`;
      // Keep authored graphics outside this retimed resource. They retain their
      // timeline clock, and recorder sound follows the source inside it.
      media.push(`<media id="${ref}" name="${esc(name)}"><sequence format="${seqFormat}" duration="${time(length)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine><ref-clip ref="${id}" offset="0s" start="0s" duration="${time(length)}">${remap}${marker(name)}</ref-clip></spine></sequence></media>`);
    }
    if (timing) {
      const owner = cutsOf(i).indexOf(group[0]);
      const pictures = i.pictures!.filter(p => p.owner === owner);
      if (pictures.length) {
        const output = `${id}-picture`, d = (Math.round(timing.endS*hz(sr))-Math.round(timing.startS*hz(sr)))/hz(sr);
        const pictureClips: string[] = [], secondary: string[] = [];
        for (const p of pictures) {
          const row = await picture(p,(Math.round(p.s*hz(sr))-Math.round(timing.startS*hz(sr)))/hz(sr),p.track);
          (p.track === 0 ? pictureClips : secondary).push(row);
        }
        // Native angle switches are consecutive picture edits on this spine.
        // Original camera/recorder sound follows its independent time map.
        const sound = `<ref-clip ref="${ref}" lane="-1" offset="0s" start="0s" duration="${time(d)}" srcEnable="audio"/>`;
        if (pictureClips.length) pictureClips[0] = pictureClips[0].replace('</ref-clip>', secondary.join('') + sound + '</ref-clip>');
        media.push(`<media id="${output}" name="${esc(name)}"><sequence format="${seqFormat}" duration="${time(d)}" tcStart="0s" audioLayout="stereo" audioRate="48k"><spine>${pictureClips.join('')}</spine></sequence></media>`);
        ref = output;
      }
    }
    const incoming = timing ? (Math.round((timing.startS + timing.overlap) * hz(sr)) - Math.round(timing.startS * hz(sr))) / hz(sr) : 0;
    const contentEnd = timing ? timing.endS - outgoing : offset + at;
    const start = seqTime(incoming), d = timing ? frameTime(Math.round(contentEnd * hz(sr)) - Math.round(offset * hz(sr)), sr) : time(at);
    return `<ref-clip ref="${ref}" name="${esc(name)}" offset="${seqTime(offset)}" start="${start}" duration="${d}"${extra}>${anchors}${marker(name, start)}${placeholder(i, group[0]) ? marker(placeholder(i, group[0])!, start) : ''}</ref-clip>`;
  }
  // Use one compound per spine sub-item. An alternate containing several cuts
  // is one connected compound, so enabling it switches its recorder with it.
  const spine: string[] = [], ends: number[] = [], overlayRows = overlays(i);
  const layerAnchors: string[] = [];
  for (const p of i.pictures!.filter(p=>p.owner < 0)) layerAnchors.push(await picture(p,p.s));
  if (hasJoinAudio(i) && !i.layers?.voice.length) {
    const jl = await joinAudioXml(i); assets.push(...jl.resources); layerAnchors.push(...jl.clips);
  }
  for (const layer of i.layers?.video ?? []) {
    const id = `layer${assets.length + 1}`;
    assets.push(`<asset id="${id}" name="${esc(layer.name)}" start="0s" duration="${frameTime(Math.ceil(layer.d * i.template.fps - 1e-6), sr)}" format="${seqFormat}" hasVideo="1" hasAudio="0"><media-rep kind="original-media" src="${await url(i, layer.file)}"/></asset>`);
    layerAnchors.push(`<asset-clip ref="${id}" name="${esc(layer.name)}" lane="${layer.track}" offset="${seqTime(layer.s)}" start="0s" duration="${frameTime(Math.round((layer.s + layer.d) * hz(sr)) - Math.round(layer.s * hz(sr)), sr)}" srcEnable="video"/>`);
  }
  const laneClips = new Map<SoundLane,string[]>(), savedLanes=finishingOf(i);
  for (const layer of [...(i.layers?.voice ?? []), ...(i.layers?.audio ?? []).map(l => ({ ...l, track: l.track + 2 }))]) {
    const lane=(savedLanes?.laneLevels || savedLanes?.laneMuted) && layer.soundLane;
    const inner=lane ? {...layer,gainDb:(layer.gainDb ?? 0)-laneDb(savedLanes!,lane),muted:false} : layer;
    const clip=`<asset-clip ref="${await sound(layer.file, layer.d, 2)}" name="${esc(layer.name)}" lane="${-3-layer.track}" offset="${time(layer.s)}" start="0s" duration="${time(layer.d)}" enabled="${inner.muted ? 0 : 1}" audioRole="${layer.name.startsWith("Voiceover:") ? "dialogue.voiceover" : layer.kind === "voice" ? "dialogue.clean" : layer.kind === "music" ? "music" : "effects"}">${fcpxVolume(inner)}</asset-clip>`;
    if(lane){const clips=laneClips.get(lane) ?? [];clips.push(clip);laneClips.set(lane,clips);}else layerAnchors.push(clip);
  }
  // An audio compound is the FCPXML/Resolve equivalent of a lane bus. Its
  // native fader remains separate from every inner clip volume and fade.
  for(const [lane,clips] of laneClips) {
    const id=`sound-lane-${lane}`,d=time(duration(i));
    media.push(`<media id="${id}" name="${soundLaneName(lane)} lane"><sequence format="${seqFormat}" duration="${d}" tcStart="0s" audioLayout="stereo" audioRate="48k"><spine><gap name="Lane" offset="0s" start="0s" duration="${d}">${clips.join('')}</gap></spine></sequence></media>`);
    layerAnchors.push(`<ref-clip ref="${id}" name="${soundLaneName(lane)} lane" lane="${-30-SOUND_LANES.indexOf(lane)}" offset="0s" start="0s" duration="${d}" enabled="${laneMuted(savedLanes!,lane)?0:1}" srcEnable="audio">${fcpxVolume({file:'',name:lane,s:0,d:duration(i),track:0,kind:'voice',gainDb:laneDb(savedLanes!,lane)})}</ref-clip>`);
  }
  if (!i.layers) for (const {cut,item} of attachedSoundOf(i,plan)) {
    const clip=cut.seg!.clip, mic=micRange(i,cut), file=mic?.file ?? clip.file, source=mic?.s ?? sourceS(cut);
    if (!(mic || clip.meta?.audioChannels)) continue;
    layerAnchors.push(`<asset-clip ref="${await sound(file,mic?.durationS ?? clip.meta!.durationS,mic?.channels ?? clip.meta!.audioChannels)}" name="${esc('B-roll sound: '+cut.seg!.marker)}" lane="-12" offset="${time(item.startS+(mic?.delay ?? 0))}" start="${time(source)}" duration="${time(mic?.d ?? item.endS-item.startS)}" enabled="${item.muted ? 0 : 1}" srcEnable="audio" audioRole="dialogue.broll">${fcpxVolume({file,name:'',s:0,d:item.endS-item.startS,track:0,kind:'voice',gainDb:item.gainDb},source)}${await editorChannelSources(i.root,await mediaPath(i,file),mic?'mic':'cam')}</asset-clip>`);
  }
  const music = i.layers?.audio ? null : i.opts?.reel?.music;
  if (music) {
    const d = Math.min(duration(i), music.endS ?? Infinity, music.durationS - music.startS);
    if (d <= 0) throw new Error("Music does not cover the reel.");
    layerAnchors.push(`<asset-clip ref="${await sound(music.file, music.durationS, 2)}" lane="-2" name="${esc(path.basename(music.file))}" offset="0s" start="${time(music.startS)}" duration="${time(d)}" audioRole="music"><adjust-volume amount="${music.gainDb}dB"><param name="amount"><fadeOut type="linear" duration="${time(Math.min(1, d))}"/></param></adjust-volume></asset-clip>`);
  }
  if (embedCaptions) {
    const lane = Math.max(0, ...(i.layers?.video ?? []).map(l => l.track)) + 1;
    // Apple's FCPXML caption/text-style contract, available since 1.8.
    for (const [n, cue] of (finishingOf(i)?.titles?.cues ?? []).entries()) if (cue.role === "subtitle") {
      layerAnchors.push(`<caption name="${esc(cue.text)}" lane="${lane}" offset="${seqTime(cue.s)}" start="0s" duration="${frameTime(Math.round(cue.e * hz(sr)) - Math.round(cue.s * hz(sr)), sr)}" role="Subtitles?captionFormat=ITT.en"><text placement="bottom"><text-style ref="caption-style-${n}">${esc(cue.text)}</text-style></text><text-style-def id="caption-style-${n}"><text-style fontFace="Regular" fontColor="1 1 1 1"/></text-style-def></caption>`);
    }
  }
  for (const [n, c] of cutsOf(i).entries()) {
    const timing = plan.items[n];
    if (!c.seg) {
      spine.push(`<gap name="${esc(placeholder(i, c) ?? 'Gap')}" offset="${seqTime(timing.startS)}" start="0s" duration="${seqTime(timing.endS - timing.startS)}">${n === 0 ? layerAnchors.join('') : ''}${placeholder(i, c) ? marker(placeholder(i, c)!) : ''}</gap>`);
      continue;
    }
    const start = timing.startS, anchors: string[] = [];
    if (c === cutsOf(i)[0]) anchors.push(...layerAnchors);
    const cleanHere = timing.muted || timing.reverse || !timing.soundEnabled || hasJoinAudio(i) || (i.layers?.voice ?? []).some(v => v.item === n || (v.item === undefined && v.s >= start - 1e-6 && v.s < timing.endS - 1e-6));
    if (cleanHere && !timing.reverse && (c.seg.clip.sound || c.seg.clip.meta?.audioChannels)) {
      const mic = micRange(i, c), a = await camera(c.seg.clip);
      const ref = mic ? await sound(mic.file, mic.durationS, mic.channels) : a.id;
      anchors.push(`<asset-clip ref="${ref}" name="${esc(`Original voice: ${c.seg.marker}`)}" lane="-1" offset="${time(mic?.delay ?? 0)}" start="${time(mic?.s ?? a.origin + sourceS(c))}" duration="${time(mic?.d ?? length(c, i))}" enabled="0" srcEnable="audio" audioRole="dialogue.original">${fcpxVolume({file:mic?.file ?? c.seg.clip.file,name:"",kind:"voice",track:0,s:0,d:mic?.d ?? length(c,i),gainDb:timing.gainDb},mic?.s ?? a.origin+sourceS(c))}${await editorChannelSources(i.root, await mediaPath(i, mic?.file ?? c.seg.clip.file), mic ? "mic" : "cam")}</asset-clip>`);
    }
    const line = i.selects?.lines.find((l) => l.piece === c.piece);
    if (line?.main[0] === c) for (const alt of line.alternates) {
      let lane = overlayRows.length ? 2 : 1; while ((ends[lane] ?? 0) > start + 1e-6) lane++;
      anchors.push(await compound(alt, 0, ` lane="${lane}" enabled="0"`));
      ends[lane] = start + alt.reduce((s, x) => s + length(x, i), 0);
    }
    for (const b of overlayRows) {
      if (i.pictures?.some(p=>p.owner===-2)) continue;
      const overlap = Math.min(timing.endS, b.start + length(b.cut, i)) - Math.max(start, b.start);
      if (overlap <= 0 || b.cut.piece !== c.piece) continue;
      const a = await camera(b.cut.seg!.clip), elapsed = Math.max(0, start - b.start);
      anchors.push(`<asset-clip ref="${a.id}" name="${esc(b.cut.seg!.marker)}" lane="1" offset="0s" start="${time(a.origin + sourceS(b.cut) + elapsed)}" duration="${time(overlap)}" srcEnable="video"/>`);
    }
    if (timing.overlap) spine.push(`<transition name="Cross dissolve" offset="${seqTime(start)}" duration="${frameTime(Math.round((start + timing.overlap) * hz(sr)) - Math.round(start * hz(sr)), sr)}"><filter-video ref="dissolve" name="Cross Dissolve"/></transition>`);
    spine.push(await compound([c], start + timing.overlap, "", anchors.join(""), !!cleanHere, timing, plan.items[n + 1]?.overlap ?? 0));
  }
  const bins: string[] = [];
  if (i.selects) {
    const lines: string[] = [], broll: string[] = [];
    for (const l of i.selects.lines) for (const g of [l.main, ...l.alternates]) if (g.length) lines.push(await compound(g, 0));
    for (const c of i.selects.broll) broll.push(await compound([c], 0));
    bins.push(`<event name="Lines">${lines.join("")}</event><event name="B-roll">${broll.join("")}</event>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>${formats.join("\n")}\n${assets.join("\n")}\n${media.join("\n")}</resources><library><event name="${esc(i.shoot.name)}"><project name="${esc(title(i))}"><sequence format="${seqFormat}" duration="${seqTime(duration(i))}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${spine.join("\n")}</spine></sequence></project></event>${bins.join("")}</library></fcpxml>\n`;
}

function ffmpeg(args: string[], durationS?: number): Promise<void> {
  const input = exportContext.getStore();
  const t = args.indexOf("-t");
  const total = durationS ?? (t >= 0 ? Number(args[t + 1]) : 0);
  return runActivity({ kind: "render", root: input?.root ?? null, target: input?.activityTarget ?? null,
    label: "Rendering export media", cancelable: true }, async activity => {
    await new Promise<void>((resolve, reject) => {
      activity.signal.throwIfAborted();
      const proc = spawn(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-progress", "pipe:1", ...args], { stdio: ["ignore", "pipe", "pipe"] });
      cancelExportProcess(proc, activity.signal);
      let errors = "";
      createInterface({ input: proc.stdout }).on("line", line => {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match && total > 0) activity.progress(Number(match[1]) / 1e6 / total * 100);
      });
      proc.stderr.on("data", (b: Buffer) => { errors = (errors + b.toString()).slice(-16000); });
      proc.on("error", reject);
      proc.on("close", code => code === 0 ? resolve() : reject(new Error(`Could not render the export media. ${errors.trim().slice(-300)}`)));
    });
  }, { renderLane: 'background' });
}

async function previewFile(i: EditorInput): Promise<string> {
  const finished = finishingOf(i)?.finished;
  if (finished) {
    const file = path.isAbsolute(finished) ? finished : path.join(i.root, ".sidething", "finished", finished);
    if (await fs.stat(file).then(s => s.isFile(), () => false)) return file;
  }
  let preview = i.previewPath;
  const finishing = finishingOf(i);
  if (!preview && finishing) {
    // EXP1: the draft preview stops at two minutes, so a long edit from camera originals never got its CapCut
    // reference. EXP2: a saved edit goes straight to the finished renderer, as Export video does (it renders in
    // parts at once now); trying the draft first only spent those two minutes.
    // If it cannot (a missing title asset), the draft still makes the reference, as before.
    const { renderFinishingPreview } = await import("./preview");
    preview = await renderFinishingPreview(i.root, cutsOf(i), { name: `capcut-${randomUUID()}`, template: i.template, version: { ...finishing, music: finishing.music ?? null }, reel: i.opts?.reel, full: true })
      .catch(error => { currentActivity()?.signal.throwIfAborted(); console.warn("CapCut reference: finished render failed, using the draft:", error); return null; });
  }
  if (!preview) {
    const { renderCutPreview } = await import("./export");
    preview = await renderCutPreview(i.root, cutsOf(i), i.template, `capcut-${randomUUID()}`, i.opts?.reel);
  }
  if (!preview) throw new Error("CapCut draft rendering failed; no full preview is available.");
  const file = path.isAbsolute(preview) ? preview : path.join(i.root, ".sidething", "precuts", preview);
  if (!(await fs.stat(file)).isFile()) throw new Error(`Preview is not a file: ${file}`);
  return file;
}
/** One H.264/AAC file per original piece. The caller's split sub-items already
 * omit fillers; concatenate those exact ranges without making new judgements.
 * libx264 is intentional: VideoToolbox cannot encode in the sandbox.
 */
export async function writeCapCutPack(i: EditorInput, folder: string): Promise<PrecutResult> {
  const preview = await previewFile(i);
  const groups = new Map<number, CutItem[]>();
  for (const c of cutsOf(i)) { checkCut(c, i); const g = groups.get(c.piece) ?? []; g.push(c); groups.set(c.piece, g); }
  if (!groups.size) throw new Error("Nothing to export.");
  await fs.mkdir(folder, { recursive: true });
  let ordinal = 0;
  // EXP2: each numbered clip is its own encode with its own name; they run three at a time (the same files).
  const encodes: (() => Promise<void>)[] = [];
  for (const group of groups.values()) {
    const base = group[0];
    if (!base.seg) {
      if (group.some((c) => c.seg)) throw new Error("A gap cannot share a source piece.");
      const d = group.reduce((sum, c) => sum + length(c, i), 0);
      const gap = path.join(folder, `${String(++ordinal).padStart(2, "0")} Gap.mp4`);
      encodes.push(() => ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${i.template.width}x${i.template.height}:r=${i.template.fps}`,
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(d), "-c:v", "libx264", "-crf", "18", "-c:a", "aac", gap]));
      continue;
    }
    const meta = base.seg.clip.meta!;
    if (group.some((c) => c.seg!.clip.meta!.width !== meta.width || c.seg!.clip.meta!.height !== meta.height ||
        Math.abs(hz(c.clipFpsR) - hz(base.clipFpsR)) > 1e-6)) throw new Error("A CapCut piece must have one source resolution and rate.");
    const args: string[] = [], filters: string[] = [], labels: string[] = [];
    let input = 0;
    for (const [n, c] of group.entries()) {
      const d = length(c, i), fps = hz(c.clipFpsR);
      // Decode from a nearby keyframe, then trim in decoded frame coordinates.
      // Seeking before input keeps 4K originals practical without stream-copy cuts.
      const seekFrame = Math.max(0, Math.floor(c.inFrames - fps));
      const seek = seekFrame / fps;
      const localStart = Math.round(c.inFrames) - seekFrame, frames = Math.round(c.outFrames) - Math.round(c.inFrames);
      const vi = input++; args.push("-ss", String(seek), "-t", String((localStart + frames + 1) / fps), "-i", await mediaPath(i, c.seg!.clip.file));
      filters.push(`[${vi}:v:0]trim=start_frame=${localStart}:end_frame=${localStart + frames},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v${n}]`);
      // A video file cannot retain a half-frame speech boundary. Align sound
      // to the same conformed source frame, rather than leading it by 20 ms.
      const mic = micRange(i, { ...c, inFrames: Math.round(c.inFrames), outFrames: Math.round(c.outFrames),
        durTimelineFrames: frames / fps * i.template.fps });
      const route = (mic || c.seg!.clip.meta!.audioChannels) && c.seg!.lineIndex !== null ? (await measureSourceAudio(i.root, await mediaPath(i, mic?.file ?? c.seg!.clip.file))).filter : "";
      if (mic) {
        const ai = input++; args.push("-ss", String(mic.s), "-t", String(mic.d), "-i", await mediaPath(i, mic.file));
        filters.push(`[${ai}:a:0]atrim=duration=${mic.d},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${route ? route + "," : ""}adelay=${Math.round(mic.delay * 48000)}S:all=1,apad,atrim=duration=${frames / fps}[a${n}]`);
      } else if (c.seg!.clip.meta!.audioChannels && !(i.kind === "reel" && c.seg!.lineIndex === null)) {
        filters.push(`[${vi}:a:0]atrim=start=${localStart / fps}:duration=${frames / fps},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${route ? route + "," : ""}apad,atrim=duration=${frames / fps}[a${n}]`);
      } else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${frames / fps}[a${n}]`);
      let picture = `v${n}`, audio = `a${n}`;
      const b = overlays(i).find((p) => p.cut.piece === c.piece);
      const elapsed = (c.offsetFrames - base.offsetFrames) / i.template.fps;
      if (b && elapsed < length(b.cut, i)) {
        const bi = input++, bd = Math.min(frames / fps, length(b.cut, i) - elapsed);
        args.push("-ss", String(sourceS(b.cut) + elapsed), "-t", String(bd), "-i", await mediaPath(i, b.cut.seg!.clip.file));
        filters.push(`[${bi}:v:0]trim=duration=${bd},setpts=PTS-STARTPTS,fps=${fps},scale=${meta.width}:${meta.height}:force_original_aspect_ratio=decrease,pad=${meta.width}:${meta.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[b${n}]`);
        filters.push(`[v${n}][b${n}]overlay=eof_action=pass:repeatlast=0[over${n}]`);
        picture = `over${n}`;
      }
      const music = i.opts?.reel?.music;
      if (music) {
        const timelineS = c.offsetFrames / i.template.fps;
        const md = Math.min(frames / fps, (music.endS ?? Infinity) - timelineS, music.durationS - music.startS - timelineS);
        if (md > 0) {
          const mi = input++;
          args.push("-ss", String(music.startS + timelineS), "-t", String(md), "-i", await mediaPath(i, music.file));
          const fadeStart = Math.max(0, duration(i) - 1 - timelineS);
          const initialGain = Math.min(1, Math.max(0, duration(i) - timelineS));
          filters.push(`[${mi}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${10 ** (music.gainDb / 20) * initialGain},apad,atrim=duration=${frames / fps},afade=t=out:st=${fadeStart}:d=${Math.min(1, duration(i) - timelineS)}[music${n}]`);
          filters.push(`[a${n}][music${n}]amix=inputs=2:duration=first:normalize=0[mix${n}]`);
          audio = `mix${n}`;
        }
      }
      labels.push(`[${picture}][${audio}]`);
      if (!(d > 0) || frames < 1) throw new Error("CapCut cut is shorter than one source frame.");
    }
    filters.push(`${labels.join("")}concat=n=${group.length}:v=1:a=1[v][a]`);
    await mapSourceAudioGraph(args, filters);
    const name = `${String(++ordinal).padStart(2, "0")} ${safeName(base.seg!.marker)}.mp4`;
    const pieceS = group.reduce((sum, cut) => sum + length(cut, i), 0);
    encodes.push(() => ffmpeg([...args, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-threads", String(threads(4)), "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", path.join(folder, name)], pieceS));
  }
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < encodes.length && !failed) await encodes[next++]().catch(error => { failed = true; throw error; });
  }));
  const copiedPreview = path.join(folder, "Full preview.mp4");
  await fs.copyFile(preview, copiedPreview, (await import("node:fs")).constants.COPYFILE_EXCL);
  const srt = subtitleSrt(i);
  if (srt) await fs.writeFile(path.join(folder, "Subtitles.srt"), srt);
  await fs.writeFile(path.join(folder, "README.txt"), [
    "Open CapCut Desktop and create a project.",
    "Import the numbered MP4 clips. Sort by name, then drag the numbered clips into the timeline in order.",
    "Each file is one piece. Its filler cuts are already joined and its matched microphone sound is included.",
    "Full preview.mp4 is the rendered finished MP4 when available, otherwise the draft. Import it for the complete rendered cut, or use the numbered clips to rebuild the edit.",
    ...(srt ? ["Import Subtitles.srt through Text > Local captions. Its timing starts at zero on the full cut; captions stay editable. If the full MP4 already shows subtitles, use the SRT with the numbered clips to avoid duplicate text."] : []),
    "The numbered clips contain source picture and matched voice, plus the existing reel overlays and music. Motion titles, grade, cleaned voice, placed sound effects, room tone and ambience are carried by the full rendered video. Recreate sound design in the editor when using the numbered clips.",
    "J/L audio handles and emphasis or jump-cut zooms are carried by Full preview.mp4. Recreate them when rebuilding from numbered clips.",
    "The numbered clips keep their original resolution. Set the canvas to your desired shape.",
    ...(i.opts?.reel ? ["The numbered clips include the reel's b-roll overlays and music, so placing them in order keeps the cut together."] : []),
    "Alternates are not in this pack. The numbered files are the chosen cut.", "",
  ].join("\n"));
  return { folder, preview: copiedPreview, lengthS: duration(i) };
}

/** Dispatch once. A judged finishing version supplies local layer inputs. */
export async function exportForEditor(editor: Editor, input: EditorInput): Promise<PrecutResult> {
  input = { ...input, shoot: { ...input.shoot, clips: input.shoot.clips.map(displayedClip) },
    cutList: input.cutList.map(c => c.seg ? { ...c, seg: { ...c.seg, clip: displayedClip(c.seg.clip) } } : c) };
  const work = (activity: ActivityHandle) => exportContext.run(input, async () => {
    activity.progress(null, "Preparing the export");
    if (!finishingOf(input)) {
      const { savedExportFinishing } = await import("./export");
      const finishing = await savedExportFinishing(input.root, input.cutList, { ...input.opts, existingPreview: input.previewPath });
      if (finishing) input = { ...input, finishing };
    }
    const fx = finishingOf(input);
    if (!["resolve", "premiere", "finalcut", "capcut"].includes(editor)) throw new Error(`Unknown editor: ${editor}`);
    const i = { ...input };
    if (i.kind === "selects" && !i.selects) {
      if (finishingOf(i)) throw new Error("Layered selects export needs the existing selects plan; it never asks a model to judge takes.");
      const { planSelects } = await import("./selects");
      const { applySelectSpeechEdges } = await import("./export");
      i.selects = applySelectSpeechEdges(i.shoot, await planSelects(i.root, i.shoot, i.template, i.opts?.outputFolder), i.template);
    }
    if (!cutsOf(i).length) throw new Error("Nothing to export.");
    const base = path.resolve(i.opts?.outputFolder ?? path.join(i.root, "sidething precuts"));
    await fs.mkdir(base, { recursive: true });
    const stem = safeName(i.opts?.folderName ?? `${i.kind} ${editor}`);
    let folder = path.join(base, stem);
    let resolveTimeline: string | undefined;
    if (editor === "resolve") {
      // Retain today's metadata CSV, cut history, source inventory and filenames.
      const { exportCutList: resolveWriter } = await import("./export");
      const result = await resolveWriter(i.root, i.shoot, i.kind, i.template, cutsOf(i), {
        ...i.opts, selects: i.selects, skipFinishing: true, existingPreview: i.previewPath,
      });
      folder = result.folder;
      resolveTimeline = (await fs.readdir(folder)).find(file => file.endsWith(".fcpxml"));
    } else {
      for (let n = 2; ; n++) {
        try { await fs.mkdir(folder); break; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; folder = path.join(base, `${stem} (${n})`); }
      }
    }
    const exportName = (index: number) => {
      const cut = cutsOf(i).find((c, n) => (c.piece ?? n) === index);
      return clipName(cut?.seg?.clip, { marker: cut?.seg?.marker, timelineS: (cut?.offsetFrames ?? 0) / i.template.fps });
    };
    const reverseNotes = editor === "capcut" ? fx?.pieceFx?.flatMap((piece, index) => piece?.reverse ? [`${exportName(index)}: reverse is not carried by this editor timeline. Reverse this clip and mute its own sound after import. The finished video is the playback reference.`] : []).join("\n") : undefined;
    const backgroundNotes = fx?.pieceFx?.flatMap((piece, index) => piece?.background && piece.background.mode !== 'blur' ? [`${exportName(index)}: background ${piece.background.mode} is in the finished video. This editable timeline keeps original ungraded media; reapply background removal and replacement in your editor. Settings are in backgrounds.json.`] : []).join("\n");
    if (backgroundNotes) await fs.writeFile(path.join(folder, "backgrounds.json"), JSON.stringify(fx?.pieceFx?.map(p => p?.background?.mode === 'blur' ? null : p?.background ?? null), null, 2));
    if (reverseNotes) await fs.writeFile(path.join(folder, "reverse.json"), JSON.stringify(fx?.pieceFx));
    if (editor === "capcut") {
      const result = await writeCapCutPack(i, folder);
      if (reverseNotes) await fs.appendFile(path.join(folder, "README.txt"), `\n${reverseNotes}\n`);
      if (backgroundNotes) await fs.appendFile(path.join(folder, "README.txt"), `\n${backgroundNotes}\n`);
      await (await import('./layouts')).writeLayoutDelivery(folder,i.root,fx?.layouts,i.shoot.clips);
      await (await import('./angles')).writeAngleDelivery(folder,fx?.angleCuts,i.shoot);
      return result;
    }
    i.pictures = await editorPictures(i);
    await preparePictureAssets(i,folder,(key,ext,render)=>cachedLayer(i,key,ext,render),ffmpeg,command,editor);
    if(editor==='premiere') i.pictures=premierePictureLanes(i.pictures!,audioPlan(i),i.template.fps);
    i.layers = await prepareEditorLayers(i, folder);
    i.layers.readme.push(...await (await import('./editor-colour')).writeEditorColour(i,folder,editor));
    const layoutNote=(await import('./editor-picture')).editorLayoutNote(fx?.layouts);
    if(layoutNote)i.layers.readme.push(layoutNote);
    if(fx?.pieceFx?.some(p=>p?.transform)) {
      await fs.writeFile(path.join(folder,'transforms.json'),JSON.stringify(fx.pieceFx.map(p=>p?.transform??null),null,2));
      i.layers.readme.push(flattenedTransforms(fx,editor)?'Clip transforms with Premiere flips or layouts use a flattened picture layer to preserve masks and picture edges. Captions and sound stay separate. Original settings are in transforms.json.':'Clip zoom, position, rotation and crop are native editable transforms. Settings are in transforms.json.');
    }
    await fs.writeFile(path.join(folder, "joins.json"), JSON.stringify(audioPlan(i), null, 2));
    const xml = editor === "premiere" ? await writePremiereXml(i) : await writeFinalCutXml(i, editor === "finalcut");
    await fs.writeFile(path.join(folder, resolveTimeline ?? `${safeName(title(i))}.${editor === "premiere" ? "xml" : "fcpxml"}`), editor === "resolve" ? xml.replace('<fcpxml version="1.10">', '<fcpxml version="1.9">') : xml);
    const importReadme = editor === "resolve"
      ? "In Resolve choose File > Import > Timeline and select the FCPXML. Original media stays on the picture track; finishing clips occupy connected tracks.\n"
      : editor === "premiere"
      ? "In Premiere Pro choose File > Import and select the XML. Open the imported sequence. Upper alternate clips and their linked audio are disabled. Use Linked Selection when swapping a take.\n"
      : "In Final Cut Pro 10.6 or later open a library, choose File > Import > XML, and select the FCPXML. Open the imported project. Connected alternate compounds are disabled; enable one together with its sound when replacing a line.\n";
    const captionReadme = subtitleSrt(i) ? editor === 'resolve'
      ? 'Subtitles.srt: use Import Subtitle and place it on a subtitle track at timeline zero.\n'
      : editor === 'premiere' ? 'Import Subtitles.srt and place it at timeline zero. xmeml has no native caption track.\n'
      : 'Subtitles are native captions in the timeline; Subtitles.srt is also included.\n' : '';
    await fs.writeFile(path.join(folder, "README.txt"), importReadme + captionReadme + (i.layers?.readme.join("\n") ?? "") + (reverseNotes ? `\n${reverseNotes}\n` : ""));
    if(fx?.layouts?.some(l=>l?.kind==='scene'))await (await import('./layouts')).writeLayoutDelivery(folder,i.root,fx.layouts,i.shoot.clips,true);
    if (editor === "resolve") {
      const file = path.join(folder, "precut.json"), metadata = JSON.parse(await fs.readFile(file, "utf8"));
      metadata.lengthS = duration(i);
      metadata.markers = cutsOf(i).flatMap(c => [{ label: placeholder(i, c) ?? c.seg?.marker ?? "Gap", s: timingOf(i, c).startS }]);
      await fs.writeFile(file, JSON.stringify(metadata, null, 2));
    }

    return { folder, preview: i.previewPath, lengthS: duration(i) };
  });
  const existing = input.activityTarget ? currentActivity() : undefined;
  if (existing) return work(existing);
  return runActivity({ kind: "export", root: input.root, target: input.activityTarget ?? null,
    label: `Exporting to ${{ resolve: "Resolve", premiere: "Premiere Pro", finalcut: "Final Cut Pro", capcut: "CapCut" }[editor] ?? editor}`, cancelable: true }, work);
}
