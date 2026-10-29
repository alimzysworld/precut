import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AudioFile, Segment, Shoot } from "../shared/schema";
import { tool, toolEnvironment } from "./tools";
import { runActivity, withRenderSlot } from "./activity";
import { availableMemoryShare } from "./resource-governor";
import { followRecordWords, prepareRecordWords, type WordFollower } from "./record-words";
import { listVoiceovers, setTranscriber, trackTranscript, TAKES_FOLDER } from "./voiceover-takes";
import { trackSave } from "./writer-lock";
import { cancelTake, finishTake, followTake } from "./voiceover-worker";

export const MIC_DENIED = "precut can't use the microphone. Allow it in System Settings, Privacy, Microphone.";
// FIX2: new takes go here, never into the exports folder. Earlier takes stay in "sidething precuts/recordings".
const RECORDINGS = TAKES_FOLDER;
export const TRANSCRIPT_FAILED = "Your take is saved, but its words aren't ready. Press Place saved take to try again.";
const RATE = 48000, MIN_FREE = 15 * 1024 ** 3;
type Level = { recordingId: string; peakDb: number; rmsDb: number };
type Result = { file: string; durationS: number };
type Input = { id: string; name: string; isDefault: boolean };

export function parseAudioInputs(stderr: string): Input[] {
  const audio = stderr.split("AVFoundation audio devices:")[1] ?? "";
  return audio.split("\n").flatMap(line => {
    const match = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    return match ? [{ id: match[1], name: match[2], isDefault: false }] : [];
  }).map((input, index) => ({ ...input, isDefault: index === 0 }));
}

/** A valid header after every PCM chunk, including an ungraceful process exit.
 * Never remux or rewrite a finished take. Sizes describe only committed samples. */
function wavHeader(bytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(36 + bytes, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
  return h;
}
function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
function atomic(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 1)); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
/** Separate durable metadata survives a pipeline stage which began before Stop.
 * The pipeline merges this journal at its index write boundary. */
function saveTake(root: string, entry: AudioFile): void {
  const dir = path.join(root, ".sidething"), file = path.join(dir, "voiceovers.json");
  const saved = readJson<AudioFile[]>(file, []).filter(a => a.file !== entry.file);
  atomic(file, [...saved, entry]);
  const indexFile = path.join(dir, "index.json"), shoot = readJson<Shoot | null>(indexFile, null);
  if (!shoot) throw new Error("Open a shoot before recording.");
  shoot.audio = [...(shoot.audio ?? []).filter(a => a.file !== entry.file), entry];
  shoot.updatedAt = new Date().toISOString();
  atomic(indexFile, shoot);
}

/** VO7-4: the take's waveform is computed once, in the background, as soon as it is saved. */
function warmTakePeaks(root: string, file: string): void {
  void import("./peaks").then(m => m.warmPeaks(root, file), () => {});
}

async function microphonePermission(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Microphone recording needs macOS.");
  const { systemPreferences } = await import("electron");
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return;
  if (status !== "not-determined" || !await systemPreferences.askForMediaAccess("microphone")) throw new Error(MIC_DENIED);
}
function changed(root: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try { win.webContents.send("api:steps-changed", root); } catch { /* closing */ }
    }
  }
}
function levels(level: Level): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try { win.webContents.send("record-level", level); } catch { /* closing */ }
    }
  }
}
async function transcribe(root: string, file: string): Promise<Segment[]> {
  const { pipelineFile, venvPython } = await import("./jobs");
  return runActivity({ kind: "process", root, target: null, label: "Transcribing your voiceover", cancelable: true }, activity =>
    withRenderSlot(activity, async () => {
      // Speech models wait for the quality bar's 20% reserve, in addition to
      // the shared lane's memory/thermal guard. The saved take stays usable.
      while (availableMemoryShare() < .2) {
        activity.progress(null, "Waiting for memory");
        await delay(5000, undefined, { signal: activity.signal });
      }
      return new Promise<Segment[]>((resolve, reject) => {
        const child = spawn(venvPython(), ["-I", pipelineFile("process.py"), root, "--transcribe-audio", file],
          { env: toolEnvironment(), stdio: ["ignore", "pipe", "pipe"], signal: activity.signal });
        let stdout = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.resume();
        child.once("error", reject);
        child.once("close", code => {
          if (code !== 0) { reject(new Error("Your take is saved. Couldn't transcribe it yet.")); return; }
          try { resolve(JSON.parse(stdout.trim().split("\n").at(-1)!).transcript); } catch (error) { reject(error); }
        });
      });
    // The person is waiting on Stop for these words, and playback pauses the
    // background lane, so a take never queues behind optional cache renders.
    // VO8: nor behind the governor's few seconds of rest after playback stops.
    }, "waited"), { renderLane: "waited" });
}

