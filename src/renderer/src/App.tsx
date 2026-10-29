import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { LockSimple } from "@phosphor-icons/react";
import { useMotionPresets } from "./components/ui";
import { instant, instantFade, page as pageMotion, spring } from "./motion";
import { StepBar } from "./components/StepBar";
import { hasNewResults } from "./components/processingFormat";
import { navigateToActivity, useActivity } from "./components/Activity";
import { shootStatusLine } from "./components/StatusLine";
import { DiscoveryToast, toastOf } from "./components/Discoveries";
import { getApi } from "./data";
import { SettingsSheet } from "./components/SettingsSheet";
import { lastShootTab, rememberShootTab, shootLanding, useNav, type NavState } from "./nav";
import { PageSession } from "./hooks/usePageActivity";
import { calmLine, useBusyReporter, useResourceState } from "./hooks/useResourceState";
import ShootsPage from "./pages/Shoots";
import { AiAccess, ModelAccess, NeedsAiSheet, openModelSignIn, useAiAccess } from "./components/ModelAccess";
import Setup,{ useSetup } from "./components/Setup";
import ClipsPage from "./pages/Clips";
import PrecutsPage from "./pages/Precuts";
import IdeasPage from "./pages/Ideas";
import WaitingRoom from "./components/WaitingRoom";
import { applyTheme, storedTheme, type ThemeChoice } from "./theme";
import type { ShootProgress, ShootSummary } from "../../shared/schema";

// FIX5: Precuts says when a save of the open edit is in flight until the commit that draws it ("precut:edit-saving").
const editSaving = { now: false, since: 0 };
if (typeof window !== "undefined") window.addEventListener("precut:edit-saving", event => { const next = !!(event as CustomEvent<boolean>).detail; if (next && !editSaving.now) editSaving.since = Date.now(); editSaving.now = next; });
export function useShootStatus(root?: string) {
  const [status, setStatus] = useState<{ root: string; progress?: ShootProgress; summary?: ShootSummary; error?: string }>();
  useEffect(() => {
    if (!root) return;
    const api = getApi();
    let alive = true;
    let request = 0;
    let lastRefresh = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const id = ++request;
      lastRefresh = Date.now();
      try {
        const [progress, summaries] = await Promise.all([api.shootProgress(root), api.listShoots()]);
        if (alive && id === request) setStatus({ root, progress, summary: summaries.find(shoot => shoot.root === root) });
      } catch {
        if (alive && id === request) setStatus(previous => ({ ...(previous?.root === root ? previous : {}), root, error: "Could not read shoot status. Retrying automatically." }));
      }
    };
    // FIX5: while a save of the open edit is being drawn (2 s at most), status reads wait, then run once after it.
    const held = () => editSaving.now && Date.now() - editSaving.since < 2000;
    let missed = false;
    const run = () => { if (held()) { missed = true; return; } missed = false; void refresh(); };
    const schedule = () => {
      if (held()) { missed = true; return; }
      if (pending) return;
      pending = setTimeout(() => { pending = undefined; run(); }, Math.max(0, 1000 - (Date.now() - lastRefresh)));
    };
    const saving = () => {
      if (editSaving.now || !missed) return;
      clearTimeout(pending);
      pending = setTimeout(() => { pending = undefined; run(); }, 50);
    };
    window.addEventListener("precut:edit-saving", saving);
    void refresh();
    const poll = window.setInterval(run, 2000);
    const offSteps = api.onStepsChanged(changed => { if (changed === root) schedule(); });
    const offProgress = api.onProgress(event => { if (event.root === root) schedule(); });
    const offIdeas = api.onSidekickChanged(changed => { if (changed === root) schedule(); });
    const offActivity = api.onActivity(activity => { if (activity.root === root) schedule(); });
    window.addEventListener("focus", schedule);
    return () => { alive = false; clearTimeout(pending); window.clearInterval(poll); offSteps(); offProgress(); offIdeas(); offActivity(); window.removeEventListener("focus", schedule); window.removeEventListener("precut:edit-saving", saving); };
  }, [root]);
  return status?.root === root ? status : undefined;
}

export default function App() {
  return <AppContent />;
}

