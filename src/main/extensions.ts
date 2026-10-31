// Manifest-owned add-ons. Never accept URLs, commands or paths from an IPC caller.
import { app } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkoutFile } from "./bundle-paths";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Api, ExtensionInfo } from "../shared/schema";
import { runActivity, withRenderSlot, type ActivityHandle } from "./activity";
import { tool } from "./tools";

type Download = { file: string; url: string; officialHost: string; redirectHosts?: string[]; sha256: string; size: number; unpack: "none" | "zip" | "tar" };
export type ExtensionManifest = { id: string; name: string; kind: "install" | "connect"; what: string; sizeBytes?: number; version?: string;
  downloads: Download[]; setup: { command: string; args: string[] }[] };
type Saved = Pick<ExtensionInfo, "state" | "version" | "error">;
type SoundKey = Api["soundKey"];
let soundKey: SoundKey = async () => ({ elevenlabs: false });
export function setExtensionSoundKey(handler: SoundKey): void { soundKey = handler; }

// Both unpacking and setup run with writes confined by macOS, offline. Reject
// archive links and traversal before extracting even an officially pinned file.
const unpackScript = String.raw`import pathlib,sys,zipfile,tarfile,stat
src,kind=sys.argv[1:]
base=pathlib.Path.cwd().resolve()
def check(name):
 p=pathlib.Path(name)
 if p.is_absolute() or '..' in p.parts or not (base/p).resolve().is_relative_to(base): raise ValueError('Unsafe path in add-on archive')
if kind=='zip':
 with zipfile.ZipFile(src) as z:
  for m in z.infolist():
   check(m.filename)
   if stat.S_ISLNK(m.external_attr>>16): raise ValueError('Links are not allowed in add-on archives')
  z.extractall(base)
else:
 with tarfile.open(src) as t:
  for m in t.getmembers():
   check(m.name)
   if not (m.isfile() or m.isdir()): raise ValueError('Links and devices are not allowed in add-on archives')
  t.extractall(base)
`;
export async function runExtensionCommand(command: string, args: string[], folder: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Add-on setup needs the Mac file sandbox.");
  const canonical = await fs.realpath(folder);
  const profile = `(version 1) (deny default) (allow process* file-read* sysctl-read) (allow file-write* (subpath ${JSON.stringify(canonical)}) (literal "/dev/null"))`;
  const env: NodeJS.ProcessEnv = { PATH: `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:${path.dirname(process.execPath)}`,
    HOME: folder, TMPDIR: path.join(folder, "tmp"), XDG_CACHE_HOME: path.join(folder, "cache"),
    PIP_CACHE_DIR: path.join(folder, "cache/pip"), PIP_CONFIG_FILE: "/dev/null", PIP_NO_INDEX: "1", PIP_REQUIRE_VIRTUALENV: "1",
    UV_CACHE_DIR: path.join(folder, "cache/uv"), UV_NO_CONFIG: "1", UV_OFFLINE: "1", PYTHONNOUSERSITE: "1" };
  await new Promise<void>((resolve, reject) => {
    let launchError: Error | undefined;
    const child = spawn("/usr/bin/nice", ["-n", "10", "/usr/bin/sandbox-exec", "-p", profile, "/usr/bin/env", command, ...args],
      { cwd: folder, env, signal, killSignal: "SIGKILL", detached: true, stdio: "ignore" });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } };
    signal.addEventListener("abort", kill, { once: true });
    // Wait for the process to close before the installer removes partial files.
    child.once("error", error => { launchError = error; });
    child.once("close", code => {
      signal.removeEventListener("abort", kill);
      if (signal.aborted) reject(signal.reason);
      else if (launchError) reject(new Error("Could not start add-on setup. Try installing again."));
      else if (code === 0) resolve();
      else reject(new Error("Add-on setup could not finish. Try installing again."));
    });
    if (signal.aborted) kill();
  });
}

