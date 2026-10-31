import { laneDb, laneMuted, heardPiece, mixOutputDb, mixCeiling, musicEnd as musicEndOf, duckedUnder, musicStems } from '../../../shared/lane-levels';
import { musicDuckKeys, duckGainAt, stemDuckKeys, type DuckKey } from '../../../shared/music-duck';
import type { AudioFinish, DraftTimeline } from '../../../shared/schema';
import type { LiveSound, LiveSoundPiece } from '../../../main/live-sound-types';
import { VoiceScheduler, FADE_S, VOICE_START_S, type VoicePiece } from './planAudio';
export type LiveSoundTimeline = DraftTimeline & { liveSound?: LiveSound };
/** PRO3c: the music plays at its own level only with no duck and no shape; a shape applies with "dip under voice" off. */
const flatMusic = (music: LiveSound['music'] | undefined) => music?.duck === false && !music.shape?.length;
export const liveSoundPreviews = new WeakMap<DraftTimeline, Partial<Pick<LiveSound, 'audio' | 'music' | 'pieces' | 'laneLevels' | 'laneMuted'>>>();
const soundListeners = new WeakMap<DraftTimeline, () => void>();
export function listenLiveSound(timeline: DraftTimeline, listener: () => void) {
  soundListeners.set(timeline, listener);
  return () => { if (soundListeners.get(timeline) === listener) soundListeners.delete(timeline); };
}
export function previewLiveSound(timeline: DraftTimeline, value: Partial<Pick<LiveSound, 'audio' | 'music' | 'pieces' | 'laneLevels' | 'laneMuted'>>) {
  liveSoundPreviews.set(timeline, {...liveSoundPreviews.get(timeline),...value});
  soundListeners.get(timeline)?.();
}
export function clearLiveSoundPreview(timeline:DraftTimeline,key:'laneLevels'|'pieces'|'music') {
  const preview=liveSoundPreviews.get(timeline);if(preview)delete preview[key];
  soundListeners.get(timeline)?.();
}
// A few nearby choices are decoded ahead of the click, without auditioning.
// The live graph takes ownership of the warmed element, avoiding a second load.
const warmMusicElements = new Map<string, HTMLAudioElement>();
export function warmLiveMusic(url: string) {
  if (warmMusicElements.has(url) || typeof document.createElement !== 'function') return;
  const element = document.createElement('audio');
  element.crossOrigin = 'anonymous'; element.preload = 'auto'; element.src = url; element.load();
  warmMusicElements.set(url, element);
  while (warmMusicElements.size > 3) {
    const key = warmMusicElements.keys().next().value!;
    const old = warmMusicElements.get(key)!;
    warmMusicElements.delete(key); old.removeAttribute('src'); old.load();
  }
}
const gain = (db: number) => 10 ** (db / 20);
export function mixPosition(piece: LiveSoundPiece, time: number) {
  const keys = piece.timeMap;
  const right = keys.findIndex(k => k.t > time), i = right < 0 ? keys.length - 2 : Math.max(0, right - 1);
  const a = keys[i], b = keys[i + 1] ?? a, rate = (b.s - a.s) / (b.t - a.t || 1);
  return { source: a.s + (time - a.t) * rate - (piece.sourceStart ?? 0), rate };
}
export function spanGain(piece: LiveSoundPiece, time: number) {
  return (piece.muted ? 0 : gain(piece.gainDb)) * Math.max(0, Math.min(1,
    piece.fadeInS ? (time - piece.startS) / piece.fadeInS : 1,
    piece.fadeOutS ? (piece.endS - time) / piece.fadeOutS : 1));
}

// ---- VO7-14: hear the edit while scrubbing, frame stepping and shuttling in reverse.
/** Scrub grain length, wall seconds. 60 ms is the middle of the 40 to 80 ms range asked for: long enough to carry
 * one speech sound (most last 50 to 100 ms), short enough that a chain of grains keeps up with a pointer that
 * moves every display frame. Fixed, as an audio engineering constant. */
export const GRAIN_S = 0.06;
/** A grain's speed follows the pointer's, within these bounds. 1/4 is the K+L creep: slower than that, speech is a
 * rumble nobody can place. Above 4x a 60 ms grain spans a quarter second of the edit and words smear into chatter. */
export const SCRUB_RATES = [0.25, 4] as const;
/** Audio is scheduled this far ahead of the clock so every source starts on an exact sample (as planAudio does). */
const LEAD_S = 0.01;
/** One sound of the mix a grain can be cut from: a decoded file and how the edit maps onto it. */
export type GrainSource = {
  id: string; url?: string; buffer: AudioBuffer; out: AudioNode; startS: number; endS: number; loop?: boolean;
  /** File seconds and file seconds per reel second at reel `t`. */
  at: (t: number) => { offset: number; rate: number };
  /** Linear level at reel `t` (fades, levels, bleeps), and the reel times where that level bends. */
  level: (t: number) => number; knots?: number[];
};
export type GrainTrace = { kind: 'scrub' | 'blip' | 'reverse' | 'lab'; id: number; scheduledAt: number; when: number; end: number; from: number; to: number; rate: number; reverse: boolean;
  sources: { id: string; url?: string; start: number; end: number; offset: number; duration: number; playbackRate: number; level: number }[] };
