import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModelAccess, ModelSignIn } from "../ModelAccess";
import { AskPanel } from "../finish/AskPanel";
import { ArrowUp, Check, ChevronDown, Clock, Eye, Icon, More, Note, Search, type IconProps } from "../icons";
import { Tooltip } from "../ui/InfoTip";
import { getApi } from "../../data";
import { usePageActive } from "../../hooks/usePageActivity";
import { claudeApi, type ChatSnapshot, type SavedChat } from "../../claude-api";
import type { AskScreenContext } from "../../terminal-api";
import { EFFORTS, chipModelLabel, emptyTranscript, ongoingLabel, modeCycle, modeLabel, modelLabel, pendingAsk, permissionDetails, permissionText, presentLabel, quietStep, reduceChat, replay,
  type Item, type ModelOption, type Receipt, type Step, type Transcript } from "@shared/claude-chat";
import { Markdown } from "./claudeMarkdown";
import "./claude-chat.css";

/** CH3: Claude Code's documented commands that work as message text, and precut's own (/clear, /model and /resume pickers). */
const COMMANDS: [string, string][] = [["/clear", "Start a fresh chat"], ["/model", "Model and effort"], ["/resume", "Pick up an earlier chat"], ["/compact", "Shorten the chat, keep the gist"],
  ["/effort", "How hard Claude thinks"], ["/fast", "Fast mode on or off"], ["/mcp", "Your MCP servers"]];
const ALIASES: ModelOption[] = [{ value: "default", label: "Default", description: "Claude Code's choice for your plan" }, { value: "opus", label: "Opus", description: "Best for judgement calls" },
  { value: "sonnet", label: "Sonnet", description: "Quicker for small edits" }, { value: "haiku", label: "Haiku", description: "Fastest, for simple asks" }];
const Stop = (props: IconProps) => <Icon {...props}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></Icon>;
const plain = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "");
const stamp = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const sameModel = (current: string | null, option: ModelOption) => !!current && (current === option.value || modelLabel(current).toLowerCase().startsWith(option.label.toLowerCase().split(" ")[0]));

/** POLISH1: a step the person said No to reads "Skipped: ...", never a failure. */
function StepLine({ step, live, skipped }: { step: Step; live: boolean; skipped?: boolean }) {
  const icon = !step.done ? <Eye size={13} /> : step.ok ? <Check size={13} /> : <span className="cc-x" aria-hidden="true">×</span>;
  return <div className="cc-step" data-claude-step data-done={step.done || undefined} data-skipped={skipped || undefined}>{icon}<span>{skipped ? `Skipped: ${presentLabel(step.label).replace(/^./, c => c.toLowerCase())}` : step.done ? step.label : ongoingLabel(step.label)}</span>{!step.done && live && !skipped ? <span className="cc-think" aria-label="Working"><i /><i /><i /></span> : null}</div>;
}
function ReceiptRow({ receipt }: { receipt: Receipt }) {
  const [state, setState] = useState<"idle" | "undone" | "moved">("idle");
  if (receipt.createdVersion !== true) return null;
  const undo = () => window.dispatchEvent(new CustomEvent("precut:claude-undo", { detail: { cutId: receipt.cutId, version: receipt.version, done: (ok: boolean) => setState(ok ? "undone" : "moved") } }));
  return <div className="cc-receipt" data-claude-receipt><Check size={14} /><span><b>{receipt.label}</b> version {receipt.version}</span>
    {state === "idle" ? <Tooltip label="Undo this" shortcut="⌘Z"><button type="button" className="cc-undo" onClick={undo}>Undo</button></Tooltip>
      : <span className="cc-undone">{state === "undone" ? "Undone" : "Changed since"}</span>}</div>;
}
/** POLISH1: the ask is a plain sentence; the raw input waits behind Show details. Answered: a Yes to a tool (MCP) is
 * already its step line, so it shows nothing more; a No reads "Skipped: ..." (on the step itself when it has one). */
