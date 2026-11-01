import { TransformPanel } from "./TransformPanel";
import { LockGroup } from "./LockGroup";
import { PunchControls } from "./PunchControls";
import { ClipSoundCleaning } from "./ClipSoundCleaning";
import { clipLaneDb, defaultClipMuted } from '../../../../shared/lane-levels';
import { previewLiveSound, type LiveSoundTimeline } from "../liveMix";
import { Switch, SectionHeader, Row, InlineError, Tile } from "../ui";
import { useActivity } from "../Activity";
import { usesPractice } from "../edits/model";
import { FramingControls } from "./ToolPanels";
import { LayoutPanel } from "./LayoutPanel";
import { BackgroundControls } from "./BackgroundControls";
import type { PieceFx } from "../../../../shared/schema";
import { useEffect, useRef, useState } from "react";
import { Play, Split, Delete } from "../icons";
import type { CutEdit, DraftTimeline, Shoot, Word } from "../../../../shared/schema";
import { formatDuration, frameAt, proxySrc } from "../../data";
import { useNav } from "../../nav";
import type { Piece } from "../edits/model";
import type { StageHandle } from "../Stage";
import { Button, FOCUS, Slider } from "../ui";
import { takeThumbnail } from "../footage/thumbnail";

/** The Clip sheet's single take list. Footage keeps its own replacement flow. */
export function ClipTakes({ shoot, piece, index, busy, onEdit, player, onPreviewInContext }: {
  shoot: Shoot; piece: Piece; index: number; busy: boolean; onEdit: (edit: CutEdit) => void;
  player: React.RefObject<StageHandle>; onPreviewInContext?: (clipId: string, s: number, e: number) => void;
}) {
  const line = /^L(\d+)A(\d+)$/i.exec(piece.id);
  const take = line ? shoot.takes.find(entry => entry.lineIndex === Number(line[1]) - 1) : undefined;
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => player.current?.stopPreview(), [piece.id, index, player]);
  if (!take) return null;
  const currentAttempt = take.attempts.findIndex(attempt => attempt.clipId === piece.clipId && attempt.s <= piece.s + .05 && attempt.e >= piece.e - .05);
  return <section aria-label="Swap take" className="space-y-1.5">
    <Row className="gap-2"><SectionHeader as="h4" className="font-semibold">Takes of this line</SectionHeader><span className="text-[11px] text-muted">Hover to watch</span></Row>
    {take.attempts.map((attempt, attemptIndex) => {
      const current = currentAttempt === attemptIndex;
      const clip = shoot.clips.find(entry => entry.id === attempt.clipId), poster = clip ? takeThumbnail(shoot, { clip, s: attempt.s }) ?? frameAt(shoot, attempt.clipId, attempt.s) : null;
      const reason = attempt.note?.trim() || (!take.starredByHand && take.starred === attemptIndex ? take.why?.trim() : "");
      const audition = () => { if (clip?.proxy) player.current?.preview(proxySrc(shoot.root, clip.proxy), attempt.s, attempt.e); };
      return <div key={attemptIndex} data-take-row className="group relative">
        <Tile type="button" aria-label={`Take ${attemptIndex + 1}`} aria-pressed={current} disabled={busy} aria-disabled={!!attempt.practice && !current || undefined}
          onMouseEnter={audition} onMouseLeave={() => player.current?.stopPreview()} onFocus={audition} onBlur={() => player.current?.stopPreview()}
          onClick={async () => {
            if (busy || current || attempt.practice || pending.current) return;
            pending.current = true; setError(null); player.current?.stopPreview();
            try { await onEdit({ kind: "swap", piece: index, take: `L${line![1]}A${attemptIndex + 1}` }); }
            catch (error) { setError(error instanceof Error ? error.message : "Couldn't swap this take."); }
            finally { pending.current = false; }
          }} className={`flex w-full items-center gap-2.5 rounded-[10px] p-1.5 ${onPreviewInContext && clip?.proxy ? "pr-9" : ""} text-left disabled:opacity-50 aria-disabled:opacity-50 ${current ? "bg-[var(--selection-fill)]" : "bg-ink/[0.04] hover:bg-ink/[0.08]"} ${FOCUS}`}>
          <span className="h-[46px] w-9 shrink-0 overflow-hidden rounded-md bg-ink/[0.06]">{poster ? <img src={poster} alt="" className="size-full object-cover" /> : null}</span>
          <span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold">Take {attemptIndex + 1}{attempt.practice ? " · practice" : ""}</span>{reason ? <span className="block text-[11px] text-muted">{reason}</span> : null}</span>
          <span className="shrink-0 text-right text-[11px] text-muted">{current ? <span className="block text-accent">In use</span> : null}{formatDuration(attempt.e - attempt.s)}</span>
        </Tile>
        {onPreviewInContext && clip?.proxy ? <button type="button" disabled={busy} title="Play in context" onClick={() => onPreviewInContext(attempt.clipId, attempt.s, attempt.e)} className={`absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-0 hover:bg-ink/[0.08] group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-40 [@media(hover:none)]:opacity-100 ${FOCUS}`} aria-label={`Play take ${attemptIndex + 1} in context`}><Play size={14} /></button> : null}
      </div>;
    })}
    {error ? <InlineError>{error}</InlineError> : null}
  </section>;
}

