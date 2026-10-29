#!/bin/bash
# SIGN2: build a signed, notarised, stapled precut for release: precut.dmg (to install) and precut.zip +
# latest-mac.yml (what the in-app updater reads), plus ffmpeg-source-<version>.tar.gz (FFM1, the GPL source of the
# bundled ffmpeg and ffprobe). Run it in the public tree that scripts/release-public.sh wrote,
# so the binary on the Releases tab is built from exactly the source published beside it.
#
#   scripts/release-mac.sh [output dir]        default: dist.noindex/release-<version>
#
# Needs, on an arm64 Mac:
#   - "Developer ID Application: sidething LTD (54D78KXPT9)" in the login keychain;
#   - the notary profile "precut" (xcrun notarytool store-credentials precut ...);
#   - build/tools filled (npm run fetch-tools; it is run for you when a tool is missing).
# Env (tests only): PRECUT_SKIP_NOTARIZE=1 signs with the Developer ID but skips Apple's notary service.
#   PRECUT_UNSIGNED=1 is a dry run for a shell that cannot reach the signing key: it builds an ad-hoc signed
#   precut.app (no dmg, no zip, no latest-mac.yml), checks the bundle and stops. It can never produce a release.
# Nothing is published: electron-builder runs with --publish never. Never uploads anything but this build to Apple.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'Release on an arm64 Mac.' >&2; exit 1; }

TEAM=54D78KXPT9
IDENTITY="Developer ID Application: sidething LTD ($TEAM)"
PROFILE=precut
VERSION=$(node -p 'require("./package.json").version')
OUT="${1:-dist.noindex/release-$VERSION}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
APP="$OUT/mac-arm64/precut.app"
DMG="$OUT/precut.dmg"
ZIP="$OUT/precut.zip"

# The identity must be a valid code-signing identity. Lists names and hashes only; never reads a key.
if [ -z "${PRECUT_UNSIGNED:-}" ]; then
  /usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -F -q "\"$IDENTITY\"" \
    || { echo "No valid \"$IDENTITY\" in the keychain." >&2; exit 1; }
fi

# Nothing in build/tools may be a link: electron-builder copies links as they are, so a link to / would ship
# inside the app and send the signer walking the whole disk (seen 29 Oct: /usr, /Users ... links in build/tools).
links=$(/usr/bin/find build/tools -type l)
[ -z "$links" ] || { printf 'Links in build/tools; remove them first:\n%s\n' "$links" >&2; exit 1; }
missing=0
for tool in ffmpeg ffprobe uv exiftool/exiftool subject matte voice record-words smart-frames quality place power-watch screen-read apple-player apple-player.node; do
  [ -e "build/tools/$tool" ] || { echo "build/tools/$tool is missing"; missing=1; }
done
[ "$missing" = 0 ] || npm run fetch-tools
# FFM1: the ffmpeg and ffprobe about to ship must be the ones the GPL source bundle describes; the release attaches it.
ffbuild="${PRECUT_FFMPEG_DIR:-dist.noindex/ffmpeg}"
ffversion=$(awk '$1 == "ffmpeg" {print $2}' "$ffbuild/BUILDINFO.txt" 2>/dev/null || true)
FFSOURCE="$ffbuild/ffmpeg-source-$ffversion.tar.gz"
for tool in ffmpeg ffprobe; do
  /usr/bin/grep -qx "output $tool $(/usr/bin/shasum -a 256 "build/tools/$tool" | awk '{print $1}')" "$ffbuild/BUILDINFO.txt" 2>/dev/null \
    || { echo "build/tools/$tool is not the build in $ffbuild; run npm run fetch-tools." >&2; exit 1; }
done
[ -n "$ffversion" ] && [ -f "$FFSOURCE" ] || { echo "No ffmpeg source bundle in $ffbuild; run npm run fetch-tools." >&2; exit 1; }

# REL2: the JavaScript licence notices must match package-lock.json.
node scripts/notices.mjs --check
echo "Building precut $VERSION into $OUT"
npx electron-vite build
if [ -n "${PRECUT_UNSIGNED:-}" ]; then
  # Dry run: the app folder only, ad-hoc signed by the dev hook, so nothing here can be uploaded as a release.
  unset APPLE_KEYCHAIN_PROFILE
  npx electron-builder --mac dir --arm64 --publish never -c.directories.output="$OUT"
  node scripts/check-bundle.mjs "$APP"
  echo "PRECUT_UNSIGNED dry run: $APP built and checked. Not signed, not a release."
  exit 0
fi
# Only the keychain profile: other APPLE_* credentials in the environment would take precedence in electron-builder.
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_KEYCHAIN
if [ -z "${PRECUT_SKIP_NOTARIZE:-}" ]; then export APPLE_KEYCHAIN_PROFILE="$PROFILE"
else unset APPLE_KEYCHAIN_PROFILE; echo "PRECUT_SKIP_NOTARIZE: signed, not notarised (tests only)"; fi
# electron-builder signs every Mach-O in the bundle inside-out with hardened runtime and
# build/entitlements.mac.plist, notarises the app with the keychain profile, staples it, then writes the dmg and zip.
npx electron-builder --mac dmg zip --arm64 --publish never \
  -c.mac.identity="sidething LTD ($TEAM)" -c.directories.output="$OUT"

# REL2: refuse a bundle missing any helper the app spawns, any licence text it owes, or the macOS 14 floor.
node scripts/check-bundle.mjs "$APP"

# The disk image is signed and notarised on its own, so Gatekeeper accepts the download before it is opened.
/usr/bin/codesign --force --sign "$IDENTITY" --timestamp "$DMG"
if [ -z "${PRECUT_SKIP_NOTARIZE:-}" ]; then
  /usr/bin/xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
  /usr/bin/xcrun stapler staple "$DMG"
  /usr/bin/xcrun stapler validate "$APP"
  /usr/bin/xcrun stapler validate "$DMG"
fi
# Signing and stapling changed the dmg after electron-builder hashed it: refresh its entry in latest-mac.yml.
node - "$OUT/latest-mac.yml" "$DMG" <<'NODE'
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const [file, dmg] = process.argv.slice(2);
const name = path.basename(dmg), data = fs.readFileSync(dmg);
const sha512 = crypto.createHash("sha512").update(data).digest("base64");
const lines = fs.readFileSync(file, "utf8").split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() !== `- url: ${name}`) continue;
  for (let j = i + 1; j < lines.length && /^\s{4}\S/.test(lines[j]); j++) {
    if (lines[j].trim().startsWith("sha512:")) lines[j] = lines[j].replace(/sha512: .*/, `sha512: ${sha512}`);
    if (lines[j].trim().startsWith("size:")) lines[j] = lines[j].replace(/size: .*/, `size: ${data.length}`);
  }
}
fs.writeFileSync(file, lines.join("\n"));
NODE
rm -f "$DMG.blockmap"
# The GPL complete corresponding source of the ffmpeg and ffprobe inside this build.
install -m 644 "$FFSOURCE" "$OUT/"

bash scripts/verify-signed.sh "$APP" "$DMG" ${PRECUT_SKIP_NOTARIZE:+--signed-only}
echo
echo "precut $VERSION ready in $OUT:"
ls -l "$DMG" "$ZIP" "$OUT/latest-mac.yml" "$OUT/$(basename "$FFSOURCE")"
echo "Next: hand back to Claude to commit the public tree, tag v$VERSION and attach precut.dmg, precut.zip, precut.zip.blockmap, latest-mac.yml and $(basename "$FFSOURCE")."
