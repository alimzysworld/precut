import { clipName } from "../../shared/clip-name";
import { applyFootageStar } from "../../main/footage-stars";
import { mixerTransform, normalizeMixer } from "../../main/mixer";
import { normalizeBasic, basicBefore, basicAfter } from "../../main/basics";
import type { Api, Preferences, Shoot, Stage, Template, Skill, Cut, CutVersion, ReelIdea, SidekickMessage, Autopilot, ShootSteps, Activity, DraftTimeline, ShootSummary, ShootProgress, ProcessingStage, ProcessingStageId, ProcessingFinding, ShootBrief, ShootQuestion } from "../../shared/schema";
import { mediaUrl } from "../../shared/media";

export const FIXTURE_ROOT = "sample-shoot";
export const GROWTH_ROOT = "growth-night-b-roll";

type ProgressEvent = { root: string; clipId: string; stage: Stage; pct: number };
type ProgressCb = (e: ProgressEvent) => void;

const listeners = new Set<ProgressCb>();
let cachedShoot: Shoot | null = null;
let cachedPromise: Promise<Shoot> | null = null;
let extraShoots: { root: string; name: string; online: boolean }[] = [];
let fakeCounter = 0;
let growthTimer: ReturnType<typeof setInterval> | null = null;
let growthStep = 6;
const timers = new Map<string, ReturnType<typeof setInterval>>();

function emit(e: ProgressEvent) {
  listeners.forEach((cb) => {
    try {
      cb(e);
    } catch {
      /* listener error does not stop others */
    }
  });
}

function startGrowthTimer() {
  if (growthTimer) return;
  const stages: Stage[] = ["transcript", "shake", "frames", "judge"];
  growthTimer = setInterval(() => {
    growthStep = growthStep >= 16 ? 1 : growthStep + 1;
    const stage = stages[growthStep % stages.length];
    emit({ root: GROWTH_ROOT, clipId: `growth-clip-${growthStep}`, stage, pct: Math.round((growthStep / 16) * 100) });
  }, 1400);
}

function startFakeTimer(root: string, total: number) {
  if (timers.has(root)) return;
  let step = 0;
  const stages: Stage[] = ["probe", "transcript", "shake", "frames", "judge"];
  const id = setInterval(() => {
    step = step >= total ? 1 : step + 1;
    emit({ root, clipId: `clip-${step}`, stage: stages[step % stages.length], pct: Math.round((step / total) * 100) });
  }, 1200);
  timers.set(root, id);
}

async function fetchFixtureShoot(): Promise<Shoot> {
  if (cachedShoot) return cachedShoot;
  if (cachedPromise) return cachedPromise;
  cachedPromise = (async () => {
    const res = await fetch("fixtures/sample-shoot/index.json");
    if (!res.ok) throw new Error(`fixture load failed: ${res.status}`);
    const raw = (await res.json()) as Shoot;
    const micOffsets: Record<string, number> = { "0993": 307.121875, "0997": 508.59625, "0999": 760.077875, "1000": 953.35825 };
    const shoot: Shoot = { ...raw, root: FIXTURE_ROOT, clips: raw.clips.map((clip, i) => {
      const offsetS = micOffsets[clip.id.slice(-4)];
      return { ...clip, sound: offsetS !== undefined
        ? { file: "TX02_MIC037_20251224_214000_orig.wav", offsetS, confidence: 0.79 }
        : i % 2 === 0 ? null : undefined };
    }) };
    // PH2: two stills alongside the unchanged video fixture.
    if (!shoot.clips.some(clip => clip.photo)) {
      const sources = shoot.clips.filter(clip => clip.frames.length > 0).slice(0, 2);
      shoot.clips.push(...sources.map((clip, i): Clip => ({ ...clip,
        id: `fixture-photo-${i + 1}`, file: `.sidething/stills/fixture-photo-${i + 1}.mov`,
        photo: { file: `photos/photo-${i + 1}.jpg`, takenAt: `2025-12-24T21:${i ? "43" : "41"}:00Z` },
        // These fixture photos have no recorded camera or sound metadata.
        meta: clip.meta ? { ...clip.meta, width: i ? 960 : 1280, height: i ? 638 : 854, codedWidth: i ? 960 : 1280, codedHeight: i ? 638 : 854,
          fps: 30, codec: "h264", camera: null, pictureProfile: "Rec.709", iso: null, shutter: null, aperture: null, focalLength: null, startTimecode: null,
          rotation: 0, containerRotation: 0, durationS: 6, sizeBytes: i ? 144717 : 113673, audioChannels: 2, sampleRate: 48000,
          createdAt: `2025-12-24T21:${i ? "43" : "41"}:00Z` } : null,
        proxy: `photos/photo-${i + 1}.mp4`, frames: [`photos/photo-${i + 1}.jpg`], transcript: [], sound: null, byHand: undefined, subject: undefined, quality: undefined, fillers: [],
        shake: { measured: true, meanPx: 0, p95Px: 0, shakySpans: [], perSecond: [] },
        judgement: { kind: "broll", verdict: "alt", shot: "medium", summary: "A still from the shoot.", usableSpans: [[0, 6]], model: "fixture" },
      })));
    }
    cachedShoot = shoot;
    return shoot;
  })();
  return cachedPromise;
}

function makeProcessingShoot(root: string, name: string, clipCount: number): Shoot {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    name,
    root,
    createdAt: now,
    updatedAt: now,
    script: [],
    scriptSource: "none",
    clips: Array.from({ length: clipCount }, (_, i) => ({
      id: `${root}-clip-${i + 1}`,
      file: `clip-${i + 1}.mp4`,
      stage: i < 6 ? "done" : "transcript",
      meta: null,
      transcript: null,
      shake: null,
      frames: [],
      proxy: null,
      judgement: null,
    })),
    audio: [],
    takes: [],
  };
}

const fakeShoots = new Map<string, Shoot>();

const fixtureBriefs = new Map<string, ShootBrief>();
const fixtureQuestions = new Map<string, ShootQuestion[]>();
const questionListeners = new Set<(root: string) => void>();

