// ONB2: download sizes REL1 measured on a fresh account (29 Oct, du of precut's support folder after the first run):
// the Python tools (python 66 MiB + venv 1243 MiB) and the speech model (1540 MiB), in decimal GB as Finder shows.
export const DOWNLOAD_SIZES = { tools: "1.4 GB", speech: "1.6 GB" } as const;
export const TOOLS_OFFLINE_LINE = `precut needs a one-time ${DOWNLOAD_SIZES.tools} download to read footage. It starts when you're online.`;
export const DOWNLOADS_PAUSED = "Downloads paused. They carry on by themselves when you're online.";
export const DOWNLOAD_STALLED = "The download stalled. Picking it up again.";
