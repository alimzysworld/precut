// The one data contract. Pipeline (python) writes it, the app reads it, the
// AI judge fills `judgement` and `takes`. Every slice codes against this file.
// Stored at <shoot>/.sidething/index.json

import type { Motion } from "./motion";
import type { Look, LookChange } from "./look";

export const SCHEMA_VERSION = 1;

export type ClipKind = "talking" | "broll" | "setup" | "unknown";
export type Verdict = "best" | "alt" | "maybe" | "unusable";
export type ShotSize = "wide" | "medium" | "close" | "unknown";
export type Stage = "probe" | "audio" | "transcript" | "shake" | "frames" | "proxy" | "judge" | "done" | "error";

export interface Word { s: number; e: number; w: string; byHand?: boolean; id?: string }  // seconds from clip start; byHand = the person corrected it (never re-transcribed over); VO7-5 id = immutable take-word id when the transcriber gives one (otherwise derived: take file + index)
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
  rotation?: 0 | 90 | 180 | 270;  // RT1: clockwise turn the file's own metadata asks for (display matrix or camera sidecar); undefined = none recorded
  codedWidth?: number; codedHeight?: number; // RT1: immutable raster dimensions; width/height are displayed dimensions
  containerRotation?: 0 | 90 | 180 | 270; // RT1: turn ffmpeg already applies, excluding sidecar-only orientation
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
  peakS?: number;                 // V35: judge's strongest action or spoken moment, in source seconds
  model: string;                   // which model judged it
  rotate?: 90 | 180 | 270;         // RT2: the judge saw the picture sideways or upside down; clockwise turn that makes it upright
  junk?: string;                   // ST1: the judge thinks this file is not worth keeping on disk (an accident, a pocket shot, a failed recording, a weaker duplicate); one short plain reason. Absent = worth keeping. Separate from verdict: a clip can be unusable for this edit and still worth keeping
  scene?: string;                  // JB1: Claude's short name for the moment this clip belongs to ("Mirror selfies", "The main fight", "Market street"); clips sharing a name are one scene. Written by the judge in the same call
}

// V36: local screen OCR and one cached wording pass, in source seconds.
export interface ScreenSegment {
  s: number; e: number; text: string; still: string;
  app?: string; action?: string; line?: string;
}
export interface ScreenReading {
  key: string; segments: ScreenSegment[]; readMs: number;
  model?: string; modelError?: string;
}

export interface Clip {
  screen?: ScreenReading; // V36: absent until read on this Mac

  missing?: boolean; // V3: original absent; cached stills and proxies remain usable
  id: string;                      // file name without extension; NF1: a clip whose name repeats in another folder gets a folder-qualified id, and an existing id never changes
  file: string;                    // path relative to shoot folder (may include subfolders)
  stage: Stage; error?: string;
  meta: ClipMeta | null;
  transcript: Segment[] | null;
  shake: Shake | null;
  frames: string[];                // relative paths in .sidething/frames/
  pictureStrip?: { key: string; rotation: number }; // RT2: orientation of the last complete, immutable strip
  proxy: string | null;            // relative path in .sidething/proxies/
  previewHealth?: { state: 'healthy' | 'incomplete' | 'unchecked' | 'missing'; stale?: boolean; requiresValidation?: boolean; sourceFrames?: number; previewFrames?: number; expectedFrames?: number; sourceDurationS?: number; previewDurationS?: number }; // V57: measured preview readiness, supplied on load
  judgement: Judgement | null;
  byHand?: { kind?: ClipKind; shaky?: boolean; rotate?: 0 | 90 | 180 | 270; star?: boolean };   // the user's own tags; they win over the judge everywhere. RT: rotate is the person's clockwise turn (0 = keep the file's own way up), winning over judgement.rotate and meta.rotation
  sound?: ClipSound | null;        // separate mic matched by waveform; undefined = not checked yet, null = camera sound only
  subject?: SubjectTrack | null;   // where the subject sits, for cropping a wide frame into tall formats; null = nothing found
  fillers?: ClipFiller[] | null;   // ums, ahs and dead air the cut should lose; undefined = not checked yet, [] = none found
  quality?: ClipQuality | null;    // measured on this Mac (Vision + signal); undefined = not checked yet
  photo?: { file: string; takenAt: string | null }; // PH1: this clip is a still photo; `file` above is the generated still video in .sidething/stills/, photo.file is the original (relative to the shoot folder, never edited). A Live Photo is read as its video, so it has no photo field
  leftOut?: boolean;               // LO1: the person (or their yes to Claude's question) left this clip out of the video; it stays read and listed under "Left out", never judged into ideas or edits
  place?: { name: string | null; lat: number; lon: number; inherited?: boolean } | null;  // JB2: where it was filmed; from the file's GPS (iPhone ISO6709), or inherited from a GPS clip filmed close in time (Sony has none); name from Apple's on-device-OS geocoder; null = unknown
  shot?: { id: string; take: number; takes: number };  // JB2: back-to-back clips with the same framing (Apple Vision feature prints, measured on this Mac) are takes of one shot; take is 1-based in filmed order
  angles?: string[];              // V2: other shots in the same nearby judged moment, never merged as takes
  similar?: { clipId: string; kind: "take" | "angle" | "similar"; distance: number | null }[]; // V2: cached Vision distances, takes first
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
export interface SubjectSample {
  t: number; x: number; y: number; w: number; h: number; kind: "face" | "body" | "salient";
  yaw?: number; pitch?: number;   // face only, radians from Apple Vision: 0 = facing the lens; a negative pitch looks down (reading a phone)
}

// A filler or dead pause inside speech, in clip seconds (camera-relative, like Word).
// "word" fillers are ones the transcript heard (um, uh, erm); "voiced" ones the audio
// shows between words that the transcript dropped; "pause" is silence long enough to tighten.
export interface ClipFiller { s: number; e: number; kind: "word" | "voiced" | "pause"; text?: string }
export interface SubjectTrack { samples: SubjectSample[] }

export interface TakeAttempt {
  clipId: string; s: number; e: number;
  text: string;                    // what was actually said
  note: string;                    // "stumbles on 'roadmap'"
  practice?: boolean;              // the judge saw a run-through (reading the phone, looking away): never cut from
  speechS?: number; speechE?: number;  // first and last real word, measured on the take's own audio (cut edges snap here)
  nextOnsetS?: number;             // the next voice onset after this take (energy): a cut never runs into it
  measures?: TakeMeasures;         // measured per take: focus, exposure, sound, delivery
  hook?: boolean;                  // the judge thinks this line works as an opening
  soundbite?: string | null;       // the judge's pick of a quotable phrase in this take, verbatim
}

export interface Take {
  lineIndex: number;               // into Shoot.script
  attempts: TakeAttempt[];
  // V8: -1 is an explicit unstar when starredByHand is true.
  starred: number;                 // index into attempts; the user can change it
  starredByHand?: boolean;         // true once the user picks; a re-judge keeps his pick
  why: string;                     // one line on the pick
}

export interface AudioFile {
  file: string; durationS: number; channels: number;
  syncedTo: { clipId: string; offsetS: number } | null;  // legacy one-to-one sync; superseded by Clip.sound, kept for old indexes
  clips?: string[];                // clip ids this recording covers (from Clip.sound); [] = matched nothing
  role?: "sync" | "voiceover";     // VO1: voiceover = a voice take with no camera (recorded in precut or dropped in); sync = a recorder matched to camera clips
  transcript?: Segment[] | null;    // VO1: voiceover takes are transcribed like clips
}

// VO: precut writes a voiceover script timed to an edit; the person records it in one take
// (or line by line). Stored per edit in <root>/.sidething/voiceover/<cutId>.json.
export interface VoiceoverLine {
  id: string;
  text: string;                    // what to say, in the person's voice; sentence case, no em dashes
  s: number; e: number;            // reel seconds this line should cover (the shots it is written for)
  pauseAfterS?: number;            // a deliberate beat after the line ("let the shelf land")
  pauseNote?: string;              // the short reason shown between lines: "1 s pause, let the shelf land"
  take?: { file: string; s: number; e: number } | null;  // VO3: the slice of a recording that says this line (shoot-relative WAV, seconds in that file); null = not recorded
  occurrence?: string;             // VO7-5: which placement of the take this piece plays. A split keeps it for both halves; a duplicate makes a new one. Absent = the line id
  follow?: { want: number; at: number };  // SCRIPT1: a picture edit wanted this line at reel `want` but the line before blocked it (it sits at `at`); the next picture edit maps the wish while it still sits there, so a cut and its Restore give the same voice
}
// SCRIPT1: voiceover words cut in the Script panel. The take span stays listed, struck, at the reel time it played,
// so Restore puts back exactly that range (or part of it). `lines` are the pieces it touched as they were, so restoring
// the whole cut gives them back unchanged.
export interface VoiceCut {
  id: string;
  file: string; s: number; e: number;   // take seconds cut
  at: number;                            // reel seconds where that speech played
  occurrence: string;                    // the placement it was cut from
  closed?: boolean;                      // later voice slid left by the length cut (Close gaps)
  lines?: VoiceoverLine[];
}
// VO7-5: captions could not follow a voice change (no words for a take yet, or the rebuild failed).
// The voice change still landed; this note stays on the revision until captions follow again.
export interface CaptionsPending { reason: string; lines: string[]; at: string }
// V66: what a voiceover placement did to the captions. followed = captions now carry the spoken words;
// off = captions are off and stay off; offer = he edited captions by hand, so precut asks before changing them; unchanged = nothing to do.
// VO7-5: voice edits never return offer; captions follow automatically, keeping his corrections.
export type VoiceoverCaptions = "followed" | "off" | "offer" | "unchanged";
export interface VoiceoverScript {
  cutId: string;
  version: number;                 // the edit version it was written for
  lines: VoiceoverLine[];
  wordsPerSecond: number;          // the speaking pace the timing assumed (measured from the person's own takes when there are any)
  model: string;
  writtenAt: string;
}

// WR4: what the judging pass noticed about the whole shoot, worth telling the person in the waiting room.
// Written by the model from the footage it watched and the measured facts it was given; never invented.
export interface ShootNotice {
  text: string;                    // a short headline, sentence case: "Found a strong opening."
  detail: string | null;           // one short line under it: "Your hand taking a croissant off the shelf, steady the whole way."
  clipIds: string[];               // the clip it is about first
}
export interface FolderChanges {
  missingClipIds: string[];
  newFiles: string[];
  changedFiles: string[];
  newAudio: string[];
  missingAudio: string[];
}
export interface Shoot {
  format?: SkillFormat; // V9: saved shoot shape for cached storyboards
  folderChanges?: FolderChanges; // V3: read-only folder listing; work needs an explicit action
  noticed?: ShootNotice[];         // WR4: from the judging pass, newest judging replaces it
  schemaVersion: number;
  name: string;
  root: string;                    // absolute path when last opened
  createdAt: string; updatedAt: string;
  script: string[];                // lines; pasted or inferred
  scriptSource: "pasted" | "inferred" | "none";
  clips: Clip[];
  audio: AudioFile[];
  takes: Take[];
  angles?: AngleGroup[];           // UL6: clips recorded at the same time (cameras, screen recordings), lined up by sound; absent = not measured yet
}
// UL6 (docs/SPIKE-16-underlord-parity.md): one moment filmed from several angles. offsetS = that clip's start on the group's clock.
export interface AngleGroup { id: string; clips: { clipId: string; offsetS: number; kind: "camera" | "screen" }[] }

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
// V9: new profiles make one top pick; persisted cutCount values still win.
export const DEFAULT_AUTOPILOT_CUT_COUNT = 1;
export interface Autopilot {
  stopAt: StepId[];      // steps where it stops and waits for the user; [] = runs all the way
  cutCount: number;      // how many ideas it cuts on its own (3)
  // V9 default is now DEFAULT_AUTOPILOT_CUT_COUNT (1); 3 above describes legacy profiles.
}

export interface ReelOptions {
  concept: string;               // what this reel is, in the user's words
  skillIds: string[];            // type skills to apply (the global one always applies)
  lengthS: number;               // target length
  musicFile?: string | null;     // a track from the music folder; null = let sidething pick; undefined = no music
}

// ---- the storyboard sidekick (one thread per shoot, shared by Precuts and the floating widget)

// V50: keep the accepted soundtrack clock through hand edits, including relaunch.
export interface MusicArrangementAnchor {
  key: string; source: string; durationS: number; storyKey: string | null;
  packet: { reason: string; durationS: number; beats: { atS: number; endS: number; words: string; id: string }[] } | null;
  moments: { reason: string; durationS: number; narration?: string[]; beats: { atS: number; endS: number; words: string; id: string; description?: string }[] } | null;
  holds?: { atS: number; s: number }[];         // SCN1b: pauses inserted into this arrangement (reel seconds, length): its bed plays on under each, then the rest follows
}
export interface CutVersion {
  balances?: Record<string, ClipBalance>;
  balanceReference?: string | null;
  balanceUndo?: number;
  clipSoundMuted?: boolean;                    // V12: saved clip sound bus; voiceover/music/effects stay independent
  voiceover?: VoiceoverScript;                 // VO3: immutable placed lines for this version
  captionsPending?: CaptionsPending | null;    // VO7-5: why captions did not follow this revision's voice; absent or null = they follow
  version: number;                              // 1, 2, 3...
  createdAt: string;
  title: string;
  voice: string[];                              // take attempt ids in play order (L3A2 = line 3, attempt 2)
  broll: { id: string; over: string | null }[]; // b-roll ids (B4); over = a voice id, or null for a b-roll-led stretch
  music: { pinnedArrangement?: MusicArrangementAnchor; file: string; startS: number; endS?: number; gainDb?: number; duckDepthDb?: number; stemDucking?: boolean; fit?: boolean; followStory?: boolean; duck?: boolean; shape?: import("./music-shape").MusicShapeMark[] } | null;  // duck (M1, default true): dips under the voice. shape (PRO3a): stillnesses and hit dips on top of the duck
  bleeps?: { piece: number; s: number; e: number; sound: "beep" | "mute" }[];  // UL1: source spans (word-snapped) bleeped or muted; caption shows the word as "f***"
  lowerThirds?: LowerThird[];                   // UL1: name/title graphics, styled from the edit's caption font and accent
  layouts?: (LayoutChoice | null)[];            // UL3: aligned with pieces; null/absent = the piece's own picture (face)
  autoLayouts?: { enabled: boolean; offerOnly?: boolean; key?: string; timingKey?: string; calledAt?: number; raw?: string; durationS?: number; replyDurationS?: number; offer?: LayoutChoice[]; error?: string };
  videoType?: VideoType;                        // VT1: the type this edit was cut as
  motionGraphics?: boolean;                     // GFX2: the person switched on agent-made motion graphics for this edit; absent/false = off (default)
  critique?: { rounds: number; issues: { what: string; fixed: boolean; how?: string }[]; at: string; from?: number } | null;  // MB1: what "Make it better" found and changed, in plain words; from = the version it improved (Undo opens it)
  produce?: ProducePass | null;                // PRO1: the Produce pass this version carries (its ranked groups of moves, before-values, which are still in); absent = none
  angleCuts?: { atS: number; clipId: string }[];  // UL6: multicam switches on the reel clock; each shows that angle until the next; absent = no multicam
  post?: PostCopy[];                            // UL5: per-platform copy, written on request
  captionLanguage?: string | null;              // UL5: BCP 47 tag of translated captions in this version; null/absent = as spoken
  bigLines?: { s: number; big: boolean }[];     // J1: the person's overrides of which caption lines are big (s = the line's start, reel seconds); absent = precut's choice
  sfx?: SfxItem[];                              // J2: placed sound effects; auto ones are precut's (re-placed when the edit changes unless the person moved them)
  faceMatch?: "off" | "snap" | "ease";          // M1: line the face up across cuts; snap = matched framing on the cut, ease = settle in over ~0.6 s (default)
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
    handMoved?: boolean;                       // V47: travels with this occurrence
    beatSnapS?: number;                         // how far the cut moved onto a beat
    removed?: { s: number; e: number; kind: ClipFiller["kind"] | "cut"; text?: string }[];  // fillers cut out of this piece (clip seconds); "cut" = words the person cut in the transcript (N1)
  }[];
  cutPieces?: { id: string; at: number; after?: { id: string; clipId: string } | null; piece: NonNullable<CutVersion["pieces"]>[number] }[];  // SCRIPT1: pieces whose every word was cut, kept struck where they sat (at = the piece index they sit before, after = the piece they follow; main also keeps their saved source) so Restore puts them back exactly
  voiceCuts?: VoiceCut[];                       // SCRIPT1: voiceover words cut in the Script panel, kept struck at their reel time so Restore puts that exact range back
  framing?: FramingChoice;                      // N2a: the edit's default framing; absent = off
  transition?: JoinChoice;                      // N2b: the edit's default for talking-head joins; absent = from faceMatch (off = cut)
  pieceFx?: (PieceFx | null)[];                 // N2: aligned with pieces; null/absent = follows the edit
  joins?: (JoinChoice | null)[];                // N2b: join i sits between spine pieces i and i+1; null/absent = automatic
  overlays?: OverlayItem[];                     // N4: images on top (screenshots etc.)
  cover?: CoverChoice | null;                   // N9: absent/null = automatic
  cutMusicPlan?: CutMusicPlan;                   // V26: validated, undoable editorial music cut plan
  cutToBeat?: boolean;                          // N2b: with music, move each cut onto the nearest beat inside its pause (reuses reel.ts snapReelCuts); absent = off
  formats?: FormatVariant[];                    // D7: extra formats of this edit on the same card; absent = just the edit's own aspect
  keptFillers?: string[];
  titles?: TitleTrack | null;                  // motion titles and subtitles for this version; null = none
  grade?: Grade | null;                         // colour for the finished video and a LUT for the editor
  audio?: AudioFinish | null;                   // voice cleanup for the finished video; null/undefined = defaults
  finished?: string | null;                     // finished MP4 in <root>/.sidething/finished/ (titles, grade, clean audio)                       // fillers the user put back: "<clipId>@<s to 2 dp>"
  energy?: "off" | "subtle" | "punchy";       // punch-ins at cuts and rhythm (finish)
  templateId: string;
  lengthS: number;                              // measured from the real cut
  preview: string | null;                       // file in <root>/.sidething/precuts/
  why: string;
  warnings: string[];
  missing: string[];                            // footage the reel needs but the shoot doesn't have
  shotOrderResetAt?: number;                   // V47: an explicit reorder cleared earlier move pins
  feedback: string | null;                      // what the user asked for that made this version
  light?: boolean;                              // ARCH2: a listing's old version: only the versions menu's fields (and pieces); loadCutVersion gives the whole version
}

