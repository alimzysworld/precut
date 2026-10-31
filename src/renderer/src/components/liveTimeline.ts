import {withClipTransforms} from '../../../shared/clip-transform';
import { updateCaptionWord } from "../../../shared/caption-words";
import { clipLaneDb, allClipSound, defaultClipMuted } from '../../../shared/lane-levels';
import { replacementSpan } from "./replaceModel";
import { magneticTime } from "../../../shared/magnetic";
import { maskCues } from "../../../main/titles/bleep-presentation";
import { lowerThirdCues } from "../../../main/titles/lower-thirds";
import type { CutEdit, CutVersion, DraftPiece, DraftTimeline, LiveSoundPiece, PieceFx, Shoot, VoiceoverLine } from '../../../shared/schema';
import type { LiveSoundTimeline } from './liveMix';
import { mediaUrl } from '../../../shared/media';
import { applyVoiceEdit, voiceJoinFades, type VoiceTake } from '../../../shared/voice-edit';
import { voiceEndS } from '../../../shared/picture-extent';
import { buildCaptionTrack } from '../../../main/titles/captions';
import { isCaptionCue } from '../../../shared/caption-words';
import type { CaptionTrack } from '../../../main/titles/captions';
import type { TitleTrack } from '../../../shared/schema';
import { timelineTime } from './timeline/model';
export function isSoundAdjustment(edit: CutEdit, version: CutVersion): boolean {
  if(edit.kind==='batch')return edit.edits.length>0 && edit.edits.every(change=>isSoundAdjustment(change,version));
  if (edit.kind === 'clipSound' || edit.kind === 'laneLevel') return true;
  if (edit.kind !== 'pieceFx') return false;
  const picture = (fx: PieceFx | null | undefined) => {
    const value = { ...fx }; delete value.gainDb; delete value.muted; delete value.overlaySound; return JSON.stringify(value);
  };
  return picture(edit.fx) === picture(version.pieceFx?.[edit.piece]);
}
/** Cut and per-take cleanup decisions invalidate a main timeline. Immutable version numbers and
 * adjustment layers do not describe decoder or preparation work. */
export function cutSignature(version: CutVersion) {
  return JSON.stringify([version.overlays?.map(o=>[o.id,o.sound,o.s,o.e]),version.sfx?.map(s=>[s.id,s.file]),[version.audio?.clean ?? true,version.audio?.denoise ?? .6,version.audio?.auto ?? true,version.audio?.breaths ?? true],version.voice,version.broll,version.pieces,version.energy,version.faceMatch,version.framing,version.transition,version.joins,version.angleCuts,version.layouts,
    version.pieceFx?.flatMap((fx,piece) => fx && [fx.speed,fx.reverse,fx.framing,fx.background].some(value=>value!==undefined) ? [{piece,speed:fx.speed,reverse:fx.reverse,framing:fx.framing,background:fx.background}] : []) ?? [],version.formats,
    // V63: another track, or fitting turned on, needs main to fit and measure it.
    version.music && [version.music.file,!!version.music.fit,!!version.music.followStory,version.music.pinnedArrangement?.key]]);
}
/** The version's bleeps on the reel clock, through the timeline's own pieces (each keeps its piece number). */
function liveBleeps(timeline: DraftTimeline, version: CutVersion) {
  const source = timeline as LiveSoundTimeline;
  const soundSpans=source.liveSound?.pieces.filter(p=>(p.layer ?? 0)===0) ?? timeline.pieces.filter(p=>p.layer===0).map(p=>({...p,timeMap:p.timeMap ?? [{t:p.startS,s:p.inS},{t:p.endS,s:p.inS+p.endS-p.startS}]}));
  return (version.bleeps ?? []).flatMap(b=>soundSpans.flatMap(p=>{
    if(p.piece!==b.piece || version.pieceFx?.[b.piece]?.reverse)return [];
    const keys=p.timeMap,s=Math.max(b.s,keys[0].s),e=Math.min(b.e,keys.at(-1)!.s);if(e<=s)return [];
    const time=(s:number)=>{let i=keys.findIndex(k=>k.s>=s);if(i<=0)i=i<0?keys.length-1:1;const a=keys[i-1],z=keys[i];return a.t+(z.t-a.t)*(s-a.s)/(z.s-a.s||1);};
    return [{s:time(s),e:time(e),sound:b.sound,piece:b.piece}];
  }));
}
/** AV4: the titles the viewer draws for a caption track, presented as main presents them for the draft and the export
 * (titles/ul1 presentTitles): every caption word under a bleep masked, the version's lower thirds laid on. The draft
 * and the saved or live track the Finish panel hands the viewer both go through here. */
