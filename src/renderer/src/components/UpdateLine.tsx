// SIGN2: the update, in plain words. The top bar shows one quiet line when a signed update is ready (or when one
// didn't download or verify); Settings has "Check for updates". Never a modal, never an outline or ring.
import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../shared/update-status";
import { getApi } from "../data";
import { Button, Row } from "./ui";
import { formatPercent } from "./processingFormat";
import { SettingToggle, usePreferences } from "./settings/shared";

type UpdaterApi = {
  updateStatus?: () => Promise<UpdateStatus>;
  checkForUpdates?: () => Promise<UpdateStatus>;
  onUpdateStatus?: (cb: (status: UpdateStatus) => void) => () => void;
};
const updaterApi = () => getApi() as ReturnType<typeof getApi> & UpdaterApi;

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const api = updaterApi();
    if (typeof api.updateStatus !== "function") return;
    let alive = true;
    void api.updateStatus().then(next => { if (alive) setStatus(next); }).catch(() => {});
    const off = api.onUpdateStatus?.(next => { if (alive) setStatus(next); });
    return () => { alive = false; off?.(); };
  }, []);
  return status;
}

/** The top bar line. Ready, or a download or verify that failed; a check that couldn't reach GitHub stays quiet. */
export function UpdateLine() {
  const status = useUpdateStatus();
  const text = status?.state === "ready" ? "Update ready: restarts when you quit"
    : status?.state === "failed" && status.failedAt !== "check" ? status.message : null;
  if (!text) return null;
  return <p role="status" data-update-line={status!.state} title={status!.state === "ready" ? `precut ${status!.next} installs when you quit precut.` : undefined}
    className="min-w-0 shrink truncate text-micro text-muted">{text}</p>;
}

const settingsLine = (s: UpdateStatus | null): string => {
  if (!s || s.state === "off") return "Updates come with the installed app.";
  if (s.state === "checking") return "Checking…";
  if (s.state === "downloading") return `Downloading ${s.next}${s.pct ? ` · ${formatPercent(s.pct)}` : ""}`;
  if (s.state === "ready") return `precut ${s.next} is ready. It installs when you quit.`;
  if (s.state === "failed") return s.message ?? "Couldn't check for updates. Try again.";
  if (s.state === "current") return `precut ${s.version} is the latest.`;
  return `precut ${s.version}`;
};

/** Settings > General: the installed version, a "Check for updates" button and (REL2) whether precut checks by itself. */
export function UpdateSettingsRow() {
  const live = useUpdateStatus();
  const [asked, setAsked] = useState<UpdateStatus | null>(null);
  const prefs = usePreferences();
  const status = live ?? asked;
  const api = updaterApi();
  const busy = status?.state === "checking" || status?.state === "downloading";
  const check = () => void api.checkForUpdates?.().then(setAsked).catch(() => {});
  return <div className="space-y-2" data-update-settings>
    <Row className="settings-row" data-update-row>
      <span className="text-small">Updates<span role="status" aria-live="polite" className="block text-micro text-muted">{settingsLine(status)}</span></span>
      <Button disabled={busy || status?.state === "off" || status?.state === "ready" || typeof api.checkForUpdates !== "function"}
        onClick={check}>{status?.state === "checking" ? "Checking…" : "Check for updates"}</Button>
    </Row>
    {prefs.value && <SettingToggle label="Check for updates automatically" checked={prefs.value.autoUpdates !== false}
      onChange={autoUpdates => void prefs.change({ autoUpdates }).then(saved => { if (saved && autoUpdates && status?.state !== "off") check(); })} />}
    {prefs.value?.autoUpdates === false && <p className="text-micro text-muted">precut asks GitHub for a new version only when you press Check for updates.</p>}
  </div>;
}
