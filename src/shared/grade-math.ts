import { lookScalar } from "./look-scalar";
// Pure grade stages, shared by export, LUT workers and renderer parameters.
import type { BasicAdjust, Grade, PieceLook } from "./schema";
import { MIXER_HUES, mixerTransform, normalizeMixer } from "../main/mixer";
import { BASIC_BOUNDS, normalizeBasic, hasBasic, basicBefore, basicAfter } from "../main/basics";
// These additions live here until the shared contract owner adds intensity.
export type LookGrade = Grade & { intensity?: number };
export type LookPreference = { preset: string; words: string | null; intensity?: number; basic?: BasicAdjust };
type RGB = [number, number, number];
export interface GalleryLook {
  id: string; name: string; description: string; family: "Film" | "Warm" | "Cool" | "Soft" | "Mono";
  exposure: number; contrast: number; saturation: number; temperature: number; tint: number;
  fade: number; rolloff: number; shadows: RGB; highlights: RGB;
  /** CIELAB a/b offsets at full intensity, applied after skin protection. */
  cast?: { a: number; b: number };
}
const look = (id: string, name: string, description: string, values: Partial<Omit<GalleryLook, "id" | "name" | "description">> = {}): GalleryLook => ({
  id, name, description, family: "Film", exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0,
  fade: 0, rolloff: .63, shadows: [0, 0, 0], highlights: [0, 0, 0], ...values,
});
/** Fixed local numbers; selecting a preset never invokes a model. */
export const LOOKS: readonly GalleryLook[] = [
  look("clean", "Clean", "True colour, gentle highlights. Your footage, clear.", {family: "Soft", exposure: 0.00000, contrast: 1, saturation: 1, temperature: 0, tint: 0, fade: 0, rolloff: 0.63, shadows: [0, 0, 0], highlights: [0, 0, 0]}),
  look("hearth", "Hearth", "Amber light, full colour and grounded shadows.", {cast: { a: 0.7, b: 3 }, family: "Warm", exposure: -0.30700, contrast: 1.485, saturation: 1.934, temperature: 1.13, tint: 0, fade: 0, rolloff: 0.52, shadows: [0, 0, 0], highlights: [0.16, 0.025, -0.13]}),
  look("linen", "Linen", "Warm soft film, faded blacks and quiet colour.", {family: "Soft", exposure: -1.00500, contrast: 0.875, saturation: 0.495, temperature: 0.136, tint: 0, fade: 0.167, rolloff: 0.47, shadows: [0.012, 0.007, 0], highlights: [0, 0, 0]}),
  look("afterhours", "Afterhours", "Deep blue shadows, spare colour and soft lights.", {family: "Cool", exposure: -0.49900, contrast: 1.799, saturation: 0.497, temperature: 0, tint: 0, fade: 0, rolloff: 0.48, shadows: [-0.005, 0.015, 0.13], highlights: [0, 0, 0]}),
  look("openair", "Open air", "Crisp contrast, bright whites and clear colour.", {family: "Cool", exposure: -0.43000, contrast: 1.959, saturation: 1.114, temperature: 0, tint: 0, fade: 0, rolloff: 0.67, shadows: [-0.02, 0.01, 0.03], highlights: [0, 0, 0]}),
  look("neon", "Night bus", "Teal shadows and clear skin under city lights.", {family: "Cool", exposure: -0.41200, contrast: 0.869, saturation: 1.108, temperature: 0, tint: 0, fade: 0.039, rolloff: 0.5, shadows: [-0.09, 0.11, 0.14], highlights: [0.012, 0.004, -0.005]}),
  look("hush", "Hush", "Low colour, flat light and a quiet matte finish.", {family: "Soft", exposure: -0.32266, contrast: 1.07470, saturation: 0.44911, temperature: 0, tint: 0, fade: 0.07779, rolloff: 0.53, shadows: [0.00772, -0.00574, 0.09503], highlights: [0, 0, 0]}),
  look("silver", "Silver", "Rich black and white, deep blacks and silver light.", {family: "Mono", exposure: -0.24000, contrast: 1.442, saturation: 0, temperature: 0, tint: 0, fade: 0.016, rolloff: 0.49, shadows: [0, 0, 0], highlights: [0, 0, 0]}),
  look("lastlight", "Last light", "Golden warmth, soft highlights and an open glow.", {cast: { a: 0.7, b: 4 }, family: "Warm", exposure: -0.24000, contrast: 0.952, saturation: 1.441, temperature: 0.7, tint: 0, fade: 0.022, rolloff: 0.45, shadows: [0.05, 0.032, -0.03], highlights: [0.065, 0.045, -0.055]}),
  look("warm-negative", "Warm negative", "Warm skin, pastel light and gentle film contrast.", {cast: { a: 2, b: 11.5 }, family: "Film", exposure: -0.19016, contrast: 1.08463, saturation: 0.76024, temperature: 0.29741, tint: 0.23235, fade: 0.00279, rolloff: 0.47, shadows: [0.00682, -0.00735, 0.00797], highlights: [0.02642, -0.00649, -0.0423]}),
  look("pastel-green", "Pastel green", "Airy highlights with a soft green-cyan cast.", {family: "Film", exposure: -0.34723, contrast: 0.72, saturation: 0.68465, temperature: -0.36949, tint: -0.65587, fade: 0.02227, rolloff: 0.45, shadows: [-0.03204, 0.02044, 0.02293], highlights: [-0.00356, 0.00304, 0.01904]}),
  look("slide", "Slide", "Rich warm reds, clear colour and deep film contrast.", {family: "Film", exposure: -0.19920, contrast: 1.44294, saturation: 1.33538, temperature: 0.4389, tint: 0.50412, fade: 0.01118, rolloff: 0.56, shadows: [0.00673, 0.00407, 0.00338], highlights: [0.01636, -0.0363, 0.01461]}),
  look("drugstore", "Drugstore", "Punchy everyday film with green shadows.", {family: "Film", exposure: -0.41652, contrast: 1.27338, saturation: 1.21651, temperature: 0.19854, tint: -0.70079, fade: 0, rolloff: 0.52, shadows: [-0.04199, 0.05925, -0.03104], highlights: [-0.02467, 0.00699, 0.01097]}),
  look("rust", "Rust", "Rust warmth, quiet colour and lifted blacks.", {cast: { a: 4.6, b: 11 }, family: "Warm", exposure: -0.56196, contrast: 1.1647, saturation: 0.4, temperature: 0.95418, tint: 0.20769, fade: 0.08044, rolloff: 0.48, shadows: [0.02046, -0.00408, -0.03679], highlights: [0.0085, 0.00944, 0.02532]}),
  look("golden-fade", "Golden fade", "Faded gold and a soft late-day finish.", {cast: { a: 1, b: 12 }, family: "Warm", exposure: -0.53508, contrast: 0.86952, saturation: 0.96928, temperature: 1.17669, tint: -0.15878, fade: 0.06157, rolloff: 0.43, shadows: [-0.00835, -0.00855, 0.02156], highlights: [0.04504, 0.04346, -0.06086]}),
  look("analog", "Analog", "Toasty analog colour and rounded highlights.", {cast: { a: 1.5, b: 10 }, family: "Warm", exposure: -0.45591, contrast: 1.19886, saturation: 1.06, temperature: 0.72, tint: 0.38225, fade: 0.012, rolloff: 0.48, shadows: [-0.00219, -0.02593, -0.04781], highlights: [-0.02108, -0.00368, -0.02404]}),
  look("candy", "Candy", "Vivid colour, pink highlights and blue shadows.", {family: "Warm", exposure: -0.29079, contrast: 0.97986, saturation: 1.46644, temperature: 0.07051, tint: 0.92216, fade: 0, rolloff: 0.5, shadows: [-0.02733, -0.02156, 0.08192], highlights: [0.05874, -0.01962, 0.0409]}),
  look("mellow", "Mellow", "Muted blue wash with soft grey blacks.", {cast: { a: 0, b: -4 }, family: "Cool", exposure: -0.68859, contrast: 0.9926, saturation: 0.4, temperature: -0.72113, tint: -0.13438, fade: 0.0607, rolloff: 0.48, shadows: [-0.00226, 0.01641, 0.05486], highlights: [-0.0089, -0.01643, 0.00718]}),
  look("street-cool", "Street cool", "Cool faded streets, crisp edges and quiet colour.", {cast: { a: 0, b: -4 }, family: "Cool", exposure: -0.49076, contrast: 1.2572, saturation: 0.5895, temperature: -0.98858, tint: -0.12684, fade: 0.04052, rolloff: 0.55, shadows: [-0.01992, 0.01235, 0.03924], highlights: [-0.01284, 0.00792, -0.00178]}),
  look("field", "Field", "Natural colour with a cool-green breeze.", {family: "Cool", exposure: -0.13045, contrast: 1.00271, saturation: 0.5921, temperature: -0.10649, tint: -1.3, fade: 0.00595, rolloff: 0.58, shadows: [-0.00046, 0.0094, -0.05065], highlights: [-0.03025, 0.02398, -0.00748]}),
  look("night-tungsten", "Night tungsten", "Teal night shadows and warm practical lights.", {family: "Cool", exposure: -0.25389, contrast: 1.33219, saturation: 0.89294, temperature: -0.77774, tint: 0.11227, fade: 0, rolloff: 0.44, shadows: [-0.09702, 0.00933, 0.09301], highlights: [0.07003, -0.00158, -0.07444]}),
  look("pastel", "Pastel", "Powdery pink colour and soft pastel light.", {family: "Soft", exposure: -0.55587, contrast: 0.72, saturation: 0.72715, temperature: -0.03678, tint: 0.74635, fade: 0.0464, rolloff: 0.42, shadows: [0.02686, -0.0437, 0.03398], highlights: [0.01894, -0.00145, -0.00935]}),
  look("cinematic", "Cinematic", "Restrained teal shadows with warm natural skin.", {family: "Soft", exposure: -0.21722, contrast: 1.4261, saturation: 0.56437, temperature: -0.50548, tint: -0.14378, fade: 0.012, rolloff: 0.49, shadows: [-0.08129, -0.01695, 0.01285], highlights: [0.02721, 0.04013, -0.06138]}),
  look("contrast-mono", "Contrast mono", "Bold monochrome with full blacks and clean light.", {family: "Mono", exposure: -0.60, contrast: 2.22, saturation: 0, temperature: 0, tint: 0, fade: 0.012, rolloff: 0.55, shadows: [0, 0, 0], highlights: [0, 0, 0]}),
  look("soft-mono", "Soft mono", "Gentle monochrome with open, silver-grey shadows.", {family: "Mono", exposure: -0.70288, contrast: 0.72646, saturation: 0, temperature: 0, tint: 0, fade: 0.07668, rolloff: 0.44, shadows: [0, 0, 0], highlights: [0, 0, 0]}),
];
export function isLookPreset(id: unknown): id is string { return typeof id === "string" && LOOKS.some((entry) => entry.id === id); }
export function lookIntensity(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : .7; }
/** Hand edits accept partial controls, discard malformed fields and clamp numbers. */
export function normalizePieceLook(value: unknown): PieceLook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as PieceLook, result: PieceLook = {};
  for (const key of ["filmFade", "diffusion"] as const) if (typeof v[key] === "number" && Number.isFinite(v[key])) result[key] = clamp(v[key]!, 0, 100);
  if (isLookPreset(v.preset)) result.preset = v.preset;
  if (typeof v.intensity === "number" && Number.isFinite(v.intensity)) result.intensity = lookIntensity(v.intensity);
  if (v.basic && typeof v.basic === "object" && !Array.isArray(v.basic)) {
    const basic = Object.fromEntries(Object.entries(BASIC_BOUNDS).flatMap(([key, [lo, hi]]) => {
      const n = v.basic![key as keyof BasicAdjust];
      return typeof n === "number" && Number.isFinite(n) ? [[key, Math.min(hi, Math.max(lo, n))]] : [];
    }));
    if (Object.keys(basic).length) result.basic = basic;
  }
  if (v.mixer && typeof v.mixer === "object" && !Array.isArray(v.mixer)) {
    const mixer = Object.fromEntries(Object.keys(MIXER_HUES).flatMap(key => {
      const band = v.mixer![key as keyof typeof MIXER_HUES];
      if (!band || typeof band !== "object" || Array.isArray(band)) return [];
      if (!["hue", "sat", "lum"].some(k => typeof band[k as keyof typeof band] === "number" && Number.isFinite(band[k as keyof typeof band]))) return [];
      const values = Object.fromEntries(["hue", "sat", "lum"].map(k => {
        const n = band[k as keyof typeof band];
        return [k, typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(-100, n)) : 0];
      }));
      return [[key, values]];
    })) as PieceLook["mixer"];
    if (Object.keys(mixer!).length) result.mixer = mixer;
  }
  return Object.keys(result).length ? result : null;
}
/** Matching is measured from the source; these controls follow that correction. */
export function gradeForPiece(grade: LookGrade, value?: PieceLook | null): LookGrade {
  const look = normalizePieceLook(value);
  if (!look) return grade;
  const basic = normalizeBasic(grade.basic);
  return { ...grade, ...look,
    ...(look.diffusion === undefined ? {} : { detail: { amount: 0, radius: 1, detail: 25, masking: 40, texture: 0, clarity: 0, ...grade.detail, diffusion: look.diffusion } }),
    basic: look.basic ? normalizeBasic(Object.fromEntries(Object.keys(BASIC_BOUNDS).map(key =>
      [key, basic[key as keyof BasicAdjust] + (look.basic![key as keyof BasicAdjust] ?? 0)]))) : grade.basic,
    mixer: look.mixer ? { ...grade.mixer, ...look.mixer } : grade.mixer };
}
export function gradeForLook(input: Grade["input"], preference: LookPreference): LookGrade {
  if (!isLookPreset(preference.preset)) throw new Error("Choose a look from the gallery.");
  return { ...neutralGrade(input), preset: preference.preset, intensity: lookIntensity(preference.intensity), ...(preference.basic ? { basic: normalizeBasic(preference.basic) } : {}) };
}