export interface Cut {
  cutId: string;
  concept: string;
  skillIds: string[];
  targetLengthS: number;
  versions: CutVersion[];                       // every version kept
  exported: { version: number; folder: string; at: string }[];
  title?: string;                               // D5: renamed by the person; absent = the latest version's title
  starred?: boolean;                            // D9
}

// VT1 (docs/SPIKE-12-video-types.md): each type has its own editing logic (structure, pacing, picture, sound).
export type VideoType = "talking" | "voiceover" | "montage" | "tutorial" | "vlog";
export interface ReelIdea {
  format?: SkillFormat; // V9: an idea can choose its own storyboard shape
  id?: string;                                  // stable; main backfills old ideas as "<messageId>:<index>"
  title: string;
  concept: string;                              // one line, ready to cut from
  hook: string;                                 // the opening words or image
  lengthS: number;
  uses: string[];                               // take and b-roll ids it would use
  missing: string[];                            // what it would need that isn't shot
  pick?: boolean;                               // one of sidekick's best (autopilot cuts these)
  passed?: boolean;                             // the user said "not this"
  cutId?: string;                               // the cut made from this idea
  requestId?: string;                           // D8: made for one of the person's requests ("Anything you want to make?")
  type?: VideoType;                             // VT1: what kind of video this is; decides the editing logic
  earlier?: Omit<ReelIdea, "id" | "earlier" | "cutId">[];  // previous wordings, oldest first, after talking it over
}

// V62: one proposed improvement. The fix itself stays in main, cached by version.
export interface BetterIssue { id: string; what: string; change: string; severity: "high" | "medium" | "low" }
export interface BetterProposal { cutId: string; version: number; issues: BetterIssue[] }

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
  ideaId?: string;                              // this turn was about one idea (that idea's own thread)
  canMake?: string;                             // VT1: the ideas call's one line on what this shoot can make (shown at the top of Ideas)
  early?: boolean;                              // PF1: made from transcripts and takes before performance checks finished; refreshed in place after
  better?: BetterProposal;                      // V62: what precut would change in the open edit; nothing is saved until Apply
}

export interface SidekickContext {
  better?: boolean;                             // V62: the Make it better offer or Cmd+Shift+B: list fixes for the open edit, change nothing
  cutId?: string;                               // revising this cut (feedback makes a new version)
  ideaId?: string;                              // talking about this idea: the reply reworks it in place
  addIdeas?: boolean;                           // from the Ideas box: a line, link or storyboard to turn into ideas
  skillIds?: string[];
  lengthS?: number;
  templateId?: string;
  musicFile?: string | null;                    // a track or null = sidekick picks; undefined = sidekick decides from the words and skills (the quiet composer sends nothing)
  fromIdea?: { messageId: string; index: number };  // "Cut this" on an idea card: the cut is linked back to it
  videoType?: VideoType;                        // VT1: cut (or re-cut) as this type ("make this a montage"); absent = the idea's, the edit's or the model's choice
  early?: boolean;                              // PF1: automatic work started before performance checks finished
}

export interface PrecutResult {
  folder: string;                // the precut folder (FCPXML, CSV, README)
  preview: string | null;        // file name in <root>/.sidething/precuts/ (serve with mediaUrl(root, "precuts", preview))
  lengthS: number;
}
export type Engine = "claude" | "codex" | "muse";

// VO7-4: 100 measured min/max pairs per second (Int8, ±127 = full scale) for the slice from..to of the source.
export interface PeakSlice { rate: number; from: number; to: number; durationS: number; min: Int8Array; max: Int8Array }
// VO7-1 (briefs/VO7-voiceover-editing-SPIKE-v3.md, "Undo and versions"): numbered snapshots stay
// immutable as hidden revisions. A small sidecar holds the current revision, the undo path and milestones.
export type MilestoneKind = "draft" | "before-auto" | "export" | "saved";
export interface RevisionMilestone { version: number; kind: MilestoneKind; name: string; at: string }
export interface RevisionState {
  version: number;        // the current revision every editor writes against
  cursor: number;         // its index on the undo path
  canUndo: boolean; canRedo: boolean;
  undoTo: number | null;  // the revision ⌘Z would open
  redoTo: number | null;  // the revision ⌘⇧Z would open
}
// Why a write did not publish. stale: written against an older revision with changed targets;
// undone: computed against a revision that was undone, so it never publishes by itself.
export interface RevisionConflict { reason: "stale" | "undone" | "changed"; expected: number; current: number; message: string }
// strict: `version` is the revision the caller believes is current. A stale write is retried on the
// current revision only when its targets are unchanged, otherwise it is a conflict. Without it,
// editCut keeps today's behaviour: it edits the version it was given (the renderer's own undo).
export interface EditCutOptions { strict?: boolean; snapshot?: boolean }

// IPC: renderer -> main (window.api)
export interface Api {
  onBalanceApplied(cb: (event: { root: string; cutId: string; version: number; baseVersion: number; count: number }) => void): () => void;
  balanceClips(root: string, cutId: string, version: number, options?: BalanceOptions): Promise<{ cutId: string; version: number; baseVersion?: number }>;
  balanceStatus(root: string, cutId: string, version: number): Promise<BalanceStatus>;
  balanceHand(root: string, clipId: string): Promise<void>;

