import { useEffect, useState } from 'react';

// WR2: all five approved lines live here, in ETA order. No model call needed.
export const WAITING_LINES = [
  'Nearly there. Stretch your legs.',
  'Go make a coffee.',
  "Go for a walk. I've got this.",
  "Have a nap. I'll keep watching.",
  "Go to bed. It'll be ready in the morning.",
] as const;
export type WaitingBand = 0 | 1 | 2 | 3 | 4;
export const BAND_SETTLE_MS = 30_000;

export function waitingBand(etaS: number | null | undefined, hour: number): WaitingBand | null {
  if (etaS == null || !Number.isFinite(etaS) || etaS < 0) return null;
  if (hour >= 22 && etaS >= 30 * 60) return 4;
  return etaS < 3 * 60 ? 0 : etaS < 15 * 60 ? 1 : etaS < 45 * 60 ? 2 : 3;
}

export type BandState = { shown: WaitingBand | null; pending: WaitingBand | null; since: number };
export const emptyBand = (): BandState => ({ shown: null, pending: null, since: 0 });
/** A new band must remain the candidate for 30 continuous seconds. */
export function settleBand(state: BandState, next: WaitingBand | null, now: number): BandState {
  if (next === null) return state.shown === null && state.pending === null ? state : emptyBand();
  if (state.shown === null) return { shown: next, pending: null, since: 0 };
  if (state.shown === next) return state.pending === null ? state : { ...state, pending: null, since: 0 };
  if (state.pending !== next) return { ...state, pending: next, since: now };
  return now - state.since >= BAND_SETTLE_MS ? { shown: next, pending: null, since: 0 } : state;
}

export function useWaitingBreak(root: string | undefined, etaS: number | null | undefined, enabled: boolean, active: boolean) {
  const [value, setValue] = useState(() => ({ root, band: emptyBand() }));
  useEffect(() => {
    if (!active) return;
    const update = () => {
      const now = Date.now();
      const next = enabled ? waitingBand(etaS, new Date(now).getHours()) : null;
      setValue(previous => {
        const band = settleBand(previous.root === root ? previous.band : emptyBand(), next, now);
        return previous.root === root && previous.band === band ? previous : { root, band };
      });
    };
    update();
    // Also observes the local clock crossing 10pm without waiting for an ETA event.
    if (!enabled) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [root, etaS, enabled, active]);
  const band = enabled && value.root === root ? value.band.shown : null;
  return band === null ? null : WAITING_LINES[band];
}
