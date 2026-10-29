import type { CutItem, ExportFinishing } from './export';
import { planFx, mapTime, type FxItem } from './edits-fx';

/** All interchange formats project the live timing plan, before rounding to
 * their sequence grid. Authored title/caption times are already in this clock. */
export function editorPlan(cuts: CutItem[], fps: number, version: ExportFinishing = {}) {
  const plan = planFx(cuts, fps, version);
  // Older assemblies can contain intentional empty space between cuts.
  const changesTime = plan.items.some(p => p.overlap || p.timeMap.length > 2 ||
    Math.abs(p.endS - p.startS - (p.timeMap.at(-1)!.s - p.timeMap[0].s)) > 1e-7);
  if (!changesTime) {
    plan.items.forEach((p, n) => {
      const shift = cuts[n].offsetFrames / fps - p.startS;
      p.startS += shift; p.endS += shift;
      p.timeMap = p.timeMap.map(k => ({ ...k, t: k.t + shift }));
    });
    plan.joins.forEach(j => { j.atS = plan.items.find(p => p.startS >= j.atS - 1e-7)?.startS ?? j.atS; });
    plan.durationS = Math.max(0, ...plan.items.map(p => p.endS));
  }
  return plan;
}

export function retimed(item: FxItem) {
  return !!item.reverse || item.timeMap.length > 2 ||
    Math.abs(item.endS - item.startS - (item.timeMap.at(-1)!.s - item.timeMap[0].s)) > 1e-7;
}

/** Local output time -> trimmed compound source time, including the held last
 * reverse frame. The source compound starts at zero, regardless of camera TC. */
export function editorTimeKeys(item: FxItem, sourceFps: number) {
  const first = item.timeMap[0].s, last = item.timeMap.at(-1)!.s;
  const keys = item.reverse ? [...item.timeMap,
    { t: mapTime(item.timeMap, last - 1 / sourceFps), s: last - 1 / sourceFps }]
    .sort((a, b) => a.t - b.t).filter((k, n, a) => !n || k.t - a[n - 1].t > 1e-7) : item.timeMap;
  return keys.map(k => ({ t: k.t - item.startS,
    s: item.reverse ? Math.max(0, last - 1 / sourceFps - k.s) : k.s - first }));
}

/** xmeml's native Time Remap filter. graphdict also carries non-linear ramps.
 * In/out remain source frame bounds; when is in the clip's output clock. */
export function premiereTimeMap(item: FxItem, sourceFps: number, sequenceFps: number, sourceOffset = 0, mediaType = 'video') {
  if (!retimed(item)) return '';
  const sourceStart = item.timeMap[0].s + sourceOffset;
  const speed = (item.timeMap.at(-1)!.s - item.timeMap[0].s) / (item.endS - item.startS) * 100;
  // Several ramp keys can round to one output frame at high speeds. Keep the
  // final source value for that frame rather than emitting duplicate whens.
  const keys = [...new Map(editorTimeKeys(item, sourceFps).map(k =>
    [Math.round(k.t * sequenceFps), k])).values()];
  const parameter = (id: string, name: string, value: string | number) => `<parameter><parameterid>${id}</parameterid><name>${name}</name><value>${value}</value></parameter>`;
  return `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>${mediaType}</mediatype>${parameter('variablespeed', 'variablespeed', item.timeMap.length > 2 ? 1 : 0)}${parameter('speed', 'speed', speed)}${parameter('reverse', 'reverse', item.reverse ? 'TRUE' : 'FALSE')}${parameter('frameblending', 'frameblending', 'FALSE')}<parameter><parameterid>graphdict</parameterid><name>graphdict</name>${keys.map((k, n) => `<keyframe><when>${Math.round(k.t * sequenceFps)}</when><value>${(sourceStart + k.s) * sourceFps}</value><interpolation><name>FCPCurve</name></interpolation>${n === 0 ? '<speedkfin>TRUE</speedkfin>' : ''}${n === keys.length - 1 ? '<speedkfout>TRUE</speedkfout>' : ''}</keyframe>`).join('')}</parameter></effect></filter>`;
}