// WR2: a waiting-room fixture shoot, so every screen can be seen without a Mac.
// Step through them with a query param before the hash, for example
//   http://127.0.0.1:5173/?wr=finding#/wait?shoot=waiting-room-demo
// wr = questions | reading | finding | followup | ideas | ready, or auto (moves on every 8 seconds).
export const WAIT_ROOT = "waiting-room-demo";
export const WAIT_STAGES = ["questions", "reading", "finding", "followup", "ideas", "ready"] as const;
export type WaitStage = typeof WAIT_STAGES[number];
const waitStarted = Date.now();
export function waitStage(): WaitStage | null {
  let value: string | null = null;
  try { value = new URLSearchParams(window.location.search).get("wr"); } catch { return null; }
  if (value === "auto") return WAIT_STAGES[Math.floor((Date.now() - waitStarted) / 8000) % WAIT_STAGES.length];
  return (WAIT_STAGES as readonly string[]).includes(value ?? "") ? value as WaitStage : null;
}
const waitClip = (n: number) => `clip20260831_${String(n).padStart(4, "0")}`;
const WAIT_FINDINGS: ProcessingFinding[] = [
  { id: "wr-f1", text: "Found 6 takes of your opening line", clipId: waitClip(991), t: 2, clipIds: [waitClip(991), waitClip(994), waitClip(995)] },
  { id: "wr-f2", text: "Found 4 steady b-roll shots", clipId: waitClip(989), t: 1, clipIds: [waitClip(989), waitClip(990), waitClip(993), waitClip(992)] },
  { id: "wr-f3", text: "Detected a stumble at 02:14", clipId: waitClip(998), t: 134, clipIds: [waitClip(998)] },
  { id: "wr-f4", text: "Found a strong opening.", clipId: waitClip(993), t: 4, clipIds: [waitClip(993), waitClip(989), waitClip(990), waitClip(994), waitClip(996)] },
  { id: "wr-f5", text: "Your voice is clear in 14 of 16 clips", clipIds: [waitClip(996), waitClip(997), waitClip(999)] },
  { id: "wr-f6", text: "Found 3 takes of the same walk", clipId: waitClip(986), t: 1, clipIds: [waitClip(986), waitClip(988), waitClip(990)] },
];
const WAIT_PLAN: Record<WaitStage, { read: number; etaS: number; findings: number; questions: number; ideas: number; ideasDone: boolean; editsMaking: number }> = {
  questions: { read: 2, etaS: 260, findings: 0, questions: 0, ideas: 0, ideasDone: false, editsMaking: 0 },
  reading: { read: 4, etaS: 190, findings: 0, questions: 0, ideas: 0, ideasDone: false, editsMaking: 0 },
  finding: { read: 9, etaS: 130, findings: 4, questions: 1, ideas: 0, ideasDone: false, editsMaking: 0 },
  followup: { read: 9, etaS: 125, findings: 4, questions: 2, ideas: 0, ideasDone: false, editsMaking: 0 },
  ideas: { read: 14, etaS: 70, findings: 5, questions: 1, ideas: 2, ideasDone: false, editsMaking: 0 },
  ready: { read: 16, etaS: 40, findings: 6, questions: 0, ideas: 3, ideasDone: true, editsMaking: 2 },
};
const waitPlan = () => WAIT_PLAN[waitStage() ?? "questions"];
function waitProgress(root: string): ShootProgress {
  const plan = waitPlan(), total = 16;
  const labels: [ProcessingStageId, string][] = [["index", "Reading footage and metadata"], ["transcribe", "Transcribing dialogue"], ["group", "Grouping takes"], ["judge", "Checking performances"], ["ideas", "Generating video ideas"], ["drafts", "Assembling draft edits"]];
  const at = plan.read < total ? 1 : plan.ideasDone ? 5 : 4;
  const stages: ProcessingStage[] = labels.map(([id, label], index) => ({ id, label, state: index < at ? "done" : index === at ? "running" : "queued",
    detail: index === 1 && plan.read < total ? `clip ${plan.read} of ${total}` : null, pct: index === at ? Math.round(plan.read / total * 100) : null }));
  // V49: progress counts describe completed work, never identify a numbered clip.
  stages.forEach(stage => { if (stage.detail) stage.detail = stage.detail.replace(/^clip (\d+) of (\d+)$/, "$1 of $2 read"); });
  const overall = { pct: Math.round((plan.read / total) * 80 + (plan.ideasDone ? 15 : 0)), etaS: plan.etaS, running: true, complete: false, ideaCount: plan.ideas, editCount: 0, stages: [] };
  return { root, running: true, stages, findings: WAIT_FINDINGS.slice(0, plan.findings),
    waiting: { clips: { read: plan.read, total }, etaS: plan.etaS, ideasReady: plan.ideas, ideasDone: plan.ideasDone, editsMaking: plan.editsMaking, complete: false },
    ...{ overall } } as ShootProgress;
}
const WAIT_QUESTIONS: ShootQuestion[] = [
  { id: "wr-q1", text: "Is it the point of the day?", why: "The croissant is in three clips, and it's the best shot so far.", options: ["Yes, it's the story", "Just part of the day"], multi: false,
    guess: ["Yes, it's the story"], answer: null, answeredBy: null, clipIds: [waitClip(993)], at: "2026-10-18T09:00:00.000Z" },
  { id: "wr-q2", text: "Should the music lift when you get outside?", why: "The pace changes once you leave the shop.", options: ["Yes, lift it", "Keep it calm"], multi: false,
    guess: ["Keep it calm"], answer: null, answeredBy: null, at: "2026-10-18T09:01:00.000Z" },
];
function waitQuestions(): ShootQuestion[] {
  const stage = waitStage() ?? "questions", key = `${WAIT_ROOT}:${stage}`;
  if (!fixtureQuestions.has(key)) fixtureQuestions.set(key, structuredClone(WAIT_QUESTIONS.slice(0, WAIT_PLAN[stage].questions)));
  return fixtureQuestions.get(key)!;
}
const WAIT_IDEAS: ReelIdea[] = [
  { id: "wr-i1", title: "The croissant run", concept: "Open on the shelf, follow the walk home.", hook: "", lengthS: 30, uses: ["L1A1", "L2A1"], missing: [], pick: true },
  { id: "wr-i2", title: "Slow morning", concept: "Kettle, light, a quiet start.", hook: "", lengthS: 20, uses: ["L5A1"], missing: [], pick: true },
  { id: "wr-i3", title: "Unexpected item in the bagging area", concept: "The checkout goes wrong, then right.", hook: "", lengthS: 15, uses: ["L6A1"], missing: [] },
];
const waitThread = (): SidekickMessage[] => waitPlan().ideas ? [{ id: "wr-ideas", role: "sidekick", text: "", at: "2026-10-18T09:02:00.000Z", ideas: structuredClone(WAIT_IDEAS.slice(0, waitPlan().ideas)) }] : [];
function createFixtureApi(): Api {
  let preferences: Preferences = { vocabulary: [], output: { shapes: ["9:16", "16:9"], height: 1080, fps: null, exportFolder: null },
    captions: { onByDefault: true, safeArea: "reels" }, voice: { clean: true, denoise: .6, loudnessLUFS: -16 },
    aiSeesFrames: true, look: { preset: "clean", words: null }, playback: { applePlayer: false } };
  const fixtureLut = (preset: string, intensity: number, basic?: import("../../shared/schema").BasicAdjust, mixer?: import("../../shared/schema").Grade["mixer"]) =>
    `fixture:${preset}:${intensity}:${basic ? encodeURIComponent(JSON.stringify(normalizeBasic(basic))) : ""}:${mixer ? encodeURIComponent(JSON.stringify(normalizeMixer(mixer))) : ""}`;
  startGrowthTimer();
  // In-memory skills mirror the files used by the desktop app.
  let skills: Skill[] = ([
  {
    id: "my-taste", name: "My taste", description: "My defaults for every reel.", global: true,
    format: { aspect: "9:16" as const, width: 1080, height: 1920, fps: null },
    body: `sidething wrote this as a starting point. Make it yours.

# My taste

Get to the hook in the first second. No intro before the point.

Cut breaths, false starts and the pause before a line. Keep enough space that I still sound like me.

Clean cuts between my talking lines. A transition, zoom or sound only where it adds energy, like going into b-roll or a screenshot, never just to look busy.

Keep my face steady in the frame.

When captions arrive, make them large and centred. Keep them easy to read.

Music sits under the voice, never over it. If it fights the words, turn it down or leave it out.
`,
  },
  {
    id: "talking-head-reel", name: "Talking head reel", description: "Use when I am talking straight to camera.", global: false,
    format: { aspect: "9:16" as const, width: 1080, height: 1920, fps: null },
    body: `sidething wrote this as a starting point. Make it yours.

# Talking head reel

Pick one idea I can say cleanly. Start with its strongest hook in the first second.

Use the take where I sound sure of the line, not just the take with no mistakes.

Cut breaths and false starts. Cut the waiting between lines. Keep the words in their natural order.

Stay on me while the point lands. A punch in on the line that matters is fine; nothing just to make it feel busy.

When captions arrive, keep them large and centred. Show a short phrase at a time.

If there is music, keep it under my voice and never over it. The words do the work.
`,
  },
]).map((skill) => ({ ...skill, path: `skills/${skill.id}.md` }));
  const skillListeners = new Set<() => void>();
  const skillsChanged = () => skillListeners.forEach((cb) => { try { cb(); } catch { /* keep notifying */ } });
  // Scripted sidekick data is per shoot and shared by both chat surfaces.
  const threads = new Map<string, SidekickMessage[]>();
  const cuts = new Map<string, Cut[]>();
  const sidekickListeners = new Set<(root: string) => void>();
  const sidekickChanged = (root: string) => sidekickListeners.forEach((cb) => { try { cb(root); } catch { /* keep notifying */ } });
  let sidekickId = 0;
  const fixtureActivities = new Map<string, Activity>();
  const activityListeners = new Set<(activity: Activity) => void>();
  const cancelFinish = new Map<string, () => void>();
  const publishActivity = (activity: Activity) => {
    fixtureActivities.set(activity.id, activity);
    activityListeners.forEach(listener => listener(structuredClone(activity)));
  };
  // V62 fixture: the same two plain improvements every time, so the list can be checked without a model.
  const FIXTURE_BETTER_ISSUES = [
    { id: "1-0", what: "The first 3 s are silence before the point.", change: "Start on the strongest line", severity: "high" as const },
    { id: "1-1", what: "The music drowns your voice at 0:41.", change: "Lower it 4 dB", severity: "medium" as const },
  ];
  const api: Api = {
    async pickFolder() {
      fakeCounter += 1;
      return `browser-shoot-${fakeCounter}`;
    },
    async addShoot(root: string) {
      const isToken = root.startsWith("browser-shoot-") || root.startsWith("dropped-");
      const name = isToken ? `new shoot ${fakeCounter || extraShoots.length + 1}` : root.split("/").filter(Boolean).pop() || root;
      const finalRoot = isToken ? `${root}-${Date.now()}` : root;
      const shoot = makeProcessingShoot(finalRoot, name, 12);
      fakeShoots.set(finalRoot, shoot);
      extraShoots = [...extraShoots, { root: finalRoot, name, online: true }];
      startFakeTimer(finalRoot, 12);
      setTimeout(() => emit({ root: finalRoot, clipId: "clip-1", stage: "transcript", pct: 8 }), 300);
      return shoot;
    },
    async listShoots() {
      // V4 fixture: one of each useful status, so the library can be built without a Mac.
      const now = Date.now(), ago = (min: number) => new Date(now - min * 60_000).toISOString();
      const base: ShootSummary[] = [
        { root: FIXTURE_ROOT, name: "sample shoot", online: true, status: "edits", thumb: frameSrc(FIXTURE_ROOT, "frames/clip-1/0.jpg"), clipCount: 113, ideaCount: 5, cutCount: 5, lastActivityAt: ago(2), progressPct: null },
        { root: GROWTH_ROOT, name: "growth night b-roll", online: true, status: "processing", thumb: null, clipCount: 16, ideaCount: 0, cutCount: 0, lastActivityAt: ago(1), progressPct: 42 },
        { root: "/Volumes/T7/product demo", name: "product demo", online: false, status: "offline", thumb: null, clipCount: 72, ideaCount: 3, cutCount: 0, lastActivityAt: ago(60 * 26), progressPct: null },
      ];
      const wait: ShootSummary[] = waitStage() ? [{ root: WAIT_ROOT, name: "b-roll test", online: true, status: "processing", thumb: frameSrc(WAIT_ROOT, "frames/clip20260831_0993_3.jpg"), clipCount: 16, ideaCount: waitPlan().ideas, cutCount: 0, lastActivityAt: ago(0), progressPct: null }] : [];
      return [...base, ...wait, ...extraShoots.map((entry): ShootSummary => ({ ...entry, status: "processing", thumb: null, clipCount: 12, ideaCount: 0, cutCount: 0, lastActivityAt: ago(0), progressPct: 8 }))];
    },
    async relinkShoot(oldRoot: string, newRoot: string) {
      const name = newRoot.split("/").filter(Boolean).pop() || newRoot;
      return { root: newRoot, name, online: true, status: "ideas", thumb: null, clipCount: 72, ideaCount: 3, cutCount: 0, lastActivityAt: new Date().toISOString(), progressPct: null } satisfies ShootSummary;
    },
    async shootProgress(root: string) {
      if (root === WAIT_ROOT) return waitProgress(root);
      // Fixture: GROWTH_ROOT and new shoots are mid-run; everything else is done.
      const running = root === GROWTH_ROOT || extraShoots.some(entry => entry.root === root);
      const labels: [ProcessingStageId, string][] = [["index", "Reading footage and metadata"], ["transcribe", "Transcribing dialogue"], ["group", "Grouping takes"], ["judge", "Checking performances"], ["ideas", "Generating video ideas"], ["drafts", "Assembling draft edits"]];
      const stages: ProcessingStage[] = labels.map(([id, label], index) => running
        ? { id, label, state: index === 0 ? "done" : index === 1 ? "running" : "queued", detail: index === 0 ? "16 files found" : index === 1 ? "clip 7 of 16" : null, pct: index === 1 ? 42 : null }
        : { id, label, state: "done", detail: null, pct: null });
      stages.forEach(stage => { if (stage.detail) stage.detail = stage.detail.replace(/^clip (\d+) of (\d+)$/, "$1 of $2 read"); });
      const findings: ProcessingFinding[] = running ? [{ id: "f1", text: "Found 6 takes of your opening line", clipId: "clip-1", t: 2 }, { id: "f2", text: "Detected a stumble at 02:14", clipId: "clip-2", t: 134 }] : [];
      return { root, running, stages, findings } satisfies ShootProgress;
    },
    async retryStage() {},
    async loadShoot(root: string) {
      if (root === FIXTURE_ROOT) return fetchFixtureShoot();
      if (root === WAIT_ROOT) return { ...(await fetchFixtureShoot()), root: WAIT_ROOT, name: "b-roll test" };
      if (root === GROWTH_ROOT) {
        if (!fakeShoots.has(GROWTH_ROOT)) {
          fakeShoots.set(GROWTH_ROOT, makeProcessingShoot(GROWTH_ROOT, "growth night b-roll", 16));
        }
        return fakeShoots.get(GROWTH_ROOT) ?? null;
      }
      if (fakeShoots.has(root)) return fakeShoots.get(root) ?? null;
      return fetchFixtureShoot();
    },
    async setScript(root: string, lines: string[]) {
      if (root === FIXTURE_ROOT) {
        const s = await fetchFixtureShoot();
        const next: Shoot = { ...s, script: lines, scriptSource: "pasted", updatedAt: new Date().toISOString() };
        cachedShoot = next;
        return next;
      }
      const existing = fakeShoots.get(root);
      if (existing) {
        const next = { ...existing, script: lines, scriptSource: "pasted" as const };
        fakeShoots.set(root, next);
        return next;
      }
      const s = await fetchFixtureShoot();
      return { ...s, script: lines, scriptSource: "pasted" };
    },
    async setFootageStar(root, key, starred) {
      const source = root === FIXTURE_ROOT ? await fetchFixtureShoot() : fakeShoots.get(root);
      if (!source) throw new Error("Shoot not found.");
      const next = applyFootageStar(source, key, starred);
      if (root === FIXTURE_ROOT) cachedShoot = next; else fakeShoots.set(root, next);
      return next;
    },
    async starTake(root: string, lineIndex: number, attempt: number) {
      const apply = (s: Shoot): Shoot => ({
        ...s,
        takes: s.takes.map((t) => (t.lineIndex === lineIndex ? { ...t, starred: attempt } : t)),
      });
      if (root === FIXTURE_ROOT) {
        const s = await fetchFixtureShoot();
        const next = apply(s);
        cachedShoot = next;
        return next;
      }
      const existing = fakeShoots.get(root);
      if (existing) {
        const next = apply(existing);
        fakeShoots.set(root, next);
        return next;
      }
      const s = await fetchFixtureShoot();
      return apply(s);
    },
    async sidekickThread(root) { return root === WAIT_ROOT ? waitThread() : structuredClone(threads.get(root) ?? []); },
    async sidekickSend(root, text, ctx = {}) {
      const thread = threads.get(root) ?? [];
      threads.set(root, thread);
      const message = (role: SidekickMessage["role"], words: string): SidekickMessage => ({ id: `fixture-message-${++sidekickId}`, role, text: words, at: new Date().toISOString() });
      thread.push(message("user", text)); sidekickChanged(root);
      // Long enough to see the working state, without waiting for AI in QA.
      await new Promise((resolve) => setTimeout(resolve, 650));
      const shoot = root === FIXTURE_ROOT ? await fetchFixtureShoot() : fakeShoots.get(root);
      const reply = message("sidekick", "");
      const starred = [...(shoot?.takes ?? [])].sort((a, b) => a.lineIndex - b.lineIndex).filter((take) => take.attempts[take.starred]);
      const ids = starred.map((take) => `L${take.lineIndex + 1}A${take.starred + 1}`);
      const q = text.toLowerCase();
      const firstWords = starred[0]?.attempts[starred[0].starred].text ?? "";
      if (/^\s*(please\s+)?(make it better|make this better|check my edit|check this edit|what would you change)\s*\??\s*$/i.test(text)) {
        const open = ctx.cutId ? (cuts.get(root) ?? []).find((cut) => cut.cutId === ctx.cutId) : undefined;
        const latest = open?.versions.at(-1);
        if (!open || !latest) reply.text = "Open an edit, then ask me to make it better.";
        else {
          reply.better = { cutId: open.cutId, version: latest.version, issues: structuredClone(FIXTURE_BETTER_ISSUES) };
          reply.text = FIXTURE_BETTER_ISSUES.map((issue, index) => `${index + 1}. ${issue.what} ${issue.change}.`).join("\n");
        }
      } else if (!starred.length) {
        reply.text = "This shoot is still processing. I need its words and usable moments before I can suggest an honest cut.";
      } else if (/what reels|suggest.*reels|reel ideas/.test(q)) {
        const ideas: ReelIdea[] = [
          { title: "Build it on the side", concept: "Cut a 30 s reel for founders with day jobs. Open on the strongest hook and end on momentum towards revenue.", hook: firstWords, lengthS: 30, uses: ids, missing: [] },
          { title: "An hour every evening", concept: "Cut a 15 s reel about making progress in an hour every evening. Use the starred takes and end on do it, ship it, come back tomorrow.", hook: starred[1]?.attempts[starred[1].starred].text ?? firstWords, lengthS: 15, uses: ids.filter((_, index) => [1, 6, 7].includes(index)), missing: [] },
          { title: "You need momentum", concept: "Cut a 30 s reel about momentum towards revenue, opening on the empty bridge and using the starred talking-head takes.", hook: "An empty bridge at night. Then: keep going.", lengthS: 30, uses: ["B2", ...ids.filter((_, index) => [0, 4, 5, 8].includes(index))], missing: ["a close-up of your hands working on a laptop at night"] },
        ];
        reply.text = "Three directions from this shoot. Each starts with a different reason to keep watching.";
        reply.ideas = ideas.map((idea, index) => ({ ...idea, pick: index < 3 }));
      } else if (/me working|lots of b.?roll/.test(q)) {
        reply.text = "You've only got 2 b-roll moments: a stand-in on a phone and the empty bridge. Neither is you working. The starred spoken lines add up to about 29 s, so I can't honestly make 60 s of that idea. I've kept your cut as it is. To make this, shoot:";
        reply.missing = ["You working at a laptop in the evening", "A close-up of your hands typing or sketching the idea", "A wider shot of your workspace with you in it"];
      } else if (/best take/.test(q)) {
        const match = q.match(/line\s*(\d+)/);
        const takes = match ? starred.filter((take) => take.lineIndex === Number(match[1]) - 1) : starred;
        const first = takes[0]?.attempts[takes[0].starred];
        reply.text = first ? `The strongest take starts in clip ${shortClipId(first.clipId)} at ${formatTimecode(first.s)}. These are your starred takes.` : "There isn't a take for that line in this shoot yet.";
        if (first) reply.text = `The strongest take is ${clipName(shoot?.clips.find(c => c.id === first.clipId), first)}. These are your starred takes.`;
        reply.clips = takes.map((take) => { const attempt = take.attempts[take.starred]; return { clipId: attempt.clipId, s: attempt.s, e: attempt.e }; });
      } else {
        const shootCuts = cuts.get(root) ?? [];
        const existing = ctx.cutId ? shootCuts.find((cut) => cut.cutId === ctx.cutId) : undefined;
        const previous = existing?.versions.at(-1);
        const versionNumber = (previous?.version ?? 0) + 1;
        // Notes drop the playbook line when present; otherwise drop a middle
        // line. The old version remains intact, and the hook/end are kept.
        let voice = previous ? [...previous.voice] : [...ids];
        if (previous && voice.length > 2) {
          const playbook = voice.findIndex((id) => /^L6A/.test(id));
          voice.splice(playbook >= 0 ? playbook : Math.floor(voice.length / 2), 1);
        }
        let lengthS = 0;
        const pieces: NonNullable<CutVersion["pieces"]> = voice.flatMap((id) => {
          const match = /^L(\d+)A(\d+)$/.exec(id)!;
          const take = starred.find((take) => take.lineIndex === Number(match[1]) - 1);
          const attempt = take?.attempts[Number(match[2]) - 1];
          if (!attempt) return [];
          const timelineS = lengthS;
          const duration = attempt.e - attempt.s;
          lengthS += duration;
          return [{ id, kind: "voice" as const, clipId: attempt.clipId, s: attempt.s, e: attempt.e,
            timelineS, lengthS: duration, words: attempt.text, overlay: null, beatSnapS: 0 }];
        });
        const title = existing?.versions[0]?.title ?? (/momentum/.test(q) && !/founders/.test(q) ? "You need momentum" : /hour every evening/.test(q) ? "An hour every evening" : "Build it on the side");
        const version: CutVersion = {
          grade: previous?.grade ?? { matchClips: true, input: "rec709", exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, look: preferences.look.words, ...preferences.look },
          version: versionNumber, createdAt: new Date().toISOString(), title, voice, broll: previous?.broll ?? [],
          pieces,
          music: ctx.musicFile !== undefined ? { file: ctx.musicFile ?? "fixture-music.mp3", startS: 0, gainDb: -12 } : previous?.music ?? null,
          templateId: ctx.templateId ?? previous?.templateId ?? "9x16", lengthS: Math.round(lengthS * 100) / 100,
          preview: "precut-talking.mp4",
          titles: previous ? previous.titles : { font: "Outfit", prompt: null, skillIds: [], cues: [{ id: "fixture-live-title", s: .2, e: Math.min(3, lengthS), role: "title", text: title, layer: "front", x: .5, y: .22, align: "center", size: .028, weight: 700, italic: false, color: "#ffffff", enter: "pop", exit: "fade" }] },
          why: previous ? "Dropped one line to keep the pace up. The hook stays first; momentum still closes it." : "Your starred takes, a direct opening, and momentum as the last word.",
          warnings: ["Fixture preview is the existing talking-head precut. It is not re-rendered for these storyboard versions. Music gain, when present, is a fixture value."], missing: [], feedback: previous ? text : null,
        };
        const seconds = q.match(/\b(\d+(?:\.\d+)?)\s*(?:s\b|sec(?:ond)?s?\b)/);
        const minutes = q.match(/\b(\d+(?:\.\d+)?)\s*(?:m\b|min(?:ute)?s?\b)/);
        const ideaLength = thread.find((message) => message.id === ctx.fromIdea?.messageId)?.ideas?.[ctx.fromIdea?.index ?? -1]?.lengthS;
        const targetLengthS = ctx.lengthS ?? ideaLength ?? (seconds ? Number(seconds[1]) : minutes ? Number(minutes[1]) * 60 : 30);
        const cut: Cut = existing ?? { cutId: `fixture-cut-${++sidekickId}`, concept: text, skillIds: ctx.skillIds ?? [], targetLengthS, versions: [], exported: [] };
        cut.versions.push(version);
        if (!existing) shootCuts.unshift(cut);
        cuts.set(root, shootCuts);
        reply.text = previous ? `Dropped ${previous.voice.length - voice.length} line and kept the ending on momentum.` : "Made the first cut from your starred takes, opening on the hook and ending on momentum.";
        reply.cut = { cutId: cut.cutId, version: versionNumber };
        if (ctx.fromIdea) {
          const idea = thread.find((message) => message.id === ctx.fromIdea!.messageId)?.ideas?.[ctx.fromIdea.index];
          if (idea) idea.cutId = cut.cutId;
        }
      }
      thread.push(reply); sidekickChanged(root);
      return structuredClone(reply);
    },
    onSidekickChanged(cb) { sidekickListeners.add(cb); return () => { sidekickListeners.delete(cb); }; },
    async listCuts(root) { return structuredClone(cuts.get(root) ?? []); },
    async listEngines() {
      return [
        { id: "claude" as const, installed: true, signedIn: true, version: "Fixture" },
        { id: "codex" as const, installed: true, signedIn: true, version: "Fixture" },
        { id: "muse" as const, installed: false, signedIn: null, version: null },
      ];
    },
    async installCommandLine() { throw new Error("The command line tool needs the desktop app."); },
    async checkSetup() { return []; },
    async testEngine(engine) { return { ok: engine !== "muse", text: engine === "muse" ? "Muse isn't installed" : "Ready. The engine answered." }; },
    async openEngineHelp() {},
    async startFirstRunDownloads() {},
    async firstRunDownloads() { return { state: "ready" as const, what: null, pct: 100, etaS: null, message: "" }; },
    async listActivity() { return structuredClone([...fixtureActivities.values()]); },
    onActivity(cb) { activityListeners.add(cb); return () => { activityListeners.delete(cb); }; },
    async reportBusy() {},
    async getResourceState() { return { mode: "full" as const, reason: null }; },
    async fullSpeedForTask() { return false; },
    onResourceState() { return () => {}; },
    async cancelActivity(id) {
      const activity = fixtureActivities.get(id);
      if (activity?.state !== "running" || !activity.cancelable) return;
      if (cancelFinish.has(id)) cancelFinish.get(id)!();
      else publishActivity({ ...activity, state: "failed", note: "Canceled", endedAt: new Date().toISOString(), cancelable: false });
    },
    async draftTimeline(root, cutId, version) {
      const cut = cuts.get(root)?.find(entry => entry.cutId === cutId);
      const selected = cut?.versions.find(entry => entry.version === version);
      if (!selected) throw new Error("That cut version isn't in this shoot.");
      const shoot = await fetchFixtureShoot();
      // The checked-in fixture has one 40-second video and stills, no per-clip proxies.
      const available = shoot.clips.filter(clip => clip.frames.length);
      if (!available.length) throw new Error("No fixture footage available.");
      const proxy = "fixtures/sample-shoot/precut-talking.mp4";
      const durationS = Math.min(40, selected.lengthS || 12);
      // Three real proxy spans exercise cuts, animated framing and a b-roll layer.
      // The fixture's existing complete cut supplies audible voice; it is not a new audio assembly.
      const pieces: DraftTimeline["pieces"] = [0, 1, 2].map(index => {
        const clip = available[index % available.length];
        const startS = durationS * index / 3, endS = durationS * (index + 1) / 3;
        return { startS, endS, layer: 0, clipId: clip.id, proxy, inS: startS,
          frame: index === 1 ? null : [{ t: startS, x: .3, y: 0, w: .31640625, h: 1 }, { t: endS, x: .35, y: .08, w: .26578125, h: .84 }],
          lut: fixtureLut(selected.grade?.preset ?? preferences.look.preset, selected.grade?.intensity ?? preferences.look.intensity ?? .7, selected.grade ? selected.grade.basic : preferences.look.basic, selected.grade?.mixer) };
      });
      const overlayClip = available.find(clip => clip.judgement?.kind === "broll") ?? available.at(-1)!;
      pieces.push({ startS: durationS * .4, endS: durationS * .55, layer: 1, clipId: overlayClip.id, proxy, inS: 0, frame: null, lut: fixtureLut(selected.grade?.preset ?? preferences.look.preset, selected.grade?.intensity ?? preferences.look.intensity ?? .7, selected.grade ? selected.grade.basic : preferences.look.basic, selected.grade?.mixer) });
      return { durationS, width: 1080, height: 1920, pieces,
        sound: "fixtures/sample-shoot/precut-talking.mp4",
        look: { preset: selected.grade?.preset ?? "clean", intensity: selected.grade?.intensity ?? .7 },
        titles: selected.titles === null ? null : selected.titles ?? { font: "Outfit", prompt: null, skillIds: [], cues: [{ id: "fixture-live-title", s: .2, e: Math.min(3, durationS), role: "title", text: selected.title, layer: "front", x: .5, y: .22, align: "center", size: .028, weight: 700, italic: false, color: "#ffffff", enter: "pop", exit: "fade" }] } };
    },
    async pieceLuts(root, cutId, version, look: Parameters<Api["pieceLuts"]>[3] & { mixer?: import("../../shared/schema").Grade["mixer"] | null; matchClips?: boolean }) {
      const timeline = await this.draftTimeline(root, cutId, version);
      const selected = cuts.get(root)?.find(c => c.cutId === cutId)?.versions.find(v => v.version === version);
      return timeline.pieces.map(() => fixtureLut(look.preset, look.intensity, look.basic ?? selected?.grade?.basic ?? (!selected?.grade ? preferences.look.basic : undefined), look.mixer === null ? undefined : look.mixer ?? selected?.grade?.mixer));
    },
    async addMusicTracks() {},
    async pickMusicTracks() { return []; },
    async pickOverlayFiles() { return []; },
    pathForFile() { return ""; },
    async exportTo(_root, _cutId, _version, targets, aspects) { return { folder: "fixture-precuts", results: targets.flatMap(target => (aspects?.length ? aspects : ["9:16" as const]).map(aspect => ({ target, aspect, ok: true, path: `fixture-precuts/${target}-${aspect.replace(":", "x")}` }))) }; },
    // WR: in-memory brief and questions; WR2 may add a richer waiting-room fixture.
    async getBrief(root) {
      if (root === WAIT_ROOT && !fixtureBriefs.has(root) && (waitStage() ?? "questions") !== "questions") return { purpose: ["Vlog"], going: ["TikTok", "Instagram Reels"], feel: ["Calm"], length: [], asked: true };
      return fixtureBriefs.get(root) ?? { purpose: [], going: [], feel: [], length: [], asked: false };
    },
    async setBrief(root, brief) { fixtureBriefs.set(root, brief); return brief; },
    async listQuestions(root) { return structuredClone(root === WAIT_ROOT ? waitQuestions() : fixtureQuestions.get(root) ?? []); },
    async answerQuestion(root, id, answer) {
      const list = (root === WAIT_ROOT ? waitQuestions() : fixtureQuestions.get(root)) ?? [], found = list.find(q => q.id === id);
      if (!found) throw new Error("That question is no longer open.");
      Object.assign(found, { answer, answeredBy: "you" as const });
      questionListeners.forEach(cb => cb(root)); return found;
    },
    onQuestionsChanged(cb) { questionListeners.add(cb); return () => { questionListeners.delete(cb); }; },
    async addRequest(_root, text) { return { id: "fixture-request", text, at: new Date().toISOString(), state: "queued" as const, ideaIds: [], cutIds: [] }; },
    async listRequests() { return []; },
    async duplicateCut(_root, cutId) { return { cutId: `${cutId}-copy`, version: 1 }; },
    async createCut() { return { cutId: "fixture-new", version: 1 }; },
    async starCut() {},
    async renderSampleLooks() { return []; },
    async writePost() { throw new Error("Post copy needs the app."); },
    async translateCaptions() { throw new Error("Translation needs the app."); },
    async measureAngles() { return []; },
    async applyVocabulary() { return { shoots: 0, clips: 0, words: 0, changes: [] }; },
    async deleteCut() {},
    async restoreCut() {},
    async storageUsage() { return { cacheBytes: 0, exportBytes: 0, footageBytes: 0 }; },
    async clearCaches() { return { freedBytes: 0 }; },
    async audioInputs() { return []; },
    async recordStart() { throw new Error("Recording needs the app."); },
    async recordStop() { throw new Error("Recording needs the app."); },
    onRecordLevel() { return () => {}; },
    async voiceoverScript() { return null; },
    async writeVoiceoverScript() { throw new Error("Voiceover needs the app."); },
    async setVoiceoverLine() { throw new Error("Voiceover needs the app."); },
    async placeVoiceover() { throw new Error("Voiceover needs the app."); },
    async followVoiceoverCaptions() { throw new Error("Voiceover needs the app."); },
    onRecordWords() { return () => {}; },
    async makeBetter(root, cutId, version) {
      const proposal = await api.proposeBetter(root, cutId, version);
      return api.applyBetter(root, cutId, version, proposal.issues.map((issue) => issue.id));
    },
    async proposeBetter(root, cutId, version) {
      const cut = (cuts.get(root) ?? []).find((entry) => entry.cutId === cutId);
      if (!cut?.versions.some((entry) => entry.version === version)) throw new Error("Open an edit, then ask me to make it better.");
      return { cutId, version, issues: structuredClone(FIXTURE_BETTER_ISSUES) };
    },
    async applyBetter(root, cutId, version, issueIds) {
      const chosen = FIXTURE_BETTER_ISSUES.filter((issue) => issueIds.includes(issue.id));
      if (!chosen.length) return { cutId, version, changes: [] };
      const shootCuts = cuts.get(root) ?? [];
      const cut = shootCuts.find((entry) => entry.cutId === cutId);
      const previous = cut?.versions.find((entry) => entry.version === version) ?? cut?.versions.at(-1);
      if (!cut || !previous) throw new Error("Open an edit, then ask me to make it better.");
      const next = Math.max(...cut.versions.map((entry) => entry.version)) + 1;
      cut.versions.push({ ...structuredClone(previous), version: next, createdAt: new Date().toISOString(), feedback: "Made it better",
        critique: { rounds: 1, from: version, at: new Date().toISOString(), issues: chosen.map((issue) => ({ what: issue.what, fixed: true, how: issue.change })) } });
      cuts.set(root, shootCuts); sidekickChanged(root);
      return { cutId, version: next, changes: chosen.map((issue) => issue.change) };
    },
    async extensions() { return []; },
    async installExtension() { throw new Error("Add-ons need the app."); },
    async removeExtension() { throw new Error("Add-ons need the app."); },
    async soundLibrary() { return []; },
    async soundKey() { return { elevenlabs: false }; },
    async generateSound() { throw new Error("Sound generation needs the app."); },
    async renameCut() {},
    async forgetShoot() {},
    async motionStatus(_root, clipIds) { return Object.fromEntries(clipIds.map(id => [id, "none" as const])); },
    async chatSend() {},
    async chatThread() { return []; },
    async chatStop() {},
    async chatAnswer() {},
    onChat() { return () => {}; },
    async musicCatalog() { const tracks = await this.listMusic(); return { tracks, total: tracks.length, completed: tracks.length, failed: 0, measuring: false, etaS: null }; },
    async listMusic() { return [{ file: "fixture-music.mp3", name: "Fixture music", durationS: 40, bpm: null }]; },
    onBalanceApplied: () => () => {},
  balanceClips: async () => { throw new Error("Auto correct is available in the desktop app."); },
  balanceStatus: async () => ({ state: "idle", ready: [], corrected: 0, hand: 0 }),
  balanceHand: async () => {},
  async autoBasic(root, cutId, version) {
      await this.draftTimeline(root, cutId, version); // validate the requested edit
      // Fixed measured fixture recommendation; production reads proxy histograms.
      return normalizeBasic({ exposure: .18, whites: 8, blacks: -6, temperature: 3, tint: -2 });
    },
    async liveGrade() { return null; },
    async liveLut(id) {
      const [, preset, strength, encodedBasic, encodedMixer] = id.split(":");
      const mixer = mixerTransform(encodedMixer ? JSON.parse(decodeURIComponent(encodedMixer)) : undefined);
      const basic = normalizeBasic(encodedBasic ? JSON.parse(decodeURIComponent(encodedBasic)) : undefined);
      const before = basicBefore(basic), after = basicAfter(basic);
      const intensity = Number(strength);
      const size = 33, data: number[] = [];
      if (!id.startsWith("fixture:") || !Number.isFinite(intensity)) throw new Error("Unknown fixture LUT");
      for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
        const original = before([r / (size - 1), g / (size - 1), b / (size - 1)]);
        let [red, green, blue] = original;
        // Browser approximations only. Desktop supplies composed finishing cubes.
        if (preset !== "clean") {
          const luma = red * .2126 + green * .7152 + blue * .0722;
          if (preset === "silver" || preset === "hush") {
            const amount = preset === "silver" ? 1 : .8;
            red += (luma - red) * amount; green += (luma - green) * amount; blue += (luma - blue) * amount;
          } else if (preset === "afterhours" || preset === "neon") { red *= .92; green *= .96; blue = blue * 1.04 + .01; }
          else { red = red * 1.06 + .025; green *= 1.01; blue *= .86; }
        }
        red = original[0] + intensity * (red - original[0]);
        green = original[1] + intensity * (green - original[1]);
        blue = original[2] + intensity * (blue - original[2]);
        data.push(...after(mixer([red, green, blue])).map(v => Math.max(0, Math.min(1, v))));
      }
      return { size, data };
    },
    async setupPrecut() {},
    async signInClaude() {},
    async renderLookPreviews(_root, clipId, t, options: { preset?: string; intensity?: number; width?: number; height?: number } = {}) {
      // Browser-only approximations for exercising the controls. Desktop uses grade.ts.
      const shoot = await fetchFixtureShoot();
      const source = frameAt(shoot, clipId || shoot.clips.find(clip => clip.frames.length)?.id || "", t);
      if (!source) return [];
      const frame = new Image();
      frame.src = source;
      await frame.decode();
      const amount = options.intensity ?? .7;
      const looks = [
        { id: "clean", name: "Clean", description: "True colour, gentle highlights. Your footage, clear.", family: "Soft" as const },
        { id: "hearth", name: "Hearth", description: "Amber light, full colour and grounded shadows.", family: "Warm" as const },
        { id: "linen", name: "Linen", description: "Warm soft film, faded blacks and quiet colour.", family: "Soft" as const },
        { id: "afterhours", name: "Afterhours", description: "Deep blue shadows, spare colour and soft lights.", family: "Cool" as const },
        { id: "openair", name: "Open air", description: "Crisp contrast, bright whites and clear colour.", family: "Cool" as const },
        { id: "neon", name: "Night bus", description: "Teal shadows and clear skin under city lights.", family: "Cool" as const },
        { id: "hush", name: "Hush", description: "Low colour, flat light and a quiet matte finish.", family: "Soft" as const },
        { id: "silver", name: "Silver", description: "Rich black and white, deep blacks and silver light.", family: "Mono" as const },
        { id: "lastlight", name: "Last light", description: "Golden warmth, soft highlights and an open glow.", family: "Warm" as const },
        { id: "warm-negative", name: "Warm negative", description: "Warm skin, pastel light and gentle film contrast.", family: "Film" as const },
        { id: "pastel-green", name: "Pastel green", description: "Airy highlights with a soft green-cyan cast.", family: "Film" as const },
        { id: "slide", name: "Slide", description: "Rich warm reds, clear colour and deep film contrast.", family: "Film" as const },
        { id: "drugstore", name: "Drugstore", description: "Punchy everyday film with green shadows.", family: "Film" as const },
        { id: "rust", name: "Rust", description: "Rust warmth, quiet colour and lifted blacks.", family: "Warm" as const },
        { id: "golden-fade", name: "Golden fade", description: "Faded gold and a soft late-day finish.", family: "Warm" as const },
        { id: "analog", name: "Analog", description: "Toasty analog colour and rounded highlights.", family: "Warm" as const },
        { id: "candy", name: "Candy", description: "Vivid colour, pink highlights and blue shadows.", family: "Warm" as const },
        { id: "mellow", name: "Mellow", description: "Muted blue wash with soft grey blacks.", family: "Cool" as const },
        { id: "street-cool", name: "Street cool", description: "Cool faded streets, crisp edges and quiet colour.", family: "Cool" as const },
        { id: "field", name: "Field", description: "Natural colour with a cool-green breeze.", family: "Cool" as const },
        { id: "night-tungsten", name: "Night tungsten", description: "Teal night shadows and warm practical lights.", family: "Cool" as const },
        { id: "pastel", name: "Pastel", description: "Powdery pink colour and soft pastel light.", family: "Soft" as const },
        { id: "cinematic", name: "Cinematic", description: "Restrained teal shadows with warm natural skin.", family: "Soft" as const },
        { id: "contrast-mono", name: "Contrast mono", description: "Bold monochrome with full blacks and clean light.", family: "Mono" as const },
        { id: "soft-mono", name: "Soft mono", description: "Gentle monochrome with open, silver-grey shadows.", family: "Mono" as const },
      ].map(look => ({ ...look, filter: look.id === "clean" ? "none" : look.family === "Mono" ? `grayscale(1) contrast(${1 + amount * .2})` : look.family === "Cool" ? `saturate(${1 - amount * .25}) hue-rotate(${amount * 12}deg)` : `sepia(${amount * .25}) contrast(${1 - amount * .1})` }));
      const paint = (width: number, height: number, filter: string) => {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Couldn't draw the fixture preview.");
        ctx.filter = filter;
        const scale = Math.max(width / frame.naturalWidth, height / frame.naturalHeight);
        ctx.drawImage(frame, (width - frame.naturalWidth * scale) / 2, (height - frame.naturalHeight * scale) / 2, frame.naturalWidth * scale, frame.naturalHeight * scale);
        return canvas.toDataURL("image/jpeg");
      };
      return looks.filter(look => !options.preset || look.id === options.preset).map(look => ({
        id: look.id, name: look.name, family: look.family, description: `Browser fixture approximation: ${look.name}`,
        image: paint(160, 160, look.filter),
        ...(options.preset ? { still: paint(480, Math.round(480 * (options.height ?? 9) / (options.width ?? 16)), look.filter) } : {}),
      }));
    },
    async appIcons() {
      const none = { installed: false, icon: null };
      return { resolve: none, premiere: none, finalcut: none, capcut: none, finder: { installed: true, icon: null } };
    },
    async getPreferences() { return structuredClone(preferences); },
    async setPreferences(patch) {
      preferences = { ...preferences, ...patch,
        look: { ...preferences.look, ...patch.look }, captions: { ...preferences.captions, ...patch.captions },
        voice: { ...preferences.voice, ...patch.voice }, output: { ...preferences.output, ...patch.output },
        playback: { ...preferences.playback, ...patch.playback } };
      return structuredClone(preferences);
    },
    async appleSetEdit(_root, _cutId, _version, request) {
      return { player: "chrome" as const, reason: request.player === "apple" ? "Apple player needs the desktop app. The standard player plays this edit." : request.reason, appleEnabled: request.appleEnabled };
    },
    async appleControl() {},
    onAppleEvent() { return () => {}; },
    async editTranscript() { throw new Error("Editing the transcript needs the desktop app."); },
    async finishCut(root, cutId, version, options = {}) {
      const cut = cuts.get(root)?.find(entry => entry.cutId === cutId);
      const selected = cut?.versions.find(entry => entry.version === version);
      if (!cut || !selected) throw new Error("That cut version isn't in this shoot.");
      const activity: Activity = { id: crypto.randomUUID(), kind: "finish", root, target: { cutId, version },
        label: `Finishing ${selected.title}`, state: "running", pct: null, etaS: null,
        note: "Browser fixture: simulating finish", startedAt: new Date().toISOString(), endedAt: null, cancelable: true };
      publishActivity(activity);
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          cancelFinish.delete(activity.id);
          const next = structuredClone(selected);
          next.version = Math.max(...cut.versions.map(entry => entry.version)) + 1;
          next.createdAt = new Date().toISOString();
          if (options.titles !== undefined) next.titles = options.titles ? { ...options.titles, font: "Inter", cues: [] } : null;
          if (options.preset !== undefined || options.intensity !== undefined || options.basic !== undefined || options.matchClips !== undefined || options.mixer !== undefined) next.grade = {
            input: "rec709", exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, ...next.grade,
            look: null, preset: options.preset ?? next.grade?.preset ?? "clean", intensity: options.intensity ?? next.grade?.intensity ?? .7,
            basic: options.basic !== undefined ? normalizeBasic(options.basic) : next.grade?.basic ?? preferences.look.basic,
            ...(options.matchClips !== undefined ? { matchClips: options.matchClips } : {}),
            ...(options.mixer !== undefined ? { mixer: normalizeMixer(options.mixer) } : {}),
          };
          if (options.filmFade !== undefined || options.detail !== undefined) next.grade = {
            input: "rec709", exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, look: null, ...next.grade,
            ...(options.filmFade !== undefined ? { filmFade: options.filmFade } : {}),
            ...(options.detail !== undefined ? { detail: options.detail } : {}),
          };
          if (options.music !== undefined) next.music = options.music;
          if (options.faceMatch !== undefined) next.faceMatch = options.faceMatch;
          if (options.audio) next.audio = { clean: true, denoise: .6, loudnessLUFS: -16, ...next.audio, ...options.audio };
          next.warnings = [...next.warnings, "Browser fixture finish updates controls only. The video is not re-rendered."];
          cut.versions.push(next); sidekickChanged(root);
          publishActivity({ ...activity, state: "done", pct: 100, note: "Browser fixture finish saved", endedAt: new Date().toISOString(), cancelable: false });
          resolve({ cutId, version: next.version });
        }, 2500);
        cancelFinish.set(activity.id, () => {
          window.clearTimeout(timer); cancelFinish.delete(activity.id);
          publishActivity({ ...activity, state: "failed", note: "Canceled", endedAt: new Date().toISOString(), cancelable: false });
          reject(new Error("Canceled"));
        });
      });
    },
    async editCut() {
      throw new Error("Editing a cut needs the desktop app.");
    },
    async listSkills() {
      return skills.map((skill) => ({ ...skill })).sort((a, b) => Number(b.global) - Number(a.global) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    onSkillsChanged(cb) { skillListeners.add(cb); return () => { skillListeners.delete(cb); }; },
    async saveSkill(input) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) throw new Error("Skill ids must be lowercase slugs.");
      const previous = skills.find((skill) => skill.id === input.id);
      const saved = { ...input, name: input.name.trim() || input.id,
        description: input.description.replace(/\s+/g, " ").trim() || input.id,
        global: Boolean(input.global) || Boolean(previous?.global) || skills.length === 0,
        path: `skills/${input.id}.md` };
      skills = skills.filter((skill) => skill.id !== saved.id).map((skill) => saved.global ? { ...skill, global: false } : skill);
      skills.push(saved);
      skillsChanged();
      return { ...saved };
    },
    async deleteSkill(id) {
      const skill = skills.find((item) => item.id === id);
      if (!skill) throw new Error("This skill no longer exists.");
      if (skill.global) throw new Error("Choose another global skill before deleting this one.");
      skills = skills.filter((item) => item.id !== id);
      skillsChanged();
    },
    async revealSkills() {},
    async getMusicFolder() { return null; },
    async setMusicFolder() {},
    async pickMusicFolder() { return null; },
    async revealInFinder() {},
    async getEngine() {
      try {
        const engine = window.localStorage.getItem("st-footage.ai-engine");
        return engine === "muse" || engine === "codex" ? engine : "claude";
      } catch { return "claude"; }
    },
    async setEngine(engine) {
      try { window.localStorage.setItem("st-footage.ai-engine", engine); } catch { /* storage unavailable */ }
    },
    async getEngineModel(engine) {
      try { return window.localStorage.getItem(`st-footage.model.${engine}`); } catch { return null; }
    },
    async setEngineModel(engine, model) {
      try {
        if (model) window.localStorage.setItem(`st-footage.model.${engine}`, model);
        else window.localStorage.removeItem(`st-footage.model.${engine}`);
      } catch { /* storage unavailable */ }
    },
    // Spike 4 fixture: steps are derived from what the shoot already has, like main does.
    async shootSteps(root) {
      const shoot = await api.loadShoot(root);
      const total = shoot?.clips.length ?? 0;
      const ready = shoot?.clips.filter((c) => c.stage === "done" || c.stage === "error").length ?? 0;
      const thread = threads.get(root) ?? [];
      const hasIdeas = thread.some((m) => m.ideas?.length);
      const hasCuts = (cuts.get(root) ?? []).length > 0;
      const steps: ShootSteps = {
        folder: { status: "done" },
        clips: ready < total ? { status: "working", note: `tagging ${ready} of ${total}` } : { status: "done" },
        ideas: hasIdeas ? (hasCuts ? { status: "done" } : { status: "waiting", note: "pick what to cut" }) : { status: "todo", note: ready < total ? "waiting on clips" : "ask for ideas" },
        precut: hasCuts ? { status: "done" } : { status: "todo", note: "waiting on ideas" },
      };
      return steps;
    },
    onStepsChanged(cb) { sidekickListeners.add(cb); return () => { sidekickListeners.delete(cb); }; },
    async passIdea(root, messageId, index, passed) {
      const idea = threads.get(root)?.find((m) => m.id === messageId)?.ideas?.[index];
      if (idea) { idea.passed = passed; sidekickChanged(root); }
    },
    async setClipTag(root, clipId, tag) {
      const shoot = await api.loadShoot(root);
      if (!shoot) throw new Error("That shoot isn't loaded.");
      const clip = shoot.clips.find((c) => c.id === clipId);
      if (clip) { if (tag) clip.byHand = { ...clip.byHand, ...tag }; else delete clip.byHand; }
      return structuredClone(shoot);
    },
    // ST1 fixture: nothing is ever trashed in the browser.
    async junkReview(root) {
      const shoot = await api.loadShoot(root);
      const clips = (shoot?.clips ?? []).filter((c) => c.judgement?.junk).map((c) => ({ clipId: c.id, file: c.file, reason: c.judgement!.junk!, sizeBytes: c.meta?.sizeBytes ?? 0 }));
      return { clips, sizeBytes: clips.reduce((n, c) => n + c.sizeBytes, 0) };
    },
    async trashClips(_root, clipIds) { return { trashed: [], failed: clipIds.map((clipId) => ({ clipId, error: "Moving to the Trash needs the desktop app." })), freedBytes: 0 }; },
    async keepClips() {},
    async relinkMissing(root, folder) { return api.relinkShoot(root, folder); },
    async rethinkWithoutMissing(root) {
      const shoot = await api.loadShoot(root);
      if (!shoot) throw new Error("That shoot isn't loaded.");
      const ids = shoot.clips.filter(c => c.missing && !c.leftOut).map(c => c.id);
      return ids.length ? api.leaveOut(root, ids, true) : shoot;
    },
    async addNewFiles() { throw new Error("Adding files needs the desktop app."); },
    async leaveOut(root, clipIds, out) {
      const shoot = await api.loadShoot(root);
      if (!shoot) throw new Error("That shoot isn't loaded.");
      for (const clip of shoot.clips) if (clipIds.includes(clip.id)) { if (out) clip.leftOut = true; else delete clip.leftOut; }
      return structuredClone(shoot);
    },
    onProgress(cb: ProgressCb) {
      listeners.add(cb);
      setTimeout(() => {
        emit({ root: GROWTH_ROOT, clipId: `growth-clip-${growthStep}`, stage: "transcript", pct: Math.round((growthStep / 16) * 100) });
      }, 400);
      return () => listeners.delete(cb);
    },
  };
  return api;
}

