// ONB1b: one rule for an edit's music in live playback and every export. A music file
// that is gone (or isn't audio) is left out of both, never a raw error. No imports
// beyond node, so any module (and its test stubs) can use it.
import { statSync } from "node:fs";
import * as path from "node:path";

export const AUDIO_FILE = /\.(mp3|m4a|aac|wav|aif|aiff|flac|ogg|opus|mp4)$/i;
export function playableMusic<T extends { file: string }>(root: string, music: T | null | undefined): T | null {
  if (!music || typeof music.file !== "string" || !music.file) return null;
  const file = path.resolve(root, music.file);
  try { return AUDIO_FILE.test(file) && statSync(file).isFile() ? music : null; } catch { return null; }
}
