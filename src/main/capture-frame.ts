import { BrowserWindow } from "electron";
import { endianness } from "node:os";

// CAP2/CAP3: one way the main process captures a frame of the title page (titles/template.html), shared by export
// titles and graphics (titles/render.ts), graphic stills and posters (graphics/render.ts) and cover titles (cover.ts).
// The seek's double requestAnimationFrame is not a guarantee that the compositor has drawn it: under load capturePage
// read the previous seek's frame (CAP2: 4.3% of export title captures). Each capture seek carries a fresh token that
// the page draws with the frame's content, in a strip one row below the frame (template.html markCapture); a capture
// that does not show the token is an older frame, so main waits for the compositor's next frame and captures again.

/** GFX1: a graphic that never returns (an endless loop) is stopped for good by destroying the window. */
export const FRAME_BUDGET_MS = 8000;
export async function withinBudget<T>(window: BrowserWindow, work: Promise<T>, tooSlow: () => Error = () => new Error('A graphic took too long to draw.')): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); reject(tooSlow()); }, FRAME_BUDGET_MS);
    })]);
  } finally { clearTimeout(timer); }
}

/** A hidden offscreen title window for capture. One row taller than the frame: the page draws each capture seek's
 * token in that row, and captureFrame reads it back. */
export function captureWindow(width: number, height: number, frameRate: number): BrowserWindow {
  const window = new BrowserWindow({ width, height: height + 1, useContentSize: true,
    show: false, transparent: true, backgroundColor: "#00000000", webPreferences: {
      offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
      // One CSS pixel per output pixel even on a Retina display.
      zoomFactor: 1 } });
  window.webContents.setFrameRate(frameRate);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return window;
}

const TOKEN_BITS = 16;   // = template.html TOKEN_BITS
const tokens = new WeakMap<BrowserWindow, number>();
/** The token in a capture's last row, the strip below the frame (template.html markCapture): each block's middle pixel,
 * white or black. null when the strip is not drawn (or not opaque) in this capture. */
function tokenOf(row: Buffer, width: number): number | null {
  const little = endianness() === "LE", alpha = little ? 3 : 0, green = little ? 1 : 2;
  if (row.length < width * 4) return null;
  let token = 0;
  for (let i = 0; i < TOKEN_BITS; i++) {
    const at = Math.floor((i + .5) * width / TOKEN_BITS) * 4;
    if (row[at + alpha] < 250) return null;
    if (row[at + green] > 127) token |= 1 << i;
  }
  return token;
}

/** The frame at t of a window made by captureWindow (and initialised by titleRenderer.init), and only that frame: a
 * width x height native bitmap (Chromium's premultiplied N32, as NativeImage.toBitmap gives it). The seek and every
 * capture until the frame's token shows run inside the frame budget.
 * CAP3: a graphic is a sandboxed frame in its own process, drawn apart from the page, so the page's token cannot vouch
 * for its pixels (two exports differed in a graphic a frame late). The page waits for each graphic to draw the seek
 * (template.html graphicHeader) and says how many show; then a frame is taken only when two token-checked captures,
 * a compositor frame apart, agree. */
export async function captureFrame(window: BrowserWindow, width: number, height: number, t: number,
  tooSlow?: () => Error, profile?: { stale: number; graphicStale?: number }): Promise<Buffer> {
  const token = ((tokens.get(window) ?? 0) + 1) % 2 ** TOKEN_BITS;
  tokens.set(window, token);
  return withinBudget(window, (async () => {
    const graphics = await window.webContents.executeJavaScript(`window.titleRenderer.seek(${t}, ${token})`);
    let held: Buffer | null = null;
    for (;;) {
      const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const size = image.getSize(), frameRows = Math.round(size.height * height / (height + 1));
      let frame: Buffer | null = null;
      if (size.width === width && size.height === height + 1) {
        // At one pixel per output pixel the strip is the bitmap's last row and the frame is everything above it.
        const bitmap = image.toBitmap({ scaleFactor: 1 });
        if (bitmap.length !== width * (height + 1) * 4) throw new Error("Unexpected title capture dimensions");
        if (tokenOf(bitmap.subarray(width * height * 4), width) === token) frame = bitmap.subarray(0, width * height * 4);
      } else if (tokenOf(image.crop({ x: 0, y: size.height - 1, width: size.width, height: 1 }).toBitmap({ scaleFactor: 1 }), size.width) === token) {
        // At the display's scale (2x on a Retina Mac) the token is read there, from the last row, and the frame above
        // the strip is cropped and brought to the output size.
        let cropped = image.crop({ x: 0, y: 0, width: size.width, height: frameRows });
        const croppedSize = cropped.getSize();
        if (croppedSize.width !== width || croppedSize.height !== height) cropped = cropped.resize({ width, height });
        frame = cropped.toBitmap({ scaleFactor: 1 });
        if (frame.length !== width * height * 4) throw new Error("Unexpected title capture dimensions");
      }
      if (frame) {
        if (!graphics || held?.equals(frame)) return frame;
        if (held && profile) profile.graphicStale = (profile.graphicStale ?? 0) + 1;
        held = frame;
      } else {
        if (window.isDestroyed()) throw new Error("Title window closed");
        if (profile) profile.stale++;
      }
      // A paint is a new compositor frame. invalidate() makes sure one comes; the timer only stops a lost event
      // from stalling the loop (withinBudget bounds it either way).
      await new Promise<void>(done => {
        const timer = setTimeout(finish, 100);
        function finish() { clearTimeout(timer); if (!window.isDestroyed()) window.webContents.off("paint", finish); done(); }
        window.webContents.once("paint", finish);
        window.webContents.invalidate();
      });
    }
  })(), tooSlow);
}

/** A captured frame (captureFrame's bitmap) as a PNG, straight alpha. nativeImage is loaded here, not at the top: the
 * title renderer shares this module and many test bundles stand in an Electron without it. */
export async function framePng(bitmap: Buffer, width: number, height: number): Promise<Buffer> {
  const { nativeImage } = await import("electron");
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
}