let fixtureApi: Api | null = null;

// Electron prefixes every rejected call with "Error invoking remote method 'api:x': Error: ". People only see the reason.
const IPC_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i;
let plainApi: { raw: Api; api: Api } | null = null;
function withPlainErrors(raw: Api): Api {
  if (plainApi?.raw === raw) return plainApi.api;
  // contextBridge freezes its own properties. Wrap a copy so method wrappers
  // obey Proxy invariants while the cache still keys on the exposed bridge.
  const bridge = raw;
  raw = { ...raw };
  // Keep lazy and inherited bridge methods reachable as well.
  Object.setPrototypeOf(raw, bridge);
  const api = new Proxy(raw, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      const result = value.apply(target, args);
      return result && typeof (result as Promise<unknown>).then === "function" ? (result as Promise<unknown>).catch((error: unknown) => {
        if (error instanceof Error && IPC_PREFIX.test(error.message)) error.message = error.message.replace(IPC_PREFIX, "");
        throw error;
      }) : result;
    };
  } });
  plainApi = { raw, api };
  plainApi.raw = bridge;
  return api;
}

export function getApi(): Api {
  const w = window as Window & { api?: Api };
  if (w.api) return withPlainErrors(w.api);
  if (import.meta.env.PROD) throw new Error("The desktop connection is unavailable. Reopen precut.");
  if (!fixtureApi) fixtureApi = createFixtureApi();
  return fixtureApi;
}

