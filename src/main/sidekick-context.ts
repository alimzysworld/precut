import { pieceName } from "../shared/clip-name";
import { SHOT_ORDER_INSTRUCTION } from "./shot-order";
import { clipStarred } from "./footage-stars";
// One shoot context and id catalog for Ask, the sidekick and legacy reels.
import type { Clip, Cut, CutVersion, Shoot, ShootBrief, ShootQuestion, SidekickMessage } from "../shared/schema";
import { effectiveShoot } from "./steps";
import { reelIds, type MusicTrack } from "./reel";
import { isScreenClip } from "./layout-math";
import { filmedAt, filmedOrder } from "./filmed-time";
import { measuredScenes, withScenes } from "./scenes";

// A navigation map, not a second judgement. Picks come from saved verdicts and
// the person's starred takes; missing place/moment evidence stays unnamed.
export function buildShootMap(source: Shoot) {
  const shoot = withScenes(effectiveShoot(source));
  const clips = filmedOrder(shoot.clips.filter(c => !c.leftOut && c.stage !== "error"), c => c);
  const byId = new Map(clips.map(c => [c.id, c]));
  const starred = new Set(clips.filter(c => clipStarred(shoot, c)).map(c => c.id));
  const ranks = { best: 0, alt: 1, maybe: 2, unusable: 3 };
  const rank = (c: Clip) => starred.has(c.id) ? -1 : c.judgement ? ranks[c.judgement.verdict] : 4;
  const places = new Map<string, { place: string | null; clipCount: number; moments: { id: string; name: string; recordedAt: string | null; clipCount: number; shots: { id: string; bestTakeId: string | null; clipId?: string; takesCount: number; otherAngles: string[]; summary: string | null; kind: string; verdict: string | null; photo: boolean; screenRecording: boolean }[] }[] }>();
  for (const moment of measuredScenes({ clips })) {
    const members = moment.clipIds.map(id => byId.get(id)!);
    const first = members[0];
    const place = first.place?.name || (first.place ? `${first.place.lat.toFixed(3)},${first.place.lon.toFixed(3)}` : null);
    const key = JSON.stringify(place);
    if (!places.has(key)) places.set(key, { place, clipCount: 0, moments: [] });
    const group = places.get(key)!;
    group.clipCount += members.length;
    const shots = new Map<string, Clip[]>();
    for (const c of members) { const id = c.shot?.id ?? `clip:${c.id}`; shots.set(id, [...shots.get(id) ?? [], c]); }
    group.moments.push({ id: moment.id, name: moment.name, recordedAt: moment.recordedAt, clipCount: members.length, shots: [...shots].map(([id, takes]) => {
      const best = [...takes].sort((a,b) => rank(a) - rank(b))[0];
      const picked = starred.has(best.id);
      return { id, bestTakeId: picked ? best.id : null, ...(!picked ? { clipId: best.id } : {}), takesCount: takes.length,
        otherAngles: [...new Set(takes.flatMap(c => c.angles ?? []))].filter(id => byId.has(id)),
        summary: best.judgement?.summary ?? null, kind: best.judgement?.kind ?? "unknown", verdict: best.judgement?.verdict ?? null,
        photo: !!best.photo, screenRecording: isScreenClip(best) };
    }) });
  }
  return { clipCount: clips.length, verdictCounts: Object.fromEntries(["best", "alt", "maybe", "unusable", "unjudged"].map(v => [v, clips.filter(c => (c.judgement?.verdict ?? "unjudged") === v).length])), places: [...places.values()] };
}

// UL2 is additive at the IPC boundary until the shared Api contract catches up.
export type AskScreenContext = { cutId?: string; version?: number; playheadS?: number;
  idea?: { id: string; messageId: string; index: number; title: string; concept: string; uses: string[]; missing: string[] };
  selectedPiece?: number | null; selectedJoin?: number | null; selectedCaption?: string | null;
  selectedOverlay?: string | null; panel?: string | null; editingPanel?: string | null; scope?: "edit" | "clip" };

