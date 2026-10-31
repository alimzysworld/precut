import { createHash } from "node:crypto";
import type { MotionGraphic } from "../../shared/schema";
import { CARD_MEDIA, CARD_MEDIA_SRC, CARD_TEMPLATE } from "./templates";

// GFX1: everything a graphic is allowed to contain. The sandbox (CSP, no network, no storage, no real clocks, a
// frame budget) is the real wall; these checks turn the common mistakes into plain, fixable messages before any
// frame is drawn, and keep sizes small enough that a graphic can never slow an edit down.
export const GRAPHIC_LIMITS = { html: 60_000, css: 60_000, js: 40_000, total: 140_000, words: 120, durationS: 60, minPx: 16, maxPx: 4096 };

export class GraphicError extends Error {}
const fail = (message: string): never => { throw new GraphicError(message); };

// PRO4b: only a screen-card may name a picture by media handle (templates.ts CARD_MEDIA), and its html shows it in
// exactly one place. The graphic's frame still loads nothing: the title page fetches that one file from the shoot cache
// and puts it into the frame as a data image.
const dataImage = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/** CSS escapes and comments can hide a word from a plain search; check what the browser would read. */
function plainCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16)) || 32)).replace(/\\(.)/g, "$1");
}

function checkUrls(source: string, where: string): void {
  for (const match of source.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
    const target = match[2].trim();
    if (!(target.startsWith("#") || dataImage.test(target))) fail(`${where} can only use images that are part of the graphic (data images) or #ids. Remove the link "${target.slice(0, 40)}".`);
  }
}

