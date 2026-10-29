import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import type { Clip, Shoot } from "../shared/schema";
import { clipRotation } from "../shared/media";
import { runActivity, withRenderSlot } from "./activity";
import { governor } from "./resource-governor";
import { supportDir, toolEnvironment } from "./tools";

export function judgeFramePath(root: string, frame: string): string {
  const direct = path.join(root, ".sidething", frame);
  return fs.existsSync(direct) ? direct : path.join(root, ".sidething/frames", path.basename(frame));
}

// Reuse V1 selection and V4's decoded candidates when they are still available.
// Only this clip's pictures are rebuilt; no transcript, shake or proxy work.
const REPAIR = `
import json, runpy, sys
from pathlib import Path
p = runpy.run_path(sys.argv[1])
root, clip = Path(sys.argv[2]), json.loads(sys.argv[3])
from shared_visual import shared_visual
shared = shared_visual(root, clip, wait=False)
meta = clip['meta']
turn = (p['clip_rotation'](clip) - meta.get('containerRotation', 0)) % 360
frames = p['extract_frames'](root / clip['file'], clip['id'], float(meta['durationS']),
    'log' in (meta.get('pictureProfile') or '').lower(), root / '.sidething/frames',
    turn, clip.get('shake'), (shared['candidates'] or None) if shared else None)
print(json.dumps(frames))
`;

export async function ensureJudgeFrames(root: string, clip: Clip): Promise<void> {
  if (clip.frames.length && clip.frames.every(f => fs.existsSync(judgeFramePath(root, f)))) return;
  if (!clip.meta || clip.meta.width <= 0 || clip.meta.durationS <= 0) return;
  const source = path.resolve(root, clip.file);
  try {
    if (!fs.existsSync(source) || !fs.realpathSync(source).startsWith(fs.realpathSync(root) + path.sep)) return;
    const pipeline = [process.resourcesPath && path.join(process.resourcesPath, "pipeline/process.py"),
      path.join(app.getAppPath(), "pipeline/process.py")].find((file): file is string => !!file && fs.existsSync(file));
    if (!pipeline) return;
    const stat = fs.statSync(source), turn = clipRotation(clip);
    await runActivity({ kind: "process", root, target: { clipId: clip.id }, label: "Preparing picture", cancelable: true }, activity =>
      withRenderSlot(activity, async () => {
        await governor.whenMemoryAllows(activity.signal);
        const release = await governor.acquireDecode(activity.signal);
        try {
          const input = { id: clip.id, file: clip.file, meta: clip.meta, shake: clip.shake,
            byHand: { rotate: clip.byHand?.rotate }, judgement: { rotate: clip.judgement?.rotate } };
          const { stdout } = await promisify(execFile)(path.join(supportDir(), "venv/bin/python"), ["-I", "-B", "-c", REPAIR, pipeline, root, JSON.stringify(input)],
            { env: toolEnvironment(), signal: activity.signal, timeout: 15 * 60_000 });
          const frames: unknown = JSON.parse(stdout.trim());
          if (!Array.isArray(frames) || !frames.length || !frames.every(f => typeof f === "string" && fs.existsSync(judgeFramePath(root, f)))) return;
          // Fresh synchronous merge preserves tags and other clips changed during decoding.
          const index = path.join(root, ".sidething/index.json");
          const fresh = JSON.parse(fs.readFileSync(index, "utf8")) as Shoot;
          const live = fresh.clips.find(c => c.id === clip.id && c.file === clip.file);
          const now = fs.statSync(source);
          if (!live || clipRotation(live) !== turn || stat.size !== now.size || stat.mtimeMs !== now.mtimeMs) return;
          live.frames = frames; clip.frames = frames;
          Object.assign(live, { _framesRotation: turn, _smartFramesVersion: 1 });
          Object.assign(clip, { _framesRotation: turn, _smartFramesVersion: 1 });
          const temporary = `${index}.${randomUUID()}.tmp`;
          try { fs.writeFileSync(temporary, JSON.stringify(fresh, null, 1)); fs.renameSync(temporary, index); }
          finally { fs.rmSync(temporary, { force: true }); }
        } finally { release(); }
      }, "background"), { renderLane: "background" });
  } catch (error) {
    // The remaining cached pictures still tell the judge something useful.
    console.warn("[judge] Could not repair clip pictures:", clip.id, error);
  }
}
