// One saved choice for Footage, edits and the read-only library. No model calls.
import type { Clip, Shoot } from "../shared/schema";

export function clipStarred(shoot: Pick<Shoot, "clips" | "takes">, clip: Clip): boolean {
  const lines = shoot.takes.filter(t => t.attempts.some(a => a.clipId === clip.id));
  if (lines.length) return lines.some(t => t.attempts[t.starred]?.clipId === clip.id && !t.attempts[t.starred]?.practice);
  const siblings = clip.shot ? shoot.clips.filter(c => c.shot?.id === clip.shot!.id) : [clip];
  const hand = siblings.find(c => c.byHand?.star === true);
  if (hand) return hand.id === clip.id;
  // Once this shot has a hand choice, re-judging cannot introduce a new default.
  if (siblings.some(c => c.byHand?.star !== undefined)) return false;
  // A shot gets one default star, even if an older judge marked several best.
  const best = siblings.filter(c => c.judgement?.verdict === "best")
    .sort((a, b) => (a.shot?.take ?? 0) - (b.shot?.take ?? 0) || a.id.localeCompare(b.id))[0];
  return best?.id === clip.id;
}

export function footageStarred(shoot: Pick<Shoot, "clips" | "takes">, key: string): boolean {
  const clip = shoot.clips.find(c => c.id === key);
  if (clip) return clipStarred(shoot, clip);
  const match = /^L([1-9]\d*)A([1-9]\d*)$/.exec(key);
  const line = match && shoot.takes.find(t => t.lineIndex === Number(match[1]) - 1);
  return !!line && line.starred === Number(match![2]) - 1 && !!line.attempts[line.starred] && !line.attempts[line.starred].practice;
}

/** Apply a person's explicit choice. False is saved, never a missing override. */
export function applyFootageStar(shoot: Shoot, key: string, starred: boolean): Shoot {
  if (typeof starred !== "boolean") throw new Error("Choose whether to star this take.");
  const clip = shoot.clips.find(c => c.id === key);
  if (clip) {
    const clips = shoot.clips.map(c => c.id === clip.id || starred && clip.shot && c.shot?.id === clip.shot.id
      ? { ...c, byHand: { ...c.byHand, star: c.id === clip.id ? starred : false } } : c);
    const takes = shoot.takes.map(t => {
      const index = t.attempts.findIndex(a => a.clipId === clip.id && !a.practice);
      if (index < 0 || !starred && t.attempts[t.starred]?.clipId !== clip.id) return t;
      return { ...t, starred: starred ? index : -1, starredByHand: true };
    });
    return { ...shoot, clips, takes };
  }
  const match = /^L([1-9]\d*)A([1-9]\d*)$/.exec(key);
  const line = match && shoot.takes.find(t => t.lineIndex === Number(match[1]) - 1);
  const index = match ? Number(match[2]) - 1 : -1;
  if (!line?.attempts[index]) throw new Error("This take no longer exists.");
  if (starred && line.attempts[index].practice) throw new Error("Choose a recorded take first.");
  return { ...shoot, takes: shoot.takes.map(t => t !== line ? t : {
    ...t, starred: starred ? index : t.starred === index ? -1 : t.starred, starredByHand: true,
  }) };
}