  pickFolder(): Promise<string | null>;
  addShoot(root: string): Promise<Shoot>;
  listShoots(): Promise<ShootSummary[]>;            // V4: card data for the library
  relinkShoot(oldRoot: string, newRoot: string): Promise<ShootSummary>;  // V4: the shoot's folder moved; same shoot, new path (checks it is the same footage)
  shootProgress(root: string): Promise<ShootProgress>;                  // V4: real stage states and grounded findings; no model call
  retryStage(root: string, stage: ProcessingStageId | OptionalCheckId): Promise<void>;     // V4: rerun one failed stage, keeping finished ones (PF1b: or one optional check)
  loadShoot(root: string): Promise<Shoot | null>;
  setScript(root: string, lines: string[]): Promise<Shoot>;
  setFootageStar(root: string, key: string, starred: boolean): Promise<Shoot>; // V8: clip id or L1A1, explicit false survives judging
  starTake(root: string, lineIndex: number, attempt: number): Promise<Shoot>;
  listSkills(): Promise<Skill[]>;
  onSkillsChanged(cb: () => void): () => void;
  saveSkill(skill: Omit<Skill, "path">): Promise<Skill>;
  deleteSkill(id: string): Promise<void>;          // moves the file to the Trash
  revealSkills(): Promise<void>;
  getMusicFolder(): Promise<string | null>;
  setMusicFolder(path: string | null): Promise<void>;
  pickMusicFolder(): Promise<string | null>;
  sidekickThread(root: string): Promise<SidekickMessage[]>;
  sidekickSend(root: string, text: string, ctx?: SidekickContext): Promise<SidekickMessage>;
  onSidekickChanged(cb: (root: string, cut?: { cutId: string; version: number }) => void): () => void;
  listCuts(root: string): Promise<Cut[]>;  // ARCH2: old versions come light (CutVersion.light); the current one, its undo neighbours and the newest come whole
  loadCutVersion?(root: string, cutId: string, version: number): Promise<CutVersion>;  // ARCH2: one saved version whole, for a version a listing gave light
  editCut(root: string, cutId: string, version: number, edit: CutEdit, options?: EditCutOptions): Promise<{ cutId: string; version: number; unchanged?: boolean; transformNote?: string; voiceIds?: string[]; snapshot?: CutVersion }>;  // a new version, no model call; Auto may report unchanged with its measured note
  // VO7-1: the current revision and undo cursor. Optional until the renderer (VO7 stage 3) uses them.
  revisionState?(root: string, cutId: string): Promise<RevisionState>;           // what is current, and whether undo or redo can move
  undoRevision?(root: string, cutId: string): Promise<RevisionState>;            // moves the cursor back one step; never rewrites the edit file
  redoRevision?(root: string, cutId: string): Promise<RevisionState>;            // moves it forward again, until an edit discards the redo path
  listVersionMilestones?(root: string, cutId: string): Promise<RevisionMilestone[]>;  // the version menu: only the moments that matter
  saveVersion?(root: string, cutId: string, name?: string): Promise<RevisionMilestone>;  // ⌘S: flags the current revision as a saved version
  restoreVersion?(root: string, cutId: string, version: number): Promise<{ cutId: string; version: number }>;  // one undoable commit whose content equals that milestone
  // TRK1c: the hands-on pin (stage and inspector), the same handlers and request shape as MCP pin_graphic, update_pin and unpin.
  // LOOK1: a scene's look changed (pictures from the shoot, the auto dim measured): the edit to send, not saved.
  lookEdit?(root: string, cutId: string, version: number, input: { itemId: string; all?: boolean; change: LookChange; file?: string }): Promise<{ edit: CutEdit | null; changed: string[]; notes: string[]; look: Look | null }>;
  pinEdit?(root: string, cutId: string, version: number, name: "pin_graphic" | "update_pin" | "unpin", input: Record<string, unknown>): Promise<{ cutId: string; version: number; id: string; heldS?: number; lost?: string; lostAtS?: number; tracked?: boolean }>;
  onPinProgress?(cb: (e: { cutId: string; itemId: string; pct: number }) => void): () => void;  // how far the tracker is, 0 to 100
  // TRK2: the hands-on locked frame (the clip inspector's Lock group and the stage's pick), the MCP's lock_on, update_lock and unlock.
  lockEdit?(root: string, cutId: string, version: number, name: "lock_on" | "update_lock" | "unlock", input: Record<string, unknown>): Promise<{ cutId: string; version: number; piece: number; zoom?: number; need?: number; capped?: boolean; note?: string; lost?: string; lostAtS?: number; tracked?: boolean }>;
  // VO7-4: measured waveform peaks for a sound file, computed once in the main process and cached per shoot.
  getPeaks?(root: string, file: string, from?: number, to?: number): Promise<PeakSlice>;  // file: shoot-relative or absolute; from/to in source seconds
  listEngines(fresh?: boolean): Promise<{ id: "claude" | "codex" | "muse"; installed: boolean; signedIn: boolean | null; version: string | null; apiKey?: boolean }[]>;  // ONB1: fresh skips the 60 s cache. ONB2: apiKey = signed in with a key, not the subscription
  // ONB2 (briefs/ONB2-first-run.md): the first run, AI optional, and precut from the terminal.
  getEngineChoice?(): Promise<Engine | "none">;   // "none" = Start without AI: no model calls at all
  aiStatus?(fresh?: boolean): Promise<AiStatus>;  // the shared "Needs your AI" card's one read; no model call
  terminalStatus?(engine: "claude" | "codex"): Promise<TerminalSetup>;
  setUpTerminal?(engine: "claude" | "codex", step: TerminalStep): Promise<TerminalSetup>;  // one step at a time, so each tick is real
  starterMusic?(): Promise<{ on: boolean; tracks: StarterTrack[] }>;
  setStarterMusic?(on: boolean): Promise<void>;
  keepingAwake?(): Promise<boolean>;              // precut holds a power assertion now (reading a shoot or exporting)
  shootReadTime?(root: string): Promise<ShootReadTime | null>;  // measured from that shoot's own processing
  testEngine(engine: Engine): Promise<{ ok: boolean; text: string }>;   // ONB1: one tiny real call, a plain result
  openEngineHelp(engine: Engine, action: "signin" | "install"): Promise<void>;  // ONB1: Terminal with the exact login command, or the install page
  startFirstRunDownloads(): Promise<void>;       // ONB1: Python tools and the speech model, in the background, safe to call twice
  firstRunDownloads(): Promise<FirstRunDownloads>;
  getEngineModel(engine: Engine): Promise<string | null>;   // null = the engine's own default
  setEngineModel(engine: Engine, model: string | null): Promise<void>;
  installCommandLine(): Promise<{ path: string; onPath: boolean }>;
  editTranscript(root: string, clipId: string, edits: { s: number; e: number; text: string }[]): Promise<Shoot>;  // replace the words in s..e with the corrected text
  finishCut(root: string, cutId: string, version: number, opts?: { filmFade?: number; titles?: { prompt: string; skillIds: string[] } | null; look?: string | null; preset?: LookPreset; intensity?: number; energy?: "off" | "subtle" | "punchy"; audio?: Partial<AudioFinish>; aspect?: SkillFormat["aspect"]; basic?: BasicAdjust | null; matchClips?: boolean; matchRef?: number | null; mixer?: Grade["mixer"] | null; music?: { pinnedArrangement?: MusicArrangementAnchor; file: string; startS: number; endS?: number; gainDb: number; duckDepthDb?: number; stemDucking?: boolean; fit?: boolean; followStory?: boolean; duck: boolean } | null; grain?: GrainChoice | null; vignette?: VignetteChoice | null; detail?: DetailChoice | null; faceMatch?: "off" | "snap" | "ease"; framing?: FramingChoice; transition?: JoinChoice; cutToBeat?: boolean }): Promise<{ cutId: string; version: number }>;  // V4: aspect reframes the cut (new version, no model call)
  checkSetup(): Promise<SetupCheck[]>;
  setupPrecut(): Promise<void>;                  // explicit click only: official Claude installer, then managed Python
  signInClaude(): Promise<void>;                 // opens interactive Claude in Terminal; recheck on app focus
  renderLookPreviews(root: string, clipId: string, t: number): Promise<{ id: string; name: string; description: string; image: string }[]>;  // the look gallery on one frame
  writePost(root: string, cutId: string, version: number, platforms: PostCopy["platform"][]): Promise<{ cutId: string; version: number }>;  // UL5: one model call; saves a version with post copy
  translateCaptions(root: string, cutId: string, version: number, language: string | null): Promise<{ cutId: string; version: number }>;  // UL5: one model call per language, cached; null = back to as spoken
  measureAngles(root: string): Promise<AngleGroup[]>;  // UL6: local, no model call; background lane
  applyVocabulary(root: string | null): Promise<{ shoots: number; clips: number; words: number; changes: { clipId: string; from: string; to: string }[] }>;  // R4: fix misheard names/brand words across transcripts using Preferences.vocabulary; root null = every shoot; one cheap model call per shoot to confirm candidates; saved through editTranscript (originals untouched)
  storageUsage(root: string): Promise<{ cacheBytes: number; exportBytes: number; footageBytes: number }>;  // R6: what precut uses for this shoot (cache is regenerable)
  clearCaches(root: string): Promise<{ freedBytes: number }>;  // R6: removes regenerable caches only; never originals or exports
  audioInputs(): Promise<{ id: string; name: string; isDefault: boolean }[]>;  // VO1: microphones (asks macOS permission on first use)
  recordStart(root: string, deviceId: string): Promise<{ recordingId: string }>;  // VO1: records 48 kHz WAV into <root>/.sidething/recordings/ (FIX2; earlier takes stay in sidething precuts/recordings/). Never in a cache folder: it is original media
  recordStop(recordingId: string): Promise<{ file: string; durationS: number }>;  // VO1: stops, adds it to the shoot as a voiceover take and transcribes it in the background
  onRecordLevel(cb: (e: { recordingId: string; peakDb: number; rmsDb: number }) => void): () => void;  // VO1: level meter
  voiceoverScript(root: string, cutId: string): Promise<VoiceoverScript | null>;                                 // VO2: the saved script, or null
  writeVoiceoverScript(root: string, cutId: string, version: number, opts?: { rewrite?: boolean }): Promise<VoiceoverScript>;  // VO2: the model writes (or rewrites) it to fit this edit
  setVoiceoverLine(root: string, cutId: string, lineId: string, text: string): Promise<VoiceoverScript>;        // VO2: the person's own wording; no model call
  placeVoiceover(root: string, cutId: string, recording: string, lineIds?: string[]): Promise<{ cutId: string; version: number; captions?: VoiceoverCaptions; snapshot?: CutVersion }>;  // OPEN1: snapshot = the placed version, so the page opens it without listing every version first  // VO3: split a take at the script's lines (all lines for a one-take, or the redone ones) and lay it on the edit as a new version; shots fit around it, music ducks
  followVoiceoverCaptions(root: string, cutId: string, version: number, lineIds?: string[]): Promise<{ cutId: string; version: number; captions: VoiceoverCaptions }>;  // V66: Update (hand-edited captions) or Turn on (captions off) so captions follow the placed voiceover; one undoable version, lineIds = the lines just placed (absent = every placed line)
  onRecordWords(cb: (e: { recordingId: string; words: string[]; available?: boolean }) => void): () => void;  // VO4: words heard so far while recording (on-device), so the teleprompter follows the voice
  makeBetter(root: string, cutId: string, version: number): Promise<{ cutId: string; version: number; changes: string[] }>;
  produceEdit?(root: string, cutId: string, version: number): Promise<ProduceOutcome>;   // PRO2: Produce it (watch, direct, apply as one pass, watch it back); never automatic
  produceOutcome?(root: string, cutId: string, version: number): Promise<ProduceOutcome | null>;  // PRO2: what the last Produce on this version came to (null = never produced)  // MB1: watch, critique, improve with a stopping rule; a new version with the changes in plain words
  proposeBetter(root: string, cutId: string, version: number): Promise<BetterProposal>;  // V62: watch and ask once; returns what it would change, saves nothing
  applyBetter(root: string, cutId: string, version: number, issueIds: string[]): Promise<{ cutId: string; version: number; changes: string[] }>;  // V62: one undoable version with only the chosen lines
  extensions(): Promise<ExtensionInfo[]>;    // J7: add-ons and connections ("VS Code for video"): what exists, what's installed, sizes
  installExtension(id: string): Promise<ExtensionInfo>;   // J7: runs on the activity bus (progress, cancelable); downloads only from the manifest's pinned official URLs, checksummed
  removeExtension(id: string): Promise<ExtensionInfo>;    // J7: deletes its files under user data; a connection forgets its key
  soundLibrary(): Promise<{ id: string; name: string; kind: SfxItem["kind"]; lengthS: number; url: string; role?: SoundRole; hitS?: number; category?: string; tags?: string[] }[]>;  // J2: bundled sounds plus the person's generated ones
  soundKey(op: "status" | "clear" | { set: string }): Promise<{ elevenlabs: boolean }>;  // J3: the person's own ElevenLabs key, kept in the macOS keychain (safeStorage), never in files or logs
  generateSound(root: string, prompt: string, seconds: number): Promise<{ file: string; name: string }>;  // J3: ElevenLabs sound generation on the person's key; saved into <root>/.sidething/sfx/ and the library
  renderSampleLooks(sample: "daylight" | "warm" | "night" | "skyline", preset?: string): Promise<{ id: string; name: string; description: string; image: string }[]>;  // O1: the gallery on one of the bundled stock frames (onboarding, Settings), cached; H9: "skyline" = the Look panel tiles
  appIcons(): Promise<Record<EditorId | "finder", { installed: boolean; icon: string | null }>>;  // real icons read from the installed apps (data URLs)   // first run: what this Mac has and how to fix what's missing
  getPreferences(): Promise<Preferences>;
  setPreferences(patch: Partial<Preferences>): Promise<Preferences>;
  // AV1: hand the open edit to the Apple player, drive it, and hear its clock. Optional so older mains keep working.
  appleSetEdit?(root: string, cutId: string, version: number, request: AppleSetEditRequest): Promise<ApplePlaybackReply>;
  appleControl?(action: "play" | "pause" | "seek" | "rect" | "visible" | "muted" | "look", payload?: { at?: number; rate?: number; x?: number; y?: number; w?: number; h?: number; visible?: boolean; muted?: boolean; frames?: number; look?: string }): Promise<void>;
  onAppleEvent?(cb: (event: AppleEvent) => void): () => void;
  getEngine(): Promise<Engine>;
  setEngine(engine: Engine | "none"): Promise<void>;  // ONB2: "none" is Start without AI
  revealInFinder(path: string): Promise<void>;
  // Spike 4: workflow, autopilot, ideas, tags
  shootSteps(root: string): Promise<ShootSteps>;
  onStepsChanged(cb: (root: string) => void): () => void;
  listActivity(): Promise<Activity[]>;                       // everything running or just finished, app-wide
  localFonts?(): Promise<import("./local-fonts").FontFamily[]>;  // VO7-15: this Mac's font families, when Local Font Access is unavailable
  onActivity(cb: (activity: Activity) => void): () => void;   // every start, progress and finish
  cancelActivity(id: string): Promise<void>;
  // PERF1: precut is gentle with the Mac
  reportBusy(busy: boolean): Promise<void>;                   // the person is playing or dragging: background work drops to its lowest profile
  getResourceState(): Promise<ResourceState>;
  fullSpeedForTask(taskId: string): Promise<boolean>;
  onResourceState(cb: (state: ResourceState) => void): () => void;
  draftTimeline(root: string, cutId: string, version: number, aspect?: SkillFormat["aspect"]): Promise<DraftTimeline>;  // D7: aspect = one of the edit's formats; absent = its own  // AA6: the cut as a live timeline over proxies; no render, no model call
  // V15: immutable live stages; slider movement never requests another LUT.
  liveGrade(id: string): Promise<{ baseId: string; presetId: string; grade: Grade; wholeGrade?: Grade; pieceLook?: PieceLook | null; exposure: { stops: number; rolloff: number; matched?: boolean; gains?: [number, number, number] } } | null>;
  liveLut(id: string): Promise<{ size: number; data: number[] }>;  // AA8: a piece's whole grade after the camera conversion (setup base, exposure, look at its intensity, custom controls), evaluated exactly as the finished render does; RGB floats 0..1, r fastest
  pieceLuts(root: string, cutId: string, version: number, look: { preset: LookPreset; intensity: number; basic?: BasicAdjust; matchClips?: boolean; matchRef?: number | null; mixer?: Grade["mixer"] | null; now?: boolean }): Promise<string[]>;  // AA8 (LK1: now = the colour known now, never waits to measure): liveLut ids, one per DraftPiece in order, for an unsaved look choice; no model call
  autoBasic(root: string, cutId: string, version: number): Promise<BasicAdjust>;  // G1: "Auto" from measured exposure, white balance and tonal range; no model call
  musicCatalog(retry?: boolean): Promise<import("./music-library").MusicCatalog>; // V25: immediate cached rows and background measurement progress
  listMusic(): Promise<{ file: string; name: string; durationS: number; bpm: number | null }[]>;  // M1: tracks in the music folder (absolute paths), measured once and cached
  addMusicTracks(files: string[]): Promise<void>;     // N5: dropped or picked tracks, referenced read-only where they are (never copied, moved or edited); listMusic includes them
  pickMusicTracks(): Promise<string[]>;               // N5: a file dialog for audio files
  pickOverlayFiles(): Promise<string[]>;              // N4: a file dialog for images
  showWhatYouSay?(root: string, cutId: string, version: number, options: { s: number; e: number; maxShots?: number; prefer?: import("./broll-plan").BrollPrefer }): Promise<import("./broll-plan").BrollPlan & { cutId: string; version: number }>;  // BROLL2: the proposal for a stretch; applies nothing, no model call
  exportTo(root: string, cutId: string, version: number, targets: ExportTarget[], aspects?: SkillFormat["aspect"][]): Promise<{ folder: string; results: { target: ExportTarget; aspect: SkillFormat["aspect"]; ok: boolean; path?: string; error?: string; warnings?: string[] }[] }>;  // D6: one export, several editors and formats; each result honest on its own. warnings: what finished plain because a model couldn't answer
  getBrief(root: string): Promise<ShootBrief>;                                   // WR: defaults to empty lists, asked: false
  setBrief(root: string, brief: ShootBrief): Promise<ShootBrief>;                // WR: a change after ideas exist becomes a request ("Brief changed: ...")
  listQuestions(root: string): Promise<ShootQuestion[]>;                         // WR: oldest first
  answerQuestion(root: string, id: string, answer: string[]): Promise<ShootQuestion>; // WR: [] = You decide (keeps the guess); a different answer queues a request
  onQuestionsChanged(cb: (root: string) => void): () => void;                   // WR
  addRequest(root: string, text: string, fromIdea?: { messageId: string; index: number }): Promise<ShootRequest>;   // D8/V11: durable requests, optionally drafting a saved idea directly
  listRequests(root: string): Promise<ShootRequest[]>;
  renameCut(root: string, cutId: string, title: string): Promise<void>;
  deleteCut(root: string, cutId: string): Promise<void>;   // R5: moves the edit to <root>/.sidething/trash/ (recoverable 30 days); never exports or originals; not in MCP
  restoreCut(root: string, cutId: string): Promise<void>;  // R5: undo of deleteCut
  duplicateCut(root: string, cutId: string, version: number): Promise<{ cutId: string; version: number }>;  // D9: a new edit (its own card) starting as an exact copy of that version; no model call
  createCut(root: string, opts: { title?: string; from?: ({ take: string } | { clipId: string; s: number; e: number })[] }): Promise<{ cutId: string; version: number }>;  // D9: a blank edit, or one from selected clips in that order; no model call
  starCut(root: string, cutId: string, starred: boolean): Promise<void>;  // D9: saved on the cut   // D5: the edit's title (all versions keep their own; the list shows this one); no model call
  forgetShoot(root: string): Promise<void>;                              // D1: remove from the library list only; never touches the folder or .sidething
  pathForFile(file: File): string;                    // N4/N5: the real path of a dropped file (Electron webUtils, sync, preload only); "" in the browser fixture
  motionStatus(root: string, clipIds: string[]): Promise<Record<string, "ready" | "measuring" | "none">>;  // N2a: camera-shake analysis per clip (steady framing needs it; made in the background on first use)
  chatSend(root: string, text: string, ctx?: { cutId?: string; version?: number }): Promise<void>;   // N8: the Ask panel; replies stream through onChat
  chatThread(root: string): Promise<ChatTurn[]>;
  chatStop(root: string): Promise<void>;
  chatAnswer(root: string, requestId: string, decision: "once" | "always" | "deny"): Promise<void>;  // an approval card
  onChat(cb: (root: string, turn: ChatTurn) => void): () => void;   // every new or changed turn
  onNavigate?(cb: (hash: string) => void): () => void;       // a clicked notification asks to go somewhere
  onMenu?(cb: (command: string) => void): () => void;        // POLISH1: an app menu item the window acts on ("toggle-edits-sidebar")
  onOpenVersion?(cb: (e: { root: string; cutId: string; version: number }) => void): () => void;  // V64: Ask (MCP open_version) puts this saved version on screen, waiting for pause or drag end like the version list
  passIdea(root: string, messageId: string, index: number, passed: boolean): Promise<void>;
  junkReview(root: string): Promise<{ clips: { clipId: string; file: string; reason: string; sizeBytes: number }[]; sizeBytes: number }>;  // ST1: the judge's junk picks still on disk, minus ones the person kept
  trashClips(root: string, clipIds: string[]): Promise<{ trashed: string[]; failed: { clipId: string; error: string }[]; freedBytes: number }>;  // ST1: moves the originals (and a photo's or Live Photo's pair, a Sony clip's XML sidecar) to the macOS Trash, never a permanent delete; only after the person's tap
  keepClips(root: string, clipIds: string[]): Promise<void>;  // ST1: the person unticked these in the review; never offered as junk again
  relinkMissing(root: string, folder: string): Promise<ShootSummary>;
  rethinkWithoutMissing(root: string): Promise<Shoot>;
  addNewFiles(root: string): Promise<Shoot>;
  leaveOut(root: string, clipIds: string[], out: boolean): Promise<Shoot>;  // LO1: these clips are not part of this video (out=true) or back in (false); files stay where they are, reads stay cached, Claude re-judges the rest with one call
  setClipTag(root: string, clipId: string, tag: { kind?: ClipKind; shaky?: boolean; rotate?: 0 | 90 | 180 | 270 } | null): Promise<Shoot>;  // null clears the user's tags; RT2: rotate applies instantly on the stage, caches rebuild in the background
  onProgress(cb: (e: { root: string; clipId: string; stage: Stage; pct: number }) => void): () => void;
}

