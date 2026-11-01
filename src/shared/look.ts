// LOOK1 (docs/plans/produced/scene-look-spike.md): the one record of how a scene looks, beside motion (shared/motion.ts),
// read by every scene template. Three layers, each set on its own: the background (from the shot, a gradient, a design
// Claude wrote, an image, a flat colour), the type (font, weight, case, colour, size) and the finish (grain, vignette,
// a slow push of the background). The inspector's Look section, Ask and the MCP (get_scene_look, set_scene_look) change these values,
// never code. Pure: no node, no DOM.
//
// A scene with no look is drawn as it always was (on black): saved edits keep their look until he changes it. New scenes
// start from the shot (LOOK_NEW). The dim layer under the words is "auto" by default: main measures the background under
// the words (as qa/LOOK0 did) and keeps every word at 4.5:1 or better; dimAuto is what it chose.

export type LookBgKind = "shot" | "gradient" | "design" | "image" | "colour";
export type GradientType = "linear" | "radial" | "mesh";
export type LookCase = "lower" | "as said" | "upper";
export type LookBox = [number, number, number, number];   // x, y, w, h as fractions of the picture, from its top left
export type LookBg =
  | { kind: "shot"; blur: number; media?: string; clip?: string; atS?: number }
  | { kind: "gradient"; stops: string[]; angle: number; type: GradientType; drift: boolean; seed?: number }
  | { kind: "design"; html: string; css: string; name: string; raster?: string }
  | { kind: "image"; blur: number; media?: string; clip?: string; atS?: number; name?: string; face?: LookBox }
  | { kind: "colour"; value: string };
export interface LookType {
  font?: string;                                // a bundled family; absent = the edit's own (its captions' font)
  weight: number;                               // 400 to 900
  case: LookCase;
  colour: string;                               // the words
  accent?: string;                              // the accent word; absent = the edit's accent
  scale: number;                                // 0.6 to 1.6 times the scene's own size
}
export interface LookFinish { grain: number; vignette: number; push: number }   // grain and vignette 0 to 1; push 0 to 10 per cent over the scene
export interface Look {
  bg: LookBg;
  dim: number | "auto";                         // the black layer under the words, 0 to 0.9, or chosen so they read
  dimAuto?: number;                             // what auto chose (main measures it)
  darkened?: boolean;                           // auto had to darken the background so the words read
  type: LookType;
  finish: LookFinish;
  palette?: string[];                           // the shot's own colours, for Shuffle
}

export const LOOK_KINDS: LookBgKind[] = ["shot", "gradient", "design", "image", "colour"];
export const LOOK_KIND_NAMES: Record<LookBgKind, string> = { shot: "From the shot", gradient: "Gradient", design: "Designed", image: "Image", colour: "Colour" };
export const GRADIENT_TYPES: GradientType[] = ["linear", "radial", "mesh"];
export const LOOK_CASES: LookCase[] = ["lower", "as said", "upper"];
export const LOOK_FONTS = ["Outfit", "Inter Display", "Montserrat", "Poppins", "Bebas Neue", "Archivo Black", "Caveat"] as const;
export const LOOK_LIMITS = { blur: [0, 100], dim: [0, 0.9], weight: [400, 900], scale: [0.6, 1.6], grain: [0, 1], vignette: [0, 1], push: [0, 10], angle: [0, 360],
  stops: [2, 4], designHtml: 8000, designCss: 12000, name: 40, palette: 6 } as const;
