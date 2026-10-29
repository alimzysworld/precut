import { useModelAccess, ModelSignIn } from "./ModelAccess";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AudioFile, CaptionsPending, CutEdit, CutVersion, VoiceoverCaptions, VoiceoverLine, VoiceoverScript } from "../../../shared/schema";
import { getApi } from "../data";
import type { StageHandle } from "./Stage";
import type { PromptState } from "./Teleprompter";
import { heardLineEnd, voiceClock, voiceSource, voiceTokens } from "./voiceoverModel";
import { InlineError, SectionHeader } from "./ui";
import { ChevronDown, Play, Voice } from "./icons";
import { TakeViewer, cleanReadApi, warmTakePeaks, type CleanReadPlan } from "./TakeViewer";
import { playSpans, stopAudition } from "./planAudio";
import "./voiceover.css";

type Input = { id: string; name: string; isDefault: boolean };
type Pending = { file: string; ids?: string[] };
/** The take plays the edit: picture and sound run from just before the first
 * line, the prompter follows the edit's clock, Space jumps ahead. */
const LEAD_S = 1;
const expectedTake = (lines: VoiceoverLine[], from: number, redo: boolean, lengthS?: number) => {
  const last = lines.at(-1); if (!last) return 0;
  return redo ? last.e - last.s : Math.min(lengthS ?? Infinity, last.e + (last.pauseAfterS ?? 0)) - from;
};
export function useVoiceover({ root, cutId, version, enabled, active, player, onPlaced, onUndo, onAddRecording, time, lengthS }: {
  root: string; cutId?: string; version?: number; enabled: boolean; active: boolean;
  player: React.RefObject<StageHandle>;
  /** VO7-7: placed = the new voice pieces, for selecting them on the lane (Precuts may ignore it). */
  onPlaced: (cutId: string, version: number, label?: string, placed?: string[], snapshot?: CutVersion) => Promise<void> | void;  // OPEN1: snapshot = the placed version
  /** V66: the editor's own Undo, for the captions note. */
  onUndo?: () => void;
  /** Add a recording: copies the file in as a take and places it whole by the Insertion rule, selected,
   * as one undoable version; resolves once saved with the take and its placed piece ids. */
  onAddRecording?: (file: string) => Promise<{ take: string; placed: string[] }>;
  /** The playhead, when the stage reports it. The prompter keeps the take's own clock either way. */
  time?: number; lengthS?: number;
}) {
  const [script, setScript] = useState<VoiceoverScript | null>(null), [inputs, setInputs] = useState<Input[]>([]);
  const [loadedScriptKey, setLoadedScriptKey] = useState<string | null>(null);
  const scriptKey = `${root}:${cutId}:${version}`;
  const loadingScript = !!enabled && !!cutId && loadedScriptKey !== scriptKey;
  const [device, setDevice] = useState(""), [level, setLevel] = useState(-96), [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null), [prompt, setPrompt] = useState<PromptState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null), [takes, setTakes] = useState<AudioFile[]>([]);
  /** V66: what the take did to the captions, shown once in place on the version it made. */
  const [captions, setCaptions] = useState<{ state: Exclude<VoiceoverCaptions, "unchanged">; cutId: string; version: number; lineIds?: string[] } | null>(null);
  useEffect(() => { setCaptions(null); }, [root, cutId]);
  const session = useRef<{ id?: string; lines: VoiceoverLine[]; index: number; cursor: number; started: number; lineAt: number; heardCount: number; following: boolean; countdown: number; redo: boolean; from: number; skip: number } | null>(null);
  const clock = useRef({ time, lengthS }); clock.current = { time, lengthS };
  const levelRef = useRef(-96), stopRef = useRef<() => Promise<void>>(async () => {});
  const alive = useRef(true), epoch = useRef(0), locked = useRef(false), drafts = useRef(new Map<string, string>()), writes = useRef(Promise.resolve());
  const speechState = useRef(new Map<string, boolean>());
  const fail = (e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+':\s*/i, "") : "Couldn't save your voiceover. Try again."); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; const id = session.current?.id; session.current = null; if (id) void getApi().recordStop(id).catch(() => {}); }; }, []);
  useEffect(() => {
    const stamp = ++epoch.current;
    setScript(current => current?.cutId === cutId ? current : null);
    drafts.current.clear(); setPending(null); setError(null);
    // Switching edits keeps the original take, but never places it on another edit.
    const id = session.current?.id; session.current = null; setPrompt(null); if (id) void getApi().recordStop(id).catch(fail);
    if (enabled && cutId) void getApi().voiceoverScript(root, cutId).then(s => {
      if (epoch.current === stamp) { setScript(s); setLoadedScriptKey(scriptKey); }
    }).catch(error => { if (epoch.current === stamp) { setLoadedScriptKey(scriptKey); fail(error); } });
    return () => { epoch.current++; };
  }, [root, cutId, version, enabled]);
  // Saved takes stay playable and placeable, placed or not.
  const loadTakes = (quiet = false) => Promise.resolve().then(() => quiet ? refreshShootWhenQuiet(root) : getApi().loadShoot(root)).then(shoot => { if (alive.current) setTakes((shoot?.audio ?? []).filter(a => a.role === "voiceover").reverse()); }).catch(() => {});
  useEffect(() => {
    if (!enabled) return;
    void loadTakes();
    return getApi().onStepsChanged?.(changed => { if (changed === root) void loadTakes(true); });
  }, [enabled, root]);
  // VO8: the warm transcriber stays while the panel is open, so a take's words land soon after Stop.
  useEffect(() => {
    const api = getApi() as ReturnType<typeof getApi> & { voiceoverWarm?: (open: boolean) => Promise<void> };
    if (!enabled || typeof api.voiceoverWarm !== "function") return;
    const renew = () => { void api.voiceoverWarm!(true).catch(() => {}); };
    renew(); const lease = window.setInterval(renew, 8000);
    return () => { clearInterval(lease); void api.voiceoverWarm!(false).catch(() => {}); };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void getApi().audioInputs().then(list => { if (live) { setInputs(list); setDevice(old => list.some(i => i.id === old) ? old : list.find(i => i.isDefault)?.id ?? list[0]?.id ?? ""); } }).catch(fail);
    return () => { live = false; };
  }, [enabled]);
  const editTime = (s: NonNullable<typeof session.current>) => s.from + s.skip + (s.id ? (performance.now() - s.started) / 1000 : 0);
  function advance(consumed?: number) {
    const s = session.current; if (!s?.id || s.countdown) return;
    s.cursor = consumed ?? Math.max(s.cursor, s.heardCount); s.index = Math.min(s.lines.length, s.index + 1); s.lineAt = performance.now();
    // His voice moving on only moves the words. Space means he is ahead, so the
    // edit jumps forward to that line and keeps playing; it never jumps back.
    const next = s.lines[s.index], now = editTime(s);
    if (consumed === undefined && next && next.s > now) { s.skip += next.s - now; player.current?.seek(next.s); player.current?.play?.(); }
  }
  useEffect(() => {
    const offLevel = getApi().onRecordLevel(e => { if (e.recordingId === session.current?.id) { levelRef.current = e.rmsDb; setLevel(e.rmsDb); } });
    const offWords = getApi().onRecordWords(e => {
      if (e.available !== undefined) { speechState.current.set(e.recordingId, e.available); if (speechState.current.size > 16) speechState.current.delete(speechState.current.keys().next().value!); }
      const s = session.current; if (!s || s.id !== e.recordingId || s.countdown) return;
      if (e.available !== undefined) s.following = e.available;
      // Empty words mean the local recognizer could not run. No remote fallback.
      if (!e.words.length) { if (e.available !== true) s.following = false; return; }
      s.following = true; s.heardCount = e.words.flatMap(voiceTokens).length;
      let line = s.lines[s.index];
      while (line) {
        const end = heardLineEnd(line, e.words, s.cursor);
        if (end === null) break;
        advance(end); line = s.lines[s.index];
      }
    });
    const timer = window.setInterval(() => {
      const s = session.current; if (!s) return;
      const elapsed = s.id ? (performance.now() - s.started) / 1000 : 0, at = editTime(s);
      // Lines change on the edit's own timing; his voice can only move them earlier.
      if (s.id) {
        let due = s.index;
        while (due + 1 < s.lines.length && s.lines[due + 1].s <= at + .25) due++;
        if (due > s.index) { s.index = due; s.lineAt = performance.now(); }
        // The edit ending ends the take, and places it.
        if (clock.current.lengthS && at >= clock.current.lengthS) { void stopRef.current(); return; }
      }
      setPrompt({ lines: s.lines, index: s.index, elapsed, countdown: s.countdown, following: s.following, redo: s.redo, expected: expectedTake(s.lines, s.from, s.redo, clock.current.lengthS), level: levelRef.current, playhead: at });
    }, 50);
    return () => { offLevel(); offWords(); clearInterval(timer); };
  }, []);
  useEffect(() => { if (!active && session.current) void stop(false); }, [active]);
  function edit(id: string, text: string) {
    drafts.current.set(id, text); setScript(s => s ? { ...s, lines: s.lines.map(l => l.id === id ? { ...l, text, take: null } : l) } : s);
  }
  function save(id: string) {
    const text = drafts.current.get(id); if (text === undefined || !cutId) return writes.current;
    drafts.current.delete(id); const stamp = epoch.current;
    writes.current = writes.current.catch(() => {}).then(async () => {
      try {
        const next = await getApi().setVoiceoverLine(root, cutId, id, text);
        if (stamp === epoch.current) setScript(s => s ? { ...next, lines: next.lines.map(l => {
          const current = s.lines.find(n => n.id === l.id);
          return current && current.text !== l.text ? { ...l, text: current.text, take: current.take } : l;
        }) } : next);
      } catch (e) { if (!drafts.current.has(id)) drafts.current.set(id, text); fail(e); throw e; }
    });
    return writes.current;
  }
  async function write() {
    if (!cutId || version === undefined || locked.current) return;
    locked.current = true; setWorking("Writing your voiceover…"); setError(null); const stamp = epoch.current;
    try { for (const id of drafts.current.keys()) await save(id); await writes.current; const next = await getApi().writeVoiceoverScript(root, cutId, version, { rewrite: !!script }); if (stamp === epoch.current) setScript(next); }
    catch (e) { fail(e); } finally { locked.current = false; if (alive.current) setWorking(null); }
  }
  async function place(take: Pending) {
    if (!cutId) return;
    setPending(take); setError(null); setWorking("Placing your take…"); const stamp = epoch.current;
    try {
      // Placement waits for Stop's local transcript itself and says plainly if it failed.
      setCaptions(null);
      const result = await getApi().placeVoiceover(root, cutId, take.file, take.ids);
      if (epoch.current !== stamp || !alive.current) return;
      setPending(null);
      if (result.captions && result.captions !== "unchanged") setCaptions({ state: result.captions, cutId: result.cutId, version: result.version, lineIds: take.ids });
      // VO8: the edit opens on the new version while the panel's script reloads, not after it.
      const script = getApi().voiceoverScript(root, cutId).then(next => { if (epoch.current === stamp && alive.current) setScript(next); });
      await Promise.all([onPlaced(result.cutId, result.version, undefined, undefined, result.snapshot), script]);
    } catch (e) { fail(e); } finally { if (alive.current) setWorking(null); void loadTakes(); }
  }
  /** VO6: the whole take, uncut, on the Voiceover lane from 0:00. Picture untouched. */
  async function placeAsIs(file: string) {
    if (!cutId || version === undefined) return;
    setError(null); setWorking("Placing your take…");
    try {
      const result = await getApi().editCut(root, cutId, version, { kind: "voiceover", op: "placeAsIs", take: file });
      if (alive.current) await onPlaced(result.cutId, result.version, "place take as is");
    } catch (e) { fail(e); } finally { if (alive.current) setWorking(null); }
  }
  /** VO7-7: part of a take (a marked range, the whole take, or a resolved clean read) at the playhead,
   * as one undoable version. A clean read carries its proposal identity, so main refuses a stale one. */
  async function addPart(file: string, spans: { s: number; e: number }[], plan?: CleanReadPlan, replace?: string[]) {
    if (!cutId || version === undefined || locked.current) return null;
    locked.current = true; setError(null); setWorking(replace?.length ? "Applying your clean read…" : plan ? "Adding your clean read…" : "Adding to the timeline…");
    try {
      // Add a recording's Apply names the raw piece it placed, so the clean read replaces it in this one version.
      const edit = { kind: "voiceover", op: "placePlan", take: file, spans: spans.map(({ s, e }) => ({ s, e })), at: Math.max(0, clock.current.time ?? 0), ...(plan ? { identity: plan.identity } : {}), ...(replace?.length ? { replace } : {}) };
      const result = await getApi().editCut(root, cutId, version, edit as unknown as CutEdit) as { cutId: string; version: number; placed?: string[]; appended?: boolean; captionsPending?: CaptionsPending | null };
      if (alive.current) await onPlaced(result.cutId, result.version, replace?.length ? "apply clean read" : plan ? "add clean read" : "add part of a take", result.placed);
      return { appended: !!result.appended };
    } finally { locked.current = false; if (alive.current) setWorking(null); }
  }
  /** Add a recording: his own file (a DJI mic take, say) from the native picker. It lands whole on the lane,
   * selected, and the take viewer then cleans it. Nothing happens when he cancels. */
  async function addRecording(): Promise<{ take: string; placed: string[] } | null> {
    const api = getApi() as ReturnType<typeof getApi> & { pickVoiceoverFile?: () => Promise<string | null> };
    if (!cutId || locked.current) return null;
    setError(null);
    if (!onAddRecording || typeof api.pickVoiceoverFile !== "function") { setError("Add a recording in the desktop app."); return null; }
    let file: string | null;
    try { file = await api.pickVoiceoverFile(); } catch (e) { fail(e); return null; }
    if (!file || !alive.current) return null;
    locked.current = true; setWorking("Adding your recording…");
    try { const added = await onAddRecording(file); await loadTakes(); return alive.current ? added : null; }
    catch (e) { fail(e); return null; }
    finally { locked.current = false; if (alive.current) setWorking(null); }
  }
  /** VO7-7: why captions didn't follow the current revision's voice, read from that revision. */
  const [captionsPending, setCaptionsPending] = useState<CaptionsPending | null>(null);
  useEffect(() => {
    setCaptionsPending(null);
    const api = cleanReadApi();
    if (!enabled || !cutId || version === undefined || !api.voiceoverCaptionsPending) return;
    let live = true;
    void api.voiceoverCaptionsPending(root, cutId, version).then(p => { if (live) setCaptionsPending(p ?? null); }, () => {});
    return () => { live = false; };
  }, [enabled, root, cutId, version]);
  async function retryCaptions() {
    if (!cutId || version === undefined || locked.current) return;
    locked.current = true; setError(null); setWorking("Updating captions…");
    try {
      const result = await getApi().followVoiceoverCaptions(root, cutId, version) as { cutId: string; version: number; captionsPending?: CaptionsPending | null };
      if (!alive.current) return;
      setCaptionsPending(result.captionsPending ?? null);
      await onPlaced(result.cutId, result.version, "update captions");
    } catch (e) { fail(e); } finally { locked.current = false; if (alive.current) setWorking(null); }
  }
  /** Update (his own captions) or Turn on (captions off): one undoable version. */
  async function followCaptions() {
    const note = captions; if (!note || locked.current) return;
    locked.current = true; setError(null); setWorking("Updating captions…"); const stamp = epoch.current;
    try {
      const result = await getApi().followVoiceoverCaptions(root, note.cutId, note.version, note.lineIds);
      if (epoch.current !== stamp || !alive.current) return;
      setCaptions({ state: "followed", cutId: result.cutId, version: result.version });
      await onPlaced(result.cutId, result.version, "update captions");
    } catch (e) { fail(e); } finally { locked.current = false; if (alive.current) setWorking(null); }
  }
  async function start(lineId?: string | string[]) {
    const ids = lineId === undefined ? undefined : Array.isArray(lineId) ? lineId : [lineId];
    if (!script?.lines.length || !device || locked.current || session.current) return;
    locked.current = true; setError(null);
    const stamp = epoch.current;
    try {
      for (const id of drafts.current.keys()) await save(id); await writes.current;
      const saved = await getApi().voiceoverScript(root, cutId!);
      const lines = saved?.lines.filter(l => !ids || ids.includes(l.id)) ?? [];
      if (!lines.length || lines.some(l => !voiceTokens(l.text).length)) throw new Error("Write each line before recording.");
      if (epoch.current !== stamp) return;
      const from = Math.max(0, lines[0].s - LEAD_S);
      player.current?.pause?.(); player.current?.stopPreview(); player.current?.seek(from);
      const s = { lines, index: 0, cursor: 0, started: 0, lineAt: 0, heardCount: 0, following: false, countdown: 3, redo: !!ids, from, skip: 0 };
      session.current = s; setPrompt({ ...s, elapsed: 0, expected: expectedTake(lines, from, !!ids, clock.current.lengthS), level: -96, playhead: from });
      for (let n = 3; n > 0; n--) { s.countdown = n; await new Promise(resolve => setTimeout(resolve, 1000)); if (session.current !== s || epoch.current !== stamp) return; }
      const result = await getApi().recordStart(root, device);
      if (session.current !== s || epoch.current !== stamp || !alive.current) { await getApi().recordStop(result.recordingId); return; }
      // The picture starts the moment the microphone does, so take time is edit time.
      s.countdown = 0;
      Object.assign(s, { following: speechState.current.get(result.recordingId) ?? false, id: result.recordingId, started: performance.now(), lineAt: performance.now() });
      player.current?.seek(from); player.current?.play?.();
    } catch (e) { session.current = null; setPrompt(null); fail(e); }
    finally { locked.current = false; }
  }
  async function stop(placing = true) {
    const s = session.current; if (!s) return; const stamp = epoch.current;
    session.current = null; setPrompt(null); setLevel(-96); levelRef.current = -96; player.current?.pause?.();
    if (!s.id) { if (s.countdown) locked.current = false; return; }
    locked.current = true; setWorking("Saving your take…");
    try {
      const take = await getApi().recordStop(s.id); void loadTakes();
      if (placing && alive.current && epoch.current === stamp) await place({ file: take.file, ids: s.redo ? s.lines.map(l => l.id) : undefined });
    }
    catch (e) { fail(e); } finally { locked.current = false; if (alive.current) setWorking(null); }
  }
  stopRef.current = () => stop();
  /** Back to the start of the voiceover in the normal player, take on its lane. */
  function playBack() {
    const first = script?.lines.find(l => l.take); if (!first) return;
    player.current?.stopPreview(); player.current?.seek(Math.max(0, first.s - LEAD_S)); player.current?.play?.();
  }
  async function restart() { const redo = session.current?.redo ? session.current.lines.map(l => l.id) : undefined; await stop(false); await start(redo); }
  const captionNote = captions && captions.cutId === cutId && captions.version === version ? captions.state : null;
  return { cutId, playhead: time ?? 0, addPart, addRecording, captionsPending, retryCaptions, captions: captionNote, followCaptions, keepCaptions: () => setCaptions(null), undoCaptions: () => { setCaptions(null); onUndo?.(); },
    script: script?.cutId === cutId ? script : null, loadingScript, inputs, device, setDevice, level, error, working, prompt, pending, edit, save, write, start, stop, restart, advance: () => advance(), retry: () => place(pending!), takes, useTake: (file: string) => place({ file }), placeAsIs, playBack };
}
export type VoiceoverController = ReturnType<typeof useVoiceover>;

