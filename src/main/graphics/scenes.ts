import { clampMotion, type Motion, type MotionElement } from "../../shared/motion";
import { BLACK, clampLook, lookDim, type Look, type LookCase } from "../../shared/look";

// SCN1a (docs/plans/produced/scenes-spike.md): the four full-screen scenes, ported from the SCN0 second pass. A scene
// is made of his words and his frames only, on black. Its look is its params (words, accent, size, layout, place,
// margin, tilt, grid, order, landing pattern, captions); its time and feel are graphic.motion (shared/motion.ts), one
// element per word, line, landing of tiles or flash of frames, with times in seconds from the scene's start. So "the
// second word half a beat later, softer" is two numbers in motion, and a new layout is one param; neither is code.
//
// House motion from the launch video (remotion/src/precut): the slam (1.5 to 0.97 by frame 2, 1 by frame 6, ease-out),
// the SNAP spring (damping 24, stiffness 340, mass 0.45), the two-frame exposure flash (softened to 0.7 on tiles), a slow
// push so nothing sits dead. Outfit 800 italic, lowercase like the captions, one accent from the edit's theme. Laid out
// in frame units every frame (a full graphic is drawn at the frame's own size), fitted inside the margin with room for
// the push and the landing, so nothing clips at 9:16, 1:1 or 16:9. No blur, glow, shadow, outline or stroke.
//
// Frames are shoot-cache handles (the PRO4b card path): the html names frame i once as src="#frame-i" and the title
// page draws the file in. Nothing inline. This file must not import templates.ts at run time (templates.ts lists these).

export interface SceneTheme { font: string; accent: string; ink: string; tone?: "dark" | "light" }
export interface SceneParam { name: string; label: string; type: "text" | "number" | "list" | "choice" | "image"; default: unknown; options?: string[] }
export interface SceneBuilt { html: string; css: string; js: string; frames?: string[]; motion: Motion }
export interface SceneTemplate {
  id: string; name: string; kind: "scene"; about: string; frame: "full"; widthPx: number; heightPx: number; durationS: number; params: SceneParam[];
  build(p: Record<string, unknown>, theme: SceneTheme, durationS: number, motion?: unknown, look?: Look | null): SceneBuilt;
}
type Params = Record<string, unknown>;

/** A scene's picture: a content-named file in the shoot's cache (the same names as graphics/templates.ts CARD_MEDIA). */
export const SCENE_FRAME = /^card-[a-f0-9]{32}\.webp$/;
export const SCENE_FRAME_TEMPLATES = ["scene-frame-wall", "scene-memories"];
export const SCENE_LIMITS = { words: 8, wordChars: 24, lineChars: 40, wallFrames: 25, memoryFrames: 32 } as const;
export const frameSrc = (i: number) => `#frame-${i}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const num = (p: Params, key: string, fallback: number, lo: number, hi: number) => typeof p[key] === "number" && Number.isFinite(p[key]) ? clamp(p[key] as number, lo, hi) : fallback;
const pick = <T extends string>(p: Params, key: string, options: T[], fallback: T): T => options.includes(p[key] as T) ? p[key] as T : fallback;
const str = (p: Params, key: string, max: number) => typeof p[key] === "string" ? (p[key] as string).replace(/\s+/g, " ").trim().slice(0, max) : "";
function words(p: Params): string[] {
  const raw = p.words, items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\n|;/) : [];
  return items.map(w => typeof w === "string" ? w.replace(/\s+/g, " ").trim().slice(0, SCENE_LIMITS.wordChars) : "").filter(Boolean).slice(0, SCENE_LIMITS.words);
}
function frames(p: Params, max: number): string[] {
  const raw = Array.isArray(p.frames) ? p.frames : [];
  return [...new Set(raw.filter((f): f is string => typeof f === "string" && SCENE_FRAME.test(f)))].slice(0, max);
}
// LOOK1: the look's case wins over the scene's own param when the scene has a look.
const said = (text: string, p: Params, look?: Look | null) => { const c: LookCase = look ? look.type.case : pick(p, "case", ["lower", "as said"], "lower"); return c === "lower" ? text.toLocaleLowerCase("en") : c === "upper" ? text.toLocaleUpperCase("en") : text; };
const family = (theme: SceneTheme) => `"${theme.font.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 40) || "Outfit"}","Outfit","Inter Display",sans-serif`;
const accentOf = (theme: SceneTheme) => /^#[0-9a-f]{6}$/i.test(theme.accent) ? theme.accent : "#5b8cff";
const wrap = (id: string, p: Params, inner: string) => `<div class="root" data-gfx-template="${id}" data-gfx-params="${esc(JSON.stringify(p))}">${inner}</div>`;
// The scene's own dark world: never the edit's light card colours, and it cuts out on a cut (no exit fade).
// LOOK1: with a look, the ground is its flat colour (black otherwise) and the look's layers sit under the words.
const BASE = (theme: SceneTheme, ground = BLACK) => `:root{--font:${family(theme)};--accent:${accentOf(theme)}}#gfx{-webkit-font-smoothing:antialiased;background:${ground}}`
  + `.root{position:absolute;inset:0;overflow:hidden;background:${ground}}.g{position:absolute;inset:0}`;
