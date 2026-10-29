import { Row, Tile } from "../ui";
import { useEffect, useState } from "react";
import { FOCUS } from "../ui";
export type HistogramData = { luma: number[]; red: number[]; green: number[]; blue: number[] };
export function histogram(data: Uint8ClampedArray): HistogramData {
  const result: HistogramData = { luma: Array(64).fill(0), red: Array(64).fill(0), green: Array(64).fill(0), blue: Array(64).fill(0) };
  for (let i = 0; i < data.length; i += 4) {
    result.red[data[i] >> 2]++; result.green[data[i + 1] >> 2]++; result.blue[data[i + 2] >> 2]++;
    result.luma[Math.min(63, Math.floor((.2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]) / 4))]++;
  }
  return result;
}
// Look can mount before playback preparation finishes. A late player reads
// the subscription state instead of missing a one-shot window event.
let histogramUsers = 0;
export function isHistogramActive(): boolean { return histogramUsers > 0; }
export function Histogram({ clipping, onClipping }: { clipping: boolean; onClipping: () => void }) {
  const [bins, setBins] = useState<HistogramData | null>(null);
  useEffect(() => {
    const read = (event: Event) => setBins((event as CustomEvent<HistogramData>).detail);
    histogramUsers++;
    window.addEventListener("sidething:histogram", read);
    window.dispatchEvent(new CustomEvent("sidething:histogram-active", { detail: true }));
    return () => { histogramUsers = Math.max(0,histogramUsers-1); window.removeEventListener("sidething:histogram", read); window.dispatchEvent(new CustomEvent("sidething:histogram-active", { detail: isHistogramActive() })); };
  }, []);
  const top = bins ? Math.max(1, ...Object.values(bins).flat()) : 1;
  return <div className="space-y-1">
    <Row className="text-micro text-muted"><span>Luma + RGB</span><Tile type="button" aria-label="Clipping preview" aria-pressed={clipping} title="Clipping preview (J)" onClick={onClipping} className={`rounded-lg px-2 py-1 ${clipping ? "bg-ink/10 text-ink" : "hover:bg-ink/[0.05]"} ${FOCUS}`}>Clipping · J</Tile></Row>
    {bins ? <svg role="img" aria-label="Current frame histogram" viewBox="0 0 252 64" preserveAspectRatio="none" className="h-16 w-full rounded-lg bg-ink/[0.035]">
      {([['red', 'var(--badge-pink-ink)'], ['green', 'var(--badge-lime-ink)'], ['blue', 'var(--accent)'], ['luma', 'var(--ink)']] as const).map(([key, colour]) => <path key={key} d={`M0 64 ${bins[key].map((n, i) => `L${i * 4} ${63 - n / top * 60}`).join(" ")} L252 64 Z`} fill={colour} fillOpacity={key === "luma" ? .2 : .15} stroke={colour} strokeWidth=".7" />)}
    </svg> : <p className="text-micro text-muted">Histogram appears when a video frame is available.</p>}
  </div>;
}
