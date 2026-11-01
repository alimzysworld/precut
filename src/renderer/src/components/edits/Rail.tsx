import { EDIT_PANELS, type EditsPanel } from "../../hooks/useShortcuts";
import * as Icons from "../icons";
import { FOCUS, Tile } from "../ui";
import "./shell.css";

const icons = { script: Icons.Text, captions: Icons.Captions, look: Icons.Look, sound: Icons.Sound,
  pace: Icons.Transitions, clips: Icons.Clips, search: Icons.Search };

/** CH2: tool panels only (keys 1 to 6) and Search. Claude has its own pane at the window's right edge. */
export function Rail({ panel, onToggle }: { panel: EditsPanel | null; onToggle: (panel: EditsPanel) => void }) {
  const button = (entry: typeof EDIT_PANELS[number]) => {
    const Icon = icons[entry.id];
    return <Tile key={entry.id} type="button" aria-label={entry.label} aria-pressed={panel === entry.id}
      aria-controls="edits-sheet" title={`${entry.label} (${entry.key})`} onClick={() => onToggle(entry.id)}
      className={`edits-rail-button ${FOCUS}`}>
      <span className="edits-rail-icon"><Icon size={18} /></span><span className="edits-rail-label">{entry.label}</span>
    </Tile>;
  };
  return <nav aria-label="Edit tools" data-edits-rail className="edits-rail">
    <div className="edits-rail-scroll">{EDIT_PANELS.filter(entry => entry.id !== "search").map(button)}</div>
    <div className="edits-rail-search">{EDIT_PANELS.filter(entry => entry.id === "search").map(button)}</div>
  </nav>;
}
