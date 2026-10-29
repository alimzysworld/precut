// PF1: the order work happens in. Nothing waits for a stage it does not need:
// transcripts need audio, not previews; ideas need transcripts and takes, not
// previews or performance checks. Real work is injected, so the order is testable.
import * as os from "node:os";
import { availableMemoryShare } from "./resource-governor";

export interface StreamingSteps {
  prepare(): Promise<void>;              // metadata (quick)
  previews(): Promise<void>;             // playable previews (ffmpeg, VideoToolbox)
  audio(): Promise<void>;                // transcripts, lining up sound, fillers
  pictures?(): Promise<void>;            // ANA1: stills and shake from each preview's decode, in the order they land
  takes(): Promise<void>;                // early grouping from transcripts + frames (one model call)
  ideas(): Promise<void>;                // early ideas, marked early
  drafts(): Promise<void>;               // first edits from the early ideas (needs previews)
  measures(): Promise<void>;             // framing and quality (needs previews)
  judge(): Promise<{ changed: boolean }>; // performance checks; changed = takes moved
  refresh(): Promise<void>;              // ideas and edits move to new versions, in place
}
export interface TimelineEntry { stage: keyof StreamingSteps | "overall"; startMs: number; endMs: number | null; error?: string }

/** Previews and transcription share the Mac when memory allows. ANA1: not gated on load. Speech runs on the
 * GPU (process.py measured 26 CPU-s in 100 s beside 518 CPU-s of previews), so a busy Mac running the lanes one
 * after the other only made transcripts wait: 0 of 220 clips while previews ran (TEST1). */
// os.freemem() on macOS counts only free pages (often under 1 GB while gigabytes sit inactive), so the
// lanes went serial at random. Count what the Mac can hand out, as the governor does.
export function lanePolicy(env: NodeJS.ProcessEnv = process.env, free = availableMemoryShare() * os.totalmem(), _load = os.loadavg()[0], _cores = os.cpus().length): "parallel" | "serial" {
  if (env.PRECUT_SERIAL_LANES === "1") return "serial";
  if (env.PRECUT_SERIAL_LANES === "0") return "parallel";
  return free >= 4 * 2 ** 30 ? "parallel" : "serial";
}

export async function runStreaming(steps: StreamingSteps, options: { mode?: "parallel" | "serial"; now?: () => number } = {}): Promise<TimelineEntry[]> {
  const now = options.now ?? Date.now, origin = now(), timeline: TimelineEntry[] = [];
  const timed = <T>(stage: TimelineEntry["stage"], work: () => Promise<T>): Promise<T> => {
    const entry: TimelineEntry = { stage, startMs: now() - origin, endMs: null };
    timeline.push(entry);
    return work().then(value => { entry.endMs = now() - origin; return value; }, error => {
      entry.endMs = now() - origin; entry.error = error instanceof Error ? error.message : String(error); throw error;
    });
  };
  const settle = (p: Promise<unknown>) => p.then(() => undefined, () => undefined);
  const mode = options.mode ?? lanePolicy();
  await timed("prepare", steps.prepare);
  // Serial mode still puts audio first: it is what unlocks the ideas.
  let previews: Promise<void> | undefined = mode === "parallel" ? timed("previews", steps.previews) : undefined;
  void previews?.catch(() => {});
  try {
    await timed("audio", steps.audio);
    if (steps.pictures) {
      // Serial: previews after the transcripts (audio first), before the stills that come from their decode.
      previews ??= timed("previews", steps.previews);
      void previews.catch(() => {});
      if (mode === "serial") await previews;
      await timed("pictures", steps.pictures);
    }
  } catch (error) { await settle(previews ?? Promise.resolve()); throw error; }
  // ONB2: takes are model work. When they fail, the local work still runs to the end (previews, framing and
  // quality); only the work that needs takes (ideas, first edits, the late judge) waits for a retry.
  let takesFailure: unknown = null;
  try { await timed("takes", steps.takes); } catch (error) { takesFailure = error ?? new Error("takes"); }
  const ideas = takesFailure ? Promise.resolve() : timed("ideas", steps.ideas);
  void ideas.catch(() => {});
  previews ??= timed("previews", steps.previews);
  let failure: unknown;
  try { await previews; } catch (error) { failure = error; }
  await settle(ideas);
  if (failure) throw failure;
  if (!takesFailure) await timed("drafts", steps.drafts);
  await timed("measures", steps.measures);
  if (takesFailure) throw takesFailure;
  const result = await timed("judge", steps.judge);
  if (result.changed) await timed("refresh", steps.refresh);
  return timeline;
}