function AppContent() {
  useBusyReporter();  // PERF1
  // FIX2: main asks for a page (a second launch handing over a shoot, a notification click). Nothing else listens.
  useEffect(() => getApi().onNavigate?.(hash => { if (hash) window.location.hash = hash; }), []);
  const resourceState = useResourceState();
  const calm = calmLine(resourceState);
  const setup = useSetup();
  // ONB2: the chosen engine's state for every gated place (no model call); the checks are the fallback for old bridges.
  const ai = useAiAccess(!!setup.checks?.find(c => c.id === "engine")?.ok);
  const { page, params, go } = useNav();
  const [theme, setTheme] = useState<ThemeChoice>(() => storedTheme());
  const root = page === "shoots" ? undefined : params.shoot;
  // FIX5: the pages render from navigation only. Shoot status, activity progress and resource notices re-render this
  // shell (status line, step bar) many times a second while work runs; that never re-renders every page with it.
  const pages = useMemo(() => params.view === "auto" && page !== "shoots" ? null : <ShootPages key={root ?? "library"} navigation={{ page, params }} />, [page, params, root]);
  const status = useShootStatus(root);
  const activities = useActivity();
  const statusLine = shootStatusLine(root, status?.progress, activities) ?? shootStatusLine(activities.find(activity => activity.state === "running")?.root, undefined, activities);
  const { reduced } = useMotionPresets();
  // What the person has already seen, as counts: more results landing later light the dot again.
  type Seen = { ideas?: number | boolean; precuts?: number | boolean };
  const [visited, setVisited] = useState<Record<string, Seen>>({});
  const unread = root ? { ideas: page !== "ideas" && hasNewResults(status?.summary?.ideaCount, visited[root]?.ideas), precuts: page !== "precuts" && hasNewResults(status?.summary?.cutCount, visited[root]?.precuts) } : {};
  const shootName = status?.summary?.name ?? root?.split(/[\\/]/).filter(Boolean).at(-1);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    if (!root || page === "shoots") return;
    // WR2: opening a shoot lands on the waiting room while it processes, else Ideas (or Footage with no ideas).
    if (params.view === "auto") {
      if (status?.progress || status?.error) {
        let alive = true;
        void getApi().listQuestions(root).catch(() => []).then(questions => {
          if (alive) go(questions.some(q => q.kind === "split" && q.answer === null) ? "wait" : shootLanding(status.progress, status.summary?.ideaCount, lastShootTab(root), status.summary?.cutCount), { ...params, view: undefined });
        });
        return () => { alive = false; };
      }
      return;
    }
    if (!status?.progress) return;
    // Completion never changes the selected tab.
    if (params.view) go(page, { ...params, view: undefined });
    else if (page !== "wait") rememberShootTab(root, page);
  }, [root, status?.progress?.running, status?.error, page, params.view, go]);

  useEffect(() => {
    if (!root) return;
    let saved: Seen = {};
    try { saved = JSON.parse(window.localStorage.getItem(`st-footage.visited:${root}`) ?? "{}") || {}; } catch { /* session memory remains available */ }
    const ready = page === "ideas" ? status?.summary?.ideaCount : page === "precuts" ? status?.summary?.cutCount : 0;
    setVisited(previous => {
      const next = { ...saved, ...previous[root], ...(ready && (page === "ideas" || page === "precuts") ? { [page]: ready } : {}) };
      if (JSON.stringify(previous[root]) === JSON.stringify(next)) return previous;
      try { window.localStorage.setItem(`st-footage.visited:${root}`, JSON.stringify(next)); } catch { /* session memory remains available */ }
      return { ...previous, [root]: next };
    });
  }, [root, page, status?.summary?.ideaCount, status?.summary?.cutCount]);

  if (setup.visible) return <Setup {...setup} onContinue={() => { setup.complete(); go("shoots"); }} />;

  return (
    <AiAccess.Provider value={ai}><ModelAccess.Provider value={ai.ready}><motion.div initial={false} animate={{ paddingTop: 60 }} transition={reduced ? instant : spring.sheet}
      className="st-dot-matrix relative isolate flex h-dvh min-h-0 flex-col overflow-hidden text-body text-ink">
      {root && status?.progress?.openElsewhere && <div role="status" data-open-elsewhere className="pointer-events-none fixed inset-x-0 top-[64px] z-40 flex justify-center px-4">
        {/* FIX2: another precut owns this shoot. Said up front, so no edit here fails with a puzzling message. */}
        <p className="pointer-events-auto flex max-w-[640px] items-center gap-2 rounded-full bg-warn-soft px-4 py-2 text-small text-ink"><LockSimple size={15} weight="fill" className="shrink-0 text-warn" aria-hidden />This shoot is open in another precut, so this one is read only. Quit the other precut to edit here.</p>
      </div>}
      <main data-edits={page === "precuts" || undefined} className="min-h-0 min-w-0 flex-1 st-page-content overflow-hidden pt-2">
        <div className="relative mx-auto h-full min-h-0">
          {pages}
        </div>
      </main>

      <StepBar page={page} root={root} shootName={shootName} thumbnail={status?.summary?.thumb ?? undefined}
        statusLine={statusLine} calm={calm} resourceState={resourceState} unread={unread}
        onFullSpeed={taskId => getApi().fullSpeedForTask(taskId)}
        onProcessing={() => { if (statusLine?.activity) navigateToActivity(statusLine.activity); else if (root) go("clips", { shoot: root }); }}
        onRetry={stage => {
          // ONB2: only the stages that need the AI ask for it; a retry of reading or transcripts never does.
          const needsModel = stage === "group" || stage === "judge" || stage === "ideas" || stage === "drafts";
          if (needsModel && !ai.ready) { openModelSignIn("retry", () => { if (root) void getApi().retryStage(root, stage).catch(() => {}); }); return Promise.resolve(); }
          return root ? getApi().retryStage(root, stage) : Promise.resolve(); }} />
      {root && page !== "shoots" && <DiscoveryToast toast={toastOf(status?.progress)} onOpen={toast => go("clips", { shoot: root, ...(toast.clipId ? { clip: toast.clipId } : {}), ...(toast.t !== undefined ? { t: String(toast.t) } : {}) })} />}
      <SettingsSheet theme={theme} onThemeChange={setTheme} />
      <NeedsAiSheet />
    </motion.div></ModelAccess.Provider></AiAccess.Provider>
  );
}

