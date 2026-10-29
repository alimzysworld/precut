import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { AudioFinish, VoiceoverScript } from '../shared/schema';
import { cleanVoiceFile, DEFAULT_AUDIO_FINISH, normalizeAudio } from './audio';
import { measureSourceAudio, sourceIdentity } from './voice-isolation';

/** The same cached, level-matched WAVs feed playback, MP4 and editable lanes.
 * Opening only checks files. Expensive preparation runs in the background or
 * during an explicit export, through cleanVoiceFile's existing media lane.
 *
 * VO7-10: each take is cleaned and loudness-matched once, over the whole take, into one WAV
 * (cleanVoiceFile's cache is keyed by the take file and its content hash). Every piece plays its
 * slice of that WAV, so pieces from one take keep exactly the take's level and sound whatever
 * the splits, trims or deletes: no per-piece gain, no cleanup restarting cold at a seam.
 * Different takes are still matched take to take. */
export async function voiceoverAudio(root: string, script: VoiceoverScript | undefined, finish: Partial<AudioFinish> | null | undefined, wait = true) {
  const audio = normalizeAudio({ ...DEFAULT_AUDIO_FINISH, ...finish, eq: undefined, loudnessLUFS: -14 });
  const result = [];
  for (const line of script?.lines ?? []) {
    if (!line.take) continue;
    const take = line.take, input = path.resolve(root, take.file), d = take.e - take.s;
    if (audio.auto === false && !audio.clean && audio.breaths === false) {
      result.push({ line, file: input, start: take.s, d, sourceStart: 0, ready: true, key: '' }); continue;
    }
    const key = createHash('sha256').update(JSON.stringify({ revision: 2, whole: true, source: await sourceIdentity(input), audio })).digest('hex');
    const file = path.join(root, '.sidething/finish-cache', `voiceover-take-${key}.wav`);
    let ready = await fs.stat(file).then(s => s.size > 44, () => false);
    if (wait && !ready) {
      await cleanVoiceFile(input, file, audio, { root, start: 0, duration: (await measureSourceAudio(root, input)).durationS }); ready = true;
    }
    // Ready or not, the file's time 0 is the take's time 0: the piece starts at take.s inside it.
    result.push({ line, file: ready ? file : input, start: take.s, d, sourceStart: 0, ready, key });
  }
  return result;
}
