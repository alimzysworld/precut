// FIX3: writers make folders inside a shoot's .sidething, never the shoot folder itself. When the shoot is
// renamed or moved (or a Drive re-sync swaps it) while precut is open, a write fails with ENOENT, the shoot
// shows offline with Relink, and its old path is never recreated as an empty ghost.
import * as fs from "node:fs";
import * as path from "node:path";

/** The shoot folder a path inside `<shoot>/.sidething` belongs to, or null for any other path (app caches). */
function shootOf(dir: string): string | null {
  const parts = path.resolve(dir).split(path.sep);
  const at = parts.lastIndexOf(".sidething");
  return at > 0 ? parts.slice(0, at).join(path.sep) || path.sep : null;
}
const gone = (root: string) => Object.assign(new Error(`The shoot folder is not there: ${root}`), { code: "ENOENT" });

/** `mkdir -p` that stops at a missing shoot folder. */
export async function mkdirInShoot(dir: string): Promise<void> {
  const root = shootOf(dir);
  if (root && !(await fs.promises.stat(root).then(stat => stat.isDirectory(), () => false))) throw gone(root);
  await fs.promises.mkdir(dir, { recursive: true });
}
export function mkdirInShootSync(dir: string): void {
  const root = shootOf(dir);
  if (root && !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw gone(root);
  fs.mkdirSync(dir, { recursive: true });
}
