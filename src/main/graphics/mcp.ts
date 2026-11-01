import type { CutEdit, MotionGraphic, OverlayItem } from "../../shared/schema";
import { GRAPHIC_LIMITS } from "./sanitize";
import { graphicTemplates, graphicSource, buildFromTemplate, CARD_TEMPLATE, graphicMotion, setGraphicMotion, NO_MOTION } from "./templates";
import { ICON_NAMES } from "./icons";
import { defaultPlacement, fitGraphicToSpan, fullScreenOver, graphicFromRequest, graphicTheme, underFullScreen } from "./edit";
import { SCENE_TEMPLATES } from "./scenes";
import { beatLabel, beatLength, beatPosition, dedupeBeats, motionWords, wordsInSpan, type MotionChange, type MotionContext } from "../../shared/motion";
import { standardFrameRate } from "../../shared/frame-rate";

const KEY_WORD = "key-word";   // PRO5

// GFX1: the editing agent's hands on the graphics engine. Same handlers as the app: every change is one undoable version.
const RULES = [
  "A graphic is a pure function of time: the renderer sets t (seconds since it began) for every frame, live and in export, so scrubbing is exact.",
  "composition.html is the inside of one root element (#gfx); size it with %, vmin or calc(var(--u) * n), where --u is 1% of the shorter side. Positions are relative to its own box.",
  "composition.css: animate with CSS animations and transitions (they are driven by t, paused and seeked), or use the custom property --t (seconds) and --p (0 to 1 over the duration) in calc().",
  "composition.js (optional) must define render(t, el), called for every frame with t and the #gfx element. Use only t: no Date, performance, timers, requestAnimationFrame or Math.random (they are replaced or removed).",
  "No network, no storage, no external files: images must be data: images inside the html or css. Fonts are the bundled ones only: Outfit, Inter Display, Montserrat, Poppins, Bebas Neue, Archivo Black, Caveat.",
  `Limits: html ${GRAPHIC_LIMITS.html / 1000} KB, css ${GRAPHIC_LIMITS.css / 1000} KB, js ${GRAPHIC_LIMITS.js / 1000} KB, durations to ${GRAPHIC_LIMITS.durationS} s. A frame that takes more than a second or two to draw stops the graphic.`,
  "frame: overlay = transparent, drawn over or beside the person at x, y, w; full = replaces the picture while it is on. layer behind = the person passes in front (overlay only).",
  "Style: one type family, generous space, one accent, short ease-out moves, no bouncing, nothing flashing. Use var(--accent), var(--ink), var(--surface), var(--on), var(--font) for the edit's look.",
  "House rules for cards and anything around a picture: no shadow, glow, blur, outline, ring, border or stroke; show emphasis with a soft fill. Sentence case. Real content only: no invented numbers, names, UI or placeholder text or bars.",
  "A card for something on a screen (a screen recording, a screenshot, a photo from the shoot) is made with add_card, never add_graphic: it uses the real picture and checks its stamp against what the person says.",
  "TRK1b, pinning: pin_graphic locks a graphic (or a designed title) to a thing in the shot, so it moves, scales and fades with it. Pin only when the thing is clearly visible and moving, or the camera moves; one pin per edit unless he asks for more. Put the word on clear surface (the label on a cup, the blank part of a sign), never over hands or faces: use offset to move it off them. When the result says lost, say it plainly and offer to trim the graphic to the part that holds.",
  "TRK2, flat things and locked frames: a word on a screen, a sign or paper is pin_graphic with the thing's four corners (surface flat): it is printed onto the surface in perspective and kept inside its inner 60%, white on a screen. lock_on steadies the picture on a thing (a held payoff, never every shot); it zooms just enough to keep the frame full, up to max zoom (1.25x by default). Say its note to him as it comes (\"Locked as far as 1.25x zoom allows; a full lock needs 1.51x.\") and let him choose to raise max zoom with update_lock; never raise it on your own.",
  `PRO5, a key word behind the person: add_graphic with template "${KEY_WORD}", params {text, accent}, layer "behind", the time he says it, and x, y, w so the word sits behind his head (his head and hair overlap part of it, the rest stays readable). Which word is your call: the one he stresses, rarely, never every line. precut measures his outline on those frames (clean edge, steady, not covering most of the word); when it can't hold up, the word goes in front and the result (and the item's label) says why in plain words. Switch it with update_graphic patch {layer}.`,
  "MOT1b, anything that moves (a scene's words, lines, tiles and flashes): read it with get_motion, fine-tune it with set_motion (when each element lands, by word, beat or seconds; style, strength, push, hold, beat offset, grid, keep order). Never by rewriting composition code or resending params for a timing change.",
  "One change per ask: change exactly what was asked (\"the second word half a beat later\" is one element, shiftBeats 0.5), then say what changed in plain words, as set_motion's changed and notes give it.",
  "LOOK1, a scene's look (its background, type and finish): read it with get_scene_look, change it with set_scene_look (the background from the shot, a gradient with shuffle, a design you write as html and css, an image from his footage, a flat colour; the dim, auto by default, keeps the words at 4.5:1; type font, weight, case, colour, size; grain, vignette, push). all true for every scene. Never by rewriting a scene's code. A new scene already sits on his shot, or on the look the edit's scenes share.",
];
const SCENES_NOTE = "Scenes (full-screen, made of his words and his frames) are added with add_scene (SCN1b, coming) and edited here: update_graphic patch {params} for their look, get_motion and set_motion for their time and feel. LOOK1: get_scene_look and set_scene_look for their background, type and finish.";
const KEY_WORD_INFO = { id: KEY_WORD, name: "Key word", kind: "text", about: "One big word that flies in and settles, made to sit behind the person (layer behind). No shadow, glow or outline.",
  frame: "overlay", widthPx: 1600, heightPx: 560, durationS: 1.6,
  params: [{ name: "text", label: "Word", type: "text", default: "today" }, { name: "accent", label: "In the accent colour", type: "choice", default: "no", options: ["no", "yes"] }] };
