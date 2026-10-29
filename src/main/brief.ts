// WR1: a shoot's brief (the five opening questions) and the questions precut raises
// while it reads. Code stores and validates; the model decides what to ask and how
// the answers shape the edit. A change that would alter made work goes through the
// normal request queue, never a pipeline of its own.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ShootBrief, ShootQuestion, SidekickMessage } from "../shared/schema";
import { writeJsonAtomic } from "./cut-storage";
import { addRequest } from "./requests";

const FIELDS = ["purpose", "going", "feel", "music", "length"] as const;
type Field = typeof FIELDS[number];
const NAMES: Record<Field, string> = { purpose: "what it's for", going: "where it's going", feel: "feel", music: "music", length: "length" };
const briefFile = (root: string) => path.join(root, ".sidething/brief.json");
const questionsFile = (root: string) => path.join(root, ".sidething/questions.json");

export const emptyBrief = (): ShootBrief => ({ purpose: [], going: [], feel: [], music: [], length: [], asked: false });

// One writer per shoot for both files, so a brief change and an answer never interleave.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(root) ?? Promise.resolve()).then(work);
  const settled = next.catch(() => {});
  queues.set(root, settled);
  void settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
  return next;
}
async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

// Lenient: trimmed, de-duplicated text. The fixed choices live in the UI; the brief is
// context for the model, so an outside tool may say "Podcast" and that is kept.
function words(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`The brief's ${field} must be a list of choices.`);
  const kept: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`The brief's ${field} must be a list of choices.`);
    const text = item.trim().slice(0, 80);
    if (text && !kept.some(k => k.toLowerCase() === text.toLowerCase())) kept.push(text);
  }
  return kept.slice(0, 10);
}
function normalBrief(value: unknown): ShootBrief {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { purpose: words(raw.purpose, NAMES.purpose), going: words(raw.going, NAMES.going), feel: words(raw.feel, NAMES.feel),
    music: words(raw.music, NAMES.music), length: words(raw.length, NAMES.length), asked: raw.asked === true };
}
const said = (list: string[]) => !list.length ? "up to precut" : list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
const same = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.some(y => y.toLowerCase() === x.toLowerCase()));

export async function getBrief(root: string): Promise<ShootBrief> {
  root = path.resolve(root);
  try { return normalBrief(await json<unknown>(briefFile(root), null)); }
  catch (error) {
    if (error instanceof SyntaxError) return emptyBrief();  // a damaged file reads as "precut decides"; the next save replaces it
    throw error;
  }
}

/** Saves the brief. When ideas already exist and a choice changed, one request remakes what it affects. */
export async function setBrief(root: string, brief: ShootBrief): Promise<ShootBrief> {
  root = path.resolve(root);
  if (!brief || typeof brief !== "object") throw new Error("Choose what this footage is for, or skip.");
  const next = normalBrief(brief);
  const { saved, changes } = await serial(root, async () => {
    const before = await getBrief(root);
    // Once the opening questions were shown they never show again for this shoot.
    const saved: ShootBrief = { ...next, asked: next.asked || before.asked };
    const changes = FIELDS.filter(f => !same(before[f] ?? [], saved[f] ?? [])).map(f => `${NAMES[f]} is now ${said(saved[f] ?? [])} (was ${said(before[f] ?? [])})`);
    await writeJsonAtomic(briefFile(root), saved, undefined, 2);
    return { saved, changes };
  });
  if (changes.length) {
    const thread = await json<SidekickMessage[]>(path.join(root, ".sidething/sidekick/thread.json"), []).catch(() => []);
    const hasIdeas = Array.isArray(thread) && thread.some(m => (m.ideas?.length ?? 0) > 0);
    if (hasIdeas) await addRequest(root, `Brief changed: ${changes.join("; ")}. Remake the ideas and edits this affects.`);
  }
  return saved;
}

// ---- Questions

let forward: ((root: string) => void) | null = null;
/** ipc.ts sends `api:questions-changed` to every live window. Unset in the headless MCP process. */
export function setQuestionsForwarder(fn: ((root: string) => void) | null): void { forward = fn; }
function questionsChanged(root: string): void {
  try { forward?.(root); } catch (error) { console.error("[brief] Could not tell the app about a question:", error); }
}

const key = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[\s?.!]+$/, "").trim();
async function readQuestions(root: string): Promise<ShootQuestion[]> {
  const saved = await json<unknown>(questionsFile(root), []);
  if (!Array.isArray(saved)) throw new Error("Could not read precut's questions. The saved file has been kept.");
  return saved as ShootQuestion[];
}

export async function listQuestions(root: string): Promise<ShootQuestion[]> {
  root = path.resolve(root);
  return [...await readQuestions(root)].sort((a, b) => a.at.localeCompare(b.at));
}

export interface NewQuestion { text: string; why?: string; options: string[]; multi?: boolean; guess: string[] | string; clipIds?: string[]; kind?: "split"; folders?: string[] }

