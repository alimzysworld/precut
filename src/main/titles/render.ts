import { tool } from "../tools";
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { deflate, inflate } from "node:zlib";
import { promisify } from "node:util";
import { dirname, extname, join, resolve } from "node:path";
import { endianness } from "node:os";
import { currentActivity, threads } from "../activity";
import { captureFrame, captureWindow as sharedCaptureWindow, withinBudget } from "../capture-frame";
import type { OverlayItem, TitleCue, TitleTrack } from "../../shared/schema";
import type { CaptionTrack } from './captions';
import { asideAt, captionAsides, fullSpans, hiddenUnderFull, type AsideSpan } from "../../shared/caption-asides";

export interface TitleRenderOptions {
  width: number;
  height: number;
  fps: number;
  durationS: number;
  layer: "front" | "behind" | "all";
  out: string;
  overlays?: (OverlayItem & { url: string; mediaUrl?: string })[];
  asides?: AsideSpan[];   // TASTE1: where captions step aside (captionAsides), made once per render and drawn by the page too
}

/**
 * A backstop before validation: timing noise under one output frame never fails an export. A cue shorter than one
 * frame is dropped (it would show on at most one frame); a word that overhangs its cue, or starts before it, by
 * under a frame is clamped to the cue, and a word left shorter than a frame by that is dropped. Anything off by a
 * frame or more is left for validate to refuse, so a cue longer than a frame is never dropped quietly.
 */
export function tolerantTitleTrack(track: TitleTrack, fps: number): TitleTrack {
  const frame = Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30;
  let changed = false;
  const cues: TitleCue[] = [];
  for (const cue of track.cues ?? []) {
    if (Number.isFinite(cue.s) && Number.isFinite(cue.e) && cue.e - cue.s < frame) {
      changed = true;
      console.warn(`[titles] dropped ${cue.id}: shorter than one frame (${cue.s} to ${cue.e})`);
      continue;
    }
    if (!cue.words?.length) { cues.push(cue); continue; }
    let wordsChanged = false;
    const words = cue.words.flatMap(word => {
      if (!Number.isFinite(word.s) || !Number.isFinite(word.e)) return [word];
      let s = word.s, e = word.e;
      if (s < cue.s && cue.s - s < frame) s = cue.s;
      if (e > cue.e && e - cue.e < frame) e = cue.e;
      if (s === word.s && e === word.e) return [word];
      wordsChanged = true;
      // Clamped to nothing (or to a sliver): a word that was itself shorter than a frame goes.
      if (e <= s) return word.e - word.s < frame ? [] : [{ ...word, s, e }];
      return [{ ...word, s, e }];
    });
    if (wordsChanged) { changed = true; cues.push({ ...cue, words }); } else cues.push(cue);
  }
  return changed ? { ...track, cues } : track;
}

