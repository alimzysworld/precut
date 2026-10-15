import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plus } from "@phosphor-icons/react";
import type { Cut, CutVersion, Skill, PrecutKind, PrecutResult, Shoot, Template } from "../../../shared/schema";
import { mediaUrl } from "../../../shared/media";
import { formatDuration, getApi, isFixtureMode } from "../data";
import { useNav } from "../nav";
import { Button, Chip, EmptyState, FOCUS, useMotionPresets } from "../components/ui";
import { SidekickChat, selectSidekickCut, useSidekickWorkspace } from "../components/SidekickChat";
import { cutAspect, cutPoster, CutPreview, CutView } from "../components/CutView";

const INSTANT: { kind: PrecutKind; label: string }[] = [{ kind: "talking", label: "Talking head" }, { kind: "selects", label: "Selects" }, { kind: "broll", label: "B-roll pull" }];
type Selection = { cutId: string; version: number };
type Instant = PrecutResult & { id: string; label: string; kind: PrecutKind; createdAt: string; aspect: number };

export default function PrecutsPage() {
  const { params, go } = useNav();
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setShoot(null);
    void (async () => {
      try {
        const root = params.shoot ?? (await getApi().listShoots()).find((entry) => entry.online)?.root;
        if (!root) return;
        const loaded = await getApi().loadShoot(root);
        if (alive) setShoot(loaded);
      } catch { if (alive) setError("Couldn't load this shoot. Check its drive is connected and reopen it."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [params.shoot]);
  if (loading) return <p role="status" className="text-[13px] text-muted">Loading precuts…</p>;
  if (!shoot) return <EmptyState title="Pick a shoot first" body={error ?? "Open a shoot to find ideas and shape a cut."}><Button onClick={() => go("shoots")}>Go to folder</Button></EmptyState>;
  return <Workspace key={shoot.root} shoot={shoot} />;
}
function Workspace({ shoot }: { shoot: Shoot }) {
  const state = useSidekickWorkspace(shoot.root);
  const { page, params, go } = useNav();
  const { cut: urlCut, v: urlVersion } = params;
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [newFocused, setNewFocused] = useState(false);
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState<PrecutKind | null>(null);
  const [instants, setInstants] = useState<Instant[]>([]);
  const [instantId, setInstantId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cutsLoading, setCutsLoading] = useState(true);
  const workspace = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const makingRef = useRef(false);
  const applyingUrl = useRef<Selection | null>(null);
  const displayedSelection = useRef<Selection | null>(null);
  const tabScope = useId();
  const feed = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>();
  const { reduced, pop } = useMotionPresets();
  useEffect(() => {
    let alive = true;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const results = await getApi().listCuts(shoot.root);
        if (!alive || request !== current) return;
        setCuts([...results].sort((a, b) => (b.versions.at(-1)?.createdAt ?? "").localeCompare(a.versions.at(-1)?.createdAt ?? ""))); setError(null);
      } catch { if (alive && request === current) setError("Couldn't load the cuts. Check the drive is connected and reopen Precut."); }
      finally { if (alive && request === current) setCutsLoading(false); }
    };
    void refresh();
    void getApi().listTemplates().then((value) => { if (alive) { setTemplates(value); setTemplateId(value[0]?.id ?? ""); } }).catch(() => { if (alive) setError("Couldn't load formats. Reopen Precut to try again."); });
    void getApi().listSkills().then((value) => { if (alive) setSkills(value); }).catch(() => {});
    const off = getApi().onSidekickChanged((root) => { if (root === shoot.root) void refresh(); });
    return () => { alive = false; off(); };
  }, [shoot.root]);
  // URL changes (including browser back/forward) take precedence over the shared chat selection.
  useEffect(() => {
    if (cutsLoading) return;
    const requestedInstant = instants.find((entry) => entry.id === urlCut);
    if (requestedInstant) { setInstantId(requestedInstant.id); setNewFocused(false); return; }
    const chosen = cuts.find((entry) => entry.cutId === urlCut) ?? cuts.find((entry) => entry.cutId === state.selection?.cutId) ?? cuts[0];
    const latest = chosen?.versions.at(-1);
    if (!chosen || !latest) return;
    const requested = chosen.versions.find((entry) => entry.version === Number(urlVersion));
    const selection = { cutId: chosen.cutId, version: requested?.version ?? latest.version };
    applyingUrl.current = selection;
    selectSidekickCut(shoot.root, selection);
    setInstantId(null); setNewFocused(false);
    // Cuts refresh on chat events; only a location change should reapply the URL.
  }, [urlCut, urlVersion, cutsLoading, shoot.root]);
  useEffect(() => {
    const selected = state.selection;
    if (!selected || cutsLoading) return;
    if (applyingUrl.current && (applyingUrl.current.cutId !== selected.cutId || applyingUrl.current.version !== selected.version)) return;
    applyingUrl.current = null;
    if (!cuts.some((entry) => entry.cutId === selected.cutId)) return;
    // The page lingers while it fades out; never pull the hash back once you've left.
    if (!instantId && !newFocused && page === "precuts" && (urlCut !== selected.cutId || urlVersion !== String(selected.version))) {
      const next = { shoot: shoot.root, cut: selected.cutId, v: String(selected.version) };
      go("precuts", next);
    }
    if (displayedSelection.current?.cutId !== selected.cutId || displayedSelection.current.version !== selected.version) {
      displayedSelection.current = selected;
      setInstantId(null); setNewFocused(false);
      workspace.current?.scrollTo({ top: 0 });
    }
  }, [state.selection, cuts, cutsLoading, shoot.root, urlCut, urlVersion, go, page, instantId, newFocused]);
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !menuButton.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);
  const cut = cuts.find((entry) => entry.cutId === state.selection?.cutId) ?? cuts[0];
  const version = cut?.versions.find((entry) => entry.version === state.selection?.version) ?? cut?.versions.at(-1);
  const instant = instants.find((entry) => entry.id === instantId);
  const openCut = (cutId: string, next: number) => { feed.current?.querySelectorAll("video").forEach((video) => video.pause()); setNewFocused(false); setMenuOpen(false); applyingUrl.current = null; selectSidekickCut(shoot.root, { cutId, version: next }); setInstantId(null); };
  async function make(kind: PrecutKind, label: string) {
    if (makingRef.current || !templateId) return;
    makingRef.current = true; setMaking(kind); setError(null); setMenuOpen(false);
    try {
      const result = await getApi().makePrecut(shoot.root, kind, templateId);
      const entry = { ...result, id: `instant-${Date.now()}`, kind, label, createdAt: new Date().toISOString(), aspect: (templates.find((template) => template.id === templateId)?.width ?? 16) / (templates.find((template) => template.id === templateId)?.height ?? 9) };
      setInstants((previous) => [entry, ...previous]); setInstantId(entry.id); setNewFocused(false); go("precuts", { shoot: shoot.root, cut: entry.id });
      workspace.current?.scrollTo({ top: 0 });
    } catch { setError(`Couldn't make ${label.toLowerCase()}. Check the shoot's footage and try again.`); }
    finally { makingRef.current = false; setMaking(null); }
  }
  const cards = [...cuts.map((entry) => ({ id: entry.cutId, title: entry.versions.at(-1)?.title ?? entry.concept, lengthS: entry.versions.at(-1)?.lengthS, createdAt: entry.versions.at(-1)?.createdAt ?? "", cut: entry, instant: null as Instant | null })),
    ...instants.map((entry) => ({ id: entry.id, title: entry.label, lengthS: entry.lengthS, createdAt: entry.createdAt, cut: null as Cut | null, instant: entry }))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selectedId = newFocused ? "new" : instantId ?? cut?.cutId ?? "new";
  const cardAspect = (id: string, entryCut: Cut | null, entryInstant: Instant | null) => {
    const previewVersion = entryCut?.versions.at(-1);
    const shown = id === selectedId && entryCut ? version : previewVersion;
    return aspects[`${id}-${shown?.version ?? 0}`] ?? (entryCut && shown ? cutAspect(entryCut, shown, skills, templates) : entryInstant?.aspect ?? 9 / 16);
  };
  function focusCard(id: string) {
    if (id === selectedId) return;
    feed.current?.querySelectorAll("video").forEach((video) => video.pause());
    setMenuOpen(false);
    if (id === "new") { setNewFocused(true); return; }
    const card = cards.find((entry) => entry.id === id);
    if (card?.cut) { const latest = card.cut.versions.at(-1); if (latest) openCut(id, latest.version); }
    else if (card?.instant) { setNewFocused(false); setInstantId(id); go("precuts", { shoot: shoot.root, cut: id }); }
  }
  function centerCard(behavior: ScrollBehavior = reduced ? "auto" : "smooth") {
    const strip = feed.current;
    const card = strip?.querySelector<HTMLElement>(`[data-feed-card][data-focused="true"]`);
    if (strip && card) strip.scrollTo({ left: card.offsetLeft - 20, behavior });
  }
  useEffect(() => {
    centerCard();
    const observer = new ResizeObserver(() => centerCard("auto"));
    if (feed.current) observer.observe(feed.current);
    return () => observer.disconnect();
  }, [selectedId, version?.version, cards.length, aspects, templates, skills, reduced]);
  useEffect(() => () => clearTimeout(settleTimer.current), []);
  // Arrow keys move through the feed from anywhere on the page, except while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (!target || target.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [data-cut-feed]")) return;
      if (target.tagName === "VIDEO" || target.closest("[role='slider']")) return;
      feed.current?.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const previewSrc = (preview: string | null) => preview ? isFixtureMode() ? `fixtures/most-people-think/${preview}` : mediaUrl(shoot.root, "precuts", preview) : null;
  return <div data-precuts-workspace className="st-glass-surface grid h-full min-h-0 grid-cols-[370px_minmax(0,1fr)] overflow-hidden rounded-[24px] max-[1000px]:grid-cols-[320px_minmax(0,1fr)] max-[700px]:grid-cols-[minmax(240px,0.8fr)_minmax(0,1fr)]">
    <aside className="flex min-h-0 min-w-0 flex-col" aria-label="Sidekick">
      
      <div className="min-h-0 flex-1"><SidekickChat shoot={shoot} cutContext={instant || newFocused ? null : undefined} onCutOpen={openCut} /></div>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-col bg-ink/[0.015]" aria-label="Cut workspace">
      <div ref={workspace} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-6">
        {error ? <p role="alert" className="px-5 pt-4 text-[13px] leading-relaxed text-ink">{error}</p> : null}
        <div role="region" aria-roledescription="carousel" aria-label="Cuts" className="relative pt-4" style={{ "--preview-height": "clamp(220px, 40dvh, 380px)" } as CSSProperties}>
          <div ref={feed} data-cut-feed tabIndex={0} aria-label="Cut feed" className={`relative flex snap-x snap-mandatory scroll-pl-5 items-start gap-4 overflow-x-auto overscroll-x-contain pb-3 ${FOCUS}`} onKeyDown={(event) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || menu.current?.contains(event.target as Node)) return;
            const ids = [...cards.map((entry) => entry.id), "new"];
            const current = ids.indexOf(selectedId);
            const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : event.key === "ArrowRight" ? Math.min(current + 1, ids.length - 1) : event.key === "ArrowLeft" ? Math.max(current - 1, 0) : -1;
            if (next >= 0) {
              event.preventDefault(); focusCard(ids[next]);
              const target = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-feed-card]")).find((entry) => entry.dataset.feedCard === ids[next]);
              target?.focus({ preventScroll: true });
            }
          }} onScroll={() => {
            clearTimeout(settleTimer.current);
            // Let native momentum and scroll snapping settle before changing the URL.
            settleTimer.current = setTimeout(() => {
              const strip = feed.current;
              if (!strip) return;
              const edge = strip.scrollLeft + 20;
              const nearest = Array.from(strip.querySelectorAll<HTMLElement>("[data-feed-card]")).sort((a, b) => Math.abs(a.offsetLeft - edge) - Math.abs(b.offsetLeft - edge))[0];
              if (nearest?.dataset.feedCard) focusCard(nearest.dataset.feedCard);
            }, 160);
          }}>
            <div aria-hidden="true" className="w-1 shrink-0" />
            {cards.map((card) => {
              const focused = selectedId === card.id;
              const shown: CutVersion | undefined = focused && card.cut ? version : card.cut?.versions.at(-1);
              const src = previewSrc(shown?.preview ?? card.instant?.preview ?? (isFixtureMode() && card.instant?.kind === "talking" ? "precut-talking.mp4" : null));
              const poster = shown ? cutPoster(shoot, shown) : null;
              return <article key={card.id} id={`${tabScope}-${card.id}`} data-feed-card={card.id} data-focused={focused} tabIndex={focused ? 0 : -1} aria-label={`${card.title}${focused ? ", focused" : ""}`} aria-current={focused ? "true" : undefined}
                onClick={() => focusCard(card.id)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); focusCard(card.id); } }}
                className="relative shrink-0 snap-start rounded-2xl outline-none" style={{ width: `calc(var(--preview-height) * ${cardAspect(card.id, card.cut, card.instant)})` }}>
                <div className={reduced ? "" : "transition-[transform,opacity] duration-200"} style={{ transform: focused ? "scale(1)" : "scale(0.92)", opacity: focused ? 1 : 0.55, transformOrigin: "center center" }}>
                  <div style={{ height: "var(--preview-height)" }}>
                    <CutPreview key={`${card.id}-${shown?.version ?? 0}-${src}`} src={src} poster={poster} label={shown ? `Cut preview v${shown.version}` : `${card.title} preview`} focused={focused && page === "precuts"} onAspect={(aspect) => setAspects((previous) => previous[`${card.id}-${shown?.version ?? 0}`] === aspect ? previous : { ...previous, [`${card.id}-${shown?.version ?? 0}`]: aspect })}>
                      {!focused ? <button type="button" aria-label={`Focus ${card.title}`} tabIndex={-1} onClick={() => focusCard(card.id)} className="absolute inset-0 cursor-pointer rounded-2xl" /> : null}
                    </CutPreview>
                  </div>
                  <div className="mt-2 flex items-start justify-between gap-2"><h2 title={focused ? shown?.title ?? card.title : card.title} className="min-w-0 truncate text-[13px] font-medium text-ink">{focused ? shown?.title ?? card.title : card.title}</h2>{card.lengthS !== undefined ? <span className="tnum shrink-0 text-[12px] text-muted">{formatDuration(focused ? shown?.lengthS ?? card.lengthS : card.lengthS)}</span> : null}</div>
                </div>
                <div className="mt-3 min-h-8">{focused && card.cut ? <div role="group" aria-label="Cut versions" className="flex flex-wrap gap-1.5">{card.cut.versions.map((entry) => <Chip key={entry.version} selected={entry.version === version?.version} title={entry.feedback || "Original cut"} onClick={() => openCut(card.id, entry.version)}>v{entry.version}</Chip>)}</div> : null}</div>
              </article>;
            })}
            <article data-feed-card="new" data-focused={selectedId === "new"} tabIndex={selectedId === "new" ? 0 : -1} aria-label="New cut card" onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); focusCard("new"); setMenuOpen((value) => !value); } }} className="relative shrink-0 snap-start rounded-2xl outline-none" style={{ width: "calc(var(--preview-height) * 9 / 16)" }}>
              <button ref={menuButton} type="button" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={`${tabScope}-new`} onClick={() => { focusCard("new"); setMenuOpen((value) => !value); }} className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl bg-ink/[0.05] text-[13px] text-ink ${FOCUS}`} style={{ height: "var(--preview-height)", transform: selectedId === "new" ? "scale(1)" : "scale(0.92)", opacity: selectedId === "new" ? 1 : 0.55 }}><Plus size={24} />{making ? "Making…" : "New cut"}</button>
              <div ref={menu}>
                <AnimatePresence>{menuOpen ? <motion.div id={`${tabScope}-new`} role="menu" aria-label="New instant cut" variants={pop} initial="initial" animate="animate" exit="exit" className="st-glass-pop relative left-1/2 z-20 mt-3 w-56 -translate-x-1/2 rounded-2xl p-2" onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                  event.preventDefault(); items[next]?.focus();
                }}>
                  {INSTANT.map(({ kind, label }) => <button key={kind} role="menuitem" disabled={!!making || !templateId} onClick={() => void make(kind, label)} className={`block w-full rounded-xl px-3 py-2.5 text-left text-[13px] text-ink hover:bg-ink/[0.05] disabled:opacity-40 ${FOCUS}`}>{label}</button>)}
                  <label className="mt-2 block px-3 pb-2 text-[11px] text-muted">Format<select aria-label="Instant cut format" value={templateId} onChange={(event) => setTemplateId(event.target.value)} disabled={!!making} className={`mt-1 block w-full rounded-lg bg-ink/[0.04] px-2 py-2 text-[12px] text-ink ${FOCUS}`}>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
                </motion.div> : null}</AnimatePresence>
              </div>
            </article>
            <div aria-hidden="true" className="shrink-0" style={{ width: "max(0px, calc(50% - var(--preview-height) * 9 / 32 - 16px))" }} />
          </div>
          {cutsLoading ? <p role="status" className="px-5 text-[12px] text-muted">Loading cuts…</p> : null}
        </div>
        <div id={`${tabScope}-panel`} role="region" aria-label="Focused cut details" aria-labelledby={selectedId !== "new" ? `${tabScope}-${selectedId}` : undefined} className="px-6 pt-3">
          {selectedId === "new" ? <p className="text-[13px] text-muted">Choose a kind of cut, or tell sidekick what you're making.</p>
            : instant ? <InstantView key={instant.id} instant={instant} onError={setError} />
            : cut && version ? <CutView shoot={shoot} cut={cut} version={version.version} />
            : !cutsLoading ? <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 text-center"><p className="max-w-[320px] text-[14px] leading-relaxed text-muted">Tell sidekick what you're making, or pick an idea.</p><button className={`rounded text-[13px] text-accent ${FOCUS}`} onClick={() => go("ideas", { shoot: shoot.root })}>Go to ideas</button></div> : null}
        </div>
      </div>
    </div>
  </div>;
}
function InstantView({ instant, onError }: { instant: Instant; onError: (error: string) => void }) {
  return <div className="space-y-4">
    <p className="text-[13px] text-muted">Timeline ready for Resolve</p><p className="break-all text-[12px] text-muted">{instant.folder}</p><Button onClick={() => { void getApi().revealInFinder(instant.folder).catch(() => onError("Couldn't open the folder. Use the path shown above in Finder.")); }}>Reveal in Finder</Button>
  </div>;
}
