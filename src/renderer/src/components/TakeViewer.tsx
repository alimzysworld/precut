import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Api, AudioFile, CaptionsPending, PeakSlice } from "../../../shared/schema";
import { takeWordList, voiceText } from "../../../shared/voice-edit";
import { getApi } from "../data";
import { useShortcuts } from "../hooks/useShortcuts";
import { holdTake, heldTake, playSpans, stopAudition, type Audition, type AuditionSpan } from "./planAudio";
import { voiceClock, voiceSource } from "./voiceoverModel";
import { InlineError, SectionHeader } from "./ui";
import { ModelSignIn, useModelAccess } from "./ModelAccess";
import { Close, Pause, Play } from "./icons";
import "./takeViewer.css";

/** VO7-7: the take viewer and Clean read review. The shapes mirror
 * src/main/clean-read.ts, which the renderer can't import; the shared contract
 * names them later. */
type WordSpan = { from: string; to: string; s: number; e: number };
export type CleanWord = { id: string; s: number; e: number; w: string; kind: "read" | "option" | "false start" | "ending" | "aside" | "kept"; ref: string | null };
export type CleanReadChoices = { read: string; repeats: Record<string, string>; ending: string; restore: string[] };
export type CleanReadProposal = {
  take: string; durationS: number; identity: { content: string; transcript: string; script: string }; script: string[] | null; scriptSource: string | null;
  words: CleanWord[]; reads: (WordSpan & { id: string; label: string; complete: boolean })[];
  repeats: { id: string; read: string; label: string; options: (WordSpan & { id: string; label: string; complete: boolean; loses: WordSpan })[]; falseStarts: WordSpan[] }[];
  endings: { id: string; label: string; span: WordSpan | null }[];
  struck: { id: string; kind: "aside" | "dead air"; label: string; s: number; e: number; from: string | null; to: string | null }[];
  defaults: CleanReadChoices; model: string; madeAt: string; note: string | null;
};
export type CleanReadPlan = { take: string; identity: CleanReadProposal["identity"]; spans: (AuditionSpan & { from: string; to: string; cutBefore: boolean })[]; durationS: number; choices: CleanReadChoices };
export interface CleanReadApi {
  cleanRead(root: string, take: string, cut?: string): Promise<{ proposal: CleanReadProposal; reason: null } | { proposal: null; reason: string }>;
  /** Add a recording: resolves once the take's words are saved (transcribing it again if they never came). */
  waitVoiceoverWords(root: string, take: string): Promise<void>;
  cleanReadPlan(root: string, take: string, cut: string | undefined, choices: Partial<CleanReadChoices>): Promise<CleanReadPlan>;
  voiceoverCaptionsPending(root: string, cutId: string, version: number): Promise<CaptionsPending | null>;
}
export const cleanReadApi = () => getApi() as Api & Partial<CleanReadApi>;

/** A marked range, or the whole take, dragged onto the timeline. Stage 8 finishes the drop. */
export const TAKE_DRAG_TYPE = "application/x-precut-take";
export type TakeDrag = { root: string; take: string; s: number; e: number };
export function readTakeDrag(transfer: DataTransfer): TakeDrag | null {
  try {
    const value = JSON.parse(transfer.getData(TAKE_DRAG_TYPE)) as TakeDrag;
    return typeof value?.take === "string" && Number.isFinite(value.s) && Number.isFinite(value.e) && value.e > value.s ? value : null;
  } catch { return null; }
}

const clock = (t: number) => `${voiceClock(t)}.${Math.floor((Math.max(0, t) % 1) * 10)}`;
const BAR_PX = 3;

