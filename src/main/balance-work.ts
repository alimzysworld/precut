import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { bundledFile } from './bundle-paths';
import type { BalanceJob } from './balance-worker';
import type { balanceView, SolvedClip } from './balance-core';
type View=ReturnType<typeof balanceView>;
let worker:Worker|undefined,serial=0;
const pending=new Map<number,{resolve:(result:unknown)=>void;reject:(error:Error)=>void}>();
export function balanceWork(job:BalanceJob & {kind:'solve'}):Promise<Record<string,SolvedClip>>;
export function balanceWork(job:BalanceJob & {kind:'view'}):Promise<View>;
export function balanceWork(job:BalanceJob):Promise<unknown> {
  if(!worker){
    const local=bundledFile('balance-worker.js');
    const active=new Worker(process.env.PRECUT_BALANCE_WORKER || (existsSync(local)?local:path.resolve('out/main/balance-worker.js')));worker=active;
    active.on('message',({id,result,error})=>{const p=pending.get(id);if(!p)return;pending.delete(id);if(!pending.size)active.unref();error?p.reject(new Error(error)):p.resolve(result);});
    const fail=(error:Error)=>{if(worker!==active)return;worker=undefined;for(const p of pending.values())p.reject(error);pending.clear();};
    active.on('error',fail);active.on('exit',code=>{if(pending.size)fail(new Error(`Auto correct worker stopped (${code}).`));if(worker===active)worker=undefined;});active.unref();
  }
  const active=worker;
  return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});active.ref();active.postMessage({id,job});});
}
