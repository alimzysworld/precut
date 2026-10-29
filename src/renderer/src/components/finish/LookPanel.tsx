import { pieceName } from "../../../../shared/clip-name";
import { changedPatch, mergePatch, selectionBatch } from "../timeline/selection";
import { InfoTip, CONTROL_TIPS } from "../ui/InfoTip";
import { balancedLook } from "../../../../shared/clip-balance";
import { autoCorrect, ownBalance, useBalance } from "../../hooks/useBalance";
import { useAutoCorrectUndo } from "../../hooks/useEditHistory";
import { useEffect, useRef, useState } from "react";
import type { Api, BasicAdjust, CutEdit, CutVersion, DraftTimeline, Grade, PieceLook, DetailChoice, GrainChoice, GrainPreset, LookPreset, VignetteChoice } from "../../../../shared/schema";
import { BASIC_BOUNDS, normalizeBasic } from "../../../../main/basics";
import { getApi } from "../../data";
import { Button, FOCUS, InlineError, SectionHeader, Tile, Row, Switch } from "../ui";
import { Slider, ColourPanel, normalizeMixer } from "./Controls";
import { Histogram } from "./Histogram";
import { pieceLook } from "./lookCache";
import { cachedLiveLut, createLookThumbnailRenderer, grabLookFrame, lookInputTimes, lookBasics, setBasicPreview, setGradePreview, type LookFrame, type LiveLook } from "../LivePlayer";
import { activityEta, ActivityShimmer, useActivity } from "../Activity";
import { DEFAULT_DETAIL, NO_DETAIL, DETAIL_BOUNDS, DETAIL_REASON } from "./detailMath";
import { GRAIN_PRESETS } from "./grainMath";
import { ChevronRight, Look, Wand, Link } from "../icons";
import { motion, useReducedMotion } from "framer-motion";
import { spring, instant } from "../../motion";
import { useShortcuts } from "../../hooks/useShortcuts";
import { usePageActive } from "../../hooks/usePageActivity";
import "./look.css";

export type LookChoice = { preset: string; words: string | null; intensity?: number; basic?: BasicAdjust };
export type LookImage = { id: string; name: string; description: string; family?: "Film" | "Warm" | "Cool" | "Soft" | "Mono" | "Clean"; image: string; still?: string };
type PreviewRequest = { intensity?: number; preset?: string; width?: number; height?: number; end?: number; adjustments?: Grade };
// Versioned local bitmap cache survives sheets, edits and app sessions. Main also
// fingerprints its on-disk skyline/LUT cache; failures are never cached.
const SAMPLE_CACHE = "precut.skyline-looks.v1";
let sampleImages: LookImage[] | undefined;
let sampleJob: Promise<void> | undefined;
const sampleListeners = new Set<(images: LookImage[]) => void>();
export function cachedSampleLooks(): LookImage[] {
  if (!sampleImages) {
    try {
      const saved: LookImage[] = JSON.parse(localStorage.getItem(SAMPLE_CACHE) ?? "[]");
      sampleImages = saved.filter(tile => EDIT_LOOKS.some(look => look.id === tile.id) && typeof tile.image === "string" && tile.image.startsWith("data:image/"));
    } catch { sampleImages = []; }
  }
  return sampleImages;
}
export function loadSampleLooks(receive: (images: LookImage[]) => void, failed: () => void) {
  sampleListeners.add(receive); receive(cachedSampleLooks());
  if (!sampleJob && cachedSampleLooks().length < EDIT_LOOKS.length) {
    sampleJob = (async () => {
      // One encoder at a time. Publish each tile as soon as its cached still is ready.
      for (const look of EDIT_LOOKS) {
        if (cachedSampleLooks().some(tile => tile.id === look.id)) continue;
        const tiles = await (getApi().renderSampleLooks as (sample: "skyline", preset: string) => Promise<LookImage[]>)("skyline", look.id);
        sampleImages = [...cachedSampleLooks().filter(tile => !tiles.some(next => next.id === tile.id)), ...tiles.map(tile => ({ ...tile, family: EDIT_LOOKS.find(look => look.id === tile.id)?.family ?? "Clean" }))];
        try { localStorage.setItem(SAMPLE_CACHE, JSON.stringify(sampleImages)); } catch { /* Main's disk cache remains available. */ }
        sampleListeners.forEach(listener => listener(sampleImages!));
      }
    })().finally(() => { sampleJob = undefined; });
  }
  void sampleJob?.catch(failed);
  return () => { sampleListeners.delete(receive); };
}
const renderLooks = (root: string, clipId: string, t: number, options: PreviewRequest = {}) =>
  (getApi().renderLookPreviews as (root: string, clipId: string, t: number, options?: PreviewRequest) => Promise<LookImage[]>)(root, clipId, t, options);

// Metadata mirrors grade.ts LOOKS. Keep this renderer-only list in parity until Api exposes a catalogue.
export const EDIT_LOOKS: Omit<LookImage, "image">[] = [
  {"id": "clean", "name": "Clean", "description": "True colour, gentle highlights. Your footage, clear.", "family": "Clean"},
  {"id": "hearth", "name": "Hearth", "description": "Amber light, full colour and grounded shadows.", "family": "Warm"},
  {"id": "linen", "name": "Linen", "description": "Warm soft film, faded blacks and quiet colour.", "family": "Soft"},
  {"id": "afterhours", "name": "Afterhours", "description": "Deep blue shadows, spare colour and soft lights.", "family": "Cool"},
  {"id": "openair", "name": "Open air", "description": "Crisp contrast, bright whites and clear colour.", "family": "Cool"},
  {"id": "neon", "name": "Night bus", "description": "Teal shadows and clear skin under city lights.", "family": "Cool"},
  {"id": "hush", "name": "Hush", "description": "Low colour, flat light and a quiet matte finish.", "family": "Soft"},
  {"id": "silver", "name": "Silver", "description": "Rich black and white, deep blacks and silver light.", "family": "Mono"},
  {"id": "lastlight", "name": "Last light", "description": "Golden warmth, soft highlights and an open glow.", "family": "Warm"},
  {"id": "warm-negative", "name": "Warm negative", "description": "Warm skin, pastel light and gentle film contrast.", "family": "Film"},
  {"id": "pastel-green", "name": "Pastel green", "description": "Airy highlights with a soft green-cyan cast.", "family": "Film"},
  {"id": "slide", "name": "Slide", "description": "Rich warm reds, clear colour and deep film contrast.", "family": "Film"},
  {"id": "drugstore", "name": "Drugstore", "description": "Punchy everyday film with green shadows.", "family": "Film"},
  {"id": "rust", "name": "Rust", "description": "Rust warmth, quiet colour and lifted blacks.", "family": "Warm"},
  {"id": "golden-fade", "name": "Golden fade", "description": "Faded gold and a soft late-day finish.", "family": "Warm"},
  {"id": "analog", "name": "Analog", "description": "Toasty analog colour and rounded highlights.", "family": "Warm"},
  {"id": "candy", "name": "Candy", "description": "Vivid colour, pink highlights and blue shadows.", "family": "Warm"},
  {"id": "mellow", "name": "Mellow", "description": "Muted blue wash with soft grey blacks.", "family": "Cool"},
  {"id": "street-cool", "name": "Street cool", "description": "Cool faded streets, crisp edges and quiet colour.", "family": "Cool"},
  {"id": "field", "name": "Field", "description": "Natural colour with a cool-green breeze.", "family": "Cool"},
  {"id": "night-tungsten", "name": "Night tungsten", "description": "Teal night shadows and warm practical lights.", "family": "Cool"},
  {"id": "pastel", "name": "Pastel", "description": "Powdery pink colour and soft pastel light.", "family": "Soft"},
  {"id": "cinematic", "name": "Cinematic", "description": "Restrained teal shadows with warm natural skin.", "family": "Soft"},
  {"id": "contrast-mono", "name": "Contrast mono", "description": "Bold monochrome with full blacks and clean light.", "family": "Mono"},
  {"id": "soft-mono", "name": "Soft mono", "description": "Gentle monochrome with open, silver-grey shadows.", "family": "Mono"},
];

