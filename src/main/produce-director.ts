// PRO2 (docs/plans/produced/spike-v1.md, "After Codex round 1"): Produce it. A fixed flow with two judgement steps:
//   watch (produce-observe.ts: the finished edit, rendered, framed and measured) ->
//   direct (one engine call, prompts/produce.md: the idea, the payoff, what stays quiet, ranked groups of moves) ->
//   check the answer in code (only moves precut has, inside the edit, at most two sounds; a group with a bad move is
//   left out whole, so a pass is never half-applied) -> stage it as one PRO1 draft, not saved (produce-pass.ts) ->
//   watch the staged draft back and ask the same engine, as critic, whether each group earned its place (one round) ->
//   apply what survived as ONE PRO1 pass: history gets one version, one Cmd+Z back to the edit produced on (PRO2b; it
//   used to apply first and apply again after the review, which left the first pass behind as a version of its own).
// PRO2b: the row says the real stage and a time left learned on this Mac (model-pace.ts): renders report the frames
// they have finished, engine turns their measured pace; past its estimate a stage says nothing rather than guess.
// An even read gets no pass at all; the outcome says why (kept beside the edit so the row can say it).
// Replay seam for QA (never in a packaged app, never from the UI): PRECUT_PRODUCE_REPLAY=<dir> writes each engine
// request to <dir>/<director|critic>/ and reads <dir>/<step>/response.txt instead of calling the engine.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { CutEdit, ProduceMoveEdit, ProducePieceRef, ProduceRequest, TransitionKind, ProduceOutcome, SfxItem, SoundRole } from "../shared/schema";
import type { StoredVersion } from "./sidekick";
import { CAPS, observe, observeAfter, prepareWatch, watchSound, pruneWatches, soundLibraryForDirector, plannedSeconds, type MoveMoment, type ObservePacket, type Watch, type WatchWindow } from "./produce-observe";
import type { ActivityHandle } from "./activity";
import { timedCaptionWords } from "../shared/caption-words";
import { cardBox } from "./graphics/templates";
import { stampInWords, StampRepeatsCaption, normWord, type CardMedia, type CardRequest } from "./graphics/card";
import { fullScreenOver, graphicTheme, underFullScreen } from "./graphics/edit";
import { keyWordGraphic } from "./titles/mattes";
import { sceneTemplateId } from "./graphics/scene-edit";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clock = (t: number) => { const s = Math.max(0, Math.round(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const plain = (v: unknown, max = 300) => typeof v === "string" ? v.replace(/[–—]/g, ", ").replace(/\s+/g, " ").trim().slice(0, max) : "";
export const LIMITS = { groups: 5, sounds: 2, punches: 2, stills: 1, hits: 2, cards: 1, words: 1, scenes: 1, movesPerGroup: 80, stillMaxS: 8, cardMinS: 1, cardMaxS: 6, wordMinS: 0.8, wordMaxS: 2.5, wordBeatS: 0.3,
  sceneHookS: 2, sceneClearS: 0.5 } as const;   // SCN2: no scene in the opening 2 s; nothing else big within half a second of one
const JOINS: TransitionKind[] = ["cut", "snap", "ease", "zoom", "whip", "dissolve", "ramp"];
const ROLES: SoundRole[] = ["hit", "accent", "ui", "ambience"];

// ---- The director's answer, checked and turned into a PRO1 request.
type Where = { kind: "pieceStart" | "pieceEnd"; ref: ProducePieceRef } | { kind: "time"; atS: number };
type Built = { edits: { edit: ProduceMoveEdit; bind?: string; label?: string }[]; where: Where[]; budget?: "sound" | "punch" | "still" | "hit" | "card" | "word" | "scene";
  word?: { text: string; s: number; e: number }; piece?: number; landS?: number;   // PRO5d: what the key word's checks across the pass read
  card?: { s: number; e: number }; scene?: { s: number; e: number; mode: "cutaway" | "pause" } };   // SCN2: and the scene's
export interface Checked { request: ProduceRequest | null; notes: string[]; where: Map<string, Where[]>; leave: string | null; payoffAtS: number | null;
  scenes?: Map<string, { label: string; about: string; line: string }> }   // SCN2: the scene a group made: its move's label, what the critic is told, the outcome's line
interface Base { record: StoredVersion; fps: number; lengthS: number; spans: { startS: number; endS: number }[]; library: Map<string, { name: string; kind: string; role: string | null }>;
  media?: Map<string, CardMedia>;   // PRO4: pictures the shoot has whose content is known, by packet id
  head?: (atS: number) => number | null }   // PRO5d: the top of his head at an edit second, a fraction of the frame's height
// PRO4: a card's picture is drawn after the answer is checked (it reads files and the picture); its edit waits here.
const pendingCards = new WeakMap<object, CardRequest>();
// SCN2: a scene is made after the answer is checked too (it reads his words, frames and beats); what it asked for waits here.
const pendingScenes = new WeakMap<object, Record<string, unknown>>();
// PRO4c: a card kept without the stamp that would repeat the caption on screen with it, by its edit (said once it lands).
const stampLeftOut = new WeakMap<object, string>();
const keptWithoutStamp = (stamp: string) => `Kept the card, left the stamp “${stamp}” out: the caption shows those words with it.`;

const num = (v: unknown, low: number, high: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= low && v <= high;
const int = (v: unknown, low: number, high: number): v is number => Number.isInteger(v) && (v as number) >= low && (v as number) <= high;
const refOf = (p: NonNullable<StoredVersion["pieces"]>[number]): ProducePieceRef => ({ id: p.id, clipId: p.clipId, s: p.s, e: p.e });

function buildMove(base: Base, m: Record<string, unknown>, reason: string): Built {
  const { record, fps, lengthS, spans } = base, pieces = record.pieces ?? [], words = timedCaptionWords(record.titles);
  const clipLength = (i: number) => record.assembly.shoot.clips.find(c => c.id === pieces[i].clipId)?.meta?.durationS ?? Infinity;
  const speed = (i: number) => Math.abs(record.pieceFx?.[i]?.speed ?? 1) || 1;
  const piece = (v: unknown) => { if (!int(v, 0, pieces.length - 1)) throw new Error(`there is no clip ${String(v)} in this edit`); return v; };
  const join = (v: unknown) => { if (!int(v, 0, pieces.length - 2)) throw new Error(`there is no join ${String(v)} in this edit`); return v; };
  const word = (v: unknown) => { if (!int(v, 0, words.length - 1)) throw new Error(`there is no caption word ${String(v)}`); return v; };
  const inside = (t: unknown, what: string) => { if (!num(t, 0, lengthS - 1e-3)) throw new Error(`${what} ${typeof t === "number" ? `${r3(t)} s ` : ""}is outside the edit (0 to ${r3(lengthS)} s)`); return t; };
  switch (m.move) {
    case "cutOnWord": {
      const k = join(m.join), w = words[word(m.word)], f = int(m.framesBefore, 0, 12) ? m.framesBefore : 1;
      const at = Math.round((w.s - f / fps) * fps) / fps, a = pieces[k], b = pieces[k + 1], sa = spans[k], sb = spans[k + 1];
      if (!sa || !sb) throw new Error(`join ${k} has no picture on the clock`);
      if (at <= sa.startS + 2 / fps || at >= sb.endS - 2 / fps) throw new Error(`the cut at ${clock(at)} would leave a shot with no picture`);
      const delta = sa.endS - at;   // the cut is where the shot before it ends
      const aE = r3(a.e - delta * speed(k));
      if (aE <= a.s + 2 / fps || aE > clipLength(k) + 1e-3) throw new Error(`the shot before the cut at ${clock(at)} doesn't have that much picture`);
      const keepStart = m.keep !== "nextTiming";
      const bS = keepStart ? b.s : r3(b.s - delta * speed(k + 1)), bE = keepStart ? r3(b.e + delta * speed(k + 1)) : b.e;
      if (bS < 0 || bE > clipLength(k + 1) + 1e-3 || bE <= bS + 2 / fps) throw new Error(`the shot after the cut at ${clock(at)} doesn't have that much picture`);
      const bind = `cut-${k}`;
      return { edits: [{ edit: { kind: "trim", piece: k, s: a.s, e: aE, magnetic: true } as ProduceMoveEdit, bind }, { edit: { kind: "trim", piece: k + 1, s: bS, e: bE, magnetic: true } as ProduceMoveEdit, bind }],
        where: [{ kind: "pieceStart", ref: refOf(b) }] };
    }
    case "trim": {
      const i = piece(m.piece), p = pieces[i];
      if (!num(m.s, 0, clipLength(i)) || !num(m.e, 0, clipLength(i)) || (m.e as number) <= (m.s as number) + 2 / fps) throw new Error(`the trim of clip ${i} is outside its footage`);
      const where: Where[] = [];
      if (Math.abs((m.s as number) - p.s) > 1e-4) where.push({ kind: "pieceStart", ref: refOf(p) });
      if (Math.abs((m.e as number) - p.e) > 1e-4) where.push({ kind: "pieceEnd", ref: refOf(p) });
      return { edits: [{ edit: { kind: "trim", piece: i, s: m.s as number, e: m.e as number, magnetic: true } as ProduceMoveEdit, ...(typeof m.bind === "string" ? { bind: m.bind } : {}) }], where };
    }
    case "clipSound": {
      const i = piece(m.piece);
      if (m.gainDb !== undefined && !num(m.gainDb, -24, 12)) throw new Error("clip sound gain is -24 to 12 dB");
      const now = record.pieceFx?.[i] ?? {};
      const fx = { ...now, muted: m.muted === true, ...(m.muted === true ? {} : { gainDb: (m.gainDb as number | undefined) ?? now.gainDb ?? 0 }) };
      return { edits: [{ edit: { kind: "pieceFx", piece: i, fx } }], where: [{ kind: "pieceStart", ref: refOf(pieces[i]) }] };
    }
    case "join": {
      const k = join(m.join);
      if (!JOINS.includes(m.kind as TransitionKind)) throw new Error(`"${String(m.kind)}" is not a join precut has`);
      return { edits: [{ edit: { kind: "join", join: k, choice: { kind: m.kind as TransitionKind, sound: null } } }], where: [{ kind: "pieceStart", ref: refOf(pieces[k + 1]) }] };
    }
    case "punch": {
      const i = piece(m.piece);
      if (!num(m.scale, 1.02, 1.18)) throw new Error("a punch-in scales 1.02 to 1.18");
      return { edits: [{ edit: { kind: "punch", piece: i, scale: m.scale as number } }], where: [{ kind: "pieceStart", ref: refOf(pieces[i]) }], budget: "punch", piece: i };
    }
    case "accentOnly": {
      if (!Array.isArray(m.words) || !m.words.length || m.words.length > 12) throw new Error("keep yellow on 1 to 12 words");
      const keep = new Set(m.words.map(word));
      const edits = words.flatMap(w => (keep.has(w.index) ? !w.accent : !!w.accent) ? [{ edit: { kind: "captionWord", index: w.index, accent: keep.has(w.index) } as ProduceMoveEdit }] : []);
      return { edits, where: [...keep].slice(0, 2).map(i => ({ kind: "time" as const, atS: words[i].s })) };
    }
    case "accent": {
      const i = word(m.word);
      if (typeof m.on !== "boolean") throw new Error("say whether the word is accented");
      return { edits: !!words[i].accent === m.on ? [] : [{ edit: { kind: "captionWord", index: i, accent: m.on } as ProduceMoveEdit }], where: [{ kind: "time", atS: words[i].s }] };
    }
    case "sound": {
      const id = typeof m.sound === "string" ? m.sound.replace(/^lib:/, "") : "", lib = base.library.get(id);
      if (!lib) throw new Error(`"${String(m.sound)}" is not one of precut's bundled sounds`);
      const land = m.landAtS !== undefined ? inside(m.landAtS, "the sound") : undefined, start = land === undefined ? inside(m.atS, "the sound") : undefined;
      if (m.gainDb !== undefined && !num(m.gainDb, -24, 6)) throw new Error("a sound's gain is -24 to 6 dB");
      if (m.role !== undefined && !ROLES.includes(m.role as SoundRole)) throw new Error("a sound's role is hit, accent, ui or ambience");
      const item = { file: `lib:${id}`, name: lib.name, kind: lib.kind as SfxItem["kind"], atS: (land ?? start)!, gainDb: (m.gainDb as number | undefined) ?? 0,
        ...(m.role !== undefined ? { role: m.role as SoundRole } : {}), reason: plain(m.why, 200) || reason, ...(land !== undefined ? { landAtS: land } : {}) };
      return { edits: [{ edit: { kind: "sfx", op: "add", item } as ProduceMoveEdit }], where: [{ kind: "time", atS: (land ?? start)! }], budget: "sound", landS: (land ?? start)! };
    }
    case "still": {
      if (!record.music && !record.assembly.reel.music) throw new Error("this edit has no music to hold still");
      const from = inside(m.fromS, "the stillness"), to = m.toS;
      if (!num(to, from + 0.1, Math.min(lengthS, from + LIMITS.stillMaxS))) throw new Error(`a stillness ends after it starts, inside the edit, at most ${LIMITS.stillMaxS} s long`);
      if (m.db !== undefined && !num(m.db, -24, 0)) throw new Error("a stillness is -24 to 0 dB");
      return { edits: [{ edit: { kind: "musicMark", mark: { kind: "still", atS: from, endS: to, ...(m.db !== undefined ? { db: m.db as number } : {}) } } }], where: [{ kind: "time", atS: from }, { kind: "time", atS: to }], budget: "still" };
    }
    case "hit": {
      if (!record.music && !record.assembly.reel.music) throw new Error("this edit has no music to dip");
      const at = inside(m.atS, "the music hit");
      if (m.db !== undefined && !num(m.db, -24, 0)) throw new Error("a music hit is -24 to 0 dB");
      if (m.recoverS !== undefined && !num(m.recoverS, 0.02, 3)) throw new Error("a music hit recovers over 0.02 to 3 s");
      return { edits: [{ edit: { kind: "musicMark", mark: { kind: "hit", atS: at, ...(m.db !== undefined ? { db: m.db as number } : {}), ...(m.recoverS !== undefined ? { recoverS: m.recoverS as number } : {}) } } }], where: [{ kind: "time", atS: at }], budget: "hit" };
    }
    case "card": {   // PRO4: the real thing he names, from the shoot, at the word that names it
      const pic = typeof m.media === "string" ? base.media?.get(m.media) : undefined;
      if (!pic) throw new Error(`"${plain(m.media, 20) || "?"}" is not one of the shoot's pictures in the packet`);
      const named = words[word(m.word)], s = Math.max(0, Math.round((named.s - 2 / fps) * fps) / fps);
      const e = m.toS === undefined || m.toS === null ? Math.min(lengthS, s + 2.6) : m.toS;
      if (!num(e, s + LIMITS.cardMinS, Math.min(lengthS, s + LIMITS.cardMaxS))) throw new Error(`a card is on screen ${LIMITS.cardMinS} to ${LIMITS.cardMaxS} seconds, inside the edit`);
      if (m.region !== undefined && m.region !== null && !cardBox(m.region)) throw new Error("a card's region is x, y, w, h fractions of the picture");
      if (m.region === undefined && m.find !== undefined && (typeof m.find !== "string" || !m.find.trim())) throw new Error("say which words on the picture to push towards");
      let stamp: ReturnType<typeof stampInWords> | null = null, leftOut: string | null = null;   // refused for words he never says
      try { stamp = typeof m.stamp === "string" && m.stamp.trim() ? stampInWords(words, m.stamp, s, e as number) : null; }
      catch (error) {
        if (error instanceof StampRepeatsCaption) leftOut = error.stamp;   // PRO4c: the card stays, its stamp goes
        else throw new Error((error instanceof Error ? error.message : String(error)).replace(/\.$/, ""));
      }
      const edit = { kind: "overlay", op: "add", source: "", item: { s: r3(s), e: r3(e as number), x: 0.5, y: 0.45, w: 0.8 } } as unknown as ProduceMoveEdit;
      if (leftOut) stampLeftOut.set(edit, leftOut);
      pendingCards.set(edit, { clip: pic.clip, atS: num(m.atS, 0, 1e5) ? m.atS : null, region: cardBox(m.region), find: typeof m.find === "string" ? m.find : null,
        crop: cardBox(m.crop), stamp: stamp?.text ?? null, s: r3(s), e: r3(e as number) });
      return { edits: [{ edit }], where: [{ kind: "time", atS: r3(s) }, ...(stamp?.inside ? [{ kind: "time" as const, atS: stamp.atS }] : [])], budget: "card", card: { s: r3(s), e: r3(e as number) } };
    }
    case "word": {   // PRO5d: one key word behind him as he says it, the house design (keyWordGraphic)
      const i = word(m.word), w = words[i], text = plain(m.text, 40).replace(/^["“”']+|["“”'.,!?;:]+$/g, "");
      if (!text) throw new Error("say the key word to show");
      if (text.length > 24 || text.split(" ").length > 3) throw new Error(`a key word is one short word, not “${text}”`);
      if (!saidThere(words, i, text)) throw new Error(`“${text}” isn't what he says there (he says “${w.text.replace(/[.,!?;:]+$/, "")}”)`);
      // Two frames before the word, held through it and a beat after, never past the end of his phrase (the caption line
      // it is in), 0.8 to 2.5 seconds. Longer competes with the caption's next words, and he moves more over it: on his
      // clean shot "accelerator" held to 14.58 s stays behind him, to the line's end at 14.9 s it doesn't (qa/PRO5d/hold.json).
      const s = Math.max(0, Math.round((w.s - 2 / fps) * fps) / fps);
      const e = Math.min(lengthS, Math.max(s + LIMITS.wordMinS, Math.min(phraseEnd(words, i), w.e + LIMITS.wordBeatS, s + LIMITS.wordMaxS)));
      if (e - s < LIMITS.wordMinS - 1e-3) throw new Error(`a key word needs ${LIMITS.wordMinS} seconds on screen, and the edit ends first`);
      const graphic = keyWordGraphic(text, graphicTheme(record.titles), { durationS: e - s, accent: m.accent === true, layer: "behind", words: [{ text: w.text, atS: r3(w.s) }] });
      // Behind his head: the top of the letters a little under the top of his hair (measured from his face on this
      // frame), so his head covers part of the word and the rest reads. precut checks the outline under it on save.
      const { width, height } = record.assembly.template, wide = width >= height, boxW = wide ? 0.55 : 0.9;
      const boxH = boxW * width * graphic.heightPx / graphic.widthPx / height, top = base.head?.(w.s) ?? null;
      const y = top === null ? 0.2 : Math.min(0.6, Math.max(boxH / 2, top + 0.35 * boxH));
      const edit = { kind: "overlay", op: "add", source: "", item: { graphic, s: r3(s), e: r3(e), x: 0.5, y: r3(y), w: boxW } } as unknown as ProduceMoveEdit;
      return { edits: [{ edit, label: `the key word “${text}” at ${clock(s)}` }], where: [{ kind: "time", atS: r3(s) }], budget: "word", word: { text, s: r3(s), e: r3(e) } };
    }
    case "scene": {   // SCN2: one full-screen scene of his words or his frames (graphics/scene-edit.ts makes and checks it)
      const kind = typeof m.kind === "string" ? m.kind : "";
      try { sceneTemplateId(kind); } catch { throw new Error(`"${plain(kind, 30) || "?"}" is not a scene precut makes (beat words, title slam, frame wall or memories)`); }
      if (m.mode !== undefined && m.mode !== "cutaway" && m.mode !== "pause") throw new Error("a scene is a cutaway or a pause");
      const mode = m.mode === "pause" ? "pause" : "cutaway", phrase = typeof m.span === "string" ? m.span : null;
      let s: number, e: number;
      if (phrase !== null) {
        const hit = findPhrase(words, phrase);
        if (!hit) throw new Error(`he doesn't say “${plain(phrase, 60)}” in this edit`);
        ({ s, e } = hit);
      } else {
        const span = m.span && typeof m.span === "object" ? m.span as Record<string, unknown> : null;
        if (!span) throw new Error("give the scene a span: start and end in edit seconds, or a phrase he says");
        s = inside(span.s, "the scene");
        if (!num(span.e, s + 0.1, lengthS)) throw new Error("the scene ends after it starts, inside the edit");
        e = span.e as number;
      }
      if (s < LIMITS.sceneHookS) throw new Error(`it would cut away inside the opening (the first ${LIMITS.sceneHookS} seconds)`);
      if (m.words !== undefined && (!Array.isArray(m.words) || !m.words.length || m.words.length > 8 || m.words.some(w => typeof w !== "string" || !w.trim() || w.length > 60))) throw new Error("a scene's words are 1 to 8 of his words or short phrases");
      const edit = { kind: "overlay", op: "add", source: "", item: { s: r3(s), e: r3(e), x: 0.5, y: 0.5, w: 1 } } as unknown as ProduceMoveEdit;
      pendingScenes.set(edit, { kind, mode, span: phrase ?? { s, e }, ...(Array.isArray(m.words) ? { words: (m.words as string[]).map(w => plain(w, 60)) } : {}) });
      // A pause takes no time from the edit as it stands: it stops at s and the rest moves on by its length.
      return { edits: [{ edit, bind: "scene" }], where: [], budget: "scene", scene: { s: r3(s), e: r3(mode === "pause" ? s : e), mode } };
    }
    default: throw new Error(`precut can't make a "${plain(m.move, 40) || "?"}" move`);
  }
}

/** PRO5d: the key word is his: the caption word itself, or a run of words he says there that includes it, or a shorter
 * form of that one word ("accelerators" as "accelerator"). Never a word he doesn't say (the card stamp rule). */
function saidThere(words: { text: string }[], i: number, text: string): boolean {
  const want = text.split(/\s+/).map(normWord).filter(Boolean), spoken = words.map(w => normWord(w.text));
  if (!want.length) return false;
  for (let a = Math.max(0, i - want.length + 1); a <= i; a++) if (want.every((t, j) => spoken[a + j] === t)) return true;
  const one = spoken[i].replace(/'s$/, "");
  return want.length === 1 && (one === want[0] || want[0].length >= 3 && one.startsWith(want[0]) && one.length - want[0].length <= 3);
}
/** SCN2: where he says a phrase (his caption words, punctuation aside), first word to last. */
function findPhrase(words: { text: string; s: number; e: number }[], phrase: string): { s: number; e: number } | null {
  const want = phrase.split(/\s+/).map(normWord).filter(Boolean), spoken = words.map(w => normWord(w.text));
  if (!want.length) return null;
  for (let a = 0; a + want.length <= spoken.length; a++) if (want.every((t, j) => spoken[a + j] === t)) return { s: words[a].s, e: words[a + want.length - 1].e };
  return null;
}
/** The end of the phrase a word is in: the caption line he sees it in. */
function phraseEnd(words: { s: number; e: number; cueId?: string }[], i: number): number {
  let k = i;
  while (words[k + 1] && words[k + 1].cueId !== undefined && words[k + 1].cueId === words[i].cueId) k++;
  return words[k].e;
}

/** The director's raw answer -> a PRO1 request, or a plain reason to leave the edit alone. Never throws for a bad answer. */
export function checkDirection(raw: unknown, base: Base): Checked {
  const notes: string[] = [], where = new Map<string, Where[]>();
  const answer = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!answer) return { request: null, notes: ["precut couldn't read the director's answer."], where, leave: null, payoffAtS: null };
  const payoffAtS = num(answer.payoffAtS, 0, base.lengthS) ? r3(answer.payoffAtS) : null;
  const groupsIn = Array.isArray(answer.groups) ? answer.groups as Record<string, unknown>[] : [];
  if (answer.verdict === "leave" || !groupsIn.length) {
    return { request: null, notes, where, payoffAtS, leave: plain(answer.leave, 240) || plain(answer.quiet, 240) || "the read is even and needs no produced moment" };
  }
  const idea = plain(answer.idea, 200);
  if (!idea) return { request: null, notes: ["The director didn't name the idea, so nothing was applied."], where, leave: null, payoffAtS };
  // Rank order first, then the cap on groups.
  const ranked = groupsIn.map((g, k) => ({ g, k, rank: int(g?.rank, 1, 99) ? g.rank as number : 50 + k })).sort((a, b) => a.rank - b.rank || a.k - b.k);
  if (ranked.length > LIMITS.groups) notes.push(`Kept the ${LIMITS.groups} strongest groups of ${ranked.length}.`);
  const used = { sound: 0, punch: 0, still: 0, hit: 0, card: 0, word: 0, scene: 0 }, max = { sound: LIMITS.sounds, punch: LIMITS.punches, still: LIMITS.stills, hit: LIMITS.hits, card: LIMITS.cards, word: LIMITS.words, scene: LIMITS.scenes };
  const builtOf = new Map<string, Built[]>();   // PRO5d: each group's kept moves, for the key word's checks across the pass
  const ids = new Set<string>();
  let groups: (ProduceRequest["groups"][number] & { id: string })[] = [];
  for (const { g, k, rank } of ranked.slice(0, LIMITS.groups)) {
    const reason = plain(g?.reason, 300) || "", id = (plain(g?.id, 40) || `g${k + 1}`).replace(/[^\w-]/g, "-");
    const name = reason ? `"${reason.length > 70 ? `${reason.slice(0, 69)}…` : reason}"` : `group ${id}`;
    if (!reason) { notes.push(`Left out ${name}: it gave no reason.`); continue; }
    if (ids.has(id)) { notes.push(`Left out ${name}: another group has its id.`); continue; }
    const moves = Array.isArray(g.moves) ? g.moves as Record<string, unknown>[] : [];
    if (!moves.length || moves.length > LIMITS.movesPerGroup) { notes.push(`Left out ${name}: it had ${moves.length ? "too many" : "no"} moves.`); continue; }
    const built: Built[] = [];
    let bad: string | null = null;
    for (const m of moves) { try { built.push(buildMove(base, m && typeof m === "object" ? m : {}, reason)); } catch (e) { bad = e instanceof Error ? e.message : String(e); break; } }
    if (bad) { notes.push(`Left out ${name}: ${bad}.`); continue; }
    // Over budget: the extra sound (punch, music mark) is dropped; the rest of the group stays if anything is left.
    const over = new Map<string, number>();
    const kept = built.filter(b => {
      if (!b.budget) return true;
      if (used[b.budget] < max[b.budget]) { used[b.budget]++; return true; }
      over.set(`${b.budget}\0${name}`, (over.get(`${b.budget}\0${name}`) ?? 0) + 1);
      return false;
    });
    for (const [key, n] of over) {
      const [kind] = key.split("\0"), noun = ({ still: ["music stillness", "music stillnesses"], hit: ["music hit", "music hits"], punch: ["punch-in", "punch-ins"], sound: ["sound", "sounds"], card: ["card", "cards"], word: ["key word", "key words"], scene: ["scene", "scenes"] } as Record<string, string[]>)[kind];
      notes.push(`Dropped ${n === 1 ? `a ${noun[0]}` : `${n} ${noun[1]}`} from ${name}: a pass has at most ${max[kind as keyof typeof max]}.`);
    }
    const edits = kept.flatMap(b => b.edits);
    if (!edits.length) { if (!over.size) notes.push(`Left out ${name}: it changed nothing.`); continue; }   // over budget: the note above says why
    ids.add(id);
    where.set(id, kept.flatMap(b => b.where));
    builtOf.set(id, kept);
    groups.push({ id, rank, reason, needs: Array.isArray(g.needs) ? (g.needs as unknown[]).map(n => plain(n, 40)).filter(Boolean) : [], moves: edits.map(e => ({ edit: e.edit, ...(e.bind ? { bind: e.bind } : {}), ...(e.label ? { label: e.label } : {}) })) });
  }
  // PRO5d: a key word is one big visual. Never with a card, and never on the payoff frame that already has a punch-in
  // and a sound (stacked, they are the slop the pass avoids). The word goes; the rest of its group stays if anything is left.
  const all = [...builtOf.values()].flat(), hasCard = all.some(b => b.budget === "card");
  const at = (t: number) => base.spans.findIndex(sp => sp && t >= sp.startS - 1e-6 && t < sp.endS - 1e-6);
  const payoffPiece = payoffAtS === null ? -1 : at(payoffAtS);
  const stacked = payoffAtS !== null && all.some(b => b.budget === "punch" && b.piece === payoffPiece) && all.some(b => b.budget === "sound" && b.landS !== undefined && Math.abs(b.landS - payoffAtS) <= 0.25);
  for (const g of [...groups]) {
    const built = builtOf.get(g.id)!, words = built.filter(b => b.word);
    if (!words.length) continue;
    const name = `the key word “${words[0].word!.text}”`;
    // TASTE1: a full-screen scene already in the edit replaces the picture the word would sit on.
    const scene = words.map(b => fullScreenOver(base.record.overlays, b.word!.s, b.word!.e)).find(Boolean);
    const why = hasCard ? "next to the card it would be a second big visual"
      : scene ? underFullScreen(scene).replace(/^That's/, "it's").replace(/\.$/, "")
      : stacked && words.some(b => payoffAtS! >= b.word!.s - 1e-3 && payoffAtS! < b.word!.e) ? "it would land on the payoff with a punch-in and a sound, and one big move there is enough" : null;
    if (!why) continue;
    const kept = built.filter(b => !b.word);
    notes.push(`Left out ${name}: ${why}.`);
    if (!kept.length) { groups = groups.filter(x => x !== g); where.delete(g.id); continue; }
    g.moves = kept.flatMap(b => b.edits).map(e => ({ edit: e.edit, ...(e.bind ? { bind: e.bind } : {}), ...(e.label ? { label: e.label } : {}) }));
    where.set(g.id, kept.flatMap(b => b.where));
  }
  // SCN2: a scene is the pass's one moment away from him. Never on the payoff itself (a pause goes before the payoff line,
  // never inside it), and never in the same moment as a card, a key word, or a punch-in with a sound: the scene goes,
  // the rest of its group stays if anything is left.
  const payoffEnd = (() => {
    if (payoffAtS === null) return null;
    const words = timedCaptionWords(base.record.titles), i = words.findIndex(w => w.e > payoffAtS + 1e-3);
    return i < 0 ? null : phraseEnd(words, i);
  })();
  for (const g of [...groups]) {
    const built = builtOf.get(g.id)!, scene = built.find(b => b.scene)?.scene;
    if (!scene) continue;
    const others = [...builtOf.values()].flat().filter(b => !b.scene), clear = LIMITS.sceneClearS;
    const near = (s: number, e: number) => s < scene.e + clear && e > scene.s - clear;
    const card = others.find(b => b.card && near(b.card.s, b.card.e)), word = others.find(b => b.word && near(b.word.s, b.word.e));
    const punched = others.some(b => b.budget === "punch" && b.piece !== undefined && base.spans[b.piece] && near(base.spans[b.piece].startS, base.spans[b.piece].endS))
      && others.some(b => b.budget === "sound" && b.landS !== undefined && near(b.landS, b.landS));
    const why = payoffAtS !== null && scene.mode === "cutaway" && payoffAtS >= scene.s - 1e-3 && payoffAtS < scene.e ? "it would cover the payoff itself, and a scene earns its place before it"
      : payoffAtS !== null && scene.mode === "pause" && payoffEnd !== null && scene.s > payoffAtS + 1e-3 && scene.s < payoffEnd ? "it would stop his voice inside the payoff line"
      : card ? "a card is on screen then, and one big visual at a time is enough"
      : word ? `the key word “${word.word!.text}” is on screen then, and one big visual at a time is enough`
      : punched ? "a punch-in and a sound already land there, and one big move there is enough" : null;
    if (!why) continue;
    const kept = built.filter(b => !b.scene);
    notes.push(`Left out the scene: ${why}.`);
    if (!kept.length) { groups = groups.filter(x => x !== g); where.delete(g.id); builtOf.delete(g.id); continue; }
    g.moves = kept.flatMap(b => b.edits).map(e => ({ edit: e.edit, ...(e.bind ? { bind: e.bind } : {}), ...(e.label ? { label: e.label } : {}) }));
    where.set(g.id, kept.flatMap(b => b.where)); builtOf.set(g.id, kept);
  }
  // A group that needs a group left out goes too (a thud without its cut); a need that never existed is ignored.
  const named = new Set(groupsIn.map((g, k) => (plain(g?.id, 40) || `g${k + 1}`).replace(/[^\w-]/g, "-")));
  for (let changed = true; changed;) {
    changed = false;
    const live = new Set(groups.map(g => g.id));
    for (const g of groups) {
      const missing = (g.needs ?? []).find(n => named.has(n) && !live.has(n) && n !== g.id);
      if (missing) { notes.push(`Left out "${g.reason.slice(0, 70)}": it needs a group that was left out.`); groups = groups.filter(x => x !== g); changed = true; break; }
      g.needs = (g.needs ?? []).filter(n => live.has(n) && n !== g.id);
      if (!g.needs.length) delete g.needs;
    }
  }
  if (!groups.length) return { request: null, notes: notes.length ? notes : ["The director's moves changed nothing."], where, leave: null, payoffAtS };
  return { request: { idea, ...(plain(answer.payoff, 300) ? { payoff: plain(answer.payoff, 300) } : {}), ...(plain(answer.quiet, 300) ? { quiet: plain(answer.quiet, 300) } : {}), groups }, notes, where, leave: null, payoffAtS };
}

/** PRO4: draw each card the answer asked for; a card that can't be made (its words aren't on the picture, the footage is
 * missing) leaves its group out whole, with what needed it, and says why. */
export async function drawCards(root: string, record: StoredVersion, checked: Checked): Promise<void> {
  const request = checked.request;
  if (!request) return;
  const { prepareCard, cardOverlay } = await import("./graphics/card");
  const failed = new Map<string, string>();
  for (const g of request.groups) for (const move of g.moves) {
    const want = pendingCards.get(move.edit);
    if (!want || failed.has(g.id!)) continue;
    try {
      let made;
      try { made = await prepareCard(root, record, want); }
      catch (e) {   // PRO4c: the card's end snapped to a cut can bring a caption line into the stamp's time; the card stays
        if (!(e instanceof StampRepeatsCaption)) throw e;
        made = await prepareCard(root, record, { ...want, stamp: null });
        stampLeftOut.set(move.edit, e.stamp);
      }
      (move.edit as unknown as { item: unknown }).item = cardOverlay(made);
      const left = stampLeftOut.get(move.edit);
      if (left) checked.notes.push(keptWithoutStamp(left));
    }
    catch (e) { failed.set(g.id!, (e instanceof Error ? e.message : String(e)).replace(/\.$/, "")); }
  }
  if (!failed.size) return;
  const short = (r: string) => `"${r.length > 70 ? `${r.slice(0, 69)}…` : r}"`;
  for (let changed = true; changed;) {
    changed = false;
    for (const g of request.groups) if (!failed.has(g.id!) && (g.needs ?? []).some(n => failed.has(n))) { failed.set(g.id!, "it needs a group that was left out"); changed = true; }
  }
  for (const g of request.groups) if (failed.has(g.id!)) checked.notes.push(`Left out ${short(g.reason)}: ${failed.get(g.id!)}.`);
  request.groups = request.groups.filter(g => !failed.has(g.id!));
  if (!request.groups.length) checked.request = null;
}

/** SCN2: make each scene the answer asked for (graphics/scene-edit.ts prepareScene: his words only, his frames from the
 * shoot cache, snapped to a beat or a word edge, a pause on the music's grid), check it where it really landed, and put
 * its moves in its group: the pause (if any), the scene, its sound, bound so they are kept or taken out as one. A scene
 * that can't be made or doesn't belong there leaves its group out whole, with what needed it, and says why. */
export async function drawScenes(root: string, cutId: string, record: StoredVersion, checked: Checked): Promise<void> {
  const request = checked.request;
  if (!request) return;
  const { prepareScene, scenePauseSteps } = await import("./graphics/scene-edit");
  const failed = new Map<string, string>(), payoffAtS = checked.payoffAtS;
  const words = timedCaptionWords(record.titles), payoffWord = payoffAtS === null ? -1 : words.findIndex(w => w.e > payoffAtS + 1e-3);
  const payoffEnd = payoffWord < 0 ? null : phraseEnd(words, payoffWord);
  for (const g of request.groups) for (const move of [...g.moves]) {
    const want = pendingScenes.get(move.edit);
    if (!want || failed.has(g.id!)) continue;
    try {
      const made = await prepareScene(root, record, want), { built } = made, s = built.s, e = built.e, P = Math.round((e - s) * 1e4) / 1e4;
      // Checked again where the snap put it (it moves up to three quarters of a second onto a beat or a word).
      if (s < LIMITS.sceneHookS) throw new Error(`it would cut away inside the opening (the first ${LIMITS.sceneHookS} seconds)`);
      if (payoffAtS !== null && built.mode === "cutaway" && payoffAtS >= s - 1e-3 && payoffAtS < e) throw new Error("it would cover the payoff itself, and a scene earns its place before it");
      if (payoffAtS !== null && built.mode === "pause" && payoffEnd !== null && s > payoffAtS + 1e-3 && s < payoffEnd) throw new Error("it would stop his voice inside the payoff line");
      if (built.mode === "pause") {
        const parts = await scenePauseSteps(root, cutId, record, s, P, []);
        if (parts.grows.tail) throw new Error("there isn't enough of the shot before the pause to hold it");
        // The shot it splits or grows is the pause's alone (produce-pass.ts sceneSteps refuses a pass that shares it).
        const under = parts.grows.splits ? parts.grows.piece - 1 : parts.grows.piece;
        const touches = (edit: ProduceMoveEdit) => { const x = edit as { piece?: unknown; join?: unknown }; return x.piece === under || typeof x.join === "number" && (x.join === under || x.join + 1 === under); };
        if (request.groups.some(o => o.moves.some(mv => mv !== move && touches(mv.edit)))) throw new Error("another move in this pass changes the shot it would pause in");
      }
      const shown = made.shown.join(" ").replace(/[.,!?;:]+$/, ""), at = clock(s);
      const what = made.shown.length ? `the ${made.name === "title slam" ? "title" : "scene"} “${shown}”` : `the ${made.name}`;
      const label = `${what} at ${at}`;
      const landing = made.onBeat ? "on the beat" : "on his word";
      const line = built.mode === "pause"
        ? `Paused ${Math.round(P * 10) / 10} s for ${made.shown.length ? `his words “${shown}”` : "his own shots"}, held on the music${payoffAtS !== null && s <= payoffAtS + 1e-3 ? ", just before the payoff" : ""}.`
        : made.shown.length ? `Cut to his words “${shown}” ${landing}.` : made.name === "frame wall" ? `Cut to a wall of his own shots ${landing}.` : `Cut to his own shots, flashing ${landing}.`;
      const about = built.mode === "pause" ? `a ${made.name} pause: his voice stops for ${Math.round(P * 10) / 10} s and the edit is that much longer` : `a ${made.name} cutaway: his voice plays on under it`;
      const moves: ProduceRequest["groups"][number]["moves"] = [
        ...(built.mode === "pause" ? [{ edit: { kind: "pause", atS: s, lengthS: P } as ProduceMoveEdit, bind: "scene" }] : []),
        { edit: { kind: "overlay", op: "add", source: "", item: made.item } as ProduceMoveEdit, bind: "scene", label },
        ...(made.sound ? [{ edit: { kind: "sfx", op: "add", item: { file: made.sound.file, name: made.sound.name, kind: made.sound.kind, role: made.sound.role, gainDb: 0, atS: made.sound.landAtS, landAtS: made.sound.landAtS, reason: "The scene's first landing" } } as ProduceMoveEdit, bind: "scene" }] : []),
      ];
      g.moves.splice(g.moves.indexOf(move), 1, ...moves);
      checked.where.set(g.id!, [...(checked.where.get(g.id!) ?? []), { kind: "time", atS: s }, { kind: "time", atS: e }]);
      (checked.scenes ??= new Map()).set(g.id!, { label, about, line });
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).trim();
      // His words, in the row's voice: what add_scene tells a caller ("Try a smaller grid") is not for the person.
      const said = /^He doesn't say (“[^”]*”)/.exec(why), short = /^Not enough shots for (a wall|memories) here\. .*?needs (\d+) of his frames, and the edit shows (\d+) usable shots/.exec(why);
      failed.set(g.id!, said ? `he doesn't say ${said[1]} there` : short ? `not enough shots for ${short[1]} here (it needs ${short[2]}, the edit shows ${short[3]} before it)`
        : why.split(/(?<=\.)\s/)[0].replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, c => c.toLowerCase()));
    }
  }
  if (!failed.size) return;
  const short = (r: string) => `"${r.length > 70 ? `${r.slice(0, 69)}…` : r}"`;
  for (let changed = true; changed;) {
    changed = false;
    for (const g of request.groups) if (!failed.has(g.id!) && (g.needs ?? []).some(n => failed.has(n))) { failed.set(g.id!, "it needs a group that was left out"); changed = true; }
  }
  for (const g of request.groups) if (failed.has(g.id!)) { checked.notes.push(`Left out ${short(g.reason)}: ${failed.get(g.id!)}.`); checked.where.delete(g.id!); checked.scenes?.delete(g.id!); }
  request.groups = request.groups.filter(g => !failed.has(g.id!));
  if (!request.groups.length) checked.request = null;
}

// ---- PRO5d: the key word's place, and where it really landed.
/** The top of his head at an edit second, as a fraction of the frame's height: his face as precut measured it on that
 * clip (Apple Vision samples), through the framing the edit plays the clip with (at the export's size, as the outline
 * check frames it). The head top is framing.ts's own: a face's height above its centre. null with no face. */
async function headTops(record: StoredVersion): Promise<(atS: number) => number | null> {
  const { planFx } = await import("./edits-fx"), { cutFraming, framingRectAt } = await import("./preview"), { clipDimensions } = await import("../shared/media");
  const { getPreferences } = await import("./settings");
  const { cutList, template, shoot } = record.assembly;
  const timing = planFx(cutList, template.fps, record);
  const short = (await getPreferences()).output.height, scale = Math.min(1, short / Math.min(template.width, template.height));
  const plans = cutFraming(cutList, template.fps, { w: Math.round(template.width * scale / 2) * 2, h: Math.round(template.height * scale / 2) * 2 }, record.energy ?? "subtle", record.faceMatch);
  return atS => {
    const k = timing.items.findIndex(p => atS >= p.startS - 1e-6 && atS < p.endS - 1e-6), c = cutList[k], item = timing.items[k];
    if (!c?.seg || !item) return null;
    const clip = shoot.clips.find(x => x.id === c.seg!.clip.id) ?? c.seg.clip, meta = clip.meta;
    if (!meta?.width || !meta.height) return null;
    const keys = item.timeMap, found = keys.findIndex((_key, n) => n + 1 < keys.length && atS < keys[n + 1].t), j = Math.max(0, found < 0 ? keys.length - 2 : found);
    const a = keys[j], b = keys[j + 1] ?? a, source = b.t > a.t ? a.s + (atS - a.t) * (b.s - a.s) / (b.t - a.t) : a.s;
    const faces = (clip.subject?.samples ?? []).filter(p => p.kind === "face" && [p.t, p.y, p.h].every(Number.isFinite) && p.h > 0 && p.h <= 1).sort((p, q) => p.t - q.t);
    const next = faces.findIndex(p => p.t >= source), after = faces[next], before = next > 0 ? faces[next - 1] : next < 0 ? faces.at(-1) : undefined;
    const near = [before, after].filter((p): p is NonNullable<typeof p> => !!p && Math.abs(p.t - source) <= 1);
    if (!near.length) return null;
    const u = near.length === 2 && after!.t > before!.t ? (source - before!.t) / (after!.t - before!.t) : 0;
    const face = near.length === 2 ? { y: before!.y + (after!.y - before!.y) * u, h: before!.h + (after!.h - before!.h) * u } : near[0];
    const top = face.y - face.h, plan = plans[k], rect = plan ? framingRectAt(plan, atS - item.startS) : null;
    const y = rect ? (top * meta.height - rect.y) / rect.h : (() => {
      const dims = clipDimensions(clip), scale = Math.min(template.width / dims.width, template.height / dims.height);
      return ((template.height - dims.height * scale) / 2 + top * dims.height * scale) / template.height;
    })();
    return Number.isFinite(y) && y > 0 && y < 1 ? y : null;
  };
}
/** The pass's key words in a version: their text, and the plain reason when one was put in front of him. */
function keyWordsOf(record: StoredVersion): { id: string; text: string; inFront: string | null }[] {
  const ids = new Set((record.produce?.groups ?? []).flatMap(g => g.moves).flatMap(m => m.slot === "graphic" && m.id ? [m.id] : []));
  return (record.overlays ?? []).flatMap(o => {
    if (!ids.has(o.id) || o.graphic?.template !== "key-word") return [];
    const text = (/<div class="w">([^<]*)<\/div>/.exec(o.graphic.html)?.[1] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    const note = (o.graphic as { behindNote?: string }).behindNote;
    return [{ id: o.id, text, inFront: o.graphic.layer !== "behind" && note ? note.replace(/^In front:\s*/, "") : null }];
  });
}
const inFrontNote = (w: { text: string; inFront: string | null }) => w.inFront ? `Put “${w.text}” in front of you: ${w.inFront.replace(/\.$/, "")}.` : null;

// ---- Engine turns (or the QA replay).
async function resource(relative: string): Promise<string> {
  const { app } = await import("electron");
  for (const file of [path.join(process.cwd(), relative), path.join(app.getAppPath(), relative), path.join(process.resourcesPath ?? "", relative)]) {
    try { return await fs.readFile(file, "utf8"); } catch { /* next */ }
  }
  throw new Error("Could not find precut's instructions. Reinstall precut.");
}
async function prompts(): Promise<{ director: string; critic: string }> {
  const [director, critic = ""] = (await resource("prompts/produce.md")).split("<!-- critic -->");
  return { director: director.trim(), critic: critic.trim() };
}
export class ReplayWaiting extends Error { constructor(public step: "director" | "critic", public dir: string) { super(`The ${step} request is in ${dir}. Put the engine's answer in response.txt there.`); } }
/** QA only: honoured in an unpackaged build (dev or a QA snapshot), never in the installed app. */
async function replayDir(): Promise<string | null> {
  const dir = process.env.PRECUT_PRODUCE_REPLAY;
  if (!dir || !path.isAbsolute(dir)) return null;
  const { app } = await import("electron");
  return app.isPackaged ? null : dir;
}
async function askEngine(step: "director" | "critic", prompt: string, images: string[], root: string, signal: AbortSignal): Promise<string> {
  const replay = await replayDir();
  if (replay) {
    const dir = path.join(replay, step), shots = path.join(dir, "images");
    await fs.mkdir(shots, { recursive: true });
    const copied: string[] = [];
    for (const [k, image] of images.entries()) { const to = path.join(shots, `${String(k + 1).padStart(2, "0")}-${path.basename(image)}`); await fs.copyFile(image, to); copied.push(to); }
    await fs.writeFile(path.join(dir, "prompt.md"), prompt);
    await fs.writeFile(path.join(dir, "request.json"), JSON.stringify({ step, prompt: path.join(dir, "prompt.md"), images: copied, cwd: root,
      note: "Feed prompt.md as the user text with the images attached in this order to one engine turn; save its final text as response.txt here." }, null, 1));
    const answer = await fs.readFile(path.join(dir, "response.txt"), "utf8").catch(() => null);
    if (answer === null) throw new ReplayWaiting(step, dir);
    return answer;
  }
  const { runModel } = await import("./ai");
  const { getEngine } = await import("./settings");
  const { measureModelWork } = await import("./model-pace");
  // Real turns only teach the row the engine's pace: a replayed answer is instant.
  return measureModelWork(step === "director" ? "produce-direct" : "produce-critic", images.length, async () => runModel({ engine: await getEngine(), prompt, images, cwd: root, signal, timeoutMs: 6 * 60_000 }));
}

// ---- The row's progress: the real stage, and a time left learned on this Mac.
type Stage = "watch" | "direct" | "place" | "review" | "critic" | "save";
type PaceKind = "produce-watch" | "produce-direct" | "produce-review" | "produce-critic";
const STAGE_KIND: Partial<Record<Stage, PaceKind>> = { watch: "produce-watch", direct: "produce-direct", review: "produce-review", critic: "produce-critic" };
const LABEL: Record<Stage, string> = { watch: "Adding finishing touches: watching your edit", direct: "Adding finishing touches: finding the payoff", place: "Adding finishing touches: placing the moves",
  review: "Adding finishing touches: watching it back", critic: "Adding finishing touches: checking each move", save: "Adding finishing touches: saving the pass" };
const ORDER: Stage[] = ["watch", "direct", "place", "review", "critic", "save"];
class ProduceClock {
  private stage: Stage = "watch"; private since = Date.now(); private readonly started = Date.now(); private fraction: number | null = null; private note = "";
  readonly sizes: Partial<Record<Stage, number>> = {};
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly activity: ActivityHandle, private readonly estimate: (kind: PaceKind, size: number) => number) {
    this.timer = setInterval(() => this.tell(), 2000);
    this.timer.unref?.();
  }
  /** A stage's size: a render's modelled seconds (windowCost), a turn's pictures. */
  size(stage: Stage, size: number) { this.sizes[stage] = size; }
  enter(stage: Stage, note = "") {
    // QA (the replay seam) reads each stage's time from here.
    if (process.env.PRECUT_PRODUCE_REPLAY) console.error(`[produce] ${this.stage} ${((Date.now() - this.since) / 1000).toFixed(1)} s, then ${stage} (expected ${Math.round(this.expected(stage))} s)`);
    this.stage = stage; this.since = Date.now(); this.fraction = null; this.note = note; this.activity.update({ label: LABEL[stage] }); this.tell();
  }
  progress(fraction: number | null, note?: string) { this.fraction = fraction; if (note !== undefined) this.note = note; this.tell(); }
  /** The pass's own edits run as grouped steps that may rename the task ("Updating ..."); the row follows a task named
   * "Adding finishing touches" on this edit, so the name and target go back once they are done. */
  reclaim(target: { cutId: string; version: number }) { this.activity.update({ label: LABEL[this.stage], target }); }
  private expected(stage: Stage): number {
    const kind = STAGE_KIND[stage];
    if (!kind) return 5;   // placing and saving the pass: a few seconds of edits, no render
    // Not sized yet: the watch as this edit's cold model sizes it, the review as a third of it, a turn by its pictures.
    const size = this.sizes[stage] ?? { watch: 60, review: (this.sizes.watch ?? 60) / 3, direct: 11, critic: 6, place: 0, save: 0 }[stage];
    return this.estimate(kind, size);
  }
  /** Seconds left: this stage's (from its real progress once there is some, else its estimate less the time spent, or
   * nothing once it has run past its estimate) plus the estimates of the stages after it. */
  left(): number | null {
    const spent = (Date.now() - this.since) / 1000, f = this.fraction;
    const own = f !== null && f >= 0.1 && spent > 3 ? spent * (1 - f) / f : this.expected(this.stage) - spent;
    if (!(own > 0)) return null;
    return own + ORDER.slice(ORDER.indexOf(this.stage) + 1).reduce((sum, s) => sum + this.expected(s), 0);
  }
  tell() {
    const left = this.left(), spent = (Date.now() - this.started) / 1000;
    this.activity.progress(left === null ? null : Math.min(99, Math.round(100 * spent / (spent + left))), this.note, left === null ? null : Math.round(left));
  }
  stop() { clearInterval(this.timer); if (process.env.PRECUT_PRODUCE_REPLAY) console.error(`[produce] ${this.stage} ${((Date.now() - this.since) / 1000).toFixed(1)} s, done in ${((Date.now() - this.started) / 1000).toFixed(1)} s`); }
}

// ---- Outcomes, kept beside the edit so the row can say what happened on a version with no pass.
const outcomeFile = (root: string, cutId: string) => path.join(root, ".sidething", "produce", `${cutId}.json`);
async function readOutcomes(root: string, cutId: string): Promise<ProduceOutcome[]> {
  try { const v = JSON.parse(await fs.readFile(outcomeFile(root, cutId), "utf8")); return Array.isArray(v?.outcomes) ? v.outcomes : []; } catch { return []; }
}
async function saveOutcome(root: string, cutId: string, outcome: ProduceOutcome): Promise<void> {
  const file = outcomeFile(root, cutId), all = [...(await readOutcomes(root, cutId)), outcome].slice(-30), temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(temporary, JSON.stringify({ outcomes: all })); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}
/** What the last Produce on this version came to: the pass it made (landed), or why it made none. */
export async function produceOutcome(root: string, cutId: string, version: number): Promise<ProduceOutcome | null> {
  root = path.resolve(root);
  // The newest Produce that started on this version or made it. A pass made from here and then undone leaves the
  // version as it was: nothing to say until Produce runs on it again.
  const found = [...await readOutcomes(root, cutId)].reverse().find(o => o.on === version || o.state === "landed" && o.version === version) ?? null;
  return found?.state === "landed" && found.version !== version ? null : found;
}

// ---- The flow.
const running = new Map<string, Promise<ProduceOutcome>>();
export function produceEdit(root: string, cutId: string, version: number): Promise<ProduceOutcome> {
  root = path.resolve(root);
  if (!Number.isInteger(version) || version < 1) return Promise.reject(new Error("Choose a saved version of this edit."));
  const key = `${root}|${cutId}`, existing = running.get(key);
  if (existing) return existing;
  const work = produceNow(root, cutId, version);
  running.set(key, work);
  void work.finally(() => { if (running.get(key) === work) running.delete(key); }).catch(() => {});
  return work;
}

async function produceNow(root: string, cutId: string, version: number): Promise<ProduceOutcome> {
  const { runActivity, withRenderSlot } = await import("./activity");
  const sidekick = await import("./sidekick"), revisions = await import("./revisions"), pace = await import("./model-pace");
  const at = () => new Date().toISOString();
  return runActivity({ kind: "finish", root, target: { cutId, version }, label: LABEL.watch, cancelable: true }, async activity => {
    const watched: string[] = [];   // the windows this run reads; older watch renders are cache and go at the end
    const finish = async (outcome: ProduceOutcome) => { if (outcome.state !== "waiting") await saveOutcome(root, cutId, outcome); return outcome; };
    const clock = new ProduceClock(activity, pace.estimateModelWork);
    const rendering = (what: string) => (done: number, total: number) => clock.progress(total > 0 ? done / total : null, `${what}${total > 0 && done > 0 && done < total ? `, ${Math.round(100 * done / total)}%` : ""}`);
    /** A render stage, timed against the planned seconds of the windows it really rendered (a cache hit teaches nothing). */
    const renderStage = async <T>(kind: PaceKind, work: () => Promise<T>, windows: (result: T) => WatchWindow[]) => {
      const t0 = performance.now(), result = await withRenderSlot(activity, work);
      const fresh = windows(result).filter(w => w.tookS > 2);
      if (fresh.length) pace.recordModelWork(kind, plannedSeconds(fresh.map(w => w.costS)), (performance.now() - t0) / 1000);
      return result;
    };
    try {
      const start = await sidekick.loadDraftVersion(root, cutId, version);
      if (start.produce && start.produce.removed === undefined) throw new Error("This edit already has finishing touches. Take them out before adding them again.");
      if (!start.pieces?.length) throw new Error("Add clips before adding finishing touches.");
      const work = path.join(root, ".sidething", "produce", cutId, `v${version}`);
      clock.enter("watch", "Rendering the moments worth a look");
      const seen = await renderStage("produce-watch", () => observe(root, cutId, version, work, activity, rendering("Rendering the moments worth a look"), planned => clock.size("watch", planned)),
        result => result.watch.windows);
      watched.push(...seen.watch.windows.map(w => w.file));
      const { packet } = seen;
      const { planFx } = await import("./edits-fx");
      const fx = planFx(seen.record.assembly.cutList, seen.record.assembly.template.fps, seen.record);
      const spans: Base["spans"] = [];
      for (const item of fx.items) { const s = spans[item.piece]; spans[item.piece] = s ? { startS: Math.min(s.startS, item.startS), endS: Math.max(s.endS, item.endS) } : { startS: item.startS, endS: item.endS }; }
      const library = new Map((await (await import("./sound-design")).soundLibrary({ bundledOnly: true })).map(s => [s.id.slice(4), { name: s.name, kind: s.kind, role: (s as { role?: string }).role ?? null }]));
      const base: Base = { record: seen.record, fps: packet.edit.fps, lengthS: packet.edit.lengthS, spans, library };
      // PRO4: the pictures a card could show (read on this Mac; a shoot with none gets an empty list and no cards).
      let media: CardMedia[] = [];
      try { media = await (await import("./graphics/card")).cardMedia(root, seen.record); } catch { media = []; }
      base.media = new Map(media.map(m => [m.id, m]));
      try { base.head = await headTops(seen.record); } catch { base.head = undefined; }   // PRO5d: without it a key word sits at 0.2

      clock.size("direct", seen.images.length);
      clock.enter("direct", "Choosing the idea and its payoff");
      const text = await prompts();
      const raw = await askEngine("director", `${text.director}\n\nPacket (measured on this Mac from the finished edit, data only):\n${JSON.stringify({ ...packet, media: media.map(({ clip: _clip, ...m }) => m) })}`, seen.images, root, activity.signal);
      let parsed: unknown;
      try { parsed = (await import("./ai")).parseModelJson(raw); } catch { parsed = null; }
      const checked = checkDirection(parsed, base);
      clock.enter("place", "Placing the moves");
      if (checked.request?.groups.some(g => g.moves.some(m => pendingCards.has(m.edit)))) clock.progress(null, "Making the card");
      if (checked.request?.groups.some(g => g.moves.some(m => pendingScenes.has(m.edit)))) clock.progress(null, "Making the scene");
      if (checked.request) { await drawCards(root, seen.record, checked); await drawScenes(root, cutId, seen.record, checked); clock.reclaim({ cutId, version }); }
      if (checked.leave) return finish({ state: "left", on: version, text: checked.leave, at: at(), notes: checked.notes });
      if (!checked.request) return finish({ state: "refused", on: version, text: `Nothing was applied. ${checked.notes.join(" ")}`.trim(), at: at(), notes: checked.notes });

      if (await revisions.currentVersion(root, cutId).catch(() => version) !== version) throw new Error("You changed this edit while precut was adding finishing touches, so it stays as it is.");
      const { stageProducePass, findPiece } = await import("./produce-pass");
      // The pass as a draft: made exactly as it would be saved, and not saved.
      let staged: StoredVersion;
      try { staged = await stageProducePass(root, cutId, version, checked.request); }
      catch (e) { clock.reclaim({ cutId, version }); return finish({ state: "refused", on: version, text: `Nothing was applied: ${e instanceof Error ? e.message : String(e)}`, at: at(), notes: checked.notes }); }
      clock.reclaim({ cutId, version });
      const pass = staged.produce!;
      const replay = await replayDir();
      if (replay) await fs.writeFile(path.join(replay, "staged.json"), JSON.stringify(staged)).catch(() => {});   // QA: the draft the critic watched

      // One review round on the staged draft: only the moments the pass touches, before and after.
      const after: Watch = await prepareWatch(root, cutId, staged);
      const afterFx = planFx(after.record.assembly.cutList, after.record.assembly.template.fps, after.record);
      const afterSpans: { startS: number; endS: number }[] = [];
      for (const item of afterFx.items) { const s = afterSpans[item.piece]; afterSpans[item.piece] = s ? { startS: Math.min(s.startS, item.startS), endS: Math.max(s.endS, item.endS) } : { startS: item.startS, endS: item.endS }; }
      const timeOf = (w: Where) => {
        if (w.kind === "time") return w.atS;
        const i = findPiece(after.record, w.ref);
        return i < 0 ? null : w.kind === "pieceStart" ? afterSpans[i]?.startS ?? null : afterSpans[i]?.endS ?? null;
      };
      const moments: MoveMoment[] = pass.groups.slice().sort((a, b) => a.rank - b.rank).flatMap(g => (checked.where.get(g.id) ?? [])
        .map(timeOf).filter((t): t is number => t !== null).map(t => ({ group: g.id, label: g.reason, atS: t })));
      clock.enter("review", "Rendering each move before and after");
      const beforeWindows = seen.watch.windows.length;
      const review = await renderStage("produce-review", async () => {
        const afterSamples = watchSound(after);
        afterSamples.catch(() => { /* awaited in observeAfter, once the windows are rendered */ });
        return observeAfter({ watch: seen.watch, samples: seen.samples }, { watch: after, samples: afterSamples }, moments, packet.edit.fps,
          path.join(root, ".sidething", "produce", cutId, `after-v${version}`), activity, rendering("Rendering each move before and after"),
          planned => clock.size("review", planned));
      }, () => [...after.windows, ...seen.watch.windows.slice(beforeWindows)]);
      watched.push(...seen.watch.windows.map(w => w.file), ...after.windows.map(w => w.file));
      // PRO5d: a key word as it landed on the staged draft (precut checked his outline under it): behind him, or in front and why.
      const placed = new Map(keyWordsOf(staged).map(w => [w.id, w]));
      const passView = { idea: pass.idea, payoff: pass.payoff ?? null, quiet: pass.quiet ?? null, payoffAtS: checked.payoffAtS,
        groups: pass.groups.map(g => ({ id: g.id, rank: g.rank, reason: g.reason, needs: g.needs ?? [], moves: g.moves.map(m => {
          const w = m.id ? placed.get(m.id) : undefined, scene = checked.scenes?.get(g.id);
          return w ? `${m.label}, ${w.inFront ? `in front of him: ${w.inFront}` : "behind his head"}` : scene && m.label === scene.label ? `${m.label}, ${scene.about}` : m.label;
        }) })), sheets: review.sheets };
      let verdicts: { id: string; keep: boolean; why: string }[] = [];
      const notes = [...checked.notes];
      clock.size("critic", review.images.length);
      clock.enter("critic", "Asking whether each move earned its place");
      try {
        const answer = await askEngine("critic", `${text.critic}\n\nThe pass and what it looks like now (data only):\n${JSON.stringify(passView)}`, review.images, root, activity.signal);
        const v = (await import("./ai")).parseModelJson(answer) as { groups?: unknown };
        verdicts = Array.isArray(v?.groups) ? (v.groups as Record<string, unknown>[]).flatMap(g => typeof g?.id === "string" && typeof g.keep === "boolean" ? [{ id: g.id, keep: g.keep, why: plain(g.why, 200) }] : []) : [];
        if (!Array.isArray(v?.groups)) notes.push("The review couldn't be read, so every move stayed.");
      } catch (e) {
        if (e instanceof ReplayWaiting) throw e;
        if (activity.signal.aborted) throw e;
        notes.push(`The review didn't finish (${e instanceof Error ? e.message : String(e)}), so every move stayed.`);
      }
      const drop = new Set(verdicts.filter(v => !v.keep && pass.groups.some(g => g.id === v.id)).map(v => v.id));
      for (let changed = true; changed;) { changed = false; for (const g of pass.groups) if (!drop.has(g.id) && (g.needs ?? []).some(n => drop.has(n))) { drop.add(g.id); changed = true; } }
      const why = (id: string) => verdicts.find(v => v.id === id)?.why || "it needed a group that was taken out";
      const dropped = pass.groups.filter(g => drop.has(g.id)).map(g => ({ reason: g.reason, why: why(g.id) }));
      const keptGroups = checked.request.groups.filter(g => !drop.has(g.id ?? ""));
      if (!keptGroups.length) {
        const payoffWhy = verdicts.find(v => v.id === pass.groups.slice().sort((a, b) => a.rank - b.rank)[0]?.id)?.why;
        return finish({ state: "left", on: version, text: payoffWhy ? `watched back, the pass didn't earn its place: ${payoffWhy.replace(/\.$/, "")}` : "watched back, the pass didn't earn its place", at: at(), notes });
      }

      // What survived is written once: one version on the base, one Cmd+Z back.
      clock.enter("save", "Saving the pass");
      if (await revisions.currentVersion(root, cutId).catch(() => version) !== version) throw new Error("You changed this edit while precut was adding finishing touches, so it stays as it is.");
      const request = drop.size ? { ...checked.request, groups: keptGroups.map(g => ({ ...g, ...(g.needs ? { needs: g.needs.filter(n => !drop.has(n)) } : {}) })) } : checked.request;
      try {
        const final = await sidekick.editCut(root, cutId, version, { kind: "produce", op: "apply", pass: request } as CutEdit).finally(() => clock.reclaim({ cutId, version }));
        // PRO5d: a key word precut had to put in front says so, in the pass's own outcome.
        for (const w of keyWordsOf(await sidekick.loadDraftVersion(root, cutId, final.version))) { const note = inFrontNote(w); if (note) notes.push(note); }
        // SCN2: a scene that stayed is named first, plainly.
        const scene = request.groups.map(g => checked.scenes?.get(g.id ?? "")?.line).find(Boolean);
        if (scene) notes.unshift(scene);
        return finish({ state: "landed", on: version, version: final.version, idea: pass.idea, payoff: pass.payoff ?? null, quiet: pass.quiet ?? null, dropped, at: at(), notes });
      } catch (e) {
        return finish({ state: "refused", on: version, text: `Nothing was applied: ${e instanceof Error ? e.message : String(e)}`, at: at(), notes });
      }
    } catch (e) {
      if (e instanceof ReplayWaiting) return { state: "waiting", on: version, step: e.step, dir: e.dir, text: e.message, at: at() } as ProduceOutcome;
      if (activity.signal.aborted) throw e;
      const message = e instanceof Error ? e.message : String(e);
      console.error("[produce]", message.slice(0, 2000));
      // A tool's own output is not words for the person.
      return finish({ state: "failed", on: version, text: /^Command failed|ffmpeg|\n/.test(message) ? "precut couldn't read the rendered edit. Try again." : message, at: at() });
    } finally {
      clock.stop();
      await pruneWatches(root, cutId, watched).catch(() => {});
      activity.progress(100, "", null);
    }
  }, { groupChildren: true });
}

/** Everything the MCP and the row read after a Produce: the outcome plus the pass as it stands. */
export async function produceReport(root: string, cutId: string, outcome: ProduceOutcome) {
  const sidekick = await import("./sidekick"), { produceStatus } = await import("./produce-pass");
  const v = outcome.state === "landed" ? outcome.version : outcome.on;
  return { ...(outcome.state === "landed" ? { cutId, version: v } : {}), outcome, ...produceStatus(await sidekick.loadDraftVersion(root, cutId, v)) };
}
export { CAPS, soundLibraryForDirector, type ObservePacket };
