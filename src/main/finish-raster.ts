import type { Clip } from '../shared/schema';
import type { CutFraming } from './preview';

/** Bound pointwise camera/colour work by the retained picture, with 12.5%
 * sampling headroom. The decoder still reads every original frame. Crop paths
 * keep their exact normalized geometry and never lose output resolution. */
export function finishingRaster(clip: Clip, plan: CutFraming | undefined, out: { w: number; h: number }) {
  const width = clip.meta!.width, height = clip.meta!.height;
  if (!plan) return { clip, plan, scale: 1 };
  const rects = [...(plan.rects ?? []), ...(plan.crop ? [plan.crop] : []), ...(plan.match ? [plan.match.from] : [])];
  const zoom = Math.max(1, plan.scale * (1 + plan.push));
  const extent = rects.length ? { w: Math.min(...rects.map(r => r.w)) / zoom, h: Math.min(...rects.map(r => r.h)) / zoom } : { w: width / zoom, h: height / zoom };
  const needed = rects.length ? Math.max(out.w / extent.w, out.h / extent.h) : Math.min(out.w / extent.w, out.h / extent.h);
  const ratio = Math.min(1, needed * 1.125);
  if (!(ratio < .85)) return { clip, plan, scale: 1 };
  const w = Math.ceil(width * ratio / 2) * 2, h = Math.ceil(height * ratio / 2) * 2, xScale = w / width, yScale = h / height;
  const rect = <T extends { x: number; y: number; w: number; h: number }>(r: T): T => ({ ...r, x: r.x * xScale, y: r.y * yScale, w: r.w * xScale, h: r.h * yScale });
  return { scale: ratio, clip: { ...clip, meta: { ...clip.meta!, width: w, height: h } }, plan: {
    ...plan, crop: plan.crop ? { ...rect(plan.crop), ...(plan.crop.keyframes ? { keyframes: plan.crop.keyframes.map(k => ({ ...k, x: k.x * xScale })) } : {}) } : null,
    ...(plan.rects ? { rects: plan.rects.map(rect) } : {}), ...(plan.match ? { match: { ...plan.match, from: rect(plan.match.from) } } : {}),
  } };
}
