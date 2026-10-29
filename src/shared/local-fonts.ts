// VO7-15: any font family installed on this Mac can style captions. Pure helpers shared by the
// renderer's picker (Local Font Access) and the main process listing (MCP and the picker's fallback).

import { isFontFamilyName } from "../main/titles/captions";

export interface FontFamily { family: string; weights: number[] }

/** The CSS weight a face's style name describes ("SemiBold Italic" is 600). */
export function weightOfStyle(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]+/g, "");
  if (/hairline|thin/.test(s)) return 100;
  if (/(extra|ultra)light/.test(s)) return 200;
  if (/(semi|demi)bold/.test(s)) return 600;
  if (/(extra|ultra)bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  if (/medium/.test(s)) return 500;
  if (/light/.test(s)) return 300;
  return 400;
}

/** Faces (from queryLocalFonts or NSFontManager) grouped by family, alphabetical, with the weights each offers. */
export function familiesFromFaces(faces: Iterable<{ family: string; style: string }>): FontFamily[] {
  const byFamily = new Map<string, Set<number>>();
  for (const face of faces) {
    // Hidden system families (".SF NS") cannot be chosen by name.
    if (!isFontFamilyName(face.family) || face.family.startsWith(".")) continue;
    const weights = byFamily.get(face.family) ?? new Set<number>();
    weights.add(weightOfStyle(face.style ?? ""));
    byFamily.set(face.family, weights);
  }
  return [...byFamily].map(([family, weights]) => ({ family, weights: [...weights].sort((a, b) => a - b) }))
    .sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: "base" }));
}
