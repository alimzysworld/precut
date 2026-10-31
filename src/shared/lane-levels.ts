import type { AudioFinish, CutVersion, LiveSound, LiveSoundPiece, Preferences, SoundLane } from './schema';
export const SOUND_LANES: SoundLane[] = ['clip-sound', 'voice', 'music', 'effects'];
export const laneDb = (version: Pick<CutVersion, 'laneLevels'>, lane: SoundLane) => version.laneLevels?.[lane] ?? 0;
export const laneMuted = (version: Pick<CutVersion, 'laneMuted' | 'clipSoundMuted'>, lane: SoundLane) => lane === 'clip-sound' ? !!version.clipSoundMuted : !!version.laneMuted?.[lane];
export const defaultClipMuted = (version: Pick<CutVersion,'clipSoundDefaultOn'|'voiceover'>, broll: boolean, attached = false) => !version.clipSoundDefaultOn && (attached || broll || !!version.voiceover?.lines.some(l=>l.take));
export const laneStep = (db: number) => Math.max(-60, Math.min(6, Math.round(db * 2) / 2));
/** Per-clip voice balancing belongs before this addition, leaving the lane fader independent. */
export const clipLaneDb = (version: Pick<CutVersion, 'laneLevels'>, ownDb = 0) => ownDb + laneDb(version, 'clip-sound');
export function allClipSound(version: CutVersion, on: boolean) {
  version.pieceFx = (version.pieces ?? []).map((piece, index) => ({...version.pieceFx?.[index], muted: !on,
    ...(piece.overlay ? {overlaySound: {...version.pieceFx?.[index]?.overlaySound, muted: !on}} : {})}));
  if (on) version.clipSoundMuted = false;
}
export function newEditClipSound(version: CutVersion, preference: Preferences['clipSoundNewEdits']) {
  if (!preference?.on) return;
  version.clipSoundDefaultOn = true;
  version.laneLevels = {...version.laneLevels, 'clip-sound': preference.db};
  allClipSound(version, true);
}

// AV1b: the live mix's level rules, shared by the Chrome viewer's LiveMix (renderer) and the Apple player's plan
// (src/shared/apple-playback.ts), so the two players can never hear a different edit. Here, beside the lane rules they
// build on, because this module has no runtime imports (the viewer's test sandboxes load it on its own).
/** A clip sound or voice piece as it is heard: its level with even-out and lane changes, its mute, and the raw
 * file when Clean is off. `base` is the saved plan when `plan` is a preview of it (lane deltas only). */
export function heardPiece(plan: LiveSound, original: LiveSoundPiece, base: LiveSound = plan): LiveSoundPiece {
  const audio: Partial<AudioFinish> = plan.audio ?? {}, narration = original.id.startsWith('voiceover:');
  const p = { ...original, gainDb: original.gainDb + (!narration && (audio.evenOutVoices ?? audio.auto !== false) ? original.normalizeDb ?? 0 : 0) + (narration ? laneDb(plan, 'voice') : laneDb(plan, 'clip-sound') - laneDb(base, 'clip-sound')), muted: original.muted || (narration ? laneMuted(plan, 'voice') : false) };
  return audio.clean === false && base.audio.clean !== false && (!p.clean || p.clean === 'none') && p.rawUrl ? { ...p, url: p.rawUrl, sourceStart: p.rawSourceStart } : p;
}

/** The mix's output level in dB. PAR1: the export's own master gain (plan.master, the loudness pass's gain on the same
 * premix, Auto or not), moved by a previewed target change. AV6: plan.master is there before any export (main measures
 * the export's own premix, preview.ts draftSoundMaster, and an export's own stage replaces it), so both viewers play at
 * the export's level from the first play. Only until that measurement lands (seconds after an edit's sound changes),
 * or while a preview flips Auto, the estimate: prepared auto voice is matched to -20 LUFS, so Auto lifts the mix to
 * the target; with Auto off it is 0 dB (15.7 dB quiet on his edit). */
export function mixOutputDb(plan: LiveSound, base: LiveSound = plan): number {
  const audio: Partial<AudioFinish> = plan.audio ?? {};
  const master = base.master ?? plan.master;
  if (master && (audio.auto !== false) === (base.audio?.auto !== false)) return master.gainDb + ((audio.loudnessLUFS ?? -14) - (base.audio?.loudnessLUFS ?? -14));
  return audio.auto !== false ? (audio.loudnessLUFS ?? -14) + 20 : (audio.loudnessLUFS ?? -14) - (base.audio?.loudnessLUFS ?? -14);
}
/** PAR1: the limiter ceiling after the master gain, as the export's master stage set it (linear; -1.5 dBFS before). */
export const mixCeiling = (plan: LiveSound, base: LiveSound = plan) => (base.master ?? plan.master)?.ceiling ?? 10 ** (-1.5 / 20);

/** Where the music ends and how long it fades out to that end. */
export function musicEnd(plan: LiveSound): { endS: number; fadeOutS: number } {
  const endS = Math.min(plan.durationS, plan.music?.endS ?? plan.durationS);
  return { endS, fadeOutS: Math.min(plan.music?.arrangementState === 'ready' ? .012 : 1.5, endS) };
}

/** The spoken pieces the music ducks under: all of them, or only clip sound when the voice lane is muted. */
export function duckedUnder(plan: LiveSound, narrationMuted: boolean): LiveSoundPiece[] {
  const hasNarration = plan.pieces.some(p => p.id.startsWith('voiceover:'));
  return narrationMuted ? plan.pieces.filter(p => hasNarration && !p.id.startsWith('voiceover:')) : plan.pieces;
}

/** The separated stems the music plays from, or undefined for the mixed track. Playback also waits for them to decode. */
export function musicStems(plan: LiveSound) {
  const music = plan.music;
  const stems = music?.stemDucking !== false ? music?.stems : undefined;
  return stems && (music!.stemsStartS === undefined || music!.stemsStartS === music!.startS) ? stems : undefined;
}
