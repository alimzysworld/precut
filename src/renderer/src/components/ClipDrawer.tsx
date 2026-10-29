import { clipName } from "../../../shared/clip-name";
import { formatPercent } from "./processingFormat";
import { MenuOption } from "./ui";
import { MenuSurface } from "./ui";
import { InlineError, SectionHeader } from "./ui";
import { TranscriptPanel } from "./finish/TranscriptPanel";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Microphone, Pause, Play, Star } from "@phosphor-icons/react";
import { motion, useIsPresent, type TargetAndTransition } from "framer-motion";
import { dur, ease } from "../motion";
import { FullScreen, Volume, VolumeOff } from "./icons";
import { Drawer, Img, Pill, useMotionPresets, reducedTransition, FOCUS, Slider } from "./ui";
import { formatBytes, formatTimecode, frameSrc, getApi, proxySrc } from "../data";
import type { Activity, Clip, Shoot } from "../../../shared/schema";
import { humanDate } from "./dates";

// The activity snapshot covers opening a page halfway through an encode;
// progress events invalidate media URLs even when a remake keeps the filename.
export function usePreviewProgress(root: string | null) {
  const [activities, setActivities] = useState<Record<string, Activity>>({});
  const [revision, setRevision] = useState(0);
  const [clipRevisions, setClipRevisions] = useState<Record<string, number>>({});
  useEffect(() => {
    setActivities({}); setRevision(0); setClipRevisions({});
    if (!root) return;
    const api = getApi();
    let alive = true;
    const seen = new Set<string>();
    const off = api.onActivity(activity => {
      if (activity.root !== root || activity.label !== "Making previews") return;
      seen.add(activity.id);
      setActivities(previous => ({ ...previous, [activity.id]: activity }));
    });
    const progressOff = api.onProgress(event => {
      const note = (event as typeof event & { note?: string }).note;
      if (event.root === root && event.clipId && event.stage === "done" && note?.startsWith("Making previews")) {
        setRevision(value => value + 1);
        setClipRevisions(previous => ({ ...previous, [event.clipId]: (previous[event.clipId] ?? 0) + 1 }));
      }
    });
    void api.listActivity().then(list => {
      if (!alive) return;
      setActivities(previous => ({ ...Object.fromEntries(list.filter(activity => activity.root === root
        && activity.label === "Making previews" && !seen.has(activity.id)).map(activity => [activity.id, activity])), ...previous }));
    }).catch(() => {});
    return () => { alive = false; off(); progressOff(); };
  }, [root]);
  const pending: Record<string, number> = {};
  for (const activity of Object.values(activities)) {
    if (activity.root !== root || activity.state !== "running" || !activity.target?.clipId) continue;
    const match = activity.note?.match(/ · (\d+)%$/);
    pending[activity.target.clipId] = match ? Number(match[1]) : 0;
  }
  return { pending, revision, clipRevisions };
}

export function PreviewPlaceholder({ pct, src, className = "", message }: { pct: number; src?: string; className?: string; message?: string }) {
  return <div data-preview-placeholder className={`absolute inset-0 z-10 flex items-center justify-center bg-ground ${className}`}>
    {src ? <div className="absolute inset-0"><Img src={src} alt="" className="h-full w-full object-contain" /></div> : null}
    <span role="status" className="relative shrink-0 whitespace-nowrap rounded-full bg-ground px-3 py-1.5 text-micro text-ink">{message ?? `Making preview · ${formatPercent(pct)}`}</span>
  </div>;
}

// Keep cards, filters and the drawer on the same interpretation of manual tags.
export const clipKind = (clip: Clip) => {
  const kind = clip.byHand?.kind ?? clip.judgement?.kind;
  // Older indexes, including the browser fixture, spell this as "b-roll".
  return (kind as string) === "b-roll" ? "broll" : kind;
};
export const clipShaky = (clip: Clip): boolean | undefined => clip.byHand?.shaky
  ?? (clip.shake?.shakySpans.length ? true : clip.shake?.measured ? false : undefined);
const kindLabel = (kind: ReturnType<typeof clipKind>) => kind === "broll" ? "B-roll" : kind === "talking" ? "Talking" : kind === "setup" ? "Setup" : "Kind untagged";

