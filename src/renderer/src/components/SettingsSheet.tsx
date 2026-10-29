import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import type { ThemeChoice } from "../theme";
import { Captions, Gear, Look, Play, Text, Export, Note, Ask, Link, Close, Eye, Info } from "./icons";
import { Button, DialogSurface, FOCUS, useDialogFocus, useMotionPresets } from "./ui";
import { fade, instant, instantFade, pop } from "../motion";
import Skills from "../pages/Skills";
import { GeneralSettings } from "./settings/GeneralSettings";
import { CaptionsSettings } from "./settings/CaptionsSettings";
import { LookSoundSettings } from "./settings/LookSoundSettings";
import { VocabularySettings } from "./settings/VocabularySettings";
import { ExportSettings } from "./settings/ExportSettings";
import { EngineSettings } from "./settings/EngineSettings";
import { PlaybackSettings } from "./settings/PlaybackSettings";
import { AddonsSettings } from "./settings/AddonsSettings";
import { PrivacySettings } from "./settings/PrivacySettings";
import { AboutSettings } from "./settings/AboutSettings";
import "./settings/settings.css";

export const sections = [
  { id: "general", label: "General", icon: Gear },
  { id: "playback", label: "Playback", icon: Play },
  { id: "captions", label: "Captions", icon: Captions },
  { id: "look-sound", label: "Look and sound", icon: Look },
  { id: "vocabulary", label: "Words to spell right", icon: Text },
  { id: "output", label: "Export", icon: Export },
  { id: "skills", label: "Skills", icon: Note },
  { id: "ai", label: "Engine and model", icon: Ask },
  { id: "addons", label: "Add-ons", icon: Link },
  { id: "privacy", label: "Privacy", icon: Eye },  // REL2
  { id: "about", label: "About", icon: Info },     // REL2: version, licence, Licences
] as const;
type Section = typeof sections[number]["id"];

// Preserve the current page, shoot and all other hash parameters.
export function openSettings(section: Section | "extensions" | "sound" | null) {
  const [path, query = ""] = window.location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  if (section) params.set("settings", section); else params.delete("settings");
  window.location.hash = `${path || "/shoots"}${params.size ? `?${params}` : ""}`;
}
function readSection(): Section | null {
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("settings");
  if (value === "extensions") return "addons";
  if (value === "sound") return "look-sound";
  return value === null ? null : sections.find((s) => s.id === value)?.id ?? "general";
}

export function SettingsSheet({ theme, onThemeChange }: { theme: ThemeChoice; onThemeChange: (theme: ThemeChoice) => void }) {
  const [section, setSection] = useState(readSection);
  const sheet = useRef<HTMLDivElement>(null);
  const { reduced } = useMotionPresets();
  useEffect(() => {
    const onHash = () => setSection(readSection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const isOpen = section !== null;
  useDialogFocus(sheet, isOpen);

  return createPortal(<AnimatePresence>{section && (
    <motion.div className="fixed inset-0 z-[200] flex items-center justify-center bg-ground/50 p-5"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={reduced ? instant : fade}
      onClick={(event) => { if (event.target === event.currentTarget) openSettings(null); }}>
      <DialogSurface ref={sheet} tabIndex={-1} onClose={() => openSettings(null)} aria-modal="true" aria-labelledby="settings-title"
        variants={reduced ? instantFade : pop} initial="initial" animate="animate" exit="exit"
        data-settings-sheet className="glass-modal flex h-[min(680px,calc(100dvh-40px))] w-[1100px] max-w-full flex-col overflow-hidden rounded-[28px] text-body text-ink outline-none [&_button]:text-small [&_button]:transition-colors [&_button]:duration-[120ms] [&_button]:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:[&_button]:transition-none">
        <header className="flex items-center justify-between px-7 py-5">
          <h1 id="settings-title" className="font-display text-display font-semibold tracking-tight">Settings</h1>
          <Button variant="ghost" aria-label="Close settings" onClick={() => openSettings(null)}><Close size={19} /></Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Settings sections" className="flex w-[210px] shrink-0 flex-col gap-1 overflow-y-auto px-3 pb-6 max-sm:w-[116px]">
            {sections.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => openSettings(id)} aria-current={section === id ? "page" : undefined}
              className={`relative isolate flex items-center gap-2.5 rounded-xl px-3 py-3 text-left text-small ${FOCUS} ${section === id ? "font-medium text-ink" : "text-muted hover:bg-ink/[0.04] hover:text-ink"}`}>
              {section === id && <motion.span initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }} transition={reduced ? instant : fade} className="absolute inset-0 -z-10 rounded-xl bg-ink/[0.07]" />}
              <Icon size={17} className="max-sm:hidden" />{label}
            </button>)}
          </nav>
          <section aria-label={sections.find((s) => s.id === section)?.label} className="settings-content min-w-0 flex-1 overflow-y-auto px-6 pb-7 max-sm:px-3">
            <div key={section} className="settings-section mx-auto w-full max-w-[640px]">
              {section === "general" && <GeneralSettings theme={theme} onThemeChange={onThemeChange} />}
              {section === "playback" && <PlaybackSettings />}
              {section === "captions" && <CaptionsSettings />}
              {section === "look-sound" && <LookSoundSettings />}
              {section === "vocabulary" && <VocabularySettings />}
              {section === "output" && <ExportSettings />}
              {section === "skills" && <Skills />}
              {section === "addons" && <AddonsSettings />}
              {section === "ai" && <EngineSettings />}
              {section === "privacy" && <PrivacySettings />}
              {section === "about" && <AboutSettings />}
            </div>
          </section>
        </div>
      </DialogSurface>
    </motion.div>
  )}</AnimatePresence>, document.body);
}
