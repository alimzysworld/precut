import { useModelAccess, openModelSignIn, ModelSignIn } from "../components/ModelAccess";
import { InlineError, Row } from "../components/ui";
import { useActivity } from "../components/Activity";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft as ArrowLeft, Close } from "../components/icons";
import type { Cut, ReelIdea, Shoot, ShootRequest, SkillFormat } from "../../../shared/schema";
import { getApi } from "../data";
import { go, useNav } from "../nav";
import { Badge, Button, EmptyState, FOCUS, SegmentedControl } from "../components/ui";
import { useShortcuts } from "../hooks/useShortcuts";
import { refreshSidekick, selectSidekickCut, useSidekickWorkspace } from "../components/SidekickChat";
import { AskPanel } from "../components/finish/AskPanel";
import { useAskWorkspace, setAskWorkspace } from "../components/finish/askWorkspace";
import { ShortcutSheet } from "../components/ShortcutSheet";
import { IdeaCard, ideaDraftState, ideaReadiness, type BoardIdea } from "../components/ideas/IdeaCard";
import { shootCanMake } from "../components/videoTypes";
import { usePageActive } from "../hooks/usePageActivity";

export type IdeaFilter = "all" | "ready" | "missing" | "requests";
export function matchesIdea(idea: ReelIdea, filter: IdeaFilter, query: string) {
  if (filter === "ready" && ideaReadiness(idea) !== "Ready") return false;
  if (filter === "missing" && ideaReadiness(idea) !== "Needs footage") return false;
  if (filter === "requests" && !idea.requestId) return false;
  return [idea.title, idea.concept, idea.hook, ...idea.missing].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
const plainError = (error: unknown, fallback: string) => error instanceof Error && error.message.length < 350
  ? error.message.replace(/^Error invoking remote method '[^']+':\s*/i, "") : fallback;

export default function IdeasPage() {
  const active = usePageActive();
  const { params } = useNav();
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let request = 0;
    let reading = false, pending = false;
    if (!shoot || params.shoot && shoot.root !== params.shoot) { setLoading(true); setShoot(null); }
    setError(null);
    let activeRoot = params.shoot;
    const load = async () => {
      if (!alive) return;
      if (reading) { pending = true; return; }
      reading = true;
      const current = ++request;
      try {
        activeRoot ??= (await getApi().listShoots()).find(entry => entry.online)?.root;
        const result = activeRoot ? await getApi().loadShoot(activeRoot) : null;
        if (alive && current === request) setShoot(result);
      } catch { if (alive && current === request) setError("Couldn't load this shoot. Check its drive is connected and reopen it."); }
      finally {
        reading = false;
        if (alive && current === request) setLoading(false);
        if (alive && pending) { pending = false; void load(); }
      }
    };
    void load();
    const off = getApi().onProgress(event => { if (event.root === activeRoot && event.stage !== 'proxy') void load(); });
    return () => { alive = false; off(); };
  }, [params.shoot, active]);
  if (loading) return <p role="status" className="text-small text-muted">Loading ideas…</p>;
  if (!shoot) return <EmptyState title="Pick a shoot first" body={error ?? "Open a shoot to find ideas in its footage."}><Button variant="primary" onClick={() => go("shoots")}>Go to shoots</Button></EmptyState>;
  // Saved ideas and cached storyboards remain available without a model sign-in.
  return <IdeasWorkspace key={shoot.root} shoot={shoot} />;
}