/** PRO5: the key word, from its params (a word of up to 24 characters; accent yes draws it in the edit's accent). */
async function keyWord(params: Record<string, unknown> | undefined, theme: ReturnType<typeof graphicTheme>, durationS: number, layer: "front" | "behind" | undefined, words?: MotionGraphic["words"]) {
  const { keyWordGraphic } = await import("../titles/mattes");
  const text = typeof params?.text === "string" ? params.text : "";
  return keyWordGraphic(text, theme, { durationS, accent: params?.accent === true || params?.accent === "yes", layer, words });
}
/** PRO5: where a graphic ended up after the outline check, for the agent's answer. */
const placed = (g: MotionGraphic | null | undefined) => g ? { layer: g.layer ?? "front", ...(g.behindNote ? { inFront: g.behindNote } : {}),
  ...(g.behindCheck && g.behindCheck.frames ? { outline: { flickerPx: g.behindCheck.flickerPx, bandPx: g.behindCheck.bandPx, cover: g.behindCheck.cover } } : {}) } : {};
const CARD_ONLY = "Cards are made with add_card (a real picture from the shoot, a stamp in the person's own words). Change a card's time or place here, or make it again with add_card.";

export async function listGraphicTemplates() {
  return { templates: [...graphicTemplates(), KEY_WORD_INFO], scenes: SCENE_TEMPLATES.map(({ build: _build, ...info }) => info), scenesNote: SCENES_NOTE, icons: ICON_NAMES, rules: RULES };
}

type Frame = { width: number; height: number };
async function frameOf(root: string, cutId: string, versionNumber: number) {
  const { loadDraftVersion } = await import("../sidekick");
  const record = await loadDraftVersion(root, cutId, versionNumber);
  return { record, frame: { width: record.assembly.template.width, height: record.assembly.template.height } as Frame };
}

