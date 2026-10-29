import type { Clip, Shoot } from "../shared/schema";
import { filmedTime } from "./filmed-time";

export interface FeaturePair { a: string; b: string; mean: number; max: number; spread?: number; aligned?: number[] }
// Calibrated against the labelled mirror/nearby-walk set; evidence in qa/V2.
export const TAKE_MEAN = 0.85, TAKE_MAX = 0.90, TAKE_SPREAD = 0.16, TAKE_WINDOW_MS = 180_000;
/** Clock correction (seconds added to the target camera clock), from measured
 * simultaneous audio only. Screen/timestamp fallback is never clock evidence. */
export function cameraClockOffsets(shoot: Pick<Shoot, "clips" | "angles">): Record<string, number> {
  const samples = new Map<string, number[]>();
  for (const group of shoot.angles ?? []) {
    // A screen edge may have used timestamps as its sync fallback. Even the
    // camera members of that connected group cannot calibrate a clock.
    if (group.clips.some(e => e.kind !== "camera")) continue;
    const entries = group.clips.filter(e => e.kind === "camera").flatMap(e => {
      const clip = shoot.clips.find(c => c.id === e.clipId && !c.photo);
      return clip?.meta?.camera && filmedTime(clip) !== null ? [{ ...e, clip }] : [];
    });
    for (const a of entries.filter(e => e.clip.place && !e.clip.place.inherited)) for (const b of entries) {
      if (a.clip.meta!.camera === b.clip.meta!.camera) continue;
      const key = JSON.stringify([b.clip.meta!.camera, a.clip.meta!.camera]);
      const offset = (filmedTime(a.clip)! - filmedTime(b.clip)!) / 1000 + b.offsetS - a.offsetS;
      samples.set(key, [...samples.get(key) ?? [], offset]);
    }
  }
  return Object.fromEntries([...samples].flatMap(([key, values]) => {
    values.sort((a,b) => a-b);
    // Disagreeing syncs make the clock unknown, rather than averaging it away.
    return values.at(-1)! - values[0] <= 2 ? [[key, values[Math.floor(values.length / 2)]]] : [];
  }));
}
export function inheritPlaces(clips: Clip[], offsets: Record<string, number> = {}): Clip[] {
  const located = clips.filter(c => !c.leftOut && c.place && !c.place.inherited && filmedTime(c) !== null);
  return clips.map(clip => {
    if (clip.place && !clip.place.inherited) return clip;
    const time = filmedTime(clip), camera = clip.meta?.camera;
    if (time === null || !camera || clip.leftOut) return { ...clip, place: null };
    const nearest = located.flatMap(other => {
      const correction = camera === other.meta?.camera ? 0 : offsets[JSON.stringify([camera, other.meta?.camera])];
      if (correction === undefined) return [];
      return [{ other, gap: Math.abs(time + correction * 1000 - filmedTime(other)!) }];
    }).filter(row => row.gap <= 1_200_000).sort((a,b) => a.gap - b.gap || a.other.id.localeCompare(b.other.id));
    return { ...clip, place: nearest.length ? { ...nearest[0].other.place!, inherited: true } : null };
  });
}
const sameScene = (a: Clip, b: Clip) => (a.judgement?.scene?.trim() || null) === (b.judgement?.scene?.trim() || null);
const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort());
export function libraryClips(clips: Clip[], pairs: FeaturePair[] = []): Clip[] {
  const distances = new Map(pairs.filter(p => Number.isFinite(p.mean) && Number.isFinite(p.max) && p.mean >= 0 && p.max >= p.mean).map(p => [pairKey(p.a, p.b), p]));
  const ordered = [...clips].filter(c => !c.leftOut).sort((a,b) => (filmedTime(a) ?? Infinity) - (filmedTime(b) ?? Infinity) || a.id.localeCompare(b.id));
  const times = new Map(ordered.map(c => [c.id, filmedTime(c)]));
  const nearby = (a: Clip, b: Clip) => times.get(a.id) != null && times.get(b.id) != null && Math.abs(times.get(a.id)! - times.get(b.id)!) <= TAKE_WINDOW_MS;
  const isTake = (a: Clip, b: Clip) => {
    const pair = distances.get(pairKey(a.id, b.id));
    const spread = pair?.spread ?? (pair?.aligned?.length === 3 ? Math.max(...pair.aligned) - Math.min(...pair.aligned) : Infinity);
    return !!pair && !!a.meta?.camera && a.meta.camera === b.meta?.camera && sameScene(a,b) && nearby(a,b) && pair.mean <= TAKE_MEAN && pair.max <= TAKE_MAX && spread <= TAKE_SPREAD;
  };
  const groups: Clip[][] = [];
  const remaining = new Set(ordered);
  const byId = new Map(ordered.map(c => [c.id, c]));
  const neighbours = new Map(ordered.map(c => [c, [] as Clip[]]));
  for (const pair of distances.values()) {
    const a = byId.get(pair.a), b = byId.get(pair.b);
    if (a && b && a !== b && isTake(a,b)) { neighbours.get(a)!.push(b); neighbours.get(b)!.push(a); }
  }
  while (remaining.size) {
    // A common reference, not transitive closure: every take must match the
    // same measured framing. Pick the reference covering the most neighbours.
    const candidates = [...remaining].map(anchor => [anchor, ...neighbours.get(anchor)!.filter(c => remaining.has(c))]
      .sort((a,b) => (times.get(a.id) ?? Infinity) - (times.get(b.id) ?? Infinity) || a.id.localeCompare(b.id)))
      .sort((a,b) => b.length - a.length);
    const first = candidates[0][0];
    const group = candidates[0].filter(c => c === first || (filmedTime(c)! - filmedTime(first)!) <= TAKE_WINDOW_MS);
    groups.push(group); group.forEach(c => remaining.delete(c));
  }
  const shots = new Map(groups.flatMap(group => group.map((clip, i) => [clip.id, { id: `shot:${group[0].id}`, take: i + 1, takes: group.length }] as const)));
  return clips.map(clip => {
    const shot = shots.get(clip.id);
    if (!shot) return { ...clip, shot: undefined, angles: [], similar: [] };
    const similar: NonNullable<Clip["similar"]> = ordered.flatMap(other => {
      if (other.id === clip.id || !sameScene(clip, other)) return [];
      const pair = distances.get(pairKey(clip.id, other.id));
      const kind = shots.get(other.id)?.id === shot.id ? "take" as const : nearby(clip, other) && (clip.judgement?.scene?.trim() || pair && pair.mean <= TAKE_MEAN && pair.max <= TAKE_MAX) ? "angle" as const : pair && pair.mean <= TAKE_MAX ? "similar" as const : null;
      return kind ? [{ clipId: other.id, kind, distance: pair?.mean ?? null }] : [];
    }).sort((a,b) => ["take", "angle", "similar"].indexOf(a.kind) - ["take", "angle", "similar"].indexOf(b.kind) || (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.clipId.localeCompare(b.clipId));
    return { ...clip, shot, angles: similar.filter(s => s.kind === "angle").map(s => s.clipId), similar };
  });
}

export interface MeasuredScene { id: string; name: string; clipIds: string[]; recordedAt: string | null }
const stamp = (clip: Clip) => {
  const value = clip.meta?.createdAt ? Date.parse(clip.meta.createdAt) : NaN;
  return Number.isFinite(value) ? value : null;
};
function unnamedMoment(clip: Clip): string {
  const time = stamp(clip);
  const when = time === null ? null : new Date(time).toISOString().slice(11, 16);
  const place = clip.place?.name?.trim();
  return [place, when].filter(Boolean).join(" · ") || "Unsorted footage";
}
function similarity(a: Clip, b: Clip): number | null {
  if (a.quality?.duplicateOf === b.id || b.quality?.duplicateOf === a.id) return 1;
  const tags = (clip: Clip) => new Map((clip.quality?.tags ?? []).filter(t => t.confidence >= 0.5).map(t => [t.label.toLowerCase(), t.confidence]));
  const left = tags(a), right = tags(b);
  if (!left.size || !right.size) return null;
  const norm = (values: Map<string, number>) => Math.sqrt([...values.values()].reduce((n, v) => n + v * v, 0));
  return [...left].reduce((n, [tag, value]) => n + value * (right.get(tag) ?? 0), 0) / (norm(left) * norm(right));
}
/** Uses recording gaps, measured Vision labels and duplicate feature-print results only.
 * Missing time and visual evidence never asserts that two clips share a scene. */
export function measuredScenes(shoot: Pick<Shoot, "clips">): MeasuredScene[] {
  if (shoot.clips.some(c => c.judgement?.scene?.trim())) {
    const moments = new Map<string, Clip[]>();
    for (const clip of shoot.clips.filter(c => !c.leftOut)) {
      const name = clip.judgement?.scene?.trim();
      const key = JSON.stringify([clip.place ? clip.place.name || [clip.place.lat.toFixed(3), clip.place.lon.toFixed(3)] : null, name ?? clip.id]);
      moments.set(key, [...moments.get(key) ?? [], clip]);
    }
    return [...moments].map(([id, clips]) => ({ id, name: clips[0].judgement?.scene?.trim() || unnamedMoment(clips[0]), clipIds: clips.map(c => c.id), recordedAt: clips[0].meta?.createdAt ?? null }));
  }
  const ordered = [...shoot.clips].sort((a, b) => (stamp(a) ?? Infinity) - (stamp(b) ?? Infinity) || a.file.localeCompare(b.file));
  const groups: Clip[][] = [];
  for (const clip of ordered) {
    const previous = groups.at(-1)?.at(-1);
    const time = stamp(clip), before = previous ? stamp(previous) : null;
    const visual = previous ? similarity(previous, clip) : null;
    const gap = time !== null && before !== null ? time - before - (previous?.meta?.durationS ?? 0) * 1000 : null;
    const placeKey = (c: Clip) => c.place ? c.place.name || `${c.place.lat.toFixed(3)},${c.place.lon.toFixed(3)}` : null;
    const together = previous && placeKey(previous) === placeKey(clip) && (gap !== null ? gap <= 600_000 && (visual === null || visual >= 0.65) : visual === 1);
    if (together) groups.at(-1)!.push(clip); else groups.push([clip]);
  }
  return groups.map(clips => {
    const first = clips[0], time = stamp(first);
    const name = unnamedMoment(first);
    return { id: `scene:${first.id}`, name, clipIds: clips.map(c => c.id), recordedAt: time === null ? null : new Date(time).toISOString() };
  });
}
export function withScenes<T extends Shoot>(shoot: T): T & { scenes: MeasuredScene[] } {
  const cache = (shoot as Shoot & { _cache?: { featurePairs?: FeaturePair[] } })._cache;
  const result = { ...shoot, clips: libraryClips(inheritPlaces(shoot.clips, cameraClockOffsets(shoot)), cache?.featurePairs) };
  return { ...result, scenes: measuredScenes(result) };
}
