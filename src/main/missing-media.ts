// Explicit folder actions. Listing changes alone never enter the work queue.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BrowserWindow } from 'electron';
import type { Shoot } from '../shared/schema';
import { folderChanges } from './shoot-files';
import { leaveOut } from './left-out';
import { writeJsonAtomic } from './cut-storage';
import { getPreferences } from './settings';
import { enqueueNewFiles, enqueueQuietRead, isShootProcessing, loadShoot, relinkShoot } from './jobs';
import { establishedShoot } from './source-changes';

async function read(root: string): Promise<Shoot> {
  return { ...JSON.parse(await fs.readFile(path.join(root, '.sidething/index.json'), 'utf8')), root };
}
export async function rethinkWithoutMissing(root: string): Promise<Shoot> {
  root = path.resolve(root);
  const shoot = await read(root), changes = folderChanges(root, shoot);
  const ids = changes.missingClipIds.filter(id => !shoot.clips.find(c => c.id === id)?.leftOut);
  if (ids.length) await leaveOut(root, ids, true);
  return (await loadShoot(root))!;
}
// A shoot with ideas or edits reads them quietly in the background (jobs.readQuietly): no waiting
// room, no re-checked takes, no new ideas or edits. Pressing Add while it reads adds to that read.
export async function addNewFiles(root: string): Promise<Shoot> {
  root = path.resolve(root);
  const quiet = await establishedShoot(root);
  if (isShootProcessing(root) && !quiet) throw new Error('Wait for this shoot to finish before adding clips.');
  const shoot = await read(root), changes = folderChanges(root, shoot, (await getPreferences()).output?.exportFolder);
  const files = [...changes.newFiles, ...changes.changedFiles, ...changes.newAudio];
  if (files.length) {
    const request = path.join(root, '.sidething/add-files.json'), reread = path.join(root, '.sidething/reread.json');
    const list = async (file: string) => { try { const value = JSON.parse(await fs.readFile(file, 'utf8')); return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : []; } catch { return []; } };
    // A changed clip is read fresh even when an older retry restamped its receipt.
    if (changes.changedFiles.length) await writeJsonAtomic(reread, [...new Set([...await list(reread), ...changes.changedFiles])]);
    await writeJsonAtomic(request, [...new Set([...(isShootProcessing(root) ? await list(request) : []), ...files])]);
    if (quiet) enqueueQuietRead(root); else enqueueNewFiles(root);
  }
  return (await loadShoot(root))!;
}
/** Reuse the library's verified folder relink, including cached edits and reads. */
export async function relinkMissing(root: string, folder: string) {
  return relinkShoot(root, folder);
}

// EXP3: a clip renamed, moved or deleted under the open shoot shows within seconds, without a tab switch. The shoot on
// screen (the window's link names it) has its clips' originals looked at every two seconds, by stat alone. When the set
// that is missing changes, the page reloads the shoot as it does for any step change, so the banner and the timeline's
// Missing marks follow, and clear once the files are back. A drive that went away entirely is not this: it is skipped.
type Watched = { root: string; stamp: string; readAt: number; files: string[]; missing: string | null; away?: boolean };
let watched: Watched | null = null, watchTimer: ReturnType<typeof setInterval> | undefined, ticking = false;
function shootOnScreen(): string | null {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      const hash = new URL(win.webContents.getURL()).hash;
      const shoot = new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('shoot');
      if (hash.includes('?') && shoot) return shoot;
    } catch { /* not loaded yet */ }
  }
  return null;
}
async function lookForMissing(): Promise<void> {
  const root = shootOnScreen();
  if (!root) { watched = null; return; }
  const index = path.join(root, '.sidething/index.json');
  const stat = await fs.stat(index).catch(() => null);
  // The whole drive went (not a missing clip). When it is back, the page reads the shoot and its edits again: an edit
  // list read while it was away came back empty.
  if (!stat) { if (watched?.root === root) watched.away = true; return; }
  if (watched?.root === root && watched.away) { watched.away = false; announce(root, true); }
  const stamp = `${stat.size}:${stat.mtimeMs}`, now = Date.now();
  // The clip list is read when the shoot changes, then at most every ten seconds while its index is being rewritten.
  if (watched?.root !== root || (watched.stamp !== stamp && now - watched.readAt > 10_000)) {
    const shoot = await read(root).catch(() => null);
    if (!shoot) return;
    const files = shoot.clips.filter(c => !c.leftOut).map(c => c.photo?.file ?? c.file);
    watched = { root, stamp, readAt: now, files, missing: watched?.root === root ? watched.missing : null };
  }
  const gone = (await Promise.all(watched.files.map(file => fs.access(path.join(root, file)).then(() => null, () => file)))).filter(Boolean);
  if (!await fs.access(root).then(() => true, () => false)) { watched.away = true; return; }  // the whole drive went: not a missing clip
  const missing = gone.sort().join('\n');
  const changed = watched.missing !== null && watched.missing !== missing;
  watched.missing = missing;
  if (changed) announce(root, false);
}
function announce(root: string, edits: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try { win.webContents.send('api:steps-changed', root); if (edits) win.webContents.send('api:sidekick-changed', root); } catch { /* closing */ }
    }
  }
}
/** Start looking (index.ts, at launch). Returns a stop for tests. */
export function watchMissingMedia(everyMs = 2000): () => void {
  if (!watchTimer) {
    watchTimer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void lookForMissing().catch(() => {}).finally(() => { ticking = false; });
    }, everyMs);
    watchTimer.unref?.();
  }
  return () => { clearInterval(watchTimer); watchTimer = undefined; watched = null; };
}
