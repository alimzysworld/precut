import type { GrainChoice, GrainPreset, VignetteChoice } from "../../../../shared/schema";

/** Post-grade texture, in output pixels. No LUT or camera-profile dependency. */
export const GRAIN_PRESETS: Readonly<Record<GrainPreset, Readonly<GrainChoice>>> = {
  "35mm-fine": { preset: "35mm-fine", amount: 22, size: 18, roughness: 18, colour: 8, shadows: 30, highlights: -45 },
  "35mm-classic": { preset: "35mm-classic", amount: 36, size: 38, roughness: 38, colour: 12, shadows: 40, highlights: -40 },
  "16mm": { preset: "16mm", amount: 48, size: 58, roughness: 60, colour: 20, shadows: 45, highlights: -35 },
  super8: { preset: "super8", amount: 62, size: 78, roughness: 78, colour: 30, shadows: 55, highlights: -30 },
  trix: { preset: "trix", amount: 65, size: 48, roughness: 65, colour: 0, shadows: 70, highlights: -65 },
  digital: { preset: "digital", amount: 18, size: 0, roughness: 0, colour: 100, shadows: 0, highlights: 0 },
};
export type GrainUpdate = Partial<GrainChoice>;
const clamp = (v: unknown, fallback: number, low: number, high: number) => typeof v === "number" && Number.isFinite(v) ? Math.max(low, Math.min(high, v)) : fallback;
export function normalizeGrain(value: GrainUpdate | null | undefined, previous?: GrainChoice | null): GrainChoice | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a grain preset or grain settings.");
  if (value.preset !== undefined && !Object.hasOwn(GRAIN_PRESETS, value.preset)) throw new Error("Choose a grain preset from the gallery.");
  const base = value.preset ? GRAIN_PRESETS[value.preset] : previous ?? GRAIN_PRESETS["35mm-fine"];
  return { preset: base.preset, ...Object.fromEntries((["amount", "size", "roughness", "colour", "shadows", "highlights"] as const).map(k =>
    [k, clamp(value[k], base[k], k === "shadows" || k === "highlights" ? -100 : 0, 100)])) } as GrainChoice;
}
export function normalizeVignette(value: Partial<VignetteChoice> | null | undefined, previous?: VignetteChoice | null): VignetteChoice | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose vignette settings.");
  const base = previous ?? { amount: -18, midpoint: 50, feather: 70 };
  return { amount: clamp(value.amount, base.amount, -100, 100), midpoint: clamp(value.midpoint, base.midpoint, 0, 100), feather: clamp(value.feather, base.feather, 0, 100) };
}

// A tiny scalar expression tree is the single maths source. Compile it to GLSL
// or FFmpeg expressions; evaluate it directly for the headless shader reference.
// The integer hash stays below 2^24, avoiding GPU sin/hash precision differences.
type E = number | string | { op: string; args: E[] };
const op = (name: string, ...args: E[]): E => ({ op: name, args });
const add = (a: E, b: E) => op("+", a, b), sub = (a: E, b: E) => op("-", a, b), mul = (a: E, b: E) => op("*", a, b), div = (a: E, b: E) => op("/", a, b);
const mix = (a: E, b: E, t: E) => add(mul(a, sub(1, t)), mul(b, t));
const sat = (a: E) => op("min", 1, op("max", 0, a));
const square = (a: E) => op("square", a);
const hash: E = sub(mul(div(op("mod", add(mul(op("mod", square(op("mod", add(add(mul("x", 37), mul("y", 239)), add(mul(op("mod", "n", 4093), 101), mul("c", 163))), 4093)), 4093), 109), 1021), 4093), 4092), 2), 1);
const smooth = (t: E) => mul(square(t), sub(3, mul(2, t)));
const field: E = mix(
  mix(op("hash", op("floor", "x"), op("floor", "y"), "n", "c"), op("hash", add(op("floor", "x"), 1), op("floor", "y"), "n", "c"), op("fract", "x")),
  mix(op("hash", op("floor", "x"), add(op("floor", "y"), 1), "n", "c"), op("hash", add(op("floor", "x"), 1), add(op("floor", "y"), 1), "n", "c"), op("fract", "x")), op("fract", "y"));
