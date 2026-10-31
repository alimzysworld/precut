// Runtime resolution only: this module never downloads or installs anything.
import { accessSync, constants, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkoutFile } from "./bundle-paths";

export const supportDir = () => path.join(os.homedir(), "Library", "Application Support", "precut");

// SIGN1: Python writes __pycache__ beside every module it imports, and the pipeline lives inside the
// signed app bundle, so a run breaks `codesign --verify`. Every spawn passes -I, which ignores
// PYTHONDONTWRITEBYTECODE / PYTHONPYCACHEPREFIX, so the switch lives in the venv instead: a .pth line
// in its site-packages runs at start-up even in isolated mode. Idempotent; call before any spawn.
const PTH = "import sys; sys.dont_write_bytecode = True\n";
let guarded = "";
export function keepBundleSealed(support = supportDir()): void {
  if (guarded === support) return;
  try {
    const lib = path.join(support, "venv/lib");
    for (const dir of existsSync(lib) ? readdirSync(lib) : []) {
      const site = path.join(lib, dir, "site-packages");
      if (existsSync(site)) { writeFileSync(path.join(site, "precut-no-bytecode.pth"), PTH); guarded = support; }
    }
  } catch { /* a read-only venv still runs; only the bundle seal is at risk */ }
}

export function tool(name: string, options: { resourcesPath?: string; developmentPath?: string; searchPath?: string; supportPath?: string } = {}): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid tool name");
  const resources = options.resourcesPath ?? (process.defaultApp ? undefined : process.resourcesPath);
  // Packaged apps must never execute a tool from an arbitrary working directory.
  const bundled = resources ? path.join(resources, "tools") : options.developmentPath ?? checkoutFile("build/tools");
  const relative = name === "exiftool" ? path.join("exiftool", "exiftool") : name;
  const candidates = [path.join(bundled, relative)];
  if (name === "python3") { if (!options.supportPath) keepBundleSealed(); candidates.push(path.join(options.supportPath ?? supportDir(), "venv/bin/python")); }
  for (const directory of (options.searchPath ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, name));
  }
  // Claude's official native installer uses this location, even before PATH is updated.
  if (name === "claude") candidates.push(path.join(os.homedir(), ".local/bin/claude"));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* try the next location */ }
  }
  return name;
}

// REL2: Python's caches (uv, numba, tokenizers, compiled helpers) live in py-cache. They used to be in "cache", which on
// a case-insensitive APFS volume is the same folder as Chromium's own "Cache" in Application Support/precut, so each could
// clear or trip over the other. Move them out once; Chromium keeps Cache_Data and its own index files.
const CHROMIUM_CACHE = /^(Cache_Data|index|index-dir|data_\d+|f_[0-9a-f]+|js|wasm)$/i;
let pyCacheSettled = "";
export function settlePyCache(home = supportDir()): string {
  const target = path.join(home, "py-cache");
  if (pyCacheSettled === home) return target;
  pyCacheSettled = home;
  try {
    const old = path.join(home, "cache");
    if (!existsSync(old)) return target;
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(old)) {
      if (CHROMIUM_CACHE.test(name) || existsSync(path.join(target, name))) continue;
      try { renameSync(path.join(old, name), path.join(target, name)); } catch { /* left behind: it is rebuilt on demand */ }
    }
  } catch { /* a cache that can't move is rebuilt in py-cache on demand */ }
  return target;
}

// Python's isolated mode ignores PYTHONPATH. Put the resolved programs on PATH
// as well, so its subprocesses (and libraries such as mlx-whisper) use them.
export function toolEnvironment(): NodeJS.ProcessEnv {
  const home = supportDir();
  keepBundleSealed(home);
  const cache = settlePyCache(home);
  return { ...process.env, PYTHONDONTWRITEBYTECODE: "1",
    PATH: [...new Set(["ffmpeg", "ffprobe", "exiftool", "subject", "matte"].map(name => tool(name)).filter(file => path.isAbsolute(file)).map(file => path.dirname(file))), process.env.PATH ?? ""].join(path.delimiter),
    UV_PYTHON_INSTALL_DIR: path.join(home, "python"), UV_PYTHON_BIN_DIR: path.join(home, "bin"),
    UV_CACHE_DIR: path.join(cache, "uv"), UV_TOOL_DIR: path.join(home, "uv-tools"),
    UV_NO_CONFIG: "1", UV_PYTHON_PREFERENCE: "only-managed", UV_LINK_MODE: "copy",
    XDG_CACHE_HOME: cache, XDG_DATA_HOME: path.join(home, "data"),
    HF_HOME: path.join(home, "models"), HF_HUB_CACHE: path.join(home, "models/hub"),
    NUMBA_CACHE_DIR: path.join(cache, "numba"), TIKTOKEN_CACHE_DIR: path.join(cache, "tokenizers"),
  };
}
