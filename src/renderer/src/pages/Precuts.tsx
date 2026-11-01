import { ClipNames, NamedMessage } from "../components/ClipNames";
import { refreshShootWhenQuiet } from "../hooks/quietShoot";
import { pieceName } from "../../../shared/clip-name";
import { selectionBatch } from "../components/timeline/selection";
import { useModelAccess, openModelSignIn } from "../components/ModelAccess";
import { LibraryView } from "../components/library/LibraryView";
import { sourceRange, sourcePlacement, sourceDestination, type SourceRange } from "../components/library/source";
import type { FootageItem } from "../components/footage/model";
import { transcriptTimeline } from "../components/finish/transcriptTimeline";
import { draftFailure } from "../components/draftFailure";
import { cutSignature, finishTimeline, optimisticTimeline, optimisticVersion, savedNumbering, sentEdit, spineOrder, isLocalVoiceId, isSoundAdjustment, playbackExtent } from "../components/liveTimeline";
import { MenuOption } from "../components/ui";
import { MenuSurface } from "../components/ui";
import { Row, SectionHeader, InlineError, PanelBoundary } from "../components/ui";
import type { CaptionSource } from "../../../main/titles/captions";
import { startTransition, useDeferredValue, useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { FullScreen, ChevronDown, Crop, Plus } from "../components/icons";
import type { Activity, Grade, TitleTrack, Cut, CutEdit, CutVersion, DraftTimeline, Skill, Shoot, RevisionMilestone, AudioFile } from "../../../shared/schema";
import { mediaUrl } from "../../../shared/media";
import { getApi, isFixtureMode } from "../data";
import { instant as instantMotion, spring } from "../motion";
import { lastShootCut, rememberShootCut, useNav } from "../nav";
import { FOCUS, useMotionPresets } from "../components/ui";
import { selectSidekickCut, sidekickSend, useSidekickWorkspace } from "../components/SidekickChat";
import { printPoster, editHook } from "../components/edits/printModel";
import { cutAspect, cutPoster, cutVersion } from "../components/edits/model";
import { Stage, type StageHandle } from "../components/Stage";
import { Timeline } from "../components/Timeline";
import { useVoiceover } from "../components/VoiceoverPanel";
import { Teleprompter } from "../components/Teleprompter";
import { magneticPreview, type LaneVisibility } from "../components/timeline/model";
import { useEditHistory, type EditHistory } from "../hooks/useEditHistory";
import { useActivity } from "../components/Activity";
import { ExportModal } from "../components/ExportModal";
import { MissingMediaBanner } from "../components/MissingMediaBanner";  // EXP3
import { VersionMenu, followDecision, versionLabel } from "../components/VersionMenu";
import { WhatChanged } from "../components/WhatChanged";
import { ProducedRow } from "../components/ProducedRow";  // UI09: follow-ups in Claude
import { EditSwitcher } from "../components/edits/EditSwitcher";  // POLISH1
import { EditsSidebarToggle, useEditsSidebar } from "../components/edits/editsSidebar";  // POLISH1
import { selectedSources } from "../components/footage/selection";
import type { LiveLook } from "../components/LivePlayer";
import { ShotOrderDialog } from "../components/ShotOrderDialog";
import { InspectorHeader } from "../components/finish/InspectorHeader";
import { FinishPanel, type FinishOptions } from "../components/FinishPanel";
import { ClipMenu } from "../components/ClipMenu";
import { ShowWhatISay, showWhatISay } from "../components/ShowWhatISay";  // BROLL2
import { ownBalance } from "../hooks/useBalance";
import { editShortcuts, panelShortcuts, type EditsPanel, useShortcuts, useShuttle } from "../hooks/useShortcuts";
import { ShortcutSheet } from "../components/ShortcutSheet";
import { CONTROL_REGISTRY, panelForControl, type ControlEntry, type SearchResult } from "../components/finish/search";
import { EditsList, type EditListItem } from "../components/edits/EditsList";
import { PaneHandle, readPane, savePane, ToolBar, usePane, type TimelineTool } from "../components/edits/ToolBar";
import { voiceDeleteEdit, type VoiceEditOp } from "../../../shared/voice-edit";
import { timelinePrefs } from "../components/timeline/prefs";
import { selectOverlay, useOverlaySession } from "../components/OverlayHandles";
import { sourceTime } from "../components/LivePlayer";
import { Rail } from "../components/edits/Rail";
import { showClaude } from "../components/edits/ClaudePane";
import { toggleClaude, useEditorNarrow } from "../components/edits/claudeLayout";
import { useClaudeScreen } from "../components/edits/claudeScreen";
import type { AskScreenContext } from "../components/finish/AskPanel";
import { Sheet } from "../components/edits/Sheet";
import { usePageActive } from "../hooks/usePageActivity";
import { prefetchCuts, prefetchDraft, takeCuts, takeDraft } from "./openCache";

const ACTION = "inline-flex items-center justify-center gap-1.5 rounded-full bg-ink/[0.06] px-3.5 py-1.5 text-small font-medium text-ink hover:bg-ink/[0.1] disabled:opacity-40 outline-none";
type Selection = { cutId: string; version: number };
type UndoSelection = Selection & { message?: string };
/** VO7-3: what the screen shows while an edit is on its way to main: the edit applied locally. */
type LocalDoc = { key: string; version: CutVersion; timeline: DraftTimeline; time?: number; exact?: boolean };
// Edits that never move, add or remove a piece: they queue behind pending saves without a local plan.
const QUEUE_WITHOUT_PLAN = new Set<CutEdit["kind"]>(["overlay", "lowerThird", "sfx", "cover", "bleep", "captionWord", "clipSound", "laneLevel", "pieceFx", "transform", "retimeCaptions"]);
const SAVE_FAILED = "Couldn't save that change. Your edit is as it was.";
/** The revision an edit opens on (VO7: its current revision), or null without main's history. */
async function currentRevision(root: string, cutId: string): Promise<number | null> {
  const api = getApi();
  if (typeof api.revisionState !== "function") return null;
  try { return (await api.revisionState(root, cutId)).version; } catch { return null; }
}
const plainReason = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^(Revision)?Error:\s*/i, "").trim() : "";
/** A conflict (another writer moved the edit on) is its own plain reason. A refusal main put in a
 * sentence follows the note; anything else (a disk, a crash) is just the note. */
export function saveNote(error: unknown): string {
  const reason = plainReason(error);
  if (reason === "Something else changed this edit. Try again." || reason.startsWith("precut is open on this shoot.") || /so it was not applied/.test(reason)) return reason;
  return /^[A-Z][^/\\\n]{0,180}[.!?]$/.test(reason) ? `${SAVE_FAILED} ${reason}` : SAVE_FAILED;
}


/** ARCH2: listings give old versions light. A version this page already holds whole (the same number and save time)
 * stays whole across listings, so a listing never takes back what loadCutVersion or a save's snapshot brought. */
