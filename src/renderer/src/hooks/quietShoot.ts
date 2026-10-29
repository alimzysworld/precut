import type { Shoot } from "../../../shared/schema";
import { getApi } from "../data";

// Background metadata consumers share one read. Neither its large IPC reply
// nor its publication belongs between input events or playback frames.
type Read = { promise: Promise<Shoot | null>; resolve(value: Shoot | null): void; reject(error: unknown): void;
  reading: boolean; ready: boolean; value: Shoot | null };
const pending = new Map<string, Read>();
let listening = false, playing = false, inputAt = 0, timer: number | undefined;
const QUIET_MS = 800;
function schedule() {
  if (playing || timer !== undefined || !pending.size) return;
  timer = window.setTimeout(drain, Math.max(0, QUIET_MS - (performance.now() - inputAt)));
}
function drain() {
  timer = undefined;
  if (playing) return;
  if (performance.now() - inputAt < QUIET_MS) { schedule(); return; }
  for (const [root, read] of pending) {
    if (read.ready) { pending.delete(root); read.resolve(read.value); continue; }
    if (read.reading) continue;
    read.reading = true;
    void getApi().loadShoot(root).then(value => {
      read.value = value; read.ready = true; schedule();
    }, error => { pending.delete(root); read.reject(error); schedule(); });
  }
}
export function refreshShootWhenQuiet(root: string): Promise<Shoot | null> {
  if (!listening) {
    listening = true; inputAt = performance.now();
    const input = () => { inputAt = performance.now(); };
    ["keydown", "pointerdown", "pointermove", "wheel"].forEach(name => window.addEventListener(name, input, true));
    window.addEventListener("sidething:playing", event => {
      playing = !!(event as CustomEvent<boolean>).detail;
      if (!playing) schedule();
    });
    window.dispatchEvent(new CustomEvent("sidething:playing-request"));
  }
  let read = pending.get(root);
  if (!read) {
    let resolve!: Read["resolve"], reject!: Read["reject"];
    const promise = new Promise<Shoot | null>((yes, no) => { resolve = yes; reject = no; });
    read = { promise, resolve, reject, reading: false, ready: false, value: null };
    pending.set(root, read);
  }
  schedule(); return read.promise;
}
