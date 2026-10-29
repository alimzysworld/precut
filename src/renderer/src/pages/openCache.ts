import type { Cut, DraftTimeline } from "../../../shared/schema";
import { getApi } from "../data";

type Aspect = "9:16" | "16:9" | "1:1" | "4:5";

// Opening an edit is a chain: shoot, edit list, draft plan, decoders. These
// short-lived promises let the links start together instead of one after another.
const FRESH_MS = 15_000;
const cutLists = new Map<string, { at: number; promise: Promise<Cut[]> }>();
const drafts = new Map<string, { at: number; promise: Promise<DraftTimeline> }>();

function fresh<T>(entry: { at: number; promise: Promise<T> } | undefined): Promise<T> | undefined {
  return entry && Date.now() - entry.at < FRESH_MS ? entry.promise : undefined;
}

/** Start listing edits now; the first reader takes the result. */
export function prefetchCuts(root: string): Promise<Cut[]> {
  const promise = getApi().listCuts(root);
  cutLists.set(root, { at: Date.now(), promise });
  promise.catch(() => { if (cutLists.get(root)?.promise === promise) cutLists.delete(root); });
  return promise;
}
export function takeCuts(root: string): Promise<Cut[]> | undefined {
  const hit = fresh(cutLists.get(root));
  cutLists.delete(root);
  return hit;
}

export const draftKeyFor = (root: string, cutId: string, version: number, aspect: Aspect | undefined, revision: number) => `${root}:${cutId}:${version}:${aspect ?? "base"}:${revision}`;
/** Start the draft plan for the edit most likely to open; a wrong guess only warms main's caches. */
export function prefetchDraft(root: string, cutId: string, version: number, aspect?: Aspect, revision = 0): void {
  const key = draftKeyFor(root, cutId, version, aspect, revision);
  if (fresh(drafts.get(key))) return;
  const promise = Promise.resolve().then(() => getApi().draftTimeline(root, cutId, version, aspect));
  drafts.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (drafts.get(key)?.promise === promise) drafts.delete(key); });
  if (drafts.size > 6) drafts.delete(drafts.keys().next().value!);
}
export function takeDraft(root: string, cutId: string, version: number, aspect: Aspect | undefined, revision: number): Promise<DraftTimeline> | undefined {
  const key = draftKeyFor(root, cutId, version, aspect, revision);
  const hit = fresh(drafts.get(key));
  drafts.delete(key);
  return hit;
}
