import * as path from "node:path";
import { fileURLToPath } from "node:url";

// FIX7: one stable base for files the main process loads from beside its own code. electron-vite writes the main
// entry to out/main/index.js and every code-split module to out/main/chunks/<name>-<hash>.js, so a module's own
// __dirname depends on which chunk Rollup put it in (graphics/render.ts landed in chunks/ and lost its template).
// Resolve from the main output folder instead, whichever chunk asks. The same layout holds in dev (out/), in a
// private --outDir build and packaged (Resources/app.asar/out/main, read through Electron's asar support).
// Running from source (an esbuild test bundle, or src/main itself) the folder is wherever this module is, as before.
const CHUNKS = "chunks";

function moduleDir(): string {
  if (typeof __dirname === "string") return __dirname;
  // ESM with no __dirname (an esbuild test bundle): this module's own file from the call stack. Not import.meta, which
  // the CommonJS test loaders (qa/*/load.cjs, transpileModule + vm) cannot parse.
  const url = new Error().stack?.match(/file:\/\/[^\s)]+?(?=:\d+:\d+)/)?.[0];
  try { return url ? path.dirname(fileURLToPath(url)) : process.cwd(); } catch { return process.cwd(); }
}

/** The main bundle's output folder (out/main), the same from the entry and from any chunk. */
export function mainBundleDir(): string {
  const here = moduleDir();
  return path.basename(here) === CHUNKS ? path.dirname(here) : here;
}

/** A file the main build emits beside index.js, e.g. "titles/template.html" or "grade-worker.js". */
export function bundledFile(relative: string): string {
  return path.join(mainBundleDir(), relative);
}

/** A file in the checkout that holds out/ (pipeline/, prompts/, build/, resources/). Development only: a packaged
 * app reads these from process.resourcesPath, and callers try that first. */
export function checkoutFile(relative: string): string {
  return path.resolve(mainBundleDir(), "../..", relative);
}
