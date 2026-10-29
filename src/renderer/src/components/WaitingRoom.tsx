// WR2: the waiting room (docs/plans/WAITING-ROOM.md, design qa/WR2/design/*.dc.html).
// One focal point in the centre while a shoot processes. Every count and time comes from
// ShootProgress.waiting; a finding's words come from main; the questions' words come from the plan
// (the opening five) or the model (follow-ups). Nothing here waits on an answer.
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, CaretDown, CaretUp, FileText, Moon } from "@phosphor-icons/react";
import type { Clip, ProcessingFinding, ReelIdea, Shoot, ShootBrief, ShootProgress, ShootQuestion, ShootReadTime, SidekickMessage, WaitingRoomState } from "../../../shared/schema";
import { needsAi } from "../../../shared/stage-words";
import { getApi } from "../data";
import { go, useNav } from "../nav";
import { announceFolderSplit } from "./splitStatus";
import { instant, spring } from "../motion";
import { usePageActive } from "../hooks/usePageActivity";
import { Button, Img, InlineError, ProgressRing, Row, Tile, useMotionPresets } from "./ui";
import { footagePerspective, waitingStatus } from "./waitingStatus";
import { useWaitingBreak } from "./waitingBreak";
import { FailedClips } from "./FailedClips";
import { useModelAccess, ModelSignIn, openModelSignIn, AiAccess } from "./ModelAccess";
export { waitingStatus } from "./waitingStatus";
import { ideaDuration, ideaFrames } from "./ideas/IdeaCard";
import { takeThumbnail } from "./footage/thumbnail";

// ---- The opening questions, verbatim from the plan.
export const YOU_DECIDE = "You decide";
type BriefKey = "purpose" | "going" | "feel" | "music" | "length";
export const OPENING: { key: BriefKey; lead: string; accent: string; hint: string; options: string[]; label: string }[] = [
  { key: "purpose", label: "For", lead: "What's this", accent: "footage for?", hint: "Pick any that fit. It helps precut look for the right moments.", options: ["Vlog", "Talking to camera", "Montage", "Tutorial", "Event"] },
  { key: "going", label: "Going to", lead: "Where is it", accent: "going?", hint: "Sets the length, crop and captions.", options: ["TikTok", "Instagram Reels", "YouTube Shorts", "YouTube"] },
  { key: "feel", label: "Feel", lead: "How should it", accent: "feel?", hint: "Sets the pace, music and look.", options: ["Calm", "Funny", "High energy", "Cinematic"] },
  { key: "music", label: "Music", lead: "What kind of", accent: "music?", hint: "precut picks tracks from your music folder to match.", options: ["Chill", "Upbeat", "Cinematic", "Hip-hop", "Acoustic"] },
  { key: "length", label: "Length", lead: "About how", accent: "long?", hint: "A rough target is fine.", options: ["15 s", "30 s", "60 s", "Longer"] },
];