export type GradeInput = Grade["input"];
export interface PieceCorrection { stops: number; rolloff: number; matched?: boolean; gains?: RGB }
export interface LutOptions { cacheDir?: string; pieceExposure?: PieceCorrection }
export const LUT_SIZE = 33;
// Grade's contract specifies exposure/white balance bounds. These conservative
// contrast/saturation limits complete that contract for the look prompt.
export const GRADE_BOUNDS = {
  exposure: [-2, 2], contrast: [0.5, 2], saturation: [0, 2],
  temperature: [-1, 1], tint: [-1, 1],
} as const;
type Matrix = readonly (readonly [number, number, number])[];
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** Conversion IDs are local until the shared-contract owner expands Grade.input. */
export type CameraInput = GradeInput | "slog3-sgamut3" | "slog2" | "clog2" | "clog3" |
  "nlog" | "vlog" | "flog" | "flog2" | "apple-log" | "pq" | "srgb";
export type CameraGrade = Omit<LookGrade, "input"> & { input: CameraInput };
export const CAMERA_INPUTS: readonly CameraInput[] = ["slog3", "slog3-sgamut3", "slog2", "clog2", "clog3", "nlog", "vlog", "flog", "flog2", "apple-log", "hlg", "pq", "rec709", "srgb", "unknown"];
export function validInput(input: GradeInput): GradeInput {
  return ["slog3", "rec709", "hlg", "unknown"].includes(input) ? input : "unknown";
}

