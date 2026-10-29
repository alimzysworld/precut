// VT1 (docs/SPIKE-12-video-types.md): each video type has its own editing logic.
// The model judges the type and the edit; this module measures what the footage
// can carry (kinds, recorded times, places) and holds each type's engine defaults.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Clip, LayoutChoice, LowerThird, Shoot, VideoType } from "../shared/schema";
import type { StoredVersion } from "./sidekick";
import type { MusicTrack } from "./reel";
import { reelIds, resolveReelPieces } from "./reel";
import { cutPieceGroups } from "./export";
import { planFx, syncFxMetadata } from "./edits-fx";
import { measuredScenes } from "./scenes";
import { isScreenClip } from "./layout-math";
import { validateLayout, layoutReadme } from "./layouts";
import { writeJsonAtomic } from "./cut-storage";
import { tool } from "./tools";

export const VIDEO_TYPES: readonly VideoType[] = ["talking", "voiceover", "montage", "tutorial", "vlog"];
export const isVideoType = (value: unknown): value is VideoType => typeof value === "string" && (VIDEO_TYPES as readonly string[]).includes(value);

// The editing logic each type asks for. Data for the model, never a script.
export const TYPE_LOGIC: Record<VideoType, string> = {
  talking: "Talking to camera carries it. Open on the hook line, one point, every line moves toward it, jump cuts hidden with punch-ins, captions on, music under.",
  voiceover: "A voice leads from start to end (a talking take's sound; the speaker is rarely seen). Lay a b-roll id over every voice id so the picture follows the words, in the order they are said. Captions on, music under the voice. precut fills any line you leave uncovered with the unused b-roll that best matches its words.",
  montage: "No voice: only b-roll ids in voice order, chosen and ordered so it builds. Music is the sound: pick the track and start so the build or drop lands on the strongest shot. precut trims every shot to land on a beat, cuts to the beat and plays the music at full level. Optional short text cards with finish.layouts title on a piece. No captions.",
  tutorial: "Screen recordings with the face. On lines about the screen set finish.layouts bubble (face in a corner) or split; when you leave layouts out precut lays the synced screen recording under the face in a corner. Each new step gets a title card (finish.layouts title, a few words). Slower pace: energy off or subtle, never punchy. Captions on.",
  vlog: "A day in time order. Open on the best moment or line of the day as the hook, then go back to the start of the day and follow request.day in recorded order. Loose voice: talking-to-camera and walk-and-talk moments, with b-roll of the places and moments between them. Show a talking clip's own picture only when it is worth watching (the person in frame, or the moment they are talking about visible); when its picture is a setup, an empty room or a wall, keep its line as voice and lay the day's strongest b-roll over it. The first second is the most striking picture of the day with the hook line over it, never a setup shot. precut keeps the natural sound under talking, lets it trail into b-roll and lands b-roll cuts on the music's beats; add an ambience sfx under b-roll of a place only when it lifts it. Short time and place cards (finish.lowerThirds, two or three words like 'Morning coffee') where the place or time of day changes; precut adds clock-time cards from the recorded times when you leave them out. End on a moment that closes the day (a last line, a last light, a door closing), never mid-thought.",
};