// Peaks fetched this session, so reopening a take paints in the same frame.
const peakCache = new Map<string, PeakSlice>(), peakLoads = new Map<string, Promise<PeakSlice | null>>();
/** Fetch a take's peaks ahead (the Voiceover panel does this for its takes), so opening one paints at once. */
export function warmTakePeaks(root: string, file: string): Promise<PeakSlice | null> {
  const key = `${root}|${file}`, hit = peakCache.get(key);
  if (hit) return Promise.resolve(hit);
  let load = peakLoads.get(key);
  if (!load) {
    load = Promise.resolve().then(() => getApi().getPeaks?.(root, file) ?? null).then(slice => {
      if (slice) { peakCache.set(key, slice); while (peakCache.size > 8) peakCache.delete(peakCache.keys().next().value!); }
      return slice;
    }).finally(() => peakLoads.delete(key));
    peakLoads.set(key, load);
  }
  return load;
}
function columns(slice: PeakSlice, count: number): number[] {
  const n = slice.max.length, out: number[] = [];
  if (!n || count <= 0) return out;
  for (let c = 0; c < count; c++) {
    let peak = 0;
    for (let i = Math.floor(c * n / count), end = Math.max(i + 1, Math.floor((c + 1) * n / count)); i < end && i < n; i++) peak = Math.max(peak, -slice.min[i], slice.max[i]);
    out.push(Math.min(1, peak / 127));
  }
  return out;
}

type Marks = { in?: number; out?: number };
const rangeOf = (marks: Marks, duration: number) => marks.in === undefined && marks.out === undefined ? null : { s: marks.in ?? 0, e: marks.out ?? duration };

