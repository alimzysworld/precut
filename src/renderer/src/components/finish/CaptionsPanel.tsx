import "./captions.css";
import { useModelAccess, ModelSignIn } from "../ModelAccess";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CaptionAccentForm, CaptionStyle, CaptionTextEffect, CutVersion, TitleTrack } from "../../../../shared/schema";
import { getApi } from "../../data";
import { useActivity, ActivityProgress } from "../Activity";
import { CAPTION_DESIGN, captionDesignOfLabel, captionDesignOfNote, type CaptionDesign } from "../../../../main/titles/design-notes";
import { Button, InlineError } from "../ui";
import { useEditHistory } from "../../hooks/useEditHistory";
import { CAPTION_PRESETS, CAPTION_FONTS, DEFAULT_CAPTION_STYLE, buildCaptionTrack } from "../../../../main/titles/captions";
import { FontPicker, fontOnThisMac } from "./FontPicker";
import { titleDocument } from "../LivePlayer";
import { FOCUS, Row, SegmentedControl, Switch, Tile } from "../ui";

// CAP4: the stressed word's forms and the optional text effects, in the panel's words.
const ACCENT_FORMS: [CaptionAccentForm, string][] = [["colour", "Colour"], ["italic", "Italic"], ["caps", "Caps"], ["bigger", "Bigger"], ["tag", "Tag"]];
const TEXT_EFFECTS: [CaptionTextEffect, string][] = [["none", "None"], ["depth", "Depth"], ["shadow", "Shadow"], ["blur-in", "Blur in"]];
// Real word timings, so the 1.2 s preview frame shows one spoken word ("styled") in the accent and the rest in the primary.
const sampleWords = "This is a styled caption".split(" ").map((text, i) => ({ text, s: [0, .3, .6, .9, 1.5][i], e: [.3, .6, .9, 1.5, 1.8][i] }));
export function CaptionLanguage({ root, cutId, version, disabled }: { root: string; cutId: string; version: CutVersion; disabled?: boolean }) {
  const modelReady = useModelAccess();
  const { history } = useEditHistory(root, cutId, version.version);
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  const [saved, setSaved] = useState({ version: version.version, language: version.captionLanguage ?? "" });
  const active = useRef(false);
  useEffect(() => { setSaved({ version: version.version, language: version.captionLanguage ?? "" }); setError(""); }, [root, cutId, version.version, version.captionLanguage]);
  const languages = [["", "As spoken"], ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["ar", "Arabic"], ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"], ["zh-Hans", "Chinese (simplified)"]];
  if (saved.language && !languages.some(([tag]) => tag === saved.language)) languages.push([saved.language, saved.language]);
  if (!modelReady) return <ModelSignIn feature="translate" />;
  return <div className="space-y-2"><Row as="label"><span className="text-micro text-muted">Language</span><select aria-label="Caption language" disabled={disabled || working} value={saved.language} className={`max-w-[65%] rounded-lg bg-ink/[0.06] p-2 text-small text-ink ${FOCUS}`} onChange={async event => {
    if (active.current) return;
    const language = event.target.value;
    active.current = true; setWorking(true); setError("");
    try {
      const result = await getApi().translateCaptions(root, cutId, saved.version, language || null);
      history.commit(saved.version, result.version, language ? `Translate captions to ${language}` : "Restore spoken captions");
      const { selectSidekickCut } = await import("../SidekickChat");
      selectSidekickCut(root, result);
      setSaved({ version: result.version, language });
    }
    catch (error) { setError(error instanceof Error ? error.message : "Could not translate captions."); }
    finally { active.current = false; setWorking(false); }
  }}>{languages.map(([tag, label]) => <option key={tag} value={tag}>{label}</option>)}</select></Row>
    {working ? <Row><p role="status" className="text-micro text-muted">Translating captions…</p><Button onClick={async () => { const activities = await getApi().listActivity(); const activity = activities.find(a => a.kind === "titles" && a.state === "running" && a.target?.cutId === cutId); if (activity) await getApi().cancelActivity(activity.id); }}>Cancel</Button></Row> : null}
    <p className="text-micro text-muted">Translation makes an undoable version. Saved languages export as SRT files.</p>
    {error ? <InlineError>{error}</InlineError> : null}
  </div>;
}
type ThumbnailRenderer = { init(track: TitleTrack, options: { width: number; height: number; layer: string }): Promise<void>; seek(time: number): Promise<void> };
export function CaptionThumbnail({ style }: { style: CaptionStyle }) {
  const iframe = useRef<HTMLIFrameElement>(null), container = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(0), [width, setWidth] = useState(320);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const renderer = (iframe.current?.contentWindow as (Window & { titleRenderer?: ThumbnailRenderer }) | null)?.titleRenderer;
    if (!renderer) return;
    let alive = true;
    // Use the export renderer, with a full sample line and legible card scale.
    const track = buildCaptionTrack(sampleWords, { font: style.font, cues: [], prompt: null, skillIds: [], emphasis: ["3"] }, { ...style, position: "middle", wordsPerLine: "line", hook: "off" }, { left: .04, right: .96, top: 0, bottom: 1 });
    track.cues.forEach(cue => { cue.size = { s: .15, m: .18, l: .22 }[style.size]; });
    void renderer.init(track, { width: 640, height: 128, layer: "all" }).then(() => { if (alive) return renderer.seek(1.2); }).catch(() => {});
    return () => { alive = false; };
  }, [loaded, style]);
  return <div ref={container} className="pointer-events-none relative h-16 w-full overflow-hidden rounded-xl" style={{ background: "var(--primary-ink)" }}>
    <iframe ref={iframe} title={`${style.preset}: This is a styled caption`} srcDoc={titleDocument} onLoad={() => setLoaded(n => n + 1)} tabIndex={-1} aria-hidden="true" className="pointer-events-none absolute left-0 top-1/2 origin-top-left border-0" style={{ width: 640, height: 128, transform: `translateY(-${width / 10}px) scale(${width / 640})`, colorScheme: "normal", background: "transparent" }} />
  </div>;
}

