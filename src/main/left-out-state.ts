import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Shoot } from '../shared/schema';
export const leftOutFile = (root: string) => path.join(root, '.sidething/left-out.json');
function apply(shoot: Shoot, value: unknown): Shoot {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new Error('Could not read your left-out clips. Your choices have been kept.');
  const ids = new Set(value);
  return { ...shoot, clips: shoot.clips.map(clip => { const { leftOut: _old, ...rest } = clip; return ids.has(clip.id) ? { ...rest, leftOut: true } : rest; }) };
}
export async function mergeLeftOut(shoot: Shoot): Promise<Shoot> {
  if (typeof shoot.root !== 'string' || !shoot.root) return shoot;
  let value: unknown;
  try { value = JSON.parse(await fs.promises.readFile(leftOutFile(shoot.root), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return shoot; }
  return apply(shoot, value);
}
export function mergeLeftOutSync(shoot: Shoot): Shoot {
  // Export metadata also projects an in-memory shoot with no disk location.
  if (typeof shoot.root !== 'string' || !shoot.root) return shoot;
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(leftOutFile(shoot.root), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return shoot; }
  return apply(shoot, value);
}
