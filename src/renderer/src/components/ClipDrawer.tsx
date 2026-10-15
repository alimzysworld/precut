import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Microphone, Pause, Play, Star, X } from "@phosphor-icons/react";
import { AnimatePresence, motion, useIsPresent, type TargetAndTransition } from "framer-motion";
import { dur, ease } from "../motion";
import { Drawer, Img, Pill, useMotionPresets, reducedTransition, FOCUS } from "./ui";
import { formatBytes, formatTimecode, frameSrc, getApi, proxySrc } from "../data";
import type { Clip, Shoot } from "../../../shared/schema";

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
    <button type="button" aria-label={`Edit ${label.toLowerCase()} tag for clip ${clip.id}${byYou ? ", set by you" : ""}`}
      aria-haspopup="menu" aria-expanded={anchor?.dataset.tag === label} aria-controls={anchor?.dataset.tag === label ? menuId : undefined}
      data-tag={label} disabled={saving}
      onClick={(event) => { event.stopPropagation(); setError(null); setAnchor(anchor === event.currentTarget ? null : event.currentTarget); }}
      className={`rounded-full hover:bg-ink/[0.08] disabled:opacity-50 ${FOCUS}`}>
      <Pill tone={warn ? "warn" : "neutral"}>{label}{byYou ? <span className="text-[10px] opacity-75">you</span> : null}</Pill>
    </button>
  );
  const optionClass = `flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-ink hover:bg-ink/[0.06] disabled:opacity-50 ${FOCUS}`;
  return <>
    {clip.sound ? <span className="inline-flex items-center px-1 text-muted" title="Sound from mic" aria-label="Sound from mic"><Microphone size={14} /></span> : null}
    {trigger(kindLabel(kind), clip.byHand?.kind !== undefined)}
    {trigger(shaky === undefined ? "Shake unmeasured" : shaky ? "Shaky" : "Steady", clip.byHand?.shaky !== undefined, shaky === true)}
    {anchor && createPortal(
      <motion.div ref={menuRef} id={menuId} role="menu" aria-label={`Tags for clip ${clip.id}`} aria-busy={saving}
        variants={pop} initial="initial" animate="animate"
        style={position} className="st-glass-pop fixed z-[80] w-[220px] rounded-2xl border-0 p-1.5"
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[index]?.focus();
        }}>
        <div role="group" aria-label="Kind">
          {(["talking", "broll", "setup"] as const).map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={kind === value}
            disabled={saving} onClick={() => void save({ kind: value })} className={optionClass}>
            {kindLabel(value)}{kind === value ? <Check size={14} /> : null}
          </button>)}
        </div>
        <div role="group" aria-label="Shake" className="mt-1 rounded-xl bg-ink/[0.03]">
          {[true, false].map((value) => <button key={String(value)} type="button" role="menuitemradio" aria-checked={shaky === value}
            disabled={saving} onClick={() => void save({ shaky: value })} className={optionClass}>
            {value ? "Shaky" : "Steady"}{shaky === value ? <Check size={14} /> : null}
          </button>)}
        </div>
        <button type="button" role="menuitem" disabled={saving || !clip.byHand} onClick={() => void save(null)} className={`${optionClass} mt-1 text-muted`}>Use sidething's tags</button>
        {saving ? <p role="status" className="px-3 py-2 text-[12px] text-muted">Saving your tags</p> : null}
        {error ? <p role="alert" className="px-3 py-2 text-[12px] text-danger">{error}</p> : null}
      </motion.div>, document.body,
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
  onClose,
  onShootChange,
  layout = "drawer",
}: {
  shoot: Shoot;
  clip: Clip | null;
  initialTime?: number;
  onClose: () => void;
  onShootChange?: (shoot: Shoot) => void;
  layout?: "drawer" | "player";
}) {
  // Chat also opens this drawer without owning the shoot state.
  const [savedShoot, setSavedShoot] = useState<Shoot | null>(null);
  if (!onShootChange && savedShoot?.root === shoot.root && clip) {
    const savedClip = savedShoot.clips.find((item) => item.id === clip?.id);
    if (savedClip) clip = { ...clip, byHand: savedClip.byHand };
  }
  const updateShoot = (next: Shoot) => {
    setSavedShoot(next);
    onShootChange?.(next);
  };
  const present = useIsPresent();
  const liveClip = clip;
  const lastClip = useRef(clip);
  if (clip) lastClip.current = clip;
  clip = clip ?? lastClip.current;
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
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState(false);

  useEffect(() => {
    if (layout !== "player" || !liveClip || !present) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [layout, liveClip?.id, present, onClose]);

  useEffect(() => {
    if (!present) videoRef.current?.pause();
  }, [present]);

  useEffect(() => {
    if (!liveClip) return;
    const target = Math.max(0, initialTime ?? 0);
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
  }, [liveClip?.id, clip?.proxy, initialTime]);

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

  const title = clip.id.slice(-4);
  const micLabel = clip.sound?.file.match(/MIC(\d+)/i)?.[1];
  const soundLabel = clip.sound
    ? `sound from ${micLabel ? `mic ${micLabel}` : clip.sound.file.split(/[\\/]/).pop()} at ${clip.sound.offsetS < 0 ? "−" : ""}${formatTimecode(Math.abs(clip.sound.offsetS))}`
    : clip.sound === null ? "camera sound" : null;
  const subtitle = judgement ? `${judgement.verdict} · ${formatTimecode(duration)}` : formatTimecode(duration);

  const tags = <div className="flex flex-col gap-2">
    <div aria-label="Clip tags" className="flex flex-wrap gap-1.5">
      <ClipTags key={`${shoot.root}/${clip.id}`} shoot={shoot} clip={clip} onShootChange={updateShoot} />
    </div>
    {soundLabel ? <p className="text-[12px] text-muted">{soundLabel}</p> : null}
  </div>;

  const viewer = (
    <div className={layout === "player" ? "flex min-h-0 min-w-0 flex-col" : ""}>
      <div className={`relative overflow-hidden rounded-xl bg-ink/[0.04] ${layout === "player" ? "min-h-0 flex-1" : ""}`}>
        {clip.proxy ? (
          <video
            ref={videoRef}
            src={proxySrc(shoot.root, clip.proxy)}
            poster={frames[frameIndex] ? frameSrc(shoot.root, frames[frameIndex]) : undefined}
            onLoadedData={() => { if (pendingSeek.current === null && !seekingRef.current) setVideoReady(true); }}
            className={layout === "player" ? "h-full w-full object-contain" : "aspect-video w-full object-contain"}
            controls={false}
            autoPlay={false}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            preload="auto"
            playsInline
            key={clip.id}
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
          <Img instant={scrubbed.current} src={frameSrc(shoot.root, frames[frameIndex])} alt={`clip ${title} frame`} className={layout === "player" ? "h-full w-full object-contain" : "aspect-video w-full object-cover"} />
        ) : (
          <div className={`flex items-center justify-center text-[13px] text-muted ${layout === "player" ? "h-full" : "aspect-video"}`}>no frames yet</div>
        )}
        {clip.proxy && !videoReady && frames[frameIndex] ? <Img instant={scrubbed.current} src={frameSrc(shoot.root, frames[frameIndex])} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-contain" /> : null}
      </div>
      <div className="mt-2 grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3">
        <div className="flex items-center gap-2">
          {clip.proxy ? <button type="button" aria-label={playing ? "Pause clip" : "Play clip"}
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
        <input
          aria-label="scrub"
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(time, duration)}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-1 w-full min-w-0 cursor-pointer accent-[var(--accent)]"
        />
        <span className="tnum text-[12px] text-muted">{formatTimecode(duration)}</span>
        {/* shake strip shares the scrubber track column so both edges line up */}
        {!(shake && !shake.measured) && perSecond.length ? (
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
      {playError ? <p role="alert" className="mt-1 text-[12px] text-danger">Could not play this preview. Try again.</p> : null}
      {shake && !shake.measured && clip.byHand?.shaky === undefined ? (
        <p className="mt-2 text-[12.5px] text-muted">too dark to judge shake</p>
      ) : null}
      {/* frame thumbnails */}
      {frames.length > 1 ? (
        <div className="mt-2 grid shrink-0 grid-cols-8 gap-1">
          {frames.map((f, i) => (
            <button
              key={f}
              type="button"
              onClick={() => seek(duration ? (i / frames.length) * duration : 0)}
              className={`overflow-hidden rounded-md ${i === frameIndex ? "ring-2 ring-[var(--accent)]" : "opacity-70 hover:opacity-100"}`}
              aria-label={`frame ${i + 1}`}
            >
              <Img src={frameSrc(shoot.root, f)} alt="" className={`aspect-video w-full object-cover ${layout === "player" ? "max-h-8" : ""}`} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
    </div>

  );

  const details = (
    <motion.div variants={detailVariants} initial={layout === "player" ? false : "initial"} animate={layout === "player" || landed || reduced ? "animate" : "initial"}
      className={`flex min-w-0 flex-col gap-5 ${layout === "player" ? "min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain pr-2 pb-3 [&>*]:shrink-0" : ""}`} data-drawer-details
      role={layout === "player" ? "region" : undefined} aria-label={layout === "player" ? "Clip details" : undefined} tabIndex={layout === "player" ? 0 : undefined}>
    {layout === "player" ? tags : null}
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
      <h3 className="font-display text-[13px] font-semibold tracking-tight text-ink">Transcript</h3>
      {clip.transcript?.length ? (
        <div className="mt-2 text-[14px] leading-[1.9] text-ink">
          {clip.transcript.map((seg, si) => (
            <span key={si}>
              {seg.words.map((w, wi) => {
                const active = time >= w.s && time < w.e;
                return (
                  <button
                    key={`${si}-${wi}`}
                    type="button"
                    onClick={() => seek(w.s)}
                    className={`rounded px-[1px] ${active ? "bg-accent/20 text-ink" : "text-ink/85 hover:bg-ink/[0.06]"}`}
                  >
                    {w.w}
                  </button>
                );
              })}{" "}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[13px] text-muted">no transcript for this clip</p>
      )}
    </section>

    {/* takes */}
    {takesInClip.length ? (
      <section>
        <h3 className="font-display text-[13px] font-semibold tracking-tight text-ink">Takes in this clip</h3>
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
      <h3 className="font-display text-[13px] font-semibold tracking-tight text-ink">Details</h3>
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
            ["audio", meta ? `${meta.audioChannels} channels, ${meta.sampleRate} Hz` : "not recorded"],
            ["file size", meta ? formatBytes(meta.sizeBytes) : "not recorded"],
            ["file", clip.file],
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

  if (layout === "player") return (
    <section aria-label={`Clip ${title} player`} aria-hidden={!present} className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4"
      style={{ pointerEvents: present ? undefined : "none" }}>
      <header className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="font-display text-[20px] leading-none font-semibold tracking-tight text-ink">{title}</h2>
          <span className="tnum truncate text-[12px] text-muted">{subtitle}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close clip" title="Close clip (Esc)"
          className={`flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-ink ${FOCUS}`}>
          <X size={16} />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 sm:gap-5">
        {viewer}
        {details}
      </div>
    </section>
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

// Clips owns the sticky space; only the selected content crossfades inside it.
// Other consumers retain the drawer and its existing navigation behavior.
export function ClipPlayer(props: {
  shoot: Shoot;
  clip: Clip;
  initialTime?: number;
  onClose: () => void;
  onShootChange: (shoot: Shoot) => void;
}) {
  const { reduced } = useMotionPresets();
  return <AnimatePresence initial={false}>
    <motion.div key={`${props.shoot.root}/${props.clip.id}`} className="absolute inset-0"
      initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={reduced ? reducedTransition : { duration: dur.fast, ease: ease.out }}>
      <ClipDrawer {...props} layout="player" />
    </motion.div>
  </AnimatePresence>;
}
