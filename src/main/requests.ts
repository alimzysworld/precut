// Requests add work to the normal ideas/cut route. Saving never waits for a model.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirInShoot } from "./shoot-dir";
import type { Shoot, ShootRequest, SidekickMessage } from "../shared/schema";
import { changed, queueAutopilot, sidekickSend } from "./sidekick";
import { processingSnapshot } from "./jobs";
import { setRequestWake } from "./steps";
import { begin, type ActivityHandle } from "./activity";
import { sidekickThread } from "./sidekick";

// The shared contract has no successful no-edit explanation field. Keep the
// model's words and reply link on disk without misusing the failure-only error.
type StoredRequest = ShootRequest & { replyId?: string; reason?: string };
const stores = new Map<string, Promise<unknown>>();
const pending = new Set<string>();
const waking = new Map<string, Promise<void>>();
const nudged = new Set<string>();
const working = new Set<string>();
const draining = new Map<string, Promise<void>>();
const draftActivities = new Map<string, ActivityHandle>();
async function announceDraft(root: string, request: ShootRequest) {
  if (!request.fromIdea || !["queued", "working"].includes(request.state) || draftActivities.has(request.id)) return;
  const thread = await sidekickThread(root);
  const idea = thread.find(m => m.id === request.fromIdea!.messageId)?.ideas?.[request.fromIdea.index];
  if (!idea || draftActivities.has(request.id)) return;
  draftActivities.set(request.id, begin({ root, kind: "cut", target: { ideaId: idea.id ?? `${request.fromIdea.messageId}:${request.fromIdea.index}` }, label: `Queued: ${idea.title}`, cancelable: false }));
}
const file = (root: string) => path.join(root, ".sidething/requests.json");

