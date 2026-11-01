// TRK2: the tracks the edit's locked frames read, by track key, kept in memory once loaded (tracking/lock.ts reads them
// from the shoot's cache, or tracks again). planFx reads them synchronously, so the draft (live and Apple) and the
// export bake the same lock into the same framing keys. No electron here: the timing code imports it everywhere.
import type { TrackFile } from '../../shared/pin-keys';

const tracks = new Map<string, TrackFile>();
/** asked: the key the lock saved, when the track was made again under a new one (a newer tracker). */
export function rememberLockTrack(track: TrackFile, asked = track.key) {
  for (const key of new Set([track.key, asked])) { tracks.delete(key); tracks.set(key, track); }
  if (tracks.size > 32) tracks.delete(tracks.keys().next().value!);
}
export function lockTrackFor(key: string | undefined): TrackFile | null {
  return key ? tracks.get(key) ?? null : null;
}
