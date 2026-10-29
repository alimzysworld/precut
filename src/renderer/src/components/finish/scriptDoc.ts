// SCRIPT1: the Script panel's document. Camera speech and placed voiceover, in edit order, as paragraphs of words.
// Cut words stay in it, struck, where they were (camera cuts, whole cut pieces, voiceover cuts), so the person can
// see and restore them. B-roll that no one speaks over is one quiet line. Pure: no DOM, no React.
import type { AudioFile, CutVersion, Shoot, VoiceCut, VoiceoverLine, VoiceoverScript, Word } from "../../../../shared/schema";
import { stretchedVoiceLines, voiceAddedOf, voiceCorrectionsOf, voiceTakeWords, voiceTranscript } from "../../../../shared/caption-words";
import { transcriptText } from "../../../../main/titles/text";
import { voiceCutAt } from "../../../../shared/voice-edit";
import { transcriptPieces } from "./TranscriptPanel";
import { tombIndex } from "./transcriptEdits";

export type ScriptWord = {
  key: string;
  kind: "camera" | "voice";
  text: string;            // shown (his spelling)
  spoken: string;          // as transcribed
  cut: boolean;            // cut from the edit: struck, restorable
  hidden?: boolean;        // voice: left out of captions by his typing (still heard)
  start: number; end: number;  // reel seconds; a cut word sits at its spot with no length
  block: number;
  // camera
  piece?: number;          // live piece index in version.pieces
  tomb?: string;           // cut piece id (version.cutPieces)
  clipId?: string;
  s?: number; e?: number;  // clip seconds
  marker?: { s: number; e: number; kind: string };  // the removal it belongs to (cut words)
  // voice
  id?: string; occurrence?: string; line?: string; file?: string; sourceS?: number; sourceE?: number;
  added?: boolean; voiceCut?: string;
};
export type ScriptBlock = {
  key: string;
  kind: "camera" | "voice" | "broll" | "draft";
  label: string;
  start: number; end: number;
  words: number[];
  piece?: number; tomb?: string; clipId?: string;
  lines?: string[];        // voice: placed line ids heard in this paragraph
  draft?: VoiceoverLine;   // a script line not recorded yet
  fallback?: string;       // camera: what was said, when there are no timed words
  changed?: boolean;       // wording changed beyond spelling (audio unchanged)
  suspect?: string[];      // voice: pieces that may play words the transcript lacks (Listen again finds them)
};
export type ScriptDoc = { words: ScriptWord[]; blocks: ScriptBlock[] };

