import { useEffect,useState } from "react";
import type { CutVersion, RevisionState } from "../../../shared/schema";
import { getApi } from "../data";

export type HistoryStep = { label: string; undo: () => void; redo: () => void };
type Selection = (version: number, mode?: "refresh" | "after-local") => void;
/** VO7-3: main's revision cursor (VO7-1), the truth every editor writes against. */
export type RevisionDriver = { state(): Promise<RevisionState>; undo(): Promise<RevisionState>; redo(): Promise<RevisionState> };
export type SavedEdit = { cutId?: string; version: number; unchanged?: boolean; baseVersion?: number } | null | undefined;
type Entry = {
  version?: number;        // the revision this step made; undefined while its commit is queued
  label?: string;          // what made it; absent = read from the saved version (labeler)
  step?: HistoryStep;      // this session's local view of the step: undo shows before, redo shows after
  pending?: boolean;
  parent?: Entry;          // the step it was made on, so a queued commit finds its base after earlier ones land
  undoBase?: Entry;        // main's accepted rebase, including for an undo queued before the save answers
  from?: number;           // made while the screen showed a revision off the undo path
  noop?: boolean;          // main made nothing (unchanged): moving over it never reaches main
  opened?: Entry;          // made on a peek: the step for that revision, put under it at once
  reopen?: { cursor: number; tail: Entry[] };  // the peek was an earlier step: where the path stood before
};

/** One session, one cut. Snapshots stay immutable in main; this mirrors main's undo path.
 * Every hand edit is applied on screen at once, then committed in order in the background with
 * expected = the revision it was made on. ⌘Z and ⌘⇧Z move on screen at once and queue the same
 * move for main behind any pending commit, so main replays exactly what the person did. Without a
 * driver (the browser fixture) undo opens the earlier version, as before. */
