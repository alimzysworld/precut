import { RotatingImage } from "../RotatingImage";
import type { DraftPiece, Shoot } from "../../../../shared/schema";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { frameAt, getApi, isFixtureMode } from "../../data";
import { instant, spring } from "../../motion";
import { takeThumbnail } from "../footage/thumbnail";
import { proxyRotation, standInUrl } from "../../../../shared/media";
import { clipDuration } from "./model";
import { usePageActive } from "../../hooks/usePageActivity";

export function DurationBadge({ seconds }: { seconds: number }) {
  const badge = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);
  const label = clipDuration(seconds);
  useEffect(() => {
    const element = badge.current, clip = element?.parentElement;
    if (!element || !clip) return;
    const measure = () => setFits(clip.clientWidth >= element.offsetWidth + 8);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(clip); observer.observe(element);
    return () => observer.disconnect();
  }, [label]);
  return <span ref={badge} data-duration-badge data-fits={fits} aria-hidden={!fits} className="st-timeline-duration" style={{ visibility: fits ? "visible" : "hidden" }}>{label}</span>;
}

/** PS2: frames come from the clip's stand-in strip (made once, in the background). Zooming never starts ffmpeg or a decoder. */
export function Filmstrip({ shoot, clipId, start, length, width, span }: {
  shoot: Shoot; clipId: string; start: number; length: number; width: number; span?: DraftPiece;
}) {
  const pageActive = usePageActive();
  const reduced = useReducedMotion();
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const failed = useRef(new Set<string>());
  const [shown, setShown] = useState<Record<number, { url: string; baked: number }>>({});
  const [retries, setRetries] = useState<Record<string, number>>({});
  useEffect(() => {
    failed.current.clear();
    return getApi().onActivity(activity => {
      if (activity.root === shoot.root && activity.target?.clipId === clipId && activity.state === "done" && activity.label.startsWith("Preparing footage thumbnails") && failed.current.size) {
        const urls = [...failed.current];
        failed.current.clear();
        setRetries(previous => { const next = { ...previous }; for (const url of urls) next[url] = (next[url] ?? 0) + 1; return next; });
      }
    });
  }, [shoot.root, clipId]);
  const clip = shoot.clips.find(clip => clip.id === clipId);
  const count = Math.max(1, Math.min(256, Math.ceil(width / 48)));
  return <>{Array.from({ length: count }, (_, frame) => {
    const elapsed = frame / count * length, t = (span?.startS ?? 0) + elapsed;
    const a = span?.timeMap?.filter(point => point.t <= t).at(-1), z = span?.timeMap?.find(point => point.t > t);
    const source = a && z ? a.s + (z.s - a.s) * (t - a.t) / (z.t - a.t) : a?.s ?? start + elapsed;
    // A clip with a preview reads its strip; one without reads the original's poster, which main serves without a decode.
    const poster = !clip || isFixtureMode() ? frameAt(shoot, clipId, source)
      : clip.proxy && clip.meta?.width ? standInUrl(shoot.root, clip.id, source, clip.meta.durationS, shoot.updatedAt, clip.pictureStrip?.key)
      : takeThumbnail(shoot, { clip, s: source });
    const retry = poster ? retries[poster] : 0;
    const url = poster && retry ? `${poster}${poster.includes("?") ? "&" : "?"}thumbRetry=${retry}` : poster;
    const ready = !!url && loaded.has(url);
    const baked = clip?.pictureStrip?.rotation ?? proxyRotation(clip?.proxy, clip?.meta?.containerRotation ?? clip?.meta?.rotation);
    const previous = shown[frame];
    return <span key={frame} className="st-filmstrip-frame" data-filmstrip-frame data-loading={!ready}>
      {!ready && previous && <RotatingImage root={shoot.root} clip={clip} baked={previous.baked} src={previous.url} alt="" draggable={false} />}
      {!ready && !previous && <span data-filmstrip-placeholder aria-hidden="true" className="st-filmstrip-placeholder"><motion.span className="st-filmstrip-shimmer" initial={{ x: "-100%" }} animate={{ x: reduced || !pageActive ? "0%" : "100%" }} transition={reduced || !pageActive ? instant : { ...spring.sheet, repeat: Infinity, repeatType: "reverse" }} /></span>}
      {url && <RotatingImage root={shoot.root} clip={clip} baked={clip?.pictureStrip?.rotation} key={url} src={url} alt="" draggable={false} loading="lazy" decoding="async" style={{ visibility: ready ? "visible" : "hidden" }} onLoad={() => { failed.current.delete(poster!); setLoaded(previous => new Set([...previous, url])); setShown(previous => ({ ...previous, [frame]: { url, baked } })); }} onError={() => { failed.current.add(poster!); setLoaded(previous => { const next = new Set(previous); next.delete(url); return next; }); }} />}
    </span>;
  })}</>;
}
