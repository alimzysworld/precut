import { useEffect, useRef, useState } from 'react';
import { Checkbox, DialogSurface, FOCUS, InlineError, SectionHeader } from './ui';

export function ShotOrderDialog({ count, onClose, onApply }: { count?: number; onClose: () => void; onApply: (keepMyMoves: boolean) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false);
  const [keepMyMoves,setKeepMyMoves]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const node=dialog.current;node?.showModal();return ()=>node?.close();},[]);
  async function apply() {
    if(pending.current)return;
    pending.current=true;setBusy(true);setError('');
    try {await onApply(keepMyMoves);onClose();}
    catch(e){setError(e instanceof Error?e.message:'Could not put these clips in shot order.');}
    finally{pending.current=false;setBusy(false);}
  }
  return <dialog ref={dialog} onCancel={event=>{event.preventDefault();if(!busy)onClose();}} className="m-auto w-[min(420px,calc(100vw-32px))] rounded-2xl bg-surface p-5 text-ink" style={{border:0,outline:'none',boxShadow:'none',backdropFilter:'none'}}>
    <DialogSurface aria-modal="true" aria-labelledby="shot-order-title" onClose={()=>{if(!busy)onClose();}}>
    <SectionHeader as="h2" id="shot-order-title" className="text-body font-semibold">Put in shot order</SectionHeader>
    <p className="mt-2 text-small text-muted">{count === 1 ? 'Order this clip by when it was filmed.' : count ? `Order these ${count} clips by when they were filmed.` : 'Order this edit by when it was filmed.'} Unknown times stay in place.</p>
    <label className="my-4 flex items-center gap-2 text-small"><Checkbox checked={keepMyMoves} disabled={busy} onChange={event=>setKeepMyMoves(event.target.checked)} />Keep my moves</label>
    {error && <InlineError className="mb-3 text-small text-danger">{error}</InlineError>}
    <div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-3 py-2 text-small hover:bg-ink/[0.05] ${FOCUS}`}>Cancel</button><button autoFocus type="button" disabled={busy} onClick={()=>void apply()} className={`st-button-primary rounded-lg px-3 py-2 text-small text-white ${FOCUS}`}>Put in shot order</button></div>
  </DialogSurface></dialog>;
}
