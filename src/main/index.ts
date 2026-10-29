import { enableAppWriter, savesPending, savesSettled } from "./writer-lock";
import { app, BrowserWindow, nativeTheme, Notification, powerMonitor, session, shell } from "electron";
import { governor } from "./resource-governor";
import { join, resolve as resolvePath } from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { registerIpc } from "./ipc";
import { startUpdater } from "./updater";
import { activityHash, activityNotificationBody, setActivityCompletionHandler } from "./activity";
import { getPreferences } from "./settings";
import { registerMediaScheme, registerMediaProtocol } from "./media";
import { bringForward, makeInvisibleForQa, showOnReady } from "./window-show";
import type { ProcessingStageId } from "../shared/schema";
import { STAGE_FAILED_TEXT } from "../shared/stage-words";

// Keep recoverable async media failures from becoming Node's default fatal
// unhandled rejection. Persist the evidence before a window or child disappears.
function reportRuntimeFailure(kind: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  const line = `${new Date().toISOString()} ${kind}: ${detail.slice(0, 8000)}\n`;
  console.error(line.trim());
  try {
    const directory = join(app.getPath("userData"), "logs"), file = join(directory, "runtime.log");
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, line);
  } catch { /* stderr remains available when a drive is unavailable. */ }
}
process.on("unhandledRejection", error => reportRuntimeFailure("Unhandled async task", error));
// Do not attempt to resume after an unknown synchronous main-process exception.
process.on("uncaughtExceptionMonitor", error => reportRuntimeFailure("Main process exception", error));
app.on("child-process-gone", (_event, details) => reportRuntimeFailure("Child process stopped", JSON.stringify(details)));

// Finder does not inherit the user's terminal PATH. Resolve it once before
// registering handlers that can start work, with a bounded startup wait.
function restoreLoginPath(): Promise<void> {
  const inherited = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const merge = (loginPath = "") => {
    // Preserve the actual shell PATH for the installer's PATH advice, before
    // adding our own discovery fallbacks below.
    process.env.PRECUT_SHELL_PATH = loginPath.trim() || inherited;
    process.env.PATH = [...new Set([
      ...loginPath.trim().split(":"),
      ...inherited.split(":"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      // Where Claude Code's own installer puts it, in case the shell is slow.
      join(app.getPath("home"), ".local/bin"),
      join(app.getPath("home"), ".claude/local"),
    ].filter(Boolean))].join(":");
  };
  merge();
  if (process.platform !== "darwin") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (loginPath = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      merge(loginPath);
      resolve();
    };
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 2600);
    const child = execFile("/bin/zsh", ["-lc", 'printf %s "$PATH"'], {
      timeout: 2500,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    }, (error, stdout) => finish(error ? "" : stdout));
  });
}

// Everything the app keeps (settings, skills, the Python venv, the subject
// detector) lives in Application Support/precut. Builds from before the rename
// kept it in sidething-footage: move that folder over once, venv and all.
function settleUserData(): void {
  if (app.commandLine.hasSwitch("user-data-dir")) return; // QA runs keep their own
  const support = app.getPath("appData");
  const home = join(support, "precut");
  const old = join(support, "sidething-footage");
  try {
    if (!fs.existsSync(home) && fs.existsSync(old)) fs.renameSync(old, home);
  } catch {
    /* start fresh; the venv and skills are recreated on demand */
  }
  app.setPath("userData", home);
}
settleUserData();
// REL2: Python caches leave "cache" (the same folder as Chromium's "Cache" on APFS) for py-cache, once, before Chromium starts.
void import("./tools").then(m => m.settlePyCache()).catch(() => {});

const pathReady = restoreLoginPath();

