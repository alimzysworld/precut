import { liveMusicSelection } from './finish/musicSelection';
import { LayoutPanel } from './finish/LayoutPanel';
import { previewLiveSound, liveSoundPreviews } from "./liveMix";
import { EmptyState } from "./ui";
import { GenerateSound } from "./finish/GenerateSound";
import { SearchField } from "./ui";
import { Tabs } from "./ui";
import { InlineError, Tile, SectionHeader, Row, Switch } from "./ui";
import { type InspectorActions } from "./finish/InspectorHeader";
import { FramingControls, MotionProgress, TransitionControls, LengthPanel, PacePanel } from "./finish/ToolPanels";
import { VideoTypeControl } from "./finish/VideoTypeControl";
import { INSPECTOR_TABS, TAB_CONTROLS, CONTROL_REGISTRY, panelForControl, searchInspector, markControlTargets, type InspectorTab, type ControlEntry } from "./finish/search";
import type { Cut, FramingChoice, JoinChoice } from "../../../shared/schema";
import { type EditsPanel, useShortcuts } from "../hooks/useShortcuts";
import { useEditHistory } from "../hooks/useEditHistory";

import { useOverlayEditor, selectOverlay } from "./OverlayHandles";
import { pieceLook } from "./finish/lookCache";
import { Histogram } from "./finish/Histogram";
import { AskPanel, type AskScreenContext } from "./finish/AskPanel";
import { AddMore, ClipPanel, ClipsPanel } from "./finish/ClipsPanel";
import type { StageHandle } from "./Stage";
import type { CutEdit, DraftTimeline } from "../../../shared/schema";
import { normalizeBasic } from "../../../main/basics";
import { Basics } from "./Basics";
import { ColourPanel, normalizeMixer, Segments } from "./finish/Controls";
import { type MusicChoice } from "./finish/MusicPanel";
import { SoundPanel, renderSoundControl } from "./finish/SoundPanel";
import { TransitionsPanel } from "./finish/TransitionsPanel";
import { CaptionSettings, CaptionLanguage, CaptionDesignNote } from "./finish/CaptionsPanel";
import { captionDesignOfNote, type CaptionDesign } from "../../../main/titles/design-notes";
import { transcriptPieces } from "./finish/TranscriptPanel";
import { ScriptPanel } from "./finish/ScriptPanel";
import type { VoiceoverController } from "./VoiceoverPanel";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DEFAULT_CAPTION_STYLE, buildCaptionTrack, followEmphasis, captionWordsForVersion, captionSafeArea, type CaptionSource, type CaptionTrack } from "../../../main/titles/captions";
import { cachedLiveLut, lookInputTimes, lookBasics, setBasicPreview } from "./LivePlayer";
import { BackHeader } from "./ui";
import type { AudioFinish, BasicAdjust, CaptionStyle, TitleTrack, Preferences, Api, CutVersion, Grade, Shoot, Skill, LookPreset, SkillFormat } from "../../../shared/schema";
import type { LiveLook } from "./LivePlayer";
import { getApi } from "../data";
import { usePageActive } from "../hooks/usePageActivity";
import { soundBlocks } from "./timeline/model";
import { storyboard } from "./edits/model";
import { Button, FOCUS, Slider } from "./ui";

export type FinishSkill = Skill & { type?: "video" | "titles"; look?: string; lookGrade?: Grade };
export type FinishOptions = NonNullable<Parameters<Api["finishCut"]>[3]> & { preset?: string; intensity?: number; captions?: CaptionStyle | null };
export { LookStrip, LiveLookStrip, EDIT_LOOKS } from "./finish/LookPanel";
export type { LookChoice, LookImage } from "./finish/LookPanel";
import { LookPanel, LookStrip, EDIT_LOOKS, type LookChoice } from "./finish/LookPanel";

function visibleFrame(shoot: Shoot, version: CutVersion, time: number) {
  let start = 0;
  for (const piece of storyboard(shoot, version).pieces) {
    const length = piece.lengthS ?? piece.e - piece.s, at = piece.timelineS ?? start;
    if (time >= at && time < at + length) {
      const offset = time - at;
      const overlay = piece.overlays?.find(o => offset < (o.lengthS ?? o.e - o.s));
      const visible = overlay ?? piece;
      let source = visible.s + offset;
      if (!overlay && piece.removed?.length) {
        for (const removed of [...piece.removed].sort((a, b) => a.s - b.s)) if (removed.s <= source) source += removed.e - removed.s;
      }
      return { clipId: visible.clipId, t: Math.max(visible.s, Math.min(source, visible.e - .04)), end: visible.e };
    }
    start = at + length;
  }
  return { clipId: "", t: 0, end: 0 };
}

type Aspect = SkillFormat["aspect"];
const FORMATS: { value: Aspect; label: string; ratio: number }[] = [
  { value: "9:16", label: "Portrait 9:16", ratio: 9 / 16 },
  { value: "1:1", label: "Square 1:1", ratio: 1 },
  { value: "4:5", label: "4:5", ratio: 4 / 5 },
  { value: "16:9", label: "Landscape 16:9", ratio: 16 / 9 },
];
type FinishDraft = { evenOutVoices: boolean; auto: boolean; breaths: boolean; framing: FramingChoice; transition: JoinChoice; cutToBeat: boolean; matchClips: boolean; matchRef: number | null; mixer: Grade["mixer"]; eq: NonNullable<AudioFinish["eq"]>; music: MusicChoice; faceMatch: "off" | "snap" | "ease"; titles: boolean; captionStyle: CaptionStyle; choice: LookChoice; clean: boolean; strength: number; target: number; aspect: Aspect; energy: "off" | "subtle" | "punchy" };
function savedFinish(version: CutVersion, aspect: number, defaultStyle: CaptionStyle = DEFAULT_CAPTION_STYLE): FinishDraft {
  return {
    framing: version.framing ?? { mode: "off" }, transition: version.transition ?? { kind: version.faceMatch === "off" ? "cut" : version.faceMatch ?? "ease", sound: null }, cutToBeat: version.cutToBeat ?? false,
    titles: Boolean(version.titles?.cues.some(c => c.role === "subtitle" || c.id.startsWith("kinetic-"))), captionStyle: version.titles?.captionStyle ?? defaultStyle,
    aspect: FORMATS.reduce((best, format) => Math.abs(format.ratio - aspect) < Math.abs(best.ratio - aspect) ? format : best).value,
    energy: version.energy ?? "subtle",
    matchClips: version.grade?.matchClips ?? true, matchRef: version.grade?.matchRef ?? null, mixer: normalizeMixer(version.grade?.mixer),
    eq: { low: version.audio?.eq?.low ?? 0, mid: version.audio?.eq?.mid ?? 0, high: version.audio?.eq?.high ?? 0 }, faceMatch: version.faceMatch ?? "ease",
    music: version.music ? { file: version.music.file, startS: version.music.startS, gainDb: version.music.gainDb ?? -18, duckDepthDb: version.music.duckDepthDb, stemDucking:version.music.stemDucking, fit:version.music.fit, followStory:version.music.followStory, duck: version.music.duck ?? true } : null,
    choice: { preset: version.grade?.preset ?? "clean", words: version.grade?.look ?? null, intensity: version.grade?.intensity ?? .7, ...(version.grade?.basic ? { basic: version.grade.basic } : {}) },
    evenOutVoices: version.audio?.evenOutVoices ?? version.audio?.auto !== false, auto: version.audio?.auto ?? true, breaths: version.audio?.breaths ?? true, clean: version.audio?.clean ?? true, strength: version.audio?.denoise ?? .6, target: version.audio?.loudnessLUFS ?? -14,
  };
}
const sameLook = (a: LookChoice, b: LookChoice) => a.preset === b.preset && (a.intensity ?? .7) === (b.intensity ?? .7) && a.words === b.words && JSON.stringify(normalizeBasic(a.basic)) === JSON.stringify(normalizeBasic(b.basic));

