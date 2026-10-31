// Measured cover selection and the finished compositor, without a model turn.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bundledFile } from "./bundle-paths";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import { captureFrame, captureWindow, framePng } from "./capture-frame";
import type { CoverChoice, DraftPiece, Preferences } from "../shared/schema";
import type { LayoutPicture } from "./layout-math";
import { MEDIA_SCHEME, clipRotation } from "../shared/media";
import type { StoredVersion } from "./sidekick";
import { currentActivity, runActivity, withRenderSlot } from "./activity";
import { readMotion } from "./motion";
import { getPreferences } from "./settings";
import { COLOUR_MEASUREMENT_REVISION } from './grade';
import { captionSafeArea, DEFAULT_CAPTION_STYLE, type CaptionTrack } from "./titles/captions";
import { tool } from "./tools";
import { planFx, mapTime } from "./edits-fx";

const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function coverDuration(record: StoredVersion): number {
  return planFx(record.assembly.cutList, record.assembly.template.fps, record).durationS;
}
export function validateCover(choice: CoverChoice | null, duration: number): CoverChoice | null {
  if (choice === null) return null;
  if (!choice || !Number.isFinite(choice.t) || choice.t < 0 || choice.t >= duration || typeof choice.auto !== "boolean" ||
      (choice.title !== null && typeof choice.title !== "string")) throw new Error("Choose a frame inside this edit and a cover title.");
  return { t: choice.t, auto: false, title: choice.title };
}
export function automaticCover(record: StoredVersion): CoverChoice {
  const { cutList, template, shoot, reel } = record.assembly;
  const fx = planFx(cutList, template.fps, record), duration = fx.durationS, candidates: { t: number; score: number }[] = [];
  for (const [i, cut] of cutList.entries()) {
    if (!cut.seg || cut.seg.lineIndex === null) continue;
    const rate = cut.clipFpsR.num / cut.clipFpsR.den, start = cut.inFrames / rate;
    const attempts = shoot.takes?.flatMap(t => t.attempts) ?? [];
    const attempt = attempts.find(a => a.clipId === cut.seg!.clip.id && a.s <= start + .05 && a.e >= start);
    const hook = !!attempt?.hook || (cut.piece ?? i) === 0;
    for (const face of cut.seg.clip.subject?.samples ?? []) {
      if (face.kind !== "face" || ![face.t, face.w, face.h].every(Number.isFinite) || face.w <= 0 || face.h <= 0) continue;
      const t = mapTime(fx.items[i].timeMap, face.t);
      if (face.t < start || face.t >= cut.outFrames / rate || t < 0 || t >= duration / 2) continue;
      // A face on the spine is hidden while a B-roll overlay covers that instant.
      if ((reel?.broll ?? []).some(o => {
        const items = cutList.filter((c, index) => (c.piece ?? index) === o.voiceIndex);
        const owner = fx.items.find(item => item.piece === o.voiceIndex);
        const s = owner?.startS ?? Infinity;
        return t >= s && t < s + Math.min(o.seg.e - o.seg.s, items.reduce((n, c) => n + c.durTimelineFrames / template.fps, 0));
      })) continue;
      const angle = Number.isFinite(face.yaw) && Number.isFinite(face.pitch)
        ? Math.max(0, 1 - (Math.abs(face.yaw!) + Math.abs(face.pitch!)) / .9) : .25;
      const quality = attempt?.measures?.faceQuality;
      const sharp = Number.isFinite(quality) ? clamp(quality!) : .5;
      const soft = cut.seg.clip.quality?.spans?.some(s => s.kind === "soft-focus" && face.t >= s.s && face.t < s.e);
      const words = cut.seg.clip.transcript?.flatMap(p => p.words) ?? [];
      const betweenWords = words.length > 0 && !words.some(w => face.t > w.s + .04 && face.t < w.e - .04);
      candidates.push({ t, score: angle * 5 + Math.sqrt(clamp(face.w * face.h)) * 3 + sharp * 2 + (hook ? .6 : 0)
        + (betweenWords ? .25 : 0) - (soft ? 2 : 0) - t / Math.max(duration, 1) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.t - b.t);
  const firstVoice = cutList.find(c => c.seg && c.seg.lineIndex !== null);
  const fallback = Math.min(Math.max(0, duration - 1 / template.fps), fx.items[cutList.indexOf(firstVoice!)]?.startS ?? 0);
  return { t: Math.floor((candidates[0]?.t ?? fallback) * template.fps + 1e-7) / template.fps, auto: true, title: record.title };
}
export function coverChoice(record: StoredVersion): CoverChoice {
  return record.cover && !record.cover.auto ? { ...record.cover, t: Math.max(0, Math.min(record.cover.t, coverDuration(record) - 1 / record.assembly.template.fps)), title: record.cover.title ?? record.title } : automaticCover(record);
}
// Keyed by what the picture shows, not by which edit or version holds it: a duplicate reuses the source's cover.
export function coverCacheKey(_cutId: string, record: StoredVersion, choice: CoverChoice, context: unknown = null): string {
  const stableClip = (clip: StoredVersion["assembly"]["shoot"]["clips"][number]) => ({ id: clip.id, file: clip.file, meta: clip.meta, subject: clip.subject, rotation: clipRotation(clip) });
  const assembly = { template: record.assembly.template,
    cutList: record.assembly.cutList.map(c => ({ ...c, seg: c.seg ? { ...c.seg, clip: stableClip(c.seg.clip) } : null })),
    broll: record.assembly.reel.broll.map(o => ({ ...o, seg: { ...o.seg, clip: stableClip(o.seg.clip) } })) };
  return createHash("sha256").update(JSON.stringify({ revision: 5, colourRevision: COLOUR_MEASUREMENT_REVISION, t: choice.t, title: choice.title,
    grade: record.grade, titles: record.titles, framing: record.framing, pieceFx: record.pieceFx, energy: record.energy,
    faceMatch: record.faceMatch, transition: record.transition, overlays: record.overlays, joins: record.joins, assembly, context })).digest("hex");
}
export function coverTrack(record: StoredVersion, title: string, preferences: Preferences): CaptionTrack {
  const style = { ...(record.titles?.captionStyle ?? preferences.captions.style ?? DEFAULT_CAPTION_STYLE), animation: "none" as const, emphasis: false };
  const safe = captionSafeArea(preferences.captions.safeArea);
  const text = style.case === "upper" ? title.toUpperCase() : style.case === "lower" ? title.toLowerCase() : title;
  // One layout, using the caption renderer's safe-area fitting and bundled font.
  return { font: style.font, prompt: null, skillIds: [], captionStyle: style,
    captionSource: { words: [], faces: [], safeArea: safe }, cues: [{ id: "cover", role: "subtitle", layer: "front", s: 0, e: 1,
      text, x: (safe.left + safe.right) / 2, y: safe.bottom - .12, size: .065, weight: 800, italic: false,
      color: style.primary, accent: style.accent, align: "center", enter: "none", exit: "none" }] };
}
async function coverIdentity(root: string, cutId: string, record: StoredVersion, finishedFrame = false) {
  const choice = coverChoice(record), preferences = await getPreferences();
  const clips = [...record.assembly.cutList.flatMap(c => c.seg ? [c.seg.clip] : []), ...record.assembly.reel.broll.map(o => o.seg.clip)];
  const sources = await Promise.all([...new Set(clips.map(c => path.resolve(root, c.file)))].sort().map(async file => {
    const stat = await fs.stat(file); return [file, stat.size, stat.mtimeMs, stat.ctimeMs];
  }));
  const steady = record.framing?.mode === "steady" || Object.values(record.pieceFx ?? {}).some(fx => fx?.framing?.mode === "steady");
  const motions = steady ? await Promise.all([...new Map(clips.map(clip => [clip.id, clip])).values()].map(async clip => [clip.id, await readMotion(root, clip)])) : [];
  const key = coverCacheKey(cutId, record, choice, { sources, motions, output: preferences.output, captions: preferences.captions, look: preferences.look, finishedFrame });
  return { choice, preferences, key, file: path.join(root, ".sidething", "finish-cache", `cover-${key}.jpg`) };
}
async function nonempty(file: string) { try { return (await fs.stat(file)).size > 0; } catch { return false; } }
async function titleStill(track: CaptionTrack, width: number, height: number, out: string): Promise<void> {
  const signal = currentActivity()?.signal;
  signal?.throwIfAborted();
  await app.whenReady();
  // CAP3: the shared capture window (one row taller than the cover, for the capture token).
  const window = captureWindow(width, height, 60);
  const abort = () => { if (!window.isDestroyed()) window.destroy(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await window.loadFile(bundledFile("titles/template.html"));
    const payload = JSON.stringify([track, { width, height, fps: 1, durationS: 1, layer: "all" }]);
    // Preserve the template's measured safe-area fitting while wrapping a big cover title.
    await window.webContents.executeJavaScript(`{ const style = document.createElement('style'); style.textContent = '.cue { white-space: pre-wrap; max-width: ${Math.round((track.captionSource!.safeArea.right - track.captionSource!.safeArea.left) * width * .92)}px; }'; document.head.append(style); }`);
    await window.webContents.executeJavaScript(`window.titleRenderer.init(...${payload})`);
    await window.webContents.executeJavaScript(`{
      const root = document.querySelector('.cue');
      if (root) {
        const safe = ${JSON.stringify(track.captionSource!.safeArea)};
        const box = root.getBoundingClientRect();
        const maxHeight = (safe.bottom - safe.top) * ${height} * .9;
        if (box.height > maxHeight) root.style.fontSize = (parseFloat(root.style.fontSize) * maxHeight / box.height) + 'px';
        const fitted = root.getBoundingClientRect();
        const left = Math.max(safe.left * ${width}, Math.min(fitted.left, safe.right * ${width} - fitted.width));
        const top = Math.max(safe.top * ${height}, Math.min(fitted.top, safe.bottom * ${height} - fitted.height));
        root.style.left = (parseFloat(root.style.left) + left - fitted.left) + 'px';
        root.style.top = (parseFloat(root.style.top) + top - fitted.top) + 'px';
      }
    }`);
    // CAP3: the title only appears at the seek; a capture straight after it could be the page before it (a cover with
    // no title, or before the fit above). captureFrame checks the seek's token and captures again.
    const png = await framePng(await captureFrame(window, width, height, 0, () => new Error("The cover title took too long to draw.")), width, height);
    signal?.throwIfAborted();
    await fs.writeFile(out, png);
  } finally { signal?.removeEventListener("abort", abort); abort(); }
}
const pending = new Map<string, Promise<string>>();
export async function renderCover(root: string, cutId: string, record: StoredVersion, finishedVideo?: string): Promise<string> {
  const identity = await coverIdentity(root, cutId, record, !!finishedVideo);
  if (await nonempty(identity.file)) return identity.file;
  // A finished render may already hold the media slot. Never wait for a
  // background cover queued behind that same slot; its cache check will reuse ours.
  const existing = pending.get(identity.file); if (existing && !currentActivity()) return existing;
  const work = runActivity({ kind: "looks", root, target: { cutId, version: record.version }, label: "Making cover", cancelable: true }, activity => withRenderSlot(activity, async () => {
    if (await nonempty(identity.file)) return identity.file;
    const { template, cutList, reel } = record.assembly;
    const { renderFinishingPreview } = await import("./preview");
    const extracted = `${identity.file}.${randomUUID()}.frame.jpg`;
    const picture = finishedVideo ? extracted : await renderFinishingPreview(root, cutList, { name: `cover-picture-${identity.key}`, template, full: true,
      still: { t: identity.choice.t }, version: { ...record, titles: null, audio: { clean: false, denoise: 0, loudnessLUFS: -16 }, music: null }, reel: { ...reel, music: undefined } });
    const temporary = `${identity.file}.${randomUUID()}.tmp.jpg`, titleFile = `${temporary}.png`;
    try {
      if (finishedVideo) await promisify(execFile)(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-y', '-ss', String(identity.choice.t), '-i', finishedVideo, '-frames:v', '1', '-q:v', '2', extracted],
        { signal: currentActivity()?.signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      if (identity.choice.title?.trim()) {
        const scale = Math.min(Math.min(template.width, template.height), identity.preferences.output.height) / Math.min(template.width, template.height);
        const width = Math.round(template.width * scale / 2) * 2, height = Math.round(template.height * scale / 2) * 2;
        await titleStill(coverTrack(record, identity.choice.title, identity.preferences), width, height, titleFile);
        await promisify(execFile)(tool("ffmpeg"), ["-v", "error", "-y", "-i", picture, "-i", titleFile,
          "-filter_complex", "[0:v][1:v]overlay=format=auto,format=yuvj420p[v]", "-map", "[v]", "-frames:v", "1", "-q:v", "2", temporary],
        { signal: currentActivity()?.signal, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      } else await fs.copyFile(picture, temporary);
      currentActivity()?.signal.throwIfAborted();
      await fs.rename(temporary, identity.file);
      return identity.file;
    } finally { await fs.rm(temporary, { force: true }); await fs.rm(titleFile, { force: true }); await fs.rm(extracted, { force: true }); }
  }));
  pending.set(identity.file, work);
  try { return await work; } finally { if (pending.get(identity.file) === work) pending.delete(identity.file); }
}
const retryAfter = new Map<string, number>();

// PS4: the cover the app shows is the stage's own picture at the cover frame (proxy, crop, piece colour, title), made
// from the proxy when the edit is shown, never from the camera originals and never for every save. It is kept per
// content key: a save that leaves that picture alone (grain, music, a lower third, a trim elsewhere) makes nothing,
// and a version that was superseded before its cover started is never made. Exports still make their full-quality
// cover from the originals, at export time only (renderCover).
type StageTimeline = { pieces: DraftPiece[]; width: number; height: number };
type CoverLayer = { file: string; source: number; rect: { x: number; y: number; w: number; h: number } | null;
  region: { x: number; y: number; w: number; h: number } | null; circle: boolean; lut: string; opacity: number };
type LiveCoverPlan = { key: string; file: string; width: number; height: number; layers: CoverLayer[]; track: CaptionTrack | null };
// CAP3: revision 2 (and cover revision 5): a cover title captured before the capture token could have no title.
const LIVE_COVER_REVISION = 2, LIVE_COVERS_KEPT = 48, COVER_TITLES_KEPT = 16, LIVE_COVER_DELAY_MS = 1200;
function segment<T extends { t: number }>(points: T[], time: number): [T, T, number] {
  const right = points.findIndex(point => point.t > time);
  const index = right < 0 ? points.length - 1 : Math.max(0, right - 1);
  const a = points[index], b = points[Math.min(index + 1, points.length - 1)];
  return [a, b, Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t || 1)))];
}
/** The same maths as the live player (LivePlayer sourceTime, opacityAt, frameAtTime). */
function stageLayer(root: string, piece: LayoutPicture, time: number): CoverLayer | null {
  if (!piece.proxy) return null;
  let file: string;
  try {
    const [encodedRoot, kind, ...rest] = new URL(piece.proxy).pathname.split("/").slice(1).map(decodeURIComponent);
    if (path.resolve(encodedRoot) !== path.resolve(root) || !kind || !rest.length) return null;
    const base = path.resolve(root, ".sidething", kind);
    file = path.resolve(base, ...rest);
    if (!file.startsWith(base + path.sep)) return null;
  } catch { return null; }
  const at = Math.max(piece.startS, Math.min(time, piece.endS));
  let source = piece.inS + at - piece.startS;
  if (piece.timeMap?.length) { const [a, b, mix] = segment(piece.timeMap, at); source = a.s + (b.s - a.s) * mix; }
  let opacity = 1;
  if (piece.opacity?.length) { const [a, b, mix] = segment(piece.opacity, time); opacity = clamp(a.a + (b.a - a.a) * mix); }
  let rect: CoverLayer["rect"] = null;
  const frames = piece.frame;
  if (frames?.length) {
    const right = frames.findIndex(frame => frame.t > time);
    if (right === 0) rect = frames[0]; else if (right < 0) rect = frames[frames.length - 1];
    else { const a = frames[right - 1], b = frames[right], mix = (time - a.t) / (b.t - a.t || 1);
      rect = { x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix, w: a.w + (b.w - a.w) * mix, h: a.h + (b.h - a.h) * mix }; }
    rect = { x: clamp(rect.x), y: clamp(rect.y), w: Math.max(.001, Math.min(1 - clamp(rect.x), rect.w)), h: Math.max(.001, Math.min(1 - clamp(rect.y), rect.h)) };
  }
  return { file, source: Math.max(0, Math.round(source * 1e4) / 1e4), rect, region: piece.layoutRegion ?? null, circle: !!piece.layoutCircle, lut: piece.lut, opacity };
}
async function liveCoverPlan(root: string, record: StoredVersion, choice: CoverChoice, preferences: Preferences, timeline: StageTimeline): Promise<LiveCoverPlan | null> {
  const t = choice.t;
  // Draw order as the stage: spine, then overlays and layout layers; later starts on top.
  const visible = timeline.pieces.filter(p => t >= p.startS - 1e-6 && t < p.endS).sort((a, b) => a.layer - b.layer || a.startS - b.startS);
  const layers = visible.map(p => stageLayer(root, p as LayoutPicture, t)).filter((l): l is CoverLayer => !!l && l.opacity > .01);
  if (!layers.length) return null;
  const scale = Math.min(Math.min(timeline.width, timeline.height), preferences.output.height) / Math.min(timeline.width, timeline.height);
  const width = Math.round(timeline.width * scale / 2) * 2, height = Math.round(timeline.height * scale / 2) * 2;
  const track = choice.title?.trim() ? coverTrack(record, choice.title, preferences) : null;
  const files = await Promise.all([...new Set(layers.map(l => l.file))].map(async file => { const stat = await fs.stat(file); return [file, stat.size, stat.mtimeMs]; }));
  const key = createHash("sha256").update(JSON.stringify({ revision: LIVE_COVER_REVISION, width, height, layers, files, track })).digest("hex");
  return { key, file: path.join(root, ".sidething", "finish-cache", `cover-live-${key}.jpg`), width, height, layers, track };
}
async function writeCube(id: string, file: string): Promise<void> {
  const { liveLut } = await import("./grade");
  const { size, data } = await liveLut(id);
  const lines = [`LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let i = 0; i + 2 < data.length; i += 3) lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  await fs.writeFile(file, lines.join("\n") + "\n");
}
async function prune(directory: string, prefix: string, keep: number): Promise<void> {
  const names = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.startsWith(prefix) && !name.includes(".tmp"));
  if (names.length <= keep) return;
  const dated = await Promise.all(names.map(async name => ({ name, at: (await fs.stat(path.join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  for (const { name } of dated.sort((a, b) => b.at - a.at).slice(keep)) await fs.rm(path.join(directory, name), { force: true });
}
const ownerRuns = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
/**
 * FIX6: remove `precut-cover-*.cube` files a cover render left in the temp folder when its app was killed or quit
 * mid-render (a render that ends, fails or is cancelled removes its own). As EXP3's cleanupStaleExportScratch: only
 * precut's own names, only files, never one whose owner still runs. A cube from before owners were named goes once
 * nothing has touched it for an hour. Returns what was removed.
 */
export async function cleanupStaleCoverCubes(tmpDir: string = os.tmpdir(), now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fs.readdir(tmpDir).catch(() => [] as string[])) {
    const match = /^precut-cover-(?:(\d+)-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+\.cube$/.exec(name);
    if (!match) continue;
    const target = path.join(tmpDir, name);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile()) continue;
      if (match[1] !== undefined ? ownerRuns(Number(match[1])) : now - stat.mtimeMs < 3600_000) continue;
      await fs.rm(target, { force: true });
      removed.push(target);
    } catch { /* already gone; the next launch looks again */ }
  }
  return removed;
}
export async function renderLiveCover(plan: LiveCoverPlan): Promise<string> {
  if (await nonempty(plan.file)) return plan.file;
  const directory = path.dirname(plan.file), stamp = randomUUID();
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${plan.file}.${stamp}.tmp.jpg`, cubes: string[] = [];
  try {
    const args = ["-hide_banner", "-v", "error", "-y"], filters: string[] = [];
    filters.push(`color=c=black:s=${plan.width}x${plan.height}:d=1,format=rgba[canvas]`);
    let below = "canvas";
    for (const [i, layer] of plan.layers.entries()) {
      args.push("-ss", `${layer.source}`, "-i", layer.file);
      const box = layer.region ?? { x: 0, y: 0, w: 1, h: 1 };
      const bw = Math.max(2, Math.round(plan.width * box.w)), bh = Math.max(2, Math.round(plan.height * box.h));
      let chain = `[${i}:v]setpts=PTS-STARTPTS,scale=out_range=full,format=rgb48le`;
      // Cubes go to the system temp folder: a plain path the filter graph never has to quote. FIX6: named by this
      // process, so a launch after a crash or kill clears them (cleanupStaleCoverCubes) and never a running precut's.
      if (layer.lut) { const cube = path.join(os.tmpdir(), `precut-cover-${process.pid}-${stamp}-${i}.cube`); cubes.push(cube); await writeCube(layer.lut, cube); chain += `,lut3d=file=${cube}:interp=tetrahedral`; }
      if (layer.rect) filters.push(`${chain},crop=w=iw*${layer.rect.w}:h=ih*${layer.rect.h}:x=iw*${layer.rect.x}:y=ih*${layer.rect.y},scale=${bw}:${bh}:flags=lanczos,format=rgba[p${i}]`);
      else filters.push(`${chain},split[f${i}a][f${i}b]`, `[f${i}a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=24[f${i}bg]`,
        `[f${i}b]scale=${bw}:${bh}:force_original_aspect_ratio=decrease[f${i}fg]`, `[f${i}bg][f${i}fg]overlay=(W-w)/2:(H-h)/2,format=rgba[p${i}]`);
      let label = `p${i}`;
      if (layer.circle) { filters.push(`[${label}]geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-W/2,Y-H/2),min(W,H)/2),alpha(X,Y),0)'[c${i}]`); label = `c${i}`; }
      if (layer.opacity < 1) { filters.push(`[${label}]colorchannelmixer=aa=${layer.opacity}[o${i}]`); label = `o${i}`; }
      filters.push(`[${below}][${label}]overlay=x=${Math.round(plan.width * box.x)}:y=${Math.round(plan.height * box.y)}:format=auto[s${i}]`);
      below = `s${i}`;
    }
    if (plan.track) {
      // The title still depends only on its words, style and size: one per title, reused across looks and trims.
      const titleFile = path.join(directory, `cover-title-${createHash("sha256").update(JSON.stringify([LIVE_COVER_REVISION, plan.track, plan.width, plan.height])).digest("hex")}.png`);
      if (!await nonempty(titleFile)) {
        const partial = `${titleFile}.${stamp}.tmp.png`;
        try { await titleStill(plan.track, plan.width, plan.height, partial); await fs.rename(partial, titleFile); }
        finally { await fs.rm(partial, { force: true }); }
      }
      args.push("-i", titleFile);
      filters.push(`[${below}][${plan.layers.length}:v]overlay=format=auto[titled]`); below = "titled";
    }
    filters.push(`[${below}]scale=out_color_matrix=bt709:out_range=full,format=yuvj420p[cover]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[cover]", "-frames:v", "1", "-q:v", "2", temporary);
    await promisify(execFile)(tool("ffmpeg"), args, { signal: currentActivity()?.signal, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, timeout: 60_000 });
    currentActivity()?.signal.throwIfAborted();
    await fs.rename(temporary, plan.file);
    await prune(directory, "cover-live-", LIVE_COVERS_KEPT);
    await prune(directory, "cover-title-", COVER_TITLES_KEPT);
    return plan.file;
  } finally {
    await fs.rm(temporary, { force: true });
    for (const cube of cubes) await fs.rm(cube, { force: true });
  }
}
// One cover waits per edit: a newer version of the same edit replaces it before it starts.
// Asking again for the same picture keeps its place in the wait.
const waitingCovers = new Map<string, { file: string; timer: ReturnType<typeof setTimeout> }>();
function scheduleLiveCover(root: string, cutId: string, version: number, plan: LiveCoverPlan): void {
  const slot = JSON.stringify([root, cutId]);
  const waiting = waitingCovers.get(slot);
  if (waiting?.file === plan.file) return;
  if (waiting) clearTimeout(waiting.timer);
  waitingCovers.set(slot, { file: plan.file, timer: setTimeout(() => {
    waitingCovers.delete(slot);
    if (pending.has(plan.file) || Date.now() < (retryAfter.get(plan.file) ?? 0)) return;
    const work = runActivity({ kind: "looks", root, target: { cutId, version }, label: "Making cover", cancelable: true },
      activity => withRenderSlot(activity, () => renderLiveCover(plan)));
    pending.set(plan.file, work);
    work.then(() => import("./sidekick").then(m => m.changed(root)), error => {
      retryAfter.set(plan.file, Date.now() + 30_000);
      if (!(error instanceof Error && error.name === "AbortError")) console.warn("Could not make cover:", error instanceof Error ? error.message : error);
    }).finally(() => { if (pending.get(plan.file) === work) pending.delete(plan.file); });
  }, LIVE_COVER_DELAY_MS) });
}
/** `measured`: every piece's colour is known. A cover is never made from colour that is about to change. Without the
 * stage timeline only an existing cover is answered. */
export async function draftCover(root: string, cutId: string, record: StoredVersion, timeline?: StageTimeline, measured = true): Promise<CoverChoice & { image: string | null }> {
  const choice = coverChoice(record);
  const url = (file: string) => `${MEDIA_SCHEME}://local/${encodeURIComponent(root)}/finish-cache/${encodeURIComponent(path.basename(file))}`;
  // An export already made the full-quality cover of this exact picture: show that one.
  const exported = await coverIdentity(root, cutId, record, true).catch(() => null);
  if (exported && await nonempty(exported.file)) return { ...exported.choice, image: url(exported.file) };
  const standalone = await coverIdentity(root, cutId, record).catch(() => null);
  if (standalone && await nonempty(standalone.file)) return { ...standalone.choice, image: url(standalone.file) };
  const plan = timeline && await liveCoverPlan(root, record, choice, await getPreferences(), timeline).catch(() => null);
  if (!plan) return { ...choice, image: null };
  if (await nonempty(plan.file)) return { ...choice, image: url(plan.file) };
  // A pending still never holds up the draft timeline or its player.
  if (measured && !pending.has(plan.file)) scheduleLiveCover(root, cutId, record.version, plan);
  return { ...choice, image: null };
}
