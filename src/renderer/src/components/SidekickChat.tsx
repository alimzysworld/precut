import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowUp, ArrowUpRight, FilmStrip, Lightbulb, Plus, Scissors } from "@phosphor-icons/react";
import type { Shoot, SidekickContext, SidekickMessage } from "../../../shared/schema";
import { formatTimecode, getApi, shortClipId, plainClipNames } from "../data";
import { go } from "../nav";
import { dur, ease } from "../motion";
import { reducedTransition, useMotionPresets } from "./ui";
import { ClipDrawer } from "./ClipDrawer";
import logoTile from "../assets/sidething-logo-tile@2x.png";
import {
  BUBBLE_BASE, BUBBLE_TEXT, BUBBLE_WIDTH, CHAT_CARD, CHAT_CARD_ROW, CHAT_FOCUS,
  CHAT_HEADER_CLEARANCE, CHAT_HEADER_FADE, CHAT_IDENTITY, COMPOSER_BUTTON,
  COMPOSER_INPUT, COMPOSER_MAX_HEIGHT_PX, COMPOSER_MIN_HEIGHT_PX, COMPOSER_PILL,
  COMPOSER_QUIET, FLOATING_GLASS, INCOMING_BUBBLE, MESSAGE_RUN_GAP,
  MESSAGE_TURN_GAP, OUTGOING_BUBBLE, OUTGOING_GRADIENT,
} from "./chatStyles";

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
  return text && text.length < 350 ? text : "Sidekick couldn't finish that. Your earlier cuts are safe. Try again.";
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
  update(root, { pending: { at, context, message: { id: `sending-${at}`, at: new Date(at).toISOString(), text, role: "user" } }, ...(context.fromIdea ? {} : { draft: "" }), error: null });
  try {
    const reply = await getApi().sidekickSend(root, text, context);
    await refreshSidekick(root);
    const current = session(root);
    // Keep the returned answer visible even if a subsequent disk read failed.
    if (!current.messages.some((message) => message.id === reply.id)) {
      update(root, { messages: [...current.messages, reply] });
    }
    if (reply.cut) selectSidekickCut(root, reply.cut);
  } catch (error) {
    update(root, { error: plainError(error), ...(context.fromIdea ? {} : { draft: text }) });
    await refreshSidekick(root);
  } finally { update(root, { pending: null }); }
}

type Moment = NonNullable<SidekickMessage["clips"]>[number];
const quietLink = `rounded-sm underline underline-offset-3 hover:opacity-75 ${CHAT_FOCUS}`;

function MessageText({ message, onMoment }: { message: SidekickMessage; onMoment: (moment: Moment) => void }) {
  const text = plainClipNames(message.text);
  const mentioned = new Set<Moment>();
  const parts: ReactNode[] = [];
  const pattern = /\bclip\s+(\S+)\s+at\s+(\d+:\d{2}(?::\d{2})?)\b/gi;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const moment = message.clips?.find((clip) => (shortClipId(clip.clipId) === match[1] || plainClipNames(clip.clipId) === match[1]) && formatTimecode(clip.s) === match[2]);
    if (!moment) continue;
    parts.push(text.slice(from, match.index));
    parts.push(<button key={match.index} type="button" onClick={() => onMoment(moment)} className={quietLink}>{match[0]}</button>);
    mentioned.add(moment);
    from = match.index! + match[0].length;
  }
  parts.push(text.slice(from));
  const remaining = message.clips?.filter((clip) => !mentioned.has(clip)) ?? [];
  return <>
    {text ? <p role={message.error === message.text ? "alert" : undefined} className={BUBBLE_TEXT}>{parts}</p> : null}
    {remaining.length ? <details className="mt-1.5 rounded-xl text-[14px] leading-normal"><summary className={`cursor-pointer rounded-xl px-3.5 py-3 hover:bg-ink/[0.035] ${CHAT_FOCUS}`}>{remaining.length} {remaining.length === 1 ? "moment" : "moments"}</summary><ul>{remaining.map((clip, index) => <li key={index}><button type="button" className={`${CHAT_CARD_ROW} hover:bg-ink/[0.035] ${CHAT_FOCUS}`} onClick={() => onMoment(clip)}><FilmStrip size={16} className="shrink-0" aria-hidden="true" /><span>clip {shortClipId(clip.clipId)} at {formatTimecode(clip.s)}</span></button></li>)}</ul></details> : null}
  </>;
}

