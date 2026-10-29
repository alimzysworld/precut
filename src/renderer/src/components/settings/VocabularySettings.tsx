import { useEffect, useRef, useState } from "react";
import type { Api, Preferences } from "../../../../shared/schema";
import { getApi } from "../../data";
import { Button, FOCUS, InlineError, SectionHeader, Skeleton } from "../ui";
import { Close as X } from "../icons";
import { settingInput as preferenceInput } from "./shared";
type VocabularyResult = Awaited<ReturnType<Api["applyVocabulary"]>> & { batchId?: string };
type VocabularyAction = (root: string | null, options?: { undo: string }) => Promise<VocabularyResult>;
export function VocabularySettings() {
  const [value, setValue] = useState<Preferences | null>(null);
  const [word, setWord] = useState("");
  const [vocabularyResult, setVocabularyResult] = useState<VocabularyResult | null>(null);
  const [fixing, setFixing] = useState(false);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getApi().getPreferences().then((preferences) => { if (active) { setValue(preferences); } })
      .catch(() => { if (active) setError("Could not read preferences. Reopen this section to try again."); });
    return () => { active = false; };
  }, []);
  async function change(patch: Partial<Preferences>): Promise<boolean> {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setError(null);
    try { setValue(await getApi().setPreferences(patch)); setSaved(true); return true; }
    catch { setError("Could not save preferences. Try again."); return false; }
    finally { saving.current = false; setBusy(false); }
  }
  async function fixVocabulary(undo = false): Promise<void> {
    if (saving.current) return;
    saving.current = true; setBusy(true); setFixing(true); setError(null);
    try {
      const apply = getApi().applyVocabulary as VocabularyAction;
      const result = await apply(null, undo && vocabularyResult?.batchId ? { undo: vocabularyResult.batchId } : undefined);
      if (undo) setUndone(true);
      else { setVocabularyResult(result); setUndone(false); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not fix vocabulary. Try again."); }
    finally { saving.current = false; setBusy(false); setFixing(false); }
  }
  const vocabularyChanges = [...(vocabularyResult?.changes ?? []).reduce((groups, entry) => {
    const key = JSON.stringify([entry.from, entry.to]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { from: entry.from, to: entry.to, count: 1 });
    return groups;
  }, new Map<string, { from: string; to: string; count: number }>()).values()];
  const label = "Words to spell right";
  return <>
    <SectionHeader as="h2" heading={label}>Names and spellings here help transcription and word fixes.</SectionHeader>
    <InlineError className="my-3 text-small text-danger" error={error} /><p role="status" className="text-micro text-muted">{saved && "Saved"}</p>
    {!value && !error ? <Skeleton /> : value && <fieldset disabled={busy} className="space-y-2">
      <legend className="sr-only">{label} preferences</legend>
      {<div className="min-h-[64px] flex-col items-stretch gap-5 rounded-2xl bg-ink/[0.035] px-5 py-4">
        <label htmlFor="vocabulary-word" className="text-body font-medium">Your vocabulary</label>
        {value.vocabulary.length > 0 && <ul aria-label="Saved vocabulary" className="flex flex-wrap gap-2">
          {value.vocabulary.map((entry) => <li key={entry} className="flex max-w-full items-center gap-1 rounded-xl bg-ink/[0.06] py-1 pl-3 pr-1 text-small">
            <span className="break-words">{entry}</span><button type="button" aria-label={`Remove ${entry}`} className={`shrink-0 rounded-lg p-1.5 text-muted hover:text-ink ${FOCUS}`}
              onClick={() => void change({ vocabulary: value.vocabulary.filter((item) => item !== entry) })}><X size={14} /></button>
          </li>)}
        </ul>}
        <form className="flex gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (word.trim()) void change({ vocabulary: [...value.vocabulary, word.trim()] }).then((saved) => { if (saved) setWord(""); });
        }}>
          <input id="vocabulary-word" value={word} onChange={(event) => setWord(event.target.value)} placeholder="sidething, a name…" className={`${preferenceInput} min-w-0 flex-1`} />
          <Button type="submit" disabled={busy || !word.trim()}>Add</Button>
        </form>
        <div className="mt-4 space-y-3">
          <p className="text-small text-muted">Saved vocabulary also fixes past transcripts automatically. Your own word fixes are kept.</p>
          <Button variant="primary" type="button" disabled={busy || !value.vocabulary.length} onClick={() => void fixVocabulary()}>{fixing ? "Checking transcripts…" : "Fix past transcripts"}</Button>
          {vocabularyResult && <div role="status" aria-live="polite" className="space-y-2 text-small">
            {undone ? <p>Vocabulary fixes undone.</p> : vocabularyResult.words ? <>
              <ul className="space-y-1">{vocabularyChanges.map((entry, i) => <li key={i} className="break-words">{entry.from} {"->"} {entry.to}, {entry.count} {entry.count === 1 ? "place" : "places"}</li>)}</ul>
              {vocabularyResult.batchId && <Button type="button" onClick={() => void fixVocabulary(true)}>Undo vocabulary fixes</Button>}
            </> : <p>No vocabulary fixes needed.</p>}
          </div>}
        </div>
      </div>}

    </fieldset>}
  </>;
}

