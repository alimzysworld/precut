import { isScreenClip, screenText } from '../shared/screen';
// V2b: one metadata vocabulary for Footage and MCP. No inferred judgements.
import type { Clip } from "../shared/schema";
import { filmedTime } from "./filmed-time";
export const libraryFields = {
  camera: "Camera", resolution: "Resolution", fps: "Frame rate", codec: "Codec", pictureProfile: "Picture profile",
  iso: "ISO", shutter: "Shutter", aperture: "Aperture", focalLength: "Focal length", orientation: "Orientation",
  duration: "Duration", date: "Date (UTC)", time: "Time (UTC)", place: "Place", moment: "Moment", shotType: "Shot type", shotSize: "Shot size",
  junk: "Junk", hasSpeech: "Has speech", mediaType: "Photo or video", steadiness: "Steadiness", soundSource: "Sound source",
} as const;
export type LibraryField = keyof typeof libraryFields;
export const isLibraryField = (value: string): value is LibraryField => Object.hasOwn(libraryFields, value);
export function libraryValue(clip: Clip, field: LibraryField): string | undefined {
  const meta = clip.meta, time = filmedTime(clip);
  let value: string | number | null | undefined;
  switch (field) {
    case "camera": case "fps": case "codec": case "pictureProfile": case "iso": case "shutter": case "aperture": case "focalLength": value = meta?.[field]; break;
    case "resolution": value = meta && meta.width > 0 ? `${meta.width} × ${meta.height}` : undefined; break;
    case "orientation": value = meta && meta.width > 0 && meta.height > 0 ? meta.width === meta.height ? "Square" : meta.width > meta.height ? "Landscape" : "Portrait" : undefined; break;
    case "duration": value = clip.photo ? undefined : meta?.durationS; break;
    case "date": value = time === null ? undefined : new Date(time).toISOString().slice(0,10); break;
    case "time": value = time === null ? undefined : new Date(time).toISOString().slice(11,16); break;
    case "place": value = clip.place ? clip.place.name || `${clip.place.lat.toFixed(3)}, ${clip.place.lon.toFixed(3)}` : undefined; break;
    case "moment": value = clip.judgement?.scene?.trim(); break;
    case "shotType": value = meta?.width === 0 && meta.height === 0 && meta.audioChannels > 0 ? "audio" : isScreenClip(clip) ? "screen" : clip.byHand?.kind ?? clip.judgement?.kind; break;
    case "shotSize": value = clip.judgement?.shot; break;
    case "junk": value = clip.judgement ? clip.judgement.junk ? "Yes" : "No" : undefined; break;
    case "hasSpeech": value = clip.transcript == null ? undefined : clip.transcript.some(s => s.text.trim()) ? "Yes" : "No"; break;
    case "mediaType": value = clip.photo ? "Photo" : "Video"; break;
    case "steadiness": value = clip.byHand?.shaky !== undefined ? clip.byHand.shaky ? "Shaky" : "Steady" : !clip.shake?.measured ? undefined : clip.shake.shakySpans.length ? "Shaky" : "Steady"; break;
    case "soundSource": value = clip.photo ? "Silent" : clip.sound ? clip.sound.file : meta?.audioChannels === 0 ? "Silent" : clip.sound === null ? "Camera" : undefined; break;
  }
  return value == null || value === "" || typeof value === "number" && !Number.isFinite(value) ? undefined : String(value);
}
export function libraryOptions(clips: Clip[], field: LibraryField): [string, string][] {
  const counts = new Map<string, number>();
  for (const clip of clips.filter(c => !c.leftOut)) {
    const value = libraryValue(clip, field);
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort(([a],[b]) => a.localeCompare(b, undefined, { numeric: true })).map(([value, count]) => [value, `${value} · ${count}`]);
}
export function matchesLibraryFilter(clip: Clip, field: LibraryField, values: string[], operator = "is"): boolean {
  const value = libraryValue(clip, field);
  return value !== undefined && (operator === "is" ? values.includes(value) : !values.includes(value));
}
export function matchesLibraryQuery(clip: Clip, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [clip.id, clip.photo?.file ?? clip.file, clip.judgement?.summary, clip.judgement?.verdict,
    ...Object.keys(libraryFields).map(f => libraryValue(clip, f as LibraryField)),
    ...screenText(clip), ...(clip.transcript?.map(s => s.text) ?? []), ...(clip.quality?.tags.map(t => t.label) ?? [])].some(v => v?.toLowerCase().includes(q));
}
