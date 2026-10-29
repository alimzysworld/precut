// VO7-18: how windows come to the screen. PRECUT_QA_BACKGROUND=1 (QA runs) opens them behind the user's work:
// inactive, unfocusable, never raised. Without it, behaviour is exactly what users have always had.
export interface ShowableWindow {
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  maximize(): void;
  show(): void;
  showInactive(): void;
  focus(): void;
}

/** The window finished loading: first show. */
export function showOnReady(win: ShowableWindow, background: boolean): void {
  if (background) { win.showInactive(); return; }
  win.maximize();
  win.show();
}

/** Something asks for the window (a link, a notification): bring it forward, unless this is a QA run. */
export function bringForward(win: ShowableWindow, background: boolean, stealFocus: () => void): void {
  if (background) { if (!win.isVisible()) win.showInactive(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  stealFocus();
  win.focus();
}

export interface HideableWindow {
  setOpacity(opacity: number): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setSkipTaskbar(skip: boolean): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { skipTransformProcessType?: boolean }): void;
  setFocusable(focusable: boolean): void;
  webContents: { setBackgroundThrottling(allowed: boolean): void };
}

/** QA runs only: the window renders real frames but the user cannot see it, click it or focus it. */
export function makeInvisibleForQa(win: HideableWindow): void {
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.setSkipTaskbar(true);
  win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true }); // else macOS turns the app back into a Dock app
  win.setFocusable(false);
  win.webContents.setBackgroundThrottling(false);
}
