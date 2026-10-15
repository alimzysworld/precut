// The one data contract. Pipeline (python) writes it, the app reads it, the
// AI judge fills `judgement` and `takes`. Every slice codes against this file.
// Stored at <shoot>/.sidething/index.json

export const SCHEMA_VERSION = 1;

export type ClipKind = "talking" | "broll" | "setup" | "unknown";
export type Verdict = "best" | "alt" | "maybe" | "unusable";
export type ShotSize = "wide" | "medium" | "close" | "unknown";
export type Stage = "probe" | "audio" | "transcript" | "shake" | "frames" | "proxy" | "judge" | "done" | "error";

export interface Word { s: number; e: number; w: string }            // seconds from clip start
export interface Segment { s: number; e: number; text: string; words: Word[] }

export interface ClipMeta {
  camera: string | null;          // "Sony ILCE-7CM2"
  width: number; height: number; fps: number;
  codec: string;                   // "h264 4:2:2 10-bit"
  pictureProfile: string | null;  // "s-log3-cine / s-gamut3-cine"
  iso: number | null; shutter: string | null; aperture: number | null; focalLength: number | null;
  startTimecode: string | null;   // "09:55:16:02"
  audioChannels: number; sampleRate: number;
  durationS: number; sizeBytes: number; createdAt: string | null;
}

export interface Shake {
  measured: boolean;               // false when too dark / unreadable
  meanPx: number | null;           // high-frequency jitter at 320px width
  p95Px: number | null;
  perSecond: number[];             // jitter per second
  shakySpans: [number, number][];  // seconds, merged
}

export interface Judgement {
  kind: ClipKind; verdict: Verdict; shot: ShotSize;
  summary: string;                 // one line, plain English
  usableSpans: [number, number][]; // seconds worth keeping
  model: string;                   // which model judged it
}

export interface Clip {
  id: string;                      // file name without extension
  file: string;                    // path relative to shoot folder
  stage: Stage; error?: string;
  meta: ClipMeta | null;
  transcript: Segment[] | null;
  shake: Shake | null;
  frames: string[];                // relative paths in .sidething/frames/
  proxy: string | null;            // relative path in .sidething/proxies/
  judgement: Judgement | null;
  byHand?: { kind?: ClipKind; shaky?: boolean };   // the user's own tags; they win over the judge everywhere
  sound?: ClipSound | null;        // separate mic matched by waveform; undefined = not checked yet, null = camera sound only
  subject?: SubjectTrack | null;   // where the subject sits, for cropping a wide frame into tall formats; null = nothing found
}

// The best sound for a clip: a separate recorder (DJI mic, Zoom...) lined up by
// waveform, many clips to one long recording. Renders, previews, transcripts and
// the Resolve export all use it in place of the camera's own sound.
export interface ClipSound {
  file: string;          // audio file, relative to the shoot folder
  offsetS: number;       // position in the audio file at clip t=0 (negative: the recorder started after the camera)
  confidence: number;    // 0..1, how clearly the waveforms agree
  byHand?: boolean;      // the user nudged or picked it; a re-sync keeps it
}

// Sampled about twice a second from the proxy. x, y, w, h are fractions of the
// frame (0..1): the centre and size of what the eye should follow.
export interface SubjectSample { t: number; x: number; y: number; w: number; h: number; kind: "face" | "body" | "salient" }
export interface SubjectTrack { samples: SubjectSample[] }

export interface TakeAttempt {
  clipId: string; s: number; e: number;
  text: string;                    // what was actually said
  note: string;                    // "stumbles on 'roadmap'"
}

export interface Take {
  lineIndex: number;               // into Shoot.script
  attempts: TakeAttempt[];
  starred: number;                 // index into attempts; the user can change it
  starredByHand?: boolean;         // true once the user picks; a re-judge keeps his pick
  why: string;                     // one line on the pick
}

export interface AudioFile {
  file: string; durationS: number; channels: number;
  syncedTo: { clipId: string; offsetS: number } | null;  // legacy one-to-one sync; superseded by Clip.sound, kept for old indexes
  clips?: string[];                // clip ids this recording covers (from Clip.sound); [] = matched nothing
}

