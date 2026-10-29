import type { Grade } from '../../../../shared/schema';
import { MIXER_HUES } from '../../../../main/mixer';
export function mixerDelta(target: Grade['mixer'], baseline: Grade['mixer']) {
  return Object.keys(MIXER_HUES).flatMap(key => {
    const k = key as keyof NonNullable<Grade['mixer']>;
    return (['hue','sat','lum'] as const).map(axis=>(target?.[k]?.[axis] ?? 0)-(baseline?.[k]?.[axis] ?? 0));
  });
}
// Export and preview compile the same scalar evaluator.
export { mixerGLSL } from '../../../../shared/mixer-scalar';
import { mixerGLSL } from '../../../../shared/mixer-scalar';
export const mixerPreviewGLSL = mixerGLSL();
