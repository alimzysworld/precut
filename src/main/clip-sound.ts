import { clipLaneDb } from '../shared/lane-levels';
import { bleepTimes } from './titles/ul1';
import type { CutVersion } from '../shared/schema';
import type { CutItem } from './export';
import type { ReelAssembly } from './reel';
import type { FxItem, FxPlan } from './edits-fx';

/** Attached pictures keep a separate sound choice on their owner. Their source
 * and output spans follow the same clamped overlay placement as the picture. */
export function attachedClipSounds(overlays: ReelAssembly['broll'], plan: FxPlan, version: Pick<CutVersion,'pieceFx'|'clipSoundMuted'|'layouts'|'laneLevels'|'clipSoundDefaultOn'>, fps: number): {cut:CutItem;item:FxItem}[] {
  return (overlays ?? []).flatMap(overlay=>{
    const owner=plan.items.filter(p=>p.piece===overlay.voiceIndex), first=owner[0], last=owner.at(-1);
    if (!first || !last || version.layouts?.[overlay.voiceIndex] && !['face','placeholder'].includes(version.layouts[overlay.voiceIndex]!.kind)) return [];
    const rate=overlay.seg.clip.meta?.fps || fps, s=Math.ceil(overlay.seg.s*rate)/rate;
    const d=Math.min(Math.floor(overlay.seg.e*rate)/rate-s,last.endS-first.startS,owner.reduce((n,p)=>n+p.timeMap.at(-1)!.s-p.timeMap[0].s,0));
    if (!(d>0)) return [];
    const fx=version.pieceFx?.[overlay.voiceIndex]?.overlaySound;
    return [{cut:{piece:overlay.voiceIndex,seg:overlay.seg,inFrames:s*rate,outFrames:(s+d)*rate,clipFpsR:{num:rate,den:1},durTimelineFrames:d*fps,offsetFrames:first.startS*fps},item:{piece:overlay.voiceIndex,startS:first.startS,endS:first.startS+d,timeMap:[{t:first.startS,s},{t:first.startS+d,s:s+d}],overlap:0,gainDb:clipLaneDb(version,fx?.gainDb ?? 0),muted:!!version.clipSoundMuted || (fx?.muted ?? !version.clipSoundDefaultOn),soundEnabled:fx?.muted===false || !!version.clipSoundDefaultOn}}];
  });
}

/** Captions keep their redaction, while muted source audio contributes no beep. */
export function audibleClipBleeps(version:Parameters<typeof bleepTimes>[0], cuts:CutItem[], fps:number, plan:FxPlan) {
  return bleepTimes({...version,bleeps:version.bleeps?.filter(b=>plan.items.some(p=>p.piece===b.piece && !p.muted && !p.reverse))},cuts,fps);
}

