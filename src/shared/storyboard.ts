import type { Clip, ReelIdea, Shoot, SkillFormat } from './schema';

export type StoryboardShot = {
  id: string;
  clipId: string;
  framePath: string | null;
  spokenLine: string | null;
  missing: boolean;
  timeS: number;
  position: { x: number; y: number };
};
export const storyboardAspect = (idea: ReelIdea, shoot: Shoot, fallback?: SkillFormat['aspect']) =>
  idea.format?.aspect ?? shoot.format?.aspect ?? fallback ?? '9:16';

/** Cached facts only. B ids deliberately match the editorial catalog's span order. */
export function resolveStoryboard(shoot: Shoot, uses: readonly string[], available: (frame: string) => boolean = () => true): StoryboardShot[] {
  const broll = shoot.clips.flatMap(clip => {
    const j = clip.judgement;
    const kind = clip.byHand?.kind ?? j?.kind;
    if (clip.leftOut || !j || !clip.meta || (clip.photo && j.verdict === 'unusable') || (kind !== 'broll' && !(clip.byHand?.kind === undefined && j.verdict === 'maybe' && /b-?roll/i.test(j.summary)))) return [];
    const spans = j.usableSpans.length ? j.usableSpans : kind === 'broll' ? [[0, clip.meta.durationS]] : [];
    return spans.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s && e <= clip.meta!.durationS)
      .map(([s, e]) => ({ clipId: clip.id, s, e }));
  });
  const clips = new Map(shoot.clips.map(clip => [clip.id, clip]));
  return uses.flatMap<StoryboardShot>(id => {
    const voice = /^L(\d+)A(\d+)$/i.exec(id), b = /^B(\d+)$/i.exec(id);
    const attempt = voice ? shoot.takes.find(take => take.lineIndex === Number(voice[1]) - 1)?.attempts[Number(voice[2]) - 1] : undefined;
    const moment = attempt ?? (b ? broll[Number(b[1]) - 1] : undefined);
    const clip = clips.get(moment?.clipId ?? id);
    if (!clip) return [{ id, clipId: moment?.clipId ?? id, framePath: null, spokenLine: attempt?.text ?? null, missing: true, timeS: 0, position: { x: .5, y: .5 } }];
    const range = moment ?? bestSpan(clip);
    const spans = (clip.judgement?.usableSpans ?? []).map(([s, e]) => [Math.max(s, range.s), Math.min(e, range.e)])
      .filter(([s, e]) => e > s).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    const target = spans[0] ? (spans[0][0] + spans[0][1]) / 2 : (range.s + range.e) / 2;
    const frames = clip.frames.map((frame, index) => ({ framePath: frame.startsWith('frames/') ? frame : `frames/${frame}`, timeS: frameTime(clip, frame, index) }))
      .filter(frame => available(frame.framePath));
    // Prefer a picture inside the usable range. Old evenly spaced caches may have none.
    const inside = frames.filter(frame => frame.timeS >= (spans[0]?.[0] ?? range.s) && frame.timeS <= (spans[0]?.[1] ?? range.e));
    const frame = (inside.length ? inside : frames).sort((a, b) => Math.abs(a.timeS - target) - Math.abs(b.timeS - target))[0];
    if (!frame && !clip.missing) return [];
    const timeS = frame?.timeS ?? target;
    const subject = clip.subject?.samples.filter(sample => Number.isFinite(sample.x) && Number.isFinite(sample.y))
      .reduce<(NonNullable<Clip['subject']>['samples'][number]) | undefined>((best, sample) => !best || Math.abs(sample.t - timeS) < Math.abs(best.t - timeS) ? sample : best, undefined);
    return [{ id, clipId: clip.id, framePath: frame?.framePath ?? null, spokenLine: attempt?.text ?? null,
      missing: !!clip.missing, timeS, position: { x: Math.max(0, Math.min(1, subject?.x ?? .5)), y: Math.max(0, Math.min(1, subject?.y ?? .5)) } }];
  });
}
function bestSpan(clip: Clip) {
  const span = clip.judgement?.usableSpans.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  return { s: span?.[0] ?? 0, e: span?.[1] ?? clip.meta?.durationS ?? 0 };
}
function frameTime(clip: Clip, frame: string, index: number) {
  const timestamp = /_t(\d+(?:\.\d+)?)\.(?:jpg|jpeg|png)$/i.exec(frame);
  return timestamp ? Number(timestamp[1]) : (index + .5) * (clip.meta?.durationS ?? 0) / clip.frames.length;
}
