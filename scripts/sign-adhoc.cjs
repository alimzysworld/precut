// electron-builder afterPack hook (SIGN1). There is no Developer ID certificate on this Mac, so the
// bundle is signed ad hoc, but as com.sidething.precut. electron-builder's `identity: null` leaves
// Electron's stock linker signature (Identifier=Electron), and Spotlight drops the app from search
// until it is re-signed. Signing here, before the dmg or dir target is written, removes the hand step.
// Nested code (frameworks, helpers) is signed inside-out by --deep, each with its own bundle id.
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function signAdHoc(context) {
  if (context.electronPlatformName !== "darwin") return;
  // SIGN2: dev builds only. A release build (scripts/release-mac.sh) sets mac.identity to the Developer ID, and
  // electron-builder then signs with hardened runtime and notarises; an ad-hoc pass here would only be overwritten.
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (typeof identity === "string" && identity.length) { console.log(`  • sign-adhoc skipped: release build signs as "${identity}"`); return; }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", app], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const info = spawnSync("/usr/bin/codesign", ["-dv", app], { encoding: "utf8" });
  if (!/Identifier=com\.sidething\.precut\b/.test(info.stderr)) throw new Error(`sign-adhoc: wrong identifier\n${info.stderr}`);
};
