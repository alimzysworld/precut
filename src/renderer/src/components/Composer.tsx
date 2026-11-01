import { useModelAccess, ModelSignIn } from "./ModelAccess";
import { useEffect, useRef, useState } from "react";
import type { ShootProgress, ShootRequest } from "../../../shared/schema";
import { getApi } from "../data";
import { useShortcuts } from "../hooks/useShortcuts";
import { ArrowUp, Attach, Close } from "./icons";
import { InlineError } from "./ui";
import panda from "../assets/precut-icon-1024.png";

type Told = { id: string; text: string; at: number; clipId?: string; t?: number };
type Line = { key: string; at: number; who: "you" | "precut"; text: string };
const stamp = (iso: string) => { const n = Date.parse(iso); return Number.isFinite(n) ? n : 0; };

/** What precut says back about a brief, from the request's real state. */
export function replyTo(request: ShootRequest): string {
  if (request.state === "queued") return "Got it. I'll use this for the ideas and edits I haven't made yet.";
  if (request.state === "working") return "Working on it.";
  if (request.state === "failed") return requestFailure(request.error);
  const n = request.ideaIds.length;
  return request.note ?? (n ? `Added ${n === 1 ? "an idea" : `${n} ideas`} for this${request.cutIds.length ? ", with an edit" : ""}.` : "Done.");
}

/** One plain line for a failed request: the model or engine's own words stay out of it. */
export function requestFailure(error?: string): string {
  if (error && /too large to fit/i.test(error)) return "This shoot is too big to look at in one go. Try a shorter request.";
  return error && error.length < 140 && !/\n/.test(error) ? error : "Couldn't finish that one. Send it again to retry.";
}

export function conversation(requests: ShootRequest[], told: Told[]): Line[] {
  return [
    ...requests.flatMap((r): Line[] => [{ key: `${r.id}:you`, at: stamp(r.at), who: "you", text: r.text },
      { key: `${r.id}:precut`, at: stamp(r.at) + 1, who: "precut", text: replyTo(r) }]),
    ...told.map((d): Line => ({ key: `found:${d.id}`, at: d.at, who: "precut", text: `${d.text}.` })),
  ].sort((a, b) => a.at - b.at);
}

