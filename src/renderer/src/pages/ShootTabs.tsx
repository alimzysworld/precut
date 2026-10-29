import { SectionHeader, InlineError } from "../components/ui";
import { useCallback, useEffect, useState } from "react";
import { ClipboardText } from "@phosphor-icons/react";
import type { Shoot, Take, TakeAttempt } from "../../../shared/schema";
import { getApi, isFixtureMode } from "../data";
import { Button, Card, MotionList, MotionItem, FOCUS, Pill } from "../components/ui";
import { matchesClipFilters, shootPaceThresholds, type ClipFilter } from "../components/Filters";
export interface ShootTabProps { shoot: Shoot; onShootChange: (s: Shoot) => void }
interface TakeGroup { take: Take; attempts: { att: TakeAttempt; index: number }[] }
const isPractice = (att: TakeAttempt) => !!att.practice;

export function filterTakeGroups(shoot: Shoot, filters: ClipFilter[], query: string): TakeGroup[] {
  const q = query.trim().toLowerCase();
  const clips = new Map(shoot.clips.map(clip => [clip.id, clip]));
  const takes = new Map(shoot.takes.map(take => [take.lineIndex, take]));
  const lineIndices = [...new Set([...shoot.script.map((_, index) => index), ...takes.keys()])].sort((a, b) => a - b);
  const filtering = filters.some(filter => filter.values.length > 0);
  const pace = shootPaceThresholds(shoot);
  return lineIndices.flatMap(lineIndex => {
    const lineMatches = !q || (shoot.script[lineIndex] ?? "").toLowerCase().includes(q);
    const take = takes.get(lineIndex) ?? { lineIndex, attempts: [], starred: -1, why: "" };
    const attempts = take.attempts.map((att, index) => ({ att, index })).filter(({ att, index }) => {
      const clip = clips.get(att.clipId);
      if (!lineMatches && !att.text.toLowerCase().includes(q) && !att.soundbite?.toLowerCase().includes(q)
        && !clip?.quality?.tags.some(tag => tag.label.toLowerCase().includes(q))) return false;
      return filters.every(filter => {
        if (!filter.values.length) return true;
        let matches: boolean;
        if (filter.field === "said" || filter.field === "didNotSay") {
          const said = filter.values.some(word => att.text.toLowerCase().includes(word.trim().toLowerCase()));
          matches = filter.field === "said" ? said : !said;
        } else if (filter.field === "length") {
          const seconds = att.e - att.s;
          matches = filter.values.includes(seconds < 30 ? "short" : seconds < 120 ? "medium" : "long");
        } else if (filter.field === "verdict" && filter.values.includes("best")) {
          matches = filter.values.some(value => value === "best" ? index === take.starred : clip?.judgement?.verdict === value);
        } else {
          return !!clip && matchesClipFilters(clip, [filter], { shoot, attempt: att, pace });
        }
        return filter.operator === "is" ? matches : !matches;
      });
    }).sort((a, b) => {
      // Practice always trails other attempts, even if an older pick points at it.
      const practice = Number(isPractice(a.att)) - Number(isPractice(b.att));
      if (practice) return practice;
      const starred = Number(b.index === take.starred) - Number(a.index === take.starred);
      if (starred) return starred;
      return a.att.clipId.localeCompare(b.att.clipId) || a.att.s - b.att.s;
    });
    return attempts.length || (!filtering && lineMatches) ? [{ take, attempts }] : [];
  });
}