export function presentLiveTitles(titles: TitleTrack | null | undefined, timeline: DraftTimeline, version: CutVersion, bleeps = liveBleeps(timeline, version)): TitleTrack {
  const track=titles ?? {font:'Outfit',cues:[],prompt:null,skillIds:[]};
  return {...track,cues:[...maskCues(track.cues.filter(c=>!c.id.startsWith('lower-third:')),bleeps),...lowerThirdCues(version.lowerThirds,track.captionStyle)]};
}
export function finishTimeline(timeline: DraftTimeline, version: CutVersion, root: string): DraftTimeline {
  const source = timeline as LiveSoundTimeline;
  const bleeps=liveBleeps(timeline,version);
  const soundPieces=source.liveSound?.pieces.map(p=>p.layer===1 ? {...p,gainDb:clipLaneDb(version,version.pieceFx?.[p.piece ?? -1]?.overlaySound?.gainDb ?? 0),muted:!!version.clipSoundMuted || (version.pieceFx?.[p.piece ?? -1]?.overlaySound?.muted ?? !version.clipSoundDefaultOn)} : ({...p,gainDb:p.piece === undefined ? p.gainDb : clipLaneDb(version,version.pieceFx?.[p.piece ?? -1]?.gainDb ?? 0),muted:p.piece === undefined ? p.muted : !!version.clipSoundMuted || !!version.pieceFx?.[p.piece]?.reverse || (version.pieceFx?.[p.piece]?.muted ?? defaultClipMuted(version,version.pieces?.[p.piece]?.kind === "broll"))}));
  const musicUrl=version.music ? `st-media://local/music/${encodeURIComponent(version.music.file.startsWith("/") ? version.music.file : `${root}/${version.music.file}`)}` : null;
  const preparedMusic=source.liveSound?.music?.url===musicUrl ? source.liveSound.music : undefined;
  const originalMusic=source.liveSound?.music?.arrangementSource===version.music?.file ? source.liveSound?.music : preparedMusic;
  const titles=version.titles === undefined ? timeline.titles : version.titles;
  // V63: beat marks measured for another track never stay on this one.
  const otherTrack=!!source.liveSound?.music && source.liveSound.music.arrangementSource!==version.music?.file;
  // V63: the same fitted track keeps its prepared arrangement and clock; only levels follow the version.
  const heard=source.liveSound?.music,fitted=version.music && (version.music.fit || version.music.followStory) && heard?.arrangementSource===version.music.file && heard.arrangementState==='ready' && !!heard.fit===!!version.music.fit && !!heard.followStory===!!version.music.followStory ? heard : undefined;
  return voiceFromVersion({...timeline,...(otherTrack ? {musicGrid:undefined,musicBeatsS:undefined} : {}),pieces:withClipTransforms(timeline.pieces,version.pieceFx),uniformBalances:version.balances,correctionKey:version.feedback?.startsWith("Auto correct ") ? version.version : undefined,uniformGrade:version.grade,uniformPieceLooks:(version.pieceFx ?? []).map(fx=>fx?.look ?? null),titles:presentLiveTitles(titles,timeline,version,bleeps),overlays:(version.overlays ?? []).map(item=>({...item,url:`st-media://local/${encodeURIComponent(root)}/overlays/${encodeURIComponent(item.file)}`,...(item.graphic?.media ? {mediaUrl:`st-media://local/${encodeURIComponent(root)}/overlays/${encodeURIComponent(item.graphic.media)}`} : {})})),
    ...(source.liveSound ? {liveSound:{...source.liveSound,laneLevels:version.laneLevels,laneMuted:version.laneMuted,bleeps:bleeps.filter(b=>soundPieces?.some(p=>!p.muted && (p.layer ?? 0)===0 && p.piece===b.piece)).map(({piece,...b})=>b),effects:source.liveSound.effects.map(p=>{
      const item=version.sfx?.find(s=>s.id===p.id);if(!item)return p;
      const length=item.lengthS ?? p.endS-p.startS,delta=item.atS-p.startS;
      return {...p,startS:item.atS,endS:item.atS+length,gainDb:(item.gainDb ?? -12)+(p.normalizeDb ?? 0),timeMap:p.timeMap.map(k=>({...k,t:k.t+delta}))};
    }),audio:version.audio ?? source.liveSound.audio,
      pieces:soundPieces ?? [],
      music:version.music && fitted ? {...fitted,gainDb:version.music.gainDb,duck:version.music.duck,duckDepthDb:version.music.duckDepthDb,stemDucking:version.music.stemDucking,endS:version.music.endS,shape:version.music.shape} : version.music ? {...preparedMusic,...version.music,url:musicUrl!,...(!version.music.fit && !version.music.followStory ? {arrangementState:undefined,sourcePeaks:originalMusic?.sourcePeaks,sourceDurationS:originalMusic?.sourceDurationS,sourceBars:originalMusic?.sourceBars,peaks:originalMusic?.sourcePeaks ?? originalMusic?.peaks,waveformDurationS:originalMusic?.sourceDurationS ?? originalMusic?.waveformDurationS} : {})} : null}} : {})} as DraftTimeline,version,root);
}
// ---- VO7-3: one synchronous local reducer for hand edits, so an edit shows in the frame it was made.
const voiceGeometry = (lines?: VoiceoverLine[]) => JSON.stringify((lines ?? []).map(l => [l.id, l.s, l.take?.file ?? null, l.take?.s ?? null, l.take?.e ?? null]));
/** The saved version's voice pieces win over a plan prepared for another version (undo between
 * versions that differ only in voice, or a plan reused after a voice edit). */