type Stream = { follow: (id: string, root: string, file: string) => void; cancel: (id: string) => void;
  finish: (id: string, root: string, file: string, signal?: AbortSignal) => Promise<Segment[]> | null };
/** VO8: the warm worker finishes a take it followed while recording, so Stop only waits for the tail. It is
 * already resident and measured against memory when the panel opened, so it takes no render slot. Null when
 * it isn't running; a worker failure (not a cancel) falls back to the one-off transcription. */
async function streamed(stream: Stream, root: string, file: string, id: string): Promise<Segment[] | null> {
  const cancel = new AbortController();
  const words = stream.finish(id, root, file, cancel.signal);
  if (!words) return null;
  void words.catch(() => {});
  return runActivity({ kind: "process", root, target: null, label: "Transcribing your voiceover", cancelable: true }, async activity => {
    const abort = () => cancel.abort(activity.signal.reason);
    activity.signal.addEventListener("abort", abort, { once: true });
    try { return await words; }
    catch (error) { if (activity.signal.aborted) throw error; console.warn("[voiceover]", error instanceof Error ? error.message : error); return null; }
    finally { activity.signal.removeEventListener("abort", abort); }
  }, { renderLane: "waited" }).catch(error => { cancel.abort(error); throw error; });
}

/** Only this factory can substitute an input. IPC and MCP cannot choose a file,
 * lavfi source, command or destination; recording always needs the app's mic grant. */
