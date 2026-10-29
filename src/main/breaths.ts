import { sourceAudioInput } from './source-audio';
// Local, conservative repair. Word timings are a protection mask, never an edit list.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { Shoot, Word, VoiceoverLine } from "../shared/schema";
import { currentActivity, runActivity } from "./activity";
import { audioCacheDir, audioHash, localAudioProcess, sourceIdentity } from "./voice-isolation";
import { tool } from "./tools";

export const BREATH_CLEANUP_REASON = "Softens breaths between words and repairs mouth clicks and low pops. Keeps the timing.";
const SR = 48000, REV = 5;
export interface BreathEvent { s: number; e: number; kind: "breath" | "click" | "plosive" }
export interface BreathResult { file: string; sourceStart: number; events: BreathEvent[]; reason: string; cacheHit: boolean }

/** Keep consonants and the short breath around a phrase, without borrowing a
 * neighbouring word. Split long silence in its middle instead of hard onsets. */
export function naturalWordEdges(words: Word[], first: number, last: number, duration: number) {
  const a = words[first], b = words[last];
  return { s: Math.max(0, a.s - Math.min(.12, Math.max(0, a.s - (words[first - 1]?.e ?? 0)) / 2)),
    e: Math.min(duration, b.e + Math.min(.18, Math.max(0, (words[last + 1]?.s ?? duration) - b.e) / 2)) };
}

/** Recorded PCM needs no decoder to find a quiet edge beside an inhale. Read
 * bounded windows only; compressed imports keep their conservative word edges. */
