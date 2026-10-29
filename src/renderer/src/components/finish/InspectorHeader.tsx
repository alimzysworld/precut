import { MenuOption } from "../ui";
import { MenuSurface } from "../ui";
import { InlineError } from "../ui";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowClockwise, CalendarBlank, CaretDown, Clock, DotsThree, FolderOpen, FrameCorners, PencilSimple, Resize } from "@phosphor-icons/react";
import type { CutVersion, DraftTimeline } from "../../../../shared/schema";
import { getApi, formatDuration } from "../../data";
import { FOCUS } from "../ui";

export type InspectorActions = {
  onRegenerate?: () => void | Promise<void>;
  actionsDisabled?: boolean;
};
export function InspectorHeader({ root, cutId, version, title, concept, aspect, timeline, drafting, busy = false, exportAction, onRegenerate, actionsDisabled, onDuplicate }: InspectorActions & { root: string; cutId?: string; version: CutVersion; onDuplicate?: () => void | Promise<void>; title?: string; concept?: string; aspect: string; timeline?: DraftTimeline | null; drafting: boolean; busy?: boolean; exportAction?: ReactNode }) {
  const [name, setName] = useState(title ?? version.title), [editing, setEditing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false), [acting, setActing] = useState(false);
  const actionPending = useRef(false), menu = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => { setName(title ?? version.title); setEditing(false); setMenuOpen(false); setError(null); }, [cutId, title, version.title]);
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [menuOpen]);
  async function save() {
    if (!cutId || saving || !name.trim()) return;
    setSaving(true); setError(null);
    try { await getApi().renameCut(root, cutId, name); setName(name.trim()); setEditing(false); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn't rename this edit."); }
    finally { setSaving(false); }
  }
  async function run(action: () => void | Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true; setActing(true); setMenuOpen(false); setError(null); menuButton.current?.focus();
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn't complete this action. Try again."); }
    finally { actionPending.current = false; setActing(false); }
  }
  const created = version.createdAt ? new Date(version.createdAt) : null;
  const revealPath = version.finished ?? version.preview ?? root;
  const iconButton = `flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40 ${FOCUS}`;
  return <header className="space-y-2 px-3 pb-3" aria-label="Edit details">
    <div className="flex min-h-8 items-center gap-1.5">
      {editing ? <form className="flex min-w-0 flex-1 gap-1" onSubmit={event => { event.preventDefault(); void save(); }}><input autoFocus aria-label="Edit title" maxLength={240} value={name} disabled={saving} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setName(title ?? version.title); setEditing(false); } }} className={`min-w-0 flex-1 rounded-lg bg-ink/[0.06] p-2 ${FOCUS}`} /><button type="submit" disabled={saving || !name.trim()} className={`rounded-lg px-2 disabled:opacity-40 ${FOCUS}`}>Save</button></form> : <><button type="button" aria-label="Rename edit" title="Rename edit" disabled={!cutId} onClick={() => setEditing(true)} className={iconButton}><PencilSimple size={15} /></button></>}
      <div ref={menu} className="relative ml-auto shrink-0" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false); }}>
        <button ref={menuButton} type="button" aria-label="Edit actions" title="Edit actions" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} disabled={acting} onClick={() => setMenuOpen(open => !open)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMenuOpen(true); } }} className={iconButton}><DotsThree size={21} weight="bold" /></button>
        {menuOpen ? <MenuSurface id={menuId} aria-label="Edit actions" className="st-pop absolute right-0 top-full z-40 mt-2 w-48 rounded-xl p-1.5" onClose={() => { setMenuOpen(false); menuButton.current?.focus(); }}>
          {[
            { label: "Duplicate", icon: ArrowClockwise, action: onDuplicate, disabled: actionsDisabled },
            { label: "Regenerate via Ask", icon: ArrowClockwise, action: onRegenerate, disabled: actionsDisabled },
            { label: "Reveal in Finder", icon: FolderOpen, action: () => getApi().revealInFinder(revealPath), disabled: false },
          ].map(({ label, icon: Icon, action, disabled }) => <MenuOption key={label} type="button" role="menuitem" disabled={!action || disabled || acting} onClick={() => action && void run(action)} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-small hover:bg-ink/[0.05] disabled:opacity-40 ${FOCUS}`}><Icon size={16} aria-hidden="true" />{label}</MenuOption>)}
        </MenuSurface> : null}
      </div>
    </div>
    {concept ? <p className="text-micro leading-relaxed text-muted [overflow-wrap:anywhere]">{concept}</p> : null}
    <div aria-label="Edit metadata" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-muted">
      {Number.isFinite(version.lengthS) ? <span aria-label="Length" className="inline-flex items-center gap-1.5"><Clock size={14} aria-hidden="true" />{formatDuration(version.lengthS)}</span> : null}
      <span aria-label="Aspect ratio" className="inline-flex items-center gap-1.5"><FrameCorners size={14} aria-hidden="true" />{aspect}</span>
      {timeline ? <span aria-label="Frame size" className="inline-flex items-center gap-1.5"><Resize size={14} aria-hidden="true" />{timeline.width} × {timeline.height}</span> : null}
      {created && Number.isFinite(created.getTime()) ? <span className="inline-flex items-center gap-1.5"><CalendarBlank size={14} aria-hidden="true" /><time dateTime={version.createdAt}>Created {created.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</time></span> : null}
    </div>
    {version.missing?.length ? <details className="rounded-lg bg-[var(--badge-amber-fill)] px-2.5 py-2"><summary className={`flex cursor-pointer list-none items-center justify-between gap-2 text-micro text-[var(--badge-amber-ink)] ${FOCUS}`}>{version.missing.length} {version.missing.length === 1 ? "shot missing" : "shots missing"}<CaretDown size={12} aria-hidden="true" /></summary><ul className="mt-2 space-y-1 pl-3 text-micro leading-relaxed text-[var(--badge-amber-ink)]">{version.missing.map((note, index) => <li key={index} className="list-disc [overflow-wrap:anywhere]">{note}</li>)}</ul></details> : null}
    {error ? <InlineError className="text-micro text-danger">{error}</InlineError> : null}
  </header>;
}