export interface Shoot {
  schemaVersion: number;
  name: string;
  root: string;                    // absolute path when last opened
  createdAt: string; updatedAt: string;
  script: string[];                // lines; pasted or inferred
  scriptSource: "pasted" | "inferred" | "none";
  clips: Clip[];
  audio: AudioFile[];
  takes: Take[];
}

export interface Template {
  id: string; name: string;
  width: number; height: number; fps: number;
  drpPath: string | null;          // the user's Resolve template project
  notes: string;
}

export type PrecutKind = "talking" | "selects" | "broll" | "reel";

// A skill is a Markdown file describing what the user likes. One is global (his
// taste, read for every reel); the rest are for a type of video. Stored as
// <userData>/skills/<id>.md with frontmatter (name, description, global).
export interface Skill {
  id: string;            // file name without .md
  name: string;
  description: string;   // one line: when to use it
  global: boolean;
  body: string;          // the Markdown after the frontmatter
  path: string;          // absolute path of the .md file
  format?: SkillFormat;  // what a cut made with this skill looks like; the global skill's format is the default
}

// Templates folded into skills (Spike 4): each skill carries its format.
export interface SkillFormat {
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  width: number; height: number;
  fps: number | null;    // null = match the footage
}

// The workflow across the top bar (Spike 4).
export type StepId = "folder" | "clips" | "ideas" | "precut";
export const STEP_IDS: StepId[] = ["folder", "clips", "ideas", "precut"];
export interface StepState {
  status: "todo" | "working" | "waiting" | "done" | "stopped";
  // working: "tagging 9 of 16"; waiting: "pick what to cut"; stopped: "Claude limit reached, try again after 3:30"
  note?: string;
}
export type ShootSteps = Record<StepId, StepState>;
export interface Autopilot {
  stopAt: StepId[];      // steps where it stops and waits for the user; [] = runs all the way
  cutCount: number;      // how many ideas it cuts on its own (3)
}

export interface ReelOptions {
  concept: string;               // what this reel is, in the user's words
  skillIds: string[];            // type skills to apply (the global one always applies)
  lengthS: number;               // target length
  musicFile?: string | null;     // a track from the music folder; null = let sidething pick; undefined = no music
}

// ---- the storyboard sidekick (one thread per shoot, shared by Precuts and the floating widget)

export interface CutVersion {
  version: number;                              // 1, 2, 3...
  createdAt: string;
  title: string;
  voice: string[];                              // take attempt ids in play order (L3A2 = line 3, attempt 2)
  broll: { id: string; over: string | null }[]; // b-roll ids (B4); over = a voice id, or null for a b-roll-led stretch
  music: { file: string; startS: number; gainDb?: number } | null;
  // Every piece resolved by main, in play order, so the renderer never maps ids itself.
  // A b-roll-led stretch is a "broll" piece on the spine; an overlay sits on its voice piece.
  pieces?: {
    id: string;                                 // L3A2 or B4
    kind: "voice" | "broll";
    clipId: string; s: number; e: number;       // source span actually used
    timelineS: number; lengthS: number;
    words?: string;                             // what's said (voice)
    description?: string;                       // what's in it (b-roll)
    overlay?: { id: string; clipId: string; s: number; e: number; description?: string } | null;
    beatSnapS?: number;                         // how far the cut moved onto a beat
  }[];
  templateId: string;
  lengthS: number;                              // measured from the real cut
  preview: string | null;                       // file in <root>/.sidething/precuts/
  why: string;
  warnings: string[];
  missing: string[];                            // footage the reel needs but the shoot doesn't have
  feedback: string | null;                      // what the user asked for that made this version
}

export interface Cut {
  cutId: string;
  concept: string;
  skillIds: string[];
  targetLengthS: number;
  versions: CutVersion[];                       // every version kept
  exported: { version: number; folder: string; at: string }[];
}

export interface ReelIdea {
  title: string;
  concept: string;                              // one line, ready to cut from
  hook: string;                                 // the opening words or image
  lengthS: number;
  uses: string[];                               // take and b-roll ids it would use
  missing: string[];                            // what it would need that isn't shot
  pick?: boolean;                               // one of sidekick's best (autopilot cuts these)
  passed?: boolean;                             // the user said "not this"
  cutId?: string;                               // the cut made from this idea
}

