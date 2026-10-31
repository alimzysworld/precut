import { musicStems, pieceSoundSettings } from './stem-mix';
import { clipDuckDb } from './music-duck';
import { attachedClipSounds, audibleClipBleeps } from './clip-sound';
import { playbackSource } from './playback-source';
import { sourceAudio, sourceAudioInput, sourceAudioDuration, prefetchSourceAudio } from './source-audio';
import { voiceoverAudio } from './voiceover-audio';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AudioFinish, DraftTimeline } from '../shared/schema';
import type { StoredVersion } from './sidekick';
import type { FxPlan } from './edits-fx';
import { audioSpan } from './join-audio';
import { DEFAULT_AUDIO_FINISH, normalizeAudio, prepareVoicePiece } from './audio';
import { independentPreparation, runActivity, currentActivity, threads } from './activity';
import { sourceIdentity, localAudioProcess } from './voice-isolation';
import { tool } from './tools';
import { prepareDesignSounds } from './sound-design';
import type { LiveSound, LiveSoundPiece } from './live-sound-types';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobs = new Map<string, Promise<void>>();
const cacheUrl = (root: string, file: string) => `st-media://local/${encodeURIComponent(root)}/finish-cache/${encodeURIComponent(path.basename(file))}`;
async function ensureCache(root:string,cache:string) {
  const realRoot=await fs.realpath(root),side=path.join(root,'.sidething');
  await fs.mkdir(side,{recursive:true});
  if(await fs.realpath(side)!==path.join(realRoot,'.sidething'))throw Error('The audio cache cannot follow a shoot cache symlink.');
  await fs.mkdir(cache,{recursive:true});
  if(await fs.realpath(cache)!==path.join(realRoot,'.sidething/finish-cache'))throw Error('The audio cache cannot follow a finish cache symlink.');
}
function queue(root: string, key: string, prepare: () => Promise<void>) {
  key = `${root}|${key}`;
  if (jobs.has(key)) return;
  const work = independentPreparation(() => new Promise<void>(resolve => setImmediate(resolve)).then(() =>
    runActivity({kind:'render',root,target:null,label:'Preparing sound',cancelable:true},prepare,{renderLane:'background'})
  )).then(() => import('./sidekick').then(m => m.changed(root)), error => console.warn('Could not prepare live sound:',error));
  jobs.set(key,work); void work.finally(() => jobs.delete(key));
}
/** PAR1: the export's own master stage for this version's sound (the gain its loudness pass gave the premix and the
 * limiter ceiling after it), read from the export's sound manifest: the same request the export makes (its format,
 * energy and cut list), so the cache entry is the export's own. Read only: the viewer never prepares the export's
 * sound itself (doing that in the background made an export that overlapped it fail). AV6: with no export of this
 * sound yet, `measure` measures the export's own premix (preview.ts draftSoundMaster: the same request and graph,
 * written to nothing the export reads) and gives the stage the export will apply, so the live mix plays at the
 * export's level before any export (it was 15.7 dB quiet with Audio Auto off, 2 dB with it on). */
async function exportMaster(root: string, record: StoredVersion, measure = false): Promise<{ master: NonNullable<LiveSound['master']>; exported: boolean } | null> {
  const [{ exportFormat, exportAspect }, { prepareEnergy }, { cachedDraftSound, draftSoundMaster }, { getPreferences }, { displayedClip }] = await Promise.all([
    import('./export'), import('./finish'), import('./preview'), import('./settings'), import('../shared/media')]);
  const { width, height } = record.assembly.template;
  const version = await exportFormat(record, exportAspect(width, height));
  prepareEnergy(version, version.assembly, version.energy ?? 'subtle', (await getPreferences()).output.height);
  const cuts = version.assembly.cutList.map(c => c.seg ? { ...c, seg: { ...c.seg, clip: displayedClip(c.seg.clip) } } : c);
  const opts = { name: 'live-master', template: version.assembly.template, version, reel: version.assembly.reel, full: true };
  const file = await cachedDraftSound(root, cuts, opts, false);
  const master = file ? await fs.readFile(`${file}.json`, 'utf8').then(text => JSON.parse(text).master as LiveSound['master'] | null, () => null) : null;
  if (master && Number.isFinite(master.gainDb) && Number.isFinite(master.ceiling)) return { master, exported: true };
  if (!measure) return null;
  const measured = await runActivity({kind:'render',root,target:null,label:'Preparing sound',cancelable:true}, () => draftSoundMaster(root, cuts, opts), {renderLane:'background'});
  return measured && Number.isFinite(measured.gainDb) && Number.isFinite(measured.ceiling) ? { master: measured, exported: false } : null;
}
/** Master stages found, by the sound's own inputs (measured before an export, or the export's own); the looks still
 * running; when each sound was last asked for. */
