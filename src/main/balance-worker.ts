import { parentPort } from 'node:worker_threads';
import { balanceView, solveBalances, type BalanceFrame, type SolveFrame } from './balance-core';
// V67: 'solve' grades each measured source and matches scenes; 'view' draws the judge's contact sheet.
export type BalanceJob = { kind:'view'; frames:BalanceFrame[] } | { kind:'solve'; frames:SolveFrame[]; reference?:string; only?:string[] };
parentPort?.on('message',({id,job}:{id:number;job:BalanceJob})=>{
  try {
    const result=job.kind==='solve' ? solveBalances(job.frames,job.reference,job.only) : balanceView(job.frames);
    parentPort!.postMessage({id,result});
  }catch(error){parentPort!.postMessage({id,error:String(error)});}
});
