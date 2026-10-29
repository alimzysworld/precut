#!/bin/bash
# Build-host only. End users never need curl, a compiler, or a package manager.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'Build tools on an arm64 Mac.' >&2; exit 1; }
mkdir -p build/tools
work=$(mktemp -d "${TMPDIR:-/tmp}/precut-tools.XXXXXX")
trap 'rm -rf "$work"' EXIT
fetch() {
  local url=$1 checksum=$2 destination=$3
  /usr/bin/curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "$url" -o "$destination"
  echo "$checksum  $destination" | /usr/bin/shasum -a 256 -c -
}
# FFM1: precut's own ffmpeg and ffprobe, built from pinned source by scripts/build-ffmpeg.sh, which also writes the
# GPL source bundle each release attaches. Built once (about 4 minutes), then reused while its BUILDINFO.txt names
# this exact build script. PRECUT_FFMPEG_DIR builds elsewhere.
ffbuild="${PRECUT_FFMPEG_DIR:-dist.noindex/ffmpeg}"
ffscript=$(/usr/bin/shasum -a 256 scripts/build-ffmpeg.sh | awk '{print $1}')
/usr/bin/grep -qx "script $ffscript" "$ffbuild/BUILDINFO.txt" 2>/dev/null || bash scripts/build-ffmpeg.sh "$ffbuild"
ffversion=$(awk '$1 == "ffmpeg" {print $2}' "$ffbuild/BUILDINFO.txt")
[ -f "$ffbuild/ffmpeg-source-$ffversion.tar.gz" ] || { echo "Missing $ffbuild/ffmpeg-source-$ffversion.tar.gz" >&2; exit 1; }
# The binaries must be exactly the ones the source bundle describes.
for name in ffmpeg ffprobe; do
  /usr/bin/grep -qx "output $name $(/usr/bin/shasum -a 256 "$ffbuild/$name" | awk '{print $1}')" "$ffbuild/BUILDINFO.txt" \
    || { echo "$ffbuild/$name does not match its BUILDINFO.txt; delete that file to rebuild." >&2; exit 1; }
done
# The starter music (CC BY 4.0, build/music/tracks.json: file, url, sha256) is too big for the public source tree, so it is
# downloaded here. A file that is already present with the right hash is kept; a wrong hash after a download fails the run.
while IFS=$'\t' read -r file url sum; do
  if [ -f "build/music/$file" ] && echo "$sum  build/music/$file" | /usr/bin/shasum -a 256 -c - >/dev/null 2>&1; then continue; fi
  echo "Fetching build/music/$file"
  fetch "$url" "$sum" "$work/$file" || { echo "build/music/$file: download or SHA-256 check failed ($url)" >&2; exit 1; }
  install -m 644 "$work/$file" "build/music/$file"
done < <(/usr/bin/python3 -I -c 'import json,sys; [print(t["file"], t["url"], t["sha256"], sep="\t") for t in json.load(open(sys.argv[1]))]' build/music/tracks.json)
fetch https://github.com/astral-sh/uv/releases/download/0.12.20/uv-aarch64-apple-darwin.tar.gz 848fdeb602ff1a1baacd4f6c8b7bdc6cf1ad026a6d9cf59475fda17c179743ca "$work/uv.tar.gz"
fetch https://downloads.sourceforge.net/project/exiftool/Image-ExifTool-13.59.tar.gz 668ea3acececb7235fbd0f4900e72d5f12c9b07e5c778fd36cb1e9b5828fd65a "$work/exiftool.tar.gz"
tar -xzf "$work/uv.tar.gz" -C "$work"
tar -xzf "$work/exiftool.tar.gz" -C "$work"
install -m 755 "$ffbuild/ffmpeg" "$ffbuild/ffprobe" "$work/uv-aarch64-apple-darwin/uv" build/tools/
mkdir -p build/tools/exiftool
cp -R "$work/Image-ExifTool-13.59/." build/tools/exiftool/
chmod 755 build/tools/exiftool/exiftool
# /usr/bin/perl is available on factory macOS, independently of PATH.
/usr/bin/sed -i '' '1s|.*|#!/usr/bin/perl|' build/tools/exiftool/exiftool
for name in subject matte voice record-words smart-frames quality place power-watch screen-read; do
  speech_flags=()
  if [ "$name" = record-words ]; then
    speech_flags=(-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PWD/pipeline/record-words.plist")
  fi
  xcrun swiftc ${speech_flags[@]+"${speech_flags[@]}"} -O -target arm64-apple-macosx13.0 -module-cache-path "$work/swift-cache" "pipeline/$name.swift" -o "$work/$name"
  install -m 755 "$work/$name" "build/tools/$name"
done
# AV1b: the Apple player's helper and its in-process addon, from one composition builder (checks its own outputs).
bash scripts/build-apple-player.sh
for name in ffmpeg ffprobe uv subject matte voice record-words smart-frames quality place power-watch screen-read; do
  /usr/bin/lipo "build/tools/$name" -verify_arch arm64
  # System frameworks/libraries only: no Homebrew or build-machine dylibs.
  if /usr/bin/otool -L "build/tools/$name" | tail -n +2 | awk '{print $1}' | /usr/bin/grep -Ev '^(/System/Library/|/usr/lib/)' ; then
    echo "Non-system dependency in $name" >&2; exit 1
  fi
done
filters=$(build/tools/ffmpeg -hide_banner -filters 2>&1)
# The filters precut calls that need a library or a specific build: vid.stab (motion.ts), drawtext (judge.ts),
# arnndn (voice clean-up) and lut3d (looks).
for name in vidstabdetect drawtext arnndn lut3d; do
  echo "$filters" | /usr/bin/grep -q " $name " || { echo "Missing filter $name" >&2; exit 1; }
done
build/tools/ffprobe -version | head -n 1
build/tools/uv --version
build/tools/exiftool/exiftool -ver
# Local sources are pinned by the release's source tree; record their hashes too.
/usr/bin/shasum -a 256 pipeline/subject.swift pipeline/matte.swift pipeline/voice.swift pipeline/record-words.swift pipeline/smart-frames.swift pipeline/quality.swift pipeline/place.swift pipeline/power-watch.swift pipeline/screen-read.swift pipeline/apple-composition.swift pipeline/apple-look.swift pipeline/apple-player.swift pipeline/apple-view.swift pipeline/apple-addon.c pipeline/record-words.plist build/tools/{ffmpeg,ffprobe,uv,subject,matte,voice,record-words,smart-frames,quality,place,power-watch,screen-read,apple-player,apple-player.node} "$ffbuild/ffmpeg-source-$ffversion.tar.gz" > build/tools/SHA256SUMS
echo 'precut tools verified and ready.'
