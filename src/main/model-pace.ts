// LO1b: a small machine-local history, shared by the existing waiting-room clock.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
// PRO2b: Produce's stages learn here too. A render stage's size is its modelled seconds (produce-observe.ts windowCost), a
// model turn's is the pictures it reads.
type Kind = 'judge' | 'ideas' | 'produce-watch' | 'produce-direct' | 'produce-review' | 'produce-critic';
const KINDS: readonly string[] = ['judge', 'ideas', 'produce-watch', 'produce-direct', 'produce-review', 'produce-critic'];
type Sample = { kind: Kind; clips: number; seconds: number };
export const coldModelEstimate = (kind: Kind, clips: number) => kind === 'judge' ? 30 + Math.max(1, clips) * .54 : kind === 'ideas' ? 20 + Math.max(1, clips) * .24
  : kind === 'produce-direct' ? 40 + Math.max(1, clips) * 5 : kind === 'produce-critic' ? 25 + Math.max(1, clips) * 5 : Math.max(1, clips);
let directory: (() => string) | null = null;
/** Runtime supplies Electron's userData; the reusable clock stays independent of Electron. */
export function setModelPaceDirectory(resolve: () => string): void { directory = resolve; }
const historyFile = () => {
  if (!directory) throw new Error('Model timing storage has not been configured.');
  return path.join(directory(), 'model-pace.json');
};
function history(): Sample[] {
  try { const saved: unknown = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); return Array.isArray(saved) ? saved.filter(s => KINDS.includes(s.kind) && Number.isFinite(s.clips) && s.clips > 0 && Number.isFinite(s.seconds) && s.seconds > 0) : []; }
  catch { return []; }
}
export function estimateModelWork(kind: Kind, clips: number): number {
  const samples = history().filter(s => s.kind === kind).slice(-12).map(s => s.seconds * coldModelEstimate(kind, clips) / coldModelEstimate(kind, s.clips)).sort((a,b) => a-b);
  return samples.length ? samples[Math.floor(samples.length / 2)] : coldModelEstimate(kind, clips);
}
export async function measureModelWork<T>(kind: Kind, clips: number, work: () => Promise<T>): Promise<T> {
  const started = performance.now(), result = await work();
  recordModelWork(kind, clips, (performance.now() - started) / 1000);
  return result;
}
/** PRO2b: a finished stage whose size is only known once it is done (a Produce render). */
export function recordModelWork(kind: Kind, clips: number, seconds: number): void {
  const sample = { kind, clips: Math.max(1, clips), seconds: Math.max(.01, seconds) };
  let temp: string | undefined;
  try {
    const file = historyFile(); temp = `${file}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The newest dozen of each kind (all an estimate reads), so one kind's runs never push another's out.
    const all = [...history(), sample], kept = all.filter((s, i) => all.slice(i + 1).filter(o => o.kind === s.kind).length < 12);
    fs.writeFileSync(temp, JSON.stringify(kept));
    fs.renameSync(temp, file);
  } catch { /* Timing never fails a completed model answer. */ }
  finally { if (temp) { try { fs.unlinkSync(temp); } catch { /* renamed */ } } }
}
