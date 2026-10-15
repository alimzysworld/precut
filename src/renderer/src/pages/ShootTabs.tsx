// Takes, Script and Audio tabs for one shoot. Rendered by the Clips page
// (part A) with { shoot, onShootChange }. Data changes go through getApi().
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ClipboardText, Star } from "@phosphor-icons/react";
import type { Shoot, TakeAttempt } from "../../../shared/schema";
import { formatDuration, formatTimecode, frameAt, getApi, shortClipId } from "../data";
import { go } from "../nav";
import { motion } from "framer-motion";
import { hoverLift } from "../motion";
import { Button, Card, Img, MotionList, MotionItem, useMotionPresets, FOCUS, Pill } from "../components/ui";

export interface ShootTabProps { shoot: Shoot; onShootChange: (s: Shoot) => void }

function AttemptCard({
  shoot, att, starred, onStar, onOpen,
}: {
  shoot: Shoot; att: TakeAttempt; starred: boolean;
  onStar: () => void; onOpen: () => void;
}) {
  const src = frameAt(shoot, att.clipId, att.s);
  const { reduced, layoutTransition } = useMotionPresets();
  const dur = att.e - att.s;
  return (
    <motion.div layout={reduced ? false : "position"} transition={{ layout: layoutTransition }} whileHover={reduced ? undefined : hoverLift} className={`st-glass-surface overflow-hidden rounded-xl text-left ${starred ? "ring-2 ring-[var(--accent)]" : ""}`}>
      <button
        type="button"
        onClick={onStar}
        disabled={starred}
        aria-label={starred ? `Starred take, clip ${att.clipId} at ${formatTimecode(att.s)}` : `Star this take, clip ${att.clipId} at ${formatTimecode(att.s)}`}
        aria-pressed={starred}
        className={`block w-full text-left disabled:cursor-default ${FOCUS}`}
      >
        <span className="relative block aspect-video w-full overflow-hidden bg-ink/[0.06]">
          {src ? <Img src={src} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
          <span className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">
            {starred ? <Star size={11} weight="fill" /> : null}
            {shortClipId(att.clipId)} · {formatTimecode(att.s)}
          </span>
          <span className="tnum absolute right-1.5 bottom-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white">{formatDuration(dur)}</span>
        </span>
        <span className="block px-2.5 pt-2 pb-1 text-[12.5px] leading-snug text-ink">{att.text || "Nothing said"}</span>
        {att.note ? <span className="block px-2.5 pb-2 text-[11.5px] text-warn">{att.note}</span> : <span className="block pb-2" />}
      </button>
      <div className="flex items-center justify-between px-2.5 pb-2">
        <span className={`text-[11.5px] font-medium ${starred ? "text-accent" : "text-muted"}`}>{starred ? "Starred" : "Tap to star"}</span>
        <button type="button" onClick={onOpen} className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium text-muted hover:bg-ink/[0.06] hover:text-ink ${FOCUS}`}>
          Open clip
        </button>
      </div>
    </motion.div>
  );
}

export function TakesTab({ shoot, onShootChange }: ShootTabProps) {
  const [busyLine, setBusyLine] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ lineIndex: number; prev: number; next: number } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((t: { lineIndex: number; prev: number; next: number }) => {
    setToast(t);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  const star = useCallback(async (lineIndex: number, attempt: number) => {
    const take = shoot.takes.find((t) => t.lineIndex === lineIndex);
    if (!take || take.starred === attempt || busyLine !== null) return;
    const prev = take.starred;
    setBusyLine(lineIndex);
    setError(null);
    try {
      const next = await getApi().starTake(shoot.root, lineIndex, attempt);
      onShootChange(next);
      showToast({ lineIndex, prev, next: attempt });
    } catch {
      setError("Could not star that take. Try again.");
    } finally {
      setBusyLine(null);
    }
  }, [shoot, busyLine, onShootChange, showToast]);

  const undo = useCallback(async () => {
    if (!toast) return;
    const { lineIndex, prev } = toast;
    setToast(null);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setBusyLine(lineIndex);
    try {
      const next = await getApi().starTake(shoot.root, lineIndex, prev);
      onShootChange(next);
    } catch {
      setError("Could not undo. Try again.");
    } finally {
      setBusyLine(null);
    }
  }, [toast, shoot.root, onShootChange]);

  const takes = [...shoot.takes].sort((a, b) => a.lineIndex - b.lineIndex);
  if (takes.length === 0) {
    return <Card><p className="text-[14px] text-muted">No takes yet. Takes appear once the shoot has been transcribed.</p></Card>;
  }
  return (
    <MotionList className="flex flex-col gap-4">
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      {takes.map((take, index) => {
        const line = shoot.script[take.lineIndex] ?? "";
        const hasClean = take.attempts.some((a) => a.text.trim() !== "" && a.note.trim() === "");
        return (
          <MotionItem index={index} key={take.lineIndex}>
          <Card className="p-0">
            <div className="px-5 pt-4 pb-3">
              <p className="text-[12px] font-medium text-muted">Line {take.lineIndex + 1} of {shoot.script.length}</p>
              <p className="font-display mt-1 text-[16px] leading-snug font-semibold tracking-tight text-ink">{line || "Untitled line"}</p>
              {take.attempts.length > 0 ? (
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                  <Star size={13} weight="fill" className="text-accent" />
                  <span>{take.why}</span>
                </p>
              ) : null}
              {take.attempts.length === 0 ? (
                <p className="mt-1.5 text-[13px] text-muted">No takes for this line yet.</p>
              ) : !hasClean ? (
                <p className="mt-1.5 text-[13px] text-warn">No clean take for this line yet. The starred one is the best of them.</p>
              ) : null}
            </div>
            {take.attempts.length > 0 ? (
              <MotionList className="grid grid-cols-2 gap-3 px-5 pb-5 sm:grid-cols-3 lg:grid-cols-4">
                {take.attempts
                  .map((att, index) => ({ att, index }))
                  .sort((a, b) => {
                    const aStar = a.index === take.starred ? 0 : 1;
                    const bStar = b.index === take.starred ? 0 : 1;
                    if (aStar !== bStar) return aStar - bStar;
                    if (a.att.clipId !== b.att.clipId) return a.att.clipId < b.att.clipId ? -1 : 1;
                    return a.att.s - b.att.s;
                  })
                  .map(({ att, index }) => (
                    <MotionItem index={index} key={`${att.clipId}-${att.s}-${index}`}>
                    <AttemptCard
                      shoot={shoot}
                      att={att}
                      starred={index === take.starred}
                      onStar={() => void star(take.lineIndex, index)}
                      onOpen={() => go("clips", { shoot: shoot.root, clip: att.clipId, t: String(Math.floor(att.s)) })}
                    />
                    </MotionItem>
                  ))}
              </MotionList>
            ) : null}
            {busyLine === take.lineIndex ? <p className="px-5 pb-4 text-[12.5px] text-muted">Saving your pick.</p> : null}
          </Card>
          </MotionItem>
        );
      })}
      {toast ? (
        <div role="status" className="st-glass-pop st-pop-in fixed bottom-6 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full py-2 pr-2 pl-4">
          <span className="flex items-center gap-1.5 text-[13px] text-ink"><Check size={14} className="text-good" /> Take starred for line {toast.lineIndex + 1}</span>
          <Button variant="secondary" onClick={() => void undo()}>Undo</Button>
        </div>
      ) : null}
    </MotionList>
  );
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
          <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">Script</h2>
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
        {error ? <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p> : null}
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

export function AudioTab({ shoot }: ShootTabProps) {
  const camChannels = shoot.clips.find((c) => c.meta)?.meta?.audioChannels ?? 2;
  return (
    <MotionList className="flex flex-col gap-4">
      <Card>
        <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">Camera audio</h2>
        <p className="mt-1 text-[13.5px] text-muted">camera audio, {camChannels} channels on every clip</p>
        <p className="mt-1 text-[12.5px] text-muted">{shoot.clips.length} clips, recorded in the camera. No sync needed.</p>
      </Card>
      {shoot.audio.length === 0 ? (
        <Card><p className="text-[14px] text-muted">No separate audio files in this shoot.</p></Card>
      ) : shoot.audio.map((a, index) => (
        <MotionItem index={index} key={a.file}><Card>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-ink">{a.file}</p>
              <p className="tnum mt-0.5 text-[12.5px] text-muted">
                {a.durationS < 2 ? `${Math.max(1, Math.round(a.durationS))} s` : formatTimecode(a.durationS)} · {a.channels} {a.channels === 1 ? "channel" : "channels"}
              </p>
            </div>
            {a.syncedTo ? <Pill tone="good">synced</Pill> : <Pill tone="warn">not from this shoot</Pill>}
          </div>
          {a.syncedTo ? (
            <p className="mt-2 text-[13px] text-muted">
              Synced to clip {shortClipId(a.syncedTo.clipId)} at {a.syncedTo.offsetS >= 0 ? "+" : ""}{a.syncedTo.offsetS.toFixed(1)} s. It will sit on its own track in a precut.
            </p>
          ) : (
            <p className="mt-2 text-[13px] text-muted">no clip in this shoot matches its sound</p>
          )}
        </Card></MotionItem>
      ))}
    </MotionList>
  );
}
