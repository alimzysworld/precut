// HL1: precut's footage reads travel to other tools (DaVinci Resolve's MCP, ffmpeg, a script). Every read that names a
// clip span also says, additively, where that span lives in the ORIGINAL file: its absolute path (never a proxy), source
// in and out in seconds and as timecode at the clip's own frame rate, the frame rate, the rotation and the camera's
// timecode start when it has one. Nothing here changes what a read already returned.
import * as path from "node:path";
import type { Clip, Shoot } from "../shared/schema";
import { clipFilterTurn, clipRotation } from "../shared/media";

export interface OriginalSpan {
  file: string;                 // absolute path of the camera original
  s: number; e: number;         // source seconds in that file (0 = its first frame)
  inTC: string; outTC: string;  // the same span as timecode at timecodeRate, counted from startTimecode (or 00:00:00:00)
  fps: number;                  // the clip's measured frame rate
  timecodeRate: number;         // whole frames per timecode second (the rounded frame rate, as editors count it)
  startTimecode: string | null; // the camera's timecode at the first frame, when it recorded one
  rotation: 0 | 90 | 180 | 270; // clockwise turn that shows the picture upright, from the stored frame
  fileRotation: number;         // what the file's own orientation tag already turns (players and editors apply it)
  extraTurn: 0 | 90 | 180 | 270;// what precut adds on top of the file's tag (a person's or the judge's turn)
  sound?: { file: string; offsetS: number } | null;  // a separate recorder synced to this clip: its file and the time at clip 0
}

const pad = (n: number) => String(n).padStart(2, "0");
function timecode(frames: number, rate: number): string {
  const f = Math.max(0, Math.round(frames)), secs = Math.floor(f / rate);
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(f % rate)}`;
}

/** The original-file description of one clip span. */
export function originalSpan(root: string, clip: Clip, s: number, e: number): OriginalSpan {
  const fps = clip.meta?.fps && Number.isFinite(clip.meta.fps) && clip.meta.fps > 0 ? clip.meta.fps : 25;
  const rate = Math.max(1, Math.round(fps));
  const start = clip.meta?.startTimecode ?? null;
  const parts = (start ?? "00:00:00:00").split(/[:;]/).map(Number);
  const origin = parts.length === 4 && parts.every(Number.isFinite) ? ((parts[0] * 3600 + parts[1] * 60 + parts[2]) * rate) + parts[3] : 0;
  // Frames of the clip itself, at its own rate; the timecode counts them in whole-frame seconds as editors do.
  const inFrame = Math.floor(s * fps + 1e-6), outFrame = Math.ceil(e * fps - 1e-6);
  const file = clip.photo?.file ?? clip.file;
  return {
    file: path.isAbsolute(file) ? file : path.join(root, file), s, e,
    inTC: timecode(origin + inFrame, rate), outTC: timecode(origin + outFrame, rate),
    fps, timecodeRate: rate, startTimecode: start,
    rotation: clipRotation(clip), fileRotation: clip.meta?.containerRotation ?? clip.meta?.rotation ?? 0, extraTurn: clipFilterTurn(clip),
    ...(clip.sound ? { sound: { file: path.isAbsolute(clip.sound.file) ? clip.sound.file : path.join(root, clip.sound.file), offsetS: clip.sound.offsetS } } : {}),
  };
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
// Keys left as they are: values on the reel or edit clock (never source seconds of the clipId), and ready arguments.
// `source` is a ready argument (search_footage hits go straight into create_cut's from, whose schema allows no extra
// keys), so it passes through untouched; its hit already carries the original.
const UNTOUCHED = /^(atS|reelS|startS|endS|source)$/;

/** Walk a read's result and add `original` beside every clip span ({clipId, s, e} in source seconds), and beside every
 * clip row ({id, file}, or {clipId, name} without a span: the whole clip), and beside a shot's best take (bestTakeId). */
export function withOriginals<T>(root: string, shoot: Pick<Shoot, "clips">, result: T): T {
  const byId = new Map(shoot.clips.map(c => [c.id, c]));
  let budget = 200_000;
  const visit = (value: unknown, depth: number): unknown => {
    if (budget-- <= 0 || depth > 12 || !value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(v => visit(v, depth + 1));
    const item = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) out[k] = UNTOUCHED.test(k) ? v : visit(v, depth + 1);
    if (item.original !== undefined) return out;
    // A single word ({w, s, e}) shares its clip's file, rate and rotation with the line, piece or hit it belongs to,
    // which carries the original; repeating it on every word would bury the read.
    if (typeof item.w === "string") return out;
    const spanClip = typeof item.clipId === "string" ? byId.get(item.clipId) : undefined;
    const shotClip = typeof item.bestTakeId === "string" ? byId.get(item.bestTakeId) : undefined;
    if (spanClip && finite(item.s) && finite(item.e) && item.e > item.s && item.s >= 0 && item.clock !== "reel") {
      out.original = originalSpan(root, spanClip, item.s, item.e);
    } else if (spanClip?.meta?.durationS && !("s" in item) && (typeof item.name === "string" || typeof item.summary === "string")) {
      out.original = originalSpan(root, spanClip, 0, spanClip.meta.durationS);  // a clip row (list_takes shots, read_shot)
    } else if (shotClip?.meta?.durationS) {
      out.original = originalSpan(root, shotClip, 0, shotClip.meta.durationS);  // a shot's best take (list_moments)
    } else if (typeof item.id === "string" && typeof item.file === "string" && byId.get(item.id)?.meta?.durationS) {
      const clip = byId.get(item.id)!;
      out.original = originalSpan(root, clip, 0, clip.meta!.durationS);
    }
    return out;
  };
  return visit(result, 0) as T;
}

/** The MCP read path: annotate a read-only tool's result for its shoot. Image results and reads without a shoot pass
 * through, and a shoot whose index cannot be read leaves the result as it was. */
export async function annotateRead(args: Record<string, unknown>, result: unknown): Promise<unknown> {
  const value = typeof args.shoot === "string" ? args.shoot : typeof args.root === "string" ? args.root : null;
  if (!value || !result || typeof result !== "object" || "content" in (result as object)) return result;
  // Only a result that names clips is worth reading the shoot's index for.
  if (!/"(clipId|bestTakeId)":"|"id":"[^"]*","file":"/.test(JSON.stringify(result))) return result;
  try {
    const root = await (await import("./cli")).resolveShoot(value);
    const shoot = await (await import("./ask-read")).readShoot(root);
    return withOriginals(root, shoot, result);
  } catch { return result; }
}
