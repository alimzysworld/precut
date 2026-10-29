import type { Clip, Shoot } from '../../../shared/schema';
import { clipTurn, clipRotation } from '../../../shared/media';

const shoots = new Map<string, Shoot>();
const optimistic = new Map<string, Clip>();
const listeners = new Set<() => void>();
let revision = 0;
const key = (root: string, id: string) => JSON.stringify([root, id]);
export const subscribeRotation = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const rotationRevision = () => revision;
const notify = () => { revision++; listeners.forEach(listener => listener()); };
export function observeRotationShoot(shoot: Shoot) {
  shoots.delete(shoot.root); shoots.set(shoot.root, shoot);
  if (shoots.size > 16) shoots.delete(shoots.keys().next().value!);
  notify();
}
export function rotationClip(root: string, id: string, fallback?: Clip): Clip | undefined {
  return optimistic.get(key(root, id)) ?? shoots.get(root)?.clips.find(clip => clip.id === id) ?? fallback;
}
export function desiredRotation(root: string, id: string, fallback = 0): number {
  const clip = rotationClip(root, id);
  return clip ? clipRotation(clip) : fallback;
}
export function previewRotation(root: string, clip: Clip): () => void {
  const id = key(root, clip.id);
  optimistic.set(id, clip); notify();
  return () => { if (optimistic.get(id) === clip) { optimistic.delete(id); notify(); } };
}

export function rotationItems(clip: Clip) {
  return ['Rotate right', 'Rotate left', ...(clipTurn(clip) ? ['Back to original'] : [])];
}
