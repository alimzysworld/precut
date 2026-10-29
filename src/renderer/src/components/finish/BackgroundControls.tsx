import { useEffect, useRef, useState } from 'react';
import type { PieceFx } from '../../../../shared/schema';
import { getApi } from '../../data';
import { Button, FOCUS, InlineError, Row, SectionHeader, SegmentedControl as Segments } from '../ui';

export function BackgroundControls({ value, busy, onChange, onCommit, onAll }: {
  value: PieceFx['background']; busy: boolean;
  onChange: (value: PieceFx['background']) => void;
  onCommit: (value: PieceFx['background']) => Promise<void>;
  onAll?: (value: PieceFx['background']) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null), [working, setWorking] = useState(false);
  const pending = useRef(false), colour = useRef(value?.colour ?? '#e4e2dc');
  useEffect(() => { colour.current = value?.colour ?? '#e4e2dc'; }, [value?.colour]);
  async function commit(next: PieceFx['background']) {
    if (pending.current || busy) return;
    pending.current = true; setWorking(true); setError(null);
    try { await onCommit(next); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't change the background."); }
    finally { pending.current = false; setWorking(false); }
  }
  async function image() {
    try { const [file] = await getApi().pickOverlayFiles(); if (file) await commit({ mode: 'image', image: file }); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't open that image."); }
  }
  return <section aria-label="Background" className="space-y-2">
    <SectionHeader as="h4" className="font-medium">Background</SectionHeader>
    <fieldset disabled={busy || working}><Segments label="Background mode" value={value?.mode === 'colour' || value?.mode === 'image' ? value.mode : 'off'} options={[
      { value: 'off', label: 'Off' }, { value: 'colour', label: 'Colour' }, { value: 'image', label: 'Image' },
    ]} onChange={mode => {
      if (mode === 'image') void image();
      else void commit(mode === 'off' ? null : { mode: 'colour', colour: colour.current });
    }} /></fieldset>
    {value?.mode === 'colour' ? <Row as="label" className="text-micro text-muted">Colour
      <input type="color" aria-label="Background colour" value={value.colour} disabled={busy || working} className={`h-7 w-12 cursor-pointer rounded border-0 bg-transparent p-0 ${FOCUS}`}
        onChange={e => { colour.current = e.target.value; onChange({ mode: 'colour', colour: e.target.value }); }}
        onBlur={() => void commit({ mode: 'colour', colour: colour.current })} onKeyUp={e => { if (e.key === 'Enter') void commit({ mode: 'colour', colour: colour.current }); }} />
    </Row> : null}
    {value?.mode === 'image' ? <Button disabled={busy || working} onClick={() => void image()}>Choose another image</Button> : null}
    {onAll ? <Button disabled={busy || working} onClick={() => {
      if (pending.current) return;
      pending.current = true; setWorking(true); setError(null);
      void onAll(value?.mode === 'colour' || value?.mode === 'image' ? value : null).catch(e => setError(e instanceof Error ? e.message : "Couldn't change all backgrounds.")).finally(() => { pending.current = false; setWorking(false); });
    }}>Use for all clips</Button> : null}
    {working ? <p role="status" className="text-micro text-muted">Preparing background</p> : null}
    {error ? <InlineError>{error}</InlineError> : null}
  </section>;
}