const grainTraces: GrainTrace[] = [];
let grainRuns = 0;
const reversedBuffers = new WeakMap<AudioBuffer, AudioBuffer>();
function reversedBuffer(buffer: AudioBuffer) {
  let out = reversedBuffers.get(buffer);
  if (!out) {
    out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate });
    for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).slice().reverse(), c);
    reversedBuffers.set(buffer, out);
  }
  return out;
}
/** Just the samples of [fileA, fileB], reversed: a scrub grain copies a few thousand samples, never the whole file. */
function reversedSegment(buffer: AudioBuffer, fileA: number, fileB: number) {
  const sr = buffer.sampleRate, a = Math.max(0, Math.floor(fileA * sr)), b = Math.min(buffer.length, Math.ceil(fileB * sr));
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: Math.max(1, b - a), sampleRate: sr });
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).slice(a, b).reverse(), c);
  return { buffer: out, offset: b / sr - fileB };
}
export type GrainNodes = { nodes: { source: AudioBufferSourceNode; gain: GainNode }[]; end: number; trace: GrainTrace };
/** Play reel seconds [from, to] of `sources` at `rate`, forwards or reversed, starting at context time `when`. Every
 * source fades in and out over 5 ms (FADE_S, the export's join fade) at its edges, so nothing clicks; between edges
 * its level follows the mix's own level curve. Works on any context, so QA can render it offline. */
export function scheduleGrain(c: BaseAudioContext, sources: GrainSource[], opts: { when: number; from: number; to: number; rate: number; reverse: boolean; kind: GrainTrace['kind'] }): GrainNodes {
  const { when, from, to, rate, reverse } = opts, end = when + (to - from) / rate;
  const trace: GrainTrace = { kind: opts.kind, id: ++grainRuns, scheduledAt: performance.now(), when, end, from, to, rate, reverse, sources: [] };
  const out: GrainNodes = { nodes: [], end, trace };
  for (const s of sources) {
    let a = Math.max(from, s.startS), b = Math.min(to, s.endS);
    if (!(b - a > 1e-4)) continue;
    const pa = s.at(a), pb = s.at(b), fileRate = Math.max(1e-6, pa.rate);
    let fileA = pa.offset, fileB = s.loop ? pa.offset + (b - a) * fileRate : pb.offset;
    // Only what the file holds: a piece can start before its file (a delay) or run past its end.
    if (fileA < 0) { a += -fileA / fileRate; fileA = 0; }
    if (!s.loop && fileB > s.buffer.duration) { b -= (fileB - s.buffer.duration) / fileRate; fileB = s.buffer.duration; }
    if (!(b - a > 1e-4) || !(fileB > fileA)) continue;
    const toWall = (t: number) => when + (reverse ? to - t : t - from) / rate;
    const start = Math.min(toWall(a), toWall(b)), end = Math.max(toWall(a), toWall(b)), fade = Math.min(FADE_S, (end - start) / 2);
    const reelAt = (w: number) => reverse ? b - (w - start) * rate : a + (w - start) * rate;
    // Reversed: J reverses each whole file once (kept); a scrub grain reverses only its own few samples. A looped
    // tone reads the same either way.
    const piece = reverse && !s.loop && opts.kind !== 'reverse' ? reversedSegment(s.buffer, fileA, fileB) : null;
    const buffer = piece ? piece.buffer : reverse && !s.loop ? reversedBuffer(s.buffer) : s.buffer;
    const playbackRate = rate * (fileB - fileA) / (b - a);
    const offset = piece ? piece.offset : reverse && !s.loop ? s.buffer.duration - fileB : s.loop ? fileA % s.buffer.duration : fileA;
    const source = new AudioBufferSourceNode(c, { buffer, playbackRate, loop: !!s.loop }), gain = new GainNode(c, { gain: 0 });
    // The envelope, in wall time: up from silence, the level curve through its bends, down to silence.
    const points: [number, number][] = [[start, 0], [start + fade, s.level(reelAt(start + fade))], [end - fade, s.level(reelAt(end - fade))], [end, 0]];
    for (const k of s.knots ?? []) if (k > a && k < b) { const w = toWall(k); if (w > start + fade && w < end - fade) points.push([w, s.level(k)]); }
    points.sort((x, y) => x[0] - y[0]);
    gain.gain.setValueAtTime(0, start);
    for (const [w, v] of points.slice(1)) gain.gain.linearRampToValueAtTime(v, w);
    source.connect(gain).connect(s.out);
    source.start(start, Math.max(0, offset), s.loop ? undefined : fileB - fileA);
    source.stop(end);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    out.nodes.push({ source, gain });
    trace.sources.push({ id: s.id, url: s.url, start, end, offset: fileA, duration: fileB - fileA, playbackRate, level: s.level((a + b) / 2) });
  }
  grainTraces.push(trace); if (grainTraces.length > 400) grainTraces.splice(0, 200);
  (globalThis as { __precutGrains?: GrainTrace[] }).__precutGrains = grainTraces;
  return out;
}
/** Bring scheduled grains down to silence over 5 ms from now (never a hard stop: that clicks). */
function fadeGrains(c: BaseAudioContext, run: GrainNodes | null | undefined) {
  if (!run) return;
  const now = c.currentTime;
  for (const { source, gain } of run.nodes) {
    try {
      if (typeof gain.gain.cancelAndHoldAtTime === 'function') gain.gain.cancelAndHoldAtTime(now); else { gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(gain.gain.value, now); }
      gain.gain.linearRampToValueAtTime(0, now + FADE_S);
      source.stop(now + FADE_S + .001);
    } catch { /* already ended */ }
  }
}
type Slot ={ element: HTMLAudioElement; source: MediaElementAudioSourceNode; gain: GainNode; piece: LiveSoundPiece; ready: boolean; fallback?: boolean };
/** One graph for the lifetime of an edit. Media elements preserve speech pitch at
 * changed speed; WebAudio supplies sample-clock gains, EQ and voice-keyed ducking.
 * Only active/nearby spans own decoders. A replacement is published after seek. */
