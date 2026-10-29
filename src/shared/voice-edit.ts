import type { CutEdit, VoiceCut, VoiceoverLine, Word } from "./schema";

/** VO6: hand edits on the Voiceover lane. One pure function feeds the live
 * preview while dragging and the saved version, so both land on the same edge.
 * A piece is a VoiceoverLine: `s` is where it sits on the reel, `take` the
 * slice of the recording it plays. Picture is never read or changed here. */
export type VoiceEdit = Extract<CutEdit, { kind: "voiceover" }>;
export type VoiceTake = { file: string; durationS: number; words: Word[] };
const MIN = 0.05;

export function voiceText(words: Word[]): string {
  const spaced = words.filter(w => /^\s/u.test(w.w)).length * 2 > words.length;
  let text = "";
  for (const { w } of words) {
    const word = w.trim(); if (!word) continue;
    const joins = spaced ? !/^\s/u.test(w) : /^[-'’,.!?;:)]/u.test(word);
    text += !text || joins ? word : ` ${word}`;
  }
  return text;
}
/** VO7-5: which placement of a take a piece plays. Splits keep it; duplicates and new placements make one. */
export const occurrenceOf = (line: Pick<VoiceoverLine, "id" | "occurrence">): string => line.occurrence ?? line.id;
/** VO7-5: a take's words in time order, each with its immutable take-word id: the transcript's own id when it
 * has one, otherwise the take file plus the word's place in this order (the order Clean read numbers). */
export function takeWordList(take: { file: string; durationS: number; transcript?: { words: Word[] }[] | null }): { word: Word; id: string }[] {
  const timed = (take.transcript ?? []).flatMap(s => s.words)
    .filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s && w.s >= 0 && w.e <= take.durationS)
    .sort((a, b) => a.s - b.s);
  return timed.map((word, i) => ({ word, id: typeof word.id === "string" && word.id ? word.id : `${take.file}#w${i}` }));
}
const inside = (words: Word[], s: number, e: number) => words.filter(w => w.s >= s - 1e-6 && w.e <= e + 1e-6);
function nearest(candidates: number[], at: number, low: number, high: number): number {
  const fit = candidates.filter(c => c >= low - 1e-9 && c <= high + 1e-9).sort((a, b) => Math.abs(a - at) - Math.abs(b - at));
  return fit[0] ?? Math.max(low, Math.min(high, at));
}
const ordered = (lines: VoiceoverLine[]) => lines.filter(l => l.take).sort((a, b) => a.s - b.s);
const length = (l: VoiceoverLine) => l.take!.e - l.take!.s;
const piece = (l: VoiceoverLine, s: number, take: { file: string; s: number; e: number }, words: Word[]): VoiceoverLine =>
  // A hand-cut piece carries no script pause: it sits exactly where it was put.
  ({ ...l, s, e: s + take.e - take.s, take, text: voiceText(inside(words, take.s, take.e)) || l.text, pauseAfterS: undefined, pauseNote: undefined });

/** VO7: one span of a take that a resolved clean read plays, in seconds of
 * that take. Pauses are already inside the span edges (see clean-read.ts). */
export type PlanSpan = { s: number; e: number };
/** VO7: lay a resolved plan on the Voiceover lane. Local to this file until the
 * schema's CutEdit union names it (stage 1 owns schema.ts). `identity` is the
 * proposal's, so main can refuse a plan made from an older take or script. */
export type PlacePlanEdit = { kind: "voiceover"; op: "placePlan"; take: string; spans: PlanSpan[]; at?: number;
  identity?: { content: string; transcript: string; script: string };
  /** Add a recording's Apply: these pieces (by id or occurrence, so split halves go too) leave in the same version. */
  replace?: string[] };
/** VO7-5: Shift+Delete removes those pieces and slides later voice left by their summed lengths (gaps
 * kept), or closes one empty gap. Duplicate (⌘D) copies a piece just after it, as a new occurrence.
 * Local here, as placePlan is, so the shared CutEdit union (and the renderer's labels) stay as they are. */
export type RippleEdit = { kind: "voiceover"; op: "ripple"; lines?: string[]; gap?: { s: number; e: number } };
export type DuplicateVoiceEdit = { kind: "voiceover"; op: "duplicate"; line: string };
/** VO7-8: the Blade (and ⌥) cut exactly where its landing line showed, so `free` skips the
 * nearest-word-edge move a playhead split makes. Remove with `lines` deletes several pieces at once
 * (gaps left, one undo). Local, as ripple is, so the shared CutEdit union stays as it is. */
