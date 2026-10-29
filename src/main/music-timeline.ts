import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { StoredVersion } from './sidekick';
import type { FxPlan } from './edits-fx';
import { outputMusicGrid, type MusicGrid } from '../shared/music-grid';
import { readMusicArrangement, type MusicMeasurements } from './music-arrange';
import { cachedMusicStems } from './stem-mix';
import { sourceIdentity } from './voice-isolation';
import { independentPreparation } from './activity';
import { measureMusicForTimeline } from './cut-to-music';

const attempts = new Map<string, Promise<unknown>>();
const retryAfter = new Map<string, number>();
/** Read-only for MCP. Playback alone may request silent local measurement. */
export async function timelineMusic(root: string, record: StoredVersion, fx: FxPlan, prepare = false): Promise<MusicGrid | undefined> {
  const music = record.music !== undefined ? record.music : record.assembly.reel.music;
  if (!music) return;
  const arranged = await readMusicArrangement(root,record,fx);
  if (arranged) return outputMusicGrid(arranged.measurements,Math.min(fx.durationS,music.endS ?? fx.durationS),0,arranged.parts);
  // Until fitted audio is ready its measured source grid is the wrong clock.
  if (music.fit || music.followStory) return;
  const file = path.resolve(root,music.file), stems = await cachedMusicStems(root,file);
  const key = createHash('sha256').update(JSON.stringify([await sourceIdentity(file),stems ? await sourceIdentity(stems.drums) : null,6])).digest('hex');
  try {
    const m: MusicMeasurements = JSON.parse(await fs.readFile(path.join(root,'.sidething/finish-cache',`arrange-analysis-${key}.json`),'utf8'));
    return outputMusicGrid(m,Math.min(fx.durationS,music.endS ?? fx.durationS),music.startS);
  } catch { /* An absent cache stays invisible while local measurement runs. */ }
  const scope = `${root}:${key}`;
  if (prepare && !attempts.has(scope) && Date.now() >= (retryAfter.get(scope) ?? 0)) {
    const work = independentPreparation(() => measureMusicForTimeline(root,file)).then(() => {
      retryAfter.delete(scope);
    }).catch(() => {
      // Cancellation and transient resource failures must not hide this song's
      // marks until relaunch. Avoid repeatedly retrying while the edit refreshes.
      retryAfter.set(scope,Date.now()+30_000);
      if (retryAfter.size > 64) retryAfter.delete(retryAfter.keys().next().value!);
    }).finally(() => { attempts.delete(scope); });
    attempts.set(scope,work);
  }
}

/** Full source bars for start/slip gestures, including bars outside the current edit. */
export async function sourceMusicMeasurements(root:string,file:string):Promise<MusicMeasurements|undefined> {
  const stems=await cachedMusicStems(root,file);
  const key=createHash('sha256').update(JSON.stringify([await sourceIdentity(file),stems ? await sourceIdentity(stems.drums) : null,6])).digest('hex');
  try{return JSON.parse(await fs.readFile(path.join(root,'.sidething/finish-cache',`arrange-analysis-${key}.json`),'utf8'));}catch{return undefined;}
}
