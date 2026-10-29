import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';
import type { DraftPiece } from '../shared/schema';
import type { CutItem } from './export';
import { fxSetpts, type FxPlan, type FxItem } from './edits-fx';
import { runActivity, currentActivity, threads } from './activity';
import { tool } from './tools';

/** Reverse before retiming, for both the proxy and the original compositor. */
export function reverseVideoFilter(item?: FxItem): string {
  return item?.reverse ? 'reverse,setpts=PTS-STARTPTS,' : '';
}
const pending = new Map<string, Promise<string>>();
const retryAfter = new Map<string, number>();
async function fingerprint(file: string) {
  const stat = await fs.stat(file);
  return [await fs.realpath(file), stat.size, stat.mtimeMs, stat.ctimeMs];
}
export async function reverseIdentity(root: string, cut: CutItem, item: FxItem, fps: number) {
  if (!cut.seg?.clip.proxy) throw new Error('The clip preview is not ready.');
  const directory = path.resolve(root, '.sidething', 'proxies');
  const source = path.resolve(directory, cut.seg.clip.proxy);
  if (!source.startsWith(directory + path.sep) || !(await fs.realpath(source)).startsWith(await fs.realpath(directory) + path.sep)) throw new Error('Preview outside cache.');
  const key = createHash('sha256').update(JSON.stringify({ revision: 1, clip: cut.seg.clip.id,
    source: await fingerprint(source), start: item.timeMap[0].s, end: item.timeMap.at(-1)!.s,
    timing: item.timeMap.map(k => ({ t: k.t - item.startS, s: k.s })), fps })).digest('hex');
  return { source, file: path.join(directory, `reverse-${key}.mp4`) };
}
async function cached(file: string): Promise<boolean> {
  try {
    return JSON.stringify(JSON.parse(await fs.readFile(`${file}.json`, 'utf8')).output) === JSON.stringify(await fingerprint(file)) && (await fs.stat(file)).size > 0;
  } catch { return false; }
}
function encode(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = currentActivity()?.signal;
    signal?.throwIfAborted();
    const child = spawn(tool('ffmpeg'), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    const abort = () => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', data => { errorText = (errorText + data).slice(-4000); });
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`Could not reverse this clip: ${errorText}`));
    });
  });
}
export async function renderReverse(root: string, cut: CutItem, item: FxItem, fps: number,
  target: { cutId: string; version: number }): Promise<string> {
  const identity = await reverseIdentity(root, cut, item, fps);
  if (await cached(identity.file)) return identity.file;
  const existing = pending.get(identity.file);
  if (existing) return existing;
  const work = runActivity({ kind: 'render', root, target: { ...target, clipId: cut.seg!.clip.id },
    label: 'Reversing clip', cancelable: true }, async () => {
    if (await cached(identity.file)) return identity.file;
    const temporary = `${identity.file}.${randomUUID()}.tmp.mp4`;
    const receipt = `${identity.file}.json`, tempReceipt = `${receipt}.${randomUUID()}.tmp`;
    try {
      const start = item.timeMap[0].s, length = item.timeMap.at(-1)!.s - start;
      await encode(['-v', 'error', '-nostdin', '-y', '-threads', String(threads(2)), '-ss', `${start}`, '-t', `${length}`, '-i', identity.source,
        '-map', '0:v:0', '-an', '-vf', `trim=duration=${length},setpts=PTS-STARTPTS,${reverseVideoFilter(item)}${fxSetpts(item)},fps=${fps}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-threads', String(threads(2)), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temporary]);
      currentActivity()?.signal.throwIfAborted();
      await fs.rename(temporary, identity.file);
      await fs.writeFile(tempReceipt, JSON.stringify({ output: await fingerprint(identity.file) }));
      await fs.rename(tempReceipt, receipt);
      return identity.file;
    } finally {
      await fs.rm(temporary, { force: true }); await fs.rm(tempReceipt, { force: true });
    }
  }, { renderLane: 'background' });
  pending.set(identity.file, work);
  try { return await work; }
  finally { if (pending.get(identity.file) === work) pending.delete(identity.file); }
}
function changed(root: string) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    try { win.webContents.send('api:sidekick-changed', root); } catch { /* Closing window. */ }
  }
}
/** A cache miss returns forward pictures immediately, then refreshes the draft. */
export async function reverseDraftPictures(root: string, cutId: string, version: number, cuts: CutItem[],
  plan: FxPlan, fps: number, pictures: DraftPiece[], forwards: DraftPiece[]): Promise<DraftPiece[]> {
  const result = [...pictures];
  for (const [i, item] of plan.items.entries()) {
    if (!item.reverse || !cuts[i].seg) continue;
    const indexes = pictures.flatMap((p,n) => p.clipId === cuts[i].seg!.clip.id && p.piece === item.piece && Math.abs(p.startS-item.startS)<1e-6 && !(p as import('./layout-math').LayoutPicture).layoutScreen ? [n] : []);
    if (!indexes.length) continue;
    const { file } = await reverseIdentity(root, cuts[i], item, fps);
    if (await cached(file)) {
      for (const n of indexes) result[n] = { ...pictures[n], proxy: `st-media://local/${encodeURIComponent(root)}/proxies/${encodeURIComponent(path.basename(file))}`,
        inS: 0, timeMap: [{ t: item.startS, s: 0 }, { t: item.endS, s: item.endS - item.startS }] };
    } else {
      for (const n of indexes) result[n] = { ...forwards[n], lut: pictures[n].lut };
      if (!pending.has(file) && Date.now() >= (retryAfter.get(file) ?? 0)) {
        retryAfter.set(file, Date.now() + 30_000);
        setImmediate(() => { void renderReverse(root, cuts[i], item, fps, { cutId, version }).then(() => {
          retryAfter.delete(file); changed(root);
        }, error => {
          retryAfter.set(file, Date.now() + 30_000);
          console.warn('Could not reverse clip:', error instanceof Error ? error.message : error); changed(root);
        }); });
      }
    }
  }
  return result;
}
