import { pieceName } from "../../../../shared/clip-name";
import { NamedMessage } from "../ClipNames";
import { MissingMediaBanner } from "../MissingMediaBanner";
import { LeftOutGroup } from "../LeftOutGroup";
import { ClipMenu } from "../ClipMenu";
import { JunkReview } from "../JunkReview";
import { FailedClips } from "../FailedClips";
import { SegmentedControl } from "../ui";
import { EmptyState } from "../ui";
import { SearchField } from "../ui";
import { InlineError, Row, Tile, SectionHeader } from "../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Funnel, Waveform, FilmStrip, VideoCamera, Monitor, Image, Package } from "@phosphor-icons/react";
import type { Cut, CutEdit, CutVersion, Shoot } from "../../../../shared/schema";
import { filmedOrder } from "../../../../main/filmed-time";
import { getApi } from "../../data";
import { useNav } from "../../nav";
import { Button, FOCUS, Skeleton } from "../ui";
import { Composer } from "../Composer";
import { ClipViewsTitle, Filters, matchesClipFilters, shootPaceThresholds, useClipViews } from "../Filters";
import { ScriptTab, filterTakeGroups } from "../../pages/ShootTabs";
import { ShortcutSheet } from "../ShortcutSheet";
import { useShortcuts } from "../../hooks/useShortcuts";
import { AudioRecordings } from "../footage/AudioRecordings";
import { TakeRow } from "../footage/TakeRow";
import { Inspector } from "../footage/Inspector";
import { rememberSelection, selectedKeys } from "../footage/selection";
import { itemStarred, clipItem, defaultView, footageShortcuts, scriptItems, shotGroups, type FootageItem, type FootageView } from "../footage/model";
import { layoutReplacementGroups,layoutReplacementEdit,replaceClipGroups, mediaItem, librarySearchScores, libraryItemRank, rankLibraryGroups } from "./model";
import { sourceRange, writeSourceDrag, type SourceRange } from "./source";
export type MediaLibraryContext = { shoot: Shoot; cuts: Cut[]; version: CutVersion; replacePiece?: number | null; busy: boolean;
  replaceLayout?: import('../../../../shared/schema').LayoutChoice; layoutTopic?: string;
  onSource?: (item: FootageItem) => void; source?: SourceRange | null; getSource?: () => SourceRange | null; onEscape?: () => void;
  onEdit: (edit: CutEdit) => unknown; onClose: () => void; onShootChange: (shoot: Shoot) => void };
const countOf = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