/** Edits renders the gallery through the exact same LUT shader as live playback. */
type LivePreview = { cutId: string; version: number; timeline?: DraftTimeline | null; time: number; matchClips: boolean; matchRef?: number | null; mixer: Grade["mixer"] };
export function LiveLookStrip({ root, cutId, version, timeline, time, matchClips, matchRef, mixer, ...props }: LivePreview & { root: string } & Pick<Parameters<typeof LookStrip>[0], "value" | "disabled" | "onChoose" | "onRelease" | "onNames">) {
  const pageActive = usePageActive();
  const [frame, setFrame] = useState<LookFrame | null>(null);
  const [images, setImages] = useState<LookImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const captureTime = useRef(time);
  const thumbnails = useRef<ReturnType<typeof createLookThumbnailRenderer> | null>(null);
  const capturedTimeline = useRef<DraftTimeline>();
  const capturedRetry = useRef(retry);
  const existingImages = useRef(images); existingImages.current = images;
  useEffect(() => {
    if (!pageActive || !timeline || capturedTimeline.current === timeline && capturedRetry.current === retry) return;
    capturedTimeline.current = undefined; capturedRetry.current = retry;
    const controller = new AbortController();
    setError(null); setFrame(null); setImages([]);
    void grabLookFrame(timeline, captureTime.current, controller.signal).then(frame => { if (!controller.signal.aborted) { capturedTimeline.current = timeline; setFrame(frame); } }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Couldn't load this frame.");
    });
    return () => controller.abort();
  }, [timeline, retry, pageActive]);
  // Keep the lease through intensity/basic changes; release when this panel closes.
  useEffect(() => {
    if (!frame || !timeline) return;
    try { thumbnails.current = createLookThumbnailRenderer(); }
    catch { setError("Live look previews need WebGL2. Reopen the edit to try again."); return; }
    return () => { thumbnails.current?.dispose(); thumbnails.current = null; };
  }, [frame, timeline, retry]);
  useEffect(() => {
    const renderer = thumbnails.current;
    if (!pageActive || !frame || !timeline || !renderer) return;
    let active = true;
    setError(null);
    const index = timeline.pieces.indexOf(frame.piece);
    // Start each LUT independently; publish each completed tile without waiting for the gallery.
    void Promise.allSettled(EDIT_LOOKS.map(async look => {
      if (existingImages.current.some(image => image.id === look.id)) return;
      const ids = await pieceLook(root, cutId, version, { preset: look.id, intensity: props.value.intensity ?? .7,
        basic: normalizeBasic(props.value.basic), matchClips, matchRef, mixer } as Parameters<Api["pieceLuts"]>[3]);
      if (!active) return;
      const id = ids[index];
      if (!id) throw new Error("Couldn't find the colour for this piece.");
      const image = await renderer.thumbnail(frame, id, 160, Math.max(1, Math.round(160 * timeline.height / timeline.width)));
      if (active) setImages(previous => EDIT_LOOKS.flatMap(entry => {
        const tile = entry.id === look.id ? { ...look, image } : previous.find(tile => tile.id === entry.id);
        return tile ? [tile] : [];
      }));
    })).then(results => {
      if (active && results.some(result => result.status === "rejected")) setError("Some look previews couldn't load. Try again.");
    });
    return () => { active = false; };
  }, [frame, timeline, root, cutId, version, retry, pageActive]);
  return <div className="space-y-2">
    <LookStrip {...props} root={root} t={captureTime.current} mode="stage" suppliedImages={images} />
    {error ? <InlineError className="text-micro text-danger">{error} <button type="button" onClick={() => setRetry(n => n + 1)} className={`underline ${FOCUS}`}>Retry</button></InlineError> : null}
  </div>;
}