export function TakeViewer({ root, take, label, cutId, scriptKey, playhead, busy, canAdd, autoClean, replacing, onAddRange, onAddPlan, onClose }: {
  root: string; take: AudioFile; label: string; cutId?: string;
  /** Changes when the edit's script text changes, so a proposal made from the old one shows stale. */
  scriptKey: string;
  /** The edit's playhead, where Add lands. */
  playhead: number;
  busy: boolean; canAdd: boolean;
  /** Add a recording: Clean read starts by itself when the viewer opens. */
  autoClean?: boolean;
  /** Add a recording: Apply replaces the raw piece already on the lane instead of adding beside it. */
  replacing?: boolean;
  onAddRange: (s: number, e: number) => Promise<unknown>;
  onAddPlan: (plan: CleanReadPlan) => Promise<{ appended?: boolean } | null | undefined>;
  onClose: () => void;
}) {
  const url = voiceSource(root, take.file), duration = take.durationS;
  const section = useRef<HTMLElement>(null), wave = useRef<HTMLDivElement>(null), head = useRef<HTMLSpanElement>(null), timeText = useRef<HTMLSpanElement>(null), words = useRef<HTMLParagraphElement>(null);
  const pos = useRef(0), audition = useRef<Audition | null>(null), frame = useRef(0), lastWord = useRef(-1);
  // A play still waiting for the take to decode: Space or K again cancels it instead of starting a second one.
  const starting = useRef<object | null>(null);
  const [playing, setPlaying] = useState<string | null>(null), [marks, setMarks] = useState<Marks>({});
  const [peaks, setPeaks] = useState<PeakSlice | null>(() => peakCache.get(`${root}|${take.file}`) ?? null), [width, setWidth] = useState(0);
  const [auto] = useState(!!autoClean);
  const [review, setReview] = useState(auto), [keep, setKeep] = useState<AuditionSpan[] | null>(null);
  const [error, setError] = useState<string | null>(null), [adding, setAdding] = useState(false);
  const list = useMemo(() => takeWordList(take), [take]);
  // The transcriber's own spacing joins "work" and "-life", as voiceText does.
  const spaced = useMemo(() => list.filter(({ word }) => /^\s/u.test(word.w)).length * 2 > list.length, [list]);
  const gapBefore = (w: string) => spaced ? /^\s/u.test(w) : !/^[-'’,.!?;:)]/u.test(w.trim());
  const range = rangeOf(marks, duration);

  // The take stays decoded while it is open, so Play starts on the next audio quantum.
  // data-decoded marks when that is true, so Play's start time is measured from a decoded take.
  const [decoded, setDecoded] = useState(false);
  useEffect(() => {
    const release = holdTake(url); let live = true; setDecoded(false);
    void heldTake(url)?.then(() => { if (live) setDecoded(true); }, () => { /* Play says so */ });
    return () => { live = false; release(); };
  }, [url]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); if (audition.current || starting.current) stopAudition(); }, []);
  useEffect(() => {
    const hit = peakCache.get(`${root}|${take.file}`);
    if (hit) { setPeaks(hit); return; }
    let live = true; setPeaks(null);
    void warmTakePeaks(root, take.file).then(slice => { if (live && slice) setPeaks(slice); }).catch(() => { /* the quiet empty wave stays; Play still works */ });
    return () => { live = false; };
  }, [root, take.file]);
  useLayoutEffect(() => {
    const node = wave.current; if (!node) return;
    setWidth(Math.round(node.getBoundingClientRect().width));
    const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { section.current?.focus({ preventScroll: true }); paint(0); }, [take.file]);
  const bars = useMemo(() => peaks && width > 0 ? columns(peaks, Math.max(1, Math.floor(width / BAR_PX))) : [], [peaks, width]);
  useEffect(() => { paint(pos.current); }, [width]);

  /** The playhead, time and current word follow the sound without re-rendering. */
  function paint(t: number) {
    pos.current = Math.max(0, Math.min(duration, t));
    if (head.current) head.current.style.transform = `translateX(${(pos.current / duration) * (wave.current?.clientWidth ?? 0)}px)`;
    if (timeText.current) timeText.current.textContent = clock(pos.current);
    let lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].word.s <= pos.current) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at >= 0 && pos.current > list[at].word.e + 0.6) at = -1;
    if (at !== lastWord.current) {
      words.current?.querySelector('[data-current]')?.removeAttribute("data-current");
      if (at >= 0) words.current?.querySelector(`[data-word="${at}"]`)?.setAttribute("data-current", "");
      lastWord.current = at;
    }
  }
  function follow(a: Audition, key: string) {
    audition.current = a; setPlaying(key); cancelAnimationFrame(frame.current);
    const tick = () => { if (audition.current !== a) return; paint(a.takeTime()); frame.current = requestAnimationFrame(tick); };
    tick();
    void a.ended.then(() => { if (audition.current !== a) return; audition.current = null; cancelAnimationFrame(frame.current); paint(a.takeTime()); setPlaying(null); });
  }
  function stop() {
    const a = audition.current, pending = starting.current; audition.current = null; starting.current = null; cancelAnimationFrame(frame.current);
    if (a) { paint(a.takeTime()); a.stop(); } else if (pending) stopAudition();
    setPlaying(null);
  }
  /** Plays plan seconds [from, to] of spans; the viewer's own playback is the whole take as one span. */
  async function play(key: string, spans: AuditionSpan[], opts: { from?: number; to?: number; rate?: number; reverse?: boolean; inputAt?: number }) {
    setError(null);
    const token = {}; starting.current = token;
    try {
      const a = await playSpans(url, spans, opts);
      if (starting.current !== token) { a.stop(); return; }
      starting.current = null; follow(a, key);
    }
    catch (e) {
      if (starting.current === token) starting.current = null;
      if (!(e instanceof Error && e.message === "Another audition started.")) { setPlaying(null); setError("Couldn't play that take. Check the drive is connected."); }
    }
  }
  const whole: AuditionSpan[] = [{ s: 0, e: duration }];
  function playTake(opts: { rate?: number; reverse?: boolean; inputAt?: number } = {}) {
    const from = opts.reverse ? 0 : pos.current >= duration - 0.05 ? 0 : pos.current;
    void play("take", whole, opts.reverse ? { to: pos.current, rate: opts.rate, reverse: true, inputAt: opts.inputAt } : { from, rate: opts.rate, inputAt: opts.inputAt });
  }
  function toggle(inputAt?: number) { if (playing || starting.current) stop(); else playTake({ inputAt }); }
  function seek(t: number) {
    const was = playing === "take" ? audition.current : null;
    if (audition.current) stop();
    paint(t);
    if (was) playTake({ rate: was.rate, reverse: was.reverse });
  }
  function shuttle(direction: 1 | -1, inputAt: number) {
    const a = playing === "take" ? audition.current : null;
    const same = a && a.reverse === (direction < 0);
    const rate = same ? Math.min(4, a.rate * 2) : 1;
    if (a) stop();
    playTake({ rate, reverse: direction < 0, inputAt });
  }
  function mark(edge: "in" | "out") {
    const t = pos.current;
    setMarks(m => edge === "in" ? { in: t, out: m.out !== undefined && m.out > t + 0.05 ? m.out : undefined } : { in: m.in !== undefined && m.in < t - 0.05 ? m.in : undefined, out: t });
  }
  // The take viewer is a source viewer: while it has focus its keys go first, the way the Media
  // panel's source preview does ("source-" shortcuts dispatch before the edit's). ⌘Z stays the edit's.
  const [focused, setFocused] = useState(false);
  const key = (id: string, keys: string[], label: string, run: (event: KeyboardEvent) => void, repeat = false) => ({ id: `source-take-${id}`, scope: "precuts", keys, label, repeat, handler: run });
  useShortcuts("precuts", [
    key("play", ["Space"], "Play or pause the take", event => {
      // Space on another button or option presses it, as it would anywhere else.
      const target = event.target as HTMLElement | null, control = target?.closest?.("button, [role='radio']") as HTMLElement | null;
      if (control && !control.hasAttribute("data-take-play")) control.click(); else toggle(event.timeStamp);
    }),
    key("reverse", ["j"], "Play the take backward, repeat for 2x or 4x", event => shuttle(-1, event.timeStamp)),
    key("pause", ["k"], "Pause the take", () => stop()),
    key("forward", ["l"], "Play the take forward, repeat for 2x or 4x", event => shuttle(1, event.timeStamp)),
    key("in", ["i"], "Mark in", () => mark("in")),
    key("out", ["o"], "Mark out", () => mark("out")),
    key("back", ["ArrowLeft"], "Back one second", () => seek(pos.current - 1), true),
    key("ahead", ["ArrowRight"], "Forward one second", () => seek(pos.current + 1), true),
    key("back-5", ["Shift+ArrowLeft"], "Back five seconds", () => seek(pos.current - 5), true),
    key("ahead-5", ["Shift+ArrowRight"], "Forward five seconds", () => seek(pos.current + 5), true),
  ], focused);
  // Press and drag on the waveform marks a part; a click moves the playhead.
  const press = useRef<{ x: number; id: number; marking: boolean } | null>(null);
  const timeAt = (x: number) => { const box = wave.current!.getBoundingClientRect(); return Math.max(0, Math.min(duration, (x - box.left) / Math.max(1, box.width) * duration)); };
  function dragStart(event: React.DragEvent, s: number, e: number) {
    event.dataTransfer.setData(TAKE_DRAG_TYPE, JSON.stringify({ root, take: take.file, s, e } satisfies TakeDrag));
    event.dataTransfer.effectAllowed = "copy";
  }
  async function addRange() {
    if (adding) return;
    setAdding(true); setError(null);
    const r = range ?? { s: 0, e: duration };
    try { await onAddRange(r.s, r.e); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't add that part. Try again."); } finally { setAdding(false); }
  }
  const pct = (t: number) => `${(t / duration) * 100}%`;
  const path = bars.map((p, i) => `M${i + .5} ${1 - Math.max(.02, p)}V${1 + Math.max(.02, p)}`).join("");
  return <div className="tv-root" onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <section ref={section} className="tv" data-take-viewer={take.file} data-decoded={decoded || undefined} tabIndex={0} aria-label={`Take from ${label}`}>
      <header className="tv-head">
        <span className="tv-title" draggable onDragStart={event => dragStart(event, range?.s ?? 0, range?.e ?? duration)} title="Drag onto the timeline">{label}<span className="tv-length">{voiceClock(duration)}</span></span>
        {review && <button type="button" className="tv-pill" data-active="" onClick={() => { stop(); setReview(false); setKeep(null); }} title="Back to the whole take">Clean read</button>}
        <button type="button" className="tv-icon" aria-label="Close take" onClick={() => { stop(); onClose(); }}><Close size={16} /></button>
      </header>
      <div ref={wave} className="tv-wave" data-compact={review || undefined} data-wave-ready={bars.length ? "" : undefined}
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest("[data-take-range]") || event.button !== 0) return;
          press.current = { x: event.clientX, id: event.pointerId, marking: false }; event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const p = press.current; if (!p || p.id !== event.pointerId) return;
          if (!p.marking && Math.abs(event.clientX - p.x) < 4) return;
          p.marking = true; const a = timeAt(p.x), b = timeAt(event.clientX);
          setMarks({ in: Math.min(a, b), out: Math.max(a, b) });
        }}
        onPointerUp={event => { const p = press.current; press.current = null; if (p && !p.marking && p.id === event.pointerId) seek(timeAt(event.clientX)); }}
        onPointerCancel={() => { press.current = null; }}>
        {keep?.map((span, i) => <span key={i} className="tv-keep" style={{ left: pct(span.s), width: pct(span.e - span.s) }} />)}
        {range && <span data-take-range className="tv-range" draggable title="Drag onto the timeline" style={{ left: pct(range.s), width: pct(Math.max(0, range.e - range.s)) }}
          onDragStart={event => dragStart(event, range.s, range.e)} onClick={event => seek(timeAt(event.clientX))} />}
        {bars.length ? <svg aria-hidden viewBox={`0 0 ${bars.length} 2`} preserveAspectRatio="none" className="tv-svg"><path d={path} /></svg>
          : <span className="tv-wave-empty">{take.transcript === null ? "Your take is still being transcribed" : ""}</span>}
        <span ref={head} className="tv-head-line" aria-hidden />
      </div>
      <div className="tv-transport">
        <button type="button" data-take-play className="tv-icon" data-playing={playing === "take" || undefined} aria-label={playing ? "Pause" : "Play"} onClick={event => toggle(event.timeStamp)}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
        <span className="tv-time"><span ref={timeText}>0:00.0</span><span className="tv-muted"> / {voiceClock(duration)}</span></span>
        <span className="tv-marks" data-take-marks>{range ? <>{voiceClock(range.s)} to {voiceClock(range.e)}<button type="button" className="tv-clear" onClick={() => setMarks({})}>Clear</button></> : <span className="tv-muted">I and O mark a part</span>}</span>
      </div>
      {!review && <div className="tv-actions">
        <button type="button" className="st-button-primary" disabled={!take.transcript?.length} onClick={() => { stop(); setReview(true); }}>Clean read</button>
        <button type="button" disabled={!canAdd || busy || adding} onClick={() => void addRange()} title={`Adds ${range ? "the marked part" : "the whole take"} at ${voiceClock(playhead)} on the Voiceover lane`}>Add to timeline</button>
      </div>}
      {error && <InlineError className="vo-message">{error}</InlineError>}
    </section>
    {review ? <CleanReadReview root={root} take={take} cutId={cutId} scriptKey={scriptKey} playhead={playhead} busy={busy} canAdd={canAdd} playing={playing} auto={auto} replacing={!!replacing}
        play={(key, spans, from, to, inputAt) => void play(key, spans, { from, to, inputAt })} stop={stop} onPlan={plan => setKeep(plan?.spans ?? null)} onAdd={onAddPlan}
        onCutByHand={() => { setReview(false); setKeep(null); section.current?.focus({ preventScroll: true }); }} />
      : <div className="tv-body"><p ref={words} className="tv-words" aria-label="Words in this take">{list.length ? list.map(({ word }, i) => <Fragment key={i}>{i && gapBefore(word.w) ? " " : ""}<span data-word={i}
          data-marked={range && word.s >= range.s - 0.01 && word.e <= range.e + 0.01 || undefined} onClick={() => seek(word.s)}>{word.w.trim()}</span></Fragment>)
          : <span className="tv-muted">{take.transcript == null ? "The words appear here when your take is transcribed." : "No words were heard in this take."}</span>}</p></div>}
  </div>;
}