export function neutralGrade(input: GradeInput): Grade {
  return { input: validInput(input), exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, look: null };
}

export function clampGrade(grade: LookGrade): LookGrade {
  const result: LookGrade = neutralGrade(grade.input);
  for (const key of Object.keys(GRADE_BOUNDS) as (keyof typeof GRADE_BOUNDS)[]) {
    const n = grade[key];
    result[key] = typeof n === "number" && Number.isFinite(n)
      ? clamp(n, ...GRADE_BOUNDS[key]) : result[key];
  }
  result.look = typeof grade.look === "string" && grade.look.trim() ? grade.look : null;
  result.preset = isLookPreset(grade.preset) ? grade.preset : "clean";
  result.intensity = lookIntensity(grade.intensity);
  result.filmFade = Number.isFinite(grade.filmFade) ? clamp(grade.filmFade!, 0, 100) : 0;
  result.fade = Number.isFinite(grade.fade) ? clamp(grade.fade!, 0, .15) : 0;
  result.rolloff = Number.isFinite(grade.rolloff) ? clamp(grade.rolloff!, .4, .8) : .63;
  if (grade.basic) result.basic = normalizeBasic(grade.basic);
  if (grade.matchClips !== undefined) result.matchClips = grade.matchClips;
  if (grade.matchRef !== undefined) result.matchRef = grade.matchRef;
  if (grade.mixer) result.mixer = normalizeMixer(grade.mixer);
  return result;
}

