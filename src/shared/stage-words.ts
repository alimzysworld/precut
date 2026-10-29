import type { ProcessingStageId } from "./schema";

/** FIX6: the words a failed stage says, in plain language. The status line and the Mac notification both read these. */
export const STAGE_FAILED_TEXT: Record<ProcessingStageId, string> = { index: "Couldn't read your footage.", transcribe: "Couldn't transcribe your footage.",
  group: "Couldn't check your takes.", judge: "Couldn't check your takes.", ideas: "Couldn't find ideas.", drafts: "Couldn't make your edits." };

/** ONB2: a stage that needs the person's AI and has none to use. Calm, never a failure: the stage is "skipped" with
 * this detail, so the shoot still ends ready to edit by hand. */
export const STAGE_NEEDS_AI = "Needs your AI";
export const needsAi = (stage: { state: string; detail: string | null } | undefined | null) => stage?.state === "skipped" && stage.detail === STAGE_NEEDS_AI;
