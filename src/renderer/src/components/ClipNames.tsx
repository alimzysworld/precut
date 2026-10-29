import { getApi } from "../data";
import { go } from "../nav";
import { Children, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CutVersion, Shoot } from '../../../shared/schema';
import { clipName, nameLegacyPieces, pieceName } from '../../../shared/clip-name';

type Reference = { name: string; piece: number; version: number; time: number };
// VO7-3: saved versions are immutable snapshots, so each one's piece names are worked out once per
// shoot. Naming a 400-version history took ~130 ms on every edit and undo; now only the version on
// screen (which may be an edit still on its way) is named fresh.
// The shoot reloads after every save; its names only change when a clip's words or summary do.
const savedNames = new Map<string, { words: string; names: Map<string, string[][]> }>();
const shootWords = (shoot: Shoot) => shoot.clips.map(c => `${c.id}:${c.judgement?.summary ?? ""}:${c.transcript?.length ?? 0}:${c.transcript?.[0]?.text ?? ""}:${c.meta?.durationS ?? ""}`).join("|");
function namesFor(shoot: Shoot): Map<string, string[][]> {
  const words = shootWords(shoot), held = savedNames.get(shoot.root);
  if (held?.words === words) return held.names;
  const names = new Map<string, string[][]>();
  savedNames.set(shoot.root, { words, names });
  return names;
}
function pieceNames(shoot: Shoot, v: CutVersion, saved: boolean, cache: Map<string, string[][]>): string[][] {
  const make = () => (v.pieces ?? []).map((p, piece) => [pieceName(shoot, v, piece), clipName(undefined, { s: p.s, e: p.e, timelineS: p.timelineS, lengthS: p.lengthS })]);
  if (!saved) return make();
  const key = `${v.version}|${v.createdAt}|${v.pieces?.length ?? 0}`;
  let names = cache.get(key);
  if (!names) { names = make(); cache.set(key, names); }
  return names;
}
const Names = createContext<{ references: Reference[]; names: string[]; select: (ref: Reference) => void } | null>(null);
export function ClipNames({ shoot, version, versions = [], onSelect, children }: { shoot: Shoot; version?: CutVersion | null; versions?: CutVersion[]; onSelect: (piece: number, time: number, version: number) => void; children: ReactNode }) {
  const selectNow = useRef(onSelect);
  selectNow.current = onSelect;
  const value = useMemo(() => {
    const ordered = [version, ...versions.filter(v => v.version !== version?.version).slice().reverse()].filter((v): v is CutVersion => !!v);
    const seen = new Set<string>(), cache = namesFor(shoot);
    const references = ordered.flatMap(v => (v.pieces ?? []).flatMap((p, piece) => {
      const names = pieceNames(shoot, v, v !== version, cache)[piece];
      return names.flatMap(name => {
        if (seen.has(name)) return [];
        seen.add(name);
        return [{ name, piece, version: v.version, time: p.timelineS }];
      });
    }));
    return { references, names: (version?.pieces ?? []).map((_, i) => pieceName(shoot, version!, i)), select: (ref: Reference) => selectNow.current(ref.piece, ref.time, ref.version) };
  }, [shoot, version, versions]);
  return <Names.Provider value={value}>{children}</Names.Provider>;
}
export function useNamedText() {
  const context = useContext(Names);
  return (text: string) => context ? nameLegacyPieces(text, context.names) : text;
}
/** Plain strings in errors, scopes, critiques and notices share navigation. */
export function NamedMessage({ children }: { children: ReactNode }) {
  const context = useContext(Names);
  if (!context) return <>{children}</>;
  return <>{Children.map(children, child => {
    if (typeof child !== 'string') return child;
    const text = nameLegacyPieces(child, context.names), result: ReactNode[] = [];
    let offset = 0;
    while (offset < text.length) {
      const matches = context.references.map(ref => ({ ref, at: text.indexOf(ref.name, offset) })).filter(m => m.at >= 0).sort((a, b) => a.at - b.at || b.ref.name.length - a.ref.name.length);
      const match = matches[0];
      if (!match) { result.push(text.slice(offset)); break; }
      result.push(text.slice(offset, match.at));
      result.push(<button key={match.at} type="button" data-shot-link={match.ref.piece} onClick={() => context.select(match.ref)} className="text-accent underline decoration-transparent hover:decoration-current focus-visible:decoration-current outline-none">{match.ref.name}</button>);
      offset = match.at + match.ref.name.length;
    }
    return result;
  })}</>;
}

/** Progress refers to source footage before an edit exists. Open its source player. */
export function SourceNames({ root, children }: { root?: string | null; children: ReactNode }) {
  const [shoot, setShoot] = useState<Shoot | null>(null);
  useEffect(() => {
    let alive = true;
    if (root) void getApi().loadShoot(root).then(value => { if (alive) setShoot(value); }).catch(() => {});
    return () => { alive = false; };
  }, [root]);
  const value = useMemo(() => {
    const source = shoot?.root === root ? shoot : null;
    const candidates = source?.clips.flatMap((clip, piece) => [...new Set([clipName(clip), clipName(undefined, { lengthS: clip.meta?.durationS })])].map(name => ({ name, piece, time: 0, version: 0 }))) ?? [];
    const counts = new Map<string, number>();
    candidates.forEach(ref => counts.set(ref.name, (counts.get(ref.name) ?? 0) + 1));
    const references = candidates.filter(ref => counts.get(ref.name) === 1);
    return { references, names: source?.clips.map(clip => clipName(clip)) ?? [], select: (ref: Reference) => {
      const clip = source?.clips[ref.piece];
      if (clip && root) go('clips', { shoot: root, clip: clip.id, t: String(ref.time) });
    } };
  }, [shoot, root]);
  return <Names.Provider value={value}>{children}</Names.Provider>;
}
