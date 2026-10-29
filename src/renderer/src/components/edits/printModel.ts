import type { CutVersion, Shoot } from "../../../../shared/schema";
import { frameAt } from "../../data";
import { cutPoster, storyboard } from "./model";

/** Remove generated settings metadata, preserving meaningful parenthesised words. */
export function cleanEditTitle(title: string): string {
  return title.replace(/\s*\(\s*\d+(?:\.\d+)?\s*(?:s|sec(?:onds?)?)\s*(?:,\s*(?:no\s+)?music)?\s*\)\s*$/i, "").trim();
}
export function editHook(shoot: Shoot, version: CutVersion): string | undefined {
  const words = storyboard(shoot, version).pieces.find(piece => !piece.broll && piece.words.trim())?.words.trim();
  return words?.split(/\n|(?<=[.!?])\s/)[0];
}
/** Use the cover's position in this version, then its first cached picture. No rendering work. */
export function printPoster(shoot: Shoot, version: CutVersion): string | null {
  const pieces = storyboard(shoot, version).pieces;
  const at = version.cover?.t;
  if (at !== undefined) {
    let cursor = 0;
    for (const piece of pieces) {
      const start = piece.timelineS ?? cursor;
      const duration = piece.lengthS ?? piece.e - piece.s;
      cursor = start + duration;
      if (at >= start && at < cursor) {
        const picture = piece.overlays?.[0] ?? piece;
        const time = Math.min(picture.e, picture.s + (at - start) * (picture.e - picture.s) / duration);
        return frameAt(shoot, picture.clipId, time) ?? cutPoster(shoot, version);
      }
    }
  }
  return cutPoster(shoot, version);
}
