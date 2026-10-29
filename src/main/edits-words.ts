import { randomUUID } from "node:crypto";
import { syncFxMetadata, layoutRangeAdvance } from "./edits-fx";
import { remapLayoutRanges } from '../shared/layout-presets';
import type { CutEdit, CutVersion, Word } from "../shared/schema";
import { cutPieceGroups, sourceWords, splitCutItem, type CutItem } from "./export";
import { tightenEnergyPauses } from "./framing";
import { resolveReelPieces } from "./reel";
import { finishStoredVersion, renderStoredPreview, type StoredVersion } from "./sidekick";
import { runActivity } from "./activity";
import * as titles from "./titles";

type Span = { s: number; e: number };
type Removal = NonNullable<NonNullable<CutVersion["pieces"]>[number]["removed"]>[number] & {
  // Exact source holes include the safe audio guard. Keeping them with their
  // marker makes overlapping cuts and restores independent and lossless.
  ranges?: Span[];
};
type Item = Omit<CutItem, "removed"> & { removed?: Removal[] };
type WordEdit = Extract<CutEdit, { kind: "cutWords" | "restoreWords" | "keepFiller" | "removeFillers" | "tightenPauses" }>;
// CutItem's older private type still says ClipFiller, though the public schema
// and all consumers accept cut markers. Keep that adaptation at this boundary.
const cutItems = (items: Item[]) => items as CutItem[];
const rate = (item: Item) => item.clipFpsR.num / item.clipFpsR.den;
const spanOf = (item: Item): Span => ({ s: item.inFrames / rate(item), e: item.outFrames / rate(item) });
const valid = (span: Span) => Number.isFinite(span.s) && Number.isFinite(span.e) && span.e > span.s;
function subtract(spans: Span[], holes: Span[]): Span[] {
  return holes.reduce((remaining, hole) => remaining.flatMap(span => hole.s >= span.e || hole.e <= span.s ? [span] :
    [{ s: span.s, e: Math.min(span.e, hole.s) }, { s: Math.max(span.s, hole.e), e: span.e }].filter(valid)), spans);
}
function union(spans: Span[]): Span[] {
  const result: Span[] = [];
  for (const span of spans.filter(valid).sort((a, b) => a.s - b.s)) {
    const last = result.at(-1);
    if (last && span.s <= last.e + 1e-7) last.e = Math.max(last.e, span.e);
    else result.push({ ...span });
  }
  return result;
}
function slice(item: Item, spans: Span[], fps: number): Item[] {
  const source = spanOf(item), scale = item.durTimelineFrames / ((source.e - source.s) * fps);
  return spans.map(span => ({ ...item, inFrames: span.s * rate(item), outFrames: span.e * rate(item),
    durTimelineFrames: (span.e - span.s) * fps * scale, removed: undefined }));
}
function wordsFor(assembly: StoredVersion["assembly"], item: Item): Word[] {
  if (!item.seg || item.seg.lineIndex === null) return [];
  return sourceWords(assembly.shoot, item.seg);
}
// Infer legacy filler holes using the very same edge/pause code that made them.
function legacyRanges(marker: Removal, items: Item[], fps: number): Span[] {
  const first = items[0], last = items.at(-1)!;
  const domain = { s: Math.min(spanOf(first).s, marker.s), e: Math.max(spanOf(last).e, marker.e) };
  if (!first.seg || marker.kind === "cut") return [marker];
  const base = slice(first, [domain], fps)[0];
  base.seg = { ...first.seg, clip: { ...first.seg.clip, fillers: [marker as import("../shared/schema").ClipFiller] } };
  const normal = splitCutItem(cutItems([base])[0], { fps });
  const punchy = marker.kind === "pause" ? tightenEnergyPauses(cutItems([base]), fps) : normal;
  const candidates = union([...subtract([domain], normal.map(spanOf)), ...subtract([domain], punchy.map(spanOf))]);
  return subtract(candidates, items.map(spanOf));
}
/** SCRIPT1: one cut on a piece's kept items. Adjacent or overlapping word cuts are one restorable run. Returns
 * the kept items (possibly none) and every removal marker the piece now has, so a cut that empties the piece
 * keeps its markers too (it becomes a tombstone, never a vanished piece). */