function voiceFromVersion(timeline: DraftTimeline, version: CutVersion, root: string): DraftTimeline {
  if (!version.voiceover || voiceGeometry(version.voiceover.lines) === voiceGeometry(timeline.voiceover)) return timeline;
  return withVoiceLines(timeline, version.voiceover.lines, root);
}
const PREPARED = /^voiceover:[^:]+:(.*):(-?[\d.e+-]+):(-?[\d.e+-]+)$/;
/** The Voiceover lane and its live pieces for these lines, in the shape main's live mix builds. A
 * piece whose span lies inside one already prepared (cleaned) keeps that audio; anything else
 * plays the raw take until main prepares it. Picture is never read or changed. */
export function withVoiceLines(timeline: DraftTimeline, lines: VoiceoverLine[], root: string): DraftTimeline {
  const source = timeline as LiveSoundTimeline;
  if (!source.liveSound) return { ...timeline, voiceover: lines };
  const old = source.liveSound.pieces.filter(p => p.id.startsWith('voiceover:'));
  const pieces: LiveSoundPiece[] = [];
  for (const line of lines) {
    if (!line.take) continue;
    // VO7-9: voice past the picture's end stays in the plan; playback runs on to it over black.
    const take = line.take, d = take.e - take.s, endS = line.s + d;
    if (endS <= line.s) continue;
    const raw = `st-media://local/${encodeURIComponent(root)}/voice/${encodeURIComponent('voiceover:' + take.file)}`;
    // Main cleans each take once over the whole take, so any ready piece of the same take has this audio.
    const ready = old.find(p => { const m = PREPARED.exec(p.id); return !!m && m[1] === take.file && p.url !== raw; });
    pieces.push({ id: `voiceover:${line.id}:${take.file}:${take.s}:${take.e}`, url: ready?.url ?? raw, startS: line.s, endS, sourceStart: ready ? ready.sourceStart : 0,
      timeMap: [{ t: line.s, s: take.s }, { t: endS, s: take.s + endS - line.s }], gainDb: 0, fadeInS: .005, fadeOutS: .005 });
  }
  return { ...timeline, voiceover: lines, liveSound: { ...source.liveSound, pieces: [...source.liveSound.pieces.filter(p => !p.id.startsWith('voiceover:')), ...pieces] } } as DraftTimeline;
}
/** The shoot's voiceover takes with their measured words, as main reads them for voice edits. */
export function voiceTakes(shoot: Shoot): (file: string) => VoiceTake | undefined {
  return file => { const a = shoot.audio?.find(t => t.file === file); return a ? { file, durationS: a.durationS, words: (a.transcript ?? []).flatMap(t => t.words).filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s).sort((x, y) => x.s - y.s) } : undefined; };
}
let localVoice = 0;
/** A piece made on screen before main names it. The renderer maps it to main's id once saved. */
export const localVoiceId = () => `vo-local-${++localVoice}`;
export const isLocalVoiceId = (id: string) => id.startsWith('vo-local-');
const keysOf = (p: DraftPiece) => p.timeMap ?? [{ t: p.startS, s: p.inS }, { t: p.endS, s: p.inS + p.endS - p.startS }];
function timeAt(keys: { t: number; s: number }[], s: number) {
  let i = keys.findIndex(k => k.s >= s); if (i <= 0) i = i < 0 ? keys.length - 1 : 1;
  const a = keys[i - 1], b = keys[i]; return a.t + (b.t - a.t) * (s - a.s) / (b.s - a.s || 1);
}
/** Picture split at source seconds `at`, on main's rule: a talking piece splits at the nearest gap
 * between two whole words. The screen keeps its numbering (so nothing else re-keys); the second
 * half takes a fresh number, and sentIndex() names it as main will once the edit is sent. */
