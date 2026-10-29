import { SettingsSection, SettingToggle, usePreferences } from "./shared";

export function PlaybackSettings() {
  const state = usePreferences();
  const value = state.value;
  return <SettingsSection title="Playback" state={state}>{value && <>
    <SettingToggle label="Apple player" checked={!!value.playback?.applePlayer}
      onChange={applePlayer => void state.change(p => ({ playback: { ...p.playback, applePlayer } }))
        // AV2: an open viewer takes the new choice at once (no reopen).
        .then(saved => { if (saved) window.dispatchEvent(new CustomEvent("sidething:apple-player", { detail: applePlayer })); })} />
    <p className="text-small text-muted">Plays edits with the Mac video engine, with the Look on. An edit with layouts, overlays or speed changes keeps the standard player for now, and the viewer says why.</p>
  </>}</SettingsSection>;
}