export type SplitVoiceEdit = { kind: "voiceover"; op: "split"; line: string; at: number; free?: boolean };
export type RemoveVoiceEdit = { kind: "voiceover"; op: "remove"; line: string; lines?: string[] };
/** VO7-13: a move with `lines` moves those pieces together by the dragged piece's change (`line` to `s`),
 * keeping their spacing; the group stops at the nearest unselected neighbour on either side. */
export type MoveVoiceEdit = { kind: "voiceover"; op: "move"; line: string; s: number; lines?: string[] };
/** SCRIPT1: cut reel `s`..`e` of voice words and keep the cut listed (struck, restorable); close slides later
 * voice left by the length cut (Close gaps). restoreCut puts back a listed cut, or only take seconds `s`..`e` of it.
 * Local, as ripple is, so the shared CutEdit union stays as it is. */
export type CutVoiceWordsEdit = { kind: "voiceover"; op: "cutWords"; s: number; e: number; close?: boolean };
export type RestoreVoiceCutEdit = { kind: "voiceover"; op: "restoreCut"; cut: string; s?: number; e?: number };
export type VoiceEditOp = VoiceEdit | PlacePlanEdit | RippleEdit | DuplicateVoiceEdit | SplitVoiceEdit | RemoveVoiceEdit | MoveVoiceEdit | CutVoiceWordsEdit | RestoreVoiceCutEdit;
const voiceEnd = (l: VoiceoverLine) => l.s + length(l);

/** VO7 Insertion rule: existing voice is kept. The plan's spans become one piece
 * each, butted together from `at`. If the whole insertion would overlap any
 * voice, it is appended after the latest existing voice end instead. */
export function placePlan(lines: VoiceoverLine[], take: VoiceTake, spans: PlanSpan[], at: number | undefined, id: () => string): { lines: VoiceoverLine[]; placed: string[]; at: number; appended: boolean } {
  if (!(take.durationS > 0)) throw new Error("Choose a saved voiceover take from this shoot.");
  if (!Array.isArray(spans) || !spans.length) throw new Error("Choose what to keep from this take first.");
  for (const span of spans) {
    if (!Number.isFinite(span?.s) || !Number.isFinite(span?.e) || span.s < -1e-6 || span.e > take.durationS + 1e-6 || span.e - span.s < MIN / 5)
      throw new Error("This clean read no longer fits its take. Run Clean read again.");
  }
  const existing = ordered(lines), total = spans.reduce((sum, span) => sum + Math.min(take.durationS, span.e) - Math.max(0, span.s), 0);
  const { at: start, appended: overlaps } = insertionAt(existing, Number.isFinite(at) ? at! : 0, total);
  let s = start;
  const added = spans.map(span => {
    const src = { file: take.file, s: Math.max(0, span.s), e: Math.min(take.durationS, span.e) };
    const fresh = id(), line = piece({ id: fresh, occurrence: fresh, text: "", s, e: s }, s, src, take.words);
    s += src.e - src.s;
    return line;
  });
  return { lines: [...existing, ...added].sort((a, b) => a.s - b.s), placed: added.map(l => l.id), at: start, appended: overlaps };
}

/** Add a recording: Apply swaps the raw piece for the clean read in one version. The pieces named (or
 * split from them) leave, and the plan lands where the first of them began; none left means `at` as given. */
export function withoutReplaced(lines: VoiceoverLine[], replace: string[] | undefined, at: number | undefined): { lines: VoiceoverLine[]; at: number | undefined } {
  if (!Array.isArray(replace) || !replace.length) return { lines, at };
  const ids = new Set(replace), gone = lines.filter(l => ids.has(l.id) || ids.has(occurrenceOf(l)));
  return gone.length ? { lines: lines.filter(l => !gone.includes(l)), at: Math.min(...gone.map(l => l.s)) } : { lines, at };
}
/** VO7 Insertion rule, on its own so the drop ghost lands where the drop will: `length` seconds at
 * `at`, or after the latest existing voice end when the whole insertion would overlap any voice. */
