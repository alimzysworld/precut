// Dropped media is copied into the edit cache, never moved into the shoot.
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Clip } from '../shared/schema';
import type { StoredVersion } from './sidekick';
import { currentActivity, withRenderSlot, threads } from './activity';
import { tool } from './tools';
export type LayoutAssembly = StoredVersion['assembly'] & { layoutMedia?: Clip[] };
const exec = promisify(execFile);
export function withLayoutMedia(assembly: LayoutAssembly, shoot = assembly.shoot) {
  const clips = assembly.layoutMedia ?? [];
  return clips.length ? {...shoot,clips:[...shoot.clips,...clips.filter(c => !shoot.clips.some(p => p.id === c.id))]} : shoot;
}
export async function importLayoutMedia(root: string, source: string, length: number): Promise<Clip> {
  const activity = currentActivity();
  if (!activity || !path.isAbsolute(source) || !/\.(mp4|mov|m4v|webm|mkv|png|jpe?g|webp|tiff?|gif)$/i.test(source)) throw new Error('Drop a video or image from Finder.');
  return withRenderSlot(activity,async() => {
    const stat = await fs.stat(source);
    if (!stat.isFile() || !stat.size) throw new Error('Choose a media file.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source)) {activity.signal.throwIfAborted();hash.update(chunk);}
    const still = /\.(png|jpe?g|webp|tiff?|gif)$/i.test(source), key = hash.update(still ? `:${length}` : '').digest('hex').slice(0,24), id = `layout-${key}`;
    const dir = path.join(root,'.sidething','layout-media'); await fs.mkdir(dir,{recursive:true});
    const copy = path.join(dir,`${key}${path.extname(source).toLowerCase()}`);
    try {await fs.copyFile(source,copy,2);} catch(e) {if((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;}
    const {stdout} = await exec(tool('ffprobe'),['-v','error','-select_streams','v:0','-show_streams','-show_format','-of','json',copy],{signal:activity.signal,maxBuffer:1024*1024});
    const probe = JSON.parse(stdout), stream = probe.streams?.[0], duration = still ? length : Number(probe.format?.duration);
    if (!stream?.width || !stream.height || !Number.isFinite(duration) || duration < length-1e-6) throw new Error('This shot needs a video long enough to cover the clip.');
    const [num,den] = String(stream.avg_frame_rate ?? '25/1').split('/').map(Number), fps = num > 0 && den > 0 ? num/den : 25;
    const proxyDir = path.join(root,'.sidething','proxies');await fs.mkdir(proxyDir,{recursive:true});
    const proxy = `${id}.mp4`, target = path.join(proxyDir,proxy), converted = path.join(dir,`${id}.mp4`);
    const signal = activity.signal;
    async function encode(file:string,width:number) {
      try {await fs.access(file);return;} catch { /* Cache miss. */ }
      const temp = `${file}.${randomUUID()}.tmp.mp4`;
      try {
        await exec(tool('ffmpeg'),['-v','error','-nostdin','-y','-threads',String(threads(2)),...(still ? ['-loop','1'] : []),'-i',copy,'-t',String(duration),'-an','-vf',`scale='max(2,trunc(min(${width},iw)/2)*2)':-2,format=yuv420p`,'-r',String(fps),'-c:v','libx264','-preset','fast','-crf','18','-threads',String(threads(2)),'-movflags','+faststart',temp],{signal,maxBuffer:1024*1024});
        await fs.rename(temp,file);
      } finally {await fs.rm(temp,{force:true});}
    }
    if (still) await encode(converted,stream.width);
    await encode(target,960);
    const file = path.relative(root,still ? converted : copy);
    const picture = still ? JSON.parse((await exec(tool('ffprobe'),['-v','error','-select_streams','v:0','-show_streams','-of','json',converted],{signal,maxBuffer:1024*1024})).stdout).streams[0] : stream;
    return {id,file,stage:'done',proxy,frames:[],transcript:[],shake:null,judgement:null,byHand:{kind:'broll'},subject:null,
      meta:{width:picture.width,height:picture.height,fps,durationS:duration,codec:picture.codec_name ?? 'h264',camera:null,pictureProfile:null,iso:null,shutter:null,aperture:null,focalLength:null,startTimecode:null,audioChannels:0,sampleRate:48000,sizeBytes:stat.size,createdAt:null}};
  },'waited');
}
