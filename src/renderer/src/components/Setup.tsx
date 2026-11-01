import { Checkbox } from "./ui";
import { Tile, InlineError, Row } from "./ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Export, EditorResolve, EditorPremiere, EditorFinalCut, EditorCapCut } from "./icons";
import { MusicNotes, Play, Pause } from "@phosphor-icons/react";
import { type LookChoice } from "./FinishPanel";
import { motion } from "framer-motion";
import type { Engine, ExportTarget, FirstRunDownloads, Preferences, SetupCheck, StarterTrack, TerminalSetup, TerminalStep } from "../../../shared/schema";
import { getApi, isFixtureMode } from "../data";
import { instant, spring } from "../motion";
import { Button, FOCUS, ProgressRing, useMotionPresets } from "./ui";
import { PRIVACY_COPY } from "./privacy";
import { useShortcuts } from "../hooks/useShortcuts";
import { exportChoices, saveExportTargets } from "./ExportModal";
import { MusicFolderChoice, folderName } from "./finish/MusicFolder";
import { ENGINE_INFO, EngineMark } from "./aiEngines";
import { engineAnswered } from "./ModelAccess";
import { formatPercent } from "./processingFormat";
import panda from "../assets/precut-icon-1024.png";

const STORAGE_KEY = "precut.setup-completed";
import { CHECK_NAMES, setupAction, ENGINE_CHOICES, downloadLine, enginePill, SETUP_STEPS, type EnginePill, type SetupStep } from "./setupState";

