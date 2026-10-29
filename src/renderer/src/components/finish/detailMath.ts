import type { DetailChoice } from "../../../../shared/schema";

export const DEFAULT_DETAIL: Readonly<DetailChoice> = { amount: 25, radius: 1, detail: 25, masking: 40, texture: 0, clarity: 0, diffusion: 0 };
export const NO_DETAIL: Readonly<DetailChoice> = { ...DEFAULT_DETAIL, amount: 0 };
export const DETAIL_REASON = "Sharpened lightly for phone screens";
export const DETAIL_BOUNDS: Record<keyof DetailChoice, readonly [number, number]> = {
  amount: [0, 150], radius: [.5, 3], detail: [0, 100], masking: [0, 100], texture: [-100, 100], clarity: [-100, 100], diffusion: [0, 100],
};
export function normalizeDetail(value: Partial<DetailChoice> | null | undefined, previous?: DetailChoice | null): DetailChoice | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose detail settings.");
  const base = previous ?? NO_DETAIL;
  return Object.fromEntries(Object.entries(DETAIL_BOUNDS).map(([key, [lo, hi]]) => {
    const v = value[key as keyof DetailChoice];
    return [key, typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : base[key as keyof DetailChoice]];
  })) as unknown as DetailChoice;
}
export const detailActive = (d?: DetailChoice | null) => !!d && !!(d.amount || d.texture || d.clarity || d.diffusion);
export const detailReadme = "Detail (sharpening, texture, clarity and diffusion) appears in the finished video only. Resolve keeps original ungraded picture; reapply the saved detail settings there.";
export const DETAIL_LUMA = [.2126, .7152, .0722] as const;
export const DETAIL_HIGHLIGHT = .75;
// 50 visibly lifts highlight surroundings; 100 gives strong halation while
// leaving the source edges and below-threshold regions intact.
export const DETAIL_SCREEN = .0096;
export const DETAIL_STEPS = [1, 2, 4, 8] as const;
export const DETAIL_KERNEL = [1, 4, 6, 4, 1] as const;

