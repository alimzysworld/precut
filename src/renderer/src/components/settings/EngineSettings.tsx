import { useEffect, useRef, useState } from "react";
import type { Api, Engine } from "../../../../shared/schema";
import { getApi } from "../../data";
import { Button, InlineError, Row, SectionHeader } from "../ui";
import { settingInput } from "./shared";
import { PRIVACY_COPY } from "../privacy";

type EngineStatus = Awaited<ReturnType<Api["listEngines"]>>;
const choices = [
  { id: "claude", label: "Claude Code", command: "claude", install: "https://code.claude.com/docs/en/setup" },
  { id: "codex", label: "Codex", command: "codex login", install: "https://developers.openai.com/codex/cli" },
  { id: "muse", label: "Muse", command: "muse login", install: "" },
] as const;

/** Optional CLI probes must not hold the saved engine and model hostage. */
export function engineDeadline<T>(request: Promise<T>, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(Error("Engine check took too long. Try again.")), ms);
    request.then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
  });
}
export function EngineSettings() {
  const [engine, setEngine] = useState<Engine | "none" | null>(null), [statuses, setStatuses] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<Partial<Record<Engine, string | null>>>({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(""), [probeError, setProbeError] = useState("");
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [saved, setSaved] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(), pendingModel = useRef<string | null | undefined>();
  const choosing = useRef(false);
  const [tests, setTests] = useState<Partial<Record<Engine, { busy: boolean; ok?: boolean; text?: string }>>>({});
  const queue = useRef(Promise.resolve()), savedModel = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    const api = getApi();
    setError(""); setProbeError("");
    void engineDeadline(api.getEngineChoice ? api.getEngineChoice() : api.getEngine()).then(value => { if (active) setEngine(value); }).catch(() => { if (active) setError("Could not read your engine. Try again."); });
    for (const id of ["claude", "codex"] as const) {
      void engineDeadline(api.getEngineModel(id)).then(value => { if (active) { setModels(previous => ({ ...previous, [id]: value })); if (id === "codex") { setDraft(value ?? ""); savedModel.current = value; } } })
        .catch(() => { if (active) setError("Could not read your model. Try again."); });
    }
    async function check() {
      try { const value = await engineDeadline(api.listEngines()); if (active) { setStatuses(value); setProbeError(""); } }
      catch { if (active) setProbeError("Could not check engine sign-in. Try again."); }
    }
    void check(); window.addEventListener("focus", check);
    return () => { active = false; window.removeEventListener("focus", check); };
  }, [attempt]);
  // Flushing on blur and unmount preserves the last typed model. Each value is
  // saved once even when blur follows the debounce or a dropdown choice.
  function flushModel() {
    window.clearTimeout(timer.current);
    if (pendingModel.current === undefined) return;
    const value = pendingModel.current; pendingModel.current = undefined;
    if (value === savedModel.current) return;
    savedModel.current = value;
    void saveModel("codex", value);
  }
  useEffect(() => () => flushModel(), []);
  async function saveModel(id: Engine, model: string | null) {
    setSaved("Saving…"); setError("");
    queue.current = queue.current.then(async () => {
      try { await getApi().setEngineModel(id, model); setModels(previous => ({ ...previous, [id]: model })); setSaved("Saved"); }
      catch { if (id === "codex") savedModel.current = models.codex ?? null; setSaved(""); setError("Could not save the model. Try again."); }
    });
    await queue.current;
  }
  async function runTest(id: Engine) {
    if (tests[id]?.busy) return;
    setTests(previous => ({ ...previous, [id]: { busy: true } }));
    try { const result = await getApi().testEngine(id); setTests(previous => ({ ...previous, [id]: { busy: false, ...result } })); }
    catch { setTests(previous => ({ ...previous, [id]: { busy: false, ok: false, text: "The test did not run. Try again." } })); }
  }
  async function choose(next: Engine | "none") {
    if (choosing.current || engine === next) return;
    choosing.current = true;
    flushModel(); setBusy(true); setSaved(""); setError("");
    try { await getApi().setEngine(next); setEngine(next); setSaved("Saved"); window.dispatchEvent(new Event("precut:ai-changed")); }
    catch { setError("Could not save the engine. Try again."); }
    finally { choosing.current = false; setBusy(false); }
  }
  return <><SectionHeader as="h2" heading="Engine and model">Use your own signed-in subscription.</SectionHeader>
    <p className="mb-3 text-micro text-muted">{PRIVACY_COPY}</p>
    <p role="status" aria-live="polite" className="mb-3 min-h-4 text-micro text-muted">{saved}</p>
    <InlineError error={error || probeError} />
    {(error || probeError) && <Button onClick={() => setAttempt(n => n + 1)}>Try again</Button>}
    <fieldset disabled={busy} className="space-y-3"><legend className="sr-only">Default engine</legend>
      {choices.map(choice => {
        const status = statuses?.find(item => item.id === choice.id);
        return <div key={choice.id} className="rounded-xl bg-ink/[0.035] p-3">
          <Row className="settings-row"><label className="flex min-w-0 items-center gap-2 text-small"><input type="radio" name="settings-engine" aria-label={choice.label} checked={engine === choice.id} onChange={() => void choose(choice.id)} />{choice.label}</label>
            <span role="status" className="text-micro text-muted">{!statuses ? probeError ? "Status unavailable" : "Checking sign-in…" : !status?.installed ? "Not installed" : status.signedIn === true ? "Signed in" : status.signedIn === false ? "Not signed in" : "Sign-in status unavailable"}</span></Row>
          {status?.installed && <div className="mt-2 flex items-center gap-3"><Button disabled={tests[choice.id]?.busy} onClick={() => void runTest(choice.id)}>{tests[choice.id]?.busy ? "Testing…" : "Test"}</Button>
            <span role="status" aria-live="polite" className={`text-micro ${tests[choice.id]?.ok === false ? "text-danger" : "text-muted"}`}>{tests[choice.id]?.text ?? ""}</span></div>}
          {status?.version && <p className="mt-2 break-words text-micro text-muted">{status.version}</p>}
          {status?.installed && status.signedIn !== true && (choice.id === "claude" ? <Button onClick={() => { void getApi().signInClaude().catch(() => setError("Could not open sign-in. Try again.")); }}>Sign in to Claude Code</Button> : <p className="mt-2 text-small text-muted">In Terminal, run <code>{choice.command}</code>, then return here.</p>)}
          {statuses && !status?.installed && choice.install && <a href={choice.install} target="_blank" rel="noreferrer" className="text-small text-accent underline">Install {choice.label}</a>}
        </div>;
      })}
      {/* ONB2: Start without AI, remembered. precut then makes no model calls at all. */}
      <div className="rounded-xl bg-ink/[0.035] p-3"><Row className="settings-row"><label className="flex min-w-0 items-center gap-2 text-small"><input type="radio" name="settings-engine" aria-label="Without Claude or Codex" checked={engine === "none"} onChange={() => void choose("none")} />Without Claude or Codex</label>
        <span className="text-micro text-muted">Edit by hand. Nothing goes to Claude or Codex.</span></Row></div>
    </fieldset>
    <div className="mt-5">
      {engine === "claude" && Object.hasOwn(models, "claude") && <Row as="label" className="settings-row"><span className="text-small">Claude model</span><select aria-label="Claude model" className={settingInput} value={models.claude ?? ""} onChange={event => void saveModel("claude", event.target.value || null)}><option value="">Your Claude Code default</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option></select></Row>}
      {engine === "codex" && Object.hasOwn(models, "codex") && <label className="block text-small">Codex model<input aria-label="Codex model" list="settings-codex-models" className={`${settingInput} mt-2 block w-full`} placeholder="Your Codex default" value={draft} onChange={event => { const value = event.target.value; setDraft(value); setSaved("Saving…"); pendingModel.current = value.trim() || null; window.clearTimeout(timer.current); timer.current = window.setTimeout(flushModel, 350); }} onBlur={flushModel} /><datalist id="settings-codex-models"><option value="">Your Codex default</option>{models.codex && <option value={models.codex} />}</datalist><span className="mt-2 block text-micro text-muted">Type a model name, or leave blank for your Codex default.</span></label>}
      {engine === "muse" && <p className="text-small text-muted">Uses your Muse default model.</p>}
    </div>
  </>;
}