const letters = (value: string) => value.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prior = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prior + (a[i - 1] === b[j - 1] ? 0 : 1)); prior = keep; }
  }
  return row[b.length];
}
/** True when `after` respells `before` (same number of words, each a close spelling); false when the wording changed. */
export function spellingOnly(before: string, after: string): boolean {
  const a = before.trim().split(/\s+/u).filter(Boolean), b = after.trim().split(/\s+/u).filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((word, i) => { const x = letters(word), y = letters(b[i]); return x === y || distance(x, y) <= Math.max(1, Math.floor(Math.max(x.length, y.length) / 3)); });
}
const clipName = (shoot: Shoot, clipId: string) => (shoot.clips.find(c => c.id === clipId)?.file ?? "").split("/").pop()?.replace(/\.[^.]+$/u, "") ?? "";
const sentenceEnd = (text: string) => /[.!?…]["”’)]*$/u.test(text.trim());
const seconds = (value: number) => `${Math.round(value * 10) / 10} s`;

export function buildScript(shoot: Shoot, version: CutVersion, options: { takes?: AudioFile[]; script?: VoiceoverScript | null; changedCamera?: Set<string>; range?: { s: number; e: number } } = {}): ScriptDoc {
  const words: ScriptWord[] = [], blocks: ScriptBlock[] = [];
  type Draft = Omit<ScriptBlock, "words" | "key"> & { items: Omit<ScriptWord, "block">[] };
  const drafts: Draft[] = [];
  // Camera speech: every live piece's words, with what was cut from it struck in place.
  for (const piece of transcriptPieces(shoot, version)) {
    const items = piece.displayWords.map((word, w) => ({
      key: `c:${piece.pieceIndex}:${word.s}:${w}`, kind: "camera" as const, text: transcriptText([word.w]) || "…", spoken: word.w, cut: !!word.removed,
      start: word.start, end: word.end, piece: piece.pieceIndex, clipId: piece.clipId, s: word.s, e: word.e,
      marker: word.removed ? { s: word.removed.s, e: word.removed.e, kind: word.removed.kind } : undefined,
    }));
    // A cut word sits where the speech before it ends, so clicking it goes there.
    let spot = piece.start;
    for (const item of items) { if (item.cut) { item.start = item.end = spot; } else spot = item.end; }
    const fallback = items.length ? undefined : transcriptText([piece.words ?? ""]);
    drafts.push({ kind: "camera", label: clipName(shoot, piece.clipId) || "Camera", start: piece.start, end: piece.end, piece: piece.pieceIndex, clipId: piece.clipId, items, fallback });
  }
  // Whole pieces whose every word was cut, struck, where they sat.
  const live = version.pieces ?? [];
  for (const tomb of version.cutPieces ?? []) {
    const at = tombIndex(tomb, live), spot = live[at]?.timelineS ?? version.lengthS ?? 0, piece = tomb.piece;
    const removed = [...(piece.removed ?? [])].sort((a, b) => a.s - b.s);
    const source = shoot.clips.find(c => c.id === piece.clipId)?.transcript?.flatMap(s => s.words) ?? [];
    const own = source.filter(w => w.e > piece.s && w.s < piece.e || removed.some(g => g.kind !== "pause" && w.s < g.e && w.e > g.s));
    const items = own.map((word, w) => {
      const marker = removed.find(g => g.kind !== "pause" && word.s < g.e && word.e > g.s) ?? removed.find(g => g.kind === "cut") ?? removed[0];
      return { key: `t:${tomb.id}:${word.s}:${w}`, kind: "camera" as const, text: transcriptText([word.w]) || "…", spoken: word.w, cut: true, start: spot, end: spot,
        tomb: tomb.id, clipId: piece.clipId, s: word.s, e: word.e, marker: marker ? { s: marker.s, e: marker.e, kind: marker.kind } : undefined };
    });
    if (items.length) drafts.push({ kind: "camera", label: clipName(shoot, piece.clipId) || "Camera", start: spot, end: spot, tomb: tomb.id, clipId: piece.clipId, items });
  }
  // Voiceover: what is heard, then what was cut from it, at the reel time it played.
  const takes = new Map((options.takes ?? shoot.audio ?? []).filter(a => a.role === "voiceover").map(a => [a.file, a]));
  const lines = version.voiceover?.lines ?? [];
  const heard = voiceTranscript(lines, file => takes.get(file), version.titles);
  const stretched = new Set(stretchedVoiceLines(lines, file => takes.get(file), version.titles));
  const corrections = voiceCorrectionsOf(version.titles), added = voiceAddedOf(version.titles);
  type Voice = Omit<ScriptWord, "block">;
  const voice: Voice[] = heard.map((w, i) => ({ key: `v:${w.occurrence}:${w.id}:${i}`, kind: "voice", text: w.hidden ? w.spoken : w.text, spoken: w.spoken, cut: false, hidden: w.hidden,
    start: w.s, end: w.e, id: w.id, occurrence: w.occurrence, line: w.line, file: w.file, sourceS: w.sourceS, sourceE: w.sourceE, added: w.added }));
  for (const cut of (version.voiceCuts ?? []) as VoiceCut[]) {
    const take = takes.get(cut.file); if (!take) continue;
    const spot = voiceCutAt(lines, cut);
    for (const { word, id } of voiceTakeWords(take, added)) {
      if (!word.w.trim() || word.e <= cut.s + 1e-6 || word.s >= cut.e - 1e-6) continue;
      const fix = corrections[id], spoken = transcriptText([word.w]), at = cut.closed ? spot : spot + Math.max(0, word.s - cut.s);
      voice.push({ key: `x:${cut.id}:${id}`, kind: "voice", text: fix && fix.was === spoken && fix.text ? fix.text : spoken, spoken, cut: true, start: at, end: at,
        id, occurrence: cut.occurrence, file: cut.file, sourceS: Math.max(word.s, cut.s), sourceE: Math.min(word.e, cut.e), voiceCut: cut.id });
    }
  }
  voice.sort((a, b) => a.start - b.start || (a.sourceS ?? 0) - (b.sourceS ?? 0));
  // Paragraphs break where he paused after a sentence, where the lane has a gap, or at another placement.
  let open: Draft | null = null, prior: Voice | null = null;
  for (const word of voice) {
    const gap = prior ? word.start - prior.end : Infinity;
    const breaks = !open || !prior || word.occurrence !== prior.occurrence && !word.cut && !prior.cut || !word.cut && !prior.cut && (gap > 0.6 || gap > 0.3 && sentenceEnd(prior.text));
    if (breaks) { open = { kind: "voice", label: "Voiceover", start: word.start, end: word.end, items: [], lines: [] }; drafts.push(open); }
    open!.items.push(word); open!.end = Math.max(open!.end, word.end);
    if (word.line && !open!.lines!.includes(word.line)) open!.lines!.push(word.line);
    prior = word;
  }
  // Script lines not recorded yet, where no voice plays.
  for (const line of options.script?.lines ?? []) {
    if (line.take || !line.text.trim()) continue;
    if (voice.some(w => !w.cut && w.start < line.e && w.end > line.s)) continue;
    drafts.push({ kind: "draft", label: "Voiceover · not recorded yet", start: line.s, end: line.e, draft: line, items: [] });
  }
  // B-roll no one speaks over: one quiet line per stretch.
  const spoken = drafts.flatMap(d => d.items).filter(w => !w.cut && w.end > w.start);
  let quiet: Draft | null = null;
  const brolls = live.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === "broll").sort((a, b) => a.p.timelineS - b.p.timelineS);
  for (const { p } of brolls) {
    const s = p.timelineS, e = p.timelineS + p.lengthS;
    if (spoken.some(w => w.start < e - 1e-6 && w.end > s + 1e-6)) { quiet = null; continue; }
    const name = p.description?.trim() || "cutaway";
    if (quiet && Math.abs(quiet.end - s) < 0.05) { quiet.end = e; if (!quiet.fallback!.split(", ").includes(name)) quiet.fallback += `, ${name}`; }
    else { quiet = { kind: "broll", label: "B-roll", start: s, end: e, items: [], fallback: name }; drafts.push(quiet); }
  }
  for (const d of drafts) if (d.kind === "broll") d.label = `B-roll · ${seconds(d.end - d.start)} · ${d.fallback}`;
  const inRange = (d: Draft) => !options.range || d.items.some(w => w.start < options.range!.e && w.end > options.range!.s || w.cut && w.start >= options.range!.s && w.start <= options.range!.e);
  const order = { camera: 0, voice: 1, draft: 2, broll: 3 } as const;
  const sorted = drafts.filter(d => d.kind !== "broll" && d.kind !== "draft" || !options.range).filter(inRange)
    .sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]);
  for (const d of sorted) {
    const index = blocks.length, items = options.range ? d.items.filter(w => w.start < options.range!.e && w.end > options.range!.s || w.cut && w.start >= options.range!.s && w.start <= options.range!.e) : d.items;
    const first = words.length;
    for (const item of items) words.push({ ...item, block: index });
    const ids = items.map((_, k) => first + k);
    const changed = d.kind === "voice" ? items.some(w => w.added || w.hidden || !w.cut && w.text !== w.spoken && !spellingOnly(w.spoken, w.text))
      : d.kind === "camera" ? items.some(w => options.changedCamera?.has(`${w.clipId}:${w.s}`)) : false;
    const suspect = d.kind === "voice" ? (d.lines ?? []).filter(id => stretched.has(id)) : [];
    blocks.push({ ...d, ...(suspect.length ? { suspect } : {}), key: `${d.kind}:${d.piece ?? d.tomb ?? d.draft?.id ?? ""}:${d.start}:${index}`, words: ids, changed } as ScriptBlock);
    delete (blocks[index] as ScriptBlock & { items?: unknown }).items;
  }
  return { words, blocks };
}

/** The live words a range of the document covers, by index. */
export const liveIn = (doc: ScriptDoc, from: number, to: number) => doc.words.slice(from, to + 1).map((w, k) => ({ w, i: from + k })).filter(({ w }) => !w.cut);
/** The reel time a word index plays at (a cut word: its spot). */
export const timeOf = (doc: ScriptDoc, index: number) => doc.words[index]?.start ?? 0;
/** Seconds of take a voice cut's chosen words cover, for Restore. */
export function takeSpan(words: ScriptWord[]): { s: number; e: number } | null {
  const list = words.filter(w => Number.isFinite(w.sourceS) && Number.isFinite(w.sourceE));
  return list.length ? { s: Math.min(...list.map(w => w.sourceS!)), e: Math.max(...list.map(w => w.sourceE!)) } : null;
}
export type { Word };
