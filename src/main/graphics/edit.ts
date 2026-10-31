import type { MotionGraphic, OverlayItem, Template, TitleTrack } from "../../shared/schema";
import { buildFromTemplate, graphicSource, type GraphicTheme } from "./templates";
import { GraphicError, sanitizeGraphic } from "./sanitize";

// GFX1: how graphics join an edit. A graphic is an overlay whose picture is drawn by the sandboxed renderer; the
// rest (versions, undo, handles, the list in Clips) is the overlay machinery that already exists.

/** The edit's own look for a new graphic: its caption font and accent. */
export function graphicTheme(titles: TitleTrack | null | undefined): Partial<GraphicTheme> {
  const style = titles?.captionStyle;
  return { font: style?.font ?? titles?.font, accent: style?.accent, ink: style?.primary };
}

/** Sanitise, check that every sampled frame draws within its budget, and make the picture used in lists and handles. */
export async function prepareGraphic(root: string, input: unknown): Promise<{ graphic: MotionGraphic; file: string }> {
  const graphic = sanitizeGraphic(input);
  // PRO4b: a card's picture must be in this shoot's own card cache (add_card put it there).
  if (graphic.media && !await (await import("node:fs")).promises.stat((await import("node:path")).join(root, ".sidething", "overlays", graphic.media)).then(s => s.isFile() && s.size > 0, () => false))
    throw new GraphicError("That card's picture isn't in this shoot. Make the card again with add_card.");
  const { vetGraphic, graphicPoster } = await import("./render");
  await vetGraphic(graphic);
  return { graphic, file: await graphicPoster(root, graphic) };
}

/** A starter's graphic, or the person's own composition, ready to be an overlay. */
export function graphicFromRequest(request: { template?: string; params?: Record<string, unknown>; composition?: Partial<MotionGraphic> & Record<string, unknown>; durationS?: number; layer?: "front" | "behind"; words?: MotionGraphic["words"] },
  theme: Partial<GraphicTheme>): MotionGraphic {
  if (!!request.template === !!request.composition) throw new GraphicError("Give either a template with params, or a composition with html, css and js.");
  // PRO4b: a picture from the shoot comes only through add_card, never in a hand-written composition.
  if (request.composition && (request.composition.media !== undefined || request.composition.template === "screen-card")) throw new GraphicError("Cards are made with add_card (a real picture from the shoot, a stamp in the person's own words).");
  if (request.template) return buildFromTemplate(request.template, request.params ?? {}, theme, { durationS: request.durationS, layer: request.layer, words: request.words });
  const composition = { ...request.composition!, ...(request.durationS !== undefined ? { durationS: request.durationS } : {}), ...(request.layer ? { layer: request.layer } : {}), ...(request.words ? { words: request.words } : {}) };
  return sanitizeGraphic(composition);
}

/** Where a new graphic sits by default: wide strips nearly full width, cards and icons smaller, taller frames wider. */
export function defaultPlacement(graphic: MotionGraphic, frame: { width: number; height: number }): { x: number; y: number; w: number } {
  if (graphic.frame === "full") return { x: 0.5, y: 0.5, w: 1 };
  const portrait = frame.width < frame.height, aspect = graphic.widthPx / graphic.heightPx;
  const base = aspect >= 2.6 ? 0.82 : aspect >= 1.6 ? 0.62 : aspect >= 1.1 ? 0.5 : 0.34;
  return { x: 0.5, y: 0.5, w: portrait ? Math.min(0.92, base * 1.45) : base };
}

/** When the person changes how long a starter is on screen, rebuild it to that length (so its exit lands on the last frame). */
export function fitGraphicToSpan(graphic: MotionGraphic, durationS: number): MotionGraphic {
  if (Math.abs(graphic.durationS - durationS) < 0.05) return graphic;
  const source = graphicSource(graphic);
  if (!source) return graphic;
  return buildFromTemplate(source.template, source.params, source.theme, { durationS, layer: graphic.layer, words: graphic.words });
}

// ---- keeping a graphic on its words when the cut changes

const normal = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export type TimedWord = { text: string; s: number; e: number };

/** The reel second where the cue's words are spoken now, nearest to where they were; null when they are gone from the cut. */
function find(cue: { text: string; atS: number }, words: TimedWord[]): number | null {
  const tokens = cue.text.split(/\s+/).map(normal).filter(Boolean);
  if (!tokens.length) return null;
  let best: number | null = null;
  for (let i = 0; i + tokens.length <= words.length; i++) {
    if (!tokens.every((token, j) => normal(words[i + j].text) === token)) continue;
    if (best === null || Math.abs(words[i].s - cue.atS) < Math.abs(best - cue.atS)) best = words[i].s;
  }
  return best;
}

/** Slides the graphic so its first findable cue lands where that word is spoken now, keeping its lead and length. */
export function retimeToWords(item: OverlayItem, words: TimedWord[], durationS: number): OverlayItem {
  const cues = item.graphic?.words;
  if (!cues?.length || !words.length) return item;
  const found = cues.map(cue => find(cue, words));
  const first = found.findIndex(at => at !== null);
  if (first < 0) return item;
  const length = item.e - item.s;
  const shift = found[first]! - cues[first].atS;
  if (Math.abs(shift) < 1e-6) return item;
  const s = Math.max(0, Math.min(Math.max(0, durationS - length), item.s + shift));
  const moved = s - item.s;
  return { ...item, s, e: s + length, graphic: { ...item.graphic!, words: cues.map((cue, i) => ({ ...cue, atS: found[i] ?? cue.atS + moved })) } };
}

/** Re-time every word-synced graphic of a version that has just been recut. Other overlays are left as they are. */
export async function retimeGraphicOverlays(record: { overlays?: OverlayItem[]; assembly: { shoot: import("../../shared/schema").Shoot; template: Template; cutList: import("../export").CutItem[] }; lengthS: number }): Promise<OverlayItem[] | undefined> {
  const items = record.overlays;
  if (!items?.some(item => item.graphic?.words?.length)) return items;
  const { buildTitlesInput, captionSourceForInput } = await import("../titles");
  const { getPreferences } = await import("../settings");
  const preferences = await getPreferences();
  const { shoot, template, cutList } = record.assembly;
  const input = buildTitlesInput(shoot, record as never, template, cutList, preferences.captions.safeArea, preferences.output.height, false);
  const words = captionSourceForInput(input).words;
  return items.map(item => retimeToWords(item, words, record.lengthS));
}

export { sanitizeGraphic, GraphicError };