type Request = { template?: string; params?: Record<string, unknown>; composition?: Record<string, unknown>; durationS?: number; layer?: "front" | "behind"; words?: MotionGraphic["words"] };
export async function graphicEdit(root: string, cutId: string, versionNumber: number, name: "add_graphic" | "update_graphic" | "remove_graphic", input: Record<string, unknown>) {
  const { editCut } = await import("../sidekick");
  const { record, frame } = await frameOf(root, cutId, versionNumber);
  const theme = graphicTheme(record.titles);
  if (name === "remove_graphic") {
    const item = record.overlays?.find(o => o.id === input.id);
    if (!item?.graphic) throw new Error("That graphic is not in this version.");
    const removed = await editCut(root, cutId, versionNumber, { kind: "overlay", op: "remove", id: item.id });
    // SCN1b: a pause scene's time stays in the edit; undoing the add_scene version takes both out.
    return graphicSource(item.graphic)?.params.mode === "pause" ? { ...removed, note: "The scene is out; the pause it made is still in the edit. Undo the version that added it to take the pause out too." } : removed;
  }
  const last = (record.lengthS ?? 0);
  if (name === "add_graphic") {
    if (input.template === CARD_TEMPLATE) throw new Error(CARD_ONLY);
    const s = input.s as number, e = input.e as number;
    if (!(e > s)) throw new Error("e must be after s.");
    if (s >= last) throw new Error(`The edit is ${last.toFixed(1)} seconds long. Choose a time inside it.`);
    // TASTE1: a key word sits on the picture; a full-screen scene replaces it there.
    const under = input.template === KEY_WORD ? fullScreenOver(record.overlays, s, Math.min(e, last)) : null;
    if (under) throw new Error(underFullScreen(under));
    const graphic = input.template === KEY_WORD ? await keyWord(input.params as Record<string, unknown> | undefined, theme, (input.durationS as number | undefined) ?? Math.min(e - s, 60), input.layer as Request["layer"], input.words as Request["words"])
      : graphicFromRequest({ template: input.template as string | undefined, params: input.params as Record<string, unknown> | undefined, composition: input.composition as Request["composition"],
      durationS: (input.durationS as number | undefined) ?? (input.composition ? undefined : Math.min(e - s, 60)), layer: input.layer as Request["layer"], words: input.words as Request["words"] }, theme);
    // MOT1b: a scene's anchors (his words, the beats) resolved for where it sits, so its times are right from the start.
    const resolved = graphicMotion(graphic) ? setGraphicMotion(graphic, {}, await motionContext(root, record, { s, e: Math.min(e, last) })) : null;
    const spot = defaultPlacement(graphic, frame);
    const item: Omit<OverlayItem, "id" | "file"> = { graphic: resolved?.graphic ?? graphic, s, e: Math.min(e, last), x: (input.x as number | undefined) ?? spot.x, y: (input.y as number | undefined) ?? spot.y, w: (input.w as number | undefined) ?? spot.w,
      ...(input.rotate !== undefined ? { rotate: input.rotate as number } : {}), corner: "square", enter: "none", exit: "none", sound: null };
    const result = await editCut(root, cutId, versionNumber, { kind: "overlay", op: "add", source: "", item } as CutEdit);
    const made = (await frameOf(root, cutId, result.version)).record.overlays?.filter(o => o.graphic).at(-1);
    return { ...result, id: made?.id, ...placed(made?.graphic), ...(resolved?.notes.length ? { notes: resolved.notes } : {}), note: resolved ? "Check it with preview_graphic or look_at; fine-tune its timing with get_motion and set_motion." : "Check it with preview_graphic or look_at." };
  }
  // update_graphic
  const item = record.overlays?.find(o => o.id === input.id);
  if (!item?.graphic) throw new Error("That graphic is not in this version.");
  const patch = { ...(input.patch as Record<string, unknown>) };
  const { template, params, composition: next, layer, words: cues, ...place } = patch as Record<string, unknown> & Request;
  if ((template || params || next) && (template === CARD_TEMPLATE || item.graphic.template === CARD_TEMPLATE)) throw new Error(CARD_ONLY);
  const edit: Partial<OverlayItem> = { ...(place as Partial<OverlayItem>) };
  if (params && isSceneGraphic(item.graphic)) await checkSceneUpdate(root, record, item, params);   // SCN1b
  if (template || params || next || layer || cues) {
    if (next) edit.graphic = graphicFromRequest({ composition: next, layer, words: cues ?? item.graphic.words }, theme);
    else if ((template ?? item.graphic.template) === KEY_WORD && (template || params)) {   // PRO5: a new word, or the accent
      const was = /<div class="w">([^<]*)<\/div>/.exec(item.graphic.html)?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      const s = (place.s as number | undefined) ?? item.s, e = (place.e as number | undefined) ?? item.e;
      edit.graphic = await keyWord({ text: was, ...params }, theme, Math.min(60, e - s), layer ?? item.graphic.layer, cues ?? item.graphic.words);
    } else if (!template && !params) {
      // PRO5: only the layer or the words: the same design. Behind is checked again on save; front by hand is his choice.
      const { behindNote: _note, behindCheck: _check, ...same } = item.graphic;
      edit.graphic = { ...same, ...(layer ? { layer } : {}), ...(cues ? { words: cues } : {}) };
    } else {
      const was = graphicSource(item.graphic);
      const id = template ?? was?.template;
      if (!id) throw new Error("This graphic was written by hand. Send a new composition, or change only its time and place.");
      const s = (place.s as number | undefined) ?? item.s, e = (place.e as number | undefined) ?? item.e;
      edit.graphic = buildFromTemplate(id, template ? (params ?? {}) : { ...was?.params, ...params }, was?.theme ?? theme, { durationS: Math.min(60, e - s), layer: layer ?? item.graphic.layer, words: cues ?? item.graphic.words });
    }
  }
  // MOT1b: a scene keeps its motion through any change, resolved again for where it now sits (its words follow him).
  let notes: string[] = [];
  const s = (place.s as number | undefined) ?? item.s, e = (place.e as number | undefined) ?? item.e, moved = place.s !== undefined || place.e !== undefined;
  // TASTE1: a key word or a pinned item moved under a full-screen scene would be hidden by it.
  const under = moved && ((edit.graphic ?? item.graphic).template === KEY_WORD || !!item.pin) ? fullScreenOver(record.overlays, s, e, item.id) : null;
  if (under) throw new Error(underFullScreen(under));
  const base = edit.graphic ?? (moved ? fitGraphicToSpan(item.graphic, Math.min(60, e - s)) : undefined);
  if (base && graphicMotion(base)) {
    const resolved = setGraphicMotion(base, {}, await motionContext(root, record, { s, e }));
    edit.graphic = resolved.graphic; notes = resolved.notes;
  }
  const result = await editCut(root, cutId, versionNumber, { kind: "overlay", op: "update", id: item.id, patch: edit } as CutEdit);
  return { ...result, ...placed((await frameOf(root, cutId, result.version)).record.overlays?.find(o => o.id === item.id)?.graphic), ...(notes.length ? { notes } : {}) };
}

