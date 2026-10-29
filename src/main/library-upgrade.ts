// Opening old footage may measure library prints, never judge or transcribe it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Shoot } from '../shared/schema';
import { runActivity, withRenderSlot } from './activity';
import { toolEnvironment } from './tools';
import { withShootWriter } from './writer-lock';

export const SORTING_FOOTAGE = 'Sorting your footage into places and shots';
const pending = new Map<string, Promise<void>>(), attempted = new Set<string>();
export function libraryUpgradePending(root: string): Promise<void> | undefined { return pending.get(root); }
export function scheduleLibraryUpgrade(shoot: Shoot, deps: { python: string; file: (name: string) => string; changed: () => void }): void {
  // Metadata-free import stubs have nothing to migrate yet.
  if (!shoot.clips.some(c => c.meta && c.meta.width > 0 && c.meta.height > 0) || !fs.existsSync(deps.python)) return;
  const revision = createHash('sha256').update(['library_upgrade.py', 'quality.py', 'quality.swift', 'place.py', 'place.swift']
    .map(name => fs.readFileSync(deps.file(name))).join('\n')).digest('hex');
  const cache = (shoot as Shoot & { _cache?: { libraryUpgrade?: string; libraryPrints?: Record<string, unknown> } })._cache;
  const available = shoot.clips.filter(c => c.meta && !c.leftOut && fs.existsSync(path.join(shoot.root, c.photo?.file ?? c.file)));
  if (cache?.libraryUpgrade === revision && available.every(c => cache.libraryPrints?.[c.id] && '_placeRead' in c)) return;
  const key = `${shoot.root}:${revision}:${available.map(c => c.id).join(',')}`;
  if (attempted.has(key) || pending.has(shoot.root)) return;
  const work = withShootWriter(shoot.root, () => {
    attempted.add(key);
    return runActivity({ kind: 'process', root: shoot.root, target: null, label: SORTING_FOOTAGE, cancelable: true }, activity =>
    withRenderSlot(activity, () => new Promise<void>((resolve, reject) => {
      const child = spawn(deps.python, ['-I', '-B', deps.file('library_upgrade.py'), shoot.root, revision],
        { env: toolEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
      const abort = () => child.kill('SIGTERM');
      activity.signal.addEventListener('abort', abort, { once: true });
      createInterface({ input: child.stdout }).on('line', line => {
        try { const row = JSON.parse(line); activity.progress(row.pct, SORTING_FOOTAGE, row.etaS); deps.changed(); } catch { /* tool diagnostic */ }
      });
      child.stderr.on('data', () => { /* Drain tool diagnostics; the UI uses a short failure line. */ });
      child.once('error', reject);
      child.once('close', code => { activity.signal.removeEventListener('abort', abort); code === 0 ? resolve() : reject(new Error('Could not finish sorting your footage. Restart precut to retry.')); });
    }), 'background'), { renderLane: 'background' });
  })
    .catch(error => { console.error('[library upgrade]', error); })
    .finally(() => { pending.delete(shoot.root); deps.changed(); });
  pending.set(shoot.root, work);
}
