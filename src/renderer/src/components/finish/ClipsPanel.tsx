import { mediaLabel } from "./mediaLabel";
import { clipName as shotName } from "../../../../shared/clip-name";
import { RotatingImage } from "../RotatingImage";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LowerThirdEditor } from "./LowerThirdEditor";
import { previewOverlay, addOverlayFiles, selectOverlay, useOverlaySession } from "../OverlayHandles";
import { addLibraryItem, LIBRARY_DRAG_TYPE, overlayName, shootLibrary } from "./library";
import type { CutEdit, CutVersion, DraftTimeline, OverlayItem, Shoot } from "../../../../shared/schema";
import { formatDuration, frameAt, getApi } from "../../data";
import { useShortcuts } from "../../hooks/useShortcuts";
import { storyboard, type Piece } from "../edits/model";
import { ChevronLeft, ChevronRight, Plus, Image, Delete } from "../icons";
import { Button, FOCUS, InlineError, NumberField, SectionHeader, Row, Tile, Slider } from "../ui";
import { PiecePanel } from "./PiecePanel";
import { takeThumbnail } from "../footage/thumbnail";
import { AddGraphic, GraphicDesign, graphicName } from "./GraphicControls";
import type { MotionSource } from "./MotionControls";
import { LAYOUTS, migrateLayouts } from "../../../../shared/layout-presets";

/** Folder names remain as named on disk; a single-folder shoot has no headings. */
export function folderGroups<T>(items: T[], fileOf: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const folder = (fileOf(item) ?? "").split(/[\\/]/).slice(0, -1).join(" / ");
    const group = groups.get(folder) ?? [];
    group.push(item); groups.set(folder, group);
  }
  return [...groups].map(([folder, items]) => ({ folder: groups.size > 1 ? folder || "Shoot folder" : null, items }));
}

export function clipThumbnail(shoot: Shoot, clipId: string, s: number): string | null {
  const clip = shoot.clips.find(entry => entry.id === clipId);
  return clip ? takeThumbnail(shoot, { clip, s }) ?? frameAt(shoot, clipId, s) : null;
}

export function clipTag(shoot: Shoot, piece: Piece): "Keep" | "Maybe" | "B-roll" | null {
  if (piece.broll) return "B-roll";
  const verdict = shoot.clips.find(clip => clip.id === piece.clipId)?.judgement?.verdict;
  return verdict === "best" || verdict === "alt" ? "Keep" : verdict === "maybe" ? "Maybe" : null;
}
const clipName = (shoot: Shoot, piece: Piece) => shotName(shoot.clips.find(c => c.id === piece.clipId), piece);

export function clipSpan(start: number, length: number): string {
  const ticks = Math.round(start * 10);
  const from = length < 10 ? `${Math.floor(ticks / 600)}:${String(Math.floor(ticks / 10) % 60).padStart(2, "0")}.${ticks % 10}` : formatDuration(start);
  return `${length.toFixed(1)} s, from ${from}`;
}

