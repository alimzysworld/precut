#!/bin/bash
# AV1b: build the Apple player, both faces from one composition builder.
#   build/tools/apple-player       command line helper (validate, frame, rms) for tests and QA
#   build/tools/apple-player.node  the in-process addon main loads: the picture behind precut's page
# Called by scripts/fetch-tools.sh; runs on its own too (no network). Same swiftc flags as every helper.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'Build the Apple player on an arm64 Mac.' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/precut-apple-player.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p build/tools
# N-API headers ship with every Node install. N-API is ABI stable, so the addon loads in Electron unchanged.
node_include=$(node -p "require('path').resolve(process.execPath, '../../include/node')")
[ -f "$node_include/node_api.h" ] || { echo "No node_api.h under $node_include" >&2; exit 1; }
flags=(-O -target arm64-apple-macosx13.0 -module-cache-path "$work/swift-cache")
# AV2: apple-look.swift (the Look on the GPU) is in both, so a QA frame is drawn exactly as the window draws it.
xcrun swiftc "${flags[@]}" pipeline/apple-composition.swift pipeline/apple-look.swift pipeline/apple-player.swift -o "$work/apple-player"
xcrun clang -c -O2 -Wall -Werror -target arm64-apple-macosx13.0 -I"$node_include" pipeline/apple-addon.c -o "$work/apple-addon.o"
xcrun swiftc "${flags[@]}" -emit-library -module-name ApplePlayerAddon pipeline/apple-composition.swift pipeline/apple-look.swift pipeline/apple-view.swift "$work/apple-addon.o" \
  -o "$work/apple-player.node" -Xlinker -undefined -Xlinker dynamic_lookup
install -m 755 "$work/apple-player" build/tools/apple-player
install -m 755 "$work/apple-player.node" build/tools/apple-player.node
for name in apple-player apple-player.node; do
  /usr/bin/lipo "build/tools/$name" -verify_arch arm64
  # System frameworks/libraries only: no Homebrew or build-machine dylibs.
  # A library lists its own install name first; that is not a dependency.
  own=$(/usr/bin/otool -D "build/tools/$name" | tail -n +2)
  if /usr/bin/otool -L "build/tools/$name" | tail -n +2 | awk '{print $1}' | /usr/bin/grep -vxF "${own:-/}" | /usr/bin/grep -Ev '^(/System/Library/|/usr/lib/)' ; then
    echo "Non-system dependency in $name" >&2; exit 1
  fi
done
echo 'Apple player built.'
