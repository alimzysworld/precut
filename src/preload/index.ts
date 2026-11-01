import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Api } from "../shared/schema";

const api: Api = {
  draftTimeline: (...args) => ipcRenderer.invoke("api:draftTimeline", ...args),
  pieceLuts: (...args) => ipcRenderer.invoke("api:pieceLuts", ...args),
  liveGrade: (...args) => ipcRenderer.invoke("api:liveGrade", ...args),
  liveLut: (...args) => ipcRenderer.invoke("api:liveLut", ...args),
  shootSteps: (...args) => ipcRenderer.invoke("api:shootSteps", ...args),
  passIdea: (...args) => ipcRenderer.invoke("api:passIdea", ...args),
  setClipTag: (...args) => ipcRenderer.invoke("api:setClipTag", ...args),
  junkReview: (...args) => ipcRenderer.invoke("api:junkReview", ...args),
  trashClips: (...args) => ipcRenderer.invoke("api:trashClips", ...args),
  keepClips: (...args) => ipcRenderer.invoke("api:keepClips", ...args),
  relinkMissing: (...args) => ipcRenderer.invoke("api:relinkMissing", ...args),
  rethinkWithoutMissing: (...args) => ipcRenderer.invoke("api:rethinkWithoutMissing", ...args),
  addNewFiles: (...args) => ipcRenderer.invoke("api:addNewFiles", ...args),
  leaveOut: (...args) => ipcRenderer.invoke("api:leaveOut", ...args),
  onStepsChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, root: string) => cb(root);
    ipcRenderer.on("api:steps-changed", listener);
    return () => { ipcRenderer.removeListener("api:steps-changed", listener); };
  },
  pickFolder: (...args) => ipcRenderer.invoke("api:pickFolder", ...args),
  addShoot: (...args) => ipcRenderer.invoke("api:addShoot", ...args),
  listShoots: (...args) => ipcRenderer.invoke("api:listShoots", ...args),
  loadShoot: (...args) => ipcRenderer.invoke("api:loadShoot", ...args),
  setScript: (...args) => ipcRenderer.invoke("api:setScript", ...args),
  setFootageStar: (...args) => ipcRenderer.invoke("api:setFootageStar", ...args),
  starTake: (...args) => ipcRenderer.invoke("api:starTake", ...args),
  revealInFinder: (...args) => ipcRenderer.invoke("api:revealInFinder", ...args),
  listSkills: (...args) => ipcRenderer.invoke("api:listSkills", ...args),
  onSkillsChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("api:skills-changed", listener);
    return () => { ipcRenderer.removeListener("api:skills-changed", listener); };
  },
  saveSkill: (...args) => ipcRenderer.invoke("api:saveSkill", ...args),
  deleteSkill: (...args) => ipcRenderer.invoke("api:deleteSkill", ...args),
  revealSkills: (...args) => ipcRenderer.invoke("api:revealSkills", ...args),
  getMusicFolder: (...args) => ipcRenderer.invoke("api:getMusicFolder", ...args),
  setMusicFolder: (...args) => ipcRenderer.invoke("api:setMusicFolder", ...args),
  pickMusicFolder: (...args) => ipcRenderer.invoke("api:pickMusicFolder", ...args),
  sidekickThread: (...args) => ipcRenderer.invoke("api:sidekickThread", ...args),
  sidekickSend: (...args) => ipcRenderer.invoke("api:sidekickSend", ...args),
  onSidekickChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, root: string, cut?: { cutId: string; version: number }) => cb(root, cut);
    ipcRenderer.on("api:sidekick-changed", listener);
    return () => { ipcRenderer.removeListener("api:sidekick-changed", listener); };
  },
  listCuts: (...args) => ipcRenderer.invoke("api:listCuts", ...args),
  loadCutVersion: (...args) => ipcRenderer.invoke("api:loadCutVersion", ...args),  // ARCH2
  editCut: (...args) => ipcRenderer.invoke("api:editCut", ...args),
  listEngines: (...args) => ipcRenderer.invoke("api:listEngines", ...args),
  testEngine: (...args) => ipcRenderer.invoke("api:testEngine", ...args),
  openEngineHelp: (...args) => ipcRenderer.invoke("api:openEngineHelp", ...args),
  startFirstRunDownloads: (...args) => ipcRenderer.invoke("api:startFirstRunDownloads", ...args),
  getEngineChoice: (...args) => ipcRenderer.invoke("api:getEngineChoice", ...args),  // ONB2
  aiStatus: (...args) => ipcRenderer.invoke("api:aiStatus", ...args),
  terminalStatus: (...args) => ipcRenderer.invoke("api:terminalStatus", ...args),
  setUpTerminal: (...args) => ipcRenderer.invoke("api:setUpTerminal", ...args),
  starterMusic: (...args) => ipcRenderer.invoke("api:starterMusic", ...args),
  setStarterMusic: (...args) => ipcRenderer.invoke("api:setStarterMusic", ...args),
  keepingAwake: (...args) => ipcRenderer.invoke("api:keepingAwake", ...args),
  shootReadTime: (...args) => ipcRenderer.invoke("api:shootReadTime", ...args),
  firstRunDownloads: (...args) => ipcRenderer.invoke("api:firstRunDownloads", ...args),
  installCommandLine: (...args) => ipcRenderer.invoke("api:installCommandLine", ...args),
  editTranscript: (...args) => ipcRenderer.invoke("api:editTranscript", ...args),
  finishCut: (...args) => ipcRenderer.invoke("api:finishCut", ...args),
  setupPrecut: (...args) => ipcRenderer.invoke("api:setupPrecut", ...args),
  signInClaude: (...args) => ipcRenderer.invoke("api:signInClaude", ...args),
  checkSetup: (...args) => ipcRenderer.invoke("api:checkSetup", ...args),
  listActivity: (...args) => ipcRenderer.invoke("api:listActivity", ...args),
  localFonts: (...args) => ipcRenderer.invoke("api:localFonts", ...args),
  cancelActivity: (...args) => ipcRenderer.invoke("api:cancelActivity", ...args),
  musicCatalog: (...args) => ipcRenderer.invoke("api:musicCatalog", ...args),
  listMusic: (...args) => ipcRenderer.invoke("api:listMusic", ...args),
  onBalanceApplied: cb => { const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof cb>[0]) => cb(value); ipcRenderer.on("api:balanceApplied", listener); return () => ipcRenderer.removeListener("api:balanceApplied", listener); },
  balanceClips: (...args) => ipcRenderer.invoke("api:balanceClips", ...args),
  balanceStatus: (...args) => ipcRenderer.invoke("api:balanceStatus", ...args),
  balanceHand: (...args) => ipcRenderer.invoke("api:balanceHand", ...args),
  autoBasic: (...args) => ipcRenderer.invoke("api:autoBasic", ...args),
  addMusicTracks: (...args) => ipcRenderer.invoke("api:addMusicTracks", ...args),
  pickMusicTracks: (...args) => ipcRenderer.invoke("api:pickMusicTracks", ...args),
  pickOverlayFiles: (...args) => ipcRenderer.invoke("api:pickOverlayFiles", ...args),
  showWhatYouSay: (...args) => ipcRenderer.invoke("api:showWhatYouSay", ...args),
  motionStatus: (...args) => ipcRenderer.invoke("api:motionStatus", ...args),
  chatSend: (...args) => ipcRenderer.invoke("api:chatSend", ...args),
  chatThread: (...args) => ipcRenderer.invoke("api:chatThread", ...args),
  chatStop: (...args) => ipcRenderer.invoke("api:chatStop", ...args),
  chatAnswer: (...args) => ipcRenderer.invoke("api:chatAnswer", ...args),
  exportTo: (...args) => ipcRenderer.invoke("api:exportTo", ...args),
  getBrief: (...args) => ipcRenderer.invoke("api:getBrief", ...args),
  setBrief: (...args) => ipcRenderer.invoke("api:setBrief", ...args),
  listQuestions: (...args) => ipcRenderer.invoke("api:listQuestions", ...args),
  answerQuestion: (...args) => ipcRenderer.invoke("api:answerQuestion", ...args),
  onQuestionsChanged: (cb) => {
    const listener = (_event: unknown, root: string) => cb(root);
    ipcRenderer.on("api:questions-changed", listener);
    return () => { ipcRenderer.removeListener("api:questions-changed", listener); };
  },
  addRequest: (...args) => ipcRenderer.invoke("api:addRequest", ...args),
  listRequests: (...args) => ipcRenderer.invoke("api:listRequests", ...args),
  duplicateCut: (...args) => ipcRenderer.invoke("api:duplicateCut", ...args),
  createCut: (...args) => ipcRenderer.invoke("api:createCut", ...args),
  starCut: (...args) => ipcRenderer.invoke("api:starCut", ...args),
  renderSampleLooks: (...args) => ipcRenderer.invoke("api:renderSampleLooks", ...args),
  writePost: (...args) => ipcRenderer.invoke("api:writePost", ...args),
  translateCaptions: (...args) => ipcRenderer.invoke("api:translateCaptions", ...args),
  measureAngles: (...args) => ipcRenderer.invoke("api:measureAngles", ...args),
  applyVocabulary: (...args) => ipcRenderer.invoke("api:applyVocabulary", ...args),
  deleteCut: (...args) => ipcRenderer.invoke("api:deleteCut", ...args),
  restoreCut: (...args) => ipcRenderer.invoke("api:restoreCut", ...args),
  storageUsage: (...args) => ipcRenderer.invoke("api:storageUsage", ...args),
  clearCaches: (...args) => ipcRenderer.invoke("api:clearCaches", ...args),
  audioInputs: (...args) => ipcRenderer.invoke("api:audioInputs", ...args),
  recordStart: (...args) => ipcRenderer.invoke("api:recordStart", ...args),
  recordStop: (...args) => ipcRenderer.invoke("api:recordStop", ...args),
  onRecordLevel: (cb) => { const h = (_e: Electron.IpcRendererEvent, v: { recordingId: string; peakDb: number; rmsDb: number }) => cb(v); ipcRenderer.on("record-level", h); return () => ipcRenderer.removeListener("record-level", h); },
  voiceoverScript: (...args) => ipcRenderer.invoke("api:voiceoverScript", ...args),
  writeVoiceoverScript: (...args) => ipcRenderer.invoke("api:writeVoiceoverScript", ...args),
  setVoiceoverLine: (...args) => ipcRenderer.invoke("api:setVoiceoverLine", ...args),
  placeVoiceover: (...args) => ipcRenderer.invoke("api:placeVoiceover", ...args),
  followVoiceoverCaptions: (...args) => ipcRenderer.invoke("api:followVoiceoverCaptions", ...args),
  onRecordWords: (cb) => { const h = (_e: Electron.IpcRendererEvent, v: { recordingId: string; words: string[]; available?: boolean }) => cb(v); ipcRenderer.on("record-words", h); return () => ipcRenderer.removeListener("record-words", h); },
  makeBetter: (...args) => ipcRenderer.invoke("api:makeBetter", ...args),
  proposeBetter: (...args) => ipcRenderer.invoke("api:proposeBetter", ...args),
  applyBetter: (...args) => ipcRenderer.invoke("api:applyBetter", ...args),
  produceEdit: (...args) => ipcRenderer.invoke("api:produceEdit", ...args),  // PRO2
  produceOutcome: (...args) => ipcRenderer.invoke("api:produceOutcome", ...args),  // PRO2
  extensions: (...args) => ipcRenderer.invoke("api:extensions", ...args),
  installExtension: (...args) => ipcRenderer.invoke("api:installExtension", ...args),
  removeExtension: (...args) => ipcRenderer.invoke("api:removeExtension", ...args),
  soundLibrary: (...args) => ipcRenderer.invoke("api:soundLibrary", ...args),
  soundKey: (...args) => ipcRenderer.invoke("api:soundKey", ...args),
  generateSound: (...args) => ipcRenderer.invoke("api:generateSound", ...args),
  renameCut: (...args) => ipcRenderer.invoke("api:renameCut", ...args),
  // VO7-1: the current revision, undo cursor and milestones.
  revisionState: (...args) => ipcRenderer.invoke("api:revisionState", ...args),
  undoRevision: (...args) => ipcRenderer.invoke("api:undoRevision", ...args),
  redoRevision: (...args) => ipcRenderer.invoke("api:redoRevision", ...args),
  listVersionMilestones: (...args) => ipcRenderer.invoke("api:listVersionMilestones", ...args),
  saveVersion: (...args) => ipcRenderer.invoke("api:saveVersion", ...args),
  restoreVersion: (...args) => ipcRenderer.invoke("api:restoreVersion", ...args),
  // TRK1c: stick a graphic to a thing, and how far the tracker is.
  pinEdit: (...args) => ipcRenderer.invoke("api:pinEdit", ...args),
  // LOOK1: a scene's look, made real by main (pictures, the auto dim); the inspector saves the edit it returns.
  lookEdit: (...args) => ipcRenderer.invoke("api:lookEdit", ...args),
  // TRK2: lock a clip's frame on a thing (the MCP's lock handlers), progress on the same channel as the pin's.
  lockEdit: (...args) => ipcRenderer.invoke("api:lockEdit", ...args),
  onPinProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, progress: { cutId: string; itemId: string; pct: number }) => cb(progress);
    ipcRenderer.on("api:pin-progress", listener);
    return () => { ipcRenderer.removeListener("api:pin-progress", listener); };
  },
  // VO7-4: cached waveform peaks.
  getPeaks: (...args) => ipcRenderer.invoke("api:getPeaks", ...args),
  forgetShoot: (...args) => ipcRenderer.invoke("api:forgetShoot", ...args),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  onChat: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, root: string, turn: import("../shared/schema").ChatTurn) => cb(root, turn);
    ipcRenderer.on("api:chat", listener);
    return () => { ipcRenderer.removeListener("api:chat", listener); };
  },
  relinkShoot: (...args) => ipcRenderer.invoke("api:relinkShoot", ...args),
  shootProgress: (...args) => ipcRenderer.invoke("api:shootProgress", ...args),
  retryStage: (...args) => ipcRenderer.invoke("api:retryStage", ...args),
  onMenu: (cb: (command: string) => void) => {
    const listener = (_event: unknown, command: string) => cb(command);
    ipcRenderer.on("api:menu", listener);
    return () => { ipcRenderer.removeListener("api:menu", listener); };
  },
  onNavigate: (cb: (hash: string) => void) => {
    const listener = (_event: unknown, hash: string) => cb(hash);
    ipcRenderer.on("api:navigate", listener);
    return () => { ipcRenderer.removeListener("api:navigate", listener); };
  },
  onOpenVersion: (cb) => {
    const listener = (_event: unknown, value: Parameters<typeof cb>[0]) => cb(value);
    ipcRenderer.on("api:open-version", listener);
    return () => { ipcRenderer.removeListener("api:open-version", listener); };
  },
  onActivity: (cb) => {
    const listener = (_event: unknown, activity: Parameters<typeof cb>[0]) => cb(activity);
    ipcRenderer.on("api:activity", listener);
    return () => { ipcRenderer.removeListener("api:activity", listener); };
  },
  reportBusy: (...args) => ipcRenderer.invoke("api:reportBusy", ...args),
  getResourceState: (...args) => ipcRenderer.invoke("api:getResourceState", ...args),
  fullSpeedForTask: (...args) => ipcRenderer.invoke("api:fullSpeedForTask", ...args),
  onResourceState: (cb) => {
    const listener = (_event: unknown, state: Parameters<typeof cb>[0]) => cb(state);
    ipcRenderer.on("api:resourceState", listener);
    return () => { ipcRenderer.removeListener("api:resourceState", listener); };
  },
  // Forward all arguments, including G2's optional intensity/framed-still request.
  renderLookPreviews: (...args) => ipcRenderer.invoke("api:renderLookPreviews", ...args),
  appIcons: (...args) => ipcRenderer.invoke("api:appIcons", ...args),
  getPreferences: (...args) => ipcRenderer.invoke("api:getPreferences", ...args),
  setPreferences: (...args) => ipcRenderer.invoke("api:setPreferences", ...args),
  appleSetEdit: (...args) => ipcRenderer.invoke("api:appleSetEdit", ...args),
  appleControl: (...args) => ipcRenderer.invoke("api:appleControl", ...args),
  onAppleEvent: (cb) => { const listener = (_e: Electron.IpcRendererEvent, v: import("../shared/schema").AppleEvent) => cb(v); ipcRenderer.on("api:apple-event", listener); return () => ipcRenderer.removeListener("api:apple-event", listener); },
  getEngine: (...args) => ipcRenderer.invoke("api:getEngine", ...args),
  setEngine: (...args) => ipcRenderer.invoke("api:setEngine", ...args),
  getEngineModel: (...args) => ipcRenderer.invoke("api:getEngineModel", ...args),
  setEngineModel: (...args) => ipcRenderer.invoke("api:setEngineModel", ...args),
  onProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on("api:progress", listener);
    return () => {
      ipcRenderer.removeListener("api:progress", listener);
    };
  },
};