// ---- Pure rules (exported for qa/WR2).
/** Multi-select by default. "You decide" clears the others; picking anything else clears "You decide". */
export function togglePick(current: string[], label: string, multi = true): string[] {
  if (label === YOU_DECIDE) return current.includes(YOU_DECIDE) ? [] : [YOU_DECIDE];
  if (current.includes(label)) return current.filter(value => value !== label);
  return multi ? [...current.filter(value => value !== YOU_DECIDE), label] : [label];
}
/** An empty list means "You decide" or skipped: precut decides. */
export function briefFromPicks(picks: string[][]): ShootBrief {
  const list = (index: number) => (picks[index] ?? []).filter(value => value !== YOU_DECIDE);
  return { purpose: list(0), going: list(1), feel: list(2), music: list(3), length: list(4), asked: true };
}
export type RoomState = "loading" | "questions" | "question" | "ready" | "finding" | "reading";
/** States in priority order: the opening questions, a question the person opened, ideas done, a finding, otherwise reading. */
export function roomState({ brief, editing, question, waiting, stayed, findings }: {
  brief: ShootBrief | null | undefined; editing: boolean; question: boolean; waiting: WaitingRoomState | undefined; stayed: boolean; findings: number;
}): RoomState {
  if (brief === undefined && !editing) return "loading";
  if (editing || (brief && !brief.asked)) return "questions";
  if (question) return "question";
  if (waiting?.ideasDone && !stayed) return "ready";
  if (findings > 0) return "finding";
  return "reading";
}
/** Findings seen this visit stay in the pager in the order they arrived, even after main drops old ones. */
export function mergeFindings(previous: ProcessingFinding[], next: ProcessingFinding[]): ProcessingFinding[] {
  const fresh = new Map(next.map(finding => [finding.id, finding]));
  const kept = previous.map(finding => fresh.get(finding.id) ?? finding);
  const known = new Set(previous.map(finding => finding.id));
  const added = next.filter(finding => !known.has(finding.id));
  return added.length || kept.some((finding, index) => finding !== previous[index]) ? [...kept, ...added] : previous;
}
/** null follows the newest; an id pins the one the person went back to. */
export function shownFinding(findings: ProcessingFinding[], viewing: string | null): number {
  const pinned = viewing === null ? -1 : findings.findIndex(finding => finding.id === viewing);
  return pinned >= 0 ? pinned : findings.length - 1;
}
export const countOf = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export function ideasLine(waiting: WaitingRoomState): string {
  return [`${countOf(waiting.ideasReady, "idea")} ready`, waiting.editsMaking > 0 ? `${countOf(waiting.editsMaking, "edit")} still being made` : null].filter(Boolean).join(" · ");
}
export const ideasPillVisible = (waiting: WaitingRoomState | undefined) => !!waiting && waiting.ideasReady > 0 && !waiting.ideasDone;
/** The ideas the thread holds, in first-appearance order (as Ideas builds its board), passed ones left out. */
export function ideasOf(messages: SidekickMessage[]): ReelIdea[] {
  const byId = new Map<string, ReelIdea>();
  messages.forEach(message => message.ideas?.forEach((idea, index) => { const id = idea.id ?? `${message.id}:${index}`; byId.set(id, { ...idea, id }); }));
  return [...byId.values()].filter(idea => !idea.passed);
}
function clipStill(shoot: Shoot | null, clipId: string, t?: number): string | null {
  const clip: Clip | undefined = shoot?.clips.find(item => item.id === clipId);
  if (!shoot || !clip) return null;
  return takeThumbnail(shoot, { clip, s: t ?? (clip.meta ? clip.meta.durationS / 2 : 0) });
}
function splitAccent(text: string): [string, string] {
  const at = text.trim().lastIndexOf(" ");
  return at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [text, ""];
}

