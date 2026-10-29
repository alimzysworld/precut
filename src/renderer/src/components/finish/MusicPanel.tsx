import { InfoLabel, CONTROL_TIPS } from "../ui/InfoTip";
import { useSoundSeparation } from "./ClipSoundCleaning";
import { MUSIC_DUCK } from '../../../../shared/music-duck';
import { EmptyState } from "../ui";
import { Tile, InlineError, Row, Switch, NumberField, SearchField } from "../ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { musicGroups, musicGroupName, musicLength, musicTempo, MUSIC_LENGTHS, MUSIC_TEMPOS, MUSIC_PAGE_SIZE, type LibraryTrack, type MusicCatalog } from "../../../../shared/music-library";
import { getApi } from "../../data";
import { Button, FOCUS } from "../ui";
import { Slider } from "./Controls";
import { MusicFolderChoice } from "./MusicFolder";
import { warmLiveMusic } from "../liveMix";

export type MusicChoice = { pinnedArrangement?: import('../../../../shared/schema').MusicArrangementAnchor; file: string; startS: number; endS?: number; gainDb: number; duckDepthDb?: number; stemDucking?: boolean; fit?: boolean; followStory?: boolean; duck: boolean } | null;
type Track = LibraryTrack;
function musicLabel(track: Track, grouped = false) {
  const name = track.name.replace(/^.*?-\s+/, '');
  return grouped ? musicGroupName({ ...track, name }) : name;
}
export function musicName(file: string) { return file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? file; }
// M1 serves only files from the configured music catalog through this route.
export function musicPreviewUrl(file: string) { return `st-media://local/music/${encodeURIComponent(file)}`; }
export function MusicPanel({ value, onChange, onNames, cutToBeat = false, onCutToBeat, showBeat = true, editS, arrangementState, arrangementSummary }: { arrangementState?: "preparing" | "ready" | "error"; arrangementSummary?: string; editS?: number; showBeat?: boolean; cutToBeat?: boolean; onCutToBeat?: (value: boolean) => void; value: MusicChoice; onChange: (value: MusicChoice) => void; onNames: (names: Record<string, string>) => void }) {
  const tipId = useId();
  const [startDraft,setStartDraft]=useState<string|null>(null);
  const startDirty=useRef(false);
  useEffect(()=>{startDirty.current=false;setStartDraft(null);},[value?.file,value?.startS]);
  function commitStart() {
    if(!startDirty.current || startDraft===null || !value)return;
    startDirty.current=false;
    const startS=Number(startDraft);setStartDraft(null);
    if(!startDraft.trim() || !Number.isFinite(startS))return;
    const bounded=Math.max(0,Math.min(startS,duration===undefined ? Infinity : Math.max(0,duration-.1)));
    if(bounded===value.startS)return;
    stop();onChange({...value,pinnedArrangement:undefined,fit:false,followStory:false,startS:bounded});
  }
  const separation=useSoundSeparation();
  const [separationInstalled,setSeparationInstalled]=useState(false);
  useEffect(()=>{let alive=true;void Promise.resolve().then(()=>getApi().extensions()).then(items=>{if(alive)setSeparationInstalled(items.some(item=>item.id==='sound-separation' && item.state==='installed'));}).catch(()=>{});return ()=>{alive=false;};},[]);
  const [tracks, setTracks] = useState<Track[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const [catalog, setCatalog] = useState<MusicCatalog | null>(null);
  const [query, setQuery] = useState(''), [length, setLength] = useState<number>(), [tempo, setTempo] = useState<number>(), [page, setPage] = useState(0), [expanded, setExpanded] = useState<string | null>(null);
  const names = useRef(onNames); names.current = onNames;
  const groups = useMemo(() => musicGroups(tracks, { query, editS, current: value?.file }), [tracks, query, editS, value?.file]);
  const lengthCounts = groups.length ? MUSIC_LENGTHS.map((_, i) => groups.filter(g => g.versions.some(t => musicLength(t, i, editS) && (tempo === undefined || musicTempo(t, tempo)))).length) : MUSIC_LENGTHS.map(() => 0);
  const tempoCounts = MUSIC_TEMPOS.map((_, i) => groups.filter(g => g.versions.some(t => musicTempo(t, i) && (length === undefined || musicLength(t, length, editS)))).length);
  const filtered = groups.flatMap(g => { const versions = g.versions.filter(t => (length === undefined || musicLength(t, length, editS)) && (tempo === undefined || musicTempo(t, tempo))); return versions.length ? [{ ...g, versions }] : []; });
  const lastPage = Math.max(0, Math.ceil(filtered.length / MUSIC_PAGE_SIZE) - 1), activePage = Math.min(page, lastPage);
  const rows = filtered.slice(activePage * MUSIC_PAGE_SIZE, (activePage + 1) * MUSIC_PAGE_SIZE);
  useEffect(() => { setPage(0); setExpanded(null); }, [query, length, tempo, editS, value?.file]);
  const [folder, setFolder] = useState<string | null>(null), [folderRead, setFolderRead] = useState(false);
  // ONB1b: an edit's music outside the library joins it (as on open); a missing file is said plainly.
  const [missing, setMissing] = useState(false), referenced = useRef<string | null>(null);
  useEffect(() => { let alive = true; void getApi().getMusicFolder().then(value => { if (alive) setFolder(value); }).catch(() => {}).finally(() => { if (alive) setFolderRead(true); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (loading || catalog?.measuring || error || !value || tracks.some(track => track.file === value.file)) { setMissing(false); return; }
    if (referenced.current === value.file) { setMissing(true); return; }
    referenced.current = value.file;
    void Promise.resolve().then(() => getApi().addMusicTracks([value.file])).catch(() => {}).finally(() => setRetry(n => n + 1));
  }, [loading, catalog?.measuring, error, tracks, value]);
  const [preview, setPreview] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null), stopAt = useRef(10), timer = useRef<ReturnType<typeof setTimeout>>(), request = useRef(0);
  const selected = useRef(value); selected.current = value;
  useEffect(() => {
    tracks.filter(track => track.file !== value?.file).slice(0, 3).forEach(track => warmLiveMusic(musicPreviewUrl(track.file)));
  }, [tracks, value?.file]);
  function stop() { request.current++; audio.current?.pause(); clearTimeout(timer.current); setPreview(null); }
  useEffect(() => {
    let active = true, first = true, poll: ReturnType<typeof setTimeout> | undefined; setLoading(true); setError(null);
    async function refresh() {
      try {
        const api = getApi();
        const result = typeof api.musicCatalog === 'function' ? await api.musicCatalog(first && retry > 0) : null;
        first = false;
        const next = result?.tracks ?? await api.listMusic();
        if (!active) return;
        setTracks(next); setCatalog(result); setLoading(false);
        names.current(Object.fromEntries(next.map(track => [track.file, track.name])));
        if (result?.error) setError(result.error);
        if (result?.measuring) poll = setTimeout(() => void refresh(), 500);
      } catch { if (active) { setLoading(false); setError("Couldn't load music. Check your music folder and retry."); } }
    }
    void refresh();
    return () => { active = false; clearTimeout(poll); };
  }, [retry]);
  useEffect(() => { const element = audio.current; return () => { request.current++; element?.pause(); clearTimeout(timer.current); }; }, []);
  useEffect(() => { if (audio.current) audio.current.volume = Math.min(1, Math.pow(10, (value?.gainDb ?? -18) / 20)); }, [value?.gainDb]);
  async function play(track: Track) {
    if (preview === track.file) return;
    stop(); const element = audio.current;
    if (!element) return;
    const token = ++request.current;
    setError(null); setPreview(track.file);
    const start = selected.current?.file === track.file ? Math.min(selected.current.startS, Math.max(0, track.durationS - .1)) : 0;
    stopAt.current = Math.min(track.durationS, start + 10);
    element.onloadedmetadata = () => { if (token === request.current) element.currentTime = start; };
    element.volume = Math.min(1, Math.pow(10, (selected.current?.gainDb ?? -18) / 20));
    element.src = musicPreviewUrl(track.file);
    try { await element.play(); if (token === request.current) timer.current = setTimeout(stop, 10_000); }
    catch { if (token === request.current) { stop(); setError("Couldn't preview this track. Try again."); } }
  }
  async function importTracks(kind: "tracks", files?: string[]) {
    setError(null);
    try {
      if (files) await getApi().addMusicTracks(files);
      else if (kind === "tracks") await getApi().pickMusicTracks();
      setRetry(previous => previous + 1);
    } catch { setError("Couldn't add music. Check the files are connected and try again."); }
  }
  function trackRow(track: Track, label = musicLabel(track)) { return <div key={track.file} className={`flex min-w-0 items-center gap-1 rounded-xl ${value?.file === track.file ? "bg-ink/[0.1]" : "hover:bg-ink/[0.05]"}`}>
        <Tile type="button" aria-label={`Use ${track.name}`} aria-pressed={value?.file === track.file} onPointerEnter={() => warmLiveMusic(musicPreviewUrl(track.file))} onFocus={() => warmLiveMusic(musicPreviewUrl(track.file))} onClick={() => { stop(); if (selected.current?.file !== track.file) onChange({ file: track.file, fit: true, followStory: selected.current?.followStory, startS: 0, gainDb: selected.current?.gainDb ?? -18, duckDepthDb: selected.current?.duckDepthDb, stemDucking:selected.current?.stemDucking, duck: selected.current?.duck ?? true }); }} className={`min-w-0 flex-1 rounded-xl p-2 text-left ${FOCUS}`}><span title={track.name} className="block truncate">{label}</span><span className="block truncate text-micro text-muted">{Math.floor(track.durationS / 60)}:{String(Math.floor(track.durationS % 60)).padStart(2, "0")}{track.bpm !== null ? ` · ${Math.round(track.bpm)} bpm` : ""}{track.tags?.artist || track.name.match(/^(.*?)-\s+/)?.[1] ? ` · ${track.tags?.artist ?? track.name.match(/^(.*?)-\s+/)?.[1]?.trim()}` : ""}</span></Tile>
        <button type="button" aria-label={`${preview === track.file ? "Stop" : "Preview"} ${track.name}`} onClick={() => preview === track.file ? stop() : void play(track)} className={`shrink-0 rounded-lg p-2 text-micro text-muted ${FOCUS}`}>{preview === track.file ? "Stop" : "Preview"}</button>
      </div>; }
  const duration = tracks.find(track => track.file === value?.file)?.durationS;
  const chosen = (next: string) => { setFolder(next); setRetry(previous => previous + 1); };
  // No music at all: one line and one button, nothing else.
  if (!loading && !error && folderRead && !folder && !tracks.length && !value) return <MusicFolderChoice folder={null} line="No music yet. Choose a folder of tracks you're allowed to post." onChosen={chosen} />;
  return <div className="space-y-4">
    <audio ref={audio} preload="none" onEnded={stop} onTimeUpdate={event => { if (event.currentTarget.currentTime >= stopAt.current) stop(); }} onError={() => { stop(); setError("Couldn't preview this track. Try again."); }} />
    <div className="space-y-2">
      <SearchField label="Search music" placeholder="Search music" query={query} onQueryChange={setQuery} shortcut={null} className="w-full !rounded-lg !px-3 !py-2" />
      <div role="group" aria-label="Music length" className="flex flex-wrap gap-1">{MUSIC_LENGTHS.map((label, i) => i === 0 && !editS ? null : <Tile type="button" key={label} aria-pressed={length === i} onClick={() => setLength(length === i ? undefined : i)} className={`rounded-lg px-2 py-1 text-micro ${length === i ? 'bg-ink/[0.14] text-ink' : 'bg-ink/[0.05] text-muted'} ${FOCUS}`}>{label} · {lengthCounts[i]}</Tile>)}</div>
      {tracks.some(t => t.bpm !== null) ? <div role="group" aria-label="Music tempo" className="flex flex-wrap gap-1">{MUSIC_TEMPOS.map((label, i) => <Tile type="button" key={label} aria-label={`${label} tempo`} title={i === 0 ? 'Under 90 bpm' : i === 1 ? '90 to 120 bpm' : 'Over 120 bpm'} aria-pressed={tempo === i} onClick={() => setTempo(tempo === i ? undefined : i)} className={`rounded-lg px-2 py-1 text-micro ${tempo === i ? 'bg-ink/[0.14] text-ink' : 'bg-ink/[0.05] text-muted'} ${FOCUS}`}>{label} · {tempoCounts[i]}</Tile>)}</div> : null}
    </div>
    <div role="group" aria-label="Music tracks" className="space-y-1">
      <Tile type="button" aria-pressed={!value} onClick={() => { stop(); onChange(null); }} className={`w-full rounded-xl p-2 text-left ${!value ? "bg-ink/[0.1]" : "hover:bg-ink/[0.05]"} ${FOCUS}`}>Off</Tile>
      {rows.map(group => <div key={group.id} data-music-group={group.id}>
        {trackRow(group.versions[0], musicLabel(group.versions[0], expanded !== group.id))}
        {group.versions.length > 1 ? <button type="button" aria-expanded={expanded === group.id} aria-label={`Versions of ${group.name}`} onClick={() => setExpanded(expanded === group.id ? null : group.id)} className={`rounded-lg bg-ink/[0.05] px-2 py-1 text-micro text-muted ${FOCUS}`}>{group.versions.length} versions</button> : null}
        {expanded === group.id ? <div className="ml-3 space-y-1">{group.versions.slice(1).map(track => trackRow(track))}</div> : null}
      </div>)}
    </div>
    {filtered.length > MUSIC_PAGE_SIZE ? <nav aria-label="Music pages" className="flex items-center justify-between gap-2 text-micro"><Button disabled={activePage === 0} onClick={() => { stop(); setPage(activePage - 1); setExpanded(null); }}>Previous</Button><span className="text-muted">{activePage + 1} of {lastPage + 1} · {filtered.length} songs</span><Button disabled={activePage === lastPage} onClick={() => { stop(); setPage(activePage + 1); setExpanded(null); }}>Next</Button></nav> : null}
    {!loading && tracks.length > 0 && !rows.length ? <p className="text-micro text-muted">No matching music. Try another search or filter.</p> : null}
    {catalog?.measuring ? <p role="status" className="text-micro text-muted">Measuring {catalog.total} tracks{catalog.etaS === null ? '' : catalog.etaS < 60 ? ' · Less than a minute left' : ` · Approx ${Math.ceil(catalog.etaS / 60)} min`}</p> : null}
    {catalog?.failed ? <p role="status" className="text-micro text-muted">{catalog.failed} {catalog.failed === 1 ? 'track could' : 'tracks could'} not be read.</p> : null}
    {missing ? <p role="status" className="text-micro text-muted">This edit's music file is missing.</p> : null}
    {loading ? <p role="status" className="text-micro text-muted">Loading music…</p> : !catalog?.measuring && !tracks.length && !error ? <EmptyState variant="inline" as="p" className="text-micro text-muted">No tracks in this folder yet.</EmptyState> : null}
    {error ? <InlineError className="text-micro text-danger">{error} <Button type="button" onClick={() => setRetry(n => n + 1)}>Retry</Button></InlineError> : null}
    <div className="space-y-2">
      <MusicFolderChoice folder={folder} line={null} onChosen={chosen} />
      <Button aria-label="Add music tracks" onClick={() => void importTracks("tracks")}>Add tracks</Button>
      <div aria-label="Drop music tracks" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={event => { event.preventDefault(); const files = Array.from(event.dataTransfer.files).map(file => getApi().pathForFile(file)).filter(Boolean); if (files.length) void importTracks("tracks", files); }} className="rounded-xl bg-ink/[0.04] p-4 text-center text-micro text-muted">Drop audio files here</div>
      {showBeat ? <Row className="gap-2"><InfoLabel label="Cut to the music" htmlFor={`${tipId}-beat`}>{CONTROL_TIPS.beat}</InfoLabel><Switch id={`${tipId}-beat`} aria-label="Cut to the music" checked={cutToBeat} disabled={!value} onChange={event => onCutToBeat?.(event.target.checked)} /></Row> : null}
      {showBeat && !value ? <p className="text-micro text-muted">Add music first</p> : null}
    </div>
    <fieldset disabled={!value} className="space-y-3 disabled:opacity-40">
      <Row><InfoLabel label="Fit to edit" htmlFor={`${tipId}-fit`}>{CONTROL_TIPS.fit}</InfoLabel><Switch id={`${tipId}-fit`} aria-label="Fit to edit" checked={value?.fit ?? false} onChange={event=>{if(value)onChange({...value,pinnedArrangement:undefined,fit:event.target.checked,followStory:event.target.checked ? value.followStory : false});}} /></Row>
      <Row><InfoLabel label="Follow the story" htmlFor={`${tipId}-story`}>{CONTROL_TIPS.story}</InfoLabel><Switch id={`${tipId}-story`} aria-label="Follow the story" checked={value?.followStory ?? false} onChange={event=>{if(value)onChange({...value,pinnedArrangement:undefined,followStory:event.target.checked,fit:event.target.checked ? true : value.fit});}} /></Row>
      {value?.pinnedArrangement && (value.fit || value.followStory) ? <div className="space-y-1"><p role="status" className="text-micro text-muted">Music stays put while you edit.</p><Button onClick={()=>onChange({...value,pinnedArrangement:undefined,fit:true,followStory:true})}>Follow the story again</Button></div> : null}
      {(value?.fit || value?.followStory) && !value?.pinnedArrangement ? <p role="status" className="text-micro text-muted" style={{ minHeight: "2lh" }}>{arrangementState === 'error' ? 'Music could not be fitted. Change the track or turn fitting off.' : arrangementState === 'ready' ? arrangementSummary ?? 'Music fits the edit.' : value.followStory ? 'Following the story. You can keep editing.' : 'Fitting music. You can keep editing.'}</p> : null}
      <Slider label="Music volume" value={value?.gainDb ?? -18} min={-60} max={0} unit=" dB" onChange={gainDb => { if (value) onChange({ ...value, gainDb }); }} />
      <Row as="label" className="gap-2 text-micro text-muted">Start at (seconds)<NumberField aria-label="Music start at" min={0} max={duration === undefined ? undefined : Math.max(0, duration - .1)} step={.1} value={startDraft ?? value?.startS ?? 0} onChange={event=>{startDirty.current=true;setStartDraft(event.target.value);}} onBlur={commitStart} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commitStart();}if(event.key==='Escape'){startDirty.current=false;setStartDraft(null);}}} className={`w-20 rounded-lg bg-ink/[0.06] p-2 text-ink ${FOCUS}`} /></Row>
      <Row as="label" className="gap-2 text-micro text-muted">End in edit (seconds)<NumberField aria-label="Music end in edit" min={.1} step={.1} placeholder="Edit end" value={value?.endS ?? ''} onChange={event=>{if(!value)return;const endS=event.target.value==='' ? undefined : Number(event.target.value);if(endS===undefined || Number.isFinite(endS) && endS>=.1)onChange({...value,endS,fit:false,followStory:false});}} className={`w-20 rounded-lg bg-ink/[0.06] p-2 text-ink ${FOCUS}`} /></Row>
      <Row><InfoLabel label="Make room for the voice" htmlFor={`${tipId}-duck`}>{CONTROL_TIPS.duck}</InfoLabel><Switch id={`${tipId}-duck`} aria-label="Duck under voice" checked={value?.duck ?? true} onChange={event => { if (value) onChange({ ...value, duck: event.target.checked }); }} /></Row>
      {value && value.duck !== false && <Slider label="Music under voice" value={value.duckDepthDb ?? MUSIC_DUCK.speechDb} min={0} max={24} unit=" dB" onChange={duckDepthDb => onChange({ ...value, duckDepthDb })} />}
      <Row><InfoLabel label="Keep the beat under voices" htmlFor={`${tipId}-stems`}>{CONTROL_TIPS.stems}</InfoLabel><Switch id={`${tipId}-stems`} aria-label="Keep the beat under voices" checked={value?.stemDucking ?? separationInstalled} onChange={event=>{if(!value)return;const stemDucking=event.target.checked;if(stemDucking)void separation.request(()=>onChange({...value,stemDucking}));else onChange({...value,stemDucking});}} /></Row>
      {separation.prompt}
    </fieldset>
  </div>;
}
