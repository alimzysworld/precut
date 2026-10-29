import { useModelAccess, ModelSignIn } from "./ModelAccess";
import { useState } from "react";
import type { Clip, Shoot } from "../../../shared/schema";
import { getApi } from "../data";
import { go } from "../nav";
import { Button, InlineError } from "./ui";

declare module "../nav" { interface NavParams { failed?: "1" } }

export function clipReadError(clip: Clip): string {
  const error = clip.error ?? "";
  if (/no such file|not found|missing|disconnected/i.test(error)) return "This clip is missing. Reconnect its drive, then retry.";
  if (/transcri|speech|dialogue/i.test(error)) return "Couldn't read the words in this clip. Try again.";
  return "Couldn't read this clip. Check it opens, then retry.";
}

/** The same saved clip failures in the waiting room and its filtered Footage view. */
export function FailedClips({ shoot, details = false, onChange }: { shoot: Shoot | null; details?: boolean; onChange?: (shoot: Shoot) => void }) {
  const modelReady = useModelAccess();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const clips = shoot?.clips.filter(c => c.stage === "error" && !c.missing) ?? [];
  if (!shoot || !clips.length) return details ? <p className="text-small text-muted">All clips read.</p> : null;
  // ONB2: only re-checking takes needs the AI; reading and transcripts retry on this Mac.
  if (!modelReady && clips.every(c => c.meta && c.transcript != null)) return <ModelSignIn feature="takes" />;
  const all = clips.length === shoot.clips.length;
  async function retry(clip: Clip) {
    if (!shoot || busy) return;
    setBusy(true); setError("");
    try {
      const api = getApi();
      await api.retryStage(shoot.root, !clip.meta ? "index" : clip.transcript == null ? "transcribe" : "judge");
      // The existing stage retry repairs its data only. Resume any remaining
      // reading through the normal cached import path, then ideas can begin.
      await api.addShoot(shoot.root);
      const next = await api.loadShoot(shoot.root); if (next) onChange?.(next);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't retry. Try again."); }
    finally { setBusy(false); }
  }
  return <div data-failed-clips className="flex flex-col gap-3 text-small text-muted">
    <div className="flex flex-wrap items-center justify-center gap-2">
      <span>{all ? "Couldn't read any clips. Ideas need readable footage." : `${clips.length} ${clips.length === 1 ? "clip couldn't" : "clips couldn't"} be read`}</span>
      {!details && <Button variant="ghost" onClick={() => go("clips", { shoot: shoot.root, failed: "1" })}>See which</Button>}
      {all && !details && <Button variant="secondary" disabled={busy} onClick={() => void retry(clips[0])}>{busy ? "Retrying..." : "Retry"}</Button>}
    </div>
    {details && clips.map(clip => <div key={clip.id} data-failed-clip={clip.id} className="flex items-center gap-4 rounded-xl bg-surface p-4 text-left">
      <div className="min-w-0 flex-1"><p className="m-0 truncate text-ink">{clip.file.split(/[\\/]/).pop()}</p><p className="mb-0 mt-1">{clipReadError(clip)}</p></div>
      <Button variant="secondary" disabled={busy} onClick={() => void retry(clip)}>{busy ? "Retrying..." : "Retry"}</Button>
    </div>)}
    {error && <InlineError>{error}</InlineError>}
  </div>;
}
