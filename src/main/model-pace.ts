// LO1b: a small machine-local history, shared by the existing waiting-room clock.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
type Kind = 'judge' | 'ideas';
type Sample = { kind: Kind; clips: number; seconds: number };
export const coldModelEstimate = (kind: Kind, clips: number) => kind === 'judge' ? 30 + Math.max(1, clips) * .54 : 20 + Math.max(1, clips) * .24;
let directory: (() => string) | null = null;
/** Runtime supplies Electron's userData; the reusable clock stays independent of Electron. */
export function setModelPaceDirectory(resolve: () => string): void { directory = resolve; }
const historyFile = () => {
  if (!directory) throw new Error('Model timing storage has not been configured.');
  return path.join(directory(), 'model-pace.json');
};
function history(): Sample[] {
  try { const saved: unknown = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); return Array.isArray(saved) ? saved.filter(s => ['judge', 'ideas'].includes(s.kind) && Number.isFinite(s.clips) && s.clips > 0 && Number.isFinite(s.seconds) && s.seconds > 0) : []; }
  catch { return []; }
}
export function estimateModelWork(kind: Kind, clips: number): number {
  const samples = history().filter(s => s.kind === kind).slice(-12).map(s => s.seconds * coldModelEstimate(kind, clips) / coldModelEstimate(kind, s.clips)).sort((a,b) => a-b);
  return samples.length ? samples[Math.floor(samples.length / 2)] : coldModelEstimate(kind, clips);
}
export async function measureModelWork<T>(kind: Kind, clips: number, work: () => Promise<T>): Promise<T> {
  const started = performance.now(), result = await work();
  const sample = { kind, clips: Math.max(1, clips), seconds: Math.max(.01, (performance.now() - started) / 1000) };
  let temp: string | undefined;
  try {
    const file = historyFile(); temp = `${file}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify([...history(), sample].slice(-24)));
    fs.renameSync(temp, file);
  } catch { /* Timing never fails a completed model answer. */ }
  finally { if (temp) { try { fs.unlinkSync(temp); } catch { /* renamed */ } } }
  return result;
}