export function ClipTags({ shoot, clip, onShootChange }: {
  shoot: Shoot; clip: Clip; onShootChange: (shoot: Shoot) => void;
}) {
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { pop } = useMotionPresets();
  const kind = clipKind(clip);
  const shaky = clipShaky(clip);

  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = menuRef.current?.offsetHeight ?? 270;
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 232)),
      top: rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - height - 6),
    });
  }, [anchor, error]);

  useEffect(() => {
    if (!anchor) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) setAnchor(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setAnchor(null);
      anchor.focus();
    };
    const close = () => setAnchor(null);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    // A fixed portal avoids clipping inside cards and the scrolling drawer.
    const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) close(); };
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchor]);

  const save = async (tag: NonNullable<Clip["byHand"]> | null) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await getApi().setClipTag(shoot.root, clip.id, tag === null ? null : { ...clip.byHand, ...tag });
      onShootChange(next);
      setAnchor(null);
      requestAnimationFrame(() => anchor?.focus({ preventScroll: true }));
    } catch {
      setError("Could not save your tags. Try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const trigger = (label: string, byYou: boolean, warn = false) => (
    <button type="button" aria-label={`Edit ${label.toLowerCase()} tag for ${clipName(clip)}${byYou ? ", set by you" : ""}`}
      aria-haspopup="menu" aria-expanded={anchor?.dataset.tag === label} aria-controls={anchor?.dataset.tag === label ? menuId : undefined}
      data-tag={label} disabled={saving}
      onClick={(event) => { event.stopPropagation(); setError(null); setAnchor(anchor === event.currentTarget ? null : event.currentTarget); }}
      className={`rounded-full hover:bg-ink/[0.08] disabled:opacity-50 ${FOCUS}`}>
      <Pill tone={warn ? "warn" : "neutral"}>{label}{byYou ? <span className="text-[10px] opacity-75">you</span> : null}</Pill>
    </button>
  );
  const optionClass = `flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-ink hover:bg-ink/[0.06] disabled:opacity-50 ${FOCUS}`;
  return <>
    {!clip.photo && clip.sound ? <span className="inline-flex items-center px-1 text-muted" title="Sound from mic" aria-label="Sound from mic"><Microphone size={14} /></span> : null}
    {clip.photo ? <Pill>Photo</Pill> : trigger(kindLabel(kind), clip.byHand?.kind !== undefined)}
    {!clip.photo && trigger(shaky === undefined ? "Shake unmeasured" : shaky ? "Shaky" : "Steady", clip.byHand?.shaky !== undefined, shaky === true)}
    {anchor && createPortal(
      <MenuSurface ref={menuRef} id={menuId} aria-label={`Tags for ${clipName(clip)}`} aria-busy={saving}
        variants={pop} initial="initial" animate="animate"
        style={position} className="st-glass-pop fixed z-[80] w-[220px] rounded-2xl border-0 p-1.5"
        onClose={() => { setAnchor(null); anchor?.focus(); }}>
        <div role="group" aria-label="Kind">
          {(["talking", "broll", "setup"] as const).map((value) => <MenuOption key={value} type="button" role="menuitemradio" aria-checked={kind === value}
            disabled={saving} onClick={() => void save({ kind: value })} className={optionClass}>
            {kindLabel(value)}{kind === value ? <Check size={14} /> : null}
          </MenuOption>)}
        </div>
        <div role="group" aria-label="Shake" className="mt-1 rounded-xl bg-ink/[0.03]">
          {[true, false].map((value) => <MenuOption key={String(value)} type="button" role="menuitemradio" aria-checked={shaky === value}
            disabled={saving} onClick={() => void save({ shaky: value })} className={optionClass}>
            {value ? "Shaky" : "Steady"}{shaky === value ? <Check size={14} /> : null}
          </MenuOption>)}
        </div>
        <MenuOption type="button" role="menuitem" disabled={saving || !clip.byHand} onClick={() => void save(null)} className={`${optionClass} mt-1 text-muted`}>Use sidething's tags</MenuOption>
        {saving ? <p role="status" className="px-3 py-2 text-[12px] text-muted">Saving your tags</p> : null}
        {error ? <InlineError className="px-3 py-2 text-[12px] text-danger">{error}</InlineError> : null}
      </MenuSurface>, document.body,
    )}
  </>;
}

