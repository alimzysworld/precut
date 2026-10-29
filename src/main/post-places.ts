import type { Preferences } from "../shared/schema";

// P5 additive wire values, kept local until the shared contract catches up.
export const POST_PLACES = [
  { id: "vertical", name: "Vertical (Reels, TikTok, Shorts)", shape: "9:16", safeArea: "tiktok" },
  { id: "youtube", name: "YouTube", shape: "16:9", safeArea: "none" },
  { id: "linkedin", name: "LinkedIn", shape: "4:5", safeArea: "none" },
  { id: "x", name: "X", shape: "16:9", safeArea: "none" },
] as const;
export type PostPlace = typeof POST_PLACES[number]["id"];
export function normalizePostPlaces(places: readonly string[]): PostPlace[] {
  return [...new Set(places.map(id => ["reels", "tiktok", "shorts"].includes(id) ? "vertical" : id))]
    .filter((id): id is PostPlace => POST_PLACES.some(place => place.id === id));
}
// TikTok's reserved UI contains the reserved UI of Reels and Shorts: its safe
// text rectangle is their intersection, clear of the union of all three UIs.
export function postingPreferences(value: Preferences, places: PostPlace[]): Partial<Preferences> {
  if (!places.length) return {};
  const selected = places.map(id => POST_PLACES.find(place => place.id === id)!);
  return { output: { ...value.output, posts: places as unknown as Preferences["output"]["posts"], shapes: [...new Set(selected.map(place => place.shape))] },
    captions: { ...value.captions, safeArea: selected[0].safeArea } };
}
