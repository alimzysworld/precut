import { Tile } from "./ui";
import { InlineError } from "./ui";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import { ArrowsIn, ArrowsOut, Pause, Play, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { formatDuration, getApi } from "../data";
import { instant, spring } from "../motion";
import type { LaneVisibility } from "./timeline/model";
import { LivePlayer, type LiveLook } from "./LivePlayer";
import type { DraftTimeline, Activity, TitleTrack, Grade, DetailChoice, GrainChoice, VignetteChoice } from "../../../shared/schema";
import { FOCUS, Slider } from "./ui";
import { usePageActive } from "../hooks/usePageActivity";
import { useViewerZoom } from "../hooks/useViewerZoom";
import { SourcePreview, type SourcePreviewProps } from "./library/SourcePreview";

export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='dialog']")) return true;
  const input = target.closest("input");
  return !!input && !["range", "checkbox", "radio", "button", "submit", "reset", "file", "color"].includes(input.type);
}

export interface StageHandle {
  trimPreview?: (timeline: DraftTimeline | null, seconds?: number) => void;
  seek: (seconds: number) => void;
  play?: (rate?: number) => void;
  pause?: () => void;
  togglePlayback?: () => void;
  preview: (src: string, start: number, end: number) => void;
  stopPreview: () => void;
  /** Draw these titles now, ahead of the liveTitles render that carries the same track. */
  previewTitles?: (track: import("../../../shared/schema").TitleTrack) => void;
  /** VO7-14: hear the edit without moving the clock. A ruler scrub's new playhead time (null when it ends), one
   * frame's sound at a time, and reversed sound from a time back to 0 while J shuttles. Edit player only. */
  scrubAudio?: (seconds: number | null) => void;
  blip?: (seconds: number, length: number) => void;
  reverseAudio?: (seconds: number, rate: number) => void;
  stopReverseAudio?: () => void;
}
interface StageProps {
  source?: SourcePreviewProps;
  visibility?: LaneVisibility;
  selectionKey: string;
  timeline?: DraftTimeline | null;
  draft?: boolean;
  liveLook?: LiveLook;
  bypassLook?: boolean;
  previewPiece?: number;
  savedGrade?: Grade | null; previewDetail?: DetailChoice | null; previewGrain?: GrainChoice | null; previewVignette?: VignetteChoice | null;
  liveTitles?: TitleTrack | null;
  src: string | null;
  poster: string | null;
  label: string;
  aspect: number;
  focused: boolean;
  onAspect: (aspect: number) => void;
  onTime?: (seconds: number) => void;
  rendering?: boolean;
  progress?: number | null;
  activity?: Activity;
  children?: ReactNode;
  overlay?: ReactNode;
  /** A voiceover take is running: the edit plays, its keys belong to the take. */
  recording?: boolean;
  /** AV1b: the open edit and version, so the Apple player's state (and MCP) names what it plays. */
  cutId?: string;
  cutVersion?: number;
}

