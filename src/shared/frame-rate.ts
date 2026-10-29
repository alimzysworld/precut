// EXP3: an edit is made and exported at a standard frame rate, so the file says the rate its label does.
// Phone clips record a variable rate and are read as their average (an iPhone "60" averages 59.89 when a few frames
// run long). That average is not a rate any file plays at: the export would carry 5989/100 while the sheet said 60.

/** Constant-rate cameras land within this of a standard rate (59.94 is 60000/1001 = 59.94006). */
const EXACT = 0.002;
const WHOLE = [24, 25, 30, 48, 50, 60, 100, 120, 240];
const NTSC = [24, 30, 48, 60, 120, 240].map(n => n * 1000 / 1001);
/** The rates phones record at. A variable-rate average sits a little under its nominal rate, never over it. */
const PHONE = [24, 25, 30, 60, 120, 240];

/**
 * The standard rate for a measured one. A constant rate keeps its own (29.97 stays 30000/1001, 25 stays 25). A variable
 * phone rate goes to the nominal rate it was shot at: the next phone rate at or above its average. iPhones write frames
 * on a 1/600 s clock, 10 ticks each at 60, so their nominal is a whole 60 (59.94 would drop one frame every 16.7 s).
 */
export function standardFrameRate(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return fps;
  const whole = WHOLE.find(n => Math.abs(fps - n) < EXACT);
  if (whole !== undefined) return whole;
  const ntsc = NTSC.find(n => Math.abs(fps - n) < EXACT);
  if (ntsc !== undefined) return ntsc;
  return PHONE.find(n => n >= fps - EXACT) ?? Math.round(fps);
}

/** How a rate reads on screen: 60, 25, 29.97, 59.94, 23.976. */
export function frameRateLabel(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return "";
  if (Math.abs(fps - Math.round(fps)) < EXACT) return String(Math.round(fps));
  const ntsc = NTSC.find(n => Math.abs(fps - n) < EXACT);
  if (ntsc !== undefined) return Math.round(ntsc) === 24 ? "23.976" : (Math.round(ntsc * 100) / 100).toFixed(2);
  return String(Math.round(fps * 100) / 100);
}
