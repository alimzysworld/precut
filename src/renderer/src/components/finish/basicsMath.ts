import type { BasicAdjust } from "../../../../shared/schema";

type RGB = [number, number, number];
// Scalar, GLSL-compatible functions are the source for both CPU and shader maths.
// Keep this small subset numeric: no arrays, closures, JS-only operators or loops.
function bound(v: number) { return Math.max(0, Math.min(1, v)); }
export function basicLinear(v: number) { return v < .081 ? v / 4.5 : Math.pow((v + .099) / 1.099, 1 / .45); }
export function basicDisplay(v: number) { return v < .018 ? v * 4.5 : 1.099 * Math.pow(Math.max(0, v), .45) - .099; }
function basicSmooth(a: number, b: number, v: number) {
  const t = bound((v - a) / (b - a)); return t * t * (3 - 2 * t);
}
function beforeChannel(v: number, gain: number) { return basicDisplay(basicLinear(v) * Math.pow(2, gain)); }
function toneChannel(value: number, contrast: number, shadows: number, highlights: number, whites: number, blacks: number) {
  const initial = bound(value);
  const v = contrast == 0 ? initial : initial <= .41 ? .41 * Math.pow(initial / .41, Math.pow(2, contrast / 100)) : 1 - .59 * Math.pow((1 - initial) / .59, Math.pow(2, contrast / 100));
  const mask = basicSmooth(.25, .75, v);
  const tone = (shadows * (1 - mask) + highlights * mask) / 100;
  const toned = tone == 0 ? v : basicDisplay(basicLinear(v) * Math.pow(2, tone));
  return bound(toned + (whites / 100 * .25 * basicSmooth(.35, 1, toned) + blacks / 100 * .2 * (1 - basicSmooth(0, .65, toned))));
}
function presence(r: number, g: number, b: number, vibrance: number, saturation: number) {
  const high = Math.max(r, Math.max(g, b)), low = Math.min(r, Math.min(g, b)), chroma = high - low;
  const sat = high > 0 ? chroma / high : 0;
  const rawHue = chroma < 1e-8 ? 0 : high == r ? 60 * ((g - b) / chroma) : high == g ? 60 * ((b - r) / chroma + 2) : 60 * ((r - g) / chroma + 4);
  const hue = rawHue > 180 ? rawHue - 360 : rawHue;
  const skin = basicSmooth(-10, 10, hue) * (1 - basicSmooth(55, 80, hue)) * basicSmooth(.05, .18, sat);
  const travel = vibrance / 100;
  const response = (travel > 0 ? 3.6 : 2) * travel / (1 + Math.abs(travel));
  return (1 + saturation / 100) * (1 + response * Math.pow(1 - sat, 2) * (1 - .85 * skin));
}

export function basicBefore(b: BasicAdjust): (rgb: RGB) => RGB {
  if (!b.exposure && !b.temperature && !b.tint) return rgb => rgb;
  // Preserve the CPU's original operation order (including zero-input identity).
  const t = b.temperature / 100, m = b.tint / 100;
  const gains = [2 ** (.35 * t + .18 * m), 2 ** (-.18 * m), 2 ** (-.35 * t + .18 * m)];
  const ev = 2 ** b.exposure;
  return rgb => rgb.map((v, i) => basicDisplay(basicLinear(v) * gains[i] * ev)) as RGB;
}
export function basicAfter(b: BasicAdjust): (rgb: RGB) => RGB {
  if (![b.contrast, b.highlights, b.shadows, b.whites, b.blacks, b.vibrance, b.saturation].some(Boolean)) return rgb => rgb;
  return rgb => {
    const out = rgb.map(v => toneChannel(v, b.contrast, b.shadows, b.highlights, b.whites, b.blacks)) as RGB;
    if (!b.vibrance && !b.saturation) return out;
    const y = .2126 * out[0] + .7152 * out[1] + .0722 * out[2];
    const amount = presence(...out, b.vibrance, b.saturation);
    return out.map(v => bound(y + (v - y) * amount)) as RGB;
  };
}

// Generate GLSL from the actual scalar CPU functions, including names after
// bundler renaming. No runtime eval, second handwritten port, or shader drift.
const scalars = { bound, basicLinear, basicDisplay, basicSmooth, beforeChannel, toneChannel, presence };
export function basicsGLSL(): string {
  return Object.entries(scalars).map(([name, fn]) => {
    let source = fn.toString();
    for (const [canonical, actual] of Object.entries(scalars)) source = source.replace(new RegExp(`\\b${actual.name}\\b`, "g"), canonical);
    const parameters = source.slice(source.indexOf("(") + 1, source.indexOf(")")).split(",").map(p => `float ${p.trim()}`).join(",");
    let body = source.slice(source.indexOf("{"));
    body = body.replace(/\b(?:const|let|var)\b/g, "float").replace(/Math\.(pow|max|min|abs)/g, "$1")
      .replace(/(?<![\w.])(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?(?![\w.])/gi, n => /[.e]/i.test(n) ? n : `${n}.`)
      .replace(/([^;{}\s])\s*}/g, "$1;}");
    return `float ${name}(${parameters}) ${body}`;
  }).join("\n") + `
vec3 basicBeforeOnly(vec3 rgb, float b[10]) {
  if (b[0]!=0. || b[6]!=0. || b[7]!=0.) {
    rgb=vec3(beforeChannel(rgb.r,b[0]+.35*b[6]/100.+.18*b[7]/100.),
             beforeChannel(rgb.g,b[0]-.18*b[7]/100.),
             beforeChannel(rgb.b,b[0]-.35*b[6]/100.+.18*b[7]/100.));
  }
  return rgb;
}
vec3 basicAfterOnly(vec3 rgb,float b[10]) {
  if (b[1]==0. && b[2]==0. && b[3]==0. && b[4]==0. && b[5]==0. && b[8]==0. && b[9]==0.) return rgb;
  rgb=vec3(toneChannel(rgb.r,b[1],b[3],b[2],b[4],b[5]),
           toneChannel(rgb.g,b[1],b[3],b[2],b[4],b[5]),
           toneChannel(rgb.b,b[1],b[3],b[2],b[4],b[5]));
  if (b[8]==0. && b[9]==0.) return rgb;
  float y=dot(rgb,vec3(.2126,.7152,.0722));
  return clamp(vec3(y)+(rgb-y)*presence(rgb.r,rgb.g,rgb.b,b[8],b[9]),0.,1.);
}
vec3 basicPreview(vec3 rgb,float b[10]) { return basicAfterOnly(basicBeforeOnly(rgb,b),b); }`;
}

export const BASIC_KEYS = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "temperature", "tint", "vibrance", "saturation"] as const;
export const basicDelta = (target: BasicAdjust, baked: BasicAdjust) => BASIC_KEYS.map(key => target[key] - baked[key]);
/** CPU equivalent of the temporary post-LUT delta, for measured preview error. */
export function previewDelta(rgb: RGB, target: BasicAdjust, baked: BasicAdjust): RGB {
  const delta = Object.fromEntries(BASIC_KEYS.map(key => [key, target[key] - baked[key]])) as unknown as BasicAdjust;
  return basicAfter(delta)(basicBefore(delta)(rgb));
}
