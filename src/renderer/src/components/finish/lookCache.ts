import type { Api, PieceLook } from "../../../../shared/schema";
import { getApi } from "../../data";

type Choice = Parameters<Api["pieceLuts"]>[3] & { previewPiece?: number; previewLook?: PieceLook | null };
const cache = new Map<string, Promise<string[]>>();
export function pieceLook(root: string, cutId: string, version: number, choice: Choice): Promise<string[]> {
  const key = JSON.stringify([root, cutId, version, choice]);
  let pending = cache.get(key);
  if (!pending) {
    pending = getApi().pieceLuts(root, cutId, version, choice).catch(error => { cache.delete(key); throw error; });
    cache.set(key, pending);
    if (cache.size > 160) cache.delete(cache.keys().next().value!);
  }
  return pending;
}
