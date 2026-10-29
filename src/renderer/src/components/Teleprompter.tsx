import type { VoiceoverLine } from "../../../shared/schema";
import { voiceClock } from "./voiceoverModel";
import "./voiceover.css";
export type PromptState = { lines: VoiceoverLine[]; index: number; elapsed: number; countdown: number; following: boolean; redo: boolean;
  /** Seconds this take should run, measured from where the edit starts playing. */
  expected?: number;
  /** Microphone level in dB, so he can see it hearing him. */
  level?: number;
  playhead?: number };
/** The edit is the main thing: full picture, moving. The words sit in a light
 * lower third, with a red dot, the running time and the mic level on top. */
export function Teleprompter({ prompt, onStop, onRestart }: { prompt: PromptState; onStop: () => void; onRestart: () => void }) {
  const current = prompt.lines[prompt.index], next = prompt.lines[prompt.index + 1];
  const expected = prompt.expected ?? (prompt.redo ? prompt.lines[0].e - prompt.lines[0].s : prompt.lines.at(-1)?.e ?? 0);
  const counting = prompt.countdown > 0;
  const level = Math.max(0, Math.min(1, ((prompt.level ?? -96) + 60) / 54));
  return <section className="vo-teleprompter" aria-label="Voiceover teleprompter" data-recording data-counting={counting || undefined}>
    {counting ? <p className="vo-countdown" aria-live="assertive">{prompt.countdown}</p> : null}
    <p className="vo-take-time" role="status">
      <span className="vo-record-dot" data-live={!counting || undefined} />
      <span>{counting ? "Get ready" : prompt.redo ? "Recording line" : "Recording"}</span>
      <span className="vo-take-clock">{voiceClock(prompt.elapsed)} of about {voiceClock(expected)}</span>
      <span className="vo-level" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><span style={{ transform: `scaleX(${counting ? 0 : level})` }} /></span>
    </p>
    <div className="vo-prompt-copy">
      <p className="vo-current" aria-live="polite">{current?.text ?? "That's the script. Stop when you're done."}</p>
      <p className="vo-next">{counting ? "The edit starts after the count." : next ? next.text : ""}</p>
      <div className="vo-prompt-row">
        <p className="vo-prompt-hint">{prompt.following ? "The words follow your voice. Space for the next line." : "Following the line timing. Space for the next line."}</p>
        <div className="vo-prompt-actions"><button type="button" onClick={onStop} title="Stop recording (Esc)">Stop (Esc)</button><button type="button" onClick={onRestart}>Start over</button></div>
      </div>
    </div>
  </section>;
}
