import type { CutEdit, CutVersion, Shoot, Word } from '../../../../shared/schema';

type Piece = NonNullable<CutVersion['pieces']>[number];
const keptLength = (piece: Piece) => {
  const holes = (piece.removed ?? []).flatMap(g => (g as typeof g & { ranges?: {s:number;e:number}[] }).ranges ?? [g]).sort((a,b)=>a.s-b.s);
  let at=piece.s, kept=0;
  for(const gap of holes){kept+=Math.max(0,Math.min(gap.s,piece.e)-at);at=Math.max(at,Math.min(gap.e,piece.e));}
  return kept+Math.max(0,piece.e-at);
};
const identity = (p: Piece) => `${p.id}:${p.clipId}:${p.s}:${p.e}`;
type Tomb = NonNullable<CutVersion['cutPieces']>[number];
type Marker = NonNullable<Piece['removed']>[number] & { ranges?: { s: number; e: number }[] };
/** SCRIPT1: where a cut piece sits among `pieces` (main's tombIndex rule): after the piece it followed, else its index. */
export function tombIndex(tomb: Pick<Tomb, 'at' | 'after'>, pieces: { id: string; clipId: string }[]): number {
  if (tomb.after) {
    const matches = pieces.map((p, i) => p.id === tomb.after!.id && p.clipId === tomb.after!.clipId ? i + 1 : -1).filter(i => i >= 0);
    if (matches.length) return matches.sort((a, b) => Math.abs(a - tomb.at) - Math.abs(b - tomb.at))[0];
  } else if (tomb.after === null) return 0;
  return Math.max(0, Math.min(pieces.length, Number.isInteger(tomb.at) ? tomb.at : pieces.length));
}
const sameMarker = (a: { s: number; e: number }, b: { s: number; e: number }) => Math.abs(a.s - b.s) < 1e-7 && Math.abs(a.e - b.e) < 1e-7;
/** Piece indices belong to the document the person selected, never a later save. A cut piece is found again by its
 * own id, or (made before its save) by the piece it was. */
export function rebaseWords(edit: CutEdit, from: CutVersion, to: CutVersion): CutEdit {
  // `near`: clip seconds the edit is about. A piece split meanwhile (a move) matches the half holding them.
  const index = (i: number, near?: number) => {
    const piece = from.pieces?.[i], list = to.pieces ?? [];
    const same = list.findIndex(p => !!piece && identity(p) === identity(piece));
    const overlapping = piece ? list.map((p, k) => ({ p, k })).filter(({ p }) => p.id === piece.id && p.clipId === piece.clipId && p.s < piece.e && p.e > piece.s) : [];
    const next = same >= 0 ? same : (near !== undefined && overlapping.find(({ p }) => near >= p.s - 1e-6 && near <= p.e + 1e-6) || overlapping[0])?.k ?? -1;
    if (next < 0) throw new Error('Those words have changed. Select them again.');
    return next;
  };
  if (edit.kind === 'cutWords' || edit.kind === 'bleep') return { ...edit, spans: edit.spans.map(s => ({ ...s, piece: index(s.piece, (s.s + s.e) / 2) })) };
  if (edit.kind === 'move' && edit.words) {
    const { last, s, e, at } = edit.words, count = from.pieces?.length ?? 0;
    return { ...edit, piece: index(edit.piece, s), to: edit.to >= count ? to.pieces?.length ?? 0 : index(edit.to, at), words: { ...edit.words, last: index(last, e) } };
  }
  if (edit.kind === 'restoreWords' && edit.cut) {
    const was = from.cutPieces?.find(t => t.id === edit.cut), tombs = to.cutPieces ?? [];
    const now = tombs.find(t => t.id === edit.cut) ?? (was ? tombs.find(t => t.piece.id === was.piece.id && t.piece.clipId === was.piece.clipId && t.piece.s < was.piece.e && t.piece.e > was.piece.s) : undefined);
    if (now) return { ...edit, cut: now.id, piece: tombIndex(now, to.pieces ?? []) };
    // Restored meanwhile into a live piece: put back the same words there.
    if (was) { const at = to.pieces?.findIndex(p => p.id === was.piece.id && p.clipId === was.piece.clipId && p.s < was.piece.e && p.e > was.piece.s) ?? -1;
      if (at >= 0) { const { cut: _c, ...rest } = edit; return { ...rest, piece: at }; } }
    throw new Error('Those words have changed. Select them again.');
  }
  if (edit.kind === 'restoreWords') return { ...edit, piece: index(edit.piece) };
  return edit;
}
const wordsOf = (shoot: Shoot, piece: Piece) => ((piece as Piece & { timedWords?: Word[] }).timedWords ?? shoot.clips.find(c => c.id === piece.clipId)?.transcript?.flatMap(s => s.words) ?? []);
/** SCRIPT1: the document the person sees at once, before main saves it: cuts strike (a piece whose every word is cut
 * stays listed as a cut piece), restores put back the marker or only the chosen words of it. Mirrors editWords. */
