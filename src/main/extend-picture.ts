import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from './tools';
import { randomUUID } from 'node:crypto';
import type { AudioFile, CaptionsPending, OverlayItem, Shoot, VoiceoverCaptions } from '../shared/schema';
import { voiceEndS } from '../shared/picture-extent';
import { runActivity, withRenderSlot, currentActivity } from './activity';
import { finishStoredVersion, loadDraftVersion, renderStoredPreview, type StoredVersion } from './sidekick';
import { planFx, syncFxMetadata } from './edits-fx';
import type { CutItem } from './export';

export type ExtendMode = 'black' | 'hold';
const NAMES: Record<ExtendMode, { label: string; feedback: string; before: string }> = {
  black: { label: 'Extending with black', feedback: 'Extended with black to the end of the voice', before: 'Before Extend with black' },
  hold: { label: 'Holding the last shot', feedback: 'Held the last shot to the end of the voice', before: 'Before Hold last shot' },
};
const withTakes = (shoot: Shoot, takes: AudioFile[]): Shoot => ({ ...shoot, audio: [...(shoot.audio ?? []).filter(a => !takes.some(t => t.file === a.file)), ...takes] });

/** The picture's last frame as it is finished (framing, layouts, grade), with no captions, images or
 * lower thirds on it, cached as an overlay image so every renderer that shows images holds it. */