// The original mic lives beside the source videos, outside .sidething.
// st-media's proxy URL cannot serve it. Packaged Electron uses a file origin;
// the browser preview uses fixture-relative media instead.
export function takeSoundSrc(root: string, file: string): string {
  if (/^(https?:|data:|blob:|st-media:|file:)/.test(file)) return file;
  if (isFixtureMode()) return `fixtures/${root}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const path = file.startsWith("/") ? file : `${root}/${file}`;
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function ScriptTab({ shoot, onShootChange }: ShootTabProps) {
  const [lines, setLines] = useState<string[]>(shoot.script);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setLines(shoot.script); }, [shoot.script, shoot.root]);

  const save = useCallback(async (nextLines: string[]) => {
    const clean = nextLines.map((l) => l.trim()).filter((l) => l !== "");
    if (clean.length === 0) { setError("Add at least one line first."); return; }
    setSaving(true); setError(null); setSaved(false);
    try {
      const next = await getApi().setScript(shoot.root, clean);
      onShootChange(next);
      setLines(next.script);
      setSaved(true);
      setPasteOpen(false);
      setPasteText("");
    } catch {
      setError("Could not save the script. Try again.");
    } finally { setSaving(false); }
  }, [shoot.root, onShootChange]);

  const dirty = lines.length !== shoot.script.length || lines.some((l, i) => l !== shoot.script[i]);
  return (
    <MotionList className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <SectionHeader as="h2" className="font-display text-[17px] font-semibold tracking-tight text-ink">Script</SectionHeader>
          {shoot.scriptSource === "inferred" ? <Pill tone="accent">worked out from your takes</Pill> : null}
          {shoot.scriptSource === "pasted" ? <Pill tone="neutral">pasted by you</Pill> : null}
          <span className="text-[12.5px] text-muted">{shoot.script.length} lines</span>
          <span className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => { setPasteOpen((v) => !v); setError(null); }}>
              <ClipboardText size={15} /> Paste script
            </Button>
            <Button variant="primary" disabled={!dirty || saving} onClick={() => void save(lines)}>
              {saving ? "Saving" : "Save lines"}
            </Button>
          </span>
        </div>
        {saved ? <p role="status" className="mt-2 text-[13px] text-good">Script saved.</p> : null}
        {error ? <InlineError className="mt-2 text-[13px] text-danger">{error}</InlineError> : null}
        {pasteOpen ? (
          <div className="mt-4 rounded-xl bg-ink/[0.035] p-3.5">
            <label htmlFor="st-paste-script" className="text-[13px] font-medium text-ink">Paste your script, one line per line</label>
            <textarea
              id="st-paste-script"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={8}
              placeholder={"First line\nSecond line"}
              className={`st-glass-field mt-2 w-full rounded-[10px] px-3 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-muted ${FOCUS}`}
            />
            <div className="mt-2.5 flex gap-2">
              <Button variant="primary" disabled={saving || pasteText.trim() === ""} onClick={() => void save(pasteText.split("\n"))}>
                {saving ? "Replacing" : "Replace lines"}
              </Button>
              <Button variant="ghost" onClick={() => setPasteOpen(false)}>Cancel</Button>
            </div>
            <p className="mt-2 text-[12.5px] text-muted">This replaces all {shoot.script.length} lines. Takes are matched again by line number.</p>
          </div>
        ) : null}
        <MotionList className="mt-4 flex flex-col gap-2">
          {lines.map((line, i) => (
            <MotionItem index={i} key={i} className="flex items-start gap-3">
              <span className="tnum pt-2.5 text-[12.5px] font-medium text-muted">{i + 1}</span>
              <label className="sr-only" htmlFor={`st-script-line-${i}`}>Line {i + 1}</label>
              <textarea
                id={`st-script-line-${i}`}
                value={line}
                onChange={(e) => setLines((prev) => prev.map((l, j) => (j === i ? e.target.value : l)))}
                rows={2}
                className={`st-glass-field min-w-0 flex-1 rounded-[10px] px-3 py-2.5 text-[13.5px] text-ink outline-none ${FOCUS}`}
              />
            </MotionItem>
          ))}
        </MotionList>
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={() => setLines((prev) => [...prev, ""])}>Add a line</Button>
          {dirty ? <span className="self-center text-[12.5px] text-muted">Unsaved changes</span> : null}
        </div>
      </Card>
    </MotionList>
  );
}

