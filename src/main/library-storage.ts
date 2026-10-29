import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withScenes } from "./scenes";
/** Called only after a pipeline writer exits; shares the JS index-writer lock. */
export async function persistLibrary(root: string): Promise<void> {
  const { withShootLock } = await import("./sidekick");
  await withShootLock(root, async () => {
    const directory = path.join(root, ".sidething"), file = path.join(directory, "index.json");
    if ((await fs.lstat(directory)).isSymbolicLink() || (await fs.lstat(file)).isSymbolicLink()) throw new Error("Library cache must stay inside this shoot.");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const next = withScenes(raw);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(next)); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  });
}
