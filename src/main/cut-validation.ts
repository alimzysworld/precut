import { Worker } from 'node:worker_threads';

// Validation keeps the caller's cut queue and writer lease. Only the expensive
// read/parse/comparison runs here; this worker never writes a file.
let tail: Promise<unknown> = Promise.resolve();
type Version = { version: number; baseVersion?: number };
export function validateSavedContent<T extends Version>(file: string, versions: T[], indexRoot: string | undefined,
  project: (version: T) => unknown, indexIds?: string[]): Promise<{ added: number[]; existing: boolean }> {
  const next = tail.then(() => validate(file, versions, indexRoot, project, indexIds));
  tail = next.catch(() => {});
  return next;
}
async function validate<T extends Version>(file: string, versions: T[], indexRoot: string | undefined,
  project: (version: T) => unknown, indexIds?: string[]): Promise<{ added: number[]; existing: boolean }> {
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const fs=require('node:fs/promises'), {isDeepStrictEqual}=require('node:util');
    const project=${project.toString()};
    const plain=value=>JSON.parse(JSON.stringify(value));
    (async()=>{
      const before=await fs.readFile(workerData.file,'utf8').then(raw=>{
        const parsed=JSON.parse(raw);
        if(!parsed || !Array.isArray(parsed.versions))throw Error('The saved edit could not be checked.');
        return parsed;
      },error=>{if(error.code==='ENOENT')return null;throw error;});
      const existing=new Map((before?.versions ?? []).map(v=>[v.version,v])), kept=new Set(), added=[];
      const byId=new Set(workerData.indexIds ?? []), slim=before?.storage?.format==='slim-v1';
      const clip=ref=>{
        const found=byId.has(ref.id) ? ref : slim ? before.storage.clips[ref.snapshot] : ref;
        if(!found)throw Error('Could not find the footage for '+ref.id+'. Reconnect it and try again.');
        return found;
      };
      const seg=s=>s ? {...s,clip:clip(s.clip)} : s;
      const saved=v=>{
        if(!v.assembly)return project(v);
        const a=v.assembly;
        const shoot=workerData.indexRoot ? {root:workerData.indexRoot}
          : before.storage?.format==='slim-v1' ? before.storage.shoots[a.shoot.snapshot] : a.shoot;
        if(!shoot)throw Error("Could not load this edit's shoot index. Check the drive is connected and try again.");
        return project({...v,assembly:{...a,shoot,cutList:a.cutList.map((item,i)=>({...item,
          ...(workerData.indexRoot && item.piece===undefined ? {piece:i} : {}),seg:seg(item.seg)})),
          reel:{...a.reel,broll:a.reel.broll.map(item=>({...item,seg:seg(item.seg)}))}}});
      };
      parentPort.on('message',message=>{try{
        if(message.done){
          if([...existing.keys()].some(v=>!kept.has(v)))throw Error('Saved edit versions cannot be removed.');
          parentPort.postMessage({result:{added,existing:existing.size>0}});parentPort.close();return;
        }
        const v=message.version, was=existing.get(v.version);kept.add(v.version);
        if(was){if(!isDeepStrictEqual(plain(saved(was)),plain(v)))throw Error('Saved edit content needs a new version with a base.');}
        else {
          if(!Number.isInteger(v.baseVersion))throw Error('Every saved edit must name its base version.');
          if(!existing.size && v.baseVersion!==0)throw Error('A new edit must name base version 0.');
          added.push(v.version);
        }
      }catch(error){parentPort.postMessage({error:error.message});parentPort.close();}});
      parentPort.postMessage({ready:true});
    })().catch(error=>{parentPort.postMessage({error:error.message});parentPort.close();});
  `, { eval: true, workerData: { file, indexRoot, indexIds } });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const result = new Promise<{ added: number[]; existing: boolean }>((resolve, reject) => {
    worker.on('message', message => {
      if (message.ready) ready();
      else if (message.error) { ready(); reject(new Error(message.error)); }
      else if (message.result) resolve(message.result);
    });
    worker.once('error', error => { ready(); reject(error); });
    worker.once('exit', code => { ready(); if (code) reject(new Error('Could not check the saved edit. Try again.')); });
  });
  // Attach rejection handling before the worker can answer during preparation.
  void result.catch(() => {});
  try {
    await started;
    for (let i = 0; i < versions.length; i++) {
      worker.postMessage({ version: project(versions[i]) });
      if (i % 32 === 31) await new Promise<void>(resolve => setImmediate(resolve));
    }
    worker.postMessage({ done: true });
    return await result;
  } finally { await worker.terminate(); }
}