// ---- MOT1b: what a motion graphic's times are resolved against

/** The item's span, his words (ids that follow them: the caption source's words, rebuilt when a version has none), the
 *  music's measured beats on the edit clock (the timeline's grid) and the frame rate. The same facts the app's timeline
 *  holds, so a change made here lands where the same change made by hand would. */
export async function motionContext(root: string, record: import("../sidekick").StoredVersion, item: { s: number; e: number }): Promise<MotionContext> {
  const words = await motionWordsOf(record);
  let beats: number[] = [];
  try {
    const { planFx } = await import("../edits-fx");
    const fx = planFx(record.assembly.cutList, record.assembly.template.fps, record as never);
    beats = (await (await import("../music-timeline")).timelineMusic(root, record, fx))?.beats ?? [];
  } catch { /* no music: words, else its own times */ }
  return { itemS: item.s, itemE: item.e, words, beats: dedupeBeats(beats), syllables: words.map(w => w.s), fps: standardFrameRate(record.assembly?.template.fps || 30) };   // the frames the export draws (EXP3), as add_scene lands them
}

/** His words with the ids motion anchors use: the caption source's, rebuilt when a version has none. scene-edit.ts keys
 *  a scene's word anchors by these too. */
export async function motionWordsOf(record: import("../sidekick").StoredVersion) {
  let words = motionWords(record.titles);
  if (!words.length && record.assembly) {
    try {
      const { buildTitlesInput, captionSourceForInput } = await import("../titles");
      const { shoot, template, cutList } = record.assembly;
      words = motionWords({ captionSource: captionSourceForInput(buildTitlesInput(shoot, record as never, template, cutList, "reels", Math.min(template.width, template.height), false)) });
    } catch { /* no words: beats and its own times still work */ }
  }
  return words;
}

// ---- MOT1b: get_motion and set_motion, the same change the inspector and the timeline's ticks make (setGraphicMotion)

