# precut

A pre-editor for reels, made by sidething. Point it at a shoot folder. It tags your clips, syncs a separate mic, finds ideas, and cuts precuts and selects for DaVinci Resolve. You choose what to keep and finish the edit in Resolve.

It runs on your own Claude Code subscription. Your footage, audio, frames and working files stay on your Mac. Claude Code sends the prompts and the context it needs to Claude to make its judgements. This is not an offline AI app.

## What you need

- macOS on Apple silicon.
- Claude Code installed and signed in on your subscription. Run `claude` in Terminal to check.
- ffmpeg, including ffprobe.
- Python 3.11 or newer, available as `python3`.
- Xcode command line tools, including the Swift compiler. Install them with `xcode-select --install`.
- exiftool, which the pipeline uses to read camera metadata.

If you use Homebrew, `brew install ffmpeg python@3.11 exiftool` installs the system tools. Make sure `python3 --version` reports 3.11 or newer in your login shell. On the first shoot, sidething creates its own Python environment in Application Support and downloads the processing packages and speech model. That first setup needs an internet connection.

## Install the app

Open `precut.dmg` and drag precut into Applications. The app is unsigned and is not notarised. The first time, right-click the app in Finder and choose Open, then confirm Open. If macOS still blocks it, open System Settings, Privacy & Security, and choose Open Anyway for precut.

Open the app and pick your shoot folder. Keep the drive connected while it works. sidething reads the tools from your login shell, so the same ffmpeg, Python and Claude Code you use in Terminal are available when you open it from Finder.

## Run from source

Install the tools above and Node.js 22 or newer. From the project folder:

```sh
npm ci
npm run dev
```

To check and build the app:

```sh
npm run typecheck
npm run build
```

To build the unsigned Apple silicon DMG on a Mac:

```sh
npm run dist
```

The installer is written to `dist/precut.dmg`. Pipeline scripts and prompts travel with the app. The subject detector is compiled with your Mac's Swift compiler on first use and cached in Application Support.

## Your originals

sidething never writes to your original footage or audio. It keeps its index, frames, proxies and analysis in a `.sidething` folder inside the shoot folder. Precuts and Resolve exports are separate files. Your camera files stay as they were.

## Licence

MIT. See [LICENSE](LICENSE).
