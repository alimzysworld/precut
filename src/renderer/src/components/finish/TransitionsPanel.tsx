import { pieceName } from "../../../../shared/clip-name";
import { NamedMessage } from "../ClipNames";
import { useEffect, useRef, useState } from "react";
import type { CutEdit, CutVersion, DraftTimeline, JoinChoice, Shoot } from "../../../../shared/schema";
import { TransitionCut, Snap, Ease, Zoom, Whip, Dissolve, Ramp } from "../icons";
import { Button, Tile, FOCUS, InlineError } from "../ui";

const kinds = [["cut", "Cut", "Hard cut", TransitionCut], ["snap", "Snap", "Face lined up", Snap], ["ease", "Ease", "Face settles in", Ease], ["zoom", "Zoom", "Punch through", Zoom], ["whip", "Whip", "Fast pan", Whip], ["dissolve", "Dissolve", "Cross-fade", Dissolve], ["ramp", "Ramp", "Speed ramp", Ramp]] as const;
export function TransitionControls({ value, onChange, onPreview }: { value: JoinChoice; onChange: (value: JoinChoice) => void; onPreview?: () => void }) {
  return <div className="space-y-3" data-control="transitions"><div role="group" aria-label="Transition kind" className="grid grid-cols-3 gap-1.5">{kinds.map(([kind, label, description, Icon]) => <Tile type="button" key={kind} aria-pressed={value.kind === kind} onMouseEnter={onPreview} onFocus={onPreview} onClick={() => onChange({ ...value, kind })} className={`flex h-[70px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-[10px] ${value.kind === kind ? "bg-[var(--selection-fill)] text-[var(--accent)]" : "bg-ink/[0.035]"} ${FOCUS}`}><Icon size={20} /><span className="text-[12px]">{label}</span><span className="text-[10px] text-muted">{description}</span></Tile>)}</div><div className="space-y-1.5"><p className="font-semibold">Sound</p><div role="group" aria-label="Transition sound" className="flex flex-wrap gap-1">{["whoosh", "hit", "pop", "riser", "none"].map(sound => <Tile type="button" key={sound} aria-pressed={(value.sound ?? "none") === sound} onClick={() => onChange({ ...value, sound: sound === "none" ? null : sound as JoinChoice["sound"] })} className={`rounded-lg px-2.5 py-1.5 text-[12px] ${(value.sound ?? "none") === sound ? "bg-[var(--selection-fill)] text-[var(--accent)]" : "bg-ink/[0.035]"} ${FOCUS}`}>{sound[0].toUpperCase() + sound.slice(1)}</Tile>)}</div></div></div>;
}
export function TransitionsPanel({ shoot, version, index, timeline, onEdit, preview, value, onChange, action }: {
  shoot?: Shoot; version: CutVersion; index?: number | null; timeline?: DraftTimeline | null; onEdit?: (edit: CutEdit) => unknown; preview?: (at: number) => void;
  value?: JoinChoice; onChange?: (choice: JoinChoice) => void; action?: React.ReactNode;
}) {
  const join = timeline?.joins?.find(join => join.index === index);
  const initial = index != null ? version.joins?.[index] ?? join?.choice ?? version.transition ?? { kind: "cut" as const, sound: null } : value ?? version.transition ?? { kind: "cut" as const, sound: null };
  const [choice, setChoice] = useState(initial), [error, setError] = useState<string | null>(null);
  const pending = useRef(false), signature = useRef(JSON.stringify(initial));
  useEffect(() => { setChoice(initial); signature.current = JSON.stringify(initial); setError(null); }, [version.version, index, JSON.stringify(initial)]);
  async function commit(next: JoinChoice | null) {
    if (index == null || !onEdit || pending.current || JSON.stringify(next) === signature.current) return;
    pending.current = true; setError(null);
    try { await onEdit({ kind: "join", join: index, choice: next }); signature.current = JSON.stringify(next); setChoice(next ?? join?.choice ?? version.transition ?? { kind: "cut", sound: null }); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn't change this transition."); }
    finally { pending.current = false; }
  }
  return <div data-control="cuts" className="space-y-3 pt-1">{index != null ? <p className="text-[11px] text-muted"><NamedMessage>{`Changing the join after ${pieceName(shoot ?? { clips: [] }, version, index)} only.`}</NamedMessage></p> : null}<TransitionControls value={index != null ? choice : value ?? choice} onChange={next => index != null ? void commit(next) : onChange?.(next)} onPreview={join ? () => preview?.(join.atS) : undefined} /><p className="text-[11px] text-muted">{index != null ? "Hover a tile to play this join." : "Default for joins between talking lines. Joins into b-roll stay hard cuts unless you change them."}</p>{index != null ? <Button onClick={() => void commit(null)}>Automatic</Button> : action}{error ? <InlineError>{error}</InlineError> : null}</div>;
}
