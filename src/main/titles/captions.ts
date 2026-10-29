export { timedCaptionWords } from "../../shared/caption-words";
import type { CaptionStyle, CutVersion, Preferences, Shoot, TitleCue, TitleTrack } from "../../shared/schema";
import { transcriptGroups, transcriptText } from "./text";
import { isOpeningStyle } from "./opening";

export const CAPTION_FONTS = ["Outfit", "Inter Display", "Montserrat", "Poppins", "Bebas Neue", "Archivo Black", "Caveat"] as const;
const base: CaptionStyle = { preset: "clean", primary: "#ffffff", accent: "#F7C204", font: "Inter Display", size: "m", position: "bottom", wordsPerLine: "3-4", case: "as-spoken", background: "none", outline: false, animation: "none", emphasis: false, hook: "auto" };
export const CAPTION_PRESETS: { name: string; style: CaptionStyle }[] = [
  { name: "Clean", style: base },
  { name: "Karaoke", style: { ...base, preset: "karaoke", font: "Poppins", animation: "karaoke" } },
  { name: "Box", style: { ...base, preset: "box", font: "Montserrat", animation: "box-highlight" } },
  { name: "Impact", style: { ...base, preset: "impact", font: "Bebas Neue", size: "l", case: "upper", wordsPerLine: "1-2", animation: "pop" } },
  { name: "Punch", style: { ...base, preset: "punch", font: "Archivo Black", wordsPerLine: "1-2", outline: true, animation: "typewriter", emphasis: true } },
  { name: "Glide", style: { ...base, preset: "glide", font: "Montserrat", animation: "glide" } },
  { name: "Pulse", style: { ...base, preset: "pulse", font: "Outfit", animation: "pulse", emphasis: true } },
  { name: "Typewriter", style: { ...base, preset: "typewriter", animation: "typewriter" } },
  { name: "Handwritten", style: { ...base, preset: "handwritten", font: "Caveat", size: "l", animation: "glide" } },
  { name: "Bubble", style: { ...base, preset: "bubble", font: "Poppins", background: "pill", animation: "pop" } },
  { name: "Minimal", style: { ...base, preset: "minimal", size: "s", wordsPerLine: "line" } },
  { name: "Lower third", style: { ...base, preset: "lower-third", font: "Montserrat", wordsPerLine: "line" } },
];
export const DEFAULT_CAPTION_STYLE = base;
/** VO7-15: a font family name that is safe inside a quoted CSS or canvas font string. Any family on this Mac
 * can style captions; one that is missing where it is drawn falls back to Inter Display (template.html). */
