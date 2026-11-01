import { coupledSoundShape } from './sound-attachments';
/** Keep each atempo stage inside FFmpeg's pitch-preserving 0.5..2 range. */
export function tempoChain(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("Invalid speed.");
  const stages: number[] = [];
  while (speed < .5) { stages.push(.5); speed /= .5; }
  while (speed > 2) { stages.push(2); speed /= 2; }
  stages.push(speed);
  return stages.map(value => `atempo=${value}`).join(",");
}
/** Recombine an untouched full-band copy with an inverted, speech-ducked
 * presence band. Only the removed band energy is subtracted (up to 3 dB).
 * The sidechain is dry speech, so effects never trigger the EQ. */
export function musicVoiceSpace(music: string, speech: string, output: string): string[] {
  return [
    `[${music}]asplit=2[spaceFull][spaceBandIn]`,
    `[spaceBandIn]highpass=f=1500,lowpass=f=4000,asplit=2[spaceBand][spaceBandDry]`,
    `[spaceBand][${speech}]sidechaincompress=threshold=0.012:ratio=8:attack=15:release=180:makeup=1[spaceBandDuck]`,
    `[spaceBandDry]volume=-0.292054[spaceSubtract]`,
    `[spaceBandDuck]volume=0.292054[spaceReturn]`,
    `[spaceFull][spaceSubtract][spaceReturn]amix=inputs=3:duration=first:normalize=0[${output}]`,
  ];
}

/** V23c: all delivery paths consume the same prepared music and source clock. */
export async function musicForEdit(root: string, record: import('./music-arrange').ArrangeRecord & { assembly: { template?: { fps: number } } }, fx: import('./edits-fx').FxPlan, wait: boolean, arrange: typeof import('./music-arrange').arrangedMusic) {
  const base = record.music !== undefined ? record.music : record.assembly.reel.music;
  const soundRecord = record as import('./sidekick').StoredVersion;
  const shape = base ? coupledSoundShape(soundRecord, fx, soundRecord.assembly.template?.fps ?? 30, 'shape' in base ? base.shape ?? [] : []) : [];
  const music = base && (shape.length ? { ...base, shape } : base);
  if (!music) return { music: null, arrangement: null };
  const arrangement = await arrange(root, record, fx, wait);
  return { music: arrangement ? { ...music, file: arrangement.file, startS: 0 } : { ...music } as import('../shared/schema').CutVersion['music'], arrangement };
}
