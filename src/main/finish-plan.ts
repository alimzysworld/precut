import { defaultAngles, validateAngles, anglesReadme } from './angles';
// A first-cut finish is data from the existing cut call, never another AI turn.
import type { CutVersion, FramingChoice, FramingMode, Preferences, Shoot, TransitionKind, TransitionSound } from "../shared/schema";
import type { StoredVersion } from "./sidekick";
import type { MusicTrack } from "./reel";
import { resolveReelPieces, snapReelCuts } from "./reel";
import { fxReadme, planFx, syncFxMetadata, validJoinAudio } from "./edits-fx";
import { motionReadme } from "./framing";
import { kineticWordCatalog } from "./titles/kinetic";
import { readMotion, shakeCorrections } from "./motion";
import { validateLayout, seedMissingLayouts, layoutReadme } from './layouts';
import { isScreenClip } from './layout-math';
import { withPieceLayout } from '../shared/layout-presets';

// Exhaustive maps make contract additions a type error instead of stale prose.
const kinds = { cut: true, snap: true, ease: true, zoom: true, whip: true, dissolve: true, ramp: true } satisfies Record<TransitionKind, true>;
const sounds = { whoosh: true, hit: true, pop: true, riser: true } satisfies Record<TransitionSound, true>;
const modes = { off: true, steady: true, face: true } satisfies Record<FramingMode, true>;
const energies = { off: true, subtle: true, punchy: true } satisfies Record<NonNullable<CutVersion["energy"]>, true>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const member = <T extends string>(choices: Record<T, true>, v: unknown): v is T => typeof v === "string" && Object.hasOwn(choices, v);
const round = (v: number) => Math.round(v * 1000) / 1000;

// Keep per-second measurements, using rounded numbers instead of dense tracks.
export async function finishCatalog(root: string, shoot: Shoot, music: MusicTrack[]) {
  const clips = [];
  for (const clip of shoot.clips) {
    const motion = await readMotion(root, clip); // Cached only. Do not start analysis for a cut call.
    const jitter = new Map<number, number[]>();
    if (motion) for (const p of shakeCorrections(motion.samples)) {
      const second = Math.floor(p.t), values = jitter.get(second) ?? [];
      values.push(Math.hypot(p.x, p.y) * 320 / motion.width); jitter.set(second, values);
    }
    const faces = (clip.subject?.samples ?? []).filter(p => p.kind === "face" && [p.x, p.y].every(Number.isFinite));
    clips.push({ id: clip.id, jitter320Px: clip.shake?.measured ? clip.shake.perSecond.map(round) : null,
      motionJitter320Px: motion ? [...jitter.values()].map(a => round(a.reduce((s, n) => s + n, 0) / a.length)) : null,
      faceDrift: faces.length ? { x: round(Math.max(...faces.map(p => p.x)) - Math.min(...faces.map(p => p.x))),
        y: round(Math.max(...faces.map(p => p.y)) - Math.min(...faces.map(p => p.y))) } : null });
  }
  // Lossless millisecond delta runs keep long, regular beat grids compact.
  const beats = (values: number[]) => {
    const ms = values.filter(finite).map(n => Math.round(n * 1000)), runs: [number, number][] = [];
    for (let i = 1; i < ms.length; i++) {
      const delta = ms[i] - ms[i - 1], last = runs.at(-1);
      if (last?.[0] === delta) last[1]++; else runs.push([delta, 1]);
    }
    return { unit: "ms", first: ms[0] ?? null, deltaRuns: runs };
  };
  const { soundLibrary } = await import("./sound-design");
  const sfx = (await soundLibrary({ bundledOnly: true })).map(({ id, name, kind, lengthS, category, tags, hitS, role }) => ({ id, name, kind, lengthS, category, tags, hitS, role }));
  return { sfx, choices: { transitions: Object.keys(kinds), sounds: Object.keys(sounds), framing: Object.keys(modes), energy: Object.keys(energies) },
    coverAtS: "offset from the start of the finished piece in seconds", clips,
    screens: shoot.clips.filter(isScreenClip).map(c => ({ clipId: c.id, durationS: c.meta?.durationS })),
    kineticWords: kineticWordCatalog(shoot),
    takes: shoot.takes.flatMap(t => t.attempts.flatMap((a, i) => a.measures ? [{ id: `L${t.lineIndex + 1}A${i + 1}`, ...a.measures }] : [])),
    angleGroups: shoot.angles ?? [],
    angles: "finish.angles: [{atS: reel seconds, clip: synced clip id}]. Use wide for setup, close for punch, screen for screen references. Sentence boundaries, at least 2 seconds between switches. Voice stays continuous.",
    music: music.map(t => ({ file: t.file, tempo: t.tempo, beats: beats(t.beats) })) };
}

function framing(value: unknown): FramingChoice | undefined {
  if (!object(value) || !member(modes, value.mode) || (value.tight !== undefined && (!finite(value.tight) || value.tight < 0 || value.tight > 1))) return;
  return { mode: value.mode, ...(value.tight !== undefined ? { tight: value.tight as number } : {}) };
}

