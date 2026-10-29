// Shared evidence and thresholds. Python consumes the same rules data.
import { screenRules as rules } from './screen-rules';
import type { Clip } from './schema';
export function isScreenClip(clip: Clip): boolean {
  if (clip.photo || clip.meta && (clip.meta.width === 0 || clip.meta.height === 0)) return false;
  if (clip.screen || new RegExp(rules.name, 'i').test(clip.file) || new RegExp(rules.description, 'i').test(clip.judgement?.summary ?? '')) return true;
  const tags = (clip.quality?.tags ?? []).filter(t => t.confidence >= .5).map(t => t.label.toLowerCase());
  if (tags.some(t => rules.tags.includes(t))) return true;
  const meta = clip.meta;
  return !!meta && !meta.camera && meta.fps > 0 && meta.fps <= 120 &&
    (rules.displays.some(([w,h]) => meta.width === w && meta.height === h) || tags.some(t => rules.uiTags.includes(t)));
}
export function screenText(clip: Clip): string[] {
  return (clip.screen?.segments ?? []).flatMap(s => [s.line, s.app, s.action, s.text].filter((s): s is string => !!s));
}
