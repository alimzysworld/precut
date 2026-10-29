// Live playback can use retained camera proxies when an original is offline.
// Export source references and the saved index stay untouched.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Clip } from '../shared/schema';
export function playbackSource(root: string, clip: Clip): { file: string; offset: number } {
  const present = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  const original = path.resolve(root, clip.file);
  if (clip.sound) {
    const sound = path.resolve(root, clip.sound.file);
    if (present(sound)) return { file: sound, offset: clip.sound.offsetS };
  }
  if (present(original) || !clip.proxy) return { file: original, offset: 0 };
  const cache = path.resolve(root, '.sidething/proxies'), proxy = path.resolve(cache, clip.proxy);
  if (!proxy.startsWith(cache + path.sep) || !present(proxy)) return { file: original, offset: 0 };
  return { file: proxy, offset: 0 };
}
