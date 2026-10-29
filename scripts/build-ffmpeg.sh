#!/bin/bash
# FFM1: precut's own ffmpeg and ffprobe, built for arm64 from pinned upstream source, plus the source bundle each
# release attaches beside the DMG (the GPL's complete corresponding source for those two binaries).
#
#   scripts/build-ffmpeg.sh [--offline] [output dir]       default output: dist.noindex/ffmpeg
#
# Writes into the output dir: ffmpeg, ffprobe, BUILDINFO.txt and ffmpeg-source-<version>.tar.gz. Source archives
# are read from <output dir>/sources, or from sources/ beside this script when it runs from an unpacked source
# bundle. A missing archive is downloaded from its upstream release location unless --offline is given. Every
# archive must match the SHA-256 pinned below before it is unpacked.
#
# Needs only an arm64 Mac with the Xcode command line tools (clang, make, ar, strip, /usr/bin/python3, perl).
# pkgconf and ninja are built here from their pinned sources and meson runs from its pinned source, so the bundle
# rebuilds with no network. No Homebrew, no sudo, nothing written outside the output dir and a temporary folder.
#
# Licence: the result is GPL-2.0-or-later as a whole (x264 and vid.stab are GPL). Never add --enable-nonfree.
# Reproducible: the same archives, this script and the same command line tools (clang and SDK versions, recorded
# in BUILDINFO.txt) give byte-identical ffmpeg and ffprobe, whatever folder the build runs in.
set -euo pipefail

# A clean environment: nothing from Homebrew, MacPorts or the caller's flags can reach the build.
if [ -z "${PRECUT_FFMPEG_CLEAN_ENV:-}" ]; then
  exec /usr/bin/env -i PRECUT_FFMPEG_CLEAN_ENV=1 HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" \
    PRECUT_FFMPEG_KEEP="${PRECUT_FFMPEG_KEEP:-}" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C TZ=UTC \
    /bin/bash "${BASH_SOURCE[0]}" "$@"
fi
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'Build ffmpeg on an arm64 Mac.' >&2; exit 1; }
/usr/bin/xcrun --find clang >/dev/null 2>&1 || { echo 'Install the Xcode command line tools (xcode-select --install).' >&2; exit 1; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/$(basename "${BASH_SOURCE[0]}")"
OFFLINE=0 OUT=""
for arg; do
  case $arg in
    --offline) OFFLINE=1 ;;
    -*) echo "Usage: $0 [--offline] [output dir]" >&2; exit 2 ;;
    *) OUT=$arg ;;
  esac
done
if [ -d "$HERE/sources" ] && [ -f "$HERE/BUILDINFO.txt" ]; then
  # Running from an unpacked ffmpeg-source bundle.
  SOURCES_DIR="$HERE/sources"; OUT="${OUT:-$HERE/out}"
else
  OUT="${OUT:-$HERE/../dist.noindex/ffmpeg}"; SOURCES_DIR="$OUT/sources"
fi
mkdir -p "$OUT" "$SOURCES_DIR"
OUT=$(cd "$OUT" && pwd); SOURCES_DIR=$(cd "$SOURCES_DIR" && pwd)

FFMPEG_VERSION=9.0.2
MIN_MACOS=13.0
# Fixed timestamp for anything that would otherwise record the build time (2026-01-01 00:00 UTC).
export SOURCE_DATE_EPOCH=1767225600

