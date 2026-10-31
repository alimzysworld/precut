// PRO1: the quiet row near the viewer once a Produce pass is in the edit: what the pass is for, Less, More and Remove.
// Each button is one saved version and one Cmd+Z (main: produce-pass.ts). Soft fills only, never an outline, ring or
// stroke; keyboard focus shows the app's selection fill (brand.css).
// PRO2: the same row before a pass. Produce it (the person asks; drafts never get it by themselves), what it is doing
// while it watches and directs (the activity main reports), and what it came to when it made no pass ("Left as it is:
// ..." in the director's own words, or why it couldn't).
import { useEffect, useState } from "react";
import type { Activity, CutEdit, CutVersion, ProduceGroup, ProduceOutcome } from "../../../shared/schema";
import { getApi } from "../data";
import { FOCUS } from "./ui";
import { formatEta } from "./processingFormat";

const BUTTON = `rounded-full bg-ink/[0.06] px-3 py-1 text-small font-medium text-ink hover:bg-ink/[0.1] active:bg-ink/[0.14] disabled:opacity-40 disabled:hover:bg-ink/[0.06] ${FOCUS}`;
const PRIMARY = `st-button-primary rounded-full px-3 py-1 text-small font-medium disabled:opacity-40 ${FOCUS}`;
const ROW = "mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-surface px-3 py-2 text-small text-ink";
// The same choices main makes: Less takes the weakest group no group still in needs; More the strongest whose needs are in.
const canLess = (groups: ProduceGroup[]) => groups.some(g => g.on && !groups.some(o => o.on && o.needs?.includes(g.id)));
const canMore = (groups: ProduceGroup[]) => groups.some(g => !g.on && (g.needs ?? []).every(n => groups.some(o => o.id === n && o.on)));
const plain = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const producing = (a: Activity, root: string, cutId: string) => a.root === root && a.target?.cutId === cutId && a.label.startsWith("Producing");

export function ProducedRow({ root, cutId, version, busy, onEdit, onOpen }: { root?: string; cutId?: string; version: CutVersion; busy: boolean; onEdit: (edit: CutEdit) => unknown; onOpen?: (version: number) => void }) {
  const pass = version.produce, api = getApi();
  const [running, setRunning] = useState<Activity | null>(null);
  const [outcome, setOutcome] = useState<ProduceOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!root || !cutId || !api.produceOutcome) { setOutcome(null); return; }
    let alive = true;
    void api.produceOutcome(root, cutId, version.version).then(o => { if (alive) setOutcome(o); }, () => { if (alive) setOutcome(null); });
    return () => { alive = false; };
  }, [root, cutId, version.version, refresh, api]);
  useEffect(() => {
    if (!root || !cutId) return;
    let alive = true;
    void api.listActivity?.().then(all => { if (alive) setRunning(all.find(a => producing(a, root, cutId) && a.state === "running") ?? null); }, () => {});
    const off = api.onActivity?.(a => {
      if (!producing(a, root, cutId)) return;
      setRunning(a.state === "running" ? a : null);
      if (a.state !== "running") setRefresh(n => n + 1);
    });
    return () => { alive = false; off?.(); };
  }, [root, cutId, api]);

  const produce = async () => {
    if (!root || !cutId || !api.produceEdit) return;
    setError(null);
    try {
      const result = await api.produceEdit(root, cutId, version.version);
      setRefresh(n => n + 1);
      if (result.state === "landed" && result.version !== version.version) onOpen?.(result.version);
    } catch (e) { setError(plain(e)); }
  };

  if (running) return <section aria-label="Produced pass" data-produced-row data-produced-state="producing" className={ROW}>
    <p role="status" className="min-w-0 flex-1 truncate">{running.label}</p>
    {running.note || running.etaS != null ? <span className="truncate text-micro text-muted">{[running.note, formatEta(running.etaS)].filter(Boolean).join(" · ")}</span> : null}
  </section>;

  if (!pass || pass.removed !== undefined) {
    const note = pass?.note?.version === version.version ? pass.note.text : null;
    const said = outcome && outcome.state !== "landed" && outcome.state !== "waiting" && outcome.on === version.version ? outcome : null;
    const canProduce = !!root && !!cutId && !!api.produceEdit && !!version.pieces?.length;
    if (!canProduce && !note) return null;
    const state = error ? "failed" : said ? said.state : "idle";
    return <section aria-label="Produced pass" data-produced-row data-produced-state={state} className={ROW}>
      <p role="status" className="min-w-0 flex-1 text-muted">
        {pass?.removed === version.version && note ? `Took the pass out. ${note}`
          : error ? `Couldn't produce this: ${error}`
          : said?.state === "left" ? <><span className="text-ink">Left as it is: </span>{said.text}</>
          : said ? `Couldn't produce this: ${said.text.replace(/^Nothing was applied[.:]\s*/, "")}`
          : "Produce it: one earned payoff, the rest kept quiet."}
      </p>
      {canProduce ? <button type="button" className={said || error ? BUTTON : PRIMARY} disabled={busy} onClick={() => void produce()}
        title="Watch the edit, find its payoff and give it one produced moment">{said || error ? "Try again" : "Produce it"}</button> : null}
    </section>;
  }

  const note = pass.note?.version === version.version ? pass.note.text : null;
  const on = pass.groups.filter(g => g.on).length, edit = (op: "less" | "more" | "remove") => { void onEdit({ kind: "produce", op }); };
  const landed = outcome?.state === "landed" && outcome.version === version.version ? outcome : null;
  const about = [pass.payoff ? `Pays off on “${pass.payoff.replace(/^["“]|["”]$/g, "")}”` : null, pass.quiet ? `Quiet: ${pass.quiet}` : null].filter(Boolean).join(" ");
  return <section aria-label="Produced pass" data-produced-row data-produced-state="landed" className={ROW}>
    <p className="min-w-0 flex-1 truncate" title={about || undefined}><span className="text-muted">Produced: </span>{pass.idea}</p>
    <span className="tnum text-micro text-muted">{on} of {pass.groups.length} in</span>
    <div className="flex items-center gap-1.5">
      <button type="button" className={BUTTON} disabled={busy || !canLess(pass.groups)} onClick={() => edit("less")} title="Take the weakest group of moves out">Less</button>
      <button type="button" className={BUTTON} disabled={busy || !canMore(pass.groups)} onClick={() => edit("more")} title="Put the strongest group taken out back in">More</button>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => edit("remove")} title="Take the whole pass out, keeping your own changes">Remove</button>
    </div>
    {about ? <p className="basis-full truncate text-small text-muted">{about}</p> : null}
    {landed?.dropped.length ? <p className="basis-full text-small text-muted">Watched back and took out: {landed.dropped.map(d => `${d.reason.replace(/\.$/, "")} (${d.why.replace(/\.$/, "")})`).join("; ")}.</p> : null}
    {note ? <p role="status" className="basis-full text-small text-muted">{note}</p> : null}
  </section>;
}
