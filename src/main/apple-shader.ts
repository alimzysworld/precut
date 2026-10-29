// AV2: the Apple player's Look shader, made from the same GLSL the Chrome viewer compiles.
//
// The grade, the mixer, the basics, detail, grain and vignette are each written once, as scalar TypeScript that
// the export evaluates and that emits GLSL (look-scalar, mixer-scalar, basicsMath, detailMath, grainMath), and the
// per piece order once in look-scalar. The Chrome viewer compiles that GLSL in WebGL. This file translates the very
// same text to Metal Shading Language, mechanically (types, array parameters, texel reads), and adds only the
// plumbing kernels the compositor dispatches: bake a piece's live grade onto its 33 point lattice, draw a picture
// through its tables, the detail pyramid in the viewer's DetailPass order, and the finish (grain and vignette).
// No colour maths is written here. pipeline/apple-view.swift compiles the source at run time (Metal, safe maths).
import { createHash } from "node:crypto";
import { mixerGLSL } from "../shared/mixer-scalar";
import { GRADE_LATTICE, GRADE_VERTEX_GLSL, TABLE_AT_GLSL, lookGLSL } from "../shared/look-scalar";
import { basicsGLSL } from "../renderer/src/components/finish/basicsMath";
import { DETAIL_KERNEL, DETAIL_LUMA, DETAIL_SCREEN, DETAIL_STEPS, detailGLSL } from "../renderer/src/components/finish/detailMath";
import { grainGLSL } from "../renderer/src/components/finish/grainMath";
import { transformGLSL } from "../shared/transform-glsl";
import { layerMainGLSL, layerUniformsGLSL } from "../shared/layer-glsl";
import { layoutBackgroundGLSL } from "../shared/layout-effects";

