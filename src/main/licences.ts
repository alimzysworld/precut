// REL2: Settings, About, Licences. The licence texts precut owes travel in Resources/licenses (electron-builder.yml);
// a development run reads them from resources/licenses and Electron's two from node_modules/electron/dist.
// Read-only: listing, reading one text, or opening one in the Mac's default app. MCP: get_about.
import { app } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface LicenceEntry { file: string; name: string; covers: string; bytes: number; inline: boolean }
const ELECTRON = new Set(["electron-LICENSE.txt", "LICENSES.chromium.html"]);
const INLINE_MAX = 2 * 1024 * 1024;   // larger texts (Chromium's) open in the Mac's default app instead

function located(file: string): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "licenses", file);
  if (file === "electron-LICENSE.txt") return path.join(app.getAppPath(), "node_modules/electron/dist/LICENSE");
  if (file === "LICENSES.chromium.html") return path.join(app.getAppPath(), "node_modules/electron/dist/LICENSES.chromium.html");
  return path.join(app.getAppPath(), "resources/licenses", file);
}

export async function listLicences(): Promise<LicenceEntry[]> {
  const index = JSON.parse(await fs.readFile(located("index.json"), "utf8")) as { file: string; name: string; covers: string }[];
  const out: LicenceEntry[] = [];
  for (const item of index) {
    if (!/^[A-Za-z0-9._-]+$/.test(item.file)) continue;
    const stat = await fs.stat(located(item.file)).catch(() => null);
    if (stat?.isFile()) out.push({ ...item, bytes: stat.size, inline: stat.size <= INLINE_MAX && !item.file.endsWith(".html") });
  }
  return out;
}

async function known(file: unknown): Promise<string> {
  if (typeof file !== "string" || !(await listLicences()).some(item => item.file === file) && !ELECTRON.has(file)) throw new Error("That licence is not one precut ships.");
  return located(file);
}

export async function readLicence(file: unknown): Promise<string> {
  const target = await known(file), stat = await fs.stat(target);
  if (stat.size > INLINE_MAX) throw new Error("This licence is long: open it instead.");
  return fs.readFile(target, "utf8");
}

export async function openLicence(file: unknown): Promise<void> {
  const { shell } = await import("electron");
  const error = await shell.openPath(await known(file));
  if (error) throw new Error("Couldn't open that licence. Try again.");
}

/** For Settings, About and get_about: what precut is and under which licence. */
export async function about(): Promise<{ version: string; licence: string; source: string; licences: LicenceEntry[] }> {
  return { version: app.getVersion(), licence: "GNU Affero General Public License 3.0 only (AGPL-3.0-only)", source: "https://github.com/alimzysworld/precut", licences: await listLicences() };
}

let registered = false;
export async function registerLicenceIpc(): Promise<void> {
  if (registered) return;
  registered = true;
  const { ipcMain } = await import("electron");
  ipcMain.handle("api:about", () => about());
  ipcMain.handle("api:readLicence", (_event, file: unknown) => readLicence(file));
  ipcMain.handle("api:openLicence", (_event, file: unknown) => openLicence(file));
}