// Sony Technical Summary, appendix pp. 6–7: inverse S-Log3 (FULL 0..1023
// code values), and S-Gamut3.Cine D65 RGB -> XYZ matrix. Not a Sony LUT.
// https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf
// Sony's executable inverse curve is also published in its ACES IDT:
// https://github.com/ampas/aces-dev/blob/v1.3/transforms/ctl/idt/vendorSupplied/sony/IDT.Sony.SLog3_SGamut3Cine.ctl
const CINE_TO_XYZ: Matrix = [
  [0.5990839208, 0.2489255161, 0.1024464902],
  [0.2150758201, 0.8850685017, -0.1001443219],
  [-0.0320658495, -0.0276583907, 1.1487819910],
];
// Inverse of the normalised-primary matrix from BT.709's primaries and D65.
// OETF: ITU-R BT.709-6, table 1 (4.5 L / 1.099 L^0.45 - 0.099).
// https://www.itu.int/rec/R-REC-BT.709-6-201506-I/en
const XYZ_TO_709: Matrix = [
  [3.2409699419, -1.5373831776, -0.4986107603],
  [-0.9692436363, 1.8759675015, 0.0415550574],
  [0.0556300797, -0.2039769589, 1.0569715142],
];
const multiply = (m: Matrix, rgb: RGB): RGB => m.map((row) =>
  row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]) as RGB;
