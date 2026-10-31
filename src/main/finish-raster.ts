import type { Clip, DraftPiece } from '../shared/schema';
import type { CutFraming } from './preview';

/** Bound pointwise camera/colour work by the retained picture, with 12.5%
 * sampling headroom. The decoder still reads every original frame. Crop paths
 * keep their exact normalized geometry and never lose output resolution. */
export function finishingRaster(clip: Clip, plan: CutFraming | undefined, out: { w: number; h: number }) {
  const width = clip.meta!.width, height = clip.meta!.height;
  if (!plan) return { clip, plan, scale: 1 };
  const rects = [...(plan.rects ?? []), ...(plan.crop ? [plan.crop] : []), ...(plan.match ? [plan.match.from] : [])];
  const zoom = Math.max(1, plan.scale * (1 + plan.push));
  const extent = rects.length ? { w: rects.reduce((m, r) => Math.min(m, r.w), Infinity) / zoom, h: rects.reduce((m, r) => Math.min(m, r.h), Infinity) / zoom } : { w: width / zoom, h: height / zoom };
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

/** Fuse the finishing raster's resize into the leading YCbCr conversion (`scale=in_color_matrix=...`), so the
 * pointwise LUTs after it run on the smaller picture, as previews do. Unchanged at full raster. */
export function rasterFilter(filter: string, raster: { clip: Clip; scale: number }): string {
  return raster.scale < 1 && filter.startsWith('scale=') ? `scale=w=${raster.clip.meta!.width}:h=${raster.clip.meta!.height}:flags=bicubic:${filter.slice(6)}` : filter;
}

/** EXP4 B: a layout region's framing in source pixels, from its normalized frame keys (one static crop when the
 * scene's keys never move). Every layout piece then takes finishingRaster's bound for its region, like a plain cut. */
export function regionFraming(clip: Clip, region: { frame?: DraftPiece['frame']; startS: number; layoutScene?: unknown }, length: number, planned?: CutFraming): CutFraming | undefined {
  const { width, height } = clip.meta!;
  if (region.frame?.length) planned = { scale: 1, push: 0, x: .5, y: .5, elapsed: 0, duration: length, crop: null, rects: region.frame.map(k => ({ t: k.t - region.startS, x: k.x * width, y: k.y * height, w: k.w * width, h: k.h * height })) };
  if (region.layoutScene && planned?.rects?.length) {
    const first = planned.rects[0];
    if (planned.rects.every(k => (['x', 'y', 'w', 'h'] as const).every(key => Math.abs(k[key] - first[key]) < 1e-6))) planned = { ...planned, rects: undefined, crop: { x: first.x, y: first.y, w: first.w, h: first.h } };
  }
  return planned;
}

/** EXP4 B: a moving layout region crops every frame itself before one fixed-size scale to `out`. Its source raster
 * is bounded by the smallest crop (source pixels) it ever takes, with finishingRaster's headroom. */
export function morphRaster(clip: Clip, crops: { w: number; h: number }[], out: { w: number; h: number }) {
  const { clip: scaled, scale } = finishingRaster(clip, { scale: 1, push: 0, x: .5, y: .5, elapsed: 0, duration: 0, crop: null, rects: crops.map(c => ({ t: 0, x: 0, y: 0, w: c.w, h: c.h })) }, out);
  return { clip: scaled, scale };
}