export function projectWords(shoot: Shoot, version: CutVersion, edit: CutEdit): CutVersion {
  let pieces: (Piece & { removed: Marker[]; tomb?: Tomb })[] = (version.pieces ?? []).map(p => ({ ...p, removed: [...p.removed ?? []] }));
  let tombs: Tomb[] = [...(version.cutPieces ?? [])];
  if (edit.kind === 'cutWords') for (const span of edit.spans) {
    const piece = pieces[span.piece];
    if (!piece) throw new Error('Select spoken words in this edit.');
    const words = wordsOf(shoot, piece).filter(w => w.s < span.e && w.e > span.s);
    if (!words.length) throw new Error('This selection has no measured words to cut safely.');
    let s = Math.min(...words.map(w => w.s)), e = Math.max(...words.map(w => w.e));
    if (piece.removed.some(g => g.s <= s && g.e >= e)) continue;
    const transcript = shoot.clips.find(c => c.id === piece.clipId)?.transcript?.flatMap(s => s.words) ?? [];
    const own = transcript.filter(w => w.e > piece.s && w.s < piece.e);
    const whole = span.s <= piece.s && span.e >= piece.e || own.length > 0 && own.every(w => w.s < e && w.e > s);
    const low = whole ? piece.s : Math.max(piece.s, s - .04, ...transcript.filter(w => w.e <= s).map(w => w.e));
    const high = whole ? piece.e : Math.min(piece.e, e + .04, ...transcript.filter(w => w.s >= e).map(w => w.s));
    let ranges = [{ s: low, e: high }], text = words.map(w => w.w).join(' ');
    // Adjacent or overlapping word cuts are one restorable run, as main keeps them.
    for (const prior of (piece.removed as Marker[]).filter(r => r.kind === 'cut' && r.s <= e && r.e >= s)) {
      piece.removed.splice(piece.removed.indexOf(prior), 1);
      s = Math.min(s, prior.s); e = Math.max(e, prior.e); ranges = [...ranges, ...(prior.ranges ?? [prior])];
      text = transcript.filter(w => w.s < e && w.e > s).map(w => w.w).join(' ');
    }
    piece.removed.push({ s, e, kind: 'cut', text, ranges } as Marker);
    piece.removed.sort((a, b) => a.s - b.s);
  }
  if (edit.kind === 'restoreWords') {
    const tomb = edit.cut ? tombs.find(t => t.id === edit.cut) : undefined;
    if (edit.cut && !tomb) throw new Error('Those words have changed. Select them again.');
    let piece = tomb ? { ...tomb.piece, removed: [...(tomb.piece.removed ?? [])] as Marker[] } : pieces[edit.piece];
    if (piece) {
      const marker = (piece.removed as Marker[]).find(g => Math.abs(g.s - edit.at) <= 1e-7);
      if (marker) {
        const all = wordsOf(shoot, piece), own = all.filter(w => w.s < marker.e && w.e > marker.s);
        const chosen = Number.isFinite(edit.s) && Number.isFinite(edit.e) ? own.filter(w => w.s < edit.e! && w.e > edit.s!) : own;
        const rest = (piece.removed as Marker[]).filter(g => g !== marker);
        if (marker.kind === 'cut' && chosen.length && chosen.length < own.length) {
          const cs = Math.min(...chosen.map(w => w.s)), ce = Math.max(...chosen.map(w => w.e));
          const low = Math.max(cs - .04, ...all.filter(w => w.e <= cs).map(w => w.e)), high = Math.min(ce + .04, ...all.filter(w => w.s >= ce).map(w => w.s));
          const ranges = marker.ranges ?? [marker], clip = (a: number, b: number) => ranges.map(r => ({ s: Math.max(r.s, a), e: Math.min(r.e, b) })).filter(r => r.e > r.s);
          const side = (list: Word[], a: number, b: number) => list.length ? [{ s: Math.min(...list.map(w => w.s)), e: Math.max(...list.map(w => w.e)), kind: 'cut' as const, text: list.map(w => w.w).join(' '), ranges: clip(a, b) }] : [];
          rest.push(...side(own.filter(w => !chosen.includes(w) && w.e <= cs + 1e-9), -Infinity, low), ...side(own.filter(w => !chosen.includes(w) && w.s >= ce - 1e-9), high, Infinity));
          rest.sort((a, b) => a.s - b.s);
        }
        piece = { ...piece, removed: rest };
        if (tomb) {
          tombs = tombs.filter(t => t !== tomb);
          const at = tombIndex(tomb, pieces);
          pieces.splice(at, 0, { ...piece, tomb });
        } else pieces[edit.piece] = piece as typeof pieces[number];
      }
    }
  }
  let cursor = 0;
  const kept: typeof pieces = [];
  for (const piece of pieces) {
    if (keptLength(piece) > 1e-6) { kept.push(piece); continue; }
    // Every word cut: the piece stays listed, struck, where it sat.
    const prior = kept.at(-1), { tomb: _t, ...plain } = piece;
    tombs.push({ id: piece.tomb?.id ?? `local-${Math.random().toString(36).slice(2, 10)}`, at: kept.length, after: prior ? { id: prior.id, clipId: prior.clipId } : null, piece: plain });
  }
  const placed = kept.map(piece => {
    const kept = keptLength(piece), { tomb, ...plain } = piece;
    const original = tomb?.piece ?? version.pieces?.find(p => identity(p) === identity(piece)) ?? piece;
    const originalKept = keptLength({ ...original, removed: tomb ? (original.removed ?? []).filter(r => r.kind !== 'cut') : original.removed });
    const scale = originalKept > 0 ? (original.lengthS ?? originalKept) / originalKept : 1;
    const lengthS = kept * scale, timelineS = cursor; cursor += lengthS;
    return { ...plain, lengthS, timelineS };
  });
  if (!placed.length) throw new Error('A cut cannot be empty. Keep at least one word or piece.');
  // Cut pieces that were not touched keep their place relative to the pieces around them.
  const out: CutVersion = { ...version, pieces: placed, lengthS: cursor };
  if (tombs.length) out.cutPieces = tombs.map(t => ({ ...t, at: tombIndex(t, placed) })); else delete out.cutPieces;
  return out;
}
/** SCRIPT2: the document the person sees at once while a move saves: the words' pieces split at the gaps around them
 * (and where they land), then the block of them put back before the landing piece. Mirrors movePiece with words; main
 * snaps each split onto the frame grid, so these halves are close, not exact, until the save lands. */