export function createEditHistory(initial: number, driver?: RevisionDriver) {
  let entries: Entry[] = [{ version: initial, label: "Open edit" }], cursor = 0;
  let staged: HistoryStep[] = [], stageCursor = 0;
  let peek: number | null = null;                 // driver: the screen shows a revision off the path
  let edge: RevisionState | null = null;          // driver: main's neighbours as last reported
  let tail: Promise<unknown> = Promise.resolve(), jobs = 0, generation = 0, started = false, turn = 0;
  const waiting = new Set<Entry>();               // edits whose commit has not landed yet
  let refused: { step: HistoryStep; version: number } | undefined;
  let labeler: (version: number) => string = () => "change";
  let selectNow: Selection | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const clearStages = () => { staged = []; stageCursor = 0; };
  const labelOf = (entry: Entry | undefined) => entry ? entry.label ?? labeler(entry.version ?? 0) : null;
  const resolved = (entry: Entry | undefined): number | undefined => {
    for (let e = entry; e; e = e.parent) if (!e.pending && e.version !== undefined) return e.version;
    return undefined;
  };
  const savedAt = (index: number): number => {
    for (let i = Math.min(index, entries.length - 1); i >= 0; i--) if (!entries[i].pending && entries[i].version !== undefined) return entries[i].version!;
    return initial;
  };
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    turn++;
    // An idle queue starts the work now, in the same turn as the edit: no extra hop before main hears of it.
    const run = jobs++ === 0 ? work() : tail.then(work);
    tail = run.then(() => {}, () => {}).then(() => { if (--jobs === 0) { notify(); drained(); } });
    return run;
  }
  const select = (version: number, choose?: Selection, mode?: "refresh" | "after-local") => (choose ?? selectNow)?.(version, mode);
  /** Driver: rebuild what this session knows around main's state, and show it. */
  function resync(state: RevisionState, show = true, mode?: "refresh" | "after-local") {
    if (refused?.version !== state.version) refused = undefined;
    generation++; edge = state; peek = null;
    entries = [...(state.undoTo !== null ? [{ version: state.undoTo }] : []), { version: state.version }, ...(state.redoTo !== null ? [{ version: state.redoTo }] : [])];
    cursor = state.undoTo !== null ? 1 : 0;
    clearStages();
    if (show) select(state.version, undefined, mode);
    notify();
  }
  /** Driver: what main reported after a move. Grows the known path at its ends; a surprise resyncs. */
  function learn(state: RevisionState, target: Entry | null) {
    edge = state;
    if (target && state.version !== target.version) { resync(state); return; }
    if (!target) {
      // Moved past what this session knew: main's answer is the step.
      const at = entries.findIndex(e => e.version === state.version);
      if (at >= 0) { if (at !== cursor) { cursor = at; select(state.version); } }
      else if (cursor === 0) { entries = [{ version: state.version }, ...entries]; cursor = 0; select(state.version); }
      else { entries = [...entries, { version: state.version }]; cursor = entries.length - 1; select(state.version); }
    }
    const first = entries[0], last = entries.at(-1)!;
    if (state.undoTo !== null && first.version === state.version && !entries.some(e => e.version === state.undoTo)) {
      if (first.label === "Open edit") first.label = undefined;
      entries = [{ version: state.undoTo }, ...entries]; cursor++;
    }
    if (state.redoTo !== null && last.version === state.version && !last.pending && !entries.some(e => e.version === state.redoTo)) entries = [...entries, { version: state.redoTo }];
    notify();
  }
  function start() {
    if (!driver || started || !(initial > 0)) return;
    started = true;
    void enqueue(async () => {
      const state = await driver.state().catch(() => null);
      if (!state) return;
      edge = state;
      if (entries.length === 1 && cursor === 0 && !entries[0].pending && jobs === 1) {
        // What the screen shows now: a visit while this read was in flight (the link's version, or main's
        // current opened over the newest snapshot) already set peek. Using the version the history was
        // made with instead sent the next hand edit onto a hidden snapshot that was not on screen: the
        // split failed on it and vanished, and ⌘Z then took back the step before.
        const shown = peek ?? entries[0].version!;
        if (state.version === entries[0].version && peek === null) { entries[0].label = undefined; learn(state, entries[0]); }
        else { resync(state, false); if (shown !== state.version) peek = shown; notify(); }
      }
    });
  }
  function drained() {
    if (!driver || !started) return;
    const asked = turn, gen = generation;
    void driver.state().then(state => {
      if (jobs || asked !== turn || gen !== generation) return;
      edge = state;
      if (peek !== null || entries[cursor]?.pending) { notify(); return; }
      if (state.version !== savedAt(cursor)) resync(state); else notify();
    }, () => {});
  }
  function move(direction: -1 | 1, target: Entry | null, moved?: Entry) {
    if (!driver) return;
    const gen = generation;
    void enqueue(async () => {
      if (gen !== generation || moved?.noop) return;
      try { learn(await (direction < 0 ? driver.undo() : driver.redo()), direction < 0 ? moved?.undoBase ?? target : target); }
      catch { /* drained() reads main's state and puts the screen back on it */ }
    });
  }
  /** An edit made on a peek placed nothing: the path is as it was before it (the peek stays a peek). */
  function unopen(entry: Entry) {
    if (entry.reopen) { entries = [...entries, ...entry.reopen.tail]; cursor = entry.reopen.cursor; }
    else { entries = entries.filter(e => e !== entry.opened); cursor = entries.length - 1; }  // it was put right after the cursor
  }
  /** A failed commit: it and every edit still waiting go; the screen returns to the last saved step. */
  function rollback(entry: Entry, restore = true) {
    generation++;
    const index = entries.indexOf(entry);
    const lowest = index >= 0 ? index : entries.findIndex(e => e.pending);
    if (lowest >= 0) {
      const applied = cursor >= lowest, failed = entries[lowest];
      if (applied && restore) failed.step?.undo();
      entries = entries.slice(0, lowest);
      // Made on a peek and never placed: the screen is on that peek again, off the path.
      let reopened = false;
      if (failed.opened && entries.length > 1 && entries.at(-1) === failed.opened && cursor >= lowest - 1) { unopen(failed); peek = failed.from!; reopened = true; }
      if (applied) { if (!reopened) cursor = entries.length - 1; if (restore) select(peek ?? savedAt(cursor)); }
      if (!entries.length) { entries = [{ version: savedAt(-1) }]; cursor = 0; }
    }
    waiting.clear();
    notify();
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** The saved revision the screen is on (the base of anything still pending). */
    get version() { return peek ?? savedAt(cursor); },
    get undoLabel() { return refused?.step.label ?? (stageCursor ? staged[stageCursor - 1].label : cursor ? labelOf(entries[cursor]) : driver && edge?.canUndo && peek === null && entries[cursor]?.version === edge.version ? labelOf(entries[cursor]) : null); },
    get redoLabel() { return labelOf(entries[cursor + 1]) ?? (stageCursor < staged.length ? staged[stageCursor].label : null)
      ?? (driver && edge?.canRedo && edge.redoTo !== null && cursor === entries.length - 1 && entries[cursor]?.version === edge.version ? labeler(edge.redoTo) : null); },
    /** Edits still waiting for main. Input never waits for them. */
    get saving() { return waiting.size; },
    get busy() { return jobs > 0; },
    /** Driver only: the step on screen is this session's view of main's current revision. */
    get onPath() { return !!driver && peek === null && stageCursor === 0 && !entries[cursor]?.pending; },
    get driven() { return !!driver; },
    get staged() { return stageCursor; },
    setLabeler(next: (version: number) => string) { labeler = next; },
    attach(choose: Selection) { selectNow = choose; },
    /** Resolves once every queued commit and move has reached main. */
    idle(): Promise<void> { return tail.then(() => {}, () => {}); },
    visit(version: number) {
      if (driver && !started) { if (entries.length === 1 && !entries[0].pending && entries[0].version !== version) { entries[0].version = version; initial = version; } start(); }
      if (entries[cursor]?.pending || version === savedAt(cursor)) { if (driver && peek !== null && version === savedAt(cursor)) { peek = null; notify(); } return; }
      refused = undefined;
      if (driver) {
        // A version the screen opens off the cursor (a link, the version menu), even one on the path, is a peek:
        // edits made on it go on it, never on main's current.
        if (peek === version) return;
        clearStages(); peek = version; notify(); return;
      }
      clearStages();
      const index = entries.findIndex(step => step.version === version);
      if (index >= 0) cursor = index;
      else { entries = [...entries.slice(0, cursor + 1), { version, label: `Select v${version}` }]; cursor++; }
      notify();
    },
    /** A commit that already landed in main (a background job, a recording, a translation). */
    commit(base: number, version: number, label: string) {
      refused = undefined;
      clearStages();
      if (driver) {
        if (version === base) { notify(); return; }
        if (entries.some(e => e.version === version)) { notify(); return; }
        const at = entries.map(e => e.version).lastIndexOf(base);
        if (at >= 0 && at <= cursor && !entries.slice(at + 1, cursor + 1).some(e => e.pending)) cursor = at;
        else if (at < 0) { entries = [...entries.slice(0, cursor + 1), { version: base, label: `Open v${base}` }]; cursor++; }
        entries = [...entries.slice(0, cursor + 1), { version, label }]; cursor++; peek = null;
        notify(); return;
      }
      const index = entries.findIndex(step => step.version === base);
      if (index >= 0) cursor = index;
      else { entries = [{ version: base, label: "Open edit" }]; cursor = 0; }
      if (version !== base) { entries = [...entries.slice(0, cursor + 1), { version, label }]; cursor++; }
      notify();
    },
    /** One hand edit, already applied on screen. `run` commits it on its base (strict: base is main's
     * current revision as this session knows it). A failure rolls it back with the edits that wait on it. */
    pending(step: HistoryStep, run: (base: number, strict: boolean) => Promise<SavedEdit>,
      hooks: { saved?: (result: NonNullable<SavedEdit>, current: boolean) => void; failed?: (error: unknown) => void } = {}): Promise<SavedEdit> {
      refused = undefined;
      clearStages();
      // An edit made on a revision off the path (a version opened on purpose, or one a link opened over main's
      // current) sits on that revision at once, as main will place it: ⌘Z before it lands goes back to the
      // revision on screen, not to main's current (which took back the step before it).
      // As main places it: an earlier step of the path becomes the step it is made on (its redo goes), any other
      // revision is put after the current one.
      let opened: Entry | undefined, reopen: Entry["reopen"];
      if (peek !== null) {
        const at = entries.findIndex(e => e.version === peek && !e.pending);
        if (at >= 0 && at <= cursor) { reopen = { cursor, tail: entries.slice(at + 1) }; opened = entries[at]; entries = entries.slice(0, at + 1); cursor = at; }
        else { opened = { version: peek, label: `Open v${peek}` }; entries = [...entries.slice(0, cursor + 1), opened]; cursor = entries.length - 1; }
      }
      const entry: Entry = { label: step.label, step, pending: true, parent: entries[cursor], ...(opened ? { from: opened.version, opened, ...(reopen ? { reopen } : {}) } : {}) };
      entries = [...entries.slice(0, cursor + 1), entry]; cursor = entries.length - 1; peek = null; waiting.add(entry);
      notify();
      const gen = generation;
      return enqueue(async () => {
        if (gen !== generation) { waiting.delete(entry); return undefined; }
        const base = entry.from ?? resolved(entry.parent) ?? initial;
        let result: SavedEdit;
        try { result = await run(base, !!driver && entry.from === undefined); }
        catch (error) {
          const applied = entries.indexOf(entry) >= 0 && cursor >= entries.indexOf(entry);
          const conflict = !!driver && !!(error as { message?: string })?.message?.includes("Something else changed this edit. Try again.");
          waiting.delete(entry); rollback(entry, !conflict);
          if (driver && conflict) {
            const state = await driver.state().catch(() => null);
            if (state) {
              resync(state, true, applied ? "refresh" : "after-local");
              // A fast refusal can beat the person's next Z. That key still
              // belongs to the refused step, never the other writer's change.
              if (applied) refused = { step, version: state.version };
            } else if (applied) { step.undo(); select(peek ?? savedAt(cursor)); }
          }
          hooks.failed?.(error); return undefined;
        }
        waiting.delete(entry);
        entry.pending = false;
        const index = entries.indexOf(entry);
        if (!result || result.unchanged || result.version === base) {
          entry.version = base; entry.noop = true;
          if (index >= 0) {
            const top = cursor === index;
            entries.splice(index, 1);
            if (cursor >= index) cursor--;
            for (const e of entries) if (e.parent === entry) e.parent = entry.parent;
            // Nothing was made on the peek: it is a peek again, not a step on the path.
            const at = entry.opened ? entries.indexOf(entry.opened) : -1;
            if (at >= 0 && at === entries.length - 1 && cursor === at) { unopen(entry); peek = entry.from!; }
            if (top) { step.undo(); const v = peek ?? savedAt(cursor); if (!entries[cursor]?.pending) select(v); }
          }
          notify();
          if (result) hooks.saved?.(result, false);
          return result;
        }
        if (result.baseVersion !== undefined && result.baseVersion !== base) {
          const parent = entry.parent;
          const actual = entries.find(e => !e.pending && e.version === result.baseVersion) ?? { version: result.baseVersion };
          entry.undoBase = actual;
          // The person may already have undone this save and made another edit.
          // Keep that edit, and queue it on the revision the undo really reaches.
          const at = parent ? entries.indexOf(parent) : -1;
          if (!entries.includes(actual) && at >= 0) {
            entries.splice(at + 1, 0, actual);
            if (cursor >= at) cursor++;
          }
          for (const e of entries) if (e.pending && e.parent === parent) e.parent = actual;
          entry.parent = actual;
        }
        if (index >= 0) {
          const extra: Entry[] = [];
          if (entry.from !== undefined && !entries.some(e => e.version === entry.from)) extra.push({ version: entry.from, label: `Open v${entry.from}` });
          const position = entries.indexOf(entry);
          if (extra.length) { entries.splice(position, 0, ...extra); if (cursor >= position) cursor += extra.length; }
        }
        entry.version = result.version;
        notify();
        hooks.saved?.(result, entries[cursor] === entry);
        return result;
      });
    },
    stage(step: HistoryStep) {
      refused = undefined;
      // Editing a staged undo also branches from the selected immutable version.
      entries = entries.slice(0, cursor + 1);
      staged = [...staged.slice(0, stageCursor), step]; stageCursor++; notify();
    },
    commitStage(step: HistoryStep, base: number, version: number) {
      const index = staged.indexOf(step);
      if (index < 0) return;
      const applied = index < stageCursor;
      staged.splice(index, 1);
      if (applied) stageCursor--;
      const parent = entries.findIndex(entry => entry.version === base);
      if (parent < 0) return;
      entries.splice(parent + 1, 0, { version, label: step.label });
      if (applied) cursor = parent + 1;
      notify();
    },
    discardStage(step: HistoryStep) {
      const index = staged.indexOf(step);
      if (index < 0) return;
      if (index < stageCursor) { step.undo(); stageCursor--; }
      staged.splice(index, 1); notify();
    },
    clearStages() { clearStages(); notify(); },
    undo(choose?: Selection) {
      if (refused) {
        const rejected = refused; refused = undefined;
        rejected.step.undo(); select(rejected.version, choose, "after-local"); notify(); return;
      }
      if (stageCursor) { staged[--stageCursor].undo(); notify(); return; }
      if (cursor) {
        const entry = entries[cursor]; cursor--; peek = null;
        entry.step?.undo();
        const target = entries[cursor];
        if (!target.pending && target.version !== undefined) select(target.version, choose);
        move(-1, target, entry);
        notify(); return;
      }
      if (driver && edge?.canUndo && peek === null && entries[cursor]?.version === edge.version) move(-1, null);
      notify();
    },
    redo(choose?: Selection) {
      refused = undefined;
      if (cursor + 1 < entries.length) {
        const entry = entries[++cursor]; peek = null;
        entry.step?.redo();
        if (!entry.pending && entry.version !== undefined) select(entry.version, choose);
        move(1, entry, entry);
        notify(); return;
      }
      if (stageCursor < staged.length) { staged[stageCursor++].redo(); notify(); return; }
      if (driver && edge?.canRedo && peek === null && entries[cursor]?.version === edge.version) move(1, null);
      notify();
    },
    /** Driver: main's current revision changed under this session (the sidekick, the MCP, a job). */
    follow(state: RevisionState) { if (driver && !jobs && !waiting.size) resync(state); },
    /** Queue work behind every pending commit (saving a version, restoring one). */
    after<T>(work: () => Promise<T>): Promise<T> { return enqueue(work); },
  };
}
export type EditHistory = ReturnType<typeof createEditHistory>;
const sessions = new Map<string, EditHistory>();
function revisionDriver(root: string, cutId: string | undefined): RevisionDriver | undefined {
  const api = getApi();
  if (!cutId || typeof api.revisionState !== "function" || typeof api.undoRevision !== "function" || typeof api.redoRevision !== "function") return undefined;
  return { state: () => api.revisionState!(root, cutId), undo: () => api.undoRevision!(root, cutId), redo: () => api.redoRevision!(root, cutId) };
}
/** The revision an edit opens on (VO7: its current revision), or null when main has no history to say. */
export async function currentRevision(root: string, cutId: string): Promise<number | null> {
  const api = getApi();
  if (typeof api.revisionState !== "function") return null;
  try { return (await api.revisionState(root, cutId)).version; } catch { return null; }
}
export function editHistoryFor(root: string, cutId: string | undefined, version?: number): EditHistory {
  const key = JSON.stringify([root, cutId]);
  let history = sessions.get(key);
  if (!history) { history = createEditHistory(version ?? 0, revisionDriver(root, cutId)); sessions.set(key, history); }
  return history;
}
export function useEditHistory(root: string, cutId: string | undefined, version: number | undefined,
  select?: Selection) {
  const history = editHistoryFor(root, cutId, version);
  if (select) history.attach(select);
  const [, refresh] = useState(0);
  useEffect(() => history.subscribe(() => refresh(n => n + 1)), [history]);
  useEffect(() => { if (version !== undefined) history.visit(version); }, [history, version]);
  return { history, undoLabel: history.undoLabel, redoLabel: history.redoLabel,
    undo: () => history.undo(select), redo: () => history.redo(select) };
}
/** VO7-3: Auto correct's own Undo shows only while Auto correct is the current undo step, and it is
 * that step's ⌘Z: the cursor moves back one revision, so later cuts are never discarded. Without
 * main's history (the browser fixture) it reopens the saved version from before the correction. */
export function useAutoCorrectUndo(root: string, cutId: string | undefined, version: CutVersion) {
  const { history, undoLabel } = useEditHistory(root, cutId, version.version);
  const corrected = /^Auto correct \d+ clips?$/.test(version.feedback ?? "");
  if (!history.driven) return { show: corrected && !!version.balanceUndo,
    undo: () => window.dispatchEvent(new CustomEvent("precut:balance-undo", { detail: { cutId, version: version.balanceUndo } })) };
  return { show: corrected && history.onPath && history.version === version.version && !!undoLabel, undo: () => history.undo() };
}
