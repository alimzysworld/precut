import type { CutVersion, PieceLook } from './schema';
/** One source correction below each occurrence's creative look. */
export function balancedLook(version: Pick<CutVersion, 'balances' | 'pieceFx'>, clipId: string, piece: number, preview?: PieceLook | null): PieceLook | null {
  const look = preview === undefined ? version.pieceFx?.[piece]?.look : preview;
  const balance = version.balances?.[clipId];
  if (!balance) return look ?? null;
  // Basic controls are source-owned once corrected; a live slider preview replaces them.
  return { ...look, basic: preview === undefined ? balance.basic : preview?.basic ?? balance.basic };
}

/** Legacy Match becomes a reference choice on read. Opening never calls a model. */
export function legacyBalanceVersion<T extends CutVersion>(version:T):T {
  if(!version.grade?.matchClips)return version;
  const assembly=(version as T & {assembly?:{cutList:{seg?:{clip:{id:string}}|null}[];reel:{broll:{seg:{clip:{id:string}}}[]}}}).assembly;
  const sources=assembly ? [...assembly.cutList.map(c=>c.seg?.clip.id),...assembly.reel.broll.map(c=>c.seg.clip.id)] : undefined;
  const reference=version.grade.matchRef==null ? null : sources?.[version.grade.matchRef] ?? version.pieces?.[version.grade.matchRef]?.clipId ?? null;
  return {...version,balanceReference:reference,grade:{...version.grade,matchClips:false}};
}
