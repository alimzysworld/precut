#!/bin/bash
# SIGN2: check a release build the way Gatekeeper and Squirrel will.
#   scripts/verify-signed.sh <precut.app> [precut.dmg] [--signed-only]
# --signed-only skips the notarisation checks (spctl, stapler) for a build made with PRECUT_SKIP_NOTARIZE=1.
# Fails on: a broken seal, any Mach-O in the bundle not signed by team 54D78KXPT9 or without the hardened runtime,
# a __pycache__ inside the bundle, or (unless --signed-only) Gatekeeper not saying "Notarized Developer ID".
set -euo pipefail
TEAM=54D78KXPT9
APP="${1:?usage: verify-signed.sh <precut.app> [precut.dmg] [--signed-only]}"
DMG=""; SIGNED_ONLY=""
for arg in "${@:2}"; do case "$arg" in --signed-only) SIGNED_ONLY=1 ;; *) DMG="$arg" ;; esac; done
fail() { echo "FAIL: $*" >&2; exit 1; }

/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -n 2
info=$(/usr/bin/codesign -dv --verbose=4 "$APP" 2>&1)
grep -q "Identifier=com.sidething.precut$" <<<"$info" || fail "app identifier is not com.sidething.precut"
grep -q "TeamIdentifier=$TEAM" <<<"$info" || fail "app is not signed by team $TEAM"
grep -q "Authority=Developer ID Application: sidething LTD ($TEAM)" <<<"$info" || fail "app is not signed with the Developer ID"
grep -Eq "flags=0x[0-9a-f]*\(runtime\)" <<<"$info" || fail "app has no hardened runtime"
grep -q "Timestamp=" <<<"$info" || fail "app signature has no secure timestamp"
echo "app: com.sidething.precut, Developer ID $TEAM, hardened runtime, timestamped"
echo "entitlements:"; /usr/bin/codesign -d --entitlements :- "$APP" 2>/dev/null | /usr/bin/plutil -p - | sed 's/^/  /'

# Every Mach-O file in the bundle (Electron, its helpers and frameworks, node-pty, apple-player.node, every tool).
count=0; bad=0
while IFS= read -r -d '' file; do
  /usr/bin/file -b "$file" | grep -q '^Mach-O' || continue
  count=$((count + 1))
  d=$(/usr/bin/codesign -dv --verbose=4 "$file" 2>&1 || true)
  if ! grep -q "TeamIdentifier=$TEAM" <<<"$d" || ! grep -Eq "flags=0x[0-9a-f]*\(runtime\)|flags=0x[0-9a-f]*\(.*runtime.*\)" <<<"$d" \
     || ! /usr/bin/codesign --verify --strict "$file" 2>/dev/null; then
    echo "  not signed right: ${file#"$APP"/}"; bad=$((bad + 1))
  fi
done < <(/usr/bin/find "$APP" -type f -print0)
[ "$bad" = 0 ] || fail "$bad of $count Mach-O files are not signed by $TEAM with the hardened runtime"
echo "nested: all $count Mach-O files signed by $TEAM, hardened runtime, verify --strict ok"
[ -z "$(/usr/bin/find "$APP" -name __pycache__ -print -quit)" ] || fail "__pycache__ inside the bundle"
# Links stay inside the bundle (the frameworks' Versions/Current and friends); none may point out of it.
while IFS= read -r -d '' link; do
  target=$(/usr/bin/readlink "$link")
  case "$target" in /*) fail "link out of the bundle: ${link#"$APP"/} -> $target" ;; esac
done < <(/usr/bin/find "$APP" -type l -print0)

if [ -z "$SIGNED_ONLY" ]; then
  out=$(/usr/sbin/spctl -a -vvv -t exec "$APP" 2>&1); echo "$out"
  grep -q "accepted" <<<"$out" && grep -q "source=Notarized Developer ID" <<<"$out" || fail "Gatekeeper does not accept the app as Notarized Developer ID"
  /usr/bin/xcrun stapler validate "$APP" | tail -n 1
fi
if [ -n "$DMG" ]; then
  d=$(/usr/bin/codesign -dv --verbose=4 "$DMG" 2>&1)
  grep -q "TeamIdentifier=$TEAM" <<<"$d" || fail "dmg is not signed by $TEAM"
  if [ -z "$SIGNED_ONLY" ]; then
    out=$(/usr/sbin/spctl -a -vvv -t install "$DMG" 2>&1); echo "$out"
    grep -q "accepted" <<<"$out" && grep -q "source=Notarized Developer ID" <<<"$out" || fail "Gatekeeper does not accept the dmg as Notarized Developer ID"
    /usr/bin/xcrun stapler validate "$DMG" | tail -n 1
  fi
fi
echo "verify-signed: ok"
