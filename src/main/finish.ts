import { withShootWriter } from "./writer-lock";
import { planMusicCuts, musicCutSignature, refreshMusicCutReceipt, currentCutMusicPlan } from "./cut-to-music";
import { legacyBalanceVersion } from "../shared/clip-balance";
import { renderLatestLook } from "./look-saves";
import { retimeKinetic } from "./titles/captions";
import { captionDesignOfNote } from "./titles/design-notes";
// A finish is one transaction over a saved assembly, never a new edit/model cut.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Api, AudioFinish, Skill, SkillFormat } from "../shared/schema";
import { DEFAULT_AUDIO_FINISH, normalizeAudio } from "./audio";
import { normalizeBasic, validBasic } from "./basics";
import { gradeFromLook, gradeForLook, normalizeMixer, validMixer, validateMatchRef, exposureSpans, type LookPreference } from "./grade";
import { getPreferences } from "./settings";
import { normalizeDetail, detailReadme } from "../renderer/src/components/finish/detailMath";
import { normalizeGrain, normalizeVignette, grainReadme } from "../renderer/src/components/finish/grainMath";
import { designTitles, styleCaptions, rebuildSubtitles } from "./titles";
import { finishStoredVersion, renderStoredPreview, savePlaybackChange, PREVIEW_REV, withShootLock, cutFile, readCut, freshen, cacheRewriteAllowed } from "./sidekick";
import { renderFinishingPreview, finishingProgress } from "./preview";
import { energyReadme, tightenEnergyPauses, validFraming, framingChoice, motionReadme, type Energy } from "./framing";
import { framingMotion } from "./motion";
import { resolveReelPieces } from "./reel";
import { planFx, mapSource, mapTime, validJoin, retimeVersion, fxReadme } from "./edits-fx";
import type { CutItem } from "./export";
import type { StoredVersion } from "./sidekick";
import { listSkills } from "./skills";
import { runActivity, withRenderSlot } from "./activity";

type FinishOptions = NonNullable<Parameters<Api["finishCut"]>[3]> & { preset?: string; intensity?: number; captions?: import("../shared/schema").CaptionStyle | null };

// Private saved base spans let switching away from punchy restore its pauses.
// No source media or model decisions are changed, and repeated finishes do not
// keep shaving silence from the same saved assembly.
type EnergyVersion = StoredVersion & { energyBaseCuts?: CutItem[] };
export function energyTime(t: number, before: CutItem[], after: CutItem[], fps: number): number {
  const end = after.reduce((n, c) => n + c.durTimelineFrames / fps, 0);
  const index = before.findIndex(c => t < (c.offsetFrames + c.durTimelineFrames) / fps - 1e-7);
  if (index < 0) return end;
  const c = before[index], piece = c.piece ?? index;
  const matching = after.filter((a, i) => (a.piece ?? i) === piece && a.seg?.clip.id === c.seg?.clip.id);
  if (!matching.length) return Math.min(end, t);
  const sourceFps = c.clipFpsR.num / c.clipFpsR.den;
  const source = c.inFrames / sourceFps + Math.max(0, t - c.offsetFrames / fps);
  const next = matching.find(a => a.outFrames / sourceFps > source + 1e-7) ?? matching.at(-1)!;
  return next.offsetFrames / fps + Math.max(0, Math.min(next.durTimelineFrames / fps, source - next.inFrames / sourceFps));
}

