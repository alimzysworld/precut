import { SectionHeader, Tile } from "../ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { More, Star } from "../icons";
import type { Activity, ReelIdea, Shoot, ShootRequest, SkillFormat } from "../../../../shared/schema";
import { frameSrc } from "../../data";
import { resolveStoryboard, storyboardAspect } from "../../../../shared/storyboard";
import { StoryboardStill } from "./Storyboard";
import { instant, spring } from "../../motion";
import { Badge, Button, FOCUS, Img, Menu, useMotionPresets } from "../ui";
import { usePageActive } from "../../hooks/usePageActivity";
import { videoTypeLabel } from "../videoTypes";

export type BoardIdea = { idea: ReelIdea; messageId: string; index: number };
export type Readiness = "Ready" | "Needs footage";
export const missingShots = (idea: ReelIdea) => idea.missing.filter(line => line.trim());
export const ideaReadiness = (idea: ReelIdea): Readiness => missingShots(idea).length ? "Needs footage" : "Ready";
export function ideaDrafting(entry: BoardIdea, activities: Activity[], pending?: { messageId: string; index: number }) {
  return (pending?.messageId === entry.messageId && pending.index === entry.index) || activities.some(activity =>
    activity.kind === "cut" && activity.state === "running" &&
    ((!!entry.idea.id && activity.target?.ideaId === entry.idea.id) || (!!entry.idea.cutId && activity.target?.cutId === entry.idea.cutId)));
}
export function ideaDraftState(entry: BoardIdea, activities: Activity[], requests: ShootRequest[], pending?: { messageId: string; index: number }): "making" | "queued" | undefined {
  if (ideaDrafting(entry, activities.filter(a => !a.label.startsWith("Queued:")), pending)) return "making";
  if (requests.some(r => r.fromIdea && (r.ideaIds.includes(entry.idea.id!) || r.fromIdea.messageId === entry.messageId && r.fromIdea.index === entry.index) && ["queued", "working"].includes(r.state)) ||
    activities.some(a => a.state === "running" && a.label.startsWith("Queued:") && a.target?.ideaId === entry.idea.id)) return "queued";
}

// Compatibility for the existing details strip; the same resolver powers MCP and cards.
export function ideaFrames(shoot: Shoot, uses: string[]) {
  return resolveStoryboard(shoot, uses).flatMap(shot => shot.framePath ? [{ id: shot.id, src: frameSrc(shoot.root, shot.framePath), label: shot.spokenLine ?? "Footage used by this idea" }] : []);
}