function PermissionCard({ item, onAnswer, onStep }: { item: Extract<Item, { type: "permission" }>; onAnswer: (allow: boolean) => void; onStep: boolean }) {
  const { title, detail } = permissionText(item.tool, item.input);
  const [details, setDetails] = useState(false);
  const what = title.replace(/\?$/, "");
  if (item.answer === "allow" && /^mcp__/.test(item.tool)) return null;
  if (item.answer === "deny" && onStep) return null;
  if (item.answer) return <div className="cc-step" data-claude-answered>{item.answer === "allow" ? <Check size={13} /> : <span className="cc-x" aria-hidden="true">×</span>}<span>{item.answer === "allow" ? `Allowed: ${what}` : `Skipped: ${what.replace(/^./, c => c.toLowerCase())}`}</span></div>;
  const raw = permissionDetails(item.tool, item.input);
  return <div className="cc-perm" data-claude-permission role="group" aria-label={title}>
    <p><b>{title}</b> <span className="cc-muted">{detail}</span></p>
    {raw && raw !== "{}" ? <><button type="button" className="cc-details" aria-expanded={details} data-claude-details onClick={() => setDetails(value => !value)}>{details ? "Hide details" : "Show details"}</button>
      {details ? <pre className="cc-raw" data-claude-raw>{raw}</pre> : null}</> : null}
    {/* "Yes, and don't ask again" needs a documented way to hand Claude Code the rule from here; until then, Yes or No. */}
    <div className="cc-opts">
      <button type="button" className="cc-opt cc-opt-first" data-claude-allow onClick={() => onAnswer(true)}>Yes<kbd>1</kbd></button>
      <button type="button" className="cc-opt" data-claude-deny onClick={() => onAnswer(false)}>No, and tell Claude what to do instead<kbd>Esc</kbd></button>
    </div>
  </div>;
}