const masters = new Map<string, NonNullable<LiveSound['master']>>(), measuredOnly = new Set<string>();
const masterLooks = new Map<string, true>(), masterAsked = new Map<string, number>();
/** The master stage for this version's sound when known. Otherwise it is looked for off the draft's path, again every
 * 20 s while a draft asked for it in the last half hour (an export may land any time; a look costs about 20 ms of
 * reads and stats; at most the 4 sounds asked for last are looked for), and the draft is built again when it is found. */
function liveMaster(root: string, record: StoredVersion): LiveSound['master'] {
  const { cutList } = record.assembly;
  const key = `${root}|${digest([record.audio, record.laneLevels, record.laneMuted, record.clipSoundMuted, record.clipSoundDefaultOn, record.music, record.sfx, record.voiceover?.lines,
    record.pieceFx, record.bleeps, record.energy, record.assembly.template, cutList.map(c => [c.seg?.clip.id, c.inFrames, c.outFrames, c.durTimelineFrames, c.offsetFrames])])}`;
  masterAsked.delete(key); masterAsked.set(key, Date.now()); if (masterAsked.size > 64) masterAsked.delete(masterAsked.keys().next().value!);
  const known = masters.get(key), edit = editOf(root, record), audioKey = digest(normalizeAudio({...DEFAULT_AUDIO_FINISH,...record.audio}));
  if (known && !measuredOnly.has(key)) return known;
  // AV6: until this sound's own stage lands (a measurement takes seconds to minutes after an edit changes the sound),
  // the edit's nearest earlier version with the same audio settings lends its stage: one edit's loudness barely moves
  // between versions (the faders sit after it), where the estimate was 15.7 dB out with Audio Auto off. When the
  // version's own stage lands the mix moves by only the real difference. A first open has none and waits for its own.
  const lent = known ? undefined : earlierStage(edit, record.version, audioKey);
  if (masterLooks.has(key)) return known ?? lent;
  masterLooks.set(key, true);
  // AV6: a look measures the premix while no stage is known for this sound and it is one of the two sounds asked for
  // last (a draft and its playback preparation can ask for neighbours; one measuring pass per sound, kept on disk).
  // Once measured, looks only read, so an export landing replaces the measured stage with its own.
  const attempt = (): void => { const measure = !masters.has(key) && [...masterAsked.keys()].slice(-2).includes(key);
    void independentPreparation(() => exportMaster(root, record, measure)).then(found => {
    // Found: a "Preparing sound" step that ends at once, the signal the edit page takes to read its draft again.
    const changed = found && JSON.stringify(found.master) !== JSON.stringify(masters.get(key));
    if (found) { masters.set(key, found.master); if (found.exported) measuredOnly.delete(key); else measuredOnly.add(key); if (masters.size > 64) { const old = masters.keys().next().value!; masters.delete(old); measuredOnly.delete(old); }
      keepStage(edit, record.version, audioKey, found.master); }
    if (changed) void runActivity({kind:'render',root,target:null,label:'Preparing sound',cancelable:true},async () => {},{renderLane:'background',deferRenderSlot:true}).catch(() => {});
    if (found?.exported) { masterLooks.delete(key); return; }
    const recent = [...masterAsked.keys()].slice(-4);
    if (recent.includes(key) && Date.now() - (masterAsked.get(key) ?? 0) < 1_800_000) setTimeout(attempt, 20_000).unref?.(); else masterLooks.delete(key);
  }, error => { masterLooks.delete(key); console.warn('Could not read the export level:', error); }); };
  setImmediate(attempt);
  return known ?? lent;
}
/** AV6: each edit's stages by version (this run of the app): an edit is its shoot, title and frame (a version carries
 * no id of its edit; its title stays with it across versions). */