function splitPlan(timeline: DraftTimeline, index: number, at: number, version: CutVersion, shoot: Shoot): DraftTimeline {
  const spans = timeline.pieces.filter(p => p.piece === index && p.layer === 0);
  if (!spans.length || !Number.isFinite(at)) return timeline;
  const low = keysOf(spans[0])[0].s, high = keysOf(spans.at(-1)!).at(-1)!.s;
  if (version.pieces?.[index]?.kind === 'voice') {
    const words = (shoot.clips.find(c => c.id === spans[0].clipId)?.transcript ?? []).flatMap(t => t.words).filter(w => w.s >= low - 1e-6 && w.e <= high + 1e-6).sort((a, b) => a.s - b.s);
    const gaps = words.slice(0, -1).flatMap((w, i) => { const next = words[i + 1], edge = (w.e + next.s) / 2; return next.s >= w.e && !words.some(o => o.s < edge && o.e > edge) ? [edge] : []; });
    if (!gaps.length) throw new Error("This piece needs two complete words to split.");
    at = gaps.reduce((best, g) => Math.abs(g - at) < Math.abs(best - at) ? g : best, gaps[0]);
  }
  if (at <= low + 1e-6 || at >= high - 1e-6) throw new Error("Split inside the piece, leaving footage on both sides.");
  const fresh = Math.max(...timeline.pieces.map(p => p.piece ?? -1)) + 1;
  // The new half keeps the clip's look and controls until main saves it under its own number.
  const half = (p: DraftPiece) => ({ ...p, piece: fresh, lookPiece: p.lookPiece ?? index });
  const pieces = timeline.pieces.flatMap(p => {
    if (p.piece !== index || p.layer !== 0) return [p];
    const keys = keysOf(p), s0 = keys[0].s, s1 = keys.at(-1)!.s;
    if (s1 <= at + 1e-9) return [p];
    if (s0 >= at - 1e-9) return [half(p)];
    const t = timeAt(keys, at);
    return [{ ...p, endS: t, timeMap: [...keys.filter(k => k.s < at), { t, s: at }] }, { ...half(p), startS: t, inS: at, timeMap: [{ t, s: at }, ...keys.filter(k => k.s > at)] }];
  });
  const source = timeline as LiveSoundTimeline, cut = pieces.find(p => p.piece === fresh && p.layer === 0)?.startS ?? Infinity;
  return { ...timeline, pieces, ...(source.liveSound ? { liveSound: { ...source.liveSound, pieces: source.liveSound.pieces.map(p => p.piece === index && p.startS >= cut - 1e-6 ? { ...p, piece: fresh } : p) } } : {}) } as DraftTimeline;
}
/** Main numbers pieces in their order on the spine. The screen keeps the numbers it showed while
 * edits are on their way, so an edit names a piece by where it sits when it is sent. */