export function createRecorder(deps: {
  permission?: () => Promise<void>;
  inputArgs?: (id: string) => string[];
  emitLevel?: (level: Level) => void;
  transcribe?: (root: string, file: string) => Promise<Segment[]>;
  warmPeaks?: (root: string, file: string) => void;  // VO7-4: tests pass a no-op
  changed?: (root: string) => void;
  freeBytes?: (root: string) => number;
  followWords?: (recordingId: string) => Promise<WordFollower>;
  /** VO8: the warm transcriber; without it every take uses `transcribe`. */
  stream?: Stream;
} = {}) {
  const permission = deps.permission ?? microphonePermission;
  const notify = deps.changed ?? changed;
  const freeBytes = deps.freeBytes ?? (root => { const s = fs.statfsSync(root); return s.bavail * s.bsize; });
  let busy = false;
  const sessions = new Map<string, { stop: () => Promise<Result>; close: () => void }>();
  const pending = new Set<Promise<unknown>>();
  function queueTranscript(root: string, entry: AudioFile, id: string = randomUUID()): Promise<void> {
    const oneOff = () => (deps.transcribe ?? transcribe)(root, entry.file);
    const words = deps.stream ? streamed(deps.stream, root, entry.file, id).then(t => t ?? oneOff()) : oneOff();
    const work = words.then(transcript => {
      saveTake(root, { ...entry, transcript }); notify(root);
    }).catch(error => {
      console.warn("[voiceover]", error instanceof Error ? error.message : error);
      throw new Error(TRANSCRIPT_FAILED);
    });
    trackTranscript(root, entry.file, work);
    const settled = work.catch(() => {});
    pending.add(settled); void settled.finally(() => pending.delete(settled));
    return work;
  }
  return {
    async audioInputs(): Promise<Input[]> {
      await permission();
      return new Promise((resolve, reject) => {
        const child = spawn(tool("ffmpeg"), ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32768); });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("close", () => { clearTimeout(timeout); resolve(parseAudioInputs(stderr)); });
      });
    },
    async recordStart(root: string, deviceId: string): Promise<{ recordingId: string }> {
      if (busy) throw new Error("Stop your current take first.");
      busy = true;
      let release: (() => void) | undefined;
      let follower: WordFollower | undefined;
      let streamId: string | undefined;
      try {
        await permission();
        if (!/^\d+$/.test(deviceId)) throw new Error("Choose a microphone first.");
        root = fs.realpathSync(root);
        if (!fs.existsSync(path.join(root, ".sidething/index.json"))) throw new Error("Open a shoot before recording.");
        if (freeBytes(root) < MIN_FREE) throw new Error("Make some space before recording.");
        const base = path.join(root, ".sidething"), dir = path.join(root, RECORDINGS);
        fs.mkdirSync(base, { recursive: true });
        if (fs.realpathSync(base) !== base) throw new Error("The recordings folder must be inside this shoot.");
        fs.mkdirSync(dir, { recursive: true });
        if (fs.realpathSync(dir) !== dir) throw new Error("The recordings folder must be inside this shoot.");
        const stamp = new Date().toISOString().replace("T", " ").replace(/:/g, "-").replace("Z", "");
        const file = `${RECORDINGS}/${stamp} ${randomUUID().slice(0, 8)}.wav`;
        const recordingId = randomUUID();
        follower = await deps.followWords?.(recordingId);
        const fd = fs.openSync(path.join(root, file), "wx");
        let closed = false, bytes = 0, carry = Buffer.alloc(0), peak = 0, sum = 0, samples = 0;
        let lastDiskCheck = Date.now(), stderr = "", stopTimer: ReturnType<typeof setTimeout> | undefined;
        let child: ReturnType<typeof spawn>;
        const close = () => {
          if (closed) return;
          closed = true; clearInterval(meter); if (stopTimer) clearTimeout(stopTimer);
          follower?.stop();
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        };
        try { fs.writeSync(fd, wavHeader(0), 0, 44, 0); }
        catch (error) { fs.closeSync(fd); throw error; }
        // VO8: the warm worker decodes the take's finished windows while he speaks.
        streamId = recordingId; deps.stream?.follow(recordingId, root, file);
        const meter = setInterval(() => {
          const db = (amplitude: number) => Math.max(-96, 20 * Math.log10(amplitude || 0));
          (deps.emitLevel ?? levels)({ recordingId, peakDb: db(peak), rmsDb: db(samples ? Math.sqrt(sum / samples) : 0) });
          peak = sum = samples = 0;
        }, 50);
        release = () => { close(); busy = false; };
        child = spawn(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
          ...(deps.inputArgs?.(deviceId) ?? ["-f", "avfoundation", "-i", `:${deviceId}`]),
          "-vn", "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", "-f", "s16le", "-flush_packets", "1", "pipe:1"],
        { stdio: ["ignore", "pipe", "pipe"] });
        let ready: () => void, failed: (error: Error) => void;
        const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
        const startTimeout = setTimeout(() => {
          failed(new Error("Couldn't start the microphone. Check it and try again.")); child.kill("SIGTERM");
          stopTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
        }, 10000);
        let captureError: Error | undefined;
        const done = new Promise<Result>((resolve, reject) => {
          child.stdout!.on("data", (chunk: Buffer) => {
            if (closed) return;
            try {
              const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
              const size = data.length - data.length % 2;
              carry = Buffer.from(data.subarray(size));
              if (bytes + size > 0xffff_ffff - 36) throw new Error("Your take reached its length limit and was saved.");
              // Explicit offsets: patching the header never changes append position.
              let offset = 0;
              while (offset < size) offset += fs.writeSync(fd, data, offset, size - offset, 44 + bytes + offset);
              bytes += size;
              follower?.write(data.subarray(0, size));
              fs.writeSync(fd, wavHeader(bytes), 0, 44, 0);
              for (let i = 0; i < size; i += 2) {
                const value = data.readInt16LE(i) / 32768;
                peak = Math.max(peak, Math.abs(value)); sum += value * value; samples++;
              }
              clearTimeout(startTimeout); ready();
              if (Date.now() - lastDiskCheck > 1000) {
                lastDiskCheck = Date.now();
                if (freeBytes(root) < MIN_FREE) throw new Error("Recording stopped to keep space free. Your take is saved.");
              }
            } catch (error) { captureError = error as Error; child.kill("SIGTERM"); }
          });
          child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
          child.once("error", error => { captureError = error; });
          child.once("close", code => {
            clearTimeout(startTimeout); close(); busy = false;
            const result = { file, durationS: bytes / (RATE * 2) };
            if (bytes) {
              const entry: AudioFile = { ...result, channels: 1, syncedTo: null, clips: [], role: "voiceover", transcript: null };
              try { saveTake(root, entry); notify(root); queueTranscript(root, entry, recordingId); (deps.warmPeaks ?? warmTakePeaks)(root, entry.file); }  // VO7-4: peaks at ingest
              catch (error) { deps.stream?.cancel(recordingId); reject(error); return; }
            } else deps.stream?.cancel(recordingId);
            const error = captureError ?? (!bytes || code && code !== 255 ? new Error(/permission|not authorized|denied/i.test(stderr) ? MIC_DENIED : "Couldn't record from the microphone. Your saved audio has been kept.") : undefined);
            if (error) { failed(error); reject(error); } else resolve(result);
          });
        });
        // A device can disappear before the person presses Stop.
        void done.catch(() => {});
        void trackSave(done).catch(() => {});  // FIX2: quit waits for the take to be journaled
        sessions.set(recordingId, { close: () => { child.kill("SIGTERM"); close(); }, stop: () => {
          if (!closed) {
            child.kill("SIGTERM");
            stopTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
          }
          return done;
        } });
        try { await started; } catch (error) {
          await done.catch(() => {}); sessions.delete(recordingId); throw error;
        }
        return { recordingId };
      } catch (error) { follower?.stop(); if (streamId) deps.stream?.cancel(streamId); release?.(); busy = false; throw error; }
    },
    async recordStop(recordingId: string): Promise<Result> {
      const session = sessions.get(recordingId);
      if (!session) throw new Error("That recording is no longer open. Your saved takes are still in the shoot.");
      try { return await session.stop(); } finally { sessions.delete(recordingId); }
    },
    closeAll(): void { for (const session of sessions.values()) session.close(); },
    async whenTranscribed(): Promise<void> { await Promise.all([...pending]); },
    /** Retry for a saved take that has no words yet (a quit or failed attempt). */
    async transcribeTake(root: string, file: string): Promise<void> {
      const entry = (await listVoiceovers(root)).find(t => t.file === file);
      if (entry) await queueTranscript(root, { ...entry, transcript: null });
    },
  };
}