export function ShootPages({ navigation }: { navigation: NavState }) {
  const pages = useRef(new Map<NavState["page"], NavState>());
  const previousInput = useRef<NavState>();
  const previous = pages.current.get(navigation.page);
  // A bare tab switch restores that tab's route. Edits can still accept explicit
  // cut/version links, and navigation inside a tab can clear its query normally.
  const lastPage = useRef(navigation.page);
  if (previousInput.current?.page !== navigation.page || previousInput.current.params !== navigation.params) {
    const returning = lastPage.current !== navigation.page && Object.keys(navigation.params).every(key => key === "shoot" || key === "settings");
    const route = returning ? { ...navigation, params: { ...previous?.params, ...navigation.params } } : navigation;
    pages.current.set(navigation.page, route);
    previousInput.current = navigation;
  }
  lastPage.current = navigation.page;
  const components = { shoots: ShootsPage, clips: ClipsPage, ideas: IdeasPage, precuts: PrecutsPage, wait: WaitingRoom };
  return <>{[...pages.current].map(([id, saved]) => {
    const Component = components[id];
    return <PageSession.Provider key={id} value={{ active: id === navigation.page, navigation: saved }}>
      <PageSurface active={id === navigation.page} workspace={id === "ideas" || id === "precuts"} page={id}>
        <Component />
      </PageSurface>
    </PageSession.Provider>;
  })}</>;
}

// Animate visibility without changing the page's React identity or scroll host.
function PageSurface({ children, workspace, active, page }: { children: React.ReactNode; workspace: boolean; active: boolean; page: NavState["page"] }) {
  const [exiting, setExiting] = useState(false);
  const previous = useRef(active);
  if (previous.current !== active) { previous.current = active; setExiting(!active); }
  const { reduced } = useMotionPresets();
  return <motion.div variants={reduced ? instantFade : pageMotion} initial="initial" animate={active ? "animate" : "exit"}
    onAnimationComplete={phase => { if (phase === "exit") setExiting(false); }}
    hidden={!active && !exiting} ref={element => { if (!active) element?.setAttribute("inert", ""); else element?.removeAttribute("inert"); }} aria-hidden={!active || undefined}
    className={`h-full min-h-0 ${workspace ? "overflow-hidden [&>div]:!my-0 [&>div]:!h-full [&>div]:!min-h-0" : "overflow-y-auto"}`} data-page-surface={page}
    style={active ? { position: "relative" } : { position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none", ...(!exiting ? { display: "none" } : {}) }}>
    {children}
  </motion.div>;
}
