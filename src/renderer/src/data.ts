import type { Api, Shoot, Stage, Template, Skill, Cut, CutVersion, ReelIdea, SidekickMessage, Autopilot, ShootSteps } from "../../shared/schema";
import { mediaUrl } from "../../shared/media";

export const FIXTURE_ROOT = "most-people-think";
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
    const res = await fetch("fixtures/most-people-think/index.json");
    if (!res.ok) throw new Error(`fixture load failed: ${res.status}`);
    const raw = (await res.json()) as Shoot;
    const micOffsets: Record<string, number> = { "0993": 307.121875, "0997": 508.59625, "0999": 760.077875, "1000": 953.35825 };
    const shoot: Shoot = { ...raw, root: FIXTURE_ROOT, clips: raw.clips.map((clip, i) => {
      const offsetS = micOffsets[clip.id.slice(-4)];
      return { ...clip, sound: offsetS !== undefined
        ? { file: "TX02_MIC037_20251224_214000_orig.wav", offsetS, confidence: 0.79 }
        : i % 2 === 0 ? null : undefined };
    }) };
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

function createFixtureApi(): Api {
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

One idea per reel. If a line does not help that idea, leave it out.

End on the line that lands. No recap or extra sign off.

No zooms. No transitions. A clean cut is enough.

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

Stay on me while the point lands. No zooms or transitions to make it feel busy.

End on the line that lands. Do not add another sentence just to fill the length.

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
  const autopilots = new Map<string, Autopilot>();
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
      const base = [
        { root: FIXTURE_ROOT, name: "most people think", online: true },
        { root: GROWTH_ROOT, name: "growth night b-roll", online: true },
      ];
      return [...base, ...extraShoots];
    },
    async loadShoot(root: string) {
      if (root === FIXTURE_ROOT) return fetchFixtureShoot();
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
    async makePrecut() {
      return { folder: "sidething precuts/talking head", preview: null, lengthS: 40 };
    },
    async listPrecuts() { return []; },
    async sidekickThread(root) { return structuredClone(threads.get(root) ?? []); },
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
      if (!starred.length) {
        reply.text = "This shoot is still processing. I need its words and usable moments before I can suggest an honest cut.";
      } else if (/what reels|suggest.*reels|reel ideas/.test(q)) {
        const ideas: ReelIdea[] = [
          { title: "Build it on the side", concept: "Cut a 30 s reel for founders with day jobs. Open on the strongest hook and end on momentum towards revenue.", hook: firstWords, lengthS: 30, uses: ids, missing: [] },
          { title: "An hour every evening", concept: "Cut a 15 s reel about making progress in an hour every evening. Use the starred takes and end on do it, ship it, come back tomorrow.", hook: starred[1]?.attempts[starred[1].starred].text ?? firstWords, lengthS: 15, uses: ids.filter((_, index) => [1, 6, 7].includes(index)), missing: [] },
          { title: "You need momentum", concept: "Cut a 30 s reel about momentum towards revenue, opening on the empty bridge and using the starred talking-head takes.", hook: "An empty bridge at night. Then: you don't need more ideas, you need momentum.", lengthS: 30, uses: ["B2", ...ids.filter((_, index) => [0, 4, 5, 8].includes(index))], missing: ["a close-up of your hands working on a laptop at night"] },
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
          version: versionNumber, createdAt: new Date().toISOString(), title, voice, broll: previous?.broll ?? [],
          pieces,
          music: ctx.musicFile !== undefined ? { file: ctx.musicFile ?? "fixture-music.mp3", startS: 0, gainDb: -12 } : previous?.music ?? null,
          templateId: ctx.templateId ?? previous?.templateId ?? "9x16", lengthS: Math.round(lengthS * 100) / 100,
          preview: "precut-talking.mp4",
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
    async exportCut(root, cutId, version) {
      const cut = cuts.get(root)?.find((entry) => entry.cutId === cutId);
      const selected = cut?.versions.find((entry) => entry.version === version);
      if (!cut || !selected) throw new Error("That cut version isn't in this shoot.");
      const folder = `sidething precuts/${selected.title} v${version}`;
      cut.exported.push({ version, folder, at: new Date().toISOString() });
      sidekickChanged(root);
      return { folder, preview: selected.preview, lengthS: selected.lengthS };
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
    async listTemplates(): Promise<Template[]> {
      return [
        { id: "16x9", name: "YouTube 16:9", width: 3840, height: 2160, fps: 25, drpPath: null, notes: "" },
        { id: "9x16", name: "Shorts 9:16", width: 1080, height: 1920, fps: 25, drpPath: null, notes: "" },
      ];
    },
    async saveTemplate() {},
    async ask(_root: string, question: string) {
      return { text: `No answer wired in the browser preview yet for: ${question}`, clips: [] };
    },
    async revealInFinder() {},
    // Fixture keeps the engine where the profile menu does ("claude-code" | "muse").
    async getEngine() {
      try { return window.localStorage.getItem("st-footage.ai-engine") === "muse" ? "muse" : "claude"; } catch { return "claude"; }
    },
    async setEngine(engine) {
      try { window.localStorage.setItem("st-footage.ai-engine", engine === "muse" ? "muse" : "claude-code"); } catch { /* storage unavailable */ }
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
    async retryStep() {},
    async getAutopilot(root) { return structuredClone((root && autopilots.get(root)) || autopilots.get("") || { stopAt: [], cutCount: 3 }); },
    async setAutopilot(a, root) { autopilots.set(root ?? "", structuredClone(a)); },
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

export function getApi(): Api {
  const w = window as Window & { api?: Api };
  if (w.api) return w.api;
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
    return `fixtures/most-people-think/${frame}`;
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
    return `fixtures/most-people-think/${proxy}`;
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
