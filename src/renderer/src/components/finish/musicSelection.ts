import type { CutVersion, LiveSound } from '../../../../shared/schema';

/** Faders keep the prepared decoder and its zero-based source clock. A changed
 * arranging choice uses the original until its matching preparation arrives. */
export function liveMusicSelection(choice: CutVersion['music'], saved: CutVersion['music'], prepared: LiveSound['music'] | undefined, root: string): LiveSound['music'] {
  if (!choice) return null;
  const same = choice.file === saved?.file && choice.startS === saved?.startS && choice.fit === saved?.fit && choice.followStory === saved?.followStory;
  // PRO3a: the music's shape belongs to the edit, so a previewed track or level keeps it.
  return { ...choice, ...(saved?.shape && !choice.shape ? { shape: saved.shape } : {}), url: `st-media://local/music/${encodeURIComponent(choice.file.startsWith('/') ? choice.file : `${root}/${choice.file}`)}`,
    ...(same && prepared ? { url: prepared.url, startS: prepared.startS, stems: prepared.stems, stemsStartS: prepared.stemsStartS, arrangementState: prepared.arrangementState } : {}) };
}