// A hand edit to a cut version, applied without a model call (the flow is fixed):
// swap a voice piece to another take of the same line, drop a piece, or put a removed filler back.
export type CutEdit =
  | { kind: "shotOrder"; pieces?: number[]; keepMyMoves?: boolean } // V47: sort selected slots, or the whole edit, in one version
  | { kind: "captionWord"; index: number; text?: string; s?: number; e?: number; accent?: boolean; accentAs?: CaptionAccentForm | null; big?: boolean } // V38: edit-clock words, no picture rebuild. CAP4: accentAs = this word's accent form (null = the edit's), big = the word stands alone, big and in caps
  | { kind: "retimeCaptions" } // V38: local speech timing
  | { kind: "duplicate"; pieces: number[] } // V33: exact selected occurrences, one version
  | { kind: "move"; piece: number; to: number; words?: { last: number; s?: number; e?: number; at?: number } }  // TL1: final zero-based position on the magnetic spine. SCRIPT2 words: pieces piece..words.last hold the moved words (split first at clip seconds s in the first and e in the last, each snapped to a gap between words); `to` is then where they go: before piece `to` of this version (pieces.length = the end), or inside it at clip seconds `at`, split there first
  | { kind: "trim"; piece: number; s: number; e: number; magnetic: true } // TL1: explicit frame trim within source footage
  | { kind: "swap"; piece: number; take: string }        // piece index in version.pieces; take = "L11A2"
  | { kind: "remove"; piece: number }
  | { kind: "keepFiller"; piece: number; at: number }     // at = the removed filler's s
  | { kind: "replacePractice" }                          // swap every voice piece whose take is now practice for the best clean take of that line
  | { kind: "trim"; piece: number; s: number; e: number }  // P1: new in/out for that piece, source seconds inside its take (snapped to word edges by main; never clips a word)
  | { kind: "split"; piece: number; at: number }           // P1: cut the piece in two at source time `at` (snapped to the nearest gap between words)
  | { kind: "cutWords"; spans: { piece: number; s: number; e: number }[] }  // N1: cut these source spans (snapped out to whole words) from their pieces, one version; a span covering a whole piece removes it
  | { kind: "restoreWords"; piece: number; at: number; s?: number; e?: number; cut?: string }  // N1: put back the removed span (cut words or filler) of that piece that starts at `at`; SCRIPT1: s/e put back only the words inside (the rest stays cut), cut = a cutPieces id (piece is then ignored)
  | { kind: "removeFillers" }                            // N1: cut every filler (word + voiced) across the edit that isn't already out
  | { kind: "tightenPauses" }                            // N1: shorten long pauses between words to a natural beat (reuses the punchy-energy pause logic)
  | { kind: "laneLevel"; lane: SoundLane; db?: number; muted?: boolean }
  | { kind: "clipSound"; piece?: number; layer?: 0 | 1; muted?: boolean; gainDb?: number; clean?: ClipSoundClean; all?: "on" | "off" } // V12: omit piece to mute the clip sound track
  | { kind: "transform"; pieces: number[]; patch?: ClipTransform | null; autoStraighten?: boolean }
  | { kind: "pieceFx"; piece: number; fx: PieceFx | null } // N2: this clip's framing / speed / volume; null = follow the edit
  | { kind: "join"; join: number; choice: JoinChoice | null }  // N2b: null = automatic
  | { kind: "overlay"; op: "add"; source: string; item: Omit<OverlayItem, "id" | "file"> }  // N4: source = absolute path the person dropped or picked; main copies it into .sidething/overlays (never moves or edits it)
  | { kind: "overlay"; op: "update"; id: string; patch: Partial<Omit<OverlayItem, "id" | "file">> }
  | { kind: "overlay"; op: "remove"; id: string }
  | { kind: "cover"; cover: CoverChoice | null }           // N9: null = back to automatic
  | { kind: "extendPicture"; mode: "black" | "hold" }      // VO7-9: picture runs on to the voice's end, over black or the last frame held
  | { kind: "voiceover"; op: "placeAsIs"; take: string; at?: number }   // VO6: the whole take, uncut, on the Voiceover lane at `at` reel seconds (default 0); picture untouched
  | { kind: "voiceover"; op: "split"; line: string; at: number }          // VO6: split that voice piece at reel seconds `at` (a word inside it moves the cut to its nearest edge)
  | { kind: "voiceover"; op: "trim"; line: string; edge: "start" | "end"; to: number; free?: boolean }  // VO6: move that edge to reel seconds `to`; snaps to the take's word edges unless free (Option); recovers audio up to the take's bounds
  | { kind: "voiceover"; op: "move"; line: string; s: number }            // VO6: new start in reel seconds, stopped at its neighbours
  | { kind: "voiceover"; op: "remove"; line: string }                     // VO6: leaves a gap, no ripple
  | { kind: "voiceWords"; fix?: { word: string; text: string }[]; add?: { text: string; before?: { word: string; occurrence: string }; after?: { word: string; occurrence: string } }[]; relisten?: { line: string } }  // Script panel: respell voiceover words by take-word id ("" hides one), add words the transcriber missed next to a heard word, or listen to one voice piece again for missed words; captions follow in the same version
  | { kind: "batch"; edits: CutEdit[]; label: string }   // UL1: many edits in ONE version (Ask's bulk edits); label = plain words for undo ("Cut every 'basically'")
  | { kind: "bleep"; spans: { piece: number; s: number; e: number }[]; sound: "beep" | "mute" | null }  // UL1: null removes bleeps overlapping the spans
  | { kind: "lowerThird"; op: "add"; item: Omit<LowerThird, "id"> }
  | { kind: "lowerThird"; op: "update"; id: string; patch: Partial<Omit<LowerThird, "id">> }
  | { kind: "lowerThird"; op: "remove"; id: string }
  | { kind: "layout"; piece: number; layout: LayoutChoice | null }    // UL3
  | { kind: "layoutRange"; s: number; e: number; layout: LayoutChoice | null } // V37: reel seconds, one undoable change
  | { kind: "autoLayouts"; enabled: boolean; accept?: boolean }
  | { kind: "layoutJoin"; at: number; transition: "smooth" | "cut" }
  | { kind: "layoutBoundary"; at: number; to: number }
  | { kind: "layoutSplit"; at: number }
  | { kind: "angles"; cuts: { atS: number; clipId: string }[] | null } // UL6: null = back to precut's choice
  | { kind: "bigLine"; s: number; big: boolean | null }    // J1: make this caption line big or normal; null = back to precut's choice
  | { kind: "sfx"; op: "add"; item: Omit<SfxItem, "id" | "auto"> & { landAtS?: number } }   // PRO3a: landAtS puts the sound's measured hit there (atS = landAtS - hitS); J2: placed by the person
  | { kind: "sfx"; op: "update"; id: string; patch: Partial<Omit<SfxItem, "id">> & { landAtS?: number } }  // moving an auto one makes it the person's (auto=false)
  | { kind: "sfx"; op: "remove"; id: string }
  | { kind: "sfx"; op: "musicShape"; shape: import("./music-shape").MusicShapeMark[] | null }  // PRO3a: replace the music's stillnesses and hit dips (null clears them)
  | { kind: "produce"; op: "apply"; pass: ProduceRequest }  // PRO1: write a Produce pass as ONE version (main records each move's target and before-value)
  | { kind: "produce"; op: "less" | "more" | "remove" }      // PRO1: take out the weakest group still in, put back the strongest one out, or take the whole pass out; one version each
  | { kind: "insert"; at: number; source: { take: string } | { clipId: string; s: number; e: number } }  // D9: put a take or a clip span in at piece index `at` (edges snapped like trim); "Add to edit" from Footage
  | { kind: "replace"; piece: number; clipId: string; s?: number; e?: number }  // RP1: put another clip in this piece's place in one step, keeping the slot's length where the new clip allows; no s/e = precut picks the new clip's best usable moment
  | { kind: "format"; op: "add"; aspect: SkillFormat["aspect"] }     // D7: starts from a measured reframe (face tracking), no model call
  | { kind: "format"; op: "remove"; aspect: SkillFormat["aspect"] }
  | { kind: "format"; op: "patch"; aspect: SkillFormat["aspect"]; patch: Partial<Omit<FormatVariant, "aspect" | "width" | "height">> };