const r2 = (n: number) => Math.round(n * 100) / 100, r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Every element with its time in seconds, in beats and its word, and the knobs: what get_motion answers. */
export function describeMotion(item: OverlayItem, ctx: MotionContext) {
  const found = graphicMotion(item.graphic!)!, { motion, labels } = found;
  const { resolved } = setGraphicMotion(item.graphic!, {}, ctx), beats = ctx.beats, words = new Map(ctx.words.map(w => [w.id, w]));
  return {
    itemId: item.id, template: found.source.template, scene: { s: r3(item.s), e: r3(item.e) },
    style: motion.style, strength: motion.strength, push: motion.push, holdBeats: motion.holdBeats, offsetBeats: motion.offsetBeats, grid: motion.grid, keepOrder: motion.keepOrder, timing: motion.timing,
    beatLengthS: r3(beatLength(beats, item.s)), music: beats.length > 0, fps: ctx.fps,
    elements: motion.elements.map((e, i) => ({
      id: e.id, what: labels[i], atS: r3(resolved.at[i]), reelS: r3(resolved.times[i]), beat: r2(beatPosition(beats, resolved.times[i])), beatInScene: beatLabel(beats, item.s, resolved.times[i]),
      on: e.word !== undefined ? "his word" : e.beat !== undefined ? "the beat" : "its own time",
      word: e.word !== undefined ? { id: e.word, text: words.get(e.word)?.text ?? null } : null,
      ...(e.style ? { style: e.style } : {}), ...(e.strength !== undefined ? { strength: e.strength } : {}),
    })),
    wordsInSpan: wordsInSpan(ctx).map(w => ({ id: w.id, text: w.text, reelS: r3(w.s) })),
    notes: resolved.notes,
    howTo: "set_motion with itemId and only what changes: a knob, or elements [{id, shiftBeats}] (0.5 = half a beat later), {id, beat} (a beat as listed here, snapped to the grid), {id, word} (a word id from wordsInSpan, or the word), {id, at} (seconds from the scene's start).",
  };
}

export async function motionEdit(root: string, cutId: string, versionNumber: number, name: "get_motion" | "set_motion", input: Record<string, unknown>) {
  const { record } = await frameOf(root, cutId, versionNumber);
  const item = record.overlays?.find(o => o.id === input.itemId);
  if (!item?.graphic) throw new Error("That graphic is not in this version.");
  if (!graphicMotion(item.graphic)) throw new Error(NO_MOTION);
  const ctx = await motionContext(root, record, item);
  if (name === "get_motion") return describeMotion(item, ctx);
  const { itemId: _id, ...change } = input as { itemId: string } & MotionChange;
  const result = setGraphicMotion(item.graphic, change, ctx);
  if (!result.changed.length) return { version: versionNumber, changed: [], notes: result.notes, note: "Nothing changed, so there is no new version." };
  const { editCut } = await import("../sidekick");
  const saved = await editCut(root, cutId, versionNumber, { kind: "overlay", op: "update", id: item.id, patch: { graphic: result.graphic } } as CutEdit);
  const after = (await frameOf(root, cutId, saved.version)).record.overlays?.find(o => o.id === item.id);
  return { ...saved, changed: result.changed, notes: result.notes, motion: after?.graphic && graphicMotion(after.graphic) ? describeMotion(after, ctx) : null };
}

export async function previewGraphic(args: Record<string, unknown>, resolve: { shoot: (name: string) => Promise<string>; version: (root: string, cutId: string, version?: number) => Promise<number> }) {
  if (args.atS !== undefined) return previewGraphicAt(args, resolve);   // SCN1b
  let graphic: MotionGraphic, root: string | null = null;
  if (args.id) {
    if (typeof args.shoot !== "string" || typeof args.cut !== "string") throw new Error("Give shoot and cut with the graphic's id.");
    root = await resolve.shoot(args.shoot);
    const { record } = await frameOf(root, args.cut, await resolve.version(root, args.cut, args.version as number | undefined));
    const found = record.overlays?.find(o => o.id === args.id)?.graphic;
    if (!found) throw new Error("That graphic is not in this version.");
    graphic = found;
  } else {
    let theme = {};
    if (typeof args.shoot === "string" && typeof args.cut === "string") {
      const root = await resolve.shoot(args.shoot);
      theme = graphicTheme((await frameOf(root, args.cut, await resolve.version(root, args.cut, args.version as number | undefined))).record.titles);
    }
    graphic = args.template === KEY_WORD ? await keyWord(args.params as Record<string, unknown> | undefined, theme, (args.durationS as number | undefined) ?? KEY_WORD_INFO.durationS, args.layer as Request["layer"])
      : graphicFromRequest({ template: args.template as string | undefined, params: args.params as Record<string, unknown> | undefined, composition: args.composition as Request["composition"],
      durationS: args.durationS as number | undefined, layer: args.layer as Request["layer"] }, theme);
  }
  const { renderGraphicStills, vetGraphic } = await import("./render");
  await vetGraphic(graphic);
  const times = [graphic.durationS * 0.15, graphic.durationS * 0.55, Math.max(0, graphic.durationS - 0.5)].map(t => Math.round(t * 100) / 100);
  const frames = await renderGraphicStills(graphic, times, { maxWidth: 800, backdrop: "#44444c", root });
  return { content: [
    { type: "text" as const, text: JSON.stringify({ note: "Three frames of the graphic on a grey backdrop (it is transparent in the edit). Times are seconds into the graphic.", times, durationS: graphic.durationS, frame: graphic.frame, template: graphic.template ?? null }) },
    ...frames.map(png => ({ type: "image" as const, mimeType: "image/png", data: png.toString("base64") })),
  ] };
}