/** Only cached stills here: take auditions share the stage's existing player. */
export function ClipsPanel({ shoot, version, onSelect, onAdd, onAddAt, layout, ...media }: {
  shoot: Shoot; version: CutVersion; onSelect: (index: number) => void; onAdd?: () => void; onAddAt?: (index: number) => void;
  /** RAIL1: the whole-edit layout and auto layouts, opened in place (the Layout panel's old home was the rail). */
  layout?: { open: boolean; onToggle: () => void; aspect?: number; panel: React.ReactNode };
} & Omit<AddMoreProps, "shoot" | "version">) {
  const { pieces } = storyboard(shoot, version);
  const files = new Map(shoot.clips.map(clip => [clip.id, clip.file]));
  const groups = folderGroups(pieces.map((piece, index) => ({ piece, index })), item => files.get(item.piece.clipId) ?? "");
  const add = () => { onAdd?.(); window.dispatchEvent(new CustomEvent("sidething:browse-media", { detail: { root: shoot.root } })); };
  return <div aria-label="Media grid" className="space-y-2.5 pt-2">
    <SectionHeader as="h3" className="font-semibold">In this edit</SectionHeader>
    {(version.layouts ?? []).map((layout,index) => layout?.kind === 'placeholder' ? <Row key={`shot-${index}`} className="gap-2 rounded-lg bg-ink/[0.04] p-2"><span className="min-w-0 text-[12px]">Shot needed: {layout.note}</span><button type="button" className={`shrink-0 text-[12px] text-accent ${FOCUS}`} onClick={() => {onAddAt?.(index);add();}}>Add a shot</button></Row> : null)}
    <Row className="gap-2"><span className="text-[12px] text-muted">{pieces.length} {pieces.length === 1 ? "clip" : "clips"} in this edit</span><button type="button" onClick={add} title="Browse footage" className={`flex items-center gap-1 text-[12px] text-accent ${FOCUS}`}><Plus size={12} />Add clip</button></Row>
    <div className="grid grid-cols-3 gap-2.5">{groups.map((group, groupIndex) => <Fragment key={groupIndex}>
      {group.folder !== null ? <SectionHeader as="h4" data-media-folder className="col-span-3 pt-2 text-[12px] font-medium text-muted">{group.folder}</SectionHeader> : null}
      {group.items.map(({ piece, index }) => {
      const poster = clipThumbnail(shoot, piece.clipId, piece.s), tag = clipTag(shoot, piece), missing = shoot.clips.some(c => c.id === piece.clipId && c.missing);
      return <button key={`${index}-${piece.id}`} type="button" data-clip-menu={piece.clipId} data-clip-tile={index} aria-label={clipName(shoot, piece)} onClick={() => onSelect(index)} className={`flex min-w-0 flex-col gap-[5px] text-left ${FOCUS}`}>
        <span className="relative block aspect-[3/4] w-full overflow-hidden rounded-[10px] bg-ink/[0.06]">{poster ? <RotatingImage root={shoot.root} clip={shoot.clips.find(c => c.id === piece.clipId)} src={poster} alt="" loading="lazy" className="size-full object-cover" /> : null}{missing ? <span data-missing-piece className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ground/60 text-micro text-muted"><span className="rounded-md bg-surface px-2 py-1">Missing</span></span> : null}<span className="st-media-chip absolute left-1 top-1 rounded px-1 text-[10px] font-semibold">{formatDuration(piece.timelineS ?? 0)}</span><span className="st-media-chip absolute bottom-1 right-1 rounded px-1 text-[10px]">{formatDuration(piece.lengthS ?? piece.e - piece.s)}</span></span>
        <span className="w-full truncate text-[12px] font-semibold" title={clipName(shoot, piece)}>{clipName(shoot, piece)}</span>
        {tag ? <span className={`self-start rounded-lg px-2 text-[11px] ${tag === "Keep" ? "bg-[var(--badge-lime-fill)] text-[var(--badge-lime-ink)]" : tag === "Maybe" ? "bg-[var(--badge-amber-fill)] text-[var(--badge-amber-ink)]" : "bg-ink/[0.06] text-muted"}`}>{tag}</span> : null}
      </button>;
    })}</Fragment>)}<button type="button" aria-label="Add clip" title="Browse footage" onClick={add} className={`flex aspect-[3/4] items-center justify-center rounded-[10px] bg-ink/[0.04] text-muted hover:bg-ink/[0.08] ${FOCUS}`}><Plus size={22} /></button></div>
    <p className="text-[11px] text-muted">Click a clip to trim, swap the take, change speed, framing or layout.</p>
    {layout ? <WholeLayout version={version} {...layout} /> : null}
    <section data-control="overlays" aria-label="Add more" className="space-y-2 pt-4"><SectionHeader as="h3" className="font-semibold">Add more</SectionHeader><AddMore {...media} shoot={shoot} version={version} onBrowse={add} /></section>
  </div>;
}

/** RAIL1: one row, like Export's cover line: what the edit's layout is now, and Change opens the whole Layout controls here. */
function WholeLayout({ version, open, onToggle, aspect, panel }: { version: CutVersion } & NonNullable<React.ComponentProps<typeof ClipsPanel>["layout"]>) {
  const scenes = migrateLayouts(version, aspect).filter(entry => entry.kind === "scene");
  const names = [...new Set(scenes.map(entry => LAYOUTS.find(([id]) => id === entry.id)?.[1]).filter(Boolean))];
  const line = !scenes.length ? "Camera only" : scenes.length === 1 ? names[0] ?? "1 layout" : `${scenes.length} layouts`;
  return <section data-whole-layout aria-label="Layout for the whole edit" className="space-y-2 pt-4">
    <Row className="gap-2"><SectionHeader as="h3" className="font-semibold">Layout</SectionHeader><span className="min-w-0 flex-1 truncate text-[12px] text-muted">{line}{version.autoLayouts?.enabled ? " · auto layouts on" : ""}</span>
      <Button aria-expanded={open} aria-label={open ? "Done with layout" : "Change layout"} onClick={onToggle}>{open ? "Done" : "Change"}</Button></Row>
    {open ? panel : null}
  </section>;
}

export function ClipPanel({ shoot, version, index, onSelect, onBack, ...controls }: {
  shoot: Shoot; version: CutVersion; index: number; onSelect: (index: number) => void; onBack: () => void;
} & Omit<React.ComponentProps<typeof PiecePanel>, "shoot" | "piece" | "index" | "versionFx">) {
  const { pieces } = storyboard(shoot, version), piece = pieces[index];
  const step = (direction: -1 | 1) => { const next = index + direction; if (next >= 0 && next < pieces.length) onSelect(next); };
  useShortcuts("precuts", [
    { id: "clip-previous", keys: ["["], label: "Previous clip", scope: "precuts", enabled: index > 0, handler: () => step(-1) },
    { id: "clip-next", keys: ["]"], label: "Next clip", scope: "precuts", enabled: index < pieces.length - 1, handler: () => step(1) },
  ]);
  if (!piece) return null;
  const poster = clipThumbnail(shoot, piece.clipId, piece.s);
  const start = piece.timelineS ?? pieces.slice(0, index).reduce((sum, p) => sum + (p.lengthS ?? p.e - p.s), 0);
  return <div aria-label="Clip panel" data-control="piece" className="min-w-0">
    <div data-clip-preview className="sticky top-0 z-30 flex items-center gap-3 bg-surface pb-2.5 pt-2">
      <div className="relative h-[150px] w-[84px] shrink-0 overflow-hidden rounded-lg bg-ink/[0.06]">{poster ? <RotatingImage root={shoot.root} clip={shoot.clips.find(c => c.id === piece.clipId)} src={poster} alt={clipName(shoot, piece)} className="size-full object-cover" /> : null}<span className="st-media-chip absolute bottom-1 left-1 rounded px-1 text-[10px]">{formatDuration(start)}</span></div>
      <div className="flex min-w-0 flex-col gap-1.5"><button type="button" onClick={onBack} className={`self-start text-[15px] font-semibold text-accent ${FOCUS}`}>‹ Clips</button><p className="line-clamp-2 text-[13px] font-semibold">{clipName(shoot, piece)}</p><p className="text-[11px] text-muted">{clipSpan(start, piece.lengthS ?? piece.e - piece.s)}</p><div className="flex gap-1"><button type="button" aria-label="Previous clip" title="Previous clip ([)" disabled={index === 0} onClick={() => step(-1)} className={`flex h-7 w-8 items-center justify-center rounded-lg bg-ink/[0.06] disabled:opacity-40 ${FOCUS}`}><ChevronLeft size={16} /></button><button type="button" aria-label="Next clip" title="Next clip (])" disabled={index === pieces.length - 1} onClick={() => step(1)} className={`flex h-7 w-8 items-center justify-center rounded-lg bg-ink/[0.06] disabled:opacity-40 ${FOCUS}`}><ChevronRight size={16} /></button></div></div>
    </div>
    <PiecePanel key={`${version.version}-${index}`} {...controls} shoot={shoot} piece={piece} index={index} version={version} versionFx={version.pieceFx?.[index]} angleCuts={version.angleCuts}
      onFramingAll={async framing => { const result: unknown = await controls.onEdit({ kind: "batch", label: "Framing on all clips",
        edits: pieces.map((_, piece) => ({ kind: "pieceFx", piece, fx: { ...version.pieceFx?.[piece], framing } })) });
        if (result === undefined || result === false) throw new Error("Couldn't change framing. Try again."); }}
      onBackgroundAll={async background => { const result: unknown = await controls.onEdit({ kind: "batch", label: `Background ${background?.mode ?? "off"} on all clips`,
        edits: pieces.map((_, piece) => ({ kind: "pieceFx", piece, fx: { ...version.pieceFx?.[piece], background } })) });
        if (result === undefined) throw new Error("Couldn't change the backgrounds. Try again."); }} />
  </div>;
}

// MOT1b: where the panel was scrolled for the selected overlay. An edit can redraw the whole panel (a new version, the
// inspector opened again for the same item), so the place is kept here and put back while the same item stays selected.
const panelPlace = { id: null as string | null, top: 0 };
const scrollerOf = (node: HTMLElement | null) => { let e = node?.parentElement ?? null; while (e && !/(auto|scroll)/.test(getComputedStyle(e).overflowY)) e = e.parentElement; return e; };
type AddMoreProps = { shoot: Shoot; version: CutVersion; timeline?: DraftTimeline | null; time?: number; busy?: boolean; onEdit?: (edit: CutEdit) => unknown; selectedOnly?: boolean; onBrowse?: () => void };
export function AddMore({ shoot, version, timeline, time = 0, busy, onEdit, selectedOnly = false, onBrowse }: AddMoreProps) {
  const session = useOverlaySession(timeline);
  // MOT1b: an edit keeps the panel's place. A new version's overlay session is set up a render after its timeline
  // arrives (and the timeline can be absent while it reloads); through that gap the item that was selected stays
  // selected, so its settings stay mounted and the panel keeps its scroll position instead of jumping to the top.
  const kept = useRef<NonNullable<DraftTimeline["overlays"]>[number] | null>(null);
  const live = session ? timeline?.overlays?.find(item => item.id === session.selected) : undefined;
  const selected = session ? live : kept.current ? timeline ? timeline.overlays?.find(item => item.id === kept.current!.id) : kept.current : undefined;
  if (session) kept.current = live ?? null;
  // ...and its edits still go through: the session's edit is the editor's own (OverlayHandles keeps the latest).
  const keptSession = useRef(session); if (session) keptSession.current = session;
  const editor = session ?? (selected ? keptSession.current : undefined), lastDuration = useRef(0); if (timeline) lastDuration.current = timeline.durationS;
  const [error, setError] = useState<string | null>(null), [working, setWorking] = useState(false);
  const [addingText, setAddingText] = useState(false);
  const pending = useRef(false);
  const locked = busy || session?.busy || working;
  async function run(work: () => Promise<unknown>) {
    if (locked || pending.current) return;
    pending.current = true; setWorking(true); setError(null);
    try { await work(); return true; } catch (e) { setError(e instanceof Error ? e.message : "Couldn't add that media."); return false; }
    finally { pending.current = false; setWorking(false); }
  }
  const media = shootLibrary(shoot), place = useRef<HTMLDivElement>(null), selectedId = selected?.id ?? null;
  useLayoutEffect(() => {
    const box = scrollerOf(place.current);
    if (!box || !selectedId) return;
    if (panelPlace.id === selectedId && Math.abs(box.scrollTop - panelPlace.top) > 1) box.scrollTop = panelPlace.top;
    // a scroll caused by the panel briefly being too short to hold the place (a redraw) is not a move: keep the place
    const save = () => { if (panelPlace.id === selectedId && box.scrollTop < panelPlace.top && box.scrollHeight - box.clientHeight < panelPlace.top - 1) return; panelPlace.id = selectedId; panelPlace.top = box.scrollTop; };
    box.addEventListener("scroll", save, { passive: true });
    return () => box.removeEventListener("scroll", save);
  }, [selectedId, timeline, selected]);
  return <div ref={place} aria-label="Media to add" className="space-y-3 pt-2" onDragOver={event => {
    if (!locked && session && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  }} onDrop={event => {
    if (!session || locked || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault(); event.stopPropagation();
    const paths = Array.from(event.dataTransfer.files).map(file => getApi().pathForFile(file)).filter(Boolean);
    if (!paths.length) { setError("Drop images in the desktop app, or use Add files."); return; }
    void run(() => addOverlayFiles(session, paths, time));
  }}>
    {selected ? <><button type="button" onClick={() => editor && selectOverlay(editor, "")} className={`text-[15px] font-semibold text-accent ${FOCUS}`}>‹ Add more</button><OverlaySettings onPreview={item=>editor && previewOverlay(editor,item)} key={selected.id} item={selected} motion={timeline ? { titles: timeline.titles, captionSource: timeline.captionSource, beats: timeline.musicGrid?.beats ?? timeline.musicBeatsS, fps: timeline.fps } : null} duration={timeline?.durationS ?? lastDuration.current} busy={!!locked} onEdit={async change => editor ? run(() => Promise.resolve(editor.edit(change))) : false} /></> : <>
      {/* RAIL1: the footage browser (BUG1's Recently added, Matches and search) opens here, in Clips. */}
      {onBrowse ? <div data-browse-footage className="space-y-1.5"><Row className="gap-2"><SectionHeader as="h3" className="font-semibold">From this shoot</SectionHeader><span className="text-[11px] text-muted">Recently added, matches and search</span></Row><Button variant="primary" onClick={onBrowse}>Browse footage</Button></div> : null}
      <Row className="gap-2"><SectionHeader as="h3" className="font-semibold">On this edit</SectionHeader><Button variant="primary" disabled={!session || locked} onClick={() => session && void run(async () => addOverlayFiles(session, await getApi().pickOverlayFiles(), time))}><Plus size={13} />Add files</Button></Row>
      {onEdit ? <>
        <Button disabled={!!locked || !version.lengthS} onClick={() => setAddingText(true)}><Plus size={13} />Add text</Button>
        <AddGraphic time={time} duration={version.lengthS} titles={version.titles} busy={!!locked} onEdit={change => run(() => Promise.resolve(onEdit(change)))} />
        {addingText ? <LowerThirdEditor time={time} duration={version.lengthS} busy={!!locked} onEdit={change => run(() => Promise.resolve(onEdit(change)))} onClose={() => setAddingText(false)} /> : null}
        {(version.lowerThirds ?? []).map(item => <LowerThirdEditor key={`${item.id}:${version.version}`} item={item} time={time} duration={version.lengthS} busy={!!locked} onEdit={change => run(() => Promise.resolve(onEdit(change)))} />)}
      </> : null}
      {timeline?.overlays?.length ? <ul aria-label="Overlays on this edit" className="space-y-1.5">{timeline.overlays.map(item => <li key={item.id}><button type="button" aria-label={`Overlay: ${item.graphic ? graphicName(item) : overlayName(item.file)}`} disabled={!session || locked} onClick={() => session && selectOverlay(session, item.id)} className={`flex w-full items-center gap-2.5 rounded-[10px] bg-ink/[0.06] p-1.5 text-left ${FOCUS}`}><img src={item.url} alt="" className="h-[34px] w-[52px] shrink-0 rounded-md object-contain" /><span className="min-w-0"><span className="block truncate text-[12px] font-semibold">{item.graphic ? graphicName(item) : overlayName(item.file)}</span><span className="block text-[11px] text-muted">{formatDuration(item.s)} to {formatDuration(item.e)}{item.graphic ? "" : ` · ${item.enter === "slide-up" ? "Slide up" : item.enter} in · ${item.sound ?? "no"} sound`}</span></span></button></li>)}</ul> : <p className="text-[11px] text-muted">No overlays on this edit. Add a screenshot or logo.</p>}
      {onBrowse ? null : <>
      <Row className="gap-2"><SectionHeader as="h3" className="font-semibold">From this shoot</SectionHeader><span className="text-[11px] text-muted">B-roll and stills</span></Row>
      {media.length ? <div className="grid grid-cols-3 gap-1.5">{folderGroups(media, item => item.clip.file).map((group, groupIndex) => <Fragment key={groupIndex}>
        {group.folder !== null ? <SectionHeader as="h4" data-media-folder className="col-span-3 pt-2 text-[12px] font-medium text-muted">{group.folder}</SectionHeader> : null}
        {group.items.map(({ clip, still, description: rawDescription }) => {
        const description = mediaLabel(rawDescription) || (still ? "Still" : "B-roll");
        const poster = clipThumbnail(shoot, clip.id, 0);
        const available = !!onEdit && !locked && (still ? !!session : !!clip.meta?.durationS);
        return <button key={clip.id} type="button" data-clip-menu={clip.id} aria-label={`Add ${description}`} title={available ? `Add at ${formatDuration(time)}` : "Wait for this edit and media to load"} disabled={!available} draggable={available} onDragStart={event => { event.dataTransfer.setData(LIBRARY_DRAG_TYPE, clip.id); event.dataTransfer.effectAllowed = "copy"; }} onClick={() => onEdit && void run(() => addLibraryItem(shoot, version, timeline, clip.id, time, onEdit, session))} className={`flex min-w-0 flex-col gap-1 text-left disabled:opacity-50 ${FOCUS}`}>
          <span className="relative flex aspect-[9/12] w-full items-center justify-center overflow-hidden rounded-lg bg-ink/[0.06]">{poster ? <RotatingImage root={shoot.root} clip={clip} src={poster} alt="" loading="lazy" className="size-full object-cover" /> : <Image size={20} className="text-muted" />}<span className="st-media-chip absolute bottom-1 right-1 rounded px-1 text-[10px]">{still ? "Still" : formatDuration(clip.meta?.durationS ?? 0)}</span></span><span className="line-clamp-2 text-[11px] leading-tight">{description}</span>
        </button>;
      })}</Fragment>)}</div> : <p className="text-[11px] text-muted">No B-roll or stills in this shoot.</p>}
      <p className="text-[11px] text-muted">Click to add at the playhead, or drag onto the timeline. Drop images here or on the video.</p>
      </>}
    </>}
    {selectedOnly && !selected ? <p className="text-[11px] text-muted">Select an overlay to change its settings.</p> : null}
    {error ? <InlineError>{error}</InlineError> : null}
  </div>;
}

export function OverlaySettings({ item, duration, busy, onEdit, onPreview, motion }: { onPreview?: (item: OverlayItem) => void; item: OverlayItem & { url: string }; duration: number; busy: boolean; onEdit: (edit: CutEdit) => unknown; motion?: MotionSource | null }) {
  const [draft, setDraft] = useState(item), saved = useRef(item), latest = useRef(item);
  // TASTE1: the times show to 2 decimals (the stored value stays exact); what he types shows as typed until he leaves the field.
  const [typed, setTyped] = useState<{ s?: string; e?: string }>({});
  useEffect(() => { saved.current = item; latest.current = item; setDraft(item); }, [item]);
  function change(patch: Partial<OverlayItem>) { latest.current = { ...latest.current, ...patch }; setDraft(latest.current); onPreview?.(latest.current); }
  function commit(patch: Partial<OverlayItem>) {
    if (busy) return;
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== saved.current[key as keyof OverlayItem]));
    if (!Object.keys(changed).length) return;
    saved.current = { ...saved.current, ...changed }; change(changed);
    void Promise.resolve(onEdit({ kind: "overlay", op: "update", id: item.id, patch: changed })).then(ok => {
      if (ok === false) { saved.current = item; latest.current = item; setDraft(item); }
    });
  }
  const field = `w-full min-w-0 rounded-lg bg-ink/[0.06] px-2 py-1.5 text-[12px] text-ink ${FOCUS}`;
  return <fieldset disabled={busy} className="space-y-3 disabled:opacity-50"><legend className="sr-only">Overlay settings</legend>
    <div className="flex items-center gap-2.5"><img src={item.url} alt="" className="h-[42px] w-16 rounded-md object-contain" /><span className="min-w-0 truncate font-semibold">{item.graphic ? graphicName(item) : overlayName(item.file)}</span></div>
    <div className="grid grid-cols-[72px_1fr] items-center gap-2.5"><span className="text-right text-[12px] text-muted">Position</span><div className="flex flex-wrap gap-1">{([['Top', .5, .2], ['Centre', .5, .5], ['Bottom', .5, .8], ['Corner', .8, .2]] as const).map(([label, x, y]) => <Tile key={label} type="button" aria-pressed={draft.x === x && draft.y === y} onClick={() => commit({ x, y })} className={`rounded-lg px-2 py-1 text-[11px] ${draft.x === x && draft.y === y ? "bg-accent/15 text-accent" : "bg-ink/[0.06]"} ${FOCUS}`}>{label}</Tile>)}</div></div>

    {(item.graphic ? ['enter', 'exit'] as const : ['corner', 'enter', 'exit', 'sound'] as const).map(key => <label key={key} className="grid grid-cols-[72px_1fr] items-center gap-2.5"><span className="text-right text-[12px] text-muted">{key === 'corner' ? 'Corners' : key[0].toUpperCase() + key.slice(1)}</span><select aria-label={key === 'corner' ? 'Corners' : key[0].toUpperCase() + key.slice(1)} value={draft[key] ?? 'none'} onChange={event => commit({ [key]: key === 'sound' && event.target.value === 'none' ? null : event.target.value })} className={field}>{(key === 'corner' ? ['square', 'round'] : key === 'enter' ? ['pop', 'slide-up', 'fade', 'none'] : key === 'exit' ? ['pop', 'fade', 'none'] : ['none', 'pop', 'whoosh', 'hit', 'riser']).map(value => <option key={value} value={value}>{value === 'slide-up' ? 'Slide up' : value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>)}
    <div className="grid grid-cols-2 gap-2">{(['s', 'e'] as const).map(key => <label key={key} className="space-y-1 text-[11px] text-muted"><span>{key === 's' ? 'Start (seconds)' : 'End (seconds)'}</span><NumberField aria-label={key === 's' ? 'Overlay start' : 'Overlay end'} min={key === 's' ? 0 : (Number.isFinite(draft.s) ? draft.s : item.s) + .04} max={key === 's' ? (Number.isFinite(draft.e) ? draft.e : item.e) - .04 : duration} step={.04} value={typed[key] ?? (Number.isFinite(draft[key]) ? String(Math.round(draft[key] * 100) / 100) : "")} onChange={event => { setTyped(was => ({ ...was, [key]: event.target.value })); change({ [key]: event.target.value === '' ? NaN : Number(event.target.value) }); }} onBlur={() => { setTyped(was => ({ ...was, [key]: undefined })); const value = latest.current[key]; if (Number.isFinite(value) && value >= 0 && (key === 's' ? value < latest.current.e : value > latest.current.s) && value <= duration) commit({ [key]: value }); else { latest.current = saved.current; setDraft(saved.current); } }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} className={field} /></label>)}</div>
    <Slider label="Size" min={5} max={100} step={1} unit="%" defaultValue={70} value={Math.round(draft.w * 100)} onChange={value => change({ w: value / 100 })} onRelease={value => commit({ w: value / 100 })} />
    {item.graphic ? <GraphicDesign key={item.id + ':' + (item.graphic.html.length + item.graphic.css.length)} item={item} busy={busy} onEdit={onEdit} motion={motion} onPreview={graphic => change({ graphic })} /> : null}
    <p className="text-[11px] text-muted">Drag it on the video to move it; drag its ends on the timeline to retime.</p>
    <Button aria-label="Remove overlay" onClick={() => void onEdit({ kind: 'overlay', op: 'remove', id: item.id })}><Delete size={13} />Remove overlay</Button>
  </fieldset>;
}
