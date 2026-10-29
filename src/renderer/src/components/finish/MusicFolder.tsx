import { useState } from "react";
import { getApi } from "../../data";
import { Button, InlineError } from "../ui";

// ONB1b: the one music folder choice, shared by first run, Settings and the Sound panel.
export const MUSIC_FOLDER_LINE = "precut picks tracks from this folder. Use music you're allowed to post.";
export const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

export function MusicFolderChoice({ folder, onChosen, line = MUSIC_FOLDER_LINE, disabled = false }: {
  folder: string | null; onChosen: (folder: string) => void; line?: string | null; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function choose() {
    setBusy(true); setError("");
    // The main process opens the folder sheet and saves the choice for new edits.
    try { const chosen = await getApi().pickMusicFolder(); if (chosen) onChosen(chosen); }
    catch { setError("Couldn't use that folder. Try again."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2">
    {line ? <p className="text-small text-muted">{line}</p> : null}
    <div className="flex min-w-0 items-center gap-3">
      <Button aria-label="Choose music folder" disabled={busy || disabled} onClick={() => void choose()}>{folder ? "Change folder" : "Choose folder"}</Button>
      {folder ? <span className="min-w-0 truncate text-micro text-muted" title={folder}>{folderName(folder)}</span> : null}
    </div>
    {error ? <InlineError className="text-micro text-danger">{error}</InlineError> : null}
  </div>;
}
