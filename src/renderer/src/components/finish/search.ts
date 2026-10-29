import { EDIT_PANELS, type EditsPanel } from "../../hooks/useShortcuts";
import type { Cut,Shoot } from "../../../../shared/schema";
export const INSPECTOR_TABS = ["Edit", "Look", "Captions", "Sound", "Ask"] as const;
export type InspectorTab = typeof INSPECTOR_TABS[number];
export type ControlEntry = { id: string; tab: InspectorTab; panel: string; label: string; synonyms: string; selector?: string; path: string };
/** RAIL1: null means the control is not on the rail: Cover opens from the Export sheet. Layout lives in Clips. */
export function panelForControl(entry: Pick<ControlEntry, "panel" | "tab">): EditsPanel | null {
  if (["piece", "framing", "transform", "overlays", "layout", "footage"].includes(entry.panel)) return "clips";
  // SCRIPT1: the transcript and the voiceover are one Script document.
  if (entry.panel === "transcript" || entry.panel === "voiceover") return "script";
  if (entry.panel === "cover") return null;
  return entry.tab === "Look" ? "look" : entry.tab === "Captions" ? "captions" : entry.tab === "Sound" ? "sound" : entry.tab === "Ask" ? "ask" : "pace";
}
const entries: ControlEntry[] = [];
function group(tab: InspectorTab, panel: string, label: string, synonyms = "", controls: [string, string, string?, string?][] = []) {
  const destination = panelForControl({ panel, tab });
  const sheet = destination ? EDIT_PANELS.find(entry => entry.id === destination)!.label : "Export";
  const path = `${sheet} › ${label}`;
  entries.push({ id: panel, tab, panel, label, synonyms, path });
  controls.forEach(([name, aria, aliases = "", selector = `[aria-label="${aria}"]`]) => entries.push({ id: `${panel}-${aria.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, tab, panel, label: name, synonyms: aliases, selector, path: `${path} › ${name}` }));
}
group("Edit", "piece", "Clip", "trim split swap take speed volume framing fillers remove", [["Speed", "Clip speed"], ["Volume", "Clip volume"], ["Trim in", "Piece in point"], ["Trim out", "Piece out point"], ["Swap take", "Swap take"], ["Framing", "Framing mode"], ["Layout", "Scene layout"]]);
group("Edit", "transform", "Transform", "straighten rotate level zoom scale position crop flip", [["Zoom", "Zoom"], ["Rotation", "Rotation"]]);
group("Edit", "transcript", "Transcript", "words remove restore correct text fillers um uh tighten pauses cut struck show cuts script");
group("Edit", "voiceover", "Voiceover", "record microphone mic take takes narration redo add a recording clean read teleprompter");
group("Edit", "layout", "Layout", "screen phone camera bubble custom corners radius padding gradient background swap", [["Layouts", "Scene layout"], ["Corner radius", "Corner radius"], ["Padding", "Padding"], ["Background", "Background source"]]);

group("Edit", "length", "Length", "duration target recut new version", [["Target seconds", "Target seconds"]]);
group("Edit", "cuts", "Transitions", "joins whoosh dissolve snap ease zoom whip ramp cut", [["Kind", "Transition kind"], ["Sound", "Transition sound"]]);
group("Edit", "framing", "Framing", "stabilise stabilize shake lock face steady", [["Mode", "Framing mode"], ["How close", "How close"]]);
group("Edit", "energy", "Energy", "rhythm subtle punchy");
group("Look", "histogram", "Histogram", "luma rgb clipping shadows highlights", [["Clipping preview", "Clipping preview"]]);
group("Look", "look", "Look", "film warm cool soft mono clean preset", [["Families", "Look families"], ["Gallery", "Look gallery"], ["Intensity", "Look intensity"]]);
group("Look", "adjust", "Adjust", "basics auto warmer cooler brighter darker reset match clips", [["Match all clips", "Match all clips"], ...["Exposure", "Contrast", "Highlights", "Shadows", "Whites", "Blacks", "Temperature", "Tint", "Vibrance", "Saturation"].map(label => [label, label, label === "Vibrance" ? "vibrancy vib" : ""] as [string, string, string])]);
group("Look", "cover", "Cover", "preview image thumbnail poster cover frame title automatic", [["Use current frame", "Use current frame"], ["Cover title", "Cover title"], ["Back to automatic", "Back to automatic"]]);
group("Look", "colour", "Colour mixer", "hsl color red orange yellow green aqua blue purple magenta", [["Bands", "Colour bands"], ["Hue", "Hue"], ["Saturation", "Saturation"], ["Luminance", "Luminance"], ["Overview", "Colour overview"]]);
group("Edit", "overlays", "Overlays", "image screenshot picture enter exit corners resize");
// RAIL1: the footage browser (Recently added, Matches, search) is Clips' Add more.
group("Edit", "footage", "Footage", "media library browse b-roll broll stills recently added matches add clip insert replace");
group("Captions", "captions", "Captions", "captions presets font size position case background animation outline emphasis key words save style", [["On or off", "Captions"], ["Presets", "Caption presets"], // The font picker names its value ("Font: Inter Display"), so its control is found by that label's start.
  ["Font", "Font", "", '[aria-label^="Font:"]'], ...["Size", "Position", "Words per line", "Case", "Background", "Animation", "Primary colour", "Accent colour", "Primary colour picker", "Accent colour picker", "Outline", "Emphasis"].map(label => [label, label] as [string, string])]);
group("Sound", "auto-mix", "Auto mix", "automatic audio mixing", [["Auto mix", "Auto mix"]]);
group("Sound", "audio", "Voice", "denoise noise eq equalizer natural warm clear broadcast", [["Clean up voice", "Clean up voice"], ["Strength", "Voice cleanup strength"], ["EQ presets", "Voice EQ presets"], ["Low", "Low"], ["Mid", "Mid"], ["High", "High"], ["Loudness target", "Loudness target"]]);
group("Sound", "sounds", "Sound effects", "sfx whoosh hit pop riser");
group("Sound", "music", "Music", "tracks folder add drop", [["Tracks", "Music tracks"], ["Choose folder", "Choose music folder"], ["Add tracks", "Add music tracks"], ["Drop tracks", "Drop music tracks"], ["Level", "Music volume"], ["Start at", "Music start at"], ["Ducking", "Duck under voice"], ["Cut to the music", "Cut to the music", "music rhythm beat sync"]]);

group("Captions", "caption-lines", "Caption lines", "words fix timing text transcript");
group("Sound", "loudness", "Loudness", "lufs true peak clipping measurement");
group("Ask", "ask", "Ask", "chat assistant conversation approval steps");
export const TAB_CONTROLS: Record<InspectorTab, readonly string[]> = {
  Edit: ["transcript", "voiceover", "length", "cuts", "energy", "framing", "overlays"],
  Look: ["histogram", "look", "adjust", "colour"], Captions: ["captions", "caption-lines"],
  Sound: ["auto-mix", "audio", "music", "sounds", "loudness"], Ask: ["ask"],
};
export function assertUniqueControls() {
  const ids = Object.values(TAB_CONTROLS).flat();
  if (new Set(ids).size !== ids.length || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Duplicate inspector control");
}
assertUniqueControls();
export const CONTROL_REGISTRY: readonly ControlEntry[] = entries;
export type SearchResult = { id: string; label: string; detail: string; control?: ControlEntry; cutId?: string; version?: number; clipId?: string; time?: number; piece?: number };
export function searchInspector(query: string, shoot?: Shoot, cuts: Cut[] = [], activeCutId?: string, pieces: { clipId: string; timelineS?: number; s?: number; e?: number; lengthS?: number; removed?: { s: number; e: number }[] }[] = []): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  const results: SearchResult[] = CONTROL_REGISTRY.filter(entry => matches(`${entry.path} ${entry.synonyms}`)).map(entry => ({ id: entry.id, label: entry.path, detail: "Control", control: entry }));
  cuts.forEach(cut => { const latest = cut.versions.at(-1); const title = (cut as Cut & { title?: string }).title ?? latest?.title ?? cut.concept; if (matches(`${title} ${cut.concept}`)) results.push({ id: `edit-${cut.cutId}`, label: title, detail: "Edit", cutId: cut.cutId, version: latest?.version }); });
  shoot?.clips.forEach(clip => {
    const piece = pieces.findIndex(piece => piece.clipId === clip.id);
    const destination = { clipId: clip.id, ...(piece >= 0 && activeCutId ? { cutId: activeCutId, piece, time: pieces[piece].timelineS ?? 0 } : {}) };
    if (matches(`${clip.file} ${clip.id}`)) results.push({ id: `clip-${clip.id}`, label: clip.file, detail: "Clip", ...destination });
    clip.transcript?.forEach((segment, index) => {
      const text = segment.words.map(word => word.w).join(" ");
      if (!matches(text)) return;
      const word = segment.words.find(word => matches(word.w)) ?? segment.words[0];
      const pieceIndex = word ? pieces.findIndex(piece => piece.clipId === clip.id && piece.s !== undefined && piece.e !== undefined && word.s >= piece.s && word.s < piece.e && !piece.removed?.some(gap => word.s >= gap.s && word.s < gap.e)) : -1;
      if (pieceIndex >= 0 && activeCutId && word) {
        const piece = pieces[pieceIndex], removed = piece.removed ?? [];
        const total = piece.e! - piece.s! - removed.reduce((sum, gap) => sum + gap.e - gap.s, 0);
        const elapsed = word.s - piece.s! - removed.filter(gap => gap.e <= word.s).reduce((sum, gap) => sum + gap.e - gap.s, 0);
        results.push({ id: `word-${clip.id}-${index}`, label: text, detail: "Transcript", clipId: clip.id, cutId: activeCutId, piece: pieceIndex, time: (piece.timelineS ?? 0) + elapsed * (total > 0 ? (piece.lengthS ?? total) / total : 1) });
      } else results.push({ id: `word-${clip.id}-${index}`, label: text, detail: "Transcript", clipId: clip.id, time: word?.s ?? 0 });
    });
  });
  return results;
}
/** Stamp existing controls, including controls shared with Settings, from one registry. */
export function markControlTargets(root: HTMLElement, panel: string) {
  const host = root.querySelector<HTMLElement>(`[data-control="${panel}"]`);
  CONTROL_REGISTRY.filter(entry => entry.panel === panel && entry.selector).forEach(entry => {
    const element = host?.querySelector?.<HTMLElement>(entry.selector!) ?? root.querySelector<HTMLElement>(entry.selector!);
    if (element?.dataset) element.dataset.control = entry.id;
  });
}
