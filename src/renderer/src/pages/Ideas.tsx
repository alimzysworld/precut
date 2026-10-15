import { useEffect, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { CircleNotch } from "@phosphor-icons/react";
import type { Cut, ReelIdea, Shoot, SidekickMessage } from "../../../shared/schema";
import { frameAt, getApi } from "../data";
import { go, useNav } from "../nav";
import { dur, ease, imgIn, spring } from "../motion";
import { Button, EmptyState, FOCUS, Img, MotionItem, MotionList, reducedTransition, useMotionPresets } from "../components/ui";
import { refreshSidekick, selectSidekickCut, SidekickChat, sidekickSend, useSidekickWorkspace } from "../components/SidekickChat";

// Resolve historical take and b-roll ids in the same shoot order as CutView.
function ideaFrames(shoot: Shoot, uses: string[]) {
  const broll = shoot.clips.flatMap((clip) => {
    const judgement = clip.judgement;
    if (!judgement || !(String(judgement.kind).replace("-", "") === "broll" || (judgement.verdict === "maybe" && /b-?roll/i.test(judgement.summary)))) return [];
    const spans = judgement.usableSpans.length ? judgement.usableSpans : [[0, clip.meta?.durationS ?? 0]];
    return spans.map(([s]) => ({ clipId: clip.id, s }));
  });
  return uses.flatMap((id) => {
    const voice = /^L(\d+)A(\d+)$/i.exec(id);
    const attempt = voice ? shoot.takes.find((take) => take.lineIndex === Number(voice[1]) - 1)?.attempts[Number(voice[2]) - 1] : undefined;
    const b = /^B(\d+)$/i.exec(id);
    const moment = attempt ?? (b ? broll[Number(b[1]) - 1] : undefined);
    const src = moment ? frameAt(shoot, moment.clipId, moment.s) : null;
    return src ? [{ id, src }] : [];
  }).slice(0, 4);
}

export default function IdeasPage() {
  const { params } = useNav();
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let request = 0;
    setLoading(true); setShoot(null); setError(null);
    let activeRoot = params.shoot;
    const load = async () => {
      const current = ++request;
      try {
        activeRoot ??= (await getApi().listShoots()).find((entry) => entry.online)?.root;
        const result = activeRoot ? await getApi().loadShoot(activeRoot) : null;
        if (alive && current === request) setShoot(result);
      } catch { if (alive && current === request) setError("Couldn't load this shoot. Check its drive is connected and reopen it."); }
      finally { if (alive && current === request) setLoading(false); }
    };
    void load();
    const off = getApi().onProgress((event) => { if (event.root === activeRoot) void load(); });
    return () => { alive = false; off(); };
  }, [params.shoot]);
  if (loading) return <p role="status" className="text-[13px] text-muted">Loading ideas…</p>;
  if (!shoot) return <EmptyState title="Pick a shoot first" body={error ?? "Open a shoot to find ideas in its footage."}><Button variant="primary" onClick={() => go("shoots")}>Go to folder</Button></EmptyState>;
  return <IdeasWorkspace key={shoot.root} shoot={shoot} />;
}