export function useSetup() {
  const [completed, setCompleted] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
  });
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(async (background = false) => {
    if (pending.current) return;
    pending.current = true;
    if (!background) setChecking(true);
    try {
      let result = await getApi().checkSetup();
      // The browser preview has no Mac tools. Keep its setup assistant usable.
      if (!result.length && isFixtureMode()) result = CHECK_NAMES.map(id => ({ id,
        name: { ffmpeg: "precut tools", engine: "AI · Claude Code", venv: "Python environment", python: "Speech model" }[id],
        ok: id !== "python", required: id === "ffmpeg" || id === "engine",
        detail: id === "python" ? "About 1.6 GB · Downloads with your first shoot" : "Ready", fix: null }));
      if (!CHECK_NAMES.every(id => result.some(check => check.id === id))) throw new Error("Incomplete setup checks");
      if (mounted.current) {
        setChecks(result);
        setError(null);
      }
    } catch {
      if (mounted.current) { setError("Could not check this Mac. Try again."); }
    } finally {
      pending.current = false;
      // REL1: any finished check ends "checking". Setup's own background poll mounts first and can take the pending slot
      // from the first foreground check, which then never cleared it: Continue stayed off until the window got focus.
      if (mounted.current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => { void refresh(); };
    // ONB2: signing in later happens in the shared "Needs your AI" card, never by reopening the whole first run.
    window.addEventListener("focus", onFocus);
    return () => { mounted.current = false; window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  const ready = Boolean(!error && checks?.length && checks.every(check => !check.required || check.ok));
  return { checks, checking, error, refresh, ready,
    visible: !completed,
    complete: () => {
      try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* this session can still continue */ }
      setCompleted(true);
    } };
}

type SetupProps = Pick<ReturnType<typeof useSetup>, "checks" | "checking" | "error" | "refresh" | "ready"> & { onContinue: () => void };
export { POST_PLACES as postPlaces, type PostPlace } from "../../../main/post-places";
import { POST_PLACES as postPlaces, normalizePostPlaces, postingPreferences as postPreferences, type PostPlace } from "../../../main/post-places";
export { postPreferences };
export function inferredPostPlaces(value: Preferences): PostPlace[] {
  if (value.output.posts?.length) return normalizePostPlaces(value.output.posts);
  return [...(value.output.shapes.includes("9:16") ? ["vertical" as const] : []),
    ...(value.output.shapes.includes("16:9") ? ["youtube" as const] : []),
    ...(value.output.shapes.some(shape => shape === "4:5" || shape === "1:1") ? ["linkedin" as const] : [])];
}
export function PostPlaces({ value, onChange, disabled }: { value: PostPlace[]; onChange: (value: PostPlace[]) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled} className="space-y-2"><legend className="sr-only">Where do you post?</legend>
    {postPlaces.map(place => <div key={place.id} className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${value.includes(place.id) ? "bg-[var(--selection-fill)]" : "bg-ink/[0.035]"}`}>
      <label className="flex flex-1 cursor-pointer items-center gap-3 text-small"><Checkbox checked={value.includes(place.id)} aria-label={place.name}
        onChange={() => onChange(value.includes(place.id) ? value.filter(id => id !== place.id) : [...value, place.id])} className={`size-4 accent-accent ${FOCUS}`} />
        <span className="flex-1 font-medium">{place.name}</span><span className="font-mono text-micro text-muted">{place.shape}</span></label>
      {value.includes(place.id) && <Tile type="button" aria-label={`Make ${place.name} main`} aria-pressed={value[0] === place.id}
        onClick={() => onChange([place.id, ...value.filter(id => id !== place.id)])} className={`rounded-full px-2 py-1 text-micro ${value[0] === place.id ? "bg-ink text-ground" : "text-muted hover:bg-ink/[0.06]"} ${FOCUS}`}>{value[0] === place.id ? "Main" : "Make main"}</Tile>}
    </div>)}
  </fieldset>;
}
export function EditorChoices({ value, onChange, disabled }: { value: ExportTarget[]; onChange: (value: ExportTarget[]) => void; disabled?: boolean }) {
  const [icons, setIcons] = useState<Awaited<ReturnType<ReturnType<typeof getApi>["appIcons"]>> | null>(null);
  useEffect(() => { let active = true; void getApi().appIcons().then(result => { if (active) setIcons(result); }).catch(() => {}); return () => { active = false; }; }, []);
  return <fieldset disabled={disabled} className="space-y-2"><legend className="sr-only">Export targets</legend>
    {[...exportChoices].sort((a, b) => Number(b.id !== "mp4" && icons?.[b.id]?.installed || false) - Number(a.id !== "mp4" && icons?.[a.id]?.installed || false)).map(editor => {
      const app = editor.id !== "mp4" ? icons?.[editor.id] : null;
      const Mark = { resolve: EditorResolve, premiere: EditorPremiere, finalcut: EditorFinalCut, capcut: EditorCapCut, mp4: Export }[editor.id];
      return <label key={editor.id} className={`flex cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 text-small ${value.includes(editor.id) ? "bg-[var(--selection-fill)]" : "bg-ink/[0.035]"}`}>
        <Checkbox aria-label={editor.name} checked={value.includes(editor.id)} onChange={() => onChange(value.includes(editor.id) ? value.filter(id => id !== editor.id) : [...value, editor.id])} className={`size-4 accent-accent ${FOCUS}`} />
        {app?.icon ? <img src={app.icon} alt="" className="size-8 object-contain" /> : <Mark size={28} className="text-muted" />}
        <span className="flex-1 font-medium">{editor.id === "mp4" ? "Just the finished MP4" : editor.name}</span>
        {app?.installed && <span className="text-micro text-good">Installed</span>}
      </label>;
    })}
  </fieldset>;
}

/** POLISH1: the first run's "How do you want your videos?". The finished video comes first and is on by default; the
 * editors are extras ("Also open in"). It stores the same export targets as Settings (mp4 plus any editors). */
export function VideoChoices({ value, onChange, disabled }: { value: ExportTarget[]; onChange: (value: ExportTarget[]) => void; disabled?: boolean }) {
  const [icons, setIcons] = useState<Awaited<ReturnType<ReturnType<typeof getApi>["appIcons"]>> | null>(null);
  useEffect(() => { let active = true; void getApi().appIcons().then(result => { if (active) setIcons(result); }).catch(() => {}); return () => { active = false; }; }, []);
  const toggle = (id: ExportTarget) => onChange(value.includes(id) ? value.filter(entry => entry !== id) : [...value, id]);
  const editors = exportChoices.filter(editor => editor.id !== "mp4")
    .sort((a, b) => Number(!!icons?.[b.id as Exclude<ExportTarget, "mp4">]?.installed) - Number(!!icons?.[a.id as Exclude<ExportTarget, "mp4">]?.installed));
  const row = (on: boolean) => `flex cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 text-small ${on ? "bg-[var(--selection-fill)]" : "bg-ink/[0.035]"}`;
  return <fieldset disabled={disabled} className="space-y-2"><legend className="sr-only">How you want your videos</legend>
    <label data-video-choice="mp4" className={row(value.includes("mp4"))}>
      <Checkbox aria-label="The finished video" checked={value.includes("mp4")} onChange={() => toggle("mp4")} className={`size-4 accent-accent ${FOCUS}`} />
      <Export size={28} className="text-muted" />
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-medium">The finished video</span><span className="text-micro text-muted">Captions, look and sound done, ready to post</span></span>
    </label>
    <p className="m-0 px-1 pt-3 text-micro text-muted">Also open in</p>
    {editors.map(editor => {
      const app = icons?.[editor.id as Exclude<ExportTarget, "mp4">];
      const Mark = { resolve: EditorResolve, premiere: EditorPremiere, finalcut: EditorFinalCut, capcut: EditorCapCut }[editor.id as Exclude<ExportTarget, "mp4">];
      return <label key={editor.id} data-video-choice={editor.id} className={row(value.includes(editor.id))}>
        <Checkbox aria-label={`Also open in ${editor.name}`} checked={value.includes(editor.id)} onChange={() => toggle(editor.id)} className={`size-4 accent-accent ${FOCUS}`} />
        {app?.icon ? <img src={app.icon} alt="" className="size-8 object-contain" /> : <Mark size={28} className="text-muted" />}
        <span className="flex-1 font-medium">{editor.name}</span>
        {app?.installed && <span className="text-micro text-good">Installed</span>}
      </label>;
    })}
  </fieldset>;
}

export { SampleLookPicker, prepareSetupLooks, forgetSetupLooks } from "./finish/SampleLookPicker";
import { SampleLookPicker, prepareSetupLooks } from "./finish/SampleLookPicker";

// ---- ONB2: the first run (briefs/ONB2-first-run.md, approved prototype docs/plans/onboarding/prototype.html).
// Welcome, AI (optional), terminal, music, where you post, editors, look. Continue is never blocked; Skip skips one step.
const STEP_NAMES: Record<SetupStep, string> = { welcome: "Welcome", ai: "Your AI", terminal: "Terminal", music: "Music", post: "Where you post", editors: "Your editors", look: "Your look" };
type Phase = "waiting" | "checking" | "ready";
type EngineRow = Awaited<ReturnType<ReturnType<typeof getApi>["listEngines"]>>[number];

export default function Setup({ checks, refresh, onContinue }: SetupProps) {
  const { reduced } = useMotionPresets();
  const [step, setStep] = useState(0);
  const id: SetupStep = SETUP_STEPS[step], last = SETUP_STEPS.length - 1;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionPending = useRef(false);
  const mounted = useRef(true);
  // Music
  const [musicFolder, setMusicFolder] = useState<string | null>(null);
  const [starter, setStarter] = useState<{ on: boolean; tracks: StarterTrack[] } | null>(null);
  // Where you post, editors, look
  const [places, setPlaces] = useState<PostPlace[]>([]);
  const [targets, setTargets] = useState<ExportTarget[]>(["mp4"]);  // POLISH1: the finished video is on by default
  const [choice, setChoice] = useState<LookChoice>({ preset: "clean", words: null, intensity: .7 });
  const [preferencesReady, setPreferencesReady] = useState(false);
  // AI
  const [engine, setEngine] = useState<Engine | "none">("claude");
  const [engines, setEngines] = useState<EngineRow[]>([]);
  const [phases, setPhases] = useState<Partial<Record<Engine, Phase>>>({});
  const [aiNote, setAiNote] = useState<string | null>(null);
  // A tile shows as chosen only once the person chose it (or a saved choice works): an unset default is not a choice.
  const [picked, setPicked] = useState(false);
  // Terminal
  const [terminal, setTerminal] = useState<Partial<Record<"claude" | "codex", TerminalSetup>>>({});
  const [settingUp, setSettingUp] = useState<"claude" | "codex" | null>(null);
  // Downloads
  const [downloads, setDownloads] = useState<FirstRunDownloads | null>(null);

  useEffect(() => {
    mounted.current = true;
    const api = getApi();
    void api.getPreferences().then(prefs => { if (mounted.current) { setChoice(prefs.look); setPreferencesReady(true); } })
      .catch(() => { if (mounted.current) setActionError("Could not read preferences. You can skip these choices for now."); });
    void safely(() => api.getMusicFolder()).then(value => { if (mounted.current) setMusicFolder(value); });
    void safely(() => api.starterMusic ? api.starterMusic() : Promise.resolve(null)).then(value => { if (mounted.current && value) setStarter(value); });
    void safely(() => api.getEngineChoice ? api.getEngineChoice() : api.getEngine()).then(value => { if (mounted.current && value) { setEngine(value); if (value === "none") setPicked(true); } });
    // First-run downloads start at once and keep going while the person sets up.
    void safely(() => api.startFirstRunDownloads());
    // POLISH1: the look step's galleries render now, so they are ready by the last step.
    void prepareSetupLooks().catch(() => {});
    const poll = async () => { const value = await safely(() => api.firstRunDownloads()); if (mounted.current && value) setDownloads(value); };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);

  // On the AI step, notice by ourselves when an install or a sign-in finishes, then test it once.
  const testing = useRef<Partial<Record<Engine, boolean>>>({});
  useEffect(() => {
    if (id !== "ai") return;
    let active = true;
    const look = async () => {
      const value = await safely(() => getApi().listEngines(true));
      if (!active || !value) return;
      setEngines(value);
      void refresh(true);
      for (const row of value) {
        if (phases[row.id] !== "waiting" || testing.current[row.id]) continue;
        if (row.installed && (row.id === "muse" || row.signedIn === true)) void check(row.id);
      }
    };
    void look();
    const timer = window.setInterval(() => void look(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [id, phases, refresh]);
  useEffect(() => {
    if (id !== "terminal") return;
    for (const agent of ["claude", "codex"] as const) void safely(() => getApi().terminalStatus ? getApi().terminalStatus!(agent) : Promise.resolve(null))
      .then(value => { if (mounted.current && value) setTerminal(previous => previous[agent]?.steps.command ? previous : { ...previous, [agent]: value }); });
  }, [id]);

  async function check(target: Engine) {
    testing.current[target] = true;
    setPhases(previous => ({ ...previous, [target]: "checking" }));
    const result = await safely(() => getApi().testEngine(target));
    testing.current[target] = false;
    if (!mounted.current) return;
    if (result?.ok) { setPhases(previous => ({ ...previous, [target]: "ready" })); setAiNote(null); if (typeof engineAnswered === "function") engineAnswered(target); window.dispatchEvent(new Event("precut:ai-changed")); }
    else { setPhases(previous => { const next = { ...previous }; delete next[target]; return next; }); setAiNote(result?.text ?? "precut couldn't reach your AI. Try again."); }
  }
  async function choose(next: Engine | "none") {
    if (busy) return;
    setEngine(next); setPicked(true); setActionError(null); setAiNote(null);
    try { await getApi().setEngine(next); window.dispatchEvent(new Event("precut:ai-changed")); void refresh(true); }
    catch { setActionError("Could not save your choice. Try again."); }
  }
  async function engineAction(target: Engine, pill: EnginePill) {
    if (pill !== "get" && pill !== "signin") return;
    await choose(target);
    setPhases(previous => ({ ...previous, [target]: "waiting" }));
    try {
      if (pill === "get" && target === "claude") await getApi().setupPrecut();
      else await getApi().openEngineHelp(target, pill === "get" ? "install" : "signin");
      if (pill === "signin") setAiNote(`Terminal opened with "${ENGINE_INFO[target].signIn}" ready. Sign in there; precut notices by itself.`);
      else if (target !== "claude") setAiNote(`The ${ENGINE_INFO[target].label} install page is open. precut notices when it's there.`);
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, "") : "";
      setAiNote(pill === "signin" ? `Terminal couldn't open. Run "${ENGINE_INFO[target].signIn}" in Terminal; precut notices when you're signed in.` : message || "That did not work. Try again.");
    }
  }
  async function setUp(agent: "claude" | "codex") {
    if (settingUp || !getApi().setUpTerminal) return;
    setSettingUp(agent);
    try {
      for (const name of ["command", "connect", "skill", "check"] as TerminalStep[]) {
        const result = await getApi().setUpTerminal!(agent, name);
        if (!mounted.current) return;
        setTerminal(previous => ({ ...previous, [agent]: result }));
        if (!result.steps[name]?.ok) break;
      }
    } catch { setActionError("Couldn't set that up. Try again."); }
    finally { if (mounted.current) setSettingUp(null); }
  }

  const advance = () => { setActionError(null); if (step === last) onContinue(); else setStep(step + 1); };
  async function next() {
    if (actionPending.current) return;
    if (id === "welcome" || id === "ai" || id === "terminal" || id === "music") { advance(); return; }
    actionPending.current = true; setBusy(true); setActionError(null);
    try {
      const api = getApi();
      const prefs = await api.getPreferences();
      if (id === "post" && places.length) await api.setPreferences(postPreferences(prefs, places));
      if (id === "editors" && targets.length) await saveExportTargets(targets);
      if (id === "look") await api.setPreferences({ look: choice });
      if (mounted.current) advance();
    } catch { if (mounted.current) setActionError("Could not save your choice. Try again, or skip for now."); }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  }
  const skip = () => { if (busy || actionPending.current) return; advance(); };
  const pillOf = (target: Engine) => enginePill(engines.find(row => row.id === target), target, phases[target]);
  const chosenReady = engine === "none" || pillOf(engine) === "ready";
  const canNext = !busy && (id === "post" ? places.length > 0 : id === "editors" ? targets.length > 0 : id === "look" ? preferencesReady : true);
  const nextLabel = busy ? "Working…" : id === "welcome" ? "Get started" : id === "look" ? "Finish" : id === "ai" && !chosenReady ? "Skip for now" : "Continue";
  const [help, setHelp] = useState(false);
  const shortcuts = useShortcuts("setup", [
    { id: "setup-next", keys: ["Cmd+Enter"], label: "Continue setup", scope: "setup", enabled: canNext, handler: () => void next() },
    { id: "setup-back", keys: ["Alt+ArrowLeft"], label: "Previous setup step", scope: "setup", enabled: step > 0 && !busy, handler: () => setStep(n => Math.max(0, n - 1)) },
    { id: "setup-help", keys: ["?"], label: "Keyboard shortcuts", scope: "setup", handler: () => setHelp(value => !value) },
  ]);
  const line = downloadLine(downloads);
  const wide = id === "look" || id === "welcome";
  // POLISH1: the name sits beside the window's traffic lights, on their line. The step scrolls from its top: centring
  // with auto margins (never align-items) keeps a tall step (the look gallery) reachable all the way up.
  return <main data-setup-step={id} className="flex h-dvh flex-col overflow-hidden text-body text-ink">
    <div className="flex h-[60px] shrink-0 items-center pl-[100px] pr-6 text-small font-semibold text-muted" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}><span>precut</span></div>
    <div data-setup-scroll className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
      <motion.section key={id} aria-labelledby="setup-title" initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? instant : spring.sheet}
        className={`m-auto flex w-full flex-col gap-5 ${id === "look" ? "max-w-[1040px]" : wide ? "max-w-[760px]" : "max-w-[620px]"}`}>
        {id === "welcome" ? <Welcome />
          : id === "ai" ? <AiStep engine={picked || (engine !== "none" && pillOf(engine) === "ready") ? engine : null} engines={engines} pillOf={pillOf} busy={busy} note={aiNote} onChoose={choose} onAction={engineAction} />
          : id === "terminal" ? <TerminalSetupStep setups={terminal} busy={settingUp} onSetUp={setUp} />
          : id === "music" ? <MusicStep folder={musicFolder} onFolder={setMusicFolder} starter={starter} onStarter={async on => { setStarter(previous => previous ? { ...previous, on } : previous); await safely(() => getApi().setStarterMusic ? getApi().setStarterMusic!(on) : Promise.resolve()); }} />
          : <>
            <header><h1 id="setup-title" className="m-0 font-display text-[26px] font-bold leading-tight tracking-tight">{{ post: "Where do you post?", editors: "How do you want your videos?", look: "Pick your look" }[id]}</h1>
              <p className="m-0 mt-2 max-w-[52ch] text-[16px] text-muted">{{ post: "Choose all that apply. Your main place sets the caption safe area.", editors: "precut makes the finished video for you. If you also like to finish in an editor, it can open the edit there too.", look: "Choose how your edits look. Change it any time, per edit." }[id]}</p></header>
            {id === "post" ? <PostPlaces value={places} onChange={setPlaces} disabled={busy} />
              : id === "editors" ? <VideoChoices value={targets} onChange={setTargets} disabled={busy} />
              : <SampleLookPicker value={choice} disabled={busy} onChoose={async value => { setChoice(value); return true; }} />}
          </>}
        {actionError && <InlineError className="m-0 text-small text-danger">{actionError}</InlineError>}
        {help && <div className="rounded-2xl bg-ink/[0.035] p-3 text-small">{shortcuts.filter(shortcut => shortcut.enabled !== false).map(shortcut => <p key={shortcut.id} className="flex justify-between gap-4"><span>{shortcut.label}</span><kbd className="font-mono text-micro">{shortcut.keys.join(" / ")}</kbd></p>)}</div>}
      </motion.section>
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-6 pb-5 pt-3">
      <div className="flex min-w-0 items-center gap-3 font-mono text-micro text-muted">
        <ol aria-label="Setup progress" className="flex gap-1.5">{SETUP_STEPS.map((name, index) => <li key={name} aria-current={step === index ? "step" : undefined} aria-label={`${STEP_NAMES[name]}${index < step ? ", visited" : ""}`}><span className={`block size-1.5 rounded-full ${step === index ? "bg-ink" : index < step ? "bg-ink/40" : "bg-ink/15"}`} /></li>)}</ol>
        {line && <span role="status" data-downloads={downloads?.state} className={`flex min-w-0 items-center gap-2 ${downloads?.state === "ready" ? "text-good" : ""}`}>
          <span className="truncate">{line}</span>
          {downloads?.state === "working" && downloads.what === "speech" && <span aria-hidden="true" className="relative block h-1 w-[90px] shrink-0 overflow-hidden rounded-full bg-ink/15">
            <span className="st-brand-gradient absolute inset-y-0 left-0 rounded-full" style={{ width: formatPercent(Math.max(2, downloads.pct)) }} /></span>}
        </span>}
      </div>
      <div className="flex items-center gap-1.5">
        {step > 0 && <Button variant="ghost" disabled={busy} title="Back (Alt+Left)" onClick={() => { setActionError(null); setStep(step - 1); }}>Back</Button>}
        {(id === "music" || id === "post" || id === "editors" || id === "look") && <Button variant={id === "look" ? "secondary" : "ghost"} disabled={busy} onClick={skip}>Skip</Button>}
        <Button variant="primary" disabled={!canNext} onClick={() => void next()} title="Continue (Cmd+Enter)" className="px-6 py-2.5 text-[14px]">{nextLabel}</Button>
      </div>
    </footer>
  </main>;
}

