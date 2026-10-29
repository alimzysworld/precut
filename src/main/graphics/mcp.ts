import type { CutEdit, MotionGraphic, OverlayItem } from "../../shared/schema";
import { GRAPHIC_LIMITS } from "./sanitize";
import { graphicTemplates, graphicSource, buildFromTemplate } from "./templates";
import { ICON_NAMES } from "./icons";
import { defaultPlacement, graphicFromRequest, graphicTheme } from "./edit";

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
];

export async function listGraphicTemplates() {
  return { templates: graphicTemplates(), icons: ICON_NAMES, rules: RULES };
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
    return editCut(root, cutId, versionNumber, { kind: "overlay", op: "remove", id: item.id });
  }
  const last = (record.lengthS ?? 0);
  if (name === "add_graphic") {
    const s = input.s as number, e = input.e as number;
    if (!(e > s)) throw new Error("e must be after s.");
    if (s >= last) throw new Error(`The edit is ${last.toFixed(1)} seconds long. Choose a time inside it.`);
    const graphic = graphicFromRequest({ template: input.template as string | undefined, params: input.params as Record<string, unknown> | undefined, composition: input.composition as Request["composition"],
      durationS: (input.durationS as number | undefined) ?? (input.composition ? undefined : Math.min(e - s, 60)), layer: input.layer as Request["layer"], words: input.words as Request["words"] }, theme);
    const spot = defaultPlacement(graphic, frame);
    const item: Omit<OverlayItem, "id" | "file"> = { graphic, s, e: Math.min(e, last), x: (input.x as number | undefined) ?? spot.x, y: (input.y as number | undefined) ?? spot.y, w: (input.w as number | undefined) ?? spot.w,
      ...(input.rotate !== undefined ? { rotate: input.rotate as number } : {}), corner: "square", enter: "none", exit: "none", sound: null };
    const result = await editCut(root, cutId, versionNumber, { kind: "overlay", op: "add", source: "", item } as CutEdit);
    const made = (await frameOf(root, cutId, result.version)).record.overlays?.filter(o => o.graphic).at(-1);
    return { ...result, id: made?.id, note: "Check it with preview_graphic or look_at." };
  }
  // update_graphic
  const item = record.overlays?.find(o => o.id === input.id);
  if (!item?.graphic) throw new Error("That graphic is not in this version.");
  const patch = { ...(input.patch as Record<string, unknown>) };
  const { template, params, composition: next, layer, words: cues, ...place } = patch as Record<string, unknown> & Request;
  const edit: Partial<OverlayItem> = { ...(place as Partial<OverlayItem>) };
  if (template || params || next || layer || cues) {
    if (next) edit.graphic = graphicFromRequest({ composition: next, layer, words: cues ?? item.graphic.words }, theme);
    else {
      const was = graphicSource(item.graphic);
      const id = template ?? was?.template;
      if (!id) throw new Error("This graphic was written by hand. Send a new composition, or change only its time and place.");
      const s = (place.s as number | undefined) ?? item.s, e = (place.e as number | undefined) ?? item.e;
      edit.graphic = buildFromTemplate(id, template ? (params ?? {}) : { ...was?.params, ...params }, was?.theme ?? theme, { durationS: Math.min(60, e - s), layer: layer ?? item.graphic.layer, words: cues ?? item.graphic.words });
    }
  }
  return editCut(root, cutId, versionNumber, { kind: "overlay", op: "update", id: item.id, patch: edit } as CutEdit);
}

export async function previewGraphic(args: Record<string, unknown>, resolve: { shoot: (name: string) => Promise<string>; version: (root: string, cutId: string, version?: number) => Promise<number> }) {
  let graphic: MotionGraphic;
  if (args.id) {
    if (typeof args.shoot !== "string" || typeof args.cut !== "string") throw new Error("Give shoot and cut with the graphic's id.");
    const root = await resolve.shoot(args.shoot);
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
    graphic = graphicFromRequest({ template: args.template as string | undefined, params: args.params as Record<string, unknown> | undefined, composition: args.composition as Request["composition"],
      durationS: args.durationS as number | undefined, layer: args.layer as Request["layer"] }, theme);
  }
  const { renderGraphicStills, vetGraphic } = await import("./render");
  await vetGraphic(graphic);
  const times = [graphic.durationS * 0.15, graphic.durationS * 0.55, Math.max(0, graphic.durationS - 0.5)].map(t => Math.round(t * 100) / 100);
  const frames = await renderGraphicStills(graphic, times, { maxWidth: 800, backdrop: "#44444c" });
  return { content: [
    { type: "text" as const, text: JSON.stringify({ note: "Three frames of the graphic on a grey backdrop (it is transparent in the edit). Times are seconds into the graphic.", times, durationS: graphic.durationS, frame: graphic.frame, template: graphic.template ?? null }) },
    ...frames.map(png => ({ type: "image" as const, mimeType: "image/png", data: png.toString("base64") })),
  ] };
}
