import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "electron";
import type { Shoot, Segment, VoiceoverLine, VoiceoverScript } from "../shared/schema";
import type { StoredVersion } from "./sidekick";
import type { MusicTrack } from "./reel";
import { parseModelJson, runModel } from "./ai";
import { getEngine, getEngineModel } from "./settings";
import { getBrief, listQuestions } from "./brief";
import { writeJsonAtomic } from "./cut-storage";
import { mergeLeftOut } from "./left-out-state";
import { runActivity } from "./activity";
import { retimeScript, timeScript } from "./voiceover-retime";

// Private disk metadata leaves the shared UI contract unchanged.
interface SavedScript extends VoiceoverScript { editedIds?: string[]; story?: unknown; editLengthS?: number }
const fileFor = (root: string, cutId: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(cutId)) throw new Error("That edit id is invalid.");
  return path.join(path.resolve(root), ".sidething/voiceover", `${cutId}.json`);
};
async function optionalJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
const writes = new Map<string, Promise<unknown>>();
function serial<T>(file: string, work: () => Promise<T>): Promise<T> {
  const next = (writes.get(file) ?? Promise.resolve()).then(work), settled = next.catch(() => {});
  writes.set(file, settled);
  void settled.then(() => { if (writes.get(file) === settled) writes.delete(file); });
  return next;
}
export const wordCount = (text: string): number => text.trim().split(/\s+/u).filter(Boolean).length;
export async function voiceoverScript(root: string, cutId: string): Promise<VoiceoverScript | null> {
  const file = fileFor(root, cutId);
  const initial = await optionalJson<SavedScript | null>(file, null);
  // Read picture before taking the wording lock, preserving placement's lock
  // order. Opening the panel needs the latest assembly and its script's source,
  // rather than rehydrating every undo version during picture playback.
  const { readCut, loadDraftVersion } = await import("./sidekick");
  // VO7-2: the panel shows the current revision (what is on screen), not simply the newest snapshot.
  const on = await import("./revisions").then(m => m.currentVersion(root, cutId)).catch(() => 'latest' as const);
  const latest = await loadDraftVersion(root, cutId, on).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Preserve old empty/metadata-only envelopes until their first assembly.
    if (error instanceof Error && error.message === "Could not find that edit version's saved assembly.")
      return readCut(root, cutId).then(cut => cut.versions.at(-1) ?? null);  // at(-1) stays: an envelope with no assembly yet has only metadata
    throw error;
  });
  if (!latest) return initial;
  // Older imports can keep their only script embedded in a previous version.
  const embedded = latest.voiceover?.lines.length ? latest.voiceover : initial ? undefined
    : [...(await readCut(root, cutId)).versions].reverse().find(v => v.voiceover?.lines.length)?.voiceover;
  const wanted = initial ?? embedded;
  const source = wanted?.version === latest.version ? latest : wanted
    ? await loadDraftVersion(root, cutId, wanted.version).catch(error => {
      if (error instanceof Error && error.message === "Could not find that edit version's saved assembly.") return undefined;
      throw error;
    }) : undefined;
  const retry = Symbol('wording changed');
  const result = await serial<VoiceoverScript | null | typeof retry>(file, async () => {
    const onDisk = await optionalJson<SavedScript | null>(file, null);
    const saved = onDisk ?? embedded;
    if (!saved) return null;
    // VO7-5: one authority. A sidecar that disagrees with the current revision (written for an undone
    // or unpublished one, or older than voice this revision placed itself) is rewritten from the revision.
    if (onDisk && disagrees(onDisk, latest)) {
      const derived = deriveSidecar(onDisk, latest);
      if (derived) await writeJsonAtomic(file, derived, undefined, 2);
      return derived && timeScript(derived, latest.lengthS);
    }
    // A placement can change the script while this call waits for its lock.
    // Load its different source outside this queue, never in the inverse order.
    if (saved.version !== latest.version && saved.version !== wanted?.version) return retry;
    const fitted = timeScript(latest.voiceover?.version === latest.version && saved.version < latest.version &&
      latest.voiceover.writtenAt === saved.writtenAt && latest.voiceover.lines.length === saved.lines.length &&
      saved.lines.every(line => latest.voiceover!.lines.some(l => l.id === line.id))
      ? { ...saved, version: latest.version, lines: saved.lines.map(wording => {
        const line = latest.voiceover!.lines.find(l => l.id === wording.id)!;
        return { ...line, text: wording.text, take: wording.take };
      }) }
      : retimeScript(saved, source, latest), latest.lengthS);
    if (!onDisk || JSON.stringify(onDisk) !== JSON.stringify(fitted)) await writeJsonAtomic(file, fitted, undefined, 2);
    return fitted;
  });
  return result === retry ? voiceoverScript(root, cutId) : result;
}
/** VO7-5: the sidecar disagrees with this revision when it was written for a later one (undone, or never
 * published), or this revision placed its own voice and the sidecar is not from it. */
