import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Preferences } from "../../../../shared/schema";
import { getApi } from "../../data";
import { defaultExportTargets } from "../ExportModal";
import { Button, FOCUS, InlineError, Row, SectionHeader, Switch } from "../ui";

// The shared contract has no detail-default field yet. Keep the additive wire
// extension local, as with the extended LookPreference in main/settings.ts.
export type SettingsPreferences = Omit<Preferences, "look"> & { look: Preferences["look"] & { detail?: boolean } };
export const settingInput = `min-w-0 max-w-full rounded-lg bg-ink/[0.06] px-3 py-2 text-small text-ink ${FOCUS}`;
type Patch = Partial<SettingsPreferences>;
export function usePreferences(migrateTargets = false) {
  const [value, setValue] = useState<SettingsPreferences | null>(null);
  const current = useRef<SettingsPreferences | null>(null);
  const alive = useRef(true), revision = useRef(0), queue = useRef(Promise.resolve());
  const [status, setStatus] = useState(""), [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    alive.current = true;
    void (async () => { if (migrateTargets) await defaultExportTargets(); return getApi().getPreferences(); })().then(next => { if (alive.current) { current.current = next; setValue(next); setError(null); } })
      .catch(() => { if (alive.current) setError("Could not read defaults. Try again."); });
    return () => { alive.current = false; };
  }, [attempt, migrateTargets]);
  function change(update: Patch | ((previous: SettingsPreferences) => Patch)): Promise<boolean> {
    if (!current.current) return Promise.resolve(false);
    const patch = typeof update === "function" ? update(current.current) : update;
    if (Object.entries(patch).every(([key, next]) => JSON.stringify(current.current![key as keyof SettingsPreferences]) === JSON.stringify(next))) return Promise.resolve(true);
    current.current = { ...current.current, ...patch };
    setValue(current.current); setStatus("Saving…"); setError(null);
    const id = ++revision.current;
    let saved = false;
    queue.current = queue.current.then(async () => {
      try {
        const next = await getApi().setPreferences(patch);
        saved = true;
        if (alive.current && id === revision.current) { current.current = next; setValue(next); setStatus("Saved"); }
      } catch {
        if (alive.current) { setStatus(""); setError("Could not save defaults. Try again."); }
        if (id === revision.current) {
          // Reload the saved value so retrying the same choice is a real write.
          try { const next = await getApi().getPreferences(); if (alive.current && id === revision.current) { current.current = next; setValue(next); } } catch { /* Keep the failure visible. */ }
        }
      }
    });
    return queue.current.then(() => saved);
  }
  return { value, change, status, error, retry: () => setAttempt(n => n + 1) };
}
export function SettingsSection({ title, children, state }: { title: string; children?: ReactNode; state: ReturnType<typeof usePreferences> }) {
  return <><SectionHeader as="h2" heading={title}>Defaults for new edits.</SectionHeader>
    <p role="status" aria-live="polite" className="mb-3 min-h-4 text-micro text-muted">{state.status}</p>
    <InlineError error={state.error} />
    {!state.value ? state.error ? <Button onClick={state.retry}>Try again</Button> : <p role="status" className="text-small text-muted">Reading defaults…</p> : <div className="space-y-5">{children}</div>}
  </>;
}
export function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <Row className="settings-row"><span className="text-small">{label}</span><Switch label={label} checked={checked} onChange={event => onChange(event.target.checked)} /></Row>;
}