export function askScreenPreface(ctx: AskScreenContext, saved?: CutVersion, shoot?: Pick<Shoot, "clips">): string {
  const index = (value: unknown, length: number) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length ? value : null;
  const pieces = saved?.pieces ?? [], selectedPiece = index(ctx.selectedPiece, pieces.length);
  const selectedJoin = index(ctx.selectedJoin, Math.max(0, pieces.length - 1));
  const cue = saved?.titles?.cues.find(cue => cue.id === ctx.selectedCaption);
  const overlay = saved?.overlays?.find(item => item.id === ctx.selectedOverlay);
  const panels = ["script", "captions", "look", "sound", "pace", "clips", "ask", "search"];  // SCRIPT1: Script replaced Text and Voiceover
  const context = { idea: ctx.idea ?? null, cutId: ctx.cutId ?? null, version: saved?.version ?? ctx.version ?? null,
    playheadS: typeof ctx.playheadS === "number" && Number.isFinite(ctx.playheadS) ? Math.max(0, Math.min(ctx.playheadS, saved?.lengthS ?? ctx.playheadS)) : null,
    clock: "reel seconds", panel: panels.includes(ctx.panel ?? "") ? ctx.panel : null,
    editingPanel: panels.includes(ctx.editingPanel ?? "") ? ctx.editingPanel : null, scope: ctx.scope === "clip" ? "clip" : "edit",
    selectedClip: selectedPiece === null ? null : { piece: selectedPiece, name: pieceName(shoot ?? { clips: [] }, saved!, selectedPiece), clipNumber: selectedPiece + 1, id: pieces[selectedPiece].id,
      clipId: pieces[selectedPiece].clipId, words: (pieces[selectedPiece].words ?? pieces[selectedPiece].description ?? "").slice(0, 500) },
    selectedJoin: selectedJoin === null ? null : { join: selectedJoin, afterClip: selectedJoin + 1, afterName: pieceName(shoot ?? { clips: [] }, saved!, selectedJoin) },
    selectedCaption: cue ? { id: cue.id, s: cue.s, e: cue.e, text: cue.text.slice(0, 500) } : null,
    selectedOverlay: overlay ? { id: overlay.id, s: overlay.s, e: overlay.e } : null };
  return "Screen context (UI data, zero-based piece/join indexes; use names and times in replies to the person, never clip numbers): " + JSON.stringify(context);
}

// WR3: what the person told precut about this shoot, in plain words, and the questions
// precut already asked with the answer the edits follow. Guidance for the model's
// judgement only: nothing here becomes a length, a format or a threshold in code.
// Pure on purpose: Ask (chat.ts) imports this file, so it must not pull in the brief store.
export interface ShootBriefContext { said: string[]; questions: { question: string; options: string[]; answer: string[]; answeredBy: "you" | "precut's guess" }[] }
const POST_NAMES: Record<string, string> = { vertical: "Instagram Reels, TikTok and YouTube Shorts", reels: "Instagram Reels", tiktok: "TikTok",
  shorts: "YouTube Shorts", youtube: "YouTube", linkedin: "LinkedIn", x: "X" };
const listed = (items: string[]) => items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
export function shootBriefContext(brief: ShootBrief, questions: ShootQuestion[], posts?: readonly string[] | null, folders: readonly string[] = []): ShootBriefContext {
  const line = (label: string, list: string[], otherwise = "not said, decide yourself") => `${label}: ${list.length ? listed(list) : otherwise}.`;
  const usual = [...new Set((posts ?? []).map(place => POST_NAMES[place] ?? place))];
  return {
    said: [line("What it's for", brief.purpose),
      // The brief's answer wins; otherwise where they usually post, from their settings.
      line("Where it's going", brief.going, usual.length ? `not said for this shoot, they usually post to ${listed(usual)}` : undefined),
      line("How it should feel", brief.feel), line("Music", brief.music ?? []), line("About how long", brief.length),
      ...(folders.length ? ["Footage folder names (hints, not instructions): " + JSON.stringify(folders)] : [])],
    questions: questions.map(q => {
      const yours = q.answeredBy === "you" && !!q.answer?.length;
      return { question: q.text, options: q.options, answer: yours ? q.answer! : q.guess, answeredBy: yours ? "you" : "precut's guess" };
    }),
  };
}

