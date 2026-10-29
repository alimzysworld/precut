import { InfoLabel } from "../ui/InfoTip";
import "./controls.css";
import { Tile } from "../ui";
import { useEffect, useId, useRef, useState } from "react";
import type { AudioFinish, Grade, MixerColour } from "../../../../shared/schema";
import { Button, FOCUS, InlineError, Segments, Row } from "../ui";

export { Segments } from "../ui";

export function parseSliderValue(text: string, unit = ""): number {
  const clean = text.trim().toLowerCase();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:%|x|db|lufs|s|stops|px|°)?$/.test(clean)) return NaN;
  const value = Number.parseFloat(clean);
  return unit === "x" && clean.endsWith("%") ? value / 100 : value;
}

/** One editable numeric slider for finishing and transport controls. */
export function Slider({ label, tip, mixed = false, value, min, max, step = 1, unit = "", defaultValue = min < 0 && max > 0 ? 0 : min,
  rangeMin = min, rangeMax = max, detent, disabled, onChange, onRelease, compact = false, className = "", ...props }: {
  label: string; tip?: string; mixed?: boolean; value: number; min: number; max: number; step?: number; unit?: string; defaultValue?: number;
  rangeMin?: number; rangeMax?: number; detent?: number; disabled?: boolean; compact?: boolean; className?: string;
  onChange: (value: number) => void; onRelease?: (value: number) => void; "aria-label"?: string; "aria-valuetext"?: string; "data-control"?: string;
}) {
  const id = useId(), [typing, setTyping] = useState(false), [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null), latest = useRef(value); latest.current = value;
  const pending = useRef(false), editing = useRef(false);
  const release = () => { if (pending.current) { pending.current = false; onRelease?.(latest.current); } };
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { if (typing) { field.current?.focus(); field.current?.select(); } }, [typing]);
  const format = (n: number) => `${Number(n.toFixed(Math.max(2, (String(step).split(".")[1] ?? "").length)))}${unit}`;
  const change = (n: number) => { latest.current = n; pending.current = true; onChange(n); };
  function applyText() {
    if (!editing.current) return;
    const n = parseSliderValue(text, unit);
    if (!Number.isFinite(n) || n < min || n > max) { setInvalid(true); return; }
    editing.current = false; setTyping(false); setInvalid(false); change(n); release();
  }
  function reset() { if (!disabled) { change(defaultValue); release(); } }
  const percent = (n: number) => Math.max(0, Math.min(100, (n - rangeMin) / (rangeMax - rangeMin) * 100));
  const centre = min < 0 && max > 0 ? percent(0) : 0, amount = percent(value);
  return <div data-slider onDoubleClick={event => { event?.stopPropagation(); reset(); }} className={`${compact ? "relative group min-w-0 flex-1" : "lightroom-slider"} ${className}`}>
    <Row className={`min-h-6 gap-2 text-micro text-muted ${compact ? "absolute -top-7 right-0 z-30 rounded bg-surface px-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100" : "lightroom-slider-values"}`}>
      {tip ? <InfoLabel label={label} htmlFor={id}>{tip}</InfoLabel> : <label htmlFor={id} onDoubleClick={event => { event?.stopPropagation(); reset(); }} className="cursor-ew-resize">{label}</label>}
      {typing ? <input ref={field} aria-label={`${label} value`} aria-invalid={invalid || undefined} title={`From ${min}${unit} to ${max}${unit}`} value={text} disabled={disabled}
        onChange={event => { setText(event.target.value); setInvalid(false); }} onBlur={applyText} onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); applyText(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editing.current = false; setTyping(false); setInvalid(false); }
        }} className={`w-20 rounded bg-ink/[0.06] px-1 text-right tabular-nums text-ink ${FOCUS}`} /> :
        <button type="button" aria-label={`Edit ${label.toLowerCase()} value`} disabled={disabled} onClick={() => { editing.current = true; setText(format(value)); setTyping(true); }} className={`rounded px-1 tabular-nums hover:bg-ink/[0.06] ${FOCUS}`}>{mixed ? "Mixed" : format(value)}</button>}
    </Row>
    <input {...props} id={id} aria-label={props["aria-label"] ?? label} aria-valuetext={props["aria-valuetext"] ?? (mixed ? "Mixed" : format(value))} type="range" min={rangeMin} max={rangeMax} step={step}
      list={detent === undefined ? undefined : `${id}-detent`} value={Math.max(rangeMin, Math.min(rangeMax, value))} disabled={disabled} title={format(value)}
      onChange={event => { let n = Number(event.target.value); if (detent !== undefined && Math.abs(n - detent) < step * 1.1) n = detent; change(n); }}
      onPointerDown={event => event.currentTarget.setPointerCapture?.(event.pointerId)} onPointerUp={release} onPointerCancel={release} onBlur={() => release()} onDoubleClick={event => { event?.stopPropagation(); reset(); }}
      onKeyDown={event => {
        const direction = ["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowDown"].includes(event.key) ? -1 : 0;
        if (!direction) return;
        event.preventDefault(); event.stopPropagation();
        const increment = (event.altKey ? step / 10 : event.shiftKey ? step * 10 : step);
        change(Math.max(min, Math.min(max, Number((latest.current + direction * increment).toFixed(6)))));
      }} onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) release(); }}
      className={`st-slider block h-4 w-full cursor-ew-resize appearance-none bg-transparent disabled:opacity-40 ${FOCUS}`}
      style={{ backgroundImage: `linear-gradient(to right, color-mix(in srgb, var(--ink) 14%, transparent) 0%, color-mix(in srgb, var(--ink) 14%, transparent) ${Math.min(centre, amount)}%, var(--accent) ${Math.min(centre, amount)}%, var(--accent) ${Math.max(centre, amount)}%, color-mix(in srgb, var(--ink) 14%, transparent) ${Math.max(centre, amount)}%, color-mix(in srgb, var(--ink) 14%, transparent) 100%)`, backgroundSize: "100% 2px", backgroundPosition: "center", backgroundRepeat: "no-repeat" }} />
    {detent !== undefined ? <datalist id={`${id}-detent`}><option value={detent} /></datalist> : null}
    {invalid ? <InlineError>Enter a number from {min}{unit} to {max}{unit}.</InlineError> : null}
  </div>;
}