// Scalar expressions are emitted to GLSL and FFmpeg and evaluated by the CPU
// reference. The blur kernel, edge extension and highlight threshold are shared.
type E = number | string | { op: string; args: E[] };
const op = (name: string, ...args: E[]): E => ({ op: name, args });
const add = (a: E, b: E) => op("+", a, b), sub = (a: E, b: E) => op("-", a, b), mul = (a: E, b: E) => op("*", a, b), div = (a: E, b: E) => op("/", a, b);
const abs = (a: E) => op("abs", a), min = (a: E, b: E) => op("min", a, b), max = (a: E, b: E) => op("max", a, b);
const sat = (a: E) => min(1, max(0, a));
const mix = (a: E, b: E, t: E) => add(mul(a, sub(1, t)), mul(b, t));
const expressions: [string, E][] = [
  ["sharp", mix(mix("l", "fine", min(1, "radius")), "medium", sat(div(sub("radius", 1), 2)))],
  ["mask", sat(div(sub("edge", mul("masking", .0015)), add(.04, mul("masking", .001))))],
  // At zero masking every pixel participates. Low Detail suppresses halos on
  // strong contrast; high Detail retains the complete unsharp signal.
  ["edgeWeight", mix(1, "mask", mul("masking", .01))],
  ["halo", mix(div(1, add(1, mul(abs(sub("l", "sharp")), 40))), 1, mul("detail", .01))],
  ["delta", add(add(mul(mul(mul(sub("l", "sharp"), mul("amount", .01)), "halo"), "edgeWeight"),
    div(mul(sub("fine", "medium"), mul("texture", .008)), add(1, mul("edge", 20)))),
    mul(mul(sub("l", "wide"), mul("clarity", .006)), mul(4, mul("l", sub(1, "l")))))],
];
function emit(e: E, target: "glsl" | "ffmpeg", env: Record<string, string>): string {
  if (typeof e === "number") return target === "glsl" && Number.isInteger(e) ? `${e}.0` : String(e);
  if (typeof e === "string") return env[e] ?? e;
  const a = e.args.map(v => emit(v, target, env));
  return ["+", "-", "*", "/"].includes(e.op) ? `(${a[0]}${e.op}${a[1]})` : `${e.op}(${a.join(",")})`;
}
function evaluate(e: E, env: Record<string, number>): number {
  if (typeof e === "number") return e;
  if (typeof e === "string") return env[e];
  const [a,b] = e.args.map(v => evaluate(v, env));
  switch(e.op) { case "+": return a+b; case "-": return a-b; case "*": return a*b; case "/": return a/b; case "abs": return Math.abs(a); case "min": return Math.min(a,b); default: return Math.max(a,b); }
}
// Fold inactive controls before building the export expression. The same AST
// remains the source; zero Texture/Clarity does not pay for their neighbourhoods.
function specialize(e: E, constants: Record<string, number>): E {
  if (typeof e === "number") return e;
  if (typeof e === "string") return constants[e] ?? e;
  const args = e.args.map(a => specialize(a, constants));
  if (args.every(a => typeof a === "number")) return evaluate({op:e.op,args}, {});
  if (e.op === "*" && args.includes(0)) return 0;
  if (e.op === "*" && args[0] === 1) return args[1];
  if (e.op === "*" && args[1] === 1 || e.op === "/" && args[1] === 1 || ["+", "-"].includes(e.op) && args[1] === 0) return args[0];
  if (e.op === "+" && args[0] === 0) return args[1];
  return {op:e.op,args};
}
export function detailGLSL(): string {
  return `float h12_delta(float l,float fine,float medium,float wide,float edge,float amount,float radius,float detail,float masking,float texture,float clarity){\n${expressions.map(([k,e]) => `float ${k}=${emit(e,"glsl",{})};`).join("\n")}\nreturn delta;}\nfloat h12_mask(float edge,float masking){float mask=${emit(expressions[1][1],"glsl",{})};return ${emit(expressions[2][1],"glsl",{})};}\nfloat h12_bloom(float l){return clamp((l-${DETAIL_HIGHLIGHT})/${1-DETAIL_HIGHLIGHT},0.,1.);}`;
}
export function detailDelta(env: Record<string, number>): { delta: number; mask: number } {
  env = { ...env };
  for (const [key,e] of expressions) env[key] = evaluate(e, env);
  return { delta: env.delta, mask: env.edgeWeight };
}
/** RGB interleaved normalized floats. Clamped edge extension, separable pyramid. */
export function detailFrame(input: ArrayLike<number>, width: number, height: number, d: DetailChoice | null, maskOnly = false): Float64Array {
  if (!detailActive(d) && !maskOnly) return Float64Array.from(input);
  d ??= { ...NO_DETAIL };
  const n = width*height, luma = new Float64Array(n), bright = new Float64Array(n);
  for (let i=0;i<n;i++) { luma[i]=input[i*3]*DETAIL_LUMA[0]+input[i*3+1]*DETAIL_LUMA[1]+input[i*3+2]*DETAIL_LUMA[2]; bright[i]=Math.max(0,Math.min(1,(luma[i]-DETAIL_HIGHLIGHT)/(1-DETAIL_HIGHLIGHT))); }
  const sample = (a: Float64Array,x: number,y: number) => a[Math.max(0,Math.min(height-1,y))*width+Math.max(0,Math.min(width-1,x))];
  const blur = (a: Float64Array, step: number) => {
    const temp=new Float64Array(n),out=new Float64Array(n);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let t=-2;t<=2;t++)temp[y*width+x]+=sample(a,x+t*step,y)*DETAIL_KERNEL[t+2]/16;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let t=-2;t<=2;t++)out[y*width+x]+=sample(temp,x,y+t*step)*DETAIL_KERNEL[t+2]/16;
    return out;
  };
  const levels=[luma]; for(const step of DETAIL_STEPS) { levels.push(blur(levels.at(-1)!,step)); if(d.diffusion) bright.set(blur(bright,step)); }
  const out=new Float64Array(n*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=y*width+x, edge=Math.max(Math.abs(sample(luma,x+1,y)-sample(luma,x-1,y)),Math.abs(sample(luma,x,y+1)-sample(luma,x,y-1)));
    const {delta,mask}=detailDelta({...d,l:luma[i],fine:levels[1][i],medium:levels[2][i],wide:levels[4][i],edge});
    for(let c=0;c<3;c++) { const v=Math.max(0,Math.min(1,input[i*3+c]+delta)); out[i*3+c]=maskOnly?mask:v+(1-v)*bright[i]*d.diffusion*DETAIL_SCREEN; }
  }
  return out;
}