export function projectMove(shoot: Shoot, version: CutVersion, edit: CutEdit): CutVersion {
  if (edit.kind !== 'move' || !edit.words) return version;
  const pieces = version.pieces ?? [], { last, s, e, at } = edit.words;
  /** Where piece i splits for clip seconds `t`: before the word starting there, after the word ending there; null at its edges. */
  const point = (i: number, t: number | undefined): number | null => {
    const piece = pieces[i];
    if (!piece || t === undefined || piece.kind !== 'voice') return null;
    const all = wordsOf(shoot, piece).filter(w => w.e > piece.s && w.s < piece.e).sort((a, b) => a.s - b.s);
    const starts = all.findIndex(w => Math.abs(w.s - t) < 1e-6), ends = all.findIndex(w => Math.abs(w.e - t) < 1e-6);
    const after = starts >= 0 ? starts - 1 : ends >= 0 ? ends : all.findIndex((w, k) => w.e <= t && (all[k + 1]?.s ?? Infinity) >= t);
    if (after < 0 || after >= all.length - 1) return null;
    return (all[after].e + all[after + 1].s) / 2;
  };
  const cuts = [{ i: edit.piece, at: point(edit.piece, s) }, { i: last, at: point(last, e) }, { i: edit.to, at: point(edit.to, at) }];
  type Half = Piece & { old: number };
  const halves: Half[] = pieces.flatMap((piece, old) => {
    const marks = [...new Set(cuts.filter(c => c.i === old && c.at !== null).map(c => c.at!))].sort((a, b) => a - b);
    const edges = [piece.s, ...marks, piece.e], whole = keptLength(piece as Piece & { removed: Marker[] });
    return edges.slice(0, -1).map((from, k) => {
      const half = { ...piece, s: from, e: edges[k + 1], removed: (piece.removed ?? []).filter(m => (k === 0 || m.s >= from) && (k === edges.length - 2 || m.s < edges[k + 1])) };
      return { ...half, old, lengthS: marks.length && whole > 0 ? (piece.lengthS ?? whole) * keptLength(half) / whole : piece.lengthS };
    });
  });
  const lo = cuts[0].at ?? -Infinity, hi = cuts[1].at ?? Infinity, lands = cuts[2].at ?? -Infinity;
  const moving = halves.filter(h => h.old >= edit.piece && h.old <= last && (h.old !== edit.piece || h.s >= lo - 1e-9) && (h.old !== last || h.e <= hi + 1e-9));
  if (!moving.length) return version;
  const target = edit.to >= pieces.length ? null : halves.find(h => h.old === edit.to && h.s >= lands - 1e-9) ?? halves.find(h => h.old > edit.to) ?? null;
  const rest = halves.filter(h => !moving.includes(h)), at2 = target ? rest.indexOf(target) : rest.length;
  if (target && moving.includes(target)) return version;
  rest.splice(at2 < 0 ? rest.length : at2, 0, ...moving);
  let cursor = 0;
  const placed = rest.map(({ old: _o, ...h }) => { const timelineS = cursor; cursor += h.lengthS ?? 0; return { ...h, timelineS }; });
  const out: CutVersion = { ...version, pieces: placed };
  if (version.cutPieces) out.cutPieces = version.cutPieces.map(t => ({ ...t, at: tombIndex(t, placed) }));
  return out;
}
export function correctWords(shoot: Shoot, clipId: string, fix: { s: number; e: number; text: string }): Shoot {
  const tokens = fix.text.trim().split(/\s+/).filter(Boolean), weight = tokens.reduce((n,w) => n + Array.from(w).length,0);
  let at = fix.s;
  const words = tokens.map((w,i) => { const s = at; at = i === tokens.length-1 ? fix.e : at + (fix.e-fix.s)*Array.from(w).length/weight; return {s,e:at,w,byHand:true}; });
  return { ...shoot, clips: shoot.clips.map(clip => {
    if (clip.id !== clipId || !clip.transcript) return clip;
    let inserted = false;
    return { ...clip, transcript: clip.transcript.map(segment => {
      const overlap = segment.words.some(w => w.s < fix.e && w.e > fix.s);
      const kept = segment.words.filter(w => w.s >= fix.e || w.e <= fix.s);
      if (overlap && !inserted) { kept.push(...words); inserted = true; }
      kept.sort((a,b) => a.s-b.s);
      return { ...segment, words: kept, text: kept.map(w => w.w).join(' ') };
    }) };
  }) };
}

