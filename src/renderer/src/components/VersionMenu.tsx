import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence } from "framer-motion";
import type { Cut, CutVersion, MilestoneKind, RevisionMilestone } from "../../../shared/schema";
import { formatDuration } from "../data";
import { Check, ChevronDown, Film, Plus } from "./icons";
import type { EditHistory } from "../hooks/useEditHistory";
import { cleanEditTitle } from "./edits/printModel";
import { FOCUS, InlineError, MenuOption, MenuSurface, useMotionPresets } from "./ui";

/** Plain words for what made a version. The saved feedback wins; Make it better
 *  says so; then the saved why, then the title. Never invented. */
export function versionLabel(version: CutVersion): string {
  const feedback = version.feedback?.trim();
  if (feedback) return feedback;
  if (version.critique?.issues?.some((issue) => issue.fixed)) return "Made it better";
  const why = version.why?.trim().split(/\n|(?<=[.!?])\s/)[0]?.trim();
  if (why) return why.length > 72 ? `${why.slice(0, 71).trimEnd()}…` : why;
  const title = cleanEditTitle(version.title ?? "").trim();
  if (title) return title;
  return version.version === 1 ? "First version" : "New version";
}

/** Short age in plain words, from the saved createdAt. */
export function relativeAge(createdAt: string, now = Date.now()): string {
  const then = Date.parse(createdAt);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} wk ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

/** One page of history, newest first, read from the end so a 360-version
 *  history never copies or scans the whole list to open. */
export function paginateVersions<T>(versions: readonly T[], offset = 0, limit = 30): { rows: T[]; total: number; nextOffset: number | null } {
  const total = versions.length;
  const safeOffset = Math.max(0, Math.min(total, Math.floor(offset) || 0));
  const safeLimit = Math.max(1, Math.floor(limit) || 30);
  const end = total - safeOffset;
  const start = Math.max(0, end - safeLimit);
  const rows = versions.slice(start, end).reverse();
  return { rows, total, nextOffset: start > 0 ? safeOffset + rows.length : null };
}

export type FollowDecision = "follow" | "defer" | "stay";

/** Whether a newly arrived latest version moves the screen. Only when the
 *  person was on the tip, not pinned to an older version on purpose, and
 *  nothing of theirs is in motion; playback and drags defer, never cancel. */
export function followDecision(input: { displayed: number; previousLatest: number; latest: number; pinnedOlder: boolean; playing: boolean; dragging: boolean }): FollowDecision {
  if (input.latest <= input.previousLatest) return "stay";
  if (input.pinnedOlder) return "stay";
  if (input.displayed !== input.previousLatest) return "stay";
  if (input.playing || input.dragging) return "defer";
  return "follow";
}

const PAGE = 30;

function VersionThumb({ src, small = false }: { src: string | null; small?: boolean }) {
  return <span className={`flex shrink-0 items-center justify-center overflow-hidden bg-ink/[0.06] text-muted ${small ? "h-6 w-5 rounded" : "h-10 w-8 rounded-md"}`}>
    {src ? <img src={src} alt="" width={small ? 20 : 32} height={small ? 24 : 40} loading="lazy" decoding="async" className="h-full w-full object-cover" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : <Film size={small ? 12 : 14} aria-hidden="true" />}
  </span>;
}