function checkHtml(html: string): void {
  if (/<\s*\/?\s*(script|style|iframe|frame|frameset|object|embed|link|meta|base|form|input|button|textarea|select|audio|video|source|track|portal|template|slot|dialog|applet|noscript)\b/i.test(html))
    fail("The html can't contain script, style, link, frame, form or media tags. Put styles in css and code in js.");
  if (/\son[a-z]+\s*=/i.test(html)) fail("The html can't have on... event attributes. Animate from time in css or js.");
  if (/javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|srcdoc\s*=/i.test(html)) fail("The html can't contain scripts in links.");
  for (const match of html.matchAll(/\s(?:src|href|xlink:href|poster|action|formaction|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!(target.startsWith("#") || dataImage.test(target))) fail(`The html can't load "${target.slice(0, 40)}". Images must be data images inside the graphic.`);
  }
  if (/(?:https?:)?\/\/[a-z0-9-]+\.[a-z]{2,}/i.test(html.replace(/xmlns(?::\w+)?\s*=\s*"[^"]*"/gi, ""))) fail("The html can't point to the internet.");
  checkUrls(html, "The html");
  for (const match of html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) checkCss(match[1] ?? match[2] ?? "");
}

function checkCss(css: string): void {
  const plain = plainCss(css);
  if (/@import|@font-face|@namespace|@charset/i.test(plain)) fail("The css can't import or define fonts. Use the bundled fonts: Outfit, Inter Display, Montserrat, Poppins, Bebas Neue, Archivo Black or Caveat.");
  if (/expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:/i.test(plain)) fail("The css can't contain scripts.");
  if (/<\s*\/?\s*[a-z!]/i.test(plain)) fail("The css can't contain tags.");
  checkUrls(plain, "The css");
}

// Plain mistakes with plain advice. A determined author could still dodge a text check; the sandbox does not care.
const banned: [RegExp, string][] = [
  [/\beval\b|\bnew\s+Function\b|\bFunction\s*\(|\.constructor\s*\(|\bimport\s*[(\s{*]|\bimportScripts\b/, "The js can't build code from text or import files."],
  [/\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bWorker\b|\bSharedWorker\b|\bServiceWorker\b|\bBroadcastChannel\b/, "The js can't use the network or workers."],
  [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bdocument\s*\.\s*cookie\b|\bcaches\b/, "The js can't use storage."],
  [/\bsetTimeout\b|\bsetInterval\b|\brequestIdleCallback\b/, "The js can't use timers. Everything is a function of t: render(t, el)."],
  [/\bpostMessage\b|\bwindow\s*\.\s*(?:parent|top|opener|frames|open)\b|\bparent\s*\.|\btop\s*\.|\bopener\b|\blocation\b|\bdocument\s*\.\s*(?:write|writeln|domain)\b|\bhistory\b|\bnavigator\b/, "The js can't reach outside its own graphic."],
  [/\bDate\b|\bperformance\b|\brequestAnimationFrame\b|\bMath\s*\.\s*random\b/, "The js can't use real clocks or randomness. Use t, or a fixed pattern."],
];
function checkJs(js: string): void {
  if (/<\/script|<!--/i.test(js)) fail("The js can't contain script tags.");
  // Words inside text strings ("our location") are fine; only code is checked.
  const code = js.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '""');
  for (const [pattern, message] of banned) if (pattern.test(code)) fail(message);
  if (!/\bfunction\s+render\b|\b(?:const|let|var)\s+render\b|\bwindow\s*\.\s*render\s*=/.test(code)) fail("The js must define render(t, el), called with the seconds since the graphic began.");
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Returns a clean copy, or throws a GraphicError whose message can be shown to the person (or sent back to the agent). */
export function sanitizeGraphic(input: unknown): MotionGraphic {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("A graphic needs html, css and a duration.");
  const g = input as Record<string, unknown>;
  for (const key of ["html", "css"] as const) if (typeof g[key] !== "string") fail(`A graphic needs ${key}.`);
  if (g.js !== undefined && g.js !== null && typeof g.js !== "string") fail("The js must be text.");
  const html = g.html as string, css = g.css as string, js = (g.js as string | undefined | null) || undefined;
  if (!html.trim()) fail("The graphic has no html.");
  if (html.length > GRAPHIC_LIMITS.html || css.length > GRAPHIC_LIMITS.css || (js?.length ?? 0) > GRAPHIC_LIMITS.js || html.length + css.length + (js?.length ?? 0) > GRAPHIC_LIMITS.total)
    fail("That graphic is too big. Keep it under about 140 KB in total, with images small.");
  for (const key of ["widthPx", "heightPx"] as const) {
    const value = g[key];
    if (!finite(value) || !Number.isInteger(value) || value < GRAPHIC_LIMITS.minPx || value > GRAPHIC_LIMITS.maxPx) fail(`${key} must be a whole number of pixels from ${GRAPHIC_LIMITS.minPx} to ${GRAPHIC_LIMITS.maxPx}.`);
  }
  if (!finite(g.durationS) || g.durationS < 0.2 || g.durationS > GRAPHIC_LIMITS.durationS) fail(`durationS must be from 0.2 to ${GRAPHIC_LIMITS.durationS} seconds.`);
  if (g.frame !== "overlay" && g.frame !== "full") fail('frame must be "overlay" or "full".');
  if (g.layer !== undefined && g.layer !== "front" && g.layer !== "behind") fail('layer must be "front" or "behind".');
  if (g.layer === "behind" && g.frame === "full") fail("A full-frame graphic replaces the picture, so it can't sit behind the person.");
  checkHtml(html); checkCss(css); if (js) checkJs(js);
  const out: MotionGraphic = { html, css, widthPx: g.widthPx as number, heightPx: g.heightPx as number, durationS: Math.round((g.durationS as number) * 1000) / 1000, frame: g.frame as MotionGraphic["frame"] };
  if (js) out.js = js;
  if (g.layer) out.layer = g.layer as "front" | "behind";
  if (g.template !== undefined && g.template !== null) {
    if (typeof g.template !== "string" || !/^[a-z0-9-]{1,40}$/.test(g.template)) fail("The template name is not valid.");
    out.template = g.template as string;
  }
  if (g.media !== undefined && g.media !== null) {
    if (out.template !== CARD_TEMPLATE || typeof g.media !== "string" || !CARD_MEDIA.test(g.media)) fail("Only a card made by add_card can show a picture from the shoot.");
    if (html.split(`src="${CARD_MEDIA_SRC}"`).length !== 2) fail("A card shows its picture once.");
    out.media = g.media as string;
  }
  if (g.words !== undefined && g.words !== null) {
    if (!Array.isArray(g.words) || g.words.length > GRAPHIC_LIMITS.words) fail("The words list is too long.");
    out.words = (g.words as unknown[]).map(word => {
      const w = word as { text?: unknown; atS?: unknown };
      if (typeof w?.text !== "string" || !w.text.trim() || w.text.length > 80 || !finite(w.atS) || w.atS < 0) return fail("Each word needs its text and a time in seconds.");
      return { text: w.text, atS: w.atS };
    });
  }
  return out;
}

/** What makes two graphics render identically (words and the template name only matter for re-timing). */
export function graphicKey(g: MotionGraphic): string {
  return createHash("sha256").update(JSON.stringify([g.html, g.css, g.js ?? "", g.widthPx, g.heightPx, g.durationS, g.frame, g.layer ?? "front", ...(g.media ? [g.media] : [])])).digest("hex");
}