export function isFontFamilyName(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && /^[^"'\\;{}<>\u0000-\u001f\u007f]{1,100}$/.test(value);
}
export function isCaptionStyle(value: unknown): value is CaptionStyle {
  if (!value || typeof value !== "object") return false;
  const v = value as CaptionStyle;
  return [...CAPTION_PRESETS.map(p => p.style.preset), "custom"].includes(v.preset) &&
    /^#[0-9a-f]{6}$/i.test(v.primary) && /^#[0-9a-f]{6}$/i.test(v.accent) && isFontFamilyName(v.font) &&
    ["s", "m", "l"].includes(v.size) && ["bottom", "middle", "top"].includes(v.position) &&
    ["1-2", "3-4", "line"].includes(v.wordsPerLine) && ["as-spoken", "upper", "lower"].includes(v.case) &&
    ["none", "box", "pill"].includes(v.background) && typeof v.outline === "boolean" && typeof v.emphasis === "boolean" &&
    ["none", "pop", "glide", "karaoke", "box-highlight", "typewriter", "pulse"].includes(v.animation) &&
    (v.hook === undefined || ["auto", "off", "all"].includes(v.hook)) && (v.hookStyle === undefined || isOpeningStyle(v.hookStyle));
}
export type CaptionWord = { text: string; s: number; e: number; piece?: number; accent?: boolean; estimated?: boolean };
export type CaptionSource = { words: CaptionWord[]; safeArea: CaptionSafeArea; faces: { s: number; e: number; box: CaptionSafeArea }[] };
// Private finishing metadata travels with the track; the shared schema stays owned by Claude.
// style: an opening caption style (opening.ts); absent = the model placed each cue itself (designs before 25 Oct).
export type KineticLine = { s: number; e: number; hook: boolean; reason: string; style?: import("./opening").OpeningStyle; edges?: import("./opening").OpeningEdge[]; cues: TitleCue[];
  rebuilt?: boolean };  // CAP1: an opening rebuilt from the first spoken words after an edit, without the designer
export type KineticDesign = { font: string; lines: KineticLine[] };
export type PersonMatte = { s: number; e: number; fps: number; frames: string[] };
export type CaptionTrack = TitleTrack & { captionWordsEdited?: boolean; speechOnsets?: number[]; captionSource?: CaptionSource; kinetic?: KineticDesign; personMattes?: PersonMatte[] };
export type CaptionSafeArea = { left: number; right: number; top: number; bottom: number };
export function captionSafeArea(platform: Preferences["captions"]["safeArea"] = "reels"): CaptionSafeArea {
  return { left: platform === "none" ? .03 : .06, right: platform === "tiktok" ? .82 : platform === "shorts" ? .84 : .94,
    top: .08, bottom: platform === "tiktok" ? .75 : platform === "shorts" ? .78 : platform === "none" ? .92 : .8 };
}
/** Stable zero-based measured word indices, never model-invented text. */
export function validateEmphasis(value: unknown, words: CaptionWord[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !/^(0|[1-9]\d*)$/.test(id) || Number(id) >= words.length)) throw new Error("Emphasis must contain only supplied measured word indices.");
  return [...new Set(value)] as string[];
}
type IdentifiedWord = { s: number; e: number; takeWord?: string; occurrence?: string | number };
/** Accented old words carry over: voice words by identity (they move with their piece), others by time. */
export function carryEmphasis<W extends IdentifiedWord>(accented: W[], words: W[]): string[] {
  const same = (a: W, b: W) => !!a.takeWord && a.takeWord === b.takeWord && a.occurrence === b.occurrence;
  // Overlap beyond float noise: a shared boundary is not an overlap, or emphasis spreads to a neighbour on every save.
  return words.flatMap((w, i) => accented.some(old => old.takeWord ? same(old, w) : !w.takeWord && old.s < w.e - 1e-6 && old.e > w.s + 1e-6) ? [String(i)] : []);
}
/** 0.7.1: a saved track's key words, as indices into `words`. Emphasis indexes the track's own caption words; when the
 * words have changed since (a picture edit moved the voice, a word was cut) the accented words carry over by take-word
 * id or time, and an index past the words is dropped. Saved data never throws here. */
