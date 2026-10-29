import type { Cut,CutVersion,Shoot,Skill,Template } from "../../../../shared/schema";
import { frameAt } from "../../data";

const versionIndexes = new WeakMap<Cut['versions'], { length: number; byNumber: Map<number, CutVersion> }>();
/** Transport renders never scan saved history. A new snapshot builds its index once. */
export function cutVersion(cut: Cut | undefined | null, number?: number): CutVersion | undefined {
  if (!cut || number === undefined) return cut?.versions.at(-1);
  let index = versionIndexes.get(cut.versions);
  if (!index || index.length !== cut.versions.length) {
    index = { length: cut.versions.length, byNumber: new Map(cut.versions.map(v => [v.version, v])) };
    versionIndexes.set(cut.versions, index);
  }
  return index.byNumber.get(number) ?? cut.versions.at(-1);
}

export interface Piece {
  id: string; clipId: string; s: number; e: number; label: string; words: string; broll?: boolean;
  lengthS?: number; timelineS?: number; beatSnapS?: number; overlays?: Piece[];
  removed?: NonNullable<CutVersion["pieces"]>[number]["removed"];
}
export function usesPractice(shoot: Shoot, piece: { clipId: string; s: number; e: number; broll?: boolean }): boolean {
  return !piece.broll && shoot.takes.some((take) => take.attempts.some((attempt) =>
    attempt.practice && attempt.clipId === piece.clipId && attempt.s < piece.e && attempt.e > piece.s));
}
function pieceLabel(id: string): string {
  const match = /^L(\d+)A(\d+)$/i.exec(id);
  return match ? `Line ${match[1]} · take ${match[2]}` : id;
}
function voicePiece(shoot: Shoot, id: string): Piece {
  const match = /^L(\d+)A(\d+)$/i.exec(id);
  const take = match ? shoot.takes.find((take) => take.lineIndex === Number(match[1]) - 1) : undefined;
  const attempt = match ? take?.attempts[Number(match[2]) - 1] : undefined;
  return { id, clipId: attempt?.clipId ?? "", s: attempt?.s ?? 0, e: attempt?.e ?? 0, label: pieceLabel(id), words: attempt?.text || "This take is no longer in the shoot." };
}
// B-roll ids enumerate usable moments in shoot order, including multiple
// spans of one source. Older fixture indexes spell the kind “b-roll”.
function brollPieces(shoot: Shoot): Piece[] {
  return shoot.clips.flatMap((clip) => {
    const judgement = clip.judgement;
    if (!judgement || !(String(judgement.kind).replace("-", "") === "broll" || (judgement.verdict === "maybe" && /b-?roll/i.test(judgement.summary)))) return [];
    const spans = judgement.usableSpans.length ? judgement.usableSpans : [[0, clip.meta?.durationS ?? 0]];
    return spans.map(([s, e]) => ({ id: "", clipId: clip.id, s, e, label: "B-roll", words: judgement.summary, broll: true }));
  }).map((piece, index) => ({ ...piece, id: `B${index + 1}` }));
}
export function storyboard(shoot: Shoot, version: CutVersion): { pieces: Piece[]; unknownPositions: boolean; unattached: string[] } {
  if (version.pieces !== undefined) return {
    pieces: version.pieces.map((piece) => ({
      ...piece, label: piece.kind === "broll" ? `B-roll · ${piece.description || "cutaway"}` : pieceLabel(piece.id), broll: piece.kind === "broll",
      words: (piece.kind === "voice" ? piece.words : piece.description) ?? "",
      overlays: piece.overlay ? [{ ...piece.overlay, label: "B-roll", words: piece.overlay.description ?? "", broll: true }] : [],
    })),
    unknownPositions: false, unattached: [],
  };
  // Only old versions without resolved pieces need the historical id mapping.
  const broll = brollPieces(shoot);
  const findBroll = (id: string): Piece => broll.find((piece) => piece.id === id) ?? { id, clipId: "", s: 0, e: 0, label: "B-roll", words: "This b-roll moment is no longer in the shoot.", broll: true };
  const voices = version.voice.map((id) => ({
    ...(/^B\d+$/.test(id) ? findBroll(id) : voicePiece(shoot, id)),
    overlays: version.broll.filter((overlay) => overlay.over === id).map((overlay) => findBroll(overlay.id)),
  }));
  const standalone = version.broll.filter((piece) => !piece.over).map((piece) => findBroll(piece.id));
  return { pieces: [...voices, ...standalone], unknownPositions: standalone.length > 0,
    unattached: version.broll.filter((piece) => piece.over && !version.voice.includes(piece.over)).map((piece) => piece.id) };
}
export function cutPoster(shoot: Shoot, version: CutVersion): string | null {
  const first = storyboard(shoot, version).pieces[0];
  const visible = first?.overlays?.[0] ?? first;
  return visible ? frameAt(shoot, visible.clipId, visible.s) : null;
}
// The saved version's format reserves the card; media metadata is authoritative.
export function cutAspect(cut: Cut, version: CutVersion, skills: Skill[], templates: Template[]): number {
  const savedFormat = version.formats?.[0];
  if (savedFormat && savedFormat.width > 0 && savedFormat.height > 0) return savedFormat.width / savedFormat.height;
  // Reframing stores a per-version template id, rather than changing a shared format.
  const reframed = /^aspect-(?:9-16|16-9|1-1|4-5)-(\d+)x(\d+)-/.exec(version.templateId);
  if (reframed && Number(reframed[1]) > 0 && Number(reframed[2]) > 0) return Number(reframed[1]) / Number(reframed[2]);
  const template = templates.find((entry) => entry.id === version.templateId);
  if (template && template.width > 0 && template.height > 0) return template.width / template.height;
  const format = skills.find((skill) => cut.skillIds.includes(skill.id) && !skill.global && skill.format)?.format
    ?? skills.find((skill) => skill.global && (skill as Skill & { type?: string }).type !== "titles")?.format;
  return format && format.width > 0 && format.height > 0 ? format.width / format.height : 16 / 9;
}

