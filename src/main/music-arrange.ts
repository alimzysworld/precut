import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { MusicStems } from '../shared/schema';
import type { StoredVersion } from './sidekick';
export type ArrangeRecord = Pick<StoredVersion,'cutToBeat'|'cutMusicPlan'|'keptBeats'|'voiceover'> & { music?: StoredVersion['music']; assembly: {cutList: StoredVersion['assembly']['cutList']; reel: Pick<StoredVersion['assembly']['reel'],'cuts'|'why'|'music'> & {model?: Pick<StoredVersion['assembly']['reel']['model'],'why'>}} };
import type { FxPlan } from './edits-fx';
import { sourceAudioDuration } from './source-audio';
import { sourceIdentity } from './voice-isolation';
import { musicStems, cachedMusicStems } from './stem-mix';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { totalmem } from 'node:os';
import { availableMemoryShare } from './resource-governor';
import { readExtension } from './extensions';
import { independentPreparation, awaitSoundPreparation, runActivity, currentActivity } from './activity';
import { tool, toolEnvironment } from './tools';
import { chooseStory, retimeStory, storyCallGate, SupersededStory, STEM_NAMES, type StoryPoint } from './music-story';
export { validateShape } from './music-story';

type Music = NonNullable<StoredVersion['music']>;
export interface MusicMeasurements { beats?: number[]; durationS: number; bars: number[]; sections: number[]; sectionFacts?: {index:number;s:number;e:number;rmsDb:number;strongHits:number}[]; hits: number[]; metre: string; rhythmSource: string }
export interface MusicPart { sourceS: number; sourceE: number; atS: number; section: number }
/** Said in the music panel and in an export's result when Follow the story ran without the model's decision. */
export const STORY_UNAVAILABLE = "The music fits the length but wasn't shaped to the story: couldn't get an answer from the model.";
export interface MusicArrangement { summary?: string; storyNote?: string; repeats?: string; alreadyFits?: boolean; key: string; file: string; stems?: MusicStems; durationS: number; parts: MusicPart[]; shape: StoryPoint[]; measurements: MusicMeasurements; ending: 'original outro'; outputs: Awaited<ReturnType<typeof sourceIdentity>>[]; }
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** V63: a hand pin keeps the accepted clock only while its arrangement still
 * reaches the edit's end on its musical ending: within one measured beat of
 * the track. A bigger length change refits (the story decision is cached, so
 * no model call). Unmeasured tracks keep the pin until measurement exists. */
