import { useState } from "react";
import { getApi } from "../../data";
import { EditorChoices, PostPlaces, inferredPostPlaces, postPreferences } from "../Setup";
import { Button, InlineError, Row, SectionHeader } from "../ui";
import { SettingsSection, settingInput, usePreferences } from "./shared";

export function ExportSettings() {
  const state = usePreferences(true), value = state.value, [choosing, setChoosing] = useState(false);
  const [folderError, setFolderError] = useState("");
  async function chooseFolder() {
    setChoosing(true); setFolderError("");
    try { const folder = await getApi().pickFolder(); if (folder) await state.change(p => ({ output: { ...p.output, exportFolder: folder } })); }
    catch { setFolderError("Could not choose a folder. Try again."); }
    finally { setChoosing(false); }
  }
  return <SettingsSection title="Export" state={state}>{value && <>
    <div><SectionHeader as="h3" className="mb-3 text-small font-medium">Your editors</SectionHeader><EditorChoices value={value.output.targets ?? ["resolve"]} onChange={targets => { if (targets.length) void state.change(p => ({ output: { ...p.output, targets } })); }} /></div>
    <div><SectionHeader as="h3" className="mb-3 text-small font-medium">Where you post</SectionHeader><PostPlaces value={inferredPostPlaces(value)} onChange={places => { if (places.length) void state.change(p => postPreferences(p, places)); }} /></div>
    <Row as="label" className="settings-row"><span className="text-small">Finished size</span><select aria-label="Finished size" className={settingInput} value={value.output.height} onChange={event => { const height = Number(event.target.value) as 1080 | 1440 | 2160; void state.change(p => ({ output: { ...p.output, height } })); }}>{[1080,1440,2160].map(n => <option key={n} value={n}>{n}p</option>)}</select></Row>
    <Row as="label" className="settings-row"><span className="text-small">Frame rate</span><select aria-label="Frame rate" className={settingInput} value={value.output.fps ?? "match"} onChange={event => { const fps = event.target.value === "match" ? null : Number(event.target.value); void state.change(p => ({ output: { ...p.output, fps } })); }}><option value="match">Match footage</option>{[24,25,30,50,60].map(n => <option key={n} value={n}>{n} fps</option>)}</select></Row>
    <p className="text-micro text-muted">An explicit frame rate in a skill takes priority.</p>
    <div><SectionHeader as="h3" className="mb-2 text-small font-medium">Export folder</SectionHeader><p role="status" className="mb-3 break-all text-small text-muted">{value.output.exportFolder ?? "sidething precuts, next to the footage"}</p><div className="flex flex-wrap gap-2"><Button disabled={choosing} onClick={() => void chooseFolder()}>Choose folder</Button>{value.output.exportFolder && <Button onClick={() => void state.change(p => ({ output: { ...p.output, exportFolder: null } }))}>Use default folder</Button>}</div>{folderError && <InlineError>{folderError}</InlineError>}</div>
  </>}</SettingsSection>;
}