/** VO7-3: what kind of moment a version is, in plain words. */
export const MILESTONE_WORDS: Record<MilestoneKind, string> = { draft: "Draft", "before-auto": "Before Auto correct", export: "Exported", saved: "Saved" };
/** The name a saved version starts with; the person can type over it. */
export function defaultVersionName(now = new Date()): string {
  return `Version ${now.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

/** The one version list: a grey button in the Edits top bar and its dropdown. VO7: versions are
 *  the moments that matter (a draft, before Auto correct, an export, a saved version), never every
 *  revision; choosing one restores it as one undoable step, and ⌘S saves the one on screen. Without
 *  main's history (the browser fixture) it lists saved versions as before. */
export function VersionMenu({ cut, current, poster, onOpen, justNew, milestones: source }: {
  cut: Cut;
  current: CutVersion;
  poster: (version: CutVersion) => string | null;
  onOpen: (version: number) => void;
  justNew: boolean;
  /** Main's revision history (VO7-1). Absent: the saved versions list. */
  milestones?: {
    list: () => Promise<RevisionMilestone[]>;
    save?: (name: string) => Promise<unknown>;
    restore: (milestone: RevisionMilestone) => void | Promise<void>;
    history: EditHistory;
  };
}) {
  const { pop } = useMotionPresets();
  const milestonesApi = !!source;
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(PAGE);
  const [milestones, setMilestones] = useState<RevisionMilestone[] | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const latest = cut.versions.at(-1)?.version ?? current.version;
  const byNumber = useMemo(() => new Map(cut.versions.map(entry => [entry.version, entry])), [cut.versions]);
  // Rows are built only while open, and only for the page shown.
  const page = useMemo(() => open && !milestonesApi ? paginateVersions(cut.versions, 0, visible) : null, [open, cut.versions, visible]);
  const marks = useMemo(() => open && milestones ? paginateVersions(milestones, 0, visible) : null, [open, milestones, visible]);
  const currentPoster = useMemo(() => poster(current), [current]);
  const shownMark = milestones?.filter(m => m.version === current.version).at(-1);

  async function reload() {
    if (!source) return;
    try { setMilestones(await source.list()); setProblem(null); }
    catch { setProblem("Couldn't read this edit's versions. Try again."); }
  }
  // "Versions" in the edits list may switch edits first: open once that edit is on screen.
  const cutIdNow = useRef(cut.cutId); cutIdNow.current = cut.cutId;
  const wanted = useRef<{ cutId: string; naming: boolean } | null>(null);
  useEffect(() => {
    setVisible(PAGE); setMilestones(null); setNaming(null); setProblem(null);
    if (wanted.current?.cutId === cut.cutId) { const name = wanted.current.naming; wanted.current = null; setOpen(true); if (name) setNaming(defaultVersionName()); } else setOpen(false);
  }, [cut.cutId]);
  useEffect(() => {
    const show = (naming: boolean) => (event: Event) => {
      const id = (event as CustomEvent<{ cutId?: string } | undefined>).detail?.cutId;
      if (id && id !== cutIdNow.current) { wanted.current = { cutId: id, naming }; return; }
      setOpen(true); if (naming) setNaming(defaultVersionName());
    };
    const versions = show(false), save = show(true);
    window.addEventListener("sidething:open-versions", versions);
    window.addEventListener("sidething:save-version", save);
    return () => { window.removeEventListener("sidething:open-versions", versions); window.removeEventListener("sidething:save-version", save); };
  }, []);
  useEffect(() => { if (open) void reload(); }, [open, cut.cutId, current.version]);
  useEffect(() => {
    if (!open) { setVisible(PAGE); setNaming(null); return; }
    const onPointer = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onPointer);
    const id = window.setTimeout(() => {
      if (field.current) { field.current.focus(); field.current.select(); return; }
      (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]'))?.focus();
    }, 0);
    return () => { window.removeEventListener("pointerdown", onPointer); window.clearTimeout(id); };
  }, [open]);
  useEffect(() => { if (naming !== null) window.setTimeout(() => { field.current?.focus(); field.current?.select(); }, 0); }, [naming !== null]);

  function close() { setOpen(false); trigger.current?.focus(); }
  function choose(version: number) {
    close();
    if (version !== current.version) onOpen(version);
  }
  function restore(milestone: RevisionMilestone) {
    // Focus leaves the menu button so ⌘Z (which shortcuts skip on a menu button) undoes the restore at once.
    setOpen(false); (document.activeElement as HTMLElement | null)?.blur?.();
    if (milestone.version !== current.version || !source?.history.onPath) void source?.restore(milestone);
  }
  async function save() {
    const name = (naming ?? "").trim() || defaultVersionName();
    setNaming(null); setProblem(null);
    try {
      // Saved on the revision on screen, after any edit still on its way.
      await source!.history.after(() => source!.save!(name));
      await reload();
      window.setTimeout(() => menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(), 0);
    } catch { setProblem("Couldn't save this version. Try again."); }
  }

  const buttonText = milestonesApi ? justNew ? "New version" : shownMark?.name ?? "Versions" : justNew ? `v${current.version} · new` : `v${current.version}`;
  return <div ref={wrap} data-version-menu className="relative flex shrink-0 items-center" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <div className={`flex h-9 items-center rounded-full motion-safe:transition-colors ${justNew ? "bg-[var(--selection-fill)]" : "bg-ink/[0.06]"}`}>
      <button ref={trigger} type="button" data-version-button aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? "version-menu" : undefined}
        aria-label={milestonesApi ? `Versions. ${shownMark ? `${shownMark.name} on screen.` : "Open the versions you saved and the moments precut kept."}` : justNew ? `Versions. Version ${current.version} on screen, just made.` : `Versions. Version ${current.version} on screen.`}
        title="Versions (⌘S saves one)"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}
        className={`flex h-9 max-w-[240px] items-center gap-2 rounded-full px-2.5 text-small font-medium text-ink ${justNew ? "" : "hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08]"} ${FOCUS}`}>
        <VersionThumb src={currentPoster} small />
        <span className="tnum truncate whitespace-nowrap" aria-live="polite">{buttonText}</span>
        <ChevronDown size={14} className="shrink-0 text-ink/70" aria-hidden="true" />
      </button>
    </div>
    <AnimatePresence>{open && (page || milestonesApi) && <MenuSurface ref={menu} id="version-menu" aria-label="Versions" onClose={close}
      variants={pop} initial="initial" animate="animate" exit="exit"
      className="absolute right-0 top-[calc(100%_+_8px)] z-50 w-[320px] max-w-[calc(100vw-32px)] rounded-3xl p-1.5">
      {milestonesApi ? <>
        {naming === null
          ? <MenuOption data-save-version disabled={!source.save} onClick={() => setNaming(defaultVersionName())}
              className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-2 text-left text-small font-medium text-ink hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08]">
              <span className="flex h-10 w-8 shrink-0 items-center justify-center rounded-md bg-ink/[0.06]"><Plus size={14} aria-hidden="true" /></span>
              <span className="flex-1">Save version</span><span className="text-micro text-muted">⌘S</span>
            </MenuOption>
          : <form data-save-version-form className="flex items-center gap-1.5 px-1.5 py-1" onSubmit={event => { event.preventDefault(); void save(); }}>
              <label className="sr-only" htmlFor="version-name">Version name</label>
              <input ref={field} id="version-name" value={naming} maxLength={120} onChange={event => setNaming(event.target.value)}
                onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); setNaming(null); } }}
                className="min-w-0 flex-1 rounded-xl bg-ink/[0.06] px-3 py-2 text-small text-ink outline-none placeholder:text-muted focus:bg-ink/[0.09]" />
              <button type="submit" className={`shrink-0 rounded-full bg-ink/[0.08] px-3 py-2 text-small font-medium text-ink hover:bg-ink/[0.12] focus-visible:bg-ink/[0.14] ${FOCUS}`}>Save</button>
            </form>}
        <div className="max-h-[min(420px,calc(100dvh-200px))] overflow-y-auto">
          {marks?.rows.map((mark) => {
            const isCurrent = mark.version === current.version;
            const saved = byNumber.get(mark.version);
            return <MenuOption key={`${mark.version}:${mark.kind}`} role="menuitemradio" aria-checked={isCurrent}
              aria-label={isCurrent ? `${mark.name}, on screen` : `Restore ${mark.name}`}
              data-version-row={mark.version} data-milestone-kind={mark.kind} onClick={() => restore(mark)}
              className={`flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left text-ink hover:bg-ink/[0.05] focus-visible:bg-ink/[0.08] ${isCurrent ? "bg-ink/[0.06]" : ""}`}>
              <VersionThumb src={saved ? poster(saved) : null} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-medium">{mark.name}</span>
                <span className="mt-0.5 block text-micro text-muted">{[MILESTONE_WORDS[mark.kind], relativeAge(mark.at), saved ? formatDuration(saved.lengthS) : ""].filter(Boolean).join(" · ")}</span>
              </span>
              {isCurrent && <Check size={14} className="shrink-0 text-ink" aria-hidden="true" />}
            </MenuOption>;
          })}
          {marks && marks.nextOffset !== null && <MenuOption data-version-older onClick={() => setVisible((value) => value + PAGE)}
            className="mt-1 w-full rounded-2xl px-3 py-2 text-center text-small font-medium text-ink">
            Show older
          </MenuOption>}
          {milestones && !milestones.length && <p className="px-3 py-2 text-small text-muted">No saved versions yet.</p>}
          {!milestones && !problem && <p role="status" className="px-3 py-2 text-small text-muted">Loading versions…</p>}
        </div>
        <InlineError className="px-3 pb-1 pt-1.5 text-micro text-ink" error={problem} />
        <p className="px-3 pb-1 pt-1.5 text-micro text-muted">Restoring a version is one step. ⌘Z brings back where you were.</p>
      </> : page && <>
        <div className="max-h-[min(420px,calc(100dvh-160px))] overflow-y-auto">
          {page.rows.map((entry) => {
            const isCurrent = entry.version === current.version;
            return <MenuOption key={entry.version} role="menuitemradio" aria-checked={isCurrent}
              data-version-row={entry.version} onClick={() => choose(entry.version)}
              className={`flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left text-ink ${isCurrent ? "bg-ink/[0.06]" : ""}`}>
              <VersionThumb src={poster(entry)} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="tnum shrink-0 text-small font-medium">v{entry.version}</span>
                  <span className="min-w-0 truncate text-small text-muted">{versionLabel(entry)}</span>
                </span>
                <span className="mt-0.5 block text-micro text-muted">
                  {[relativeAge(entry.createdAt), formatDuration(entry.lengthS)].filter(Boolean).join(" · ")}
                </span>
              </span>
              {isCurrent && <Check size={14} className="shrink-0 text-ink" aria-hidden="true" />}
            </MenuOption>;
          })}
          {page.nextOffset !== null && <MenuOption data-version-older onClick={() => setVisible((value) => value + PAGE)}
            className="mt-1 w-full rounded-2xl px-3 py-2 text-center text-small font-medium text-ink">
            Show older
          </MenuOption>}
        </div>
        <p className="px-3 pb-1 pt-1.5 text-micro text-muted">{latest === current.version ? `v${current.version} on screen, the newest` : `v${current.version} on screen · v${latest} is newest`}</p>
      </>}
    </MenuSurface>}</AnimatePresence>
  </div>;
}
