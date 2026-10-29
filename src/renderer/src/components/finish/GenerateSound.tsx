import { useEffect, useRef, useState } from "react";
import type { CutEdit, ExtensionInfo } from "../../../../shared/schema";
import { getApi } from "../../data";
import { AddOnPrompt } from "../AddOnPrompt";
import { Button, FOCUS, InlineError, Row, NumberField } from "../ui";

export function GenerateSound({ root, time = 0, durationS, busy = false, onEdit }: {
  root: string; time?: number; durationS?: number; busy?: boolean;
  onEdit?: (edit: CutEdit) => void | Promise<unknown>;
}) {
  const [connection, setConnection] = useState<ExtensionInfo | null>(null);
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(2);
  const [result, setResult] = useState<{ file: string; name: string; seconds: number } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const locked = useRef(false), alive = useRef(true);
  const scope = useRef(0);
  useEffect(() => {
    const current = ++scope.current;
    alive.current = true; locked.current = false; setWorking(false); setConnection(null); setResult(null); setError(null);
    void getApi().extensions().then(items => {
      const next = items.find(item => item.id === "elevenlabs");
      if (alive.current && current === scope.current) { if (next) setConnection(next); else setError("ElevenLabs is not available in this version."); }
    }).catch(() => { if (alive.current && current === scope.current) setError("Could not read your ElevenLabs connection. Try again."); });
    return () => { alive.current = false; };
  }, [root, retry]);
  async function generate() {
    if (locked.current || busy) return;
    locked.current = true; setWorking(true); setError(null);
    const current = scope.current;
    try {
      const sound = await getApi().generateSound(root, prompt.trim(), seconds);
      if (alive.current && current === scope.current) setResult({ ...sound, seconds });
    } catch (failure) { if (alive.current && current === scope.current) setError(failure instanceof Error ? failure.message : "Could not make this sound. Try again."); }
    finally { if (current === scope.current) { locked.current = false; if (alive.current) setWorking(false); } }
  }
  async function place() {
    if (!result || !onEdit || locked.current || busy) return;
    locked.current = true; setWorking(true); setError(null);
    try {
      await onEdit({ kind: "sfx", op: "add", item: { file: result.file, name: result.name, kind: "other", atS: time,
        gainDb: -12, lengthS: Math.min(result.seconds, durationS === undefined ? result.seconds : durationS - time) } });
    } catch { if (alive.current) setError("Could not place this sound. Try again."); }
    finally { locked.current = false; if (alive.current) setWorking(false); }
  }
  return <div className="space-y-3" aria-label="Generate a sound">
    {connection && connection.state !== "installed" ? <AddOnPrompt extension={connection} onChange={setConnection} /> : null}
    {connection?.state === "installed" ? <form className="space-y-2" onSubmit={event => { event.preventDefault(); void generate(); }}>
      <label className="block text-small">Describe a sound
        <input aria-label="Describe a sound" value={prompt} maxLength={2000} disabled={busy || working} onChange={event => setPrompt(event.target.value)} className={`mt-1 w-full rounded-xl bg-ink/[0.06] px-3 py-2 ${FOCUS}`} />
      </label>
      <Row as="label" className="gap-3 text-small">Length in seconds
        <NumberField aria-label="Sound length in seconds" min={.5} max={30} step={.5} value={seconds} disabled={busy || working} onChange={event => setSeconds(Number(event.target.value))} className={`w-20 rounded-lg bg-ink/[0.06] p-2 ${FOCUS}`} />
      </Row>
      <Button type="submit" variant="primary" disabled={busy || working || !prompt.trim() || !Number.isFinite(seconds) || seconds < .5 || seconds > 30}>{working ? "Making sound" : "Generate sound"}</Button>
      <p className="text-micro text-muted">Sounds are made on your ElevenLabs account.</p>
    </form> : !connection && !error ? <p role="status" className="text-micro text-muted">Reading connection</p> : null}
    {result ? <div className="space-y-2">
      <p className="text-small">{result.name}</p>
      <audio controls preload="none" aria-label={`Preview ${result.name}`} src={`st-media://local/sounds/${encodeURIComponent(result.file)}`} className="w-full" />
      <Button disabled={busy || working || !onEdit || time < 0 || durationS !== undefined && time >= durationS} onClick={() => void place()}>Place at playhead</Button>
    </div> : null}
    <InlineError className="text-small text-danger" error={error} />
    {!connection && error ? <Button onClick={() => setRetry(value => value + 1)}>Try again</Button> : null}
  </div>;
}
