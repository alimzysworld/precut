import type { DraftTimeline } from '../../../../shared/schema';
import { magneticSpans, timelineTime, type TrimEdge } from './model';

/** FIX4: how far in from a piece's edge a press trims. 10 px, but never more than a quarter of the piece, so the
 * middle of a narrow clip (5 to 17 px at Fit zoom) always selects it. The trim handles use the same width. */
export const trimZone = (width: number) => Math.min(10, Math.max(0, width) / 4);
/** Half-open spans make the pointer's side of a join authoritative. */
export function hitTrimEdge(x: number, left: number, width: number): TrimEdge | undefined {
  if (x < left || x >= left + width || width <= 0) return;
  const start = x - left, end = left + width - x;
  if (Math.min(start, end) > trimZone(width)) return;
  return start <= end ? 'start' : 'end';
}

/** Geometry only: keep filmstrips, waveforms and the editor's React tree asleep. */
export function paintTrim(canvas: HTMLElement, plan: DraftTimeline, piece: number, scale: number, length: number, limit?: string | null, seek?: number) {
  for (const span of magneticSpans(plan)) {
    const block = canvas.querySelector<HTMLElement>(`[data-source-piece="${span.piece}"]`);
    if (!block) continue;
    block.style.left = `${span.startS * scale}px`;
    block.style.width = `${(span.endS - span.startS) * scale}px`;
    block.dataset.dragging = String(span.piece === piece);
    if (span.piece === piece) {
      const badge = block.querySelector<HTMLElement>('[data-duration-badge]');
      if (badge) badge.textContent = `${length.toFixed(1)} s`;
    }
  }
  for (const head of canvas.querySelectorAll<HTMLElement>('[data-timeline-playhead]')) head.hidden=piece>=0;
  const head=canvas.querySelector<HTMLElement>('[data-layered-playhead]');
  if(head && seek!==undefined){head.style.left=`${seek*scale}px`;const label=head.querySelector<HTMLElement>('[data-playhead-time]');if(label)label.textContent=timelineTime(seek);}
  const label = canvas.closest('[data-timeline]')?.querySelector<HTMLElement>('[data-trim-readout]');
  if (label) { label.hidden = false; label.textContent = `${length.toFixed(1)} s${limit ? ` · ${limit}` : ''}`; }
}
