// PRO3b (docs/plans/produced/spike-v1.md, qa/PRO0/direction.md primitives 3, 5 and 7): motion moves in edit seconds,
// resolved on the draft they run on into edits precut already has. A punch or an exposure key becomes the clip's
// settings (pieceFx, its other settings kept), locked to the source frame under it; a cut on a word becomes two
// magnetic trims, the same pair a timeline edge drag makes (no new reorder path). Used by MCP (set_clip_punch,
// set_clip_exposure, cut_on_word, batch_edit) and by a Produce pass (produce-pass.ts).
import type { CutEdit, MotionEdit, PieceFx } from "../shared/schema";
import { timedCaptionWords } from "../shared/caption-words";
import { standardFrameRate } from "../shared/frame-rate";
import { planFx, validExposure, validPunches, type FxPlan } from "./edits-fx";
import { punchSourceAt } from "../shared/punch-keys";
import type { BatchStep, StoredVersion } from "./sidekick";

export const MOTION_KINDS = ["clipPunch", "clipExposure", "cutOnWord"] as const;
export const isMotionEdit = (edit: { kind: string }): edit is MotionEdit => (MOTION_KINDS as readonly string[]).includes(edit.kind);

const planOf = (record: StoredVersion) => planFx(record.assembly.cutList, record.assembly.template.fps, record);
/** The piece on the picture lane at reel second t (the later one inside a dissolve). */
function pieceAt(plan: FxPlan, t: number): number {
  const item = [...plan.items].reverse().find(i => t >= i.startS - 1e-6 && t < i.endS - 1e-6);
  if (!item) throw new Error(`Nothing is on the picture at ${t.toFixed(2)} s.`);
  return item.piece;
}
/** The source second the piece shows on the frame at reel second t (its own frame clock, as the export draws it). */
// CAP4: the one mapping (shared/punch-keys.ts), also used by the inspector's Punch row, so both write the same record.
function sourceAt(plan: FxPlan, piece: number, t: number, fps: number): number {
  return punchSourceAt(plan.items, piece, t, fps);
}

/** clipPunch / clipExposure: the clip's settings with its new list, as one pieceFx edit. */
export function motionFx(record: StoredVersion, edit: Extract<MotionEdit, { kind: "clipPunch" | "clipExposure" }>): CutEdit {
  const fps = record.assembly.template.fps, plan = planOf(record);
  const list = edit.kind === "clipPunch" ? edit.punches : edit.keys;
  if (list !== null && (!Array.isArray(list) || !list.length || list.some(k => !k || !Number.isFinite(k.atS)))) throw new Error("Give each key a time in edit seconds (atS), or null to clear them.");
  const piece = edit.piece ?? (list?.length ? pieceAt(plan, list[0].atS) : NaN);
  if (!Number.isInteger(piece) || !plan.items.some(i => i.piece === piece)) throw new Error("Choose a clip in this edit.");
  const fx: PieceFx = { ...record.pieceFx?.[piece] };
  if (edit.kind === "clipPunch") {
    const punches = edit.punches?.map(({ atS, ...p }) => ({ ...p, sourceS: sourceAt(plan, piece, atS, fps) }));
    if (punches && !validPunches(punches)) throw new Error("A punch scales 1 to 1.6, settles over 1 to 60 frames and creeps at most 0.005 a frame.");
    if (punches) fx.punches = punches; else delete fx.punches;
  } else {
    const keys = edit.keys?.map(k => ({ sourceS: sourceAt(plan, piece, k.atS, fps), levels: k.levels }));
    if (keys && !validExposure(keys)) throw new Error("An exposure key holds 1 to 30 levels, each 0.25 to 4 (1 is the picture as graded).");
    if (keys) fx.exposure = keys; else delete fx.exposure;
  }
  return { kind: "pieceFx", piece, fx };
}

/** cutOnWord: the two magnetic trims that put the cut into the incoming shot `frames` frames before the word, keeping
 * the edit's length. Each shot's edge can only move by whole frames of its own footage, so among the moves that keep
 * the length exact this takes the nearest that doesn't land later than asked (else the nearest). */