/** SCRIPT1: recording lives at the top of the Script panel: the microphone, Record in one take, Add a recording, and
 * the takes (play, open in the take viewer to clean the read, use, place as is). The take viewer takes the panel's
 * place while open (onTakeOpen tells the panel). The document below shows what is placed. */
export function ScriptRecording({ voice, root, onTakeOpen }: { voice: VoiceoverController; root: string; onTakeOpen?: (open: boolean) => void }) {
  const modelReady = useModelAccess();
  const listening = useRef(0);
  const [playing, setPlaying] = useState<string | null>(null), [heard, setHeard] = useState<string | null>(null), [takesOpen, setTakesOpen] = useState(false);
  /** VO7-7: the take open in the viewer, by file. */
  const [openTake, setOpenTake] = useState<string | null>(null);
  const viewing = voice.takes?.find(t => t.file === openTake) ?? null;
  const viewerOpen = !!viewing && !voice.prompt;
  useEffect(() => { onTakeOpen?.(viewerOpen); }, [viewerOpen]);
  /** Add a recording: the take it added and the raw piece Apply replaces, until Apply lands or he closes it. */
  const [added, setAdded] = useState<{ take: string; placed: string[] } | null>(null);
  const replacing = added && viewing?.file === added.take ? added.placed : null;
  useEffect(() => { setAdded(null); }, [voice.cutId]);
  async function addRecording() {
    stopListening(); setPlaying(null);
    const result = await voice.addRecording();
    if (result) { setAdded(result); setOpenTake(result.take); }
  }
  const scriptKey = JSON.stringify(voice.script?.lines.map(l => l.text) ?? null);
  const stopListening = () => { listening.current++; stopAudition(); };
  const editLengthS = (voice.script as (VoiceoverScript & { editLengthS?: number }) | null)?.editLengthS;
  const scriptEnd = voice.script?.lines.reduce((end, l) => Math.max(end, l.e + (l.pauseAfterS ?? 0)), 0) ?? 0;
  const extraSeconds = editLengthS === undefined ? 0 : Math.ceil(Math.max(0, scriptEnd - editLengthS - 1e-6));
  useEffect(() => () => { stopAudition(); }, []);
  useEffect(() => { if (voice.prompt) setOpenTake(null); }, [!!voice.prompt]);
  // The newest takes' waveforms are fetched while the list shows, so opening one paints at once.
  const takeFiles = (voice.takes ?? []).slice(0, 4).map(t => t.file).join("\n");
  useEffect(() => { for (const file of takeFiles ? takeFiles.split("\n") : []) void warmTakePeaks(root, file).catch(() => {}); }, [root, takeFiles]);
  /** The raw take on its own, placed or not, through the same Web Audio player as the take viewer. */
  async function listen(id: string, file: string, from = 0, to = Infinity) {
    const turn = ++listening.current; stopAudition(); if (playing === id) { setPlaying(null); return; }
    const end = Math.min(to, voice.takes?.find(t => t.file === file)?.durationS ?? to);
    setPlaying(id); setHeard(null);
    try {
      const played = await playSpans(voiceSource(root, file), [{ s: from, e: Number.isFinite(end) ? end : from + 3600 }]);
      if (turn !== listening.current) { played.stop(); return; }
      void played.ended.then(() => { if (turn === listening.current) setPlaying(null); });
    } catch { if (turn === listening.current) { setPlaying(null); setHeard("Couldn't play that take. Check the drive is connected."); } }
  }
  const anyTake = !!voice.script?.lines.some(l => l.take);
  const takes = voice.takes ?? [];
  /** The microphone: an icon button over the device picker while idle; the full picker and level while recording. */
  const micName = voice.inputs.find(i => i.id === voice.device)?.name ?? "Choose a microphone";
  const mic = <div className={`vo-mic${voice.prompt ? "" : " vo-mic-compact"}`}><Voice size={voice.prompt ? 16 : 15} />
    <select aria-label="Microphone" title={voice.prompt ? undefined : `Microphone: ${micName}`} value={voice.device} disabled={!!voice.prompt || !!voice.working} onChange={e => voice.setDevice(e.target.value)}>{voice.inputs.length ? voice.inputs.map(i => <option key={i.id} value={i.id}>{i.name}</option>) : <option value="">Choose a microphone</option>}</select>
    <meter min={-96} max={0} value={voice.level} aria-label="Input level" />{voice.prompt ? null : <ChevronDown size={10} />}</div>;
  return <div className="vo-panel script-record" data-voiceover-panel data-control="voiceover">
    {viewerOpen ? <TakeViewer key={viewing!.file} root={root} take={viewing!} label={takeLabel(viewing!.file)} cutId={voice.cutId} scriptKey={scriptKey}
      playhead={voice.playhead} busy={!!voice.working} canAdd={!!voice.cutId} onClose={() => { setOpenTake(null); setAdded(null); }}
      autoClean={added?.take === viewing!.file} replacing={!!replacing}
      onAddRange={(s, e) => voice.addPart(viewing!.file, [{ s, e }])}
      onAddPlan={async plan => { const result = await voice.addPart(viewing!.file, plan.spans, plan, replacing ?? undefined); if (result && replacing) setAdded(null); return result; }} /> : <>
    {!voice.prompt && extraSeconds > 0 && <p className="vo-intro">This script needs about {voiceClock(extraSeconds)} more than the edit has</p>}
    {voice.loadingScript && !voice.script && <p role="status" className="vo-message">Loading your script…</p>}
    {voice.prompt ? mic : <div className="vo-actions script-record-row">{mic}
      {(voice.script || !voice.loadingScript) && <>
      {voice.pending ? <button type="button" disabled={voice.loadingScript || !!voice.working} className="st-button-primary" onClick={() => void voice.retry()}>Place saved take</button>
        : voice.script?.lines.length ? <button type="button" className="st-button-primary" disabled={voice.loadingScript || !voice.device || !!voice.working} onClick={() => { stopListening(); setPlaying(null); void voice.start(); }}><span className="vo-record-dot" />Record<span className="vo-hidden-label"> in one take</span></button>
        : modelReady ? <button type="button" className="st-button-primary" disabled={!!voice.working} onClick={() => void voice.write()}>Write voiceover</button> : <ModelSignIn feature="voiceover" />}
      {!voice.pending && <button type="button" data-add-recording disabled={!!voice.working} onClick={() => void addRecording()} title="Bring in a recording from another mic. It goes on the Voiceover lane, then Clean read checks it">Add a recording</button>}
      {takes.length || voice.script ? <button type="button" aria-expanded={takesOpen} aria-controls="script-takes" onClick={() => setTakesOpen(open => !open)}>{takesOpen ? "Hide takes" : takes.length ? `Takes (${takes.length})` : "More"}</button> : null}
      </>}
    </div>}
    {!voice.prompt && takesOpen && <section id="script-takes" className="vo-takes" aria-label="Your takes">
      {takes.map(take => <div className="vo-take" key={take.file}>
        <button type="button" data-playing={playing === take.file || undefined} aria-label={`${playing === take.file ? "Pause" : "Play"} take from ${takeLabel(take.file)}`} onClick={() => void listen(take.file, take.file)}><Play size={15} /></button>
        <button type="button" className="vo-take-open" data-open-take={take.file} onClick={() => { stopListening(); setPlaying(null); setOpenTake(take.file); }} aria-label={`Open take from ${takeLabel(take.file)}`}>{takeLabel(take.file)} · {voiceClock(take.durationS)}</button>
        <button type="button" disabled={!voice.script?.lines.length || !!voice.working || voice.loadingScript} onClick={() => { stopListening(); setPlaying(null); void voice.useTake(take.file); }} aria-label={`Use take from ${takeLabel(take.file)}`}>Use this take</button>
        <button type="button" disabled={!!voice.working} onClick={() => { stopListening(); setPlaying(null); void voice.placeAsIs(take.file); }} aria-label={`Place take from ${takeLabel(take.file)} as is`} title="The whole take on the Voiceover lane, uncut, from 0:00. Cut it there by hand">Place as is</button>
      </div>)}
      <div className="vo-actions">{anyTake && !voice.pending && <button type="button" disabled={!!voice.working} onClick={() => { stopListening(); setPlaying(null); voice.playBack(); }}><Play size={15} />Play it back</button>}
        {voice.script && (modelReady ? <button type="button" disabled={voice.loadingScript || !!voice.working} onClick={() => void voice.write()}>Rewrite script</button> : <ModelSignIn feature="voiceover" />)}</div>
    </section>}
    </>}
    {heard && <InlineError className="vo-message">{heard}</InlineError>}
    {voice.error && <InlineError className="vo-message">{voice.error}</InlineError>}
    {voice.working && <p role="status" className="vo-message">{voice.working}</p>}
    {!voice.prompt && !voice.working && voice.captions && <div role="status" className="vo-take" data-caption-note={voice.captions}>
      <span>{voice.captions === "followed" ? "Captions now follow your voiceover." : voice.captions === "offer" ? "Your voiceover changed the words. Update captions?" : "Captions are off. Turn on to follow your voiceover."}</span>
      {voice.captions === "followed" && <button type="button" onClick={voice.undoCaptions}>Undo</button>}
      {voice.captions === "offer" && <><button type="button" onClick={() => void voice.followCaptions()}>Update</button><button type="button" onClick={voice.keepCaptions}>Keep mine</button></>}
      {voice.captions === "off" && <button type="button" onClick={() => void voice.followCaptions()}>Turn on</button>}
    </div>}
    {!voice.prompt && !voice.working && voice.captionsPending && <div role="status" className="vo-take" data-captions-pending>
      <span>{voice.captionsPending.reason}</span><button type="button" onClick={() => void voice.retryCaptions()}>Retry</button>
    </div>}
  </div>;
}
/** Takes are named by when they were recorded, from the saved file's stamp. */
const takeTimeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const takeDateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
function takeLabel(file: string) {
  const stamp = file.split("/").pop()?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})/);
  const at = stamp ? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`) : null;
  if (!at || Number.isNaN(at.getTime())) return "Saved take";
  const time = takeTimeFormat.format(at);
  return at.toDateString() === new Date().toDateString() ? `Today ${time}` : `${takeDateFormat.format(at)} ${time}`;
}
export function LineEditor({ label, text, disabled, onChange, onBlur }: { label: string; text: string; disabled: boolean; onChange: (text: string) => void; onBlur: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } };
  useLayoutEffect(fit, [text]);
  useEffect(() => { let width = 0; const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width !== width) { width = entry.contentRect.width; fit(); } }); if (ref.current) observer.observe(ref.current); return () => observer.disconnect(); }, []);
  return <textarea ref={ref} aria-label={label} rows={1} value={text} disabled={disabled} onChange={e => onChange(e.target.value)} onBlur={onBlur} />;
}
import { refreshShootWhenQuiet } from "../hooks/quietShoot";
