import type { ProcessingStage, Shoot, WaitingRoomState } from '../../../shared/schema';
import { formatTimeLeft, formatEta } from './processingFormat';

const countOf = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Use the complete metadata total, never the partial duration of clips read so far. */
export function footagePerspective(shoot: Pick<Shoot, 'clips'> | null | undefined): string {
  const clips = shoot?.clips.filter(clip => clip.stage !== 'error') ?? [];
  const photos = clips.filter(clip => clip.photo).length;
  const videos = clips.filter(clip => !clip.photo);
  if (!clips.length || videos.some(clip => !clip.meta || !Number.isFinite(clip.meta.durationS) || clip.meta.durationS <= 0)) return 'Reading your footage';
  if (!videos.length) return `Watching all ${countOf(photos, 'photo')}`;
  const seconds = videos.reduce((n, clip) => n + clip.meta!.durationS, 0);
  const duration = seconds < 120 ? countOf(Math.round(seconds), 'second') : countOf(Math.round(seconds / 60), 'minute');
  return `Watching all ${duration} of your footage${photos ? ` and ${countOf(photos, 'photo')}` : ''}`;
}
export function waitingStatus(waiting: WaitingRoomState | undefined, running: boolean, shoot?: Pick<Shoot, 'clips'> | null, stages?: ProcessingStage[]): string | null {
  if (waiting?.sound) return [waiting.sound.label, formatEta(waiting.sound.etaS)].filter(Boolean).join(' · ');
  if (!running || waiting?.complete) return null;
  if (stages) {
    const ideas = stages.find(s => s.id === 'ideas');
    const active = stages.find(s => s.state === 'running' && s.id !== 'ideas');
    const rethink = stages.find(s => s.state === 'running' && (s.detail?.startsWith('Rethinking without ') || s.detail === 'Rethinking with your clips'));
    const sorting = stages.find(s => s.state === "running" && s.detail === "Sorting your footage into places and shots");
    const reading = stages.some(s => ["index", "transcribe", "group"].includes(s.id) && s.state === "running");
    const what = sorting?.detail ?? (rethink && !reading ? "Rethinking your shots" : null) ?? (ideas?.state === 'running' ? 'Finding ideas'
      : active?.id === 'drafts' ? 'Making your first edit'
      : active?.id === 'group' || active?.id === 'judge' ? 'Checking your footage'
      : active?.id === 'index' && waiting && waiting.clips.read === waiting.clips.total ? 'Making previews'
      : active ? footagePerspective(shoot) : null);
    if (!what) return null;
    const eta = waiting?.etaS != null && ideas?.state !== 'failed' ? formatTimeLeft(waiting.etaS, true) : null;
    return [what, eta].filter(Boolean).join(' · ');
  }
  // Older main processes may omit stages. Counts prove reading is unfinished,
  // but never prove that an idea call or a draft has started.
  if (waiting && waiting.clips.read >= waiting.clips.total) return null;
  const what = footagePerspective(shoot);
  const eta = waiting?.etaS != null ? formatTimeLeft(waiting.etaS, true) : null;
  return [what, eta].filter(Boolean).join(' · ');
}
