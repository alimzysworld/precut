// R7: the live mix types now live in the shared contract; re-exported here for existing imports.
import type { DraftTimeline, LiveSound, LiveSoundPiece } from '../shared/schema';
export type { LiveSound, LiveSoundPiece };
export type SoundTimeline = DraftTimeline;
