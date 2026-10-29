import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from './tools';
import { currentActivity, withRenderSlot } from './activity';

/** Relink verifies bytes and, when the timestamp differs, duration. Never decodes. */
export async function verifyRelinkFile(file: string, size: number, mtime?: number, durationS?: number): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size !== size) return false;
  if (mtime !== undefined && Math.abs(stat.mtimeMs - mtime * 1000) <= 1) return true;
  if (durationS === undefined) return true;
  const probe = async () => {
    try {
      const { stdout } = await promisify(execFile)(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 5000, maxBuffer: 4096, signal: currentActivity()?.signal });
      const value = Number(stdout.trim());
      return !!stdout.trim() && Number.isFinite(value) && Math.abs(value - durationS) <= .1;
    } catch { return false; }
  };
  const activity = currentActivity();
  return activity ? withRenderSlot(activity, probe, 'background') : probe();
}