// This element stays mounted across cut changes, including while full screen.
export const Stage = forwardRef<StageHandle, StageProps>(function Stage({ selectionKey, children, overlay, source, ...preview }, ref) {
  preview.focused = usePageActive() && preview.focused;
  const sourceFocused = preview.focused;
  preview.focused = preview.focused && !source;
  const stage = useRef<HTMLDivElement>(null);
  const zoomTag = useViewerZoom(stage, selectionKey, preview.focused, preview.timeline?.width);
  const live = useRef<StageHandle>(null);
  const players = useRef(new Map<string, StageHandle>());
  const layerKey = `${selectionKey}-${preview.src ?? "pending"}`;
  const [shown, setShown] = useState({ key: layerKey, media: preview });
  const waiting = !!preview.src && shown.key !== layerKey;
  const rendering = !preview.draft && !preview.timeline && (!!preview.rendering || preview.activity?.state === "running" || waiting);
  const currentLayer = useRef(shown.key);
  currentLayer.current = shown.key;
  useEffect(() => {
    if (!preview.src && !preview.rendering) setShown({ key: layerKey, media: preview });
  }, [layerKey, preview.src, preview.rendering]);
  // Exiting layers must not clear the new player's handle after a crossfade.
  useImperativeHandle(ref, () => ({
    trimPreview: (timeline, seconds) => live.current?.trimPreview?.(timeline, seconds),
    play: (rate) => (preview.timeline ? live.current : players.current.get(currentLayer.current))?.play?.(rate),
    pause: () => (preview.timeline ? live.current : players.current.get(currentLayer.current))?.pause?.(),
    togglePlayback: () => (preview.timeline ? live.current : players.current.get(currentLayer.current))?.togglePlayback?.(),
    seek: (seconds) => (preview.timeline ? live.current : players.current.get(currentLayer.current))?.seek(seconds),
    preview: (src, start, end) => (preview.timeline ? live.current : players.current.get(currentLayer.current))?.preview(src, start, end),
    stopPreview: () => (preview.timeline ? live.current : players.current.get(currentLayer.current))?.stopPreview(),
    previewTitles: (track) => { if (preview.timeline) live.current?.previewTitles?.(track); },
    scrubAudio: (seconds) => { if (preview.timeline) live.current?.scrubAudio?.(seconds); },
    blip: (seconds, length) => { if (preview.timeline) live.current?.blip?.(seconds, length); },
    reverseAudio: (seconds, rate) => { if (preview.timeline) live.current?.reverseAudio?.(seconds, rate); },
    stopReverseAudio: () => { live.current?.stopReverseAudio?.(); },
  }), [preview.timeline]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    const changed = () => setFullscreen(document.fullscreenElement === element);
    document.addEventListener("fullscreenchange", changed);
    return () => { observer.disconnect(); document.removeEventListener("fullscreenchange", changed); };
  }, []);
  async function toggleFullscreen() {
    setError(null);
    try {
      if (document.fullscreenElement === stage.current) await document.exitFullscreen();
      else await stage.current?.requestFullscreen();
    } catch { setError("Couldn't open full screen. Try the full screen button again."); }
  }
  return <div ref={stage} data-cut-stage aria-label="Edit stage" className="relative h-full min-h-0 w-full overflow-hidden bg-black [&:fullscreen]:bg-black">
    {/* No blurred fill behind vertical video: plain black (it changed frame by frame on every clip switch). */}
    {preview.timeline ? <div className="absolute inset-0 flex items-center justify-center"><LivePlayer cutId={preview.cutId} cutVersion={preview.cutVersion} recording={preview.recording} bypassLook={preview.bypassLook} cover={preview.timeline.cover?.image ?? preview.poster} previewPiece={preview.previewPiece} visibility={preview.visibility} key={selectionKey} ref={live} timeline={preview.timeline} look={preview.liveLook} savedGrade={preview.savedGrade} previewDetail={preview.previewDetail} previewGrain={preview.previewGrain} previewVignette={preview.previewVignette} liveTitles={preview.liveTitles} label={preview.label} focused={preview.focused} size={size} fullscreen={fullscreen} onFullscreen={() => void toggleFullscreen()} onTime={preview.onTime} onAspect={preview.onAspect} /></div> : <AnimatePresence initial={false}>
      {[shown, ...(waiting ? [{ key: layerKey, media: preview }] : [])].map((layer) => <motion.div key={layer.key} data-stage-layer initial={{ opacity: 0 }} animate={{ opacity: layer.key !== shown.key ? 0 : rendering ? 0.72 : 1 }} exit={{ opacity: 0 }}
        transition={reduced ? instant : spring.sheet} className="absolute inset-0 flex items-center justify-center">
        {children ?? <Player ref={(handle) => { if (handle) players.current.set(layer.key, handle); else players.current.delete(layer.key); }} {...preview} {...layer.media} focused={preview.focused && layer.key === shown.key} rendering={rendering} onTime={preview.onTime} onAspect={preview.onAspect} size={size} fullscreen={fullscreen} onFullscreen={() => void toggleFullscreen()} onReady={layer.key !== shown.key ? () => setShown({ key: layer.key, media: layer.media }) : undefined} />}
      </motion.div>)}
    </AnimatePresence>}
    {error ? <InlineError className="absolute inset-x-4 top-4 rounded-xl bg-[var(--primary-ink)]/80 p-3 text-center text-small text-[var(--media-ink)]">{error}</InlineError> : null}
    {preview.bypassLook ? <span role="status" className="pointer-events-none absolute left-3 top-3 z-30 rounded-md bg-surface px-2 py-1 text-micro text-ink">Look off · Shift-D</span> : null}
    {overlay}
    {source && <SourcePreview key={source.clip.id} {...source} focused={sourceFocused && source.focused} />}
    <span ref={zoomTag} hidden data-view-zoom className="pointer-events-none absolute bottom-14 left-3 z-30 rounded-md bg-surface px-2 py-1 text-micro text-ink" />
  </div>;
});

