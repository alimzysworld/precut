import { formatPercent } from "../components/processingFormat";
import { SegmentedControl } from "../components/ui";
import { MenuOption, EmptyState } from "../components/ui";
import { MenuSurface } from "../components/ui";
import { InlineError, Tile, SectionHeader } from "../components/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown as CaretDown, More as DotsThree, FolderOpen, Play, Plus, List as Rows, Grid as SquaresFour } from "../components/icons";
import sidethingMark from "../assets/sidething-mark.png";
import { AnimatePresence, motion } from "framer-motion";
import { instantFade, item, pop } from "../motion";
import { Badge, Button, FOCUS, Img, SearchField, useMotionPresets, Skeleton } from "../components/ui";
import { formatDuration, frameSrc, getApi, isFixtureMode } from "../data";
import { useShortcuts } from "../hooks/useShortcuts";
import { ShortcutSheet } from "../components/ShortcutSheet";
import type { BadgeTone } from "../theme";
import { lastShootTab, openShoot as navigateToShoot, rememberShootTab } from "../nav";
import type { Shoot, ShootSummary } from "../../../shared/schema";


type View = "cards" | "list";
type Sort = "opened" | "name" | "clips";
type ShootFilter = "all" | "ready" | "working" | "review";
// D1 additive fields produced by main; shared schema belongs to Claude.
type LibrarySummary = ShootSummary & { durationS?: number | null; sizeBytes?: number | null };
interface HomePreferences { view: View; sort: Sort; lastOpened: Record<string, number> }
const HOME_KEY = "st-footage.shoots-view";
const SORT_OPTIONS: { value: Sort; label: string }[] = [
  { value: "opened", label: "Last opened" },
  { value: "name", label: "Name" }, { value: "clips", label: "Most clips" },
];
const FILTER_OPTIONS: { value: ShootFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "ready", label: "Ready" }, { value: "working", label: "Working" },
  { value: "review", label: "Needs a look" },
];

// A missing or stale summary still can recover from the shoot's real frames.
export function useShootStill(root: string, thumb?: string | null, online = true) {
  const [failed, setFailed] = useState<string[]>([]);
  const [fallback, setFallback] = useState<{ root: string; src: string }>();
  useEffect(() => {
    if (!online || thumb && !failed.includes(`${root}:${thumb}`)) return;
    let alive = true;
    void getApi().loadShoot(root).then(shoot => {
      if (shoot?.root !== root) return;
      const rank = (verdict?: string) => verdict === "best" ? 0 : verdict === "alt" ? 1 : verdict === "maybe" ? 2 : 3;
      const lead = [...(shoot?.clips ?? [])].filter(clip => clip.frames.length).sort((a, b) => rank(a.judgement?.verdict) - rank(b.judgement?.verdict))[0];
      const frame = lead?.frames[Math.min(4, lead.frames.length - 1)];
      if (alive && frame) setFallback({ root, src: frameSrc(root, frame) });
    }).catch(() => { /* A folder placeholder remains truthful when media is unavailable. */ });
    return () => { alive = false; };
  }, [root, thumb, online, failed]);
  const src = thumb && !failed.includes(`${root}:${thumb}`) ? thumb : fallback?.root === root && !failed.includes(`${root}:${fallback.src}`) ? fallback.src : undefined;
  return { src, onError: () => { if (src) setFailed(previous => [...previous, `${root}:${src}`]); } };
}

function LibraryThumbnail({ entry, compact = false }: { entry: ShootSummary; compact?: boolean }) {
  const { reduced } = useMotionPresets();
  const { src, onError } = useShootStill(entry.root, entry.thumb, entry.online);
  const size = compact ? "w-[112px] rounded-lg" : "w-full";
  return src ? <Img instant={Boolean(reduced)} src={src} onError={onError} alt="" className={`${size} aspect-video object-cover`} loading="lazy" />
    : <span className={`flex aspect-video items-center justify-center bg-ink/[0.04] text-muted ${size}`}><FolderOpen size={compact ? 20 : 32} /></span>;
}