async function lastFrame(root: string, record: StoredVersion, pictureS: number): Promise<string> {
  const { template, cutList, reel } = record.assembly;
  // Only the last shot is rendered when nothing on the reel clock (timed layouts, scenes, multicam angles)
  // depends on where it sits; otherwise the whole edit, exactly.
  const reelClocked = !!record.angleCuts?.length || !!record.layouts?.some(l => l && (l.s !== undefined || l.kind === 'scene'));
  const lastPiece = cutList.at(-1)!.piece, first = cutList.findIndex(c => c.piece === lastPiece);
  const own = reelClocked || first < 0 || cutList.slice(first).some(c => c.piece !== lastPiece) ? null : cutList.slice(first);
  const startS = own ? planFx(cutList, template.fps, record).items[first].startS : 0;
  const work = async () => {
    // The finished picture of that span (framing, layouts, grade at the export's size), with no captions,
    // images, lower thirds or sound on it; its final frame becomes the held image.
    const { renderFinishingPreview } = await import('./preview');
    // VO7-11: the span alone, graded as inside the whole edit (exposure matching reads every piece).
    const video = await renderFinishingPreview(root, own ?? cutList, { name: `hold-frame-${randomUUID()}`, template, full: true, exposureCuts: cutList,
      version: { ...record, titles: null, overlays: [], lowerThirds: [], bleeps: [], sfx: [], voiceover: undefined, audio: { clean: false, denoise: 0, loudnessLUFS: -16 }, music: null }, reel: { ...reel, music: undefined } });
    const still = path.join(path.dirname(video), `${path.basename(video, '.mp4')}.png`);
    try {
      const end = Math.max(0, pictureS - startS - .5);
      // VO7-11: the render is bt709, limited range (preview.ts tags it so). Convert it to full-range RGB exactly
      // (swscale's default fast path lost about 2 levels), and write the still untagged, as plain sRGB like
      // every other image the titles layer draws, so nothing downstream reinterprets its colour.
      const exact = 'scale=in_color_matrix=bt709:in_range=tv:out_range=full:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24,setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown';
      await promisify(execFile)(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-y', '-ss', String(end), '-i', video, '-vf', exact, '-update', '1', still], { signal: currentActivity()?.signal, maxBuffer: 1 << 20 });
      return await (await import('./overlays')).copyOverlay(root, still);
    } finally { await fs.rm(video, { force: true }); await fs.rm(still, { force: true }); }
  };
  const activity = currentActivity();
  return activity ? withRenderSlot(activity, work) : work();
}

/** VO7-9: voice runs past the picture's end. Append picture to the voice's end, as black (a gap on the
 * spine, which every exporter already draws black) or with the last frame held (that gap, under the
 * finished last frame as a full-frame image). One undoable version; the state before it is kept as a
 * version. Captions follow again, so the words past the old end become captions. Voice never moves. */
export function extendToVoice(root: string, cutId: string, version: number, mode: ExtendMode): Promise<{ cutId: string; version: number; extendedS: number; lengthS: number; captions: VoiceoverCaptions; captionsPending: CaptionsPending | null }> {
  if (mode !== 'black' && mode !== 'hold') return Promise.reject(new Error('Choose Extend with black or Hold last shot.'));
  if (!/^[a-zA-Z0-9_-]+$/.test(cutId)) return Promise.reject(new Error('That edit id is invalid.'));
  const names = NAMES[mode];
  return runActivity({ kind: 'edit', root, target: { cutId, version }, label: names.label, cancelable: true }, async () => {
    const source = await loadDraftVersion(root, cutId, version);
    const { cutList: sourceCuts, template } = source.assembly;
    const sourcePicture = planFx(sourceCuts, template.fps, source).durationS;
    if (!(voiceEndS(source.voiceover?.lines) - sourcePicture > .5 / template.fps)) throw new Error('Your voice already ends inside the picture.');
    // Rendered before the edit lock is taken, from exactly this version.
    const held = mode === 'hold' ? await lastFrame(root, source, sourcePicture) : null;
    let before = version;
    const result = await finishStoredVersion(root, cutId, version, true, async (record, assembly, baseVersion) => {
      before = baseVersion;
      record.assembly = assembly;
      const fps = assembly.template.fps, cuts = assembly.cutList;
      if (!cuts.length) throw new Error('Add a shot to this edit first.');
      const picture = planFx(cuts, fps, record).durationS, end = voiceEndS(record.voiceover?.lines);
      if (!(end - picture > .5 / fps)) throw new Error('Your voice already ends inside the picture.');
      const frames = Math.ceil((end - picture) * fps - 1e-6), last = cuts.at(-1)!;
      const gap: CutItem = { piece: Math.max(...cuts.map((c, i) => c.piece ?? i)) + 1, seg: null, inFrames: 0, outFrames: 0,
        clipFpsR: last.clipFpsR, offsetFrames: Math.round(picture * fps), durTimelineFrames: frames };
      assembly.cutList = [...cuts, gap];
      syncFxMetadata(record);
      if (held) {
        const item: OverlayItem = { id: randomUUID(), file: held, s: picture, e: record.lengthS, x: .5, y: .5, w: 1, corner: 'square', enter: 'none', exit: 'none', sound: null };
        record.overlays = [...(record.overlays ?? []), item];
      }
      // VO7-11: the voice is this revision's own, exactly as it was. Without the stamp, the save retimes the
      // older voiceover sidecar through the old and new picture plans, and the gap stretched the last line
      // (seen: a piece at 0:22.5 moved to 1:01.4 and ran to 6:47).
      if (record.voiceover) record.voiceover = { ...record.voiceover, version: record.version };
      record.feedback = names.feedback;
      const { listVoiceovers } = await import('./voiceover-takes');
      const followed = await (await import('./titles')).followVoiceCaptions(root, record, withTakes(assembly.shoot, await listVoiceovers(root)), assembly.template, assembly.cutList, { onlyExisting: true });
      await renderStoredPreview(root, cutId, record, assembly);
      return { cutId, version: record.version, extendedS: frames / fps, lengthS: record.lengthS, ...followed };
    });
    await (await import('./revisions')).markMilestone(root, cutId, before, { kind: 'before-auto', name: names.before }).catch(error => console.warn('[revisions]', error));
    // The voiceover sidecar follows the new revision, so later saves retime from it, not from the picture before.
    await (await import('./voiceover-script')).syncVoiceoverSidecar(root, cutId, { voice: true }).catch(error => console.warn('[voiceover]', error));
    return result;
  });
}
