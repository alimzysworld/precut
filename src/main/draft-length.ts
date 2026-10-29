// Measure first; editorial timing belongs to the model, never a code cutoff.
export const missesLength = (actual: number, target: number) => Math.abs(actual - target) > Math.max(5, target * .15) + 1e-6;
export function lengthClock(seconds: number): string {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}
export const lengthWarning = (actual: number, target: number) => missesLength(actual, target)
  ? `Came out ${lengthClock(actual)} against ${lengthClock(target)}` : null;

export async function repairDraftLength<T extends { lengthS: number }>(first: T, target: number,
  pieces: { id: string; description: string; lengthS: number }[], repair: (instruction: string) => Promise<T>): Promise<T> {
  if (!missesLength(first.lengthS, target)) return first;
  const instruction = `The assembled draft measures ${first.lengthS.toFixed(2)} seconds against a ${target} second target. Keep that target.\n`
    + `Measured pieces in play order:\n${pieces.map(p => `${p.id}: ${p.lengthS.toFixed(2)} s of ${p.description}`).join("\n")}\n`
    + "Repair this cut once to land on the target using your editorial judgement. Trim long holds with cut.spans, drop or reshape beats, preserve the hook and payoff. Do not simply change targetS. For a voiceover video the target is the finished picture WITH voiceover; do not leave it long for voiceover. Return the complete reply JSON with the repaired cut, including its finish plan.";
  try {
    const next = await repair(instruction);
    return Math.abs(next.lengthS - target) < Math.abs(first.lengthS - target) ? next : first;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // A failed optional repair must not discard an otherwise usable first cut.
    console.warn("[draft] Could not repair the length:", error);
    return first;
  }
}