/** Saves survive closing the sheet. New input waits in the next burst, never on IPC. */
export class DocumentQueue<T> {
  private pending: T[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  constructor(private save: (items: T[]) => Promise<void>, private failed: (cause: unknown) => void, private busy: (value: boolean) => void) {}
  add(item: T) { this.pending.push(item); this.busy(true); clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), 250); }
  async flush() {
    clearTimeout(this.timer);
    if (this.running || !this.pending.length) return;
    this.running = true;
    const items = this.pending.splice(0);
    try { await this.save(items); }
    catch (cause) { this.pending = []; this.failed(cause); }
    finally { this.running = false; if (this.pending.length) await this.flush(); else this.busy(false); }
  }
}

/** SCRIPT1: one save queue for every kind of word in the Script panel: camera cuts and restores, voiceover cuts,
 * restores and fixes, and camera spelling fixes (the shoot's transcript). Edits go to main in order, one burst per
 * version, each against the version the last one saved, so a camera edit and a voice edit never race each other.
 * `build` turns a job into the edit for `draft` (the saved version plus this burst's earlier edits); it returns
 * "wait" when its target is still only on screen (a cut made in this same burst), which ends the burst there.
 * Picture edits and voice edits save as separate versions, in order: a picture edit moves the voice with it when
 * it saves, and a voice edit in the same version would skip that. */
export type ScriptJob =
  | { kind: 'edit'; label: string; group?: 'picture' | 'voice'; build: (draft: CutVersion) => CutEdit | null | 'wait'; project?: (draft: CutVersion, edit: CutEdit) => CutVersion; alone?: boolean }
  | { kind: 'fix'; clipId: string; fix: { s: number; e: number; text: string }; after: Shoot };
