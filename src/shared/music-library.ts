// V25: one deterministic catalog view for the panel and MCP. No model calls.
export interface LibraryTrack {
  file: string; name: string; durationS: number; bpm: number | null;
  tags?: Partial<Record<'title' | 'artist' | 'album' | 'genre' | 'comment', string>>;
  integratedLUFS?: number;
}
export interface MusicCatalog {
  tracks: LibraryTrack[]; total: number; completed: number; failed: number;
  measuring: boolean; etaS: number | null; error?: string;
}
export interface MusicQuery {
  query?: string; minS?: number; maxS?: number; minBpm?: number; maxBpm?: number;
  offset?: number; editS?: number; current?: string;
}
export const MUSIC_PAGE_SIZE = 20;
export const MUSIC_LENGTHS = ['Fits this edit', 'Under 0:30', '0:30 to 1:00', '1:00 to 2:00', 'Over 2:00'] as const;
export const MUSIC_TEMPOS = ['Slow', 'Mid', 'Fast'] as const;
export function musicGroupName(track: LibraryTrack) {
  // Download suffixes and explicit version suffixes in the licensed folder.
  let name = track.name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s+pr(?:\s*(?:\(\d+\)|\d+))?$/i, '');
  let previous = '';
  while (previous !== name) {
    previous = name;
    name = name.replace(/\s+\(?\s*(?:(?:short|logo|full|long|medium|main|extended|instrumental|original|radio|loop|electronic|dark pop|love|speed up)\s+)?(?:version|edit|mix)(?:\s*\d+)*\s*\)?(?:\s+\d+)?$/i, '')
      .replace(/\s+(?:no vocal|instrumental(?:\s+\d+)?|speed up|intro)$/i, '').trim();
  }
  return name || track.name;
}
export function fitsMusic(track: LibraryTrack, editS?: number) {
  return !!editS && track.durationS >= editS * .85 - 1e-7 && track.durationS <= editS * 1.15 + 1e-7;
}
export function musicLength(track: LibraryTrack, index: number, editS?: number) {
  return index === 0 ? fitsMusic(track, editS) : index === 1 ? track.durationS < 30 : index === 2 ? track.durationS >= 30 && track.durationS < 60 : index === 3 ? track.durationS >= 60 && track.durationS <= 120 : track.durationS > 120;
}
export function musicTempo(track: LibraryTrack, index: number) {
  return track.bpm !== null && (index === 0 ? track.bpm < 90 : index === 1 ? track.bpm >= 90 && track.bpm <= 120 : track.bpm > 120);
}
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export function musicGroups(tracks: LibraryTrack[], options: MusicQuery = {}, length?: number, tempo?: number) {
  const terms = normalize(options.query ?? '').split(/\s+/).filter(Boolean);
  const grouped = new Map<string, { id: string; name: string; versions: LibraryTrack[] }>();
  for (const track of tracks) {
    const name = musicGroupName(track), id = normalize(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    let group = grouped.get(id);
    if (!group) { group = { id, name, versions: [] }; grouped.set(id, group); }
    group.versions.push(track);
  }
  return [...grouped.values()].flatMap(group => {
    // A tag hit on one version finds the song, but numeric filters must match
    // the SAME version that the person can choose.
    const haystack = normalize(group.versions.map(t => [t.name, ...Object.values(t.tags ?? {})].join(' ')).join(' '));
    if (!terms.every(term => haystack.includes(term))) return [];
    const versions = group.versions.filter(t =>
      (options.minS === undefined || t.durationS >= options.minS) && (options.maxS === undefined || t.durationS <= options.maxS) &&
      (options.minBpm === undefined || t.bpm !== null && t.bpm >= options.minBpm) && (options.maxBpm === undefined || t.bpm !== null && t.bpm <= options.maxBpm) &&
      (length === undefined || musicLength(t, length, options.editS)) && (tempo === undefined || musicTempo(t, tempo)));
    versions.sort((a, b) => Number(b.file === options.current) - Number(a.file === options.current) || Number(fitsMusic(b, options.editS)) - Number(fitsMusic(a, options.editS)) || (options.editS ? Math.abs(a.durationS - options.editS) - Math.abs(b.durationS - options.editS) : 0) || a.name.localeCompare(b.name));
    return versions.length ? [{ ...group, versions }] : [];
  }).sort((a, b) => Number(b.versions.some(t => t.file === options.current)) - Number(a.versions.some(t => t.file === options.current)) || Number(b.versions.some(t => fitsMusic(t, options.editS))) - Number(a.versions.some(t => fitsMusic(t, options.editS))) || a.name.localeCompare(b.name));
}
export function musicPage(tracks: LibraryTrack[], options: MusicQuery = {}, length?: number, tempo?: number) {
  const groups = musicGroups(tracks, options, length, tempo);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  return { rows: groups.slice(offset, offset + MUSIC_PAGE_SIZE), total: groups.length, offset, nextOffset: offset + MUSIC_PAGE_SIZE < groups.length ? offset + MUSIC_PAGE_SIZE : null };
}
