// A separate choice file survives every pipeline index rewrite. Never touch reads or originals.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Shoot } from '../shared/schema';
import { writeJsonAtomic } from './cut-storage';

import { leftOutFile, mergeLeftOut } from './left-out-state';
export { mergeLeftOut } from './left-out-state';
const writers = new Map<string, Promise<unknown>>();
let schedule: ((root: string) => void) | null = null;
/** The job runner owns execution; the store stays independent of media/model modules. */
export function setRethinkScheduler(fn: (root: string) => void): void { schedule = fn; }
export function leaveOut(root: string, clipIds: string[], out: boolean): Promise<Shoot> {
  root = path.resolve(root);
  if (!Array.isArray(clipIds) || !clipIds.length || clipIds.some(id => typeof id !== 'string') || typeof out !== 'boolean') return Promise.reject(new Error('Choose the clips to leave out or put back.'));
  const task = (writers.get(root) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const shoot = await mergeLeftOut({ ...JSON.parse(await fs.readFile(path.join(root, '.sidething/index.json'), 'utf8')), root } as Shoot);
    if (clipIds.some(id => !shoot.clips.some(c => c.id === id))) throw new Error('One of these clips is no longer in this shoot.');
    const ids = new Set(shoot.clips.filter(c => c.leftOut).map(c => c.id));
    let changed = false;
    for (const id of new Set(clipIds)) { if (ids.has(id) !== out) changed = true; if (out) ids.add(id); else ids.delete(id); }
    if (changed) {
      await writeJsonAtomic(leftOutFile(root), [...ids].sort(), undefined, 2);
      await writeJsonAtomic(path.join(root, ".sidething/rethink.json"), { revision: randomUUID() });
      // The normal shoot queue owns the model work, including changes made during a read.
      schedule?.(root);
    }
    return mergeLeftOut(shoot);
  });
  writers.set(root, task);
  void task.finally(() => { if (writers.get(root) === task) writers.delete(root); }).catch(() => {});
  return task;
}