function disagrees(saved: SavedScript, record: Pick<StoredVersion, "version" | "voiceover">): boolean {
  if (saved.version > record.version) return true;
  // A revision's own voice, even none at all (the last piece removed), is the authority.
  return !!record.voiceover && record.voiceover.version === record.version && saved.version !== record.version;
}
/** VO7-5: the sidecar as the revision has it: its placed lines and their timing, with the script's own
 * private notes (story, his edited wording on lines not recorded yet) kept. */
function deriveSidecar(saved: SavedScript | null, record: Pick<StoredVersion, "version" | "voiceover">): SavedScript | null {
  const voice = record.voiceover;
  if (!voice || !voice.lines.length && voice.version !== record.version) {
    if (!saved || saved.version <= record.version) return saved;
    // Nothing is placed on this revision: a hand-placed take goes; a written script keeps its lines, unrecorded.
    return { ...saved, version: record.version, lines: saved.model === "by hand" ? [] : saved.lines.map(l => ({ ...l, take: null })), editLengthS: undefined };
  }
  const edited = new Set(saved?.editedIds ?? []);
  const lines = voice.lines.map(line => {
    const own = saved?.lines.find(l => l.id === line.id);
    return !line.take && own && edited.has(line.id) ? { ...line, text: own.text } : line;
  });
  return { ...(saved ?? {}), ...voice, cutId: voice.cutId ?? saved?.cutId, version: record.version, lines, editLengthS: undefined };
}
/** VO7-5: rewrite the sidecar from the current revision when they disagree. Runs after every commit,
 * undo and redo. Reads the revision before taking the wording lock, as the panel does, and starts again if
 * the current revision moves meanwhile. Never fails the edit that called it. Without `voice` (an edit that
 * did not touch the voice) it costs one small read when there is no sidecar or it is already current. */
/** VO7-5: the voice a commit wrote, keyed by the result it returned, so the sidecar can be derived from
 * that revision without parsing the edit file again. Only results of writes that landed reach a caller. */
export const committedVoice = new WeakMap<object, { version: number; voiceover: VoiceoverScript | undefined }>();
export async function syncVoiceoverSidecar(root: string, cutId: string, opts: { voice?: boolean; result?: object } = { voice: true }): Promise<VoiceoverScript | null> {
  root = path.resolve(root);
  const file = fileFor(root, cutId);
  const { currentVersion } = await import("./revisions"), { loadRevision } = await import("./sidekick");
  for (let attempt = 0; attempt < 3; attempt++) {
    const onDisk = await optionalJson<SavedScript | null>(file, null);
    if (!opts.voice && !onDisk) return null;
    const version = await currentVersion(root, cutId).catch(() => null);
    if (version === null) return onDisk;
    if (!opts.voice && onDisk?.version === version) return onDisk;
    const wrote = opts.result ? committedVoice.get(opts.result) : undefined;
    const record = wrote?.version === version ? wrote : await loadRevision(root, cutId, version, { light: true });
    const done = await serial(file, async () => {
      if (await currentVersion(root, cutId).catch(() => null) !== version) return undefined;
      const saved = await optionalJson<SavedScript | null>(file, null);
      if (saved && !disagrees(saved, record)) return saved;
      const derived = deriveSidecar(saved, record);
      if (derived && JSON.stringify(derived) !== JSON.stringify(saved)) await writeJsonAtomic(file, derived, undefined, 2);
      return derived;
    });
    if (done !== undefined) return done;
  }
  return optionalJson<SavedScript | null>(file, null);
}
/** Placement shares the wording queue so typing during placement is never lost. */
export function placeSavedVoiceover<T>(root: string, cutId: string, work: (script: VoiceoverScript) => Promise<{ script: VoiceoverScript; result: T }>): Promise<T> {
  const file = fileFor(root, cutId);
  return serial(file, async () => {
    const saved = await optionalJson<SavedScript | null>(file, null);
    if (!saved) throw new Error("Write a voiceover for this edit first.");
    const { script, result } = await work(timeScript(structuredClone(saved), saved.editLengthS));
    await writeJsonAtomic(file, { ...saved, ...script }, undefined, 2);
    return result;
  });
}
/** VO6: a commit that changes the voice (restoring a version). VO7-5: the sidecar is derived from the
 * committed revision after the commit, never written beside it; a refused commit (work throws) leaves it. */
