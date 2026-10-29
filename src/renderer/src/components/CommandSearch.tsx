import { EmptyState } from "./ui";
import { SearchField } from "./ui";
import { useEffect, useId, useRef, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useShortcuts } from "../hooks/useShortcuts";
import { CONTROL_REGISTRY, searchInspector, type SearchResult } from "./finish/search";
import type { Cut, Shoot } from "../../../shared/schema";
import { useNav } from "../nav";
import { FOCUS, Modal } from "./ui";
export function CommandSearch({ shoot, cuts = [], cutId, pieces = [], onSelect }: { shoot: Shoot; cuts?: Cut[]; cutId?: string; pieces?: { clipId: string; timelineS?: number; s?: number; e?: number; lengthS?: number; removed?: { s: number; e: number }[] }[]; onSelect?: (result: SearchResult) => void }) {
  const { go } = useNav();
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null), results = searchInspector(query, shoot, cuts, cutId, pieces), listId = useId();
  useShortcuts("global", [{ id: "command-search", keys: ["Cmd+k"], label: "Search edits, clips, words and controls", scope: "global", handler: () => setOpen(true) }]);
  useEffect(() => { if (open) { input.current?.focus(); setQuery(""); setIndex(0); } }, [open]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("sidething:command-search", show);
    return () => window.removeEventListener("sidething:command-search", show);
  }, []);
  useEffect(() => { if (open) document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" }); }, [open, index, query, listId]);
  function choose(result: SearchResult) {
    setOpen(false);
    if (onSelect) { onSelect(result); return; }
    if (result.control) go("precuts", { shoot: shoot.root, ...(cutId ? { cut: cutId } : {}), control: result.control.id });
    else if (result.cutId) go("precuts", { shoot: shoot.root, cut: result.cutId, ...(result.version ? { v: String(result.version) } : {}), ...(result.piece !== undefined ? { piece: String(result.piece) } : {}) });
    else if (result.clipId) go("clips", { shoot: shoot.root, clip: result.clipId, t: String(result.time ?? 0) });
  }
  return <><button type="button" aria-label="Search edits, clips and controls" title="Search edits, clips and controls (Cmd K)" onClick={() => setOpen(true)} className={`flex min-w-0 items-center gap-2 rounded-xl bg-ink/[0.04] px-3 py-2 text-micro text-muted ${FOCUS}`}><MagnifyingGlass size={15} /><span className="truncate">Search edits, clips or words</span><kbd className="ml-auto font-mono">⌘ K</kbd></button>
    <Modal open={open} onClose={() => setOpen(false)} title="Search edits, clips and controls">
      <SearchField shortcut={null} label="Search edits, clips and controls" ref={input} role="combobox" aria-label="Search edits, clips and controls" aria-expanded="true" aria-controls={listId} aria-activedescendant={results[index] ? `${listId}-${index}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex(previous => (previous + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, results.length)) % Math.max(1, results.length)); }
        if (event.key === "Enter" && results[index]) { event.preventDefault(); choose(results[index]); }
      }} placeholder="Search edits, clips, words or a control" className={`w-full rounded-xl bg-ink/[0.06] p-3 ${FOCUS}`} />
      <div role="listbox" id={listId} aria-label="Search results" className="mt-3 max-h-[55vh] space-y-1 overflow-y-auto">{results.map((result, i) => <button id={`${listId}-${i}`} role="option" aria-selected={index === i} key={result.id} type="button" onMouseEnter={() => setIndex(i)} onClick={() => choose(result)} className={`block w-full rounded-lg p-3 text-left text-small ${index === i ? "bg-ink/10" : "hover:bg-ink/[0.04]"} ${FOCUS}`}><span className="block truncate">{result.label}</span><span className="text-micro text-muted">{result.detail}</span></button>)}</div>
      {!query ? <p className="mt-3 text-small text-muted">Search every inspector control, your edits and source transcripts.</p> : !results.length ? <EmptyState variant="inline" as="p" className="mt-3 text-small text-muted">No matches.</EmptyState> : null}
    </Modal>
  </>;
}
export { CONTROL_REGISTRY };
