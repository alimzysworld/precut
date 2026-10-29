import { BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Clip, PieceFx, DraftPiece } from '../shared/schema';
import { isLayoutCamera } from '../shared/layout-presets';
import type { LayoutPicture } from './layout-math';
import { clipRotation, clipRotationFilter, clipFileDimensions, displayedClip } from '../shared/media';
import { copyOverlay } from './overlays';
import { cameraConversionFilter } from './grade';
import { independentPreparation, runActivity, currentActivity, threads } from './activity';
import { tool } from './tools';
import { resource, processLocal } from './titles/mattes';

export type Background = NonNullable<PieceFx['background']>;
export const activeBackground = (value: PieceFx['background']) => value?.mode === 'colour' || value?.mode === 'image' ? value : null;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fingerprint(file: string) {
  const stat = await fs.stat(file);
  return [await fs.realpath(file), stat.size, stat.mtimeMs, stat.ctimeMs];
}
// Refuse redirected cache directories, including an existing cache entry.
async function cacheDirectory(root: string, name: string) {
  const base = path.resolve(root, '.sidething'), directory = path.join(base, name);
  for (const folder of [base, directory]) {
    try { if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('The background cache must stay inside this shoot.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.mkdir(folder, { recursive: true });
  }
  return directory;
}
export async function normalizeBackground(root: string, value: PieceFx['background']): Promise<PieceFx['background']> {
  if (value == null || value.mode === 'blur') return null; // Legacy saved setting plays as Off.
  if (typeof value !== 'object' || !['colour', 'image'].includes(value.mode)) throw new Error('Choose Colour or Image for the background.');
  if (value.mode === 'colour') {
    if (!/^#[0-9a-f]{6}$/i.test(value.colour ?? '')) throw new Error('Choose a six digit background colour.');
    return { mode: 'colour', colour: value.colour!.toLowerCase() };
  }
  if (typeof value.image !== 'string') throw new Error('Choose a background image.');
  const directory = await cacheDirectory(root, 'backgrounds');
  // Absolute paths are imports; saved references are content-addressed basenames.
  if (path.isAbsolute(value.image)) {
    await cacheDirectory(root, 'overlays');
    const file = await copyOverlay(root, value.image), source = path.join(root, '.sidething', 'overlays', file);
    if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('Choose an original image file.');
    const bytes = await fs.readFile(source), name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${path.extname(file)}`, destination = path.join(directory, name);
    await fs.writeFile(destination, bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    value = { mode: 'image', image: name };
  }
  await backgroundImage(root, value.image!);
  return { mode: 'image', image: value.image };
}
export async function backgroundImage(root: string, file: string): Promise<string> {
  if (!/^[a-f0-9]{16}\.(png|jpg|webp)$/.test(file)) throw new Error('Choose an image from this shoot\'s background cache.');
  const directory = await cacheDirectory(root, 'backgrounds'), result = path.join(directory, file);
  if ((await fs.lstat(result)).isSymbolicLink()) throw new Error('The background image must stay inside this shoot.');
  if (createHash('sha256').update(await fs.readFile(result)).digest('hex').slice(0, 16) !== file.slice(0, 16)) throw new Error('The background image has changed. Choose it again.');
  return result;
}

/** White-person matte refinement. Vision already feathers and temporally smooths
 * before materialising each frame. A subpixel choke suppresses old-background
 * spill without thresholding away fine hair. Shared by every background mode. */
export function backgroundMaskFilter(width: number, height: number) {
  const radius = Math.max(.35, Math.min(width, height) / 1800);
  return `format=gray,erosion,gblur=sigma=${radius},lut=y='clip((val-12)*255/243,0,255)'`;
}
const pending = new Map<string, Promise<string>>();
const retryAfter = new Map<string, number>();
async function validCache(file: string) {
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Refusing a redirected background cache entry.');
    return JSON.stringify(JSON.parse(await fs.readFile(`${file}.json`, 'utf8')).output) === JSON.stringify(await fingerprint(file));
  } catch { return false; }
}
/** One neutral, lossless composited stream feeds the live GPU and the finished
 * compositor. Framing, speed, reverse and looks remain downstream, editable.
 * Caching the composite also avoids a second per-frame decoder in the player. */
export type BackgroundSpan = { s: number; e: number };
export async function prepareBackground(root: string, clip: Clip, background: Background, span?: BackgroundSpan): Promise<string>;
export async function prepareBackground(root: string, clip: Clip, background: Background, span: BackgroundSpan | undefined, live: true): Promise<string | null>;
export async function prepareBackground(root: string, clip: Clip, background: Background, span?: BackgroundSpan, live = false): Promise<string | null> {
  clip = displayedClip(clip);
  currentActivity()?.signal.throwIfAborted();
  if (!activeBackground(background)) return path.resolve(root, clip.file);
  const meta = clip.meta;
  if (!meta || ![meta.width, meta.height, meta.fps, meta.durationS].every(n => Number.isFinite(n) && n > 0)) throw new Error('This clip needs measured video metadata.');
  const start = span?.s ?? 0, end = span?.e ?? meta.durationS;
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > meta.durationS + 1 / meta.fps) throw new Error('Choose a background span inside this clip.');
  const length = end - start;
  const scale = Math.min(1, 1280 / Math.max(meta.width, meta.height));
  const w = Math.max(2, Math.round(meta.width * scale / 2) * 2), h = Math.max(2, Math.round(meta.height * scale / 2) * 2);
  const directory = await cacheDirectory(root, 'proxies');
  const source = live ? path.resolve(directory, clip.proxy ?? '') : path.resolve(root, clip.file);
  if (live && (!clip.proxy || !source.startsWith(directory + path.sep) || !(await fs.realpath(source)).startsWith(await fs.realpath(directory) + path.sep))) throw new Error('The clip preview is unavailable.');
  const image = background.mode === 'image' ? await backgroundImage(root, background.image!) : null;
  const script = await resource('pipeline/matte.py'), swift = await resource('pipeline/matte.swift');
  const conversion = live ? 'null' : await cameraConversionFilter(clip, await cacheDirectory(root, 'finish-cache'));
  const native = live ? meta : clipFileDimensions(clip), rotation = live ? '' : clipRotationFilter(clip);
  const maskScale = Math.min(1, 1280 / Math.max(native.width, native.height));
  const mw = Math.max(2, Math.round(native.width * maskScale / 2) * 2), mh = Math.max(2, Math.round(native.height * maskScale / 2) * 2);
  const matteKey = hash([await fingerprint(source), meta, clipRotation(clip), live, start, end, await fingerprint(tool('matte')), await fs.readFile(script, 'utf8'), await fs.readFile(swift, 'utf8')]);
  const key = hash(['ul4-v3-span', w, h, matteKey, background, image && await fingerprint(image), conversion, backgroundMaskFilter(mw, mh)]);
  const file = path.join(directory, `background-${key}.mp4`);
  if (await validCache(file)) return file;
  if (pending.has(file)) return live ? null : pending.get(file)!;
  if (live && Date.now() < (retryAfter.get(file) ?? 0)) return null;
  if (live) retryAfter.set(file, Date.now() + 30_000);
  const work = independentPreparation(() => new Promise<void>(resolve => setImmediate(resolve)).then(() => runActivity({ kind: 'render', root, target: { clipId: clip.id }, label: 'Preparing background', cancelable: true }, async () => {
    if (await validCache(file)) return file;
    const matte = path.join(await cacheDirectory(root, 'mattes'), `ul4-${matteKey}.mkv`);
    const temporary = `${file}.${randomUUID()}.tmp.mp4`, receipt = `${temporary}.json`;
    try {
      await processLocal(tool('python3'), ['-I', script, root, '--clip', clip.id, '--s', String(start), '--e', String(end), '--fps', String(meta.fps), ...(live ? ['--preview'] : []), '--size', `${mw}x${mh}`, '--out', matte]);
      const args = ['-v', 'error', '-nostdin', '-y', '-filter_complex_threads', String(threads(2)), '-threads', String(threads(2)), '-ss', String(start), '-t', String(length), '-i', source, '-i', matte];
      if (image) args.push('-loop', '1', '-i', image);
      const fps = meta.fps;
      const filters = [`[0:v]${rotation}setpts=PTS-STARTPTS,fps=${fps},scale=${w}:${h}:flags=bilinear,${conversion},format=gbrp[original]`,
        `[1:v]setpts=PTS-STARTPTS,${backgroundMaskFilter(mw, mh)},${rotation}scale=${w}:${h}:flags=bilinear,format=gray[mask]`];
      filters.push('[original]null[foreground]');
      filters.push(image ? `[2:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=gbrp[background]`
        : `color=c=${background.colour}:s=${w}x${h}:r=${fps},format=gbrp[background]`);
      filters.push('[background][foreground][mask]maskedmerge,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[out]');
      args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-t', String(length), '-r', String(fps), '-c:v', 'libx264', '-preset', 'fast', '-crf', '0', '-threads', String(threads(2)), '-movflags', '+faststart', temporary);
      await processLocal(tool('ffmpeg'), args);
      currentActivity()?.signal.throwIfAborted();
      await fs.rename(temporary, file);
      await fs.writeFile(receipt, JSON.stringify({ output: await fingerprint(file) }));
      await fs.rename(receipt, `${file}.json`);
      return file;
    } catch (error) {
      currentActivity()?.signal.throwIfAborted();
      const detail = String(error);
      const reason = /signal|killed|interrupted/i.test(detail) ? 'The person measurement was interrupted. Try again.'
        : /ENOENT|not found|No such file/i.test(detail) ? 'A source file or local video tool is unavailable. Reconnect the drive and try again.'
        : 'The person measurement or video preparation stopped before it finished. Try again.';
      throw new Error(`Could not prepare the background. ${reason}`, { cause: error });
    } finally { await fs.rm(temporary, { force: true }); await fs.rm(receipt, { force: true }); }
  }, { renderLane: 'background' })));
  pending.set(file, work);
  const settled = work.finally(() => pending.delete(file));
  if (live) {
    void settled.then(() => {
      retryAfter.delete(file);
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('api:sidekick-changed', root);
    }, error => console.warn('Could not prepare background:', error instanceof Error ? error.message : error));
    return null;
  }
  return settled;
}
export async function backgroundPictures(root: string, clips: Map<string, Clip>, pictures: DraftPiece[], fx: (PieceFx | null)[] = [], live = false): Promise<DraftPiece[]> {
  const result: DraftPiece[] = [];
  for (const picture of pictures) {
    const scene=picture as LayoutPicture;
    const background = scene.layoutScene&&!isLayoutCamera(scene.layoutScene,scene.layoutSlot)?null:activeBackground(fx[picture.piece ?? 0]?.background), clip = clips.get(picture.clipId);
    const keys = picture.timeMap?.length ? picture.timeMap.map(k => k.s) : [picture.inS ?? 0, (picture.inS ?? 0) + picture.endS - picture.startS];
    const span = { s: Math.min(...keys), e: Math.max(...keys) };
    let file: string | null = null;
    if (background && clip) {
      if (live) {
        try { file = await prepareBackground(root, clip, background, span, true); }
        catch (error) { console.warn('Could not prepare live background:', error); }
      } else file = await prepareBackground(root, clip, background, span);
    }
    result.push(file ? { ...picture, inS: (picture.inS ?? 0) - span.s, timeMap: picture.timeMap?.map(k => ({ ...k, s: k.s - span.s })), proxy: `st-media://local/${encodeURIComponent(root)}/proxies/${path.basename(file)}` } : picture);
  }
  return result;
}