export async function saveHandVoiceover<T>(root: string, cutId: string, work: () => Promise<{ script: VoiceoverScript; result: T }>): Promise<T> {
  const { result } = await work();
  await syncVoiceoverSidecar(root, cutId).catch(error => console.warn("[voiceover]", error));
  return result;
}
export function setVoiceoverLine(root: string, cutId: string, lineId: string, text: string): Promise<VoiceoverScript> {
  const file = fileFor(root, cutId);
  if (typeof text !== "string") throw new Error("Write the words for this line first.");
  return serial(file, async () => {
    const saved = await optionalJson<SavedScript | null>(file, null);
    if (!saved || !saved.lines.some(l => l.id === lineId)) throw new Error("Could not find that voiceover line.");
    saved.lines = saved.lines.map(l => l.id === lineId ? { ...l, text, take: null } : l);
    saved.editedIds = [...new Set([...(saved.editedIds ?? []), lineId])];
    const fitted = timeScript(saved, saved.editLengthS);
    await writeJsonAtomic(file, fitted, undefined, 2);
    return fitted;
  });
}

/** Damage checks only. A pause is outside the spoken span, so it consumes the gap. */
export function validateLines(lines: VoiceoverLine[], lengthS: number, pace: number): { lines: VoiceoverLine[]; problems: string[] } {
  const kept: VoiceoverLine[] = [], problems: string[] = [], ids = new Set<string>();
  let end = 0;
  for (const line of lines) {
    let problem = "";
    if (!line || typeof line.id !== "string" || !line.id || ids.has(line.id) || typeof line.text !== "string") problem = "needs unique id and text";
    else if (!Number.isFinite(line.s) || !Number.isFinite(line.e) || line.s < 0 || line.e <= line.s || line.e > lengthS) problem = "is outside the reel";
    else if (line.s < end - 1e-6) problem = "is out of order or overlaps the previous line or pause";
    else if (!Number.isFinite(line.pauseAfterS ?? 0) || (line.pauseAfterS ?? 0) < 0 || line.e + (line.pauseAfterS ?? 0) > lengthS + 1e-6) problem = "has a pause outside the reel";
    else if (wordCount(line.text) / pace > line.e - line.s + 1e-6) problem = `has ${wordCount(line.text)} words but only ${line.e - line.s} seconds at ${pace} words per second`;
    if (problem) problems.push(`${line?.id ?? "Line"}: ${problem}.`);
    else { kept.push(line); ids.add(line.id); end = line.e + (line.pauseAfterS ?? 0); }
  }
  return { lines: kept, problems };
}