export function spineOrder(timeline: DraftTimeline): number[] {
  const order: number[] = [];
  for (const p of [...timeline.pieces].filter(p => p.layer === 0 && p.piece !== undefined).sort((a, b) => a.startS - b.startS)) if (!order.includes(p.piece!)) order.push(p.piece!);
  return order;
}
/** The edit as main must read it: piece numbers made on screen become their spine positions.
 * Unchanged (the same object) when the screen's numbers already are main's. */
export function sentEdit(edit: CutEdit, timeline: DraftTimeline): CutEdit {
  const order = spineOrder(timeline);
  if (order.every((piece, i) => piece === i)) return edit;
  const at = (piece: number) => { const i = order.indexOf(piece); return i < 0 ? piece : i; };
  const map = (e: CutEdit): CutEdit => {
    // Joins, move targets and evolving batch moves are positions already.
    if (e.kind === "batch") return e.edits.every(x => x.kind === "move") ? e : { ...e, edits: e.edits.map(map) };
    if ((e.kind === "cutWords" || e.kind === "bleep") && Array.isArray(e.spans)) return { ...e, spans: e.spans.map(span => ({ ...span, piece: at(span.piece) })) } as CutEdit;
    if ((e.kind === "transform" || e.kind === "duplicate") && Array.isArray(e.pieces)) return { ...e, pieces: e.pieces.map(at) } as CutEdit;
    if ("piece" in e && typeof e.piece === "number") return { ...e, piece: at(e.piece) } as CutEdit;
    return e;
  };
  return map(edit);
}
/** The plan on screen numbered the way main numbers the saved version it becomes: pieces by spine position
 * (sentEdit's rule, applied to the plan). Unchanged (the same object) when the numbers already are main's. */
export function savedNumbering(timeline: DraftTimeline): DraftTimeline {
  const order = spineOrder(timeline);
  if (order.every((piece, i) => piece === i)) return timeline;
  const at = (piece: number) => { const i = order.indexOf(piece); return i < 0 ? piece : i; };
  const bounds = timeline.musicTrimBounds && Object.fromEntries(Object.entries(timeline.musicTrimBounds).map(([piece, b]) => [at(Number(piece)), b]));
  return { ...timeline,
    pieces: timeline.pieces.map(p => ({ ...p, ...(p.piece === undefined ? {} : { piece: at(p.piece) }), ...(p.lookPiece === undefined ? {} : { lookPiece: at(p.lookPiece) }) })),
    ...(bounds ? { musicTrimBounds: bounds } : {}),
    ...(timeline.liveSound ? { liveSound: { ...timeline.liveSound, pieces: timeline.liveSound.pieces.map(p => p.piece === undefined ? p : { ...p, piece: at(p.piece) }) } } : {}) };
}
/** The version the screen describes while an edit is on its way: the edit's own fields only.
 * Main's saved version replaces it once it lands. */
export function optimisticVersion(version: CutVersion, edit: CutEdit, plan: DraftTimeline): CutVersion {
  // Pieces keep their numbers on screen (see sentEdit): only fields the edit sets change here.
  if (edit.kind === 'pieceFx' && version.pieces?.[edit.piece]) { const pieceFx = [...version.pieceFx ?? []]; pieceFx[edit.piece] = edit.fx; return { ...version, pieceFx }; }
  if (edit.kind === 'voiceover') return { ...version, voiceover: { ...(version.voiceover ?? { cutId: '', wordsPerSecond: 2.5, model: 'by hand', writtenAt: '' }), version: version.version, lines: plan.voiceover ?? [] } };
  if (edit.kind === 'remove' || edit.kind === 'split') return { ...version, lengthS: plan.durationS };
  return version;
}
function shift(piece: DraftPiece, delta: number): DraftPiece {
  return {...piece,startS:piece.startS+delta,endS:piece.endS+delta,timeMap:piece.timeMap?.map(k=>({...k,t:k.t+delta})),frame:piece.frame?.map(k=>({...k,t:k.t+delta})) ?? null,opacity:piece.opacity?.map(k=>({...k,t:k.t+delta})),blur:piece.blur?.map(k=>({...k,t:k.t+delta})),...(piece.exposure?{exposure:piece.exposure.map(k=>({...k,t:k.t+delta}))}:{})};
}
/** Immediate picture plan while main validates/snaps/saves. Existing spans retain
 * proxies and LUTs; the server's confirmed timing replaces this plan in place. */
