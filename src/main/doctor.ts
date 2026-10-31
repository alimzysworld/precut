// Fixed, local checks only. No model invocation or cached authentication result.
import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import type { SetupCheck } from "../shared/schema";
import { supportDir, tool } from "./tools";
import { runActivity } from "./activity";
import { speechModelReady } from "./onboarding";

async function executable(name: string, searchPath: string): Promise<string | null> {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try { await access(file, constants.X_OK); return file; } catch { /* next directory */ }
  }
  return null;
}

function run(binary: string, args: string[], timeoutMs: number, env = process.env): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    let output = "";
    let settled = false;
    const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: output.trim() });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, Math.max(1, timeoutMs));
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(0, 32_768); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => finish(false));
    child.on("close", code => finish(code === 0));
  });
}

// Share the in-flight lookup too: icons are read only once per app session.
let appIconsCache: ReturnType<typeof appIcons> | undefined;
export async function appIcons(): Promise<Record<"resolve" | "premiere" | "finalcut" | "capcut" | "finder", { installed: boolean; icon: string | null }>> {
  return appIconsCache ??= (async () => {
    const missing = () => ({ installed: false, icon: null as string | null });
    const result = { resolve: missing(), premiere: missing(), finalcut: missing(), capcut: missing(), finder: missing() };
    try {
      const { app } = await import("electron");
      const fs = await import("node:fs/promises");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const bundles = {
        resolve: ["com.blackmagic-design.DaVinciResolve", "com.blackmagic-design.DaVinciResolveLite"],
        premiere: ["com.adobe.PremierePro.*", "com.adobe.PremierePro"],
        finalcut: ["com.apple.FinalCut"], capcut: ["com.lemon.lvoverseas"],
      };
      const exists = async (file: string) => fs.stat(file).then(s => s.isDirectory(), () => false);
      // Spotlight may be disabled or still indexing. Inspect bundles in the
      // Applications tree too, including versioned Adobe/Blackmagic folders.
      let fallback: Promise<{ file: string; id: string }[]> | undefined;
      async function applications(directory: string, depth = 0): Promise<string[]> {
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
        const nested = await Promise.all(entries.filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => {
          const file = path.join(directory, e.name);
          return e.name.endsWith(".app") ? [file] : depth < 3 ? applications(file, depth + 1) : [];
        }));
        return nested.flat();
      }
      async function applicationBundles() {
        const files = await applications("/Applications");
        const found: { file: string; id: string }[] = [];
        for (let start = 0; start < files.length; start += 8) {
          found.push(...await Promise.all(files.slice(start, start + 8).map(async file => {
            let id = "";
            try {
              const plist = path.join(file, "Contents", "Info.plist");
              const data = await fs.readFile(plist);
              id = data.toString().match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
              if (!id && data.subarray(0, 6).toString() === "bplist") {
                id = (await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], { timeout: 1500 })).stdout.trim();
              }
            } catch { /* An unreadable bundle cannot stop the menu. */ }
            return { file, id };
          })));
        }
        return found;
      }
      await Promise.all((Object.keys(result) as (keyof typeof result)[]).map(async key => {
        try {
          let file: string | undefined;
          if (key === "finder") file = "/System/Library/CoreServices/Finder.app";
          else {
            const ids = bundles[key];
            try {
              const query = ids.map(id => `kMDItemCFBundleIdentifier == '${id}'`).join(" || ");
              const { stdout } = await exec("/usr/bin/mdfind", [query], { timeout: 2000, maxBuffer: 1024 * 1024 });
              for (const candidate of stdout.split("\n").filter(p => p.endsWith(".app"))) {
                if (await exists(candidate)) { file = candidate; break; }
              }
            } catch { /* Use /Applications without Spotlight. */ }
            if (!file) {
              const apps = await (fallback ??= applicationBundles());
              file = apps.find(candidate => ids.some(id => id.endsWith("*") ? candidate.id.startsWith(id.slice(0, -1)) : candidate.id === id)
                || key === "capcut" && /^CapCut\.app$/i.test(path.basename(candidate.file)))?.file;
            }
          }
          if (!file || !await exists(file)) return;
          result[key].installed = true;
          // Logos belong to the user's installed apps; none are bundled.
          try {
            // app.getFileIcon crashes Electron 35 on macOS 26 (SIGTRAP in its thread pool,
            // reproduced 15 Oct). Read the app's own .icns and convert it with sips instead.
            const icon = await iconFromBundle(file);
            if (icon) result[key].icon = icon;
          } catch { /* Installed app, neutral initial tile in the renderer. */ }
        } catch { /* Missing or unreadable apps are always safe to display. */ }
      }));
    } catch { /* Icon discovery must never reject. */ }
    return result;
  })();
}
// The install sequence is fixed and has no model calls. Kept injectable so the
// same state machine can be tested without installing into the developer account.
export function createSetupInstaller(actions: {
  claudeInstalled: () => Promise<boolean>;
  installClaude: (progress: (message: string) => void) => Promise<void>;
  preparePython: (progress: (message: string) => void) => Promise<void>;
}) {
  let pending: Promise<void> | undefined;
  let status = { phase: "idle", message: "" };
  const progress = (message: string) => { status = { ...status, message }; };
  return {
    status: () => ({ ...status }),
    start(): Promise<void> {
      return pending ??= runActivity({ kind: "setup", root: null, target: null, label: "Setting up precut" }, async activity => {
        const report = (message: string) => { progress(message); activity.progress(null, message); };
        try {
          if (!await actions.claudeInstalled()) {
            status = { phase: "claude", message: "Installing Claude Code…" };
            report(status.message);
            await actions.installClaude(report);
            if (!await actions.claudeInstalled()) throw new Error("Claude Code installation did not finish. Try setup again.");
          }
          status = { phase: "python", message: "Preparing the Python environment…" };
          report(status.message);
          await actions.preparePython(report);
          status = { phase: "done", message: "precut is ready." };
          activity.done(status.message);
        } catch (error) {
          status = { phase: "error", message: "Setup did not finish. Check your connection and try again." };
          activity.fail(status.message);
          throw error;
        }
      }).finally(() => { pending = undefined; });
    },
  };
}

