import { useEffect, useMemo, useRef, useState } from "react";
import type { CutEdit, MotionGraphic, OverlayItem, Shoot } from "../../../../shared/schema";
import { GRADIENT_TYPES, LOOK_FONTS, LOOK_KIND_NAMES, LOOK_KINDS, LOOK_NOTES, isHex, lookDim, type GradientType, type Look, type LookBgKind, type LookCase, type LookChange } from "../../../../shared/look";
import { graphicLook, setGraphicLook } from "../../../../main/graphics/templates";
import { frameSrc, getApi } from "../../data";
import { overlaySessionFor } from "../OverlayHandles";
import { Button, FOCUS, SectionHeader, Segments, Slider, Switch, Tile } from "../ui";

// LOOK1 (docs/plans/produced/scene-look-spike.md): the Look section beside Motion for a selected scene. Its background
// (from the shot, a gradient with Shuffle, a design Claude writes, an image from his library or a dropped file, a flat
// colour), its type and its finish. A change is previewed on the viewer while it is made (templates.ts setGraphicLook,
// pure) and lands as one version: main makes its pictures and measures the dim (graphics/look.ts lookUpdate, the same
// change Ask and set_scene_look make), and the edit it returns goes through the same overlay edit as every inspector change.
// Soft fills only, never a line: focus and selection are a fill change.

const swatch = `cursor-pointer rounded-md bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-0 ${FOCUS}`;
const soft = `rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] text-ink hover:bg-ink/[0.1] focus-visible:bg-ink/[0.14] disabled:opacity-40 ${FOCUS}`;
// focus on a control already filled (the picked source, the house button) brightens its fill, as the primary button's
// focus does (brand.css), never a line
const lift = "focus-visible:brightness-125";
const chip = (on: boolean) => `rounded-lg px-1 py-1.5 text-[11px] leading-tight hover:bg-ink/[0.08] focus-visible:bg-ink/[0.12] ${lift} ${on ? "!bg-[var(--selection-fill)] text-accent" : "text-muted"} ${FOCUS}`;
const CASES: { value: LookCase; label: string }[] = [{ value: "lower", label: "Lower" }, { value: "as said", label: "As said" }, { value: "upper", label: "Upper" }];
const TYPES: { value: GradientType; label: string }[] = GRADIENT_TYPES.map(t => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }));
const COLOURS = ["#0a0a0b", "#16161d", "#1d2740", "#2a1a10", "#f0e7d2", "#ffffff"];
const WORD_SCENES = ["scene-beat-words", "scene-title-slam"];

const lookKey = (graphic: MotionGraphic) => graphic.css + graphic.html + JSON.stringify(graphic.look ?? null);   // REL09e: the saved look a change was made from

/** Put a prompt in Claude's message box and show the pane (CH3's chat; the cursor goes there, nothing is sent). */
export function askClaude(prompt: string) {
  // loaded when asked: the pane's layout module sets up the window's layout as it loads
  void Promise.all([import("../edits/claudeLayout"), import("../edits/ClaudePane")]).then(([{ setClaudeOpen }, { focusClaude }]) => { setClaudeOpen(true); requestAnimationFrame(() => requestAnimationFrame(() => {
    const box = document.querySelector<HTMLTextAreaElement>("#claude-pane [data-claude-input]");
    if (box) {
      // a controlled box: set its value the way typing does, so the chat keeps it
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, prompt);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    focusClaude();
  })); });
}

// What the last change said, by item, shown while the scene is still the one that change made (as Motion does).
const lastSaid = new Map<string, { css: string; changed: string[]; notes: string[] }>();
let shootCache: { root: string; shoot: Promise<Shoot | null> } | null = null;
const loadShoot = (root: string) => (shootCache?.root === root ? shootCache : shootCache = { root, shoot: getApi().loadShoot(root).catch(() => null) }).shoot;