export function optimisticTimeline(timeline: DraftTimeline, edit: CutEdit, version: CutVersion, shoot: Shoot): DraftTimeline {
  if (edit.kind === "captionWord") return { ...timeline, titles: updateCaptionWord(timeline.titles, edit, timeline.durationS) };
  // VO7-3: voice pieces run the same pure edit main saves; an impossible edit throws its plain sentence.
  if (edit.kind === "voiceover") return withVoiceLines(timeline, applyVoiceEdit(timeline.voiceover ?? [], edit, voiceTakes(shoot), localVoiceId), shoot.root);
  if (edit.kind === "split") return splitPlan(timeline, edit.piece, edit.at, version, shoot);
  if (edit.kind === "pieceFx") {
    const pieceFx=[...version.pieceFx ?? []]; pieceFx[edit.piece]=edit.fx;
    const before=timeline;
    timeline=finishTimeline(timeline,{...version,pieceFx},shoot.root);
    timeline={...timeline,pieces:timeline.pieces.map((p,i)=>p.piece===edit.piece?p:before.pieces[i])};
  }
  if (edit.kind === "laneLevel") return finishTimeline(timeline,{...version,laneLevels:{...version.laneLevels,...(edit.db === undefined ? {} : {[edit.lane]:edit.db})},laneMuted:{...version.laneMuted,...(edit.muted === undefined ? {} : {[edit.lane]:edit.muted})},...(edit.lane==='clip-sound' && edit.muted!==undefined ? {clipSoundMuted:edit.muted} : {})},shoot.root);
  if (edit.kind === "clipSound") {
    const changed = {...version,clipSoundMuted:edit.piece === undefined && !edit.all ? edit.muted : version.clipSoundMuted,pieceFx:[...version.pieceFx ?? []]};
    if (edit.piece !== undefined) changed.pieceFx[edit.piece] = edit.layer===1 ? {...changed.pieceFx[edit.piece],overlaySound:{...changed.pieceFx[edit.piece]?.overlaySound,...(edit.muted===undefined ? {} : {muted:edit.muted}),...(edit.gainDb===undefined ? {} : {gainDb:edit.gainDb})}} : {...changed.pieceFx[edit.piece],...(edit.muted === undefined ? {} : {muted:edit.muted}),...(edit.gainDb === undefined ? {} : {gainDb:edit.gainDb})};
    if(edit.all) allClipSound(changed,edit.all === "on");
    return finishTimeline(timeline,changed,shoot.root);
  }
  if (!('piece' in edit)) return timeline;
  const index = edit.piece, selected = timeline.pieces.filter(p=>p.piece===index && p.layer===0);
  if (!selected.length) return timeline;
  const first = selected[0], end = selected.at(-1)!.endS;
  let replacement = selected, delta = 0;
  if (edit.kind==='swap' || edit.kind==='trim' || edit.kind==='replace') {
    let clipId = first.clipId, s = first.inS, e = s + end-first.startS;
    if (edit.kind==='swap') {
      const match = /^L(\d+)A(\d+)$/.exec(edit.take);
      const take = match && shoot.takes.find(t=>t.lineIndex===Number(match[1])-1)?.attempts[Number(match[2])-1];
      if (!take) return timeline;
      clipId=take.clipId;s=take.speechS ?? take.s;e=take.speechE ?? take.e;
    } else if (edit.kind==='replace') {
      const clip=shoot.clips.find(c=>c.id===edit.clipId);
      if (!clip || version.pieces?.[index]?.kind!=='broll') return timeline;
      try {const span=replacementSpan(clip,(end-first.startS)*(version.pieceFx?.[index]?.speed ?? 1),edit);clipId=clip.id;s=span.s;e=span.e;} catch {return timeline;}
    } else {s=edit.s;e=edit.e;}
    const clip=shoot.clips.find(c=>c.id===clipId);if(!clip?.proxy || e<=s)return timeline;
    const speed=version.pieceFx?.[index]?.speed ?? 1,length=(e-s)/speed;
    replacement=[{...first,clipId,proxy:mediaUrl(shoot.root,'proxies',clip.proxy),inS:s,endS:first.startS+length,timeMap:[{t:first.startS,s},{t:first.startS+length,s:e}],frame:edit.kind==='swap' || edit.kind==='replace'?null:first.frame}];
    delta=length-(end-first.startS);
  } else if(edit.kind==='remove'){replacement=[];delta=first.startS-end;}
  else if(edit.kind==='pieceFx' && (edit.fx?.speed ?? 1)!==(version.pieceFx?.[index]?.speed ?? 1)) {
    const scale=(version.pieceFx?.[index]?.speed ?? 1)/(edit.fx?.speed ?? 1);
    replacement=selected.map(p=>({...p,startS:first.startS+(p.startS-first.startS)*scale,endS:first.startS+(p.endS-first.startS)*scale,timeMap:p.timeMap?.map(k=>({...k,t:first.startS+(k.t-first.startS)*scale}))}));delta=(end-first.startS)*(scale-1);
  } else return timeline;
  const pieces=timeline.pieces.flatMap(p=>p.piece===index ? p.layer===0 && p===first ? replacement : edit.kind==='replace' && p.layer===1 && p.startS<end+delta ? [{...p,endS:Math.min(p.endS,end+delta)}] : [] : [p.startS>=end ? shift(p,delta) : p]);
  const spans=(pieces:DraftPiece[])=>[...new Set(pieces.filter(p=>p.layer===0).map(p=>p.piece))].map(piece=>{const group=pieces.filter(p=>p.layer===0 && p.piece===piece);return {piece:piece!,startS:group[0].startS,endS:group.at(-1)!.endS};});
  const magnetic=edit.kind==='replace' ? magneticTime(spans(timeline.pieces),spans(pieces)) : magneticTime([],[]);
  const attachments=edit.kind==='replace' ? {titles:timeline.titles ? {...timeline.titles,cues:timeline.titles.cues.map(c=>({...magnetic.range(c),words:c.words?.map(magnetic.range)}))} : timeline.titles,overlays:timeline.overlays?.map(magnetic.range)} : {};
  const source=timeline as LiveSoundTimeline;
  const result={...timeline,...attachments,pieces,durationS:timeline.durationS+delta,...(source.liveSound ? {liveSound:{...source.liveSound,durationS:timeline.durationS+delta,
    ...(edit.kind==='replace' ? {effects:source.liveSound.effects.map(p=>{const range=magnetic.range({s:p.startS,e:p.endS}),delta=range.s-p.startS;return {...p,startS:range.s,endS:range.e,timeMap:p.timeMap.map(k=>({...k,t:k.t+delta}))};}),bleeps:source.liveSound.bleeps?.map(magnetic.range)} : {}),
    pieces:edit.kind==='replace' ? source.liveSound.pieces.map(p=>{
      // Narration is independent of the picture spine and must keep playing.
      if(p.id.startsWith('voiceover:')) return {...p,endS:Math.min(p.endS,timeline.durationS+delta)};
      const range=magnetic.range({s:p.startS,e:p.endS}),shift=range.s-p.startS;
      return {...p,startS:range.s,endS:range.e,timeMap:p.timeMap.map(k=>({...k,t:k.t+shift}))};
    }).filter(p=>p.endS>p.startS) : source.liveSound.pieces.flatMap(p=>p.startS>=first.startS && p.startS<end ? replacement.flatMap(pic=>{
      const clip=shoot.clips.find(c=>c.id===pic.clipId);return !clip||version.pieces?.[index]?.kind==='broll'?[]:[{...p,id:`voice:${pic.clipId}:${pic.inS}`,url:`st-media://local/${encodeURIComponent(shoot.root)}/voice/${encodeURIComponent(pic.clipId)}`,sourceStart:-(clip.sound?.offsetS ?? 0),startS:pic.startS,endS:pic.endS,timeMap:pic.timeMap!,gainDb:version.pieceFx?.[index]?.gainDb ?? 0}];
    }) : [{...p,startS:p.startS>=end?p.startS+delta:p.startS,endS:p.startS>=end?p.endS+delta:p.endS,timeMap:p.startS>=end?p.timeMap.map(k=>({...k,t:k.t+delta})):p.timeMap}])}} : {})} as DraftTimeline;
  return result;
}

