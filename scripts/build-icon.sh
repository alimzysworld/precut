#!/bin/sh
# Compile the Tahoe app icon (build/precut.icon) into build/icon-car/Assets.car with Xcode's actool.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ACTOOL="${ACTOOL:-/Applications/Xcode.app/Contents/Developer/usr/bin/actool}"
mkdir -p build/icon-car
"$ACTOOL" "$ROOT/build/precut.icon" --compile "$ROOT/build/icon-car" --app-icon precut --enable-on-demand-resources NO \
  --development-region en --target-device mac --platform macosx --minimum-deployment-target 11.0 \
  --output-partial-info-plist "$ROOT/build/icon-car/partial.plist" >/dev/null
cp build/icon-car/precut.icns build/icon.icns
echo "icon compiled"
