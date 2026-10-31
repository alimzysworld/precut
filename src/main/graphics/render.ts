import { app, type BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { bundledFile } from "../bundle-paths";
import { createHash, randomUUID } from "node:crypto";
import type { MotionGraphic } from "../../shared/schema";
import { currentActivity, withRenderSlot } from "../activity";
import { GraphicError, graphicKey } from "./sanitize";
import { captureFrame, captureWindow, framePng, withinBudget } from "../capture-frame";

// GFX1: stills of a graphic, drawn by the same title page that plays it live and renders the export, so what the
// agent and the person see here is what ends up in the video. One hidden window at a time; a graphic that stops
// answering is stopped for good by closing its window.
const TOO_SLOW = "That graphic took too long to draw. It may be stuck in a loop; keep render(t, el) short and a pure function of t.";

type Page = { run: (code: string) => Promise<unknown>; capture: (t: number) => Promise<Buffer>; window: BrowserWindow };
const tooSlow = () => new GraphicError(TOO_SLOW);

function plainError(error: unknown): GraphicError {
  if (error instanceof GraphicError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/took too long/i.test(message)) return new GraphicError(TOO_SLOW);
  const script = /The graphic's script failed: (.*)/.exec(message);
  if (script) return new GraphicError(`The graphic's js failed: ${script[1]}`);
  return new GraphicError("Couldn't draw that graphic. Check its html, css and js.");
}

async function withPage<T>(width: number, height: number, graphic: MotionGraphic, backdrop: string | null, root: string | null, work: (page: Page, stage: { width: number; height: number }) => Promise<T>): Promise<T> {
  await app.whenReady();
  // CAP3: the shared capture window (one row taller than the still, for the capture token).
  const window = captureWindow(width, height, 60);
  const signal = currentActivity()?.signal, stop = () => { if (!window.isDestroyed()) window.destroy(); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    await window.loadFile(bundledFile("titles/template.html"));
    // PRO4b: a card's picture comes from its shoot's cache; with no shoot (the frame check) it is drawn as an empty picture.
    const media = graphic.media ? root ? { mediaData: await (await import("../overlays")).cardMediaData(root, graphic.media) } : { mediaBlank: true } : {};
    const item = { id: "preview", file: "", url: "", graphic, s: 0, e: graphic.durationS + 1, x: 0.5, y: 0.5, w: 1, corner: "square", enter: "none", exit: "none", sound: null, ...media };
    const track = { font: "Outfit", cues: [], prompt: null, skillIds: [] };
    const run = (code: string) => withinBudget(window, window.webContents.executeJavaScript(code), tooSlow);
    await run(`window.titleRenderer.init(${JSON.stringify(track)}, ${JSON.stringify({ width, height, layer: "all", overlays: [item] })})`);
    if (backdrop) await run(`document.body.style.background=${JSON.stringify(backdrop)}`);
    // CAP3: the still at t and only that frame. A capture straight after the seek could be the frame before it (the
    // previous still, or the page before its first seek): captureFrame checks the seek's token and captures again.
    const capture = async (t: number) => framePng(await captureFrame(window, width, height, t, tooSlow), width, height);
    return await work({ run, capture, window }, { width, height });
  } catch (error) { throw plainError(error); }
  finally { signal?.removeEventListener("abort", stop); stop(); }
}

/** The size a graphic is drawn at for stills and checks: its design size, no wider than maxWidth. */
export function stillSize(graphic: MotionGraphic, maxWidth = 960): { width: number; height: number } {
  const width = Math.min(graphic.widthPx, maxWidth);
  return { width, height: Math.max(2, Math.round(graphic.heightPx * width / graphic.widthPx)) };
}
const slot = <T>(work: () => Promise<T>): Promise<T> => { const activity = currentActivity(); return activity ? withRenderSlot(activity, work) : work(); };

/** PNG stills (transparent unless a backdrop colour is given) at the given seconds into the graphic. */
export function renderGraphicStills(graphic: MotionGraphic, times: number[], options: { maxWidth?: number; backdrop?: string | null; root?: string | null } = {}): Promise<Buffer[]> {
  const { width, height } = stillSize(graphic, options.maxWidth);
  return slot(() => withPage(width, height, graphic, options.backdrop ?? null, options.root ?? null, async ({ capture }) => {
    const out: Buffer[] = [];
    for (const t of times) out.push(await capture(Math.max(0, Math.min(graphic.durationS, t))));
    return out;
  }));
}

/** Runs every sampled frame under the time budget. Throws a GraphicError in plain words when the graphic cannot be drawn. */
export function vetGraphic(graphic: MotionGraphic): Promise<void> {
  const { width, height } = stillSize(graphic, 480);
  const samples = Math.max(8, Math.min(90, Math.round(graphic.durationS * 12)));
  return slot(() => withPage(width, height, graphic, null, null, async ({ run }) => {
    for (let i = 0; i <= samples; i++) await run(`window.titleRenderer.seek(${(graphic.durationS * i / samples).toFixed(4)})`);
  }));
}

/** The picture shown for a graphic in lists and for its handles: the finished state, at its design shape. Named like the other overlay images. */
export async function graphicPoster(root: string, graphic: MotionGraphic): Promise<string> {
  // CAP3: revision 2: a poster drawn before the capture token could be the page before its seek; none is reused.
  const file = `${createHash("sha256").update(JSON.stringify({ revision: 2, graphic: graphicKey(graphic) })).digest("hex").slice(0, 16)}.png`;
  const destination = path.join(root, ".sidething", "overlays", file);
  if (await fs.stat(destination).then(s => s.size > 0, () => false)) return file;
  const [png] = await renderGraphicStills(graphic, [Math.max(0, graphic.durationS - 0.6)], { maxWidth: 640, root });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, png); await fs.rename(temporary, destination); } finally { await fs.rm(temporary, { force: true }); }
  return file;
}