function cutGroup(items: Item[], marker: Removal, holes: Span[], fps: number): { items: Item[]; removed: Removal[] } {
  const removed: Removal[] = items.flatMap(item => item.removed ?? []).map(r => ({ ...r }));
  if (!items.some(item => holes.some(hole => hole.s < spanOf(item).e && hole.e > spanOf(item).s))) return { items, removed };
  const next = items.flatMap(item => slice(item, subtract([spanOf(item)], holes), fps));
  const merged: Span[] = [];
  if (marker.kind === "cut") {
    const joined = removed.filter(r => r.kind === "cut" && r.s <= marker.e && r.e >= marker.s);
    for (const prior of joined) {
      removed.splice(removed.indexOf(prior), 1);
      marker = { ...marker, s: Math.min(marker.s, prior.s), e: Math.max(marker.e, prior.e) };
      merged.push(...(prior.ranges ?? [prior]));
    }
  } else {
    const prior = removed.find(r => r.kind === marker.kind && r.s === marker.s && r.e === marker.e);
    if (prior) { removed.splice(removed.indexOf(prior), 1); merged.push(...(prior.ranges ?? [prior])); }
  }
  // A cut that empties the piece records exactly what was kept (plus the runs it joined), so putting it all
  // back gives the same spans. Otherwise the marker keeps its holes, as before.
  const ranges = union(next.length ? [...holes, ...merged] : [...items.map(spanOf), ...merged]);
  const all = [...removed, { ...marker, ranges }].sort((a, b) => a.s - b.s);
  if (next.length) next[0].removed = all;
  return { items: next, removed: all };
}
function addRemoval(items: Item[], marker: Removal, holes: Span[], fps: number): Item[] {
  return cutGroup(items, marker, holes, fps).items;
}
const intersect = (spans: Span[], window: Span): Span[] => spans.map(s => ({ s: Math.max(s.s, window.s), e: Math.min(s.e, window.e) })).filter(valid);
/** SCRIPT1: put back one removal marker, or only the words of it inside `range` (the run splits around them, so
 * each side stays its own restorable cut). `current` are the kept items (none for a tombstone), `base` the item
 * new spans are sliced from. Restoring every word of a marker restores its exact holes. */
function restoreGroup(current: Item[], base: Item, removed: Removal[], marker: Removal, range: Span | undefined, words: Word[], domain: Span, fps: number): { items: Item[]; removed: Removal[] } {
  const rest = removed.filter(r => r !== marker), ranges = marker.ranges ?? [marker];
  const own = words.filter(w => w.s < marker.e && w.e > marker.s);
  const chosen = range ? own.filter(w => w.s < range.e && w.e > range.s) : own;
  let back = ranges;
  if (range && marker.kind === "cut" && chosen.length && chosen.length < own.length) {
    const cs = Math.min(...chosen.map(w => w.s)), ce = Math.max(...chosen.map(w => w.e));
    const low = Math.max(domain.s, cs - .04, ...words.filter(w => w.e <= cs).map(w => w.e));
    const high = Math.min(domain.e, ce + .04, ...words.filter(w => w.s >= ce).map(w => w.s));
    back = intersect(ranges, { s: low, e: high });
    const side = (list: Word[], window: Span) => list.length ? [{ s: Math.min(...list.map(w => w.s)), e: Math.max(...list.map(w => w.e)), kind: "cut" as const,
      text: list.map(w => w.w.trim()).join(" "), ranges: intersect(ranges, window) }] : [];
    rest.push(...side(own.filter(w => !chosen.includes(w) && w.e <= cs + 1e-9), { s: -Infinity, e: low }), ...side(own.filter(w => !chosen.includes(w) && w.s >= ce - 1e-9), { s: high, e: Infinity }));
  }
  rest.sort((a, b) => a.s - b.s);
  const spans = subtract(union([...current.map(spanOf), ...back]), rest.flatMap(r => r.ranges ?? [r]));
  const items = slice(base, spans, fps);
  if (items.length) items[0].removed = rest;
  return { items, removed: rest };
}

/** SCRIPT1: a piece whose every word was cut. It stays in the version, struck, where it sat, so Restore can put it
 * back exactly (its items, reel entry, attached b-roll, bleeps, controls and joins). Items are saved without their
 * clip copies; the clip is found again by id. */