// D7 (docs/SPIKE-13-redesign.md): one edit, several formats. Shared by every format: cuts, takes, transcript cuts,
// transitions, speed, volume, music, look, caption words. Per format: framing, overlay placement, caption placement, cover.
export interface FormatVariant {
  aspect: SkillFormat["aspect"];
  width: number; height: number;
  framing?: FramingChoice;                      // this format's default; absent = the edit's
  pieceFraming?: (FramingChoice | null)[];      // aligned with pieces; null = this format's default
  overlays?: Record<string, { x: number; y: number; w: number }>;  // placement by overlay id; absent = scaled from the main format
  captions?: Partial<Pick<CaptionStyle, "position" | "size" | "wordsPerLine">>;
  cover?: CoverChoice | null;
}
export type ExportTarget = EditorId | "mp4";

// ---- N (16 Oct, docs/SPIKE-11-parity.md): per-clip settings with an edit default.
// The edit sets a default; any clip (or join) can override it; null = follow the edit.
export type FramingMode = "off" | "steady" | "face";       // steady = remove camera shake; face = keep the face locked in place (steadies too)
export interface FramingChoice { mode: FramingMode; tight?: number }  // tight 0..1 for "face" (0 loose, 1 close), default 0.4
export type TransitionKind = "cut" | "snap" | "ease" | "zoom" | "whip" | "dissolve" | "ramp";
// cut = hard cut; snap = face lined up on the cut; ease = face settles in (~0.6 s); zoom = punch through;
// whip = fast pan with motion blur; dissolve = cross-fade; ramp = speed ramp (tail of A speeds up, head of B lands back to 1x)
export type TransitionSound = "whoosh" | "hit" | "pop" | "riser";   // synthesised locally, no files or licences
// J7 (docs/SPIKE-15-captions-sound.md, "VS Code for video"): heavy or third-party capabilities are add-ons the person
// installs or connects when they first use them, never part of the app download. Files live under the app's user data.
export interface ExtensionInfo {
  id: string;                                   // "eye-contact", "elevenlabs"
  name: string;                                 // "Eye contact"
  kind: "install" | "connect";                  // install = files on this Mac; connect = the person's own account/key
  what: string;                                 // one plain line: what it needs and whose it is ("A 1.9 GB add-on on this Mac.", "Uses your ElevenLabs account.")
  sizeBytes?: number;                           // install: download/disk size
  state: "available" | "installing" | "installed" | "failed";
  version?: string;
  error?: string;                               // plain words
  unsupported?: string;                         // REL2: why this Mac can't run it ("Needs macOS 26 or newer."); controls that need it hide and say so
}
// J2 (docs/SPIKE-15-captions-sound.md): one placed sound. file = a bundled library id ("lib:whoosh-soft-01") or a file inside <root>/.sidething/sfx/.
export interface SfxItem {
  id: string;
  file: string;
  name: string;                                 // plain words ("soft whoosh")
  atS: number;                                  // reel seconds
  lengthS?: number;                             // for beds (room tone, ambience); absent = the file's length
  gainDb: number;                               // -24..6
  kind: "whoosh" | "hit" | "pop" | "riser" | "impact" | "ambience" | "roomtone" | "ui" | "other";
  auto: boolean;                                // true = placed by precut; false = the person placed or moved it
  reason?: string;                              // why precut put it here, shown in place
  role?: SoundRole;                             // PRO3a: placed at its role's level against the edit's voice; gainDb then trims it (0 = the role's level). Absent = the J2 loudness level
}
// SFX1: identity stays in source time; atS remains a resolved cache for older clients.
export type SoundAnchor =
  | { to: "join"; piece: ProducePieceRef }
  | { to: "graphic"; id: string; edge: "in" | "out" }
  | { to: "element"; id: string; element: string; edge: "in" | "land" | "out" }
  | { to: "word"; piece: ProducePieceRef; sourceS: number }
  | { to: "punch"; piece: ProducePieceRef; at: number }
  | { to: "time"; at: ProduceAnchor };
export interface SfxItem {
  sound?: string;
  anchor?: SoundAnchor | null;
  offsetFrames?: number;
  stretch?: boolean;
  sourceHitS?: number;
  sourceLengthS?: number;
  legacyMix?: "synth" | "scene" | "placed";
  startOffsetS?: number;
}
// PRO3a: where a sound sits in the mix, loudest first: hit (a landing), accent (whoosh, pop, land), ui (click, tick), ambience (a bed).
export type SoundRole = "hit" | "accent" | "ui" | "ambience";

// ---- PRO1 (docs/plans/produced/spike-v1.md, "After Codex round 1"): pass ownership. A Produce pass is ranked groups of
// moves; a move is a value precut already has (a trim, clip settings, a join, a layout, a punch, a sound, a graphic, a
// caption accent, a music mark). Each move keeps its target by identity (piece id + clip + span, a sound or graphic id,
// a caption word by text and neighbours, a time anchored to the piece under it), so later edits that shift indexes or
// times do not lose it, and its before-value, so Less and Remove can put it back. A move the person changed after the
// pass is theirs (handed): Less, More and Remove leave it alone and say so.
export interface ProducePieceRef { id: string; clipId: string; s: number; e: number }  // a spine piece: its id and clip; s/e (source seconds) tell repeated occurrences apart
export interface ProduceAnchor { piece: ProducePieceRef; sourceS: number }                // a reel time held as the source second of the piece under it, so it moves with the picture as precut's ripple moves items
// SCN2: pause = the time a pause scene adds: the shot that grows ({ s, e } source span) and the music held under it
// (held: the seconds held, null when the music isn't fitted); its split stays, playing straight through when it's out.
export type ProduceSlot = "span" | "fx" | "join" | "layout" | "punch" | "sound" | "graphic" | "word" | "music" | "pause";
export interface ProduceMove {
  slot: ProduceSlot;
  label: string;                 // plain words for the row: "the cut at 0:49"
  piece?: ProducePieceRef;       // span, fx, layout, punch: that piece; join: the piece before the join
  next?: ProducePieceRef;        // join: the piece after it
  id?: string;                   // sound, graphic: the item's id in the newest version that holds it
  word?: { text: string; s: number; prev: string[]; next: string[] };  // word: a caption word by its text and neighbours
  before: unknown;               // the value before the pass (null = absent); sounds, graphics and music marks carry their anchor
  after: unknown;                // the value the pass left
  bind?: string;                 // moves that only make sense together (the two trims of one cut) are kept or taken out as one
  handed?: boolean;              // the person changed it after the pass: it is theirs now
}
export interface ProduceGroup { id: string; rank: number; reason: string; needs?: string[]; on: boolean; moves: ProduceMove[] }  // rank 1 = what the edit most needs; Less takes the highest rank out first
export interface ProducePass {
  id: string; idea: string; payoff?: string; quiet?: string;
  at: string; madeOn: number;    // when, and the version it was applied on
  groups: ProduceGroup[];
  removed?: number;              // the version Remove made; absent = the pass is in the edit
  note?: { version: number; text: string };  // what the last Less, More or Remove kept of the person's, shown on that version only
}
export type ProduceMoveEdit = CutEdit | { kind: "punch"; piece: number; scale: number | null } | { kind: "musicMark"; mark: import("./music-shape").MusicShapeMark } | MotionEdit
  | { kind: "pause"; atS: number; lengthS: number };   // SCN2: stop his voice at atS (reel seconds, a gap between his words) for lengthS, under the pause scene the same group adds there

// PRO3b: motion moves in edit seconds, resolved on the draft they run on (src/main/motion-edits.ts). clipPunch and
// clipExposure set a clip's whole list (null clears it), keeping its other settings; piece absent = the clip under the
// first atS. cutOnWord moves the cut into `piece` (absent: the nearest cut) so that shot starts `frames` frames before
// caption word `word` (read_captions index), keeping the length: slide keeps the incoming shot's first frame and
// ripples its tail; roll moves its in-point (absent: slide for b-roll, roll for a shot that carries its own words).
export type MotionEdit =
  | { kind: "clipPunch"; piece?: number; punches: ({ atS: number } & Omit<PiecePunch, "sourceS">)[] | null }
  | { kind: "clipExposure"; piece?: number; keys: { atS: number; levels: number[] }[] | null }
  | { kind: "cutOnWord"; word: number; text?: string; frames?: number; piece?: number; mode?: "slide" | "roll" };
export interface ProduceRequest {
  idea: string; payoff?: string; quiet?: string;
  groups: { id?: string; rank: number; reason: string; needs?: string[]; moves: { edit: ProduceMoveEdit; label?: string; bind?: string }[] }[];
}
// PRO2: what the last "Produce it" on a version came to. landed = a pass was written (version), with any groups the
// review took out and why; left = no pass, the read is best as it is (text says why); refused = the director's answer
// couldn't be applied as a whole (text says why, nothing changed); failed = it stopped (text in plain words);
// waiting = QA replay only: the engine request is on disk.
export type ProduceOutcome =
  | { state: "landed"; on: number; version: number; idea: string; payoff: string | null; quiet: string | null; dropped: { reason: string; why: string }[]; notes?: string[]; at: string }
  | { state: "left" | "refused" | "failed"; on: number; text: string; notes?: string[]; at: string }
  | { state: "waiting"; on: number; step: "director" | "critic"; dir: string; text: string; at: string };