export function isFixtureMode(): boolean {
  return import.meta.env.DEV && !(window as Window & { api?: Api }).api;
}

export function frameSrc(shootRoot: string, frame: string): string {
  if (!frame) return "";
  if (frame.startsWith("http") || frame.startsWith("data:") || frame.startsWith("st-media:") || frame.startsWith("/")) return frame;
  if (isFixtureMode()) {
    if (frame.startsWith("fixtures/")) return frame;
    return `fixtures/sample-shoot/${frame}`;
  }
  // Electron: frames/proxies live in <root>/.sidething/<kind>/<file>.
  // Index entries are bare file names; fixture-style "frames/<file>" also works.
  if (frame.startsWith("proxies/")) return mediaUrl(shootRoot, "proxies", frame.slice("proxies/".length));
  if (frame.startsWith("frames/")) return mediaUrl(shootRoot, "frames", frame.slice("frames/".length));
  if (/\.(mp4|m4v|mov|webm)$/i.test(frame)) return mediaUrl(shootRoot, "proxies", frame);
  return mediaUrl(shootRoot, "frames", frame);
}

/** Proxy video URL. In Electron this goes through st-media; fixture mode is unchanged. */
export function proxySrc(shootRoot: string, proxy: string): string {
  if (!proxy) return "";
  if (proxy.startsWith("http") || proxy.startsWith("data:") || proxy.startsWith("st-media:") || proxy.startsWith("/")) return proxy;
  if (isFixtureMode()) {
    if (proxy.startsWith("fixtures/")) return proxy;
    return `fixtures/sample-shoot/${proxy}`;
  }
  const file = proxy.startsWith("proxies/") ? proxy.slice("proxies/".length) : proxy;
  return mediaUrl(shootRoot, "proxies", file);
}