export function prepareEnergy(record: EnergyVersion, assembly: StoredVersion["assembly"], energy: Energy, outputHeight: number): void {
  // Keep an accepted musical clock intact when delivery reapplies energy.
  if (record.cutMusicPlan?.outputSignature === musicCutSignature(record, assembly.cutList) && energy === record.energy) return;
  const before = assembly.cutList, fps = assembly.template.fps;
  const currentClips = new Map(before.flatMap(c => c.seg ? [[c.seg.clip.id, c.seg.clip] as const] : []));
  const base = (record.energyBaseCuts ?? before).map(c => c.seg ? {
    ...c, seg: { ...c.seg, clip: currentClips.get(c.seg.clip.id) ?? c.seg.clip },
  } : { ...c });
  if (energy === "punchy" && !record.energyBaseCuts) record.energyBaseCuts = base;
  const after = energy === "punchy" ? tightenEnergyPauses(base, fps, record.keptFillers) : base;
  const beforeFx = planFx(before, fps, record), afterFx = planFx(after, fps, record);
  const time = (t: number) => {
    const index = beforeFx.items.findIndex(item => t < item.endS - 1e-7);
    if (index < 0) return afterFx.durationS;
    const source = mapSource(beforeFx.items[index].timeMap, t), old = before[index];
    const candidates = after.map((c, i) => ({ c, i })).filter(({ c, i }) => (c.piece ?? i) === (old.piece ?? index) && c.seg?.clip.id === old.seg?.clip.id);
    const next = candidates.find(({ c }) => c.outFrames / (c.clipFpsR.num / c.clipFpsR.den) > source + 1e-7) ?? candidates.at(-1);
    return next ? mapTime(afterFx.items[next.i].timeMap, source) : Math.min(afterFx.durationS, t);
  };
  if (record.bigLines?.length || (record.titles as import("./titles/captions").CaptionTrack | undefined)?.kinetic) retimeKinetic(record, time);
  if (record.titles) record.titles = { ...record.titles, cues: record.titles.cues.map(c => ({
    ...c, s: time(c.s), e: time(c.e), words: c.words?.map(w => ({ ...w, s: time(w.s), e: time(w.e) })).filter(w => w.e > w.s),
  })).filter(c => c.e > c.s) };
  if (record.lowerThirds) record.lowerThirds = record.lowerThirds.map(o => ({ ...o, s: time(o.s), e: time(o.e) }));
  if (record.overlays) record.overlays = record.overlays.map(o => ({ ...o, s: time(o.s), e: time(o.e) }));
  assembly.cutList = after;
  record.energy = energy;
  record.lengthS = afterFx.durationS;
  const pieces = resolveReelPieces(assembly.shoot, assembly.template, after, assembly.reel);
  record.pieces = pieces.map((p, i) => { const items = afterFx.items.filter(c => c.piece === i); return items.length ? { ...p, timelineS: items[0].startS, lengthS: items.at(-1)!.endS - items[0].startS } : p; });
  assembly.reel = { ...assembly.reel, cuts: assembly.reel.cuts.map((c, i) => ({ ...c,
    offsetS: pieces[i]?.timelineS ?? time(c.offsetS), lengthS: pieces[i]?.lengthS ?? c.lengthS,
  })) };
  const { width, height } = assembly.template;
  const ratio = Math.min(outputHeight, width, height) / Math.min(width, height);
  const full = { w: Math.round(width * ratio / 2) * 2, h: Math.round(height * ratio / 2) * 2 };
  const draft = { w: 960, h: Math.round(960 * height / width / 2) * 2 };
  // The existing timeline exporter prints reel.why in README.txt.
  // Keep the note on the saved assembly rather than modifying export writers.
  const why = assembly.reel.why.replace(/\n\n\[Energy framing\][\s\S]*?\[\/Energy framing\]/g, "").replace(`\n\n${motionReadme}`, "");
  assembly.reel.why = `${why}\n\n[Energy framing]\n${energyReadme(after, fps, full, energy)}\nDraft preview:\n${energyReadme(after, fps, draft, energy)}\n[/Energy framing]`;
  if (after.some((c, i) => framingChoice(record, c.piece ?? i).mode !== "off") && !assembly.reel.why.includes(motionReadme)) {
    assembly.reel.why += `\n\n${motionReadme}`;
  }
  record.assembly = assembly;
}
function audioOptions(previous: AudioFinish | null | undefined, update?: Partial<AudioFinish>): AudioFinish {
  const audio = { ...DEFAULT_AUDIO_FINISH, ...previous, ...update };
  if (typeof audio.clean !== "boolean" || !Number.isFinite(audio.denoise) || audio.denoise < 0 || audio.denoise > 1 ||
      !Number.isFinite(audio.loudnessLUFS) || audio.loudnessLUFS < -70 || audio.loudnessLUFS > -5) {
    throw new Error("Choose a denoise strength from 0 to 1 and a loudness target from -70 to -5 LUFS.");
  }
  return normalizeAudio(audio);
}