export function IdeasWorkspace({ shoot }: { shoot: Shoot }) {
  const active = usePageActive();
  const modelReady = useModelAccess();
  const state = useSidekickWorkspace(shoot.root);
  const ask = useAskWorkspace(shoot.root);
  const [savingIds, setSavingIds] = useState<Set<string>>(() => new Set());
  const activities = useActivity({ root: shoot.root, state: "running" });
  const { params } = useNav();
  const [aspect, setAspect] = useState<SkillFormat["aspect"]>();
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [cutsError, setCutsError] = useState<string | null>(null);
  const [requests, setRequests] = useState<ShootRequest[]>([]);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const requestRevision = useRef(0);
  const cutting = useRef(new Set<string>());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<IdeaFilter>("all");
  const query = "";
  const [helpOpen, setHelpOpen] = useState(false);
  const [passing, setPassing] = useState(false);
  const [undo, setUndo] = useState<{ entry: BoardIdea; until: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const processing = shoot.clips.some(clip => clip.stage !== "done" && clip.stage !== "error");
  const byId = new Map<string, BoardIdea>();
  state.messages.forEach(message => message.ideas?.forEach((idea, index) => {
    const id = idea.id ?? `${message.id}:${index}`;
    byId.set(id, { idea: { ...idea, id }, messageId: message.id, index });
  }));
  // Revisions replace their own card without disturbing first-appearance order.
  const board = [...byId.values()];
  const canMake = shootCanMake(state.messages);
  const visibleIdeas = board.filter(({ idea }) => !idea.passed && matchesIdea(idea, filter, query));
  const passedIdeas = board.filter(({ idea }) => idea.passed && matchesIdea(idea, filter, query));
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const talking = ask.idea ? byId.get(ask.idea.id) : undefined;
  const askIdea = talking ? { id: talking.idea.id!, messageId: talking.messageId, index: talking.index,
    title: talking.idea.title, concept: talking.idea.concept, uses: talking.idea.uses, missing: talking.idea.missing } : ask.idea;
  const ideaGeneration = activities.find(activity => activity.kind === "ideas" && !activity.target?.ideaId);
  const adding = !!state.pending?.context.addIdeas || !!ideaGeneration;
  const shownRequests = requests.filter(request => (filter === "requests" || (filter === "all" && request.state !== "done"))
    && request.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useEffect(() => {
    let alive = true;
    void getApi().listSkills().then(skills => { if (alive) setAspect(skills.find(skill => skill.global)?.format?.aspect); }).catch(() => {});
    return () => { alive = false; };
  }, [shoot.root]);
  useEffect(() => {
    const ideaId = new URLSearchParams(window.location.hash.split("?")[1]).get("idea");
    if (ideaId) setSelectedId(ideaId);
  }, [params]);
  useEffect(() => {
    let alive = true, cutRevision = 0;
    if (!active) return;
    let loading = false, pending = false;
    const load = () => {
      if (!alive) return;
      // Preview progress can arrive faster than a full history can be read.
      // Keep one request and one trailing refresh, never a queue of histories.
      if (loading) { pending = true; return; }
      loading = true;
      const request = ++requestRevision.current, cut = ++cutRevision;
      const requests = getApi().listRequests(shoot.root).then(result => {
        if (alive && request === requestRevision.current) { setRequests(result); setRequestsError(null); }
      }).catch(reason => { if (alive && request === requestRevision.current) setRequestsError(plainError(reason, "Couldn't load your requests.")); });
      const cuts = getApi().listCuts(shoot.root).then(result => {
        if (alive && cut === cutRevision) { setCuts(result); setCutsError(null); }
      }).catch(() => { if (alive && cut === cutRevision) setCutsError("Couldn't check saved edits. You can still open an idea and try again."); });
      void Promise.all([requests, cuts]).finally(() => {
        loading = false;
        if (alive && pending) { pending = false; load(); }
      });
    };
    void refreshSidekick(shoot.root);
    load();
    const offThread = getApi().onSidekickChanged(root => { if (root === shoot.root) { void refreshSidekick(root); load(); } });
    const offActivity = getApi().onActivity(activity => { if (activity.root === shoot.root && activity.state !== 'running') load(); });
    const offSteps = getApi().onStepsChanged(root => { if (root === shoot.root) load(); });
    return () => { alive = false; offThread(); offActivity(); offSteps(); };
  }, [shoot.root, active]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), Math.max(0, undo.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [undo]);

  const returnToBoard = () => {
    setSelectedId(null);
    requestAnimationFrame(() => {
      const card = [...document.querySelectorAll<HTMLElement>("[data-idea-card]")].find(node => node.dataset.ideaId === selectedId);
      card?.focus();
    });
  };
  const openDetails = (entry: BoardIdea) => setSelectedId(entry.idea.id!);
  async function pass(entry: BoardIdea, passed: boolean) {
    if (passing) return;
    setPassing(true); setError(null);
    try {
      await getApi().passIdea(shoot.root, entry.messageId, entry.index, passed);
      await refreshSidekick(shoot.root);
      setUndo(passed ? { entry, until: Date.now() + 5000 } : null);
      if (passed && selectedId === entry.idea.id) setSelectedId(null);
    } catch { setError("Couldn't save that choice. Try again."); }
    finally { setPassing(false); }
  }
  const discuss = (entry: BoardIdea) => setAskWorkspace(shoot.root, { open: true, idea: {
    id: entry.idea.id!, messageId: entry.messageId, index: entry.index, title: entry.idea.title,
    concept: entry.idea.concept, uses: entry.idea.uses, missing: entry.idea.missing,
  } });
  async function cut(entry: BoardIdea) {
    if (cutting.current.has(entry.idea.id!)) return;
    cutting.current.add(entry.idea.id!); setError(null);
    setSavingIds(current => new Set([...current, entry.idea.id!]));
    try {
      const cutId = entry.idea.cutId;
      const availableCuts = cutId ? await getApi().listCuts(shoot.root) : [];
      const version = availableCuts.find(item => item.cutId === cutId)?.versions.at(-1)?.version;
      if (cutId && version !== undefined) {
        setCuts(availableCuts);
        selectSidekickCut(shoot.root, { cutId, version });
        go("precuts", { shoot: shoot.root, cut: cutId, v: String(version) });
        return;
      }
      if (!modelReady) { openModelSignIn("firstEdits", () => void cut(entry)); return; }
      if (ideaDraftState(entry, activities, requests, state.pending?.context.fromIdea)) return;
      const request = await getApi().addRequest(shoot.root, entry.idea.concept, { messageId: entry.messageId, index: entry.index });
      ++requestRevision.current;
      setRequests(current => [...current.filter(item => item.id !== request.id), request]);
    } catch (reason) { setError(plainError(reason, "Couldn't make this edit. Try again.")); }
    finally {
      cutting.current.delete(entry.idea.id!);
      setSavingIds(current => { const next = new Set(current); next.delete(entry.idea.id!); return next; });
    }
  }
  const focused = selected ?? [...visibleIdeas, ...passedIdeas].find(entry => entry.idea.id === focusedId) ?? visibleIdeas[0];
  const moveFocus = (key: string) => {
    const cards = [...(boardRef.current?.querySelectorAll<HTMLElement>("[data-idea-card]") ?? [])].filter(card => card.getClientRects().length > 0);
    if (!cards.length) return;
    const index = cards.findIndex(card => card.dataset.ideaId === focusedId);
    const columns = cards.filter(card => Math.abs(card.offsetTop - cards[0].offsetTop) < 2).length || 1;
    const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "ArrowUp" ? -columns : columns;
    const next = cards[index < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, index + step))];
    setFocusedId(next.dataset.ideaId!); next.focus(); next.scrollIntoView({ block: "nearest" });
  };
  const shortcuts = useShortcuts("ideas", [
    ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].map(key => ({ id: `ideas-${key}`, scope: "ideas", keys: [key], label: key === "ArrowLeft" ? "Previous idea" : key === "ArrowRight" ? "Next idea" : key === "ArrowUp" ? "Previous row" : "Next row", enabled: !selected, handler: () => moveFocus(key) })),
    { id: "ideas-open", scope: "ideas", keys: ["Enter"], label: "Open or make edit", enabled: !!focused && !selected, handler: event => {
      // Buttons keep their native Enter action; the card itself opens or cuts.
      if ((event.target as HTMLElement)?.closest("button, summary, a")) (event.target as HTMLElement).click();
      else if (focused) void cut(focused);
    } },
    { id: "ideas-pass", scope: "ideas", keys: ["p"], label: "Pass idea", enabled: !!focused && !selected, handler: () => { if (focused) void pass(focused, !focused.idea.passed); } },
    { id: "ideas-ask", scope: "ideas", keys: ["9"], label: "Ask", handler: () => setAskWorkspace(shoot.root, { open: !ask.open }) },
    { id: "ideas-close-ask", scope: "ideas", keys: ["Escape"], label: "Close Ask", enabled: ask.open, handler: () => setAskWorkspace(shoot.root, { open: false }) },
    { id: "ideas-back", scope: "ideas", keys: ["Escape"], label: "Back to ideas", enabled: !!selected && !ask.open, handler: returnToBoard },
    { id: "ideas-help", scope: "ideas", keys: ["?"], label: "Keyboard shortcuts", handler: () => setHelpOpen(true) },
  ], !helpOpen);
  const renderCard = (entry: BoardIdea, expanded = false) => <IdeaCard key={entry.idea.id} shoot={shoot} entry={entry} expanded={expanded}
    editLengthS={cuts.find(item => item.cutId === entry.idea.cutId)?.versions.at(-1)?.lengthS}
    linked={!!entry.idea.cutId && cuts.some(item => item.cutId === entry.idea.cutId && item.versions.length > 0)}
    drafting={ideaDraftState(entry, activities, requests, state.pending?.context.fromIdea) === "making"}
    queued={ideaDraftState(entry, activities, requests, state.pending?.context.fromIdea) === "queued"} saving={savingIds.has(entry.idea.id!)} passing={passing}
    failure={[...requests].reverse().find(r => r.fromIdea && (r.ideaIds.includes(entry.idea.id!) || r.fromIdea.messageId === entry.messageId && r.fromIdea.index === entry.index))?.error}
    aspect={aspect}
    onDiscuss={() => discuss(entry)} onFocus={() => setFocusedId(entry.idea.id!)} onOpen={() => openDetails(entry)} onCut={() => { void cut(entry); }} onPass={() => { void pass(entry, !entry.idea.passed); }} />;

  return <div data-ideas-workspace className="relative flex h-full min-h-0 flex-col text-ink">
    <div className="flex min-h-0 flex-1 gap-4">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <Row className="mb-3 shrink-0 justify-end"><Button variant="secondary" title="Ask (9)" aria-expanded={ask.open} onClick={() => setAskWorkspace(shoot.root, { open: !ask.open })}>Ask</Button></Row>
    {error || state.error || cutsError || requestsError ? <InlineError className="mb-3 text-small text-danger">{error ?? state.error ?? cutsError ?? requestsError}</InlineError> : null}
    {notice && <p role="status" className="mb-3 text-small text-muted">{notice}</p>}
    {selected ? <>
      <div className="mb-3"><Button type="button" variant="ghost" onClick={returnToBoard}><ArrowLeft size={16} />All ideas</Button></div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="min-h-0 overflow-y-auto pb-5">{renderCard(selected, true)}</div>
      </div>
    </> : <>
      {canMake && <details data-can-make className="mb-3 shrink-0 text-small"><summary className="flex cursor-pointer gap-2"><span className="shrink-0 font-medium">Your brief</span><span className="truncate text-muted">{canMake.split("\n")[0]}</span></summary><p className="mt-2 whitespace-pre-wrap text-muted">{canMake}</p></details>}
      <Row className="mb-4 shrink-0 flex-wrap">
        <SegmentedControl<IdeaFilter> label="Filter ideas" value={filter} options={[
          { value: "all", label: "All ideas" }, { value: "ready", label: "Ready" }, { value: "missing", label: "Needs footage" }, { value: "requests", label: "Your requests" },
        ]} onChange={setFilter} />

      </Row>
      <section ref={boardRef} aria-label="Idea board" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-5">
        {shownRequests.length > 0 && <ul aria-label="Your requests" className="mb-4 space-y-2">{shownRequests.map(request => <li key={request.id} data-request-id={request.id} className="flex flex-wrap items-start gap-3 rounded-2xl bg-surface px-4 py-3">
          <div className="min-w-0 flex-1"><div className="text-small"><details><summary className="cursor-pointer truncate">{request.text.split("\n")[0]}</summary><p className="mt-2 whitespace-pre-wrap">{request.text}</p></details></div>{request.error && <p className="mt-1 text-small text-muted">{request.error}</p>}</div>
          <Badge tone={request.state === "failed" ? "pink" : request.state === "done" ? "lime" : "neutral"}>{({ queued: "Queued", working: "Working", done: "Done", failed: "Failed" })[request.state]}</Badge>
        </li>)}</ul>}
        {!visibleIdeas.length && !adding && (!modelReady && !state.loading && !board.length && !query && filter === "all"
          // ONB2/REL1: without an AI ideas never "appear"; say what makes them, and how to get it.
          ? <div className="max-w-[460px] py-6"><ModelSignIn feature="ideas" onReady={() => void getApi().retryStage(shoot.root, "group").then(() => getApi().retryStage(shoot.root, "ideas")).catch(() => {})} /></div>
          : <EmptyState variant="inline" as="p" role="status" className="py-8 text-small text-muted">{state.loading ? "Loading your ideas…" : board.length || query || filter !== "all" ? "No ideas match this view yet." : processing ? "Ideas will appear as your footage is understood." : "Ideas will appear here as they're generated. Open Ask to say what you want."}</EmptyState>)}
        <div data-idea-grid className={`grid auto-rows-fr items-stretch gap-3 ${ask.open ? "grid-cols-2 min-[1100px]:grid-cols-3 max-[850px]:grid-cols-1" : "grid-cols-3 min-[1100px]:grid-cols-4 max-[850px]:grid-cols-2 max-[520px]:grid-cols-1"}`}>{visibleIdeas.map(entry => renderCard(entry))}</div>
        {passedIdeas.length > 0 && <details className="mt-5"><summary className={`w-fit cursor-pointer py-2 text-small text-muted ${FOCUS}`}>Passed · {passedIdeas.length}</summary>
          <div className="mt-3 grid grid-cols-3 gap-3 min-[1100px]:grid-cols-4 max-[850px]:grid-cols-2 max-[520px]:grid-cols-1">{passedIdeas.map(entry => renderCard(entry))}</div>
        </details>}
      </section>
    </>}
    </div>
    {ask.open && <aside aria-label="Ask sidebar" className="flex w-[360px] min-w-0 shrink-0 flex-col rounded-3xl bg-surface p-4 max-[850px]:w-[300px]">
      <Row className="shrink-0"><span className="font-medium">Ask</span><Button variant="ghost" aria-label="Close Ask" onClick={() => setAskWorkspace(shoot.root, { open: false })}><Close size={16} /></Button></Row>
      <AskPanel root={shoot.root} version={0} screenContext={{ panel: "ask", idea: askIdea }} />
    </aside>}
    </div>
    {undo && <div role="status" className="absolute bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-full bg-surface px-5 py-3 text-small"><span>Idea passed</span><Button variant="ghost" disabled={passing} onClick={() => { void pass(undo.entry, false); }}>Undo</Button></div>}
    {helpOpen && <ShortcutSheet shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}
  </div>;
}