function readHomePreferences(): HomePreferences {
  const defaults: HomePreferences = { view: "cards", sort: "opened", lastOpened: {} };
  try {
    const stored = JSON.parse(localStorage.getItem(HOME_KEY) ?? "null") as Partial<HomePreferences> | null;
    if (!stored || typeof stored !== "object") return defaults;
    return {
      view: stored.view === "list" ? "list" : "cards",
      sort: SORT_OPTIONS.some(option => option.value === stored.sort) ? stored.sort! : "opened",
      lastOpened: stored.lastOpened && typeof stored.lastOpened === "object" && !Array.isArray(stored.lastOpened)
        ? Object.fromEntries(Object.entries(stored.lastOpened).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15)) : {},
    };
  } catch { return defaults; }
}

export function shootStatus(entry: ShootSummary): { label: string; tone: BadgeTone } {
  if (!entry.online || entry.status === "offline") return { label: "Offline", tone: "pink" };
  if (entry.status === "processing") {
    const pct = entry.progressPct;
    return { label: `Processing${pct != null && Number.isFinite(pct) ? ` · ${formatPercent(pct)}` : ""}`, tone: "amber" };
  }
  if (entry.status === "failed") return { label: "Needs a look", tone: "pink" };
  if (entry.status === "edits" || entry.status === "ideas") return { label: "Ready", tone: "lime" };
  return { label: "Not processed", tone: "neutral" };
}

export function openedLabel(timestamp?: number, now = Date.now()): string {
  if (!timestamp) return "Not opened here yet";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  return minutes < 1 ? "Last opened just now" : minutes < 60 ? `Last opened ${minutes}m ago`
    : minutes < 1440 ? `Last opened ${Math.floor(minutes / 60)}h ago` : `Last opened ${Math.floor(minutes / 1440)}d ago`;
}

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

export function updatedLabel(value: string | null, now = Date.now()): string {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "Update time unavailable";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  if (minutes < 1440) return `Updated ${Math.floor(minutes / 60)}h ago`;
  return `Updated ${Math.floor(minutes / 1440)}d ago`;
}

export function selectShoots(entries: ShootSummary[], query: string, filter: ShootFilter, preferences: HomePreferences) {
  const search = query.trim().toLocaleLowerCase();
  return entries.filter(entry => {
    const offline = !entry.online || entry.status === "offline";
    return (!search || `${entry.name} ${entry.root}`.toLocaleLowerCase().includes(search)) &&
      (filter === "all" || filter === "ready" && !offline && (entry.status === "ideas" || entry.status === "edits") ||
        filter === "working" && !offline && entry.status === "processing" || filter === "review" && (offline || entry.status === "failed"));
  }).sort((a, b) => {
    const order = preferences.sort === "opened" ? (preferences.lastOpened[b.root] ?? 0) - (preferences.lastOpened[a.root] ?? 0)
      : preferences.sort === "clips" ? b.clipCount - a.clipCount : 0;
    return order || a.name.localeCompare(b.name, undefined, { numeric: true }) || a.root.localeCompare(b.root);
  });
}

