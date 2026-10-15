import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play } from "@phosphor-icons/react";
import type { Cut, CutVersion, Shoot, Skill, Template } from "../../../shared/schema";
import { formatDuration, frameAt, getApi, plainClipNames } from "../data";
import { Button, FOCUS, Img } from "./ui";

interface Piece {
  id: string; clipId: string; s: number; e: number; label: string; words: string; broll?: boolean;
  lengthS?: number; timelineS?: number; beatSnapS?: number; overlays?: Piece[];
}
function pieceLabel(id: string): string {
  const match = /^L(\d+)A(\d+)$/i.exec(id);
  return match ? `Line ${match[1]} · take ${match[2]}` : id;
}
function voicePiece(shoot: Shoot, id: string): Piece {
  const match = /^L(\d+)A(\d+)$/i.exec(id);
  const take = match ? shoot.takes.find((take) => take.lineIndex === Number(match[1]) - 1) : undefined;
  const attempt = match ? take?.attempts[Number(match[2]) - 1] : undefined;
  return { id, clipId: attempt?.clipId ?? "", s: attempt?.s ?? 0, e: attempt?.e ?? 0, label: pieceLabel(id), words: attempt?.text || "This take is no longer in the shoot." };
}
// B-roll ids enumerate usable moments in shoot order, including multiple
// spans of one source. Older fixture indexes spell the kind “b-roll”.
function brollPieces(shoot: Shoot): Piece[] {
  return shoot.clips.flatMap((clip) => {
    const judgement = clip.judgement;
    if (!judgement || !(String(judgement.kind).replace("-", "") === "broll" || (judgement.verdict === "maybe" && /b-?roll/i.test(judgement.summary)))) return [];
    const spans = judgement.usableSpans.length ? judgement.usableSpans : [[0, clip.meta?.durationS ?? 0]];
    return spans.map(([s, e]) => ({ id: "", clipId: clip.id, s, e, label: "B-roll", words: judgement.summary, broll: true }));
  }).map((piece, index) => ({ ...piece, id: `B${index + 1}` }));
}
function storyboard(shoot: Shoot, version: CutVersion): { pieces: Piece[]; unknownPositions: boolean; unattached: string[] } {
  if (version.pieces !== undefined) return {
    pieces: version.pieces.map((piece) => ({
      ...piece, label: pieceLabel(piece.id), broll: piece.kind === "broll",
      words: (piece.kind === "voice" ? piece.words : piece.description) ?? "",
      overlays: piece.overlay ? [{ ...piece.overlay, label: "B-roll", words: piece.overlay.description ?? "", broll: true }] : [],
    })),
    unknownPositions: false, unattached: [],
  };
  // Only old versions without resolved pieces need the historical id mapping.
  const broll = brollPieces(shoot);
  const findBroll = (id: string): Piece => broll.find((piece) => piece.id === id) ?? { id, clipId: "", s: 0, e: 0, label: "B-roll", words: "This b-roll moment is no longer in the shoot.", broll: true };
  const voices = version.voice.map((id) => ({
    ...(/^B\d+$/.test(id) ? findBroll(id) : voicePiece(shoot, id)),
    overlays: version.broll.filter((overlay) => overlay.over === id).map((overlay) => findBroll(overlay.id)),
  }));
  const standalone = version.broll.filter((piece) => !piece.over).map((piece) => findBroll(piece.id));
  return { pieces: [...voices, ...standalone], unknownPositions: standalone.length > 0,
    unattached: version.broll.filter((piece) => piece.over && !version.voice.includes(piece.over)).map((piece) => piece.id) };
}
export function cutPoster(shoot: Shoot, version: CutVersion): string | null {
  const first = storyboard(shoot, version).pieces[0];
  const visible = first?.overlays?.[0] ?? first;
  return visible ? frameAt(shoot, visible.clipId, visible.s) : null;
}
function Thumbnail({ shoot, piece, small = false }: { shoot: Shoot; piece: Piece; small?: boolean }) {
  const src = frameAt(shoot, piece.clipId, piece.s);
  const className = `${small ? "h-9 w-14" : "h-14 w-[88px]"} shrink-0 rounded-lg object-cover`;
  return src ? <Img src={src} alt="" className={className} loading="lazy" /> : <span aria-hidden="true" className={`${className} bg-ink/[0.06]`} />;
}
// The saved version's format reserves the card; media metadata is authoritative.
export function cutAspect(cut: Cut, version: CutVersion, skills: Skill[], templates: Template[]): number {
  const template = templates.find((entry) => entry.id === version.templateId);
  if (template && template.width > 0 && template.height > 0) return template.width / template.height;
  const format = skills.find((skill) => cut.skillIds.includes(skill.id) && !skill.global && skill.format)?.format
    ?? skills.find((skill) => skill.global)?.format;
  return format && format.width > 0 && format.height > 0 ? format.width / format.height : 16 / 9;
}