function slog3ToLinear(v: number): number {
  return v >= 171.2102946929 / 1023
    ? 10 ** ((v * 1023 - 420) / 261.5) * 0.19 - 0.01
    : (v * 1023 - 95) * 0.01125 / (171.2102946929 - 95);
}
function rec709(v: number): number { return v < 0.018 ? 4.5 * v : 1.099 * v ** 0.45 - 0.099; }
// The nominal rolloff is .63, with a broad transition beginning .20 earlier
// than that point. Continuous slope at the knee; a slight toe anchors black.
function filmic(v: number): number {
  const x = Math.max(0, v), toe = x * x / (x + .0015);
  const knee = .63 - .20, headroom = 1 - knee;
  return toe <= knee ? toe : 1 - headroom * Math.exp(-(toe - knee) / headroom);
}
/** Compress chroma around luminance before individual channels can clip.
 * Hue is preserved, including negative/out-of-gamut reds and oranges. */
export function cleanLinear(linear: RGB): RGB {
  const y = Math.max(0, .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]);
  if (y < 1e-8) return [0, 0, 0];
  const delta = linear.map(v => v - y) as RGB;
  const extent = Math.max(...delta.map(v => Math.abs(v))) / y;
  const knee = .55, compressed = extent <= knee ? extent : knee + .55 * (1 - Math.exp(-(extent - knee) / .55));
  let scale = extent > 0 ? compressed / extent : 1;
  for (const d of delta) if (d < 0) scale = Math.min(scale, y / -d);
  return delta.map(d => clamp(rec709(filmic(y + d * scale)))) as RGB;
}

// G3 viewing calibration, independently generated maths, not Sony LUT samples.
// Reference: Sony SLog3SGamut3.CineToLC-709TypeA.cube, from Sony's official
// Resolve pack (QA only). A neutral-preserving scene-light gamut compression
// follows the published primary conversion. Integrating two sigmoids gives
// separately controlled toe/shoulder slopes without forcing scene white to 1.
// Calibration uses a general camera-code grid, never the shoot's pixels.
// Measured with ffmpeg tetrahedral 33^3 interpolation on 12 RGB16 shoot frames
// (1000, 0989, 0994/96/98/99/95): see qa/G3/REPORT.md for before/after CIEDE2000,
// 2nd/98th-percentile display luma and actual clip.subject face-box means.
// Before: mean ΔE00 2.419–2.900; p95 ΔE00 9.419–10.117.
// After: mean ΔE00 0.477–0.719; p95 ΔE00 1.587–2.133; maximum absolute
// black/highlight error 0.429/0.190 percentage points (before: 3.804/10.990).
const VIEWING_GAMUT: Matrix = [
  [.75322768, .20216161, .04461072],
  [.04144377, .88769166, .07086457],
  [.03263863, .14190935, .82545202],
];
function linearToSlog3(v: number): number {
  return v >= .01125 ? (420 + 261.5 * Math.log10((v + .01) / .19)) / 1023
    : (95 + v * (171.2102946929 - 95) / .01125) / 1023;
}
function viewingTone(v: number): number {
  if (v <= 0) return 0;
  const softplus = (x: number) => Math.max(x, 0) + Math.log1p(Math.exp(-Math.abs(x)));
  const slope = 2.16681746, toe = .239944787, toeWidth = .0921666731;
  const shoulder = .701456651, shoulderWidth = .0756933486, offset = -.000641132056;
  const curve = (x: number) => offset + slope * (
    toeWidth * softplus((x - toe) / toeWidth) - shoulderWidth * softplus((x - shoulder) / shoulderWidth));
  // Anchor zero code to true black, with no added pedestal. Sony's viewing
  // toe itself maps nominal S-Log3 scene black (95/1023) above zero; retaining
  // that toe is necessary to match the reference, rather than crushing it.
  return clamp(curve(v) - curve(0) * Math.exp(-v / .02));
}
function cleanSony(linear709: RGB): RGB {
  return multiply(VIEWING_GAMUT, linear709).map(v => viewingTone(linearToSlog3(v))) as RGB;
}

// Simple HLG SDR rendering: BT.2100 inverse OETF, BT.2020 -> BT.709,
// 3x scene gain (HLG reference white near 75%), same fixed shoulder/OETF.
// Assumes BT.2020 HLG, without a display-dependent OOTF or HDR mastering data.
// https://www.itu.int/rec/R-REC-BT.2100
const BT2020_TO_709: Matrix = [
  [1.6604910021, -0.5876411388, -0.0728498633],
  [-0.1245504745, 1.1328998971, -0.0083494226],
  [-0.0181507634, -0.1005788980, 1.1187296614],
];
function hlgToLinear(v: number): number {
  return v <= 0.5 ? v * v / 3 : (Math.exp((v - 0.55991073) / 0.17883277) + 0.28466892) / 12;
}

