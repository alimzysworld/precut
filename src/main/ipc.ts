// Main-side handlers for window.api. Channel for method m is `api:${m}`;
// progress events go out on `api:progress`. S1 calls registerIpc() from
// src/main/index.ts and maps the preload onto these channels; S2+ replace
// the stub bodies. One handler per Api method, nothing else registers them.
import { ipcMain, BrowserWindow } from "electron";
import type { Api, Shoot, Stage } from "../shared/schema";
import {
  addShoot,
  listShoots,
  loadShoot,
  pickFolder,
  revealInFinder,
  setProgressForwarder,
} from "./jobs";
import { setScript as judgeSetScript, starTake as judgeStarTake, setClipTag } from "./judge";
import { makePrecut, listTemplates, saveTemplate, listPrecuts } from "./export";
import { ask } from "./ask";
import { sidekickThread, sidekickSend, listCuts, exportCut, passIdea } from "./sidekick";
import { getAutopilot, setAutopilot, getEngine, setEngine, getMusicFolder, setMusicFolder, pickMusicFolder } from "./settings";
import { shootSteps, stepsChanged, trackProgress, stopStep } from "./steps";
import { listSkills, saveSkill, deleteSkill, revealSkills } from "./skills";

type Handlers = { [K in Exclude<keyof Api, "onProgress" | "onSkillsChanged" | "onSidekickChanged" | "onStepsChanged">]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> };

const handlers: Handlers = {
  shootSteps,
  getAutopilot,
  setAutopilot,
  passIdea,
  setClipTag,
  retryStep: async () => {
    throw new Error("Send your request to sidekick again to retry.");
  },

  pickFolder,
  addShoot,
  listShoots,
  loadShoot,
  setScript: (root: string, lines: string[]) =>
    judgeSetScript(root, lines, {
      onProgress: (e) => sendProgress({ root: e.root, clipId: e.clipId, stage: e.stage, pct: e.pct }),
    }).catch((error) => { stopStep(root, "clips", error); throw error; }),
  starTake: judgeStarTake,
  makePrecut: async (...args) => {
    const result = await makePrecut(...args);
    stepsChanged(args[0]);
    return result;
  },
  listPrecuts,
  listTemplates,
  saveTemplate,
  ask,
  sidekickThread,
  sidekickSend,
  listCuts,
  exportCut,
  getEngine,
  setEngine,
  listSkills,
  saveSkill,
  deleteSkill,
  revealSkills,
  getMusicFolder,
  setMusicFolder,
  pickMusicFolder,
  revealInFinder,
};

export function sendProgress(e: { root: string; clipId: string; stage: Stage; pct: number }): void {
  trackProgress(e);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
      try { w.webContents.send("api:progress", e); } catch { /* window closed */ }
    }
  }
}

setProgressForwarder(sendProgress);

export function registerIpc(): void {
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`api:${name}`, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args));
  }
}

export type { Shoot };
