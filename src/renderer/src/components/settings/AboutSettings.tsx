// REL2: Settings, About. The version, precut's own licence and every licence text it ships (Resources/licenses), each
// readable here; Chromium's long list opens in the Mac's default app. Read-only. MCP: get_about.
import { useEffect, useState } from "react";
import { getApi } from "../../data";
import { Button, InlineError, Row, SectionHeader } from "../ui";
import { AboutCredits } from "./AboutCredits";  // ONB2: starter music credits and where the sounds come from

type Licence = { file: string; name: string; covers: string; bytes: number; inline: boolean };
type About = { version: string; licence: string; source: string; licences: Licence[] };
type AboutApi = { about?: () => Promise<About>; readLicence?: (file: string) => Promise<string>; openLicence?: (file: string) => Promise<void> };
const aboutApi = () => getApi() as ReturnType<typeof getApi> & AboutApi;

export function AboutSettings() {
  const [about, setAbout] = useState<About | null>(null), [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null), [text, setText] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const api = aboutApi();
    if (typeof api.about !== "function") { setError("Licences are listed in the installed app."); return; }
    void api.about().then(value => { if (alive) { setAbout(value); setError(""); } }).catch(() => { if (alive) setError("Could not read the licences. Try again."); });
    return () => { alive = false; };
  }, [attempt]);
  async function show(item: Licence) {
    const api = aboutApi();
    setError("");
    if (!item.inline) { await api.openLicence?.(item.file).catch(() => setError("Could not open that licence. Try again.")); return; }
    if (open === item.file) { setOpen(null); setText(""); return; }
    try { setText(await api.readLicence!(item.file)); setOpen(item.file); }
    catch { setError("Could not read that licence. Try again."); }
  }
  return <>
    <SectionHeader as="h2" heading="About">precut is free software from sidething.</SectionHeader>
    <InlineError error={error} />
    {error && !about && <Button onClick={() => setAttempt(n => n + 1)}>Try again</Button>}
    {about && <div className="space-y-5" data-about-settings>
      <div className="space-y-1 text-small">
        <p className="m-0">precut {about.version}</p>
        <p className="m-0 text-muted">Licensed under the {about.licence}. You may use, study, share and change it; a changed version you offer to others, including over a network, must offer its source too.</p>
        <p className="m-0 text-muted">Source: <a href={about.source} target="_blank" rel="noreferrer" className="text-accent underline">{about.source.replace(/^https:\/\//, "")}</a></p>
      </div>
      <section aria-label="Licences" data-licences>
        <SectionHeader as="h3" className="mb-1 text-small font-medium">Licences</SectionHeader>
        <p className="mb-3 text-small text-muted">The software and content precut ships keep their own licences. The texts travel with the app.</p>
        <div className="space-y-1">{about.licences.map(item => <div key={item.file} className="rounded-xl bg-ink/[0.035] px-3 py-2">
          <Row className="settings-row gap-3">
            <span className="min-w-0 text-small">{item.name}<span className="block text-micro text-muted">{item.covers}</span></span>
            <Button variant="ghost" aria-expanded={item.inline ? open === item.file : undefined} onClick={() => void show(item)}>{!item.inline ? "Open" : open === item.file ? "Hide" : "Read"}</Button>
          </Row>
          {open === item.file && <pre data-licence-text={item.file} className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ground p-3 font-mono text-micro text-muted">{text}</pre>}
        </div>)}</div>
      </section>
      <AboutCredits />
    </div>}
  </>;
}