/** 0.7.1: a caption change waiting on the model, under the control that asked for it (the opening line and big lines
 * under Opening caption, key words under Emphasis). It shows from the click (`waiting`, the panel's own change in flight)
 * and while the edit's activity says the model is designing it (the same words as the status line), until the version
 * with it is on screen. If the model couldn't answer, the track's plain note with Retry. */
export function CaptionDesignNote({ root, cutId, slot, waiting, failed, onRetry }: {
  root: string; cutId?: string; slot: "hook" | "emphasis"; waiting: CaptionDesign | null; failed: string | null; onRetry: () => void;
}) {
  const mine = (kind: CaptionDesign | null) => !!kind && (kind === "emphasis") === (slot === "emphasis");
  const running = useActivity({ root, state: "running" }).filter(a => a.target?.cutId === cutId).map(a => captionDesignOfLabel(a.label)).find(mine) ?? null;
  const kind = running ?? (mine(waiting) ? waiting : null);
  if (kind) return <div role="status" data-caption-design className="space-y-1.5 pt-1">
    <p className="text-micro text-muted">{CAPTION_DESIGN[kind].label}…</p>
    <ActivityProgress pct={null} label={CAPTION_DESIGN[kind].label} className="text-accent" />
  </div>;
  if (!failed || !mine(captionDesignOfNote(failed))) return null;
  return <p role="status" data-caption-design-failed className="pt-1 text-micro text-muted">{failed} <button type="button" onClick={onRetry} className={`underline ${FOCUS}`}>Retry</button></p>;
}

