#!/bin/bash
# SIGN1: install a built precut.app. Usage: scripts/install-local.sh <path-to-built precut.app>
# Env (for tests only): PRECUT_INSTALL_DIR (default ~/Applications), PRECUT_BACKUP_DIR (default ~/.Trash),
# PRECUT_SKIP_INDEX=1 skips lsregister and mdimport so a test never registers a temp bundle.
# PRECUT_RUNNING_PATH (default <install dir>/precut.app/Contents/MacOS/precut).
set -euo pipefail
NEW="${1:?usage: install-local.sh <path-to-built precut.app>}"
INSTALL_DIR="${PRECUT_INSTALL_DIR:-$HOME/Applications}"
BACKUP_DIR="${PRECUT_BACKUP_DIR:-$HOME/.Trash}"
DEST="$INSTALL_DIR/precut.app"
RUNNING="${PRECUT_RUNNING_PATH:-$DEST/Contents/MacOS/precut}"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ -d "$NEW/Contents" ] || { echo "not an app bundle: $NEW" >&2; exit 1; }
# Exact match on the executable path; never matches by name pattern, never kills anything.
PROCS="$(ps -axo comm=)"
if printf '%s\n' "$PROCS" | grep -F -x -q -- "$RUNNING"; then
  echo "precut is running from $RUNNING. Quit it, then run this again." >&2; exit 1
fi
version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist"; }

mkdir -p "$INSTALL_DIR" "$BACKUP_DIR"
STAGE="$(mktemp -d "$INSTALL_DIR/.precut-stage.XXXXXX")"
trap '[ -n "${STAGE:-}" ] && [ -d "$STAGE" ] && /bin/rm -rf "$STAGE"' EXIT
/bin/cp -cR "$NEW" "$STAGE/precut.app"
codesign --verify --deep --strict "$STAGE/precut.app" || { echo "signature check failed on the staged copy; nothing installed" >&2; exit 1; }
SIG="$(codesign -dv "$STAGE/precut.app" 2>&1)"
case "$SIG" in *Identifier=com.sidething.precut*) ;; *) echo "staged bundle is not signed as com.sidething.precut; nothing installed" >&2; exit 1 ;; esac

if [ -d "$DEST" ]; then
  OLD="$(version "$DEST")"
  BACKUP="$BACKUP_DIR/precut $OLD backup.app"
  [ -e "$BACKUP" ] && BACKUP="$BACKUP_DIR/precut $OLD backup $(date +%H.%M.%S).app"
  n=2; while [ -e "$BACKUP" ]; do BACKUP="$BACKUP_DIR/precut $OLD backup $(date +%H.%M.%S) $n.app"; n=$((n+1)); done
  mv "$DEST" "$BACKUP"
  echo "backup: $BACKUP"
fi
mv "$STAGE/precut.app" "$DEST"
if [ -n "${PRECUT_SKIP_INDEX:-}" ]; then echo "index: skipped (PRECUT_SKIP_INDEX)"; else
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$DEST"
  mdimport "$DEST"
fi
echo "installed precut $(version "$DEST") at $DEST"
