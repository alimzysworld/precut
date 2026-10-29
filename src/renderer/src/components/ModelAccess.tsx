// ONB2: the one shared "Needs your AI" card. Every place that needs the person's AI shows it (inline, or in a sheet
// for a button that was pressed). It names the chosen engine and what the feature does, and gives the one action for
// the engine's state: pick one, get it, sign in, waiting, checking, ready, out of allowance, offline or unknown.
// It notices sign-in by itself, runs one tiny test call, then hands back to the feature, which carries on.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiStatus, Engine } from "../../../shared/schema";
import { engineProblemOf } from "../../../shared/engine-problem";
import { getApi } from "../data";
import { Button, InlineError, Modal, ProgressRing } from "./ui";
import { ENGINE_INFO, EngineMark } from "./aiEngines";

/** True when the chosen engine is ready. Kept as a plain boolean: every gated place reads it. */
export const ModelAccess = createContext(true);
export const useModelAccess = () => useContext(ModelAccess);
type AiAccessValue = {
  status: AiStatus | null;                         // the engine's state, with a problem a real test found laid over it
  ready: boolean;                                  // signed in and answering (tested once when it became ready)
  checking: boolean;                               // the one tiny test is running
  failure: string | null;                          // the test's plain words when it did not answer
  refresh: (fresh?: boolean) => Promise<AiStatus | null>;
  verify: () => Promise<boolean>;
};
export const AiAccess = createContext<AiAccessValue>({ status: null, ready: true, checking: false, failure: null, refresh: async () => null, verify: async () => false });
// What was asked, kept outside any card: an inline card unmounts the moment its feature can show, so the feature's
// "carry on" waits here and runs once the AI has answered its test.
const pendingResumes = new Set<() => void>();
export function queueResume(resume: () => void) { pendingResumes.add(resume); }
// The first run tests an engine itself when it notices a sign-in; the app then trusts that answer instead of asking again.
let answered: { engine: Engine; at: number } | null = null;
export function engineAnswered(engine: Engine) { answered = { engine, at: Date.now() }; }
function flushResumes() {
  const resumes = [...pendingResumes]; pendingResumes.clear();
  for (const resume of resumes) { try { resume(); } catch { /* the feature says what went wrong itself */ } }
}

/** What each gated feature does, in one line, for the card. */
export const AI_FEATURES = {
  ideas: { name: "Ideas", line: "finds the moments in this shoot worth making into a video" },
  firstEdits: { name: "First edits", line: "cut your best takes into an edit you can open and change" },
  takes: { name: "Best takes", line: "picks the best take of every line you said" },
  ask: { name: "Ask", line: "answers questions about your footage and changes the edit when you ask" },
  better: { name: "Make it better", line: "watches the edit and suggests what to change" },
  post: { name: "Post copy", line: "writes the caption and description for each place you post" },
  translate: { name: "Translated captions", line: "translates your captions and keeps their timing" },
  length: { name: "A new length", line: "re-cuts this edit to the length you choose" },
  videoType: { name: "Video type", line: "re-cuts this edit as a different kind of video" },
  voiceover: { name: "Voiceover script", line: "writes a voiceover script for this edit" },
  cleanRead: { name: "Clean read", line: "finds your best full read of the script" },
  rethink: { name: "Rethink", line: "makes the ideas and edits again without the missing clips" },
  retry: { name: "Retry", line: "runs this step again with your AI" },
  newEdit: { name: "A described edit", line: "makes an edit from what you describe" },
  anotherVersion: { name: "Another version", line: "finds another strong arrangement of this edit" },
  generic: { name: "This", line: "uses the AI you already pay for" },
} as const;
export type AiFeature = keyof typeof AI_FEATURES;
/** Kept for older callers and tests: the line the card used to show. */
export const MODEL_SIGN_IN = "Needs your AI";

type SignInRequest = { feature?: AiFeature; resume?: () => void };
/** Open the card in a sheet for a button that was pressed; resume runs once the AI answers. */
export function openModelSignIn(feature?: AiFeature, resume?: () => void) {
  window.dispatchEvent(new CustomEvent<SignInRequest>("precut:sign-in", { detail: { feature, resume } }));
}

