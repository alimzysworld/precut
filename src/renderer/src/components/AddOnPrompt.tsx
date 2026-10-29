import { formatPercent } from "./processingFormat";
import { useEffect, useRef, useState } from "react";
import type { Activity, ExtensionInfo } from "../../../shared/schema";
import { getApi } from "../data";
import { Button, FOCUS, InlineError, SectionHeader } from "./ui";

export function addOnSize(bytes?: number): string | null {
  if (!bytes) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${bytes} bytes`;
}

// The same in-place row serves a feature's first use and Settings, Extensions.
// The feature owns its switch; onReady enables it only once installation succeeds.
export function AddOnPrompt({ extension, onReady, onNotNow, onChange, manage = false, keySettings = false, compact = false }: {
  extension: ExtensionInfo; onReady?: () => void; onNotNow?: () => void;
  onChange?: (extension: ExtensionInfo) => void; manage?: boolean; keySettings?: boolean; compact?: boolean;
}) {
  const [value, setValue] = useState(extension);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(keySettings);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => { setValue(extension); }, [extension]);
  useEffect(() => {
    alive.current = true;
    const api = getApi();
    const matches = (a: Activity) => a.root === null && a.kind === "setup" && a.label === `Installing ${extension.name.toLowerCase()} add-on`;
    const update = (a: Activity) => {
      if (!alive.current || !matches(a)) return;
      setActivity(a.state === "running" ? a : null);
      if (a.state !== "running") void api.extensions().then(items => {
        const next = items.find(item => item.id === extension.id);
        if (alive.current && next) setValue(next);
      }).catch(() => {});
    };
    void api.listActivity().then(items => items.forEach(update)).catch(() => {});
    const unsubscribe = api.onActivity(update);
    return () => { alive.current = false; unsubscribe(); };
  }, [extension.id, extension.name]);
  useEffect(() => {
    if (!busy && value.state !== "installing" && !activity) return;
    let active = true;
    const timer = window.setInterval(() => {
      void getApi().extensions().then(items => {
        const next = items.find(item => item.id === extension.id);
        if (active && next) setValue(next);
      }).catch(() => {});
    }, 750);
    return () => { active = false; window.clearInterval(timer); };
  }, [busy, value.state, extension.id, activity?.id]);
  async function change(remove = false) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      const api = getApi();
      if (!remove && value.kind === "connect" && (value.state !== "installed" || keySettings)) {
        if (!connecting) { setConnecting(true); return; }
        const secret = key.trim();
        // Clear the input before handing it to J3; never include it in errors.
        setKey("");
        if (!secret) throw new Error("Enter your ElevenLabs key.");
        const status = await api.soundKey({ set: secret });
        if (!status.elevenlabs) throw new Error("ElevenLabs key storage is not ready yet. Try again after updating precut.");
      }
      const next = await (remove ? api.removeExtension(value.id) : api.installExtension(value.id));
      if (alive.current) { setValue(next); setConnecting(keySettings); onChange?.(next); if (!remove && next.state === "installed") onReady?.(); }
    } catch (failure) {
      if (alive.current) setError(value.kind === "connect" ? remove ? "Could not disconnect ElevenLabs. Try again." : "Could not connect ElevenLabs. Check your key and try again." : failure && typeof failure === "object" && "message" in failure && typeof failure.message === "string" ? failure.message : "Could not change this add-on. Try again.");
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const installing = busy && value.kind === "install" || value.state === "installing" || !!activity;
  const ready = value.state === "installed";
  const size = addOnSize(value.sizeBytes);
  return <div className="rounded-2xl bg-ink/[0.035] px-5 py-4" data-addon={value.id}>
    <div className={compact ? "flex flex-col gap-3" : "flex flex-wrap items-start justify-between gap-3"}>
      <div className="min-w-0 flex-1">
        <SectionHeader as="h3" className="text-body font-medium">{value.name}</SectionHeader>
        <p className="mt-1 text-small text-muted">{value.what}</p>
        <p className="mt-2 text-micro text-muted" role="status">{size && <span>{size} · </span>}
          {installing ? "Installing" : ready ? value.kind === "connect" ? "Connected" : "Installed" : value.state === "failed" ? "Could not install" : "Available"}
          {value.version && <span> · {value.version}</span>}
        </p>
      </div>
      {!installing && <div className="flex flex-wrap gap-2">
        {!ready && !connecting && <Button variant="primary" disabled={busy} onClick={() => void change()}>{value.kind === "connect" ? "Connect" : "Install"}</Button>}
        {ready && manage && <Button disabled={busy} onClick={() => void change(true)}>{value.kind === "connect" && !keySettings ? "Disconnect" : "Remove"}</Button>}
        {!manage && onNotNow && !ready && <Button variant="ghost" disabled={busy} onClick={onNotNow}>Not now</Button>}
      </div>}
    </div>
    {installing && <div className="mt-3 flex items-center gap-3">
      <progress className="min-w-0 flex-1 accent-accent" max={100} value={activity?.pct ?? undefined} aria-label={`Installing ${value.name}`} />
      <span className="text-micro text-muted">{activity?.pct != null ? formatPercent(activity.pct) : activity?.note || "Waiting"}</span>
      {activity?.cancelable && <Button variant="ghost" onClick={() => { void getApi().cancelActivity(activity.id).catch(() => setError("Could not cancel. Try again.")); }}>Cancel</Button>}
    </div>}
    {connecting && <>
      <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer" className={`mt-3 inline-block text-small text-accent underline ${FOCUS}`}>Get your key</a>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void change(); }}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-small">ElevenLabs key
        <input type="password" autoComplete="off" value={key} disabled={busy} onChange={event => setKey(event.target.value)}
          className={`min-w-0 rounded-lg bg-ink/[0.06] px-3 py-2 text-ink ${FOCUS}`} />
      </label>
      <Button variant="primary" type="submit" className="self-end !rounded-xl px-4" disabled={busy || !key.trim()}>{keySettings ? "Save" : "Continue"}</Button>
      {!keySettings && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setConnecting(false); setKey(""); }}>Not now</Button>}
    </form></>}
    <InlineError className="mt-2 text-small text-danger" error={error ?? value.error} />
  </div>;
}
