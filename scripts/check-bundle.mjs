#!/usr/bin/env node
// REL2: refuse a precut.app that is missing anything the app runs or owes. Run on every release build
// (scripts/release-mac.sh) and on any local build:
//
//   node scripts/check-bundle.mjs <precut.app>
//
// 1. Every helper precut spawns is in Contents/Resources/tools. The list is read from the source, not kept by hand:
//    each tool("<name>") call in src/main and pipeline, each "tools/<name>" path, and apple-player.node.
//    Engines (claude, codex, muse) are the person's own apps and python3 is the managed venv: never bundled.
// 2. Every licence text precut owes is in Contents/Resources/licenses (resources/licenses/index.json, plus Electron's
//    LICENSE and LICENSES.chromium.html copied from the electron package).
// 3. Every starter track in build/music/tracks.json is in Contents/Resources/music (the release is built from the public
//    tree, where fetch-tools.sh downloads them; a build that skipped that has no music).
// 4. Info.plist asks for macOS 14.0 or newer (LSMinimumSystemVersion), which the Swift helpers and mlx wheels need.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = process.argv[2];
if (!app || !fs.existsSync(path.join(app, "Contents/Info.plist"))) { console.error("usage: node scripts/check-bundle.mjs <precut.app>"); process.exit(2); }
const resources = path.join(app, "Contents/Resources");
const NOT_BUNDLED = new Set(["claude", "codex", "muse", "python3", "list"]);   // "tools/list" is an MCP method, not a file

function sources(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!["node_modules", "__pycache__"].includes(entry.name)) out.push(...sources(file, ext)); }
    else if (ext.some(e => entry.name.endsWith(e))) out.push(file);
  }
  return out;
}
const needed = new Map();
for (const file of [...sources(path.join(ROOT, "src/main"), [".ts"]), ...sources(path.join(ROOT, "pipeline"), [".py"])]) {
  const text = fs.readFileSync(file, "utf8"), rel = path.relative(ROOT, file);
  // tool("ffmpeg") or tool("ffmpeg", { ...options }); an MCP tool("name", "description", ...) definition is not a program.
  for (const m of text.matchAll(/\btool\(\s*["']([A-Za-z0-9_-]+)["']\s*(?:\)|,\s*\{)/g)) if (!NOT_BUNDLED.has(m[1])) needed.set(m[1], rel);
  for (const m of text.matchAll(/["']tools\/([A-Za-z0-9_.-]+)["']/g)) if (!NOT_BUNDLED.has(m[1])) needed.set(m[1], rel);
  if (text.includes('"apple-player.node"')) needed.set("apple-player.node", rel);
}
const problems = [], seen = [];
for (const [name, from] of [...needed].sort()) {
  const file = path.join(resources, "tools", name === "exiftool" ? "exiftool/exiftool" : name);
  let ok = false;
  try { const stat = fs.statSync(file); ok = stat.isFile() && (name.endsWith(".node") || (stat.mode & 0o111) !== 0); } catch { /* missing */ }
  seen.push(`${ok ? "ok     " : "MISSING"} tools/${name}  (used by ${from})`);
  if (!ok) problems.push(`tools/${name} is missing or not executable (used by ${from})`);
}
const index = JSON.parse(fs.readFileSync(path.join(ROOT, "resources/licenses/index.json"), "utf8"));
const licences = [...index.map(item => item.file), "electron-LICENSE.txt", "LICENSES.chromium.html"];
for (const name of [...new Set(licences)]) {
  const file = path.join(resources, "licenses", name);
  const ok = fs.existsSync(file) && fs.statSync(file).size > 0;
  seen.push(`${ok ? "ok     " : "MISSING"} licenses/${name}`);
  if (!ok) problems.push(`licenses/${name} is missing`);
}
const tracks = JSON.parse(fs.readFileSync(path.join(ROOT, "build/music/tracks.json"), "utf8"));
for (const track of tracks) {
  const file = path.join(resources, "music", track.file);
  const ok = fs.existsSync(file) && fs.statSync(file).size > 0;
  seen.push(`${ok ? "ok     " : "MISSING"} music/${track.file}`);
  if (!ok) problems.push(`music/${track.file} is missing (run npm run fetch-tools, then build)`);
}
let minimum = "";
try { minimum = execFileSync("/usr/bin/plutil", ["-extract", "LSMinimumSystemVersion", "raw", path.join(app, "Contents/Info.plist")]).toString().trim(); } catch { /* absent */ }
seen.push(`${minimum === "14.0" ? "ok     " : "WRONG  "} LSMinimumSystemVersion ${minimum || "(none)"}`);
if (minimum !== "14.0") problems.push(`LSMinimumSystemVersion is ${minimum || "missing"}, not 14.0`);
console.log(seen.join("\n"));
if (problems.length) { console.error(`\nThis bundle can't ship:\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`\nBundle complete: ${needed.size} helpers, ${new Set(licences).size} licence files, ${tracks.length} music tracks, macOS ${minimum}+.`);
