import { useEffect, useRef, useState } from "react";
import Peep, { type AccessoryType, type FaceType, type FacialHairType, type HairType } from "react-peeps";
import type { ThemeChoice } from "../theme";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CircleHalf, Moon, Shuffle, Sun, UserCircle, Check, FilmStrip, FolderOpen, GearSix, MusicNotes, Robot, SlidersHorizontal, X } from "@phosphor-icons/react";
import type { Autopilot, Engine, StepId } from "../../../shared/schema";
import { getApi } from "../data";
import Skills from "../pages/Skills";
import { Button, FOCUS, Skeleton, reducedTransition, useMotionPresets } from "./ui";
import { spring } from "../motion";

const sections = [
  { id: "general", label: "General", icon: UserCircle },
  { id: "autopilot", label: "Autopilot", icon: SlidersHorizontal },
  { id: "skills", label: "Skills", icon: FilmStrip },
  { id: "music", label: "Music", icon: MusicNotes },
  { id: "ai", label: "AI", icon: Robot },
  { id: "processing", label: "Processing", icon: GearSix },
] as const;
type Section = typeof sections[number]["id"];

// Preserve the current page, shoot and all other hash parameters.
export function openSettings(section: Section | null) {
  const [path, query = ""] = window.location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  if (section) params.set("settings", section); else params.delete("settings");
  window.location.hash = `${path || "/shoots"}${params.size ? `?${params}` : ""}`;
}
function readSection(): Section | null {
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("settings");
  return value === null ? null : sections.find((s) => s.id === value)?.id ?? "general";
}

export function SettingsSheet({ theme, onThemeChange }: { theme: ThemeChoice; onThemeChange: (theme: ThemeChoice) => void }) {
  const [section, setSection] = useState(readSection);
  const sheet = useRef<HTMLDivElement>(null);
  const { pop, reduced } = useMotionPresets();
  useEffect(() => {
    const onHash = () => setSection(readSection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const isOpen = section !== null;
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const background = [...document.body.children].filter((el) => el instanceof HTMLElement && !el.contains(sheet.current)) as HTMLElement[];
    const inert = background.map((el) => el.inert);
    background.forEach((el) => { el.inert = true; });
    sheet.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); openSettings(null); }
      if (event.key !== "Tab") return;
      // Mantine popovers use portals and manage their own keyboard focus.
      if (event.target instanceof Element && event.target.closest("[data-mantine-portal]")) return;
      const controls = [...(sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex="0"]') ?? [])].filter((el) => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === sheet.current)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      background.forEach((el, index) => { el.inert = inert[index]; });
      previous?.focus();
    };
  }, [isOpen]);

  return createPortal(<AnimatePresence>{section && (
    <motion.div className="fixed inset-0 z-[200] flex items-center justify-center bg-ground/50 p-5 backdrop-blur-sm"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={reduced ? reducedTransition : spring.soft}
      onClick={(event) => { if (event.target === event.currentTarget) openSettings(null); }}>
      <motion.div ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="settings-title"
        variants={pop} initial="initial" animate="animate" exit="exit"
        className="st-sheet flex h-[min(680px,calc(100dvh-40px))] w-[1100px] max-w-full flex-col overflow-hidden rounded-[28px] text-ink outline-none">
        <header className="flex items-center justify-between px-7 py-5">
          <h1 id="settings-title" className="font-display text-[22px] font-semibold tracking-tight">Settings</h1>
          <Button variant="ghost" aria-label="Close settings" onClick={() => openSettings(null)}><X size={19} /></Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Settings sections" className="flex w-[170px] shrink-0 flex-col gap-1 px-3 pb-6 max-sm:w-[116px]">
            {sections.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => openSettings(id)} aria-current={section === id ? "page" : undefined}
              className={`relative isolate flex items-center gap-2.5 rounded-xl px-3 py-3 text-left text-[13px] ${FOCUS} ${section === id ? "font-medium text-ink" : "text-muted hover:bg-ink/[0.04] hover:text-ink"}`}>
              {section === id && <motion.span layoutId={reduced ? undefined : "settings-section"} transition={spring.pill} className="absolute inset-0 -z-10 rounded-xl bg-ink/[0.07]" />}
              <Icon size={17} className="max-sm:hidden" />{label}
            </button>)}
          </nav>
          <section aria-label={sections.find((s) => s.id === section)?.label} className="min-w-0 flex-1 overflow-y-auto px-6 pb-7 max-sm:px-3">
            <div key={section}>
              {section === "general" && <GeneralSettings theme={theme} onThemeChange={onThemeChange} />}
              {section === "autopilot" && <AutopilotSettings />}
              {section === "skills" && <Skills />}
              {section === "music" && <MusicSettings />}
              {section === "ai" && <AISettings />}
              {section === "processing" && <ProcessingSettings />}
            </div>
          </section>
        </div>
      </motion.div>
    </motion.div>
  )}</AnimatePresence>, document.body);
}

