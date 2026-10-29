import { useModelAccess, ModelSignIn } from "./ModelAccess";
import { EmptyState, MenuSurface, MenuOption } from "./ui";
import { useDialogFocus } from "./ui";
import { DialogSurface } from "./ui";
import { SectionHeader, InlineError, Tile } from "./ui";
import { CoverPanel } from "./finish/CoverPanel";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CaretDown, CaretUp, Check, Copy, FilmStrip, FolderSimple, Image as ImageIcon, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import type { Activity, ActivityStage, Api, Cut, CutVersion, CutEdit, DraftTimeline, EditorId, ExportTarget, SkillFormat, PostCopy } from "../../../shared/schema";
import { getApi } from "../data";
import { Export } from "./icons";
import { useShortcuts } from "../hooks/useShortcuts";
import { useEditHistory } from "../hooks/useEditHistory";
import { Button, FOCUS } from "./ui";
import { useActivity } from "./Activity";
import { formatPercent } from "./processingFormat";
import { voiceBeyondNote, voiceBeyondS } from "../../../shared/picture-extent";
import { exportCanceled, exportPlace, exportsFolder, exportSummary } from "../../../shared/export-summary";
import { TOAST_PLACEMENT } from "./Discoveries";  // BUG1: the app's one toast placement
import { frameRateLabel, standardFrameRate } from "../../../shared/frame-rate";
import { relinkShootFolder } from "./MissingMediaBanner";
import { useNav } from "../nav";

