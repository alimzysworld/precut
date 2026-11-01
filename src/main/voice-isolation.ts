// Offline source facts and take-sized isolation. No downloads, installs or model API calls.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { tool, supportDir, toolEnvironment } from "./tools";
import { currentActivity, runActivity, shareWork, awaitShared } from "./activity";
import { sourceAudio, sourceAudioInput, sourceAudioChannels } from './source-audio';

const exec = promisify(execFile);
const revision = 2;
const pending = new Map<string, Promise<unknown>>();
export async function audioHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) { currentActivity()?.signal.throwIfAborted(); hash.update(chunk); }
  return hash.digest("hex");
}
export async function sourceIdentity(file: string) {
  const resolved = await fs.realpath(file).catch(async (error: NodeJS.ErrnoException) => {
    // FIX2: a voiceover take that is gone says which take, not a raw ENOENT. Still code ENOENT for callers that check.
    if (error.code === "ENOENT" && (await import("./voiceover-takes")).isTakeFile(file)) throw (await import("./voiceover-takes")).missingTakeError(file);
    throw error;
  }), stat = await fs.stat(resolved);
  return { file: resolved, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
}
const keyOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function audioCacheDir(root: string): Promise<string> {
  const base = await fs.realpath(root), parent = path.join(base, ".sidething"), dir = path.join(parent, "audio");
  await fs.mkdir(parent, { recursive: true });
  if (await fs.realpath(parent) !== parent) throw new Error("Audio cache cannot follow a shoot cache symlink.");
  await fs.mkdir(dir, { recursive: true });
  if (!(await fs.realpath(dir)).startsWith(base + path.sep)) throw new Error("Audio cache must stay inside the shoot.");
  return dir;
}
export async function localAudioProcess(command: string, args: string[]): Promise<string> {
  currentActivity()?.signal.throwIfAborted();
  const result = await exec(command, args, { signal: currentActivity()?.signal, killSignal: "SIGKILL",
    timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...toolEnvironment(), OMP_NUM_THREADS: "2", MKL_NUM_THREADS: "2" } });
  return result.stderr;
}
async function once<T>(key: string, work: () => Promise<T>): Promise<T> {
  // A waiting caller inherits its own cancellation, not a canceled caller's result.
  // DEAD1: an export awaiting a scan a timeline read started lends it its lane (activity.ts awaitShared).
  while (pending.has(key)) {
    const previous = pending.get(key)!, signal = currentActivity()?.signal;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener("abort", abort); reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
      void awaitShared(previous).then(ready, ready);
      if (signal?.aborted) abort();
    });
    currentActivity()?.signal.throwIfAborted();
  }
  const job = shareWork(work); pending.set(key, job);
  try { return await job; } finally { if (pending.get(key) === job) pending.delete(key); }
}
export interface SourceAudioFacts {
  channels: number;
  channelDb: number[];
  correlation: number;
  route: "mono" | "left" | "right" | "dual mono" | "phase inverted" | "stereo";
  filter: string;
  boomDb: number;
  presenceDb: number;
  noiseFloorDb: number | null;
  peakDb: number | null;
  durationS: number;
}