declare module "../../nav" { interface NavParams { line?: string } }
type LocalMarks = Record<string, { star?: boolean; review?: "keep" | "maybe" | "pass"; note?: string }>;
function stored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}
// FIX5: Precuts says when a save of the open edit is in flight until the commit that draws it ("precut:edit-saving").
const editSaving = { now: false, since: 0 };
if (typeof window !== "undefined") window.addEventListener("precut:edit-saving", event => { const next = !!(event as CustomEvent<boolean>).detail; if (next && !editSaving.now) editSaving.since = Date.now(); editSaving.now = next; });
// FIX5: Precuts announces each listing it starts ("precut:cuts-listing"). A Library read asked for before that listing
// started uses it instead of starting its own; `order` is program order, so a listing that began earlier never counts.
let order = 0;
// Timers where the host has them (a bare harness runs the read at once).
const later = (fn: () => void, ms: number): number | undefined => typeof setTimeout === "function" ? setTimeout(fn, ms) as unknown as number : (fn(), undefined);
const cancel = (id?: number) => { if (id !== undefined && typeof clearTimeout === "function") clearTimeout(id); };
const sharedListing: { root: string; order: number; cuts: Promise<Cut[]> | null } = { root: "", order: 0, cuts: null };
if (typeof window !== "undefined") window.addEventListener("precut:cuts-listing", event => { const { root, cuts } = (event as CustomEvent<{ root: string; cuts: Promise<Cut[]> }>).detail; Object.assign(sharedListing, { root, order: ++order, cuts }); });
export function LibraryView({ root, media }: { root: string; media?: MediaLibraryContext }) {
  const api = useMemo(() => getApi(), []);
  const { page, params: routeParams, go } = useNav();
  const params = media ? {} : routeParams;
  const [shoot, setShoot] = useState<Shoot | null>(media?.shoot ?? null);
  const shootNow = useRef(shoot); shootNow.current = shoot;
  const [cuts, setCuts] = useState<Cut[]>(media?.cuts ?? []), [usageKnown, setUsageKnown] = useState(!!media);
  const [error, setError] = useState(""), [loading, setLoading] = useState(!media);
  const [filtersOpen, setFiltersOpen] = useState(false), [inspectorOpen, setInspectorOpen] = useState(() => !!params.clip), [help, setHelp] = useState(false);
  const [viewChoice, setViewChoice] = useState<FootageView | null>(() => {
    if (media) return "scenes";
    const value = stored<unknown>(`st-footage.view:${root}`, null);
    return value === "scenes" || value === "script" || value === "shot" ? value : null;
  });
  const [scoped, setScoped] = useState(media?.replacePiece != null||!!media?.replaceLayout);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [playRequest, setPlayRequest] = useState(0);
  const [selected, setSelected] = useState<Map<string, FootageItem>>(() => new Map());
  const [marks, setMarks] = useState<LocalMarks>(() => {
    const value = stored<unknown>(`st-footage.marks:${root}`, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value as LocalMarks : {};
  });
  const [storageError, setStorageError] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const busyRef = useRef(false), alive = useRef(false), serial = useRef(0);
  const search = useRef<HTMLInputElement>(null), host = useRef<HTMLDivElement>(null), inspectorHost = useRef<HTMLElement>(null);
  const [selectedItem, setSelectedItem] = useState<FootageItem | null>(null);
  const views = useClipViews(params.q);
  const { query, setQuery, filters } = views;
  const typeFilters = filters.filter(f => f.field === "kind" || f.field === "shotType");
  const category = typeFilters.length === 1 && typeFilters[0].operator === "is" && typeFilters[0].values.length === 1 ? typeFilters[0].values[0] : typeFilters.length ? null : "all";
  function filterCategory(id: string) {
    views.setFilters(previous => {
      const rest = previous.filter(f => f.field !== "kind" && f.field !== "shotType");
      return id === "all" || category === id ? rest : [...rest, { field: id === "screen" || id === "audio" ? "shotType" : "kind", operator: "is", values: [id] }];
    });
  }
  const previousQuery = useRef(params.q);
  useEffect(() => { if (params.q !== previousQuery.current) setQuery(params.q ?? ""); previousQuery.current = params.q; }, [params.q, setQuery]);
  useEffect(() => { if (media) { setShoot(media.shoot); setCuts(media.cuts); } }, [media?.shoot, media?.cuts]);
  useEffect(() => {
    alive.current = true;
    if (media) return () => { alive.current = false; serial.current++; };
    let active = true, request = 0, cutRequest = 0;
    const refresh = async () => {
      const id = ++request;
      try {
        if (!root) {
          if (page !== "clips") return;
          const list = await api.listShoots();
          const first = list.find(s => s.online) ?? list[0];
          if (active && first) { go("clips", { shoot: first.root }); return; }
          throw new Error("No shoot yet. Add a shoot to see All footage");
        }
        const value = await api.loadShoot(root);
        if (active && id === request) { if (!value) throw new Error("Shoot not found."); if (JSON.stringify(shootNow.current) !== JSON.stringify(value)) setShoot(value); setError(""); }  // FIX5: compared here, never inside a render
      } catch (e) { if (active && id === request) setError(e instanceof Error ? e.message : "Could not load footage."); }
      finally { if (active && id === request) setLoading(false); }
    };
    const refreshCuts = async (listed?: Promise<Cut[]>) => {
      const id = ++cutRequest;
      try { const value = await (listed ?? api.listCuts(root)); if (active && id === cutRequest) { setCuts(value); setUsageKnown(true); } }
      catch { if (active && id === cutRequest) setUsageKnown(false); }
    };
    // FIX5: a notice, steps, activity, progress and the 2 s poll each ask for one coalesced read. While a save of the open
    // edit is being drawn the read waits (2 s at most), then runs in idle time: a save costs one listing and one shoot read here.
    const want = { shoot: false, cuts: false, asked: 0 };
    let wait: number | undefined, idle: number | undefined;
    const run = () => {
      idle = undefined; wait = undefined; const next = { ...want }; want.shoot = want.cuts = false;
      if (next.shoot) void refresh();
      if (next.cuts && root) void refreshCuts(sharedListing.root === root && sharedListing.order > next.asked ? sharedListing.cuts ?? undefined : undefined);
    };
    const plan = () => {
      if (!active || wait !== undefined || idle !== undefined || !(want.shoot || want.cuts)) return;
      wait = -1;
      const id = later(() => { wait = undefined; idle = -1; const next = typeof requestIdleCallback === "function" ? requestIdleCallback(run, { timeout: 200 }) : later(run, 0); if (idle === -1) idle = next; },
        editSaving.now ? Math.max(0, editSaving.since + 2000 - Date.now()) : 50);
      if (wait === -1) wait = id;
    };
    const ask = (shoot: boolean, cuts: boolean) => { want.shoot ||= shoot; if (cuts && !want.cuts) { want.cuts = true; want.asked = ++order; } plan(); };
    const saving = () => { if (wait !== undefined) { cancel(wait); wait = undefined; plan(); } };
    window.addEventListener("precut:edit-saving", saving);
    void refresh(); if (root) void refreshCuts();
    const off = api.onProgress(event => { if (event.root === root) ask(true, false); });
    const steps = api.onStepsChanged(changed => { if (changed === root) ask(true, true); });
    // A finished job that changed an edit says so with its own notice (sidekick or steps), so here only the shoot is read.
    const activity = api.onActivity(event => { if (event.root === root && event.state !== "running" && !event.label.startsWith("Preparing footage thumbnails")) ask(true, false); });
    const sidekick = api.onSidekickChanged(changed => { if (changed === root) ask(false, true); });
    const timer = window.setInterval(() => ask(true, false), 2000);
    return () => { active = false; alive.current = false; serial.current++; off(); steps(); activity(); sidekick(); window.clearInterval(timer); cancel(wait); if (idle !== undefined) { if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle); else cancel(idle); } window.removeEventListener("precut:edit-saving", saving); };
  }, [api, root, go, page]);
  function mark(key: string, value: LocalMarks[string]) {
    setMarks(previous => {
      const next = { ...previous, [key]: { ...previous[key], ...value } };
      try { localStorage.setItem(`st-footage.marks:${root}`, JSON.stringify(next)); setStorageError(""); }
      catch { setStorageError("Your notes and review marks could not be saved on this Mac."); }
      return next;
    });
  }
  const migratedStars = useRef(false);
  useEffect(() => {
    if (media || !shoot || migratedStars.current || busyRef.current) return;
    migratedStars.current = true;
    const legacy = Object.entries(marks).filter(([, mark]) => typeof mark.star === "boolean");
    if (!legacy.length) return;
    busyRef.current = true;
    void (async () => {
      try {
        let next = shoot;
        const valid = new Set([...shoot.clips.map(c => c.id), ...shoot.takes.flatMap(t => t.attempts.map((_, index) => `L${t.lineIndex + 1}A${index + 1}`))]);
        for (const [key, value] of legacy.sort((a, b) => Number(a[1].star) - Number(b[1].star))) {
          if (!valid.has(key)) continue;
          next = await api.setFootageStar(root, key, value.star!);
        }
        if (!alive.current) return;
        setShoot(next);
        setMarks(previous => {
          const clean = Object.fromEntries(Object.entries(previous).map(([key, { star: _star, ...value }]) => [key, value]));
          try { localStorage.setItem(`st-footage.marks:${root}`, JSON.stringify(clean)); }
          catch { setStorageError("Your notes and review marks could not be saved on this Mac."); }
          return clean;
        });
      } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : "Could not save your stars."); }
      finally { busyRef.current = false; }
    })();
  }, [shoot, api, root, marks]);
  const requestedLine = params.line && /^[1-9]\d*$/.test(params.line) ? Number(params.line) - 1 : null;
  const view = requestedLine !== null || params.tab === "takes" || params.tab === "script" ? "script" : viewChoice ?? (shoot ? defaultView(shoot) : "shot");
  const searchScores = useMemo(() => shoot ? librarySearchScores(shoot, query) : new Map<string, number>(), [shoot, query]);
  const baseGroups = useMemo(() => {
    if (!shoot) return [];
    const footage = { ...shoot, clips: shoot.clips.filter(c => !c.leftOut) };
    const pace = shootPaceThresholds(footage), q = query.trim().toLowerCase();
    const matches = (clip: Shoot["clips"][number]) => matchesClipFilters(clip, filters, { shoot: footage, pace }) && (!q || (searchScores.get(clip.id) ?? 0) > 0);
    if(media?.replaceLayout&&scoped)return layoutReplacementGroups({...footage,clips:footage.clips.filter(matches)},media.replaceLayout,media.layoutTopic??'');
    // BUG1: one shared list (newest read first, search over every clip), the same one MCP list_replacements returns.
    if (media && scoped && media.replacePiece != null) return replaceClipGroups(footage, media.version, media.replacePiece, query, clip => matchesClipFilters(clip, filters, { shoot: footage, pace }));
    if (view === "script") {
      const matchingFilters = new Set(filterTakeGroups(footage, filters, "").flatMap(g => g.attempts.map(a => `L${g.take.lineIndex + 1}A${a.index + 1}`)));
      const allowed = new Set(filterTakeGroups(footage, filters, query).flatMap(g => g.attempts.map(a => `L${g.take.lineIndex + 1}A${a.index + 1}`)));
      return scriptItems(footage).map(g => ({ ...g, items: g.items.filter(item => allowed.has(item.key) || matchingFilters.has(item.key) && matches(item.clip) || item.lineIndex === requestedLine && matchesClipFilters(item.clip, filters, { shoot: footage, pace, attempt: item.attempt })) })).filter(g => g.items.length);
    }
    const clips = filmedOrder(footage.clips.filter(matches), clip => clip);
    if (view === "shot") return shotGroups(clips).filter(g => g.clips.length).map(g => ({ id: g.id, name: g.name, items: g.clips.map(clip => clipItem(footage, clip)) }));
    // Main attaches measured scenes on load. Browser fixtures without this additive
    // field remain honest: ungrouped footage, never synthetic scene discoveries.
    const scenes = (footage as Shoot & { scenes?: { id: string; name: string; recordedAt?: string | null; clipIds: string[] }[] }).scenes;
    if (!scenes) return clips.length ? [{ id: "ungrouped", name: "Footage not grouped into scenes yet", items: clips.map(clip => clipItem(footage, clip)) }] : [];
    const byId = new Map(clips.map(clip => [clip.id, clip]));
    return filmedOrder(scenes.map(scene => ({ id: scene.id, name: scene.name, subtitle: scene.recordedAt && !/\b\d{2}:\d{2}\b/.test(scene.name) ? new Date(scene.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null, items: filmedOrder(scene.clipIds.flatMap(id => { const clip = byId.get(id); return clip ? [clipItem(footage, clip)] : []; }), item => item.clip) })).filter(g => g.items.length), group => group.items[0].clip);
  }, [shoot, filters, query, searchScores, view, requestedLine, !!media, scoped, media?.version, media?.replacePiece,media?.replaceLayout,media?.layoutTopic]);
  const groups = useMemo(() => {
    if (!shoot) return baseGroups;
    if(media&&scoped&&(media.replaceLayout||media.replacePiece!=null))return baseGroups;
    const mapped = media ? baseGroups.map(group => ({ ...group, items: group.items.map(item => mediaItem(shoot, item)) })) : baseGroups;
    return query.trim() ? rankLibraryGroups(shoot, mapped, searchScores) : mapped;
  }, [baseGroups, shoot, !!media, query, searchScores,media?.replaceLayout,scoped]);
  const librarySections = useMemo(() => {
    if (media && scoped || view !== "scenes") return [{ id: "all", name: null as string | null, groups }];
    const places = new Map<string, { id: string; name: string | null; groups: typeof groups }>();
    for (const group of groups) {
      const place = group.items[0]?.clip.place;
      const id = place ? place.name || `${place.lat.toFixed(3)},${place.lon.toFixed(3)}` : "unknown";
      const entry = places.get(id) ?? { id, name: place?.name || (place ? `${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}` : "Place not recorded"), groups: [] };
      entry.groups.push(group); places.set(id, entry);
    }
    const rank = (groups: typeof baseGroups) => Math.max(...groups.flatMap(group => group.items.map(item => libraryItemRank(shoot!, item, searchScores))));
    return [...places.values()].map(place => ({ ...place, groups: [...place.groups].sort((a,b) => query.trim() ? rank([b]) - rank([a]) : Number(a.items.every(i => i.clip.missing)) - Number(b.items.every(i => i.clip.missing))) })).sort((a,b) => query.trim() ? rank(b.groups) - rank(a.groups) : Number(a.groups.every(g => g.items.every(i => i.clip.missing))) - Number(b.groups.every(g => g.items.every(i => i.clip.missing))));
  }, [groups, shoot, searchScores, query, view, !!media, scoped]);
  const items = useMemo(() => { const all = groups.flatMap(g => g.items); return media ? [...new Map(all.map(item => [item.key, item])).values()] : all; }, [groups, !!media]);
  const inEdit = useMemo(() => media ? new Set(media.version.pieces?.flatMap(piece => [piece.clipId, ...(piece.overlay ? [piece.overlay.clipId] : [])])) : undefined, [media?.version]);
  const selectionAnchor = useRef<string | null>(null);
  function selectByClick(event: React.MouseEvent) {
    if (media) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-take-open]');
    if (!target) return;
    const item = items.find(i => i.key === target.dataset.takeOpen);
    if (!item) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault(); event.stopPropagation();
      const anchor = items.findIndex(i => i.key === selectionAnchor.current), index = items.indexOf(item);
      setSelected(previous => {
        const next = event.shiftKey && !event.metaKey && !event.ctrlKey ? new Map<string, FootageItem>() : new Map(previous);
        if (event.shiftKey && anchor >= 0) for (const i of items.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)) next.set(i.key, i);
        else if (next.has(item.key)) next.delete(item.key); else next.set(item.key, item);
        return next;
      });
    }
    if (!event.shiftKey) selectionAnchor.current = item.key;
  }
  const applyShoot = useCallback((value: Shoot) => {
    setShoot(value); media?.onShootChange(value);
    const ids = new Set(value.clips.filter(c => !c.leftOut).map(c => c.id));
    setSelected(previous => new Map([...previous].filter(([, item]) => ids.has(item.clip.id))));
  }, [media?.onShootChange]);
  const routeItem = items.find(item => item.clip.id === params.clip && (!params.t || item.s <= Number(params.t) && (item.e ?? Infinity) > Number(params.t)));
  const selectedMatchesRoute = !params.clip || selectedItem?.clip.id === params.clip && (!params.t || selectedItem.s <= Number(params.t) && (selectedItem.e ?? Infinity) > Number(params.t));
  const current = (selectedItem && selectedMatchesRoute && items.find(item => item.key === selectedItem.key)) || (media && selectedItem ? mediaItem(shoot!, selectedItem) : null) || routeItem || items[0] || null;
  const open = useCallback((item: FootageItem, play = false, targetView = view) => { setSelectedItem(item); setInspectorOpen(!media?.onSource || media.replacePiece != null); setPlayRequest(value => play ? value + 1 : 0); media?.onSource?.(item); if (!media) go("clips", { shoot: root, clip: item.clip.id, t: String(item.s), tab: targetView === "script" ? "takes" : "clips", q: query || undefined }); }, [root, view, query, go, media?.onSource, media?.replacePiece, !!media]);
  // A click opens the inspector beside the grid; clicking the open take again closes it.
  const pick = useCallback((item: FootageItem) => { if (media?.onSource) open(item); else if (inspectorOpen && current?.key === item.key) setInspectorOpen(false); else open(item); }, [inspectorOpen, current?.key, open, media?.onSource]);
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  const group = current ? groups.find(g => g.items.some(item => item.key === current.key)) : undefined;
  const groupIndex = group && current ? group.items.findIndex(item => item.key === current.key) : -1;
  function move(delta: number) {
    if (!current) return;
    if (media) {
      const next = items[Math.max(0, Math.min(items.length - 1, items.findIndex(item => item.key === current.key) + delta))];
      if (next) { open(next); window.dispatchEvent(new CustomEvent("sidething:reveal-take", { detail: next.key })); }
      return;
    }
    if (!inspectorOpen || !group) { open(current); return; }
    const item = group.items[Math.max(0, Math.min(group.items.length - 1, groupIndex + delta))]; if (item.key !== current.key) open(item);
    window.dispatchEvent(new CustomEvent("sidething:reveal-take", { detail: item.key }));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-take-open="${CSS.escape(item.key)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  const toggleSelection = useCallback((item: FootageItem) => { setSelected(previous => { const next = new Map(previous); if (next.has(item.key)) next.delete(item.key); else next.set(item.key, item); return next; }); }, []);
  async function star(item: FootageItem) {
    if (!shoot || busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try { const next = await api.setFootageStar(root, item.key, !itemStarred(shoot, item)); if (alive.current) { setShoot(next); media?.onShootChange(next); } }
    catch (e) { if (alive.current) setNotice(e instanceof Error ? e.message : "Could not star this take."); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  const starRef = useRef(star); starRef.current = star;
  const starItem = useCallback((item: FootageItem) => { void starRef.current(item); }, []);
  const restoredSelection = useRef(false);
  useEffect(() => {
    if (media || !shoot || restoredSelection.current) return;
    restoredSelection.current = true;
    const keys = new Set(selectedKeys(root));
    setSelected(new Map(items.filter(item => keys.has(item.key)).map(item => [item.key, item])));
  }, [shoot, items, root]);
  useEffect(() => {
    if (media || !restoredSelection.current) return;
    const selection = [...selected.values()];
    rememberSelection(root, [...selected.keys()], selection.map(item => item.lineIndex !== undefined && item.attemptIndex !== undefined
      ? { take: `L${item.lineIndex + 1}A${item.attemptIndex + 1}` }
      : { clipId: item.clip.id, s: item.s, e: item.e ?? item.clip.meta?.durationS ?? 0 }));
  }, [selected, root]);
  async function create(selection: FootageItem[], cutId?: string) {
    if (!selection.length || busyRef.current || media?.busy) return;
    if (media) {
      busyRef.current = true; setBusy(true); setNotice("");
      try {
        const item = selection[0];
        const result = await media.onEdit(media.replaceLayout?layoutReplacementEdit(media.replaceLayout,item):media.replacePiece != null
          ? { kind: "replace", piece: media.replacePiece, clipId: item.clip.id, s: item.s, e: item.e ?? undefined }
          : { kind: "insert", at: media.version.pieces?.length ?? 0, source: { clipId: item.clip.id, s: item.s, e: item.e ?? item.clip.meta?.durationS ?? 0 } });
        if (result === undefined || result === false) throw new Error("Couldn't save this change. Try again.");
        if (alive.current && (media.replacePiece != null||media.replaceLayout)) media.onClose();
      } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : "Couldn't save this change."); }
      finally { busyRef.current = false; if (alive.current) setBusy(false); }
      return;
    }
    busyRef.current = true; setBusy(true); setNotice(""); const id = ++serial.current;
    try {
      const sources = selection.map(item => item.lineIndex !== undefined && item.attemptIndex !== undefined
        ? { take: `L${item.lineIndex + 1}A${item.attemptIndex + 1}` }
        : { clipId: item.clip.id, s: item.s, e: item.e ?? item.clip.meta?.durationS ?? 0 });
      let result: { cutId: string; version: number };
      if (cutId) {
        const cut = (await api.listCuts(root)).find(cut => cut.cutId === cutId);
        const position = stored<{ version?: number; at?: number }>(`sidething.insert:${root}:${cutId}`, {});
        const version = cut?.versions.find(v => v.version === position.version) ?? cut?.versions.at(-1);
        if (!version) throw new Error("That edit is no longer available.");
        let base = version.version, at = Number.isInteger(position.at) ? Math.max(0, Math.min(version.pieces?.length ?? 0, position.at!)) : version.pieces?.length ?? 0;
        result = { cutId, version: base };
        for (const source of sources) { result = await api.editCut(root, cutId, base, { kind: "insert", at: at++, source }); base = result.version; }
      } else result = await api.createCut(root, { from: sources });
      if (!alive.current || id !== serial.current) return;
      go("precuts", { shoot: root, cut: result.cutId, v: String(result.version) });
    } catch (e) { if (alive.current && id === serial.current) setNotice(e instanceof Error ? e.message : "Could not create this edit."); }
    finally { busyRef.current = false; if (alive.current && id === serial.current) setBusy(false); }
  }
  const footageKeys = footageShortcuts({ move, play: () => {
    if (!inspectorOpen && current) { open(current, true); return; }
    const video = inspectorHost.current?.querySelector<HTMLVideoElement>("[data-footage-preview] video");
    if (!video) return;
    if (video.paused) {
      if (current && (video.currentTime < current.s || current.e !== null && video.currentTime >= current.e)) video.currentTime = current.s;
      void video.play().catch(() => setNotice("Could not play this preview."));
    } else video.pause();
  }, star: () => { if (current) void star(current); }, review: value => { if (current) mark(current.key, { review: value }); },
    close: closeInspector, search: () => search.current?.focus(), help: () => setHelp(true), select: () => { if (current) toggleSelection(current); } });
  const shortcuts = useShortcuts(media ? "precuts" : "clips", media ? [
    { id: "library-search", scope: "precuts", keys: ["/", "Cmd+f"], label: "Search footage", handler: () => search.current?.focus() },
    { id: "library-previous", scope: "precuts", keys: ["ArrowLeft", "ArrowUp"], label: "Previous footage", repeat: true, handler: () => move(-1) },
    { id: "library-next", scope: "precuts", keys: ["ArrowRight", "ArrowDown"], label: "Next footage", repeat: true, handler: () => move(1) },
    { id: "library-close", scope: "precuts", keys: ["Escape"], label: "Close the preview or go back to Clips", handler: media.onEscape ?? media.onClose },
  ] : footageKeys);
  function chooseView(next: FootageView) {
    setViewChoice(next);
    if (media) { setScoped(false); return; }
    try { localStorage.setItem(`st-footage.view:${root}`, JSON.stringify(next)); } catch { setStorageError("Your view choice could not be saved on this Mac."); }
    go("clips", { shoot: root, tab: next === "script" ? "takes" : "clips", q: query || undefined });
  }
  if (loading && !shoot) return <div><h1 className="mb-6 font-display text-display-xl font-semibold">All footage</h1><Skeleton kind="cards" count={4} /></div>;
  if (!shoot) return <div className="rounded-2xl bg-surface p-8"><h1 className="font-display text-display font-semibold">All footage</h1><InlineError className="mt-3 text-small text-muted">{error}</InlineError><Button className="mt-4" onClick={() => go("shoots")}>Back to shoots</Button></div>;
  if (params.failed === "1") return <div className="px-6 py-5"><Row className="mb-5 justify-between"><h1 className="text-xl font-semibold">Clips that couldn't be read</h1><Button variant="ghost" onClick={() => go("clips", { shoot: root })}>All footage</Button></Row><FailedClips shoot={shoot} details onChange={setShoot} /></div>;
  const includedClips = shoot.clips.filter(c => !c.leftOut);
  const countedClips = filters.length ? [...new Map(items.map(item => [item.clip.id, item.clip])).values()] : includedClips;
  const counts = shotGroups(countedClips);
  const audioOnly = shoot.audio.filter(audio => !shoot.clips.some(clip => clip.file === audio.file));
  const visibleAudio = audioOnly.filter(audio => !query.trim() || audio.file.toLowerCase().includes(query.trim().toLowerCase()));
  const showAudio = (category === "audio" || view === "shot" && category === "all") && visibleAudio.length > 0
    && !filters.some(f => f.field !== "kind" && f.field !== "shotType" && f.values.length);
  const countedAudio = filters.length ? showAudio ? visibleAudio.length : 0 : audioOnly.length;
  const categoryIcons = { all: FilmStrip, talking: VideoCamera, screen: Monitor, broll: Image, setup: Package, audio: Waveform, unknown: FilmStrip };
  const titleViews = { ...views, title: views.selectedId === "all" ? "All footage" : views.title, views: views.views.map(v => v.id === "all" ? { ...v, name: "All footage" } : v) };
  const libraryToolbar = (
    <Row data-library-toolbar className="mb-3 flex-wrap gap-2">
      <div className="st-footage-heading"><ClipViewsTitle views={titleViews} onSelect={value => views.select(value)} /></div>

      <SegmentedControl label="Footage views" value={view} options={[{value:"scenes",label:"Scenes"},{value:"script",label:"Script lines"},{value:"shot",label:"Shot type"}]} onChange={chooseView} />
      <div className="flex items-center gap-2">
        <SearchField ref={search} label="Search takes, transcript or keywords" shortcut={null} title={media ? "Search footage (/ or Cmd F)" : "Search takes, transcript or keywords (Cmd K)"} value={query} onChange={e => { setQuery(e.target.value); if (media) { setInspectorOpen(false); setSelectedItem(null); } }} placeholder="Search takes, transcript or keywords..." className="w-64 !rounded-full !bg-surface !py-2" />
        <Button aria-label="Toggle filters" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><Funnel size={16} />{filters.length || ""}</Button>
      </div>
    </Row>
  );
  return <ClipMenu shoot={shoot} onShootChange={applyShoot} selectedClipIds={[...selected.values()].map(item => item.clip.id)}><div onClickCapture={selectByClick} onDragStartCapture={event=>{
    if(!media)return;
    const key=(event.target as HTMLElement).closest<HTMLElement>('[data-take-open]')?.dataset.takeOpen;
    const item=items.find(i=>i.key===key);if(!item)return;
    const marked=media.getSource?.() ?? media.source;
    const range=marked?.clipId===item.clip.id?marked:sourceRange(item.clip,item.attempt?item:undefined);
    if(range.e<=range.s || item.clip.missing){event.preventDefault();return;}
    writeSourceDrag(event.dataTransfer,root,range);
  }} ref={host} className={media ? "library-media" : "pb-32"} data-library-media={!!media || undefined} data-footage-root={root}>
    {!media && <><MissingMediaBanner shoot={shoot} onShootChange={applyShoot} onRelink={root => go("clips", { shoot: root })} />
    <JunkReview shoot={shoot} onShootChange={value => { setShoot(value); const ids = new Set(value.clips.map(c => c.id)); setSelected(previous => new Map([...previous].filter(([, item]) => ids.has(item.clip.id)))); }} /></>}

    {filtersOpen && <div className="mb-5 rounded-2xl bg-surface p-4"><Filters shoot={shoot} takes={view === "script"} filters={filters} onChange={views.setFilters} query={query} onQueryChange={setQuery} hideSearch /></div>}
    {error && <InlineError className="mb-3 text-small text-danger">{error}</InlineError>}
    {!usageKnown && <p role="status" className="mb-3 text-micro text-muted">Saved edits are unavailable. You can still start a new edit.</p>}
    {!media && selected.size > 0 && <div className="sticky top-0 z-20 mb-4 flex items-center gap-3 rounded-2xl bg-surface p-3" aria-label="Selected clips"><span className="tnum text-small">{selected.size} selected</span><Button variant="primary" disabled={busy} onClick={() => void create([...selected.values()])}>{busy ? "Creating..." : "Create from selected clips"}</Button><Button disabled={busy} onClick={() => setSelected(new Map())}>Clear selection</Button></div>}
    {(notice || storageError) && <p role="status" className="mb-4 whitespace-pre-wrap text-small text-muted">{notice || storageError}</p>}
    {media && scoped && <Row className="library-scope gap-2"><span className="text-small font-medium"><NamedMessage>{media.replaceLayout?'Replace screen':`Replace ${pieceName(shoot, media.version, media.replacePiece ?? 0)}`}</NamedMessage></span><Button onClick={() => setScoped(false)}>Browse all</Button></Row>}
    {media && libraryToolbar}
    <div data-library-body className={`grid items-start gap-4 ${inspectorOpen && current ? "grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-1"}`}>
      <div data-library-scroll={media ? true : undefined} className="min-w-0 space-y-4">
    {!media && libraryToolbar}
        {!query.trim() && <div className={`grid grid-cols-3 gap-2 ${inspectorOpen && current ? "min-[1700px]:grid-cols-6" : "min-[1200px]:grid-cols-6"}`} aria-label="Shot type counts">
          {[{ id: "all", name: "All clips", clips: countedClips }, ...counts.filter(g => g.id !== "unknown" || g.clips.length)].map(group => { const CategoryIcon = categoryIcons[group.id as keyof typeof categoryIcons] ?? FilmStrip; return <Tile type="button" key={group.id} aria-pressed={category === group.id} onClick={() => filterCategory(group.id)} className={`flex min-w-0 items-center gap-2 rounded-xl p-2 text-left ${category === group.id ? "bg-accent/10" : "bg-surface"} ${FOCUS}`}>
            <span className="flex size-8 shrink-0 min-[1440px]:size-10 items-center justify-center relative overflow-hidden rounded-lg bg-ground"><CategoryIcon size={24} className="text-accent" /></span><span className="min-w-0"><span className="block text-micro font-semibold">{group.name}</span><span className="mt-1 block tnum text-micro text-muted">{countOf(group.clips.length + (group.id === "audio" ? countedAudio : 0), group.id === "audio" ? "recording" : "clip")}</span></span></Tile>; })}
        </div>}
        {librarySections.map(place => <section key={place.id} aria-label={place.name ?? undefined} className="min-w-0 space-y-3">
        {place.name && <SectionHeader as="h2" className="text-small font-semibold">{place.name}</SectionHeader>}
        {place.groups.map(group => <section key={group.id} data-library-group={media ? true : undefined} data-missing-line={view === "script" && group.items.length > 0 && group.items.every(i => i.clip.missing) || undefined} className={`min-w-0 rounded-2xl p-3 ${view === "script" && group.items.length > 0 && group.items.every(i => i.clip.missing) ? "bg-ground/60 text-muted" : "bg-surface"}`} aria-label={group.name}>
          <header className="mb-3 flex items-start gap-3"><SectionHeader as="h2" className="flex min-w-0 flex-1 items-center gap-2 text-small font-semibold"><FilmStrip size={18} className="shrink-0" />{group.name}{view === "script" && group.items.length > 0 && group.items.every(i => i.clip.missing) ? <span className="rounded-md bg-surface px-2 py-1 text-micro font-normal text-muted">Missing</span> : null}{"subtitle" in group && group.subtitle ? <span className="font-normal text-micro text-muted">{String(group.subtitle)}</span> : null}</SectionHeader><span className="shrink-0 tnum text-micro text-muted">{countOf(group.items.length, view === "script" ? "take" : "clip")}</span><Button className="!py-0.5 !text-micro" onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })} aria-label={`Show all ${group.name}`} aria-expanded={expanded.has(group.id)}>{expanded.has(group.id) ? "Show less" : "Show all"}</Button></header>
          <TakeRow stackTakes={view !== "script"} ranked={!!query.trim()} id={group.id} shoot={shoot} items={group.items} expanded={expanded.has(group.id)} currentKey={inspectorOpen || media?.source?.clipId === current?.clip.id ? current?.key : undefined} selected={selected} marks={marks} inEdit={inEdit} onOpen={pick} onSelect={toggleSelection} onStar={starItem} />
        </section>)}</section>)}
        {showAudio && <section aria-label="Audio only" className="rounded-2xl bg-surface p-4"><SectionHeader as="h2" className="mb-4 text-small font-semibold">Audio only <span className="ml-2 tnum font-normal text-muted">{countOf(visibleAudio.length, "recording")}</span></SectionHeader><AudioRecordings shoot={{ ...shoot, audio: visibleAudio }} /></section>}
        {!groups.length && !showAudio && <EmptyState variant="inline" as="div" className="rounded-2xl bg-surface px-6 py-10 text-small text-muted">{query || filters.length ? "No footage matches this view." : !includedClips.length && shoot.clips.some(c => c.leftOut) ? "Your clips are left out. Put them back below." : view === "script" ? "No script lines with takes yet. Try Shot type while precut works." : "Footage will appear here as it is indexed."}</EmptyState>}
        {!media && <><LeftOutGroup shoot={shoot} onShootChange={applyShoot} />
        <details className="rounded-2xl bg-surface p-4"><summary className={`cursor-pointer text-small font-medium ${FOCUS}`}>Script tools</summary><div className="mt-5 space-y-5"><ScriptTab shoot={shoot} onShootChange={setShoot} /></div></details></>}
      </div>
      {inspectorOpen && current && <Inspector key={current.key} shoot={shoot} item={current} cuts={cuts} usageKnown={usageKnown} index={Math.max(0, groupIndex)} total={group?.items.length ?? 1}
        onClose={closeInspector} onMove={move} onOpen={open} onShootChange={applyShoot} onCutsChange={setCuts} onAdd={cutId => void create([current], cutId)}
        note={marks[current.key]?.note ?? ""} onNote={note => mark(current.key, { note })} host={inspectorHost} playRequest={playRequest}
        starred={itemStarred(shoot, current)} onStar={starItem}
        actionLabel={media?.replaceLayout?'Replace screen':media?.replacePiece != null ? "Replace clip" : "Add to edit"} embedded={!!media} actionDisabled={busy || media?.busy} review={marks[current.key]?.review} onReview={review => mark(current.key, { review })} />}
    </div>
    {!media && <><footer className="mt-6 flex items-center justify-between text-micro text-muted"><span className="tnum">{countOf(shoot.clips.length, "clip")}</span><span>Built by <strong className="text-ink">sidething</strong></span></footer>
    {help && <ShortcutSheet shortcuts={shortcuts} onClose={() => setHelp(false)} />}
    <Composer root={root} scope="clips" /></>}
  </div></ClipMenu>;
}
