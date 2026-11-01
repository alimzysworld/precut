// BROLL2: the "Show what I say" strip above the timeline. Select words in the Script (or clips on the timeline, right
// click) and precut proposes one cutaway per phrase that names something the library shows. Each slot shows the picked
// shot and its alternatives; click one to swap, remove a slot, lay a screen recording over a desk shot, then "Use these"
// lands every cutaway as one version (Cmd+Z takes it back). Nothing is placed before that. Fills only, no strokes.
import { useEffect, useRef, useState } from "react";
import type { CutEdit, CutVersion, Shoot } from "../../../shared/schema";
import { BLEND_OPACITY, brollPlanEdit, overDesk, removeSlot, slotPlacement, swapSlot, type BrollPlan, type BrollShot, type BrollSlot } from "../../../shared/broll-plan";
import { migrateLayouts } from "../../../shared/layout-presets";
import { clipName } from "../../../shared/clip-name";
import { getApi } from "../data";
import { Filmstrip } from "./timeline/Filmstrip";
import { timelineTime } from "./timeline/model";
import { Button, InlineError, Switch, Tile } from "./ui";
import { Slider } from "./finish/Controls";
import { Close } from "./icons";

export const SHOW_WHAT_I_SAY = "precut:show-what-i-say";
/** Open the strip for a stretch of the edit (edit seconds). */
export function showWhatISay(s: number, e: number) {
  document.dispatchEvent(new CustomEvent(SHOW_WHAT_I_SAY, { detail: { s, e } }));
}

function Shot({ shoot, shot, length, width, height }: { shoot: Shoot; shot: BrollShot; length: number; width: number; height: number }) {
  return <span data-broll-shot className="relative flex shrink-0 overflow-hidden rounded-md bg-ink/[0.06]" style={{ width, height }}>
    <Filmstrip key={`${shot.clipId}@${shot.s}`} shoot={shoot} clipId={shot.clipId} start={shot.s} length={length} width={width} />
  </span>;
}

export function ShowWhatISay({ shoot, cutId, version, busy, onEdit, onSeek }: {
  shoot: Shoot; cutId: string; version: CutVersion; busy: boolean;
  onEdit: (edit: CutEdit) => unknown; onSeek?: (time: number) => void;
}) {
  const [plan, setPlan] = useState<BrollPlan | null>(null), [loading, setLoading] = useState<{ s: number; e: number } | null>(null);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false), [showSkipped, setShowSkipped] = useState(false);
  const request = useRef(0), latest = useRef({ cutId, version: version.version });
  latest.current = { cutId, version: version.version };
  async function propose(s: number, e: number) {
    const api = getApi(), ticket = ++request.current;
    setError(null); setPlan(null); setShowSkipped(false); setLoading({ s, e });
    try {
      if (!api.showWhatYouSay) throw new Error("Show what I say needs the precut app.");
      const next = await api.showWhatYouSay(shoot.root, latest.current.cutId, latest.current.version, { s, e });
      if (ticket === request.current) setPlan(next);
    } catch (cause) {
      if (ticket === request.current) setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, "") : "Could not look for shots.");
    } finally { if (ticket === request.current) setLoading(null); }
  }
  useEffect(() => {
    const open = (event: Event) => { const { s, e } = (event as CustomEvent<{ s: number; e: number }>).detail ?? {}; if (Number.isFinite(s) && Number.isFinite(e) && e > s) void propose(s, e); };
    document.addEventListener(SHOW_WHAT_I_SAY, open);
    return () => document.removeEventListener(SHOW_WHAT_I_SAY, open);
  }, [shoot.root]);
  // A different edit closes it; a new version of this edit keeps the proposal (its times are edit seconds).
  useEffect(() => { request.current++; setPlan(null); setLoading(null); setError(null); }, [cutId]);
  const close = () => { request.current++; setPlan(null); setLoading(null); setError(null); };
  function change(next: (plan: BrollPlan) => BrollPlan) { if (!plan) return; try { setPlan(next(plan)); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change that."); } }
  async function use() {
    if (!plan || busy || saving) return;
    setSaving(true); setError(null);
    try {
      const result = await onEdit(brollPlanEdit(plan.slots.map(slotPlacement), migrateLayouts(version), { s: plan.s, e: plan.e },
        plan.slots.length === 1 ? `Show what I say: “${plan.slots[0].phrase.slice(0, 60)}”` : `Show what I say: ${plan.slots.length} cutaways`));
      if (result === false) throw new Error("Could not place the cutaways.");
      close();
    } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, "") : "Could not place the cutaways."); }
    finally { setSaving(false); }
  }
  if (!plan && !loading && !error) return null;
  const range = plan ?? loading;
  return <section data-show-what-i-say aria-label="Show what I say" className="st-glass-surface mx-2 mb-1 shrink-0 rounded-xl bg-ink/[0.03] px-3 py-2">
    <div className="flex items-center gap-2">
      <h3 className="text-small font-semibold">Show what I say</h3>
      {range ? <span className="text-micro tabular-nums text-muted">{timelineTime(range.s)} to {timelineTime(range.e)}</span> : null}
      <p role="status" className="min-w-0 flex-1 truncate text-micro text-muted">{loading ? "Looking through your footage…" : plan?.note}</p>
      {plan?.skipped.length ? <Tile type="button" aria-pressed={showSkipped} onClick={() => setShowSkipped(v => !v)} className={`rounded-full px-2.5 py-1 text-[11px] ${showSkipped ? "bg-[var(--selection-fill)] text-accent" : "bg-ink/[0.05] text-muted hover:bg-ink/[0.08]"}`}>{plan.skipped.length} stay on you</Tile> : null}
      {plan?.slots.length ? <Button variant="primary" disabled={busy || saving} onClick={() => void use()}>{saving ? "Placing…" : plan.slots.length === 1 ? "Use this" : "Use these"}</Button> : null}
      <Tile type="button" aria-label="Close Show what I say" onClick={close} className="flex size-7 items-center justify-center rounded-full bg-ink/[0.05] text-muted hover:bg-ink/[0.1] focus-visible:bg-ink/[0.12]"><Close size={14} /></Tile>
    </div>
    {showSkipped && plan ? <ul data-broll-skipped className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-micro text-muted">{plan.skipped.map(k => <li key={`${k.s}`}><span className="text-ink">“{k.phrase}”</span> · {k.why}</li>)}</ul> : null}
    {plan?.slots.length ? <ol data-broll-slots className="mt-2 flex gap-2 overflow-x-auto pb-1">{plan.slots.map((slot, i) =>
      <Slot key={slot.id} index={i} shoot={shoot} slot={slot} disabled={busy || saving} onSeek={onSeek}
        onSwap={shot => change(p => swapSlot(p, slot.id, shot))} onRemove={() => change(p => removeSlot(p, slot.id))}
        onOver={(desk, opacity) => change(p => overDesk(p, slot.id, desk, opacity))} />)}</ol> : null}
    {error ? <InlineError>{error}</InlineError> : null}
  </section>;
}

