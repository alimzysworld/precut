// Pure colour maths: shared by the production grade and browser fixture.
import type { BasicAdjust } from "../shared/schema";
export { basicBefore, basicAfter, basicLinear, basicDisplay } from "../renderer/src/components/finish/basicsMath";
export const BASIC_BOUNDS: Record<keyof BasicAdjust, readonly [number, number]> = {
  exposure: [-2, 2], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
  whites: [-100, 100], blacks: [-100, 100], temperature: [-100, 100], tint: [-100, 100],
  vibrance: [-100, 100], saturation: [-100, 100],
};
const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
export function normalizeBasic(value?: Partial<BasicAdjust> | null): BasicAdjust {
  return Object.fromEntries(Object.entries(BASIC_BOUNDS).map(([key, [min, max]]) => {
    const n = value?.[key as keyof BasicAdjust];
    return [key, typeof n === "number" && Number.isFinite(n) ? clamp(n, min, max) : 0];
  })) as unknown as BasicAdjust;
}
export function validBasic(value: unknown): value is BasicAdjust {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(BASIC_BOUNDS).every(key => typeof (value as BasicAdjust)[key as keyof BasicAdjust] === "number" && Number.isFinite((value as BasicAdjust)[key as keyof BasicAdjust]));
}
export const hasBasic = (basic: BasicAdjust) => Object.keys(BASIC_BOUNDS).some(key => basic[key as keyof BasicAdjust] !== 0);
