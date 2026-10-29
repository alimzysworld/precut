import { randomUUID } from 'node:crypto';
import type { CutEdit, LowerThird } from '../shared/schema';
import { cutPieceGroups, sourceWords } from './export';
import { finishStoredVersion, renderStoredPreview } from './sidekick';
import { runActivity } from './activity';
import { buildTitlesInput, captionSourceForInput } from './titles';
import { getPreferences } from './settings';

export function validateLowerThird(item: LowerThird, duration: number): LowerThird {
  if (![item.s, item.e].every(Number.isFinite) || item.s < 0 || item.e <= item.s || item.e > duration + 1e-6) throw new Error('Keep the lower third inside this edit.');
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160 || item.subtitle !== undefined && (typeof item.subtitle !== 'string' || item.subtitle.length > 240) || !['left', 'right', 'centre'].includes(item.position)) throw new Error('Give the lower third a title, optional subtitle and a side.');
  return { ...item, title: item.title.trim().replace(/\s+/g, ' '), subtitle: item.subtitle?.trim().replace(/\s+/g, ' ') };
}
export function editUl1(root: string, cutId: string, version: number, edit: Extract<CutEdit, { kind: 'bleep' | 'lowerThird' }>) {
  return runActivity({ kind: 'edit', root, target: { cutId, version }, label: edit.kind === 'bleep' ? 'Updating bleeps' : 'Updating lower third', cancelable: true }, activity =>
    finishStoredVersion(root, cutId, version, true, async (record, assembly) => {
      record.assembly = assembly;
      if (edit.kind === 'bleep') {
        if (!Array.isArray(edit.spans) || !edit.spans.length || !['beep', 'mute', null].includes(edit.sound)) throw new Error('Select words and choose Bleep, Mute or Remove bleep.');
        let bleeps = [...record.bleeps ?? []];
        const groups = cutPieceGroups(assembly.cutList);
        for (const span of edit.spans) {
          const group = groups[span.piece];
          if (!Number.isInteger(span.piece) || !group || !Number.isFinite(span.s) || !Number.isFinite(span.e) || span.e <= span.s) throw new Error('Select spoken words in this edit.');
          const words = group.items.flatMap(item => item.seg?.lineIndex !== null && item.seg ? sourceWords(assembly.shoot, item.seg).filter(w => w.s >= item.inFrames / (item.clipFpsR.num / item.clipFpsR.den) - 1e-6 && w.e <= item.outFrames / (item.clipFpsR.num / item.clipFpsR.den) + 1e-6) : []);
          const selected = words.filter(w => w.s < span.e && w.e > span.s);
          if (!selected.length) throw new Error('This selection has no kept measured words.');
          let s = Math.min(...selected.map(w => w.s)), e = Math.max(...selected.map(w => w.e));
          for (;;) {
            const overlap = words.filter(w => w.s < e && w.e > s), low = Math.min(...overlap.map(w => w.s)), high = Math.max(...overlap.map(w => w.e));
            if (s === low && e === high) break; s = low; e = high;
          }
          // Replace only the chosen interval, preserving the rest of a prior run.
          bleeps = bleeps.flatMap(b => b.piece !== span.piece || b.s >= e || b.e <= s ? [b] : [{ ...b, e: s }, { ...b, s: e }].filter(b => b.e > b.s));
          if (edit.sound) bleeps.push({ piece: span.piece, s, e, sound: edit.sound });
        }
        record.bleeps = bleeps.sort((a,b) => a.piece-b.piece || a.s-b.s);
        record.feedback = edit.sound === null ? 'Removed bleep' : edit.sound === 'mute' ? 'Muted selected words' : 'Bleeped selected words';
      } else {
        const items = [...record.lowerThirds ?? []];
        if (edit.op === 'add') items.push(validateLowerThird({ ...edit.item, id: randomUUID() }, record.lengthS));
        else {
          const index = items.findIndex(i => i.id === edit.id);
          if (index < 0) throw new Error('That lower third is no longer in this edit.');
          if (edit.op === 'remove') items.splice(index, 1);
          else items[index] = validateLowerThird({ ...items[index], ...edit.patch, id: edit.id }, record.lengthS);
        }
        record.lowerThirds = items;
        record.feedback = edit.op === 'add' ? 'Added lower third' : edit.op === 'remove' ? 'Removed lower third' : 'Updated lower third';
      }
      const prefs = await getPreferences();
      const input = buildTitlesInput(assembly.shoot, record, assembly.template, assembly.cutList, prefs.captions.safeArea, prefs.output.height);
      const source = captionSourceForInput(input);
      // Presentation is derived from saved source text, so removing a bleep
      // restores captions without ever changing the shoot's transcript.
      record.titles = { ...(record.titles ?? { font: 'Outfit', cues: [], prompt: null, skillIds: [] }), captionSource: source } as import('./titles/captions').CaptionTrack;
      if (!assembly.reel.why.includes('Bleeps and lower thirds')) assembly.reel.why += '\n\nBleeps and lower thirds are in the finished video. Reapply these effects in editors using the saved source spans and lower third times; original media stays unchanged.';
      await renderStoredPreview(root, cutId, record, assembly);
      activity.signal.throwIfAborted();
      return { cutId, version: record.version };
    }));
}
