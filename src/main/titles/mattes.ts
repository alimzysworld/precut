import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tool } from '../tools';
import { runActivity, currentActivity } from '../activity';
import { previewFraming, type CutFraming } from '../preview';
import type { Clip } from '../../shared/schema';
import { clipRotation, clipRotationFilter, clipFileDimensions } from '../../shared/media';
import type { PersonMatte } from './captions';

export async function resource(relative: string) {
  for (const base of [process.cwd(), app.getAppPath(), process.resourcesPath ?? '']) {
    const file = path.join(base, relative);
    try { await fs.access(file); return file; } catch { /* next */ }
  }
  throw new Error(`Could not find ${relative}.`);
}
export async function processLocal(command: string, args: string[]) {
  const signal = currentActivity()?.signal;
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const abort = () => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); if (signal?.aborted) reject(signal.reason); else if (code === 0) resolve(); else reject(new Error(`Person matte failed: ${stderr}`)); });
  });
}
/** PRO5: the edge a word's matte is drawn with. Vision's mask is soft (about 3.5 px on a 1080-pixel short side when he's
 * still) and the measurement's frame-to-frame smoothing leaves a 15% ghost of where he was when he moves: behind
 * letters both show as a see-through fringe around the head. The ramp keeps person from 0.40 to 0.70 of the measured
 * mask (about a third of the softness, centred a little inside him, so no ring of background is drawn over the letters)
 * and drops the ghost. Captions keep the plain mask. */
export const WORD_EDGE = { from: 102, to: 179 } as const;
export async function preparePersonMatte(root: string, clip: Clip, span: { s: number; e: number; timelineS: number; lengthS: number },
  frame: { width: number; height: number; fps: number }, plan: CutFraming, word = false): Promise<PersonMatte> {
  // PRO5: a word placed behind him is measured while he waits on that edit, so it doesn't queue behind background work.
  return runActivity({ kind: 'render', root, target: null, label: word ? 'Measuring the outline behind a word' : 'Measuring person for captions', cancelable: true }, async () => {
    const source = await fs.stat(path.resolve(root, clip.file));
    const script = await resource('pipeline/matte.py'), swift = await resource('pipeline/matte.swift');
    const measured = createHash('sha256').update(JSON.stringify(['j1-matte-v2', clip.file, source.size, source.mtimeMs, clipRotation(clip), span, frame, plan,
      await fs.readFile(script, 'utf8'), await fs.readFile(swift, 'utf8')])).digest('hex');
    // PRO5: a word's matte is drawn from the same measurement with a firmer edge (its own folder; captions keep theirs).
    const key = word ? createHash('sha256').update(JSON.stringify([measured, 'pro5-edge', WORD_EDGE])).digest('hex') : measured;
    const directory = path.join(root, '.sidething', 'finish-cache'), folder = path.join(directory, `person-${key}`);
    const count = Math.ceil(span.lengthS * frame.fps - 1e-7);
    const result = { s: span.timelineS, e: span.timelineS + span.lengthS, fps: frame.fps,
      // PRO5/PRO5c: every frame names its folder and file as one path part: st-media serves <root>/<kind>/<one part> only,
      // so the old caption form (folder/file as two parts) was refused and kinetic captions behind him couldn't load
      // their matte (template.html matteUrl still reads that form from edits saved before).
      frames: Array.from({ length: count }, (_, i) => `st-media://local/${encodeURIComponent(path.resolve(root))}/finish-cache/${
        encodeURIComponent(`${path.basename(folder)}/${String(i + 1).padStart(6, '0')}.png`)}`) };
    try { if ((await fs.readdir(folder)).length === count) return result; } catch { /* measure once */ }
    await fs.mkdir(directory, { recursive: true });
    const raw = path.join(root, '.sidething', 'mattes', `j1-${measured}.mkv`), temporary = `${folder}.${randomUUID()}.tmp`;
    await fs.mkdir(temporary);
    try {
      const native = clipFileDimensions(clip);
      await processLocal(tool('python3'), ['-I', script, root, '--clip', clip.id, '--s', String(span.s), '--e', String(span.e),
        '--fps', String(frame.fps), '--size', `${native.width}x${native.height}`, '--out', raw]);
      const out = { w: frame.width, h: frame.height }, ratio = span.lengthS / (span.e - span.s);
      const framing = plan.crop || plan.rects ? previewFraming(clip, span.s, span.e, out, 'source', 'framed', 'off', undefined, frame.fps, undefined, plan)
        : [`[source]scale=${out.w}:${out.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${out.w}:${out.h}:(ow-iw)/2:(oh-ih)/2:black[framed]`];
      await processLocal(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', raw, '-filter_complex',
        [`[0:v]${clipRotationFilter(clip)}setpts=${ratio}*(PTS-STARTPTS),fps=${frame.fps}[source]`, ...framing,
          `[framed]format=rgba,geq=r=255:g=255:b=255:a='${word ? `255-clip((r(X,Y)-${WORD_EDGE.from})*255/${WORD_EDGE.to - WORD_EDGE.from},0,255)` : '255-r(X,Y)'}'[mask]`].join(';'),
        '-map', '[mask]', '-an', '-frames:v', String(count), '-c:v', 'png', path.join(temporary, '%06d.png')]);
      if ((await fs.readdir(temporary)).length !== count) throw new Error('The person matte has missing frames.');
      await fs.rm(folder, { recursive: true, force: true });
      await fs.rename(temporary, folder);
      return result;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }, { renderLane: word ? 'waited' : 'background' });
}