function store<T>(root: string, work: () => Promise<T>): Promise<T> {
  const next = (stores.get(root) ?? Promise.resolve()).then(work);
  const settled = next.catch(() => {});
  stores.set(root, settled);
  void settled.then(() => { if (stores.get(root) === settled) stores.delete(root); });
  return next;
}
async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
async function save(root: string, requests: StoredRequest[]): Promise<void> {
  const target = file(root), temporary = `${target}.${randomUUID()}.tmp`;
  await mkdirInShoot(path.dirname(target));  // FIX3: a renamed or moved shoot is never recreated
  try {
    await fs.writeFile(temporary, JSON.stringify(requests, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  if (requests.some(r => r.state === "queued")) pending.add(root); else pending.delete(root);
  changed(root);
}
async function read(root: string): Promise<StoredRequest[]> {
  const requests = await json<StoredRequest[]>(file(root), []);
  if (!Array.isArray(requests)) throw new Error("Could not read your requests. Your saved file has been kept.");
  let dirty = false;
  if (!requests.length) {
    const focus = await json<unknown>(path.join(root, ".sidething/focus.json"), "");
    if (typeof focus === "string" && focus.trim()) {
      const thread = await json<SidekickMessage[]>(path.join(root, ".sidething/sidekick/thread.json"), []);
      const ideas = thread.flatMap(m => (m.ideas ?? []).map((idea, index) => ({ ...idea, id: idea.id ?? `${m.id}:${index}` })));
      requests.push({ id: randomUUID(), text: focus.trim(), at: new Date().toISOString(),
        state: ideas.length ? "done" : "queued", ideaIds: ideas.flatMap((i) => i.id ? [i.id] : []),
        cutIds: [...new Set(ideas.flatMap(i => i.cutId ? [i.cutId] : []))] });
      dirty = true;
    }
  }
  for (const request of requests) if (request.state === "working" && !working.has(root)) {
    request.state = request.fromIdea ? "queued" : "failed";
    request.error = request.fromIdea ? undefined : "This request was interrupted. Your saved ideas and edits have been kept. Send it again to continue.";
    dirty = true;
  }
  if (requests.some(r => r.state === "queued")) pending.add(root); else pending.delete(root);
  if (dirty) await save(root, requests);
  return requests;
}
async function update(root: string, request: StoredRequest): Promise<void> {
  await store(root, async () => {
    const requests = await read(root), index = requests.findIndex(r => r.id === request.id);
    if (index < 0) throw new Error("Could not find the saved request.");
    requests[index] = request;
    await save(root, requests);
  });
}

export async function listRequests(root: string): Promise<ShootRequest[]> {
  root = path.resolve(root);
  // Resume durable, already-authorized work after reopening a shoot, without
  // creating another request or blocking this read behind generation.
  const known = pending.has(root);
  const requests = await store(root, () => read(root));
  for (const request of requests) await announceDraft(root, request);
  if (!known) wakeRequests(root);
  // The model's own words for a request that finished without an edit reach the app as `note`.
  return requests.map(({ replyId: _replyId, reason, ...request }) => ({ ...request, ...(reason && !request.error ? { note: reason } : {}) }));
}
/** What the person has told precut they are making, newest last. Read-only, no wake-ups. */
export async function requestBrief(root: string): Promise<string[]> {
  const requests = await json<StoredRequest[]>(file(path.resolve(root)), []).catch(() => []);
  return (Array.isArray(requests) ? requests : []).filter(r => r.state !== "failed" && typeof r.text === "string").slice(-5).map(r => r.text);
}
export async function addRequest(root: string, text: string, fromIdea?: { messageId: string; index: number }): Promise<ShootRequest> {
  root = path.resolve(root);
  if (typeof text !== "string" || !text.trim()) throw new Error("Describe what you want to make first.");
  if (text.length > 10_000) throw new Error("Keep your request under 10,000 characters.");
  const thread = fromIdea ? await sidekickThread(root) : [];
  const idea = fromIdea ? thread.find(m => m.id === fromIdea.messageId)?.ideas?.[fromIdea.index] : undefined;
  if (fromIdea && (!Number.isInteger(fromIdea.index) || !idea)) throw new Error("Could not find that idea. Open the latest ideas and try again.");
  let request: ShootRequest = { id: randomUUID(), text: text.trim(), at: new Date().toISOString(),
    ...(fromIdea ? { fromIdea, ideaIds: [idea!.id ?? `${fromIdea.messageId}:${fromIdea.index}`] } : { ideaIds: [] }),
    state: "queued", cutIds: [] };
  await store(root, async () => {
    const requests = await read(root);
    const existing = fromIdea && requests.find(r => ["queued", "working"].includes(r.state) && r.ideaIds.some(id => request.ideaIds.includes(id)));
    if (existing) { request = existing; return; }
    requests.push(request); await save(root, requests);
  });
  await announceDraft(root, request);
  wakeRequests(root);
  return request;
}

export async function requestInputsReady(root: string): Promise<boolean> {
  const shoot = await json<Shoot | null>(path.join(root, ".sidething/index.json"), null);
  const clips = shoot?.clips.filter(c => c.stage !== "error") ?? [];
  if (!clips.length || clips.some(c => !c.meta || c.transcript == null)) return false;
  const stages = await processingSnapshot(root);
  for (const id of ["transcribe", "group"] as const) {
    if (stages[id] && !["done", "skipped"].includes(stages[id]!.state)) return false;
  }
  // Empty takes can be a finished, entirely B-roll shoot. The existing judge's
  // saved judgement distinguishes that from grouping which has not happened.
  return !!shoot && (shoot.takes.length > 0 || clips.every(c => !!c.judgement));
}

// Called by the existing step notifications, not a polling timer. Only shoots
// with queued requests are considered, and the normal shoot lock owns all calls.
export function wakeRequests(root: string): void {
  root = path.resolve(root);
  if (!pending.has(root)) return;
  if (waking.has(root)) { nudged.add(root); return; }
  const work = Promise.resolve().then(async () => {
    if (await requestInputsReady(root)) await queueAutopilot(root);
  }).catch(error => {
    nudged.delete(root); // A failed automatic call must not create a retry loop.
    console.error("[requests] Could not resume requests:", error);
  });
  waking.set(root, work);
  void work.finally(() => {
    if (waking.get(root) === work) waking.delete(root);
    if (nudged.delete(root) && pending.has(root)) wakeRequests(root);
  });
}
setRequestWake(wakeRequests);

export function processRequests(root: string): Promise<void> {
  root = path.resolve(root);
  const existing = draining.get(root);
  if (existing) return existing;
  const work = Promise.resolve().then(async () => {
    if (!await requestInputsReady(root)) return;
    while (true) {
      const request = await store(root, async () => {
        const requests = await read(root), next = requests.find(r => r.state === "queued");
        if (!next) return undefined;
        working.add(root);
        next.state = "working";
        await save(root, requests);
        return { ...next };
      });
      if (!request) return;
      try {
        if (request.fromIdea) {
          const draft = await sidekickSend(root, request.text, { fromIdea: request.fromIdea, requestId: request.id });
          request.replyId = draft.id;
          if (draft.error) throw new Error(draft.error);
          if (!draft.cut) throw new Error(draft.text || "Couldn't make this edit. Try again.");
          request.cutIds = [draft.cut.cutId];
          request.state = "done";
        } else {
          const reply = await sidekickSend(root, request.text, { addIdeas: true, requestId: request.id });
          request.replyId = reply.id;
          request.ideaIds = (reply.ideas ?? []).flatMap(i => i.id ? [i.id] : []);
          if (reply.error) throw new Error(reply.error);
          await update(root, request);
          // The model orders candidates and marks its strongest. Missing shots
          // can be placeholders, just as they are for a Make this click.
          const feasible = (reply.ideas ?? []).map((idea, index) => ({ idea, index }))
            .filter(({ idea }) => idea.uses.length && !idea.passed);
          const best = feasible.find(({ idea }) => idea.pick) ?? feasible[0];
          const saved = await store(root, () => read(root));
          const chosen = saved.some(r => r.fromIdea && r.state !== "failed" &&
            (r.fromIdea.messageId === reply.id || r.ideaIds.some(id => request.ideaIds.includes(id))));
          const newerBrief = saved.slice(saved.findIndex(r => r.id === request.id) + 1).some(r => !r.fromIdea);
          if (best && !chosen && !newerBrief) {
            const draft = await sidekickSend(root, `Draft this idea: ${best.idea.title}`, {
              fromIdea: { messageId: reply.id, index: best.index }, requestId: request.id,
            });
            request.replyId = draft.id;
            if (draft.error) throw new Error(draft.error);
            if (draft.cut) request.cutIds = [draft.cut.cutId];
            else request.reason = draft.text;
          } else request.reason = reply.text;
          request.state = "done";
        }
      } catch (error) {
        request.state = "failed";
        request.error = error instanceof Error && error.name === "AbortError" ? "Canceled"
          : error instanceof Error ? error.message : "Could not finish this request. Try again.";
      }
      try {
        await update(root, request);
      } finally {
        working.delete(root);
        const activity = draftActivities.get(request.id);
        if (request.state === "failed") activity?.fail(request.error ?? "Couldn't make this edit."); else activity?.done();
        draftActivities.delete(request.id);
      }
    }
  });
  draining.set(root, work);
  void work.finally(() => { if (draining.get(root) === work) draining.delete(root); }).catch(() => {});
  return work;
}
