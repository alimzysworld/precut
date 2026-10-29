import { newEditClipSound } from '../shared/lane-levels';
import { getPreferences } from "./settings";
import { DEFAULT_DETAIL, detailReadme } from "../renderer/src/components/finish/detailMath";
import { gradeForLook } from "./grade";
import { retimeKinetic } from "./titles/captions";
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readLogHead, readCutDocument, logPaths } from './cut-storage';
import type { Api, CutEdit, Shoot, Template } from '../shared/schema';
import { PREVIEW_REV, changed, cutFile, readCut, saveCutFile, withShootLock, freshen, renderStoredPreview, sidekickThread, type StoredCut, type StoredVersion } from './sidekick';
import { buildCutList, cutPieceGroups, listTemplates, sourceWords, type CutItem, type Segment } from './export';
import { resolveReelPieces, measureReelVoice, type ReelAssembly } from './reel';
import { listSkills, skillTemplate } from './skills';
import { effectiveShoot } from './steps';
import { runActivity } from './activity';
import { planFx, remapFxTime, syncFxMetadata } from './edits-fx';

type Source = NonNullable<Parameters<Api['createCut']>[1]['from']>[number];
const nearest = (value: number, edges: number[]) => edges.reduce((best, edge) => Math.abs(edge - value) < Math.abs(best - value) ? edge : best);

