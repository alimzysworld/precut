import { ContextMenu } from "../ContextMenu";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Film, Plus, Star } from "../icons";
import type { Cut, ReelIdea } from "../../../../shared/schema";
import { formatDuration, getApi } from "../../data";
import { FOCUS, InlineError, MenuOption, Row } from "../ui";
import { cleanEditTitle } from "./printModel";
import { cutVersion } from "./model";
import { NewEditPrompt } from "./NewEditPrompt";
import { Tooltip } from "../ui/InfoTip";
import "./EditsList.css";

export type EditListItem = { id: string; title: string; hook?: string; music?: boolean; lengthS?: number; poster: string | null; cut: Cut | null; status?: string; formats: string[]; disabled: boolean };
// V64: saved versions live in one place, the top bar dropdown (VersionMenu).
// This list only points there; it never renders a second history.
export function groupEdits(items: EditListItem[], ideas: ReelIdea[]) {
  const groups: { id: string; title: string; items: EditListItem[] }[] = [];
  for (const item of items) {
    const ideaId = (item.cut as (Cut & { ideaId?: string }) | null)?.ideaId;
    const idea = ideas.find(idea => idea.cutId === item.id || !!ideaId && idea.id === ideaId);
    const id = idea?.id ?? idea?.cutId ?? item.id;
    let group = groups.find(group => group.id === id);
    if (!group) { group = { id, title: item.cut?.title ?? idea?.title ?? item.title, items: [] }; groups.push(group); }
    group.items.push(item);
  }
  return groups;
}
export function EditsList({ root, onBlank, busy, items, ideas, selectedId, version, collapsed, onCollapse, onSelect, onVersion, children, footer, pending, onStar, onDuplicate, onShotOrder }: {
  root?: string; onBlank?: () => void; busy?: boolean;
  selectedDetails?: ReactNode; items: EditListItem[]; ideas: ReelIdea[]; selectedId?: string; version?: number; collapsed: boolean; onCollapse: () => void;
  onShotOrder?: (cutId:string, version:number) => void;
  onStar?: (id: string, starred: boolean) => void; onDuplicate?: (id: string, version: number) => void | Promise<void>;
  onSelect: (id: string) => void; onVersion: (id: string, version: number) => void; children?: ReactNode; footer?: ReactNode; pending?: ReactNode;
}) {
  const [deleted, setDeleted] = useState<{ root: string; id: string; title: string; version: number; at: number }[]>([]);
  const [composer, setComposer] = useState(false);
  const [context, setContext] = useState<{ item: EditListItem; x: number; y: number }>();
  const [renaming, setRenaming] = useState<string>(), [name, setName] = useState("");
  const [error, setError] = useState(""), [acting, setActing] = useState(false);
  const actionPending = useRef(false), returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem("precut.edits.collapsed") ?? "null");
      if (window.innerWidth >= 1280 && typeof saved === "boolean" && saved !== collapsed) onCollapse();
    } catch { /* Keep the current window usable when storage is unavailable. */ }
  }, []);
  function toggleCollapsed() {
    try { window.sessionStorage.setItem("precut.edits.collapsed", JSON.stringify(!collapsed)); } catch { /* The choice still works for this mount. */ }
    setComposer(false);
    onCollapse();
  }
  useEffect(() => { setContext(undefined); setRenaming(undefined); setError(""); setDeleted([]); }, [root]);
  useEffect(() => {
    if (!deleted.length) return;
    const next = Math.min(...deleted.map(item => item.at + 10_000));
    const timer = setTimeout(() => setDeleted(items => items.filter(item => Date.now() - item.at < 10_000)), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [deleted]);
  async function run(action: () => void | Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true; setActing(true); setError(""); setContext(undefined);
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : "Could not update this edit."); }
    finally { actionPending.current = false; setActing(false); returnFocus.current?.focus(); }
  }
  return <nav aria-label="Edits" data-edits-list data-collapsed={collapsed} className={`relative flex min-h-0 flex-col rounded-2xl bg-surface p-1.5 ${collapsed ? "st-compact-edits" : ""}`}>
    <Row className={`flex items-center ${collapsed ? "justify-center" : "justify-between px-2"} pb-2 pt-1`}>
      {!collapsed && <span className="text-small font-medium">Edits</span>}
      <button type="button" aria-label={collapsed ? "Expand edits" : "Collapse edits"} title={collapsed ? "Expand edits" : "Collapse edits"} onClick={toggleCollapsed} className={`rounded-lg p-2 text-muted hover:bg-ink/[0.06] ${FOCUS}`}>{collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}</button>
    </Row>
    {root && onBlank ? <>
      {collapsed ? <button type="button" aria-label="New edit" title="New edit" aria-expanded={composer} onClick={() => setComposer(value => !value)} className={`st-button-primary mx-auto mb-2 flex size-8 shrink-0 items-center justify-center rounded-full text-white ${FOCUS}`}><Plus size={18} /></button> : <p className="px-2 pb-2 text-micro text-muted">New edit</p>}
      {(!collapsed || composer) && <div className={collapsed ? "st-pop absolute left-full top-12 z-40 ml-2 w-64 rounded-2xl p-3" : ""} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setComposer(false); } }}><NewEditPrompt root={root} onBlank={onBlank} busy={busy} /></div>}
    </> : children}
    <div data-cut-rail className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden py-1">{pending}
      {groupEdits(items, ideas).map(group => <div key={group.id} data-edit-group={group.id}>
        {group.items.map(item => {
          const selected = item.id === selectedId;
          const displayTitle = cleanEditTitle(item.cut?.title ?? item.title);
          const ideaId = (item.cut as (Cut & { ideaId?: string }) | null)?.ideaId;
          const origin = ideas.find(idea => idea.cutId === item.id || !!ideaId && idea.id === ideaId);
          const shown = cutVersion(item.cut, selected ? version : undefined);
          const thumbnail = <button type="button" data-cut-thumbnail={item.id} aria-current={selected ? "true" : undefined} aria-label={[displayTitle, item.lengthS !== undefined ? formatDuration(item.lengthS) : null, item.status].filter(Boolean).join(" · ")} title={collapsed ? undefined : origin ? `${displayTitle}\nFrom idea: ${origin.title}` : displayTitle} disabled={item.disabled} onClick={() => onSelect(item.id)}
              className={`flex w-full min-w-0 ${collapsed ? "justify-center py-1.5" : "items-center gap-2.5 p-2 text-left"} rounded-xl disabled:opacity-50 ${FOCUS}`}>
              <span data-edit-print data-selected={selected} className={collapsed ? "st-compact-edit-thumbnail" : "flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-ink/[0.06]"}>
                {item.poster ? <img key={item.poster} src={item.poster} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = "hidden"; }} className="h-full w-full object-cover" /> : <Film size={20} className="text-muted" />}
                {collapsed && item.lengthS !== undefined && <span data-edit-length className="st-compact-edit-length tnum">{formatDuration(item.lengthS)}</span>}
              </span>
              {!collapsed && <span className="min-w-0 flex-1">
                <span data-edit-title className="line-clamp-2 text-small font-medium">{displayTitle}</span>
                {item.hook && <span className="mt-0.5 block truncate text-micro text-muted">{item.hook}</span>}
                <span className="mt-1.5 flex flex-wrap gap-1 text-[10px] leading-3 text-muted">
                  {item.lengthS !== undefined && <span className="rounded bg-ink/[0.05] px-1.5 py-1 tnum">{formatDuration(item.lengthS)}</span>}
                  {shown && <span className="rounded bg-ink/[0.05] px-1.5 py-1">{(item.music ?? !!shown.music) ? "Music on" : "Music off"}</span>}
                  {!!item.cut?.versions.length && <span className="rounded bg-ink/[0.05] px-1.5 py-1">{item.cut.versions.length} {item.cut.versions.length === 1 ? "version" : "versions"}</span>}
                </span>
                {selected && <span className="mt-1 block truncate whitespace-nowrap text-micro text-muted">{[item.formats.join(" · "), item.status].filter(Boolean).join(" · ")}</span>}
                {!selected && item.status && item.status !== "Ready" && <span className="mt-1 block text-micro text-muted">{item.status}</span>}
              </span>}
              {!collapsed && item.cut?.starred && <Star size={12} className="shrink-0 text-accent" />}
            </button>;
          return <div key={item.id} data-edit-card={item.id} className={`rounded-xl ${selected ? "bg-[var(--selection-fill)]" : "hover:bg-ink/[0.03]"}`}
            onContextMenu={event => { event.preventDefault(); returnFocus.current = event.currentTarget.querySelector('button'); setContext({ item, x: Math.min(event.clientX, window.innerWidth - 208), y: Math.min(event.clientY, window.innerHeight - 200) }); }}
            onKeyDown={event => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); returnFocus.current = event.target as HTMLElement; const box = event.currentTarget.getBoundingClientRect(); setContext({ item, x: box.right, y: box.top }); } }}>
            {collapsed ? <Tooltip label={[displayTitle, item.lengthS !== undefined ? formatDuration(item.lengthS) : null].filter(Boolean).join(" · ")} wrap>{thumbnail}</Tooltip> : thumbnail}
            {!collapsed && root && item.cut && <button type="button" aria-label={`Actions for ${displayTitle}`} title="Edit actions" aria-haspopup="menu" aria-expanded={context?.item.id === item.id} disabled={item.disabled || acting} className={`ml-14 flex items-center gap-1 rounded px-1 py-1 text-micro text-muted ${FOCUS}`} onClick={event => {
              returnFocus.current = event.currentTarget;
              const box = event.currentTarget.getBoundingClientRect();
              setContext({ item, x: Math.min(box.left, window.innerWidth - 208), y: Math.min(box.bottom, window.innerHeight - 200) });
            }}>Edit actions <ChevronDown size={12} /></button>}
            {renaming === item.id && <form className={collapsed ? "st-pop absolute left-full top-16 z-40 ml-2 flex w-64 gap-1 rounded-xl p-2" : "flex gap-1 p-2"} onSubmit={event => { event.preventDefault(); if (root && name.trim()) void run(async () => { await getApi().renameCut(root, item.id, name.trim()); setRenaming(undefined); }); }}>
              <input autoFocus aria-label="Edit title" maxLength={240} value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setRenaming(undefined); }} className={`min-w-0 flex-1 rounded-lg bg-ground p-1 text-small ${FOCUS}`} />
              <button type="submit" disabled={acting || !name.trim()} className={`rounded-lg px-1 text-micro ${FOCUS}`}>Save</button>
            </form>}
            {!collapsed && !!shown?.missing?.length && <p className="px-2 pb-1 text-micro text-warn">{shown.missing.join(" · ")}</p>}
            {!collapsed && !!item.cut?.versions.length && <button type="button" aria-label={`Versions of ${displayTitle}`} onClick={() => { if (!selected) onSelect(item.id); window.dispatchEvent(new CustomEvent("sidething:open-versions", { detail: { cutId: item.id } })); }} className={`ml-14 flex items-center gap-1 rounded px-1 py-1 text-micro text-muted ${FOCUS}`}>Versions<ChevronRight size={12} /></button>}
          </div>;
        })}
      </div>)}
    </div>
    {error && <InlineError className="p-2 text-micro text-danger">{error}</InlineError>}
    {context && <ContextMenu label="Edit actions" x={context.x} y={context.y} returnFocus={returnFocus.current} onClose={() => setContext(undefined)}>
      {root && <MenuOption type="button" role="menuitem" disabled={context.item.disabled || acting} onClick={() => { const item = context.item; setContext(undefined); setRenaming(item.id); setName(cleanEditTitle(item.cut?.title ?? item.title)); if (collapsed) toggleCollapsed(); }}>Rename</MenuOption>}
      {onDuplicate && <MenuOption type="button" role="menuitem" disabled={!context.item.cut || context.item.disabled || acting} onClick={() => { const item = context.item; const v = (item.id === selectedId ? version : undefined) ?? item.cut?.versions.at(-1)?.version; if (v !== undefined) void run(() => onDuplicate(item.id, v)); }}>Duplicate</MenuOption>}
      {onShotOrder && <MenuOption type="button" role="menuitem" disabled={!context.item.cut || context.item.disabled || acting} onClick={()=>{const item=context.item,v=(item.id===selectedId ? version : undefined) ?? item.cut?.versions.at(-1)?.version;setContext(undefined);if(v!==undefined)onShotOrder(item.id,v);}}>Put in shot order</MenuOption>}
      {onStar && <MenuOption type="button" role="menuitem" aria-label={`Star ${context.item.title}`} aria-pressed={!!context.item.cut?.starred} disabled={!context.item.cut || context.item.disabled || acting} onClick={() => void run(() => onStar(context.item.id, !context.item.cut?.starred))}>{context.item.cut?.starred ? "Unstar" : "Star"}</MenuOption>}
      {root && context.item.cut && <MenuOption type="button" role="menuitem" disabled={context.item.disabled || acting} onClick={() => {
        const item = context.item, shoot = root;
        void run(async () => {
          await getApi().deleteCut(shoot, item.id);
          setDeleted(items => [...items, { root: shoot, id: item.id, title: cleanEditTitle(item.cut?.title ?? item.title), version: (item.id === selectedId ? version : undefined) ?? item.cut?.versions.at(-1)?.version ?? 1, at: Date.now() }]);
        });
      }}>Delete edit</MenuOption>}
    </ContextMenu>}
    {deleted.map(item => <div key={item.id} role="status" className="st-pop fixed bottom-4 left-4 z-[90] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl px-3 py-2 text-small" style={{ bottom: `${16 + deleted.indexOf(item) * 48}px` }}>
      <span className="min-w-0 truncate">Deleted {item.title}</span>
      <button type="button" disabled={acting} className={`rounded px-2 py-1 text-accent ${FOCUS}`} onClick={() => void run(async () => {
        await getApi().restoreCut(item.root, item.id);
        setDeleted(items => items.filter(entry => entry !== item));
        onVersion(item.id, item.version);
      })}>Undo</button>
    </div>)}
    {footer}
  </nav>;
}
