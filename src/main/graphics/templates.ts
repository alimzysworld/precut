import type { MotionGraphic } from "../../shared/schema";
import { iconSvg, ICON_NAMES } from "./icons";

// GFX1: the starter graphics, in sidething's indie style: one type family, generous space, one accent, short
// ease-out moves and no bouncing. Each starter is plain html + css (+ a few lines of js where a number has to
// count). Everything is a function of time, so a frame is the same live, scrubbed and exported.
export interface GraphicTheme { font: string; accent: string; ink: string; tone?: "dark" | "light" }
export const DEFAULT_THEME: GraphicTheme = { font: "Outfit", accent: "#5b8cff", ink: "#ffffff", tone: "dark" };

export interface TemplateParam { name: string; label: string; type: "text" | "number" | "list" | "data" | "choice" | "image"; default: unknown; options?: string[] }
export interface TemplateInfo {
  id: string; name: string; kind: string; about: string;
  frame: "overlay" | "full"; widthPx: number; heightPx: number; durationS: number; params: TemplateParam[];
}
type Params = Record<string, unknown>;
// A starter may size its own frame from its params (a card takes its picture's shape).
type Built = { html: string; css: string; js?: string; size?: { widthPx: number; heightPx: number }; media?: string };
// hidden: made only by its own tool (add_card), never offered as a starter, so its checks can't be skipped.
interface Template extends TemplateInfo { hidden?: boolean; build(p: Params, theme: GraphicTheme, durationS: number): Built }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const colour = (value: unknown, fallback: string) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const str = (p: Params, key: string, fallback: string, max = 120) => typeof p[key] === "string" && (p[key] as string).trim() ? (p[key] as string).trim().slice(0, max) : fallback;
const num = (p: Params, key: string, fallback: number, lo = -1e9, hi = 1e9) => typeof p[key] === "number" && Number.isFinite(p[key]) ? clamp(p[key] as number, lo, hi) : fallback;
const pick = (p: Params, key: string, options: string[], fallback: string) => options.includes(p[key] as string) ? p[key] as string : fallback;
function list(p: Params, key: string, fallback: string[], max = 6, each = 60): string[] {
  const raw = p[key];
  const items = Array.isArray(raw) ? raw.map(x => typeof x === "string" ? x : typeof (x as { title?: unknown })?.title === "string" ? (x as { title: string }).title : "")
    : typeof raw === "string" ? raw.split(/\n|;/) : [];
  const clean = items.map(s => s.trim().slice(0, each)).filter(Boolean).slice(0, max);
  return clean.length ? clean : fallback;
}
function data(p: Params, fallback: [string, number][], max = 8): [string, number][] {
  const raw = p.data;
  const rows = Array.isArray(raw) ? raw.flatMap((row): [string, number][] => {
    const r = row as { label?: unknown; value?: unknown } | unknown[];
    const label = Array.isArray(r) ? r[0] : r?.label, value = Array.isArray(r) ? r[1] : r?.value;
    return (typeof label === "string" || typeof label === "number") && typeof value === "number" && Number.isFinite(value) ? [[String(label).slice(0, 16), value]] : [];
  }) : [];
  return (rows.length >= 2 ? rows : fallback).slice(0, max);
}
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

// ---- PRO4: the card's numbers, shared with add_card and the director.
export const CARD_TEMPLATE = "screen-card";
/** The picture lives once in the html (the <img>); its params carry this marker instead, and graphicSource puts it back.
 * PRO4b: a card made now carries no picture at all: its params and the graphic name the picture's media handle in the
 * shoot's own cache (CARD_MEDIA), and the title page puts that one picture in when it draws the card. Old cards keep
 * their inline picture. */