function IdeasWorkspace({ shoot }: { shoot: Shoot }) {
  const state = useSidekickWorkspace(shoot.root);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [passing, setPassing] = useState<string | null>(null);
  const sets = state.messages.filter((message) => message.role === "sidekick" && message.ideas?.length);
  const latest = sets.at(-1);
  const earlier = sets.slice(0, -1).reverse();
  const processing = shoot.clips.some((clip) => clip.stage !== "done" && clip.stage !== "error");
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const load = async () => {
      const current = ++revision;
      try { const result = await getApi().listCuts(shoot.root); if (alive && current === revision) setCuts(result); }
      catch { if (alive && current === revision) setError("Couldn't read the cuts. Reopen this shoot to try again."); }
    };
    void load();
    const off = getApi().onSidekickChanged((root) => { if (root === shoot.root) void load(); });
    return () => { alive = false; off(); };
  }, [shoot.root]);
  async function pass(messageId: string, index: number, passed: boolean) {
    if (passing) return;
    setPassing(`${messageId}-${index}`); setError(null);
    try { await getApi().passIdea(shoot.root, messageId, index, passed); await refreshSidekick(shoot.root); }
    catch { setError("Couldn't save that choice. Try again."); }
    finally { setPassing(null); }
  }
  function open(idea: ReelIdea) {
    if (!idea.cutId) return;
    const cut = cuts.find((entry) => entry.cutId === idea.cutId);
    const linked = [...state.messages].reverse().find((message) => message.cut?.cutId === idea.cutId)?.cut;
    const version = cut?.versions.at(-1)?.version ?? linked?.version ?? 1;
    selectSidekickCut(shoot.root, { cutId: idea.cutId, version });
    go("precuts", { shoot: shoot.root, cut: idea.cutId, v: String(version) });
  }
  const renderSet = (message: SidekickMessage) => <IdeaSet key={message.id} shoot={shoot} message={message} pending={!!state.pending} cuttingIndex={state.pending?.context.fromIdea?.messageId === message.id ? state.pending.context.fromIdea.index : undefined} passing={passing} onPass={(index, passed) => void pass(message.id, index, passed)} onCut={(idea, index) => { void sidekickSend(shoot.root, idea.concept, { fromIdea: { messageId: message.id, index } }); }} onOpen={open} />;
  return <div className="h-full min-h-0"><div data-ideas-workspace className="st-glass-surface grid h-full min-h-0 grid-cols-[370px_minmax(0,1fr)] overflow-hidden rounded-[24px] max-[1000px]:grid-cols-[320px_minmax(0,1fr)] max-[700px]:grid-cols-[minmax(240px,0.8fr)_minmax(0,1fr)]">
    <aside aria-label="Sidekick" className="flex min-h-0 min-w-0 flex-col">
      
      <div className="min-h-0 flex-1"><SidekickChat shoot={shoot} cutContext={null} placeholder={!latest ? "Add a link, storyboard or sentence" : undefined} /></div>
    </aside>
    <section aria-label="Idea board" className="min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-ink/[0.025] p-6 lg:p-7">
      <header className="mb-6"><p className="text-[11.5px] text-muted">{shoot.name}</p><h2 className="font-display mt-1 text-[24px] font-semibold tracking-tight text-ink">Ideas</h2></header>
      {error ? <p role="alert" className="mb-4 text-[13px] text-ink">{error}</p> : null}
      {latest ? renderSet(latest) : <div className="flex min-h-[340px] flex-col items-center justify-center gap-5 px-4 text-center">
        <p className="max-w-[320px] text-[14px] leading-relaxed text-muted">{state.loading ? "Loading your ideas…" : processing ? "Ideas come once your clips are tagged." : "Find what you could make from this footage."}</p>
        {!state.loading ? <Button variant="primary" disabled={processing || !!state.pending} onClick={() => { void sidekickSend(shoot.root, "what reels could I make from this?"); }}>Find ideas</Button> : null}
      </div>}
      {earlier.length ? <details className="mt-8 text-[13px] text-muted"><summary className={`w-fit cursor-pointer rounded-sm py-2 hover:text-ink ${FOCUS}`}>earlier ideas ({earlier.length} sets)</summary><div className="mt-4 space-y-8">{earlier.map(renderSet)}</div></details> : null}
    </section>
  </div></div>;
}

function Spinner() {
  const { reduced } = useMotionPresets();
  return <motion.span aria-hidden="true" className="inline-flex" animate={reduced ? undefined : { rotate: 360 }} transition={{ duration: dur.smooth + dur.smooth, ease: ease.out, repeat: Infinity }}><CircleNotch size={14} /></motion.span>;
}

