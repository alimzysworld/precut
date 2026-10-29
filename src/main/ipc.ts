import { balanceClips, balanceStatus, balanceHand } from "./balance";
import { liveGrade } from "./grade";
import { soundLibrary } from "./sound-design";
import { junkReview, trashClips, keepClips } from "./junk";
import { soundKey, generateSound } from "./sound-gen";
import { duplicateCut, createCut, starCut, deleteCut, restoreCut } from "./cuts";
import { writePost } from "./post";
import { translateCaptions } from "./translate";
// Main-side handlers for window.api. Channel for method m is `api:${m}`;
// Progress events go out on `api:progress`. One handler per active method.
import { app, ipcMain, BrowserWindow } from "electron";
import type { Api, Shoot, Stage } from "../shared/schema";
import {
  addShoot,
  listShoots,
  relinkShoot,
  forgetShoot,
  retryStage,
  setStepsChangedForwarder,
  loadShoot,
  pickFolder,
  revealInFinder,
  setProgressForwarder,
} from "./jobs";
import { setScript as judgeSetScript, starTake as judgeStarTake, setClipTag, setFootageStar } from "./judge";
import { exportTo } from "./export";
import { finishCut } from "./finish";
import { pickOverlayFiles } from "./overlays";
import { editTranscript } from "./transcript";
import { sidekickThread, sidekickSend, listCutsLight, loadCutVersion, noteShownVersion, editCut, passIdea, readCut, savedSnapshot, cutFile } from "./sidekick";
import { addRequest, listRequests } from "./requests";
import { getBrief, setBrief, listQuestions, answerQuestion, setQuestionsForwarder } from "./brief";  // WR1
import { getEngine, setEngine, getEngineModel, setEngineModel, getMusicFolder, setMusicFolder, pickMusicFolder, listEngines, getPreferences, setPreferences } from "./settings";
import { installCommandLine } from "./cli";
import { checkSetup, appIcons, setupPrecut, signInClaude } from "./doctor";
import { testEngine, openEngineHelp, startFirstRunDownloads, firstRunDownloads } from "./onboarding";
import { openEdit, isSetupPreview, staleLookWork } from "./look-preview-scope";
import { listActivity, cancelActivity, runActivity } from "./activity";
import { governor } from "./resource-governor";
import { renderLookPreviews, renderSampleLooks, liveLut } from "./grade";
import { draftTimeline, pieceLuts, autoBasic } from "./draft";
import { motionStatus } from "./motion";
import { shootSteps, stepsChanged, trackProgress, stopStep } from "./steps";
import { shootProgress } from "./progress";
import { listSkills, saveSkill, deleteSkill, revealSkills } from "./skills";
import { extensions, installExtension, removeExtension, setExtensionSoundKey } from "./extensions";

import { musicCatalog } from "./music-catalog";
import { listMusic, addMusicTracks, pickMusicTracks } from "./music";
import { renameCut } from "./sidekick";
import { current as revisionState, undo as undoRevision, redo as redoRevision, listMilestones as listVersionMilestones, saveVersion, restoreVersion } from "./revisions";  // VO7-1
import { chatSend, chatThread, chatStop, chatAnswer, setChatForwarder } from "./chat";
import { terminalOpen, terminalWrite, terminalResize, terminalContext, terminalRestart, terminalClose, closeAllTerminals, setTerminalForwarder, type TerminalRequest } from "./terminal";
export { listMusic } from "./music";

type Handlers = { [K in Exclude<keyof Api, "onBalanceApplied" | "onRecordLevel" | "onRecordWords" | "onProgress" | "onQuestionsChanged" | "onSkillsChanged" | "onSidekickChanged" | "onStepsChanged" | "onActivity" | "onResourceState" | "onNavigate" | "onOpenVersion" | "onChat" | "pathForFile" | "ask" | "renderFinished" | "retryStep" | "setEditor" | "saveTemplate" | "exportCut" | "getShootFocus" | "setShootFocus" | "makePrecut" | "listTemplates" | "listPrecuts" | "getEditor" | "getAutopilot" | "setAutopilot" | "appleSetEdit" | "appleControl" | "onAppleEvent">]: (...args: Parameters<NonNullable<Api[K]>>) => ReturnType<NonNullable<Api[K]>> };  // VO7-1: NonNullable admits optional channels; AV1 channels register below with the sender

