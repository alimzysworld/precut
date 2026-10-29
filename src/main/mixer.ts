import { mixerScalar } from "../shared/mixer-scalar";
import type { Grade, MixerColour } from "../shared/schema";
type RGB = [number, number, number];
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
function hueSaturation(rgb: RGB) {
  const high = Math.max(...rgb), low = Math.min(...rgb), chroma = high-low;
  let hue = chroma < 1e-8 ? 0 : high === rgb[0] ? 60*((rgb[1]-rgb[2])/chroma % 6) : high === rgb[1] ? 60*((rgb[2]-rgb[0])/chroma+2) : 60*((rgb[0]-rgb[1])/chroma+4);
  if (hue < 0) hue += 360;
  return { hue, chroma };
}
export const MIXER_HUES: Record<MixerColour, number> = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 275, magenta: 315 };
export function validMixer(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, v]) =>
    Object.hasOwn(MIXER_HUES, key) && !!v && typeof v === "object" && ["hue", "sat", "lum"].every(k =>
      typeof (v as Record<string, unknown>)[k] === "number" && Number.isFinite((v as Record<string, number>)[k]) && Math.abs((v as Record<string, number>)[k]) <= 100));
}
export function normalizeMixer(value?: Grade["mixer"] | null): Grade["mixer"] {
  return Object.fromEntries(Object.keys(MIXER_HUES).filter(key => value?.[key as MixerColour]).map(key => {
    const v = value![key as MixerColour]!;
    return [key, Object.fromEntries(["hue", "sat", "lum"].map(k => [k, Number.isFinite(v[k as keyof typeof v]) ? clamp(v[k as keyof typeof v], -100, 100) : 0]))];
  }));
}
export function mixerTransform(value?: Grade["mixer"]): (rgb: RGB) => RGB {
  const normalized=normalizeMixer(value);
  const bands=Object.keys(MIXER_HUES).flatMap(key=>["hue","sat","lum"].map(axis=>normalized?.[key as MixerColour]?.[axis as "hue"|"sat"|"lum"] ?? 0));
  if(!bands.some(Boolean))return rgb=>rgb;
  return rgb=>[mixerScalar(...rgb,0,bands),mixerScalar(...rgb,1,bands),mixerScalar(...rgb,2,bands)];
}
