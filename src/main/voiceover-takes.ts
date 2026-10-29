// Read-only queries never load microphone capture or register app lifecycle hooks.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AudioFile, Shoot } from "../shared/schema";

/** FIX2: new takes are kept with precut's own data, never in the exports folder where clearing out exports
 * would delete them. Takes recorded earlier stay in `sidething precuts/recordings` and keep working there. */
export const TAKES_FOLDER = ".sidething/recordings";
const TAKE_FILE = /(?:^|[\\/])(?:sidething precuts|\.sidething)[\\/]recordings[\\/]([^\\/]+\.wav)$/i;
/** A voiceover take recorded or dropped in by precut, in either folder. */
export const isTakeFile = (file: string): boolean => TAKE_FILE.test(file);
/** FIX2: a take file that is gone, in plain words that name the take and where it belongs. Keeps code ENOENT. */
export function missingTakeError(file: string): Error & { code: string; path: string } {
  const name = TAKE_FILE.exec(file)?.[1] ?? file.split(/[\\/]/).at(-1) ?? file;
  const folder = /(?:^|[\\/])\.sidething[\\/]recordings[\\/][^\\/]+$/i.test(file) ? ".sidething/recordings" : "sidething precuts/recordings";
  const stamp = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})(?:\.\d+)? [0-9a-f]{8}\.wav$/i.exec(name);
  const when = stamp ? new Date(Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6])) : null;
  const label = when && !Number.isNaN(when.getTime())
    ? `from ${when.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} at ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`
    : `"${name.replace(/ [0-9a-f]{8}\.wav$/i, "").replace(/\.wav$/i, "")}"`;
  return Object.assign(new Error(`Your voiceover take ${label} is missing. Put "${name}" back in the shoot's ${folder} folder, then try again.`), { code: "ENOENT", path: file });
}

async function read<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
export async function listVoiceovers(root: string): Promise<AudioFile[]> {
  const [index, journal] = await Promise.all([
    read<Shoot | null>(path.join(root, ".sidething/index.json"), null),
    read<AudioFile[]>(path.join(root, ".sidething/voiceovers.json"), []),
  ]);
  const takes = new Map((index?.audio ?? []).filter(a => a.role === "voiceover").map(a => [a.file, a]));
  for (const take of journal) {
    takes.set(take.file, { ...take, transcript: take.transcript ?? takes.get(take.file)?.transcript ?? null });
  }
  return [...takes.values()];
}

/** A take saved on Stop is transcribed in the background. Placement waits for
 * that same work (never a second copy) and reports its failure in plain words. */
const transcribing = new Map<string, Promise<unknown>>();
let transcriber: ((root: string, file: string) => Promise<unknown>) | undefined;
const takeKey = (root: string, file: string) => JSON.stringify([path.resolve(root), file]);
export function trackTranscript(root: string, file: string, work: Promise<unknown>): void {
  const key = takeKey(root, file);
  transcribing.set(key, work);
  void work.catch(() => {}).finally(() => { if (transcribing.get(key) === work) transcribing.delete(key); });
}
export function setTranscriber(start: (root: string, file: string) => Promise<unknown>): void { transcriber = start; }
export async function waitForTranscript(root: string, file: string): Promise<void> {
  const real = await fs.realpath(root).catch(() => path.resolve(root));
  const pending = transcribing.get(takeKey(real, file)) ?? transcribing.get(takeKey(root, file));
  if (pending) { await pending; return; }
  const take = (await listVoiceovers(root)).find(t => t.file === file);
  // A take left untranscribed by a quit or a failure gets one fresh attempt.
  if (take && take.transcript == null && transcriber) await transcriber(real, file);
}
