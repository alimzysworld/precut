import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { LayoutGroup, motion } from "framer-motion";
import { spring, hoverLift } from "../motion";
import { Chip, Img, MotionList, MotionItem, useMotionPresets, FOCUS, PageHeader, Pill, Skeleton } from "../components/ui";
import { ClipPlayer, ClipTags, clipKind, clipShaky } from "../components/ClipDrawer";
import { formatDuration, formatTimecode, frameSrc, getApi, shortClipId } from "../data";
import { useNav } from "../nav";
import type { Clip, Shoot } from "../../../shared/schema";
import { AudioTab, ScriptTab, TakesTab } from "./ShootTabs";

type TabId = "clips" | "takes" | "script" | "audio";
const TABS: { id: TabId; label: string }[] = [
  { id: "clips", label: "Clips" },
  { id: "takes", label: "Takes" },
  { id: "script", label: "Script" },
  { id: "audio", label: "Audio" },
];

function verdictTone(v: string | undefined): "good" | "warn" | "danger" | "neutral" | "accent" {
  if (v === "best") return "good";
  if (v === "alt") return "accent";
  if (v === "maybe") return "warn";
  return "neutral";
}

function verdictRank(v: string | undefined): number {
  if (v === "best") return 0;
  if (v === "alt") return 1;
  if (v === "maybe") return 2;
  return 3;
}

interface SearchHit {
  clip: Clip;
  segmentText: string;
  s: number;
}