const cliIndex = process.argv.indexOf("--cli");
const headless = cliIndex !== -1 || process.argv.includes("--mcp");
const cliArgs = cliIndex === -1 ? [] : process.argv.slice(cliIndex + 1);
if (cliArgs[0] === "") cliArgs.shift(); // the installed shim's sentinel
const mcpMode = cliArgs[0] === "--mcp" || (cliIndex === -1 && process.argv.includes("--mcp"));
// VO7-18 (minimal): QA launches run behind the user's windows. PRECUT_QA_BACKGROUND=1 hides the Dock icon before any
// window, shows windows inactive and unfocusable, never focuses, and keeps frames unthrottled. Unset, nothing changes.
const qaBackground = process.env["PRECUT_QA_BACKGROUND"] === "1";
if (headless || qaBackground) app.dock?.hide();
// Every window the app creates (secondary ones too) is invisible, click-through and unfocusable before it can show.
if (qaBackground) app.on("browser-window-created", (_event, created) => makeInvisibleForQa(created));
// FIX2: one precut per Mac account. A second launch brings this window forward, opening the shoot folder it was
// asked for, and exits. The CLI and MCP still run beside the app (their writes are refused while it is open).
function askedFolder(argv: string[], cwd: string): string | null {
  for (const arg of argv.slice(process.defaultApp ? 2 : 1).reverse()) {
    if (!arg || arg.startsWith("-")) continue;
    const folder = resolvePath(cwd, arg);
    try { if (fs.statSync(folder).isDirectory()) return folder; } catch { /* not a folder */ }
  }
  return null;
}
const firstInstance = headless || app.requestSingleInstanceLock({ folder: askedFolder(process.argv, process.cwd()) });
if (!firstInstance) app.exit(0);
if (!headless) registerMediaScheme();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "precut",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 30, y: 34 },
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#18191c",
    ...(process.platform === "darwin" ? {
      vibrancy: "under-window" as const,
      visualEffectState: "followWindow" as const,
    } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      backgroundThrottling: !qaBackground,
    },
  });
  win.webContents.on("render-process-gone", (_event, details) => reportRuntimeFailure("Player process stopped", JSON.stringify(details)));
  const foreground = () => governor.setForeground(BrowserWindow.getAllWindows().some(window =>
    !window.isDestroyed() && window.isFocused() && window.isVisible() && !window.isMinimized()));
  win.on("focus", foreground); win.on("blur", foreground); win.on("show", foreground); win.on("hide", foreground);
  win.on("minimize", foreground); win.on("restore", foreground); win.on("closed", foreground);
  // Opens maximised (fills the screen, keeps the menu bar and Dock), never full screen.
  win.on("ready-to-show", () => showOnReady(win, qaBackground));
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url).catch(error => reportRuntimeFailure("Opening link", error));
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]).catch(error => reportRuntimeFailure("Opening window", error));
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html")).catch(error => reportRuntimeFailure("Opening window", error));
  }
}

// VO7-15: the font picker lists this Mac's fonts through Local Font Access, granted to our own pages only.
// Every other permission keeps Electron's default (granted), exactly as before this handler existed.
function ownPage(url: string): boolean {
  try {
    const page = new URL(url), dev = process.env["ELECTRON_RENDERER_URL"];
    return page.protocol === "file:" || (!!dev && page.origin === new URL(dev).origin);
  } catch { return false; }
}
function grantLocalFonts(): void {
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) =>
    (permission as string) === "local-fonts" ? ownPage(details.requestingUrl || origin) : true);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback((permission as string) === "local-fonts" ? ownPage(details.requestingUrl) : true));
}