# archive|SHA-256|upstream release location. How each hash was checked (FFM1, 29 Oct 2026):
#   ffmpeg: GPG signature by the FFmpeg release signing key FCF986EA15E6E293A5644F10B4322F04D67658D8 (ffmpeg.org).
#   freetype: GPG signature by Werner Lemberg, BE6C3AAC63AD8E3F.
#   fontconfig, dav1d: the SHA-256 files published beside the tarballs (dav1d also GPG, VideoLAN 2018 key).
#   meson: GPG signature by Jussi Pakkanen, 19E2D6D9B46D8DAA6288F877C24E631BABB1FE70.
#   x264, vid.stab, ninja, harfbuzz, pkgconf: no published hash; computed on download from the official location.
#   x264, vid.stab and ninja are forge-generated archives: if the forge ever regenerates them with different bytes,
#   the copy in the source bundle (and in <output dir>/sources) stays the authoritative one.
SOURCES='
ffmpeg-9.0.2.tar.xz|8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e|https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2|6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224|https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2
vid.stab-1.1.2.tar.gz|96db34d48a9e3aa13736a48744b56dfb76731ac9bb5193c716de8534c9fd709d|https://github.com/georgmartius/vid.stab/archive/refs/tags/v1.1.2.tar.gz
dav1d-1.5.4.tar.xz|686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5|https://downloads.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz
freetype-2.15.0.tar.xz|93cd47eb719c325107f2d3cf087d06299e944c3b48a40b55537302304dea1dd5|https://download.savannah.gnu.org/releases/freetype/freetype-2.15.0.tar.xz
harfbuzz-15.0.0.tar.xz|968536e9abd782f07f7954044c0c4020199fcdd39b41d221ec42d2a3be4a44df|https://github.com/harfbuzz/harfbuzz/releases/download/15.0.0/harfbuzz-15.0.0.tar.xz
fontconfig-2.18.3.tar.xz|4f7b554a38cdf78c033f666c8871f3749e14a094f65a07f630c91ed0b43d35e3|https://gitlab.freedesktop.org/api/v4/projects/890/packages/generic/fontconfig/2.18.3/fontconfig-2.18.3.tar.xz
pkgconf-3.0.10.tar.xz|9371b2f6372da574d4c6dc96fe9b1463037bcf6afcb6671c1555afde7b17e2de|https://distfiles.ariadne.space/pkgconf/pkgconf-3.0.10.tar.xz
ninja-1.13.2.tar.gz|974d6b2f4eeefa25625d34da3cb36bdcebe7fbce40f4c16ac0835fd1c0cbae17|https://github.com/ninja-build/ninja/archive/refs/tags/v1.13.2.tar.gz
meson-1.11.2.tar.gz|698feae069cef3ecd4d7aaf281d7df359bdfcf555a9a1564383d3b913fa8a736|https://github.com/mesonbuild/meson/releases/download/1.11.2/meson-1.11.2.tar.gz
'

free_kb=$(/bin/df -k "$TMPDIR" | /usr/bin/awk 'NR==2 {print $4}')
[ "$free_kb" -gt $((8 * 1024 * 1024)) ] || { echo "Need 8 GB free in $TMPDIR to build ffmpeg." >&2; exit 1; }
WORK=$(mktemp -d "${TMPDIR%/}/precut-ffmpeg.XXXXXX")
WORK=$(cd "$WORK" && pwd -P)
if [ -z "$PRECUT_FFMPEG_KEEP" ]; then trap 'rm -rf "$WORK"' EXIT; else echo "Keeping $WORK"; fi
mkdir -p "$WORK/src" "$WORK/stage" "$WORK/tools/bin" "$WORK/logs"
started=$(date +%s)

# 1. Sources: present and pinned, or fetched from upstream and pinned.
while IFS='|' read -r archive sum url; do
  [ -n "$archive" ] || continue
  if [ ! -f "$SOURCES_DIR/$archive" ]; then
    [ "$OFFLINE" = 0 ] || { echo "Missing $SOURCES_DIR/$archive (offline)." >&2; exit 1; }
    echo "Downloading $archive"
    /usr/bin/curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "$url" -o "$WORK/download"
    echo "$sum  $WORK/download" | /usr/bin/shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch: $url" >&2; exit 1; }
    mv "$WORK/download" "$SOURCES_DIR/$archive"
  fi
  echo "$sum  $SOURCES_DIR/$archive" | /usr/bin/shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch: $SOURCES_DIR/$archive" >&2; exit 1; }
  /usr/bin/tar -xf "$SOURCES_DIR/$archive" -C "$WORK/src"
done <<< "$SOURCES"