/** Sharpening needs only one difference and one edge mask. LUTs evaluate the
 * shared scalar expression once per code value instead of per output pixel. */
function sharpeningGraph(input: string, output: string, d: DetailChoice, prefix: string): string[] {
  const p=(s:string)=>`${prefix}${s}`,f:string[]=[];
  f.push(`[${input}]format=gbrp16le,split=2[${p("rgb")}][${p("lumaSource")}]`);
  const weights=DETAIL_LUMA;
  f.push(`[${p("lumaSource")}]colorchannelmixer=${["r","g","b"].flatMap(out=>["r","g","b"].map((ch,i)=>`${out}${ch}=${weights[i]}`)).join(":")},extractplanes=r,split=${d.clarity?4:3}[${p("base")}][${p("edgeSource")}][${p("next0")}]${d.clarity?`[${p("claritySource")}]`:""}`);
  const count=d.radius>1?2:1;
  for(let i=0;i<count;i++) {
    const step=DETAIL_STEPS[i],margin=step*2,kernel=Array.from({length:step*4+1},(_,i)=>i%step===0?DETAIL_KERNEL[i/step]:0).join(" ");
    f.push(`[${p(`next${i}`)}]pad=iw+${margin*2}:ih:${margin}:0,fillborders=left=${margin}:right=${margin}:mode=smear,convolution=0m='${kernel}':0rdiv=.0625:0mode=row,crop=iw-${margin*2}:ih:${margin}:0,pad=iw:ih+${margin*2}:0:${margin},fillborders=top=${margin}:bottom=${margin}:mode=smear,convolution=0m='${kernel}':0rdiv=.0625:0mode=column,crop=iw:ih-${margin*2}:0:${margin}${i===0&&count===2?`,split=2[${p("fine")}][${p("next1")}]`:`[${p("blur")}]`}`);
  }
  if(count===2) f.push(`[${p("blur")}][${p("fine")}]blend=all_mode=normal:all_opacity=${(d.radius-1)/2}:shortest=1[${p("sharp")}]`);
  else f.push(`[${p("blur")}]null[${p("sharp")}]`);
  f.push(`[${p("sharp")}]lut=y='65535-val'[${p("inverse")}]`, `[${p("base")}][${p("inverse")}]blend=all_mode=normal:all_opacity=.5:shortest=1[${p("difference")}]`);
  const env:Record<string,string>={l:`(val-32768)*${2*Math.min(1,d.radius)}/65535`,fine:"0",medium:"0",wide:"0",edge:"0"};
  const constants={...d,radius:1,masking:0,texture:0,clarity:0,diffusion:0};
  // Inline the tiny AST for a LUT: unlike per-frame geq this is 65536 entries.
  for(const [k,e] of expressions) env[k]=emit(specialize(e,constants),"ffmpeg",env);
  f.push(`[${p("difference")}]lut=y='32768+65535*(${env.delta})/4'[${p("gain")}]`);
  if(d.masking) {
    const maskEnv:Record<string,string>={edge:"val/65535",masking:String(d.masking)};
    maskEnv.mask=emit(expressions[1][1],"ffmpeg",maskEnv);
    const weight=emit(expressions[2][1],"ffmpeg",maskEnv);
    // Signed central differences with native convolution. Padding keeps the
    // exact clamped edge extension used by the live shader.
    f.push(`[${p("edgeSource")}]split=2[${p("ex")}][${p("ey")}]`);
    for(const axis of ["x","y"] as const) {
      const pad=axis==="x"?"pad=iw+2:ih:1:0,fillborders=left=1:right=1:mode=smear":"pad=iw:ih+2:0:1,fillborders=top=1:bottom=1:mode=smear";
      const crop=axis==="x"?"crop=iw-2:ih:1:0":"crop=iw:ih-2:0:1";
      f.push(`[${p(`e${axis}`)}]${pad},convolution=0m='-1 0 1':0rdiv=.5:0bias=32768:0mode=${axis==="x"?"row":"column"},${crop},lut=y='min(65535,abs(val-32768)*2)'[${p(`abs${axis}`)}]`);
    }
    f.push(`[${p("absx")}][${p("absy")}]blend=all_mode=lighten:shortest=1,lut=y='65535*${weight}',split=2[${p("mask")}][${p("halfMask")}]`,
      `[${p("halfMask")}]lut=y='val/2'[${p("centre")}]`,
      `[${p("gain")}][${p("mask")}]blend=all_mode=multiply:shortest=1[${p("weighted")}]`,
      `[${p("weighted")}][${p("centre")}]blend=all_mode=grainextract:shortest=1[${p("masked")}]`);
  } else f.push(`[${p("edgeSource")}]nullsink`, `[${p("gain")}]null[${p("masked")}]`);
  let deltaSource=p("masked");
  if(d.clarity) {
    // Clarity uses the same original luminance and four-level clamped pyramid
    // as the live shader. Keep it grayscale; no per-pixel expression evaluator.
    f.push(`[${p("claritySource")}]split=3[${p("clarityBase")}][${p("clarityWeight")}][${p("cNext0")}]`);
    for(let i=0;i<4;i++) {
      const step=DETAIL_STEPS[i],margin=step*2,kernel=Array.from({length:step*4+1},(_,i)=>i%step===0?DETAIL_KERNEL[i/step]:0).join(" ");
      f.push(`[${p(`cNext${i}`)}]pad=iw+${margin*2}:ih:${margin}:0,fillborders=left=${margin}:right=${margin}:mode=smear,convolution=0m='${kernel}':0rdiv=.0625:0mode=row,crop=iw-${margin*2}:ih:${margin}:0,pad=iw:ih+${margin*2}:0:${margin},fillborders=top=${margin}:bottom=${margin}:mode=smear,convolution=0m='${kernel}':0rdiv=.0625:0mode=column,crop=iw:ih-${margin*2}:0:${margin}[${p(`cNext${i+1}`)}]`);
    }
    f.push(`[${p("cNext4")}]lut=y='65535-val'[${p("clarityInverse")}]`,
      `[${p("clarityBase")}][${p("clarityInverse")}]blend=all_mode=normal:all_opacity=.5:shortest=1,lut=y='32768+(val-32768)*${2*d.clarity*.006/4}'[${p("clarityGain")}]`,
      `[${p("clarityWeight")}]lut=y='65535*4*(val/65535)*(1-val/65535)',split=2[${p("clarityMask")}][${p("clarityHalf")}]`,
      `[${p("clarityHalf")}]lut=y='val/2'[${p("clarityCentre")}]`,
      `[${p("clarityGain")}][${p("clarityMask")}]blend=all_mode=multiply:shortest=1[${p("clarityWeighted")}]`,
      `[${p("clarityWeighted")}][${p("clarityCentre")}]blend=all_mode=grainextract:shortest=1[${p("clarityDelta")}]`,
      `[${p("masked")}][${p("clarityDelta")}]blend=all_mode=grainmerge:shortest=1[${p("combinedDelta")}]`);
    deltaSource=p("combinedDelta");
  }
  // A single native add suffices when the configured unsharp gain cannot
  // exceed half range. Stronger combined controls share signed headroom
  // across several monotonic adds before the final clamp.
  const adds=d.clarity?Math.max(1,Math.ceil(2*(d.amount*.01+Math.abs(d.clarity)*.006))):d.amount<=50?1:2;
  f.push(`[${deltaSource}]lut=y='clip(32768+(val-32768)*${4/adds},0,65535)',split=3[${p("dr")}][${p("dg")}][${p("db")}]`,
    `[${p("dg")}][${p("db")}][${p("dr")}]mergeplanes=0x001020:format=gbrp16le${adds>1?`,split=${adds}${Array.from({length:adds},(_,i)=>`[${p(`delta${i+1}`)}]`).join("")}`:`[${p("delta1")}]`}`);
  for(let i=0;i<adds;i++) f.push(`[${i?p(`partial${i}`):p("rgb")}][${p(`delta${i+1}`)}]blend=all_mode=grainmerge:shortest=1[${i===adds-1?output:p(`partial${i+1}`)}]`);
  return f;
}

