import { MUSIC_SHAPE } from './music-duck';
export { MUSIC_SHAPE, musicShapeGain, musicShapeTimes } from './music-duck';

/** PRO3a: the music's shape over the edit, the one description the export, the live viewer and every exporter read.
 * A stillness pulls the music down with a one-frame step and snaps it back on the hit that ends it; a hit dips the
 * music for a moment so the sound punches through, then recovers. The shape multiplies the speech duck
 * (music-duck.ts musicDuckKeys), so a stillness under speech is the same dip below wherever the duck already sits.
 * Times are edit seconds. Levels are dB below the music's own level. The gain itself lives in music-duck.ts, which the viewer's
 * test sandboxes load on its own (no runtime imports there). */
export type MusicShapeMark =
  | { kind: 'still'; atS: number; endS: number; db?: number }
  | { kind: 'hit'; atS: number; db?: number; recoverS?: number };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/** Checked and sorted marks, or an error in plain words. Levels -24..0 dB; a hit recovers over 0.02..3 s. */
export function validMusicShape(shape: unknown, durationS: number): MusicShapeMark[] {
  if (!Array.isArray(shape) || shape.length > MUSIC_SHAPE.maxMarks) throw new Error(`Give the music shape as a list of up to ${MUSIC_SHAPE.maxMarks} stillnesses and hits.`);
  const level = (db: unknown) => db === undefined || (finite(db) && db >= -24 && db <= 0);
  return shape.map((m: Record<string, unknown>): MusicShapeMark => {
    if (m?.kind === 'still' && finite(m.atS) && finite(m.endS) && m.atS >= 0 && m.endS > m.atS && m.atS < durationS && level(m.db))
      return { kind: 'still', atS: m.atS, endS: Math.min(m.endS, durationS), ...(m.db === undefined ? {} : { db: m.db as number }) };
    if (m?.kind === 'hit' && finite(m.atS) && m.atS >= 0 && m.atS < durationS && level(m.db) && (m.recoverS === undefined || (finite(m.recoverS) && m.recoverS >= .02 && m.recoverS <= 3)))
      return { kind: 'hit', atS: m.atS, ...(m.db === undefined ? {} : { db: m.db as number }), ...(m.recoverS === undefined ? {} : { recoverS: m.recoverS as number }) };
    throw new Error('Each music mark is a stillness {kind:"still", atS, endS, db?} or a hit {kind:"hit", atS, db?, recoverS?} inside the edit, db from -24 to 0.');
  }).sort((a, b) => a.atS - b.atS);
}