/** GLSL ES (as the emitters write it) to MSL. Syntax only: every expression is kept as written. */
export function glslToMetal(glsl: string): string {
  return glsl
    // The grain plate is a uniform in WebGL; in Metal the finish takes it as a parameter.
    .replace(/vec3 h4_finish\(vec3 rgb,/g, "vec3 h4_finish(texture2d<float> grainPlate, vec3 rgb,")
    .replace(/texture\(grainPlate,/g, "grainPlate.sample(plateSampler,")
    // Array parameters (`float b[10]`) become pointers the kernel fills from its own local arrays.
    .replace(/\bfloat\s+(\w+)\[\d+\]/g, "thread const float* $1")
    .replace(/\bsampler3D\s+(\w+)/g, "texture3d<float> $1")
    // texelFetch(table, p, 0) reads one texel at integer coordinates.
    .replace(/texelFetch\((\w+),(.+?),0\)/g, "$1.read(uint3($2))")
    .replace(/\bivec([234])\b/g, "int$1")
    .replace(/\bvec([234])\b/g, "float$1");
}

/** `name(a,b)` calls (GLSL's componentwise compare) to `(a OP b)`, split at the call's own top level comma. */
function compareCalls(text: string, name: string, op: string): string {
  let out = "", at = 0;
  for (let i = text.indexOf(`${name}(`); i >= 0; i = text.indexOf(`${name}(`, at)) {
    out += text.slice(at, i);
    let depth = 0, comma = -1, j = i + name.length;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
      else if (ch === "," && depth === 1 && comma < 0) comma = j;
    }
    out += `(${text.slice(i + name.length + 1, comma)}${op}${text.slice(comma + 1, j)})`;
    at = j + 1;
  }
  return out + text.slice(at);
}

/** AV3: the Chrome viewer's clip transform (transformGpu transformGLSL, the very text it compiles) as a Metal function.
 * Its uniforms (and the viewer's outputAspect) become parameters, and `discard` reports the pixel as outside the
 * picture, which the compositor leaves black as the viewer's cleared canvas is. No transform maths is written here. */
export function transformToMetal(glsl: string = transformGLSL): string {
  const uniforms = [...glsl.matchAll(/uniform\s+(\w+)\s+(\w+);/g)].map(m => `${m[1]} ${m[2]}`);
  let body = glsl.replace(/uniform\s+\w+\s+\w+;[^\n]*\n?/g, "");
  body = body.replace(/vec2 clipPoint\(vec2 at\)\{/, `vec2 clipPoint(vec2 at, ${[...uniforms, "float outputAspect"].join(", ")}, thread bool& discarded){`)
    .replace(/\bdiscard;/g, "{discarded=true;return at;}");
  body = compareCalls(compareCalls(body, "lessThan", "<"), "greaterThan", ">");
  return glslToMetal(body);
}

/** `name(...)` calls in `text` (outside a definition), each given `extra` arguments after its own. */
function withArguments(text: string, name: string, extra: string): string {
  let out = "", at = 0;
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0, j = m.index + name.length;
    for (; j < text.length; j++) { if (text[j] === "(") depth++; else if (text[j] === ")") { depth--; if (depth === 0) break; } }
    const inside = text.slice(m.index + name.length + 1, j);
    out += text.slice(at, m.index) + `${name}(${inside}${inside.trim() ? ", " : ""}${extra})`;
    at = j + 1; re.lastIndex = j + 1;
  }
  return out + text.slice(at);
}
/** The names a GLSL uniform block declares (`uniform TYPE a; uniform TYPE b[3];`). */
const uniformNames = (glsl: string) => [...glsl.matchAll(/uniform\s+\w+\s+(\w+)(?:\[\d+\])?\s*;/g)].map(m => m[1]);

/** AV4: the Chrome viewer's layer main() (src/shared/layer-glsl.ts, the very text LivePlayer compiles) as a Metal
 * function. Its body is kept as written (GLSL syntax made Metal by glslToMetal); its uniforms are read from the
 * layer's arguments by macros, `clipPoint` is the viewer's own translated clipPoint, and `pictureAt` is the Apple
 * picture: the framed tile the compositor made (one sample of the source, as the viewer's texture read is) through
 * the piece's tables. `discard` in clipPoint reports the pixel untouched, as the viewer's fragment is dropped. */
export function layerToMetal(main: string = layerMainGLSL, uniforms: string = layerUniformsGLSL): string {
  const body = main.slice(main.indexOf("{") + 1, main.lastIndexOf("}"));
  const declared = new Set(uniformNames(uniforms));
  for (const name of ["layoutCircle", "layoutSceneMask", "layoutDim", "layoutColour", "layoutPixels", "layoutRadius"]) if (!declared.has(name)) throw new Error(`layer uniforms lost ${name}`);
  const macros: [string, string][] = [
    ["opacity", "layer_.a.x"], ["layoutRadius", "layer_.a.y"], ["blurVector", "layer_.b.xy"], ["layoutPixels", "layer_.b.zw"], ["layoutColour", "layer_.c.xyz"],
    ["layoutCircle", "(layer_.d.x != 0.)"], ["layoutSceneMask", "(layer_.d.y != 0.)"], ["layoutDim", "(layer_.d.z != 0.)"], ["clipping", "false"],
    ["clipPoint(at)", "clipPoint(at, (int(layer_.d.w) & 2) != 0, layer_.clipAffine, layer_.clipCrop, float2((int(layer_.d.w) & 4) != 0 ? 1. : 0., (int(layer_.d.w) & 8) != 0 ? 1. : 0.), layer_.a.w, discarded)"],
    ["pictureAt(at)", "applePictureAt(at, layer_, tile, table, lattice)"],
  ];
  const metal = glslToMetal(compareCalls(body, "notEqual", "!="));
  return `${macros.map(([k, v]) => `#define ${k} ${v}`).join("\n")}
/** The viewer's layer main(), translated: the colour and coverage of one pixel of a picture layer. */
float4 appleLayerColour(float2 uv, constant LayerArgs& layer_, texture2d<float> tile, texture3d<float> table, texture3d<float> lattice, thread bool& discarded) {
  float4 color = float4(0.);${metal}
  return color;
}
${macros.map(([k]) => `#undef ${k.replace(/\(.*$/, "")}`).join("\n")}`;
}

/** AV4: the layout background (src/shared/layout-effects.ts layoutBackgroundGLSL, the text both compositors use) as
 * Metal. Its uniforms come from the pass's arguments by macros; its functions take the pass's textures and the pixel.
 * The viewer's backdrop target is stored upside down in WebGL (its `turned` flips it back); Metal textures are not, so
 * `turned` is the identity here. Its own `grade` is the identity (the picture is graded before it is drawn there). */
export function backdropToMetal(glsl: string = layoutBackgroundGLSL): string {
  let text = glsl.replace(/uniform\s+[^;]+;/g, "");
  const params = "float2 uv, constant BackdropArgs& backdrop_, texture2d<float> picture, texture2d<float> backdropImage";
  const args = "uv, backdrop_, picture, backdropImage";
  for (const name of ["backdropAt", "drawBackdrop"]) {
    text = text.replace(new RegExp(`(vec3\\s+${name})\\(([^)]*)\\)\\s*\\{`), (_, head: string, inner: string) => `${head}(${inner}${inner.trim() ? ", " : ""}__PARAMS__){`);
    text = withArguments(text, name, args);
    text = text.replace(new RegExp(`${name}\\(([^)]*?), ${args.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\{`), (_, inner: string) => `${name}(${inner}){`);
  }
  text = text.replaceAll("__PARAMS__", params);
  const macros: [string, string][] = [
    ["backdropKind", "int(backdrop_.a.x)"], ["backdropBlur", "backdrop_.a.y"], ["backdropDim", "backdrop_.a.z"], ["backdropCount", "int(backdrop_.a.w)"],
    ["backdropAspect", "backdrop_.b.x"], ["backdropTaps", "int(backdrop_.b.y)"], ["sourceAspect", "backdrop_.b.z"], ["outputAspect", "backdrop_.b.w"],
    ["backdropDirection", "backdrop_.c.xy"], ["backdropStops", "backdrop_.stops"],
    ["texture(t,p)", "t.sample(backdropSampler, p)"], ["grade(c)", "(c)"], ["turned(p)", "(p)"],
  ];
  return `constexpr sampler backdropSampler(filter::linear, address::clamp_to_edge, coord::normalized);
${macros.map(([k, v]) => `#define ${k} ${v}`).join("\n")}
${glslToMetal(text)}
${macros.map(([k]) => `#undef ${k.replace(/\(.*$/, "")}`).join("\n")}`;
}

/** Detail pass weights, steps and constants as the viewer's DetailPass uses them (detailGpu.ts). */
const detailConstants = () => `constant float DETAIL_WEIGHTS[5] = {${DETAIL_KERNEL.map(k => `${k}.0/16.0`).join(", ")}};
constant float3 DETAIL_LUMA_W = float3(${DETAIL_LUMA.join(", ")});
constant float DETAIL_SCREEN_K = ${DETAIL_SCREEN};`;

/** The steps of the detail pyramid, for the host (DetailPass: 1, 2, 4, 8 pixels). */
export const APPLE_DETAIL_STEPS = [...DETAIL_STEPS];

export function appleShaderSource(): string {
  // grainGLSL(true): the viewer's own finish, which reads grain from a plate of the lattice (GrainPlate) rather than
  // evaluating noise at every pixel; the plate is made on the GPU from the same lattice function (applePlate).
  const shared = [basicsGLSL(), mixerGLSL(), lookGLSL(), TABLE_AT_GLSL, GRADE_VERTEX_GLSL, detailGLSL(), grainGLSL(true)].join("\n");
  const lattice = GRADE_LATTICE;
  return `#include <metal_stdlib>
using namespace metal;
// GLSL's mod (floored), which Metal's fmod (truncated) is not.
inline float mod(float a, float b) { return a - b * floor(a / b); }
// The grain plate repeats and is read with bilinear filtering, as the viewer's GrainPlate texture is.
constexpr sampler plateSampler(filter::linear, address::repeat, coord::normalized);
// ---- shared GLSL, translated (src/shared/look-scalar, mixer-scalar; finish/basicsMath, detailMath, grainMath)
${glslToMetal(shared)}
// ---- AV3: the viewer's clip transform (transformGpu), translated
${transformToMetal()}
// ---- AV4: the viewer's layer main() and layout background, translated (src/shared/layer-glsl, layout-effects)
/** One picture layer's numbers (LivePlayer drawLayer's uniforms): dest is its viewport in the output (x, y, w, h,
 * top left pixels), box the same picture in the compositor's tile (pixels of the framed picture), a: opacity, radius,
 * table size, output aspect; b: blur vector, mask pixels; c: dim colour, colour mode; d: circle, scene mask, dim,
 * flags (1 blend, 2 clip transform, 4 flip h, 8 flip v). */
struct LayerArgs { float4 dest; float4 box; float4 clipAffine; float4 clipCrop; float4 a; float4 b; float4 c; float4 d; };
/** The Apple picture at a point of the layer (0..1 over its viewport): the framed tile, then the piece's tables. Where
 * the tile has no picture it is black and ungraded, as the viewer leaves it. */
float3 applePictureAt(float2 at, constant LayerArgs& u, texture2d<float> tile, texture3d<float> table, texture3d<float> lattice) {
  constexpr sampler pixels(filter::linear, address::clamp_to_edge, coord::pixel);
  float4 c = tile.sample(pixels, u.box.xy + at * u.box.zw);
  if (c.a <= 0.5) return float3(0.);
  float3 rgb = c.rgb;
  int mode = int(u.c.w);
  if (mode == 1) rgb = tableAt(table, rgb, u.a.z, 0);
  else if (mode == 2) rgb = tableAt(lattice, tableAt(table, rgb, u.a.z, 0), ${lattice + 1}., 0);
  return rgb;
}
${layerToMetal()}
/** One layer over the picture so far, in its viewport: the viewer's main(), blended as the viewer blends it. */
kernel void appleLayer(texture2d<float, access::sample> tile [[texture(0)]], texture3d<float> table [[texture(1)]], texture3d<float> lattice [[texture(2)]],
                       texture2d<float, access::read_write> scene [[texture(3)]], constant LayerArgs& u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= uint(u.dest.z) || gid.y >= uint(u.dest.w)) return;
  uint2 at = uint2(u.dest.xy) + gid;
  if (at.x >= scene.get_width() || at.y >= scene.get_height()) return;
  float2 uv = (float2(gid) + 0.5) / u.dest.zw;
  bool discarded = false;
  float4 c = appleLayerColour(uv, u, tile, table, lattice, discarded);
  if (discarded) return;
  float3 below = scene.read(at).rgb;
  scene.write(float4((int(u.d.w) & 1) != 0 ? c.rgb * c.a + below * (1. - c.a) : c.rgb, 1.), at);
}
struct BackdropArgs { float4 a; float4 b; float4 c; float3 stops[3]; };
${backdropToMetal()}
/** The layout background over the whole frame (the viewer's LayoutBackdropPass draw). */
kernel void appleBackdrop(texture2d<float> picture [[texture(0)]], texture2d<float> backdropImage [[texture(1)]], texture2d<float, access::write> out [[texture(2)]],
                          constant BackdropArgs& u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= out.get_width() || gid.y >= out.get_height()) return;
  float2 uv = (float2(gid) + 0.5) / float2(out.get_width(), out.get_height());
  out.write(float4(drawBackdrop(uv, u, picture, backdropImage), 1.), gid);
}
/** A finished scene over the picture at its opacity (the viewer's scene program, blended). */
kernel void appleGroup(texture2d<float, access::read> source [[texture(0)]], texture2d<float, access::read_write> scene [[texture(1)]], constant float& opacity [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= scene.get_width() || gid.y >= scene.get_height()) return;
  scene.write(float4(source.read(gid).rgb * opacity + scene.read(gid).rgb * (1. - opacity), 1.), gid);
}
kernel void appleClear(texture2d<float, access::write> out [[texture(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= out.get_width() || gid.y >= out.get_height()) return;
  out.write(float4(0., 0., 0., 1.), gid);
}
/** AV4, the compositor: one source picture framed into its tile of the composed picture. \`m\` maps a tile pixel
 * (output pixels, top left) to source pixels; \`rect\` is where to write in the composed picture and \`origin\` the
 * tile's own top left there. Outside the source the tile stays transparent black. */
struct FrameArgs { float2 m0; float2 m1; float2 m2; float2 sourceSize; float4 rect; float2 origin; float2 pad; };
kernel void appleFrameTile(texture2d<float, access::sample> source [[texture(0)]], texture2d<float, access::write> out [[texture(1)]], constant FrameArgs& f [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= uint(f.rect.z) || gid.y >= uint(f.rect.w)) return;
  uint2 at = uint2(f.rect.xy) + gid;
  if (at.x >= out.get_width() || at.y >= out.get_height()) return;
  float2 p = float2(at) - f.origin + 0.5;
  float2 s = f.m0 * p.x + f.m1 * p.y + f.m2;
  float4 c = float4(0.);
  if (s.x >= 0. && s.y >= 0. && s.x <= f.sourceSize.x && s.y <= f.sourceSize.y) {
    constexpr sampler linear(filter::linear, address::clamp_to_edge, coord::normalized);
    c = float4(source.sample(linear, s / f.sourceSize).rgb, 1.);
  }
  out.write(c, at);
}
// ---- plumbing
${detailConstants()}
struct LookNumbers { float look[18]; float basics[10]; float mixer[24]; float4 gain; };
/** A piece's live grade on the ${lattice + 1} point lattice of its base table's output (the viewer's stagedGrade vertices). */
kernel void appleBake(texture3d<float, access::write> lattice [[texture(0)]], constant LookNumbers& n [[buffer(0)]], uint3 gid [[thread_position_in_grid]]) {
  if (gid.x > ${lattice} || gid.y > ${lattice} || gid.z > ${lattice}) return;
  float look[18]; float basics[10]; float mixer[24];
  for (int i = 0; i < 18; i++) look[i] = n.look[i];
  for (int i = 0; i < 10; i++) basics[i] = n.basics[i];
  for (int i = 0; i < 24; i++) mixer[i] = n.mixer[i];
  lattice.write(float4(gradeVertexWith(float3(gid) / ${lattice}., n.gain, basics, look, mixer), 1.), gid);
}
struct PictureArgs { float2 m0; float2 m1; float2 m2; float2 sourceSize; int hasPicture; int mode; float tableSize; int opaque;
  int clip; float outputAspect; float2 clipFlip; float4 clipAffine; float4 clipCrop; };
/** One output pixel: the source picture through a transform (the builder's framing, inverted; identity on an already
 * framed picture), then its tables. mode 0: no table; 1: the piece's whole table; 2: its base table, then its baked
 * live grade. Where there is no picture (outside it, or a framed picture's transparent field) the pixel stays black
 * and ungraded, as the viewer leaves it; alpha says which (opaque: 1 everywhere, for the screen). AV3: \`clip\` moves
 * the output point through the piece's clip transform first (the viewer's clipPoint, on the framed picture). */
kernel void applePicture(texture2d<float, access::sample> source [[texture(0)]], texture3d<float> table [[texture(1)]], texture3d<float> lattice [[texture(2)]],
                         texture2d<float, access::write> out [[texture(3)]], constant PictureArgs& a [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= out.get_width() || gid.y >= out.get_height()) return;
  float4 c = float4(0.);
  float2 p = float2(gid) + 0.5;
  bool gone = false;
  if (a.clip != 0) {
    float2 size = float2(out.get_width(), out.get_height());
    p = clipPoint(p / size, true, a.clipAffine, a.clipCrop, a.clipFlip, a.outputAspect, gone) * size;
  }
  if (a.hasPicture != 0 && !gone) {
    float2 s = a.m0 * p.x + a.m1 * p.y + a.m2;
    if (s.x >= 0. && s.y >= 0. && s.x <= a.sourceSize.x && s.y <= a.sourceSize.y) {
      constexpr sampler linear(filter::linear, address::clamp_to_edge, coord::normalized);
      float4 at = source.sample(linear, s / a.sourceSize);
      if (at.a > 0.5) {
        float3 rgb = at.rgb;
        if (a.mode == 1) rgb = tableAt(table, rgb, a.tableSize, 0);
        else if (a.mode == 2) rgb = tableAt(lattice, tableAt(table, rgb, a.tableSize, 0), ${lattice + 1}., 0);
        c = float4(rgb, 1.);
      }
    }
  }
  if (a.opaque != 0) c.a = 1.;
  out.write(c, gid);
}
/** The detail pyramid's seed: luma and its highlight bloom. */
kernel void appleDetailSeed(texture2d<float, access::read> source [[texture(0)]], texture2d<float, access::write> out [[texture(1)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= out.get_width() || gid.y >= out.get_height()) return;
  float l = dot(source.read(gid).rgb, DETAIL_LUMA_W);
  out.write(float4(l, h12_bloom(l), 0., 1.), gid);
}
/** One separable blur step, edges clamped. */
kernel void appleDetailBlur(texture2d<float, access::read> source [[texture(0)]], texture2d<float, access::write> out [[texture(1)]], constant int2& step [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  int2 size = int2(out.get_width(), out.get_height());
  if (int(gid.x) >= size.x || int(gid.y) >= size.y) return;
  float4 c = float4(0.);
  for (int k = 0; k < 5; k++) c += source.read(uint2(clamp(int2(gid) + step * (k - 2), int2(0), size - 1))) * DETAIL_WEIGHTS[k];
  out.write(c, gid);
}
struct DetailArgs { float amount; float radius; float detail; float masking; float texture; float clarity; float diffusion; float pad; };
kernel void appleDetail(texture2d<float, access::read> source [[texture(0)]], texture2d<float, access::read> level0 [[texture(1)]], texture2d<float, access::read> level1 [[texture(2)]],
                        texture2d<float, access::read> level2 [[texture(3)]], texture2d<float, access::read> level4 [[texture(4)]], texture2d<float, access::write> out [[texture(5)]],
                        constant DetailArgs& d [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  int2 size = int2(out.get_width(), out.get_height());
  if (int(gid.x) >= size.x || int(gid.y) >= size.y) return;
  int2 g = int2(gid);
  float at = level0.read(gid).r;
  float ex = abs(level0.read(uint2(clamp(g + int2(1, 0), int2(0), size - 1))).r - level0.read(uint2(clamp(g - int2(1, 0), int2(0), size - 1))).r);
  float ey = abs(level0.read(uint2(clamp(g + int2(0, 1), int2(0), size - 1))).r - level0.read(uint2(clamp(g - int2(0, 1), int2(0), size - 1))).r);
  float delta = h12_delta(at, level1.read(gid).r, level2.read(gid).r, level4.read(gid).r, max(ex, ey), d.amount, d.radius, d.detail, d.masking, d.texture, d.clarity);
  float3 rgb = clamp(source.read(gid).rgb + delta, 0., 1.);
  rgb += (1. - rgb) * level4.read(gid).g * d.diffusion * DETAIL_SCREEN_K;
  out.write(float4(rgb, 1.), gid);
}
/** Copy (and so quantise to the target's format, as the viewer's 8 bit scene does). */
kernel void appleCopy(texture2d<float, access::read> source [[texture(0)]], texture2d<float, access::write> out [[texture(1)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= out.get_width() || gid.y >= out.get_height()) return;
  out.write(float4(source.read(gid).rgb, 1.), gid);
}
struct FinishArgs { float2 shape; float frame; float gAmount; float gSize; float gRough; float gColour; float gShadows; float gHighlights; float vAmount; float vMid; float vFeather; };
/** The grain plate: the lattice at each of its 96 x 96 points, mono and colour mixed (grainMath grainPlateValues). */
kernel void applePlate(texture2d<float, access::write> plate [[texture(0)]], constant float2& choice [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= plate.get_width() || gid.y >= plate.get_height()) return;
  float rough = choice.x * 0.01, c = choice.y * 0.01, x = float(gid.x), y = float(gid.y);
  float mono = h4_lattice(x, y, 0., 3., rough);
  float3 chroma = float3(h4_lattice(x, y, 0., 0., rough), h4_lattice(x, y, 0., 1., rough), h4_lattice(x, y, 0., 2., rough));
  plate.write(float4(((1. - c) * mono + c * chroma) / sqrt((1. - c) * (1. - c) + c * c), 1.), gid);
}
kernel void appleFinish(texture2d<float, access::read> source [[texture(0)]], texture2d<float, access::write> out [[texture(1)]], texture2d<float> plate [[texture(2)]], constant FinishArgs& f [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= out.get_width() || gid.y >= out.get_height()) return;
  float3 rgb = h4_finish(plate, source.read(gid).rgb, float2(gid), f.shape, f.frame, f.gAmount, f.gSize, f.gRough, f.gColour, f.gShadows, f.gHighlights, f.vAmount, f.vMid, f.vFeather);
  out.write(float4(clamp(rgb, 0., 1.), 1.), gid);
}
`;
}

let cached: { source: string; hash: string } | null = null;
/** The shader source and its content hash (the compositor compiles each distinct source once per run). */
export function appleShader(): { source: string; hash: string } {
  if (!cached) { const source = appleShaderSource(); cached = { source, hash: createHash("sha256").update(source).digest("hex").slice(0, 16) }; }
  return cached;
}
