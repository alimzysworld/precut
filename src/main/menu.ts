// POLISH1: precut's own menu bar, so View can hold "Show or hide edits" (the edits sidebar's hidden state). Every other
// menu is the macOS default by role, as Electron's default menu had it (reload, dev tools and zoom stay in View for now;
// the UX audit's full menu, docs/plans/produced/ux-audit-31-oct.md (c), replaces this later).
import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";

/** Ask the focused window (else the first) to act on a menu command; the renderer listens through onMenu. */
function tell(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("api:menu", command);
}

export function installMenu(): void {
  const view: MenuItemConstructorOptions = { label: "View", submenu: [
    // ⌃⌘S is shown here but kept by the window (registerAccelerator false), so the key and the click do the same one thing.
    { label: "Show or hide edits", accelerator: "Ctrl+Cmd+S", registerAccelerator: false, click: () => tell("toggle-edits-sidebar") },
    { type: "separator" },
    { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
    { type: "separator" },
    { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ] };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { role: "fileMenu" }, { role: "editMenu" }, view, { role: "windowMenu" },
    { role: "help", submenu: [{ label: "precut on the web", click: () => { void shell.openExternal("https://sidething.com/precut").catch(() => {}); } }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
