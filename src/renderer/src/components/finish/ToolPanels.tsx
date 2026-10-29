import { mergePatch, changedPatch, selectionBatch } from "../timeline/selection";
import { InfoTip, InfoLabel, CONTROL_TIPS } from "../ui/InfoTip";
import { ClipSoundCleaning } from "./ClipSoundCleaning";
import { clipLaneDb, defaultClipMuted } from '../../../../shared/lane-levels';
import { previewLiveSound } from "../liveMix";
import { useModelAccess, ModelSignIn } from "../ModelAccess";
import { Row, Tile, SectionHeader, NumberField, InlineError } from "../ui";
import { useEffect, useId, useRef, useState } from "react";
import type { CutEdit, CutVersion, DraftTimeline, FramingChoice, JoinChoice, PieceFx, Shoot } from "../../../../shared/schema";
import { getApi } from "../../data";

import { Button, FOCUS, Switch } from "../ui";
import type { ReactNode } from "react";
import { Slider } from "./Controls";

export function FramingControls({ value, onChange, onRelease, onTightChange, inherit = false, pills = false }: { pills?: boolean; onTightChange?: (value: FramingChoice) => void; onRelease?: (value: FramingChoice) => void; value?: FramingChoice; onChange: (value?: FramingChoice) => void; inherit?: boolean }) {
  return <div className="space-y-3">
    {pills ? <div role="group" aria-label="Framing mode" className="flex flex-wrap gap-1">{[...(inherit ? [["inherit", "Same as edit"]] : []), ["off", "Off"], ["steady", "Steady"], ["face", "Lock on face"]].map(([mode, label]) => <Tile type="button" key={mode} aria-pressed={(value?.mode ?? (inherit ? "inherit" : "off")) === mode} onClick={() => onChange(mode === "inherit" ? undefined : { mode: mode as FramingChoice["mode"], tight: value?.tight ?? .4 })} className={`rounded-lg px-2.5 py-1.5 text-[12px] ${(value?.mode ?? (inherit ? "inherit" : "off")) === mode ? "bg-[var(--selection-fill)] text-[var(--accent)]" : "bg-ink/[0.035]"} ${FOCUS}`}>{label}</Tile>)}</div> : <Row as="label" className="gap-2">Framing<select aria-label="Framing mode" value={value?.mode ?? (inherit ? "inherit" : "off")} onChange={event => onChange(event.target.value === "inherit" ? undefined : { mode: event.target.value as FramingChoice["mode"], tight: value?.tight ?? .4 })} className={`rounded-lg bg-ink/[0.06] p-2 ${FOCUS}`}>
      {inherit ? <option value="inherit">Same as edit</option> : null}<option value="off">Off</option><option value="steady">Steady</option><option value="face">Lock on face</option>
    </select></Row>}
    {!pills || value?.mode === "face" ? <Slider label="How close" data-control="framing-close" min={0} max={1} step={.05} defaultValue={.4} disabled={value?.mode !== "face"} value={value?.tight ?? .4}
      onChange={tight => (onTightChange ?? onChange)({ mode: "face", ...value, tight })} onRelease={tight => onRelease?.({ mode: "face", ...value, tight })} /> : null}
  </div>;
}
export function MotionProgress({ shoot, visible }: { shoot: Shoot; visible: boolean }) {
  const [status, setStatus] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!visible) return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const ids = [...new Set(shoot.clips.map(clip => clip.id))];
    async function poll() {
      try { const next = await getApi().motionStatus(shoot.root, ids); if (alive) setStatus(next); }
      catch { /* No fabricated progress when unavailable. */ }
      if (alive) timer = setTimeout(poll, 2500);
    }
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [shoot.root, visible]);
  const entries = Object.values(status);
  return entries.includes("measuring") ? <p role="status" className="text-micro text-muted">Measuring shake, {entries.filter(value => value === "ready").length} of {entries.length}</p> : null;
}
export { TransitionControls } from "./TransitionsPanel";
export function LengthPanel({ root, cutId, version, lengthS, disabled }: { root: string; cutId?: string; version: number; lengthS: number; disabled: boolean }) {
  const modelReady = useModelAccess();
  const [target, setTarget] = useState(String(Math.round(lengthS))), [pending, setPending] = useState(false), sending = useRef(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { setTarget(String(Math.round(lengthS))); }, [cutId, version]);
  if (!modelReady) return <ModelSignIn feature="length" />;
  const seconds = Number(target);
  return <div className="space-y-3"><div className="flex gap-1">{[15, 30, 45, 60].map(length => <Tile type="button" key={length} onClick={() => setTarget(String(length))} aria-pressed={seconds === length} className={`flex-1 rounded-lg p-2 ${seconds === length ? "bg-ink/10" : "bg-ink/[0.04]"} ${FOCUS}`}>{length} s</Tile>)}</div>
    <Row as="label" className="">Target seconds<NumberField aria-label="Target seconds" min={1} max={3600} value={target} onChange={event => setTarget(event.target.value)} className={`w-24 rounded-lg bg-ink/[0.06] p-2 ${FOCUS}`} /></Row>
    <Button variant="primary" disabled={disabled || pending || !cutId || !Number.isFinite(seconds) || seconds < 1 || seconds > 3600} onClick={async () => { if (!cutId || sending.current) return; sending.current = true; setPending(true); setError(null); try { await getApi().sidekickSend(root, `Re-cut this edit to about ${seconds} seconds.`, { cutId, lengthS: seconds }); } catch (error) { setError(error instanceof Error ? error.message : "Couldn't re-cut this edit."); } finally { sending.current = false; setPending(false); } }}>{pending ? "Making new version…" : "Make new version"}</Button>
    {error ? <InlineError className="text-danger">{error}</InlineError> : null}
  </div>;
}

