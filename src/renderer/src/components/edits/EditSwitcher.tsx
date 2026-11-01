import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence } from "framer-motion";
import { Check, ChevronDown, Film, Plus, Library } from "../icons";
import type { ShootSummary } from "../../../../shared/schema";
import { go, openShoot } from "../../nav";
import { pickAndAddShoot } from "../../pages/Shoots";
import { getApi, formatDuration } from "../../data";
import { FOCUS, MenuOption, MenuSurface, useMotionPresets } from "../ui";
import { cleanEditTitle } from "./printModel";
import type { EditListItem } from "./EditsList";

/** One menu for the open edit and every shoot. */
export function EditSwitcher({ items, selectedId, onSelect, root, shootName = "Shoot", onNew }: { items: EditListItem[]; selectedId?: string; onSelect: (id: string) => void; root?: string; shootName?: string; onNew?: () => void }) {
  const { pop } = useMotionPresets();
  const [open, setOpen] = useState(false);
  const [shoots, setShoots] = useState<ShootSummary[]>([]), [error, setError] = useState<string | null>(null), [adding, setAdding] = useState(false);
  const wrap = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const current = items.find(item => item.id === selectedId);
  const title = current ? cleanEditTitle(current.cut?.title ?? current.title) : "Edits";
  useEffect(() => { setOpen(false); }, [selectedId]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    void getApi().listShoots().then(items => { if (alive) setShoots(items.filter(item => item.root !== root).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))); }).catch(() => { if (alive) setError("Couldn't load shoots. Reopen to try again."); });
    const onPointer = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onPointer);
    const id = window.setTimeout(() => (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus(), 0);
    return () => { alive = false; window.removeEventListener("pointerdown", onPointer); window.clearTimeout(id); };
  }, [open, root]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div ref={wrap} data-edit-switcher className="relative flex h-9 min-w-0 items-center" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" data-open-edit-title aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "edit-switcher-menu" : undefined}
      aria-label={`Switch edit or shoot: ${title}, in ${shootName}`} title={`${title}, in ${shootName}`} onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}
      className={`flex h-9 min-w-0 max-w-full items-center gap-2 rounded-full bg-surface pl-1 pr-2.5 text-small font-medium text-ink outline-none hover:bg-ink/[0.06] focus-visible:bg-ink/[0.08] ${FOCUS}`}>
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink/[0.06]">{current?.poster ? <img src={current.poster} alt="" className="size-full object-cover" /> : <Film size={16} />}</span>
      <span className="min-w-0 text-left leading-tight"><span data-edit-name className="block truncate text-[12px]">{title}</span><span data-switcher-shoot className="block truncate text-[10px] font-normal text-muted">{shootName}</span></span>
      <ChevronDown size={14} className="shrink-0 text-ink/70" aria-hidden="true" />
    </button>
    <AnimatePresence>{open && <MenuSurface ref={menu} id="edit-switcher-menu" aria-label="Switch edit or shoot" onClose={close}
      variants={pop} initial="initial" animate="animate" exit="exit"
      className="absolute left-0 top-[calc(100%_+_8px)] z-50 w-[320px] max-w-[calc(100vw-32px)] rounded-3xl p-1.5">
      <div className="max-h-[min(420px,calc(100dvh-160px))] overflow-y-auto">
        <p className="px-2 py-2 text-micro text-muted">This shoot's edits</p>
        {items.map(item => {
          const name = cleanEditTitle(item.cut?.title ?? item.title), on = item.id === selectedId;
          return <MenuOption key={item.id} role="menuitemradio" aria-checked={on} data-edit-switch={item.id} disabled={item.disabled}
            onClick={() => { close(); if (!on) onSelect(item.id); }}
            className={`flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left text-ink hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08] disabled:opacity-45 ${on ? "bg-ink/[0.06]" : ""}`}>
            <span className="flex h-10 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink/[0.06] text-muted">
              {item.poster ? <img src={item.poster} alt="" width={32} height={40} loading="lazy" className="h-full w-full object-cover" onError={event => { event.currentTarget.style.visibility = "hidden"; }} /> : <Film size={14} aria-hidden="true" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-small font-medium">{name}</span>
              <span className="mt-0.5 block truncate text-micro text-muted">{[item.lengthS !== undefined ? formatDuration(item.lengthS) : null, item.cut?.versions.at(-1)?.createdAt ? new Date(item.cut.versions.at(-1)!.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : item.status && item.status !== "Ready" ? item.status : null].filter(Boolean).join(" · ")}</span>
            </span>
            {on && <Check size={14} className="shrink-0 text-ink" aria-hidden="true" />}
          </MenuOption>;
        })}
        {onNew ? <MenuOption role="menuitem" onClick={() => { close(); onNew(); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-small hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08]"><Plus size={16} />New edit</MenuOption> : null}
        <p className="px-2 py-2 text-micro text-muted">Other shoots</p>
        {shoots.map(shoot => <MenuOption key={shoot.root} role="menuitem" disabled={!shoot.online} onClick={() => { close(); openShoot(shoot.root); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08] disabled:opacity-45"><Film size={16} /><span className="min-w-0 flex-1"><span className="block truncate text-small">{shoot.name}</span>{!shoot.online ? <span className="block text-micro text-muted">Drive not connected</span> : null}</span></MenuOption>)}
        {error ? <p role="alert" className="px-3 py-2 text-micro text-danger">{error}</p> : null}
        <MenuOption role="menuitem" onClick={() => { close(); go("shoots"); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-small hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08]"><Library size={16} />All shoots</MenuOption>
        <MenuOption role="menuitem" disabled={adding} onClick={() => { setAdding(true); void pickAndAddShoot().then(shoot => { if (shoot) { close(); openShoot(shoot.root); } }).catch(() => setError("Couldn't add the shoot. Try again.")).finally(() => setAdding(false)); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-small hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08]"><Plus size={16} />{adding ? "Adding shoot…" : "Add shoot"}</MenuOption>
      </div>
    </MenuSurface>}</AnimatePresence>
  </div>;
}
