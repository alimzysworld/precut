// REL2: Settings, Privacy. Exactly what goes where, and the one switch that decides whether any picture leaves precut
// for the AI. Off: no stills or contact sheets go to the engine (main enforces it at the one place every model call
// passes); judging, ideas and edits work from text and measurements. MCP: get_settings / set_settings aiSeesFrames.
import { SectionHeader } from "../ui";
import { SettingToggle, usePreferences } from "./shared";

const ON_MAC = ["Your footage, audio and photos: precut reads them, it never uploads them.", "Transcribing speech (the speech model runs on this Mac), previews, looks, sound, editing and exporting."];
const TO_AI = ["Transcripts with word timings, and clip, folder and shoot names.", "Your notes, brief, skills and words to spell right.", "Edit plans and measurements (lengths, sound levels, shake, colour)."];
const ELSEWHERE = [
  "First launch: Python from GitHub, Python packages from PyPI and the speech model from Hugging Face, each pinned to the version precut is tested with.",
  "Update checks: GitHub, about every six hours, unless you turn them off in General.",
  "ElevenLabs, only if you connect your own key: the words describing a sound.",
  "Add-ons you install in Add-ons: their files, from the sites listed there.",
];

function List({ items }: { items: readonly string[] }) {
  return <ul className="m-0 list-disc space-y-1 pl-5 text-small text-muted">{items.map(item => <li key={item}>{item}</li>)}</ul>;
}

export function PrivacySettings() {
  const state = usePreferences();
  const sees = state.value?.aiSeesFrames !== false;
  return <>
    <SectionHeader as="h2" heading="Privacy">What stays on this Mac and what goes to the AI you pick.</SectionHeader>
    <p role="status" aria-live="polite" className="mb-3 min-h-4 text-micro text-muted">{state.status}</p>
    <div className="space-y-5" data-privacy-settings>
      {state.value && <div>
        <SettingToggle label="AI sees frames" checked={sees} onChange={aiSeesFrames => void state.change({ aiSeesFrames })} />
        <p className="text-small text-muted">{sees
          ? "Small still frames and contact sheets from your footage go to the AI with the text, so it can judge framing, light and what is in shot."
          : "No pictures go to the AI. It judges takes, writes ideas and cuts edits from transcripts and measurements alone; anything that needs to see a shot says so."}</p>
      </div>}
      <section><h3 className="mb-2 text-small font-medium">Stays on this Mac</h3><List items={ON_MAC} /></section>
      <section><h3 className="mb-2 text-small font-medium">Goes to the AI you pick</h3>
        <p className="mb-2 text-small text-muted">Through Claude Code or Codex on this Mac, to Anthropic or OpenAI under your own plan:</p>
        <List items={[...TO_AI, sees ? "Small still frames and contact sheets (AI sees frames is on)." : "No frames or contact sheets (AI sees frames is off)."]} />
        <p className="mt-2 text-small text-muted">precut asks Claude Code and Codex not to keep a history of its own requests. Ask is a terminal you open yourself: like any session you start, Claude Code keeps it in ~/.claude and Codex in ~/.codex.</p>
      </section>
      <section><h3 className="mb-2 text-small font-medium">Other connections</h3><List items={ELSEWHERE} /></section>
      <p className="text-small text-muted">precut sends nothing to sidething. There is no account, analytics or crash upload; errors go to a log on this Mac.</p>
    </div>
  </>;
}
