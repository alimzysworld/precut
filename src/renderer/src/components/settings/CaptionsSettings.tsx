import { CaptionSettings } from "../finish/CaptionsPanel";
import { DEFAULT_CAPTION_STYLE } from "../../../../main/titles/captions";
import { SettingsSection, SettingToggle, usePreferences } from "./shared";

export function CaptionsSettings() {
  const state = usePreferences(), value = state.value;
  return <SettingsSection title="Captions" state={state}>{value && <>
    <SettingToggle label="Captions on by default" checked={value.captions.onByDefault} onChange={onByDefault => void state.change(p => ({ captions: { ...p.captions, onByDefault } }))} />
    <div className="settings-compact-panel"><CaptionSettings value={value.captions.style ?? DEFAULT_CAPTION_STYLE} onChange={style => void state.change(p => ({ captions: { ...p.captions, style } }))} /></div>
  </>}</SettingsSection>;
}
