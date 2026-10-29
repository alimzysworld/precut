import { useEffect, useMemo, useRef, useState } from "react";
import type { Api, Shoot } from "../../../shared/schema";
import { frameAt, getApi, proxySrc } from "../data";
import { Button, InlineError, Modal } from "./ui";
import { Check } from "./icons";

type Review = Awaited<ReturnType<Api["junkReview"]>>;
export function junkSize(bytes: number): string {
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1e3)} KB`;
}
function Preview({ shoot, id }: { shoot: Shoot; id: string }) {
  const [hover, setHover] = useState(false);
  const clip = shoot.clips.find(c => c.id === id), poster = frameAt(shoot, id, 0);
  return <span className="relative block h-16 w-24 shrink-0 overflow-hidden rounded-xl bg-ground outline-none"
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
    tabIndex={clip?.proxy ? 0 : undefined} aria-label="Preview shot">
    {poster && <img src={poster} alt="" className="size-full object-cover" />}
    {hover && clip?.proxy && <video className="absolute inset-0 size-full object-cover" src={proxySrc(shoot.root, clip.proxy)} poster={poster ?? undefined} muted autoPlay loop playsInline />}
  </span>;
}

/** A quiet entry point plus the app's existing centred sheet. */
export function JunkReview({ shoot, onShootChange }: { shoot: Shoot; onShootChange: (shoot: Shoot) => void }) {
  const api = useMemo(() => getApi(), []), [review, setReview] = useState<Review>({ clips: [], sizeBytes: 0 });
  const [open, setOpen] = useState(false), [rows, setRows] = useState<Review["clips"]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const pending = useRef(false);
  const signature = JSON.stringify(shoot.clips.map(c => [c.id, c.judgement?.junk]));
  useEffect(() => {
    if (!shoot.clips.some(clip => clip.judgement?.junk)) { setReview({ clips: [], sizeBytes: 0 }); return; }
    let active = true;
    void Promise.resolve().then(() => api.junkReview(shoot.root)).then(value => { if (active && Array.isArray(value?.clips)) setReview(value); }).catch(() => { if (active) setReview({ clips: [], sizeBytes: 0 }); });
    return () => { active = false; };
  }, [api, shoot.root, signature]);
  const chosen = rows.filter(row => selected.has(row.clipId)), bytes = chosen.reduce((sum, row) => sum + row.sizeBytes, 0);
  const kept = () => rows.filter(row => !selected.has(row.clipId)).map(row => row.clipId);
  async function close() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      if (kept().length) await api.keepClips(shoot.root, kept());
      setReview(await api.junkReview(shoot.root)); setOpen(false);
    } catch { setError("Could not save the clips you kept. Try again."); }
    finally { pending.current = false; setBusy(false); }
  }
  async function move() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (kept().length) await api.keepClips(shoot.root, kept());
      if (!chosen.length) { setReview(await api.junkReview(shoot.root)); setOpen(false); return; }
      const result = await api.trashClips(shoot.root, chosen.map(row => row.clipId));
      const value = await api.loadShoot(shoot.root); if (value) onShootChange(value);
      const next = await api.junkReview(shoot.root); setReview(next);
      const moved = new Set(result.trashed);
      setRows(previous => previous.filter(row => !moved.has(row.clipId)));
      setSelected(previous => new Set([...previous].filter(id => !moved.has(id))));
      if (result.trashed.length) setNotice(`Moved ${result.trashed.length} ${result.trashed.length === 1 ? "clip" : "clips"} to the Trash.`);
      if (result.failed.length) setError(result.failed.map(failure => `${rows.find(row => row.clipId === failure.clipId)?.reason ?? "Shot"}: ${failure.error}`).join("\n"));
      else setOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not move these clips. Try again."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <>
    {!!review.clips.length && <button type="button" data-junk-line className="mb-4 text-small text-muted hover:text-ink outline-none"
      onClick={() => { setRows(review.clips); setSelected(new Set(review.clips.map(row => row.clipId))); setError(""); setNotice(""); setOpen(true); }}>
      {review.clips.length} {review.clips.length === 1 ? "clip looks" : "clips look"} like accidents · {junkSize(review.sizeBytes)}
    </button>}
    <Modal open={open} onClose={() => void close()} title="Review accidents" className="!bg-surface !backdrop-filter-none">
      <div data-junk-sheet>
        <p className="mb-5 text-small text-muted">Keep anything that matters. The rest goes to the Trash.</p>
        <div className="max-h-[min(48vh,440px)] space-y-2 overflow-y-auto" aria-label="Clips to review">
          {rows.map(row => <div key={row.clipId} className="flex items-center gap-3 rounded-2xl bg-ground/60 p-3">
            <button type="button" role="checkbox" aria-checked={selected.has(row.clipId)} aria-label={row.reason} disabled={busy}
              className={`flex size-7 shrink-0 items-center justify-center rounded-lg outline-none ${selected.has(row.clipId) ? "bg-accent/15 text-accent" : "bg-surface text-muted"}`}
              onClick={() => setSelected(previous => { const next = new Set(previous); if (next.has(row.clipId)) next.delete(row.clipId); else next.add(row.clipId); return next; })}>
              {selected.has(row.clipId) ? <Check size={18} /> : null}
            </button>
            <Preview shoot={shoot} id={row.clipId} />
            <div className="min-w-0 flex-1"><p className="text-small">{row.reason}</p><p className="mt-1 text-micro text-muted tnum">{junkSize(row.sizeBytes)}</p></div>
          </div>)}
        </div>
        {notice && <p role="status" className="mt-4 text-small text-muted">{notice}</p>}
        {error && <InlineError className="mt-4 whitespace-pre-wrap text-small text-danger">{error}</InlineError>}
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button disabled={busy} onClick={() => void close()}>Close</Button>
          <Button variant="primary" disabled={busy} onClick={() => void move()}>{busy ? "Saving..." : chosen.length ? `Move ${chosen.length} to the Trash · ${junkSize(bytes)}` : "Keep all clips"}</Button>
        </div>
      </div>
    </Modal>
    {!open && notice && <p role="status" className="mb-4 text-small text-muted">{notice}</p>}
  </>;
}