/** Raised by the model (WR3) or an outside tool. A question matching one already asked returns that one. */
export async function addQuestion(root: string, input: NewQuestion): Promise<ShootQuestion> {
  root = path.resolve(root);
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (!text) throw new Error("Write the question first.");
  if (text.length > 300) throw new Error("Keep the question under 300 characters.");
  const why = typeof input.why === "string" ? input.why.trim().slice(0, 500) : "";
  const options = Array.isArray(input.options) ? input.options.map(o => typeof o === "string" ? o.trim().slice(0, 80) : "").filter(Boolean) : [];
  const distinct = options.filter((o, i) => options.findIndex(p => p.toLowerCase() === o.toLowerCase()) === i);
  if (distinct.length < 2 || distinct.length > 4) throw new Error("Give 2 to 4 different options.");
  const multi = input.multi === true;
  const rawGuess = typeof input.guess === "string" ? [input.guess] : Array.isArray(input.guess) ? input.guess : [];
  const guess: string[] = [];
  for (const g of rawGuess) {
    const match = typeof g === "string" ? distinct.find(o => o.toLowerCase() === g.trim().toLowerCase()) : undefined;
    if (!match) throw new Error("precut's guess must be one of the options.");
    if (!guess.includes(match)) guess.push(match);
  }
  if (!guess.length) throw new Error("Say which option precut goes with until it's answered.");
  if (!multi && guess.length > 1) throw new Error("This question takes one answer, so precut's guess must be one option.");
  const clipIds = Array.isArray(input.clipIds) ? [...new Set(input.clipIds.filter((c): c is string => typeof c === "string" && !!c.trim()))] : [];
  const folders = input.kind === "split" ? await (await import("./folder-shape")).validateSplitFolders(root, input.folders) : undefined;
  if (folders && (multi || distinct.length !== 2 || distinct[0] !== "One video" || distinct[1] !== "Separate shoots")) throw new Error("Choose One video or Separate shoots.");
  const result = await serial(root, async () => {
    const questions = await readQuestions(root);
    // Asking again what was already asked, open or answered, would nag: keep the first one.
    const leavingOut = distinct.length === 2 && distinct.includes("Leave out") && distinct.includes("Keep them") && clipIds.length > 0;
    const existing = questions.find(q => key(q.text) === key(text) || input.kind === "split" && q.kind === "split"
      || leavingOut && q.options.includes("Leave out") && q.options.includes("Keep them") && q.clipIds?.length === clipIds.length && clipIds.every(id => q.clipIds!.includes(id)));
    if (existing) return { question: existing, added: false };
    const base = `q-${createHash("sha256").update(key(text)).digest("hex").slice(0, 12)}`;
    let id = base;
    for (let n = 2; questions.some(q => q.id === id); n++) id = `${base}-${n}`;
    const question: ShootQuestion = { id, text, why, options: distinct, multi, guess, answer: null, answeredBy: null,
      ...(folders ? { kind: "split", folders } : {}),
      ...(clipIds.length ? { clipIds } : {}), at: new Date().toISOString() };
    await writeJsonAtomic(questionsFile(root), [...questions, question], undefined, 2);
    return { question, added: true };
  });
  if (result.added) questionsChanged(root);
  return result.question;
}

/** [] = "You decide": precut keeps its guess. A different answer than what the edits were made with queues one request. */
export async function answerQuestion(root: string, id: string, answer: string[]): Promise<ShootQuestion> {
  root = path.resolve(root);
  if (!Array.isArray(answer) || answer.some(a => typeof a !== "string")) throw new Error("Choose one of the options, or You decide.");
  const { question, request } = await serial(root, async () => {
    const questions = await readQuestions(root);
    const index = questions.findIndex(q => q.id === id);
    if (index < 0) throw new Error("Could not find that question. It may have been answered already.");
    const before = questions[index];
    const chosen: string[] = [];
    for (const a of answer) {
      const match = before.options.find(o => o.toLowerCase() === a.trim().toLowerCase());
      if (!match) throw new Error("Choose one of the question's options, or You decide.");
      if (!chosen.includes(match)) chosen.push(match);
    }
    if (!before.multi && chosen.length > 1) throw new Error("This question takes one answer.");
    // What the edits were made with: the person's answer, else precut's guess.
    const used = (q: ShootQuestion) => q.answeredBy === "you" && q.answer?.length ? q.answer : q.guess;
    const after: ShootQuestion = { ...before, answer: chosen, answeredBy: chosen.length ? "you" : "precut" };
    // A folder answer changes the library, never the edit request queue. Keep
    // the question open if registering a child fails, so the person can retry.
    if (before.kind === "split" && (before.answer === null || !same(used(before), used(after)))) {
      if (before.answer !== null && used(before)[0] === "Separate shoots") throw new Error("These folders are already separate shoots.");
      await (await import("./folder-shape")).applyFolderAnswer(root, after);
    }
    const leaveOutQuestion = before.clipIds?.length && before.options.length === 2 && before.options.includes("Leave out") && before.options.includes("Keep them");
    if (leaveOutQuestion && (before.answer === null || !same(used(before), used(after)))) {
      await (await import("./left-out")).leaveOut(root, before.clipIds!, chosen[0] === "Leave out");
    }
    questions[index] = after;
    await writeJsonAtomic(questionsFile(root), questions, undefined, 2);
    const request = leaveOutQuestion || before.kind === "split" || same(used(before), used(after)) ? null
      : `precut asked: "${before.text}" It had gone with ${said(used(before))}. The answer is ${said(used(after))}. Remake the ideas and edits this affects.`;
    return { question: after, request };
  });
  try { if (request) await addRequest(root, request); }
  finally { questionsChanged(root); }
  return question;
}
