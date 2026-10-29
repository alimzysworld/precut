// ONB2: "Use precut from your terminal". For Claude Code and Codex, four fixed steps, each checked:
//   command  the `precut` command in ~/.local/bin (cli.ts installCommandLine)
//   connect  precut's MCP server registered in the engine's user scope, through the engine's own `mcp add`
//            (so precut never edits another tool's config file by hand; other servers and settings stay as they were)
//   skill    the precut skill (terminal-skill.ts) in ~/.claude/skills/precut or ~/.codex/skills/precut
//   check    the engine itself lists the precut server, and the skill file is where it reads skills
// Any failure carries the command to copy and run by hand. No model call anywhere here.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TerminalSetup, TerminalStep } from "../shared/schema";
import { SKILL_MARKER, skillFile } from "./terminal-skill";

type Agent = "claude" | "codex";
const LABEL: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };
export const FIRST_PROMPT: Record<Agent, string> = {
  claude: 'claude "make a 40 second short from my newest shoot"',
  codex: 'codex "make a 40 second short from my newest shoot"',
};
const STEPS: TerminalStep[] = ["command", "connect", "skill", "check"];
const results = new Map<Agent, TerminalSetup["steps"]>();

async function home(): Promise<string> { return (await import("electron")).app.getPath("home"); }
async function commandPath(): Promise<string> { return path.join(await home(), ".local/bin/precut"); }
async function shimPath(): Promise<string> {
  const { app } = await import("electron");
  return app.isPackaged ? path.join(process.resourcesPath, "precut") : path.join(app.getAppPath(), "build/precut");
}
async function skillPath(agent: Agent): Promise<string> { return path.join(await home(), agent === "claude" ? ".claude" : ".codex", "skills/precut/SKILL.md"); }
const q = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** The commands a person runs by hand when a step can't be done from here. */
export async function copyCommand(agent: Agent, step: TerminalStep): Promise<string> {
  const target = await commandPath();
  if (step === "command") return `mkdir -p ~/.local/bin && ln -sf ${q(await shimPath())} ~/.local/bin/precut`;
  if (step === "connect" || step === "check") return agent === "claude"
    ? `claude mcp add --scope user precut -- ${q(target)} --mcp`
    : `codex mcp add precut -- ${q(target)} --mcp`;
  return `${q(target)} setup ${agent}`;
}

async function cli(agent: Agent): Promise<string | null> {
  try { return await (await import("./ai")).resolveBinary(agent); } catch { return null; }
}
async function run(binary: string, args: string[]): Promise<{ code: number; out: string }> {
  const ai = await import("./ai");
  const { app } = await import("electron");
  // From precut's own empty folder, as the engine probes do: never the home folder (macOS would ask about Desktop).
  const cwd = path.join(app.getPath("userData"), "engine-probe");
  await fs.mkdir(cwd, { recursive: true });
  try {
    const result = await ai.runChild(binary, args, { cwd, env: ai.subscriptionEnv(), timeoutMs: 30_000 });
    return { code: result.code, out: `${result.stdout}\n${result.stderr}` };
  } catch (error) { return { code: 1, out: error instanceof Error ? error.message : String(error) }; }
}

/** Does the engine list a precut server that runs our command? */
async function registered(agent: Agent, binary: string): Promise<"ours" | "other" | "missing"> {
  const target = await commandPath();
  const got = await run(binary, ["mcp", "get", "precut"]);
  if (got.code === 0 && /precut/i.test(got.out)) return got.out.includes(target) ? "ours" : "other";
  // An older CLI without `mcp get`: read the list instead.
  const listed = await run(binary, ["mcp", "list"]);
  const line = listed.out.split("\n").find(entry => /^\s*precut\b/.test(entry));
  return !line ? "missing" : line.includes(target) ? "ours" : "other";
}

