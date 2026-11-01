type TimeKey = { t: number; s: number };
export function mapSource(keys: TimeKey[], t: number): number {
  return interpolate(keys, t, 't', 's');
}
export function mapTime(keys: TimeKey[], s: number): number {
  return interpolate(keys, s, 's', 't');
}
function interpolate(keys: TimeKey[], n: number, x: 't' | 's', y: 't' | 's'): number {
  if (n <= keys[0][x]) return keys[0][y];
  for (let i = 1; i < keys.length; i++) if (n <= keys[i][x]) {
    const a = keys[i - 1], b = keys[i];
    return a[y] + (b[y] - a[y]) * (n - a[x]) / (b[x] - a[x]);
  }
  return keys.at(-1)![y];
}
