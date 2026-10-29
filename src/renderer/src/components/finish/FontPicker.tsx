import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { familiesFromFaces, type FontFamily } from "../../../../shared/local-fonts";
import { getApi } from "../../data";
import { titleDocument } from "../LivePlayer";
import { FOCUS, SearchField } from "../ui";

// VO7-15: pick any font on this Mac. The short bundled list stays on top as Suggested; below it every installed
// family, each name drawn in its own font. The list is virtualised, so only visible rows load their font.

type LocalFace = { family: string; style: string };
let listing: Promise<FontFamily[]> | null = null;
/** This Mac's families, read once per launch: Local Font Access first, the main process listing if that is missing. */
export function installedFonts(): Promise<FontFamily[]> {
  listing ??= (async () => {
    const query = (window as Window & { queryLocalFonts?: () => Promise<LocalFace[]> }).queryLocalFonts;
    if (query) {
      try { const families = familiesFromFaces(await query.call(window)); if (families.length) return families; }
      catch { /* not granted here: use the main process listing */ }
    }
    return (await getApi().localFonts?.()) ?? [];
  })().catch(() => { listing = null; return []; });
  return listing;
}
export function useInstalledFonts(): FontFamily[] | null {
  const [families, setFamilies] = useState<FontFamily[] | null>(null);
  useEffect(() => { let alive = true; void installedFonts().then(found => { if (alive) setFamilies(found); }); return () => { alive = false; }; }, []);
  return families;
}

// The same test the title renderer uses (template.html): an installed family changes a sample's width against at
// least one generic fallback. Preview, export and this note therefore agree on what is missing.
const drawable = new Map<string, boolean>();
export function fontOnThisMac(family: string, bundled: readonly string[]): boolean {
  if (bundled.includes(family) || typeof document === "undefined") return true;
  if (!drawable.has(family)) {
    const probe = document.createElement("canvas").getContext("2d"), sample = "mmmmmmmmmmlliWQ@#0";
    drawable.set(family, !probe || ["monospace", "serif", "sans-serif"].some(generic => {
      probe.font = `72px ${generic}`; const base = probe.measureText(sample).width;
      probe.font = `72px "${family}", ${generic}`; return probe.measureText(sample).width !== base;
    }));
  }
  return drawable.get(family)!;
}

// The bundled caption faces are inlined for the title renderer; the picker reuses them so Suggested names draw in
// their own font too. Outfit and Inter already load with the app.
let facesAdded = false;
function addBundledFaces(): void {
  if (facesAdded) return;
  facesAdded = true;
  const rules = titleDocument.match(/@font-face\{[^}]*\}/g) ?? [];
  const style = document.createElement("style");
  style.dataset.captionFaces = "";
  style.textContent = rules.filter(rule => !/font-family:\s*(Outfit|Inter)\s*;/.test(rule)).join("");
  document.head.append(style);
}

type Row = { kind: "header"; label: string } | { kind: "font"; family: string } | { kind: "note"; label: string };
const ROW = 32, HEIGHT = 288, OVERSCAN = 6;
const css = (family: string) => `"${family}", var(--font-sans)`;