/** CH2b: the pane follows every page; its first words and starters are about what that page shows. */
type Where = "edit" | "ideas" | "footage";
const FIRST: Record<Where, { title: string; body: string; placeholder: string; starters: string[] }> = {
  edit: { title: "What should change in this edit?", body: "I can see the edit, the playhead and what you select. Every change lands as an undo step.", placeholder: "Ask Claude to change this edit", starters: [] },
  ideas: { title: "What should we make from this shoot?", body: "I can see your ideas and the one you're talking about. Nothing gets made until you say so.", placeholder: "Ask Claude about your ideas",
    starters: ["Which idea has the strongest hook?", "Give me three more ideas", "Make the best idea into an edit"] },
  footage: { title: "What are you looking for in this footage?", body: "I can read what was said and look at your clips. Your footage never changes.", placeholder: "Ask Claude about this footage",
    starters: ["Find my best takes", "Where do I say the big line?", "Which clips would make a good hook?"] },
};
type Menu = null | "model" | "more" | "resume";
export function ClaudeChat({ root, cutId, version, screenContext, where: place = "edit" }: { root: string; cutId?: string; version: number; screenContext?: AskScreenContext; where?: Where }) {
  const modelReady = useModelAccess();
  const active = usePageActive();
  const [snapshot, setSnapshot] = useState<ChatSnapshot>();
  const [chat, setChat] = useState<Transcript>(emptyTranscript);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(""), [menu, setMenu] = useState<Menu>(null), [pick, setPick] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null), [saved, setSaved] = useState<SavedChat[] | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), list = useRef<HTMLDivElement>(null), stick = useRef(true), sequence = useRef(0);
  const context = useMemo(() => ({ ...screenContext, cutId, version }), [screenContext, cutId, version]);
  const latest = useRef({ root, cutId, version, context }); latest.current = { root, cutId, version, context };
  const id = snapshot?.engine === "claude" ? snapshot.id : null;
  const showError = (value: unknown) => setError(plain(value));

  useEffect(() => { setSlot(document.getElementById("claude-head-slot")); }, []);
  useEffect(() => { if (id) window.dispatchEvent(new Event("precut:claude-compose-ready")); }, [id]);
  useEffect(() => {
    if (!modelReady || !active) return;
    const api = claudeApi();
    if (!api) { setError("Open the desktop app to use Claude."); return; }
    let live = true, current: string | null = null;
    const early: Parameters<Parameters<typeof api.onEvent>[0]>[0][] = [];
    const off = api.onEvent(event => {
      if (!live) return;
      if (current === null) { early.push(event); return; }
      if (event.id !== current || event.sequence <= sequence.current) return;
      sequence.current = event.sequence;
      setChat(previous => reduceChat(previous, event));
    });
    setError(null);
    api.open({ root, cutId: latest.current.cutId, version: latest.current.version, context: latest.current.context }).then(next => {
      if (!live) return;
      setSnapshot(next);
      if (next.engine !== "claude") return;
      current = next.id; sequence.current = next.sequence;
      let transcript = replay(next.events);
      for (const event of early) if (event.id === next.id && event.sequence > sequence.current) { sequence.current = event.sequence; transcript = reduceChat(transcript, event); }
      setChat(transcript);
    }).catch(error => { if (live) showError(error); });
    return () => { live = false; off(); };
  }, [root, modelReady, active]);
  // The newest playhead and selection, without an IPC call per frame. Claude reads them through precut_context, as in the terminal.
  useEffect(() => {
    if (!active || !id) return;
    const timer = window.setTimeout(() => { void claudeApi()?.context(id, latest.current.context).catch(showError); }, 120);
    return () => window.clearTimeout(timer);
  }, [context, id, active]);
  useLayoutEffect(() => { const element = list.current; if (element && stick.current) element.scrollTop = element.scrollHeight; }, [chat]);
  // Hidden (⌘L) the pane is squeezed to nothing; shown again, a chat that was at its end is at its end.
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (stick.current && element.clientWidth > 100) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, [id]);

  const ask = pendingAsk(chat);
  const slash = /^\/\S*$/.test(text) ? text : null;
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1] ?? null;
  const commands = useMemo(() => {
    const extra = (chat.commands ?? []).map(c => [`/${c.name.replace(/^\//, "")}`, c.description] as [string, string]);
    const all = [...COMMANDS, ...extra.filter(([name]) => !COMMANDS.some(([known]) => known === name))];
    return slash === null ? [] : all.filter(([name]) => name.startsWith(slash.toLowerCase())).slice(0, 9);
  }, [slash, chat.commands]);
  useEffect(() => {
    if (mention === null || !id) { setFiles(null); return; }
    let live = true;
    const timer = window.setTimeout(() => { void claudeApi()?.files(id, mention).then(found => { if (live) { setFiles(found.slice(0, 8)); setPick(0); } }).catch(() => {}); }, 80);
    return () => { live = false; window.clearTimeout(timer); };
  }, [mention, id]);
  useEffect(() => { setPick(0); }, [slash]);
  useEffect(() => {
    if (menu !== "resume" || !id) return;
    setSaved(null);
    void claudeApi()?.sessions(id).then(setSaved).catch(showError);
  }, [menu, id]);

  const call = async (work: () => Promise<unknown> | undefined) => { setError(null); try { await work(); } catch (error) { showError(error); } };
  const send = (value: string) => {
    const message = value.trim();
    if (!message || !id) return;
    if (message === "/model") { setText(""); setMenu("model"); return; }
    if (message === "/resume") { setText(""); setMenu("resume"); return; }
    setText(""); stick.current = true;
    void call(() => claudeApi()?.send(id, message, latest.current.context));
  };
  const answer = (allow: boolean) => {
    if (!ask || !id) return;
    void call(() => claudeApi()?.answer(id, ask.request, allow));
    if (!allow) requestAnimationFrame(() => input.current?.focus());
  };
  const interrupt = () => { if (id && chat.running) void call(() => claudeApi()?.interrupt(id)); };
  const cycleMode = () => {
    if (!id) return;
    const order = modeCycle([...chat.modesSeen, chat.mode ?? "default"]);
    const next = order[(order.indexOf(chat.mode ?? "default") + 1) % order.length];
    void call(() => claudeApi()?.mode(id, next));
  };
  const chooseCommand = (name: string) => {
    if (name === "/clear" || name === "/model" || name === "/resume") { send(name); return; }
    setText(`${name} `); input.current?.focus();
  };
  const chooseFile = (file: string) => { setText(value => value.replace(/@[^\s@]*$/, `@${file} `)); setFiles(null); input.current?.focus(); };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation();
    const typing = event.target === input.current;
    const options = slash !== null && commands.length ? commands.length : files?.length ? files.length : 0;
    if (options && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setPick(value => (value + (event.key === "ArrowDown" ? 1 : options - 1)) % options); return; }
    if (options && (event.key === "Tab" && !event.shiftKey || event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      if (slash !== null && commands.length) chooseCommand(commands[Math.min(pick, commands.length - 1)][0]); else if (files?.length) chooseFile(files[Math.min(pick, files.length - 1)]);
      return;
    }
    if (event.key === "Tab" && event.shiftKey) { event.preventDefault(); cycleMode(); return; }
    if (event.key === "Escape") {
      if (menu) { event.preventDefault(); setMenu(null); return; }
      if (options) { event.preventDefault(); setText(value => slash !== null ? "" : value.replace(/@[^\s@]*$/, "")); return; }
      if (ask) { event.preventDefault(); answer(false); return; }
      if (chat.running) { event.preventDefault(); interrupt(); return; }
      return;
    }
    if (ask && (!typing || !text) && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "1" || event.key === "2")) { event.preventDefault(); answer(event.key === "1"); return; }
    if (typing && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!chat.running) send(text); }
  };
  useLayoutEffect(() => { const box = input.current; if (!box) return; box.style.height = "0px"; box.style.height = `${Math.min(140, Math.max(38, box.scrollHeight))}px`; }, [text]);
  // A new permission ask takes the keys when Claude's pane already had them, so 1, 2 and Esc answer it at once.
  useEffect(() => { if (ask && document.activeElement?.closest("#claude-pane") && document.activeElement !== input.current) document.querySelector<HTMLElement>("[data-claude-allow]")?.focus(); }, [ask?.request]);

  if (!modelReady) return <ModelSignIn feature="ask" />;
  // Codex and Muse stay a terminal in the pane for now.
  if (snapshot && snapshot.engine !== "claude") return <div className="flex min-h-0 flex-1 flex-col px-3 pb-3"><AskPanel autoFocus={false} root={root} cutId={cutId} version={version} screenContext={screenContext} /></div>;

  const models = chat.models ?? ALIASES;
  // POLISH1: before the first turn, the model Claude Code will run (main reads it from its settings or last session).
  const chipModel = chat.pendingModel ?? chat.model ?? chat.defaultModel ?? null;
  const effortName = EFFORTS.find(([value]) => value === chat.effort)?.[1];
  const where = typeof screenContext?.playheadS === "number" ? `${stamp(screenContext.playheadS)}${typeof screenContext.selectedPiece === "number" ? `, clip ${screenContext.selectedPiece + 1}` : ""}` : null;
  const first = FIRST[place];
  const about = place === "ideas" && screenContext?.idea ? screenContext.idea.title : null;
  const starters = place !== "edit" ? first.starters : ["Add finishing touches", `Put a word behind my head at ${typeof screenContext?.playheadS === "number" ? stamp(screenContext.playheadS).replace(/\.\d$/, "") : "0:12"}`, "Cut the ums and the long pauses", "Add a title slam on the big line"];
  const lastSteps = [...chat.items].reverse().find(item => item.type === "steps");
  // A No to a tool marks its step (Claude Code names the call in the ask): "Skipped: ...".
  const denied = new Set(chat.items.flatMap(item => item.type === "permission" && item.answer === "deny" && item.toolUseId ? [item.toolUseId] : []));
  const stepIds = new Set(chat.items.flatMap(item => item.type === "steps" ? item.steps.filter(step => !quietStep(step.name)).map(step => step.id) : []));
  const working = chat.running && !ask && !(lastSteps && chat.items.at(-1) === lastSteps && (lastSteps as Extract<Item, { type: "steps" }>).steps.some(s => !s.done));

  const chip = <button type="button" className="cc-model" data-claude-model aria-haspopup="menu" aria-expanded={menu === "model"} onClick={() => setMenu(menu === "model" ? null : "model")} disabled={!id}>
    {chipModelLabel(chat)}{effortName ? <span className="cc-eff">{effortName}</span> : null}<ChevronDown size={12} /></button>;
  const head = <>
    {/* The tip steps aside while the menu it names is open. */}
    {menu === "model" ? chip : <Tooltip label="Model and effort" shortcut="/model">{chip}</Tooltip>}
    <span className="flex-1" />
    <Tooltip label="New chat, Resume, Settings"><button type="button" className="cc-icon" aria-label="More" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}><More size={16} /></button></Tooltip>
  </>;
  const popover = menu === "model" ? <div className="cc-menu" role="menu" aria-label="Model and effort" data-claude-model-menu>
    {models.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={sameModel(chipModel, option)} className="cc-row" disabled={chat.running}
      onClick={() => { setMenu(null); send(`/model ${option.value}`); }}><span><b>{option.label}</b>{option.description ? <small>{option.description}</small> : null}</span>{sameModel(chipModel, option) ? <Check size={15} /> : null}</button>)}
    <div className="cc-label">Effort</div>
    <div className="cc-effort" role="group" aria-label="Effort">{EFFORTS.map(([value, label]) => <button key={value} type="button" aria-pressed={chat.effort === value} disabled={chat.running} onClick={() => { setMenu(null); send(`/effort ${value}`); }}>{label}</button>)}</div>
    <div className="cc-src">{chat.models ? "The list comes from Claude Code and your plan." : "Claude Code's model names. Your plan decides which ones run."}</div>
  </div> : menu === "more" ? <div className="cc-menu cc-menu-end" role="menu" aria-label="More">
    <button type="button" role="menuitem" className="cc-row" onClick={() => { setMenu(null); send("/clear"); }}><span><b>New chat</b><small>/clear</small></span></button>
    <button type="button" role="menuitem" className="cc-row" onClick={() => setMenu("resume")}><span><b>Resume</b><small>Pick up an earlier chat</small></span></button>
    <button type="button" role="menuitem" className="cc-row" onClick={() => { setMenu(null); void import("../SettingsSheet").then(({ openSettings }) => openSettings("ai")); }}><span><b>Settings</b><small>Which AI precut uses</small></span></button>
  </div> : menu === "resume" ? <div className="cc-menu" role="menu" aria-label="Earlier chats" data-claude-resume>
    {saved === null ? <div className="cc-src">Looking for earlier chats…</div> : saved.length ? saved.map(entry => <button key={entry.id} type="button" role="menuitem" className="cc-row"
      onClick={() => { setMenu(null); if (id) void call(() => claudeApi()?.resume(id, entry.id)); }}><span><b>{entry.title}</b><small>{new Date(entry.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></span></button>)
      : <div className="cc-src">No earlier chats in this shoot yet.</div>}
  </div> : null;

  const problem = chat.problem;
  return <div className="cc-root" aria-label="Claude chat" data-claude-chat data-editor-widget data-ask-terminal onKeyDown={onKeyDown}>
    {slot ? createPortal(<div className="contents" data-claude-head>{head}{popover}</div>, slot) : null}
    {menu ? <div className="cc-scrim" onMouseDown={() => setMenu(null)} /> : null}
    <div ref={list} className="cc-msgs" data-claude-messages onScroll={event => { const el = event.currentTarget; if (el.clientWidth > 100) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {problem === "not-installed" ? <div className="cc-first"><p className="cc-title">Claude Code isn't on this Mac</p><p className="cc-muted">precut runs your own Claude Code, on your own plan. Install it, then check again.</p>
        <div className="cc-starters"><button type="button" className="cc-starter" onClick={() => void call(() => getApi().openEngineHelp("claude", "install"))}>Install Claude Code</button>
          <button type="button" className="cc-starter" onClick={() => id && void call(() => claudeApi()!.restart(id))}>Check again</button></div></div>
      : problem === "signed-out" ? <div className="cc-first" data-claude-signed-out><p className="cc-title">Sign in to Claude Code</p><p className="cc-muted">Open Terminal and run <code>claude</code>, then sign in with your Claude account. precut uses that login and never sees it.</p>
        <div className="cc-starters"><button type="button" className="cc-starter" onClick={() => void call(() => getApi().openEngineHelp("claude", "signin"))}>Open Terminal</button>
          <button type="button" className="cc-starter" onClick={() => id && void call(() => claudeApi()!.restart(id))}>Check again</button></div></div>
      : !chat.items.length && id ? <div className="cc-first" data-claude-starters><p className="cc-title">{first.title}</p><p className="cc-muted">{first.body}</p>
        <div className="cc-starters">{starters.map(starter => <button key={starter} type="button" className="cc-starter" onClick={() => send(starter)}>{starter}</button>)}</div></div>
      : null}
      {chat.items.map(item => item.type === "ask" ? <div key={item.key} className="cc-me" data-claude-ask>{item.text.split(/(@\S+)/g).map((part, i) => part.startsWith("@") && part.length > 1 ? <span key={i} className="cc-mention">{part.slice(1).split("/").at(-1)}</span> : part)}</div>
        : item.type === "steps" ? item.steps.some(step => !quietStep(step.name)) ? <div key={item.key} className="cc-steps">{item.steps.filter(step => !quietStep(step.name)).map(step => <Fragment key={step.id}><StepLine step={step} live={chat.running} skipped={denied.has(step.id)} />{step.receipt ? <ReceiptRow receipt={step.receipt} /> : null}</Fragment>)}</div> : null
        : item.type === "reply" ? <div key={item.key} className="cc-ai" data-claude-reply data-done={item.done || undefined}><Markdown text={item.text} /></div>
        : item.type === "permission" ? <PermissionCard key={item.key} item={item} onAnswer={answer} onStep={!!item.toolUseId && stepIds.has(item.toolUseId)} />
        : <div key={item.key} className={`cc-notice${item.tone === "problem" ? " cc-problem" : ""}`} data-claude-notice>{item.text}</div>)}
      {working ? <div className="cc-step" data-claude-working><Search size={13} /><span>Working</span><span className="cc-think"><i /><i /><i /></span></div> : null}
    </div>
    {error ? <p className="cc-error" role="alert">{error}</p> : null}
    <div className="cc-compose">
      {place === "edit" ? <div id="claude-finishing-touches" /> : null}
      {slash !== null && commands.length ? <div className="cc-list" role="listbox" aria-label="Commands" data-claude-commands>{commands.map(([name, about], i) =>
        <div key={name} role="option" aria-selected={i === pick} className="cc-cmd" onMouseDown={event => { event.preventDefault(); chooseCommand(name); }} onMouseEnter={() => setPick(i)}><b>{name}</b><span>{about}</span></div>)}</div>
      : files?.length ? <div className="cc-list" role="listbox" aria-label="Files" data-claude-files>{files.map((file, i) =>
        <div key={file} role="option" aria-selected={i === pick} className="cc-cmd cc-file" onMouseDown={event => { event.preventDefault(); chooseFile(file); }} onMouseEnter={() => setPick(i)}><b>{file.split("/").at(-1)}</b><span>{file}</span></div>)}</div> : null}
      <div className="cc-box">
        <textarea ref={input} data-claude-input rows={1} value={text} disabled={!id || !!problem} onChange={event => setText(event.target.value)} placeholder={first.placeholder} aria-label="Message Claude" spellCheck />
        <div className="cc-box-row">
          {place === "edit" && where ? <span className="cc-ctx" data-claude-context><Clock size={12} />{where}</span> : null}
          {about ? <span className="cc-ctx min-w-0" data-claude-context data-claude-idea title={about}><Note size={12} className="shrink-0" /><span className="truncate">{about}</span></span> : null}
          {chat.running ? <Tooltip label="Stop Claude" shortcut="Esc"><button type="button" className="cc-send cc-stop" aria-label="Stop" data-claude-stop onClick={interrupt}><Stop size={14} /></button></Tooltip>
            : <Tooltip label="Send" shortcut="↵"><button type="button" className="cc-send" aria-label="Send" data-claude-send disabled={!text.trim() || !id} onClick={() => send(text)}><ArrowUp size={15} /></button></Tooltip>}
        </div>
      </div>
      <div className="cc-quiet">
        <Tooltip label="Permission mode" shortcut="⇧⇥"><button type="button" className="cc-mode" data-claude-mode onClick={cycleMode} disabled={!id}>{modeLabel(chat.mode)}</button></Tooltip>
        <span className="cc-hints"><span><kbd>@</kbd>files</span><span><kbd>/</kbd>commands</span></span>
      </div>
    </div>
  </div>;
}