export function ShootMenu({ entry, busy, onRelink, onRemove, onError }: { entry: ShootSummary; busy: boolean; onRelink: () => void; onRemove: () => void; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { reduced } = useMotionPresets();
  useEffect(() => { if (confirm) ref.current?.querySelector<HTMLButtonElement>("[data-keep-shoot]")?.focus(); }, [confirm]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={ref} className="relative" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" aria-label={`More options for ${entry.name}`} aria-haspopup="menu" aria-expanded={open} disabled={busy}
      onClick={() => { setConfirm(false); setOpen(value => !value); }} className={`flex h-8 items-center justify-center rounded-full bg-ink/[0.06] px-2.5 hover:bg-ink/[0.1] disabled:opacity-45 ${FOCUS}`}><DotsThree size={20} /></button>
    <AnimatePresence>{open && <MenuSurface aria-label={`${entry.name} options`} initial="initial" animate="animate" exit="exit" variants={reduced ? instantFade : pop}
      onClose={() => { setOpen(false); trigger.current?.focus(); }} className="st-pop absolute right-0 top-full z-30 mt-2 w-64 rounded-2xl p-1.5">
      <MenuOption type="button" role="menuitem" className={`w-full rounded-xl px-3 py-2 text-left text-small hover:bg-ink/[0.06] ${FOCUS}`}
        onClick={() => { setOpen(false); void getApi().revealInFinder(entry.root).catch(error => onError(error instanceof Error ? error.message : "Could not reveal the folder.")); }}>Reveal in Finder</MenuOption>
      <MenuOption type="button" role="menuitem" className={`w-full rounded-xl px-3 py-2 text-left text-small hover:bg-ink/[0.06] ${FOCUS}`}
        onClick={() => { setOpen(false); onRelink(); }}>Relink…</MenuOption>
      {confirm ? <div className="rounded-xl bg-ink/[0.04] p-3">
        <p className="text-small">Remove {entry.name} from this list?</p><p className="mt-1 text-micro text-muted">Your folder and footage stay where they are.</p>
        <div className="mt-3 flex gap-2"><MenuOption type="button" role="menuitem" data-keep-shoot className={`rounded-full bg-ink/[0.08] px-3 py-2 text-small ${FOCUS}`} onClick={() => { setConfirm(false); trigger.current?.focus(); }}>Keep shoot</MenuOption>
          <MenuOption type="button" role="menuitem" className={`rounded-full bg-ink/[0.08] px-3 py-2 text-small text-danger ${FOCUS}`} onClick={() => { setOpen(false); onRemove(); }}>Remove</MenuOption></div>
      </div> : <MenuOption type="button" role="menuitem" className={`w-full rounded-xl px-3 py-2 text-left text-small text-danger hover:bg-ink/[0.06] ${FOCUS}`} onClick={() => setConfirm(true)}>Remove from list</MenuOption>}
    </MenuSurface>}</AnimatePresence>
  </div>;
}

export default function ShootsPage() {
  const { reduced } = useMotionPresets();
  const api = useMemo(() => getApi(), []);
  const [entries, setEntries] = useState<LibrarySummary[]>([]);
  const [details, setDetails] = useState<Record<string, Shoot>>({});
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [removed, setRemoved] = useState<LibrarySummary[]>([]);
  const hiddenRoots = useRef(new Set<string>());
  const removals = useRef(new Map<string, { entry: LibrarySummary; timer: ReturnType<typeof setTimeout> }>());
  const undoRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [preferences, setPreferences] = useState(readHomePreferences);
  const [storageError, setStorageError] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ShootFilter>("all");
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>();
  const importing = useRef(false);
  const dragDepth = useRef(0);
  const generation = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(HOME_KEY, JSON.stringify(preferences)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [preferences]);

  useEffect(() => {
    let alive = true;
    let request = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const id = ++request;
      const version = generation.current;
      try {
        const list = await api.listShoots();
        if (alive && request === id && version === generation.current) { setEntries(list.filter(entry => !hiddenRoots.current.has(entry.root))); setLoadError(false); }
      } catch { if (alive && request === id) setLoadError(true); }
      finally { if (alive) setLoading(false); }
    };
    const schedule = () => { if (!pending) pending = setTimeout(() => { pending = undefined; void refresh(); }, 500); };
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5000);
    const offSteps = api.onStepsChanged(schedule);
    const offProgress = api.onProgress(schedule);
    const offActivity = api.onActivity(schedule);
    window.addEventListener("focus", schedule);
    return () => { alive = false; clearTimeout(pending); window.clearInterval(poll); offSteps(); offProgress(); offActivity(); window.removeEventListener("focus", schedule); };
  }, [api]);

  // Native summaries include cached totals. The browser fixture predates those
  // fields, so use its real clip metadata rather than invented card numbers.
  const detailRoots = entries.filter(entry => entry.online && (entry.durationS === undefined || entry.sizeBytes === undefined)).map(entry => entry.root).join("\n");
  useEffect(() => {
    if (!detailRoots || !isFixtureMode()) return;
    let alive = true;
    void Promise.all(detailRoots.split("\n").map(async root => {
      try { return await api.loadShoot(root); } catch { return null; }
    })).then(loaded => {
      if (alive) setDetails(Object.fromEntries(loaded.filter((shoot): shoot is Shoot => Boolean(shoot)).map(shoot => [shoot.root, shoot])));
    });
    return () => { alive = false; };
  }, [api, detailRoots]);

  useEffect(() => () => {
    // Navigating away ends the Undo window and commits only registry changes.
    for (const [root, pending] of removals.current) {
      clearTimeout(pending.timer);
      void api.forgetShoot(root).catch(error => console.error("Could not remove shoot from library", error));
    }
    removals.current.clear();
  }, [api]);

  useEffect(() => {
    if (removed.length) undoRef.current?.querySelector<HTMLButtonElement>("[data-shoot-undo]:last-child button")?.focus();
  }, [removed]);

  function removeShoot(entry: LibrarySummary) {
    generation.current += 1;
    hiddenRoots.current.add(entry.root);
    setEntries(previous => previous.filter(value => value.root !== entry.root));
    setRemoved(previous => [...previous, entry]);
    const timer = setTimeout(() => {
      removals.current.delete(entry.root);
      setRemoved(previous => previous.filter(value => value.root !== entry.root));
      void api.forgetShoot(entry.root).catch(error => {
        hiddenRoots.current.delete(entry.root);
        setEntries(previous => previous.some(value => value.root === entry.root) ? previous : [...previous, entry]);
        setDropNote(error instanceof Error ? error.message : "Could not remove this shoot from the list.");
      });
    }, 8000);
    removals.current.set(entry.root, { entry, timer });
  }

  function undoRemoval(entry: LibrarySummary) {
    const pending = removals.current.get(entry.root);
    if (!pending) return;
    clearTimeout(pending.timer); removals.current.delete(entry.root);
    generation.current += 1; hiddenRoots.current.delete(entry.root);
    setEntries(previous => [...previous, entry]);
    setRemoved(previous => previous.filter(value => value.root !== entry.root));
  }

  const openShoot = useCallback((root: string) => {
    setPreferences(previous => ({ ...previous, lastOpened: { ...previous.lastOpened, [root]: Date.now() } }));
    navigateToShoot(root);
  }, []);

  const importFolder = useCallback(async (root?: string) => {
    if (importing.current) return;
    importing.current = true;
    setBusy("import"); setDropNote(null);
    try {
      const folder = root ?? await api.pickFolder();
      if (!folder) return;
      const known = (await api.listShoots()).find(entry => entry.root === folder);
      if (known) { openShoot(known.root); return; }
      const shoot = await api.addShoot(folder);
      openShoot(shoot.root);
    } catch (error) { setDropNote(error instanceof Error ? error.message : "Could not add the shoot. Try again."); }
    finally { importing.current = false; setBusy(undefined); }
  }, [api, openShoot]);

  const handleDrop = useCallback(async (event: DragEvent) => {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      const item = event.dataTransfer?.items?.[0];
      const fsEntry = item?.webkitGetAsEntry?.();
      if (fsEntry && !fsEntry.isDirectory || !fsEntry && /\.[a-z0-9]{2,5}$/i.test(file.name)) {
        setDropNote("Drop a folder, not a file"); return;
      }
      const root = window.stFiles?.pathFor(file) || (isFixtureMode() ? `dropped-${file.name}` : "");
      if (!root) { setDropNote("Could not read this folder. Use Add shoot to choose it."); return; }
      await importFolder(root);
    } catch (error) { setDropNote(error instanceof Error ? error.message : "Could not read this folder. Try Add shoot."); }
  }, [importFolder]);

  // Window listeners make folder drop work over the header and unused page space too.
  useEffect(() => {
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault(); dragDepth.current += 1; setDragging(true);
    };
    const over = (event: DragEvent) => { event.preventDefault(); };
    const leave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); };
    const drop = (event: DragEvent) => { void handleDrop(event); };
    const reset = () => { dragDepth.current = 0; setDragging(false); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave); window.addEventListener("drop", drop); window.addEventListener("dragend", reset);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); window.removeEventListener("dragend", reset); };
  }, [handleDrop]);

  async function relink(entry: ShootSummary) {
    if (importing.current) return;
    importing.current = true; setBusy(entry.root); setDropNote(null);
    try {
      const folder = await api.pickFolder();
      if (!folder) return;
      const updated = await api.relinkShoot(entry.root, folder);
      generation.current += 1;
      setEntries(previous => previous.filter(value => value.root !== updated.root || value.root === entry.root).map(value => value.root === entry.root ? updated : value));
      const tab = lastShootTab(entry.root);
      if (tab) rememberShootTab(updated.root, tab);
      setPreferences(previous => ({ ...previous, lastOpened: { ...previous.lastOpened, [updated.root]: previous.lastOpened[entry.root] ?? Date.now() } }));
    } catch (error) { setDropNote(error instanceof Error ? error.message : "Could not relink the shoot. Choose the folder containing the original footage."); }
    finally { importing.current = false; setBusy(undefined); }
  }

  const visible = useMemo(() => selectShoots(entries, query, filter, preferences), [entries, query, filter, preferences]);
  const statusChip = (entry: ShootSummary) => {
    const status = shootStatus(entry);
    return <Badge className="st-thumbnail-badge" tone={status.tone} dot>{status.label}</Badge>;
  };
  const totals = (entry: LibrarySummary) => {
    const clips = details[entry.root]?.clips;
    return {
      durationS: entry.durationS ?? (clips?.length && clips.every(c => c.meta && Number.isFinite(c.meta.durationS)) ? clips.reduce((sum, c) => sum + c.meta!.durationS, 0) : null),
      sizeBytes: entry.sizeBytes ?? (clips?.length && clips.every(c => c.meta && Number.isFinite(c.meta.sizeBytes)) ? clips.reduce((sum, c) => sum + c.meta!.sizeBytes, 0) : null),
    };
  };
  const menu = (entry: LibrarySummary) => <ShootMenu entry={entry} busy={Boolean(busy)} onRelink={() => void relink(entry)} onRemove={() => removeShoot(entry)} onError={setDropNote} />;
  const move = (event: KeyboardEvent, direction: number, vertical = false) => {
    const target = event.target as HTMLElement;
    if (target.closest?.("button") && !target.closest("[data-shoot-open]")) return;
    const buttons = [...(libraryRef.current?.querySelectorAll<HTMLButtonElement>("[data-shoot-open]") ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const firstTop = buttons[0].getBoundingClientRect().top;
    const columns = preferences.view === "list" ? 1 : buttons.filter(button => Math.abs(button.getBoundingClientRect().top - firstTop) < 2).length;
    buttons[index < 0 ? 0 : Math.max(0, Math.min(buttons.length - 1, index + direction * (vertical ? columns : 1)))]?.focus();
  };
  const shortcutList = useShortcuts("shoots", [
    { id: "command-search", scope: "global", keys: ["Cmd+k", "Cmd+f"], label: "Search shoots", handler: () => searchRef.current?.querySelector("input")?.focus() },
    { id: "shoot-grid", scope: "shoots", keys: ["g"], label: "Grid view", handler: () => setPreferences(previous => ({ ...previous, view: "cards" })) },
    { id: "shoot-list", scope: "shoots", keys: ["l"], label: "List view", handler: () => setPreferences(previous => ({ ...previous, view: "list" })) },
    ...([[-1, "ArrowLeft"], [1, "ArrowRight"], [-1, "ArrowUp"], [1, "ArrowDown"]] as const).map(([direction, key]) => ({
      id: `shoot-${key}`, scope: "shoots", keys: [key], label: `Move ${key.slice(5).toLowerCase()}`, repeat: true,
      handler: (event: KeyboardEvent) => move(event, direction, key === "ArrowUp" || key === "ArrowDown"),
    })),
    { id: "shoot-open", scope: "shoots", keys: ["Enter"], label: "Open focused shoot", handler: event => {
      const target = event.target as HTMLElement;
      if (target.matches?.("[data-shoot-open]") && !target.hasAttribute("disabled") && target.getAttribute("aria-disabled") !== "true") openShoot(target.dataset.shootOpen!);
      else target.closest?.("button")?.click();
    } },
    { id: "shoot-help", scope: "shoots", keys: ["?"], label: "Keyboard shortcuts", handler: () => setShortcutsOpen(true) },
  ]);

  return <div className="shoots-page relative min-h-full flex flex-col text-body">
    {dragging && <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center" aria-live="polite">
      <div className="absolute inset-0 bg-accent/10" /><p className="st-pop relative rounded-full px-5 py-3 text-body font-medium">Drop to add this shoot</p>
    </div>}
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <div ref={searchRef} title="Search shoots (Cmd K or Cmd F)"><SearchField value={query} onChange={event => setQuery(event.target.value)} label="Search shoots" placeholder="Search shoots" shortcut={null} className="w-52" /></div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <SegmentedControl label="Shoot filters" variant="filter" value={filter} options={FILTER_OPTIONS} onChange={setFilter} className="!p-0" />
        <div className="glass-surface relative ml-auto rounded-full">
          <select aria-label="Sort shoots" title="Sort by" value={preferences.sort} onChange={event => setPreferences(previous => ({ ...previous, sort: event.target.value as Sort }))}
            className={`appearance-none rounded-full bg-transparent py-2 pr-8 pl-3 text-small text-ink ${FOCUS}`}>
            {SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>Sort by {option.label}</option>)}
          </select><CaretDown size={12} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
        </div>
        <div role="group" aria-label="Shoot view" className="flex gap-1">{([{ value: "cards", label: "Grid", icon: SquaresFour, key: "G" }, { value: "list", label: "List", icon: Rows, key: "L" }] as const).map(option => <Tile key={option.value} type="button" aria-label={`${option.label} view`} title={`${option.label} view (${option.key})`} aria-pressed={preferences.view === option.value} onClick={() => setPreferences(previous => ({ ...previous, view: option.value }))} className={`st-filter-pill !p-2.5 ${FOCUS}`}><option.icon size={18} /></Tile>)}</div>
      </div>
          <Button variant="primary" disabled={Boolean(busy)} onClick={() => void importFolder()}><Plus size={15} />{busy === "import" ? "Adding shoot…" : "Add shoot"}</Button>
    </div>
    {storageError && <p role="status" className="mb-4 text-micro text-muted">Your choices are available this session. Could not save them on this device.</p>}
    {dropNote && <InlineError className="mb-4 text-small text-muted">{dropNote}</InlineError>}
    {loading ? <Skeleton kind="cards" count={3} /> : loadError && !entries.length ? <InlineError as="div" className="glass-surface rounded-2xl p-6 text-small text-muted">
      Could not load shoots. Retrying automatically. You can still add a folder.
    </InlineError> : !entries.length ? <button type="button" disabled={Boolean(busy)} onClick={() => void importFolder()}
      className={`glass-surface flex min-h-[360px] w-full flex-col items-center justify-center rounded-2xl px-8 py-20 text-center hover:bg-ink/[0.03] ${FOCUS}`}>
      <FolderOpen size={40} className="text-muted" /><span className="mt-5 text-title font-semibold">Drop a folder of footage here</span>
      <span className="mt-2 text-small text-muted">Works with camera, phone and screen recordings.</span>
      <span className="mt-1 text-micro text-muted">Or click to choose a folder.</span>
    </button> : !visible.length ? <div className="glass-surface rounded-2xl px-6 py-14 text-center">
      <EmptyState variant="inline" as="p" className="text-title font-semibold">No matching shoots</EmptyState><p className="mt-1 text-small text-muted">Try another name, folder or filter.</p>
      <button type="button" onClick={() => { setQuery(""); setFilter("all"); }} className={`mt-4 text-small hover:underline ${FOCUS}`}>Clear search and filters</button>
    </div> : <div ref={libraryRef}>
      {preferences.view === "cards" ? <div role="list" aria-label="Shoots" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 min-[1440px]:grid-cols-4">
        {visible.map(entry => {
          const measured = totals(entry);
          return <motion.div role="listitem" key={entry.root} initial="initial" animate="animate" variants={reduced ? instantFade : item}>
            <Tile as="article" aria-label={entry.name} className="rounded-2xl bg-surface p-3">
              <div className="relative">
                <button type="button" data-shoot-open={entry.root} aria-label={`Open ${entry.name}`} aria-disabled={!entry.online || entry.status === "offline"} disabled={Boolean(busy)} onClick={() => { if (entry.online && entry.status !== "offline") openShoot(entry.root); }}
                  className={`block w-full overflow-hidden rounded-xl disabled:cursor-not-allowed ${FOCUS}`}><LibraryThumbnail entry={entry} /></button>
                <span className="pointer-events-none absolute top-2 left-2">{statusChip(entry)}</span>
                {measured.durationS != null && <span className="pointer-events-none absolute bottom-2 left-2 st-media-chip flex items-center gap-1.5 rounded-lg px-2 py-1 tnum text-micro"><Play size={12} />{formatDuration(measured.durationS)}</span>}
                <div className="absolute top-2 right-2">{menu(entry)}</div>
              </div>
              <div className="px-1 pt-3 pb-1"><div className="flex items-baseline justify-between gap-2"><SectionHeader as="h2" className="min-w-0 truncate text-[20px] font-bold tracking-tight" title={entry.name}>{entry.name}</SectionHeader>
                <p className="shrink-0 text-micro text-muted">{openedLabel(preferences.lastOpened[entry.root])}</p></div>
                <p title="Size of indexed original video and audio" className="mt-3 font-mono text-micro text-muted">{entry.clipCount} clips{measured.sizeBytes != null ? ` · ${formatSize(measured.sizeBytes)}` : ""} · {entry.cutCount} edits</p>
              </div>
            </Tile>
          </motion.div>;
        })}
      </div> : <div className="rounded-2xl bg-surface">
        <table className="w-full table-fixed text-left text-small">
          <thead className="text-micro text-muted"><tr>
            <th scope="col" className="px-4 py-2 font-normal">Shoot</th>
            <th scope="col" className="w-[190px] px-3 py-2 text-right font-normal">Last opened</th>
            <th scope="col" className="w-36 px-3 py-2 text-right font-normal">Status</th>
            <th scope="col" className="w-12 px-2 py-2 font-normal"><span className="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>{visible.map(entry => {
            const measured = totals(entry);
            return <tr key={entry.root} data-shoot-row className="group relative h-[72px] cursor-pointer hover:bg-ink/[0.03]">
              <td className="px-4 py-1"><button type="button" data-shoot-open={entry.root} aria-label={`Open ${entry.name}`} aria-disabled={!entry.online || entry.status === "offline"} disabled={Boolean(busy)} onClick={() => { if (entry.online && entry.status !== "offline") openShoot(entry.root); }} className={`flex w-full min-w-0 items-center gap-4 text-left after:absolute after:inset-0 ${FOCUS}`}>
                <span className="w-[112px] shrink-0"><LibraryThumbnail entry={entry} compact /></span>
                <span className="min-w-0"><span className="block truncate font-medium" title={entry.name}>{entry.name}</span>
                  <span className="mt-1 block truncate font-mono text-micro text-muted">{entry.clipCount} clips{measured.sizeBytes != null ? ` · ${formatSize(measured.sizeBytes)}` : ""} · {entry.cutCount} edits{measured.durationS != null ? ` · ${formatDuration(measured.durationS)}` : ""}</span>
                </span></button></td>
              <td className="px-3 text-right tnum text-micro text-muted">{openedLabel(preferences.lastOpened[entry.root])}</td>
              <td className="px-3 text-right">{statusChip(entry)}</td><td className="px-2"><div className="relative z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">{menu(entry)}</div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
    </div>}
    <footer className="mt-auto flex items-center justify-between gap-3 pt-[var(--page-gutter)] pb-[var(--page-gutter)] text-micro text-muted">
      <span role="status">{!loading && !loadError && (visible.length === entries.length ? `${entries.length} ${entries.length === 1 ? "shoot" : "shoots"}` : `${visible.length} of ${entries.length} shoots`)}</span>
      <a href="https://sidething.com" target="_blank" rel="noopener noreferrer" className={`flex items-center gap-2 rounded-md hover:text-ink ${FOCUS}`}><img src={sidethingMark} alt="" className="size-5 object-contain" /><span>Built by <span className="font-medium text-ink">sidething</span></span></a>
    </footer>
    <div ref={undoRef} className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
      {removed.map(entry => <div key={entry.root} data-shoot-undo role="status" className="flex items-center gap-4 rounded-2xl bg-surface px-4 py-3 text-small">
        <span>{entry.name} removed from list</span><Button onClick={() => undoRemoval(entry)}>Undo</Button>
      </div>)}
    </div>
    {shortcutsOpen && <ShortcutSheet shortcuts={shortcutList} onClose={() => setShortcutsOpen(false)} />}

  </div>;
}

// Shared by the library and shoot switcher; known folders resume without reimport.
export async function pickAndAddShoot(): Promise<Pick<Shoot, "root" | "name"> | null> {
  const api = getApi();
  const root = await api.pickFolder();
  if (!root) return null;
  const known = (await api.listShoots()).find(entry => entry.root === root);
  return known ?? api.addShoot(root);
}
