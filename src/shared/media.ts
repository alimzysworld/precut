// How the renderer asks for a shoot's frames and proxies in Electron.
// Main serves st-media:// (src/main/media.ts); only files inside
// <root>/.sidething/ are ever served. The browser fixture doesn't use this.
export const MEDIA_SCHEME = "st-media";

import type { Clip } from "./schema";
export const quarterTurn = (n: number): 0 | 90 | 180 | 270 => ((Math.round(n / 90) * 90 % 360 + 360) % 360) as 0 | 90 | 180 | 270;
/** Extra clockwise turn on top of the file. An explicit zero wins. */
export function clipTurn(clip: Clip): 0 | 90 | 180 | 270 {
  return quarterTurn(clip.byHand?.rotate ?? clip.judgement?.rotate ?? 0);
}
export const clipRotation = (clip: Clip) => quarterTurn((clip.meta?.rotation ?? 0) + clipTurn(clip));
export const clipFilterTurn = (clip: Clip) => quarterTurn(clipRotation(clip) - (clip.meta?.containerRotation ?? clip.meta?.rotation ?? 0));
/** ffmpeg autorotates the container before filters. Sidecars need a filter too. */
export function clipRotationFilter(clip: Clip): string {
  const turn = clipFilterTurn(clip);
  return turn === 90 ? "transpose=clock," : turn === 180 ? "hflip,vflip," : turn === 270 ? "transpose=cclock," : "";
}
/** FCPXML uses counterclockwise degrees. The original's matrix stays native. */
export const clipTransformXml = (clip: Clip) => clipFilterTurn(clip) ? `<adjust-conform type="none"/><adjust-transform rotation="${-clipFilterTurn(clip)}"/>` : "";
export function clipDimensions(clip: Clip): { width: number; height: number } {
  const m = clip.meta;
  if (!m) return { width: 0, height: 0 };
  // Older indexes have dimensions before the person's turn, but no coded size.
  const swapped = (m.rotation ?? 0) % 180 !== 0;
  const w = m.codedWidth ?? (swapped ? m.height : m.width), h = m.codedHeight ?? (swapped ? m.width : m.height);
  return clipRotation(clip) % 180 ? { width: h, height: w } : { width: w, height: h };
}
/** Native file shape before any extra orientation carried by our timeline. */
export function clipFileDimensions(clip: Clip): { width: number; height: number } {
  const base = displayedClip(clip);
  return clipDimensions({ ...base, byHand: { rotate: 0 }, judgement: null,
    meta: base.meta ? { ...base.meta, rotation: base.meta.containerRotation ?? base.meta.rotation } : null });
}
/** Idempotent projection, safe for saved assemblies as well as fresh indexes. */
export function displayedClip(clip: Clip): Clip {
  const m = clip.meta;
  if (!m) return clip;
  // Do not migrate untouched legacy assemblies just by opening or copying them.
  if (m.codedWidth === undefined && m.codedHeight === undefined && !m.rotation && !clipTurn(clip)) return clip;
  const swapped = (m.rotation ?? 0) % 180 !== 0;
  return { ...clip, meta: { ...m, codedWidth: m.codedWidth ?? (swapped ? m.height : m.width),
    codedHeight: m.codedHeight ?? (swapped ? m.width : m.height), ...clipDimensions(clip) } };
}

/** RT1 names turned proxies with the absolute baked orientation. Legacy proxies have the file's own turn. */
export function proxyRotation(proxy: string | null | undefined, fileRotation = 0): number {
  let name = proxy ?? "";
  try { name = decodeURIComponent(name); } catch { /* plain cache filename */ }
  return Number(/\.r(0|90|180|270)-[a-f0-9]+\.mp4(?:[?#]|$)/.exec(name)?.[1] ?? fileRotation);
}

export function mediaUrl(root: string, kind: "frames" | "proxies" | "judge" | "precuts", file: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(root)}/${kind}/${encodeURIComponent(file)}`;
}

// PS2: the stand-in strip, 5 frames a second at 540 px, made from the proxy.
// Frame N (1-based) sits at (N - 1) / STRIP_FPS seconds of the clip's source time.
export const STRIP_FPS = 5;
export function stripIndex(seconds: number, durationS: number): number {
  const last = Number.isFinite(durationS) ? Math.max(1, Math.floor(durationS * STRIP_FPS)) : Infinity;  // main clamps to the strip's real count
  const n = Math.round((Number.isFinite(seconds) ? Math.max(0, seconds) : 0) * STRIP_FPS) + 1;
  return Math.min(last, n);
}
/** The stand-in frame for a clip at a source time. Served by main from <root>/.sidething/thumbs/strips; 404s until the strip exists. */
export function standInUrl(root: string, clipId: string, seconds: number, durationS: number, rev = "", key?: string): string {
  const file = encodeURIComponent(`strip:${clipId}:${stripIndex(seconds, durationS)}${key ? `:${key}` : ""}.jpg`);
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(root)}/thumbs/${file}${rev ? `?rev=${encodeURIComponent(rev)}` : ""}`;
}
