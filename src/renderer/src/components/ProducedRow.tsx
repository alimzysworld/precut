// Finishing touches live above Claude's input. Every follow-up is one undoable version.
import { useEffect, useState } from "react";
import type { Activity, CutEdit, CutVersion, ProduceGroup, ProduceOutcome } from "../../../shared/schema";
import { getApi } from "../data";
import { FOCUS } from "./ui";
import { formatEta } from "./processingFormat";

const BUTTON = `rounded-full bg-ink/[0.06] px-3 py-1 text-small font-medium text-ink hover:bg-ink/[0.1] active:bg-ink/[0.14] disabled:opacity-40 disabled:hover:bg-ink/[0.06] ${FOCUS}`;
const ROW = "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1.5 py-1 text-small text-ink";
// The same choices main makes: Less takes the weakest group no group still in needs; More the strongest whose needs are in.
const canLess = (groups: ProduceGroup[]) => groups.some(g => g.on && !groups.some(o => o.on && o.needs?.includes(g.id)));
const canMore = (groups: ProduceGroup[]) => groups.some(g => !g.on && (g.needs ?? []).every(n => groups.some(o => o.id === n && o.on)));
const producing = (a: Activity, root: string, cutId: string) => a.root === root && a.target?.cutId === cutId && (a.label.startsWith("Producing") || a.label.startsWith("Adding finishing touches"));

type ProduceProps = { root?: string; cutId?: string; version: CutVersion; busy: boolean; onEdit: (edit: CutEdit) => unknown; onOpen?: (version: number) => void };
export function ProducedRow({ root, cutId, version, busy, onEdit }: ProduceProps) {
  const pass = version.produce, api = getApi();
  const [running, setRunning] = useState<Activity | null>(null);
  const [outcome, setOutcome] = useState<ProduceOutcome | null>(null);
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

  if (running) return <section aria-label="Finishing touches" data-produced-row data-produced-state="producing" className={ROW}>
    <p role="status" className="min-w-0 basis-full">{running.label.replace(/^Producing/, "Adding finishing touches")}</p>
    {running.note || running.etaS != null ? <span className="truncate text-micro text-muted">{[running.note, formatEta(running.etaS)].filter(Boolean).join(" · ")}</span> : null}
  </section>;

  if (!pass || pass.removed !== undefined) {
    const note = pass?.note?.version === version.version ? pass.note.text : null;
    const said = outcome && outcome.state !== "landed" && outcome.state !== "waiting" && outcome.on === version.version ? outcome : null;
    if (!note && !said) return null;
    const state = said ? said.state : "idle";
    return <section aria-label="Finishing touches" data-produced-row data-produced-state={state} className={ROW}>
      <p role="status" className="min-w-0 flex-1 text-muted">
        {pass?.removed === version.version && note ? `Took the finishing touches out. ${note}`
          : said?.state === "left" ? <><span className="text-ink">Left as it is: </span>{said.text}</>
          : said ? `Couldn't add finishing touches: ${said.text.replace(/^Nothing was applied[.:]\s*/, "")}`
          : null}
      </p>

    </section>;
  }

  const note = pass.note?.version === version.version ? pass.note.text : null;
  const on = pass.groups.filter(g => g.on).length, edit = (op: "less" | "more" | "remove") => { void onEdit({ kind: "produce", op }); };
  const about = [pass.payoff ? `Pays off on “${pass.payoff.replace(/^["“]|["”]$/g, "")}”` : null, pass.quiet ? `Quiet: ${pass.quiet}` : null].filter(Boolean).join(" ");
  return <section aria-label="Finishing touches" data-produced-row data-produced-state="landed" className={ROW}>
    <p className="min-w-0 flex-1 truncate text-micro" title={[pass.idea, about].filter(Boolean).join(" · ")}><span className="text-muted">Finishing touches: </span>{pass.idea}</p>
    <span className="sr-only">{on} of {pass.groups.length} in</span>
    <div className="flex basis-full items-center gap-1.5">
      <button type="button" className={BUTTON} disabled={busy || !canMore(pass.groups)} onClick={() => edit("more")} title="Put the strongest group taken out back in">More</button>
      <button type="button" className={BUTTON} disabled={busy || !canLess(pass.groups)} onClick={() => edit("less")} title="Take the weakest group of moves out">Less</button>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => edit("remove")} title="Take the whole pass out, keeping your own changes">Take them out</button>
    </div>
    {note ? <p role="status" className="basis-full text-small text-muted">{note}</p> : null}
  </section>;
}
