import { sourceAudioDuration } from './source-audio';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AudioFinish, ClipSoundClean, MusicStems, PieceFx } from '../shared/schema';
import { independentPreparation, awaitSoundPreparation } from './activity';
import { sourceIdentity } from './voice-isolation';
import { readExtension } from './extensions';
import { separate, isolateVoice, STEMS_EXTENSION_ID, STEMS_MODEL_VERSION } from './stems';

export const STEM_NAMES = ['vocals', 'other', 'drums', 'bass'] as const;
export function pieceSoundSettings(audio: AudioFinish, fx: PieceFx | null | undefined, talking: boolean, layer = 0) {
  const sound = layer === 1 ? fx?.overlaySound : fx;
  return { audio: {...audio, evenOutVoices: sound?.gainDb !== undefined || !talking ? false : audio.evenOutVoices}, clean: sound?.clean ?? 'none' as ClipSoundClean };
}
export async function requireSoundSeparation() {
  const extension = await readExtension(STEMS_EXTENSION_ID);
  if (extension.state !== 'installed') throw new Error('Install Sound separation in Settings > Add-ons to clean clip sound.');
}
/** The music-trained vocal stem retains crowd singing too. This is instrument
 * reduction, not a foreground speaker selector. Never claim PA vocal removal. */
export async function cleanClipSound(root: string, file: string, mode: ClipSoundClean) {
  // A source is separated once, before piece trimming. Live takes, J/L handles,
  // export tails and editor slices must never infer different boundary audio.
  if (mode === 'isolate_voice') {
    const result = await awaitSoundPreparation(() => isolateVoice(file, undefined, { root }));
    if (result.status !== 'ready') throw new Error('Install Sound separation in Settings > Add-ons to clean clip sound.');
    return result.voice;
  }
  const result = await awaitSoundPreparation(() => separate(file, undefined, { root }));
  if (result.status !== 'ready') throw new Error('Install Sound separation in Settings > Add-ons to clean clip sound.');
  return result.vocals;
}

async function publish(root: string, file: string, key: string, name: string) {
  const realRoot = await fs.realpath(root), side = path.join(root,'.sidething'), cache = path.join(side,'finish-cache');
  await fs.mkdir(side,{recursive:true});
  if (await fs.realpath(side) !== path.join(realRoot,'.sidething')) throw Error('The sound cache cannot be a link.');
  await fs.mkdir(cache,{recursive:true});
  if (await fs.realpath(cache) !== path.join(realRoot,'.sidething/finish-cache')) throw Error('The sound cache cannot be a link.');
  const [disk,source]=await Promise.all([fs.statfs(cache),fs.stat(file)]);
  if(disk.bavail*disk.bsize-source.size<15e9)throw Error('Free some space before preparing separated music.');
  const output = path.join(cache,`stem-${key}-${name}.wav`), temporary = `${output}.${randomUUID()}.tmp`;
  // Atomic copies, never links into an original or another profile.
  try { await fs.copyFile(file,temporary); await fs.rename(temporary,output); }
  finally { await fs.rm(temporary,{force:true}); }
  return output;
}
const ready = new Map<string, MusicStems>(), pending = new Map<string,Promise<MusicStems | undefined>>();
async function musicKey(root:string,file:string,span?:{s:number;e:number}) {
  return createHash('sha256').update(JSON.stringify([await fs.realpath(root),await sourceIdentity(file),STEMS_MODEL_VERSION,span])).digest('hex');
}
export async function cachedMusicStems(root:string,file:string,span?:{s:number;e:number}) {
  return ready.get(await musicKey(root,file,span));
}
export async function musicStems(root: string, file: string, wait = true, span?:{s:number;e:number}): Promise<MusicStems | undefined> {
  if ((await readExtension(STEMS_EXTENSION_ID)).state !== 'installed') return;
  const key = await musicKey(root,file,span);
  if (ready.has(key)) return ready.get(key);
  let work = pending.get(key);
  if (!work) {
    const prepare = async () => {
      const duration=span ? await sourceAudioDuration(file) : undefined;
      if(span && duration! <= span.s)return;
      const selected=span ? {...span,e:Math.min(span.e,duration!)} : undefined;
      const result = await separate(file,selected);
      if (result.status !== 'ready') return;
      const files = {} as MusicStems;
      for (const name of STEM_NAMES) files[name] = await publish(root,result[name],result.key,name);
      ready.set(key,files); while(ready.size>32)ready.delete(ready.keys().next().value!);
      return files;
    };
    work = wait ? awaitSoundPreparation(prepare) : independentPreparation(prepare);
    pending.set(key,work);
    void work.then(() => import('./sidekick').then(m=>m.changed(root)),()=>{}).finally(()=>pending.delete(key)).catch(()=>{});
  }
  if (wait) return awaitSoundPreparation(()=>work!);
}
