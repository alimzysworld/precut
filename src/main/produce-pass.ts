// PRO1 (docs/plans/produced/spike-v1.md, "After Codex round 1", point 2): the container a Produce pass writes into.
// A pass is ranked groups of moves. Every move is a value precut already has (trim, clip settings, join, layout, punch,
// sound, graphic, caption accent, music mark), applied through the UL1 batch (sidekick.ts runBatch), so a pass, a Less,
// a More and a Remove are each ONE version and one Cmd+Z. Each move keeps its target by identity and its before-value:
// - pieces by id + clip (+ source span to tell repeats apart), never by index;
// - sounds and graphics by id, their times anchored to the piece under them (a ripple moves both together);
// - caption words by text and neighbours; music marks by kind, level and anchored time.
// A move whose current value is no longer what the pass left is the person's (handed): Less, More and Remove keep it and
// the row says so. Moves bound together (the two trims of one cut) are kept or taken out as one.
// The flow is fixed (no model call here); the director that decides the moves is PRO2.
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { CutEdit, JoinChoice, LayoutChoice, OverlayItem, PieceFx, ProduceAnchor, ProduceGroup, ProduceMove, ProduceMoveEdit,
  ProducePass, ProducePieceRef, ProduceRequest, SfxItem } from "../shared/schema";
import type { MusicShapeMark } from "../shared/music-shape";
import { timedCaptionWords } from "../shared/caption-words";
import { editCut, finishStoredVersion, loadDraftVersion, loadRevision, readCut, runBatch, settleSnapshot, type BatchStep, type StoredVersion } from "./sidekick";
import { planFx } from "./edits-fx";
import { standardFrameRate } from "../shared/frame-rate";
import { cutOnWordTrims, motionFx, motionStep } from "./motion-edits";
import { CARD_TEMPLATE, graphicSource } from "./graphics/templates";
import { stampInWords } from "./graphics/card";
import { isSceneGraphic, SCENE_LENGTH } from "./graphics/scene-edit";

type ProduceEdit = Extract<CutEdit, { kind: "produce" }>;
type Piece = NonNullable<StoredVersion["pieces"]>[number];
const GONE = Symbol("gone");   // the move's target is not in this version (a deleted piece or sound): it cannot be the pass's
type Read = unknown | typeof GONE;
type Timed<T> = { item: T; at: ProduceAnchor; lengthS?: number };
type Mark = { mark: MusicShapeMark; at: ProduceAnchor; lengthS?: number };
type Pause = { s: number; e: number; held: number | null };   // SCN2: the grown shot's source span, and the music held under the pause