const lattice: E = div(add(op("hash", "x", "y", "n", "c"), mul("rough", op("field", div("x", 3), div("y", 3), "n", add("c", 7)))), op("sqrt", add(1, square("rough"))));
const texture: E = mix(mix(op("lattice",op("mod",op("floor","x"),96),op("mod",op("floor","y"),96),"n","c","rough"),op("lattice",op("mod",add(op("floor","x"),1),96),op("mod",op("floor","y"),96),"n","c","rough"),op("fract","x")),mix(op("lattice",op("mod",op("floor","x"),96),op("mod",add(op("floor","y"),1),96),"n","c","rough"),op("lattice",op("mod",add(op("floor","x"),1),96),op("mod",add(op("floor","y"),1),96),"n","c","rough"),op("fract","x")),op("fract","y"));
const luma: E = add(add(mul("r", .2126), mul("g", .7152)), mul("b", .0722));
const response: E = op("max", 0, add(add(1, mul("shadows", square(sub(1, "l")))), mul("highlights", square("l"))));
// Ellipse touches the midpoints of the post-crop frame. Feather has a nonzero
// minimum, so even feather=0 is continuous and deterministic at the boundary.
const radius: E = op("sqrt", add(square(sub(mul("u", 2), 1)), square(sub(mul("v", 2), 1))));
const edge: E = smooth(sat(div(sub("radius", mul("midpoint", .009)), add(.02, mul("feather", .0098)))));
const vignette: E = add(1, mul(mul("vamount", .01), "edge"));
const definitions: Record<string, { names: string[]; value: E }> = {
  hash: { names: ["x", "y", "n", "c"], value: hash },
  field: { names: ["x", "y", "n", "c"], value: field },
  lattice: { names: ["x", "y", "n", "c", "rough"], value: lattice },
  noise: { names: ["x", "y", "n", "c", "rough"], value: texture },
};
let referenceLatticeKey = "";
const referenceLattice = new Map<string, number>();
function evaluate(e: E, env: Record<string, number>): number {
  if (typeof e === "number") return e;
  if (typeof e === "string") return env[e];
  const a = e.args.map(v => evaluate(v, env));
  if (definitions[e.op]) {
    const key = `${a[2]}:${a[4]}`;
    if (e.op === "lattice") {
      if (referenceLatticeKey !== key) { referenceLatticeKey = key; referenceLattice.clear(); }
      const cell = `${a[0]}:${a[1]}:${a[3]}`, cached = referenceLattice.get(cell);
      if (cached !== undefined) return cached;
      const value = evaluate(definitions[e.op].value, Object.fromEntries(definitions[e.op].names.map((n, i) => [n, a[i]])));
      referenceLattice.set(cell, value); return value;
    }
    return evaluate(definitions[e.op].value, Object.fromEntries(definitions[e.op].names.map((n, i) => [n, a[i]])));
  }
  switch (e.op) {
    case "+": return a[0] + a[1]; case "-": return a[0] - a[1]; case "*": return a[0] * a[1]; case "/": return a[0] / a[1];
    case "square": return a[0] * a[0]; case "mod": return a[0] - a[1] * Math.floor(a[0] / a[1]); case "floor": return Math.floor(a[0]); case "fract": return a[0] - Math.floor(a[0]);
    case "sqrt": return Math.sqrt(a[0]); case "min": return Math.min(...a); case "max": return Math.max(...a);
    default: throw new Error(`Unknown grain operation ${e.op}`);
  }
}
function emit(e: E, target: "glsl" | "ffmpeg", env: Record<string, string> = {}): string {
  if (typeof e === "number") return target === "glsl" && Number.isInteger(e) ? `${e}.0` : String(e);
  if (typeof e === "string") return env[e] ?? e;
  const a = e.args.map(v => emit(v, target, env));
  if (definitions[e.op]) {
    if (target === "glsl") return `h4_${e.op}(${a.join(",")})`;
    return emit(definitions[e.op].value, target, Object.fromEntries(definitions[e.op].names.map((n, i) => [n, a[i]])));
  }
  if (["+", "-", "*", "/"].includes(e.op)) return `(${a[0]}${e.op}${a[1]})`;
  if (e.op === "square") return target === "glsl" ? `h4_square(${a[0]})` : `(${a[0]})^2`;
  if (e.op === "fract" && target === "ffmpeg") return `(${a[0]}-floor(${a[0]}))`;
  return `${e.op}(${a.join(",")})`;
}
// Compile the existing expression tree to arithmetic closures once. Unlike
// the diagnostic interpreter this makes no objects while filling a GPU plate.
type Scalar = (values: number[]) => number;
function compileScalar(e: E, env: Record<string, Scalar>): Scalar {
  if(typeof e==="number") return ()=>e;
  if(typeof e==="string") return env[e];
  const a=e.args.map(v=>compileScalar(v,env)),[x,y]=a;
  if(definitions[e.op]) return compileScalar(definitions[e.op].value,Object.fromEntries(definitions[e.op].names.map((n,i)=>[n,a[i]])));
  switch(e.op) {
    case "+":return v=>x(v)+y(v);case "-":return v=>x(v)-y(v);case "*":return v=>x(v)*y(v);case "/":return v=>x(v)/y(v);
    case "square":return v=>{const n=x(v);return n*n;};case "mod":return v=>{const n=x(v),d=y(v);return n-d*Math.floor(n/d);};
    case "floor":return v=>Math.floor(x(v));case "fract":return v=>{const n=x(v);return n-Math.floor(n);};
    case "sqrt":return v=>Math.sqrt(x(v));case "min":return v=>Math.min(x(v),y(v));default:return v=>Math.max(x(v),y(v));
  }
}
const plateLattice=compileScalar(lattice,{x:v=>v[0],y:v=>v[1],n:()=>0,c:v=>v[2],rough:v=>v[3]});
// One stationary, tileable lattice. A frame-seeded crop animates it without
// rebuilding noise at every pixel. Offsets repeat after 4093 output frames.
export const GRAIN_TILE = 96;
export const grainPeriod = (size: number) => Math.round(GRAIN_TILE*(1+size*.045));
export function grainOffset(frame: number, period=GRAIN_TILE): [number, number] {
  const n=((Math.floor(frame)%4093)+4093)%4093;
  return [(n*37+Math.floor(n/96)*17)%period,(n*53+Math.floor(n/96)*29)%period];
}
export function grainPlateValues(grain: GrainChoice): Float32Array {
  const values=new Float32Array(GRAIN_TILE*GRAIN_TILE*3),c=grain.colour/100,norm=Math.sqrt((1-c)**2+c*c);
  const env=[0,0,3,grain.roughness/100];
  for(let y=0;y<GRAIN_TILE;y++)for(let x=0;x<GRAIN_TILE;x++) {
    env[0]=x;env[1]=y;env[2]=3;const mono=plateLattice(env);
    for(let ch=0;ch<3;ch++){env[2]=ch;values[(y*GRAIN_TILE+x)*3+ch]=((1-c)*mono+c*plateLattice(env))/norm;}
  }
  return values;
}
export function grainGLSL(plate = false): string {
  return `float h4_square(float x){return x*x;}\n` + Object.entries(definitions).map(([name, d]) =>
    `float h4_${name}(${d.names.map(n => `float ${n}`).join(",")}){return ${emit(d.value, "glsl")};}`).join("\n") + `
vec3 h4_finish(vec3 rgb, vec2 pixel, vec2 shape, float n, float amount, float size, float rough, float colour, float shadows, float highlights, float vamount, float midpoint, float feather){
  float period=floor(96.0*(1.0+size*.045)+.5),fn=mod(floor(n),4093.0);
  float ox=mod(fn*37.0+floor(fn/96.0)*17.0,period),oy=mod(fn*53.0+floor(fn/96.0)*29.0,period);
  float x=(pixel.x+ox+.5)*96.0/period-.5,y=(pixel.y+oy+.5)*96.0/period-.5;
  rough*=.01; colour*=.01; shadows*=.01; highlights*=.01;
  if(amount>0.0){
  float r=rgb.r,g=rgb.g,b=rgb.b,l=${emit(luma, "glsl")};
  float weight=${emit(response, "glsl")};
  ${plate ? "vec3 noise=texture(grainPlate,(vec2(x,y)+.5)/96.0).rgb;" : "float mono=h4_noise(x,y,0.0,3.0,rough); vec3 chroma=vec3(h4_noise(x,y,0.0,0.0,rough),h4_noise(x,y,0.0,1.0,rough),h4_noise(x,y,0.0,2.0,rough)); vec3 noise=mix(vec3(mono),chroma,colour)/sqrt((1.0-colour)*(1.0-colour)+colour*colour);"}
  rgb=clamp(rgb+noise*amount*.0012*weight,0.0,1.0);
  }
  float u=(pixel.x+.5)/shape.x,v=(pixel.y+.5)/shape.y,radius=${emit(radius, "glsl")},edge=${emit(edge, "glsl")};
  return clamp(rgb*${emit(vignette, "glsl")},0.0,1.0);
}`;
}
export function finishPixel(rgb: number[], x: number, y: number, frame: number, width: number, height: number, grain?: GrainChoice | null, vig?: VignetteChoice | null): number[] {
  let result = rgb;
  if (grain?.amount) {
    const period=grainPeriod(grain.size),offset=grainOffset(frame,period);
    const env={x:(x+offset[0]+.5)*GRAIN_TILE/period-.5,y:(y+offset[1]+.5)*GRAIN_TILE/period-.5,n:0,rough:grain.roughness/100};
    const mono = evaluate(texture, { ...env, c: 3 }), c = grain.colour / 100;
    const weight = evaluate(response, { l: evaluate(luma, { r: rgb[0], g: rgb[1], b: rgb[2] }), shadows: grain.shadows / 100, highlights: grain.highlights / 100 });
    result = rgb.map((v, i) => Math.max(0, Math.min(1, v + ((1 - c) * mono + c * evaluate(texture, { ...env, c: i })) / Math.sqrt((1-c)**2+c*c) * grain.amount * .0012 * weight)));
  }
  if (vig?.amount) {
    const env = { u: (x+.5)/width, v: (y+.5)/height, midpoint: vig.midpoint, feather: vig.feather, vamount: vig.amount };
    const gain = evaluate(vignette, { ...env, edge: evaluate(edge, { ...env, radius: evaluate(radius, env) }) });
    result = result.map(v => Math.max(0, Math.min(1, v * gain)));
  }
  return result;
}
export const grainReadme = "Grain and vignette appear in the finished video only. Resolve keeps original ungraded picture; reapply the saved grain preset, grain settings and post-crop vignette there.";

