import type { CutEdit, Segment } from '../shared/schema';
import { alignCaptionTrack, updateCaptionWord } from '../shared/caption-words';
import { finishStoredVersion, PREVIEW_REV, savePlaybackChange } from './sidekick';
import { runActivity, withRenderSlot } from './activity';

export function editCaption(root: string, cutId: string, version: number, edit: Extract<CutEdit, { kind: 'captionWord' | 'retimeCaptions' }>) {
  return savePlaybackChange(root, cutId, version, base =>
    runActivity({ kind: 'edit', root, target: { cutId, version: base }, label: edit.kind === 'captionWord' ? 'Updating caption word' : 'Re-timing words', cancelable: true }, activity =>
      finishStoredVersion(root, cutId, base, true, async (record, assembly, baseVersion) => {
        record.assembly = assembly;
        if (edit.kind === 'captionWord') record.titles = updateCaptionWord(record.titles, edit, record.lengthS);
        else {
          if (record.captionLanguage) throw Error('Re-time the spoken captions before translating them.');
          const { buildTitlesInput } = await import('./titles');
          const shoot = structuredClone(assembly.shoot);
          await withRenderSlot(activity, async () => {
            const { spawn } = await import('node:child_process');
            const { pipelineFile, venvPython } = await import('./jobs');
            const { toolEnvironment } = await import('./tools');
            const ids = new Set(record.pieces?.filter(p => p.kind === 'voice').map(p => p.clipId));
            for (const clip of shoot.clips.filter(c => ids.has(c.id))) {
              activity.signal.throwIfAborted();
              clip.transcript = await new Promise<Segment[]>((resolve, reject) => {
                const child = spawn(venvPython(), ['-I', pipelineFile('process.py'), root, '--transcribe-audio', clip.file], { env: toolEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], signal: activity.signal });
                let output = '';
                child.stdout.on('data', chunk => { output += chunk; });
                child.stderr.resume();
                child.once('error', reject);
                child.once('close', code => {
                  if (code !== 0) { reject(Error('Could not re-time words. Your captions are unchanged.')); return; }
                  try { resolve(JSON.parse(output.trim().split('\n').at(-1)!).transcript); } catch (error) { reject(error); }
                });
              });
            }
          }, 'background');
          // Discard cut-local transcript caches only in this disposable input.
          const cuts = assembly.cutList.map(c => ({ ...c, seg: c.seg ? { ...c.seg, speechWords: undefined } : c.seg }));
          const measured = buildTitlesInput(shoot, record, assembly.template, cuts, 'none', assembly.template.height, false).words;
          record.titles = alignCaptionTrack(record.titles!, measured);
        }
        activity.signal.throwIfAborted();
        record.feedback = edit.kind === 'captionWord' ? 'Changed caption word' : 'Re-timed caption words';
        record.previewRev = PREVIEW_REV;
        return { cutId, version: record.version, baseVersion };
      }, true)));
}
