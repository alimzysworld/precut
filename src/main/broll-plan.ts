// BROLL2: "Show what you say" on a saved edit. The proposal reads the edit's caption words (camera speech and
// voiceover alike, on the edit clock) and the shoot's library; nothing is written until apply. Apply is one version of
// timed layout scenes (shared/broll-plan.ts cutawayLayout), so every cutaway stays editable in the Layout lane and
// inspector like any other range: trim, swap the shot, change the weave's opacity, remove.
import type { BrollPlacement, BrollPlan, BrollPrefer } from "../shared/broll-plan";
import { brollPlanEdit, libraryShots, pictureShot, planBroll, type PlanWord } from "../shared/broll-plan";
import { timedCaptionWords } from "../shared/caption-words";
import { standardFrameRate } from "../shared/frame-rate";
import { migrateLayouts } from "../shared/layout-presets";
import { clipName } from "../shared/clip-name";
import { captionWordsForVersion } from "./titles/captions";
import type { StoredVersion } from "./sidekick";

export type BrollProposal = BrollPlan & { cutId: string; version: number };

/** The edit's spoken words on its own clock, indexed as read_captions indexes them when captions exist. */
export function editWords(record: StoredVersion): PlanWord[] {
  const timed = timedCaptionWords(record.titles);
  if (timed.length) return timed.map(w => ({ text: w.text.trim(), s: w.s, e: w.e, index: w.index }));
  const versionWords = captionWordsForVersion(record.assembly.shoot, record);
  if (versionWords.length) return versionWords.map((w, index) => ({ text: w.text.trim(), s: w.s, e: w.e, index }));
  // Captions off and no take ids (an edit made from clip spans): what each piece's own clip says inside its span.
  const clips = new Map(record.assembly.shoot.clips.map(c => [c.id, c]));
  return (record.pieces ?? []).flatMap((p, i) => {
    const speed = Math.abs(record.pieceFx?.[i]?.speed ?? 1) || 1, removed = p.removed ?? [];
    return (clips.get(p.clipId)?.transcript ?? []).flatMap(seg => seg.words).filter(w => w.s >= p.s - .02 && w.e <= p.e + .02 && !removed.some(r => w.s < r.e && w.e > r.s))
      .map(w => { const cut = removed.filter(r => r.e <= w.s).reduce((n, r) => n + r.e - Math.max(r.s, p.s), 0);
        return { text: w.w.trim(), s: p.timelineS + (w.s - p.s - cut) / speed, e: p.timelineS + (w.e - p.s - cut) / speed }; });
  }).sort((a, b) => a.s - b.s).map((w, index) => ({ ...w, index }));
}

/** What already fills the picture somewhere (a layout he chose, a full-frame graphic): no cutaway goes over it. */
function busyRanges(record: StoredVersion) {
  const scenes = migrateLayouts(record).filter(l => l.kind === "scene" && !l.cutaway && !(l.id === "camera-only" && (l.followCamera || !l.sources?.b)) && l.s !== undefined && l.e !== undefined)
    .map(l => ({ s: l.s!, e: l.e!, why: "A layout you chose is already there" }));
  const graphics = (record.overlays ?? []).filter(o => o.graphic?.frame === "full").map(o => ({ s: o.s, e: o.e, why: "A full-screen graphic is already there" }));
  return [...scenes, ...graphics];
}

export function proposeBroll(record: StoredVersion, options: { s: number; e: number; maxShots?: number; prefer?: BrollPrefer }): BrollPlan {
  const { shoot, template } = record.assembly;
  // What the edit already shows: its pictures and the b-roll laid over them. A cutaway never repeats what is there.
  const picture = (record.pieces ?? []).flatMap(p => [{ s: p.timelineS, e: p.timelineS + p.lengthS, clipId: p.clipId },
    ...(p.overlay ? [{ s: p.timelineS, e: p.timelineS + p.overlay.e - p.overlay.s, clipId: p.overlay.clipId }] : [])]);
  return planBroll(editWords(record), libraryShots(shoot), { ...options, fps: standardFrameRate(template.fps), lengthS: record.lengthS, busy: busyRanges(record), picture,
    pictureShots: [...new Set(picture.map(p => p.clipId))].flatMap(id => { const clip = shoot.clips.find(c => c.id === id); return clip ? [pictureShot(clip)] : []; }) });
}

export async function showWhatYouSay(root: string, cutId: string, version: number, options: { s: number; e: number; maxShots?: number; prefer?: BrollPrefer }): Promise<BrollProposal> {
  const { loadDraftVersion } = await import("./sidekick");
  const record = await loadDraftVersion(root, cutId, version);
  return { cutId, version: record.version, ...proposeBroll(record, options) };
}

/** Land chosen cutaways as one version. stretch: the words the proposal covered, so cutaways from an earlier run there go. */
export async function applyBrollPlan(root: string, cutId: string, version: number, placements: BrollPlacement[], stretch?: { s: number; e: number }) {
  const { loadDraftVersion, editCut } = await import("./sidekick");
  const record = await loadDraftVersion(root, cutId, version);
  const edit = brollPlanEdit(placements, migrateLayouts(record), stretch, placements.length === 1 ? `Show what I say: “${placements[0].phrase.slice(0, 60)}”` : `Show what I say: ${placements.length} cutaways`);
  return editCut(root, cutId, record.version, edit);
}

/** MCP and Ask read the proposal with shot names, never bare ids. */
export function describeProposal(proposal: BrollProposal, shoot: StoredVersion["assembly"]["shoot"]) {
  const named = <T extends { clipId: string; s: number }>(x: T) => ({ ...x, shot: clipName(shoot.clips.find(c => c.id === x.clipId) ?? null) });
  return { ...proposal, slots: proposal.slots.map(slot => ({ ...slot, pick: named(slot.pick), alternatives: slot.alternatives.map(named), desks: slot.desks.map(named) })),
    apply: "Nothing is placed yet. Pass the cutaways you keep to apply_broll_plan (s, e, phrase, word, clipId, sourceS from pick.s or an alternative's s, and over for a screen recording laid over a desk shot), or call show_what_you_say with apply true to place every pick." };
}