async function lookGrade(root: string, text: string) {
  const dir = path.join(root, ".sidething", "finish-cache");
  // The look is independent of a camera profile. Conversion is per picture.
  const file = path.join(dir, `look-${createHash("sha256").update(`look-v1:${text}`).digest("hex")}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(file, "utf8"));
    if (cached.look === text && [cached.exposure, cached.contrast, cached.saturation, cached.temperature, cached.tint].every(Number.isFinite)) return cached;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  const grade = await gradeFromLook(text, "rec709", { cwd: root });
  await fs.mkdir(dir, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(grade)); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  return grade;
}

async function resolveLook(root: string, preference: LookPreference) {
  const grade = gradeForLook("rec709", preference);
  return preference.words?.trim() ? { ...await lookGrade(root, preference.words.trim()), preset: grade.preset, intensity: grade.intensity, ...(grade.basic ? { basic: grade.basic } : {}) } : grade;
}

export function reframeAspect(record: StoredVersion, assembly: StoredVersion["assembly"], aspect: SkillFormat["aspect"], skills: Skill[]): void {
  const sizes: Record<SkillFormat["aspect"], [number, number]> = {
    "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350],
  };
  if (!Object.hasOwn(sizes, aspect)) throw new Error("Choose 9:16, 16:9, 1:1 or 4:5 for the video format.");
  const matching = skills.find(s => s.format?.aspect === aspect && (s as Skill & { type?: string }).type !== "titles");
  const [width, height] = matching?.format ? [matching.format.width, matching.format.height] : sizes[aspect];
  const fps = assembly.template.fps; // Aspect never retimes an existing cut.
  const id = `aspect-${aspect.replace(":", "-")}-${width}x${height}-${fps}`;
  assembly.template = { ...assembly.template, id, name: `${aspect} ${width}x${height}`, width, height, drpPath: null };
  record.templateId = id;
  record.preview = null; record.finished = null;
  record.assembly = assembly;
}

async function applyMusicCutPlan(root: string, record: StoredVersion, assembly: StoredVersion["assembly"]) {
  const beforeCuts = assembly.cutList;
  const before = planFx(beforeCuts, assembly.template.fps, record);
  record.assembly = assembly;
  const { plan, cuts } = await planMusicCuts(root, record);
  assembly.cutList = cuts.map(c => ({ ...c }));
  record.cutToBeat = true; record.cutMusicPlan = plan;
  record.pieces = resolveReelPieces(assembly.shoot, assembly.template, assembly.cutList, assembly.reel);
  const after = planFx(assembly.cutList, assembly.template.fps, record);
  retimeVersion(record, before, after);
  if (record.titles && cuts.some((c,i)=>(record.voiceover || c.seg?.lineIndex !== null) && (c.inFrames!==beforeCuts[i].inFrames || c.outFrames!==beforeCuts[i].outFrames))) record.titles = await rebuildSubtitles(assembly.shoot, record, assembly.template, assembly.cutList, true);
  assembly.reel.cuts = assembly.reel.cuts.map((c, i) => {
    const piece = record.pieces?.[i], entry = plan.cuts.find(e => e.piece === i);
    return { ...c, s: piece?.s ?? c.s, e: piece?.e ?? c.e, offsetS: piece?.timelineS ?? c.offsetS,
      lengthS: piece?.lengthS ?? c.lengthS, beatDeltaS: entry ? entry.atS - entry.beforeS : 0, beatS: entry?.beatS ?? null };
  });
  if ((record as EnergyVersion).energyBaseCuts) (record as EnergyVersion).energyBaseCuts = assembly.cutList.map(c => ({ ...c }));
  record.previewRev = PREVIEW_REV;
  refreshMusicCutReceipt(record);
  record.feedback = plan.summary;
}

export function finishCut(root: string, cutId: string, version: number, opts: FinishOptions = {}): Promise<{ cutId: string; version: number }> {
  root = path.resolve(root);
  // A look choice is already on the stage when it is saved, so its save is named apart and kept out of the status line.
  const lookKeys = new Set(["filmFade", "preset", "intensity", "basic", "matchClips", "matchRef", "mixer", "detail", "grain", "vignette"]);
  const keys = Object.keys(opts).filter(key => opts[key as keyof FinishOptions] !== undefined);
  const lookOnly = keys.length > 0 && keys.every(key => lookKeys.has(key));
  const soundOnly = keys.length > 0 && keys.every(key => key === "music" || key === "audio" || key === "cutToBeat");
  const save = (base: number) => runActivity({ kind: "finish", root, target: { cutId, version }, label: soundOnly ? "Saving sound" : lookOnly ? "Saving your look" : "Saving edit", cancelable: true }, activity => {
    activity.progress(null, "Waiting");
    // Acquire the existing shoot lock before the global media slot. An edit
    // holding that lock may still need to render its own draft.
    return finishStoredVersion(root, cutId, base, true, async (record, assembly, baseVersion) => {
      const musicDuration = opts.music ? await (await import("./music-bounds")).validateMusicBounds(root, opts.music) : undefined;
      if (soundOnly) {
        if (opts.cutToBeat !== undefined && typeof opts.cutToBeat !== "boolean") throw new Error("Choose whether to cut to the music.");
        if (opts.music && [opts.music.fit,opts.music.followStory].some(v=>v!==undefined && typeof v!=="boolean")) throw new Error("Choose whether music fits and follows the edit.");
        if (opts.music?.stemDucking !== undefined && typeof opts.music.stemDucking !== "boolean") throw new Error("Choose whether to keep the beat.");
        if (opts.music?.duckDepthDb !== undefined && (!Number.isFinite(opts.music.duckDepthDb) || opts.music.duckDepthDb < 0 || opts.music.duckDepthDb > 24)) throw new Error("Choose a music dip between 0 and 24 dB.");
        if (opts.music != null && (typeof opts.music.file !== "string" || !opts.music.file.trim() || !Number.isFinite(opts.music.startS) || opts.music.startS < 0 || !Number.isFinite(opts.music.gainDb) || typeof opts.music.duck !== "boolean")) throw new Error("Choose a music track, nonnegative start, gain and duck setting.");
        record.assembly = assembly;
        record.audio = audioOptions(record.audio, opts.audio);
        if (opts.music !== undefined) {
          record.music = opts.music ? { ...opts.music, fit: opts.music.fit ?? record.music?.fit ?? (record.music?.file !== opts.music.file ? true : undefined), followStory: opts.music.followStory ?? record.music?.followStory, stemDucking: opts.music.stemDucking ?? record.music?.stemDucking, duckDepthDb: opts.music.duckDepthDb ?? record.music?.duckDepthDb } : null;
          assembly.reel = { ...assembly.reel, music: record.music ? { ...assembly.reel.music, ...record.music, gainDb: record.music.gainDb ?? -18, durationS: musicDuration ?? record.lengthS, musicLUFS: assembly.reel.music?.musicLUFS ?? -16 } : undefined };
        }
        if (opts.cutToBeat === false || opts.music !== undefined && record.cutToBeat && !currentCutMusicPlan(record)) record.cutToBeat = false;
        // These are live graph parameters. Cleanup is cached per source by
        // liveSound when the next plan is read; saving never prepares media.
        record.previewRev = PREVIEW_REV;
        record.feedback = "Updated sound";
        if (opts.cutToBeat === true) await applyMusicCutPlan(root, record, assembly);
        return { cutId, version: record.version, baseVersion };
      }
      // Validate fixed settings before any requested paid design turn.
      if (opts.filmFade !== undefined && (!Number.isFinite(opts.filmFade) || opts.filmFade < 0 || opts.filmFade > 100)) throw new Error("Choose Fade from 0 to 100.");
      if (opts.basic != null && !validBasic(opts.basic)) throw new Error("Choose valid Basic adjustments.");
      if (opts.matchClips !== undefined && typeof opts.matchClips !== "boolean") throw new Error("Choose whether to match clips.");
      validateMatchRef(opts.matchRef);
      if (opts.matchRef != null && !exposureSpans(assembly.cutList, assembly.reel.broll, assembly.template.fps).some(s => s.pieceIndex === opts.matchRef)) throw new Error("Choose a reference clip in this edit.");
      if (opts.mixer != null && !validMixer(opts.mixer)) throw new Error("Choose valid colour mixer adjustments.");
      if (opts.faceMatch !== undefined && !["off", "snap", "ease"].includes(opts.faceMatch)) throw new Error("Choose off, snap or ease face matching.");
      if (opts.framing !== undefined && !validFraming(opts.framing)) throw new Error("Choose off, steady or face framing, with closeness from 0 to 1.");
      if (opts.music && [opts.music.fit,opts.music.followStory].some(v=>v!==undefined && typeof v!=="boolean")) throw new Error("Choose whether music fits and follows the edit.");
      if (opts.music?.stemDucking !== undefined && typeof opts.music.stemDucking !== "boolean") throw new Error("Choose whether to keep the beat.");
      if (opts.music?.duckDepthDb !== undefined && (!Number.isFinite(opts.music.duckDepthDb) || opts.music.duckDepthDb < 0 || opts.music.duckDepthDb > 24)) throw new Error("Choose a music dip between 0 and 24 dB.");
      if (opts.music != null && (typeof opts.music.file !== "string" || !opts.music.file.trim() || !Number.isFinite(opts.music.startS) || opts.music.startS < 0 || !Number.isFinite(opts.music.gainDb) || typeof opts.music.duck !== "boolean")) throw new Error("Choose a music track, nonnegative start, gain and duck setting.");
      if (opts.transition !== undefined && !validJoin(opts.transition)) throw new Error("Choose a valid transition and sound.");
      if (opts.cutToBeat !== undefined && typeof opts.cutToBeat !== "boolean") throw new Error("Choose whether to cut to beat.");
      const detail = opts.detail === undefined ? undefined : normalizeDetail(opts.detail, record.grade?.detail);
      const grain = opts.grain === undefined ? undefined : normalizeGrain(opts.grain, record.grade?.grain);
      const vignette = opts.vignette === undefined ? undefined : normalizeVignette(opts.vignette, record.grade?.vignette);
      const beforeFx = planFx(assembly.cutList, assembly.template.fps, record);
      record.assembly = assembly;
      if (opts.transition !== undefined) record.transition = { ...opts.transition };
      if (opts.cutToBeat !== undefined) record.cutToBeat = opts.cutToBeat;
      record.audio = audioOptions(record.audio, opts.audio);
      if (opts.faceMatch !== undefined) record.faceMatch = opts.faceMatch;
      if (opts.framing !== undefined) record.framing = { ...opts.framing };
      if (opts.music !== undefined) {
        record.music = opts.music ? { ...opts.music, fit: opts.music.fit ?? record.music?.fit ?? (record.music?.file !== opts.music.file ? true : undefined), followStory: opts.music.followStory ?? record.music?.followStory, stemDucking: opts.music.stemDucking ?? record.music?.stemDucking, duckDepthDb: opts.music.duckDepthDb ?? record.music?.duckDepthDb } : null;
        assembly.reel = { ...assembly.reel, music: opts.music ? { ...assembly.reel.music, ...opts.music, durationS: musicDuration ?? record.lengthS, musicLUFS: assembly.reel.music?.musicLUFS ?? -16 } : undefined };
      }
      const energy = opts.energy ?? record.energy ?? "subtle";
      if (!["off", "subtle", "punchy"].includes(energy)) throw new Error("Choose off, subtle or punchy energy.");
      if (opts.aspect !== undefined) reframeAspect(record, assembly, opts.aspect, await listSkills());
      activity.progress(null, "Preparing framing and audio");
      retimeVersion(record, beforeFx, planFx(assembly.cutList, assembly.template.fps, record));
      prepareEnergy(record, assembly, energy, (await getPreferences()).output.height);
      const beforeBeat = planFx(assembly.cutList, assembly.template.fps, record);
      if (opts.cutToBeat === true) await applyMusicCutPlan(root, record, assembly);
      const afterFx = planFx(assembly.cutList, assembly.template.fps, record);
      if (opts.cutToBeat !== true) retimeVersion(record, beforeBeat, afterFx);
      if ((opts.transition !== undefined || opts.cutToBeat !== undefined) && !assembly.reel.why.includes(fxReadme)) assembly.reel.why += `\n\n${fxReadme}`;
      await framingMotion(root, [...assembly.cutList, ...assembly.reel.broll.map(o => ({ piece: o.voiceIndex, seg: o.seg }))], record);
      finishingProgress(root, cutId, 0);
      if (opts.look !== undefined || opts.preset !== undefined || opts.intensity !== undefined || (!record.grade && opts.aspect === undefined && opts.basic === undefined && opts.matchClips === undefined && opts.matchRef === undefined && opts.mixer === undefined && opts.music === undefined && opts.faceMatch === undefined && opts.framing === undefined && opts.audio === undefined && opts.transition === undefined && opts.cutToBeat === undefined && opts.grain === undefined && opts.vignette === undefined && opts.detail === undefined && opts.filmFade === undefined)) {
        const previous = record.grade;
        const defaults = (await getPreferences()).look;
        const explicit = opts.look !== undefined || opts.preset !== undefined || opts.intensity !== undefined;
        const preference: LookPreference = explicit ? {
          preset: opts.preset ?? previous?.preset ?? defaults.preset,
          words: opts.look !== undefined ? opts.look : opts.preset !== undefined ? null : previous?.look ?? defaults.words,
          intensity: opts.intensity ?? (previous as { intensity?: number } | null)?.intensity ?? defaults.intensity,
          basic: previous?.basic ?? defaults.basic,
        } : defaults;
        activity.progress(null, "Applying the look");
        record.grade = { ...await resolveLook(root, preference), ...(previous?.matchClips !== undefined ? { matchClips: previous.matchClips } : {}), ...(previous?.matchRef !== undefined ? { matchRef: previous.matchRef } : {}), ...(previous?.mixer ? { mixer: previous.mixer } : {}), ...(previous?.grain !== undefined ? { grain: previous.grain } : {}), ...(previous?.vignette !== undefined ? { vignette: previous.vignette } : {}), ...(previous?.detail !== undefined ? { detail: previous.detail } : {}), ...(previous?.filmFade !== undefined ? { filmFade: previous.filmFade } : {}) };
      }
      if (opts.filmFade !== undefined) record.grade = { ...(record.grade ?? gradeForLook("rec709", (await getPreferences()).look)), filmFade: opts.filmFade };
      // Basics alone keeps the saved look/custom controls and never resolves words.
      if (opts.basic !== undefined) {
        record.grade = { ...(record.grade ?? gradeForLook("rec709", (await getPreferences()).look)), basic: normalizeBasic(opts.basic) };
      }
      if (opts.matchClips !== undefined || opts.matchRef !== undefined || opts.mixer !== undefined) record.grade = {
        ...(record.grade ?? gradeForLook("rec709", (await getPreferences()).look)),
        ...(opts.matchClips !== undefined ? { matchClips: opts.matchClips } : {}),
        ...(opts.matchRef !== undefined ? { matchRef: opts.matchRef } : {}),
        ...(opts.mixer !== undefined ? { mixer: normalizeMixer(opts.mixer) } : {}),
      };
      if (grain !== undefined || vignette !== undefined || detail !== undefined) {
        record.grade = { ...(record.grade ?? gradeForLook("rec709", (await getPreferences()).look)),
          ...(detail !== undefined ? { detail } : {}), ...(grain !== undefined ? { grain } : {}), ...(vignette !== undefined ? { vignette } : {}) };
      }
      assembly.reel.why = assembly.reel.why.replace(/\n\n\[Film fade\][\s\S]*?\[\/Film fade\]/g, "");
      if (record.grade?.filmFade) assembly.reel.why += `\n\n[Film fade]\nFade: ${record.grade.filmFade}. Film fade appears in the finished video. Resolve keeps original ungraded picture; reapply this value there.\n[/Film fade]`;
      assembly.reel.why = assembly.reel.why.replace(/\n\n\[Detail\][\s\S]*?\[\/Detail\]/g, "");
      if (record.grade?.detail) assembly.reel.why += `\n\n[Detail]\n${detailReadme}\n${JSON.stringify(record.grade.detail)}\n[/Detail]`;
      const textureNote = /\n\n\[Grain and vignette\][\s\S]*?\[\/Grain and vignette\]/g;
      assembly.reel.why = assembly.reel.why.replace(textureNote, "");
      if (record.grade?.grain || record.grade?.vignette) assembly.reel.why += `\n\n[Grain and vignette]\n${grainReadme}\n${JSON.stringify({ grain: record.grade.grain ?? null, vignette: record.grade.vignette ?? null })}\n[/Grain and vignette]`;
      if(opts.matchRef!==undefined)record.balanceReference=legacyBalanceVersion({...record,grade:{...record.grade!,matchClips:true}}).balanceReference;
      if (opts.basic !== undefined || opts.matchClips !== undefined || opts.matchRef !== undefined) {
        // The Resolve writer includes reel.why in its README. Its original
        // picture is ungraded, so make these finishing-only changes explicit.
        const note = "Colour adjustments and clip matching appear in the finished video. Resolve uses original ungraded picture; reapply these adjustments there.";
        if (!assembly.reel.why.includes(note)) assembly.reel.why += `\n\n${note}`;
      }
      if (!record.grade && (opts.audio !== undefined || opts.music !== undefined || opts.faceMatch !== undefined)) {
        record.grade = gradeForLook("rec709", (await getPreferences()).look);
      }
      if (opts.titles === null) record.titles = null;
      else if (opts.titles !== undefined) { activity.update({ label: "Updating titles" }); await designTitles(root, cutId, version, opts.titles); }
      if (opts.captions !== undefined) activity.update({ label: "Updating captions" });
      if (opts.captions === null && record.titles) {
        record.titles = { ...record.titles, cues: record.titles.cues.filter(c => c.role !== "subtitle" && !c.id.startsWith("kinetic-")) };
      } else if (opts.captions) record.titles = await styleCaptions(root, assembly.shoot, record, assembly.template, assembly.cutList, opts.captions, opts.captions.hook !== undefined && opts.captions.hook !== record.titles?.captionStyle?.hook
        || opts.captions.hookStyle !== undefined && opts.captions.hookStyle !== (record.titles?.captionStyle?.hookStyle ?? "build-up")
        // 0.7.1: Retry under "Couldn't design the opening caption" asks the designer again with the same style.
        || ((record.titles as { warnings?: string[] } | null | undefined)?.warnings ?? []).some(note => captionDesignOfNote(note) === "opening"));
      if (opts.cutToBeat !== true && record.cutMusicPlan && !currentCutMusicPlan(record)) record.cutToBeat = false;
      if (opts.cutToBeat === true) refreshMusicCutReceipt(record);
      record.feedback = opts.cutToBeat === true ? record.cutMusicPlan!.summary : "Updated finishing";
      activity.update({ label: lookOnly ? "Saving your look" : "Saving edit" });
      activity.progress(null, "Rendering the draft");
      await renderStoredPreview(root, cutId, record, assembly);
      finishingProgress(root, cutId, 100);
      return { cutId, version: record.version, baseVersion };
    }, true);
  });
  // These controls target the edit as a whole, including when its pictures changed meanwhile.
  return savePlaybackChange(root, cutId, version, save, () => cutId);
}

export function renderFinished(root: string, cutId: string, version: number): Promise<{ file: string }> {
  root = path.resolve(root);
  return renderLatestLook(root, cutId, version, latest => renderFinishedSnapshot(root, cutId, latest));
}

function renderFinishedSnapshot(root: string, cutId: string, version: number): Promise<{ file: string }> {
  return runActivity({ kind: "render", root, target: { cutId, version }, label: "Rendering finished video", cancelable: true }, activity => {
    activity.progress(null, "Waiting");
    return withShootWriter(root, () => withShootLock(cutFile(root, cutId), () => withRenderSlot(activity, async () => {
      const previous = (await readCut(root, cutId)).versions.find(v => v.version === version);
      if (!previous?.assembly) throw new Error("Could not find that edit version's saved assembly.");
      const assembly = await freshen(root, structuredClone(previous.assembly));
      const prepared = { ...structuredClone(previous), assembly };
      activity.progress(null, "Preparing framing and audio");
      prepareEnergy(prepared, assembly, prepared.energy ?? "subtle", (await getPreferences()).output.height);
      if (!prepared.grade) prepared.grade = await resolveLook(root, (await getPreferences()).look);
      await (await import("./sound-design")).refreshSoundDesign(root, prepared);
      // The finished file is cache. Any editorial preparation it required gets
      // its own explicit-base snapshot; an already prepared edit keeps its number.
      const create = !cacheRewriteAllowed(previous, prepared);
      return finishStoredVersion(root, cutId, version, create, async record => {
        const identity = { version: record.version, baseVersion: record.baseVersion, createdAt: record.createdAt };
        Object.assign(record, prepared, identity);
        // The renderer and saved revision use this exact prepared voice clock.
        if (create && record.voiceover) record.voiceover = { ...record.voiceover, version: record.version };
        const file = await renderFinishingPreview(root, assembly.cutList, {
          name: `${cutId}-v${record.version}`, template: assembly.template, version: record, reel: assembly.reel, full: true,
        });
        await (await import("./export")).writeExportCover(root, cutId, record, path.dirname(file), file);
        await (await import("./translate")).writeDeliveryText(root, record, path.dirname(file), path.basename(file, path.extname(file)));
        record.finished = file;
        return { file };
      });
    })));

  }, { deferRenderSlot: true });
}
