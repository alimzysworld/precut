import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { registerIpc } from "./ipc";
import { registerMediaScheme, registerMediaProtocol } from "./media";

// Finder does not inherit the user's terminal PATH. Resolve it once before
// registering handlers that can start work, with a bounded startup wait.
function restoreLoginPath(): Promise<void> {
  const inherited = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const merge = (loginPath = "") => {
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

const pathReady = restoreLoginPath();

registerMediaScheme();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "precut",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 28, y: 12 },
    backgroundColor: "#15181d",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });
  win.on("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await pathReady;
  registerMediaProtocol();
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
