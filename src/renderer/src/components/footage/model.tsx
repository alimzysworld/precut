import { isScreenClip } from '../../../../shared/screen';
import { clipStarred } from "../../../../main/footage-stars";
import type { Clip, Cut, Shoot, TakeAttempt } from "../../../../shared/schema";
import type { Shortcut } from "../../hooks/useShortcuts";
export type FootageView = "scenes" | "script" | "shot";
export const shotTypes = ["talking", "screen", "broll", "setup", "audio", "unknown"] as const;
export type ShotType = typeof shotTypes[number];
export const shotLabels: Record<ShotType, string> = { talking: "Talking", screen: "Screen recordings", broll: "B-roll", setup: "Setup", audio: "Audio only", unknown: "Not classified yet" };
export function shotType(clip: Clip): ShotType {
  if (clip.meta && clip.meta.width === 0 && clip.meta.height === 0 && clip.meta.audioChannels > 0) return "audio";
  if (isScreenClip(clip)) return "screen";
  const kind = clip.byHand?.kind ?? clip.judgement?.kind;
  return (kind as string) === "b-roll" ? "broll" : kind === "talking" || kind === "broll" || kind === "setup" ? kind : "unknown";
}
export function defaultView(shoot: Shoot): FootageView {
  if (shoot.script.length && shoot.takes.some(t => t.attempts.some(a => shoot.clips.some(c => c.id === a.clipId && !c.missing && !c.leftOut)))) return "script";
  if (shoot.clips.length && shoot.clips.filter(c => shotType(c) === "broll").length > shoot.clips.length / 2) return "scenes";
  return "shot";
}
export function shotGroups(clips: Clip[]) {
  return shotTypes.map(id => ({ id, name: shotLabels[id], clips: clips.filter(c => shotType(c) === id) }));
}
export interface FootageItem { key: string; clip: Clip; s: number; e: number | null; lineIndex?: number; attemptIndex?: number; attempt?: TakeAttempt; best?: boolean; why?: string }
export function itemStarred(shoot: Shoot, item: FootageItem): boolean {
  return item.lineIndex !== undefined ? !!(!item.attempt?.practice && shoot.takes.find(t => t.lineIndex === item.lineIndex)?.starred === item.attemptIndex) : clipStarred(shoot, item.clip);
}
export function clipItem(shoot: Shoot, clip: Clip): FootageItem {
  return { key: clip.id, clip, s: 0, e: clip.meta?.durationS ?? null, best: clipStarred(shoot, clip) };
}
export function takeStacks(items: FootageItem[], marks: Record<string, { star?: boolean }> = {}) {
  const groups = new Map<string, FootageItem[]>();
  for (const item of items) {
    const id = item.clip.shot?.id ?? item.key;
    groups.set(id, [...groups.get(id) ?? [], item]);
  }
  const rank = (item: FootageItem) => Number(marks[item.key]?.star ?? !!item.best) * 100 + ({ best: 4, alt: 3, maybe: 2, unusable: 1 }[item.clip.judgement?.verdict ?? "unusable"]);
  return [...groups].map(([id, members]) => ({ id, items: [...members].sort((a,b) => rank(b) - rank(a) || (a.clip.shot?.take ?? 0) - (b.clip.shot?.take ?? 0)) }));
}
export function scriptItems(shoot: Shoot): { id: string; name: string; items: FootageItem[] }[] {
  return [...shoot.takes].sort((a,b) => a.lineIndex - b.lineIndex).map(take => ({
    id: `line:${take.lineIndex}`, name: shoot.script[take.lineIndex] || `Line ${take.lineIndex + 1}`,
    items: take.attempts.flatMap((attempt, attemptIndex) => {
      const clip = shoot.clips.find(c => c.id === attempt.clipId);
      return clip ? [{ key: `L${take.lineIndex + 1}A${attemptIndex + 1}`, clip, s: attempt.s, e: attempt.e,
        lineIndex: take.lineIndex, attemptIndex, attempt, best: take.starred === attemptIndex && !attempt.practice,
        why: attempt.note.trim() || (!take.starredByHand && take.starred === attemptIndex ? take.why : "") }] : [];
    }).sort((a,b) => Number(!!a.attempt.practice) - Number(!!b.attempt.practice) || Number(b.best) - Number(a.best)),
  }));
}
export function itemBadges(item: FootageItem): { label: string; tone: "lime" | "violet" | "pink" | "amber" }[] {
  const badges: ReturnType<typeof itemBadges> = [];
  if (item.attempt?.hook === true) badges.push({ label: "Strong hook", tone: "violet" });
  if (item.attempt?.note && /\bstumbl(?:e|es|ed|ing)\b/i.test(item.attempt.note) && !/\b(?:no|not|without|never|didn't|doesn't)\s+(?:\w+\s+)?stumbl/i.test(item.attempt.note)) badges.push({ label: "Stumble", tone: "pink" });
  if (item.clip.judgement) {
    const verdict = item.clip.judgement.verdict;
    badges.push({ label: verdict === "best" || verdict === "alt" ? "Keep" : verdict === "maybe" ? "Maybe" : "Pass", tone: verdict === "maybe" ? "amber" : verdict === "unusable" ? "pink" : "lime" });
  }
  return badges;
}
export function similarItems(shoot: Shoot, item: FootageItem): FootageItem[] {
  if (item.clip.similar?.length) return item.clip.similar.flatMap(link => {
    const clip = shoot.clips.find(c => c.id === link.clipId && !c.leftOut);
    return clip ? [clipItem(shoot, clip)] : [];
  });
  const line = scriptItems(shoot).find(g => !item.attempt && g.items.some(i => i.clip.id === item.clip.id) || g.items.some(i => item.lineIndex !== undefined && i.lineIndex === item.lineIndex) || g.items.some(i => i.key === item.key) || g.items.some(i => i.clip.id === item.clip.id && i.s <= item.s && (i.e ?? Infinity) > item.s));
  if (line) return line.items.filter(i => i.key !== item.key && !(i.clip.id === item.clip.id && i.s === item.s));
  const tags = new Set((item.clip.quality?.tags ?? []).filter(t => t.confidence >= 0.5).map(t => t.label));
  return shoot.clips.filter(c => !c.leftOut && c.id !== item.clip.id && (!item.clip.judgement?.scene || c.judgement?.scene === item.clip.judgement.scene) && (c.shot && c.shot.id === item.clip.shot?.id || c.quality?.duplicateOf === item.clip.id || item.clip.quality?.duplicateOf === c.id || c.quality?.tags.some(t => t.confidence >= 0.5 && tags.has(t.label)))).map(c => clipItem(shoot,c));
}
export function editUsage(cuts: Cut[], clipId: string) {
  return cuts.flatMap(cut => {
    const version = [...cut.versions].sort((a,b) => b.version - a.version).find(v => v.pieces?.some(p => p.clipId === clipId || p.overlay?.clipId === clipId));
    return version ? [{ cut, version }] : [];
  });
}
export type FootageActions = { move: (delta: number) => void; play: () => void; star: () => void; review: (value: "keep" | "maybe" | "pass") => void; close: () => void; search: () => void; help: () => void; select: () => void };
export function footageShortcuts(actions: FootageActions): Shortcut[] {
  const key = (id: string, keys: string[], label: string, handler: () => void): Shortcut => ({ id, keys, label, scope: "clips", handler });
  return [key("previous",["ArrowLeft", "ArrowUp"],"Previous take",() => actions.move(-1)), key("next",["ArrowRight", "ArrowDown"],"Next take",() => actions.move(1)),
    key("play",["Space"],"Play or pause",actions.play), key("star",["f"],"Star take",actions.star),
    key("keep",["1"],"Mark keep (on this Mac)",() => actions.review("keep")), key("maybe",["2"],"Mark maybe (on this Mac)",() => actions.review("maybe")), key("pass",["3"],"Mark pass (on this Mac)",() => actions.review("pass")),
    key("close",["Escape"],"Close inspector",actions.close), key("select",["x"],"Select clip",actions.select), key("shortcuts",["?"],"Keyboard shortcuts",actions.help),
    { id: "command-search", keys: ["Cmd+k"], label: "Search takes, transcript or keywords", scope: "global", handler: actions.search }];
}
// Selection travels through the existing cut flow. Source spans are explicit since
// SidekickContext has no uses field; the user requested this one existing model action.
export function selectionPrompt(items: FootageItem[], addToExisting = false): string {
  return `${addToExisting ? "Add these selected clips and source ranges to this edit, preserving its existing clips" : "Create an edit using only these selected clips and source ranges"}: ${items.map(i => `${i.key} (clip ${i.clip.id}, ${i.s}s${i.e !== null ? ` to ${i.e}s` : ""})`).join("; ")}. Use this selection as the edit's uses. Keep the source footage unchanged.`;
}