export function insertionAt(lines: VoiceoverLine[], at: number, length: number): { at: number; appended: boolean } {
  const existing = ordered(lines), start = Math.max(0, Number.isFinite(at) ? at : 0);
  const overlaps = existing.some(l => l.s < start + length - 1e-9 && voiceEnd(l) > start + 1e-9);
  return { at: overlaps ? Math.max(...existing.map(voiceEnd)) : start, appended: overlaps };
}
/** VO7-8 Blade and trim snapping: the reel time of the nearest of `edges` (take seconds) within
 * `radiusS` of `at` (reel seconds), taking the earlier edge on a tie; otherwise `at` itself. The
 * caller passes radius 8 screen pixels in seconds, or 0 for ⌥. */
export function snapToEdge(line: VoiceoverLine, edges: number[], at: number, radiusS: number): { at: number; snapped: boolean } {
  let best: number | null = null;
  for (const edge of edges) {
    const t = line.s + edge - line.take!.s, d = Math.abs(t - at);
    if (d > radiusS + 1e-9) continue;
    if (best === null || d < Math.abs(best - at) - 1e-9 || (Math.abs(d - Math.abs(best - at)) <= 1e-9 && t < best)) best = t;
  }
  return best === null ? { at, snapped: false } : { at: best, snapped: true };
}
/** Word edges of a piece's take, in take seconds, for the Blade (both edges of every word). */
export const wordEdges = (words: Word[]): number[] => words.flatMap(w => [w.s, w.e]);
/** VO7-8: where the Blade would cut a piece at reel `at`, or null on a seam (within MIN of an end). */
export function bladeCut(line: VoiceoverLine, words: Word[], at: number, radiusS: number): number | null {
  const t = line.take!, inner = wordEdges(words).filter(e => e > t.s + MIN && e < t.e - MIN);
  const cut = snapToEdge(line, inner, at, radiusS).at, src = t.s + cut - line.s;
  return src > t.s + MIN && src < t.e - MIN ? cut : null;
}
/** VO7-8: the empty stretches of the Voiceover lane: from 0:00 to the first piece, then between pieces. */
export function voiceGaps(lines: VoiceoverLine[]): { s: number; e: number }[] {
  const all = ordered(lines), gaps: { s: number; e: number }[] = [];
  let end = 0;
  for (const l of all) { if (l.s - end > 1e-3) gaps.push({ s: end, e: l.s }); end = Math.max(end, voiceEnd(l)); }
  return gaps;
}
/** VO7 Fades: a linear 5 ms fade-out and fade-in inside the kept audio at every boundary where take
 * audio was removed (or starts from silence); none across an untouched seam, where the next piece
 * plays the very next take sample at the very next reel time. Never longer than half a piece, so the
 * two fades of a short piece never overlap. Timing never changes. Every exporter reads this. */
export const JOIN_FADE_S = 0.005;
export function voiceJoinFades(lines: VoiceoverLine[]): Map<string, { fadeInS: number; fadeOutS: number }> {
  const all = ordered(lines), out = new Map<string, { fadeInS: number; fadeOutS: number }>();
  const seam = (a: VoiceoverLine | undefined, b: VoiceoverLine | undefined) => !!a && !!b && a.take!.file === b.take!.file
    && Math.abs(voiceEnd(a) - b.s) <= 1e-6 && Math.abs(a.take!.e - b.take!.s) <= 1e-6;
  all.forEach((l, i) => {
    const cap = Math.min(JOIN_FADE_S, length(l) / 2);
    out.set(l.id, { fadeInS: seam(all[i - 1], l) ? 0 : cap, fadeOutS: seam(l, all[i + 1]) ? 0 : cap });
  });
  return out;
}

/** SCRIPT1: a piece slid along the lane as a whole keeps where the picture wanted it, slid too (VoiceoverLine.follow). */
const slide = (l: VoiceoverLine, d: number): VoiceoverLine => ({ ...l, s: l.s + d, e: l.s + d + length(l), ...(l.follow ? { follow: { want: l.follow.want + d, at: l.follow.at + d } } : {}) });
/** VO7 Ripple: each surviving piece moves left by the summed lengths of the removed pieces that end
 * before its start; gaps already there stay. A gap alone closes only that gap. */
