import { useState } from "react";
import type { CutEdit, MotionGraphic, OverlayItem, TitleTrack } from "../../../../shared/schema";
import { buildFromTemplate, graphicSource, graphicTemplates, templateInfo, type TemplateParam } from "../../../../main/graphics/templates";
import { Plus } from "../icons";
import { Button, FOCUS, SectionHeader } from "../ui";
import { MotionControls, type MotionSource } from "./MotionControls";
import { LookControls } from "./LookControls";
import { overlaySessionFor, pinWaiting, startPick, cancelPick, usePinState } from "../OverlayHandles";

// GFX1: the hands-on side of motion graphics. A starter is built here (it is plain text, no rendering) and sent through
// the same overlay edit as an image; the app draws and checks it, so a bad one comes back as a plain message.
const field = `w-full min-w-0 rounded-lg bg-ink/[0.06] px-2 py-1.5 text-[12px] text-ink ${FOCUS}`;
const KIND_LABEL: Record<string, string> = { text: "Text", number: "Numbers", chart: "Charts", diagram: "Diagrams", card: "Cards", screenshot: "Screenshots", icon: "Icons", explainer: "Full frame" };

export function graphicName(item: OverlayItem): string {
  const id = item.graphic?.template;
  return (id && templateInfo(id)?.name) || "Graphic";
}
function themeOf(titles?: TitleTrack | null) {
  const style = titles?.captionStyle;
  return { font: style?.font ?? titles?.font, accent: style?.accent, ink: style?.primary };
}

export function AddGraphic({ time, duration, titles, busy, onEdit }: { time: number; duration: number; titles?: TitleTrack | null; busy: boolean; onEdit: (edit: CutEdit) => unknown }) {
  const [open, setOpen] = useState(false), [note, setNote] = useState<string | null>(null);
  const kinds = [...new Set(graphicTemplates().map(t => t.kind))];
  function add(id: string) {
    const info = templateInfo(id)!;
    const room = duration - time;
    if (room < 0.8) { setNote("Move the playhead earlier to add a graphic."); return; }
    setNote(null); setOpen(false);
    const graphic = buildFromTemplate(id, {}, themeOf(titles), { durationS: Math.min(info.durationS, room) });
    const wide = graphic.widthPx / graphic.heightPx;
    void onEdit({ kind: "overlay", op: "add", source: "", item: { graphic, s: time, e: time + graphic.durationS, x: 0.5, y: graphic.frame === "full" ? 0.5 : 0.5, w: graphic.frame === "full" ? 1 : wide >= 2.6 ? 0.82 : wide >= 1.6 ? 0.6 : wide >= 1.1 ? 0.5 : 0.34, corner: "square", enter: "none", exit: "none", sound: null } });
  }
  return <div className="space-y-2">
    <Button disabled={busy || !duration} aria-expanded={open} onClick={() => setOpen(value => !value)}><Plus size={13} />Add graphic</Button>
    {open ? <div aria-label="Graphics" className="space-y-2">{kinds.map(kind => <div key={kind} className="space-y-1"><SectionHeader as="h4" className="text-[11px] text-muted">{KIND_LABEL[kind] ?? kind}</SectionHeader>
      {graphicTemplates().filter(t => t.kind === kind).map(t => <button key={t.id} type="button" disabled={busy} onClick={() => add(t.id)} className={`block w-full rounded-[10px] bg-ink/[0.06] px-2.5 py-1.5 text-left hover:bg-ink/[0.1] ${FOCUS}`}><span className="block text-[12px] font-semibold">{t.name}</span><span className="block text-[11px] text-muted">{t.about}</span></button>)}</div>)}</div> : null}
    {note ? <p className="text-[11px] text-muted">{note}</p> : null}
  </div>;
}

const asText = (param: TemplateParam, value: unknown) => Array.isArray(value)
  ? value.map(row => Array.isArray(row) ? row.join(", ") : typeof row === "object" && row ? `${(row as { label?: string }).label}, ${(row as { value?: number }).value}` : String(row)).join("\n") : value === undefined || value === null ? "" : String(value);
function fromText(param: TemplateParam, text: string): unknown {
  if (param.type === "number") return Number(text);
  if (param.type === "list") return text.split("\n").map(s => s.trim()).filter(Boolean);
  if (param.type === "data") {
    const rows = text.split("\n").map(line => line.split(",").map(s => s.trim())).filter(r => r.length >= 2 && r[0] && Number.isFinite(Number(r[1]))).map(r => [r[0], Number(r[1])]);
    return param.name === "highlight" ? text.split(",").map(s => Number(s.trim())) : rows;
  }
  return text;
}

/** TRK1c: "Stick to something": the stage picks the thing on the paused frame (OverlayHandles), main follows it. Once
 *  pinned, the Tracking group in the Motion section has the rest (Pick again, Unstick). */
