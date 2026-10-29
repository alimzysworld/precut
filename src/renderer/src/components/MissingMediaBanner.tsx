import { useModelAccess, ModelSignIn } from "./ModelAccess";
import { useRef, useState } from 'react';
import type { Shoot } from '../../../shared/schema';
import { getApi } from '../data';
import { Button, InlineError } from './ui';

/** The one relink: pick the shoot's folder where it is now. Returns the shoot's root after relinking, or null if no folder was picked. */
export async function relinkShootFolder(root: string): Promise<string | null> {
  const api = getApi();
  const folder = await api.pickFolder();
  return folder ? (await api.relinkMissing(root, folder)).root : null;
}

/**
 * Missing and new footage in the shoot's folder. EXP3: the editor shows it too (`editor`): only the missing clips, with
 * Relink, since a clip renamed or deleted under an open edit is what it is there for. Main watches the shoot on screen,
 * so it appears within seconds of the file going and clears once it is back.
 */
export function MissingMediaBanner({ shoot, onShootChange, onRelink, editor = false }: { shoot: Shoot; onShootChange: (shoot: Shoot) => void; onRelink: (root: string) => void; editor?: boolean }) {
  const modelReady = useModelAccess();
  const [dismissed, setDismissed] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const pending = useRef(false);
  const changes = editor ? undefined : shoot.folderChanges;
  const missing = shoot.clips.filter(c => c.missing && !c.leftOut).length;
  const fresh = changes?.newFiles.length ?? 0, updated = changes?.changedFiles.length ?? 0, audio = changes?.newAudio.length ?? 0;
  const photos = changes?.newFiles.filter(file => /\.(heic|heif|jpe?g|png|webp|tiff?|avif)$/i.test(file)).length ?? 0;
  const videos = fresh - photos;
  const stamp = JSON.stringify([shoot.root, shoot.clips.filter(c => c.missing && !c.leftOut).map(c => c.id), changes]);
  if ((!missing && !fresh && !updated && !audio) || dismissed === stamp) return null;
  async function act(action: 'Relink' | 'Rethink' | 'Add') {
    if (pending.current || action === 'Rethink' && !modelReady) return;
    pending.current = true; setBusy(action); setError('');
    try {
      const api = getApi();
      if (action === 'Relink') {
        const root = await relinkShootFolder(shoot.root);
        if (root) onRelink(root);
      } else onShootChange(await (action === 'Rethink' ? api.rethinkWithoutMissing(shoot.root) : api.addNewFiles(shoot.root)));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update this footage. Try again.'); }
    finally { pending.current = false; setBusy(''); }
  }
  return <section aria-label="Folder changes" data-missing-media-banner className={`${editor ? 'mb-2 shrink-0 px-3 py-2' : 'mb-4 p-4'} rounded-2xl bg-surface text-small text-ink`}>
    <div className={`flex ${editor ? 'items-center gap-3' : 'items-start gap-4'}`}><div className="min-w-0 flex-1 space-y-2">
      {missing > 0 && <div className="flex flex-wrap items-center gap-2"><span>{missing} {missing === 1 ? 'clip is' : 'clips are'} missing from the folder</span><Button disabled={!!busy} onClick={() => void act('Relink')}>Relink</Button>{editor ? null : modelReady ? <Button variant="primary" disabled={!!busy} onClick={() => void act('Rethink')}>Rethink without them</Button> : <ModelSignIn feature="rethink" />}</div>}
      {(fresh > 0 || updated > 0 || audio > 0) && <div className="flex flex-wrap items-center gap-2"><span>{[photos > 0 && `${photos} new ${photos === 1 ? 'photo' : 'photos'} in the folder`, videos > 0 && `${videos} new ${videos === 1 ? 'clip' : 'clips'} in the folder`, updated > 0 && `${updated} changed ${updated === 1 ? 'clip' : 'clips'}`, audio > 0 && `${audio} new or changed ${audio === 1 ? 'recording' : 'recordings'}`].filter(Boolean).join(' · ')}</span><Button variant="primary" disabled={!!busy} onClick={() => void act('Add')}>Add them</Button></div>}
    </div><Button variant="ghost" disabled={!!busy} onClick={() => setDismissed(stamp)}>Dismiss</Button></div>
    {error && <InlineError className="mt-2 text-danger">{error}</InlineError>}
  </section>;
}
