import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Plus } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { hoverLift } from "../motion";
import { Button, FOCUS, Img, MotionList, MotionItem, useMotionPresets, PageHeader, Pill, Skeleton } from "../components/ui";
import { formatDuration, frameSrc, getApi, isFixtureMode, shortClipId, stageLabel } from "../data";
import { useNav } from "../nav";
import { STEP_IDS, type Autopilot, type Shoot, type ShootSteps, type Stage, type StepId } from "../../../shared/schema";

const STOP_STEPS: { id: StepId; label: string }[] = [
  { id: "clips", label: "Clips" }, { id: "ideas", label: "Ideas" }, { id: "precut", label: "Precut" },
];

function AutopilotLine({ root }: { root: string }) {
  const [autopilot, setAutopilot] = useState<Autopilot>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { pop, reduced, layoutTransition } = useMotionPresets();
  useEffect(() => {
    let alive = true;
    void getApi().getAutopilot(root).then((a) => { if (alive) setAutopilot(a); }).catch(() => { if (alive) setError("Could not read autopilot settings"); });
    return () => { alive = false; };
  }, [root]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus();
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onPointer); window.removeEventListener("keydown", onKey); };
  }, [open]);
  async function toggle(id: StepId) {
    if (!autopilot || saving) return;
    const next = { ...autopilot, stopAt: autopilot.stopAt.includes(id) ? autopilot.stopAt.filter((step) => step !== id) : [...autopilot.stopAt, id] };
    setSaving(true); setError(undefined);
    try { await getApi().setAutopilot(next, root); setAutopilot(next); }
    catch { setError("Could not save. Try again."); }
    finally { setSaving(false); }
  }
  const stop = STEP_IDS.find((id) => autopilot?.stopAt.includes(id));
  const stopLabel = { folder: "folder", clips: "clips", ideas: "ideas", precut: "precut" };
  return <div ref={ref} className="relative px-5 pb-4 text-[12px] text-muted">
    {autopilot && <p>{stop ? `Stops at ${stopLabel[stop]}` : "Runs all the way to precuts"} · <button ref={trigger} type="button" aria-label="Change autopilot" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} className={`rounded text-ink hover:underline ${FOCUS}`}>change</button></p>}
    {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
    <AnimatePresence>{open && autopilot && <motion.div role="dialog" aria-label="Shoot autopilot" initial="initial" animate="animate" exit="exit" variants={pop} className="st-glass-pop absolute top-full left-5 z-30 mt-2 w-[288px] rounded-[20px] p-4">
      <p className="mb-2 text-[13px] font-medium text-ink">Pause after a step</p>
      {STOP_STEPS.map(({ id, label }) => <div key={id} className="flex items-center justify-between gap-4 py-2">
        <span><span className="block text-[13px] font-medium text-ink">{label}</span><span className="text-[11px]">Stop here for me</span></span>
        <button type="button" role="switch" aria-label={`${label}: Stop here for me`} aria-checked={autopilot.stopAt.includes(id)} disabled={saving} onClick={() => void toggle(id)} className={`flex h-6 w-10 shrink-0 items-center rounded-full p-1 disabled:opacity-50 ${autopilot.stopAt.includes(id) ? "st-brand-gradient" : "bg-ink/[0.12]"} ${FOCUS}`}>
          <motion.span layout={reduced ? false : "position"} transition={layoutTransition} className={`size-4 rounded-full bg-white ${autopilot.stopAt.includes(id) ? "ml-auto" : ""}`} />
        </button>
      </div>)}
    </motion.div>}</AnimatePresence>
  </div>;
}

interface ShootEntry {
  root: string;
  name: string;
  online: boolean;
  shoot: Shoot | null;
}

interface ProgressState {
  current: number;
  total: number;
  stage: Stage;
  pct: number;
  clipId?: string;
}

