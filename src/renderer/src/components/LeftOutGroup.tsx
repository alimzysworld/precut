import { useState } from 'react';
import type { Shoot } from '../../../shared/schema';
import { getApi } from '../data';
import { Button, InlineError, FOCUS } from './ui';
import { RotatingImage } from './RotatingImage';
import { takeThumbnail } from './footage/thumbnail';

export function LeftOutGroup({ shoot, onShootChange }: { shoot: Shoot; onShootChange: (shoot: Shoot) => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const clips = shoot.clips.filter(c => c.leftOut);
  if (!clips.length) return null;
  async function putBack(ids: string[]) {
    if (busy) return;
    setBusy(true); setError('');
    try { onShootChange(await getApi().leaveOut(shoot.root, ids, false)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not put these clips back.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Left out" className="rounded-2xl bg-surface p-4">
    <div className="flex items-center gap-3">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className={`flex-1 rounded-lg text-left text-small font-medium ${FOCUS}`}>Left out <span className="ml-2 tnum font-normal text-muted">{clips.length}</span></button>
      <Button disabled={busy} onClick={() => void putBack(clips.map(c => c.id))}>Put back</Button>
    </div>
    {open && <div className="mt-3 flex flex-wrap gap-3">{clips.map(clip => {
      const src = takeThumbnail(shoot, { clip, s: 0 });
      return <div key={clip.id} data-clip-menu={clip.id} tabIndex={0} aria-label={clip.judgement?.summary || 'Left-out clip'} className={`w-44 rounded-xl bg-ground p-1 ${FOCUS}`}>
        <div className="aspect-video overflow-hidden rounded-lg opacity-50">{src && <RotatingImage root={shoot.root} clip={clip} src={src} alt="" className="h-full w-full object-cover" />}</div>
        <Button variant="ghost" disabled={busy} className="mt-1 w-full" onClick={() => void putBack([clip.id])}>Put back</Button>
      </div>;
    })}</div>}
    {error && <InlineError className="mt-2 text-small text-danger">{error}</InlineError>}
  </section>;
}