/** App-level: the chosen engine's state, read on launch, on focus, after a change, and every 15 s (no model call).
 * When it becomes ready during the session (an install or a sign-in), one tiny test runs before anything relies on it;
 * then whatever was asked carries on. Ready at launch is trusted as it is: no call is spent on it. */
export function useAiAccess(fallbackReady: boolean): AiAccessValue {
  const [raw, setRaw] = useState<AiStatus | null>(null);
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<{ text: string; problem: "allowance" | "offline" | null; engine: Engine } | null>(null);
  const alive = useRef(true), first = useRef(true), testing = useRef(false), last = useRef<AiStatus | null>(null);
  const verify = useCallback(async () => {
    const engine = last.current?.engine;
    if (!engine || testing.current) return false;
    testing.current = true; setChecking(true);
    try {
      const result = answered?.engine === engine && Date.now() - answered.at < 120_000 ? { ok: true, text: "" } : await getApi().testEngine(engine);
      if (!alive.current) return false;
      if (result.ok) {
        setFailure(null); setVerified(true);
        flushResumes();
        return true;
      }
      const problem = engineProblemOf(result.text);
      setFailure({ text: result.text, problem: problem === "allowance" || problem === "offline" ? problem : null, engine });
      setVerified(false);
      return false;
    } catch { if (alive.current) setFailure({ text: "precut couldn't reach your AI. Try again.", problem: null, engine }); return false; }
    finally { testing.current = false; if (alive.current) setChecking(false); }
  }, []);
  const refresh = useCallback(async (fresh = false) => {
    try {
      const next = await getApi().aiStatus?.(fresh) ?? null;
      if (!alive.current) return next;
      const before = last.current; last.current = next; setRaw(next);
      const ready = next?.state === "ready";
      if (!ready) setVerified(false);
      if (before?.engine !== next?.engine) setFailure(null);
      // Ready at launch, or a switch to an engine that is already signed in, is trusted as it is (no call spent).
      // Becoming ready here (an install or a sign-in noticed) is tested once before anything relies on it.
      if (ready && (first.current || before?.engine !== next?.engine)) { setVerified(true); if (!first.current) window.setTimeout(flushResumes, 0); }
      else if (ready && before && before.state !== "ready") void verify();
      first.current = false;
      return next;
    } catch { return null; }
  }, [verify]);
  useEffect(() => {
    alive.current = true;
    void refresh(true);
    const onFocus = () => void refresh(true);
    const onChange = () => void refresh(true);
    window.addEventListener("focus", onFocus);
    window.addEventListener("precut:ai-changed", onChange);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { alive.current = false; window.removeEventListener("focus", onFocus); window.removeEventListener("precut:ai-changed", onChange); window.clearInterval(timer); };
  }, [refresh]);
  // Offline: try again by itself every 20 s.
  useEffect(() => {
    if (failure?.problem !== "offline") return;
    const timer = window.setInterval(() => void verify(), 20_000);
    return () => window.clearInterval(timer);
  }, [failure?.problem, verify]);
  const status = useMemo(() => raw && failure?.problem && failure.engine === raw.engine && raw.state !== "none" && raw.state !== "not-installed" && raw.state !== "signed-out"
    ? { ...raw, state: failure.problem, detail: failure.text } : raw, [raw, failure]);
  const ready = raw ? verified && !checking && (raw.state === "ready" || raw.state === "unknown") && !failure : fallbackReady;
  const failureText = failure?.problem ? null : failure?.text ?? null;
  return useMemo(() => ({ status, ready, checking, failure: failureText, refresh, verify }), [status, ready, checking, failureText, refresh, verify]);
}

type Phase = { kind: "idle" } | { kind: "waiting"; for: "install" | "signin" };
const ENGINES: Engine[] = ["claude", "codex", "muse"];

