import { useEffect, useState } from "react";
import type { ResourceState } from "../../../shared/schema";
import { getApi } from "../data";

/** PERF1: the popover line when precut is holding back for heat, battery or playback. Never alarming. */
export function calmLine(state: ResourceState): string | null {
  if (state.mode === "full") return null;
  if (state.reason === "busy") return "Taking it easy while you watch";
  if (state.reason === "warm") return "Taking it easy: your Mac is warm";
  if (state.reason === "battery") {
    if (state.batteryContext === "background") return "On battery: going easy while precut is in the background";
    if (state.batteryContext === "low-power") return "Going easy: Low Power Mode is on";
    if (state.batteryContext === "low") return "On battery: going easy at 30% or less";
    if (state.batteryContext === "preparation") return "On battery: going easy on background prep";
    return "Taking it easy to save battery";
  }
  return "Taking it easy";
}

export function useResourceState(): ResourceState {
  const [state, setState] = useState<ResourceState>({ mode: "full", reason: null });
  useEffect(() => {
    let live = true;
    const api = getApi();
    void api.getResourceState().then(next => { if (live) setState(next); }).catch(() => {});
    const off = api.onResourceState(next => { if (live) setState(next); });
    return () => { live = false; off(); };
  }, []);
  return state;
}

/** Tells the main process when the person is playing or dragging a slider, so background work steps back. */
export function useBusyReporter(): void {
  useEffect(() => {
    const api = getApi();
    let playing = false, dragging = false, sent = false;
    const send = () => {
      const busy = playing || dragging;
      if (busy === sent) return;
      sent = busy; void api.reportBusy(busy).catch(() => {});
    };
    const onPlaying = (event: Event) => { playing = !!(event as CustomEvent<boolean>).detail; send(); };
    const slider = (target: EventTarget | null) => target instanceof Element && !!target.closest('input[type="range"], [role="slider"], [data-scrub]');
    const down = (event: PointerEvent) => { if (slider(event.target)) { dragging = true; send(); } };
    const up = () => { if (dragging) { dragging = false; send(); } };
    window.addEventListener("sidething:playing", onPlaying);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("sidething:playing", onPlaying);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      if (sent) void api.reportBusy(false).catch(() => {});
    };
  }, []);
}