/** Source position follows the actual playable spans, including filler cuts. */
export function pieceSourceTime(piece: Piece, time: number, timeline?: DraftTimeline | null, index?: number, shoot?:Shoot): number | null {
  const start = piece.timelineS ?? 0, length = piece.lengthS ?? piece.e - piece.s;
  if (time < start - 1e-6 || time >= start + length) return null;
  const span = timeline?.pieces.find(p => p.layer === 0 && (p.clipId === piece.clipId || !!shoot?.angles?.some(g => g.clips.some(c => c.clipId===p.clipId) && g.clips.some(c => c.clipId===piece.clipId))) && (index === undefined || p.piece === undefined || p.piece === index) && time >= p.startS && time < p.endS);
  const group = shoot?.angles?.find(g => g.clips.some(c => c.clipId===span?.clipId) && g.clips.some(c => c.clipId===piece.clipId));
  const delta = group ? group.clips.find(c => c.clipId===span?.clipId)!.offsetS-group.clips.find(c => c.clipId===piece.clipId)!.offsetS : 0;
  if (span?.timeMap?.length) {
    const points = span.timeMap, right = points.findIndex(point => point.t > time);
    const a = points[Math.max(0, right < 0 ? points.length - 2 : right - 1)], b = points[right < 0 ? points.length - 1 : right];
    return delta + a.s + (b.s - a.s) * Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t || 1)));
  }
  if (span) return delta + span.inS + time - span.startS;
  if (piece.removed?.length) return null;
  return piece.s + time - start;
}

