import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown as CaretDown, ChevronRight as CaretRight, Check, Film as FilmStrip, Gear as GearSix, Library as House, Ask as Lightbulb, Play, Plus, Video as VideoCamera } from "./icons";
import { AnimatePresence, motion } from "framer-motion";
import type { Cut, ShootSteps, ShootSummary, StepId, ResourceState } from "../../../shared/schema";
import { formatDuration, getApi } from "../data";
import { instant, instantFade, pop, spring } from "../motion";
import { go, openShoot, type PageId } from "../nav";
import { openSettings } from "./SettingsSheet";
import { MotionSurfaces, useMotionPresets } from "./ui";
import { pickAndAddShoot, useShootStill } from "../pages/Shoots";
import { useShortcuts } from "../hooks/useShortcuts";
import { StatusLine, type shootStatusLine } from "./StatusLine";
import { UpdateLine } from "./UpdateLine";
import { ClaudeToggle } from "./edits/ClaudePane";
import { useClaudeLayout } from "./edits/claudeLayout";

function Dock({ children, className, label }: { children: ReactNode; className: string; label?: string }) {
  const props = { className, style: { WebkitAppRegion: "no-drag" } as CSSProperties };
  return label ? <nav {...props} aria-label={label}>{children}</nav> : <div {...props}>{children}</div>;
}
function DockTile(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} />; }

const STEPS = [
  { page: "clips", id: "clips", label: "Footage", icon: VideoCamera },
  { page: "ideas", id: "ideas", label: "Ideas", icon: Lightbulb },
  { page: "precuts", id: "precut", label: "Edits", icon: Play },
] satisfies { page: PageId; id: StepId; label: string; icon: typeof Lightbulb }[];

export function useShootSteps(root?: string) {
  const [value, setValue] = useState<{ root: string; steps: ShootSteps }>();
  useEffect(() => {
    if (!root) return;
    const api = getApi();
    let alive = true;
    let request = 0;
    const refresh = () => {
      const id = ++request;
      void api.shootSteps(root).then(steps => {
        if (alive && id === request) setValue({ root, steps });
      }).catch(() => { /* Keep the last known states; never invent completion. */ });
    };
    const off = api.onStepsChanged(changed => { if (changed === root) refresh(); });
    const timer = window.setInterval(refresh, 2000);
    refresh();
    return () => { alive = false; off(); window.clearInterval(timer); };
  }, [root]);
  return value && value.root === root ? value.steps : undefined;
}

function ShootThumbnail({ root, src: thumb, online = true }: { root: string; src?: string; online?: boolean }) {
  const { src, onError } = useShootStill(root, thumb, online);
  return <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink/[0.06] text-muted">
    {src ? <img src={src} onError={onError} alt="" width={24} height={24} className="size-6 object-cover" /> : <FilmStrip size={16} aria-hidden="true" />}
  </span>;
}

