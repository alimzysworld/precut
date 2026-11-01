import { useState } from "react";
import type { DraftTimeline, PieceFx, PiecePunch } from "../../../../shared/schema";
import { PUNCH_ROW, punchSourceAt, punchTimeOf } from "../../../../shared/punch-keys";
import { formatDuration } from "../../data";
import { FOCUS, SectionHeader, Segments, Slider } from "../ui";

// CAP4: the clip's Punch row. Until now a punch was Ask-only (set_clip_punch); here it has its controls: add one at
// the playhead, its scale (1 to 1.6), settle or hold, and Drift (the slow push that keeps a shot from parking). Each
// change is the clip's settings with its new punch list, one pieceFx edit and one undoable version, the same record
// set_clip_punch writes (shared/punch-keys.ts maps the playhead to the source frame the same way). Its tick on the clip
// block in the timeline moves it. Soft fills only: focus and selection are a fill change.

const soft = `rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] text-ink hover:bg-ink/[0.1] focus-visible:bg-ink/[0.14] disabled:opacity-40 ${FOCUS}`;
/** Drift as he reads it: how much the picture grows each second (creep is per frame). */
const driftOf = (creep: number, fps: number) => Number((creep * fps * 100).toFixed(2));
const creepOf = (drift: number, fps: number) => Math.max(0, Math.min(PUNCH_ROW.creepMax, Math.round(drift / 100 / fps * 1e6) / 1e6));
const sortPunches = (list: PiecePunch[]) => [...list].sort((a, b) => a.sourceS - b.sourceS);

export function PunchControls({ fx, index, time, timeline, busy, onPreview, onCommit }: {
  fx: PieceFx; index: number; time: number; timeline?: DraftTimeline | null; busy: boolean;
  onPreview?: (fx: PieceFx) => void; onCommit: (fx: PieceFx) => void;
}) {
  const fps = timeline?.fps || 30, spans = timeline?.pieces ?? [];
  const punches = fx.punches ?? [];
  // A slider being dragged shows at once; it lands as one version on release.
  const [live, setLive] = useState<{ i: number; patch: Partial<PiecePunch> } | null>(null), [loose, setLoose] = useState<number | null>(null);
  const shown = punches.map((p, i) => live?.i === i ? { ...p, ...live.patch } : p);
  const withList = (list: PiecePunch[]): PieceFx => { const next = { ...fx }; if (list.length) next.punches = sortPunches(list); else delete next.punches; return next; };
  const change = (i: number, patch: Partial<PiecePunch>) => withList(punches.map((p, n) => n === i ? { ...p, ...patch } : p));
  const preview = (i: number, patch: Partial<PiecePunch>) => { setLive({ i, patch }); onPreview?.(change(i, patch)); };
  const commit = (i: number, patch: Partial<PiecePunch>) => { setLive(null); onCommit(change(i, patch)); };
  let here: number | null = null, why = "";
  if (fx.reverse) why = "This clip plays backwards; punches need it forwards.";
  else try { here = punchSourceAt(spans, index, time, fps); } catch { why = "Move the playhead onto this clip to add a punch there."; }
  const taken = here !== null && punches.some(p => Math.abs(p.sourceS - here!) < .5 / fps);
  function add(at: number, punch: Omit<PiecePunch, "sourceS">) { if (!busy) onCommit(withList([...punches, { sourceS: at, ...punch }])); }
  // Drift with no punch: a slow push from the clip's first frame (scale 1, creep only).
  const first = (() => { const span = spans.find(s => s.piece === index && s.layer === 0); if (!span || fx.reverse) return null; try { return punchSourceAt(spans, index, span.startS, fps); } catch { return null; } })();
  return <section aria-label="Punch" data-control="clip-punch" className="space-y-2.5">
    <div className="flex items-center justify-between gap-2"><SectionHeader as="h4" className="font-semibold">Punch</SectionHeader>
      <button type="button" data-punch-add disabled={busy || here === null || taken} title={why || (taken ? "There's a punch on this frame" : "A punch-in on the frame at the playhead")} onClick={() => here !== null && add(here, { scale: PUNCH_ROW.scale, style: "settle" })} className={soft}>Add at playhead</button></div>
    <p className="text-[11px] text-muted">{punches.length ? "Drag its tick on the clip in the timeline to move it; arrow keys move it a frame." : "A punch-in lands on the frame at the playhead. Drift alone is a slow push that keeps the shot alive."}</p>
    {why && !punches.length ? <p className="text-micro text-muted">{why}</p> : null}
    {shown.map((p, i) => {
      const at = punchTimeOf(spans, index, p.sourceS, fps), style = p.style ?? "settle";
      const label = p.scale <= 1.0001 ? "Push" : "Punch";
      return <div key={`${p.sourceS}-${i}`} data-punch-row={i} className="space-y-2 rounded-xl bg-ink/[0.04] p-2.5">
        <div className="flex items-center justify-between gap-2 text-[11px]"><span className="font-semibold text-ink">{label} at {at === null ? "a trimmed frame" : formatDuration(at)}</span>
          <button type="button" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} disabled={busy} onClick={() => onCommit(withList(punches.filter((_, n) => n !== i)))} className={soft}>Remove</button></div>
        <Slider label="Scale" aria-label={`Punch ${i + 1} scale`} data-control="punch-scale" min={1} max={PUNCH_ROW.max} step={.01} unit="x" defaultValue={PUNCH_ROW.scale} value={p.scale} disabled={busy}
          onChange={scale => preview(i, { scale })} onRelease={scale => commit(i, { scale })} />
        <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">Then</span>
          <Segments label={`Punch ${i + 1} style`} variant="compact" value={style} options={[{ value: "settle", label: "Settle", disabled: busy }, { value: "hold", label: "Hold", disabled: busy }]}
            onChange={value => commit(i, value === "hold" ? { style: "hold" } : { style: "settle" })} /></div>
        <Slider label="Drift" aria-label={`Punch ${i + 1} drift`} data-control="punch-drift" min={0} max={driftOf(PUNCH_ROW.creepMax, fps)} step={.1} unit="%/s" defaultValue={0} value={driftOf(p.creep ?? 0, fps)} disabled={busy || style === "hold"}
          onChange={drift => preview(i, { creep: creepOf(drift, fps) })} onRelease={drift => commit(i, { creep: creepOf(drift, fps) })} />
        {style === "hold" ? <p className="text-micro text-muted">Hold steps in and stays; Drift is for Settle.</p> : null}
      </div>;
    })}
    {!punches.length ? <Slider label="Drift" aria-label="Clip drift" data-control="clip-drift" min={0} max={driftOf(PUNCH_ROW.creepMax, fps)} step={.1} unit="%/s" defaultValue={0} value={loose ?? 0} disabled={busy || first === null}
      onChange={drift => { setLoose(drift); if (first !== null) onPreview?.(withList([{ sourceS: first, scale: 1, style: "settle", creep: creepOf(drift, fps) }])); }}
      onRelease={drift => { setLoose(null); if (first !== null && drift > 0) add(first, { scale: 1, style: "settle", creep: creepOf(drift, fps) }); }} /> : null}
  </section>;
}
