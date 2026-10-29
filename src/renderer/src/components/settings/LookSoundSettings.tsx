import { useEffect, useId, useState } from "react";
import { getApi } from "../../data";
import { LookGallery, DetailDefault, EDIT_LOOKS, type LookImage } from "../finish/LookPanel";
import { SoundCards, renderSoundControl } from "../finish/SoundPanel";
import { Button, InlineError, SectionHeader, Row, Switch } from "../ui";
import { SettingsSection, usePreferences } from "./shared";
import { ClipSoundDefault } from "./ClipSoundDefault";
import { MusicFolderChoice } from "../finish/MusicFolder";

// ONB1b: the same music folder choice as first run and the Sound panel.
function MusicFolderSetting() {
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => { let alive = true; void getApi().getMusicFolder().then(value => { if (alive) setFolder(value); }).catch(() => {}); return () => { alive = false; }; }, []);
  return <MusicFolderChoice folder={folder} onChosen={setFolder} />;
}

export function LookSoundSettings() {
  const controlId = useId();
  const state = usePreferences(), value = state.value;
  const [intensity, setIntensity] = useState(.7);
  useEffect(() => { if (value) setIntensity(value.look.intensity ?? .7); }, [value?.look.intensity]);
  const [images, setImages] = useState<LookImage[]>([]), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void getApi().renderSampleLooks("skyline").then(items => { if (active) { setImages(items.map(item => ({ ...item, family: EDIT_LOOKS.find(look => look.id === item.id)?.family }))); setError(""); } })
      .catch(() => { if (active) setError("Could not load look previews."); });
    return () => { active = false; };
  }, [attempt]);
  return <SettingsSection title="Look and sound" state={state}>{value && <div className="settings-compact-panel">
    <SectionHeader as="h3" className="text-small font-medium">Default look</SectionHeader>
    <div className="look-panel"><LookGallery images={images} value={{ ...value.look, intensity }} error={error}
      onChoose={preset => void state.change(p => ({ look: { ...p.look, preset, words: null, intensity } }))}
      onIntensity={(amount, release) => { setIntensity(amount); if (release) void state.change(p => ({ look: { ...p.look, intensity: amount } })); }} />
      {error && <InlineError>{error} <Button onClick={() => setAttempt(n => n + 1)}>Try again</Button></InlineError>}
      <Row as="label"><span className="text-small">Auto correct new edits</span><Switch aria-label="Auto correct new edits" checked={value.autoCorrectNewEdits !== false} onChange={event => void state.change(() => ({ autoCorrectNewEdits: event.target.checked }))} /></Row>
      <DetailDefault checked={value.look.detail !== false} onChange={detail => void state.change(p => ({ look: { ...p.look, detail } }))} />
    </div>
    <SectionHeader as="h3" className="mt-6 mb-3 text-small font-medium">Sound</SectionHeader>
    <ClipSoundDefault value={value.clipSoundNewEdits} onChange={clipSoundNewEdits=>void state.change(()=>({clipSoundNewEdits}))} />
    <SoundCards controls={["auto-mix", "audio", "breaths"]} renderControl={id => renderSoundControl({ id, controlId,
      auto: value.voice.auto !== false, clean: value.voice.clean, strength: value.voice.denoise, eq: value.voice.eq ?? { low: 0, mid: 0, high: 0 },
      target: value.voice.loudnessLUFS, breaths: value.voice.breaths, loudnessRange: [-16, -14], music: null, cutToBeat: false,
      onChange: patch => void state.change(p => ({ voice: { ...p.voice,
        ...(patch.auto !== undefined ? { auto: patch.auto } : {}), ...(patch.clean !== undefined ? { clean: patch.clean } : {}),
        ...(patch.strength !== undefined ? { denoise: patch.strength } : {}), ...(patch.eq !== undefined ? { eq: patch.eq } : {}),
        ...(patch.target !== undefined ? { loudnessLUFS: patch.target } : {}), ...(patch.breaths !== undefined ? { breaths: patch.breaths } : {}),
      } })), onNames: () => {}, onDefault: null, sounds: null,
    })} />
    <SectionHeader as="h3" className="mt-6 mb-3 text-small font-medium">Music for your edits</SectionHeader>
    <MusicFolderSetting />
  </div>}</SettingsSection>;
}
