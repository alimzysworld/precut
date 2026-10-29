/** Measured times only, always on the picture/output clock. */
export interface MusicGrid {
  beats: number[]; bars: number[]; hits: number[];
  sections: { s: number; e: number; section: number }[];
}
export interface MusicTrimBounds { low: number; high: number; safe: [number, number][]; lockedDuration: number | null }
export function outputMusicGrid(m: { beats?: number[]; bars: number[]; hits: number[]; sections: number[]; durationS: number }, duration: number, start: number,
  parts?: { sourceS: number; sourceE: number; atS: number; section: number }[]): MusicGrid {
  const spans = parts ?? [{ sourceS: start, sourceE: Math.min(m.durationS,start + duration), atS: 0, section: 0 }];
  // V63: a part that starts on a bar can carry float drift (b - (b - a)); keep that bar's mark.
  const map = (times: number[]) => [...new Set(spans.flatMap(p => times.filter(t => t >= p.sourceS - 1e-9 && t < p.sourceE).map(t => p.atS + Math.max(0, t - p.sourceS))))]
    .filter(t => Number.isFinite(t) && t >= 0 && t <= duration).sort((a,b) => a-b);
  const sections = spans.flatMap(p => {
    const cuts = [p.sourceS, ...m.sections.filter(t => t > p.sourceS && t < p.sourceE), p.sourceE];
    return cuts.slice(0,-1).map((s,i) => ({s: Math.max(0,p.atS+s-p.sourceS), e: Math.min(duration,p.atS+cuts[i+1]-p.sourceS),
      section: Math.max(0,m.sections.reduce((n,t,j) => t <= s ? j : n,0))}));
  }).filter(p => p.e > p.s);
  return { beats: map(m.beats ?? []), bars: map(m.bars), hits: map(m.hits), sections };
}
export function beatAt(grid: MusicGrid, at: number, tolerance: number): number | undefined {
  for(const times of [grid.bars,grid.beats,grid.hits]) {
    let low=0,high=times.length;
    while(low<high){const mid=(low+high)>>>1;if(times[mid]<at-tolerance-1e-7)low=mid+1;else high=mid;}
    if(low<times.length && Math.abs(times[low]-at)<=tolerance+1e-7)return times[low];
  }
}