# 2. Toolchain. Everything installs under a prefix that never exists on disk (/opt/precut-ffmpeg) and is staged
# with DESTDIR, so no build path ends up in a library or in the binaries.
PREFIX=/opt/precut-ffmpeg
STAGE="$WORK/stage"
TOOLS="$WORK/tools"
JOBS=$(/usr/sbin/sysctl -n hw.ncpu)
SDK=$(/usr/bin/xcrun --show-sdk-path)
export PATH="$TOOLS/bin:$PATH"
export CC=/usr/bin/clang CXX=/usr/bin/clang++ SDKROOT="$SDK"
export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS" ZERO_AR_DATE=1
export PKG_CONFIG="$TOOLS/bin/pkg-config" PKG_CONFIG_LIBDIR="$STAGE$PREFIX/lib/pkgconfig" PKG_CONFIG_SYSROOT_DIR="$STAGE"
MAP="-ffile-prefix-map=$WORK=/precut-ffmpeg-build"
log() { echo "== $1"; }
run() { local name=$1; shift; "$@" >>"$WORK/logs/$name.log" 2>&1 || { echo "Failed: $name (log follows)" >&2; tail -n 60 "$WORK/logs/$name.log" >&2; exit 1; }; }

log 'pkgconf 3.0.10 (build tool)'
cd "$WORK/src/pkgconf-3.0.10"
run pkgconf ./configure --prefix="$TOOLS" --disable-shared --enable-static CFLAGS=-O2 \
  --with-pkg-config-dir="$STAGE$PREFIX/lib/pkgconfig" --with-system-libdir=/usr/lib --with-system-includedir=/usr/include
run pkgconf make -j"$JOBS"
run pkgconf make install
ln -sf pkgconf "$TOOLS/bin/pkg-config"

log 'ninja 1.13.2 (build tool)'
cd "$WORK/src/ninja-1.13.2"
run ninja /usr/bin/python3 -I configure.py --bootstrap
install -m 755 ninja "$TOOLS/bin/ninja"

log 'meson 1.11.2 (build tool, run from source)'
printf '#!/bin/sh\nexec /usr/bin/python3 -I "%s/src/meson-1.11.2/meson.py" "$@"\n' "$WORK" > "$TOOLS/bin/meson"
chmod 755 "$TOOLS/bin/meson"

log 'FreeType 2.15.0'
cd "$WORK/src/freetype-2.15.0"
# Its own zlib inflate copy, no PNG/Brotli/HarfBuzz: no extra libraries to link. The experimental HVF driver stays
# off (it links Apple's libhvf, present only in macOS 15.4+ SDKs, so the binary would depend on the SDK version).
run freetype ./configure --prefix="$PREFIX" --enable-static --disable-shared CFLAGS="-O2 $MAP" \
  --without-zlib --without-bzip2 --without-png --without-brotli --without-harfbuzz --without-librsvg \
  ac_cv_header_hvf_Scaler_h=no
run freetype make -j"$JOBS"
run freetype make install DESTDIR="$STAGE"

log 'HarfBuzz 15.0.0'
cd "$WORK/src/harfbuzz-15.0.0"
CFLAGS="$MAP" CXXFLAGS="$MAP" run harfbuzz meson setup build --prefix="$PREFIX" --buildtype=release --default-library=static \
  --wrap-mode=nodownload -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled \
  -Dpng=disabled -Dzlib=disabled -Dicu=disabled -Dgraphite2=disabled -Dcoretext=disabled -Draster=disabled \
  -Dvector=disabled -Dgpu=disabled -Dgpu_demo=disabled -Dsubset=disabled -Dtests=disabled -Dintrospection=disabled \
  -Ddocs=disabled -Dutilities=disabled -Dbenchmark=disabled
run harfbuzz ninja -C build -j"$JOBS"
run harfbuzz meson install -C build --destdir "$STAGE"