// Highlight diffusion needs only a thresholded grayscale pyramid and a screen
// blend. Native convolution/LUT filters avoid evaluating per-pixel expressions
// or building unused texture/clarity scales on every exported frame.
function diffusionGraph(input: string, output: string, d: DetailChoice, prefix: string): string[] {
  const p = (name: string) => `${prefix}${name}`;
  const f = [`[${input}]format=gbrp16le,split=2[${p("detailSource")}][${p("brightSource")}]`,
    ...detailGraph(p("detailSource"),p("detailed"),{...d,diffusion:0},p("sharp"))];
  const weights = ["r","g","b"].flatMap(out => ["r","g","b"].map((ch,i) => `${out}${ch}=${DETAIL_LUMA[i]}`)).join(":");
  f.push(`[${p("brightSource")}]colorchannelmixer=${weights},extractplanes=r,lut=y='clip((val-${DETAIL_HIGHLIGHT*65535})/${1-DETAIL_HIGHLIGHT},0,65535)'[${p("bright0")}]`);
  DETAIL_STEPS.forEach((step,i) => {
    const margin=step*2,kernel=Array.from({length:step*4+1},(_,n)=>n%step===0?DETAIL_KERNEL[n/step]:0).join(" ");
    f.push(`[${p(`bright${i}`)}]pad=iw+${margin*2}:ih:${margin}:0,fillborders=left=${margin}:right=${margin}:mode=smear,convolution=0m='${kernel}':0rdiv=.0625:0mode=row,crop=iw-${margin*2}:ih:${margin}:0,pad=iw:ih+${margin*2}:0:${margin},fillborders=top=${margin}:bottom=${margin}:mode=smear,convolution=0m='${kernel}':0rdiv=.0625:0mode=column,crop=iw:ih-${margin*2}:0:${margin}[${p(`bright${i+1}`)}]`);
  });
  f.push(`[${p("bright4")}]lut=y='val*${d.diffusion*DETAIL_SCREEN}',split=3[${p("r")}][${p("g")}][${p("b")}]`,
    `[${p("g")}][${p("b")}][${p("r")}]mergeplanes=0x001020:format=gbrp16le[${p("screen")}]`,
    `[${p("detailed")}][${p("screen")}]blend=all_mode=screen:shortest=1[${output}]`);
  return f;
}

