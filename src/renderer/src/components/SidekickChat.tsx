import { clipName } from "../../../shared/clip-name";
import { useModelAccess, ModelSignIn } from "./ModelAccess";
import { SectionHeader, InlineError, Tile } from "./ui";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowUp, ArrowUpRight, FilmStrip, Lightbulb, Plus, Scissors } from "@phosphor-icons/react";
import type { Shoot, SidekickContext, SidekickMessage } from "../../../shared/schema";
import { formatTimecode, getApi, shortClipId, plainClipNames } from "../data";
import { go } from "../nav";
import { dur, ease } from "../motion";
import { reducedTransition, useMotionPresets } from "./ui";
import { ClipDrawer } from "./ClipDrawer";
import {
BUBBLE_BASE,BUBBLE_WIDTH,CHAT_CARD_ROW,CHAT_FOCUS,
CHAT_HEADER_CLEARANCE,COMPOSER_MAX_HEIGHT_PX,COMPOSER_MIN_HEIGHT_PX,
COMPOSER_QUIET,FLOATING_GLASS,INCOMING_BUBBLE,MESSAGE_RUN_GAP,
MESSAGE_TURN_GAP,OUTGOING_BUBBLE,OUTGOING_GRADIENT
} from "./chatStyles";

const BUBBLE_TEXT = "whitespace-pre-wrap text-body leading-normal";
const CHAT_CARD = "glass-surface w-full max-w-[440px] rounded-2xl text-body leading-normal text-ink [overflow-wrap:anywhere]";
const COMPOSER_INPUT = "block min-h-[44px] min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-[10px] text-body leading-6 text-ink placeholder:text-muted";
const COMPOSER_BUTTON = "flex size-11 shrink-0 items-center justify-center rounded-full transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none disabled:cursor-not-allowed";
const COMPOSER_PILL = "flex min-h-[60px] items-end gap-1 p-[7px]";

type Selection = { cutId: string; version: number };
interface Session {
  messages: SidekickMessage[];
  loading: boolean;
  pending: { at: number; message: SidekickMessage; context: SidekickContext } | null;
  error: string | null;
  draft: string;
  selection: Selection | null;
}
// UI state survives moving between the dock and the widget, including a slow
// request. Persisted messages still come exclusively from sidekickThread.
const sessions = new Map<string, Session>();
const subscribers = new Set<() => void>();
const revisions = new Map<string, number>();
function session(root: string): Session {
  if (!sessions.has(root)) sessions.set(root, { messages: [], loading: true, pending: null, error: null, draft: "", selection: null });
  return sessions.get(root)!;
}
function update(root: string, change: Partial<Session>) {
  sessions.set(root, { ...session(root), ...change });
  subscribers.forEach((cb) => cb());
}
export function useSidekickWorkspace(root: string) {
  return useSyncExternalStore((cb) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; }, () => session(root));
}
export function selectSidekickCut(root: string, selection: Selection) { update(root, { selection }); }
function plainError(error: unknown) {
  const text = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "") : "";
  return text && text.length < 350 ? text : "precut couldn't finish that. Your earlier cuts are safe. Try again.";
}
export async function refreshSidekick(root: string) {
  const revision = (revisions.get(root) ?? 0) + 1;
  revisions.set(root, revision);
  try {
    const messages = await getApi().sidekickThread(root);
    if (revisions.get(root) === revision) update(root, { messages, loading: false });
  } catch {
    if (revisions.get(root) === revision) update(root, { loading: false, error: "Couldn't read this shoot's conversation. Try loading it again." });
  }
}
export async function sidekickSend(root: string, raw: string, context: SidekickContext = {}) {
  const text = raw.trim();
  if (!text || session(root).pending) return;
  const at = Date.now();
  const ownsDraft = !context.fromIdea && !context.ideaId && !context.addIdeas;
  update(root, { pending: { at, context, message: { id: `sending-${at}`, at: new Date(at).toISOString(), text, role: "user", ...(context.ideaId ? { ideaId: context.ideaId } : {}) } }, ...(ownsDraft ? { draft: "" } : {}), error: null });
  try {
    const reply = await getApi().sidekickSend(root, text, context);
    await refreshSidekick(root);
    const current = session(root);
    // Keep the returned answer visible even if a subsequent disk read failed.
    if (!current.messages.some((message) => message.id === reply.id)) {
      update(root, { messages: [...current.messages, reply] });
    }
    if (reply.cut) selectSidekickCut(root, reply.cut);
    return reply;
  } catch (error) {
    update(root, { error: plainError(error), ...(ownsDraft ? { draft: text } : {}) });
    await refreshSidekick(root);
  } finally { update(root, { pending: null }); }
}