export function SidekickChat({ shoot, onCutOpen, onOpenCut, autoFocus = false, cutContext, placeholder }: {
  shoot: Shoot;
  onCutOpen?: (cutId: string, version: number) => void;
  // Kept for the Precut workspace while its builder moves to onCutOpen.
  onOpenCut?: (selection: Selection) => void;
  autoFocus?: boolean;
  cutContext?: Selection | null;
  placeholder?: string;
}) {
  const root = shoot.root;
  const state = useSidekickWorkspace(root);
  const selection = cutContext === undefined ? state.selection : cutContext;
  const [stillLooking, setStillLooking] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ clipId: string; s: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [multiline, setMultiline] = useState(false);
  const id = useId();
  const { item, reduced } = useMotionPresets();

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
  }, [root, state.draft]);
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

  const ask = (text: string) => {
    pinned.current = true;
    void sidekickSend(root, text, selection ? { cutId: selection.cutId } : {});
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
    const draft = session(root).draft;
    update(root, { draft: draft ? `${draft}\n\n${text}` : text });
    inputRef.current?.focus({ preventScroll: true });
  };
  const openCut = (chosen: Selection) => {
    selectSidekickCut(root, chosen);
    if (onCutOpen) onCutOpen(chosen.cutId, chosen.version);
    else if (onOpenCut) onOpenCut(chosen);
    else go("precuts", { shoot: root, cut: chosen.cutId, v: String(chosen.version) });
  };
  const pendingMessage = state.pending && !state.messages.some((message) => message.role === "user" && message.text === state.pending!.message.text && Date.parse(message.at) >= state.pending!.at)
    ? state.pending.message : null;
  const messages = pendingMessage ? [...state.messages, pendingMessage] : state.messages;
  return <div data-sidekick-chat className="relative isolate flex h-full min-h-0 flex-col"
    onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
    onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); void insertFiles(Array.from(e.dataTransfer.files)); }}>
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20">
      <div aria-hidden="true" className={CHAT_HEADER_FADE} />
      <div className="relative px-3 pt-3 md:px-5 md:pt-4">
        <div className={`${FLOATING_GLASS} ${CHAT_IDENTITY}`}>
          <img src={logoTile} alt="" className="size-10 shrink-0 rounded-xl" draggable={false} />
          <h2 className="truncate text-base font-bold leading-tight text-ink">sidekick</h2>
        </div>
      </div>
    </header>
    <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 ${CHAT_HEADER_CLEARANCE}`} aria-label="Shoot conversation" role="log" aria-live="polite" aria-busy={!!state.pending}>
      {state.loading && !messages.length ? <p className="text-[13px] text-muted">Loading your conversation…</p> : null}
      <div>{messages.map((message, index) => <motion.div key={message.id} variants={item} initial="initial" animate="animate" data-sidekick-message={message.role} className={`flex min-w-0 flex-col ${message.role === "user" ? "items-end" : "items-start"} ${index === 0 ? "" : messages[index - 1].role === message.role ? MESSAGE_RUN_GAP : MESSAGE_TURN_GAP}`}>
        <div className={`${BUBBLE_WIDTH} ${BUBBLE_BASE} ${message.role === "user" ? OUTGOING_BUBBLE : INCOMING_BUBBLE}`} style={message.role === "user" ? { backgroundImage: OUTGOING_GRADIENT } : undefined}>
          <MessageText message={message} onMoment={setDrawer} />
          {message.error && message.error !== message.text ? <p role="alert" className={`mt-2 ${BUBBLE_TEXT}`}>{message.error}</p> : null}
        </div>
        {message.ideas?.length || message.cut || message.missing?.length ? <div className="flex w-full min-w-0 flex-col gap-1.5 pt-1">
          {message.ideas?.length ? <button type="button" onClick={() => go("ideas", { shoot: root })} className={`${CHAT_CARD} ${CHAT_CARD_ROW} hover:opacity-80 ${CHAT_FOCUS}`}><Lightbulb size={16} className="shrink-0 text-muted" aria-hidden="true" /><span className="min-w-0 flex-1">{message.ideas.length} ideas</span><ArrowUpRight size={16} className="shrink-0 text-muted" aria-hidden="true" /></button> : null}
          {message.cut ? <button type="button" onClick={() => openCut(message.cut!)} className={`${CHAT_CARD} ${CHAT_CARD_ROW} hover:opacity-80 ${CHAT_FOCUS}`}><Scissors size={16} className="shrink-0 text-muted" aria-hidden="true" /><span className="min-w-0 flex-1">made v{message.cut.version}</span><ArrowUpRight size={16} className="shrink-0 text-muted" aria-hidden="true" /></button> : null}
          {message.missing?.length ? <div className={`${CHAT_CARD} px-3.5 py-3`}><p className="text-[12px] text-muted">to film</p><ul className="mt-1.5 list-disc space-y-1 pl-4">{message.missing.map((shot, i) => <li key={i}>{shot}</li>)}</ul></div> : null}
        </div> : null}
      </motion.div>)}</div>
      {state.pending ? <div role="status" className={`${BUBBLE_WIDTH} ${BUBBLE_BASE} ${INCOMING_BUBBLE} ${messages.at(-1)?.role === "sidekick" ? MESSAGE_RUN_GAP : MESSAGE_TURN_GAP} flex items-center gap-2 text-[15px] leading-normal`}><span className="flex gap-1" aria-hidden="true">{[0, 1, 2].map((index) => <motion.span key={index} className="size-1.5 rounded-full bg-accent" animate={reduced ? { opacity: 0.7 } : { opacity: [0.35, 1, 0.35] }} transition={reduced ? reducedTransition : { duration: dur.smooth + dur.base, ease: ease.smooth, repeat: Infinity, repeatType: "reverse", delay: index * dur.fast }} />)}</span>{stillLooking ? "Still looking through your footage…" : "Thinking"}</div> : null}
      {state.error ? <div className={`mt-4 ${BUBBLE_WIDTH} ${BUBBLE_BASE} ${INCOMING_BUBBLE} text-[15px] leading-normal`} role="alert">{state.error}<button onClick={() => { update(root, { error: null }); void refreshSidekick(root); }} className={`ml-2 text-accent ${quietLink}`}>Reload thread</button></div> : null}
    </div>
    <footer className="shrink-0 p-4 pt-2">
      {dropError ? <p role="alert" className="mb-2 text-[12px] text-muted">{dropError}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); ask(state.draft); }}>
        <div className={`${FLOATING_GLASS} ${COMPOSER_PILL} ${multiline ? "rounded-[26px]" : "rounded-[30px]"}`}>
          <input ref={fileRef} type="file" accept=".md,.txt,text/plain,text/markdown" multiple hidden onChange={(e) => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; void insertFiles(files); }} />
          <button type="button" aria-label="Attach a text or Markdown file" onClick={() => fileRef.current?.click()} className={`${COMPOSER_BUTTON} text-muted hover:bg-ink/[0.04] hover:text-ink ${CHAT_FOCUS}`}><Plus size={20} weight="bold" aria-hidden="true" /></button>
          <label htmlFor={id} className="sr-only">{selection ? `Notes on v${selection.version}` : "Tell sidekick what you're making"}</label>
          <textarea id={id} ref={inputRef} rows={1} value={state.draft} onChange={(e) => update(root, { draft: e.target.value })}
            onPaste={(e) => {
              if (!e.clipboardData.types.includes("text/plain")) return;
              e.preventDefault();
              const input = e.currentTarget;
              const text = e.clipboardData.getData("text/plain");
              const start = input.selectionStart;
              update(root, { draft: input.value.slice(0, start) + text + input.value.slice(input.selectionEnd) });
              requestAnimationFrame(() => input.setSelectionRange(start + text.length, start + text.length));
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(state.draft); } }} placeholder={selection ? `notes on v${selection.version}…` : placeholder ?? "ask about the footage, or say what you're making"} className={`${COMPOSER_INPUT} ${CHAT_FOCUS}`} />
          <button type="submit" disabled={!state.draft.trim() || !!state.pending} aria-label="Send" onMouseDown={(e) => e.preventDefault()} className={`${COMPOSER_BUTTON} ${state.draft.trim() ? "st-brand-gradient text-white disabled:opacity-30" : COMPOSER_QUIET} ${CHAT_FOCUS}`}><ArrowUp size={19} weight="bold" aria-hidden="true" /></button>
        </div>
      </form>
    </footer>
    <ClipDrawer shoot={shoot} clip={shoot.clips.find((clip) => clip.id === drawer?.clipId) ?? null} initialTime={drawer?.s} onClose={() => setDrawer(null)} />
  </div>;
}
