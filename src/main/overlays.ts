import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dialog } from "electron";
import type { CutEdit, OverlayItem } from "../shared/schema";
import { finishStoredVersion, renderStoredPreview } from "./sidekick";
import { runActivity, withRenderSlot, currentActivity } from "./activity";
import { tool } from "./tools";
import { CARD_MEDIA } from "./graphics/templates";

type OverlayEdit = Extract<CutEdit, { kind: "overlay" }>;
const limit = 50 * 1024 * 1024;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const extensions = ["png", "jpg", "jpeg", "webp", "heic", "heif", "tif", "tiff", "gif"];
export async function pickOverlayFiles(): Promise<string[]> {
  const result = await dialog.showOpenDialog({ title: "Add image", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions }] });
  return result.canceled ? [] : result.filePaths;
}

// Inspect bytes, not just a user-controlled extension. Never accept SVG/HTML.
export function imageKind(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpg";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (/^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) return "gif";
  if (["49492a00", "4d4d002a", "49492b00", "4d4d002b"].includes(b.subarray(0, 4).toString("hex"))) return "tiff";
  if (b.toString("ascii", 4, 8) === "ftyp" && /(?:heic|heix|hevc|hevx|mif1|msf1)/.test(b.toString("ascii", 8, Math.min(b.length, 64)))) return "heic";
  return null;
}

export function overlayPath(root: string, file: string): string {
  if (!/^[a-f0-9]{16}\.(png|jpg|jpeg|webp)$/.test(file)) throw new Error("That image is not in this shoot's overlay cache.");
  return path.join(root, ".sidething", "overlays", file);
}
export function overlayUrl(root: string, file: string): string {
  overlayPath(root, file);
  return `st-media://local/${encodeURIComponent(root)}/overlays/${encodeURIComponent(file)}`;
}
/** PRO4b: a card's picture (graphics/sanitize.ts CARD_MEDIA) as the shoot cache serves it, for the title page to draw in. */
export function cardMediaUrl(root: string, media: string): string {
  if (!CARD_MEDIA.test(media)) throw new Error("That picture is not in this shoot's card cache.");
  return `st-media://local/${encodeURIComponent(root)}/overlays/${encodeURIComponent(media)}`;
}
/** PRO4b: a card's picture as a data image, read by main from that shoot's card cache, for the title pages main draws
 * (export, stills, posters): they never depend on the media protocol (the CLI and MCP don't register it). */
export async function cardMediaData(root: string, media: string): Promise<string> {
  if (!CARD_MEDIA.test(media)) throw new Error("That picture is not in this shoot's card cache.");
  const folder = path.join(root, ".sidething", "overlays"), file = path.join(folder, media);
  const real = await fs.realpath(file).catch(() => null), realFolder = await fs.realpath(folder).catch(() => null);
  if (!real || !realFolder || path.dirname(real) !== realFolder) throw new Error("That card's picture isn't in this shoot. Make the card again with add_card.");
  const bytes = await fs.readFile(real);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("That card's picture couldn't be read. Make the card again with add_card.");
  return `data:image/webp;base64,${bytes.toString("base64")}`;
}
/** PRO4b: the same, for an overlay main has already given its media URL (overlayMedia). */
export async function withCardData<T extends { graphic?: OverlayItem["graphic"]; mediaUrl?: string }>(items: T[]): Promise<(T & { mediaData?: string })[]> {
  return Promise.all(items.map(async item => {
    const media = item.graphic?.media, prefix = "st-media://local/", url = item.mediaUrl ?? "";
    if (!media) return item;
    const tail = `/overlays/${encodeURIComponent(media)}`;
    if (!url.startsWith(prefix) || !url.endsWith(tail)) throw new Error("That card's picture isn't in this shoot. Make the card again with add_card.");
    return { ...item, mediaData: await cardMediaData(decodeURIComponent(url.slice(prefix.length, -tail.length)), media) };
  }));
}
export function overlayMedia(root: string, items: OverlayItem[] = []): (OverlayItem & { url: string; mediaUrl?: string })[] {
  return items.map(item => ({ ...item, url: overlayUrl(root, item.file), ...(item.graphic?.media ? { mediaUrl: cardMediaUrl(root, item.graphic.media) } : {}) }));
}

export async function copyOverlay(root: string, source: string): Promise<string> {
  if (!currentActivity()) return runActivity({ kind: "edit", root, target: null, label: "Adding image", cancelable: true }, () => copyOverlay(root, source));
  if (!path.isAbsolute(source)) throw new Error("Choose an image file from your computer.");
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error("Choose an image file.");
  if (stat.size > limit) throw new Error("Choose an image smaller than 50 MB.");
  // Read at most the limit even if a file grows after stat.
  const handle = await fs.open(source, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    bytes = bytes.subarray(0, offset);
  }
  finally { await handle.close(); }
  if (bytes.length > limit) throw new Error("Choose an image smaller than 50 MB.");
  const kind = imageKind(bytes);
  if (!kind) throw new Error("Choose a PNG, JPG, WebP, HEIC, TIFF or GIF image.");
  const convert = !["png", "jpg", "webp"].includes(kind);
  const ext = convert ? "png" : kind;
  const file = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
  const destination = overlayPath(root, file);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (!convert) { await fs.writeFile(destination, bytes, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; }); return file; }
  return withRenderSlot(currentActivity()!, async () => {
    const signal = currentActivity()?.signal;
    signal?.throwIfAborted();
    const input = path.join(path.dirname(destination), `${randomUUID()}.${kind}`);
    const output = path.join(path.dirname(destination), `${randomUUID()}.png`);
    try {
      await fs.writeFile(input, bytes, { flag: "wx" });
      if (process.platform === "darwin" && kind !== "gif") {
        await promisify(execFile)("/usr/bin/nice", ["-n", "10", "/usr/bin/sips", "-s", "format", "png", input, "--out", output], { signal, timeout: 60_000 });
      } else {
        await promisify(execFile)(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-frames:v", "1", output], { signal, timeout: 60_000 });
      }
      signal?.throwIfAborted();
      if (imageKind(await fs.readFile(output)) !== "png") throw new Error("Could not convert that image. Try a PNG or JPG.");
      await fs.rename(output, destination);
      return file;
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error("Couldn't read that image. Try a PNG or JPG.", { cause: error });
    } finally { await fs.rm(input, { force: true }); await fs.rm(output, { force: true }); }
  }, "waited");
}