export function ideaDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export function IdeaCard({ shoot, entry, expanded = false, linked, editLengthS, drafting, queued = false, saving = false, failure, passing, onOpen, onCut, onDiscuss, onPass, onFocus, aspect }: {
  shoot: Shoot; entry: BoardIdea; expanded?: boolean; linked: boolean; drafting: boolean; passing: boolean;
  aspect?: SkillFormat["aspect"];
  editLengthS?: number;
  queued?: boolean; saving?: boolean; failure?: string; onDiscuss?: () => void;
  onOpen: () => void; onCut: () => void; onPass: () => void; onFocus?: () => void;
}) {
  const active = usePageActive();
  const { idea } = entry;
  const { reduced } = useMotionPresets();
  const [earlier, setEarlier] = useState<number | null>(null);
  const shown = earlier === null ? idea : idea.earlier?.[earlier] ?? idea;
  const [hovered, setHovered] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const readyFrames = useRef(new Set<string>());
  const shots = useMemo(() => resolveStoryboard(shoot, shown.uses, frame => !failed.has(frame)), [shoot, shown.uses, failed]);
  useEffect(() => {
    setFrameIndex(0);
  }, [active, hovered, shots.length, shown.uses]);
  const shot = shots[hovered ? frameIndex % Math.max(1, shots.length) : 0];
  const nextShot = shots[((hovered ? frameIndex : 0) + 1) % Math.max(1, shots.length)];
  useEffect(() => {
    if (!active || shots.length < 2 || !nextShot?.framePath) return;
    const frame = nextShot.framePath;
    const src = frameSrc(shoot.root, frame);
    if (readyFrames.current.has(src)) return;
    let cancelled = false;
    const image = new Image();
    const fail = () => { if (!cancelled) setFailed(previous => new Set([...previous, frame])); };
    image.onload = () => { void image.decode().then(() => { if (!cancelled) readyFrames.current.add(src); }, fail); };
    image.onerror = fail;
    image.src = src;
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [active, nextShot?.framePath, shoot.root, shots.length]);
  useEffect(() => {
    if (!active || !hovered || shots.length < 2) return;
    const timer = window.setInterval(() => setFrameIndex(value => {
      const next = (value + 1) % shots.length;
      const frame = shots[next].framePath;
      // Keep the current picture if a slow disk has not decoded the next one yet.
      return !frame || readyFrames.current.has(frameSrc(shoot.root, frame)) ? next : value;
    }), 500);
    return () => window.clearInterval(timer);
  }, [active, hovered, shots, shoot.root]);
  const shape = storyboardAspect(shown, shoot, aspect);
  const length = ideaDuration(editLengthS ?? shown.lengthS);
  const missing = missingShots(shown);
  const readiness = ideaReadiness(shown);
  return <Tile as="article" data-idea-card data-idea-id={idea.id} data-idea-status={readiness}
    aria-label={idea.title} tabIndex={0} onFocus={onFocus}
    className={`relative flex min-w-0 flex-col rounded-3xl bg-surface ${expanded ? "mx-auto max-w-4xl p-6" : "p-3"} ${FOCUS}`}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? instant : spring.sheet}>
    <button type="button" data-storyboard-preview aria-label={`Open idea: ${shown.title}`} onClick={onOpen}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onBlur={() => setHovered(false)}
      className={`relative block ${expanded ? "w-40 self-start" : "w-full"} overflow-hidden rounded-2xl bg-black focus-visible:bg-ink/15`}
      style={{ aspectRatio: shape.replace(":", " / ") }}>
      <StoryboardStill shoot={shoot} shot={shot} onError={() => { if (shot?.framePath) setFailed(previous => new Set([...previous, shot.framePath!])); }} />
      {length && <span aria-label={`${editLengthS === undefined ? "Approximate duration" : "Edit duration"} ${length}`} className="absolute bottom-2 right-2 rounded-lg bg-surface px-2 py-1 font-mono text-micro text-ink">{length}</span>}
    </button>
    <div className={`flex flex-wrap items-center gap-2 ${expanded ? "mt-4" : "mt-2"}`}>
      <Badge tone={readiness === "Ready" ? "lime" : "amber"}>{readiness}</Badge>
      {videoTypeLabel(shown.type) && <Badge>{videoTypeLabel(shown.type)}</Badge>}
      {idea.pick && <Badge tone="violet" icon={<Star size={12} />}>Pick</Badge>}
      {idea.passed && <Badge>Passed</Badge>}
      {linked ? <Badge tone="lime">Edit ready</Badge> : null}
      {idea.requestId && <span className="text-micro text-muted">Your request</span>}
    </div>
    <SectionHeader as="h2" className={`${expanded ? "mt-3 text-display" : "mt-2 line-clamp-2 text-body"} font-display font-semibold leading-snug tracking-tight`}>
      {expanded ? shown.title : <button type="button" className={`text-left hover:text-accent ${FOCUS}`} aria-label={`View idea: ${shown.title}`} onClick={onOpen}>{shown.title}</button>}
    </SectionHeader>
    {expanded && <p className="mt-2 whitespace-pre-wrap text-small leading-relaxed text-muted">{shown.concept}</p>}
    {shown.hook && <p className={`text-small leading-snug ${expanded ? "mt-3 whitespace-pre-wrap" : "mt-1 line-clamp-1 text-muted"}`}>{shown.hook}</p>}
    {expanded && length && <p className="mt-3 text-small text-muted">{length}{videoTypeLabel(shown.type) ? ` · ${videoTypeLabel(shown.type)}` : ""}</p>}
    {expanded && shots.length > 0 && <ol aria-label="Story in order" className="mt-5 space-y-4">{shots.map((beat, index) => {
      const summary = shoot.clips.find(clip => clip.id === beat.clipId)?.judgement?.summary;
      return <li key={`${beat.id}-${index}`} data-story-beat className="flex items-start gap-3">
        <div className="relative aspect-[4/3] w-28 shrink-0 overflow-hidden rounded-xl bg-ground"><StoryboardStill shoot={shoot} shot={beat} /></div>
        <div className="min-w-0 text-small"><p className="text-micro text-muted">{index + 1}</p>
          {summary && <p className="mt-1 whitespace-pre-wrap">{summary}</p>}
          {beat.spokenLine && <blockquote className="mt-2 whitespace-pre-wrap text-muted">“{beat.spokenLine}”</blockquote>}
        </div>
      </li>;
    })}</ol>}
    {expanded && missing.length > 0 && <section aria-label="Missing shots" className="mt-5 text-small"><SectionHeader>What’s missing</SectionHeader><ul className="mt-2 space-y-2 text-muted">{missing.map((line, index) => <li key={index}>{line}</li>)}</ul></section>}
    {expanded && idea.earlier?.length ? <label className="mt-5 flex flex-wrap items-center gap-3 text-small text-muted">Earlier version
      <select aria-label="Earlier version" value={earlier ?? "current"} className={`rounded-xl bg-ground px-3 py-2 text-ink ${FOCUS}`}
        onChange={event => setEarlier(event.target.value === "current" ? null : Number(event.target.value))}>
        <option value="current">Current version</option>{idea.earlier.map((_, index) => <option key={index} value={index}>Version {index + 1}</option>)}
      </select>
    </label> : null}
    {!linked && !drafting && !queued && failure && <p role="status" className="mt-3 text-small text-danger">{failure}</p>}
    <div className={`mt-auto flex flex-wrap items-center gap-2 ${expanded ? "pt-5" : "pt-3"}`}>
      {readiness === "Needs footage" && <Button type="button" variant="primary" onClick={onDiscuss}>Discuss</Button>}
      <Button type="button" variant={readiness === "Ready" ? "primary" : "secondary"} title="Open or make edit (Enter)" aria-busy={!linked && (drafting || queued || saving)} disabled={!linked && (drafting || queued || saving)} onClick={onCut}>
        {linked ? "Open" : drafting ? "Making…" : queued ? "Queued" : saving ? "Saving…" : failure ? "Retry" : earlier !== null ? "Make current idea" : "Make this"}
      </Button>
      {readiness === "Ready" && <Button type="button" variant="secondary" onClick={onDiscuss}>Discuss</Button>}
      <div className="ml-auto"><Menu label={`More for ${idea.title}`} items={[
        { id: "details", label: "Open idea", onSelect: onOpen },
        { id: "pass", label: idea.passed ? "Restore idea" : "Pass", shortcut: "P", disabled: passing, onSelect: onPass },
      ]}><More size={20} /></Menu></div>
    </div>
  </Tile>;
}
