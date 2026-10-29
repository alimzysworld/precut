// Raw live sound must never make Chromium decode the camera's video track.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {sourceAudio, sourceAudioInput} from './source-audio';
import {audioCacheDir, sourceIdentity, localAudioProcess} from './voice-isolation';
import {runActivity} from './activity';
import {tool} from './tools';
const pending = new Map<string, Promise<string>>();
const audioFiles = new Set(['.wav','.mp3','.m4a','.aac','.flac','.ogg','.opus','.aiff','.aif']);
export async function playbackAudio(root: string, source: string): Promise<string> {
  if (audioFiles.has(path.extname(source).toLowerCase())) return source;
  const identity = await sourceIdentity(source);
  const key = createHash('sha256').update(JSON.stringify([1,identity])).digest('hex');
  const id = `${path.resolve(root)}:${key}`, existing = pending.get(id);
  if (existing) return existing;
  const work = (async () => {
    const stream = await sourceAudio(source);
    if (!stream) throw new Error("This clip has no sound.");
    const copy = ['aac','alac','pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'].includes(stream.codec_name!);
    const extension = ['aac','alac'].includes(stream.codec_name!) ? '.m4a' : '.wav';
    const folder = await audioCacheDir(root), output = path.join(folder,`raw-live-${key}${extension}`);
    if (await fs.stat(output).then(s => s.size > 44, () => false)) return output;
    await runActivity({kind:'render',root,target:null,label:'Preparing sound',cancelable:true}, async activity => {
      const disk = await fs.statfs(folder);
      // Copying even an uncompressed track cannot exceed its source container;
      // conversion reserves a conservative multiple before touching the cache.
      if (disk.bavail * disk.bsize < 15e9 + identity.size * (copy ? 1 : 8)) throw new Error('There is not enough room to prepare this sound.');
      const temporary = path.join(folder,`raw-live-${key}.${randomUUID()}${extension}`);
      try {
        await localAudioProcess(tool('ffmpeg'),['-v','error','-nostdin','-y',...await sourceAudioInput(source),'-vn','-sn','-dn','-c:a',copy ? 'copy' : 'pcm_f32le',temporary]);
        activity.signal.throwIfAborted();
        await fs.rename(temporary,output);
      } finally {await fs.rm(temporary,{force:true});}
    },{renderLane:'draft'});
    return output;
  })();
  pending.set(id,work);
  try {return await work;} finally {if(pending.get(id)===work)pending.delete(id);}
}
