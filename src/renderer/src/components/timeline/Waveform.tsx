import { useEffect, useRef, useState, type ReactElement } from "react";
import type { PeakSlice } from "../../../../shared/schema";
import { getApi } from "../../data";

/** VO7-4: where a sound's cached peaks live. Explicit root and file win; else a shoot media URL is read back. */
export function peakSource(sound?: string, root?: string, file?: string): { root: string; file: string } | null {
  if (root && file) return { root, file };
  if (!sound?.startsWith("st-media://local/")) return null;
  const parts = sound.slice("st-media://local/".length).split(/[?#]/)[0].split("/");
  if (parts.length !== 3) return null;
  try {
    const [shoot, kind, name] = [decodeURIComponent(parts[0]), parts[1], decodeURIComponent(parts[2])];
    if (kind === "voice") return name.startsWith("voiceover:") ? { root: shoot, file: name.slice(10) } : null;
    if (kind === "thumbs" || !name) return null;
    return { root: shoot, file: `.sidething/${kind}/${name}` };
  } catch { return null; }
}
/** One bar per five pixels of the block (the density the 240-bar waveform had on a typical block), each the loudest measured peak it covers (0..1). */
export function peakColumns(slice: Pick<PeakSlice, "min" | "max">, width: number): number[] {
  const count = slice.max.length, columns = Math.min(count, Math.max(1, Math.round(width / 5)));
  if (!count || width <= 0) return [];
  const out = new Array<number>(columns);
  for (let c = 0; c < columns; c++) {
    let peak = 0;
    for (let i = Math.floor(c * count / columns), end = Math.max(i + 1, Math.floor((c + 1) * count / columns)); i < end; i++) peak = Math.max(peak, -slice.min[i], slice.max[i]);
    out[c] = Math.round(Math.min(127, peak) / 127 * 1000) / 1000;
  }
  return out;
}

// Slices already fetched this session, so a remount paints in the same frame.
const slices = new Map<string, PeakSlice>();
function remember(key: string, slice: PeakSlice) { slices.delete(key); slices.set(key, slice); while (slices.size > 256) slices.delete(slices.keys().next().value!); }

export function Waveform({ sound, measured, muted = false, label, root, file, from, to }: { sound?: string; measured?: number[]; muted?: boolean; label?: string; root?: string; file?: string; from?: number; to?: number }) {
  const rendered = useRef<{values:number[];description:string;node:ReactElement} | null>(null);
  const box = useRef<HTMLSpanElement | null>(null);
  const source = measured ? null : peakSource(sound, root, file);
  const key = source ? JSON.stringify([source.root, source.file, from ?? null, to ?? null]) : "";
  const [peaks, setPeaks] = useState<{ key: string; slice: PeakSlice } | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!key || !source) return;
    const hit = slices.get(key);
    if (hit) { setPeaks({ key, slice: hit }); return; }
    let live = true;
    let api: ReturnType<typeof getApi> | undefined;
    try { api = getApi(); } catch { return; }
    // Peaks come from the main process cache; the renderer never fetches or decodes the file.
    void api.getPeaks?.(source.root, source.file, from, to).then(slice => { remember(key, slice); if (live) setPeaks({ key, slice }); }, () => { /* The quiet empty state stays; nothing is invented. */ });
    return () => { live = false; };
  }, [key]);
  useEffect(() => {
    const node = box.current;
    if (!key || !node) return;
    setWidth(Math.round(node.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [key]);
  const drawn = useRef<{ memo: string; node: ReactElement } | null>(null);
  if (muted) return <span aria-label="Muted waveform" className="absolute inset-x-1 top-1/2 h-0.5 bg-current opacity-40" />;
  const empty = <span className="px-2 text-micro text-muted">{label ? "Sound" : measured ? "Voice" : "Draft sound"}</span>;
  if (key) {
    // Drawn at the block's own pixel width; a quiet label until the peaks arrive, never a spinner.
    const slice = peaks && peaks.key === key ? peaks.slice : slices.get(key) ?? null, memo = `${key}|${width}|${label ?? ""}`;
    if (slice && width > 0 && drawn.current?.memo !== memo) {
      const columns = peakColumns(slice, width);
      drawn.current = columns.length ? { memo, node: svg(columns, label ?? "Draft sound waveform") } : null;
    }
    const node = slice && width > 0 && drawn.current?.memo === memo ? drawn.current.node : empty;
    return <span ref={box} className="absolute inset-0 flex items-center">{node}</span>;
  }
  const values = measured ?? [];
  if (!values.length) return empty;
  const description = label ?? "Voice waveform";
  if (!rendered.current || rendered.current.values!==values || rendered.current.description!==description) rendered.current={values,description,node:svg(values, description)};
  return rendered.current.node;
}
function svg(values: number[], description: string) {
  return <svg role="img" aria-label={description} preserveAspectRatio="none" viewBox={`0 0 ${values.length} 2`} className="absolute inset-0 h-full w-full">
    <path d={values.map((peak,i)=>`M${i} ${1-peak}V${1+peak}`).join("")} stroke="currentColor" strokeWidth=".65" />
  </svg>;
}
