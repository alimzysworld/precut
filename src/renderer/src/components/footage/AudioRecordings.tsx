import { Tile } from "../ui";
import type { Shoot } from "../../../../shared/schema";
import { formatTimecode } from "../../data";
import { takeSoundSrc } from "../../pages/ShootTabs";
import { Badge } from "../ui";
export function AudioRecordings({ shoot }: { shoot: Shoot }) {
  return <div className="space-y-3">{shoot.audio.map(audio => {
    const matched = new Set([...(audio.clips ?? []), ...shoot.clips.filter(clip => clip.sound?.file === audio.file).map(clip => clip.id), ...(audio.syncedTo ? [audio.syncedTo.clipId] : [])]);
    return <Tile as="article" key={audio.file} className="rounded-xl bg-ground p-3">
      <div className="flex items-start gap-2"><span className="min-w-0 flex-1 break-all text-small font-medium">{audio.file}</span>{matched.size > 0 && <Badge tone="lime">Synced</Badge>}</div>
      <p className="mt-1 tnum text-micro text-muted">{Number.isFinite(audio.durationS) ? formatTimecode(audio.durationS) : "Duration not measured"}{audio.channels > 0 ? ` · ${audio.channels} ${audio.channels === 1 ? "channel" : "channels"}` : ""}</p>
      {matched.size > 0 && <p className="mt-2 text-micro text-muted">Matched to {matched.size} {matched.size === 1 ? "clip" : "clips"}</p>}
      <audio controls preload="none" src={takeSoundSrc(shoot.root, audio.file)} aria-label={`Play ${audio.file}`} className="mt-3 h-9 w-full" />
    </Tile>;
  })}</div>;
}
