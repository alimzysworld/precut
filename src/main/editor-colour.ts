import { balancedLook } from "../shared/clip-balance";
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { EditorInput, Editor } from './editors';
import { editorPieceLuts, gradeForLook, gradeForPiece, exposureSpans } from './grade';
import { getPreferences } from './settings';
import { angleFxPiece } from './angles';
import { editorPlan } from './editor-timeline';
import { resource } from './titles/mattes';

export async function writeEditorColour(i: EditorInput, folder: string, editor: Editor) {
  const version=i.finishing ?? i.opts?.finishing ?? {}, cuts=i.selects?.cuts ?? i.cutList;
  const grade=version.grade ?? gradeForLook('unknown',(await getPreferences()).look);
  const cache=path.join(i.root,'.sidething','finish-cache'), directory=path.join(folder,'LUTs');
  await fs.mkdir(directory,{recursive:true});
  const entries=[],plan=editorPlan(cuts,i.template.fps,version);
  for(const [n,p] of (i.pictures ?? []).entries()) {
    if(p.still)continue;
    const piece=p.piece ?? cuts[p.owner]?.piece ?? p.owner;
    const original=p.colourClip ?? i.shoot.clips.find(c=>c.id===p.clip.id);
    if(!original)continue; // generated alpha/backgrounds inherit colour from their picture below
    const setting=version.angleCuts?.length ? angleFxPiece({assembly:{cutList:cuts} as import('./sidekick').StoredVersion['assembly'],pieceFx:version.pieceFx},original.id,piece) : piece;
    const keys=p.colourKeys ?? p.keys;
    const s=Math.min(...keys.map(k=>k.s)),e=Math.max(...keys.map(k=>k.s))+(keys[0].s>keys.at(-1)!.s ? 1/original.meta!.fps : 0);
    const recipe=await editorPieceLuts(original,gradeForPiece(grade,balancedLook(version,original.id,setting)),cache,{root:i.root,s,e,neighbours:exposureSpans(cuts,i.opts?.reel?.broll ?? [],i.template.fps)});
    const prefix=`${String(n+1).padStart(3,'0')}-piece-${piece+1}`,lut=`LUTs/${prefix}.cube`;
    await fs.writeFile(path.join(folder,lut),recipe.composed);
    const stages=[];
    for(const [index,source] of recipe.stages.entries()) {
      const file=`LUTs/${prefix}-stage-${index+1}.cube`,bytes=await fs.readFile(source);
      await fs.writeFile(path.join(folder,file),bytes);
      stages.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),source});
    }
    entries.push({name:p.name,parentName:cuts[p.owner]?.seg?.marker ?? null,localStartFrame:Math.round(p.s*i.template.fps)-Math.round((plan.items[p.owner]?.startS ?? 0)*i.template.fps),source:original.file,startFrame:Math.round(p.s*i.template.fps),endFrame:Math.round((p.s+p.d)*i.template.fps),lut,stages});
  }
  await fs.writeFile(path.join(folder,'LUTs','clips.json'),JSON.stringify({fps:i.template.fps,entries},null,2)+'\n');
  const notes=['Colour LUTs are in LUTs/clips.json. The numbered stage files are byte-identical to precut\'s camera conversion, measured balance and per-piece look tables; apply them in that order. Each piece also has one composed LUT for editors with a single slot (33-point resampling).'];
  if(editor==='resolve') {
    await fs.copyFile(await resource('resources/resolve-apply.py'),path.join(folder,'resolve-apply.py'));
    notes.push('Resolve Studio scripting is required: open the imported timeline, then run resolve-apply.py from the scripting console. Add the package LUTs folder to Resolve custom LUT locations and refresh LUTs first. The script applies each matching clip LUT and attempts to import Subtitles.srt; it reports unmatched compounds and unsupported subtitle import instead of silently skipping them.');
  } else notes.push('FCPXML and xmeml have no portable LUT reference: select all > apply LUT, using the per-piece assignments in LUTs/clips.json.');
  if(grade.grain || grade.detail!==null || grade.vignette)notes.push('Grain, detail and vignette remain in the finished MP4.');
  return notes;
}