export function CutPreview({ src, poster, label, focused, onAspect, children }: {
  src: string | null; poster?: string | null; label: string; focused: boolean;
  onAspect?: (aspect: number) => void; children?: ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!focused) element?.pause();
    return () => { element?.pause(); };
  }, [focused, src]);
  return <div data-cut-player className="relative h-full w-full overflow-hidden rounded-2xl bg-black/90">
    {src && !failed ? <video ref={video} src={src} poster={poster ?? undefined} playsInline preload="metadata"
      onLoadedMetadata={(event) => {
        const element = event.currentTarget;
        if (element.videoWidth > 0 && element.videoHeight > 0) onAspect?.(element.videoWidth / element.videoHeight);
        setDuration(Number.isFinite(element.duration) ? element.duration : 0);
        // Decode the rendered preview's first frame without starting playback.
        // The source thumbnail above is only a fallback while this loads.
        element.currentTime = 0;
      }} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
      onPlay={(event) => { if (!focused) event.currentTarget.pause(); else setPlaying(true); }}
      onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setFailed(true)}
      className="absolute inset-0 h-full w-full object-contain" aria-label={label} />
      : poster ? <Img src={poster} alt="" className="h-full w-full object-cover" /> : null}
    {(!src || failed) ? <p role="status" className="absolute inset-0 flex items-center justify-center px-4 text-center text-[12px] leading-relaxed text-white/70">{failed ? "Couldn't load the preview. The timeline is still available." : "No preview yet. The timeline is still available."}</p> : null}
    {focused && src && !failed ? <>
      <button type="button" aria-label={playing ? `Pause ${label}` : `Play ${label}`} onClick={() => {
        const element = video.current;
        if (!element || !focused) return;
        if (element.paused) { setError(false); void element.play().catch(() => setError(true)); }
        else element.pause();
      }} className={`absolute bottom-3 left-3 flex size-10 items-center justify-center rounded-full bg-black/70 text-white ${FOCUS}`}>
        {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
      </button>
      {duration > 0 ? <input type="range" min={0} max={duration} step="any" value={Math.min(time, duration)} aria-label={`Seek ${label}`} onChange={(event) => { if (video.current) video.current.currentTime = Number(event.target.value); }} className={`absolute bottom-6 left-16 h-1 w-[calc(100%-80px)] accent-white ${FOCUS}`} /> : null}
      {error ? <p role="alert" className="absolute inset-x-0 top-0 bg-black/70 p-2 text-center text-[11px] text-white">Couldn't play the preview. Try play again.</p> : null}
    </> : null}
    {children}
  </div>;
}

export function CutView({ shoot, cut, version }: { shoot: Shoot; cut: Cut; version: number }) {
  const selected = cut.versions.find((entry) => entry.version === version) ?? cut.versions.at(-1);
  if (!selected) return <p className="text-[13px] text-muted">This cut has no versions yet.</p>;
  return <div data-cut-view><VersionContent key={`${cut.cutId}-${selected.version}`} shoot={shoot} cut={cut} version={selected} /></div>;
}
function VersionContent({ shoot, cut, version }: { shoot: Shoot; cut: Cut; version: CutVersion }) {
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(cut.exported.find((entry) => entry.version === version.version)?.folder ?? null);
  const [error, setError] = useState<string | null>(null);
  const { pieces, unknownPositions, unattached } = storyboard(shoot, version);
  async function exportVersion() {
    if (exporting) return;
    setExporting(true); setError(null);
    try { const result = await getApi().exportCut(shoot.root, cut.cutId, version.version); setExported(result.folder); }
    catch { setError("Couldn't export this version. Check the shoot's drive is connected, then try again."); }
    finally { setExporting(false); }
  }
  return <div data-cut-details aria-label="Cut details" className="min-w-0 space-y-6">
      <div>
        <p className="tnum text-[16px] font-medium text-ink">{formatDuration(version.lengthS)} <span className="text-[12px] font-normal text-muted">/ {cut.targetLengthS} s target</span></p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink">{plainClipNames(version.why)}</p>
        {version.feedback ? <p className="mt-2 text-[12px] leading-relaxed text-muted">Your note: {version.feedback}</p> : null}
      </div>
    <section aria-label="Storyboard">
      <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-[13px] font-medium text-ink">Storyboard</h3><span className="text-[11.5px] text-muted">{pieces.length} pieces</span></div>
      <ol className="space-y-1">
        {pieces.map((piece, index) => <li key={`${piece.id}-${index}`} data-storyboard-row className="rounded-xl bg-ink/[0.025] px-3 py-3.5">
          <div className="flex items-start gap-3.5"><Thumbnail shoot={shoot} piece={piece} /><div className="min-w-0 flex-1"><p className="text-[11px] text-muted">{String(index + 1).padStart(2, "0")} · {piece.broll ? "B-roll-led" : piece.label}</p><p className="mt-1.5 text-[13px] leading-relaxed text-ink">{piece.words}</p>{piece.timelineS !== undefined ? <p className="tnum mt-1 text-[11px] text-muted">At {formatDuration(piece.timelineS)}</p> : piece.broll && unknownPositions ? <p className="mt-1 text-[11px] text-muted">Standalone · position not supplied</p> : null}{(piece.beatSnapS ?? 0) > 0 ? <span className="mt-1 inline-block text-[10.5px] font-medium text-accent" title={`Cut moved ${piece.beatSnapS!.toFixed(2)} s onto the beat`}>on the beat</span> : null}</div><span className="tnum shrink-0 text-[11px] text-muted">{formatDuration(piece.lengthS ?? piece.e - piece.s)}</span></div>
          {piece.overlays?.map((covering, i) => <div key={`${covering.id}-${i}`} className="mt-3 flex items-center gap-3 rounded-xl bg-ink/[0.04] p-2.5"><Thumbnail shoot={shoot} piece={covering} small /><div><p className="text-[11px] font-medium text-accent">B-roll over this line</p><p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{covering.words}</p></div></div>)}
        </li>)}
      </ol>
      {unknownPositions ? <p className="mt-2 text-[11.5px] leading-relaxed text-muted">Voice rows follow play order. Standalone b-roll is listed after them because this cut doesn't record its position.</p> : null}
      {unattached.length ? <p role="status" className="mt-2 text-[12px] text-muted">B-roll {unattached.join(", ")} refers to a line outside this version.</p> : null}
      <div className="mt-3 rounded-xl bg-ink/[0.04] px-4 py-3" aria-label="Music bar"><p className="text-[12px] font-medium text-ink">Music · {version.music ? version.music.file.split(/[\\/]/).pop() : "No music"}</p>{version.music ? <p className="tnum mt-1 text-[11.5px] text-muted">Start {formatDuration(version.music.startS)} · {version.music.gainDb !== undefined ? `Gain ${version.music.gainDb} dB` : "Gain not supplied by this cut"}</p> : null}</div>
    </section>
    {version.warnings.length ? <section><h3 className="text-[12px] font-medium text-muted">Worth knowing</h3><ul className="mt-2 space-y-2 text-[13px] leading-relaxed text-ink">{version.warnings.map((warning, i) => <li key={i}>{plainClipNames(warning)}</li>)}</ul></section> : null}
    {version.missing.length ? <section><h3 className="text-[12px] font-medium text-muted">To film</h3><ul className="mt-2 space-y-2">{version.missing.map((shot, i) => <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink"><span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted/50" />{shot}</li>)}</ul></section> : null}
    <div className="pt-1">
      <Button variant="primary" onClick={() => void exportVersion()} disabled={exporting}>{exporting ? `Exporting v${version.version}…` : "Export to Resolve"}</Button>
      <p className="mt-2 text-[11.5px] text-muted">Version {version.version} · timeline, clips and notes in one folder.</p>
      {exported ? <div role="status" className="mt-4"><p className="break-all text-[12px] text-muted">{exported}</p><button onClick={() => { void getApi().revealInFinder(exported).catch(() => setError("Couldn't reveal the folder. You can open the path above in Finder.")); }} className={`mt-2 rounded text-[13px] text-accent ${FOCUS}`}>Reveal in Finder</button></div> : null}
      {error ? <p role="alert" className="mt-3 text-[13px] text-ink">{error}</p> : null}
    </div>
  </div>;
}
