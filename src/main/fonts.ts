import { execFile } from "node:child_process";
import { familiesFromFaces, type FontFamily } from "../shared/local-fonts";

// VO7-15: the installed font families, read once per launch from AppKit's font manager. Used by MCP (no
// window there) and by the picker when Local Font Access is unavailable. Asynchronous, so it never blocks.
const SCRIPT = 'ObjC.import("AppKit");const m=$.NSFontManager.sharedFontManager;'
  + 'JSON.stringify(ObjC.deepUnwrap(m.availableFontFamilies).map(f=>[f,(ObjC.deepUnwrap(m.availableMembersOfFontFamily(f))||[]).map(x=>String(x[1]))]))';
let cached: Promise<FontFamily[]> | null = null;

export function listInstalledFonts(): Promise<FontFamily[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  cached ??= new Promise<FontFamily[]>((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", SCRIPT], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error("Could not list the fonts on this Mac.")); return; }
      try {
        const rows = JSON.parse(stdout) as [string, string[]][];
        resolve(familiesFromFaces(rows.flatMap(([family, styles]) => (styles.length ? styles : ["Regular"]).map(style => ({ family, style })))));
      } catch { reject(new Error("Could not read the fonts on this Mac.")); }
    });
  }).catch(error => { cached = null; throw error; });
  return cached;
}
