import type { Api, StarterTrack } from "../shared/schema";
import { AUDIO_FILE, playableMusic } from "./music-file";

// Imported tracks stay where they are. Only references live in app-owned settings.
async function referencesFile() {
  const { app } = await import("electron");
  const path = await import("node:path");
  return path.join(app.getPath("userData"), "music-tracks.json");
}
async function storedReferences(): Promise<string[]> {
  const fs = await import("node:fs/promises");
  try { const value: unknown = JSON.parse(await fs.readFile(await referencesFile(), "utf8")); return Array.isArray(value) ? value.filter((file): file is string => typeof file === "string") : []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
/** Every track the library lists beside the music folder: the person's own references, plus the starter tracks while they're on. */
export async function musicReferences(): Promise<string[]> {
  const stored = await storedReferences();
  const { starterMusicOn } = await import("./settings");
  if (typeof starterMusicOn !== "function" || !starterMusicOn()) return stored;
  const starter = await starterTracks().catch(() => []);
  return [...new Set([...stored, ...starter.map(track => track.file)])];
}

// ONB2: a few starter tracks ship with precut (build/music, CC0 or CC BY 4.0, licences in build/music/LICENSES.md),
// so a first edit can have music before the person has a folder of their own.
export async function starterDirectory(): Promise<string> {
  const { app } = await import("electron");
  const path = await import("node:path");
  return app.isPackaged ? path.join(process.resourcesPath, "music") : path.join(app.getAppPath(), "build/music");
}
export async function starterTracks(): Promise<StarterTrack[]> {
  const fs = await import("node:fs/promises"), path = await import("node:path");
  const directory = await starterDirectory();
  const listed: unknown = JSON.parse(await fs.readFile(path.join(directory, "tracks.json"), "utf8"));
  if (!Array.isArray(listed)) return [];
  const tracks: StarterTrack[] = [];
  for (const entry of listed as Record<string, unknown>[]) {
    if (typeof entry?.file !== "string" || entry.file.includes("/") || !audioFile.test(entry.file)) continue;
    const file = path.join(directory, entry.file);
    if (!(await fs.stat(file).catch(() => null))?.isFile()) continue;
    tracks.push({ file, title: String(entry.title ?? entry.file), artist: String(entry.artist ?? ""), licence: String(entry.licence ?? ""),
      credit: String(entry.credit ?? ""), mood: String(entry.mood ?? ""), durationS: Number(entry.durationS) || 0 });
  }
  return tracks;
}
export async function starterMusic(): Promise<{ on: boolean; tracks: StarterTrack[] }> {
  const { starterMusicOn } = await import("./settings");
  const tracks = (await starterTracks().catch(() => [])).map(track => ({ ...track, url: `st-media://local/music/${encodeURIComponent(track.file)}` }));
  return { on: starterMusicOn(), tracks };
}
export async function setStarterMusic(on: boolean): Promise<void> {
  await (await import("./settings")).setStarterMusic(on);
  (await import("./music-catalog")).invalidateMusicCatalog();
}
/** The credit owed for a starter track, or null for the person's own music. */
export async function starterCredit(file: string | null | undefined): Promise<string | null> {
  if (!file) return null;
  const path = await import("node:path");
  const resolved = path.resolve(file);
  return (await starterTracks().catch(() => [])).find(track => track.file === resolved)?.credit ?? null;
}
const audioFile = AUDIO_FILE;
let referenceQueue = Promise.resolve();
export function addMusicTracks(files: string[]): ReturnType<Api["addMusicTracks"]> {
  if (!Array.isArray(files) || files.some(file => typeof file !== "string" || file.includes("\0"))) return Promise.reject(new Error("Choose audio files."));
  const next = referenceQueue.then(async () => {
    const fs = await import("node:fs/promises"), path = await import("node:path");
    const usable: string[] = [];
    for (const file of files) {
      if (!path.isAbsolute(file) || !audioFile.test(file)) continue;
      if ((await fs.stat(file).catch(() => null))?.isFile()) usable.push(await fs.realpath(file));
    }
    const target = await referencesFile();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify([...new Set([...(await storedReferences()), ...usable])]) + "\n"); await fs.rename(temp, target); (await import("./music-catalog")).invalidateMusicCatalog(); }
    finally { await fs.unlink(temp).catch(() => {}); }
  });
  referenceQueue = next.catch(() => {});
  return next;
}
/** The one native audio picker: music tracks (several) and Add a recording (one voiceover file). */
export async function pickAudioFiles(multiple: boolean): Promise<string[]> {
  const { BrowserWindow, dialog } = await import("electron");
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = { properties: multiple ? ["openFile" as const, "multiSelections" as const] : ["openFile" as const], filters: [{ name: "Audio", extensions: ["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "opus", "mp4"] }] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths.slice(0, multiple ? undefined : 1);
}
export async function pickMusicTracks(): ReturnType<Api["pickMusicTracks"]> {
  const files = await pickAudioFiles(true);
  if (!files.length) return [];
  await addMusicTracks(files);
  return files;
}
/** Add a recording: one audio file (his DJI mic's), or null when he cancels. The file is only read; importTake copies it in. */
export async function pickVoiceoverFile(): Promise<string | null> {
  return (await pickAudioFiles(false))[0] ?? null;
}

/** ONB1b: the catalog path for an edit's music, so live plays what export uses. A file
 * outside the library that exists is added to its references (as a dropped track is);
 * a missing one gives null and both leave music out. */
export async function editMusicFile(root: string, file: string): Promise<string | null> {
  const path = await import("node:path"), fs = await import("node:fs/promises");
  if (!playableMusic(root, { file })) return null;
  const resolved = path.resolve(root, file), real = await fs.realpath(resolved).catch(() => resolved);
  const listed = async () => (await (await import("./music-catalog")).musicCatalog()).tracks.find(track => track.file === resolved || track.file === real)?.file ?? null;
  // VO7-4: music joining an edit gets its waveform peaks cached in that shoot, in the background.
  const warm = (track: string | null) => { if (track) void import("./peaks").then(m => m.warmPeaks(root, track, true), () => {}); return track; };
  const found = await listed();
  if (found) return warm(found);
  // Joins the library, then only this track is measured: never a wait on the whole library (see measureTrackNow).
  await addMusicTracks([resolved]);
  return warm(await (await import("./music-catalog")).measureTrackNow(real) ?? await listed());
}

// Legacy callers wait for the same cached catalog; the panel polls snapshots.
export async function listMusic(): ReturnType<Api["listMusic"]> {
  return (await import("./music-catalog")).measuredMusic();
}

// VO7-4: library tracks may be read for waveform peaks even though they live outside the shoot.
void import("./peaks").then(m => m.setLibraryTracks(async () => (await (await import("./music-catalog")).musicCatalog()).tracks.map(track => track.file)), () => {});