const Player = forwardRef<StageHandle, Omit<StageProps, "selectionKey" | "children"> & {
  size: { width: number; height: number }; fullscreen: boolean; onFullscreen: () => void;
  onReady?: () => void;
}>(function Player({ src, poster, label, aspect, focused, onAspect, onTime, rendering, size, fullscreen, onFullscreen, onReady }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const audition = useRef<HTMLVideoElement>(null);
  const auditionEnd = useRef(0);
  const auditionToken = useRef(0);
  const auditionFrame = useRef(0);
  const [previewing, setPreviewing] = useState(false);
  const present = useIsPresent();
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);
  const active = present && focused && !rendering;
  function stopPreview() {
    auditionToken.current++;
    cancelAnimationFrame(auditionFrame.current);
    if (audition.current) { audition.current.onloadedmetadata = null; audition.current.pause(); }
    setPreviewing(false);
  }
  useImperativeHandle(ref, () => ({
    play(rate = 1) { if (video.current && active && !failed) { stopPreview(); video.current.playbackRate = rate; void video.current.play().catch(() => setError(true)); } },
    pause() { video.current?.pause(); stopPreview(); },
    togglePlayback,
    seek(seconds) {
      stopPreview();
      if (video.current) {
        video.current.pause();
        const next = Math.max(0, seconds);
        if (video.current.readyState >= 1) video.current.currentTime = Math.min(next, video.current.duration || next);
        else pendingSeek.current = next;
      }
      onTime?.(seconds);
    },
    // Invoked exclusively by hovering/focusing a take in TakeSwap.
    preview(source, start, end) {
      const element = audition.current;
      if (!element || !active) return;
      video.current?.pause();
      cancelAnimationFrame(auditionFrame.current);
      const token = ++auditionToken.current;
      auditionEnd.current = end;
      element.muted = true;
      setPreviewing(true);
      element.onloadedmetadata = () => {
        if (token !== auditionToken.current) return;
        element.currentTime = start;
        void element.play().catch(() => { if (token === auditionToken.current) setError(true); });
        const stopAtEnd = () => {
          if (token !== auditionToken.current) return;
          if (element.ended) return;
          if (element.currentTime >= end) { element.pause(); element.currentTime = end; return; }
          auditionFrame.current = requestAnimationFrame(stopAtEnd);
        };
        auditionFrame.current = requestAnimationFrame(stopAtEnd);
      };
      element.src = source;
      element.load();
    },
    stopPreview,
  }));
  // Playback starts only in togglePlayback, reached by a click or Space.
  function togglePlayback() {
    const element = video.current;
    if (!element || !active || failed) return;
    stopPreview();
    if (element.paused) { element.playbackRate = 1; setError(false); void element.play().catch(() => setError(true)); }
    else element.pause();
  }
  useEffect(() => {
    const element = video.current;
    if (!active) { element?.pause(); stopPreview(); }
    const previewElement = audition.current;
    return () => { element?.pause(); previewElement?.pause(); auditionToken.current++; cancelAnimationFrame(auditionFrame.current); };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTextField(event.target)) return;
      if (document.querySelector('[role="dialog"]:not([inert] *, [hidden] *), [role="menu"]:not([inert] *, [hidden] *)')) return;
      if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
      const key = event.key.toLowerCase();
      if (["j", "k", "l"].includes(key)) {
        event.preventDefault(); stopPreview();
        const element = video.current;
        if (!element) return;
        if (key === "k") element.pause();
        else { element.currentTime = Math.max(0, Math.min(element.duration || 0, element.currentTime + (key === "j" ? -5 : 5))); onTime?.(element.currentTime); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, failed]);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const width = Math.min(size.width, size.height * safeAspect);
  const control = `flex size-8 shrink-0 items-center justify-center rounded-full st-player-control ${FOCUS}`;
  return <div data-cut-player aria-hidden={!present || undefined} ref={(element) => {
    if (!present) element?.setAttribute("inert", "");
    else element?.removeAttribute("inert");
  }}
    className="relative overflow-hidden rounded-xl bg-[var(--primary-ink)]" style={{ width, height: width / safeAspect, "--player-gutter": `${(size.width - width) / 2}px`, "--player-bottom": `${(size.height - width / safeAspect) / 2}px`, pointerEvents: active ? undefined : "none" } as React.CSSProperties}>
    <div data-view-picture className="absolute inset-0">
    {src && !failed ? <video ref={video} src={src} poster={poster ?? undefined} playsInline preload="auto" muted={muted} onLoadedData={onReady}
      onLoadedMetadata={(event) => {
        const element = event.currentTarget;
        if (element.videoWidth > 0 && element.videoHeight > 0) onAspect(element.videoWidth / element.videoHeight);
        setDuration(Number.isFinite(element.duration) ? element.duration : 0);
        element.currentTime = Math.min(pendingSeek.current ?? 0, element.duration || Infinity);
        pendingSeek.current = null;
      }} onTimeUpdate={(event) => { setTime(event.currentTarget.currentTime); if (active) onTime?.(event.currentTarget.currentTime); }}
      onPlay={(event) => { if (!active) event.currentTarget.pause(); else setPlaying(true); }}
      onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setFailed(true); onReady?.(); }}
      className="absolute inset-0 h-full w-full object-contain" aria-label={label} />
      : poster ? <img src={poster} alt="" className="absolute inset-0 h-full w-full object-contain" /> : null}
    <video ref={audition} playsInline muted preload="none" aria-label="Take preview" onTimeUpdate={(event) => {
      if (event.currentTarget.currentTime >= auditionEnd.current) event.currentTarget.pause();
    }} onError={() => { stopPreview(); setError(true); }} className={`absolute inset-0 h-full w-full object-contain ${previewing ? "" : "hidden"}`} />
    </div>
    {previewing ? <span className="st-pop absolute left-3 top-3 rounded-full px-3 py-1 text-micro text-ink">Take preview · muted</span> : null}
    <div className="st-player-transport absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 rounded-xl px-3 py-2" aria-label="Player controls">

        <button type="button" aria-label={playing ? `Pause ${label}` : `Play ${label}`} disabled={!src || failed} onClick={togglePlayback} className={`${control} disabled:opacity-30`}>
          {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
        </button>
        <span className="tnum whitespace-nowrap text-micro text-[var(--media-ink)]">{formatDuration(time)} / {formatDuration(duration)}</span>
      <Slider compact label={`Seek ${label}`} min={0} max={duration || 1} step={.01} value={Math.min(time, duration)} disabled={!duration || failed} aria-valuetext={`${formatDuration(time)} of ${formatDuration(duration)}`} onChange={value => { stopPreview(); if (video.current) video.current.currentTime = value; }} />
        <Tile type="button" aria-label={muted ? "Unmute preview" : "Mute preview"} aria-pressed={muted} onClick={() => setMuted((value) => !value)} className={control}>
          {muted ? <SpeakerSlash size={18} /> : <SpeakerHigh size={18} />}
        </Tile>
        <button type="button" aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={onFullscreen} className={control}>
          {fullscreen ? <ArrowsIn size={18} /> : <ArrowsOut size={18} />}
        </button>
    </div>
    {error ? <InlineError className="absolute inset-x-0 top-0 bg-[var(--scrim)] p-3 text-center text-small text-[var(--media-ink)]">Couldn't play the preview. Try play again.</InlineError> : null}
  </div>;
});
