import type { VideoType } from "../../../shared/schema";

// VT1: the five kinds of video, each with its own editing logic in main.
export const VIDEO_TYPE_OPTIONS: { value: VideoType; label: string; hint: string }[] = [
  { value: "talking", label: "Talking", hint: "You to camera, hook first" },
  { value: "voiceover", label: "Voiceover", hint: "Your voice over b-roll" },
  { value: "montage", label: "Montage", hint: "B-roll cut to the music" },
  { value: "tutorial", label: "Tutorial", hint: "Screen and face, step by step" },
  { value: "vlog", label: "Vlog", hint: "Your day, in order" },
];
export const videoTypeLabel = (type: VideoType | undefined) => VIDEO_TYPE_OPTIONS.find(option => option.value === type)?.label ?? null;
/** The newest "What this shoot can make" line from the ideas call. */
export const shootCanMake = (messages: { canMake?: string }[]) => [...messages].reverse().find(message => message.canMake?.trim())?.canMake?.trim() ?? null;
