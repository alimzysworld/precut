import { defaultClipMuted } from '../../../../shared/lane-levels';
import type { CutEdit, CutVersion, DraftPiece, DraftTimeline, OverlayItem, TitleTrack } from "../../../../shared/schema";
import { magneticTime, moveOrder } from "../../../../shared/magnetic";
import { transcriptText } from "../../../../main/titles/text";

/** Display cues are an animation detail. Text's saved speech pieces own the lines. */
export function captionBlocks(track: TitleTrack | null | undefined, pieces: { sourceIndex: number; timelineS?: number; lengthS?: number; broll?: boolean }[], bigLines: CutVersion["bigLines"] = []) {
  const groups = new Map<string, { id: string; s: number; e: number; text: string; big: boolean; tokens: { text: string; s: number; e: number }[] }>();
  const cues = (track?.cues ?? []).filter(cue => cue.role === "subtitle" || cue.id.startsWith("kinetic-"));
  for (const cue of [...cues].sort((a, b) => a.s - b.s)) {
    for (const word of cue.words?.length ? cue.words : [{ text: cue.text, s: cue.s, e: cue.e }]) {
      const owner = pieces.find(piece => !piece.broll && word.s < (piece.timelineS ?? 0) + (piece.lengthS ?? 0) && word.e > (piece.timelineS ?? 0));
      // Old tracks without piece timing retain honest sentence boundaries.
      const last = [...groups.values()].at(-1);
      const previousKey = [...groups.keys()].at(-1);
      const key = owner ? `piece-${owner.sourceIndex}` : last && previousKey && !/[.!?]["'’”)]?$/.test(last.tokens.at(-1)?.text ?? "") && word.s - last.e < .7 ? previousKey : cue.id;
      let group = groups.get(key);
      if (!group) { group = { id: cue.id, s: word.s, e: word.e, text: "", big: false, tokens: [] }; groups.set(key, group); }
      if (!group.tokens.some(token => token.s === word.s && token.e === word.e && token.text === word.text)) group.tokens.push(word);
      group.s = Math.min(group.s, word.s); group.e = Math.max(group.e, word.e);
      group.big ||= cue.id.startsWith("kinetic-");
    }
  }
  return [...groups.values()].map(({ tokens, ...group }) => {
    const override = bigLines.find(line => line.s >= group.s - 1e-7 && line.s < group.e);
    return { ...group, big: override?.big ?? group.big, text: transcriptText(tokens.sort((a, b) => a.s - b.s).map(token => token.text)) };
  }).sort((a, b) => a.s - b.s);
}

export function clipDuration(seconds: number) {
  const safe = Math.max(0, seconds);
  if (safe < 10) return `${safe.toFixed(1)}s`;
  const whole = Math.round(safe);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
export function retimeOverlay(item: Pick<OverlayItem, "s" | "e">, mode: "move" | "start" | "end", delta: number, duration: number) {
  const minimum = Math.min(.1, duration);
  if (mode === "start") return { s: Math.max(0, Math.min(item.e - minimum, item.s + delta)), e: item.e };
  if (mode === "end") return { s: item.s, e: Math.min(duration, Math.max(item.s + minimum, item.e + delta)) };
  const length = Math.min(item.e - item.s, duration);
  const s = Math.max(0, Math.min(duration - length, item.s + delta));
  return { s, e: s + length };
}
export function soundBlocks(draft?: DraftTimeline | null) {
  return [
    ...(draft?.joins ?? []).filter(join => join.choice.sound).map(join => ({ id: `join-${join.index}`, s: join.atS, e: Math.min(draft!.durationS, join.atS + .3), label: join.choice.sound!, join: join.index })),
    ...(draft?.overlays ?? []).filter(item => item.sound).map(item => ({ id: `overlay-${item.id}`, s: item.s, e: Math.min(draft!.durationS, item.s + .3), label: item.sound!, overlay: item.id })),
  ];
}
/** Measured sample envelopes only; no decorative or invented waveform. */
export function audioPeaks(buffer: { length: number; numberOfChannels: number; getChannelData: (channel: number) => Float32Array }, count = 240) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const bins = Math.min(count, buffer.length);
  return Array.from({ length: bins }, (_, i) => {
    const start = Math.floor(i * buffer.length / bins), end = Math.floor((i + 1) * buffer.length / bins);
    let peak = 0;
    for (const channel of channels) for (let sample = start; sample < end; sample++) peak = Math.max(peak, Math.abs(channel[sample]));
    return peak;
  });
}

export type LaneId = "layouts" | "video" | "clip-sound" | "broll-sound" | "captions" | "voice" | "music" | "overlays" | "sound-effects";
export type LaneVisibility = Partial<Record<LaneId, boolean>>;
/** Tenths, rounded once so the badge never reads 0:60.0. */
export function timelineTime(seconds: number) {
  const ticks = Math.round(Math.max(0, seconds) * 10);
  return `${Math.floor(ticks / 600)}:${String(Math.floor(ticks / 10) % 60).padStart(2, "0")}.${ticks % 10}`;
}

export type TrimEdge = "start" | "end";
export function snapEdge(value: number, targets: number[], scale: number, disabled: boolean) {
  if (disabled) return value;
  return targets.filter(t => Math.abs(t - value) * scale <= 6).sort((a,b) => Math.abs(a-value)-Math.abs(b-value))[0] ?? value;
}
export function trimEdge(piece: { s: number; e: number; timelineS: number; lengthS?: number }, edge: TrimEdge, delta: number, sourceDuration: number, speed: number, fps: number, targets: number[], scale: number, alt = false) {
  const original = edge === "start" ? piece.s : piece.e;
  const at = piece.timelineS + (edge === "end" ? piece.lengthS ?? (piece.e-piece.s)/speed : 0);
  const snapped = snapEdge(at + delta, targets, scale, alt);
  const wanted = Math.round((original + (snapped-at)*speed)*fps)/fps;
  const low = edge === "start" ? 0 : piece.s + 1/fps;
  const high = edge === "start" ? piece.e - 1/fps : sourceDuration;
  const value = Math.max(low, Math.min(high, wanted));
  return { s: edge === "start" ? value : piece.s, e: edge === "end" ? value : piece.e,
    limit: wanted <= 0 && edge === "start" ? "Start of footage" : wanted >= sourceDuration && edge === "end" ? "End of footage"
      : wanted < low && edge === "end" || wanted > high && edge === "start" ? "Shortest a clip can be" : null };
}
export function insertionAt(starts: number[], lengths: number[], x: number, from: number) {
  return starts.filter((start, i) => i !== from && x > start + lengths[i]/2).length;
}
export function magneticSpans(timeline: DraftTimeline) {
  const groups = new Map<number, { piece: number; startS: number; endS: number }>();
  timeline.pieces.filter(p => p.layer === 0).forEach((p, i) => {
    const piece = p.piece ?? i, prior = groups.get(piece);
    groups.set(piece, { piece, startS: Math.min(prior?.startS ?? Infinity, p.startS), endS: Math.max(prior?.endS ?? 0, p.endS) });
  });
  return [...groups.values()];
}
function shiftPicture(p: DraftPiece, delta: number): DraftPiece {
  return { ...p, startS:p.startS+delta, endS:p.endS+delta, timeMap:p.timeMap?.map(k => ({...k,t:k.t+delta})), frame:p.frame?.map(k => ({...k,t:k.t+delta})) ?? null,
    opacity:p.opacity?.map(k => ({...k,t:k.t+delta})), blur:p.blur?.map(k => ({...k,t:k.t+delta})) };
}
/** Local picture and sound use the same source spans. No decoder reload or IPC
 * is needed during a drag, including edits with removed words and speed. */
export function magneticPreview(timeline: DraftTimeline, edit: CutEdit): DraftTimeline {
  if(edit.kind==='batch')return edit.edits.reduce((plan,change)=>{
    if(change.kind!=='move' && !(change.kind==='trim' && 'magnetic' in change))return plan;
    const piece=magneticSpans(plan)[change.piece]?.piece;
    return piece===undefined ? plan : magneticPreview(plan,{...change,piece});
  },timeline);
  if (edit.kind !== "move" && !(edit.kind === "trim" && "magnetic" in edit)) return timeline;
  const before = magneticSpans(timeline), selected = before.find(p => p.piece === edit.piece);
  if (!selected) return timeline;
  let pieces = timeline.pieces, durationS = timeline.durationS, trimOffsetS = 0;
  if (edit.kind === "move") {
    let at = 0;
    const order = moveOrder(before.length, before.findIndex(p => p === selected), edit.to);
    const offsets = new Map(order.map(i => { const span = before[i], delta = at-span.startS; at += span.endS-span.startS; return [span.piece,delta]; }));
    pieces = pieces.map(p => shiftPicture(p, offsets.get(p.piece ?? -1) ?? 0)).sort((a,b) => a.startS-b.startS);
    durationS = at;
  } else {
    const spans = pieces.filter(p => p.piece === edit.piece && p.layer === 0);
    const first = spans[0], last = spans.at(-1)!;
    const sourceEnd = last.timeMap?.at(-1)?.s ?? last.inS + last.endS-last.startS;
    const speed = ((first.timeMap?.at(-1)?.s ?? first.inS+first.endS-first.startS)-first.inS)/(first.endS-first.startS);
    const clipped = spans.flatMap((p, i) => {
      const keys = p.timeMap ?? [{t:p.startS,s:p.inS},{t:p.endS,s:p.inS+p.endS-p.startS}];
      const low = Math.max(edit.s, i === 0 ? edit.s : keys[0].s), high = Math.min(edit.e, i === spans.length-1 ? edit.e : keys.at(-1)!.s);
      if (high <= low) return [];
      const time = (s: number) => {
        let n = keys.findIndex(k => k.s >= s); if (n <= 0) n = n < 0 ? keys.length-1 : 1;
        const a = keys[n-1], b = keys[n]; return a.t+(s-a.s)*(b.t-a.t)/(b.s-a.s);
      };
      return [{...p,inS:low,startS:time(low),endS:time(high),timeMap:[{t:time(low),s:low},...keys.filter(k => k.s>low && k.s<high),{t:time(high),s:high}]}];
    });
    if (!clipped.length) return timeline;
    const head = clipped[0].startS-selected.startS;
    trimOffsetS = head;
    const replacement = clipped.map(p => shiftPicture(p,-head));
    const newEnd = replacement.at(-1)!.endS, delta = newEnd-selected.endS;
    pieces = pieces.flatMap(p => p.piece === edit.piece ? p.layer === 0 && p === first ? replacement : p.layer === 1 ? [shiftPicture({...p,endS:Math.min(p.endS,selected.endS+(edit.e-sourceEnd)/speed)},-head)] : [] : [p.startS>=selected.endS-1e-7 ? shiftPicture(p,delta) : p]);
    durationS += delta;
  }
  const after = magneticSpans({...timeline,pieces}).map(p => ({...p,offsetS:p.piece===edit.piece ? trimOffsetS : 0})), time = magneticTime(before, after);
  const voice = (timeline.voiceover ?? []).flatMap(l => l.take ? [{s:l.s,e:l.s+l.take.e-l.take.s}] : []), onVoice = (t: number) => voice.some(v => t >= v.s-1e-6 && t < v.e+1e-6);
  const liveSound = timeline.liveSound && {...timeline.liveSound,durationS,
    pieces:timeline.liveSound.pieces.flatMap(sound => {
      const pictures = pieces.filter(p => p.layer===(sound.layer ?? 0) && p.piece===sound.piece);
      return pictures.map(p => ({...sound,startS:p.startS,endS:p.endS,timeMap:p.timeMap ?? [{t:p.startS,s:p.inS},{t:p.endS,s:p.inS+p.endS-p.startS}]}));
    }).filter((p,i,all) => all.findIndex(s => s.id===p.id && s.startS===p.startS)===i),
    effects:timeline.liveSound.effects.map(p => { const delta=time.point(p.startS)-p.startS; return {...p,startS:p.startS+delta,endS:p.endS+delta,timeMap:p.timeMap.map(k=>({...k,t:k.t+delta}))}; }),
    bleeps:timeline.liveSound.bleeps.map(time.range)};
  return {...timeline,pieces,durationS,liveSound,overlays:timeline.overlays?.map(time.range),
    // VO7-19: a picture move never shifts the voiceover, and the voice's own captions stay on it (main's movePiece).
    titles:timeline.titles && {...timeline.titles,cues:timeline.titles.cues.map(c=>edit.kind==='move' && (c.words?.length ? c.words : [c]).every(w=>onVoice(w.s)) ? c : {...time.range(c),words:c.words?.map(time.range)})},
    joins:timeline.joins?.map(j=>({...j,atS:time.point(j.atS)}))};
}

/** Linked geometry always comes from picture spans. Only cached envelopes are sampled. */
export function clipSoundBlocks(draft: DraftTimeline | null | undefined, version: CutVersion, clips: {id:string; sound?: unknown; meta?: {audioChannels?:number} | null}[]) {
  const live = draft?.liveSound?.pieces ?? [];
  const groups = new Map<string, DraftPiece[]>();
  for (const p of draft?.pieces ?? []) {
    if (p.piece === undefined || p.layer > 1 || !clips.some(c=>c.id===p.clipId && (c.sound || c.meta?.audioChannels))) continue;
    if (p.layer===1 && (version.pieces?.[p.piece]?.overlay?.clipId!==p.clipId || version.layouts?.[p.piece] && !['face','placeholder'].includes(version.layouts[p.piece]!.kind))) continue;
    const key = `${p.layer}:${p.piece}`, spans = groups.get(key) ?? []; spans.push(p); groups.set(key,spans);
  }
  return [...groups.values()].map(spans=>{
    const first=spans[0], piece=first.piece!, startS=first.startS, endS=spans.at(-1)!.endS;
    const sources=live.filter(p=>p.piece===piece && (p.layer ?? 0)===first.layer && p.peaks?.length);
    const measured = sources.length ? Array.from({length:Math.min(240,Math.max(1,Math.ceil((endS-startS)*100)))},(_,i)=> {
      const t=startS+(i+.5)/Math.min(240,Math.max(1,Math.ceil((endS-startS)*100)))*(endS-startS), picture=spans.find(p=>t>=p.startS && t<p.endS);
      if (!picture) return 0;
      const keys=picture.timeMap ?? [{t:picture.startS,s:picture.inS},{t:picture.endS,s:picture.inS+picture.endS-picture.startS}];
      const right=keys.findIndex(k=>k.t>t), a=keys[Math.max(0,right<0?keys.length-2:right-1)], b=keys[right<0?keys.length-1:Math.max(1,right)];
      const source=a.s+(b.s-a.s)*(t-a.t)/(b.t-a.t||1), sound=sources.find(p=>source>=(p.sourceStart ?? 0) && source<(p.sourceStart ?? 0)+p.peaks!.length/100);
      return Math.min(1,sound?.peaks?.[Math.max(0,Math.floor((source-(sound.sourceStart ?? 0))*100))] ?? 0);
    }) : [];
    return {piece,layer:first.layer,clipId:first.clipId,startS,endS,measured,muted:!!version.clipSoundMuted || (first.layer===1 ? (version.pieceFx?.[piece]?.overlaySound?.muted ?? !version.clipSoundDefaultOn) : !!version.pieceFx?.[piece]?.reverse || (version.pieceFx?.[piece]?.muted ?? defaultClipMuted(version,version.pieces?.[piece]?.kind==='broll')))};
  });
}