export { setupAction, ENGINE_CHOICES, downloadLine, PRIVACY_COPY };
/** Tolerant of a bridge that lacks a method: first-run help must never break the screen. */
function safely<T>(call: () => Promise<T>): Promise<T | null> { try { return call().catch(() => null); } catch { return Promise.resolve(null); } }

/** One welcome: what runs on this Mac for free, what the AI the person already pays for adds, and exactly what it receives. */
export function Welcome() {
  return <div className="flex flex-col items-center gap-5 text-center">
    <img src={panda} alt="" className="size-16 rounded-[18px]" />
    <h1 id="setup-title" className="m-0 max-w-[16ch] font-display text-[clamp(28px,4.2vw,44px)] font-bold leading-[1.08] tracking-tight">precut watches your footage for you.</h1>
    <p className="m-0 max-w-[52ch] text-[16px] text-muted">Two hours of footage is two hours of watching before you can cut a frame, and usually far longer to edit. precut does the watching, on your Mac, while you get on with something else.</p>
    <div className="grid w-full gap-3 text-left sm:grid-cols-2">
      <div data-welcome="local" className="flex flex-col gap-2 rounded-2xl bg-surface px-[18px] py-4">
        <span className="font-mono text-[11px] font-semibold uppercase text-good">On this Mac, free</span>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small text-muted"><li>Reads every clip, previews and stills</li><li>Transcribes what you said</li><li>Captions, Look, sound, editing, export</li></ul>
        <small className="text-micro text-muted/80">Your video and audio never leave the Mac.</small>
      </div>
      <div data-welcome="ai" className="flex flex-col gap-2 rounded-2xl bg-surface px-[18px] py-4">
        <span className="font-mono text-[11px] font-semibold uppercase text-accent">With the AI you already pay for</span>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small text-muted"><li>Finds your best takes</li><li>Ideas and first edits, ready to open</li><li>Make it better, Ask, post copy</li></ul>
        <small className="text-micro text-muted/80">It gets transcripts, clip names and small frames, never your video.</small>
      </div>
    </div>
  </div>;
}