function validate(track: TitleTrack, options: TitleRenderOptions): void {
  for (const key of ["width", "height"] as const) {
    if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > 16384) {
      throw new Error(`Title ${key} must be an integer from 1 to 16384`);
    }
  }
  if (!Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 240 ||
      !Number.isFinite(options.durationS) || options.durationS <= 0) {
    throw new Error("Title fps must be in (0, 240] and durationS must be positive");
  }
  if (!["front", "behind", "all"].includes(options.layer)) throw new Error("Invalid title layer");
  if (extname(options.out).toLowerCase() !== ".mov") throw new Error("Titles require a .mov output");
  // VO7-15: a cover takes the caption font, which may be any family on this Mac; the template falls back if it is missing.
  if (typeof track.font !== "string" || track.font.trim() !== track.font || !/^[^"'\\;{}<>\u0000-\u001f\u007f]{1,100}$/.test(track.font)) throw new Error(`Invalid title font: ${track.font}`);  // = isFontFamilyName
  for (const cue of track.cues) {
    if (![cue.s, cue.e, cue.x, cue.y, cue.size, cue.rotate ?? 0].every(Number.isFinite) ||
        cue.s < 0 || cue.e <= cue.s || cue.size <= 0) throw new Error(`Invalid title cue: ${cue.id}`);
    if (![600, 700, 800, 900].includes(cue.weight) ||
        !["title", "subtitle"].includes(cue.role) || !["front", "behind"].includes(cue.layer) ||
        !["left", "center", "right"].includes(cue.align) ||
        !["pop", "slide-up", "slide-left", "type", "fade", "scale", "roll", "none"].includes(cue.enter) ||
        !["fade", "slide-down", "pop", "none"].includes(cue.exit)) throw new Error(`Invalid title style: ${cue.id}`);
    for (const word of cue.words ?? []) {
      if (!word.text || !Number.isFinite(word.s) || !Number.isFinite(word.e) || word.s < cue.s ||
          word.e <= word.s || word.e > cue.e) throw new Error(`Invalid title word in ${cue.id}`);
    }
  }
}

// Chromium's NativeImage bitmap is native-endian premultiplied Skia N32.
// ffmpeg raw RGBA needs straight alpha, including at antialiased/fading edges.
function straightRgba(bitmap: Buffer): Buffer {
  const little = endianness() === "LE";
  // EXP2: the same bytes, a word at a time (a caption frame is mostly clear pixels).
  if (little && bitmap.byteOffset % 4 === 0) {
    const words = new Uint32Array(bitmap.buffer, bitmap.byteOffset, bitmap.length >>> 2);
    for (let i = 0; i < words.length; i++) {
      const v = words[i];
      if (v === 0) continue;
      const a = v >>> 24;
      if (a === 0) { words[i] = 0; continue; }
      if (a === 255) { words[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff); continue; }
      const j = i << 2, factor = 255 / a, r = bitmap[j + 2], g = bitmap[j + 1], b = bitmap[j];
      bitmap[j] = Math.min(255, Math.round(r * factor));
      bitmap[j + 1] = Math.min(255, Math.round(g * factor));
      bitmap[j + 2] = Math.min(255, Math.round(b * factor));
    }
    return bitmap;
  }
  for (let i = 0; i < bitmap.length; i += 4) {
    const a = bitmap[i + (little ? 3 : 0)];
    if (a === 0) {
      bitmap[i] = 0; bitmap[i + 1] = 0; bitmap[i + 2] = 0; bitmap[i + 3] = 0;
      continue;
    }
    const r = bitmap[i + (little ? 2 : 1)];
    const g = bitmap[i + (little ? 1 : 2)];
    const b = bitmap[i + (little ? 0 : 3)];
    if (a === 255) {
      bitmap[i] = r; bitmap[i + 1] = g; bitmap[i + 2] = b; bitmap[i + 3] = a;
      continue;
    }
    const factor = 255 / a;
    bitmap[i] = Math.min(255, Math.round(r * factor));
    bitmap[i + 1] = Math.min(255, Math.round(g * factor));
    bitmap[i + 2] = Math.min(255, Math.round(b * factor));
    bitmap[i + 3] = a;
  }
  return bitmap;
}

// CAP4: template.html TAG_S and BLUR_S.
const TAG_S = .18, BLUR_S = .3;
// Longest opening style motion after a phrase arrives (template.html OPENING_STYLES: pop, re-centre and dim), with room.
const OPENING_MOTION_S = .3;
/** A capture changes only at an animation sample, word reveal or matte frame.
 * Holds and empty spans reuse exact lossless pixels, never approximate motion. */
export function titleFrameKey(track: TitleTrack, options: TitleRenderOptions, frame: number): string {
  const t = frame / options.fps, state: unknown[] = [], aside = asideAt(options.asides ?? captionAsides(track.cues, options.overlays), t);
  const full = fullSpans(options.overlays);
  for (const cue of track.cues) {
    if (options.layer !== 'all' && cue.layer !== options.layer || t < cue.s || t >= cue.e) continue;
    // SCN1b: captions a scene stepped aside for are not drawn on this frame (template.html), so they are not in its key.
    // TASTE1: nor are they under a key word, or before a word scene from the start of its line (captionAsides).
    if (aside && (cue.role === 'subtitle' || cue.id.startsWith('kinetic-') || !!(cue as TitleCue & { opening?: unknown }).opening)) continue;
    // TASTE1: a pinned title under a full-screen graphic is hidden there (template.html underFull).
    if (hiddenUnderFull(cue, t, full)) continue;
    const caption = cue.role === 'subtitle' ? track.captionStyle : null;
    const words: { text: string; s: number; e: number; accent?: boolean; accentAs?: import('../../shared/schema').CaptionAccentForm }[] = cue.words ?? [...cue.text.matchAll(/\S+/gu)].map((m,i)=>({text:m[0],s:cue.s+(cue.enter==='type'?i*.25:0),e:cue.e,accent:false}));
    // CAP4: a Tag accent wipes on over TAG_S from its word, then stays (template.html): how many have started is state.
    // (captions.ts accentFormOf, inline: this module stays free of the caption builder's imports)
    const tags = caption ? words.filter(w => w.accent && (w.accentAs ?? caption.accentAs) === 'tag') : [];
    // An opening style moves while any of its phrases arrives: the pop, the block re-centring and earlier lines dimming.
    const opening = !!(cue as TitleCue & { opening?: unknown }).opening && track.cues.some(c => (c as TitleCue & { opening?: unknown }).opening && c.e === cue.e && t >= c.s && t < c.s + OPENING_MOTION_S);
    // TRK1b: a pinned title follows its thing, so every frame it is on is its own sample.
    const moving = opening || !!cue.pinKeys || cue.enter !== 'none' && cue.enter !== 'type' && t < cue.s+.22 || cue.exit !== 'none' && t >= cue.e-.12 ||
      !!caption && (caption.animation === 'pulse' && words.some(w=>w.accent && t>=w.s && t<w.e) || caption.animation === 'typewriter' && caption.preset !== 'punch' && words.some(w=>t>=w.s && t<w.e)) ||
      // PAR1: template.html pops an accent word while it is spoken in every caption style (not only pulse): each frame moves.
      // CAP4: except Fade (Film), which never pops.
      !!caption && caption.animation !== 'fade' && words.some(w=>w.accent && t>=w.s && t<(w.e ?? cue.e)) ||
      // CAP4: a Tag's fill wiping on, and Blur in clearing (template.html TAG_S, BLUR_S).
      tags.some(w => t >= w.s && t < w.s + TAG_S) || caption?.effect === 'blur-in' && t < cue.s + BLUR_S;
    // The opening's caption edge switches at the spans main measured; a frame either side of a switch is its own capture.
    const edge = (cue as TitleCue & { opening?: { edges?: { s: number; e: number }[] } }).opening?.edges?.some(span => t >= span.s && t < span.e) ?? null;
    state.push([cue.id, moving ? frame : null, edge, !caption || caption.animation === 'typewriter' ? words.filter(w=>w.s<=t).length : null,
      // PAR1: the words being spoken, as template.html reads them (s to e), in every caption style and kinetic cue: the
      // template colours a spoken word with the accent in all of them (an opening style colours by accent only).
      (caption || cue.id.startsWith('kinetic-')) && !(cue as TitleCue & { opening?: unknown }).opening ? words.flatMap((w,i)=>t>=w.s && t<(w.e ?? cue.e) ? [i] : []).join(',') : null,
      ...(tags.length ? [tags.filter(w => t >= w.s).length] : [])]);
    if (cue.layer === 'behind') for (const matte of (track as TitleTrack & {personMattes?: {s:number;e:number;fps:number}[]}).personMattes ?? []) {
      if (t>=matte.s && t<matte.e) state.push(['matte',matte.s,Math.floor((t-matte.s)*matte.fps+1e-7)]);
    }
  }
  for (const item of options.overlays ?? []) if (options.layer === 'all' || options.layer === (item.graphic?.layer === 'behind' ? 'behind' : 'front')) if (t >= item.s && t < item.e && !hiddenUnderFull(item, t, full)) {
    // GFX1: a graphic is a function of time, so every frame it is on screen is its own sample.
    if (item.graphic) { state.push([item.id, frame]); continue; }
    const moving = !!item.pinKeys || item.enter !== 'none' && t < item.s+Math.min(.25,(item.e-item.s)/2) || item.exit !== 'none' && t >= item.e-Math.min(.15,(item.e-item.s)/2);
    state.push([item.id,moving?frame:null]);
  }
  return state.length ? JSON.stringify(state) : '';
}

/** CAP2/CAP3: export capture (the window one row taller than the frame, the seek token, the stale-frame check and the
 * frame budget) is shared with graphic stills and cover titles in ../capture-frame. */
async function captureTitleFrame(window: BrowserWindow, options: TitleRenderOptions, t: number, profile?: { stale: number; graphicStale: number }): Promise<Buffer> {
  return straightRgba(await captureFrame(window, options.width, options.height, t, undefined, profile));
}
const captureWindow = (options: TitleRenderOptions) => sharedCaptureWindow(options.width, options.height, 240);

const compress = promisify(deflate), decompress = promisify(inflate), subtle = webcrypto.subtle;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Sparse, straight-alpha input for the final compositor. The clock remains
 * the output frame clock, including gaps; no transparent frames cross the pipe.
 * Capture is demand driven, so picture rendering and Chromium run together. */
export function titleStream(track: TitleTrack, options: TitleRenderOptions, directory: string, assets: unknown, range?: { from: number; to: number }) {
  track = tolerantTitleTrack(track, options.fps);
  validate(track, options);
  options = { ...options, asides: options.asides ?? captionAsides(track.cues, options.overlays) };
  const frames = Math.ceil(options.durationS * options.fps - 1e-9);
  // EXP2: a part of the edit (output frames from..to) streams only its own samples. Timestamps stay on the
  // edit's frame clock; `enable` counts the part's own frames from zero, as its overlay does.
  const first = Math.max(0, range?.from ?? 0), end = Math.min(frames, range?.to ?? frames);
  const spans: { start: number; end: number; offset: number }[] = [];
  let count = 0;
  for (let frame = first; frame < end; frame++) {
    if (!titleFrameKey(track, options, frame)) continue;
    const last = spans.at(-1);
    if (last?.end === frame) last.end++;
    else spans.push({ start: frame, end: frame + 1, offset: frame - count });
    count++;
  }
  // Geometry reserves space across both layers. Include the complete connected
  // overlap group, even a cue not visible at this particular sample, so moving
  // a neighbour cannot silently reuse an obsolete placement.
  const contexts = new Map<string, string>();
  const captionTrack = track as CaptionTrack;
  for (const cue of track.cues) {
    let group = [cue], start = cue.s, end = cue.e;
    for (;;) {
      const next = track.cues.filter(c => c.s < end && c.e > start);
      if (next.length === group.length) break;
      group = next; start = Math.min(...group.map(c => c.s)); end = Math.max(...group.map(c => c.e));
    }
    contexts.set(cue.id, hash({ cues: group,
      faces: captionTrack.captionSource?.faces.filter(f => f.s < end && f.e > start),
      mattes: captionTrack.personMattes?.filter(m => m.s < end && m.e > start) }));
  }
  const design = { font: track.font, style: (track as TitleTrack & { style?: string }).style, captionStyle: track.captionStyle,
    safeArea: captionTrack.captionSource?.safeArea,
    preparedBehind: track.cues.filter(c => c.layer === 'behind').every(c => c.id.startsWith('kinetic-')) };
  // CAP2: revision 3: a sample captured before the capture token could be the previous frame; none is reused.
  // CAP3: revision 4: a graphic's frame could still be a frame late behind a fresh token; none is reused.
  // PRO5c: revision 5: a word behind the person could be captured before its matte was painted; none is reused.
  // TASTE1: revision 6: captions now step aside for key words and before word scenes; none drawn under the old rule is reused.
  // CAP4: revision 7: caption accent forms, Big lines, Fade and the optional text effects draw here now.
  // LOOK1: revision 8: a word scene can draw a picture from the shoot under its words (its look); none is reused.
  const identity = hash({ revision: 8, design, width: options.width, height: options.height,
    fps: options.fps, layer: options.layer, assets, overlays: options.overlays });
  const profile = { frames: count, empty: frames - count, captures: 0, hits: 0, reused: 0, stale: 0, graphicStale: 0, captureMs: 0, cacheMs: 0 };
  const enable = spans.map(s => `gte(n,${s.start - first})*lt(n,${s.end - first})`).join('+') || '0';
  let offset = String(spans.at(-1)?.offset ?? 0);
  let consumed = count;
  for (let i = spans.length - 2; i >= 0; i--) {
    consumed -= spans[i + 1].end - spans[i + 1].start;
    offset = `if(lt(N,${consumed}),${spans[i].offset},${offset})`;
  }
  // VO7: in microseconds (preview.ts sets AVTB), with the same arithmetic preview.ts uses to restamp the
  // picture, so sample k and picture frame k carry identical timestamps. Before, a picture timestamp a hair
  // early (rounding at a fractional rate such as 59.89) picked the previous sample: titles landed a frame
  // late, and the first frame of a held last shot showed black under the caption.
  const setpts = `(N+${offset})/${options.fps}/TB`;
  async function* pixels(): AsyncGenerator<Buffer> {
    let window: BrowserWindow | undefined, previous = '', rgba: Buffer | undefined;
    const writes: Promise<void>[] = [];
    const signal = currentActivity()?.signal;
    const cancel = () => { if (window && !window.isDestroyed()) window.destroy(); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await mkdir(directory, { recursive: true });
      for (const span of spans) for (let frame = span.start; frame < span.end; frame++) {
        signal?.throwIfAborted();
        const state = titleFrameKey(track, options, frame);
        const t = frame / options.fps;
        const key = hash([identity, track.cues.filter(c => c.s <= t && c.e > t).map(c => contexts.get(c.id)), state]);
        if (key === previous && rgba) profile.reused++;
        else {
          const file = join(directory, `${key}.rgba`), start = performance.now();
          try {
            const saved = await readFile(file);
            const decoded = await decompress(saved.subarray(32), { maxOutputLength: options.width * options.height * 4 });
            if (decoded.length !== options.width * options.height * 4 ||
                !Buffer.from(await subtle.digest('SHA-256', decoded)).equals(saved.subarray(0, 32))) throw new Error('Invalid title sample');
            rgba = decoded; profile.hits++;
          } catch {
            signal?.throwIfAborted();
            if (!window) {
              await app.whenReady();
              window = captureWindow(options);
              await window.loadFile((await import("../bundle-paths")).bundledFile("titles/template.html"));
              // PRO4b: a card's picture (MOT1: a scene's frames) goes in as a data image read by main from the shoot's card cache.
              const drawn = options.overlays?.some(o => o.graphic?.media || o.graphic?.frames?.length) ? { ...options, overlays: await (await import("../overlays")).withCardData(options.overlays!) } : options;
              await withinBudget(window, window.webContents.executeJavaScript(`window.titleRenderer.init(...${JSON.stringify([track, drawn])})`));
            }
            const captureStart = performance.now();
            rgba = await captureTitleFrame(window, options, t, profile);
            profile.captures++; profile.captureMs += performance.now() - captureStart;
            // EXP2: the sample goes to the encoder first; it is kept for the next export off the main thread
            // (hash and compression run in the thread pool), and a cache that cannot be written is only a cache.
            const sample = rgba, temporary = `${file}.${randomUUID()}.partial`;
            writes.push((async () => {
              try {
                const [bytes, digest] = await Promise.all([compress(sample, { level: 1 }), subtle.digest('SHA-256', sample)]);
                if (signal?.aborted) return;
                await writeFile(temporary, Buffer.concat([Buffer.from(digest), bytes]));
                await rename(temporary, file);
              } catch { /* not kept */ } finally { await rm(temporary, { force: true }).catch(() => {}); }
            })());
          }
          profile.cacheMs += performance.now() - start;
          previous = key;
        }
        yield rgba!;
      }
    } finally {
      signal?.removeEventListener('abort', cancel); cancel();
      await Promise.all(writes);
    }
  }
  return { spans, frames: count, enable, setpts, profile, pixels };
}

/** Frame n is sampled at n / fps; a fractional last frame rounds duration up. */
export async function renderTitleTrack(track: TitleTrack, options: TitleRenderOptions): Promise<void> {
  const started = performance.now();
  const profile = { frames: 0, captures: 0, reused: 0, empty: 0, stale: 0, graphicStale: 0, captureMs: 0, pipeMs: 0, wallMs: 0, codec: 'qtrle' };
  track = tolerantTitleTrack(track, options.fps);
  validate(track, options);
  options = { ...options, asides: options.asides ?? captionAsides(track.cues, options.overlays) };
  await app.whenReady();
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  const temporary = `${out}.${randomUUID()}.partial`;
  const frames = Math.max(1, Math.ceil(options.durationS * options.fps - 1e-9));
  const window = captureWindow(options);
  const encoder = spawn(tool("ffmpeg"), [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", `${options.width}x${options.height}`,
    "-framerate", String(options.fps), "-i", "pipe:0", "-an",
    "-frames:v", String(frames), "-c:v", "qtrle", "-pix_fmt", "argb", "-threads", String(threads(2)), "-f", "mov", temporary,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  let streamError: Error | undefined;
  let encoderError: Error | undefined;
  encoder.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  encoder.stdin.on("error", (error: Error) => { streamError = error; });
  // Resolve on errors too, so an early encoder failure never becomes an unhandled rejection.
  const finished = new Promise<{ code: number | null; error?: Error }>((done) => {
    encoder.once("error", error => { encoderError = error; done({ code: null, error }); });
    encoder.once("close", code => done({ code }));
  });
  const cancel = () => { encoder.kill("SIGKILL"); if (!window.isDestroyed()) window.destroy(); };
  const signal = currentActivity()?.signal;
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    await window.loadFile((await import("../bundle-paths")).bundledFile("titles/template.html"));
    // PRO4b: a card's picture (MOT1: a scene's frames) goes in as a data image read by main from the shoot's card cache.
    const drawn = options.overlays?.some(o => o.graphic?.media || o.graphic?.frames?.length) ? { ...options, overlays: await (await import("../overlays")).withCardData(options.overlays!) } : options;
    const payload = JSON.stringify([track, drawn]);
    await withinBudget(window, window.webContents.executeJavaScript(`window.titleRenderer.init(...${payload})`));
    let previousKey: string | undefined, rgba: Buffer = Buffer.alloc(options.width * options.height * 4);
    const empty = rgba;
    for (let frame = 0; frame < frames; frame++) {
      signal?.throwIfAborted();
      if (encoderError || streamError || encoder.exitCode !== null) {
        throw encoderError ?? streamError ?? new Error(`Title encoder stopped early (${encoder.exitCode})`);
      }
      const state = titleFrameKey(track, options, frame);
      if (!state) { rgba = empty; profile.empty++; }
      else if (state === previousKey) profile.reused++;
      else {
        const captureStart = performance.now();
        rgba = await captureTitleFrame(window, options, frame / options.fps, profile);
        profile.captureMs += performance.now() - captureStart;
        profile.captures++;
      }
      previousKey = state;
      if (rgba.length !== options.width * options.height * 4) throw new Error("Unexpected title capture dimensions");
      const pipeStart = performance.now();
      // The write callback provides backpressure: at most one frame is in flight.
      await new Promise<void>((done, fail) => encoder.stdin.write(rgba, error => error ? fail(error) : done()));
      profile.pipeMs += performance.now() - pipeStart;
      profile.frames++;
    }
    encoder.stdin.end();
    const result = await finished;
    if (result.error || result.code !== 0 || streamError) {
      throw result.error ?? streamError ?? new Error(`Title ffmpeg exited ${result.code}: ${stderr}`);
    }
    await rename(temporary, out);
    profile.wallMs = performance.now() - started;
    await writeFile(`${out}.profile.json`, JSON.stringify(profile));
  } catch (error) {
    encoder.stdin.destroy();
    encoder.kill("SIGKILL");
    await finished;
    throw new Error(`Title render failed: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`);
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!window.isDestroyed()) window.destroy();
    await rm(temporary, { force: true });
  }
}