type Moment = NonNullable<SidekickMessage["clips"]>[number];
const quietLink = `rounded-sm underline underline-offset-3 hover:opacity-75 ${CHAT_FOCUS}`;

function MessageText({ shoot, message, onMoment }: { shoot: Shoot; message: SidekickMessage; onMoment: (moment: Moment) => void }) {
  const text = plainClipNames(message.text);
  const mentioned = new Set<Moment>();
  const parts: ReactNode[] = [];
  const matches: { at: number; length: number; moment: Moment }[] = [];
  const pattern = /\bclip\s+(\S+)\s+at\s+(\d+:\d{2}(?::\d{2})?)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const moment = message.clips?.find(clip => (shortClipId(clip.clipId) === match[1] || plainClipNames(clip.clipId) === match[1]) && formatTimecode(clip.s) === match[2]);
    if (moment) matches.push({ at: match.index!, length: match[0].length, moment });
  }
  for (const moment of message.clips ?? []) {
    const name = clipName(shoot.clips.find(c => c.id === moment.clipId), moment);
    const at = text.indexOf(name);
    if (at >= 0) matches.push({ at, length: name.length, moment });
  }
  let from = 0;
  for (const match of matches.sort((a, b) => a.at - b.at || b.length - a.length)) {
    if (match.at < from) continue;
    parts.push(text.slice(from, match.at));
    parts.push(<button key={match.at} type="button" onClick={() => onMoment(match.moment)} className={quietLink}>{clipName(shoot.clips.find(c => c.id === match.moment.clipId), match.moment)}</button>);
    mentioned.add(match.moment);
    from = match.at + match.length;
  }
  parts.push(text.slice(from));
  const remaining = message.clips?.filter((clip) => !mentioned.has(clip)) ?? [];
  return <>
    {text ? <p role={message.error === message.text ? "alert" : undefined} className={BUBBLE_TEXT}>{parts}</p> : null}
    {remaining.length ? <details className="mt-1.5 rounded-xl text-body leading-normal"><summary className={`cursor-pointer rounded-xl px-3.5 py-3 hover:bg-ink/[0.035] ${CHAT_FOCUS}`}>{remaining.length} {remaining.length === 1 ? "moment" : "moments"}</summary><ul>{remaining.map((clip, index) => <li key={index}><button type="button" className={`${CHAT_CARD_ROW} hover:bg-ink/[0.035] ${CHAT_FOCUS}`} onClick={() => onMoment(clip)}><FilmStrip size={16} className="shrink-0" aria-hidden="true" /><span>{clipName(shoot.clips.find(c => c.id === clip.clipId), clip)}</span></button></li>)}</ul></details> : null}
  </>;
}

