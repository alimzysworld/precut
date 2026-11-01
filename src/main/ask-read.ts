import { clipName, pieceName } from "../shared/clip-name";
import { filmedAt } from "./filmed-time";
import { matchScreen, listScreenRecordings } from './screen-match';
import { migrateLayouts } from '../shared/layout-presets';
import { defaultClipMuted } from '../shared/lane-levels';
import { balancedLook, legacyBalanceVersion } from "../shared/clip-balance";
import { normalizeBasic } from './basics';
import { clipDuckDb } from './music-duck';
import { keptBeatsFor, keptBeatPacket } from './kept-beats';
import { attachedClipSounds } from './clip-sound';
import { MUSIC_DUCK, duckDepth } from '../shared/music-duck';
import { clipStarred } from "./footage-stars";
// Fast local inspection for Ask. No preview healing, storage migrations or AI.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Shoot } from "../shared/schema";
import { hydrateCut, readCutDocument } from "./cut-storage";
import { effectiveShoot } from "./steps";
import { resolveReelPieces } from "./reel";
import { fxWords, mapSource, mapTime, planFx } from "./edits-fx";
import { takeThumbnail } from "./thumbnails";
import { transcriptText } from "./titles/text";

export const ASK_READ_NAMES = ["find_words", "read_edit", "read_transcript", "list_takes", "look_at", "search_footage", "match_screen", "list_screen_recordings"];
const MAX_BYTES = 49_000;
type Args = { cut?: string; version?: number; offset?: number; limit?: number; detail?: boolean; line?: number; query?: string; topic?: string;
  times?: number[]; clipId?: string; in?: "edit" | "shoot"; phrase?: string; words?: string[] };
