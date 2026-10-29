import { clipName } from "../../../shared/clip-name";
import { EmptyState } from "./ui";
import { SectionHeader } from "./ui";
import { useEffect } from "react";
import { Microphone, Star } from "@phosphor-icons/react";
import type { CutEdit, Shoot } from "../../../shared/schema";
import { formatDuration, frameAt, proxySrc } from "../data";
import type { Piece } from "./edits/model";
import type { StageHandle } from "./Stage";
import { FOCUS } from "./ui";

export function TakeSwap({ shoot, piece, index, busy, onEdit, player, onPreviewInContext }: { onPreviewInContext?: (clipId: string, s: number, e: number) => void;
  shoot: Shoot; piece: Piece; index: number; busy: boolean;
  onEdit: (edit: CutEdit) => void; player: React.RefObject<StageHandle>;
}) {
  const line = /^L(\d+)A(\d+)$/i.exec(piece.id);
  const take = line ? shoot.takes.find((entry) => entry.lineIndex === Number(line[1]) - 1) : undefined;
  const takes = take?.attempts.map((attempt, attemptIndex) => ({ ...attempt, attemptIndex }))
    .sort((a, b) => Number(!!a.practice) - Number(!!b.practice)) ?? [];
  useEffect(() => () => player.current?.stopPreview(), [player]);
  return <div aria-label="Swap take">
    <SectionHeader as="h4" className="mb-2 font-medium">Swap take</SectionHeader>
    <ul className="space-y-1">
      {takes.filter(attempt => Number(line?.[2]) !== attempt.attemptIndex + 1).map((attempt) => {
        const current = Number(line?.[2]) === attempt.attemptIndex + 1;
        const clip = shoot.clips.find((entry) => entry.id === attempt.clipId);
        const poster = frameAt(shoot, attempt.clipId, attempt.s);
        const audition = () => { if (clip?.proxy) player.current?.preview(proxySrc(shoot.root, clip.proxy), attempt.s, attempt.e); };
        return <li key={attempt.attemptIndex} onMouseEnter={audition} onMouseLeave={() => player.current?.stopPreview()}
          className={`rounded-xl p-2 ${current ? "bg-ink/[0.1]" : "hover:bg-ink/[0.04]"} ${attempt.practice ? "opacity-50" : ""}`}>
          <div className="flex items-start gap-3">
            <button type="button" aria-label={`Preview take ${attempt.attemptIndex + 1}`} disabled={!clip?.proxy} onClick={audition} className={`shrink-0 rounded-lg ${FOCUS}`}>{poster ? <img src={poster} alt="" className="h-12 w-16 shrink-0 rounded-lg object-cover" /> : <span className="h-12 w-16 shrink-0 rounded-lg bg-ink/[0.06]" />}</button>
            <div className="min-w-0 flex-1"><p className="text-small font-medium">Take {attempt.attemptIndex + 1}{current ? " · in the cut" : ""}{take?.starred === attempt.attemptIndex ? " · starred" : ""}{attempt.practice ? " · practice" : ""}{take?.starred === attempt.attemptIndex ? <Star size={12} weight="fill" aria-label="Starred take" className="ml-1 inline text-accent" /> : null}</p>
              <p className="mt-1 flex flex-wrap items-center gap-1 text-micro text-muted">{formatDuration(attempt.e - attempt.s)} · <button type="button" className="text-accent underline decoration-transparent hover:decoration-current outline-none" disabled={!clip?.proxy} onClick={audition}>{clipName(clip, attempt)}</button> · <Microphone size={12} aria-hidden="true" />{clip?.sound ? "mic" : "camera mic"}</p>
              <p className="mt-1 text-small text-muted">{attempt.note || (take?.starred === attempt.attemptIndex ? take.why : "No judge note")}</p>
              {!attempt.practice && !current ? <button type="button" disabled={busy} onFocus={audition} onBlur={() => player.current?.stopPreview()} onClick={() => onEdit({ kind: "swap", piece: index, take: `L${line?.[1]}A${attempt.attemptIndex + 1}` })} className={`st-brand-gradient mt-2 rounded-full px-3 py-1.5 text-small font-medium text-white disabled:opacity-40 ${FOCUS}`}>Use this take</button> : null}
              {onPreviewInContext ? <button type="button" disabled={!clip?.proxy || busy} aria-label={`Play take ${attempt.attemptIndex + 1} in context`} onClick={() => onPreviewInContext(attempt.clipId, attempt.s, attempt.e)} className={`mt-2 block rounded-lg py-1 text-micro text-muted ${FOCUS}`}>Play in context</button> : null}
              {!clip?.proxy ? <p className="mt-1 text-micro text-muted">Preview unavailable</p> : null}
            </div>
          </div>
        </li>;
      })}
    </ul>
    {!takes.some(attempt => Number(line?.[2]) !== attempt.attemptIndex + 1) ? <EmptyState variant="inline" as="p" className="text-micro text-muted">No other takes of this line.</EmptyState> : null}
  </div>;
}