/** One composer for the whole shoot: the Footage page and the Ideas page share it and the shoot's one conversation. */
export function Composer({ root, scope, onSaved }: { root: string; scope: "clips" | "ideas"; onSaved?: (request: ShootRequest) => void }) {
  const modelReady = useModelAccess();
  const [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [dragging, setDragging] = useState(false), [error, setError] = useState("");
  const [open, setOpen] = useState(false), [requests, setRequests] = useState<ShootRequest[]>([]), [told, setTold] = useState<Told[]>([]), [working, setWorking] = useState(false);
  const pending = useRef(false), file = useRef<HTMLInputElement>(null), box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!modelReady) return;
    const api = getApi();
    let alive = true;
    const load = () => {
      void api.listRequests(root).then(value => { if (alive) setRequests(old => [...new Map([...value, ...old.filter(r => !value.some(v => v.id === r.id))].map(r => [r.id, r])).values()]); }).catch(() => {});
      void api.shootProgress(root).then((p: ShootProgress) => {
        if (!alive) return;
        const extra = p as ShootProgress & { discoveries?: Told[]; overall?: { running: boolean; complete: boolean; failed?: boolean } };
        setTold(extra.discoveries ?? []);
        setWorking(p.running || !!extra.overall && !extra.overall.complete && !extra.overall.failed);
      }).catch(() => {});
    };
    load();
    const off = api.onStepsChanged(changed => { if (changed === root) load(); });
    return () => { alive = false; off(); };
  }, [root, modelReady]);
  useShortcuts(scope, [{ id: "composer-close", keys: ["Escape"], label: "Close the conversation with precut", scope, handler: () => setOpen(false) }], open);
  async function send(text = draft) {
    if (!text.trim() || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const request = await getApi().addRequest(root, text.trim());
      setDraft(current => current === draft ? "" : current);
      setRequests(old => [...old.filter(r => r.id !== request.id), request]); setOpen(true); onSaved?.(request);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save your request. Your words are still here."); }
    finally { pending.current = false; setBusy(false); }
  }
  async function attach(files: File[]) {
    const blocks: string[] = [];
    try {
      for (const f of files) {
        if (!/\.(md|txt)$/i.test(f.name)) throw new Error("Drop a Markdown or text storyboard, or paste a link.");
        blocks.push(`Storyboard: ${f.name}\n${await f.text()}`);
      }
      if (blocks.length) await send([draft, ...blocks].filter(Boolean).join("\n\n"));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read that storyboard."); }
  }
  const lines = conversation(requests, told);
  // A request that failed shows as one plain line in the bar, never a dead state; sending again retries.
  const last = requests.reduce<ShootRequest | undefined>((newest, r) => !newest || stamp(r.at) >= stamp(newest.at) ? r : newest, undefined);
  const failedLine = last?.state === "failed" && !busy ? requestFailure(last.error) : "";
  if (!modelReady) return <ModelSignIn feature={scope === "ideas" ? "ideas" : "ask"} />;
  return <div data-composer={scope} className="pointer-events-none fixed inset-x-0 bottom-4 z-[40] flex justify-center px-4"
    // CH2b: centred on the page, which ends where Claude's pane starts.
    style={{ right: "var(--claude-reserve, 0px)" }} onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <div className="pointer-events-auto relative w-[min(680px,100%)]">
      {open && <section aria-label="Conversation with precut" className="glass-floating absolute bottom-full mb-2 max-h-[min(360px,50vh)] w-full overflow-y-auto rounded-3xl p-4">
        <button type="button" aria-label="Close conversation" onClick={() => setOpen(false)} className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-ink"><Close size={14} /></button>
        {lines.length ? <ul className="space-y-2 pr-6 text-small">{lines.map(line => <li key={line.key} data-from={line.who} className={line.who === "you" ? "ml-auto w-fit max-w-[85%] rounded-2xl bg-ink/[0.06] px-3 py-1.5" : "max-w-[85%] text-ink"}>{line.text}</li>)}</ul>
          : <p className="pr-6 text-small text-muted">Nothing yet. precut will tell you what it finds as it goes.</p>}
      </section>}
      <form aria-label="Add a request" className={`glass-floating flex items-center gap-3 rounded-[28px] py-2.5 pl-3 pr-3 ${dragging ? "bg-ink/[0.06]" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}
        onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void attach(Array.from(event.dataTransfer.files)); }}>
        <button type="button" aria-label={open ? "Hide conversation" : "Show conversation"} aria-expanded={open} onClick={() => setOpen(value => !value)} className="size-11 shrink-0 overflow-hidden rounded-full bg-ink/[0.06]"><img src={panda} alt="" className="size-full object-cover" /></button>
        <div className="min-w-0 flex-1">
          <textarea ref={box} aria-label="Anything in mind?" placeholder="Anything in mind?" rows={1} value={draft} onFocus={() => { if (lines.length) setOpen(true); }} onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
            className="block max-h-24 min-h-6 w-full resize-none border-0 bg-transparent p-0 text-body font-medium text-ink outline-none [field-sizing:content] placeholder:text-ink" />
          {!draft && <p className="truncate text-micro text-muted">{working ? "Tell precut what you're making, or leave it to us. We're already working." : "Tell precut what you're making, or leave it to us."}</p>}
        </div>
        <input ref={file} type="file" accept=".md,.txt,text/plain,text/markdown" multiple hidden onChange={event => { void attach(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
        <button type="button" aria-label="Attach a storyboard" disabled={busy} onClick={() => file.current?.click()} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-muted hover:text-ink disabled:opacity-45"><Attach size={18} /></button>
        <button type="submit" aria-label="Add request" disabled={busy || !draft.trim()} className="st-button-primary flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-45"><ArrowUp size={18} /></button>
      </form>
      {(error || failedLine) && <InlineError className="mt-2 text-center text-small text-danger">{error || failedLine}</InlineError>}
    </div>
  </div>;
}