export function cutOnWordTrims(record: StoredVersion, edit: Extract<MotionEdit, { kind: "cutOnWord" }>): { edits: CutEdit[]; note: string; leadFrames: number } {
  // Frames of the finished video: an edit kept at a phone's average rate (59.89) exports at the standard one (EXP3).
  const fps = standardFrameRate(record.assembly.template.fps), plan = planOf(record), pieces = record.pieces ?? [];
  const words = timedCaptionWords(record.titles), word = words[edit.word];
  if (!word) throw new Error("Choose a caption word in this edit (read_captions index).");
  const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  if (edit.text !== undefined && clean(edit.text) !== clean(word.text)) throw new Error(`Caption word ${edit.word} is "${word.text}", not "${edit.text}".`);
  const lead = edit.frames ?? 1;
  if (!Number.isInteger(lead) || lead < 0 || lead > 60) throw new Error("Lead the word by 0 to 60 frames.");
  const wordFrame = Math.ceil(word.s * fps - 1e-6), want = wordFrame - lead;
  // The cut into each piece: where its first item starts, when the piece before is another piece.
  const cuts = plan.items.flatMap((item, i) => i && plan.items[i - 1].piece !== item.piece && !item.overlap ? [{ b: item.piece, a: plan.items[i - 1].piece, at: item.startS, i }] : []);
  const cut = edit.piece !== undefined ? cuts.find(c => c.b === edit.piece) : cuts.sort((x, y) => Math.abs(x.at - want / fps) - Math.abs(y.at - want / fps))[0];
  if (!cut) throw new Error(edit.piece !== undefined ? "That clip has no hard cut into it to move (a dissolve or the first clip)." : "This edit has no cut to move.");
  if (Math.abs(cut.at - want / fps) > 3) throw new Error(`The nearest cut is ${Math.abs(cut.at - word.s).toFixed(1)} s from "${word.text}"; name the clip to cut into.`);
  const A = pieces[cut.a], B = pieces[cut.b], items = record.assembly.cutList;
  const itemOf = (piece: number) => items.find((c, i) => (c.piece ?? i) === piece)!;
  const rate = (piece: number) => { const c = itemOf(piece).clipFpsR; return c.num / c.den; };
  const speed = (piece: number) => Math.abs(record.pieceFx?.[piece]?.speed ?? 1) || 1;
  const mode = edit.mode ?? (itemOf(cut.b).seg?.lineIndex == null && B.kind !== "voice" ? "slide" : "roll");
  const durationB = itemOf(cut.b).seg?.clip.meta?.durationS ?? Infinity;
  // The export joins each item's own frames (preview.ts joinFxVideo): the incoming shot's first frame is the frames before
  // it, each item's length rounded to frames, so it can land a frame off the edit clock's ceil. With a dissolve before
  // it, the clock's own frame.
  const last = plan.items[cut.i - 1], hard = !plan.items.slice(0, cut.i + 1).some(it => it.overlap);
  const before = plan.items.slice(0, cut.i - 1).reduce((n, it) => n + Math.round((it.endS - it.startS) * fps), 0);
  const frameOf = (d: number) => hard ? before + Math.round((last.endS - last.startS - d) * fps) : Math.ceil((cut.at - d) * fps - 1e-6);
  let best: { d: number; frame: number } | null = null;
  // d: how much earlier the cut lands (reel seconds); A's out moves by whole frames of A's footage, B's edge must too.
  for (let m = -Math.ceil(3 * rate(cut.a) * speed(cut.a)); m <= Math.ceil(3 * rate(cut.a) * speed(cut.a)); m++) {
    const d = m / rate(cut.a) / speed(cut.a), bFrames = d * speed(cut.b) * rate(cut.b);
    if (Math.abs(bFrames - Math.round(bFrames)) > 1e-6) continue;
    if (A.e - d * speed(cut.a) <= A.s + .5 / rate(cut.a)) continue;
    if (mode === "slide" ? B.e + d * speed(cut.b) > durationB + 1e-6 || B.e + d * speed(cut.b) <= B.s : B.s - d * speed(cut.b) < -1e-6 || B.s - d * speed(cut.b) >= B.e) continue;
    const frame = frameOf(d);
    // Never later than asked (a cut that lands after the lead loses the release), then nearest, then the smaller move.
    const late = (f: number) => f > want ? 1 : 0, off = (f: number) => Math.abs(f - want);
    if (!best || late(frame) < late(best.frame) || late(frame) === late(best.frame) && (off(frame) < off(best.frame) || off(frame) === off(best.frame) && Math.abs(d) < Math.abs(best.d))) best = { d, frame };
  }
  if (!best) throw new Error(`The shots either side of this cut can't move it there and keep the edit's length${mode === "slide" ? " (the incoming shot has no more footage at its end; try mode roll)" : " (the incoming shot has no earlier footage; try mode slide)"}.`);
  const round = (n: number) => Math.round(n * 1e6) / 1e6, d = best.d;
  const edits: CutEdit[] = [
    { kind: "trim", piece: cut.a, s: A.s, e: round(A.e - d * speed(cut.a)), magnetic: true },
    mode === "slide" ? { kind: "trim", piece: cut.b, s: B.s, e: round(B.e + d * speed(cut.b)), magnetic: true }
      : { kind: "trim", piece: cut.b, s: round(B.s - d * speed(cut.b)), e: B.e, magnetic: true },
  ];
  const leadFrames = wordFrame - best.frame;
  const note = `Cut ${d >= 0 ? "earlier" : "later"} by ${Math.abs(d).toFixed(3)} s: the next shot starts ${leadFrames} frame${leadFrames === 1 ? "" : "s"} before "${word.text}"${leadFrames !== lead ? ` (${lead} isn't possible without changing the length: each shot's edge moves in whole frames of its own footage, ${(1 / rate(cut.a)).toFixed(3)} s here)` : ""}.`;
  return { edits: Math.abs(d) < 1e-9 ? [] : edits, note, leadFrames };
}

/** One batch step for a motion move, resolved on the draft it runs on. */
export function motionStep(root: string, cutId: string, edit: MotionEdit): BatchStep {
  return async (version: number) => {
    const { loadDraftVersion, editCut } = await import("./sidekick");
    const record = await loadDraftVersion(root, cutId, version);
    const edits = edit.kind === "cutOnWord" ? cutOnWordTrims(record, edit).edits : [motionFx(record, edit)];
    for (const e of edits) version = (await editCut(root, cutId, version, e)).version;
    return { version };
  };
}
