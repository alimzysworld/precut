import { useEffect, useMemo, useState } from "react";
import { CaretDown, Check, CircleNotch, FilmStrip, GearSix, Lightbulb, Scissors, WarningCircle, type Icon } from "@phosphor-icons/react";
import { motion } from "framer-motion";
import type { ShootSteps, StepId } from "../../../shared/schema";
import { getApi } from "../data";
import { spring } from "../motion";
import { go, type PageId } from "../nav";
import { openSettings } from "./SettingsSheet";
import { useMotionPresets } from "./ui";
import logoTile from "../assets/sidething-logo-tile@2x.png";

const STEPS: { page: PageId; id: StepId; label: string; icon: Icon }[] = [
  { page: "ideas", id: "ideas", label: "Ideas", icon: Lightbulb },
  { page: "clips", id: "clips", label: "Clips", icon: FilmStrip },
  { page: "precuts", id: "precut", label: "Precut", icon: Scissors },
];

// FLOATING_GLASS from the chat header's shared material, scoped to this bar.
// Keep its hairline as an inset glass edge rather than an outline border.
const FLOATING_GLASS = `
  .st-taskbar.st-glass {
    position: fixed;
    --st-glass-strong-fill: rgba(255, 255, 255, 0.86);
    --st-glass-strong-blur: blur(20px) saturate(150%);
    --st-glass-strong-rim: transparent;
    --st-glass-strong-ring: rgba(0, 0, 0, 0.08);
    --st-glass-strong-edge: transparent;
    --st-glass-strong-sheen: none;
    --st-glass-depth: 0 4px 14px rgba(15, 23, 42, 0.07);
  }
  [data-theme="dark"] .st-taskbar.st-glass {
    --st-glass-strong-fill: rgba(44, 51, 66, 0.86);
    --st-glass-strong-ring: rgba(255, 255, 255, 0.12);
    --st-glass-depth: 0 4px 14px rgba(0, 0, 0, 0.18);
  }
`;

