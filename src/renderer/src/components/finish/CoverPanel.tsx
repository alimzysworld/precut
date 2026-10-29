import { SectionHeader, InlineError } from "../ui";
import { useEffect, useId, useState } from "react";
import type { CutEdit, CutVersion, DraftTimeline } from "../../../../shared/schema";
import { getApi } from "../../data";
import { Button, FOCUS } from "../ui";
import { useActivity } from "../Activity";

export function CoverPanel({ root, cutId, version, time, timeline, disabled, onEdit, heading = true }: {
  root: string; cutId?: string; version: CutVersion; time: number; timeline?: DraftTimeline | null;
  disabled?: boolean; onEdit?: (edit: CutEdit) => void; heading?: boolean;
}) {
  // The editor keeps its last timeline while a cover-only edit loads, so a cover that no longer matches this version is stale: ask for a fresh one.
  const live = timeline?.cover, saved = version.cover;
  const stale = !!live && (live.auto !== (!saved || saved.auto) || (!live.auto && Math.abs(live.t - (saved?.t ?? 0)) > 1e-6) || (!live.auto && live.title !== (saved?.title ?? version.title)));
  const current = stale ? null : live ?? null;
  const [cover, setCover] = useState(current);
  const [title, setTitle] = useState(version.cover?.title ?? version.title);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const id = useId();
  const failures = useActivity({ root, kind: "looks", target: { cutId, version: version.version }, state: "failed" });
  const failure = failures.find(activity => activity.label === "Making cover");
  const [dismissedFailure, setDismissedFailure] = useState<string | null>(null);
  const renderError = failure && failure.id !== dismissedFailure ? failure.note ?? "Could not make the cover. Try again." : null;
  useEffect(() => { setTitle(version.cover?.title ?? version.title); }, [version.version, version.cover?.title, version.title]);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    setCover(current); setError(null);
    if (!cutId || current?.image || renderError) return;
    async function load() {
      try {
        const draft = await getApi().draftTimeline(root, cutId!, version.version);
        if (!active) return;
        setCover(draft.cover ?? null);
        if (draft.cover && !draft.cover.image) timer = setTimeout(() => void load(), 2000);
        else if (!draft.cover) setError("The cover preview is not available here.");
      } catch (error) { if (active) setError(error instanceof Error ? error.message : "Could not load the cover."); }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [root, cutId, version.version, current?.image, retry, renderError]);
  const locked = disabled || !cutId || !onEdit;
  function saveTitle() {
    if (locked || title === (version.cover?.title ?? version.title)) return;
    onEdit!({ kind: "cover", cover: { t: cover?.t ?? version.cover?.t ?? 0, auto: false, title } });
  }
  return <section aria-label="Cover" className={heading ? "space-y-3 pt-4" : "space-y-3"}>
    {heading ? <SectionHeader as="h4" className="text-small font-medium">Cover</SectionHeader> : null}
    <div className="flex min-h-24 items-center justify-center overflow-hidden rounded-xl bg-ink/[0.04]" style={{ aspectRatio: timeline ? `${timeline.width}/${timeline.height}` : "9/16", maxHeight: 240 }}>
      {cover?.image ? <img src={cover.image} alt="Cover for this edit" className="h-full w-full object-contain" /> : <p role="status" className="px-3 text-center text-micro text-muted">{error || renderError ? "Cover preview unavailable" : "Making cover…"}</p>}
    </div>
    <p className="text-micro text-muted">{(cover?.auto ?? !version.cover) ? "Automatic frame" : "Your frame"}{cover ? ` · ${cover.t.toFixed(2)} s` : ""}</p>
    <Button type="button" variant="primary" aria-label="Use current frame" disabled={locked || !Number.isFinite(time)} onClick={() => onEdit?.({ kind: "cover", cover: { t: Math.max(0, Math.min(time, (timeline?.durationS ?? version.lengthS) - .001)), auto: false, title } })}>Use current frame</Button>
    <label htmlFor={id} className="block text-micro text-muted">Cover title</label>
    <input id={id} aria-label="Cover title" value={title} disabled={locked} onChange={event => setTitle(event.target.value)} onKeyDown={event => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); saveTitle(); }
    }} className={`w-full rounded-lg bg-ink/[0.05] px-3 py-2 text-small ${FOCUS}`} />
    <p className="text-micro text-muted">Press Enter to save the title. Cover changes make a new version.</p>
    <Button type="button" variant="ghost" aria-label="Back to automatic" disabled={locked || !version.cover} onClick={() => onEdit?.({ kind: "cover", cover: null })}>Back to automatic</Button>
    {error || renderError ? <InlineError className="text-micro text-danger">{error ?? renderError} <button type="button" className={`underline ${FOCUS}`} onClick={() => { setDismissedFailure(failure?.id ?? null); setRetry(n => n + 1); }}>Retry</button></InlineError> : null}
  </section>;
}