function StickAction({ item, busy }: { item: OverlayItem; busy: boolean }) {
  const { pick } = usePinState(), session = overlaySessionFor(item.id), picking = pick?.itemId === item.id;
  if (item.pin || item.graphic?.frame === "full") return null;
  return <div data-stick-action className="space-y-1">
    <Button aria-pressed={picking} disabled={busy || !session || (!picking && pinWaiting(session))} onClick={() => picking ? cancelPick() : session && startPick(session, item)}>{picking ? "Picking the thing…" : "Stick to something"}</Button>
    <p className="text-[11px] text-muted">{picking ? "Box the thing on the video. Return sticks it, Esc cancels." : "Pin it to a thing in the shot, so it moves with it."}</p>
  </div>;
}

/** The starter's own fields, the Motion section for anything that moves (MOT1b), and the composition source for anyone
 *  who wants to write it by hand. */
export function GraphicDesign({ item, busy, onEdit, motion, onPreview }: { item: OverlayItem; busy: boolean; onEdit: (edit: CutEdit) => unknown; motion?: MotionSource | null; onPreview?: (graphic: MotionGraphic) => void }) {
  const graphic = item.graphic as MotionGraphic, source = graphicSource(graphic), info = source && templateInfo(source.template);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((info?.params ?? []).map(p => [p.name, asText(p, source?.params[p.name] ?? p.default)])));
  const [code, setCode] = useState<{ html: string; css: string; js: string } | null>(null);
  const send = (next: MotionGraphic) => onEdit({ kind: "overlay", op: "update", id: item.id, patch: { graphic: next } });
  function apply() {
    if (!source || !info) return;
    const params = Object.fromEntries(info.params.filter(p => p.type !== "image" && values[p.name] !== undefined).map(p => [p.name, fromText(p, values[p.name])]));
    void send(buildFromTemplate(source.template, { ...source.params, ...params }, source.theme, { durationS: graphic.durationS, layer: graphic.layer, words: graphic.words }));
  }
  return <div className="space-y-3">
    {info ? <div className="space-y-2">{info.params.filter(p => p.type !== "image").map(p => <label key={p.name} className="grid grid-cols-[72px_1fr] items-start gap-2.5"><span className="pt-1.5 text-right text-[12px] text-muted">{p.label.replace(/ \(.*\)/, "")}</span>
      {p.type === "choice" ? <select value={values[p.name]} disabled={busy} onChange={event => setValues(v => ({ ...v, [p.name]: event.target.value }))} className={field}>{p.options!.map(o => <option key={o} value={o}>{o}</option>)}</select>
        : p.type === "list" || p.type === "data" ? <textarea rows={Math.min(6, Math.max(2, values[p.name].split("\n").length))} disabled={busy} value={values[p.name]} onChange={event => setValues(v => ({ ...v, [p.name]: event.target.value }))} className={field} />
        : <input type="text" inputMode={p.type === "number" ? "decimal" : "text"} disabled={busy} value={values[p.name]} onChange={event => setValues(v => ({ ...v, [p.name]: event.target.value }))} className={field} />}</label>)}
      <Button disabled={busy} onClick={apply}>Update graphic</Button></div> : null}
    <StickAction item={item} busy={busy} />
    <MotionControls item={item} source={motion} busy={busy} onEdit={onEdit} onPreview={onPreview} />
    {/* LOOK1: a scene's look, beside its motion. Shuffle offers the edit's caption colours as the brand's. */}
    <LookControls item={item} busy={busy} onEdit={onEdit} onPreview={onPreview} brand={[themeOf((motion?.titles ?? null) as TitleTrack | null).accent, themeOf((motion?.titles ?? null) as TitleTrack | null).ink].filter((c): c is string => typeof c === "string")} />
    {code ? <div className="space-y-2">{(["html", "css", "js"] as const).map(key => <label key={key} className="block space-y-1 text-[11px] text-muted"><span>{key.toUpperCase()}</span>
      <textarea aria-label={`Graphic ${key}`} spellCheck={false} rows={key === "js" ? 6 : 8} disabled={busy} value={code[key]} onChange={event => setCode({ ...code, [key]: event.target.value })} className={`${field} font-mono text-[11px] leading-snug`} /></label>)}
      <div className="flex gap-2"><Button variant="primary" disabled={busy} onClick={() => void send({ ...graphic, html: code.html, css: code.css, ...(code.js.trim() ? { js: code.js } : { js: undefined }) })}>Apply</Button><Button disabled={busy} onClick={() => setCode(null)}>Close</Button></div></div>
      : <Button disabled={busy} onClick={() => setCode({ html: graphic.html, css: graphic.css, js: graphic.js ?? "" })}>Edit design</Button>}
  </div>;
}