// Exact wording for prompts/sidekick.md (Claude owns the prompt). Appended only
// while the template does not carry it yet, so the handoff needs no code change.
export const VIDEO_TYPE_PROMPT_MARKER = "Video types:";
export const VIDEO_TYPE_PROMPT = `${VIDEO_TYPE_PROMPT_MARKER} every video is one of talking, voiceover, montage, tutorial or vlog, and each has its own editing logic (request.videoTypes when making ideas, request.videoType when cutting).
- Making ideas: first read request.footage (talking, voiceover takes, b-roll, screen recordings, a day across times and places) and decide which types this shoot can carry. Give every idea a "type". Add a top-level "canMake": one short plain line on what this shoot can make ("A day in the life vlog, a market montage and two talking clips."). Offer a type only when the footage carries it: a vlog needs clips across a day, a tutorial needs screen recordings, a montage needs b-roll and music, a voiceover needs b-roll for the words.
- Cutting: follow request.videoType.logic and set cut.type to the type you cut. When the person asks for another type ("make this a montage"), re-cut it as that type and set cut.type. Every other output field stays as it is.
- Vlog: request.day lists every take and b-roll id in recorded order with its clock time, scene and place, and the voice notes recorded that day. finish.lowerThirds is optional: [{ "piece": string, "title": string, "subtitle": string | null }], a short time or place card at the start of that piece.
JSON additions: ideas[].type, top-level "canMake" (a line when making ideas, otherwise null), cut.type, cut.finish.lowerThirds.`;

// ---- measured facts: recorded wall-clock time and place, read once per file and cached

interface ClipFacts { key: string; local: string | null; lat: number | null; lon: number | null }
type FactsFile = Record<string, ClipFacts>;
const factsFile = (root: string) => path.join(root, ".sidething", "video-type-facts.json");
const pad = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM-DDTHH:MM" on the Mac's clock. */
function localStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** Phones write the wall clock where it was filmed; other cameras UTC, shown on this Mac's clock. */
export function wallClock(tags: Record<string, string>, fallback: string | null | undefined): string | null {
  const phone = tags["com.apple.quicktime.creationdate"];
  if (phone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(phone)) return phone.slice(0, 16);
  const utc = tags.creation_time ?? fallback;
  const time = utc ? Date.parse(utc) : NaN;
  return Number.isFinite(time) && time > 0 ? localStamp(new Date(time)) : null;
}
/** ISO 6709 ("+51.5072-000.1276+011.0/"), as phones and many cameras write it. */
export function parseLocation(tags: Record<string, string>): { lat: number; lon: number } | null {
  const value = tags["com.apple.quicktime.location.ISO6709"] ?? tags.location ?? tags["location-eng"];
  const match = value ? /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(value) : null;
  if (!match) return null;
  const lat = Number(match[1]), lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0) ? { lat, lon } : null;
}
async function probeTags(file: string): Promise<Record<string, string>> {
  const { stdout } = await promisify(execFile)(tool("ffprobe"), ["-v", "error", "-print_format", "json", "-show_entries", "format_tags", file], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const tags = (JSON.parse(stdout) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {};
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase().startsWith("com.apple") ? k : k.toLowerCase(), String(v)]));
}
/** Read-only on originals; results live in .sidething. Unreadable files give no facts, never a guess. */
export async function readClipFacts(root: string, files: { file: string; createdAt?: string | null }[]): Promise<Map<string, { local: string | null; lat: number | null; lon: number | null }>> {
  let cache: FactsFile = {};
  try { cache = JSON.parse(await fs.readFile(factsFile(root), "utf8")); } catch { /* first read */ }
  let dirty = false;
  const result = new Map<string, { local: string | null; lat: number | null; lon: number | null }>();
  const queue = [...new Set(files.map(f => f.file))].map(file => files.find(f => f.file === file)!);
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const absolute = path.resolve(root, item.file);
      const stat = await fs.stat(absolute).catch(() => null);
      const key = stat ? `${stat.size}:${Math.round(stat.mtimeMs)}` : "missing";
      let facts = cache[item.file]?.key === key ? cache[item.file] : null;
      if (!facts) {
        const tags = stat ? await probeTags(absolute).catch(() => ({} as Record<string, string>)) : {};
        const place = parseLocation(tags);
        facts = { key, local: wallClock(tags, item.createdAt), lat: place?.lat ?? null, lon: place?.lon ?? null };
        if (stat) { cache[item.file] = facts; dirty = true; }
      }
      // A cached file never had its pipeline time: keep the pipeline's if the probe found none.
      result.set(item.file, { local: facts.local ?? wallClock({}, item.createdAt), lat: facts.lat, lon: facts.lon });
    }
  }));
  if (dirty) await writeJsonAtomic(factsFile(root), cache).catch(() => { /* cache only */ });
  return result;
}