/** VO8 QA seam, never in a packaged app: PRECUT_QA_MIC_FILE plays a recorded voice file into the
 * capture path at its own pace. No microphone, no permission prompt, no live speech helper. Set only
 * at launch; IPC and MCP cannot reach it. */
const qaMicFile = !app.isPackaged && path.isAbsolute(process.env.PRECUT_QA_MIC_FILE ?? "") ? process.env.PRECUT_QA_MIC_FILE! : null;
const stream: Stream = { follow: followTake, finish: finishTake, cancel: cancelTake };
const recorder = createRecorder(qaMicFile
  ? { permission: async () => {}, inputArgs: () => ["-re", "-i", qaMicFile], stream }
  : { followWords: followRecordWords, stream });
setTranscriber(recorder.transcribeTake);
app.on("before-quit", () => recorder.closeAll());
export const audioInputs = () => {
  if (qaMicFile) return Promise.resolve([{ id: "0", name: "QA voice file", isDefault: true }]);
  void prepareRecordWords(); return recorder.audioInputs();
};
export const recordStart = recorder.recordStart;
export const recordStop = recorder.recordStop;
export { listVoiceovers };

/** VO7-8: an audio file dropped on the timeline from Finder becomes a take of this shoot. It is copied
 * into `.sidething/recordings` (FIX2; before 28 Oct, `sidething precuts/recordings`) in the recorder's own format (48 kHz mono 16-bit WAV, a header
 * written by wavHeader), journaled like a recorded take, and its words and waveform are queued the same
 * way. The dropped file is only read; recordings are never rewritten afterwards. */
export const importTake = (root: string, source: string): Promise<AudioFile> => trackSave(copyTake(root, source));
async function copyTake(root: string, source: string): Promise<AudioFile> {
  root = path.resolve(root);
  if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("Drop an audio file from Finder.");
  const stat = await fs.promises.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error("That audio file can't be read. Check it and try again.");
  if (!fs.existsSync(path.join(root, ".sidething/index.json"))) throw new Error("Open a shoot before adding a voiceover.");
  const dir = path.join(root, RECORDINGS);
  await fs.promises.mkdir(dir, { recursive: true });
  const free = fs.statfsSync(dir); if (free.bavail * free.bsize < MIN_FREE) throw new Error("Free up some disk space to add this voiceover.");
  const stem = path.basename(source, path.extname(source)).replace(/[^\p{L}\p{N} ._-]+/gu, " ").trim().slice(0, 60) || "Voiceover";
  const name = `${stem} ${randomUUID().slice(0, 8)}.wav`, out = path.join(dir, name), part = `${out}.part`;
  const fd = fs.openSync(part, "wx");
  let bytes = 0;
  try {
    fs.writeSync(fd, wavHeader(0), 0, 44, 0);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-i", source,
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"], { env: toolEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      let error = "";
      child.stderr!.on("data", chunk => { error = (error + chunk).slice(-400); });
      child.stdout!.on("data", (chunk: Buffer) => { fs.writeSync(fd, chunk, 0, chunk.length, 44 + bytes); bytes += chunk.length; });
      child.once("error", reject);
      child.once("close", code => code === 0 && bytes >= RATE * 2 * .05 ? resolve() : reject(new Error(code === 0 ? "That audio file is too short to use." : "That file has no sound precut can read.")));
      void error;
    });
    bytes -= bytes % 2;
    fs.writeSync(fd, wavHeader(bytes), 0, 44, 0); fs.fsyncSync(fd);
  } catch (error) { fs.closeSync(fd); fs.rmSync(part, { force: true }); throw error; }
  fs.closeSync(fd); fs.renameSync(part, out);
  const entry: AudioFile = { file: `${RECORDINGS}/${name}`, durationS: bytes / (RATE * 2), channels: 1, syncedTo: null, clips: [], role: "voiceover", transcript: null };
  saveTake(root, entry); changed(root);
  void recorder.transcribeTake(root, entry.file).catch(error => console.warn("[voiceover]", error instanceof Error ? error.message : error));
  warmTakePeaks(root, entry.file);
  return entry;
}