function convert(rgb: RGB, input: GradeInput): RGB {
  let linear: RGB;
  if (input === "slog3") {
    linear = multiply(XYZ_TO_709, multiply(CINE_TO_XYZ, rgb.map(slog3ToLinear) as RGB));
  } else if (input === "hlg") {
    linear = multiply(BT2020_TO_709, rgb.map((v) => 3 * hlgToLinear(v)) as RGB);
  } else return rgb; // Rec.709 and unknown are identity, including neutral black.
  return input === "slog3" ? cleanSony(linear) : cleanLinear(linear);
}

// All curve APIs use published normalised 10-bit code (CV/1023), not IRE.
// Canon v1.2 coefficients include the studio pedestal; do not legal-expand
// those values twice. Reflection is 1.0 for 100% reflectance.
// Canon (2018/2020) gamma whitepaper, Appendix, and vendor ACES transforms:
// https://downloads.canon.com/nw/learn/white-papers/cinema-eos/white-paper-canon-log-gamma-curves.pdf
// https://github.com/ampas/aces-dev/tree/v1.3/transforms/ctl/idt/vendorSupplied/canon
// Nikon N-Log Specification, equations (1),(2), BT.2020 primaries:
// https://download.nikonimglib.com/archive3/hDCmK00m9JDI03RPruD74xpoU905/N-Log_Specification_(En)01.pdf
// Panasonic V-Log/V-Gamut, equations and matrix (D65):
// https://pro-av.panasonic.net/en/varicam/common/pdf/VARICAM_V-Log_V-Gamut.pdf
// Fujifilm, curve section 2-3 and BT.2020 primaries section 3:
// https://dl.fujifilm-x.com/support/lut/F-Log_DataSheet_E_Ver.1.1.pdf
// https://dl.fujifilm-x.com/support/lut/F-Log2_DataSheet_E_Ver.1.0.pdf
// Apple Log Profile White Paper and vendor-supplied IDT (BT.2020):
// https://developer.apple.com/download/all/?q=Apple%20log%20profile
// https://github.com/ampas/aces-dev/blob/528c78fe2c0f4e7eb322581e98aba05de79466cb/transforms/ctl/idt/vendorSupplied/apple/IDT.Apple.AppleLog_BT2020.ctl
// Sony S-Log2: S-Log whitepaper, 155/219 scaling, reflection /0.9:
// https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf
const FLOG = [.555556, .009468, .344676, .790453, 8.735631, .092864, .00089, .100537775223865];
const FLOG2 = [5.555556, .064829, .245281, .384316, 8.799461, .092864, .000889, .100686685370811];
export function encodeCameraCurve(x: number, input: CameraInput): number {
  switch (input) {
    case "slog3": case "slog3-sgamut3": return linearToSlog3(x);
    case "slog2": {
      const t = x * 155 / 219 / .9;
      return (64 + 876 * (t >= 0 ? .432699 * Math.log10(t + .037584) + .646596 : 5 * t + .0300012228518893)) / 1023;
    }
    case "clog2": { const t = x / .9; return .092864125 + Math.sign(t) * .24136077 * Math.log10(1 + 87.09937546 * Math.abs(t)); }
    case "clog3": { const t = x / .9; return t < -.014 ? -.36726845 * Math.log10(1 - 14.98325 * t) + .12783901 :
      t <= .014 ? 1.9754798 * t + .12512219 : .36726845 * Math.log10(1 + 14.98325 * t) + .12240537; }
    case "nlog": return (x < .328 ? 650 * Math.cbrt(x + .0075) : 150 * Math.log(x) + 619) / 1023;
    case "vlog": return x < .01 ? 5.6 * x + .125 : .241514 * Math.log10(x + .00873) + .598206;
    case "flog": case "flog2": {
      const [a,b,c,d,e,f,cut] = input === "flog" ? FLOG : FLOG2;
      return x < cut ? e * x + f : c * Math.log10(a * x + b) + d;
    }
    case "apple-log": return x >= .01 ? .08550479 * Math.log2(x + .00964052) + .69336945 : x >= -.05641088 ? 47.28711236 * (x + .05641088) ** 2 : 0;
    case "hlg": return x <= 1 / 12 ? Math.sqrt(3 * Math.max(0,x)) : .17883277 * Math.log(12 * x - .28466892) + .55991073;
    case "pq": { const p = Math.max(0,x) ** (2610 / 16384); return ((3424 / 4096 + 2413 / 128 * p) / (1 + 2392 / 128 * p)) ** (2523 / 32); }
    case "srgb": return x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055;
    case "rec709": return rec709(x);
    default: return x;
  }
}
export function decodeCameraCurve(v: number, input: CameraInput): number {
  switch (input) {
    case "slog3": case "slog3-sgamut3": return slog3ToLinear(v);
    case "slog2": {
      const t = (v * 1023 - 64) / 876;
      return .9 * 219 / 155 * (t >= .0300012228518893 ? 10 ** ((t - .646596) / .432699) - .037584 : (t - .0300012228518893) / 5);
    }
    case "clog2": return .9 * Math.sign(v - .092864125) * (10 ** (Math.abs(v - .092864125) / .24136077) - 1) / 87.09937546;
    case "clog3": return .9 * (v < .097465473 ? -(10 ** ((.12783901 - v) / .36726845) - 1) / 14.98325 :
      v <= .15277891 ? (v - .12512219) / 1.9754798 : (10 ** ((v - .12240537) / .36726845) - 1) / 14.98325);
    case "nlog": return v * 1023 < 452 ? (v * 1023 / 650) ** 3 - .0075 : Math.exp((v * 1023 - 619) / 150);
    case "vlog": return v < .181 ? (v - .125) / 5.6 : 10 ** ((v - .598206) / .241514) - .00873;
    case "flog": case "flog2": {
      const [a,b,c,d,e,f,,cut] = input === "flog" ? FLOG : FLOG2;
      return v < cut ? (v - f) / e : (10 ** ((v - d) / c) - b) / a;
    }
    case "apple-log": return v >= 47.28711236 * (.01 + .05641088) ** 2 ? 2 ** ((v - .69336945) / .08550479) - .00964052 : Math.sqrt(Math.max(v,0) / 47.28711236) - .05641088;
    case "hlg": return hlgToLinear(v);
    case "pq": { const n = Math.max(v,0) ** (32 / 2523); return (Math.max(n - 3424 / 4096, 0) / (2413 / 128 - 2392 / 128 * n)) ** (16384 / 2610); }
    case "srgb": return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    case "rec709": return v < .081 ? v / 4.5 : ((v + .099) / 1.099) ** (1 / .45);
    default: return v;
  }
}
// Sony's D65 S-Gamut and S-Gamut3 primaries; Canon Cinema Gamut D65
// normalized-primary matrix (R .74/.27, G .17/1.14, B .08/-.10).
// Sources: Sony technical summary above; Canon's vendor ACES IDT above.
const SGAMUT_TO_XYZ: Matrix = [[.7064827132,.1288010498,.1151721641],[.2709796708,.7866064112,-.0575860820],[-.0096778454,.0046000375,1.0941355587]];
const SGAMUT3_TO_XYZ: Matrix = SGAMUT_TO_XYZ;
const CINEMA_TO_XYZ: Matrix = [[.7160496548,.1296834779,.1047227940],[.2612613560,.8696421450,-.1309035010],[-.0096763456,-.2364816431,1.3352157395]];
const VGAMUT_TO_XYZ: Matrix = [[.679644,.152211,.118600],[.260686,.774894,-.035580],[-.009310,-.004612,1.102980]];
export function cameraLinear709(rgb: RGB, input: CameraInput): RGB {
  const linear = rgb.map(v => decodeCameraCurve(v, input)) as RGB;
  if (input === "rec709" || input === "srgb" || input === "unknown") return linear;
  const xyz = input === "slog3" ? CINE_TO_XYZ : input === "slog3-sgamut3" ? SGAMUT3_TO_XYZ : input === "slog2" ? SGAMUT_TO_XYZ :
    input === "clog2" || input === "clog3" ? CINEMA_TO_XYZ : input === "vlog" ? VGAMUT_TO_XYZ : null;
  return xyz ? multiply(XYZ_TO_709, multiply(xyz, linear)) : multiply(BT2020_TO_709, linear);
}
/** G3 Sony viewing response is retained. Other cameras share the fixed
 * neutral SDR viewing rendering; HDR values are scaled before its shoulder. */