// VO7-7: Clean read for the take viewer, and the current revision's captions note (additive channels).
const cleanReadApi = {
  cleanRead: (...args: unknown[]) => ipcRenderer.invoke("api:cleanRead", ...args),
  cleanReadPlan: (...args: unknown[]) => ipcRenderer.invoke("api:cleanReadPlan", ...args),
  voiceoverCaptionsPending: (...args: unknown[]) => ipcRenderer.invoke("api:voiceoverCaptionsPending", ...args),
};
// VO7-8: a Finder audio file dropped on the timeline becomes a take (additive channel).
const voiceTakeApi = {
  importVoiceoverTake: (...args: unknown[]) => ipcRenderer.invoke("api:importVoiceoverTake", ...args),
  // Add a recording: one audio file from the native picker, then its words before Clean read.
  pickVoiceoverFile: () => ipcRenderer.invoke("api:pickVoiceoverFile"),
  waitVoiceoverWords: (...args: unknown[]) => ipcRenderer.invoke("api:waitVoiceoverWords", ...args),
  // VO8: keeps the warm voiceover transcriber while the panel is open.
  voiceoverWarm: (open: boolean) => ipcRenderer.invoke("api:voiceoverWarm", open),
};

// SIGN2: the update line in the top bar and Settings' "Check for updates" (additive channels).
const updaterApi = {
  updateStatus: () => ipcRenderer.invoke("api:updateStatus"),
  checkForUpdates: () => ipcRenderer.invoke("api:checkForUpdates"),
  // REL2: Settings, About: version, licence and the licence texts in the app (additive channels).
  about: () => ipcRenderer.invoke("api:about"),
  readLicence: (file: string) => ipcRenderer.invoke("api:readLicence", file),
  openLicence: (file: string) => ipcRenderer.invoke("api:openLicence", file),
  onUpdateStatus: (cb: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown) => cb(status);
    ipcRenderer.on("api:update-status", listener);
    return () => { ipcRenderer.removeListener("api:update-status", listener); };
  },
};

const stFiles = {
  pathFor: (file: File): string => webUtils.getPathForFile(file),
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("api", { ...api, ...cleanReadApi, ...voiceTakeApi, ...updaterApi });
  contextBridge.exposeInMainWorld("stFiles", stFiles);
} else {
  const w = globalThis as unknown as { api: Api; stFiles: typeof stFiles };
  w.api = { ...api, ...cleanReadApi, ...voiceTakeApi, ...updaterApi };
  w.stFiles = stFiles;
}