// UL1: a name/title graphic. s/e reel seconds.
export interface LowerThird { id: string; s: number; e: number; title: string; subtitle?: string; position: "left" | "right" | "centre" }
// UL3: how a piece is laid out. screen = a screen recording fills the frame; bubble = screen with the face in a round bubble;
// split = face and screen side by side (or stacked in 9:16); title = a title card over a blurred frame; placeholder = a shot
// still to film or add: the picture stays the person, the timeline shows "Shot needed: <note>" until something is dropped in.
export interface LayoutChoice {
  kind: "face" | "screen" | "bubble" | "split" | "title" | "placeholder" | "scene";
  /** V37: timed layouts extend the original model. Legacy piece choices remain readable. */
  s?: number;
  e?: number;
  id?: import('./layout-presets').LayoutId;
  sources?: { a?: { clipId: string; s: number }; b?: { clipId: string; s: number } };
  swap?: boolean;
  boxes?: import('./layout-presets').LayoutBoxes;
  radius?: number;
  padding?: number; // fraction, 0..0.12
  background?: import('./layout-presets').LayoutBackground;
  transition?: "smooth" | "cut";
  reason?: string;
  auto?: boolean; // V39: hand changes clear this flag and remain protected
  followCamera?: boolean; // keep the original edited camera clock across a timed scene
  screenLoop?: { s: number; e: number }; // source seconds, repeat honestly when the selected segment is short
  screen?: { clipId: string; s: number };       // the screen recording and its source start for this piece
  bubble?: { corner: "tl" | "tr" | "bl" | "br"; size: number };   // size = fraction of frame width, 0.2..0.45
  title?: string;
  note?: string;                                // placeholder: what the shot is
  opacity?: number;                             // BROLL2: the top picture's opacity in an over layout (clip-over-camera: a over b), 0.2..0.95; absent = solid
  cutaway?: { phrase: string; word?: number };  // BROLL2: a "Show what I say" cutaway: the words it shows (word = caption index of the named thing)
}
// UL5: copy for posting, in the person's voice. One per platform asked for.
export interface PostCopy { platform: "reels" | "tiktok" | "shorts" | "youtube" | "linkedin" | "x"; title?: string; caption: string; hashtags: string[]; chapters?: { atS: number; title: string }[]; at: string }
export interface JoinChoice { kind: TransitionKind; sound: TransitionSound | null; audio?: { leadS?: number; trailS?: number } | null }  // J4: J cut (next clip's sound leads in by leadS) / L cut (this clip's sound trails over by trailS), 0..1.5 s; absent on an automatic join = precut decides
export type ClipSoundClean = "none" | "remove_music" | "isolate_voice";
export interface MusicStems { vocals: string; drums: string; bass: string; other: string }
export interface ClipTransform {
  zoom?: number; x?: number; y?: number; rotate?: number;
  crop?: { l?: number; r?: number; t?: number; b?: number };
  flipH?: boolean; flipV?: boolean; constrain?: boolean;
}
/** TRK2: what a clip's locked frame costs (zoom, capped, the note in plain words) and where its thing was lost. tracking:
 * its track is being made again (the clip plays as framed until then). */
export interface LockSummary { piece: number; zoom: number; need: number; capped: boolean; note: string; thing?: string; lost?: string; lostAtS?: number; tracking?: boolean }
export interface PieceFx {
  transform?: ClipTransform; // V46: after framing, inside each layout picture; absent preserves the picture

  clean?: ClipSoundClean;
  overlaySound?: { muted?: boolean; gainDb?: number; clean?: ClipSoundClean }; // V12: attached b-roll sound, independent of its owner
  muted?: boolean;                             // V12: explicit clip sound choice, including b-roll
  framing?: FramingChoice;                      // absent = the edit's
  speed?: number;                               // 0.1..10 (C2 widened from 0.5..2), constant; voice keeps its pitch; typed or slid
  gainDb?: number;                              // -12..12 on this clip's voice
  reverse?: boolean;                            // F1: play this clip backwards (b-roll mostly); its own sound is muted while reversed
  background?: { mode: "blur" | "colour" | "image"; amount?: number; colour?: string; image?: string } | null;  // UL4: behind the person (person mask); amount 0..100 for blur; image inside .sidething/backgrounds/
  look?: PieceLook | null;                      // H5: this clip's own look on top of the edit's; absent/null = follows the edit
  punches?: PiecePunch[];                       // PRO3b: punches on any clip (b-roll too), each locked to the source frame it lands on
  exposure?: PieceExposure[];                   // PRO3b: exposure keys on the picture (a flash), each locked to the source frame it starts on
  lock?: import("./pin-keys").PieceLock;      // TRK2: the picture steadies on a picked thing (after framing, before the clip transform)
}
// PRO3b: a punch lands on the frame showing source second sourceS. settle (the default, the launch video's): it lands
// at scale and eases to 1 over `frames` frames (out cubic), times (1 + creep x frames since the hit) so it never sits
// dead; hold: it steps to scale for lengthS (absent = to the end of the shot). Absent frames = 0.2 s of frames.
export interface PiecePunch { sourceS: number; scale: number; style?: "settle" | "hold"; frames?: number; creep?: number; lengthS?: number }
// PRO3b: from the frame showing source second sourceS, one exposure level per frame (1 = as graded, 1.9 = a hit),
// applied to the graded picture by shared/look-scalar.ts exposureKey in the viewer and the export.
export interface PieceExposure { sourceS: number; levels: number[] }
// H5 (docs/SPIKE-14-edits-panel.md): "This clip" in the Look panel. Each field absent = the edit's value.
// basic is ADDED to the edit's basic (so "a touch brighter on this clip" survives a change of the edit's look);
// preset/intensity replace the edit's for this clip; mixer entries replace the edit's for that colour.
export interface PieceLook {
  filmFade?: number;                            // V19: 0..100, replaces the edit's film fade
  diffusion?: number;                           // V19: 0..100, replaces the edit's highlight diffusion
  preset?: LookPreset;
  intensity?: number;
  basic?: Partial<BasicAdjust>;
  mixer?: Grade["mixer"];
}
export interface OverlayItem {
  id: string;
  file: string;                                 // inside <root>/.sidething/overlays/, relative to it; for a graphic, its rendered PNG
  graphic?: MotionGraphic | null;               // GFX1: an agent-made motion graphic; drawn by precut's sandboxed renderer so live = export
  s: number; e: number;                         // reel seconds
  x: number; y: number; w: number;              // centre and width, fractions of the frame; height follows the image
  rotate?: number;                              // degrees
  corner: "square" | "round";
  enter: "pop" | "slide-up" | "fade" | "none";
  exit: "pop" | "fade" | "none";
  sound: TransitionSound | null;                // plays on enter
  pin?: import("./pin-keys").PinChoice;         // TRK1: locked to a thing in the shot (source space); x, y, w stay the placement at the pick frame
  pinKeys?: import("./pin-keys").PinKeys;       // TRK1b: drawing only (never saved): the pin sampled per frame through the pictures it shows on
}
// GFX1 (briefs/GFX1-graphics.md): an animated composition the agent wrote. It is a pure function of time:
// the renderer sets t (seconds into the graphic) for every frame, so playback, scrubbing and export are frame-exact.
// Sandboxed: no network, no storage, no timers or real clocks, bundled fonts only.
export interface MotionGraphic {
  html: string; css: string;
  js?: string;                                  // optional; must export render(t, el) and use only t for animation
  widthPx: number; heightPx: number;            // design size; scaled to the format
  durationS: number;
  frame: "overlay" | "full";                    // overlay = transparent over/beside the person; full = replaces the picture for its span
  layer?: "front" | "behind";                   // behind = composited behind the person (person mask)
  words?: { text: string; atS: number }[];      // spoken cues it is synced to (reel seconds), for re-timing when the cut changes
  template?: string;                            // the starter it came from, if any
  media?: string;                               // PRO4b: a card's picture, a file in the shoot's own cache (card-<hash>.webp); drawn in by the title page
  frames?: string[];                            // MOT1: a scene's pictures, files in the same cache, drawn in by the title page; the html shows frame i once as src="#frame-i"
  motion?: Motion;                              // MOT1 (shared/motion.ts): when each element lands and how; the template draws from it, so tools change numbers, not code
  look?: Look;                                  // LOOK1 (shared/look.ts): a scene's background, type and finish; absent = drawn on black as before looks
}
export interface CoverChoice { t: number; auto: boolean; title: string | null }  // t = reel seconds; title drawn in the edit's caption style

export type EditorId = "resolve" | "premiere" | "finalcut" | "capcut";

// ---- finishing: motion titles, subtitles, grade (spike 9)
// Times are seconds on the cut's own timeline. Positions are fractions of the frame (0..1).
export interface TitleCue {
  id: string;
  s: number; e: number;
  role: "title" | "subtitle";                   // a designed graphic, or a running subtitle line
  text: string;
  words?: { text: string; s: number; e: number; accent?: boolean; estimated?: boolean; accentAs?: CaptionAccentForm; big?: boolean }[];  // per-word timing for word-by-word reveals. CAP4: accentAs overrides the style's for this word; big = its own big caps line
  layer: "front" | "behind";                    // behind = the speaker passes in front of it (needs a person matte)
  x: number; y: number;                         // anchor point
  align: "left" | "center" | "right";
  size: number;                                 // cap height as a fraction of frame height (subtitle about 0.03, a giant word 0.2)
  weight: 600 | 700 | 800 | 900;
  italic: boolean;
  color: string;                                // CSS colour
  accent?: string;                              // CSS colour for accented words
  rotate?: number;                              // degrees
  enter: "pop" | "slide-up" | "slide-left" | "type" | "fade" | "scale" | "roll" | "none";  // J1: roll = the word rolls in on a 3D drum (a big-word opener)
  exit: "fade" | "slide-down" | "pop" | "none";
  pin?: import("./pin-keys").PinChoice;         // TRK1: locked to a thing in the shot (source space); x, y stay the anchor at the pick frame
  pinKeys?: import("./pin-keys").PinKeys;       // TRK1b: drawing only (never saved)
}
export interface TitleTrack {
  font: string;                                 // a bundled family name
  cues: TitleCue[];
  captionStyle?: CaptionStyle;                  // C1: how the code-built subtitles look; absent = the model's own subtitle style (pre-C1 tracks)
  emphasis?: string[];                          // C1: measured word ids/indices the titles call marked as key words; [] = none
  prompt: string | null;                        // what the person asked for
  skillIds: string[];                           // the title skills used
}
export interface Grade {
  filmFade?: number;                            // V19: 0..100 matte blacks and gentle white roll-off, independent of preset intensity
  input: "slog3" | "rec709" | "hlg" | "unknown"; // fallback only: every clip is converted from its OWN profile (gradeInputFor(clip))
  exposure: number;                             // stops, -2..2
  contrast: number; saturation: number;         // 1 = unchanged
  temperature: number; tint: number;            // -1..1
  look: string | null;                          // the person's words ("warm night, deep blacks")
  preset?: LookPreset;                          // the starting look; the numbers above adjust it
  fade?: number;                                // lifted blacks, 0..0.15 (film)
  rolloff?: number;                             // where highlights start to soften, 0.4..0.8 of white (lower = softer)
  intensity?: number;                           // 0..1, how far the look goes from clean (default 0.7)
  basic?: BasicAdjust;                          // G1: Lightroom-style basics for the whole edit; absent = all zero
  matchClips?: boolean;                         // M1: even out exposure + white balance across pieces (down to -1 stop, up to +0.7); default true for new edits
  matchRef?: number | null;                     // N6: piece index the others are matched to (Lightroom "match to this"); null/absent = matched to each other
  mixer?: Partial<Record<MixerColour, { hue: number; sat: number; lum: number }>>;  // M1: Lightroom HSL, -100..100 each; absent = 0
  grain?: GrainChoice | null;                   // H4: film or video grain over the whole edit, after the LUT; absent/null = none
  vignette?: VignetteChoice | null;             // H4: absent/null = none
  detail?: DetailChoice | null;                 // H12: sharpening and softening after the grade (spatial, not a LUT); absent on new edits = light output sharpening; null = none
}
// H4: grain is drawn after the grade (it is not a LUT): a shader in the live player and the same maths in export.
// Deterministic per frame (seeded by output frame number), so live = export and re-renders match.
export type GrainPreset = "35mm-fine" | "35mm-classic" | "16mm" | "super8" | "trix" | "digital";
export interface GrainChoice {
  preset: GrainPreset;                          // sets the five numbers below; any of them can then be moved
  amount: number;                               // 0..100
  size: number;                                 // 0..100 (grain size, 0 = finest)
  roughness: number;                            // 0..100 (clumping / irregularity)
  colour: number;                               // 0..100 (0 = mono luminance grain, 100 = full chroma noise like digital)
  shadows: number; highlights: number;          // -100..100: how much more or less grain sits in shadows / highlights
}
// H12 (16 Oct): Lightroom Detail + Presence spatial controls, drawn in the same post-grade
// pass as grain (shader live, same maths in export), before grain so grain is never sharpened.
export interface DetailChoice {
  amount: number;                               // 0..150 sharpening amount (Lightroom default 40)
  radius: number;                               // 0.5..3 px at output size
  detail: number;                               // 0..100 (how much fine texture vs only edges)
  masking: number;                              // 0..100 (0 = everywhere, 100 = only strong edges; keeps skin and sky smooth)
  texture: number;                              // -100..100 (fine detail; negative softens skin)
  clarity: number;                              // -100..100 (midtone local contrast; negative = soft, dreamy)
  diffusion: number;                            // 0..100 (Pro-Mist style: highlights bloom softly, contrast drops a touch)
}
export interface VignetteChoice { amount: number; midpoint: number; feather: number }  // amount -100..100 (negative darkens), midpoint/feather 0..100, Lightroom-style
export type MixerColour = "red" | "orange" | "yellow" | "green" | "aqua" | "blue" | "purple" | "magenta";
// G1: Lightroom "Basic" panel for a whole edit. 0 = unchanged. exposure in stops (-2..2),
// the rest -100..100 like Lightroom. Evaluated inside the same per-piece LUT, so live = export.
// V27: source-owned basics, snapshotted by each undoable edit version.
export interface ClipBalance {
  protected?: boolean; // Auto explicitly pressed on this source is also the person's choice.
  basic: BasicAdjust;
  source: string;
  owner: "auto" | "hand";
  updatedAt: string;
}
export interface BalanceStatus {
  state: "idle" | "working" | "ready" | "error";
  ready: string[];
  corrected: number;
  hand: number;
  message?: string;
  etaS?: number | null;
}
export interface BalanceOptions {
  pieces?: number[]; // V33: one scoped Auto correct operation