export function convertCameraRGB(rgb: RGB, input: CameraInput): RGB {
  if (input === "rec709" || input === "srgb" || input === "unknown") return rgb;
  if (input === "slog3") return convert(rgb, input);
  const linear = cameraLinear709(rgb, input);
  const gain = input === "hlg" ? 3 : input === "pq" ? 100 : 1;
  return cleanLinear(linear.map(v => v * gain) as RGB);
}

export function lookParameters(grade:LookGrade):number[] {
  const g=clampGrade(grade),preset=LOOKS.find(entry=>entry.id===g.preset)!,i=g.intensity!,mix=(n:number,v:number)=>n+(v-n)*i;
  return [(g.exposure+preset.exposure)*i,mix(1,g.contrast)*mix(1,preset.contrast),(g.temperature+preset.temperature)*i,(g.tint+preset.tint)*i,
    mix(1,g.saturation)*(preset.family==="Mono"?Math.max(0,1-i/.7):mix(1,preset.saturation)),(g.fade!+preset.fade)*i,
    (.63-(.63+(g.rolloff!-.63+preset.rolloff-.63)*i))*3,i,preset.family==="Mono"?1:0,...preset.shadows,...preset.highlights,preset.cast?.a ?? 0,preset.cast?.b ?? 0,g.filmFade! / 100];
}
export function lookTransform(grade:LookGrade):(rgb:RGB)=>RGB {
  const p=lookParameters(grade);
  return rgb=>[lookScalar(...rgb,0,p),lookScalar(...rgb,1,p),lookScalar(...rgb,2,p)];
}

