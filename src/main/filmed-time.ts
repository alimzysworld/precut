type FilmedClip = { meta?: { createdAt?: string | null } | null; photo?: { takenAt?: string | null } };

/** Capture clocks share a UTC timeline. Legacy zone-less ISO dates use UTC too,
 * so the same shoot cannot change order with the computer's time zone. */
export function filmedTime(clip?: FilmedClip): number | null {
  for (const value of [clip?.meta?.createdAt, clip?.photo?.takenAt]) {
    if (!value || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) continue;
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    const time = Date.parse(value.includes('T') && !zoned ? value + 'Z' : value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

export function filmedAt(clip?: FilmedClip): string | null {
  const time = filmedTime(clip);
  return time === null ? null : new Date(time).toISOString();
}

/** Stable for equal or missing times, without changing the saved clip/id order. */
export function filmedOrder<T>(items: readonly T[], clipOf: (item: T) => FilmedClip): T[] {
  return items.map((item, index) => ({ item, index, time: filmedTime(clipOf(item)) ?? Infinity }))
    .sort((a, b) => a.time - b.time || a.index - b.index).map(({ item }) => item);
}
