import type { TitleCue } from "../../shared/schema";
import type { CaptionWord, KineticLine } from "./captions";

/** Opening caption styles (25 Oct). Each style is a layout plus a motion recipe (entrance, emphasis on the punch
 * word, exit), drawn by the one title renderer (template.html, OPENING_STYLES) live and in export.
 * The model decides the phrases, where lines break, the punch word, the accent words and how long the opening
 * runs. The engine guarantees what would be broken if wrong: spoken order top to bottom, no overlap, nothing off
 * frame or under the safe area, a readable minimum size, and no phrase shown before its first word is spoken.
 * A new style plugs in here (its brief for the model) and in template.html (its recipe); the engine is shared. */
export const OPENING_STYLES = ["build-up"] as const;
export type OpeningStyle = typeof OPENING_STYLES[number];
export const DEFAULT_OPENING_STYLE: OpeningStyle = "build-up";
export const OPENING_ROLES = ["punch", "phrase", "connector", "payoff"] as const;
export type OpeningRole = typeof OPENING_ROLES[number];
// edges: the spans (reel seconds) where the footage behind the opening is too bright or busy for its text, measured
// by main (titles.ts openingEdges); the renderer gives the text the Outline option's solid black edge there.
export type OpeningEdge = { s: number; e: number };
export type OpeningCue = TitleCue & { opening: { style: OpeningStyle; role: OpeningRole; edges?: OpeningEdge[] } };
export const isOpeningStyle = (value: unknown): value is OpeningStyle => OPENING_STYLES.includes(value as OpeningStyle);
export const isOpeningCue = (cue: TitleCue): cue is OpeningCue => !!(cue as Partial<OpeningCue>).opening && isOpeningStyle((cue as OpeningCue).opening.style);

/** What the title designer is told about each style. Judgement stays with the model; sizes and places do not. */
export const OPENING_STYLE_BRIEFS: Record<OpeningStyle, string> = {
  "build-up": "Build up: one screen that fills in as the opening is spoken, always reading top to bottom in spoken order. "
    + "Each phrase appears when its first word is spoken and pops in; the newest phrase leads at full colour while earlier ones dim. "
    + "Break the opening where a good editor would: where the meaning turns or the speaker breathes, usually 2 to 5 short phrases. "
    + "Give each phrase a role: punch (the word or two the viewer must feel, drawn biggest; normally one), phrase (an ordinary phrase), "
    + "connector (small glue words between ideas, drawn smallest) or payoff (the closing phrase that lands the line). "
    + "Accent the punch word and the payoff's last word, or whatever words carry the line.",
};

// Weights per role; sizes per role belong to the style's recipe in template.html.
const WEIGHT: Record<OpeningRole, 800 | 900> = { punch: 900, phrase: 800, connector: 800, payoff: 900 };
// Nominal cap height (fraction of frame height) for code that reads cue.size; the renderer sizes by role.
const NOMINAL: Record<OpeningRole, number> = { punch: .07, phrase: .052, connector: .039, payoff: .06 };

type PhraseWord = Pick<CaptionWord, "text" | "s" | "e"> & { accent?: boolean };
type RawPhrase = { role?: unknown; from?: unknown; to?: unknown; accents?: unknown; words?: unknown };
type RawOpening = { style?: unknown; reason?: unknown; hook?: unknown; phrases: unknown };
const same = (a: { s: number; e: number }, b: { s: number; e: number }) => Math.abs(a.s - b.s) < 1e-6 && Math.abs(a.e - b.e) < 1e-6;

/** A phrase's words: measured word indices (from inclusive, to exclusive) or already resolved measured words. */
function phraseWords(phrase: RawPhrase, measured: CaptionWord[]): PhraseWord[] {
  if (Array.isArray(phrase.words)) return (phrase.words as PhraseWord[]).filter(w => w && Number.isFinite(w.s) && Number.isFinite(w.e));
  const { from, to } = phrase;
  if (!Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (to as number) <= (from as number) || (to as number) > measured.length) return [];
  const accents = Array.isArray(phrase.accents) ? phrase.accents : [];
  return measured.slice(from as number, to as number).map((w, i) => ({ text: w.text, s: w.s, e: w.e, accent: accents.includes((from as number) + i) }));
}

/** The model's opening (phrases with roles and accents) as a kinetic line the renderer draws. Code fixes order
 * and coverage without touching the wording: phrases are re-stacked by their first spoken word, and every
 * measured word of the line belongs to exactly one phrase (a word the answer skipped joins the phrase before it). */
export function openingLine(raw: RawOpening, measured: CaptionWord[]): KineticLine {
  if (!Array.isArray(raw.phrases) || !raw.phrases.length) throw new Error("The opening needs phrases.");
  const style = isOpeningStyle(raw.style) ? raw.style : DEFAULT_OPENING_STYLE;
  const phrases = (raw.phrases as RawPhrase[]).filter(p => p && typeof p === "object").map(p => {
    const words = phraseWords(p, measured).filter(w => measured.some(m => same(m, w)));
    return { role: (OPENING_ROLES as readonly unknown[]).includes(p.role) ? p.role as OpeningRole : "phrase" as OpeningRole, words };
  }).filter(p => p.words.length);
  if (!phrases.length) throw new Error("The opening's phrases name no measured words.");
  const s = Math.min(...phrases.flatMap(p => p.words.map(w => w.s))), e = Math.max(...phrases.flatMap(p => p.words.map(w => w.e)));
  const spoken = measured.filter(w => w.s >= s - 1e-7 && w.e <= e + 1e-7).sort((a, b) => a.s - b.s);
  // Spoken order: a phrase starts at its earliest word; two phrases starting together are one.
  const starts = [...new Map(phrases.map(p => [Math.min(...p.words.map(w => w.s)), p] as const)).entries()].sort((a, b) => a[0] - b[0]);
  const accented = phrases.flatMap(p => p.words.filter(w => w.accent));
  const cues = starts.map(([start, phrase], i) => {
    const next = starts[i + 1]?.[0] ?? Infinity;
    const words = spoken.filter(w => w.s >= start - 1e-7 && w.s < next - 1e-7).map(w => ({ text: w.text, s: w.s, e: w.e, accent: accented.some(a => same(a, w)) }));
    return { phrase, words };
  }).filter(c => c.words.length).map(({ phrase, words }, i): OpeningCue => ({
    id: `opening-${i}`, role: "title", s: words[0].s, e, text: words.map(w => w.text).join(" "), words,
    layer: "front", x: .5, y: .5, align: "center", size: NOMINAL[phrase.role], weight: WEIGHT[phrase.role], italic: true,
    color: "#ffffff", accent: "#F7C204", enter: "none", exit: "none", opening: { style, role: phrase.role } }));
  return { s: spoken[0]?.s ?? s, e, hook: raw.hook !== false, reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason : "The opening line", style, cues };
}

/** Lines in a model or first-cut answer that use an opening style's phrases become drawn kinetic lines. */
export function resolveOpeningLines<T>(lines: T[], measured: CaptionWord[]): (T | KineticLine)[] {
  return lines.map(line => line && typeof line === "object" && Array.isArray((line as unknown as RawOpening).phrases) ? openingLine(line as unknown as RawOpening, measured) : line);
}
