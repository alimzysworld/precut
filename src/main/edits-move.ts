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
import { splitPiecesAt, tombIndex, type PieceTomb } from "./edits-words";

type MoveEdit = Extract<CutEdit, { kind: "move" }>;
/** SCRIPT2: a move of words is a split, then this same piece move. The selection's edge pieces and the piece it lands in
 * are split at word boundaries first (splitPiecesAt), so the words become whole pieces; the result is the block of new
 * pieces to move and the new piece index it lands before. */
function splitForWords(record: StoredVersion, assembly: StoredVersion["assembly"], edit: MoveEdit & { words: NonNullable<MoveEdit["words"]> }) {
  const count = cutPieceGroups(assembly.cutList).length, { last, s, e, at } = edit.words;
  if (![edit.piece, last, edit.to].every(Number.isInteger) || edit.piece < 0 || last < edit.piece || last >= count || edit.to < 0 || edit.to > count)
    throw new Error("Choose words and a place in this edit.");
  if ([s, e, at].some(v => v !== undefined && !Number.isFinite(v))) throw new Error("Choose words and a place in this edit.");
  const cuts = [{ piece: edit.piece, at: s ?? -Infinity }, { piece: last, at: e ?? Infinity }, ...(at !== undefined && edit.to < count ? [{ piece: edit.to, at }] : [])]
    .filter(c => Number.isFinite(c.at));
  const split = splitPiecesAt(record, assembly, cuts);
  const point = (piece: number, value: number | undefined, edge: number) => {
    const i = cuts.findIndex(c => c.piece === piece && c.at === value);
    return value === undefined || i < 0 ? edge : split.points[i];
  };
  const from = point(edit.piece, s, -Infinity), through = point(last, e, Infinity);
  const block = split.halves.flatMap((h, i) => h.old >= edit.piece && h.old <= last && (h.old !== edit.piece || h.s >= from - 1e-9) && (h.old !== last || h.e <= through + 1e-9) ? [i] : []);
  if (!block.length) throw new Error("Select the words to move.");
  const lands = point(edit.to, at, -Infinity);
  let before = edit.to >= count ? split.halves.length : split.halves.findIndex(h => h.old === edit.to && h.s >= lands - 1e-9);
  if (before < 0) before = split.halves.findIndex(h => h.old > edit.to);
  if (before < 0) before = split.halves.length;
  const first = block[0], end = block.at(-1)!;
  if (before >= first && before <= end + 1) throw new Error("Choose a place outside the words you are moving.");
  return { first, end, before };
}

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
  const words = edit.kind==='move' && edit.words ? edit as MoveEdit & { words: NonNullable<MoveEdit["words"]> } : null;
  return runActivity({ kind: "edit", root, target: { cutId, version }, label: words ? "Moving words" : "Moving clip", cancelable: true }, () =>
    finishStoredVersion(root, cutId, version, true, async (record, assembly) => {
      // SCRIPT2: the words' pieces are split first; from here on it is the same move of whole pieces.
      const block = words ? splitForWords(record, assembly, words) : null;
      const previous = structuredClone(record), groups = cutPieceGroups(assembly.cutList);
      const duplicated=edit.kind==='duplicate' ? [...new Set(edit.pieces)].sort((a,b)=>a-b) : [];
      if(edit.kind==='duplicate' && (!duplicated.length || duplicated.length>500 || duplicated.some(i=>!Number.isInteger(i) || i<0 || i>=groups.length)))throw new Error('Choose clips in this edit.');
      const order = edit.kind==='shotOrder'
        ? shotOrder(groups.map(g=>g.items[0].seg?.clip),edit.pieces,edit.keepMyMoves ? handMovedPieces(previous,(await readCut(root,cutId)).versions) : undefined)
        : block ? blockOrder(groups.length, block) : edit.kind==='move' ? moveOrder(groups.length, edit.piece, edit.to) : Array.from({length:groups.length},(_,i)=>i);
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
        ...(block ? old>=block.first && old<=block.end ? {handMoved:true} : {} : edit.kind==='move' && old===edit.piece ? {handMoved:true} : {}),
        ...(edit.kind==='shotOrder' && !edit.keepMyMoves && (!edit.pieces || edit.pieces.includes(old)) ? {handMoved:false} : {})}));
      record.pieceFx = previous.pieceFx && order.map(old => previous.pieceFx?.[old] ?? null);
      record.layouts = previous.layouts && order.map(old => previous.layouts?.[old] ?? null);
      record.jumpScales = previous.jumpScales && order.map(old => previous.jumpScales?.[old] ?? null);
      record.bleeps = previous.bleeps?.flatMap(b => order.flatMap((old,piece)=>old===b.piece ? [{...b,piece}] : []));
      record.joins = order.slice(1).map((right, i) => right === order[i] + 1 ? previous.joins?.[order[i]] ?? null : null);
      if (block) {
        // Old and new seams are plain cuts. A transition the person set on the moved words' own edges goes with them;
        // its J or L sound came from the old neighbour, so that part does not.
        const at = index(block.first), end = index(block.end), own = (join: NonNullable<typeof record.joins>[number] | undefined) => {
          if (!join) return null; const { audio: _a, ...rest } = join; return rest;
        };
        const entry = own(previous.joins?.[block.first - 1]), exit = own(previous.joins?.[block.end]);
        if (entry && at > 0) record.joins[at - 1] = entry;
        if (exit && end < order.length - 1) record.joins[end] = exit;
        // Cut pieces stay after the piece they followed.
        if (record.cutPieces) record.cutPieces = (record.cutPieces as PieceTomb[]).map(tomb => { const old = tombIndex(tomb, previous.pieces ?? []); return { ...tomb, at: old === 0 ? 0 : index(old - 1) + 1 }; });
      }
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
        // CH2b: the voice stays where it is (VO7-19), so its captions are not copied with the picture: a copy of them
        // would show words the voice never says there, and the realign on open then saved a second "Duplicated" version.
        const spoken=(words:{s:number}[])=>!words.every(w=>onVoice(w.s));
        if(previous.titles && record.titles)record.titles.cues.push(...copyRanges(previous.titles.cues.filter(cue=>spoken(cue.words?.length ? cue.words : [cue]))).map(cue=>{
          const old=previous.titles!.cues.find(c=>c.id===cue.id)!,delta=cue.s-old.s;
          return {...cue,id:copyCueId(cue.id,delta),words:old.words?.map(w=>({...w,s:w.s+delta,e:w.e+delta}))};
        }));
        const track=record.titles as import('./titles/captions').CaptionTrack | undefined;
        const priorTrack=previous.titles as import('./titles/captions').CaptionTrack | undefined;
        if(track?.captionSource && priorTrack?.captionSource)track.captionSource={...track.captionSource,words:[...track.captionSource.words,...copyRanges(priorTrack.captionSource.words.filter(w=>!onVoice(w.s)))].sort((a,b)=>a.s-b.s),faces:[...track.captionSource.faces,...copyRanges(priorTrack.captionSource.faces)].sort((a,b)=>a.s-b.s)};
        if(track?.kinetic && priorTrack?.kinetic)track.kinetic={...track.kinetic,lines:[...track.kinetic.lines,...copyRanges(priorTrack.kinetic.lines.filter(l=>spoken(l.cues.flatMap((c):{s:number}[]=>c.words?.length ? c.words : [c]))).map(l=>({...l,sourceS:l.s}))).map(({sourceS,...line})=>{
          const delta=line.s-sourceS;
          return {...line,cues:line.cues.map(c=>({...c,id:copyCueId(c.id,delta),s:c.s+delta,e:c.e+delta,words:c.words?.map(w=>({...w,s:w.s+delta,e:w.e+delta}))}))};
        })].sort((a,b)=>a.s-b.s)};
        record.bigLines=[...record.bigLines ?? [],...copyRanges(previous.bigLines?.filter(l=>!onVoice(l.s)).map(l=>({...l,e:l.s}))).map(({e:_e,...line})=>line)];
        record.titles?.cues.sort((a,b)=>a.s-b.s);
      }
      if(edit.kind==='shotOrder' && !edit.keepMyMoves && !edit.pieces)record.shotOrderResetAt=record.version;
      const clips=(n:number)=>`${n} clip${n===1?'':'s'}`;  // FIX4: plural only above one
      record.feedback = edit.kind==='shotOrder' ? `Moved ${clips(order.filter((old,i)=>old!==i).length)} into shot order` : duplicated.length ? `Duplicated ${clips(duplicated.length)}` : block ? movedWords(previous, block) : "Moved a clip";
      await renderStoredPreview(root, cutId, record, record.assembly);
      return { cutId, version: record.version };
    }));
}