/** 16-bit planar filter graph. The four luminance scales are packed into RGBA
 * planes once; one scalar geq produces a signed delta applied equally to RGB. */
export function detailGraph(input: string, output: string, d: DetailChoice | null | undefined, prefix="h12"): string[] {
  if (!detailActive(d)) return [`[${input}]null[${output}]`];
  d=d!;
  if (d.diffusion && !d.texture) return diffusionGraph(input,output,d,prefix);
  if (!d.texture && !d.diffusion) return sharpeningGraph(input,output,d,prefix);
  const f:string[]=[], p=(s:string)=>`${prefix}${s}`;
  f.push(`[${input}]format=gbrp16le,split=2[${p("rgb")}][${p("seed")}]`);
  const l=`(r(X,Y)*${DETAIL_LUMA[0]}+g(X,Y)*${DETAIL_LUMA[1]}+b(X,Y)*${DETAIL_LUMA[2]})`;
  f.push(`[${p("seed")}]geq=r='${l}':g='${d.diffusion ? `65535*clip((${l}/65535-${DETAIL_HIGHLIGHT})/${1-DETAIL_HIGHLIGHT},0,1)` : 0}':b=0:interpolation=nearest,split=2[${p("level0")}][${p("next0")}]`);
  const count=d.clarity||d.diffusion?4:2;
  for(let i=0;i<count;i++) {
    const step=DETAIL_STEPS[i];
    const margin = step*2;
    const kernel = Array.from({length:step*4+1},(_,i)=>i%step===0?DETAIL_KERNEL[i/step]:0).join(" ");
    const convolution = (mode: string) => `convolution=${[0,1,2].map(plane=>`${plane}m='${kernel}':${plane}rdiv=.0625:${plane}mode=${mode}`).join(":")}`;
    // Smear a temporary border before each axis, then crop. This gives exactly
    // the GPU's clamp-to-edge extension without convolution's reflected edges.
    for(const axis of ["x","y"] as const) {
      const pad = axis === "x" ? `pad=iw+${margin*2}:ih:${margin}:0,fillborders=left=${margin}:right=${margin}:mode=smear` : `pad=iw:ih+${margin*2}:0:${margin},fillborders=top=${margin}:bottom=${margin}:mode=smear`;
      const crop = axis === "x" ? `crop=iw-${margin*2}:ih:${margin}:0` : `crop=iw:ih-${margin*2}:0:${margin}`;
      f.push(`[${axis==="x"?p(`next${i}`):p(`horizontal${i}`)}]${pad},${convolution(axis==="x"?"row":"column")},${crop}[${axis==="x"?p(`horizontal${i}`):p(`blur${i+1}`)}]`);
    }
    f.push(`[${p(`blur${i+1}`)}]split=2[${p(`level${i+1}`)}][${p(`next${i+1}`)}]`);
  }
  f.push(`[${p(`next${count}`)}]nullsink`);
  for(let i=0;i<=count;i++) {
    if([0,1,2,count].includes(i)) {
      if(i===count && d.diffusion) { f.push(`[${p(`level${i}`)}]split=2[${p("wideSource")}][${p("brightSource")}]`, `[${p("brightSource")}]extractplanes=g[${p("bloom")}]`); }
      f.push(`[${i===count&&d.diffusion?p("wideSource"):p(`level${i}`)}]extractplanes=r[${p(`lum${i}`)}]`);
    } else f.push(`[${p(`level${i}`)}]nullsink`);
  }
  if(count===2) f.push(`[${p("lum2")}]split=2[${p("medium")}][${p("wide")}]`);
  f.push(`[${p("lum0")}][${p("lum1")}][${count===2?p("medium"):p("lum2")}][${count===2?p("wide"):p("lum4")}]mergeplanes=0x00102030:format=gbrap16le[${p("scales")}]`);
  const env:Record<string,string>={...Object.fromEntries(Object.entries(d).map(([k,v])=>[k,String(v)])),l:"g(X,Y)/65535",fine:"b(X,Y)/65535",medium:"r(X,Y)/65535",wide:"alpha(X,Y)/65535",edge:"max(abs(g(min(X+1,W-1),Y)-g(max(X-1,0),Y)),abs(g(X,min(Y+1,H-1))-g(X,max(Y-1,0))))/65535"};
  const seq=expressions.map(([k,e],i)=>{const value=emit(specialize(e,{...d}),"ffmpeg",env);env[k]=`ld(${i})`;return `st(${i},${value})`;}).join(";");
  // Reserve signed headroom for simultaneous maximum controls before the
  // final RGB clamp, including isolated white pixels on a black background.
  const delta=`${seq};32768+8191*${env.delta}`;
  // Extract before dropping alpha: the bundled FFmpeg swscale conversion
  // gbrap16le -> gbrp16le corrupts the tail of each threaded slice.
  f.push(`[${p("scales")}]geq=r='${delta}':g=0:b=0:interpolation=nearest,extractplanes=r,split=3[${p("dr")}][${p("dg")}][${p("db")}]`, `[${p("dg")}][${p("db")}][${p("dr")}]mergeplanes=0x001020:format=gbrp16le[${p("delta")}]`);
  f.push(`[${p("rgb")}][${p("delta")}]blend=all_expr='clip(A+(B-32768)*65535/8191,0,65535)':shortest=1[${p("detailed")}]`);
  if(d.diffusion) {
    f.push(`[${p("bloom")}]format=gbrp16le,lutrgb=r='val*${d.diffusion*DETAIL_SCREEN}':g='val*${d.diffusion*DETAIL_SCREEN}':b='val*${d.diffusion*DETAIL_SCREEN}'[${p("screen")}]`, `[${p("detailed")}][${p("screen")}]blend=all_mode=screen:shortest=1[${output}]`);
  } else f.push(`[${p("detailed")}]null[${output}]`);
  return f;
}
