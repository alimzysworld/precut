/** A one-take recording is shared by all its lines. Fetch and decode it once,
 * then release the PCM when the final line leaves the panel. */
const decoded = new Map<string, { users: number; audio: Promise<AudioBuffer> }>();
export function retainVoiceWave(source: string) {
  let entry = decoded.get(source);
  if (!entry) {
    const audio = (async () => {
      const response = await fetch(source);
      if (!response.ok) throw new Error("Take unavailable");
      const bytes = await response.arrayBuffer(), context = new AudioContext();
      try { return await context.decodeAudioData(bytes); }
      finally { await context.close(); }
    })();
    entry = { users: 0, audio }; decoded.set(source, entry);
  }
  entry.users++;
  return { audio: entry.audio, release() { if (entry && --entry.users === 0 && decoded.get(source) === entry) decoded.delete(source); } };
}
export function linePeaks(buffer: AudioBuffer, s: number, e: number): number[] {
  const data = buffer.getChannelData(0), start = Math.floor(s * buffer.sampleRate), end = Math.min(data.length, Math.ceil(e * buffer.sampleRate));
  return Array.from({ length: 48 }, (_, i) => {
    let peak = 0;
    for (let n = start + Math.floor((end - start) * i / 48); n < start + Math.floor((end - start) * (i + 1) / 48); n++) peak = Math.max(peak, Math.abs(data[n]));
    return peak;
  });
}