function ripple(lines: VoiceoverLine[], edit: RippleEdit): VoiceoverLine[] {
  const all = ordered(lines);
  if (edit.gap) {
    const { s, e } = edit.gap;
    if (!Number.isFinite(s) || !Number.isFinite(e) || e - s <= 1e-6 || all.some(l => l.s < e - 1e-6 && voiceEnd(l) > s + 1e-6)) throw new Error("Choose a gap between voice pieces to close.");
    return all.map(l => l.s >= e - 1e-6 ? slide(l, -(e - s)) : l);
  }
  const ids = new Set(edit.lines ?? []);
  if (!ids.size || [...ids].some(id => !all.some(l => l.id === id))) throw new Error("Choose a voice piece on the Voiceover lane.");
  const removed = all.filter(l => ids.has(l.id));
  return all.filter(l => !ids.has(l.id)).map(l => {
    const shift = removed.filter(r => voiceEnd(r) <= l.s + 1e-6).reduce((sum, r) => sum + length(r), 0);
    return shift ? slide(l, -shift) : l;
  });
}

/** VO7 Text panel: the edits that cut reel `s`..`e` out of the voice (split, trim and remove; a gap is left). */
export function cutVoiceEdits(lines: VoiceoverLine[], s: number, e: number): CutEdit[] {
  return cutVoiceRange(lines, s, e).edits;
}
function cutVoiceRange(lines: VoiceoverLine[], s: number, e: number): { edits: CutEdit[]; removed: { s: number; e: number }[] } {
  const edits: CutEdit[] = [], removed: { s: number; e: number }[] = [];
  for (const line of ordered(lines)) {
    const ls = line.s, le = voiceEnd(line);
    if (le <= s + 1e-6 || ls >= e - 1e-6) continue;
    const head = s - ls > MIN, tail = le - e > MIN;
    if (!head && !tail) { edits.push({ kind: "voiceover", op: "remove", line: line.id }); removed.push({ s: ls, e: le }); }
    else if (head && tail) { edits.push({ kind: "voiceover", op: "split", line: line.id, at: e, free: true } as CutEdit, { kind: "voiceover", op: "trim", line: line.id, edge: "end", to: s, free: true }); removed.push({ s, e }); }
    else if (head) { edits.push({ kind: "voiceover", op: "trim", line: line.id, edge: "end", to: s, free: true }); removed.push({ s, e: le }); }
    else { edits.push({ kind: "voiceover", op: "trim", line: line.id, edge: "start", to: e, free: true }); removed.push({ s: ls, e }); }
  }
  return { edits, removed };
}
/** VO7-13 Close gaps: the one Delete rule for voice, from the lane and the Text panel alike. `close` is the
 * Close gaps toggle (Shift+Delete passes its opposite). Selected pieces: closing removes them and slides
 * later voice left by their summed length (ripple), otherwise they leave a gap. A selected gap always
 * closes. A stretch of words (the Text panel) is cut out, and closing then slides the voice after it left
 * by the length of voice removed, so gaps already there stay. Null when there is nothing to delete. */
export type VoiceDeleteTarget = { lines: string[] } | { gap: { s: number; e: number } } | { range: { s: number; e: number } };
export function voiceDeleteEdit(lines: VoiceoverLine[], target: VoiceDeleteTarget, close: boolean): CutEdit | null {
  const asCut = (edit: VoiceEditOp) => edit as unknown as CutEdit;
  if ("gap" in target) return asCut({ kind: "voiceover", op: "ripple", gap: target.gap });
  if ("lines" in target) {
    const [line, ...rest] = target.lines;
    if (!line) return null;
    return asCut(close ? { kind: "voiceover", op: "ripple", lines: target.lines } : { kind: "voiceover", op: "remove", line, ...(rest.length ? { lines: target.lines } : {}) });
  }
  const { edits, removed } = cutVoiceRange(lines, target.range.s, target.range.e);
  if (!edits.length) return null;
  const total = removed.reduce((sum, r) => sum + r.e - r.s, 0), from = Math.min(...removed.map(r => r.s)), last = Math.max(...removed.map(r => r.e));
  // The cut leaves [from, last] empty; closing it by the voice removed keeps any gap that was inside it.
  if (close && total > 1e-6 && ordered(lines).some(l => voiceEnd(l) > last + 1e-6)) edits.push(asCut({ kind: "voiceover", op: "ripple", gap: { s: from, e: from + total } }));
  return edits.length === 1 ? edits[0] : { kind: "batch", edits, label: "Cut voiceover words" };
}

/** SCRIPT1: where a kept voice cut's first word would play now. The pieces left either side of it (the same take
 * and placement, meeting it in take time) say where; they move when the picture moves the voice. */
