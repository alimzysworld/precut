// One shoot context and id catalog for Ask, the sidekick and legacy reels.
import type { Cut, Shoot, SidekickMessage } from "../shared/schema";
import { effectiveShoot } from "./steps";
import { reelIds, type MusicTrack } from "./reel";

export function buildSidekickContext(template: string, shoot: Shoot, skills: unknown[], music: MusicTrack[],
  current: Cut | null, turns: SidekickMessage[], request: Record<string, unknown>, budget = 60_000): string {
  shoot = effectiveShoot(shoot);
  const { takes, broll } = reelIds(shoot);
  const core = {
    skills, shoot: shoot.name, script: shoot.script,
    // Pick rationale belongs to the line, not repeated on every attempt.
    // Keep every attempt and all editorial metadata while avoiding duplication.
    takes: shoot.takes.map((line) => ({ line: line.lineIndex + 1,
      starred: `L${line.lineIndex + 1}A${line.starred + 1}`, why: line.why,
      attempts: takes.filter((a) => a.lineIndex === line.lineIndex).map(({ lineIndex: _line, starred: _star, why: _why, ...a }) => a),
    })),
    broll: [...broll].map(([id, s]) => ({ id, clipId: s.clip.id, s: s.s, e: s.e, description: s.marker, lengthS: s.e - s.s })),
    clips: shoot.clips.map((c) => ({ id: c.id, lengthS: c.meta?.durationS ?? null,
      kind: c.judgement?.kind ?? "unknown", verdict: c.judgement?.verdict ?? null,
      summary: c.judgement?.summary ?? "Not judged yet", shakeSpans: c.shake?.shakySpans ?? [] })),
    music: music.map((t) => ({ file: t.file, name: t.name, tempo: t.tempo, lengthS: t.durationS, energy: t.energy, moments: t.moments })),
    currentCut: current, request,
  };
  const transcripts = shoot.clips.flatMap((c) => (c.transcript ?? []).map((s) => ({
    clipId: c.id, s: s.s, e: s.e, text: s.text,
    priority: c.judgement?.kind === "setup" ? 0 : c.judgement?.verdict === "unusable" ? 1 : 2,
  })));
  // A turn is one user/reply pair. User's new message is in request, not history.
  const history = turns.slice(-20);
  const encode = () => template + "\n\n--- SHOOT AND CONVERSATION ---\n" +
    JSON.stringify({ ...core, transcripts: transcripts.map(({ priority: _priority, ...s }) => s), history });
  let prompt = encode();
  for (const priority of [0, 1]) {
    for (let i = transcripts.length - 1; i >= 0 && prompt.length > budget; i--) {
      if (transcripts[i].priority === priority) { transcripts.splice(i, 1); prompt = encode(); }
    }
  }
  // Keep the newest turn: references such as "cut the first one" must
  // survive a large transcript. Only older turns go before useful speech.
  while (history.length > 2 && prompt.length > budget) {
    history.splice(0, history[0].role === "user" && history[1]?.role === "sidekick" ? 2 : 1);
    prompt = encode();
  }
  while (transcripts.length && prompt.length > budget) { transcripts.pop(); prompt = encode(); }
  if (prompt.length > budget) throw new Error("This shoot's takes and skills are too large to fit. Use a smaller shoot or shorter skills.");
  return prompt;
}