export function normalizeOverlay(item: OverlayItem, duration: number): OverlayItem {
  if (!(duration > 0) || ![item.s, item.e, item.x, item.y, item.w, item.rotate ?? 0].every(Number.isFinite)) throw new Error("Choose valid image times and position.");
  if (!["square", "round"].includes(item.corner) || !["pop", "slide-up", "fade", "none"].includes(item.enter) || !["pop", "fade", "none"].includes(item.exit) || (item.sound !== null && !["pop", "whoosh", "hit", "riser"].includes(item.sound))) throw new Error("Choose an image animation, corners and sound from the list.");
  const s = clamp(item.s, 0, Math.max(0, duration - Math.min(.04, duration)));
  return { id: item.id, file: item.file, s, e: clamp(item.e, s + Math.min(.04, duration), duration),
    x: clamp(item.x, 0, 1), y: clamp(item.y, 0, 1), w: clamp(item.w, .05, 1), rotate: clamp(item.rotate ?? 0, -180, 180), corner: item.corner, enter: item.enter, exit: item.exit, sound: item.sound,
    ...(item.graphic ? { graphic: item.graphic } : {}) };  // GFX1: a graphic was already sanitised and drawn once by prepareGraphic
}
export function editOverlays(root: string, cutId: string, version: number, edit: OverlayEdit): Promise<{ cutId: string; version: number }> {
  return runActivity({ kind: "edit", root, target: { cutId, version }, label: "Updating images", cancelable: true }, () =>
    finishStoredVersion(root, cutId, version, true, async (record, assembly) => {
      const items = [...(record.overlays ?? [])];
      const index = edit.op === "add" ? -1 : items.findIndex(item => item.id === edit.id);
      if (edit.op !== "add" && index < 0) throw new Error("That image is no longer in this version.");
      const duration = assembly.cutList.reduce((n, c) => n + c.durTimelineFrames / assembly.template.fps, 0);
      if (edit.op === "add") {
        const item = normalizeOverlay({ ...edit.item, id: randomUUID(), file: "" }, duration);
        if (item.graphic) { const { prepareGraphic } = await import("./graphics/edit"); const made = await prepareGraphic(root, item.graphic); item.graphic = made.graphic; item.file = made.file; }  // GFX1
        else item.file = await copyOverlay(root, edit.source);
        items.push(item);
      } else if (edit.op === "update") {
        const before = items[index];
        let next = normalizeOverlay({ ...before, ...edit.patch, id: before.id, file: before.file }, duration);
        if (next.graphic) {  // GFX1: a new composition, or a new length for a starter, is drawn and checked again
          const { prepareGraphic, fitGraphicToSpan } = await import("./graphics/edit");
          if (edit.patch.graphic === undefined && (edit.patch.s !== undefined || edit.patch.e !== undefined)) next = { ...next, graphic: fitGraphicToSpan(next.graphic!, next.e - next.s) };
          if (next.graphic !== before.graphic) { const made = await prepareGraphic(root, next.graphic); next = { ...next, graphic: made.graphic, file: made.file }; }
        }
        items[index] = next;
      } else items.splice(index, 1);
      record.overlays = items;
      record.assembly = assembly;
      await renderStoredPreview(root, cutId, record, assembly);
      return { cutId, version: record.version };
    }));
}

export function overlayReadme(items: OverlayItem[] = []): string {
  if (!items.length) return "";
  return "\n\nImages on top are visible in the finished video. This cuts-only timeline does not carry image placement, animations or their sounds. Add these cached stills manually on a top video track:\n" + items.map(o => o.graphic ? `Motion graphic${o.graphic.template ? ` (${o.graphic.template})` : ""}: ${o.s.toFixed(3)} to ${o.e.toFixed(3)} s; ${o.graphic.frame === "full" ? "full frame, covers the picture" : `centre ${o.x}, ${o.y}; width ${o.w}`}; ${o.graphic.layer === "behind" ? "behind the person" : "in front"}; animated, drawn from html, css and js (see graphics/ and Layers/ in the export)` : `.sidething/overlays/${o.file}: ${o.s.toFixed(3)} to ${o.e.toFixed(3)} s; centre ${o.x}, ${o.y}; width ${o.w}; rotation ${o.rotate ?? 0}; ${o.corner} corners; ${o.enter} in, ${o.exit} out; sound ${o.sound ?? "none"}`).join("\n");
}