export async function readShoot(root: string): Promise<Shoot> {
  return effectiveShoot(JSON.parse(await fs.readFile(path.join(root, ".sidething/index.json"), "utf8")));
}
async function loadEdit(root: string, shoot: Shoot, args: Args) {
  if (!args.cut || path.basename(args.cut) !== args.cut || args.cut === "." || args.cut === "..") throw new Error("Choose an edit id from list_cuts.");
  // Hydrate in memory only: readCutFile deliberately migrates old files on read.
  const cut = hydrateCut(await readCutDocument(path.join(root, ".sidething/sidekick/cuts", `${args.cut}.json`)) as never, shoot);  // ARCH2: head + log
  // VO7-2: an omitted version reads the current revision (what is on screen after any undo).
  const wanted = args.version ?? await import("./revisions").then(m => m.currentVersion(root, args.cut!)).catch(() => cut.versions.at(-1)?.version);  // at(-1): no history readable
  const chosen = cut.versions.find(v => v.version === wanted);
  const saved=chosen && legacyBalanceVersion(chosen);
  if (!saved) throw new Error("That edit version does not exist.");
  const a = saved.assembly;
  if (!a) throw new Error("That edit has no saved source assembly.");
  const fx = planFx(a.cutList, a.template.fps, saved);
  const pieces = saved.pieces?.length ? saved.pieces : resolveReelPieces(shoot, a.template, a.cutList, a.reel);
  return { cut, saved, a, fx, pieces };
}
type Edit = Awaited<ReturnType<typeof loadEdit>>;
function editWords(edit: Edit) {
  return edit.a.cutList.flatMap((item, i) => {
    const timing = edit.fx.items[i], rate = item.clipFpsR.num / item.clipFpsR.den;
    const s = item.inFrames / rate, e = item.outFrames / rate;
    if (item.seg?.clip.leftOut) return [];
    return fxWords(item).filter(word => word.s < e && word.e > s).map(word => ({
      piece: timing.piece, clipId: item.seg?.clip.id, ...word,
      muted: timing.muted || !!edit.saved.laneMuted?.['clip-sound'] || !!timing.reverse,
      reelS: mapTime(timing.timeMap, Math.max(s, word.s)),
      reelE: mapTime(timing.timeMap, Math.min(e, word.e)),
    }));
  });
}
// All collections share one offset. nextOffset resumes every collection; totals
// make empty/finished collections explicit. Leave room for MCP original-file annotations.
// Never silently drop the tail.
function page(meta: Record<string, unknown>, collections: Record<string, unknown[]>, args: Args, maxBytes = 20_000): unknown {
  const offset = args.offset ?? 0;
  let limit = args.limit ?? 80;
  const total = Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, rows.length]));
  while (true) {
    const result = { ...meta, offset, nextOffset: Object.values(total).some(n => n > offset + limit) ? offset + limit : null, total,
      ...Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, rows.slice(offset, offset + limit)])) };
    if (Buffer.byteLength(JSON.stringify(result)) < maxBytes) return result;
    if (limit === 1) {
      // REL09e: one record over the budget is summarised in place (its plain fields kept, marked shortened), never a failed read.
      const shortened = { ...result, ...Object.fromEntries(Object.keys(collections).map(key => [key, ((result as Record<string, unknown>)[key] as unknown[]).map(row => shorten(row, maxBytes))])) };
      if (Buffer.byteLength(JSON.stringify(shortened)) < maxBytes) return shortened;
      throw new Error("One record is too large. Request a smaller source span or inspect the shoot index locally.");
    }
    limit = Math.max(1, Math.floor(limit / 2));
  }
}
function shorten(row: unknown, maxBytes: number): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row) || Buffer.byteLength(JSON.stringify(row)) < maxBytes / 8) return row;
  const plain = Object.entries(row).filter(([, v]) => v === null || typeof v !== "object").map(([k, v]) => [k, typeof v === "string" && v.length > 200 ? v.slice(0, 200) + " [text shortened]" : v]);
  return { ...Object.fromEntries(plain), shortened: true };
}
/** REL09e: a graphic in a compact read_edit: what it is, where and how long, not its code (detail:true or get_motion has that). */
function compactOverlay(item: import("../shared/schema").OverlayItem) {
  if (!item.graphic) return item;
  const { html: _html, css: _css, js: _js, look: _look, frames: _frames, behindCheck: _check, motion: _motion, composition: _composition, ...graphic } = item.graphic as typeof item.graphic & Record<string, unknown>;
  return { ...item, graphic };
}
const short = (text: string | undefined) => text && text.length > 2000 ? text.slice(0, 2000) + " [text shortened]" : text;
// Export instructions are not editorial observations, even on older saved versions.
const editorial = (text: string | undefined) => short(text?.replace(/\n*\[(Energy framing|Motion framing)\][\s\S]*?\[\/\1\]/g, '').trim());
export async function readAskTool(root: string, name: string, args: Args): Promise<unknown> {
  const sourceShoot = await readShoot(root);
  const shoot = { ...sourceShoot, clips: sourceShoot.clips.filter(c => !c.leftOut) };
  const available = new Set(shoot.clips.map(c => c.id));
  if (name === "find_words") {
    if (!!args.phrase === !!args.words?.length) throw new Error("Supply either a phrase or a list of words.");
    if (args.in !== "shoot" && !args.cut) throw new Error("Choose an edit or use in:shoot.");
    const normalize = (text: string) => text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
    const needles = (args.phrase ? [args.phrase] : args.words!).map(normalize);
    if (needles.some(n => !n.length)) throw new Error("Search for words containing letters or numbers.");
    const streams = args.in === "shoot" ? shoot.takes.flatMap(line => line.attempts.map((take, attempt) => ({
      take: `L${line.lineIndex + 1}A${attempt + 1}`, clipId: take.clipId, piece: null as number | null,
      words: (shoot.clips.find(c => c.id === take.clipId)?.transcript ?? []).flatMap(s => s.words).filter(w => w.s >= take.s - 1e-6 && w.e <= take.e + 1e-6),
    }))) : (() => {
      // A sub-item is a contiguous kept run. Phrases cannot jump deleted words.
      return [] as { take?: string; clipId: string | undefined; piece: number | null; words: { w: string; s: number; e: number }[] }[];
    })();
    if (args.in !== "shoot") {
      const edit = await loadEdit(root, sourceShoot, args);
      for (const [i, item] of edit.a.cutList.entries()) {
        if (!item.seg || !available.has(item.seg.clip.id) || item.seg.lineIndex === null) continue;
        const rate = item.clipFpsR.num / item.clipFpsR.den;
        streams.push({ clipId: item.seg.clip.id, piece: edit.fx.items[i].piece, words: fxWords(item).filter(w => w.s >= item.inFrames / rate - 1e-6 && w.e <= item.outFrames / rate + 1e-6) });
      }
    }
    const hits = streams.flatMap(stream => {
      const tokens = stream.words.flatMap((word, index) => normalize(word.w).map(text => ({ text, word, index })));
      return tokens.flatMap((token, at) => needles.flatMap(needle => {
        if (!needle.every((text, j) => tokens[at + j]?.text === text)) return [];
        const last = tokens[at + needle.length - 1];
        return [{ piece: stream.piece, name: clipName(shoot.clips.find(c => c.id === stream.clipId), { s: token.word.s, e: last.word.e }), take: stream.take, clipId: stream.clipId, s: token.word.s, e: last.word.e,
          text: transcriptText(stream.words.slice(token.index, last.index + 1).map(w => w.w)),
          context: transcriptText(stream.words.slice(Math.max(0, token.index - 5), last.index + 6).map(w => w.w)) }];
      }));
    });
    return page({ shoot: shoot.name, clock: "source seconds", matching: "Whole words, case insensitive", in: args.in ?? "edit" }, { hits: [...new Map(hits.map(h => [JSON.stringify([h.piece,h.take,h.clipId,h.s,h.e]), h])).values()] }, args);
  }
  if (name === "list_takes") return page({ shoot: shoot.name, clock: "source seconds", lineNumbers: "one-based" }, {
    shots: args.line === undefined ? shoot.clips.map(clip => ({ clipId: clip.id, name: clipName(clip), shot: clip.shot ?? null,
      starred: clipStarred(shoot, clip), summary: short(clip.judgement?.summary) })) : [],
    takes: shoot.takes.filter(line => args.line === undefined || line.lineIndex + 1 === args.line).flatMap(line => line.attempts.flatMap((a, index) => !available.has(a.clipId) ? [] : [{
      line: line.lineIndex + 1, script: short(shoot.script[line.lineIndex]), take: `L${line.lineIndex + 1}A${index + 1}`,
      ...a, text: short(a.text), note: short(a.note), starred: !a.practice && index === line.starred, judgeReason: line.starredByHand ? null : short(line.why),
    }])),
  }, args);
  if (name === "match_screen") {
    if (!args.topic?.trim()) throw new Error("Choose a topic for the screen recording.");
    return page({ shoot:shoot.name, topic:args.topic, matching:"Local lexical ranking; the closest available screen is returned even without shared words." }, { segments:matchScreen(shoot,args.topic) },args);
  }
  if (name === "list_screen_recordings") return page({ shoot:shoot.name, clock:"source seconds" }, { recordings:listScreenRecordings(shoot).map(({segments,...clip}) => ({...clip, segmentCount:segments.length})),
    segments:listScreenRecordings(shoot).flatMap(c => c.segments.map(s => ({clipId:c.clipId,...s}))) },args);
  if (name === "search_footage") {
    const query = args.query!.normalize("NFKC").toLocaleLowerCase().trim();
    const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!terms.length) throw new Error("Search with a topic or phrase containing words.");
    const hits: { kind: string; clipId: string; s: number; e: number; text: string; score: number; source: { clipId: string; s: number; e: number } }[] = [];
    const add = (kind: string, clipId: string, s: number, e: number, text: string) => {
      if (!available.has(clipId)) return;
      const lower = text.normalize("NFKC").toLocaleLowerCase(), matched = terms.filter(term => lower.includes(term)).length;
      if (!matched || e <= s) return;
      hits.push({ kind, clipId, s, e, text: short(text)!, score: lower.includes(query) ? terms.length + 1 : matched, source: { clipId, s, e } });
    };
    for (const clip of shoot.clips) {
      for (const segment of clip.screen?.segments ?? []) add("screen", clip.id, segment.s, segment.e, [segment.line,segment.app,segment.action,segment.text].filter(Boolean).join(" "));
      for (const segment of clip.transcript ?? []) add("transcript", clip.id, segment.s, segment.e, segment.text);
      if (clip.judgement?.kind === "broll") for (const span of clip.judgement.usableSpans.length ? clip.judgement.usableSpans : [[0, clip.meta?.durationS ?? 0]])
        add("broll", clip.id, span[0], span[1], clip.judgement.summary);
    }
    hits.sort((a, b) => b.score - a.score || a.clipId.localeCompare(b.clipId) || a.s - b.s);
    return page({ shoot: shoot.name, query: args.query, matching: "Local lexical candidates. Judge topic meaning from the text; expand terms or read_transcript for exhaustive coverage.",
      copy: "Pass chosen hits' source objects to create_cut.from in the desired order. Speaker names are searchable only when present in saved text; no speaker diarisation is available." }, { hits }, args);
  }
  if (name === "read_transcript" && !args.cut) return page({ shoot: shoot.name, clock: "source seconds" }, {
    lines: shoot.clips.flatMap(clip => (clip.transcript ?? []).map((segment, index) => ({ clipId: clip.id, line: index + 1,
      s: segment.s, e: segment.e, text: short(segment.text), words: segment.words }))),
  }, args);
  const edit = args.cut ? await loadEdit(root, sourceShoot, args) : undefined;
  if (name === "look_at") {
    // REL2: Settings, Privacy. With "AI sees frames" off no picture leaves precut for an AI.
    if ((await (await import("./settings")).getPreferences()).aiSeesFrames === false) throw new Error("AI sees frames is off in Settings, Privacy, so precut sends no pictures. Work from the transcript and measurements, or ask the person to turn it on.");
    if (!args.clipId && !edit) throw new Error("Choose an edit for reel times, or a clipId for source times.");
    const frames: { requestedS: number; clipId: string; sourceS: number; full: string; data: string; tiny?: boolean }[] = [];
    for (const t of args.times!) {
      let clipId = args.clipId, sourceS = t;
      if (!clipId && edit) {
        if (t >= edit.fx.durationS) throw new Error("Choose a reel time before the end of this edit.");
        // Later item wins during a dissolve, matching the foreground picture.
        const i = edit.fx.items.map((item, index) => t >= item.startS && t < item.endS ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
        const timing = edit.fx.items[i], item = edit.a.cutList[i];
        if (!timing || !item?.seg) throw new Error("There is no source picture at that reel time.");
        clipId = item.seg.clip.id;
        sourceS = mapSource(timing.timeMap, timing.reverse ? timing.startS + timing.endS - t : t);
        const ownerStart = edit.fx.items.find(item => item.piece === timing.piece)!.startS;
        const overlay = edit.a.reel.broll.find(o => o.voiceIndex === timing.piece && t - ownerStart < o.seg.e - o.seg.s);
        if (overlay) { clipId = overlay.seg.clip.id; sourceS = overlay.seg.s + t - ownerStart; }
      }
      const clip = shoot.clips.find(c => c.id === clipId);
      if (!clip?.meta || sourceS < 0 || sourceS >= clip.meta.durationS) throw new Error("Choose a source time inside the clip.");
      const full = await takeThumbnail(root, clipId!, sourceS);
      frames.push({ requestedS: t, clipId: clipId!, sourceS, full, data: (await fs.readFile(full)).toString("base64") });
    }
    const result = () => ({ content: [
      { type: "text", text: JSON.stringify({ clock: args.clipId ? "source seconds" : "reel seconds", note: "Cached source pictures, before looks, captions, layouts or compositing. If tiny=true, request fewer stills for more detail.",
        frames: frames.map(({ data: _data, full: _full, ...frame }) => frame) }) },
      ...frames.map(frame => ({ type: "image", mimeType: "image/jpeg", data: frame.data })),
    ] });
    // Six busy JPEGs can exceed the text budget. P3 already caches a tiny still
    // alongside every full still, so using it never launches another encoder.
    for (let i = 0; Buffer.byteLength(JSON.stringify(result())) >= MAX_BYTES && i < frames.length; i++) {
      frames[i].data = (await fs.readFile(await takeThumbnail(root, frames[i].clipId, frames[i].sourceS, true))).toString("base64");
      frames[i].tiny = true;
    }
    if (Buffer.byteLength(JSON.stringify(result())) >= MAX_BYTES) throw new Error("Request fewer stills.");
    return result();
  }
  if (!edit) throw new Error("Choose an edit id.");
  const { saved, fx, pieces, a } = edit, words = editWords(edit);
  const meta = { cutId: edit.cut.cutId, version: saved.version, title: saved.title, lengthS: fx.durationS, reason: editorial(saved.feedback ?? saved.why), notes:editorial(saved.why) };
  if (name === "read_transcript") return page({ ...meta, clock: "s/e source seconds; reelS/reelE reel seconds" }, {
    lines: pieces.flatMap((piece, index) => {
      const kept = words.filter(word => word.piece === index);
      return piece.kind === "voice" ? [{ piece: index, name: pieceName(shoot, { pieces }, index), take: piece.id, clipId: piece.clipId,
        line: /^L(\d+)A/.test(piece.id) ? Number(/^L(\d+)A/.exec(piece.id)![1]) : null, s: piece.s, e: piece.e,
        reelS: kept.length ? Math.min(...kept.map(w => w.reelS)) : piece.timelineS,
        reelE: kept.length ? Math.max(...kept.map(w => w.reelE)) : piece.timelineS + piece.lengthS,
        text: transcriptText(kept.map(w => w.w)), words: kept }] : [];
    }),
  }, args);
  if (name !== "read_edit") throw new Error("Unknown read tool.");
  const music: import("./sidekick").StoredVersion["music"] = saved.music !== undefined ? saved.music : saved.assembly.reel.music ?? null;
  const musicDepth = duckDepth(music?.duckDepthDb), duckEnabled = !!music && !saved.laneMuted?.music && music.duck !== false;
  const keepBeat = music?.stemDucking === true;
  const stemsAvailable=keepBeat && (await (await import('./extensions')).readExtension('sound-separation')).state==='installed';
  const stemsReady=keepBeat && !!music && !!await (await import('./stem-mix')).cachedMusicStems(root,path.resolve(root,music.file),{s:music.startS,e:music.startS+fx.durationS}).catch(()=>undefined);
  const attached = attachedClipSounds(saved.assembly.reel.broll,fx,saved,saved.assembly.template.fps);
  const arrangement=await (await import('./music-arrange')).readMusicArrangement(root,saved,fx);
  const cutMusicPlan=await (await import("./cut-to-music")).readCutMusicPlan(root,saved);
  const musicGrid=await (await import('./music-timeline')).timelineMusic(root,saved,fx).catch(()=>undefined);
  const { beatAt }=await import('../shared/music-grid');
  const musicEnd = Math.min(fx.durationS, music?.endS ?? fx.durationS);
  const musicParts = arrangement?.parts ?? [];
  const musicPlays = musicParts.map(part => ({sourceS:part.sourceS,sourceE:Math.min(part.sourceE,part.sourceS+musicEnd-part.atS),atS:part.atS})).filter(part=>part.sourceE>part.sourceS);
  const clock = (s:number) => `${Number(s.toFixed(2))}s`;
  const playing = musicPlays.length ? musicPlays.map(p=>`Track ${clock(p.sourceS)} to ${clock(p.sourceE)} plays at edit ${clock(p.atS)} to ${clock(p.atS+p.sourceE-p.sourceS)}.`).join(' ')
    : music ? `Track ${clock(music.startS)} to ${clock(music.startS+musicEnd)} plays from the start of the edit${music.fit || music.followStory ? ' while the arrangement is not ready' : ''}.` : undefined;

  return page({ ...meta, detail:!!args.detail, clock: "pieces and words s/e are source seconds; timelineS/reelS/reelE are reel seconds; muted words are not heard", grade: saved.grade, balanceReference:saved.balanceReference,
    framing: saved.framing, transition: saved.transition, clipSoundMuted: !!saved.clipSoundMuted, laneLevels: Object.fromEntries(["clip-sound","voice","music","effects"].map(lane=>[lane,saved.laneLevels?.[lane as import("../shared/schema").SoundLane] ?? 0])), laneMuted:saved.laneMuted ?? {}, audio: saved.audio, music: music ? {name:path.basename(music.file,path.extname(music.file)), file:music.file, startS:music.startS, endS:musicEnd, plays:short(playing), gainDb:music.gainDb ?? -18, effectiveGainDb:(music.gainDb ?? -18)+(saved.laneLevels?.music ?? 0),muted:!!saved.laneMuted?.music, duckDepthDb:musicDepth, duck:duckEnabled} : null,
    cutMusicPlan: cutMusicPlan ? {summary:cutMusicPlan.summary,durationS:cutMusicPlan.durationS} : null,
    musicArrangement: arrangement ? {state:'ready',source:music?.file,summary:arrangement.summary,repeats:arrangement.repeats ?? null,alreadyFits:arrangement.alreadyFits,durationS:arrangement.durationS,coversEdit:Math.abs(arrangement.durationS-fx.durationS)<1e-3,...(args.detail ? {sections:arrangement.parts,shape:arrangement.shape} : {}),ending:arrangement.ending,metre:arrangement.measurements.metre} : music && (music.fit || music.followStory) ? {state:await (await import('./music-arrange')).musicArrangementStatus(root,saved,fx) ?? null,source:music.file} : null,
    musicBeatSource: musicGrid && music ? music.file : null,
    ...(keepBeat ? {stemDucking:{keepBeatOn:true,active:duckEnabled && stemsAvailable && stemsReady,separationInstalled:stemsAvailable,separatedAudioReady:stemsReady,rhythmDipDb:Math.min(2,musicDepth),voiceDipDb:musicDepth}} : {}),
    autoLayouts:saved.autoLayouts?{enabled:saved.autoLayouts.enabled,offered:saved.autoLayouts.offer?.length??0,error:saved.autoLayouts.error}:null,
    cover: saved.cover ? {t:saved.cover.t,auto:saved.cover.auto,title:saved.cover.title} : {automatic:true},
    captionStyle: saved.titles?.captionStyle, captionLanguage: saved.captionLanguage,
    // V66: where the caption words come from; voiceover words carry negative piece ids.
    captionSource: (()=>{const t=saved.titles as {captionSource?:{words:{piece?:number}[]};captionWordsEdited?:boolean}|null|undefined, w=t?.captionSource?.words ?? [];return t ? {voiceoverWords:w.filter(x=>(x.piece ?? 0)<0).length,speechWords:w.filter(x=>(x.piece ?? 0)>=0).length,handEdited:!!t.captionWordsEdited} : null;})() }, {
    musicParts: musicPlays,
    musicShape: arrangement?.shape ?? [],
    musicCuts: cutMusicPlan?.cuts ?? [],
    musicBeats: musicGrid ? [...musicGrid.beats.map(atS=>({atS,kind:'beat'})),...musicGrid.bars.map(atS=>({atS,kind:'bar'})),...musicGrid.hits.map(atS=>({atS,kind:'hit'}))].sort((a,b)=>a.atS-b.atS) : [],
    musicSections: musicGrid?.sections ?? [],
    keptBeats: keptBeatPacket(saved,await keptBeatsFor(root, edit!.cut, saved.version)).filter(beat => available.has(beat.clipId)),
    pieces: pieces.flatMap((piece, index) => {
      if (piece.clipId && !available.has(piece.clipId)) return [];
      const timings = fx.items.filter(item => item.piece === index);
      const source = saved.assembly.cutList.find((c,i)=>(c.piece ?? i)===index);
      const heard = !saved.laneMuted?.['clip-sound'] && timings.some(t=>!t.muted && !t.reverse) && shoot.clips.some(c=>c.id===piece.clipId && (c.sound || c.meta?.audioChannels));
      const ownDuck = source && timings[0] ? clipDuckDb(source,timings[0]) : MUSIC_DUCK.ambienceDb;
      const overlaySource = attached.find(p=>p.item.piece===index);
      const overlayHeard = !saved.laneMuted?.['clip-sound'] && !!overlaySource && !overlaySource.item.muted && !!(overlaySource.cut.seg?.clip.sound || overlaySource.cut.seg?.clip.meta?.audioChannels);
      const look = balancedLook(saved,piece.clipId ?? "",index);
      const clip = shoot.clips.find(c=>c.id===piece.clipId);
      const name = heard ? pieceName(shoot,{pieces},index) : clipName({judgement:clip?.judgement ?? null,meta:clip?.meta ?? null,transcript:[]},{s:piece.s,e:piece.e,timelineS:piece.timelineS,lengthS:piece.lengthS,description:piece.description});

      return [{ ...(args.detail ? piece : {id:piece.id,kind:piece.kind,clipId:piece.clipId,s:piece.s,e:piece.e,overlay:piece.overlay}), name, filmedAt:filmedAt(shoot.clips.find(c=>c.id===piece.clipId)), look: look ? {...look,basic:normalizeBasic(look.basic)} : null, lookOwner: saved.balances?.[piece.clipId ?? ""]?.owner ?? (saved.pieceFx?.[index]?.look ? "hand" : null), balance:saved.balances?.[piece.clipId ?? ""] ?? null, words: short(transcriptText(words.filter(word => word.piece === index && !word.muted).map(word => word.w))), speechMuted:!heard, description: short(piece.description || shoot.clips.find(c=>c.id===piece.clipId)?.judgement?.summary), piece: index,
        timelineS: timings[0]?.startS ?? piece.timelineS, lengthS: timings.length ? timings.at(-1)!.endS - timings[0].startS : piece.lengthS,
        overlaySound: piece.overlay ? {clean:saved.pieceFx?.[index]?.overlaySound?.clean ?? "none",muted:saved.pieceFx?.[index]?.overlaySound?.muted ?? !saved.clipSoundDefaultOn,trackMuted:!!saved.clipSoundMuted || !!saved.laneMuted?.['clip-sound'],effectiveGainDb:overlaySource?.item.gainDb ?? 0,gainDb:saved.pieceFx?.[index]?.overlaySound?.gainDb ?? 0, ducking:{enabled:duckEnabled && overlayHeard,depthDb:duckEnabled && overlayHeard ? musicDepth*clipDuckDb(overlaySource!.cut,overlaySource!.item)/MUSIC_DUCK.speechDb : 0}} : null, sound: {clean:saved.pieceFx?.[index]?.clean ?? "none",muted: saved.pieceFx?.[index]?.muted ?? defaultClipMuted(saved,piece.kind === "broll"), trackMuted: !!saved.clipSoundMuted || !!saved.laneMuted?.['clip-sound'], heard, effectiveGainDb:timings[0]?.gainDb ?? 0, gainDb:saved.pieceFx?.[index]?.gainDb ?? 0, ducking: { enabled:duckEnabled && heard, depthDb:duckEnabled && heard ? musicDepth*ownDuck/MUSIC_DUCK.speechDb : 0 }}, fx: saved.pieceFx?.[index] ?? null, layout: saved.layouts?.[index] ?? null }];
    }), words, joins: fx.joins.map(join=>({...join,musicBeatS:musicGrid ? beatAt(musicGrid,join.atS,1/(2*saved.assembly.template.fps)) ?? null : null})), captions: saved.titles?.cues ?? [], sounds: saved.sfx ?? [],
    layouts: migrateLayouts(saved,a.template.width/a.template.height), overlays: (saved.overlays ?? []).map(o => args.detail ? o : compactOverlay(o)), lowerThirds: saved.lowerThirds ?? [], bleeps: saved.bleeps ?? [], angleCuts: saved.angleCuts ?? [],
    // SCRIPT1: what the Script panel shows struck: pieces whose every word was cut (restore_words cut) and voiceover
    // words cut (edit_voiceover restoreCut). at is the piece index a cut piece sits before; voice at is reel seconds.
    cutPieces: (saved.cutPieces ?? []).map(t => ({ id: t.id, at: t.at, after: t.after ?? null, piece: { id: t.piece.id, clipId: t.piece.clipId, s: t.piece.s, e: t.piece.e, words: t.piece.words, removed: t.piece.removed } })),
    voiceCuts: (saved.voiceCuts ?? []).map(({ lines: _lines, ...cut }) => cut),
  }, { ...args, limit:args.limit ?? (args.detail ? 80 : 24) }, args.detail ? MAX_BYTES : 12_000);
}