// A fixed pattern from the scene's own content, so a random order is the same every time it is drawn.
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = h + 0x6D2B79F5 | 0; let t = Math.imul(h ^ h >>> 15, 1 | h); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** The motion for these elements: the ones already there keep their times and anchors (matched by id); new ones take
 *  the default times; ones no longer there are dropped. */
function motionFor(ids: string[], defaults: number[], input: unknown, base: Partial<Motion>): Motion {
  const given = input ? clampMotion(input, base) : clampMotion({}, base);
  const byId = new Map(given.elements.map(e => [e.id, e]));
  const elements: MotionElement[] = ids.map((id, i) => byId.get(id) ?? { id, at: r4(defaults[i] ?? 0) });
  return { ...given, elements };
}

// ---- the shared moves, in the graphic's own js (seconds; frames counted at 30 fps like the trailer)
const KIT = `var F=1/30,EPS=2e-3;   // a landing counts from 2 ms before its time (times are stored to 0.1 ms)

function c01(x){return Math.min(1,Math.max(0,x));}
function eo(x){x=c01(x);return 1-Math.pow(1-x,3);}
function slam(a,k){var f=a/F,hi=1+0.5*k,lo=1-0.03*k;if(f<2)return hi+(lo-hi)*eo(f/2);if(f<6)return lo+(1-lo)*eo((f-2)/4);return 1;}
var Z=24/(2*Math.sqrt(340*0.45)),W0=Math.sqrt(340/0.45),WD=W0*Math.sqrt(1-Z*Z);
function spring(t){return t<=0?0:1-Math.exp(-Z*W0*t)*(Math.cos(WD*t)+Z*W0/WD*Math.sin(WD*t));}
function snap(a,k){return 1+0.22*k*(1-spring(a));}
function flash(a,k){var f=Math.floor(a/F+1e-6);return f===0?1+0.9*k:f===1?1+0.35*k:1;}
function peak(st,k){return st==='slam'?1+0.5*k:st==='snap'?1+0.22*k:1;}
// a landing at age a: [scale, brightness, opacity]
function land(st,a,k){if(st==='slam')return [slam(a,k),1,1];if(st==='snap')return [snap(a,k),1,1];if(st==='flash')return [1,flash(a,k),1];if(st==='fade')return [1,1,eo(a/0.25)];return [1,1,1];}
// the margin box the ink keeps inside, before the push (which grows everything about O by up to PM)
function box(W,H,M,O,PM){var m=M*W;return [O[0]-(O[0]-m)/PM,O[0]+(W-m-O[0])/PM,O[1]-(O[1]-m)/PM,O[1]+(H-m-O[1])/PM];}
// how much of the landing fits and where it grows from: the ink (centre c, half extents hx, hy) stays inside b
function room(cx,cy,hx,hy,pk,b){var s=Math.min(pk,Math.max(1,Math.min((b[1]-b[0])/(2*hx),(b[3]-b[2])/(2*hy)))),ox=cx,oy=cy;
if(s>1){ox=Math.min(Math.max(cx,((cx+hx)*s-b[1])/(s-1)),((cx-hx)*s-b[0])/(s-1));oy=Math.min(Math.max(cy,((cy+hy)*s-b[3])/(s-1)),((cy-hy)*s-b[2])/(s-1));}
return [pk>1?(s-1)/(pk-1):1,ox,oy];}
// a w x h box rotated th about its centre, its centre at (cx,cy), scaled f, then by the landing s about (ox,oy)
function put(n,w,h,cx,cy,th,f,s,ox,oy){var c=Math.cos(th),si=Math.sin(th),lx=w/2,ly=h/2,k=s*f;
n.style.transform='translate('+(ox+s*(cx-ox)-k*(c*lx-si*ly)).toFixed(2)+'px,'+(oy+s*(cy-oy)-k*(si*lx+c*ly)).toFixed(2)+'px) rotate('+(th*57.29578).toFixed(3)+'deg) scale('+k.toFixed(4)+')';}
function show(n,o,b){n.style.opacity=o>=1?'1':o.toFixed(3);n.style.filter=b>1?'brightness('+b.toFixed(3)+')':'none';}`;
const TEXT_CSS = `.w{position:absolute;left:0;top:0;transform-origin:0 0;white-space:nowrap;font-family:var(--font);font-weight:800;line-height:1;letter-spacing:-0.025em;padding-right:0.06em;color:#fff;opacity:0}`
  + `.w.i{font-style:italic}.w.a{color:var(--accent)}`;
const motionJs = (m: Motion, count: number) => `var AT=${JSON.stringify(m.elements.slice(0, count).map(e => e.at))},ST=${JSON.stringify(m.elements.slice(0, count).map(e => e.style ?? m.style))},KK=${JSON.stringify(m.elements.slice(0, count).map(e => e.strength ?? m.strength))},P=${r4(m.push / 100)};`;