type Option = { key: string; group: "read" | "repeat" | "ending"; id: string; time: number | null; text: string; tag?: string; phrase: { s: number; e: number } | null };
const textOf = (words: CleanWord[], span: WordSpan | null, limit = Infinity) => {
  if (!span) return "";
  const from = +span.from.slice(1), to = +span.to.slice(1), picked = words.slice(from, Math.min(to + 1, from + limit));
  return voiceText(picked.map(w => ({ s: w.s, e: w.e, w: w.w }))) + (to + 1 > from + limit ? "…" : "");
};
const choiceKey = (c: CleanReadChoices, p: CleanReadProposal) => JSON.stringify([c.read, p.repeats.filter(g => g.read === c.read).map(g => c.repeats[g.id]), c.ending, [...c.restore].sort()]);
const isStale = (e: unknown) => e instanceof Error && /changed|Run Clean read/u.test(e.message);

/** Read choices first, then the repeats inside the chosen read, then the ending, then what was
 * struck. Every Play and Add comes from the resolved plan for those choices. */
function CleanReadReview({ root, take, cutId, scriptKey, playhead, busy, canAdd, playing, auto, replacing, play, stop, onPlan, onAdd, onCutByHand }: {
  root: string; take: AudioFile; cutId?: string; scriptKey: string; playhead: number; busy: boolean; canAdd: boolean; playing: string | null;
  /** Started by Add a recording: it waits for the words, and says so when there is nothing to clean. */
  auto: boolean; replacing: boolean;
  play: (key: string, spans: AuditionSpan[], from: number, to: number, inputAt: number) => void; stop: () => void;
  onPlan: (plan: CleanReadPlan | null) => void; onAdd: (plan: CleanReadPlan) => Promise<{ appended?: boolean } | null | undefined>; onCutByHand: () => void;
}) {
  type State = { status: "loading" } | { status: "signin" } | { status: "none"; reason: string } | { status: "stale" } | { status: "error"; message: string } | { status: "ready"; proposal: CleanReadProposal };
  const [state, setState] = useState<State>({ status: "loading" }), [choices, setChoices] = useState<CleanReadChoices | null>(null);
  const [plans, setPlans] = useState<Map<string, CleanReadPlan>>(new Map()), [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false), [note, setNote] = useState<string | null>(null);
  const proposal = state.status === "ready" ? state.proposal : null;
  const api = cleanReadApi(), modelReady = useModelAccess();
  useEffect(() => {
    let live = true; setState({ status: "loading" }); setPlans(new Map()); setChoices(null); setNote(null);
    if (!api.cleanRead) { setState({ status: "none", reason: "Clean read needs the desktop app. Cut it by hand." }); return; }
    // Add a recording, not signed in: the raw piece stays and the shared sign-in shows; signing in starts it.
    if (auto && !modelReady) { setState({ status: "signin" }); return; }
    // A recording just added has no words yet: wait for them (transcribed once), then check the reads.
    const words = take.transcript == null && api.waitVoiceoverWords ? api.waitVoiceoverWords(root, take.file).then(() => true, () => false) : Promise.resolve(true);
    void words.then(heard => {
      if (!live) return;
      if (!heard) { setState({ status: "error", message: "Couldn't get the words from this recording yet. It stays on the timeline as it is." }); return; }
      return api.cleanRead!(root, take.file, cutId).then(result => {
        if (!live) return;
        if (!result.proposal) { setState({ status: "none", reason: result.reason }); return; }
        const p = result.proposal;
        // Nothing to choose and nothing struck: the recording is already clean, so the raw piece stays.
        if (auto && p.reads.length <= 1 && !p.repeats.some(g => g.options.length > 1) && !p.struck.length && p.endings.filter(e => e.span).length <= 1) {
          setState({ status: "none", reason: "Nothing to clean in this recording. It stays on the timeline as it is." }); return;
        }
        setChoices(structuredClone(p.defaults)); setState({ status: "ready", proposal: p });
      });
    }).catch(error => { if (live) setState({ status: "error", message: error instanceof Error ? error.message : "Couldn't check your reads. Try again." }); });
    return () => { live = false; };
  }, [root, take.file, cutId, attempt, auto && modelReady]);

  // Alternatives one pick away, resolved ahead, so Play on any option starts at once.
  const alternatives = useMemo(() => {
    if (!proposal || !choices) return [];
    const out: CleanReadChoices[] = [choices];
    for (const r of proposal.reads) if (r.id !== choices.read) out.push({ ...choices, read: r.id, repeats: { ...proposal.defaults.repeats } });
    for (const g of proposal.repeats.filter(g => g.read === choices.read)) for (const o of g.options) if (o.id !== choices.repeats[g.id]) out.push({ ...choices, repeats: { ...choices.repeats, [g.id]: o.id } });
    for (const e of proposal.endings) if (e.id !== choices.ending) out.push({ ...choices, ending: e.id });
    return out;
  }, [proposal, choices]);
  const resolve = (c: CleanReadChoices) => api.cleanReadPlan!(root, take.file, cutId, c);
  useEffect(() => {
    if (!proposal || !api.cleanReadPlan) return;
    let live = true;
    for (const c of alternatives) {
      const key = choiceKey(c, proposal);
      if (plans.has(key)) continue;
      void resolve(c).then(plan => { if (live) setPlans(m => new Map(m).set(key, plan)); }, error => { if (live && isStale(error)) setState({ status: "stale" }); });
    }
    return () => { live = false; };
  }, [alternatives]);
  // The script or the take's words changing makes the proposal stale; the check costs no model call.
  const checked = useRef({ scriptKey, transcript: take.transcript });
  useEffect(() => {
    const was = checked.current; checked.current = { scriptKey, transcript: take.transcript };
    if (!proposal || !choices || (was.scriptKey === scriptKey && was.transcript === take.transcript)) return;
    let live = true;
    void resolve(choices).then(plan => { if (live) setPlans(new Map([[choiceKey(choices, proposal), plan]])); }, error => { if (live && isStale(error)) setState({ status: "stale" }); });
    return () => { live = false; };
  }, [scriptKey, take.transcript]);

  const current = proposal && choices ? plans.get(choiceKey(choices, proposal)) ?? null : null;
  useEffect(() => { onPlan(current); }, [current]);
  useEffect(() => () => onPlan(null), []);

  if (state.status === "loading") return <div className="tv-body"><p role="status" className="cr-state" data-clean-read-state="loading">{auto ? "Processing your recording…" : "Checking your reads…"}</p></div>;
  if (state.status === "signin") return <div className="tv-body cr-state" data-clean-read-state="signin"><ModelSignIn feature="cleanRead" /><button type="button" onClick={onCutByHand}>Cut it by hand</button></div>;
  if (state.status === "none") return <div className="tv-body cr-state" data-clean-read-state="none"><p>{state.reason}</p><button type="button" onClick={onCutByHand}>Cut it by hand</button></div>;
  if (state.status === "stale") return <div className="tv-body cr-state" data-clean-read-state="stale"><p>This take or its script changed since precut checked your reads.</p><button type="button" className="st-button-primary" onClick={() => { stop(); setAttempt(a => a + 1); }}>Check again</button></div>;
  if (state.status === "error") return <div className="tv-body cr-state" data-clean-read-state="error"><InlineError className="vo-message">{state.message}</InlineError><button type="button" onClick={() => setAttempt(a => a + 1)}>Check again</button></div>;
  if (!proposal || !choices) return null;

  const words = proposal.words;
  const reads: Option[] = proposal.reads.map(r => ({ key: `read:${r.id}`, group: "read", id: r.id, time: r.s, text: r.label.replace(/\s*\(\d+:\d\d\)$/u, ""), tag: r.complete ? undefined : "Not every line", phrase: r }));
  const groups = proposal.repeats.filter(g => g.read === choices.read).map(g => ({ id: g.id, label: g.label,
    options: g.options.map((o): Option => ({ key: `repeat:${o.id}`, group: "repeat", id: o.id, time: o.s, text: textOf(words, o), tag: o.complete ? undefined : "Unfinished", phrase: o })) }));
  const endings: Option[] = proposal.endings.map(e => ({ key: `ending:${e.id}`, group: "ending", id: e.id, time: e.span?.s ?? null, text: e.span ? textOf(words, e.span) : "No ending", phrase: e.span }));
  const chosen = (o: Option) => o.group === "read" ? choices.read === o.id : o.group === "ending" ? choices.ending === o.id : Object.values(choices.repeats).includes(o.id);
  const withPick = (o: Option, group?: string): CleanReadChoices => o.group === "read" ? (o.id === choices.read ? choices : { ...choices, read: o.id, repeats: { ...proposal.defaults.repeats } })
    : o.group === "ending" ? { ...choices, ending: o.id } : { ...choices, repeats: { ...choices.repeats, [group!]: o.id } };
  function pick(o: Option, group?: string) { setNote(null); setChoices(withPick(o, group)); }
  /** That phrase, with one second either side of its joins, from the plan it would be in. */
  function audition(o: Option, group: string | undefined, inputAt: number) {
    if (playing === o.key) { stop(); return; }
    const c = withPick(o, group), plan = plans.get(choiceKey(c, proposal!));
    if (!plan) {
      // Not resolved yet (rare): resolve it, then play.
      void resolve(c).then(p => { setPlans(m => new Map(m).set(choiceKey(c, proposal!), p)); auditionIn(p, o, inputAt); }, error => { if (isStale(error)) setState({ status: "stale" }); });
      return;
    }
    auditionIn(plan, o, inputAt);
  }
  function auditionIn(plan: CleanReadPlan, o: Option, inputAt: number) {
    const total = plan.durationS;
    let a: number | null = null, b: number | null = null, start = 0;
    if (o.phrase) for (const span of plan.spans) {
      const s = Math.max(span.s, o.phrase.s), e = Math.min(span.e, o.phrase.e);
      if (e > s) { if (a === null) a = start + s - span.s; b = start + e - span.s; }
      start += span.e - span.s;
    }
    if (a === null || b === null) { a = b = total; }
    play(o.key, plan.spans, Math.max(0, a - 1), Math.min(total, b + 1), inputAt);
  }
  async function add() {
    if (!current || adding) return;
    stop(); setAdding(true); setNote(null);
    try {
      const result = await onAdd(current);
      if (result) setNote(result.appended ? "Your voiceover was already there, so the clean read went in after it." : replacing ? "Your recording on the timeline is now the clean read." : `Added at ${voiceClock(playhead)}.`);
    } catch (e) { if (isStale(e)) setState({ status: "stale" }); else setNote(e instanceof Error ? e.message : "Couldn't add your clean read. Try again."); }
    finally { setAdding(false); }
  }
  const row = (o: Option, group?: string) => <div className="cr-row" key={o.key}>
    <div role="radio" tabIndex={0} aria-checked={chosen(o)} data-clean-option={o.id} className="cr-option" onClick={() => pick(o, group)}
      onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); pick(o, group); } }}>
      {o.time !== null && <span className="cr-time">{voiceClock(o.time)}</span>}
      <span className="cr-text">{o.text}</span>{o.tag && <span className="cr-tag">{o.tag}</span>}
    </div>
    <button type="button" className="tv-icon" data-clean-play={o.id} data-playing={playing === o.key || undefined} aria-label={`${playing === o.key ? "Stop" : "Play"} ${o.text.slice(0, 40)}`}
      onClick={event => audition(o, group, event.timeStamp)}>{playing === o.key ? <Pause size={15} /> : <Play size={15} />}</button>
  </div>;
  const restore = new Set(choices.restore);
  return <><div className="tv-body cr" data-clean-read-state="ready">
    <section className="cr-group" aria-label="Read"><SectionHeader className="">Read</SectionHeader><div role="radiogroup" aria-label="Read">{reads.map(o => row(o))}</div></section>
    {groups.map(g => <section key={g.id} className="cr-group" aria-label={`Repeat: ${g.label}`}><SectionHeader className="">{g.label}</SectionHeader><div role="radiogroup" aria-label={g.label}>{g.options.map(o => row(o, g.id))}</div></section>)}
    <section className="cr-group" aria-label="Ending"><SectionHeader className="">Ending</SectionHeader><div role="radiogroup" aria-label="Ending">{endings.map(o => row(o))}</div></section>
    {!!proposal.struck.length && <section className="cr-group" aria-label="Struck"><SectionHeader className="">Struck <span className="tv-muted">· click one to put it back</span></SectionHeader><div className="cr-struck-list">
      {proposal.struck.map(s => <button type="button" key={s.id} data-clean-struck={s.id} data-restored={restore.has(s.id) || undefined} className="cr-struck"
        onClick={() => { setNote(null); setChoices({ ...choices, restore: restore.has(s.id) ? choices.restore.filter(id => id !== s.id) : [...choices.restore, s.id] }); }}>{s.label}</button>)}
    </div></section>}
    {proposal.note && <p className="cr-note">{proposal.note}</p>}
  </div>
  <div className="cr-foot"><div className="cr-foot-row">
      <button type="button" data-clean-play="plan" data-playing={playing === "plan" || undefined} disabled={!current} onClick={event => { if (playing === "plan") stop(); else if (current) play("plan", current.spans, 0, current.durationS, event.timeStamp); }}>
        {playing === "plan" ? <Pause size={15} /> : <Play size={15} />}{playing === "plan" ? "Stop" : "Play clean read"}{current && <span className="tv-muted">{voiceClock(current.durationS)}</span>}</button>
      <button type="button" className="st-button-primary" data-add-clean-read disabled={!current || !canAdd || busy || adding} onClick={() => void add()} title={replacing ? "Replaces the recording you added with this clean read" : `Lands at ${voiceClock(playhead)} on the Voiceover lane`}>{replacing ? "Apply clean read" : "Add clean read"}</button>
    </div>{note && <p role="status" className="cr-note" data-clean-read-note>{note}</p>}</div></>;
}
