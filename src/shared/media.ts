// How the renderer asks for a shoot's frames and proxies in Electron.
// Main serves st-media:// (src/main/media.ts); only files inside
// <root>/.sidething/ are ever served. The browser fixture doesn't use this.
export const MEDIA_SCHEME = "st-media";

export function mediaUrl(root: string, kind: "frames" | "proxies" | "judge" | "precuts", file: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(root)}/${kind}/${encodeURIComponent(file)}`;
}
