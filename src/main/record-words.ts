import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app, BrowserWindow } from "electron";

export type WordFollower = { write: (pcm: Buffer) => void; stop: () => void };
let preparing: Promise<string | null> | undefined;
let compiler: ChildProcess | undefined;
app.on("before-quit", () => { compiler?.kill("SIGTERM"); });
/** One content-addressed helper, compiled into this app profile. Failure only
 * selects timing; capture remains independent of speech availability. */
export function prepareRecordWords(): Promise<string | null> {
  return preparing ??= (async () => {
    if (process.platform !== "darwin") return null;
    if (app.isPackaged) {
      const bundled = path.join(process.resourcesPath, "tools/record-words");
      await fs.access(bundled); return bundled;
    }
    const source = path.resolve(__dirname, "../../pipeline/record-words.swift");
    const plist = path.join(path.dirname(source), "record-words.plist");
    const digest = createHash("sha256").update(await fs.readFile(source)).update(await fs.readFile(plist)).digest("hex").slice(0, 16);
    const dir = path.join(app.getPath("userData"), "speech-helper"), binary = path.join(dir, `record-words-${digest}`);
    await fs.mkdir(dir, { recursive: true });
    try { await fs.access(binary); return binary; } catch { /* build once */ }
    const output = `${binary}.${randomUUID()}.tmp`;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/xcrun", ["swiftc", "-O", "-module-cache-path", path.join(dir, "modules"), source, "-o", output, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist], { stdio: "ignore" });
        compiler = child;
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Speech helper took too long.")); }, 45000);
        child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", code => { compiler = undefined; clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Speech helper unavailable.")); });
      });
      await fs.rename(output, binary); return binary;
    } finally { await fs.rm(output, { force: true }); }
  })().catch(() => null);
}
export async function followRecordWords(recordingId: string, onWords?: (words: string[], available?: boolean) => void): Promise<WordFollower> {
  const emit = (words: string[], available?: boolean) => { if (onWords) { onWords(words, available); return; } for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) { try { win.webContents.send("record-words", { recordingId, words, available }); } catch { /* closing */ } }
  } };
  let child: ReturnType<typeof spawn> | undefined;
  let pending = "", stopped = false, available = true;
  const unavailable = () => { available = false; if (!stopped) emit([], false); };
  // Compilation (development only) never delays the selected microphone.
  void prepareRecordWords().then(binary => {
    if (stopped) return;
    if (!binary) { unavailable(); return; }
    child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    child.stdin!.on("error", unavailable); child.once("error", unavailable); child.once("close", unavailable);
    child.stdout!.on("data", chunk => {
      pending += chunk;
      if (pending.length > 65536) { pending = ""; return; }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const v = JSON.parse(line);
          if (Array.isArray(v.words) && v.words.length < 5000 && v.words.every((w: unknown) => typeof w === "string")) {
            if (!stopped) emit(v.words, typeof v.available === "boolean" ? v.available : undefined);
          }
        } catch { /* ignore malformed helper output */ }
      }
    });
  }).catch(unavailable);
  return {
    write(pcm) {
      if (!stopped && available && child?.stdin?.writable) {
        // Speech cannot backpressure or accumulate unbounded copies of capture.
        if (child.stdin.writableLength > 48000 * 2 * 2) { unavailable(); child.kill("SIGTERM"); return; }
        child.stdin.write(pcm);
      }
    },
    stop() { if (stopped) return; stopped = true; child?.stdin?.destroy(); child?.kill("SIGTERM"); },
  };
}
