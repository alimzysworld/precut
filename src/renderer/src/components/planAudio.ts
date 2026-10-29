import { retainVoiceWave } from "./voiceoverWave";

/** VO7-7: audition for the take viewer and Clean read. One AudioContext; each
 * take is decoded once (shared with the line waveforms) and kept as an
 * AudioBuffer while a viewer holds it. A plan's spans are scheduled on the
 * audio clock, sample-accurately, never through media elements or frame-timed
 * gain. Where audio was removed, the kept audio on each side gets a linear 5 ms
 * fade-out and fade-in inside itself: no overlap, no change to timing.
 * Contiguous source seams play as one source, continuously. --mute-audio mutes
 * the output; the clock and the schedule still run, so QA reads them. */
export const FADE_S = 0.005;
/** One span of a take, in take seconds. cutBefore: audio was removed just before it. */
export type AuditionSpan = { s: number; e: number; cutBefore?: boolean };
export type Scheduled = { at: number; offset: number; duration: number; fadeIn: boolean; fadeOut: boolean };
export interface Audition {
  readonly id: number;
  readonly spans: AuditionSpan[];
  readonly from: number; readonly to: number; readonly rate: number; readonly reverse: boolean;
  readonly schedule: Scheduled[];
  /** Plan seconds now (from..to). */
  position(): number;
  /** Take seconds now: where in the recording the sound is. */
  takeTime(): number;
  stop(): void;
  readonly ended: Promise<void>;
}
/** What QA reads: the last schedule, on the audio clock and in page time. */
export type AuditionTrace = { id: number; inputAt: number | null; scheduledAt: number; startsAt: number; spans: AuditionSpan[]; from: number; to: number; rate: number; reverse: boolean; schedule: Scheduled[]; baseLatencyMs: number };

let context: AudioContext | null = null;
function audioContext() {
  if (!context || context.state === "closed") context = new AudioContext({ latencyHint: "interactive" });
  if (context.state === "suspended") void context.resume().catch(() => {});
  return context;
}

type Held = { users: number; release: () => void; buffer: Promise<AudioBuffer>; ready: AudioBuffer | null; reversed: AudioBuffer | null };
const held = new Map<string, Held>();
/** Keep a take decoded while something can play it. Returns the release. */
export function holdTake(url: string): () => void {
  let entry = held.get(url);
  if (!entry) {
    const wave = retainVoiceWave(url);
    const made: Held = { users: 0, release: wave.release, buffer: wave.audio, ready: null, reversed: null };
    void wave.audio.then(buffer => { made.ready = buffer; }, () => {});
    held.set(url, entry = made);
  }
  entry.users++;
  // Opening the context now means the first Play doesn't pay for it.
  try { audioContext(); } catch { /* no audio device: Play says so */ }
  let released = false;
  return () => {
    if (released || !entry) return; released = true;
    if (--entry.users === 0 && held.get(url) === entry) { held.delete(url); entry.release(); }
  };
}
/** The decode of a held take, or null when nothing holds it. */
export function heldTake(url: string): Promise<AudioBuffer> | null { return held.get(url)?.buffer ?? null; }
async function bufferFor(url: string): Promise<AudioBuffer> {
  const entry = held.get(url);
  if (entry) return entry.ready ?? entry.buffer;
  const wave = retainVoiceWave(url);
  try { return await wave.audio; } finally { wave.release(); }
}
function reversedOf(url: string, buffer: AudioBuffer): AudioBuffer {
  const entry = held.get(url);
  if (entry?.reversed) return entry.reversed;
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).slice().reverse(), c);
  if (entry) entry.reversed = out;
  return out;
}

