import type { BalanceFrame, RGB } from './balance-core';
const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
export function balanceSheetBitmap(frames:Pick<BalanceFrame,'id'|'aspect'>[],rendered:RGB[][]) {
  const cols=4,w=cols*240,h=Math.ceil(frames.length/cols)*198,bitmap=Buffer.alloc(w*h*4,40);
  for(let n=0;n<w*h;n++)bitmap[n*4+3]=255;
  frames.forEach((f,i)=>{
    const pixels=rendered[i],x=i%cols*240,y=Math.floor(i/cols)*198,aspect=f.aspect ?? 16/9;
    const width=Math.round(Math.min(236,174*aspect)),height=Math.round(width/aspect),ox=x+Math.round((240-width)/2),oy=y+Math.round((174-height)/2);
    for(let py=0;py<height;py++)for(let px=0;px<width;px++) {
      const p=pixels[Math.min(107,Math.floor(py/height*108))*192+Math.min(191,Math.floor(px/width*192))],at=((oy+py)*w+ox+px)*4;
      bitmap[at]=Math.round(p[2]*255);bitmap[at+1]=Math.round(p[1]*255);bitmap[at+2]=Math.round(p[0]*255);
    }
    String(i+1).split('').forEach((d,c)=>{digits[Number(d)].split('').forEach((on,j)=>{if(on==='1')for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const at=((y+180+Math.floor(j/3)*2+dy)*w+x+4+c*8+j%3*2+dx)*4;bitmap[at]=bitmap[at+1]=bitmap[at+2]=230;}});});
  });
  return {bitmap,width:w,height:h};
}