// ---- VO7-9: playback past the picture's end.
/** Play, scrub and seek run to the end of the last voice piece; the picture (and the export) end at durationS. */
export function playbackExtent(timeline: DraftTimeline): number {
  return Math.max(timeline.durationS, voiceEndS(timeline.voiceover));
}
/** One voice piece as the Web Audio scheduler plays it: file seconds `offset` at reel `startS`, with
 * the 5 ms fades only where take audio was removed (voiceJoinFades, the rule every exporter reads). */
export type VoicePlayPiece = { id: string; url: string; startS: number; endS: number; offset: number; fadeInS: number; fadeOutS: number };
const PLACED = /^voiceover:([^:]+):/;
export function voicePlayback(timeline: DraftTimeline, root: string | null): VoicePlayPiece[] {
  const lines = (timeline.voiceover ?? []).filter(l => l.take && l.take.e > l.take.s);
  if (!lines.length) return [];
  const live = ((timeline as LiveSoundTimeline).liveSound?.pieces ?? []).filter(p => p.id.startsWith('voiceover:'));
  const fades = voiceJoinFades(lines);
  return lines.flatMap(line => {
    const take = line.take!, d = take.e - take.s, raw = root ? `st-media://local/${encodeURIComponent(root)}/voice/${encodeURIComponent('voiceover:' + take.file)}` : null;
    // Its own piece, else any cleaned piece of the same take (main cleans a take once, whole), else the raw take.
    const piece = live.find(p => PLACED.exec(p.id)?.[1] === line.id && p.id.endsWith(`:${take.file}:${take.s}:${take.e}`))
      ?? live.find(p => p.id.includes(`:${take.file}:`) && p.url !== raw);
    const url = piece?.url ?? raw;
    if (!url) return [];
    // A file's take time is its time plus the piece's sourceStart (0 for a whole cleaned take or the raw take).
    const offset = take.s - (piece ? piece.sourceStart ?? 0 : 0), fade = fades.get(line.id) ?? { fadeInS: .005, fadeOutS: .005 };
    return [{ id: line.id, url, startS: line.s, endS: line.s + d, offset, fadeInS: fade.fadeInS, fadeOutS: fade.fadeOutS }];
  }).sort((a, b) => a.startS - b.startS);
}
type BeyondTrack = CaptionTrack & { voiceBeyond?: NonNullable<CaptionTrack['captionSource']>['words'] };
/** Preview only: caption cues for the words heard past the picture's end (kept by caption follow as
 * voiceBeyond), built the way Extend will build them, so captions show over the black too. */