/** The card itself. Inline in a panel, or inside the sheet. */
export function NeedsAiCard({ feature = "generic", onReady, compact = false }: { feature?: AiFeature; onReady?: () => void; compact?: boolean }) {
  const ai = useContext(AiAccess);
  const status = ai.status;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copy, setCopy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState<Engine[]>(["claude", "codex"]);
  const resume = useRef<(() => void) | null>(null);
  useEffect(() => { void getApi().listEngines().then(list => setInstalled(ENGINES.filter(id => id !== "muse" || list.find(e => e.id === id)?.installed))).catch(() => {}); }, []);
  const refresh = ai.refresh;  // stable; the context object itself is new on every app render
  useEffect(() => { if (!status) void refresh(true); }, [status, refresh]);
  // Whatever the person asks for here carries on once the AI answers, even after this card has gone.
  const asked = () => {
    if (!onReady || resume.current) return;
    let done = false;
    resume.current = () => { if (!done) { done = true; onReady(); } };
    queueResume(resume.current);
  };
  // While waiting on the person (Terminal or an install), notice by ourselves: the app tests it once it is ready.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const timer = window.setInterval(() => void refresh(true), 3_000);
    return () => window.clearInterval(timer);
  }, [phase, refresh]);
  useEffect(() => { if (phase.kind === "waiting" && phase.for === "install" && status && status.state !== "not-installed") setPhase({ kind: "idle" }); }, [phase, status]);

  if (!status) return <div role="status" data-needs-ai="loading" className="rounded-2xl bg-surface p-4 text-small text-muted">Looking for your AI…</div>;
  const info = status.engine ? ENGINE_INFO[status.engine] : null;
  const what = AI_FEATURES[feature];
  const choose = async (engine: Engine) => {
    setError(""); asked();
    try { await getApi().setEngine(engine); window.dispatchEvent(new Event("precut:ai-changed")); await ai.refresh(true); }
    catch { setError("Couldn't save your choice. Try again."); }
  };
  const getIt = async () => {
    if (!status.engine) return;
    setError(""); asked(); setPhase({ kind: "waiting", for: "install" });
    try {
      if (status.engine === "claude") await getApi().setupPrecut();
      else await getApi().openEngineHelp(status.engine, "install");
    } catch (e) { setError(e instanceof Error && e.message.length < 160 ? e.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, "") : "That didn't work. Try again."); }
  };
  const signIn = async () => {
    if (!status.engine) return;
    setError(""); setCopy(null); asked(); setPhase({ kind: "waiting", for: "signin" });
    try { await getApi().openEngineHelp(status.engine, "signin"); }
    catch { setCopy(status.signInCommand ?? ENGINE_INFO[status.engine].signIn); }
  };
  const check = () => { asked(); void ai.verify(); };
  const copyCommand = async (command: string) => {
    try { await navigator.clipboard.writeText(command); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); }
  };

  let state: string = status.state;
  if (ai.checking) state = "checking";
  else if (phase.kind === "waiting" && (status.state === "not-installed" || status.state === "signed-out")) state = "waiting";
  else if (status.state === "ready" && !ai.ready) state = ai.failure ? "failed" : "checking";
  const heading = `${what.name} ${feature === "generic" ? "uses" : what.name.endsWith("s") && !what.name.endsWith("ss") ? "use" : "uses"} your AI`;
  const line = feature === "generic" ? null : `It ${what.line}.`;
  let body: ReactNode = null, action: ReactNode = null;
  if (state === "none") {
    body = <>You started without AI. Pick the one you already pay for; it signs in with your plan, no API key.</>;
    action = <div className="flex flex-wrap gap-2">{installed.map(id => <Button key={id} variant="secondary" data-engine={id} onClick={() => void choose(id)} className="!gap-2 !py-1.5 !pl-1.5 !pr-3.5"><EngineMark engine={id} size={24} />{ENGINE_INFO[id].label}</Button>)}</div>;
  } else if (state === "not-installed" && info) {
    body = <>{info.label} isn't on this Mac yet. {info.plan}.</>;
    action = <Button variant="primary" data-needs-ai-action="get" onClick={() => void getIt()}>{info.get}</Button>;
  } else if (state === "signed-out" && info) {
    body = status.apiKey && status.engine === "claude" ? <>{info.label} is signed in with an API key. precut uses your Claude subscription, not an API key, so sign in with your Claude account.</>
      : status.apiKey ? <>{info.label} is signed in with an API key. precut uses your ChatGPT plan, so sign in with ChatGPT.</>
      : <>Sign in to {info.label} to use this. {info.plan}.</>;
    action = <Button variant="primary" data-needs-ai-action="signin" onClick={() => void signIn()}>Sign in</Button>;
  } else if (state === "waiting" && info) {
    body = phase.kind === "waiting" && phase.for === "install" ? <>Installing {info.label}. precut notices when it's there.</> : <>Sign in to {info.label} in Terminal, then come back. precut notices by itself.</>;
    action = <span role="status" className="flex items-center gap-2 text-small text-muted"><ProgressRing pct={null} label="Waiting" className="text-accent" />{phase.kind === "waiting" && phase.for === "install" ? "Waiting for the install" : "Waiting for you in Terminal"}</span>;
  } else if (state === "checking" && info) {
    body = <>Signed in. Checking {info.label} answers with one tiny request.</>;
    action = <span role="status" className="flex items-center gap-2 text-small text-muted"><ProgressRing pct={null} label="Checking" className="text-accent" />Checking it answers</span>;
  } else if (state === "failed" && info) {
    body = <>{info.label} is signed in but didn't answer: {ai.failure}</>;
    action = <Button variant="secondary" onClick={check}>Try again</Button>;
  } else if (state === "allowance" && info) {
    body = <>Your {info.label} allowance is used up for now. It comes back when your plan resets.</>;
    action = <Button variant="secondary" onClick={check}>Check again</Button>;
  } else if (state === "offline" && info) {
    body = <>You're offline, so {info.label} can't answer. precut tries again by itself when you're back.</>;
    action = <Button variant="secondary" onClick={check}>Try now</Button>;
  } else if (state === "unknown" && info) {
    body = <>precut couldn't tell if {info.label} is signed in.</>;
    action = <div className="flex flex-wrap gap-2"><Button variant="primary" onClick={check}>Check it works</Button><Button variant="ghost" onClick={() => void signIn()}>Sign in</Button></div>;
  } else if (state === "ready" && info) {
    body = <>{info.label} is ready.</>;
    action = onReady ? <Button variant="primary" onClick={() => { asked(); resume.current?.(); pendingResumes.delete(resume.current!); }}>Carry on</Button> : null;
  }
  return <div role="status" data-model-sign-in data-needs-ai={state} data-engine={status.engine ?? "none"} className={`flex min-w-0 flex-col gap-3 rounded-2xl bg-surface text-small ${compact ? "p-3" : "p-4"}`}>
    <div className="flex items-center gap-3">
      {status.engine ? <EngineMark engine={status.engine} size={compact ? 28 : 36} /> : null}
      <div className="min-w-0"><p className="m-0 font-semibold text-ink">{heading}</p>{line && <p className="m-0 text-micro text-muted">{line}</p>}</div>
    </div>
    <p className="m-0 text-muted">{body}</p>
    {action}
    {copy && <div data-copy-command className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-ink/[0.06] px-3 py-2 font-mono text-micro text-ink">
      <span className="min-w-0 truncate">{copy}</span><Button variant="ghost" onClick={() => void copyCommand(copy)} className="!py-1">{copied ? "Copied" : "Copy"}</Button>
    </div>}
    {copy && <p className="m-0 text-micro text-muted">Terminal couldn't open. Paste this into Terminal to sign in; precut notices when you're done.</p>}
    {error && <InlineError className="m-0 text-small text-danger">{error}</InlineError>}
  </div>;
}

/** Kept name: the inline card for a gated panel. */
export function ModelSignIn({ feature, onReady }: { feature?: AiFeature; onReady?: () => void }) {
  return <NeedsAiCard feature={feature} onReady={onReady} compact />;
}

/** One sheet for buttons that need the AI: it opens on openModelSignIn and returns to what was asked. */
export function NeedsAiSheet() {
  const [request, setRequest] = useState<SignInRequest | null>(null);
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<SignInRequest>).detail ?? {});
    window.addEventListener("precut:sign-in", open);
    return () => window.removeEventListener("precut:sign-in", open);
  }, []);
  const feature = request?.feature ?? "generic";
  return <Modal open={!!request} onClose={() => setRequest(null)} title="Needs your AI" className="max-w-md">
    {request && <NeedsAiCard feature={feature} onReady={() => { const resume = request.resume; setRequest(null); resume?.(); }} />}
  </Modal>;
}
