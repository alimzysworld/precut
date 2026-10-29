import {useEffect,useState} from 'react';
import type { Preferences } from '../../../../shared/schema';
import { Slider, Row } from '../ui';
import { settingInput } from './shared';
export function ClipSoundDefault({value,onChange}:{value:Preferences['clipSoundNewEdits'];onChange:(value:NonNullable<Preferences['clipSoundNewEdits']>)=>void}) {
  const choice=value ?? {on:false,db:-20};
  const [db,setDb]=useState(choice.db);useEffect(()=>setDb(choice.db),[choice.db]);
  return <section className="space-y-3"><Row as="label"><span className="text-small">Clip sound in new edits</span><select aria-label="Clip sound in new edits" className={settingInput} value={choice.on?'on':'off'} onChange={event=>onChange({...choice,on:event.target.value==='on'})}><option value="off">Off under music</option><option value="on">On at a level</option></select></Row>
    {choice.on && <Slider label="Clip sound level" value={db} min={-60} max={6} step={.5} unit=" dB" defaultValue={-20} onChange={setDb} onRelease={db=>onChange({...choice,db})} />}
  </section>;
}
