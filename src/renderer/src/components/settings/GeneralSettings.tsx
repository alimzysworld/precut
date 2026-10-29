import { useState } from "react";
import { type ThemeChoice } from "../../theme";
import { registeredShortcuts } from "../../hooks/useShortcuts";
import { ShortcutList } from "../ShortcutSheet";
import { Row, SectionHeader, SegmentedControl } from "../ui";
import { StorageSettings } from "./StorageSettings";
import { UpdateSettingsRow } from "../UpdateLine";
import { SettingsSection, SettingToggle, usePreferences } from "./shared";

export function GeneralSettings({ theme, onThemeChange }: { theme: ThemeChoice; onThemeChange: (value: ThemeChoice) => void }) {
  const state = usePreferences(), [saved, setSaved] = useState(false);
  // Same live registry and list as the ? sheet, across the available workspaces.
  const shortcuts = [...new Map(["global", "clips", "ideas", "precuts", "shoots"].flatMap(registeredShortcuts).map(s => [s.id, s])).values()];
  return <SettingsSection title="General" state={state}>
    <Row className="settings-row"><span className="text-small">Colour mode</span><SegmentedControl variant="compact" label="Colour mode" value={theme} choices={["system", "light", "dark"]} onChange={value => { onThemeChange(value); setSaved(true); }} /></Row>
    {saved && <p role="status" className="text-micro text-muted">Saved on this Mac.</p>}
    <SettingToggle label="Mac notifications" checked={state.value?.notifications !== false} onChange={notifications => void state.change({ notifications })} />
    <SettingToggle label="Improve first cuts automatically" checked={state.value?.improveFirstCuts !== false} onChange={improveFirstCuts => void state.change({ improveFirstCuts })} />
    <UpdateSettingsRow />
    <StorageSettings />
    <div><SectionHeader as="h3" className="mb-3 text-small font-medium">Keyboard shortcuts</SectionHeader><ShortcutList shortcuts={shortcuts} /></div>
  </SettingsSection>;
}
