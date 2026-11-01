// TASTE1: one text layer at a time. The title page (live, Apple and export) and the export's frame keys (titles/render.ts)
// read these spans, so captions step aside on the same frames everywhere. Pure: no node, no DOM.
//   - a full-screen scene takes the captions' place for its span (SCN1b), unless its captions param is "stay";
//   - a word scene (beat words, title slam) whose first word sits in a caption line takes their place from the start of
//     that line when it starts at most WORD_SCENE_LEAD_S before the cut, so the line never shows the words about to slam;
//   - a key word (behind or in front) takes their place for its own span.
// Captions come back on the first frame after. His words are untouched: only drawing skips them.
// A key word or a pinned item sits on the picture, so a full-screen graphic (which replaces the picture) hides it.

export type AsideSpan = [number, number];
type GraphicLike = { frame?: string; html?: string; template?: string; words?: { text: string; atS: number }[] | null };
type ItemLike = { s: number; e: number; graphic?: GraphicLike | null; pinKeys?: unknown; pin?: unknown };
type CueLike = { id: string; s: number; e: number; role?: string; text?: string; words?: { text: string; s: number; e?: number }[] | null; opening?: unknown };

export const WORD_SCENE_LEAD_S = 1.5;
const WORD_SCENES = /data-gfx-template="(scene-beat-words|scene-title-slam)"/;
const norm = (t: string) => t.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]/gu, "");
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** SCN1b: a full-screen scene whose captions step aside (template.html had the same test). */
export const isSceneAside = (item: ItemLike | null | undefined): boolean => !!item?.graphic && item.graphic.frame === "full"
  && /data-gfx-template="scene-/.test(item.graphic.html ?? "") && !/&quot;captions&quot;:&quot;stay&quot;/.test(item.graphic.html ?? "");
export const isKeyWord = (item: ItemLike | null | undefined): boolean => !!item?.graphic && item.graphic.template === "key-word" && item.graphic.frame !== "full";
/** Caption cues that step aside: captions, kinetic captions and opening styles (designed titles stay). */
export const stepsAside = (cue: CueLike): boolean => cue.role === "subtitle" || cue.id.startsWith("kinetic-") || !!cue.opening;
/** An item drawn on the picture that a full-screen graphic hides: a key word, or anything pinned to a thing in the shot. */
export const onPicture = (item: ItemLike | null | undefined): boolean => !!item && (!!item.pinKeys || !!item.pin || isKeyWord(item));
/** Spans where a full-screen graphic replaces the picture. */
export const fullSpans = (overlays: readonly ItemLike[] | null | undefined): AsideSpan[] =>
  (overlays ?? []).filter(o => o.graphic?.frame === "full" && o.e > o.s).map(o => [o.s, o.e]);
export const hiddenUnderFull = (item: ItemLike, t: number, spans: readonly AsideSpan[]): boolean => onPicture(item) && spans.some(([s, e]) => t >= s && t < e);

/** The first word a word scene shows, from its params (his words, as add_scene placed them). */
function sceneFirstWords(html: string): string[] {
  const raw = /data-gfx-params="([^"]*)"/.exec(html)?.[1];
  if (!raw) return [];
  try {
    const p = JSON.parse(unescape(raw)) as { words?: unknown; line1?: unknown; line2?: unknown };
    const first = Array.isArray(p.words) ? p.words[0] : (typeof p.line1 === "string" && p.line1.trim() ? p.line1 : p.line2);
    return typeof first === "string" ? first.split(/\s+/).map(norm).filter(Boolean) : [];
  } catch { return []; }
}

/** When the scene's first word is said: a cutaway keeps it on the graphic (graphic.words); otherwise (a pause) it is the
 * caption words that spell the scene's first element, nearest before the cut. Null when it can't be found. */
function firstWordAt(item: ItemLike, words: { text: string; s: number }[]): number | null {
  const given = item.graphic?.words?.[0]?.atS;
  if (typeof given === "number" && Number.isFinite(given)) return given;
  const tokens = sceneFirstWords(item.graphic?.html ?? "");
  if (!tokens.length) return null;
  const found: number[] = [];
  for (let i = 0; i + tokens.length <= words.length; i++) {
    const at = words[i].s;
    if (at >= item.s - 8 && at < item.e && tokens.every((t, j) => norm(words[i + j].text) === t)) found.push(at);
  }
  // Nearest before the cut (the line that would repeat it), else the first inside the scene.
  const before = found.filter(at => at <= item.s + 1e-3);
  return before.length ? Math.max(...before) : found.length ? Math.min(...found) : null;
}

/** Where captions step aside: [start, end) spans in reel seconds, merged. */
export function captionAsides(cues: readonly CueLike[] | null | undefined, overlays: readonly ItemLike[] | null | undefined): AsideSpan[] {
  const lines = (cues ?? []).filter(stepsAside);
  let words: { text: string; s: number }[] | null = null;
  const spans: AsideSpan[] = [];
  for (const item of overlays ?? []) {
    if (!(item.e > item.s)) continue;
    if (isKeyWord(item)) { spans.push([item.s, item.e]); continue; }
    if (!isSceneAside(item)) continue;
    let start = item.s;
    if (WORD_SCENES.test(item.graphic!.html ?? "")) {
      words ??= lines.flatMap(c => c.words?.length ? c.words.map(w => ({ text: w.text, s: w.s })) : []).sort((a, b) => a.s - b.s);
      const at = firstWordAt(item, words);
      if (at !== null) {
        const line = Math.min(...lines.filter(c => c.s <= at + 1e-3 && at < c.e).map(c => c.s));
        if (line < item.s && item.s - line <= WORD_SCENE_LEAD_S + 1e-6) start = line;
      }
    }
    spans.push([start, item.e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: AsideSpan[] = [];
  for (const span of spans) { const last = merged.at(-1); if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
  return merged;
}
export const asideAt = (spans: readonly AsideSpan[] | null | undefined, t: number): boolean => !!spans?.some(([s, e]) => t >= s && t < e);
