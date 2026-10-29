import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import type { CutVersion, TransitionSound } from '../shared/schema';
import type { FxPlan } from './edits-fx';
import { currentActivity, runActivity, withRenderSlot } from './activity';
import { tool } from './tools';
type SynthKind = TransitionSound | 'impact';
export const soundDuration: Record<SynthKind, number> = { whoosh: .55, hit: .48, pop: .22, riser: 1.2, impact: .9 };
export function soundGraph(kind: SynthKind): string {
  const d = soundDuration[kind];
  const noise = `anoisesrc=color=pink:amplitude=0.12:sample_rate=48000:seed=731:duration=${d}`;
  if (kind === 'hit' || kind === 'pop' || kind === 'impact') {
    const f = kind === 'pop' ? 620 : kind === 'impact' ? 58 : 105, decay = kind === 'pop' ? 30 : 14;
    return `aevalsrc=0.3*sin(2*PI*${f}*(1-exp(-10*t))/10)*exp(-${decay}*t)+0.08*sin(2*PI*${f * 2.1}*t)*exp(-35*t):s=48000:d=${d}[body];` +
      `${noise},highpass=f=${kind === 'pop' ? 1800 : 700},lowpass=f=6500,afade=t=out:st=0:d=${d * .7}[air];` +
      `[body][air]amix=inputs=2:normalize=0,aecho=0.8:0.35:37|73:0.16|0.08,atrim=duration=${d},afade=t=in:d=0.002,afade=t=out:st=${d - .1}:d=0.1`;
  }
  const commands = Array.from({ length: 16 }, (_, i) => `${(i * d / 16).toFixed(6)} bandpass@sw frequency ${Math.round(kind === 'riser' ? 250 + i * 270 : 5000 - i * 290)}`).join(';');
  return `${noise},asendcmd=c='${commands}',bandpass@sw=frequency=1000:width_type=h:width=1500,` +
    `aecho=0.8:0.4:43|89:0.2|0.1,atrim=duration=${d},afade=t=in:d=${kind === 'riser' ? .9 : .08},afade=t=out:st=${d - .16}:d=0.16`;
}
const pending = new Map<string, Promise<string>>();
export async function synthSound(kind: SynthKind): Promise<string> {
  if (!Object.hasOwn(soundDuration, kind)) throw new Error('Choose whoosh, hit, pop, riser or impact.');
  const directory = path.join(process.env.SIDETHING_USER_DATA ?? app.getPath('userData'), 'sfx');
  const output = path.join(directory, `v2-${kind}.wav`);
  try { if ((await fs.stat(output)).size > 44) return output; } catch { /* create */ }
  if (pending.has(output)) return pending.get(output)!;
  const work = runActivity({ kind: 'render', root: null, target: null, label: 'Preparing transition sound', cancelable: true }, activity => withRenderSlot(activity, async () => {
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${kind}-${randomUUID()}.wav`);
    try {
      await promisify(execFile)(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', soundGraph(kind), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', temporary],
        { signal: currentActivity()?.signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      activity.signal.throwIfAborted(); await fs.rename(temporary, output); return output;
    } finally { await fs.rm(temporary, { force: true }); }
  }), { renderLane: 'background' });
  pending.set(output, work);
  try { return await work; } finally { pending.delete(output); }
}
export function soundEvents(plan: FxPlan, version: Pick<CutVersion, 'overlays'> = {}): { atS: number; sound: TransitionSound }[] {
  return [...plan.joins.flatMap(j => j.choice.sound ? [{ atS: j.atS, sound: j.choice.sound }] : []),
    ...(version.overlays ?? []).flatMap(o => o.sound && o.s < plan.durationS && o.e > 0 ? [{ atS: Math.max(0, o.s), sound: o.sound }] : [])].sort((a, b) => a.atS - b.atS);
}