export function createExtensionRegistry(deps: {
  userData: string; manifest: () => Promise<ExtensionManifest[]>; soundKey: SoundKey;
  fetch?: typeof fetch; allowLocalDownloads?: boolean;
  activity?: typeof runActivity; slot?: typeof withRenderSlot; command?: typeof runExtensionCommand;
}) {
  const base = path.resolve(deps.userData, "extensions");
  let saved: Record<string, Saved> = Object.create(null);
  let ready: Promise<ExtensionManifest[]> | undefined;
  let writes = Promise.resolve();
  const pending = new Map<string, Promise<ExtensionInfo>>();
  const request = deps.fetch ?? fetch;
  const execute = deps.command ?? runExtensionCommand;
  async function noLink(target: string) {
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("The add-on folder cannot be a link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  function persist() {
    const next = writes.catch(() => {}).then(async () => {
      const temp = path.join(base, `.state-${randomUUID()}.tmp`);
      try { await fs.writeFile(temp, JSON.stringify(saved), { mode: 0o600, flag: "wx" }); await fs.rename(temp, path.join(base, ".state.json")); }
      finally { await fs.rm(temp, { force: true }); }
    });
    writes = next; return next;
  }
  async function load() {
    if (!ready) ready = (async () => {
      const entries = await deps.manifest();
      const ids = new Set<string>();
      for (const e of entries) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.id) || ids.has(e.id)) throw new Error("The add-on list has an invalid id.");
        ids.add(e.id);
      }
      await noLink(base); await fs.mkdir(base, { recursive: true });
      await noLink(path.join(base, ".state.json"));
      try {
        const value: unknown = JSON.parse(await fs.readFile(path.join(base, ".state.json"), "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved add-ons.");
        saved = Object.assign(Object.create(null), value);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read saved add-ons."); }
      for (const e of entries) if (saved[e.id]?.state === "installing") {
        await noLink(path.join(base, e.id)); await fs.rm(path.join(base, e.id), { recursive: true, force: true });
        saved[e.id] = { state: "failed", error: "Installation was interrupted. Try again." };
      }
      await persist(); return entries;
    })();
    return ready;
  }
  async function entry(id: string) {
    const e = (await load()).find(e => e.id === id);
    if (!e) throw new Error("That add-on is not in the list.");
    return e;
  }
  async function info(e: ExtensionManifest): Promise<ExtensionInfo> {
    const { id, name, kind, what, sizeBytes } = e;
    let status: Saved = saved[id] ?? { state: "available" };
    if (kind === "connect") status = { state: (await deps.soundKey("status")).elevenlabs ? "installed" : "available" };
    if (kind === "install" && status.state === "installed") {
      await noLink(path.join(base, id));
      if (status.version !== e.version || !await fs.stat(path.join(base, id)).then(s => s.isDirectory(), () => false)) status = { state: "available" };
    }
    return { id, name, kind, what, sizeBytes, ...status };
  }
  function validate(e: ExtensionManifest) {
    if (!e.downloads.length) throw new Error("This add-on is waiting for verified downloads.");
    for (const d of e.downloads) {
      if (!/^[a-f0-9]{64}$/i.test(d.sha256)) throw new Error("This add-on is waiting for a verified download checksum. Nothing was installed.");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(d.file) || !["none", "zip", "tar"].includes(d.unpack)) throw new Error("This add-on has an invalid download path.");
      let url: URL; try { url = new URL(d.url); } catch { throw new Error("This add-on is waiting for its official download address."); }
      const local = deps.allowLocalDownloads && ["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol === "http:";
      if ((!local && url.protocol !== "https:") || url.hostname !== d.officialHost || url.username || url.password) throw new Error("Add-ons must download from their pinned official source.");
      if (!Number.isSafeInteger(d.size) || d.size <= 0) throw new Error("This add-on is waiting for a verified download size.");
    }
    if (!e.version || e.version.startsWith("TODO")) throw new Error("This add-on is waiting for a pinned version.");
  }
  async function download(d: Download, folder: string, activity: ActivityHandle, progress: (bytes: number) => void) {
    // Release/model CDNs redirect. Each hop needs an explicit manifest host;
    // bytes still have to match the original pin. Other entries reject redirects.
    let address = d.url;
    let response = await request(address, { signal: activity.signal, redirect: d.redirectHosts?.length ? "manual" : "error" });
    for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop >= 4 || !d.redirectHosts?.length) throw new Error("The add-on download redirected unexpectedly.");
      const next = new URL(location, address);
      if (next.protocol !== "https:" || next.username || next.password || ![d.officialHost, ...d.redirectHosts].includes(next.hostname)) throw new Error("The add-on download left its pinned official sources.");
      address = next.href;
      response = await request(address, { signal: activity.signal, redirect: "manual" });
    }
    if (!response.ok || !response.body) throw new Error("Could not download this add-on. Try again.");
    const output = await fs.open(path.join(folder, "downloads", d.file), "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        activity.signal.throwIfAborted(); bytes += chunk.length;
        if (bytes > d.size) throw new Error("The add-on download has the wrong size. Nothing was installed.");
        hash.update(chunk); await output.writeFile(chunk); progress(chunk.length);
      }
    } finally { await output.close(); }
    if (bytes !== d.size) throw new Error("The add-on download is incomplete. Try again.");
    if (hash.digest("hex") !== d.sha256.toLowerCase()) throw new Error("The add-on download did not match its checksum. Nothing was installed.");
  }
  async function install(id: string): Promise<ExtensionInfo> {
    if (pending.has(id)) return pending.get(id)!;
    const work = (async () => {
      const e = await entry(id);
      if (e.kind === "connect") {
        if (!(await deps.soundKey("status")).elevenlabs) throw new Error("Connect your ElevenLabs key in Settings, Extensions first.");
        return info(e);
      }
      if ((await info(e)).state === "installed") return info(e);
      const folder = path.join(base, id);
      await noLink(folder);
      // A missing pin refuses before any download or setup.
      try { validate(e); } catch (error) {
        saved[id] = { state: "failed", error: (error as Error).message }; await persist(); throw error;
      }
      saved[id] = { state: "installing" }; await persist();
      try {
        await (deps.activity ?? runActivity)({ kind: "setup", root: null, target: null, label: `Installing ${e.name.toLowerCase()} add-on`, cancelable: true }, activity =>
          (deps.slot ?? withRenderSlot)(activity, async () => {
            activity.signal.throwIfAborted();
            await fs.rm(folder, { recursive: true, force: true });
            for (const sub of ["downloads", "tmp", "cache"]) await fs.mkdir(path.join(folder, sub), { recursive: true });
            const total = e.downloads.reduce((sum, d) => sum + d.size, 0); let received = 0;
            for (const d of e.downloads) await download(d, folder, activity, bytes => { received += bytes; activity.progress(received / total * 100, ""); });
            // Every download is verified before any code or archive is used.
            activity.progress(null, "Getting ready");
            for (const d of e.downloads) if (d.unpack !== "none") await execute("python3", ["-I", "-c", unpackScript, path.join("downloads", d.file), d.unpack], folder, activity.signal);
            for (const step of e.setup) { activity.signal.throwIfAborted(); await execute(step.command === "@python" ? tool("python3") : step.command, step.args, folder, activity.signal); }
            activity.signal.throwIfAborted(); saved[id] = { state: "installed", version: e.version }; await persist();
          }, "background"));
        return info(e);
      } catch (error) {
        await fs.rm(folder, { recursive: true, force: true });
        saved[id] = { state: "failed", error: (error as Error).name === "AbortError" ? "Installation canceled." : (error as Error).message };
        await persist(); throw error;
      }
    })();
    pending.set(id, work);
    try { return await work; } finally { pending.delete(id); }
  }
  async function remove(id: string): Promise<ExtensionInfo> {
    const e = await entry(id);
    if (pending.has(id)) throw new Error("Cancel installation before removing this add-on.");
    if (e.kind === "connect") {
      await deps.soundKey("clear");
      if ((await deps.soundKey("status")).elevenlabs) throw new Error("Could not disconnect ElevenLabs. Try again.");
    } else {
      const folder = path.join(base, id); await noLink(folder);
      await fs.rm(folder, { recursive: true, force: true });
    }
    delete saved[id]; await persist(); return info(e);
  }
  return { list: async () => Promise.all((await load()).map(info)), install, remove };
}
let registry: ReturnType<typeof createExtensionRegistry> | undefined;
function extensionsRegistry() {
  return registry ??= createExtensionRegistry({ userData: process.env.SIDETHING_USER_DATA ?? app.getPath("userData"),
    manifest: async () => JSON.parse(await fs.readFile(app.isPackaged ? path.join(process.resourcesPath, "extensions.json") : checkoutFile("resources/extensions.json"), "utf8")),
    soundKey: op => soundKey(op) });
}
// REL2: Sound separation's wheels and setup need macOS 26 (Darwin 25). On an older Mac the controls that need it hide.
function withSupport<T extends ExtensionInfo>(info: T): T {
  return info.id === "sound-separation" && Number(os.release().split(".")[0]) < 25 ? { ...info, unsupported: "Needs macOS 26 or newer." } : info;
}
export const extensions = async () => (await extensionsRegistry().list()).map(withSupport);
export const installExtension = (id: string) => extensionsRegistry().install(id);
export const removeExtension = (id: string) => extensionsRegistry().remove(id);

