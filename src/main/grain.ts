import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { GrainChoice } from "../shared/schema";
import { grainTileFilter } from "../renderer/src/components/finish/grainMath";
import { currentActivity } from "./activity";
import { tool } from "./tools";

/** Small, lossless grain plate. Only our cache is written. Generation inherits
 * the existing render slot, low priority, cancellation and playback preemption. */
export async function prepareGrainPlate(root: string, grain: GrainChoice | null | undefined, width: number, height: number): Promise<string | undefined> {
  if (!grain?.amount) return undefined;
  const graph=grainTileFilter(grain);
  const key=createHash("sha256").update(JSON.stringify({revision:2,graph,preset:grain.preset,size:grain.size,width,height})).digest("hex");
  const directory=path.join(root,".sidething","finish-cache"),file=path.join(directory,`grain-${key}.ppm`);
  try { const saved=await fs.readFile(file); if (saved.length===96*96*6+15 && saved.subarray(0,15).toString()==="P6\n96 96\n65535\n") return file; } catch { /* generate */ }
  await fs.mkdir(directory,{recursive:true});
  const temporary=path.join(directory,`grain-${key}-${randomUUID()}.ppm`);
  try {
    await promisify(execFile)(tool("ffmpeg"),["-v","error","-y","-filter_threads","1","-f","lavfi","-i",graph,"-frames:v","1","-pix_fmt","rgb48be","-update","1",temporary],
      {signal:currentActivity()?.signal,killSignal:"SIGKILL",timeout:30_000});
    currentActivity()?.signal.throwIfAborted();
    await fs.rename(temporary,file);
    return file;
  } finally { await fs.rm(temporary,{force:true}); }
}