export function StepBar({ page, root, shootName, thumbnail, statusLine, calm, resourceState, onFullSpeed, onProcessing, onRetry, unread }: {
  page: PageId;
  root?: string;
  shootName?: string;
  thumbnail?: string;
  statusLine?: ReturnType<typeof shootStatusLine>;
  calm?: string | null;  // PERF1: "Taking it easy" line for the status popover
  resourceState?: ResourceState;
  onFullSpeed?: (taskId: string) => Promise<boolean>;
  onProcessing?: () => void;
  onRetry?: (stage: import("../../../shared/schema").ProcessingStageId | import("../../../shared/schema").OptionalCheckId) => Promise<void>;
  unread?: Partial<Record<"ideas" | "precuts", boolean>>;
}) {
  const claude = useClaudeLayout();
  useShortcuts("global", STEPS.map((step, index) => ({
    id: `page-${step.page}`, keys: [`Cmd+${index + 1}`], label: `Go to ${step.label.toLowerCase()}`, scope: "global",
    handler: () => {
      if (root) { go(step.page); return; }
      void getApi().listShoots().then(shoots => {
        const shoot = shoots.filter(shoot => shoot.online).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))[0];
        if (shoot) go(step.page, { shoot: shoot.root });
      }).catch(() => {});
    },
  })));
  const api = useMemo(() => getApi(), []);
  const steps = useShootSteps(root);
  const { reduced } = useMotionPresets();
  
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<ShootSummary[]>([]);
  const [edits, setEdits] = useState<Cut[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const switcher = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => { setOpen(false); setError(undefined); }, [page, root]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true); setError(undefined);
    if (root) void api.listCuts(root).then(saved => { if (alive) setEdits(saved); }).catch(() => { if (alive) setError("Could not load edits. Reopen to try again."); });
    void api.listShoots().then((saved) => {
      if (alive) setRecent(saved.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "")));
    }).catch(() => { if (alive) setError("Could not load shoots. Close and reopen to try again."); })
      .finally(() => { if (alive) setLoading(false); });
    const onPointer = (event: PointerEvent) => {
      if (!switcher.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => { alive = false; window.removeEventListener("pointerdown", onPointer); window.removeEventListener("keydown", onKey); };
  }, [api, open, root]);
  useEffect(() => {
    if (open && !loading) (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)') ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  }, [open, loading]);

  function selectShoot(nextRoot: string) {
    setOpen(false); trigger.current?.focus();
    if (nextRoot === root) return;
    openShoot(nextRoot);
  }
  async function addShoot() {
    if (adding) return;
    setAdding(true); setError(undefined);
    try {
      const added = await pickAndAddShoot();
      if (added) { setOpen(false); openShoot(added.root); }
    } catch (error) { setError(error instanceof Error ? error.message : "Could not add the shoot. Try again."); }
    finally { setAdding(false); }
  }

  const control = "st-bar-control outline-none hover:bg-ink/[0.06] focus-visible:bg-ink/[0.08]";

  // CH2: the top bar ends where Claude's pane starts (--claude-reserve, on every page since CH2b).
  return <><MotionSurfaces /><header aria-label="App navigation" className="st-taskbar fixed top-0 left-0 z-[60] grid h-[60px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4"
    style={{ WebkitAppRegion: "drag", right: "var(--claude-reserve, 0px)" } as CSSProperties}>
    {/* POLISH1: the start of the bar, after the window's traffic lights (main sets them on this bar's line): the edits
        sidebar toggle on Edits, the shoot, then on Edits the open edit (its switcher). */}
    <div data-topbar-start className="col-start-1 row-start-1 ml-[72px] flex h-9 min-w-0 max-w-[calc(100%_-_72px)] items-center gap-1 justify-self-start">
    {page === "precuts" && <div id="edits-topbar-sidebar" className="flex shrink-0 empty:hidden" style={{ WebkitAppRegion: "no-drag" } as CSSProperties} />}
    {page !== "precuts" && <div ref={switcher} data-shoot-switcher className="relative h-9 min-w-[72px] shrink"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
      {root && <button ref={trigger} type="button" aria-label={root ? `Switch shoot: ${shootName ?? "Shoot"}` : "Shoots"}
        aria-current={page === "shoots" ? "page" : undefined} aria-haspopup={root ? "menu" : undefined}
        aria-expanded={root ? open : undefined} aria-controls={root && open ? "shoot-switcher-menu" : undefined}
        onClick={() => root ? setOpen((value) => !value) : go("shoots")}
        onKeyDown={(event) => { if (root && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); setOpen(true); } }}
        className={`glass-floating flex h-full max-w-full items-center gap-2 rounded-full px-3 text-small font-medium text-ink ${control}`}>
        {root && <ShootThumbnail root={root} src={thumbnail} />}
        <span data-shoot-name className="max-w-[160px] truncate">{root ? shootName ?? "Shoot" : "Shoots"}</span>
        {root && <CaretDown size={16} className="shrink-0 text-ink/70" aria-hidden="true" />}
      </button>}
      <AnimatePresence>{root && open && <motion.div ref={menu} id="shoot-switcher-menu" role="menu" aria-label="Shoot switcher"
        variants={reduced ? instantFade : pop} initial="initial" animate="animate" exit="exit"
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        className="st-pop absolute top-[calc(100%_+_8px)] left-0 w-[300px] max-w-[calc(100vw-104px)] rounded-3xl p-1.5">
        <div className="max-h-[min(360px,calc(100dvh-200px))] overflow-y-auto" role="group" aria-label="Recent shoots">
          <p className="px-3 py-2 text-micro text-muted">This shoot's edits</p>
          {edits.map(edit => <button key={edit.cutId} type="button" role="menuitem" onClick={() => { setOpen(false); go("precuts", { cut: edit.cutId }); }} className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-small ${control}`}><FilmStrip size={16} /><span className="min-w-0"><span className="block truncate">{edit.title}</span><span className="block truncate text-micro text-muted">{[edit.versions.at(-1)?.lengthS != null ? formatDuration(edit.versions.at(-1)!.lengthS!) : null, edit.versions.at(-1)?.createdAt ? new Date(edit.versions.at(-1)!.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null].filter(Boolean).join(" · ")}</span></span></button>)}
          <button type="button" role="menuitem" onClick={() => { if (!root) return; void api.createCut(root, {}).then(edit => { setOpen(false); go("precuts", { cut: edit.cutId, v: String(edit.version) }); }).catch(() => setError("Couldn't start an edit. Try again.")); }} className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-small ${control}`}><Plus size={16} />New edit</button>
          <p className="px-3 py-2 text-micro text-muted">Other shoots</p>
          {loading ? <p role="status" className="px-3 py-3 text-micro text-muted">Loading shoots…</p> : recent.filter(entry => entry.root !== root).map((entry) => <button key={entry.root} type="button" role="menuitemradio" aria-checked={entry.root === root}
            disabled={!entry.online} onClick={() => selectShoot(entry.root)}
            className={`flex w-full items-center gap-2.5 rounded-full px-2.5 py-2 text-left disabled:opacity-45 ${control}`}>
            <ShootThumbnail root={entry.root} online={entry.online} src={entry.root === root ? thumbnail ?? entry.thumb ?? undefined : entry.thumb ?? undefined} />
            <span className="min-w-0 flex-1"><span className="block truncate text-small text-ink">{entry.name}</span>
              <span className="block text-micro text-muted">{!entry.online ? "Drive not connected" : entry.clipCount === undefined ? "Clip count unavailable" : `${entry.clipCount} ${entry.clipCount === 1 ? "clip" : "clips"}`}</span></span>
            {entry.root === root && <Check size={16} className="shrink-0 text-ink" aria-hidden="true" />}
          </button>)}
        </div>
        {error && <p role="alert" className="px-3 py-2 text-micro text-danger">{error}</p>}
        <div role="separator" className="my-1.5 h-px bg-hair" />
        <button type="button" role="menuitem" onClick={() => { setOpen(false); go("shoots"); }} className={`flex w-full items-center gap-2.5 rounded-full px-2.5 py-2 text-small text-ink ${control}`}><House size={16} aria-hidden="true" />All shoots</button>
        <button type="button" role="menuitem" disabled={adding} onClick={() => void addShoot()} className={`flex w-full items-center gap-2.5 rounded-full px-2.5 py-2 text-small text-ink disabled:opacity-45 ${control}`}><Plus size={16} aria-hidden="true" />{adding ? "Adding shoot…" : "Add shoot"}</button>
      </motion.div>}</AnimatePresence>
    </div>}
    {page === "precuts" && <div id="edits-topbar-edit" className="flex min-w-[96px] shrink empty:hidden" />}
    </div>
    {root && <Dock label="Workflow" className="glass-floating col-start-2 row-start-1 flex h-9 items-center gap-1 rounded-full p-1">
      {STEPS.map((step, index) => {
        const state = steps?.[step.id];
        const active = page === step.page;
        const Icon = step.icon;
        return <Fragment key={step.page}>
          {index > 0 && <CaretRight size={12} className="shrink-0 text-muted/60" aria-hidden="true" />}
          <DockTile type="button" aria-current={active ? "page" : undefined}
          aria-label={step.label} data-step={step.id} data-state={state?.status} title={[`${step.label} (Cmd+${index + 1})`, state?.note].filter(Boolean).join(" · ")} onClick={() => go(step.page)}
          className={`st-bar-control relative flex h-7 items-center rounded-full px-2 sm:px-3 text-small font-medium outline-none ${active ? "text-white focus-visible:brightness-110" : "text-ink/70 hover:bg-ink/[0.06] hover:text-ink focus-visible:bg-ink/[0.06] focus-visible:text-ink"}`}>
          {active && <motion.span layoutId={reduced ? undefined : "workflow-active"} initial={false} transition={reduced ? instant : spring.pill}
            className="st-brand-gradient absolute inset-0 rounded-full" aria-hidden="true" />}
          <span className="relative z-10 flex items-center gap-1.5">
            {state?.status === "done" ? <span aria-label="Done" className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--badge-lime-fill)] text-[var(--badge-lime-ink)]"><Check size={11} aria-hidden="true" /></span>
              : <Icon size={16} aria-hidden="true" />}
            {step.label}
            {(step.page === "ideas" || step.page === "precuts") && unread?.[step.page] && <span aria-label={`New ${step.label.toLowerCase()} ready`} className="size-1.5 rounded-full bg-current" />}
          </span>
        </DockTile></Fragment>;
      })}
    </Dock>}
    <Dock className="col-start-3 row-start-1 flex h-9 min-w-0 max-w-full items-center justify-self-end gap-2">
      {!statusLine && <UpdateLine />}
      <StatusLine status={statusLine ?? null} calm={calm} resourceState={resourceState} onFullSpeed={onFullSpeed} onOpen={onProcessing} onRetry={onRetry} />
      {page === "precuts" && <div id="edits-topbar-version" className="shrink-0" />}
      {page === "precuts" && <div id="edits-topbar-export" className="shrink-0 [&>button]:h-9 [&>button]:rounded-full" />}
      <DockTile type="button" aria-label="Settings" aria-haspopup="dialog" onClick={() => openSettings("general")}
        className={`flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-muted hover:text-ink focus-visible:text-ink ${control}`}>
        <GearSix size={16} aria-hidden="true" />
      </DockTile>
      {/* CH2b: hidden, Claude's toggle sits at the bar's end on every page, the pixel it has in Claude's header. */}
      <div id="edits-topbar-claude" className="shrink-0 empty:hidden">{!claude.open && <ClaudeToggle />}</div>
    </Dock>
  </header></>;
}
