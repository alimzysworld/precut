import {useEffect,useRef,useState} from 'react';
import type {ClipTransform,CutEdit,CutVersion,DraftTimeline} from '../../../../shared/schema';
import {transformValue,transformEdits,validTransform} from '../../../../shared/clip-transform';
import {transformSessions,previewTransform,announceTransform} from '../transformPreview';
import {usePageActive} from '../../hooks/usePageActivity';
import {Slider,Switch,Button,SectionHeader,Row,InlineError} from '../ui';
export function TransformPanel({version,index,indexes,timeline,busy,onEdit,viewer,onViewer}:{version:CutVersion;index:number;indexes?:number[];timeline?:DraftTimeline|null;busy:boolean;onEdit:(edit:CutEdit)=>unknown;viewer?:boolean;onViewer?:(enabled:boolean)=>void}){
 const [localViewer,setLocalViewer]=useState(false),enabled=viewer??localViewer;
 function setViewer(next:boolean){if(!next)setLevel(false);(onViewer??setLocalViewer)(next);}
 const active=usePageActive(),targets=indexes?.length?indexes:[index],saved=transformValue(version.pieceFx?.[index]?.transform),[value,setValue]=useState(saved),[level,setLevel]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false),pending=useRef(false),patch=useRef<ClipTransform>({});
 useEffect(()=>{setValue(saved);patch.current={};},[version.version,index]);
 useEffect(()=>{if(!timeline||!active||!enabled)return;transformSessions.set(timeline,{version,pieces:targets,busy:busy||saving,level,edit:onEdit});announceTransform();return()=>{transformSessions.delete(timeline);previewTransform(timeline,targets,null);announceTransform();};},[timeline,version,index,targets.join(','),busy,saving,level,active,enabled,onEdit]);
 const mixed=(key:keyof ClipTransform,side?:'l'|'r'|'t'|'b')=>targets.some(i=>{const v=transformValue(version.pieceFx?.[i]?.transform);return side?v.crop[side]!==saved.crop[side]:JSON.stringify(v[key])!==JSON.stringify(saved[key]);});
 function change(next:ClipTransform){patch.current={...patch.current,...next,...(next.crop?{crop:{...patch.current.crop,...next.crop}}:{})};const v=transformValue({...value,...next,...(next.crop?{crop:{...value.crop,...next.crop}}:{})});setValue(v);if(timeline&&validTransform(v))previewTransform(timeline,targets,patch.current);}
 async function save(next:ClipTransform|null=patch.current,autoStraighten=false){if(busy||pending.current)return;pending.current=true;setSaving(true);setError('');setMessage('');try{const result=await onEdit(autoStraighten?{kind:'transform',pieces:targets,autoStraighten:true}:transformEdits(version,targets,next));if(result===undefined||result===false){setValue(saved);if(timeline)previewTransform(timeline,targets,null);return;}const note=(result as {transformNote?:string}).transformNote;if(note)setMessage(note);patch.current={};}catch(e){setError((e as Error).message);setValue(saved);if(timeline)previewTransform(timeline,targets,null);}finally{pending.current=false;setSaving(false);}}
 const locked=busy||saving;
 return <section aria-label="Transform" data-control="transform" className="space-y-2">
  <Row><SectionHeader as="h4">Transform</SectionHeader><div className="flex gap-1">{timeline?<Button disabled={locked} aria-pressed={enabled} onClick={()=>setViewer(!enabled)}>{enabled?'Done':'Edit in viewer'}</Button>:null}<Button disabled={locked} onClick={()=>void save(null)}>Reset</Button></div></Row>
  <p className="text-[11px] text-muted">{enabled?'Move the picture in the viewer. Scroll to zoom.':'Use the fields or edit in the viewer.'}</p>
  {message||version.feedback?.startsWith('Levelled')?<p role="status" className="text-[11px] text-muted">{message||version.feedback}</p>:null}
  {([['zoom','Zoom',.5,4,.01,'x'],['x','Position X',-2,2,.001,''],['y','Position Y',-2,2,.001,''],['rotate','Rotation',-45,45,.1,'°']] as const).map(([key,label,min,max,step,unit])=><Slider key={key} label={label} min={min} max={max} step={step} unit={unit} value={value[key]} defaultValue={key==='zoom'?1:0} mixed={mixed(key)} disabled={locked} onChange={v=>change({[key]:v})} onRelease={()=>void save()} />)}
  <Row className="gap-2"><Button disabled={locked} onClick={()=>void save({},true)}>Auto</Button><Button disabled={locked||!timeline} aria-pressed={level} onClick={()=>{setViewer(true);setLevel(v=>!v);}}>{level?'Done levelling':'Level tool'}</Button></Row>
  <Row as="label" className="text-[12px]">Hide rotated corners<Switch aria-label="Constrain rotation" checked={value.constrain} disabled={locked} onChange={()=>{const next={constrain:!value.constrain};change(next);void save(next);}} /></Row>
  {(['l','r','t','b'] as const).map((side,i)=><Slider key={side} label={`Crop ${['left','right','top','bottom'][i]}`} min={0} max={95} step={.1} unit="%" value={value.crop[side]*100} defaultValue={0} mixed={mixed('crop',side)} disabled={locked} onChange={v=>change({crop:{[side]:v/100}})} onRelease={()=>void save()} />)}
  <div className="space-y-2">{(['flipH','flipV'] as const).map((key,i)=><Row key={key} as="label" className="gap-2 text-[12px]"><span>Flip {i?'vertical':'horizontal'}{mixed(key)?' · Mixed':''}</span><Switch aria-label={`Flip ${i?'vertical':'horizontal'}`} checked={value[key]} disabled={locked} onChange={()=>{const next={[key]:!value[key]};change(next);void save(next);}} /></Row>)}</div>
  {error?<InlineError>{error}</InlineError>:null}
 </section>;
}