/** Mutate only the new, unsaved version. Missing shots retain exact anchors. */
export async function applyFinishPlan(record: StoredVersion, raw: unknown, preferences: Pick<Preferences, "captions" | "output">,
  tracks: MusicTrack[]): Promise<{ captions?: boolean }> {
  if (raw === undefined) { seedMissingLayouts(record); const angles=defaultAngles(record); if(angles.length) record.angleCuts=angles; return {}; }
  const warn = (field: string) => record.warnings.push(`Ignored finish ${field}.`);
  if (!object(raw)) { warn("plan: expected an object"); seedMissingLayouts(record); return {}; }
  const pieces = record.pieces ?? [], { template } = record.assembly;
  if (Array.isArray(raw.layouts)) for (const entry of raw.layouts) {
    try {
      if (!object(entry)) throw new Error('expected a layout object');
      const piece = typeof entry.piece === 'number' ? entry.piece : pieces.findIndex(p => p.id === entry.piece);
      if (typeof entry.piece === 'string' && pieces.filter(p => p.id === entry.piece).length !== 1) throw new Error('unknown or ambiguous piece');
      const layout = validateLayout(entry as unknown as import('../shared/schema').LayoutChoice,record,piece);
      record.layouts = withPieceLayout(record.layouts,pieces.length,piece,layout);
    } catch (error) { warn(`layout: ${error instanceof Error ? error.message : 'invalid layout'}`); }
  }
  else if (raw.layouts !== undefined) warn('layouts: expected a list');
  seedMissingLayouts(record);
  if (record.layouts?.some(Boolean) && !record.assembly.reel.why.includes(layoutReadme)) record.assembly.reel.why += `\n\n${layoutReadme}`;
  const indexOf = (id: unknown) => typeof id === "string" && pieces.filter(p => p.id === id).length === 1 ? pieces.findIndex(p => p.id === id) : -1;
  const list = (value: unknown, field: string): unknown[] => {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    warn(`${field}: expected a list`); return [];
  };
  if (raw.framing !== undefined) {
    if (!object(raw.framing)) warn("framing: expected an object");
    else {
      if (raw.framing.default != null) {
        const choice = framing(raw.framing.default);
        if (choice) record.framing = choice; else warn("framing.default: invalid framing or closeness");
      }
      for (const entry of list(raw.framing.pieces, "framing.pieces")) {
        const index = object(entry) ? indexOf(entry.id) : -1, choice = object(entry) ? framing(entry.framing) : undefined;
        if (index < 0 || !choice) { warn("framing piece: unknown or ambiguous id, or invalid framing"); continue; }
        record.pieceFx = Array.from({ length: pieces.length }, (_, i) => record.pieceFx?.[i] ?? null);
        record.pieceFx[index] = { ...record.pieceFx[index], framing: choice };
      }
    }
  }
  if (raw.energy != null) {
    if (member(energies, raw.energy)) {
      // Use the hand-finish implementation, including punchy silence trimming.
      const { prepareEnergy } = await import("./finish");
      prepareEnergy(record, record.assembly, raw.energy, preferences.output.height);
    } else warn("energy: unknown level");
  }
  for (const entry of list(raw.joins, "joins")) {
    const index = object(entry) ? indexOf(entry.after) : -1;
    if (!object(entry) || index < 0 || index >= pieces.length - 1 || !member(kinds, entry.kind) ||
        !(entry.sound === undefined || entry.sound === null || member(sounds, entry.sound)) || !validJoinAudio(entry.audio)) {
      warn("join: unknown or ambiguous id, kind or sound, or no following piece"); continue;
    }
    record.joins = Array.from({ length: pieces.length - 1 }, (_, i) => record.joins?.[i] ?? null);
    record.joins[index] = { kind: entry.kind, sound: entry.sound as TransitionSound | null ?? null, ...(entry.audio === undefined ? {} : { audio: entry.audio }) };
    try { planFx(record.assembly.cutList, template.fps, record); }
    catch {
      record.joins[index] = null;
      warn("ramp: no measured room, using the automatic join");
    }
  }
  if (raw.jumpScales !== undefined) {
    const scales: (number | null)[] = [];
    for (const entry of list(raw.jumpScales, "jumpScales")) {
      const index = object(entry) ? indexOf(entry.piece) : -1;
      if (!object(entry) || index < 0 || !finite(entry.scale) || entry.scale < 1 || entry.scale > 1.18) { warn("jumpScales: choose a known piece and scale 1 to 1.18"); continue; }
      scales[index] = entry.scale;
    }
    (record as StoredVersion & { jumpScales?: (number | null)[] }).jumpScales = Array.from({ length: pieces.length }, (_, i) => scales[i] ?? null);
  }
  if (raw.cutToBeat != null) {
    if (typeof raw.cutToBeat !== "boolean") warn("cutToBeat: expected true or false");
    else if (!record.music) warn("cutToBeat: no music");
    else {
      const music = record.music, track = tracks.find(t => t.file === music.file);
      if (raw.cutToBeat && !track?.beats.length) warn("cutToBeat: music has no measured beats");
      else {
        record.cutToBeat = raw.cutToBeat;
        if (raw.cutToBeat) {
          // A beat move must not invalidate a previously accepted silent ramp.
          const cuts = record.assembly.cutList.map(c => ({ ...c }));
          try {
            const snaps = snapReelCuts(cuts, template, track, music.startS, { nearest: true,
              boundary: (items, i) => { const fx = planFx(items, template.fps, record); return fx.items[i + 1]?.startS ?? fx.durationS; } });
            planFx(cuts, template.fps, record);
            record.assembly.cutList = cuts;
            record.assembly.reel.cuts = record.assembly.reel.cuts.map((c, i) => ({ ...c, ...snaps[i] }));
            record.pieces = resolveReelPieces(record.assembly.shoot, template, cuts, record.assembly.reel)
              .map((p, i) => ({ ...p, beatSnapS: snaps[i]?.beatDeltaS ?? 0 }));
          } catch { delete record.cutToBeat; warn("cutToBeat: beat placement leaves no room for the chosen ramp"); }
        }
      }
    }
  }
  const fx = planFx(record.assembly.cutList, template.fps, record);
  syncFxMetadata(record, fx);
  if ((record as StoredVersion & { energyBaseCuts?: unknown }).energyBaseCuts && record.cutToBeat) {
    (record as StoredVersion & { energyBaseCuts?: unknown }).energyBaseCuts = record.assembly.cutList.map(c => ({ ...c }));
  }
  if (raw.cover !== undefined) {
    if (raw.cover === null) record.cover = null;
    else {
      const index = object(raw.cover) ? indexOf(raw.cover.piece) : -1;
      const items = fx.items.filter(i => i.piece === index), start = items[0]?.startS, end = items.at(-1)?.endS;
      if (!object(raw.cover) || !finite(raw.cover.atS) || index < 0 || start === undefined || end === undefined || raw.cover.atS < 0 || raw.cover.atS >= end - start) {
        warn("cover: unknown or ambiguous piece, or frame outside the piece");
      } else record.cover = { t: start + raw.cover.atS, auto: false, title: null };
    }
  }
  if ((record.joins || record.cutToBeat) && !record.assembly.reel.why.includes(fxReadme)) record.assembly.reel.why += `\n\n${fxReadme}`;
  if ((record.framing || record.pieceFx?.some(f => f?.framing)) && !record.assembly.reel.why.includes(motionReadme)) record.assembly.reel.why += `\n\n${motionReadme}`;
  if (raw.kinetic !== undefined) {
    try {
      const { buildTitlesInput, seedKineticDesign } = await import("./titles");
      const input = buildTitlesInput(record.assembly.shoot, record, template, record.assembly.cutList, preferences.captions.safeArea, preferences.output.height);
      const { resolveKineticPlan } = await import("./titles/kinetic");
      const kinetic = seedKineticDesign(resolveKineticPlan(raw.kinetic, input.words, record.pieces!.map(p => p.id), kineticWordCatalog(record.assembly.shoot)), input);
      record.titles = { font: kinetic.font, cues: [], prompt: null, skillIds: [], kinetic } as import("./titles/captions").CaptionTrack;
    } catch (error) { warn(`kinetic: ${error instanceof Error ? error.message : "invalid design"}`); }
  }
  if (raw.sfx !== undefined) {
    const { validateSfx } = await import("./sound-design");
    const authored: import("../shared/schema").SfxItem[] = [];
    for (const [i, entry] of list(raw.sfx, "sfx").entries()) {
      try {
        if (!object(entry) || typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error("sound needs a reason");
        authored.push(validateSfx({ ...entry, id: `auto:plan:${i}`, auto: true } as import("../shared/schema").SfxItem, fx.durationS));
      } catch { warn("sfx: invalid sound, time, length, gain or reason"); }
    }
    record.soundDesign = { suppressed: record.soundDesign?.suppressed ?? [], authored };
  }
  const automaticAngles=defaultAngles(record);
  if (automaticAngles.length) record.angleCuts=automaticAngles;
  if (raw.angles !== undefined) {
    try {
      if (!Array.isArray(raw.angles)) throw new Error('expected a list');
      const cuts = validateAngles(raw.angles.map(c => ({atS:c.atS,clipId:c.clip})),record);
      if (cuts.some((c,i) => i>0 && c.atS-cuts[i-1].atS<2)) throw new Error('leave at least 2 seconds between automatic switches');
      record.angleCuts = cuts;
    } catch (error) { warn(`angles: ${error instanceof Error ? error.message : 'invalid switches'}`); }
  }
  if (record.angleCuts?.length && !record.assembly.reel.why.includes(anglesReadme)) record.assembly.reel.why += `\n\n${anglesReadme}`;
  if (raw.captions != null && typeof raw.captions !== "boolean") warn("captions: expected true or false");
  return typeof raw.captions === "boolean" ? { captions: preferences.captions.onByDefault && raw.captions } : {};
}