// ---- LOOK1: the scene's look (shared/look.ts), drawn under its words or frames: the background (his shot or a picture
// from the shoot's cache as one more frame handle, a gradient, a design written as html and css, a flat colour), the
// vignette, the dim that keeps the words reading, the grain, the background's slow push, and the type. Everything is a
// function of t, so live, scrubbed and exported frames match. Words keep off a face in a picture (bg.face): before the
// first frame of each size, the words' place (CY) is tried at the scene's landings and the nearest one clear of it kept.
function base64(text: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i), b = text.charCodeAt(i + 1), c = text.charCodeAt(i + 2), n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += A[n >> 18 & 63] + A[n >> 12 & 63] + (i + 1 < text.length ? A[n >> 6 & 63] : "=") + (i + 2 < text.length ? A[n & 63] : "=");
  }
  return out;
}
// Film grain drawn by Chromium (feTurbulence), nothing loaded: a neutral grey noise tile.
const GRAIN = `url("data:image/svg+xml;base64,${base64(`<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' seed='7' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 1.6 -0.3'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`)}")`;
const FONTS = ["Outfit", "Inter Display", "Montserrat", "Poppins", "Bebas Neue", "Archivo Black", "Caveat"];
export interface ScenePaint { html: string; css: string; js: string; ground: string; frame?: string; scale: number }
/** The look's layers for a scene whose picture handle (if any) is frame k. */
export function scenePaint(look: Look, theme: SceneTheme, d: number, k: number): ScenePaint {
  const bg = look.bg, dim = lookDim(look), f = look.finish;
  const picture = bg.kind === "shot" || bg.kind === "image" ? bg.media : bg.kind === "design" ? bg.raster : undefined;
  const ground = bg.kind === "colour" ? bg.value : bg.kind === "gradient" ? bg.stops[0] : BLACK;
  const img = picture && SCENE_FRAME.test(picture) ? `<img class="lk-img" alt="" src="${frameSrc(k)}">` : "";
  const inner = img || (bg.kind === "gradient" ? `<div class="lk-grad"></div>` : bg.kind === "design" ? `<div class="lk-design">${bg.html}</div>` : "");
  const html = `<div class="lk-bg">${inner}</div>${f.vignette > 0 ? `<div class="lk-vig"></div>` : ""}${dim > 0 ? `<div class="lk-dim"></div>` : ""}${f.grain > 0 ? `<div class="lk-grain"></div>` : ""}`;
  const font = look.type.font && FONTS.includes(look.type.font) ? `"${look.type.font}",` : "";
  const css = `.lk-bg,.lk-vig,.lk-dim,.lk-grain{position:absolute;inset:0;pointer-events:none}.lk-bg{overflow:hidden;background:${ground};transform-origin:50% 50%}`
    + (img ? `.lk-img{position:absolute;left:0;top:0;width:100%;height:100%;display:block;max-width:none;object-fit:cover}` : "")
    + (bg.kind === "gradient" && !img ? `.lk-grad{position:absolute;inset:-12%}` : "")
    + (bg.kind === "design" && !img ? `.lk-design{position:absolute;inset:0;overflow:hidden}${bg.css}` : "")
    + (f.vignette > 0 ? `.lk-vig{background:radial-gradient(ellipse 80% 75% at 50% 50%,transparent 45%,rgba(0,0,0,${r4(0.8 * f.vignette)}) 100%)}` : "")
    + (dim > 0 ? `.lk-dim{background:rgba(0,0,0,${r4(dim)})}` : "")
    + (f.grain > 0 ? `.lk-grain{inset:-12%;background-image:${GRAIN};background-size:256px 256px;opacity:${r4(0.55 * f.grain)}}` : "")
    + `.w{font-family:${font}var(--font);font-weight:${look.type.weight};color:${look.type.colour}}.w.a{color:${look.type.accent ?? accentOf(theme)}}`;
  const blur = (bg.kind === "shot" || bg.kind === "image") && img ? bg.blur / 100 * 0.04 : 0;
  const grad = bg.kind === "gradient" && !img ? bg : null;
  const face = bg.kind === "image" && img && bg.face ? bg.face : null;
  const js = `
var LKD=${r4(d)},LKP=${r4(f.push / 100)},LKB=${r4(blur)},LKS='',LKF=${JSON.stringify(face)},LKK='',LKG=${grad ? JSON.stringify({ s: grad.stops, a: grad.angle, y: grad.type, d: grad.drift }) : "null"};
// the picture bleeds past the frame by enough for the push and the blur's soft edge
function lkLay(el){var W=el.clientWidth,H=el.clientHeight,img=el.querySelector('.lk-img'),key=W+'x'+H;if(LKS===key)return;LKS=key;if(!img)return;
var s=LKB*Math.min(W,H),m=0.02*Math.max(W,H)+2.5*s;Object.assign(img.style,{left:(-m).toFixed(1)+'px',top:(-m).toFixed(1)+'px',width:(W+2*m).toFixed(1)+'px',height:(H+2*m).toFixed(1)+'px',filter:s>0.3?'blur('+s.toFixed(2)+'px)':'none'});}
function lkGrad(t){var g=LKG,s=g.s,dr=g.d?1:0,w=2*Math.PI*t;
if(g.y==='linear')return 'linear-gradient('+(g.a+dr*14*Math.sin(w/9)).toFixed(2)+'deg,'+s.map(function(c,i){return c+' '+(i/(s.length-1)*100).toFixed(1)+'%';}).join(',')+')';
if(g.y==='radial')return 'radial-gradient(ellipse 95% 80% at '+(50+dr*12*Math.sin(w/8)).toFixed(2)+'% '+(42+dr*9*Math.cos(w/10)).toFixed(2)+'%,'+s.slice().reverse().map(function(c,i){return c+' '+(i/(s.length-1)*100).toFixed(1)+'%';}).join(',')+')';
var P=[[0.22,0.2,7,0],[0.8,0.55,9,2.1],[0.35,0.88,11,4.2]],o=[];for(var i=1;i<s.length;i++){var p=P[(i-1)%3],x=(p[0]+dr*0.13*Math.sin(w/p[2]+p[3]))*100,y=(p[1]+dr*0.1*Math.cos(w/p[2]+p[3]))*100;
o.push('radial-gradient(ellipse 75% 60% at '+x.toFixed(2)+'% '+y.toFixed(2)+'%,'+s[i]+' 0%,transparent 70%)');}return o.join(',')+(o.length?',':'')+s[0];}
// LOOK1 story 5: the words' place (CY) clear of the face in the picture, chosen once per frame size
function lkClear(el){if(!LKF||typeof CY!=='number')return;var img=el.querySelector('.lk-img');if(!img||!img.naturalWidth)return;var W=el.clientWidth,H=el.clientHeight,key=W+'x'+H+':'+img.naturalWidth;if(LKK===key)return;LKK=key;
var bw=img.offsetWidth,bh=img.offsetHeight,sc=Math.max(bw/img.naturalWidth,bh/img.naturalHeight),dw=img.naturalWidth*sc,dh=img.naturalHeight*sc,ox=img.offsetLeft+(bw-dw)/2,oy=img.offsetTop+(bh-dh)/2,gw=0.06*Math.min(W,H);
var F=[ox+LKF[0]*dw-gw,oy+LKF[1]*dh-gw,ox+(LKF[0]+LKF[2])*dw+gw,oy+(LKF[1]+LKF[3])*dh+gw],c0=LKCY,cands=[c0],best=c0,low=1e18,i,j;
for(var c=0.3;c<=0.6001;c+=0.02)cands.push(Math.round(c*1000)/1000);cands.sort(function(a,b){return Math.abs(a-c0)-Math.abs(b-c0);});
var ts=AT.map(function(a){return Math.min(LKD-1e-3,a+0.35);}).concat([LKD-1e-3]),r0=el.getBoundingClientRect();
for(i=0;i<cands.length;i++){CY=cands[i];var hit=0;for(j=0;j<ts.length;j++){LK_R0(ts[j],el);var ws=el.querySelectorAll('.w');for(var q=0;q<ws.length;q++){if(ws[q].style.opacity==='0')continue;var r=ws[q].getBoundingClientRect(),x0=r.left-r0.left,y0=r.top-r0.top;
hit+=Math.max(0,Math.min(x0+r.width,F[2])-Math.max(x0,F[0]))*Math.max(0,Math.min(y0+r.height,F[3])-Math.max(y0,F[1]));}}
if(hit<low-1e-6){low=hit;best=cands[i];}if(hit<=0)break;}CY=best;}
function lkRender(t,el){lkLay(el);var bg=el.querySelector('.lk-bg');if(LKP>0)bg.style.transform='scale('+(1+LKP*c01(t/LKD)).toFixed(4)+')';
if(LKG){var gr=el.querySelector('.lk-grad'),v=lkGrad(t);if(gr&&gr.style.background!==v)gr.style.background=v;}
var gn=el.querySelector('.lk-grain');if(gn){var f=Math.floor(t*24+1e-6);gn.style.transform='translate('+((f*37)%23-11)*3+'px,'+((f*53)%19-9)*3+'px)';}}
var LKCY=typeof CY==='number'?CY:0,LK_R0=render;render=function(t,el){lkLay(el);lkClear(el);LK_R0(t,el);lkRender(t,el);};`;
  return { html, css, js, ground, ...(img ? { frame: picture } : {}), scale: look.type.scale };
}
/** The look a template draws, or none (today's black). */
const lookOf = (input: Look | null | undefined): Look | null => input ? clampLook(input) : null;
/** A scene's html, css, js and pictures with its look laid under it; without a look, exactly as before (on black). */
function painted(id: string, p: Params, inner: string, css: string, js: string, theme: SceneTheme, d: number, look: Look | null, pictures: string[] = []): Pick<SceneBuilt, "html" | "css" | "js" | "frames"> {
  if (!look) return { html: wrap(id, p, inner), css: BASE(theme) + css, js, ...(pictures.length ? { frames: pictures } : {}) };
  const paint = scenePaint(look, theme, d, pictures.length), frames = paint.frame ? [...pictures, paint.frame] : pictures;
  return { html: wrap(id, p, paint.html + inner), css: BASE(theme, paint.ground) + css + paint.css, js: js + paint.js, ...(frames.length ? { frames } : {}) };
}

