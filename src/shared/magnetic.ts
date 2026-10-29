/** A move uses final indexes, so moving 0 to 2 in [a,b,c] gives [b,c,a]. */
export function moveOrder(count: number, from: number, to: number): number[] {
  if (![count, from, to].every(Number.isInteger) || count < 1 || from < 0 || to < 0 || from >= count || to >= count) throw new Error("Choose a clip and a place inside this edit.");
  const order = Array.from({ length: count }, (_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  return order;
}

export type MagneticSpan = { piece: number; startS: number; endS: number; offsetS?: number };
/** Attach timed items to the piece containing their start. An end at a cut
 * belongs to the same item, rather than accidentally following its new neighbour. */
export function magneticTime(before: MagneticSpan[], after: MagneticSpan[]) {
  const duration = Math.max(0,...after.map(p=>p.endS));
  const owner = (t: number) => before.find(p => t >= p.startS - 1e-7 && t < p.endS - 1e-7) ?? before.at(-1);
  const point = (t: number) => {
    const old = owner(t), next = after.find(p => p.piece === old?.piece);
    return old && next ? Math.max(next.startS, Math.min(next.endS, next.startS + t - old.startS - (next.offsetS ?? 0))) : t;
  };
  const range = <T extends { s: number; e: number }>(item: T): T => {
    const old = owner(item.s), next = after.find(p => p.piece === old?.piece);
    if (!old || !next) return item;
    const shift = next.startS-old.startS-(next.offsetS ?? 0);
    const s = Math.max(next.startS, Math.min(next.endS, item.s+shift));
    return { ...item, s, e: Math.max(s, Math.min(duration, item.e+shift)) };
  };
  return { point, range };
}
