import { useEffect, useState } from 'react';
import type { BalanceOptions, BalanceStatus } from '../../../shared/schema';
import { getApi } from '../data';
const EMPTY:BalanceStatus={state:'idle',ready:[],corrected:0,hand:0};
export function useBalance(root:string,cutId:string|undefined,version:number) {
  const [status,setStatus]=useState<BalanceStatus>(EMPTY);
  useEffect(()=>{
    if(!cutId || typeof getApi().balanceStatus!=='function')return;
    let alive=true,pending=false,playing=false,timer:ReturnType<typeof setTimeout>|undefined;
    const read=async()=>{if(pending || playing || !cutId || !getApi().balanceStatus)return;pending=true;try{const next=await getApi().balanceStatus(root,cutId,version);if(alive)setStatus(next);}catch{/* Reopening/removed edits retire their status quietly. */}finally{pending=false;if(alive && !playing)timer=setTimeout(read,1200);}};
    const playback=(event:Event)=>{playing=!!(event as CustomEvent<boolean>).detail;clearTimeout(timer);if(!playing)void read();};
    window.addEventListener('sidething:playing',playback);
    window.dispatchEvent(new CustomEvent('sidething:playing-request'));
    setStatus(EMPTY);void read();
    const clear=(event:Event)=>{const id=(event as CustomEvent<string>).detail;setStatus(old=>({...old,ready:old.ready.filter(clip=>clip!==id)}));};
    window.addEventListener('precut:balance-hand',clear);
    return ()=>{alive=false;clearTimeout(timer);window.removeEventListener('precut:balance-hand',clear);window.removeEventListener('sidething:playing',playback);};
  },[root,cutId,version]);
  return status;
}
export function autoCorrect(root:string,cutId:string,version:number,options:BalanceOptions={}) {
  return getApi().balanceClips(root,cutId,version,options);
}
export function ownBalance(root:string,clipId:string|undefined) {
  if(!clipId)return;
  window.dispatchEvent(new CustomEvent('precut:balance-hand',{detail:clipId}));
  void getApi().balanceHand?.(root,clipId).catch(()=>{});
}