/** Frame image for a moment in a clip, picked from the clip's frames by time. */
export function frameAt(shoot: Shoot, clipId: string, seconds: number): string | null {
  const clip = shoot.clips.find((c) => c.id === clipId);
  if (!clip || clip.frames.length === 0) return null;
  const dur = clip.meta?.durationS ?? 0;
  const idx = dur > 0
    ? Math.min(clip.frames.length - 1, Math.max(0, Math.floor((seconds / dur) * clip.frames.length)))
    : 0;
  return frameSrc(shoot.root, clip.frames[idx]);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}:${String(mm).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function formatTimecode(seconds: number): string {
  return formatDuration(seconds);
}

/** Model text sometimes names clips by file ("camera20260831_1000"); show them the way the grid does ("1000"). */
export function plainClipNames(text: string): string {
  return text.replace(/\b[A-Za-z][A-Za-z-]*\d{6,8}_(\d{3,5})\b/g, "$1");
}

export function shortClipId(id: string): string {
  return id.slice(-4);
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "not recorded";
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1_000_000;
  return `${mb.toFixed(0)} MB`;
}

export function stageLabel(stage: Stage): string {
  const map: Record<Stage, string> = {
    probe: "reading",
    audio: "reading audio",
    transcript: "transcribing",
    shake: "checking shake",
    frames: "making frames",
    proxy: "making proxy",
    judge: "judging",
    done: "done",
    error: "could not read",
  };
  return map[stage] ?? stage;
}
import type { Clip } from "../../shared/schema";
