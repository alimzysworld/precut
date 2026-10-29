import { correctWords, DocumentQueue } from "./transcriptEdits";
import { InlineError } from "../ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CutVersion, Shoot, Word } from "../../../../shared/schema";
import { storyboard } from "../edits/model";
import { getApi } from "../../data";
import { Button, FOCUS } from "../ui";
import { transcriptSeparator, transcriptText } from "../../../../main/titles/text";

type Removal = NonNullable<NonNullable<CutVersion["pieces"]>[number]["removed"]>[number] & { ranges?: { s: number; e: number }[] };
type TimedWord = Word & { start: number; end: number; removed?: Removal };

export function transcriptPieces(shoot: Shoot, version: CutVersion) {
  let cursor = 0;
  return storyboard(shoot, version).pieces.map((piece, pieceIndex) => {
    const start = piece.timelineS ?? cursor, removed = [...(piece.removed ?? [])].sort((a, b) => a.s - b.s);
    const spans: { s: number; e: number }[] = []; let source = piece.s;
    for (const gap of removed.flatMap(gap => (gap as Removal).ranges ?? [gap]).sort((a, b) => a.s - b.s)) { if (gap.s > source) spans.push({ s: source, e: Math.min(gap.s, piece.e) }); source = Math.max(source, Math.min(gap.e, piece.e)); }
    if (source < piece.e) spans.push({ s: source, e: piece.e });
    const total = spans.reduce((sum, span) => sum + span.e - span.s, 0), length = piece.lengthS ?? total;
    cursor = start + length;
    const words: TimedWord[] = [];
    let at = start;
    const measured = (version.pieces?.[pieceIndex] as { timedWords?: Word[] } | undefined)?.timedWords;
    const sourceWords = shoot.clips.find(clip => clip.id === piece.clipId)?.transcript?.flatMap(segment => segment.words) ?? [];
    const corrections = sourceWords.filter(word => word.byHand);
    // A successful word fix must be visible before the saved version refreshes.
    // Keep measured timing elsewhere, replacing only the person's corrected spans.
    const transcript = measured ? [...measured.filter(word => !corrections.some(fix => word.s < fix.e && word.e > fix.s)), ...corrections].sort((a, b) => a.s - b.s) : sourceWords;
    for (const span of spans) {
      const scale = total > 0 ? length / total : 1;
      for (const word of transcript.filter(word => word.e > span.s && word.s < span.e)) {
        const existing = words.find(other => other.s === word.s && other.e === word.e);
        const end = at + (Math.min(word.e, span.e) - span.s) * scale;
        if (existing) existing.end = end;
        else words.push({ ...word, start: at + (Math.max(word.s, span.s) - span.s) * scale, end });
      }
      at += (span.e - span.s) * scale;
    }
    const displayWords: TimedWord[] = transcript.filter(word => word.e > piece.s && word.s < piece.e || removed.some(gap => gap.kind !== "pause" && word.s < gap.e && word.e > gap.s)).map(word => {
      const gap = removed.find(gap => gap.kind !== "pause" && word.s < gap.e && word.e > gap.s);
      return gap ? { ...word, start, end: start, removed: gap } : words.find(kept => kept.s === word.s && kept.e === word.e);
    }).filter((word): word is TimedWord => !!word);
    for (const gap of removed) if (gap.kind === "pause" || !displayWords.some(word => word.removed === gap)) {
      displayWords.push({ s: gap.s, e: gap.e, w: gap.kind === "pause" ? "· pause ·" : gap.text || "· filler ·", start, end: start, removed: gap });
    }
    displayWords.sort((a, b) => a.s - b.s);
    return { ...piece, pieceIndex, start, end: cursor, timedWords: words, displayWords };
  }).filter(piece => !piece.broll);
}
/** Count only measured or transcribed fillers that still intersect kept speech. */
export function removableFillerCount(shoot: Shoot, version: CutVersion): number {
  return transcriptPieces(shoot, version).reduce((count, piece) => {
    const clip = shoot.clips.find(clip => clip.id === piece.clipId);
    const markers = [...(clip?.fillers ?? [])];
    for (const word of piece.timedWords) {
      if (/^(?:u+m+|u+h+|e+r+m*|a+h+|h+m+|m{2,})$/i.test(word.w.replace(/[^a-z]/gi, "")) && !markers.some(marker => marker.s < word.e && marker.e > word.s)) {
        markers.push({ s: word.s, e: word.e, kind: "word", text: word.w });
      }
    }
    const seen = new Set<string>();
    return count + markers.filter(marker => {
      if (marker.kind === "pause" || !Number.isFinite(marker.s) || !Number.isFinite(marker.e) || marker.e <= marker.s) return false;
      const key = `${marker.s}:${marker.e}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const start = Math.max(marker.s, piece.s), end = Math.min(marker.e, piece.e);
      if (end <= start || piece.removed?.some(gap => gap.kind !== "pause" && gap.s <= marker.s && gap.e >= marker.e)) return false;
      let cursor = start;
      const holes = (piece.removed ?? []).flatMap(gap => (gap as Removal).ranges ?? [gap]).sort((a, b) => a.s - b.s);
      for (const hole of holes) {
        if (hole.e <= cursor) continue;
        if (hole.s > cursor) break;
        cursor = Math.max(cursor, hole.e);
      }
      return cursor < end;
    }).length;
  }, 0);
}

const spelling = (value: string) => value.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const token = (value: string) => spelling(value).toLocaleLowerCase();
type Occurrence = { clipId: string; s: number; e: number; text: string };
export function otherOccurrences(shoot: Shoot, wrong: string, correction: string, exclude: Occurrence): Occurrence[] {
  const key = token(wrong);
  if (!key || !spelling(correction) || /\s/.test(wrong.trim()) || /\s/.test(spelling(correction))) return [];
  return shoot.clips.flatMap(clip => (clip.transcript ?? []).flatMap(segment => segment.words).filter(word => token(word.w) === key && !(clip.id === exclude.clipId && word.s < exclude.e && word.e > exclude.s))
    .map(word => ({ clipId: clip.id, s: word.s, e: word.e, text: word.w.trim().replace(/[\p{L}\p{N}][\s\S]*[\p{L}\p{N}]|[\p{L}\p{N}]/u, () => spelling(correction)) })));
}
// The sidebar owns no player ref. Drive the existing React seek control in the
// nearest workspace so both the live clock and saved-preview player stay in sync.
export function seekWorkspace(host: HTMLElement | null, time: number): boolean {
  let workspace: HTMLElement | null = host;
  while (workspace && !workspace.querySelector("[data-cut-stage]")) workspace = workspace.parentElement;
  const slider = Array.from(workspace?.querySelectorAll<HTMLInputElement>('[data-cut-stage] input[type="range"][aria-label^="Seek "]') ?? []).find(input => !input.disabled && !input.closest('[aria-hidden="true"]'));
  if (!slider) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(slider, String(time)); slider.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}
/** True when the selection range overlaps the word's own text, not just its edge. 1 is START_TO_END, 3 is END_TO_START. */
export function coversWord(range: { compareBoundaryPoints(how: number, other: any): number }, own: unknown): boolean {
  return range.compareBoundaryPoints(1, own) > 0 && range.compareBoundaryPoints(3, own) < 0;
}
/** A clip's text when it has no timed words, never a file name ("IMG_4737.MOV"): an inserted source piece
 * stores its file name where a take stores what was said. */
function spokenFallback(text: string | undefined, file?: string): string {
  const value = transcriptText([text ?? ""]);
  if (!value) return "";
  const base = (file ?? "").split("/").pop() ?? "";
  return value === file || value === base || /^[^\s]+\.(?:mov|mp4|m4v|mts|mxf|avi|mkv|webm|wav|mp3|m4a|aac|aif|aiff|heic|jpe?g|png)$/iu.test(value) ? "" : value;
}
type Source = { clipId: string; s?: number; e?: number; fallback?: string };
/** A clip's own transcript (Footage and the clip drawer): click a word to jump there, type or double-click to
 * correct it. SCRIPT1: an edit's words are the Script panel's document (ScriptPanel.tsx); this is not that. */
export function TranscriptPanel({ shoot: inputShoot, source, time = 0, onChange = () => {}, onSaving = () => {}, onSeek }: { shoot: Shoot; source: Source; time?: number; onChange?: (shoot: Shoot) => void; onSaving?: (value: boolean) => void; onSeek?: (time: number) => void }) {
  const [localShoot, setLocalShoot] = useState<Shoot | null>(null);
  const shoot = localShoot ?? inputShoot;
  const version = useMemo(() => {
    const clip = shoot.clips.find(clip => clip.id === source.clipId);
    const s = source.s ?? 0, e = source.e ?? clip?.meta?.durationS ?? Math.max(0, ...(clip?.transcript?.flatMap(segment => segment.words).map(word => word.e) ?? []));
    return { version: 0, pieces: [{ id: source.clipId, clipId: source.clipId, kind: "voice", s, e, timelineS: s, lengthS: e - s, words: source.fallback ?? "" }] } as CutVersion;
  }, [shoot, source.clipId, source.s, source.e, source.fallback]);
  const pieces = useMemo(() => transcriptPieces(shoot, version), [shoot, version]);
  function seek(time: number) { if (onSeek) onSeek(time); else if (!seekWorkspace(host.current, time)) setError("The player is still loading. Try seeking again."); }
  const [selection, setSelection] = useState<{ anchor: number; end: number } | null>(null);
  const dragging = useRef(false), moved = useRef(false);
  const offsets = useMemo(() => pieces.map((_, p) => pieces.slice(0, p).reduce((sum, prior) => sum + prior.displayWords.length, 0)), [pieces]);
  const allWords = pieces.flatMap(piece => piece.displayWords.map(word => ({ ...word, piece: piece.pieceIndex })));
  const selected = (index: number) => !!selection && index >= Math.min(selection.anchor, selection.end) && index <= Math.max(selection.anchor, selection.end);
  useEffect(() => { setSelection(null); setEdit(null); setError(null); }, [source.clipId, source.s, source.e]);
  useEffect(() => {
    const end = () => { dragging.current = false; };
    window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, []);
  const [edit, setEdit] = useState<{ piece: number; first: number; last: number; text: string; typing?: boolean } | null>(null);
  const editingField = useRef(edit); editingField.current = edit;
  const [offer, setOffer] = useState<{ words: Occurrence[]; correction: string } | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null), pending = useRef(false), currentWord = useRef<HTMLSpanElement>(null);
  const activeKey = pieces.flatMap((piece, p) => piece.timedWords.map((word, w) => time >= word.start && time < word.end ? `${p}:${w}` : "")).find(Boolean);
  useEffect(() => { field.current?.focus(); if (edit?.typing) field.current?.setSelectionRange(edit.text.length, edit.text.length); else field.current?.select(); }, [edit?.piece, edit?.first, edit?.last]);
  useEffect(() => { if (!edit && window.getSelection()?.isCollapsed !== false) currentWord.current?.scrollIntoView({ block: "nearest" }); }, [activeKey, edit]);
  const live = useRef({ onChange, onSaving }); live.current = { onChange, onSaving };
  const confirmedShoot = useRef(inputShoot);
  type Job = { clipId: string; fix: { s: number; e: number; text: string }; after: Shoot };
  const queue = useRef<DocumentQueue<Job>>();
  if (!queue.current) queue.current = new DocumentQueue<Job>(async jobs => {
    // Corrections of one source clip share an IPC call. The newest overlapping fix wins.
    const fixes = new Map<string, { s: number; e: number; text: string }[]>();
    for (const job of jobs) {
      const prior = fixes.get(job.clipId) ?? [], overlap = prior.filter(f => f.s < job.fix.e && f.e > job.fix.s);
      if (!overlap.length) { fixes.set(job.clipId, [...prior, job.fix]); continue; }
      const s = Math.min(job.fix.s, ...overlap.map(f => f.s)), e = Math.max(job.fix.e, ...overlap.map(f => f.e));
      const words = job.after.clips.find(clip => clip.id === job.clipId)?.transcript?.flatMap(segment => segment.words).filter(word => word.s < e && word.e > s) ?? [];
      fixes.set(job.clipId, [...prior.filter(f => !overlap.includes(f)), { s, e, text: transcriptText(words.map(word => word.w)) }]);
    }
    for (const [clipId, edits] of fixes) confirmedShoot.current = await getApi().editTranscript(shoot.root, clipId, edits);
  }, cause => {
    setLocalShoot(confirmedShoot.current); live.current.onChange(confirmedShoot.current);
    setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "") : "Couldn't save these words. Try again.");
  }, value => { setSaving(value); live.current.onSaving(value); });
  useEffect(() => () => { void queue.current?.flush(); }, []);
  function begin(piece: number, first: number, last: number, typed?: string) {
    setError(null); setEdit({ piece, first, last, text: typed ?? transcriptText(pieces[piece].displayWords.slice(first, last + 1).filter(word => !word.removed).map(word => word.w)), typing: typed !== undefined });
    window.getSelection()?.removeAllRanges();
  }
  function typeSelection(typed: string): boolean {
    if (!selection) return false;
    const first = Math.min(selection.anchor, selection.end), last = Math.max(selection.anchor, selection.end), word = allWords[first];
    if (!word || word.removed || allWords[last]?.piece !== word.piece) return false;
    const p = pieces.findIndex(piece => piece.pieceIndex === word.piece), offset = pieces.slice(0, p).reduce((sum, piece) => sum + piece.displayWords.length, 0);
    begin(p, first - offset, last - offset, typed); return true;
  }
  function selectWords() {
    if (edit) return;
    const native = window.getSelection();
    if (!native || native.isCollapsed || !native.rangeCount || !host.current) return;
    const range = native.getRangeAt(0);
    if (!host.current.contains(range.startContainer) || !host.current.contains(range.endContainer)) return;
    // Only words the range really covers: intersectsNode also matches words that merely touch its edge.
    const indices = Array.from(host.current.querySelectorAll<HTMLElement>("[data-word-index]")).filter(word => {
      const own = document.createRange(); own.selectNodeContents(word);
      return coversWord(range, own);
    }).map(word => Number(word.dataset.wordIndex));
    if (indices.length) setSelection({ anchor: Math.min(...indices), end: Math.max(...indices) });
  }
  async function save() {
    if (!edit || editingField.current !== edit || !edit.text.trim()) return;
    const piece = pieces[edit.piece], words = piece.displayWords.slice(edit.first, edit.last + 1).filter(word => !word.removed);
    if (!words.length) return;
    const span = { clipId: piece.clipId, s: words[0].s, e: Math.max(...words.map(word => word.e)), text: edit.text.trim() };
    if (transcriptText(words.map(word => word.w)) === span.text) { editingField.current = null; setEdit(null); return; }
    editingField.current = null;
    const next = correctWords(shoot, piece.clipId, span);
    setLocalShoot(next); onChange(next); setEdit(null); setSelection(null); setError(null); setOffer(null);
    queue.current!.add({ clipId: piece.clipId, fix: { s: span.s, e: span.e, text: span.text }, after: next });
    const occurrences = words.length === 1 ? otherOccurrences(next, words[0].w, span.text, span) : [];
    if (occurrences.length) setOffer({ words: occurrences, correction: spelling(span.text) });
  }
  async function fixAll() {
    if (!offer || pending.current) return;
    pending.current = true; setSaving(true); onSaving(true); setError(null);
    try {
      let next = shoot;
      for (const { clipId, s, e, text } of offer.words) {
        const fix = { s, e, text }; next = correctWords(next, clipId, fix); queue.current!.add({ clipId, fix, after: next });
      }
      setLocalShoot(next); onChange(next);
      const prefs = await getApi().getPreferences();
      await getApi().setPreferences({ vocabulary: [...new Set([...(prefs.vocabulary ?? []), offer.correction])] });
      setOffer(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't finish fixing all words. Try again."); }
    finally { pending.current = false; setSaving(false); onSaving(false); }
  }
  return <div ref={host} data-transcript className="space-y-4" aria-busy={saving} tabIndex={-1} onKeyDown={event => {
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    if (selection && event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (typeSelection(event.key)) { event.preventDefault(); event.stopPropagation(); }
    }
    if (event.key === "Escape") { event.stopPropagation(); setSelection(null); }
  }} onMouseUp={selectWords}>
    <p className="text-micro text-muted">Click a word to jump there. Type or double-click to correct.</p>
    {saving ? <span role="status" className="text-micro text-muted">Saving…</span> : null}
    {pieces.map((piece, p) => <div key={`${piece.id}:${p}`} data-transcript-line={p} aria-label={piece.label} className="rounded-lg"><p className="select-text text-[15px] leading-[1.75]">{piece.displayWords.length ? piece.displayWords.map((word, w) => {
        const index = offsets[p] + w;
        if (edit?.piece === p && w > edit.first && w <= edit.last) return null;
        if (edit?.piece === p && w === edit.first) return <span key={w} className="inline-block max-w-full"><input ref={field} aria-label="Correct transcript" value={edit.text} onBlur={() => void save()} onChange={event => setEdit({ ...edit, text: event.target.value })} onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editingField.current = null; setEdit(null); }
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void save(); }
        }} className={`max-w-full rounded-lg bg-ink/[0.07] px-1 ${FOCUS}`} />{" "}</span>;
        const active = time >= word.start && time < word.end;
        function choose(shift: boolean) { setSelection(previous => ({ anchor: shift && previous ? previous.anchor : index, end: index })); }
        return <span key={`${word.s}:${w}`}><span ref={active ? currentWord : undefined} data-edit-word={w} data-word-index={index} role="button" tabIndex={0} aria-label={word.w} aria-current={active ? "true" : undefined}
          title="Click to seek, type or double-click to correct"
          onDoubleClick={() => begin(p, w, w)}
          onPointerDown={event => { if (event.button !== 0) return; host.current?.focus?.({ preventScroll: true }); dragging.current = true; moved.current = false; choose(event.shiftKey); }}
          onPointerEnter={() => { if (dragging.current) { moved.current = true; setSelection(previous => previous ? { ...previous, end: index } : null); } }}
          onClick={event => { if (!moved.current && !event.shiftKey && window.getSelection()?.isCollapsed !== false) seek(word.start); }}
          onKeyDown={event => {
            if (event.key === "F2" || event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault(); event.stopPropagation(); if (event.key === "F2") begin(p, w, w);
              else if (!selected(index) || !typeSelection(event.key)) begin(p, w, w, event.key);
              return;
            }
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); choose(event.shiftKey); if (!event.shiftKey) seek(word.start); }
          }} className={`rounded cursor-text ${selected(index) ? "bg-accent/25" : active ? "bg-accent/15" : "hover:bg-ink/[0.06]"} ${FOCUS}`}>{transcriptText([word.w]) || "…"}</span>{transcriptSeparator(word.w, piece.displayWords[w + 1]?.w)}</span>;
      }) : <span className="text-muted">{spokenFallback(piece.words, shoot.clips.find(clip => clip.id === piece.clipId)?.file) || "No timed words to edit."}</span>}</p>
    </div>)}
    {offer ? <div className="space-y-1 text-micro"><p className="text-micro text-muted">{offer.words.length ? `Use “${offer.correction}” for the same word elsewhere in this shoot?` : "Words corrected. Retry to save the spelling to your vocabulary."}</p><Button type="button" variant="ghost" disabled={saving} onClick={() => void fixAll()}>{offer.words.length ? `Fix all ${offer.words.length}` : "Save spelling"}</Button><Button type="button" variant="ghost" disabled={saving} onClick={() => setOffer(null)}>Dismiss</Button></div> : null}
    {error ? <InlineError className="text-micro text-danger">{error}</InlineError> : null}
  </div>;
}