/** "9:14 am". */
export function clockText(local: string): string {
  const hours = Number(local.slice(11, 13)), minutes = local.slice(14, 16);
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "am" : "pm"}`;
}
const dayText = (local: string) => new Date(`${local.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
const kindOf = (clip: Clip) => clip.byHand?.kind ?? clip.judgement?.kind ?? "unknown";
/** Audio-only files that line up with no camera clip: voice notes or voiceover takes. */
export function voiceNotes(shoot: Shoot) {
  const used = new Set(shoot.clips.flatMap(c => c.sound ? [c.sound.file] : []));
  return (shoot.audio ?? []).filter(a => a.role === "voiceover" || (a.role !== "sync" && !a.syncedTo && !a.clips?.length && !used.has(a.file)));
}

export interface DayFacts {
  clips: Map<string, { local: string | null; scene: number | null; place: string | null }>;
  notes: Map<string, string | null>;
  places: { id: string; lat: number; lon: number; clips: number }[];
  scenes: number;
}
export async function dayFacts(root: string, shoot: Shoot): Promise<DayFacts> {
  const notes = voiceNotes(shoot);
  const facts = await readClipFacts(root, [...shoot.clips.map(c => ({ file: c.file, createdAt: c.meta?.createdAt })), ...notes.map(n => ({ file: n.file }))]);
  const ordered = [...shoot.clips].sort((a, b) => (facts.get(a.file)?.local ?? "~").localeCompare(facts.get(b.file)?.local ?? "~") || a.file.localeCompare(b.file));
  // Places: greedy clusters within 200 m, numbered in the order the day reaches them.
  const places: (DayFacts["places"][number] & { sum: { lat: number; lon: number } })[] = [];
  const placeOf = new Map<string, string>();
  for (const clip of ordered) {
    const f = facts.get(clip.file);
    if (f?.lat == null || f.lon == null) continue;
    const point = { lat: f.lat, lon: f.lon };
    let place = places.find(p => metres(p, point) <= 200);
    if (!place) { place = { id: `P${places.length + 1}`, lat: point.lat, lon: point.lon, clips: 0, sum: { lat: 0, lon: 0 } }; places.push(place); }
    place.clips++; place.sum.lat += point.lat; place.sum.lon += point.lon;
    place.lat = place.sum.lat / place.clips; place.lon = place.sum.lon / place.clips;
    placeOf.set(clip.id, place.id);
  }
  const sceneOf = new Map<string, number>();
  measuredScenes(shoot).forEach((scene, index) => scene.clipIds.forEach(id => sceneOf.set(id, index + 1)));
  return {
    clips: new Map(shoot.clips.map(c => [c.id, { local: facts.get(c.file)?.local ?? null, scene: sceneOf.get(c.id) ?? null, place: placeOf.get(c.id) ?? null }])),
    notes: new Map(notes.map(n => [n.file, facts.get(n.file)?.local ?? null])),
    places: places.map(({ sum: _sum, ...p }) => ({ ...p, lat: Math.round(p.lat * 1000) / 1000, lon: Math.round(p.lon * 1000) / 1000 })),
    scenes: new Set(sceneOf.values()).size,
  };
}

/** What the footage measures as, for the ideas call to judge which types it can carry. */
export function footageProfile(shoot: Shoot, day: DayFacts) {
  const length = (clips: Clip[]) => Math.round(clips.reduce((n, c) => n + (c.meta?.durationS ?? 0), 0));
  const talking = shoot.clips.filter(c => kindOf(c) === "talking"), screens = shoot.clips.filter(isScreenClip);
  const broll = shoot.clips.filter(c => kindOf(c) === "broll" && !isScreenClip(c));
  const times = [...day.clips.values()].map(c => c.local).filter((t): t is string => !!t).sort();
  const notes = voiceNotes(shoot);
  return {
    talkingClips: talking.length, talkingS: length(talking), brollClips: broll.length, brollS: length(broll),
    screenRecordings: screens.length, syncedScreens: screens.filter(s => shoot.angles?.some(g => g.clips.some(c => c.clipId === s.id))).length,
    voiceNotes: notes.length, voiceNotesS: Math.round(notes.reduce((n, a) => n + (a.durationS ?? 0), 0)),
    lines: shoot.takes.length,
    recorded: times.length >= 2 ? { first: times[0], last: times.at(-1)!, hours: Math.round((Date.parse(times.at(-1)!) - Date.parse(times[0])) / 360_000) / 10,
      days: new Set(times.map(t => t.slice(0, 10))).size, scenes: day.scenes, places: day.places.length } : null,
  };
}

/** Every take and b-roll id in recorded order, with the voice notes, for a vlog. */
export function dayOrder(shoot: Shoot, day: DayFacts) {
  const { voice, broll } = reelIds(shoot);
  const multiDay = new Set([...day.clips.values()].flatMap(c => c.local ? [c.local.slice(0, 10)] : [])).size > 1;
  const at = (clipId: string, s: number) => {
    const local = day.clips.get(clipId)?.local;
    if (!local) return null;
    const time = new Date(Date.parse(`${local}:00`) + s * 1000);
    return localStamp(time);
  };
  const entries = [...voice, ...broll].map(([id, seg]) => {
    const local = at(seg.clip.id, seg.s), facts = day.clips.get(seg.clip.id);
    return { id, kind: seg.lineIndex === null ? "broll" : "talk", clipId: seg.clip.id, sort: local ?? "~", at: local ? `${multiDay ? `${dayText(local)}, ` : ""}${clockText(local)}` : null,
      scene: facts?.scene ?? null, place: facts?.place ?? null };
  }).sort((a, b) => a.sort.localeCompare(b.sort) || a.clipId.localeCompare(b.clipId) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const notes = voiceNotes(shoot).map(n => ({ file: path.basename(n.file), lengthS: Math.round(n.durationS * 10) / 10,
    at: day.notes.get(n.file) ? clockText(day.notes.get(n.file)!) : null,
    said: n.transcript?.map(s => s.text).join(" ").slice(0, 400) || null }));
  return { order: entries.map(({ sort: _sort, ...e }) => e), places: day.places, voiceNotes: notes,
    note: "Voice notes are listed for the story; they can't be placed in the cut yet." };
}

// ---- engine support per type, applied to the new unsaved version

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** Rebuild timeline offsets, the reel's cut table and pieces after a length change. A fitted piece keeps the beat it
 * ends on, or none (null) when it ends off the measured beats: never the beat it ended on before it was fitted. */
function retime(record: StoredVersion, beats: Map<number, number | null>): void {
  const { cutList, template, reel, shoot } = record.assembly;
  let offset = 0;
  for (const item of cutList) { item.offsetFrames = offset; offset += item.durTimelineFrames; }
  reel.cuts = cutPieceGroups(cutList).map(({ piece, items }) => {
    const first = items[0], last = items.at(-1)!, rate = first.clipFpsR.num / first.clipFpsR.den;
    return { ...reel.cuts[piece], s: first.inFrames / rate, e: last.outFrames / rate, offsetS: first.offsetFrames / template.fps,
      lengthS: items.reduce((n, c) => n + c.durTimelineFrames / template.fps, 0),
      ...(beats.has(piece) ? { beatDeltaS: 0, beatS: beats.get(piece) ?? null } : {}) };
  });
  const before = record.pieces ?? [];
  record.pieces = resolveReelPieces(shoot, template, cutList, reel).map((p, i) => ({ ...before[i], ...p, ...(before[i]?.words ? { words: before[i].words } : {}) }));
  record.lengthS = offset / template.fps;
}

/**
 * The music's beat grid in edit time. A beat tracker hears nothing in a quiet intro or a break, but the tempo carries
 * on through it: the beats it missed are put back at the measured period, in phase with the beats it heard either side
 * (LK1: "The croissant run" track's first heard beat is 7.9 s in, so its opening shot could only end there).
 */
function beatGrid(heard: number[], period: number, endS: number): { at: number; heard: boolean }[] {
  if (!heard.length || !Number.isFinite(period)) return heard.map(at => ({ at, heard: true }));
  const grid: { at: number; heard: boolean }[] = [];
  for (let at = heard[0] - period; at > 0; at -= period) grid.unshift({ at, heard: false });
  heard.forEach((at, i) => {
    grid.push({ at, heard: true });
    if (i === heard.length - 1) return;
    const gap = heard[i + 1] - at, missing = Math.round(gap / period) - 1;
    for (let k = 1; k <= missing; k++) grid.push({ at: at + gap * k / (missing + 1), heard: false });
  });
  for (let at = heard.at(-1)! + period; at < endS; at += period) grid.push({ at, heard: false });
  return grid;
}

/**
 * Lay b-roll-led shots on the music's beat grid: each shot ends on a beat and runs
 * about `desired` seconds (never longer than its usable span). Talking pieces keep
 * their measured length. Every shot is judged the same way, the opening one too.
 * Returns how many shots landed on a beat the tracker heard.
 */
export function fitBrollToBeats(record: StoredVersion, track: MusicTrack | undefined, desired: (available: number) => number): number {
  const music = record.music, startS = music?.startS ?? 0;
  const { cutList, template } = record.assembly;
  // Without music there is no grid: shots just get their length.
  const heard = music && track?.beats?.length ? track.beats.filter(finite).map(b => b - startS).filter(b => b > 0).sort((a, b) => a - b) : [];
  const period = median(heard.slice(1).map((b, i) => b - heard[i]).filter(d => d > 0));
  const beats = beatGrid(heard, period, finite(track?.durationS) ? track.durationS - startS : heard.at(-1) ?? 0);
  const minimum = Number.isFinite(period) ? Math.max(.6, period * .9) : .6, fitted = new Map<number, number | null>();
  let cursor = 0, changed = false;
  for (const { piece, items } of cutPieceGroups(cutList)) {
    const length = items.reduce((n, c) => n + c.durTimelineFrames / template.fps, 0);
    const item = items[0];
    if (items.length !== 1 || !item.seg || item.seg.lineIndex !== null) { cursor += length; continue; }
    const rate = item.clipFpsR.num / item.clipFpsR.den;
    const available = Math.min(length, (item.seg.clip.meta?.durationS ?? item.seg.e) - item.inFrames / rate);
    const want = Math.max(minimum, Math.min(available, desired(available)));
    const choices = beats.filter(b => b.at - cursor >= minimum - 1e-6 && b.at - cursor <= available + 1e-6);
    const beat = choices.sort((a, b) => Math.abs(a.at - cursor - want) - Math.abs(b.at - cursor - want) || Number(b.heard) - Number(a.heard) || a.at - b.at)[0];
    const seconds = beat !== undefined ? beat.at - cursor : Math.min(available, want);
    const out = item.inFrames + Math.max(1, Math.round(seconds * rate));
    if (out <= item.inFrames) { cursor += length; continue; }
    changed ||= out !== item.outFrames;
    item.outFrames = out;
    item.durTimelineFrames = (out - item.inFrames) / rate * template.fps;
    cursor += item.durTimelineFrames / template.fps;
    fitted.set(piece, beat?.heard ? beat.at + startS : null);
  }
  if (changed || fitted.size) retime(record, fitted);
  return [...fitted.values()].filter(b => b !== null).length;
}

const stop = new Set("a an and are as at be but by for from has have i in is it its it's just me my of on or our so that the their then there this to was we were with you your".split(" "));
const terms = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']+/g)?.filter(w => w.length > 2 && !stop.has(w)) ?? []);
/** Voiceover: every line gets picture. Lines the model left uncovered get the unused b-roll whose description shares most words with them. */
export function coverLinesWithBroll(record: StoredVersion): number {
  const { shoot, template, cutList, reel } = record.assembly;
  const { broll } = reelIds(shoot);
  const used = new Set([...reel.cuts.map(c => c.id), ...reel.broll.map(b => b.id)]);
  const pieces = record.pieces ?? [];
  let added = 0;
  pieces.forEach((piece, voiceIndex) => {
    if (piece.kind !== "voice" || reel.broll.some(b => b.voiceIndex === voiceIndex)) return;
    const words = terms(piece.words ?? "");
    const candidates = [...broll].filter(([id, seg]) => !used.has(id) && Math.floor(seg.e * (seg.clip.meta?.fps || template.fps)) > Math.ceil(seg.s * (seg.clip.meta?.fps || template.fps)))
      .map(([id, seg], order) => ({ id, seg, order, score: [...terms(seg.marker)].filter(w => words.has(w)).length }))
      .sort((a, b) => b.score - a.score || (b.seg.e - b.seg.s >= piece.lengthS ? 1 : 0) - (a.seg.e - a.seg.s >= piece.lengthS ? 1 : 0) || a.order - b.order);
    const chosen = candidates[0];
    if (!chosen) return;
    used.add(chosen.id);
    reel.broll.push({ id: chosen.id, over: piece.id, voiceIndex, seg: chosen.seg });
    added++;
  });
  if (!added) return 0;
  reel.broll.sort((a, b) => a.voiceIndex - b.voiceIndex);
  reel.model = { ...reel.model, broll: reel.broll.map(({ id, over }) => ({ id, over })) };
  record.broll = reel.broll.map(({ id, over }) => ({ id, over }));
  const before = record.pieces ?? [];
  record.pieces = resolveReelPieces(shoot, template, cutList, reel).map((p, i) => ({ ...before[i], ...p, ...(before[i]?.words ? { words: before[i].words } : {}) }));
  return added;
}

/** Before the finish plan: structure the type depends on (b-roll under a voice, shots on beats). */
export function prepareVideoType(record: StoredVersion, type: VideoType, tracks: MusicTrack[], targetS: number): void {
  const track = record.music ? tracks.find(t => t.file === record.music!.file) : undefined;
  if (type === "voiceover") coverLinesWithBroll(record);
  if (type === "montage") {
    const pieces = record.pieces ?? [];
    const voiceS = pieces.filter(p => p.kind === "voice").reduce((n, p) => n + p.lengthS, 0);
    const shots = pieces.filter(p => p.kind === "broll").length;
    const each = shots ? Math.max(.6, (targetS - voiceS) / shots) : 2;
    fitBrollToBeats(record, track, available => Math.min(available, each));
  }
  // A vlog's b-roll keeps moving: about 3.5 s a shot, ending on a beat when there is music.
  if (type === "vlog") fitBrollToBeats(record, track, available => Math.min(available, 3.5));
}

/** The finish-plan fields a type defaults when the model leaves them out. The model's own choices always win. */
export function typePlanDefaults(type: VideoType, raw: unknown, record: StoredVersion, tracks: MusicTrack[]): unknown {
  if (type === "talking") return raw;
  const plan: Record<string, unknown> = object(raw) ? { ...raw } : {};
  const track = record.music ? tracks.find(t => t.file === record.music!.file) : undefined;
  if ((type === "montage" || type === "vlog") && plan.cutToBeat == null && track?.beats.length) plan.cutToBeat = true;
  if (type === "tutorial" && plan.energy === "punchy") plan.energy = "subtle";
  if (type === "montage" && plan.captions == null) plan.captions = false;
  if (type === "voiceover" && plan.captions == null) plan.captions = true;
  if (!object(raw) && !Object.keys(plan).length) return raw;
  return plan;
}

/** After the finish plan: picture and sound the type owns. Each default fills only what the model left empty. */
export function finishVideoType(record: StoredVersion, type: VideoType, raw: unknown, day: DayFacts | null, previousType?: VideoType): void {
  const warn = (field: string) => record.warnings.push(`Ignored finish ${field}.`);
  const plan = object(raw) ? raw : {};
  record.videoType = type;
  if (type === "montage" && record.music && record.assembly.reel.music && !record.pieces?.some(p => p.kind === "voice")) {
    // Music is the only sound: play it at the delivery level, not under a missing voice.
    const gainDb = Math.round(((record.audio?.loudnessLUFS ?? -14) - record.assembly.reel.music.musicLUFS) * 100) / 100;
    record.assembly.reel.music.gainDb = gainDb;
    record.music = { ...record.music, gainDb };
    record.warnings = record.warnings.filter(w => !w.startsWith("No voice in this cut; music uses a quiet"));
    record.assembly.reel.warnings = record.assembly.reel.warnings.filter(w => !w.startsWith("No voice in this cut; music uses a quiet"));
  }
  if (type === "tutorial" && plan.layouts === undefined) tutorialLayouts(record, plan.angles !== undefined);
  if (type === "vlog") {
    // Natural sound: lighter voice cleanup keeps the room, street and wind under talking.
    // A re-cut of a vlog keeps whatever the person has set since.
    if (record.audio && previousType !== "vlog") record.audio = { ...record.audio, denoise: Math.min(record.audio.denoise, .35) };
    naturalSoundJoins(record);
    if (plan.lowerThirds !== undefined) {
      try { record.lowerThirds = modelCards(record, plan.lowerThirds); }
      catch (error) { warn(`lowerThirds: ${error instanceof Error ? error.message : "invalid cards"}`); }
    } else if (day) {
      const cards = timeCards(record, day);
      if (cards.length) record.lowerThirds = cards;
    }
  }
}

/** Vlog: a talking piece's own sound trails 1 s into the b-roll after it and leads 0.5 s in from the b-roll before it. */
function naturalSoundJoins(record: StoredVersion): void {
  const pieces = record.pieces ?? [];
  if (pieces.length < 2) return;
  const joins = Array.from({ length: pieces.length - 1 }, (_, i) => record.joins?.[i] ?? null);
  let changed = false;
  for (let i = 0; i < joins.length; i++) {
    if (joins[i]) continue;
    const [a, b] = [pieces[i].kind, pieces[i + 1].kind];
    if (a === b) continue;
    joins[i] = { kind: "cut", sound: null, audio: a === "voice" ? { trailS: 1 } : { leadS: .5 } };
    changed = true;
  }
  if (!changed) return;
  const previous = record.joins;
  record.joins = joins;
  try { syncFxMetadata(record, planFx(record.assembly.cutList, record.assembly.template.fps, record)); }
  catch { record.joins = previous; }
}

function cardSpan(record: StoredVersion, piece: number): { s: number; e: number } | null {
  const fx = planFx(record.assembly.cutList, record.assembly.template.fps, record);
  const items = fx.items.filter(i => i.piece === piece);
  if (!items.length) return null;
  const start = items[0].startS, end = items.at(-1)!.endS;
  const s = start + Math.min(.3, (end - start) / 4), e = Math.min(end - .1, s + 2.4);
  return e - s >= .8 ? { s: Math.round(s * 1000) / 1000, e: Math.round(e * 1000) / 1000 } : null;
}
function modelCards(record: StoredVersion, raw: unknown): LowerThird[] | undefined {
  if (raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("expected a list");
  const pieces = record.pieces ?? [], cards: LowerThird[] = [];
  for (const [n, entry] of raw.entries()) {
    if (!object(entry) || typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 60) throw new Error("each card needs a short title");
    const index = typeof entry.piece === "string" && pieces.filter(p => p.id === entry.piece).length === 1 ? pieces.findIndex(p => p.id === entry.piece) : -1;
    const span = index >= 0 ? cardSpan(record, index) : null;
    if (!span) throw new Error("unknown or ambiguous piece, or a piece too short for a card");
    const subtitle = typeof entry.subtitle === "string" && entry.subtitle.trim() ? entry.subtitle.trim().slice(0, 80) : undefined;
    cards.push({ id: `vlog:${n}`, ...span, title: entry.title.trim(), ...(subtitle ? { subtitle } : {}), position: "left" });
  }
  return cards.length ? cards : undefined;
}
/** Measured clock-time cards: back at the start of the day after the hook, then at each new scene, never crowding (3.5 s apart). */
export function timeCards(record: StoredVersion, day: DayFacts): LowerThird[] {
  const pieces = record.pieces ?? [];
  const multiDay = new Set([...day.clips.values()].flatMap(c => c.local ? [c.local.slice(0, 10)] : [])).size > 1;
  const cards: LowerThird[] = [];
  let lastScene: number | null = null, lastAt = -Infinity;
  pieces.forEach((piece, index) => {
    const facts = day.clips.get(piece.clipId);
    const scene = facts?.scene ?? null;
    const fresh = index > 0 && facts?.local && scene !== lastScene;
    if (index === 0 || !fresh) { lastScene = scene; return; }
    lastScene = scene;
    const span = cardSpan(record, index);
    if (!span || span.s - lastAt < 3.5 || cards.length >= 6) return;
    const local = new Date(Date.parse(`${facts!.local}:00`) + piece.s * 1000);
    const stamp = localStamp(local);
    cards.push({ id: `vlog:time:${index}`, ...span, title: multiDay ? `${dayText(stamp)}, ${clockText(stamp)}` : clockText(stamp), position: "left" });
    lastAt = span.s;
  });
  return cards;
}

/** Tutorial: where a talking piece has a screen recording on the same clock, show the screen with the face in a corner. */
function tutorialLayouts(record: StoredVersion, modelAngles: boolean): void {
  const { shoot } = record.assembly;
  const pieces = record.pieces ?? [];
  const layouts: (LayoutChoice | null)[] = Array.from({ length: pieces.length }, (_, i) => record.layouts?.[i] ?? null);
  let seeded = 0;
  pieces.forEach((piece, index) => {
    if (piece.kind !== "voice" || layouts[index]) return;
    const group = shoot.angles?.find(g => g.clips.some(c => c.clipId === piece.clipId));
    const camera = group?.clips.find(c => c.clipId === piece.clipId);
    const screen = group?.clips.find(c => c.kind === "screen" && c.clipId !== piece.clipId);
    if (!group || !camera || !screen) return;
    const s = Math.round((piece.s + camera.offsetS - screen.offsetS) * 1000) / 1000;
    try {
      const layout = validateLayout({ kind: "bubble", screen: { clipId: screen.clipId, s }, bubble: { corner: "br", size: .3 } }, record, index);
      if (layout) { layouts[index] = layout; seeded++; }
    } catch { /* no screen picture for this span */ }
  });
  if (!seeded) return;
  record.layouts = layouts;
  // The layout shows the screen with the face; automatic switches to the bare screen would hide the face.
  if (!modelAngles && record.angleCuts?.length) {
    const screens = new Set(shoot.angles?.flatMap(g => g.clips.filter(c => c.kind === "screen").map(c => c.clipId)) ?? []);
    const kept = record.angleCuts.filter(c => !screens.has(c.clipId)).filter((c, i, all) => i === 0 || all[i - 1].clipId !== c.clipId);
    if (kept.length) record.angleCuts = kept; else delete record.angleCuts;
  }
  if (!record.assembly.reel.why.includes(layoutReadme)) record.assembly.reel.why += `\n\n${layoutReadme}`;
}