/** Plan length in seconds. */
export const planLength = (spans: AuditionSpan[]) => spans.reduce((sum, s) => sum + Math.max(0, s.e - s.s), 0);
/** Plan seconds to take seconds. */
export function takeAt(spans: AuditionSpan[], t: number): number {
  let start = 0;
  for (const span of spans) {
    const length = Math.max(0, span.e - span.s);
    if (t <= start + length + 1e-9) return span.s + Math.max(0, t - start);
    start += length;
  }
  return spans.at(-1)?.e ?? 0;
}
/** Take seconds to plan seconds: the first place the plan plays that moment, or null. */
export function planAt(spans: AuditionSpan[], take: number): number | null {
  let start = 0;
  for (const span of spans) {
    if (take >= span.s - 1e-9 && take <= span.e + 1e-9) return start + Math.min(span.e, Math.max(span.s, take)) - span.s;
    start += Math.max(0, span.e - span.s);
  }
  return null;
}
/** The plan cut to plan seconds [from, to], contiguous seams merged, each piece knowing whether audio was removed at its edges. */
export function windowOf(spans: AuditionSpan[], from: number, to: number): { s: number; e: number; fadeIn: boolean; fadeOut: boolean; planS: number }[] {
  const merged: AuditionSpan[] = [];
  for (const span of spans) {
    if (!(span.e > span.s)) continue;
    const last = merged.at(-1);
    if (last && !span.cutBefore && Math.abs(span.s - last.e) < 1e-6) last.e = span.e;
    else merged.push({ ...span, cutBefore: !!last });
  }
  const out: { s: number; e: number; fadeIn: boolean; fadeOut: boolean; planS: number }[] = [];
  let start = 0;
  merged.forEach((span, i) => {
    const length = span.e - span.s, a = Math.max(from, start), b = Math.min(to, start + length);
    // A removed boundary, or an edge of what was asked for, fades; a seam that plays on is one source.
    // The end always fades: the audio after it was removed, or the audition stops there.
    if (b - a > 1e-6) out.push({ s: span.s + a - start, e: span.s + b - start, planS: a, fadeIn: a > start + 1e-6 || i > 0 || span.s > 1e-6, fadeOut: true });
    start += length;
  });
  return out;
}

let nextId = 0, latest = 0, current: Audition | null = null;
const traces: AuditionTrace[] = [];
function trace(t: AuditionTrace) {
  traces.push(t); if (traces.length > 20) traces.shift();
  (globalThis as { __precutAudition?: AuditionTrace[] }).__precutAudition = traces;
}
export const playingAudition = () => current;
export function stopAudition() { latest = ++nextId; current?.stop(); }

/** Play plan seconds [from, to] of `spans` from the take at `url`. Stops anything already auditioning.
 * Starts on the next audio quantum when the take is already decoded. `inputAt` is the click's
 * event.timeStamp, kept for QA. Reverse plays backwards from `to` down to `from` (J). */
export async function playSpans(url: string, spans: AuditionSpan[], opts: { from?: number; to?: number; rate?: number; reverse?: boolean; inputAt?: number } = {}): Promise<Audition> {
  current?.stop();
  const id = latest = ++nextId, entry = held.get(url);
  const buffer = entry?.ready ?? await bufferFor(url);
  if (latest !== id) throw new Error("Another audition started.");
  const c = audioContext(), length = planLength(spans);
  const from = Math.max(0, Math.min(length, opts.from ?? 0)), to = Math.max(from, Math.min(length, opts.to ?? length));
  const rate = Math.max(0.25, Math.min(8, opts.rate ?? 1)), reverse = !!opts.reverse;
  const pieces = windowOf(spans, from, to);
  // A few milliseconds ahead so every source starts on an exact sample of the same clock.
  const t0 = c.currentTime + 0.01, source = reverse ? reversedOf(url, buffer) : buffer;
  const nodes: { node: AudioBufferSourceNode; gain: GainNode }[] = [], schedule: Scheduled[] = [];
  const order = reverse ? [...pieces].reverse() : pieces;
  for (const piece of order) {
    const planOffset = reverse ? to - (piece.planS + piece.e - piece.s) : piece.planS - from;
    const at = t0 + planOffset / rate, duration = piece.e - piece.s;
    const offset = reverse ? buffer.duration - piece.e : piece.s;
    const node = new AudioBufferSourceNode(c, { buffer: source, playbackRate: rate }), gain = new GainNode(c, { gain: 1 });
    const fadeIn = reverse ? piece.fadeOut : piece.fadeIn, fadeOut = reverse ? piece.fadeIn : piece.fadeOut;
    const fade = Math.min(FADE_S, duration / 2) / rate, end = at + duration / rate;
    gain.gain.setValueAtTime(fadeIn ? 0 : 1, at);
    if (fadeIn) gain.gain.linearRampToValueAtTime(1, at + fade);
    if (fadeOut) { gain.gain.setValueAtTime(1, end - fade); gain.gain.linearRampToValueAtTime(0, end); }
    node.connect(gain).connect(c.destination);
    node.start(at, Math.max(0, offset), duration);
    nodes.push({ node, gain }); schedule.push({ at, offset, duration, fadeIn, fadeOut });
  }
  let resolveEnded!: () => void, stopped = false;
  const ended = new Promise<void>(resolve => { resolveEnded = resolve; });
  const finish = () => {
    if (stopped) return; stopped = true;
    for (const { node, gain } of nodes) { try { node.onended = null; node.stop(); } catch { /* not started */ } node.disconnect(); gain.disconnect(); }
    if (current === audition) current = null;
    resolveEnded();
  };
  if (nodes.length) nodes.at(-1)!.node.onended = finish; else queueMicrotask(finish);
  const position = () => {
    const played = Math.max(0, (c.currentTime - t0) * rate);
    return reverse ? Math.max(from, to - played) : Math.min(to, from + played);
  };
  const audition: Audition = { id, spans, from, to, rate, reverse, schedule, ended, position, takeTime: () => takeAt(spans, position()), stop: finish };
  current = audition;
  trace({ id, inputAt: opts.inputAt ?? null, scheduledAt: performance.now(), startsAt: performance.now() + (t0 - c.currentTime) * 1000, spans, from, to, rate, reverse, schedule, baseLatencyMs: Math.round((c.baseLatency ?? 0) * 1000) });
  return audition;
}

