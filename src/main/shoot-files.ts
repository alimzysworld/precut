// Listing receipts match process.py. This check never decodes or schedules work.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Shoot, FolderChanges } from '../shared/schema';
import { discoverMedia } from './media-scan';

type Receipt = { size: number; mtime: number };
type Cache = { clips?: Record<string, Receipt>; audio?: Record<string, Receipt> };
export function folderChanges(root: string, shoot: Shoot, exportFolder?: string | null): FolderChanges {
  const listing = discoverMedia(root, exportFolder), cache = (shoot as Shoot & { _cache?: Cache })._cache;
  const clips = new Map(shoot.clips.map(c => [c.photo?.file ?? c.file, c]));
  const audio = new Map(shoot.audio.filter(a => !/^(sidething precuts|\.sidething)\/recordings\//.test(a.file)).map(a => [a.file, a]));
  const changed = (file: string, receipt?: Receipt) => {
    try { const stat = fs.statSync(path.join(root, file)); return receipt ? receipt.size !== stat.size || Math.abs(receipt.mtime * 1000 - stat.mtimeMs) > 1 : false; }
    catch { return true; }
  };
  const resized = (clip: Shoot['clips'][number]) => {
    if (clip.photo || !clip.meta?.sizeBytes) return false;
    try { return fs.statSync(path.join(root, clip.file)).size !== clip.meta.sizeBytes; } catch { return false; }
  };
  return {
    missingClipIds: shoot.clips.filter(c => !fs.existsSync(path.join(root, c.photo?.file ?? c.file))).map(c => c.id),
    newFiles: listing.clips.filter(file => !clips.has(file)),
    // A video read at one size and now another changed too, even under a receipt an older retry restamped.
    changedFiles: listing.clips.filter(file => clips.has(file) && (changed(file, cache?.clips?.[clips.get(file)!.id]) || resized(clips.get(file)!))),
    newAudio: listing.audio.filter(file => !audio.has(file) || changed(file, cache?.audio?.[file])),
    missingAudio: [...audio.keys()].filter(file => !fs.existsSync(path.join(root, file))),
  };
}
export function shootFilesChanged(root: string, shoot: Shoot, exportFolder?: string | null): boolean {
  return Object.values(folderChanges(root, shoot, exportFolder)).some(files => files.length > 0);
}
/** V3 retains cards, takes, cached reads and proxy links, including absent originals. */
export function withoutMissingFiles(root: string, shoot: Shoot): Shoot {
  const changes = folderChanges(root, shoot), missing = new Set(changes.missingClipIds);
  return { ...shoot, folderChanges: changes, clips: shoot.clips.map(c => ({ ...c, missing: missing.has(c.id) })) };
}
export function shootFilesStamp(root: string, exportFolder?: string | null): string {
  const listing = discoverMedia(root, exportFolder);
  return JSON.stringify([...listing.clips, ...listing.audio].map(file => {
    try { const stat = fs.statSync(path.join(root, file)); return [file, stat.size, stat.mtimeMs]; }
    catch { return [file, null]; }
  }));
}