/** SCRIPT2: the spine with pieces first..end (inclusive) taken out and put back before piece `before`. */
function blockOrder(count: number, { first, end, before }: { first: number; end: number; before: number }): number[] {
  const all = Array.from({ length: count }, (_, i) => i), moved = all.slice(first, end + 1), rest = all.filter(i => i < first || i > end);
  rest.splice(before > end ? before - moved.length : before, 0, ...moved);
  return rest;
}
/** The undo label: the moved words, short. */
function movedWords(record: StoredVersion, { first, end }: { first: number; end: number }): string {
  // The measured words each piece plays (a piece's own `words` can be its file's name when it has no script line).
  const words = (record.pieces ?? []).slice(first, end + 1).filter(p => p.kind === "voice").flatMap(p =>
    (record.assembly.shoot.clips.find(c => c.id === p.clipId)?.transcript ?? []).flatMap(s => s.words)
      .filter(w => w.e > p.s + 1e-6 && w.s < p.e - 1e-6 && !(p.removed ?? []).some(r => r.kind !== "pause" && w.s < r.e && w.e > r.s))
      .map(w => w.w.trim())).filter(Boolean);
  if (!words.length) return "Moved words";
  return `Moved “${words.slice(0, 6).join(" ")}${words.length > 6 ? "…" : ""}”`;
}