/** ONB2: "2 h 10 min", "48 min", "under a minute": how long, in words a person says. */
export function spokenDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
/** ONB2: measured from this shoot's own reading: footage covered and how long it took on this Mac. */
function useReadTime(root: string | undefined, complete: boolean) {
  const [value, setValue] = useState<ShootReadTime | null>(null);
  useEffect(() => {
    setValue(null);
    if (!root || !complete) return;
    let alive = true, tries = 0;
    // The measurement lands a moment after the last stage settles: look again for a little while.
    const look = () => void getApi().shootReadTime?.(root).then(time => { if (!alive) return; setValue(time ?? null); if (!time && ++tries < 60) timer = window.setTimeout(look, 2000); }).catch(() => {});
    let timer = window.setTimeout(look, 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [root, complete]);
  return value;
}
/** ONB2: true only while precut really holds the power assertion (reading or exporting). */
function useKeepingAwake(running: boolean, active: boolean) {
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (!running || !active) { setAwake(false); return; }
    let alive = true;
    const look = () => void getApi().keepingAwake?.().then(value => { if (alive) setAwake(!!value); }).catch(() => {});
    look();
    const timer = window.setInterval(look, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [running, active]);
  return awake;
}

// ---- Data for one shoot, only while the room is the visible page.
function useWaitingData(root: string | undefined, active: boolean) {
  const [progress, setProgress] = useState<ShootProgress>();
  const [brief, setBrief] = useState<ShootBrief | null>();
  const [questions, setQuestions] = useState<ShootQuestion[]>([]);
  const [messages, setMessages] = useState<SidekickMessage[]>([]);
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const asked = useRef(false);
  asked.current = !!brief?.asked;
  useEffect(() => {
    setProgress(undefined); setBrief(undefined); setQuestions([]); setMessages([]); setShoot(null);
    if (!root) return;
    let alive = true;
    void getApi().getBrief(root).then(value => { if (alive) setBrief(value); }).catch(() => { if (alive) setBrief(null); });
    return () => { alive = false; };
  }, [root]);
  useEffect(() => {
    if (!root || !active) return;
    const api = getApi();
    let alive = true, request = 0, last = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const questionsNow = () => { void api.listQuestions(root).then(value => {
      if (!alive) return;
      setQuestions(value);
      // Confident imports split without a question; MCP answers use the same hand-off.
      void api.listShoots().then(shoots => {
        if (!alive || shoots.some(shoot => shoot.root === root)) return;
        const count = shoots.filter(shoot => shoot.root.startsWith(root.replace(/[\\/]$/, "") + "/")).length;
        if (count < 2) return;
        announceFolderSplit(root, count); go("shoots");
      }).catch(() => { /* Retry on the next progress refresh. */ });
    }).catch(() => { /* no questions shown */ }); };
    // An outside `precut --mcp` is its own process: its ask_question and set_brief never fire events here,
    // so questions (and a brief not yet asked) are read again with every progress refresh and on focus.
    const briefNow = () => { if (!asked.current) void api.getBrief(root).then(value => { if (alive && value.asked) setBrief(value); }).catch(() => { /* keep what we have */ }); };
    const refresh = () => {
      const id = ++request; last = Date.now();
      void api.shootProgress(root).then(value => { if (alive && id === request) setProgress(value); }).catch(() => { /* keep the last real state */ });
      questionsNow(); briefNow();
    };
    const schedule = () => { if (!pending) pending = setTimeout(() => { pending = undefined; refresh(); }, Math.max(0, 1000 - (Date.now() - last))); };
    const threadNow = () => { void api.sidekickThread(root).then(value => { if (alive) setMessages(value); }).catch(() => { /* no idea frames */ }); };
    refresh(); threadNow();
    window.addEventListener("focus", refresh);
    const poll = window.setInterval(refresh, 2000);
    const offProgress = api.onProgress(event => { if (event.root === root) schedule(); });
    const offSteps = api.onStepsChanged(changed => { if (changed === root) { schedule(); threadNow(); } });
    const offThread = api.onSidekickChanged(changed => { if (changed === root) threadNow(); });
    const offQuestions = api.onQuestionsChanged(changed => { if (changed === root) questionsNow(); });
    return () => { alive = false; clearTimeout(pending); window.clearInterval(poll); offProgress(); offSteps(); offThread(); offQuestions(); window.removeEventListener("focus", refresh); };
  }, [root, active]);
  // The shoot is read again only when something new needs its stills: new clips in findings, or more ideas.
  const stillsKey = `${progress?.findings.flatMap(finding => finding.clipIds ?? (finding.clipId ? [finding.clipId] : [])).join(",") ?? ""}|${progress?.waiting?.ideasReady ?? 0}|${progress?.waiting?.clips.read ?? 0}|${progress?.waiting?.clips.total ?? 0}|${progress?.running ?? false}`;
  useEffect(() => {
    if (!root || !active) return;
    let alive = true;
    void getApi().loadShoot(root).then(value => { if (alive) setShoot(value); }).catch(() => { /* frames stay out */ });
    return () => { alive = false; };
  }, [root, active, stillsKey]);
  useEffect(() => { if (!root || !active) return; void getApi().sidekickThread(root).then(setMessages).catch(() => {}); }, [root, active, progress?.waiting?.ideasReady]);
  return { progress, brief, setBrief, questions, setQuestions, messages, shoot };
}

// ---- Pieces. State is always a fill or tint change, never a stroke.
const SOFT = "!bg-surface !text-ink hover:!bg-[var(--surface-hover)] focus-visible:!bg-[var(--selection-fill)]";
const PILL_OFF = "!bg-[var(--badge-neutral-fill)] !text-ink hover:!bg-[color-mix(in_srgb,var(--badge-neutral-fill),var(--ink)_10%)] focus-visible:!bg-[color-mix(in_srgb,var(--badge-neutral-fill),var(--ink)_16%)]";
const TINT = "!bg-[color-mix(in_srgb,var(--accent-text)_16%,transparent)] !text-accent hover:!bg-[color-mix(in_srgb,var(--accent-text)_24%,transparent)] focus-visible:!bg-[color-mix(in_srgb,var(--accent-text)_30%,transparent)]";

function Headline({ lead, accent }: { lead: string; accent?: string }) {
  return <h1 className="m-0 font-display text-[56px] font-bold leading-[62px] tracking-[-0.02em] text-ink">{lead}{accent ? <> <span className="text-accent">{accent}</span></> : null}</h1>;
}
function ChoicePills({ options, picked, onPick, label }: { options: string[]; picked: string[]; onPick: (label: string) => void; label: string }) {
  return <div role="group" aria-label={label} className="flex max-w-[720px] flex-wrap justify-center gap-2.5">
    {[...options, YOU_DECIDE].map(option => {
      const on = picked.includes(option);
      return <Button key={option} type="button" variant={on ? "primary" : "secondary"} aria-pressed={on} data-choice={option} onClick={() => onPick(option)}
        className={`min-h-[52px] !px-6 !py-3.5 !text-[16px] !font-medium ${on ? "" : PILL_OFF}`}>{option}</Button>;
    })}
  </div>;
}
function Primary({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <Button type="button" variant="primary" onClick={onClick} disabled={disabled} className="min-h-12 !gap-2 !px-[26px] !py-3 !text-[15px]">{children}<ArrowRight size={16} aria-hidden="true" /></Button>;
}
function Quiet({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <Button type="button" variant="ghost" onClick={onClick} className="min-h-12 !px-4 !py-3 !text-[15px] !font-normal">{children}</Button>;
}
function Spinner({ text }: { text: string }) {
  const [perspective, eta] = text.split(" · ");
  return <span className="flex min-w-0 items-center justify-center gap-2"><ProgressRing pct={null} label="Working" className="shrink-0 text-accent" /><span data-wait-status className="flex flex-wrap justify-center gap-x-1"><span className="whitespace-nowrap">{perspective}</span>{eta && <span className="whitespace-nowrap"> · {eta}</span>}</span></span>;
}

export default function WaitingRoom() {
  const modelReady = useModelAccess();
  const { params } = useNav();
  const root = params.shoot;
  const active = usePageActive();
  const { page: fade, reduced } = useMotionPresets();
  const { progress, brief, setBrief, questions, setQuestions, messages, shoot } = useWaitingData(root, active);
  const waiting = progress?.root === root ? progress?.waiting : undefined;
  const running = progress?.root === root ? !!progress?.running : false;

  // The opening five (also "Change" in Your brief).
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<string[][]>(() => OPENING.map(() => []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A question the person opened, and the run of questions it belongs to.
  const [session, setSession] = useState<string[]>([]);
  const [asking, setAsking] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string[]>([]);
  // Findings and the pager.
  const [findings, setFindings] = useState<ProcessingFinding[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [stayed, setStayed] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [broken, setBroken] = useState<string[]>([]);
  const briefRef = useRef<HTMLDivElement>(null);
  const breakLine = useWaitingBreak(root, waiting?.etaS, running && !waiting?.complete, active);

  useEffect(() => { setEditing(false); setStep(0); setPicks(OPENING.map(() => [])); setAsking(null); setSession([]); setFindings([]); setViewing(null); setStayed(false); setBriefOpen(false); setError(null); }, [root]);
  useEffect(() => { if (progress?.root === root && progress) setFindings(previous => mergeFindings(previous, progress.findings)); }, [progress, root]);
  useEffect(() => {
    if (!briefOpen) return;
    const onPointer = (event: PointerEvent) => { if (!briefRef.current?.contains(event.target as Node)) setBriefOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setBriefOpen(false); };
    window.addEventListener("pointerdown", onPointer); window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onPointer); window.removeEventListener("keydown", onKey); };
  }, [briefOpen]);

  const open = questions.filter(question => question.answer === null);
  const split = open.find(question => question.kind === "split");
  const current = split ?? (asking ? questions.find(question => question.id === asking) : undefined);
  // ONB2: the opening questions brief the AI. With "Start without AI" nobody would read the answers, so they aren't asked.
  const noAi = useContext(AiAccess).status?.choice === "none";
  const state = split ? "question" : roomState({ brief: noAi && brief && !editing ? { ...brief, asked: true } : brief, editing, question: !!current, waiting, stayed, findings: findings.length });
  // ONB2: a shoot read without the AI ends "Ready to edit": the local work is done, the AI stages say so calmly.
  const stages = progress?.root === root ? progress?.stages ?? [] : [];
  const withoutAi = stages.some(stage => needsAi(stage));
  const complete = !!waiting?.complete || (!!progress && progress.root === root && !running && stages.length > 0 && stages.every(stage => stage.state === "done" || stage.state === "skipped"));
  const readTime = useReadTime(root, complete);
  const awake = useKeepingAwake(running && !complete, active);
  const [starting, setStarting] = useState(false);
  if (!root) return null;

  const status = waitingStatus(waiting, running, shoot?.root === root ? shoot : null, progress?.stages);
  const allFailed = !!shoot?.clips.length && shoot.clips.every(c => c.stage === "error");
  const ideasStage = progress?.stages.find(s => s.id === "ideas");
  const ideas = ideasOf(messages);
  const frameOf = (idea: ReelIdea) => shoot ? ideaFrames(shoot, idea.uses).find(frame => !broken.includes(frame.src))?.src ?? null : null;
  const fail = (src: string) => setBroken(previous => previous.includes(src) ? previous : [...previous, src]);

  async function finishOpening(next: string[][]) {
    if (!root) return;
    setSaving(true); setError(null);
    try { const saved = await getApi().setBrief(root, briefFromPicks(next)); setBrief(saved); setEditing(false); setStep(0); }
    catch { setError("Couldn't save your brief. Try again."); }
    finally { setSaving(false); }
  }
  function advance(skip: boolean) {
    const next = skip ? picks.map((list, index) => index === step ? [] : list) : picks;
    setPicks(next);
    if (step < OPENING.length - 1) setStep(step + 1);
    else void finishOpening(next);
  }
  function openQuestions(ids: string[]) {
    if (!ids.length) return;
    setSession(ids); setAsking(ids[0]); setAnswer([]); setBriefOpen(false); setError(null);
  }
  function nextQuestion() {
    const rest = session.slice(session.indexOf(asking ?? "") + 1).filter(id => questions.some(question => question.id === id && question.answer === null));
    if (rest.length) { setAsking(rest[0]); setAnswer([]); } else { setAsking(null); setSession([]); setAnswer([]); }
  }
  async function submitQuestion() {
    if (!root || !current) return;
    if (!answer.length && current.kind !== "split") { nextQuestion(); return; }  // a split's empty answer applies the guess too
    setSaving(true); setError(null);
    try {
      const saved = await getApi().answerQuestion(root, current.id, answer.includes(YOU_DECIDE) ? [] : answer);
      if (saved.kind === "split" && (saved.answer?.length ? saved.answer : saved.guess)[0] === "Separate shoots") { announceFolderSplit(root, saved.folders?.length ?? 0); go("shoots"); return; }
      setQuestions(previous => previous.map(question => question.id === saved.id ? saved : question));
      nextQuestion();
    } catch { setError("Couldn't save that answer. Try again."); }
    finally { setSaving(false); }
  }
  const changeBrief = () => {
    setBriefOpen(false);
    setPicks(OPENING.map(question => [...(brief?.[question.key] ?? [])]));
    setStep(0); setEditing(true); setError(null);
  };
  const toIdeas = (idea?: ReelIdea) => go("ideas", { shoot: root, ...(idea?.id ? { idea: idea.id } : {}) });
  const showFindings = () => { setStayed(true); setViewing(null); };

  // ---- Centre
  let centre: ReactNode = null, key: string = state;
  const questionPill = open.length > 0 && <Button type="button" variant="ghost" data-question-pill onClick={() => openQuestions(open.map(question => question.id))}
    className={`!gap-1.5 !px-3 !py-1.5 !text-[13px] ${TINT}`}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{open.length === 1 ? "1 question for you" : `${open.length} questions for you`}</Button>;
  const statusRow = (extra: ReactNode, text = status) => text ? <div className="flex flex-wrap items-center justify-center gap-3 text-[14px] text-muted"><Spinner text={text} />{extra}</div> : extra ? <div className="flex justify-center">{extra}</div> : null;

  const watchedLine = readTime ? <p data-read-time className="m-0 text-[15px] text-muted"><span className="tnum">{spokenDuration(readTime.footageS)}</span> of footage watched in <span className="tnum">{spokenDuration(readTime.tookS)}</span>, on this Mac</p> : null;
  const startEdit = async () => {
    if (!root || starting) return;
    setStarting(true); setError(null);
    try { const saved = await getApi().createCut(root, {}); go("precuts", { shoot: root, cut: saved.cutId }); }
    catch { setError("Couldn't start an edit. Try again."); }
    finally { setStarting(false); }
  };
  const addAi = () => openModelSignIn("ideas", () => {
    if (!root) return;
    // Back to what was asked: takes, then ideas and first edits, with the AI now ready.
    void getApi().retryStage(root, "group").then(() => getApi().retryStage(root, "ideas")).catch(() => setError("Couldn't start ideas. Retry from the status line."));
  });
  const readyToEdit = withoutAi && complete && !split && !editing;
  if (readyToEdit) {
    centre = <>
      <span data-eyebrow className="font-mono text-[12px] font-semibold text-muted">{shoot?.name ?? root.split(/[\\/]/).filter(Boolean).at(-1)} · read</span>
      {readTime ? <div className="flex flex-col items-center gap-2"><span data-read-time className="font-display text-[clamp(40px,6vw,64px)] font-bold leading-none tracking-[-0.03em] tnum">{spokenDuration(readTime.footageS)}</span>
        <span className="text-[18px] font-semibold text-muted">of footage watched in {spokenDuration(readTime.tookS)}, on this Mac</span></div>
        : <Headline lead="Your footage is" accent="read." />}
      {readTime && <p className="m-0 text-[16px] text-muted">You didn't have to sit through any of it.</p>}
      <div data-ready-to-edit className="flex w-full max-w-[620px] flex-wrap items-center justify-between gap-3 rounded-2xl bg-good-soft px-[18px] py-4 text-left">
        <span className="flex flex-col"><span className="font-semibold text-ink">Ready to edit</span><span className="text-[14px] text-muted">Start an edit, or add an AI for best takes and first edits.</span></span>
        <span className="flex gap-2"><Button type="button" variant="primary" disabled={starting} onClick={() => void startEdit()} className="!px-4 !py-2">{starting ? "Starting…" : "Start an edit"}</Button>
          <Button type="button" variant="secondary" onClick={addAi} className={`!px-4 !py-2 ${SOFT}`}>Add an AI</Button></span>
      </div>
    </>;
    key = "ready-to-edit";
  } else if (state === "questions") {
    const question = OPENING[step];
    centre = <>
      <div className="flex flex-col gap-3"><Headline lead={question.lead} accent={question.accent} /><p className="m-0 text-[18px] leading-[26px] text-muted">{question.hint}</p></div>
      <ChoicePills label={`${question.lead} ${question.accent}`} options={question.options} picked={picks[step]} onPick={label => setPicks(previous => previous.map((list, index) => index === step ? togglePick(list, label) : list))} />
    </>;
    key = `questions:${step}`;
  } else if (state === "question" && current) {
    const guess = current.guess.join(", ");
    centre = <>
      <div className="flex flex-col gap-3.5"><Headline lead="Quick question." /><p className="m-0 text-[22px] leading-[32px] text-ink">{current.why}<br />{current.text}</p></div>
      {!!current.clipIds?.length && <div data-question-frames className="flex flex-wrap items-center justify-center gap-3.5">{current.clipIds.slice(0, 6).map(id => ({ id, src: clipStill(shoot, id) })).filter(frame => frame.src && !broken.includes(frame.src)).map(frame => <Img key={frame.id} src={frame.src!} alt="Clip this question is about" onError={() => fail(frame.src!)} className="h-28 w-40 rounded-xl object-cover" />)}</div>}
      <ChoicePills label={current.text} options={current.options} picked={answer} onPick={label => setAnswer(previous => togglePick(previous, label, current.multi))} />
      {guess && <p data-guess className="m-0 text-[13px] text-muted">{current.kind === "split" ? `You decide uses precut's guess: "${guess}".` : `If you don't answer, precut goes with "${guess}". You can change it in Your brief.`}</p>}
    </>;
    key = `question:${current.id}`;
  } else if (state === "ready" && waiting) {
    const shown = ideas.slice(0, 4);
    centre = <>
      <div className="flex flex-col gap-2.5"><Headline lead="Found something" accent="good." /><p data-ideas-line className="m-0 text-[18px] leading-[26px] text-muted">{ideasLine(waiting)}</p>{watchedLine}</div>
      {shown.length > 0 && <div className="grid justify-center gap-5" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 200px))` }}>
        {shown.map(idea => {
          const src = frameOf(idea), length = ideaDuration(idea.lengthS);
          return <Tile key={idea.id} data-ready-idea={idea.id} onClick={() => toIdeas(idea)} aria-label={`Open idea: ${idea.title}`}
            className="-m-1.5 flex flex-col gap-2.5 rounded-[20px] p-1.5 text-left text-ink hover:bg-ink/[0.05]">
            <span className="relative block">
              {src ? <Img src={src} alt="" onError={() => fail(src)} className="aspect-[3/4] w-full rounded-2xl object-cover" /> : <span className="block aspect-[3/4] w-full rounded-2xl bg-[var(--badge-neutral-fill)]" />}
              {length && <span className="absolute bottom-2.5 right-2.5 rounded-lg bg-surface px-2 py-1 font-mono text-micro text-ink">{length}</span>}
            </span>
            <span className="text-[15px] font-semibold leading-5">{idea.title}</span>
          </Tile>;
        })}
      </div>}
      <div className="flex flex-wrap justify-center gap-2.5">
        <Primary onClick={() => toIdeas()}>See your ideas</Primary>
        <Button type="button" variant="secondary" data-stay onClick={() => setStayed(true)} className={`min-h-12 !px-[22px] !py-3 !text-[15px] ${SOFT}`}>Stay here</Button>
      </div>
    </>;
  } else if (state === "finding") {
    const index = shownFinding(findings, viewing), finding = findings[index];
    const [lead, accent] = splitAccent(finding.text);
    const ids = [...new Set(finding.clipIds?.length ? finding.clipIds : finding.clipId ? [finding.clipId] : [])].slice(0, 5);
    const frames = ids.map((id, at) => ({ id, src: clipStill(shoot, id, at === 0 && id === finding.clipId ? finding.t : undefined), main: at === 0 })).filter(frame => frame.src && !broken.includes(frame.src));
    const main = frames.find(frame => frame.main), others = frames.filter(frame => !frame.main);
    const ordered = main ? [...others.slice(0, Math.ceil(others.length / 2)), main, ...others.slice(Math.ceil(others.length / 2))] : others;
    centre = <>
      {statusRow(questionPill)}
      <div className="flex flex-col gap-3"><Headline lead={lead} accent={accent} />{finding.detail && <p data-finding-detail className="m-0 text-[18px] leading-[26px] text-muted">{finding.detail}</p>}</div>
      {ordered.length > 0 && <div data-finding-frames className="flex items-center justify-center gap-3.5">
        {ordered.map(frame => <Img key={frame.id} src={frame.src!} alt="" data-main-frame={frame.main || undefined} onError={() => fail(frame.src!)}
          className={frame.main ? "h-[240px] w-[180px] rounded-[18px] object-cover" : "h-[160px] w-[120px] rounded-[14px] object-cover opacity-40"} />)}
      </div>}
      {findings.length > 1 && <div className="flex items-center gap-3.5 text-[14px] text-muted">
        <Button type="button" variant="secondary" aria-label="Previous finding" disabled={index === 0} onClick={() => setViewing(findings[index - 1].id)} className={`size-11 !p-0 ${SOFT}`}><ArrowLeft size={16} aria-hidden="true" /></Button>
        <span data-finding-count className="tnum">{index + 1} of {findings.length} findings</span>
        <Button type="button" variant="secondary" aria-label="Next finding" disabled={index === findings.length - 1} onClick={() => setViewing(index + 1 === findings.length - 1 ? null : findings[index + 1].id)} className={`size-11 !p-0 ${SOFT}`}><ArrowRight size={16} aria-hidden="true" /></Button>
      </div>}
    </>;
    key = `finding:${finding.id}`;
  } else if (state === "reading") {
    const clips = waiting && waiting.clips.total > 0 ? waiting.clips : null;
    const caption = clips ? `${clips.read} of ${countOf(clips.total, "clip")} read` : null;
    centre = <>
      {statusRow(questionPill, status?.split(" · ")[1] ?? null)}
      <div className="flex flex-col gap-2"><div className="flex min-h-[124px] items-center justify-center"><Headline lead={breakLine ?? "That's all for now."} /></div><p data-wait-perspective className="m-0 font-display text-[30px] font-semibold leading-[38px] text-muted">{status?.split(" · ")[0] ?? (clips && clips.read === clips.total ? "Your footage is read." : footagePerspective(shoot?.root === root ? shoot : null))}</p></div>
      {clips && <div className="flex w-full max-w-[420px] flex-col gap-3">
        <div role="progressbar" aria-label="Clips read" aria-valuemin={0} aria-valuemax={clips.total} aria-valuenow={clips.read} className="h-2 overflow-hidden rounded-full bg-[var(--badge-neutral-fill)]">
          <motion.div className="st-brand-gradient h-full rounded-full" initial={false} animate={{ width: `${Math.min(100, Math.round(clips.read / clips.total * 100))}%` }} transition={reduced ? instant : spring.sheet} />
        </div>
        <span data-read-caption className="tnum text-[14px] text-muted">{caption}</span>
      </div>}
      {withoutAi && <p data-needs-ai-line className="m-0 text-[14px] text-muted">Best takes, ideas and first edits need your AI. Everything else runs on this Mac.</p>}
    </>;
  }
  if (!readyToEdit && (state === "questions" || state === "question")) centre = <>{state === "question" ? (status || session.length > 1) && <div className="flex flex-wrap items-center justify-center gap-4 text-[14px] text-muted">
    {status && <Spinner text={status} />}{session.length > 1 && <span>Question {session.indexOf(current?.id ?? "") + 1} of {session.length}</span>}</div>
    : status && <div className="flex justify-center text-[14px] text-muted"><Spinner text={status} /></div>}{centre}</>;

  // ---- Footer
  const briefRows = brief ? OPENING.map(question => ({ id: question.key, label: question.label, value: (brief[question.key] ?? []).join(", ") })) : [];
  const questionRows = questions.map(question => ({ id: question.id, label: question.text, value: (question.answer?.length ? question.answer : question.guess).join(", "), question: question.id, guessed: !question.answer?.length }));
  const yourBrief = brief && <div ref={briefRef} className="relative">
    {briefOpen && <motion.div role="region" aria-label="Your brief" data-brief-card variants={fade} initial="initial" animate="animate"
      className="absolute bottom-[calc(100%+12px)] left-0 z-30 flex w-[340px] flex-col gap-3.5 rounded-[22px] bg-surface p-5 text-left">
      <Row>
        <span className="font-display text-[18px] font-semibold">Your brief</span>
        <Button type="button" variant="ghost" onClick={changeBrief} className="!px-2 !py-1 !text-[14px] !font-normal !text-accent">Change</Button>
      </Row>
      <div className="flex flex-col gap-2.5 text-[14px]">
        {briefRows.map(row => <Row key={row.id} data-brief-row={row.id}><span className="text-muted">{row.label}</span><span className={`text-right ${row.value ? "" : "text-muted"}`}>{row.value || "precut decides"}</span></Row>)}
        {questionRows.map(row => <Row as="button" key={row.id} type="button" data-brief-question={row.question} onClick={() => openQuestions([row.question])}
          className="-mx-2 rounded-xl px-2 py-1 text-left hover:bg-ink/[0.05]">
          <span className="text-muted">{row.label}</span><span className={`shrink-0 text-right ${row.guessed ? "text-muted" : ""}`}>{row.value || "precut decides"}</span>
        </Row>)}
      </div>
    </motion.div>}
    <Button type="button" variant="secondary" aria-expanded={briefOpen} data-your-brief onClick={() => setBriefOpen(value => !value)}
      className={`min-h-12 !gap-2 !px-[18px] !py-3 !text-[15px] ${briefOpen ? "!bg-[var(--surface-hover)] !text-ink" : SOFT}`}>
      <FileText size={16} aria-hidden="true" />Your brief{briefOpen ? <CaretDown size={14} aria-hidden="true" /> : <CaretUp size={14} aria-hidden="true" />}
    </Button>
  </div>;
  const newest = ideas.at(-1), newestFrame = newest ? frameOf(newest) : null;
  const ideasPill = ideasPillVisible(waiting) && <Button type="button" variant="secondary" data-ideas-pill onClick={() => toIdeas()}
    className={`min-h-12 !gap-2.5 !py-1.5 !pr-4 !text-[15px] ${newestFrame ? "!pl-1.5" : "!pl-4"} ${SOFT}`}>
    {newestFrame && <img src={newestFrame} alt="" onError={() => fail(newestFrame)} className="size-9 rounded-full object-cover" />}
    {waiting!.ideasReady === 1 ? "1 idea ready" : `${waiting!.ideasReady} ideas ready`}<ArrowRight size={16} aria-hidden="true" />
  </Button>;
  let left: ReactNode = yourBrief, middle: ReactNode = null, right: ReactNode = ideasPill;
  if (state === "questions") { left = <Quiet onClick={() => advance(true)}>Skip</Quiet>; middle = `${step + 1} of ${OPENING.length}`; right = <Primary disabled={saving} onClick={() => advance(false)}>{step === OPENING.length - 1 ? "Done" : "Next"}</Primary>; }
  if (state === "question") {
    const last = !session.slice(session.indexOf(asking ?? "") + 1).some(id => questions.some(question => question.id === id && question.answer === null));
    left = split ? null : <Quiet onClick={() => { setAsking(null); setSession([]); setAnswer([]); setError(null); }}>Later</Quiet>;
    right = <Primary disabled={saving} onClick={() => void submitQuestion()}>{last ? "Done" : "Next"}</Primary>;
  }
  if (state === "ready") right = findings.length > 0 && <Button type="button" variant="ghost" data-noticed onClick={showFindings} className="!px-1 !py-3 !text-[14px] !font-normal underline underline-offset-4">What precut noticed ({findings.length})</Button>;
  if (state === "loading") left = null;
  if (readyToEdit) { left = noAi ? null : yourBrief; middle = null; right = null; }

  return <div data-waiting-room data-state={state} className="relative flex min-h-full flex-col text-ink">
    <main className="flex flex-1 flex-col items-center justify-center px-4 pb-10 pt-6 text-center">
      <AnimatePresence key={split?.id ?? "reading"} mode="wait" initial={false}>
        <motion.div key={key} variants={fade} initial="initial" animate="animate" exit="exit" className="flex w-full max-w-[820px] flex-col items-center gap-7">
          {allFailed ? <Headline lead="Your footage needs a look." /> : centre}
          <FailedClips shoot={shoot?.root === root ? shoot : null} />
          {!allFailed && ideasStage?.state === "failed" && (modelReady ? <div className="text-small text-muted">Couldn't find ideas.<Button variant="ghost" onClick={() => { setError(null); void getApi().retryStage(root, "ideas").catch(() => setError("Couldn't retry ideas. Try again.")); }}>Retry</Button></div> : <ModelSignIn feature="ideas" onReady={() => void getApi().retryStage(root, "ideas").catch(() => setError("Couldn't retry ideas. Try again."))} />)}
          {!allFailed && ideasStage?.state === "skipped" && !needsAi(ideasStage) && <p className="m-0 text-small text-muted">Ideas are paused. You can continue in Ideas.</p>}
          {awake && !readyToEdit && <span data-keep-awake className="flex items-center justify-center gap-2 text-[13px] text-muted"><Moon size={14} aria-hidden="true" /><b className="font-medium text-ink/80">Keeping your Mac awake</b> while precut reads. It can sleep again when this finishes.</span>}
          {error && <InlineError className="m-0 text-small text-danger">{error}</InlineError>}
        </motion.div>
      </AnimatePresence>
    </main>
    <footer className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-2 pb-8">
      <div className="justify-self-start">{left}</div>
      <span data-counter className="tnum text-[14px] text-muted">{middle}</span>
      <div className="justify-self-end">{right}</div>
    </footer>
  </div>;
}
