import { InfoLabel, CONTROL_TIPS } from "../ui/InfoTip";
import type { ReactNode } from "react";
import type { AudioFinish, CutVersion, DraftTimeline } from "../../../../shared/schema";
import { Row, Switch, SectionHeader } from "../ui";
import { Slider, VoiceEq } from "./Controls";
import { MusicPanel, type MusicChoice } from "./MusicPanel";
import { ClipFinishControls } from "./ToolPanels";

export function autoMixReason(version: CutVersion) {
  if (!version.audio || version.audio.auto === false) return null;
  if(version.audio.evenOutVoices===false)return version.audio.clean ? "precut cleaned the camera audio" : null;
  return version.audio.clean
    ? "precut cleaned the camera audio and levelled your voice"
    : "precut levelled your voice";
}
export function renderSoundControl({ id, controlId = "sound", version, timeline, auto, evenOutVoices, clean, strength, eq, target, breaths, loudnessRange = [-24, -9], music, cutToBeat, onChange, onNames, onDefault, sounds }: {
  id: string; controlId?: string; version?: CutVersion; timeline?: DraftTimeline | null;
  auto: boolean; evenOutVoices?: boolean; clean: boolean; breaths?: boolean; loudnessRange?: [number, number]; strength: number; eq: NonNullable<AudioFinish["eq"]>; target: number;
  music: MusicChoice; cutToBeat: boolean;
  onChange: (patch: { auto?: boolean; evenOutVoices?: boolean; clean?: boolean; strength?: number; eq?: NonNullable<AudioFinish["eq"]>; target?: number; breaths?: boolean; music?: MusicChoice; cutToBeat?: boolean }) => void;
  onNames: (names: Record<string, string>) => void; onDefault: ReactNode; sounds: ReactNode;
}) {
  const reason = version ? autoMixReason(version) : null, measured = timeline?.loudness;
  const liveMusic = timeline?.liveSound?.music;
  const currentArrangement = liveMusic?.arrangementSource === music?.file && !!liveMusic?.followStory === !!music?.followStory ? liveMusic : null;
  const plan = version?.cutMusicPlan;
  const planSummary = plan?.piecesSignature === JSON.stringify(version?.pieces?.map(p=>[p.clipId,p.s,p.e,p.timelineS,p.lengthS]) ?? []) ? plan.summary : null;
  if (id === "auto-mix") return <div className="space-y-2"><Row className="gap-3"><span className="font-semibold"><InfoLabel label="Auto mix" htmlFor={`${controlId}-auto-mix`}>{CONTROL_TIPS.mix}</InfoLabel></span><Switch id={`${controlId}-auto-mix`} aria-label="Auto mix" checked={auto} onChange={event => onChange({ auto: event.target.checked })} /></Row>{reason ? <p className="text-[11px] text-muted">{reason}</p> : null}</div>;
  if (id === "audio") return <div className="space-y-2"><Row as="label"><span>Even out voices</span><Switch aria-label="Even out voices" checked={evenOutVoices ?? auto} onChange={event=>onChange({evenOutVoices:event.target.checked})} /></Row><Row as="label"><span>Clean up voice</span><Switch aria-label="Clean up voice" checked={clean} onChange={event => onChange({ clean: event.target.checked })} /></Row><Slider label="Voice cleanup strength" value={strength} min={0} max={1} step={.01} defaultValue={.6} disabled={!clean} onChange={strength => onChange({ strength })} /><VoiceEq value={eq} onChange={eq => onChange({ eq })} /><Slider label="Loudness target" min={loudnessRange[0]} max={loudnessRange[1]} step={1} unit=" LUFS" defaultValue={-14} value={target} onChange={target => onChange({ target })} />{onDefault}</div>;
  if (id === "breaths") return <Row as="label"><span>Breath cleanup</span><Switch aria-label="Breath cleanup" checked={breaths !== false} onChange={event => onChange({ breaths: event.target.checked })} /></Row>;
  if (id === "music") return <><MusicPanel editS={timeline?.durationS ?? version?.lengthS} value={music} onChange={music => onChange({ music, ...(!music ? { cutToBeat: false } : {}) })} cutToBeat={cutToBeat} onCutToBeat={cutToBeat => onChange({ cutToBeat })} onNames={onNames} showBeat={true} arrangementState={currentArrangement?.arrangementState} arrangementSummary={currentArrangement?.arrangementSummary} />{cutToBeat && planSummary ? <p role="status" className="mt-2 text-micro text-muted">{planSummary}</p> : null}</>;
  if (id === "sounds") return <>{sounds}</>;
  if (id === "loudness") return measured ? <p role="status" className="text-[12px] text-muted">Loudness {measured.lufs.toFixed(1)} LUFS · True peak {measured.truePeakDb.toFixed(1)} dBTP · Target {measured.target} LUFS</p> : null;
  return null;
}
export function SoundPanel({ renderControl, action, ...clip }: {
  renderControl: (id: string) => ReactNode; action: ReactNode;
} & React.ComponentProps<typeof ClipFinishControls>) {
  if (clip.index != null) return <ClipFinishControls {...clip} mode="sound" />;
  return <SoundCards renderControl={renderControl} action={action} />;
}
export function SoundCards({ renderControl, action, controls = ["auto-mix", "audio", "breaths", "music", "sounds", "loudness"] }: {
  renderControl: (id: string) => ReactNode; action?: ReactNode; controls?: string[];
}) {
  return <div className="space-y-2.5 pt-1">{controls.map(id => <section key={id} data-control={id} className={id === "loudness" ? "px-1" : "space-y-2 rounded-xl bg-ink/[0.035] px-3 py-2.5"}>{!["auto-mix", "loudness"].includes(id) ? <SectionHeader as="h3" className="text-[12px] font-semibold">{id === "audio" ? "Voice" : id === "breaths" ? "Breaths" : id === "music" ? "Music" : "Sound effects"}</SectionHeader> : null}{renderControl(id)}</section>)}{action}</div>;
}