// ---- PRO5 (docs/plans/produced/spike-v1.md, stories 1 and 4): a key word behind the person that holds up.
// Whether the person's outline is clean enough to put text behind is a measurement, so it is code: the outline is read
// from the same person mattes the viewer and the export draw with, on the frames the word covers, inside its box only.
// Which word, and where, is the agent's judgement (Ask, Produce). A word asked to sit behind whose outline isn't clean
// (or that precut can't keep aligned there) is drawn in front, and its own label says why in plain words.
declare module "../../shared/schema" {
  interface MotionGraphic {
    behindNote?: string;        // PRO5: asked to sit behind the person but drawn in front; the plain reason its label shows
    behindCheck?: BehindCheck;  // PRO5: the last measurement of the outline under it (or why none could be made)
  }
}
export interface BehindCheck { key: string; ok: boolean; frames: number; flickerPx: number; flickerMeanPx: number; bandPx: number; cover: number; edgePx: number; mattes: string[];
  wordCover?: number; wordCoverPeak?: number }   // TASTE1: the share of the word's own ink his outline covers (mean over its frames, and the 90th percentile)
type WordMatte = PersonMatte & { behindWord?: true };
/** Calibrated on his real footage (qa/PRO5/REPORT.md has the spans and numbers). Pixels are on a 1080-pixel short side.
 * flickerPx: the 90th percentile, over the item's frames, of how far the outline moves from one frame to the next
 * (area swept / outline length). bandPx: how wide the outline's soft edge is (soft pixels / outline length).
 * cover: the share of the word's box the person covers on average; above it the word can't be read behind him.
 * edgePx: below this much outline in the box per frame, nobody is behind the word.
 * Measured with WORD_EDGE on 23 spans of two shoots (qa/PRO5/calibrate.json):
 *  - bandPx: clean or still shots 0.5 to 1.35; busy backgrounds behind his hair 2.8 to 5.0. Limit 2, in the gap.
 *  - flickerPx: still shots 0.6 to 1.8; talking or walking shots 4.9 to 26. Limit 4: at a 180 degree shutter that
 *    keeps the motion blur of his outline under 2 px, the halo the eye reads around letters behind a moving head.
 *  - cover: 0 to 0.46 on every span. Limit 0.55: past it the word can't be read.
 *  - edgePx: 3.3 with no one in the box, 77 and up with him in it. Limit 8.
 * TASTE1, wordCover: the share of the word's own letters (its ink, not its box) his outline covers, averaged over its
 * frames. A word behind him reads as behind only where he passes in front of letters; with nothing in front of it, it
 * reads as a front word ("caught" between two heads in a handshake), so it is drawn in front and says so.
 * Measured on the same spans (qa/TASTE1/calibrate.mjs, each looked at with the letters he covers tinted):
 *  - nothing in front, reads as a front word: 0.015 (p90 0.041) and 0.027 (p90 0.040), "quit" above a man's cap;
 *  - something in front, reads as behind: a cap cutting into the "q" 0.038 (p90 0.122), the handshake heads 0.077 to
 *    0.289, his head on the clean shots 0.205 to 0.6 ("accelerator" 0.398).
 *  Limits 0.03 on average and 0.06 at the 90th percentile (so a hand that crosses for a moment still counts). */
