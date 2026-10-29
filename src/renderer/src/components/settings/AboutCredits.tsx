// ONB2: in Settings, About. Credits for the starter music (CC BY 4.0 asks for them) and where the bundled sounds come from.
import { useEffect, useState } from "react";
import type { StarterTrack } from "../../../../shared/schema";
import { getApi } from "../../data";
import { SectionHeader } from "../ui";

export function AboutCredits() {
  const [tracks, setTracks] = useState<StarterTrack[]>([]);
  useEffect(() => { let alive = true; void getApi().starterMusic?.().then(value => { if (alive) setTracks(value.tracks); }).catch(() => {}); return () => { alive = false; }; }, []);
  return <div data-about className="space-y-2">
    <SectionHeader as="h3" className="text-small font-medium">Music and sounds</SectionHeader>
    {tracks.length > 0 && <div className="space-y-1"><p className="m-0 text-micro font-medium text-ink">Starter music</p>
      <ul className="m-0 list-none space-y-1 p-0">{tracks.map(track => <li key={track.file} data-credit={track.title} className="text-micro text-muted">{track.credit}</li>)}</ul>
      <p className="m-0 text-micro text-muted">An export that uses one of these adds its credit to the export folder, ready for your post.</p></div>}
    <p className="m-0 text-micro text-muted">Sound effects: Kenney's Impact and Interface Sounds (CC0), and sounds made for precut by sidething.</p>
  </div>;
}