export function FinishPanel({ transformMode, onTransformMode, onLookFinish, onLookEdit, shoot, cutId, version, skills, aspect = 16 / 9, time = 0, busy, onFinish, onLiveLook, onLiveTexture, onPreviewPiece, onLiveTitles, captionSource, selectedPieces, selectedPiece, onClosePiece, onEdit, onPreviewEdit, player, timeline, cut, exportAction, drafting = false, onRegenerate, actionsDisabled, selectedJoin, onCloseJoin, searchControl, panel: railPanel, scope = "edit", onPanelChange, onSelectPiece, voice }: {
  transformMode?: boolean; onTransformMode?: (enabled: boolean) => void;
  onLookFinish?: (options: FinishOptions) => Promise<boolean>; onLookEdit?: (edit: CutEdit) => ReturnType<NonNullable<Parameters<typeof LookPanel>[0]["onEdit"]>>;
  panel?: EditsPanel | null; scope?: "edit" | "clip"; onPanelChange?: (panel: EditsPanel | null) => void;
  /** SCRIPT1: recording, for the Script panel (Precuts owns it so the teleprompter outlives the panel). */
  voice?: VoiceoverController;
  cut?: Cut; exportAction?: React.ReactNode; drafting?: boolean; selectedJoin?: number | null; onCloseJoin?: () => void; searchControl?: ControlEntry | null;
  shoot: Shoot; cutId?: string; version: CutVersion; skills: FinishSkill[]; aspect?: number; time?: number; busy: boolean;
  selectedPieces?: number[]; onSelectPiece?: (index: number) => void; selectedPiece?: number | null; onClosePiece?: () => void; onEdit?: (edit: CutEdit, baseVersion?: number) => void | Promise<{ cutId: string; version: number } | undefined>;
  onPreviewEdit?: (edit: CutEdit) => void;
  player?: React.RefObject<StageHandle>; timeline?: DraftTimeline | null;
  onFinish: (options: FinishOptions) => Promise<boolean>;
  onLiveLook?: (look: LiveLook) => void;
  onLiveTexture?: (texture: Pick<Grade, "detail" | "grain" | "vignette">) => void; onPreviewPiece?: (piece: number | undefined) => void;
  captionSource?: CaptionSource;
  onLiveTitles?: (titles: TitleTrack | null) => void;
} & InspectorActions) {
  const pageActive = usePageActive();
  const pageActiveRef = useRef(pageActive); pageActiveRef.current = pageActive;
  const overlaySession = useOverlayEditor(shoot.root, cutId, version.version, timeline, onEdit, busy, t => player?.current?.seek(t));
  const [saved, setSaved] = useState(() => savedFinish(version, aspect));
  const [draft, setDraftRaw] = useState(() => savedFinish(version, aspect));
  const { history } = useEditHistory(shoot.root, cutId, version.version);
  useEffect(() => () => history.clearStages(), [history]);
  const stagedDraft = useRef(draft); stagedDraft.current = draft;
  function setDraft(update: React.SetStateAction<FinishDraft>) {
    const before = stagedDraft.current;
    const after = typeof update === "function" ? update(before) : update;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (timeline) previewLiveSound(timeline, {
      audio: { clean: after.clean, denoise: after.strength, auto: after.auto, evenOutVoices:after.evenOutVoices, breaths: after.breaths, loudnessLUFS: after.target, eq: after.eq },
      music: liveMusicSelection(after.music,version.music,timeline.liveSound?.music,shoot.root),
    });
    const changed = Object.keys(after).filter(key => JSON.stringify(before[key as keyof FinishDraft]) !== JSON.stringify(after[key as keyof FinishDraft]));
    const names: Record<string, string> = { cutToBeat: "music cuts", choice: "look", captionStyle: "caption style", clean: "voice cleanup", strength: "denoise", eq: "EQ", faceMatch: "framing", matchClips: "match clips", titles: "captions", mixer: "colour", aspect: "format" };
    const restore = (value: FinishDraft) => { stagedDraft.current = value; setDraftRaw(value); previewLook(value.choice, true, value); };
    history.stage({ label: `change ${changed.map(key => names[key] ?? key).join(", ")}`, undo: () => restore(before), redo: () => restore(after) });
    stagedDraft.current = after; setDraftRaw(after); setError(null);
  }
  const [safePlatform, setSafePlatform] = useState<Preferences["captions"]["safeArea"]>("reels");
  const [autoSignature, setAutoSignature] = useState<string | null>(null);
  const [defaultSaved, setDefaultSaved] = useState<string | null>(null);
  const [captionHover, setCaptionHover] = useState<CaptionStyle | null>(null);
  const [transcriptTarget, setTranscriptTarget] = useState<{ s: number; e: number } | undefined>();
  // Double-click on a caption (lane block or caption line): its words open in the Text panel, ready to fix.
  const [transcriptFix, setTranscriptFix] = useState<{ s: number; e: number; key: number } | undefined>();
  useEffect(() => { setCaptionHover(null); }, [railPanel, version.version]);
  const [styleSaved, setStyleSaved] = useState(false);
  const [correctedShoot, setCorrectedShoot] = useState<Shoot | null>(null);
  const [transcriptSaving, setTranscriptSaving] = useState(false);
  const captionWords = useMemo(() => version.captionLanguage ? captionWordsForVersion(shoot, version) : correctedShoot ? transcriptPieces(correctedShoot, version).flatMap((piece, index) => piece.timedWords.map(word => ({ text: word.w, s: word.start, e: word.end, piece: index }))) : captionSource?.words ?? captionWordsForVersion(shoot, version), [shoot, correctedShoot, version, captionSource]);
  const titleCallback = useRef(onLiveTitles); titleCallback.current = onLiveTitles;
  const [musicNames, setMusicNames] = useState<Record<string, string>>({});
  const [lookNames, setLookNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [resultIndex, setResultIndex] = useState(0);
  const searchField = useRef<HTMLInputElement>(null), resultsId = useId();
  const content = useRef<HTMLDivElement>(null);
  const tabScroll = useRef<Partial<Record<InspectorTab, number>>>({});
  const [clipping, setClipping] = useState(false);
  const [item, setItem] = useState<{ kind: "caption" | "music" | "sound" | "audio"; id?: string } | null>(null);
  const [tab, setTab] = useState<InspectorTab>("Edit");
  const joinPreviewTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(joinPreviewTimer.current), []);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ id: string; anchor?: HTMLButtonElement } | null>(null);
  const [searchedPiece, setSearchedPiece] = useState<number | null>(null);
  const activePiece = selectedPiece ?? searchedPiece;
  const piece = activePiece == null ? null : storyboard(shoot, version).pieces[activePiece];
  function selectClip(index: number) {
    const pieces = storyboard(shoot, version).pieces, next = pieces[index];
    if (!next) return;
    if (onSelectPiece) onSelectPiece(index); else setSearchedPiece(index);
    player?.current?.stopPreview();
    player?.current?.seek(next.timelineS ?? pieces.slice(0, index).reduce((sum, piece) => sum + (piece.lengthS ?? piece.e - piece.s), 0));
  }
  const shell = railPanel !== undefined;
  const pieceOpen = !!piece && !!player && !!onEdit && (!shell || railPanel === "clips");
  const section = useRef<HTMLElement>(null);
  const overlayOpen = !!timeline?.overlays?.some(item => item.id === overlaySession?.selected) && (!shell || railPanel === "clips");
  const [inspectedJoin, setInspectedJoin] = useState<number | null>(null);
  const activeJoin = selectedJoin ?? inspectedJoin;
  const joinOpen = activeJoin != null && (!shell || railPanel === "pace");
  useEffect(() => {
    if (shell && railPanel === "pace" && activeJoin != null) content.current?.querySelector<HTMLElement>('[aria-label="Transitions"]')?.scrollIntoView?.({ block: "start" });
  }, [shell, railPanel, activeJoin]);
  const askCaption = useRef<string | null>(null);
  const askView = useRef<{ version: number; context: AskScreenContext }>({ version: version.version,
    context: { playheadS: time, panel: null, scope } });
  // Opening the Ask sheet closes the previous inspector. Keep what the person
  // was pointing at, while taking the playhead afresh on every render/send.
  if (askView.current.version !== version.version) askView.current = { version: version.version, context: { playheadS: time, panel: null, scope } };
  if (railPanel !== "ask" && tab !== "Ask") askView.current.context = { playheadS: time,
    panel: railPanel ?? ({ Edit: "pace", Look: "look", Captions: "captions", Sound: "sound" } as Record<string, string>)[tab], scope,
    selectedPiece: activePiece ?? null, selectedJoin: activeJoin ?? null,
    selectedCaption: railPanel === "script" || railPanel === "captions" || item?.kind === "caption" ? askCaption.current ?? item?.id ?? null : null,
    selectedOverlay: overlaySession?.selected || null };
  const askContext: AskScreenContext = { ...askView.current.context, playheadS: time, panel: "ask", editingPanel: askView.current.context.panel };
  function closePanel() {
    if (transcriptSaving) return;
    setItem(null); setSearchedPiece(null); setInspectedJoin(null); onClosePiece?.(); onCloseJoin?.();
    if (overlaySession?.selected) selectOverlay(overlaySession, "");
    setPanel(null);
  }
  const contextual = (!shell && joinOpen) || overlayOpen || (!overlayOpen && pieceOpen) || !!item;
  useEffect(() => { if (selectedPiece != null || selectedJoin != null || overlayOpen) setItem(null); }, [selectedPiece, selectedJoin, overlayOpen]);
  useEffect(() => {
    if (contextual) section.current?.querySelector<HTMLButtonElement>("[data-finish-back]")?.focus();
    else if (content.current) content.current.scrollTop = tabScroll.current[tab] ?? 0;
  }, [contextual, tab]);
  useEffect(() => {
    if (!contextual) return;
    let delta = 0, stamp = 0;
    const swipe = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      if (performance.now() - stamp > 180) delta = 0;
      stamp = performance.now(); delta += event.deltaX;
      if (delta < -90) { event.preventDefault(); closePanel(); delta = 0; }
    };
    const host = section.current; host?.addEventListener("wheel", swipe, { passive: false });
    return () => host?.removeEventListener("wheel", swipe);
  }, [contextual, transcriptSaving]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("sidething:clipping", { detail: clipping }));
    return () => { window.dispatchEvent(new CustomEvent("sidething:clipping", { detail: false })); };
  }, [clipping]);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const release = () => setDragging(false);
    window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release); window.addEventListener("keyup", release);
    return () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("keyup", release); };
  }, []);
  useEffect(() => {
    if (!shell) return;
    setItem(previous => previous && (previous.kind === "caption" ? railPanel === "captions" : railPanel === "sound") ? previous : null);
    if (railPanel !== "clips") setSearchedPiece(null);
    if (railPanel !== "pace") setInspectedJoin(null);
  }, [railPanel, scope]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 0.7.1: the caption design this panel asked for, until a version after `base` is on screen (it has the design, or its note).
  const [designWait, setDesignWait] = useState<{ kind: CaptionDesign; base: number } | null>(null);
  useEffect(() => { setDesignWait(previous => previous && previous.base !== version.version ? null : previous); }, [version.version]);
  const modelNotes = ((version.titles as { warnings?: string[] } | null | undefined)?.warnings ?? []).filter(note => captionDesignOfNote(note));
  const applying = useRef(false);
  const liveRequest = useRef(0), liveFrame = useRef(0);
  const basicSettle = useRef<ReturnType<typeof setTimeout>>();
  const livePending = useRef(false), latestPreview = useRef<(() => Promise<void>) | null>(null);
  const choiceRef = useRef(draft.choice); choiceRef.current = draft.choice;
  useEffect(() => {
    cancelAnimationFrame(liveFrame.current); clearTimeout(basicSettle.current); basicSettle.current = undefined;
    if (pageActive && latestPreview.current) previewLook(choiceRef.current, true);
  }, [pageActive]);
  const frame = visibleFrame(shoot, version, time);
  const lookChanged = !sameLook(draft.choice, saved.choice);
  const styleChanged = JSON.stringify(draft.captionStyle) !== JSON.stringify(saved.captionStyle);
  const mixerChanged = JSON.stringify(normalizeMixer(draft.mixer)) !== JSON.stringify(normalizeMixer(saved.mixer));
  const eqChanged = (["low", "mid", "high"] as const).some(band => draft.eq[band] !== saved.eq[band]);
  const musicChanged = draft.music?.fit !== saved.music?.fit || draft.music?.followStory !== saved.music?.followStory || draft.music?.file !== saved.music?.file || draft.music?.startS !== saved.music?.startS || draft.music?.gainDb !== saved.music?.gainDb || draft.music?.duck !== saved.music?.duck || draft.music?.duckDepthDb !== saved.music?.duckDepthDb || draft.music?.stemDucking !== saved.music?.stemDucking;
  const structureChanged = JSON.stringify(draft.framing) !== JSON.stringify(saved.framing) || JSON.stringify(draft.transition) !== JSON.stringify(saved.transition) || draft.cutToBeat !== saved.cutToBeat;
  const dirty = structureChanged || mixerChanged || eqChanged || musicChanged || draft.matchClips !== saved.matchClips || draft.matchRef !== saved.matchRef || draft.faceMatch !== saved.faceMatch || draft.titles !== saved.titles || (draft.titles && styleChanged) || lookChanged || draft.evenOutVoices !== saved.evenOutVoices || draft.breaths !== saved.breaths || draft.auto !== saved.auto || draft.clean !== saved.clean || draft.target !== saved.target || draft.strength !== saved.strength || draft.aspect !== saved.aspect || draft.energy !== saved.energy;
  useEffect(() => {
    if (!timeline) return;
    previewLiveSound(timeline,{audio:{clean:draft.clean,denoise:draft.strength,auto:draft.auto,evenOutVoices:draft.evenOutVoices,breaths:draft.breaths,loudnessLUFS:draft.target,eq:draft.eq},
      music:liveMusicSelection(draft.music,version.music,timeline.liveSound?.music,shoot.root)});
    return () => { liveSoundPreviews.delete(timeline); };
  },[timeline,draft.clean,draft.strength,draft.auto,draft.evenOutVoices,draft.breaths,draft.target,draft.eq,draft.music]);
  const locked = busy;
  const draftRef = useRef(draft); draftRef.current = draft;
  const renderCarry = useRef<{ base: number; draft: FinishDraft } | null>(null);

  useEffect(() => {
    let active = true;
    const initial = savedFinish(version, aspect);
    const carry = renderCarry.current;
    renderCarry.current = null;
    const patch: Partial<FinishDraft> = {};
    if (carry && version.version > carry.base) for (const key of Object.keys(initial) as (keyof FinishDraft)[]) {
      if (JSON.stringify(stagedDraft.current[key]) !== JSON.stringify(carry.draft[key])) Object.assign(patch, { [key]: stagedDraft.current[key] });
    }
    setCorrectedShoot(null); setAutoSignature(null); setSaved(initial); setDraftRaw({ ...initial, ...patch }); setPanel(null); setError(null);
    void getApi().getPreferences().then(prefs => {
      if (!active) return;
      setSafePlatform(prefs.captions.safeArea);
      const choice = version.grade ? initial.choice : { ...prefs.look, intensity: prefs.look.intensity ?? .7 };
      const captionStyle = version.titles?.captionStyle ?? prefs.captions.style ?? DEFAULT_CAPTION_STYLE;
      setSaved({ ...initial, choice, captionStyle });
      setDraftRaw(previous => ({ ...previous,
        ...(sameLook(previous.choice, initial.choice) ? { choice } : {}),
        ...(JSON.stringify(previous.captionStyle) === JSON.stringify(initial.captionStyle) ? { captionStyle } : {}),
      }));
    }).catch(() => {});
    return () => { active = false; liveRequest.current++; latestPreview.current = null; cancelAnimationFrame(liveFrame.current); clearTimeout(basicSettle.current); };
  }, [shoot.root, cutId, version.version, aspect]);

  useEffect(() => {
    if (timeline) setBasicPreview(timeline, normalizeBasic(draft.choice.basic), normalizeBasic(saved.choice.basic));
  }, [timeline, saved.choice.basic]);

  useEffect(() => {
    if (!titleCallback.current) return;
    const prior = version.titles;
    // The saved track is shown only once it carries the chosen style. Between the commit and the new version
    // arriving it is still the old one; showing it then flashed the old style back for a few seconds.
    const savedStyle = (style?: CaptionStyle) => style ? JSON.stringify({ ...style, hook: style.hook ?? "auto" }) : "";
    if (!captionHover && draft.titles && savedStyle(prior?.captionStyle) === savedStyle(draft.captionStyle) && saved.titles && !correctedShoot) { titleCallback.current(prior ?? null); return; }
    if (draft.titles || captionHover) {
      titleCallback.current(liveCaptionTrack(captionHover ?? draft.captionStyle));
    } else titleCallback.current(prior ? { ...prior, cues: prior.cues.filter(c => c.role !== "subtitle" && !c.id.startsWith("kinetic-")) } : null);
  }, [captionHover, draft.titles, draft.captionStyle, captionWords, version.titles, safePlatform, styleChanged, saved.titles, captionSource, correctedShoot]);
  function liveCaptionTrack(style: CaptionStyle) {
    const prior = version.titles;
    return buildCaptionTrack(captionWords, { ...prior, font: prior?.font ?? "Outfit", cues: prior?.cues ?? [], emphasis: correctedShoot ? [] : followEmphasis(prior, captionWords), prompt: prior?.prompt ?? null, skillIds: prior?.skillIds ?? [], captionSource: captionSource ? { ...captionSource, words: captionWords } : undefined } as CaptionTrack, style, captionSource?.safeArea ?? captionSafeArea(safePlatform), version.bigLines);
  }
  function chooseCaptionStyle(captionStyle: CaptionStyle) {
    // Optimistic: the player draws the new style this frame; the draft, the live track and the save follow.
    if (JSON.stringify(captionStyle) !== JSON.stringify(draft.captionStyle) || !draft.titles) try { player?.current?.previewTitles?.(liveCaptionTrack(captionStyle)); } catch { /* the render below reports it */ }
    // 0.7.1: a change that asks the model for what this track lacks says so under its control from this frame
    // (main asks for the opening line when the hook turns on with none designed, and for key words when Emphasis
    // turns on with none chosen). Off and on again while it designs keeps the note: the running design still lands.
    const track = version.titles as CaptionTrack | null | undefined, words = captionWords.length > 0;
    const asks: CaptionDesign | null = words && captionStyle.hook && captionStyle.hook !== "off" && captionStyle.hook !== draft.captionStyle.hook && !track?.kinetic?.lines.length ? "opening"
      : words && captionStyle.emphasis && !draft.captionStyle.emphasis && !track?.emphasis?.length ? "emphasis" : null;
    if (asks) setDesignWait(previous => previous ?? { kind: asks, base: version.version });
    setCaptionHover(null); setDraft(previous => ({ ...previous, captionStyle, titles: true })); setStyleSaved(false);
  }
  async function saveCaptionStyle() {
    setError(null); setStyleSaved(false);
    try {
      const prefs = await getApi().getPreferences();
      const savedPreferences = await getApi().setPreferences({ captions: { ...prefs.captions, style: draft.captionStyle } });
      if (JSON.stringify(savedPreferences.captions.style) !== JSON.stringify(draft.captionStyle)) throw new Error("Style was not saved");
      setStyleSaved(true);
    } catch { setError("Couldn't save your caption style. Try again."); }
  }
  function previewLook(choice: LookChoice, immediate = false, controls = draftRef.current) {
    const request = ++liveRequest.current, inputAt = performance.now();
    clearTimeout(basicSettle.current);
    basicSettle.current = undefined;
    if (timeline) setBasicPreview(timeline, normalizeBasic(choice.basic), normalizeBasic(saved.choice.basic), inputAt);
    latestPreview.current = async () => {
      if (!cutId || !onLiveLook) return;
      const look = { preset: choice.preset as LookPreset, intensity: choice.intensity ?? .7, basic: normalizeBasic(choice.basic), matchClips: controls.matchClips, matchRef: controls.matchRef, mixer: controls.mixer };
      try {
        const ids = await pieceLook(shoot.root, cutId, version.version, look);
        await Promise.all(ids.map(id => cachedLiveLut(id)));
        if (request === liveRequest.current) { lookBasics.set(ids, look.basic); lookInputTimes.set(ids, inputAt); onLiveLook(ids); }
      } catch { if (request === liveRequest.current) setError("Couldn't preview this look. Try again."); }
    };
    async function drain() {
      if (!pageActiveRef.current || livePending.current || basicSettle.current !== undefined) return;
      const load = latestPreview.current; latestPreview.current = null;
      if (!load) return;
      livePending.current = true;
      await load(); livePending.current = false;
      if (pageActiveRef.current && latestPreview.current) liveFrame.current = requestAnimationFrame(() => void drain());
    }
    cancelAnimationFrame(liveFrame.current);
    // Basic-only drags paint immediately, then settle once the pointer rests.
    // Release, look selection and other grade controls still request exact LUTs now.
    const basicOnly = choice.preset === choiceRef.current.preset && (choice.intensity ?? .7) === (choiceRef.current.intensity ?? .7)
      && JSON.stringify(normalizeBasic(choice.basic)) !== JSON.stringify(normalizeBasic(choiceRef.current.basic));
    if (!immediate && basicOnly) basicSettle.current = setTimeout(() => { basicSettle.current = undefined; void drain(); }, 150);
    else if (immediate) void drain(); else liveFrame.current = requestAnimationFrame(() => void drain());
  }
  async function chooseLook(choice: LookChoice, immediate = false) {
    if (locked) return false;
    setDraft(previous => ({ ...previous, choice })); setError(null);
    previewLook(choice, immediate || choice.preset !== draft.choice.preset);
    return true;
  }
  async function saveLookDefault() {
    const choice = draft.choice;
    const preferences = await getApi().setPreferences({ look: { preset: choice.preset, words: choice.words,
      intensity: choice.intensity ?? .7, basic: normalizeBasic(choice.basic) } });
    return sameLook(choice, preferences.look);
  }
  async function savePanelDefault(panel: "look" | "voice") {
    setError(null);
    try {
      if (panel === "look") { if (!await saveLookDefault()) throw new Error("Look was not saved."); }
      else { const prefs = await getApi().getPreferences(); await getApi().setPreferences({ voice: { ...prefs.voice, breaths: draft.breaths, clean: draft.clean, denoise: draft.strength, eq: draft.eq, loudnessLUFS: draft.target } }); }
      setDefaultSaved(panel);
    } catch { setError("Could not save this default. Try again."); }
  }
  function stageGrade(patch: Partial<Pick<FinishDraft, "matchClips" | "matchRef" | "mixer">>) {
    const next = { ...draftRef.current, ...patch }; setDraft(next); setError(null); previewLook(next.choice, false, next);
  }
  /** retry: the caption style again as it is, so main asks the model once more (Retry under its plain note). */
  async function apply(retry = false) {
    if (locked || transcriptSaving || applying.current || !dirty && !retry) return;
    const options: FinishOptions = {};
    if (retry || draft.titles !== saved.titles || (draft.titles && styleChanged)) options.captions = draft.titles ? draft.captionStyle : null;
    if (draft.choice.preset !== saved.choice.preset) options.preset = draft.choice.preset;
    if ((draft.choice.intensity ?? .7) !== (saved.choice.intensity ?? .7)) options.intensity = draft.choice.intensity ?? .7;
    if (JSON.stringify(normalizeBasic(draft.choice.basic)) !== JSON.stringify(normalizeBasic(saved.choice.basic))) options.basic = normalizeBasic(draft.choice.basic);
    if (draft.choice.words !== saved.choice.words) options.look = draft.choice.words;
    if (draft.evenOutVoices !== saved.evenOutVoices || draft.breaths !== saved.breaths || draft.auto !== saved.auto || draft.clean !== saved.clean || draft.target !== saved.target || draft.strength !== saved.strength || eqChanged) options.audio = {
      ...(draft.evenOutVoices !== saved.evenOutVoices ? {evenOutVoices:draft.evenOutVoices} : {}),
      ...(draft.breaths !== saved.breaths ? { breaths: draft.breaths } : {}),
      ...(draft.auto !== saved.auto ? { auto: draft.auto } : {}),
      ...(draft.clean !== saved.clean ? { clean: draft.clean } : {}),
      ...(draft.strength !== saved.strength ? { denoise: draft.strength } : {}),
      ...(eqChanged ? { eq: draft.eq } : {}),
      ...(draft.target !== saved.target ? { loudnessLUFS: draft.target } : {}),
    };
    if (draft.matchClips !== saved.matchClips) options.matchClips = draft.matchClips;
    if (draft.matchRef !== saved.matchRef) options.matchRef = draft.matchRef;
    if (mixerChanged) options.mixer = normalizeMixer(draft.mixer);
    if (musicChanged) options.music = draft.music;
    if (draft.faceMatch !== saved.faceMatch) options.faceMatch = draft.faceMatch;
    if (draft.aspect !== saved.aspect) options.aspect = draft.aspect;
    if (draft.energy !== saved.energy) options.energy = draft.energy;
    if (JSON.stringify(draft.framing) !== JSON.stringify(saved.framing)) options.framing = draft.framing;
    if (JSON.stringify(draft.transition) !== JSON.stringify(saved.transition)) options.transition = draft.transition;
    if (draft.cutToBeat !== saved.cutToBeat) options.cutToBeat = draft.cutToBeat;
    if (!Object.keys(options).length) return;
    renderCarry.current = { base: version.version, draft };
    applying.current = true; setSubmitting(true); setError(null);
    try { if (!await onFinish(options)) { renderCarry.current = null; setDesignWait(null); setError("Finish wasn't applied. Your changes are still here."); }
      else setSaved(draft);
    }
    catch (error) { renderCarry.current = null; setDesignWait(null); setError(error instanceof Error ? error.message : "Couldn't finish this cut. Your changes are still here."); }
    finally { applying.current = false; setSubmitting(false); }
  }
  function retryDesign() {
    const kind = modelNotes.map(captionDesignOfNote).find(Boolean);
    if (!kind || locked || transcriptSaving || applying.current) return;
    setDesignWait({ kind, base: version.version }); void apply(true);
  }
  const commitLive = useRef(() => { void apply(); }); commitLive.current = () => { void apply(); };
  const releasedLiveChange = useRef(false);
  releasedLiveChange.current = dirty && !dragging && !locked && !submitting && !transcriptSaving && !error;
  useEffect(() => () => { if (releasedLiveChange.current) commitLive.current(); }, []);
  useEffect(() => {
    if (!dirty || dragging || locked || submitting || transcriptSaving || error) return;
    const timer = setTimeout(() => commitLive.current(), 100);
    return () => clearTimeout(timer);
  }, [dirty, JSON.stringify(draft), dragging, locked, submitting, transcriptSaving, error]);
  const shellControls: Record<EditsPanel, readonly string[]> = {
    script: ["transcript"], captions: ["captions", "caption-lines"], look: ["look", "histogram", "adjust", "colour"],
    sound: ["auto-mix", "audio", "music", "sounds", "loudness"], pace: ["length", "energy", "cuts"],
    clips: [], ask: ["ask"], search: [],
  };
  // RAIL1: the whole-edit layout (and auto layouts) open inside Clips.
  const [wholeLayout, setWholeLayout] = useState(false);
  const visibleControls = shell ? shellControls[railPanel ?? "search"] : TAB_CONTROLS[tab];
  const askOpen = shell ? railPanel === "ask" : tab === "Ask";
  function openControl(entry: ControlEntry) {
    // RAIL1: Cover opens in the Export sheet, footage in Clips' Add more. Both keep their own owner's flow.
    if (entry.panel === "cover" || entry.panel === "footage") {
      setQuery("");
      window.dispatchEvent(new CustomEvent(entry.panel === "cover" ? "sidething:open-cover" : "sidething:browse-media", { detail: { root: shoot.root } }));
      if (entry.panel === "cover") onPanelChange?.(null);
      return;
    }
    closePanel();
    onPanelChange?.(panelForControl(entry));
    if (shell && entry.panel === "layout") setWholeLayout(true);
    if (["piece", "transform"].includes(entry.panel) || shell && entry.panel === "framing") setSearchedPiece(selectedPiece ?? 0);
    setTab(entry.tab); setPanel({ id: entry.panel }); setHighlight(entry.id); setQuery("");
  }
  useEffect(() => {
    function inspect(event: Event) {
      const detail = (event as CustomEvent<{ panel: string; join?: number; id?: string; control?: string; controlId?: string }>).detail;
      if (!detail) return;
      if (detail.panel === "join" && detail.join != null) { setItem(null); setInspectedJoin(detail.join); return; }
      if (detail.panel === "caption" && shell) {
        askCaption.current = detail.id ?? null;
        const cue = (timeline?.titles ?? version.titles)?.cues.find(cue => cue.id === detail.id);
        setItem(null); setInspectedJoin(null); setSearchedPiece(null);
        if (cue) setTranscriptTarget({ s: cue.s, e: cue.e });
        onPanelChange?.("script"); return;
      }
      if (["caption", "music-item", "sound-item", "audio-item"].includes(detail.panel)) {
        if (detail.panel === "caption") askCaption.current = detail.id ?? null;
        setInspectedJoin(null); setSearchedPiece(null);
        setItem({ kind: detail.panel === "caption" ? "caption" : detail.panel === "music-item" ? "music" : detail.panel === "sound-item" ? "sound" : "audio", id: detail.id }); return;
      }
      const entry = CONTROL_REGISTRY.find(entry => entry.id === (detail.controlId ?? detail.control ?? detail.panel));
      if (entry) openControl(entry);
    }
    function fixCaption(event: Event) {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      const cue = (timeline?.titles ?? version.titles)?.cues.find(cue => cue.id === id);
      if (!cue) return;
      askCaption.current = cue.id;
      setTranscriptTarget({ s: cue.s, e: cue.e }); setTranscriptFix({ s: cue.s, e: cue.e, key: Date.now() });
      if (shell) { setItem(null); setInspectedJoin(null); setSearchedPiece(null); onPanelChange?.("script"); }
      else setItem({ kind: "caption", id: cue.id });
    }
    window.addEventListener("sidething:inspect", inspect);
    window.addEventListener("sidething:fix-caption", fixCaption);
    return () => { window.removeEventListener("sidething:inspect", inspect); window.removeEventListener("sidething:fix-caption", fixCaption); };
  }, [selectedPiece, transcriptSaving, shell, timeline?.titles, version.titles, onPanelChange]);
  useEffect(() => { if (searchControl) openControl(searchControl); }, [searchControl]);
  useEffect(() => {
    const root = section.current;
    if (!root) return;
    CONTROL_REGISTRY.filter(entry => !entry.selector).forEach(entry => markControlTargets(root, entry.panel));
    if (!highlight) return;
    const target = root.querySelector<HTMLElement>(`[data-control="${highlight}"]`);
    if (target && !target.matches?.("input, button, select, textarea, [tabindex]")) target.tabIndex = -1;
    target?.scrollIntoView?.({ block: "nearest", behavior: "instant" }); target?.focus?.({ preventScroll: true });
    target?.setAttribute?.("data-search-highlight", "");
    const timer = setTimeout(() => { target?.removeAttribute?.("data-search-highlight"); setHighlight(null); }, 1200);
    return () => { clearTimeout(timer); target?.removeAttribute?.("data-search-highlight"); };
  }, [tab, highlight, contextual, railPanel, scope]);
  const focusSearch = () => { if (shell) onPanelChange?.("search"); searchField.current?.focus(); searchField.current?.select(); };
  useEffect(() => {
    window.addEventListener("sidething:command-search", focusSearch);
    return () => window.removeEventListener("sidething:command-search", focusSearch);
  }, [shell, onPanelChange]);
  useShortcuts("precuts", [
    { id: "inspector-back", keys: ["Escape"], label: "Back to inspector tabs", scope: "precuts", enabled: contextual, handler: closePanel },
    { id: "command-search", keys: ["Cmd+k"], label: "Find a tool or setting", scope: "global", handler: focusSearch },
    { id: "clipping-preview", keys: ["j"], label: "Toggle clipping preview in Look", scope: "precuts", enabled: tab === "Look" && !contextual, handler: () => setClipping(value => !value) },
  ], !shell);
  // Prepare all choices as soon as the edit opens, independently of the visible tab.
  useEffect(() => {
    if (!cutId || !timeline) return;
    let alive = true;
    void (async () => {
      for (const look of EDIT_LOOKS) {
        if (!alive) return;
        try { const ids = await pieceLook(shoot.root, cutId, version.version, { preset: look.id as LookPreset, intensity: draft.choice.intensity ?? .7, basic: normalizeBasic(draft.choice.basic), matchClips: draft.matchClips, matchRef: draft.matchRef, mixer: draft.mixer }); await Promise.all(ids.map(id => cachedLiveLut(id))); } catch { /* The selected look reports its own error. */ }
      }
    })();
    return () => { alive = false; };
  }, [shoot.root, cutId, version.version, timeline]);
  const captionLines = (timeline?.titles ?? version.titles)?.cues.filter(cue => cue.role === "subtitle") ?? [];
  const currentCaption = captionLines.find(cue => cue.id === item?.id);
  const sounds = soundBlocks(timeline), currentSound = sounds.find(sound => sound.id === item?.id);
  const results = searchInspector(query).filter(result => result.control && (result.control.id !== "energy-cut-to-beat" || draft.music));
  function soundView(sound: typeof sounds[number]) {
    const change = (value: string) => {
      if ("join" in sound) {
        const join = timeline?.joins?.find(join => join.index === sound.join);
        if (join) void onEdit?.({ kind: "join", join: sound.join!, choice: { ...join.choice, sound: value === "none" ? null : value as JoinChoice["sound"] } });
      } else if ("overlay" in sound) void onEdit?.({ kind: "overlay", op: "update", id: sound.overlay!, patch: { sound: value === "none" ? null : value as JoinChoice["sound"] } });
    };
    return <div className="space-y-2"><p>{sound.label} · {"join" in sound ? `Transition ${sound.join! + 1}` : "Overlay"} · {sound.s.toFixed(2)} s</p>
      <Button onClick={() => { player?.current?.seek(Math.max(0, sound.s - .1)); player?.current?.play?.(); clearTimeout(joinPreviewTimer.current); joinPreviewTimer.current = setTimeout(() => player?.current?.pause?.(), 1200); }}>Play</Button>
      <Row as="label" className="min-h-10">Change sound<select aria-label={`Sound ${sound.id}`} value={sound.label} onChange={event => change(event.target.value)} className={`rounded-lg bg-ink/[0.06] p-2 ${FOCUS}`}>{["none", "whoosh", "hit", "pop", "riser"].map(name => <option key={name} value={name}>{name === "none" ? "None" : name[0].toUpperCase() + name.slice(1)}</option>)}</select></Row>
      <Button onClick={() => change("none")}>Remove sound</Button></div>;
  }
  // SCRIPT1: one document for camera speech and voiceover. Its own saves never lock it (a fieldset would).
  const scriptPanel = <ScriptPanel shoot={correctedShoot ?? shoot} version={version} time={time} voice={voice} scrollTo={transcriptTarget} fixRange={transcriptFix} onChange={setCorrectedShoot} onSaving={setTranscriptSaving} onSeek={at => player?.current?.seek(at)} onTogglePlay={() => player?.current?.togglePlayback?.()} />;
  const renderControl = (id: string) => <fieldset disabled={locked} className="min-w-0 space-y-3 disabled:opacity-50">
        {id === "transcript" ? scriptPanel : null}
        {id === "overlays" ? <AddMore shoot={shoot} version={version} timeline={timeline} time={time} busy={locked} onEdit={onEdit} /> : null}
        {id === "colour" ? <ColourPanel value={draft.mixer} onChange={mixer => stageGrade({ mixer })} /> : null}
        {id === "cuts" ? <><TransitionControls value={draft.transition} onChange={transition => setDraft(previous => ({ ...previous, transition }))} /><Button disabled={!version.joins?.some(Boolean)} onClick={async () => { if (!onEdit) return; let base = version.version; for (let join = 0; join < (version.joins?.length ?? 0); join++) if (version.joins?.[join]) { const result = await onEdit({ kind: "join", join, choice: null }, base); if (!result) break; base = result.version; } }}>Use for every join</Button><Segments label="Face match" value={draft.faceMatch} choices={["off", "snap", "ease"]} onChange={faceMatch => setDraft(previous => ({ ...previous, faceMatch }))} /></> : null}
        {id === "cut-to-beat" && draft.music ? <Row as="label">Cut to the music<Switch aria-label="Cut to the music" checked={draft.cutToBeat} onChange={event => setDraft(previous => ({ ...previous, cutToBeat: event.target.checked }))} /></Row> : null}
        {id === "energy" ? <><Segments label="Energy" value={draft.energy} choices={["off", "subtle", "punchy"]} onChange={energy => setDraft(previous => ({ ...previous, energy }))} />{!shell && draft.music ? <><Row as="label">Cut to the music<Switch aria-label="Cut to the music" checked={draft.cutToBeat} onChange={event => setDraft(previous => ({ ...previous, cutToBeat: event.target.checked }))} /></Row>{draft.cutToBeat ? <p role="status" className="text-micro text-muted">{beatWorking ? "Cutting to the music" : beatLine}</p> : null}</> : null}</> : null}
        {id === "captions" ? <Row as="label" className=""><span>Captions {draft.titles ? "on" : "off"}</span><Switch aria-label="Captions" checked={draft.titles} onChange={event => setDraft(previous => ({ ...previous, titles: event.target.checked }))} /></Row> : null}
        {id === "captions" ? <fieldset className="space-y-3">
          {cutId ? <CaptionLanguage root={shoot.root} cutId={cutId} version={version} disabled={locked} /> : null}
          <CaptionSettings value={draft.captionStyle} onChange={chooseCaptionStyle} onPreview={setCaptionHover} notes={Object.fromEntries((["hook", "emphasis"] as const).map(slot => [slot,
            <CaptionDesignNote key={slot} root={shoot.root} cutId={cutId} slot={slot} waiting={designWait?.kind ?? null} failed={modelNotes.find(note => (captionDesignOfNote(note) === "emphasis") === (slot === "emphasis")) ?? null} onRetry={retryDesign} />]))} />
          <Button type="button" onClick={() => void saveCaptionStyle()}>Use for new edits</Button>
          {styleSaved ? <p role="status" className="text-micro text-muted">Saved for new edits.</p> : null}
          {(version.titles as { warnings?: string[] } | null | undefined)?.warnings?.filter(note => note.startsWith("Couldn't") && !captionDesignOfNote(note)).map(note => <p key={note} role="status" className="text-micro text-muted">{note}</p>)}
        </fieldset> : null}
        {id === "look" ? <><LookStrip root={shoot.root} livePreview={{ cutId: cutId!, version: version.version, timeline, time, matchClips: draft.matchClips, matchRef: draft.matchRef, mixer: draft.mixer }} value={draft.choice} t={frame.t} disabled={locked} onChoose={chooseLook} onRelease={choice => previewLook(choice, true)} onNames={setLookNames} /><Button onClick={() => void savePanelDefault("look")}>Use for new edits</Button></> : null}
        {id === "adjust" ? <><Row as="label" className=""><span>Match all clips</span><Switch aria-label="Match all clips" checked={draft.matchClips && draft.matchRef === null} onChange={event => stageGrade({ matchClips: event.target.checked, matchRef: null })} /></Row><Basics root={shoot.root} cutId={cutId} version={version.version} value={draft.choice.basic} disabled={locked}
          onChange={(basic, immediate, origin) => { setAutoSignature(origin === "auto" ? JSON.stringify(normalizeBasic(basic)) : null); void chooseLook({ ...choiceRef.current, basic }, immediate); }} onSave={saveLookDefault} /></> : null}
        {["auto-mix", "audio", "breaths", "music", "sounds", "loudness"].includes(id) ? renderSoundControl({ id, controlId: resultsId, version, timeline, auto: draft.auto, evenOutVoices:draft.evenOutVoices, breaths: draft.breaths, clean: draft.clean, strength: draft.strength, eq: draft.eq, target: draft.target, music: draft.music, cutToBeat: draft.cutToBeat,
          onChange: patch => setDraft(previous => ({ ...previous, ...patch })), onNames: setMusicNames,
          onDefault: <Button onClick={() => void savePanelDefault("voice")}>Use for new edits</Button>,
          sounds: <div className="space-y-3">{sounds.map(sound => <div key={sound.id}>{soundView(sound)}</div>)}{!sounds.length ? <EmptyState variant="inline" as="p" className="text-micro text-muted">No sound effects in this edit.</EmptyState> : null}<GenerateSound root={shoot.root} time={time} durationS={timeline?.durationS ?? version.lengthS} busy={locked} onEdit={onEdit} /></div>,
        }) : null}
        {id === "length" ? <LengthPanel root={shoot.root} cutId={cutId} version={version.version} lengthS={version.lengthS} disabled={locked} /> : null}
        {id === "framing" ? <><FramingControls pills={shell} value={draft.framing} onChange={framing => setDraft(previous => ({ ...previous, framing: framing ?? { mode: "off" } }))} /><MotionProgress shoot={shoot} visible={tab === "Edit" && draft.framing.mode !== "off"} /></> : null}
        {id === "histogram" ? <Histogram clipping={clipping} onClipping={() => setClipping(value => !value)} /> : null}
        {id === "caption-lines" ? <div className="space-y-1" aria-label="Caption lines">{captionLines.map(cue => <button type="button" key={cue.id} title="Open this line to fix its words" onClick={() => { player?.current?.seek(cue.s); setItem({ kind: "caption", id: cue.id }); }} className={`block w-full rounded-lg bg-ink/[0.035] p-2 text-left hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06] ${FOCUS}`}><span className="block text-micro text-muted">{cue.s.toFixed(2)} to {cue.e.toFixed(2)} s</span>{cue.text}</button>)}{!captionLines.length ? <EmptyState variant="inline" as="p" className="text-micro text-muted">No caption lines in this edit.</EmptyState> : null}</div> : null}
      {defaultSaved === (id === "audio" ? "voice" : id) && <p role="status" className="text-micro text-muted">Saved for new edits.</p>}
      </fieldset>;
  const renderAction = null;
  const beatPlan = version.cutMusicPlan;
  const beatLine = draft.cutToBeat && beatPlan?.piecesSignature === JSON.stringify(version.pieces?.map(p => [p.clipId, p.s, p.e, p.timelineS, p.lengthS]) ?? []) ? beatPlan.summary : null;
  const beatWorking = !!draft.cutToBeat && !beatLine;
  return <section ref={section} data-editor-widget aria-label="Finish" onPointerDownCapture={event => {
    if ((event.target as HTMLElement).closest("[data-slider], input[type='range']")) setDragging(true);
  }} onKeyDownCapture={event => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && (event.target as HTMLElement).closest("[data-slider], input[type='range']")) setDragging(true);
  }} onKeyDown={event => {
    if (!shell && event.key === "Escape" && contextual) { event.preventDefault(); event.stopPropagation(); closePanel(); }
    else if (!shell && event.key.toLowerCase() === "j" && tab === "Look" && !contextual && !(event.target as HTMLElement).closest("input, textarea, select")) { event.preventDefault(); setClipping(value => !value); }
    if (event.key !== "Tab") event.stopPropagation();
  }} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden font-sans text-small">
    {!shell && (!contextual ? <Tabs label="Inspector tabs" value={tab} options={INSPECTOR_TABS} onChange={setTab} idPrefix="inspector-tab" panelId="inspector-content" className="grid shrink-0 grid-cols-5 gap-0.5 px-2 pt-2" /> :
      <BackHeader data-finish-back title="Back (Escape or swipe right)" disabled={transcriptSaving} onClick={closePanel}>{tab}</BackHeader>)}
    <div ref={content} id="inspector-content" role={shell || contextual ? undefined : "tabpanel"} aria-labelledby={shell || contextual ? undefined : `inspector-tab-${tab}`} onScroll={event => { if (!contextual) tabScroll.current[tab] = event.currentTarget.scrollTop; }} className={`min-h-0 flex-1 px-3 pb-3 ${(askOpen || shell && railPanel === "script") && !contextual ? "flex flex-col overflow-hidden" : "overflow-y-auto overflow-x-hidden"}`}>
      {!shell && panel?.id === "layout" ? <div data-finish-row="layout"><LayoutPanel shoot={shoot} version={version} time={time} aspect={aspect} timeline={timeline} busy={locked} onEdit={onEdit} onSeek={t=>player?.current?.seek(t)} /></div> : contextual && (!shell || railPanel !== "search") ? <div className="space-y-3 pt-2">
        {item?.kind === "caption" ? currentCaption ? <div aria-label="Caption line" className="space-y-3"><SectionHeader as="h3" className="font-medium">Caption line</SectionHeader><p className="text-micro text-muted">{currentCaption.s.toFixed(2)} to {currentCaption.e.toFixed(2)} s</p><ScriptPanel shoot={correctedShoot ?? shoot} version={version} time={time} range={{ s: currentCaption.s, e: currentCaption.e }} fixRange={transcriptFix} onChange={setCorrectedShoot} onSaving={setTranscriptSaving} onSeek={at => player?.current?.seek(at)} onTogglePlay={() => player?.current?.togglePlayback?.()} /><Button onClick={() => openControl(CONTROL_REGISTRY.find(entry => entry.id === "captions")!)}>Caption style</Button></div> : <p className="text-muted">This caption is no longer in this version.</p> :
        item?.kind === "sound" ? currentSound ? <div aria-label="Sound effect">{soundView(currentSound)}</div> : <p className="text-muted">This sound has been removed.</p> :
        item?.kind === "music" ? <div aria-label="Music item">{renderControl("music")}</div> :
        item?.kind === "audio" ? <div aria-label="Voice item">{renderControl("audio")}</div> :
        overlayOpen ? <div aria-label="Overlay panel"><AddMore shoot={shoot} version={version} timeline={timeline} time={time} busy={locked} onEdit={onEdit} selectedOnly /></div> :
        joinOpen ? <fieldset disabled={locked}><TransitionsPanel shoot={shoot} version={version} index={activeJoin!} timeline={timeline} onEdit={edit => onEdit?.(edit)} preview={at => { player?.current?.seek(Math.max(0, at - 1)); player?.current?.play?.(); clearTimeout(joinPreviewTimer.current); joinPreviewTimer.current = setTimeout(() => player?.current?.pause?.(), 2000); }} /></fieldset> :
        <div aria-label="Piece panel" data-control="piece"><ClipPanel transformMode={transformMode} onTransformMode={onTransformMode} indexes={selectedPieces} onPreviewEdit={onPreviewEdit} shoot={shoot} version={version} index={activePiece!} onSelect={selectClip} onBack={closePanel} time={time} timeline={timeline} player={player!} busy={locked} onEdit={onEdit!} onMatch={() => void onFinish({ matchClips: true, matchRef: activePiece })} /></div>}
      </div> : shell && railPanel === "script" ? <div data-control="transcript" className={`flex min-h-0 flex-1 flex-col ${highlight === "transcript" ? "bg-[var(--selection-fill)]" : ""}`}>{scriptPanel}</div> : shell && railPanel === "sound" ? <SoundPanel indexes={scope === "clip" ? selectedPieces : undefined} timeline={timeline} renderControl={renderControl} action={renderAction} version={version} index={scope === "clip" ? activePiece : null} busy={locked} onEdit={onEdit} /> :
      shell && railPanel === "pace" ? <PacePanel videoType={<VideoTypeControl root={shoot.root} cutId={cutId} current={version.videoType} disabled={locked} />} renderControl={renderControl} action={renderAction} music={!!draft.music} cutToBeat={draft.cutToBeat} beatLine={beatLine} beatWorking={beatWorking} onCutToBeat={cutToBeat => setDraft(previous => ({ ...previous, cutToBeat }))}
        transitions={<fieldset disabled={locked}><TransitionsPanel shoot={shoot} version={version} index={activeJoin} timeline={timeline} onEdit={onEdit} preview={at => { player?.current?.seek(Math.max(0, at - 1)); player?.current?.play?.(); clearTimeout(joinPreviewTimer.current); joinPreviewTimer.current = setTimeout(() => player?.current?.pause?.(), 2000); }} value={draft.transition} onChange={transition => setDraft(previous => ({ ...previous, transition }))} /></fieldset>} /> :
      shell && railPanel === "clips" ? <ClipsPanel layout={{ open: wholeLayout, onToggle: () => setWholeLayout(open => !open), aspect, panel: <LayoutPanel shoot={shoot} version={version} time={time} aspect={aspect} timeline={timeline} busy={locked} onEdit={onEdit} onSeek={t => player?.current?.seek(t)} /> }} shoot={shoot} version={version} timeline={timeline} time={time} busy={locked} onEdit={onEdit} onSelect={selectClip} onAddAt={index => { const piece = storyboard(shoot, version).pieces[index]; if (piece) player?.current?.seek(piece.timelineS ?? 0); }} /> : shell && railPanel === "look" ? <LookPanel shoot={shoot} selectedPieces={selectedPieces} root={shoot.root} cutId={cutId} version={version} timeline={timeline} selectedPiece={selectedPiece} scope={scope} disabled={false} onFinish={onLookFinish ?? onFinish} onEdit={onLookEdit ?? onEdit} onLiveLook={onLiveLook} onTexture={onLiveTexture} onPreviewPiece={onPreviewPiece} /> : askOpen ? <div data-control="ask" className="flex min-h-0 flex-1 flex-col pt-3"><AskPanel root={shoot.root} cutId={cutId} version={version.version} screenContext={askContext} /></div> :
        <div className="space-y-4">{visibleControls.map(id => <section key={id} data-control={id} className={`min-w-0 ${highlight === id ? "bg-[var(--selection-fill)]" : ""}`}>
          {id !== "auto-mix" && id !== "overlays" && <SectionHeader as="h3" className="sticky top-0 z-20 flex min-h-10 items-center bg-surface text-micro font-semibold text-muted">{CONTROL_REGISTRY.find(entry => entry.id === id)?.label ?? id}</SectionHeader>}{renderControl(id)}
        </section>)}</div>}
    </div>
    {shell && error ? <InlineError className="px-3 pb-2 text-micro text-danger">{error}</InlineError> : null}
    {!shell || railPanel === "search" ? <div data-tool-search className="relative shrink-0 px-3 pb-3 pt-1">
      {query.trim() ? <div id={resultsId} role="listbox" aria-label="Tools and settings" className={`${shell ? "relative mb-2" : "absolute inset-x-3 bottom-full"} z-40 max-h-64 overflow-y-auto rounded-xl bg-surface p-1`}>
        {results.length ? results.map((result, index) => <button id={`${resultsId}-${index}`} type="button" role="option" aria-selected={index === resultIndex} key={result.id} onClick={() => openControl(result.control!)} className={`block w-full rounded-lg p-2 text-left text-micro ${index === resultIndex ? "bg-ink/[0.08]" : "hover:bg-ink/[0.04]"} ${FOCUS}`}>{result.label}</button>) : <EmptyState variant="inline" as="p" className="p-2 text-micro text-muted">No matching tools.</EmptyState>}
      </div> : null}
      <SearchField shortcut={null} label="Find a tool or setting" ref={searchField} autoFocus={shell} aria-label="Find a tool or setting" role="combobox" aria-controls={resultsId} aria-activedescendant={query.trim() && results[resultIndex] ? `${resultsId}-${resultIndex}` : undefined} aria-expanded={!!query.trim()} value={query} placeholder="Find a tool or setting · ⌘ K" onChange={event => { setQuery(event.target.value); setResultIndex(0); }} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setResultIndex(index => (index + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, results.length)) % Math.max(1, results.length)); }
        if (event.key === "Enter" && results[resultIndex]) { event.preventDefault(); openControl(results[resultIndex].control!); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setQuery(""); }
      }} className={`w-full rounded-lg bg-ink/[0.045] px-3 py-2 text-micro text-ink placeholder:text-muted ${FOCUS}`} />
    </div> : null}
  </section>;
}
