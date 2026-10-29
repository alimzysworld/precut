import { playbackSource } from "./playback-source";
// Serves shoot cache media and tracks in the configured music catalog.
// registerMediaScheme() must run before app ready; registerMediaProtocol() after.
import { app, protocol } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { takeThumbnail } from "./thumbnails";
import { libraryFiles } from "./sound-design";
import { MEDIA_SCHEME } from "../shared/media";

const KINDS = new Set(["frames", "proxies", "judge", "precuts", "finish-cache", "overlays", "thumbs", "voice"]);

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

function shootsStorePath(): string {
  return path.join(app.getPath("userData"), "shoots.json");
}

function allowedRoots(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(shootsStorePath(), "utf8"));
    if (!Array.isArray(parsed)) return new Set();
    const roots = new Set<string>();
    for (const e of parsed) {
      if (typeof e === "object" && e !== null && typeof (e as { root?: unknown }).root === "string") {
        roots.add(path.resolve((e as { root: string }).root));
      }
    }
    return roots;
  } catch {
    return new Set();
  }
}

function fail(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

interface RangeResult {
  start: number;
  end: number;
}

function parseRange(header: string | null, size: number): RangeResult | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (size === 0) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Number(m[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "invalid";
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function handleMedia(request: Request): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fail(405, "method not allowed");
    }
    const url = new URL(request.url);
    if (url.hostname !== "local") return fail(404, "not found");
    const parts = url.pathname.split("/").slice(1);
    let target: string, kindDir: string, voiceRoot: string | undefined;
    if (parts.length === 2 && parts[0] === "sounds") {
      const id = decodeURIComponent(parts[1]);
      const sound = (await libraryFiles()).find(s => s.id === id);
      if (!sound) return fail(403, "not a library sound");
      target = sound.file; kindDir = path.dirname(target);
    } else if (parts.length === 2 && parts[0] === "music") {
      try { target = decodeURIComponent(parts[1]); } catch { return fail(400, "bad encoding"); }
      // ONB2: the bundled starter tracks play as previews on the first run, before the catalog has measured them.
      if (!(await (await import("./music-catalog")).musicCatalog()).tracks.some(track => track.file === target)
        && !(await (await import("./music")).starterTracks().catch(() => [])).some(track => track.file === target)) return fail(403, "not a catalog track");
      kindDir = path.dirname(target);
    } else {
      if (parts.length !== 3) return fail(404, "not found");
      const [encRoot, kind, encFile] = parts as [string, string, string];
      if (!KINDS.has(kind)) return fail(404, "not found");
      let rootRaw: string;
      let fileRaw: string;
      try {
        rootRaw = decodeURIComponent(encRoot);
        fileRaw = decodeURIComponent(encFile);
      } catch {
        return fail(400, "bad encoding");
      }
      if (!fileRaw) return fail(404, "not found");
      const root = path.resolve(rootRaw);
      if (!allowedRoots().has(root)) return fail(403, "not a known shoot");

      const sideDir = path.resolve(root, ".sidething");
      kindDir = path.resolve(sideDir, kind);
      target = path.resolve(kindDir, fileRaw);
      // Nothing outside <root>/.sidething/<kind>/ is ever served. This also
      // catches ../ and decoded %2F traversal before any file is touched.
      if (!isInside(target, sideDir) || !isInside(target, kindDir)) {
        return fail(403, "outside shoot media");
      }

      if (kind === "voice") {
        // IDs resolve only to a registered shoot's indexed voice sources. A URL
        // cannot select an arbitrary original or filesystem path.
        const index = JSON.parse(await fs.promises.readFile(path.join(sideDir, "index.json"), "utf8"));
        const clip = (index.clips as import('../shared/schema').Clip[]).find(c => c.id === fileRaw);
        const recording = fileRaw.startsWith('voiceover:') ? (await (await import('./voiceover-takes')).listVoiceovers(root)).find(t => t.file === fileRaw.slice(10)) : undefined;
        if (!clip && !recording) return fail(404, "unknown voice clip");
        target = recording ? path.resolve(root, recording.file) : playbackSource(root, clip!).file;
        if (!isInside(target,root)) return fail(403,"outside shoot voice sources");
        kindDir = root;
        voiceRoot = root;
      }

      if (kind === "thumbs") {
        if (!fileRaw.endsWith(".jpg")) return fail(404, "not found");
        try { target = await takeThumbnail(root, fileRaw.slice(0, -4), Number(url.searchParams.get("t") ?? 0), url.searchParams.get("size") === "24", url.searchParams.get("proxy") ?? undefined); }
        catch { return fail(404, "thumbnail unavailable"); }
      }

    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      return fail(404, "not found");
    }
    if (!stat.isFile()) return fail(404, "not found");

    // Symlink escape check: the real file must stay inside the real kind dir.
    try {
      const realTarget = await fs.promises.realpath(target);
      const realKind = await fs.promises.realpath(kindDir);
      if (!isInside(realTarget, realKind)) return fail(403, "outside shoot media");
    } catch {
      return fail(404, "not found");
    }

    // Authorize the indexed source and its real path before making a cache.
    // An <audio> element given a MOV/MP4 can also start its 4K video decoder.
    if (voiceRoot) {
      try {
        target = await (await import('./playback-audio')).playbackAudio(voiceRoot, target);
        if (!isInside(await fs.promises.realpath(target), await fs.promises.realpath(voiceRoot))) return fail(403, "outside shoot voice sources");
        stat = await fs.promises.stat(target);
      } catch { return fail(404, "sound unavailable"); }
    }
    const size = stat.size;
    const type = MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    const range = parseRange(request.headers.get("range"), size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (range) {
      const length = range.end - range.start + 1;
      const headers = new Headers({
        "Content-Type": type,
        "Content-Length": String(length),
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
      });
      if (request.method === "HEAD") return new Response(null, { status: 206, headers });
      const stream = Readable.toWeb(fs.createReadStream(target, { start: range.start, end: range.end, signal: request.signal })) as ReadableStream;
      return new Response(stream, { status: 206, headers });
    }

    const headers = new Headers({
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
    });
    if (request.method === "HEAD" || size === 0) return new Response(null, { status: 200, headers });
    const stream = Readable.toWeb(fs.createReadStream(target, { signal: request.signal })) as ReadableStream;
    return new Response(stream, { status: 200, headers });
  } catch {
    return fail(500, "media error");
  }
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, handleMedia);
}
