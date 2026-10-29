# Tools shipped beside precut

Run `npm run fetch-tools` on an arm64 macOS build host with Xcode command line
tools. `npm run dist` runs it automatically. Nothing is fetched at app launch.
The script fails on download, checksum, architecture, dependency or filter errors.
The tools are separate programs, invoked with argument arrays by precut (AGPL-3.0-only).
They are copied to `Contents/Resources/tools`, outside the app's ASAR archive.
Do not substitute a Homebrew build: those depend on libraries on the build Mac.

| Program | Pinned version | Upstream / source | Licence |
| --- | --- | --- | --- |
| ffmpeg, ffprobe | 9.0.2, built by precut from source (`scripts/build-ffmpeg.sh`) | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz ; every library and its pin in `scripts/build-ffmpeg.sh` | GPL version 2 or later (`ffmpeg -L`); includes x264 and vid.stab (GPL); separate executables |
| uv | 0.12.20, aarch64-apple-darwin | https://github.com/astral-sh/uv/releases/tag/0.12.20 ; https://github.com/astral-sh/uv/tree/0.12.20 | MIT or Apache-2.0 |
| ExifTool | 13.59, original Perl distribution | https://sourceforge.net/projects/exiftool/files/Image-ExifTool-13.59.tar.gz/download ; https://exiftool.org/ | Same terms as Perl: Artistic or GPL |
| subject, matte, voice, record-words, smart-frames, quality, place, power-watch, screen-read, apple-player, apple-player.node | This release's `pipeline/*.swift` and `pipeline/apple-addon.c`, compiled by `scripts/fetch-tools.sh` and `scripts/build-apple-player.sh` (macOS 13 target) | Included in precut source | AGPL-3.0-only, as precut |

Archive SHA-256 pins are in `scripts/fetch-tools.sh` (uv, ExifTool) and
`scripts/build-ffmpeg.sh` (FFmpeg and every library it links). `SHA256SUMS`
records local Swift source, built binary and FFmpeg source bundle hashes for every
program above. `node scripts/check-bundle.mjs <precut.app>` (run by `scripts/release-mac.sh`)
refuses a bundle missing any helper the app spawns: it reads every `tool("...")` call
and `tools/...` path in `src/main` and `pipeline`, so the list can't drift. ExifTool retains its Perl libraries and upstream documentation; its
interpreter line is changed to `/usr/bin/perl`, provided by macOS. No installer,
Homebrew, npm, Python or Swift compiler runs on the customer's behalf at launch.

FFmpeg is precut's own build (FFM1). `scripts/build-ffmpeg.sh` builds ffmpeg and
ffprobe for arm64 from pinned tarballs: FFmpeg 9.0.2, x264 (stable branch,
b35605ac), vid.stab 1.1.2, dav1d 1.5.4, FreeType 2.15.0, HarfBuzz 15.0.0 and
Fontconfig 2.18.3, with pkgconf, ninja and meson built from their own pinned
sources as build tools. It needs only the Xcode command line tools: no Homebrew,
CMake or sudo. The libraries are linked statically; the binaries link only to
Apple's system libraries and frameworks (VideoToolbox, AudioToolbox, AVFoundation,
libz, libbz2, libiconv, libexpat). It is GPL without nonfree parts. The script
asserts what precut calls: libx264, h264_videotoolbox, prores_ks, ffv1, qtrle,
`vidstabdetect`, `drawtext` with a system font, `arnndn`, `lut3d`, the
avfoundation and lavfi inputs and the videotoolbox hwaccel.
`npm run fetch-tools` runs it once (about 4 minutes) into `dist.noindex/ffmpeg/`
and reuses that build while its `BUILDINFO.txt` names the same script.

The same run writes `ffmpeg-source-9.0.2.tar.gz`: every source tarball, the
script and `BUILDINFO.txt` (versions, SHA-256s, toolchain, configure flags and
the binaries' SHA-256). It is the GPL complete corresponding source; every
release attaches it beside the DMG (`docs/RELEASING.md`). It rebuilds offline
with `bash build-ffmpeg.sh --offline`, byte-identical with the same Xcode
command line tools. No patches are applied.

Python 3.12 and the packages are downloaded only after **Set up precut** is
pressed. uv's managed Python, venv and requirements live in
`~/Library/Application Support/precut`, and Python's caches in its `py-cache`
folder (not `cache`, which on APFS is the same folder as Chromium's `Cache`).
Every package is pinned with its hashes in `pipeline/requirements.txt` and
installed with `uv pip sync --require-hashes` (wheels only, so a compiler is
never needed): every Mac gets the stack precut is tested on. The speech model,
`mlx-community/whisper-large-v3-turbo` at revision
`a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb`, is about 1.6 GB and downloads with
the first shoot. Claude Code is the single exception to the app-owned install
location: its official native installer manages `~/.local/bin/claude`.