export function FontPicker({ value, suggested, onChange, onPreview, label = "Font" }: {
  value: string; suggested: readonly string[]; onChange: (family: string) => void; onPreview?: (family: string | null) => void; label?: string;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [top, setTop] = useState(0), [active, setActive] = useState(-1);
  const families = useInstalledFonts();
  const container = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const id = useId(), scrolled = useRef(0);
  useEffect(addBundledFaces, []);
  const rows = useMemo<Row[]>(() => {
    const words = query.trim().toLowerCase();
    const match = (family: string) => !words || family.toLowerCase().includes(words);
    const mine = suggested.filter(match);
    const local = (families ?? []).map(f => f.family).filter(family => !suggested.includes(family) && match(family));
    const out: Row[] = [];
    if (mine.length) out.push({ kind: "header", label: "Suggested" }, ...mine.map(family => ({ kind: "font" as const, family })));
    if (!families) out.push({ kind: "header", label: "On this Mac" }, { kind: "note", label: "Reading this Mac's fonts…" });
    else if (local.length) out.push({ kind: "header", label: "On this Mac" }, ...local.map(family => ({ kind: "font" as const, family })));
    if (!out.length) out.push({ kind: "note", label: `No fonts match "${query.trim()}"` });
    return out;
  }, [families, query, suggested]);
  const options = useMemo(() => rows.flatMap((row, index) => row.kind === "font" ? [index] : []), [rows]);
  useEffect(() => { setActive(-1); if (list.current) list.current.scrollTop = 0; setTop(0); }, [query]);
  // Typing marks the top match with the soft fill, so Enter visibly picks it; the arrows move on from there.
  const typed = query.trim() !== "";
  useEffect(() => { if (typed) setActive(current => options.includes(current) ? current : options[0] ?? -1); }, [typed, options]);
  // Opening reveals the whole list, even when the Font field sits at the bottom of a scrolled panel.
  useEffect(() => { if (open) list.current?.parentElement?.scrollIntoView({ block: "nearest" }); }, [open, families]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  });
  function close(refocus: boolean) {
    setOpen(false); setQuery(""); setActive(-1); onPreview?.(null);
    if (refocus) trigger.current?.focus();
  }
  function pick(family: string) { onChange(family); close(true); }
  function reveal(index: number) {
    const box = list.current; if (!box) return;
    if (index * ROW < box.scrollTop) box.scrollTop = index * ROW;
    else if ((index + 1) * ROW > box.scrollTop + HEIGHT) box.scrollTop = (index + 1) * ROW - HEIGHT;
  }
  function key(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); close(true); return; }
    if (event.key === "Enter") {
      // The active row, or with none the first visible match.
      const row = rows[active >= 0 ? active : options[0] ?? -1];
      if (row?.kind === "font") { event.preventDefault(); pick(row.family); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!options.length) return;
    const at = options.indexOf(active), next = options[event.key === "ArrowDown" ? Math.min(options.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)];
    setActive(next); reveal(next);
    const row = rows[next]; if (row.kind === "font") onPreview?.(row.family);
  }
  const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN), last = Math.min(rows.length, Math.ceil((top + HEIGHT) / ROW) + OVERSCAN);
  return <div ref={container} data-font-picker className="space-y-2">
    <button ref={trigger} type="button" aria-label={`${label}: ${value}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => open ? close(false) : setOpen(true)}
      className={`flex w-full items-center gap-2 rounded-lg bg-ink/[0.06] p-2 text-left text-small text-ink hover:bg-ink/[0.1] ${FOCUS}`}>
      <span className="min-w-0 flex-1 truncate" style={{ fontFamily: css(value) }}>{value}</span><CaretDown size={13} aria-hidden="true" className="shrink-0 text-muted" />
    </button>
    {open ? <div className="space-y-2 rounded-xl bg-ink/[0.04] p-2">
      <SearchField label="Search fonts" placeholder="Search fonts" shortcut={null} autoFocus query={query} onQueryChange={setQuery} onKeyDown={key}
        aria-controls={`${id}-list`} aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined} className="!py-2" />
      <div ref={list} id={`${id}-list`} role="listbox" aria-label="Fonts" onScroll={event => { scrolled.current = performance.now(); setTop(event.currentTarget.scrollTop); }} onPointerLeave={() => onPreview?.(null)}
        className="relative overflow-y-auto overscroll-contain" style={{ height: Math.min(HEIGHT, rows.length * ROW) }}>
        <div style={{ height: rows.length * ROW, position: "relative" }}>
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset, place = { position: "absolute" as const, top: index * ROW, left: 0, right: 0, height: ROW };
            if (row.kind !== "font") return <div key={`${row.kind}-${row.label}`} role="presentation" style={place}
              className={`flex items-center px-2 text-micro text-muted ${row.kind === "header" ? "pt-2" : ""}`}>{row.label}</div>;
            const selected = row.family === value;
            return <div key={`font-${row.family}`} id={`${id}-${index}`} role="option" aria-selected={selected} title={row.family} style={{ ...place, fontFamily: css(row.family),
              background: selected ? "color-mix(in srgb, var(--accent) 22%, transparent)" : index === active ? "var(--selection-fill)" : undefined }}
              onPointerEnter={() => { if (performance.now() - scrolled.current < 150) return; setActive(index); onPreview?.(row.family); }} onClick={() => pick(row.family)}
              className="flex cursor-pointer items-center truncate rounded-lg px-2 text-[15px] text-ink">{row.family}</div>;
          })}
        </div>
      </div>
    </div> : null}
  </div>;
}