// ---- VO7-9: timeline voice through the same scheduling rule.
/** One placed voice piece: file seconds `offset` heard at reel `startS`, to reel `endS`. Fades are the
 * export's (voiceJoinFades): 5 ms inside the kept audio where take audio was removed, none across an
 * untouched seam. */
export type VoicePiece = { id: string; url: string; startS: number; endS: number; offset: number; fadeInS: number; fadeOutS: number };
/** What QA reads: each scheduled source on the audio clock, with the reel time it plays from. */
export type VoiceScheduleTrace = { id: number; from: number; rate: number; t0: number; scheduledAt: number; contextState: string;
  sources: { id: string; url: string; reelS: number; at: number; offset: number; duration: number; fadeInS: number; fadeOutS: number }[] };
const voiceTraces: VoiceScheduleTrace[] = [];
let voiceRuns = 0;
/** Prewarmed: every piece's file is decoded when the plan arrives, so Space only schedules. Plays on the
 * mixer's own context and voice bus, on to the last piece, past the picture's end too. */
/** How far after its schedule placed voice starts, so every source starts on an exact sample (PAR1: liveMix leads by it). */
export const VOICE_START_S = .01;
export class VoiceScheduler {
  private holds = new Map<string, { release: () => void; buffer: AudioBuffer | null; failed: boolean }>();
  private pieces: VoicePiece[] = []; private signature = "";
  private nodes: { source: AudioBufferSourceNode; gain: GainNode; id: string }[] = [];
  private run: { from: number; t0: number; rate: number; trace: VoiceScheduleTrace; waiting: Set<string> } | null = null;
  constructor(private context: () => AudioContext | undefined, private output: () => AudioNode | undefined, private failed: (message: string) => void = () => {}) {}
  get playing() { return !!this.run; }
  /** VO7-14: the placed pieces whose take is decoded, for scrub grains and reverse play. */
  decoded(): { piece: VoicePiece; buffer: AudioBuffer }[] {
    return this.pieces.flatMap(piece => { const buffer = this.holds.get(piece.url)?.buffer; return buffer ? [{ piece, buffer }] : []; });
  }
  setPieces(pieces: VoicePiece[]) {
    const signature = JSON.stringify(pieces);
    if (signature === this.signature) return;
    this.pieces = pieces; this.signature = signature;
    const wanted = new Set(pieces.map(p => p.url));
    for (const url of wanted) if (!this.holds.has(url)) {
      const wave = retainVoiceWave(url), hold = { release: wave.release, buffer: null as AudioBuffer | null, failed: false };
      this.holds.set(url, hold);
      void wave.audio.then(buffer => { hold.buffer = buffer; this.arrived(url); }, () => { hold.failed = true; if (this.holds.get(url) === hold) this.failed("Couldn't play this take's sound."); });
    }
    for (const [url, hold] of this.holds) if (!wanted.has(url)) { hold.release(); this.holds.delete(url); }
    // A changed plan while playing (a prepared file arrived, an edit landed) plays on from here.
    if (this.run) { const at = this.position(); if (at !== null) this.start(at, this.run.rate); }
  }
  /** Reel seconds now, on the audio clock, or null when stopped. */
  position(): number | null {
    const c = this.context();
    return this.run && c ? this.run.from + Math.max(0, c.currentTime - this.run.t0) * this.run.rate : null;
  }
  /** Called every frame: starts, follows a seek or a rate change, or stops. */
  follow(time: number, playing: boolean, rate = 1) {
    if (!playing) { this.stop(); return; }
    const c = this.context();
    if (!c) return;
    if (this.run && this.run.rate === rate && (c.state !== "running" || Math.abs((this.position() ?? time) - time) < .06)) return;
    this.start(time, rate);
  }
  start(time: number, rate = 1) {
    this.stop();
    if (!this.signature && this.pieces.length) this.setPieces([...this.pieces]);
    const c = this.context(), out = this.output();
    if (!c || !out) return;
    const trace: VoiceScheduleTrace = { id: ++voiceRuns, from: time, rate, t0: c.currentTime + VOICE_START_S, scheduledAt: performance.now(), contextState: c.state, sources: [] };
    this.run = { from: time, t0: trace.t0, rate, trace, waiting: new Set() };
    for (const piece of this.pieces) if (piece.endS > time) this.schedule(piece);
    voiceTraces.push(trace); if (voiceTraces.length > 20) voiceTraces.shift();
    (globalThis as { __precutVoiceSchedule?: VoiceScheduleTrace[] }).__precutVoiceSchedule = voiceTraces;
  }
  private arrived(url: string) {
    if (!this.run) return;
    for (const piece of this.pieces) if (piece.url === url && this.run.waiting.has(piece.id)) { this.run.waiting.delete(piece.id); this.schedule(piece); }
  }
  private schedule(piece: VoicePiece) {
    const run = this.run, c = this.context(), out = this.output();
    if (!run || !c || !out) return;
    const buffer = this.holds.get(piece.url)?.buffer;
    if (!buffer) { run.waiting.add(piece.id); return; }
    const now = this.position() ?? run.from;
    // A piece already under way (play from its middle, or its file decoded late) joins at the clock.
    const reel = Math.max(piece.startS, run.from, now - .001);
    if (reel >= piece.endS - 1e-4) return;
    const at = run.t0 + (reel - run.from) / run.rate, offset = Math.max(0, piece.offset + reel - piece.startS);
    const duration = Math.min(piece.endS - reel, buffer.duration - offset);
    if (!(duration > 0)) return;
    // Starting inside a piece is not a join: a 5 ms fade there only keeps the start from clicking.
    const fadeIn = reel > piece.startS + 1e-4 ? Math.min(FADE_S, duration / 2) : piece.fadeInS, fadeOut = piece.fadeOutS;
    const source = new AudioBufferSourceNode(c, { buffer, playbackRate: run.rate }), gain = new GainNode(c, { gain: fadeIn ? 0 : 1 });
    const end = at + duration / run.rate;
    gain.gain.setValueAtTime(fadeIn ? 0 : 1, at);
    if (fadeIn) gain.gain.linearRampToValueAtTime(1, at + fadeIn / run.rate);
    if (fadeOut) { gain.gain.setValueAtTime(1, end - fadeOut / run.rate); gain.gain.linearRampToValueAtTime(0, end); }
    source.connect(gain).connect(out);
    source.start(Math.max(c.currentTime, at), offset + Math.max(0, c.currentTime - at) * run.rate, duration);
    this.nodes.push({ source, gain, id: piece.id });
    source.onended = () => { const i = this.nodes.findIndex(n => n.source === source); if (i >= 0) { this.nodes.splice(i, 1); source.disconnect(); gain.disconnect(); } };
    run.trace.sources.push({ id: piece.id, url: piece.url, reelS: reel, at, offset, duration, fadeInS: fadeIn, fadeOutS: fadeOut });
  }
  stop() {
    this.run = null;
    for (const { source, gain } of this.nodes) { source.onended = null; try { source.stop(); } catch { /* not started */ } source.disconnect(); gain.disconnect(); }
    this.nodes = [];
  }
  /** Frees the decoded audio; the plan is kept, so the next play decodes it again. */
  dispose() { this.stop(); for (const hold of this.holds.values()) hold.release(); this.holds.clear(); this.signature = ""; }
}
