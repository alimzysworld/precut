// SCRIPT1: the Script panel. One document of what is said in the edit, camera speech and voiceover in edit order,
// edited like text: click puts the cursor there and moves the playhead, drag or Shift+arrows select across
// paragraphs, double-click selects a word, arrows, Option+arrows and Home/End move as in any editor. Delete cuts;
// cut words stay, struck, until Show cuts is off (then a dot marks each spot); select struck words and Restore puts
// back exactly those. Typing fixes words (captions follow, audio doesn't). One save queue for every kind of word.
import "./script.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CutEdit, CutVersion, Shoot, TitleTrack, VoiceCut } from "../../../../shared/schema";
import { applyVoiceCut, type VoiceTake } from "../../../../shared/voice-edit";
import { heardVoiceWords, placeVoiceWords, retypeVoiceWords, voiceAddedOf, voiceTranscript, withVoiceWordChanges } from "../../../../shared/caption-words";
import { buildCaptionTrack, followEmphasis, DEFAULT_CAPTION_STYLE, type CaptionTrack } from "../../../../main/titles/captions";
import { transcriptSeparator, transcriptText } from "../../../../main/titles/text";
import { buildScript, spellingOnly, takeSpan, type ScriptDoc, type ScriptWord } from "./scriptDoc";
import { correctWords, projectWords, rebaseWords, ScriptQueue } from "./transcriptEdits";
import { otherOccurrences, removableFillerCount, seekWorkspace, transcriptPieces } from "./TranscriptPanel";
import { useTimelinePrefs } from "../timeline/prefs";
import { runShortcut } from "../../hooks/useShortcuts";
import { getApi } from "../../data";
import { readHash } from "../../nav";
import { ScriptRecording, LineEditor, type VoiceoverController } from "../VoiceoverPanel";
import { playSpans, stopAudition } from "../planAudio";
import { voiceSource } from "../voiceoverModel";
import { Button, InlineError } from "../ui";
import { Pause, Play, Voice } from "../icons";

type Point = { w: number; o: number };
type Sel = { a: Point; f: Point };
type Draft = { first: number; last: number; text: string; caret: number; end?: number };
type Occurrence = { clipId: string; s: number; e: number; text: string };
const SHOW_CUTS = "precut.script.show-cuts";
const readShowCuts = () => { try { return globalThis.localStorage?.getItem(SHOW_CUTS) !== "0"; } catch { return true; } };
const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "") : fallback;
const before = (p: Point, q: Point) => p.w < q.w || p.w === q.w && p.o < q.o;
const isLocal = (id: string | undefined) => !!id && /(^|-)local-/.test(id);
const spelling = (value: string) => value.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** The word indices a selection covers: every word with at least one character inside it. */
export function coveredWords(doc: ScriptDoc, sel: Sel | null, shown: (i: number) => boolean = () => true): number[] {
  if (!sel) return [];
  const [p, q] = before(sel.f, sel.a) ? [sel.f, sel.a] : [sel.a, sel.f];
  if (p.w === q.w && p.o === q.o) return [];
  const out: number[] = [];
  for (let i = p.w; i <= q.w && i < doc.words.length; i++) {
    const length = doc.words[i].text.length;
    if (i === p.w && p.o >= length && i !== q.w) continue;
    if (i === q.w && q.o <= 0 && i !== p.w) continue;
    if (shown(i)) out.push(i);
  }
  return out;
}