export function StepBar({ page, root, shootName, thumbnail }: {
  page: PageId;
  root?: string;
  shootName?: string;
  thumbnail?: string;
}) {
  const api = useMemo(() => getApi(), []);
  const { reduced } = useMotionPresets();
  const [shoot, setShoot] = useState<{ root: string; steps?: ShootSteps; error?: string }>();

  useEffect(() => {
    if (!root) return;
    let alive = true;
    let request = 0;
    let lastRefresh = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      lastRefresh = Date.now();
      const current = ++request;
      try {
        const steps = await api.shootSteps(root);
        if (alive && request === current) setShoot((prev) => ({ ...(prev?.root === root ? prev : {}), root, steps, error: undefined }));
      } catch {
        if (alive && request === current) setShoot((prev) => ({ ...(prev?.root === root ? prev : {}), root, error: "Could not load step status" }));
      }
    };
    void refresh();
    const offSteps = api.onStepsChanged((changedRoot) => { if (changedRoot === root) void refresh(); });
    const offProgress = api.onProgress((event) => {
      if (event.root !== root || timer) return;
      const remaining = 1000 - (Date.now() - lastRefresh);
      if (remaining <= 0) void refresh();
      else timer = setTimeout(() => { timer = undefined; void refresh(); }, remaining);
    });
    return () => { alive = false; clearTimeout(timer); offSteps(); offProgress(); };
  }, [api, root]);

  const currentShoot = shoot?.root === root ? shoot : undefined;
  const working = Object.values(currentShoot?.steps ?? {}).find((step) => step.status === "working");
  const control = "outline-none transition-colors duration-150 hover:bg-ink/[0.06] focus-visible:bg-ink/[0.08]";
  const tooltip = "st-pop pointer-events-none absolute bottom-[calc(100%_+_12px)] left-1/2 z-[100] max-w-[320px] w-max -translate-x-1/2 rounded-xl px-3 py-2 text-[12px] font-medium text-ink opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100";
  const spinner = <motion.span className="flex shrink-0" animate={reduced ? undefined : { rotate: 360 }}
    transition={{ duration: 1, ease: "linear", repeat: Infinity }} aria-hidden="true"><CircleNotch size={13} /></motion.span>;

  return <footer aria-label="App navigation" className="st-taskbar st-glass bottom-[10px] left-3 right-3 z-[60] grid h-12 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-[16px] px-2">
    <style>{FLOATING_GLASS}</style>
    <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
      <button type="button" aria-label="sidething home" onClick={() => go("shoots", { shoot: undefined })}
        className={`size-[26px] shrink-0 rounded-[7px] ${control}`}>
        <img src={logoTile} alt="" width={26} height={26} className="size-[26px] rounded-[7px] object-contain" />
      </button>
      <button type="button" aria-label={root ? `${shootName ?? "Shoot"}, back to Shoots` : "Shoots"}
        aria-current={page === "shoots" ? "page" : undefined}
        onClick={() => go("shoots", { shoot: undefined })}
        className={`flex h-[34px] min-w-0 items-center gap-2 rounded-[10px] px-2 text-[13px] text-ink ${control}`}>
        {root && <span className="flex size-[26px] shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-ink/[0.06] text-muted">
          {thumbnail ? <img key={thumbnail} src={thumbnail} alt="" width={26} height={26} className="size-[26px] object-cover" /> : <FilmStrip size={18} aria-hidden="true" />}
        </span>}
        <span className="max-w-[220px] truncate">{root ? shootName ?? "Shoot" : "Shoots"}</span>
        {root && <CaretDown size={12} className="shrink-0 text-muted" aria-hidden="true" />}
      </button>
    </div>
    {root && <nav aria-label="Workflow" className="col-start-2 row-start-1 flex items-center gap-2">
      {STEPS.map((step) => {
        const active = page === step.page;
        const state = currentShoot?.steps?.[step.id];
        const StepIcon = step.icon;
        const note = state?.note ?? currentShoot?.error;
        return <div key={step.id} className="group relative">
          <button type="button" aria-current={active ? "step" : undefined}
            aria-label={`${step.label}${state ? `, ${state.status}` : ""}`}
            aria-describedby={note ? `step-note-${step.id}` : undefined}
            onClick={() => go(step.page)}
            className={`relative flex h-[34px] items-center gap-2 rounded-full px-[13px] text-[13px] font-medium outline-none transition-colors duration-150 ${active ? "text-white focus-visible:brightness-110" : "text-muted hover:text-ink focus-visible:bg-ink/[0.06] focus-visible:text-ink"}`}>
            {active && <motion.span layoutId={reduced ? undefined : "workflow-active"} initial={false} transition={spring.pill}
              className="st-brand-gradient absolute inset-0 rounded-full" aria-hidden="true" />}
            <StepIcon size={18} weight="fill" className="relative z-10 shrink-0" aria-hidden="true" />
            <span className="relative z-10">{step.label}</span>
            {state && state.status !== "todo" && <span className="relative z-10 flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
              {state.status === "done" && <Check size={12} weight="bold" />}
              {state.status === "working" && spinner}
              {state.status === "waiting" && <span className={`size-1.5 rounded-full ${active ? "bg-white" : "bg-accent"}`} />}
              {state.status === "stopped" && <WarningCircle size={14} weight="fill" className={active ? "text-white" : "text-warn"} />}
            </span>}
          </button>
          {note && <span id={`step-note-${step.id}`} role="tooltip" className={tooltip}>{note}</span>}
        </div>;
      })}
    </nav>}
    <div className="col-start-3 row-start-1 flex min-w-0 items-center justify-end gap-3">
      {working && <div role="status" className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
        {spinner}<span className="truncate">{working.note ?? "Working"}</span>
      </div>}
      <button type="button" aria-label="Settings" aria-haspopup="dialog" onClick={() => openSettings("general")}
        className={`flex size-[34px] shrink-0 items-center justify-center rounded-[10px] text-muted hover:text-ink focus-visible:text-ink ${control}`}>
        <GearSix size={18} weight="fill" aria-hidden="true" />
      </button>
    </div>
  </footer>;
}
