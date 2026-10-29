import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { availableParallelism } from 'node:os';
import { existsSync } from 'node:fs';
import type { GradeJob } from './grade-worker';
export type GradeTable = { size: number; data: Float64Array; cube?: string };
let serial = 0;
type Lane = { worker?: Worker; pending: Map<number, { resolve: (v: GradeTable) => void; reject: (e: Error) => void }> };
const pending = (lane: Lane) => lane.pending;
// One worker for everything that writes or exports (unchanged). OPEN1: opening an edit asks for one live table per
// piece (37 on his edit), each ~30 ms of worker time, and they queued one behind another for over a second before the
// first picture could draw. liveLut's tables (gradeWork(job, { live: true })) share a few workers of their own; the
// maths is the same worker file, so the tables are the same.
const main: Lane = { pending: new Map() };
const LIVE = Math.min(3, Math.max(1, Math.floor(availableParallelism() / 4)));
const live: Lane[] = Array.from({ length: LIVE }, () => ({ pending: new Map() }));
const laneFor = (options?: { live?: boolean }): Lane => options?.live
  ? live.reduce((best, lane) => lane.pending.size < best.pending.size ? lane : best) : main;
const inFlight = new Map<string, Promise<GradeTable>>();
const cache = new Map<string, GradeTable>();
function start(lane: Lane): Worker {
  if (lane.worker) return lane.worker;
  const local = path.join(__dirname, 'grade-worker.js');
  const active = new Worker(process.env.PRECUT_GRADE_WORKER || (existsSync(local) ? local : path.resolve('out/main/grade-worker.js')));
  lane.worker = active;
  active.on('message', ({ id, error, ...result }) => {
    const call = pending(lane).get(id); if (!call) return;
    pending(lane).delete(id); if (!pending(lane).size) active.unref();
    error ? call.reject(new Error(error)) : call.resolve(result);
  });
  const failed = (error: Error) => {
    if (lane.worker !== active) return;
    lane.worker = undefined;
    for (const call of pending(lane).values()) call.reject(error);
    pending(lane).clear(); inFlight.clear();
  };
  active.on('error', failed);
  active.on('exit', code => {
    if (lane.worker !== active) return;
    if (pending(lane).size) failed(new Error(`Colour worker stopped (${code}).`)); else lane.worker = undefined;
  });
  active.unref(); return active;
}
/** Immutable jobs coalesce across gallery, export and playback. Sliders never
 * enqueue work; V13's save queue admits only the latest follow-up render. */
export function gradeWork(job: GradeJob, options?: { live?: boolean }): Promise<GradeTable> {
  const key = JSON.stringify(job), ready = cache.get(key);
  if (ready) { cache.delete(key); cache.set(key, ready); return Promise.resolve(ready); }
  const existing = inFlight.get(key); if (existing) return existing;
  const promise = new Promise<GradeTable>((resolve, reject) => {
    const lane = laneFor(options), active = start(lane), id = ++serial;
    pending(lane).set(id, { resolve, reject }); active.ref(); active.postMessage({ id, job });
  });
  inFlight.set(key, promise);
  void promise.then(table => {
    inFlight.delete(key); cache.set(key, table);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
  }, () => inFlight.delete(key));
  return promise;
}