/** Resolve one explicit source, without consulting model picks or changing other pieces. */
export function sourceItems(shoot: Shoot, template: Template, source: Source): { id: string; items: CutItem[] } {
  let seg: Segment, id: string;
  if ('take' in source) {
    const match = /^L([1-9]\d*)A([1-9]\d*)$/.exec(source.take);
    const attempt = match ? shoot.takes.find(t => t.lineIndex === Number(match[1]) - 1)?.attempts[Number(match[2]) - 1] : undefined;
    const clip = shoot.clips.find(c => c.id === attempt?.clipId);
    if (!match || !attempt || clip?.leftOut || !clip?.meta || ![attempt.s, attempt.e].every(Number.isFinite) || attempt.s < 0 || attempt.e > clip.meta.durationS || attempt.s >= attempt.e) throw new Error('That take is unavailable.');
    seg = { clip, s: attempt.s, e: attempt.e, lineIndex: Number(match[1]) - 1, marker: `${source.take}: ${attempt.text}` }; id = source.take;
  } else {
    const clip = shoot.clips.find(c => c.id === source.clipId);
    if (clip?.leftOut || !clip?.meta || ![source.s, source.e].every(Number.isFinite) || source.s < 0 || source.e > clip.meta.durationS || source.s >= source.e) throw new Error('Choose a valid source span from this shoot.');
    const voice = clip.judgement?.kind !== 'broll' && (!!clip.transcript?.some(p => p.words?.length) || shoot.takes.some(t => t.attempts.some(a => a.clipId === clip.id)) || clip.judgement?.kind === 'talking');
    seg = { clip, s: 0, e: clip.meta.durationS, lineIndex: voice ? 0 : null, marker: clip.file };
    if (voice) {
      const words = sourceWords(shoot, seg);
      const starts = words.filter(w => !words.some(other => other.s < w.s && other.e > w.s)).map(w => w.s);
      const ends = words.filter(w => !words.some(other => other.s < w.e && other.e > w.e)).map(w => w.e);
      if (!starts.length || !ends.length) throw new Error('This clip has no measured words to insert safely.');
      const inside=(t:number)=>words.some(w=>t>w.s+1e-7 && t<w.e-1e-7);
      seg = { ...seg, s: inside(source.s) ? nearest(source.s, starts) : source.s, e: inside(source.e) ? nearest(source.e, ends) : source.e };
    } else seg = { ...seg, s: source.s, e: source.e };
    id = `source-${randomUUID()}`;
  }
  if (seg.s >= seg.e) throw new Error('Keep at least one complete word or frame.');
  // An explicit marked window keeps its measured length, including silence.
  // Build its frame clock without automatic take padding or filler removal,
  // then restore speech identity for captions and sound defaults.
  const items = buildCutList(shoot, 'reel', template, ['take' in source ? seg : {...seg,lineIndex:null}]);
  // Measured speech edges can expand a take. Explicit spans keep their snapped edges.
  const bounded = 'take' in source ? items : items.flatMap(item => {
    const rate = item.clipFpsR.num / item.clipFpsR.den;
    const s = seg.lineIndex === null ? Math.max(item.inFrames, Math.ceil(seg.s * rate - 1e-9)) / rate : Math.max(seg.s, item.inFrames / rate);
    const e = seg.lineIndex === null ? Math.min(item.outFrames, Math.floor(seg.e * rate + 1e-9)) / rate : Math.min(seg.e, item.outFrames / rate);
    return e > s ? [{ ...item, seg, inFrames: s * rate, outFrames: e * rate, durTimelineFrames: (e - s) * template.fps }] : [];
  });
  if (!bounded.length) throw new Error('That source span has no playable frames.');
  return { id, items: bounded };
}
function assembly(shoot: Shoot, template: Template, groups: CutItem[][], ids: string[], base?: ReelAssembly): StoredVersion['assembly'] {
  let offsetFrames = 0;
  const cutList = groups.flatMap((items, piece) => items.map(item => { const next = { ...item, piece, offsetFrames }; offsetFrames += item.durTimelineFrames; return next; }));
  const reel: ReelAssembly = base ? structuredClone(base) : { title: '', why: '', warnings: [], voiceLUFS: null, broll: [], cuts: [], model: { title: '', why: '', warnings: [], voice: [], broll: [], music: null } };
  reel.cuts = cutPieceGroups(cutList).map(({ piece, items }) => {
    const first = items[0], last = items.at(-1)!, rate = first.clipFpsR.num / first.clipFpsR.den;
    return { id: ids[piece], clipId: first.seg!.clip.id, s: first.inFrames / rate, e: last.outFrames / rate, offsetS: first.offsetFrames / template.fps, lengthS: items.reduce((n, c) => n + c.durTimelineFrames / template.fps, 0), beatDeltaS: 0, beatS: null };
  });
  reel.model.voice = ids.map(id => ({ id }));
  return { shoot, template, cutList, reel };
}
export const createCut: Api['createCut'] = async (root, opts = {}) => {
  root = path.resolve(root);
  if (opts.title !== undefined && (typeof opts.title !== 'string' || !opts.title.trim() || opts.title.trim().length > 240 || /[\x00-\x1f\x7f]/.test(opts.title))) throw new Error('Use a title between 1 and 240 characters.');
  if (opts.from !== undefined && !Array.isArray(opts.from)) throw new Error('Choose a list of clips.');
  return withShootLock(root, async () => {
    const shoot = effectiveShoot(JSON.parse(await fs.readFile(path.join(root, '.sidething/index.json'), 'utf8')));
    const skills = await listSkills(), templates = await listTemplates();
    const fallback = templates[0] ?? { id: 'blank', name: 'Blank', width: 1080, height: 1920, fps: 25, drpPath: null, notes: '' };
    const defaults = await getPreferences();
    const template = skillTemplate(skills, [], shoot, fallback, defaults.output.fps);
    const selected = (opts.from ?? []).map(source => sourceItems(shoot, template, source));
    const saved = assembly(shoot, template, selected.map(s => s.items), selected.map(s => s.id));
    const title = opts.title?.trim() || 'Untitled edit';
    saved.reel.title = saved.reel.model.title = title;
    const cutId = randomUUID();
    if (defaults.look.detail !== false) saved.reel.why += `\n\n[Detail]\n${detailReadme}\n${JSON.stringify(DEFAULT_DETAIL)}\n[/Detail]`;
    const record: StoredVersion = { audio: { ...defaults.voice }, grade: { ...gradeForLook("rec709", defaults.look), detail: defaults.look.detail === false ? null : { ...DEFAULT_DETAIL } }, baseVersion: 0, version: 1, createdAt: new Date().toISOString(), title, voice: selected.map(s => s.id), broll: [], music: null, pieces: resolveReelPieces(shoot, template, saved.cutList, saved.reel), templateId: template.id, lengthS: saved.cutList.reduce((n, c) => n + c.durTimelineFrames / template.fps, 0), preview: null, why: '', warnings: [], missing: [], feedback: null, assembly: saved, previewRev: PREVIEW_REV, energy: 'off', faceMatch: 'off' };
    newEditClipSound(record,defaults.clipSoundNewEdits);
    if (selected.length) await renderStoredPreview(root, cutId, record, saved);
    await saveCutFile(cutFile(root, cutId), { cutId, concept: '', skillIds: skills.filter(s => s.global).map(s => s.id), targetLengthS: record.lengthS, versions: [record], exported: [] } satisfies StoredCut);
    changed(root);
    if(selected.length)setImmediate(()=>{void import('./balance').then(m=>m.prepareHandClips(root,cutId,1)).catch(()=>{});});
    return { cutId, version: 1 };
  });
};
export const duplicateCut: Api['duplicateCut'] = async (root, cutId, version) => {
  root = path.resolve(root);
  return withShootLock(root, () => withShootLock(cutFile(root, cutId), async () => {
    const source = await readCut(root, cutId), record = source.versions.find(v => v.version === version);
    if (!record?.assembly) throw new Error('Could not find that saved version.');
    const ideas = (await sidekickThread(root)).flatMap(m => m.ideas ?? []);
    const ideaId = (source as StoredCut & { ideaId?: string }).ideaId ?? ideas.find(i => i.cutId === cutId)?.id;
    const copy = structuredClone(source) as StoredCut & { ideaId?: string };
    copy.cutId = randomUUID(); copy.exported = []; copy.ideaId = ideaId;
    copy.versions = [{ ...structuredClone(record), baseVersion: 0, version: 1, createdAt: new Date().toISOString() }];
    await saveCutFile(cutFile(root, copy.cutId), copy);
    changed(root); return { cutId: copy.cutId, version: 1 };
  }));
};
export const starCut: Api['starCut'] = async (root, cutId, starred) => {
  if (typeof starred !== 'boolean') throw new Error('Choose whether to star this edit.');
  root = path.resolve(root);
  await withShootLock(cutFile(root, cutId), async () => {
    const cut = await readCut(root, cutId); cut.starred = starred;
    await saveCutFile(cutFile(root, cutId), cut); changed(root);
  });
};
export async function insertClip(root: string, cutId: string, version: number, edit: Extract<CutEdit, { kind: 'insert' }>) {
  return withShootLock(cutFile(root, cutId), () => runActivity({ kind: 'edit', root, target: { cutId, version }, label: 'Adding to edit', cancelable: true }, async activity => {
    const cut = await readCut(root, cutId), previous = cut.versions.find(v => v.version === version);
    if (!previous?.assembly) throw new Error('Could not find that saved version.');
    const fresh = await freshen(root, previous.assembly), groups = cutPieceGroups(fresh.cutList).map(g => g.items);
    if (!Number.isInteger(edit.at) || edit.at < 0 || edit.at > groups.length) throw new Error('Choose an insertion point inside this edit.');
    const selected = sourceItems(fresh.shoot, fresh.template, edit.source);
    const ids = fresh.reel.cuts.map(c => c.id); ids.splice(edit.at, 0, selected.id); groups.splice(edit.at, 0, selected.items);
    const saved = assembly(fresh.shoot, fresh.template, groups, ids, fresh.reel);
    const layoutMedia = (fresh as import('./layout-media').LayoutAssembly).layoutMedia;
    if (layoutMedia) Object.assign(saved,{layoutMedia});
    saved.reel.broll = saved.reel.broll.map(o => ({ ...o, voiceIndex: o.voiceIndex >= edit.at ? o.voiceIndex + 1 : o.voiceIndex }));
    const record: StoredVersion = { ...structuredClone(previous), version: Math.max(...cut.versions.map(v => v.version)) + 1, createdAt: new Date().toISOString(), preview: null, finished: null, feedback: 'Added a clip', assembly: saved, voice: ids, previewRev: 0 };
    if (record.bleeps) record.bleeps = record.bleeps.map(b => ({ ...b, piece: b.piece >= edit.at ? b.piece + 1 : b.piece }));
    if (record.pieceFx) record.pieceFx.splice(edit.at, 0, null);
    if (record.layouts) record.layouts = [...record.layouts.slice(0,edit.at),null,...record.layouts.slice(edit.at)];
    if (record.jumpScales) record.jumpScales.splice(edit.at, 0, null);
    if (record.joins) {
      const joins = Array.from({ length: Math.max(0, groups.length - 2) }, (_, i) => previous.joins?.[i] ?? null);
      if (edit.at === 0) joins.unshift(null);
      else if (edit.at === groups.length - 1) joins.push(null);
      else joins.splice(edit.at - 1, 1, null, null);
      record.joins = joins;
    }
    if (record.grade?.matchRef != null && record.grade.matchRef >= edit.at) record.grade.matchRef++;
    for (const format of record.formats ?? []) if (format.pieceFraming) format.pieceFraming.splice(edit.at, 0, null);
    const fx = planFx(saved.cutList, saved.template.fps, record), oldFx = planFx(fresh.cutList, fresh.template.fps, previous);
    const time = (t: number) => remapFxTime(t, fresh.cutList, fresh.template.fps, oldFx, { ...fx, items: fx.items.filter(item => item.piece !== edit.at) });
    record.lowerThirds = record.lowerThirds?.map(o => ({ ...o, s: time(o.s), e: time(o.e) }));
    record.overlays = record.overlays?.map(o => ({ ...o, s: time(o.s), e: time(o.e) }));
    if (record.bigLines?.length || (record.titles as import("./titles/captions").CaptionTrack | undefined)?.kinetic) retimeKinetic(record, time);
    if (record.titles) record.titles.cues = record.titles.cues.map(c => ({ ...c, s: time(c.s), e: time(c.e), words: c.words?.map(w => ({ ...w, s: time(w.s), e: time(w.e) })) }));
    const captions = record.titles as import('./titles/captions').CaptionTrack | null | undefined;
    if (captions?.captionSource) captions.captionSource = { ...captions.captionSource, words: captions.captionSource.words.map(w => ({ ...w, s: time(w.s), e: time(w.e) })), faces: captions.captionSource.faces.map(f => ({ ...f, s: time(f.s), e: time(f.e) })) };
    if (record.cover) record.cover.t = time(record.cover.t);
    for (const format of record.formats ?? []) if (format.cover) format.cover.t = time(format.cover.t);
    record.pieces = resolveReelPieces(saved.shoot, saved.template, saved.cutList, saved.reel).map((piece, index) => {
      const oldIndex = index < edit.at ? index : index - 1;
      return index === edit.at ? piece : { ...previous.pieces?.[oldIndex] ?? piece, timelineS: piece.timelineS, overlay: piece.overlay };
    });
    syncFxMetadata(record, fx);
    if (saved.reel.music) {
      saved.reel.voiceLUFS = await runActivity({ kind: "render", root, target: { cutId, version: record.version }, label: "Measuring edit voice", cancelable: true }, task => measureReelVoice(root, saved.cutList.filter(c => c.seg?.lineIndex !== null), saved.template, task.signal), { renderLane: "finished" });
      if (saved.reel.voiceLUFS !== null) saved.reel.music.gainDb = Math.round((saved.reel.voiceLUFS - 15 - saved.reel.music.musicLUFS) * 100) / 100;
      if (record.music) record.music.gainDb = saved.reel.music.gainDb;
    }
    await renderStoredPreview(root, cutId, record, saved);
    record.baseVersion = version;
    cut.versions.push(record); await saveCutFile(cutFile(root, cutId), cut, activity.signal);
    changed(root);
    setImmediate(()=>{void import('./balance').then(m=>m.prepareHandClips(root,cutId,record.version)).catch(()=>{});});
    return { cutId, version: record.version };
  }));
}

