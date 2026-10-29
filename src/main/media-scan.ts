// NF1: keep this identity and card-filter policy in step with process.py.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const CLIPS = new Set([".mp4", ".mov", ".mxf", ".mts", ".m4v"]);
const AUDIO = new Set([".wav", ".mp3", ".m4a"]);
export const isPhoto = (file: string) => [".heic", ".heif", ".jpg", ".jpeg", ".png"].includes(path.extname(file).toLowerCase());
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function discoverMedia(root: string, exportFolder?: string | null): { clips: string[]; audio: string[] } {
  const resolved = (file: string) => {
    try { return fs.realpathSync(file); } catch { return path.resolve(file); }
  };
  root = resolved(root);
  const excluded = exportFolder ? resolved(exportFolder) : null;
  const clips: string[] = [], audio: string[] = [];
  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name), lower = item.name.toLowerCase();
      if (item.name.startsWith(".") || item.isSymbolicLink() || full === excluded
        || ["sidething precuts", "proxy", "proxies", "thmbnl", "thumbnail", "thumbnails"].includes(lower)
        || (lower === "sub" && ["m4root", "xdroot"].includes(path.basename(dir).toLowerCase()))) continue;
      if (item.isDirectory()) walk(full);
      else if (item.isFile()) {
        const extension = path.extname(item.name).toLowerCase();
        if (CLIPS.has(extension) || isPhoto(item.name)) clips.push(path.relative(root, full));
        else if (AUDIO.has(extension)) audio.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  const stemKey = (file: string) => path.join(path.dirname(file), path.basename(file, path.extname(file)).toLowerCase());
  const videos = new Set(clips.filter(file => !isPhoto(file)).map(stemKey));
  return { clips: clips.filter(file => !isPhoto(file) || !videos.has(stemKey(file))).sort(compare), audio: audio.sort(compare) };
}

function safeId(value: string): string {
  const clean = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/gu, " ").replace(/^[ .]+|[ .]+$/g, "") || "clip";
  let result = "";
  for (const char of clean) { if (Buffer.byteLength(result + char) > 160) break; result += char; }
  return result.replace(/[ .]+$/g, "");
}

const idKey = (value: string) => value.normalize("NFD").toUpperCase().toLowerCase();

export function assignClipIds(files: string[], existing: { id: string; file: string; photo?: { file: string } }[] = []): Map<string, string> {
  const previous = new Map(existing.map(c => [c.photo?.file ?? c.file, c.id])), used = new Set(existing.map(c => idKey(c.id)));
  const ids = new Map(files.filter(file => previous.has(file)).map(file => [file, previous.get(file)!]));
  const fresh = files.filter(file => !ids.has(file)).sort(compare);
  const candidate = (file: string, depth: number) => {
    const parts = file.split(path.sep), name = parts.pop()!, stem = path.basename(name, path.extname(name));
    return safeId(depth ? [...parts.slice(-depth), stem].join(" ") : stem);
  };
  const counts = new Map<number, Map<string, number>>();
  const unique = (file: string, depth: number) => {
    let atDepth = counts.get(depth);
    if (!atDepth) {
      atDepth = new Map();
      for (const other of files) { const value = idKey(candidate(other, depth)); atDepth.set(value, (atDepth.get(value) ?? 0) + 1); }
      counts.set(depth, atDepth);
    }
    return atDepth.get(idKey(candidate(file, depth))) === 1;
  };
  for (const file of fresh) {
    const stem = candidate(file, 0);
    if (!used.has(idKey(stem)) && unique(file, 0)) { ids.set(file, stem); used.add(idKey(stem)); }
  }
  for (const file of fresh) {
    if (ids.has(file)) continue;
    const depth = file.split(path.sep).length - 1;
    let value: string | undefined;
    for (let n = 1; n <= depth; n++) {
      const proposed = candidate(file, n);
      if (!used.has(idKey(proposed)) && unique(file, n)) { value = proposed; break; }
    }
    if (!value) {
      const base = candidate(file, depth), hash = createHash("sha256").update(file).digest("hex");
      let size = 8;
      value = `${base} ${hash.slice(0, size)}`;
      while (used.has(idKey(value))) { size++; value = size <= 64 ? `${base} ${hash.slice(0, size)}` : `${base} ${hash} ${size - 64}`; }
    }
    ids.set(file, value); used.add(idKey(value));
  }
  return ids;
}
