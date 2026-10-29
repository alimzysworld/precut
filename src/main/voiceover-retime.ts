import type { VoiceoverScript } from "../shared/schema";
import type { StoredVersion } from "./sidekick";
import type { FxPlan, TimeKey } from "./edits-fx";

/** Local timing metadata travels with the sidecar; no model or wording change. */
export function timeScript<T extends VoiceoverScript>(script: T, editLengthS?: number): T & { editLengthS?: number } {
  const pace = Number.isFinite(script.wordsPerSecond) && script.wordsPerSecond > 0 ? script.wordsPerSecond : 2.5;
  const needed = (line: T["lines"][number]) => line.take ? line.take.e - line.take.s
    : line.text.trim().split(/\s+/u).filter(Boolean).length / pace;
  const lines = script.lines.map(line => ({ ...line }));
  const durations = new Map(lines.map(line => [line.id, Math.max(.01, needed(line), line.e - line.s)]));
  // The old retimer sorted by picture time and discarded the authored order.
  // Only recover its complete, numbered legacy sequence when speech collapsed.
  // Arbitrary ids and healthy authored arrays always retain their array order.
  const numbered = lines.map(l => /^line-([1-9]\d*)$/.exec(l.id)?.[1]).map(Number);
  const recover = !("editLengthS" in script) && lines.some(l => !l.take && l.e - l.s + 1e-6 < needed(l)) &&
    new Set(numbered).size === lines.length && numbered.every(n => n >= 1 && n <= lines.length) &&
    numbered.some((n, i) => n !== i + 1);
  if (recover) {
    lines.sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)));
    // A later line may have been pulled in front of the hook. Move the earlier
    // lines back to that anchor, rather than starting the hook after it.
    let anchor = Infinity;
    for (let i = lines.length - 1; i >= 0; i--) { anchor = Math.min(anchor, lines[i].s); lines[i].s = anchor; }
  }
  let cursor = 0;
  for (const line of lines) {
    const duration = durations.get(line.id)!;
    line.s = Math.max(cursor, line.s);
    line.e = line.s + duration;
    cursor = line.e + Math.max(0, line.pauseAfterS ?? 0);
  }
  return { ...script, lines, ...(editLengthS !== undefined ? { editLengthS } : {}) };
}

function interpolate(keys: TimeKey[], value: number, from: "s" | "t", to: "s" | "t"): number {
  if (value <= keys[0][from]) return keys[0][to];
  for (let i = 1; i < keys.length; i++) if (value <= keys[i][from]) {
    const a = keys[i - 1], b = keys[i];
    return a[to] + (b[to] - a[to]) * (value - a[from]) / Math.max(.001, b[from] - a[from]);
  }
  return keys.at(-1)![to];
}

/** Follow the same source picture when it moves; removed pictures fall back to
 * their relative position. Wording, line ids and recording references survive. */