type Aspect = SkillFormat["aspect"];
type Batch = Awaited<ReturnType<Api["exportTo"]>>;
type Icons = Awaited<ReturnType<Api["appIcons"]>>;
export const exportChoices: { id: ExportTarget; name: string; detail: string }[] = [
  { id: "resolve", name: "DaVinci Resolve", detail: "Editable XML timeline with original footage. See README for track and finishing support." },
  { id: "finalcut", name: "Final Cut Pro", detail: "Editable FCPXML timeline with original footage and separate tracks where supported." },
  { id: "premiere", name: "Premiere Pro", detail: "Editable XML timeline. See README for supported tracks and effects." },
  { id: "capcut", name: "CapCut", detail: "Numbered clips and a reference video. No native project or editable finishing tracks." },
  { id: "mp4", name: "Finished video (MP4)", detail: "Finished picture, captions and sound, ready to publish." },
];
const defaultsKey = "sidething.exportTargets";
/** The saved editor choice from setup. Setup and Settings still use it; the export sheet no longer reads it (EXP1). */
export async function defaultExportTargets(): Promise<ExportTarget[]> {
  const preferences = await getApi().getPreferences();
  let stored: ExportTarget[] | null = null;
  try {
    const legacy: unknown = JSON.parse(localStorage.getItem(defaultsKey) ?? "null");
    if (Array.isArray(legacy) && legacy.length && legacy.every(id => exportChoices.some(choice => choice.id === id))) stored = [...new Set(legacy)] as ExportTarget[];
  } catch { /* Invalid legacy data falls back to the desktop editor. */ }
  if (preferences.output.targets?.length) {
    try { localStorage.removeItem(defaultsKey); } catch { /* Preferences remain authoritative. */ }
    return preferences.output.targets;
  }
  if (stored) {
    const saved = await getApi().setPreferences({ output: { ...preferences.output, targets: stored } });
    if (!saved.output.targets?.length) throw new Error("Could not migrate export defaults.");
    try { localStorage.removeItem(defaultsKey); } catch { /* Preferences remain authoritative. */ }
    return saved.output.targets;
  }
  return [];
}
export async function saveExportTargets(targets: ExportTarget[]) {
  const preferences = await getApi().getPreferences();
  await getApi().setPreferences({ output: { ...preferences.output, targets } });
  try { localStorage.removeItem(defaultsKey); } catch { /* Preferences remain authoritative. */ }
}
function message(error: unknown) {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message.replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "") : "Could not export. Try again.";
}
function duration(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`; }
function aspectOf(width: number, height: number): Aspect | undefined {
  return (["9:16", "16:9", "1:1", "4:5"] as const).find(value => { const [w, h] = value.split(":").map(Number); return Math.abs(width / height - w / h) < .01; });
}
/** One calm number for the time left. Hidden (null) until main has measured the picture's pace. */
export function timeLeft(etaS: number | null | undefined): string | null {
  if (etaS == null || !Number.isFinite(etaS) || etaS < 0) return null;
  return etaS < 50 ? "Less than a minute left" : `About ${Math.max(1, Math.round(etaS / 60))} min left`;
}

// EXP1: the four stages of a finished video, in the order the work happens.
const STAGES: { id: ActivityStage; name: string; doing: string }[] = [
  { id: "preparing", name: "Preparing", doing: "Preparing the edit" },
  { id: "sound", name: "Sound", doing: "Mixing the sound" },
  { id: "picture", name: "Picture", doing: "Rendering the picture" },
  { id: "saving", name: "Saving", doing: "Saving the video" },
];
const EDITORS: { id: EditorId; name: string; note?: string }[] = [
  { id: "resolve", name: "DaVinci Resolve" }, { id: "finalcut", name: "Final Cut Pro" },
  { id: "premiere", name: "Premiere Pro" }, { id: "capcut", name: "CapCut", note: "Clips only" },
];
const PLATFORMS: [PostCopy["platform"], string][] = [["reels", "Reels"], ["tiktok", "TikTok"], ["shorts", "Shorts"], ["youtube", "YouTube"], ["linkedin", "LinkedIn"], ["x", "X"]];

// One export per edit, kept outside the sheet: closing the sheet never loses the export or its result.
type Run = { root: string; cutId: string; version: number; target: ExportTarget; aspects: Aspect[]; state: "running" | "done" | "failed";
  result?: Batch; error?: string; toast?: boolean; startedAt?: number; endedAt?: number };
const runs = new Map<string, Run>(), viewing = new Set<string>(), runListeners = new Set<() => void>();
let runsVersion = 0;
const runKey = (root: string, cutId: string) => `${root}\u0000${cutId}`;
function setRun(key: string, run: Run | undefined) {
  if (run) runs.set(key, run); else runs.delete(key);
  runsVersion++; runListeners.forEach(listener => listener());
}
function subscribeRuns(listener: () => void) { runListeners.add(listener); return () => { runListeners.delete(listener); }; }
function useRuns() { useSyncExternalStore(subscribeRuns, () => runsVersion, () => runsVersion); return runs; }
/** Start one export of this edit. Resolves when it ends; a second start while one runs is ignored. */
export async function startExport(root: string, cutId: string, version: number, target: ExportTarget, aspects: Aspect[], hooks: { onRenderingChange?: (rendering: boolean) => void } = {}) {
  const key = runKey(root, cutId);
  if (runs.get(key)?.state === "running") return;
  const run: Run = { root, cutId, version, target, aspects, state: "running", startedAt: Date.now() };
  setRun(key, run);
  hooks.onRenderingChange?.(true);
  try {
    const result = await getApi().exportTo(root, cutId, version, [target], aspects);
    // Cancel goes back to the start: nothing half made is shown as an export.
    if (exportCanceled(result)) setRun(key, undefined);
    else setRun(key, { ...run, state: exportSummary(root, result).ok ? "done" : "failed", result, toast: !viewing.has(key), endedAt: Date.now() });
  } catch (error) {
    setRun(key, { ...run, state: "failed", error: message(error), toast: !viewing.has(key), endedAt: Date.now() });
  } finally { hooks.onRenderingChange?.(false); }
}

export type ExportProps = {
  time?: number; timeline?: DraftTimeline | null; onEdit?: (edit: CutEdit) => void; root: string; cuts: Cut[]; cut?: Cut; version?: CutVersion; busy?: boolean;
  onRenderingChange?: (rendering: boolean) => void; onError: (message: string) => void;
};

/** The workspace's single Export action. While an export runs it fills softly with its progress. */
export function ExportModal(props: ExportProps) {
  const [open, setOpen] = useState(false), [coverFirst, setCoverFirst] = useState(false);
  useEffect(() => { setOpen(false); setCoverFirst(false); }, [props.root, props.cut?.cutId]);
  // RAIL1: Cover lives here. Search, deep links and old Cover entries open this sheet with the cover controls showing.
  useEffect(() => {
    const openCover = (event: Event) => { if ((event as CustomEvent<{ root?: string }>).detail?.root === props.root && props.version) { setCoverFirst(true); setOpen(true); } };
    window.addEventListener("sidething:open-cover", openCover);
    return () => window.removeEventListener("sidething:open-cover", openCover);
  }, [props.root, !!props.version]);
  useShortcuts("precuts", [{ id: "export", keys: ["Cmd+e"], label: "Export your video", scope: "precuts", enabled: !props.busy && !!(props.version), handler: () => setOpen(true) }]);
  const exports = useActivity({ root: props.root, kind: "export", ...(props.cut ? { target: { cutId: props.cut.cutId } } : {}) });
  const all = useRuns();
  const key = props.cut ? runKey(props.root, props.cut.cutId) : "";
  const toastRun = [...all.entries()].find(([k, run]) => run.toast && run.root === props.root && (k === key || !open))?.[1];
  // Started here and not yet reported by main: it is already exporting, at 0%. Ended in main but not yet here: its last percent.
  // EXP3: an export that has ended here clears the button, whatever older word from main is still on its way.
  const run = key ? all.get(key) : undefined, running = exports.find(item => item.state === "running" && !(run?.endedAt && Date.parse(item.startedAt) <= run.endedAt))
    ?? (run?.state === "running" ? exports.find(item => Date.parse(item.startedAt) >= (run.startedAt ?? 0) - 2000) : undefined);
  const pct = running ? Math.round(running.pct ?? 0) : run?.state === "running" ? 0 : null;
  return <>
    <Button type="button" variant="primary" aria-label="Export" aria-haspopup="dialog" aria-expanded={open} title="Export (Cmd+E)" disabled={props.busy || !props.version} onClick={() => setOpen(true)}
      data-export-progress={pct ?? undefined} className="relative overflow-hidden">
      {pct !== null ? <span aria-hidden="true" data-export-fill className="absolute inset-y-0 left-0 bg-white/25 transition-[width] duration-500" style={{ width: formatPercent(pct) }} /> : null}
      <span className="relative inline-flex items-center gap-1.5"><Export size={16} />{pct !== null ? <>Exporting <span className="tabular-nums">{formatPercent(pct)}</span></> : "Export"}</span>
    </Button>
    {open ? <ExportDialog {...props} cover={coverFirst} onClose={() => { setOpen(false); setCoverFirst(false); }} /> : null}
    {toastRun && !open ? <ExportToast run={toastRun} onOpen={() => { dismissToast(toastRun); setOpen(true); }} /> : null}
  </>;
}
/** The toast hides; the sheet still shows the result once. Acting on the toast (Show in Finder, Dismiss) is seeing it. */
function dismissToast(run: Run, seen = false) {
  const key = runKey(run.root, run.cutId);
  if (runs.get(key) === run) setRun(key, seen ? undefined : { ...run, toast: false });
}

/** EXP1: the export finished while the sheet was closed. */
export function ExportToast({ run, onOpen }: { run: Run; onOpen: () => void }) {
  useEffect(() => { const timer = window.setTimeout(() => dismissToast(run), 15_000); return () => window.clearTimeout(timer); }, [run]);
  const summary = run.result ? exportSummary(run.root, run.result) : null;
  const file = summary?.file;
  return createPortal(<div role="status" data-export-toast={run.state} className={`glass-floating ${TOAST_PLACEMENT} z-[205] flex max-w-[420px] items-center gap-3 rounded-2xl py-2.5 pl-3 pr-2 text-ink`}>
    <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-full ${run.state === "done" ? "bg-accent/15 text-[var(--accent-text)]" : "bg-danger/15 text-danger"}`}>{run.state === "done" ? <Check size={16} weight="bold" /> : <WarningCircle size={16} />}</span>
    <div className="min-w-0 flex-1"><p className="text-small font-medium">{run.state === "done" ? "Export finished" : "Export failed"}</p>
      <p className="truncate text-micro text-muted">{run.state === "done" ? summary?.name : summary?.failures[0] ?? run.error ?? "Try again."}</p></div>
    {run.state === "done" && file ? <Button type="button" onClick={() => { dismissToast(run, true); void getApi().revealInFinder(file).catch(() => {}); }}><FolderSimple size={15} />Show in Finder</Button>
      : <Button type="button" onClick={onOpen}>Open</Button>}
    <button type="button" aria-label="Dismiss" onClick={() => dismissToast(run, true)} className={`flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-ink ${FOCUS}`}><X size={14} /></button>
  </div>, document.body);
}

