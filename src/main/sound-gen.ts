import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app, type SafeStorage } from 'electron';
import * as electron from 'electron';
import type { Api } from '../shared/schema';
import { runActivity } from './activity';

const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const SOUND_GENERATION_LIMIT = 3;
const keyError = 'Could not save your ElevenLabs key securely. Unlock your Mac keychain and try again.';
const limitError = 'This edit has already requested three new sounds. Choose a sound from the library.';
type SecureStorage = Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> & { getSelectedStorageBackend?: () => string };
class SoundResponseError extends Error {}

/** Dependency injection keeps QA offline and exercises the actual disk/network path. */
export function createSoundGenerator(deps: { userData: () => string; secure: SecureStorage; request?: typeof fetch; timeoutMs?: number }) {
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.catch(() => {}).then(work); tail = next; return next;
  }
  const keyFile = () => path.join(deps.userData(), 'elevenlabs-key.enc');
  function secure() {
    if (!deps.secure.isEncryptionAvailable() || deps.secure.getSelectedStorageBackend?.() === 'basic_text') throw new Error(keyError);
  }
  async function readKey(): Promise<string | null> {
    try {
      const bytes = await fs.readFile(keyFile()); secure();
      return deps.secure.decryptString(bytes) || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Could not read your ElevenLabs key. Unlock your Mac keychain or connect again.');
    }
  }
  const soundKey: Api['soundKey'] = op => serial(async () => {
    if (op === 'clear') { await fs.rm(keyFile(), { force: true }); return { elevenlabs: false }; }
    if (op === 'status') return { elevenlabs: !!await readKey() };
    if (!op || typeof op !== 'object' || typeof op.set !== 'string' || !op.set.trim() || op.set.length > 4096 || /[\r\n\0]/.test(op.set)) throw new Error('Enter your ElevenLabs key.');
    const temp = `${keyFile()}.${randomUUID()}.tmp`;
    try {
      secure();
      const bytes = deps.secure.encryptString(op.set.trim());
      await fs.mkdir(deps.userData(), { recursive: true });
      await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, keyFile());
      return { elevenlabs: true };
    } catch { throw new Error(keyError); }
    finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  });
  async function safeDirectory(base: string, name: string): Promise<string> {
    const parent = await fs.realpath(base), directory = path.join(parent, name);
    await fs.mkdir(directory, { recursive: true });
    if (await fs.realpath(directory) !== directory) throw new Error('The sound cache must stay in its own folder.');
    return directory;
  }
  async function atomic(file: string, bytes: string | Buffer, signal?: AbortSignal) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); signal?.throwIfAborted(); await fs.rename(temp, file); }
    finally { await fs.rm(temp, { force: true }); }
  }
  async function cached(file: string): Promise<Buffer | null> {
    try { const stat = await fs.lstat(file); return stat.isFile() && stat.size > 0 && stat.size <= 20 * 1024 * 1024 ? await fs.readFile(file) : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async function generate(root: string, prompt: string, seconds: number, budget?: string): Promise<{ file: string; name: string }> {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) throw new Error('Describe a sound in up to 2,000 characters.');
    if (!Number.isFinite(seconds) || seconds < .5 || seconds > 30) throw new Error('Choose a sound length from 0.5 to 30 seconds.');
    const name = prompt.trim().replace(/\s+/g, ' ');
    return serial(async () => {
      // Require a key even on a cache hit: disconnect never enables paid work.
      const key = await readKey();
      if (!key) throw new Error('Connect your ElevenLabs key to make a sound.');
      if (name.includes(key)) throw new Error('Describe the sound without including your API key.');
      const side = await safeDirectory(root, '.sidething'), directory = await safeDirectory(side, 'sfx');
      const cache = await safeDirectory(deps.userData(), 'generated-sounds');
      const id = digest(JSON.stringify({ text: name, duration_seconds: seconds, prompt_influence: .3, model_id: 'eleven_text_to_sound_v2' }));
      const output = path.join(directory, `elevenlabs-${id}.mp3`), master = path.join(cache, `${id}.mp3`);
      return runActivity({ kind: 'render', root, target: null, label: 'Making a sound with ElevenLabs', cancelable: true }, async activity => {
        let bytes = await cached(master) ?? await cached(output);
        if (!bytes) {
          // Reserve before sending, including failed/aborted requests: they may have been billed.
          if (budget) {
            const ledger = path.join(cache, `budget-${digest(directory + ':' + budget)}`);
            let reserved = false;
            // Exclusive, durable slots also enforce the cap across app/MCP processes.
            for (let slot = 1; slot <= SOUND_GENERATION_LIMIT; slot++) {
              activity.signal.throwIfAborted();
              try { await fs.writeFile(`${ledger}-${slot}.request`, 'reserved', { flag: 'wx', mode: 0o600 }); reserved = true; break; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            }
            if (!reserved) throw new Error(limitError);
          }
          const controller = new AbortController(), abort = () => controller.abort();
          activity.signal.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(abort, deps.timeoutMs ?? 60_000);
          try {
            activity.signal.throwIfAborted();
            const response = await (deps.request ?? fetch)(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
              body: JSON.stringify({ text: name, duration_seconds: seconds, prompt_influence: .3, model_id: 'eleven_text_to_sound_v2' }) });
            if (!response.ok) {
              let status = '';
              try { status = (await response.json() as { detail?: { status?: string } }).detail?.status ?? ''; } catch { /* Never display upstream text. */ }
              if (response.status === 402 || /quota|credit/.test(status)) throw new SoundResponseError('Your ElevenLabs account is out of credits. Add credits there and try again.');
              if (response.status === 401 || response.status === 403) throw new SoundResponseError('ElevenLabs did not accept this key. Check its sound generation access or connect a new key.');
              if (response.status === 429) throw new SoundResponseError('ElevenLabs is busy. Wait a moment and try again.');
              throw new SoundResponseError('ElevenLabs could not make this sound. Try a different description.');
            }
            if (!response.headers.get('content-type')?.toLowerCase().startsWith('audio/')) throw new SoundResponseError('ElevenLabs did not return a sound. Try again.');
            const reader = response.body?.getReader();
            if (!reader) throw new SoundResponseError('ElevenLabs did not return a sound. Try again.');
            const chunks: Buffer[] = []; let total = 0;
            try {
              for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                total += value.length;
                if (total > 20 * 1024 * 1024) { await reader.cancel(); throw new SoundResponseError('The generated sound was too large. Try a shorter sound.'); }
                chunks.push(Buffer.from(value));
              }
            } finally { reader.releaseLock(); }
            if (!total) throw new SoundResponseError('ElevenLabs returned an empty sound. Try again.');
            bytes = Buffer.concat(chunks);
          } catch (error) {
            if (activity.signal.aborted) throw new Error('Sound generation canceled.');
            if (controller.signal.aborted) throw new Error('ElevenLabs took too long. Try again.');
            // Only our fixed messages can escape. Network errors can echo headers.
            if (error instanceof SoundResponseError) throw error;
            throw new Error('Could not reach ElevenLabs. Check your connection and try again.');
          } finally { clearTimeout(timer); activity.signal.removeEventListener('abort', abort); }
          await atomic(master, bytes, activity.signal);
        }
        activity.signal.throwIfAborted();
        await atomic(output, bytes, activity.signal);
        await atomic(`${output}.json`, JSON.stringify({ name, prompt: name, kind: 'other', lengthS: seconds, provider: 'elevenlabs' }), activity.signal);
        return { file: output, name };
      }, { renderLane: 'waited' });
    });
  }
  return { soundKey, generateSound: (root: string, prompt: string, seconds: number) => generate(root, prompt, seconds), generateForEdit: generate };
}
// Resolve lazily: unrelated headless tools never need to unlock the keychain.
const storage = () => Reflect.get(electron, 'safeStorage') as SafeStorage | undefined;
const generator = createSoundGenerator({ userData: () => app.getPath('userData'), secure: {
  isEncryptionAvailable: () => storage()?.isEncryptionAvailable() ?? false,
  encryptString: value => storage()!.encryptString(value),
  decryptString: value => storage()!.decryptString(value),
  getSelectedStorageBackend: () => storage()?.getSelectedStorageBackend?.() ?? '',
} });
export const soundKey = generator.soundKey;
export const generateSound = generator.generateSound;
export const generateSoundForEdit = generator.generateForEdit;