const inverse709 = (v: number) => v < .081 ? v / 4.5 : ((v + .099) / 1.099) ** (1 / .45);
const luma = (rgb: RGB) => .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
export function expose(rgb: RGB, exposure?: PieceCorrection): RGB {
  if (!exposure) return rgb;
  const stops = Number.isFinite(exposure.stops) ? clamp(exposure.stops, -1, exposure.matched ? .7 : 0) : 0;
  if (stops === 0 && !exposure.gains) return rgb;
  return rgb.map((v, c) => rec709(inverse709(v) * 2 ** stops * (exposure.gains?.[c] ?? 1))) as RGB;
}

export interface NeutralBase {
  gains: RGB; neutralRatios: RGB; vibrance: number; mid: number; black: number;
  neutralPixels: number; skinPixels: number; medianChroma: number;
  measuredMid: number; measuredBlack: number; confidence: number;
}
function hueSaturation(rgb: RGB) {
  const high = Math.max(...rgb), low = Math.min(...rgb), d = high-low;
  let h = d < 1e-8 ? 0 : high === rgb[0] ? 60*((rgb[1]-rgb[2])/d % 6) : high === rgb[1] ? 60*((rgb[2]-rgb[0])/d+2) : 60*((rgb[0]-rgb[1])/d+4);
  if (h < 0) h += 360;
  return { hue: h, saturation: high > 0 ? d/high : 0, chroma: d };
}
function skinLike(rgb: RGB): boolean {
  const {hue,saturation,chroma} = hueSaturation(rgb), y=luma(rgb);
  return hue >= 10 && hue <= 65 && saturation >= .15 && saturation <= .7 && chroma >= .018 && y > .06 && y < .85;
}
export function applyNeutralBase(rgb: RGB, base: NeutralBase): RGB {
  const before=hueSaturation(rgb), skin=skinLike(rgb);
  // Preserve likely skin hue/chroma exactly. Face measurement also constrains
  // the global gains, protecting skin even near the classifier's boundaries.
  let out=(skin ? rgb : rgb.map((v,c)=>v*base.gains[c])) as RGB;
  const y=luma(out), h=hueSaturation(out);
  let amount=skin ? 0 : base.vibrance*(1-h.saturation)**2;
  // Bright saturated practicals/neon only compress. Never lift those colours.
  if (!skin && Math.max(...rgb) > .7 && before.saturation > .65) amount=-.025*clamp((before.saturation-.65)/.35);
  out=out.map(v=>y+(v-y)*(1+amount)) as RGB;
  // Affine match leaves zero at zero and anchors white; bounded black effect
  // is local to shadows, mid effect fades out toward both endpoints.
  const matchLevel=(v: number)=>clamp(v + base.mid*4*v*(1-v) + base.black*clamp(1-v/.25)*clamp(v/.025));
  if (skin && y>0) {
    const gain=Math.min(matchLevel(y)/y,1/Math.max(...out));
    return out.map(v=>v*gain) as RGB; // matching preserves skin hue/saturation
  }
  return out.map(matchLevel) as RGB;
}
// The numeric evaluator is shared by the finishing cube and live composition.
export function gradeTransform(grade: LookGrade, exposure?: LutOptions["pieceExposure"]): (rgb: RGB) => RGB {
  const look = lookTransform(grade);
  const basic = normalizeBasic(grade.basic);
  const mixer = mixerTransform(grade.mixer);
  if (!hasBasic(basic)) return rgb => mixer(look(expose(rgb, exposure)));
  const before = basicBefore(basic), after = basicAfter(basic);
  return rgb => after(mixer(look(before(expose(rgb, exposure)))));
}