async function claudeBinary(): Promise<string | null> {
  const binary = tool("claude");
  if (path.isAbsolute(binary)) return binary;
  return executable("claude", process.env.PATH ?? "");
}

function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[key];
  return env;
}

const installer = createSetupInstaller({
  claudeInstalled: async () => (await (await import("./settings")).getEngine()) !== "claude" || Boolean(await claudeBinary()),
  installClaude: async progress => {
    // Official native installer. pipefail ensures curl errors cannot look like success.
    const result = await new Promise<boolean>(resolve => {
      const child = spawn("/bin/bash", ["-o", "pipefail", "-c", "/usr/bin/curl -fsSL https://claude.ai/install.sh | /bin/bash"],
        { env: subscriptionEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 15 * 60_000);
      const line = () => progress("Installing Claude Code…");
      child.stdout?.on("data", line);
      child.stderr?.on("data", line);
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("close", code => { clearTimeout(timer); resolve(code === 0); });
    });
    if (!result) throw new Error("Claude Code could not be installed. Check your connection and try again.");
  },
  preparePython: async progress => (await import("./jobs")).preparePython(progress),
});

// These actions are only called by explicit setup-screen button handlers.
export async function setupPrecut(): Promise<void> { await installer.start(); }

export async function signInClaude(): Promise<void> {
  const binary = await claudeBinary();
  if (!binary) throw new Error("Set up precut before signing in.");
  // Claude's documented first-run login is interactive. Terminal supplies a real
  // TTY and lets the person complete browser login or paste a returned code.
  // Both shell and AppleScript values are escaped independently.
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = "cd " + quote(supportDir()) + "; /usr/bin/env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY " + quote(binary);
  const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`;
  const result = await run("/usr/bin/osascript", ["-e", script], 10_000);
  if (!result.ok) throw new Error("Could not open Terminal. Allow precut to control Terminal in System Settings, then try again.");
}

export async function checkSetup(): Promise<SetupCheck[]> {
  // ONB1: only the engine the person picked has to be ready.
  const { getEngine, listEngines, aiOff } = await import("./settings");
  // ONB2: "Start without AI" is a ready setup with no engine row to fix, and no engine CLI is run to find out.
  const none = typeof aiOff === "function" && aiOff();
  const engine = await getEngine();
  const label = { claude: "Claude Code", codex: "Codex", muse: "Muse" }[engine];
  const found = none ? undefined : (await listEngines(true)).find(item => item.id === engine);
  const installed = Boolean(found?.installed);
  const signedIn = engine === "muse" ? installed : found?.signedIn === true;
  let pythonReady = false;
  try {
    await access(path.join(supportDir(), "venv/bin/python"), constants.X_OK);
    try {
      const marker = await readFile(path.join(supportDir(), "venv/.precut-ready"), "utf8");
      pythonReady = marker.includes("mlx-whisper==0.4.3") && marker.includes("librosa==0.11.0");
    } catch {
      // An environment made before the managed installer has no marker: ready when its packages are there.
      const lib = path.join(supportDir(), "venv/lib");
      const versions = await readdir(lib).catch(() => [] as string[]);
      for (const v of versions) {
        const site = path.join(lib, v, "site-packages");
        if (await access(path.join(site, "mlx_whisper")).then(() => true, () => false) &&
            await access(path.join(site, "librosa")).then(() => true, () => false)) pythonReady = true;
      }
    }
  } catch { /* explicit setup creates it */ }
  const status = installer.status();
  return [
    { id: "ffmpeg", name: "precut tools", ok: true, required: true, detail: "Included with the app", fix: null },
    none ? { id: "engine", name: "Claude or Codex", ok: false, required: false, detail: "Not chosen. precut works without them.", fix: "none" } :
    { id: "engine", name: `AI · ${label}`, ok: installed && signedIn, required: true,
      detail: !installed ? `${label} isn't installed` : signedIn ? (engine === "muse" ? "Installed" : "Signed in") : `${label} isn't signed in`,
      fix: !installed ? "install" : signedIn ? null : "login" },
    { id: "venv", name: "Python environment", ok: pythonReady, required: false,
      detail: status.phase === "claude" || status.phase === "python" || status.phase === "error" ? status.message : pythonReady ? "Ready" : "Installed when you set up precut", fix: null },
    { id: "python", name: "Speech model", ok: speechModelReady(), required: false,
      detail: speechModelReady() ? "Ready" : "About 1.6 GB, downloading in the background", fix: null },
  ];
}

async function iconFromBundle(appPath: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const run = promisify(execFile);
  try {
    let name = "";
    try { name = (await run("/usr/bin/defaults", ["read", path.join(appPath, "Contents/Info"), "CFBundleIconFile"], { timeout: 3000 })).stdout.trim(); }
    catch { /* fall back to any .icns below */ }
    const resources = path.join(appPath, "Contents/Resources");
    let icns = name ? path.join(resources, name.endsWith(".icns") ? name : `${name}.icns`) : "";
    try { await fsp.access(icns); } catch {
      const any = (await fsp.readdir(resources)).find((f) => f.endsWith(".icns"));
      if (!any) return null;
      icns = path.join(resources, any);
    }
    const out = path.join(os.tmpdir(), `precut-icon-${Buffer.from(appPath).toString("hex").slice(-24)}.png`);
    await run("/usr/bin/sips", ["-s", "format", "png", "-Z", "128", icns, "--out", out], { timeout: 8000 });
    const png = await fsp.readFile(out);
    return png.byteLength ? `data:image/png;base64,${png.toString("base64")}` : null;
  } catch { return null; }
}