export function PiecePanel({ transformMode, onTransformMode, shoot, piece, index, time, timeline, player, busy, onEdit, onPreviewEdit, versionFx, onMatch, onBackgroundAll, angleCuts, version, onFramingAll, indexes }: {
  transformMode?: boolean; onTransformMode?: (enabled: boolean) => void;
  indexes?: number[];
  version?: import("../../../../shared/schema").CutVersion;
  onFramingAll?: (framing: import("../../../../shared/schema").FramingChoice) => Promise<unknown>;
  angleCuts?: import("../../../../shared/schema").CutVersion["angleCuts"];
  onBackgroundAll?: (background: PieceFx['background']) => Promise<void>;
  onPreviewEdit?: (edit: CutEdit) => void;
  onMatch?: () => void; versionFx?: PieceFx | null; shoot: Shoot; piece: Piece; index: number; time: number; timeline?: DraftTimeline | null;
  player: React.RefObject<StageHandle>; busy: boolean; onEdit: (edit: CutEdit) => void;
}) {
  const { go } = useNav();
  const line = /^L(\d+)A(\d+)$/i.exec(piece.id);
  const catalogTake = line ? shoot.takes.find(t => t.lineIndex === Number(line[1]) - 1)?.attempts[Number(line[2]) - 1] : undefined;
  const clip = shoot.clips.find(c => c.id === piece.clipId);
  // Q1 projects source-second words from the saved assembly. LxAy may now identify a different take.
  const timedWords = (piece as Piece & { timedWords?: Word[] }).timedWords;
  const take = catalogTake?.clipId === piece.clipId && catalogTake.s < piece.e && catalogTake.e > piece.s ? catalogTake : undefined;
  const words = (timedWords ?? (clip?.transcript ?? []).flatMap(part => part.words).filter(w =>
    w.s >= (take?.s ?? piece.s) - 1e-6 && w.e <= (take?.e ?? piece.e) + .05))
    .filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s).sort((a, b) => a.s - b.s);
  const low = Math.min(piece.s, words[0]?.s ?? take?.s ?? piece.s), high = Math.max(piece.e, words.at(-1)?.e ?? take?.e ?? piece.e);
  const extent = Math.max(.01, high - low);
  const [range, setRange] = useState({ s: piece.s, e: piece.e });
  const latestRange = useRef(range);
  useEffect(() => { latestRange.current = { s: piece.s, e: piece.e }; setRange(latestRange.current); return () => player.current?.stopPreview(); }, [piece.s, piece.e, piece.id, index, player]);
  const canTrim = !!piece.broll || words.length > 0;
  const source = pieceSourceTime(piece, time, timeline, index, shoot);
  const playableWords = words.filter(w => w.s >= piece.s - 1e-6 && w.e <= piece.e + 1e-6
    && !piece.removed?.some(f => f.kind !== "pause" && w.s >= f.s && w.e <= f.e));
  const gaps = playableWords.slice(0, -1).flatMap((word, i) => {
    const next = playableWords[i + 1], at = (word.e + next.s) / 2;
    return next.s >= word.e && !playableWords.some(w => w.s < at && w.e > at) ? [at] : [];
  });
  const splitAt = source === null ? null : piece.broll ? (source > piece.s && source < piece.e ? source : null) : gaps.length ? gaps.reduce((best, at) => Math.abs(source - at) < Math.abs(source - best) ? at : best) : null;
  const audition = (s = range.s, e = range.e) => { if (clip?.proxy) player.current?.preview(proxySrc(shoot.root, clip.proxy), s, e); };
  function trim(value: number, edge: "s" | "e") {
    const choices = words.map(w => edge === "s" ? w.s : w.e).filter(at => edge === "s" ? at < range.e : at > range.s);
    const snapped = piece.broll || !choices.length ? value : choices.reduce((best, at) => Math.abs(value - at) < Math.abs(value - best) ? at : best);
    const next = { ...range, [edge]: snapped };
    if (next.s >= next.e) return;
    latestRange.current = next; setRange(next); if(onPreviewEdit)onPreviewEdit({kind:"trim",piece:index,...next});else audition(next.s, next.e);
  }
  const contextTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  function stopContext() { contextTimers.current.forEach(clearTimeout); contextTimers.current = []; }
  useEffect(() => () => { stopContext(); player.current?.stopPreview(); }, [index, player]);
  function previewInContext(clipId: string, s: number, e: number) {
    stopContext();
    const alternative = shoot.clips.find(clip => clip.id === clipId);
    if (!alternative?.proxy) return;
    const start = piece.timelineS ?? 0, end = start + (piece.lengthS ?? piece.e - piece.s), lead = Math.min(1, start);
    player.current?.stopPreview(); player.current?.seek(start - lead); player.current?.play?.();
    contextTimers.current.push(setTimeout(() => { player.current?.preview(proxySrc(shoot.root, alternative.proxy!), s, e); }, lead * 1000));
    contextTimers.current.push(setTimeout(() => {
      player.current?.stopPreview(); player.current?.seek(end); player.current?.play?.();
      contextTimers.current.push(setTimeout(() => player.current?.pause?.(), Math.min(1, Math.max(0, (timeline?.durationS ?? end) - end)) * 1000));
    }, (lead + e - s) * 1000));
  }
  const committedTrim = useRef(JSON.stringify({ s: piece.s, e: piece.e }));
  async function commitTrim(next = latestRange.current) {
    const signature = JSON.stringify(next);
    if (busy || !canTrim || signature === committedTrim.current) return;
    const before = committedTrim.current; committedTrim.current = signature;
    try { await onEdit({ kind: "trim", piece: index, ...next }); }
    catch { committedTrim.current = before; latestRange.current = { s: piece.s, e: piece.e }; setRange(latestRange.current); }
  }
  const savedFx = (versionFx ?? null);
  const [fx, setFx] = useState<PieceFx>(savedFx ?? {});
  function stageSound(next:PieceFx) {
    setFx(next);
    if(timeline?.liveSound)previewLiveSound(timeline,{pieces:timeline.liveSound.pieces.map(p=>p.piece!==index ? p : {...p,gainDb:clipLaneDb(version ?? {},p.layer===1 ? next.overlaySound?.gainDb ?? 0 : next.gainDb ?? 0),muted:!!version?.clipSoundMuted || (p.layer===1 ? (next.overlaySound?.muted ?? !version?.clipSoundDefaultOn) : !!next.reverse || (next.muted ?? defaultClipMuted(version ?? {},!!piece.broll)))})});
  }
  const committedFx = useRef(JSON.stringify(savedFx ?? {}));
  const committingFx = useRef(false);
  useEffect(() => { setFx(savedFx ?? {}); committedFx.current = JSON.stringify(savedFx ?? {}); }, [JSON.stringify(savedFx), index]);
  async function commitFx(next = fx, reportError = false) {
    const signature = JSON.stringify(next);
    if (busy || committingFx.current || signature === committedFx.current) return;
    const before = committedFx.current;
    committedFx.current = signature; committingFx.current = true;
    try {
      const result: unknown = await onEdit({ kind: "pieceFx", piece: index, fx: Object.keys(next).length ? next : null });
      if (reportError && result === undefined) throw new Error("Couldn't change the background. Try again.");
    }
    catch (error) { committedFx.current = before; setFx(savedFx ?? {}); if (reportError) throw error; }
    finally { committingFx.current = false; }
  }
  const reverseTasks = useActivity({ root: shoot.root, target: { clipId: piece.clipId } }).filter(task => task.label === "Reversing clip");
  const reverseSpans = timeline?.pieces.filter(span => span.layer === 0 && span.piece === index) ?? [];
  const reverseReady = reverseSpans.length > 0 && reverseSpans.every(span => span.proxy.includes("/reverse-"));
  const reverseFailure = !reverseReady && reverseTasks[0]?.state === "failed" ? reverseTasks[0].note : null;
  const [batchError, setBatchError] = useState<string | null>(null), [batchBusy, setBatchBusy] = useState(false);
  const batchPending = useRef(false);
  const dirty = JSON.stringify(range) !== committedTrim.current;
  return <div className="space-y-3 text-[12px]" aria-label="Piece controls">
    {clip?.missing ? <p data-missing-piece className="rounded-md bg-ground/60 px-3 py-2 text-muted">Missing</p> : null}
    {piece.broll && version ? <button type="button" disabled={busy} onClick={() => window.dispatchEvent(new CustomEvent("sidething:browse-media", { detail: { root: shoot.root, piece: index } }))} className="w-full rounded-lg bg-ink/[0.06] px-3 py-2 text-left outline-none hover:bg-ink/[0.1] focus-visible:bg-ink/[0.1]">Replace</button> : null}
    {!piece.broll ? <ClipTakes shoot={shoot} piece={piece} index={index} busy={busy} onEdit={onEdit} player={player} onPreviewInContext={previewInContext} /> : null}
    {version ? <TransformPanel viewer={transformMode} onViewer={onTransformMode} version={version} index={index} indexes={indexes} timeline={timeline} busy={busy} onEdit={onEdit} /> : null}
    {version && clip && !clip.missing && (indexes?.length ?? 0) <= 1 ? <LockGroup version={version} index={index} timeline={timeline} busy={busy} /> : null}
    <AngleControls shoot={shoot} piece={piece} index={index} time={time} timeline={timeline} cuts={angleCuts} busy={busy} onEdit={onEdit} />
    <section aria-label="Trim piece" className="space-y-2">
      <p className="text-[11px] text-muted">Move where it starts and ends. Voice trims snap to words.</p>
      <Row><SectionHeader as="h4" className="font-medium">Trim</SectionHeader><button type="button" aria-label="Preview trimmed piece" disabled={busy || !clip?.proxy} onClick={() => audition()} className={`flex items-center gap-1 text-micro text-muted disabled:opacity-40 ${FOCUS}`}><Play size={12} />Preview</button></Row>
      <div className="relative h-24 overflow-hidden rounded-xl bg-ink/[0.06]" data-piece-filmstrip>
        <div className="absolute inset-0 flex opacity-70">{Array.from({ length: 5 }, (_, i) => {
          const poster = frameAt(shoot, piece.clipId, low + (high - low) * i / 5);
          return poster ? <img key={i} src={poster} alt="" className="h-full w-1/5 object-cover" /> : <span key={i} className="h-full w-1/5 bg-ink/[0.06]" />;
        })}</div>
        <div className="pointer-events-none absolute inset-y-0 bg-ground/70" style={{ left: 0, width: `${Math.max(0, (range.s - low) / extent) * 100}%` }} />
        <div className="pointer-events-none absolute inset-y-0 bg-ground/70" style={{ right: 0, width: `${Math.max(0, (high - range.e) / extent) * 100}%` }} />
        <div className="absolute inset-x-2 top-1"><Slider compact label="Piece in point" min={low} max={high} defaultValue={piece.s} step={.01} unit="s" value={Math.max(low, range.s)} disabled={busy || !canTrim} onChange={value => trim(value, "s")} onRelease={() => void commitTrim()} /></div>
        <div className="absolute inset-x-2 bottom-1"><Slider compact label="Piece out point" min={low} max={high} defaultValue={piece.e} step={.01} unit="s" value={Math.min(high, range.e)} disabled={busy || !canTrim} onChange={value => trim(value, "e")} onRelease={() => void commitTrim()} /></div>
      </div>
      <p className="text-small leading-relaxed" aria-label="Take words">{words.length ? words.map((word, i) => <span key={i} className={word.s >= range.s - 1e-6 && word.e <= range.e + 1e-6 ? "text-ink" : "text-muted opacity-40"}>{word.w.trim()} </span>) : piece.words}</p>
      {!canTrim ? <p className="text-micro text-muted">Word timings are needed to trim this take safely.</p> : null}
      <div className="flex gap-2"><Button variant="primary" disabled={busy || !dirty || !canTrim} onClick={() => void commitTrim()}>Apply trim</Button>{dirty ? <Button variant="ghost" disabled={busy} onClick={() => { latestRange.current = { s: piece.s, e: piece.e }; setRange(latestRange.current); player.current?.stopPreview(); }}>Revert</Button> : null}</div>
    </section>
    <section className="space-y-2"><p className="text-[11px] text-muted">Cut it in two at the playhead.</p><button type="button" title="Split at playhead (S)" disabled={busy || splitAt === null || dirty} onClick={() => { if (splitAt !== null) onEdit({ kind: "split", piece: index, at: splitAt }); }} className={`flex items-center gap-2 rounded-lg bg-ink/[0.06] px-3 py-2 disabled:opacity-40 ${FOCUS}`}><Split size={16} />Split at playhead</button><p className="text-micro text-muted">{dirty ? "Apply or revert the trim before splitting." : source === null ? "Seek within this piece to split it." : splitAt === null ? "This piece needs two complete words to split." : `Snaps between words at ${formatDuration(splitAt)}.`}</p></section>
    {usesPractice(shoot, piece) && <p className="text-micro text-muted">This is a practice take. Choose another take above.</p>}
    <section aria-label="Clip settings" className="space-y-4" data-control="clip-settings">
      <p className="text-[11px] text-muted">Faster or slower; voice keeps its pitch. Click the number to type.</p>
      <Slider label="Speed" aria-label="Clip speed" data-control="clip-speed" min={.1} max={10} rangeMin={.1} rangeMax={10} detent={1} defaultValue={1} step={.01} unit="x" value={fx.speed ?? 1} disabled={busy}
        onChange={speed => { setFx(previous => ({ ...previous, speed })); onPreviewEdit?.({kind:"pieceFx",piece:index,fx:{...fx,speed}}); }} onRelease={speed => void commitFx({ ...fx, speed })} />
      <PunchControls fx={fx} index={index} time={time} timeline={timeline} busy={busy} onPreview={next => onPreviewEdit?.({ kind: "pieceFx", piece: index, fx: next })} onCommit={next => { setFx(next); void commitFx(next); }} />
      {piece.broll ? <div className="space-y-2">
        <p className="text-[11px] text-muted">Plays backwards; its own sound is muted.</p>
        <Row as="label" className="flex items-center justify-between gap-3 text-small">Reverse<Switch aria-label="Reverse" checked={fx.reverse ?? false} data-control="clip-reverse" disabled={busy}
          onChange={() => { const next = { ...fx, reverse: !fx.reverse }; setFx(next); void commitFx(next); }} /></Row>
      </div> : null}
      {savedFx?.reverse && !reverseReady ? <p role="status" className="text-micro text-muted">{reverseFailure ? `${reverseFailure} Playing forwards. Try Reverse again shortly.` : "Reversing…"}</p> : null}
      {savedFx?.reverse && !piece.broll ? <p className="text-micro text-muted">The words in this clip will be silent.</p> : null}
      <p className="text-[11px] text-muted">Steady the camera or lock on your face.</p>
      <fieldset disabled={busy || batchBusy} data-control="framing" className="space-y-2">
        <FramingControls inherit value={fx.framing} onTightChange={framing => setFx(previous => ({ ...previous, framing }))} onRelease={framing => void commitFx({ ...fx, framing })} onChange={framing => { const next = { ...fx }; if (framing) next.framing = framing; else delete next.framing; setFx(next); void commitFx(next); }} />
        {onFramingAll ? <Button aria-label="Use framing for all clips" disabled={busy || batchBusy} onClick={async () => {
          if (busy || batchPending.current) return;
          batchPending.current = true; setBatchBusy(true); setBatchError(null);
          try { await onFramingAll(fx.framing ?? version?.framing ?? { mode: "off" }); }
          catch (error) { setBatchError(error instanceof Error ? error.message : "Couldn't change framing."); }
          finally { batchPending.current = false; setBatchBusy(false); }
        }}>Use for all clips</Button> : null}
      </fieldset>
      {version ? <LayoutPanel shoot={shoot} version={version} index={index} time={time} timeline={timeline} aspect={timeline ? timeline.width/timeline.height : undefined} busy={busy} onEdit={onEdit} onSeek={t=>player.current?.seek(t)} /> : null}
      {batchError ? <InlineError>{batchError}</InlineError> : null}
      <BackgroundControls value={fx.background} busy={busy} onChange={background => setFx(previous => ({ ...previous, background }))}
        onAll={onBackgroundAll} onCommit={async background => { const next = { ...fx, background }; setFx(next); await commitFx(next, true); }} />
      <p className="font-semibold">This clip's sound</p>
      <Row as="label">Mute<Switch aria-label="Mute this clip's sound" checked={fx.muted ?? defaultClipMuted(version ?? {},!!piece.broll)} disabled={busy} onChange={event=>{const next={...fx,muted:event.target.checked};stageSound(next);void commitFx(next);}} /></Row>
      <ClipSoundCleaning value={fx.clean} disabled={busy} onChange={clean=>onEdit({kind:"clipSound",piece:index,clean})} />
      {version?.clipSoundMuted && <p className="text-micro text-muted">Clip sound track is muted.</p>}
      <Slider label="Volume" aria-label="Clip volume" data-control="clip-gainDb" min={-12} max={12} defaultValue={0} step={.5} unit=" dB" value={fx.gainDb ?? 0} disabled={busy}
        onChange={gainDb => stageSound({...fx,gainDb})} onRelease={gainDb => void commitFx({ ...fx, gainDb })} />
      {version?.pieces?.[index]?.overlay && <section className="space-y-2"><p className="font-semibold">B-roll sound</p><ClipSoundCleaning value={fx.overlaySound?.clean} disabled={busy} onChange={clean=>onEdit({kind:"clipSound",piece:index,layer:1,clean})} /><Row as="label">Mute<Switch aria-label="Mute attached b-roll sound" checked={fx.overlaySound?.muted ?? !version?.clipSoundDefaultOn} disabled={busy} onChange={event=>void commitFx({...fx,overlaySound:{...fx.overlaySound,muted:event.target.checked}})} /></Row><Slider label="B-roll volume" min={-12} max={12} step={.5} unit=" dB" value={fx.overlaySound?.gainDb ?? 0} onChange={gainDb=>stageSound({...fx,overlaySound:{...fx.overlaySound,gainDb}})} onRelease={gainDb=>void commitFx({...fx,overlaySound:{...fx.overlaySound,gainDb}})} /></section>}
      {onMatch ? <Button disabled={busy} onClick={onMatch}>Match others to this clip</Button> : null}
    </section>
    <p className="text-[11px] text-muted">Look, captions and sound for just this clip: open them while it's selected.</p>
    <p className="text-[11px] text-muted">Remove this clip from the edit. Your footage stays in the shoot.</p>
    <button type="button" title="Remove from edit (Delete)" disabled={busy} onClick={() => onEdit({ kind: "remove", piece: index })} className={`flex items-center gap-2 rounded-lg px-1 py-2 text-danger disabled:opacity-40 ${FOCUS}`}><Delete size={16} />Remove from edit</button>
    {piece.removed?.length ? <section className="space-y-2"><SectionHeader as="h4" className="font-medium">Fillers removed</SectionHeader>{piece.removed.map(filler => <Row key={`${filler.s}-${filler.e}`} className="flex items-center justify-between gap-2 rounded-lg bg-ink/[0.04] px-2 py-2"><s className="text-micro text-muted">{filler.text || (filler.kind === "pause" ? "pause" : "filler")} · {formatDuration(filler.s)}</s><button type="button" disabled={busy} onClick={() => onEdit({ kind: "keepFiller", piece: index, at: filler.s })} className={`text-micro font-medium disabled:opacity-40 ${FOCUS}`}>Put back</button></Row>)}</section> : null}
    <button type="button" onClick={() => { player.current?.stopPreview(); go("clips", line ? { shoot: shoot.root, tab: "takes", line: line[1] } : { shoot: shoot.root, clip: piece.clipId, t: String(piece.s) }); }} className={`flex items-center gap-1 py-2 text-micro text-muted ${FOCUS}`}>Show in Footage</button>
  </div>;
}

