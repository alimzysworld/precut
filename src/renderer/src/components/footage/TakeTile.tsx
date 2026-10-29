import { RotatingImage } from "../RotatingImage";
import { Checkbox, Tile, Badge, FOCUS } from "../ui";
import { memo, useState } from "react";
import { Star } from "../icons";
import { formatTimecode, frameAt } from "../../data";
import type { Shoot } from "../../../../shared/schema";
import { shotLabels, shotType, itemBadges, type FootageItem } from "./model";
import { takeThumbnail } from "./thumbnail";
import { humanDate } from "../dates";

export const TakeTile = memo(function TakeTile({ shoot, item, active, selected, starred, review, inEdit, onOpen, onSelect, onStar }: {
  shoot: Shoot; item: FootageItem; active: boolean; selected: boolean; starred: boolean; review?: string; inEdit?: boolean;
  onOpen: (item: FootageItem) => void; onSelect: (item: FootageItem) => void; onStar: (item: FootageItem) => void;
}) {
  const poster = takeThumbnail(shoot, item), tiny = takeThumbnail(shoot, item, true);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [hoverTime,setHoverTime] = useState<number | null>(null);
  const hoverStill = hoverTime === null ? null : frameAt(shoot,item.clip.id,hoverTime);
  const badges = itemBadges(item), verdict = badges.find(badge => ["Keep", "Maybe", "Pass"].includes(badge.label));
  const editorial = badges.find(badge => badge.label === "Stumble") ?? badges.find(badge => badge !== verdict);
  const detail = [...badges.map(badge => badge.label), ...(review ? [`Your mark: ${review}`] : [])].join(" · ");
  return <Tile as="article" data-footage-tile={item.key} data-active={active || undefined} data-in-edit={inEdit || undefined} className={`w-full shrink-0 rounded-xl p-1 ${active ? "bg-[var(--selection-fill)]" : "bg-ground"}`}>
    <div className="relative overflow-hidden rounded-lg">
      <Tile type="button" draggable={inEdit !== undefined && !item.clip.missing} onPointerMove={event=>{if(inEdit===undefined || !item.clip.frames.length)return;const box=event.currentTarget.getBoundingClientRect();setHoverTime(Math.max(0,Math.min(1,(event.clientX-box.left)/box.width))*(item.clip.meta?.durationS ?? 0));}} onPointerLeave={()=>setHoverTime(null)} data-clip-menu={item.clip.id} data-take-open={item.key} onClick={() => onOpen(item)} title={detail || undefined} aria-label={`Open ${item.clip.photo?.file ?? item.clip.file}${item.attemptIndex !== undefined ? `, take ${item.attemptIndex + 1}` : ""}`} aria-pressed={active}
        className={`relative block aspect-video w-full overflow-hidden rounded-lg bg-surface ${FOCUS}`}>
        {tiny && !loaded && <RotatingImage root={shoot.root} clip={item.clip} src={tiny} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full scale-105 object-cover" />}
        {loaded && loaded !== poster && <RotatingImage root={shoot.root} clip={item.clip} src={loaded} loading="lazy" decoding="async" alt="" className="absolute inset-0 h-full w-full object-cover" />}
        {poster ? <RotatingImage root={shoot.root} clip={item.clip} src={poster} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(poster)} className={`relative h-full w-full object-cover ${loaded === poster ? "opacity-100" : "opacity-0"}`} /> : <span className="flex h-full items-center justify-center text-micro text-muted">{item.clip.meta?.width === 0 ? "Audio only" : "No still yet"}</span>}
        {hoverStill && <RotatingImage data-hover-still root={shoot.root} clip={item.clip} src={hoverStill} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        {item.clip.transcript?.some(segment => segment.text.trim()) && <span data-transcript-snippet className="absolute inset-x-1 bottom-6 truncate rounded-md bg-surface px-1 text-micro text-ink">{item.clip.transcript.find(segment => segment.text.trim())?.text}</span>}
        {(item.clip.photo || shotType(item.clip) !== "unknown") && <span data-clip-kind className={`absolute ${item.clip.photo ? "bottom-6 right-1" : "bottom-1 left-1"} rounded-md bg-surface px-1 text-micro text-ink`}>{item.clip.photo ? "Photo" : shotLabels[shotType(item.clip)]}</span>}
        {item.clip.photo && humanDate(item.clip.photo.takenAt) && <span data-photo-taken-at className="absolute bottom-1 right-1 max-w-[75%] truncate rounded-md bg-surface px-1 text-micro tnum text-ink" title={humanDate(item.clip.photo.takenAt)!}>{humanDate(item.clip.photo.takenAt)}</span>}
        {!item.clip.photo && item.e !== null && <span className="absolute bottom-1 right-1 st-media-chip rounded-md px-1.5 py-0.5 tnum text-micro">{formatTimecode(item.e - item.s)}</span>}
        {item.clip.missing && <span data-missing-media className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ground/60"><span className="rounded-md bg-surface px-2 py-1 text-micro text-muted">Missing</span></span>}
      </Tile>
      {editorial && <div className="pointer-events-none absolute left-9 right-9 top-1"><Badge tone={editorial.tone} className="st-thumbnail-badge whitespace-nowrap">{editorial.label}</Badge></div>}
      {inEdit && <span className="pointer-events-none absolute left-1 top-9 rounded-md bg-surface px-1 text-micro text-accent">In the edit</span>}
      <div className="pointer-events-none absolute bottom-1 left-1 flex gap-1">{verdict && <Badge tone={verdict.tone} className="!px-1.5 !py-0.5">{verdict.label}</Badge>}{review && <span aria-label={`Your mark: ${review}`} className="st-media-chip rounded-md px-1.5 py-0.5 text-micro">{review[0].toUpperCase() + review.slice(1)}</span>}</div>
      <label className="absolute left-1 top-1 flex size-7 cursor-pointer items-center justify-center rounded-lg bg-surface" title="Select clip (X)"><Checkbox checked={selected} onChange={() => onSelect(item)} aria-label={`Select ${item.key}`} className="size-4 accent-[var(--accent)]" /></label>
      <Tile type="button" onClick={() => onStar(item)} aria-pressed={starred} aria-label={`Star ${item.key}`} title="Star (F): edits use starred shots first" className={`absolute right-1 top-1 flex size-7 items-center justify-center rounded-lg bg-surface ${starred ? "text-accent" : "text-muted"} ${FOCUS}`}><Star size={16} style={{ fill: "currentColor", stroke: "none" }} /></Tile>
    </div>
  </Tile>;
});
