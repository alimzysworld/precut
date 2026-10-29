import type { CutEdit } from './schema';

export function clickSelection<T>(current: T[], piece: T, anchor: T | null, order: T[], event: {metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean}) {
  if (event.shiftKey && anchor !== null && order.includes(anchor)) {
    const a = order.indexOf(anchor), b = order.indexOf(piece);
    const range=order.slice(Math.min(a,b),Math.max(a,b)+1);
    return event.metaKey || event.ctrlKey ? [...new Set([...current,...range])] : range;
  }
  if (event.metaKey || event.ctrlKey) return current.includes(piece) ? current.filter(p=>p!==piece) : [...current,piece];
  return [piece];
}
export function selectionBatch(pieces: number[], label: string, make: (piece:number)=>CutEdit): CutEdit {
  return {kind:'batch', label, edits:[...new Set(pieces)].sort((a,b)=>b-a).map(make)};
}
/** Build evolving-index moves for one stable, ordered group. `to` is a slot in the remaining spine. */
export function moveSelection(order: number[], selected: number[], to: number): {edit: CutEdit; order:number[]; selected:number[]} {
  const picked=order.filter(p=>selected.includes(p)), rest=order.filter(p=>!selected.includes(p));
  const target=[...rest.slice(0,to),...picked,...rest.slice(to)], evolving=[...order], edits:CutEdit[]=[];
  target.forEach((piece,index)=>{const from=evolving.indexOf(piece);if(from!==index){edits.push({kind:'move',piece:from,to:index});evolving.splice(index,0,evolving.splice(from,1)[0]);}});
  return {edit:{kind:'batch',label:`Move ${picked.length} clips`,edits},order:target,selected:picked.map(p=>target.indexOf(p))};
}
export function boxPieces(rect: {left:number;right:number;top:number;bottom:number}, blocks: {piece:number;left:number;right:number;top:number;bottom:number}[]) {
  return blocks.filter(b=>b.left<=rect.right && b.right>=rect.left && b.top<=rect.bottom && b.bottom>=rect.top).map(b=>b.piece);
}

/** Merge only the touched control, preserving each other clip's own controls. */
export function mergePatch<T>(base:T, patch:unknown):T {
  if(!patch || typeof patch!=='object' || Array.isArray(patch))return patch as T;
  const next={...(base && typeof base==='object' ? base : {})} as Record<string,unknown>;
  for(const [key,value] of Object.entries(patch))next[key]=mergePatch(next[key],value);
  return next as T;
}
export function changedPatch(before:unknown, after:unknown):Record<string,unknown> {
  const old=(before ?? {}) as Record<string,unknown>,next=(after ?? {}) as Record<string,unknown>,patch:Record<string,unknown>={};
  for(const [key,value] of Object.entries(next))if(JSON.stringify(old[key])!==JSON.stringify(value))patch[key]=value && typeof value==='object' && !Array.isArray(value) ? changedPatch(old[key],value) : value;
  return patch;
}
