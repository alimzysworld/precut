// SIGN2: precut updates itself from the GitHub releases of alimzysworld/precut (public, no token).
// The flow is fixed: check, download, verify, install on quit. Nothing here is a judgement call.
//
// - A newer signed version downloads in the background. electron-updater checks the zip's sha512 against
//   latest-mac.yml; Squirrel.Mac then checks the new app's code signature against this app's designated
//   requirement (same Developer ID team, same bundle id). Only after both does the top bar say it is ready.
// - It installs when precut quits: Squirrel's ShipIt waits for this process to exit, so FIX2's quit, which
//   waits for every save, always runs first. We never call quitAndInstall, so nothing quits around the saves.
// - A failed download or check says so plainly; the installed app is never touched.
import { app, autoUpdater as nativeUpdater, BrowserWindow, ipcMain } from "electron";
import type { AppUpdater, UpdateInfo, ProgressInfo } from "electron-updater";
import type { UpdateState, UpdateStatus } from "../shared/update-status";

const OWNER = "alimzysworld", REPO = "precut";
const FIRST_CHECK_MS = 30_000, EVERY_MS = 6 * 60 * 60_000;
let status: UpdateStatus = { state: "off", version: app.getVersion() };
let updater: AppUpdater | null = null;
let busy: Promise<void> | null = null;

function publish(next: Partial<UpdateStatus> & { state: UpdateState }): void {
  status = { version: app.getVersion(), checkedAt: status.checkedAt, manual: status.manual, ...next };
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("api:update-status", status);
}
const failed = (failedAt: "check" | "download" | "verify", message: string) =>
  publish({ state: "failed", failedAt, message, next: status.next, checkedAt: new Date().toISOString() });

/** A test feed (a folder served on this Mac) stands in for GitHub. Loopback only: a feed can't install anything
 *  Squirrel's signature check refuses, and this keeps the override from pointing anywhere else. */
function testFeed(): string | null {
  const url = process.env["PRECUT_UPDATE_FEED"];
  if (!url) return null;
  try { const host = new URL(url).hostname; return host === "127.0.0.1" || host === "localhost" ? url : null; } catch { return null; }
}

async function loadUpdater(): Promise<AppUpdater> {
  if (updater) return updater;
  // electron-updater is CommonJS with a lazy getter for autoUpdater, which ESM's named-export detection misses.
  const mod = await import("electron-updater");
  const autoUpdater = mod.autoUpdater ?? (mod as unknown as { default: typeof mod }).default.autoUpdater;
  autoUpdater.autoDownload = false;            // we start the download ourselves, so its failure is handled here
  autoUpdater.autoInstallOnAppQuit = true;     // Squirrel installs when precut exits
  autoUpdater.autoRunAppAfterInstall = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: () => {}, warn: (m: unknown) => console.warn("[updater]", m), error: (m: unknown) => console.warn("[updater]", m), debug: () => {} };
  const feed = testFeed();
  autoUpdater.setFeedURL(feed ? { provider: "generic", url: feed } : { provider: "github", owner: OWNER, repo: REPO, releaseType: "release" });
  autoUpdater.on("download-progress", (p: ProgressInfo) => {
    if (status.state === "downloading") publish({ state: "downloading", next: status.next, pct: Math.round(p.percent) });
  });
  // Squirrel has the new app and its signature satisfies ours: it installs when precut quits.
  nativeUpdater.on("update-downloaded", () => publish({ state: "ready", next: status.next, checkedAt: new Date().toISOString() }));
  // Squirrel refusing the bundle (signature, team, bundle id) arrives here. MacUpdater re-emits it on autoUpdater
  // too; the "downloading" guard below keeps one message.
  nativeUpdater.on("error", error => {
    if (status.state === "downloading") failed("verify", `Update ${status.next} didn't pass its signature check, so it wasn't installed. precut ${app.getVersion()} is unchanged.`);
    console.warn("[updater] Squirrel:", error?.message ?? error);
  });
  updater = autoUpdater;
  return autoUpdater;
}

async function run(manual: boolean): Promise<void> {
  if (status.state === "ready") return;        // one update at a time; the next check is after it installs
  const u = await loadUpdater();
  publish({ state: "checking", manual });
  let info: UpdateInfo | undefined;
  try {
    const result = await u.checkForUpdates();
    info = result?.isUpdateAvailable ? result.updateInfo : undefined;
  } catch (error) {
    console.warn("[updater] check:", error instanceof Error ? error.message : error);
    failed("check", "Couldn't check for updates. Check your connection and try again.");
    return;
  }
  if (!info) { publish({ state: "current", checkedAt: new Date().toISOString() }); return; }
  publish({ state: "downloading", next: info.version, pct: 0 });
  try {
    await u.downloadUpdate();
  } catch (error) {
    const code = (error as { code?: string })?.code;
    console.warn("[updater] download:", code ?? "", error instanceof Error ? error.message : error);
    if (status.state !== "downloading") return;  // Squirrel already said why
    failed(code === "ERR_CHECKSUM_MISMATCH" ? "verify" : "download", code === "ERR_CHECKSUM_MISMATCH"
      ? `Update ${info.version} didn't match its checksum, so it wasn't installed. precut ${app.getVersion()} is unchanged.`
      : `Update ${info.version} didn't download. precut ${app.getVersion()} is unchanged.`);
  }
}

export function checkForUpdates(manual = false): Promise<UpdateStatus> {
  if (status.state === "off") return Promise.resolve(status);
  busy ??= run(manual).catch(error => { console.warn("[updater]", error); failed("check", "Couldn't check for updates. Try again."); }).finally(() => { busy = null; });
  return busy.then(() => status);
}

export function updateStatus(): UpdateStatus { return status; }

/** Packaged macOS builds only: a development run is the bare Electron binary and has nothing to update. */
export function startUpdater(): void {
  ipcMain.handle("api:updateStatus", () => status);
  ipcMain.handle("api:checkForUpdates", () => checkForUpdates(true));
  void import("./licences").then(m => m.registerLicenceIpc());  // REL2: Settings, About (version, licence, Licences)
  if (!app.isPackaged || process.platform !== "darwin") return;
  status = { state: "idle", version: app.getVersion() };
  // REL2: "Check for updates automatically" (Settings, General, Updates; on unless turned off). Off means no request
  // to GitHub at all until the person presses "Check for updates".
  const scheduled = async () => {
    const { getPreferences } = await import("./settings");
    if ((await getPreferences().catch(() => null))?.autoUpdates === false) return;
    await checkForUpdates();
  };
  setTimeout(() => void scheduled(), testFeed() ? 2_000 : FIRST_CHECK_MS).unref?.();
  setInterval(() => void scheduled(), EVERY_MS).unref?.();
}