export function speakingPace(segments: Segment[]): number {
  let words = 0, seconds = 0;
  for (const s of segments) if (s.e > s.s && s.text.trim()) { words += wordCount(s.text); seconds += s.e - s.s; }
  return seconds > 0 ? words / seconds : 2.5;
}
async function voiceExamples(root: string, shoot: Shoot): Promise<Segment[]> {
  const registry = await optionalJson<{ root: string }[]>(path.join(app.getPath("userData"), "shoots.json"), []);
  const others = await Promise.all(registry.filter(s => path.resolve(s.root) !== path.resolve(root)).map(async s => {
    try { return await optionalJson<Shoot | null>(path.join(s.root, ".sidething/index.json"), null); }
    catch { return null; } // a disconnected other shoot must not prevent writing
  }));
  const sources = await Promise.all([shoot, ...others].map(s => s ? mergeLeftOut(s) : null));
  return sources.flatMap(s => s ? [
    ...s.clips.filter(c => !c.leftOut && (c.byHand?.kind ?? c.judgement?.kind) === "talking").flatMap(c => c.transcript ?? []),
    ...s.audio.filter(a => a.role === "voiceover").flatMap(a => a.transcript ?? []),
  ] : []);
}
async function instructions(): Promise<string> {
  for (const base of [process.cwd(), app.getAppPath(), process.resourcesPath ?? ""]) {
    try { return await fs.readFile(path.join(base, "prompts/voiceover.md"), "utf8"); } catch { /* next */ }
  }
  throw new Error("Could not find precut's voiceover instructions.");
}
export async function voiceoverContext(root: string, record: StoredVersion) {
  const { shoot, cutList, template, reel } = record.assembly;
  const [brief, questions, examples, cache] = await Promise.all([getBrief(root), listQuestions(root), voiceExamples(root, shoot),
    optionalJson<{ entries?: Record<string, MusicTrack> }>(path.join(app.getPath("userData"), "music-cache.json"), {})]);
  const track = Object.values(cache.entries ?? {}).find(t => t.file === reel.music?.file);
  const stillFor = (clip: Shoot["clips"][number], s: number, e: number) => {
    const position = clip.meta?.durationS ? (s + e) / 2 / clip.meta.durationS : 0;
    return clip.frames[Math.min(clip.frames.length - 1, Math.max(0, Math.floor(position * clip.frames.length)))];
  };
  const activeShoot = await mergeLeftOut(shoot), excluded = new Set(activeShoot.clips.filter(c => c.leftOut).map(c => c.id));
  const allowedBroll = reel.broll.filter(b => !excluded.has(b.seg.clip.id));
  const shots = cutList.filter(item => !item.seg || !excluded.has(item.seg.clip.id)).map(item => ({ piece: item.piece, s: item.offsetFrames / template.fps,
    e: (item.offsetFrames + item.durTimelineFrames) / template.fps, clipId: item.seg?.clip.id,
    source: item.seg ? { s: item.seg.s, e: item.seg.e } : null, summary: item.seg?.clip.judgement?.summary ?? null,
    ...(item.seg?.clip.photo ? { photo: true, takenAt: item.seg.clip.photo.takenAt } : {}),
    still: item.seg ? stillFor(item.seg.clip, item.seg.s, item.seg.e) : null }));
  const frames = [...new Set([...shots.flatMap(s => s.still ? [s.still] : []), ...allowedBroll.flatMap(b => {
    const frame = stillFor(b.seg.clip, b.seg.s, b.seg.e); return frame ? [frame] : [];
  })])];
  const images: string[] = [];
  for (const frame of frames) {
    const file = path.resolve(root, ".sidething/frames", frame);
    if (!file.startsWith(path.resolve(root, ".sidething/frames") + path.sep)) continue;
    try { await fs.access(file); images.push(file); } catch { /* only already available stills */ }
  }
  return { images, context: { title: record.title, lengthS: record.lengthS, shots,
    broll: allowedBroll.map(b => ({ over: b.over, voiceIndex: b.voiceIndex, summary: b.seg.clip.judgement?.summary, source: { s: b.seg.s, e: b.seg.e },
      ...(b.seg.clip.photo ? { photo: true, takenAt: b.seg.clip.photo.takenAt } : {}) })),
    music: reel.music ? { ...reel.music, ...(track ? { tempo: track.tempo, beats: track.beats.map(b => b - reel.music!.startS).filter(b => b >= 0 && b <= record.lengthS), energy: track.energy } : {}) } : null,
    brief, questions, wordsPerSecond: speakingPace(examples), spokenExamples: examples.slice(0, 80).map(s => s.text) } };
}