function verdictTone(v: string | undefined): "good" | "warn" | "danger" | "neutral" | "accent" {
  if (v === "best") return "good";
  if (v === "alt") return "accent";
  if (v === "maybe") return "warn";
  return "neutral";
}

export function ClipDrawer({
  shoot,
  clip,
  initialTime,
  endTime,
  onClose,
  onShootChange,
  layout = "drawer",
}: {
  shoot: Shoot;
  clip: Clip | null;
  initialTime?: number;
  endTime?: number;
  onClose: () => void;
  onShootChange?: (shoot: Shoot) => void;
  layout?: "drawer" | "preview";
}) {
  // Chat also opens this drawer without owning the shoot state.
  const [savedShoot, setSavedShoot] = useState<Shoot | null>(null);
  if (!onShootChange && savedShoot?.root === shoot.root && clip) {
    const savedClip = savedShoot.clips.find((item) => item.id === clip?.id);
    if (savedClip) { clip = savedClip; shoot = savedShoot; }
  }
  const updateShoot = (next: Shoot) => {
    setSavedShoot(next);
    onShootChange?.(next);
  };
  const previews = usePreviewProgress(shoot.root);
  const updateShootRef = useRef(updateShoot); updateShootRef.current = updateShoot;
  useEffect(() => {
    if (!previews.revision) return;
    let alive = true;
    void getApi().loadShoot(shoot.root).then(next => { if (alive && next) updateShootRef.current(next); }).catch(() => {});
    return () => { alive = false; };
  }, [shoot.root, previews.revision]);
  const present = useIsPresent();
  const liveClip = clip;
  const lastClip = useRef(clip);
  if (clip) lastClip.current = clip;
  clip = clip ?? lastClip.current;
  const previewPct = clip ? previews.pending[clip.id] : undefined;
  const previewRevision = clip ? previews.clipRevisions[clip.id] ?? 0 : 0;
  const { item, reduced } = useMotionPresets();
  const detailVariants = { ...item, animate: {
    ...(item.animate as TargetAndTransition),
    transition: reduced ? reducedTransition : { duration: dur.fast, ease: ease.out },
  } };
  const [landed, setLanded] = useState(false);
  useEffect(() => { setLanded(false); }, [liveClip?.id]);
  const duration = clip?.meta?.durationS ?? 0;
  const [cursor, setCursor] = useState({ clipId: clip?.id, time: initialTime ?? 0 });
  // A newly selected clip gets the requested poster before effects run.
  const time = cursor.clipId === clip?.id ? cursor.time : initialTime ?? 0;
  const setTime = (next: number) => setCursor({ clipId: clip?.id, time: next });
  const videoRef = useRef<HTMLVideoElement>(null);

  const pendingSeek = useRef<number | null>(initialTime ?? 0);
  const seekingRef = useRef(false);
  const scrubbed = useRef(false);
  const [seeking, setSeeking] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [playing, setPlaying] = useState(false), [muted, setMuted] = useState(false);
  const [playError, setPlayError] = useState(false);
  const selection = useRef({ id: liveClip?.id, initialTime });
  useEffect(() => {
    if (previewPct === undefined) return;
    videoRef.current?.pause();
    setPlaying(false); setVideoReady(false);
  }, [previewPct !== undefined]);


  useEffect(() => {
    if (!present) videoRef.current?.pause();
  }, [present]);

  useEffect(() => {
    if (!liveClip) return;
    const sameSelection = selection.current.id === liveClip.id && selection.current.initialTime === initialTime;
    const target = Math.max(0, previewRevision && sameSelection ? time : initialTime ?? 0);
    selection.current = { id: liveClip.id, initialTime };
    videoRef.current?.pause();
    setPlaying(false);
    setPlayError(false);
    scrubbed.current = false;
    setVideoReady(false);
    pendingSeek.current = target;
    setTime(target);
    seekingRef.current = false;
    setSeeking(false);
    const video = videoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      video.currentTime = Math.min(Math.max(target, 0), video.duration);
      pendingSeek.current = null;
    }
  }, [liveClip?.id, clip?.proxy, initialTime, previewRevision]);

  const frames = clip?.frames ?? [];
  const frameIndex = useMemo(() => {
    if (!frames.length || !duration) return 0;
    return Math.min(frames.length - 1, Math.max(0, Math.floor((time / duration) * frames.length)));
  }, [time, duration, frames.length]);

  const takesInClip = useMemo(() => {
    if (!clip) return [];
    const rows: { lineIndex: number; attemptIndex: number; total: number; starred: boolean; text: string; s: number }[] = [];
    for (const take of shoot.takes) {
      take.attempts.forEach((a, idx) => {
        if (a.clipId === clip.id) {
          rows.push({
            lineIndex: take.lineIndex,
            attemptIndex: idx,
            total: take.attempts.length,
            starred: take.starred === idx,
            text: a.text,
            s: a.s,
          });
        }
      });
    }
    return rows.sort((a, b) => a.s - b.s);
  }, [shoot, clip]);

  if (!clip) return null;

  const meta = clip.meta;
  const shake = clip.shake;
  const judgement = clip.judgement;
  const perSecond = shake?.perSecond ?? [];
  const maxShake = perSecond.length ? Math.max(...perSecond, 0.6) : 0.6;
  const isShakySecond = (sec: number) => clip.byHand?.shaky ?? (shake?.shakySpans ?? []).some(([a, b]) => sec >= a && sec < b);

  const seek = (t: number) => {
    scrubbed.current = true;
    const clamped = Math.min(Math.max(t, 0), duration || t);
    setTime(clamped);
    pendingSeek.current = clamped;
    const video = videoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      video.currentTime = clamped;
      pendingSeek.current = null;
    }
  };

  const title = clipName(clip);
  const micLabel = clip.sound?.file.match(/MIC(\d+)/i)?.[1];
  const soundLabel = clip.photo ? null : clip.sound
    ? `sound from ${micLabel ? `mic ${micLabel}` : clip.sound.file.split(/[\\/]/).pop()} at ${clip.sound.offsetS < 0 ? "−" : ""}${formatTimecode(Math.abs(clip.sound.offsetS))}`
    : clip.sound === null ? "camera sound" : null;
  const subtitle = clip.photo ? ["Photo", humanDate(clip.photo.takenAt)].filter(Boolean).join(" · ") : judgement ? `${judgement.verdict} · ${formatTimecode(duration)}` : formatTimecode(duration);

  const tags = <div className="flex flex-col gap-2">
    <div aria-label="Clip tags" className="flex flex-wrap gap-1.5">
      <ClipTags key={`${shoot.root}/${clip.id}`} shoot={shoot} clip={clip} onShootChange={updateShoot} />
    </div>
    {soundLabel ? <p className="text-[12px] text-muted">{soundLabel}</p> : null}
  </div>;

  const viewer = (
    <div className={""}>
      <div className={`relative overflow-hidden rounded-xl bg-ink/[0.04] ${""}`}>
        {clip.proxy && previewPct === undefined ? (
          <video
            ref={videoRef}
            src={`${proxySrc(shoot.root, clip.proxy)}${proxySrc(shoot.root, clip.proxy).includes("?") ? "&" : "?"}preview=${previewRevision}`}
            poster={frames[frameIndex] ? frameSrc(shoot.root, frames[frameIndex]) : undefined}
            onLoadedData={() => { if (pendingSeek.current === null && !seekingRef.current) setVideoReady(true); }}
            className={"aspect-video w-full object-contain"}
            controls={false}
            autoPlay={false}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            preload="auto"
            playsInline
            key={`${clip.id}:${previewRevision}`}
            aria-busy={seeking}
            onLoadedMetadata={(e) => {
              const video = e.currentTarget;
              video.pause();
              const target = pendingSeek.current ?? initialTime ?? 0;
              video.currentTime = Math.min(Math.max(target, 0), video.duration);
              pendingSeek.current = null;
            }}
            onSeeking={() => {
              seekingRef.current = true;
              setSeeking(true);
            }}
            onTimeUpdate={(e) => {
              if (endTime != null && !e.currentTarget.paused && e.currentTarget.currentTime >= endTime) e.currentTarget.pause();
              if (!seekingRef.current && pendingSeek.current === null) setTime(e.currentTarget.currentTime);
            }}
            onSeeked={(e) => {
              seekingRef.current = false;
              setVideoReady(true);
              setSeeking(false);
              setTime(e.currentTarget.currentTime);
            }}
          />
        ) : frames[frameIndex] ? (
          <Img instant={scrubbed.current} src={frameSrc(shoot.root, frames[frameIndex])} alt={`${clipName(clip)} frame`} className={"aspect-video w-full object-cover"} />
        ) : (
          <div className={`flex items-center justify-center text-[13px] text-muted ${"aspect-video"}`}>no frames yet</div>
        )}
        {clip.proxy && !videoReady && frames[frameIndex] ? <Img instant={scrubbed.current} src={frameSrc(shoot.root, frames[frameIndex])} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-contain" /> : null}
        {previewPct !== undefined ? <PreviewPlaceholder pct={previewPct} src={frames[frameIndex] ? frameSrc(shoot.root, frames[frameIndex]) : undefined} /> : null}
      </div>
      <div className="mt-2 grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3">
        <div className="flex items-center gap-2">
          {clip.proxy ? <button type="button" disabled={previewPct !== undefined} aria-label={playing ? "Pause clip" : "Play clip"}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              setPlayError(false);
              if (video.paused) void video.play().catch(() => setPlayError(true));
              else video.pause();
            }}
            className={`flex size-6 items-center justify-center rounded-full text-ink hover:bg-ink/[0.06] ${FOCUS}`}>
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          </button> : null}
          <span className="tnum text-[12px] text-muted">{formatTimecode(time)}</span>
        </div>
        <Slider compact label="scrub" min={0} max={Math.max(duration, .1)} step={.1} value={Math.min(time, duration)} onChange={seek} />
        <span className="flex items-center gap-1"><span className="tnum text-[12px] text-muted">{formatTimecode(duration)}</span>
          {layout === "preview" && clip.proxy ? <>
            {!clip.photo && <button type="button" aria-label={muted ? "Unmute" : "Mute"} onClick={() => { const video = videoRef.current; if (video) { video.muted = !video.muted; setMuted(video.muted); } }} className={`flex size-6 items-center justify-center rounded-full text-ink hover:bg-ink/[0.06] ${FOCUS}`}>{muted ? <VolumeOff size={14} /> : <Volume size={14} />}</button>}
            <button type="button" aria-label="Full screen" onClick={() => { void videoRef.current?.requestFullscreen?.(); }} className={`flex size-6 items-center justify-center rounded-full text-ink hover:bg-ink/[0.06] ${FOCUS}`}><FullScreen size={14} /></button>
          </> : null}</span>
        {/* shake strip shares the scrubber track column so both edges line up */}
        {!clip.photo && layout !== "preview" && !(shake && !shake.measured) && perSecond.length ? (
          <>
            <span aria-hidden="true" />
            <div className="mt-2 flex h-9 w-full min-w-0 items-end gap-[1px] overflow-hidden" role="img" aria-label="shake per second">
              {perSecond.map((v, i) => {
                const shaky = isShakySecond(i);
                const h = Math.max(12, Math.round((v / maxShake) * 100));
                const active = Math.floor(time) === i;
                return (
                  <button
                    key={i}
                    type="button"
                    title={`${formatTimecode(i)} ${shaky ? "shaky" : "steady"}`}
                    aria-label={`${formatTimecode(i)} ${shaky ? "shaky" : "steady"}`}
                    onClick={() => seek(i)}
                    className="min-w-0 flex-1 rounded-[1px] p-0 hover:opacity-80"
                    style={{
                      height: `${h}%`,
                      background: shaky ? "var(--warn)" : "color-mix(in oklab, var(--accent) 55%, transparent)",
                      opacity: active ? 1 : 0.7,
                    }}
                  />
                );
              })}
            </div>
            <span aria-hidden="true" />
          </>
        ) : null}
      </div>
      {playError ? <InlineError className="mt-1 text-[12px] text-danger">Could not play this preview. Try again.</InlineError> : null}
      {!clip.photo && shake && !shake.measured && clip.byHand?.shaky === undefined ? (
        <p className="mt-2 text-[12.5px] text-muted">too dark to judge shake</p>
      ) : null}
      {/* frame thumbnails */}
      {layout !== "preview" && frames.length > 1 ? (
        <div className="mt-2 grid shrink-0 grid-cols-8 gap-1">
          {frames.map((f, i) => (
            <button
              key={f}
              type="button"
              onClick={() => seek(duration ? (i / frames.length) * duration : 0)}
              className={`overflow-hidden rounded-md ${i === frameIndex ? "bg-[var(--selection-fill)] opacity-100" : "opacity-70 hover:opacity-100"}`}
              aria-label={`frame ${i + 1}`}
            >
              <Img src={frameSrc(shoot.root, f)} alt="" className={`aspect-video w-full object-cover ${""}`} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
    </div>

  );

  // D2 reuses this player and its preview invalidation without duplicating media logic.
  if (layout === "preview") return <div data-footage-preview>{viewer}</div>;

  const details = (
    <motion.div variants={detailVariants} initial={"initial"} animate={landed || reduced ? "animate" : "initial"}
      className={`flex min-w-0 flex-col gap-5 ${""}`} data-drawer-details
      >
    {judgement ? (
      <div>
        <div className="flex flex-wrap gap-1.5">
          <Pill tone={verdictTone(judgement.verdict)}>{judgement.verdict}</Pill>
          <Pill tone="neutral">{judgement.shot}</Pill>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-ink">{judgement.summary}</p>
      </div>
    ) : null}

    {/* transcript */}
    <section>
      <SectionHeader as="h3" className="font-display text-[13px] font-semibold tracking-tight text-ink">Transcript</SectionHeader>
      {clip.transcript?.length ? (
        <div className="mt-2 text-body leading-[1.9] text-ink">
          <TranscriptPanel key={`${shoot.root}/${clip.id}`} shoot={shoot} source={{ clipId: clip.id }} time={time} onSeek={seek} onChange={updateShoot} />
        </div>
      ) : (
        <p className="mt-1 text-[13px] text-muted">no transcript for this clip</p>
      )}
    </section>

    {/* takes */}
    {takesInClip.length ? (
      <section>
        <SectionHeader as="h3" className="font-display text-[13px] font-semibold tracking-tight text-ink">Takes in this clip</SectionHeader>
        <ul className="mt-2 flex flex-col gap-1.5">
          {takesInClip.map((row) => (
            <li key={`${row.lineIndex}-${row.attemptIndex}-${row.s}`}>
              <button
                type="button"
                onClick={() => seek(row.s)}
                className="st-glass-surface flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] hover:bg-ink/[0.03]"
              >
                {row.starred ? <Star size={14} weight="fill" className="shrink-0 text-[var(--warn)]" /> : <span className="size-[14px] shrink-0" />}
                <span className="font-medium text-ink">
                  line {row.lineIndex + 1}, attempt {row.attemptIndex + 1} of {row.total}
                </span>
                <span className="tnum text-muted">{formatTimecode(row.s)}</span>
                <span className="truncate text-muted">{row.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    ) : null}

    {/* metadata */}
    <section>
      <SectionHeader as="h3" className="font-display text-[13px] font-semibold tracking-tight text-ink">Details</SectionHeader>
      <dl className="st-glass-surface mt-2 divide-y divide-ink/[0.06] rounded-xl px-4">
        {(
          [
            ["camera", meta?.camera ? meta.camera.replace("Sony ILCE-7CM2", "Sony A7C II") : "not recorded"],
            ["ISO", meta?.iso != null ? String(meta.iso) : "not recorded"],
            ["shutter", meta?.shutter ?? "not recorded"],
            ["aperture", meta?.aperture != null ? `f/${meta.aperture}` : "not recorded"],
            ["focal length", meta?.focalLength != null ? `${meta.focalLength} mm` : "not recorded"],
            ["frame rate", meta ? `${meta.fps} fps` : "not recorded"],
            ["codec", meta?.codec ?? "not recorded"],
            ["picture profile", meta?.pictureProfile ?? "not recorded"],
            ["start timecode", meta?.startTimecode ?? "not recorded"],
            ...(!clip.photo ? [["audio", meta ? `${meta.audioChannels} channels, ${meta.sampleRate} Hz` : "not recorded"]] : []),
            ["file size", meta ? formatBytes(meta.sizeBytes) : "not recorded"],
            ["file", clip.photo?.file ?? clip.file],
          ] as [string, string][]
        ).map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
            <dt className="text-muted">{k}</dt>
            <dd className="tnum min-w-0 break-words text-right font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
    </motion.div>
  );


  return (
    <Drawer open={Boolean(liveClip)} onClose={onClose} title={title} subtitle={subtitle} wide onLanded={() => setLanded(true)}>
      <div className="flex flex-col gap-5">
        {tags}
        {viewer}
        {details}
      </div>
    </Drawer>
  );
}

