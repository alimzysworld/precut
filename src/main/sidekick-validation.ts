import type { ReelIdea, Shoot } from "../shared/schema";
import { reelIds, type ReelAnswer } from "./reel";

type Moment = { clipId: string; s: number; e: number };
export interface SidekickReply {
  text: string; clips: Moment[]; ideas: ReelIdea[] | null;
  cut: (ReelAnswer & { concept: string }) | null; missing: string[];
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
export class ReplyShapeError extends Error {}
export function parseSidekick(raw: string, shoot: Shoot): { reply: SidekickReply; warnings: string[] } {
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
    if (!(m === null || (object(m) && typeof m.file === "string" && typeof m.startS === "number" && Number.isFinite(m.startS) && m.startS >= 0))) return fail();
    cut = { title: c.title, concept: c.concept, voice: voiceIds.map((id) => ({ id })), broll: overlays,
      music: m as ReelAnswer["music"], why: c.why, warnings: c.warnings };
  }
  return { reply: { text: v.text, clips, ideas, cut, missing: v.missing }, warnings };
}