async function step(agent: Agent, name: TerminalStep): Promise<{ ok: boolean; detail: string | null }> {
  const label = LABEL[agent];
  if (name === "command") {
    try {
      const { installCommandLine } = await import("./cli");
      const result = await installCommandLine();
      return { ok: true, detail: result.onPath ? result.path : `${result.path}. Add ~/.local/bin to your PATH to type precut.` };
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : "Couldn't add the precut command." }; }
  }
  if (name === "skill") {
    try {
      const file = await skillPath(agent);
      const existing = await fs.readFile(file, "utf8").catch(() => null);
      if (existing !== null && !existing.includes(SKILL_MARKER)) return { ok: false, detail: `A skill named precut is already in ${path.dirname(file)}. Move it aside, then try again.` };
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, skillFile(agent));
      await fs.rename(temp, file);
      return { ok: true, detail: file };
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : "Couldn't install the skill." }; }
  }
  const binary = await cli(agent);
  if (!binary) return { ok: false, detail: `${label} isn't installed on this Mac yet.` };
  if (name === "connect") {
    const target = await commandPath();
    const now = await registered(agent, binary);
    if (now === "ours") return { ok: true, detail: `Already connected to ${label}.` };
    // Replace only precut's own entry; every other server stays as it is.
    if (now === "other") await run(binary, agent === "claude" ? ["mcp", "remove", "--scope", "user", "precut"] : ["mcp", "remove", "precut"]);
    const added = await run(binary, agent === "claude" ? ["mcp", "add", "--scope", "user", "precut", "--", target, "--mcp"] : ["mcp", "add", "precut", "--", target, "--mcp"]);
    if (added.code !== 0) return { ok: false, detail: added.out.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? `${label} didn't accept the connection.` };
    return { ok: true, detail: `Connected in ${label}'s user settings.` };
  }
  // check: the engine itself must list our server, and the skill must be where it reads skills.
  const seen = await registered(agent, binary);
  const skill = await fs.readFile(await skillPath(agent), "utf8").catch(() => "");
  if (seen !== "ours") return { ok: false, detail: `${label} doesn't list precut yet.` };
  if (!/^---\nname: precut\n/.test(skill)) return { ok: false, detail: "The precut skill isn't where it should be." };
  return { ok: true, detail: `${label} lists precut and its skill.` };
}

function snapshot(agent: Agent, installed: boolean): TerminalSetup {
  const steps = results.get(agent) ?? { command: null, connect: null, skill: null, check: null };
  return { engine: agent, installed, steps: { ...steps }, done: STEPS.every(name => steps[name]?.ok), copy: null, prompt: FIRST_PROMPT[agent] };
}

export async function setUpTerminal(agent: Agent, name: TerminalStep): Promise<TerminalSetup> {
  if (agent !== "claude" && agent !== "codex") throw new Error("Choose Claude Code or Codex.");
  if (!STEPS.includes(name)) throw new Error("Choose a setup step.");
  const steps = results.get(agent) ?? { command: null, connect: null, skill: null, check: null };
  steps[name] = await step(agent, name);
  results.set(agent, steps);
  const setup = snapshot(agent, Boolean(await cli(agent)));
  if (!steps[name]!.ok) setup.copy = await copyCommand(agent, name);
  return setup;
}

/** Already set up? Read-only: the command, the engine's server list and the skill file, nothing changed. */
export async function terminalStatus(agent: Agent): Promise<TerminalSetup> {
  if (agent !== "claude" && agent !== "codex") throw new Error("Choose Claude Code or Codex.");
  const binary = await cli(agent);
  if (binary && !results.has(agent)) {
    const target = await commandPath();
    const command = await fs.readlink(target).then(() => true, () => false);
    const skill = (await fs.readFile(await skillPath(agent), "utf8").catch(() => "")).includes(SKILL_MARKER);
    if (command && skill && await registered(agent, binary) === "ours") {
      const ok = { ok: true, detail: null };
      results.set(agent, { command: ok, connect: ok, skill: ok, check: ok });
    }
  }
  return snapshot(agent, Boolean(binary));
}

/** `precut setup claude|codex`: the same four steps from the terminal. */
export async function setUpFromCli(agent: Agent, say: (line: string) => void): Promise<boolean> {
  const words: Record<TerminalStep, string> = { command: "Add the precut command", connect: `Connect precut to ${LABEL[agent]}`, skill: "Install the precut skill", check: `Check ${LABEL[agent]} can see it` };
  for (const name of STEPS) {
    const setup = await setUpTerminal(agent, name);
    const result = setup.steps[name]!;
    say(`${result.ok ? "done" : "failed"}  ${words[name]}${result.detail ? `: ${result.detail}` : ""}`);
    if (!result.ok) { if (setup.copy) say(`Run this instead: ${setup.copy}`); return false; }
  }
  say(`Ready. Try: ${FIRST_PROMPT[agent]}`);
  return true;
}
