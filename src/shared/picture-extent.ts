import type { VoiceoverLine } from "./schema";

/** VO7-9: three extents, kept apart. The picture's end is where the export stops (version.lengthS,
 * the draft's durationS). Voice can be placed past it, so playback runs on to the last voice piece's
 * end, over black. Only "Extend with black" or "Hold last shot" moves the picture's end out. */
export function voiceEndS(lines: VoiceoverLine[] | undefined | null): number {
  let end = 0;
  for (const l of lines ?? []) if (l.take && Number.isFinite(l.s) && l.take.e > l.take.s) end = Math.max(end, l.s + l.take.e - l.take.s);
  return end;
}
/** Where playback stops: the picture's end, or the last voice piece's end when the voice runs on past it (over black,
 * as "Extend with black" would make it). Every player reads this one rule: the Chrome viewer (liveTimeline
 * playbackExtent) and the Apple player's plan (buildAppleManifest), so neither stops or snaps back at the picture. */
export function playbackEndS(pictureS: number, lines: VoiceoverLine[] | undefined | null): number {
  return Math.max(Number.isFinite(pictureS) ? pictureS : 0, voiceEndS(lines));
}
/** Seconds of voice heard after the picture ends, or 0. Under half a frame is not past the end. */
export function voiceBeyondS(lines: VoiceoverLine[] | undefined | null, pictureS: number, fps = 25): number {
  const beyond = voiceEndS(lines) - (Number.isFinite(pictureS) ? pictureS : 0);
  return beyond > 0.5 / (fps || 25) ? beyond : 0;
}
/** How the export sheet and the MCP say it: whole seconds, never "0 s". */
export function voiceBeyondNote(seconds: number): string {
  return `${Math.max(1, Math.round(seconds))} s of voice runs past the end and won't be in the video.`;
}
