import { AsyncLocalStorage } from "node:async_hooks";
import { CAPTION_DESIGN } from "./titles/design-notes";

/** 0.7.1: plain-words notes a render owes whoever asked for it, such as music arranged without the model's
 * story decision. An export collects them around its render and says them in its result. */
export const renderNotes = new AsyncLocalStorage<Set<string>>();

/** Notes a caption change leaves on its track when the model couldn't answer (shown in Captions), each mapped to
 * the line an export's result says. The export itself never asks a model. */
export const CAPTION_MODEL_NOTES: Record<string, string> = {
  [CAPTION_DESIGN.emphasis.note]: "Emphasis wasn't styled: couldn't get an answer from the model.",
  [CAPTION_DESIGN.opening.note]: "The opening caption is a plain line: couldn't get an answer from the model.",
  [CAPTION_DESIGN.big.note]: "Big caption lines show as plain lines: couldn't get an answer from the model.",
};

/** What an export of this track says about caption styling the model couldn't do. */
export function captionExportNotes(track: { warnings?: string[] } | null | undefined): string[] {
  return (track?.warnings ?? []).flatMap(note => Object.hasOwn(CAPTION_MODEL_NOTES, note) ? [CAPTION_MODEL_NOTES[note as keyof typeof CAPTION_MODEL_NOTES]] : []);
}
