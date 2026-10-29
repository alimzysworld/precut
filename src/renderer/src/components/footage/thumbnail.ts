import type { Shoot } from "../../../../shared/schema";
import { MEDIA_SCHEME } from "../../../../shared/media";
import { frameAt, isFixtureMode } from "../../data";
import type { FootageItem } from "./model";

export function takeThumbnail(shoot: Shoot, item: Pick<FootageItem, "clip" | "s">, tiny = false): string | null {
  if (isFixtureMode()) return frameAt(shoot, item.clip.id, item.s);
  if (item.clip.meta?.width === 0) return null;
  const file = encodeURIComponent(`${item.clip.id}.jpg`);
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(shoot.root)}/thumbs/${file}?t=${item.s}&size=${tiny ? 24 : 320}&rev=${encodeURIComponent(shoot.updatedAt)}${item.clip.proxy ? `&proxy=${encodeURIComponent(item.clip.proxy)}` : ""}`;
}
