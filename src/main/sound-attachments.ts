import type { CutVersion, ProducePieceRef, SfxItem, SoundAnchor } from '../shared/schema';
import type { StoredVersion } from './sidekick';
import type { FxPlan } from './edits-fx';
import { mapTime } from './time-map';
import type { MusicShapeMark } from '../shared/music-shape';

type SoundRecord = Pick<CutVersion, 'sfx' | 'overlays' | 'pieces' | 'pieceFx' | 'audio'> & Partial<Pick<CutVersion, 'joins' | 'transition' | 'warnings'>>;
function soundPieces(record: SoundRecord): ProducePieceRef[] {
  if (record.pieces?.length) return record.pieces;
  const assembly = (record as unknown as StoredVersion).assembly, pieces: ProducePieceRef[] = [];
  for (const [index, cut] of (assembly?.cutList ?? []).entries()) {
    if (!cut.seg) continue;
    const i = cut.piece ?? index, rate = cut.clipFpsR.num / cut.clipFpsR.den, before = pieces[i];
    pieces[i] = { id: assembly.reel.cuts[i]?.id ?? cut.seg.clip.id, clipId: cut.seg.clip.id,
      s: Math.min(before?.s ?? Infinity, cut.inFrames / rate), e: Math.max(before?.e ?? -Infinity, cut.outFrames / rate) };
  }
  return pieces;
}
export const soundPieceRef = (record: SoundRecord, piece: number): ProducePieceRef | undefined => {
  const p = soundPieces(record)[piece];
  return p && { id: p.id, clipId: p.clipId, s: p.s, e: p.e };
};
function pieceIndex(record: SoundRecord, ref: ProducePieceRef, sourceS?: number): number {
  return soundPieces(record).map((p, i) => ({ p, i })).filter(({ p }) => p.id === ref.id && p.clipId === ref.clipId &&
    (sourceS === undefined ? Math.min(p.e, ref.e) > Math.max(p.s, ref.s) : sourceS >= p.s - 1e-6 && sourceS < p.e - 1e-6))
    .sort((a, b) => (Math.min(b.p.e, ref.e) - Math.max(b.p.s, ref.s)) - (Math.min(a.p.e, ref.e) - Math.max(a.p.s, ref.s)))[0]?.i ?? -1;
}
export function validSoundAnchor(value: unknown): value is SoundAnchor {
  if (!value || typeof value !== 'object') return false;
  const a = value as SoundAnchor, ref = (p: ProducePieceRef) => p && typeof p.id === 'string' && typeof p.clipId === 'string' && Number.isFinite(p.s) && Number.isFinite(p.e) && p.e > p.s;
  if (a.to === 'graphic' || a.to === 'element') return typeof a.id === 'string' && (a.to === 'graphic' ? ['in', 'out'].includes(a.edge) : typeof a.element === 'string' && ['in', 'land', 'out'].includes(a.edge));
  if (a.to === 'time') return !!a.at && ref(a.at.piece) && Number.isFinite(a.at.sourceS);
  return ['join', 'word', 'punch'].includes(a.to) && ref(a.piece) && (a.to === 'join' || Number.isFinite(a.to === 'word' ? a.sourceS : a.at));
}
/** One reel-clock resolver, shared by storage, live sound and every delivery path. */
export function soundTime(record: SoundRecord, item: SfxItem, plan: FxPlan, fps: number) {
  const a = item.anchor;
  let landingS = item.atS, lengthS: number | undefined;
  if (a) {
    if (!validSoundAnchor(a)) return null;
    if (a.to === 'graphic' || a.to === 'element') {
      const graphic = record.overlays?.find(o => o.id === a.id);
      if (!graphic) return null;
      lengthS = graphic.e - graphic.s;
      landingS = a.edge === 'out' ? graphic.e : graphic.s;
      if (a.to === 'element') {
        const elements = graphic.graphic?.motion?.elements ?? [], i = elements.findIndex(e => e.id === a.element);
        if (i < 0) return null;
        const start = graphic.s + elements[i].at, end = graphic.s + (elements[i + 1]?.at ?? lengthS);
        lengthS = end - start;
        landingS = a.edge === 'out' ? end : start;
      }
    } else {
      const ref = a.to === 'time' ? a.at.piece : a.piece;
      const source = a.to === 'word' ? a.sourceS : a.to === 'punch' ? a.at : a.to === 'time' ? a.at.sourceS : undefined;
      const i = pieceIndex(record, ref, source), spans = plan.items.filter(p => p.piece === i);
      if (i < 0 || !spans.length) return null;
      const start = Math.min(...spans.map(p => p.startS)), end = Math.max(...spans.map(p => p.endS));
      lengthS = end - start;
      if (a.to === 'join') {
        const order = [...new Set(plan.items.map(p => p.piece))], join = plan.joins[order.indexOf(i) - 1];
        if (!join) return null;
        landingS = join.atS;
      } else {
        if (a.to === 'punch' && !record.pieceFx?.[i]?.punches?.some(p => Math.abs(p.sourceS - a.at) < 1e-6)) return null;
        const span = spans.find(p => source! >= Math.min(p.timeMap[0].s, p.timeMap.at(-1)!.s) - 1e-6 && source! <= Math.max(p.timeMap[0].s, p.timeMap.at(-1)!.s) + 1e-6);
        if (!span) return null;
        landingS = span.reverse ? span.endS - (mapTime(span.timeMap, source!) - span.startS) : mapTime(span.timeMap, source!);
      }
    }
  }
  const fitS = item.stretch ? lengthS : undefined;
  const rate = fitS && item.sourceLengthS ? item.sourceLengthS / fitS : 1;
  const hitS = (item.sourceHitS ?? 0) / rate;
  if (a) landingS += (item.offsetFrames ?? 0) / fps;
  else landingS += (item.offsetFrames ?? 0) / fps + hitS;
  const start = landingS - hitS + (item.startOffsetS ?? 0);
  if (!Number.isFinite(start) || start >= plan.durationS || start + hitS < 0 || (fitS !== undefined && fitS <= 0)) return null;
  return { atS: Math.max(0, start), landingS: start + hitS, sourceStartS: Math.max(0, -start), rate, lengthS: fitS ?? item.lengthS };
}