/** WCAG's bar for words on a background. */
export const LOOK_CONTRAST = 4.5;
export const LOOK_NOTES = {
  darkened: "Darkened the background so the words read.",
  darkWords: "The words are dark, so a darker background won't help them read; pick lighter words or a lighter background.",
  noPicture: "There's no picture here yet, so it shows black until one is chosen.",
} as const;
export const BLACK = "#0a0a0b";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown, fallback: number, [lo, hi]: readonly [number, number], step = 0.001) => r3(Math.round(clamp(finite(v) ? v : fallback, lo, hi) / step) * step);
function one<T>(v: unknown, options: readonly T[], fallback: T): T { return options.includes(v as T) ? v as T : fallback; }
export const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const hexOr = (v: unknown, fallback: string) => typeof v === "string" && /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map(c => c + c).join("")}`.toLowerCase() : isHex(v) ? v.toLowerCase() : fallback;
const MEDIA = /^card-[a-f0-9]{32}\.webp$/;
const text = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : "";

export const LOOK_TYPE_DEFAULT: LookType = { weight: 800, case: "lower", colour: "#ffffff", scale: 1 };
export const LOOK_FINISH_DEFAULT: LookFinish = { grain: 0, vignette: 0.2, push: 3 };
/** Each background's own starting values, when he picks it. */
export function bgDefaults(kind: LookBgKind): LookBg {
  if (kind === "shot") return { kind, blur: 45 };
  if (kind === "gradient") return { kind, stops: ["#1b1030", "#3a1550", "#0d1a3a"], angle: 160, type: "mesh", drift: true };
  if (kind === "design") return { kind, html: "", css: "", name: "" };
  if (kind === "image") return { kind, blur: 0 };
  return { kind: "colour", value: BLACK };
}
/** A new scene's look: his own shot under the cut, blurred and graded down, the words kept readable. */
export const LOOK_NEW: Look = { bg: bgDefaults("shot"), dim: "auto", type: { ...LOOK_TYPE_DEFAULT }, finish: { ...LOOK_FINISH_DEFAULT } };

function clampBg(input: unknown, fallback: LookBg): LookBg {
  const b = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const kind = one(b.kind, LOOK_KINDS, fallback.kind), d = (fallback.kind === kind ? fallback : bgDefaults(kind)) as Record<string, unknown>;
  const L = LOOK_LIMITS, pic = () => ({
    ...(typeof b.media === "string" && MEDIA.test(b.media) ? { media: b.media } : typeof d.media === "string" && b.media === undefined ? { media: d.media } : {}),
    ...(typeof b.clip === "string" && b.clip ? { clip: b.clip.slice(0, 200) } : typeof d.clip === "string" && b.clip === undefined ? { clip: d.clip } : {}),
    ...(finite(b.atS) ? { atS: r3(Math.max(0, b.atS)) } : finite(d.atS) && b.atS === undefined ? { atS: d.atS } : {}),
  });
  if (kind === "shot") return { kind, blur: num(b.blur, d.blur as number, L.blur, 1), ...pic() };
  if (kind === "image") {
    const face = Array.isArray(b.face) && b.face.length === 4 && b.face.every(finite) ? b.face.map(n => r3(clamp(n as number, 0, 1))) as LookBox : b.face === undefined && Array.isArray(d.face) ? d.face as LookBox : undefined;
    const name = typeof b.name === "string" ? b.name.slice(0, 80) : b.name === undefined && typeof d.name === "string" ? d.name : undefined;
    return { kind, blur: num(b.blur, d.blur as number, L.blur, 1), ...pic(), ...(name ? { name } : {}), ...(face ? { face } : {}) };
  }
  if (kind === "gradient") {
    const raw = Array.isArray(b.stops) ? b.stops : d.stops as string[];
    let stops = raw.map(s => hexOr(s, "")).filter(Boolean).slice(0, L.stops[1]);
    if (stops.length < L.stops[0]) stops = [...stops, ...(d.stops as string[])].slice(0, Math.max(L.stops[0], stops.length));
    const seed = finite(b.seed) ? Math.round(clamp(b.seed, 0, 1e6)) : b.seed === undefined && finite(d.seed) ? d.seed : undefined;
    return { kind, stops, angle: num(b.angle, d.angle as number, L.angle, 1) % 360, type: one(b.type, GRADIENT_TYPES, d.type as GradientType), drift: typeof b.drift === "boolean" ? b.drift : d.drift as boolean, ...(seed !== undefined ? { seed } : {}) };
  }
  if (kind === "design") {
    const raster = typeof b.raster === "string" && MEDIA.test(b.raster) ? b.raster : undefined;
    return { kind, html: text(b.html ?? d.html, L.designHtml), css: text(b.css ?? d.css, L.designCss), name: text(b.name ?? d.name, L.name).replace(/\s+/g, " ").trim(), ...(raster ? { raster } : {}) };
  }
  return { kind: "colour", value: hexOr(b.value, d.value as string) };
}

/** A clean copy with every value inside its range; anything missing or wrong takes the default (or `fallback`'s). */
export function clampLook(input: unknown, fallback: Look = LOOK_NEW): Look {
  const m = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const L = LOOK_LIMITS, t = (m.type && typeof m.type === "object" ? m.type : {}) as Record<string, unknown>, f = (m.finish && typeof m.finish === "object" ? m.finish : {}) as Record<string, unknown>;
  const ft = fallback.type, ff = fallback.finish;
  const font = typeof t.font === "string" && (LOOK_FONTS as readonly string[]).includes(t.font) ? t.font : t.font === undefined ? ft.font : undefined;
  const accent = t.accent === undefined ? ft.accent : isHex(t.accent) || /^#[0-9a-f]{3}$/i.test(String(t.accent)) ? hexOr(t.accent, "") : undefined;
  const type: LookType = { ...(font ? { font } : {}), weight: num(t.weight, ft.weight, L.weight, 100), case: one(t.case, LOOK_CASES, ft.case), colour: hexOr(t.colour, ft.colour), ...(accent ? { accent } : {}), scale: num(t.scale, ft.scale, L.scale, 0.01) };
  const dim = m.dim === "auto" ? "auto" : finite(m.dim) ? num(m.dim, 0, L.dim, 0.01) : fallback.dim;
  const out: Look = { bg: clampBg(m.bg, fallback.bg), dim, type, finish: { grain: num(f.grain, ff.grain, L.grain, 0.01), vignette: num(f.vignette, ff.vignette, L.vignette, 0.01), push: num(f.push, ff.push, L.push, 0.1) } };
  const dimAuto = finite(m.dimAuto) ? m.dimAuto : m.dimAuto === undefined && dim === "auto" ? fallback.dimAuto : undefined;
  if (dim === "auto" && finite(dimAuto)) { out.dimAuto = num(dimAuto, 0, L.dim, 0.01); if (m.darkened === true || (m.darkened === undefined && fallback.darkened)) out.darkened = true; }
  const palette = (Array.isArray(m.palette) ? m.palette : fallback.palette ?? []).map(c => hexOr(c, "")).filter(Boolean).slice(0, L.palette);
  if (palette.length) out.palette = palette;
  return out;
}

/** The dim the template draws: the fixed one, or what auto chose (none until it is measured). */
export const lookDim = (look: Look) => look.dim === "auto" ? look.dimAuto ?? 0 : look.dim;
/** The picture a background shows from the shoot's cache, if any (from the shot or an image; a design kept as a texture). */
export const lookMedia = (look: Look | null | undefined): string | undefined => !look ? undefined : look.bg.kind === "shot" || look.bg.kind === "image" ? look.bg.media : look.bg.kind === "design" ? look.bg.raster : undefined;
/** Two looks the same except the picture the shot gives each scene (that is the scene's own). */
export function sameLookAcrossScenes(a: Look, b: Look): boolean {
  const strip = (l: Look) => JSON.stringify({ ...l, bg: l.bg.kind === "shot" ? { kind: "shot", blur: l.bg.blur } : l.bg, dimAuto: undefined, darkened: undefined, palette: undefined });
  return strip(a) === strip(b);
}

// ---- one change, the same from the inspector, Ask and the MCP

export type LookChange = { bg?: Partial<Record<string, unknown>> & { kind?: LookBgKind }; dim?: number | "auto"; type?: { [K in keyof LookType]?: LookType[K] | null }; finish?: Partial<LookFinish>; shuffle?: boolean };
export interface LookChanged { look: Look; changed: string[] }

const pct = (n: number) => `${Math.round(n * 100)}%`;
const BG_WORDS: Record<LookBgKind, string> = { shot: "the shot", gradient: "a gradient", design: "a design", image: "an image", colour: "a flat colour" };
function describeBg(a: LookBg, b: LookBg, out: string[]) {
  if (a.kind !== b.kind) { out.push(`background ${BG_WORDS[a.kind]} to ${BG_WORDS[b.kind]}${b.kind === "colour" ? ` (${b.value})` : b.kind === "design" && b.name ? ` (“${b.name}”)` : ""}`); return; }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  if (x.blur !== y.blur && y.blur !== undefined) out.push(`blur ${x.blur} to ${y.blur}`);
  if (x.media !== y.media && (b.kind === "image" || b.kind === "shot")) out.push(b.kind === "image" ? `picture ${b.name ? `to “${b.name}”` : "changed"}` : "picture from the shot changed");
  if (JSON.stringify(x.stops) !== JSON.stringify(y.stops)) out.push(`gradient colours ${(x.stops as string[]).join(", ")} to ${(y.stops as string[]).join(", ")}`);
  if (x.angle !== y.angle && y.angle !== undefined) out.push(`angle ${x.angle}° to ${y.angle}°`);
  if (x.type !== y.type && y.type !== undefined) out.push(`gradient ${x.type} to ${y.type}`);
  if (x.drift !== y.drift && y.drift !== undefined) out.push(`drift ${y.drift ? "on" : "off"}`);
  if (x.value !== y.value && y.value !== undefined) out.push(`colour ${x.value} to ${y.value}`);
  if ((x.html !== y.html || x.css !== y.css) && b.kind === "design") out.push(`design ${b.name ? `“${b.name}” ` : ""}changed`);
  else if (x.name !== y.name && b.kind === "design") out.push(`design named “${b.name}”`);
}
/** What changed between two looks, in plain words. */
export function describeLookChange(a: Look, b: Look): string[] {
  const out: string[] = [];
  describeBg(a.bg, b.bg, out);
  if (a.dim !== b.dim) out.push(`dim ${a.dim === "auto" ? "auto" : pct(a.dim)} to ${b.dim === "auto" ? "auto (so the words read)" : pct(b.dim)}`);
  const ta = a.type, tb = b.type;
  if (ta.font !== tb.font) out.push(`font ${ta.font ?? "the edit's"} to ${tb.font ?? "the edit's"}`);
  if (ta.weight !== tb.weight) out.push(`weight ${ta.weight} to ${tb.weight}`);
  if (ta.case !== tb.case) out.push(`case ${ta.case} to ${tb.case}`);
  if (ta.colour !== tb.colour) out.push(`words ${ta.colour} to ${tb.colour}`);
  if (ta.accent !== tb.accent) out.push(`accent ${ta.accent ?? "the edit's"} to ${tb.accent ?? "the edit's"}`);
  if (ta.scale !== tb.scale) out.push(`size ${pct(ta.scale)} to ${pct(tb.scale)}`);
  const fa = a.finish, fb = b.finish;
  if (fa.grain !== fb.grain) out.push(`grain ${pct(fa.grain)} to ${pct(fb.grain)}`);
  if (fa.vignette !== fb.vignette) out.push(`vignette ${pct(fa.vignette)} to ${pct(fb.vignette)}`);
  if (fa.push !== fb.push) out.push(`background push ${fa.push}% to ${fb.push}%`);
  return out;
}

/** Apply one change to a look (or to none: a scene still on black starts from LOOK_NEW's type and finish, on black). */
export function changeLook(current: Look | null | undefined, change: LookChange, brand: string[] = []): LookChanged {
  const was = current ? clampLook(current) : clampLook({ bg: { kind: "colour", value: BLACK }, dim: 0 });
  const next: Record<string, unknown> = { ...was, type: { ...was.type }, finish: { ...was.finish } };
  if (change.bg) {
    const kind = change.bg.kind ?? was.bg.kind;
    // A new source starts from its own defaults (a gradient from the shot's colours); the same source keeps its values.
    const base = kind === was.bg.kind ? was.bg : kind === "gradient" ? { ...bgDefaults("gradient"), stops: shuffleStops(was.palette ?? [], brand, 0).stops, seed: 0 } : bgDefaults(kind);
    next.bg = { ...base, ...change.bg, kind };
    // a new design is drawn (and timed) again: the last one's still picture is not it
    if (kind === "design" && (change.bg.html !== undefined || change.bg.css !== undefined) && change.bg.raster === undefined) delete (next.bg as Record<string, unknown>).raster;
  }
  if (change.shuffle) {
    const g = (next.bg as LookBg).kind === "gradient" ? next.bg as Extract<LookBg, { kind: "gradient" }> : { ...bgDefaults("gradient") as Extract<LookBg, { kind: "gradient" }>, seed: -1 };
    const seed = (g.seed ?? 0) + 1, made = shuffleStops(was.palette ?? [], brand, seed);
    next.bg = { ...g, stops: made.stops, angle: made.angle, seed };
  }
  if (change.dim !== undefined) next.dim = change.dim;
  if (change.type) for (const [k, v] of Object.entries(change.type)) (next.type as Record<string, unknown>)[k] = v === null ? undefined : v;
  if (change.finish) Object.assign(next.finish as object, change.finish);
  // A new background or new words colours are measured again before dimAuto is trusted (main does it on save).
  const look = clampLook(next, was);
  return { look, changed: describeLookChange(was, look) };
}

// ---- colour maths (WCAG 2.x relative luminance and contrast), the dim rule measured in qa/LOOK0

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export const rgbOf = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
export const hexOf = (c: readonly number[]) => `#${c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
export const luminance = ([r, g, b]: readonly number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** The highest background luminance at which light words still have 4.5:1, with a margin (qa/LOOK0 maxBgLum). */
export const maxBgLum = (colours: string[], margin = 0.85) => Math.min(...colours.map(c => (luminance(rgbOf(c)) + 0.05) / LOOK_CONTRAST - 0.05)) * margin;
/** The black dim (sRGB alpha) that brings the background's luminance down to L: black at alpha a scales its sRGB value by
 *  (1 - a), its luminance by about (1 - a)^2.2 (qa/LOOK0 dimFor). */
export function dimFor(bright: number, L: number): number { return bright <= L || L <= 0 ? 0 : Math.min(0.9, 1 - Math.pow(L / bright, 1 / 2.2)); }
/** A pixel's luminance under a black dim of alpha a (the dim is drawn in sRGB). */
export const dimmedLum = (rgb: readonly number[], a: number) => luminance(rgb.map(v => v * (1 - a)));
/** Light words: a darker background helps them. Dark words (a notebook's ink) need a light one instead. */
export const lightWords = (colours: string[]) => colours.every(c => luminance(rgbOf(c)) > 0.18);

/** The auto dim from what was measured: the background's bright end under the words picks it, then it goes up in small
 *  steps until 95 per cent of the pixels round every glyph reach 4.5:1 (qa/LOOK0 raised the library frame this way).
 *  ring: per type colour, the background pixels (sRGB) round its glyphs. */
export function autoDim(ring: { colour: string; pixels: number[][] }[], bright: number): { dim: number; worst: number; darkened: boolean } {
  const colours = ring.map(r => r.colour);
  if (!ring.some(r => r.pixels.length)) return { dim: 0, worst: 99, darkened: false };
  const p5 = (a: number) => Math.min(...ring.filter(r => r.pixels.length).map(r => {
    const Lt = luminance(rgbOf(r.colour)), v = r.pixels.map(px => contrast(dimmedLum(px, a), Lt)).sort((x, y) => x - y);
    return v[Math.floor(v.length * 0.05)];
  }));
  if (!lightWords(colours)) return { dim: 0, worst: r3(p5(0)), darkened: false };
  let dim = Math.round(dimFor(bright, maxBgLum(colours)) * 100) / 100, worst = p5(dim);
  for (let i = 0; i < 12 && worst < LOOK_CONTRAST && dim < 0.9; i++) { dim = Math.min(0.9, Math.round((dim + 0.04) * 100) / 100); worst = p5(dim); }
  return { dim, worst: r3(worst), darkened: dim > 0.02 };
}

// ---- Shuffle: a new gradient from the shot's own colours and the brand's (the edit's caption colours)

function seeded(seed: number): () => number {
  let h = (seed * 2654435761) >>> 0 || 1;
  return () => { h = h + 0x6D2B79F5 | 0; let t = Math.imul(h ^ h >>> 15, 1 | h); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function saturate(c: number[], s: number) { const m = (c[0] + c[1] + c[2]) / 3; return c.map(v => clamp(m + (v - m) * s, 0, 255)); }
/** Scale a colour (in sRGB) until its luminance is at most L, so words on it still read (qa/LOOK0 toLum). */
export function toLum(c: number[], L: number) { let k = 1; for (let i = 0; i < 60 && luminance(c.map(v => v * k)) > L; i++) k *= 0.92; return c.map(v => Math.round(v * k)); }
/** Shuffle n: even turns use the shot's colours, odd ones mix in the brand's; every stop is kept dark enough for light
 *  words (the darkest as the ground). The same seed always gives the same stops. */
export function shuffleStops(palette: string[], brand: string[], seed: number): { stops: string[]; from: "shot" | "brand" | "both" | "house"; angle: number } {
  // white or black words colours are not brand colours: only coloured ones join (a grey gradient is no one's brand)
  const chroma = (c: string) => { const v = rgbOf(c); return (Math.max(...v) - Math.min(...v)) / 255; };
  const shot = palette.filter(isHex), own = brand.filter(isHex).filter(c => chroma(c) > 0.15), rand = seeded(seed + 17);
  const from = shot.length && own.length ? (seed % 2 ? "both" : "shot") : shot.length ? "shot" : own.length ? "brand" : "house";
  const given = from === "both" ? [...shot.slice(0, 3), ...own] : from === "shot" ? shot : from === "brand" ? own : ["#5b2a86", "#1f3a93", "#0f5e5a", "#7a2048", "#2b2d6e"];
  // a few colours only (a brand of one): their neighbours on the colour wheel join them, so each turn is new
  const pool = given.length >= 4 ? given : [...given, ...given.flatMap(c => [hueTurn(c, 28 + 50 * rand()), hueTurn(c, -(28 + 50 * rand()))])];
  const order = pool.map(c => ({ c, k: rand() })).sort((a, b) => a.k - b.k).map(x => x.c);
  const n = Math.min(order.length, 2 + Math.floor(rand() * 2)) || 1;
  const picked = order.slice(0, Math.max(1, n));
  const byL = picked.map(c => rgbOf(c)).sort((a, b) => luminance(a) - luminance(b));
  const ground = toLum(saturate(byL[0], 1.1), 0.008), rest = byL.slice(1).map(c => toLum(saturate(c, 1.3 + 0.2 * rand()), 0.06 + 0.03 * rand()));
  const stops = [ground, ...rest].map(hexOf);
  while (stops.length < 2) stops.push(hexOf(toLum(saturate(rgbOf(hueTurn(stops[0], 40)), 1.4).map(v => v * 1.8), 0.05)));
  return { stops, from, angle: Math.round(rand() * 36) * 10 };
}
/** A colour turned round the colour wheel by deg (its lightness and saturation kept). */
function hueTurn(hex: string, deg: number): string {
  const [r, g, b] = rgbOf(hex).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-6) return hex;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h * 60 + deg) % 360 + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return hexOf([R + m, G + m, B + m].map(v => v * 255));
}

/** The shot's own colours from a small picture (rgb bytes): a tiny deterministic k-means, biggest clusters first
 *  (qa/LOOK0 palette). */
export function paletteOf(rgb: ArrayLike<number>, k = 4): string[] {
  const px: number[][] = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) px.push([rgb[i], rgb[i + 1], rgb[i + 2]]);
  if (!px.length) return [];
  const sorted = [...px].sort((a, b) => luminance(a) - luminance(b));
  let c = Array.from({ length: k }, (_, i) => sorted[Math.floor((i + 0.5) / k * sorted.length)].slice());
  let share = c.map(() => 0);
  for (let it = 0; it < 10; it++) {
    const sum = c.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let bi = 0, bd = Infinity;
      c.forEach((q, i) => { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
      const s = sum[bi]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    c = c.map((q, i) => sum[i][3] ? [sum[i][0] / sum[i][3], sum[i][1] / sum[i][3], sum[i][2] / sum[i][3]] : q);
    share = sum.map(s => s[3] / px.length);
  }
  return c.map((q, i) => ({ hex: hexOf(q), share: share[i] })).sort((a, b) => b.share - a.share).map(x => x.hex);
}