  readyOnly?: boolean;
  piece?: number;
  reference?: number;
  replaceHand?: boolean;
  prepareOnly?: boolean;
}

export interface BasicAdjust {
  exposure: number; contrast: number;
  highlights: number; shadows: number; whites: number; blacks: number;
  temperature: number; tint: number;
  vibrance: number; saturation: number;
}
export type LookPreset = string;                 // an id from the look gallery (grade.ts LOOKS); "clean" = the plain conversion

// Voice cleanup, applied locally (no model call) to the voice source of each piece.
export interface AudioFinish {
  evenOutVoices?: boolean;
  clean: boolean;                               // denoise + rumble cut + de-ess + gentle compression
  denoise: number;                              // 0..1 strength
  loudnessLUFS: number;                         // target, -16 for social, -14 louder
  eq?: { low: number; mid: number; high: number };  // M1: voice EQ in dB, -6..6 each (low ~120 Hz shelf, mid ~2.5 kHz bell, high ~8 kHz shelf); absent = flat
  auto?: boolean;                               // A3: Auto mix for the whole video (isolation, level matching, voice tone, music/effects under the voice, master); absent = on for new edits
  breaths?: boolean;                            // J6: remove breaths, mouth clicks and plosives from the voice; absent = on for new edits
  design?: boolean;                             // J2: automatic sound design (room tone under cuts, hits on big captions, whooshes on transitions, risers into the hook, ambience); absent = on for new edits
}

// Everyday preferences (Settings). Each is a default; a cut or shoot can still override.
export interface Preferences {
  vocabulary: string[];                         // names, brand words and spellings ("sidething"); fed to transcription and word fixes
  output: {
    shapes: ("9:16" | "16:9" | "1:1" | "4:5")[]; // the shapes you usually make
    height: 1080 | 1440 | 2160;                 // finished video size on the short side's partner (1080 = 1080x1920 for 9:16)
    fps: number | null;                         // null = match the footage
    exportFolder: string | null;                // null = "sidething precuts" next to the footage
    targets?: ExportTarget[];                   // O1/D6: where Export sends by default (multi-select); absent = the editor setting
    posts?: ("reels" | "tiktok" | "shorts" | "youtube" | "linkedin")[];  // O1: where they post, as chosen (shapes and safe area are derived from it)
  };
  captions: {
    onByDefault: boolean;
    safeArea: "tiktok" | "reels" | "shorts" | "none";  // keep text clear of that app's buttons
    style?: CaptionStyle;                      // C1: the default caption style for new edits (Settings > Captions)
  };
  voice: AudioFinish;                           // voice cleanup defaults
  notifications?: boolean;                      // Mac notifications when a long task finishes (default on)
  aiSeesFrames: boolean;                        // false = the AI gets transcripts and measurements only, never pictures
  autoUpdates?: boolean;                        // REL2: check GitHub for a new precut automatically (Settings, General, Updates); absent = on
  improveFirstCuts?: boolean;                   // MB1: watch and improve every first cut once ("Improve first cuts automatically"); absent = on
  look: { preset: LookPreset; words: string | null; intensity?: number; basic?: BasicAdjust };  // the default look for finished videos; basic = "Use for new edits"
  timeline?: { snapping?: boolean; closeGaps?: boolean; audioScrub?: boolean };  // VO7-13: the timeline's remembered toggles; absent = both on. closeGaps: Delete on voice closes the gap
}

export interface FirstRunDownloads {            // ONB1
  state: "idle" | "working" | "ready" | "error";
  what: "tools" | "speech" | null;              // which download is running now
  pct: number;                                  // 0..100 over everything left, never invented
  etaS: number | null;                          // null until there is a real rate to measure (ONB2: always null; the model lands in lumps)
  message: string;
  resumed?: number;                             // ONB2: times a paused or stalled download was picked up again
}
// ONB2: the shared "Needs your AI" card's state for the chosen engine.
export interface AiStatus {
  choice: Engine | "none";
  engine: Engine | null;
  label: string | null;                         // "Claude Code"
  state: "none" | "not-installed" | "signed-out" | "ready" | "unknown" | "allowance" | "offline";
  signInCommand: string | null;                 // what Terminal runs to sign in, for copying when Terminal can't open
  installUrl: string | null;
  apiKey: boolean;                              // signed in with an API key: precut uses the subscription
  detail: string | null;                        // the engine's own words for an allowance or offline problem
}
export type TerminalStep = "command" | "connect" | "skill" | "check";
export interface TerminalSetup {
  engine: "claude" | "codex";
  installed: boolean;                           // the engine's CLI is on this Mac
  steps: Record<TerminalStep, { ok: boolean; detail: string | null } | null>;  // null = not tried yet
  done: boolean;
  copy: string | null;                          // the command to run by hand when a step fails
  prompt: string;                               // a first prompt to copy
}
export interface StarterTrack { file: string; title: string; artist: string; licence: string; credit: string; mood: string; durationS: number; url?: string }
export interface ShootReadTime { footageS: number; tookS: number; clips: number }
export interface SetupCheck {
  id: "claude" | "codex" | "engine" | "ffmpeg" | "python" | "xcode" | "exiftool" | "venv";
  name: string;                                 // "Claude Code"
  ok: boolean;
  required: boolean;                            // tools, Claude and Python must be ready; the speech model is deferred
  detail: string | null;                        // "2.1.300, signed in" or what's wrong, in plain words
  fix: string | null;                           // Claude setup action: "install", "login", or null
}

// Measured facts for culling and search (spike 10). Numbers are measurements;
// flags are the measurement's plain reading, shown as facts, never as a verdict.
export interface ClipQuality {
  tags: { label: string; confidence: number }[];  // Apple Vision scene classification over the clip, top labels
  spans: QualitySpan[];                           // problems with where they are
  duplicateOf?: string | null;                    // a near-identical clip (Vision feature print)
}
export interface QualitySpan {
  s: number; e: number;
  kind: "soft-focus" | "blown-highlights" | "too-dark" | "clipping" | "wind" | "rustle" | "noisy" | "no-mic";
  value: number;                                  // the measurement (e.g. face capture quality 0..1, noise floor dBFS)
}
export interface TakeMeasures {
  faceQuality: number | null;       // Vision face capture quality, median over the take (0..1, higher = sharper, better lit)
  eyeContact: number | null;        // share of the take facing the lens (0..1); informational, fixable in post
  wpm: number | null;               // speaking pace
  pauseS: number | null;            // total silence inside the take
  energyDb: number | null;          // vocal loudness spread (dynamics) in dB
  flags: QualitySpan["kind"][];     // problems overlapping the take
}

// One shape for every long task, so the app can show it where the result will appear,
// in one quiet activity capsule, and as a Mac notification when it finishes.
/** PERF1: how hard background work is pushing right now. full = no limits. */
export interface ResourceState {
  batteryContext?: "low-power" | "low" | "background" | "preparation";
  taskId?: string | null;
  canFullSpeed?: boolean;
  mode: "full" | "calm" | "quiet" | "paused";
  reason: "warm" | "battery" | "busy" | null;
}
export interface Activity {
  id: string;
  kind: "process" | "judge" | "ideas" | "cut" | "edit" | "titles" | "finish" | "render" | "export" | "setup" | "looks";
  root: string | null;                          // the shoot, when there is one
  target: { cutId?: string; version?: number; ideaId?: string; clipId?: string } | null;  // where the result appears
  label: string;                                // plain words: "Cutting Here's the move", "Rendering finished video"
  state: "running" | "done" | "failed";
  pct: number | null;                           // null = indeterminate
  etaS: number | null;                          // estimated seconds left, when known
  note: string | null;                          // the current step ("transcribing 3 of 16") or the error in plain words
  startedAt: string; endedAt: string | null;
  cancelable?: boolean;                         // AA2: true for finish and render; the UI shows Cancel only when true
  // EXP1: an export's current stage, how far through that stage (0..100), and how much of the edit's picture is
  // rendered (doneS of lengthS seconds). Absent for other work. With stages, pct is the whole export and only rises.
  stage?: ActivityStage | null;
  stagePct?: number | null;
  doneS?: number | null;
  lengthS?: number | null;
}
export type ActivityStage = "preparing" | "sound" | "picture" | "saving";

// AA5-AA7: drafts are played live, never rendered. Proxies carry only the camera
// conversion to Rec.709 (made once at import); everything else is a live layer.
export interface DraftPiece {
  transform?: ClipTransform; // V46: same output-space recipe as the finished renderer

  startS: number; endS: number;            // on the reel timeline
  layer: 0 | 1 | 2 | 3;                    // 0 = spine, 1 = overlay; 2/3 = outgoing layout pictures during a morph
  clipId: string;
  proxy: string;                           // playable URL of the clip's proxy, same scheme the Stage uses today
  inS: number;                             // source time at startS (proxy time = source time)
  frame: { t: number; x: number; y: number; w: number; h: number }[] | null;  // source rect over time, normalised 0..1, t = reel seconds; null = fit with blurred fill
  liveLook?: PieceLook | null;             // V15: immutable per-picture override, independent of a shared LUT id
  lookPiece?: number;                       // V15: pieceFx owner, including angle cuts
  lut: string;                             // AA8: liveLut id of this piece's whole grade at the saved look; the shader applies only this, with tetrahedral interpolation
  piece?: number;                          // N2: index in CutVersion.pieces this picture belongs to (for selection and pieceFx)
  timeMap?: { t: number; s: number }[];    // N2b: reel t -> source s, piecewise linear over startS..endS (speed, ramps); absent = inS + (t - startS)
  opacity?: { t: number; a: number }[];    // N2b: 0..1 over reel time (dissolve); absent = 1. Spine pieces may overlap during a dissolve; the later one draws on top
  blur?: { t: number; amount: number; angle: number }[];  // N2b: directional motion blur (whip, zoom); amount = fraction of frame width, angle in radians; absent = none
  exposure?: { t: number; k: number }[];   // PRO3b: exposure level from reel second t until the next key (stepped, per frame); absent = 1
}

// N8: the Ask panel. One thread per shoot (the sidekick thread, upgraded): the person's own Claude Code
// running as an agent, with precut's edit tools first and everything else behind approval cards.
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;                            // streamed; markdown
  at: string;
  state: "streaming" | "done" | "stopped" | "failed";
  steps?: { id: string; tool: string; summary: string; state: "running" | "done" | "failed" | "denied" }[];  // tool calls, one plain line each ("Cut 'and then' from line 10")
  ask?: { requestId: string; tool: string; summary: string; state: "waiting" | "allowed" | "denied" } | null;  // an approval card
  cut?: { cutId: string; version: number };   // a version this turn made
  error?: string;
}
// R7: the live mix the player builds in WebAudio. Each voice piece plays its prepared (cleaned) take span, or the raw
// audio until that is ready; effects and room tone are scheduled buffers; music ducks under the voice envelope.
export interface LiveSoundPiece { clean?: ClipSoundClean; duckDb?: number; layer?: 0 | 1; muted?: boolean; id: string; piece?: number; url: string; rawUrl?: string; rawSourceStart?: number; startS: number; endS: number; timeMap: { t: number; s: number }[]; sourceStart?: number; gainDb: number; normalizeDb?: number; fadeInS?: number; fadeOutS?: number; loop?: boolean; peaks?: number[] }
export interface LiveSound { durationS: number; pieces: LiveSoundPiece[]; effects: LiveSoundPiece[]; audio: AudioFinish; music: { endS?: number; peaks?: number[]; sourcePeaks?: number[]; sourceDurationS?: number; waveformDurationS?: number; sourceBars?: number[]; arrangementSource?: string; arrangementSummary?: string; arrangementSections?: { sourceS: number; sourceE: number; atS: number; section: number }[]; arrangementState?: "preparing" | "ready" | "error"; stems?: MusicStems; stemsStartS?: number; url: string; rawUrl?: string; rawSourceStart?: number; startS: number; gainDb?: number; duckDepthDb?: number; stemDucking?: boolean; fit?: boolean; followStory?: boolean; duck?: boolean; shape?: import("./music-shape").MusicShapeMark[] } | null; bleeps: { s: number; e: number; sound: "beep" | "mute" }[] }
export interface DraftTimeline {
  captionSource?: import('../main/titles/captions').CaptionSource;
  voiceover?: VoiceoverLine[];                 // VO3: recorded line blocks on the Voiceover lane
  musicBeatsS?: number[];                   // TL1: measured music beats on the reel clock, never inferred from tempo
  musicGrid?: import('./music-grid').MusicGrid; // V31: cached measured rhythm on the arranged output clock
  musicTrimBounds?: Record<number, import('./music-grid').MusicTrimBounds>; // V26 whole-word and usable-source constraints
  durationS: number;
  width: number; height: number;           // the reel's frame
  fps?: number;                            // N7/D4: the reel's frame rate, for frame stepping (absent on older builds = the template's, else 25)
  pieces: DraftPiece[];
  layoutClock?: Pick<DraftPiece,'clipId'|'startS'|'endS'|'inS'|'timeMap'>[]; // original picture clock, including holes/speed, even in a screen-only scene
  sound: string | null;                    // legacy: a whole mixed master (now only for export/editors); live playback uses liveSound when present
  liveSound?: LiveSound;                   // R7: per-piece live mix (WebAudio): voice pieces, effects, music with ducking, bleeps; nothing is pre-mixed for playback
  voice?: { url: string | null; peaks: number[] } | null;  // D9: the voice alone (for the Voice lane waveform) and ~100 peaks per second of the master; absent on older builds
  look: { preset: LookPreset; intensity: number } | null;   // the saved choice, for the controls
  titles: TitleTrack | null;
  joins?: { index: number; atS: number; choice: JoinChoice; auto: boolean; between: ["voice" | "broll", "voice" | "broll"] }[];  // N2b: one per join on the spine, for the storyboard's transition cards
  overlays?: (OverlayItem & { url: string; mediaUrl?: string; framesUrl?: string[] })[];   // N4: drawn in the titles layer, live and in the export
  pinTracks?: Record<string, import('./pin-keys').TrackFile>;  // TRK1b: the tracks the version's pins read, by pinTrackId (a missing one is being tracked again)
  locks?: LockSummary[];                        // TRK2: each locked clip's cost and loss, for the clip inspector's Lock group
  loudness?: { lufs: number; truePeakDb: number; target: number } | null;  // S1: measured on the draft mix (the same chain as export); null while measuring
  cover?: (CoverChoice & { image: string | null }) | null;  // N9: image = still of that frame with its title
}

