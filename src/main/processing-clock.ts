import * as fs from 'node:fs';
import * as path from 'node:path';
import { coldModelEstimate, estimateModelWork } from './model-pace';
import type { Clip } from '../shared/schema';

export const pipelineLabels = ['Stills', 'Previews', 'Transcripts', 'Takes', 'Ideas', 'First edits'] as const;
export type PipelinePhase = typeof pipelineLabels[number];
type Phase = { label: PipelinePhase; state: 'queued' | 'running' | 'done' | 'failed' | 'skipped'; fraction: number; started?: number; cost: number; elapsed?: number; paused?: boolean };
type ClipWork = { weights: Map<string, number>; progress: Map<string, number>; total: number; prior: number };
export class ProcessingClock {
  readonly started: number;
  readonly phases: Phase[];
  private lastPct = 0;
  private shownEta: number | null = null;
  private etaAt = -Infinity;
  private etaScope = 'pipeline';
  private measured: boolean;
  private work = new Map<PipelinePhase, ClipWork>();
  /** Previews and transcripts share the clock: their time left overlaps instead of adding up. */
  parallel = false;
  constructor(private now: () => number = Date.now, costs: number[] = [], count = 1) {
    this.started = now();
    this.measured = costs.some(c => c > 0);
    // Cold estimates are explicitly estimates. Completed work is never inferred
    // from elapsed time. Subsequent runs use measured, saved phase costs.
    // Takes are judged in a shoot-wide call, never five seconds for every clip.
    const seed = [count * .2, count * 8, count * 12, coldModelEstimate('judge', count), coldModelEstimate('ideas', count), 120];
    this.phases = pipelineLabels.map((label, i) => ({ label, state: 'queued', fraction: 0, cost: costs[i] > 0 ? costs[i] : seed[i] }));
  }
  /** Once metadata lands, measure each lane against seconds of unfinished footage.
   * Cached work contributes neither throughput nor time. Photos have a small fixed
   * workload, rather than their generated editorial hold length. */
  setClips(clips: readonly Clip[], lane?: 'Previews' | 'Transcripts') {
    for (const label of lane ? [lane] : ['Previews', 'Transcripts'] as const) {
      if (!lane && this.work.has(label)) continue;
      const weights = new Map(clips.filter(c => c.stage !== 'error').map(c => [c.id,
        label === 'Transcripts' && c.transcript != null && !(c as Clip & { _transcriptNeedsRefresh?: boolean })._transcriptNeedsRefresh ? 0
          : c.photo ? 1 : Math.max(1, c.meta?.durationS ?? 1)]));
      const phase = this.phases.find(p => p.label === label)!;
      this.work.set(label, { weights, progress: new Map(), total: [...weights.values()].reduce((a, b) => a + b, 0), prior: phase.cost });
    }
  }
  updateClip(label: 'Previews' | 'Transcripts', id: string, fraction: number) {
    const work = this.work.get(label);
    if (!work || !work.weights.get(id)) return;
    if ((work.progress.get(id) ?? -1) >= fraction) return;
    const phase = this.phases.find(p => p.label === label)!;
    work.progress.set(id, Math.max(work.progress.get(id) ?? 0, Math.min(1, Math.max(0, fraction))));
    const done = [...work.progress].reduce((n, [key, value]) => n + work.weights.get(key)! * value, 0);
    this.update(label, done / work.total);
    const elapsed = this.elapsed(phase);
    const finished = [...work.progress.values()].filter(value => value === 1).length;
    // Three receipts retire the opening guess. A partial encode is useful too,
    // but must not let a single fast startup frame determine the whole shoot.
    const confidence = Math.min(1, (finished + (phase.fraction > 0 ? .25 : 0)) / 3);
    if (elapsed > .05 && phase.fraction > 0) phase.cost = Math.max(.01,
      work.prior * (1 - confidence) + elapsed / phase.fraction * confidence);
  }
  private elapsed(phase: Phase) {
    return (phase.elapsed ?? 0) + (phase.started === undefined || phase.paused ? 0 : (this.now() - phase.started) / 1000);
  }
  /** The late checks wait while ideas and edits run. Don't charge that wait twice. */
  pause(label: PipelinePhase) {
    const phase = this.phases.find(p => p.label === label)!;
    phase.elapsed = this.elapsed(phase); phase.paused = true;
  }
  resume(label: PipelinePhase) {
    const phase = this.phases.find(p => p.label === label)!;
    if (phase.paused) { phase.started = this.now(); phase.paused = false; }
  }
  update(label: PipelinePhase, fraction: number, state: Phase['state'] = 'running') {
    const phase = this.phases.find(p => p.label === label)!;
    if (phase.started === undefined) phase.started = this.now();
    phase.fraction = Math.max(phase.fraction, Math.min(1, Math.max(0, fraction)));
    phase.state = state;
    const elapsed = this.elapsed(phase);
    if (phase.fraction > 0 && elapsed > .05) phase.cost = Math.max(.01, elapsed / phase.fraction);
    if (state === 'done') { phase.fraction = 1; phase.cost = Math.max(.01, elapsed); }
  }
  snapshot() {
    const now = this.now(), running = this.phases.some(p => p.state === 'running');
    const ideaCall = this.phases.find(p => p.label === 'Ideas' && p.state === 'running' && !p.paused);
    const scope = ideaCall ? 'ideas' : 'pipeline';
    if (scope !== this.etaScope) { this.etaScope = scope; this.shownEta = null; this.etaAt = -Infinity; }
    const complete = this.phases.every(p => p.state === 'done' || p.state === 'skipped');
    const total = this.phases.reduce((n, p) => n + p.cost, 0);
    this.lastPct = complete ? 100 : Math.max(this.lastPct, Math.min(99, this.phases.reduce((n, p) => n + p.cost * p.fraction, 0) / total * 100));
    if (complete) this.shownEta = 0;
    else if (!this.measured && now - this.started < 15_000) this.shownEta = null; // cold start: no number until rates are measured
    else if (now - this.etaAt >= 10_000) {
      const left = (p: Phase) => {
        if (p.state === 'done' || p.state === 'skipped') return 0;
        const elapsed = this.elapsed(p);
        // A model call can overrun its history. Keep a non-zero estimate until
        // its saved result arrives, without advancing the measured percentage.
        return Math.max(p.cost * (1 - p.fraction), p.state === 'running' && !p.paused && elapsed > p.cost ? elapsed * .25 : 0);
      };
      const overlapped = this.parallel ? ['Previews', 'Transcripts'] : [];
      let remaining = this.phases.filter(p => !overlapped.includes(p.label)).reduce((n, p) => n + left(p), 0)
        + Math.max(0, ...this.phases.filter(p => overlapped.includes(p.label)).map(left));
      if (this.work.size) {
        const [stills, previews, transcripts, takes, ideas, drafts] = this.phases;
        const earlyTakes = takes.fraction < .5 ? left(takes) * (.5 - takes.fraction) / (1 - takes.fraction) : 0;
        const lateTakes = left(takes) - earlyTakes;
        // runStreaming: early ideas overlap previews; drafts then late checks.
        const reading = left(transcripts) + earlyTakes;
        remaining = left(stills) + (this.parallel ? Math.max(left(previews), reading + left(ideas))
          : reading + Math.max(left(previews), left(ideas))) + left(drafts) + lateTakes;
      }
      // Ideas need transcripts and takes, never previews or the paused late
      // checks. While that call runs, show its estimate, not the media backlog.
      if (ideaCall) remaining = left(ideaCall);
      // Cumulative stage pace smooths the samples. Bound each displayed revision
      // as well, so a long clip or a newly started stage cannot jerk the number.
      const target = Math.max(1, Math.round(remaining));
      // In the final minute, measured work can count down one ten-second
      // sample at a time. A percentage cap alone leaves the tail behind.
      const lower = this.shownEta === null ? target : !ideaCall && target < 60
        ? Math.min(Math.ceil(this.shownEta * .8), Math.max(1, this.shownEta - 10)) : Math.ceil(this.shownEta * .8);
      this.shownEta = this.shownEta === null ? target
        : Math.max(lower, Math.min(this.shownEta < 5 ? this.shownEta * 1.2 : Math.floor(this.shownEta * 1.2), target));
      this.etaAt = now;
    }
    // A failed stage ends the estimate at once: no countdown for work that stopped.
    const failed = this.phases.some(p => p.state === 'failed');
    if (failed) this.shownEta = null;
    return { pct: this.lastPct, etaS: this.shownEta, running, complete, failed,
      estimated: true, stages: this.phases.map(p => ({ label: p.label, state: p.state, pct: p.fraction * 100 })) };
  }
  finish() {
    for (const phase of this.phases) {
      if (phase.state === 'failed') return;
      if (phase.state === 'queued') { phase.state = 'skipped'; phase.fraction = 1; }
      else if (phase.state === 'running') this.update(phase.label, 1, 'done');
    }
  }
  /** Mark one phase failed now; a retry puts it back to running, and done once it finishes. */
  mark(label: PipelinePhase, state: 'failed' | 'running' | 'done') {
    const phase = this.phases.find(p => p.label === label)!;
    if (state === 'failed') { phase.state = 'failed'; if (phase.started === undefined) phase.started = this.now(); }
    else if (phase.state === 'failed') { phase.state = state; if (state === 'done') phase.fraction = 1; }
  }
  /** FIX3: when one phase already failed in its own words, the phases it stopped did not fail: finished ones are done, the rest wait for the retry. */
  fail() {
    const told = this.phases.some(p => p.state === 'failed');
    for (const phase of this.phases) if (phase.state === 'running') phase.state = !told ? 'failed' : phase.fraction >= 1 ? 'done' : 'queued';
  }
  costs() { return this.phases.map(p => p.cost); }
}
const clocks = new Map<string, ProcessingClock>();
/** Measured costs for the next run. A shoot folder that was renamed or moved meanwhile is left alone (FIX3): no write recreates it. */
function saveCosts(root: string, clock: ProcessingClock) {
  const file = path.join(root, '.sidething/processing-costs.json');
  try { fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 2, costs: clock.costs() })); fs.renameSync(`${file}.tmp`, file); }
  catch (error) { console.warn('[processing] Could not save measured costs:', (error as Error).message); }
}
/** NF2: waiting for a folder choice has no running-work ETA. */
export function clearProcessingClock(root: string): void { clocks.delete(root); }
export function startProcessingClock(root: string, count: number, parallel = false) {
  let costs: number[] = [];
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.sidething/processing-costs.json'), 'utf8'));
    // Old Takes totals included the idle wait for ideas/edits. Keep the useful
    // reading history, but don't carry that double charge into a new run.
    if (Array.isArray(saved)) { costs = saved; costs[3] = 0; }
    else if (saved.version === 2 && Array.isArray(saved.costs)) costs = saved.costs;
  } catch { /* first shoot */ }
  // Model phases use history across shoots on this Mac, scaled to this shoot's size.
  costs[3] = estimateModelWork('judge', count); costs[4] = estimateModelWork('ideas', count);
  const clock = new ProcessingClock(Date.now, costs, count); clock.parallel = parallel; clocks.set(root, clock); return clock;
}
export function updateProcessingClock(root: string, phase: PipelinePhase, fraction: number, state: Phase['state'] = 'running') {
  const clock = clocks.get(root); if (!clock) return;
  clock.update(phase, fraction, state);
  if (clock.snapshot().complete) saveCosts(root, clock);
}
const phaseOf: Record<string, PipelinePhase> = { index: 'Previews', transcribe: 'Transcripts', group: 'Takes', judge: 'Takes', ideas: 'Ideas', drafts: 'First edits' };
/** A stage failed (or a retry began): the overall indicator must say so within a tick. */
export function markProcessingStage(root: string, stage: string, state: 'failed' | 'running' | 'done') {
  const phase = phaseOf[stage];
  if (phase) clocks.get(root)?.mark(phase, state);
}
export function overallProcessing(root: string) { return clocks.get(root)?.snapshot(); }
/** ONB2: when this shoot's reading began (stills included), for "watched in N min". */
export function processingStartedAt(root: string): number | null { return clocks.get(root)?.started ?? null; }
export function configureProcessingWork(root: string, clips: readonly Clip[], lane?: 'Previews' | 'Transcripts') { clocks.get(root)?.setClips(clips, lane); }
export function updateProcessingClip(root: string, phase: 'Previews' | 'Transcripts', id: string, fraction: number) { clocks.get(root)?.updateClip(phase, id, fraction); }
export function pauseProcessingPhase(root: string, phase: PipelinePhase) { clocks.get(root)?.pause(phase); }
export function resumeProcessingPhase(root: string, phase: PipelinePhase) { clocks.get(root)?.resume(phase); }

export function finishProcessingClock(root: string, failed = false) {
  const clock = clocks.get(root); if (!clock) return;
  if (failed) clock.fail(); else clock.finish();
  if (clock.snapshot().complete) saveCosts(root, clock);
}