async function pinFits(root:string,file:string,pinnedS:number,durationS:number,pinnedKey?:string) {
  const delta=Math.abs(pinnedS-durationS);
  if(delta<1/48000)return true;
  const stems=await cachedMusicStems(root,file).catch(()=>undefined);
  const key=digest([await sourceIdentity(file),stems ? await sourceIdentity(stems.drums) : null,6]),cache=path.join(root,'.sidething/finish-cache');
  const m=await fs.readFile(path.join(cache,`arrange-analysis-${key}.json`),'utf8').then(s=>JSON.parse(s) as MusicMeasurements)
    .catch(()=>pinnedKey ? fs.readFile(path.join(cache,`arrange-${pinnedKey}.json`),'utf8').then(s=>(JSON.parse(s) as MusicArrangement).measurements) : null).catch(()=>null);
  if(!m?.bars)return true;
  const grid=m.beats?.length ? m.beats : m.bars,gaps=grid.slice(1).map((t,i)=>t-grid[i]).filter(g=>g>0).sort((a,b)=>a-b);
  const beat=gaps.length ? gaps[Math.floor(gaps.length/2)]/(m.beats?.length ? 1 : 4) : 0;
  return delta<=beat+1e-6;
}
const editClock=(s:number)=>{const t=Math.round(s);return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`;};
/** V63: say when reaching the length meant playing part of the song again. */
export function repeatLine(parts:MusicPart[],durationS:number) {
  const blocks:MusicPart[][]=[];let open=false;
  parts.forEach((p,i)=>{
    const repeat=parts.slice(0,i).some(q=>Math.min(q.sourceE,p.sourceE)-Math.max(q.sourceS,p.sourceS)>.05);
    if(repeat && open)blocks.at(-1)!.push(p);else if(repeat)blocks.push([p]);
    open=repeat;
  });
  if(!blocks.length)return undefined;
  return blocks.length>1 ? `Repeats ${blocks.length} sections to reach ${editClock(durationS)}` : `Repeats ${blocks[0][0].section===0 ? 'the opening' : 'a section'} to reach ${editClock(durationS)}`;
}
function withRepeats(a:MusicArrangement):MusicArrangement {
  const repeats=repeatLine(a.parts,a.durationS);
  return repeats ? {...a,repeats,summary:`${(a.summary ?? 'Music fits the edit').replace(/\.\s*$/,'')}. ${repeats}`} : a;
}
const pending = new Map<string, Promise<MusicArrangement|null>>();
const failures = new Map<string,string>();
export async function musicArrangementStatus(root:string,record:ArrangeRecord,fx:FxPlan) {
  const r=await request(root,record,fx);
  if(!r)return undefined;
  return failures.has(r.key) ? 'error' as const : await readMusicArrangement(root,record,fx) ? 'ready' as const : 'preparing' as const;
}
const names = STEM_NAMES;

/** Own the helper's process group, including its ffmpeg decoder. */
export async function arrangeProcess(args:string[]) {
  const signal=currentActivity()?.signal;signal?.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(tool('python3'),args,{detached:true,stdio:['ignore','ignore','pipe'],env:{...toolEnvironment(),OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}});
    let stderr='',expired=false;
    child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
    const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* Already closed. */}};
    const timeout=setTimeout(()=>{expired=true;stop();},30*60_000);
    signal?.addEventListener('abort',stop,{once:true});
    const clean=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',stop);};
    child.once('error',error=>{clean();reject(error);});
    child.once('close',code=>{clean();if(signal?.aborted)reject(signal.reason);else if(code!==0||expired)reject(Error(stderr || 'Music preparation stopped.'));else resolve();});
    if(signal?.aborted)stop();
  });
}

/** Complete bars internally, a possible pickup at the opening, untouched outro
 * at picture end. Arbitrary picture lengths cannot also be whole-bar totals. */
export function arrangeBars(m: MusicMeasurements, durationS: number, startS = 0, shape: StoryPoint[] = []): MusicPart[] {
  if (!Number.isFinite(durationS) || durationS <= 0 || durationS > 1800) throw Error('Choose an edit under 30 minutes.');
  const bars = m.bars.filter(t=>Number.isFinite(t) && t>=0 && t<m.durationS).sort((a,b)=>a-b);
  if(bars.length<2)throw Error('Could not find bars in this track.');
  const cadenceLength=m.durationS-bars[Math.max(0,bars.length-4)];
  const cadence=bars.find(t=>m.durationS-t<=Math.min(durationS/4,cadenceLength)) ?? bars.at(-1)!;
  const outro = (m.durationS-cadence<=durationS ? cadence : undefined) ?? [...bars].reverse().find(t=>m.durationS-t<=durationS) ?? Math.max(0,m.durationS-durationS);
  const tail=m.durationS-outro, prefix=durationS-tail, parts:MusicPart[]=[];
  const barLengths=bars.slice(1).map((b,i)=>b-bars[i]).sort((a,b)=>a-b);
  const barLength=barLengths[Math.floor(barLengths.length/2)];
  let remaining=prefix, cursor=-1, lastPoint:StoryPoint|undefined;
  // Fill backwards so any fractional pickup stays at the opening. The final
  // section is always the real recorded ending, never a fade on a loop.
  while(remaining>1e-7){
    // Select at the bar's middle, so a story boundary uses the nearest bar
    // rather than always advancing the change by a whole bar.
    const point=[...shape].reverse().find(p=>p.atS<=Math.max(0,remaining-barLength/2)+1e-7) ?? shape[0];
    const sectionStart=point ? m.sections[point.section] : 0;
    const first=Math.max(0,bars.findIndex(t=>t>=sectionStart));
    if(cursor<first || point!==lastPoint){
      const preferred=point ? (m.sections[point.section+1] ?? m.durationS) : Math.min(m.durationS,startS+remaining);
      const found=bars.findIndex(t=>t>=preferred);
      cursor=Math.min(bars.length-2,Math.max(first,found<0 ? bars.length-2 : found-1));
      lastPoint=point;
    }
    const a=bars[cursor],b=bars[cursor+1],length=Math.min(remaining,b-a);
    parts.unshift({sourceS:b-length,sourceE:b,atS:remaining-length,section:Math.max(0,m.sections.reduce((last,t,i)=>t<=a ? i : last,-1))});
    cursor--;
    remaining-=length;
    startS=Math.max(0,a-(b-a));
  }
  parts.push({sourceS:outro,sourceE:m.durationS,atS:prefix,section:Math.max(0,m.sections.reduce((last,t,i)=>t<=outro ? i : last,-1))});
  return parts;
}

export function storyPacket(record:ArrangeRecord,fx:FxPlan) {
  return {reason:record.assembly.reel.why,durationS:fx.durationS,
    beats:fx.items.map((item,i)=>({atS:item.startS,endS:item.endS,
      words:record.assembly.cutList[i]?.seg?.clip.transcript?.filter(s=>s.e>item.timeMap[0].s && s.s<item.timeMap.at(-1)!.s).map(s=>s.text).join(' ') ?? '',
      id:record.assembly.reel.cuts[i]?.id ?? String(i)}))};
}
/** Authored reel IDs are story anchors. Hand-inserted coverage (source-) only
 * moves their clock unless it has explicitly become a chosen story beat.
 * Bookkeeping that first populates keptBeats does not change authored IDs.
 * Use the complete segment wording, so a trim through a phrase is not a new story. */
export function storyMoments(record:ArrangeRecord,fx:FxPlan) {
  const chosen=record.keptBeats;
  const beats=record.assembly.reel.cuts.flatMap((cut,piece)=>{
    const items=fx.items.filter(item=>item.piece===piece);
    if(!items.length)return [];
    const seg=record.assembly.cutList.find((c,i)=>(c.piece ?? i)===piece)?.seg;
    const words=seg?.clip.transcript?.filter(s=>s.e>seg.s && s.s<seg.e).map(s=>s.text).join(' ') ?? '';
    if(cut.id.startsWith('source-') && !chosen?.some(b=>b.id===cut.id) && !(seg && seg.lineIndex!==null && words.trim()))return [];
    return [{id:cut.id,words,description:seg?.clip.judgement?.summary,atS:items[0].startS,endS:items.at(-1)!.endS}];
  }).filter((beat,i,all)=>!i || beat.id!==all[i-1].id);
  // Narration text is semantic; timing is deliberately excluded from identity.
  return {reason:record.assembly.reel.model?.why ?? record.assembly.reel.why,durationS:fx.durationS,beats,narration:record.voiceover?.lines.map(l=>l.text)};
}
export function storyIdentity(record:ArrangeRecord,fx:FxPlan) {
  const packet=storyMoments(record,fx);
  return [packet.reason,packet.beats.map(b=>[b.id,b.words,b.description]),record.voiceover?.lines.map(l=>l.text) ?? []];
}
async function directory(root:string) {
  const real=await fs.realpath(root),side=path.join(real,'.sidething'),cache=path.join(side,'finish-cache');
  await fs.mkdir(side,{recursive:true});if(await fs.realpath(side)!==side)throw Error('The music cache cannot be a link.');
  await fs.mkdir(cache,{recursive:true});if(await fs.realpath(cache)!==cache)throw Error('The music cache cannot be a link.');
  return cache;
}
async function script() {
  const {app}=await import('electron');
  for(const base of [app.getAppPath(),process.resourcesPath,process.cwd()].filter(Boolean) as string[]){const file=path.join(base,'pipeline/music_arrange.py');if(await fs.stat(file).catch(()=>null))return file;}
  throw Error('Music arranging is unavailable.');
}
async function request(root:string,record:ArrangeRecord,fx:FxPlan) {
  const music=record.music !== undefined ? record.music : record.assembly.reel.music;
  if(!music || !music.fit && !music.followStory)return null;
  const file=path.resolve(root,music.file), identity=await sourceIdentity(file).catch(()=>null);
  if(!identity)return null;
  const currentPacket=music.followStory ? storyPacket(record,fx) : null;
  const cutPlan=record.cutMusicPlan; // Turning the control off keeps the already applied cut and soundtrack.
  // V26 cuts were judged against this prepared soundtrack. Keep its musical
  // clock while this exact resulting story is current; trims invalidate it.
  const packet=cutPlan?.musicStory && cutPlan.outputStorySignature===digest(currentPacket) && cutPlan.musicChoice===digest([music.file,music.startS,!!music.fit,!!music.followStory]) ? cutPlan.musicStory : currentPacket;
  const installed=(await readExtension('sound-separation')).state==='installed';
  const scope=await fs.realpath(root);
  const currentMoments=music.followStory ? storyMoments(record,fx) : null;
  const moments=currentMoments && packet && packet!==currentPacket ? {...currentMoments,beats:currentMoments.beats.map(b=>{
    const original=packet.beats.filter(p=>p.id===b.id);
    return original.length ? {...b,atS:original[0].atS,endS:original.at(-1)!.endS} : b;
  })} : currentMoments;
  const source=digest([scope,identity,music.startS,installed]);
  const anchor=(music as Music).pinnedArrangement;
  const pinned=anchor?.source===source && /^[a-f0-9]{64}$/.test(anchor.key) && Number.isFinite(anchor.durationS) && anchor.durationS>0 && anchor.durationS<=1800;
  if(pinned && await pinFits(root,file,anchor.durationS,fx.durationS,anchor.key))
    return {music:music as Music,file,...anchor,scope,installed};
  // V63: a refit for a new length keeps the pinned story decision (its moments
  // retime onto this edit), so a trim never buys another model call.
  const storyKey=moments ? pinned && anchor.storyKey ? anchor.storyKey : digest([2,identity,installed,storyIdentity(record,fx)]) : null;
  const key=digest([11,installed,scope,identity,Math.round(fx.durationS*48000)/48000,music.startS,!!music.fit,!!music.followStory,packet,storyKey]);
  return {music:music as Music,file,key,source,durationS:fx.durationS,packet,moments,storyKey,scope,installed};
}
/** A hand edit carries the original request, so even pending work/relaunch uses
 * exactly the old clock. No media or model work runs in the save transaction. */
export async function pinMusicForHandEdit(root:string,previous:StoredVersion,record:StoredVersion) {
  const before=previous.music !== undefined ? previous.music : previous.assembly.reel.music;
  const after=record.music !== undefined ? record.music : record.assembly.reel.music;
  if(!before || !after || before.file!==after.file || before.startS!==after.startS || !!before.fit!==!!after.fit || !!before.followStory!==!!after.followStory)return;
  const {planFx}=await import('./edits-fx');
  const oldFx=planFx(previous.assembly.cutList,previous.assembly.template.fps,previous);
  const nextFx=planFx(record.assembly.cutList,record.assembly.template.fps,record);
  const clock=(v:StoredVersion,fx:FxPlan)=>[v.assembly.cutList.map(c=>[c.seg?.clip.id,c.inFrames,c.outFrames,c.offsetFrames]),fx.items.map(i=>[i.piece,i.startS,i.endS,i.timeMap])];
  if(JSON.stringify(clock(previous,oldFx))===JSON.stringify(clock(record,nextFx)))return;
  const r=await request(root,previous,oldFx);if(!r)return;
  const {key,source,durationS,packet,moments,storyKey}=r;
  record.music={...after,pinnedArrangement:{key,source,durationS,packet,moments,storyKey}};
  // V63: a length change past one beat pins the refit for the new length instead,
  // keeping the accepted story decision.
  if(await pinFits(root,r.file,r.durationS,nextFx.durationS,r.key))return;
  const refit=await request(root,record,nextFx);
  if(refit)record.music={...after,pinnedArrangement:{key:refit.key,source:refit.source,durationS:refit.durationS,packet:refit.packet,moments:refit.moments,storyKey:refit.storyKey}};
}
export async function musicArrangementKey(root:string,record:ArrangeRecord,fx:FxPlan) { return (await request(root,record,fx))?.key ?? null; }
/** Read-only: read_edit must not launch analysis, inference or rendering. */
export async function readMusicArrangement(root:string,record:ArrangeRecord,fx:FxPlan):Promise<MusicArrangement|null> {
  const r=await request(root,record,fx);if(!r)return null;
  const file=path.join(root,'.sidething/finish-cache',`arrange-${r.key}.json`);
  try {const value=JSON.parse(await fs.readFile(file,'utf8')) as MusicArrangement;
    const outputs=[value.file,...Object.values(value.stems ?? {})];
    if(!value.outputs || value.outputs.length!==outputs.length)return null;
    for(const [i,f] of outputs.entries())if(path.dirname(f)!==path.join(await fs.realpath(root),'.sidething/finish-cache')||JSON.stringify(await sourceIdentity(f))!==JSON.stringify(value.outputs[i])||(await fs.stat(f)).size<=44)return null;
    return withRepeats(value);
  }catch{return null;}
}
/** V26 may wait for Follow already requested by playback, but must not
 * launch a second editorial model call as part of cutting to the music. */
export async function preparedMusicArrangement(root:string,record:ArrangeRecord,fx:FxPlan):Promise<MusicArrangement|null> {
  const cached=await readMusicArrangement(root,record,fx);if(cached)return cached;
  const r=await request(root,record,fx),work=r ? pending.get(r.key) : undefined;
  return work ? awaitSoundPreparation(()=>work) : null;
}
export async function arrangedMusic(root:string,record:ArrangeRecord,fx:FxPlan,wait=true):Promise<MusicArrangement|null> {
  const r=await request(root,record,fx);
  if(!r){storyCallGate.observe(await fs.realpath(root),'off','off');return null;}
  // This runs only on playback/preparation requests, never on read_edit/status.
  storyCallGate.observe(r.scope,r.storyKey ?? 'fit',digest([r.key,record.music?.gainDb]));
  const cached=await readMusicArrangement(root,record,fx);if(cached)return cached;
  if(failures.has(r.key)){if(wait)throw Error(failures.get(r.key));return null;}
  let work=pending.get(r.key);
  if(!work){
    const prepare=async()=>{
      // Stem preparation has its own background slot; do not hold ours while
      // waiting on it. No add-on installation ever starts here.
      const duration=await sourceAudioDuration(r.file);
      if(duration>1800)throw Error('Choose a music track under 30 minutes.');
      const stems=await musicStems(root,r.file,true);
      return runActivity({kind:'edit',root,target:null,label:'Arranging music',cancelable:true},async activity=>{
        activity.progress(null,'Arranging music',null);
        while(availableMemoryShare()<.2+Math.max(512e6,(duration+r.durationS)*48000*8*3)/totalmem()){activity.progress(null,'Waiting for memory',null);await delay(1000,undefined,{signal:activity.signal});}
        const cache=await directory(root), disk=await fs.statfs(cache);
        if(disk.bavail*disk.bsize-Math.max(1e9,r.durationS*48000*8*6)<15e9)throw Error('Free some space before arranging music.');
        const timingName=`arrange-time-${r.packet ? 'story' : 'fit'}-${stems ? 'stems' : 'mix'}.json`;
        const timing=await fs.readFile(path.join(cache,timingName),'utf8').then(s=>JSON.parse(s) as {sourceS:number;outputS:number;seconds:number}).catch(()=>null);
        activity.progress(null,'Arranging music',timing ? timing.seconds*(duration+r.durationS)/(timing.sourceS+timing.outputS) : null);
        const started=Date.now(), staging=await fs.mkdtemp(path.join(cache,'arrange-work-'));
        const processAudio=(args:string[])=>runActivity({kind:'render',root,target:null,label:'Preparing music',cancelable:true},()=>arrangeProcess(args),{renderLane:'background'});
        try {
          const helper=await script(),analysisKey=digest([await sourceIdentity(r.file),stems ? await sourceIdentity(stems.drums) : null,6]);
          const measured=path.join(cache,`arrange-analysis-${analysisKey}.json`);
          let measurements:MusicMeasurements;
          try{measurements=JSON.parse(await fs.readFile(measured,'utf8'));}catch{
            const output=path.join(staging,'analysis.json');
            await processAudio(['-I',helper,'analyse',r.file,output,...(stems ? ['--drums',stems.drums] : [])]);
            measurements=JSON.parse(await fs.readFile(output,'utf8'));await fs.rename(output,measured);
          }
          // A story the model can't decide never stops the music (or an export): it fits the length without
          // following the story, and says so. The story's one request stays spent, as chooseStory records it.
          let decision:Awaited<ReturnType<typeof chooseStory>>|null=null,storyNote:string|undefined;
          if(r.moments && r.storyKey)try{decision=await chooseStory(r.scope,cache,r.storyKey,r.moments,measurements,!!stems,activity.signal);}
          catch(error){if(error instanceof SupersededStory || activity.signal.aborted)throw error;storyNote=STORY_UNAVAILABLE;console.warn('[music] arranged without the story:',error);}
          const shape=decision && r.moments ? retimeStory(decision,r.moments) : [];
          const parts=arrangeBars(measurements,r.durationS,r.music.startS,shape);
          const spec=path.join(staging,'render.json');
          await fs.writeFile(spec,JSON.stringify({file:r.file,sources:stems,parts,shape,durationS:r.durationS,directory:staging}));
          await processAudio(['-I',helper,'render',spec]);
          const outputs={} as Record<string,string>;
          for(const name of stems ? ['mix',...names] : ['mix']){const output=path.join(cache,`arrange-${r.key}-${name}.wav`);await fs.rename(path.join(staging,name+'.wav'),output);outputs[name]=output;}
          const result:MusicArrangement={summary:decision?.summary ?? storyNote,storyNote,alreadyFits:decision?.alreadyFits,key:r.key,file:outputs.mix,stems:stems ? Object.fromEntries(names.map(n=>[n,outputs[n]])) as unknown as MusicStems : undefined,durationS:r.durationS,parts,shape,measurements,ending:'original outro',outputs:await Promise.all([outputs.mix,...(stems ? names.map(n=>outputs[n]) : [])].map(sourceIdentity))};
          currentActivity()?.signal.throwIfAborted();
          const timingFile=path.join(staging,'timing.json');await fs.writeFile(timingFile,JSON.stringify({sourceS:duration,outputS:r.durationS,seconds:(Date.now()-started)/1000}));await fs.rename(timingFile,path.join(cache,timingName));
          const receipt=path.join(staging,'receipt.json');await fs.writeFile(receipt,JSON.stringify(result));await fs.rename(receipt,path.join(cache,`arrange-${r.key}.json`));
          return withRepeats(result);
        } finally {await fs.rm(staging,{recursive:true,force:true});}
      },{renderLane:'background'});
    };
    work=independentPreparation(prepare).catch(error=>{if(error instanceof SupersededStory)return null;throw error;});pending.set(r.key,work);
    void work.then(()=>import('./sidekick').then(m=>m.changed(root)),error=>{failures.set(r.key,'Music could not be arranged. Change the track or turn fitting off.');console.warn('Could not arrange music:',error);void import('./sidekick').then(m=>m.changed(root));}).finally(()=>pending.delete(r.key)).catch(()=>{});
  }
  return wait ? awaitSoundPreparation(()=>work!) : null;
}

/** Existing cut-to-beat can prefer measured drum accents without another
 * story call. Only an already prepared full-song stem is eligible. */
export async function strongDrumHits(root:string,record:ArrangeRecord,fx:FxPlan):Promise<number[]|null> {
  const music=record.music !== undefined ? record.music : record.assembly.reel.music;
  if(!music)return null;
  // Cut-to-beat is an explicit timing operation. Wait for a pending fit so its
  // hits use the arranged clock, even when clicked before preparation ends.
  const arranged=music.fit || music.followStory ? await arrangedMusic(root,record,fx) : await readMusicArrangement(root,record,fx);
  if(arranged?.measurements.rhythmSource==='drums')return arranged.parts.flatMap(p=>arranged.measurements.hits.filter(t=>t>=p.sourceS && t<p.sourceE).map(t=>music.startS+p.atS+t-p.sourceS));
  const stems=await cachedMusicStems(root,path.resolve(root,music.file));
  if(!stems)return null;
  return runActivity({kind:'render',root,target:null,label:'Measuring music hits',cancelable:true},async()=>{
    const cache=await directory(root),key=digest(await sourceIdentity(stems.drums)),file=path.join(cache,`arrange-hits-${key}.json`);
    try{return (JSON.parse(await fs.readFile(file,'utf8')) as MusicMeasurements).hits;}catch{
      const stage=await fs.mkdtemp(path.join(cache,'arrange-hits-'));
      try{const output=path.join(stage,'hits.json');await arrangeProcess(['-I',await script(),'analyse',path.resolve(root,music.file),output,'--drums',stems.drums]);const m=JSON.parse(await fs.readFile(output,'utf8')) as MusicMeasurements;await fs.rename(output,file);return m.hits;}
      finally{await fs.rm(stage,{recursive:true,force:true});}
    }
  });
}