/** Shared by the per-cut controls and Settings. All previews are local. */
export function LookStrip({ root, clipId, t, value, disabled, mode = "commit", onChoose, onRelease, onNames, suppliedImages, livePreview }: {
  root?: string; clipId?: string; t: number; value: LookChoice; disabled?: boolean; mode?: "commit" | "stage";
  onChoose: (value: LookChoice, immediate?: boolean) => Promise<boolean>;
  onRelease?: (value: LookChoice) => void;
  suppliedImages?: LookImage[];
  livePreview?: LivePreview;
  onNames?: (names: Record<string, string>) => void;
}) {
  const pageActive = usePageActive();
  const previewActivities = useActivity({ root: root ?? null, kind: "looks", state: "running", ...(clipId ? { target: { clipId } } : {}) });
  const [images, setImages] = useState<LookImage[]>([]);
  const [family, setFamily] = useState("All");
  const [intensity, setIntensity] = useState(value.intensity ?? .7);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const galleryIntensity = mode === "stage" ? .7 : intensity;
  const committed = useRef(value.intensity ?? .7);
  const choosing = useRef(false);
  useEffect(() => { setIntensity(value.intensity ?? .7); committed.current = value.intensity ?? .7; }, [value.intensity]);
  // Coming back to this tab keeps the tiles it already has: only a changed input renders them again.
  const renderedFor = useRef<string>();
  useEffect(() => {
    if (!pageActive) return;
    if (livePreview) { setLoading(false); return; }
    if (suppliedImages) { setImages(suppliedImages); setLoading(false); return; }
    const inputs = JSON.stringify([root, clipId, t, galleryIntensity, retry]);
    if (renderedFor.current === inputs) return;
    let active = true;
    setError(null); setLoading(true);
    const timer = window.setTimeout(() => {
      void renderLooks(root && clipId ? root : "", root && clipId ? clipId : "", t, { intensity: galleryIntensity }).then(result => { if (active) { renderedFor.current = inputs; setImages(result); } })
        .catch(() => { if (active) { setImages([]); setError("Couldn't load looks. Check that the footage is connected."); } })
        .finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [root, clipId, t, galleryIntensity, retry, suppliedImages, Boolean(livePreview), pageActive]);
  useEffect(() => { if (images.length) onNames?.(Object.fromEntries(images.map(image => [image.id, image.name]))); }, [images, onNames]);
  async function choose(preset: string, amount = intensity, keepWords = false) {
    if (disabled || (mode === "commit" && choosing.current)) return;
    choosing.current = true; setError(null);
    try {
      if (!await onChoose({ ...value, preset, intensity: amount, words: keepWords ? value.words : null }, !keepWords)) { setIntensity(committed.current); setError("Couldn't apply that look. Try again."); }
      else committed.current = amount;
    } catch { setIntensity(committed.current); setError("Couldn't apply that look. Try again."); }
    finally { choosing.current = false; }
  }
  const previewsLoading = !suppliedImages && (loading || previewActivities.length > 0);
  const tiles: LookImage[] = images.length ? images : suppliedImages ? EDIT_LOOKS.map(look => ({ ...look, image: "" })) : previewsLoading ? Array.from({ length: 5 }, (_, index) => ({ id: `loading-${index}`, name: "", description: "Loading preview", image: "" })) : [];
  if (livePreview) return <LiveLookStrip {...livePreview} root={root!} value={value} disabled={disabled} onChoose={onChoose} onRelease={onRelease} onNames={onNames} />;
  return <div className="space-y-2">
    {previewsLoading && <p role="status" className="text-micro text-muted">Loading looks on your frame…</p>}
    <div role="group" aria-label="Look families" className="flex flex-wrap gap-1">{["All", "Film", "Warm", "Cool", "Soft", "Mono", "Clean"].map(name => <Tile key={name} type="button" aria-pressed={family === name} onClick={() => { setFamily(name); if (name !== "All") document.getElementById(`look-family-${name}`)?.scrollIntoView({ block: "nearest" }); }} className={`rounded-full px-2.5 py-1 text-micro ${family === name ? "bg-ink text-ground" : "bg-ink/[0.05] text-muted"} ${FOCUS}`}>{name}</Tile>)}</div>
    <div role="group" aria-label="Look gallery" className="space-y-4">
      {["Film", "Warm", "Cool", "Soft", "Mono", "Clean"].map(name => <section key={name} id={`look-family-${name}`} aria-label={`${name} looks`}><SectionHeader as="h4" className="mb-2 text-micro font-medium text-muted">{name}</SectionHeader><div className="grid grid-cols-3 gap-2">{tiles.filter(image => (image.family ?? "Clean") === name).map(image => <Tile key={image.id} type="button" aria-pressed={value.preset === image.id} disabled={disabled || previewsLoading} aria-busy={previewsLoading} title={image.description}
        onClick={() => void choose(image.id)} className={`min-w-0 rounded-lg text-left outline-none focus-visible:bg-ink/[0.05] disabled:cursor-default`}>
        <span className={`relative block aspect-[4/3] overflow-hidden rounded-lg bg-ink/[0.05]`}>
          {image.image ? <img src={image.image} width={160} height={160} alt={image.description} className={`h-full w-full object-cover ${previewsLoading ? "opacity-50" : ""}`} /> : null}
          {previewsLoading ? <ActivityShimmer /> : null}
          {value.preset === image.id ? <span aria-hidden="true" className="absolute bottom-1.5 left-1/2 h-1 w-4 -translate-x-1/2 rounded-full bg-accent" /> : null}
        </span>
        <span className={`mt-1 block text-micro ${value.preset === image.id ? "font-semibold text-ink" : "text-muted"}`}>{image.name}</span>
      </Tile>)}</div></section>)}
    </div>
    {!suppliedImages && (!root || !clipId) ? <p className="text-small text-muted">Add a shoot to see the looks on your footage.</p> : null}
    <Slider label="Look intensity" min={0} max={1} step={.01} defaultValue={.7} value={intensity} disabled={disabled}
      onChange={amount => { setIntensity(amount); if (mode === "stage") void choose(value.preset, amount, true); }}
      onRelease={amount => { if (mode === "stage") onRelease?.({ ...value, intensity: amount }); else if (amount !== committed.current) void choose(value.preset, amount, true); }} />
    {error && <InlineError className="text-micro text-danger">{error} <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>Retry</button></InlineError>}
  </div>;
}


const ACCORDION_KEY = "precut.look.accordions";
const GRAIN_NAMES: Record<GrainPreset, string> = { "35mm-fine": "35mm fine", "35mm-classic": "35mm classic", "16mm": "16mm", super8: "Super 8", trix: "Tri-X", digital: "Digital" };
const BASIC_SECTIONS: { name: string; sliders: [keyof BasicAdjust, string][] }[] = [
  { name: "White balance", sliders: [["temperature", "Temp"], ["tint", "Tint"]] },
  { name: "Tone", sliders: [["exposure", "Exposure"], ["contrast", "Contrast"], ["highlights", "Highlights"], ["shadows", "Shadows"], ["whites", "Whites"], ["blacks", "Blacks"]] },
  { name: "Presence", sliders: [["vibrance", "Vibrance"], ["saturation", "Saturation"]] },
];
function readAccordions(): Record<string, boolean> {
  try { return { Basic: true, ...JSON.parse(localStorage.getItem(ACCORDION_KEY) ?? "{}") }; } catch { return { Basic: true }; }
}
type PanelGrade = Grade & Pick<PieceLook, "diffusion">;
function gradeFor(version: CutVersion, piece: number | undefined): PanelGrade {
  return { input: "unknown", exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, look: null, ...version.grade, ...(piece === undefined ? {} : { mixer: version.pieceFx?.[piece]?.look?.mixer, ...version.pieceFx?.[piece]?.look, basic: normalizeBasic(balancedLook(version,version.pieces?.[piece]?.clipId ?? "",piece)?.basic) }), preset: (piece === undefined ? null : version.pieceFx?.[piece]?.look?.preset) ?? version.grade?.preset ?? "clean" };
}

/** One sheet for the edit grade and the selected clip's optional override. */
export function LookPanel({ shoot, root, cutId, version, timeline, selectedPieces, selectedPiece, scope, disabled, onFinish, onEdit, onLiveLook, onTexture, onPreviewPiece, seek, playing = false }: {
  shoot?: {clips: import("../../../../shared/schema").Clip[]};
  root: string; cutId?: string; version: CutVersion; timeline?: DraftTimeline | null; selectedPieces?: number[]; selectedPiece?: number | null; scope: "edit" | "clip"; disabled: boolean;
  onFinish: (options: { filmFade?: number; preset?: string; intensity?: number; basic?: BasicAdjust; mixer?: Grade["mixer"]; matchClips?: boolean; matchRef?: number | null; detail?: DetailChoice | null; grain?: GrainChoice | null; vignette?: VignetteChoice | null }) => Promise<boolean>;
  onEdit?: (edit: CutEdit) => void | Promise<unknown>;
  onLiveLook?: (look: LiveLook) => void; onTexture?: (texture: Pick<Grade, "detail" | "grain" | "vignette">) => void;
  onPreviewPiece?: (piece: number | undefined) => void; seek?: (time: number) => void; playing?: boolean;
}) {
  // A one-clip edit has one source correction in either scope. Saving a global
  // Basic offset here would add it on top of the correction shown on the sliders.
  const piece = scope === "clip" && selectedPiece != null ? selectedPiece : version.pieces?.length === 1 ? 0 : undefined;
  const targets=piece===undefined ? [] : scope === "clip" && selectedPieces?.length ? selectedPieces : [piece];
  const clipPatch=useRef<Record<string,unknown>>({});
  const mixed=(read:(g:PanelGrade)=>unknown)=>targets.length>1 && targets.some(p=>JSON.stringify(read(gradeFor(version,p)))!==JSON.stringify(read(gradeFor(version,targets[0]))));
  const balance=useBalance(root,cutId,version.version);
  const autoUndo=useAutoCorrectUndo(root,cutId,version);  // VO7-3: only while Auto correct is the current undo step
  const balanceActions=useRef(new Set<string>());
  const [replaceHand,setReplaceHand]=useState(false),[handTouched,setHandTouched]=useState(false);
  const [unchangedAuto, setUnchangedAuto] = useState<number | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const clipId=piece===undefined ? undefined : version.pieces?.[piece]?.clipId;
  useEffect(()=>{setHandTouched(false);setReplaceHand(false);setUnchangedAuto(null);},[root,cutId,piece,version.version]);
  const [grade, setGrade] = useState(() => gradeFor(version, piece));
  const clipLookRef = useRef<PieceLook>({ ...(piece === undefined ? {} : balancedLook(version,version.pieces?.[piece]?.clipId ?? "",piece)) });
  const gradeRef = useRef(grade); gradeRef.current = grade;
  const [texture, setTexture] = useState<Pick<Grade, "detail" | "grain" | "vignette">>(() => ({ detail: version.grade?.detail, grain: version.grade?.grain, vignette: version.grade?.vignette }));
  const textureRef = useRef(texture); textureRef.current = texture;
  const [images, setImages] = useState<LookImage[]>(cachedSampleLooks);
  const [isPlaying, setIsPlaying] = useState(playing);
  useEffect(() => { const read = (event: Event) => setIsPlaying(!!(event as CustomEvent).detail); window.addEventListener("sidething:playing", read); window.dispatchEvent(new CustomEvent("sidething:playing-request")); return () => window.removeEventListener("sidething:playing", read); }, []);
  const [open, setOpen] = useState(readAccordions), [clipping, setClipping] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [working, setWorking] = useState(false), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const savingCount = useRef(0), matchPending = useRef(false), scopeKey = useRef("");
  const writing = useRef(false), autoPending = useRef(false), generation = useRef(0), previewTimer = useRef<ReturnType<typeof setTimeout>>();
  const request = useRef(0), baseline = useRef(grade), committed = useRef(JSON.stringify(grade));
  const textureCommitted = useRef(JSON.stringify(texture));
  const queuedGrade = useRef(JSON.stringify(grade)), queuedTexture = useRef(JSON.stringify(texture));
  const reduced = useReducedMotion();
  useEffect(() => {
    let active = true;
    setError(null);
    const off = loadSampleLooks(result => { if (active) setImages(result); }, () => { if (active) setError("Couldn't load some look previews. Try again."); });
    return () => { active = false; off(); };
  }, [retry]);
  useEffect(() => {
    const key = JSON.stringify([root, cutId, piece, targets]);
    const retain = scopeKey.current === key && (writing.current || JSON.stringify(gradeRef.current) !== committed.current || JSON.stringify(textureRef.current) !== textureCommitted.current);
    scopeKey.current = key;
    baseline.current = gradeFor(version, piece);
    if (retain) return;
    clipPatch.current={}; autoPending.current = false; setMeasuring(false); setWorking(writing.current);
    clipLookRef.current = { ...(piece === undefined ? {} : balancedLook(version,version.pieces?.[piece]?.clipId ?? "",piece)) };
    const next = gradeFor(version, piece); gradeRef.current = next; baseline.current = next; committed.current = JSON.stringify(next); queuedGrade.current = committed.current; setGrade(next);
    const nextTexture = { detail: version.grade?.detail, grain: version.grade?.grain, vignette: version.grade?.vignette };
    textureRef.current = nextTexture; textureCommitted.current = JSON.stringify(nextTexture); queuedTexture.current = textureCommitted.current; setTexture(nextTexture);
    onTexture?.(nextTexture); onPreviewPiece?.(piece); setClipping(false); setError(null);
    return () => { generation.current++; request.current++; clearTimeout(previewTimer.current); };
  }, [root, cutId, version.version, piece, targets.join()]);
  const uniformTimeline = !!getApi().liveGrade && !!timeline?.pieces.length && timeline.pieces.every(p => p.lut.startsWith("piece:"));
  const latestTimeline = useRef(timeline); latestTimeline.current = timeline;
  useEffect(() => { const clearMask = () => window.dispatchEvent(new CustomEvent("sidething:detail-mask", { detail: false })); window.addEventListener("blur", clearMask); window.addEventListener("keyup", clearMask); return () => { window.removeEventListener("blur", clearMask); window.removeEventListener("keyup", clearMask); clearMask(); }; }, []);
  useEffect(() => () => { const saved = latestTimeline.current; if (saved) { setGradePreview(saved); setBasicPreview(saved, normalizeBasic(), normalizeBasic()); onLiveLook?.(saved.pieces.map(p => p.lut)); } onPreviewPiece?.(undefined); onTexture?.({ detail: undefined, grain: undefined, vignette: undefined }); }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("sidething:clipping", { detail: clipping && !isPlaying }));
    return () => { window.dispatchEvent(new CustomEvent("sidething:clipping", { detail: false })); };
  }, [clipping, isPlaying]);
  useShortcuts("precuts", [{ id: "clipping-preview", keys: ["j"], label: "Toggle clipping preview in Look", scope: "precuts", enabled: !isPlaying, handler: () => setClipping(value => !value) }]);
  function toggle(name: string) {
    const next = { ...open, [name]: !open[name] }; setOpen(next);
    try { localStorage.setItem(ACCORDION_KEY, JSON.stringify(next)); } catch { /* Preferences are optional when storage is unavailable. */ }
  }
  function effectiveBasic(basic: BasicAdjust | undefined) {
    if (piece === undefined) return normalizeBasic(basic);
    const edit = normalizeBasic(version.grade?.basic), delta = normalizeBasic(basic);
    return normalizeBasic(Object.fromEntries(Object.keys(edit).map(key => [key, edit[key as keyof BasicAdjust] + delta[key as keyof BasicAdjust]])));
  }
  // LK1: hovering a tile puts its look on the stage in the next frame; leaving the gallery puts the chosen look back;
  // clicking keeps it. Looks use the colour known now (never waiting for a measurement, never starting one) and each
  // shown tile's look is prepared in the background. When measured colour lands the timeline changes and they follow.
  const prepared = useRef<{ basis: string; looks: Map<string, string[]>; pending: Map<string, Promise<string[]>> }>({ basis: "", looks: new Map(), pending: new Map() });
  const hovered = useRef<string | null>(null), chosenLook = useRef<string[] | null>(null), chosenFor = useRef<string | null>(null);
  const shownLooks = useRef<string[]>([]), [shownKey, setShownKey] = useState("");
  const [picked, setPicked] = useState<string | null>(null), pickedRef = useRef(picked); pickedRef.current = picked;
  // Defaults as a save writes them, so the version a pick saves reads as the same chosen look.
  const chosenKey = (g: Grade) => JSON.stringify([g.filmFade ?? 0, piece ?? null, g.preset ?? "clean", g.intensity ?? .7, normalizeBasic(g.basic), normalizeMixer(g.mixer), g.matchClips ?? true, g.matchRef ?? null]);
  const lookBasis = (g: Grade) => JSON.stringify([version.version, piece ?? null, timeline?.pieces.map(p => p.lut) ?? null, g.matchClips ?? null, g.matchRef ?? null]);
  const withPreset = (preset: string): Grade => ({ ...gradeRef.current, preset: preset as LookPreset, look: null });
  function preparedLook(g: Grade): string[] | undefined {
    return prepared.current.basis === lookBasis(g) ? prepared.current.looks.get(g.preset ?? "clean") : undefined;
  }
  function lookIds(g: Grade): Promise<string[]> {
    if (!cutId) return Promise.reject(new Error("No edit"));
    const basis = lookBasis(g), preset = g.preset ?? "clean";
    if (prepared.current.basis !== basis) prepared.current = { basis, looks: new Map(), pending: new Map() };
    const state = prepared.current, ready = state.looks.get(preset);
    if (ready) return Promise.resolve(ready);
    let pending = state.pending.get(preset);
    if (!pending) {
      const choice = { ...g, preset: preset as LookPreset, intensity: g.intensity ?? .7, basic: normalizeBasic(g.basic), now: true,
        ...(piece === undefined ? {} : { previewPiece: piece, previewLook: { preset: g.preset, intensity: g.intensity, basic: g.basic, mixer: g.mixer } }) } as Parameters<Api["pieceLuts"]>[3];
      pending = getApi().pieceLuts(root, cutId, version.version, choice).then(async ids => {
        await Promise.all(ids.map(id => cachedLiveLut(id)));
        state.looks.set(preset, ids); return ids;
      }).finally(() => state.pending.delete(preset));
      state.pending.set(preset, pending);
    }
    return pending;
  }
  function show(ids: string[], basic: BasicAdjust | undefined, inputAt: number) {
    if (!lookBasics.has(ids)) lookBasics.set(ids, effectiveBasic(basic));
    lookInputTimes.set(ids, inputAt); onLiveLook?.(ids);
  }
  function hoverLook(preset: string | null) {
    const inputAt = performance.now(); hovered.current = preset;
    if (!timeline || !cutId) return;
    if (uniformTimeline) { preview(preset === null ? gradeRef.current : withPreset(preset)); return; }
    if (preset === null) {
      preview(gradeRef.current);
      const pick = pickedRef.current ? preparedLook(withPreset(pickedRef.current)) : undefined;
      show(pick ?? chosenLook.current ?? timeline.pieces.map(p => p.lut), baseline.current.basic, inputAt); return;
    }
    const g = withPreset(preset), ready = preparedLook(g);
    preview(g);
    if (ready) { show(ready, g.basic, inputAt); return; }
    void lookIds(g).then(ids => { if (hovered.current === preset) show(ids, g.basic, inputAt); }).catch(() => {});
  }
  // A click while a save is in flight is kept and saved right after it.
  function pick(preset: string) {
    hovered.current = preset;
    if (disabled) return;
    setPicked(null); change({ preset: preset as LookPreset, look: null }, true);
  }
  useEffect(() => {
    if (!picked || disabled || working) return;
    setPicked(null);
    if (picked !== gradeRef.current.preset) change({ preset: picked as LookPreset, look: null }, true);
  }, [picked, disabled, working]);
  useEffect(() => {
    if (!cutId || !timeline || uniformTimeline) return;
    let alive = true;
    const g = gradeRef.current, key = chosenKey(g);
    // Another chosen look (undo, another clip): the stage's own colour is the chosen one until we pick again.
    if (chosenFor.current !== key) { chosenLook.current = null; chosenFor.current = key; }
    const refresh = chosenLook.current !== null;
    void (async () => {
      const over = hovered.current;
      if (over) { const hg = withPreset(over), ids = await lookIds(hg).catch(() => null); if (alive && ids && hovered.current === over) show(ids, hg.basic, performance.now()); }
      if (refresh) {
        const ids = await lookIds(g).catch(() => null);
        if (alive && ids && chosenFor.current === key) { chosenLook.current = ids; lookBasics.set(ids, effectiveBasic(g.basic)); if (!hovered.current) onLiveLook?.(ids); }
      }
      for (const preset of shownLooks.current) { if (!alive) return; await lookIds(withPreset(preset)).catch(() => null); }
    })();
    return () => { alive = false; };
  }, [cutId, timeline, version.version, piece, shownKey]);
  function preview(next: Grade, exact = false) {
    const id = ++request.current, inputAt = performance.now(); clearTimeout(previewTimer.current);
    if (timeline) {
      setBasicPreview(timeline, effectiveBasic(next.basic), effectiveBasic(baseline.current.basic), inputAt);
      setGradePreview(timeline, piece === undefined ? next : gradeFor(version,undefined), piece, piece === undefined ? undefined : {...clipLookRef.current,preset:next.preset,intensity:next.intensity,basic:next.basic,mixer:next.mixer,filmFade:next.filmFade}, inputAt, targets.length>1 ? Object.fromEntries(targets.map(p=>[p,mergePatch(balancedLook(version,version.pieces?.[p]?.clipId ?? "",p) ?? {},{...clipPatch.current,...(next.preset!==gradeRef.current.preset ? {preset:next.preset} : {})})])) : undefined);
    }
    onPreviewPiece?.(piece);
    // A basic, mixer or intensity release only saves; it never builds or reloads colour.
    // Match changes still need the measured basis, and presets warm their one cached atlas.
    if (uniformTimeline && next.matchClips === baseline.current.matchClips && next.matchRef === baseline.current.matchRef) return;
    if (!exact || next.preset === baseline.current.preset && next.matchClips === baseline.current.matchClips && next.matchRef === baseline.current.matchRef) return;
    void (async () => {
      if (!cutId) return;
      try {
        const ids = preparedLook(next) ?? await lookIds(next);
        if (id !== request.current) return;
        chosenLook.current = ids; chosenFor.current = chosenKey(next); lookBasics.set(ids,effectiveBasic(next.basic));
        if (hovered.current === null || hovered.current === next.preset) { lookInputTimes.set(ids,inputAt); onLiveLook?.(ids); }
      } catch { if (id === request.current) setError("Couldn't preview this look. Try again."); }
    })();
  }
  useEffect(() => { if (timeline) preview(gradeRef.current); }, [timeline]);
  // Only the release path writes a version. Pointer motion and tile hover only preview.
  async function commit(next: Grade) {
    if (disabled || targets.length<2 && JSON.stringify(next) === (writing.current ? queuedGrade.current : committed.current)) return;
    queuedGrade.current = JSON.stringify(next);
    const epoch = generation.current, savingScope = scopeKey.current; savingCount.current++; writing.current = true; setWorking(true); setError(null);
    try {
      let ok = true;
      if (piece !== undefined) {
        if (!onEdit) throw new Error("Select an editable clip to change its look.");
        const look = { ...clipLookRef.current };
        const result = await onEdit(targets.length>1 ? selectionBatch(targets,`Look on ${targets.length} clips`,p=>({kind:'pieceFx',piece:p,fx:{...version.pieceFx?.[p],look:mergePatch(balancedLook(version,version.pieces?.[p]?.clipId ?? '',p),clipPatch.current)}})) : { kind: "pieceFx", piece, fx: { ...version.pieceFx?.[piece], look } });
        if (result === false || result === undefined) ok = false;
      } else ok = await onFinish({ filmFade: next.filmFade, preset: next.preset, intensity: next.intensity ?? .7, basic: normalizeBasic(next.basic), mixer: normalizeMixer(next.mixer), matchClips: next.matchClips ?? true, matchRef: next.matchRef ?? null });
      if (!ok) throw new Error("Couldn't apply this look. Your changes are still here.");
      if (savingScope === scopeKey.current) committed.current = JSON.stringify(next);
    } catch (error) { if (epoch === generation.current) setError(error instanceof Error ? error.message : "Couldn't apply this look."); }
    finally { writing.current = --savingCount.current > 0; setWorking(writing.current); }
  }
  function change(patch: Partial<PanelGrade>, release = false, basicKey?:keyof BasicAdjust) {
    if (disabled) return;
    window.dispatchEvent(new Event("precut:look-adjust"));
    if(piece!==undefined) {
      targets.forEach(p=>ownBalance(root,version.pieces?.[p]?.clipId));if(!handTouched)setHandTouched(true);
      const touched=basicKey ? {basic:{[basicKey]:patch.basic?.[basicKey]}} : {...patch,...(patch.basic ? {basic:changedPatch(gradeRef.current.basic,patch.basic)} : {}),...(patch.mixer ? {mixer:changedPatch(gradeRef.current.mixer,patch.mixer)} : {})};
      delete (touched as Partial<PanelGrade>).look;
      clipPatch.current=mergePatch(clipPatch.current,touched);
    }
    generation.current++; autoPending.current = false;
    if (piece !== undefined) for (const key of ["preset", "intensity", "basic", "mixer", "filmFade", "diffusion"] as const) if (key in patch) Object.assign(clipLookRef.current, { [key]: patch[key] });
    const next = { ...gradeRef.current, ...patch }; gradeRef.current = next; setGrade(next); preview(next, release);
    if (release) void commit(next);
  }
  async function auto(reference?:number,replace=false,keepHand=false) {
    if(!cutId || disabled)return;
    const autoPiece = scope === "clip" ? piece : undefined;
    if(autoPiece===undefined && balance.hand && !balance.ready.length && !replace && !keepHand && reference===undefined){setReplaceHand(true);return;}
    const action=JSON.stringify([cutId,piece,reference,replace]);if(balanceActions.current.has(action))return;balanceActions.current.add(action);
    const owned=reference ?? autoPiece;if(owned!==undefined)ownBalance(root,version.pieces?.[owned]?.clipId);
    setReplaceHand(false);setError(null);setAutoError(null);setUnchangedAuto(null);
    const autoScope = scopeKey.current;
    try {
      const result = await autoCorrect(root,cutId,version.version,{...(reference===undefined ? autoPiece===undefined ? {} : targets.length>1 ? {pieces:targets} : {piece:autoPiece} : {reference}),replaceHand:replace,readyOnly:autoPiece===undefined && reference===undefined && balance.ready.length>0});
      if (reference === undefined && result.version === version.version && autoScope === scopeKey.current) setUnchangedAuto(result.version);
    }
    catch(error){setAutoError(error instanceof Error ? error.message : "Couldn't auto correct. Try again.");}
    finally{balanceActions.current.delete(action);}
  }
  async function match() { if(piece!==undefined)await auto(piece); }
  async function resetClip() {
    if (piece === undefined || !onEdit || disabled) return;
    window.dispatchEvent(new Event("precut:look-adjust"));
    const epoch = ++generation.current, savingScope = scopeKey.current;
    const fx = { ...version.pieceFx?.[piece] }; delete fx.look;
    const balance=clipId ? version.balances?.[clipId] : undefined;
    if(balance){fx.look={basic:normalizeBasic()};ownBalance(root,clipId);setHandTouched(true);}
    clipLookRef.current = fx.look ?? {};
    const next = gradeFor({ ...version, ...(balance && clipId ? {balances:{...version.balances,[clipId]:{...balance,basic:normalizeBasic(),owner:"hand"}}} : {}), pieceFx: version.pieceFx?.map((old, index) => index === piece ? fx : old) }, piece);
    gradeRef.current = next; setGrade(next); preview(next, true); queuedGrade.current = JSON.stringify(next);
    savingCount.current++; writing.current = true; setWorking(true); setError(null);
    try {
      const result = await onEdit(targets.length>1 ? selectionBatch(targets,`Reset ${targets.length} clip looks`,p=>{const next={...version.pieceFx?.[p]};delete next.look;if(version.balances?.[version.pieces?.[p]?.clipId ?? ""]){next.look={basic:normalizeBasic()};ownBalance(root,version.pieces?.[p]?.clipId);}return {kind:'pieceFx',piece:p,fx:next};}) : { kind: "pieceFx", piece, fx: Object.keys(fx).length ? fx : null });
      if (result === false || result === undefined) throw new Error("Couldn't reset this clip. Try again.");
      if (savingScope === scopeKey.current) committed.current = JSON.stringify(next);
    } catch (error) { if (epoch === generation.current) setError(error instanceof Error ? error.message : "Couldn't reset this clip."); }
    finally { writing.current = --savingCount.current > 0; setWorking(writing.current); }
  }
  function changeTexture(patch: Pick<Grade, "detail" | "grain" | "vignette">, release = false) {
    if (disabled) return;
    window.dispatchEvent(new Event("precut:look-adjust"));
    const next = { ...textureRef.current, ...patch }; textureRef.current = next; setTexture(next); onTexture?.(next);
    if (!release || disabled || JSON.stringify(next) === (writing.current ? queuedTexture.current : textureCommitted.current)) return;
    queuedTexture.current = JSON.stringify(next);
    savingCount.current++; writing.current = true; setWorking(true); setError(null);
    void onFinish(patch).then(ok => { if (!ok) throw new Error("Couldn't apply the texture. Your changes are still here."); textureCommitted.current = JSON.stringify(next); })
      .catch(error => setError(error instanceof Error ? error.message : "Couldn't apply the texture."))
      .finally(() => { writing.current = --savingCount.current > 0; setWorking(writing.current); });
  }
  const detail = texture.detail ?? NO_DETAIL;
  const basic = normalizeBasic(grade.basic), grain = texture.grain ?? { ...GRAIN_PRESETS["35mm-fine"], amount: 0 }, vignette = texture.vignette ?? { amount: 0, midpoint: 50, feather: 70 };
  const correctedCount = Number(/^Auto correct (\d+) clips?$/.exec(version.feedback ?? "")?.[1] ?? 0);
  const correctedHere = targets.length ? targets.filter(p => version.balances?.[version.pieces?.[p]?.clipId ?? ""]?.owner === "auto") : [];
  const correctionRows = piece === undefined ? Object.values(version.balances ?? {}).filter(row => row.owner === "auto") : correctedHere.map(p => version.balances![version.pieces![p].clipId!]);
  const savedCorrection = correctedCount > 0 && autoUndo.show;
  const showCorrection = balance.state === "idle" && !handTouched && correctionRows.length > 0 && (savedCorrection || unchangedAuto === version.version);
  // Below one ordinary slider step on every measured Basic control.
  const smallCorrection = correctionRows.length > 0 && correctionRows.every(row =>
    Object.entries(normalizeBasic(row.basic)).every(([key, value]) => Math.abs(value) < (key === "exposure" ? .05 : 1)));
  const shownCount = piece === undefined ? correctedCount : correctedHere.length;
  const correctionMessage = showCorrection ? smallCorrection ? "Already looks right" : !savedCorrection ? "Already corrected" : targets.length === 1 ? `Corrected ${pieceName(shoot ?? {clips:[]},version,piece!)}` : `Corrected ${shownCount} ${shownCount === 1 ? "clip" : "clips"}` : null;
  const locked = disabled;
  const rendering = useActivity({ root, kind: ["finish", "render", "titles"], state: "running", target: { cutId } });
  const render = rendering.find(task => task.kind === "render") ?? rendering.find(task => task.label !== "Saving your look");
  const eta = render ? activityEta(render.etaS) : null;
  const accordion = (name: string, body: React.ReactNode, wholeEdit = false) => LookAccordion({ name, body, open: !!open[name], onToggle: () => toggle(name), id: `look-${name}`, wholeEdit: wholeEdit && piece !== undefined, reduced });
  return <div className="look-panel" aria-label="Look controls">
    {mixed(g=>g.preset) ? <p className="text-micro text-muted">Look: Mixed</p> : null}
    <p role="status" className="min-h-4 text-micro text-muted">{render && (measuring || matchPending.current) ? `Applies when this render finishes${eta ? ` · ${eta} left` : ""}` : render ? eta ? `Rendering, ${eta} left` : "Rendering in the background" : working ? "Saving your look" : null}</p>
    <LookGallery mixedIntensity={mixed(g=>g.intensity ?? .7)} images={images} value={{ preset: mixed(g=>g.preset) ? "" : picked ?? grade.preset ?? "clean", intensity: grade.intensity }} disabled={locked} tilesDisabled={false} error={error} onChoose={pick} onPreview={hoverLook} onShown={presets => { shownLooks.current = presets; setShownKey(presets.join()); }} onIntensity={(amount, release) => change({ intensity: amount }, release)} />
    <div className="flex min-h-5 flex-wrap items-center gap-2">{piece!==undefined && !handTouched && version.balances?.[clipId ?? ""]?.owner==="auto" ? <span className="rounded-full bg-ground px-2 py-0.5 text-micro">Auto</span> : null}{piece!==undefined && version.balanceReference===clipId ? <span className="rounded-full bg-ground px-2 py-0.5 text-micro">Reference</span> : null}</div>
    <div className="space-y-1">
      <Slider mixed={mixed(g=>g.filmFade ?? 0)} label="Fade" tip={CONTROL_TIPS.fade} min={0} max={100} defaultValue={0} value={grade.filmFade ?? 0} disabled={locked} onChange={filmFade => change({ filmFade })} onRelease={filmFade => change({ filmFade }, true)} />
      <Slider mixed={mixed(g=>g.diffusion ?? g.detail?.diffusion ?? 0)} label="Diffusion" tip={CONTROL_TIPS.diffusion} aria-label="Detail diffusion" min={0} max={100} defaultValue={0} value={piece === undefined ? detail.diffusion : grade.diffusion ?? detail.diffusion} disabled={locked} onChange={diffusion => piece === undefined ? changeTexture({ detail: { ...detail, diffusion } }) : change({ diffusion })} onRelease={diffusion => piece === undefined ? changeTexture({ detail: { ...detail, diffusion } }, true) : change({ diffusion }, true)} />
    </div>
    <div>
      {accordion("Basic", <>
        <div data-control="histogram" className="look-histogram min-h-24"><Histogram clipping={clipping && !isPlaying} onClipping={() => { if (!isPlaying) setClipping(value => !value); }} /></div>
        <div className="flex flex-wrap items-center gap-2"><Button type="button" disabled={locked || !cutId} onClick={() => void auto()}><Wand size={16} />{scope==="edit" ? balance.ready.length ? `Auto correct ${balance.ready.length} clips` : "Auto correct" : "Auto"}</Button><InfoTip label="Auto correct">{piece === undefined ? CONTROL_TIPS.correct : CONTROL_TIPS.correctClip}</InfoTip><span data-auto-feedback role="status" className="text-micro text-muted">{correctionMessage}{showCorrection && savedCorrection ? <> · <button type="button" onClick={autoUndo.undo} className={`underline ${FOCUS}`}>Undo</button></> : null}</span>{scope==="clip" && piece!==undefined && targets.length===1 ? <div className="w-full"><Button type="button" disabled={locked} title="Auto correct the other clips to sit with this one" onClick={() => void match()}><Link size={16} />Match others to this clip</Button></div> : null}</div>
        {autoError || balance.message || balance.state==="working" ? <p role="status" data-auto-status className={`text-micro ${autoError ? "text-danger" : "text-muted"}`}>{autoError ?? (balance.state==="working" ? balance.message ?? "Correcting clips" : balance.message)}{!autoError && balance.state==="working" && balance.etaS ? ` · ${activityEta(balance.etaS)}` : null}</p> : null}
        {replaceHand ? <p data-auto-replace className="text-micro text-muted">Includes {balance.hand} clips you set by hand · Replace them? <button type="button" className={`underline ${FOCUS}`} onClick={()=>void auto(undefined,true)}>Replace</button> · <button type="button" className={`underline ${FOCUS}`} onClick={()=>void auto(undefined,false,true)}>Keep mine</button></p> : null}
        {BASIC_SECTIONS.map(section => <div key={section.name} className="space-y-1"><p className="text-micro text-muted">{section.name}</p>{section.sliders.map(([key, label]) => <Slider key={key} mixed={mixed(g=>normalizeBasic(g.basic)[key])} data-control={`adjust-${key}`} label={label} min={BASIC_BOUNDS[key][0]} max={BASIC_BOUNDS[key][1]} step={key === "exposure" ? .05 : 1} defaultValue={0} value={basic[key]} disabled={locked} onChange={amount => change({ basic: { ...normalizeBasic(gradeRef.current.basic), [key]: amount } }, false, key)} onRelease={amount => change({ basic: { ...normalizeBasic(gradeRef.current.basic), [key]: amount } }, true, key)} />)}</div>)}
      </>)}
      {accordion("Colour", <fieldset disabled={locked}><ColourPanel isMixed={(colour,key)=>mixed(g=>g.mixer?.[colour]?.[key] ?? 0)} value={grade.mixer} onChange={mixer => change({ mixer })} onRelease={mixer => change({ mixer }, true)} preserveZero={piece !== undefined} compact /></fieldset>)}
      {accordion("Detail", <>
        <p className="text-micro text-muted">Sharpening</p>
        {(Object.keys(DEFAULT_DETAIL) as (keyof DetailChoice)[]).every(key => texture.detail?.[key] === DEFAULT_DETAIL[key]) ? <p className="text-micro text-muted">{DETAIL_REASON}</p> : null}
        {(["amount", "texture", "clarity", "radius", "detail", "masking"] as (keyof DetailChoice)[]).map(key => <div key={key} onPointerDown={event => { if (key === "masking" && event.altKey) window.dispatchEvent(new CustomEvent("sidething:detail-mask", { detail: true })); }} onPointerMove={event => { if (key === "masking" && event.buttons) window.dispatchEvent(new CustomEvent("sidething:detail-mask", { detail: event.altKey })); }} onPointerUp={() => window.dispatchEvent(new CustomEvent("sidething:detail-mask", { detail: false }))} onPointerCancel={() => window.dispatchEvent(new CustomEvent("sidething:detail-mask", { detail: false }))}>
          <Slider label={key === "amount" ? "Sharpening" : key[0].toUpperCase() + key.slice(1)} aria-label={`Detail ${key}`} min={DETAIL_BOUNDS[key][0]} max={DETAIL_BOUNDS[key][1]} step={key === "radius" ? .1 : 1} defaultValue={NO_DETAIL[key]} value={detail[key]} disabled={locked} onChange={amount => changeTexture({ detail: { ...detail, [key]: amount } })} onRelease={amount => changeTexture({ detail: { ...detail, [key]: amount } }, true)} />
          {key === "texture" ? <p className="text-micro text-muted">Left softens fine detail</p> : key === "clarity" ? <p className="text-micro text-muted">Left softens midtone contrast</p> : null}
          {key === "masking" ? <p className="text-micro text-muted">Hold Alt while dragging to see the mask</p> : null}
        </div>)}
        <Button type="button" disabled={locked || !texture.detail} onClick={() => changeTexture({ detail: null }, true)}>Remove detail</Button>
      </>, true)}
      {accordion("Grain", <>
        <div role="group" aria-label="Grain presets" className="flex flex-wrap gap-1">{(Object.keys(GRAIN_NAMES) as GrainPreset[]).map(preset => <Tile key={preset} type="button" disabled={locked} aria-pressed={grain.amount > 0 && grain.preset === preset} onClick={() => changeTexture({ grain: { ...GRAIN_PRESETS[preset] } }, true)} className={`look-chip ${FOCUS}`}>{GRAIN_NAMES[preset]}</Tile>)}</div>
        {(["amount", "size", "roughness", "colour", "shadows", "highlights"] as const).map(key => <Slider key={key} label={key[0].toUpperCase() + key.slice(1)} aria-label={`Grain ${key}`} min={key === "shadows" || key === "highlights" ? -100 : 0} max={100} defaultValue={key === "amount" ? 0 : GRAIN_PRESETS[grain.preset][key]} value={grain[key]} disabled={locked} onChange={amount => changeTexture({ grain: { ...grain, [key]: amount } })} onRelease={amount => changeTexture({ grain: { ...grain, [key]: amount } }, true)} />)}
      </>, true)}
      {accordion("Vignette", <>{(["amount", "midpoint", "feather"] as const).map(key => <Slider key={key} label={key[0].toUpperCase() + key.slice(1)} aria-label={`Vignette ${key}`} min={key === "amount" ? -100 : 0} max={100} defaultValue={key === "amount" ? 0 : key === "midpoint" ? 50 : 70} value={vignette[key]} disabled={locked} onChange={amount => changeTexture({ vignette: { ...vignette, [key]: amount } })} onRelease={amount => changeTexture({ vignette: { ...vignette, [key]: amount } }, true)} />)}</>, true)}
    </div>
    {piece !== undefined && (version.pieceFx?.[piece]?.look || version.balances?.[clipId ?? ""]) ? <Button type="button" disabled={locked} onClick={() => void resetClip()}>{targets.length>1 ? "Reset these clips" : "Reset this clip"}</Button> : null}
    {error ? <InlineError>{error} <button type="button" onClick={() => setRetry(n => n + 1)} className={`underline ${FOCUS}`}>Retry previews</button></InlineError> : null}
  </div>;
}

/** The panel gallery and its intensity control, shared unchanged with defaults. */
export function LookGallery({ images, mixedIntensity = false, value, disabled, tilesDisabled = disabled, error, onChoose, onPreview, onShown, onIntensity }: {
  mixedIntensity?:boolean; images: LookImage[]; value: { preset: string; intensity?: number }; disabled?: boolean; error?: string | null;
  /** Tiles still preview and take a pick while the panel saves (the Look panel queues it); defaults to `disabled`. */
  tilesDisabled?: boolean;
  onChoose: (preset: string) => void; onPreview?: (preset: string | null) => void; onShown?: (presets: string[]) => void; onIntensity: (amount: number, release: boolean) => void;
}) {
  const [family, setFamily] = useState("All");
  const visible = EDIT_LOOKS.filter(image => family === "All" || image.family === family).slice(0, 9).map(look => images.find(image => image.id === look.id) ?? { ...look, image: "" });
  useEffect(() => { onShown?.(visible.map(look => look.id)); }, [family]);
  return <>
    <div role="group" aria-label="Look gallery" className="grid grid-cols-3 gap-2" onMouseLeave={() => onPreview?.(null)}>
      {visible.map(image => <Tile key={image.id} type="button" aria-label={image.name} aria-pressed={value.preset === image.id} title={image.description} disabled={tilesDisabled} onMouseEnter={() => onPreview?.(image.id)} onFocus={() => onPreview?.(image.id)} onBlur={() => onPreview?.(null)} onClick={() => onChoose(image.id)} className={`look-stock ${FOCUS} hover:[&_.look-stock-label]:bg-[var(--selection-fill)] focus-visible:[&_.look-stock-label]:bg-[var(--selection-fill)]`}>
        {image.image ? <img src={image.image} alt={image.description} /> : <span aria-label={`Loading ${image.name} preview`} className="block aspect-[4/3] bg-ink/[0.05]" />}<span className="look-stock-label">{image.name}<span>{image.family}</span></span>
      </Tile>)}
    </div>
    {!images.length && !error ? <p role="status" className="text-micro text-muted">Loading looks…</p> : null}
    <div role="group" aria-label="Look families" className="flex flex-wrap gap-1">{["All", "Film", "Warm", "Cool", "Soft", "Mono", "Clean"].map(name => <Tile key={name} type="button" aria-pressed={family === name} onClick={() => setFamily(name)} className={`look-chip ${FOCUS}`}>{name}</Tile>)}</div>
    <Slider mixed={mixedIntensity} label="Intensity" tip={CONTROL_TIPS.intensity} min={0} max={100} defaultValue={70} value={Math.round((value.intensity ?? .7) * 100)} disabled={disabled} onChange={amount => onIntensity(amount / 100, false)} onRelease={amount => onIntensity(amount / 100, true)} />
  </>;
}
/** One accordion row style for the edit panel and its saved defaults. */
export function LookAccordion({ name, body, open, onToggle, id, wholeEdit, reduced }: {
  name: string; body: React.ReactNode; open: boolean; onToggle: () => void; id: string; wholeEdit?: boolean; reduced?: boolean | null;
}) {
  return <section data-control={name === "Basic" ? "adjust" : name.toLowerCase()} className="look-accordion">
    <button type="button" className={`look-accordion-row ${FOCUS}`} aria-expanded={open} aria-controls={id} onClick={onToggle}><Look size={16} /><span className="flex-1">{name}</span>{wholeEdit ? <span className="text-micro text-muted">Whole edit</span> : null}<motion.span animate={{ rotate: open ? 90 : 0 }} transition={reduced ? instant : spring.press}><ChevronRight size={16} /></motion.span></button>
    {open ? <div id={id} className="look-accordion-body">{body}</div> : null}
  </section>;
}
export function DetailDefault({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  const [open, setOpen] = useState(true), reduced = useReducedMotion();
  return <LookAccordion name="Detail" id="default-look-detail" open={open} onToggle={() => setOpen(value => !value)} reduced={reduced} body={<><Row as="label"><span className="text-small">Light detail sharpening</span><Switch aria-label="Light detail sharpening" checked={checked} onChange={event => onChange(event.target.checked)} /></Row><p className="text-micro text-muted">{DETAIL_REASON}</p></>} />;
}
