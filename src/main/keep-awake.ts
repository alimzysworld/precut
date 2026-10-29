// ONB2: keep the Mac awake while precut reads a shoot or exports, and let it sleep again the moment that work ends
// or fails. One Electron power-save blocker ("prevent-app-suspension": the screen may still dim and lock), held only
// while such an activity is running. The waiting room says so in one line, from keepingAwake().
import { powerSaveBlocker } from "electron";
import { listActivity } from "./activity";
import type { Activity } from "../shared/schema";

const KEEPS_AWAKE: ReadonlySet<Activity["kind"]> = new Set(["process", "judge", "export"]);
let blocker: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function keepingAwake(): boolean { return blocker !== null && powerSaveBlocker.isStarted(blocker); }

export async function syncKeepAwake(): Promise<void> {
  const busy = (await listActivity().catch(() => [] as Activity[])).some(a => a.state === "running" && KEEPS_AWAKE.has(a.kind));
  if (busy && !keepingAwake()) {
    blocker = powerSaveBlocker.start("prevent-app-suspension");
    console.info("[keep-awake] holding: reading or exporting");
  } else if (!busy && blocker !== null) {
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
    blocker = null;
    console.info("[keep-awake] released");
  }
}

export function startKeepAwake(): void {
  if (timer) return;
  timer = setInterval(() => { void syncKeepAwake(); }, 2_000);
  timer.unref?.();
}
