// PERF1: feeds the resource governor from Electron's powerMonitor. The governor
// itself is pure; everything that touches the OS lives here.
import { app, powerMonitor } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkoutFile } from "./bundle-paths";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { governor, type ThermalState } from "./resource-governor";

/** `pmset -g` prints " lowpowermode 1" when Low Power Mode is on. */
export const parseLowPower = (text: string): boolean => /^\s*lowpowermode\s+1\b/m.test(text);
export const parseBatteryPercent = (text: string): number | undefined => {
  const match = /\b(\d{1,3})%/.exec(text), percent = match ? Number(match[1]) : NaN;
  return percent >= 0 && percent <= 100 ? percent : undefined;
};

export function startPowerWatch(): void {
  let child: ChildProcess | undefined, stopped = false;
  app.once("before-quit", () => { stopped = true; child?.kill("SIGTERM"); });
  const thermal = (state: string): ThermalState => state === "nominal" || state === "fair" || state === "serious" || state === "critical" ? state : "unknown";
  const read = () => {
    try { governor.setThermal(thermal(powerMonitor.getCurrentThermalState())); } catch { /* not supported on this OS */ }
    try { governor.setPower({ onBattery: powerMonitor.isOnBatteryPower() }); } catch { /* desktop Mac */ }
    if (process.platform === "darwin") {
      execFile("/usr/bin/pmset", ["-g"], { timeout: 2000 }, (error, stdout) => { if (!error) governor.setPower({ lowPower: parseLowPower(stdout) }); });
      // Fast initial/event reading while the development helper compiles.
      execFile("/usr/bin/pmset", ["-g", "batt"], { timeout: 2000 }, (error, stdout) => {
        if (!error) governor.setPower({ batteryPercent: parseBatteryPercent(stdout) });
      });
    }
  };
  read();
  powerMonitor.on("thermal-state-change", (details: { state: string }) => governor.setThermal(thermal(details.state)));
  powerMonitor.on("on-battery", read);
  powerMonitor.on("on-ac", read);
  powerMonitor.on("resume", read);
  powerMonitor.on("speed-limit-change", read);
  app.on("browser-window-focus", read);
  if (process.platform === "darwin") void (async () => {
    let binary = path.join(process.resourcesPath ?? "", "tools/power-watch");
    if (!app.isPackaged) {
      const source = checkoutFile("pipeline/power-watch.swift");
      const digest = createHash("sha256").update(await fs.readFile(source)).digest("hex").slice(0, 16);
      const dir = path.join(app.getPath("userData"), "power-helper");
      await fs.mkdir(dir, { recursive: true });
      binary = path.join(dir, `power-watch-${digest}`);
      try { await fs.access(binary); } catch {
        await promisify(execFile)("/usr/bin/xcrun", ["swiftc", "-O", "-module-cache-path", path.join(dir, "modules"), source, "-o", binary], { timeout: 45000 });
      }
    }
    if (stopped) return;
    child = spawn(binary, [], { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", error => console.warn("[power]", error));
    let pending = "";
    child.stdout!.on("data", bytes => {
      pending += bytes;
      if (pending.length > 4096) { pending = ""; return; }
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const state = JSON.parse(line);
          if (typeof state.lowPower === "boolean" && Number.isFinite(state.batteryPercent) && state.batteryPercent >= 0 && state.batteryPercent <= 100)
            governor.setPower({ lowPower: state.lowPower, batteryPercent: state.batteryPercent });
        } catch { /* Ignore partial or unsupported native readings. */ }
      }
    });
  })().catch(error => console.warn("[power] Battery notifications unavailable:", error));
}