function IdeaSet({ shoot, message, pending, cuttingIndex, passing, onPass, onCut, onOpen }: {
  shoot: Shoot; message: SidekickMessage; pending: boolean; cuttingIndex?: number; passing: string | null;
  onPass: (index: number, passed: boolean) => void; onCut: (idea: ReelIdea, index: number) => void; onOpen: (idea: ReelIdea) => void;
}) {
  const { reduced } = useMotionPresets();
  const ideas = message.ideas ?? [];
  const passed = ideas.map((idea, index) => ({ idea, index })).filter(({ idea }) => idea.passed);
  return <LayoutGroup id={`ideas-${message.id}`}>
    <MotionList className="grid grid-cols-1 gap-4 min-[1200px]:grid-cols-2">
      <AnimatePresence>{ideas.map((idea, index) => !idea.passed ? <MotionItem key={`${message.id}-${index}`} index={index} layoutId={reduced ? undefined : `${message.id}-${index}`} exit={reduced ? { opacity: 0, transition: reducedTransition } : { opacity: 0, y: 24, scale: 0.97, transition: { duration: dur.base, ease: ease.out } }} className="st-glass-surface flex min-w-0 flex-col rounded-[20px] p-5" data-idea-card>
        <div className="mb-3 flex min-h-4 flex-wrap items-center justify-between gap-2 text-[11px] text-muted"><span>{idea.pick ? "sidekick's pick" : ""}</span><span className="tnum">{idea.lengthS} s</span></div>
        <h3 className="font-display text-[19px] font-semibold leading-snug tracking-tight text-ink">{idea.title}</h3>
        <p className="mt-3 text-[13px] leading-relaxed text-ink">“{idea.hook}”</p>
        <div className="mt-auto pt-5">
          <div className="flex gap-1.5 overflow-hidden" aria-label="Footage used">{ideaFrames(shoot, idea.uses).map(({ id, src }, i) => <Img key={`${id}-${i}`} src={src} alt={id} loading="lazy" className="aspect-[4/3] min-w-0 max-w-[calc((100%-18px)/4)] flex-1 rounded-lg object-cover" />)}</div>
          {idea.missing.length ? <p className="mt-3 text-[11.5px] leading-relaxed text-muted">needs: {idea.missing.join("; ")}</p> : null}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <div className="grid"><AnimatePresence initial={false}>{cuttingIndex === index ? <motion.span key="cutting" role="status" className="flex items-center gap-2 px-3.5 py-1.5 text-[13px] text-muted [grid-area:1/1]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? reducedTransition : imgIn}><Spinner />cutting</motion.span> : <motion.div key={idea.cutId ? "open" : "cut"} className="[grid-area:1/1]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? reducedTransition : imgIn}><Button variant={idea.cutId ? "secondary" : "primary"} disabled={!idea.cutId && pending} onClick={() => idea.cutId ? onOpen(idea) : onCut(idea, index)} aria-label={`${idea.cutId ? "Open cut" : "Cut this"}: ${idea.title}`}>{idea.cutId ? "Open cut" : "Cut this"}</Button></motion.div>}</AnimatePresence></div>
            <Button variant="ghost" className="!px-1 !text-[12px]" disabled={!!passing || cuttingIndex === index} onClick={() => onPass(index, true)} aria-label={`Not this: ${idea.title}`}>Not this</Button>
          </div>
        </div>
      </MotionItem> : null)}</AnimatePresence>
    </MotionList>
    {passed.length ? <motion.details layout={!reduced} transition={reduced ? reducedTransition : spring.soft} className="mt-5 text-[12px] text-muted" data-passed-pile><summary className={`w-fit cursor-pointer rounded-sm py-2 hover:text-ink ${FOCUS}`}>passed ({passed.length})</summary><div className="mt-1 space-y-2">{passed.map(({ idea, index }) => <motion.div key={index} layoutId={reduced ? undefined : `${message.id}-${index}`} transition={reduced ? reducedTransition : spring.soft} className="flex items-center justify-between gap-3 rounded-xl bg-ink/[0.035] px-4 py-3"><span>{idea.title}</span><Button variant="ghost" disabled={!!passing} onClick={() => onPass(index, false)} aria-label={`Undo pass: ${idea.title}`}>Undo</Button></motion.div>)}</div></motion.details> : null}
  </LayoutGroup>;
}