export interface SidekickMessage {
  id: string;
  role: "user" | "sidekick";
  text: string;
  at: string;
  clips?: { clipId: string; s: number; e: number }[];
  ideas?: ReelIdea[];
  cut?: { cutId: string; version: number };    // a new cut or version this reply made
  missing?: string[];
  error?: string;                               // plain-words failure ("Claude Code isn't signed in...")
}

export interface SidekickContext {
  cutId?: string;                               // revising this cut (feedback makes a new version)
  skillIds?: string[];
  lengthS?: number;
  templateId?: string;
  musicFile?: string | null;                    // a track or null = sidekick picks; undefined = sidekick decides from the words and skills (the quiet composer sends nothing)
  fromIdea?: { messageId: string; index: number };  // "Cut this" on an idea card: the cut is linked back to it
}

export interface PrecutResult {
  folder: string;                // the precut folder (FCPXML, CSV, README)
  preview: string | null;        // file name in <root>/.sidething/precuts/ (serve with mediaUrl(root, "precuts", preview))
  lengthS: number;
}
export type Engine = "claude" | "muse";

export interface AskAnswer {
  text: string;
  clips: { clipId: string; s: number; e: number }[];
  precut?: { kind: PrecutKind; attempts: { clipId: string; s: number; e: number }[] };  // a proposed cut; only the user exports it
}

// IPC: renderer -> main (window.api)
export interface Api {
  pickFolder(): Promise<string | null>;
  addShoot(root: string): Promise<Shoot>;
  listShoots(): Promise<{ root: string; name: string; online: boolean }[]>;
  loadShoot(root: string): Promise<Shoot | null>;
  setScript(root: string, lines: string[]): Promise<Shoot>;
  starTake(root: string, lineIndex: number, attempt: number): Promise<Shoot>;
  makePrecut(root: string, kind: PrecutKind, templateId: string, opts?: { reel?: ReelOptions }): Promise<PrecutResult>;
  listPrecuts(root: string): Promise<{ name: string; folder: string; kind: PrecutKind | null; preview: string | null; lengthS: number | null; createdAt: string }[]>;
  listSkills(): Promise<Skill[]>;
  onSkillsChanged(cb: () => void): () => void;
  saveSkill(skill: Omit<Skill, "path">): Promise<Skill>;
  deleteSkill(id: string): Promise<void>;          // moves the file to the Trash
  revealSkills(): Promise<void>;
  getMusicFolder(): Promise<string | null>;
  setMusicFolder(path: string | null): Promise<void>;
  pickMusicFolder(): Promise<string | null>;
  listTemplates(): Promise<Template[]>;
  saveTemplate(t: Template): Promise<void>;
  ask(root: string, question: string): Promise<AskAnswer>;   // legacy: now a thin wrapper over sidekickSend
  sidekickThread(root: string): Promise<SidekickMessage[]>;
  sidekickSend(root: string, text: string, ctx?: SidekickContext): Promise<SidekickMessage>;
  onSidekickChanged(cb: (root: string) => void): () => void;
  listCuts(root: string): Promise<Cut[]>;
  exportCut(root: string, cutId: string, version: number): Promise<PrecutResult>;
  getEngine(): Promise<Engine>;
  setEngine(engine: Engine): Promise<void>;
  revealInFinder(path: string): Promise<void>;
  // Spike 4: workflow, autopilot, ideas, tags
  shootSteps(root: string): Promise<ShootSteps>;
  onStepsChanged(cb: (root: string) => void): () => void;
  retryStep(root: string, step: StepId): Promise<void>;
  getAutopilot(root?: string): Promise<Autopilot>;              // root: that shoot's own setting, else the default
  setAutopilot(a: Autopilot, root?: string): Promise<void>;     // root: just this shoot
  passIdea(root: string, messageId: string, index: number, passed: boolean): Promise<void>;
  setClipTag(root: string, clipId: string, tag: { kind?: ClipKind; shaky?: boolean } | null): Promise<Shoot>;  // null clears the user's tags
  onProgress(cb: (e: { root: string; clipId: string; stage: Stage; pct: number }) => void): () => void;
}