function keepWhole(listed: Cut[], held: Cut[]): Cut[] {
  return listed.map(cut => {
    if (!cut.versions.some(v => v.light)) return cut;
    const prior = held.find(c => c.cutId === cut.cutId), whole = new Map((prior?.versions ?? []).filter(v => !v.light).map(v => [v.version, v]));
    return whole.size ? { ...cut, versions: cut.versions.map(v => v.light && whole.get(v.version)?.createdAt === v.createdAt ? whole.get(v.version)! : v) } : cut;
  });
}
export default function PrecutsPage() {
  const { params, go } = useNav();
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setShoot(null);
    void (async () => {
      try {
        const root = params.shoot ?? (await getApi().listShoots()).find((entry) => entry.online)?.root;
        if (!root) return;
        // The edit list and the likely edit's draft plan start with the shoot, not after it.
        const listing = prefetchCuts(root);
        void listing.then(cuts => {
          const sorted = [...cuts].sort((a, b) => (b.versions.at(-1)?.createdAt ?? "").localeCompare(a.versions.at(-1)?.createdAt ?? ""));
          const remembered = lastShootCut(root);
          const likely = sorted.find(entry => entry.cutId === params.cut) ?? sorted.find(entry => entry.cutId === remembered) ?? sorted[0];
          const latest = likely?.versions.at(-1);
          const linked = likely?.versions.find(entry => entry.version === Number(params.v))?.version;
          if (likely && latest) {
            // VO7: the draft to warm is the current revision's, unless the link names one.
            if (linked !== undefined) prefetchDraft(root, likely.cutId, linked);
            else if (typeof getApi().revisionState !== "function") prefetchDraft(root, likely.cutId, latest.version);
            else void currentRevision(root, likely.cutId).then(current => prefetchDraft(root, likely.cutId, likely.versions.some(entry => entry.version === current) ? current! : latest.version));
          }
        }).catch(() => {});
        const loaded = await getApi().loadShoot(root);
        if (alive) setShoot(loaded);
      } catch { if (alive) setError("Couldn't load this shoot. Check its drive is connected and reopen it."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [params.shoot]);
  useEffect(() => {
    if (!shoot) return;
    let alive = true;
    const reload = (root: string, cut?: { cutId: string; version: number }) => {
      if (root === shoot.root && !cut) void refreshShootWhenQuiet(root).then(loaded => {
        if (alive && loaded) startTransition(() => setShoot(loaded));
      }).catch(() => {});
    };
    const off = getApi().onSidekickChanged(reload), pictures = getApi().onStepsChanged(reload);
    return () => { alive = false; off(); pictures(); };
  }, [shoot?.root]);
  if (loading) return <p role="status" className="text-small text-muted">Loading edits…</p>;
  if (!shoot) return <div className="glass-surface flex h-full flex-col items-center justify-center gap-3 rounded-3xl p-6 text-center"><h1 className="text-display">Pick a shoot first</h1><p className="text-body text-muted">{error ?? "Open a shoot to find ideas and shape an edit."}</p><button type="button" className={ACTION} onClick={() => go("shoots")}>Back to shoots</button></div>;
  return <Workspace key={shoot.root} shoot={shoot} onShootChange={setShoot} />;
}
/** FIX5: the editor reads only whether a job runs on an edit and how it ended. A running job's percent, label and eta
 * change many times a second (a hand save's own "Updating" job among them); they re-render this, never the editor. */
function EditActivities({ root, onChange }: { root: string; onChange: (activities: Activity[]) => void }) {
  const kept = useActivity({ root }).filter(activity => ["cut", "finish", "edit"].includes(activity.kind))
    .map(({ id, kind, state, note, startedAt, root: at, target }) => ({ id, kind, state, note: state === "failed" ? note : null, startedAt, root: at, target: target?.cutId === undefined ? null : { cutId: target.cutId } }) as Activity);
  const key = JSON.stringify(kept), last = useRef("[]");
  useLayoutEffect(() => { if (key !== last.current) { last.current = key; onChange(kept); } });
  return null;
}
function Workspace({ shoot, onShootChange }: { shoot: Shoot; onShootChange: (shoot: Shoot) => void }) {
  const modelReady = useModelAccess();
  const active = usePageActive();
  const state = useSidekickWorkspace(shoot.root);
  const [allActivities, setEditActivities] = useState<Activity[]>([]);
  const activities = allActivities.filter(activity => activity.state === "running");
  const { page, params, go } = useNav();
  const { cut: urlCut, v: urlVersion } = params;
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [formatAspect, setFormatAspect] = useState<"9:16" | "16:9" | "1:1" | "4:5" | undefined>();
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportHost, setExportHost] = useState<HTMLElement | null>(null);
  useEffect(() => { if (active) setExportHost(document.getElementById("edits-topbar-export")); }, [active]);
  const [versionHost, setVersionHost] = useState<HTMLElement | null>(null);
  useEffect(() => { if (active) setVersionHost(document.getElementById("edits-topbar-version")); }, [active]);
  // The top bar holds the one switcher and sidebar toggle; finishing touches live in Claude.
  const [topHosts, setTopHosts] = useState<{ produce: HTMLElement | null; edit: HTMLElement | null; sidebar: HTMLElement | null }>({ produce: null, edit: null, sidebar: null });
  useEffect(() => { if (active) setTopHosts({ produce: document.getElementById("claude-finishing-touches"), edit: document.getElementById("edits-topbar-edit"), sidebar: document.getElementById("edits-topbar-sidebar") }); }, [active]);
  useEffect(() => {
    if (!active) return;
    const find = () => setTopHosts(previous => ({ ...previous, produce: document.getElementById("claude-finishing-touches") }));
    find(); window.addEventListener("precut:claude-compose-ready", find);
    return () => window.removeEventListener("precut:claude-compose-ready", find);
  }, [active]);
  const sidebar = useEditsSidebar(active);
  const [askScreen, setAskScreen] = useState<AskScreenContext | null>(null);
  const [justNew, setJustNew] = useState<number | null>(null);
  const justNewTimer = useRef<number>();
  const prevLatestRef = useRef(new Map<string, number>());
  const pinnedVersionRef = useRef<{ cutId: string; version: number } | null>(null);
  const playingNowRef = useRef(false);
  const pendingFollowRef = useRef<{ cutId: string; version: number; from: number } | null>(null);
  const flushFollowRef = useRef<() => void>(() => {});
  const [savingCut, setSavingCut] = useState(false);
  const savingCutRef = useRef(false);
  const [collapsed, setCollapsed] = useState(() => readPane<boolean>("collapsed", true) === true);
  const [listWidth, setListWidth] = usePane("list", 292, 240, 360);
  const [timelineHeight, setTimelineHeight] = usePane("timeline", 306, 180, 420);
  const [cutsLoading, setCutsLoading] = useState(true);
  const player = useRef<StageHandle>(null);
  const [time, setTime] = useState(0);
  // VO7-11: the player's clock reaches the timeline's playhead every frame through liveTime, with no render.
  // `time` (panels that show it, the timeline's highlight) lands at once when paused, about 4 times a second
  // while playing, and once when a scrub ends. Actions read timeNow, which is always the clock's latest.
  const timeNow = useRef(0), scrubbingTime = useRef(false), playingTime = useRef(false);
  const timeTimer = useRef<ReturnType<typeof setTimeout> | null>(null), timeShownAt = useRef(0);
  const [liveTime] = useState(() => {
    const paints = new Set<(seconds: number) => void>();
    return { now: () => timeNow.current, subscribe(paint: (seconds: number) => void) { paints.add(paint); return () => { paints.delete(paint); }; }, paint(seconds: number) { paints.forEach(paint => paint(seconds)); } };
  });
  function showTime(seconds: number) {
    if (timeTimer.current !== null) { clearTimeout(timeTimer.current); timeTimer.current = null; }
    timeNow.current = seconds; timeShownAt.current = Date.now(); setTime(seconds);
  }
  function playerTime(seconds: number) {
    timeNow.current = seconds; liveTime.paint(seconds);
    if (scrubbingTime.current) return;
    if (!playingTime.current) { showTime(seconds); return; }
    if (timeTimer.current !== null) return;
    const wait = 250 - (Date.now() - timeShownAt.current);
    if (wait <= 0) showTime(seconds);
    else timeTimer.current = setTimeout(() => { timeTimer.current = null; showTime(timeNow.current); }, wait);
  }
  function scrubTime(active: boolean) { scrubbingTime.current = active; if (!active) showTime(timeNow.current); }
  useEffect(() => {
    const playing = (event: Event) => { playingTime.current = !!(event as CustomEvent).detail; if (!playingTime.current) showTime(timeNow.current); };
    window.addEventListener("sidething:playing", playing);
    return () => { window.removeEventListener("sidething:playing", playing); if (timeTimer.current !== null) clearTimeout(timeTimer.current); };
  }, []);
  const [source,setSource] = useState<SourceRange | null>(null);
  const sourceRangeNow = useRef<SourceRange | null>(null);
  const [selectedPiece, setSelectedPiece] = useState<number | null>(null);
  const [selectedPieces, setSelectedPieces] = useState<number[]>([]);
  const [selectedVoices, setSelectedVoices] = useState<string[]>([]);  // VO6/VO7-8: voice pieces on the Voiceover lane (⌘-click adds)
  const [selectedGap, setSelectedGap] = useState<{ s: number; e: number } | null>(null);  // VO7-8: a gap on the Voiceover lane
  const [timelineTool, setTimelineTool] = useState<TimelineTool>("select");  // VO7-8: Select (A) or Blade (B)
  const [timelineHint, setTimelineHint] = useState<string | null>(null), hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showHint(text: string) { if (hintTimer.current) clearTimeout(hintTimer.current); setTimelineHint(text); hintTimer.current = setTimeout(() => { hintTimer.current = null; setTimelineHint(null); }, 2500); }
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);
  /** VO7-8: takes copied in from Finder this session, so the local reducer knows them before the shoot reloads. */
  const importedTakes = useRef<AudioFile[]>([]);
  const [transformMode, setTransformMode] = useState(false);
  const [shotOrderTarget,setShotOrderTarget]=useState<{cutId:string;version:number;pieces?:number[]}>();
  const [selectedJoin, setSelectedJoin] = useState<number | null>(null);
  const [searchControl, setSearchControl] = useState<ControlEntry | null>(null);
  const pendingSearch = useRef<SearchResult | null>(null);
  const [preparationRevision, setPreparationRevision] = useState(0);
  const [draftPlayback, setDraftPlayback] = useState<{ key: string; timeline: DraftTimeline | null; failed: boolean; error?: string } | null>(null);
  const draftSnapshots = useRef(new Map<string, DraftTimeline>());
  function rememberDraft(key: string, timeline: DraftTimeline) {
    draftSnapshots.current.set(key,timeline);
    if(draftSnapshots.current.size>64){const oldest=draftSnapshots.current.keys().next().value!;draftSnapshots.current.delete(oldest);}
  }
  useEffect(()=>{draftSnapshots.current.clear();},[preparationRevision]);
  // VO7-3: one local document per edit on its way to main. Undo and redo swap documents at once;
  // the history queues the same move for main behind the pending commits.
  /** Every listing of the edits is applied in the order it was asked for: a read that started before a save
   * and answers after a newer one never puts the older list back (the lane flashed the step before). */
  const listing = useRef({ asked: 0, applied: 0 });
  async function listInOrder(root: string, prefetched?: Promise<Cut[]>): Promise<{ cuts: Cut[]; current: boolean }> {
    // FIX5: a listing this page starts is offered to the Library, which then reads it instead of listing again.
    const read = prefetched ?? getApi().listCuts(root);
    if (!prefetched) window.dispatchEvent(new CustomEvent("precut:cuts-listing", { detail: { root, cuts: read } }));
    const asked = ++listing.current.asked, cuts = keepWhole(await read, cutsRef.current);
    if (asked < listing.current.applied) return { cuts, current: false };
    listing.current.applied = asked; return { cuts, current: true };
  }
  const localDocRef = useRef<LocalDoc | null>(null);
  const [localDoc, setLocalDoc] = useState<LocalDoc | null>(null);
  const [dragPreview, setDragPreview] = useState<{ key: string; timeline: DraftTimeline } | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const voiceIds = useRef(new Map<string, string>());
  const wantOpen = useRef<Selection | null>(null);
  const trimGesture = useRef(false);
  const historyRef = useRef<EditHistory | null>(null);  // the open edit's history, for work that lands later
  const receivedHandSnapshots = useRef(new Set<string>());
  const unseenChanges = useRef(new Set<string>());
  const localPaint = useRef(0), paintPending = useRef(false);
  const pendingSavedOpen = useRef<(() => void) | null>(null);
  /** `seek` only for the edit being made now: a magnetic trim shows its edge once. Undo, redo and a saved
   * step landing never move the playhead (an older trim's edge is not where the playhead is now). */
  function showDoc(doc: LocalDoc | null, seek = false) {
    localDocRef.current = doc; setLocalDoc(doc);
    const turn = ++localPaint.current;
    paintPending.current = !!doc;
    if (doc) requestAnimationFrame(() => setTimeout(() => {
      if (turn !== localPaint.current) return;
      paintPending.current = false;
      const open = pendingSavedOpen.current; pendingSavedOpen.current = null; open?.();
    }, 0));
    if (seek && doc?.time !== undefined) edgeSeek.current = Math.min(doc.time, doc.timeline.durationS);
  }
  const currentDraftKey = useRef('');
  const [transcriptPreview, setTranscriptPreview] = useState<{ root: string; cutId: string; version: CutVersion } | null>(null);
  useEffect(() => {
    const preview = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.root === shoot.root && detail.cutId === selectedCutRef.current) setTranscriptPreview(detail.version ? detail : null); };
    window.addEventListener("sidething:transcript-preview", preview);
    return () => window.removeEventListener("sidething:transcript-preview", preview);
  }, []);
  const [liveMedia, setLiveMedia] = useState<{ key: string; failed: boolean } | null>(null);
  const [laneVisibility, setLaneVisibility] = useState<LaneVisibility>({});
  const [liveTitles, setLiveTitles] = useState<{ key: string; titles: TitleTrack | null } | null>(null);
  const [lookTexture, setLookTexture] = useState<Pick<Grade, "detail" | "grain" | "vignette">>({});
  const lookPending = useRef(new Map<string, number>());
  const [lookBypassed, setLookBypassed] = useState(false);
  useEffect(() => { const enable=()=>setLookBypassed(false); window.addEventListener("precut:look-adjust",enable); return ()=>window.removeEventListener("precut:look-adjust",enable); }, []);
  useEffect(() => { if (!active || page !== "precuts") setLookBypassed(false); }, [active, page]);
  const [lookPreviewPiece, setLookPreviewPiece] = useState<number | undefined>();
  const [liveChoice, setLiveChoice] = useState<{ key: string; look: LiveLook } | null>(null);
  const busyCuts = useRef(new Set<string>());
  const [, refreshBusy] = useState(0);
  const selectedCutRef = useRef<string | undefined>();
  const setCutBusy = (cutId: string, value: boolean) => { if (value) busyCuts.current.add(cutId); else busyCuts.current.delete(cutId); refreshBusy(n => n + 1); };
  const editingRef = useRef(false);
  // FIX4: one owner per key. From a save with no local plan starting until the timeline shows its version (keyGate), an
  // editing key is handed to the timeline's hold, which replays it then; otherwise it runs now. Never both.
  const holdKey = useRef<((event: KeyboardEvent) => void) | null>(null);
  const keyGate = useRef<{ saving: boolean; until: number | null }>({ saving: false, until: null });
  const orHold = (run: () => void) => (event?: KeyboardEvent) => { if (keyGate.current.saving && event && holdKey.current) { holdKey.current(event); return; } run(); };
  const [undo, setUndo] = useState<UndoSelection | null>(null);
  const [undoNotice, setUndoNotice] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // CH2: the edits list collapses when the editor pane (the window less Claude's pane) is under 1280 px.
  const narrow = useEditorNarrow();
  const [panel, setLocalPanel] = useState<EditsPanel | null>(null);
  const [browsing, setBrowsing] = useState(false);  // RAIL1: Clips' footage browser (the old Media panel) is open
  const setPanel = (next: EditsPanel | null | ((current: EditsPanel | null) => EditsPanel | null)) => {
    const value = typeof next === "function" ? next(panel) : next;
    // CH2: Ask is Claude's pane now. Anything that opened the Ask sheet shows that pane and leaves the open panel be.
    if (value === "ask") { showClaude(); return; }
    if (!(value === "clips" && panel === "clips")) { setSource(null); setBrowsing(false); }
    setLocalPanel(value);
  };
  const [scope, setScope] = useState<"edit" | "clip">("edit");
  const printsCollapsed = narrow || collapsed;
  const closeSheet = () => { setPanel(null); setReplaceTarget(null); clearOverlay(); };
  const togglePanel = (next: EditsPanel) => {
    clearOverlay(); setSelectedJoin(null); setSearchControl(null); setReplaceTarget(null);
    setPanel(current => current === next ? null : next);
  };
  const workspace = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const applyingUrl = useRef<Selection | null>(null);
  const displayedSelection = useRef<Selection | null>(null);
  const [initialVersions] = useState(()=>{
    const saved=readPane<unknown>(`edit-versions:${shoot.root}`,{});
    return saved && typeof saved==='object' && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([,v])=>typeof v==='number' && Number.isSafeInteger(v) && v>0)) as Record<string,number> : {};
  });
  const rememberedVersions = useRef<Record<string, number>>(initialVersions);
  const persistVersions=()=>{void Promise.resolve().then(()=>savePane(`edit-versions:${shoot.root}`,{...rememberedVersions.current}));};
  const menuId = useId();
  const { reduced } = useMotionPresets();
  useEffect(() => {
    if (!undoNotice) return;
    const timer = window.setTimeout(() => setUndoNotice(false), 6000);
    return () => window.clearTimeout(timer);
  }, [undoNotice, undo]);
  useEffect(() => getApi().onActivity?.(activity => {
    if (activity.root === shoot.root && activity.state === 'done' && ['Preparing background', 'Measuring clip colour', 'Preparing sound', 'Preparing voice waveform', 'Reversing clip', 'Measuring music', 'Arranging music', 'Following a pinned thing'].includes(activity.label)) setPreparationRevision(value => value + 1);
  }), [shoot.root]);
  useEffect(() => getApi().onProgress((event) => {
    if (event.root === shoot.root && event.clipId === state.selection?.cutId && event.stage === "proxy") setProgress(event.pct);
  }), [shoot.root, state.selection?.cutId]);
  useEffect(() => {
    let alive = true;
    let request = 0;
    let playing = false, stale = false, loading = false, again = false;
    const refresh = async () => {
      if (playing) { stale = true; return; }
      // Preview repairs announce changes faster than a 300-version history can be
      // read: keep one read in flight and one trailing refresh, never a pile.
      if (loading) { again = true; return; }
      const current = ++request;
      loading = true;
      try {
        const { cuts: results, current: newest } = await listInOrder(shoot.root, current === 1 ? takeCuts(shoot.root) : undefined);
        if (!alive || request !== current) return;
        if (!newest) { setError(null); return; }  // a newer listing already landed
        const sorted = [...results].sort((a, b) => (b.versions.at(-1)?.createdAt ?? "").localeCompare(a.versions.at(-1)?.createdAt ?? ""));
        // Listings contain the whole history. Never stringify it twice in an
        // input turn; React can interrupt this background update for local undo.
        if (current === 1) setCuts(sorted);
        else startTransition(() => setCuts(sorted));
        setError(null);
      } catch { if (alive && request === current) setError("Couldn't load the edits. Check the drive is connected and reopen Edits."); }
      finally { if (request === current) { loading = false; if (alive) setCutsLoading(false); if (alive && again) { again = false; void refresh(); } } }
    };
    // A cache completion can publish the entire saved history. Defer that IPC,
    // comparison and React update until Pause, including an in-flight refresh.
    const playback = (event: Event) => {
      const next = !!(event as CustomEvent<boolean>).detail;
      if (next === playing) return;
      playing = next;
      if (playing && loading) { request++; loading = false; stale = true; }
      else if (!playing && stale) { stale = false; void refresh(); }
    };
    window.addEventListener('sidething:playing', playback);
    window.dispatchEvent(new CustomEvent('sidething:playing-request'));
    void refresh();
    const refreshSkills = () => { void getApi().listSkills().then((value) => { if (alive) setSkills(value); }).catch(() => {}); };
    refreshSkills();
    const offSkills = getApi().onSkillsChanged(refreshSkills);
    const off = getApi().onSidekickChanged((root, cut) => {
      // A hand save returns its one snapshot. Its own notification must not
      // race that response with another copy of the entire history.
      if (cut && receivedHandSnapshots.current.has(`${cut.cutId}:${cut.version}`)) return;
      if (root !== shoot.root) return;
      // A notice that lands while a save is held is kept, not dropped: the
      // save's completion reconciles it with one listing (see settle).
      if (historyRef.current?.saving) { unseenChanges.current.add(cut ? `${cut.cutId}:${cut.version}` : '*'); return; }
      void refresh();
    });
    return () => { alive = false; off(); offSkills(); window.removeEventListener('sidething:playing', playback); };
  }, [shoot.root]);
  // Location changes win over the shared chat selection. Refreshes leave it alone.
  // The link this page writes for its own selection is never read back as a new location: its hashchange can
  // land after a newer selection (⌘Z during a slow render), and reopening it brought the undone edit back.
  const ownLinks = useRef<string[]>([]);
  useEffect(() => {
    if (cutsLoading) return;
    const own = ownLinks.current.indexOf(`${urlCut}:${urlVersion}`);
    if (own >= 0) { ownLinks.current = ownLinks.current.slice(own + 1); return; }
    const remembered = lastShootCut(shoot.root);
    // POLISH1: with nothing named or remembered, the most recent edit (the newest saved version), never just the first listed.
    const newest = [...cuts].sort((a, b) => (b.versions.at(-1)?.createdAt ?? "").localeCompare(a.versions.at(-1)?.createdAt ?? ""))[0];
    const chosen = cuts.find((entry) => entry.cutId === urlCut) ?? cuts.find((entry) => entry.cutId === state.selection?.cutId) ?? cuts.find((entry) => entry.cutId === remembered) ?? newest;
    const latest = chosen?.versions.at(-1);
    if (!chosen || !latest) return;
    const linked = chosen.versions.find((entry) => entry.version === Number(urlVersion));
    const open = (version: number) => { const selection = { cutId: chosen.cutId, version }; applyingUrl.current = selection; selectSidekickCut(shoot.root, selection); };
    // VO7: an edit opens on its current revision unless the link names a version.
    if (!linked && typeof getApi().revisionState === "function") {
      let alive = true;
      void currentRevision(shoot.root, chosen.cutId).then(current => { if (alive) open(chosen.versions.find(entry => entry.version === current)?.version ?? latest.version); });
      return () => { alive = false; };
    }
    const requested = linked ?? (!urlCut ? chosen.versions.find(entry=>entry.version===rememberedVersions.current[chosen.cutId]) : undefined);
    open(requested?.version ?? latest.version);
  }, [urlCut, urlVersion, cutsLoading, shoot.root]);
  useEffect(() => {
    const selected = state.selection;
    if (!selected || cutsLoading) return;
    if (applyingUrl.current && (applyingUrl.current.cutId !== selected.cutId || applyingUrl.current.version !== selected.version)) return;
    applyingUrl.current = null;
    if (!cuts.some((entry) => entry.cutId === selected.cutId)) return;
    const changed = displayedSelection.current?.cutId !== selected.cutId || displayedSelection.current.version !== selected.version;
    if (changed) { rememberedVersions.current[selected.cutId] = selected.version; displayedSelection.current = selected; persistVersions(); rememberShootCut(shoot.root, selected.cutId); }
    // An exiting page must never pull navigation back to Precut.
    if (active && page === "precuts" && (urlCut !== selected.cutId || urlVersion !== String(selected.version))) {
      // No hashchange comes when the location already says it (edit ids and versions need no decoding).
      const there = ((window.location?.hash ?? "").split("?")[1] ?? "").split("&");
      if (!there.includes(`cut=${selected.cutId}`) || !there.includes(`v=${selected.version}`)) ownLinks.current = [...ownLinks.current.slice(-15), `${selected.cutId}:${selected.version}`];
      go("precuts", { shoot: shoot.root, cut: selected.cutId, v: String(selected.version), ...(params.control ? { control: params.control } : {}) });
    }
  }, [state.selection, cuts, cutsLoading, shoot.root, urlCut, urlVersion, go, page, active]);
  useEffect(() => {
    if (!active || !menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !menuButton.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen, active]);
  const cut = cuts.find((entry) => entry.cutId === state.selection?.cutId) ?? cuts[0];
  useEffect(() => { setFormatAspect(undefined); setTransformMode(false); }, [cut?.cutId]);
  useEffect(() => { if (panel !== "clips") setTransformMode(false); }, [panel]);
  selectedCutRef.current = cut?.cutId;
  const editing = !!cut && busyCuts.current.has(cut.cutId);
  editingRef.current = editing;
  const regenerating = Boolean(state.pending?.context.cutId && state.pending.context.cutId === cut?.cutId);
  const stageActivity = activities.find(activity => activity.kind === "cut" && activity.target?.cutId === cut?.cutId);
  // ARCH2: a listing gives old versions light (the versions menu's fields). One is never shown or edited from: the page
  // asks main for it whole (loadCutVersion) and shows it when it lands.
  const listedVersion = cutVersion(cut, state.selection?.version);
  const version = listedVersion?.light ? undefined : listedVersion;
  useEffect(() => {
    if (!cut || !listedVersion?.light || typeof getApi().loadCutVersion !== "function") return;
    const id = cut.cutId, number = listedVersion.version;
    const splice = (list: Cut[], whole: CutVersion) => list.map(c => c.cutId !== id ? c : { ...c, versions: c.versions.map(v => v.version === number && v.light ? whole : v) });
    void getApi().loadCutVersion!(shoot.root, id, number).then(whole => {
      cutsRef.current = splice(cutsRef.current, whole); setCuts(list => splice(list, whole));
    }).catch(() => { if (selectedCutRef.current === id) setEditError("Couldn't open that version. Try again."); });
  }, [shoot.root, cut?.cutId, listedVersion?.version, listedVersion?.light]);
  useEffect(() => {
    if (!active || page !== "precuts" || !cut || version?.videoType !== "voiceover") return;
    const key = `voiceover-opened:${shoot.root}:${cut.cutId}`;
    if (readPane<boolean>(key, false)) return;
    savePane(key, true);
    setPanel("script");
  }, [active, page, shoot.root, cut?.cutId, version?.videoType]);
  const draftKey = `${shoot.root}:${cut?.cutId}:${version?.version}:${formatAspect ?? "base"}`;
  currentDraftKey.current = draftKey;
  const playbackKey = `${shoot.root}:${cut?.cutId}:${formatAspect ?? "base"}`;
  const retainedDraft = useRef<{ key: string; timeline: DraftTimeline }>();
  if (draftPlayback?.key === draftKey && draftPlayback.timeline) retainedDraft.current = {key:playbackKey,timeline:draftPlayback.timeline};
  const timeline = draftPlayback?.key === draftKey ? draftPlayback.timeline : draftSnapshots.current.get(draftKey) ?? (retainedDraft.current?.key === playbackKey ? retainedDraft.current.timeline : null);
  // A completed waveform changes only the lane. Keep the live player's timeline
  // identity when the saved pictures and master sound are unchanged.
  const playbackTimeline = useRef<{ key: string; source: DraftTimeline | null; timeline: DraftTimeline | null }>();
  if (playbackTimeline.current?.key !== draftKey || playbackTimeline.current?.source !== timeline) {
    const previous = playbackTimeline.current;
    const same = previous?.key === draftKey && JSON.stringify({ ...previous.timeline, voice: null, cover: null }) === JSON.stringify({ ...timeline, voice: null, cover: null });
    playbackTimeline.current = { key: draftKey, source: timeline, timeline: same ? previous.timeline : timeline };
  }
  const trimmingDocument = localDoc?.key === playbackKey ? localDoc : null;
  const documentVersion = trimmingDocument?.version ?? (transcriptPreview?.root === shoot.root && transcriptPreview.cutId === cut?.cutId && transcriptPreview.version.version === version?.version ? transcriptPreview.version : version);
  const transcriptPlan = useRef<{ source: DraftTimeline; version: CutVersion; timeline: DraftTimeline }>();
  if (!trimmingDocument && documentVersion && documentVersion !== version && playbackTimeline.current.timeline && (transcriptPlan.current?.source !== playbackTimeline.current.timeline || transcriptPlan.current?.version !== documentVersion)) {
    transcriptPlan.current = { source: playbackTimeline.current.timeline, version: documentVersion, timeline: transcriptTimeline(playbackTimeline.current.timeline, documentVersion) };
  }
  const stageTimeline = (dragPreview?.key === playbackKey ? dragPreview.timeline : undefined) ?? trimmingDocument?.timeline ?? (documentVersion !== version && transcriptPlan.current && transcriptPlan.current.version === documentVersion ? transcriptPlan.current.timeline : playbackTimeline.current.timeline);
  const draftFailed = draftPlayback?.key === draftKey && draftPlayback.failed;
  const overlaySession = useOverlaySession(stageTimeline);
  useEffect(() => { setLiveChoice(null); showTime(0); setEditError(null); }, [playbackKey]);
  const loadedCut = useRef<{key:string; signature:string; revision:number; version:number; look:string}>();
  const signature = version ? cutSignature(version) : "";
  const savedLook = JSON.stringify([version?.grade,version?.pieceFx?.map(fx=>fx?.look)]);
  useEffect(() => {
    let alive = true;
    if (!cut || !version) { setDraftPlayback(null); return; }
    // The link asked for another version than the one shown for this first render: wait for it instead of building a plan nobody opens.
    const linked = cut.cutId === urlCut ? cut.versions.find(entry => entry.version === Number(urlVersion))?.version : undefined;
    if (cutsLoading || !loadedCut.current && linked !== undefined && linked !== version.version) return;
    const prior = loadedCut.current;
    const cached = draftSnapshots.current.get(draftKey);
    if (cached) {
      loadedCut.current = {key:playbackKey,signature,revision:preparationRevision,version:version.version,look:savedLook};
      setDraftPlayback({key:draftKey,timeline:cached,failed:false});
      return;
    }
    if (prior?.key === playbackKey && prior.signature === signature && prior.revision === preparationRevision && retainedDraft.current?.key === playbackKey) {
      if (prior.version !== version.version) {
        // Remembered like a fetched plan, so undo and redo between these versions never wait for an effect.
        const finished=finishTimeline(retainedDraft.current.timeline,version,shoot.root);if(prior.look===savedLook)rememberDraft(draftKey,finished);
        setDraftPlayback({key:draftKey,timeline:finished,failed:false});
        loadedCut.current = {...prior,version:version.version,look:savedLook};
        if (prior.look !== savedLook && typeof getApi().pieceLuts === 'function') {
          void getApi().pieceLuts(shoot.root,cut.cutId,version.version,{preset:version.grade?.preset ?? 'clean',intensity:version.grade?.intensity ?? .7,basic:version.grade?.basic,mixer:version.grade?.mixer,matchClips:version.grade?.matchClips,matchRef:version.grade?.matchRef}).then(ids=>{
            if (!alive) return;
            setDraftPlayback(current=>current?.key===draftKey && current.timeline ? {...current,timeline:{...current.timeline,pieces:current.timeline.pieces.map((piece,i)=>({...piece,lut:ids[i] ?? piece.lut}))}} : current);
            setLiveChoice({key:playbackKey,look:ids});
          }).catch(error=>{if(alive)setEditError(error instanceof Error ? error.message : "Couldn't update live colour.");});
        }
      }
      return () => { alive = false; };
    }
    void Promise.resolve().then(() => takeDraft(shoot.root, cut.cutId, version.version, formatAspect, preparationRevision) ?? getApi().draftTimeline(shoot.root, cut.cutId, version.version, formatAspect)).then(timeline => {
      if (timeline.durationS < 0) throw new Error("This draft has no playable footage.");
      if (alive) { rememberDraft(draftKey,timeline); loadedCut.current = {key:playbackKey,signature,revision:preparationRevision,version:version.version,look:savedLook}; setDraftPlayback({ key: draftKey, timeline, failed: false }); }
    }).catch(cause => { if (alive) { const error = draftFailure(cause); console.error("Live playback failed", { cutId: cut.cutId, version: version.version, error }); setDraftPlayback({ key: draftKey, timeline: null, failed: true, error }); } });
    return () => { alive = false; };
  }, [draftKey, signature, preparationRevision, cutsLoading, urlCut, urlVersion]);
  const openCut = (cutId: string, next: number, preservePlayback = false) => {
    if (editingRef.current && cutId === selectedCutRef.current) return;
    showDoc(null); setDragPreview(null); wantOpen.current = null;
    const snapshotKey=`${shoot.root}:${cutId}:${next}:${formatAspect ?? 'base'}`;
    const snapshot=draftSnapshots.current.get(snapshotKey);
    if(snapshot)setDraftPlayback({key:snapshotKey,timeline:snapshot,failed:false});
    if (!preservePlayback && cutId !== selectedCutRef.current) { setLiveChoice(null); workspace.current?.querySelectorAll("video").forEach((video) => video.pause()); player.current?.stopPreview(); showTime(0); }
    if (cutId !== selectedCutRef.current) setSelectedPiece(null);
    setMenuOpen(false); applyingUrl.current = null;
    const latestKnown = cuts.find((entry) => entry.cutId === cutId)?.versions.at(-1)?.version;
    if (latestKnown !== undefined) pinnedVersionRef.current = next < latestKnown ? { cutId, version: next } : null;
    rememberedVersions.current[cutId] = next;persistVersions();
    selectSidekickCut(shoot.root, { cutId, version: next });
  };
  async function saveNewEdit(source?: Selection, fromSelection = false) {
    if (savingCutRef.current) return;
    savingCutRef.current = true; setSavingCut(true); setError(null);
    try {
      const api = getApi();
      const saved = source ? await api.duplicateCut(shoot.root, source.cutId, source.version) : await api.createCut(shoot.root, fromSelection ? { from: selectedSources(shoot.root) } : {});
      const listed = await listInOrder(shoot.root); if (listed.current) setCuts(listed.cuts); openCut(saved.cutId, saved.version, true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this edit."); }
    finally { savingCutRef.current = false; setSavingCut(false); }
  }
  async function starSavedCut(id: string, starred: boolean) {
    try { await getApi().starCut(shoot.root, id, starred); const listed = await listInOrder(shoot.root); if (listed.current) setCuts(listed.cuts); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save this star."); }
  }
  useEffect(() => {
    if (!cut || !version) return;
    const at = timeline?.pieces.find(piece => piece.layer === 0 && piece.startS <= time && time < piece.endS)?.piece ?? version.pieces?.length ?? 0;
    try { localStorage.setItem(`sidething.insert:${shoot.root}:${cut.cutId}`, JSON.stringify({ version: version.version, at })); } catch { /* End insertion remains available. */ }
  }, [shoot.root, cut?.cutId, version?.version, timeline, time]);
  const [replaceTarget, setReplaceTarget] = useState<number | null>(null);
  function browseMedia(piece: number | null = null) {
    player.current?.stopPreview(); setReplaceTarget(piece); setPanel("clips"); setBrowsing(true);
  }
  function backToClips() { setSource(null); setReplaceTarget(null); setBrowsing(false); }
  useEffect(() => {
    const browse = (event: Event) => { const detail = (event as CustomEvent).detail; if (active && detail?.root === shoot.root) browseMedia(detail.piece ?? null); };
    window.addEventListener("sidething:browse-media", browse);
    return () => window.removeEventListener("sidething:browse-media", browse);
  }, [shoot.root, active]);
  useEffect(() => { setReplaceTarget(null); }, [cut?.cutId]);
  useEffect(() => { setSource(null); sourceRangeNow.current=null; }, [cut?.cutId,version?.version,shoot.root]);
  function previewSource(item: FootageItem) {
    const range=sourceRange(item.clip,item.attempt?item:undefined);
    if(range.e<=range.s || item.clip.missing)return;
    player.current?.pause?.();sourceRangeNow.current=range;setSource(range);
  }
  const sourceLanding=source && version ? sourcePlacement(version,stageTimeline,time,shoot) : undefined;
  async function insertSource(append: boolean) {
    if(!source || !version || editingRef.current)return;
    const placement=sourcePlacement(version,stageTimeline,timeNow.current,shoot,append);
    const insert:CutEdit={kind:'insert',at:placement.at,source:sourceRangeNow.current ?? source};
    const saved=await editCut(insert);
    if(saved)setSource(null);
  }
  const dragPlan = useRef<{key:string; timeline:DraftTimeline}>();
  const edgeSeek = useRef<number>();
  useLayoutEffect(() => { if (edgeSeek.current !== undefined) { player.current?.seek(edgeSeek.current); edgeSeek.current=undefined; } }, [stageTimeline]);
  function pictureEdit(base: DraftTimeline, edit: CutEdit, on: CutVersion = version!):DraftTimeline {
    return edit.kind === "move" || edit.kind === "trim" && "magnetic" in edit || edit.kind==='batch' && edit.edits.every(e=>e.kind==='move' || e.kind==='trim' && 'magnetic' in e) ? magneticPreview(base,edit) : edit.kind === "batch" ? edit.edits.reduce((plan,change)=>pictureEdit(plan,change,on),base) : optimisticTimeline(base,edit,on,shoot);
  }
  const shownDoc = () => localDocRef.current?.key === playbackKey ? localDocRef.current : null;
  function previewEdit(edit: CutEdit | null, seek?: number) {
    if (!timeline || !version || editingRef.current) return;
    if (!edit) { setDragPreview(null); dragPlan.current=undefined; edgeSeek.current=undefined; return; }
    const shown = shownDoc();
    if (dragPlan.current?.key !== playbackKey) dragPlan.current={key:playbackKey,timeline:shown?.timeline ?? timeline};
    edgeSeek.current=seek;
    setDragPreview({key:playbackKey,timeline:pictureEdit(dragPlan.current.timeline,edit,shown?.version ?? version)});
  }
  const cutsRef = useRef(cuts); cutsRef.current = cuts;
  /** What is on screen right now: the newest local document, else the saved version. */
  function currentDoc(): LocalDoc | null {
    const shown = shownDoc();
    if (shown) return shown;
    // A drag preview is not the edit yet: the edit it ends in applies to the timeline the drag started on.
    // (A move applied to its own preview is a move to where the clip already is, and saves nothing.)
    const dragged = dragPlan.current?.key === playbackKey ? dragPlan.current.timeline : undefined;
    const plan = dragged ?? stageTimeline ?? timeline, doc = documentVersion ?? version;
    return plan && doc ? { key: playbackKey, version: doc, timeline: plan } : null;
  }
  function reordered(base: LocalDoc, edit: CutEdit, plan: DraftTimeline): LocalDoc | null {
    return plan === base.timeline ? null : { key: base.key, timeline: plan, version: base.version };
  }
  /** VO7-3: the synchronous local reducer. The edit applied to what is on screen, or null when it has
   * no local plan (it then saves blocking, as before). Throws an impossible edit's plain sentence. */
  function localStep(base: LocalDoc, edit: CutEdit): LocalDoc | null {
    if (edit.kind === "batch") {
      if (edit.edits.every(e => e.kind === "move" || e.kind === "trim" && "magnetic" in e)) return reordered(base, edit, magneticPreview(base.timeline, edit));
      let doc = base;
      for (const change of edit.edits) { const next = localStep(doc, change); if (!next) return null; doc = next; }
      return doc === base ? null : doc;
    }
    if (edit.kind === "trim" && "magnetic" in edit && edit.magnetic) {
      const plan = magneticPreview(base.timeline, edit), spans = plan.pieces.filter(p => p.layer === 0), trimmed = spans.filter(p => p.piece === edit.piece);
      if (!trimmed.length) return null;
      const time = edit.s !== base.version.pieces?.[edit.piece]?.s ? trimmed[0].startS : Math.max(trimmed[0].startS, trimmed.at(-1)!.endS - 1 / (plan.fps ?? 25));
      return { key: base.key, time, exact: true, timeline: plan, version: { ...base.version, lengthS: plan.durationS,
        pieces: base.version.pieces?.map((p, i) => { const group = spans.filter(s => s.piece === i); return { ...p, ...(i === edit.piece ? { s: edit.s, e: edit.e } : {}), ...(group.length ? { timelineS: group[0].startS, lengthS: group.at(-1)!.endS - group[0].startS } : {}) }; }),
        titles: plan.titles ?? undefined, overlays: plan.overlays } };
    }
    if (edit.kind === "move") return reordered(base, edit, magneticPreview(base.timeline, edit));
    const known = importedTakes.current.filter(take => !shoot.audio?.some(a => a.file === take.file));
    const plan = optimisticTimeline(base.timeline, edit, base.version, known.length ? { ...shoot, audio: [...shoot.audio ?? [], ...known] } : shoot);
    if (plan === base.timeline) return QUEUE_WITHOUT_PLAN.has(edit.kind) ? base : null;
    return { key: base.key, timeline: plan, version: optimisticVersion(base.version, edit, plan) };
  }
  function editLabel(edit: CutEdit, on: CutVersion) {
    const label = edit.kind === "cutWords" ? `cut '${edit.spans.map(span => {
      const clipId = on.pieces?.[span.piece]?.clipId;
      return shoot.clips.find(clip => clip.id === clipId)?.transcript?.flatMap(line => line.words).filter(word => word.s < span.e && word.e > span.s).map(word => word.w).join(" ") || "words";
    }).join(" ")}'` : ({ insert: "insert clip", remove: "remove clip", split: "split clip", trim: "trim clip", move: "move clip", shotOrder: "put in shot order", swap: "swap take", replace: "Replace shot", join: "change transition", pieceFx: "change clip controls", overlay: "change overlay", restoreWords: "restore words", removeFillers: "remove fillers", tightenPauses: "tighten pauses", cover: "change cover", voiceover: edit.kind === "voiceover" ? ({ placeAsIs: "place take as is", split: "split voiceover", trim: "trim voiceover", move: "move voiceover", remove: "remove voiceover piece" } as const)[edit.op] : undefined } as Partial<Record<CutEdit["kind"], string>>)[edit.kind] ?? (edit.kind === "batch" ? edit.label : "update edit");
    const targetName = "piece" in edit && typeof edit.piece === "number" ? pieceName(shoot, on, edit.piece) : null;
    return { label: targetName ? `${label}: ${targetName}` : label, targetName };
  }
  /** Open a saved version, carrying the local document as its plan until main's draft arrives, so
   * nothing flashes back. An exact plan (a magnetic trim) is that version's plan. */
  function openSaved(id: string, next: number, carry: LocalDoc | null) {
    // Saved selection flushes a full workspace render. Give the local edit or
    // undo its frame first, even when main answers before that frame paints.
    if (paintPending.current) {
      pendingSavedOpen.current = () => {
        const h = historyRef.current;
        if (selectedCutRef.current === id && h?.version === next && !h.saving) openSaved(id, next, localDocRef.current);
      };
      return;
    }
    // Selection is synchronous: publish the saved revision first. Otherwise cutVersion
    // falls back to the hidden newest snapshot while React still holds the old listing.
    flushSync(() => setCuts(cutsRef.current));
    const key = `${shoot.root}:${id}:${next}:${formatAspect ?? 'base'}`;
    if (carry) {
      // The saved version numbers pieces by spine position: the selection follows the same pieces.
      const order = spineOrder(carry.timeline), at = (piece: number) => { const i = order.indexOf(piece); return i < 0 ? piece : i; };
      if (order.some((piece, i) => piece !== i)) { setSelectedPieces(list => list.map(at)); setSelectedPiece(piece => piece === null ? piece : at(piece)); }
    }
    if (carry && !draftSnapshots.current.has(key)) {
      // A moved clip keeps its place, under the saved version's own piece numbers.
      const plan = savedNumbering(carry.timeline);
      if (carry.exact) rememberDraft(key, plan);
      // Selection is an external store and renders synchronously. Publish its lane first,
      // before openCut clears the local document, or the retained pre-split lane flashes.
      else flushSync(() => setDraftPlayback({ key, timeline: plan, failed: false }));
    }
    openCut(id, next, true);
  }
  /** The history's way to show a saved step: at once when it is listed, else after the next listing. */
  function showSaved(next: number, mode?: "refresh" | "after-local") {
    const id = selectedCutRef.current; if (!id) return;
    if (mode === "after-local" && paintPending.current) {
      pendingSavedOpen.current = () => { if (selectedCutRef.current === id && historyRef.current?.version === next) showSaved(next, "refresh"); };
      return;
    }
    if (!cutsRef.current.find(c => c.cutId === id)?.versions.some(v => v.version === next)) { wantOpen.current = { cutId: id, version: next }; void settle(id, !!mode); return; }
    if (mode) {
      // A conflict needs the saved plan, never the rejected document or a
      // retained plan from the peek. Keep the lane until that plan is ready.
      pendingSavedOpen.current = null;
      const key = `${shoot.root}:${id}:${next}:${formatAspect ?? 'base'}`;
      const publish = (plan: DraftTimeline) => {
        const current = () => selectedCutRef.current === id && historyRef.current?.version === next && !historyRef.current.saving;
        if (!current()) return;
        const open = () => {
          if (!current()) return;
          rememberDraft(key, plan);
          flushSync(() => setDraftPlayback({ key, timeline: plan, failed: false }));
          openSaved(id, next, null); setUndoNotice(false);
        };
        if (paintPending.current) pendingSavedOpen.current = open; else open();
      };
      const cached = draftSnapshots.current.get(key);
      if (cached) publish(cached);
      else void getApi().draftTimeline(shoot.root, id, next, formatAspect).then(publish).catch(() => {
        if (selectedCutRef.current === id && historyRef.current?.version === next) setEditError("Couldn't refresh the edit. Reopen Edits to see the saved version.");
      });
      return;
    }
    const carry = localDocRef.current?.key === `${shoot.root}:${id}:${formatAspect ?? "base"}` ? localDocRef.current : null;
    openSaved(id, next, carry); setUndoNotice(false);
  }
  /** Once an edit's saves have all landed: list them, then show the newest saved step if the screen is still waiting for it. */
  async function settle(id: string, fresh = false) {
    unseenChanges.current.clear();  // this listing reconciles every retained notice
    let listed: Cut[];
    try { const read = await listInOrder(shoot.root); listed = read.current ? read.cuts : cutsRef.current; }
    catch { if (selectedCutRef.current === id) setEditError('The edit was saved. Reopen Edits to refresh its details.'); return; }
    const merged = listed.map(entry => { const prior = cutsRef.current.find(c => c.cutId === entry.cutId); return (prior?.versions.at(-1)?.version ?? 0) > (entry.versions.at(-1)?.version ?? 0) ? prior! : entry; });
    cutsRef.current = merged; setCuts(merged);
    const h = historyRef.current;
    if (!h || selectedCutRef.current !== id || h.saving || trimGesture.current) return;
    // A deferred opening heal can finish listing after a hand save. Main's cursor wins.
    const want = h.driven ? h.version : wantOpen.current?.cutId === id ? wantOpen.current.version : h.version;
    wantOpen.current = null;
    if (!merged.find(c => c.cutId === id)?.versions.some(v => v.version === want)) return;
    if (fresh) { showSaved(want, "refresh"); return; }
    const shown = localDocRef.current?.key === `${shoot.root}:${id}:${formatAspect ?? "base"}` ? localDocRef.current : null;
    if (displayedSelection.current?.cutId === id && displayedSelection.current.version === want && !shown) return;
    openSaved(id, want, shown);
  }
  /** Main names a piece made on screen once its commit lands; queued edits use main's id. */
  async function learnVoiceIds(id: string, after: LocalDoc, savedIds?: string[]) {
    const script = savedIds ? null : await getApi().voiceoverScript(shoot.root, id).catch(() => null);
    const mine = (after.version.voiceover?.lines ?? []).filter(l => l.take).sort((a, b) => a.s - b.s), real = savedIds ?? (script?.lines ?? []).filter(l => l.take).sort((a, b) => a.s - b.s).map(line => line.id);
    if (mine.length !== real.length) return;
    mine.forEach((line, i) => { if (isLocalVoiceId(line.id)) voiceIds.current.set(line.id, real[i]); });
    setSelectedVoices(current => current.some(isLocalVoiceId) ? current.map(id => voiceIds.current.get(id) ?? id) : current);
  }
  const realVoiceId = (id: string) => isLocalVoiceId(id) ? voiceIds.current.get(id) ?? id : id;
  const localVoice = (edit: CutEdit): CutEdit => {
    if (edit.kind !== "voiceover") return edit;
    const e = edit as VoiceEditOp & { line?: string; lines?: string[] };
    return { ...e, ...(typeof e.line === "string" ? { line: realVoiceId(e.line) } : {}), ...(Array.isArray(e.lines) ? { lines: e.lines.map(realVoiceId) } : {}) } as unknown as CutEdit;
  };
  const voiceIdsOf = (edit: CutEdit): string[] => { const e = edit as { line?: unknown; lines?: unknown }; return [...(typeof e.line === "string" ? [e.line] : []), ...(Array.isArray(e.lines) ? e.lines as string[] : [])]; };
  /** VO7-3: shown now, committed in order in the background with expected = the revision it was made on. */
  function queueEdit(edit: CutEdit, before: LocalDoc, after: LocalDoc) {
    const id = cut!.cutId, h = history.history, changed = after !== before;
    let receivedSnapshot = false;
    const { label, targetName } = editLabel(edit, before.version);
    setEditError(null); setProgress(null);
    if (changed) showDoc(after, true);
    if (edit.kind === "replace") edgeSeek.current = before.version.pieces?.[edit.piece]?.timelineS;
    if (edit.kind === "move") { setSelectedPiece(edit.piece); setSelectedPieces([edit.piece]); }  // the screen keeps its numbers
    if (edit.kind === "remove" || edit.kind === "batch" && edit.edits.some(e => e.kind === "remove")) { setSelectedPieces([]); setSelectedPiece(null); setScope("edit"); }
    // Delete and Shift+Delete clear what they removed from the selection; closing a gap clears the gap.
    if (edit.kind === "voiceover" && (edit.op === "remove" || (edit as { op: string }).op === "ripple")) { const gone = voiceIdsOf(edit); setSelectedVoices(current => current.filter(id => !gone.includes(id))); setSelectedGap(null); }
    setUndo({ cutId: id, version: before.version.version, message: edit.kind === "remove" ? `Removed ${targetName}` : targetName ? `Updated ${targetName}` : "Edit updated" }); setUndoNotice(true);
    const step = { label, undo: () => { if (selectedCutRef.current === id) showDoc(before); }, redo: () => { if (selectedCutRef.current === id && changed) showDoc(after); } };
    void h.pending(step, async (base, strict) => {
      // Pieces keep their screen numbers while edits are pending; main reads spine positions.
      const sent = sentEdit(localVoice(edit), before.timeline);
      if (sent.kind === "voiceover" && voiceIdsOf(sent).some(isLocalVoiceId)) throw new Error("That voice piece could not be saved yet.");
      const result = await getApi().editCut(shoot.root, id, base, sent, { ...(strict ? { strict: true } : {}), snapshot: true });
      if (result.snapshot) {
        const snapshot = result.snapshot;
        receivedHandSnapshots.current.add(`${id}:${snapshot.version}`);
        if (receivedHandSnapshots.current.size > 32) receivedHandSnapshots.current.delete(receivedHandSnapshots.current.values().next().value!);
        cutsRef.current = cutsRef.current.map(c => c.cutId !== id ? c : { ...c,
          versions: c.versions.some(v => v.version === snapshot.version) ? c.versions.map(v => v.version === snapshot.version ? snapshot : v) : [...c.versions, snapshot] });
        listing.current.applied = ++listing.current.asked;
        receivedSnapshot = true;
      }
      if (!result.unchanged && after.version.voiceover?.lines.some(line => isLocalVoiceId(line.id))) await learnVoiceIds(id, after, result.voiceIds);
      return result;
    }, {
      saved: () => {
        rememberedVersions.current[id] = h.version; persistVersions();
        if (!h.saving) {
          unseenChanges.current.delete(`${id}:${h.version}`);
          if (unseenChanges.current.size) void settle(id);
          else if (receivedSnapshot && cutsRef.current.find(c => c.cutId === id)?.versions.some(v => v.version === h.version)) {
            if (selectedCutRef.current === id) showSaved(h.version);
            else setCuts(cutsRef.current);
          }
          else void settle(id);
        }
      },
      failed: error => { if (selectedCutRef.current === id) { setSaveFailure(saveNote(error)); setUndoNotice(false); } },
    });
    return { cutId: id, version: before.version.version };
  }
  async function editCut(edit: CutEdit, baseVersion?: number) {
    if (!cut || !version) return;
    if (edit.kind === "captionWord" || isSoundAdjustment(edit, documentVersion ?? version)) {
      // Sound and caption words stay instant and never hold a gesture: queued like every edit.
      const saving = saveLiveLook(edit, baseVersion);
      return baseVersion === undefined ? { cutId: cut.cutId, version: (documentVersion ?? version).version } : saving;
    }
    if (editingRef.current) return;
    const base = currentDoc();
    let after: LocalDoc | null = null;
    if (base && baseVersion === undefined) {
      try { after = localStep(base, edit); }
      catch (error) { setEditError(plainReason(error) || "Couldn't apply the edit. Try again."); return undefined; }
    }
    dragPlan.current = undefined; setDragPreview(null);
    if (base && after) return queueEdit(edit, base, after);
    return blockingEdit(edit, baseVersion);
  }
  /** Edits with no local plan (insert, shot order, transcript cuts, layouts, duplicates): they change
   * which piece is which in ways the screen can't show yet, so they wait for the queue, then hold
   * input while they save, as before VO7. */
  async function blockingEdit(edit: CutEdit, baseVersion?: number) {
    if (!cut || !version || editingRef.current) return;
    const id = cut.cutId, h = history.history, on = documentVersion ?? version;
    editingRef.current = true; keyGate.current = { saving: true, until: null }; setCutBusy(id, true); setEditError(null); setProgress(null);
    let saved: Selection | null = null, base = baseVersion ?? h.version;
    try {
      const shown = currentDoc();
      if (shown) edit = sentEdit(edit, shown.timeline);
      saved = await h.after(async () => {
        base = baseVersion ?? h.version;
        const strict = h.driven && baseVersion === undefined && h.onPath;
        return strict ? getApi().editCut(shoot.root, id, base, edit, { strict: true }) : getApi().editCut(shoot.root, id, base, edit);
      });
      if ((saved as Selection & { unchanged?: boolean }).unchanged) return saved;
      const { label, targetName } = editLabel(edit, on);
      h.commit(base, saved.version, label);
      const read = await listInOrder(shoot.root), refreshed = read.current ? read.cuts : cutsRef.current;
      if (!refreshed.some((entry) => entry.cutId === saved?.cutId && entry.versions.some((v) => v.version === saved?.version))) throw new Error("The edit was saved. Reopen Edits to load its new version.");
      cutsRef.current = refreshed; setCuts(refreshed);
      editingRef.current = false;
      if (selectedCutRef.current === id) keyGate.current.until = saved.version;  // FIX4: keys stay held until it shows
      rememberedVersions.current[saved.cutId] = saved.version;
      if (selectedCutRef.current === id) openCut(saved.cutId, saved.version, true);
      if (selectedCutRef.current === id) { setUndo({ cutId: id, version: base, message: edit.kind === "shotOrder" ? refreshed.find(entry=>entry.cutId===saved?.cutId)?.versions.find(v=>v.version===saved?.version)?.feedback ?? "Put in shot order" : targetName ? `Updated ${targetName}` : "Edit updated" }); setUndoNotice(true); }
      return saved;
    } catch (error) {
      const message = plainReason(error) || "Couldn't apply the edit. Try again.";
      setEditError(saved ? "The edit was saved, but its version couldn't load. Reopen Edits to see it." : message);
      return undefined;
    } finally { setCutBusy(id, false); editingRef.current = busyCuts.current.has(selectedCutRef.current ?? ""); if (keyGate.current.until === null) keyGate.current.saving = false; }
  }
  /** A copy of the edit reads the saved edit: pending hand edits land first. */
  function duplicateEdit() {
    if (!cut || !version || savingCut || editingRef.current) return;
    const id = cut.cutId, h = history.history;
    void h.idle().then(() => saveNewEdit({ cutId: id, version: h.version }));
  }
  /** The version menu's Restore: one undoable commit, behind any pending edit. */
  async function restoreMilestone(milestone: RevisionMilestone) {
    if (!cut || typeof getApi().restoreVersion !== "function") return;
    const id = cut.cutId, h = history.history, prior = shownDoc();
    await h.pending({ label: `restore ${milestone.name}`, undo: () => { if (selectedCutRef.current === id) showDoc(prior); }, redo: () => {} },
      async () => getApi().restoreVersion!(shoot.root, id, milestone.version), {
        saved: () => { if (!h.saving) void settle(id); },
        failed: error => { if (selectedCutRef.current === id) setSaveFailure(saveNote(error)); },
      });
  }
  async function finishCut(options: FinishOptions): Promise<boolean> {
    return !!await saveLiveLook(options);
  }
  // Finishing releases and live sound share the one queue, including during a render: each lands
  // on the step before it, and main's actual parent (baseVersion) keeps its own undo step.
  async function saveLiveLook(change: FinishOptions | CutEdit, requestedBase?: number): Promise<Selection | undefined> {
    if (!cut || !version) return;
    const id = cut.cutId, h = history.history, edit = "kind" in change ? change : null, prior = shownDoc(), base = currentDoc();
    let after: LocalDoc | null = null;
    if (edit && base) {
      try { const plan = pictureEdit(base.timeline, edit, base.version); if (plan !== base.timeline) after = { key: base.key, timeline: plan, version: optimisticVersion(base.version, edit, plan) }; }
      catch { /* main validates and refuses it in words */ }
    }
    if (after) showDoc(after);
    const label = edit ? edit.kind === "captionWord" ? "change caption word" : isSoundAdjustment(edit, base?.version ?? version) ? "change clip sound" : "change clip look"
      : Object.keys(change).some(key => key === "music" || key === "audio") ? "change sound" : Object.keys(change).some(key => ["captions", "titles", "framing", "energy", "aspect", "transition", "cutToBeat"].includes(key)) ? "change finish" : "change look";
    const step = { label, undo: () => { if (selectedCutRef.current === id) showDoc(prior); }, redo: () => { if (selectedCutRef.current === id && after) showDoc(after); } };
    const sent = edit && base ? sentEdit(edit, base.timeline) : edit;
    const saved = await h.pending(step, async (from, strict) => {
      const on = requestedBase ?? from;
      if (!sent) return getApi().finishCut(shoot.root, id, on, change as FinishOptions);
      return strict && requestedBase === undefined ? getApi().editCut(shoot.root, id, on, sent, { strict: true }) : getApi().editCut(shoot.root, id, on, sent);
    }, {
      saved: result => {
        rememberedVersions.current[id] = h.version; persistVersions();
        if (selectedCutRef.current === id && !edit) { setUndo({ cutId: id, version: (result as Selection & { baseVersion?: number }).baseVersion ?? result.version }); setUndoNotice(true); }
        if (!h.saving) void settle(id);
      },
      failed: error => { if (selectedCutRef.current === id) setSaveFailure(saveNote(error)); },
    });
    return saved ? { cutId: id, version: saved.version } : undefined;
  }
  async function regenerate() {
    if (!modelReady) { openModelSignIn("anotherVersion", () => void regenerate()); return; }
    if (!cut || !version || editingRef.current) return;
    setError(null);
    // The sidekick reads the saved edit: pending hand edits land first.
    const h = history.history; await h.idle();
    try { await getApi().sidekickSend(shoot.root, `Make another version of this edit, starting from v${h.version}. Keep its concept and target length, and find another strong arrangement from the available footage.`, { cutId: cut.cutId }); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't create another version."); }
  }
  // V62: Make it better lives in Ask. The shortcut opens Ask with the request; nothing changes until Apply.
  async function askBetter() {
    if (!modelReady) { openModelSignIn("better", () => void askBetter()); return; }
    if (!cut || !version) return;
    setPanel("ask");
    await sidekickSend(shoot.root, "Make it better", { cutId: cut.cutId, better: true });
  }
  const cards = cuts.map(entry => ({ id: entry.cutId, title: entry.title ?? entry.versions.at(-1)?.title ?? entry.concept, lengthS: entry.versions.at(-1)?.lengthS, createdAt: entry.versions.at(-1)?.createdAt ?? "", cut: entry }));
  const selectedId = cut?.cutId;
  function focusCut(id: string) {
    if (id === selectedId) return;
    workspace.current?.querySelectorAll("video").forEach((video) => video.pause());
    setMenuOpen(false);
    const card = cards.find((entry) => entry.id === id);
    if (!card?.cut) return;
    const latest = card.cut.versions.at(-1)?.version;
    if (latest === undefined) return;
    // VO7: an edit opens on its current revision.
    if (typeof getApi().revisionState === "function") { void currentRevision(shoot.root, id).then(current => { if (selectedCutRef.current !== id) openCut(id, card.cut!.versions.some(v => v.version === current) ? current! : rememberedVersions.current[id] ?? latest); }); return; }
    openCut(id, rememberedVersions.current[id] ?? latest);
  }
  const history = useEditHistory(shoot.root, cut?.cutId, version?.version, showSaved);
  // Steps from earlier sessions are named by the saved version's own words.
  historyRef.current = history.history;
  // FIX5: background readers (the Library's listing, the shoot status) hold while a save of this edit is in flight and
  // until the commit that draws its version, then read once, so the page's own redraw goes first.
  const editSaving = !!(history.history.saving || history.history.busy || editing);
  useEffect(() => { window.dispatchEvent(new CustomEvent("precut:edit-saving", { detail: editSaving })); }, [editSaving]);
  useEffect(() => () => { window.dispatchEvent(new CustomEvent("precut:edit-saving", { detail: false })); }, []);
  history.history.setLabeler?.(number => { const saved = cut?.versions.find(entry => entry.version === number); return saved ? versionLabel(saved) : "change"; });
  // V64: a version made elsewhere from the one on screen moves the screen to
  // it, unless the person is watching an older one on purpose. Playback and
  // drags defer the move until they finish; Undo still goes back.
  const followTo = (cutId: string, next: number, from: number) => {
    const arrived = cuts.find((entry) => entry.cutId === cutId)?.versions.find((entry) => entry.version === next);
    history.history.commit(from, next, arrived ? versionLabel(arrived) : "New version");
    openCut(cutId, next, true);
    setJustNew(next);
    window.clearTimeout(justNewTimer.current);
    justNewTimer.current = window.setTimeout(() => setJustNew(null), 4000);
  };
  const followRef = useRef(followTo); followRef.current = followTo;
  // A save the person made by hand opens its own version; never follow it twice.
  const handSaving = (cutId: string, latest: number) => editingRef.current || (selectedCutRef.current === cutId && (historyRef.current?.saving ?? 0) > 0)
    || (lookPending.current.get(cutId) ?? 0) > 0 || (rememberedVersions.current[cutId] ?? 0) >= latest;
  const stillOn = (cutId: string, from: number) => selectedCutRef.current === cutId
    && displayedSelection.current?.cutId === cutId && displayedSelection.current.version === from;
  // V64: Ask's open_version takes the version list's path, waiting while playing or dragging.
  const pendingOpenRef = useRef<{ cutId: string; version: number } | null>(null);
  const openRef = useRef(openCut); openRef.current = openCut;
  useEffect(() => getApi().onOpenVersion?.(target => {
    if (target.root !== shoot.root) return;
    if (!active || page !== "precuts") { go("precuts", { shoot: shoot.root, cut: target.cutId, v: String(target.version) }); return; }
    if (playingNowRef.current || trimGesture.current) { pendingOpenRef.current = { cutId: target.cutId, version: target.version }; return; }
    pendingOpenRef.current = null; openRef.current(target.cutId, target.version);
  }), [shoot.root, active, page]);
  flushFollowRef.current = () => {
    const opening = pendingOpenRef.current;
    if (opening && !playingNowRef.current && !trimGesture.current) { pendingOpenRef.current = null; pendingFollowRef.current = null; openCut(opening.cutId, opening.version); return; }
    const pending = pendingFollowRef.current;
    if (!pending || playingNowRef.current || trimGesture.current) return;
    pendingFollowRef.current = null;
    if (history.history.driven) { followCurrent(); return; }
    if (stillOn(pending.cutId, pending.from) && !handSaving(pending.cutId, pending.version)) followTo(pending.cutId, pending.version, pending.from);
  };
  useEffect(() => {
    const playback = (event: Event) => {
      playingNowRef.current = !!(event as CustomEvent<boolean>).detail;
      if (!playingNowRef.current) flushFollowRef.current();
    };
    window.addEventListener("sidething:playing", playback);
    window.dispatchEvent(new CustomEvent("sidething:playing-request"));
    return () => window.removeEventListener("sidething:playing", playback);
  }, []);
  // VO7-3: the screen follows main's current revision, not the newest snapshot: a result computed
  // across an undo is a hidden revision and never shows by itself.
  function followCurrent() {
    const h = history.history, id = cut?.cutId;
    if (!id || !h.driven || h.busy || h.saving || typeof getApi().revisionState !== "function") return;
    const from = h.version;
    void getApi().revisionState!(shoot.root, id).then(state => {
      if (h.version !== from || selectedCutRef.current !== id || h.busy || h.saving || !h.onPath || editingRef.current || state.version === h.version) return;
      if (!stillOn(id, h.version) || !cutsRef.current.find(entry => entry.cutId === id)?.versions.some(entry => entry.version === state.version)) return;
      if (playingNowRef.current || trimGesture.current) { pendingFollowRef.current = { cutId: id, version: state.version, from: h.version }; return; }
      h.follow(state);
      setJustNew(state.version);
      window.clearTimeout(justNewTimer.current);
      justNewTimer.current = window.setTimeout(() => setJustNew(null), 4000);
    }).catch(() => {});
  }
  useEffect(() => {
    if (!cut || !version) return;
    if (history.history.driven) { followCurrent(); return; }
    const latest = cut.versions.at(-1)?.version;
    if (latest === undefined) return;
    const previous = prevLatestRef.current.get(cut.cutId);
    for (const entry of cuts) { const known = entry.versions.at(-1)?.version; if (known !== undefined) prevLatestRef.current.set(entry.cutId, known); }
    if (previous === undefined || latest <= previous) return;
    const displayed = displayedSelection.current;
    if (!displayed || displayed.cutId !== cut.cutId) return;
    const cutId = cut.cutId, from = displayed.version;
    // Decide a beat later: a hand save's own open lands first and wins.
    window.setTimeout(() => {
      if (!stillOn(cutId, from) || handSaving(cutId, latest)) return;
      const decision = followDecision({ displayed: from, previousLatest: previous, latest,
        pinnedOlder: pinnedVersionRef.current?.cutId === cutId && pinnedVersionRef.current.version === from,
        playing: playingNowRef.current, dragging: trimGesture.current });
      if (decision === "defer") pendingFollowRef.current = { cutId, version: latest, from };
      else if (decision === "follow") followRef.current(cutId, latest, from);
    }, 30);
  }, [cuts]);
  useEffect(() => {
    let alive=true;
    const off=getApi().onBalanceApplied?.(event => {
      if(event.root!==shoot.root)return;
      // Publish the snapshot before its selection. Otherwise hash navigation
      // sees a missing version and falls back to the old, uncorrected edit.
      void listInOrder(shoot.root).then(read => {
        if(!alive)return;
        const refreshed=read.current ? read.cuts : cutsRef.current;
        // The selection uses a synchronous external store, so commit the
        // React snapshot before allowing it to navigate to the new version.
        flushSync(()=>setCuts(refreshed));
        const viewed=rememberedVersions.current[event.cutId] ?? (cut?.cutId===event.cutId ? version?.version : undefined);
        if(selectedCutRef.current===event.cutId && viewed===event.baseVersion && refreshed.some(entry=>entry.cutId===event.cutId && entry.versions.some(saved=>saved.version===event.version))) {
          history.history.commit(event.baseVersion,event.version,`Auto correct ${event.count} clips`);
          rememberedVersions.current[event.cutId]=event.version;
          selectSidekickCut(shoot.root,{cutId:event.cutId,version:event.version});
        }
      }).catch(()=>{if(alive)setEditError("Couldn't show the correction. Reopen this edit to try again.");});
    });
    return ()=>{alive=false;off?.();};
  },[shoot.root,cut?.cutId,version?.version]);
  // CH3: an Undo receipt in Claude's pane undoes its change while that version is still the one on screen, as the Undo pill does.
  useEffect(() => {
    const undoClaude = (event: Event) => {
      const detail = (event as CustomEvent<{ cutId: string; version: number; done?: (ok: boolean) => void }>).detail;
      const ok = !!detail && cut?.cutId === detail.cutId && version?.version === detail.version && !editing;
      if (ok) { history.undo(); setUndoNotice(false); }
      detail?.done?.(ok);
    };
    window.addEventListener("precut:claude-undo", undoClaude);
    return () => window.removeEventListener("precut:claude-undo", undoClaude);
  }, [cut?.cutId, version?.version, editing, history]);
  useEffect(()=>{const undoBalance=(event:Event)=>{const detail=(event as CustomEvent).detail;if(cut?.cutId===detail.cutId) {openCut(detail.cutId,detail.version,true);setUndoNotice(false);}};window.addEventListener("precut:balance-undo",undoBalance);return ()=>window.removeEventListener("precut:balance-undo",undoBalance);},[cut?.cutId]);
  // The player's clock (not React's time, which lags it while playing), to the end of the voice past the picture.
  const shuttle = useShuttle(player, () => timeNow.current, stageTimeline ? playbackExtent(stageTimeline) : timeline?.durationS ?? version?.lengthS ?? 0, playbackKey, timeline?.fps ?? 25);
  useEffect(()=>{if(source)shuttle.shuttle(0);},[!!source]);
  const fps = timeline?.fps ?? 25;
  const shownVoice = () => ((currentDoc()?.timeline ?? timeline)?.voiceover ?? []).filter(l => l.take);
  /** VO7-8 S and Cmd+B: every selected voice piece that crosses the playhead is cut there (pieces never
   * overlap, so at most one does). A selected picture piece splits the picture as today. With nothing
   * selected nothing happens, and a short hint says so. */
  function splitAtPlayhead() {
    // VO7-3: split what is on screen, including edits still on their way to main.
    const shown = currentDoc()?.timeline ?? timeline, time = timeNow.current;
    if (!shown || editingRef.current) return;
    if (selectedVoices.length) {
      const crossing = shownVoice().filter(l => selectedVoices.includes(l.id) && l.s < time && time < l.s + l.take!.e - l.take!.s);
      for (const line of crossing) void editCut({ kind: "voiceover", op: "split", line: line.id, at: time });
      if (!crossing.length) showHint("Move the playhead inside the piece to split it");
      return;
    }
    if (selectedPiece === null && !selectedPieces.length) { showHint("Select a piece to split"); return; }
    const picture = shown.pieces.filter(piece => piece.layer === 0 && piece.startS < time && time < piece.endS).at(-1);
    if (picture?.piece !== undefined) void editCut({ kind: "split", piece: picture.piece, at: sourceTime(picture, time) });
  }
  /** VO7-8 Blade: cut exactly where its landing line showed; the right half is selected, the playhead stays. */
  function bladeVoice(line: string, at: number) {
    if (editingRef.current) return;
    void editCut({ kind: "voiceover", op: "split", line, at, free: true } as unknown as CutEdit);
    const right = shownVoice().find(l => Math.abs(l.s - at) < 1e-6);
    if (right && right.id !== line) { setSelectedVoices([right.id]); if (selectedGap) setSelectedGap(null); }
  }
  /** VO7-8: a dropped take (or a Finder file once copied in) lands by the Insertion rule and arrives selected. */
  function placeTakeNow(take: string, spans: { s: number; e: number }[], at: number) {
    if (editingRef.current) return null;
    const before = new Set(shownVoice().map(l => l.id));
    const saved = editCut({ kind: "voiceover", op: "placePlan", take, spans, at } as unknown as CutEdit);
    const placed = shownVoice().filter(l => !before.has(l.id)).map(l => l.id);
    if (placed.length) { setSelectedVoices(placed); setSelectedGap(null); setSelectedPieces([]); setSelectedPiece(null); }
    return { saved, placed };
  }
  async function placeVoiceTake(take: string, spans: { s: number; e: number }[], at: number) {
    return placeTakeNow(take, spans, at)?.saved;
  }
  /** Add a recording: the chosen file becomes a take, lands whole at the playhead by the Insertion rule and
   * arrives selected, as a Finder drop does. Resolves once that version is saved, with main's piece ids,
   * so Clean read reads the saved edit and its Apply can replace exactly this piece. */
  async function addRecording(file: string) {
    const imported = await importVoiceTake(file);
    const placing = placeTakeNow(imported.file, [{ s: 0, e: imported.durationS }], Math.max(0, timeNow.current));
    if (!placing) throw new Error("Wait for the current edit to save, then add your recording.");
    const id = cut?.cutId, h = history.history;
    await placing.saved; await h.idle();
    // Main names the piece: read it from the saved revision (the take is new, so its pieces are this placement).
    // A listing already under way can predate the commit, so a fresh one is asked for until it shows it.
    let placed: string[] = [];
    for (let attempt = 0; attempt < 8 && !placed.length; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 150));
      const saved = (await getApi().listCuts(shoot.root)).find(c => c.cutId === id)?.versions.find(v => v.version === h.version);
      placed = (saved?.voiceover?.lines ?? []).filter(l => l.take?.file === imported.file).map(l => l.id);
    }
    if (!placed.length) throw new Error("Your recording is saved in Your takes, but it couldn't go on the timeline. Try Add to timeline from the take.");
    if (selectedCutRef.current === id) { setSelectedPieces([]); setSelectedPiece(null); setSelectedGap(null); setSelectedVoices(placed); }
    return { take: imported.file, placed };
  }
  async function importVoiceTake(file: string) {
    const api = getApi() as ReturnType<typeof getApi> & { importVoiceoverTake?: (root: string, file: string) => Promise<AudioFile> };
    if (typeof api.importVoiceoverTake !== "function") throw new Error("Drop audio files in the desktop app.");
    const take = await api.importVoiceoverTake(shoot.root, file);
    importedTakes.current = [...importedTakes.current.filter(t => t.file !== take.file), take];
    return { file: take.file, durationS: take.durationS };
  }
  /** VO7-13 Delete on voice follows Close gaps (on: the selected pieces go and later voice slides left by
   * their total length, keeping gaps already there; off: they leave a gap), in one undoable step. A selected
   * gap closes whatever the toggle says. Pictures as today. The Text panel's Delete uses the same rule. */
  function deleteVoice(invert: boolean) {
    if (editingRef.current || !selectedGap && !selectedVoices.length) return false;
    const close = timelinePrefs().closeGaps !== invert;
    const edit = selectedGap ? voiceDeleteEdit(shownVoice(), { gap: selectedGap }, close) : selectedVoices.length ? voiceDeleteEdit(shownVoice(), { lines: selectedVoices }, close) : null;
    if (edit) void editCut(edit);
    return !!edit;
  }
  function removeSelected() {
    const id=cut?.cutId;
    if (deleteVoice(false)) return;
    if (selectedPieces.length && !editingRef.current) void editCut(selectedPieces.length===1 ? {kind:"remove",piece:selectedPieces[0]} : selectionBatch(selectedPieces, `Delete ${selectedPieces.length} clips`, piece=>({kind:'remove',piece}))).then(saved=>{if(saved && selectedCutRef.current===id)clearPiece();});
  }
  /** Shift+Delete on voice: the opposite of Close gaps. Voice only. */
  function rippleSelected() { deleteVoice(true); }
  /** VO7-8 Cmd+D: a copy of the selected voice piece just after it when there is room; picture clips as today. */
  function duplicateSelected() {
    if (editingRef.current) return;
    if (selectedVoices.length) {
      if (selectedVoices.length > 1) { showHint("Select one piece to duplicate"); return; }
      const lines = shownVoice(), index = lines.sort((a, b) => a.s - b.s).findIndex(l => l.id === selectedVoices[0]), line = lines[index];
      if (!line) return;
      const length = line.take!.e - line.take!.s, next = lines[index + 1]?.s ?? Infinity;
      if (line.s + 2 * length > next + 1e-9) { showHint("No room after this piece"); return; }
      const before = new Set(lines.map(l => l.id));
      void editCut({ kind: "voiceover", op: "duplicate", line: line.id } as unknown as CutEdit);
      const copy = shownVoice().find(l => !before.has(l.id));
      if (copy) setSelectedVoices([copy.id]);
      return;
    }
    if(selectedPieces.length) void editCut({kind:'duplicate',pieces:selectedPieces});
  }
  function selectMany(pieces:number[]) { if(pieces.length){setSelectedVoices([]);setSelectedGap(null);} clearOverlay(); setSelectedJoin(null); setSelectedPieces(pieces); setSelectedPiece(pieces.at(-1) ?? null); setScope(pieces.length ? 'clip' : 'edit'); }
  function clearOverlay() { if (overlaySession?.selected) selectOverlay(overlaySession, ""); }
  function inspect(panel: string, detail: { id?: string; join?: number; overlay?: string; control?: string; piece?: number } = {}) {
    setPanel(panel === "join" || panel === "cuts" ? "pace" : panel === "piece" ? "clips" : panel === "overlays" ? "clips" : panel === "caption" ? "script" : panel === "captions" ? "captions" : panel.includes("item") ? "sound" : panel === "transcript" || panel === "voiceover" ? "script" : panel === "ask" ? "ask" : ["energy", "length"].includes(panel) ? "pace" : ["framing", "layout"].includes(panel) ? "clips" : "look");
    if (panel === "piece" && (detail.control === "trim" || detail.control === "framing" || detail.control === "transform")) {
      const label = detail.control === "transform" ? "Zoom" : detail.control === "framing" ? "Framing mode" : "Piece in point";
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-label="Piece panel"] [aria-label="${label}"]`)?.focus());
    }
    if (panel !== "overlays") clearOverlay();
    setSelectedJoin(panel === "join" ? detail.join ?? null : null);
    if (panel !== "piece" && panel !== "join") { setSelectedPieces([]); setSelectedPiece(null); setScope("edit"); }
    if (["caption", "music-item", "sound-item", "audio-item"].includes(panel)) { window.dispatchEvent(new CustomEvent("sidething:inspect", { detail: { panel, ...detail } })); return; }
    if (panel === "overlays" && detail.overlay) return;
    if (panel !== "join" && panel !== "piece") {
      const entry = CONTROL_REGISTRY.find(entry => entry.id === panel || entry.panel === panel);
      if (entry) setSearchControl({ ...entry });
    }
  }
  function selectPiece(index: number, openInspector = true) {
    setSelectedVoices([]); setSelectedGap(null); clearOverlay(); setSelectedJoin(null); setSelectedPieces([index]); setSelectedPiece(index); setScope("clip");
    if (openInspector) setPanel(current => current ?? "clips");
  }
  function clearPiece() { setSelectedVoices([]); setSelectedGap(null); setSelectedPieces([]); clearOverlay(); setSelectedPiece(null); setSelectedJoin(null); setScope("edit"); }
  function selectSearch(result: SearchResult) {
    if (result.control) { clearOverlay(); setSelectedJoin(null); if (result.control.panel !== "piece") setSelectedPiece(null); setSearchControl({ ...result.control }); setPanel(panelForControl(result.control)); }
    else if (result.cutId) {
      const entry = cuts.find(cut => cut.cutId === result.cutId);
      if (entry) {
        const next = result.version ?? rememberedVersions.current[entry.cutId] ?? entry.versions.at(-1)!.version;
        if (entry.cutId === cut?.cutId && next === version?.version && timeline) {
          if (result.piece !== undefined) selectPiece(result.piece);
          if (result.time !== undefined) player.current?.seek(result.time);
        } else { pendingSearch.current = result; openCut(entry.cutId, next); }
      }
    } else if (result.clipId) go("clips", { shoot: shoot.root, clip: result.clipId, t: result.time === undefined ? undefined : String(result.time) });
  }
  useEffect(() => {
    const result = pendingSearch.current;
    if (!result || !timeline || result.cutId !== cut?.cutId) return;
    pendingSearch.current = null;
    if (result.piece !== undefined) selectPiece(result.piece);
    if (result.time !== undefined) player.current?.seek(result.time);
  }, [timeline, cut?.cutId]);
  function trimCurrent() {
    const time = timeNow.current, index = selectedPiece ?? (currentDoc()?.timeline ?? timeline)?.pieces.filter(piece => piece.layer === 0 && piece.startS <= time && time < piece.endS).at(-1)?.piece;
    if (index !== undefined && index !== null) { selectPiece(index); inspect("piece", { piece: index, control: "trim" }); }
  }
  function fullscreen() {
    const stage = workspace.current?.querySelector<HTMLElement>("[data-player-container]");
    const request = document.fullscreenElement ? document.exitFullscreen() : stage?.requestFullscreen();
    void request?.catch(() => setError("Couldn't open full screen. Try again."));
  }
  const voice = useVoiceover({ root: shoot.root, cutId: cut?.cutId, version: version?.version,
    enabled: panel === "script", active: active && page === "precuts", player, time, lengthS: stageTimeline?.durationS,
    onPlaced: async (id, next, label, placed, snapshot) => {
      if (version) history.history.commit(version.version, next, label ?? "record voiceover");
      if (snapshot?.version === next && cutsRef.current.some(c => c.cutId === id)) {
        // OPEN1: the placed version opens from its own snapshot now; the listing that reconciles everything else
        // follows. Listing all 569 versions first held the take off the lane for 1.5 to 2.5 s.
        cutsRef.current = cutsRef.current.map(c => c.cutId !== id ? c : { ...c,
          versions: c.versions.some(v => v.version === next) ? c.versions.map(v => v.version === next ? snapshot : v) : [...c.versions, snapshot] });
        listing.current.applied = ++listing.current.asked;
        // The lane's plan for it (main shares one build per version), then the reconciling listing once the page is
        // idle: a whole-history listing landing first held the take's waveform back by about a second.
        const planned = getApi().draftTimeline(shoot.root, id, next, formatAspect).catch(() => null);
        setCuts(cutsRef.current); openCut(id, next, true);
        void planned.then(() => new Promise<void>(resolve => requestIdleCallback(() => resolve(), { timeout: 2000 })))
          .then(() => listInOrder(shoot.root)).then(listed => { if (listed.current) startTransition(() => setCuts(listed.cuts)); }).catch(() => {});
      } else { const listed = await listInOrder(shoot.root); if (listed.current) setCuts(listed.cuts); openCut(id, next, true); }
      // VO7-8: added clean-read pieces (and placed parts of a take) arrive selected on the lane.
      if (placed?.length && selectedCutRef.current === id) { setSelectedPieces([]); setSelectedPiece(null); setSelectedGap(null); setSelectedVoices(placed); }
    },
    onUndo: () => { if (!editingRef.current) history.undo(); },
    onAddRecording: addRecording,
  });
  // CH2b: Claude's pane (App's, on every page) sees this edit, its playhead and what is selected while Edits is active.
  useClaudeScreen("precuts", { cutId: cut?.cutId, version: documentVersion?.version ?? version?.version ?? 0,
    screenContext: { ...askScreen, playheadS: time, panel: "ask", editingPanel: askScreen?.panel ?? null } }, active);
  const shortcutList = useShortcuts("precuts", [
    ...editShortcuts({
      toggle: shuttle.toggle, shuttle: shuttle.shuttle, step: shuttle.step,
      split: orHold(splitAtPlayhead), remove: orHold(removeSelected),
      undo: orHold(() => { if (!editingRef.current) history.undo(); }), redo: orHold(() => { if (!editingRef.current) history.redo(); }),
      search: () => setPanel("search"), help: () => setShortcuts(true), bypassLook: () => setLookBypassed(value => !value),
    }, fps),
    ...panelShortcuts(togglePanel, closeSheet, toggleClaude),
    ...([-1, 1] as const).map(direction => ({ id: `cut-${direction}`, scope: "precuts", keys: [direction < 0 ? "ArrowUp" : "ArrowDown"], label: direction < 0 ? "Previous edit" : "Next edit", handler: () => {
      const index = cards.findIndex(card => card.id === selectedId);
      const next = cards[Math.max(0, Math.min(cards.length - 1, index + direction))]; if (next) focusCut(next.id);
    } })),
    // VO7-8: Cmd+D copies the selection, never the whole edit (that is Duplicate in the Edits list's menu).
    { id: "duplicate", scope: "precuts", keys: ["Cmd+d"], label: selectedVoices.length ? "Duplicate voice piece" : "Duplicate selected clips", enabled: !!cut && !!version && (selectedVoices.length > 0 || selectedPieces.length > 0), handler: orHold(duplicateSelected) },
    { id: "split-cmd-b", scope: "precuts", keys: ["Cmd+b"], label: "Split at playhead", handler: orHold(splitAtPlayhead) },
    { id: "ripple-delete", scope: "precuts", keys: ["Shift+Delete", "Shift+Backspace"], label: "Delete voice, the opposite of Close gaps", enabled: selectedVoices.length > 0 || !!selectedGap, handler: orHold(rippleSelected) },
    { id: "tool-select", scope: "precuts", keys: ["a"], label: "Select tool", handler: () => setTimelineTool("select") },
    { id: "tool-blade", scope: "precuts", keys: ["b"], label: "Blade tool (voice)", handler: () => setTimelineTool("blade") },
    { id: "save-version", scope: "precuts", keys: ["Cmd+s"], label: "Save version", enabled: !!cut && !!version && typeof getApi().saveVersion === "function", handler: () => { window.dispatchEvent(new CustomEvent("sidething:save-version", { detail: { cutId: cut?.cutId } })); } },
    { id: "make-better", scope: "precuts", keys: ["Cmd+Shift+b"], label: "Make it better", enabled: !!cut && !!version, handler: () => { void askBetter(); } },
    { id: "trim", scope: "precuts", keys: ["t"], label: "Trim current clip", handler: trimCurrent },
    { id: "fullscreen", scope: "precuts", keys: ["f"], label: "Full screen", handler: fullscreen },
    // POLISH1: ⌃⌘S (the macOS sidebar key; nothing in the UX audit's map uses it) is listened for in editsSidebar.tsx,
    // by its physical key, so it works from any focus on Edits. Listed here for the shortcut sheet only.
    { id: "edits-sidebar", scope: "precuts", keys: ["Cmd+Ctrl+s"], label: sidebar.hidden ? "Show edits" : "Hide edits", handler: () => {}, enabled: false },
  ].map(shortcut => ({ ...shortcut, enabled: (!("enabled" in shortcut) || shortcut.enabled !== false) && !shotOrderTarget && !menuOpen && !shortcuts && !voice.prompt && !voice.working })), active && page === "precuts");
  useShortcuts("precuts", [
    { id: "vo-stop", scope: "precuts", keys: ["Escape"], label: "Stop recording", handler: () => { void voice.stop(); } },
    { id: "vo-advance", scope: "precuts", keys: ["Space"], label: "Next voiceover line", handler: voice.advance },
  ], !!voice.prompt && active);
  const previewSrc = (preview: string | null) => preview ? isFixtureMode() ? `fixtures/sample-shoot/${preview}` : mediaUrl(shoot.root, "precuts", preview) : null;
  const activeVersion = version;
  const activeTitle = (cut as (Cut & { title?: string }) | undefined)?.title ?? version?.title ?? cut?.concept ?? "Edits";
  const activeKey = playbackKey;
  useEffect(() => { setSelectedPieces([]); setSelectedPiece(null); setSelectedJoin(null); setSearchControl(null); setScope("edit"); setLaneVisibility({}); setJustNew(null); pendingFollowRef.current = null; }, [selectedId]);
  useEffect(() => {
    if (!active || !params.control || !cut || !version) return;
    const entry = CONTROL_REGISTRY.find(entry => entry.id === params.control);
    if (entry) { setSearchControl({ ...entry }); setPanel(panelForControl(entry)); }
    go("precuts", { shoot: shoot.root, cut: cut.cutId, v: String(version.version) });
  }, [params.control, cut?.cutId, version?.version, active]);
  // A legacy burned-in preview may contain the removed background effect.
  // Wait for the current live plan instead of briefly showing that old movie.
  const src = previewSrc(activeVersion?.pieceFx?.some(fx => fx?.background?.mode === "blur") ? null : activeVersion?.preview ?? null);
  const aspect = timeline ? timeline.width / timeline.height : aspects[activeKey] ?? (cut && version ? cutAspect(cut, version, skills, []) : 16 / 9);
  const listItems: EditListItem[] = cards.map(card => {
    const focused = selectedId === card.id;
    const shown = focused && card.cut ? version : card.cut?.versions.at(-1);
    const task = allActivities.find(activity => ["cut", "finish", "edit"].includes(activity.kind) && activity.target?.cutId === card.id);
    const failed = (focused && (draftFailed || (liveMedia?.key === draftKey && liveMedia.failed))) || (task?.state === "failed" && task.note !== "Canceled" && (!shown || task.startedAt >= shown.createdAt));
    const status = state.pending?.context.cutId === card.id || task?.state === "running" ? undefined : failed ? "Couldn't finish" : (shown?.pieces?.length || shown?.preview || focused && timeline?.pieces.length) ? "Ready" : shown?.lengthS === 0 ? "Empty" : undefined;
    const ratio = card.cut && shown ? cutAspect(card.cut, shown, skills, []) : undefined;
    const format = ratio ? ratio > 1.7 ? "16:9" : ratio < .6 ? "9:16" : Math.abs(ratio - 1) < .01 ? "1:1" : Math.abs(ratio - .8) < .01 ? "4:5" : `${ratio.toFixed(2)}:1` : null;
    return { id: card.id, cut: card.cut, title: (card.cut as (Cut & { title?: string }) | null)?.title ?? (focused ? activeTitle : card.title), lengthS: focused ? activeVersion?.lengthS ?? card.lengthS : card.lengthS,
      poster: focused && timeline?.cover?.image ? timeline.cover.image : shown ? printPoster(shoot, shown) : null, hook: shown ? editHook(shoot, shown) : undefined, music: !!shown?.music, status, formats: [...new Set([...(format ? [format] : []), ...(shown?.formats?.map(format => format.aspect) ?? [])])], disabled: editing && focused };
  });
  useEffect(() => {
    if (!active) return;
    const search = () => setPanel("search");
    window.addEventListener("sidething:command-search", search);
    return () => window.removeEventListener("sidething:command-search", search);
  }, [active]);
  // Clip names across the whole history follow an undo in a background render, not in its frame.
  const namesVersion = typeof useDeferredValue === "function" ? useDeferredValue(version) : version;
  const exportAction = <ExportModal time={time} timeline={timeline} onEdit={edit => { void editCut(edit); }} root={shoot.root} cuts={cuts} cut={cut} version={activeVersion} busy={regenerating || Boolean(stageActivity)} onError={setError} />;
  return <ClipNames shoot={shoot} version={namesVersion} versions={cut?.versions} onSelect={(piece, at, targetVersion) => { if (targetVersion === version?.version) { selectPiece(piece); player.current?.seek(at); } else if (cut) { pendingSearch.current = { id: `shot-${piece}`, label: pieceName(shoot, cut.versions.find(v => v.version === targetVersion)!, piece), detail: "Shot", cutId: cut.cutId, version: targetVersion, piece, time: at }; openCut(cut.cutId, targetVersion); } }}><ClipMenu onShowWhatISay={cut && version && !editing ? piece=>{const chosen=(selectedPieces.includes(piece)?selectedPieces:[piece]).map(i=>version.pieces?.[i]).filter(p=>!!p);if(chosen.length)showWhatISay(Math.min(...chosen.map(p=>p!.timelineS)),Math.max(...chosen.map(p=>p!.timelineS+p!.lengthS)));} : undefined} onShotOrder={cut && version && !editing ? piece=>setShotOrderTarget({cutId:cut.cutId,version:version.version,pieces:selectedPieces.includes(piece)?[...selectedPieces]:[piece]}) : undefined} shoot={shoot} onShootChange={onShootChange} history={history.history} onAutoCorrect={cut && version ? piece=>{ownBalance(shoot.root,version.pieces?.[piece]?.clipId);return getApi().balanceClips(shoot.root,cut.cutId,version.version,{piece});} : undefined} canReplace={piece=>!editing && version?.pieces?.[piece]?.kind === "broll"} onReplace={piece => browseMedia(piece)}><div ref={workspace} data-precuts-workspace data-saving={history.history.saving || history.history.busy ? "true" : undefined} className="grid h-full min-h-0 min-w-0 gap-0 pb-[2px] st-editor-type" data-edits-hidden={sidebar.hidden || undefined} style={{ gridTemplateColumns: sidebar.hidden ? "minmax(0, 1fr)" : `${printsCollapsed ? "136px" : `clamp(240px, ${listWidth}px, 24vw)`} 8px minmax(0, 1fr)` }}><EditActivities root={shoot.root} onChange={setEditActivities} />
    {active && topHosts.sidebar && createPortal(<EditsSidebarToggle hidden={sidebar.hidden} onToggle={sidebar.toggle} />, topHosts.sidebar)}
    {active && topHosts.edit && createPortal(<EditSwitcher root={shoot.root} shootName={shoot.name} onNew={() => void saveNewEdit()} items={listItems} selectedId={selectedId} onSelect={focusCut} />, topHosts.edit)}
    {active && topHosts.produce && cut && activeVersion && createPortal(<ProducedRow root={shoot.root} cutId={cut.cutId} version={activeVersion} busy={editing || regenerating || Boolean(stageActivity)} onEdit={editCut} onOpen={next => openCut(cut.cutId, next)} />, topHosts.produce)}
    {/* POLISH1: hidden, the edits sidebar is not drawn at all (no strip); the top-left toggle, View > Show edits and ⌃⌘S bring it back. */}
    {!sidebar.hidden && <EditsList onShotOrder={(cutId,version)=>{openCut(cutId,version);setShotOrderTarget({cutId,version});}} root={shoot.root} onBlank={() => void saveNewEdit()} busy={savingCut} onStar={starSavedCut} onDuplicate={(cutId, version) => { if (cutId === cut?.cutId && version === history.history.version) duplicateEdit(); else void saveNewEdit({ cutId, version }); }} items={listItems} ideas={[...(state.messages ?? [])].reverse().flatMap(message => message.ideas ?? [])} selectedId={selectedId} version={version?.version} collapsed={printsCollapsed} onCollapse={() => { setCollapsed(!collapsed); savePane("collapsed", !collapsed); }} onSelect={focusCut} onVersion={openCut}>
      <div className="st-button-primary mb-4 flex shrink-0 items-stretch rounded-xl text-small text-white">
        <button ref={menuButton} type="button" disabled={savingCut} onClick={() => setMenuOpen(value => !value)} title="New edit" aria-label="New edit options" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl py-3 disabled:opacity-40 ${FOCUS}`}><Plus size={16} />{!printsCollapsed && <>New edit<ChevronDown size={14} /></>}</button>
      </div>
      <div ref={menu}>
        <AnimatePresence>{menuOpen ? <MenuSurface id={menuId} aria-label="New edit" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? instantMotion : spring.sheet} className="st-pop absolute top-24 left-full ml-2 z-40 w-56 rounded-2xl p-2" onClose={() => { setMenuOpen(false); menuButton.current?.focus(); }}>
          <MenuOption type="button" role="menuitem" onClick={() => go("ideas", { shoot: shoot.root })} className={`block w-full rounded-xl px-3 py-2.5 text-left text-small hover:bg-ink/[0.05] ${FOCUS}`}>From an idea</MenuOption>
          <MenuOption type="button" role="menuitem" disabled={savingCut || !selectedSources(shoot.root).length} onClick={() => void saveNewEdit(undefined, true)} className={`block w-full rounded-xl px-3 py-2.5 text-left text-small hover:bg-ink/[0.05] disabled:opacity-40 ${FOCUS}`}>From selected clips</MenuOption>
          <MenuOption type="button" role="menuitem" disabled={savingCut} onClick={() => void saveNewEdit()} className={`block w-full rounded-xl px-3 py-2.5 text-left text-small hover:bg-ink/[0.05] ${FOCUS}`}>Blank</MenuOption>
        </MenuSurface> : null}</AnimatePresence>
      </div>
    </EditsList>}
    {!sidebar.hidden && <div className={printsCollapsed ? "pointer-events-none invisible" : ""}><PaneHandle label="Resize edits list" value={listWidth} onChange={setListWidth} min={240} max={360} reset={292} /></div>}
    <section aria-label="Edit workspace" className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
      {active && exportHost && createPortal(exportAction, exportHost)}
      {active && versionHost && cut && version && createPortal(<VersionMenu cut={cut} current={version} poster={(entry) => printPoster(shoot, entry)} onOpen={(next) => openCut(cut.cutId, next)} justNew={justNew === version.version}
        milestones={history.history.driven && typeof getApi().listVersionMilestones === "function" ? { history: history.history, restore: restoreMilestone, list: () => getApi().listVersionMilestones!(shoot.root, cut.cutId), save: typeof getApi().saveVersion === "function" ? name => getApi().saveVersion!(shoot.root, cut.cutId, name) : undefined } : undefined} />, versionHost)}
      {/* POLISH1: the edit's name is in the top bar (EditSwitcher), not a line above the viewer. */}
      {cut ? <MissingMediaBanner editor shoot={shoot} onShootChange={onShootChange} onRelink={root => go("precuts", { shoot: root, cut: cut.cutId })} /> : null}{/* EXP3 */}
      {/* Finishing touches and their follow-ups live in Claude. */}
      <div className="edits-stage-row">
      <div data-player-container data-source-open={!!source || undefined} data-aspect={aspect < 1 ? "vertical" : "horizontal"} style={{ "--edit-aspect": aspect } as React.CSSProperties} className="edits-player relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl bg-black" onLoadedDataCapture={event => {
        if (event.target instanceof HTMLVideoElement && !event.target.closest('[data-source-preview]') && event.target.getAttribute("aria-label") !== "Take preview") setLiveMedia({ key: draftKey, failed: false });
      }} onErrorCapture={event => {
        if (event.target instanceof HTMLVideoElement && !event.target.closest('[data-source-preview]') && event.target.getAttribute("aria-label") !== "Take preview") setLiveMedia({ key: draftKey, failed: true });
      }}>
        {!source && <Row data-player-options className="edits-player-options gap-1">
            <label className="mr-auto text-micro"><span className="sr-only">Edit format</span><select aria-label="Player format" defaultValue={Math.abs(aspect - 9 / 16) < .01 ? "9:16" : Math.abs(aspect - 16 / 9) < .01 ? "16:9" : Math.abs(aspect - 1) < .01 ? "1:1" : "4:5"} className={`rounded-lg px-2 py-1.5 tnum text-micro ${FOCUS}`}><option value={Math.abs(aspect - 9 / 16) < .01 ? "9:16" : Math.abs(aspect - 16 / 9) < .01 ? "16:9" : Math.abs(aspect - 1) < .01 ? "1:1" : "4:5"}>{Math.abs(aspect - 9 / 16) < .01 ? "9:16" : Math.abs(aspect - 16 / 9) < .01 ? "16:9" : Math.abs(aspect - 1) < .01 ? "1:1" : "4:5"}</option></select></label>
            <button type="button" disabled={!timeline?.pieces.some(piece => piece.layer === 0)} onClick={() => { const time = timeNow.current, index = selectedPiece ?? timeline?.pieces.find(piece => piece.layer === 0 && piece.startS <= time && time < piece.endS)?.piece ?? timeline?.pieces.filter(piece => piece.layer === 0).at(-1)?.piece; if (index !== undefined && index !== null) { if (!selectedPieces.includes(index)) selectPiece(index); setTransformMode(true); inspect("piece", { control: "transform" }); } }} title="Transform current clip" className={`${ACTION} ${FOCUS}`}><Crop size={14} />Crop</button>
            <button type="button" aria-label="Full screen" title="Full screen (F)" onClick={fullscreen} className={`${ACTION} ${FOCUS}`}><FullScreen size={14} /></button>

        </Row>}
        <WhatChanged root={shoot.root} cut={cut} version={activeVersion} busy={regenerating || Boolean(stageActivity)} onOpen={(cutId, next) => openCut(cutId, next, true)} />
        <PanelBoundary label="the viewer" resetKey={draftKey}><Stage cutId={cut?.cutId} cutVersion={activeVersion?.version} source={source && shoot.clips.find(c=>c.id===source.clipId) ? {shoot,clip:shoot.clips.find(c=>c.id===source.clipId)!,range:source,musicGrid:stageTimeline?.musicGrid,landing:sourceLanding?.atS,destination:sourceLanding && version ? sourceDestination(version,sourceLanding,shoot) : undefined,onRange:range=>{sourceRangeNow.current=range;},onClose:()=>setSource(null),onInsert:append=>void insertSource(append),busy:editing,focused:active && page==='precuts' && !shortcuts && !voice.prompt} : undefined} bypassLook={lookBypassed} overlay={voice.prompt ? <Teleprompter prompt={voice.prompt} onStop={() => void voice.stop()} onRestart={() => void voice.restart()} /> : undefined} previewDetail={lookTexture.detail} previewPiece={lookPreviewPiece} previewGrain={lookTexture.grain} previewVignette={lookTexture.vignette} visibility={voice.prompt && voice.script?.lines.some(l => l.take) ? { ...laneVisibility, voice: true } : laneVisibility} ref={player} selectionKey={activeKey} draft={!!activeVersion} savedGrade={activeVersion?.grade} timeline={stageTimeline?.pieces.length ? stageTimeline : null} liveTitles={liveTitles?.key === draftKey ? liveTitles.titles : undefined} liveLook={liveChoice?.key === playbackKey ? liveChoice.look : undefined} src={activeVersion && !draftFailed ? null : src} poster={activeVersion ? cutPoster(shoot, activeVersion) : null} label={activeTitle} aspect={aspect} focused={page === "precuts" && !shortcuts} recording={!!voice.prompt} rendering={false} progress={progress} onTime={playerTime}
          onAspect={(value) => setAspects((previous) => previous[activeKey] === value ? previous : { ...previous, [activeKey]: value })}>
          {!selectedId ? <div className="flex max-w-sm flex-col items-center gap-3 p-6 text-center"><SectionHeader as="h2" className="text-title font-medium">{cutsLoading ? "Loading edits…" : "Your edit takes the stage here"}</SectionHeader>{!cutsLoading ? modelReady ? <><p className="text-body text-muted">Pick an idea, or make a new edit.</p><button type="button" className={ACTION} onClick={() => go("ideas", { shoot: shoot.root })}>Go to ideas</button></>
            : <><p className="text-body text-muted">Start an edit and add clips from your footage.</p><button type="button" className={`st-button-primary rounded-full px-4 py-2 text-small text-white ${FOCUS}`} disabled={savingCut} onClick={() => void saveNewEdit()}>Start an edit</button></> : null}</div> : activeVersion && timeline && !timeline.pieces.length ? <div className="flex max-w-sm flex-col items-center gap-3 p-6 text-center"><SectionHeader as="h2" className="text-title font-medium">Your blank edit</SectionHeader><p className="text-body text-muted">Choose footage to start this edit.</p><button type="button" className={`st-button-primary rounded-full px-4 py-2 text-small text-white ${FOCUS}`} onClick={() => browseMedia()}>Add clips</button></div> : activeVersion && !timeline && !draftFailed ? <p role="status" className="text-small text-muted">Loading draft…</p> : activeVersion && draftFailed && !src ? <InlineError className="max-w-sm p-6 text-center text-small text-muted">{draftPlayback?.error ?? "Couldn't open live playback. Reopen this edit to try again."}</InlineError> : undefined}
        </Stage></PanelBoundary>
      </div>
      <Sheet selectedName={selectedPiece === null || !documentVersion ? undefined : pieceName(shoot, documentVersion, selectedPiece)} selectedCount={selectedPieces.length} panel={panel} browsing={panel === "clips" && browsing} scope={scope} selectedPiece={selectedPiece} onScope={setScope} onClose={closeSheet}>
        {panel === "clips" && browsing && version ? <div data-clips-browse className="flex min-h-0 flex-1 flex-col"><button type="button" onClick={backToClips} className={`self-start px-3.5 pb-1 text-[15px] font-semibold text-accent ${FOCUS}`}>‹ Clips</button><LibraryView key={`${cut?.cutId}:media:${replaceTarget ?? "all"}`} root={shoot.root} media={{ shoot, cuts, version, replacePiece: replaceTarget, busy: editing, source, getSource:()=>sourceRangeNow.current, onSource:previewSource, onEscape:()=>source?setSource(null):backToClips(), onEdit: editCut, onClose: closeSheet, onShootChange }} /></div> : cut && version ? <PanelBoundary label="this panel" resetKey={`${draftKey}:${panel}`}><FinishPanel transformMode={transformMode} onTransformMode={setTransformMode} selectedPieces={selectedPieces} onLookFinish={async options => !!await saveLiveLook(options)} onLookEdit={saveLiveLook} onPreviewEdit={previewEdit} onLiveTexture={setLookTexture} onPreviewPiece={setLookPreviewPiece} panel={panel} onPanelChange={setPanel} onAskContext={setAskScreen} voice={voice} scope={scope} cut={cut} drafting={regenerating || stageActivity?.kind === "cut"} onRegenerate={regenerate} actionsDisabled={savingCut || Boolean(state.pending)} selectedJoin={panel === "pace" ? selectedJoin : null} onCloseJoin={() => setSelectedJoin(null)} searchControl={searchControl} selectedPiece={selectedPiece} onClosePiece={clearPiece} onSelectPiece={selectPiece} onEdit={editCut} player={player} timeline={timeline} key={cut.cutId} cutId={cut.cutId} shoot={shoot} version={documentVersion!} skills={skills} time={time} aspect={aspect} busy={editing || regenerating || Boolean(stageActivity)} captionSource={(timeline as (DraftTimeline & { captionSource?: CaptionSource }) | null)?.captionSource} onLiveTitles={titles => setLiveTitles({ key: draftKey, titles })} onLiveLook={choice => setLiveChoice({ key: playbackKey, look: choice })} onFinish={finishCut} /></PanelBoundary> : <p className="p-5 text-small text-muted">Choose an edit to adjust its finish.</p>}
      </Sheet>
      <Rail panel={panel} onToggle={togglePanel} />
      </div>
      {cut && version ? <>
        <ShowWhatISay shoot={shoot} cutId={cut.cutId} version={documentVersion ?? version} busy={editing} onEdit={editCut} onSeek={at => player.current?.seek(at)} />
        <PaneHandle label="Resize player and timeline" value={timelineHeight} onChange={setTimelineHeight} min={180} max={420} reset={306} horizontal reverse />
        <div data-edits-timeline-region className="edits-timeline-region" style={{ height: timelineHeight }} onPointerDownCapture={event => {
          setSource(null);
          if (!(event.target as HTMLElement).closest("[data-editor-timeline], button, input, select, [role='slider'], [role='separator'], [data-timeline-block]")) clearPiece();
        }}><div className="min-h-0 flex-1"><Timeline keyGate={keyGate} holdKeys={holdKey} liveTime={liveTime} onScrub={scrubTime} selectedVoices={selectedVoices} onSelectVoices={lines=>{setSelectedVoices(lines);if(lines.length){if(selectedGap)setSelectedGap(null);if(selectedJoin!==null)setSelectedJoin(null);clearOverlay();}}} selectedGap={selectedGap} onSelectGap={setSelectedGap} tool={timelineTool} onTool={setTimelineTool} onBlade={bladeVoice} onPlaceTake={placeVoiceTake} onImportTake={importVoiceTake} hint={timelineHint} sourceInsertS={sourceLanding?.atS} selectedPieces={selectedPieces} onSelectPieces={selectMany} onTrimGesture={active=>{trimGesture.current=active;if(!active)void Promise.resolve().then(()=>{if(!trimGesture.current && !history.history.saving && selectedCutRef.current===cut.cutId && (shownDoc() || displayedSelection.current?.version!==history.history.version))void settle(cut.cutId);flushFollowRef.current();});}} cutId={cut.cutId} onMusicChange={music=>finishCut({audio:{},cutToBeat:false,music:{...music,gainDb:music.gainDb ?? -18,duck:music.duck ?? true}})} onMusicGain={async gainDb=>{if(documentVersion?.music) await finishCut({audio:{},music:{...documentVersion.music,gainDb,duck:documentVersion.music.duck ?? true}});}} tools={<ToolBar tool={timelineTool} onTool={setTimelineTool} onDuplicate={selectedVoices.length || selectedPieces.length ? duplicateSelected : undefined} disabled={editing} canSplit={selectedVoices.length > 0 || ((selectedPiece !== null || selectedPieces.length > 0) && !!version.pieces?.length)} canRemove={selectedPiece !== null || selectedVoices.length > 0 || !!selectedGap} onSplit={splitAtPlayhead} onRemove={removeSelected} />} visibility={laneVisibility} onVisibility={setLaneVisibility} onDeselect={clearPiece} key={cut.cutId} shoot={shoot} version={documentVersion!} draft={dragPreview?.key === playbackKey || trimmingDocument || documentVersion !== version ? stageTimeline : timeline} time={time} player={player} busy={editing} selectedPiece={selectedPiece} onSelectPiece={selectPiece} onEdit={async edit => {const saved=await editCut(edit);if(saved && (edit.kind==='insert' || edit.kind==='batch' && edit.edits.some(e=>e.kind==='insert')))setSource(null);return saved;}} onPreview={previewEdit} history={history} onSelectJoin={join => { setSelectedPieces([]); setSelectedPiece(join); setScope("clip"); inspect("join", { join }); }} onSelectOverlay={id => { setSelectedPiece(null); if (overlaySession) selectOverlay(overlaySession, id); inspect("overlays", { overlay: id }); }} onInspect={(panel, detail) => { setSelectedPiece(null); inspect(panel, detail); }} /></div>

        </div>
      </> : null}
      {saveFailure ? <div aria-live="assertive" data-save-failure className="mx-4 mb-3 flex items-center gap-3 rounded-2xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-4 py-2.5 text-small text-ink"><span className="min-w-0 flex-1"><NamedMessage>{saveFailure}</NamedMessage></span><button type="button" onClick={() => setSaveFailure(null)} className={`shrink-0 rounded-full px-3 py-1 font-medium hover:bg-ink/[0.08] focus-visible:bg-ink/[0.1] ${FOCUS}`}>Dismiss</button></div> : null}
      {editError ? <InlineError data-edit-refusal className="px-4 pb-3 text-small text-ink">{editError}</InlineError> : null}
      {draftFailed ? <p role="status" className="px-4 pb-2 text-micro text-muted">{src ? "Live playback is unavailable. Showing the saved preview." : draftPlayback?.error ?? "Couldn't open live playback. Reopen this edit to try again."}</p> : null}
      {error || state.error ? <InlineError className="px-4 pb-4 text-small text-ink">{error || state.error}</InlineError> : null}
    </section>
    {undo && undoNotice && undo.cutId === cut?.cutId ? <div role="status" className="st-pop fixed bottom-[86px] left-1/2 z-[90] flex -translate-x-1/2 items-center gap-3 rounded-full px-4 py-2 text-small"><span><NamedMessage>{undo.message ?? "Edit updated"}</NamedMessage></span><button type="button" disabled={editing} onClick={() => { history.undo(); setUndoNotice(false); }} className="font-medium outline-none disabled:opacity-40">Undo</button></div> : null}
    {shotOrderTarget && <ShotOrderDialog count={shotOrderTarget.pieces?.length} onClose={()=>setShotOrderTarget(undefined)} onApply={async keepMyMoves=>{
      const target=shotOrderTarget;
      if(target.cutId!==cut?.cutId)throw Error('This edit is still opening. Try again.');
      const result=await editCut({kind:'shotOrder',pieces:target.pieces,keepMyMoves},target.version);
      if(!result)throw Error('Could not put these clips in shot order. Try again.');
    }} />}
    {shortcuts ? <ShortcutSheet shortcuts={shortcutList} onClose={() => setShortcuts(false)} /> : null}
  </div></ClipMenu></ClipNames>;
}
