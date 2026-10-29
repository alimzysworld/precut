import type { VoiceoverLine } from "../../../shared/schema";
export const voiceTokens = (text: string) => text.toLowerCase().normalize("NFKD").replace(/['’]/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];
/** Require the last phrase and most of the current read. Earlier ad-libs and a
 * small recognition error cannot trap the reader; repeated endings alone cannot
 * skip a line. The cursor excludes words already used by an earlier line. */
export function heardLineEnd(line: VoiceoverLine, words: string[], cursor: number): number | null {
  const expected = voiceTokens(line.text), heard = words.flatMap(voiceTokens);
  if (!expected.length) return null;
  const allowed = expected.length < 4 ? 0 : Math.floor(expected.length * .25), tail = Math.min(2, expected.length);
  for (let end = cursor + expected.length - allowed; end <= heard.length; end++) {
    if (!expected.slice(-tail).every((w, i) => heard[end - tail + i] === w)) continue;
    for (let start = Math.max(cursor, end - expected.length - allowed); start <= end - expected.length + allowed; start++) {
      let row = Array.from({ length: end - start + 1 }, (_, j) => j);
      for (let i = 0; i < expected.length; i++) {
        const next = [i + 1];
        for (let j = 1; j < row.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (expected[i] === heard[start + j - 1] ? 0 : 1));
        row = next;
      }
      if (row.at(-1)! <= allowed) return end;
    }
  }
  return null;
}
export const voiceClock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;
export const voiceSource = (root: string, file: string) => `st-media://local/${encodeURIComponent(root)}/voice/${encodeURIComponent(`voiceover:${file}`)}`;
