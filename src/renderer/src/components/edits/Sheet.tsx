import { NamedMessage } from "../ClipNames";
import type { CSSProperties, ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CLIP_PANELS, EDIT_PANELS, type EditsPanel } from "../../hooks/useShortcuts";
import { instant, spring } from "../../motion";
import { Close, Wand } from "../icons";
import { FOCUS, SectionHeader, Tile } from "../ui";
import "./shell.css";
import "../library/library.css";
import { PaneHandle, usePane } from "./ToolBar";

export function Sheet({ panel, scope, selectedCount = 0, selectedPiece, selectedName, onScope, onClose, children, browsing = false }: {
  /** RAIL1: Clips' footage browser is open; the sheet takes the browser's resizable width. */
  browsing?: boolean; selectedName?: string; selectedCount?: number; panel: EditsPanel | null; scope: "edit" | "clip"; selectedPiece: number | null;
  onScope: (scope: "edit" | "clip") => void; onClose: () => void; children: ReactNode;
}) {
  const [mediaWidth, setMediaWidth] = usePane("media-width", 600, 420, 900);
  const reduced = useReducedMotion();
  const title = browsing ? "Footage" : panel === "clips" && selectedPiece !== null ? "Clip" : EDIT_PANELS.find(entry => entry.id === panel)?.label;
  return <motion.aside id="edits-sheet" data-edits-sheet data-panel={panel} data-browse={browsing || undefined} data-open={!!panel} aria-label={panel ? `${title} panel` : "Edit panel"}
    hidden={!panel} className="edits-sheet" style={browsing ? { "--media-width": `${mediaWidth}px` } as CSSProperties : undefined} initial={false} animate={{ opacity: panel ? 1 : 0, x: panel || reduced ? 0 : 12 }} transition={reduced ? instant : spring.sheet}>
    {browsing && <div className="library-resize"><PaneHandle label="Resize footage browser" value={mediaWidth} onChange={setMediaWidth} min={420} max={900} reset={600} reverse /></div>}
    <header className="flex h-[46px] shrink-0 items-center justify-between pl-3.5 pr-2">
      <SectionHeader as="h2" className="flex items-center gap-2 text-[14px] font-semibold">{panel === "ask" ? <Wand size={18} /> : null}{title}</SectionHeader>
      <button type="button" aria-label="Close panel" title="Close panel (Esc)" onClick={onClose} className={`flex size-[34px] items-center justify-center rounded-full bg-ink/[0.06] ${FOCUS}`}><Close size={18} /></button>
    </header>
    {panel && CLIP_PANELS.includes(panel) ? <div className="shrink-0 space-y-1.5 px-3.5 pb-2.5">
      <div role="group" aria-label="Panel scope" className="grid grid-cols-2 rounded-[10px] bg-ink/[0.06] p-[3px]">
        {([['edit', 'Whole edit'], ['clip', selectedCount>1 ? `These ${selectedCount} clips` : 'This clip']] as const).map(([value, label]) => <Tile key={value} type="button" aria-pressed={scope === value} disabled={value === "clip" && selectedPiece === null}
          onClick={() => onScope(value)} className={`rounded-lg py-1.5 text-micro font-medium disabled:opacity-40 ${scope === value ? "bg-surface text-ink" : "text-muted"} ${FOCUS}`}>{label}</Tile>)}
      </div>
      {scope === "clip" && selectedPiece !== null ? <p className="text-micro text-muted"><NamedMessage>{selectedCount>1 ? `Changing ${selectedCount} clips.` : `Changing ${selectedName ?? "the selected shot"} only.`}</NamedMessage></p> : null}
    </div> : null}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
  </motion.aside>;
}