// TRK1b: pin a graphic to a thing in the shot. The box is required for now (naming the thing in words is TRK3).
export async function pinEdit(root: string, cutId: string, versionNumber: number, name: "pin_graphic" | "update_pin" | "unpin", input: Record<string, unknown>) {
  const pin = await import("../tracking/pin");
  const id = input.itemId as string;
  if (typeof id !== "string" || !id) throw new Error("Give the graphic's itemId (from read_edit or the add_graphic result).");
  if (name === "unpin") return pin.unpin(root, cutId, versionNumber, id);
  const { itemId: _id, ...request } = input as Record<string, unknown> & import("../tracking/pin").PinRequest;
  return name === "pin_graphic" ? pin.pinItem(root, cutId, versionNumber, id, request) : pin.updatePin(root, cutId, versionNumber, id, request);
}

// TRK2: a locked frame, the picture steadied on a thing in the shot. A box (or four corners) to track, then knobs.
export async function lockEdit(root: string, cutId: string, versionNumber: number, name: "lock_on" | "update_lock" | "unlock", input: Record<string, unknown>) {
  const lock = await import("../tracking/lock");
  const request = input as Record<string, unknown> & import("../tracking/lock").LockRequest & { piece?: number; pieceId?: string };
  if (name === "unlock") return lock.unlock(root, cutId, versionNumber, request);
  return name === "lock_on" ? lock.lockOn(root, cutId, versionNumber, request) : lock.updateLock(root, cutId, versionNumber, request);
}

// ---- SCN1b: full-screen scenes (add_scene) and previews at any time. Apart from the graphic tools above so each can
// change on its own; the scene logic itself is graphics/scene-edit.ts.

/** MCP and Ask add_scene: one undoable version. */
export async function sceneEdit(root: string, cutId: string, versionNumber: number, input: Record<string, unknown>) {
  return (await import("./scene-edit")).addScene(root, cutId, versionNumber, input);
}
const isSceneGraphic = (g: MotionGraphic | null | undefined) => !!g?.template?.startsWith("scene-");
/** update_graphic params on a scene: new words must still be words he says there. */
async function checkSceneUpdate(root: string, record: Awaited<ReturnType<typeof frameOf>>["record"], item: OverlayItem, params: Record<string, unknown>) {
  await (await import("./scene-edit")).checkSceneParams(root, record, item, params);
}

const PREVIEW_TIMES = 12;
/** preview_graphic atS: any times (up to 12). With an id they are reel seconds and each frame is the item in place at
 *  the edit's shape (a full-screen scene alone; an overlay over the picture under it, the cached source still before
 *  looks); otherwise seconds into the graphic, on the neutral backdrop. Draws only those frames: seconds, not an export. */