function Slot({ index, shoot, slot, disabled, onSeek, onSwap, onRemove, onOver }: {
  index: number; shoot: Shoot; slot: BrollSlot; disabled: boolean; onSeek?: (time: number) => void;
  onSwap: (shot: { clipId: string; s: number }) => void; onRemove: () => void; onOver: (desk: { clipId: string; s: number } | null, opacity?: number) => void;
}) {
  const length = slot.e - slot.s, name = (shot: BrollShot) => shot.name || clipName(shoot.clips.find(c => c.id === shot.clipId) ?? null);
  const [opacity, setOpacity] = useState(slot.over?.opacity ?? BLEND_OPACITY);
  const canWeave = slot.pick.kind === "screen" && slot.desks.length > 0;
  return <li data-broll-slot={index} className="flex w-[300px] shrink-0 flex-col gap-1.5 rounded-lg bg-ink/[0.04] p-2">
    <div className="flex items-start gap-1">
      <Tile type="button" onClick={() => onSeek?.(slot.s)} title="Play from here" className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-left hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08]">
        <span className="block truncate text-small">“{slot.phrase}”</span>
        <span className="block text-micro tabular-nums text-muted">{timelineTime(slot.s)} · {length.toFixed(1)} s on {slot.thing}</span>
      </Tile>
      <Tile type="button" disabled={disabled} aria-label={`Remove the cutaway for ${slot.thing}`} onClick={onRemove} className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-muted hover:bg-ink/[0.1] focus-visible:bg-ink/[0.12]"><Close size={12} /></Tile>
    </div>
    <div className="flex gap-2">
      <Shot shoot={shoot} shot={slot.pick} length={length} width={120} height={68} />
      <p data-broll-pick className="min-w-0 text-micro"><span className="line-clamp-2 text-ink">{name(slot.pick)}</span><span className="text-muted">{slot.pick.why}{slot.pick.steady === false ? " · shaky" : ""}{slot.pick.kind === "screen" ? " · screen" : slot.pick.kind === "photo" ? " · photo" : ""}</span></p>
    </div>
    {slot.alternatives.length ? <div role="group" aria-label={`Other shots for ${slot.thing}`} className="flex gap-1 overflow-x-auto">{slot.alternatives.map(shot =>
      <Tile key={`${shot.clipId}@${shot.s}`} type="button" disabled={disabled} data-broll-alternative={shot.clipId} aria-label={`Use ${name(shot)}`} title={`${name(shot)} · ${shot.why}`} onClick={() => onSwap({ clipId: shot.clipId, s: shot.s })}
        className="shrink-0 rounded-md bg-ink/[0.03] p-0.5 opacity-80 hover:bg-ink/[0.1] hover:opacity-100 focus-visible:bg-[var(--selection-fill)] focus-visible:opacity-100">
        <Shot shoot={shoot} shot={shot} length={length} width={52} height={30} />
      </Tile>)}</div> : <p className="text-micro text-muted">No other shots show {slot.thing}.</p>}
    {canWeave ? <div data-broll-weave className="space-y-1 rounded-md bg-ink/[0.03] p-1.5">
      <label className="flex items-center justify-between gap-2 text-micro">Over a desk shot<Switch label="Over a desk shot" disabled={disabled} checked={!!slot.over} onChange={event => onOver(event.target.checked ? slot.desks[0] : null, opacity)} /></label>
      {slot.over ? <>
        <div role="group" aria-label="Desk shot" className="flex gap-1">{slot.desks.map(desk => <Tile key={desk.clipId} type="button" disabled={disabled} aria-pressed={slot.over?.desk.clipId === desk.clipId} aria-label={`Under it: ${name(desk)}`} title={name(desk)} onClick={() => onOver(desk, opacity)}
          className={`shrink-0 rounded-md p-0.5 ${slot.over?.desk.clipId === desk.clipId ? "bg-[var(--selection-fill)]" : "bg-ink/[0.03] hover:bg-ink/[0.1]"}`}><Shot shoot={shoot} shot={desk} length={length} width={44} height={26} /></Tile>)}</div>
        <Slider label="Screen opacity" value={Math.round(opacity * 100)} min={20} max={95} unit="%" defaultValue={Math.round(BLEND_OPACITY * 100)} disabled={disabled}
          onChange={value => setOpacity(value / 100)} onRelease={value => onOver(slot.over!.desk, value / 100)} />
      </> : null}
    </div> : null}
  </li>;
}
