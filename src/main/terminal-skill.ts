// ONB2: the precut skill, installed for Claude Code (~/.claude/skills/precut/SKILL.md) and Codex
// (~/.codex/skills/precut/SKILL.md) by the first run's "Use precut from your terminal" step and `precut setup`.
// It teaches the agent how to drive precut through its MCP server (or the `precut` command), with safe defaults.
// The marker line lets precut update its own skill and never overwrite someone else's skill of the same name.
export const SKILL_MARKER = "<!-- installed by precut; precut updates this file -->";

const body = (agent: "Claude Code" | "Codex") => `${SKILL_MARKER}

# precut

precut is a pre-editor on this Mac. It reads a folder of raw footage (clips, transcripts, best takes), suggests ideas, cuts first edits and exports them, as an MP4 or a timeline for DaVinci Resolve, Premiere Pro, Final Cut Pro or CapCut. You drive it through the \`precut\` MCP server ${agent} has connected, or the \`precut\` command in the terminal. Both do the same things.

## When to use it
The person mentions footage, a shoot, clips, a reel, a short, a video edit, captions, a look or an export of their own video.

## How to work
1. Find the shoot. \`list_shoots\` (or \`precut shoots\`) lists the shoots precut knows. A new folder of footage is added with \`add_shoot\` (\`precut add <folder>\`); reading it takes a while, so check \`shoot_progress\` and tell the person what is happening instead of waiting silently.
2. Understand it before cutting. \`list_clips\`, \`read_transcript\`, \`list_takes\` and \`search_footage\` show what was filmed and said. Use the person's words when you choose moments.
3. Make the edit. \`list_ideas\` / \`add_ideas\` for ideas, \`make_cut\` with an idea id or a plain concept and a length, then \`read_edit\` to check it. Change it with the edit tools (\`set_format\`, \`set_look\`, \`swap_take\`, \`remove_piece\`, captions, music).
4. Export. \`export_cut\` makes an MP4 by default; pass an editor to get a timeline. Give the person the file path it returns.

\`precut tools\` lists every tool with its description, and \`precut tool <name> '<json>'\` runs one from the terminal with the same arguments.

## Taste
- Do what the person asks, fully. When you add anything they didn't ask for, use precut's tools with intent: each one should do a job you can name (stop the scroll, land the point, carry a cut, lift the energy), and the amount should match the video (a calm vlog wants few, a fast tip or a launch can carry more). Don't add something just because precut can.

## Safe defaults
- precut never deletes or moves footage and never touches originals. Every change to an edit saves a new version, so it can always be undone. Say which version you made.
- One writer at a time: while the precut app has a shoot open, changes to it from here are refused. Reads still work. If a change is refused, ask the person to close that shoot in the app.
- Ideas, first edits and some edit tools call the AI the person chose in precut, on their own plan. Reading, format, look and export do not. If precut says no AI is chosen, tell them they can add one in precut's Settings; everything else still works.
- Don't invent facts about the footage. Read the transcript or the clip first.
- Export only when asked, or when the person asked for a finished video.

## Example
"make a 40 second short from my newest shoot": \`list_shoots\`, pick the newest, \`list_ideas\`, \`make_cut\` with the best idea and length 40, \`read_edit\` to check the opening, then \`export_cut\` and share the path.
`;

export function skillFile(agent: "claude" | "codex"): string {
  const description = agent === "claude"
    ? "Use precut, the person's video pre-editor, to read their footage and make, change and export short video edits (reels, shorts, TikToks) through the precut MCP server or the precut command."
    : "Use precut, the person's video pre-editor, to read their footage and make, change and export short video edits through the precut MCP server or the precut command.";
  return `---\nname: precut\ndescription: ${description}\n---\n\n${body(agent === "claude" ? "Claude Code" : "Codex")}`;
}