/** Replace picture in one slot, preserving its finishing controls and attachments. */
export async function replaceClip(root: string, cutId: string, version: number, edit: Extract<CutEdit, { kind: 'replace' }>) {
  const { finishStoredVersion } = await import('./sidekick');
  const { replacementSpan } = await import('../renderer/src/components/replaceModel');
  const { retimeMagneticItems } = await import('./edits-move');
  const { magneticTime } = await import('../shared/magnetic');
  return runActivity({ kind: 'edit', root, target: { cutId, version }, label: 'Replacing shot', cancelable: true }, () =>
    finishStoredVersion(root, cutId, version, true, async (record, fresh) => {
      Object.assign(record,structuredClone(record));
      const previous = structuredClone(record), groups = cutPieceGroups(fresh.cutList).map(g=>g.items);
      if (!Number.isInteger(edit.piece) || edit.piece<0 || edit.piece>=groups.length || record.pieces?.[edit.piece]?.kind!=='broll') throw new Error('Choose a b-roll shot to replace.');
      const clip = fresh.shoot.clips.find(c=>c.id===edit.clipId);
      if (clip?.leftOut || !clip?.meta) throw new Error('Choose a clip from this shoot.');
      const speed = record.pieceFx?.[edit.piece]?.speed ?? 1;
      const span = replacementSpan(clip,record.pieces[edit.piece].lengthS*speed,edit);
      // Replacing is picture-only, even when the chosen source contains speech.
      const items = buildCutList(fresh.shoot,'reel',fresh.template,[{clip,...span,lineIndex:null,marker:clip.judgement?.summary || (clip.photo ? 'Photo' : '')}]);
      groups[edit.piece] = items.flatMap(item=>{
        const fps=item.clipFpsR.num/item.clipFpsR.den;
        const s=Math.max(Math.ceil(span.s*fps-1e-9),item.inFrames),e=Math.min(Math.floor(span.e*fps+1e-9),item.outFrames);
        return e>s ? [{...item,inFrames:s,outFrames:e,durTimelineFrames:(e-s)/fps*fresh.template.fps}] : [];
      });
      if (!groups[edit.piece].length) throw new Error('That moment has no playable frames.');
      const saved = {...fresh,...assembly(fresh.shoot,fresh.template,groups,fresh.reel.cuts.map(c=>c.id),fresh.reel)};
      record.assembly = saved;
      record.pieces = resolveReelPieces(saved.shoot,saved.template,saved.cutList,saved.reel).map((piece,index)=>index===edit.piece ? piece : {...previous.pieces?.[index] ?? piece,timelineS:piece.timelineS,lengthS:piece.lengthS,overlay:piece.overlay});
      const before = planFx(fresh.cutList,fresh.template.fps,previous), after = planFx(saved.cutList,saved.template.fps,record);
      syncFxMetadata(record,after);
      const spans = (plan: typeof before) => groups.map((_,piece)=>{const items=plan.items.filter(i=>i.piece===piece);return {piece,startS:items[0].startS,endS:items.at(-1)!.endS};});
      const time = magneticTime(spans(before),spans(after));
      retimeMagneticItems(previous,record,time);
      if ((previous.titles as import('./titles/captions').CaptionTrack | undefined)?.kinetic) {
        record.bigLines=previous.bigLines;
        retimeKinetic(record,time.point);
      }
      const captions = record.titles as import('./titles/captions').CaptionTrack | undefined;
      if (captions?.captionSource) captions.captionSource = {...captions.captionSource,words:captions.captionSource.words.map(time.range),faces:captions.captionSource.faces.map(time.range)};
      record.feedback = 'Replace shot';
      await renderStoredPreview(root,cutId,record,saved);
      return {cutId,version:record.version};
    }));
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** All mutation paths are managed directories, never redirected into originals. */
async function cutDirectories(root: string) {
  const directories = [path.join(root, '.sidething'), path.join(root, '.sidething/sidekick'), path.join(root, '.sidething/sidekick/cuts'), path.join(root, '.sidething/trash')];
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The edit cache must stay inside this shoot.');
  }
  return directories[3];
}
async function regularEdit(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Choose an edit stored inside this shoot.');
}
/** Only our dated trash entries expire. Unknown files are always left alone. */
export async function purgeDeletedCuts(root: string, now = Date.now()) {
  root = path.resolve(root);
  const trash = await cutDirectories(root);
  for (const id of await fs.readdir(trash)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
    await withShootLock(cutFile(root, id), async () => {
      const directory = path.join(trash, id);
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        const receipt = path.join(directory, 'deleted.json'), file = path.join(directory, 'edit.json');
        await regularEdit(receipt); await regularEdit(file);
        const saved = JSON.parse(await fs.readFile(receipt, 'utf8'));
        if (saved.cutId !== id || !Number.isFinite(saved.deletedAt) || now - saved.deletedAt < TRASH_RETENTION_MS) return;
        // Never recursively remove a folder containing anything we do not own.
        if ((await fs.readdir(directory)).some(name => name !== 'edit.json' && name !== 'deleted.json')) return;
        await fs.unlink(file); await fs.unlink(receipt); await fs.rmdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not purge deleted edit:', error);
      }
    });
  }
}
export const deleteCut: Api['deleteCut'] = async (root, cutId) => {
  root = path.resolve(root);
  const file = cutFile(root, cutId); // Validate before constructing any trash path.
  await withShootLock(root, () => withShootLock(file, async () => {
    const trash = await cutDirectories(root), directory = path.join(trash, cutId);
    await regularEdit(file);
    // ARCH2: an edit kept as a log goes to the trash folded back into one file (checked), so restore, purge and junk
    // review read it as they always have; restoring it brings back a one-file edit, which moves to a log when opened.
    const head = await readLogHead(file), folded = head ? await readCutDocument(file) : null;
    await fs.mkdir(directory); // Existing recoverable edits must never be overwritten.
    try {
      await fs.writeFile(path.join(directory, 'deleted.json'), JSON.stringify({ cutId, deletedAt: Date.now() }), { flag: 'wx' });
      if (folded) {
        const temp = path.join(directory, `edit.json.${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temp, JSON.stringify(folded) + '\n', { flag: 'wx' });
          if (!isDeepStrictEqual(JSON.parse(await fs.readFile(temp, 'utf8')), folded)) throw new Error('Could not move this edit to the trash safely. Try again.');
          await fs.rename(temp, path.join(directory, 'edit.json'));
        } finally { await fs.unlink(temp).catch(() => {}); }
        await fs.unlink(file);
      } else await fs.rename(file, path.join(directory, 'edit.json'));
    } catch (error) {
      if (!folded || await fs.access(file).then(() => true, () => false)) {
        await fs.unlink(path.join(directory, 'edit.json')).catch(() => {});
        await fs.unlink(path.join(directory, 'deleted.json')).catch(() => {});
        await fs.rmdir(directory).catch(() => {});
      }
      throw error;
    }
    // The trash holds the whole edit now; the log's files and the pre-ARCH2 copy go with the head.
    if (head) for (const extra of [logPaths(file, head.versionLog).log, logPaths(file, head.versionLog).cache, `${file}.pre-arch2`])
      await fs.unlink(extra).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') console.warn('[edit history] could not remove', path.basename(extra), error.message); });
    changed(root);
  }));
  await purgeDeletedCuts(root);
};
export const restoreCut: Api['restoreCut'] = async (root, cutId) => {
  root = path.resolve(root);
  const file = cutFile(root, cutId);
  await withShootLock(root, () => withShootLock(file, async () => {
    const trash = await cutDirectories(root), directory = path.join(trash, cutId);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose an edit from this shoot\'s trash.');
    const saved = path.join(directory, 'edit.json'), receipt = path.join(directory, 'deleted.json');
    await regularEdit(saved); await regularEdit(receipt);
    const deleted = JSON.parse(await fs.readFile(receipt, 'utf8'));
    if (deleted.cutId !== cutId || !Number.isFinite(deleted.deletedAt)) throw new Error('The deleted edit receipt is invalid.');
    // Hard linking is an atomic no-replace move on the same volume. A recreated
    // edit at this id is preserved, including when it appears during the restore.
    await fs.link(saved, file);
    await fs.unlink(saved); await fs.unlink(receipt); await fs.rmdir(directory);
    changed(root);
  }));
};
