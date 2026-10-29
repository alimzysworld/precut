import type { LowerThird, TitleCue, TitleTrack } from '../../shared/schema';
export function lowerThirdCues(items: LowerThird[] = [], style?: TitleTrack['captionStyle']): TitleCue[] {
  const cues: TitleCue[] = [];
  for (const item of items) cues.push({ id: `lower-third:${item.id}`, role: 'title', layer: 'front', s: item.s, e: item.e,
    text: item.title + (item.subtitle ? '\n' + item.subtitle : ''), x: item.position === 'left' ? .08 : item.position === 'right' ? .92 : .5,
    y: .72, align: item.position === 'centre' ? 'center' : item.position, size: .032, weight: 800, italic: false,
    color: style?.primary ?? '#ffffff', accent: style?.accent ?? '#F7C204', enter: 'slide-left', exit: 'fade' });
  return cues;
}