export async function quietVoiceoverEdges(input: string, lines: VoiceoverLine[], words: Word[], duration: number): Promise<VoiceoverLine[]> {
  const handle = await fs.open(input, 'r');
  try {
    const header = Buffer.alloc(65536), { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return lines;
    let channels = 0, rate = 0, bits = 0, format = 0, dataAt = 0;
    for (let at = 12; at + 8 <= bytesRead;) {
      const size = header.readUInt32LE(at + 4), kind = header.toString('ascii', at, at + 4);
      if (kind === 'fmt ' && size >= 16 && at + 24 <= bytesRead) { format = header.readUInt16LE(at + 8); channels = header.readUInt16LE(at + 10); rate = header.readUInt32LE(at + 12); bits = header.readUInt16LE(at + 22); }
      if (kind === 'data') { dataAt = at + 8; break; }
      at += 8 + size + size % 2;
    }
    if (format !== 1 || bits !== 16 || ![1, 2].includes(channels) || rate < 8000 || rate > 192000 || !dataAt) return lines;
    const edge = async (low: number, high: number, preferred: number) => {
      if (high - low < .02) return preferred;
      const first = Math.ceil(low * rate), count = Math.floor((high - low) * rate), block = Buffer.alloc(count * channels * 2);
      const { bytesRead } = await handle.read(block, 0, block.length, dataAt + first * channels * 2);
      const frame = Math.max(1, Math.round(.01 * rate)); let best = Infinity, chosen = preferred;
      for (let at = 0; (at + frame) * channels * 2 <= bytesRead; at += frame) {
        let energy = 0;
        for (let n = at; n < at + frame; n++) for (let c = 0; c < channels; c++) energy += (block.readInt16LE((n * channels + c) * 2) / 32768) ** 2;
        const t = (first + at + frame / 2) / rate, score = energy / (frame * channels) + Math.abs(t - preferred) * 1e-8;
        if (score < best) { best = score; chosen = t; }
      }
      return chosen;
    };
    const result: VoiceoverLine[] = [];
    for (const line of lines) {
      if (!line.take) { result.push(line); continue; }
      const first = words.findIndex(w => w.s >= line.take!.s && w.e <= line.take!.e);
      let last = first;
      while (last + 1 < words.length && words[last + 1].e <= line.take.e) last++;
      if (first < 0) { result.push(line); continue; }
      const a = words[first], b = words[last];
      const s = await edge(Math.max(0, a.s - .35, words[first - 1]?.e ?? 0), Math.max(0, a.s - .025), line.take.s);
      const e = await edge(b.e + .025, Math.min(duration, b.e + .4, words[last + 1]?.s ?? duration), line.take.e);
      result.push({ ...line, take: { ...line.take, s, e } });
    }
    return result;
  } finally { await handle.close(); }
}

/** Recorder words use the same offset as voiceAudioSource. Protect the union when clips share a mic. */
export async function breathWords(root: string, input: string): Promise<Word[]> {
  let shoot: Shoot;
  try { shoot = JSON.parse(await fs.readFile(path.join(root, ".sidething", "index.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const file = path.resolve(input), words: Word[] = [];
  for (const audio of shoot.audio ?? []) if (path.resolve(root, audio.file) === file) {
    for (const segment of audio.transcript ?? []) {
      if (segment.words.length) words.push(...segment.words.filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s));
      else if (segment.text.trim()) words.push({ s: segment.s, e: segment.e, w: segment.text });
    }
  }
  for (const clip of shoot.clips) {
    const camera = path.resolve(root, clip.file) === file;
    const recorder = clip.sound && path.resolve(root, clip.sound.file) === file;
    if (!camera && !recorder) continue;
    const offset = recorder ? clip.sound!.offsetS : 0;
    for (const segment of clip.transcript ?? []) for (const w of segment.words) {
      if (Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s) words.push({ ...w, s: w.s + offset, e: w.e + offset });
    }
    // Untimed text is protected too: it cannot safely be treated as a breath gap.
    for (const segment of clip.transcript ?? []) if (!segment.words.length && segment.text.trim()) words.push({ s: segment.s + offset, e: segment.e + offset, w: segment.text });
  }
  return words.sort((a, b) => a.s - b.s || a.e - b.e);
}

/** PCM in/out at the same rate and sample count. Only measured event samples change. */
export function repairBreaths(data: Buffer, words: Word[], origin = 0): { pcm: Buffer; events: BreathEvent[] } {
  const SR = 48000, CHANNELS = 2, FRAME = 480;
  const count = Math.floor(data.length / 8), pcm = Buffer.from(data), mono = new Float32Array(count), protectedSamples = new Uint8Array(count);
  for (const w of words) {
    const s = Math.max(0, Math.floor((w.s - origin - .025) * SR)), e = Math.min(count, Math.ceil((w.e - origin + .025) * SR));
    protectedSamples.fill(1, s, Math.max(s, e));
  }
  for (let n = 0; n < count; n++) mono[n] = (data.readFloatLE(n * 8) + data.readFloatLE(n * 8 + 4)) / 2;
  const frames: { s: number; e: number; rms: number; zcr: number; high: number; low: number; word: boolean }[] = [];
  let low = 0, belowHigh = 0;
  const lowA = 1 - Math.exp(-2 * Math.PI * 180 / SR), highA = 1 - Math.exp(-2 * Math.PI * 1800 / SR);
  for (let s = 0; s < count; s += FRAME) {
    const e = Math.min(count, s + FRAME); let energy = 0, hi = 0, lo = 0, crossings = 0, word = false;
    for (let n = s; n < e; n++) {
      const x = mono[n]; low += lowA * (x - low); belowHigh += highA * (x - belowHigh);
      energy += x * x; hi += (x - belowHigh) ** 2; lo += low * low;
      if (n && x * mono[n - 1] < 0) crossings++; word ||= !!protectedSamples[n];
    }
    frames.push({ s, e, rms: Math.sqrt(energy / (e - s)), zcr: crossings / (e - s), high: hi / (energy || 1), low: lo / (energy || 1), word });
  }
  const spoken = frames.filter(f => f.word).map(f => f.rms).sort((a, b) => a - b);
  const speech = spoken[Math.floor(spoken.length * .65)] ?? 0;
  const gaps = frames.filter(f => !f.word).map(f => f.rms).sort((a, b) => a - b);
  const floor = gaps[Math.floor(gaps.length * .15)] ?? 0;
  const events: BreathEvent[] = [];
  const event = (s: number, e: number, kind: BreathEvent['kind']) => events.push({ s: origin + s / SR, e: origin + e / SR, kind });
  // Breath-like noise: quiet, unvoiced, broadband, and strictly outside padded words.
  let first = -1;
  const flush = (last: number) => {
    if (first < 0) return;
    const s = frames[first].s, e = frames[last].e, d = (e - s) / SR;
    if (d >= .15 && d <= .6) {
      const fade = Math.min(96, (e - s) / 8), gain = 10 ** (-12 / 20);
      for (let n = s; n < e; n++) {
        const wet = Math.min(1, (n - s) / fade, (e - 1 - n) / fade), g = 1 - wet * (1 - gain);
        for (let c = 0; c < CHANNELS; c++) pcm.writeFloatLE(data.readFloatLE(n * 8 + c * 4) * g, n * 8 + c * 4);
      }
      event(s, e, "breath");
    }
    first = -1;
  };
  const candidates = frames.map((f, i) => {
    const window = frames.slice(Math.max(0, i - 2), i + 3);
    const average = (key: "rms" | "zcr" | "high" | "low") => window.reduce((sum, f) => sum + f[key], 0) / window.length;
    return !f.word && average("rms") > Math.max(.00004, floor * .6) && average("rms") < speech * .7 && average("zcr") > .04 && average("high") > .1 && average("low") < .4;
  });
  // Bridge at most 20 ms of spectral jitter, never a word boundary.
  for (let i = 1; i < candidates.length - 1; i++) {
    if (candidates[i] || frames[i].word || !candidates[i - 1]) continue;
    const next = candidates[i + 1] ? i + 1 : candidates[i + 2] && !frames[i + 1].word ? i + 2 : -1;
    if (next > 0) for (let n = i; n < next; n++) candidates[n] = true;
  }
  candidates.forEach((candidate, i) => {
    if (candidate) { if (first < 0) first = i; } else flush(i - 1);
  });
  flush(frames.length - 1);
  // Isolated click bursts up to 4 ms, with smooth samples on both sides.
  // Never smear speech with a whole-track declick filter.
  for (let n = 1300; n < count - 1300; n++) {
    if (protectedSamples[n]) continue;
    let spike = false, threshold = .006;
    const curvature = (i: number, c: number) => Math.abs(data.readFloatLE(i * 8 + c * 4) -
      (data.readFloatLE((i - 1) * 8 + c * 4) + data.readFloatLE((i + 1) * 8 + c * 4)) / 2);
    for (let c = 0; c < CHANNELS; c++) {
      const residual = curvature(n, c);
      if (residual < .006) continue;
      let surrounding = 0;
      // Look 4 to 25 ms away, outside a click's ringing, and compare curvature
      // rather than amplitude so quiet clicks on a low voice remain detectable.
      for (let k = 192; k <= 1200; k += 32) surrounding += curvature(n - k, c) ** 2 + curvature(n + k, c) ** 2;
      const noise = Math.sqrt(surrounding / 64);
      if (residual > Math.max(.006, noise * 8)) {
        // A voiced pitch pulse repeats on both sides. It is not a click even
        // if transcription left the end of that vowel outside a word span.
        let periodic = false;
        for (let lag = 120; lag <= 720 && !periodic; lag += 4) {
          const peakNear = (i: number) => Math.max(...[-2, -1, 0, 1, 2].map(k => curvature(i + k, c)));
          periodic = peakNear(n - lag) > residual * .45 && peakNear(n + lag) > residual * .45;
        }
        if (!periodic) { spike = true; threshold = Math.max(threshold, noise * 3); }
      }
    }
    if (!spike) continue;
    let s = n - 4, e = n + 4;
    const quiet = (i: number) => [0, 1].every(c => {
      for (let k = -3; k <= 3; k++) if (curvature(i + k, c) > threshold) return false;
      return true;
    });
    while (s > n - 96 && !quiet(s)) s--;
    while (e < n + 96 && !quiet(e)) e++;
    if (!quiet(s) || !quiet(e)) continue;
    if (protectedSamples.subarray(s, e + 1).some(Boolean)) continue;
    for (let c = 0; c < CHANNELS; c++) {
      const a = pcm.readFloatLE(s * 8 + c * 4), b = pcm.readFloatLE(e * 8 + c * 4);
      for (let k = s + 1; k < e; k++) pcm.writeFloatLE(a + (b - a) * (k - s) / (e - s), k * 8 + c * 4);
    }
    event(s, e, "click"); n = e + 24;
  }
  // Dynamic low cut only at measured low-frequency p/b onsets. Crossfade the
  // 180 Hz low component over 5 ms; retain every sample outside the burst.
  for (const w of words) {
    if (!/^[pb]/i.test(w.w.trim().replace(/^[^\p{L}]+/u, ""))) continue;
    const onset = w.s - origin;
    const burst = frames.filter(f => f.s / SR >= onset - .025 && f.s / SR < onset + .09 && f.low > .65 && f.rms > speech * .8);
    if (!burst.length) continue;
    const s = burst[0].s, e = Math.min(count, burst.at(-1)!.e + 240);
    let state = [0, 0];
    for (let n = Math.max(0, s - 2400); n < e; n++) for (let c = 0; c < CHANNELS; c++) {
      const x = pcm.readFloatLE(n * 8 + c * 4); state[c] += lowA * (x - state[c]);
      if (n >= s) {
        const wet = Math.max(0, Math.min(1, (n - s) / 240, (e - 1 - n) / 240));
        pcm.writeFloatLE(x - state[c] * wet * .9, n * 8 + c * 4);
      }
    }
    event(s, e, "plosive");
  }
  return { pcm, events };
}

// DSP runs off the Electron main thread. The self-contained function also makes
// its exact sample math directly testable. No downloaded runtime or model.
async function repairAsync(data: Buffer, words: Word[], origin: number): Promise<{ pcm: Buffer; events: BreathEvent[] }> {
  const signal = currentActivity()?.signal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      const repair=${repairBreaths.toString()};
      parentPort.postMessage(repair(Buffer.from(workerData.data),workerData.words,workerData.origin));`,
      { eval: true, workerData: { data, words, origin } });
    const abort = () => { void worker.terminate(); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", value => resolve({ pcm: Buffer.from(value.pcm), events: value.events }));
    worker.once("error", reject);
    worker.once("exit", code => { signal?.removeEventListener("abort", abort); if (code) reject(new Error(`Breath cleanup stopped (${code}).`)); });
    if (signal?.aborted) abort();
  });
}

/** A piece cache, not a timeline edit. sourceStart tells readers where its zero was. */
export async function cleanupBreaths(root: string, input: string, start: number, duration: number, words: Word[], filter = ""): Promise<BreathResult> {
  if (![start, duration].every(Number.isFinite) || start < 0 || duration <= 0) throw new Error("Invalid breath cleanup span.");
  if (!words.length) return { file: input, sourceStart: 0, events: [], reason: "Waiting for word timings before softening breaths.", cacheHit: false };
  return runActivity({ kind: "render", root, target: null, label: "Softening breaths and mouth sounds", cancelable: true }, async () => {
    const source = await sourceIdentity(input), engine = await sourceIdentity(tool("ffmpeg"));
    const key = createHash("sha256").update(JSON.stringify({ revision: REV, source, engine, start, duration, words, filter })).digest("hex");
    const dir = await audioCacheDir(root), file = path.join(dir, `breaths-${key}.wav`), manifest = `${file}.json`;
    try {
      const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
      if (saved.hash === await audioHash(file)) { const now = new Date(); void fs.utimes(file, now, now).catch(() => {}); return { ...saved.result, cacheHit: true } as BreathResult; }
    } catch { /* Missing or damaged result: rebuild atomically. */ }
    const token = randomUUID(), raw = path.join(dir, `.${key}.${token}.raw`), decoded = `${raw}.input`, temporary = `${raw}.wav`, receipt = `${raw}.json`;
    const events: BreathEvent[] = [];
    const output = await fs.open(raw, "wx");
    try {
      // Bounded memory, with one second of context on each side of every block.
      for (let offset = 0; offset < duration; offset += 30) {
        currentActivity()?.signal.throwIfAborted();
        const before = Math.min(1, offset), length = Math.min(30, duration - offset), readStart = start + offset - before;
        await localAudioProcess(tool("ffmpeg"), ["-v", "error", "-nostdin", "-y", "-ss", `${readStart}`, "-t", `${before + length + Math.min(1, duration - offset - length)}`, ...await sourceAudioInput(input),
          "-vn", ...(filter ? ["-af", filter] : []), "-ac", "2", "-ar", `${SR}`, "-f", "f32le", decoded]);
        const repaired = await repairAsync(await fs.readFile(decoded), words, readStart);
        const from = Math.round(before * SR) * 8, to = from + Math.round(length * SR) * 8;
        await output.writeFile(repaired.pcm.subarray(from, to));
        events.push(...repaired.events.filter(e => e.s >= start + offset && e.s < start + offset + length));
        currentActivity()?.progress((offset + length) / duration * 100);
      }
      await output.close();
      await localAudioProcess(tool("ffmpeg"), ["-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", `${SR}`, "-ac", "2", "-i", raw, "-c:a", "pcm_s24le", temporary]);
      currentActivity()?.signal.throwIfAborted();
      if (JSON.stringify(await sourceIdentity(input)) !== JSON.stringify(source)) throw new Error("Voice source changed during breath cleanup. Try again.");
      const result: BreathResult = { file, sourceStart: start, events, reason: BREATH_CLEANUP_REASON, cacheHit: false };
      await fs.writeFile(receipt, JSON.stringify({ hash: await audioHash(temporary), result }));
      await fs.rename(temporary, file); await fs.rename(receipt, manifest);
      return result;
    } finally {
      await output.close().catch(() => {});
      await Promise.all([raw, decoded, temporary, receipt].map(f => fs.rm(f, { force: true })));
    }
  }, { renderLane: "background" });
}