export const BEHIND_LIMITS = { flickerPx: 4, bandPx: 2, cover: 0.55, edgePx: 8, wordCover: 0.03, wordCoverPeak: 0.06 } as const;
export const BEHIND_NOTES = {
  outline: "In front: the outline wasn't clean here",
  flicker: "In front: the outline wasn't steady here",
  nobody: "In front: there's no one behind it here",
  clear: "In front: nothing passes in front of it here",
  covered: "In front: you'd cover most of the word here",
  moving: "In front: a transition or speed change moves the picture here",
  picture: "In front: other footage or a layout is on screen here",
  zoom: "In front: a zoom on this shot moves the outline",
  captions: "In front: turn captions on to put words behind you",
  titles: "In front: a title already sits behind you in this edit",
  unavailable: "In front: precut couldn't measure the outline here",
} as const;

/** Outline measurements on person pixels (0 background .. 255 person), one w x h gray buffer per frame. Pure. */
export function measureOutline(frames: Buffer[], w: number, h: number, pxScale = 1) {
  const edges: number[] = [], moves: number[] = [];
  let soft = 0, edge = 0, covered = 0;
  for (let f = 0; f < frames.length; f++) {
    const p = frames[f], q = f ? frames[f - 1] : null;
    let e = 0, d = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, v = p[i], on = v >= 128;
      if (on) covered++;
      if (v > 24 && v < 231) soft++;
      if (x + 1 < w && (p[i + 1] >= 128) !== on) e++;
      if (y + 1 < h && (p[i + w] >= 128) !== on) e++;
      if (q) d += Math.abs(v - q[i]);
    }
    edges.push(e); edge += e;
    if (q) moves.push(d / 255 / Math.max(1, (e + edges[f - 1]) / 2));
  }
  const sorted = [...moves].sort((a, b) => a - b), round = (n: number) => Math.round(n * 1000) / 1000;
  const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;
  return { frames: frames.length, flickerPx: round(p90 * pxScale), flickerMeanPx: round(moves.reduce((a, b) => a + b, 0) / Math.max(1, moves.length) * pxScale),
    bandPx: round(soft / Math.max(1, edge) * pxScale), cover: round(covered / Math.max(1, frames.length * w * h)), edgePx: round(edge / Math.max(1, frames.length) * pxScale) };
}

/** The matte frame files of a person matte (they live in the shoot's finish cache). */
function matteFolder(root: string, matte: PersonMatte): string {
  const url = new URL(matte.frames[0]), parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
  const name = (parts[2] ?? '').split('/')[0];   // "person-<key>/000001.png" as one part (or the folder alone, the old caption form)
  if (path.resolve(parts[0]) !== path.resolve(root) || parts[1] !== 'finish-cache' || !/^person-[a-f0-9]{64}$/.test(name)) throw new Error('A person matte is outside this shoot.');
  return path.join(root, '.sidething', 'finish-cache', name);
}
/** TASTE1: his outline covers too little of the word's letters, on average and at its most, for it to read as behind. */
const nothingInFront = (c: BehindCheck) => c.wordCover !== undefined && c.wordCover < BEHIND_LIMITS.wordCover && (c.wordCoverPeak ?? 0) < BEHIND_LIMITS.wordCoverPeak;
/** TASTE1: the share of the word's own ink (0..1 per box pixel) that person pixels cover, per frame: the mean over the
 * frames and their 90th percentile. Null when the word has no ink in the box. Pure. */
export function measureInkCover(frames: Buffer[], ink: Float32Array): { wordCover: number; wordCoverPeak: number } | null {
  let total = 0;
  for (let i = 0; i < ink.length; i++) total += ink[i];
  if (!(total > 0) || !frames.length) return null;
  const shares = frames.map(p => { let c = 0; for (let i = 0; i < ink.length; i++) if (ink[i] && p[i] >= 128) c += ink[i]; return c / total; });
  const sorted = [...shares].sort((a, b) => a - b), round = (n: number) => Math.round(n * 1000) / 1000;
  return { wordCover: round(shares.reduce((a, b) => a + b, 0) / shares.length), wordCoverPeak: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]) };
}
/** TASTE1: the word's ink in the box (0..1 per box pixel): the settled word (its poster, the finished state; a word too
 * short for its poster to be settled is drawn at its end), transparent, at its design shape, laid where the title page
 * lays the item (centred on x, y, w wide), then cut to the box. */
