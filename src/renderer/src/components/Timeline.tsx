import { pieceName } from "../../../shared/clip-name";
import { useNamedText } from "./ClipNames";
import { useLaneResize } from './timeline/laneResize';
import { MusicBlock } from './timeline/MusicBlock';
import { LayoutLane } from './timeline/LayoutLane';
import { CaptionWords } from "./timeline/CaptionWords";
import { timedCaptionWords, updateCaptionWord } from "../../../shared/caption-words";
import { PunchTicks } from "./timeline/PunchTicks";
import { clickSelection, boxPieces, moveSelection, selectionBatch } from "./timeline/selection";
import { useSoundSeparation, CLEAN_SOUND_CHOICES } from "./finish/ClipSoundCleaning";
import { autoCorrect, useBalance } from "../hooks/useBalance";
import { LaneLevel } from './timeline/LaneLevel';
import { clipLaneDb, laneDb, laneMuted, defaultClipMuted } from '../../../shared/lane-levels';
import type { SoundLane } from '../../../shared/schema';
import { VolumeLine } from './timeline/VolumeLine';
import { previewLiveSound, clearLiveSoundPreview, liveSoundPreviews } from './liveMix';
import { Tile, InlineError, MenuSurface, MenuOption } from "./ui";
import { addLibraryItem, LIBRARY_DRAG_TYPE, fillPlaceholderEdit, libraryInsertIndex } from "./finish/library";
import { addOverlayFiles, useOverlaySession } from "./OverlayHandles";
import { getApi } from "../data";
import { More, Wand, Undo, Redo, Captions, Video, Voice, Music, Overlays, Sound, Volume, VolumeOff, Eye, EyeOff, Minus, Plus, TransitionCut, Snap, Ease, Zoom, Whip, Dissolve, Ramp } from "./icons";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePageActive } from "../hooks/usePageActivity";
import { shortcutKeys, useShortcuts } from "../hooks/useShortcuts";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { CutEdit, CutVersion, DraftTimeline, Shoot } from "../../../shared/schema";
import { magneticTime } from "../../../shared/magnetic";
import { instant, spring } from "../motion";
import { formatDuration } from "../data";
import { storyboard } from "./edits/model";
import type { StageHandle } from "./Stage";
import { FOCUS, Slider } from "./ui";
import { OverlayBlock } from "./timeline/OverlayBlock";
import { useKept } from "./finish/MotionControls";
import { Waveform } from "./timeline/Waveform";
import { clipSoundBlocks, captionBlocks, clipDuration, soundBlocks, soundLabelSlots, timelineTime, magneticPreview, magneticSpans, insertionAt, trimEdge, type TrimEdge, type LaneId, type LaneVisibility } from "./timeline/model";
import { DurationBadge, Filmstrip } from "./timeline/Filmstrip";
import "./timeline/timeline.css";
import { timelineZoom, wheelPixels } from "./viewZoom";
import { SOURCE_DRAG_TYPE, readSourceDrag, sourceInsertAt } from "./library/source";
import { TAKE_DRAG_TYPE, readTakeDrag, type TakeDrag } from "./TakeViewer";
import { AudioScrub, CloseGap, FitView, Magnet, keyGlyphs, type TimelineTool } from "./edits/ToolBar";
import { Tooltip } from "./ui/InfoTip";
import { hitTrimEdge, paintTrim, trimZone } from './timeline/instantTrim';
import { musicSnap, musicTicks, musicalTrim, fitPlacement, joinBeat, snapJoinToBeat } from './timeline/musicBeats';
import { beatAt, type MusicGrid } from '../../../shared/music-grid';
import { dur, musicGridTransition, sourceWindowTransition } from '../motion';
import type { VoiceoverLine } from '../../../shared/schema';
import { applyVoiceEdit, bladeCut, insertionAt as voiceInsertionAt, snapToEdge, voiceGaps, voiceJoinFades, type VoiceEditOp, type VoiceTake } from '../../../shared/voice-edit';
import { setTimelinePref, timelinePrefs, useTimelinePrefs } from './timeline/prefs';

// VO7-8 cursors: a blade over a voice piece, and Resolve's bracket at a trim edge (hotspot on the edge).
const svgCursor=(body:string,x:number,y:number,fallback:string)=>`url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>${body}</svg>`)}") ${x} ${y}, ${fallback}`;
const BLADE_CURSOR=svgCursor("<path d='M4.5 19.5 16.8 7.2a2.1 2.1 0 0 1 3 3L8 19.5z' fill='white' stroke='black' stroke-width='1.5' stroke-linejoin='round'/><path d='M11 13.5l2.5 2.5' stroke='black' stroke-width='1.2'/>",4,20,'crosshair');
const bracket=(open:boolean)=>`<path d='${open ? 'M13 4h-3v16h3' : 'M11 4h3v16h-3'}' fill='none' stroke='white' stroke-width='4'/><path d='${open ? 'M13 4h-3v16h3' : 'M11 4h3v16h-3'}' fill='none' stroke='black' stroke-width='2'/><path d='${open ? 'M7 12H2M4 9.5 1.5 12 4 14.5' : 'M17 12h5M20 9.5l2.5 2.5-2.5 2.5'}' fill='none' stroke='white' stroke-width='3.5'/><path d='${open ? 'M7 12H2M4 9.5 1.5 12 4 14.5' : 'M17 12h5M20 9.5l2.5 2.5-2.5 2.5'}' fill='none' stroke='black' stroke-width='1.5'/>`;
const TRIM_START_CURSOR=svgCursor(bracket(true),10,12,'w-resize'), TRIM_END_CURSOR=svgCursor(bracket(false),14,12,'e-resize');
/** FIX5: why a trim at a limit saved nothing, from trimEdge's limit. */
const trimLimitNote: Record<string, string> = { 'Shortest a clip can be': 'One frame is the shortest a clip can be', 'Start of footage': 'The footage starts here', 'End of footage': 'The footage ends here' };

/** VO7-11: the player's clock, every frame, outside React. The timeline paints its playhead and time
 * readout from it directly; React's `time` prop lands only at rest (about 4 Hz while playing, once after a scrub). */
export type LiveTime = { now: () => number; subscribe: (paint: (seconds: number) => void) => () => void };

