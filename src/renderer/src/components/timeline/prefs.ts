import { useEffect, useState } from "react";
import { getApi } from "../../data";

/** VO7-13: the timeline's remembered toggles, Snapping and Close gaps, kept in Settings' preferences (so the
 * MCP's voice remove reads the same Close gaps default). One store for the timeline's toolbar, the Delete keys
 * and the Text panel's Delete. Both are on until he turns them off. */
/** VO7-14: audioScrub, hear the edit while dragging the playhead on the ruler (Shift+S), on until turned off. */
export type TimelinePrefs = { snapping: boolean; closeGaps: boolean; audioScrub: boolean };
const DEFAULTS: TimelinePrefs = { snapping: true, closeGaps: true, audioScrub: true };
let value: TimelinePrefs = DEFAULTS, requested = false, touched = false;
const listeners = new Set<() => void>();
const emit = () => { for (const listen of listeners) listen(); };
function load() {
  if (requested) return;
  requested = true;
  void Promise.resolve().then(() => getApi().getPreferences()).then(prefs => {
    // A toggle pressed before the read came back wins over what was stored.
    if (touched) return;
    value = { ...DEFAULTS, ...prefs.timeline };
    emit();
  }).catch(() => { /* the defaults stay */ });
}
/** The toggles now, for key handlers that run outside a render. */
export function timelinePrefs(): TimelinePrefs { load(); return value; }
export function setTimelinePref(patch: Partial<TimelinePrefs>) {
  touched = true;
  value = { ...value, ...patch };
  emit();
  void Promise.resolve().then(() => getApi().setPreferences({ timeline: value })).catch(() => { /* kept for this session */ });
}
const subscribe = (listen: () => void) => { listeners.add(listen); return () => { listeners.delete(listen); }; };
export function useTimelinePrefs(): TimelinePrefs {
  load();
  const [, rendered] = useState(value);
  useEffect(() => { rendered(value); return subscribe(() => rendered(value)); }, []);
  return value;
}
