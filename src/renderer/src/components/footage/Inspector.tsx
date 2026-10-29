import { EmptyState, Tile, Tabs, SectionHeader, Row, InlineError, MenuOption } from "../ui";
import { useEffect, useRef, useState } from "react";
import type { Cut, CutEdit, Shoot } from "../../../../shared/schema";
import { formatBytes, formatTimecode, getApi } from "../../data";
import { ClipDrawer, ClipTags } from "../ClipDrawer";
import { TranscriptPanel } from "../finish/TranscriptPanel";
import { humanDate } from "../dates";
import { TakeSwap } from "../TakeSwap";
import type { StageHandle } from "../Stage";
import { Badge, Button, FOCUS } from "../ui";
import { Calendar, Camera, ChevronLeft, ChevronRight, Check, Clock, FileSize, Frame, More, Pencil, Plus, Search, Star, Video } from "../icons";
import { editUsage, itemBadges, similarItems, shotLabels, shotType, type FootageItem } from "./model";
import { takeThumbnail } from "./thumbnail";
import { lastShootCut } from "../../nav";
const tabs = ["Overview", "Transcript", "Metadata", "Similar"] as const;
const reviews = ["keep", "maybe", "pass"] as const;
type Review = typeof reviews[number];
const cap = (value: string) => value[0].toUpperCase() + value.slice(1);
/** REL2: Add to edit goes into the edit last open on Edits, else the most recently changed one. New edit is its own button. */
export function defaultDestination(root: string, cuts: Cut[]): string {
  const open = lastShootCut(root);
  if (open && cuts.some(cut => cut.cutId === open)) return open;
  const latest = (cut: Cut) => cut.versions.reduce((t, v) => Math.max(t, Date.parse(v.createdAt) || 0), 0);
  return [...cuts].sort((a, b) => latest(b) - latest(a))[0]?.cutId ?? "";
}
export function Inspector({ shoot, item, cuts, usageKnown, index, total, onClose, onMove, onOpen, onShootChange, onCutsChange, onAdd, note, onNote, host, playRequest, initialTime, embedded, actionLabel = "Add to edit", actionDisabled, starred = false, onStar, review, onReview }: {
  shoot: Shoot; item: FootageItem; cuts: Cut[]; usageKnown: boolean; index: number; total: number;
  onClose: () => void; onMove: (delta: number) => void; onOpen: (item: FootageItem) => void;
  onShootChange: (shoot: Shoot) => void; onCutsChange: (cuts: Cut[]) => void; onAdd: (cutId?: string) => void;
  note: string; onNote: (note: string) => void; playRequest: number; initialTime?: number; host: React.RefObject<HTMLElement>;
  embedded?: boolean; actionLabel?: string; actionDisabled?: boolean;
  starred?: boolean; onStar?: (item: FootageItem) => void; review?: Review; onReview?: (value: Review | undefined) => void;
}) {
  const [tab, setTab] = useState<typeof tabs[number]>("Overview");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [target, setTarget] = useState(() => defaultDestination(shoot.root, cuts)), [menu, setMenu] = useState(false);
  useEffect(() => { if (!cuts.some(cut => cut.cutId === target)) setTarget(defaultDestination(shoot.root, cuts)); }, [cuts, shoot.root, target]);
  const [replacement, setReplacement] = useState<{ cutId: string; version: number; piece: number } | null>(null);
  const [audition, setAudition] = useState<{ url: string; s: number; e: number } | null>(null);
  const preview = useRef<HTMLVideoElement>(null);
  // TakeSwap needs just its preview transport, so it can share the same replacement logic.
  const transport = useRef({ preview: (url: string, s: number, e: number) => { host.current?.querySelectorAll("video").forEach(video => video.pause()); setAudition({ url,s,e }); }, stopPreview: () => { preview.current?.pause(); setAudition(null); } } as StageHandle);
  useEffect(() => { setReplacement(null); setAudition(null); setError(""); setMenu(false); setTab("Overview"); }, [item.key]);
  const playedRequest = useRef(0);
  useEffect(() => {
    if (!playRequest || playedRequest.current === playRequest) return;
    playedRequest.current = playRequest;
    const video = host.current?.querySelector<HTMLVideoElement>("[data-footage-preview] video");
    if (!video) return;
    const play = () => { video.currentTime = Math.max(0, initialTime ?? item.s); void video.play().catch(() => setError("Could not play this preview.")); };
    if (video.readyState >= 2) play(); else video.addEventListener("loadeddata", play, { once: true });
    return () => { video.removeEventListener("loadeddata", play); };
  }, [playRequest, item.key]);
  const usage = editUsage(cuts, item.clip.id);
  const similar = similarItems(shoot, item);
  const meta = item.clip.meta;
  const badges = itemBadges(item);
  const replaceCut = cuts.find(c => c.cutId === replacement?.cutId);
  const replaceVersion = replaceCut?.versions.find(v => v.version === replacement?.version);
  const piece = replacement ? replaceVersion?.pieces?.[replacement.piece] : undefined;
  async function replace(edit: CutEdit) {
    if (!replacement || busy) return;
    setBusy(true); setError("");
    try { await getApi().editCut(shoot.root, replacement.cutId, replacement.version, edit); onCutsChange(await getApi().listCuts(shoot.root)); setReplacement(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not replace this take."); }
    finally { setBusy(false); }
  }
  const seek = (time: number) => { const video = host.current?.querySelector<HTMLVideoElement>("[data-footage-preview] video"); if (video) video.currentTime = time; };
  const verdict = review ? { label: cap(review), tone: review === "keep" ? "lime" as const : review === "maybe" ? "amber" as const : "pink" as const } : badges.find(badge => ["Keep", "Maybe", "Pass"].includes(badge.label));
  const judgement = item.why || item.clip.judgement?.summary;
  const fileSize = meta ? item.clip.photo && meta.sizeBytes < 1024 * 1024 ? `${Math.round(meta.sizeBytes / 1024)} KB` : formatBytes(meta.sizeBytes) : null;
  const rows = [
    [Video, "Shot type", shotType(item.clip) !== "unknown" ? shotLabels[shotType(item.clip)] : null],
    [Clock, "Duration", !item.clip.photo && meta ? formatTimecode(item.e !== null ? item.e - item.s : meta.durationS) : null],
    [FileSize, "File size", fileSize], [Calendar, item.clip.photo ? "Taken" : "Recorded", humanDate(item.clip.photo ? item.clip.photo.takenAt : meta?.createdAt)],
    [Camera, "Camera", meta?.camera], [Frame, "Format", meta ? `${meta.height >= 2160 ? "4K" : `${meta.width} × ${meta.height}`} · ${meta.fps} fps` : null],
  ] as const;
  const fileName = (item.clip.photo?.file ?? item.clip.file).split(/[\\/]/).pop();
  const stepper = "flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-ink/[0.06] disabled:opacity-30";
  return <aside ref={host} aria-label="Footage inspector" className="sticky top-0 h-[calc(100dvh-148px)] min-h-0 min-w-0 flex flex-col overflow-hidden rounded-2xl bg-surface p-4">
    {embedded && <button type="button" onClick={onClose} className={`mb-2 flex shrink-0 items-center gap-1 self-start rounded-lg px-2 py-1 text-micro text-accent ${FOCUS}`}><ChevronLeft size={14} />Back to footage</button>}
    <header className="mb-3 flex shrink-0 items-center gap-2">
      {badges[0] && <Badge className="st-thumbnail-badge shrink-0" tone={badges[0].tone}>{badges[0].label}</Badge>}
      <strong className="min-w-0 flex-1 truncate text-small" title={item.clip.file}>{fileName}</strong>
      <span className="whitespace-nowrap tnum text-micro text-muted">{index + 1} of {total}</span>
      <button type="button" aria-label="Previous take" title="Previous take (Left)" disabled={index <= 0} onClick={() => onMove(-1)} className={`${stepper} ${FOCUS}`}><ChevronLeft size={16} /></button>
      <button type="button" aria-label="Next take" title="Next take (Right)" disabled={index >= total - 1} onClick={() => onMove(1)} className={`${stepper} ${FOCUS}`}><ChevronRight size={16} /></button>
    </header>
    <div className={audition ? "hidden" : "shrink-0"}><ClipDrawer shoot={shoot} clip={item.clip} initialTime={initialTime ?? item.s} endTime={item.attempt || embedded ? item.e ?? undefined : undefined} layout="preview" onClose={onClose} onShootChange={onShootChange} /></div>
    {audition && <video key={`${audition.url}:${audition.s}`} ref={preview} src={audition.url} className="aspect-video w-full shrink-0 rounded-xl" controls autoPlay playsInline onLoadedMetadata={event => { event.currentTarget.currentTime = audition.s; void event.currentTarget.play().catch(() => setError("Could not play this preview.")); }} onTimeUpdate={event => { if (event.currentTarget.currentTime >= audition.e) event.currentTarget.pause(); }} />}
    <Tabs label="Clip details" value={tab} options={tabs} onChange={setTab} idPrefix="footage" panelId="footage-detail-panel" className="my-3 flex shrink-0 gap-1" itemClassName="px-1 !py-1.5" />
    <div id="footage-detail-panel" role="tabpanel" aria-labelledby={`footage-${tab}`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {tab === "Overview" && <div className="space-y-4">
        <div className="flex items-center gap-2">
          <SectionHeader as="h3" className="min-w-0 flex-1 truncate text-body font-semibold" title={item.clip.file}>{fileName}</SectionHeader>
          <Tile type="button" aria-label="Star take" aria-pressed={starred} title="Star (F): edits use starred shots first" onClick={() => onStar?.(item)} className={`${stepper} ${starred ? "text-accent" : ""} ${FOCUS}`}><Star size={16} style={{ fill: "currentColor", stroke: "none" }} /></Tile>
          <div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(false); }} onKeyDown={event => { if (event.key === "Escape" && menu) { event.stopPropagation(); setMenu(false); } }}>
            <button type="button" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)} className={`${stepper} ${FOCUS}`}><More size={16} /></button>
            {menu && <div role="group" aria-label="Your mark" className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl bg-ground p-1.5">
              {reviews.map((value, i) => <MenuOption key={value} role="menuitemradio" aria-checked={review === value} title={`${cap(value)} (${i + 1}), on this Mac`} onClick={() => { onReview?.(review === value ? undefined : value); setMenu(false); }} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-small">{cap(value)}{review === value && <Check size={14} />}</MenuOption>)}
            </div>}
          </div>
        </div>
        {judgement && <p className="text-small leading-relaxed text-muted">{judgement}</p>}
        {!!item.clip.screen?.segments.length && <section aria-label="What this screen shows" className="space-y-2">
          <SectionHeader as="h3" className="text-small font-semibold">What this screen shows</SectionHeader>
          {item.clip.screen.segments.map(segment => <p key={segment.s} className="rounded-lg bg-ground p-2 text-small">
            <span className="mr-2 tnum text-micro text-muted">{formatTimecode(segment.s)}</span>{segment.line || segment.text.split("\n").slice(0,2).join(" · ") || "Screen text could not be read"}
            {segment.app && <span className="mt-1 block text-micro text-muted">{segment.app}</span>}
          </p>)}
          {item.clip.screen.modelError && <p className="text-small text-muted">{item.clip.screen.modelError}</p>}
        </section>}
        {item.attempt?.soundbite && <p className="text-small italic text-muted">“{item.attempt.soundbite}”</p>}
        <div className="flex flex-wrap gap-1.5">
          {item.clip.photo && <Badge>Photo</Badge>}
          {shotType(item.clip) !== "unknown" && <Badge>{shotLabels[shotType(item.clip)]}</Badge>}
          {item.lineIndex !== undefined && <Badge>Line {item.lineIndex + 1}</Badge>}
          {verdict && <Badge tone={verdict.tone}>{verdict.label}</Badge>}
          {usageKnown && usage.length > 0 && <Badge>Used in {usage.length} {usage.length === 1 ? "edit" : "edits"}</Badge>}
        </div>
        <dl className="space-y-3 text-small">{rows.filter(([, , value]) => value != null).map(([Icon, label, value]) => <Row key={label} className=""><dt className="flex items-center gap-2 text-muted"><Icon size={14} />{label}</dt><dd className="min-w-0 truncate tnum text-micro" title={String(value)}>{value}</dd></Row>)}</dl>
        {usageKnown && usage.length > 0 && <section><SectionHeader as="h3" className="text-small font-semibold">Used in</SectionHeader>
          {usage.map(({ cut, version }) => <div key={cut.cutId} className="mt-2 rounded-xl bg-ground p-3">
            <a className={`text-small text-accent ${FOCUS}`} href={`#/precuts?${new URLSearchParams({ shoot: shoot.root, cut: cut.cutId, v: String(version.version) })}`}>{version.title} · v{version.version}</a>
            {(version.pieces ?? []).flatMap((p, pieceIndex) => p.clipId === item.clip.id && /^L\d+A\d+$/.test(p.id) ? [<Button key={pieceIndex} className="mt-2" onClick={() => setReplacement({ cutId: cut.cutId, version: version.version, piece: pieceIndex })}>Replace take {pieceIndex + 1}</Button>] : [])}
          </div>)}
        </section>}
        {piece && replacement && <TakeSwap shoot={shoot} piece={{ ...piece, label: piece.words || piece.description || piece.id, words: piece.words || "" }} index={replacement.piece} busy={busy} onEdit={edit => void replace(edit)} player={transport} />}
        <label className="block text-small text-muted"><span className="flex items-center justify-between">Notes<Pencil size={14} /></span><textarea value={note} onChange={event => onNote(event.target.value)} placeholder="Add a note..." className={`mt-2 min-h-16 w-full resize-y rounded-xl bg-ground p-3 text-ink ${FOCUS}`} /></label>
      </div>}
      {tab === "Transcript" && <div className="text-small leading-relaxed"><TranscriptPanel shoot={shoot} source={{ clipId: item.clip.id, s: item.attempt ? item.s : undefined, e: item.attempt ? item.e ?? undefined : undefined, fallback: item.attempt?.text }} onSeek={seek} onChange={onShootChange} />{!item.clip.transcript?.length && !item.attempt?.text && <EmptyState variant="inline" as="p" className="text-muted">No transcript for this clip yet.</EmptyState>}</div>}
      {tab === "Metadata" && <><div className="mb-4 flex flex-wrap gap-1"><ClipTags shoot={shoot} clip={item.clip} onShootChange={onShootChange} />{item.clip.quality?.tags.map(tag => <Badge key={tag.label}>{tag.label}</Badge>)}</div><dl className="space-y-3 text-small">{[
        ["File",item.clip.photo?.file ?? item.clip.file], ["Duration", !item.clip.photo && meta ? formatTimecode(meta.durationS) : null], ["Size",fileSize], [item.clip.photo ? "Taken" : "Recorded",humanDate(item.clip.photo ? item.clip.photo.takenAt : meta?.createdAt)], ["Camera",meta?.camera], ["Format",meta ? `${meta.width} × ${meta.height} · ${meta.fps} fps` : null], ["Codec",meta?.codec], ["Profile",meta?.pictureProfile], ["Source audio",!item.clip.photo ? item.clip.sound?.file : null], ["Stage",item.clip.stage],
      ].filter(([, value]) => value != null).map(([label,value]) => <div key={label} className="flex justify-between gap-4"><dt className="shrink-0 text-muted">{label}</dt><dd className="break-all text-right tnum text-micro">{value}</dd></div>)}</dl></>}
      {tab === "Similar" && <div className="space-y-2">{similar.map(other => { const still = takeThumbnail(shoot, other); return <button type="button" key={other.key} onClick={() => onOpen(other)} className={`flex w-full items-center gap-3 rounded-xl bg-ground p-2 text-left text-small ${FOCUS}`}>
        <span className="aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-surface">{still && <img src={still} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />}</span>
        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.clip.similar?.find(s => s.clipId === other.clip.id)?.kind === "take" ? "Another take" : item.clip.angles?.includes(other.clip.id) ? "Other angles" : "Similar footage"}</span><span className="mt-0.5 line-clamp-2 block text-micro text-muted">{other.attempt?.text || other.clip.judgement?.summary || other.clip.photo?.file || other.clip.file}</span></span></button>; })}{!similar.length && <EmptyState variant="inline" as="p" className="text-small text-muted">No matching footage in this moment.</EmptyState>}</div>}
    </div>
    {error && <InlineError className="mt-3 text-small text-danger">{error}</InlineError>}
    <footer data-footage-actions className="shrink-0 bg-surface pt-3">
    {!embedded && cuts.length > 0 && <div className="mt-3 flex items-end gap-2"><label className="block min-w-0 flex-1 text-micro text-muted">Add to<select aria-label="Destination edit" value={target} onChange={event => setTarget(event.target.value)} className={`mt-1 w-full rounded-xl bg-ground p-2 text-small text-ink ${FOCUS}`}>{cuts.map(cut => <option key={cut.cutId} value={cut.cutId}>{cut.title || cut.versions.at(-1)?.title || cut.cutId}</option>)}</select></label>
      <Button data-new-edit disabled={actionDisabled} className="shrink-0 !px-3" onClick={() => onAdd(undefined)}><Plus size={14} />New edit</Button></div>}
    <div className="grid grid-cols-2 gap-2 pt-3 pb-1"><Button className="!px-2" onClick={() => setTab("Similar")}><Search size={14} />Find similar takes</Button><Button variant="primary" disabled={actionDisabled} className="!px-2" onClick={() => onAdd(embedded ? undefined : target || undefined)}><Plus size={14} />{!embedded && !cuts.length && actionLabel === "Add to edit" ? "New edit" : actionLabel}</Button></div>
    </footer>
  </aside>;
}
