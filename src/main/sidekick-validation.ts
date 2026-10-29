import type { ReelIdea, Shoot } from "../shared/schema";
import { reelIds, type ReelAnswer } from "./reel";

type Moment = { clipId: string; s: number; e: number };
/** WR3: a question the model raised while reading the shoot, with the guess it already made the work with. */
export interface RaisedQuestion { text: string; why: string; options: string[]; multi: boolean; guess: string[]; clipIds: string[] }
export interface SidekickReply {
  text: string; clips: Moment[]; ideas: ReelIdea[] | null;
  cut: (ReelAnswer & { concept: string }) | null; missing: string[];
  titles?: { prompt: string; skillIds: string[] } | null;
  better?: boolean;  // BUG1: the model routed this note to Make it better (list fixes first, change nothing)
  questions: RaisedQuestion[];
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
export class ReplyShapeError extends Error {}

// WR3: a bad question is dropped, never a failed reply: the ideas and edits in the same
// reply stand on their own. The reasons go to the log, never into the person's text.
export function parseQuestions(value: unknown, shoot: Shoot): { questions: RaisedQuestion[]; dropped: string[] } {
  const questions: RaisedQuestion[] = [], dropped: string[] = [];
  if (value === undefined || value === null) return { questions, dropped };
  if (!Array.isArray(value)) return { questions, dropped: ["questions was not a list."] };
  const clipIds = new Set(shoot.clips.map(c => c.id));
  for (const q of value) {
    const text = object(q) && typeof q.text === "string" ? q.text.trim() : "";
    if (!object(q) || !text || text.length > 300) { dropped.push(`Dropped a question without usable text.`); continue; }
    const raw = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string").map(o => o.trim().slice(0, 80)).filter(Boolean) : [];
    const options = raw.filter((o, i) => raw.findIndex(p => p.toLowerCase() === o.toLowerCase()) === i);
    if (options.length < 2 || options.length > 4) { dropped.push(`Dropped "${text}": it needs 2 to 4 different options.`); continue; }
    const multi = q.multi === true;
    const named = typeof q.guess === "string" ? [q.guess] : Array.isArray(q.guess) ? q.guess : [];
    const guess = named.map(g => typeof g === "string" ? options.find(o => o.toLowerCase() === g.trim().toLowerCase()) : undefined);
    if (!guess.length || guess.some(g => !g) || (!multi && new Set(guess).size > 1)) { dropped.push(`Dropped "${text}": its guess must be ${multi ? "some" : "one"} of its options.`); continue; }
    questions.push({ text, why: typeof q.why === "string" ? q.why.trim().slice(0, 500) : "", options, multi, guess: [...new Set(guess as string[])],
      clipIds: strings(q.clipIds) ? [...new Set(q.clipIds.filter(id => clipIds.has(id)))] : [] });
  }
  return { questions, dropped };
}
export function parseSidekick(raw: string, shoot: Shoot): { reply: SidekickReply; warnings: string[]; dropped: string[] } {
  let v: unknown;
  try { v = JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw.trim()); }
  catch { throw new ReplyShapeError("The answer must be a JSON object."); }
  const fail = (): never => { throw new ReplyShapeError("Expected text, clips, ideas or null, cut or null, and missing in the supplied JSON shape."); };
  if (!object(v) || typeof v.text !== "string" || !Array.isArray(v.clips) || !strings(v.missing)) return fail();
  const { voice, broll } = reelIds(shoot);
  const warnings: string[] = [];
  const known = (id: string) => {
    if (voice.has(id) || broll.has(id)) return true;
    warnings.push(`Dropped unknown footage id ${id}.`); return false;
  };
  const clips: Moment[] = v.clips.flatMap((m) => {
    if (!object(m) || typeof m.clipId !== "string" || typeof m.s !== "number" || typeof m.e !== "number") return fail();
    const clip = shoot.clips.find((c) => c.id === m.clipId);
    if (!clip?.meta || !Number.isFinite(m.s) || !Number.isFinite(m.e) || m.s < 0 || m.e <= m.s || m.e > clip.meta.durationS) {
      warnings.push(`Dropped unknown clip or invalid moment ${m.clipId}.`); return [];
    }
    return [{ clipId: m.clipId, s: m.s, e: m.e }];
  });
  let ideas: ReelIdea[] | null = null;
  if (v.ideas !== null) {
    if (!Array.isArray(v.ideas)) return fail();
    ideas = v.ideas.map((i) => {
      if (!object(i) || typeof i.title !== "string" || typeof i.concept !== "string" || typeof i.hook !== "string" ||
        !positive(i.lengthS) || !strings(i.uses) || !strings(i.missing)) return fail();
      return { title: i.title, concept: i.concept, hook: i.hook, lengthS: i.lengthS, uses: i.uses.filter(known), missing: i.missing };
    });
  }
  let cut: SidekickReply["cut"] = null;
  if (v.cut !== null) {
    const c = v.cut;
    if (!object(c) || typeof c.title !== "string" || !c.title.trim() || typeof c.concept !== "string" ||
      !strings(c.voice) || !Array.isArray(c.broll) || typeof c.why !== "string" || !strings(c.warnings)) return fail();
    const voiceIds = c.voice.filter((id) => {
      if (voice.has(id)) return true;
      warnings.push(`Dropped unknown voice id ${id}.`); return false;
    });
    const overlays: ReelAnswer["broll"] = c.broll.flatMap((b) => {
      if (!object(b) || typeof b.id !== "string" || !(b.over === null || typeof b.over === "string")) return fail();
      if (!broll.has(b.id) || (b.over !== null && !voiceIds.includes(b.over))) {
        warnings.push(`Dropped b-roll ${b.id} over ${b.over}: unknown id.`); return [];
      }
      return [{ id: b.id, over: b.over }];
    });
    const m = c.music;
    let spans: ReelAnswer["spans"];
    if (c.spans !== undefined) {
      if (!Array.isArray(c.spans)) return fail();
      const seen = new Set<string>();
      spans = c.spans.map(span => {
        if (!object(span) || typeof span.id !== "string" || typeof span.s !== "number" || typeof span.e !== "number") return fail();
        const seg = voice.get(span.id) ?? broll.get(span.id);
        if (seen.has(span.id) || !seg || !Number.isFinite(span.s) || !Number.isFinite(span.e) || span.s < seg.s || span.e > seg.e || span.e <= span.s)
          throw new ReplyShapeError("spans must name each shot once with source seconds inside its listed span.");
        seen.add(span.id);
        return { id: span.id, s: span.s, e: span.e };
      });
    }
    let photoSpans: ReelAnswer["photoSpans"];
    if (c.photoSpans !== undefined) {
      if (!Array.isArray(c.photoSpans)) return fail();
      const seen = new Set<string>();
      photoSpans = c.photoSpans.map(span => {
        if (!object(span) || typeof span.id !== "string" || typeof span.s !== "number" || typeof span.e !== "number") return fail();
        const seg = broll.get(span.id);
        if (seen.has(span.id) || !seg?.clip.photo || !Number.isFinite(span.s) || !Number.isFinite(span.e) ||
          span.s < seg.s || span.e > seg.e || span.e <= span.s) {
          throw new ReplyShapeError("photoSpans must name each photo once with source seconds inside its listed span.");
        }
        seen.add(span.id);
        return { id: span.id, s: span.s, e: span.e };
      });
    }
    if (!(m === null || (object(m) && typeof m.file === "string" && typeof m.startS === "number" && Number.isFinite(m.startS) && m.startS >= 0))) return fail();
    cut = { ...(typeof c.shotOrderReason === "string" && c.shotOrderReason.trim() ? {shotOrderReason:c.shotOrderReason.trim().slice(0,1000)} : {}), title: c.title, concept: c.concept, voice: voiceIds.map((id) => ({ id })), broll: overlays,
      music: m as ReelAnswer["music"], why: c.why, warnings: c.warnings, ...(spans ? { spans } : {}), ...(photoSpans ? { photoSpans } : {}) };
  }
  let titles: SidekickReply["titles"];
  if (v.titles !== undefined && v.titles !== null) {
    if (!object(v.titles) || typeof v.titles.prompt !== "string" || !v.titles.prompt.trim() || !strings(v.titles.skillIds)) {
      throw new ReplyShapeError("titles must be null or an instruction with prompt and skillIds.");
    }
    if (cut || ideas?.length) throw new ReplyShapeError("A titles instruction cannot also cut footage or change ideas. Return cut: null and ideas: null.");
    titles = { prompt: v.titles.prompt, skillIds: v.titles.skillIds };
  }
  // BUG1: Make it better is a route the model chooses, like titles; it lists fixes and never cuts in the same reply.
  if (v.better !== undefined && v.better !== null && typeof v.better !== "boolean") throw new ReplyShapeError("better must be true, false or null.");
  if (v.better === true && (cut || ideas?.length || titles)) throw new ReplyShapeError("Make it better lists fixes first. Return cut: null, ideas: null and titles: null with better: true.");
  const { questions, dropped } = parseQuestions(v.questions, shoot);
  return { reply: { text: v.text, clips, ideas, cut, missing: v.missing, ...(titles ? { titles } : {}), ...(v.better === true ? { better: true } : {}), questions }, warnings, dropped };
}
