import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { checkoutFile } from './bundle-paths';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { AngleGroup, CutVersion, DraftPiece, Shoot } from '../shared/schema';
import type { StoredVersion } from './sidekick';
import { runActivity } from './activity';
import { tool, toolEnvironment } from './tools';
import { mediaUrl } from '../shared/media';
import { layoutSourceTime } from './layout-math';
import { isScreenClip } from '../shared/screen';
import { framingPlans, framingReference } from './framing';
import { cutFraming, framingRectAt } from './preview';
import type { MotionAnalysis } from './motion';

const inflight = new Map<string, Promise<AngleGroup[]>>();
async function angleFingerprint(root: string, shoot: Shoot) {
  const stamp = async (file: string) => fs.stat(path.resolve(root, file)).then(s => [s.size, s.mtimeMs, s.ctimeMs], error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  const clips = await Promise.all(shoot.clips.map(async c => [c.id, c.file, !!c.proxy, !!c.photo, c.stage === 'error',
    c.meta && [c.meta.durationS, c.meta.audioChannels, c.meta.createdAt], c.sound,
    isScreenClip(c),
    await stamp(c.file), c.sound?.file && await stamp(c.sound.file)]));
  return createHash('sha256').update('V4-waveforms').update(JSON.stringify(clips.sort((a,b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex');
}
export function measureAngles(root: string): Promise<AngleGroup[]> {
  root = path.resolve(root);
  const existing = inflight.get(root); if (existing) return existing;
  // Cache lookup is IO only, outside the serial media lane. Even a long export
  // cannot delay an unchanged shoot's groups.
  const job = (async () => {
    const index = path.join(root, '.sidething/index.json');
    const shoot = JSON.parse(await fs.readFile(index, 'utf8')) as Shoot & { _anglesCache?: string };
    const key = await angleFingerprint(root, shoot);
    if (shoot._anglesCache === key && shoot.angles) return shoot.angles;
    return runActivity({ kind: 'render', root, target: null, label: 'Lining up camera angles', cancelable: true }, async activity => {
      let angles: AngleGroup[] = [];
      if (shoot.clips.filter(c => !c.photo && c.meta && c.proxy && c.stage !== 'error').length > 1) {
        const script = [process.resourcesPath && path.join(process.resourcesPath, 'pipeline/angles.py'), checkoutFile('pipeline/angles.py'), path.resolve('pipeline/angles.py')].find(p => p && existsSync(p));
        if (!script) throw new Error('The camera sync helper is missing.');
        const { stdout } = await promisify(execFile)(tool('python3'), ['-I', script, root], { signal: activity.signal, env: toolEnvironment(), maxBuffer: 4 * 1024 * 1024 });
        angles = JSON.parse(stdout);
      }
      activity.signal.throwIfAborted();
      // Share the index writer's lock so background measurements cannot replace
      // processing updates that arrive while the helper is running.
      const { withShootLock } = await import('./sidekick');
      await withShootLock(root, async () => {
        const current = JSON.parse(await fs.readFile(index, 'utf8'));
        if (await angleFingerprint(root, current) !== key) throw new Error('The footage changed while lining up angles. Try again.');
        activity.signal.throwIfAborted();
        const temporary = `${index}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, JSON.stringify({ ...current, angles, _anglesCache: key })); await fs.rename(temporary, index); }
        finally { await fs.rm(temporary, { force: true }); }
      });
      (await import('./steps')).stepsChanged(root);
      return angles;
    }, { renderLane: 'background' });
  })();
  inflight.set(root, job); void job.finally(() => inflight.delete(root)).catch(() => {}); return job;
}

export type AngleCuts = NonNullable<CutVersion['angleCuts']>;
export const anglesReadme = 'Multicam switches appear in the finished MP4. The cuts-only editor timeline keeps the original picture and continuous voice. Reapply switches from angles.json; atS is reel seconds and clipId names the synced source. The finished MP4 is the visual reference.';

/** Split only picture; preserve the voice assembly, including its recorder. */
export function anglePictures(pictures: DraftPiece[], record: Pick<StoredVersion,'assembly'|'angleCuts'|'framing'|'pieceFx'|'energy'>, motions = new Map<string,MotionAnalysis>(), referenceOut?:{w:number;h:number}): DraftPiece[] {
  if (!record.angleCuts?.length) return pictures;
  const {shoot,template} = record.assembly;
  return pictures.flatMap(p => {
    if (p.layer !== 0 || !p.clipId) return [p];
    const group = shoot.angles?.find(g => g.clips.some(c => c.clipId === p.clipId));
    if (!group) return [p];
    const base = group.clips.find(c => c.clipId === p.clipId)!;
    const keys = p.timeMap ?? [{t:p.startS,s:p.inS},{t:p.endS,s:p.inS+p.endS-p.startS}];
    const coverage = group.clips.flatMap(entry => {
      const clip = shoot.clips.find(c => c.id===entry.clipId);
      if (!clip?.meta) return [];
      return [entry.offsetS-base.offsetS,entry.offsetS-base.offsetS+clip.meta.durationS].flatMap((edge,edgeIndex) => keys.slice(1).flatMap((b,i) => {
        const a=keys[i];
        if (edge<=Math.min(a.s,b.s) || edge>=Math.max(a.s,b.s)) return [];
        const frame=(a.t+(edge-a.s)*(b.t-a.t)/(b.s-a.s))*template.fps;
        return [(edgeIndex===0 ? Math.ceil(frame-1e-7) : Math.floor(frame+1e-7))/template.fps];
      }));
    });
    const boundaries = [...new Set([p.startS,...record.angleCuts!.filter(c => c.atS > p.startS && c.atS < p.endS).map(c => c.atS),...coverage.filter(t => t>p.startS && t<p.endS),p.endS])].sort((a,b)=>a-b);
    return boundaries.slice(0,-1).flatMap((startS,i) => {
      const endS = boundaries[i+1], chosen = record.angleCuts!.filter(c => c.atS <= startS+1e-7).at(-1);
      const entry = group.clips.find(c => c.clipId === chosen?.clipId);
      const clip = shoot.clips.find(c => c.id === entry?.clipId);
      const delta = entry ? base.offsetS-entry.offsetS : 0;
      const inS = layoutSourceTime(p,startS)+delta, outS = layoutSourceTime(p,endS)+delta;
      // A camera ending early restores the base picture instead of freezing.
      if (!clip?.meta || !clip.proxy || Math.min(inS,outS)<-1e-6 || Math.max(inS,outS)>clip.meta.durationS+1e-6) return [slice(p,startS,endS,0)];
      const result = {...slice(p,startS,endS,delta),clipId:clip.id,proxy:mediaUrl(shoot.root,'proxies',clip.proxy)};
      if (clip.id !== p.clipId) {
        const sourcePiece=angleFxPiece(record,clip.id,p.piece ?? 0), reference=referenceOut ?? framingReference(template);
        const fps=clip.meta.fps, length=Math.abs(outS-inS);
        const cut={...record.assembly.cutList.find(c => c.seg?.clip.id===p.clipId)!,seg:{clip,s:Math.min(inS,outS),e:Math.max(inS,outS),lineIndex:null,marker:clip.id},piece:sourcePiece,inFrames:Math.min(inS,outS)*fps,outFrames:Math.max(inS,outS)*fps,clipFpsR:{num:fps,den:1},durTimelineFrames:length*template.fps,offsetFrames:0};
        const plan=framingPlans({plan:cutFraming,at:framingRectAt},[cut],template.fps,reference,record.energy ?? 'subtle','off',record,motions,reference)[0];
        result.frame=plan?.crop ? Array.from({length:Math.ceil((endS-startS)*template.fps)+1},(_,n) => {
          const t=Math.min(endS,startS+n/template.fps),sourceT=layoutSourceTime(result,t)-Math.min(inS,outS),r=framingRectAt(plan,sourceT)!;
          return {t,x:r.x/clip.meta!.width,y:r.y/clip.meta!.height,w:r.w/clip.meta!.width,h:r.h/clip.meta!.height};
        }) : null;
      }
      return [result];
    });
  });
}
function slice(p: DraftPiece,startS: number,endS: number,delta:number): DraftPiece {
  const inS = layoutSourceTime(p,startS)+delta;
  return {...p,startS,endS,inS,timeMap:[{t:startS,s:inS},...(p.timeMap ?? []).filter(k => k.t>startS && k.t<endS).map(k => ({t:k.t,s:k.s+delta})),{t:endS,s:layoutSourceTime(p,endS)+delta}],frame:p.frame ? [{...p.frame.reduce((a,k) => k.t<=startS?k:a),t:startS},...p.frame.filter(k => k.t>startS && k.t<endS),{...p.frame.reduce((a,k) => k.t<=endS?k:a),t:endS}] : null};
}
export function validateAngles(cuts: AngleCuts, record: StoredVersion): AngleCuts {
  if (!Array.isArray(cuts) || cuts.length>2000) throw new Error('Choose a list of camera switches.');
  const fps = record.assembly.template.fps;
  const duration = planFx(record.assembly.cutList,fps,record).durationS;
  const result = cuts.map(c => ({atS:Math.round(c.atS*fps)/fps,clipId:c.clipId})).sort((a,b) => a.atS-b.atS);
  for (const [i,c] of result.entries()) {
    if (!Number.isFinite(c.atS) || c.atS<0 || c.atS>=duration || typeof c.clipId !== 'string' || (i>0 && result[i-1].atS===c.atS)) throw new Error('Camera switches need distinct reel times inside the edit.');
    const pictures = (record.assembly.cutList);
    const fx = planFx(pictures,fps,record);
    const span = fx.items.find(p => c.atS>=p.startS && c.atS<p.endS), base = span && pictures[fx.items.indexOf(span)].seg?.clip;
    const group = record.assembly.shoot.angles?.find(g => g.clips.some(a => a.clipId===base?.id) && g.clips.some(a => a.clipId===c.clipId));
    const clip = record.assembly.shoot.clips.find(p => p.id===c.clipId);
    if (!group || !clip?.meta || !clip.proxy || !span || !base) throw new Error('Choose a synced angle available at this moment.');
    const source = mapSource(span.timeMap,c.atS) + group.clips.find(a => a.clipId===base.id)!.offsetS-group.clips.find(a => a.clipId===c.clipId)!.offsetS;
    if (source<0 || source>=clip.meta.durationS) throw new Error('That angle does not cover this moment.');
  }
  return result;
}
import { mapSource, mapTime, planFx } from './edits-fx';
export function defaultAngles(record: StoredVersion): AngleCuts {
  const shoot = record.assembly.shoot, result: AngleCuts = [];
  const fx = planFx(record.assembly.cutList,record.assembly.template.fps,record);
  for (const [i,cut] of record.assembly.cutList.entries()) {
    if (!cut.seg) continue;
    const group = shoot.angles?.find(g => g.clips.some(c => c.clipId===cut.seg!.clip.id));
    if (!group) continue;
    const cameras = group.clips.filter(c => c.kind==='camera').sort((a,b) => (shoot.clips.find(c => c.id===a.clipId)?.meta?.focalLength ?? 0)-(shoot.clips.find(c => c.id===b.clipId)?.meta?.focalLength ?? 0));
    const words = cut.seg.clip.transcript?.flatMap(s => s.words ?? []) ?? [];
    const start = fx.items[i].timeMap[0].s, end = fx.items[i].timeMap.at(-1)!.s;
    const boundaries = [start,...words.filter(w => /[.!?]$/.test(w.w) && w.e>start && w.e<end).map(w => w.e)];
    for (const [n,s] of boundaries.entries()) {
      const atS = mapTime(fx.items[i].timeMap,s);
      if (result.length && atS-result.at(-1)!.atS<2) continue;
      const sentence = words.filter(w => w.s>=s && w.s<(boundaries[n+1] ?? end)).map(w => w.w).join(' ');
      const screen = group.clips.find(c => c.kind==='screen');
      const chosen = screen && /\b(screen|click|here|chart|slide|cursor|window)\b/i.test(sentence) ? screen : n>0 && /!|\b(punch|finally|secret|remember)\b/i.test(sentence) ? cameras.at(-1) : cameras[0];
      if (!chosen || result.at(-1)?.clipId===chosen.clipId) continue;
      try { const next = validateAngles([...result,{atS,clipId:chosen.clipId}],record); result.splice(0,result.length,...next); } catch { /* Angle not present for this sentence. */ }
    }
  }
  return result;
}
export async function editAngles(root:string,cutId:string,version:number,cuts:AngleCuts|null) {
  const {finishStoredVersion,renderStoredPreview} = await import('./sidekick');
  return runActivity({kind:'edit',root,target:{cutId,version},label:'Changing camera angles',cancelable:true},() => finishStoredVersion(root,cutId,version,true,async(record,assembly) => {
    record.assembly = assembly; record.angleCuts = cuts===null ? defaultAngles(record) : validateAngles(cuts,record);
    record.feedback = cuts===null ? 'Restored automatic camera angles' : 'Changed camera angles, keeping continuous sound';
    if (!assembly.reel.why.includes(anglesReadme)) assembly.reel.why += `\n\n${anglesReadme}`;
    await renderStoredPreview(root,cutId,record,assembly); return {cutId,version:record.version};
  }));
}

export async function writeAngleDelivery(folder:string,cuts:CutVersion['angleCuts'],shoot:Shoot):Promise<void> {
  if (!cuts?.length) return;
  await fs.writeFile(path.join(folder,'angles.json'),JSON.stringify({cuts,groups:shoot.angles,clips:shoot.clips.filter(c => shoot.angles?.some(g => g.clips.some(a => a.clipId===c.id))).map(c => ({clipId:c.id,file:path.resolve(shoot.root,c.file)}))},null,2));
  const file=path.join(folder,'README.txt');
  const existing=await fs.readFile(file,'utf8').catch(()=>'');
  if (!existing.includes(anglesReadme)) await fs.appendFile(file,`\n${anglesReadme}\n`);
}

/** A source already used elsewhere retains that clip's saved picture settings. */
export function angleFxPiece(record:Pick<StoredVersion,'assembly'|'pieceFx'>,clipId:string,piece:number):number {
  const base=record.assembly.cutList.find((c,i) => (c.piece ?? i)===piece)?.seg?.clip.id;
  if (base===clipId) return piece;
  const source=record.assembly.cutList.find((c,i) => c.seg?.clip.id===clipId && record.pieceFx?.[c.piece ?? i]);
  return source ? source.piece ?? record.assembly.cutList.indexOf(source) : piece;
}
