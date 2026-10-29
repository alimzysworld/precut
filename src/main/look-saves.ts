import * as path from 'node:path';
import { trackSave } from './writer-lock';

type Saved = { cutId: string; version: number; baseVersion?: number };
type Queue = { tail: Promise<void>; latest?: number; pending: number };
type Render = { preparing: Set<Promise<void>>; pending: Set<Promise<Saved>>; latest?: number; revision: number };
const queues = new Map<string, Queue>();
const renders = new Map<string, Render>();
const preparations = new Map<string, Promise<void>>();
const keyFor = (root: string, cutId: string) => JSON.stringify([path.resolve(root), cutId]);

/** Reserve call order before asynchronous clip classification. The boxed result
 * releases the preparation gate once the save is registered, not when it ends. */
export function prepareLookSave<T>(root: string, cutId: string, work: () => Promise<{ result: Promise<T> }>): Promise<T> {
  const key = keyFor(root,cutId);
  const prepared = (preparations.get(key) ?? Promise.resolve()).then(work);
  const ready = prepared.then(() => {}, () => {});
  preparations.set(key,ready);
  const render = renders.get(key);
  if (render) { render.preparing.add(ready); void ready.then(() => render.preparing.delete(ready)); }
  void ready.then(() => {
    if (preparations.get(key) !== ready) return;
    preparations.delete(key);
    if (queues.get(key)?.pending === 0) queues.delete(key);
  });
  return trackSave(prepared.then(({result}) => result));  // FIX2: quit waits for it
}

/** Each release remains an undoable version. Only picture renders are coalesced. */
export function saveLook(root: string, cutId: string, version: number, work: (base: number) => Promise<Saved>): Promise<Saved> {
  const key = keyFor(root, cutId);
  let queue = queues.get(key);
  if (!queue) { queue = { tail: Promise.resolve(), pending: 0 }; queues.set(key, queue); }
  const state = queue; state.pending++;
  const saved = state.tail.then(async () => {
    const base = state.latest ?? version;
    const result = await work(base);
    state.latest = result.version;
    return { ...result, baseVersion: result.baseVersion ?? base };
  });
  state.tail = saved.then(() => {}, () => {}).finally(() => {
    if (--state.pending === 0 && !preparations.has(key)) queues.delete(key);
  });
  const render = renders.get(key);
  if (render) {
    render.pending.add(saved);
    void saved.then(result => { render.latest = result.version; render.revision++; }, () => {}).finally(() => render.pending.delete(saved));
  }
  return trackSave(saved);  // FIX2: quit waits for it
}

/** Read the saved snapshot after releases already registered at export start. */
export async function waitForLiveSaves(root: string, cutId: string, version: number): Promise<number> {
  const key = keyFor(root, cutId), preparing = preparations.get(key);
  const queued = queues.get(key);
  if (preparing) await preparing;
  const queue = queues.get(key) ?? queued;
  if (queue?.pending) await queue.tail;
  return queue?.latest ?? version;
}

/** Finish the current snapshot, then render once with all released look changes. */
export async function renderLatestLook<T>(root: string, cutId: string, version: number, draw: (version: number) => Promise<T>): Promise<T> {
  const key = keyFor(root, cutId);
  // Multiple explicit exports retain their own selected version.
  if (renders.has(key)) return draw(version);
  const state: Render = { preparing: new Set(), pending: new Set(), revision: 0 };
  const preparing = preparations.get(key);
  if (preparing) { state.preparing.add(preparing); void preparing.then(() => state.preparing.delete(preparing)); }
  renders.set(key, state);
  try {
    // Releases already queued when Export is clicked belong to its starting
    // snapshot too. New releases during the render use the follow-up below.
    const queued = queues.get(key);
    if (queued?.pending) await queued.tail;
    let revision = state.revision, result = await draw(state.latest ?? queued?.latest ?? version);
    for (;;) {
      while (state.pending.size || state.preparing.size) await Promise.allSettled([...state.pending,...state.preparing]);
      if (revision === state.revision || state.latest === undefined) return result;
      revision = state.revision;
      result = await draw(state.latest);
    }
  } finally { renders.delete(key); }
}
