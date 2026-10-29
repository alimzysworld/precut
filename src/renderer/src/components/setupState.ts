// ONB1: the pure first-run rules, kept apart from the screen so tests can run them alone.
// ONB2: the first run is welcome, AI (optional), terminal, music, where you post, editors, look. Nothing blocks.
import type { Engine, FirstRunDownloads, SetupCheck } from "../../../shared/schema";
import { formatPercent } from "./processingFormat";
import { DOWNLOAD_SIZES, DOWNLOAD_STALLED } from "../../../shared/first-run";
export { PRIVACY_COPY } from "./privacy";
export { DOWNLOAD_SIZES };

export const CHECK_NAMES = ["ffmpeg", "engine", "venv", "python"] as const;

// A fixed setup state machine; exported for isolated unit tests. Only the engine the person
// picked has to be ready; the tools and the speech model download in the background.
export function setupAction(checks: SetupCheck[] | null): "install" | "login" | "continue" | null {
  if (!checks || !CHECK_NAMES.every(id => checks.some(check => check.id === id))) return null;
  const engine = checks.find(check => check.id === "engine");
  if (engine?.fix === "none") return "continue";  // ONB2: Start without AI
  if (engine?.fix === "install") return "install";
  if (!engine?.ok) return "login";
  return checks.every(check => !check.required || check.ok) ? "continue" : null;
}

export const ENGINE_CHOICES: { id: Engine; label: string }[] = [
  { id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }, { id: "muse", label: "Muse" }];

export const SETUP_STEPS = ["welcome", "ai", "terminal", "music", "post", "editors", "look"] as const;
export type SetupStep = typeof SETUP_STEPS[number];

/** ONB2: one engine tile's one action. Phases are what the person started here (waiting, checking). */
export type EnginePill = "ready" | "signin" | "get" | "waiting" | "checking";
export function enginePill(item: { installed: boolean; signedIn: boolean | null } | undefined, id: Engine, phase?: "waiting" | "checking" | "ready"): EnginePill {
  if (phase === "checking") return "checking";
  if (phase === "ready") return "ready";
  if (!item?.installed) return phase === "waiting" ? "waiting" : "get";
  if (id === "muse" || item.signedIn === true) return "ready";
  return phase === "waiting" ? "waiting" : "signin";
}

/** The footer's one line: what downloads, how big, how far. No time left: the model lands in lumps (REL1). */
export function downloadLine(d: FirstRunDownloads | null): string {
  if (!d || d.state === "idle") return "";
  if (d.state === "ready") return "Tools and speech ready";
  if (d.state === "error") return d.message;
  if (d.message === DOWNLOAD_STALLED) return d.message;
  if (d.what === "speech") return `Getting speech ready · ${DOWNLOAD_SIZES.speech} · ${formatPercent(d.pct)}`;
  return `Getting precut tools · ${DOWNLOAD_SIZES.tools}`;
}