export function LookControls({ item, busy, onEdit, onPreview, brand = [] }: { item: OverlayItem; busy: boolean; onEdit: (edit: CutEdit) => unknown; onPreview?: (graphic: MotionGraphic) => void; brand?: string[] }) {
  const graphic = item.graphic as MotionGraphic, found = graphicLook(graphic);
  const [live, setLive] = useState<LookChange | null>(null), [working, setWorking] = useState(false), [picking, setPicking] = useState(false), [, redraw] = useState(0);
  const [frames, setFrames] = useState<{ name: string; src: string }[] | null>(null);
  // REL09e: a change is in hand from the click until its new version reaches this panel (about 3 s while main makes the
  // pictures and the preview); till then the choice shows as picked and the section says it is preparing, never the old
  // choice looking unclicked. A change that is not saved puts the saved choice back.
  const [landing, setLanding] = useState<{ from: string; kind?: LookBgKind } | null>(null);
  const root = useRef<HTMLElement>(null);
  // a new saved scene (not the same one redrawn) ends what was being moved
  useEffect(() => { setLive(null); }, [graphic.css, graphic.html]);
  useEffect(() => { if (!landing) return; const t = setTimeout(() => setLanding(null), 20000); return () => clearTimeout(t); }, [landing]);
  const session = overlaySessionFor(item.id);
  const pieces = session?.timeline.pieces;
  const usedClips = useMemo(() => [...new Set((pieces ?? []).filter(p => p.layer === 0).map(p => p.clipId))], [pieces]);
  useEffect(() => {
    if (!picking || frames || !session) return;
    let alive = true;
    void loadShoot(session.root).then(shoot => {
      if (!alive || !shoot) return;
      const clips = shoot.clips.filter(c => usedClips.includes(c.id) && c.frames.length);
      setFrames(clips.flatMap(c => [c.frames[Math.floor(c.frames.length / 2)]].filter(Boolean).map(name => ({ name, src: frameSrc(shoot.root, name) }))).slice(0, 24));
    });
    return () => { alive = false; };
  }, [picking, frames, session?.root, usedClips]);
  if (!found) return null;
  const look = found.look, template = found.source.template, words = WORD_SCENES.includes(template);
  const shown: Look | null = live && look ? setGraphicLook(graphic, live, brand).look : look;
  const said = lastSaid.get(item.id)?.css === graphic.css ? lastSaid.get(item.id)! : null;
  const arriving = landing?.from === lookKey(graphic) ? landing : null;
  const off = busy || working;
  const kind: LookBgKind = shown?.bg.kind ?? "colour";

  async function send(change: LookChange, options: { all?: boolean; file?: string } = {}) {
    if (off) return;
    const api = getApi();
    if (!session?.cutId || !api.lookEdit) { lastSaid.set(item.id, { css: graphic.css, changed: [], notes: ["Open this edit to change its look."] }); redraw(n => n + 1); return; }
    setWorking(true);
    let sent = false, landed = false;
    const from = lookKey(graphic);
    setLanding({ from, kind: change.bg?.kind });
    try {
      const out = await api.lookEdit(session.root, session.cutId, session.version, { itemId: item.id, change, ...options });
      if (out.edit) {
        const next = out.edit.kind === "overlay" && out.edit.op === "update" ? (out.edit.patch as { graphic?: MotionGraphic }).graphic : (out.edit.kind === "batch" ? out.edit.edits.map(e => e.kind === "overlay" && e.op === "update" && e.id === item.id ? (e.patch as { graphic?: MotionGraphic }).graphic : null).find(Boolean) : null);
        lastSaid.set(item.id, { css: next?.css ?? graphic.css, changed: out.changed, notes: out.notes });
        sent = true;
        landed = await onEdit(out.edit) !== false;
      } else lastSaid.set(item.id, { css: graphic.css, changed: [], notes: out.notes.length ? out.notes : ["That's how it looks already."] });
    } catch (error) { lastSaid.set(item.id, { css: graphic.css, changed: [], notes: [plain(error)] }); }
    finally { setWorking(false); setLive(null); if (!landed) setLanding(null); if (!sent && live) onPreview?.(graphic); redraw(n => n + 1); }
  }
  function preview(change: LookChange) {
    const merged: LookChange = { ...live, ...change, ...(live?.bg || change.bg ? { bg: { ...live?.bg, ...change.bg } } : {}), ...(live?.type || change.type ? { type: { ...live?.type, ...change.type } } : {}), ...(live?.finish || change.finish ? { finish: { ...live?.finish, ...change.finish } } : {}) };
    setLive(merged);
    try { onPreview?.(setGraphicLook(graphic, merged, brand).graphic); } catch { /* the release says why */ }
  }
  const release = (change: LookChange) => void send({ ...live, ...change, ...(live?.bg || change.bg ? { bg: { ...live?.bg, ...change.bg } } : {}), ...(live?.type || change.type ? { type: { ...live?.type, ...change.type } } : {}), ...(live?.finish || change.finish ? { finish: { ...live?.finish, ...change.finish } } : {}) });
  function choose(next: LookBgKind) {
    setPicking(false);
    if (next === "design" && (shown?.bg.kind !== "design")) { askClaude(designPrompt(item)); return; }
    if (next === "image" && shown?.bg.kind !== "image") { setPicking(true); return; }
    void send({ bg: { kind: next } });
  }
  async function file(path: string | undefined) { if (path) await send({ bg: { kind: "image" } }, { file: path }); }

  const bg = shown?.bg, dim = shown ? lookDim(shown) : 0, notes = said ? [...said.changed.length ? [`Changed: ${said.changed.join("; ")}.`] : [], ...said.notes] : [];
  return <section ref={root} aria-label="Look" data-look-controls className="space-y-2.5">
    <div className="flex items-baseline justify-between gap-2"><SectionHeader as="h4" className="text-[12px] font-semibold">Look</SectionHeader>{working || arriving ? <span role="status" className="text-[11px] text-muted">Preparing the look</span> : null}</div>
    {!look ? <p className="text-[11px] text-muted">On black, as it was made. Pick a background to change it.</p> : null}
    <div role="group" aria-label="Background source" className="grid grid-cols-5 gap-1">
      {LOOK_KINDS.map(k => { const on = picking ? k === "image" : arriving?.kind ? arriving.kind === k : (look ? kind : null) === k;   // picking a picture: Image is the one in hand
        return <Tile key={k} type="button" aria-pressed={on} disabled={off} onClick={() => choose(k)} className={chip(on)}>{LOOK_KIND_NAMES[k]}</Tile>; })}
    </div>
    {look && bg?.kind === "shot" ? <Slider label="Blur" min={0} max={100} step={1} defaultValue={45} value={bg.blur} disabled={off} onChange={v => preview({ bg: { blur: v } })} onRelease={v => release({ bg: { blur: v } })} /> : null}
    {look && bg?.kind === "gradient" ? <div className="space-y-2">
      <div className="flex items-center gap-1.5" role="group" aria-label="Gradient colours">
        {bg.stops.map((c, i) => <input key={i} type="color" aria-label={`Colour ${i + 1}`} value={c} disabled={off} className={`h-7 flex-1 ${swatch}`}
          onChange={e => preview({ bg: { stops: bg.stops.map((s, j) => j === i ? e.target.value : s) } })} onBlur={() => live?.bg ? release({}) : undefined} />)}
        <button type="button" disabled={off} onClick={() => void send({ shuffle: true })} className={soft}>Shuffle</button>
      </div>
      <p className="text-[11px] text-muted">{shown?.palette?.length ? "Shuffle mixes the shot's colours" : "Shuffle mixes"}{brand.length ? " and your caption colours" : ""}, kept dark so the words read.</p>
      <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">Kind</span><Segments label="Gradient kind" variant="compact" value={bg.type} options={TYPES.map(t => ({ ...t, disabled: off }))} onChange={v => void send({ bg: { type: v } })} /></div>
      {bg.type === "linear" ? <Slider label="Angle" min={0} max={350} step={10} unit="°" defaultValue={160} value={bg.angle} disabled={off} onChange={v => preview({ bg: { angle: v } })} onRelease={v => release({ bg: { angle: v } })} /> : null}
      <label className="flex items-center justify-between gap-2 text-[11px]"><span className="text-muted">Slow drift</span><Switch label="Slow drift" checked={bg.drift} disabled={off} onChange={e => void send({ bg: { drift: e.target.checked } })} /></label>
    </div> : null}
    {look && bg?.kind === "design" ? <div className="space-y-1.5">
      <p className="text-[12px] text-ink">{bg.name ? `“${bg.name}”` : "A design"}{bg.raster ? <span className="text-muted"> · kept as a still picture</span> : null}</p>
      <button type="button" disabled={off} onClick={() => askClaude(designPrompt(item))} className={soft}>Ask Claude for another</button>
    </div> : null}
    {picking || (look && bg?.kind === "image") ? <div className="space-y-1.5" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const dropped = e.dataTransfer.files?.[0]; if (dropped) void file(getApi().pathForFile(dropped)); }}>
      {look && bg?.kind === "image" && bg.name ? <p className="truncate text-[12px] text-ink">{bg.name}{bg.face ? <span className="text-muted"> · words kept clear of the face</span> : null}</p> : null}
      <div role="group" aria-label="Frames from this edit" className="grid grid-cols-4 gap-1">
        {(frames ?? []).map(f => <button key={f.name} type="button" aria-label={`Use frame ${f.name}`} disabled={off} onClick={() => { setPicking(false); void send({ bg: { kind: "image", frame: f.name } }); }}
          className={`overflow-hidden rounded-md bg-ink/[0.06] hover:opacity-90 focus-visible:opacity-80 disabled:opacity-40 ${FOCUS}`}><img src={f.src} alt="" className="aspect-[9/16] w-full object-cover" loading="lazy" /></button>)}
      </div>
      {picking && !frames ? <p className="text-[11px] text-muted">Finding frames from this edit</p> : null}
      <div className="flex flex-wrap items-center gap-1"><button type="button" disabled={off} onClick={() => void getApi().pickOverlayFiles().then(([path]) => file(path)).catch(error => { lastSaid.set(item.id, { css: graphic.css, changed: [], notes: [plain(error)] }); redraw(n => n + 1); })} className={soft}>Choose a picture</button>
        <span className="text-[11px] text-muted">or drop one here</span>
        {picking ? <button type="button" onClick={() => setPicking(false)} className={soft}>Cancel</button> : null}</div>
      {look && bg?.kind === "image" ? <Slider label="Blur" min={0} max={100} step={1} defaultValue={0} value={bg.blur} disabled={off} onChange={v => preview({ bg: { blur: v } })} onRelease={v => release({ bg: { blur: v } })} /> : null}
    </div> : null}
    {look && bg?.kind === "colour" ? <div className="flex items-center gap-1.5" role="group" aria-label="Background colour">
      {COLOURS.map(c => <button key={c} type="button" aria-label={c === "#0a0a0b" ? "Black" : `Colour ${c}`} aria-pressed={bg.value === c} disabled={off} onClick={() => void send({ bg: { value: c } })} className={`h-7 flex-1 rounded-md hover:opacity-90 focus-visible:opacity-80 ${FOCUS}`} style={{ background: c }} />)}
      <input type="color" aria-label="Pick a colour" value={bg.value} disabled={off} className={`h-7 w-9 ${swatch}`} onChange={e => preview({ bg: { value: e.target.value } })} onBlur={() => live?.bg ? release({}) : undefined} />
    </div> : null}
    {look ? <>
      <Slider label="Dim" min={0} max={90} step={1} unit="%" defaultValue={0} value={Math.round(dim * 100)} disabled={off} onChange={v => preview({ dim: v / 100 })} onRelease={v => release({ dim: v / 100 })} />
      <label className="flex items-center justify-between gap-2 text-[11px]"><span className="text-muted">Dim so the words read</span><Switch label="Dim so the words read" checked={shown?.dim === "auto"} disabled={off} onChange={e => void send({ dim: e.target.checked ? "auto" : Math.round(dim * 100) / 100 })} /></label>
      {shown?.dim === "auto" && look.darkened ? <p className="text-[11px] text-muted">{LOOK_NOTES.darkened}</p> : null}
      {words ? <div role="group" aria-label="Type" className="space-y-2 rounded-xl bg-ink/[0.04] p-2.5">
        <SectionHeader as="h4" className="text-[12px] font-semibold">Type</SectionHeader>
        <label className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">Font</span>
          <select aria-label="Font" value={shown?.type.font ?? ""} disabled={off} onChange={e => void send({ type: { font: e.target.value || null } })} className={`min-w-0 rounded-lg bg-ink/[0.06] px-2 py-1.5 text-[12px] text-ink ${FOCUS}`}>
            <option value="">The edit's font</option>{LOOK_FONTS.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
        <Slider label="Weight" min={400} max={900} step={100} defaultValue={800} value={shown?.type.weight ?? 800} disabled={off} onChange={v => preview({ type: { weight: v } })} onRelease={v => release({ type: { weight: v } })} />
        <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">Case</span><Segments label="Case" variant="compact" value={shown?.type.case ?? "lower"} options={CASES.map(c => ({ ...c, disabled: off }))} onChange={v => void send({ type: { case: v } })} /></div>
        <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">Colours</span><div className="flex items-center gap-1.5">
          <input type="color" aria-label="Words colour" value={shown?.type.colour ?? "#ffffff"} disabled={off} className={`h-7 w-9 ${swatch}`} onChange={e => preview({ type: { colour: e.target.value } })} onBlur={() => live?.type ? release({}) : undefined} />
          <input type="color" aria-label="Accent colour" value={shown?.type.accent ?? (isHex(brand[0]) ? brand[0] : "#5b8cff")} disabled={off} className={`h-7 w-9 ${swatch}`} onChange={e => preview({ type: { accent: e.target.value } })} onBlur={() => live?.type ? release({}) : undefined} />
          <span className="text-muted">Words, accent</span></div></div>
        <Slider label="Size" min={60} max={160} step={5} unit="%" defaultValue={100} value={Math.round((shown?.type.scale ?? 1) * 100)} disabled={off} onChange={v => preview({ type: { scale: v / 100 } })} onRelease={v => release({ type: { scale: v / 100 } })} />
      </div> : null}
      <div role="group" aria-label="Finish" className="space-y-2">
        <Slider label="Grain" min={0} max={100} step={1} unit="%" defaultValue={0} value={Math.round((shown?.finish.grain ?? 0) * 100)} disabled={off} onChange={v => preview({ finish: { grain: v / 100 } })} onRelease={v => release({ finish: { grain: v / 100 } })} />
        <Slider label="Vignette" min={0} max={100} step={1} unit="%" defaultValue={20} value={Math.round((shown?.finish.vignette ?? 0) * 100)} disabled={off} onChange={v => preview({ finish: { vignette: v / 100 } })} onRelease={v => release({ finish: { vignette: v / 100 } })} />
        <Slider label="Push" min={0} max={10} step={0.5} unit="%" defaultValue={3} value={shown?.finish.push ?? 0} disabled={off} onChange={v => preview({ finish: { push: v } })} onRelease={v => release({ finish: { push: v } })} />
      </div>
      <Button disabled={off} className={lift} onClick={() => void send({}, { all: true })}>Use this look on all scenes</Button>
    </> : null}
    {notes.length ? <div aria-live="polite" className="space-y-1 rounded-lg bg-ink/[0.04] px-2 py-1.5 text-[11px] text-muted">{notes.map(n => <p key={n}>{n}</p>)}</div> : null}
  </section>;
}

const plain = (error: unknown) => (error instanceof Error ? error.message : String(error ?? "")).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || "Couldn't change the look.";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** What "Ask Claude to design one" puts in Claude's box: the scene and the tool, his description left for him. */
export const designPrompt = (item: OverlayItem) => `Design a background for the scene at ${clock(item.s)} (scene ${item.id}, set_scene_look bg kind design): `;
