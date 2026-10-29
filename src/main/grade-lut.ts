// HL1: precut's grade, ready for another editor without running an export. For a clip, or for one piece of an edit,
// write the same composed LUT the editor exports write (editor-colour.ts: camera conversion, measured balance and the
// look, composed into one .cube) and say how to apply it. Optionally render precut's own graded frame at one source
// time with the finishing compositor's filter, so the LUT can be checked against what precut shows.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Clip, CutVersion } from "../shared/schema";
import { balancedLook } from "../shared/clip-balance";
import { clipRotationFilter } from "../shared/media";
import { originalSpan, type OriginalSpan } from "./interop";

export interface GradeLut {
  clipId: string; piece: number | null; cutId: string | null; version: number | null;
  lut: string;                 // absolute path of the composed .cube
  stages: string[];            // the separate stage tables (camera conversion, balance, look), for editors that stack them
  decode: string;              // the ffmpeg decode the LUT expects before it (YCbCr to full-range RGB for this camera)
  ffmpegFilter: string;        // ready to use: -vf "<this>" on the original applies precut's grade
  look: string;                // the gallery look this grade follows
  still: { path: string; atS: number } | null;  // precut's own graded frame (finishing compositor filter), when asked
  original: OriginalSpan;
}

const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", d => { stderr = (stderr + d).slice(-2000); });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolve() : reject(new Error(`Could not render the graded frame. ${stderr.trim().split("\n").at(-1) ?? ""}`)));
});
const escapeFilter = (file: string) => file.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,");

export async function gradeLut(root: string, args: { cut?: string; version?: number; piece?: number; clipId?: string; atS?: number }): Promise<GradeLut> {
  const grade = await import("./grade"), { getPreferences } = await import("./settings");
  const cache = path.join(root, ".sidething", "finish-cache");
  let clip: Clip, s: number, e: number, look, neighbours, piece: number | null = null, cutId: string | null = null, version: number | null = null, lookName: string;
  if (args.cut !== undefined) {
    if (args.piece === undefined) throw new Error("Choose a piece of this edit (piece, zero-based), or a clipId.");
    const { listCuts, loadDraftVersion } = await import("./sidekick"), { newestListed, versionOr } = await import("./revisions");
    const entry = (await listCuts(root)).find(c => c.cutId === args.cut);
    if (!entry) throw new Error("Could not find that edit. Use list_cuts to find its id.");
    version = await versionOr(root, entry.cutId, args.version, newestListed(entry));
    const saved = entry.versions.find(v => v.version === version) as CutVersion | undefined;
    if (!saved) throw new Error("Could not find that edit version.");
    const record = await loadDraftVersion(root, entry.cutId, saved.version);
    const cuts = record.assembly.cutList, fps = record.assembly.template.fps;
    const item = cuts.find((c, i) => (c.piece ?? i) === args.piece && c.seg);
    if (!item?.seg) throw new Error("That piece has no camera picture to grade. Choose another piece.");
    clip = record.assembly.shoot.clips.find(c => c.id === item.seg!.clip.id) ?? item.seg.clip;
    const rate = item.clipFpsR.num / item.clipFpsR.den;
    s = item.inFrames / rate; e = s + item.durTimelineFrames / fps;
    const g = record.grade ?? grade.gradeForLook("unknown", (await getPreferences()).look);
    const setting = record.angleCuts?.length ? (await import("./angles")).angleFxPiece(record, clip.id, args.piece) : args.piece;
    look = grade.gradeForPiece(g, balancedLook(record, clip.id, setting));
    neighbours = grade.exposureSpans(cuts, record.assembly.reel.broll, fps);
    piece = args.piece; cutId = entry.cutId; lookName = g.preset ?? "clean";
  } else {
    if (!args.clipId) throw new Error("Choose a clipId, or an edit (cut) and its piece.");
    const shoot = await (await import("./ask-read")).readShoot(root);
    const found = shoot.clips.find(c => c.id === args.clipId);
    if (!found?.meta || found.photo) throw new Error("Choose a video clip from list_clips.");
    clip = found; s = 0; e = found.meta.durationS;
    // A clip outside any edit gets the look new edits start with, and its saved per-clip balance when it has one.
    const g = grade.gradeForLook("unknown", (await getPreferences()).look);
    const balance = await (await import("./balance")).readClipBalance(root, clip.id);
    look = grade.gradeForPiece(g, balancedLook({ balances: balance ? { [clip.id]: balance } : undefined } as Pick<CutVersion, "balances" | "pieceFx">, clip.id, 0));
    lookName = g.preset ?? "clean";
  }
  const options = { root, s, e, ...(neighbours ? { neighbours } : {}) };
  const recipe = await grade.editorPieceLuts(clip, look, cache, options);
  const folder = path.join(root, ".sidething", "luts");
  await fs.mkdir(folder, { recursive: true });
  const name = `${cutId ? `${cutId}-v${version}-piece-${piece! + 1}` : clip.id.replace(/[^\w.-]+/g, "_")}-${createHash("sha256").update(recipe.composed).digest("hex").slice(0, 10)}`;
  const lut = path.join(folder, `${name}.cube`);
  await fs.writeFile(lut, recipe.composed);
  const conversion = await grade.cameraConversionFilter(clip, cache);
  const decode = conversion.split(",lut3d=")[0];
  const ffmpegFilter = `${decode},lut3d=file='${escapeFilter(lut)}':interp=tetrahedral`;
  let still: GradeLut["still"] = null;
  if (args.atS !== undefined) {
    if (!(args.atS >= s && args.atS <= e)) throw new Error(`Choose atS inside the span, ${s.toFixed(2)} to ${e.toFixed(2)} source seconds.`);
    const filter = await grade.pieceGradeFilter(clip, look, cache, options);
    const file = path.join(folder, `${name}-t${args.atS.toFixed(3)}.png`);
    const source = path.join(root, clip.file);
    await run((await import("./tools")).tool("ffmpeg"), ["-v", "error", "-y", "-ss", String(args.atS), "-i", source, "-frames:v", "1",
      "-vf", `${filter},${clipRotationFilter(clip)}format=rgb24`, file]);
    still = { path: file, atS: args.atS };
  }
  return { clipId: clip.id, piece, cutId, version, lut, stages: recipe.stages, decode, ffmpegFilter, look: lookName, still, original: originalSpan(root, clip, s, e) };
}