const row = "flex min-h-[64px] items-center justify-between gap-5 rounded-2xl bg-ink/[0.035] px-5 py-4";
function Heading({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="mb-5"><h2 className="font-display text-[19px] font-semibold">{title}</h2>{children && <p className="mt-2 text-[13px] leading-relaxed text-muted">{children}</p>}</div>;
}
function ErrorLine({ error }: { error: string | null }) { return error ? <p role="alert" className="my-3 text-[13px] text-danger">{error}</p> : null; }

const NAME_KEY = "st-footage.name";
const AVATAR_KEY = "st-footage.avatar";

interface AvatarConfig {
  hair: HairType;
  face: FaceType;
  accessory?: AccessoryType;
  facialHair?: FacialHairType;
}

const AVATAR_PRESETS: AvatarConfig[] = [
  { hair: "ShortVolumed", face: "Cute" },
  { hair: "Afro", face: "Smile" },
  { hair: "LongCurly", face: "Calm" },
  { hair: "Bun", face: "Cute", accessory: "GlassRoundThick" },
  { hair: "ShortCurly", face: "Smile", facialHair: "Dali" },
  { hair: "MediumBangs", face: "Calm" },
  { hair: "Mohawk", face: "Cute" },
  { hair: "Long", face: "Smile", accessory: "GlassRoundThick" },
];

const HAIR_POOL: HairType[] = ["ShortVolumed", "Afro", "LongCurly", "Bun", "ShortCurly", "MediumBangs", "Mohawk", "Long", "Buns", "FlatTop", "Twists", "MediumShort"];
const FACE_POOL: FaceType[] = ["Cute", "Smile", "Calm"];

function randomAvatar(): AvatarConfig {
  const config: AvatarConfig = {
    hair: HAIR_POOL[Math.floor(Math.random() * HAIR_POOL.length)],
    face: FACE_POOL[Math.floor(Math.random() * FACE_POOL.length)],
  };
  if (Math.random() > 0.6) config.accessory = "GlassRoundThick";
  return config;
}

function storedAvatar(): AvatarConfig {
  try {
    const raw = window.localStorage.getItem(AVATAR_KEY);
    if (raw) return JSON.parse(raw) as AvatarConfig;
  } catch {
    /* storage unavailable */
  }
  return AVATAR_PRESETS[0];
}

function PeepAvatar({ config, size }: { config: AvatarConfig; size: number }) {
  // react-peeps centres its head group at translate(225 0) in a 600-unit
  // viewBox, which leaves the white face shape ~6% left of centre and the
  // features low. Rendering at 1.35x and shifting by (-2%, -16.2%) puts
  // the face shape's centre on the tile's centre at any size; the tile's
  // radius clips the overscan. Verified by eye across all presets.
  const scaled = size * 1.35;
  const radius = Math.max(8, Math.round(size * 0.28));
  return (
    <span
      className="relative block shrink-0 overflow-hidden bg-ink/[0.06]"
      style={{ width: size, height: size, borderRadius: radius }}
      aria-hidden="true"
    >
      <span
        className="absolute block"
        style={{ width: scaled, height: scaled, left: -size * 0.02, top: -size * 0.162 }}
      >
        <Peep
          style={{ width: scaled, height: scaled, display: "block" }}
          hair={config.hair}
          face={config.face}
          accessory={config.accessory}
          facialHair={config.facialHair}
          viewBox={{ x: "225", y: "0", width: "600", height: "600" }}
        />
      </span>
    </span>
  );
}

function GeneralSettings({ theme, onThemeChange }: { theme: ThemeChoice; onThemeChange: (theme: ThemeChoice) => void }) {
  const [name, setName] = useState(() => {
    try { return window.localStorage.getItem(NAME_KEY) || ""; }
    catch { return ""; }
  });
  const [avatar, setAvatar] = useState<AvatarConfig>(storedAvatar);
  const [avatarOptions, setAvatarOptions] = useState<AvatarConfig[]>(AVATAR_PRESETS);
  const [choosingAvatar, setChoosingAvatar] = useState(false);
  function chooseAvatar(config: AvatarConfig) {
    setAvatar(config);
    try { window.localStorage.setItem(AVATAR_KEY, JSON.stringify(config)); }
    catch { /* storage unavailable */ }
  }
  return <>
    <Heading title="General" />
    <div className="space-y-5">
      <div className="rounded-2xl bg-ink/[0.035] p-5">
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => setChoosingAvatar((value) => !value)} aria-label="Choose avatar" aria-expanded={choosingAvatar} aria-controls="avatar-options" className={`shrink-0 rounded-[14px] ${FOCUS}`}>
            <PeepAvatar config={avatar} size={50} />
          </button>
          <div className="min-w-0 flex-1">
            <label className="block text-[12px] text-muted" htmlFor="profile-name">Your name</label>
            <input id="profile-name" placeholder="Add your name" value={name} onChange={(event) => {
              setName(event.target.value);
              try { window.localStorage.setItem(NAME_KEY, event.target.value); }
              catch { /* storage unavailable */ }
            }} className={`font-display mt-1 w-full min-w-0 rounded bg-transparent text-[17px] font-semibold text-ink ${FOCUS}`} />
            <p className="mt-1 text-[12px] text-muted">footage on this Mac</p>
          </div>
          <Button variant="ghost" aria-expanded={choosingAvatar} aria-controls="avatar-options" onClick={() => setChoosingAvatar((value) => !value)}>Change picture</Button>
        </div>
        {choosingAvatar && <div id="avatar-options" className="mt-5">
          <div role="group" aria-label="Avatar" className="grid max-w-[288px] grid-cols-4 gap-2">
            {avatarOptions.map((config, index) => <button key={index} type="button" onClick={() => chooseAvatar(config)} aria-label={`Avatar ${index + 1}`} aria-pressed={JSON.stringify(config) === JSON.stringify(avatar)}
              className={`flex items-center justify-center rounded-[14px] p-1 ${JSON.stringify(config) === JSON.stringify(avatar) ? "bg-accent/15" : "hover:bg-ink/[0.06]"} ${FOCUS}`}>
              <PeepAvatar config={config} size={44} />
            </button>)}
          </div>
          <Button variant="ghost" className="mt-3" onClick={() => setAvatarOptions(Array.from({ length: 8 }, () => randomAvatar()))}><Shuffle size={15} />Shuffle</Button>
        </div>}
      </div>
      <div className={`${row} flex-wrap`}>
        <span className="text-[14px] font-medium">Theme</span>
        <div role="group" aria-label="Theme" className="flex flex-wrap gap-1 rounded-2xl bg-ink/[0.06] p-1">
          {([["light", "Light", Sun], ["dark", "Dark", Moon], ["system", "System", CircleHalf]] as const).map(([value, label, Icon]) => <button key={value} type="button" aria-pressed={theme === value} onClick={() => onThemeChange(value)}
            className={`flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] transition-colors ${theme === value ? "bg-ink text-ground" : "text-muted hover:text-ink"} ${FOCUS}`}>
            <Icon size={16} weight="fill" />{label}
          </button>)}
        </div>
      </div>
    </div>
  </>;
}