const CARD_IMAGE_REF = "@shot";
// PRO4b: a card made by add_card names its picture by a media handle instead of carrying it: a content-named file in
// that shoot's own cache (<root>/.sidething/overlays/card-<hash>.webp). The name is the whole handle (no path, no
// scheme) and the html shows it in exactly one place; the title page draws that one file in (sanitize.ts checks it).
export const CARD_MEDIA = /^card-[a-f0-9]{32}\.webp$/;
export const CARD_MEDIA_SRC = "#card-media";
const CARD_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export const CARD_MOTION = {
  side: 1400,                                                   // the card's longer side in design px
  springDamping: 24, springStiffness: 340, springMass: 0.45,    // the launch video's SNAP (ActThree.tsx)
  tilt: { x: 16, y: 11, scale: 0.1, drop: 0.05 },               // degrees about x and y, scale and drop (of its height) it settles from
  holdS: 0.42,                                                  // flat and still before the push starts
  pushMax: 1.5,                                                 // the push never goes further in than this
  popS: 4 / 30, popFrom: 1.4,                                   // the stamp: 1.4 to 1 over 4 frames at 30 fps (kit.tsx ClipTile)
  exitS: 0.3,                                                   // an eased exit; a cut exit has none
  imageChars: 56_000,                                           // an old card's inline picture, inside the 60 KB html a graphic may have
  pictureSide: 4096,                                            // PRO4b: a card's picture (a media handle) at full resolution, up to this side
  stampWords: 4, stampChars: 28,
} as const;
/** x, y, w, h as fractions, kept inside the picture; null when it isn't a box. */
export function cardBox(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(n => typeof n === "number" && Number.isFinite(n))) return null;
  const x = clamp(v[0], 0, 0.995), y = clamp(v[1], 0, 0.995);
  return [x, y, clamp(v[2], 0.005, 1 - x), clamp(v[3], 0.005, 1 - y)].map(n => Math.round(n * 10000) / 10000) as [number, number, number, number];
}
/** The stamp as it is shown: one short line in sentence case (its words are checked against what he says by add_card). */
export function cardStamp(v: unknown): string {
  const text = typeof v === "string" ? v.replace(/\s+/g, " ").trim().replace(/^["'“‘]+|["'”’.,;:!?]+$/g, "") : "";
  if (!text) return "";
  const short = text.split(" ").slice(0, CARD_MOTION.stampWords).join(" ").slice(0, CARD_MOTION.stampChars);
  return /^[a-z][^A-Z]/.test(short) || /^[a-z]$/.test(short) ? short[0].toUpperCase() + short.slice(1) : short;
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The css every starter shares: tokens from the edit's look, the exit fade, and the few moves the starters reuse. */
function base(theme: GraphicTheme, durationS: number, lines = true): string {   // lines: the line-drawing moves icons and charts use
  const light = theme.tone === "light";
  const surface = light ? "#f6f4ef" : "#15151b", on = light ? "#15151b" : "#ffffff", muted = light ? "rgba(21,21,27,.62)" : "rgba(255,255,255,.64)", line = light ? "rgba(21,21,27,.14)" : "rgba(255,255,255,.16)";
  const family = `"${theme.font}","Outfit","Inter Display",sans-serif`;
  return `:root{--font:${family};--accent:${theme.accent};--ink:${theme.ink};--surface:${surface};--on:${on};--muted:${muted};--line:${line};--d:${fmt(durationS)}s;--ease:cubic-bezier(.16,1,.3,1)}`
    + `#gfx{font-family:var(--font);color:var(--on);-webkit-font-smoothing:antialiased}`
    + `.root{position:absolute;inset:0;animation:out .35s cubic-bezier(.4,0,1,1) calc(var(--d) - .35s) both}`
    + `@keyframes out{from{opacity:1}to{opacity:0}}`
    + `@keyframes rise{from{opacity:0;transform:translateY(calc(var(--u)*3))}to{opacity:1;transform:none}}`
    + `@keyframes pop{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}`
    + `@keyframes fade{from{opacity:0}to{opacity:1}}`
    + (lines ? `@keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}` : "")
    + `@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}`
    + `@keyframes sweep{from{transform:scaleX(0)}to{transform:scaleX(1)}}`
    + (lines ? `.stroke{stroke-dasharray:1;stroke-dashoffset:1;animation:draw .8s var(--ease) calc(var(--at,0s) + var(--i,0)*.18s) both}` : "");
}
const wrap = (id: string, params: Params, inner: string) => `<div class="root" data-gfx-template="${id}" data-gfx-params="${esc(JSON.stringify(params))}">${inner}</div>`;

const TEMPLATES: Template[] = [
  {
    id: "title-pop", name: "Title pop", kind: "text", about: "A short headline that settles in, with an optional small line above.",
    frame: "overlay", widthPx: 1280, heightPx: 420, durationS: 3,
    params: [{ name: "text", label: "Headline", type: "text", default: "Ship it on Friday" }, { name: "kicker", label: "Small line above", type: "text", default: "" }],
    build(p, theme, d) {
      const text = str(p, "text", "Ship it on Friday", 80), kicker = str(p, "kicker", "", 40);
      const fs = clamp(Math.min(210, 1180 / (text.length * 0.5)), 56, 210);
      return { html: wrap("title-pop", p, `<div class="c">${kicker ? `<p class="k">${esc(kicker)}</p>` : ""}<h1>${esc(text)}</h1><i class="bar"></i></div>`),
        css: `${base(theme, d)}.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 5%}`
          + `h1{margin:0;font-weight:800;font-size:${Math.round(fs)}px;line-height:1.02;letter-spacing:-.02em;color:var(--ink);text-wrap:balance;text-shadow:0 2px 18px rgba(0,0,0,.28);animation:pop .7s var(--ease) .1s both}`
          + `.k{margin:0 0 18px;font-weight:600;font-size:34px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);animation:rise .6s var(--ease) both}`
          + `.bar{display:block;margin-top:26px;width:120px;height:8px;border-radius:4px;background:var(--accent);transform-origin:left;animation:sweep .7s var(--ease) .45s both}` };
    },
  },
  {
    id: "title-slide", name: "Title slide", kind: "text", about: "Lines of text that slide up out of a mask, one after another.",
    frame: "overlay", widthPx: 1280, heightPx: 480, durationS: 3.4,
    params: [{ name: "lines", label: "Lines (up to 4)", type: "list", default: ["Three things", "I got wrong"] }],
    build(p, theme, d) {
      const lines = list(p, "lines", ["Three things", "I got wrong"], 4, 40);
      const longest = Math.max(...lines.map(l => l.length)), fs = clamp(Math.min(1180 / (longest * 0.52), 400 / lines.length / 1.15), 48, 190);
      return { html: wrap("title-slide", p, `<div class="c">${lines.map((l, i) => `<div class="l"><span style="--i:${i}">${esc(l)}</span></div>`).join("")}</div>`),
        css: `${base(theme, d)}.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;padding:0 7%}`
          + `.l{overflow:hidden;padding:.06em 0}.l span{display:block;font-weight:800;font-size:${Math.round(fs)}px;line-height:1.08;letter-spacing:-.02em;color:var(--ink);text-shadow:0 2px 18px rgba(0,0,0,.28);animation:up .8s var(--ease) calc(.1s + var(--i)*.14s) both}`
          + `.l:last-child span{color:var(--accent)}@keyframes up{from{transform:translateY(105%)}to{transform:none}}` };
    },
  },
  {
    id: "words-reveal", name: "Words reveal", kind: "text", about: "A sentence that appears word by word. Put *stars* around words to colour them.",
    frame: "overlay", widthPx: 1280, heightPx: 420, durationS: 4,
    params: [{ name: "text", label: "Sentence", type: "text", default: "Make *one* thing people want" }, { name: "stepS", label: "Seconds per word", type: "number", default: 0.28 }],
    build(p, theme, d) {
      const text = str(p, "text", "Make *one* thing people want", 140), step = num(p, "stepS", 0.28, 0.08, 1);
      const words = text.split(/\s+/).map(w => ({ accent: /^\*.*\*[.,!?]*$/.test(w), text: w.replace(/\*/g, "") })).slice(0, 24);
      const fs = clamp(Math.sqrt((1180 * 330) / (text.length * 0.55 * 1.2)), 52, 150);
      return { html: wrap("words-reveal", p, `<p class="c">${words.map((w, i) => `<span class="${w.accent ? "a" : ""}" style="--i:${i}">${esc(w.text)}</span>`).join(" ")}</p>`),
        css: `${base(theme, d)}.c{position:absolute;inset:0;margin:0;display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:0 .28em;padding:0 6%;text-align:center;font-weight:800;font-size:${Math.round(fs)}px;line-height:1.14;letter-spacing:-.015em;color:var(--ink);text-shadow:0 2px 18px rgba(0,0,0,.28)}`
          + `.c span{display:inline-block;animation:rise .55s var(--ease) calc(.12s + var(--i)*${fmt(step)}s) both}.c .a{color:var(--accent)}` };
    },
  },
  {
    id: "counter", name: "Counter", kind: "number", about: "A number that counts up (or down) to its value, with a label.",
    frame: "overlay", widthPx: 960, heightPx: 480, durationS: 3.5,
    params: [{ name: "from", label: "From", type: "number", default: 10 }, { name: "to", label: "To", type: "number", default: 100 }, { name: "prefix", label: "Before the number", type: "text", default: "" },
      { name: "suffix", label: "After the number", type: "text", default: "k" }, { name: "label", label: "Label", type: "text", default: "Subscribers" }, { name: "decimals", label: "Decimals", type: "number", default: 0 }],
    build(p, theme, d) {
      const from = num(p, "from", 10), to = num(p, "to", 100), decimals = Math.round(num(p, "decimals", 0, 0, 3));
      const prefix = str(p, "prefix", "", 6), suffix = str(p, "suffix", "k", 8), label = str(p, "label", "Subscribers", 40);
      const countS = Math.min(2.4, Math.max(.8, d - 1.1));
      const widest = prefix.length + suffix.length + Math.max(String(Math.round(Math.abs(from))).length, String(Math.round(Math.abs(to))).length) + (decimals ? decimals + 1 : 0);
      const fs = clamp(840 / (widest * 0.58), 90, 300);
      return { html: wrap("counter", p, `<div class="c"><div class="n"><span class="num">${esc(prefix)}${fmt(from)}${esc(suffix)}</span></div><i class="bar"></i><p class="l">${esc(label)}</p></div>`),
        css: `${base(theme, d)}.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}`
          + `.n{font-weight:800;font-size:${Math.round(fs)}px;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--ink);text-shadow:0 2px 18px rgba(0,0,0,.28);animation:pop .6s var(--ease) both}`
          + `.bar{display:block;margin:22px 0 18px;width:${Math.round(fs * 0.9)}px;max-width:70%;height:8px;border-radius:4px;background:var(--accent);transform-origin:left;animation:sweep ${fmt(countS)}s var(--ease) .3s both}`
          + `.l{margin:0;font-weight:600;font-size:40px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink);opacity:.9;animation:rise .6s var(--ease) .35s both}`,
        js: `var FROM=${from},TO=${to},DEC=${decimals},PRE=${JSON.stringify(prefix)},SUF=${JSON.stringify(suffix)},START=.3,DUR=${fmt(countS)};
function render(t,el){var p=Math.min(1,Math.max(0,(t-START)/DUR)),e=1-Math.pow(1-p,3),v=FROM+(TO-FROM)*e;
el.querySelector('.num').textContent=PRE+v.toLocaleString('en-US',{minimumFractionDigits:DEC,maximumFractionDigits:DEC})+SUF;}` };
    },
  },
  {
    id: "percent", name: "Percent", kind: "number", about: "A percentage as a ring or a progress bar that fills to its value.",
    frame: "overlay", widthPx: 720, heightPx: 560, durationS: 3.5,
    params: [{ name: "value", label: "Percent", type: "number", default: 72 }, { name: "label", label: "Label", type: "text", default: "Finished" }, { name: "style", label: "Look", type: "choice", default: "ring", options: ["ring", "bar"] }],
    build(p, theme, d) {
      const value = Math.round(num(p, "value", 72, 0, 100)), label = str(p, "label", "Finished", 40), style = pick(p, "style", ["ring", "bar"], "ring");
      const fillS = Math.min(2.2, Math.max(.8, d - 1.2));
      const js = `var TO=${value},START=.3,DUR=${fmt(fillS)};function render(t,el){var p=Math.min(1,Math.max(0,(t-START)/DUR)),e=1-Math.pow(1-p,3);el.querySelector('.num').textContent=Math.round(TO*e)+'%';}`;
      if (style === "bar") return { html: wrap("percent", p, `<div class="c"><div class="row"><p class="l">${esc(label)}</p><span class="num">0%</span></div><div class="track"><i class="fill"></i></div></div>`), js,
        css: `${base(theme, d)}.c{position:absolute;left:6%;right:6%;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;animation:fade .5s ease-out both}`
          + `.row{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:22px}.l{margin:0;font-weight:600;font-size:46px;color:var(--ink);text-shadow:0 2px 14px rgba(0,0,0,.28)}`
          + `.num{font-weight:800;font-size:120px;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--ink);text-shadow:0 2px 14px rgba(0,0,0,.28)}`
          + `.track{height:34px;border-radius:17px;background:rgba(255,255,255,.22);overflow:hidden}.fill{display:block;height:100%;width:${value}%;border-radius:17px;background:var(--accent);transform-origin:left;animation:sweep ${fmt(fillS)}s var(--ease) .3s both}` };
      return { html: wrap("percent", p, `<div class="c"><div class="ring"><svg viewBox="0 0 100 100"><circle class="t" cx="50" cy="50" r="42" pathLength="1"/><circle class="f" cx="50" cy="50" r="42" pathLength="1"/></svg><span class="num">0%</span></div><p class="l">${esc(label)}</p></div>`), js,
        css: `${base(theme, d)}.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;animation:fade .5s ease-out both}`
          + `.ring{position:relative;width:380px;height:380px}svg{width:100%;height:100%;transform:rotate(-90deg)}circle{fill:none;stroke-width:8;stroke-linecap:round}.t{stroke:rgba(255,255,255,.22)}`
          + `.f{stroke:var(--accent);stroke-dasharray:${fmt(value / 100)} 1;stroke-dashoffset:${fmt(value / 100)};animation:ring ${fmt(fillS)}s var(--ease) .3s both}@keyframes ring{from{stroke-dashoffset:${fmt(value / 100)}}to{stroke-dashoffset:0}}`
          + `.num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:112px;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--ink);text-shadow:0 2px 14px rgba(0,0,0,.28)}`
          + `.l{margin:0;font-weight:600;font-size:44px;color:var(--ink);text-shadow:0 2px 14px rgba(0,0,0,.28)}` };
    },
  },
  {
    id: "bar-chart", name: "Bar chart", kind: "chart", about: "Bars that grow from your numbers, one after another.",
    frame: "overlay", widthPx: 1000, heightPx: 600, durationS: 4.5,
    params: [{ name: "title", label: "Title", type: "text", default: "Views per video" }, { name: "data", label: "Data (label and value)", type: "data", default: [["Jan", 12], ["Feb", 19], ["Mar", 31], ["Apr", 58]] }],
    build(p, theme, d) {
      const title = str(p, "title", "Views per video", 50), rows = data(p, [["Jan", 12], ["Feb", 19], ["Mar", 31], ["Apr", 58]], 8);
      const max = Math.max(...rows.map(r => Math.abs(r[1])), 1e-9);
      return { html: wrap("bar-chart", p, `<div class="card"><p class="t">${esc(title)}</p><div class="bars">${rows.map(([label, value], i) => `<div class="col" style="--i:${i}"><b class="v">${esc(fmt(value))}</b><i class="bar${i === rows.length - 1 ? " last" : ""}" style="--h:${fmt(Math.max(0.02, Math.abs(value) / max))}"></i><span class="k">${esc(label)}</span></div>`).join("")}</div></div>`),
        css: `${base(theme, d)}.card{position:absolute;inset:4%;border-radius:28px;background:var(--surface);padding:38px 44px 30px;display:flex;flex-direction:column;animation:pop .6s var(--ease) both}`
          + `.t{margin:0 0 26px;font-weight:600;font-size:36px;color:var(--muted)}.bars{flex:1;display:flex;align-items:flex-end;gap:${rows.length > 5 ? 14 : 28}px;min-height:0}`
          + `.col{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch;text-align:center}`
          + `.bar{display:block;height:calc(var(--h)*(100% - 100px));min-height:6px;border-radius:12px 12px 4px 4px;background:rgba(255,255,255,.3);transform-origin:bottom;animation:grow .9s var(--ease) calc(.35s + var(--i)*.14s) both}.bar.last{background:var(--accent)}`
          + `.v{font-weight:800;font-size:34px;margin-bottom:10px;font-variant-numeric:tabular-nums;animation:fade .5s ease-out calc(.9s + var(--i)*.14s) both}.k{margin-top:14px;font-weight:600;font-size:28px;color:var(--muted)}` };
    },
  },
  {
    id: "line-chart", name: "Line chart", kind: "chart", about: "A line that draws itself across your numbers, ending on a marked point.",
    frame: "overlay", widthPx: 1000, heightPx: 600, durationS: 4.5,
    params: [{ name: "title", label: "Title", type: "text", default: "Watch time" }, { name: "data", label: "Data (label and value)", type: "data", default: [["W1", 4], ["W2", 7], ["W3", 6], ["W4", 12], ["W5", 18], ["W6", 25]] }],
    build(p, theme, d) {
      const title = str(p, "title", "Watch time", 50), rows = data(p, [["W1", 4], ["W2", 7], ["W3", 6], ["W4", 12], ["W5", 18], ["W6", 25]], 12);
      const lo = Math.min(...rows.map(r => r[1])), hi = Math.max(...rows.map(r => r[1])), span = hi - lo || 1;
      const L = 90, R = 940, T = 150, B = 480;
      const pts = rows.map(([label, value], i) => ({ label, value, x: L + (R - L) * (rows.length === 1 ? 0 : i / (rows.length - 1)), y: B - (B - T) * ((value - lo) / span) }));
      const path = pts.map((q, i) => `${i ? "L" : "M"}${fmt(q.x)} ${fmt(q.y)}`).join("");
      const drawS = Math.min(2.4, d - 1.4);
      return { html: wrap("line-chart", p, `<div class="card"><p class="t">${esc(title)}</p><svg viewBox="0 0 1000 600">`
        + [0, 1, 2, 3].map(g => `<line class="g" x1="${L}" x2="${R}" y1="${B - (B - T) * g / 3}" y2="${B - (B - T) * g / 3}"/>`).join("")
        + `<path class="ln" d="${path}" pathLength="1"/>`
        + pts.map((q, i) => `<circle class="dot${i === pts.length - 1 ? " end" : ""}" cx="${fmt(q.x)}" cy="${fmt(q.y)}" r="${i === pts.length - 1 ? 13 : 7}" style="--f:${fmt(i / Math.max(1, pts.length - 1))}"/>`).join("")
        + pts.map(q => `<text class="x" x="${fmt(q.x)}" y="530" text-anchor="middle">${esc(q.label)}</text>`).join("")
        + `<text class="val" x="${fmt(pts.at(-1)!.x)}" y="${fmt(pts.at(-1)!.y - 30)}" text-anchor="end">${esc(fmt(pts.at(-1)!.value))}</text></svg></div>`),
        css: `${base(theme, d)}.card{position:absolute;inset:4%;border-radius:28px;background:var(--surface);animation:pop .6s var(--ease) both}.t{position:absolute;left:44px;top:34px;margin:0;font-weight:600;font-size:36px;color:var(--muted)}`
          + `svg{position:absolute;inset:0;width:100%;height:100%}.g{stroke:var(--line);stroke-width:2}.x{fill:var(--muted);font-weight:600;font-size:26px;font-family:var(--font)}`
          + `.ln{fill:none;stroke:var(--accent);stroke-width:8;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:draw ${fmt(drawS)}s cubic-bezier(.45,.05,.25,1) .4s both}`
          + `.dot{fill:var(--surface);stroke:var(--accent);stroke-width:5;animation:fade .3s ease-out calc(.4s + var(--f)*${fmt(drawS)}s) both}.dot.end{fill:var(--accent)}`
          + `.val{fill:var(--on);font-weight:800;font-size:46px;font-family:var(--font);animation:fade .5s ease-out ${fmt(0.4 + drawS)}s both}` };
    },
  },
  {
    id: "timeline", name: "Timeline", kind: "diagram", about: "A line that draws across, dropping a marker and a label at each step.",
    frame: "overlay", widthPx: 1280, heightPx: 360, durationS: 5,
    params: [{ name: "steps", label: "Steps (up to 6)", type: "list", default: ["Idea", "Prototype", "Launch", "First 100 users"] }],
    build(p, theme, d) {
      const steps = list(p, "steps", ["Idea", "Prototype", "Launch", "First 100 users"], 6, 24);
      const n = steps.length, L = 110, R = 1170, drawS = Math.min(3, d - 1.2);
      const at = (i: number) => n === 1 ? (L + R) / 2 : L + (R - L) * i / (n - 1);
      return { html: wrap("timeline", p, `<div class="line" style="left:${L}px;width:${R - L}px;--s:${fmt(drawS)}s"></div>` + steps.map((s, i) => `<div class="st" style="left:${fmt(at(i))}px;--f:${fmt(n === 1 ? 0 : i / (n - 1))}"><i class="dot"></i><span>${esc(s)}</span></div>`).join("")),
        css: `${base(theme, d)}.line{position:absolute;top:150px;height:8px;border-radius:4px;background:var(--accent);transform-origin:left;animation:sweep var(--s) cubic-bezier(.45,.05,.25,1) .3s both}`
          + `.st{position:absolute;top:0;width:220px;margin-left:-110px;height:100%;--at:calc(.3s + var(--f)*${fmt(drawS)}s)}`
          + `.dot{position:absolute;left:50%;top:136px;width:36px;height:36px;margin-left:-18px;border-radius:50%;background:var(--ink);border:8px solid var(--accent);box-sizing:border-box;animation:pop .45s var(--ease) var(--at) both}`
          + `.st span{position:absolute;left:0;right:0;top:196px;text-align:center;font-weight:700;font-size:34px;line-height:1.15;color:var(--ink);text-shadow:0 2px 14px rgba(0,0,0,.3);animation:rise .55s var(--ease) calc(var(--at) + .1s) both}` };
    },
  },
  {
    id: "flow-diagram", name: "Flow diagram", kind: "diagram", about: "Boxes joined by arrows that draw on, left to right.",
    frame: "overlay", widthPx: 1280, heightPx: 360, durationS: 5,
    params: [{ name: "steps", label: "Boxes (up to 5)", type: "list", default: ["Record", "precut", "Review", "Post"] }],
    build(p, theme, d) {
      const steps = list(p, "steps", ["Record", "precut", "Review", "Post"], 5, 18), n = steps.length;
      const gap = 80, boxW = Math.min(250, (1180 - gap * (n - 1)) / n), total = n * boxW + (n - 1) * gap, x0 = (1280 - total) / 2, y = 130, h = 100;
      const each = Math.min(.9, (d - 1.2) / n);
      return { html: wrap("flow-diagram", p, steps.map((s, i) => `<div class="b" style="left:${fmt(x0 + i * (boxW + gap))}px;width:${fmt(boxW)}px;--i:${i}">${esc(s)}</div>`).join("")
        + `<svg viewBox="0 0 1280 360">` + steps.slice(1).map((_, i) => { const x1 = x0 + i * (boxW + gap) + boxW + 10, x2 = x0 + (i + 1) * (boxW + gap) - 10, ym = y + h / 2;
          return `<path class="a" pathLength="1" style="--i:${i}" d="M${fmt(x1)} ${ym}H${fmt(x2)}M${fmt(x2 - 16)} ${ym - 14}L${fmt(x2)} ${ym}L${fmt(x2 - 16)} ${ym + 14}"/>`; }).join("") + `</svg>`),
        css: `${base(theme, d)}.b{position:absolute;top:${y}px;height:${h}px;border-radius:22px;background:var(--surface);display:flex;align-items:center;justify-content:center;text-align:center;padding:0 14px;box-sizing:border-box;font-weight:700;font-size:${n > 4 ? 30 : 36}px;line-height:1.1;color:var(--on);animation:pop .5s var(--ease) calc(.2s + var(--i)*${fmt(each)}s) both}`
          + `.b:last-of-type{background:var(--accent);color:#fff}svg{position:absolute;inset:0;width:100%;height:100%}`
          + `.a{fill:none;stroke:var(--ink);stroke-width:6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:draw ${fmt(Math.max(.3, each * .9))}s var(--ease) calc(.2s + var(--i)*${fmt(each)}s + ${fmt(Math.min(.35, each * .5))}s) both}` };
    },
  },
  {
    id: "callout-card", name: "Callout card", kind: "card", about: "A card with an icon, a title and one line, for a label, a tip or a note.",
    frame: "overlay", widthPx: 760, heightPx: 260, durationS: 4,
    params: [{ name: "title", label: "Title", type: "text", default: "Pro tip" }, { name: "body", label: "One line", type: "text", default: "Cut the first two seconds of every clip." }, { name: "icon", label: "Icon", type: "choice", default: "idea", options: ICON_NAMES }],
    build(p, theme, d) {
      const title = str(p, "title", "Pro tip", 36), body = str(p, "body", "Cut the first two seconds of every clip.", 90), icon = pick(p, "icon", ICON_NAMES, "idea");
      return { html: wrap("callout-card", p, `<div class="card"><div class="ic">${iconSvg(icon)}</div><div class="tx"><p class="t">${esc(title)}</p><p class="b">${esc(body)}</p></div></div>`),
        css: `${base(theme, d)}.card{position:absolute;inset:14px;border-radius:30px;background:var(--surface);display:flex;align-items:center;gap:30px;padding:0 38px;animation:rise .7s var(--ease) both}`
          + `.ic{flex:none;width:112px;height:112px;border-radius:30px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;--at:.35s}.icon{width:62px;height:62px}`
          + `.t{margin:0 0 8px;font-weight:800;font-size:46px;line-height:1.05;letter-spacing:-.01em;color:var(--on);animation:fade .5s ease-out .25s both}.b{margin:0;font-weight:500;font-size:32px;line-height:1.25;color:var(--muted);animation:fade .5s ease-out .4s both}` };
    },
  },
  {
    id: "notification", name: "Notification", kind: "card", about: "A banner that drops in from the top, like a phone notification.",
    frame: "overlay", widthPx: 900, heightPx: 220, durationS: 3.5,
    params: [{ name: "app", label: "App name", type: "text", default: "Payments" }, { name: "title", label: "Title", type: "text", default: "New sale" }, { name: "body", label: "Message", type: "text", default: "Someone just bought your course." }, { name: "icon", label: "Icon", type: "choice", default: "bolt", options: ICON_NAMES }],
    build(p, theme, d) {
      const app = str(p, "app", "Payments", 24), title = str(p, "title", "New sale", 36), body = str(p, "body", "Someone just bought your course.", 70), icon = pick(p, "icon", ICON_NAMES, "bolt");
      return { html: wrap("notification", p, `<div class="n"><div class="ic">${iconSvg(icon)}</div><div class="tx"><p class="h"><span>${esc(app)}</span><em>now</em></p><p class="t">${esc(title)}</p><p class="b">${esc(body)}</p></div></div>`),
        css: `${base(theme, d)}.n{position:absolute;inset:16px;border-radius:36px;background:var(--surface);display:flex;align-items:center;gap:26px;padding:0 32px;animation:drop .75s var(--ease) both}@keyframes drop{from{opacity:0;transform:translateY(-40px) scale(.97)}to{opacity:1;transform:none}}`
          + `.ic{flex:none;width:96px;height:96px;border-radius:24px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;--at:.4s}.icon{width:54px;height:54px}.tx{flex:1;min-width:0}`
          + `.h{margin:0 0 4px;display:flex;justify-content:space-between;font-weight:600;font-size:24px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.h em{font-style:normal;text-transform:none;letter-spacing:0}`
          + `.t{margin:0;font-weight:800;font-size:38px;line-height:1.1;color:var(--on)}.b{margin:2px 0 0;font-weight:500;font-size:28px;line-height:1.2;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` };
    },
  },
  {
    // PRO4: house rules for anything around a picture: soft fills only (no stroke, ring, outline or shadow) and nothing
    // invented. Without a screenshot the window stays empty: no placeholder bars, no made-up title, no fake window dots.
    id: "screenshot-frame", name: "Screenshot frame", kind: "screenshot", about: "A window around a screenshot, a soft highlight that lands on the part that matters and a cursor that moves to it.",
    frame: "overlay", widthPx: 1280, heightPx: 760, durationS: 6,
    params: [{ name: "image", label: "Screenshot (a data image, optional)", type: "image", default: "" }, { name: "title", label: "Window title (optional)", type: "text", default: "" },
      { name: "highlight", label: "Highlight (x, y, w, h as fractions of the screenshot)", type: "data", default: [0.58, 0.3, 0.32, 0.22] }, { name: "caption", label: "Caption under the highlight", type: "text", default: "" }],
    build(p, theme, d) {
      const image = typeof p.image === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image) ? p.image : "";
      const title = str(p, "title", "", 40), caption = str(p, "caption", "", 60);
      const h = Array.isArray(p.highlight) && p.highlight.length === 4 && p.highlight.every(v => typeof v === "number" && Number.isFinite(v)) ? (p.highlight as number[]).map(v => clamp(v, 0, 1)) : [0.58, 0.3, 0.32, 0.22];
      const W = 1280, barH = title ? 64 : 0, sx = 48, sy = 40 + barH, sw = W - 96, sh = 760 - sy - 40;
      const hx = sx + h[0] * sw, hy = sy + h[1] * sh, hw = Math.max(40, h[2] * sw), hh = Math.max(40, h[3] * sh);
      const cx0 = sx + sw * 0.18, cy0 = sy + sh * 0.82, cx1 = hx + hw * 0.62, cy1 = hy + hh * 0.62;
      const hl = Math.min(2.4, d * 0.34), cur = hl - .2;
      const screen = image ? `<img class="shot" alt="" src="${image}">` : "";
      return { html: wrap("screenshot-frame", p, `<div class="win">${title ? `<div class="bar"><span>${esc(title)}</span></div>` : ""}<div class="screen">${screen}</div></div>`
        + `<div class="hl" style="left:${fmt(hx)}px;top:${fmt(hy)}px;width:${fmt(hw)}px;height:${fmt(hh)}px"></div>`
        + (caption ? `<div class="cap" style="left:${fmt(hx)}px;top:${fmt(Math.min(760 - 90, hy + hh + 18))}px">${esc(caption)}</div>` : "")
        + `<svg class="cur" viewBox="0 0 24 24" width="56" height="56"><path d="M4 2l15 9-6.5 1.5L9 19 4 2z" fill="currentColor"/></svg><i class="click" style="left:${fmt(cx1)}px;top:${fmt(cy1)}px"></i>`),
        css: `${base(theme, d, false)}.win{position:absolute;left:${sx}px;top:40px;width:${sw}px;height:${sh + barH}px;border-radius:26px;background:var(--surface);overflow:hidden;animation:pop .7s var(--ease) both}`
          + `.bar{height:${barH}px;display:flex;align-items:center;padding:0 30px;background:color-mix(in srgb,var(--on) 7%,transparent)}.bar span{font-weight:600;font-size:26px;color:var(--muted)}`
          + `.screen{position:absolute;left:0;right:0;top:${barH}px;bottom:0}.shot{width:100%;height:100%;object-fit:cover;display:block}`
          + `.hl{position:absolute;border-radius:20px;background:color-mix(in srgb,var(--accent) 30%,transparent);transform-origin:center;animation:hlin .7s var(--ease) ${fmt(hl)}s both}@keyframes hlin{from{opacity:0;transform:scale(1.12)}to{opacity:1;transform:none}}`
          + `.cap{position:absolute;max-width:520px;padding:12px 22px;border-radius:16px;background:var(--accent);color:#fff;font-weight:700;font-size:30px;animation:rise .5s var(--ease) ${fmt(hl + .35)}s both}`
          + `.cur{position:absolute;left:0;top:0;color:var(--accent);animation:cur ${fmt(cur)}s cubic-bezier(.5,0,.2,1) .6s both}@keyframes cur{from{opacity:0;transform:translate(${fmt(cx0)}px,${fmt(cy0)}px)}12%{opacity:1}to{opacity:1;transform:translate(${fmt(cx1)}px,${fmt(cy1)}px)}}`
          + `.click{position:absolute;width:70px;height:70px;margin:-35px 0 0 -35px;border-radius:50%;background:color-mix(in srgb,var(--accent) 40%,transparent);animation:ripple .6s ease-out ${fmt(0.6 + cur)}s both}@keyframes ripple{from{opacity:.9;transform:scale(.2)}to{opacity:0;transform:scale(1.2)}}` };
    },
  },
  {
    // PRO4: a card for something on a screen. The picture is his own (a frame of a recording, a screenshot, a photo),
    // cropped and encoded by add_card. It arrives with a tilt that settles flat on the launch video's SNAP spring
    // (damping 24, stiffness 340, mass 0.45: about 5 frames at 30 fps), holds, pushes slowly towards the named region,
    // and a stamp (his own words, checked by add_card) pops 1.4 to 1 over 4 frames at 30 fps. It cuts out on a cut or
    // eases off. Soft fills only: no shadow, glow, blur, outline or stroke. Everything is a function of t.
    id: CARD_TEMPLATE, name: "Card", kind: "card", hidden: true, about: "A real picture from the shoot that tilts in, settles flat, pushes towards the part that matters and can carry a stamp.",
    frame: "overlay", widthPx: 1568, heightPx: 1036, durationS: 3,
    params: [{ name: "image", label: "Picture (made by add_card)", type: "image", default: "" }, { name: "media", label: "Picture in the shoot (made by add_card)", type: "text", default: "" }, { name: "px", label: "Picture size in pixels", type: "data", default: [1600, 1000] },
      { name: "region", label: "Region to push towards (x, y, w, h as fractions of the picture)", type: "data", default: null },
      { name: "stamp", label: "Stamp (his own words)", type: "text", default: "" }, { name: "stampAtS", label: "Stamp time (seconds into the card)", type: "number", default: 0.9 },
      { name: "exit", label: "Exit", type: "choice", default: "ease", options: ["ease", "cut"] }],
    build(p, theme, d) {
      const media = typeof p.media === "string" && CARD_MEDIA.test(p.media) ? p.media : "";
      const image = media ? CARD_MEDIA_SRC : typeof p.image === "string" && CARD_IMAGE.test(p.image) ? p.image : "";
      if (!image) throw new Error("A card shows a real picture from your shoot. Make it with add_card.");
      const px = Array.isArray(p.px) && p.px.length === 2 && p.px.every(v => typeof v === "number" && v > 0) ? p.px as number[] : [1600, 1000];
      const aspect = clamp(px[0] / px[1], 0.3, 3.4), M = CARD_MOTION.side;
      const CW = aspect >= 1 ? M : Math.round(M * aspect), CH = aspect >= 1 ? Math.round(M / aspect) : M;
      const padX = Math.round(Math.max(28, CW * 0.06)), padY = Math.round(Math.max(28, CH * 0.06));
      const region = cardBox(p.region), stamp = cardStamp(p.stamp), exit = pick(p, "exit", ["ease", "cut"], "ease");
      const stampAt = num(p, "stampAtS", Math.min(d * 0.45, 1.1), 0, Math.max(0, d - 0.2));
      const push = region ? clamp(0.55 / Math.max(region[2], region[3]), 1.08, CARD_MOTION.pushMax) : 1.05;
      const radius = Math.round(Math.min(CW, CH) * 0.045), font = Math.round(clamp(Math.min(CW, CH) * 0.075, 30, 96));
      const stampInk = luminance(theme.accent) > 0.55 ? "#15151b" : "#ffffff";
      const { springDamping: c, springStiffness: k, springMass: m, holdS, exitS, popS, popFrom, tilt } = CARD_MOTION;
      const html = `<div class="card"><img class="shot" alt="" src="${image}">${stamp ? `<span class="stamp">${esc(stamp)}</span>` : ""}</div>`;
      return { size: { widthPx: CW + 2 * padX, heightPx: CH + 2 * padY }, ...(media ? { media } : {}),
        html: wrap(CARD_TEMPLATE, media ? { ...p, image: "", media } : { ...p, image: CARD_IMAGE_REF }, html),
        css: `${base(theme, d, false)}.root{animation:none;perspective:${Math.round(Math.max(CW, CH) * 2.2)}px;perspective-origin:50% 50%}`
          + `.card{position:absolute;left:${padX}px;top:${padY}px;width:${CW}px;height:${CH}px;border-radius:${radius}px;overflow:hidden;background:var(--surface);transform-origin:50% 60%;opacity:0}`
          + `.shot{position:absolute;left:0;top:0;width:100%;height:100%;display:block;transform-origin:50% 50%}`
          + `.stamp{position:absolute;left:0;top:0;padding:.3em .62em .34em;border-radius:999px;background:var(--accent);color:${stampInk};font-weight:700;font-size:${font}px;line-height:1.05;letter-spacing:-.005em;white-space:nowrap;opacity:0}`,
        js: `var D=${fmt(d)},W=${CW},H=${CH},REG=${JSON.stringify(region)},PUSH=${fmt(push)},SAT=${fmt(stampAt)},HOLD=${holdS},OUT=${exit === "ease" ? exitS : 0},POP=${fmt(popS)},POPF=${popFrom},TX=${tilt.x},TY=${tilt.y},TS=${tilt.scale},TD=${tilt.drop};
var Z=${c}/(2*Math.sqrt(${k}*${m})),W0=Math.sqrt(${k}/${m}),WD=W0*Math.sqrt(1-Z*Z);
function snap(t){return t<=0?0:1-Math.exp(-Z*W0*t)*(Math.cos(WD*t)+Z*W0/WD*Math.sin(WD*t));}
function clamp01(x){return Math.min(1,Math.max(0,x));}
function inout(x){x=clamp01(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;}
function out3(x){x=clamp01(x);return 1-Math.pow(1-x,3);}
function pushAt(t){var k=inout((t-HOLD)/Math.max(0.3,D-OUT-HOLD)),s=1+(PUSH-1)*k,tx=0,ty=0;
if(REG){tx=-s*(REG[0]+REG[2]/2-0.5)*W*k;ty=-s*(REG[1]+REG[3]/2-0.5)*H*k;var mx=(s-1)*W/2,my=(s-1)*H/2;tx=Math.max(-mx,Math.min(mx,tx));ty=Math.max(-my,Math.min(my,ty));}
return [s,tx,ty];}
function regionAt(m){return [W/2+m[0]*(REG[0]*W-W/2)+m[1],H/2+m[0]*(REG[1]*H-H/2)+m[2],m[0]*REG[2]*W,m[0]*REG[3]*H];}
// Where the stamp sits, chosen once (as the region is when it lands) so it never jumps: just above the region, else beside
// a short region (a line of text), else just below it while that stays clear of the caption band, else on the region's
// own top-left corner. It follows the push.
var SPOT=null;
function spot(sw,sh,inset,gap){if(SPOT)return SPOT;if(!REG)return SPOT='corner';var r=regionAt(pushAt(SAT));
SPOT=r[1]-gap-sh*POPF>=inset?'above':r[3]<sh*2&&r[0]+r[2]+gap+sw*POPF<=W-inset?'beside':r[1]+r[3]+gap+sh*POPF<=H*0.8?'below':'inside';return SPOT;}
function render(t,el){
var card=el.querySelector('.card'),shot=el.querySelector('.shot'),stamp=el.querySelector('.stamp');
var q=1-snap(t),o=clamp01(t/0.05),sc=1-TS*q,ex=0;
if(OUT>0&&t>D-OUT){ex=clamp01((t-D+OUT)/OUT);ex=ex*ex*ex;o*=1-ex;sc*=1-0.03*ex;}
card.style.opacity=o.toFixed(4);
card.style.transform='translateY('+(q*H*TD).toFixed(2)+'px) rotateX('+(q*TX).toFixed(3)+'deg) rotateY('+(-q*TY).toFixed(3)+'deg) scale('+sc.toFixed(4)+')';
var m=pushAt(t);shot.style.transform='translate('+m[1].toFixed(2)+'px,'+m[2].toFixed(2)+'px) scale('+m[0].toFixed(4)+')';
if(!stamp)return;
var a=t-SAT;if(a<0){stamp.style.opacity='0';return;}
var sw=stamp.offsetWidth,sh=stamp.offsetHeight,inset=Math.min(W,H)*0.05,gap=H*0.02,where=spot(sw,sh,inset,gap),x=inset,y=inset,low=false;
if(REG){var r=regionAt(m);x=r[0];if(where==='above'){y=r[1]-gap-sh;low=true;}else if(where==='beside'){x=r[0]+r[2]+gap;y=r[1]+r[3]/2-sh/2;}else if(where==='below'){y=r[1]+r[3]+gap;}else{x+=inset*0.6;y=r[1]+inset*0.6;}}
x=Math.max(inset,Math.min(W-inset-sw*POPF,x));y=low?Math.max(inset+sh*(POPF-1),Math.min(H-inset-sh,y)):Math.max(inset,Math.min(H-inset-sh*POPF,y));
stamp.style.opacity='1';stamp.style.transformOrigin=low?'0 100%':'0 0';
stamp.style.transform='translate('+x.toFixed(2)+'px,'+y.toFixed(2)+'px) scale('+(POPF-(POPF-1)*out3(a/POP)).toFixed(4)+')';}` };
    },
  },
  {
    id: "icon-metaphor", name: "Icon metaphor", kind: "icon", about: "A line icon that draws itself in a ring, with a word beneath.",
    frame: "overlay", widthPx: 520, heightPx: 520, durationS: 3,
    params: [{ name: "icon", label: "Icon", type: "choice", default: "growth", options: ICON_NAMES }, { name: "label", label: "Word", type: "text", default: "Growth" }],
    build(p, theme, d) {
      const icon = pick(p, "icon", ICON_NAMES, "growth"), label = str(p, "label", "Growth", 24);
      return { html: wrap("icon-metaphor", p, `<div class="c"><div class="disc"><svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" pathLength="1" class="stroke"/></svg>${iconSvg(icon, "icon")}</div><p class="l">${esc(label)}</p></div>`),
        css: `${base(theme, d)}.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px}.disc{position:relative;width:300px;height:300px;display:flex;align-items:center;justify-content:center;color:var(--ink);animation:pop .6s var(--ease) both}`
          + `.ring{position:absolute;inset:0;width:100%;height:100%;fill:none;stroke:var(--accent);stroke-width:3;stroke-linecap:round;transform:rotate(-90deg)}`
          + `.icon{width:150px;height:150px;stroke-width:1.3;--at:.5s}.icon .stroke{stroke-width:1.5}.l{margin:0;font-weight:800;font-size:56px;letter-spacing:-.01em;color:var(--ink);text-shadow:0 2px 14px rgba(0,0,0,.3);animation:rise .6s var(--ease) 1s both}` };
    },
  },
  {
    id: "explainer-full", name: "Explainer card", kind: "explainer", about: "A full-frame card: a title and up to four points that arrive one by one. It replaces the picture while it is on.",
    frame: "full", widthPx: 1920, heightPx: 1080, durationS: 8,
    params: [{ name: "title", label: "Title", type: "text", default: "How it works" }, { name: "points", label: "Points (up to 4)", type: "list", default: ["Drop in your footage", "precut makes the first cut", "You have the final say"] }],
    build(p, theme, d) {
      const title = str(p, "title", "How it works", 50), points = list(p, "points", ["Drop in your footage", "precut makes the first cut", "You have the final say"], 4, 60);
      const gap = Math.min(1.1, (d - 2.4) / Math.max(1, points.length));
      return { html: wrap("explainer-full", p, `<div class="bg"></div><div class="c"><p class="eyebrow">${String(points.length).padStart(2, "0")} steps</p><h1>${esc(title)}</h1><ol>${points.map((s, i) => `<li style="--i:${i}"><b>${String(i + 1).padStart(2, "0")}</b><span>${esc(s)}</span></li>`).join("")}</ol></div>`),
        css: `${base(theme, d)}.bg{position:absolute;inset:0;background:var(--surface)}.c{position:absolute;left:9%;right:9%;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center}`
          + `.eyebrow{margin:0 0 calc(var(--u)*2);font-weight:600;font-size:calc(var(--u)*3);letter-spacing:.14em;text-transform:uppercase;color:var(--accent);animation:rise .6s var(--ease) .1s both}`
          + `h1{margin:0 0 calc(var(--u)*7);font-weight:800;font-size:calc(var(--u)*11);line-height:1.02;letter-spacing:-.025em;color:var(--on);text-wrap:balance;animation:rise .7s var(--ease) .2s both}`
          + `ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:calc(var(--u)*3.2)}li{display:flex;align-items:baseline;gap:calc(var(--u)*3);animation:rise .6s var(--ease) calc(1s + var(--i)*${fmt(gap)}s) both}`
          + `li b{font-weight:800;font-size:calc(var(--u)*4);color:var(--accent);font-variant-numeric:tabular-nums}li span{font-weight:600;font-size:calc(var(--u)*5.2);line-height:1.15;color:var(--on)}` };
    },
  },
];

export function graphicTemplates(): TemplateInfo[] {
  return TEMPLATES.filter(t => !t.hidden).map(({ build: _build, hidden: _hidden, ...info }) => info);
}
export function templateInfo(id: string): TemplateInfo | undefined {
  return graphicTemplates().find(t => t.id === id);
}

/** Build a composition from a starter. Params outside the starter's list are ignored; bad values fall back to the defaults. */
export function buildFromTemplate(id: string, params: Record<string, unknown> = {}, theme: Partial<GraphicTheme> = {}, options: { durationS?: number; layer?: "front" | "behind"; words?: MotionGraphic["words"] } = {}): MotionGraphic {
  const template = TEMPLATES.find(t => t.id === id);
  if (!template) throw new Error(`There is no graphic template called "${id}". Choose one from the list.`);
  const resolved: GraphicTheme = { font: theme.font || DEFAULT_THEME.font, accent: colour(theme.accent, DEFAULT_THEME.accent), ink: colour(theme.ink, DEFAULT_THEME.ink), tone: theme.tone === "light" ? "light" : "dark" };
  const durationS = clamp(options.durationS ?? template.durationS, 0.8, 60);
  const built = template.build(params ?? {}, resolved, durationS);
  // The look rides along in the html so the starter can be rebuilt to a new length without losing it.
  built.html = built.html.replace(/data-gfx-params="/, `data-gfx-theme="${esc(JSON.stringify(resolved))}" data-gfx-params="`);
  const graphic: MotionGraphic = { html: built.html, css: built.css, widthPx: built.size?.widthPx ?? template.widthPx, heightPx: built.size?.heightPx ?? template.heightPx, durationS, frame: template.frame, template: template.id };
  if (built.js) graphic.js = built.js;
  if (built.media) graphic.media = built.media;
  if (options.layer === "behind" && template.frame === "overlay") graphic.layer = "behind";
  if (options.words?.length) graphic.words = options.words;
  return graphic;
}

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The starter, params and look a graphic was made from, read back from its own html; null for a hand-written composition. */
export function graphicSource(g: MotionGraphic): { template: string; params: Record<string, unknown>; theme: Partial<GraphicTheme> } | null {
  const template = /data-gfx-template="([a-z0-9-]+)"/.exec(g.html), params = /data-gfx-params="([^"]*)"/.exec(g.html), theme = /data-gfx-theme="([^"]*)"/.exec(g.html);
  if (!template || !params) return null;
  try {
    const found = { template: template[1], params: JSON.parse(unesc(params[1])) as Record<string, unknown>, theme: theme ? JSON.parse(unesc(theme[1])) : {} };
    // PRO4: a card keeps its picture once, in its <img>; put it back so a rebuild (a new length) keeps it.
    if (found.params.image === CARD_IMAGE_REF) found.params.image = /<img class="shot" alt="" src="(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)"/.exec(g.html)?.[1] ?? "";
    return found;
  }
  catch { return null; }
}
