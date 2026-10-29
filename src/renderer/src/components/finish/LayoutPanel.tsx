import { clipName } from "../../../../shared/clip-name";
import {useEffect,useRef,useState} from 'react';
import {usePageActive} from '../../hooks/usePageActivity';
import type {CutEdit,CutVersion,DraftTimeline,LayoutChoice,Shoot} from '../../../../shared/schema';
import {LAYOUTS,layoutAt,migrateLayouts,sceneBoxes,sourceStart,type LayoutId,type LayoutBackground} from '../../../../shared/layout-presets';
import {matchScreen} from '../../../../shared/screen-match';
import {clipDimensions} from '../../../../shared/media';
import {Button,InlineError,NumberField,SectionHeader,Tile,Switch,Modal,Row} from '../ui';
import {Slider} from './Controls';
import {getApi} from '../../data';
import {previewLayout,layoutSessions} from '../layoutPreview';
import {timelineTime} from '../timeline/model';
const gradients=[['#182d40','#486c75'],['#f2b5a7','#a56fb6'],['#1f363d','#609c88'],['#e1c78a','#c38764']];
const swatches=['#191a20','#f0e8d7','#254f62','#395d49','#7d4e62','#ac6844'];
const field='w-full rounded-lg bg-ink/[0.06] px-2 py-1.5 text-[12px]';
/** FIX6: a time as typed ("0:30", "1:02.5", "53.8", "30s"), in seconds; NaN when it isn't one. */
export function parseLayoutTime(text:string):number{
  const parts=text.trim().replace(/\s*s$/i,'').split(':');
  if(parts.length>3||!parts.every((p,i)=>i===parts.length-1?/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(p):/^\d+$/.test(p)))return NaN;
  return parts.reduce((total,p)=>total*60+Number(p),0);
}
export function LayoutDrawing({layout,aspect,phoneAspect,referenceWidth=1920}:{layout:LayoutChoice;aspect:number;phoneAspect?:number;referenceWidth?:number}){
  const w=120,h=w/aspect,boxes=sceneBoxes(layout,w,h,phoneAspect);
  return <svg viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="w-full rounded-md bg-ink/[0.07]" style={{aspectRatio:aspect}}>
    {(layout.id==='phone-over-camera'||layout.id==='clip-over-camera'?['b','a'] as const:['a','b'] as const).map(key=>{const box=boxes[key];if(!box)return null;return <rect key={key} x={box.x*w} y={box.y*h} width={box.w*w} height={box.h*h} rx={box.circle?Math.min(box.w*w,box.h*h)/2:(layout.radius??16)*w/referenceWidth} fill={key==='a'?'var(--accent)':'var(--muted)'} opacity={key==='a'?.8:.5}/>;})}
  </svg>;
}
export function LayoutPanel({shoot,version,index,busy,onEdit,time=0,timeline,aspect=16/9,onSeek}:{shoot:Shoot;version:CutVersion;index?:number|null;busy?:boolean;onEdit?:(edit:CutEdit)=>unknown;time?:number;timeline?:DraftTimeline|null;aspect?:number;onSeek?:(time:number)=>void}){
  const active=usePageActive();
  const ranges=migrateLayouts(version,aspect),saved=layoutAt(ranges,index==null?time:version.pieces?.[index]?.timelineS??time);
  const currentPiece=index==null?version.pieces?.find(p=>time>=(p.timelineS??0)&&time<(p.timelineS??0)+p.lengthS):version.pieces?.[index];
  const initial=():LayoutChoice=>saved??{kind:'scene',id:'camera-only',followCamera:true,s:index==null?0:currentPiece?.timelineS??0,e:index==null?version.lengthS:Math.min(version.lengthS,(currentPiece?.timelineS??0)+(currentPiece?.lengthS??version.lengthS)),radius:16,padding:.04,transition:'smooth',background:{kind:'gradient',stops:gradients[0],angle:135}};
  const [draft,setDraft]=useState<LayoutChoice>(initial),[category,setCategory]=useState('All'),[error,setError]=useState<string|null>(null),[text,setText]=useState(''),[replacing,setReplacing]=useState(false);
  const [Library,setLibrary]=useState<typeof import('../library/LibraryView').LibraryView|null>(null);
  useEffect(()=>{let mounted=true;if(replacing&&!Library)void import('../library/LibraryView').then(m=>{if(mounted)setLibrary(()=>m.LibraryView);}).catch(()=>{if(mounted){setReplacing(false);setError('Could not open screen recordings.');}});return()=>{mounted=false;};},[replacing,Library]);
  const pending=useRef(false),latest=useRef(draft);latest.current=draft;
  // FIX6: From and To read as the rest of the app does ("0:53.8") and take a typed time; a valid one previews as it is typed.
  const [typed,setTyped]=useState<{s?:string;e?:string}>({});
  const timeField=(key:'s'|'e',label:string,value:number)=>{const text=typed[key];
    return <NumberField numeric={false} inputMode="decimal" aria-label={label} title="A time such as 0:30 or 1:02.5" aria-invalid={text!==undefined&&!Number.isFinite(parseLayoutTime(text))||undefined}
      className={`${field} tabular-nums`} value={text??timelineTime(value)} onFocus={e=>e.currentTarget.select()} onBlur={()=>setTyped(t=>({...t,[key]:undefined}))}
      onChange={e=>{const next=e.target.value,seconds=parseLayoutTime(next);setTyped(t=>({...t,[key]:next}));if(Number.isFinite(seconds))preview({...latest.current,[key]:Math.max(0,Math.min(version.lengthS,seconds))});}}
      onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();setTyped(t=>({...t,[key]:undefined}));}}}/>;};
  useEffect(()=>{
    if(!timeline||!onEdit||!active)return;
    layoutSessions.set(timeline,{enabled:true,busy:!!busy,edit:onEdit});
    document.dispatchEvent(new Event('precut:layout-session'));
    return()=>{layoutSessions.delete(timeline);previewLayout(timeline,null);document.dispatchEvent(new Event('precut:layout-session'));};
  },[timeline,onEdit,busy,active]);
  useEffect(()=>{setDraft(initial());setTyped({});setError(null);return()=>previewLayout(timeline,null);},[version.version,index,saved?.s,saved?.e]);
  const phoneClip=shoot.clips.find(c=>c.id===draft.sources?.a?.clipId&&c.meta&&clipDimensions(c).width<clipDimensions(c).height)??shoot.clips.find(c=>c.proxy&&c.meta&&clipDimensions(c).width<clipDimensions(c).height);
  const phoneAspect=phoneClip?clipDimensions(phoneClip).width/clipDimensions(phoneClip).height:undefined;
  const bg=draft.background??{kind:'gradient',stops:gradients[0],angle:135};
  function preview(next:LayoutChoice){latest.current=next;setDraft(next);previewLayout(timeline,next);}
  async function commit(next=latest.current){
    if(!onEdit||busy||pending.current)return;
    pending.current=true;setError(null);
    try{const result=await onEdit({kind:'layoutRange',s:next.s??0,e:next.e??version.lengthS,layout:{...next,kind:'scene'}});if(result===false)throw new Error("Couldn't change the layout.");preview(next);}
    catch(e){setError(e instanceof Error?e.message:"Couldn't change the layout.");previewLayout(timeline,null);}
    finally{pending.current=false;}
  }
  function choose(id:LayoutId){
    const next={...draft,kind:'scene' as const,id,reason:undefined,boxes:undefined,swap:!['camera-only','screen-only','phone-only'].includes(id)&&!!draft.swap};
    // A source is a choice with a source clock, never an arbitrary zero.
    const clips=shoot.clips.filter(c=>c.meta&&c.proxy&&!c.leftOut&&!c.missing&&c.stage!=='error');
    const matches=matchScreen(shoot,currentPiece?.words??currentPiece?.description??'');
    const candidates=id.startsWith('clip')||id==='camera-over-clip'?clips:matches.map(m=>clips.find(c=>c.id===m.clipId)).filter(Boolean) as typeof clips;
    const source=candidates.find(c=>!id.startsWith('phone')||clipDimensions(c).height>clipDimensions(c).width)??candidates[0];
    const camera=clips.find(c=>c.id===currentPiece?.clipId)??clips.find(c=>!matches.some(m=>m.clipId===c.id));
    next.sources={...(id!=='camera-only'&&source?{a:next.sources?.a&&candidates.some(c=>c.id===next.sources!.a!.clipId&&(!id.startsWith('phone')||clipDimensions(c).height>clipDimensions(c).width))?next.sources.a:{clipId:source.id,s:sourceStart(shoot,version,source.id,next.s??0,matches.find(m=>m.clipId===source.id)?.s??0,timeline??undefined)}}:{}),...(!['screen-only','phone-only'].includes(id)&&camera?{b:next.sources?.b??{clipId:camera.id,s:sourceStart(shoot,version,camera.id,next.s??0,currentPiece?.s??0,timeline??undefined)}}:{})};
    preview(next);void commit(next);
  }
  function background(patch:Partial<LayoutBackground>,save=false){const next={...draft,background:{...bg,...patch}};preview(next);if(save)void commit(next);}
  async function image(){try{const[file]=await getApi().pickOverlayFiles();if(file)background({kind:'image',image:file},true);}catch(e){setError(e instanceof Error?e.message:"Couldn't choose an image.");}}
  const rangesOnly=ranges.filter(l=>l.kind==='scene');
  const topic=(timeline?.captionSource?.words??[]).filter(w=>w.s<(draft.e??version.lengthS)&&w.e>(draft.s??0)).map(w=>w.text).join(' ')||currentPiece?.words||'';
  async function auto(enabled:boolean,accept=false){if(!onEdit||pending.current)return;pending.current=true;setError(null);try{const result=await onEdit({kind:'autoLayouts',enabled,accept});if(result===false)throw Error('Could not change auto layouts.');}catch(e){setError(e instanceof Error?e.message:'Could not change auto layouts.');}finally{pending.current=false;}}
  return <section data-control="layout" aria-label="Layout" className="space-y-3 py-2">
    <fieldset disabled={busy||!onEdit} className="space-y-3">
      <Row as="label" className="text-small">Auto layouts<Switch label="Auto layouts" checked={!!version.autoLayouts?.enabled} onChange={e=>void auto(e.target.checked)}/></Row>
      {version.autoLayouts?.error?<InlineError>{version.autoLayouts.error}</InlineError>:version.autoLayouts?.offer?.length?<div className="space-y-1"><p className="text-micro text-muted">{version.autoLayouts.offer.length} layouts ready. Your layouts are kept.</p><Button variant="primary" onClick={()=>void auto(true,true)}>Try these layouts</Button></div>:version.autoLayouts?.enabled&&rangesOnly.some(l=>l.auto)?<p role="status" className="text-micro text-muted">Picked {rangesOnly.filter(l=>l.auto).length} layouts from what you say and show</p>:null}
      {draft.reason?<p className="text-micro text-muted">{draft.reason}</p>:null}
      {draft.sources?.a?<Button onClick={()=>setReplacing(true)}>Replace</Button>:null}
      {rangesOnly.length?<div className="flex flex-wrap gap-1" aria-label="Layout ranges">{rangesOnly.map(l=><Button key={`${l.s}:${l.e}`} aria-label={`Layout from ${l.s} to ${l.e} seconds`} onClick={()=>{setDraft(l);onSeek?.(l.s!);}}>{timelineTime(l.s!)} to {timelineTime(l.e!)}</Button>)}</div>:null}
      <div className="grid grid-cols-2 gap-2"><label className="text-micro text-muted">From{timeField('s','Layout from',draft.s??0)}</label><label className="text-micro text-muted">To{timeField('e','Layout to',draft.e??version.lengthS)}</label></div>
      <div role="group" aria-label="Layout categories" className="flex flex-wrap gap-1">{['All','Screen','Phone','Camera','Clip on clip'].map(c=><Tile key={c} type="button" aria-pressed={c===category} onClick={()=>setCategory(c)} className={`rounded-full px-2.5 py-1 text-[11px] ${c===category?'bg-[var(--selection-fill)] text-accent':'bg-ink/[0.05] text-muted'}`}>{c}</Tile>)}</div>
      <div role="group" aria-label="Scene layout" className="grid grid-cols-2 gap-1.5">{LAYOUTS.filter(l=>category==='All'||l[2]===category).map(([id,label])=><Tile key={id} type="button" aria-label={label} aria-pressed={draft.id===id} onClick={()=>choose(id)} className={`space-y-1 rounded-lg p-1.5 text-left text-[11px] ${draft.id===id?'bg-[var(--selection-fill)] text-accent':'bg-ink/[0.03] text-muted'}`}><LayoutDrawing layout={{...draft,id,boxes:undefined}} aspect={aspect} phoneAspect={phoneAspect} referenceWidth={timeline?.width??1920}/><span>{label}</span></Tile>)}</div>
      <p className="text-micro text-muted">{draft.boxes?'Custom. Drag a corner to resize.':'Drag either picture or its corner dots.'}</p>
      <div className="flex flex-wrap gap-2">{draft.sources?.a&&draft.sources?.b?<Button onClick={()=>void commit({...draft,swap:!draft.swap})}>Swap</Button>:null}<Button onClick={()=>void commit({...draft,boxes:undefined})}>Reset layout</Button><Button onClick={()=>void commit()}>Apply range</Button>{index!=null?<Button aria-label="Use layout for all clips" onClick={()=>void commit({...latest.current,s:0,e:version.lengthS})}>Use for all clips</Button>:null}{saved?.kind==='scene'?<Button onClick={()=>void onEdit?.({kind:'layoutRange',s:draft.s!,e:draft.e!,layout:null})}>Remove layout</Button>:null}</div>
      {(['a','b'] as const).filter(key=>key==='a'?draft.id!=='camera-only':!['screen-only','phone-only'].includes(draft.id!)).map(key=><label key={key} className="block space-y-1 text-micro text-muted">{key==='a'?'Screen or clip':'Camera'}<select aria-label={key==='a'?'Screen recording':'Camera recording'} className={field} value={draft.sources?.[key]?.clipId??''} onChange={e=>{const clipId=e.target.value;void commit({...draft,reason:undefined,followCamera:key==='b'?false:draft.followCamera,screenLoop:key==='a'?undefined:draft.screenLoop,sources:{...draft.sources,[key]:{clipId,s:sourceStart(shoot,version,clipId,draft.s??0,0,timeline??undefined)}}});}}><option value="">Choose a source</option>{shoot.clips.filter(c=>c.proxy&&c.meta&&!c.missing&&!c.leftOut).map(c=><option key={c.id} value={c.id}>{clipName(c)}</option>)}</select>{draft.sources?.[key]?<NumberField aria-label={key==='a'?'Screen start':'Camera start'} min={0} step={.04} className={field} value={draft.sources[key]!.s} onChange={e=>preview({...draft,followCamera:key==='b'?false:draft.followCamera,sources:{...draft.sources,[key]:{...draft.sources![key]!,s:Number(e.target.value)}}})} onBlur={()=>void commit()}/>:null}</label>)}
      <Slider label="Corner radius" value={draft.radius??16} min={0} max={48} unit=" px" defaultValue={16} onChange={radius=>preview({...draft,radius})} onRelease={radius=>void commit({...latest.current,radius})}/>
      <Slider label="Padding" value={(draft.padding??.04)*100} min={0} max={12} step={.1} unit="%" defaultValue={4} onChange={n=>preview({...draft,padding:n/100})} onRelease={n=>void commit({...latest.current,padding:n/100})}/>
      <SectionHeader as="h4" className="text-micro font-medium">Background</SectionHeader>
      <div role="group" aria-label="Background source" className="grid grid-cols-4 gap-1">{(['screen','gradient','image','colour'] as const).map(kind=><Tile key={kind} type="button" aria-pressed={bg.kind===kind} onClick={()=>kind==='image'&&!bg.image?void image():background({kind,...(kind==='gradient'?{stops:bg.stops??gradients[0]}:{}),...(kind==='colour'?{colour:bg.colour??swatches[0]}:{})},true)} className={`rounded-lg py-1.5 text-[11px] ${bg.kind===kind?'bg-[var(--selection-fill)] text-accent':'bg-ink/[0.05] text-muted'}`}>{kind[0].toUpperCase()+kind.slice(1)}</Tile>)}</div>
      {bg.kind==='gradient'?<><div className="flex gap-1.5" aria-label="Gradient presets">{gradients.map((stops,i)=><button key={i} type="button" aria-label={`Gradient ${i+1}`} onClick={()=>background({stops,fromClip:false},true)} className="h-7 flex-1 rounded-lg" style={{background:`linear-gradient(135deg,${stops.join(',')})`}}/>)}</div><Button onClick={()=>{if(!timeline)return;const abort=new AbortController();void import('../LivePlayer').then(m=>m.grabLookFrame(timeline,time,abort.signal)).then(frame=>{const ctx=frame.image.getContext('2d')!,{width,height}=frame.image;const data=ctx.getImageData(0,0,width,height).data;const stops=[0,1,2].map(part=>{const sum=[0,0,0];let n=0;for(let y=0;y<height;y+=4)for(let x=Math.floor(width*part/3);x<width*(part+1)/3;x+=4){const at=(y*width+x)*4;sum.forEach((_,c)=>sum[c]+=data[at+c]);n++;}return '#'+sum.map(v=>Math.round(v/n).toString(16).padStart(2,'0')).join('');});background({stops,fromClip:true},true);}).catch(e=>setError(String(e)));}}>From this clip</Button><p className="text-micro text-muted">Custom</p><div className="flex gap-2">{(bg.stops??gradients[0]).map((colour,i)=><input key={i} type="color" aria-label={`Gradient stop ${i+1}`} value={colour} className="h-8 min-w-0 flex-1 cursor-pointer rounded-lg border-0 bg-transparent p-0" onChange={e=>background({stops:(bg.stops??gradients[0]).map((v,j)=>j===i?e.target.value:v),fromClip:false})} onBlur={()=>void commit()}/>)}</div><Button onClick={()=>background({stops:(bg.stops??gradients[0]).length===2?[...bg.stops??gradients[0],'#87afb0']:(bg.stops??gradients[0]).slice(0,2),fromClip:false},true)}>{(bg.stops??gradients[0]).length===2?'Add third colour':'Use two colours'}</Button><Slider label="Gradient angle" value={bg.angle??135} min={0} max={360} unit="°" onChange={angle=>background({angle})} onRelease={angle=>void commit({...latest.current,background:{...latest.current.background!,angle}})}/></>:null}
      {bg.kind==='colour'?<><div className="flex gap-1.5">{swatches.map(colour=><button key={colour} type="button" aria-label={`Colour ${colour}`} className="h-7 flex-1 rounded-lg" style={{background:colour}} onClick={()=>background({colour},true)}/>)}</div><div className="flex gap-2"><input type="color" aria-label="Custom background colour" className="h-8 w-10 border-0 bg-transparent p-0" value={bg.colour??swatches[0]} onChange={e=>background({colour:e.target.value})} onBlur={()=>void commit()}/><input aria-label="Background hex" className={field} maxLength={7} value={bg.colour??swatches[0]} onChange={e=>background({colour:e.target.value})} onBlur={()=>void commit()}/></div></>:null}
      {bg.kind==='image'?<><div className="flex flex-wrap gap-1">{shoot.clips.filter(c=>c.photo).map((c,i)=><Button key={c.id} onClick={()=>background({image:c.id},true)}>Image {i+1}</Button>)}</div><Button onClick={()=>void image()}>Choose image</Button></>:null}
      {bg.kind==='screen'||bg.kind==='image'?<Slider label="Background blur" value={bg.blur??0} min={0} max={100} unit="%" onChange={blur=>background({blur})} onRelease={blur=>void commit({...latest.current,background:{...latest.current.background!,blur}})}/>:null}
      <Slider label="Dim" value={bg.dim??0} min={0} max={100} unit="%" onChange={dim=>background({dim})} onRelease={dim=>void commit({...latest.current,background:{...latest.current.background!,dim}})}/>
      <label className="block space-y-1 text-micro text-muted">Into this one<select aria-label="Into this one" className={field} value={draft.transition??'smooth'} onChange={e=>void commit({...draft,transition:e.target.value as 'smooth'|'cut'})}><option value="smooth">Smooth</option><option value="cut">Hard cut</option></select></label>
      {index!=null?<details><summary className="cursor-pointer text-micro text-muted">Title or shot needed</summary><textarea aria-label="Shot description" value={text} className={field} maxLength={500} onChange={e=>setText(e.target.value)}/><Button onClick={()=>{if(text.trim())void onEdit?.({kind:'layout',piece:index,layout:{kind:'title',title:text.trim()}});}}>Title</Button><Button onClick={()=>{if(text.trim())void onEdit?.({kind:'layout',piece:index,layout:{kind:'placeholder',note:text.trim()}});}}>Shot needed</Button></details>:null}
    </fieldset>
    <Modal open={replacing} onClose={()=>setReplacing(false)} title="Replace screen" className="!max-w-4xl !bg-surface !backdrop-filter-none !shadow-none">{replacing&&Library?<Library root={shoot.root} media={{shoot,cuts:[],version,replaceLayout:draft,layoutTopic:topic,busy:!!busy,onEdit:async edit=>{const result=await onEdit?.(edit);return result===undefined?true:result;},onClose:()=>setReplacing(false),onShootChange:()=>{}}}/>:null}</Modal>
    {error?<InlineError>{error}</InlineError>:null}
  </section>;
}