log 'Fontconfig 2.18.3'
cd "$WORK/src/fontconfig-2.18.3"
# Expat is Apple's system copy (/usr/lib/libexpat.1.dylib, headers in the SDK). Default font folders are the
# macOS ones (/System/Library/Fonts, /Library/Fonts, ~/Library/Fonts and the font assets).
run fontconfig ./configure --prefix="$PREFIX" --sysconfdir="$PREFIX/etc" --localstatedir="$PREFIX/var" \
  --enable-static --disable-shared --disable-docs --disable-cache-build --disable-nls --disable-rpath CFLAGS="-O2 $MAP"
run fontconfig make -j"$JOBS"
run fontconfig make install DESTDIR="$STAGE"

log 'dav1d 1.5.4'
cd "$WORK/src/dav1d-1.5.4"
CFLAGS="$MAP" ASFLAGS="$MAP" run dav1d meson setup build --prefix="$PREFIX" --buildtype=release --default-library=static \
  -Denable_tools=false -Denable_tests=false -Denable_examples=false -Denable_docs=false -Dxxhash_muxer=disabled
run dav1d ninja -C build -j"$JOBS"
run dav1d meson install -C build --destdir "$STAGE"

log 'vid.stab 1.1.2'
cd "$WORK/src/vid.stab-1.1.2"
# Its CMakeLists, done by hand so the build needs no CMake: the Release flags, the flags it adds for Apple
# silicon, no OpenMP (Apple clang has none), the same eleven sources and the same pkg-config file.
objects=()
for name in frameinfo transformtype libvidstab transform transformfixedpoint motiondetect motiondetect_opt serialize \
  localmotion2transform boxblur vsvector; do
  run vidstab "$CC" -std=gnu99 -O3 -DNDEBUG -Wall -Wno-pointer-sign -fPIC -march=armv8-a+fp+simd+crypto+crc \
    -mmacosx-version-min="$MIN_MACOS" "$MAP" -c "src/$name.c" -o "src/$name.o"
  objects+=("src/$name.o")
