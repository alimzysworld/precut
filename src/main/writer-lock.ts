// One process owns a shoot's writes. The app retains ownership until it quits;
// standalone tools borrow it for their operation. shlock is macOS's atomic
// link-based PID gate: it also recovers a gate left by a crashed claimant.
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
export const WRITER_BUSY = 'precut is open on this shoot. Make this change from inside precut, or quit it first.';
/** FIX2: what the app itself says when another precut already owns the shoot. */
export const OPEN_ELSEWHERE = 'This shoot is open in another precut, so changes here can\'t be saved. Quit the other precut to edit here.';
export class WriterBusyError extends Error { constructor() { super(appWriter ? OPEN_ELSEWHERE : WRITER_BUSY); } }
type Owner = { pid: number; start: string; token: string; root?: string };
type Lease = { owner: Owner; users: number; retained: boolean };
const held = new Map<string, Lease>();
const queues = new Map<string, Promise<unknown>>();
let appWriter = false;
export function enableAppWriter(): void { appWriter = true; }
// FIX2: every save already started, from the moment it is queued until it lands or fails. Quit waits on these.
// Tracked where edits queue (sidekick's cut queue, look saves, history moves, takes), not the shoot lease itself:
// reading footage and making previews hold that lease for minutes, and are rebuilt or resumed on the next launch.
const inFlight = new Set<Promise<void>>();
const origins = new WeakMap<Promise<void>, string>();
export function trackSave<T>(work: Promise<T>): Promise<T> {
  const settled = work.then(() => {}, () => {});
  inFlight.add(settled); void settled.then(() => inFlight.delete(settled));
  if (process.env.PRECUT_FIX2_DEBUG === '1') origins.set(settled, new Error('queued').stack ?? '');
  return work;
}
export const pendingOrigins = (): string[] => [...inFlight].map(p => origins.get(p) ?? '?');
export const savesPending = (): number => inFlight.size;
/** Resolves once nothing tracked is running, including saves queued while it waited. Failures count as settled. */
export async function savesSettled(): Promise<void> { while (inFlight.size) await Promise.all([...inFlight]); }
/** Only the app's already retained, canonical shoot can use its in-memory history. */
export function ownsOpenShoot(root: string): boolean {
  const resolved = path.resolve(root);
  if (!appWriter || !held.get(resolved)?.retained) return false;
  try { return realpathSync(resolved) === resolved; } catch { return false; }
}
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work), settled = next.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return next;
}
async function startTime(pid: number): Promise<string> {
  return (await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } })).stdout.trim();
}
async function live(owner: Owner): Promise<boolean> {
  if (!Number.isInteger(owner.pid) || owner.pid < 1 || !owner.start) return true; // malformed: fail closed
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  try { return await startTime(owner.pid) === owner.start; }
  catch { return true; } // an unreadable live process is never taken over
}
async function gated<T>(root: string, work: (file: string) => Promise<T>): Promise<T> {
  const dir = path.join(root, '.sidething'), gate = path.join(dir, 'writer.gate');
  await fs.mkdir(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { await exec('/usr/bin/shlock', ['-p', String(process.pid), '-f', gate]); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      if (attempt >= 200) throw new WriterBusyError();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try { return await work(path.join(dir, 'writer.lock')); }
  finally { await fs.unlink(gate); }
}
async function acquire(root: string, retain: boolean): Promise<void> {
  return serial(root, async () => {
    const mine = held.get(root);
    if (mine) { mine.users++; mine.retained ||= retain; return; }
    await gated(root, async file => {
      const old = await fs.readFile(file, 'utf8').then(raw => JSON.parse(raw) as Owner, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (old && (!old.root || old.root === root) && await live(old)) throw new WriterBusyError();
      const owner = { pid: process.pid, start: await startTime(process.pid), token: randomUUID(), root };
      // The gate serializes both takeover and release, including competing stale claimants.
      const temporary = `${file}.${owner.token}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(owner), { flag: 'wx' }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      held.set(root, { owner, users: 1, retained: retain });
    });
  });
}
async function release(root: string): Promise<void> {
  return serial(root, async () => {
    const mine = held.get(root);
    if (!mine || --mine.users > 0 || mine.retained) return;
    await gated(root, async file => {
      const old = JSON.parse(await fs.readFile(file, 'utf8')) as Owner;
      if (old.token === mine.owner.token) await fs.unlink(file);
      held.delete(root);
    });
  });
}
export async function withShootWriter<T>(root: string, work: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(root), mine = appWriter ? held.get(resolved) : undefined;
  if (mine?.retained && realpathSync(resolved) === resolved) {
    // This process already owns the OS lease until quit. Borrow it without
    // yielding to background work between input and a tiny cursor save.
    mine.users++;
    try { return await work(); } finally { mine.users--; }
  }
  root = await fs.realpath(root);
  await acquire(root, appWriter);
  try { return await work(); } finally { await release(root); }
}
/** Called on app open, before jobs that can write. Headless library reads stay read-only. */
export async function retainOpenShoot(root: string): Promise<void> {
  if (!appWriter) return;
  root = await fs.realpath(root);
  if (held.get(root)?.retained) return;
  try { await acquire(root, true); await release(root); elsewhere.delete(root); }
  catch (error) {
    if (!(error instanceof WriterBusyError)) throw error;
    // FIX2: another precut owns this shoot. Remembered, so the page says read only up front.
    if (!elsewhere.has(root)) console.warn(`[writer] ${root} is open in another precut; this one is read only.`);
    elsewhere.set(root, Date.now());
  }
}
const elsewhere = new Map<string, number>();
/** FIX2: true while another precut owns this shoot. Checked again every few seconds, so this app takes
 * over as soon as the other one quits. False for shoots this app owns, and for headless tools. */
export async function shootOpenElsewhere(root: string): Promise<boolean> {
  if (!appWriter) return false;
  try { root = await fs.realpath(root); } catch { return false; }
  if (held.get(root)?.retained) return false;
  const checked = elsewhere.get(root);
  if (checked === undefined || Date.now() - checked > 3000) await retainOpenShoot(root).catch(() => {});
  return elsewhere.has(root);
}
// Ownership is retained until process exit. The next claimant verifies PID and
// process start before replacing the record, for normal quits as well as crashes.
/** Readers never trigger migrations or background repairs in another writer's shoot. */
export async function shootHasOtherWriter(root: string): Promise<boolean> {
  root = await fs.realpath(root);
  if (held.has(root)) return false;
  const owner = await fs.readFile(path.join(root, '.sidething/writer.lock'), 'utf8').then(raw => JSON.parse(raw) as Owner, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  return !!owner && (!owner.root || owner.root === root) && await live(owner);
}
