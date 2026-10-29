// Playback accepts old or concurrently refreshed indexes. Repair only the
// in-memory draft, never the saved edit or the strict encoder geometry.
import type { Clip } from "../shared/schema";
import type { StoredVersion } from "./sidekick";

const positive = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const warned = new Set<string>();
const unknownSizes = new WeakSet<object>();
export const unknownDraftSize = (clip: Clip): boolean => !!clip.meta && unknownSizes.has(clip.meta);
function warn(root: string, clip: Clip | undefined, detail: unknown): void {
  const key = `${root}:${clip?.id ?? "output"}`;
  if (warned.has(key)) return;
  if (warned.size >= 512) warned.delete(warned.values().next().value!);
  warned.add(key);
  console.warn("[draft] Centre crop fallback", { clip: clip?.id, file: clip?.file, ...detail as object });
}

/** Unknown dimensions are marked for a centre crop from the decoded picture.
 * Temporary dimensions below keep draft planning finite, never encode pixels. */
export function draftGeometry(assembly: StoredVersion["assembly"]): StoredVersion["assembly"] {
  const raw = assembly.template;
  const template = positive(raw.width) && positive(raw.height) && positive(raw.fps) ? raw : {
    ...raw, width: positive(raw.width) ? raw.width : 1080,
    height: positive(raw.height) ? raw.height : 1920, fps: positive(raw.fps) ? raw.fps : 25,
  };
  if (template !== raw) warn(assembly.shoot.root, undefined, { output: raw });
  const out = { w: template.width, h: template.height };
  const centre = (clip: Clip, badSpan = false, span?: unknown): Clip => {
    if (!badSpan && positive(clip.meta?.width) && positive(clip.meta?.height)) return clip;
    warn(assembly.shoot.root, clip, { meta: clip.meta, span, output: out });
    const meta = clip.meta;
    // Coded dimensions are usable only as a pair and after the saved rotation.
    const turned = (meta?.rotation ?? 0) % 180 !== 0;
    const coded = positive(meta?.codedWidth) && positive(meta?.codedHeight);
    const width = positive(meta?.width) && positive(meta?.height) ? meta.width : coded ? (turned ? meta.codedHeight : meta.codedWidth) : out.w;
    const height = positive(meta?.width) && positive(meta?.height) ? meta.height : coded ? (turned ? meta.codedWidth : meta.codedHeight) : out.h;
    const next = { ...clip, subject: undefined, meta: { ...meta, width, height,
      fps: positive(meta?.fps) ? meta.fps : template.fps } as NonNullable<Clip["meta"]> };
    if (unknownDraftSize(clip) || !coded && !(positive(meta?.width) && positive(meta?.height))) unknownSizes.add(next.meta);
    return next;
  };
  let at = 0;
  const cutList = assembly.cutList.map(cut => {
    const rate = cut.clipFpsR.num / cut.clipFpsR.den;
    const sourceFps = positive(rate) ? rate : positive(cut.seg?.clip.meta?.fps) ? cut.seg.clip.meta.fps : template.fps;
    const inFrames = Number.isFinite(cut.inFrames) && cut.inFrames >= 0 ? cut.inFrames : 0;
    const duration = (cut.outFrames - inFrames) / sourceFps * template.fps;
    const durTimelineFrames = positive(cut.durTimelineFrames) ? cut.durTimelineFrames : positive(duration) ? duration : 1;
    const badSpan = rate !== sourceFps || inFrames !== cut.inFrames || durTimelineFrames !== cut.durTimelineFrames ||
      !Number.isFinite(cut.outFrames) || cut.outFrames <= inFrames;
    const seg = cut.seg ? { ...cut.seg, clip: centre(cut.seg.clip, badSpan, {
      s: cut.inFrames / rate, e: cut.inFrames / rate + cut.durTimelineFrames / template.fps,
    }) } : cut.seg;
    const offsetFrames = Number.isFinite(cut.offsetFrames) ? cut.offsetFrames : at;
    at += durTimelineFrames;
    if (!badSpan && seg?.clip === cut.seg?.clip && offsetFrames === cut.offsetFrames) return cut;
    return { ...cut, seg, inFrames, outFrames: badSpan ? inFrames + durTimelineFrames / template.fps * sourceFps : cut.outFrames,
      durTimelineFrames, offsetFrames, clipFpsR: { num: sourceFps, den: 1 } };
  });
  const broll = assembly.reel.broll.map(overlay => {
    const s = Number.isFinite(overlay.seg.s) && overlay.seg.s >= 0 ? overlay.seg.s : 0;
    const length = cutList.filter((c, i) => (c.piece ?? i) === overlay.voiceIndex)
      .reduce((n, c) => n + c.durTimelineFrames / template.fps, 0);
    const e = Number.isFinite(overlay.seg.e) && overlay.seg.e > s ? overlay.seg.e : s + Math.max(1 / template.fps, length);
    const badSpan = s !== overlay.seg.s || e !== overlay.seg.e || !positive(overlay.seg.clip.meta?.fps);
    const clip = centre(overlay.seg.clip, badSpan, { s: overlay.seg.s, e: overlay.seg.e });
    return clip === overlay.seg.clip && !badSpan ? overlay : { ...overlay, seg: { ...overlay.seg, clip, s, e } };
  });
  if (template === raw && cutList.every((c, i) => c === assembly.cutList[i]) && broll.every((o, i) => o === assembly.reel.broll[i])) return assembly;
  return { ...assembly, template, cutList, reel: { ...assembly.reel, broll } };
}