function verdictCounts(shoot: Shoot) {
  let best = 0;
  let alt = 0;
  let maybe = 0;
  let unusable = 0;
  for (const c of shoot.clips) {
    const v = c.judgement?.verdict;
    if (v === "best") best += 1;
    else if (v === "alt") alt += 1;
    else if (v === "maybe") maybe += 1;
    else if (v === "unusable") unusable += 1;
  }
  return { best, alt, maybe, unusable };
}

function cameraLine(shoot: Shoot): string {
  const withMeta = shoot.clips.find((c) => c.meta);
  if (!withMeta?.meta) return "processing";
  const m = withMeta.meta;
  const cam = (m.camera || "camera").replace("Sony ILCE-7CM2", "Sony A7C II");
  const res = m.width >= 3840 ? "4K" : `${m.width}x${m.height}`;
  return `${cam} · ${res} ${m.fps}p`;
}

export default function ShootsPage() {
  const { go } = useNav();
  const { reduced } = useMotionPresets();
  const api = useMemo(() => getApi(), []);
  const [entries, setEntries] = useState<ShootEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Record<string, ProgressState>>({});
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [steps, setSteps] = useState<Record<string, ShootSteps>>({});
  const dragDepth = useRef(0);
  const entriesRef = useRef<ShootEntry[]>([]);
  entriesRef.current = entries;

  const loadAll = useCallback(async () => {
    const list = await api.listShoots();
    const loaded: ShootEntry[] = await Promise.all(
      list.map(async (item) => {
        if (!item.online) return { ...item, shoot: null };
        try {
          const shoot = await api.loadShoot(item.root);
          return { ...item, shoot };
        } catch {
          return { ...item, shoot: null };
        }
      }),
    );
    setEntries(loaded);
    setLoading(false);
  }, [api]);

  const reloadShoot = useCallback(
    async (root: string) => {
      try {
        const shoot = await api.loadShoot(root);
        if (!shoot) return;
        setEntries((prev) => prev.map((en) => (en.root === root ? { ...en, shoot, name: shoot.name, online: true } : en)));
      } catch {
        /* keep the last known shoot */
      }
    },
    [api],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const roots = entries.filter((entry) => entry.online).map((entry) => entry.root).join("\n");
  useEffect(() => {
    let alive = true;
    const refresh = async (root: string) => {
      try {
        const value = await api.shootSteps(root);
        if (alive) setSteps((prev) => ({ ...prev, [root]: value }));
      } catch { /* keep the last known status; opening a shoot still works */ }
    };
    roots.split("\n").filter(Boolean).forEach((root) => { void refresh(root); });
    const off = api.onStepsChanged((root) => { if (roots.split("\n").includes(root)) void refresh(root); });
    return () => { alive = false; off(); };
  }, [api, roots]);

  const openShoot = (root: string) => go("ideas", { shoot: root });

  useEffect(() => {
    const off = api.onProgress((e) => {
      const entry = entriesRef.current.find((en) => en.root === e.root);
      const shoot = entry?.shoot ?? null;
      setProgress((prev) => {
        const existing = prev[e.root];
        const fixtureTotal = e.root.includes("growth") ? 16 : 12;
        const total = shoot?.clips.length ?? existing?.total ?? (isFixtureMode() ? fixtureTotal : 1);
        const idx = shoot ? shoot.clips.findIndex((c) => c.id === e.clipId) : -1;
        const fallbackNum = Number(String(e.clipId).match(/(\d+)$/)?.[1] ?? existing?.current ?? 1);
        const current = idx >= 0 ? idx + 1 : Math.min(Math.max(fallbackNum, 1), total);
        // judge arrives with pct 0 from the judge; keep the bar where it was.
        const pct = e.stage === "judge" && e.pct === 0 && existing ? existing.pct : e.pct;
        return {
          ...prev,
          [e.root]: { current: Math.min(Math.max(current, 1), total), total, stage: e.stage, pct, clipId: e.clipId },
        };
      });
      // When a clip finishes, reload that shoot so its clips appear as they finish.
      if (e.stage === "done") void reloadShoot(e.root);
    });
    return off;
  }, [api, reloadShoot]);

  const addFromPicker = useCallback(async () => {
    const root = await api.pickFolder();
    if (!root) return;
    const shoot = await api.addShoot(root);
    setAdded((prev) => new Set(prev).add(shoot.root));
    setEntries((prev) => {
      if (prev.some((e) => e.root === shoot.root)) return prev;
      return [...prev, { root: shoot.root, name: shoot.name, online: true, shoot }];
    });
    openShoot(shoot.root);
  }, [api]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      // Work out whether a folder or a plain file was dropped, where possible.
      let isDirectory: boolean | null = null;
      let entryName = file.name || "dropped shoot";
      try {
        const item = e.dataTransfer.items?.[0] as
          | { webkitGetAsEntry?: () => { isDirectory?: boolean; isFile?: boolean; name?: string } | null }
          | undefined;
        const fsEntry = item?.webkitGetAsEntry?.();
        if (fsEntry) {
          if (typeof fsEntry.isDirectory === "boolean") isDirectory = fsEntry.isDirectory;
          else if (typeof fsEntry.isFile === "boolean") isDirectory = !fsEntry.isFile;
          if (fsEntry.name) entryName = fsEntry.name;
        }
      } catch {
        /* keep the file name */
      }

      if (!isFixtureMode()) {
        // Electron: File.path is gone; the real path comes from the preload.
        if (isDirectory === false) {
          setDropNote("drop a folder, not a file");
          return;
        }
        const root = window.stFiles?.pathFor(file) ?? "";
        if (!root) {
          setDropNote("drop a folder, not a file");
          return;
        }
        // A dropped file may slip past webkitGetAsEntry in some builds; its
        // name carrying a video/document extension is not a shoot folder.
        if (isDirectory === null && /\.[a-z0-9]{2,5}$/i.test(entryName)) {
          setDropNote("drop a folder, not a file");
          return;
        }
        setDropNote(null);
        const shoot = await api.addShoot(root);
        setAdded((prev) => new Set(prev).add(shoot.root));
        setEntries((prev) => {
          if (prev.some((x) => x.root === shoot.root)) return prev;
          return [...prev, { root: shoot.root, name: shoot.name, online: true, shoot }];
        });
        openShoot(shoot.root);
        return;
      }

      const root = `dropped-${entryName}`;
      const shoot = await api.addShoot(root);
      setAdded((prev) => new Set(prev).add(shoot.root));
      // fixture addShoot may rename the root; prefer the returned shoot
      setEntries((prev) => {
        if (prev.some((x) => x.root === shoot.root)) return prev;
        return [...prev, { root: shoot.root, name: shoot.name, online: true, shoot }];
      });
      openShoot(shoot.root);
    },
    [api],
  );

  const hasShoots = entries.length > 0;

  return (
    <div
      className="relative min-h-[60vh]"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center" aria-live="polite">
          <div className="absolute inset-0" style={{ background: "color-mix(in oklab, var(--accent) 10%, transparent)" }} />
          <p className="relative rounded-full px-4 py-2 text-[14px] font-medium text-ink st-glass-pop">drop to add this shoot</p>
        </div>
      ) : null}

      <PageHeader title="Shoots">
        <Button variant="primary" onClick={() => void addFromPicker()}>
          <Plus size={15} weight="bold" /> Add shoot
        </Button>
      </PageHeader>

      {dropNote ? (
        <p role="status" className="mb-4 text-[13px] text-muted">
          {dropNote}
        </p>
      ) : null}

      {loading ? (
        <Skeleton kind="cards" count={4} />
      ) : !hasShoots ? (
        <button
          type="button"
          onClick={() => void addFromPicker()}
          className="st-glass-surface flex w-full flex-col items-center justify-center rounded-2xl px-8 py-20 text-center transition-colors hover:bg-ink/[0.03]"
        >
          <span className="flex size-12 items-center justify-center rounded-2xl bg-accent/12 text-accent">
            <FolderOpen size={22} />
          </span>
          <span className="font-display mt-5 text-[20px] font-semibold tracking-tight text-ink">Drop a shoot folder here</span>
          <span className="mt-1 text-[13.5px] text-muted">or click to choose a folder. sidething reads the clips and leaves originals alone.</span>
        </button>
      ) : (
        <MotionList className="grid gap-4 sm:grid-cols-2">
          {entries.map((entry, index) => {
            const shoot = entry.shoot;
            const prog = progress[entry.root];
            const isProcessing = Boolean(shoot?.clips.some((c) => c.stage !== "done" && c.stage !== "error")) || Object.values(steps[entry.root] ?? {}).some((step) => step.status === "working");
            const totalLength = shoot ? shoot.clips.reduce((sum, c) => sum + (c.meta?.durationS ?? 0), 0) : 0;
            const counts = shoot ? verdictCounts(shoot) : { best: 0, alt: 0, maybe: 0, unusable: 0 };
            // strip: one mid frame each from the strongest clips first, so dark setup clips do not fill it
            const rank = (v: string | undefined) => (v === "best" ? 0 : v === "alt" ? 1 : v === "maybe" ? 2 : 3);
            const stripFrames = shoot
              ? [...shoot.clips]
                  .sort((a, b) => rank(a.judgement?.verdict) - rank(b.judgement?.verdict))
                  .map((c) => c.frames[Math.min(4, c.frames.length - 1)])
                  .filter(Boolean)
                  .slice(0, 4)
              : [];
            const framesToShow = stripFrames;
            const offline = !entry.online;

            return (
              <MotionItem index={index} key={entry.root}>
              <motion.article whileHover={!offline && !reduced ? hoverLift : undefined}
                className={`st-glass-surface rounded-2xl text-left ${offline ? "opacity-55" : ""}`}
              >
                <button
                  type="button"
                  disabled={offline}
                  onClick={() => void openShoot(entry.root)}
                  className={`block w-full overflow-hidden rounded-2xl text-left disabled:cursor-not-allowed ${FOCUS}`}
                >
                  {framesToShow.length ? (
                    <div className="grid grid-cols-4 gap-px bg-ink/[0.06]">
                      {framesToShow.map((f, i) => (
                        <Img key={`${f}-${i}`} src={frameSrc(entry.root, f)} alt="" className="aspect-[16/10] w-full object-cover" loading="lazy" />
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-[72px] items-center justify-center bg-ink/[0.04] text-[12px] text-muted">{isProcessing && prog ? stageLabel(prog.stage) : "making frames"}</div>
                  )}
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-display text-[19px] leading-tight font-semibold tracking-tight text-ink">{entry.name}</h2>
                      {offline ? <Pill tone="neutral">drive not connected</Pill> : isProcessing ? <Pill tone="accent">processing</Pill> : null}
                    </div>
                    {shoot ? (
                      <>
                        <p className="mt-1 text-[13px] text-muted">
                          {shoot.clips.length} clips{totalLength > 0 ? ` · ${formatDuration(totalLength)}` : ""} · {cameraLine(shoot)}
                        </p>
                        {!isProcessing ? (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            <Pill tone="good">{counts.best} best</Pill>
                            <Pill tone="neutral">{counts.alt} alt</Pill>
                            {counts.maybe ? <Pill tone="warn">{counts.maybe} maybe</Pill> : null}
                            <Pill tone="neutral">{counts.unusable} unusable</Pill>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="mt-1 text-[13px] text-muted">{offline ? "drive not connected" : "loading"}</p>
                    )}
                    {isProcessing && prog ? (
                      <div className="mt-4">
                        <div className="flex items-center justify-between text-[12px] text-muted">
                          <span>
                            {stageLabel(prog.stage)} {prog.current} of {prog.total}
                            {prog.clipId && !isFixtureMode() ? ` · clip ${shortClipId(prog.clipId)}` : ""}
                          </span>
                          <span className="tnum">{prog.pct}%</span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/[0.08]">
                          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, prog.pct)}%` }} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </button>
                {!offline && (isProcessing || added.has(entry.root)) && <AutopilotLine root={entry.root} />}
              </motion.article>
              </MotionItem>
            );
          })}
        </MotionList>
      )}
    </div>
  );
}
