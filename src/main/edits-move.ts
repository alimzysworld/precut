import { shotOrder, handMovedPieces } from "./shot-order";
import { readCut } from "./sidekick";
import { randomUUID } from "node:crypto";
import type { CutEdit } from "../shared/schema";
import { remapLayoutRanges } from '../shared/layout-presets';
import { moveOrder, magneticTime } from "../shared/magnetic";
import { cutPieceGroups } from "./export";
import { planFx, syncFxMetadata, layoutRangeAdvance } from "./edits-fx";
import { finishStoredVersion, renderStoredPreview, type StoredVersion } from "./sidekick";
import { runActivity } from "./activity";
import { retimeKinetic } from "./titles/captions";

export function retimeMagneticTrim(previous: StoredVersion, record: StoredVersion, piece: number) {
  // The older trim constructor lists its original fields explicitly. Preserve
  // later finishing metadata as well when the person drags a source edge.
  for (const [key,value] of Object.entries(previous)) if (!(key in record)) Reflect.set(record,key,structuredClone(value));
  const spans = (v: StoredVersion) => (v.pieces ?? []).map((p,piece) => ({piece,startS:p.timelineS,endS:p.timelineS+p.lengthS}));
  const offsetS = (record.pieces![piece].s-previous.pieces![piece].s)/(previous.pieceFx?.[piece]?.speed ?? 1);
  const time = magneticTime(spans(previous),spans(record).map(p=>({...p,offsetS:p.piece===piece?offsetS:0})));
  retimeMagneticItems(previous, record, time);
  if(previous.layouts?.some(l=>l?.kind==='scene')){
    const mapping=(record.pieces??[]).map((p,i)=>{const old=previous.pieces![i],offset=i===piece?Math.max(0,offsetS):0;return {oldS:old.timelineS+offset,oldE:old.timelineS+offset+Math.min(old.lengthS-offset,p.lengthS),s:p.timelineS,e:p.timelineS+p.lengthS};});
    record.layouts=[...Array.from({length:record.pieces?.length??0},(_,i)=>record.layouts?.[i]?.kind==='scene'?null:record.layouts?.[i]??null),...remapLayoutRanges(previous.layouts,mapping,layoutRangeAdvance(previous))];
  }
}

/** Shared attachment rules for source trims and voiceover picture fitting. */
export function retimeMagneticItems(previous: StoredVersion, record: StoredVersion, time: ReturnType<typeof magneticTime>) {
  if(previous.layouts?.some(l=>l?.kind==='scene'))record.layouts=[...Array.from({length:record.pieces?.length??0},(_,i)=>record.layouts?.[i]?.kind==='scene'?null:record.layouts?.[i]??null),...previous.layouts.filter(l=>l?.kind==='scene').flatMap(l=>{const range=time.range({s:l!.s!,e:l!.e!});return range.e>range.s?[{...l!,...range}]:[];})];
  record.overlays = previous.overlays?.map(time.range).filter(o=>o.e>o.s);
  record.lowerThirds = previous.lowerThirds?.map(time.range).filter(o=>o.e>o.s);
  if (previous.titles) record.titles = {...previous.titles,cues:previous.titles.cues.map(c=>({...time.range(c),words:c.words?.map(time.range).filter(w=>w.e>w.s)})).filter(c=>c.e>c.s)};
  record.sfx = previous.sfx?.map(s=>({...s,atS:time.point(s.atS)}));
  if (previous.soundDesign?.authored) record.soundDesign = {...previous.soundDesign,authored:previous.soundDesign.authored.map(s=>({...s,atS:time.point(s.atS)}))};
  record.angleCuts = previous.angleCuts?.map(c=>({...c,atS:time.point(c.atS)}));
  record.bigLines = previous.bigLines?.map(l=>({...l,s:time.point(l.s)}));
  if (record.cover) record.cover = {...record.cover,t:time.point(record.cover.t)};
  for (const format of record.formats ?? []) if (format.cover) format.cover = {...format.cover,t:time.point(format.cover.t)};
}