/** Only measured, ready angles covering the playhead are offered. */
export function AngleControls({shoot,piece,index,time,timeline,cuts,busy,onEdit}: {
  shoot:Shoot;piece:Piece;index:number;time:number;timeline?:DraftTimeline|null;cuts?:import("../../../../shared/schema").CutVersion["angleCuts"];busy:boolean;onEdit:(edit:CutEdit)=>void;
}) {
  const [error,setError] = useState<string|null>(null);
  const pending = useRef(false);
  const group = shoot.angles?.find(g => g.clips.some(c => c.clipId===piece.clipId));
  const span = timeline?.pieces.find(p => p.layer===0 && p.piece===index && time>=p.startS && time<p.endS);
  if (!group || !span) return null;
  const current = group.clips.find(c => c.clipId===span.clipId);
  if (!current) return null;
  const map = span.timeMap, right = map?.findIndex(k => k.t>=time) ?? -1;
  const a = map?.[Math.max(0,right-1)], b = map?.[right<0 ? map.length-1 : right];
  const source = a && b ? a.s+(b.s-a.s)*(time-a.t)/(b.t-a.t || 1) : span.inS+time-span.startS;
  const options = group.clips.flatMap(entry => {
    const clip = shoot.clips.find(c => c.id===entry.clipId), at = source+current.offsetS-entry.offsetS;
    return clip?.proxy && clip.meta && at>=0 && at<clip.meta.durationS ? [{entry,clip,at}] : [];
  });
  if (options.length<2) return null;
  return <section aria-label="Angle" className="space-y-2">
    <SectionHeader as="h4">Angle</SectionHeader><p className="text-[11px] text-muted">Switch picture here. Sound stays continuous.</p>
    <div className="grid grid-cols-2 gap-2">{options.map(({entry,clip,at}) => {
      const selected = span.clipId===clip.id, poster = takeThumbnail(shoot,{clip,s:at}) ?? frameAt(shoot,clip.id,at);
      return <Tile key={clip.id} type="button" aria-label={`Switch to ${clip.id} here`} aria-pressed={selected} disabled={busy} className={`overflow-hidden rounded-lg text-left ${selected ? 'bg-[var(--selection-fill)]' : 'bg-ink/[0.04]'} ${FOCUS}`}
        onClick={async() => {
          if (busy || selected || pending.current) return;
          pending.current=true;setError(null);
          const atS = Math.round(time*(timeline?.fps ?? 25))/(timeline?.fps ?? 25);
          try { await onEdit({kind:'angles',cuts:[...(cuts ?? []).filter(c => Math.abs(c.atS-atS)>1e-6),{atS,clipId:clip.id}].sort((a,b) => a.atS-b.atS)}); }
          catch(e) {setError(e instanceof Error ? e.message : "Couldn't change camera angles.");}
          finally {pending.current=false;}
        }}>
        <span className="block aspect-video bg-ink/[0.06]">{poster ? <img src={poster} alt="" className="size-full object-cover"/> : null}</span>
        <span className="block truncate px-2 py-1 text-[11px]">{entry.kind==='screen' ? 'Screen' : clip.id}{selected ? ' · In use' : ''}</span>
      </Tile>;
    })}</div>
    {cuts?.length ? <button type="button" disabled={busy} onClick={() => onEdit({kind:'angles',cuts:null})} className={`text-[11px] text-muted ${FOCUS}`}>Use automatic angles</button> : null}
    {error ? <InlineError>{error}</InlineError> : null}
  </section>;
}
