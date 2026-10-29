/** IPC serializes Error.message but drops cause. Preserve the useful part in main
 * and remove only Electron's invocation wrapper here. Never infer a drive fault. */
export function draftFailure(cause: unknown): string {
  const message = (cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim();
  return message ? `Couldn't open live playback: ${message}` : "Couldn't open live playback. Try reopening this edit.";
}