export function ExportDialog({ root, cuts, cut, version: initialVersion, busy = false, onRenderingChange, onError, onClose, time = 0, timeline, onEdit, cover = false }: ExportProps & { onClose: () => void; cover?: boolean }) {
  const modelReady = useModelAccess();
  const [postVersion, setPostVersion] = useState<CutVersion | null>(null);
  const version = postVersion ?? initialVersion;
  const { history: editHistory } = useEditHistory(root, cut?.cutId, initialVersion?.version);
  const [writing, setWriting] = useState(false), [postCopied, setPostCopied] = useState(""), [postOpen, setPostOpen] = useState(!!initialVersion?.post?.length);
  const writingRef = useRef(false);
  useEffect(() => { setPostVersion(null); }, [root, cut?.cutId, initialVersion?.version]);
  const postBody = (post: PostCopy) => [post.title, post.caption, post.hashtags.join(" "), post.chapters?.map(c => `${duration(c.atS)} ${c.title}`).join("\n")].filter(Boolean).join("\n\n");
  // EXP1: one model call writes all six; each block keeps its own Copy and Rewrite.
  async function writeCopy(platforms: PostCopy["platform"][], rewrite = false) {
    setPostOpen(true);
    if (!modelReady || !cut || !version || writingRef.current) return;
    writingRef.current = true; setWriting(true); setError("");
    try {
      // Optional rewrite is implemented by UL5 without changing the shared contract.
      const write = getApi().writePost as (...args: [...Parameters<Api["writePost"]>, boolean?]) => ReturnType<Api["writePost"]>;
      const result = await write(root, cut.cutId, version.version, platforms, rewrite);
      const saved = (await getApi().listCuts(root)).find(c => c.cutId === result.cutId)?.versions.find(v => v.version === result.version);
      if (!saved) throw new Error("Could not load the saved post copy.");
      editHistory.commit(version.version, saved.version, `Write post copy for ${platforms.join(", ")}`);
      const { selectSidekickCut } = await import("./SidekickChat");
      selectSidekickCut(root, result);
      setPostVersion(saved);
    } catch (error) { setError(message(error)); }
    finally { writingRef.current = false; setWriting(false); }
  }
  const titleId = useId(), dialog = useRef<HTMLDivElement>(null), menuId = useId();
  const [aspects, setAspects] = useState<Aspect[]>([]), [selectedAspects, setSelectedAspects] = useState<Aspect[]>([]);
  const [icons, setIcons] = useState<Icons | null>(null), [thumbnail, setThumbnail] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ width: number; height: number; fps: number; cover: number | null; auto: boolean } | null>(null);
  const [place, setPlace] = useState<{ folder: string; custom: boolean } | null>(null), [outputHeight, setOutputHeight] = useState<number | null>(null);
  const [error, setError] = useState(""), [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(!!cut && !!version), [retry, setRetry] = useState(0);
  const [history, setHistory] = useState(false), [coverOpen, setCoverOpen] = useState(cover), [menu, setMenu] = useState(false);
  useEffect(() => { if (cover) setCoverOpen(true); }, [cover]);
  const all = useRuns();
  const key = cut ? runKey(root, cut.cutId) : "";
  const run = key ? all.get(key) : undefined;
  const activities = useActivity({ root, kind: "export", ...(cut ? { target: { cutId: cut.cutId } } : {}) });
  // While this sheet's export is still settling, the export that just ended (100%, saving) stays on screen: never a drop back to 0.
  const activity = activities.find(item => item.state === "running") ?? (run?.state === "running" ? activities.find(item => Date.parse(item.startedAt) >= (run.startedAt ?? 0) - 2000) : undefined);
  const exporting = run?.state === "running" || activity?.state === "running";
  const finished = !exporting && run && run.state !== "running" ? run : undefined;
  const locked = busy || exporting || writing;
  // The sheet is open for this edit: an export that ends now is shown here, not as a toast.
  useEffect(() => {
    if (!key) return;
    viewing.add(key);
    const current = runs.get(key);
    if (current?.toast) setRun(key, { ...current, toast: false });
    return () => {
      viewing.delete(key);
      // A finished export has been seen once the sheet closes on it; the next open starts fresh.
      const ended = runs.get(key);
      if (ended && ended.state !== "running" && !ended.toast) setRun(key, undefined);
    };
  }, [key]);
  // VO7-9: export stops at the picture's end. Voice placed past it is named here, before export, with the three ways on.
  const beyond = version ? voiceBeyondS(version.voiceover?.lines, version.lengthS, timeline?.fps ?? 25) : 0;
  const [anyway, setAnyway] = useState(false), [extending, setExtending] = useState<"black" | "hold" | null>(null);
  useEffect(() => { setAnyway(false); setExtending(null); }, [cut?.cutId, version?.version]);
  async function extend(mode: "black" | "hold") {
    if (!cut || !version || locked || extending) return;
    setExtending(mode); setError("");
    const edit: CutEdit = { kind: "extendPicture", mode };
    try { if (onEdit) onEdit(edit); else await getApi().editCut(root, cut.cutId, version.version, edit); }
    catch (error) { setExtending(null); setError(message(error)); }
  }
  const extended = version?.feedback?.startsWith("Extended with black") || version?.feedback?.startsWith("Held the last shot") ? version.feedback : null;
  useEffect(() => {
    let active = true;
    void getApi().appIcons().then(value => { if (active) setIcons(value); }).catch(() => {});
    void getApi().getPreferences().then(preferences => {
      if (!active) return;
      setPlace({ folder: exportsFolder(root, preferences.output.exportFolder), custom: !!preferences.output.exportFolder });
      setOutputHeight(preferences.output.height ?? null);
    }).catch(() => { if (active) setPlace({ folder: exportsFolder(root, null), custom: false }); });
    return () => { active = false; };
  }, [root]);
  useEffect(() => {
    if (!cut || !version) return;
    let active = true;
    setLoading(true);
    void getApi().draftTimeline(root, cut.cutId, version.version).then(draft => {
      if (!active) return;
      const base = aspectOf(draft.width, draft.height);
      if (!base) throw new Error("This edit has an unsupported format.");
      const formats = [...new Set([base, ...(version.formats?.map(format => format.aspect) ?? [])])];
      setAspects(formats); setSelectedAspects(formats); setThumbnail(draft.cover?.image ?? null); setError("");
      setFrame({ width: draft.width, height: draft.height, fps: draft.fps ?? 0, cover: draft.cover?.t ?? version.cover?.t ?? null, auto: draft.cover?.auto ?? !version.cover });
    }).catch(error => { if (active) setError(message(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [root, cut?.cutId, version?.version, retry]);
  useDialogFocus(dialog, true, 'button[aria-label="Export"]');
  // Changing state can remove the focused control. Restore containment so Escape and Tab still reach the dialog.
  const view = exporting ? "exporting" : finished ? finished.state : "ready";
  useEffect(() => {
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, [locked, view]);
  function begin(target: ExportTarget) {
    if (locked || !cut || !version || !selectedAspects.length) return;
    setError(""); setMenu(false); onError("");
    void startExport(root, cut.cutId, version.version, target, selectedAspects, { onRenderingChange });
  }
  async function reveal(file: string) {
    try { await getApi().revealInFinder(file); } catch (error) { setError(message(error)); }
  }
  async function copy(file: string) {
    try { await navigator.clipboard.writeText(file); setCopied(true); } catch { setError("Could not copy the path. Try again."); }
  }
  function cancel() {
    if (activity?.state === "running") void getApi().cancelActivity(activity.id).catch(error => setError(message(error)));
  }
  // EXP3: clips gone from the shoot folder are named on the failure, with the one Relink (MissingMediaBanner's).
  const { go } = useNav();
  const missingClips = [...new Set(finished?.result?.results.flatMap(item => (item as { missing?: string[] }).missing ?? []) ?? [])];
  const [relinking, setRelinking] = useState(false);
  async function relink() {
    if (!cut || relinking) return;
    setRelinking(true); setError("");
    try {
      const next = await relinkShootFolder(root);
      if (!next) return;
      if (key) setRun(key, undefined);
      if (next !== root) { onClose(); go("precuts", { shoot: next, cut: cut.cutId }); }
    } catch (error) { setError(message(error)); }
    finally { setRelinking(false); }
  }
  const exported = [...cuts.flatMap(entry => entry.exported.map(item => ({ ...item, name: entry.versions.find(v => v.version === item.version)?.title ?? entry.concept })))];
  const records = [...new Map(exported.sort((a, b) => b.at.localeCompare(a.at)).map(item => [item.folder, item])).values()];
  const summary = finished?.result ? exportSummary(root, finished.result) : null;
  const scale = frame && outputHeight ? Math.min(1, outputHeight / Math.min(frame.width, frame.height)) : 1;
  // EXP3: the rate the file plays at (export.ts exportFormat makes a phone's average a standard rate), never the average.
  const formatLine = frame ? [aspects[0], `${Math.round(frame.width * scale / 2) * 2} × ${Math.round(frame.height * scale / 2) * 2}`, frame.fps ? `${frameRateLabel(standardFrameRate(frame.fps))} fps` : null].filter(Boolean).join(" · ") : " ";
  const coverLine = frame?.cover == null ? "Cover: automatic" : `Cover: ${frame.auto ? "automatic, " : ""}frame at ${duration(frame.cover)}`;
  const where = place ? place.custom ? `Saves in ${exportPlace(root, place.folder)}` : `Saves next to your footage, in ${exportPlace(root, place.folder)}` : " ";
  const title = view === "exporting" ? "Exporting" : view === "done" ? "Exported" : view === "failed" ? "Export failed" : "Export";
  const editorTarget = (run?.target ?? "mp4") !== "mp4";
  // One soft pill fill for the secondary controls, readable on the modal in both themes.
  const pill = "!bg-ink/[0.07] hover:!bg-ink/[0.11]";

  const editorMenu = <div className="relative">
    <Button type="button" aria-haspopup="menu" aria-expanded={menu} aria-controls={menu ? menuId : undefined} disabled={locked || loading || !selectedAspects.length}
      onClick={() => setMenu(value => !value)} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setMenu(true); } }}
      className={`h-10 px-3.5 ${menu ? "!bg-ink/[0.14]" : pill}`}>Open in an editor{menu ? <CaretUp size={12} /> : <CaretDown size={12} />}</Button>
    {menu ? <EditorMenu id={menuId} icons={icons} onClose={() => setMenu(false)} onPick={editor => begin(editor)} /> : null}
  </div>;
  const writeButton = <Button type="button" disabled={locked || !cut || !version} onClick={() => void writeCopy(PLATFORMS.map(([id]) => id))} className={`h-10 px-3.5 ${pill}`}>Write post copy</Button>;
  const quiet = "h-10 rounded-full px-1.5 text-small text-muted hover:text-ink disabled:opacity-45";

  return createPortal(<div className="st-scrim fixed inset-0 z-[210] flex items-center justify-center p-5" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <DialogSurface ref={dialog} tabIndex={-1} aria-modal="true" aria-labelledby={titleId} aria-busy={exporting} data-export-view={view}
      className="glass-modal flex max-h-[calc(100dvh-40px)] w-[580px] max-w-full flex-col gap-5 overflow-y-auto rounded-[28px] p-7 text-left text-ink outline-none focus-visible:!bg-[var(--glass-modals-tint)]"
      onClose={() => { if (menu) setMenu(false); else onClose(); }}>
      <header className="flex items-start gap-4">
        <div className="relative flex h-24 w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink/[0.06]">
          {thumbnail ? <img src={thumbnail} alt="Cover for this edit" className="h-full w-full object-cover" onError={() => setThumbnail(null)} /> : <FilmStrip size={28} className="text-muted" />}
          {version ? <span className="absolute bottom-1 left-1 rounded bg-ground/90 px-1.5 py-0.5 font-mono text-micro">{duration(version.lengthS)}</span> : null}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-2.5">
            {view === "done" ? <span aria-hidden="true" className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-accent/15 text-[var(--accent-text)]"><Check size={14} weight="bold" /></span> : null}
            {view === "failed" ? <span aria-hidden="true" className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger"><WarningCircle size={15} /></span> : null}
            <SectionHeader as="h2" id={titleId} className="font-display text-[24px] font-semibold leading-[30px] tracking-tight">{title}</SectionHeader>
          </div>
          {view === "done" && summary ? <>
            <p data-export-file className="mt-2 truncate text-[15px] font-medium" title={summary.file ?? undefined}>{summary.name}{summary.more > 0 ? <span className="font-normal text-muted"> and {summary.more} more</span> : null}</p>
            <p className="mt-1 truncate text-small text-muted">In {summary.place}</p>
          </> : <>
            <p className="mt-1.5 truncate text-[15px] font-medium">{version?.title ?? "Edit"}</p>
            <p aria-label="Output size" className="mt-1 truncate text-small text-muted">{formatLine}</p>
          </>}
        </div>
        <button type="button" aria-label={exporting ? "Close, export keeps going" : "Close export"} onClick={onClose}
          className={`flex size-9 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-muted hover:bg-ink/[0.1] hover:text-ink ${FOCUS}`}><X size={16} /></button>
      </header>

      {!cut || !version ? <p className="text-small text-muted">Choose a saved edit to export.</p>
      : view === "exporting" ? <ExportProgress activity={activity} editor={editorTarget} lengthS={version.lengthS} />
      : view === "done" && summary ? <>
        <div className="grid grid-cols-2 gap-2.5">
          <Button type="button" variant="primary" disabled={!summary.file} onClick={() => summary.file && void reveal(summary.file)} className="h-[52px] !rounded-2xl !text-[15px]"><FolderSimple size={18} />Show in Finder</Button>
          <Button type="button" disabled={!summary.file} onClick={() => summary.file && void copy(summary.file)} className={`h-[52px] !rounded-2xl !text-[15px] ${pill}`}><Copy size={18} />{copied ? "Path copied" : "Copy path"}</Button>
        </div>
        {summary.failures.length || summary.warnings.length ? <div className="-mt-1 space-y-1">
          {summary.failures.map(line => <p key={line} className="text-small text-danger">{line}</p>)}
          {summary.warnings.map(line => <p key={line} className="text-micro text-muted">{line}</p>)}
        </div> : null}
      </>
      : view === "failed" ? <>
        <div className="space-y-1 rounded-2xl bg-danger/[0.08] px-4 py-3">
          {(summary?.failures.length ? summary.failures : [finished?.error ?? "Could not export. Try again."]).map(line => <InlineError key={line} className="break-words text-small text-ink">{line}</InlineError>)}
        </div>
        {missingClips.length ? <div className="grid grid-cols-2 gap-2.5">
          <Button type="button" variant="primary" disabled={locked || relinking} onClick={() => void relink()} className="h-[52px] !rounded-2xl !text-[15px]"><FolderSimple size={18} />Relink</Button>
          <Button type="button" disabled={locked || loading || relinking} onClick={() => { const target = finished?.target ?? "mp4"; if (key) setRun(key, undefined); begin(target); }} className={`h-[52px] !rounded-2xl !text-[15px] ${pill}`}><UploadSimple size={18} />Try again</Button>
        </div>
        : <Button type="button" variant="primary" disabled={locked || loading} onClick={() => { const target = finished?.target ?? "mp4"; if (key) setRun(key, undefined); begin(target); }} className="h-[52px] w-full !rounded-2xl !text-[16px]"><UploadSimple size={18} />Try again</Button>}
      </>
      : <>
        <div className="rounded-2xl bg-ink/[0.04]">
          <div className="flex items-center gap-3 px-3.5 py-3">
            <ImageIcon size={18} className="shrink-0 text-muted" aria-hidden="true" />
            <span data-export-cover-line className="flex-1 text-[14px]">{coverLine}</span>
            <Button type="button" aria-expanded={coverOpen} disabled={locked} onClick={() => setCoverOpen(value => !value)} className={`h-8 px-3 ${pill}`}>{coverOpen ? "Done" : "Change"}</Button>
          </div>
          {coverOpen ? <div data-export-cover className="px-3.5 pb-3.5"><CoverPanel root={root} cutId={cut.cutId} version={version} time={time} timeline={timeline} disabled={locked} onEdit={onEdit} heading={false} /></div> : null}
        </div>
        {aspects.length > 1 ? <div role="group" aria-label="Formats" className="-mt-1 flex flex-wrap items-center gap-2">
          {aspects.map(aspect => { const on = selectedAspects.includes(aspect); return <Tile key={aspect} type="button" aria-label={`Export ${aspect}`} aria-pressed={on} disabled={locked}
            onClick={() => setSelectedAspects(value => on ? value.filter(item => item !== aspect) : [...value, aspect])}
            className={`h-8 rounded-full px-3 font-mono text-small ${on ? "bg-accent/15 text-[var(--accent-text)]" : "bg-ink/[0.05] text-muted hover:text-ink"} ${FOCUS}`}>{aspect}</Tile>; })}
        </div> : null}
        {beyond > 0 && !anyway ? <section data-export-voice-beyond aria-label="Voice past the end" className="rounded-2xl bg-ink/[0.05] p-4">
          <p role="status" className="text-small font-medium text-ink">{voiceBeyondNote(beyond)}</p>
          <p className="mt-1 text-micro text-muted">{extending ? extending === "black" ? "Extending with black…" : "Holding the last shot…" : "Extend the picture to keep it, or export the picture as it is. Cmd+Z undoes an extend."}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="primary" disabled={locked || !!extending} onClick={() => void extend("black")}>Extend with black</Button>
            <Button type="button" disabled={locked || !!extending} onClick={() => void extend("hold")}>Hold last shot</Button>
            <Button type="button" disabled={locked || !!extending || loading || !selectedAspects.length} onClick={() => { setAnyway(true); begin("mp4"); }}>Export anyway</Button>
          </div>
        </section> : <div className="flex flex-col gap-2.5">
          <Button type="button" variant="primary" disabled={locked || loading || !selectedAspects.length} onClick={() => begin("mp4")} className="h-[52px] w-full !rounded-2xl !text-[16px]"><UploadSimple size={18} />Export video</Button>
          <p className="text-center text-micro text-muted">{extended ? <span role="status" data-export-extended>{`${extended}, ${duration(version.lengthS)} long. `}</span> : null}{where}</p>
        </div>}
      </>}

      {cut && version && view !== "exporting" ? <div className="flex flex-wrap items-center gap-2">
        {view === "done" ? <>{writeButton}{editorMenu}</> : <>{editorMenu}{writeButton}</>}
        <div className="flex-1" />
        {view === "done" ? <button type="button" disabled={locked} onClick={() => { if (key) setRun(key, undefined); }} className={`${quiet} ${FOCUS}`}>Export again</button>
          : <button type="button" aria-expanded={history} onClick={() => setHistory(value => !value)} className={`${quiet} ${FOCUS}`}>Earlier exports</button>}
      </div> : null}

      {error ? <InlineError className="-mt-2 break-words text-small text-danger">{error}{!aspects.length && !loading ? <> <button type="button" onClick={() => setRetry(value => value + 1)} className={`underline ${FOCUS}`}>Try again</button></> : null}</InlineError> : null}
      {history && view !== "exporting" ? <div className="-mt-2 flex flex-col gap-2">{!records.length ? <EmptyState variant="inline" as="p" className="text-micro text-muted">No earlier exports</EmptyState> : records.map(item => <div key={item.folder} className="flex items-center gap-3 rounded-xl bg-ink/[0.035] py-2 pl-3 pr-2"><span className="min-w-0 flex-1 truncate text-small">{item.name}</span><Button type="button" onClick={() => void reveal(item.folder)}>Reveal</Button></div>)}</div> : null}
      {postOpen && cut && version && view !== "exporting" ? <section aria-label="Post copy" className="-mt-1 space-y-2.5">
        {!modelReady ? <ModelSignIn feature="post" /> : <>
          {writing ? <p role="status" className="text-small text-muted">Writing post copy for all six…</p> : null}
          {PLATFORMS.map(([id, name]) => { const post = version.post?.find(p => p.platform === id); return post ? <div key={id} className="space-y-2 rounded-2xl bg-ink/[0.035] p-3.5">
            <div className="flex items-center gap-2"><p className="flex-1 text-small font-medium">{name}</p>
              <Button type="button" disabled={locked} onClick={async () => { try { await navigator.clipboard.writeText(postBody(post)); setPostCopied(name); } catch { setError("Could not copy. Select the post text and copy it."); } }}>{postCopied === name ? "Copied" : "Copy"}</Button>
              <Button type="button" disabled={locked} onClick={() => void writeCopy([id], true)}>Rewrite</Button></div>
            <p className="whitespace-pre-wrap text-small select-text">{postBody(post)}</p>
          </div> : null; })}
        </>}
      </section> : null}
      {view === "exporting" ? <div className="flex items-center gap-2">
        <p className="flex-1 text-small text-muted">Close this and keep editing. Export shows how far it is.</p>
        <Button type="button" disabled={activity?.state !== "running"} onClick={cancel} className={`h-10 px-4 ${pill}`}>Cancel</Button>
        <Button type="button" onClick={onClose} className="h-10 px-4 !bg-ink/[0.11] hover:!bg-ink/[0.15]">Keep editing</Button>
      </div> : null}
    </DialogSurface>
  </div>, document.body);
}

/** The editors, one click each: that timeline on its own. */
export function EditorMenu({ id, icons, onClose, onPick }: { id: string; icons: Icons | null; onClose: () => void; onPick: (editor: EditorId) => void }) {
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    surface.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!surface.current?.parentElement?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return <MenuSurface ref={surface} id={id} aria-label="Open in an editor" onClose={onClose} className="absolute bottom-full left-0 z-10 mb-2 flex w-[300px] flex-col gap-0.5 rounded-[18px] p-1.5">
    {EDITORS.map(editor => { const app = icons?.[editor.id]; const note = [editor.note, app && !app.installed ? "Not installed" : null].filter(Boolean).join(" · ");
      return <MenuOption key={editor.id} onClick={() => { onClose(); onPick(editor.id); }} className={`flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] text-ink ${FOCUS}`}>
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-ink/[0.06]">
          {app?.icon ? <img src={app.icon} alt="" width={28} height={28} className="size-7 object-contain" onError={event => { event.currentTarget.hidden = true; }} /> : <FilmStrip size={16} className="text-muted" />}
        </span>
        <span className="flex-1">{editor.name}</span>
        {note ? <span className="text-micro text-muted">{note}</span> : null}
      </MenuOption>; })}
  </MenuSurface>;
}

/** Stage, percent, bar, time left and how much of the edit is done, all from main. */
export function ExportProgress({ activity, editor, lengthS }: { activity: Activity | undefined; editor: boolean; lengthS: number }) {
  const stage = activity?.stage ?? "preparing";
  const pct = Math.round(Math.max(0, Math.min(100, activity?.pct ?? 0)));
  // Main measures the time left; between its updates it counts down here.
  const told = useRef<{ etaS: number; at: number } | null>(null);
  if (activity?.etaS == null) told.current = null;
  else if (told.current?.etaS !== activity.etaS) told.current = { etaS: activity.etaS, at: Date.now() };
  const left = told.current ? timeLeft(Math.max(0, told.current.etaS - (Date.now() - told.current.at) / 1000)) : null;
  const total = activity?.lengthS ?? lengthS, done = Math.min(total, activity?.doneS ?? 0);
  const doing = editor ? stage === "saving" ? "Writing the timeline" : STAGES.find(s => s.id === stage)?.doing : STAGES.find(s => s.id === stage)?.doing;
  const at = STAGES.findIndex(s => s.id === stage);
  return <div data-export-stage={stage} className="flex flex-col gap-3.5 rounded-[20px] bg-ink/[0.04] p-5">
    <div className="flex items-baseline gap-3">
      <span role="status" className="flex-1 text-[16px] font-semibold">{doing ?? "Preparing the edit"}</span>
      <span data-export-pct className="font-mono text-[14px] text-muted">{formatPercent(pct)}</span>
    </div>
    <div role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full bg-ink/[0.08]">
      <div className="st-button-primary h-full rounded-full transition-[width] duration-500" style={{ width: formatPercent(pct) }} />
    </div>
    <p data-export-left className="text-small text-muted">{left ?? "Working out the time left"}{editor ? "" : ` · ${duration(done)} of ${duration(total)} done`}</p>
    {editor ? null : <div className="mt-1 grid grid-cols-4 gap-2">
      {STAGES.map((s, i) => { const fill = i < at ? 100 : i === at ? activity?.stagePct ?? 0 : 0;
        return <div key={s.id} className="flex flex-col gap-1.5">
          <div className="h-1 overflow-hidden rounded-full bg-ink/[0.1]"><div className="h-full rounded-full bg-[var(--accent-text)] transition-[width] duration-500" style={{ width: `${fill}%` }} /></div>
          <span className={`text-micro ${i === at ? "font-medium text-ink" : "text-muted"}`}>{s.name}</span>
        </div>; })}
    </div>}
  </div>;
}