export function ScriptPanel({ shoot: inputShoot, version: savedVersion, time = 0, voice, range, scrollTo, fixRange, onChange = () => {}, onSaving = () => {}, onSeek, onTogglePlay }: {
  shoot: Shoot; version: CutVersion; time?: number; voice?: VoiceoverController;
  /** The caption line view: only the words that play inside this reel range. */
  range?: { s: number; e: number };
  scrollTo?: { s: number; e: number }; fixRange?: { s: number; e: number; key: number };
  onChange?: (shoot: Shoot) => void; onSaving?: (value: boolean) => void; onSeek?: (time: number) => void; onTogglePlay?: () => void;
}) {
  const owner = useRef({ root: inputShoot.root, cutId: readHash().params.cut });
  const [localShoot, setLocalShoot] = useState<Shoot | null>(null);
  const shoot = localShoot ?? inputShoot;
  const [localVersion, setLocalVersion] = useState<CutVersion | null>(null);
  const version = localVersion ?? savedVersion;
  const [showCuts, setShowCuts] = useState(readShowCuts);
  const [changed, setChanged] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [dots, setDots] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const [offer, setOffer] = useState<{ words: Occurrence[]; correction: string } | null>(null);
  const [bleepMenu, setBleepMenu] = useState(false), [viewer, setViewer] = useState(false), [playing, setPlaying] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null), caretAfter = useRef<Point | null>(null), lastKey = useRef(0), pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout>>(), listening = useRef(0), activeIndex = useRef(-1);
  const { closeGaps } = useTimelinePrefs();
  const takes = useMemo(() => {
    const own = (shoot.audio ?? []).filter(a => a.role === "voiceover"), fresh = voice?.takes ?? [];
    return [...fresh, ...own.filter(a => !fresh.some(f => f.file === a.file))];
  }, [shoot.audio, voice?.takes]);
  const doc = useMemo(() => buildScript(shoot, version, { takes, script: range ? null : voice?.script, changedCamera: changed, range }), [shoot, version, takes, voice?.script, changed, range?.s, range?.e]);
  const docRef = useRef(doc); docRef.current = doc;
  const draftRef = useRef(draft); draftRef.current = draft;
  const shown = (i: number) => showCuts || !doc.words[i]?.cut;
  const selected = useMemo(() => dots ?? coveredWords(doc, sel, shown), [doc, sel, dots, showCuts]);
  const selectedCut = selected.filter(i => doc.words[i].cut || doc.words[i].hidden);
  const selectedLive = selected.filter(i => !doc.words[i].cut);

  // ------------------------------------------------------------------ saving
  const takeOf = (file: string): VoiceTake | undefined => {
    const take = takes.find(t => t.file === file);
    return take ? { file: take.file, durationS: take.durationS, words: (take.transcript ?? []).flatMap(s => s.words).filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s).sort((a, b) => a.s - b.s) } : undefined;
  };
  const projectVoice = (base: CutVersion, edit: CutEdit): CutVersion => {
    const result = applyVoiceCut(base.voiceover?.lines ?? [], (base.voiceCuts ?? []) as VoiceCut[], edit as never, takeOf, () => `local-${Math.random().toString(36).slice(2, 10)}`);
    const script = base.voiceover ?? ({ cutId: owner.current.cutId ?? "", version: base.version, wordsPerSecond: 2.5, packet: null, moments: null } as unknown as NonNullable<CutVersion["voiceover"]>);
    return { ...base, voiceover: { ...script, lines: result.lines }, voiceCuts: result.cuts };
  };
  const live = useRef({ shoot, version, onChange, onSaving }); live.current = { shoot, version, onChange, onSaving };
  const confirmedShoot = useRef(inputShoot);
  const stagePreview = useRef<{ detail: { root: string; cutId?: string; version: CutVersion | null }; queued: boolean }>();
  // The strike paints on the keypress; the stage, timeline and captions follow a frame later.
  function publish(next: CutVersion | null) {
    setLocalVersion(next);
    if (typeof CustomEvent === "undefined") return;
    const pending = stagePreview.current;
    stagePreview.current = { detail: { root: owner.current.root, cutId: owner.current.cutId, version: next }, queued: true };
    if (pending?.queued) return;
    const send = () => { const latest = stagePreview.current; if (!latest?.queued) return; latest.queued = false; window.dispatchEvent(new CustomEvent("sidething:transcript-preview", { detail: latest.detail })); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(send, 0)); else setTimeout(send, 0);
  }
  const queue = useRef<ScriptQueue>();
  if (!queue.current) queue.current = new ScriptQueue(savedVersion, {
    save: async (edit, base) => {
      const { root, cutId } = owner.current;
      if (!cutId) throw new Error("Open an edit before editing its script.");
      const api = getApi();
      const next = await api.editCut(root, cutId, base, edit, { snapshot: true });
      const whole = next.snapshot?.version === next.version ? next.snapshot : await api.loadCutVersion?.(root, next.cutId, next.version)
        ?? (await api.listCuts(root)).find(c => c.cutId === next.cutId)?.versions.find(v => v.version === next.version && !v.light);
      const { selectSidekickCut } = await import("../SidekickChat");
      const current = readHash().params;
      if (current.cut === cutId && (!current.shoot || current.shoot === root)) selectSidekickCut(root, next);
      return whole ? { ...whole, version: next.version } : { ...live.current.version, version: next.version };
    },
    fix: async (clipId, fixes) => (confirmedShoot.current = await getApi().editTranscript(owner.current.root, clipId, fixes)),
    saved: () => {},
    failed: cause => {
      publish(null); setLocalShoot(confirmedShoot.current); live.current.onChange(confirmedShoot.current);
      setError(message(cause, "Couldn't save these words. Try again."));
    },
    busy: value => { setSaving(value); live.current.onSaving(value); if (!value) setNote(prior => prior === "Listening again…" ? null : prior); },
    text: transcriptText,
    latest: async () => {
      const { root, cutId } = owner.current, api = getApi();
      if (!cutId || !api.revisionState || !api.loadCutVersion) return null;
      const { version } = await api.revisionState(root, cutId);
      return await api.loadCutVersion(root, cutId, version);
    },
  });
  useEffect(() => () => { void queue.current?.flush(); stopAudition(); }, []);
  // A save lands as a new version through props. Once the queue is idle and the saved version is on screen, the
  // document is the saved one again; any other version (Undo, another panel) replaces it.
  const seen = useRef(savedVersion.version);
  useEffect(() => {
    const q = queue.current!;
    if (!q.idle) return;
    if (savedVersion.version !== q.confirmed.version && seen.current !== savedVersion.version) { q.confirmed = savedVersion; }
    seen.current = savedVersion.version;
    if (q.confirmed.version === savedVersion.version && localVersion) publish(null);
  }, [savedVersion.version, saving]);
  useEffect(() => { if (queue.current!.idle && localShoot) setLocalShoot(null); }, [inputShoot]);

  function apply(next: CutVersion) {
    // Camera cuts rebuild the caption track at once, as the saved version will.
    if (next.titles && next.pieces !== version.pieces) {
      const prior = next.titles as CaptionTrack;
      const words = transcriptPieces(shoot, next).flatMap((piece, index) => piece.timedWords.map(word => ({ text: word.w, s: word.start, e: word.end, piece: index })));
      const captionSource = prior.captionSource ? { ...prior.captionSource, words } : undefined;
      if (!next.voiceover?.lines.some(l => l.take)) next = { ...next, titles: buildCaptionTrack(words, { ...prior, emphasis: followEmphasis(prior, words), captionSource } as CaptionTrack, prior.captionStyle ?? DEFAULT_CAPTION_STYLE, captionSource?.safeArea, next.bigLines) };
    }
    publish(next); setError(null);
  }
  function editJob(label: string, edit: CutEdit, from: CutVersion, kind: "camera" | "voice" | "other", place?: (draft: CutVersion) => CutEdit | null) {
    queue.current!.add({ kind: "edit", label, group: kind === "camera" ? "picture" : "voice", project: kind === "camera" ? (draft, e) => projectWords(live.current.shoot, draft, e) : kind === "voice" ? projectVoice : undefined,
      build: draft => {
        if (place) return place(draft) ?? "wait";
        if (kind === "camera") {
          const rebased = rebaseWords(edit, from, draft);
          return rebased.kind === "restoreWords" && isLocal(rebased.cut) ? "wait" : rebased;
        }
        if (edit.kind === "voiceover" && (edit as unknown as { op: string }).op === "restoreCut") {
          const ask = edit as unknown as { cut: string; s?: number; e?: number };
          const was = (from.voiceCuts ?? []).find(c => c.id === ask.cut), cuts = draft.voiceCuts ?? [];
          const now = cuts.find(c => c.id === ask.cut) ?? (was ? cuts.find(c => c.file === was.file && c.s < was.e && c.e > was.s) : undefined);
          if (!now) return "wait";
          if (isLocal(now.id)) return "wait";
          return { ...edit, cut: now.id } as unknown as CutEdit;
        }
        return edit;
      } });
  }

  // ------------------------------------------------------------------ editing
  /** invert: Shift+Delete, the opposite of Close gaps for voice (as on the lane). */
  function cutWords(indices: number[], invert = false) {
    const words = indices.map(i => doc.words[i]).filter(w => !w.cut && !w.hidden);
    if (!words.length) return;
    if (!owner.current.cutId) { setError("Open an edit before editing its script."); return; }
    let next = version;
    const camera = words.filter(w => w.kind === "camera" && w.piece !== undefined);
    if (camera.length) {
      const spans = new Map<number, { piece: number; s: number; e: number }>();
      for (const w of camera) { const span = spans.get(w.piece!); spans.set(w.piece!, { piece: w.piece!, s: Math.min(span?.s ?? w.s!, w.s!), e: Math.max(span?.e ?? w.e!, w.e!) }); }
      // Every word of a piece left: the whole piece, so it is kept as a cut piece, exactly.
      if (!range) for (const span of spans.values()) {
        const rest = doc.words.filter(w => w.kind === "camera" && w.piece === span.piece && !w.cut);
        const piece = version.pieces?.[span.piece];
        if (piece && rest.every(w => camera.includes(w))) Object.assign(span, { s: Math.min(piece.s, span.s), e: Math.max(piece.e, span.e) });
      }
      const edit: CutEdit = { kind: "cutWords", spans: [...spans.values()] };
      try { const projected = projectWords(shoot, next, edit); editJob("Cut words", edit, next, "camera"); next = projected; }
      catch (cause) { setError(message(cause, "Couldn't cut these words.")); return; }
    }
    // Voiceover words: each run of them is one cut on the lane, kept struck.
    const chosenVoice = new Set(words.filter(w => w.kind === "voice")), runs: ScriptWord[][] = [];
    let open = false;
    for (const w of doc.words.filter(x => x.kind === "voice" && !x.cut).sort((a, b) => a.start - b.start)) {
      if (!chosenVoice.has(w)) { open = false; continue; }
      const prior = runs.at(-1)?.at(-1);
      if (open && prior && prior.occurrence === w.occurrence && prior.file === w.file) runs.at(-1)!.push(w); else { runs.push([w]); open = true; }
    }
    for (const run of runs.reverse()) {
      // By take time and placement, so a picture edit saved meanwhile (which moves the voice with it) can't shift
      // the cut onto other words: the reel times are read from the version the cut is saved against.
      const take = { file: run[0].file!, occurrence: run[0].occurrence!, s: Math.min(...run.map(w => w.sourceS!)), e: Math.max(...run.map(w => w.sourceE!)) };
      const place = (base: CutVersion): CutEdit | null => {
        const lines = (base.voiceover?.lines ?? []).filter(l => l.take?.file === take.file && (l.occurrence ?? l.id) === take.occurrence);
        const at = (t: number, side: "s" | "e") => { const l = lines.find(l => l.take!.s - 1e-6 <= t && t <= l.take!.e + 1e-6 && (side === "s" ? t < l.take!.e - 1e-6 : t > l.take!.s + 1e-6)); return l ? l.s + t - l.take!.s : null; };
        const s = at(take.s, "s"), e = at(take.e, "e");
        return s === null || e === null || e <= s ? null : { kind: "voiceover", op: "cutWords", s, e, close: closeGaps !== invert } as unknown as CutEdit;
      };
      const edit = place(next);
      if (!edit) { setError("Those words have changed. Select them again."); return; }
      try { const projected = projectVoice(next, edit); editJob("Cut voiceover words", edit, next, "voice", place); next = projected; }
      catch (cause) { setError(message(cause, "Couldn't cut these words.")); return; }
    }
    apply(next);
    const last = Math.max(...indices), after = doc.words.findIndex((w, i) => i > last && !w.cut);
    caretAfter.current = after >= 0 ? { w: after, o: 0 } : { w: last, o: doc.words[last].text.length };
    setSel(null); setDots(null);
  }
  function restoreWords(indices: number[]) {
    const words = indices.map(i => doc.words[i]);
    let next = version;
    // Words left out of the captions by typing come back into them.
    const hidden = words.filter(w => w.hidden && !w.cut);
    if (hidden.length) fixVoice(hidden.map(w => ({ word: w.id!, text: w.spoken })), [], "Putting words back…");
    const groups = new Map<string, ScriptWord[]>();
    for (const w of words.filter(w => w.cut)) {
      const key = w.kind === "voice" ? `v:${w.voiceCut}` : `c:${w.tomb ?? w.piece}:${w.marker?.s}`;
      groups.set(key, [...groups.get(key) ?? [], w]);
    }
    for (const list of groups.values()) {
      const w = list[0];
      if (w.kind === "voice") {
        const all = doc.words.filter(x => x.voiceCut === w.voiceCut), span = list.length < all.length ? takeSpan(list) : null;
        const edit = { kind: "voiceover", op: "restoreCut", cut: w.voiceCut, ...(span ? span : {}) } as unknown as CutEdit;
        try { const projected = projectVoice(next, edit); editJob("Put back voiceover words", edit, next, "voice"); next = projected; }
        catch (cause) { setError(message(cause, "Couldn't put these words back.")); return; }
        continue;
      }
      if (!w.marker) continue;
      const all = doc.words.filter(x => x.kind === "camera" && x.cut && (x.tomb ?? x.piece) === (w.tomb ?? w.piece) && x.marker?.s === w.marker!.s);
      const partial = list.length < all.length && w.marker.kind === "cut";
      const tomb = w.tomb ? (version.cutPieces ?? []).find(t => t.id === w.tomb) : undefined;
      const edit: CutEdit = { kind: "restoreWords", piece: tomb ? tomb.at : w.piece!, at: w.marker.s,
        ...(partial ? { s: Math.min(...list.map(x => x.s!)), e: Math.max(...list.map(x => x.e!)) } : {}), ...(tomb ? { cut: tomb.id } : {}) };
      try { const projected = projectWords(shoot, next, edit); editJob("Put back words", edit, next, "camera"); next = projected; }
      catch (cause) { setError(message(cause, "Couldn't put these words back.")); return; }
    }
    if (next !== version) apply(next);
    setDots(null);
  }
  function fixVoice(fix: { word: string; text: string }[], add: NonNullable<Extract<CutEdit, { kind: "voiceWords" }>["add"]>, label: string) {
    const track = version.titles, lines = version.voiceover?.lines ?? [];
    const takeSource = (file: string) => takes.find(t => t.file === file);
    try {
      let added = voiceAddedOf(track);
      for (const a of add) added = [...added, ...placeVoiceWords(lines, heardVoiceWords(lines, takeSource, added).words, a.text, a, () => `local-${Math.random().toString(36).slice(2)}`)];
      const heard = voiceTranscript(lines, takeSource, track);
      if (track) publish({ ...version, titles: withVoiceWordChanges(track as TitleTrack, heard, fix, added) });
      editJob(label, { kind: "voiceWords", ...(fix.length ? { fix } : {}), ...(add.length ? { add } : {}) }, version, "other");
    } catch (cause) { setError(message(cause, "Couldn't place those words.")); }
  }
  function commit(keepCaret = false) {
    const d = draftRef.current;
    if (!d) return;
    draftRef.current = null; setDraft(null);
    const chosen = docRef.current.words.slice(d.first, d.last + 1).filter(w => !w.cut);
    const typed = d.text.trim().replace(/\s+/gu, " "), was = transcriptText(chosen.map(w => w.text));
    if (!chosen.length || !typed || typed === was) return;
    const first = chosen[0];
    if (keepCaret) caretAfter.current = { w: d.first, o: 0 };
    if (first.kind === "camera") {
      const span = { clipId: first.clipId!, s: first.s!, e: Math.max(...chosen.map(w => w.e!)), text: typed };
      const corrected = correctWords(shoot, span.clipId, span);
      setLocalShoot(corrected); onChange(corrected); setError(null); setOffer(null);
      if (!spellingOnly(was, typed)) setChanged(prior => new Set([...prior, `${span.clipId}:${span.s}`]));
      queue.current!.add({ kind: "fix", clipId: span.clipId, fix: { s: span.s, e: span.e, text: span.text }, after: corrected });
      const others = chosen.length === 1 ? otherOccurrences(corrected, chosen[0].spoken, typed, span) : [];
      if (others.length) setOffer({ words: others, correction: spelling(typed) });
      return;
    }
    const { fix, add } = retypeVoiceWords(chosen.map(w => ({ id: w.id!, occurrence: w.occurrence!, text: w.text })), typed);
    if (fix.length || add.length) fixVoice(fix, add, add.length ? "Adding words…" : "Fixing words…");
  }
  async function fixAll() {
    if (!offer) return;
    let next = shoot;
    for (const { clipId, s, e, text } of offer.words) { const fix = { s, e, text }; next = correctWords(next, clipId, fix); queue.current!.add({ kind: "fix", clipId, fix, after: next }); }
    setLocalShoot(next); onChange(next);
    try {
      const prefs = await getApi().getPreferences();
      await getApi().setPreferences({ vocabulary: [...new Set([...(prefs.vocabulary ?? []), offer.correction])] });
      setOffer(null);
    } catch (cause) { setError(message(cause, "Couldn't finish fixing all words. Try again.")); }
  }
  function bleep(sound: "beep" | "mute" | null) {
    const spans = selectedLive.map(i => doc.words[i]).filter(w => w.kind === "camera" && w.piece !== undefined).map(w => ({ piece: w.piece!, s: w.s!, e: w.e! }));
    setBleepMenu(false);
    if (spans.length) editJob(sound ? "Bleep words" : "Remove bleep", { kind: "bleep", spans, sound }, version, "camera");
  }
  const fillers = useMemo(() => range ? 0 : removableFillerCount(shoot, version), [shoot, version, range]);
  async function undo(redo: boolean) {
    commit();
    await queue.current!.flush();
    runShortcut(redo ? "redo" : "undo", "precuts");
  }

  // ------------------------------------------------------------------ the text surface
  const seek = (at: number) => { if (onSeek) onSeek(at); else if (!seekWorkspace(host.current, at)) setError("The player is still loading. Try seeking again."); };
  const textNode = (w: number): Node | null => host.current?.querySelector?.(`[data-w="${w}"]`)?.firstChild ?? null;
  /** A DOM position as a word and a character offset in it. Between words it belongs to the end of the word before. */
  function pointOf(node: Node | null, offset: number): Point | null {
    const root = host.current;
    if (!node || !root || !root.contains(node)) return null;
    const element = (node.nodeType === 3 ? node.parentElement : node as Element);
    const draftSpan = element?.closest?.("[data-draft]");
    if (draftSpan && draftRef.current) return { w: draftRef.current.first, o: node.nodeType === 3 ? offset : 0 };
    const span = element?.closest?.("[data-w]") as HTMLElement | null;
    if (span) { const w = Number(span.dataset.w); return { w, o: node.nodeType === 3 ? Math.min(offset, docRef.current.words[w]?.text.length ?? 0) : offset ? docRef.current.words[w]?.text.length ?? 0 : 0 }; }
    // Between spans: the nearest word before, by document position.
    const spans = Array.from(root.querySelectorAll<HTMLElement>("[data-w]"));
    if (!spans.length) return null;
    const probe = document.createRange(); probe.setStart(node, offset);
    let lo = 0, hi = spans.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, r = document.createRange(); r.selectNodeContents(spans[mid]);
      if (r.compareBoundaryPoints(Range.END_TO_START, probe) <= 0) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0) return { w: Number(spans[0].dataset.w), o: 0 };
    const w = Number(spans[found].dataset.w);
    return { w, o: docRef.current.words[w]?.text.length ?? 0 };
  }
  function readSelection(): Sel | null {
    const native = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (!native || !native.rangeCount || !host.current?.contains?.(native.anchorNode)) return null;
    const a = pointOf(native.anchorNode, native.anchorOffset), f = pointOf(native.focusNode, native.focusOffset);
    return a && f ? { a, f } : null;
  }
  function place(p: Point, q: Point = p) {
    const root = host.current, native = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (!root || !native) return;
    const at = (point: Point): [Node, number] | null => {
      if (draftRef.current && point.w === draftRef.current.first) { const n = root.querySelector("[data-draft]")?.firstChild; if (n) return [n, Math.min(point.o, n.textContent?.length ?? 0)]; }
      const n = textNode(point.w); if (n) return [n, Math.min(point.o, n.textContent?.length ?? 0)];
      const any = Array.from(root.querySelectorAll<HTMLElement>("[data-w]")).find(s => Number(s.dataset.w) >= point.w);
      return any?.firstChild ? [any.firstChild, 0] : null;
    };
    const from = at(p), to = at(q);
    if (!from || !to) return;
    if (native.anchorNode === from[0] && native.anchorOffset === from[1] && native.focusNode === to[0] && native.focusOffset === to[1]) return;
    native.setBaseAndExtent(from[0], from[1], to[0], to[1]);
  }
  // The selection follows the DOM: the native caret, drag, Shift+arrows, double-click and Option+arrows all work.
  const onSelection = () => {
    const next = readSelection();
    if (!next) return;
    const d = draftRef.current, inDraft = !!host.current?.querySelector?.("[data-draft]")?.contains(typeof window !== "undefined" ? window.getSelection?.()?.focusNode ?? null : null);
    if (d && !inDraft) { commit(); caretAfter.current = null; }
    else if (d) {
      const caret = next.f.o, end = next.a.o === caret ? undefined : next.a.o;
      if (caret !== d.caret || end !== d.end) setDraft(prior => prior && { ...prior, caret, end });
      return;
    }
    setSel(prior => prior && prior.a.w === next.a.w && prior.a.o === next.a.o && prior.f.w === next.f.w && prior.f.o === next.f.o ? prior : next); setDots(null);
    // The playhead follows the cursor as it moves by keys, as it does on a click.
    if (next.a.w === next.f.w && next.a.o === next.f.o && Date.now() - lastKey.current < 400) {
      clearTimeout(seekTimer.current); seekTimer.current = setTimeout(() => seek(docRef.current.words[next.f.w]?.start ?? 0), 120);
    }
  };
  const handlers = useRef(onSelection); handlers.current = onSelection;
  useEffect(() => {
    if (typeof document === "undefined" || !document.addEventListener) return;
    const changed = () => handlers.current();
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);
  // Text input never edits the DOM directly: every change goes through the document, so React owns the text.
  useEffect(() => {
    const root = host.current;
    if (!root?.addEventListener) return;
    const input = (event: InputEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.("textarea, input, select")) return;
      event.preventDefault();
      if (event.inputType === "insertText" && event.data) type(event.data);
      else if (event.inputType === "historyUndo" || event.inputType === "historyRedo") void undo(event.inputType === "historyRedo");
      else if (event.inputType.startsWith("delete") && !draftRef.current) cutWords(selectedNow());
    };
    root.addEventListener("beforeinput", input as EventListener);
    return () => root.removeEventListener("beforeinput", input as EventListener);
  });
  // After a cut or a fix the caret goes where the next words start.
  useLayoutEffect(() => {
    const d = draft;
    if (d) { place({ w: d.first, o: d.end ?? d.caret }, { w: d.first, o: d.caret }); return; }
    if (caretAfter.current) { const p = caretAfter.current; caretAfter.current = null; place(p); }
  });
  const selectedNow = () => dots ?? coveredWords(docRef.current, readSelection() ?? sel, shown);
  function type(text: string) {
    const d = draftRef.current;
    if (d) {
      const from = Math.min(d.caret, d.end ?? d.caret), to = Math.max(d.caret, d.end ?? d.caret);
      setDraft({ ...d, text: d.text.slice(0, from) + text + d.text.slice(to), caret: from + text.length, end: undefined });
      return;
    }
    if (text === " ") return;
    const current = readSelection() ?? sel, list = coveredWords(doc, current, shown);
    if (list.length) {
      const words = list.map(i => doc.words[i]), liveWords = list.filter(i => !doc.words[i].cut);
      if (!liveWords.length) return;
      if (new Set(words.map(w => w.block)).size > 1) { setNote("Type over words in one line at a time."); return; }
      if (liveWords.some((i, k) => k && doc.words.slice(liveWords[k - 1] + 1, i).some(w => w.cut))) { setNote("Type over words that are not cut."); return; }
      setNote(null); setDraft({ first: liveWords[0], last: liveWords.at(-1)!, text, caret: text.length });
      return;
    }
    const p = current?.f;
    if (!p) return;
    let w = p.w, o = p.o;
    if (doc.words[w]?.cut) {
      const back = doc.words.slice(0, w).map((x, i) => ({ x, i })).reverse().find(({ x }) => !x.cut && x.block === doc.words[w].block);
      const ahead = doc.words.findIndex((x, i) => i > w && !x.cut && x.block === doc.words[w].block);
      if (back) { w = back.i; o = back.x.text.length; } else if (ahead >= 0) { w = ahead; o = 0; } else return;
    }
    const word = doc.words[w]; if (!word) return;
    setNote(null); setDraft({ first: w, last: w, text: word.text.slice(0, o) + text + word.text.slice(o), caret: o + text.length });
  }
  function erase(forward: boolean, invert = false) {
    const d = draftRef.current;
    if (d) {
      const from = Math.min(d.caret, d.end ?? d.caret), to = Math.max(d.caret, d.end ?? d.caret);
      if (from !== to) { setDraft({ ...d, text: d.text.slice(0, from) + d.text.slice(to), caret: from, end: undefined }); return; }
      if (forward) setDraft({ ...d, text: d.text.slice(0, from) + d.text.slice(from + 1), end: undefined });
      else if (from > 0) setDraft({ ...d, text: d.text.slice(0, from - 1) + d.text.slice(from), caret: from - 1, end: undefined });
      return;
    }
    const list = selectedNow();
    if (list.length) { cutWords(list, invert); return; }
    // A cursor between words: Backspace cuts the word before it, Delete the word after, as in Descript.
    const p = (readSelection() ?? sel)?.f; if (!p) return;
    const words = doc.words;
    const target = forward ? words.findIndex((w, i) => (i > p.w || i === p.w && p.o < w.text.length) && !w.cut && shown(i))
      : [...words.keys()].reverse().find(i => (i < p.w || i === p.w && p.o > 0) && !words[i].cut && shown(i)) ?? -1;
    if (target >= 0) cutWords([target], invert);
  }
  function onKeyDown(event: React.KeyboardEvent) {
    // A script line's own text field and the buttons inside the document keep their keys.
    if ((event.target as HTMLElement | null)?.closest?.("textarea, input, select, button")) return;
    if ((event.nativeEvent as KeyboardEvent).isComposing) return;
    const key = event.key, meta = event.metaKey || event.ctrlKey;
    lastKey.current = Date.now();
    if (meta && key.toLowerCase() === "z") { event.preventDefault(); event.stopPropagation(); void undo(event.shiftKey); return; }
    if (meta && (key.toLowerCase() === "x" || key.toLowerCase() === "v")) { event.preventDefault(); setNote(key.toLowerCase() === "x" ? "Moving words comes later. Delete cuts them." : "Pasting comes later. Type to fix a word."); return; }
    if (meta) return;
    if (key === "Escape") {
      if (draftRef.current) { event.preventDefault(); event.stopPropagation(); setDraft(null); caretAfter.current = { w: draftRef.current.first, o: 0 }; return; }
      if (selected.length || bleepMenu) { event.preventDefault(); event.stopPropagation(); setDots(null); setBleepMenu(false); const p = (readSelection() ?? sel)?.f; if (p) place(p); return; }
      host.current?.blur?.(); return;
    }
    // Home and End go to the start and end of the line, as in a document (Shift extends), not scroll the panel.
    if ((key === "Home" || key === "End") && !draftRef.current) {
      const native = typeof window !== "undefined" ? window.getSelection?.() as (Selection & { modify?: (a: string, d: string, g: string) => void }) | null : null;
      if (native?.modify) { event.preventDefault(); native.modify(event.shiftKey ? "extend" : "move", key === "Home" ? "backward" : "forward", "lineboundary"); }
      return;
    }
    if (key === "Enter") { event.preventDefault(); commit(true); return; }
    if (key === "Tab") { commit(); return; }
    if (key === "Backspace" || key === "Delete") { event.preventDefault(); event.stopPropagation(); erase(key === "Delete", event.shiftKey); return; }
    if (key === " " && !draftRef.current) { event.preventDefault(); onTogglePlay?.(); return; }
    if (key.length === 1) { event.preventDefault(); event.stopPropagation(); type(key); return; }
  }
  function onMouseDown(event: React.MouseEvent) {
    if ((event.target as HTMLElement | null)?.closest?.("textarea, input, select, button")) { pointer.current = null; return; }
    pointer.current = { x: event.clientX, y: event.clientY, moved: false };
    const dot = (event.target as HTMLElement).closest?.("[data-dot]") as HTMLElement | null;
    if (dot) { event.preventDefault(); chooseDot(dot); }
  }
  function onMouseMove(event: React.MouseEvent) { const p = pointer.current; if (p && Math.hypot(event.clientX - p.x, event.clientY - p.y) > 3) p.moved = true; }
  function onMouseUp() {
    const p = pointer.current; pointer.current = null;
    if (!p || p.moved) return;
    const now = readSelection();
    if (now && now.a.w === now.f.w && now.a.o === now.f.o) seek(doc.words[now.f.w]?.start ?? 0);
  }
  function chooseDot(dot: HTMLElement) {
    const first = Number(dot.dataset.dot), last = Number(dot.dataset.dotEnd);
    setDots(Array.from({ length: last - first + 1 }, (_, k) => first + k));
    seek(doc.words[first]?.start ?? 0);
  }
  // The word being heard lights up as it plays, with no render.
  useEffect(() => {
    const root = host.current;
    if (!root?.querySelector) return;
    let at = -1;
    for (let i = 0; i < doc.words.length; i++) { const w = doc.words[i]; if (!w.cut && time >= w.start && time < w.end) { at = i; break; } }
    const old = activeIndex.current >= 0 ? root.querySelector(`[data-w="${activeIndex.current}"]`) : null;
    old?.classList.remove("script-now");
    activeIndex.current = at;
    const span = at >= 0 ? root.querySelector<HTMLElement>(`[data-w="${at}"]`) : null;
    span?.classList.add("script-now");
    const native = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (span && !draftRef.current && (!native || native.isCollapsed) && document.activeElement !== root) span.scrollIntoView?.({ block: "nearest" });
  }, [time, doc, showCuts]);
  // A caption's words, opened from the stage or Captions, are selected ready to fix; a caption target scrolls there.
  useEffect(() => {
    if (!fixRange) return;
    const inside = doc.words.map((w, i) => !w.cut && w.start < fixRange.e - 1e-6 && w.end > fixRange.s + 1e-6 ? i : -1).filter(i => i >= 0);
    if (!inside.length) return;
    host.current?.focus?.({ preventScroll: true });
    place({ w: inside[0], o: 0 }, { w: inside.at(-1)!, o: doc.words[inside.at(-1)!].text.length });
    setSel({ a: { w: inside[0], o: 0 }, f: { w: inside.at(-1)!, o: doc.words[inside.at(-1)!].text.length } });
  }, [fixRange?.key]);
  useEffect(() => {
    if (!scrollTo) return;
    const at = doc.words.findIndex(w => !w.cut && w.start < scrollTo.e && w.end > scrollTo.s);
    if (at >= 0) host.current?.querySelector?.(`[data-w="${at}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [scrollTo, doc]);
  useEffect(() => { try { globalThis.localStorage?.setItem(SHOW_CUTS, showCuts ? "1" : "0"); } catch { /* per viewer only */ } }, [showCuts]);

  // ------------------------------------------------------------------ voice paragraph actions
  async function play(block: ScriptDoc["blocks"][number]) {
    const key = block.key, turn = ++listening.current;
    stopAudition();
    if (playing === key) { setPlaying(null); return; }
    const lines = (version.voiceover?.lines ?? []).filter(l => block.lines?.includes(l.id) && l.take).sort((a, b) => a.s - b.s);
    if (!lines.length) return;
    const file = lines[0].take!.file;
    setPlaying(key);
    try {
      const played = await playSpans(voiceSource(shoot.root, file), lines.filter(l => l.take!.file === file).map(l => ({ s: l.take!.s, e: l.take!.e })));
      if (turn !== listening.current) { played.stop(); return; }
      void played.ended.then(() => { if (turn === listening.current) setPlaying(null); });
    } catch { if (turn === listening.current) { setPlaying(null); setError("Couldn't play that voiceover. Check the drive is connected."); } }
  }
  const scriptIds = new Set(voice?.script?.lines.map(l => l.id) ?? []);
  function redo(block: ScriptDoc["blocks"][number]) {
    const ids = (block.lines ?? []).filter(id => scriptIds.has(id));
    if (!ids.length || !voice) return;
    stopAudition(); setPlaying(null); void voice.start(ids);
  }

  // ------------------------------------------------------------------ render
  const words = useMemo(() => {
    const d = draft;
    return doc.blocks.map((block, b) => {
      if (block.kind === "broll") return <p key={block.key} contentEditable={false} data-script-broll className="script-broll">{block.label}</p>;
      if (block.kind === "draft") return <div key={block.key} contentEditable={false} data-script-block={b} data-kind="draft" className="script-para script-voice script-draft">
        <div className="script-who"><Voice size={14} /><span>{block.label}</span></div>
        {voice ? <LineEditor label={`Script line ${(voice.script?.lines.findIndex(l => l.id === block.draft!.id) ?? 0) + 1}`} text={block.draft!.text} disabled={voice.loadingScript || !!voice.prompt || !!voice.working}
          onChange={text => voice.edit(block.draft!.id, text)} onBlur={() => { void voice.save(block.draft!.id).catch(() => {}); }} /> : <p className="script-line">{block.draft!.text}</p>}
        {voice ? <div className="script-tools"><button type="button" className="script-chip" disabled={!!voice.prompt || !!voice.working || !voice.device} onClick={() => { stopAudition(); setPlaying(null); void voice.start(block.draft!.id); }}>Record this line</button></div> : null}
      </div>;
      const voiceBlock = block.kind === "voice", redoable = voiceBlock && (block.lines ?? []).some(id => scriptIds.has(id));
      const items: React.ReactNode[] = [];
      let hiddenRun: number[] = [];
      const flush = (key: string) => {
        if (!hiddenRun.length) return;
        const first = hiddenRun[0], last = hiddenRun.at(-1)!, chosen = !!dots && dots[0] === first;
        items.push(<span key={`dot-${key}`} contentEditable={false} data-dot={first} data-dot-end={last} role="button" tabIndex={0} aria-pressed={chosen}
          aria-label={`${hiddenRun.length} cut ${hiddenRun.length === 1 ? "word" : "words"}: ${hiddenRun.map(i => doc.words[i].text).join(" ")}. Select to restore`}
          title={`Cut: ${hiddenRun.map(i => doc.words[i].text).join(" ")}`} className={`script-dot ${chosen ? "script-dot-on" : ""}`}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); chooseDot(event.currentTarget); } }} />);
        hiddenRun = [];
      };
      block.words.forEach((i, k) => {
        const w = doc.words[i];
        if (d && i > d.first && i <= d.last) return;
        if (d && i === d.first) { items.push(<span key={`draft-${i}`} data-draft className="w script-typing">{d.text || "​"}</span>, " "); return; }
        if (w.cut && !showCuts) { hiddenRun.push(i); return; }
        flush(String(i));
        items.push(<span key={w.key} data-w={i} className={`w${w.cut ? " script-cut" : ""}${w.hidden ? " script-hidden" : ""}${w.added ? " script-added" : ""}`}
          title={w.cut ? "Cut. Select it and choose Restore to put it back" : w.hidden ? "Left out of the captions" : undefined}>{w.text}</span>);
        // "full" "-time" read as one word, as in captions; other words have a space between them.
        if (k < block.words.length - 1) { const gap = transcriptSeparator(w.text, doc.words[block.words[k + 1]].text); if (gap) items.push(gap); }
      });
      flush("end");
      return <div key={block.key} data-script-block={b} data-kind={block.kind} className={`script-para${voiceBlock ? " script-voice" : ""}${block.tomb ? " script-tomb" : ""}`}>
        <div contentEditable={false} className="script-who">
          {voiceBlock ? <Voice size={14} /> : null}<span>{voiceBlock ? "Voiceover" : `On camera · ${block.label}`}</span>
          {voiceBlock ? <span className="script-tools">
            <button type="button" className="script-chip" aria-label={`${playing === block.key ? "Pause" : "Play"} this voiceover`} onClick={() => void play(block)}>{playing === block.key ? <Pause size={13} /> : <Play size={13} />}{playing === block.key ? "Pause" : "Play"}</button>
            {voice && !range ? <button type="button" className="script-chip" disabled={!redoable || !!voice.prompt || !!voice.working || !voice.device} title={redoable ? "Record this paragraph again" : "Redo records a script line again. This voiceover was placed from a recording, so use Add a recording"} onClick={() => redo(block)}>Redo</button> : null}
          </span> : null}
        </div>
        <p className="script-line">{items.length ? items : <span contentEditable={false} className="script-muted">{block.fallback || "No timed words to edit."}</span>}</p>
        {block.changed ? <p contentEditable={false} className="script-note" data-wording-changed>Wording changed, audio unchanged</p> : null}
        {block.suspect?.length ? <p contentEditable={false} className="script-note script-muted" data-voice-suspect>Some words here may be missing from the transcript.
          <button type="button" className="script-chip" onClick={() => { for (const line of block.suspect!) editJob("Listen again", { kind: "voiceWords", relisten: { line } }, version, "other"); setNote("Listening again…"); }}>Listen again</button></p> : null}
      </div>;
    });
  }, [doc, draft, showCuts, dots, playing, voice?.prompt, voice?.working, voice?.device, voice?.loadingScript, range]);

  const cutCount = doc.words.filter(w => w.cut).length;
  const camera = selectedLive.some(i => doc.words[i].kind === "camera");
  const status = error ? null : note ?? (saving ? "Saving…" : selectedLive.length > 1 ? `${selectedLive.length} words selected · Delete cuts them, typing fixes them` : selectedCut.length ? `${selectedCut.length} cut ${selectedCut.length === 1 ? "word" : "words"} selected` : cutCount ? `${cutCount} ${cutCount === 1 ? "word" : "words"} cut · ⌘Z undoes` : "Click a word to put the cursor there");
  return <div className={`script-panel${range ? " script-range" : ""}`} data-script-panel data-transcript-panel>
    {voice && !range ? <ScriptRecording voice={voice} root={shoot.root} onTakeOpen={setViewer} /> : null}
    {!viewer ? <>
      {!range && (fillers > 0 || (camera && bleepMenu)) ? <div className="script-toolbar" role="toolbar" aria-label="Script tools">
        {fillers > 0 ? <button type="button" className="script-chip" disabled={saving} onClick={() => editJob("Remove ums", { kind: "removeFillers" }, version, "other")}>Remove ums from camera speech</button> : null}
        {camera && bleepMenu ? <span role="group" aria-label="Bleep selected words" className="script-tools">
          <button type="button" className="script-chip" onClick={() => bleep("beep")}>Bleep</button><button type="button" className="script-chip" onClick={() => bleep("mute")}>Mute</button><button type="button" className="script-chip" onClick={() => bleep(null)}>Remove bleep</button>
        </span> : null}
      </div> : null}
      <div ref={host} data-script-doc data-transcript contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Script" spellCheck={false}
        aria-busy={saving} className={`script-doc${showCuts ? "" : " script-hide-cuts"}`}
        onKeyDown={onKeyDown} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(); }}
        onCut={event => event.preventDefault()} onPaste={event => event.preventDefault()} onDrop={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
        onContextMenu={event => { if (camera && !range) { event.preventDefault(); setBleepMenu(true); } }}>
        {doc.blocks.length ? words : <p contentEditable={false} className="script-muted">{version.captionsPending?.reason ?? "No spoken words in this edit yet."}</p>}
      </div>
      {/* The footer: what the selection or the cuts are, Restore when struck words are chosen, and Show cuts. */}
      <div className="script-footer">
        <p className="script-status" role="status">{status}</p>
        {selectedCut.length ? <Button type="button" variant="primary" className="script-restore" onMouseDown={event => event.preventDefault()} onClick={() => restoreWords(selected)}>Restore</Button> : null}
        {!range ? <button type="button" className="script-toggle" role="switch" aria-checked={showCuts} onClick={() => { setShowCuts(on => !on); setDots(null); }}><span className="script-switch" aria-hidden="true" />Show cuts</button> : null}
      </div>
      {offer ? <div className="script-tools script-offer"><span>Use “{offer.correction}” for the same word elsewhere in this shoot?</span><button type="button" className="script-chip" onClick={() => void fixAll()}>Fix all {offer.words.length}</button><button type="button" className="script-chip" onClick={() => setOffer(null)}>Dismiss</button></div> : null}
      {error ? <InlineError className="script-error">{error}</InlineError> : null}
    </> : null}
  </div>;
}