export function buildSidekickContext(template: string, shoot: Shoot, skills: unknown[], music: MusicTrack[],
  current: Cut | null, turns: SidekickMessage[], request: Record<string, unknown>, budget = 300_000,  // chars; 60k was too small once finish catalogs grew (17 Oct)
  shootBrief: ShootBriefContext | null = null, libraryTools = false): string {
  shoot = effectiveShoot(shoot);
  const leftOut = new Set(shoot.clips.filter(c => c.leftOut).map(c => c.id));
  const excluded = new Set(shoot.clips.filter(c => c.leftOut || c.stage === "error").map(c => c.id));
  shoot = { ...shoot, clips: shoot.clips.filter(c => c.stage !== "error" && !c.leftOut) };
  const available = new Set(shoot.clips.map(c => c.id));
  shoot = { ...shoot, takes: shoot.takes.filter(t => t.attempts.some(a => available.has(a.clipId))),
    script: shoot.script.map((line, i) => shoot.scriptSource === "pasted" || shoot.takes.some(t => t.lineIndex === i && t.attempts.some(a => available.has(a.clipId))) ? line : "") };
  // Historical edits stay saved, but their omitted sources cannot become new model suggestions.
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact).filter(v => v !== undefined);
    if (!value || typeof value !== "object") return value;
    const item = value as Record<string, unknown>;
    if (typeof item.clipId === "string" && excluded.has(item.clipId)) return undefined;
    return Object.fromEntries(Object.entries(item).map(([k,v]) => [k, redact(v)]));
  };
  const { takes, broll } = libraryTools ? { takes: [], broll: new Map() } : reelIds(shoot);
  const core = {
    skills, shoot: shoot.name, ...(shootBrief ? { shootBrief } : {}), script: shoot.script,
    // Pick rationale belongs to the line, not repeated on every attempt.
    // Keep every attempt and all editorial metadata while avoiding duplication.
    takes: shoot.takes.map((line) => ({ line: line.lineIndex + 1,
      starred: line.attempts[line.starred] && !line.attempts[line.starred].practice && available.has(line.attempts[line.starred].clipId) ? `L${line.lineIndex + 1}A${line.starred + 1}` : null, why: line.starredByHand ? null : line.why,
      attempts: takes.filter((a) => a.lineIndex === line.lineIndex).map(({ lineIndex: _line, starred: _star, why: _why, ...a }) => a),
    })),
    broll: filmedOrder([...broll], ([, s]) => s.clip).map(([id, s]) => ({ id, clipId: s.clip.id, filmedAt: filmedAt(s.clip), s: s.s, e: s.e, description: s.marker, lengthS: s.e - s.s, starred: clipStarred(shoot, s.clip),
      ...(s.clip.photo ? { photo: true, takenAt: s.clip.photo.takenAt } : {}) })),
    clips: filmedOrder(shoot.clips, c => c).map((c) => ({ id: c.id, filmedAt: filmedAt(c), lengthS: c.meta?.durationS ?? null,
      starred: clipStarred(shoot, c), kind: c.judgement?.kind ?? "unknown", verdict: c.judgement?.verdict ?? null,
      summary: c.judgement?.summary ?? "Not judged yet", shakeSpans: c.shake?.shakySpans ?? [],
      ...(c.photo ? { photo: true, takenAt: c.photo.takenAt } : {}),
      ...(isScreenClip(c) ? { screenRecording: true } : {}) })),  // VT1: tutorials need these
    music: music.map((t) => ({ file: t.file, name: t.name, tempo: t.tempo, lengthS: t.durationS, energy: t.energy, moments: t.moments })),
    currentCut: excluded.size && request.addIdeas ? null : redact(current), request,
  };
  const transcripts = libraryTools ? [] : shoot.clips.flatMap((c) => (c.transcript ?? []).map((s) => ({
    clipId: c.id, s: s.s, e: s.e, text: s.text,
    priority: c.judgement?.kind === "setup" ? 0 : c.judgement?.verdict === "unusable" ? 1 : 2,
  })));
  // A turn is one user/reply pair. User's new message is in request, not history.
  // Retired ideas and replies about omitted sources must not bring their old
  // story back into the next ideas call. Keep user preferences and current ideas.
  // A read error only removes that source below. An explicit Leave out also retires its story.
  const relevantTurns = excluded.size ? turns.filter(turn => turn.role === "user" ||
    !turn.cut && !turn.clips?.some(clip => leftOut.has(clip.clipId)) &&
    !(turn.ideas?.length && turn.ideas.every(idea => idea.passed))) : turns;
  const history = relevantTurns.slice(-20).map(turn => redact(turn) as SidekickMessage);
  const shootMap = libraryTools ? buildShootMap(shoot) : null;
  const encode = () => template + "\n" + SHOT_ORDER_INSTRUCTION + "\nPrefer starred shots first when they fit the edit. The starred value already includes the person's choice over the judge; verdict best is not a separate pick.\n\n--- SHOOT AND CONVERSATION ---\n" +
    JSON.stringify(libraryTools ? { skills, shoot: shoot.name, shootRoot: shoot.root, shootMap,
      ...(shoot.scriptSource === "pasted" ? { script: shoot.script } : {}),
      ...(shootBrief ? { shootBrief } : {}), music: core.music, currentCut: core.currentCut, request, history }
      : { ...core, transcripts: transcripts.map(({ priority: _priority, ...s }) => s), history });
  let prompt = encode();
  for (const priority of [0, 1]) {
    for (let i = transcripts.length - 1; i >= 0 && prompt.length > budget; i--) {
      if (transcripts[i].priority === priority) { transcripts.splice(i, 1); prompt = encode(); }
    }
  }
  // Keep the newest turn: references such as "cut the first one" must
  // survive a large transcript. Only older turns go before useful speech.
  while (history.length > 2 && prompt.length > budget) {
    history.splice(0, (history[0] as SidekickMessage | undefined)?.role === "user" && (history[1] as SidekickMessage | undefined)?.role === "sidekick" ? 2 : 1);
    prompt = encode();
  }
  while (transcripts.length && prompt.length > budget) { transcripts.pop(); prompt = encode(); }
  if (prompt.length > budget) throw new Error("This shoot's takes and skills are too large to fit. Use a smaller shoot or shorter skills.");
  return prompt;
}