export function withBeyondCaptions<T extends TitleTrack | null | undefined>(track: T, pictureS: number): T {
  const t = track as unknown as BeyondTrack | null | undefined;
  if (!t?.voiceBeyond?.length || !t.captionStyle || !t.cues.some(isCaptionCue)) return track;
  try {
    const words = [...(t.captionSource?.words ?? []), ...t.voiceBeyond].sort((a, b) => a.s - b.s || a.e - b.e);
    const built = buildCaptionTrack(words, t, t.captionStyle, t.captionSource?.safeArea);
    const extra = built.cues.filter(c => c.s >= pictureS - 1e-3 && isCaptionCue(c)).map(c => ({ ...c, id: `beyond-${c.id}` }));
    return (extra.length ? { ...t, cues: [...t.cues.filter(c => c.s < pictureS - 1e-3 || !isCaptionCue(c)), ...extra] } : track) as T;
  } catch { return track; }
}
/** Scrub: move the editor timeline's playhead in the pointer's own frame, without a Timeline render.
 * The React render that follows lands the same position. */
export function paintTimelinePlayhead(seconds: number) {
  if (typeof document === 'undefined') return;
  const head = document.querySelector<HTMLElement>('[data-editor-timeline] [data-layered-playhead]');
  const ruler = document.querySelector<HTMLElement>('[data-editor-timeline] [data-time-ruler]');
  const canvas = head?.parentElement;
  if (!head || !ruler || !canvas) return;
  const duration = Number(ruler.getAttribute('aria-valuemax')) || 0;
  if (!(duration > 0)) return;
  const at = Math.max(0, Math.min(duration, seconds));
  // The canvas's width is its own style (no layout read on the pointer's frame).
  const width = parseFloat(canvas.style.width) || canvas.offsetWidth;
  head.style.left = `${at * width / duration}px`;
  const label = head.querySelector<HTMLElement>('[data-playhead-time]');
  if (label) label.textContent = timelineTime(at);
}
