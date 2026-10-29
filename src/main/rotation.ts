// RT1: quiet, coalesced picture rebuilds. Never clear the last usable picture.
import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Shoot } from "../shared/schema";
import { clipRotation, clipRotationFilter, displayedClip } from "../shared/media";
import { runActivity, withRenderSlot } from "./activity";
import { governor } from "./resource-governor";
import { makeShootProxies } from "./proxies";
import { makeStandInStrips } from "./thumbnails";
import { stepsChanged } from "./steps";
import { tool, toolEnvironment } from "./tools";

const pending = new Map<string, { again: boolean; promise: Promise<void> }>();
export function queueClipPictures(root: string): Promise<void> {
  root = path.resolve(root);
  const existing = pending.get(root);
  if (existing) { existing.again = true; return existing.promise; }
  const state = { again: false, promise: Promise.resolve() };
  state.promise = Promise.resolve().then(async () => {
    do {
      state.again = false;
      try {
        await rebuildStills(root);
        await makeShootProxies(root);
        await makeStandInStrips(root);
        stepsChanged(root);
      } catch (error) { if (!state.again) throw error; }
    } while (state.again);
  }).finally(() => { if (pending.get(root) === state) pending.delete(root); });
  pending.set(root, state);
  return state.promise;
}

async function rebuildStills(root: string): Promise<void> {
  const index = path.join(root, ".sidething/index.json");
  const shoot = JSON.parse(fs.readFileSync(index, "utf8")) as Shoot;
  for (const raw of shoot.clips) {
    const clip = displayedClip(raw);
    if (!clip.meta || clip.stage === "error") continue;
    const source = path.resolve(root, clip.file), stat = fs.statSync(source);
    if (!fs.realpathSync(source).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("Invalid original path.");
    const key = createHash("sha256").update(JSON.stringify([clip.file, stat.size, stat.mtimeMs,
      clipRotation(clip), clipRotationFilter(clip), clip.meta.pictureProfile, "stills-v1"])).digest("hex");
    const dir = path.join(root, ".sidething/frames");
    const selectedTimes = clip.frames.map(f => f.match(/_t(\d+(?:\.\d+)?)\.jpg$/)?.[1]);
    const smart = selectedTimes.length > 0 && selectedTimes.every(t => t !== undefined);
    const times = smart ? selectedTimes.map(Number) : Array.from({ length: 8 }, (_, n) => (n + .5) * clip.meta!.durationS / 8);
    const frames = times.map((t, n) => `${clip.id}-${key}-${n}${smart ? `_t${t.toFixed(3)}` : ""}.jpg`);
    const savedTurn = (raw as typeof raw & { _framesRotation?: number })._framesRotation;
    if (savedTurn === clipRotation(clip) && clip.frames?.length === times.length && clip.frames.every(f => fs.existsSync(path.join(dir, f)))) continue;
    if (clip.frames?.every((f, n) => f === frames[n] && fs.existsSync(path.join(dir, f))) && clip.frames.length === times.length) continue;
    await runActivity({ kind: "process", root, target: { clipId: clip.id }, label: "Preparing picture", cancelable: true }, activity =>
      withRenderSlot(activity, async () => {
        await governor.whenMemoryAllows(activity.signal);
        const release = await governor.acquireDecode(activity.signal);
        try {
          fs.mkdirSync(dir, { recursive: true });
          for (const [n, name] of frames.entries()) {
            activity.signal.throwIfAborted();
            const dest = path.join(dir, name);
            if (fs.existsSync(dest)) continue;
            const temporary = `${dest}.${randomUUID()}.jpg`;
            const lift = /log/i.test(clip.meta!.pictureProfile ?? "") ? ",eq=contrast=1.35:saturation=1.4:gamma=0.85" : "";
            try {
              await promisify(execFile)(tool("ffmpeg"), ["-v", "error", "-nostdin", "-y", "-threads", "1", "-ss", String(times[n]),
                "-i", source, "-filter_threads", "1", "-vf", `${clipRotationFilter(clip)}scale=480:-2${lift}`, "-frames:v", "1", "-q:v", "3", temporary],
              { env: toolEnvironment(), signal: activity.signal });
              fs.renameSync(temporary, dest);
            } finally { fs.rmSync(temporary, { force: true }); }
          }
          // No await between fresh read and atomic write: preserve concurrent tags.
          const fresh = JSON.parse(fs.readFileSync(index, "utf8")) as Shoot;
          const live = fresh.clips.find(c => c.id === clip.id && c.file === clip.file);
          const now = fs.statSync(source);
          if (!live || clipRotation(live) !== clipRotation(clip) || stat.size !== now.size || stat.mtimeMs !== now.mtimeMs) return;
          live.frames = frames; live.meta = displayedClip(live).meta;
          (live as typeof live & { _framesRotation?: number })._framesRotation = clipRotation(clip);
          fresh.updatedAt = new Date().toISOString();
          const temporary = `${index}.${randomUUID()}.tmp`;
          try { fs.writeFileSync(temporary, JSON.stringify(fresh, null, 1)); fs.renameSync(temporary, index); }
          finally { fs.rmSync(temporary, { force: true }); }
        } finally { release(); }
      }, "draft"), { renderLane: "draft" });
  }
}