// Keep notifications alive until the OS closes them, including their click handlers.
const notifications = new Set<Notification>();
function focusActivity(hash: string): void {
  let win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (!win) {
    createWindow();
    win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  }
  if (!win) return;
  const target = win;
  const navigate = () => { if (!target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send("api:navigate", hash); };
  if (target.webContents.isLoadingMainFrame()) target.webContents.once("did-finish-load", navigate);
  else navigate();
  bringForward(target, qaBackground, () => app.focus({ steal: true }));
}
// PF1: a stage that fails says so at once when the window is behind, and the
// run's closing "couldn't finish" does not repeat it.
const failureTold = new Map<string, number>();
function notifyStageFailure(root: string, stage: ProcessingStageId): void {
  if (headless || process.platform !== "darwin" || BrowserWindow.getFocusedWindow() || failureTold.has(root)) return;
  failureTold.set(root, Date.now());
  void (async () => {
    if ((await getPreferences()).notifications === false || BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
    const icon = app.isPackaged ? join(process.resourcesPath, "icon.icns")
      : join(__dirname, "../../build/icon-source/precut-icon-1024.png");
    const notification = new Notification({ title: "precut", body: `${STAGE_FAILED_TEXT[stage]} Open precut to retry.`, icon });
    notifications.add(notification);
    notification.on("click", () => { notifications.delete(notification); focusActivity(`#/clips?shoot=${encodeURIComponent(root)}`); });
    notification.on("close", () => notifications.delete(notification));
    notification.on("failed", () => notifications.delete(notification));
    notification.show();
  })().catch(error => console.warn("Could not show the failure notification:", error));
}
void import("./jobs").then(jobs => jobs.setStageFailureHandler((root, stage) => notifyStageFailure(root, stage)));
setActivityCompletionHandler(activity => {
  // R6: keep the rebuildable cache within its budget once a render is over.
  if (activity.root && activity.kind === "render" && activity.state === "done") void import("./storage").then(m => m.scheduleEnforce(activity.root!));
  if (activity.root && activity.state === "failed" && activity.label === "Reading your footage") {
    if (failureTold.delete(activity.root)) return;
  } else if (activity.root && activity.label === "Reading your footage") failureTold.delete(activity.root);
  if (headless || process.platform !== "darwin" || BrowserWindow.getFocusedWindow()) return;
  void (async () => {
    if (activity.root && activity.label !== "Reading your footage" && (await import("./jobs")).isShootProcessing(activity.root)) return;
    if ((await getPreferences()).notifications === false || BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
    // Installed builds use the bundled panda; development uses its PNG source.
    const icon = app.isPackaged ? join(process.resourcesPath, "icon.icns")
      : join(__dirname, "../../build/icon-source/precut-icon-1024.png");
    const notification = new Notification({ title: "precut", body: activityNotificationBody(activity), icon });
    notifications.add(notification);
    notification.on("click", () => { notifications.delete(notification); focusActivity(activityHash(activity)); });
    notification.on("close", () => notifications.delete(notification));
    notification.on("failed", () => notifications.delete(notification));
    notification.show();
  })().catch(error => console.warn("Could not show the activity notification:", error));
});

// FIX2: a second launch hands over the folder it was asked to open, then exits. A known shoot opens here.
if (firstInstance && !headless) app.on("second-instance", (_event, argv, cwd, data) => {
  const asked = (data as { folder?: unknown } | null)?.folder;
  const folder = typeof asked === "string" ? asked : askedFolder(argv, cwd);
  if (quitState !== "open") return;
  void (async () => {
    let root: string | null = null;
    try { root = folder ? fs.realpathSync(folder) : null; } catch { /* gone: just come forward */ }
    const known = !!root && (await (await import("./jobs")).listShoots()).some(shoot => resolvePath(shoot.root) === root);
    if (!app.isReady()) return;
    if (known) { focusActivity(`#/wait?shoot=${encodeURIComponent(root!)}&view=auto`); return; }
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w !== savingPanel);
    if (win) bringForward(win, qaBackground, () => app.focus({ steal: true })); else createWindow();
  })().catch(error => reportRuntimeFailure("Opening from a second launch", error));
});

// FIX2: quitting, closing the window and the Mac logging out or shutting down never lose a change. Every save
// already started lands (or fails, leaving the edit as it was) before precut exits. After a moment he sees
// "Saving your last change", and precut closes by itself when it lands. A save that never settles is given up
// after QUIT_SAVE_LIMIT_MS so precut can always quit; saves write a temporary file and rename it, so even then
// the edit file is never half written.
const QUIT_SAVE_LIMIT_MS = 90_000, QUIT_PANEL_AFTER_MS = 400;
let quitState: "open" | "saving" | "ready" = "open";
let savingPanel: BrowserWindow | null = null;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function showSavingPanel(): void {
  const dark = nativeTheme.shouldUseDarkColors, owner = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
  const panel = savingPanel = new BrowserWindow({ width: 340, height: 84, show: false, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, title: "precut", backgroundColor: dark ? "#17161a" : "#f1efea",
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: !qaBackground } });
  const bounds = owner?.getBounds();
  if (bounds) panel.setPosition(Math.round(bounds.x + (bounds.width - 340) / 2), Math.round(bounds.y + (bounds.height - 84) / 2));
  else panel.center();
  const html = `<!doctype html><meta charset="utf-8"><title>precut</title><style>
    :root { color-scheme: ${dark ? "dark" : "light"}; } body { margin: 0; height: 100vh; display: grid; place-content: center; text-align: center;
    font: 13px/1.4 -apple-system, system-ui, sans-serif; background: ${dark ? "#17161a" : "#f1efea"}; color: ${dark ? "#f5f0e8" : "#28252b"}; -webkit-user-select: none; }
    strong { font-weight: 600; font-size: 14px; } p { margin: 2px 0 0; opacity: .66; }</style>
    <strong data-saving>Saving your last change</strong><p>precut closes by itself when it's saved.</p>`;
  panel.once("ready-to-show", () => { if (panel.isDestroyed()) return; if (qaBackground) panel.showInactive(); else panel.show(); });
  void panel.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
}
/** Every message a window sent before quit was pressed (the trim that keypress made) reaches main first. */
async function rendererBarrier(): Promise<void> {
  await Promise.all(BrowserWindow.getAllWindows().filter(win => win !== savingPanel && !win.isDestroyed() && !win.webContents.isDestroyed())
    .map(win => Promise.race([win.webContents.executeJavaScript("0").catch(() => {}), wait(1000)])));
}
function finishSavesThenQuit(): void {
  if (quitState !== "open") return;
  quitState = "saving";
  const started = Date.now();
  const panelTimer = setTimeout(() => { if (quitState === "saving") showSavingPanel(); }, QUIT_PANEL_AFTER_MS);
  void (async () => {
    await rendererBarrier();
    for (const win of BrowserWindow.getAllWindows()) if (win !== savingPanel && !win.isDestroyed()) win.hide();
    // Saves queue more saves (a trim, then its sound). Settle until nothing new has started for a beat.
    while (Date.now() - started < QUIT_SAVE_LIMIT_MS) {
      await wait(40);
      if (!savesPending()) break;
      await Promise.race([savesSettled(), wait(QUIT_SAVE_LIMIT_MS - (Date.now() - started))]);
    }
    if (savesPending()) reportRuntimeFailure("Quit", `gave up waiting for ${savesPending()} save(s) after ${QUIT_SAVE_LIMIT_MS} ms\n${(await import("./writer-lock")).pendingOrigins().join("\n---\n").slice(0, 6000)}`);
  })().catch(error => reportRuntimeFailure("Quit", error)).finally(() => {
    clearTimeout(panelTimer);
    quitState = "ready";
    if (savingPanel && !savingPanel.isDestroyed()) savingPanel.destroy();
    app.quit();
  });
}
app.on("before-quit", event => {
  if (headless || quitState === "ready") return;
  event.preventDefault();
  finishSavesThenQuit();
});

app.whenReady().then(async () => {
  if (!firstInstance) return;
  // A development run is the Electron binary: give the Dock our name and the panda.
  if (!app.isPackaged && process.platform === "darwin") {
    app.setName("precut");
    const icon = join(__dirname, "../../build/icon-source/precut-icon-1024.png");
    if (fs.existsSync(icon) && !qaBackground) app.dock?.setIcon(icon);
  }
  await pathReady;
  // ONB2: hold the Mac awake (powerSaveBlocker, prevent-app-suspension) only while a shoot is read or an export runs.
  void import("./keep-awake").then(m => m.startKeepAwake()).catch(() => {});
  if (headless) {
    if (mcpMode) {
      const { startMcp } = await import("./mcp");
      await startMcp(() => app.exit(0));
    } else {
      const { runCli } = await import("./cli");
      const code = await runCli(cliArgs);
      // Flush piped results before Electron tears down the Node runtime.
      await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
      app.exit(code);
    }
    return;
  }
  enableAppWriter();
  // FIX2: logging out or shutting down waits for saves already started, like Cmd+Q.
  // Electron passes an event here (its typings omit it); preventDefault asks the Mac to wait for our quit.
  powerMonitor.on("shutdown", (...args: unknown[]) => { if (quitState === "ready") return; (args[0] as Electron.Event | undefined)?.preventDefault(); finishSavesThenQuit(); });
  registerMediaProtocol();
  grantLocalFonts();
  registerIpc();
  startUpdater();  // SIGN2: packaged builds check GitHub releases and install on quit, after FIX2's saves
  void import("./power-watch").then(watch => watch.startPowerWatch()).catch(() => {});  // PERF1
  // EXP3: frames a killed or crashed export left in the temp folder go at launch (never a running export's), and a clip
  // renamed or deleted under the open shoot shows as missing within seconds.
  void import("./preview").then(preview => preview.cleanupStaleExportScratch()).catch(() => {});
  // FIX6: and the colour cubes a killed or quit cover render left there.
  void import("./cover").then(cover => cover.cleanupStaleCoverCubes()).catch(() => {});
  void import("./missing-media").then(media => media.watchMissingMedia()).catch(() => {});
  // R6: trim every known shoot's rebuildable cache a little after launch, off the busy path.
  void import("./jobs").then(async jobs => { for (const shoot of await jobs.listShoots()) if (shoot.online) (await import("./storage")).scheduleEnforce(shoot.root, 20_000); }).catch(() => {});
  createWindow();
  // Reading a quit cut short picks up where it stopped, as does a changed source an edit uses.
  void import("./jobs").then(jobs => jobs.resumeReading()).catch(error => console.error("[jobs] could not resume reading:", error));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  process.stderr.write(`precut: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