export const COLOURS: { id: MixerColour; colour: string }[] = [
  { id: "red", colour: "#ed6167" }, { id: "orange", colour: "#ed9e59" }, { id: "yellow", colour: "#e8cf66" }, { id: "green", colour: "#82bc77" },
  { id: "aqua", colour: "#6ac9c3" }, { id: "blue", colour: "#6f9ee8" }, { id: "purple", colour: "#a08ade" }, { id: "magenta", colour: "#d182bc" },
];
const ZERO = { hue: 0, sat: 0, lum: 0 };
export function normalizeMixer(value: Grade["mixer"]): NonNullable<Grade["mixer"]> {
  return Object.fromEntries(COLOURS.filter(({ id }) => Object.values(value?.[id] ?? ZERO).some(Boolean)).map(({ id }) => [id, { ...ZERO, ...value?.[id] }]));
}
export function ColourPanel({ value, onChange, onRelease, compact = false, preserveZero = false, isMixed }: { isMixed?: (colour:MixerColour,key:"hue"|"sat"|"lum")=>boolean; value: Grade["mixer"]; onChange: (value: Grade["mixer"]) => void; onRelease?: (value: Grade["mixer"]) => void; compact?: boolean; preserveZero?: boolean }) {
  const [selected, setSelected] = useState<MixerColour>("red");
  const band = value?.[selected] ?? ZERO;
  const update = (key: keyof typeof ZERO, amount: number) => { const next = { ...value, [selected]: { ...band, [key]: amount } }; return preserveZero ? next : normalizeMixer(next); };
  return <div className="space-y-4">
    <div role="group" aria-label="Colour bands" className="flex justify-between gap-1">{COLOURS.map(({ id, colour }) => <Tile key={id} type="button" aria-label={id[0].toUpperCase() + id.slice(1)} aria-pressed={selected === id} onClick={() => setSelected(id)} className={`flex min-h-9 flex-1 items-center justify-center rounded-lg ${selected === id ? "bg-ink/[0.12]" : "hover:bg-ink/[0.05]"} ${FOCUS}`}><span className="size-5 rounded-full" style={{ backgroundColor: colour }} /></Tile>)}</div>
    <p className="text-small capitalize">{selected}</p>
    {([['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance']] as const).map(([key, label]) => <Slider key={key} mixed={isMixed?.(selected,key)} label={label} min={-100} max={100} value={band[key]} onRelease={onRelease ? amount => onRelease(update(key, amount)) : undefined} onChange={amount => onChange(update(key, amount))} />)}
    {!compact ? <div aria-label="Colour overview" className="grid grid-cols-8 gap-1 rounded-xl bg-ink/[0.04] p-2">{COLOURS.map(({ id, colour }) => <div key={id} aria-label={`${id}: hue ${value?.[id]?.hue ?? 0}, saturation ${value?.[id]?.sat ?? 0}, luminance ${value?.[id]?.lum ?? 0}`} className="space-y-1 text-center text-micro text-muted"><span className="mx-auto block size-2 rounded-full" style={{ backgroundColor: colour }} />{(['hue', 'sat', 'lum'] as const).map(key => <span key={key} className="block tabular-nums">{value?.[id]?.[key] ?? 0}</span>)}</div>)}</div> : null}
    <Button type="button" onClick={() => { onChange({}); onRelease?.({}); }}>Reset</Button>
  </div>;
}
export const EQ_PRESETS = { natural: { low: 0, mid: 0, high: 0 }, warm: { low: 2, mid: -1, high: -1 }, clear: { low: -2, mid: 2, high: 2 }, broadcast: { low: 2, mid: 1, high: 3 } };
export function VoiceEq({ value, onChange }: { value: NonNullable<AudioFinish["eq"]>; onChange: (value: NonNullable<AudioFinish["eq"]>) => void }) {
  const preset = (Object.keys(EQ_PRESETS) as (keyof typeof EQ_PRESETS)[]).find(key => (['low', 'mid', 'high'] as const).every(band => EQ_PRESETS[key][band] === value[band]));
  return <div className="space-y-3"><p className="text-small">EQ{!preset ? <span className="ml-2 text-micro text-muted">Custom</span> : null}</p>
    <Segments label="Voice EQ presets" value={preset ?? ""} choices={Object.keys(EQ_PRESETS)} onChange={key => onChange({ ...EQ_PRESETS[key as keyof typeof EQ_PRESETS] })} />
    {(['low', 'mid', 'high'] as const).map(band => <Slider key={band} label={`${band[0].toUpperCase() + band.slice(1)}`} min={-6} max={6} step={.5} unit=" dB" value={value[band]} onChange={amount => onChange({ ...value, [band]: amount })} />)}
  </div>;
}