export function followEmphasis(previous: TitleTrack | null | undefined, words: CaptionWord[]): string[] | undefined {
  const ids = previous?.emphasis, old = (previous as CaptionTrack | null | undefined)?.captionSource?.words;
  if (!Array.isArray(ids)) return ids;
  const changed = !!old && (old.length !== words.length || old.some((w, i) => w.text !== words[i].text || Math.abs(w.s - words[i].s) > 1e-6 || Math.abs(w.e - words[i].e) > 1e-6));
  if (changed) return carryEmphasis(ids.flatMap(id => old![Number(id)] ? [old![Number(id)] as CaptionWord & IdentifiedWord] : []), words as (CaptionWord & IdentifiedWord)[]);
  return keptEmphasis(ids, words);
}
const keptEmphasis = (ids: unknown[], words: CaptionWord[]) => [...new Set(ids.filter((id): id is string => typeof id === "string" && /^(0|[1-9]\d*)$/.test(id) && Number(id) < words.length))];
export function buildCaptionTrack(words: CaptionWord[], previous: TitleTrack | null | undefined, style: CaptionStyle,
  safe: CaptionSafeArea = captionSafeArea(), bigLines: CutVersion["bigLines"] = []): CaptionTrack {
  if (!isCaptionStyle(style)) throw new Error("Choose a valid bundled caption style.");
  // 0.7.1: saved key words past the words given are dropped, never thrown on (callers carry them with followEmphasis).
  const emphasis = Array.isArray(previous?.emphasis) ? keptEmphasis(previous!.emphasis, words) : [];
  const titles = previous?.cues.filter(c => c.role === "title" && !c.id.startsWith("kinetic-")) ?? [];
  const used = new Set(titles.map(c => c.id));
  const cues: TitleCue[] = [];
  const transform = (text: string) => style.case === "upper" ? text.toUpperCase() : style.case === "lower" ? text.toLowerCase() : text;
  const max = style.wordsPerLine === "1-2" ? 2 : style.wordsPerLine === "3-4" ? 4 : Infinity;
  let phrase: (CaptionWord & { indices: number[] })[] = [], end = 0;
  const flush = () => {
    if (!phrase.length) return;
    const size = { s: .024, m: .034, l: .046 }[style.size];
    const y = style.position === "top" ? safe.top + size * 1.5 : style.position === "middle" ? (safe.top + safe.bottom) / 2 : safe.bottom - size * 1.5;
    let id = `caption-${cues.length}`;
    while (used.has(id)) id += "-c";
    used.add(id);
    cues.push({ id, role: "subtitle", layer: "front", s: phrase[0].s, e: end,
      text: transcriptText(phrase.map(w => transform(w.text))), words: phrase.map(w => ({ text: w.text, s: w.s, e: w.e, estimated: w.estimated, accent: w.accent ?? (style.emphasis && w.indices.some(index => emphasis.includes(String(index)))) })),
      x: style.preset === "lower-third" ? safe.left + .02 : (safe.left + safe.right) / 2, y,
      align: style.preset === "lower-third" ? "left" : "center", size, weight: style.font === "Caveat" ? 700 : style.preset === "minimal" ? 600 : 800, italic: false,
      color: style.primary, accent: style.accent, enter: style.animation === "pop" ? "pop" : style.animation === "glide" ? "slide-up" : "none", exit: "none" });
    phrase = []; end = 0;
  };
  transcriptGroups(words.map((word, index) => ({ ...word, index })), word => word.text, (a, b) => a.piece === b.piece).forEach(({ text, tokens }) => {
    const word = { ...tokens[0], text, s: Math.min(...tokens.map(w => w.s)), e: Math.max(...tokens.map(w => w.e)), indices: tokens.map(w => w.index) };
    const last = phrase.at(-1);
    if (last && word.s >= end && (phrase.length >= max || phrase.map(w => w.text).join(" ").length + word.text.length + 1 > 32 ||
      word.s - last.e >= .35 || word.piece !== last.piece || /[.!?,;:]["'’”)]?$/u.test(last.text))) flush();
    phrase.push(word); end = Math.max(end, word.e);
  });
  flush();
  const kinetic = (previous as CaptionTrack | undefined)?.kinetic;
  const selected = (kinetic?.lines ?? []).filter(line => {
    const authored = line.cues.flatMap(c => c.words ?? []);
    // Within a microsecond: retiming the timeline maps times through float arithmetic, and an exact match
    // dropped the opening caption after any later save.
    if (!authored.length || authored.some(w => !words.some(actual => Math.abs(actual.s - w.s) < 1e-6 && Math.abs(actual.e - w.e) < 1e-6 && actual.text.toLowerCase() === w.text.toLowerCase()))) return false;
    if (style.hook === "off") return false;
    const override = bigLines.find(item => Math.abs(item.s - line.s) < 1e-7);
    return override ? override.big : style.hook === "all" || line.hook;
  });
  const normal: TitleCue[] = [];
  // Split at design boundaries, including boundaries within a normal phrase.
  // Every measured word belongs to exactly one normal or kinetic line.
  for (const cue of cues) {
    let run: NonNullable<TitleCue["words"]> = [];
    const flushRun = () => {
      if (run.length) normal.push({ ...cue, id: `${cue.id}-${normal.length}`, s: run[0].s, e: Math.max(...run.map(w => w.e)), text: transcriptText(run.map(w => transform(w.text))), words: run });
      run = [];
    };
    for (const word of cue.words ?? []) {
      if (selected.some(line => word.s >= line.s - 1e-7 && word.e <= line.e + 1e-7)) flushRun();
      else run.push(word);
    }
    flushRun();
  }
  // Case applies to every caption word, the opening caption included; the renderer matches words to text ignoring case.
  const big = selected.flatMap((line, i) => line.cues.map((cue, j) => ({ ...cue, id: `kinetic-${i}-${j}`, text: style.case === "as-spoken" ? cue.text : transform(cue.text), color: style.primary, accent: style.accent,
    // An opening's measured edge spans travel with each of its phrases to the renderer.
    ...((cue as import("./opening").OpeningCue).opening ? { opening: { ...(cue as import("./opening").OpeningCue).opening, edges: line.edges ?? [] } } : {}) })));
  return { ...previous, font: kinetic?.font ?? previous?.font ?? "Outfit", prompt: previous?.prompt ?? null, skillIds: previous?.skillIds ?? [],
    captionStyle: { ...style }, captionSource: { words, safeArea: safe, faces: (previous as CaptionTrack | undefined)?.captionSource?.faces ?? [] }, emphasis: previous?.emphasis === undefined ? undefined : emphasis, cues: [...titles, ...big, ...normal].sort((a, b) => a.s - b.s) };
}
/** Existing cues retain cut-local measurements; legacy cuts fall back to surviving transcript spans. */
export function captionWordsForVersion(shoot: Shoot, version: CutVersion): CaptionWord[] {
  const source = (version.titles as CaptionTrack | undefined)?.captionSource?.words;
  if (source?.length) return source;
  const timed = version.titles?.cues.filter(c => c.role === "subtitle").flatMap(c => c.words ?? []);
  if (timed?.length) return timed.map(w => ({ ...w, piece: version.pieces?.findIndex(p => w.s >= p.timelineS && w.s < p.timelineS + p.lengthS) }));
  const words: CaptionWord[] = [];
  version.pieces?.forEach((piece, index) => {
    if (piece.kind !== "voice") return;
    const transcript = shoot.clips.find(c => c.id === piece.clipId)?.transcript?.flatMap(s => s.words) ?? [];
    const removed = [...(piece.removed ?? [])].sort((a, b) => a.s - b.s);
    let cursor = piece.s;
    const spans: { s: number; e: number }[] = [];
    for (const f of removed) { if (f.s > cursor) spans.push({ s: cursor, e: Math.min(f.s, piece.e) }); cursor = Math.max(cursor, Math.min(f.e, piece.e)); }
    if (cursor < piece.e) spans.push({ s: cursor, e: piece.e });
    const total = spans.reduce((n, s) => n + s.e - s.s, 0);
    let at = piece.timelineS;
    const mapped = new Map<string, CaptionWord>();
    for (const span of spans) {
      const ratio = piece.lengthS / total;
      for (const w of transcript.filter(w => w.e > span.s && w.s < span.e)) {
        const key = JSON.stringify(w), existing = mapped.get(key);
        const next = { text: w.w, s: at + (Math.max(w.s, span.s) - span.s) * ratio, e: at + (Math.min(w.e, span.e) - span.s) * ratio, piece: index };
        if (existing) existing.e = next.e; else mapped.set(key, next);
      }
      at += (span.e - span.s) * ratio;
    }
    words.push(...mapped.values());
  });
  return words.sort((a, b) => a.s - b.s);
}

/** Timeline edits keep authored choices attached to speech. Cached live mattes
 * contain the old timeline and are invalidated; front is the honest fallback. */
export function retimeKinetic(record: CutVersion, time: (t: number) => number) {
  if (record.bigLines) record.bigLines = record.bigLines.map(l => ({ ...l, s: time(l.s) }));
  const prior = record.titles as CaptionTrack | null | undefined;
  if (!prior?.kinetic || prior.kinetic.lines.every(l => time(l.s) === l.s && time(l.e) === l.e && l.cues.every(c => (c.words ?? []).every(w => time(w.s) === w.s && time(w.e) === w.e)))) return;
  const track: CaptionTrack = { ...prior };
  record.titles = track;
  const cue = (c: TitleCue): TitleCue => ({ ...c, s: time(c.s), e: time(c.e), layer: "front", words: c.words?.map(w => ({ ...w, s: time(w.s), e: time(w.e) })) });
  track.kinetic = { ...prior.kinetic, lines: prior.kinetic.lines.map(l => ({ ...l, s: time(l.s), e: time(l.e), ...(l.edges ? { edges: l.edges.map(x => ({ s: time(x.s), e: time(x.e) })) } : {}), cues: l.cues.map(cue) })) };
  track.personMattes = [];
  track.cues = track.cues.map(c => c.id.startsWith("kinetic-") ? { ...c, layer: "front" } : c);
}

/** Editor interchange carries separate title and person layers. Keep its title
 * asset unmasked and move only this cue's display/word clock to local zero. */
export function editorTitleTrack(track: TitleTrack, cue: TitleCue): CaptionTrack {
  return { ...track, personMattes: undefined, cues: [{ ...cue, s: 0, e: cue.e - cue.s,
    words: cue.words?.map(w => ({ ...w, s: w.s - cue.s, e: w.e - cue.s })) }] };
}