export function retimeScript<T extends VoiceoverScript>(script: T, before: StoredVersion | undefined, after: StoredVersion,
  timing?: { before?: FxPlan; after: FxPlan }): T {
  if (script.version === after.version) return timeScript(script, after.lengthS);
  script = timeScript(script);
  const length = Math.max(0, after.lengthS), oldLength = before?.lengthS || length || 1;
  const spans = (record: StoredVersion, plan?: FxPlan) => {
    const { cutList, template } = record.assembly;
    let at = 0;
    return cutList.map((c, i) => {
      const rate = c.clipFpsR ? c.clipFpsR.num / c.clipFpsR.den : template.fps;
      const start = at, duration = c.durTimelineFrames / template.fps / (record.pieceFx?.[c.piece ?? i]?.speed ?? 1);
      at += duration;
      return { clipId: c.seg?.clip.id, shotId: c.seg?.clip.shot?.id, reverse: plan?.items[i].reverse ?? !!record.pieceFx?.[c.piece ?? i]?.reverse,
        keys: plan?.items[i].timeMap ?? [{ t: start, s: Number.isFinite(c.inFrames) ? c.inFrames / rate : c.seg?.s ?? 0 },
          { t: at, s: Number.isFinite(c.outFrames) ? c.outFrames / rate : c.seg?.e ?? duration }] };
    });
  };
  const previous = before ? spans(before, timing?.before) : [], nextSpans = spans(after, timing?.after);
  // SCRIPT1: a line the one before it blocked (speech order wins) remembers where the picture wanted it. While it
  // still sits where it was put, the next picture edit maps that wish, so a cut and its Restore give the same voice.
  const wanted = (line: T["lines"][number]) => line.follow && Math.abs(line.follow.at - line.s) <= 1e-6 && Number.isFinite(line.follow.want) ? line.follow.want : line.s;
  const lines = script.lines.map(placed => {
    const want = wanted(placed), line = { ...placed, s: want, e: want + placed.e - placed.s };
    const midpoint = (line.s + line.e) / 2;
    const old = previous.find(c => midpoint >= c.keys[0].t && midpoint < c.keys.at(-1)!.t);
    const bounds = (c: typeof previous[number]) => [c.keys[0].s, c.keys.at(-1)!.s];
    const sourceAt = old ? interpolate(old.keys, midpoint, "t", "s") : 0;
    const matches = old?.clipId ? nextSpans.filter(c => c.clipId === old.clipId &&
      Math.min(bounds(c)[1], bounds(old)[1]) > Math.max(bounds(c)[0], bounds(old)[0]) ||
      !!old.shotId && c.shotId === old.shotId && c.clipId !== old.clipId) : [];
    const next = matches.sort((a, b) => {
      const distance = (c: typeof a) => Math.max(bounds(c)[0] - sourceAt, sourceAt - bounds(c)[1], 0);
      return distance(a) - distance(b) ||
        Math.abs(a.keys[0].t/Math.max(.001,length)-old!.keys[0].t/oldLength)-Math.abs(b.keys[0].t/Math.max(.001,length)-old!.keys[0].t/oldLength);
    })[0];
    const map = (t: number) => {
      if (!old || !next) return t / oldLength * length;
      if (old.clipId !== next.clipId) {
        const fraction=(t-old.keys[0].t)/Math.max(.001,old.keys.at(-1)!.t-old.keys[0].t);
        return next.keys[0].t+fraction*(next.keys.at(-1)!.t-next.keys[0].t);
      }
      let sourceTime = interpolate(old.keys, t, "t", "s");
      if (old.reverse) sourceTime = bounds(old)[0] + bounds(old)[1] - sourceTime;
      if (next.reverse) sourceTime = bounds(next)[0] + bounds(next)[1] - sourceTime;
      return interpolate(next.keys, sourceTime, "s", "t");
    };
    // V66: an edge outside the shot under the line's middle keeps its distance
    // from that shot. Mapping it through the shot clamped a line spanning several
    // shots to the shot's start, so every later save moved a placed take.
    const edge = (t: number) => {
      if (!old || !next) return map(t);
      const a = old.keys[0].t, b = old.keys.at(-1)!.t;
      return t < a ? map(a) - (a - t) : t > b ? map(b) + (t - b) : map(t);
    };
    const mapped = [edge(line.s), edge(line.e)].sort((a, b) => a - b);
    // VO6: voice past the picture's end stays where it was put (the user trims it by
    // hand); clamping it to the end restacked every hand-placed piece on each save.
    const s = Math.max(0, mapped[0]), e = Math.max(s, mapped[1]);
    return { ...line, s, e };
  });
  // Picture anchors are preferences. Speech order, word time and intentional
  // pauses win, even when that means the script extends past the picture.
  const timed = timeScript({ ...script, version: after.version, lines, editLengthS: length }, length);
  return { ...timed, lines: timed.lines.map(line => {
    const want = lines.find(l => l.id === line.id)?.s, { follow: _f, ...rest } = line;
    return want !== undefined && Math.abs(want - line.s) > 1e-6 ? { ...rest, follow: { want, at: line.s } } : rest;
  }) };
}