export default function ClipsPage() {
  const { params, go } = useNav();
  const { reduced } = useMotionPresets();
  const api = useMemo(() => getApi(), []);
  const shootRoot = params.shoot ?? "";
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tab: TabId = (params.tab as TabId) || "clips";
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [verdictFilter, setVerdictFilter] = useState<string>("all");
  const [shotFilter, setShotFilter] = useState<string>("all");
  const [steadyFilter, setSteadyFilter] = useState<string>("all");
  const [query, setQuery] = useState(params.q ?? "");

  useEffect(() => {
    setQuery(params.q ?? "");
  }, [params.q]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        if (!shootRoot) {
          const list = await api.listShoots();
          const first = list.find((s) => s.online) ?? list[0];
          if (first) {
            go("clips", { shoot: first.root });
            return;
          }
          throw new Error("no shoot yet");
        }
        const loaded = await api.loadShoot(shootRoot);
        if (!alive) return;
        if (!loaded) throw new Error("shoot not found");
        setShoot(loaded);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "could not load shoot");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, shootRoot, go]);

  const openClipId = params.clip ?? null;
  const openTime = params.t ? Number(params.t) : 0;
  const openClip = useMemo(() => shoot?.clips.find((c) => c.id === openClipId) ?? null, [shoot, openClipId]);

  const searchHits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q || !shoot) return [];
    const hits: SearchHit[] = [];
    for (const clip of shoot.clips) {
      for (const seg of clip.transcript ?? []) {
        if (seg.text.toLowerCase().includes(q)) {
          hits.push({ clip, segmentText: seg.text, s: seg.s });
        }
      }
    }
    return hits.slice(0, 40);
  }, [query, shoot]);

  const filteredClips = useMemo(() => {
    if (!shoot) return [];
    return shoot.clips.filter((c) => {
      const j = c.judgement;
      if (kindFilter !== "all" && clipKind(c) !== kindFilter) return false;
      if (verdictFilter !== "all" && j?.verdict !== verdictFilter) return false;
      if (shotFilter !== "all" && j?.shot !== shotFilter) return false;
      if (steadyFilter === "shaky" && clipShaky(c) !== true) return false;
      if (steadyFilter === "steady" && clipShaky(c) !== false) return false;
      return true;
    });
  }, [shoot, kindFilter, verdictFilter, shotFilter, steadyFilter]);

  const stats = useMemo(() => {
    if (!shoot) return null;
    const total = shoot.clips.reduce((s, c) => s + (c.meta?.durationS ?? 0), 0);
    const withMeta = shoot.clips.find((c) => c.meta);
    const m = withMeta?.meta;
    const cam = m?.camera ? m.camera.replace("Sony ILCE-7CM2", "Sony A7C II") : "Sony A7C II";
    const format = m ? `${m.width >= 3840 ? "4K" : `${m.width}x${m.height}`} ${m.fps}p ${m.pictureProfile?.includes("s-log3") ? "S-Log3" : m.pictureProfile ?? ""}`.trim() : "";
    return { count: shoot.clips.length, total, cam, format };
  }, [shoot]);

  const setTab = (next: TabId) => {
    go("clips", { shoot: shootRoot, tab: next === "clips" ? undefined : next, clip: params.clip, t: params.t, q: query || undefined });
  };

  const closePlayer = () => {
    go("clips", { shoot: shootRoot, tab: tab === "clips" ? undefined : tab, q: query || undefined });
  };

  const openPlayer = (clipId: string, t: number) => {
    go("clips", { shoot: shootRoot, clip: clipId, t: String(Math.round(t * 10) / 10), tab: tab === "clips" ? undefined : tab, q: query || undefined });
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Clips" />
        <Skeleton kind="cards" count={4} />
      </div>
    );
  }

  if (error || !shoot) {
    return (
      <div>
        <PageHeader title="Clips" />
        <div className="st-glass-surface rounded-2xl px-6 py-10 text-center">
          <p className="text-[14px] text-ink">{error ?? "no shoot selected"}</p>
          <button type="button" onClick={() => go("shoots")} className="mt-3 text-[13px] font-medium text-accent hover:underline">
            back to shoots
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-[90px]">
      {openClip ? <div className="sticky top-0 z-20 mb-6 h-[45dvh] overflow-hidden rounded-2xl bg-ground" data-clip-player>
        <ClipPlayer shoot={shoot} clip={openClip} initialTime={Number.isFinite(openTime) ? openTime : 0} onClose={closePlayer} onShootChange={setShoot} />
      </div> : null}

      <PageHeader title={shoot.name}>
        <span className="text-[13px] text-muted">precut</span>
      </PageHeader>

      {stats ? (
        <div className="st-glass-surface mb-5 flex flex-wrap gap-x-5 gap-y-1 rounded-2xl px-5 py-3 text-[13px] text-muted">
          <span>
            <strong className="font-semibold text-ink">{stats.count} clips</strong>
          </span>
          <span className="tnum">{formatDuration(stats.total)} total</span>
          <span>{stats.cam}</span>
          <span>{stats.format}</span>
        </div>
      ) : null}

      <LayoutGroup id="shoot-tabs">
      <div className="mb-5 flex flex-wrap items-center gap-1" role="tablist" aria-label="shoot sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`relative isolate rounded-full px-4 py-2 text-[13.5px] ${tab === t.id ? "font-medium text-ground" : "text-muted hover:bg-ink/[0.06] hover:text-ink"}`}
          >
            {tab === t.id && <motion.span layoutId={reduced ? undefined : "tab-active"} aria-hidden="true" transition={spring.pill} className="absolute inset-0 -z-10 rounded-full bg-ink" />}
            {t.label}
          </button>
        ))}
      </div>

      </LayoutGroup>

      {tab === "takes" ? (
        shoot ? <TakesTab shoot={shoot} onShootChange={setShoot} /> : null
      ) : tab === "script" ? (
        shoot ? <ScriptTab shoot={shoot} onShootChange={setShoot} /> : null
      ) : tab === "audio" ? (
        shoot ? <AudioTab shoot={shoot} onShootChange={setShoot} /> : null
      ) : (
        <>
          {/* search */}
          <div className="st-glass-field mb-4 flex items-center gap-2 rounded-full px-4 py-2">
            <MagnifyingGlass size={16} className="shrink-0 text-muted" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                go("clips", { shoot: shootRoot, q: e.target.value || undefined, clip: params.clip, t: params.t });
              }}
              placeholder="search transcripts"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted"
              aria-label="search transcripts"
            />
            {query ? (
              <button type="button" aria-label="clear search" onClick={() => setQuery("")} className="flex size-6 items-center justify-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-ink">
                <X size={13} />
              </button>
            ) : null}
          </div>

          {query.trim() ? (
            <div className="mb-6">
              <p className="mb-2 text-[12.5px] text-muted">
                {searchHits.length} result{searchHits.length === 1 ? "" : "s"} for &ldquo;{query.trim()}&rdquo;
              </p>
              {searchHits.length ? (
                <MotionList className="flex flex-col gap-1.5">
                  {searchHits.map((hit, i) => (
                    <MotionItem index={i} key={`${hit.clip.id}-${hit.s}-${i}`}>
                      <button
                        type="button"
                        onClick={() => openPlayer(hit.clip.id, hit.s)}
                        className="st-glass-surface flex w-full items-baseline gap-3 rounded-xl px-4 py-3 text-left hover:bg-ink/[0.03]"
                      >
                        <span className="font-display shrink-0 text-[15px] font-semibold text-ink">{shortClipId(hit.clip.id)}</span>
                        <span className="tnum shrink-0 text-[12px] text-muted">{formatTimecode(hit.s)}</span>
                        <span className="truncate text-[13.5px] text-ink">{hit.segmentText}</span>
                      </button>
                    </MotionItem>
                  ))}
                </MotionList>
              ) : (
                <p className="text-[13px] text-muted">nothing said that in this shoot</p>
              )}
            </div>
          ) : null}

          {/* filters */}
          <div className="mb-5 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[12px] text-muted">kind</span>
              {["all", "talking", "broll", "setup"].map((v) => (
                <Chip key={v} group="clips-kind" selected={kindFilter === v} onClick={() => setKindFilter(v)}>
                  {v === "broll" ? "b-roll" : v}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[12px] text-muted">verdict</span>
              {["all", "best", "alt", "maybe", "unusable"].map((v) => (
                <Chip key={v} group="clips-verdict" selected={verdictFilter === v} onClick={() => setVerdictFilter(v)}>
                  {v}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[12px] text-muted">shot</span>
              {["all", "wide", "medium", "close"].map((v) => (
                <Chip key={v} group="clips-shot" selected={shotFilter === v} onClick={() => setShotFilter(v)}>
                  {v}
                </Chip>
              ))}
              <span className="mx-1 h-4 w-px bg-ink/[0.1]" />
              {["all", "steady", "shaky"].map((v) => (
                <Chip key={`steady-${v}`} group="clips-steady" selected={steadyFilter === v} onClick={() => setSteadyFilter(v)}>
                  {v === "all" ? "any shake" : v}
                </Chip>
              ))}
            </div>
          </div>

          <p className="mb-3 text-[12.5px] text-muted">
            {filteredClips.length} of {shoot.clips.length} clips
          </p>

          <MotionList className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredClips.length === 0 ? (
            <div className="st-glass-surface col-span-full rounded-2xl px-6 py-12 text-center text-[14px] text-muted">no clips match those filters</div>
          ) : (
            <>
              {[...filteredClips]
                .sort((a, b) => verdictRank(a.judgement?.verdict) - verdictRank(b.judgement?.verdict))
                .map((clip, index) => {
                  const j = clip.judgement;
                  const dur = clip.meta?.durationS ?? 0;
                  const tooDark = clip.shake && !clip.shake.measured && clip.byHand?.shaky === undefined;
                  return (
                    <MotionItem index={index} key={clip.id}>
                    <motion.article whileHover={reduced ? undefined : hoverLift} className="st-glass-surface overflow-hidden rounded-2xl" data-clip-id={clip.id}>
                      <button type="button" aria-label={`Open clip ${clip.id}`} onClick={() => openPlayer(clip.id, 0)} className={`block w-full text-left ${FOCUS}`}>
                        <div className="grid grid-cols-4 gap-px bg-ink/[0.06]">
                          {(clip.frames.slice(0, 4).length ? clip.frames.slice(0, 4) : ["", "", "", ""]).map((f, i) =>
                            f ? (
                              <Img key={i} src={frameSrc(shoot.root, f)} alt="" className="aspect-[16/10] w-full object-cover" loading="lazy" />
                            ) : (
                              <div key={i} className="flex aspect-[16/10] items-center justify-center bg-ink/[0.05] text-[10px] text-muted">frame</div>
                            ),
                          )}
                        </div>
                        <div className="p-4">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-display text-[26px] leading-none font-semibold tracking-tight text-ink">{shortClipId(clip.id)}</span>
                            <span className="tnum text-[12.5px] text-muted">{formatDuration(dur)}</span>
                          </div>
                        </div>
                      </button>
                        <div className="px-4 pb-4">
                          <div className="flex flex-wrap gap-1.5">
                            {j ? <Pill tone={verdictTone(j.verdict)}>{j.verdict}</Pill> : null}
                            <ClipTags shoot={shoot} clip={clip} onShootChange={setShoot} />
                            {j && j.shot !== "unknown" ? <Pill tone="neutral">{j.shot}</Pill> : null}
                            {tooDark ? <Pill tone="neutral">too dark to judge</Pill> : null}
                            {clip.stage === "error" ? <Pill tone="danger">cannot read this format yet</Pill> : null}
                          </div>
                          {j?.summary ? <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-muted">{j.summary}</p> : null}
                        </div>
                    </motion.article>
                    </MotionItem>
                  );
                })}
            </>
          )}
          </MotionList>
        </>
      )}

    </div>
  );
}
