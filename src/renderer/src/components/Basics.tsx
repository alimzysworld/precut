import { SectionHeader, InlineError } from "./ui";
import { useEffect, useRef, useState } from "react";
import type { BasicAdjust } from "../../../shared/schema";
import { BASIC_BOUNDS, normalizeBasic } from "../../../main/basics";
import { getApi } from "../data";
import { Button, Slider } from "./ui";

const SLIDERS: { key: keyof BasicAdjust; label: string }[] = [
  { key: "exposure", label: "Exposure" }, { key: "contrast", label: "Contrast" },
  { key: "highlights", label: "Highlights" }, { key: "shadows", label: "Shadows" },
  { key: "whites", label: "Whites" }, { key: "blacks", label: "Blacks" },
  { key: "temperature", label: "Temperature" }, { key: "tint", label: "Tint" },
  { key: "vibrance", label: "Vibrance" }, { key: "saturation", label: "Saturation" },
];
/** All quick-button nudges live here, in the same units as the sliders. */
export const BASIC_NUDGES: { label: string; delta: Partial<BasicAdjust> }[] = [
  { label: "Warmer", delta: { temperature: 15 } }, { label: "Cooler", delta: { temperature: -15 } },
  { label: "Brighter", delta: { exposure: .25 } }, { label: "Darker", delta: { exposure: -.25 } },
  { label: "More punch", delta: { contrast: 15, vibrance: 10, blacks: -8 } },
  { label: "Softer", delta: { contrast: -15, highlights: -10, blacks: 8 } },
];
export function Basics({ root, cutId, version, value, disabled, onChange, onSave }: {
  root: string; cutId?: string; version: number; value?: BasicAdjust; disabled: boolean;
  onChange: (basic: BasicAdjust, immediate?: boolean, origin?: "auto") => void; onSave: () => Promise<boolean>;
}) {
  const basic = normalizeBasic(value);
  const [autoBusy, setAutoBusy] = useState(false), [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false), [error, setError] = useState<string | null>(null);
  const generation = useRef(0), saveGeneration = useRef(0);
  useEffect(() => () => { generation.current++; saveGeneration.current++; }, [root, cutId, version]);
  useEffect(() => { saveGeneration.current++; setSaved(false); setSaving(false); }, [JSON.stringify(basic)]);
  useEffect(() => { if (disabled) { generation.current++; setAutoBusy(false); } }, [disabled]);
  function change(next: BasicAdjust, immediate = false) {
    generation.current++; setAutoBusy(false); setSaved(false); setError(null);
    onChange(normalizeBasic(next), immediate);
  }
  async function auto() {
    if (!cutId || disabled) return;
    const request = ++generation.current; setAutoBusy(true); setError(null);
    try {
      const next = await getApi().autoBasic(root, cutId, version);
      if (request === generation.current) { setSaved(false); onChange(normalizeBasic(next), true, "auto"); }
    } catch { if (request === generation.current) setError("Couldn't measure this edit. Check that the footage is connected."); }
    finally { if (request === generation.current) setAutoBusy(false); }
  }
  async function save() {
    const request = ++saveGeneration.current; setSaving(true); setError(null);
    try { const ok = await onSave(); if (request === saveGeneration.current) { setSaved(ok); if (!ok) setError("Couldn't save the default. Try again."); } }
    catch { if (request === saveGeneration.current) setError("Couldn't save the default. Try again."); }
    finally { if (request === saveGeneration.current) setSaving(false); }
  }
  return <div role="group" aria-label="Basics" className="space-y-3 pt-2">
    <div><SectionHeader as="h4" className="font-medium">Basics</SectionHeader><p className="mt-1 text-micro text-muted">Applies to the whole edit. Double-click a slider to reset it.</p></div>
    <div className="flex flex-wrap gap-1.5">
      <Button type="button" disabled={disabled || autoBusy || !cutId} onClick={() => void auto()}>{autoBusy ? "Measuring…" : "Auto"}</Button>
      {BASIC_NUDGES.map(({ label, delta }) => <Button key={label} type="button" disabled={disabled} onClick={() => change(Object.fromEntries(Object.entries(basic).map(([key, v]) => [key, v + (delta[key as keyof BasicAdjust] ?? 0)])) as unknown as BasicAdjust, true)}>{label}</Button>)}
      <Button type="button" disabled={disabled} onClick={() => change(normalizeBasic(), true)}>Reset</Button>
    </div>
    {SLIDERS.map(({ key, label }) => <Slider key={key} label={label} min={BASIC_BOUNDS[key][0]} max={BASIC_BOUNDS[key][1]} step={key === "exposure" ? .05 : 1} unit={key === "exposure" ? " stops" : ""} value={basic[key]} disabled={disabled} defaultValue={0}
      onChange={amount => change({ ...basic, [key]: amount })} onRelease={amount => change({ ...basic, [key]: amount }, true)} />)}
    <Button type="button" disabled={disabled || saving} onClick={() => void save()}>{saving ? "Saving…" : "Use for new edits"}</Button>
    {saved ? <p role="status" className="text-micro text-muted">Look and basics saved for new edits.</p> : null}
    {error ? <InlineError className="text-micro text-danger">{error}</InlineError> : null}
  </div>;
}