/** REL09e: the join's own transition sound (auto, legacy or the synth a join edit placed). Library sounds a person attached to the join are not it. */
export function joinTransitionSounds(record: SoundRecord, plan: FxPlan, index: number): SfxItem[] {
  const order = [...new Set(plan.items.map(p => p.piece))], ref = soundPieceRef(record, order[index + 1]);
  return (record.sfx ?? []).filter(s => s.id === `auto:join:${index}` || s.id === `legacy:join:${index}` || !!ref && s.legacyMix === 'synth' &&
    s.anchor?.to === 'join' && s.anchor.piece.id === ref.id && s.anchor.piece.clipId === ref.clipId && Math.min(s.anchor.piece.e, ref.e) > Math.max(s.anchor.piece.s, ref.s));
}
export function setJoinSound(record: SoundRecord, plan: FxPlan, index: number, sound: import('../shared/schema').TransitionSound | null) {
  const order = [...new Set(plan.items.map(p => p.piece))], ref = soundPieceRef(record, order[index + 1]);
  if (!ref) return;
  // REL09e: replace only the transition sound; an unchanged one stays as it is (level, offset), and other sounds on the join are never dropped.
  const owned = joinTransitionSounds(record, plan, index), keep = sound ? owned.find(s => s.file === `lib:synth-${sound}`) : undefined;
  record.sfx = (record.sfx ?? []).filter(s => s === keep || !owned.includes(s));
  if (sound && !keep) record.sfx.push({ id: `join:${ref.id}:${ref.s}:${ref.e}`, file: `lib:synth-${sound}`, sound: `lib:synth-${sound}`, name: sound, kind: sound,
    atS: plan.joins[index].atS, anchor: { to: 'join', piece: ref }, offsetFrames: 0, gainDb: -12, auto: false, legacyMix: 'synth' });
}

export function needsSoundResolution(record: SoundRecord): boolean {
  return !!(record.sfx?.some(s => s.anchor || s.id.startsWith('auto:join:') || s.reason === "The scene's first landing") || record.overlays?.some(o => o.sound) || record.transition?.sound || record.joins?.some(j => j?.sound));
}