export class LiveMix {
  private context?: AudioContext;
  private voice?: GainNode; private music?: GainNode; private effects?: GainNode; private output?: GainNode; private limiter?: DynamicsCompressorNode;
  private analyser?: AnalyserNode; private samples?: Float32Array<ArrayBuffer>;
  private eq: BiquadFilterNode[] = [];
  private slots = new Map<string, Slot>();
  private plan?: LiveSound; private muted = false; private musicMuted = false; private voiceMuted = false;
  private duckPieces?: LiveSoundPiece[]; private duckDepth?: number; private duckShape?: NonNullable<LiveSound['music']>['shape']; private duckVoiceMuted=false; private duckOff=false; private duckKeys: DuckKey[] = [];
  // VO7-9: placed voice plays through one prewarmed Web Audio schedule on the voice bus, sample-accurate
  // with the export's fades and on past the picture's end. Media elements keep clip sound and music.
  private narration?: GainNode;
  private voiceSchedule: VoiceScheduler;
  constructor(private failed: (message:string)=>void = ()=>{}) {
    this.voiceSchedule = new VoiceScheduler(() => this.context, () => this.narration, message => this.failed(message));
  }
  /** The voice pieces to schedule (from the placed lines, so voice past the picture's end is included). */
  updateVoice(pieces: VoicePiece[]) { this.voiceSchedule.setPieces(pieces); }
  /** Reel seconds on the audio clock while voice plays, for QA and the player. */
  voicePosition() { return this.voiceSchedule.position(); }
  private buffers = new Map<string,AudioBuffer>();
  private loading = new Map<string,Promise<void>>();
  private scheduled = new Map<string,{source:AudioBufferSourceNode;gain:GainNode;anchor:number;rate:number}>();
  private generation=0; private position=0; private failedBuffers=new Set<string>();
  update(plan: LiveSound) {
    this.plan = plan;
    // VO7-14: decoded grain files the plan no longer plays are let go (a prepared piece replaced its raw sound), and
    // the ones it plays are decoded when the page is idle, so the first scrub or arrow step has them.
    if (this.grainFiles.size) {
      const used = new Set([...plan.pieces.flatMap(p => [p.url, p.rawUrl]), plan.music?.url]);
      for (const [url, held] of this.grainFiles) if (!used.has(url)) { held.release(); this.grainFiles.delete(url); }
    }
    // Only once the mix is open (something has played or sounded): an edit nobody listens to decodes nothing.
    const warm = () => { if (this.plan !== plan || !this.context) return; for (const p of plan.pieces) if (!p.id.startsWith('voiceover:') && !p.muted) this.grainFile(this.heard(plan, p).url); if (plan.music && !plan.music.stems) this.grainFile(plan.music.url); };
    if (this.context) { if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 4000 }); else if (typeof setTimeout === 'function') setTimeout(warm, 1000); }
    if(plan.music?.stems){this.open();Object.values(plan.music.stems).forEach(url=>this.loadBuffer(url,'music'));}
    if(plan.effects.length){this.open();plan.effects.filter(p=>p.endS>this.position && p.startS<this.position+2).slice(0,16).forEach(p=>this.loadBuffer(p.url));}
  }
  private loadBuffer(url:string,kind:'effect'|'music'='effect') {
    if(this.buffers.has(url)||this.loading.has(url)||this.failedBuffers.has(url))return;
    const c=this.context!,generation=this.generation;
    const work=fetch(url).then(response=>{if(!response.ok)throw Error("Couldn't load this sound effect.");return response.arrayBuffer();})
      .then(bytes=>c.decodeAudioData(bytes)).then(buffer=>{
        if(generation!==this.generation)return;
        this.buffers.set(url,buffer);
        while(this.buffers.size>16)this.buffers.delete(this.buffers.keys().next().value!);
      }).catch(error=>{if(generation===this.generation){this.failedBuffers.add(url);this.failed(kind==='music' ? "Couldn't play the separated music. The original mix plays." : "Couldn't play a sound effect. The rest plays.");}});
    this.loading.set(url,work);void work.finally(()=>{if(this.loading.get(url)===work)this.loading.delete(url);});
  }
  private syncEffects(time:number,playing:boolean,rate:number,plan:LiveSound) {
    const c=this.context!,keep=new Set<string>();
    for(const p of plan.effects){
      if(!playing||p.endS<=time||p.startS>time+.3)continue;
      const key=JSON.stringify([p.id,p.url,p.startS,p.endS]);keep.add(key);
      const buffer=this.buffers.get(p.url);
      if(!buffer){this.loadBuffer(p.url);continue;}
      let slot=this.scheduled.get(key);
      if(slot && (slot.rate!==rate || Math.abs(slot.anchor+(c.currentTime-time/rate))>.12)){
        slot.source.stop();slot.source.disconnect();slot.gain.disconnect();this.scheduled.delete(key);slot=undefined;
      }
      if(!slot){
        let offset=Math.max(0,time-p.startS);if(p.loop)offset%=buffer.duration;
        if(offset>=buffer.duration)continue;
        const source=c.createBufferSource(),node=c.createGain();source.buffer=buffer;source.loop=!!p.loop;source.playbackRate.value=rate;
        source.connect(node);node.connect(this.effects!);
        const when=c.currentTime+Math.max(0,p.startS-time)/rate;
        node.gain.value=spanGain(p,Math.max(time,p.startS));source.start(when,offset);source.stop(c.currentTime+Math.max(0,p.endS-time)/rate);
        slot={source,gain:node,anchor:time/rate-c.currentTime,rate};this.scheduled.set(key,slot);
      }
      slot.gain.gain.setTargetAtTime(spanGain(p,Math.max(time,p.startS)),c.currentTime,.005);
    }
    for(const [key,slot] of this.scheduled)if(!keep.has(key)){slot.source.stop();slot.source.disconnect();slot.gain.disconnect();this.scheduled.delete(key);}
  }
  private stemSources = new Map<string,{source:AudioBufferSourceNode;gain:GainNode;anchor:number;rate:number}>();
  private syncStemMusic(time:number,playing:boolean,rate:number,plan:LiveSound,ready:boolean) {
    const c=this.context!, keep=new Set<string>();
    if(playing && ready && plan.music?.stems && time < Math.min(plan.durationS,plan.music.endS ?? plan.durationS)) for(const name of ['vocals','other','drums','bass'] as const) {
      const url=plan.music.stems[name],key=name+':'+url+':'+plan.music.startS+':'+plan.music.stemsStartS,buffer=this.buffers.get(url)!;
      const offset=plan.music.startS-(plan.music.stemsStartS ?? 0)+time;
      if(offset>=buffer.duration)continue;
      keep.add(key);let slot=this.stemSources.get(key);
      if(slot && (slot.rate!==rate || Math.abs(slot.anchor+c.currentTime-time/rate)>.12)) {
        slot.source.stop();slot.source.disconnect();slot.gain.disconnect();this.stemSources.delete(key);slot=undefined;
      }
      const musicEnd=Math.min(plan.durationS,plan.music.endS ?? plan.durationS);
      const keys=stemDuckKeys(this.duckKeys,name),fade=(t:number)=>Math.max(0,Math.min(1,(musicEnd-t)/Math.min(plan.music?.arrangementState==='ready' ? .012 : 1.5,musicEnd)));
      const level=(t:number)=>gain(plan.music!.gainDb ?? -18)*fade(t)*(flatMusic(plan.music) ? 1 : duckGainAt(keys,t));
      if(!slot) {
        const source=c.createBufferSource(),node=c.createGain();source.buffer=buffer;source.playbackRate.value=rate;
        source.connect(node);node.connect(this.music!);node.gain.value=level(time);
        source.start(c.currentTime,Math.max(0,offset));slot={source,gain:node,anchor:time/rate-c.currentTime,rate};this.stemSources.set(key,slot);
      }
      slot.gain.gain.cancelScheduledValues(c.currentTime);slot.gain.gain.setValueAtTime(level(time),c.currentTime);
      slot.gain.gain.linearRampToValueAtTime(level(time+.02),c.currentTime+.02/rate);
    }
    for(const [key,slot] of this.stemSources)if(!keep.has(key)) {slot.source.stop();slot.source.disconnect();slot.gain.disconnect();this.stemSources.delete(key);}
  }
  /** A clip sound or voice piece as it is heard: its level with even-out and lane changes, its mute, and the raw
   * file when Clean is off. Shared by playback and the scrub grains (VO7-14), so both hear the same thing. */
  private heard(plan: LiveSound, original: LiveSoundPiece): LiveSoundPiece { return heardPiece(plan, original, this.plan!); }
  setMuted(muted: boolean, music = false, voice = false) { this.muted = muted; this.musicMuted = music; this.voiceMuted=voice; }
  private open() {
    if (this.context) return;
    this.context = new AudioContext();
    const c = this.context;
    this.voice = c.createGain(); this.music = c.createGain(); this.effects = c.createGain(); this.output = c.createGain();
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 512;
    this.samples = new Float32Array(this.analyser.fftSize);
    let tail: AudioNode = this.voice;
    for (const [type, frequency] of [['lowshelf',120],['peaking',2500],['highshelf',8000]] as const) {
      // PAR1: the export's voice EQ (audio.ts voiceFilter): shelves at width 0.707, the 2.5 kHz band at Q 1.
      const filter = c.createBiquadFilter(); filter.type = type; filter.frequency.value = frequency; filter.Q.value = type === 'peaking' ? 1 : .707;
      tail.connect(filter); tail = filter; this.eq.push(filter);
    }
    tail.connect(this.analyser); this.analyser.connect(this.output);
    this.narration = c.createGain(); this.narration.connect(this.voice);
    this.music.connect(this.output); this.effects.connect(this.output);
    // PAR1: a hard knee at the export limiter's ceiling (the default 30 dB soft knee barely limited at all).
    const limiter = this.limiter = c.createDynamicsCompressor(); limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = .001; limiter.release.value = .1;
    this.output.connect(limiter); limiter.connect(c.destination);
  }
  private create(piece: LiveSoundPiece, bus: 'voice' | 'music' | 'effect', time: number): Slot {
    const warmed = bus === 'music' ? warmMusicElements.get(piece.url) : undefined;
    if (warmed) warmMusicElements.delete(piece.url);
    const c = this.context!, element = warmed ?? document.createElement('audio');
    element.crossOrigin = 'anonymous'; element.preload = 'auto';
    const source = c.createMediaElementSource(element), node = c.createGain(); node.gain.value = 0;
    element.preservesPitch = true; source.connect(node); node.connect(bus === 'music' ? this.music! : bus === 'voice' ? this.voice! : this.effects!);
    const slot: Slot = { element, source, gain: node, piece, ready: false };
    const position = () => { element.currentTime = Math.max(0, mixPosition(slot.piece, time).source); };
    element.onloadedmetadata = position;
    element.onseeked = element.oncanplay = () => { if (!element.seeking && element.readyState >= 2) slot.ready = true; };
    element.onerror = () => {
      if (!slot.fallback && piece.rawUrl && piece.rawUrl !== piece.url) {
        slot.fallback=true;slot.ready=false;slot.piece={...piece,url:piece.rawUrl,sourceStart:piece.rawSourceStart};element.src=piece.rawUrl;element.load();
      // Plain words only: the browser's own message (DEMUXER_ERROR_...) never reaches the screen.
      } else this.failed(bus === 'music' ? "Couldn't find this edit's music, so it plays without it." : bus === 'voice' ? "Couldn't play this take's sound." : "Couldn't play a sound effect. The rest plays.");
    };
    element.loop = !!piece.loop;
    if (warmed) { if (element.readyState >= 1) position(); slot.ready = element.readyState >= 2 && !element.seeking; }
    else { element.src = piece.url; element.load(); }
    return slot;
  }
  sync(time: number, playing: boolean, rate = 1, preview?: Partial<Pick<LiveSound, 'audio' | 'music' | 'pieces' | 'laneLevels' | 'laneMuted'>>) {
    if (!this.plan) return; this.position=time;
    if (!playing && !this.context) return;
    this.open(); const c = this.context!, plan = { ...this.plan, ...preview };
    if (playing && c.state === 'suspended') void c.resume().catch(() => {});
    // PAR1: while playing, the sound is scheduled ahead of the picture clock by the time it takes to be heard, so a
    // sample reaches the speakers when its picture reaches the screen (see lead()).
    if (playing) time += this.lead() * rate; else this.frameAt = 0;
    const audio: Partial<AudioFinish> = plan.audio ?? {};
    this.eq.forEach((node, i) => { node.gain.value = audio.eq?.[(['low','mid','high'] as const)[i]] ?? 0; });
    // Prepared auto voice is matched to -20 LUFS by prepareVoicePiece.
    const level = mixOutputDb(plan, this.plan);
    // PAR1: the export's master stage: its gain, then its ceiling. A Web Audio compressor always adds make-up gain, by
    // the spec (the curve at full scale, inverted, to the power 0.6); the export's limiter adds none, so it comes off here.
    const ceilingDb = 20 * Math.log10(mixCeiling(plan, this.plan)), makeupDb = 0.6 * -ceilingDb * (1 - 1 / this.limiter!.ratio.value);
    if (Math.abs(this.limiter!.threshold.value - ceilingDb) > 1e-3) this.limiter!.threshold.value = ceilingDb;
    this.output!.gain.value = this.muted ? 0 : gain(level - makeupDb);
    this.analyser!.getFloatTimeDomainData(this.samples!);
    const rms = Math.sqrt(this.samples!.reduce((n, sample) => n + sample * sample, 0) / this.samples!.length);
    const narrationMuted=this.voiceMuted || laneMuted(plan,'voice');
    // PRO3a: the music's stillnesses and hit dips ride on the duck, as in the export (shared/music-shape.ts).
    // PRO3c: with "dip under voice" off nothing ducks it, and the shape still applies.
    const duckOff=plan.music?.duck===false;
    if(this.duckPieces!==plan.pieces || this.duckDepth!==plan.music?.duckDepthDb || this.duckVoiceMuted!==narrationMuted || this.duckShape!==plan.music?.shape || this.duckOff!==duckOff) {
      this.duckPieces=plan.pieces; this.duckDepth=plan.music?.duckDepthDb; this.duckVoiceMuted=narrationMuted; this.duckShape=plan.music?.shape; this.duckOff=duckOff;
      const audible=duckOff ? [] : duckedUnder(plan,narrationMuted);
      this.duckKeys=musicDuckKeys(audible,plan.durationS,plan.music?.duckDepthDb,plan.music?.shape);
    }

    const stemFiles = plan.music?.stemDucking !== false ? plan.music?.stems : undefined;
    const stemsReady = !!musicStems(plan) && Object.values(stemFiles!).every(url=>this.buffers.has(url));
    if(stemFiles) Object.values(stemFiles).forEach(url=>this.loadBuffer(url,'music'));
    const musicGain=this.music!.gain;
    musicGain.cancelScheduledValues?.(c.currentTime);
    const musicLane = laneMuted(plan,'music') ? 0 : gain(laneDb(plan,'music'));
    musicGain.value = this.musicMuted ? 0 : musicLane * (stemsReady || flatMusic(plan.music) ? 1 : duckGainAt(this.duckKeys,time));
    // Interpolate on the audio clock between animation frames, including a seek.
    if(playing && !this.musicMuted && !stemsReady && !flatMusic(plan.music)) {
      musicGain.setValueAtTime?.(musicGain.value,c.currentTime);
      musicGain.linearRampToValueAtTime?.(musicLane*duckGainAt(this.duckKeys,time+.02),c.currentTime+.02/rate);
    }
    this.voice!.gain.value=this.voiceMuted && !plan.pieces.some(p=>p.id.startsWith("voiceover:")) ? 0 : 1;
    this.effects!.gain.value = (laneMuted(plan,'effects') ? 0 : gain(laneDb(plan,'effects'))) * (audio.auto === false ? 1 : rms > .025 ? (.025/rms)**(1-1/6) : 1);
    const wanted: [LiveSoundPiece, 'voice' | 'music' | 'effect'][] = plan.pieces.map(original => [this.heard(plan, original), 'voice']);
    const { endS: musicEnd, fadeOutS: musicFadeS } = musicEndOf(plan);
    if (plan.music) wanted.push([{ muted:stemsReady, id: 'music', url: plan.music.url, startS: 0, endS: musicEnd, sourceStart: 0,
      timeMap: [{t:0,s:plan.music.startS},{t:plan.durationS,s:plan.music.startS+plan.durationS}], gainDb: plan.music.gainDb ?? -18, fadeOutS: musicFadeS }, 'music']);
    const narrationGain = narrationMuted ? 0 : gain(laneDb(plan,'voice'));
    if (Math.abs(this.narration!.gain.value - narrationGain) > 1e-4) this.narration!.gain.setTargetAtTime(narrationGain, c.currentTime, .005);
    this.voiceSchedule.follow(time, playing, rate);
    this.syncStemMusic(time,playing,rate,plan,stemsReady);
    this.syncEffects(time,playing,rate,plan);
    const keep = new Set<string>();
    for (const [piece,bus] of wanted) {
      // Muted camera sound must not open the original movie's video decoder.
      // Unmuting creates/seeks its audio slot at the current composition time.
      if (piece.muted || piece.endS <= time || piece.startS > time + .3 || piece.id.startsWith('voiceover:')) continue;
      const key = JSON.stringify([piece.id,piece.url,piece.startS,piece.timeMap[0].s]); keep.add(key);
      let slot = this.slots.get(key);
      if (!slot) { slot = this.create(piece,bus,Math.max(time,piece.startS)); this.slots.set(key,slot); }
      slot.piece = slot.fallback ? {...piece,sourceStart:piece.rawSourceStart} : piece;
      const position = mixPosition(slot.piece, Math.max(time,piece.startS));
      if(piece.loop && slot.element.duration>0 && Number.isFinite(slot.element.duration))position.source %= slot.element.duration;
      // V63: past the end of the file is silence. Seeking there every frame
      // ended the element, play() restarted it from zero and it buzzed.
      const pastEnd = !piece.loop && slot.element.readyState >= 1 && Number.isFinite(slot.element.duration) && position.source >= slot.element.duration - .005;
      if (!pastEnd && slot.element.readyState >= 1 && Math.abs(slot.element.currentTime - position.source) > .12 && !slot.element.seeking) {
        slot.ready = false; slot.element.currentTime = Math.max(0,position.source);
      }
      // Start decoding/seeking immediately. The media element itself waits for
      // data; waiting for another animation frame here adds audible latency.
      const running = playing && !pastEnd && !(bus==='music' && stemsReady) && position.source >= 0 && time >= piece.startS && time < piece.endS;
      const redacted = bus === 'voice' && (piece.layer ?? 0)===0 && plan.bleeps.some(b => time >= b.s && time < b.e);
      slot.gain.gain.setTargetAtTime(running && !redacted && !(this.voiceMuted && piece.id.startsWith("voiceover:")) ? spanGain(piece,time) : 0,c.currentTime,.005);
      slot.element.playbackRate = Math.max(.0625,Math.min(16,position.rate * rate));
      if (running && slot.element.paused) void slot.element.play().catch(() => {});
      if (!running) slot.element.pause();
      // Keep raw sound audible until its prepared replacement has decoded.
      for (const [oldKey,old] of this.slots) if (oldKey !== key && old.piece.id === piece.id && !slot.ready) keep.add(oldKey);
    }
    for (const [key,slot] of this.slots) if (!keep.has(key)) { this.release(slot); this.slots.delete(key); }
    this.updateBleep(time,playing,plan);
  }
  // ---- PAR1: sound and picture together. The picture clock says what is drawn now; a frame drawn now is on screen one
  // display refresh later. A sample scheduled now is heard after the context's render-to-output latency (its own
  // output timestamps say it, Bluetooth included), and placed voice starts 10 ms after its schedule (VoiceScheduler).
  private frameAt = 0; private refreshS = 1 / 60; private latencyS: number | null = null;
  private lead() {
    const c = this.context!, now = performance.now();
    // One display refresh: the interval between the frames that call sync while playing (smoothed, 4 to 50 ms).
    if (this.frameAt) { const dt = (now - this.frameAt) / 1000; if (dt > .004 && dt < .05) this.refreshS += (dt - this.refreshS) * .05; }
    this.frameAt = now;
    const stamp = typeof c.getOutputTimestamp === 'function' ? c.getOutputTimestamp() : null;
    if (stamp?.contextTime && stamp.performanceTime) {
      const heard = stamp.contextTime + (now - stamp.performanceTime) / 1000, measured = c.currentTime - heard;
      if (measured > 0 && measured < .5) this.latencyS = this.latencyS === null ? measured : this.latencyS + (measured - this.latencyS) * .05;
    }
    const latency = this.latencyS ?? (c.baseLatency || 0) + (c.outputLatency || 0);
    return Math.max(0, Math.min(.5, latency + VOICE_START_S - this.refreshS));
  }
  private tone?: OscillatorNode; private toneGain?: GainNode;
  private updateBleep(time: number, playing: boolean, plan: LiveSound) {
    const c = this.context!;
    if (!this.tone) { this.tone = c.createOscillator(); this.tone.frequency.value = 1000; this.toneGain = c.createGain(); this.toneGain.gain.value = 0; this.tone.connect(this.toneGain); this.toneGain.connect(this.output!); this.tone.start(); }
    this.toneGain!.gain.setTargetAtTime(playing && plan.bleeps.some(b => b.sound === 'beep' && time >= b.s && time < b.e) ? Math.SQRT2 * .1 * gain(laneDb(plan,'clip-sound')) : 0,c.currentTime,.005);
  }
  pause() { this.voiceSchedule.stop(); if(this.context)this.syncStemMusic(0,false,1,this.plan ?? {} as LiveSound,false); this.syncEffects(0,false,1,this.plan ?? {effects:[]} as unknown as LiveSound); this.slots.forEach(slot => slot.element.pause()); if (this.toneGain) this.toneGain.gain.value = 0; }
  private release(slot: Slot) { slot.element.pause(); slot.element.onloadedmetadata = slot.element.onseeked = slot.element.oncanplay = slot.element.onerror = null; slot.element.removeAttribute('src'); slot.element.load(); slot.source.disconnect(); slot.gain.disconnect(); }
  // ---- VO7-14: scrub grains, frame blips and reverse play, cut from the same plan, levels and buses as playback.
  private grainFiles = new Map<string, { release: () => void; buffer: AudioBuffer | null }>();
  private scrubRun: { reel: number; wall: number; run: GrainNodes } | null = null;
  private blipRun: GrainNodes | null = null; private reverseRun: GrainNodes | null = null;
  private beepBuffer?: AudioBuffer;
  /** A file's decoded sound for grains, or null while it decodes. Only audio files are decoded: a camera
   * original (a movie) is never pulled whole into memory; its piece is heard once its prepared sound exists. */
  private grainFile(url: string): AudioBuffer | null {
    const held = this.grainFiles.get(url);
    if (held) return held.buffer;
    const entry = { release: () => {}, buffer: null as AudioBuffer | null };
    this.grainFiles.set(url, entry);
    // Decoded on the mix's own context (opening another AudioContext per file costs the main thread a frame).
    const c = this.context;
    if (!c) { this.grainFiles.delete(url); return null; }
    void fetch(url, { method: 'HEAD' }).then(async response => {
      if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('audio/') || this.grainFiles.get(url) !== entry) return;
      const bytes = await (await fetch(url)).arrayBuffer();
      if (this.grainFiles.get(url) !== entry) return;
      entry.buffer = await c.decodeAudioData(bytes);
    }).catch(() => { /* that piece stays silent while scrubbing; playback reports its own failure */ });
    return null;
  }
  /** Every sound of the mix that can play between reel `from` and `to`, decoded. Starting a decode is a side effect. */
  private grainSources(from: number, to: number, preview?: Partial<Pick<LiveSound, 'audio' | 'music' | 'pieces' | 'laneLevels' | 'laneMuted'>>): GrainSource[] {
    if (!this.plan || !this.context) return [];
    const plan = { ...this.plan, ...preview }, c = this.context, out: GrainSource[] = [];
    const near = (s: number, e: number) => e > from && s < to;
    const bleepKnots = plan.bleeps.flatMap(b => [b.s - FADE_S, b.s, b.e, b.e + FADE_S]);
    // Placed voice: the prewarmed takes, on the voice bus (its lane level and mute live there).
    for (const { piece, buffer } of this.voiceSchedule.decoded()) if (near(piece.startS, piece.endS))
      out.push({ id: piece.id, url: piece.url, buffer, out: this.narration!, startS: piece.startS, endS: piece.endS, at: t => ({ offset: piece.offset + t - piece.startS, rate: 1 }),
        level: t => Math.max(0, Math.min(1, piece.fadeInS ? (t - piece.startS) / piece.fadeInS : 1, piece.fadeOutS ? (piece.endS - t) / piece.fadeOutS : 1)), knots: [piece.startS + piece.fadeInS, piece.endS - piece.fadeOutS] });
    // Clip sound, as playback hears it (levels, even out, Clean), silent under a bleep.
    for (const original of plan.pieces) {
      if (original.id.startsWith('voiceover:') || !near(original.startS, original.endS)) continue;
      const p = this.heard(plan, original);
      if (p.muted) continue;
      const buffer = this.grainFile(p.url);
      if (!buffer) continue;
      const redacts = (p.layer ?? 0) === 0;
      out.push({ id: p.id, url: p.url, buffer, out: this.voice!, startS: p.startS, endS: p.endS, at: t => { const m = mixPosition(p, t); return { offset: m.source, rate: m.rate }; },
        level: t => redacts && plan.bleeps.some(b => t >= b.s && t < b.e) ? 0 : spanGain(p, t),
        knots: [p.startS + (p.fadeInS ?? 0), p.endS - (p.fadeOutS ?? 0), ...(redacts ? bleepKnots : [])] });
    }
    // Music: the separated stems when playback uses them, else the track. The music bus carries its lane and duck.
    const music = plan.music;
    if (music && !this.musicMuted && !laneMuted(plan, 'music')) {
      const end = Math.min(plan.durationS, music.endS ?? plan.durationS), fadeS = Math.min(music.arrangementState === 'ready' ? .012 : 1.5, end);
      const fade = (t: number) => Math.max(0, Math.min(1, (end - t) / fadeS));
      const stems = music.stemDucking !== false ? music.stems : undefined;
      const stemsReady = !!stems && (music.stemsStartS === undefined || music.stemsStartS === music.startS) && Object.values(stems).every(url => this.buffers.has(url));
      if (near(0, end)) {
        if (stemsReady) for (const name of ['vocals', 'other', 'drums', 'bass'] as const) {
          const keys = stemDuckKeys(this.duckKeys, name), buffer = this.buffers.get(stems![name])!;
          out.push({ id: `music:${name}`, buffer, out: this.music!, startS: 0, endS: end, at: t => ({ offset: music.startS - (music.stemsStartS ?? 0) + t, rate: 1 }),
            level: t => gain(music.gainDb ?? -18) * fade(t) * (flatMusic(music) ? 1 : duckGainAt(keys, t)), knots: [end - fadeS, ...keys.map(k => k.t)] });
        } else {
          const buffer = this.grainFile(music.url);
          if (buffer) out.push({ id: 'music', url: music.url, buffer, out: this.music!, startS: 0, endS: end, at: t => ({ offset: music.startS + t, rate: 1 }), level: t => gain(music.gainDb ?? -18) * fade(t), knots: [end - fadeS] });
        }
      }
    }
    // Sound effects, on their bus.
    for (const p of plan.effects) {
      if (!near(p.startS, p.endS)) continue;
      const buffer = this.buffers.get(p.url);
      if (!buffer) { this.loadBuffer(p.url); continue; }
      out.push({ id: p.id, buffer, out: this.effects!, startS: p.startS, endS: p.endS, loop: !!p.loop, at: t => ({ offset: t - p.startS, rate: 1 }), level: t => spanGain(p, t), knots: [p.startS + (p.fadeInS ?? 0), p.endS - (p.fadeOutS ?? 0)] });
    }
    // A bleep's tone, as playback plays it.
    const beeps = plan.bleeps.filter(b => b.sound === 'beep' && near(b.s, b.e));
    if (beeps.length) {
      if (!this.beepBuffer || this.beepBuffer.sampleRate !== c.sampleRate) {
        // One second of 1 kHz: a whole number of cycles, so it loops without a seam.
        this.beepBuffer = new AudioBuffer({ numberOfChannels: 1, length: c.sampleRate, sampleRate: c.sampleRate });
        const data = this.beepBuffer.getChannelData(0); for (let n = 0; n < data.length; n++) data[n] = Math.sin(2 * Math.PI * 1000 * n / c.sampleRate);
      }
      const level = Math.SQRT2 * .1 * gain(laneDb(plan, 'clip-sound'));
      for (const b of beeps) out.push({ id: `beep:${b.s}`, buffer: this.beepBuffer, out: this.output!, startS: b.s, endS: b.e, loop: true, at: t => ({ offset: t - b.s, rate: 1 }), level: () => level });
    }
    return out;
  }
  /** The graph, open and levelled at `time`, ready for a grain. Opening it starts decoding what grains need. */
  private ready(time: number, preview?: Partial<Pick<LiveSound, 'audio' | 'music' | 'pieces' | 'laneLevels' | 'laneMuted'>>) {
    if (!this.plan) return null;
    const fresh = !this.context;
    this.open();
    const c = this.context!;
    if (c.state === 'suspended') void c.resume().catch(() => {});
    // The first grain also starts decoding every file the edit plays, so the next ones, and J, have them.
    if (fresh) { this.sync(time, false, 1, preview); this.grainSources(0, Infinity, preview); }
    (globalThis as { __precutGrainLab?: LiveMix }).__precutGrainLab = this;
    return c;
  }
  /** Ruler scrub, called with each new playhead time while the pointer drags it; null when the drag ends.
   * Grains follow the pointer back to back: each starts where the playhead is, plays at the pointer's speed
   * (reversed when dragging left), and the next is queued when less than half of the current one is left. A pointer
   * held still sends no new time, so the sound stops after the grain that is playing. */
  scrub(time: number | null, preview?: Partial<Pick<LiveSound, 'audio' | 'music' | 'pieces' | 'laneLevels' | 'laneMuted'>>) {
    if (time === null) { this.scrubRun = null; return; }
    const c = this.ready(time, preview);
    if (!c) return;
    const now = c.currentTime, wall = performance.now() / 1000, last = this.scrubRun;
    if (last && Math.abs(time - last.reel) < 1e-6) return;
    if (last && last.run.end - now > GRAIN_S / 2) return;
    const speed = last ? (time - last.reel) / Math.max(1e-3, wall - last.wall) : 1;
    const rate = Math.max(SCRUB_RATES[0], Math.min(SCRUB_RATES[1], Math.abs(speed))), reverse = speed < 0, span = rate * GRAIN_S;
    const from = reverse ? time - span : time;
    const when = Math.max(now + LEAD_S, last && last.run.end > now ? last.run.end : 0);
    this.scrubRun = { reel: time, wall, run: scheduleGrain(c, this.grainSources(from, from + span, preview), { when, from, to: from + span, rate, reverse, kind: 'scrub' }) };
  }
  /** One frame's sound at reel `time`, `seconds` long (frame step, K+L tap). A blip still sounding fades out first. */
  blip(time: number, seconds: number, preview?: Partial<Pick<LiveSound, 'audio' | 'music' | 'pieces' | 'laneLevels' | 'laneMuted'>>) {
    const c = this.ready(time, preview);
    if (!c) return;
    fadeGrains(c, this.blipRun);
    this.blipRun = scheduleGrain(c, this.grainSources(time, time + seconds, preview), { when: c.currentTime + LEAD_S, from: time, to: time + seconds, rate: 1, reverse: false, kind: 'blip' });
  }
  /** J: the mix played backwards from reel `time` to 0 at `rate`, reversed sound as Resolve plays it. */
  reverse(time: number, rate: number, preview?: Partial<Pick<LiveSound, 'audio' | 'music' | 'pieces' | 'laneLevels' | 'laneMuted'>>) {
    const c = this.ready(time, preview);
    if (!c) return;
    fadeGrains(c, this.reverseRun);
    this.reverseRun = scheduleGrain(c, this.grainSources(0, time, preview), { when: c.currentTime + LEAD_S, from: 0, to: time, rate, reverse: true, kind: 'reverse' });
  }
  /** QA only (qa/VO7/scrub-audio): render back-to-back grains of this mix offline through scheduleGrain, so every
   * envelope edge can be checked sample by sample. Bus levels are left out; the grain envelopes are what is checked. */
  async renderGrains(grains: { from: number; to: number; rate: number; reverse: boolean }[]) {
    const sr = this.context?.sampleRate ?? 48000, length = grains.reduce((t, g) => t + (g.to - g.from) / g.rate, 0) + .05;
    const offline = new OfflineAudioContext(2, Math.ceil(length * sr), sr), traces: GrainTrace[] = [];
    let when = .01;
    for (const g of grains) {
      const run = scheduleGrain(offline, this.grainSources(g.from, g.to).map(s => ({ ...s, out: offline.destination })), { ...g, when, kind: 'lab' });
      traces.push(run.trace); when = run.end;
    }
    const rendered = await offline.startRendering();
    return { sampleRate: sr, left: rendered.getChannelData(0), right: rendered.getChannelData(1), traces };
  }
  stopReverse() { if (this.context) fadeGrains(this.context, this.reverseRun); this.reverseRun = null; }
  dispose() { this.scrubRun = null; this.blipRun = this.reverseRun = null; for (const held of this.grainFiles.values()) held.release(); this.grainFiles.clear(); this.pause();this.voiceSchedule.dispose();this.generation++;this.buffers.clear();this.loading.clear();this.failedBuffers.clear();this.slots.forEach(slot => this.release(slot)); this.slots.clear(); this.tone?.stop(); void this.context?.close(); this.context = undefined; this.eq=[]; this.tone=undefined; this.toneGain=undefined; this.voice=this.music=this.effects=this.output=this.narration=undefined; this.analyser=undefined; this.samples=undefined; }
}
