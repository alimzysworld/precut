// This entry has no Electron, model or app dependencies. Export composition
// reads only the generated, immutable stage cubes supplied by main.
import * as fs from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { applyNeutralBase, clampGrade, convertCameraRGB, expose, gradeTransform, lookTransform, type CameraGrade, type NeutralBase, type PieceCorrection } from '../shared/grade-math';
type RGB = [number, number, number];
export type GradeJob = { kind: 'finish' | 'piece' | 'base' | 'preset' | 'conversion' | 'compose'; files?: string[]; grade: CameraGrade; base?: NeutralBase | null; exposure?: PieceCorrection };

function values(sample: (rgb: RGB) => RGB): number[] {
  const data: number[] = [];
  for (let b=0;b<33;b++) for(let g=0;g<33;g++) for(let r=0;r<33;r++)
    for(const v of sample([r/32,g/32,b/32])) data.push(Number(Math.min(1,Math.max(0,v)).toFixed(9)));
  return data;
}
function sample(data:number[], rgb:RGB):RGB {
  const p=rgb.map(v=>Math.max(0,Math.min(1,v))*32),lo=p.map(v=>Math.min(31,Math.floor(v))),f=p.map((v,i)=>v-lo[i]);
  const order=[0,1,2].sort((a,b)=>f[b]-f[a]);const at=(v:number[])=>((v[2]*33+v[1])*33+v[0])*3;
  const a=at(lo),v=[...lo];v[order[0]]++;const b=at(v);v[order[1]]++;const c=at(v);v[order[2]]++;const d=at(v);
  const [x,y,z]=order.map(i=>f[i]);return [0,1,2].map(i=>data[a+i]+x*(data[b+i]-data[a+i])+y*(data[c+i]-data[b+i])+z*(data[d+i]-data[c+i])) as RGB;
}
const tables=new Map<string,number[]>();
parentPort!.on('message',async ({id,job}:{id:number;job:GradeJob})=>{
  try {
    const g=clampGrade({...job.grade,input:'rec709'});
    let data:number[];
    if(job.kind==='compose') {
      const stages=await Promise.all((job.files ?? []).map(async file=>(await fs.readFile(file,'utf8')).split('\n').filter(line=>/^\d/.test(line)).flatMap(line=>line.split(/\s+/).map(Number))));
      data=values(rgb=>stages.reduce<RGB>((value,table)=>sample(table,value),rgb));
    } else if(job.kind==='conversion') data=values(rgb=>convertCameraRGB(rgb,job.grade.input));
    else if(job.kind==='preset') data=values(lookTransform(g));
    else if(job.kind==='base') data=values(rgb=>job.base?applyNeutralBase(rgb,job.base):rgb);
    else if(job.kind==='finish') {
      const transform=gradeTransform(g,job.exposure);data=values(rgb=>transform(convertCameraRGB(rgb,job.grade.input)));
    } else {
      const key=JSON.stringify([g,job.exposure]);let finish=tables.get(key);
      if(!finish){finish=values(gradeTransform(g,job.exposure));tables.set(key,finish);if(tables.size>32)tables.delete(tables.keys().next().value!);}
      const basis=values(rgb=>job.base?applyNeutralBase(rgb,job.base):rgb);
      data=[];for(let i=0;i<basis.length;i+=3) for(const v of sample(finish,[basis[i],basis[i+1],basis[i+2]]))data.push(Math.round(Math.max(0,Math.min(1,v))*1e9)/1e9);
    }
    // Transfer ownership. The main thread never walks or serialises the table.
    const typed=new Float64Array(data);
    let cube: string | undefined;
    if (job.kind==='finish' || job.kind==='base' || job.kind==='conversion' || job.kind==='compose') {
      const rows:string[]=[];for(let i=0;i<data.length;i+=3)rows.push(`${data[i].toFixed(9)} ${data[i+1].toFixed(9)} ${data[i+2].toFixed(9)}`);
      cube=`LUT_3D_SIZE 33\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${rows.join('\n')}\n`;
    }
    parentPort!.postMessage({id,size:33,cube,data:typed},[typed.buffer]);
  } catch(error) {parentPort!.postMessage({id,error:error instanceof Error?error.message:String(error)});}
});
