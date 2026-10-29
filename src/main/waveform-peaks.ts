/** Shared envelope reader for clip sound and music: 100 real maxima per second. */
export function floatWavPeaks(wav:Buffer,channels=2,rate=48000):number[] {
  const peaks:number[]=[];
  let at=12;
  while(at+8<=wav.length){const size=wav.readUInt32LE(at+4);if(wav.toString('ascii',at,at+4)==='data'){
    const end=Math.min(wav.length,at+8+size),step=Math.round(rate/100)*channels*4;
    for(let s=at+8;s<end;s+=step){let peak=0;for(let n=s;n+4<=Math.min(end,s+step);n+=4){const value=wav.readFloatLE(n);if(Number.isFinite(value))peak=Math.max(peak,Math.abs(value));}peaks.push(Number(Math.min(1,peak).toFixed(5)));}break;
  }at+=8+size+(size%2);}
  return peaks;
}
