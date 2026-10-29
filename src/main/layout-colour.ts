import {cameraConversionFilter,clampGrade,gradeFilter,neutralBaseFilter,pieceColour,type LookGrade,type PieceExposureOptions} from './grade';
import {gradeWork,type GradeTable} from './grade-work';
import type {Clip} from '../shared/schema';
const identities=new WeakMap<object,boolean>();
/** Check the actual generated cube, so even small real look changes are retained. */
export function identityLayoutCube(table:Pick<GradeTable,'size'|'data'>):boolean{
  const old=identities.get(table.data);if(old!==undefined)return old;
  const size=table.size;let identity=Number.isInteger(size)&&size>1&&table.data.length===size**3*3;
  for(let b=0;identity&&b<size;b++)for(let g=0;identity&&g<size;g++)for(let r=0;identity&&r<size;r++){
    const at=((b*size+g)*size+r)*3;identity=[r,g,b].every((v,c)=>Number.isFinite(table.data[at+c])&&Math.abs(table.data[at+c]-v/(size-1))<1e-9);
  }
  identities.set(table.data,identity);return identity;
}
/** Same colour stages as the normal finish; omit only an exactly neutral finish cube. */
export async function layoutGradeFilters(clip:Clip,grade:LookGrade,cache:string,options:PieceExposureOptions){
  const {base,exposure}=await pieceColour(clip,cache,options,grade.matchClips===true,grade.matchRef);
  const conversion=await cameraConversionFilter(clip,cache),filters:string[]=[];
  if(base)filters.push(await neutralBaseFilter(base,cache));
  const clean=clampGrade({...grade,input:'rec709'}),table=await gradeWork({kind:'finish',grade:clean,exposure});
  if(!identityLayoutCube(table))filters.push(await gradeFilter(clean,{cacheDir:cache,pieceExposure:exposure}));
  return {conversion,colour:filters.join(',')||'format=gbrp16le'};
}
