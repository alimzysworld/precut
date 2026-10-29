import type { Clip, CutEdit } from '../shared/schema';

/** One contiguous judged span only: rounding always moves away from unusable frames. */
export function replacementSpan(clip: Clip, lengthS: number, edit?: Pick<Extract<CutEdit, { kind: 'replace' }>, 's' | 'e'>) {
  const duration = clip.meta?.durationS ?? 0;
  const measured = clip.meta?.fps, raw = measured && Number.isFinite(measured) && measured>0 ? measured : 25;
  // Match buildCutList's rational clock, including metadata rounded to 29.97.
  const fps = [24000/1001,30000/1001,60000/1001,24,25,30,48,50,60].find(rate=>Math.abs(raw-rate)<.002) ?? Math.round(raw*1000)/1000;
  if (!Number.isFinite(lengthS) || lengthS <= 0) throw new Error('Choose a shot with a playable length.');
  const explicit = edit?.s !== undefined || edit?.e !== undefined;
  if (explicit && (![edit?.s, edit?.e].every(v => typeof v === 'number' && Number.isFinite(v)) || edit!.s! < 0 || edit!.e! > duration || edit!.e! <= edit!.s!)) throw new Error('Choose a valid source span from this shoot.');
  const spans = (clip.judgement?.usableSpans ?? (clip.photo ? [[0, duration]] : []))
    .filter(([s,e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .map(([s,e]) => [Math.ceil(Math.max(0,s)*fps-1e-9), Math.floor(Math.min(duration,e)*fps+1e-9)] as const)
    .filter(([s,e]) => e>s);
  if (explicit) {
    const s = Math.ceil(edit!.s!*fps-1e-9), e = Math.floor(edit!.e!*fps+1e-9);
    if (e<=s || !spans.some(([a,b]) => s>=a && e<=b)) throw new Error('Choose frames inside a usable moment.');
    return {s:s/fps,e:Math.min(e,s+Math.max(1,Math.round(lengthS*fps)))/fps};
  }
  // The longest judged moment best preserves the slot; ties keep the judge's order.
  const best = spans.reduce<readonly [number,number] | undefined>((a,b) => !a || b[1]-b[0]>a[1]-a[0] ? b : a, undefined);
  if (!best) throw new Error('This clip has no usable moment yet.');
  const count = Math.min(best[1]-best[0], Math.max(1,Math.round(lengthS*fps)));
  const s = best[0]+Math.floor((best[1]-best[0]-count)/2);
  return {s:s/fps,e:(s+count)/fps};
}
