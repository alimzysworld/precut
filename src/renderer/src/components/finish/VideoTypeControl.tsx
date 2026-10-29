import { useModelAccess, ModelSignIn } from "../ModelAccess";
import { useEffect, useRef, useState } from "react";
import type { VideoType } from "../../../../shared/schema";
import { getApi } from "../../data";
import { Button, InlineError, Tile } from "../ui";
import { VIDEO_TYPE_OPTIONS } from "../videoTypes";

/** VT1: the kind of video this edit is. Choosing another re-cuts it with that type's editing logic as a new version. */
export function VideoTypeControl({ root, cutId, current, disabled }: { root: string; cutId?: string; current?: VideoType; disabled: boolean }) {
  const modelReady = useModelAccess();
  const [chosen, setChosen] = useState<VideoType | undefined>(current), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  useEffect(() => { setChosen(current); setError(null); }, [cutId, current]);
  if (!modelReady) return <ModelSignIn feature="videoType" />;
  const option = VIDEO_TYPE_OPTIONS.find(item => item.value === chosen);
  const name = chosen === "talking" ? "talking" : chosen === "voiceover" ? "a voiceover" : `a ${option?.label.toLowerCase()}`;
  async function recut() {
    if (!cutId || !chosen || sending.current) return;
    sending.current = true; setPending(true); setError(null);
    try {
      const reply = await getApi().sidekickSend(root, `Re-cut this edit as ${name}.`, { cutId, videoType: chosen });
      if (reply.error) setError(reply.error);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't re-cut this edit."); }
    finally { sending.current = false; setPending(false); }
  }
  return <div className="space-y-2.5">
    <div role="group" aria-label="Kind of video" className="flex flex-wrap gap-1">
      {VIDEO_TYPE_OPTIONS.map(item => <Tile key={item.value} selected={chosen === item.value} disabled={disabled || pending} title={item.hint}
        onClick={() => setChosen(item.value)} className="rounded-lg px-2.5 py-1.5 text-[12px] focus-visible:bg-ink/[0.12] disabled:opacity-50">{item.label}</Tile>)}
    </div>
    {chosen && chosen !== current ? <>
      <p className="text-micro text-muted">{option?.hint}. Makes a new version; this one stays.</p>
      <Button variant="primary" disabled={disabled || pending || !cutId} onClick={() => void recut()}>{pending ? "Making new version…" : `Re-cut as ${name}`}</Button>
    </> : null}
    {error ? <InlineError className="text-danger">{error}</InlineError> : null}
  </div>;
}