const ms = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
// SCN2: anchors keep microseconds. A scene sits on exact frame times (28.6333 s); held to the millisecond, More put it
// back a third of a millisecond late, which is another version of it (and can be the next frame).
const us = (n: number) => Math.round(n * 1e6) / 1e6;
const clock = (t: number) => { const s = Math.max(0, Math.round(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
/** Canonical JSON: key order and absent-vs-undefined never make two equal values differ. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, v[k]])) : v);
}

// ---- Identity: pieces, times, words.
const refOf = (p: Piece): ProducePieceRef => ({ id: p.id, clipId: p.clipId, s: p.s, e: p.e });
/** The piece's index now: the one with this id and clip; among repeats, the one whose source span overlaps most. */
export function findPiece(record: StoredVersion, ref: ProducePieceRef | undefined): number {
  if (!ref) return -1;
  const pieces = record.pieces ?? [], found = pieces.flatMap((p, i) => p.id === ref.id && p.clipId === ref.clipId ? [i] : []);
  if (found.length < 2) return found[0] ?? -1;
  const overlap = (i: number) => Math.min(pieces[i].e, ref.e) - Math.max(pieces[i].s, ref.s);
  return found.sort((a, b) => overlap(b) - overlap(a) || Math.abs(pieces[a].s - ref.s) - Math.abs(pieces[b].s - ref.s))[0];
}
/** SCN2: the shot a pause grew. Its split leaves two pieces with one id and clip, so it is the one whose out point the
 * pause kept (the pause only moves its in point), nearest its in point before or after. */
function pausePiece(record: StoredVersion, move: ProduceMove): number {
  const ref = move.piece, after = move.after as Pause | null, before = move.before as Pause | null, pieces = record.pieces ?? [];
  if (!ref || !after) return -1;
  const found = pieces.flatMap((p, i) => p.id === ref.id && p.clipId === ref.clipId && Math.abs(p.e - after.e) < 1e-3 ? [i] : []);
  const near = (i: number) => Math.min(...[after.s, before?.s ?? after.s].map(x => Math.abs(pieces[i].s - x)));
  return found.sort((a, b) => near(a) - near(b))[0] ?? -1;
}
/** The music hold a pause made, at the grown shot's first frame (where the scene cuts in), P seconds long. */
const holdAt = (h: { atS: number; s: number }, atS: number, P: number) => Math.abs(h.s - P) < 1e-3 && Math.abs(h.atS - atS) < 2e-3;
/** Each piece's span on the reel clock, as playback and export place it. */
function reelSpans(record: StoredVersion): { startS: number; endS: number }[] {
  const plan = planFx(record.assembly.cutList, record.assembly.template.fps, record), out: { startS: number; endS: number }[] = [];
  for (const item of plan.items) {
    const at = out[item.piece];
    out[item.piece] = at ? { startS: Math.min(at.startS, item.startS), endS: Math.max(at.endS, item.endS) } : { startS: item.startS, endS: item.endS };
  }
  return out;
}
const spansOf = new WeakMap<StoredVersion, { startS: number; endS: number }[]>();
const spans = (record: StoredVersion) => { let s = spansOf.get(record); if (!s) { s = reelSpans(record); spansOf.set(record, s); } return s; };
// Held as the source second under it (content-locked), the way precut's magnetic ripple (shared/magnetic.ts) moves
// sounds and graphics when a piece is trimmed at its head: a hand trim of the shot under a pass sound leaves it the pass's.
const speedOf = (record: StoredVersion, i: number) => Math.abs(record.pieceFx?.[i]?.speed ?? 1) || 1;
function anchor(record: StoredVersion, t: number): ProduceAnchor {
  const all = spans(record), pieces = record.pieces ?? [];
  let i = all.findIndex(s => s && t >= s.startS - 1e-6 && t < s.endS - 1e-6);
  if (i < 0) i = t < (all[0]?.startS ?? 0) ? 0 : all.length - 1;
  return { piece: refOf(pieces[i]), sourceS: us(pieces[i].s + (t - (all[i]?.startS ?? 0)) * speedOf(record, i)) };
}
function timeOf(record: StoredVersion, at: ProduceAnchor): number | null {
  const i = findPiece(record, at.piece), span = i >= 0 ? spans(record)[i] : undefined;
  return span ? us(span.startS + (at.sourceS - record.pieces![i].s) / speedOf(record, i)) : null;
}
type Word = ReturnType<typeof timedCaptionWords>[number];
function wordRef(words: Word[], index: number): NonNullable<ProduceMove["word"]> {
  const w = words[index];
  return { text: w.text, s: ms(w.s), prev: words.slice(Math.max(0, index - 2), index).map(x => x.text), next: words.slice(index + 1, index + 3).map(x => x.text) };
}
/** The word's index now: same text, most neighbours in common, then nearest in time. */
function findWord(words: Word[], ref: NonNullable<ProduceMove["word"]>): number {
  let best = -1, score = -1, distance = Infinity;
  words.forEach((w, i) => {
    if (w.text !== ref.text) return;
    const near = wordRef(words, i), common = ref.prev.filter((t, k) => near.prev[near.prev.length - ref.prev.length + k] === t).length + ref.next.filter((t, k) => near.next[k] === t).length;
    const d = Math.abs(w.s - ref.s);
    if (common > score || common === score && d < distance) { best = i; score = common; distance = d; }
  });
  return best;
}

// ---- Values: what a move's target holds in a version, in a form two versions can compare.
function soundNow(record: StoredVersion, id: string | undefined): SfxItem | undefined { return id ? record.sfx?.find(s => s.id === id) : undefined; }
function graphicNow(record: StoredVersion, id: string | undefined): OverlayItem | undefined { return id ? record.overlays?.find(o => o.id === id) : undefined; }
const shapeOf = (record: StoredVersion): MusicShapeMark[] => record.music?.shape ?? [];
function matchMark(record: StoredVersion, m: Mark, skip = new Set<number>()): number {
  const at = timeOf(record, m.at);
  if (at === null) return -1;
  const { atS: _a, ...rest } = m.mark as MusicShapeMark & { endS?: number };
  return shapeOf(record).findIndex((x, i) => {
    if (skip.has(i)) return false;
    const { atS, endS, ...other } = x as MusicShapeMark & { endS?: number };
    const { endS: _e, ...want } = rest as typeof rest & { endS?: number };
    return canon(other) === canon(want) && Math.abs(atS - at) < 0.002 && (m.lengthS === undefined || endS !== undefined && Math.abs(endS - atS - m.lengthS) < 0.002);
  });
}
/** Is the target, in this version, holding `value` (one of the move's before or after)? */
function holds(record: StoredVersion, move: ProduceMove, value: unknown): boolean {
  if (move.slot === "sound" || move.slot === "graphic") {
    const item = move.slot === "sound" ? soundNow(record, move.id) : graphicNow(record, move.id);
    if (value === null) return !item;
    const want = value as Timed<Record<string, unknown>>;
    if (!item) return false;
    const t = timeOf(record, want.at), start = move.slot === "sound" ? (item as SfxItem).atS : (item as OverlayItem).s;
    if (t === null || Math.abs(start - t) > 0.002) return false;
    if (move.slot === "graphic" && Math.abs((item as OverlayItem).e - (item as OverlayItem).s - (want.lengthS ?? 0)) > 0.002) return false;
    return canon(comparable(move.slot, item as unknown as Record<string, unknown>)) === canon(comparable(move.slot, want.item));
  }
  if (move.slot === "music") {
    const other = (value === move.after ? move.before : move.after) as Mark | null;
    return (value === null || matchMark(record, value as Mark) >= 0) && (other === null || matchMark(record, other) < 0);
  }
  const now = read(record, move);
  return now !== GONE && canon(now) === canon(value);
}
const comparable = (slot: "sound" | "graphic", item: Record<string, unknown>) => {
  const { id: _id, auto: _auto, atS: _atS, s: _s, e: _e, file, ...rest } = item;
  return slot === "graphic" ? rest : { ...rest, file };   // a graphic's PNG is re-rendered on every add; its composition is what it is
};
/** span, fx, join, layout, punch, word: the target's plain value now, or GONE. */
function read(record: StoredVersion, move: ProduceMove): Read {
  if (move.slot === "word") {
    const words = timedCaptionWords(record.titles), i = move.word ? findWord(words, move.word) : -1;
    return i < 0 ? GONE : !!words[i].accent;
  }
  if (move.slot === "pause") {
    const i = pausePiece(record, move), P = (move.after as Pause).held;
    if (i < 0) return GONE;
    const p = record.pieces![i], at = spans(record)[i]?.startS ?? NaN;
    return { s: p.s, e: p.e, held: P !== null && (record.music?.pinnedArrangement?.holds ?? []).some(h => holdAt(h, at, P)) ? P : null };
  }
  const i = findPiece(record, move.piece);
  if (i < 0) return GONE;
  switch (move.slot) {
    case "span": { const p = record.pieces![i]; return { s: p.s, e: p.e }; }
    case "fx": return record.pieceFx?.[i] ?? null;
    case "layout": return record.layouts?.[i] ?? null;
    case "punch": return record.jumpScales?.[i] ?? null;
    case "join": return findPiece(record, move.next) === i + 1 ? record.joins?.[i] ?? null : GONE;
    default: return GONE;
  }
}

// ---- Setting a target to a value: one ordinary edit, resolved against the evolving draft when the step runs.
function setStep(root: string, cutId: string, move: ProduceMove, to: "before" | "after", added: ProduceMove[]): BatchStep {
  const value = move[to];
  return async (version: number) => {
    const record = await loadDraftVersion(root, cutId, version), edit = setEdit(root, cutId, record, move, value, added);
    if (edit === null) return { version };
    if (typeof edit === "function") return edit(version);
    return editCut(root, cutId, version, edit);
  };
}
function setEdit(root: string, cutId: string, record: StoredVersion, move: ProduceMove, value: unknown, added: ProduceMove[]): CutEdit | ((v: number) => Promise<{ version: number }>) | null {
  const i = findPiece(record, move.piece);
  switch (move.slot) {
    case "span": { const v = value as { s: number; e: number }; return { kind: "trim", piece: i, s: v.s, e: v.e, magnetic: true }; }
    case "fx": return { kind: "pieceFx", piece: i, fx: value as PieceFx | null };
    case "layout": return { kind: "layout", piece: i, layout: value as LayoutChoice | null };
    case "join": return { kind: "join", join: i, choice: value as JoinChoice | null };
    case "punch": return punchStep(root, cutId, move.piece!, value as number | null);
    case "pause": return pauseStep(root, cutId, move, value as Pause);
    case "word": {
      const words = timedCaptionWords(record.titles), index = findWord(words, move.word!);
      return index < 0 ? null : { kind: "captionWord", index, accent: value as boolean };
    }
    case "sound": {
      const now = soundNow(record, move.id);
      if (value === null) return now ? { kind: "sfx", op: "remove", id: now.id } : null;
      const want = value as Timed<SfxItem>, atS = timeOf(record, want.at);
      if (atS === null) return null;
      const { id: _id, auto: _auto, ...item } = want.item;
      if (now) return { kind: "sfx", op: "update", id: now.id, patch: { ...item, atS } };
      added.push(move);
      return { kind: "sfx", op: "add", item: { ...item, atS } };
    }
    case "graphic": {
      const now = graphicNow(record, move.id);
      if (value === null) return now ? { kind: "overlay", op: "remove", id: now.id } : null;
      const want = value as Timed<OverlayItem>, s = timeOf(record, want.at);
      if (s === null) return null;
      const { id: _id, file: _file, ...wanted } = want.item, e = us(s + (want.lengthS ?? 0));
      // PRO5d: a key word precut put in front of him (its outline wasn't clean there) goes back still asking to sit
      // behind him, so it is checked again where it lands; without this, More would bring it back as his own choice of front.
      const item = wanted.graphic?.behindNote ? { ...wanted, graphic: (({ behindNote: _n, behindCheck: _c, ...g }) => ({ ...g, layer: "behind" as const }))(wanted.graphic) } : wanted;
      if (now) return { kind: "overlay", op: "update", id: now.id, patch: { ...item, s, e } };
      added.push(move);
      return { kind: "overlay", op: "add", source: "", item: { ...item, s, e } };
    }
    case "music": {
      const shape = [...shapeOf(record)], other = (value === move.after ? move.before : move.after) as Mark | null;
      const at = other ? matchMark(record, other) : -1;
      if (at >= 0) shape.splice(at, 1);
      if (value !== null) {
        const want = value as Mark, t = timeOf(record, want.at);
        if (t === null) return null;
        shape.push({ ...want.mark, atS: t, ...(want.lengthS !== undefined ? { endS: ms(t + want.lengthS) } : {}) } as MusicShapeMark);
      }
      return { kind: "sfx", op: "musicShape", shape: shape.sort((a, b) => a.atS - b.atS) };
    }
  }
}
/** SCN2: a pause in or out: the grown shot trimmed (magnetic, so everything after it moves by the pause), then the
 * music's hold put in or taken out of the arrangement it had (scene-edit.ts pauseSteps' order), never re-fitted. */
function pauseStep(root: string, cutId: string, move: ProduceMove, value: Pause) {
  return async (version: number) => {
    let record = await loadDraftVersion(root, cutId, version), i = pausePiece(record, move);
    if (i < 0) throw new Error("The shot under the pause is no longer in this edit.");
    const music = record.music, P = (move.after as Pause).held;
    let v = version;
    if (Math.abs(record.pieces![i].s - value.s) > 1e-4 || Math.abs(record.pieces![i].e - value.e) > 1e-4) v = (await editCut(root, cutId, v, { kind: "trim", piece: i, s: value.s, e: value.e, magnetic: true })).version;
    if (P === null || !music?.pinnedArrangement) return { version: v };
    record = await loadDraftVersion(root, cutId, v); i = pausePiece(record, move);
    const at = spans(record)[i]?.startS;
    if (at === undefined) throw new Error("The shot under the pause is no longer in this edit.");
    const { holds: was = [], ...pinned } = music.pinnedArrangement, holds = [...was.filter(h => !holdAt(h, at, P)), ...(value.held !== null ? [{ atS: r4(at), s: P }] : [])];
    const { finishCut } = await import("./finish");
    return finishCut(root, cutId, v, { music: { ...music, gainDb: music.gainDb ?? -18, duck: music.duck ?? true, pinnedArrangement: holds.length ? { ...pinned, holds } : pinned } });
  };
}
/** J4's jumpScales has no hand edit of its own; a punch-in is set on the draft the same way finish-plan sets it. */
function punchStep(root: string, cutId: string, piece: ProducePieceRef, scale: number | null) {
  return (version: number) => finishStoredVersion(root, cutId, version, true, async (draft, assembly) => {
    const i = findPiece(draft, piece);
    if (i < 0) throw new Error("That clip is no longer in this edit.");
    if (scale !== null && !(Number.isFinite(scale) && scale >= 1 && scale <= 1.18)) throw new Error("A punch-in scales 1 to 1.18.");
    draft.jumpScales = Array.from({ length: draft.pieces?.length ?? 0 }, (_, k) => draft.jumpScales?.[k] ?? null);
    draft.jumpScales[i] = scale;
    draft.assembly = assembly; draft.feedback = "Changed a punch-in";
    return { version: draft.version };
  });
}

// ---- Apply: the director's moves as one batch; targets and before-values from the version it starts on.
const ALLOWED = "A produced move changes something precut already has: a trim, a cut on a word, clip settings or clip sound, a clip's punches or exposure keys, a join, a layout, a punch-in, a sound, a graphic, a caption accent, a music mark or a scene's pause.";
function validRequest(pass: ProduceRequest): void {
  if (!pass || typeof pass.idea !== "string" || !pass.idea.trim() || pass.idea.length > 200) throw new Error("Name the pass's idea in a few words.");
  if (!Array.isArray(pass.groups) || !pass.groups.length || pass.groups.length > 24) throw new Error("Give the pass 1 to 24 groups of moves.");
  const ids = pass.groups.map((g, i) => g.id ?? `g${i + 1}`);
  if (new Set(ids).size !== ids.length) throw new Error("Give each group its own id.");
  for (const g of pass.groups) {
    if (!Number.isFinite(g.rank) || typeof g.reason !== "string" || !g.reason.trim()) throw new Error("Give each group a rank and a reason.");
    if (!Array.isArray(g.moves) || !g.moves.length || g.moves.length > 200) throw new Error("Give each group 1 to 200 moves.");
    for (const need of g.needs ?? []) if (!ids.includes(need) || need === (g.id ?? `g${pass.groups.indexOf(g) + 1}`)) throw new Error(`Group "${g.reason}" needs a group that is not in this pass.`);
  }
}
/** The move a request edit makes, before its values are read; null when the edit is not a move. */
function moveFor(record: StoredVersion, edit: ProduceMoveEdit): Omit<ProduceMove, "before" | "after" | "label"> {
  const pieces = record.pieces ?? [], piece = (i: number) => {
    if (!Number.isInteger(i) || !pieces[i]) throw new Error(`Choose a clip in this edit (piece ${i}).`);
    return refOf(pieces[i]);
  };
  switch (edit.kind) {
    case "trim": return { slot: "span", piece: piece(edit.piece) };
    case "pieceFx": return { slot: "fx", piece: piece(edit.piece) };
    case "clipSound": if (edit.piece === undefined || edit.all !== undefined) throw new Error(ALLOWED); return { slot: "fx", piece: piece(edit.piece) };
    case "layout": return { slot: "layout", piece: piece(edit.piece) };
    case "join": return { slot: "join", piece: piece(edit.join), next: piece(edit.join + 1) };
    case "punch": return { slot: "punch", piece: piece(edit.piece) };
    case "captionWord": {
      if (edit.text !== undefined || edit.s !== undefined || edit.e !== undefined || typeof edit.accent !== "boolean") throw new Error("A pass changes a caption word's accent only, never its words or timing.");
      const words = timedCaptionWords(record.titles);
      if (!words[edit.index]) throw new Error("Choose a caption word in this edit.");
      return { slot: "word", word: wordRef(words, edit.index) };
    }
    case "sfx":
      if (edit.op === "add") return { slot: "sound" };
      if (edit.op === "musicShape") return { slot: "music" };
      if (!soundNow(record, edit.id)) throw new Error("That sound is no longer in this edit.");
      if (edit.id.startsWith("auto:")) throw new Error("A pass leaves precut's automatic sounds alone.");
      return { slot: "sound", id: edit.id };
    case "overlay":
      if (edit.op === "add") { if (!edit.item.graphic) throw new Error("A pass adds graphics; pictures are added by hand."); return { slot: "graphic" }; }
      if (!graphicNow(record, edit.id)?.graphic) throw new Error("A pass changes graphics only.");
      return { slot: "graphic", id: edit.id };
    case "musicMark": return { slot: "music" };
    case "pause": return { slot: "pause" };   // SCN2: its shot is known once the pause is made (the batch's last steps)
    case "clipPunch": case "clipExposure": return { slot: "fx", piece: piece((motionFx(record, edit) as { piece: number }).piece) };   // PRO3b
    default: throw new Error(ALLOWED);
  }
}
const targetKey = (m: Omit<ProduceMove, "before" | "after" | "label">) =>
  m.slot === "pause" ? null : m.slot === "word" ? `word:${canon(m.word)}` : m.slot === "sound" || m.slot === "graphic" ? m.id ? `${m.slot}:${m.id}` : null : m.slot === "music" ? null : `${m.slot}:${canon(m.piece)}:${canon(m.next ?? null)}`;
function stepFor(root: string, cutId: string, edit: ProduceMoveEdit, target: Omit<ProduceMove, "before" | "after" | "label">): BatchStep {
  // A caption word is found by its text and neighbours on the draft the step runs on: an earlier step (a trim that moves
  // clip captions) can change which index it has.
  if (edit.kind === "captionWord") return async version => {
    const words = timedCaptionWords((await loadDraftVersion(root, cutId, version)).titles), index = findWord(words, target.word!);
    if (index < 0) throw new Error(`Couldn't find the caption word "${target.word!.text}".`);
    return editCut(root, cutId, version, { kind: "captionWord", index, accent: edit.accent });
  };
  if (edit.kind === "clipPunch" || edit.kind === "clipExposure" || edit.kind === "cutOnWord") return motionStep(root, cutId, edit);   // PRO3b: merged into the clip's settings on the draft it runs on
  if (edit.kind === "punch") return async version => punchStep(root, cutId, refOf((await loadDraftVersion(root, cutId, version)).pieces![edit.piece]), edit.scale)(version);
  if (edit.kind === "musicMark") return async version => {
    const record = await loadDraftVersion(root, cutId, version);
    return editCut(root, cutId, version, { kind: "sfx", op: "musicShape", shape: [...shapeOf(record), edit.mark].sort((a, b) => a.atS - b.atS) });
  };
  // A graphic needs no picture source; it enters and leaves by its own animation, as add_graphic places one.
  if (edit.kind === "overlay" && edit.op === "add") return { ...edit, source: "", item: { ...{ corner: "square" as const, enter: "none" as const, exit: "none" as const, sound: null }, ...edit.item } };
  if (edit.kind === "pause") throw new Error(PAUSE_RULE);   // only ever under its scene (sceneSteps)
  return edit;
}
function label(base: StoredVersion, after: StoredVersion, move: ProduceMove): string {
  const at = (record: StoredVersion, i: number, end = false) => clock(spans(record)[i]?.[end ? "endS" : "startS"] ?? 0);
  switch (move.slot) {
    case "span": { const i = findPiece(after, move.piece), was = base.pieces?.[findPiece(base, move.piece)]; return `the cut at ${at(after, i, was?.s === after.pieces?.[i]?.s)}`; }
    case "fx": return `the clip at ${at(after, findPiece(after, move.piece))}`;
    case "layout": return `the layout at ${at(after, findPiece(after, move.piece))}`;
    case "punch": return `the punch-in at ${at(after, findPiece(after, move.piece))}`;
    case "pause": return `the pause at ${at(after, pausePiece(after, move))}`;
    case "join": return `the join at ${at(after, findPiece(after, move.piece), true)}`;
    case "word": return `the word “${move.word!.text.replace(/[.,!?;:]+$/, "")}”`;
    case "sound": { const v = (move.after ?? move.before) as Timed<SfxItem>; return `the ${v.item.name} at ${clock(timeOf(after, v.at) ?? timeOf(base, v.at) ?? 0)}`; }
    case "graphic": { const v = (move.after ?? move.before) as Timed<OverlayItem>; return `the ${v.item.graphic?.template === CARD_TEMPLATE ? "card" : "graphic"} at ${clock(timeOf(after, v.at) ?? timeOf(base, v.at) ?? 0)}`; }
    case "music": { const v = (move.after ?? move.before) as Mark; return `the music ${v.mark.kind === "still" ? "stillness" : "dip"} at ${clock(timeOf(after, v.at) ?? timeOf(base, v.at) ?? 0)}`; }
  }
}
const timedSound = (record: StoredVersion, item: SfxItem | undefined): Timed<SfxItem> | null => item ? { item: structuredClone(item), at: anchor(record, item.atS) } : null;
const timedGraphic = (record: StoredVersion, item: OverlayItem | undefined): Timed<OverlayItem> | null => item ? { item: structuredClone(item), at: anchor(record, item.s), lengthS: us(item.e - item.s) } : null;
const timedMark = (record: StoredVersion, mark: MusicShapeMark): Mark => ({ mark: structuredClone(mark), at: anchor(record, mark.atS), ...(mark.kind === "still" ? { lengthS: ms(mark.endS - mark.atS) } : {}) });
const sameMark = (a: MusicShapeMark, b: MusicShapeMark) => canon(a) === canon(b);

// ---- SCN2: a scene in the pass. At most one, and a pause only under the pause scene its group adds (at its start, for
// its length). The scene's moves run last: a pause splits and grows a shot, which shifts the index of every piece after
// it, so nothing that names a piece by index follows it; the scene and its sound go in after the pause, at their time on
// the base moved by whatever the moves before them moved there. The split stays when the pause is taken out (Less,
// Remove): the shot plays straight through it.
type PassMove = Omit<ProduceMove, "before" | "after" | "label"> & { edit: ProduceMoveEdit; given?: string; bind?: string };
type ScenePause = { piece: number; from: { s: number; e: number }; P: number; voice: (final: StoredVersion) => Promise<string | null> };
const PAUSE_RULE = "A pause goes under the pause scene its group adds: at the scene's start, for its length (0.6 to 4 seconds).";
const clockOf = (r: StoredVersion) => JSON.stringify(planFx(r.assembly.cutList, r.assembly.template.fps, r).items.map(i => [i.piece, ms(i.startS), ms(i.endS), i.timeMap]));
/** His voice put on the draft's picture as saving would put it (re-timed from the base, captions following). */
function settleVoice(root: string, cutId: string, version: number, base: StoredVersion) {
  return finishStoredVersion(root, cutId, version, true, async draft => {
    const { retimeScript } = await import("./voiceover-retime");
    draft.voiceover = { ...retimeScript(base.voiceover!, base, draft, { before: planFx(base.assembly.cutList, base.assembly.template.fps, base), after: planFx(draft.assembly.cutList, draft.assembly.template.fps, draft) }), version: draft.version };
    if (draft.titles) await (await import("./caption-realign")).followCaptionsToVoice(root, draft);
    draft.feedback = "Put the voice on the new picture";
    return { version: draft.version };
  });
}
function sceneSteps(root: string, cutId: string, base: StoredVersion, groups: { id: string; moves: PassMove[] }[]) {
  const isScene = (m: PassMove) => m.edit.kind === "overlay" && m.edit.op === "add" && isSceneGraphic(m.edit.item.graphic);
  const scenes = groups.flatMap(g => g.moves.filter(isScene).map(m => ({ g, m }))), pauses = groups.flatMap(g => g.moves.filter(m => m.edit.kind === "pause").map(m => ({ g, m })));
  if (scenes.length > 1) throw new Error("A pass shows at most one scene.");
  if (!scenes.length) { if (pauses.length) throw new Error(PAUSE_RULE); return null; }
  const { g, m: shown } = scenes[0], item = (shown.edit as Extract<CutEdit, { kind: "overlay"; op: "add" }>).item;
  const pause = pauses[0]?.m, asked = pause?.edit as { atS: number; lengthS: number } | undefined, P = asked?.lengthS ?? 0;
  if (pauses.length > 1 || pauses.some(x => x.g !== g)) throw new Error(PAUSE_RULE);
  if (asked && (![asked.atS, P].every(Number.isFinite) || P < SCENE_LENGTH.min - 1e-6 || P > SCENE_LENGTH.max + 1e-6 || Math.abs(item.s - asked.atS) > 1e-3 || Math.abs(item.e - item.s - P) > 1e-3)) throw new Error(PAUSE_RULE);
  // The scene's own sound lands inside it and goes in with it; every other move of its group runs before the pause.
  const own = (m: PassMove) => m === shown || m === pause || !!shown.bind && m.bind === shown.bind && m.edit.kind === "sfx" && m.edit.op === "add";
  const moves = [...g.moves.filter(m => !own(m)), ...(pause ? [pause] : []), shown, ...g.moves.filter(m => own(m) && m !== shown && m !== pause)];
  const at = anchor(base, item.s), fps = standardFrameRate(base.assembly.template.fps), state: { shift: number | null; pause: ScenePause | null } = { shift: null, pause: null };
  // How far the moves before it moved the scene's moment, in whole frames (0 when they didn't).
  const shiftOn = (record: StoredVersion) => {
    const t = timeOf(record, at);
    if (t === null) throw new Error("The shot under the scene is no longer in this edit.");
    return Math.abs(t - item.s) < 2e-3 ? 0 : Math.round((t - item.s) * fps) / fps;
  };
  const pauseStep: BatchStep = async version => {
    let record = await loadDraftVersion(root, cutId, version), v = version;
    state.shift = shiftOn(record);
    // Moves before it changed the picture: his voice goes onto that picture first, as saving would put it, so the pause
    // splits it in the right gap and ripples it from there.
    if (record.voiceover?.lines.length && clockOf(record) !== clockOf(base)) { v = (await settleVoice(root, cutId, v, base)).version; record = await loadDraftVersion(root, cutId, v); }
    const { scenePauseSteps } = await import("./graphics/scene-edit");
    const parts = await scenePauseSteps(root, cutId, record, item.s + state.shift, P, []);
    if (parts.grows.tail) throw new Error("There isn't enough of the shot before the pause to hold it. Pause on another shot, or use a cutaway.");
    // The shot it splits or grows is the pause's alone: a move on it couldn't tell which half it meant.
    const under = refOf(record.pieces![parts.grows.splits ? parts.grows.piece - 1 : parts.grows.piece]);
    if (groups.some(x => x.moves.some(o => [o.piece, o.next].some(r => r && r.id === under.id && r.clipId === under.clipId && Math.min(r.e, under.e) > Math.max(r.s, under.s)))))
      throw new Error("Another move in this pass changes the shot under the pause. Give the pause a shot of its own.");
    let k = 0;
    if (parts.grows.splits) v = (await parts.picture[k++](v)).version;
    const split = (await loadDraftVersion(root, cutId, v)).pieces![parts.grows.piece];
    for (; k < parts.picture.length; k++) v = (await parts.picture[k](v)).version;
    state.pause = { piece: parts.grows.piece, from: { s: split.s, e: split.e }, P, voice: parts.voice };
    return { version: v };
  };
  const addStep = (m: PassMove): BatchStep => async version => {
    const shift = state.shift ?? (state.shift = shiftOn(await loadDraftVersion(root, cutId, version))), edit = m.edit;
    if (edit.kind === "overlay" && edit.op === "add") return editCut(root, cutId, version, { ...edit, source: "", item: { ...{ corner: "square" as const, enter: "none" as const, exit: "none" as const, sound: null }, ...edit.item, s: edit.item.s + shift, e: edit.item.e + shift } });
    if (edit.kind === "sfx" && edit.op === "add") return editCut(root, cutId, version, { ...edit, item: { ...edit.item, atS: edit.item.atS + shift, ...(edit.item.landAtS !== undefined ? { landAtS: edit.item.landAtS + shift } : {}) } });
    throw new Error(ALLOWED);
  };
  return { moves, step: (m: PassMove): BatchStep | null => m === pause ? pauseStep : own(m) ? addStep(m) : null, get pause() { return state.pause; } };
}

async function applyPass(root: string, cutId: string, version: number, request: ProduceRequest, staged?: { record?: StoredVersion }) {
  validRequest(request);
  const base = await loadRevision(root, cutId, version);
  if (base.produce && base.produce.removed === undefined) throw new Error("This edit already has finishing touches. Take them out before adding them again.");
  const groups = request.groups.map((g, gi) => ({ id: g.id ?? `g${gi + 1}`, rank: g.rank, reason: g.reason.trim(), ...(g.needs?.length ? { needs: g.needs } : {}),
    // PRO3b: a cut on a word is the two magnetic trims it makes, bound together.
    moves: g.moves.flatMap((m, k) => m.edit.kind === "cutOnWord" ? cutOnWordTrims(base, m.edit).edits.map(edit => ({ ...m, edit, bind: m.bind ?? `${g.id ?? `g${gi + 1}`}-cut-on-word-${k}` })) : [m])
      .map(m => ({ ...moveFor(base, m.edit), edit: m.edit, given: m.label, bind: m.bind })) }));
  // One owner per target: two groups touching one thing could not be taken out one at a time.
  const owner = new Map<string, string>();
  for (const g of groups) for (const m of g.moves) { const key = targetKey(m); if (key && owner.get(key) && owner.get(key) !== g.id) throw new Error(`Two groups change ${m.slot === "word" ? `the word "${m.word!.text}"` : "the same thing"}; give each thing to one group.`); if (key) owner.set(key, g.id); }
  // PRO4: a pass shows at most one card, and a card's stamp is the person's own words (checked here too, so produce_apply
  // can't carry an invented one).
  const cards = groups.flatMap(g => g.moves).flatMap(m => m.edit.kind === "overlay" && m.edit.op === "add" && m.edit.item.graphic && (m.edit.item.graphic.template === CARD_TEMPLATE || graphicSource(m.edit.item.graphic)?.template === CARD_TEMPLATE) ? [m.edit.item] : []);
  if (cards.length > 1) throw new Error("A pass shows at most one card.");
  for (const card of cards) {
    const params = graphicSource(card.graphic!)?.params, stamp = params?.stamp;
    // PRO4b: checked where it really lands, so it can't repeat the caption on screen with it either.
    if (typeof stamp === "string" && stamp.trim()) stampInWords(timedCaptionWords(base.titles), stamp, card.s, card.e, { landS: card.s + (typeof params?.stampAtS === "number" ? params.stampAtS : Math.min((card.e - card.s) * 0.45, 1.1)) });
  }
  const music = groups.filter(g => g.moves.some(m => m.edit.kind === "sfx" && (m.edit as { op: string }).op === "musicShape"));
  if (music.length && (music.length > 1 || groups.some(g => g.moves.some(m => m.edit.kind === "musicMark")))) throw new Error("Give music changes as musicMark moves (one stillness or hit each), or one musicShape in one group.");
  const scene = sceneSteps(root, cutId, base, groups);
  // Caption words first, then every other group's moves, then the scene's (scene.ts orders its own).
  const all = groups.flatMap(g => g.moves), late = new Set(scene?.moves ?? []);
  const sequence = [...words(all.filter(m => !late.has(m))), ...(scene?.moves ?? [])];
  const steps = sequence.map(m => scene?.step(m) ?? stepFor(root, cutId, m.edit, m));
  const idea = request.idea.trim();
  return runBatch(root, cutId, version, `Finishing touches: ${idea}`, steps, async record => {
    // SCN2: a pause ripples his voice onto the finished picture once, here (a save would re-time it from before the split).
    const refused = scene?.pause ? await scene.pause.voice(record) : null;
    if (refused) throw new Error(refused);
    // The sounds and graphics the pass added, matched to their moves in the order the steps added them (precut's own
    // automatic sounds are never the pass's).
    const baseSounds = new Set((base.sfx ?? []).map(s => s.id)), newSounds = (record.sfx ?? []).filter(s => !baseSounds.has(s.id) && !s.auto);
    const baseGraphics = new Set((base.overlays ?? []).map(o => o.id)), newGraphics = (record.overlays ?? []).filter(o => !baseGraphics.has(o.id));
    const fresh = new Map<object, SfxItem | OverlayItem | undefined>();
    for (const m of sequence) if (!m.id && (m.slot === "sound" || m.slot === "graphic")) fresh.set(m, m.slot === "sound" ? newSounds.shift() : newGraphics.shift());
    let shapeBefore = [...shapeOf(base)], shapeAfter = [...shapeOf(record)];
    const made: ProduceGroup[] = groups.map(g => {
      const moves: ProduceMove[] = [], seen = new Map<string, ProduceMove>();
      for (const m of g.moves) {
        const { edit, given, ...target } = m, key = targetKey(target);
        if (key && seen.has(key)) continue;   // the same thing changed twice in one group: one move, base to final
        const add = (move: ProduceMove) => { move.label = given?.trim() || label(base, record, move); if (key) seen.set(key, move); moves.push(move); };
        if (target.slot === "sound") {
          const item = target.id ? soundNow(record, target.id) : fresh.get(m) as SfxItem | undefined;
          add({ ...target, ...(item ? { id: item.id } : {}), before: target.id ? timedSound(base, soundNow(base, target.id)) : null, after: timedSound(record, item), label: "" });
        } else if (target.slot === "graphic") {
          const item = target.id ? graphicNow(record, target.id) : fresh.get(m) as OverlayItem | undefined;
          add({ ...target, ...(item ? { id: item.id } : {}), before: target.id ? timedGraphic(base, graphicNow(base, target.id)) : null, after: timedGraphic(record, item), label: "" });
        } else if (target.slot === "pause") {
          const made = scene?.pause;
          if (!made) throw new Error("The pause wasn't made.");
          const piece = record.pieces![made.piece], at = spans(record)[made.piece]?.startS ?? NaN;
          const held = (record.music?.pinnedArrangement?.holds ?? []).some(h => holdAt(h, at, made.P)) ? made.P : null;
          add({ slot: "pause", piece: refOf(piece), before: { ...made.from, held: null }, after: { s: piece.s, e: piece.e, held }, label: "", ...(m.bind ? { bind: m.bind } : {}) });
        } else if (target.slot === "music") {
          // Each mark the pass added (or took away) is its own move, so a hit dip goes with its hit.
          const marks = edit.kind === "musicMark" ? [edit.mark] : (edit as { shape: MusicShapeMark[] | null }).shape ?? [];
          for (const want of marks) {
            const i = shapeAfter.findIndex(x => x.kind === want.kind && Math.abs(x.atS - want.atS) < 0.002 && !shapeBefore.some(b => sameMark(b, x)));
            if (i < 0) continue;
            add({ slot: "music", before: null, after: timedMark(record, shapeAfter[i]), label: "", ...(m.bind ? { bind: m.bind } : {}) });
            shapeAfter = shapeAfter.filter((_, k) => k !== i);
          }
          if (edit.kind !== "musicMark") for (const gone of shapeBefore.filter(b => !shapeOf(record).some(x => sameMark(b, x)))) {
            add({ slot: "music", before: timedMark(base, gone), after: null, label: "", ...(m.bind ? { bind: m.bind } : {}) });
            shapeBefore = shapeBefore.filter(x => x !== gone);
          }
        } else {
          const move = { ...target, label: "", before: read(base, target as ProduceMove), after: read(record, target as ProduceMove) } as ProduceMove;
          if (move.before === GONE || move.after === GONE) throw new Error(`Couldn't find ${target.slot === "word" ? "that caption word" : "that clip"} after the pass.`);
          add(move);
        }
      }
      // Moves that changed nothing are not the pass's: Less would have nothing to take out.
      const real = moves.filter(mv => canon(mv.before) !== canon(mv.after));
      return { id: g.id, rank: g.rank, reason: g.reason, ...(g.needs ? { needs: g.needs } : {}), on: true, moves: real };
    });
    if (made.every(g => !g.moves.length)) throw new Error("None of the pass's moves changed the edit.");
    const pass: ProducePass = { id: randomUUID(), idea, ...(request.payoff?.trim() ? { payoff: request.payoff.trim() } : {}), ...(request.quiet?.trim() ? { quiet: request.quiet.trim() } : {}),
      at: new Date().toISOString(), madeOn: version, groups: made };
    record.produce = pass;
    // PRO2b: staged, the finished draft goes back to Produce to be watched and history stays exactly as it was.
    if (staged) { staged.record = record; return false; }
    return true;
  });
}
/** PRO2b: the pass as one draft, made exactly as `apply` makes it but never saved: Produce's critic watches it before
 * anything is written, so the person's history only ever gets the pass that survived the review (one version). */
export async function stageProducePass(root: string, cutId: string, version: number, request: ProduceRequest): Promise<StoredVersion> {
  const staged: { record?: StoredVersion } = {};
  root = path.resolve(root);
  await applyPass(root, cutId, version, request, staged);
  if (!staged.record) throw new Error("The pass could not be made.");
  // What saving would do to it too (the voice retimed to the new picture, captions following the voice).
  const cut = await readCut(root, cutId);
  await settleSnapshot(root, { ...cut, versions: [...cut.versions, staged.record] }, staged.record);
  return staged.record;
}

// ---- Less, More, Remove.
/** Moves bound together share one fate: if any is the person's, all are. */
function bindHanded(group: ProduceGroup, handed: Set<ProduceMove>) {
  for (const m of group.moves) if (m.bind && handed.has(m)) for (const o of group.moves) if (o.bind === m.bind) handed.add(o);
}
/** Which moves of these groups are still the pass's in this version (holding `state`), and which are now the person's. */
function ownership(record: StoredVersion, groups: ProduceGroup[], state: "before" | "after") {
  const handed = new Set<ProduceMove>();
  for (const g of groups) {
    for (const m of g.moves) if (m.handed || !holds(record, m, m[state])) handed.add(m);
    bindHanded(g, handed);
  }
  return handed;
}
function keptNote(moves: ProduceMove[]): string | null {
  const labels: string[] = [], binds = new Set<string>();
  for (const m of moves) { if (m.bind) { if (binds.has(m.bind)) continue; binds.add(m.bind); } if (!labels.includes(m.label)) labels.push(m.label); }
  if (!labels.length) return null;
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `Kept your change${labels.length > 1 ? "s" : ""} to ${list}.`;
}
/** The group Less takes out: the weakest still in that no group still in needs. */
export function nextLess(pass: ProducePass): ProduceGroup | undefined {
  const on = pass.groups.filter(g => g.on);
  return on.filter(g => !on.some(o => o.needs?.includes(g.id))).sort((a, b) => b.rank - a.rank)[0];
}
/** The group More puts back: the strongest out whose needs are all in. */
export function nextMore(pass: ProducePass): ProduceGroup | undefined {
  const on = new Set(pass.groups.filter(g => g.on).map(g => g.id));
  return pass.groups.filter(g => !g.on && (g.needs ?? []).every(n => on.has(n))).sort((a, b) => a.rank - b.rank)[0];
}
// Caption words first: inside one batch a trim leaves the voiceover's captions retimed until the version is saved (the
// save puts them back on the voice), so an accent set after it lands on shifted words and spreads to a neighbour. Accents
// move nothing. Then spans: a trim ripples what follows, and every later step reads its times from the draft it runs on,
// so a sound put back lands on its frame of the finished cut.
const words = <T extends { slot?: string }>(moves: T[]) => [...moves.filter(m => m.slot === "word"), ...moves.filter(m => m.slot !== "word")];
const order = (moves: ProduceMove[]) => words([...moves.filter(m => m.slot === "span" || m.slot === "pause"), ...moves.filter(m => m.slot !== "span" && m.slot !== "pause")]);

async function toggle(root: string, cutId: string, version: number, op: "less" | "more" | "remove") {
  const base = await loadRevision(root, cutId, version), pass = base.produce;
  if (!pass || pass.removed !== undefined) throw new Error("This edit has no finishing touches.");
  const groups = op === "remove" ? pass.groups.filter(g => g.on) : [op === "less" ? nextLess(pass) : nextMore(pass)].filter((g): g is ProduceGroup => !!g);
  if (!groups.length) throw new Error(op === "less" ? "Nothing of the pass is left to take out. Remove takes the pass out." : op === "more" ? "The whole pass is already in." : "This edit has no finishing touches.");
  const to = op === "more" ? "after" : "before", handed = ownership(base, groups, op === "more" ? "before" : "after");
  const moving = groups.flatMap(g => g.moves.filter(m => !handed.has(m)));
  const added: ProduceMove[] = [];   // sounds and graphics a step adds back, in order: their new ids are read after
  const steps = order(moving).map(m => setStep(root, cutId, m, to, added));
  const name = op === "remove" ? "Took the finishing touches out" : op === "less" ? `Fewer finishing touches: ${groups[0].reason}` : `More finishing touches: ${groups[0].reason}`;
  return runBatch(root, cutId, version, name.length > 240 ? `${name.slice(0, 239)}…` : name, steps, async record => {
    const next = structuredClone(pass), at = (g: ProduceGroup) => next.groups.find(x => x.id === g.id)!;
    const kept: ProduceMove[] = [];
    // New ids for sounds and graphics put back, matched in the order they were added.
    const oldSounds = new Set((base.sfx ?? []).map(s => s.id)), oldGraphics = new Set((base.overlays ?? []).map(o => o.id));
    const freshSounds = (record.sfx ?? []).filter(s => !oldSounds.has(s.id)), freshGraphics = (record.overlays ?? []).filter(o => !oldGraphics.has(o.id));
    for (const g of groups) {
      const target = at(g);
      target.on = op === "more";
      target.moves = g.moves.map(m => {
        const copy = structuredClone(m);
        if (handed.has(m)) { if (!m.handed) copy.handed = true; kept.push(copy); return copy; }
        if (added.includes(m)) { const fresh = (m.slot === "sound" ? freshSounds : freshGraphics).shift(); if (fresh) copy.id = fresh.id; }
        return copy;
      });
    }
    // Keep identities fresh: a piece's source span after this change tells its repeats apart next time.
    for (const g of next.groups) for (const m of g.moves) for (const key of ["piece", "next"] as const) {
      const i = m.slot === "pause" ? key === "piece" ? pausePiece(record, m) : -1 : findPiece(record, m[key]);
      if (i >= 0 && m[key]) m[key] = refOf(record.pieces![i]);
    }
    if (op === "remove") next.removed = record.version;
    const note = keptNote(kept);
    if (note) next.note = { version: record.version, text: note }; else delete next.note;
    record.produce = next;
    return true;
  });
}

/** CutEdit kind "produce": one version per call, through the batch (inside the caller's commit). */
export async function editProduce(root: string, cutId: string, version: number, edit: ProduceEdit): Promise<{ cutId: string; version: number }> {
  root = path.resolve(root);
  const result = edit.op === "apply" ? await applyPass(root, cutId, version, edit.pass)
    : ["less", "more", "remove"].includes(edit.op) ? await toggle(root, cutId, version, edit.op) : (() => { throw new Error("Choose apply, less, more or remove."); })();
  if (!result) throw new Error("The pass could not be saved.");
  return result;
}

/** produce_status and the row: the pass as it stands in this version, each move marked the pass's or the person's. */
export function produceStatus(record: StoredVersion) {
  const pass = record.produce;
  if (!pass) return { pass: null };
  const live = pass.removed === undefined;
  const groups = pass.groups.map(g => {
    const handed = live ? ownership(record, [g], g.on ? "after" : "before") : new Set<ProduceMove>();
    return { id: g.id, rank: g.rank, reason: g.reason, needs: g.needs ?? [], in: g.on,
      moves: g.moves.map(m => ({ slot: m.slot, label: m.label, yours: live && handed.has(m), ...(m.id ? { id: m.id } : {}) })) };
  });
  return { pass: { id: pass.id, idea: pass.idea, payoff: pass.payoff ?? null, quiet: pass.quiet ?? null, madeOn: pass.madeOn, at: pass.at,
    removed: pass.removed ?? null, note: pass.note?.version === record.version ? pass.note.text : null, groups,
    next: live ? { less: nextLess(pass)?.reason ?? null, more: nextMore(pass)?.reason ?? null } : null } };
}
