import { useCallback, useEffect, useState } from "react";
import type { ShootSummary } from "../../../../shared/schema";
import { getApi } from "../../data";
import { Button, InlineError, Row, SectionHeader } from "../ui";

type Usage = { cacheBytes: number; exportBytes: number; footageBytes: number };
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

/** R6: what precut keeps per shoot. Clearing only removes what precut rebuilds when needed. */
export function StorageSettings() {
  const [shoots, setShoots] = useState<ShootSummary[]>([]), [usage, setUsage] = useState<Record<string, Usage>>({});
  const [clearing, setClearing] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const read = useCallback(async (root: string) => {
    const next = await getApi().storageUsage(root);
    setUsage(previous => ({ ...previous, [root]: next }));
  }, []);
  useEffect(() => {
    let alive = true;
    void getApi().listShoots().then(list => {
      if (!alive) return;
      const online = list.filter(s => s.online);
      setShoots(online);
      online.forEach(s => void read(s.root).catch(() => {}));
    }).catch(() => { if (alive) setError("Could not read your shoots. Try again."); });
    return () => { alive = false; };
  }, [read]);
  async function clear(root: string) {
    setClearing(root); setError(null);
    try { await getApi().clearCaches(root); await read(root); }
    catch { setError("Could not clear this shoot. Try again."); }
    finally { setClearing(null); }
  }
  if (!shoots.length) return null;
  return <div>
    <SectionHeader as="h3" className="mb-3 text-small font-medium">Storage</SectionHeader>
    <p className="mb-2 text-micro text-muted">precut rebuilds cleared files when it needs them. Your footage and exports are never touched.</p>
    <InlineError error={error} />
    {shoots.map(shoot => {
      const u = usage[shoot.root];
      return <Row key={shoot.root} className="settings-row">
        <span className="text-small">{shoot.name}<span className="text-micro text-muted">{u ? ` Using ${size(u.cacheBytes)} (footage not included)${u.exportBytes ? `, exports ${size(u.exportBytes)}` : ""}` : ""}</span></span>
        <Button disabled={!u || clearing === shoot.root} onClick={() => void clear(shoot.root)}>{clearing === shoot.root ? "Clearing…" : "Clear caches"}</Button>
      </Row>;
    })}
  </div>;
}
