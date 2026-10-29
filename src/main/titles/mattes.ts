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
export async function preparePersonMatte(root: string, clip: Clip, span: { s: number; e: number; timelineS: number; lengthS: number },
  frame: { width: number; height: number; fps: number }, plan: CutFraming): Promise<PersonMatte> {
  return runActivity({ kind: 'render', root, target: null, label: 'Measuring person for captions', cancelable: true }, async () => {
    const source = await fs.stat(path.resolve(root, clip.file));
    const script = await resource('pipeline/matte.py'), swift = await resource('pipeline/matte.swift');
    const key = createHash('sha256').update(JSON.stringify(['j1-matte-v2', clip.file, source.size, source.mtimeMs, clipRotation(clip), span, frame, plan,
      await fs.readFile(script, 'utf8'), await fs.readFile(swift, 'utf8')])).digest('hex');
    const directory = path.join(root, '.sidething', 'finish-cache'), folder = path.join(directory, `person-${key}`);
    const count = Math.ceil(span.lengthS * frame.fps - 1e-7);
    const result = { s: span.timelineS, e: span.timelineS + span.lengthS, fps: frame.fps,
      frames: Array.from({ length: count }, (_, i) => `st-media://local/${encodeURIComponent(path.resolve(root))}/finish-cache/${path.basename(folder)}/${String(i + 1).padStart(6, '0')}.png`) };
    try { if ((await fs.readdir(folder)).length === count) return result; } catch { /* measure once */ }
    await fs.mkdir(directory, { recursive: true });
    const raw = path.join(root, '.sidething', 'mattes', `j1-${key}.mkv`), temporary = `${folder}.${randomUUID()}.tmp`;
    await fs.mkdir(temporary);
    try {
      const native = clipFileDimensions(clip);
      await processLocal(tool('python3'), ['-I', script, root, '--clip', clip.id, '--s', String(span.s), '--e', String(span.e),
        '--fps', String(frame.fps), '--size', `${native.width}x${native.height}`, '--out', raw]);
      const out = { w: frame.width, h: frame.height }, ratio = span.lengthS / (span.e - span.s);
      const framing = plan.crop || plan.rects ? previewFraming(clip, span.s, span.e, out, 'source', 'framed', 'off', undefined, frame.fps, undefined, plan)
        : [`[source]scale=${out.w}:${out.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${out.w}:${out.h}:(ow-iw)/2:(oh-ih)/2:black[framed]`];
      await processLocal(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', raw, '-filter_complex',
        [`[0:v]${clipRotationFilter(clip)}setpts=${ratio}*(PTS-STARTPTS),fps=${frame.fps}[source]`, ...framing, "[framed]format=rgba,geq=r=255:g=255:b=255:a='255-r(X,Y)'[mask]"].join(';'),
        '-map', '[mask]', '-an', '-frames:v', String(count), '-c:v', 'png', path.join(temporary, '%06d.png')]);
      if ((await fs.readdir(temporary)).length !== count) throw new Error('The person matte has missing frames.');
      await fs.rm(folder, { recursive: true, force: true });
      await fs.rename(temporary, folder);
      return result;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }, { renderLane: 'background' });
}