export function voiceCutAt(lines: VoiceoverLine[], cut: Pick<VoiceCut, "file" | "s" | "e" | "at" | "occurrence" | "closed">): number {
  const own = ordered(lines).filter(l => l.take!.file === cut.file && occurrenceOf(l) === cut.occurrence);
  const before = own.find(l => Math.abs(l.take!.e - cut.s) <= 1e-6), after = own.find(l => Math.abs(l.take!.s - cut.e) <= 1e-6);
  return before ? voiceEnd(before) : after ? (cut.closed ? after.s : after.s - (cut.e - cut.s)) : cut.at;
}
/** SCRIPT1: cut voice words and keep the cut, or put a kept cut back. Returns the lines and the version's cut list.
 * A cut is one record per piece it touched (take span, the reel time it played, its placement and the piece as it
 * was). Restoring every word of a cut gives the pieces back as they were; restoring part of one splits it, each
 * side staying listed. Later voice and later cuts move with Close gaps either way. */
export function applyVoiceCut(lines: VoiceoverLine[], cuts: VoiceCut[], edit: CutVoiceWordsEdit | RestoreVoiceCutEdit, takeOf: (file: string) => VoiceTake | undefined, id: () => string): { lines: VoiceoverLine[]; cuts: VoiceCut[] } {
  const all = ordered(lines);
  if (edit.op === "cutWords") {
    if (!Number.isFinite(edit.s) || !Number.isFinite(edit.e) || edit.e - edit.s <= 1e-6) throw new Error("Select voiceover words to cut.");
    const { edits, removed } = cutVoiceRange(all, edit.s, edit.e);
    if (!edits.length) throw new Error("Select voiceover words to cut.");
    const touched = all.filter(l => l.s < edit.e - 1e-6 && voiceEnd(l) > edit.s + 1e-6);
    let next = all;
    for (const change of edits) next = applyVoiceEdit(next, change as unknown as VoiceEditOp, takeOf, id);
    const made: VoiceCut[] = touched.flatMap((line, i) => {
      const r = removed[i]; if (!r || r.e - r.s <= 1e-6) return [];
      return [{ id: `vcut-${id()}`, file: line.take!.file, s: line.take!.s + r.s - line.s, e: line.take!.s + r.e - line.s, at: r.s, occurrence: occurrenceOf(line), lines: [line] }];
    });
    const total = removed.reduce((sum, r) => sum + r.e - r.s, 0), from = Math.min(...removed.map(r => r.s)), last = Math.max(...removed.map(r => r.e));
    let kept = cuts;
    if (edit.close && total > 1e-6) {
      if (next.some(l => l.s >= last - 1e-6)) next = ripple(next, { kind: "voiceover", op: "ripple", gap: { s: from, e: from + total } });
      // Cuts inside the closed stretch sit where it closed; later cuts move with the voice.
      let slid = 0;
      for (const c of made) { c.at -= slid; c.closed = true; slid += c.e - c.s; }
      kept = cuts.map(c => c.at >= last - 1e-6 ? { ...c, at: c.at - total } : c);
    }
    return { lines: next, cuts: [...kept, ...made].sort((a, b) => a.at - b.at) };
  }
  const cut = cuts.find(c => c.id === edit.cut);
  if (!cut) throw new Error("That cut is no longer listed. Open the edit again and try again.");
  const take = takeOf(cut.file), words = (take?.words ?? []).filter(w => w.s < cut.e && w.e > cut.s);
  let s = cut.s, e = cut.e;
  if (Number.isFinite(edit.s) && Number.isFinite(edit.e) && edit.e! > edit.s!) {
    const chosen = words.filter(w => w.s < edit.e! && w.e > edit.s!);
    // Every word chosen, or none measured: the whole cut. Otherwise its chosen words, out to the cut's own edges.
    if (chosen.length && chosen.length < words.length) {
      const first = words.indexOf(chosen[0]), last = words.indexOf(chosen.at(-1)!);
      s = first === 0 ? cut.s : Math.max(cut.s, chosen[0].s); e = last === words.length - 1 ? cut.e : Math.min(cut.e, chosen.at(-1)!.e);
    }
  }
  if (!(e - s > 1e-6)) throw new Error("Select cut voiceover words to restore.");
  const anchor = voiceCutAt(all, cut), length = e - s, where = cut.closed ? anchor : anchor + (s - cut.s);
  let next = all, rest = cuts.filter(c => c !== cut);
  if (cut.closed) {
    next = next.map(l => l.s >= where - 1e-6 ? slide(l, length) : l);
    rest = rest.map(c => c.at > where + 1e-6 ? { ...c, at: c.at + length } : c);
  }
  if (next.some(l => l.s < where + length - 1e-6 && voiceEnd(l) > where + 1e-6)) throw new Error("Other voice now plays there. Move it, then restore.");
  const fresh = id();
  let placed: VoiceoverLine = piece({ id: fresh, occurrence: cut.occurrence, text: "", s: where, e: where }, where, { file: cut.file, s, e }, take?.words ?? []);
  next = [...next, placed].sort((a, b) => a.s - b.s);
  // The restored words rejoin the piece they were cut from: a seamless neighbour from the same placement.
  const seamless = (a: VoiceoverLine, b: VoiceoverLine) => a.take!.file === b.take!.file && occurrenceOf(a) === occurrenceOf(b)
    && Math.abs(voiceEnd(a) - b.s) <= 1e-6 && Math.abs(a.take!.e - b.take!.s) <= 1e-6;
  const join = (a: VoiceoverLine, b: VoiceoverLine) => piece(a, a.s, { ...a.take!, e: b.take!.e }, take?.words ?? []);
  let at = next.indexOf(placed);
  if (at > 0 && seamless(next[at - 1], placed)) { placed = join(next[at - 1], placed); next.splice(at - 1, 2, placed); at--; }
  if (at + 1 < next.length && seamless(placed, next[at + 1])) { const after = next[at + 1]; placed = { ...join(placed, after), id: placed.id === fresh ? after.id : placed.id }; next.splice(at, 2, placed); }
  // The whole piece back as it was: the very line it was before the cut, script text, pause and all.
  const original = cut.lines?.find(l => l.take && l.take.file === placed.take!.file && Math.abs(l.take.s - placed.take!.s) <= 1e-6 && Math.abs(l.take.e - placed.take!.e) <= 1e-6 && Math.abs(l.s - placed.s) <= 1e-6);
  if (original) next[next.indexOf(placed)] = original;
  // What stays cut on either side, each still restorable.
  const left: VoiceCut[] = s - cut.s > 1e-6 ? [{ ...cut, id: `${cut.id}a`, e: s, at: anchor }] : [];
  const right: VoiceCut[] = cut.e - e > 1e-6 ? [{ ...cut, id: `${cut.id}b`, s: e, at: cut.closed ? where + length : anchor + (e - cut.s) }] : [];
  return { lines: next, cuts: [...rest, ...left, ...right].sort((a, b) => a.at - b.at) };
}

