// AV1b: the page's side of the Apple player. Its picture is a native view in this window,
// below the web contents, so while it shows the page must leave the viewer's picture rect
// transparent and paint everything else exactly as before. Each ancestor that paints a
// background over that rect (the black stage, the app's ground) moves its background to a
// layer with the rect cut out (a polygon clip with an even-odd hole, rounded like the
// viewer); ancestors above the full-window ground just stop painting (nothing shows them).
// Captions, titles, the play bar and every control are content, so they stay on top.
// FS1: in full screen the viewer sits in the top layer over a transparent ::backdrop, so the rest of the page (the
// editor, still laid out underneath) would show through the hole. While the viewer is full screen, everything
// outside the full screen element is hidden (data-apple-fullscreen on <html>), and the marks are read again. Whatever
// element is full screen (the stage, or the player around it) keeps a clear ::backdrop, so only the hole's ground paints.

const STYLE_ID = "precut-apple-hole";
const CSS = `
[data-apple-backdrop]{background:transparent!important;isolation:isolate}
[data-apple-backdrop]::after{content:"";position:absolute;inset:0;z-index:-2;pointer-events:none;background-color:var(--apple-backdrop-color);background-image:var(--apple-backdrop-image);clip-path:var(--apple-hole);border-radius:inherit}
[data-apple-backdrop]::before{clip-path:var(--apple-hole)}
[data-apple-backdrop]::backdrop{background:transparent!important}
[data-apple-clear],[data-apple-picture]{background:transparent!important}
[data-apple-fullscreen] body :not(:fullscreen,:fullscreen *){visibility:hidden!important}
[data-apple-fullscreen] :fullscreen{visibility:visible!important}
[data-apple-fullscreen] :fullscreen::backdrop{background:transparent!important}
`;
const FULLSCREEN = "data-apple-fullscreen";

export interface HoleRect { x: number; y: number; width: number; height: number }

/** The clip-path for a box of `size` with `hole` (in the box's own coordinates) cut out, corners rounded by `radius`. */
export function holePolygon(hole: HoleRect, radius: number): string {
  const r = Math.max(0, Math.min(radius, hole.width / 2, hole.height / 2));
  const x1 = hole.x, y1 = hole.y, x2 = hole.x + hole.width, y2 = hole.y + hole.height;
  const pts: [number, number][] = [];
  // Clockwise from the top left corner's end; each corner a quarter circle in 8 steps.
  const arc = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 8; i++) { const a = (from + (90 * i) / 8) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  };
  if (r > 0) { arc(x1 + r, y1 + r, 180); arc(x2 - r, y1 + r, 270); arc(x2 - r, y2 - r, 0); arc(x1 + r, y2 - r, 90); }
  else pts.push([x1, y1], [x2, y1], [x2, y2], [x1, y2]);
  const px = (v: number) => `${Math.round(v * 100) / 100}px`;
  const ring = [...pts, pts[0]].map(([x, y]) => `${px(x)} ${px(y)}`).join(",");
  return `polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,${ring},0 0)`;
}

const opaque = (color: string) => { const m = /rgba?\(([^)]+)\)/.exec(color); if (!m) return color !== "transparent"; const parts = m[1].split(/[ ,/]+/).filter(Boolean); return parts.length < 4 || Number(parts[3]) > 0; };
const paints = (style: CSSStyleDeclaration) => (style.backgroundColor && style.backgroundColor !== "transparent" && opaque(style.backgroundColor)) || (style.backgroundImage && style.backgroundImage !== "none");

/** Open the hole for the viewer `picture` (its own background goes too). Call update() whenever layout may have moved it. */
export function createAppleHole(picture: HTMLElement) {
  const doc = picture.ownerDocument;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID; style.textContent = CSS;
    doc.head.appendChild(style);
  }
  let marked: { el: HTMLElement; kind: "backdrop" | "clear" | "picture" }[] = [];
  let lastKey = "";
  const unmark = () => {
    for (const { el } of marked) {
      el.removeAttribute("data-apple-backdrop"); el.removeAttribute("data-apple-clear"); el.removeAttribute("data-apple-picture");
      el.style.removeProperty("--apple-hole"); el.style.removeProperty("--apple-backdrop-color"); el.style.removeProperty("--apple-backdrop-image");
    }
    marked = []; lastKey = "";
  };
  /** Find what paints over the picture, with fresh colours (the theme may have changed). */
  const mark = () => {
    unmark();
    const view = doc.defaultView!;
    marked.push({ el: picture, kind: "picture" });
    let ground = false;
    for (let el = picture.parentElement; el; el = el.parentElement) {
      const style = view.getComputedStyle(el);
      if (!paints(style)) continue;
      if (ground) { marked.push({ el, kind: "clear" }); continue; }
      el.style.setProperty("--apple-backdrop-color", style.backgroundColor);
      el.style.setProperty("--apple-backdrop-image", style.backgroundImage);
      marked.push({ el, kind: "backdrop" });
      const box = el.getBoundingClientRect();
      // The first ancestor that fills the window is the ground: nothing above it is ever seen.
      if (box.left <= 0 && box.top <= 0 && box.right >= view.innerWidth && box.bottom >= view.innerHeight) ground = true;
    }
    for (const { el, kind } of marked) el.setAttribute(`data-apple-${kind}`, "");
  };
  const update = () => {
    if (!marked.length) mark();
    const rect = picture.getBoundingClientRect();
    const radius = parseFloat(doc.defaultView!.getComputedStyle(picture).borderTopLeftRadius) || 0;
    const key = `${rect.x},${rect.y},${rect.width},${rect.height},${radius}`;
    if (key === lastKey) return rect;
    lastKey = key;
    for (const { el, kind } of marked) {
      if (kind !== "backdrop") continue;
      const box = el.getBoundingClientRect();
      el.style.setProperty("--apple-hole", holePolygon({ x: rect.x - box.x, y: rect.y - box.y, width: rect.width, height: rect.height }, radius));
    }
    return rect;
  };
  /** The theme changed: read the colours again. */
  const refresh = () => { mark(); lastKey = ""; return update(); };
  // FS1: full screen in or out changes what fills the window (the ground) and what the page may show around the viewer.
  const fullscreen = () => {
    doc.documentElement.toggleAttribute(FULLSCREEN, !!doc.fullscreenElement?.contains(picture));
    if (picture.isConnected) refresh();
  };
  doc.addEventListener("fullscreenchange", fullscreen);
  doc.documentElement.toggleAttribute(FULLSCREEN, !!doc.fullscreenElement?.contains(picture));
  const release = () => { doc.removeEventListener("fullscreenchange", fullscreen); doc.documentElement.removeAttribute(FULLSCREEN); unmark(); };
  return { update, refresh, release, marked: () => marked.map(({ el, kind }) => ({ kind, tag: el.tagName, className: String(el.className).slice(0, 80) })) };
}
