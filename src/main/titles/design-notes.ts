/** 0.7.1: the caption changes that wait on the model. `label` names the work while it runs (the edit's activity, so the
 * status line and the Captions panel say the same words); `note` is the plain note its track keeps when the model
 * couldn't answer (shown in Captions with Retry). Renderer safe: no Node imports. */
export const CAPTION_DESIGN = {
  emphasis: { label: "Choosing the key words", note: "Couldn't choose the key words for Emphasis. Try it again in a moment." },
  opening: { label: "Designing your opening line", note: "Couldn't design the opening caption. Change a caption setting to try again." },
  big: { label: "Designing your big caption lines", note: "Couldn't design the big caption lines. Change a caption setting to try again." },
} as const;
export type CaptionDesign = keyof typeof CAPTION_DESIGN;

/** Which design a running activity label or a track note names, if any. */
export const captionDesignOfLabel = (label: string | null | undefined) =>
  (Object.keys(CAPTION_DESIGN) as CaptionDesign[]).find(kind => CAPTION_DESIGN[kind].label === label) ?? null;
export const captionDesignOfNote = (note: string | null | undefined) =>
  (Object.keys(CAPTION_DESIGN) as CaptionDesign[]).find(kind => CAPTION_DESIGN[kind].note === note) ?? null;