const PILL_BASE = "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-medium";
function Pill({ pill, engine, onAction }: { pill: EnginePill; engine: Engine; onAction: (engine: Engine, pill: EnginePill) => void }) {
  if (pill === "ready") return <span data-pill="ready" className={`${PILL_BASE} bg-good-soft text-good`}>Ready</span>;
  if (pill === "waiting" || pill === "checking") return <span data-pill={pill} role="status" className={`${PILL_BASE} bg-ink/[0.06] text-muted`}><ProgressRing pct={null} label={pill === "waiting" ? "Waiting" : "Checking"} className="text-muted" />{pill === "waiting" ? "Waiting for you" : "Checking it answers"}</span>;
  return <Button variant="primary" data-pill={pill} onClick={event => { event.stopPropagation(); onAction(engine, pill); }} className="!px-3 !py-1.5 !text-[12.5px]">{pill === "signin" ? "Sign in" : ENGINE_INFO[engine].get}</Button>;
}

/** The AI step: real marks, one action per engine, and "Start without AI" as a first-class choice. Muse only when installed. */
export function AiStep({ engine, engines, pillOf, busy, note, onChoose, onAction }: { engine: Engine | "none" | null; engines: EngineRow[]; pillOf: (engine: Engine) => EnginePill; busy: boolean; note: string | null;
  onChoose: (engine: Engine | "none") => void; onAction: (engine: Engine, pill: EnginePill) => void }) {
  const shown = ENGINE_CHOICES.filter(choice => choice.id !== "muse" || engines.find(row => row.id === "muse")?.installed);
  const apiKey = engines.find(row => row.id === "claude")?.apiKey;
  return <>
    <header><h1 id="setup-title" className="m-0 font-display text-[26px] font-bold leading-tight tracking-tight">Add an AI to go further</h1>
      <p className="m-0 mt-2 max-w-[52ch] text-[16px] text-muted">precut works without one. Pick the AI you already use and it adds best takes, ideas and first edits.</p></header>
    <ul role="radiogroup" aria-label="AI engine" className="m-0 flex list-none flex-col gap-2 p-0">{shown.map(choice => {
      const info = ENGINE_INFO[choice.id], selected = engine === choice.id;
      return <li key={choice.id}><div role="radio" tabIndex={0} aria-checked={selected} aria-label={choice.label} data-engine={choice.id}
        onClick={() => { if (!busy) onChoose(choice.id); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!busy) onChoose(choice.id); } }}
        className={`flex w-full cursor-pointer items-center gap-3.5 rounded-2xl px-4 py-3 text-left ${selected ? "bg-[var(--selection-fill)]" : "bg-surface hover:bg-[var(--surface-hover)]"} ${FOCUS}`}>
        <EngineMark engine={choice.id} />
        <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold">{info.label}</span>
          <span className="text-[13px] text-muted">{choice.id === "claude" && apiKey && pillOf("claude") === "signin" ? "Signed in with an API key. precut uses your Claude subscription, not an API key." : info.plan}</span></span>
        <Pill pill={pillOf(choice.id)} engine={choice.id} onAction={onAction} />
      </div></li>;
    })}</ul>
    <div data-without-ai className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 ${engine === "none" ? "bg-[var(--selection-fill)]" : "bg-surface"}`}>
      <span className="flex flex-col"><span className="font-semibold">Start without Claude or Codex</span><span className="text-[13px] text-muted">Edit by hand now. Transcripts and framing still run on your Mac. Add one any time in Settings.</span></span>
      <Button variant="secondary" aria-label="Start without Claude or Codex" aria-pressed={engine === "none"} disabled={busy} onClick={() => onChoose("none")}>{engine === "none" ? "Chosen" : "Start"}</Button>
    </div>
    {note && <p role="status" className="m-0 text-small text-muted">{note}</p>}
    <p className="m-0 text-micro text-muted">{PRIVACY_COPY}</p>
  </>;
}

const TERMINAL_ITEMS: Record<TerminalStep, (label: string) => string> = { command: () => "Add the precut command", connect: label => `Connect precut to ${label}`, skill: () => "Install the precut skill", check: label => `Check ${label} can see it` };
const TERMINAL_DOING: Record<TerminalStep, (label: string) => string> = { command: () => "Adding the precut command", connect: label => `Connecting precut to ${label}`, skill: () => "Installing the precut skill", check: label => `Checking ${label} can see it` };
/** "Use precut from your terminal": Claude Code and Codex. POLISH1: calm and plain. Setting up says so in one line;
 * done, the card is one line ("precut now works in Claude Code") with the first ask to copy as a quiet second line;
 * a failure shows the steps and the command to run by hand. Continue (the footer) is the one primary action. */
export function TerminalSetupStep({ setups, busy, onSetUp }: { setups: Partial<Record<"claude" | "codex", TerminalSetup>>; busy: "claude" | "codex" | null; onSetUp: (agent: "claude" | "codex") => void }) {
  return <>
    <header><h1 id="setup-title" className="m-0 font-display text-[26px] font-bold leading-tight tracking-tight">Use precut from your terminal</h1>
      <p className="m-0 mt-2 max-w-[52ch] text-[16px] text-muted">precut also works in Claude Code and Codex. Say what you want there and precut makes the edit, even with this app closed. Set up the ones you use, or just continue.</p></header>
    <div className="flex flex-col gap-2.5">{(["claude", "codex"] as const).map(agent => {
      const setup = setups[agent], label = ENGINE_INFO[agent].label;
      const names = Object.keys(TERMINAL_ITEMS) as TerminalStep[];
      const failed = setup && names.find(name => setup.steps[name] && !setup.steps[name]!.ok);
      const working = busy === agent;
      const state = working ? "working" : setup?.done ? "done" : failed ? "failed" : "idle";
      if (state === "done") return <div key={agent} data-terminal={agent} data-terminal-state="done" className="flex flex-col gap-1.5 rounded-2xl bg-surface px-4 py-3">
        <div className="flex items-center gap-3"><EngineMark engine={agent} size={28} />
          <span role="status" className="min-w-0 flex-1 font-semibold">precut now works in {label}</span>
          <Check size={16} className="shrink-0 text-good" aria-hidden="true" /></div>
        <AskLine text={setup!.prompt} />
      </div>;
      const doing = working ? names.find(name => !setup?.steps[name]?.ok) ?? "check" : null;
      return <div key={agent} data-terminal={agent} data-terminal-state={state} className="flex flex-col gap-2.5 rounded-2xl bg-surface p-4">
        <div className="flex items-center gap-3"><EngineMark engine={agent} /><span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold">{label}</span>
          {working ? <span role="status" className="text-[13px] text-muted">{TERMINAL_DOING[doing!](label)}…</span>
            : failed ? <span className="text-[13px] text-muted">Couldn't finish setting this up.</span>
            : setup && !setup.installed ? <span className="text-[13px] text-muted">{label} isn't on this Mac yet.</span> : null}</span>
          {working ? <span className={`${PILL_BASE} bg-ink/[0.06] text-muted`}><ProgressRing pct={null} label="Setting up" className="text-muted" />Setting up</span>
            : <Button variant="secondary" disabled={!!busy} onClick={() => onSetUp(agent)} className="!px-3.5 !py-1.5">{failed ? "Try again" : "Set it up"}</Button>}
        </div>
        {failed && <div className="flex flex-col gap-1.5 text-small text-muted">{names.map(name => {
          const result = setup!.steps[name];
          return <div key={name} data-terminal-step={name} data-ok={result ? String(result.ok) : undefined} className="flex items-start gap-2.5">
            <span aria-hidden="true" className={`w-3.5 shrink-0 text-center ${result?.ok ? "text-good" : result ? "text-danger" : "text-muted/60"}`}>{result?.ok ? <Check size={13} className="inline" /> : result ? "!" : "·"}</span>
            <span className="min-w-0">{TERMINAL_ITEMS[name](label)}{result && !result.ok && result.detail ? <span className="block text-micro">{result.detail}</span> : null}</span>
          </div>;
        })}</div>}
        {setup?.copy && <CopyLine text={setup.copy} label="Run this instead" />}
      </div>;
    })}</div>
  </>;
}
function copyText(text: string, done: (ok: boolean) => void) {
  try { void navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); } catch { done(false); }
}
/** POLISH1: the first ask, as a quiet line under "precut now works in ...": the words and a small Copy. */
function AskLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <div data-copy data-terminal-ask className="flex min-w-0 items-center gap-2 pl-[40px] text-[13px] text-muted">
    <span className="min-w-0 flex-1 truncate">Try <span className="font-mono text-[12.5px] text-ink/80">{text}</span></span>
    <Button variant="ghost" onClick={() => copyText(text, ok => { setCopied(ok); if (ok) window.setTimeout(() => setCopied(false), 1600); })} className="!px-2.5 !py-1 !text-[12px]">{copied ? "Copied" : "Copy"}</Button>
  </div>;
}
function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="flex flex-col gap-1"><span className="text-micro text-muted">{label}</span>
    <div data-copy className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-[#0b0b0f] px-3.5 py-2.5 font-mono text-[13px] text-[#c9d4ff]">
      <span className="min-w-0 break-all">{text}</span>
      <Button variant="secondary" onClick={() => copyText(text, ok => { setCopied(ok); if (ok) window.setTimeout(() => setCopied(false), 1600); })} className="!py-1">{copied ? "Copied" : "Copy"}</Button>
    </div></div>;
}

/** Music: the starter tracks are the default (free to post, credits handled); the person's own folder stays a choice. */
export function MusicStep({ folder, onFolder, starter, onStarter }: { folder: string | null; onFolder: (folder: string) => void; starter: { on: boolean; tracks: StarterTrack[] } | null; onStarter: (on: boolean) => void }) {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const preview = (track: StarterTrack) => {
    const element = audio.current;
    if (!element || !track.url) return;
    if (playing === track.file) { element.pause(); setPlaying(null); return; }
    element.src = track.url; element.currentTime = 0;
    void element.play().then(() => setPlaying(track.file), () => setPlaying(null));
  };
  const tracks = starter?.tracks ?? [];
  return <>
    <header><h1 id="setup-title" className="m-0 font-display text-[26px] font-bold leading-tight tracking-tight">Music for your edits</h1>
      <p className="m-0 mt-2 max-w-[52ch] text-[16px] text-muted">precut picks tracks to fit each edit. Start with a few that are free to post, or use your own folder of music you're allowed to post.</p></header>
    {tracks.length > 0 && <div data-starter-tracks className={`flex flex-col gap-2 rounded-2xl p-4 ${starter?.on ? "bg-[var(--selection-fill)]" : "bg-surface"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="flex flex-col"><span className="font-semibold">Use the starter tracks</span>
        <span className="text-[13px] text-muted">{tracks.length} tracks, free to post with a credit. precut adds the credit to your export.</span></span>
        <Button variant="secondary" aria-pressed={!!starter?.on} onClick={() => onStarter(!starter?.on)}>{starter?.on ? "On" : "Use them"}</Button></div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">{tracks.map(track => <li key={track.file} data-track={track.title} className="flex items-center gap-3 rounded-xl px-1 py-1 text-small">
        <Button variant="ghost" aria-label={`${playing === track.file ? "Stop" : "Play"} a preview of ${track.title}`} onClick={() => preview(track)} className="size-8 !p-0">{playing === track.file ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}</Button>
        <span className="min-w-0 flex-1 truncate"><span className="font-medium">{track.title}</span><span className="text-muted"> · {track.artist}</span></span>
        <span className="shrink-0 font-mono text-micro text-muted">{track.mood} · {track.licence}</span>
      </li>)}</ul>
      <audio ref={audio} preload="none" onEnded={() => setPlaying(null)} onTimeUpdate={event => { if (event.currentTarget.currentTime > 15) { event.currentTarget.pause(); setPlaying(null); } }} />
    </div>}
    <div data-music-folder className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3.5">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-ink/[0.06] text-muted"><MusicNotes size={18} /></span>
      <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold">{folder ? folderName(folder) : "Your own music"}</span>
        <span className="truncate font-mono text-micro text-muted" title={folder ?? undefined}>{folder ?? "A folder of tracks you have the rights to"}</span></span>
      <MusicFolderChoice folder={folder} line={null} onChosen={onFolder} />
    </div>
  </>;
}
