import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Api } from "../shared/schema";

const api: Api = {
  shootSteps: (...args) => ipcRenderer.invoke("api:shootSteps", ...args),
  retryStep: (...args) => ipcRenderer.invoke("api:retryStep", ...args),
  getAutopilot: (...args) => ipcRenderer.invoke("api:getAutopilot", ...args),
  setAutopilot: (...args) => ipcRenderer.invoke("api:setAutopilot", ...args),
  passIdea: (...args) => ipcRenderer.invoke("api:passIdea", ...args),
  setClipTag: (...args) => ipcRenderer.invoke("api:setClipTag", ...args),
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
  starTake: (...args) => ipcRenderer.invoke("api:starTake", ...args),
  makePrecut: (...args) => ipcRenderer.invoke("api:makePrecut", ...args),
  listTemplates: (...args) => ipcRenderer.invoke("api:listTemplates", ...args),
  saveTemplate: (...args) => ipcRenderer.invoke("api:saveTemplate", ...args),
  ask: (...args) => ipcRenderer.invoke("api:ask", ...args),
  revealInFinder: (...args) => ipcRenderer.invoke("api:revealInFinder", ...args),
  listPrecuts: (...args) => ipcRenderer.invoke("api:listPrecuts", ...args),
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
    const listener = (_e: Electron.IpcRendererEvent, root: string) => cb(root);
    ipcRenderer.on("api:sidekick-changed", listener);
    return () => { ipcRenderer.removeListener("api:sidekick-changed", listener); };
  },
  listCuts: (...args) => ipcRenderer.invoke("api:listCuts", ...args),
  exportCut: (...args) => ipcRenderer.invoke("api:exportCut", ...args),
  getEngine: (...args) => ipcRenderer.invoke("api:getEngine", ...args),
  setEngine: (...args) => ipcRenderer.invoke("api:setEngine", ...args),
  onProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on("api:progress", listener);
    return () => {
      ipcRenderer.removeListener("api:progress", listener);
    };
  },
};

const stFiles = {
  pathFor: (file: File): string => webUtils.getPathForFile(file),
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("api", api);
  contextBridge.exposeInMainWorld("stFiles", stFiles);
} else {
  const w = globalThis as unknown as { api: Api; stFiles: typeof stFiles };
  w.api = api;
  w.stFiles = stFiles;
}