const handlers: Handlers = {
  // ARCH2: a version the page draws stays whole in its listings for a while (noteShownVersion).
  draftTimeline: (root, cutId, version) => { noteShownVersion(root, cutId, version); return draftTimeline(root, cutId, version); },
  pieceLuts,
  balanceClips, balanceStatus, balanceHand,
  autoBasic,
  listMusic,
  musicCatalog,
  liveGrade,
  liveLut,
  shootSteps,
  passIdea,
  setClipTag,
  junkReview,
  trashClips,
  keepClips,
  relinkMissing: (root, folder) => import("./missing-media").then(m => m.relinkMissing(root, folder)),
  rethinkWithoutMissing: root => import("./missing-media").then(m => m.rethinkWithoutMissing(root)),
  addNewFiles: root => import("./missing-media").then(m => m.addNewFiles(root)),
  leaveOut: (root, clipIds, out) => import("./left-out").then(m => m.leaveOut(root, clipIds, out)),
  // FIX2: the page says read only up front when another precut owns this shoot.
  shootProgress: async root => { const [progress, elsewhere] = await Promise.all([shootProgress(root), import("./writer-lock").then(m => m.shootOpenElsewhere(root)).catch(() => false)]); return elsewhere ? { ...progress, openElsewhere: true } : progress; },
  relinkShoot,
  retryStage,
  pickFolder,
  addShoot,
  listShoots,
  loadShoot,
  setScript: (root: string, lines: string[]) =>
    judgeSetScript(root, lines, {
      onProgress: (e) => sendProgress({ root: e.root, clipId: e.clipId, stage: e.stage, pct: e.pct }),
    }).catch((error) => { stopStep(root, "clips", error); throw error; }),
  setFootageStar,
  starTake: judgeStarTake,
  sidekickThread,
  sidekickSend,
  listCuts: listCutsLight,  // ARCH2: light old versions; loadCutVersion gives one whole
  loadCutVersion,
  editCut,
  getEngine,
  listEngines,
  testEngine,
  openEngineHelp,
  startFirstRunDownloads,
  firstRunDownloads,
  // ONB2: the first run without AI or with it, and precut from the terminal.
  getEngineChoice: () => import("./settings").then(m => m.getEngineChoice()),
  aiStatus: fresh => import("./onboarding").then(m => m.aiStatus(!!fresh)),
  terminalStatus: engine => import("./terminal-setup").then(m => m.terminalStatus(engine)),
  setUpTerminal: (engine, step) => import("./terminal-setup").then(m => m.setUpTerminal(engine, step)),
  starterMusic: () => import("./music").then(m => m.starterMusic()),
  setStarterMusic: on => import("./music").then(m => m.setStarterMusic(on)),
  keepingAwake: () => import("./keep-awake").then(m => m.keepingAwake()),
  shootReadTime: root => import("./onboarding").then(m => m.shootReadTime(root)),
  installCommandLine,
  editTranscript,
  finishCut,
  checkSetup,
  listActivity,
  localFonts: async () => (await import("./fonts")).listInstalledFonts(),  // VO7-15
  cancelActivity,
  reportBusy: async busy => { governor.setBusy(!!busy); },  // PERF1
  getResourceState: async () => governor.state,
  fullSpeedForTask: async taskId => governor.fullSpeedForTask(taskId),
  setupPrecut: () => setupPrecut(),
  signInClaude: () => signInClaude(),
  renderLookPreviews, // G2: same local gallery channel; optional fourth argument also requests a stage still.
  appIcons,
  getPreferences,
  setPreferences,
  setEngine,
  getEngineModel,
  setEngineModel,
  listSkills,
  saveSkill,
  deleteSkill,
  revealSkills,
  getMusicFolder,
  setMusicFolder,
  pickMusicFolder,       // ONB1b: the one music folder choice (first run, Settings, Sound)
  revealInFinder,
  addMusicTracks,        // D5 (was N5)
  pickMusicTracks,     // D5 (was N5)
  pickOverlayFiles,
  motionStatus,
  chatSend,
  chatThread,
  chatStop,
  chatAnswer,
  exportTo, // D6
  addRequest,
  listRequests,
  getBrief, setBrief, listQuestions, answerQuestion,  // WR1
  duplicateCut,    // D9
  createCut,               // D9
  starCut,            // D9
  renderSampleLooks,   // O1
  renameCut,           // D5
  // VO7-1: the current revision, undo cursor and milestones. New channels only.
  revisionState, undoRevision, redoRevision, listVersionMilestones, saveVersion, restoreVersion,
  // VO7-4: cached waveform peaks for a piece's span. One new channel.
  getPeaks: (root, file, from, to) => import("./peaks").then(m => m.getPeaks(root, file, from, to)),
  forgetShoot,                                  // D1
  // J2/J3 replace these three placeholders with the real handlers (contract written ahead of the build; no UI calls them yet).
  // UL5/UL6 replace these three placeholders (contract written ahead of the build; no UI calls them yet).
  writePost,
  translateCaptions,
  measureAngles: root => import('./angles').then(m => m.measureAngles(root)),
  applyVocabulary: (root, options?: { undo: string }) => import("./vocabulary").then(m => m.applyVocabulary(root, options)),
  deleteCut,
  restoreCut,
  storageUsage: root => import('./storage').then(m => m.storageUsage(root)),  // R6
  clearCaches: root => import('./storage').then(m => m.clearCaches(root)),  // R6
  audioInputs: () => import("./recording").then(m => m.audioInputs()),
  recordStart: (root, deviceId) => import("./recording").then(m => m.recordStart(root, deviceId)),
  recordStop: recordingId => import("./recording").then(m => m.recordStop(recordingId)),
  voiceoverScript: (root, cutId) => import("./voiceover-script").then(m => m.voiceoverScript(root, cutId)),
  writeVoiceoverScript: (root, cutId, version, opts) => import("./voiceover-script").then(m => m.writeVoiceoverScript(root, cutId, version, opts)),
  setVoiceoverLine: (root, cutId, lineId, text) => import("./voiceover-script").then(m => m.setVoiceoverLine(root, cutId, lineId, text)),
  // OPEN1: the page opens the placed version from its snapshot at once (MCP's place_voiceover answer stays small).
  placeVoiceover: (root, cutId, recording, lineIds) => import("./voiceover-place").then(m => m.placeVoiceover(root, cutId, recording, lineIds)).then(result => ({ ...result, snapshot: savedSnapshot(result) })),
  followVoiceoverCaptions: (root, cutId, version, lineIds) => import("./voiceover-place").then(m => m.followVoiceoverCaptions(root, cutId, version, lineIds)),
  makeBetter: (root, cutId, version) => import("./critique").then(m => m.makeBetter(root, cutId, version)),  // MB1
  proposeBetter: (root, cutId, version) => import("./critique").then(m => m.proposeBetter(root, cutId, version)),  // V62
  applyBetter: (root, cutId, version, issueIds) => import("./critique").then(m => m.applyBetter(root, cutId, version, issueIds)),  // V62
  extensions,
  installExtension,
  removeExtension,
  soundLibrary,
  soundKey,
  generateSound,
};

