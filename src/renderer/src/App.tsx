import { useEffect, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useMotionPresets } from "./components/ui";
import { StepBar } from "./components/StepBar";
import { frameSrc, getApi } from "./data";
import { SettingsSheet } from "./components/SettingsSheet";
import { useNav } from "./nav";
import ShootsPage from "./pages/Shoots";
import ClipsPage from "./pages/Clips";
import PrecutsPage from "./pages/Precuts";
import IdeasPage from "./pages/Ideas";
import { applyTheme, storedTheme, type ThemeChoice } from "./theme";

export default function App() {
  const { page, params } = useNav();
  const [theme, setTheme] = useState<ThemeChoice>(() => storedTheme());
  const [shoot, setShoot] = useState<{ root: string; name?: string; thumbnail?: string }>();
  const root = page === "shoots" ? undefined : params.shoot;
  const shootName = (shoot?.root === root ? shoot?.name : undefined) ?? root?.split(/[\\/]/).filter(Boolean).at(-1);
  const workspace = page === "ideas" || page === "precuts";

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    if (!root) return;
    let alive = true;
    void getApi().loadShoot(root).then((loaded) => {
      // The same frame the Shoots card leads with: the strongest clip, a mid frame, so a dark setup clip never stands in for the shoot.
      const rank = (v: string | undefined) => (v === "best" ? 0 : v === "alt" ? 1 : v === "maybe" ? 2 : 3);
      const lead = [...(loaded?.clips ?? [])].filter((clip) => clip.frames.length > 0).sort((a, b) => rank(a.judgement?.verdict) - rank(b.judgement?.verdict))[0];
      const frame = lead?.frames[Math.min(4, lead.frames.length - 1)];
      if (alive) setShoot({ root, name: loaded?.name, thumbnail: frame ? frameSrc(root, frame) : undefined });
    }).catch(() => { /* the root still identifies the shoot */ });
    return () => { alive = false; };
  }, [root]);

  return (
    <div className="st-wash flex h-dvh min-h-0 flex-col overflow-hidden text-ink">
      <header className="flex h-[38px] shrink-0 items-center justify-center px-[120px]"
        style={{ WebkitAppRegion: "drag" } as CSSProperties}>
        <span className="truncate text-[12px] font-normal text-muted" title={shootName}>{shootName}</span>
      </header>
      <main className={`min-h-0 min-w-0 flex-1 ${workspace ? "overflow-hidden px-3 pt-3 pb-[68px]" : "overflow-y-auto px-6 pt-8 pb-[68px] sm:px-8"}`}>
        <div className={`relative mx-auto ${workspace ? "h-full min-h-0" : "max-w-6xl"}`}>
          <AnimatePresence initial={false}>
            <PageSurface key={page} workspace={workspace}>
              {page === "shoots" && <ShootsPage />}
              {page === "clips" && <ClipsPage />}
              {page === "ideas" && <IdeasPage />}
              {page === "precuts" && <PrecutsPage />}
            </PageSurface>
          </AnimatePresence>
        </div>
      </main>

      <StepBar page={page} root={root} shootName={shootName} thumbnail={shoot?.root === root ? shoot?.thumbnail : undefined} />
      <SettingsSheet theme={theme} onThemeChange={setTheme} />
    </div>
  );
}

// Exiting pages leave flow immediately and fade above the incoming page.
function PageSurface({ children, workspace }: { children: React.ReactNode; workspace: boolean }) {
  const present = useIsPresent();
  const { page } = useMotionPresets();
  return <motion.div variants={page} initial="initial" animate="animate" exit="exit"
    className={workspace ? "h-full min-h-0 [&>div]:!my-0 [&>div]:!h-full [&>div]:!min-h-0" : ""} data-page-surface
    style={present ? { position: "relative" } : { position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none" }}>
    {children}
  </motion.div>;
}