/** Old cues retain their exact source, start and gain. Reading never writes a revision. */
export function migrateSounds<T extends SoundRecord>(record: T, plan: FxPlan, fps: number): T {
  if (!needsSoundResolution(record)) return record;
  const items = (record.sfx ?? []).map(s => ({ ...s })), ownsJoins = record.sfx !== undefined;
  const addSynth = (id: string, sound: string, atS: number, anchor?: SoundAnchor) => {
    if (!items.some(s => s.id === id)) items.push({ id, file: `lib:synth-${sound}`, sound: `lib:synth-${sound}`, name: sound, kind: sound as SfxItem['kind'], atS, anchor,
      offsetFrames: 0, gainDb: -12, auto: false, legacyMix: 'synth', ...(anchor?.to === 'graphic' ? { startOffsetS: atS - (record.overlays?.find(o => o.id === anchor.id)?.s ?? atS) } : {}) });
  };
  for (const j of plan.joins) {
    const next = plan.items.find(p => p.startS <= j.atS + 1e-6 && p.endS > j.atS && p.piece > 0), ref = next && soundPieceRef(record, next.piece);
    const existing = items.find(s => s.id === `auto:join:${j.index}`);
    if (existing && ref && !existing.anchor) {
      existing.anchor = { to: 'join', piece: ref }; existing.legacyMix = 'placed'; existing.startOffsetS = existing.atS - j.atS;
    }
    if (j.choice.sound && !ownsJoins) addSynth(`legacy:join:${j.index}`, j.choice.sound, j.atS, ref ? { to: 'join', piece: ref } : undefined);
  }
  for (const o of record.overlays ?? []) if (o.sound && o.s < plan.durationS && o.e > 0) addSynth(`legacy:graphic:${o.id}`, o.sound, Math.max(0, o.s), { to: 'graphic', id: o.id, edge: 'in' });
  for (const s of items) if (!s.anchor && s.reason === "The scene's first landing") {
    const graphic = record.overlays?.filter(o => o.graphic?.template?.startsWith('scene-')).sort((a, b) => Math.abs(a.s + (a.graphic?.motion?.elements[0]?.at ?? 0) - s.atS) - Math.abs(b.s + (b.graphic?.motion?.elements[0]?.at ?? 0) - s.atS))[0];
    const element = graphic?.graphic?.motion?.elements[0];
    if (graphic && element) {
      s.anchor = { to: 'element', id: graphic.id, element: element.id, edge: 'land' }; s.legacyMix = 'scene';
      s.startOffsetS = s.atS + (s.sourceHitS ?? 0) - graphic.s - element.at;
    }
  }
  const events = items.filter(s => s.id.startsWith('legacy:')).sort((a, b) => a.atS - b.atS);
  if (items.length || record.sfx !== undefined) record.sfx = [...events, ...items.filter(s => !s.id.startsWith('legacy:'))];
  if (record.joins) record.joins = record.joins.map(j => j && j.sound ? { ...j, sound: null } : j);
  if (record.transition?.sound) record.transition = { ...record.transition, sound: null };
  if (record.overlays?.some(o => o.sound)) record.overlays = record.overlays.map(o => o.sound ? { ...o, sound: null } : o);
  resolveSounds(record, plan, fps);
  return record;
}
export function resolveSounds(record: SoundRecord, plan: FxPlan, fps: number) {
  if (!record.sfx) return;
  record.sfx = record.sfx.flatMap(item => {
    const resolved = soundTime(record, item, plan, fps);
    if (!resolved) {
      if (item.anchor && record.warnings && !record.warnings.includes('A sound was removed with its attachment.')) record.warnings.push('A sound was removed with its attachment.');
      return [];
    }
    if (resolved.sourceStartS > 0 && record.warnings && !record.warnings.includes('A sound was shortened before its landing.')) record.warnings.push('A sound was shortened before its landing.');
    // Free times remain the source of truth; anchored times are a cache only.
    return [{ ...item, ...(item.anchor ? { atS: resolved.atS } : {}) }];
  });
}
export function coupledSoundShape(record: SoundRecord, plan: FxPlan, fps: number, shape: MusicShapeMark[] = []): MusicShapeMark[] {
  const hits = (record.sfx ?? []).flatMap(s => {
    if (s.role !== 'hit' || s.legacyMix || s.auto && record.audio?.design === false) return [];
    const t = soundTime(record, s, plan, fps);
    return t && !shape.some(m => m.kind === 'hit' && Math.abs(m.atS - t.landingS) < .002) ? [{ kind: 'hit' as const, atS: t.landingS, db: -6, recoverS: .4 }] : [];
  });
  return hits.length ? [...shape, ...hits].sort((a, b) => a.atS - b.atS) : shape;
}
