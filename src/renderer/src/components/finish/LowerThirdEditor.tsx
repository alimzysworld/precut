import { useState } from 'react';
import type { CutEdit, LowerThird } from '../../../../shared/schema';
import { Button, FOCUS, NumberField } from '../ui';
export function LowerThirdEditor({ item, time, duration, busy, onEdit, onClose }: { item?: LowerThird; time: number; duration: number; busy: boolean; onEdit: (edit: CutEdit) => Promise<unknown>; onClose?: () => void }) {
  const [draft, setDraft] = useState<Omit<LowerThird, 'id'>>(item ?? { s: Math.max(0, Math.min(time, duration - .04)), e: Math.min(duration, time + 3), title: '', subtitle: '', position: 'left' });
  const field = `w-full min-w-0 rounded-lg bg-ink/[0.06] px-2 py-1.5 text-[12px] text-ink ${FOCUS}`;
  const valid = draft.title.trim() && Number.isFinite(draft.s) && Number.isFinite(draft.e) && draft.s >= 0 && draft.e > draft.s && draft.e <= duration;
  return <form aria-label={item ? `Lower third: ${item.title}` : 'Add lower third'} className="space-y-2 rounded-lg bg-ink/[0.04] p-2" onSubmit={event => {
    event.preventDefault(); if (!valid || busy) return;
    void onEdit(item ? { kind: 'lowerThird', op: 'update', id: item.id, patch: draft } : { kind: 'lowerThird', op: 'add', item: draft }).then(ok => { if (ok !== false) onClose?.(); });
  }}>
    <p className="text-[12px] font-semibold">Lower third</p>
    <label className="block text-[11px] text-muted">Title<input aria-label="Lower third title" maxLength={160} required value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} className={field} /></label>
    <label className="block text-[11px] text-muted">Subtitle<input aria-label="Lower third subtitle" maxLength={240} value={draft.subtitle ?? ''} onChange={e => setDraft({ ...draft, subtitle: e.target.value })} className={field} /></label>
    <div className="grid grid-cols-2 gap-2">{(['s','e'] as const).map(key => <label key={key} className="text-[11px] text-muted">{key === 's' ? 'Start (seconds)' : 'End (seconds)'}<NumberField aria-label={key === 's' ? 'Lower third start' : 'Lower third end'} min={0} max={duration} step={.04} value={Number.isFinite(draft[key]) ? draft[key] : ''} onChange={e => setDraft({ ...draft, [key]: e.target.value === '' ? NaN : Number(e.target.value) })} className={field} /></label>)}</div>
    <label className="block text-[11px] text-muted">Side<select aria-label="Lower third side" value={draft.position} onChange={e => setDraft({ ...draft, position: e.target.value as LowerThird['position'] })} className={field}>{(['left','centre','right'] as const).map(side => <option key={side} value={side}>{side[0].toUpperCase() + side.slice(1)}</option>)}</select></label>
    <div className="flex gap-2"><Button type="submit" variant="primary" disabled={busy || !valid}>{item ? 'Save text' : 'Add lower third'}</Button>{item ? <Button type="button" disabled={busy} onClick={() => void onEdit({ kind: 'lowerThird', op: 'remove', id: item.id })}>Remove</Button> : <Button type="button" onClick={onClose}>Cancel</Button>}</div>
  </form>;
}
