import { useModelAccess, ModelSignIn } from "../ModelAccess";
import { useRef, useState } from "react";
import { getApi } from "../../data";
import { FOCUS, InlineError } from "../ui";

export function NewEditPrompt({ root, onBlank, busy = false }: { root: string; onBlank: () => void; busy?: boolean }) {
  const modelReady = useModelAccess();
  const [text, setText] = useState(""), [sending, setSending] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const pending = useRef(false);
  async function submit() {
    if (!modelReady || !text.trim() || pending.current) return;
    pending.current = true; setSending(true); setError(""); setSaved(false);
    const submitted = text;
    try {
      await getApi().addRequest(root, submitted.trim());
      setText(current => current === submitted ? "" : current); setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save your request. Try again."); }
    finally { pending.current = false; setSending(false); }
  }
  if (!modelReady) return <div className="min-w-0 space-y-2 px-1 pb-3"><ModelSignIn feature="newEdit" /><button type="button" disabled={busy} onClick={onBlank} className={`rounded-full px-2 py-1.5 text-micro text-muted hover:bg-ink/[0.06] ${FOCUS}`}>Blank</button></div>;
  return <div className="min-w-0 px-1 pb-3">
    <form aria-label="New edit request" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea autoFocus aria-label="What do you want to make?" placeholder="What do you want to make?" rows={2} value={text} onChange={event => { setText(event.target.value); setSaved(false); }}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}
        className={`w-full resize-none rounded-xl bg-ink/[0.04] p-2 text-small placeholder:text-muted ${FOCUS}`} />
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" disabled={sending || !text.trim()} className={`st-button-primary rounded-full px-3 py-1.5 text-micro text-white disabled:opacity-40 ${FOCUS}`}>{sending ? "Saving…" : "Make edit"}</button>
        <button type="button" disabled={busy} onClick={onBlank} className={`rounded-full px-2 py-1.5 text-micro text-muted hover:bg-ink/[0.06] ${FOCUS}`}>Blank</button>
      </div>
    </form>
    {saved && <p role="status" className="mt-2 text-micro text-muted">Request saved</p>}
    {error && <InlineError className="mt-2 text-micro text-danger">{error}</InlineError>}
  </div>;
}