export function SidekickChat({ shoot, autoFocus = false, cutContext, ideaId }: {
  shoot: Shoot;
  autoFocus?: boolean;
  cutContext?: Selection | null;
  ideaId?: string;
}) {
  const root = shoot.root;
  const modelReady = useModelAccess();
  const state = useSidekickWorkspace(root);
  const selection = ideaId ? null : cutContext === undefined ? state.selection : cutContext;
  const [ideaDraft, setIdeaDraft] = useState("");
  const draft = ideaId ? ideaDraft : state.draft;
  const setDraft = (draft: string) => ideaId ? setIdeaDraft(draft) : update(root, { draft });
  const pending = state.pending && (ideaId ? state.pending.context.ideaId === ideaId : !state.pending.context.ideaId && !state.pending.context.addIdeas) ? state.pending : null;
  useEffect(() => { setIdeaDraft(""); }, [root, ideaId]);
  const [stillLooking, setStillLooking] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ clipId: string; s: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [multiline, setMultiline] = useState(false);
  const [skipped, setSkipped] = useState<Record<string, string[]>>({});
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [applied, setApplied] = useState<Record<string, number>>({});
  const [applying, setApplying] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const id = useId();
  const { reduced } = useMotionPresets();

  useEffect(() => {
    void refreshSidekick(root);
    return getApi().onSidekickChanged((changedRoot) => { if (changedRoot === root) void refreshSidekick(root); });
  }, [root]);
  useEffect(() => { if (autoFocus) inputRef.current?.focus({ preventScroll: true }); }, [autoFocus]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const resize = () => {
      input.style.height = "auto";
      const height = Math.min(COMPOSER_MAX_HEIGHT_PX, Math.max(COMPOSER_MIN_HEIGHT_PX, input.scrollHeight));
      input.style.height = `${height}px`;
      input.style.overflowY = input.scrollHeight > height ? "auto" : "hidden";
      setMultiline(height > COMPOSER_MIN_HEIGHT_PX + 4);
      if (pinned.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [root, draft]);
  useEffect(() => {
    setStillLooking(false);
    if (!state.pending) return;
    const timer = window.setTimeout(() => setStillLooking(true), Math.max(0, 8000 - (Date.now() - state.pending.at)));
    return () => window.clearTimeout(timer);
  }, [state.pending?.at]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!pinned.current || !scroll) return;
    const lastReply = scroll.querySelector<HTMLElement>('[data-sidekick-message="sidekick"]:last-child');
    if (!state.pending && lastReply && lastReply.offsetHeight > scroll.clientHeight) {
      // Keep a long reply readable from its beginning.
      // The first line stays below the floating identity capsule.
      scroll.scrollTop += lastReply.getBoundingClientRect().top - scroll.getBoundingClientRect().top - parseFloat(getComputedStyle(scroll).paddingTop);
    } else scroll.scrollTop = scroll.scrollHeight;
  }, [state.messages, state.pending, state.error, stillLooking]);

  const ask = (text: string, extra: SidekickContext = {}) => {
    pinned.current = true;
    if (!text.trim() || state.pending) return;
    if (ideaId) setIdeaDraft("");
    void sidekickSend(root, text, ideaId ? { ideaId } : selection ? { cutId: selection.cutId, ...extra } : {}).then((reply) => {
      if (!reply && ideaId) setIdeaDraft(text);
    });
  };
  const insertFiles = async (files: File[]) => {
    setDropError(null);
    const blocks = await Promise.all(files.map(async (file) => {
      if (!/\.(md|txt)$/i.test(file.name)) {
        setDropError("Text, Markdown or a link works here.");
        return null;
      }
      try { return `Storyboard: ${file.name}\n${await file.text()}`; }
      catch { setDropError("Couldn't read that file. Paste its text or a link."); return null; }
    }));
    const text = blocks.filter((block) => block !== null).join("\n\n");
    if (!text) return;
    setDraft(draft ? `${draft}\n\n${text}` : text);
    inputRef.current?.focus({ preventScroll: true });
  };
  const openCut = (chosen: Selection) => {
    selectSidekickCut(root, chosen);
    go("precuts", { shoot: root, cut: chosen.cutId, v: String(chosen.version) });
  };
  const toggleSkip = (messageId: string, issueId: string) => setSkipped((current) => {
    const list = current[messageId] ?? [];
    return { ...current, [messageId]: list.includes(issueId) ? list.filter((entry) => entry !== issueId) : [...list, issueId] };
  });
  const applyProposal = async (message: SidekickMessage) => {
    const proposal = message.better;
    if (!proposal || applying) return;
    const kept = proposal.issues.filter((issue) => !(skipped[message.id] ?? []).includes(issue.id)).map((issue) => issue.id);
    if (!kept.length) { setDismissed((current) => ({ ...current, [message.id]: true })); return; }
    setApplying(message.id); setApplyError(null);
    try {
      const result = await getApi().applyBetter(root, proposal.cutId, proposal.version, kept);
      setApplied((current) => ({ ...current, [message.id]: result.version }));
      selectSidekickCut(root, { cutId: proposal.cutId, version: result.version });
      await refreshSidekick(root);
    } catch (error) { setApplyError(plainError(error)); }
    finally { setApplying(null); }
  };
  const thread = state.messages.filter((message) => ideaId ? message.ideaId === ideaId : !message.ideaId);
  const pendingMessage = pending && !thread.some((message) => message.role === "user" && message.text === pending.message.text && Date.parse(message.at) >= pending.at)
    ? pending.message : null;
  const messages = pendingMessage ? [...thread, pendingMessage] : thread;
  if (!modelReady) return <ModelSignIn feature="ask" />;
  return <div data-sidekick-chat className="relative isolate flex h-full min-h-0 flex-col"
    onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
    onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); void insertFiles(Array.from(e.dataTransfer.files)); }}>
    {/* The name sits above the thread, not over it: glass over a scrolling thread read as a smear. */}
    <header className="shrink-0 px-4 pt-3 pb-1">
      <SectionHeader as="h2" className="truncate text-small font-semibold text-muted">precut</SectionHeader>
    </header>
    <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 ${CHAT_HEADER_CLEARANCE}`} aria-label={ideaId ? "Idea conversation" : "Shoot conversation"} role="log" aria-live="polite" aria-busy={!!pending}>
      {state.loading && !messages.length ? <p className="text-small text-muted">Loading your conversation…</p> : null}
      <div>{messages.map((message, index) => <motion.div key={message.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? reducedTransition : { duration: dur.base, ease: ease.out }} data-sidekick-message={message.role} className={`flex min-w-0 flex-col ${message.role === "user" ? "items-end" : "items-start"} ${index === 0 ? "" : messages[index - 1].role === message.role ? MESSAGE_RUN_GAP : MESSAGE_TURN_GAP}`}>
        <div className={`${BUBBLE_WIDTH} ${BUBBLE_BASE} ${message.role === "user" ? OUTGOING_BUBBLE : INCOMING_BUBBLE}`} style={message.role === "user" ? { backgroundImage: OUTGOING_GRADIENT } : undefined}>
          <MessageText shoot={shoot} message={message} onMoment={setDrawer} />
          {message.error && message.error !== message.text ? <InlineError className={`mt-2 ${BUBBLE_TEXT}`}>{message.error}</InlineError> : null}
        </div>
        {message.ideas?.length || message.cut || message.missing?.length ? <div className="flex w-full min-w-0 flex-col gap-1.5 pt-1">
          {!ideaId && message.ideas?.length ? <button type="button" onClick={() => go("ideas", { shoot: root })} className={`${CHAT_CARD} ${CHAT_CARD_ROW} hover:opacity-80 ${CHAT_FOCUS}`}><Lightbulb size={16} className="shrink-0 text-muted" aria-hidden="true" /><span className="min-w-0 flex-1">{message.ideas.length} ideas</span><ArrowUpRight size={16} className="shrink-0 text-muted" aria-hidden="true" /></button> : null}
          {message.cut ? <button type="button" onClick={() => openCut(message.cut!)} className={`${CHAT_CARD} ${CHAT_CARD_ROW} hover:opacity-80 ${CHAT_FOCUS}`}><Scissors size={16} className="shrink-0 text-muted" aria-hidden="true" /><span className="min-w-0 flex-1">made v{message.cut.version}</span><ArrowUpRight size={16} className="shrink-0 text-muted" aria-hidden="true" /></button> : null}
          {message.missing?.length ? <div className={`${CHAT_CARD} px-3.5 py-3`}><p className="text-small text-muted">to film</p><ul className="mt-1.5 list-disc space-y-1 pl-4">{message.missing.map((shot, i) => <li key={i}>{shot}</li>)}</ul></div> : null}
        </div> : null}
        {message.better?.issues.length && !dismissed[message.id] && applied[message.id] === undefined ? <div className={`${CHAT_CARD} mt-1.5 py-1`} data-better-proposal>
          <ul>{message.better.issues.map((issue, index) => { const isSkipped = (skipped[message.id] ?? []).includes(issue.id); return <li key={issue.id} className="flex items-start gap-2 px-3.5 py-2">
            <span className="shrink-0 text-muted">{index + 1}.</span><span className={`min-w-0 flex-1 ${isSkipped ? "text-muted" : ""}`}>{issue.what} {issue.change}</span>
            <Tile selected={isSkipped} aria-label={isSkipped ? `Keep: ${issue.what}` : `Skip: ${issue.what}`} onClick={() => toggleSkip(message.id, issue.id)} className={`shrink-0 rounded-full px-2.5 py-1 text-small hover:bg-ink/[0.1] ${CHAT_FOCUS}`}>{isSkipped ? "Skipped" : "Skip"}</Tile>
          </li>; })}</ul>
          <div className="flex items-center gap-2 px-3.5 py-3">
            <button type="button" disabled={applying === message.id} onClick={() => void applyProposal(message)} className={`st-brand-gradient rounded-full px-3.5 py-1.5 text-small font-medium text-white disabled:opacity-40 ${CHAT_FOCUS}`}>{applying === message.id ? "Applying..." : "Apply"}</button>
            <button type="button" disabled={applying === message.id} onClick={() => setDismissed((current) => ({ ...current, [message.id]: true }))} className={`rounded-full bg-ink/[0.06] px-3.5 py-1.5 text-small font-medium hover:bg-ink/[0.1] disabled:opacity-40 ${CHAT_FOCUS}`}>Skip</button>
            {applyError && applying === null ? <span className="text-small text-muted">{applyError}</span> : null}
          </div>
        </div> : null}
        {applied[message.id] !== undefined && message.better ? <button type="button" onClick={() => openCut({ cutId: message.better!.cutId, version: applied[message.id] })} className={`${CHAT_CARD} ${CHAT_CARD_ROW} mt-1.5 hover:opacity-80 ${CHAT_FOCUS}`}><Scissors size={16} className="shrink-0 text-muted" aria-hidden="true" /><span className="min-w-0 flex-1">made v{applied[message.id]}</span><ArrowUpRight size={16} className="shrink-0 text-muted" aria-hidden="true" /></button> : null}
      </motion.div>)}</div>
      {pending ? <div role="status" className={`${BUBBLE_WIDTH} ${BUBBLE_BASE} ${INCOMING_BUBBLE} ${messages.at(-1)?.role === "sidekick" ? MESSAGE_RUN_GAP : MESSAGE_TURN_GAP} flex items-center gap-2 text-body leading-normal`}><span className="flex gap-1" aria-hidden="true">{[0, 1, 2].map((index) => <motion.span key={index} className="size-1.5 rounded-full bg-accent" animate={reduced ? { opacity: 0.7 } : { opacity: [0.35, 1, 0.35] }} transition={reduced ? reducedTransition : { duration: dur.smooth + dur.base, ease: ease.out, repeat: Infinity, repeatType: "reverse", delay: index * dur.fast }} />)}</span>{stillLooking ? "Still looking through your footage…" : "Thinking"}</div> : null}
      {state.error ? <InlineError as="div" className={`mt-4 ${BUBBLE_WIDTH} ${BUBBLE_BASE} ${INCOMING_BUBBLE} text-body leading-normal`}>{state.error}<button onClick={() => { update(root, { error: null }); void refreshSidekick(root); }} className={`ml-2 text-accent ${quietLink}`}>Reload thread</button></InlineError> : null}
    </div>
    {selection && !ideaId ? <div className="shrink-0 px-4 pb-2"><button type="button" disabled={!!state.pending} onClick={() => ask("Make it better", { better: true })} className={`${CHAT_CARD} ${CHAT_CARD_ROW} hover:opacity-80 disabled:opacity-40 ${CHAT_FOCUS}`}><span className="min-w-0 flex-1">Make it better</span><ArrowUpRight size={16} className="shrink-0 text-muted" aria-hidden="true" /></button></div> : null}
    <footer className="shrink-0 p-4 pt-2">
      {dropError ? <InlineError className="mb-2 text-small text-muted">{dropError}</InlineError> : null}
      <form onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
        <div className={`${FLOATING_GLASS} ${COMPOSER_PILL} ${multiline ? "rounded-[26px]" : "rounded-[30px]"}`}>
          <input ref={fileRef} type="file" accept=".md,.txt,text/plain,text/markdown" multiple hidden onChange={(e) => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; void insertFiles(files); }} />
          <button type="button" aria-label="Attach a text or Markdown file" onClick={() => fileRef.current?.click()} className={`${COMPOSER_BUTTON} text-muted hover:bg-ink/[0.04] hover:text-ink ${CHAT_FOCUS}`}><Plus size={20} weight="bold" aria-hidden="true" /></button>
          <label htmlFor={id} className="sr-only">{ideaId ? "Talk about this idea" : selection ? `Notes on v${selection.version}` : "Tell precut what you're making"}</label>
          <textarea id={id} ref={inputRef} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              if (!e.clipboardData.types.includes("text/plain")) return;
              e.preventDefault();
              const input = e.currentTarget;
              const text = e.clipboardData.getData("text/plain");
              const start = input.selectionStart;
              setDraft(input.value.slice(0, start) + text + input.value.slice(input.selectionEnd));
              requestAnimationFrame(() => input.setSelectionRange(start + text.length, start + text.length));
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(draft); } }} placeholder={ideaId ? "Talk about this idea" : selection ? `Notes on v${selection.version}…` : "Ask about the footage, or say what you're making"} className={`${COMPOSER_INPUT} ${CHAT_FOCUS}`} />
          <button type="submit" disabled={!draft.trim() || !!state.pending} aria-label="Send" onMouseDown={(e) => e.preventDefault()} className={`${COMPOSER_BUTTON} ${draft.trim() ? "st-brand-gradient text-white disabled:opacity-30" : COMPOSER_QUIET} ${CHAT_FOCUS}`}><ArrowUp size={19} weight="bold" aria-hidden="true" /></button>
        </div>
      </form>
    </footer>
    <ClipDrawer shoot={shoot} clip={shoot.clips.find((clip) => clip.id === drawer?.clipId) ?? null} initialTime={drawer?.s} onClose={() => setDrawer(null)} />
  </div>;
}