export function Timeline({ liveTime, onScrub, selectedVoices, onSelectVoices, selectedGap, onSelectGap, tool = 'select', onTool, onBlade, onPlaceTake, onImportTake, hint, sourceInsertS, cutId, onMusicChange, onMusicGain, shoot, version, time, player, busy, onEdit, onPreview, onTrimGesture, selectedPieces, onSelectPieces, selectedPiece, onSelectPiece, draft, onSelectJoin, onSelectOverlay, onInspect, history, tools, visibility, onVisibility, onDeselect, holdKeys, keyGate }: {
  sourceInsertS?: number;
  // FIX4: the page's own saving truth (read at the key, never a rendered copy), and where it hands a key pressed meanwhile.
  // FIX4: the page's key gate: shut from a save with no local plan starting until its version shows here (`until`).
  keyGate?: React.MutableRefObject<{ saving: boolean; until: number | null }>; holdKeys?: React.MutableRefObject<((event: KeyboardEvent) => void) | null>;
  liveTime?: LiveTime; onScrub?: (active: boolean) => void;  // VO7-11: the live clock, and a scrub starting or ending
  selectedVoices?: string[]; onSelectVoices?: (lines: string[]) => void;  // VO6/VO7-8: the selected voice pieces on the Voiceover lane
  selectedGap?: { s: number; e: number } | null; onSelectGap?: (gap: { s: number; e: number } | null) => void;  // VO7-8: a gap on the Voiceover lane
  tool?: TimelineTool; onTool?: (tool: TimelineTool) => void;  // VO7-8: Select (A) or Blade (B)
  onBlade?: (line: string, at: number) => void;                 // VO7-8: cut that voice piece at reel `at`, exactly
  onPlaceTake?: (take: string, spans: { s: number; e: number }[], at: number) => unknown;  // VO7-8: a dropped take, placed and selected
  onImportTake?: (file: string) => Promise<{ file: string; durationS: number }>;          // VO7-8: a Finder audio file, copied into the shoot as a take
  hint?: string | null;                                         // VO7-8: a short hint ("Select a piece to split")
  onTrimGesture?: (active: boolean) => void;
  onMusicChange?: (music:NonNullable<CutVersion["music"]>) => Promise<unknown>;
  onMusicGain?: (gainDb:number) => Promise<unknown>;
  onPreview?: (edit: CutEdit | null, seek?: number) => void;
  tools?: React.ReactNode; visibility?: LaneVisibility; onVisibility?: (visibility: LaneVisibility) => void; onDeselect?: () => void;
  shoot: Shoot; version: CutVersion; time: number; player: React.RefObject<StageHandle>;
  draft?: DraftTimeline | null; onSelectJoin?: (index: number) => void; onSelectOverlay?: (id: string) => void; onInspect?: (panel: string, detail?: { id?: string }) => void;
  history?: { undoLabel: string | null; redoLabel: string | null; undo: () => void; redo: () => void };
  cutId?: string;
  selectedPieces?: number[]; onSelectPieces?: (pieces:number[])=>void;
  busy: boolean; onEdit: (edit: CutEdit) => unknown; selectedPiece?: number | null; onSelectPiece?: (index: number, openInspector?: boolean) => void;
}) {
  const namedText = useNamedText();
  const laneResize=useLaneResize();
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const chosen = selectedPieces ?? (selectedPiece == null ? [] : [selectedPiece]);
  const anchor = useRef<number | null>(null), selectionNow = useRef(chosen); selectionNow.current=chosen;
  function selectMany(next:number[]) { selectionNow.current=next; if(onSelectPieces)onSelectPieces(next);else if(next.length)onSelectPiece?.(next.at(-1)!);else onDeselect?.(); }
  function selectClick(piece:number,event:{metaKey?:boolean;ctrlKey?:boolean;shiftKey?:boolean}) {
    selectMany(clickSelection(selectionNow.current,piece,anchor.current,pieces.map(p=>p.sourceIndex),event));
    if(!event.shiftKey)anchor.current=selectionNow.current.includes(piece) ? piece : selectionNow.current.at(-1) ?? null;
  }
  const marquee=useRef<HTMLSpanElement>(null);
  const [selectingBox,setSelectingBox]=useState(false);
  const boxDrag=useRef<{pointer:number;x:number;y:number;base:number[];selected:number[];blocks:{piece:number;left:number;right:number;top:number;bottom:number;node:HTMLElement}[]} | null>(null);
  function startBox(event:React.PointerEvent) {
    const canvasBox=canvasElement.current?.getBoundingClientRect(); if(!canvasBox)return;
    event.preventDefault();event.stopPropagation();pauseFollowing();setSelectingBox(true);
    const blocks=Array.from(canvasElement.current?.querySelectorAll<HTMLElement>('[data-source-piece]') ?? []).map(node=>{const r=node.getBoundingClientRect();return {piece:Number(node.dataset.sourcePiece),left:r.left-canvasBox.left,right:r.right-canvasBox.left,top:r.top-canvasBox.top,bottom:r.bottom-canvasBox.top,node};});
    const base=event.shiftKey || event.metaKey || event.ctrlKey ? [...selectionNow.current] : [];
    boxDrag.current={pointer:event.pointerId,x:event.clientX-canvasBox.left,y:event.clientY-canvasBox.top,base,selected:base,blocks};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function updateBox(event:React.PointerEvent) {
    const drag=boxDrag.current,r=canvasElement.current?.getBoundingClientRect();if(!drag || drag.pointer!==event.pointerId || !r)return;
    event.preventDefault();event.stopPropagation();
    const x=event.clientX-r.left,y=event.clientY-r.top,rect={left:Math.min(x,drag.x),right:Math.max(x,drag.x),top:Math.min(y,drag.y),bottom:Math.max(y,drag.y)};
    drag.selected=[...new Set([...drag.base,...boxPieces(rect,drag.blocks)])];
    if(marquee.current){marquee.current.hidden=false;Object.assign(marquee.current.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.right-rect.left}px`,height:`${rect.bottom-rect.top}px`});}
    for(const b of drag.blocks)b.node.dataset.selected=String(drag.selected.includes(b.piece));
  }
  function endBox(event:React.PointerEvent,cancel=false) {
    const drag=boxDrag.current;if(!drag || drag.pointer!==event.pointerId)return;
    if(!cancel)updateBox(event);boxDrag.current=null;setSelectingBox(false);if(marquee.current)marquee.current.hidden=true;
    const next=cancel ? selectionNow.current : drag.selected;selectMany(next);
    for(const b of drag.blocks)b.node.dataset.selected=String(next.includes(b.piece));
    if(!cancel && next.length)anchor.current=next.at(-1)!;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const correction=useBalance(shoot.root,cutId,version.version);
  async function correctPiece(piece:number,readyOnly=false) {if(!cutId)return;try{await autoCorrect(shoot.root,cutId,version.version,{...(chosen.includes(piece) && chosen.length>1 ? {pieces:chosen} : {piece}),readyOnly:readyOnly && !(chosen.includes(piece) && chosen.length>1)});}catch(error){setDropError(error instanceof Error?error.message:"Could not auto correct. Try again.");}setSoundMenu(null);}
  const soundSeparation=useSoundSeparation();
  const [soundMenu,setSoundMenu] = useState<{piece:number;layer:0|1;x:number;y:number} | null>(null);
  const [laneMenu,setLaneMenu]=useState<{lane:SoundLane;view:LaneId;x:number;y:number}|null>(null);
  const [soundLayer,setSoundLayer]=useState<0|1>(0);
  const overlaySession = useOverlaySession(draft);
  const dropPending = useRef(false);
  const [replaceHover,setReplaceHover] = useState<number | null>(null);
  const [sourceHover,setSourceHover] = useState<number | null>(null);
  const [sourceHoverS,setSourceHoverS] = useState<number | null>(null);
  useEffect(()=>{const clear=()=>{setSourceHover(null);setSourceHoverS(null);setReplaceHover(null);};window.addEventListener('dragend',clear);return()=>window.removeEventListener('dragend',clear);},[]);
  const [dropError, setDropError] = useState<string | null>(null);
  // FIX5: why the last trim saved nothing, until the next press (or a few seconds).
  const [trimNote, setTrimNote] = useState<string | null>(null);
  useEffect(() => { if (!trimNote) return; const id = setTimeout(() => setTrimNote(null), 5000); return () => clearTimeout(id); }, [trimNote]);
  const [localVisibility, setLocalVisibility] = useState<LaneVisibility>({});
  const [localPlan, setLocalPlan] = useState<DraftTimeline | null>(null);
  const previewBase = useRef<DraftTimeline | null>(null);
  const [dragging, setDragging] = useState<{ piece: number; edge?: TrimEdge; length: number; limit?: string | null; to?: number } | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ piece: number; edge: TrimEdge } | null>(null);
  // VO7-13: Snapping and Close gaps are remembered (Settings' preferences), one store with the Delete keys.
  const { snapping, closeGaps, audioScrub } = useTimelinePrefs();
  const toggleSnapping=()=>setTimelinePref({snapping:!timelinePrefs().snapping});
  const toggleAudioScrub=()=>setTimelinePref({audioScrub:!timelinePrefs().audioScrub});
  const snapFlash=useRef<HTMLSpanElement>(null), flashTimer=useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(()=>()=>{if(flashTimer.current!==null)clearTimeout(flashTimer.current);},[]);
  const gesture = useRef<{ pointer: number; x: number; scale: number; base: DraftTimeline; piece: number; edge?: TrimEdge; join?: number; s: number; e: number; start: number; sourceDuration: number; speed: number; fps: number; musical: boolean; starts: number[]; lengths: number[]; targets: number[]; moved: boolean; selected:number[]; nextSelection?:number[]; nextAnchor?:number; edit?: CutEdit; plan?: DraftTimeline; limit?: string | null } | null>(null);
  const hoveredJoinEdge = useRef<HTMLElement | null>(null);
  const savePending = useRef(false), suppressClick = useRef(false);
  function replaceDropTarget(target: EventTarget | null, x: number): number | null {
    const block = (target as HTMLElement | null)?.closest<HTMLElement>('[data-source-piece]');
    if (!block) return null;
    const piece = Number(block.dataset.sourcePiece), box = block.getBoundingClientRect();
    // The ends remain insertion zones, including when adjacent shots touch.
    const edge = Math.min(12,box.width/4);
    return version.pieces?.[piece]?.kind === 'broll' && x>box.left+edge && x<box.right-edge ? piece : null;
  }
  const viewDraft = localPlan ?? draft;
  const hidden = visibility ?? localVisibility;
  function toggleLane(lane: LaneId) { const next = { ...hidden, [lane]: !hidden[lane] }; setLocalVisibility(next); onVisibility?.(next); }
  const saved = storyboard(shoot, version);
  // Playback spans are authoritative after transcript cuts, speed and overlaps.
  const spine = viewDraft?.pieces.filter(piece => piece.layer === 0) ?? [];
  const grouped = [...new Map(spine.map((span, index) => [span.piece ?? index, span])).keys()].map(sourceIndex => {
    const spans = spine.filter((span, index) => (span.piece ?? index) === sourceIndex), first = spans[0], last = spans.at(-1)!;
    return { ...first, endS: last.endS, sourceIndex, segments: spans, sourceEnd: last.timeMap?.at(-1)?.s ?? last.inS + last.endS-last.startS };
  });
  const pieces = viewDraft ? grouped.map((span, index) => {
    const sourceIndex = span.piece ?? index;
    const piece = saved.pieces[sourceIndex];
    return { ...piece, id: piece?.id ?? span.clipId, label: piece?.label ?? span.clipId, words: piece?.words ?? "", clipId: span.clipId,
      s: span.inS, e: span.sourceEnd, timelineS: span.startS, lengthS: span.endS - span.startS, sourceIndex, span };
  }) : saved.pieces.map((piece, sourceIndex) => ({ ...piece, sourceIndex, span: undefined }));
  const { unknownPositions } = saved;
  // A clip keeps its element when it moves or its piece number changes (a saved move renumbers the pieces):
  // keyed by the piece itself, and its occurrence for a clip used twice, never by position. Its place is a plain
  // style, never an animated value, so a kept element never draws one frame at its old place (⌘Z after a move).
  const pieceKeys = (() => { const seen = new Map<string, number>(); return pieces.map(piece => { const n = seen.get(piece.id) ?? 0; seen.set(piece.id, n + 1); return `${piece.id}#${n}`; }); })();
  const reduced = useReducedMotion();
  const [zoom, setZoom] = useState(1);
  const zoomNow = useRef(1), zoomLeft = useRef<number | null>(null);
  const zoomHold = useRef<number | null>(null);
  const canvasElement = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const labelsInner = useRef<HTMLDivElement>(null);
  const scrub = useRef<number | null>(null);
  const autoScrollLeft = useRef<number | null>(null);
  const resumeScroll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [following, setFollowing] = useState(true);
  const pauseFollowing = useCallback(() => {
    autoScrollLeft.current = null;
    setFollowing(false);
    if (resumeScroll.current !== null) clearTimeout(resumeScroll.current);
    resumeScroll.current = setTimeout(() => { resumeScroll.current = null; setFollowing(true); }, 2000);
  }, []);
  useEffect(() => () => { if (resumeScroll.current !== null) clearTimeout(resumeScroll.current); }, []);
  const pageActive = usePageActive();
  const [width, setWidth] = useState(0);
  function scrollZoom(left: number) {
    const row = viewport.current, content = canvasElement.current;
    if (!row) return;
    row.scrollLeft = left;
    // Chromium rounds scrollLeft to device pixels. Retain the remainder in the
    // content transform so the pointed frame does not drift during a pinch.
    if (content?.style) content.style.transform = `translateX(${row.scrollLeft - left}px)`;
  }
  function changeZoom(next: number, pointer?: number) {
    const row = viewport.current;
    if (!row || gesture.current || scrub.current !== null) return;
    next = Math.max(1, Math.min(64, next));
    zoomHold.current = time;
    const left = canvasElement.current ? row.getBoundingClientRect().left - canvasElement.current.getBoundingClientRect().left : row.scrollLeft;
    zoomLeft.current = timelineZoom(zoomLeft.current ?? left, pointer ?? row.clientWidth / 2, zoomNow.current, next, row.clientWidth);
    if (next === zoomNow.current) { scrollZoom(zoomLeft.current); zoomLeft.current = null; }
    zoomNow.current = next; pauseFollowing(); setZoom(next);
  }
  useEffect(() => {
    if (zoomLeft.current !== null) { scrollZoom(zoomLeft.current); zoomLeft.current = null; }
  }, [zoom]);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  wheelHandler.current = event => {
    const row = viewport.current;
    if (!row) return;
    pauseFollowing();
    const delta = wheelPixels(event, row.clientHeight);
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      changeZoom(zoomNow.current * Math.exp(-delta * .01), event.clientX - row.getBoundingClientRect().left);
    } else {
      const lanes = row;
      // Vertical lane scrolling stays native, including at either end of the lane list.
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && lanes && lanes.scrollHeight > lanes.clientHeight + 1) return;
      event.preventDefault();
      row.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : delta;
    }
  };
  useEffect(() => {
    const row = viewport.current;
    if (!pageActive || !row) return;
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    const fit = () => changeZoom(1, 0);
    row.addEventListener?.('wheel', wheel, { passive: false });
    window.addEventListener('precut:zoom-fit', fit);
    return () => { row.removeEventListener?.('wheel', wheel); window.removeEventListener('precut:zoom-fit', fit); };
  }, [pageActive]);

  useEffect(() => {
    if (!pageActive || !viewport.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(entry.contentRect.width); });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [pageActive]);
  const lengths = pieces.map((piece) => Math.max(0, piece.lengthS ?? piece.e - piece.s));
  let elapsed = 0;
  const starts = pieces.map((piece, index) => {
    const start = piece.timelineS ?? elapsed;
    elapsed = start + lengths[index];
    return start;
  });
  // VO6: a voiceover longer than the picture stays reachable, so its end can be trimmed.
  const voiceEnd = Math.max(0, ...(viewDraft?.voiceover ?? []).flatMap(l => l.take ? [l.s + l.take.e - l.take.s] : []));
  const duration = Math.max(viewDraft?.durationS ?? Math.max(version.lengthS || 0, elapsed), voiceEnd);
  const canvas = Math.max(1, width) * zoom;
  const scale = gesture.current?.scale ?? canvas / (duration || 1);
  const widths = lengths.map(length => length * scale);
  const lastGrid=useRef<{owner:string;grid:MusicGrid}|null>(null);
  const gridOwner=JSON.stringify([shoot.root,cutId,version.music?.file,version.music?.startS]);
  if(lastGrid.current?.owner!==gridOwner)lastGrid.current=null;
  // V63: a plan still sounding another track never lends this one its marks.
  const ownTrack=!draft?.liveSound?.music || draft.liveSound.music.arrangementSource===version.music?.file,draftGrid=ownTrack ? draft?.musicGrid : undefined;
  if(draftGrid)lastGrid.current={owner:gridOwner,grid:draftGrid};
  const grid:MusicGrid = version.music ? draftGrid ?? lastGrid.current?.grid ?? {beats:ownTrack ? draft?.musicBeatsS ?? [] : [],bars:[],hits:[],sections:[]} : {beats:[],bars:[],hits:[],sections:[]};
  const tickCache=useRef<{grid:MusicGrid;scale:number;ticks:ReturnType<typeof musicTicks>} | null>(null);
  if(tickCache.current?.grid!==grid || tickCache.current.scale!==scale)tickCache.current={grid,scale,ticks:musicTicks(grid,scale)};
  const beatTicks=tickCache.current.ticks;
  // One retained SVG behind all lanes. Scroll is native; zoom scales its box.
  const guideCache=useRef<{grid:MusicGrid;duration:number;node:React.ReactNode}|null>(null);
  if(guideCache.current?.grid!==grid || guideCache.current.duration!==duration) {
    const marks=(times:number[],kind:string)=>times.map((at,i)=><rect key={`${kind}-${i}`} data-guide-kind={kind} width="1" height="100%" style={{x:`${at/(duration || 1)*100}%`,transition:reduced ? undefined : musicGridTransition}} />);
    guideCache.current={grid,duration,node:<svg data-beat-guides aria-hidden="true" className="st-beat-guides">{marks(grid.beats,'beat')}{marks(grid.bars,'bar')}</svg>};
  }
  function flashBeat(at?:number) {
    const mark=snapFlash.current;
    if(!mark)return;
    if(flashTimer.current!==null)clearTimeout(flashTimer.current);
    if(at===undefined || beatAt(grid,at,1/(2*(draft?.fps ?? 25)))===undefined){mark.hidden=true;return;}
    mark.style.left=`${at*scale}px`;mark.hidden=false;
    flashTimer.current=setTimeout(()=>{mark.hidden=true;},dur.base*1000);
  }
  function snappedTime(at:number, disabled=false, includePlayhead=false) {
    const next=snapping && !disabled ? musicSnap(at,grid,scale,[...(includePlayhead ? [time] : []),...starts,duration]) : undefined;
    flashBeat(next);return Math.max(0,Math.min(duration,next ?? at));
  }
  function paintBeatJoins(plan:DraftTimeline) {
    const spans=magneticSpans(plan);
    for(const [i,p] of spans.slice(1).entries()) {
      const dot=canvasElement.current?.querySelector<HTMLElement>(`[data-beat-join="${i}"]`);
      if(dot){dot.hidden=beatAt(grid,p.startS,1/(2*(draft?.fps ?? 25)))===undefined;dot.style.left=`${p.startS*scale}px`;}
      const videoMark=canvasElement.current?.querySelector<HTMLElement>(`[data-video-beat-join="${i}"]`),mark=joinBeat(grid,p.startS,draft?.fps ?? 25);
      if(videoMark){videoMark.hidden=!mark;videoMark.dataset.onBeat=String(mark?.frames===0);videoMark.style.left=`${p.startS*scale}px`;}
    }
  }
  const sourceRate=(piece:number)=>shoot.clips.find(c=>c.id===version.pieces?.[piece]?.clipId)?.meta?.fps || draft?.fps || 25;
  // The clip's file changed: its old preview is not shown while the new one is made (main re-reads it first).
  const updatingPreview=(clipId:string)=>shoot.clips.some(c=>c.id===clipId && c.previewHealth?.stale && !c.missing)
    ? <span data-updating-preview className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ground/80 px-1 text-micro text-muted"><span className="truncate rounded-md bg-surface px-2 py-1" title="Updating this clip's preview…">Updating this clip's preview…</span></span> : null;
  const tickInterval = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(seconds => seconds * scale >= 65) ?? Math.max(600, Math.ceil(duration / 12));
  const ticks = Array.from({ length: Math.floor(duration / tickInterval) + 1 }, (_, i) => i * tickInterval);
  const activeIndex = pieces.findIndex((_, index) => time >= starts[index]
    && (time < starts[index] + lengths[index] || (index === pieces.length - 1 && time >= starts[index] + lengths[index])));
  const progress = activeIndex < 0 ? 0 : Math.max(0, Math.min(1, (time - starts[activeIndex]) / (lengths[activeIndex] || 1)));
  // VO7-11: what a live paint needs, from this render, so a frame of the clock never renders the timeline.
  const live = useRef({ scale, duration, starts, lengths, following, pageActive, shown: 0 }); live.current = { scale, duration, starts, lengths, following, pageActive, shown: Math.max(0, Math.min(duration, time)) };
  const head = useRef<HTMLSpanElement>(null), headTime = useRef<HTMLSpanElement>(null), readout = useRef<HTMLSpanElement>(null), readoutTotal = useRef<HTMLSpanElement>(null);
  const ruler = useRef<HTMLDivElement>(null), seconds = useRef<{ nodes: HTMLElement[]; widths: number[]; badge: { length: number; half: number } }>({ nodes: [], widths: [], badge: { length: 0, half: 26 } });
  const rulerScrub = useRef(false);
  /** Follow the clock: keep the current piece (or the playhead inside a long one) in view. */
  function followAt(at: number) {
    // A paused zoom stays where it was put. Follow can resume when the clock moves.
    if (zoomHold.current !== null) { if (zoomHold.current === at) return; zoomHold.current = null; }
    const g = live.current, row = viewport.current;
    if (!g.pageActive || !g.following || scrub.current !== null || rulerScrub.current || gesture.current || !row) return;
    const index = g.starts.findIndex((start, i) => at >= start && (at < start + g.lengths[i] || (i === g.starts.length - 1 && at >= start + g.lengths[i])));
    const fraction = index < 0 ? 0 : Math.max(0, Math.min(1, (at - g.starts[index]) / (g.lengths[index] || 1)));
    const active = row.querySelector<HTMLElement>(`[data-timeline-block="${index}"]`);
    if (!active) return;
    let left = row.scrollLeft;
    if (active.offsetWidth > row.clientWidth) {
      const x = active.offsetLeft + active.offsetWidth * fraction;
      if (x < left + 2) left = x - 2;
      else if (x > left + row.clientWidth - 2) left = x - row.clientWidth + 2;
    } else if (active.offsetLeft < left) left = active.offsetLeft;
    else if (active.offsetLeft + active.offsetWidth > left + row.clientWidth) left = active.offsetLeft + active.offsetWidth - row.clientWidth;
    left = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, left));
    if (Math.abs(left - row.scrollLeft) > 0.5) {
      autoScrollLeft.current = left;
      // Follow the clock directly, including seeks and reduced motion, without easing behind it.
      row.scrollTo({ left, behavior: "instant" });
    }
  }
  /** VO7-11: the playhead, its badge and the time readout, written straight to the DOM (no render). The
   * playhead's `left` stays React's (from `time`); the live clock rides on a composited transform from there,
   * so moving it costs no layout. React writes these nodes only when `time` changes, and the layout effect
   * below repaints the live clock over it, so a late render never pulls the playhead back. */
  function paintLive(at: number) {
    const h = head.current;
    // A trim paints its own playhead (on `left`), from no offset.
    if (gesture.current) { if (h?.style.transform) h.style.transform = ""; return; }
    followAt(at);  // reads geometry before anything below is written
    const g = live.current, text = timelineTime(at), base = g.shown * g.scale, x = Math.max(0, Math.min(g.duration, at)) * g.scale - base;
    if (h) {
      // A trim can leave `left` where it painted it; the offset is from React's own position.
      if (Math.abs((parseFloat(h.style.left) || 0) - base) > .01) h.style.left = `${base}px`;
      // Under a quarter pixel of travel is not drawn: at a fitted zoom the clock moves far less than that a frame.
      const shown = Math.abs(x) < 1e-3 ? "" : `translateX(${x}px)`, prior = /translateX\((-?[\d.e-]+)px\)/.exec(h.style.transform)?.[1];
      if (shown !== h.style.transform && (!shown || prior === undefined || Math.abs(Number(prior) - x) >= .25)) h.style.transform = shown;
    }
    if (headTime.current && headTime.current.textContent !== text) headTime.current.textContent = text;
    if (readout.current && readout.current.textContent !== text) readout.current.textContent = text;
    const total = `/ ${timelineTime(g.duration)}`;
    if (readoutTotal.current && readoutTotal.current.textContent !== total) readoutTotal.current.textContent = total;
    coverSeconds(Math.max(0, Math.min(g.duration, at)) * g.scale, text, g.duration * g.scale);
  }
  /** CH4: the playhead's label owns the ruler's top row. A seconds label it would sit on fades out; the widths are
   * measured once per zoom (below), the label's only when its text gets longer or shorter, so a frame reads no layout. */
  function coverSeconds(x: number, text: string, end: number) {
    const s = seconds.current, label = headTime.current;
    if (label && s.badge.length !== text.length && label.offsetWidth > 0) s.badge = { length: text.length, half: label.offsetWidth / 2 + 6 };
    // At either end of the reel the label slides inward to stay whole; its notch stays on the line.
    const half = s.badge.half - 6, shift = end > 2 * half ? Math.max(half, Math.min(end - half, x)) - x : 0, shown = `${Math.round(shift * 10) / 10}px`;
    if (label && label.style.getPropertyValue("--badge-shift") !== shown) label.style.setProperty("--badge-shift", shown);
    x += shift;
    s.nodes.forEach((node, i) => {
      const left = parseFloat(node.style.left) || 0, covered = String(left < x + s.badge.half && left + s.widths[i] > x - s.badge.half);
      if (node.dataset.covered !== covered) node.dataset.covered = covered;
    });
  }
  const paint = useRef(paintLive); paint.current = paintLive;
  useEffect(() => liveTime?.subscribe(at => paint.current(at)), [liveTime]);
  // CH4: the seconds labels and their widths, read when the ruler's ticks change (zoom, resize), before the paint below.
  useLayoutEffect(() => {
    const nodes = Array.from(ruler.current?.querySelectorAll?.<HTMLElement>("[data-ruler-second]") ?? []);
    seconds.current = { ...seconds.current, nodes, widths: nodes.map(node => node.offsetWidth || 24) };
    if (!liveTime) coverSeconds(Math.max(0, Math.min(duration, time)) * scale, timelineTime(time), duration * scale);
  }, [tickInterval, ticks.length, scale]);
  useLayoutEffect(() => { if (liveTime) paint.current(liveTime.now()); }, [liveTime, time, scale, duration]);
  /** VO7-11: a ruler scrub seeks the player at most once per frame; the playhead is painted on every move. */
  const frameSeek = useRef<{ frame: number; at: number | null }>({ frame: 0, at: null });
  function scrubSeek(at: number, final = false) {
    paintLive(at);
    const gate = frameSeek.current;
    if (final || typeof requestAnimationFrame !== "function") {
      if (gate.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(gate.frame);
      gate.frame = 0; gate.at = null; player.current?.seek(at); return;
    }
    if (gate.frame) { gate.at = at; return; }
    player.current?.seek(at);
    // VO7-14: with Audio scrub on, a ruler drag plays grains of the mix under the playhead (same frame gate as the seek).
    if (rulerScrub.current && timelinePrefs().audioScrub) player.current?.scrubAudio?.(at);
    gate.frame = requestAnimationFrame(() => { gate.frame = 0; const next = gate.at; gate.at = null; if (next !== null) scrubSeek(next); });
  }
  function scrubbing(active: boolean) {
    if (rulerScrub.current === active) return;
    rulerScrub.current = active; onScrub?.(active);
    if (!active) player.current?.scrubAudio?.(null);
  }
  useEffect(() => () => { if (frameSeek.current.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameSeek.current.frame); if (rulerScrub.current) onScrub?.(false); }, []);
  function previewGesture(edit: CutEdit, base: DraftTimeline, seek?: number) {
    previewBase.current = base;
    setLocalPlan(magneticPreview(base, edit)); onPreview?.(edit, seek);
  }
  async function saveGesture(edit: CutEdit) {
    // FIX4: the live saving flag, as the key's handler read it; a rendered `busy` can lag it and drop the key.
    if (savePending.current || savingNow()) return;
    savePending.current = true; setDropError(null);
    try { const saved=await onEdit(edit);return saved!==undefined; }
    catch { onPreview?.(null); setDropError("Couldn't save that change. The timeline is back as it was."); }
    finally { savePending.current = false; setLocalPlan(null); setDragging(null); }
  }
  function beginGesture(event: React.PointerEvent, index: number, edge?: TrimEdge, join?: number) {
    if (!event.isPrimary || event.button !== 0 || busy || savePending.current || !draft || !version.pieces) return;
    const piece = pieces[index], source = shoot.clips.find(c => c.id === piece.clipId);
    const box = event.currentTarget.getBoundingClientRect?.();
    if (!edge && box) edge = hitTrimEdge(event.clientX, box.left, box.width);
    if (!edge && (event.metaKey || event.ctrlKey || event.shiftKey)) {event.preventDefault();event.stopPropagation();selectClick(piece.sourceIndex,event);suppressClick.current=true;return;}
    if (!source?.meta?.durationS) return;
    if (trimNote) setTrimNote(null);
    if(edge)onTrimGesture?.(true);
    setSoundLayer(0); event.preventDefault(); event.stopPropagation(); pauseFollowing(); player.current?.pause?.(); if(edge){onSelectPiece?.(piece.sourceIndex,false);anchor.current=piece.sourceIndex;}else if(!chosen.includes(piece.sourceIndex)){selectMany([piece.sourceIndex]);anchor.current=piece.sourceIndex;}
    suppressClick.current = false;
    (event.target as HTMLElement | undefined)?.closest?.("button")?.focus({preventScroll:true});
    if (edge) setSelectedEdge({piece:piece.sourceIndex,edge}); else setSelectedEdge(null);
    // Reordering moves the clip's DOM node. Chromium drops capture on a moved
    // node, so the viewport owns the gesture for both handles and clip bodies.
    const captor = viewport.current?.setPointerCapture ? viewport.current : event.currentTarget;
    captor.setPointerCapture(event.pointerId);
    gesture.current = {pointer:event.pointerId,x:event.clientX,scale,base:draft,edge,join,...pieceGesture(index)!,starts:[...starts],lengths:[...lengths],selected:edge ? [piece.sourceIndex] : chosen.includes(piece.sourceIndex) ? [...chosen] : [piece.sourceIndex],moved:false};
  }
  /** What a gesture on piece `index` works from: its source range and limits, speed, and whether musical trims apply. */
  function pieceGesture(index: number) {
    const piece = pieces[index], source = shoot.clips.find(c => c.id === piece?.clipId);
    if (!piece || !source?.meta?.durationS) return null;
    const fps = source.meta.fps || draft?.fps || 25, speed = version.pieceFx?.[piece.sourceIndex]?.speed ?? 1;
    return {piece:piece.sourceIndex,s:piece.s,e:piece.e,start:starts[index],sourceDuration:source.meta.durationS,speed,fps,targets:[time,...starts.filter((_,i)=>i!==index),duration],
      musical:spine.filter(p=>p.piece===piece.sourceIndex).every(p=>(p.timeMap ?? []).every((k,i,keys)=>!i || Math.abs((k.s-keys[i-1].s)/(k.t-keys[i-1].t)-speed)<.001)) && (index===pieces.length-1 || Math.abs(starts[index+1]-(starts[index]+lengths[index]))<1e-6)};
  }
  /** FIX5: a one-frame clip can't get shorter, so dragging its edge inward would change nothing and save nothing.
   * The drag goes to the nearest other edge at a join within 10 px of the press (the reach 0.7.4 gave every join)
   * that can move that way; with none, the drag stays put and says why when released. */
  function pinnedEdge(drag: { edge?: TrimEdge; s: number; e: number; fps: number }, delta: number) {
    const inward = drag.edge === 'end' ? delta < 0 : drag.edge === 'start' ? delta > 0 : false;
    return inward && drag.e - drag.s <= 1 / drag.fps + 1e-6;
  }
  function handOff(drag: NonNullable<typeof gesture.current>, delta: number) {
    const box = canvasElement.current?.getBoundingClientRect?.();
    if (!box) return null;
    const x = drag.x - box.left;
    const near = joins.filter(j => Math.abs(x - j.atS * drag.scale) <= 10).sort((a, b) => Math.abs(x - a.atS * drag.scale) - Math.abs(x - b.atS * drag.scale));
    // The pointer's side of each join first, then its other side.
    const sides = near.flatMap(j => { const before = x < j.atS * drag.scale, end = { index: j.index, edge: 'end' as const }, start = { index: j.index + 1, edge: 'start' as const }; return before ? [end, start] : [start, end]; });
    for (const side of sides) {
      const next = pieceGesture(side.index);
      if (!next || (next.piece === drag.piece && side.edge === drag.edge) || pinnedEdge({ ...next, edge: side.edge }, delta)) continue;
      return { ...next, edge: side.edge };
    }
    return null;
  }
  function joinHit(event: React.PointerEvent) {
    const target=event.target as HTMLElement | null;
    if(target?.closest?.('[data-auto-correct-ready]'))return;
    const card=target?.closest?.<HTMLElement>('[data-transition-card]');
    const box=canvasElement.current?.getBoundingClientRect?.();
    if(!box)return;
    const x=event.clientX-box.left;
    // FIX4: the trim zone on each side of a join is that clip's own (a quarter of a narrow clip), so its middle selects it.
    const join=joins.filter(j=>Math.abs(x-j.atS*scale)<=trimZone(widths[x<j.atS*scale ? j.index : j.index+1] ?? 0)).sort((a,b)=>Math.abs(x-a.atS*scale)-Math.abs(x-b.atS*scale))[0];
    if(!join)return;
    const before=x<join.atS*scale,index=join.index+(before?0:1),edge:TrimEdge=before?'end':'start';
    return pieces[index] ? {index,edge,join:card?Number(card.dataset.transitionCard):undefined} : undefined;
  }
  function updateGesture(event: React.PointerEvent) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!drag.edge && !drag.moved && Math.abs(event.clientX-drag.x)<4) return;
    drag.moved = true; suppressClick.current = true;
    const delta = (event.clientX-drag.x)/drag.scale;
    if (drag.edge) {
      const other = pinnedEdge(drag, delta) ? handOff(drag, delta) : null;
      if (other) {
        Object.assign(drag, other, { selected: [other.piece], join: undefined });
        onSelectPiece?.(other.piece, false); anchor.current = other.piece; setSelectedEdge({ piece: other.piece, edge: other.edge });
      }
      const shape={s:drag.s,e:drag.e,timelineS:drag.start,lengthS:drag.base.pieces.filter(p=>p.layer===0 && p.piece===drag.piece).at(-1)!.endS-drag.start};
      const bounds=drag.musical ? drag.base.musicTrimBounds?.[drag.piece] : undefined;
      const result = bounds ? musicalTrim(shape,drag.edge,delta,drag.sourceDuration,drag.speed,drag.fps,grid,drag.targets,drag.scale,event.altKey || !snapping,bounds)
        : {...trimEdge(shape,drag.edge,delta,drag.sourceDuration,drag.speed,drag.fps,drag.targets,drag.scale,event.altKey || !snapping),snap:undefined};
      flashBeat(result.snap);
      const edit: CutEdit = {kind:"trim",piece:drag.piece,s:result.s,e:result.e,magnetic:true}; drag.edit = edit; drag.limit = result.limit;
      const plan = magneticPreview(drag.base,edit), spans = plan.pieces.filter(p=>p.layer===0 && p.piece===drag.piece);
      const length = spans.at(-1)!.endS-spans[0].startS;
      const seek = drag.edge === "start" ? spans[0].startS : Math.max(spans[0].startS,spans.at(-1)!.endS-1/(draft?.fps ?? 25));
      drag.plan = plan;
      if (canvasElement.current?.querySelectorAll && player.current?.trimPreview) {
        paintTrim(canvasElement.current,plan,drag.piece,drag.scale,length,result.limit,seek);
        paintBeatJoins(plan);
        player.current.trimPreview(plan,seek);
      } else {
        // The renderer-only host has no mounted geometry or native player.
        setDragging({piece:drag.piece,edge:drag.edge,length,limit:result.limit});
        previewBase.current=drag.base; setLocalPlan(plan); onPreview?.(edit,seek);
      }
    } else {
      if(drag.selected.length>1) {
        const order=magneticSpans(drag.base).map(p=>p.piece),at=snappedTime(drag.start+delta,event.altKey);
        const to=order.filter((p,i)=>!drag.selected.includes(p) && at>drag.starts[i]+drag.lengths[i]/2).length;
        const result=moveSelection(order,drag.selected,to);drag.edit=result.edit;drag.nextSelection=result.selected;drag.nextAnchor=result.order.indexOf(anchor.current ?? drag.piece);
        if(result.edit.kind==='batch' && result.edit.edits.length) {
          const plan=magneticPreview(drag.base,result.edit),fit=fitPlacement(plan,to,grid,drag.scale,sourceRate,event.altKey || !snapping);
          if(fit) {
            const prior=magneticSpans(plan).findIndex(p=>p.piece===fit.trim.piece);
            drag.edit={...result.edit,edits:[...result.edit.edits,{...fit.trim,piece:prior}]};
            previewBase.current=drag.base;setLocalPlan(fit.plan);onPreview?.(drag.edit);flashBeat(fit.snap);
          } else previewGesture(result.edit,drag.base);
        }
        else {drag.edit=undefined;setLocalPlan(null);onPreview?.(null);}
        return;
      }
      const from = drag.base.pieces.filter(p=>p.layer===0).map(p=>p.piece).filter((p,i,all)=>all.indexOf(p)===i).indexOf(drag.piece);
      const to = insertionAt(drag.starts,drag.lengths,drag.start+drag.lengths[from]/2+delta,from);
      const edit: CutEdit = {kind:"move",piece:drag.piece,to};
      const plan=magneticPreview(drag.base,edit), fit=to!==from ? fitPlacement(plan,to,grid,drag.scale,sourceRate,event.altKey || !snapping) : undefined;
      // Saved batches address the new piece order; preview keeps original ids.
      const prior=fit && magneticSpans(plan).findIndex(p=>p.piece===fit.trim.piece);
      drag.edit=fit ? {kind:'batch',label:'Move clip to music',edits:[edit,{...fit.trim,piece:prior!}]} : edit;
      flashBeat(fit?.snap);setDragging({piece:drag.piece,to,length:drag.lengths[from]});
      if(fit){previewBase.current=drag.base;setLocalPlan(fit.plan);onPreview?.(drag.edit);}
      else previewGesture(edit,drag.base);
    }
  }
  function endGesture(event: React.PointerEvent, cancel = false) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); gesture.current = null;
    if(drag.edge)onTrimGesture?.(false);
    player.current?.trimPreview?.(null);
    if(drag.plan && canvasElement.current?.querySelectorAll)paintTrim(canvasElement.current,drag.plan,-1,drag.scale,0);
    const readout=canvasElement.current?.closest?.('[data-timeline]')?.querySelector<HTMLElement>('[data-trim-readout]');
    if(readout)readout.hidden=true;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const unchanged = !drag.edit || (drag.edit.kind === "move" && drag.edit.to === drag.piece) || (drag.edit.kind === "trim" && drag.edit.s===drag.s && drag.edit.e===drag.e);
    // FIX5: a drag that can't save says why (the saveGesture guard below would otherwise drop it silently).
    const waiting = !cancel && drag.moved && !unchanged && (savePending.current || savingNow());
    if (cancel || !drag.moved || unchanged || waiting) {
      if(canvasElement.current?.querySelectorAll)paintTrim(canvasElement.current,drag.base,-1,drag.scale,0,null,time);
      if(readout)readout.hidden=true;
      paintBeatJoins(drag.base);flashBeat();
      if (waiting) setTrimNote("Wait for the last change to save, then drag again");
      else if (!cancel && drag.moved && drag.edge) setTrimNote(trimLimitNote[drag.limit ?? ""] ?? "That edge didn't move. Drag further, or hold Option to skip snapping");
      if(!cancel && !drag.moved){if(drag.join!==undefined)onSelectJoin?.(drag.join);else {selectClick(drag.piece,{});if(!drag.edge)seekAtX(event.clientX);suppressClick.current=true;}}
      onPreview?.(null); setLocalPlan(null); setDragging(null); return;
    }
    void saveGesture(drag.edit!).then(saved=>{if(saved && mounted.current && drag.nextSelection){selectMany(drag.nextSelection);anchor.current=drag.nextAnchor ?? drag.nextSelection.at(-1) ?? null;}});
  }
  useEffect(() => { gesture.current=null; setLocalPlan(null); setDragging(null); }, [version.version]);
  useEffect(() => () => { if (gesture.current) { player.current?.trimPreview?.(null); onPreview?.(null); } }, []);
  const soundCache = useRef<{draft:typeof viewDraft;version:CutVersion;clips:Shoot["clips"];blocks:ReturnType<typeof clipSoundBlocks>} | null>(null);
  if (!soundCache.current || soundCache.current.draft!==viewDraft || soundCache.current.version!==version || soundCache.current.clips!==shoot.clips) soundCache.current={draft:viewDraft,version,clips:shoot.clips,blocks:clipSoundBlocks(viewDraft,version,shoot.clips)};
  const soundPieces=soundCache.current.blocks;
  function previewVolume(value:number | null, piece?:number, layer:0|1=0) {
    if(!draft?.liveSound)return;
    if(value===null){clearLiveSoundPreview(draft,piece===undefined?'music':'pieces');return;}
    const live=draft.liveSound, prior=liveSoundPreviews.get(draft);
    if(piece===undefined){if(live.music)previewLiveSound(draft,{music:{...(prior?.music ?? live.music)!,gainDb:value ?? version.music?.gainDb ?? -18}});}
    else previewLiveSound(draft,{pieces:(prior?.pieces ?? live.pieces).map(p=>(p.piece===piece || p.piece!==undefined && chosen.includes(piece) && chosen.includes(p.piece)) && (p.layer ?? 0)===layer ? {...p,gainDb:clipLaneDb(version,value ?? (layer===1 ? version.pieceFx?.[piece]?.overlaySound?.gainDb : version.pieceFx?.[piece]?.gainDb) ?? 0)} : p)});
  }
  function ownMuted(piece:number,layer=0) { if(layer===1)return version.pieceFx?.[piece]?.overlaySound?.muted ?? !version.clipSoundDefaultOn; return version.pieceFx?.[piece]?.muted ?? defaultClipMuted(version,version.pieces?.[piece]?.kind === "broll"); }
  async function changeSound(edit: Extract<CutEdit,{kind:"clipSound"|"laneLevel"}>) {
    const guarded=edit.kind!=='laneLevel';
    if (savingNow() || guarded && savePending.current) return;  // FIX4: the live flag, as for saveGesture
    if(guarded)savePending.current=true;
    setDropError(null);setSoundMenu(null);setLaneMenu(null);
    try { await onEdit(edit.kind==='clipSound' && edit.piece!==undefined && chosen.includes(edit.piece) && chosen.length>1 ? selectionBatch(chosen,`Change sound on ${chosen.length} clips`,piece=>({...edit,piece})) : edit); } catch { setDropError("Couldn't save clip sound. Try again."); } finally {if(guarded)savePending.current=false;}
  }
  useEffect(()=>{
    if (!soundMenu) return;
    const close=()=>setSoundMenu(null);
    window.addEventListener("pointerdown",close);window.addEventListener("blur",close);
    return ()=>{window.removeEventListener("pointerdown",close);window.removeEventListener("blur",close);};
  },[soundMenu]);
  const hasVoiceover = !!draft?.voiceover?.some(l => l.take);
  // VO6 + VO7-8: voice pieces are cut by hand, Resolve style. Select (A): a click selects (⌘-click adds
  // or removes), an edge trims with a bracket cursor and a readout, the body moves and stops at its
  // neighbours, Esc cancels. Blade (B): a landing line follows the pointer, snapping within 8 px to a
  // word edge (⌥ cuts at the pointer), and a click cuts there. Every preview runs the same pure edit
  // main saves, so what lands is what was shown. Painting during a gesture goes straight to the DOM.
  const voiceSel = selectedVoices ?? [];
  const pictureEnd = viewDraft?.durationS ?? version.lengthS ?? 0;
  const [voicePlan,setVoicePlan]=useState<VoiceoverLine[] | null>(null);
  const [voiceDrop,setVoiceDrop]=useState(false);
  // VO7-13: `group` is the selection a body drag moves together; `targets` the reel times its edges snap to.
  const voiceDrag=useRef<{pointer:number;x:number;line:VoiceoverLine;edge?:TrimEdge;base:VoiceoverLine[];moved:boolean;edit?:VoiceEditOp;node:HTMLElement;group?:string[];targets:number[]} | null>(null);
  const voiceAnchor=useRef<string | null>(null);
  const bladeLine=useRef<HTMLSpanElement>(null), voiceReadout=useRef<HTMLSpanElement>(null), dropGhost=useRef<HTMLSpanElement>(null);
  // Sorted take words, cached per take until the shoot's audio list changes.
  const takeCache=useRef<{audio:Shoot["audio"] | undefined;takes:Map<string,VoiceTake | undefined>}>({audio:undefined,takes:new Map()});
  if(takeCache.current.audio!==shoot.audio)takeCache.current={audio:shoot.audio,takes:new Map()};
  const voiceTake=(file:string)=>{
    const cache=takeCache.current.takes;
    if(!cache.has(file)){const a=shoot.audio?.find(t=>t.file===file);cache.set(file,a ? {file,durationS:a.durationS,words:(a.transcript ?? []).flatMap(t=>t.words).filter(w=>Number.isFinite(w.s) && Number.isFinite(w.e) && w.e>w.s).sort((x,y)=>x.s-y.s)} : undefined);}
    return cache.get(file);
  };
  const snapRadius=(alt:boolean)=>alt || !snapping ? 0 : 8/scale;
  const reelAt=(clientX:number)=>{const r=canvasElement.current?.getBoundingClientRect();return r ? Math.max(0,(clientX-r.left)/scale) : 0;};
  const bladeAt=(event:{clientX:number;altKey:boolean},line:VoiceoverLine)=>bladeCut(line,voiceTake(line.take!.file)?.words ?? [],reelAt(event.clientX),snapRadius(event.altKey));
  function paintBlade(at:number|null) {
    const n=bladeLine.current;if(!n)return;
    if(at===null){n.hidden=true;return;}
    n.hidden=false;n.style.left=`${at*scale}px`;n.dataset.at=String(at);
  }
  function showReadout(reel:number,take:number) {
    const n=voiceReadout.current;if(!n)return;
    n.hidden=false;n.textContent=`${timelineTime(reel)} · take ${timelineTime(take)}`;
  }
  const hideReadout=()=>{if(voiceReadout.current)voiceReadout.current.hidden=true;};
  function voiceHover(event:React.PointerEvent<HTMLElement>,line:VoiceoverLine) {
    if(voiceDrag.current)return;
    const node=event.currentTarget;
    if(tool==='blade'){const at=bladeAt(event,line);paintBlade(at);node.style.cursor=at===null ? 'default' : BLADE_CURSOR;return;}
    const box=node.getBoundingClientRect(),edge=hitTrimEdge(event.clientX,box.left,box.width);
    node.style.cursor=edge==='start' ? TRIM_START_CURSOR : edge==='end' ? TRIM_END_CURSOR : 'grab';
  }
  function voiceDown(event:React.PointerEvent<HTMLButtonElement>,line:VoiceoverLine) {
    if(!event.isPrimary || event.button!==0 || busy || !draft?.voiceover)return;
    event.preventDefault();event.stopPropagation();pauseFollowing();
    if(tool==='blade'){
      // One click cuts one piece where the line showed; the playhead stays put. A seam does nothing.
      const at=bladeAt(event,line);
      // Only state that changes is set, so the cut renders in one pass.
      if(at!==null){if(chosen.length)selectMany([]);if(selectedGap)onSelectGap?.(null);onBlade?.(line.id,at);}
      return;
    }
    if(chosen.length)selectMany([]);if(selectedGap)onSelectGap?.(null);
    // VO7-13: ⌘-click adds or removes one piece; Shift-click selects the run from the last-clicked piece. Neither seeks.
    if(event.metaKey || event.ctrlKey || event.shiftKey){
      const order=[...committedVoice].sort((a,b)=>a.s-b.s).map(l=>l.id),next=clickSelection(voiceSel,line.id,voiceAnchor.current,order,event);
      onSelectVoices?.(next);if(!event.shiftKey)voiceAnchor.current=next.includes(line.id) ? line.id : next.at(-1) ?? null;return;
    }
    player.current?.pause?.();
    const box=event.currentTarget.getBoundingClientRect(),edge=hitTrimEdge(event.clientX,box.left,box.width);
    // A body drag on a piece of a selection moves the whole selection; an edge trims that piece alone.
    const group=!edge && voiceSel.length>1 && voiceSel.includes(line.id) ? [...voiceSel] : undefined;
    if(!group && (voiceSel.length!==1 || voiceSel[0]!==line.id))onSelectVoices?.([line.id]);event.currentTarget.focus({preventScroll:true});
    voiceAnchor.current=line.id;
    const base=draft.voiceover.filter(l=>l.take),moving=new Set(group ?? [line.id]);
    // The dragged piece's edges snap to the playhead, 0:00, picture cuts and the voice it isn't moving with.
    const targets=[liveTime?.now() ?? time,0,...starts,elapsed,...base.filter(l=>!moving.has(l.id)).flatMap(l=>[l.s,l.s+l.take!.e-l.take!.s])];
    voiceDrag.current={pointer:event.pointerId,x:event.clientX,line,edge,base,moved:false,node:event.currentTarget,group,targets};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function voiceMove(event:React.PointerEvent<HTMLElement>,line:VoiceoverLine) {
    const drag=voiceDrag.current;
    if(!drag || drag.pointer!==event.pointerId){voiceHover(event,line);return;}
    event.preventDefault();event.stopPropagation();
    if(!drag.moved && Math.abs(event.clientX-drag.x)<4)return;
    drag.moved=true;
    const delta=(event.clientX-drag.x)/scale,base=drag.line,t=base.take!,words=voiceTake(t.file)?.words ?? [];
    if(drag.edge) {
      // Snaps by the Blade's rule (8 px, earlier edge on a tie); ⌥ trims freely. The take's own edges stop it.
      const want=(drag.edge==='start' ? base.s : base.s+t.e-t.s)+delta;
      const to=snapToEdge(base,drag.edge==='start' ? words.map(w=>w.s) : words.map(w=>w.e),want,snapRadius(event.altKey)).at;
      drag.edit={kind:'voiceover',op:'trim',line:base.id,edge:drag.edge,to,free:true};
    } else {
      // Snapping applies to the dragged piece's edges, within 8 px; ⌥ moves freely.
      let s=base.s+delta;const radius=snapRadius(event.altKey),length=t.e-t.s;
      if(radius){let best:number | null=null;for(const at of drag.targets)for(const d of [at-s,at-(s+length)])if(Math.abs(d)<=radius+1e-9 && (best===null || Math.abs(d)<Math.abs(best)))best=d;if(best!==null)s+=best;}
      drag.edit={kind:'voiceover',op:'move',line:base.id,s,...(drag.group ? {lines:drag.group} : {})};
    }
    try {
      const next=applyVoiceEdit(drag.base,drag.edit,voiceTake,()=>'preview'),moved=next.find(l=>l.id===base.id);
      setVoicePlan(next);
      if(moved?.take)showReadout(drag.edge==='end' ? moved.s+moved.take.e-moved.take.s : moved.s,drag.edge==='end' ? moved.take.e : moved.take.s);
    } catch { /* keeps the last good preview */ }
  }
  function cancelVoiceDrag() {
    const drag=voiceDrag.current;if(!drag)return false;
    voiceDrag.current=null;setVoicePlan(null);hideReadout();
    try{if(drag.node.hasPointerCapture(drag.pointer))drag.node.releasePointerCapture(drag.pointer);}catch{/* already released */}
    return true;
  }
  function voiceUp(event:React.PointerEvent,cancel=false) {
    const drag=voiceDrag.current;if(!drag || drag.pointer!==event.pointerId)return;
    voiceDrag.current=null;hideReadout();
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    let after:VoiceoverLine | undefined;
    try{after=drag.edit ? applyVoiceEdit(drag.base,drag.edit,voiceTake,()=>'preview').find(l=>l.id===drag.line.id) : undefined;}catch{after=undefined;}
    const before=drag.base.find(l=>l.id===drag.line.id);
    const same=!!before && !!after && before.s===after.s && before.take?.s===after.take?.s && before.take?.e===after.take?.e;
    if(cancel || !drag.moved || !drag.edit || same){
      setVoicePlan(null);
      // A click seeks to where it landed, inside the picture; past the picture's end the playhead stays.
      if(!cancel && !drag.moved && !drag.edge && reelAt(event.clientX)<pictureEnd)seekAtX(event.clientX);
      // A plain click on one piece of a selection selects that piece alone.
      if(!cancel && !drag.moved && drag.group)onSelectVoices?.([drag.line.id]);
      return;
    }
    const edit=drag.edit;setDropError(null);
    void Promise.resolve(onEdit(edit as unknown as CutEdit)).catch(()=>setDropError("Couldn't save that change. The timeline is back as it was.")).finally(()=>setVoicePlan(null));
  }
  const committedVoice=draft?.voiceover?.filter(l=>l.take) ?? [];
  const voiceLines=voicePlan ?? committedVoice;
  const sameGap=(a?:{s:number;e:number} | null,b?:{s:number;e:number} | null)=>!!a && !!b && Math.abs(a.s-b.s)<1e-6 && Math.abs(a.e-b.e)<1e-6;
  // VO7-8 drops: a take from the take viewer, or an audio file from Finder, lands on the Voiceover lane.
  // The ghost shows the real length and where it lands: snapped (8 px) to the playhead, 0:00 and
  // picture cuts, then the Insertion rule (it never overlaps; otherwise it follows the latest voice).
  const takeDragNow=useRef<TakeDrag | null>(null);
  useEffect(()=>{
    // The take viewer sets its data on dragstart; this bubble listener reads it then (drag data is only
    // readable on dragstart and drop), so the ghost knows the take's real length while dragging.
    const start=(event:DragEvent)=>{try{const raw=event.dataTransfer?.getData(TAKE_DRAG_TYPE);takeDragNow.current=raw ? JSON.parse(raw) as TakeDrag : null;}catch{takeDragNow.current=null;}};
    const end=()=>{takeDragNow.current=null;if(dropGhost.current)dropGhost.current.hidden=true;setVoiceDrop(false);};
    window.addEventListener('dragstart',start);window.addEventListener('dragend',end);window.addEventListener('drop',end);
    return()=>{window.removeEventListener('dragstart',start);window.removeEventListener('dragend',end);window.removeEventListener('drop',end);};
  },[]);
  const isVoiceDrag=(transfer:DataTransfer)=>transfer.types.includes(TAKE_DRAG_TYPE) || transfer.types.includes('Files') && Array.from(transfer.items ?? []).some(item=>item.kind==='file' && item.type.startsWith('audio/'));
  function voiceLanding(clientX:number,alt:boolean,length:number) {
    let at=reelAt(clientX);
    const radius=snapRadius(alt);
    if(radius){const near=[time,0,...starts,elapsed].filter(t=>Math.abs(t-at)<=radius).sort((a,b)=>Math.abs(a-at)-Math.abs(b-at) || a-b)[0];if(near!==undefined)at=near;}
    return voiceInsertionAt(committedVoice,at,length);
  }
  function paintGhost(clientX:number,alt:boolean) {
    const n=dropGhost.current;if(!n)return;
    const take=takeDragNow.current,length=take ? Math.max(0,take.e-take.s) : 0,land=voiceLanding(clientX,alt,length);
    n.hidden=false;n.style.left=`${land.at*scale}px`;n.style.width=`${Math.max(2,length*scale)}px`;
    n.dataset.at=String(land.at);n.dataset.length=String(length);n.dataset.appended=String(land.appended);
    n.textContent=`${timelineTime(land.at)}${land.appended ? ' · after your voiceover' : ''}`;
  }
  const hideGhost=()=>{if(dropGhost.current)dropGhost.current.hidden=true;};
  useShortcuts("precuts", [
    {id:'timeline-select-all',keys:['Cmd+a'],label:'Select all clips',scope:'precuts',handler:()=>{selectMany(pieces.map(p=>p.sourceIndex));anchor.current=pieces.at(-1)?.sourceIndex ?? null;}},
    {id:'timeline-clear-selection',keys:['Escape'],label:'Clear clip selection',scope:'precuts',enabled:chosen.length>0 || selectingBox || voiceSel.length>0 || !!selectedGap || tool==='blade',handler:()=>{if(boxDrag.current && viewport.current){endBox({pointerId:boxDrag.current.pointer,currentTarget:viewport.current} as unknown as React.PointerEvent,true);return;}
      // VO7-8: Esc in Blade returns to Select first; then it clears the selection.
      if(tool==='blade'){paintBlade(null);onTool?.('select');return;}
      selectMany([]);setSelectedEdge(null);onSelectVoices?.([]);onSelectGap?.(null);}},
    {id:'timeline-snapping',keys:['n'],label:'Toggle timeline snapping',scope:'precuts',handler:toggleSnapping},
    {id:'timeline-audio-scrub',keys:['Shift+s'],label:'Toggle audio scrub',scope:'precuts',handler:toggleAudioScrub},
    {id:"mute-clip-sound",keys:["m"],label:"Mute or unmute this clip's sound",scope:"precuts",enabled:selectedPiece!=null,handler:(event:KeyboardEvent)=>{if(holdWhileSaving(event))return;if(selectedPiece!=null){const layer=soundLayer===1 && version.pieces?.[selectedPiece]?.overlay ? 1 : 0;void changeSound({kind:"clipSound",piece:selectedPiece,layer,muted:!ownMuted(selectedPiece,layer)});}}},
    {id:"close-sound-menu",keys:["Escape"],label:"Close clip sound menu",scope:"precuts",enabled:!!soundMenu,handler:()=>setSoundMenu(null)},
    ...([-1,1] as const).map(direction => ({id:`trim-edge-${direction}`,keys:[direction<0?",":"."],label:direction<0?"Move selected edge back one frame":"Move selected edge forward one frame",scope:"precuts",enabled:!!selectedEdge && selectedEdge.piece===selectedPiece,handler:(event:KeyboardEvent) => {if(holdWhileSaving(event))return;
      const piece = pieces.find(p=>p.sourceIndex===selectedPiece), source=shoot.clips.find(c=>c.id===piece?.clipId);
      if (!piece || !selectedEdge || !draft || !source?.meta) return;
      const fps=source.meta.fps || draft.fps || 25, speed=version.pieceFx?.[piece.sourceIndex]?.speed ?? 1;
      const result=trimEdge({...piece,timelineS:piece.timelineS ?? 0},selectedEdge.edge,direction/(draft.fps ?? 25),source.meta.durationS,speed,fps,[],scale,true);
      const edit: CutEdit={kind:"trim",piece:piece.sourceIndex,s:result.s,e:result.e,magnetic:true};
      previewGesture(edit,draft,selectedEdge.edge==="start"?piece.timelineS:((piece.timelineS??0)+(result.e-result.s)/speed-1/(draft.fps??25))); void saveGesture(edit);
    }})),
    ...([-1,1] as const).map(direction => ({id:`move-piece-${direction}`,keys:[`Alt+${direction<0?"ArrowLeft":"ArrowRight"}`],label:direction<0?"Move clip one place earlier":"Move clip one place later",scope:"precuts",enabled:selectedPiece!=null && selectedPiece+direction>=0 && selectedPiece+direction<pieces.length,handler:(event:KeyboardEvent) => {if(holdWhileSaving(event))return;
      if (selectedPiece==null || !draft) return;
      // While an earlier move is still saving the screen keeps its piece numbers: the place is where the clip is now.
      const at=magneticSpans(draft).findIndex(p=>p.piece===selectedPiece),to=(at<0?selectedPiece:at)+direction;
      if(to<0 || to>=magneticSpans(draft).length)return;
      const edit: CutEdit={kind:"move",piece:selectedPiece,to}; previewGesture(edit,draft); void saveGesture(edit);
    }})),
    {id:"cancel-timeline-drag",keys:["Escape"],label:"Cancel timeline drag",scope:"precuts",enabled:!!dragging || !!voicePlan,handler:()=>{if(cancelVoiceDrag())return;gesture.current=null;onPreview?.(null);setLocalPlan(null);setDragging(null);}},
    // VO7-8/13: Alt+Arrow and comma/period nudge the selected voice (every selected piece) one frame; it stops at its neighbours.
    ...([-1,1] as const).map(direction => ({id:`voice-nudge-${direction}`,keys:[direction<0?"Alt+ArrowLeft":"Alt+ArrowRight",direction<0?",":"."],label:direction<0?"Nudge voice one frame earlier":"Nudge voice one frame later",scope:"precuts",enabled:voiceSel.length>0 && !voicePlan,handler:(event:KeyboardEvent) => {if(holdWhileSaving(event))return;
      const group=committedVoice.filter(l=>voiceSel.includes(l.id)).sort((a,b)=>a.s-b.s),line=group[0];if(!line)return;
      const edit:VoiceEditOp={kind:'voiceover',op:'move',line:line.id,s:Math.max(0,line.s+direction/(draft?.fps ?? 25)),...(group.length>1 ? {lines:group.map(l=>l.id)} : {})};
      let moved:VoiceoverLine | undefined;try{moved=applyVoiceEdit(committedVoice,edit,voiceTake,()=>'preview').find(l=>l.id===line.id);}catch{return;}
      if(!moved || Math.abs(moved.s-line.s)<1e-9)return;
      setDropError(null);void Promise.resolve(onEdit({...edit,s:moved.s} as unknown as CutEdit)).catch(()=>setDropError("Couldn't save that change. The timeline is back as it was."));
    }})),
  ]);
  // FIX4: a key pressed while a save with no instant plan is in flight (a duplicate, an insert) used to do nothing.
  // One owner per key: the shortcut handler that the key reaches asks `saving()` (the page's live flag, the same one its
  // edits check) and either runs it now or hands it here, never both. A held key keeps what it was pressed on (selection,
  // trim edge, playhead), by clip identity since that save renumbers pieces, and lands in order once the save shows.
  type HeldKey = { init: KeyboardEventInit; clips: string[]; voices: string[]; gap: { s: number; e: number } | null;
    edge: { clip: string; edge: TrimEdge } | null; at: { clip: string; offset: number } | null };
  const held = useRef<HeldKey[]>([]), replaying = useRef(false);
  const [heldCount, setHeldCount] = useState(0), [heldNote, setHeldNote] = useState<string | null>(null);
  const savingNow = () => keyGate ? keyGate.current.saving : busy;
  const keyOf = (sourceIndex: number) => { const i = pieces.findIndex(p => p.sourceIndex === sourceIndex); return i < 0 ? null : pieceKeys[i]; };
  // The gate opens once the saved version is what the timeline shows: its own pieces, in its own order (a draft still
  // loading is the old one). Held keys then replay. A save that made nothing, or failed, opened the gate already; a
  // draft that never arrives opens it after a while rather than never.
  const shows = (v: number) => {
    if (version.version !== v || !draft || !version.pieces) return false;
    const spine = magneticSpans(draft);
    return spine.length === version.pieces.length && spine.every((span, i) => draft.pieces.find(p => p.layer === 0 && (p.piece ?? -1) === span.piece)?.clipId === version.pieces![i]?.clipId);
  };
  // What a held key was pressed on comes from a render whose pieces are the version's own. Between a save landing and
  // its draft arriving, the selection may already use the new numbering while the pieces are still the old ones; a key
  // pressed then keeps what the last consistent render had.
  const consistent = shows(version.version);
  const pressedOn = () => {
    const now = liveTime?.now() ?? time, under = pieces.findIndex((_, i) => now >= starts[i] && now < starts[i] + lengths[i]);
    return { clips: selectionNow.current.flatMap(p => keyOf(p) ?? []), voices: [...voiceSel], gap: selectedGap ?? null,
      edge: selectedEdge && keyOf(selectedEdge.piece) ? { clip: keyOf(selectedEdge.piece)!, edge: selectedEdge.edge } : null,
      at: under >= 0 ? { clip: pieceKeys[under], offset: now - starts[under] } : null };
  };
  const lastConsistent = useRef<ReturnType<typeof pressedOn> | null>(null);
  if (consistent) lastConsistent.current = pressedOn();
  const hold = useRef<(event: KeyboardEvent) => void>(() => {});
  hold.current = event => {
    const on = consistent || !lastConsistent.current ? pressedOn() : lastConsistent.current;
    held.current.push({ init: { key: event.key, code: event.code, altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, bubbles: true, cancelable: true }, ...on });
    setHeldCount(held.current.length); setHeldNote(null);
  };
  /** True when the key was held for later (a save is in flight); the caller then does nothing now. */
  const holdWhileSaving = (event: KeyboardEvent | undefined) => { if (!event || !savingNow()) return false; hold.current(event); return true; };
  useEffect(() => {
    if (!holdKeys) return;
    holdKeys.current = event => hold.current(event);
    return () => { holdKeys.current = null; };
  }, [holdKeys]);
  const heldGeo = useRef({ pieces, pieceKeys, starts }); heldGeo.current = { pieces, pieceKeys, starts };
  const frames = (n = 2) => new Promise<void>(resolve => { const step = () => (n-- > 0 ? requestAnimationFrame(step) : setTimeout(resolve, 0)); step(); });
  async function replayHeld() {
    if (replaying.current) return;
    replaying.current = true;
    try {
      while (held.current.length && mounted.current && !savingNow()) {
        const k = held.current.shift()!; setHeldCount(held.current.length);
        const index = (clip: string) => heldGeo.current.pieceKeys.indexOf(clip);
        const clips = k.clips.map(index).filter(i => i >= 0).map(i => heldGeo.current.pieces[i].sourceIndex);
        if (k.clips.length && !clips.length) { setHeldNote('A key you pressed while saving was skipped: its clip is gone'); continue; }
        if (clips.length || selectionNow.current.length) { selectMany(clips); anchor.current = clips.at(-1) ?? null; }
        if (k.voices.length || voiceSel.length) onSelectVoices?.(k.voices);
        if (k.gap || selectedGap) onSelectGap?.(k.gap);
        const edgeAt = k.edge ? index(k.edge.clip) : -1;
        setSelectedEdge(k.edge && edgeAt >= 0 ? { piece: heldGeo.current.pieces[edgeAt].sourceIndex, edge: k.edge.edge } : null);
        const at = k.at ? index(k.at.clip) : -1;
        if (at >= 0) player.current?.seek(heldGeo.current.starts[at] + k.at!.offset);
        await frames(3);
        if (!mounted.current || savingNow()) { held.current.unshift(k); break; }
        // Replayed through the same shortcut handlers a press reaches, on what is on screen now.
        document.body.dispatchEvent(new KeyboardEvent('keydown', k.init));
        await frames(2);
      }
    } finally { replaying.current = false; setHeldCount(held.current.length); }
  }
  useEffect(() => {
    const gate = keyGate?.current;
    if (!gate) return;
    if (gate.saving && gate.until === null) return;  // still saving
    const open = () => { if (gate.saving) { gate.saving = false; gate.until = null; } if (held.current.length) void replayHeld(); };
    if (!gate.saving) { if (held.current.length && !busy) { const id = requestAnimationFrame(open); return () => cancelAnimationFrame(id); } return; }
    if (shows(gate.until!)) { const id = requestAnimationFrame(open); return () => cancelAnimationFrame(id); }
    const id = setTimeout(open, 10000); return () => clearTimeout(id);
  }, [busy, version.version, draft, keyGate]);
  // A timeline that goes away (another edit opened) never leaves the gate shut.
  useEffect(() => () => { const gate = keyGate?.current; if (gate?.saving && gate.until !== null) { gate.saving = false; gate.until = null; } }, [keyGate]);
  // The live clock is newer than `time` while playing; following uses it so a render never scrolls back.
  useEffect(() => { followAt(liveTime ? liveTime.now() : time); }, [activeIndex, progress, canvas, width, following]);
  function seekAtX(x: number) {
    const rect = canvasElement.current?.getBoundingClientRect();
    if (rect?.width) {
      player.current?.seek(snappedTime((x - rect.left) / scale));
      return;
    }
    const blocks = viewport.current?.querySelectorAll<HTMLElement>("[data-timeline-block]");
    let nearest: { index: number; fraction: number; distance: number } | null = null;
    for (const block of blocks ?? []) {
      const index = Number(block.dataset.timelineBlock);
      if (!pieces[index]) continue;
      const rect = block.getBoundingClientRect();
      if (!rect.width) continue;
      const fraction = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      const distance = Math.abs(x - (rect.left + fraction * rect.width));
      if (!nearest || distance < nearest.distance) nearest = { index, fraction, distance };
    }
    if (nearest) {
      const { index, fraction } = nearest;
      player.current?.seek(starts[index] + fraction * lengths[index]);
    }
  }
  function endScrub(event: React.PointerEvent<HTMLDivElement>) {
    if (scrub.current !== event.pointerId) return;
    scrub.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onScrub?.(false);
    pauseFollowing();
  }
  const captionCache=useRef<{draft:typeof viewDraft;version:CutVersion;blocks:ReturnType<typeof captionBlocks>}>();
  if(!captionCache.current || captionCache.current.draft!==viewDraft || captionCache.current.version!==version)captionCache.current={draft:viewDraft,version,blocks:captionBlocks(viewDraft ? viewDraft.titles : version.titles, pieces.map((piece,index)=>({...piece,timelineS:starts[index],lengthS:lengths[index]})),version.bigLines)};
  const cues=captionCache.current.blocks;
  const overlays = viewDraft?.overlays ?? [];
  // MOT1b: what a motion graphic's ticks snap to: his words and the music grid this timeline draws.
  const motionSource = useKept(() => ({ titles: viewDraft?.titles, captionSource: viewDraft?.captionSource, beats: grid.beats, fps: viewDraft?.fps }), [viewDraft?.titles, viewDraft?.captionSource, grid.beats, viewDraft?.fps]);
  // CAP4: a dragged punch tick snaps to where a caption word starts.
  const punchWords = useKept(() => timedCaptionWords(viewDraft ? viewDraft.titles : version.titles).map(w => w.s), [viewDraft?.titles, version.titles]);
  const thirdTiming = localPlan && previewBase.current ? magneticTime(magneticSpans(previewBase.current),magneticSpans(localPlan).map(p=>{
    const old=previewBase.current!.pieces.find(s=>s.layer===0 && s.piece===p.piece),next=localPlan.pieces.find(s=>s.layer===0 && s.piece===p.piece);
    return {...p,offsetS:old && next ? (next.inS-old.inS)/(version.pieceFx?.[p.piece]?.speed ?? 1) : 0};
  })) : null;
  const lowerThirds = (version.lowerThirds ?? []).map(item=>thirdTiming?.range(item) ?? item);
  const broll = viewDraft?.pieces.filter(piece => piece.layer === 1 && !(piece as import('../../../main/layout-math').LayoutPicture).layoutRegion) ?? [];
  const joins = pieces.slice(0, -1).map((piece, index) => draft?.joins?.find(join => join.index === index) ?? {
    index, atS: starts[index + 1], auto: version.joins?.[piece.sourceIndex] == null,
    choice: version.joins?.[piece.sourceIndex] ?? ((piece.broll || pieces[index + 1].broll) ? { kind: "cut" as const, sound: null } : version.transition ?? { kind: version.faceMatch === "off" ? "cut" as const : version.faceMatch ?? "ease" as const, sound: null }),
  });
  const joinIcons = { cut: TransitionCut, snap: Snap, ease: Ease, zoom: Zoom, whip: Whip, dissolve: Dissolve, ramp: Ramp };
  const sounds = [...soundBlocks(draft),...(version.sfx ?? []).map(item=>({id:item.id,s:item.atS,e:Math.min(duration,item.atS+(item.lengthS ?? ((draft?.liveSound?.effects.find(p=>p.id===item.id)?.endS ?? item.atS+.3)-item.atS))),label:item.name ?? 'Sound effect'}))];
  const soundSlots = soundLabelSlots(sounds, scale);  // REL09e: labels that would collide take the next free stretch, truncate or hide
  const lanes: { id: LaneId; label: string; icon: typeof Video; note?: string }[] = [
    { id: 'layouts', label: 'Layouts', icon: Video, note: 'Layout ranges' },
    { id: "video", label: "Video", icon: Video, note: "Preview only" },
    { id: "clip-sound", label: "Clip sound", icon: Sound },
    ...(soundPieces.some(p=>p.layer===1) ? [{id:"broll-sound" as const,label:"B-roll sound",icon:Sound}] : []),
    { id: "captions", label: "Captions", icon: Captions, note: "Preview only" },
    ...(hasVoiceover || voiceDrop || !draft?.liveSound ? [{ id: "voice" as const, label: draft?.voiceover?.some(l => l.take) ? "Voiceover" : "Voice", icon: Voice, note: draft?.voiceover?.some(l => l.take) ? "Mutes voiceover in preview" : "Mutes preview sound, including the mixed music and effects" }] : []),
    { id: "music", label: "Music", icon: Music, note: "Lane view only: music is part of the mixed preview sound" },
    { id: "overlays", label: "Overlays", icon: Overlays, note: "Preview only" },

    ...(sounds.length ? [{ id: "sound-effects" as const, label: "Sound effects", icon: Sound, note: "Lane view only: effects are part of the mixed preview sound" }] : []),
  ];

  const laneStyle = (id: LaneId) => ({ height: hidden[id] ? 20 : `var(--timeline-${id}-size, var(--timeline-${id === "video" ? "film" : "row"}-height))` });
  const voiceFades = voiceJoinFades(voiceLines);
  const voiceLane = <div data-lane="voice" data-hidden={!!hidden["voice"]} data-tool={tool} className="st-timeline-lane relative" style={laneStyle("voice")}
    onPointerMove={event=>{if(tool==='blade' && !(event.target as HTMLElement).closest?.('[data-voiceover-line]'))paintBlade(null);}} onPointerLeave={()=>paintBlade(null)}>
    {hasVoiceover && !voicePlan && voiceGaps(committedVoice).map(gap => { const picked=sameGap(selectedGap,gap); return <Tile key={`gap-${gap.s}`} type="button" data-voice-gap={`${gap.s.toFixed(3)}-${gap.e.toFixed(3)}`} data-selected={picked} aria-pressed={picked} aria-label={`Gap from ${timelineTime(gap.s)} to ${timelineTime(gap.e)}`} title={tool==='blade' ? 'Gap' : 'Gap. Delete closes it'} disabled={busy}
      onPointerDown={event=>{event.stopPropagation();if(tool==='blade')event.preventDefault();}} onClick={()=>{if(tool==='blade')return;selectMany([]);onSelectVoices?.([]);onSelectGap?.(picked ? null : gap);}}
      className={`st-voice-gap absolute inset-y-1 rounded-md ${picked ? 'bg-accent/20' : 'hover:bg-ink/[0.05] focus-visible:bg-ink/[0.05]'} ${FOCUS}`} style={{ left: gap.s * scale, width: Math.max(2,(gap.e - gap.s) * scale), cursor: tool==='blade' ? 'default' : 'pointer' }} />; })}
    {hasVoiceover ? voiceLines.map(line => { const picked=voiceSel.includes(line.id), take=line.take!, fade=voiceFades.get(line.id), held=committedVoice.find(l=>l.id===line.id)?.take ?? take;
      return <Tile key={line.id} type="button" data-voiceover-line={line.id} data-selected={picked} aria-pressed={picked} data-fade-in={fade?.fadeInS ?? 0} data-fade-out={fade?.fadeOutS ?? 0}
        title={`${line.text} · ${tool==='blade' ? 'Click to cut here (Option cuts exactly at the pointer)' : `Drag an edge to trim (Option skips word snapping), drag to move. Cmd-click adds, Shift-click selects a run. S splits at the playhead, Delete ${closeGaps ? 'closes' : 'leaves'} the gap, Shift+Delete ${closeGaps ? 'leaves' : 'closes'} it`}`} disabled={busy}
        onPointerDown={event=>voiceDown(event,line)} onPointerMove={event=>voiceMove(event,line)} onPointerUp={event=>voiceUp(event)} onPointerCancel={event=>voiceUp(event,true)} onLostPointerCapture={event=>voiceUp(event,true)}
        onKeyDown={event=>{
          // Space plays and pauses (the editor's shortcut); Enter selects, as a click does.
          if(event.key==='Enter'){event.preventDefault();event.stopPropagation();selectMany([]);onSelectGap?.(null);onSelectVoices?.([line.id]);if(line.s<pictureEnd)player.current?.seek(line.s);}
        }}
        className={`st-timeline-block st-lane-audio absolute overflow-hidden rounded-lg text-left focus-visible:brightness-110 ${FOCUS}`} style={{ left: line.s * scale, width: (take.e - take.s) * scale, touchAction: "none", cursor: "grab", ...(picked ? { color: "var(--ink)" } : {}) }}>
        {/* The waveform is the committed span's; a trim in progress only moves its window, so nothing refetches mid-drag. */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 opacity-30" style={{ left: (held.s - take.s) * scale, width: (held.e - held.s) * scale }}><Waveform label="Voice piece waveform" root={shoot.root} file={take.file} from={held.s} to={held.e} /></span>
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 left-0.5 w-1 rounded-full" style={{ background: "currentColor", opacity: picked ? .5 : .2 }} /><span aria-hidden="true" className="pointer-events-none absolute inset-y-1 right-0.5 w-1 rounded-full" style={{ background: "currentColor", opacity: picked ? .5 : .2 }} />
        <span className="pointer-events-none relative z-[1] block truncate px-2">{line.text}</span></Tile>; }) : (draft?.voice || draft?.sound) && !voiceDrop && <button type="button" title={draft.voice ? "Measured voice waveform" : "Measured draft sound, including music and effects"} onClick={() => onInspect?.("audio-item")} className={`st-timeline-block absolute inset-x-0 flex items-center overflow-hidden rounded-lg st-lane-audio ${FOCUS}`}><Waveform sound={draft.voice?.url ?? draft.sound ?? undefined} measured={draft.voice?.peaks.length ? draft.voice.peaks : undefined} /></button>}
    <span ref={bladeLine} hidden aria-hidden="true" data-blade-line className="pointer-events-none absolute -inset-y-1 z-20 w-px bg-accent" style={{ left: 0 }} />
    <span ref={dropGhost} hidden aria-hidden="true" data-drop-ghost className="pointer-events-none absolute inset-y-0 z-20 flex items-center overflow-hidden whitespace-nowrap rounded-lg bg-accent/25 px-2 text-micro text-ink" style={{ left: 0 }} />
  </div>;
  function soundLane(layer:0|1) {
    const id=layer===0 ? "clip-sound" : "broll-sound";
    return <div data-lane={id} data-hidden={!!hidden[id]} className="st-timeline-lane relative" style={laneStyle(id)}>
      <AnimatePresence initial={false}>{soundPieces.filter(p=>p.layer===layer).map(block=><motion.div key={`${version.pieces?.[block.piece]?.id ?? block.clipId}-${block.piece}`} initial={{opacity:0}} animate={{opacity:1,left:block.startS*scale,width:(block.endS-block.startS)*scale}} exit={{opacity:0}} transition={gesture.current?.edge || reduced ? instant : spring.sheet} layout={false} data-clip-sound={block.piece} data-muted={block.muted} data-selected={chosen.includes(block.piece)} className="st-clip-sound absolute flex overflow-hidden rounded-md" style={{left:block.startS*scale,width:(block.endS-block.startS)*scale,height:"100%"}}
        onContextMenu={event=>{event.preventDefault();event.stopPropagation();if(!chosen.includes(block.piece))onSelectPiece?.(block.piece);setSoundLayer(layer);setSoundMenu({piece:block.piece,layer,x:event.clientX,y:event.clientY});}}>
        <Tile type="button" aria-label={`${layer===1 ? "B-roll sound" : "Sound"} for ${pieceName(shoot, version, block.piece)}`} aria-pressed={chosen.includes(block.piece)} onClick={()=>{setSoundLayer(layer);onSelectPiece?.(block.piece);}} className={`relative min-w-0 flex-1 overflow-hidden ${FOCUS}`}><Waveform label="Clip sound waveform" measured={block.measured} muted={block.muted} /></Tile>
        <VolumeLine endInset={28} label={`${layer===1 ? "B-roll sound" : "Sound"} volume for ${pieceName(shoot, version, block.piece)}`} value={(layer===1 ? version.pieceFx?.[block.piece]?.overlaySound?.gainDb : version.pieceFx?.[block.piece]?.gainDb) ?? 0} disabled={busy} onPreview={value=>previewVolume(value,block.piece,layer)} onCommit={async gainDb=>{try{await changeSound({kind:"clipSound",piece:block.piece,layer,gainDb});}finally{previewVolume(null,block.piece,layer);}}} />
        <Tile type="button" disabled={busy} aria-label={`${ownMuted(block.piece,layer) ? "Unmute" : "Mute"} ${pieceName(shoot, version, block.piece)}`} title={`${ownMuted(block.piece,layer) ? "Unmute" : "Mute"} this clip's sound (M)`} aria-pressed={ownMuted(block.piece,layer)} onClick={()=>{setSoundLayer(layer);if(!chosen.includes(block.piece))onSelectPiece?.(block.piece,false);void changeSound({kind:"clipSound",piece:block.piece,layer,muted:!ownMuted(block.piece,layer)});}} className={`relative z-10 w-6 shrink-0 ${FOCUS}`}>{block.muted ? <VolumeOff size={13} /> : <Volume size={13} />}</Tile>
      </motion.div>)}</AnimatePresence>
    </div>;
  }
  // VO7: a click on the ruler snaps (V31); once the pointer really moves, the scrub follows it freely
  // and the release lands exactly where the pointer let go. Option is always free.
  const rulerDrag = useRef<{ x: number; moved: boolean } | null>(null);
  function seekRuler(event: React.PointerEvent, final = false) {
    const rect = canvasElement.current?.getBoundingClientRect();
    const drag = rulerDrag.current;
    if (drag && !drag.moved && Math.abs(event.clientX - drag.x) > 3) drag.moved = true;
    if (rect) scrubSeek(snappedTime((event.clientX - rect.left) / scale, event.altKey || !!drag?.moved), final);
  }
  return <section {...laneResize} data-editor-timeline data-timeline aria-label="Storyboard timeline" className="st-timeline flex h-full min-h-0 flex-col rounded-2xl bg-surface text-small">
    {/* CH4: groups by job, apart by space and never a divider: history, the tool and clip actions, then time and zoom. */}
    <div className="st-timeline-bar">
      <div className="st-timeline-group">
        <Tooltip label={history?.undoLabel ? `Undo ${namedText(history.undoLabel)}` : "Undo"} state={busy ? "waits for the save to finish" : !history?.undoLabel ? "nothing to undo" : undefined} shortcut={keyGlyphs(shortcutKeys("undo", "precuts") ?? "Cmd+z")}>
          <button type="button" aria-label={history?.undoLabel ? `Undo ${namedText(history.undoLabel)}` : "Undo"} disabled={busy || !history?.undoLabel} onClick={history?.undo} className={`st-timeline-icon ${FOCUS}`}><Undo size={16} /></button></Tooltip>
        <Tooltip label={history?.redoLabel ? `Redo ${namedText(history.redoLabel)}` : "Redo"} state={busy ? "waits for the save to finish" : !history?.redoLabel ? "nothing to redo" : undefined} shortcut={keyGlyphs(shortcutKeys("redo", "precuts") ?? "Cmd+Shift+z")}>
          <button type="button" aria-label={history?.redoLabel ? `Redo ${namedText(history.redoLabel)}` : "Redo"} disabled={busy || !history?.redoLabel} onClick={history?.redo} className={`st-timeline-icon ${FOCUS}`}><Redo size={16} /></button></Tooltip>
      </div>
      {tools}
      <span ref={voiceReadout} role="status" data-voice-readout hidden className="st-timeline-feedback tnum" />
      {hint ? <span role="status" data-timeline-hint className="st-timeline-feedback">{hint}</span> : null}
      {trimNote && !heldCount ? <span role="status" data-trim-note className="st-timeline-feedback">{trimNote}</span> : null}
      {heldCount || heldNote ? <span role="status" data-held-keys={heldCount} className="st-timeline-feedback">{heldCount ? `${heldCount} ${heldCount === 1 ? 'key waits' : 'keys wait'} for the last change to save` : heldNote}</span> : null}
      <span role="status" data-trim-readout hidden={!dragging} className="st-timeline-feedback">{dragging ? dragging.edge ? `${dragging.length.toFixed(1)} s${dragging.limit ? ` · ${dragging.limit}` : ""}` : `Place ${(dragging.to ?? 0)+1}` : ''}</span>
      <span className="st-timeline-time tnum"><span ref={readout}>{timelineTime(time)}</span> <span ref={readoutTotal} className="st-timeline-total">{`/ ${timelineTime(duration)}`}</span></span>
      {/* Zoom has no keys yet (pinch or Command-scroll); Fit is Shift-Z, as registered. */}
      <div className="st-timeline-group">
        <Tooltip label="Zoom out"><button type="button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => changeZoom(zoom - .5)} className={`st-timeline-icon ${FOCUS}`}><Minus size={14} /></button></Tooltip>
        <Slider compact label="Timeline zoom" min={1} max={64} step={.1} defaultValue={1} value={zoom} onChange={value => changeZoom(value)} className="w-20" />
        <Tooltip label="Zoom in"><button type="button" aria-label="Zoom in" disabled={zoom >= 64} onClick={() => changeZoom(zoom + .5)} className={`st-timeline-icon ${FOCUS}`}><Plus size={14} /></button></Tooltip>
        <Tooltip label="Fit timeline" shortcut={keyGlyphs(shortcutKeys("zoom-fit", "precuts") ?? "Shift+z")}><button type="button" aria-label="Fit timeline" onClick={() => changeZoom(1, 0)} className={`st-timeline-icon ${FOCUS}`}><FitView size={15} /></button></Tooltip>
      </div>
    </div>
    <div className="st-timeline-lanes relative flex min-h-0 flex-1 overflow-hidden">
      {/* CH4: the timeline's switches live in the empty corner above the lane names. On is a soft neutral fill. */}
      <div role="group" aria-label="Timeline options" className="st-timeline-corner">
        <Tooltip label="Snapping" state={snapping ? "on" : "off"} shortcut={keyGlyphs(shortcutKeys("timeline-snapping", "precuts") ?? "n")} below>
          <Tile type="button" data-timeline-snapping aria-label="Snapping" aria-pressed={snapping} onClick={toggleSnapping} className={`st-timeline-toggle ${FOCUS}`}><Magnet size={17} /></Tile></Tooltip>
        <Tooltip label="Close gaps" state={closeGaps ? "on" : "off"} below>
          <Tile type="button" data-timeline-close-gaps aria-label="Close gaps" aria-pressed={closeGaps} onClick={()=>setTimelinePref({closeGaps:!timelinePrefs().closeGaps})} className={`st-timeline-toggle ${FOCUS}`}><CloseGap size={17} /></Tile></Tooltip>
        <Tooltip label="Audio scrub" state={audioScrub ? "on" : "off"} shortcut={keyGlyphs(shortcutKeys("timeline-audio-scrub", "precuts") ?? "Shift+s")} below>
          <Tile type="button" data-timeline-audio-scrub aria-label="Audio scrub" aria-pressed={audioScrub} onClick={toggleAudioScrub} className={`st-timeline-toggle ${FOCUS}`}><AudioScrub size={17} /></Tile></Tooltip>
      </div>
      <div className="st-timeline-labels" onWheel={event => { const row = viewport.current; if (row && !event.ctrlKey && !event.metaKey) row.scrollTop += event.deltaY; }}><div ref={labelsInner} className="st-timeline-labels-inner">{lanes.map(lane => {
        const soundLane:SoundLane|null=lane.id==='clip-sound'||lane.id==='broll-sound'?'clip-sound':lane.id==='voice'?'voice':lane.id==='music'?'music':lane.id==='sound-effects'?'effects':null;
        return <div key={lane.id} data-lane-size={lane.id} data-lane-label={lane.label} className="st-timeline-label" style={laneStyle(lane.id)}><lane.icon size={14} className="shrink-0" /><span>{lane.label}</span>{soundLane ? <>
          <LaneLevel label={`${lane.label} lane level`} value={laneDb(version,soundLane)} disabled={busy} onPreview={db=>{if(db===null){if(draft)clearLiveSoundPreview(draft,'laneLevels');return;}if(draft?.liveSound)previewLiveSound(draft,{laneLevels:{...version.laneLevels,[soundLane]:db ?? laneDb(version,soundLane)}});}} onCommit={db=>changeSound({kind:'laneLevel',lane:soundLane,db})} />
          <Tile type="button" disabled={busy} title={`${laneMuted(version,soundLane)?'Unmute':'Mute'} ${lane.label.toLowerCase()}. Right-click for all clips`} aria-label={soundLane==='clip-sound'?`${version.clipSoundMuted?'Unmute':'Mute'} all clip sound`:`${laneMuted(version,soundLane)?'Unmute':'Mute'} ${lane.label.toLowerCase()}`} aria-pressed={laneMuted(version,soundLane)} onClick={()=>void changeSound(soundLane==='clip-sound'?{kind:'clipSound',muted:!version.clipSoundMuted}:{kind:'laneLevel',lane:soundLane,muted:!laneMuted(version,soundLane)})} onContextMenu={event=>{event.preventDefault();setLaneMenu({lane:soundLane,view:lane.id,x:event.clientX,y:event.clientY});}} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();const r=event.currentTarget.getBoundingClientRect();setLaneMenu({lane:soundLane,view:lane.id,x:r.left,y:r.bottom});}}} className={`st-timeline-eye ${FOCUS}`}>{laneMuted(version,soundLane)?<VolumeOff size={14}/>:<Volume size={14}/>}</Tile>
          <Tile type="button" disabled={busy} aria-label={`${lane.label} speaker menu`} title="Lane options" className="st-lane-menu-button" onClick={event=>{const r=event.currentTarget.getBoundingClientRect();setLaneMenu({lane:soundLane,view:lane.id,x:r.left,y:r.bottom});}}><More size={12}/></Tile>
        </> : <Tile type="button" aria-label={`${hidden[lane.id] ? "Show" : "Hide"} ${lane.label.toLowerCase()} lane`} aria-pressed={!hidden[lane.id]} title={`${hidden[lane.id] ? "Show" : "Hide"} ${lane.label.toLowerCase()}. ${lane.note}`} onClick={() => toggleLane(lane.id)} className={`st-timeline-eye ${FOCUS}`}>{hidden[lane.id] ? <EyeOff size={13} /> : <Eye size={13} />}</Tile>}</div>;
      })}</div></div>
      <div ref={viewport} className="relative min-h-0 min-w-0 flex-1 overflow-auto" onScroll={() => {
        if (labelsInner.current && viewport.current) labelsInner.current.style.transform = `translateY(${-viewport.current.scrollTop}px)`;
        if (autoScrollLeft.current === null || Math.abs((viewport.current?.scrollLeft ?? 0) - autoScrollLeft.current) > 1) pauseFollowing();
      }} onKeyDownCapture={event => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) pauseFollowing();
      }} onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        const target = event.target as HTMLElement;
        const button = target.closest("button");
        if (button && !button.hasAttribute("data-timeline-piece")) return;
        if (!target.closest("[data-timeline-block]")) {startBox(event);return;}
        event.preventDefault(); pauseFollowing(); button?.focus({ preventScroll: true });
        if (button?.hasAttribute("data-timeline-piece") && button.dataset?.timelinePiece !== undefined) onSelectPiece?.(pieces[Number(button.dataset.timelinePiece)]?.sourceIndex);
        scrub.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); onScrub?.(true); seekAtX(event.clientX);
      }} onPointerMove={event => { if(boxDrag.current){updateBox(event);return;} if (gesture.current) {updateGesture(event);return;} if (scrub.current === event.pointerId) { event.preventDefault(); seekAtX(event.clientX); } }}
        onPointerUp={event => { if(boxDrag.current){endBox(event);return;} if (gesture.current) {endGesture(event);return;} if (scrub.current === event.pointerId) seekAtX(event.clientX); endScrub(event); }} onPointerCancel={event=>{endBox(event,true);endGesture(event,true);endScrub(event);}} onLostPointerCapture={event=>{endBox(event,true);endGesture(event,true);endScrub(event);}}>
        <div ref={canvasElement} onDragOver={event => {
          const sourceDrag=event.dataTransfer.types.includes(SOURCE_DRAG_TYPE), cardDrag=event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE);
          if(!busy && (sourceDrag || cardDrag)) {
            event.preventDefault();event.dataTransfer.dropEffect='copy';
            const box=event.currentTarget.getBoundingClientRect();
            const replace=event.metaKey ? replaceDropTarget(event.target,event.clientX) : null;
            const index=sourceInsertAt(version,viewDraft,(event.clientX-box.left)/scale);
            const fit=viewDraft && fitPlacement(viewDraft,index,grid,scale,sourceRate,event.altKey || !snapping);
            setSourceHoverS(fit?.snap ?? null);flashBeat(fit?.snap);
            setSourceHover(replace===null ? index : null);
            setReplaceHover(replace);return;
          }
          // VO7-7/8: a take (or its marked part) from the take viewer, or a Finder audio file, lands on the Voiceover lane.
          if (!busy && isVoiceDrag(event.dataTransfer)) {event.preventDefault();event.dataTransfer.dropEffect='copy';if(!voiceDrop)setVoiceDrop(true);paintGhost(event.clientX,event.altKey);return;}
          if (!busy && event.dataTransfer.types.includes("Files")) {event.preventDefault();event.dataTransfer.dropEffect='copy';}
        }} onDragLeave={event=>{if (!event.currentTarget.contains(event.relatedTarget as Node)) {setReplaceHover(null);setSourceHover(null);hideGhost();}}} onDragEnd={()=>{setReplaceHover(null);setSourceHover(null);}} onDrop={async event => {
          setSourceHover(null);
          if (busy || dropPending.current) return;
          const rect = canvasElement.current?.getBoundingClientRect();
          if (!rect) return;
          const at = Math.max(0,Math.min(duration,(event.clientX - rect.left) / scale));
          const clipId = event.dataTransfer.getData(LIBRARY_DRAG_TYPE);
          const replacePiece = event.metaKey ? replaceDropTarget(event.target,event.clientX) : null; setReplaceHover(null);
          const files = Array.from(event.dataTransfer.files).map(file => getApi().pathForFile(file)).filter(Boolean);
          const audioFiles = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('audio/') || /\.(wav|aiff?|caf|mp3|m4a|aac|flac)$/i.test(file.name)).map(file => getApi().pathForFile(file)).filter(Boolean);
          const takeLength = takeDragNow.current ? takeDragNow.current.e-takeDragNow.current.s : 0;
          hideGhost();
          event.preventDefault(); event.stopPropagation(); dropPending.current = true; setDropError(null);
          // Ordinary drops target a visible join. Option skips musical handle fitting.
          const insert = async (edit:CutEdit) => {
            if(edit.kind!=='insert')return onEdit(edit);
            const index=sourceInsertAt(version,viewDraft,at);
            const fit=viewDraft && fitPlacement(viewDraft,index,grid,scale,sourceRate,event.altKey || !snapping);
            return onEdit(fit ? {kind:'batch',label:'Insert clip on music',edits:[fit.trim,{...edit,at:index}]} : {...edit,at:index});
          };
          try {
            if(event.dataTransfer.types.includes(TAKE_DRAG_TYPE)){
              const take=readTakeDrag(event.dataTransfer);if(!take)throw new Error("Drag a take from the Script panel.");
              const land=voiceLanding(event.clientX,event.altKey,take.e-take.s || takeLength);
              await (onPlaceTake ? onPlaceTake(take.take,[{s:take.s,e:take.e}],land.at) : onEdit({kind:'voiceover',op:'placePlan',take:take.take,spans:[{s:take.s,e:take.e}],at:land.at} as unknown as CutEdit));
            }
            else if(audioFiles.length && onImportTake && onPlaceTake){
              // A Finder file is copied into the shoot as a take first, then placed by the same Insertion rule.
              const land=voiceLanding(event.clientX,event.altKey,0), imported=await onImportTake(audioFiles[0]);
              await onPlaceTake(imported.file,[{s:0,e:imported.durationS}],land.at);
            }
            else if(event.dataTransfer.types.includes(SOURCE_DRAG_TYPE)){const source=readSourceDrag(event.dataTransfer,shoot);await (replacePiece!==null ? onEdit({kind:'replace',piece:replacePiece,...source}) : insert({kind:'insert',at:sourceInsertAt(version,viewDraft,at),source}));}
            else if (clipId && replacePiece !== null) await onEdit({kind:"replace",piece:replacePiece,clipId});
            else if (clipId) await addLibraryItem(shoot, version, draft, clipId, at, insert, overlaySession);
            else if (files.length && version.layouts?.[libraryInsertIndex(shoot,version,draft,at)]?.kind === 'placeholder') await onEdit(fillPlaceholderEdit(libraryInsertIndex(shoot,version,draft,at),files[0]));
            else if (files.length && overlaySession) await addOverlayFiles(overlaySession, files, at);
            else throw new Error("Drop images in the desktop app, or use Library > Add files.");
          } catch (error) { setDropError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, "") : "Couldn't add that media."); }
          finally { dropPending.current = false; setVoiceDrop(false); }
        }} className="relative select-none" data-beat-detail={beatTicks.some(t=>t.kind==='beat')} style={{ width: canvas, minHeight:"100%", touchAction: "pan-y" }}><span ref={marquee} data-selection-box hidden className="st-selection-box pointer-events-none absolute z-40" />
          {guideCache.current.node}
          {sourceInsertS!==undefined && sourceHover===null && replaceHover===null && <span data-source-insert-marker aria-label={`Insert at ${timelineTime(sourceInsertS)}`} className="pointer-events-none absolute inset-y-0 z-20 w-1 rounded bg-accent" style={{left:Math.max(0,Math.min(canvas-4,sourceInsertS*scale-2))}}/>}
          {sourceHover !== null && <span data-source-drop={sourceHover} className="pointer-events-none absolute inset-y-0 z-30 w-2 rounded bg-accent" title="Insert here. Command over a shot to replace" style={{left:Math.max(0,Math.min(canvas-8,(sourceHoverS ?? (sourceHover===pieces.length?duration:starts[pieces.findIndex(p=>p.sourceIndex===sourceHover)] ?? duration))*scale-4))}}/>}
          <div data-editor-widget data-time-ruler role="slider" aria-label="Timeline playhead" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.min(time, duration)} aria-valuetext={formatDuration(time)} tabIndex={0}
            onKeyDown={event => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); const to = Math.max(0, Math.min(duration, (liveTime?.now() ?? time) + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : 1 / (draft?.fps ?? 25)))); player.current?.seek(to); if (!event.shiftKey) player.current?.blip?.(to, 1 / (draft?.fps ?? 25)); }
              if (event.key === "Home" || event.key === "End") { event.preventDefault(); event.stopPropagation(); player.current?.seek(event.key === "Home" ? 0 : duration); } }}
            onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); pauseFollowing(); event.currentTarget.setPointerCapture(event.pointerId); rulerDrag.current = { x: event.clientX, moved: false }; scrubbing(true); seekRuler(event); }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekRuler(event); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { seekRuler(event, true); event.currentTarget.releasePointerCapture(event.pointerId); } rulerDrag.current = null; scrubbing(false); }}
            onPointerCancel={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); rulerDrag.current = null; scrubbing(false); }} onLostPointerCapture={() => { rulerDrag.current = null; scrubbing(false); }}
            ref={ruler} className={`st-timeline-ruler cursor-ew-resize tnum text-micro text-muted ${FOCUS}`} style={{ touchAction: "none" }}>{ticks.map(tick => <span key={tick} data-ruler-second={tick} className="st-ruler-second absolute top-0" style={{ left: tick * scale }}>{formatDuration(tick)}</span>)}
            {grid.bars.map((at,i)=><span key={`bar-${i}`} data-ruler-bar={i+1} title={`Bar ${i+1}`} className="st-ruler-bar absolute bottom-0" style={{left:`${at/(duration || 1)*100}%`,transition:reduced ? undefined : sourceWindowTransition}}>{i+1}</span>)}
            {beatTicks.filter(t=>t.kind!=='bar').map(t=><span key={t.at} data-ruler-beat className="st-ruler-beat absolute bottom-0" style={{left:t.at*scale}} />)}</div>
          <LayoutLane version={version} draft={viewDraft} time={time} scale={scale} busy={busy} hidden={hidden.layouts} style={laneStyle('layouts')} onEdit={onEdit} onSelect={at=>{onDeselect?.();player.current?.seek(at);onInspect?.('layout');}} />
          {tool==='blade' && <style>{`[data-timeline] [data-lane="video"], [data-timeline] [data-lane="video"] *{cursor:not-allowed !important}`}</style>}
          <ol data-lane="video" data-hidden={!!hidden.video} className="st-timeline-lane relative" style={laneStyle("video")}
            onPointerDownCapture={event=>{if(tool==='blade'){event.preventDefault();event.stopPropagation();return;}if((event.target as HTMLElement).closest?.('.st-beat-hint'))return;const hit=joinHit(event);if(hit)beginGesture(event,hit.index,hit.edge,hit.join);}}
            onPointerMoveCapture={event=>{
              if(gesture.current)return;
              if(hoveredJoinEdge.current)hoveredJoinEdge.current.dataset.hovered='false';
              const hit=joinHit(event);
              hoveredJoinEdge.current=hit ? canvasElement.current?.querySelector<HTMLElement>(`[data-source-piece="${pieces[hit.index].sourceIndex}"] [data-trim-handle="${hit.edge}"]`) ?? null : null;
              if(hoveredJoinEdge.current)hoveredJoinEdge.current.dataset.hovered='true';
            }} onPointerLeave={()=>{if(hoveredJoinEdge.current)hoveredJoinEdge.current.dataset.hovered='false';}}>
            <AnimatePresence initial={false}>{pieces.map((piece, index) => {
              const active = activeIndex === index;
              return <motion.li key={pieceKeys[index]} data-timeline-block={index} data-clip-menu={piece.clipId} data-replace-piece={piece.sourceIndex} data-source-piece={piece.sourceIndex} data-selected={chosen.includes(piece.sourceIndex)} data-dragging={dragging?.piece === piece.sourceIndex} initial={{ opacity: 0 }} animate={{ opacity: 1, width: widths[index], y: replaceHover === piece.sourceIndex ? -4 : 0 }} exit={{ opacity: 0 }} transition={{ ...(gesture.current?.edge || reduced ? instant : spring.sheet), width: instant }} layout={false}
                onPointerDown={event => beginGesture(event,index)} onPointerMove={updateGesture} onPointerUp={event => endGesture(event)} onPointerCancel={event => endGesture(event,true)} onLostPointerCapture={event => endGesture(event,true)}
                className={`st-timeline-clip group absolute overflow-hidden rounded-md ${chosen.includes(piece.sourceIndex) ? "bg-accent/15" : active ? "bg-accent/10" : "bg-ground"}`} style={{ left: starts[index] * scale, width: widths[index], touchAction:"none" }}>
                <Tile type="button" data-clip-menu={piece.clipId} data-replace-piece={piece.sourceIndex} data-timeline-piece={index} title={`${piece.words || piece.label} · ${clipDuration(lengths[index])} · Drag to move (Option+Left/Right). Cmd-click adds; Shift-click selects a range`} aria-pressed={chosen.includes(piece.sourceIndex)} aria-current={active ? "true" : undefined} onClick={event => { setSoundLayer(0); if (suppressClick.current) {suppressClick.current=false;return;} selectClick(piece.sourceIndex,event); if(event.metaKey || event.ctrlKey || event.shiftKey)return; if (event.detail === 0) player.current?.seek(starts[index]); else seekAtX(event.clientX); }} aria-label={piece.words || piece.label} className={`st-filmstrip relative flex h-full w-full overflow-hidden rounded-md text-left ${FOCUS}`}>
                  {piece.span && piece.span.segments.length>1 ? piece.span.segments.map((span,n)=><span key={n} className="absolute top-0 flex h-full overflow-hidden" style={{left:(span.startS-starts[index])*scale,width:(span.endS-span.startS)*scale}}><Filmstrip shoot={shoot} clipId={span.clipId} start={span.inS} length={span.endS-span.startS} width={(span.endS-span.startS)*scale} span={span} /></span>) : <Filmstrip shoot={shoot} clipId={piece.clipId} start={piece.s} length={lengths[index]} width={widths[index]} span={piece.span} />}<DurationBadge seconds={lengths[index]} />{version.pieceFx?.[piece.sourceIndex] && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" title="Clip has its own controls" />}
                  {shoot.clips.some(c => c.id === piece.clipId && c.missing) ? <span data-missing-piece className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ground/60 text-micro text-muted"><span className="rounded-md bg-surface px-2 py-1">Missing</span></span> : null}
                  {updatingPreview(piece.clipId)}
                  {replaceHover === piece.sourceIndex ? <span data-replace-target className="pointer-events-none absolute inset-0 flex -translate-y-0.5 items-center justify-center rounded-md bg-accent/25 text-[12px] font-semibold text-ink"><span className="rounded-full bg-surface px-3 py-1">Replace</span></span> : null}
                  {version.layouts?.[piece.sourceIndex]?.kind === 'placeholder' ? <span data-placeholder={piece.sourceIndex} className="absolute inset-0 flex items-center justify-center rounded-md border border-dashed border-current bg-surface/90 px-2 text-[11px] text-accent">Shot needed: {version.layouts[piece.sourceIndex]!.note}</span> : null}
                </Tile>
                <PunchTicks piece={piece.sourceIndex} fx={version.pieceFx?.[piece.sourceIndex]} startS={starts[index]} endS={starts[index] + lengths[index]} scale={scale} timeline={viewDraft} words={punchWords} busy={busy} onEdit={onEdit} onSelect={() => onSelectPiece?.(piece.sourceIndex)} />
                {cutId && correction.ready.includes(piece.clipId ?? "") ? <button type="button" data-auto-correct-ready title="Auto correct ready" aria-label="Auto correct ready" className={`absolute right-2 top-2 rounded-full bg-ground px-1.5 py-0.5 text-accent ${FOCUS}`} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();void correctPiece(piece.sourceIndex,true);}}><Wand size={13} style={{fill:"currentColor",stroke:"none"}} /></button> : null}
                {draft && version.pieces && (["start","end"] as const).map(edge => <button key={edge} type="button" data-trim-handle={edge} aria-label={`Trim ${edge} of ${pieceName(shoot, version, piece.sourceIndex)}`} title={`Drag to trim ${edge}. Option skips snapping. Click, then , or . for one frame.`}
                  onPointerDown={event=>beginGesture(event,index,edge)} onClick={event=>{event.stopPropagation();if(suppressClick.current){suppressClick.current=false;return;}setSelectedEdge({piece:piece.sourceIndex,edge});onSelectPiece?.(piece.sourceIndex);}}
                  className={`st-timeline-trim st-timeline-trim-${edge}`} data-selected={selectedEdge?.piece===piece.sourceIndex && selectedEdge.edge===edge} disabled={busy} />)}
                {active && <span aria-hidden="true" data-timeline-playhead className="pointer-events-none invisible absolute inset-y-0 w-px bg-accent" style={{ left: `clamp(0px, ${progress * 100}%, calc(100% - 1px))` }} />}
              </motion.li>;
            })}</AnimatePresence>
            {starts.slice(1).map((at,i)=>{
              const mark=joinBeat(grid,at,draft?.fps ?? 25);if(!mark)return null;
              const snap=viewDraft && mark.frames ? snapJoinToBeat(viewDraft,i+1,grid,sourceRate) : undefined;
              return <li key={`beat-${i}`} data-video-beat-join={i} data-on-beat={!mark.frames} className="st-video-beat-join" style={{left:at*scale}}>
                <span className="st-video-beat-dot" title={mark.frames ? `Off by ${mark.frames} ${mark.frames===1?'frame':'frames'}` : 'On beat'} />
                {mark.frames>0 ? <div className="st-beat-hint"><span>Off by {mark.frames} {mark.frames===1?'frame':'frames'}</span>{snap ? <Tile type="button" disabled={busy} onPointerDown={e=>e.stopPropagation()} onClick={()=>void saveGesture(snap.trim)}>Snap to beat</Tile> : <span>No safe trim here</span>}</div> : null}
              </li>;
            })}
            {joins.map(join => { const JoinIcon = joinIcons[join.choice.kind]; const label = `Transition: ${join.choice.kind[0].toUpperCase()}${join.choice.kind.slice(1)}${join.auto ? " (automatic)" : ""}`; return <button key={join.index} type="button" data-transition-card={join.index} data-transition-kind={join.choice.kind} data-auto={join.auto} data-tight={Math.min(widths[join.index] ?? 0, widths[join.index + 1] ?? 0) < 28} aria-label={`${label}, join ${join.index + 1}`} title={label} onClick={() => {if(suppressClick.current){suppressClick.current=false;return;}onSelectJoin?.(join.index);}}
              className={`st-timeline-join ${join.auto ? "text-muted" : "text-accent"} ${FOCUS}`} style={{ left: join.atS * scale }}><JoinIcon size={13} />{join.choice.sound && <span aria-label="Has sound" className="absolute right-0 top-0 size-1 rounded-full bg-accent" />}</button>; })}
            {version.angleCuts?.map(c => <li key={`angle-${c.atS}`} data-angle-marker className="pointer-events-none absolute inset-y-0 w-px bg-accent" style={{left:c.atS*scale}} title={`Angle ${c.clipId} at ${formatDuration(c.atS)}`} aria-label={`Angle ${c.clipId} at ${formatDuration(c.atS)}`} />)}
            {broll.map((piece, index) => <button key={`broll-${index}`} type="button" data-broll-block data-clip-menu={piece.clipId} onClick={() => { if (piece.piece !== undefined) onSelectPiece?.(piece.piece); player.current?.seek(piece.startS); }} aria-label={`B-roll ${piece.clipId}`} className={`st-timeline-broll st-filmstrip absolute flex overflow-hidden rounded-md ${FOCUS}`} style={{ left: piece.startS * scale, width: (piece.endS - piece.startS) * scale }}><Filmstrip shoot={shoot} clipId={piece.clipId} start={piece.inS} length={piece.endS - piece.startS} width={(piece.endS - piece.startS) * scale} span={piece} />{shoot.clips.some(c => c.id === piece.clipId && c.missing) ? <span data-missing-piece className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ground/60 text-micro text-muted"><span className="rounded-md bg-surface px-2 py-1">Missing</span></span> : null}{updatingPreview(piece.clipId)}</button>)}
          </ol>
          {soundLane(0)}
          {soundPieces.some(p=>p.layer===1) && soundLane(1)}
          <div data-lane="captions" data-hidden={!!hidden["captions"]} className="st-timeline-lane relative" style={laneStyle("captions")}><CaptionWords track={viewDraft ? viewDraft.titles : version.titles} blocks={cues} inspect={id=>onInspect?.("caption",{id})} scale={scale} time={time} duration={duration} fps={viewDraft?.fps ?? 25} busy={busy} seek={value=>player.current?.seek(value)} save={onEdit} error={setDropError} preview={edit=>{if(viewDraft)player.current?.trimPreview?.(edit ? {...viewDraft,titles:updateCaptionWord(viewDraft.titles,edit,viewDraft.durationS)} : null);}} /></div>
          {(hasVoiceover || voiceDrop || !draft?.liveSound) && voiceLane}
          <div data-lane="music" data-hidden={!!hidden["music"]} className="st-timeline-lane relative" style={laneStyle("music")}>{version.music && <div className="absolute inset-0"><div aria-hidden="true" className="st-music-marks pointer-events-none absolute inset-0">
            {grid.sections.map((part,i)=><span key={`section-${i}`} data-music-section={part.section} className="st-music-section absolute inset-y-0" style={{left:part.s*scale,width:(part.e-part.s)*scale,opacity:part.section%2 ? .12 : .06}} />)}
            {beatTicks.map((tick,i)=><span key={`tick-${i}`} data-music-tick={tick.kind} data-beat-time={tick.at} className="st-music-tick absolute bottom-0" style={{left:`${tick.at/(duration || 1)*100}%`,transition:reduced ? undefined : sourceWindowTransition}} />)}
            {joins.map(join=>{const at=starts[join.index+1] ?? join.atS;return <span key={join.index} data-beat-join={join.index} hidden={beatAt(grid,at,1/(2*(draft?.fps ?? 25)))===undefined} className="st-music-cut absolute top-0" style={{left:at*scale}} />;})}
            <span ref={snapFlash} data-music-snap hidden className="st-music-snap absolute inset-y-0" />
          </div><MusicBlock music={version.music} draft={draft} duration={duration} scale={scale} snapping={snapping} busy={busy} onChange={onMusicChange} onInspect={()=>onInspect?.("music-item")} onPause={()=>{pauseFollowing();player.current?.pause?.();}} />{onMusicGain && <VolumeLine endInset={Math.max(4,(duration-Math.min(duration,version.music.endS ?? duration))*scale+4)} label="Music volume" value={version.music.gainDb ?? -18} min={-60} max={0} disabled={busy} onPreview={value=>previewVolume(value)} onCommit={async gainDb=>{try{await onMusicGain(gainDb);}finally{previewVolume(null);}}} />}</div>}</div>
          <div data-lane="overlays" data-hidden={!!hidden["overlays"]} className="st-timeline-lane relative" style={laneStyle("overlays")}>{overlays.map(item => <OverlayBlock key={item.id} item={item} duration={duration} scale={scale} busy={busy} onEdit={onEdit} onSelect={id => onSelectOverlay?.(id)} motion={motionSource} />)}{lowerThirds.map(item => <OverlayBlock key={item.id} item={{ ...item, file: item.title, x: .5, y: .72, w: .5, corner: "square", enter: "none", exit: "none", sound: null }} duration={duration} scale={scale} busy={busy} onEdit={change => { if (change.kind === "overlay" && change.op === "update") onEdit({ kind: "lowerThird", op: "update", id: item.id, patch: { s: change.patch.s, e: change.patch.e } }); }} onSelect={() => onInspect?.("library")} />)}</div>
          {sounds.length > 0 && <div data-lane="sound-effects" data-hidden={!!hidden["sound-effects"]} className="st-timeline-lane relative" style={laneStyle("sound-effects")}>{sounds.map((sound, i) => { const slot = soundSlots[i]; return <button key={sound.id} data-sound-block type="button" aria-label={sound.label} title={sound.label} onClick={() => { onInspect?.("sound-item", { id: sound.id }); }} className={`st-timeline-block absolute min-w-2 overflow-hidden rounded bg-accent/15 text-left text-micro text-accent ${FOCUS}`} style={{ left: sound.s * scale, width: (sound.e - sound.s) * scale }}>{slot && <span data-sound-label className="pointer-events-none absolute inset-y-0 flex items-center" style={{ left: slot.left, width: slot.width }}><span className="block truncate px-1">{sound.label}</span></span>}</button>; })}</div>}
          {viewDraft && voiceEnd > viewDraft.durationS + .5 / (viewDraft.fps ?? 25) && <span data-picture-end role="img" aria-label="Picture ends" title="Picture ends. Export stops here unless you extend it." className="pointer-events-none absolute inset-y-0 z-20 w-px bg-muted/60" style={{ left: viewDraft.durationS * scale }}><span className="absolute left-1 top-0 whitespace-nowrap rounded bg-surface px-1 text-micro text-muted">Picture ends</span></span>}
          {pieces.length > 0 && <span ref={head} aria-hidden="true" data-layered-playhead className="pointer-events-none absolute inset-y-0 z-[47] w-px bg-accent will-change-transform" style={{ left: Math.max(0, Math.min(duration, time)) * scale }}><span className="st-timeline-headcap"><span ref={headTime} data-playhead-time className="st-timeline-badge">{timelineTime(time)}</span></span></span>}
        </div>
      </div>
    </div>
    {dropError ? <InlineError>{dropError}</InlineError> : null}
    {laneMenu && <MenuSurface aria-label="Lane speaker" className="fixed z-50 flex min-w-40 flex-col rounded-lg bg-ground p-1" style={{left:Math.min(laneMenu.x,window.innerWidth-180),top:Math.min(laneMenu.y,window.innerHeight-140),backdropFilter:'none',WebkitBackdropFilter:'none',backgroundColor:'var(--ground)'}} onClose={()=>setLaneMenu(null)}>{(['on','off'] as const).map(all=><MenuOption key={all} type="button" autoFocus={all==='on'} className="rounded-md px-3 py-2 text-small hover:bg-surface focus:bg-surface" onClick={()=>void changeSound(laneMenu.lane==='clip-sound'?{kind:'clipSound',all}:{kind:'laneLevel',lane:laneMenu.lane,muted:all==='off'})}>All clips {all}</MenuOption>)}<MenuOption type="button" title="Preview only. Keeps your saved sound choices." className="rounded-md px-3 py-2 text-small hover:bg-surface focus:bg-surface" onClick={()=>{toggleLane(laneMenu.view);setLaneMenu(null);}}>{hidden[laneMenu.view] ? "Show lane" : "Hide lane"}</MenuOption></MenuSurface>}
    <div className="fixed bottom-4 right-4 z-[90] max-h-[calc(100vh-2rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl bg-surface">{soundSeparation.prompt}</div>
    {soundMenu && <MenuSurface aria-label="Clip sound" className="fixed z-50 flex min-w-44 flex-col rounded-lg bg-ground p-1" style={{left:Math.min(soundMenu.x,window.innerWidth-180),top:Math.max(8,Math.min(soundMenu.y,window.innerHeight-256)),backdropFilter:"none",WebkitBackdropFilter:"none",backgroundColor:"var(--surface)"}} onPointerDown={event=>event.stopPropagation()} onClose={()=>setSoundMenu(null)}><MenuOption autoFocus type="button" className={`rounded-md px-3 py-2 text-small hover:bg-surface focus:bg-surface ${FOCUS}`} onClick={()=>void changeSound({kind:"clipSound",piece:soundMenu.piece,layer:soundMenu.layer,muted:!ownMuted(soundMenu.piece,soundMenu.layer)})}>{ownMuted(soundMenu.piece,soundMenu.layer) ? "Unmute" : "Mute"} {chosen.includes(soundMenu.piece) && chosen.length>1 ? `these ${chosen.length} clips' sound` : "this clip's sound"}</MenuOption>{cutId ? <MenuOption type="button" className={`rounded-md px-3 py-2 text-small hover:bg-surface focus:bg-surface ${FOCUS}`} onClick={()=>void correctPiece(soundMenu.piece)}>Auto correct this clip</MenuOption> : null}{CLEAN_SOUND_CHOICES.map(([clean,label])=><MenuOption key={clean} type="button" className="block w-full rounded-md px-3 py-2 text-left text-small hover:bg-surface focus:bg-surface" onClick={()=>{const choice={kind:'clipSound' as const,piece:soundMenu.piece,layer:soundMenu.layer,clean};setSoundMenu(null);if(clean==='none')void changeSound(choice);else void soundSeparation.request(()=>changeSound(choice));}}>{label}</MenuOption>)}</MenuSurface>}
    {unknownPositions ? <p className="text-micro text-muted">This older cut has no saved b-roll positions.</p> : null}
    {!version.pieces ? <p className="text-micro text-muted">Make a new version to edit this older storyboard.</p> : null}
  </section>;
}