async function previewGraphicAt(args: Record<string, unknown>, resolve: { shoot: (name: string) => Promise<string>; version: (root: string, cutId: string, version?: number) => Promise<number> }) {
  const times = args.atS;
  if (!Array.isArray(times) || !times.length || times.length > PREVIEW_TIMES || !times.every(t => typeof t === "number" && Number.isFinite(t) && t >= 0)) throw new Error(`Give atS as 1 to ${PREVIEW_TIMES} times in seconds.`);
  const { renderGraphicStills, renderItemStills, vetGraphic } = await import("./render");
  const started = Date.now(), r3 = (n: number) => Math.round(n * 1000) / 1000;
  if (!args.id) {
    const { id: _id, atS: _at, ...rest } = args;
    const graphic = await previewSource(rest, resolve);
    await vetGraphic(graphic);
    const root = typeof args.shoot === "string" ? await resolve.shoot(args.shoot) : null;
    const frames = await renderGraphicStills(graphic, times as number[], { maxWidth: 800, backdrop: "#44444c", root });
    return { content: [{ type: "text" as const, text: JSON.stringify({ note: "Frames of the graphic at the times asked, seconds into it, on a grey backdrop (it is transparent in the edit).", times, durationS: graphic.durationS, ms: Date.now() - started }) },
      ...frames.map(png => ({ type: "image" as const, mimeType: "image/png", data: png.toString("base64") }))] };
  }
  if (typeof args.shoot !== "string" || typeof args.cut !== "string") throw new Error("Give shoot and cut with the graphic's id.");
  const root = await resolve.shoot(args.shoot), version = await resolve.version(root, args.cut, args.version as number | undefined);
  const { record, frame } = await frameOf(root, args.cut, version);
  const item = record.overlays?.find(o => o.id === args.id);
  if (!item?.graphic) throw new Error("That graphic is not in this version.");
  // Times as written (to 0.1 ms) may sit a hair before the item's exact start: within 2 ms they are its first frame.
  const at = (times as number[]).map(t => t < item.s && t > item.s - 2e-3 ? item.s : t);
  const outside = at.filter(t => t < item.s - 1e-9 || t >= item.e - 1e-6);
  if (outside.length) throw new Error(`That graphic is on screen from ${r3(item.s)} to ${r3(item.e)} s. Give times inside it (${outside.map(r3).join(", ")} ${outside.length === 1 ? "isn't" : "aren't"}).`);
  const full = item.graphic.frame === "full";
  let under: (string | null)[] = (times as number[]).map(() => null), note = full ? "The full-screen item in place at the times asked (reel seconds), at the edit's shape." : "The item in place over the picture under it (the cached source still, before looks and captions).";
  if (!full) {
    try {
      const looked = await (await import("../ask-read")).readAskTool(root, "look_at", { cut: args.cut, version, times }) as { content: { type: string; data?: string }[] };
      under = looked.content.filter(c => c.type === "image").map(c => c.data ? `data:image/jpeg;base64,${c.data}` : null);
    } catch (error) { note += ` No picture under it: ${error instanceof Error ? error.message : error}`; }
  }
  const scale = Math.min(1, 540 / frame.width), size = { width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) };
  const frames = await renderItemStills(item, size, at, { root, backdrops: under.map(u => u ?? (full ? "#000" : "#44444c")) });
  return { content: [
    { type: "text" as const, text: JSON.stringify({ note, id: item.id, times, s: item.s, e: item.e, frame: item.graphic.frame, template: item.graphic.template ?? null, size, ms: Date.now() - started }) },
    ...frames.map(png => ({ type: "image" as const, mimeType: "image/png", data: png.toString("base64") })),
  ] };
}
/** The graphic a preview without an id draws (the same request previewGraphic builds). */
async function previewSource(args: Record<string, unknown>, resolve: { shoot: (name: string) => Promise<string>; version: (root: string, cutId: string, version?: number) => Promise<number> }): Promise<MotionGraphic> {
  let theme = {};
  if (typeof args.shoot === "string" && typeof args.cut === "string") {
    const root = await resolve.shoot(args.shoot);
    theme = graphicTheme((await frameOf(root, args.cut, await resolve.version(root, args.cut, args.version as number | undefined))).record.titles);
  }
  return args.template === KEY_WORD ? keyWord(args.params as Record<string, unknown> | undefined, theme, (args.durationS as number | undefined) ?? KEY_WORD_INFO.durationS, args.layer as Request["layer"])
    : graphicFromRequest({ template: args.template as string | undefined, params: args.params as Record<string, unknown> | undefined, composition: args.composition as Request["composition"],
      durationS: args.durationS as number | undefined, layer: args.layer as Request["layer"] }, theme);
}