done
mkdir -p "$STAGE$PREFIX/lib/pkgconfig" "$STAGE$PREFIX/include/vid.stab"
run vidstab /usr/bin/libtool -static -o "$STAGE$PREFIX/lib/libvidstab.a" "${objects[@]}"
install -m 644 src/*.h "$STAGE$PREFIX/include/vid.stab/"
cat > "$STAGE$PREFIX/lib/pkgconfig/vidstab.pc" <<PC
# file generated by vid.stab cmake build
prefix=$PREFIX
libdir=$PREFIX/lib
includedir=$PREFIX/include

Name: vidstab
Description: Vid.Stab, a library for stabilizing video clips
Version: 1.20
Libs: -L\${libdir} -lvidstab -lm
Cflags: -I\${includedir}

PC

log 'x264 (stable, b35605ac)'
cd "$WORK/src/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
CFLAGS="$MAP" run x264 ./configure --prefix="$PREFIX" --enable-static --disable-cli --disable-opencl \
  --disable-lavf --disable-swscale --disable-ffms --disable-gpac --disable-lsmash
run x264 make -j"$JOBS"
run x264 make install-lib-static DESTDIR="$STAGE"

log "FFmpeg $FFMPEG_VERSION"
cd "$WORK/src/ffmpeg-$FFMPEG_VERSION"
# Every external library is named: x264 (proxies, exports, reverse, backgrounds, editors, photos), vid.stab
# (motion.ts), FreeType + HarfBuzz + Fontconfig (drawtext with a system font), dav1d (AV1 sources). Apple's
# VideoToolbox, AudioToolbox and AVFoundation (recording) come from the SDK. Metal, SDL, X11 and LZMA stay off
# so the result does not depend on what else is installed on the build Mac. --disable-debug: with -g, ld hashes
# the object files' build paths into the executable's LC_UUID, and the build would differ from folder to folder.
# -Wl,-reproducible -Wl,-x: Apple's linker otherwise let the LC_UUID vary now and then between identical builds
# (1 build in 6 on 29 Oct); the local symbols it hashed are stripped from the shipped binaries anyway.
FFMPEG_CONFIGURE=(--prefix="$PREFIX" --cc=clang --cxx=clang++ --arch=aarch64 --pkg-config=pkg-config
  --pkg-config-flags=--static --enable-gpl --disable-shared --enable-static --disable-ffplay --disable-doc --disable-debug
  --enable-videotoolbox --enable-audiotoolbox --enable-avfoundation --disable-metal --disable-sdl2 --disable-xlib
  --disable-libxcb --disable-lzma --enable-libx264 --enable-libvidstab --enable-libfreetype --enable-libharfbuzz
  --enable-libfontconfig --enable-libdav1d --extra-ldflags='-Wl,-reproducible -Wl,-x')
run ffmpeg ./configure "${FFMPEG_CONFIGURE[@]}"
run ffmpeg make -j"$JOBS" ffmpeg ffprobe

# 3. Checks: arm64, Apple system libraries only, GPL without nonfree, and everything precut calls is present.
log 'Checks'
BIN="$WORK/bin"; mkdir -p "$BIN"
install -m 755 ffmpeg ffprobe "$BIN/"
fail() { echo "Check failed: $1" >&2; exit 1; }
for name in ffmpeg ffprobe; do
  /usr/bin/lipo "$BIN/$name" -verify_arch arm64 || fail "$name is not arm64"
  if /usr/bin/otool -L "$BIN/$name" | tail -n +2 | /usr/bin/awk '{print $1}' | /usr/bin/grep -Ev '^(/System/Library/|/usr/lib/)'; then
    fail "non-system library in $name"
  fi
done
ff() { "$BIN/ffmpeg" -hide_banner "$@" 2>&1; }
ff -buildconf | /usr/bin/grep -q -- '--enable-nonfree' && fail 'nonfree'
ff -L | /usr/bin/grep -q 'either version 2 of the License, or' || fail 'licence is not GPL version 2 or later'
want() { local kind=$1 list; shift; list=$(ff "-$kind"); for n; do echo "$list" | /usr/bin/grep -qE "^ *[A-Z.|]+ +([^ ]*,)?$n(,[^ ]*)?( |$)" || fail "$kind: $n"; done; }
want encoders libx264 h264_videotoolbox prores_ks ffv1 qtrle png mjpeg rawvideo aac pcm_s16le pcm_s24le pcm_f32le flac
want decoders libdav1d h264 hevc prores aac mp3 opus vorbis flac alac png mjpeg webp
want filters vidstabdetect vidstabtransform drawtext arnndn lut3d loudnorm sidechaincompress xfade zoompan
want muxers mp4 mov matroska nut wav null rawvideo f32le s16le
want demuxers concat mov matroska nut wav mp3 ogg image2
ff -devices | /usr/bin/grep -qE 'D +avfoundation' || fail 'avfoundation input'
ff -devices | /usr/bin/grep -qE 'D +lavfi' || fail 'lavfi input'
ff -hwaccels | /usr/bin/grep -qx 'videotoolbox' || fail 'videotoolbox hwaccel'
# drawtext with no font file must find a system font through Fontconfig, as judge.ts asks it to.
ff -v error -f lavfi -i color=c=black:s=64x32:d=0.04 -vf "drawtext=text='Aa':fontsize=20:fontcolor=white" \
  -frames:v 1 -f null - >/dev/null || fail 'drawtext without a font file'
ff -v error -f lavfi -i testsrc2=s=160x90:d=0.4 -vf vidstabdetect=result=/dev/null:fileformat=ascii -c:v libx264 \
  -f null - >/dev/null || fail 'vidstabdetect + libx264'

# 4. Record what went in and what came out.
cd "$WORK"
{
  echo "precut ffmpeg build (scripts/build-ffmpeg.sh, FFM1)"
  echo "script $(/usr/bin/shasum -a 256 "$SCRIPT" | /usr/bin/awk '{print $1}')"
  echo "ffmpeg $FFMPEG_VERSION"
  echo "clang $("$CC" --version | head -n 1)"
  echo "sdk $(/usr/bin/xcrun --show-sdk-version) $(/usr/bin/xcrun --show-sdk-build-version 2>/dev/null || true)"
  echo "macos-min $MIN_MACOS"
  echo "configure ${FFMPEG_CONFIGURE[*]}"
  while IFS='|' read -r archive sum url; do [ -n "$archive" ] && echo "source $archive $sum $url"; done <<< "$SOURCES"
  for name in ffmpeg ffprobe; do echo "output $name $(/usr/bin/shasum -a 256 "$BIN/$name" | /usr/bin/awk '{print $1}')"; done
} > "$WORK/BUILDINFO.txt"

# 5. The source bundle: every archive above, this script and BUILDINFO.txt (no patches are applied).
BUNDLE="ffmpeg-source-$FFMPEG_VERSION"
mkdir -p "$WORK/bundle/$BUNDLE/sources"
while IFS='|' read -r archive sum url; do
  [ -n "$archive" ] && cp "$SOURCES_DIR/$archive" "$WORK/bundle/$BUNDLE/sources/"
done <<< "$SOURCES"
install -m 755 "$SCRIPT" "$WORK/bundle/$BUNDLE/build-ffmpeg.sh"
install -m 644 "$WORK/BUILDINFO.txt" "$WORK/bundle/$BUNDLE/BUILDINFO.txt"
cat > "$WORK/bundle/$BUNDLE/README.txt" <<TXT
Complete corresponding source for the ffmpeg and ffprobe programs shipped with precut.

ffmpeg $FFMPEG_VERSION, built for Apple silicon with x264, vid.stab, dav1d, FreeType, HarfBuzz and Fontconfig.
Taken as a whole the two programs are licensed under the GNU General Public License, version 2 or later. The
licence texts are inside the archives in sources/ (FFmpeg: COPYING.GPLv2, LICENSE.md; x264: COPYING; vid.stab:
LICENSE), and each library keeps its own licence. pkgconf, ninja and meson are build tools, included so the
build needs no network.

To rebuild on an Apple silicon Mac with the Xcode command line tools:

    bash build-ffmpeg.sh --offline

The programs land in out/. BUILDINFO.txt lists every archive with its SHA-256 and upstream location, the clang
and SDK versions used, the FFmpeg configure flags and the SHA-256 of the released ffmpeg and ffprobe. With the
same command line tools the rebuild is byte-identical to them. No patches are applied to any source.
TXT
/usr/bin/python3 -I - "$WORK/bundle" "$BUNDLE" "$WORK/$BUNDLE.tar.gz" "$SOURCE_DATE_EPOCH" <<'PY'
import gzip, os, sys, tarfile
root, top, out, epoch = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
paths = []
for folder, dirs, files in os.walk(os.path.join(root, top)):
    dirs.sort()
    paths.append(folder)
    paths.extend(os.path.join(folder, name) for name in sorted(files))
with open(out, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz, \
        tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tar:
    for path in paths:
        info = tar.gettarinfo(path, os.path.relpath(path, root))
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mtime = epoch
        info.mode = 0o755 if info.isdir() or os.access(path, os.X_OK) else 0o644
        if info.isfile():
            with open(path, "rb") as handle:
                tar.addfile(info, handle)
        else:
            tar.addfile(info)
PY

# 6. Publish into the output dir only once everything above has passed.
for name in ffmpeg ffprobe; do install -m 755 "$BIN/$name" "$OUT/$name.tmp"; mv "$OUT/$name.tmp" "$OUT/$name"; done
install -m 644 "$WORK/$BUNDLE.tar.gz" "$OUT/$BUNDLE.tar.gz"
install -m 644 "$WORK/BUILDINFO.txt" "$OUT/BUILDINFO.txt"
echo "Built in $(( $(date +%s) - started )) s:"
/usr/bin/grep '^output ' "$OUT/BUILDINFO.txt"
echo "Source bundle: $OUT/$BUNDLE.tar.gz ($(/usr/bin/shasum -a 256 "$OUT/$BUNDLE.tar.gz" | /usr/bin/awk '{print $1}'))"
