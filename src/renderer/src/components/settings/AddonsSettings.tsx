import { useEffect, useState } from "react";
import type { ExtensionInfo } from "../../../../shared/schema";
import { getApi } from "../../data";
import { AddOnPrompt } from "../AddOnPrompt";
import { Button, InlineError, SectionHeader } from "../ui";

export function AddonsSettings() {
  const [items, setItems] = useState<ExtensionInfo[] | null>(null), [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void getApi().extensions().then(items => { if (active) { setItems(items.filter(item => item.id === "elevenlabs" || item.id === "sound-separation")); setError(""); } })
      .catch(() => { if (active) setError("Could not read add-ons. Try again."); });
    return () => { active = false; };
  }, [attempt]);
  return <><SectionHeader as="h2" heading="Add-ons">Add what you need, when you need it.</SectionHeader><InlineError error={error} />
    {error && <Button onClick={() => setAttempt(n => n + 1)}>Try again</Button>}
    {!items && !error && <p role="status" className="text-small text-muted">Reading add-ons…</p>}
    <div className="space-y-3">{items?.map(item => <AddOnPrompt key={item.id} extension={item} manage onChange={next => setItems(current => current?.map(item => item.id === next.id ? next : item) ?? null)} />)}</div>
    {items?.length === 0 && <p className="text-small text-muted">No add-ons are available.</p>}
  </>;
}
