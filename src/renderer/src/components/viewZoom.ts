export type PictureView = { scale: number; x: number; y: number };
export const fitView = (): PictureView => ({ scale: 1, x: 0, y: 0 });
export function clampView(view: PictureView, width: number, height: number): PictureView {
  const x = width * (view.scale - 1) / 2, y = height * (view.scale - 1) / 2;
  return { scale: view.scale, x: Math.max(-x, Math.min(x, view.x)), y: Math.max(-y, Math.min(y, view.y)) };
}
export function pictureZoom(view: PictureView, scale: number, x: number, y: number, width: number, height: number): PictureView {
  const ratio = scale / view.scale;
  return clampView({ scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio }, width, height);
}
export function timelineZoom(left: number, pointer: number, previous: number, next: number, width: number) {
  return Math.max(0, Math.min(width * (next - 1), (left + pointer) * next / previous - pointer));
}
export function wheelPixels(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, height: number) {
  return event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
}