/** A cacheable single frame, generated with the same lattice as the shader. */
export function grainTileFilter(grain: GrainChoice, fps=1): string {
    const c = grain.colour/100;
    const n = (channel: number) => emit(lattice,"ffmpeg",{x:"X",y:"Y",n:"0",c:String(channel),rough:String(grain.roughness/100)});
    const channels = ["r","g","b"].map((ch,i) => {
      const noise = c === 0 ? n(3) : c === 1 ? n(i) : `((${1-c}*${n(3)}+${c}*${n(i)})/${Math.sqrt((1-c)**2+c*c)})`;
      return `${ch}='32768+16384*${noise}'`;
    });
    return `nullsrc=s=96x96:r=${fps},format=gbrp16le,geq=${channels.join(":")}:interpolation=nearest`;
}

/** Low-resolution procedural field, expanded once. All blend arithmetic is full
 * range 16-bit RGB; luminance response is a LUT, not three full-frame geq runs. */
export function grainGraph(input: string, output: string, grain: GrainChoice | null | undefined, vig: VignetteChoice | null | undefined,
  out: { width: number; height: number; fps: number; canonicalWidth?: number; canonicalHeight?: number; platePath?: string; frameOffset?: number }, prefix = "h4"): string[] {
  const filters: string[] = [];
  let picture = input;
  if (grain?.amount) {
    const period=grainPeriod(grain.size),px=Math.max(1,Math.round(period*out.width/(out.canonicalWidth??out.width))),py=Math.max(1,Math.round(period*out.height/(out.canonicalHeight??out.height)));
    const columns=Math.ceil(out.width/px)+3,rows=Math.ceil(out.height/py)+3;
    // Escape the option value, then the containing filter graph (two parsers).
    const file=out.platePath?.replace(/[\\':]/g,"\\$&").replace(/[\\'\[\],;]/g,"\\$&");
    filters.push(file ? `movie=filename=${file},format=gbrp16le[${prefix}tile]` : `${grainTileFilter(grain,out.fps)},trim=end_frame=1[${prefix}tile]`);

    const repeat = (source: string, count: number, axis: "h" | "v", dest: string) => {
      if (count === 1) { filters.push(`[${source}]null[${dest}]`); return; }
      const labels = Array.from({ length: count }, (_, i) => `[${prefix}${axis}${i}]`).join("");
      filters.push(`[${source}]split=${count}${labels}`, `${labels}${axis}stack=inputs=${count}[${dest}]`);
    };
    // Stack references to the same small field instead of evaluating a wrapping
    // lookup expression at every full-frame pixel.
    repeat(`${prefix}tile`, columns, "h", `${prefix}row`);
    repeat(`${prefix}row`, rows, "v", `${prefix}field`);
    // EXP2: a part of the export starts at frameOffset on the edit's clock and takes the same grain frames.
    const at=out.frameOffset?`n+${out.frameOffset}`:"n",clock=out.frameOffset?`(N+${out.frameOffset})`:"N";
    const frame=`mod(${at},4093)`,ox=`mod(${frame}*37+floor(${frame}/96)*17,${px})`,oy=`mod(${frame}*53+floor(${frame}/96)*29,${py})`;
    // Expand and quantize the stationary plate once. Each frame is a cheap
    // crop of a reused buffer, with no full-frame resize or noise generation.
    filters.push(`[${prefix}field]scale=${columns*px}:${rows*py}:flags=bilinear,format=gbrp,loop=loop=-1:size=1:start=0,setpts=${clock}/${out.fps}/TB,crop=${out.width}:${out.height}:'${px}+${ox}':'${py}+${oy}'[${prefix}noise]`);
    filters.push(`[${picture}]format=gbrp16le,split=2[${prefix}base][${prefix}luma]`);
    // Only the two LUT indices are quantized. The picture and signed delta
    // remain 16 bit. A 256 x 256 table replaces the full-frame mask, multiply,
    // centre subtraction and amplitude passes. No scalar evaluator per pixel.
    const weightExpr=emit(response,"ffmpeg",{l:"y/255",shadows:String(grain.shadows/100),highlights:String(grain.highlights/100)});
    filters.push(`[${prefix}luma]colorchannelmixer=rr=.2126:rg=.7152:rb=.0722,extractplanes=r,format=gray,split=3[${prefix}lr][${prefix}lg][${prefix}lb]`,
      `[${prefix}lg][${prefix}lb][${prefix}lr]mergeplanes=0x001020:format=gbrp[${prefix}weight]`,
      `[${prefix}noise]format=gbrp[${prefix}index]`);
    const delta=`clip(32768+65535*((x-128)/64)*${grain.amount*.0012}*${weightExpr},0,65535)`;
    filters.push(`[${prefix}index][${prefix}weight]lut2=c0='${delta}':c1='${delta}':c2='${delta}':d=16:shortest=1[${prefix}delta]`,
      `[${prefix}base][${prefix}delta]blend=all_mode=grainmerge:shortest=1[${prefix}grain]`);
    picture = `${prefix}grain`;
  }
  if (vig?.amount) {
    const env = {u:"(X+.5)/W",v:"(Y+.5)/H",midpoint:String(vig.midpoint),feather:String(vig.feather),vamount:String(vig.amount)};
    const gain = emit(vignette,"ffmpeg",{...env,edge:emit(edge,"ffmpeg",{...env,radius:emit(radius,"ffmpeg",env)})});
    // Geometry is static. Evaluate the radial mask once and reuse its frame;
    // SIMD multiply plus a LUT avoids a full-frame expression on every frame.
    const scale = vig.amount > 0 ? 32767.5 : 65535;
    filters.push(`nullsrc=s=${out.width}x${out.height}:r=${out.fps},trim=end_frame=1,format=gray16le,geq=lum='${scale}*${gain}',split=3[${prefix}vr][${prefix}vg][${prefix}vb]`);
    filters.push(`[${prefix}vg][${prefix}vb][${prefix}vr]mergeplanes=0x001020:format=gbrp16le,loop=loop=-1:size=1:start=0,setpts=N/${out.fps}/TB[${prefix}vignette]`);
    filters.push(`[${picture}]format=gbrp16le[${prefix}vigbase]`);
    filters.push(`[${prefix}vigbase][${prefix}vignette]blend=all_mode=multiply:shortest=1${vig.amount > 0 ? ",lutrgb=r='min(65535,val*2)':g='min(65535,val*2)':b='min(65535,val*2)'" : ""}[${output}]`);
  } else filters.push(`[${picture}]null[${output}]`);
  return filters;
}