// Connections share J3's handler, including when its implementation lands later.
setExtensionSoundKey(op => handlers.soundKey(op));

export function sendProgress(e: { root: string; clipId: string; stage: Stage; pct: number }): void {
  trackProgress(e);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
      try { w.webContents.send("api:progress", e); } catch { /* window closed */ }
    }
  }
}

setChatForwarder((root, turn) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try { window.webContents.send("api:chat", root, turn); } catch { /* window closed */ }
    }
  }
});

// WR1: a new or answered question reaches every live window; a closing window is skipped, never read.
setQuestionsForwarder(root => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const contents = win.webContents;
    if (!contents.isDestroyed()) { try { contents.send("api:questions-changed", root); } catch { /* window closed */ } }
  }
});

setProgressForwarder(sendProgress);
setStepsChangedForwarder(stepsChanged);

export function registerIpc(): void {
  app.on("browser-window-focus", () => { void import("./jobs").then(m => m.refreshOpenedShoots()).catch(error => console.warn("[footage] Folder check failed:", error)); });
  // A1 provisional IPC: keep the protected shared Api and preload untouched.
  setTerminalForwarder((owner, data) => {
    // Look the owner up by id: a closing window's webContents getter throws.
    const contents = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).map(win => win.webContents).find(value => !value.isDestroyed() && value.id === owner);
    if (contents && !contents.isDestroyed()) contents.send("terminal:data", data);
  });
  ipcMain.handle("terminal:open", (event, input: TerminalRequest) => terminalOpen(event.sender.id, input));
  ipcMain.handle("terminal:write", (event, id: string, data: string) => terminalWrite(event.sender.id, id, data));
  ipcMain.handle("terminal:resize", (event, id: string, cols: number, rows: number) => terminalResize(event.sender.id, id, cols, rows));
  ipcMain.handle("terminal:context", (event, id: string, context) => terminalContext(event.sender.id, id, context));
  ipcMain.handle("terminal:restart", (event, id: string, input: TerminalRequest) => terminalRestart(event.sender.id, id, input));
  app.on("before-quit", closeAllTerminals);
  const cancelHiddenLooks = async () => {
    const urls = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && !win.webContents.isDestroyed()).map(win => win.webContents.getURL());
    // R8b: leaving keeps clip colour measuring. It runs on the background lane, so the next open reuses it instead of starting over.
    for (const activity of await listActivity()) if (staleLookWork(activity, urls) && !activity.label.startsWith("Measuring clip colour")) await cancelActivity(activity.id);
  };
  app.on("browser-window-created", (_event, win) => {
    const owner = win.webContents.id;
    let edit = openEdit(win.webContents.getURL());
    win.webContents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (!mainFrame) return;
      const next = openEdit(url);
      if (next && edit && (next.root !== edit.root || next.cutId !== edit.cutId)) void terminalClose(owner);
      if (next) edit = next;
    });
    win.webContents.on("destroyed", () => { void terminalClose(owner); });
    win.webContents.on("did-navigate-in-page", (_event, _url, mainFrame) => { if (mainFrame) void cancelHiddenLooks(); });
    win.webContents.on("destroyed", () => { void cancelHiddenLooks(); });
  });
  // VO7-7: Clean read for the take viewer, and the current revision's captions note. Additive
  // channels beside the Api handlers (the shared contract names them later); proposal shapes are clean-read.ts's.
  ipcMain.handle("api:cleanRead", (_event, root: string, take: string, cut?: string) => import("./clean-read").then(m => m.cleanRead(root, take, cut)));
  ipcMain.handle("api:cleanReadPlan", (_event, root: string, take: string, cut: string | undefined, choices?: Record<string, unknown>) =>
    import("./clean-read").then(m => m.cleanReadPlan(root, take, cut, (choices ?? {}) as Parameters<typeof m.cleanReadPlan>[3])));
  ipcMain.handle("api:voiceoverCaptionsPending", async (_event, root: string, cutId: string, version: number) => {
    if (typeof cutId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(cutId) || !Number.isInteger(version)) throw new Error("Choose an edit version.");
    const record = await import("./sidekick").then(m => m.loadRevision(root, cutId, version, { light: true }));
    return record.captionsPending ?? null;
  });
  // VO7-8: an audio file dropped on the timeline from Finder, copied into the shoot as a take (additive channel).
  ipcMain.handle("api:importVoiceoverTake", (_event, root: string, file: string) => import("./recording").then(m => m.importTake(root, file)));
  // Add a recording: the native audio picker for one voiceover file, and the wait for its words before Clean read.
  ipcMain.handle("api:pickVoiceoverFile", () => import("./music").then(m => m.pickVoiceoverFile()));
  // VO8: the Voiceover panel is open (renewed while open) or closed; the warm transcriber follows it (additive channel).
  ipcMain.handle("api:voiceoverWarm", (_event, open: unknown) => import("./voiceover-worker").then(m => m.warmVoiceover(open === true)));
  ipcMain.handle("api:waitVoiceoverWords", async (_event, root: string, file: string) => {
    if (typeof root !== "string" || typeof file !== "string") throw new Error("Choose a saved voiceover take from this shoot.");
    await (await import("./voiceover-takes")).waitForTranscript(root, file);
  });
  // AV1: the Apple player. The sender rides along so its clock returns to the right window.
  ipcMain.handle("api:appleSetEdit", (event, root: string, cutId: string, version: number, request: import("../shared/schema").AppleSetEditRequest) =>
    import("./apple-player").then(m => m.appleSetEdit(event.sender, { root, cutId, version, state: { player: request.player, reason: request.reason, appleEnabled: request.appleEnabled }, timeline: request.timeline, rotations: request.rotations, voice: request.voice, at: request.at, look: request.look, sentAt: request.sentAt, layers: request.layers })));
  // AV2: plan folders a crash or a kill left behind (precut-apple-* in the temp folder) go a few seconds after launch.
  setTimeout(() => { void import("./apple-player").then(m => m.cleanupStaleApplePlans()).catch(() => {}); }, 3000).unref?.();
  ipcMain.handle("api:appleControl", (event, action: string, payload?: { at?: number; rate?: number; x?: number; y?: number; w?: number; h?: number; visible?: boolean; muted?: boolean; frames?: number; look?: string }) =>
    import("./apple-player").then(m => {
      if (action === "play") m.applePlay(payload?.at ?? 0, payload?.rate ?? 1);
      else if (action === "pause") m.applePause();
      else if (action === "seek") m.appleSeek(payload?.at ?? 0);
      else if (action === "visible") m.appleSetVisible(payload?.visible ?? true);
      else if (action === "muted") m.appleSetMuted(!!payload?.muted);
      else if (action === "look" && payload?.look) m.appleUpdateLook(payload.look);
      else if (action === "rect" && payload) m.appleSetRect(event.sender, { x: payload.x ?? 0, y: payload.y ?? 0, w: payload.w ?? 0, h: payload.h ?? 0, frames: payload.frames });
    }));
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`api:${name}`, async (event, ...args) => {
      if (name !== "renderLookPreviews") return (fn as (...a: unknown[]) => unknown)(...args);
      // A fading or hidden editor must not start gallery work on Footage.
      const edit = openEdit(event.sender.getURL());
      if (!edit && isSetupPreview(event.sender.getURL())) return (fn as (...a: unknown[]) => unknown)(...args);
      if (!edit || edit.root !== args[0]) throw new Error("Open this edit in Edits to preview its looks.");
      // ARCH2: a title needs the head of a log, not its history.
      const cut = await import("./cut-storage").then(m => m.readLogHead(cutFile(edit.root, edit.cutId))).catch(() => null) as unknown as { title?: string; versions: { version: number; title: string }[] } | null ?? await readCut(edit.root, edit.cutId);
      const version = cut.versions.find(value => value.version === edit.version) ?? cut.versions.at(-1);
      const title = cut.title || version?.title;
      if (!title) throw new Error("Open a saved edit to preview its looks.");
      const current = openEdit(event.sender.getURL());
      if (!current || current.root !== edit.root || current.cutId !== edit.cutId || current.version !== edit.version) throw new Error("The selected edit changed.");
      return runActivity({ kind: "looks", root: edit.root, target: { cutId: edit.cutId, version: version?.version, clipId: String(args[1]) },
        label: `Preparing look previews for ${title}`, cancelable: true }, () => (fn as (...a: unknown[]) => Promise<unknown>)(...args), { groupChildren: true, renderLane: "background" });
    });
  }
}

export type { Shoot };
