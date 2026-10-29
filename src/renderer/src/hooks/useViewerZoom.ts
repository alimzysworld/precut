import { useEffect, useRef, useState, type RefObject } from 'react';
import { useShortcuts } from './useShortcuts';
import { clampView, fitView, pictureZoom, wheelPixels } from '../components/viewZoom';

/** View transforms never enter the timeline, compositor, or persisted edit. */
export function useViewerZoom(root: RefObject<HTMLDivElement>, key: string, active: boolean, sourceWidth?: number) {
  const tag = useRef<HTMLSpanElement>(null);
  const [panReady, setPanReady] = useState(false);
  const space = useRef({ held: false, panned: false });
  const enabled = useRef(active); enabled.current = active;
  const nativeWidth = useRef(sourceWidth); nativeWidth.current = sourceWidth;
  useShortcuts('precuts', [
    { id: 'zoom-fit', keys: ['Shift+z'], label: 'Fit viewer and timeline', scope: 'precuts', handler: () => window.dispatchEvent(new Event('precut:zoom-fit')) },
    { id: 'viewer-pan-space', keys: ['Space'], label: 'Hold and drag to pan the viewer', scope: 'precuts', enabled: panReady, handler: () => { space.current = { held: true, panned: false }; } },
  ], active);
  useEffect(() => {
    const stage = root.current;
    if (!stage) return;
    let view = fitView(), frame = 0;
    let drag: { id: number; x: number; y: number; view: typeof view; player: HTMLElement } | null = null;
    const picture = () => stage.querySelector<HTMLElement>('[data-cut-player]:not([aria-hidden="true"])');
    const paint = () => {
      frame = 0;
      const player = picture();
      if (!player) return;
      view = clampView(view, player.clientWidth, player.clientHeight);
      const layer = player.querySelector<HTMLElement>('[data-view-picture]');
      if (layer) { layer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`; layer.style.cursor = view.scale > 1 ? drag ? 'grabbing' : 'grab' : ''; }
      const changed = player.dataset.viewScale !== String(view.scale);
      player.dataset.viewScale = String(view.scale);
      if (changed) player.dispatchEvent(new Event('precut:viewer-zoom'));
      setPanReady(view.scale > 1 && player.matches(':hover'));
      const media = player.querySelector('video'), image = player.querySelector('img');
      const width = nativeWidth.current || media?.videoWidth || image?.naturalWidth || player.clientWidth;
      if (tag.current) { tag.current.hidden = view.scale <= 1; tag.current.textContent = `${Math.round(view.scale * player.clientWidth / width * 100)}% · Shift-Z to fit`; }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const reset = () => { if (drag?.player.hasPointerCapture(drag.id)) drag.player.releasePointerCapture(drag.id); view = fitView(); drag = null; space.current.held = false; setPanReady(false); schedule(); };
    const targetPlayer = (event: Event) => {
      if (!enabled.current) return null;
      const target = event.target as HTMLElement;
      // Crop/framing controls and overlay handles keep ownership of their gestures.
      if (target.closest('button, input, select, [role="slider"], [data-overlay-handle], [data-crop]')) return null;
      return target.closest<HTMLElement>('[data-cut-player]');
    };
    const zoom = (player: HTMLElement, scale: number, x: number, y: number) => {
      const box = player.getBoundingClientRect();
      view = pictureZoom(view, scale, x - box.left - box.width / 2, y - box.top - box.height / 2, box.width, box.height); schedule();
    };
    const wheel = (event: WheelEvent) => {
      const player = targetPlayer(event); if (!player) return;
      event.preventDefault();
      const width = nativeWidth.current || player.querySelector('video')?.videoWidth || player.querySelector('img')?.naturalWidth || player.clientWidth;
      const max = Math.max(1, 4 * width / player.clientWidth);
      zoom(player, Math.max(1, Math.min(max, view.scale * Math.exp(-wheelPixels(event, player.clientHeight) * (event.ctrlKey ? .01 : .002)))), event.clientX, event.clientY);
    };
    const double = (event: MouseEvent) => {
      const player = targetPlayer(event); if (!player) return;
      event.preventDefault();
      const width = nativeWidth.current || player.querySelector('video')?.videoWidth || player.querySelector('img')?.naturalWidth || player.clientWidth;
      zoom(player, view.scale > 1 ? 1 : Math.max(1, width / player.clientWidth), event.clientX, event.clientY);
    };
    const down = (event: PointerEvent) => {
      const player = targetPlayer(event); if (!player || event.button !== 0 || view.scale <= 1) return;
      event.preventDefault(); player.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, view, player }; schedule();
    };
    const move = (event: PointerEvent) => {
      setPanReady(view.scale > 1 && !!targetPlayer(event));
      if (!drag || drag.id !== event.pointerId) return;
      if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 3) space.current.panned = true;
      view = clampView({ ...drag.view, x: drag.view.x + event.clientX - drag.x, y: drag.view.y + event.clientY - drag.y }, drag.player.clientWidth, drag.player.clientHeight); schedule();
    };
    const up = () => { if (drag?.player.hasPointerCapture(drag.id)) drag.player.releasePointerCapture(drag.id); drag = null; schedule(); };
    const leave = () => setPanReady(false);
    const blur = () => { space.current.held = false; up(); setPanReady(false); };
    const keyup = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !space.current.held) return;
      space.current.held = false;
      if (!space.current.panned) picture()?.querySelector<HTMLButtonElement>('.st-player-transport button')?.click();
    };
    stage.addEventListener('wheel', wheel, { passive: false }); stage.addEventListener('dblclick', double);
    stage.addEventListener('pointerdown', down); stage.addEventListener('pointermove', move); stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up); stage.addEventListener('lostpointercapture', up);
    window.addEventListener('precut:zoom-fit', reset);
    stage.addEventListener('pointerleave', leave); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur);
    const observer = new ResizeObserver(schedule); observer.observe(stage); reset();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      stage.querySelectorAll<HTMLElement>('[data-view-picture]').forEach(layer => { layer.style.transform = ''; layer.style.cursor = ''; });
      if (tag.current) tag.current.hidden = true;
      stage.removeEventListener('wheel', wheel); stage.removeEventListener('dblclick', double);
      stage.removeEventListener('pointerdown', down); stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up); stage.removeEventListener('pointercancel', up); stage.removeEventListener('lostpointercapture', up);
      window.removeEventListener('precut:zoom-fit', reset);
      stage.removeEventListener('pointerleave', leave); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur);
    };
  }, [key]);
  return tag;
}