const LOOK: Record<string, SceneParam> = {
  size: { name: "size", label: "Size (per cent of the frame width, it always fits)", type: "number", default: 21 },
  position: { name: "position", label: "Position (centre, fraction of the height)", type: "number", default: 0.46 },
  margin: { name: "margin", label: "Margin (fraction of the width)", type: "number", default: 0.07 },
  case: { name: "case", label: "Case", type: "choice", default: "lower", options: ["lower", "as said"] },
  captions: { name: "captions", label: "Captions", type: "choice", default: "step aside", options: ["step aside", "stay"] },
};
// LOOK1: the look's type size scales the scene's own (the fit still keeps every word inside the margin).
const look = (p: Params, lk?: Look | null) => ({ size: lk ? r4(num(p, "size", 21, 12, 30) / 100 * lk.type.scale) : num(p, "size", 21, 12, 30) / 100, position: num(p, "position", 0.46, 0.3, 0.6), margin: num(p, "margin", 0.07, 0.04, 0.12) });

export const SCENE_TEMPLATES: SceneTemplate[] = [
  {
    // His words, one landing at a time: a staircase or a stack that builds, or one huge word at a time in the centre.
    id: "scene-beat-words", name: "Beat words", kind: "scene", frame: "full", widthPx: 1080, heightPx: 1920, durationS: 1.2,
    about: "His own words slammed onto black one at a time, on his voice or the beat, one of them in the accent colour.",
    params: [{ name: "words", label: "Words (his own, one per line, up to 8)", type: "list", default: [] },
      { name: "accent", label: "Accent (which word, from 1; 0 = the last)", type: "number", default: 0 }, LOOK.size,
      { name: "layout", label: "Layout", type: "choice", default: "staircase", options: ["staircase", "stack", "centred"] }, LOOK.position, LOOK.margin, LOOK.case, LOOK.captions],
    build(p, theme, d, input, lookIn) {
      const list = words(p), lk = lookOf(lookIn);
      if (!list.length) throw new Error("A beat-words scene shows his own words. Give it the words he says here.");
      const accent = (Math.round(num(p, "accent", 0, 0, list.length)) || list.length) - 1, layout = pick(p, "layout", ["staircase", "stack", "centred"], "staircase"), { size, position, margin } = look(p, lk);
      const step = clamp(d * 0.7 / list.length, 0.12, 0.5);
      const m = motionFor(list.map((_, i) => `w${i}`), list.map((_, i) => i * step), input, { timing: "words", style: "slam", push: 3, holdBeats: 0.5 });
      const html = `<div class="g">${list.map((w, i) => `<div class="w i${i === accent ? " a" : ""}">${esc(said(w, p, lk))}</div>`).join("")}</div>`;
      const js = `${KIT}${motionJs(m, list.length)}var D=${r4(d)},SZ=${size},M=${margin},CY=${position},LAY=${JSON.stringify(layout)};
function render(t,el){var W=el.clientWidth,H=el.clientHeight,g=el.querySelector('.g'),ws=el.querySelectorAll('.w'),n=ws.length,fs=W*SZ,PM=1+P,O=[W/2,H*CY],b=box(W,H,M,O,PM);
var PL=0.08*fs,PR=0.16*fs,PY=0.16*fs,w=[],x=[],y=[],i;
for(i=0;i<n;i++){if(ws[i].style.fontSize!==fs.toFixed(2)+'px')ws[i].style.fontSize=fs.toFixed(2)+'px';w[i]=ws[i].offsetWidth;}
for(i=0;i<n;i++){x[i]=LAY==='staircase'?i*0.36*fs:LAY==='stack'?0:-w[i]/2;y[i]=LAY==='staircase'?i*1.08*fs:LAY==='stack'?i*1.05*fs:0;}
g.style.transformOrigin=O[0].toFixed(1)+'px '+O[1].toFixed(1)+'px';g.style.transform='scale('+(1+P*c01(t/D)).toFixed(4)+')';
// the whole group (one word at a time when centred) is fitted inside the margin, then centred on O
function fit(a,z){var x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;for(var j=a;j<z;j++){x0=Math.min(x0,x[j]-PL);x1=Math.max(x1,x[j]+w[j]+PR);y0=Math.min(y0,y[j]-PY);y1=Math.max(y1,y[j]+fs+PY);}
var f=Math.min(1,(b[1]-b[0])/(x1-x0),2*Math.min(O[1]-b[2],b[3]-O[1])/(y1-y0),H*0.62/(y1-y0));return [f,(x0+x1)/2,(y0+y1)/2];}
var all=LAY==='centred'?null:fit(0,n);
for(i=0;i<n;i++){var n1=ws[i],a=t-AT[i]+EPS;
if(a<0||(LAY==='centred'&&i<n-1&&t-AT[i+1]+EPS>=0)){n1.style.opacity='0';continue;}
var q=all||fit(i,i+1),f=q[0],cx=O[0]+(x[i]+w[i]/2-q[1])*f,cy=O[1]+(y[i]+fs/2-q[2])*f,icx=cx+(PR-PL)/2*f,hx=(w[i]/2+(PL+PR)/2)*f,hy=(fs/2+PY)*f;
var r=room(icx,cy,hx,hy,peak(ST[i],KK[i]),b),e=land(ST[i],a,KK[i]*r[0]);
put(n1,w[i],fs,cx,cy,0,f,e[0],r[1],r[2]);show(n1,e[2],e[1]);}}`;
      return { ...painted("scene-beat-words", p, html, TEXT_CSS, js, theme, d, lk), motion: m };
    },
  },
  {
    // A line slammed onto black like the next level: the first upright, the second italic and tilted, like the trailer's
    // "now make it / yours."
    id: "scene-title-slam", name: "Title slam", kind: "scene", frame: "full", widthPx: 1080, heightPx: 1920, durationS: 1.3,
    about: "One or two lines of his own words slammed onto black, the second tilted, one of them in the accent colour.",
    params: [{ name: "line1", label: "First line (his own words)", type: "text", default: "" }, { name: "line2", label: "Second line (his own words)", type: "text", default: "" },
      { name: "accent", label: "Accent (which line, 1 or 2)", type: "number", default: 2 }, LOOK.size,
      { name: "tilt", label: "Tilt of the second line (degrees, -6 to 0)", type: "number", default: -3 }, LOOK.position, LOOK.margin, LOOK.case, LOOK.captions],
    build(p, theme, d, input, lookIn) {
      const lk = lookOf(lookIn), lines = [str(p, "line1", SCENE_LIMITS.lineChars), str(p, "line2", SCENE_LIMITS.lineChars)].filter(Boolean);
      if (!lines.length) throw new Error("A title slam shows his own words. Give it a line he says.");
      const accent = (Math.round(num(p, "accent", 0, 0, lines.length)) || lines.length) - 1, tilt = num(p, "tilt", -3, -6, 0), { size, position, margin } = look(p, lk);
      const m = motionFor(lines.map((_, i) => `l${i + 1}`), lines.map((_, i) => i * r4(d * 0.5)), input, { timing: "beats", style: "slam", push: 3, holdBeats: 1 });
      const html = `<div class="g">${lines.map((l, i) => `<div class="w${i === 1 || lines.length === 1 ? " i" : ""}${i === accent ? " a" : ""}">${esc(said(l, p, lk))}</div>`).join("")}</div>`;
      const js = `${KIT}${motionJs(m, lines.length)}var D=${r4(d)},SZ=${size},M=${margin},CY=${position},TH=${r4(tilt * Math.PI / 180)};
function render(t,el){var W=el.clientWidth,H=el.clientHeight,g=el.querySelector('.g'),ls=el.querySelectorAll('.w'),n=ls.length,PM=1+P,O=[W/2,H*CY],b=box(W,H,M,O,PM);
g.style.transformOrigin=O[0].toFixed(1)+'px '+O[1].toFixed(1)+'px';g.style.transform='scale('+(1+P*c01(t/D)).toFixed(4)+')';
var fs=[n>1?W*SZ*0.83:W*SZ,W*SZ],th=[n>1?0:TH,TH],gap=0.03*W*SZ;
for(var i=0;i<n;i++){var l=ls[i],z=fs[i],tt=th[i],cs=Math.cos(tt),sn=Math.abs(Math.sin(tt));if(l.style.fontSize!==z.toFixed(2)+'px')l.style.fontSize=z.toFixed(2)+'px';
var w=l.offsetWidth,PX=0.16*z,PY=0.16*z,iw=w/2+PX,ih=z/2+PY,hx=iw*cs+ih*sn,hy=iw*sn+ih*cs;
// each line fits the width; the first sits above the centre line, the second below it (one line sits on it)
var f=Math.min(1,(b[1]-b[0])/(2*hx)),cy;
if(n===1){f=Math.min(f,2*Math.min(O[1]-b[2],b[3]-O[1])/(2*hy));cy=O[1];}
else if(i===0){f=Math.min(f,(O[1]-gap-b[2])/(2*hy));cy=O[1]-gap-hy*f;}
else{f=Math.min(f,(b[3]-O[1]-gap)/(2*hy));cy=O[1]+gap+hy*f;}
var a=t-AT[i]+EPS;if(a<0){l.style.opacity='0';continue;}
var r=room(O[0],cy,hx*f,hy*f,peak(ST[i],KK[i]),b),e=land(ST[i],a,KK[i]*r[0]);
put(l,w,z,O[0],cy,tt,f,e[0],r[1],r[2]);show(l,e[2],e[1]);}}`;
      return { ...painted("scene-title-slam", p, html, TEXT_CSS, js, theme, d, lk), motion: m };
    },
  },
  {
    // His frames land as tiles on the beats and fill the frame, the centre first so it is never a sparse frame on black.
    id: "scene-frame-wall", name: "Frame wall", kind: "scene", frame: "full", widthPx: 1080, heightPx: 1920, durationS: 2,
    about: "His own frames land as a wall of tiles on the music, the centre first, with a slow push.",
    params: [{ name: "frames", label: "Frames (from the shoot)", type: "image", default: [] },
      { name: "cols", label: "Columns (2 to 5)", type: "number", default: 4 }, { name: "rows", label: "Rows (2 to 5)", type: "number", default: 4 },
      { name: "order", label: "Order", type: "choice", default: "centre out", options: ["centre out", "story", "random"] },
      { name: "landing", label: "Landing pattern", type: "choice", default: "centre four then threes", options: ["centre four then threes", "one by one", "pairs", "all together"] }, LOOK.captions],
    build(p, theme, d, input, lookIn) {
      const all = frames(p, SCENE_LIMITS.wallFrames), lk = lookOf(lookIn);
      if (all.length < 4) throw new Error("Not enough shots for a wall here. A wall needs at least 4 of his frames; try beat words.");
      let cols = Math.round(num(p, "cols", 4, 2, 5)), rows = Math.round(num(p, "rows", 4, 2, 5));
      while (cols * rows > all.length) { if (rows >= cols && rows > 2) rows--; else if (cols > 2) cols--; else rows--; }
      const used = all.slice(0, cols * rows), n = used.length, order = pick(p, "order", ["centre out", "story", "random"], "centre out");
      const rand = seeded(used.join(","));
      // slot for each frame (frames keep their story order; the order says where each one sits)
      const cells = Array.from({ length: n }, (_, i) => i), cc = (cols - 1) / 2, rc = (rows - 1) / 2, dist = (i: number) => Math.hypot(i % cols - cc, Math.floor(i / cols) - rc);
      const jitter = cells.map(() => rand());
      const slots = order === "story" ? cells : order === "random" ? [...cells].sort((a, b) => jitter[a] - jitter[b])
        : [...cells].sort((a, b) => Math.round(dist(a) * 100) - Math.round(dist(b) * 100) || jitter[a] - jitter[b]);
      const landing = pick(p, "landing", ["centre four then threes", "one by one", "pairs", "all together"], "centre four then threes");
      const sizes: number[] = [];
      for (let left = n, k = 0; left > 0; k++) { const s = landing === "all together" ? left : landing === "one by one" ? 1 : landing === "pairs" ? 2 : k === 0 ? 4 : 3; sizes.push(Math.min(left, s)); left -= Math.min(left, s); }
      const group = sizes.flatMap((s, k) => Array(s).fill(k) as number[]);
      const step = clamp(d * 0.6 / sizes.length, 0.08, 0.33);
      const m = motionFor(sizes.map((_, k) => `g${k}`), sizes.map((_, k) => k * step), input, { timing: "beats", style: "snap", push: 3.5, holdBeats: 0.5 });
      const html = `<div class="g">${used.map((_, i) => `<img class="t" alt="" src="${frameSrc(i)}">`).join("")}</div>`;
      const css = `.t{position:absolute;left:0;top:0;display:block;object-fit:cover;opacity:0;transform-origin:50% 50%}`;
      const js = `${KIT}${motionJs(m, sizes.length)}var D=${r4(d)},C=${cols},R=${rows},SL=${JSON.stringify(slots)},GR=${JSON.stringify(group)},SZ='';
function render(t,el){var W=el.clientWidth,H=el.clientHeight,g=el.querySelector('.g'),ts=el.querySelectorAll('.t'),gp=W*0.0074,tw=(W-(C+1)*gp)/C,th=(H-(R+1)*gp)/R,i;
g.style.transformOrigin='50% 50%';g.style.transform='scale('+(1+P*c01(t/D)).toFixed(4)+')';
if(SZ!==W+'x'+H){SZ=W+'x'+H;for(i=0;i<ts.length;i++){var s=SL[i],c=s%C,r=Math.floor(s/C);Object.assign(ts[i].style,{left:(gp+c*(tw+gp)).toFixed(1)+'px',top:(gp+r*(th+gp)).toFixed(1)+'px',width:tw.toFixed(1)+'px',height:th.toFixed(1)+'px',borderRadius:(W*0.012).toFixed(1)+'px'});}}
for(i=0;i<ts.length;i++){var k=GR[i],a=t-AT[k]+EPS;if(a<0){ts[i].style.opacity='0';continue;}
// tiles land with a softened exposure flash unless they cut or fade in
var e=land(ST[k],a,KK[k]),bb=ST[k]==='flash'?e[1]:ST[k]==='cut'||ST[k]==='fade'?1:flash(a,0.7*KK[k]);
ts[i].style.transform='scale('+e[0].toFixed(4)+')';show(ts[i],e[2],bb);}}`;
      return { ...painted("scene-frame-wall", p, html, css, js, theme, d, lk, used), motion: m };
    },
  },
  {
    // His frames flash in the dark and multiply: one big, then two, four, eight together, packed close with a slight
    // scatter, each a few frames of light that drifts and dims until the next lands; the last flash holds. A picture's
    // short side is about 60, 40, 30 and 22 per cent of the frame's short side (the trailer's memories act), less only
    // where the margin needs it.
    id: "scene-memories", name: "Memories", kind: "scene", frame: "full", widthPx: 1080, heightPx: 1920, durationS: 2,
    about: "His own frames flash in the dark and multiply, one big, then two, four and eight together, on the music.",
    params: [{ name: "frames", label: "Frames (from the shoot)", type: "image", default: [] },
      { name: "pattern", label: "Pattern", type: "choice", default: "multiplying", options: ["multiplying", "one at a time", "pairs"] },
      { name: "margin", label: "Margin (fraction of the short side)", type: "number", default: 0.05 }, LOOK.captions],
    build(p, theme, d, input, lookIn) {
      const used = frames(p, SCENE_LIMITS.memoryFrames), lk = lookOf(lookIn);
      if (used.length < 2) throw new Error("Not enough shots for memories here. They need at least 2 of his frames; try beat words.");
      const pattern = pick(p, "pattern", ["multiplying", "one at a time", "pairs"], "multiplying"), margin = num(p, "margin", 0.05, 0.03, 0.12);
      const run = [1, 1, 2, 2, 4, 4, 8, 8, 8, 8], sizes: number[] = [];
      for (let left = used.length, k = 0; left > 0; k++) { const s = Math.min(left, pattern === "one at a time" ? 1 : pattern === "pairs" ? 2 : run[Math.min(k, run.length - 1)]); sizes.push(s); left -= s; }
      // the scatter: each picture a little smaller than its cell (0.9 to 1) and nudged inside the room that leaves
      const rand = seeded(used.join(",")), scatter = used.map(() => [r4(rand() * 2 - 1), r4(rand() * 2 - 1), r4(0.9 + rand() * 0.1)]);
      const group = sizes.flatMap((s, k) => Array(s).fill(k) as number[]);
      const step = clamp(d * 0.75 / sizes.length, 0.08, 0.33);
      const m = motionFor(sizes.map((_, k) => `m${k}`), sizes.map((_, k) => k * step), input, { timing: "beats", style: "flash", push: 2, holdBeats: 0.5 });
      const html = `<div class="g">${used.map((_, i) => `<img class="t" alt="" src="${frameSrc(i)}">`).join("")}</div>`;
      const css = `.t{position:absolute;left:0;top:0;display:block;object-fit:cover;opacity:0;transform-origin:50% 50%}`;
      const js = `${KIT}${motionJs(m, sizes.length)}var D=${r4(d)},MS=${margin},GR=${JSON.stringify(group)},JT=${JSON.stringify(scatter)},LAST=${sizes.length - 1},DRIFT=0.004,SZ='';
function render(t,el){var W=el.clientWidth,H=el.clientHeight,g=el.querySelector('.g'),ts=el.querySelectorAll('.t'),i,k;
g.style.transformOrigin='50% 50%';g.style.transform='scale('+(1+P*c01(t/D)).toFixed(4)+')';
// laid out once per frame size: each flash a grid packed round the centre, the shape that lets its pictures be biggest,
// fitted inside the margin with room for the push, the drift and the landing; every picture keeps its own shape
var key=W+'x'+H+':'+(ts[0]&&ts[0].naturalWidth);if(SZ!==key){SZ=key;var SH=Math.min(W,H),O=[W/2,H/2],b=box(W,H,MS*SH/W,O,1+P),BW=b[1]-b[0],BH=b[3]-b[2],gp=0.014*SH;
for(k=0;k<=LAST;k++){var ids=[];for(i=0;i<ts.length;i++)if(GR[i]===k)ids.push(i);
var n=ids.length,T=SH*(n<=1?0.6:n<=2?0.4:n<=4?0.3:0.22),DR=(1+DRIFT*11)*peak(ST[k],KK[k]),cw=0,ch=0;
var dims=ids.map(function(j){var ar=ts[j].naturalWidth&&ts[j].naturalHeight?ts[j].naturalWidth/ts[j].naturalHeight:1,w=ar>=1?T*ar:T,h=ar>=1?T:T/ar;cw=Math.max(cw,w);ch=Math.max(ch,h);return [w,h];});
// full rows only, or a last row one short (8 as 3, 3, 2), never a lone picture under a row of three
var best=null;for(var c=1;c<=n;c++){var r=Math.ceil(n/c);if(c*r-n>(r>1?1:0))continue;var GW=c*cw+(c-1)*gp,GH=r*ch+(r-1)*gp,f=Math.min(1,BW/(GW*DR),BH/(GH*DR)),fit=Math.abs(Math.log(GW/GH/(BW/BH)));
if(!best||f>best[0]*1.02||(f>best[0]/1.02&&fit<best[5]))best=[f,c,r,GW,GH,fit];}
var f=best[0],cc=best[1],x0=O[0]-best[3]*f/2,y0=O[1]-best[4]*f/2;
ids.forEach(function(j,q){var row=Math.floor(q/cc),col=q%cc,inRow=Math.min(cc,n-row*cc),off=(cc-inRow)*(cw+gp)/2,J=JT[j],w=dims[q][0]*f*J[2],h=dims[q][1]*f*J[2];
var cx=x0+(off+col*(cw+gp)+cw/2)*f+J[0]*((cw*f-w)/2+0.45*gp*f),cy=y0+(row*(ch+gp)+ch/2)*f+J[1]*((ch*f-h)/2+0.45*gp*f);
cx=Math.min(Math.max(cx,b[0]+w*DR/2),b[1]-w*DR/2);cy=Math.min(Math.max(cy,b[2]+h*DR/2),b[3]-h*DR/2);
Object.assign(ts[j].style,{left:(cx-w/2).toFixed(1)+'px',top:(cy-h/2).toFixed(1)+'px',width:w.toFixed(1)+'px',height:h.toFixed(1)+'px',borderRadius:(SH*0.01).toFixed(1)+'px'});});}}
for(i=0;i<ts.length;i++){k=GR[i];var a=t-AT[k]+EPS;if(a<0||(k<LAST&&t-AT[k+1]+EPS>=0)){ts[i].style.opacity='0';continue;}
// full for three frames, then dimming towards 0.45 until the next flash replaces it; the last flash holds
var fr=a/F,span=k<LAST?Math.max(4,(AT[k+1]-AT[k])/F):1,o=k===LAST||fr<3?1:1-0.55*c01((fr-3)/(span-3)),e=land(ST[k],a,KK[k]),bb=ST[k]==='flash'?(fr<1?1+0.35*KK[k]:fr<2?1+0.12*KK[k]:1):e[1];
ts[i].style.transform='scale('+(e[0]*(1+DRIFT*Math.min(fr,11))).toFixed(4)+')';show(ts[i],o*e[2],bb);}}`;
      return { ...painted("scene-memories", p, html, css, js, theme, d, lk, used), motion: m };
    },
  },
];

export const isSceneTemplate = (id: string | undefined) => !!id && SCENE_TEMPLATES.some(t => t.id === id);
