import { musicStems, STEM_NAMES } from './stem-mix';
import { musicDuckKeys, stemDuckKeys } from '../shared/music-duck';
import { laneDb, laneMuted } from '../shared/lane-levels';
import { cutMusicKeys } from './music-duck';
import { attachedClipSounds } from './clip-sound';
import { sourceAudioInput, mapSourceAudioGraph } from './source-audio';
import { voiceoverAudio } from './voiceover-audio';
import { JOIN_FADE_S, voiceJoinFades } from '../shared/voice-edit';
import { voiceFilter } from './audio';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EditorInput } from './editors';
import { editorPlan } from './editor-timeline';
import { mapTime } from './edits-fx';
import { DEFAULT_AUDIO_FINISH, duckingFilter, bleepVoiceLevel } from './audio';
import { prepareDesignSounds } from './sound-design';
import { measureSourceAudio } from './voice-isolation';
import { currentActivity } from './activity';
import { playableMusic } from './music-file';

export type AudioKey = { t: number; gain: number };
export interface EditorAudioClip {
  file: string; name: string; s: number; d: number; track: number;
  kind: 'voice' | 'music' | 'sfx' | 'roomtone';
  soundLane?: import("../shared/schema").SoundLane; muted?: boolean; gainDb?: number; keys?: AudioKey[]; fadeInS?: number; fadeOutS?: number;
  item?: number; clipLayer?: 0 | 1;
  bleepLevelDb?: number; peakDb?: number | null;
}
type Render = (args: string[], duration?: number) => Promise<void>;
type Cache = (inputs: unknown, extension: string, render: (out: string) => Promise<void>) => Promise<string>;

/** Linear amplitude automation. Keep the hard redaction edge one sample wide. */
export function voiceKeys(layer: EditorAudioClip, spans: { s: number; e: number }[]): AudioKey[] {
  const times = new Set([0, layer.d]);
  for (const b of spans) if (b.s < layer.s + layer.d && b.e > layer.s) {
    for (const t of [b.s - 1 / 48000, b.s, b.e - 1 / 48000, b.e])
      times.add(Math.max(0, Math.min(layer.d, t - layer.s)));
  }
  return [...times].sort((a, b) => a - b).map(t => ({ t,
    gain: spans.some(b => layer.s + t >= b.s - 1e-9 && layer.s + t < b.e - 1e-9) ? 0 : 1 }));
}
/** PRO3c: with "dip under voice" off nothing ducks the music, but the director's stillnesses and hits still shape it. */
function shapeOnly(music: object, durationS: number): AudioKey[] | undefined {
  const shape = 'shape' in music ? (music as { shape?: import('../shared/music-shape').MusicShapeMark[] | null }).shape : undefined;
  return shape?.length ? musicDuckKeys([], durationS, undefined, shape) : undefined;
}
export function gainAt(keys: AudioKey[] | undefined, t: number): number {
  if (!keys?.length) return 1;
  if (t <= keys[0].t) return keys[0].gain;
  if (t >= keys.at(-1)!.t) return keys.at(-1)!.gain;
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < keys[mid].t) hi = mid; else lo = mid; }
  const a = keys[lo], b = keys[hi];
  return a.gain + (b.gain - a.gain) * (t - a.t) / (b.t - a.t);
}
function automation(layer: EditorAudioClip) {
  const keys = layer.keys ?? [{ t: 0, gain: 1 }, { t: layer.d, gain: 1 }];
  // aeval evaluates every sample, unlike volume's default audio-frame clock.
  const expressionFor = (lo: number, hi: number): string => {
    if (hi === lo) return String(keys[lo].gain);
    if (hi - lo === 1) {
      const a = keys[lo], b = keys[hi];
      return `${a.gain}+(${b.gain - a.gain})*(t-${a.t})/${b.t - a.t}`;
    }
    const mid = Math.floor((lo + hi) / 2);
    return `if(lt(t,${keys[mid].t}),${expressionFor(lo, mid)},${expressionFor(mid, hi)})`;
  };
  const expression = expressionFor(0, keys.length - 1);
  return `aeval=exprs='val(0)*(${expression})|val(1)*(${expression})',volume=${layer.muted ? 0 : 10**((layer.gainDb ?? 0)/20)}` +
    (layer.fadeInS ? `,afade=t=in:d=${layer.fadeInS}` : '') +
    (layer.fadeOutS ? `,afade=t=out:st=${layer.d - layer.fadeOutS}:d=${layer.fadeOutS}` : '');
}

/** Prepare portable sources, leaving gain, redaction and fades editable. DSP
 * without a portable native equivalent (cleanup, voice-band EQ, bus limiting)
 * lives in the source WAV; full-band ducking stays native automation. */