const editStages = new Map<string, { version: number; audioKey: string; master: NonNullable<LiveSound['master']> }[]>();
const editOf = (root: string, record: StoredVersion) => `${root}|${record.title ?? ''}|${record.assembly.template.width}x${record.assembly.template.height}`;
function keepStage(edit: string, version: number, audioKey: string, master: NonNullable<LiveSound['master']>) {
  const list = (editStages.get(edit) ?? []).filter(e => e.version !== version);
  list.push({ version, audioKey, master });
  editStages.delete(edit); editStages.set(edit, list.slice(-32));
  if (editStages.size > 64) editStages.delete(editStages.keys().next().value!);
}
/** The stage of this edit's nearest earlier version with the same audio settings, else its nearest later one. */
function earlierStage(edit: string, version: number, audioKey: string): LiveSound['master'] {
  const same = (editStages.get(edit) ?? []).filter(e => e.audioKey === audioKey && e.version !== version);
  const before = same.filter(e => e.version < version).sort((a, b) => b.version - a.version)[0];
  return (before ?? same.sort((a, b) => a.version - b.version)[0])?.master;
}

/** Cache cleaned takes, never a version's mixed movie. Timing, gain, EQ and music
 * are graph parameters, so trim/reorder/finishing never invalidate these files. */
export async function liveSound(root: string, record: StoredVersion, fx: FxPlan): Promise<LiveSound> {
  const { cutList, template, reel } = record.assembly;
  const audio = normalizeAudio({...DEFAULT_AUDIO_FINISH,...record.audio});
  const pieces: LiveSoundPiece[] = [], cache = path.join(root,'.sidething/finish-cache');
  const soundSources=[...cutList.map((cut,i)=>({cut,item:fx.items[i],layer:0 as const})),...attachedClipSounds(reel.broll,fx,record,template.fps).map(p=>({...p,layer:1 as const}))];
  // OPEN1: every source is probed before the walk below, a few at a time; the walk then reads the answers in order.
  await prefetchSourceAudio(soundSources.flatMap(({cut,item}) => { const clip = cut.seg?.clip;
    return !clip || item.reverse || (!clip.sound && !(clip.meta?.audioChannels ?? 0)) ? [] : [playbackSource(root, clip).file]; }));
  for (const [i,{cut,item,layer}] of soundSources.entries()) {
    const clip = cut.seg?.clip;
    if (!clip || item.reverse || (!clip.sound && !(clip.meta?.audioChannels ?? 0))) continue;
    const { file: input, offset } = playbackSource(root, clip);
    if (!await sourceAudio(input)) continue;
    const span = audioSpan(item);
    const takeStart=Math.max(0,Math.min(cut.seg!.s ?? span.timeMap[0].s,span.timeMap[0].s));
    const takeEnd=Math.min(clip.meta!.durationS,Math.max(cut.seg!.e ?? span.timeMap.at(-1)!.s,span.timeMap.at(-1)!.s));
    const duration=takeEnd-takeStart;
    // EQ and output level stay live. Clean/breath settings are per-take jobs.
    const settings = pieceSoundSettings(audio,record.pieceFx?.[item.piece],clipDuckDb(cut,item)===10,layer);
    const cleanup = {...settings.audio,evenOutVoices:clipDuckDb(cut,item)===10,eq:{low:0,mid:0,high:0},loudnessLUFS:-14};
    const key = digest({revision:2,source:await sourceIdentity(input),offset,takeStart,duration,clean:cleanup.clean,denoise:cleanup.denoise,auto:cleanup.auto,breaths:cleanup.breaths,evenOutVoices:cleanup.evenOutVoices,mode:settings.clean});
    const output = path.join(cache,`live-voice-${key}.wav`);
    const gainReceipt = await fs.readFile(`${output}.gain.json`,"utf8").then(text=>JSON.parse(text) as {gainDb:number}).catch(()=>null);
    const ready = !!gainReceipt && await fs.stat(output).then(s => s.size > 44,() => false);
    if (!ready && !item.muted) queue(root,key,async () => {
      if (await fs.stat(output).then(s => s.size > 44,() => false) && await fs.stat(`${output}.gain.json`).then(()=>true,()=>false)) return;
      await ensureCache(root,cache);
      const delay=Math.max(0,-offset-takeStart),start = Math.max(0,offset+takeStart), length = duration-delay;
      if (length <= 0) return;
      const prepared = await prepareVoicePiece(root,input,cleanup,start,length,settings.clean);
      const normalization = prepared.gainDb ? `volume=${prepared.gainDb}dB` : '';
      const filter = normalization && prepared.filter.endsWith(normalization) ? prepared.filter.slice(0,-normalization.length).replace(/,$/,'') : prepared.filter;
      const temporary = path.join(cache,`live-voice-${key}.${randomUUID()}.tmp.wav`);
      try {
        await localAudioProcess(tool('ffmpeg'),['-v','error','-nostdin','-y','-threads',String(threads(2)),'-ss',`${Math.max(0,start-(prepared.sourceStart ?? 0))}`,'-t',`${length}`,...await sourceAudioInput(prepared.file),'-vn','-af',[filter,`adelay=${delay*1000}:all=1`,'apad',`atrim=duration=${duration}`].filter(Boolean).join(','),'-ar','48000','-ac','2','-c:a','pcm_f32le',temporary]);
        currentActivity()?.signal.throwIfAborted(); await fs.rename(temporary,output);
        await fs.writeFile(`${output}.gain.json`,JSON.stringify({gainDb:prepared.gainDb}));
        // ffmpeg writes IEEE float WAV here. Read its data chunk once, retaining
        // a small per-take envelope instead of rendering a whole-edit waveform.
        const peaks=(await import('./waveform-peaks')).floatWavPeaks(await fs.readFile(output));
        const envelopeTemp=`${output}.${randomUUID()}.peaks.tmp`;
        try {await fs.writeFile(envelopeTemp,JSON.stringify(peaks));await fs.rename(envelopeTemp,`${output}.peaks.json`);}finally{await fs.rm(envelopeTemp,{force:true});}
      } finally { await fs.rm(temporary,{force:true}); }
    });
    const peaks = ready ? await fs.readFile(`${output}.peaks.json`,'utf8').then(text=>JSON.parse(text) as number[]).catch(()=>undefined) : undefined;
    pieces.push({normalizeDb:(layer===1 ? record.pieceFx?.[item.piece]?.overlaySound?.gainDb : record.pieceFx?.[item.piece]?.gainDb)!==undefined ? 0 : gainReceipt?.gainDb ?? 0,clean:settings.clean,duckDb:clipDuckDb(cut,item),rawUrl:`st-media://local/${encodeURIComponent(root)}/voice/${encodeURIComponent(clip.id)}`,rawSourceStart:-offset,peaks,layer,piece:item.piece,id:`voice:${clip.id}:${span.timeMap[0].s}:${span.timeMap.at(-1)!.s}:${i}`,url:ready ? cacheUrl(root,output) : `st-media://local/${encodeURIComponent(root)}/voice/${encodeURIComponent(clip.id)}`,
      startS:span.startS,endS:span.endS,timeMap:span.timeMap,sourceStart:ready ? takeStart : -offset,gainDb:item.gainDb,muted:item.muted,fadeInS:item.audio?.fadeInS,fadeOutS:item.audio?.fadeOutS});
  }
  const narration = await voiceoverAudio(root, record.voiceover, audio, false);
  if (narration.some(p => !p.ready)) queue(root, `voiceover:${digest([record.voiceover,audio.clean,audio.denoise,audio.auto,audio.breaths])}`, async () => {
    await ensureCache(root,cache); await voiceoverAudio(root,record.voiceover,audio,true);
  });
  for (const source of narration) {
    const line = source.line, take = line.take!, endS = Math.min(fx.durationS, line.s + source.d);
    if (endS <= line.s) continue;
    pieces.push({ id: `voiceover:${line.id}:${take.file}:${take.s}:${take.e}`, url: source.ready && path.dirname(source.file) === cache ? cacheUrl(root, source.file) : `st-media://local/${encodeURIComponent(root)}/voice/${encodeURIComponent('voiceover:' + take.file)}`,
      startS: line.s, endS, sourceStart: source.sourceStart, timeMap: [{ t: line.s, s: take.s }, { t: endS, s: take.s + endS - line.s }], gainDb: 0, fadeInS: .005, fadeOutS: .005 });
  }
  // PRO3a: a sound with a role is levelled against the voice, so what sets the voice's level is part of its key.
  const voiceForRoles = record.sfx?.some(s=>s.role) ? {auto:record.audio?.auto,even:record.audio?.evenOutVoices,lanes:record.laneLevels,takes:record.voiceover?.lines.map(l=>l.take?.file),reel:record.assembly.reel.voiceLUFS} : undefined;
  const effectsKey = digest({revision:2,sfx:record.sfx,overlays:record.overlays?.map(o=>({s:o.s,e:o.e,sound:o.sound})),joins:fx.joins.map(j=>({atS:j.atS,sound:j.choice.sound})),design:audio.design,duration:fx.durationS,...(voiceForRoles ? {voiceForRoles} : {})});
  const receipt = path.join(cache,`live-effects-${effectsKey}.json`);
  let effects: LiveSoundPiece[] = [];
  try { effects = JSON.parse(await fs.readFile(receipt,'utf8')); }
  catch { if (record.sfx?.length || record.overlays?.some(o=>o.sound) || fx.joins.some(j=>j.choice.sound)) queue(root,effectsKey,async () => {
    const prepared = await prepareDesignSounds(root,fx,record), result: LiveSoundPiece[] = [];
    await ensureCache(root,cache);
    for (const [i,effect] of prepared.entries()) {
      const output = path.join(cache,`live-effect-${digest(await sourceIdentity(effect.file))}${path.extname(effect.file)}`);
      await fs.access(output).catch(()=>fs.copyFile(effect.file,output));
      const length = effect.lengthS ?? fx.durationS-effect.atS;
      result.push({id:effect.id ?? `effect:${i}`,url:cacheUrl(root,output),startS:effect.atS,endS:effect.atS+length,timeMap:[{t:effect.atS,s:0},{t:effect.atS+length,s:length}],gainDb:(effect.gainDb ?? -12)+(effect.normalizeDb ?? 0),normalizeDb:effect.normalizeDb ?? 0,loop:!!effect.loopSamples});
    }
    const temp = `${receipt}.${randomUUID()}.tmp`; try { await fs.writeFile(temp,JSON.stringify(result)); await fs.rename(temp,receipt); } finally { await fs.rm(temp,{force:true}); }
  }); }
  const {music,arrangement} = await (await import('./music-space')).musicForEdit(root,record,fx,false,(await import('./music-arrange')).arrangedMusic);
  // ONB1b: the same file the export uses; outside the library it joins it, missing it's left out.
  const catalog = arrangement?.file ?? (music ? await import('./music').then(m => m.editMusicFile(root,music.file)).catch(() => null) : null);
  const stems = music && catalog && (!('duck' in music) || music.duck !== false) && (!('stemDucking' in music) || music.stemDucking !== false) ? (arrangement ? arrangement.stems : await musicStems(root,catalog,false,{s:music.startS,e:music.startS+fx.durationS})) : undefined;
  async function envelope(file:string) {
    const key=digest(['music-peaks-v1',await sourceIdentity(file)]),receipt=path.join(cache,`music-peaks-${key}.json`);
    const peaks=await fs.readFile(receipt,'utf8').then(text=>JSON.parse(text) as number[]).catch(()=>undefined);
    if(!peaks)queue(root,key,async()=>{
      await ensureCache(root,cache);
      const temporary=path.join(cache,`music-peaks-${key}.${randomUUID()}.wav`);
      try {
        await localAudioProcess(tool('ffmpeg'),['-v','error','-nostdin','-y','-threads',String(threads(2)),...await sourceAudioInput(file),'-vn','-ar','48000','-ac','2','-c:a','pcm_f32le',temporary]);
        currentActivity()?.signal.throwIfAborted();
        const values=(await import('./waveform-peaks')).floatWavPeaks(await fs.readFile(temporary));
        const temp=`${receipt}.${randomUUID()}.tmp`;
        try{await fs.writeFile(temp,JSON.stringify(values));await fs.rename(temp,receipt);}finally{await fs.rm(temp,{force:true});}
      }finally{await fs.rm(temporary,{force:true});}
    });
    return peaks;
  }
  const sourceFile=music ? await import('./music').then(m=>m.editMusicFile(root,(record.music ?? record.assembly.reel.music)!.file)).catch(()=>null) : null;
  const sourcePeaks=sourceFile ? await envelope(sourceFile) : undefined;
  const peaks=catalog ? catalog===sourceFile ? sourcePeaks : await envelope(catalog) : undefined;
  const sourceMeasurements=sourceFile ? await (await import('./music-timeline')).sourceMusicMeasurements(root,sourceFile).catch(()=>undefined) : undefined;
  const sourceDuration=sourceFile ? await sourceAudioDuration(sourceFile).catch(()=>sourceMeasurements?.durationS) : undefined;
  const stemUrls = stems ? Object.fromEntries(Object.entries(stems).map(([name,file])=>[name,cacheUrl(root,file)])) as unknown as import('../shared/schema').MusicStems : undefined;
  return {master:liveMaster(root,record),laneLevels:record.laneLevels,laneMuted:record.laneMuted,durationS:fx.durationS,pieces:narration.length ? [...pieces.filter(p=>p.piece===undefined),...pieces.filter(p=>p.piece!==undefined)] : pieces,effects,audio,bleeps:audibleClipBleeps(record,cutList,template.fps,fx),music:music && catalog ? {...music,peaks,sourcePeaks,sourceDurationS:sourceDuration,waveformDurationS:peaks ? peaks.length/100 : undefined,sourceBars:sourceMeasurements?.bars,rawUrl:sourceFile ? `st-media://local/music/${encodeURIComponent(sourceFile)}` : undefined,stems:stemUrls,stemsStartS:music.startS,url:arrangement ? cacheUrl(root,catalog) : `st-media://local/music/${encodeURIComponent(catalog)}`,arrangementSource:(record.music !== undefined ? record.music : record.assembly.reel.music)?.file,arrangementSummary:arrangement?.summary,arrangementSections:arrangement?.parts,arrangementState:await (await import('./music-arrange')).musicArrangementStatus(root,record,fx)} : null};
}

/** The lane envelope is assembled from the same source/time maps as live sound. */
export function liveVoicePeaks(plan: LiveSound): number[] {
  if(!plan.pieces.some(p=>p.peaks?.length))return [];
  return Array.from({length:Math.ceil(plan.durationS*100)},(_,i)=>{
    const t=i/100;let peak=0;
    for(const p of plan.pieces){if(p.muted||t<p.startS||t>=p.endS||!p.peaks?.length)continue;
      const right=p.timeMap.findIndex(k=>k.t>t),a=p.timeMap[Math.max(0,right<0?p.timeMap.length-2:right-1)],b=p.timeMap[right<0?p.timeMap.length-1:Math.max(1,right)];
      const source=a.s+(b.s-a.s)*(t-a.t)/(b.t-a.t||1);
      peak+= (p.peaks[Math.floor((source-(p.sourceStart ?? 0))*100)]??0)*10**(p.gainDb/20);
    }
    return peak;
  });
}