function AutopilotSettings() {
  const { reduced } = useMotionPresets();
  const [value, setValue] = useState<Autopilot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void getApi().getAutopilot().then((a) => { if (active) setValue(a); }).catch(() => { if (active) setError("Could not read autopilot settings. Reopen this section to try again."); }); return () => { active = false; }; }, []);
  async function change(next: Autopilot) {
    setBusy(true); setError(null);
    try { await getApi().setAutopilot(next); setValue(next); }
    catch { setError("Could not save autopilot settings. Try again."); }
    finally { setBusy(false); }
  }
  return <><Heading title="Autopilot">When you add a folder, sidething tags the clips, finds ideas and cuts its best ones with your skills.</Heading>
    <p className="mb-3 text-[12px] text-muted">Default for new shoots</p><ErrorLine error={error} />
    {!value && !error ? <Skeleton /> : value && <div className="space-y-2">
      {([["clips", "Clips"], ["ideas", "Ideas"], ["precut", "Precut"]] as [StepId, string][]).map(([id, label]) => <div key={id} className={row}>
        <div><p className="text-[14px] font-medium">{label}</p><p id={`stop-${id}`} className="mt-0.5 text-[12px] text-muted">Stop here for me</p></div>
        <button role="switch" aria-label={`${label}: Stop here for me`} aria-describedby={`stop-${id}`} aria-checked={value.stopAt.includes(id)} disabled={busy}
          onClick={() => void change({ ...value, stopAt: value.stopAt.includes(id) ? value.stopAt.filter((s) => s !== id) : [...value.stopAt, id] })}
          className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 disabled:opacity-45 ${value.stopAt.includes(id) ? "st-brand-gradient justify-end" : "justify-start bg-ink/15"} ${FOCUS}`}><span className="size-5 rounded-full bg-white" /></button>
      </div>)}
      <div className={`${row} mt-5`}><span className="text-[14px]">How many to cut on its own</span><div role="group" aria-label="How many to cut on its own" className="flex rounded-full bg-ink/[0.06] p-1">
        {[1, 3, 5].map((count) => <button key={count} disabled={busy} aria-pressed={value.cutCount === count} onClick={() => void change({ ...value, cutCount: count })}
          className={`relative isolate w-10 rounded-full py-1 text-[13px] ${FOCUS} ${value.cutCount === count ? "text-white" : "text-muted"}`}>
          {value.cutCount === count && <motion.span layoutId={reduced ? undefined : "autopilot-count"} transition={reduced ? reducedTransition : spring.pill} className="st-brand-gradient absolute inset-0 -z-10 rounded-full" />}{count}</button>)}
      </div></div>
    </div>}
  </>;
}
function MusicSettings() {
  const [folder, setFolder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void getApi().getMusicFolder().then((f) => { if (active) setFolder(f); }).catch(() => { if (active) setError("Could not read the music folder. Reopen this section to try again."); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  async function change(clear: boolean) {
    setBusy(true); setError(null);
    try {
      if (clear) { await getApi().setMusicFolder(null); setFolder(null); }
      else { const next = await getApi().pickMusicFolder(); if (!next) return; setFolder(next); }
      window.dispatchEvent(new Event("st-footage:music-folder-changed"));
    } catch { setError("Could not change the music folder. Try again."); }
    finally { setBusy(false); }
  }
  return <><Heading title="Music" /><ErrorLine error={error} />{loading ? <Skeleton /> : <div className="rounded-2xl bg-ink/[0.035] p-5">
    <p className="text-[14px] font-medium">Music folder</p><p className="mt-2 break-all text-[13px] text-muted">{folder ?? (error ? "Folder unavailable" : "No folder chosen")}</p>
    <div className="mt-5 flex gap-2"><Button disabled={busy} onClick={() => void change(false)}><FolderOpen size={15} />Choose folder</Button><Button variant="ghost" disabled={busy || !folder} onClick={() => void change(true)}>Clear</Button></div>
  </div>}</>;
}
function AISettings() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void getApi().getEngine().then((e) => { if (active) setEngine(e); }).catch(() => { if (active) setError("Could not read the AI engine. Reopen this section to try again."); }); return () => { active = false; }; }, []);
  async function choose(next: Engine) {
    setBusy(true); setError(null);
    try { await getApi().setEngine(next); setEngine(next); }
    catch { setError("Could not save the AI engine. Try again."); }
    finally { setBusy(false); }
  }
  return <><Heading title="AI" /><ErrorLine error={error} />{!engine && !error ? <Skeleton /> : engine && <div role="group" aria-label="AI engine" className="space-y-2">
    {([{ id: "claude", label: "Claude Code", detail: "Uses your Claude subscription" }, { id: "muse", label: "Muse", detail: "Uses your Meta AI allowance" }] as const).map((choice) => <button key={choice.id} disabled={busy} aria-pressed={engine === choice.id} onClick={() => void choose(choice.id)} className={`${row} w-full text-left ${FOCUS}`}>
      <span><span className="block text-[14px] font-medium">{choice.label}</span><span className="mt-1 block text-[12px] text-muted">{choice.detail}</span></span>{engine === choice.id && <Check size={18} className="text-accent" />}
    </button>)}
  </div>}</>;
}
function ProcessingSettings() {
  return <><Heading title="Processing" /><div className="space-y-3">
    <div className="rounded-2xl bg-ink/[0.035] p-5"><h3 className="text-[14px] font-medium">Index</h3><p className="mt-2 text-[13px]">A .sidething folder inside each shoot</p><p className="mt-1 text-[12px] leading-relaxed text-muted">The index lives with the footage, so a shoot stays searchable wherever it moves.</p></div>
    <div className="rounded-2xl bg-ink/[0.035] p-5"><h3 className="text-[14px] font-medium">Cache</h3><p className="mt-2 break-all text-[13px]">~/Library/Application Support/precut</p><p className="mt-1 text-[12px] text-muted">Thumbnails and temporary files for this app.</p></div>
  </div></>;
}