const KEY_WORD_SETTLED_S = 0.32;   // keyWordGraphic's fly-in
async function wordInk(root: string, item: Overlay, full: { left: number; top: number; w: number; h: number }, box: { x: number; y: number; w: number; h: number }): Promise<Float32Array | null> {
  const { nativeImage } = await import('electron');
  const g = item.graphic!, file = item.file, poster = file && path.basename(file) === file && /\.png$/i.test(file) ? path.join(root, '.sidething', 'overlays', file) : null;
  let image = poster && g.durationS - 0.6 >= KEY_WORD_SETTLED_S ? nativeImage.createFromPath(poster) : null;
  if (!image || image.isEmpty()) {
    const { renderGraphicStills } = await import('../graphics/render');
    image = nativeImage.createFromBuffer((await renderGraphicStills(g, [g.durationS], { maxWidth: 640, root }))[0]);
  }
  const sw = Math.max(2, Math.round(full.w)), sh = Math.max(2, Math.round(full.h));
  const bitmap = image.resize({ width: sw, height: sh, quality: 'best' }).toBitmap();
  if (bitmap.length !== sw * sh * 4) return null;
  const ink = new Float32Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    const sy = Math.floor(box.y + y + 0.5 - full.top);
    if (sy < 0 || sy >= sh) continue;
    for (let x = 0; x < box.w; x++) {
      const sx = Math.floor(box.x + x + 0.5 - full.left);
      if (sx >= 0 && sx < sw) ink[y * box.w + x] = bitmap[(sy * sw + sx) * 4 + 3] / 255;   // BGRA: alpha is the fourth byte
    }
  }
  return ink;
}
/** One gray picture stream from ffmpeg (stdout raw gray8), cancelled with the activity. */
async function ffmpegGray(args: string[]): Promise<Buffer> {
  const signal = currentActivity()?.signal;
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let stderr = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => { signal?.removeEventListener('abort', abort); if (code === 0) resolve(Buffer.concat(chunks)); else reject(new Error(`Reading the person matte failed: ${stderr}`)); });
  });
}
/** Person pixels (0..255) of matte frames first..first+count-1, cropped to box (output pixels). */
async function matteCrop(root: string, matte: PersonMatte, first: number, count: number, box: { x: number; y: number; w: number; h: number }): Promise<Buffer[]> {
  const bytes = await ffmpegGray(['-start_number', String(first + 1), '-i', path.join(matteFolder(root, matte), '%06d.png'),
    '-frames:v', String(count), '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y},alphaextract,negate`]);
  const size = box.w * box.h, frames: Buffer[] = [];
  for (let at = 0; at + size <= bytes.length; at += size) frames.push(bytes.subarray(at, at + size));
  return frames;
}

type Stored = import('../sidekick').StoredVersion;
type Overlay = NonNullable<Stored['overlays']>[number];
const wantsBehind = (o: Overlay) => !!o.graphic && o.graphic.frame === 'overlay' && (o.graphic.layer === 'behind' || !!o.graphic.behindNote);

/** PRO5: after every saved change (finishStoredVersion), each graphic asked to sit behind the person is checked on the
 * frames it covers, now: the person mattes for its pictures are made (cached), its outline measured inside its box, and
 * it goes behind (its mattes ride on the caption track, which the viewer and the export both draw through) or in front
 * with a plain reason. A word he switched to front by hand stays his choice. Never throws: a word that can't be checked
 * goes in front and says so. */
export async function holdBehindWords(root: string, record: Stored, assembly: Stored['assembly'], previous?: Stored): Promise<void> {
  const track = record.titles as (Omit<import('./captions').CaptionTrack, 'personMattes'> & { personMattes?: WordMatte[] }) | null | undefined;
  // A rebuilt graphic (a new length, a new design) loses the fields the sanitiser doesn't know: carry them while its layer stays.
  for (const item of record.overlays ?? []) {
    const was = previous?.overlays?.find(o => o.id === item.id)?.graphic;
    if (item.graphic && was && was.layer === item.graphic.layer && item.graphic.behindNote === undefined && was.behindNote)
      item.graphic = { ...item.graphic, behindNote: was.behindNote, ...(was.behindCheck ? { behindCheck: was.behindCheck } : {}) };
  }
  const items = (record.overlays ?? []).filter(wantsBehind);
  const ownMattes = track?.personMattes?.filter(m => m.behindWord) ?? [];
  if (!items.length && !ownMattes.length) return;
  if (track?.personMattes) track.personMattes = track.personMattes.filter(m => !m.behindWord);
  const decide = (item: Overlay, note: string | null, check?: BehindCheck) => {
    const g = { ...item.graphic! };
    if (note) { g.layer = 'front'; g.behindNote = note; } else { g.layer = 'behind'; delete g.behindNote; }
    if (check) g.behindCheck = check; else delete g.behindCheck;
    record.overlays = record.overlays!.map(o => o.id === item.id ? { ...o, graphic: g } : o);
  };
  if (!items.length) return;
  if (!track) { for (const item of items) decide(item, BEHIND_NOTES.captions); return; }
  // Behind titles that aren't kinetic captions use the export's own masking pass, which doesn't carry these mattes.
  if (track.cues.some(c => c.layer === 'behind' && !c.id.startsWith('kinetic-'))) { for (const item of items) decide(item, BEHIND_NOTES.titles); return; }
  const { planFx } = await import('../edits-fx');
  const { cutFraming } = await import('../preview');
  const { getPreferences } = await import('../settings');
  const { cutList, template, shoot } = assembly;
  const short = (await getPreferences()).output.height, scale = Math.min(1, short / Math.min(template.width, template.height));
  const frame = { width: Math.round(template.width * scale / 2) * 2, height: Math.round(template.height * scale / 2) * 2, fps: template.fps };
  const timing = planFx(cutList, template.fps, record);
  const plans = cutFraming(cutList, template.fps, { w: frame.width, h: frame.height }, record.energy ?? 'subtle', record.faceMatch);
  const pxScale = 1080 / Math.min(frame.width, frame.height);
  const added: WordMatte[] = [];
  for (const item of items) {
    try {
      const s = item.s, e = item.e;
      // Where precut can't keep a matte on the picture: a transition or a speed change (the viewer's own rule for
      // kinetic captions), a layout, other footage on top, or a zoom on the clip itself.
      const near = (t: number) => t > s - 0.5 && t < e + 0.5;
      if (timing.joins.some(j => j.choice.kind !== 'cut' && near(j.atS))) { decide(item, BEHIND_NOTES.moving); continue; }
      const under = timing.items.map((p, k) => ({ p, k })).filter(({ p }) => p.startS < e - 1e-6 && p.endS > s + 1e-6);
      if (!under.length) { decide(item, BEHIND_NOTES.nobody); continue; }
      if (under.some(({ p }) => p.reverse || p.timeMap.length > 2)) { decide(item, BEHIND_NOTES.moving); continue; }
      const piece = (k: number) => record.pieces?.[cutList[k].piece ?? k];
      if (under.some(({ k }) => {
        const p = piece(k), at = timing.items[k], layout = record.layouts?.[cutList[k].piece ?? k];
        const overlayEnd = p?.overlay ? at.startS + p.overlay.e - p.overlay.s : -Infinity;
        return !cutList[k].seg || (layout && layout.kind !== 'face') || (!!p?.overlay && at.startS < e && overlayEnd > s);
      })) { decide(item, BEHIND_NOTES.picture); continue; }
      if (under.some(({ k }) => { const fx = record.pieceFx?.[cutList[k].piece ?? k]; return !!fx?.punches?.length || !!(fx?.transform && Object.keys(fx.transform).length); })) { decide(item, BEHIND_NOTES.zoom); continue; }
      const mattes: WordMatte[] = [];
      for (const { p, k } of under) {
        const c = cutList[k], fps = c.clipFpsR.num / c.clipFpsR.den;
        const span = { s: c.inFrames / fps, e: c.outFrames / fps, timelineS: p.startS, lengthS: p.endS - p.startS };
        const clip = shoot.clips.find(x => x.id === c.seg!.clip.id) ?? c.seg!.clip;
        mattes.push({ ...await preparePersonMatte(root, clip, span, frame, plans[k]!, true), behindWord: true });
      }
      // The word's box, as the title page lays it out (overlayLayout), clipped to the frame.
      const W = frame.width, H = frame.height, bw = item.w * W, bh = bw / (item.graphic!.widthPx / item.graphic!.heightPx);
      const x0 = Math.max(0, Math.floor(item.x * W - bw / 2)), y0 = Math.max(0, Math.floor(item.y * H - bh / 2));
      const box = { x: x0, y: y0, w: Math.max(2, Math.min(W, Math.ceil(item.x * W + bw / 2)) - x0), h: Math.max(2, Math.min(H, Math.ceil(item.y * H + bh / 2)) - y0) };
      const key = createHash('sha256').update(JSON.stringify(['pro5-v1', BEHIND_LIMITS, mattes.map(m => [m.frames[0], m.s, m.e]), box, s, e, item.file])).digest('hex').slice(0, 24);
      let check = item.graphic!.behindCheck?.key === key ? item.graphic!.behindCheck : undefined;
      if (!check) {
        const frames: Buffer[] = [];
        for (const m of mattes) {
          const first = Math.max(0, Math.floor((Math.max(s, m.s) - m.s) * m.fps + 1e-7)), last = Math.min(m.frames.length, Math.ceil((Math.min(e, m.e) - m.s) * m.fps - 1e-7));
          if (last > first) frames.push(...await matteCrop(root, m, first, last - first, box));
        }
        if (!frames.length) { decide(item, BEHIND_NOTES.unavailable); continue; }
        // TASTE1: how much of the word's own letters he covers (a word whose letters can't be read is judged by its box alone).
        const ink = await wordInk(root, item, { left: item.x * W - bw / 2, top: item.y * H - bh / 2, w: bw, h: bh }, box).catch(() => null);
        check = { key, ok: false, ...measureOutline(frames, box.w, box.h, pxScale), ...(ink ? measureInkCover(frames, ink) ?? {} : {}), mattes: mattes.map(m => path.basename(matteFolder(root, m))) };
        check.ok = check.edgePx >= BEHIND_LIMITS.edgePx && check.cover <= BEHIND_LIMITS.cover && check.bandPx <= BEHIND_LIMITS.bandPx && check.flickerPx <= BEHIND_LIMITS.flickerPx
          && !nothingInFront(check);
      }
      // Nothing in front of the word is the plainest reason: the outline's quality doesn't show where he never crosses it.
      const note = check.ok ? null : check.edgePx < BEHIND_LIMITS.edgePx ? BEHIND_NOTES.nobody : check.cover > BEHIND_LIMITS.cover ? BEHIND_NOTES.covered
        : nothingInFront(check) ? BEHIND_NOTES.clear : check.bandPx > BEHIND_LIMITS.bandPx ? BEHIND_NOTES.outline : BEHIND_NOTES.flicker;
      decide(item, note, check);
      if (!note) for (const m of mattes) if (!added.some(a => a.frames[0] === m.frames[0])) added.push(m);
    } catch (error) {
      currentActivity()?.signal.throwIfAborted();
      decide(item, BEHIND_NOTES.unavailable);
    }
  }
  // Ours go last: the title page uses the last matte that covers a moment, and these are cut for that picture.
  if (added.length) track.personMattes = [...(track.personMattes ?? []), ...added];
}

/** PRO5: the house key word: one big word that flies in (0.12 s from 1.3x, transparent) and lands at 1.06, settling
 * to 1 over 0.2 s, then holds and cuts out with the item. The edit's caption font and colour; no blur, glow, shadow,
 * outline or stroke. `accent` draws it in the edit's accent colour instead. */
export function keyWordGraphic(text: string, theme: { font?: string; ink?: string; accent?: string }, options: { durationS: number; accent?: boolean; layer?: 'front' | 'behind'; words?: import('../../shared/schema').MotionGraphic['words'] }): import('../../shared/schema').MotionGraphic {
  const word = text.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!word) throw new Error('Give the word to show.');
  const safe = word.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  const colour = (c: string | undefined, fallback: string) => c && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback;
  const family = (theme.font ?? 'Outfit').replace(/[^\w ]/g, '');
  const widthPx = 1600, heightPx = 560, size = Math.round(Math.max(150, Math.min(440, 1480 / Math.max(1, word.length * 0.58))));
  return {
    html: `<div class="w">${safe}</div>`,
    css: `#gfx{font-family:"${family}","Outfit",sans-serif;-webkit-font-smoothing:antialiased}`
      + `.w{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;white-space:nowrap;font-weight:800;letter-spacing:-.02em;line-height:1;`
      + `font-size:${size}px;color:${options.accent ? colour(theme.accent, '#F7C204') : colour(theme.ink, '#ffffff')};transform-origin:50% 55%;animation:fly .32s linear both}`
      + `@keyframes fly{0%{opacity:0;transform:scale(1.3)}37.5%{opacity:1;transform:scale(1.06);animation-timing-function:cubic-bezier(.33,1,.68,1)}100%{opacity:1;transform:scale(1)}}`,
    widthPx, heightPx, durationS: Math.max(0.4, Math.min(60, Math.round(options.durationS * 1000) / 1000)), frame: 'overlay', template: 'key-word',
    ...(options.layer === 'behind' ? { layer: 'behind' as const } : {}), ...(options.words?.length ? { words: options.words } : {}),
  };
}
