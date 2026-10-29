// VO8: the warm voiceover transcriber (pipeline/voice_stream.py). One per app. It starts when the Voiceover panel
// opens (a lease the panel renews every few seconds) or a take starts recording, and exits once the panel has
// closed, or the panel has sat open for minutes with nothing recorded, and no take it follows is still recording or
// finishing. While a take records it decodes the finished speech windows, so Stop only finishes the tail. Without it
// (low memory, a crash) the take is transcribed the old way, by process.py.
import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";
import type { Segment } from "../shared/schema";
import { toolEnvironment } from "./tools";
import { availableMemoryShare } from "./resource-governor";

// The model holds about 2 GB, so an open panel nobody records in gives it back after a while; the next take
// starts it again and it is warm well before that take's first window finishes.
const LEASE_MS = 20_000, IDLE_MS = 5 * 60_000, MIN_FREE_MEMORY = 0.2;
type Waiter = { resolve: (transcript: Segment[]) => void; reject: (error: Error) => void };
let child: ChildProcess | null = null, starting: Promise<void> | null = null;
let leaseUntil = 0, lastUse = 0, review: ReturnType<typeof setTimeout> | undefined;
const followed = new Set<string>(), waiting = new Map<string, Waiter>();
/** The take recording now, so a worker that starts mid-take still follows it. */
let recording: { id: string; root: string; file: string } | null = null;

function send(value: unknown): boolean {
  if (!child?.stdin?.writable) return false;
  try { child.stdin.write(JSON.stringify(value) + "\n"); return true; } catch { return false; }
}
function stop(): void {
  const running = child; child = null;
  running?.stdin?.end(); running?.kill("SIGTERM");
}
const busy = () => !!recording || followed.size > 0 || waiting.size > 0;
const wanted = () => busy() || Date.now() < leaseUntil && Date.now() - lastUse < IDLE_MS;
/** The panel's lease, a take recording or finishing keeps the worker; otherwise it goes. */
function reviewSoon(): void {
  if (review) clearTimeout(review);
  review = undefined;
  if (!child) return;
  if (!wanted()) { stop(); return; }
  review = setTimeout(reviewSoon, busy() ? 5000 : Math.max(1000, Math.min(5000, leaseUntil - Date.now())));
  review.unref?.();
}
function start(): Promise<void> {
  if (child || !wanted() || availableMemoryShare() < MIN_FREE_MEMORY) return Promise.resolve();
  return starting ??= (async () => {
    const { pipelineFile, venvPython } = await import("./jobs");
    if (child || !wanted()) return;
    const worker = spawn(venvPython(), ["-I", pipelineFile("voice_stream.py")], { env: toolEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
    child = worker;
    let pending = "";
    worker.stdin!.on("error", () => {});
    worker.stdout!.on("data", chunk => {
      pending += chunk;
      if (pending.length > 1 << 24) { pending = ""; return; }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let message: { id?: string; transcript?: Segment[]; error?: string };
        try { message = JSON.parse(line); } catch { continue; }
        const waiter = message.id ? waiting.get(message.id) : undefined;
        if (!waiter || !message.id) continue;
        waiting.delete(message.id); followed.delete(message.id);
        if (Array.isArray(message.transcript)) waiter.resolve(message.transcript);
        else waiter.reject(new Error(message.error || "The voiceover worker couldn't transcribe this take."));
        reviewSoon();
      }
    });
    worker.once("error", () => { if (child === worker) child = null; });
    worker.once("close", () => {
      if (child === worker) child = null;
      // Whatever it was finishing falls back to the one-off transcription.
      for (const [id, waiter] of waiting) { waiting.delete(id); waiter.reject(new Error("The voiceover worker stopped.")); }
      followed.clear();
    });
    if (recording && send({ op: "follow", ...recording })) followed.add(recording.id);
    reviewSoon();
  })().finally(() => { starting = null; });
}

/** The Voiceover panel is open (renewed while it stays open) or has closed. */
export function warmVoiceover(open: boolean): void {
  if (open && Date.now() >= leaseUntil) lastUse = Date.now();  // opened, not renewed
  leaseUntil = open ? Date.now() + LEASE_MS : 0;
  if (open) void start().catch(() => {});
  reviewSoon();
}
/** A take began recording: the worker decodes its finished windows as it grows. */
export function followTake(id: string, root: string, file: string): void {
  recording = { id, root, file }; lastUse = Date.now();
  if (child) { if (send({ op: "follow", id, root, file })) followed.add(id); }
  else void start().catch(() => {});
}
/** The take is saved. Resolves with its words, or null when the worker isn't running (use the one-off path). */
export function finishTake(id: string, root: string, file: string, signal?: AbortSignal): Promise<Segment[]> | null {
  if (recording?.id === id) recording = null;
  lastUse = Date.now();
  if (!child || !send({ op: "finish", id, root, file })) { followed.delete(id); reviewSoon(); return null; }
  followed.add(id);
  return new Promise<Segment[]>((resolve, reject) => {
    const abort = () => { if (waiting.get(id)) { waiting.delete(id); followed.delete(id); send({ op: "cancel", id }); reviewSoon(); reject(signal!.reason); } };
    waiting.set(id, { resolve: v => { signal?.removeEventListener("abort", abort); resolve(v); }, reject: e => { signal?.removeEventListener("abort", abort); reject(e); } });
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** The take was never saved (nothing recorded) or is no longer wanted. */
export function cancelTake(id: string): void {
  if (recording?.id === id) recording = null;
  if (followed.delete(id)) send({ op: "cancel", id });
  reviewSoon();
}
app.on("before-quit", () => { leaseUntil = 0; recording = null; stop(); });