export type PieceTomb = NonNullable<CutVersion["cutPieces"]>[number] & {
  items: (Omit<Item, "seg"> & { seg: (Omit<NonNullable<Item["seg"]>, "clip" | "speechWords"> & { clipId: string }) | null })[];
  removed: Removal[]; reel?: unknown; broll?: unknown[]; fx?: unknown; layout?: unknown; joins?: [unknown, unknown]; bleeps?: { s: number; e: number; sound: "beep" | "mute" }[];
};
const keyOf = (p: { id: string; clipId: string }) => `${p.id}\u0000${p.clipId}`;
/** Where a tombstone sits among `pieces`: after the piece it followed when it was cut, or at its saved index. */
export function tombIndex(tomb: { at: number; after?: { id: string; clipId: string } | null }, pieces: { id: string; clipId: string }[]): number {
  if (tomb.after) {
    const matches = pieces.map((p, i) => keyOf(p) === keyOf(tomb.after!) ? i + 1 : -1).filter(i => i >= 0);
    if (matches.length) return matches.sort((a, b) => Math.abs(a - tomb.at) - Math.abs(b - tomb.at))[0];
  } else if (tomb.after === null) return 0;
  return Math.max(0, Math.min(pieces.length, Number.isInteger(tomb.at) ? tomb.at : pieces.length));
}