export function movePiece(root: string, cutId: string, version: number, edit: Extract<CutEdit, { kind: "move" | "duplicate" | "shotOrder" }>) {
  if(edit.kind==='duplicate' && (!Array.isArray(edit.pieces) || !edit.pieces.length || edit.pieces.length>500))return Promise.reject(new Error("Choose clips in this edit."));
  return runActivity({ kind: "edit", root, target: { cutId, version }, label: "Moving clip", cancelable: true }, () =>
    finishStoredVersion(root, cutId, version, true, async (record, assembly) => {
      const previous = structuredClone(record), groups = cutPieceGroups(assembly.cutList);
      const duplicated=edit.kind==='duplicate' ? [...new Set(edit.pieces)].sort((a,b)=>a-b) : [];
      if(edit.kind==='duplicate' && (!duplicated.length || duplicated.length>500 || duplicated.some(i=>!Number.isInteger(i) || i<0 || i>=groups.length)))throw new Error('Choose clips in this edit.');
      const order = edit.kind==='shotOrder'
        ? shotOrder(groups.map(g=>g.items[0].seg?.clip),edit.pieces,edit.keepMyMoves ? handMovedPieces(previous,(await readCut(root,cutId)).versions) : undefined)
        : edit.kind==='move' ? moveOrder(groups.length, edit.piece, edit.to) : Array.from({length:groups.length},(_,i)=>i);
      if(duplicated.length)order.splice(duplicated.at(-1)!+1,0,...duplicated);
      const index = (old: number) => order.indexOf(old);
      const fps = assembly.template.fps, before = planFx(assembly.cutList, fps, previous);
      let offsetFrames = 0;
      const cutList = order.flatMap((old, piece) => groups[old].items.map(item => {
        const next = { ...item, piece, offsetFrames }; offsetFrames += item.durTimelineFrames; return next;
      }));
      const reel = structuredClone(assembly.reel);
      reel.cuts = order.map((old, piece) => ({ ...reel.cuts[old], offsetS: cutList.find(c => c.piece === piece)!.offsetFrames / fps }));
      reel.model.voice = reel.cuts.map(c => ({ id: c.id }));
      reel.broll = reel.broll.flatMap(o => order.flatMap((old,piece)=>old===o.voiceIndex ? [{...o,voiceIndex:piece}] : []));
      record.assembly = { ...assembly, cutList, reel };
      record.voice = reel.cuts.map(c => c.id);
      record.pieces = order.map(old => ({...structuredClone(previous.pieces![old]),
        ...(edit.kind==='move' && old===edit.piece ? {handMoved:true} : {}),
        ...(edit.kind==='shotOrder' && !edit.keepMyMoves && (!edit.pieces || edit.pieces.includes(old)) ? {handMoved:false} : {})}));
      record.pieceFx = previous.pieceFx && order.map(old => previous.pieceFx?.[old] ?? null);
      record.layouts = previous.layouts && order.map(old => previous.layouts?.[old] ?? null);
      record.jumpScales = previous.jumpScales && order.map(old => previous.jumpScales?.[old] ?? null);
      record.bleeps = previous.bleeps?.flatMap(b => order.flatMap((old,piece)=>old===b.piece ? [{...b,piece}] : []));
      record.joins = order.slice(1).map((right, i) => right === order[i] + 1 ? previous.joins?.[order[i]] ?? null : null);
      if (record.grade?.matchRef != null) record.grade = { ...record.grade, matchRef: index(record.grade.matchRef) };
      record.formats = previous.formats?.map(f => ({ ...f, pieceFraming: f.pieceFraming && order.map(old => f.pieceFraming?.[old] ?? null) }));
      const after = planFx(cutList, fps, record);
      const spans = (plan: typeof before, old = false) => groups.map((_, piece) => {
        const items = plan.items.filter(p => p.piece === (old ? index(piece) : piece));
        return { piece, startS: items[0].startS, endS: items.at(-1)!.endS };
      });
      const time = magneticTime(spans(before), spans(after, true));
      // VO7-19: the voiceover is its own track. A picture move never shifts it (as in Resolve, a separate audio track
      // stays put; only the clip's own sound travels with the clip), and the captions of the voice stay on the voice:
      // same times, words and count. Captions of a clip's own speech (a talking clip) still travel with that clip.
      const voiceSpans = (previous.voiceover?.lines ?? []).flatMap(l => l.take ? [{ s: l.s, e: l.s + l.take.e - l.take.s }] : []);
      const onVoice = (t: number) => voiceSpans.some(v => t >= v.s - 1e-6 && t < v.e + 1e-6);
      const voicePoint = (t: number) => onVoice(t) ? t : time.point(t);
      const voiceRange = <T extends { s: number; e: number }>(item: T): T => onVoice(item.s) ? item : time.range(item);
      // This revision keeps the voice as it is, so the save never retimes it to follow the pictures.
      if (record.voiceover && voiceSpans.length) record.voiceover = { ...record.voiceover, version: record.version };
      if(previous.layouts?.some(l=>l?.kind==='scene'))record.layouts=[...record.layouts??[],...remapLayoutRanges(previous.layouts,order.map((old,piece)=>{
        const a=before.items.filter(p=>p.piece===old),b=after.items.filter(p=>p.piece===piece);
        return {oldS:a[0].startS,oldE:a.at(-1)!.endS,s:b[0].startS,e:b.at(-1)!.endS};
      }),layoutRangeAdvance(previous))];
      record.overlays = previous.overlays?.map(time.range);
      record.lowerThirds = previous.lowerThirds?.map(time.range);
      record.angleCuts = previous.angleCuts?.map(c => ({ ...c, atS: time.point(c.atS) })).sort((a, b) => a.atS - b.atS);
      if (record.bigLines?.length || (record.titles as import("./titles/captions").CaptionTrack | undefined)?.kinetic) retimeKinetic(record, voicePoint);
      if (previous.titles) record.titles = { ...record.titles!, cues: previous.titles.cues.flatMap(cue => {
        if ((cue.words?.length ? cue.words : [cue]).every(w => onVoice(w.s))) return [cue];  // the voice's own captions stay
        // A sentence may cross a cut. Its measured words follow their own owners.
        if (cue.words?.length) {
          const groups = new Map<number, NonNullable<typeof cue.words>>();
          for (const word of cue.words) {
            const owner = before.items.find(p=>word.s>=p.startS-1e-7 && word.s<p.endS-1e-7)?.piece ?? -1;
            groups.set(owner,[...(groups.get(owner) ?? []),word]);
          }
          return [...groups.values()].map((words,i) => {
            const mapped = words.map(time.range);
            return {...time.range(cue),id:groups.size===1?cue.id:`${cue.id}:move:${i}`,s:mapped[0].s,e:mapped.at(-1)!.e,text:groups.size===1?cue.text:words.map(w=>w.text).join(" "),words:mapped};
          });
        }
        return [time.range(cue)];
      }).sort((a, b) => a.s - b.s) };
      const captions = record.titles as import("./titles/captions").CaptionTrack | null | undefined;
      if (captions?.speechOnsets) captions.speechOnsets = captions.speechOnsets.map(voicePoint).sort((a,b)=>a-b);
      if (captions?.captionSource) captions.captionSource = { ...captions.captionSource, words: captions.captionSource.words.map(voiceRange).sort((a,b) => a.s-b.s), faces: captions.captionSource.faces.map(time.range).sort((a,b) => a.s-b.s) };
      record.sfx = previous.sfx?.map(s => ({ ...s, atS: time.point(s.atS) }));
      if (previous.soundDesign?.authored) record.soundDesign = { ...previous.soundDesign, authored: previous.soundDesign.authored.map(s => ({ ...s, atS: time.point(s.atS) })) };
      if (record.cover) record.cover = { ...record.cover, t: time.point(record.cover.t) };
      for (const format of record.formats ?? []) if (format.cover) format.cover = { ...format.cover, t: time.point(format.cover.t) };
      syncFxMetadata(record, after);
      if(duplicated.length) {
        const cueIds=new Map<string,string>();
        const copyCueId=(id:string,delta:number)=>{const key=JSON.stringify([id,delta]);if(!cueIds.has(key))cueIds.set(key,`${id}:copy:${randomUUID()}`);return cueIds.get(key)!;};
        // Existing attachments follow their original occurrence. Copy only items
        // owned by a duplicated occurrence, using that occurrence's new clock.
        const beforeSpans=spans(before),copies=order.flatMap((old,piece)=>piece===index(old)?[]:[{old,piece}]);
        const copyRanges=<T extends {s:number;e:number}>(items:T[] | undefined)=>copies.flatMap(({old,piece})=>{
          const a=beforeSpans[old],b=after.items.filter(p=>p.piece===piece),delta=b[0].startS-a.startS;
          return (items ?? []).filter(item=>item.s>=a.startS-1e-7 && item.s<a.endS-1e-7).map(item=>({...item,s:item.s+delta,e:item.e+delta}));
        });
        const copyPoints=<T extends {atS:number}>(items:T[] | undefined)=>copyRanges(items?.map(item=>({...item,s:item.atS,e:item.atS}))).map(({s,e:_e,...item})=>({...item,atS:s}));
        record.overlays=[...record.overlays ?? [],...copyRanges(previous.overlays).map(item=>({...item,id:randomUUID()}))];
        record.lowerThirds=[...record.lowerThirds ?? [],...copyRanges(previous.lowerThirds).map(item=>({...item,id:randomUUID()}))];
        record.sfx=[...record.sfx ?? [],...copyPoints(previous.sfx).map(item=>({...item,id:randomUUID()}))];
        record.angleCuts=[...record.angleCuts ?? [],...copyPoints(previous.angleCuts)].sort((a,b)=>a.atS-b.atS);
        if(record.soundDesign?.authored)record.soundDesign.authored.push(...copyPoints(previous.soundDesign?.authored).map(item=>({...item,id:randomUUID()})));
        if(previous.titles && record.titles)record.titles.cues.push(...copyRanges(previous.titles.cues).map(cue=>{
          const old=previous.titles!.cues.find(c=>c.id===cue.id)!,delta=cue.s-old.s;
          return {...cue,id:copyCueId(cue.id,delta),words:old.words?.map(w=>({...w,s:w.s+delta,e:w.e+delta}))};
        }));
        const track=record.titles as import('./titles/captions').CaptionTrack | undefined;
        const priorTrack=previous.titles as import('./titles/captions').CaptionTrack | undefined;
        if(track?.captionSource && priorTrack?.captionSource)track.captionSource={...track.captionSource,words:[...track.captionSource.words,...copyRanges(priorTrack.captionSource.words)].sort((a,b)=>a.s-b.s),faces:[...track.captionSource.faces,...copyRanges(priorTrack.captionSource.faces)].sort((a,b)=>a.s-b.s)};
        if(track?.kinetic && priorTrack?.kinetic)track.kinetic={...track.kinetic,lines:[...track.kinetic.lines,...copyRanges(priorTrack.kinetic.lines.map(l=>({...l,sourceS:l.s}))).map(({sourceS,...line})=>{
          const delta=line.s-sourceS;
          return {...line,cues:line.cues.map(c=>({...c,id:copyCueId(c.id,delta),s:c.s+delta,e:c.e+delta,words:c.words?.map(w=>({...w,s:w.s+delta,e:w.e+delta}))}))};
        })].sort((a,b)=>a.s-b.s)};
        record.bigLines=[...record.bigLines ?? [],...copyRanges(previous.bigLines?.map(l=>({...l,e:l.s}))).map(({e:_e,...line})=>line)];
        record.titles?.cues.sort((a,b)=>a.s-b.s);
      }
      if(edit.kind==='shotOrder' && !edit.keepMyMoves && !edit.pieces)record.shotOrderResetAt=record.version;
      const clips=(n:number)=>`${n} clip${n===1?'':'s'}`;  // FIX4: plural only above one
      record.feedback = edit.kind==='shotOrder' ? `Moved ${clips(order.filter((old,i)=>old!==i).length)} into shot order` : duplicated.length ? `Duplicated ${clips(duplicated.length)}` : "Moved a clip";
      await renderStoredPreview(root, cutId, record, record.assembly);
      return { cutId, version: record.version };
    }));
}
