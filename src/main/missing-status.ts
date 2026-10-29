import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Shoot, ProcessingStage, ProcessingStageId } from '../shared/schema';

export function markMissing(shoot: Shoot): Shoot {
  return { ...shoot, clips: shoot.clips.map(c => ({ ...c,
    missing: !fs.existsSync(path.join(shoot.root, c.photo?.file ?? c.file)) })) };
}
/** Suppress only errors whose identified sources are all absent. Keep unknown
 * failures visible, and leave the durable checkpoint intact for relinking. */
export function withoutMissingErrors<T extends ProcessingStage>(root: string, shoot: Shoot,
  stages: Partial<Record<ProcessingStageId, T>>): Partial<Record<ProcessingStageId, T>> {
  const missing = new Set(markMissing({ ...shoot, root }).clips.filter(c => c.missing).map(c => c.id));
  return Object.fromEntries(Object.entries(stages).filter(([id, stage]) => {
    if (!stage || stage.state !== 'failed' || !stage.detail) return true;
    const named = shoot.clips.filter(c => stage.detail!.includes(c.id) || stage.detail!.includes(c.file));
    if (named.length) return !named.every(c => missing.has(c.id));
    if (id === 'transcribe') {
      const failed = shoot.clips.filter(c => c.stage === 'error' && c.error === stage.detail);
      if (failed.length) return !failed.every(c => missing.has(c.id));
    }
    return true;
  }));
}