// ---- V4 (docs/SPEC-V4-user-stories.txt, docs/design/precut-v4-concept.png)
// Library cards. status is derived from real data, never optimistic:
// processing = a processing stage is running; failed = a stage failed and nothing is running;
// edits = at least one cut exists; ideas = ideas exist, no cuts; new = nothing yet; offline = folder not reachable.
export interface ShootSummary {
  root: string; name: string; online: boolean;
  status: "new" | "processing" | "ideas" | "edits" | "failed" | "offline";
  thumb: string | null;            // playable/displayable URL of one representative still, null when none yet
  clipCount: number; ideaCount: number; cutCount: number;
  lastActivityAt: string | null;   // ISO; the newest of index update, cut, idea, export
  progressPct: number | null;      // while processing, when defensible; else null
}
export type ProcessingStageId = "index" | "transcribe" | "group" | "judge" | "ideas" | "drafts";
// PF1b: refinements that never stop first edits. If one can't run, edits are made without it.
export type OptionalCheckId = "framing" | "quality" | "fillers";
export interface OptionalCheck { id: OptionalCheckId; detail: string | null }   // only the ones that failed
export interface ProcessingStage {
  id: ProcessingStageId;
  label: string;                   // "Reading footage and metadata", "Transcribing dialogue", "Grouping takes", "Checking performances", "Generating video ideas", "Assembling draft edits"
  state: "queued" | "running" | "done" | "failed" | "skipped";
  detail: string | null;           // "113 files found", "clip 4 of 16", the error in plain words when failed
  pct: number | null;              // only when measured
}
// A finding is a fact read from the shoot's data (counts, flags the pipeline set), written by code. Never model prose.
export interface ProcessingFinding {
  id: string;                      // stable, so the list doesn't reshuffle
  text: string;                    // "Found 6 takes of your opening line", "Detected a stumble at 02:14"
  clipId?: string; t?: number;     // what to show / open
  clipIds?: string[];              // WR: frames the waiting room shows with it, the one it is about first
  detail?: string | null;          // WR4: one short line under the headline (from ShootNotice)
}
export interface ShootProgress {
  root: string;
  running: boolean;
  stages: ProcessingStage[];       // always all six, in order
  findings: ProcessingFinding[];   // newest last, at most ~12
  optional?: OptionalCheck[];      // PF1b: optional checks that failed (edits were made without them)
  waiting?: WaitingRoomState;      // WR: what the waiting room shows; absent on old main processes
  reading?: { label: string; pct: number | null; note: string | null }; // quiet read of new or changed files in a shoot with ideas or edits (no waiting room)
  openElsewhere?: boolean;         // FIX2: another precut owns this shoot, so this one is read only until that one quits
}

// WR: the waiting room (design approved 18 Oct, docs/plans/WAITING-ROOM.md).
// A shoot's brief: the four opening questions. An empty list means "You decide" or skipped: precut decides.
// Stored in <shoot>/.sidething/brief.json. The model reads it as context; code never turns it into thresholds.
export interface ShootBrief {
  purpose: string[];               // "Vlog", "Talking to camera", "Montage", "Tutorial", "Event"
  going: string[];                 // "TikTok", "Instagram Reels", "YouTube Shorts", "YouTube"
  feel: string[];                  // "Calm", "Funny", "High energy", "Cinematic"
  length: string[];                // "15 s", "30 s", "60 s", "Longer"
  music?: string[];                // MQ1: "Chill", "Upbeat", "Cinematic", "Hip-hop", "Acoustic"; absent on briefs saved before 18 Oct
  asked: boolean;                  // the opening questions were shown (answered or skipped), so they never show again
}
// A question the model raised while reading the shoot, only when the answer would change the edit.
// Nothing waits on it: edits are made with `guess`. An answer that differs from the guess becomes a request
// to remake what it touched. Stored in <shoot>/.sidething/questions.json.
export interface ShootQuestion {
  id: string;
  text: string;                    // "Is the croissant the point of the day?"
  why: string;                     // "It's in three clips, and it's the best shot so far."
  options: string[];               // 2 to 4, written by the model; the UI adds "You decide"
  multi: boolean;
  guess: string[];                 // what precut goes with if nobody answers (one of options)
  answer: string[] | null;         // null until answered; [] = "You decide"
  answeredBy: "you" | "precut" | null;
  clipIds?: string[];
  at: string;
  kind?: "split";                  // NF2: "Is this one video or several shoots?"; answering with the split option imports each folder as its own shoot (code does the split, the model decides whether to ask)
  folders?: string[];              // NF2: for kind "split", the subfolders (relative to the shoot) that would each become a shoot
}
export interface WaitingRoomState {
  sound?: { label: "Separating music" | "Cleaning sound"; etaS: number | null }; // V23a: a real local sound activity, absent when none is running
  clips: { read: number; total: number };   // clips fully read (stills + transcript), for "3 of 12 clips read"
  etaS: number | null;             // the processing clock's measured overall estimate; null when it has none yet
  ideasReady: number;              // ideas that exist now
  ideasDone: boolean;              // the ideas stage has finished: the room may say "Found something good."
  editsMaking: number;             // first edits still being assembled
  complete: boolean;               // all processing finished
}

// C1: caption presets (VEED/Submagic-style gallery + tweaks). Pure data: no model call to
// apply or preview. Key words come from the titles call (TitleTrack.emphasis) when titles are on.
export interface CaptionStyle {
  preset: string;                               // "clean" | "karaoke" | "box" | "impact" | "punch" | "glide" | "pulse" | "typewriter" | "handwritten" | "bubble" | "minimal" | "lower-third" | "custom"
  primary: string;                              // text colour, #rrggbb
  accent: string;                               // key word / active word colour, #rrggbb
  font: string;                                 // a bundled family
  size: "s" | "m" | "l";
  position: "bottom" | "lower" | "middle" | "top";  // always inside the safe area, nudged off the face. CAP4: lower = lower middle (Film)
  wordsPerLine: "1-2" | "3-4" | "line";
  case: "as-spoken" | "upper" | "lower";
  background: "none" | "box" | "pill";
  outline: boolean;
  animation: "none" | "pop" | "glide" | "karaoke" | "box-highlight" | "typewriter" | "pulse" | "fade";  // CAP4: fade = a soft fade in and out, no word pop (Film)
  emphasis: boolean;                            // highlight the key words (from the titles call); captions-only edits: one small cached call
  hook?: "auto" | "off" | "all";               // J1: big kinetic captions. auto (default for new edits) = precut makes the opening punch line big, then normal captions; all = kinetic throughout; off = never
  hookStyle?: "build-up";                       // 25 Oct: the opening caption's style (src/main/titles/opening.ts); absent = build-up. Ready for a style picker
  accentAs?: CaptionAccentForm;                 // CAP4: how a stressed (accented) word stands out; absent = colour. A word's own accentAs beats it
  effect?: CaptionTextEffect;                   // CAP4: optional text effect, never in a preset or default; absent = none. Recorded for OPN1's titles too
}
// CAP4: the stressed word changes shape, not only colour. colour = the accent colour (before CAP4, the only form);
// italic, caps and bigger keep the primary colour; tag = an accent fill behind the word that wipes on as it is said.
export type CaptionAccentForm = "colour" | "italic" | "caps" | "bigger" | "tag";
// CAP4 (31 Oct): extruded depth, a soft text shadow and blur in are allowed as an option he picks, off by default.
export type CaptionTextEffect = "none" | "depth" | "shadow" | "blur-in";

// D8: what the person asked for while (or after) precut works. Each request becomes its own ideas and,
// when the footage can carry it, an edit; automatic suggestions still happen alongside.
export interface ShootRequest {
  fromIdea?: { messageId: string; index: number }; // V11: the exact saved idea this request drafts
  id: string;
  text: string;
  at: string;
  state: "queued" | "working" | "done" | "failed";
  ideaIds: string[];                             // ideas made for it
  cutIds: string[];                              // edits made for it
  error?: string;                                // plain words when it failed
  note?: string;                                 // D8: the model's own words when it finished without an edit (e.g. what to film)
}

// V27: defaults to on; optional for older settings.
export interface Preferences { autoCorrectNewEdits?: boolean }

// V24: independent saved lane faders; source clip gain remains unchanged.
export type SoundLane = "clip-sound" | "voice" | "music" | "effects";
export interface CutVersion {
  clipSoundDefaultOn?: boolean;
  laneLevels?: Partial<Record<SoundLane, number>>;
  laneMuted?: Partial<Record<SoundLane, boolean>>;
}
export interface LiveSound {
  laneLevels?: Partial<Record<SoundLane, number>>;
  laneMuted?: Partial<Record<SoundLane, boolean>>;
}
// PAR1: the export's master stage for this sound (gain on the premix, limiter ceiling), once its sound is prepared.
export interface LiveSound { master?: { gainDb: number; ceiling: number; dynamic?: boolean } | null }
export interface Preferences { clipSoundNewEdits?: { on: boolean; db: number } }

// AV1: the Apple player choice. Absent or false keeps the Chrome viewer.
export interface Preferences { playback?: { applePlayer?: boolean } }
export interface AppleSetEditRequest {
  timeline: DraftTimeline | null;
  player: "apple" | "chrome";
  reason: string;
  appleEnabled: boolean;
  rotations?: Record<string, number>;
  at?: number;
  // AV1b: the placed voice exactly as the Chrome viewer schedules it (liveTimeline.voicePlayback), so both players hear one plan.
  voice?: { id: string; url: string; startS: number; endS: number; offset: number; fadeInS: number; fadeOutS: number }[];
  // AV2: the Look the viewer is showing (each piece's table and numbers, the finish), so the Apple compositor draws the same.
  look?: import("./apple-playback").AppleLookPayload;
  // AV3: when the page sent this plan (epoch ms), so an edit is timed from the page to the Apple picture.
  sentAt?: number;
  // AV4: each picture piece's layer plan as the viewer draws it (layouts, masks, backgrounds, dissolves, blur), by piece index.
  layers?: (import("./apple-playback").AppleLayerPlan | null)[];
}
export interface ApplePlaybackReply { player: "apple" | "chrome"; reason: string; appleEnabled: boolean }
// AV1b: `display` (ready: the first picture is up), `opening` and `holds` (smoothness), `seekShown` (ms) join the AV1 events.
export interface AppleEvent { type: string; time?: number; playing?: boolean; message?: string; frames?: number; durationS?: number; ready?: boolean; ms?: number; expected?: number; maxHoldMs?: number }

// V26: source timings are guaranteed by main; the final endpoint is the exact edit target.
export interface CutMusicPlan {
  key: string; trackIdentity: string; musicChoice: string; outputSignature: string;
  summary: string; durationS: number;
  musicStory?: { reason: string; durationS: number; beats: { atS: number; endS: number; words: string; id: string }[] };
  outputStorySignature?: string;
  piecesSignature?: string;
  onBeatCount?: number; totalCuts?: number; offsetFrames?: number;  // V61: best-effort counts and the early cut offset in frames
  cuts: { index: number; piece: number; beforeS: number; atS: number; beatS: number; bar: boolean; hit: boolean; reason: string; onBeat?: boolean; offsetFrames?: number }[];
}