export async function prepareEditorAudio(i: EditorInput, folder: string, voice: EditorAudioClip[], cache: Cache, render: Render): Promise<EditorAudioClip[]> {
  const version = i.finishing ?? i.opts?.finishing ?? {}, cuts = i.selects?.cuts ?? i.cutList;
  const plan = editorPlan(cuts, i.template.fps, version), duration = plan.durationS;
  // Prepare inner sources/redactions even when their outer native lane is muted.
  const sourcePlan=version.laneLevels || version.laneMuted ? editorPlan(cuts,i.template.fps,{...version,clipSoundMuted:false}) : plan;
  const auto = (version.audio ?? DEFAULT_AUDIO_FINISH).auto !== false;
  const narration = version.voiceover?.lines.filter(l => l.take) ?? [];
  if (narration.length) voice.splice(0,voice.length,...voice.filter(p=>p.clipLayer===1 || p.item!==undefined && sourcePlan.items[p.item]?.muted===false));
  const clips: EditorAudioClip[] = [];
  const copy = async (file: string, name: string) => {
    const out = path.join(folder, 'Layers', name); await fs.copyFile(file, out); return out;
  };
  const identity = async (file: string) => { const stat = await fs.stat(file); return { file, size: stat.size, mtimeMs: stat.mtimeMs }; };
  const narrationSources = await voiceoverAudio(i.root, version.voiceover, version.audio);
  // VO7 Fades: 5 ms linear fades inside the kept audio where take audio was removed; untouched seams stay continuous.
  const joinFades = voiceJoinFades(narration);
  for (const [n, source] of narrationSources.entries()) {
    const line = source.line, d = source.d, eq = voiceFilter({ ...DEFAULT_AUDIO_FINISH, ...version.audio, clean: false });
    const prepared = await cache({ kind: 'voiceover-line-v2', source: await identity(source.file), s: source.start, d, eq }, '.wav', async out => render([
      '-ss', String(source.start), '-t', String(d), ...await sourceAudioInput(source.file), '-af', ['aresample=48000,aformat=channel_layouts=stereo',eq].filter(Boolean).join(','), '-c:a', 'pcm_s24le', out], d));
    voice.push({ file: await copy(prepared, `Voiceover ${n + 1}.wav`), name: `Voiceover: ${line.text}`, s: line.s, d, track: 0, kind: 'voice', soundLane:'voice', gainDb: laneDb(version,'voice'), muted:laneMuted(version,'voice'), fadeInS: joinFades.get(line.id)?.fadeInS ?? JOIN_FADE_S, fadeOutS: joinFades.get(line.id)?.fadeOutS ?? JOIN_FADE_S });
  }
  const redactions = (version.bleeps ?? []).flatMap(b => sourcePlan.items.flatMap(item => {
    const s = Math.max(b.s, item.timeMap[0].s), e = Math.min(b.e, item.timeMap.at(-1)!.s);
    return item.piece === b.piece && !item.muted && !item.reverse && e > s
      ? [{ s: mapTime(item.timeMap, s), e: mapTime(item.timeMap, e), sound: b.sound }] : [];
  }));
  for (const layer of voice) layer.keys = voiceKeys(layer, layer.clipLayer===1 ? [] : redactions);
  for (const [n, b] of redactions.entries()) {
    if (b.sound !== 'beep') continue;
    const layer = voice.find(v => v.item === plan.items.findIndex(p => b.s >= p.startS - 1e-7 && b.s < p.endS));
    const level = layer ? (layer.bleepLevelDb ?? await bleepVoiceLevel(i.root, { file: layer.file, filter: '', gainDb: 0, peakDb: null, speechLUFS: null }, 0, layer.d)) + (layer.gainDb ?? 0) : -20;
    const amplitude = Math.min(.7, Math.SQRT2 * 10 ** (level / 20)), d = b.e - b.s;
    const file = await cache({ kind: 'bleep', d, amplitude }, '.wav', out => render(['-f', 'lavfi', '-i',
      `aevalsrc=${amplitude}*sin(2*PI*1000*t)*min(1\\,min(t/0.005\\,(${d}-t)/0.005)):s=48000:d=${d}`,
      '-af', 'pan=stereo|c0=c0|c1=c0', '-c:a', 'pcm_s24le', out], d));
    clips.push({ file: await copy(file, `Bleep ${n + 1}.wav`), name: 'Bleep', s: b.s, d, track: 0, kind: 'sfx', soundLane:'clip-sound', muted:!!version.clipSoundMuted, gainDb: 0 });
  }
  const mix = async (layers: EditorAudioClip[], name: string) => cache({ kind: name, duration,
    layers: await Promise.all(layers.map(async l => ({ ...l, source: await identity(l.file) }))) }, '.wav', async out => {
    if (!layers.length) return render(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(duration), '-c:a', 'pcm_f32le', out], duration);
    const filters = layers.map((l, n) => `[${n}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${l.d},${automation(l)},adelay=${Math.round(l.s * 48000)}S:all=1,apad,atrim=duration=${duration}[a${n}]`);
    filters.push(layers.map((_, n) => `[a${n}]`).join('') + `amix=inputs=${layers.length}:normalize=0:duration=longest,asetnsamples=n=1024:p=1,asettb=1/48000[a]`);
    // Long edits must not hit the OS argument-length limit with their curves.
    const script = `${out}.filters`;
    try {
      await fs.writeFile(script, filters.join(';'));
      await render([...layers.flatMap(l => ['-i', l.file]), '-filter_complex_threads', '1', '-/filter_complex', script, '-map', '[a]', '-t', String(duration), '-c:a', 'pcm_f32le', out], duration);
    } finally { await fs.rm(script, { force: true }); }
  });
  const dry = await mix([...voice, ...clips], 'editor-dry-voice');
  const effects = await prepareDesignSounds(i.root, plan, version);
  const effectClips: EditorAudioClip[] = [];
  for (const [n, effect] of effects.entries()) {
    const sourceDuration = (await measureSourceAudio(i.root, effect.file)).durationS;
    const d = Math.min(effect.lengthS ?? duration, duration - effect.atS, effect.loopSamples ? duration : sourceDuration);
    if (!(d > 0)) continue;
    const file = await cache({ kind: 'editor-effect', source: await identity(effect.file), effect, d }, '.wav', async out => render([
      ...await sourceAudioInput(effect.file), '-af', `aresample=48000,aformat=channel_layouts=stereo,${effect.loopSamples ? `aloop=loop=-1:size=${effect.loopSamples},` : ''}apad,atrim=duration=${d}`,
      '-c:a', 'pcm_s24le', out], d));
    effectClips.push({ file: await copy(file, `Sound ${n + 1} ${effect.bed ? 'bed' : 'effect'}.wav`), name: effect.bed ? 'Room tone / ambience' : `Sound: ${path.basename(effect.file)}`,
      s: effect.atS, d, track: 0, kind: effect.bed ? 'roomtone' : 'sfx', soundLane:'effects', gainDb: (effect.gainDb ?? -12) + (effect.normalizeDb ?? 0) });
  }
  // Probe the same compressor with DC at unity. Its output is precisely the
  // gain applied to any main input, since detection uses only the sidechain.
  const curve = async (key: string, bus: 'music' | 'effects'): Promise<AudioKey[]> => {
    const file = await cache({ kind: 'editor-duck-v3', key: await identity(key), bus, duration }, '.f32', out => render([
      '-f', 'lavfi', '-i', `aevalsrc=1|1:s=48000:d=${duration + .25}`, '-i', key,
      '-filter_complex', `[1:a]apad,atrim=duration=${duration + .25}[key];[0:a][key]${duckingFilter(bus)},atrim=duration=${duration},pan=mono|c0=c0[a]`, '-map', '[a]', '-f', 'f32le', out], duration));
    const handle = await fs.open(file, 'r');
    try {
      const result: AudioKey[] = [], sample = Buffer.alloc(4), count = (await handle.stat()).size / 4;
      for (let frame = 0; frame <= Math.ceil(duration * i.template.fps); frame++) {
        currentActivity()?.signal.throwIfAborted();
        const t = Math.min(duration, frame / i.template.fps);
        await handle.read(sample, 0, 4, Math.max(0, Math.min(count - 1, Math.round(t * 48000))) * 4);
        result.push({ t, gain: sample.readFloatLE(0) });
      }
      return result.filter((k, n, a) => !n || k.t > a[n - 1].t);
    } finally { await handle.close(); }
  };
  if (auto && effectClips.length) {
    // A shared limiter envelope preserves the balance of overlapping effects.
    // The quiet third channel carries its gain without changing detection.
    const bus = await mix(effectClips, 'editor-effects');
    const peaks = voice.filter(l=>!l.muted).map(l => l.peakDb == null ? null : l.peakDb + (l.gainDb ?? 0));
    const peak = peaks.filter((p): p is number => p !== null);
    const ceiling = peak.length ? Math.min(.8, 10 ** ((Math.max(...peak) - 6) / 20)) : 10 ** (-18 / 20);
    const limit = await cache({ kind: 'editor-effects-limit-v2', source: await identity(bus), ceiling, duration }, '.wav', out => render([
      '-i', bus, '-f', 'lavfi', '-i', `aevalsrc=0.000001:s=48000:d=${duration + .25}`,
      '-filter_complex', `[0:a]apad,atrim=duration=${duration + .25},aresample=192000,aformat=sample_fmts=dbl:channel_layouts=stereo[a];[1:a]aresample=192000,aformat=sample_fmts=dbl:channel_layouts=mono[b];[a][b]amerge=inputs=2,alimiter=limit=${Math.max(.0625, ceiling)}:level=false:latency=true,volume=${ceiling < .0625 ? ceiling / .0625 : 1},aresample=48000,pan=mono|c0=c2,volume=1000000,atrim=duration=${duration}[g]`,
      '-map', '[g]', '-t', String(duration), '-c:a', 'pcm_f32le', out], duration));
    const duck = await curve(dry, 'effects');
    for (const [n, l] of effectClips.entries()) {
      const file = await cache({ kind: 'editor-effect-limited-v2', source: await identity(l.file), limit: await identity(limit), s: l.s, d: l.d }, '.wav', out => render([
        '-i', l.file, '-ss', String(l.s), '-i', limit, '-filter_complex', `[0:a]apad,atrim=duration=${l.d + .25}[effect];[1:a]pan=stereo|c0=c0|c1=c0,apad,atrim=duration=${l.d + .25}[g];[effect][g]amultiply,atrim=duration=${l.d}[a]`, '-map', '[a]', '-t', String(l.d), '-c:a', 'pcm_s24le', out], l.d));
      l.file = await copy(file, `Sound ${n + 1} auto mix.wav`);
      l.keys = [{ t: 0, gain: gainAt(duck, l.s) }, ...duck.filter(k => k.t > l.s && k.t < l.s + l.d).map(k => ({ ...k, t: k.t - l.s })), { t: l.d, gain: gainAt(duck, l.s + l.d) }];
    }
  }
  for(const clip of effectClips){clip.gainDb=(clip.gainDb ?? 0)+laneDb(version,'effects');clip.muted=laneMuted(version,'effects');}
  clips.push(...effectClips);
  const arranged = await (await import('./music-space')).musicForEdit(i.root,{music:version.music,assembly:{cutList:cuts,reel:i.opts?.reel ?? {cuts:[],why:''}}},plan,true,(await import('./music-arrange')).arrangedMusic);
  const music = arranged?.arrangement ? arranged.music : playableMusic(i.root, version.music !== undefined ? version.music : i.opts?.reel?.music);  // ONB1b: a missing file is left out, as live does
  if (music) {
    const musicEnd = Math.min(duration,music.endS ?? duration);
    const sourceFile = path.resolve(i.root,music.file);
    const stems = (!('duck' in music) || music.duck !== false) && (!('stemDucking' in music) || music.stemDucking !== false) ? (arranged?.arrangement ? arranged.arrangement.stems : await musicStems(i.root,sourceFile,true,{s:music.startS,e:music.startS+musicEnd})) : undefined;
    for(const stem of stems ? STEM_NAMES : ['mix'] as const) {
    const file = stems && stem !== 'mix' ? stems[stem] : sourceFile, gainDb = music.gainDb ?? i.opts?.reel?.music?.gainDb ?? -18;
    const prepared = await cache({ kind: 'editor-music-v3', source: await identity(file), dry: auto ? await identity(dry) : null, start: music.startS, musicEnd }, '.wav', async out => {
      const filters = [`[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${musicEnd + .25}[m]`];
      filters.push(`[m]atrim=duration=${musicEnd}[a]`);
      const args = ['-ss', String(stems ? 0 : music.startS), '-i', file];
      await mapSourceAudioGraph(args, filters);
      return render([...args, '-filter_complex', filters.join(';'), '-map', '[a]', '-t', String(musicEnd), '-c:a', 'pcm_s24le', out], musicEnd);
    });
    clips.push({ file: await copy(prepared, stem==='mix' ? 'Music.wav' : `Music ${stem}.wav`), name: path.basename(music.file), s: 0, d: musicEnd, track: 0, kind: 'music', soundLane:'music', gainDb:gainDb+laneDb(version,'music'),muted:laneMuted(version,'music'),
      fadeOutS: Math.min(arranged?.arrangement ? .012 : 1.5, musicEnd), keys: (!('duck' in music) || music.duck !== false) ? (keys=>stem==='mix' ? keys : stemDuckKeys(keys,stem))(cutMusicKeys(cuts, plan, { ...version, music }, attachedClipSounds(i.opts?.reel?.broll ?? [], plan, version, i.template.fps))) : shapeOnly(music, plan.durationS) });
    }
  }
  const ends: number[] = [];
  for (const clip of [...clips].sort((a, b) => a.s - b.s)) {
    let track = clip.kind === 'music' ? 0 : clip.kind === 'roomtone' ? 1 : 2;
    while ((ends[track] ?? 0) > clip.s + 1e-7) track++;
    clip.track = track; ends[track] = clip.s + clip.d;
  }
  return clips;
}