/** The scoped controls preserve every other effect on the selected clip. */
export function ClipFinishControls({ version, index, indexes, timeline, busy = false, onEdit }: {
  version: CutVersion; indexes?:number[]; index?: number | null; timeline?: DraftTimeline | null; mode?: "sound"; busy?: boolean; onEdit?: (edit: CutEdit) => unknown;
}) {
  const targets=indexes?.length ? indexes : index==null ? [] : [index];
  const patch=useRef<Record<string,unknown>>({});
  const mixed=(read:(fx:PieceFx,p:number)=>unknown)=>targets.length>1 && targets.some(p=>JSON.stringify(read(version.pieceFx?.[p] ?? {},p))!==JSON.stringify(read(version.pieceFx?.[targets[0]] ?? {},targets[0])));
  const saved = index == null ? {} : version.pieceFx?.[index] ?? {};
  const [fx, setFx] = useState<PieceFx>(saved), latest = useRef(fx), committed = useRef(JSON.stringify(saved));
  const pending = useRef(new Map<number, Set<string>>()), request = useRef(0), selected = useRef(index);
  if (selected.current !== index) { selected.current = index; request.current++; }
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { patch.current={}; latest.current = saved; setFx(saved); committed.current = JSON.stringify(saved); setError(null); }, [version.version, index, targets.join()]);
  function stage(next: PieceFx) {
    patch.current=mergePatch(patch.current,changedPatch(latest.current,next)); latest.current = next; setFx(next);
    if(timeline?.liveSound)previewLiveSound(timeline,{pieces:timeline.liveSound.pieces.map(p=>p.piece===undefined || !targets.includes(p.piece) ? p : (()=>{const own=targets.length>1 ? mergePatch(version.pieceFx?.[p.piece!] ?? {},patch.current) : next;return {...p,gainDb:clipLaneDb(version,p.layer===1 ? own.overlaySound?.gainDb ?? 0 : own.gainDb ?? 0),muted:!!version.clipSoundMuted || (p.layer===1 ? (own.overlaySound?.muted ?? !version.clipSoundDefaultOn) : !!own.reverse || (own.muted ?? defaultClipMuted(version,version.pieces?.[p.piece!]?.kind==='broll')))};})())});
  }
  async function commit(next = latest.current) {
    if (index == null || !onEdit || busy) return;
    const key = JSON.stringify(next), writes = pending.current.get(index) ?? new Set<string>();
    if (writes.has(key) || targets.length<2 && !writes.size && committed.current === key) return;
    const token = ++request.current; writes.add(key); pending.current.set(index, writes); setError(null); stage(next);
    try {
      await onEdit(targets.length>1 ? selectionBatch(targets,`Sound on ${targets.length} clips`,piece=>({kind:'pieceFx',piece,fx:mergePatch(version.pieceFx?.[piece] ?? {},patch.current)})) : { kind: "pieceFx", piece: index, fx: Object.keys(next).length ? next : null });
      if (token === request.current && selected.current === index) { committed.current = key; stage(next); }
    } catch (error) {
      if (token === request.current && selected.current === index) { stage(saved); setError(error instanceof Error ? error.message : "Couldn't change this clip."); }
    } finally { writes.delete(key); if (!writes.size) pending.current.delete(index); }
  }
  if (index == null) return null;
  return <fieldset disabled={busy} className="space-y-3 pt-1" data-control="clip-gain">
    <p className="font-semibold">{targets.length>1 ? `These ${targets.length} clips' sound` : "This clip's sound"}</p>
    <Row as="label">Mute{mixed((fx,p)=>fx.muted ?? defaultClipMuted(version,version.pieces?.[p]?.kind==='broll')) ? <span className="text-micro text-muted">Mixed</span> : null}<Switch aria-checked={mixed((fx,p)=>fx.muted ?? defaultClipMuted(version,version.pieces?.[p]?.kind==='broll')) ? 'mixed' : undefined} aria-label="Mute this clip's sound" checked={fx.muted ?? defaultClipMuted(version,version.pieces?.[index]?.kind === "broll")} onChange={event=>{patch.current={...patch.current,muted:event.target.checked};void commit({...latest.current,muted:event.target.checked});}} /></Row>
    {mixed(fx=>fx.clean ?? 'none') ? <p className="text-micro text-muted">Cleanup: Mixed</p> : null}<ClipSoundCleaning mixed={mixed(fx=>fx.clean ?? "none")} value={mixed(fx=>fx.clean ?? 'none') ? undefined : fx.clean} disabled={busy} onChange={async clean=>{await onEdit?.(targets.length>1 ? selectionBatch(targets,`Clean ${targets.length} clips`,piece=>({kind:'clipSound',piece,clean})) : {kind:"clipSound",piece:index,clean});}} />
    {version.clipSoundMuted && <p className="text-micro text-muted">Clip sound track is muted.</p>}<Slider mixed={mixed(fx=>fx.gainDb ?? 0)} label="Clip volume" value={fx.gainDb ?? 0} min={-12} max={12} step={.5} unit=" dB" defaultValue={0} onChange={gainDb => {patch.current={...patch.current,gainDb};stage({ ...latest.current, gainDb });}} onRelease={gainDb => void commit({ ...latest.current, gainDb })} />
    {targets.length===1 && version.pieces?.[index]?.overlay && <section className="space-y-2"><p className="font-semibold">B-roll sound</p><ClipSoundCleaning value={fx.overlaySound?.clean} disabled={busy} onChange={async clean=>{await onEdit?.({kind:"clipSound",piece:index,layer:1,clean});}} /><Row as="label">Mute<Switch aria-label="Mute attached b-roll sound" checked={latest.current.overlaySound?.muted ?? !version.clipSoundDefaultOn} disabled={busy} onChange={event=>void commit({...latest.current,overlaySound:{...latest.current.overlaySound,muted:event.target.checked}})} /></Row><Slider label="B-roll volume" min={-12} max={12} step={.5} unit=" dB" value={latest.current.overlaySound?.gainDb ?? 0} onChange={gainDb=>stage({...latest.current,overlaySound:{...latest.current.overlaySound,gainDb}})} onRelease={gainDb=>void commit({...latest.current,overlaySound:{...latest.current.overlaySound,gainDb}})} /></section>}
    {error ? <InlineError>{error}</InlineError> : null}
  </fieldset>;
}
/** Pace keeps edit rhythm and join settings together. */
export function PacePanel({ renderControl, music, cutToBeat, onCutToBeat, action, transitions, videoType, beatLine, beatWorking }: {
  renderControl: (id: string) => ReactNode; music: boolean; cutToBeat: boolean;
  onCutToBeat: (value: boolean) => void; action: ReactNode; transitions?: ReactNode; videoType?: ReactNode;
  beatLine?: string | null; beatWorking?: boolean;
}) {
  const tipId = useId();
  return <div className="space-y-3.5 pt-1">{videoType ? <section data-control="video-type" className="space-y-1.5"><SectionHeader as="h3" className="text-[12px] font-semibold">Kind of video</SectionHeader>{videoType}</section> : null}{["length", "energy"].map(id => <section key={id} data-control={id} className="space-y-1.5"><SectionHeader as="h3" className="flex items-center gap-1 text-[12px] font-semibold">{id[0].toUpperCase() + id.slice(1)}{id === "energy" ? <InfoTip label="Energy">{CONTROL_TIPS.energy}</InfoTip> : null}</SectionHeader>{renderControl(id)}</section>)}
    {music ? <div className="space-y-1.5"><Row data-control="cut-to-beat" className={`gap-2 rounded-lg px-2 py-1 ${beatWorking ? "bg-ink/[0.06]" : ""}`}><InfoLabel label="Cut to the music" htmlFor={`${tipId}-beat`}>{CONTROL_TIPS.beat}</InfoLabel><Switch id={`${tipId}-beat`} aria-label="Cut to the music" checked={cutToBeat} onChange={event => onCutToBeat(event.target.checked)} /></Row>{beatWorking ? <p role="status" className="px-2 text-micro text-muted">Cutting to the music</p> : beatLine ? <p role="status" className="px-2 text-micro text-muted">{beatLine}</p> : null}</div> : null}
    <section data-control="cuts" aria-label="Transitions" className="space-y-1.5"><SectionHeader as="h3" className="text-[12px] font-semibold">Transitions</SectionHeader>{transitions}</section>{action}
  </div>;
}