const pending = new Map<string, Promise<VoiceoverScript>>();
const generations = new Map<string, Promise<unknown>>();
export function writeVoiceoverScript(root: string, cutId: string, version: number, opts?: { rewrite?: boolean }): Promise<VoiceoverScript> {
  root = path.resolve(root);
  const file = fileFor(root, cutId), key = `${file}:${version}:${!!opts?.rewrite}`;
  if (pending.has(key)) return pending.get(key)!;
  const work = (generations.get(file) ?? Promise.resolve()).catch(() => {}).then(() => runActivity({ kind: "ideas", root, target: { cutId, version }, label: "Writing your voiceover", cancelable: true }, async activity => {
    const record = await (await import("./sidekick")).loadDraftVersion(root, cutId, version);
    const before = await optionalJson<SavedScript | null>(file, null);
    const { images, context } = await voiceoverContext(root, record);
    const preserved = opts?.rewrite ? [] : before?.lines.filter(l => before.editedIds?.includes(l.id)) ?? [];
    const engine = await getEngine(), model = await getEngineModel(engine);
    const prompt = `${await instructions()}\n\n${JSON.stringify({ shootRoot: root, cutId, version, ...context, previous: before?.lines, preserved })}`;
    let raw = "", answer: { story?: unknown; lines?: VoiceoverLine[] } = {}, candidateLines: VoiceoverLine[] = [], checked: ReturnType<typeof validateLines> = { lines: [], problems: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      raw = await runModel({ engine, model, prompt: prompt + (attempt ? `\nRepair these problems: ${checked.problems.join(" ")}\nPrevious answer:\n${raw}` : ""), images, cwd: root, signal: activity.signal, libraryTools: true });
      try {
        answer = parseModelJson(raw) as typeof answer;
        if (!answer || !Array.isArray(answer.lines)) throw new Error("Return a JSON object with a lines array.");
        // Model output cannot attach recordings or private edit metadata.
        candidateLines = answer.lines.map(l => l && ({ id: l.id, text: l.text, s: l.s, e: l.e,
          ...(l.pauseAfterS !== undefined ? { pauseAfterS: l.pauseAfterS } : {}),
          ...(typeof l.pauseNote === "string" ? { pauseNote: l.pauseNote } : {}) }));
        checked = validateLines(candidateLines, record.lengthS, context.wordsPerSecond);
      } catch { answer = {}; checked = { lines: [], problems: ["Return a JSON object with a lines array."] }; }
      if (!checked.problems.length) break;
    }
    if (!Array.isArray(answer.lines)) throw new Error("Could not write the voiceover after two tries. Your saved words have been kept.");
    if (checked.problems.length) {
      const ids = new Set<string>();
      for (const line of candidateLines) {
        if (!line || typeof line.id !== "string" || !line.id || ids.has(line.id) || typeof line.text !== "string" ||
          !Number.isFinite(line.s) || !Number.isFinite(line.e) || line.s < 0 ||
          !Number.isFinite(line.pauseAfterS ?? 0) || (line.pauseAfterS ?? 0) < 0)
          throw new Error("Could not write the voiceover after two tries. Your saved words have been kept.");
        ids.add(line.id);
      }
      // The model has had its repair turn. Keep its story and order, then give
      // every line time to be said instead of silently deleting its words.
      checked.lines = timeScript({ cutId, version, lines: candidateLines, wordsPerSecond: context.wordsPerSecond,
        model: model ?? engine, writtenAt: "", editLengthS: record.lengthS }, record.lengthS).lines;
    }
    // VO7: every editor writes against the current revision. When the edit moved on while the model wrote
    // (a placement, undo or extend landed), this stale write is retried on the current revision: the new
    // lines follow its picture, rather than landing on the old one and being replaced by its voice unseen.
    // The current revision is read before the wording lock, the order voiceoverScript keeps.
    const { currentVersion } = await import("./revisions");
    for (let attempt = 0; ; attempt++) {
      const on = await currentVersion(root, cutId).catch(() => version);
      const target = on === version ? record : await (await import("./sidekick")).loadDraftVersion(root, cutId, on);
      const done = await serial(file, async () => {
        if (attempt < 3 && await currentVersion(root, cutId).catch(() => on) !== on) return null;
        // Re-read after the call: a person can change a line while the model writes.
        const latest = await optionalJson<SavedScript | null>(file, null);
        const editedIds = (latest?.editedIds ?? []).filter(id => !opts?.rewrite || latest?.lines.find(l => l.id === id)?.text !== before?.lines.find(l => l.id === id)?.text);
        const locked = latest?.lines.filter(l => editedIds.includes(l.id)) ?? [];
        const generated = checked.lines.filter(l => !locked.some(p => p.id === l.id || (l.s < p.e + (p.pauseAfterS ?? 0) && l.e + (l.pauseAfterS ?? 0) > p.s)));
        const written: SavedScript = timeScript({ cutId, version, lines: [...generated, ...locked].sort((a, b) => a.s - b.s), wordsPerSecond: context.wordsPerSecond,
          model: model ?? engine, writtenAt: new Date().toISOString(), editedIds, story: answer.story, editLengthS: record.lengthS }, record.lengthS);
        const saved = target === record ? written : retimeScript(written, record, target);
        activity.signal.throwIfAborted();
        await writeJsonAtomic(file, saved, activity.signal, 2);
        return saved;
      });
      if (done) return done;
    }
  }));
  pending.set(key, work);
  generations.set(file, work);
  void work.finally(() => {
    if (pending.get(key) === work) pending.delete(key);
    if (generations.get(file) === work) generations.delete(file);
  }).catch(() => {});
  return work;
}
