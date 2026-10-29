import { useEffect, useRef, useState } from 'react';
import type { ClipSoundClean, ExtensionInfo } from '../../../../shared/schema';
import { getApi } from '../../data';
import { AddOnPrompt } from '../AddOnPrompt';
import { InlineError, Tile } from '../ui';

export const CLEAN_SOUND_CHOICES = [['none','Original sound'],['remove_music','Remove music'],['isolate_voice','Isolate voice']] as const;
export function useSoundSeparation() {
  const [extension,setExtension] = useState<ExtensionInfo | null>(null), [error,setError] = useState('');
  const pending = useRef<(() => void | Promise<unknown>) | null>(null);
  async function request(action: () => void | Promise<unknown>, needsAddon = true) {
    setError('');
    try {
      if(!needsAddon){await action();return;}
      const addon = (await getApi().extensions()).find(item=>item.id==='sound-separation');
      if(!addon)throw Error('Sound separation is unavailable. Check Settings > Add-ons.');
      if(addon.state !== 'installed') {pending.current=action;setExtension(addon);return;}
      await action();
    } catch {setError('Could not change sound. Try again.');}
  }
  return { request, prompt:<>{extension ? <AddOnPrompt compact extension={extension} onNotNow={()=>{pending.current=null;setExtension(null);}} onReady={()=>{const action=pending.current;pending.current=null;setExtension(null);if(action)void Promise.resolve().then(action).catch(()=>setError('Could not change sound. Try again.'));}} /> : null}{error ? <InlineError>{error}</InlineError> : null}</> };
}
// REL2: on a Mac that can't run Sound separation, its two choices hide and the panel says why.
export function useSoundSeparationUnsupported() {
  const [reason,setReason] = useState('');
  useEffect(()=>{let alive=true;void Promise.resolve(getApi().extensions?.()).then(list=>{const why=list?.find(item=>item.id==='sound-separation')?.unsupported;if(alive&&why)setReason(why);}).catch(()=>{});return()=>{alive=false;};},[]);
  return reason;
}
export function ClipSoundCleaning({value='none',mixed=false,onChange,disabled=false}:{value?:ClipSoundClean;mixed?:boolean;onChange:(value:ClipSoundClean)=>void | Promise<unknown>;disabled?:boolean}) {
  const addon=useSoundSeparation(), unsupported=useSoundSeparationUnsupported();
  if(unsupported && value==='none') return <p className="text-micro text-muted">Remove music and Isolate voice: {unsupported.charAt(0).toLowerCase()+unsupported.slice(1)}</p>;
  return <div className="space-y-2"><div role="group" aria-label="Clean clip sound" className="flex flex-wrap gap-1">{CLEAN_SOUND_CHOICES.filter(([mode])=>!unsupported||mode==='none'||mode===value).map(([mode,label])=><Tile key={mode} type="button" disabled={disabled} selected={!mixed && value===mode} className="rounded-md px-2 py-1.5 text-micro" onClick={()=>{void addon.request(()=>onChange(mode),mode!=='none');}}>{label}</Tile>)}</div>{value==='remove_music' ? <p className="text-micro text-muted">Reduces instruments. Singing may remain.</p> : null}{addon.prompt}</div>;
}