// Feature/status reads must not initialise the registry, persist state, install
// or prompt. The feature can pass this info straight to the shared AddOnPrompt.
export async function readExtension(id: string, userData = process.env.SIDETHING_USER_DATA ?? app.getPath("userData")): Promise<ExtensionInfo> {
  const manifest: ExtensionManifest[] = JSON.parse(await fs.readFile(app.isPackaged ? path.join(process.resourcesPath, "extensions.json") : checkoutFile("resources/extensions.json"), "utf8"));
  const entry = manifest.find(item => item.id === id);
  if (!entry) throw new Error("That add-on is not in the list.");
  for (const file of [path.join(userData, "extensions"), path.join(userData, "extensions/.state.json"), path.join(userData, "extensions", id)]) {
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("The add-on folder cannot be a link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let saved: Saved | undefined;
  try { saved = JSON.parse(await fs.readFile(path.join(userData, "extensions/.state.json"), "utf8"))[id]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const { name, what, kind, sizeBytes } = entry;
  if (saved?.state === "installed" && (saved.version !== entry.version || !await fs.stat(path.join(userData, "extensions", id)).then(s => s.isDirectory(), () => false))) saved = undefined;
  if (id === "sound-separation" && saved?.state === "installed") {
    for (const file of ["venv/bin/python", "deep-filter", "models/htdemucs.safetensors", "models/htdemucs_config.json"]) {
      if (!await fs.stat(path.join(userData, "extensions", id, file)).then(s => s.isFile(), () => false)) { saved = undefined; break; }
    }
  }
  return { id, name, what, kind, sizeBytes, ...(saved ?? { state: "available" as const }) };
}
