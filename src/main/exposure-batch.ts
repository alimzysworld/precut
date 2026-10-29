import { spawn } from 'node:child_process';
import { currentActivity, threads } from './activity';
import { tool } from './tools';

/** Independent still samples share one ffmpeg process and filter pool. Every
 * input keeps its own accurate seek and the caller's identical colour filter. */
export function exposureBatch(samples: string[][]): Promise<Buffer[]> {
  if (!samples.length) return Promise.resolve([]);
  const bytesPerFrame = 64 * 64 * 6;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-filter_complex_threads', String(threads(12))];
  const filters: string[] = [];
  for (const [i, sample] of samples.entries()) {
    const vf = sample.indexOf('-vf');
    if (vf < 0 || !sample.includes('-i')) return Promise.reject(new Error('Invalid colour sample.'));
    const input = sample.slice(0, vf);
    // Keep the same conservative hardware session ceiling as the compositor.
    const safe = i < 4 ? input : input.filter((arg, n) => arg !== '-hwaccel' && input[n - 1] !== '-hwaccel');
    args.push('-threads', String(threads(4)), ...safe);
    filters.push(`[${i}:v:0]${sample[vf + 1]}[sample${i}]`);
  }
  args.push('-filter_complex', filters.join(';'));
  for (let i = 0; i < samples.length; i++) args.push('-map', `[sample${i}]`, '-frames:v', '1', '-threads:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', `pipe:${i + 3}`);
  return new Promise((resolve, reject) => {
    const signal = currentActivity()?.signal;
    signal?.throwIfAborted();
    const child = spawn(tool('ffmpeg'), args, { stdio: ['ignore', 'ignore', 'pipe', ...samples.map(() => 'pipe' as const)] });
    const chunks = samples.map(() => [] as Buffer[]), sizes = samples.map(() => 0);
    let stderr = '';
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    for (let i = 0; i < samples.length; i++) child.stdio[i + 3]?.on('data', (b: Buffer) => {
      sizes[i] += b.length;
      if (sizes[i] > bytesPerFrame) abort(); else chunks[i].push(b);
    });
    child.stderr?.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-4000); });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (code !== 0 || sizes.some(n => n !== bytesPerFrame)) reject(new Error(`Could not measure colour samples: ${stderr || 'incomplete frame'}`));
      else resolve(chunks.map(parts => Buffer.concat(parts)));
    });
  });
}
