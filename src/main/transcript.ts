// Hand corrections are local edits. No judgement or model calls belong here.
import { BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { finishStoredVersion, renderStoredPreview, withShootLock } from "./sidekick";
import { currentVersion } from "./revisions";
import { readCutDocumentSync } from "./cut-storage";
import { rebuildSubtitles } from "./titles";
import { resolveReelPieces } from "./reel";
import type { Shoot, Word, Segment } from "../shared/schema";

const overlaps = (word: { s: number; e: number }, s: number, e: number) =>
  word.s < e && word.e > s || word.s === word.e && word.s >= s && word.s < e;
const textOf = (words: Word[]) => words.map(word => word.w.trim()).filter(Boolean).join(" ");

type WordFix = { s: number; e: number; text: string; expectedWords?: Word[]; replacementWords?: Word[]; restoreSegments?: Segment[] };
export function editTranscript(root: string, clipId: string, edits: WordFix[]): Promise<Shoot> {
  // Include both the index save and cut scan in the finishing/editing queue.
  // A concurrent finish must not commit a new version after our scan missed it.
  return withShootLock(root, () => editTranscriptLocked(root, clipId, edits));
}
async function editTranscriptLocked(root: string, clipId: string, edits: WordFix[]): Promise<Shoot> {
  const resolved = path.resolve(root);
  const directory = path.join(resolved, ".sidething");
  const file = path.join(directory, "index.json");
  if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) throw new Error("The shoot index must be inside its own folder.");
  // Keep read, edit and rename synchronous so two renderer saves cannot interleave.
  const before = fs.readFileSync(file, "utf8");
  const shoot = JSON.parse(before) as Shoot;
  const clip = shoot.clips.find(item => item.id === clipId);
  if (!clip?.transcript) throw new Error("This clip has no transcript to edit.");
  if (!Array.isArray(edits)) throw new Error("Choose words to correct.");
  const ordered = [...edits].sort((a, b) => a.s - b.s);
  for (const [index, edit] of ordered.entries()) {
    if (!Number.isFinite(edit.s) || !Number.isFinite(edit.e) || edit.s < 0 || edit.e <= edit.s ||
      typeof edit.text !== "string" || (clip.meta && edit.e > clip.meta.durationS + 0.001) ||
      (index > 0 && ordered[index - 1].e > edit.s)) throw new Error("Choose a valid, non-overlapping stretch of words.");
    const segments: Segment[] = clip.transcript!;
    const original = segments.flatMap(segment => segment.words).filter(word => overlaps(word, edit.s, edit.e));
    if (!original.length) throw new Error("Those words have changed. Select them again.");
    if (edit.expectedWords && JSON.stringify(original) !== JSON.stringify(edit.expectedWords)) throw new Error("Those words have changed. Select them again.");
    if (edit.replacementWords && (edit.replacementWords.length !== original.length ||
      edit.replacementWords.some((w, i) => w.s !== original[i].s || w.e !== original[i].e || typeof w.w !== "string") ||
      textOf(edit.replacementWords) !== edit.text.trim())) throw new Error("A vocabulary fix must keep the measured word timings.");
    const tokens = edit.text.trim().split(/\s+/u).filter(Boolean);
    const same = tokens.length === original.length && tokens.every((word, i) => word === original[i].w.trim());
    const weight = tokens.reduce((sum, word) => sum + Array.from(word).length, 0);
    let cursor = edit.s;
    const replacement: Word[] = edit.replacementWords ? edit.replacementWords.map(w => ({ ...w })) : same ? original.map(word => ({ ...word, byHand: true })) : tokens.map((word, i) => {
      const s = cursor;
      cursor = i === tokens.length - 1 ? edit.e : cursor + (edit.e - edit.s) * Array.from(word).length / weight;
      return { s, e: cursor, w: word, byHand: true };
    });
    // A silent hand word remembers a deletion so a re-transcription cannot undo it.
    if (!replacement.length) replacement.push({ s: edit.s, e: edit.e, w: "", byHand: true });
    if (edit.replacementWords) {
      // Vocabulary changes preserve each measured slot and its segment owner.
      let slot = 0;
      clip.transcript = segments.map(segment => {
        if (!segment.words.some(word => overlaps(word, edit.s, edit.e))) return segment;
        const words = segment.words.map(word => overlaps(word, edit.s, edit.e) ? replacement[slot++] : word);
        const restored = edit.restoreSegments?.find(saved => JSON.stringify(saved.words) === JSON.stringify(words));
        return restored ? { ...restored, words } : { ...segment, words, text: textOf(words) };
      });
    } else {
      const owner = segments.find(segment => segment.words.some(word => overlaps(word, edit.s, edit.e)))!;
      for (const segment of segments) segment.words = segment.words.filter(word => !overlaps(word, edit.s, edit.e));
      owner.words.push(...replacement);
      clip.transcript = segments.filter(segment => segment.words.length).map(segment => {
        segment.words.sort((a, b) => a.s - b.s || a.e - b.e);
        return { ...segment, s: segment.words[0].s, e: Math.max(...segment.words.map(word => word.e)), text: textOf(segment.words) };
      }).sort((a, b) => a.s - b.s);
    }
  }
  const words = clip.transcript!.flatMap(segment => segment.words);
  for (const take of shoot.takes) for (const attempt of take.attempts) {
    if (attempt.clipId === clipId && ordered.some(edit => overlaps(attempt, edit.s, edit.e))) {
      attempt.text = textOf(words.filter(word => overlaps(word, attempt.s, attempt.e)));
    }
  }
  // Old filler measurements must not remove a word the person has just fixed.
  clip.fillers = clip.fillers?.filter(filler => !ordered.some(edit => overlaps(filler, edit.s, edit.e)));
  shoot.updatedAt = new Date().toISOString();
  const temporary = path.join(directory, `index.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(shoot, null, 1), { flag: "wx" });
    if (fs.readFileSync(file, "utf8") !== before) throw new Error("The shoot changed while saving. Try again.");
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  // Correct current content in a new revision. Undo snapshots stay immutable.
  const cutsDirectory = path.join(directory, "sidekick", "cuts");
  const entries = fs.existsSync(cutsDirectory) ? fs.readdirSync(cutsDirectory).filter(name => name.endsWith(".json")) : [];
  for (const name of entries) {
    const cut = readCutDocumentSync(path.join(cutsDirectory, name)) as unknown as { cutId: string; versions: import("./sidekick").StoredVersion[] };  // ARCH2: head + log
    const current = await currentVersion(resolved, cut.cutId);
    for (const version of cut.versions.filter(v => v.version === current)) {
      if (!version.assembly || !(version.pieces?.some(piece => piece.clipId === clipId || piece.overlay?.clipId === clipId) ||
        version.assembly.cutList.some(item => item.seg?.clip.id === clipId))) continue;
      await finishStoredVersion(resolved, cut.cutId, version.version, true, async (record, assembly) => {
        record.assembly = assembly;
        const refreshed = resolveReelPieces(assembly.shoot, assembly.template, assembly.cutList, assembly.reel);
        record.pieces = record.pieces?.map((piece, i) => piece.clipId === clipId && piece.kind === "voice"
          ? { ...piece, words: refreshed[i]?.words ?? piece.words } : piece);
        record.titles = await rebuildSubtitles(assembly.shoot, record, assembly.template, assembly.cutList);
        if (record.overlays?.some(o => o.graphic?.words?.length)) record.overlays = await (await import("./graphics/edit")).retimeGraphicOverlays(record);  // GFX1
        record.finished = null; record.preview = null;
        await renderStoredPreview(resolved, cut.cutId, record, assembly);
      });
    }
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send("api:progress", { root: resolved, clipId, stage: clip.stage, pct: 100 });
      window.webContents.send("api:steps-changed", resolved);
    } catch { /* window closed */ }
  }
  return shoot;
}