export function editWords(root: string, cutId: string, version: number, edit: WordEdit): Promise<{ cutId: string; version: number }> {
  return runActivity({ kind: "edit", root, target: { cutId, version }, label: "Updating transcript", cancelable: true }, activity =>
    finishStoredVersion(root, cutId, version, true, async (record, assembly) => {
      const fps = assembly.template.fps;
      const advanceLayout=layoutRangeAdvance({...record,assembly});
      const previousPieces = record.pieces ?? resolveReelPieces(assembly.shoot, assembly.template, assembly.cutList, assembly.reel);
      const groups: Item[][] = cutPieceGroups(assembly.cutList).map(({ items }) => items.map(item => ({ ...item,
        seg: item.seg && item.seg.lineIndex !== null ? { ...item.seg, speechWords: wordsFor(assembly, item) } : item.seg,
        removed: item.removed?.map(marker => ({ ...marker, ranges: (marker as Removal).ranges ?? legacyRanges(marker, items, fps) })) })));
      // SCRIPT1: the spine as slots: every piece, with the pieces whose words were all cut (tombstones) where they sat.
      type Slot = { items: Item[]; old?: number; tomb?: PieceTomb; back?: PieceTomb };
      const tombs = ((record.cutPieces ?? []) as PieceTomb[]).map(tomb => ({ tomb, at: tombIndex(tomb, previousPieces) }));
      const slots: Slot[] = [];
      for (let index = 0; index <= groups.length; index++) {
        for (const { tomb } of tombs.filter(t => t.at === index)) slots.push({ items: [], tomb });
        if (index < groups.length) slots.push({ items: groups[index], old: index });
      }
      const live = (piece: number) => slots.find(slot => slot.old === piece);
      const hydrate = (tomb: PieceTomb): Item[] => tomb.items.map(({ seg, ...item }) => {
        if (!seg) return { ...item, seg: null } as Item;
        const { clipId, ...rest } = seg, clip = assembly.shoot.clips.find(c => c.id === clipId);
        if (!clip) throw new Error("That clip is no longer in this shoot, so its words can't come back.");
        const back = { ...item, seg: { ...rest, clip } } as Item;
        return back.seg && back.seg.lineIndex !== null ? { ...back, seg: { ...back.seg, speechWords: wordsFor(assembly, back) } } : back;
      });
      const entomb = (slot: Slot, removed: Removal[], before: Item[]) => {
        const old = slot.old!, piece = previousPieces[old];
        slot.tomb = { id: `cut-${randomUUID().slice(0, 8)}`, at: 0, piece: { ...piece, removed: removed.map(({ ranges: _r, ...m }) => m) },
          items: before.map(({ seg, ...item }) => ({ ...item, removed: undefined, seg: seg ? { ...(({ clip: _c, speechWords: _w, ...keep }) => keep)(seg), clipId: seg.clip.id } : null })),
          removed, reel: assembly.reel.cuts[old], broll: assembly.reel.broll.filter(o => o.voiceIndex === old), fx: record.pieceFx?.[old] ?? null,
          layout: record.layouts?.[old] ?? null, joins: [record.joins?.[old - 1] ?? null, record.joins?.[old] ?? null],
          bleeps: (record.bleeps ?? []).filter(b => b.piece === old).map(({ s, e, sound }) => ({ s, e, sound })) } as PieceTomb;
        delete slot.old;
      };
      let feedback: string;
      if (edit.kind === "cutWords") {
        if (!edit.spans.length) throw new Error("Select some words to cut first.");
        for (const span of edit.spans) {
          const piece = previousPieces[span.piece], slot = live(span.piece), items = slot?.items ?? [];
          if (!Number.isInteger(span.piece) || !piece || piece.kind !== "voice" || !valid(span)) throw new Error("Select spoken words in this cut.");
          if (!slot || !items.length) continue;
          const words = wordsFor(assembly, items[0]).filter(word => word.e > piece.s && word.s < piece.e);
          let chosen = words.filter(word => word.s < span.e && word.e > span.s);
          if (!chosen.length) throw new Error("This selection has no measured words to cut safely.");
          // Close over overlapping timings so no measured word is cut in half.
          let s = Math.min(...chosen.map(w => w.s)), e = Math.max(...chosen.map(w => w.e));
          for (;;) {
            chosen = words.filter(w => w.s < e && w.e > s);
            const low = Math.min(...chosen.map(w => w.s)), high = Math.max(...chosen.map(w => w.e));
            if (low === s && high === e) break;
            s = low; e = high;
          }
          const before = words.filter(w => w.e <= s), after = words.filter(w => w.s >= e);
          const low = Math.max(piece.s, s - .04, ...before.map(w => w.e));
          const high = Math.min(piece.e, e + .04, ...after.map(w => w.s));
          const whole = span.s <= piece.s && span.e >= piece.e || chosen.length === words.length;
          const marker: Removal = { s, e, kind: "cut", text: chosen.map(w => w.w.trim()).join(" ") };
          const result = cutGroup(items, marker, whole ? items.map(spanOf) : [{ s: low, e: high }], fps);
          if (result.items.length) slot.items = result.items;
          else { slot.items = []; entomb(slot, result.removed, items); }
        }
        feedback = "Cut selected words";
      } else if (edit.kind === "restoreWords" || edit.kind === "keepFiller") {
        const ask = edit as Extract<CutEdit, { kind: "restoreWords" }>;
        const range = Number.isFinite(ask.s) && Number.isFinite(ask.e) && ask.e! > ask.s! ? { s: ask.s!, e: ask.e! } : undefined;
        const slot = edit.kind === "restoreWords" && typeof ask.cut === "string" ? slots.find(x => x.tomb?.id === ask.cut) : live(edit.piece);
        const items = slot?.tomb ? hydrate(slot.tomb) : slot?.items;
        const removed = slot?.tomb ? slot.tomb.removed.map(r => ({ ...r })) : items?.flatMap(item => item.removed ?? []) ?? [];
        const marker = Number.isFinite(edit.at) ? removed.find(r => Math.abs(r.s - edit.at) < 1e-7) : undefined;
        if (!slot || !marker || !items?.length || !slot.tomb && !Number.isInteger(edit.piece)) throw new Error("Those words are no longer listed as removed. Open the cut again and try again.");
        const clipId = slot.tomb ? slot.tomb.piece.clipId : previousPieces[edit.piece].clipId;
        const domain = slot.tomb ? { s: slot.tomb.piece.s, e: slot.tomb.piece.e } : { s: Math.min(...items.map(i => spanOf(i).s), ...removed.flatMap(r => (r.ranges ?? [r]).map(x => x.s))), e: Math.max(...items.map(i => spanOf(i).e), ...removed.flatMap(r => (r.ranges ?? [r]).map(x => x.e))) };
        const result = restoreGroup(slot.tomb ? [] : items, items[0], removed, marker, range, wordsFor(assembly, items[0]), domain, fps);
        if (slot.tomb && result.items.length) {
          // The tombstone comes back to life: its own reel entry, b-roll, bleeps, controls and joins.
          slot.back = slot.tomb; delete slot.tomb; slot.items = result.items;
        } else if (slot.tomb) slot.tomb = { ...slot.tomb, removed: result.removed, piece: { ...slot.tomb.piece, removed: result.removed.map(({ ranges: _r, ...m }) => m) } };
        else slot.items = result.items;
        if (marker.kind !== "cut") record.keptFillers = [...new Set([...(record.keptFillers ?? []), `${clipId}@${marker.s.toFixed(2)}`])];
        feedback = marker.kind === "pause" ? "Put back a pause" : "Put back words";
      } else {
        if (edit.kind === "removeFillers") record.keptFillers = [];
        for (const slot of slots) {
          const initial = slot.items;
          if (!initial[0]?.seg || initial[0].seg.lineIndex === null) continue;
          let items = initial;
          const words = wordsFor(assembly, items[0]);
          const clip = items[0].seg!.clip;
          const fillers = [...clip.fillers ?? []];
          if (edit.kind === "removeFillers") for (const word of words) {
            if (/^(?:u+m+|u+h+|e+r+m*|a+h+|h+m+|m{2,})$/i.test(word.w.replace(/[^a-z]/gi, "")) && !fillers.some(f => f.s < word.e && f.e > word.s)) fillers.push({ s: word.s, e: word.e, kind: "word", text: word.w });
          }
          if (edit.kind === "tightenPauses") for (let w = 1; w < words.length; w++) {
            const s = words[w - 1].e, e = words[w].s;
            if (e - s > .3 && !fillers.some(f => f.kind === "pause" && f.s <= s && f.e >= e)) fillers.push({ s, e, kind: "pause" });
          }
          for (const marker of fillers.filter(f => edit.kind === "removeFillers" ? f.kind !== "pause" : f.kind === "pause")) {
            if (!items.length) break;
            const base = items[0], domain = { s: Math.min(...items.map(i => spanOf(i).s)), e: Math.max(...items.map(i => spanOf(i).e)) };
            const probe = slice(base, [domain], fps)[0];
            probe.seg = { ...base.seg!, speechWords: edit.kind === "removeFillers" ? undefined : words,
              clip: { ...clip, transcript: [{ s: domain.s, e: domain.e, text: words.map(w => w.w).join(" "), words }], fillers: [marker] } };
            const after = edit.kind === "tightenPauses" ? tightenEnergyPauses(cutItems([probe]), fps) : splitCutItem(cutItems([probe])[0], { fps });
            const holes = subtract([domain], after.map(spanOf));
            // Store actual holes rather than the full silence budget as removed time.
            const result = cutGroup(items, marker, holes, fps);
            if (!result.items.length) { entomb(slot, result.removed, items); items = []; break; }
            items = result.items;
          }
          slot.items = items;
        }
        feedback = edit.kind === "removeFillers" ? "Removed fillers" : "Tightened pauses";
      }
      type Kept = Slot;
      const retained: Kept[] = slots.filter(slot => slot.items.length);
      if (!retained.length) throw new Error("A cut cannot be empty. Keep at least one word or piece.");
      let offsetFrames = 0;
      assembly.cutList = cutItems(retained.flatMap(({ items }, piece) => items.map(item => {
        const next = { ...item, piece, offsetFrames }; offsetFrames += item.durTimelineFrames; return next;
      })));
      record.lengthS = offsetFrames / fps;
      const indices = new Map(retained.flatMap((slot, index) => slot.old === undefined ? [] : [[slot.old, index] as [number, number]]));
      const back = (slot: Kept, index: number) => (slot.back?.broll ?? []).map(o => ({ ...(o as typeof assembly.reel.broll[number]), voiceIndex: index }));
      assembly.reel = { ...assembly.reel, cuts: retained.map((slot, index) => ({ ...(slot.old !== undefined ? assembly.reel.cuts[slot.old] : slot.back!.reel as typeof assembly.reel.cuts[number]),
        s: spanOf(slot.items[0]).s, e: spanOf(slot.items.at(-1)!).e, offsetS: assembly.cutList.find(c => c.piece === index)!.offsetFrames / fps,
        lengthS: slot.items.reduce((n, i) => n + i.durTimelineFrames / fps, 0), beatDeltaS: 0, beatS: null })),
        broll: [...assembly.reel.broll.flatMap(overlay => indices.has(overlay.voiceIndex) ? [{ ...overlay, voiceIndex: indices.get(overlay.voiceIndex)! }] : []), ...retained.flatMap(back)],
        music: assembly.reel.music ? { ...assembly.reel.music } : undefined };
      assembly.reel.model = { ...assembly.reel.model, voice: assembly.reel.cuts.map(({ id }) => ({ id })), broll: assembly.reel.broll.map(({ id, over }) => ({ id, over })) };
      record.voice = assembly.reel.cuts.map(({ id }) => id);
      record.broll = assembly.reel.broll.map(({ id, over }) => ({ id, over }));
      record.pieces = resolveReelPieces(assembly.shoot, assembly.template, assembly.cutList, assembly.reel).map((piece, index) => {
        const items = retained[index].items, measured = wordsFor(assembly, items[0]);
        return { ...piece, words: piece.kind === "voice" ? measured.filter(w => items.some(i => w.s >= spanOf(i).s - 1e-6 && w.e <= spanOf(i).e + 1e-6)).map(w => w.w.trim()).join(" ") : piece.words,
          removed: items.flatMap(i => i.removed ?? []).map(marker => marker.kind === "cut" ? { ...marker, text: measured.filter(w => w.s < marker.e && w.e > marker.s).map(w => w.w.trim()).join(" ") } : marker) };
      });
      if (record.bleeps || retained.some(slot => slot.back?.bleeps?.length)) record.bleeps = [...(record.bleeps ?? []).flatMap(b => indices.has(b.piece) ? [{ ...b, piece: indices.get(b.piece)! }] : []),
        ...retained.flatMap((slot, index) => (slot.back?.bleeps ?? []).map(b => ({ ...b, piece: index })))].sort((a, b) => a.piece - b.piece || a.s - b.s);
      if (record.lowerThirds) record.lowerThirds = record.lowerThirds.filter(t => t.s < record.lengthS).map(t => ({ ...t, e: Math.min(t.e, record.lengthS) }));
      if (record.pieceFx || retained.some(slot => slot.back?.fx)) record.pieceFx = retained.map(slot => (slot.old !== undefined ? record.pieceFx?.[slot.old] : slot.back!.fx as NonNullable<typeof record.pieceFx>[number]) ?? null);
      if (record.layouts || retained.some(slot => slot.back?.layout)) {
        const kept = retained.map((slot, i) => ({ slot, i })).filter(({ slot }) => slot.old !== undefined);
        record.layouts = [...retained.map(slot => { const own = (slot.old !== undefined ? record.layouts?.[slot.old] : slot.back!.layout) as NonNullable<typeof record.layouts>[number] | undefined; return own?.kind === 'scene' ? null : own ?? null; }),
          ...remapLayoutRanges(record.layouts, kept.map(({ slot, i }) => ({ oldS: previousPieces[slot.old!].timelineS, oldE: previousPieces[slot.old!].timelineS + previousPieces[slot.old!].lengthS, s: record.pieces![i].timelineS, e: record.pieces![i].timelineS + record.pieces![i].lengthS })), advanceLayout)];
      }
      if (record.joins || retained.some(slot => slot.back?.joins?.some(Boolean))) record.joins = retained.slice(0, -1).map((slot, index) => {
        const next = retained[index + 1];
        if (slot.old !== undefined && next.old !== undefined) return next.old === slot.old + 1 ? record.joins?.[slot.old] ?? null : null;
        return ((next.back ? next.back.joins?.[0] : slot.back?.joins?.[1]) ?? null) as NonNullable<typeof record.joins>[number];
      });
      // The tombstones, each before the piece it now precedes, after the piece it now follows.
      const cutPieces: PieceTomb[] = [];
      let seen = 0;
      for (const slot of slots) {
        if (slot.items.length) { seen++; continue; }
        if (!slot.tomb) continue;
        const prior = seen ? record.pieces[seen - 1] : null;
        cutPieces.push({ ...slot.tomb, at: seen, after: prior ? { id: prior.id, clipId: prior.clipId } : null });
      }
      if (cutPieces.length) record.cutPieces = cutPieces; else delete record.cutPieces;
      // Changing Energy later must never revive the pre-edit source spans.
      delete (record as StoredVersion & { energyBaseCuts?: CutItem[] }).energyBaseCuts;
      record.assembly = assembly;
      record.feedback = feedback;
      if (assembly.reel.music) record.voiceMixNeedsMeasure = true;
      syncFxMetadata(record);
      if (record.titles) record.titles = await titles.rebuildSubtitles(assembly.shoot, record, assembly.template, assembly.cutList);
      if (record.overlays?.some(o => o.graphic?.words?.length)) record.overlays = await (await import("./graphics/edit")).retimeGraphicOverlays(record);  // GFX1
      await renderStoredPreview(root, cutId, record, assembly);
      activity.signal.throwIfAborted();
      return { cutId, version: record.version };
    }));
}