/** Streaming 100 ms energy windows: bounded memory even for long recorder WAVs. */
async function scan(file: string, channels: number): Promise<SourceAudioFacts> {
  const input = await sourceAudioInput(file);
  const sums = [0, 0], means = [0, 0], blocks: { energy: number; low: number; presence: number }[] = [];
  let cross = 0, count = 0, peak = 0, block = 0, energy = 0, lowEnergy = 0, presenceEnergy = 0;
  let low = 0, presenceLow = 0, presenceHigh = 0, remainder: Buffer = Buffer.alloc(0);
  const sr = 16000, lowAlpha = 1 - Math.exp(-2 * Math.PI * 150 / sr), midAlpha = 1 - Math.exp(-2 * Math.PI * 2000 / sr), highAlpha = 1 - Math.exp(-2 * Math.PI * 4000 / sr);
  await new Promise<void>((resolve, reject) => {
    const signal = currentActivity()?.signal;
    signal?.throwIfAborted();
    const child = spawn(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", ...input,
      "-vn", "-ac", "2", "-ar", `${sr}`, "-f", "f32le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => { child.kill("SIGKILL"); }; signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 30 * 60_000); let stderr = "";
    child.stderr.on("data", b => { stderr = (stderr + b).slice(-4000); });
    child.stdout.on("data", (chunk: Buffer) => {
      const data = Buffer.concat([remainder, chunk]), end = data.length - data.length % 8;
      for (let i = 0; i < end; i += 8) {
        const l = data.readFloatLE(i), r = data.readFloatLE(i + 4);
        sums[0] += l * l; sums[1] += r * r; means[0] += l; means[1] += r; cross += l * r;
        peak = Math.max(peak, Math.abs(l), Math.abs(r)); count++;
        // Measure tone on the stronger instantaneous channel, avoiding phase cancellation.
        const x = Math.abs(l) >= Math.abs(r) ? l : r;
        low += lowAlpha * (x - low); presenceLow += midAlpha * (x - presenceLow); presenceHigh += highAlpha * (x - presenceHigh);
        energy += x * x; lowEnergy += low * low; presenceEnergy += (presenceHigh - presenceLow) ** 2;
        if (++block === sr / 10) { blocks.push({ energy: energy / block, low: lowEnergy / block, presence: presenceEnergy / block }); block = energy = lowEnergy = presenceEnergy = 0; }
      }
      remainder = Buffer.from(data.subarray(end));
    });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", e => { cleanup(); reject(e); });
    child.once("close", code => { cleanup(); signal?.aborted ? reject(signal.reason) : code === 0 ? resolve() : reject(new Error(`Audio measurement failed (${code}): ${stderr}`)); });
  });
  const db = (x: number) => 10 * Math.log10(Math.max(1e-16, x));
  const channelDb = sums.map(sum => db(sum / Math.max(1, count)));
  const covariance = cross - means[0] * means[1] / Math.max(1, count);
  const correlation = covariance / Math.sqrt(Math.max(1e-30, (sums[0] - means[0] ** 2 / Math.max(1, count)) * (sums[1] - means[1] ** 2 / Math.max(1, count))));
  const strongest = channelDb[0] >= channelDb[1] ? 0 : 1;
  let route: SourceAudioFacts["route"] = channels === 1 ? "mono" : Math.abs(channelDb[0] - channelDb[1]) >= 20 ? strongest ? "right" : "left" : correlation > .98 ? "dual mono" : correlation < -.8 ? "phase inverted" : "stereo";
  if (!count || Math.max(...channelDb) < -150) route = "mono";
  // Ordinary stereo already balanced within half a dB is a true no-op, preserving Off bytes.
  const filter = route === "mono" ? channels === 1 ? "" : "pan=stereo|c0=c0|c1=c0" : route === "stereo" ? Math.abs(channelDb[0] - channelDb[1]) <= .5 ? "" :
    `pan=stereo|c0=${10 ** ((Math.min(...channelDb) - channelDb[0]) / 20)}*c0|c1=${10 ** ((Math.min(...channelDb) - channelDb[1]) / 20)}*c1` :
    `pan=stereo|c0=c${strongest}|c1=c${strongest}`;
  const sorted = blocks.map(b => b.energy).sort((a, b) => a - b), top = sorted[Math.floor(sorted.length * .8)] ?? 0;
  const speech = blocks.filter(b => b.energy > Math.max(1e-9, top * .1));
  const sum = (k: "energy" | "low" | "presence") => speech.reduce((n, b) => n + b[k], 0);
  const total = Math.max(1e-20, sum("energy")), boom = sum("low") / total, presence = sum("presence") / total;
  return { channels, channelDb, correlation: Math.max(-1, Math.min(1, correlation)), route, filter,
    boomDb: boom > .45 ? -Math.min(3, (boom - .45) * 8) : 0, presenceDb: speech.length && presence < .025 ? 1.5 : 0,
    noiseFloorDb: sorted.length ? db(sorted[Math.floor(sorted.length * .1)]) : null,
    peakDb: peak ? 20 * Math.log10(peak) : null, durationS: count / sr };
}
export async function measureSourceAudio(root: string, file: string): Promise<SourceAudioFacts> {
  const source = await sourceIdentity(file), cache = path.join(await audioCacheDir(root), `facts-${keyOf({ revision, source })}.json`);
  return once(cache, async () => {
    try { return JSON.parse(await fs.readFile(cache, "utf8")) as SourceAudioFacts; } catch { /* measure once */ }
    return runActivity({ kind: "render", root, target: null, label: "Measuring sound", cancelable: true }, async () => {
      const channels = (await sourceAudio(source.file))?.channels ?? 0;
      const result = await scan(source.file, channels), temporary = `${cache}.${randomUUID()}.tmp`;
      try { currentActivity()?.signal.throwIfAborted(); await fs.writeFile(temporary, JSON.stringify(result)); await fs.rename(temporary, cache); }
      finally { await fs.rm(temporary, { force: true }); }
      return result;
    }, { renderLane: "background" });
  });
}

// REL2: DeepFilterNet used to run only where a hand-made Python venv and an unlicensed copy of its weights sat in
// Application Support (one Mac). It now runs for anyone who installed the Sound separation add-on (Settings, Add-ons),
// which brings upstream's own pinned deep-filter binary (SHA-256 in extensions.json; MIT OR Apache-2.0, model inside).
// Without the add-on, voice cleanup uses the bundled RNNoise model, as before; nothing is downloaded here.
export async function deepFilterStatus(): Promise<{ binary: string; identity: string } | null> {
  try {
    const { readExtension } = await import("./extensions");
    const info = await readExtension("sound-separation");
    if (info.state !== "installed") return null;
    const userData = process.env.SIDETHING_USER_DATA ?? (await import("electron")).app.getPath("userData");
    const binary = path.join(userData, "extensions", "sound-separation", "deep-filter");
    await fs.access(binary);
    return { binary, identity: keyOf({ addon: info.version, binary: await sourceIdentity(binary) }) };
  } catch (error) { currentActivity()?.signal.throwIfAborted(); return null; }
}
export interface IsolatedTake { file: string; engine: "DeepFilterNet3" | "RNNoise"; cacheHit: boolean; elapsedS: number; durationS: number; beforeNoiseDb: number | null; afterNoiseDb: number | null }
export async function isolateVoiceTake(root: string, input: string, strength: number, fallback: string, fallbackIdentity = fallback): Promise<IsolatedTake> {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("Choose a voice cleanup strength from 0 to 1.");
  const facts = await measureSourceAudio(root, input), source = await sourceIdentity(input), dir = await audioCacheDir(root);
  return runActivity({ kind: "render", root, target: null, label: "Isolating voice", cancelable: true }, async () => {
    const local = await deepFilterStatus();
    const attempt = async (model: Awaited<ReturnType<typeof deepFilterStatus>>): Promise<IsolatedTake> => {
      const engine = model ? "DeepFilterNet3" : "RNNoise", key = keyOf({ revision, source, strength, route: facts.filter, engine, model: model?.identity, fallback, fallbackIdentity,
        executable: await sourceIdentity(tool("ffmpeg")) });
      const output = path.join(dir, `isolation-${key}.wav`), manifest = `${output}.json`;
      return once(output, async () => {
        try { const saved = JSON.parse(await fs.readFile(manifest, "utf8")); if (saved.hash === await audioHash(output)) { const now = new Date(); void fs.utimes(output, now, now).catch(() => {}); return { ...saved.result, cacheHit: true }; } } catch { /* missing or damaged */ }
        const start = performance.now(), token = randomUUID(), temporary = path.join(dir, `${token}.wav`), decoded = path.join(dir, `${token}-input.wav`);
        try {
          if (model) {
            // Half a second of trailing context: -D drops the model's latency and would otherwise lose the last frames.
            await localAudioProcess(tool("ffmpeg"), ["-v", "error", "-nostdin", "-y", ...await sourceAudioInput(source.file), "-vn", "-af", `${facts.filter || "anull"},apad=pad_dur=0.5`, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", decoded]);
            const cleaned = path.join(dir, `${token}-df`);
            await fs.mkdir(cleaned);
            try {
              await localAudioProcess(model.binary, ["-D", "-o", cleaned, decoded]);
              // The strength blends the cleaned voice back over the original, as the Python runner did.
              await localAudioProcess(tool("ffmpeg"), ["-v", "error", "-nostdin", "-y", "-i", decoded, "-i", path.join(cleaned, path.basename(decoded)), "-filter_complex",
                `[0:a][1:a]amix=inputs=2:weights='${1 - strength} ${strength}':normalize=0,atrim=duration=${facts.durationS.toFixed(6)}`, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", temporary]);
            } finally { await fs.rm(cleaned, { recursive: true, force: true }); }
          } else await localAudioProcess(tool("ffmpeg"), ["-v", "error", "-nostdin", "-y", ...await sourceAudioInput(source.file), "-vn", "-af", [facts.filter, fallback].filter(Boolean).join(",") || "anull", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", temporary]);
          currentActivity()?.signal.throwIfAborted();
          if (JSON.stringify(await sourceIdentity(input)) !== JSON.stringify(source)) throw new Error("Voice source changed while isolating. Try again.");
          const after = await scan(temporary, 2), result: IsolatedTake = { file: output, engine, cacheHit: false, elapsedS: (performance.now() - start) / 1000, durationS: facts.durationS, beforeNoiseDb: facts.noiseFloorDb, afterNoiseDb: after.noiseFloorDb };
          await fs.rename(temporary, output);
          const receipt = `${manifest}.${token}.tmp`;
          try { await fs.writeFile(receipt, JSON.stringify({ hash: await audioHash(output), result })); await fs.rename(receipt, manifest); }
          finally { await fs.rm(receipt, { force: true }); }
          return result;
        } finally { await fs.rm(temporary, { force: true }); await fs.rm(decoded, { force: true }); }
      });
    };
    try { return await attempt(local); }
    catch (error) { currentActivity()?.signal.throwIfAborted(); if (!local) throw error; currentActivity()?.progress(null, "Using standard voice cleanup"); return attempt(null); }
  }, { renderLane: "background" });
}

/** One live microphone channel becomes a mono source, centred by the editor.
 * Retain inactive source declarations so the original channel inventory is honest. */
export async function editorChannelSources(root: string, file: string, role: "cam" | "mic"): Promise<string> {
  const { firstChannel } = await sourceAudioChannels(file);
  const facts = await measureSourceAudio(root, file);
  const chosen = facts.channelDb[1] > facts.channelDb[0] ? 2 : 1;
  return Array.from({ length: Math.min(2, facts.channels) }, (_, n) => {
    const active = facts.route === "stereo" || n + 1 === chosen;
    const gain = facts.route === "stereo" && Math.abs(facts.channelDb[0] - facts.channelDb[1]) > .5 ? Math.min(...facts.channelDb) - facts.channelDb[n] : 0;
    return `<audio-channel-source srcCh="${firstChannel + n}" role="dialogue.${role}-${n + 1}" active="${active ? 1 : 0}"${facts.route === "stereo" ? ` outCh="${n ? "R" : "L"}"` : ""}>${gain ? `<adjust-volume amount="${gain}dB"/>` : ""}</audio-channel-source>`;
  }).join("");
}