/** Returns the new placed lines, or throws a plain sentence. `id` names a new piece. */
export function applyVoiceEdit(lines: VoiceoverLine[], edit: VoiceEditOp, takeOf: (file: string) => VoiceTake | undefined, id: () => string): VoiceoverLine[] {
  if (edit.op === "placePlan") {
    const take = takeOf(edit.take);
    if (!take) throw new Error("Choose a saved voiceover take from this shoot.");
    const base = withoutReplaced(lines, edit.replace, edit.at);
    return placePlan(base.lines, take, edit.spans, base.at, id).lines;
  }
  if (edit.op === "placeAsIs") {
    const take = takeOf(edit.take);
    if (!take || !(take.durationS > 0)) throw new Error("Choose a saved voiceover take from this shoot.");
    const at = Math.max(0, Number.isFinite(edit.at) ? edit.at! : 0), fresh = id();
    return [piece({ id: fresh, occurrence: fresh, text: "", s: at, e: at }, at, { file: take.file, s: 0, e: take.durationS }, take.words)];
  }
  if (edit.op === "ripple") return ripple(lines, edit);
  // The live preview has no cut list to hand; the saved version keeps it (applyVoiceCut).
  if (edit.op === "cutWords") return applyVoiceCut(lines, [], edit, takeOf, id).lines;
  if (edit.op === "restoreCut") throw new Error("Restore saves first; it shows once saved.");
  const all = ordered(lines), index = all.findIndex(l => l.id === edit.line);
  if (index < 0) throw new Error("Choose a voice piece on the Voiceover lane.");
  const line = all[index], take = takeOf(line.take!.file), words = take?.words ?? [];
  const prevEnd = index ? all[index - 1].s + length(all[index - 1]) : 0, nextStart = all[index + 1]?.s ?? Infinity;
  const out = [...all];
  if (edit.op === "remove") {
    const ids = new Set([edit.line, ...((edit as RemoveVoiceEdit).lines ?? [])]);
    if ([...ids].some(id => !all.some(l => l.id === id))) throw new Error("Choose a voice piece on the Voiceover lane.");
    return all.filter(l => !ids.has(l.id));
  }
  if (edit.op === "duplicate") {
    // A copy of the piece just after it, when there is room before the next piece.
    const s = line.s + length(line);
    if (s + length(line) > nextStart + 1e-9) throw new Error("No room after this piece");
    const fresh = id();
    out.splice(index + 1, 0, { ...line, id: fresh, occurrence: fresh, s, e: s + length(line), pauseAfterS: undefined, pauseNote: undefined });
    return out;
  }
  if (edit.op === "move") {
    if (!Number.isFinite(edit.s)) throw new Error("Choose where to move the voice piece.");
    const ids = new Set([edit.line, ...((edit as MoveVoiceEdit).lines ?? [])]);
    if (ids.size > 1) {
      if ([...ids].some(id => !all.some(l => l.id === id))) throw new Error("Choose a voice piece on the Voiceover lane.");
      // Every moved piece is bounded by its nearest unselected neighbours (and 0:00); the group takes the tightest.
      let low = -Infinity, high = Infinity;
      all.forEach((l, i) => {
        if (!ids.has(l.id)) return;
        let p = i - 1; while (p >= 0 && ids.has(all[p].id)) p--;
        let n = i + 1; while (n < all.length && ids.has(all[n].id)) n++;
        low = Math.max(low, (p >= 0 ? voiceEnd(all[p]) : 0) - l.s);
        high = Math.min(high, (n < all.length ? all[n].s : Infinity) - voiceEnd(l));
      });
      const delta = low > high + 1e-9 ? 0 : Math.max(low, Math.min(high, edit.s - line.s));
      return all.map(l => ids.has(l.id) ? { ...l, s: l.s + delta, e: l.s + delta + length(l), pauseAfterS: undefined, pauseNote: undefined } : l);
    }
    const s = Math.max(prevEnd, Math.min(nextStart - length(line), edit.s));
    out[index] = { ...line, s, e: s + length(line), pauseAfterS: undefined, pauseNote: undefined };
    return out;
  }
  if (edit.op === "split") {
    let src = line.take!.s + (edit.at - line.s);
    const word = (edit as SplitVoiceEdit).free ? undefined : words.find(w => w.s < src && w.e > src);
    if (word) src = src - word.s <= word.e - src ? word.s : word.e;
    if (!(src > line.take!.s + MIN && src < line.take!.e - MIN)) throw new Error("Move the playhead inside the voice piece to split it.");
    // Both halves keep the piece's occurrence: their captions are the same placement's words.
    const occurrence = occurrenceOf(line);
    out.splice(index, 1, piece({ ...line, occurrence }, line.s, { ...line.take!, e: src }, words), piece({ ...line, id: id(), occurrence }, line.s + src - line.take!.s, { ...line.take!, s: src }, words));
    return out;
  }
  if (edit.op === "trim") {
    if (!Number.isFinite(edit.to) || (edit.edge !== "start" && edit.edge !== "end")) throw new Error("Choose a voice piece edge to trim.");
    const t = line.take!, duration = take?.durationS ?? t.e;
    if (edit.edge === "start") {
      // The edge can go back as far as the recording starts and the piece before ends.
      const low = Math.max(0, t.s - (line.s - prevEnd)), high = t.e - MIN, want = t.s + edit.to - line.s;
      const src = edit.free ? Math.max(low, Math.min(high, want)) : nearest(words.map(w => w.s), want, low, high);
      out[index] = piece(line, line.s + src - t.s, { ...t, s: src }, words);
    } else {
      const low = t.s + MIN, high = Math.min(duration, t.e + (nextStart - (line.s + length(line)))), want = t.s + edit.to - line.s;
      const src = edit.free ? Math.max(low, Math.min(high, want)) : nearest(words.map(w => w.e), want, low, high);
      out[index] = piece(line, line.s, { ...t, e: src }, words);
    }
    return out;
  }
  throw new Error("Choose a voiceover edit.");
}