/** The same preset data and controls serve staged edits and saved defaults. */
export function CaptionSettings({ value, onChange, onPreview, notes }: {
  value: CaptionStyle; onChange: (style: CaptionStyle) => void; onPreview?: (style: CaptionStyle | null) => void;
  /** 0.7.1: what a control's change is waiting on (the model designing it, or why it couldn't), shown under that control. */
  notes?: Partial<Record<"hook" | "emphasis", ReactNode>>;
}) {
  const change = <K extends keyof CaptionStyle>(key: K, next: CaptionStyle[K]) => onChange({ ...value, [key]: next });
  const fields: { key: "font" | "size" | "position" | "wordsPerLine" | "case" | "background" | "animation" | "hook"; label: string; choices: [string, string][]; hint?: string }[] = [
    { key: "font", label: "Font", choices: CAPTION_FONTS.map(f => [f, f]) },
    { key: "size", label: "Size", choices: [["s", "Small"], ["m", "Medium"], ["l", "Large"]] },
    { key: "position", label: "Position", choices: [["bottom", "Bottom"], ["lower", "Lower"], ["middle", "Middle"], ["top", "Top"]] },
    { key: "wordsPerLine", label: "Words per line", choices: [["1-2", "1 to 2"], ["3-4", "3 to 4"], ["line", "Full line"]] },
    { key: "case", label: "Case", choices: [["as-spoken", "As spoken"], ["upper", "Uppercase"], ["lower", "Lowercase"]] },
    { key: "background", label: "Background", choices: [["none", "None"], ["box", "Box"], ["pill", "Pill"]] },
    { key: "hook", label: "Opening caption", choices: [["auto", "Auto"], ["off", "Off"], ["all", "Throughout"]], hint: "Auto makes the opening line big. Throughout makes every standout line big." },
    { key: "animation", label: "Animation", choices: [["none", "None"], ["pop", "Pop"], ["glide", "Glide"], ["karaoke", "Karaoke"], ["box-highlight", "Box highlight"], ["typewriter", "Typewriter"], ["pulse", "Pulse"], ["fade", "Fade"]] },
  ];
  return <div data-caption-settings className="space-y-4">
    <div role="group" aria-label="Caption presets" className="flex flex-col gap-2">
      {CAPTION_PRESETS.map(preset => <Tile key={preset.style.preset} type="button" aria-label={`${preset.name} preset`} aria-pressed={value.preset === preset.style.preset} onPointerEnter={() => onPreview?.(preset.style)} onPointerLeave={() => onPreview?.(null)} onFocus={() => onPreview?.(preset.style)} onBlur={() => onPreview?.(null)} onClick={() => { onPreview?.(null); onChange({ ...preset.style, hook: value.hook ?? "auto" }); }} style={{ background: value.preset === preset.style.preset ? "color-mix(in srgb, var(--accent) 22%, transparent)" : undefined }} className={`caption-style-card relative min-w-0 rounded-xl text-left ${FOCUS}`}>
        <CaptionThumbnail style={preset.style} />
        <span aria-hidden="true" className="caption-style-ring pointer-events-none absolute inset-0 rounded-xl" style={{ background: value.preset === preset.style.preset ? "color-mix(in srgb, var(--accent) 22%, transparent)" : undefined }} />
        <span className="sr-only">{preset.name}</span>
      </Tile>)}
    </div>
    <div className="space-y-3">
      {([['primary', 'Primary colour'], ['accent', 'Accent colour']] as const).map(([key, label]) => <Row key={key} className="gap-2"><span className="text-micro text-muted">{label}</span><div role="group" aria-label={label} className="flex items-center gap-1">
        <input aria-label={`${label} picker`} type="color" value={value[key]} onChange={event => change(key, event.target.value)} className={`size-6 cursor-pointer rounded-full bg-transparent ${FOCUS}`} />
      </div></Row>)}
      {fields.map(field => <div key={field.key} className="space-y-1"><span className="text-micro text-muted">{field.label}</span>{field.key === "font" ? <><FontPicker label={field.label} value={value.font} suggested={CAPTION_FONTS} onChange={font => change("font", font)} onPreview={font => onPreview?.(font ? { ...value, font } : null)} />
        {fontOnThisMac(value.font, CAPTION_FONTS) ? null : <p role="status" className="text-micro text-muted">{value.font} isn't on this Mac, using {DEFAULT_CAPTION_STYLE.font}.</p>}</> : <SegmentedControl variant="compact" label={field.label} value={String(value[field.key] ?? "auto")} options={field.choices.map(([value, label]) => ({ value, label }))} onChange={id => change(field.key, id as CaptionStyle[typeof field.key])} className={field.choices.length > 4 ? "!grid grid-cols-2" : ""} />}{field.hint ? <p className="text-micro text-muted">{field.hint}</p> : null}{field.key === "hook" ? notes?.hook : null}</div>)}
      {([['outline', 'Outline', 'A dark edge around every word, so captions read on bright footage.'], ['emphasis', 'Emphasis', 'Highlights the key word in each line in your accent colour.']] as const).map(([key, label, hint]) => <div key={key} className="space-y-1"><Row className="gap-2"><span className="text-micro text-muted">{label}</span><Switch aria-label={label} checked={value[key]} onChange={event => change(key, event.target.checked)} /></Row><p className="text-micro text-muted">{hint}</p>{key === "emphasis" ? notes?.emphasis : null}</div>)}
      {/* CAP4: how the stressed word stands out (one default for the edit; a word's own menu on the timeline beats it). */}
      <div className="space-y-1" data-caption-accent-as><span className="text-micro text-muted">Stressed words</span>
        <SegmentedControl variant="compact" label="Stressed words" value={value.accentAs ?? "colour"} options={ACCENT_FORMS.map(([value, label]) => ({ value, label }))} onChange={id => change("accentAs", id as CaptionAccentForm)} className="!grid grid-cols-3" />
        <p className="text-micro text-muted">How a stressed word stands out: in your accent colour, in italics, in caps, bigger, or on an accent tag that wipes on as you say it. Right-click a word on the timeline to change just that one.</p></div>
      {/* CAP4 (31 Oct): text effects are allowed as an option he picks, never part of a preset or the default. */}
      <div className="space-y-1" data-caption-effect><span className="text-micro text-muted">Text effect</span>
        <SegmentedControl variant="compact" label="Text effect" value={value.effect ?? "none"} options={TEXT_EFFECTS.map(([value, label]) => ({ value, label }))} onChange={id => change("effect", id as CaptionTextEffect)} className="!grid grid-cols-2" />
        <p className="text-micro text-muted">Off unless you pick one.</p></div>
    </div>
  </div>;
}