export class ScriptQueue {
  private pending: ScriptJob[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | null = null;
  private waiters: (() => void)[] = [];
  constructor(public confirmed: CutVersion, private io: {
    save: (edit: CutEdit, base: number) => Promise<CutVersion>;
    fix: (clipId: string, fixes: { s: number; e: number; text: string }[]) => Promise<Shoot>;
    saved: (version: CutVersion | null, shoot: Shoot | null) => void;
    failed: (cause: unknown) => void;
    busy: (value: boolean) => void;
    /** The edit's newest saved revision, whole, to build a refused burst again on. */
    latest?: () => Promise<CutVersion | null>;
    /** How a stretch of transcript words reads (the panel passes transcriptText). */
    text?: (words: string[]) => string;
  }, private delay = 250) {}
  get idle() { return !this.running && !this.pending.length; }
  add(job: ScriptJob) { this.pending.push(job); this.io.busy(true); clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), this.delay); }
  /** Saves everything queued now, and resolves when the queue is idle. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.running && this.pending.length) this.running = this.run().finally(() => {
      this.running = null;
      if (this.pending.length) void this.flush(); else { this.io.busy(false); this.waiters.splice(0).forEach(done => done()); }
    });
    if (this.idle) return Promise.resolve();
    return new Promise(done => this.waiters.push(done));
  }
  private async run() {
    while (this.pending.length) {
      const burst = this.pending.splice(0);
      try {
        // Spelling fixes of one clip share one call; the newest overlapping fix wins.
        const fixes = new Map<string, { s: number; e: number; text: string }[]>();
        let shoot: Shoot | null = null;
        for (const job of burst) if (job.kind === 'fix') {
          const prior = fixes.get(job.clipId) ?? [], overlap = prior.filter(f => f.s < job.fix.e && f.e > job.fix.s);
          if (!overlap.length) { fixes.set(job.clipId, [...prior, job.fix]); continue; }
          const s = Math.min(job.fix.s, ...overlap.map(f => f.s)), e = Math.max(job.fix.e, ...overlap.map(f => f.e));
          const words = job.after.clips.find(clip => clip.id === job.clipId)?.transcript?.flatMap(segment => segment.words).filter(word => word.s < e && word.e > s) ?? [];
          fixes.set(job.clipId, [...prior.filter(f => !overlap.includes(f)), { s, e, text: (this.io.text ?? (w => w.map(x => x.trim()).filter(Boolean).join(' ')))(words.map(word => word.w)) }]);
        }
        for (const [clipId, list] of fixes) shoot = await this.io.fix(clipId, list);
        const jobs = burst.filter((job): job is Extract<ScriptJob, { kind: 'edit' }> => job.kind === 'edit');
        // Something else may commit to the edit meanwhile (a background follow-on, another window). Every job is
        // built from identities (pieces, take time, cut ids), so it is built again on the newest revision, once.
        for (let attempt = 0; ; attempt++) {
          let draft = this.confirmed, used = jobs.length;
          const edits: CutEdit[] = [], labels: string[] = [];
          for (let i = 0; i < jobs.length; i++) {
            if (i && ((jobs[i].group ?? 'voice') !== (jobs[0].group ?? 'voice') || jobs[i].alone)) { used = i; break; }
            const built = jobs[i].build(draft);
            if (built === 'wait') {
              // Its target is saved by this burst: it goes next, against what this burst saves.
              if (edits.length) { used = i; break; }
              throw new Error('Those words have changed. Select them again.');
            }
            if (!built) continue;
            edits.push(built); labels.push(jobs[i].label);
            if (jobs[i].project) draft = jobs[i].project!(draft, built);
            // SCRIPT2: a move is its own version (one undo), and nothing is built on its guessed halves.
            if (jobs[i].alone) { used = i + 1; break; }
          }
          if (!edits.length) { this.pending.unshift(...jobs.slice(used)); if (shoot) this.io.saved(null, shoot); break; }
          const label = [...new Set(labels)].length === 1 ? labels[0] : 'Edited the script';
          try { this.confirmed = await this.io.save(edits.length === 1 ? edits[0] : { kind: 'batch', edits, label }, this.confirmed.version); }
          catch (cause) {
            const fresh = attempt ? null : await this.io.latest?.().catch(() => null);
            if (!fresh || fresh.version === this.confirmed.version) throw cause;
            this.confirmed = fresh; continue;
          }
          this.pending.unshift(...jobs.slice(used));
          this.io.saved(this.confirmed, shoot);
          break;
        }
      } catch (cause) {
        this.pending = [];
        this.io.failed(cause);
      }
    }
  }
}
