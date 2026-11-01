# Third-party notices

precut, by sidething. Version 0.8.0 and later.

precut's own source code is free software under the GNU Affero General Public License version 3 only (SPDX: `AGPL-3.0-only`). The full text is `AGPL-3.0.txt` beside this file and `LICENSE` in the source. The source is at https://github.com/alimzysworld/precut.

precut ships, or downloads when you ask it to, the third-party software and content below. Each keeps its own licence. Nothing here changes those licences, and the AGPL does not apply to them. The programs in `Contents/Resources/tools` are separate programs that precut runs as child processes: they are aggregated with precut, not linked into it.

## Where the licence texts are

Every licence named here requires its text, or its copyright and permission notice, to travel with the program. They are all in the app, in `precut.app/Contents/Resources/licenses/`, and you can read them in precut under Settings, About, Licences:

- this file, `THIRD-PARTY-NOTICES.md`;
- `AGPL-3.0.txt`, `GPL-1.0.txt`, `GPL-2.0.txt`, `GPL-3.0.txt`, `LGPL-2.1.txt`, `MPL-2.0.txt`, `Apache-2.0.txt`, `OFL-1.1.txt`, `Artistic-1.0-Perl.txt` and `CC0-1.0.txt`, each the official text;
- `electron-LICENSE.txt` and `LICENSES.chromium.html`, copied from Electron's distribution at build time;
- `uv-LICENSE-MIT.txt` and `uv-LICENSE-APACHE.txt` (uv), `RNNoise-LICENSE.txt` (the voice model), `Kenney-impact-LICENSE.txt`, `Kenney-interface-LICENSE.txt` and `Kenney-casino-LICENSE.txt` (sound effects);
- `npm-packages.txt`: every JavaScript package in the app with its own licence file, unchanged.

The same texts are in the source under `resources/licenses/`. The seven font licences are also embedded, unchanged, at the top of `out/main/titles/template.html` inside `app.asar`.

## 1. Programs shipped beside precut

These are in `precut.app/Contents/Resources/tools`, outside `app.asar`.

### FFmpeg (ffmpeg, ffprobe)

- Version 9.0.2, built by precut for Apple silicon from source with `scripts/build-ffmpeg.sh`. Source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- Copyright (c) 2000-2026 the FFmpeg developers.
- Licence: `GPL-2.0-or-later`. The build is configured with `--enable-gpl` and without `--enable-nonfree`, so the binaries as a whole are under the GPL version 2 or later. `GPL-2.0.txt` and `GPL-3.0.txt` travel with them.
- Libraries linked statically into ffmpeg and ffprobe (exact versions and SHA-256s in the source bundle's `BUILDINFO.txt`):

| Library | Version | Licence |
| --- | --- | --- |
| x264 | stable branch, commit b35605ac | GPL-2.0-or-later |
| vid.stab | 1.1.2 | GPL-2.0-or-later |
| dav1d | 1.5.4 | BSD-2-Clause |
| FreeType | 2.15.0 | FTL or GPL-2.0-or-later (FTL used here) |
| HarfBuzz | 15.0.0 | MIT ("Old MIT") |
| Fontconfig | 2.18.3 | MIT-style (Fontconfig licence) |

FreeType, as its licence (FTL) asks: Portions of this software are copyright © 2026 The FreeType Project (www.freetype.org). All rights reserved.

pkgconf, ninja and meson are built from their own pinned sources to build FFmpeg; they are not shipped. zlib, bzip2, libiconv, expat and Apple's VideoToolbox, AudioToolbox and AVFoundation are macOS's own system copies, dynamically linked, and not distributed by precut.

#### Getting the FFmpeg source

You are entitled to the complete corresponding source of these FFmpeg binaries. Because the licence is "version 2 or later", precut distributes them under the terms of GPL version 3, section 6(d): the corresponding source is offered from the same place as the binary, at no charge.

Every precut release on https://github.com/alimzysworld/precut/releases carries `ffmpeg-source-9.0.2.tar.gz` beside the DMG: the FFmpeg source tarball byte for byte as upstream published it, the source of every library above at the version actually linked, the build script and `BUILDINFO.txt` (versions, SHA-256s, toolchain, configure flags and the SHA-256 of the released binaries). It rebuilds offline with `bash build-ffmpeg.sh --offline`. The source bundle stays on the Releases page of every release that shipped these binaries, for as long as that release is offered: https://github.com/alimzysworld/precut/releases

### uv

- Version 0.12.20, aarch64-apple-darwin. Source: https://github.com/astral-sh/uv/tree/0.12.20 ; binary https://github.com/astral-sh/uv/releases/tag/0.12.20
- Copyright (c) Astral Software Inc.
- Licence: `MIT OR Apache-2.0`. Both texts travel with it (`uv-LICENSE-MIT.txt`, `uv-LICENSE-APACHE.txt`). uv's own Rust dependencies are listed in its repository at that tag.

### ExifTool

- Version 13.59, the original Perl distribution. Source: https://exiftool.org/ ; https://sourceforge.net/projects/exiftool/files/Image-ExifTool-13.59.tar.gz/download
- Copyright 2003-2026, Phil Harvey.
- Licence: the same terms as Perl itself, `Artistic-1.0-Perl OR GPL-1.0-or-later`. precut redistributes it under the GPL option. Both texts travel with it.
- Modification: precut's build changes the first line of `exiftool/exiftool` to `#!/usr/bin/perl` (see `scripts/fetch-tools.sh`). Nothing else is changed. Its test suite `t/` is left out. ExifTool ships as source, so its source is in the app.

### precut's own helpers

`subject`, `matte`, `voice`, `record-words`, `smart-frames`, `quality`, `place`, `power-watch`, `screen-read`, `apple-player` and `apple-player.node` are compiled from precut's own `pipeline/*.swift` and `pipeline/apple-addon.c`. They are part of precut and under its AGPL licence. `apple-player.node` uses Node-API headers from Node.js (MIT) at build time.

## 2. Bundled data

### RNNoise voice model

- File: `pipeline/models/sh.rnnn` (297,646 bytes, SHA-256 `70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0`), the "somnolent-hogwash" model.
- Source: https://github.com/GregorR/rnnoise-models at `3eee541a283fd3b8f81b85b1748e3b9ccbefa04d`.
- Licence: the upstream project states the weights and training data are not subject to copyright (notice kept in `pipeline/models/UPSTREAM-README.md`). The RNNoise implementation it belongs to is `BSD-3-Clause`: Copyright (c) 2017 Mozilla; (c) 2007-2017 Jean-Marc Valin; (c) 2005-2017 Xiph.Org Foundation; (c) 2003-2004 Mark Borgerding. Full text in `RNNoise-LICENSE.txt`.

### Sound effects

115 sounds in `sfx/`, listed in `sfx/manifest.json`; each one's source page, uploader, licence and our edits are in `sfx/LICENSES.md`, which ends with the CC0 legal code.

- 68 in `sfx/kenney/`, from Kenney's "Impact Sounds" (1.0), "Interface Sounds" (1.0) and "Casino Audio" (1.1), https://kenney.nl. Licence: `CC0-1.0`. Credit is not required; given anyway. Notices in `Kenney-impact-LICENSE.txt`, `Kenney-interface-LICENSE.txt` and `Kenney-casino-LICENSE.txt`.
- 16 in `sfx/freesound/`, from Freesound (https://freesound.org), each marked Creative Commons 0 on its page when downloaded (31 Oct 2026). Licence: `CC0-1.0`. Credit is not required; given anyway, to dslrguide, vckhaze, synthnisse, qubodup, denao270, OwlStorm, unfa, pbimal, jim-ph, Trollarch2, roachpowder, ludvique, tonmayster, LilMati and eyesonlegs.
- 31 made for precut (`sfx/synth/`, `sfx/v3/`), synthesised by precut's own scripts (`scripts/sfx-synth/`). They ship under precut's terms; nothing is owed by the person who uses them. Room tone and the five "soft" sounds are made by precut's own code on your Mac.

### Music

- Four starter tracks in `music/` (source: `build/music/`), each under Creative Commons Attribution 4.0 (`CC BY 4.0`): "Monkeys Spinning Monkeys", "Easy Lemon" and "Carefree" by Kevin MacLeod (incompetech.com), and "With These Hands" by Scott Buckley (www.scottbuckley.com.au). Source pages, credit lines and the CC BY 4.0 legal code are in `music/LICENSES.md`; the credits also show in Settings, About. An export that uses a track writes its credit line beside the video (`Music credit.txt`), ready to paste into the post.

### Sample frames

The sample frames used to preview looks ("Pick your look" and the Look tile) are photos dedicated to the public domain under `CC0-1.0`, from Wikimedia Commons. None shows a person. Each was cropped and resized; nothing else was changed.

- `daylight.jpg`: "Sunny Day on the Seiser Plateau", JiansheRdN, https://commons.wikimedia.org/wiki/File:Sunny_Day_on_the_Seiser_Plateau.jpg
- `warm.jpg`: "Light bulbs in a coffee shop (Unsplash)", Tomas Jasovsky, https://commons.wikimedia.org/wiki/File:Light_bulbs_in_a_coffee_shop_(Unsplash).jpg
- `night.jpg`: "Night Lights (218082587)", Nils Söderman, https://commons.wikimedia.org/wiki/File:Night_Lights_(218082587).jpeg
- `skyline.jpg`: "Taichung skyline at dusk 2017", lb0104672 from Taichung, Taiwan, https://commons.wikimedia.org/wiki/File:Taichung_skyline_at_dusk_2017.jpg

- `night-city.jpg`: "Hong Kong night street", Wilfredor, https://commons.wikimedia.org/wiki/File:Hong_Kong_night_street.jpg. CC0 1.0 Universal Public Domain Dedication, https://creativecommons.org/publicdomain/zero/1.0/. Cropped to the signs and lights, no people. Full dedication: `CC0-1.0.txt`.


Wilfredor's dedication for `night-city.jpg`:

> I, the copyright holder of this work, hereby publish it under the following license:
> This file is made available under the Creative Commons CC0 1.0 Universal Public Domain Dedication. The person who
> associated a work with this deed has dedicated the work to the public domain by waiving all of their rights to the
> work worldwide under copyright law, including all related and neighboring rights, to the extent allowed by law.
> You can copy, modify, distribute and perform the work, even for commercial purposes, all without asking permission.

### Fonts

Embedded in the title template and the app's interface. Each is under the SIL Open Font License 1.1 (`OFL-1.1`), whose text must travel with the fonts: `OFL-1.1.txt`, and embedded in `titles/template.html`. The fonts are packaged by Fontsource (https://fontsource.org), version 5.3.0.

| Font | Copyright | Upstream |
| --- | --- | --- |
| Inter (variable) | Copyright 2016 The Inter Project Authors | https://github.com/rsms/inter |
| Outfit | Copyright 2021 The Outfit Project Authors | https://github.com/Outfitio/Outfit-Fonts |
| Montserrat | Copyright 2011 The Montserrat Project Authors | https://github.com/JulietaUla/Montserrat |
| Poppins | Copyright 2020 The Poppins Project Authors | https://github.com/itfoundry/Poppins |
| Bebas Neue | Copyright 2019 The Bebas Neue Project Authors | https://github.com/dharmatype/Bebas-Neue |
| Archivo Black | Copyright 2017 The Archivo Black Project Authors | https://github.com/Omnibus-Type/ArchivoBlack |
| Caveat | Copyright 2014 The Caveat Project Authors | https://github.com/googlefonts/caveat |
| Instrument Serif | Copyright 2022 The Instrument Serif Project Authors | https://github.com/Instrument/instrument-serif (via @fontsource/instrument-serif 5.3.0, vendored in src/main/titles/fonts/instrument-serif with its licence) |

### precut and sidething marks

The precut app icon (the panda) and the sidething mark are sidething's own artwork. The names "precut" and "sidething" and these marks are not licensed under the AGPL for use as a trademark: a modified version must not use them in a way that suggests it is the official app.

### Icons

Interface icons are Phosphor Icons (`@phosphor-icons/react`, MIT, Copyright (c) 2020 Phosphor Icons). The icons drawn in titles and graphics (`src/main/graphics/icons.ts`) are precut's own.

## 3. Electron runtime

- Electron 35.7.5, https://github.com/electron/electron. Licence: `MIT`. Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. Text in `electron-LICENSE.txt`.
- Chromium and its third-party components, inside `Electron Framework.framework`, under many licences (BSD, MIT, Apache-2.0, LGPL-2.1 including Chromium's own FFmpeg build, MPL-2.0 and others). The complete list and texts are in `LICENSES.chromium.html`.
- Squirrel.Mac, Mantle and ReactiveObjC (the update frameworks Electron bundles), each `MIT`.

## 4. JavaScript packages

electron-builder copies precut's production dependencies (the MCP SDK, electron-updater, node-pty and what they need) into `app.asar`, and electron-vite bundles what the interface imports into `out/renderer`. Every package below ships in one of the two, and each one's own licence file is in `npm-packages.txt`.

Notes on the entries that are not MIT, ISC or BSD:

- `@blocknote/core`, `@blocknote/react` and `@blocknote/mantine` 0.56.0 are under the Mozilla Public License 2.0 (`MPL-2.0.txt`). They are used unmodified, and none carries the "Incompatible With Secondary Licenses" notice, so they may be combined with the AGPL work. Their source code form is at https://github.com/TypeCellOS/BlockNote (tag v0.56.0) and on npm. No BlockNote "xl" packages are used.
- The seven `@fontsource` packages are `OFL-1.1` (see Fonts above).
- `argparse` is under the Python Software Foundation License 2.0, `sax` under the Blue Oak Model License 1.0.0 and `tslib` under `0BSD`; each text is in `npm-packages.txt`.

<!-- npm:start (generated by scripts/notices.mjs) -->

199 packages. Licence counts: MIT 173, ISC 9, OFL-1.1 7, MPL-2.0 3, BSD-3-Clause 2, Python-2.0 1, BSD-2-Clause 1, BlueOak-1.0.0 1, 0BSD 1, (MIT OR CC0-1.0) 1. Each package's full licence file is in `npm-packages.txt`.

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| @babel/runtime | 7.29.10 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors |
| @blocknote/core | 0.56.0 | MPL-2.0 | (c) under Patent Claims infringed by Covered Software in the absence of |
| @blocknote/mantine | 0.56.0 | MPL-2.0 | (c) under Patent Claims infringed by Covered Software in the absence of |
| @blocknote/react | 0.56.0 | MPL-2.0 | (c) under Patent Claims infringed by Covered Software in the absence of |
| @emoji-mart/data | 1.2.1 | MIT | Copyright (c) Missive. |
| @floating-ui/core | 1.8.0 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/dom | 1.8.0 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/react | 0.27.20 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/react-dom | 2.1.9 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/utils | 0.2.12 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @fontsource-variable/inter | 5.3.0 | OFL-1.1 | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| @fontsource/archivo-black | 5.3.0 | OFL-1.1 | Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack) |
| @fontsource/bebas-neue | 5.3.0 | OFL-1.1 | Copyright 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue) |
| @fontsource/caveat | 5.3.0 | OFL-1.1 | Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat) |
| @fontsource/montserrat | 5.3.0 | OFL-1.1 | Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat) Montserrat-Italic[wght].ttf: Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat) |
| @fontsource/outfit | 5.3.0 | OFL-1.1 | Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts) |
| @fontsource/poppins | 5.3.0 | OFL-1.1 | Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ThinItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ExtraLight.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ExtraLightItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Light.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-LightItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Regular.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Italic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Medium.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-MediumItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-SemiBold.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-SemiBoldItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Bold.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-BoldItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ExtraBold.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-ExtraBoldItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-Black.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) Poppins-BlackItalic.ttf: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) |
| @handlewithcare/prosemirror-inputrules | 0.1.4 | MIT | Copyright (c) 2025 Handle with Care Collective |
| @hono/node-server | 2.1.5 | MIT | Copyright (c) 2022 - present, Yusuke Wada and Hono contributors |
| @mantine/core | 8.3.18 | MIT | Copyright (c) 2021 Vitaly Rtishchev |
| @mantine/hooks | 8.3.18 | MIT | Copyright (c) 2021 Vitaly Rtishchev |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | Copyright (c) 2024 Anthropic, PBC |
| @phosphor-icons/react | 2.1.10 | MIT | Copyright (c) 2020 Phosphor Icons |
| @shikijs/types | 4.5.0 | MIT | Copyright (c) 2021 Pine Wu |
| @shikijs/vscode-textmate | 10.0.2 | MIT | Copyright (c) Microsoft Corporation |
| @tiptap/core | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-bold | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-bubble-menu | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-code | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-floating-menu | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-italic | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-strike | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-text | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-underline | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extensions | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/pm | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/react | 3.32.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @types/hast | 3.0.5 | MIT | Copyright (c) Microsoft Corporation. |
| @types/prop-types | 15.7.15 | MIT | Copyright (c) Microsoft Corporation. |
| @types/react | 18.3.31 | MIT | Copyright (c) Microsoft Corporation. |
| @types/react-dom | 18.3.7 | MIT | Copyright (c) Microsoft Corporation. |
| @types/unist | 3.0.3 | MIT | Copyright (c) Microsoft Corporation. |
| @types/use-sync-external-store | 0.0.6 | MIT | Copyright (c) Microsoft Corporation. |
| @types/use-sync-external-store | 1.5.0 | MIT | Copyright (c) Microsoft Corporation. |
| @xterm/addon-fit | 0.11.0 | MIT | Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js) |
| @xterm/xterm | 6.0.0 | MIT | Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js) |
| accepts | 2.0.0 | MIT | Copyright (c) 2014 Jonathan Ong |
| ajv | 8.20.0 | MIT | Copyright (c) 2015-2021 Evgeny Poberezkin |
| ajv-formats | 3.0.1 | MIT | Copyright (c) 2020 Evgeny Poberezkin |
| argparse | 2.0.1 | Python-2.0 | Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam, |
| body-parser | 2.3.0 | MIT | Copyright (c) 2014 Jonathan Ong |
| builder-util-runtime | 9.7.0 | MIT | Copyright (c) 2015 Loopline Systems |
| bytes | 3.1.2 | MIT | Copyright (c) 2012-2014 TJ Holowaychuk |
| call-bind-apply-helpers | 1.0.2 | MIT | Copyright (c) 2024 Jordan Harband |
| call-bound | 1.0.4 | MIT | Copyright (c) 2024 Jordan Harband |
| clsx | 2.1.1 | MIT | Copyright (c) Luke Edwards (lukeed.com) |
| content-disposition | 2.0.1 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| content-type | 1.0.5 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| content-type | 2.1.0 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| cookie | 0.7.2 | MIT | Copyright (c) 2012-2014 Roman Shtylman |
| cookie-signature | 1.2.2 | MIT | Copyright (c) 2012–2024 LearnBoost and other contributors; |
| cors | 2.8.6 | MIT | Copyright (c) 2013 Troy Goode |
| cross-spawn | 7.0.6 | MIT | Copyright (c) 2018 Made With MOXY Lda |
| csstype | 3.2.3 | MIT | Copyright (c) 2017-2018 Fredrik Nicol |
| debug | 4.4.3 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk |
| depd | 2.0.0 | MIT | Copyright (c) 2014-2018 Douglas Christopher Wilson |
| detect-node-es | 1.1.0 | MIT | Copyright (c) 2017 Ilya Kantor |
| dunder-proto | 1.0.1 | MIT | Copyright (c) 2024 ECMAScript Shims |
| ee-first | 1.1.1 | MIT | Copyright (c) 2014 Jonathan Ong |
| electron-updater | 6.8.10 | MIT | Copyright (c) 2015 Loopline Systems |
| emoji-mart | 5.6.0 | MIT | Copyright (c) Missive. |
| encodeurl | 2.0.0 | MIT | Copyright (c) 2016 Douglas Christopher Wilson |
| es-define-property | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| es-errors | 1.3.0 | MIT | Copyright (c) 2024 Jordan Harband |
| es-object-atoms | 1.1.2 | MIT | Copyright (c) 2024 Jordan Harband |
| escape-html | 1.0.3 | MIT | Copyright (c) 2012-2013 TJ Holowaychuk |
| etag | 1.8.1 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson |
| eventsource | 3.0.7 | MIT | Copyright (c) EventSource GitHub organisation |
| eventsource-parser | 3.1.1 | MIT | Copyright (c) 2026 Espen Hovlandsdal |
| express | 5.3.0 | MIT | Copyright (c) 2009-2014 TJ Holowaychuk |
| express-rate-limit | 8.7.1 | MIT | Copyright 2023 Nathan Friedly, Vedant K |
| fast-deep-equal | 3.1.3 | MIT | Copyright (c) 2017 Evgeny Poberezkin |
| fast-equals | 5.4.5 | MIT | Copyright (c) 2025 Tony Quetano |
| fast-uri | 3.1.8 | BSD-3-Clause | Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae |
| finalhandler | 2.1.1 | MIT | Copyright (c) 2014-2022 Douglas Christopher Wilson |
| forwarded | 0.2.0 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| framer-motion | 12.43.0 | MIT | Copyright (c) 2018 Framer B.V. |
| fresh | 2.0.0 | MIT | Copyright (c) 2012 TJ Holowaychuk |
| fs-extra | 10.1.0 | MIT | Copyright (c) 2011-2017 JP Richardson |
| function-bind | 1.1.2 | MIT | Copyright (c) 2013 Raynos. |
| get-intrinsic | 1.3.0 | MIT | Copyright (c) 2020 Jordan Harband |
| get-nonce | 1.0.1 | MIT | Copyright (c) 2020 Anton Korzunov |
| get-proto | 1.0.1 | MIT | Copyright (c) 2025 Jordan Harband |
| gopd | 1.2.0 | MIT | Copyright (c) 2022 Jordan Harband |
| graceful-fs | 4.2.11 | ISC | Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors |
| has-symbols | 1.1.0 | MIT | Copyright (c) 2016 Jordan Harband |
| hasown | 2.0.4 | MIT | Copyright (c) Jordan Harband and contributors |
| hono | 4.13.13 | MIT | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors |
| http-errors | 2.0.1 | MIT | Copyright (c) 2014 Jonathan Ong |
| iconv-lite | 0.7.3 | MIT | Copyright (c) 2011 Alexander Shtuchkin |
| inherits | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter |
| ip-address | 10.7.4 | MIT | Copyright (C) 2011 by Beau Gunderson |
| ipaddr.js | 1.9.1 | MIT | Copyright (C) 2011-2017 whitequark |
| is-promise | 4.0.0 | MIT | Copyright (c) 2014 Forbes Lindesay |
| isexe | 2.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| jose | 6.2.12 | MIT | Copyright (c) 2018 Filip Skokan |
| js-tokens | 4.0.0 | MIT | Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell |
| js-yaml | 4.3.2 | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin |
| json-schema-traverse | 1.0.0 | MIT | Copyright (c) 2017 Evgeny Poberezkin |
| json-schema-typed | 8.0.2 | BSD-2-Clause | see licence file |
| jsonfile | 6.2.1 | MIT | Copyright (c) 2012-2015, JP Richardson |
| lazy-val | 1.0.5 | MIT | no licence file in package |
| lib0 | 1.0.0-rc.36 | MIT | Copyright (c) 2019 Kevin Jahns . |
| lodash.escaperegexp | 4.1.2 | MIT | see licence file |
| lodash.isequal | 4.5.0 | MIT | see licence file |
| loose-envify | 1.4.0 | MIT | Copyright (c) 2015 Andres Suarez |
| math-intrinsics | 1.1.0 | MIT | Copyright (c) 2024 ECMAScript Shims |
| media-typer | 1.1.1 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| merge-descriptors | 2.0.0 | MIT | Copyright (c) Jonathan Ong |
| mime-db | 1.54.0 | MIT | Copyright (c) 2014 Jonathan Ong |
| mime-types | 3.0.2 | MIT | Copyright (c) 2014 Jonathan Ong |
| motion-dom | 12.43.0 | MIT | Copyright (c) 2024 [Motion](https://motion.dev) B.V. |
| motion-utils | 12.39.0 | MIT | Copyright (c) 2024 [Motion](https://motion.dev) B.V. |
| ms | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. |
| negotiator | 1.1.0 | MIT | Copyright (c) 2012-2014 Federico Romero |
| node-addon-api | 7.1.1 | MIT | Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators) |
| node-pty | 1.1.0 | MIT | Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/) |
| object-assign | 4.1.1 | MIT | Copyright (c) Sindre Sorhus (sindresorhus.com) |
| object-inspect | 1.13.4 | MIT | Copyright (c) 2013 James Halliday |
| on-finished | 2.4.1 | MIT | Copyright (c) 2013 Jonathan Ong |
| once | 1.4.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| orderedmap | 2.1.1 | MIT | Copyright (C) 2016 by Marijn Haverbeke and others |
| parseurl | 1.3.3 | MIT | Copyright (c) 2014 Jonathan Ong |
| path-key | 3.1.1 | MIT | Copyright (c) Sindre Sorhus (sindresorhus.com) |
| path-to-regexp | 8.4.2 | MIT | Copyright (c) 2014 Blake Embrey |
| pkce-challenge | 5.0.1 | MIT | Copyright (c) 2019 |
| prosemirror-changeset | 2.4.4 | MIT | Copyright (C) 2017 by Marijn Haverbeke and others |
| prosemirror-commands | 1.7.2 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-dropcursor | 1.8.4 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-gapcursor | 1.4.1 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-highlight | 0.15.3 | MIT | Copyright (c) 2022 ocavue |
| prosemirror-history | 1.5.1 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-inputrules | 1.5.1 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-keymap | 1.2.3 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-model | 1.25.12 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-schema-list | 1.5.1 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-state | 1.4.4 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-tables | 1.8.5 | MIT | Copyright (C) 2015-2016 by Marijn Haverbeke and others |
| prosemirror-transform | 1.12.2 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| prosemirror-view | 1.42.6 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke and others |
| proxy-addr | 2.0.8 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson |
| qs | 6.16.1 | BSD-3-Clause | Copyright (c) 2014, Nathan LaFreniere and other [contributors](https://github.com/ljharb/qs/graphs/contributors) |
| range-parser | 1.3.0 | MIT | Copyright (c) 2012-2014 TJ Holowaychuk |
| raw-body | 3.0.2 | MIT | Copyright (c) 2013-2014 Jonathan Ong |
| react | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| react-dom | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| react-number-format | 5.4.5 | MIT | Copyright (c) 2020-present Sudhanshu Yadav |
| react-remove-scroll | 2.7.2 | MIT | Copyright (c) 2017 Anton Korzunov |
| react-remove-scroll-bar | 2.3.8 | MIT | no licence file in package |
| react-style-singleton | 2.2.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| react-textarea-autosize | 8.5.9 | MIT | Copyright (c) 2013 Andrey Popp |
| require-from-string | 2.0.2 | MIT | Copyright (c) Vsevolod Strukchinsky (github.com/floatdrop) |
| rope-sequence | 1.3.4 | MIT | Copyright (C) 2016 by Marijn Haverbeke |
| router | 2.2.0 | MIT | Copyright (c) 2013 Roman Shtylman |
| safer-buffer | 2.1.2 | MIT | Copyright (c) 2018 Nikita Skovoroda |
| sax | 1.6.1 | BlueOak-1.0.0 | see licence file |
| scheduler | 0.23.2 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| semver | 7.7.4 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| send | 1.2.1 | MIT | Copyright (c) 2012 TJ Holowaychuk |
| serve-static | 2.2.1 | MIT | Copyright (c) 2010 Sencha Inc. |
| setprototypeof | 1.2.0 | ISC | Copyright (c) 2015, Wes Todd |
| shebang-command | 2.0.0 | MIT | Copyright (c) Kevin Mårtensson (github.com/kevva) |
| shebang-regex | 3.0.0 | MIT | Copyright (c) Sindre Sorhus (sindresorhus.com) |
| side-channel | 1.1.1 | MIT | Copyright (c) 2019 Jordan Harband |
| side-channel-list | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| side-channel-map | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| side-channel-weakmap | 1.0.2 | MIT | Copyright (c) 2019 Jordan Harband |
| statuses | 2.0.2 | MIT | Copyright (c) 2014 Jonathan Ong |
| tabbable | 6.5.0 | MIT | Copyright (c) 2015 David Clark |
| tailwindcss | 4.3.3 | MIT | Copyright (c) Tailwind Labs, Inc. |
| tiny-typed-emitter | 2.1.0 | MIT | Copyright (c) 2020 Zurab Benashvili (binier) |
| toidentifier | 1.0.1 | MIT | Copyright (c) 2016 Douglas Christopher Wilson |
| tslib | 2.8.1 | 0BSD | Copyright (c) Microsoft Corporation. |
| type-fest | 4.41.0 | (MIT OR CC0-1.0) | see licence file |
| type-is | 2.1.0 | MIT | Copyright (c) 2014 Jonathan Ong |
| universalify | 2.0.1 | MIT | Copyright (c) 2017, Ryan Zimmerman |
| unpipe | 1.0.0 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| use-callback-ref | 1.3.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| use-composed-ref | 1.4.0 | MIT | no licence file in package |
| use-isomorphic-layout-effect | 1.2.1 | MIT | Copyright (c) Mateusz Burzyński |
| use-latest | 1.3.0 | MIT | Copyright (c) Andarist |
| use-sidecar | 1.1.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| use-sync-external-store | 1.6.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| vary | 1.1.2 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| w3c-keyname | 2.2.8 | MIT | Copyright (C) 2016 by Marijn Haverbeke and others |
| which | 2.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| wrappy | 1.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| zod | 4.6.7 | MIT | Copyright (c) 2025 Colin McDonnell |
| zod-to-json-schema | 3.25.2 | ISC | Copyright (c) 2020, Stefan Terdell |

<!-- npm:end -->

## 5. Downloaded on your Mac, when you ask

precut does not ship the following. They are downloaded from their publishers' servers onto your Mac when you press **Set up precut**, start your first shoot, or install an add-on, and they keep their own licences. They are listed so you know what lands on your Mac.

### Python runtime

- CPython 3.12 (python-build-standalone, fetched by uv from https://github.com/astral-sh/python-build-standalone). Licence: `PSF-2.0`, with bundled components under their own licences (OpenSSL `Apache-2.0`, SQLite public domain, libffi `MIT`, and others listed in the runtime's `lib/python3.12/LICENSE.txt`).

### Python packages

Every package is pinned with its SHA-256 hashes in `pipeline/requirements.txt` and installed exactly, as wheels from PyPI (`uv pip sync --require-hashes`). Top level: `mlx-whisper==0.4.3`, `opencv-python-headless==4.12.0.88`, `numpy==2.2.6`, `librosa==0.11.0`. The full set:

| Package | Version | Licence |
| --- | --- | --- |
| anyio | 4.15.1 | MIT |
| audioread | 3.1.0 | MIT |
| certifi | 2026.7.22 | MPL-2.0 |
| cffi | 2.1.1 | MIT-0 |
| charset-normalizer | 3.5.2 | MIT |
| click | 8.5.0 | BSD-3-Clause |
| cloudpickle | 3.1.2 | BSD-3-Clause |
| decorator | 5.3.1 | BSD-2-Clause |
| filelock | 4.2.0 | MIT |
| fsspec | 2026.9.0 | BSD-3-Clause |
| h11 | 0.16.0 | MIT |
| hf-xet | 1.7.0 | Apache-2.0 |
| httpcore2 | 2.13.1 | BSD-3-Clause |
| httpx2 | 2.13.1 | BSD-3-Clause |
| huggingface_hub | 2.2.0 | Apache-2.0 |
| idna | 3.20 | BSD-3-Clause |
| Jinja2 | 3.1.6 | BSD-3-Clause |
| joblib | 1.6.0 | BSD-3-Clause |
| lazy-loader | 0.6 | BSD-3-Clause |
| librosa | 0.11.0 | ISC |
| llvmlite | 0.50.0 | BSD-2-Clause AND Apache-2.0 WITH LLVM-exception |
| MarkupSafe | 3.0.4 | BSD-3-Clause |
| mlx | 0.32.4 | MIT |
| mlx-metal | 0.32.4 | MIT |
| mlx-whisper | 0.4.3 | MIT |
| more-itertools | 11.2.1 | MIT |
| mpmath | 1.3.0 | BSD-3-Clause |
| msgpack | 1.2.3 | Apache-2.0 |
| narwhals | 2.27.1 | MIT |
| networkx | 3.7 | BSD-3-Clause |
| numba | 0.68.0 | BSD-2-Clause |
| numpy | 2.2.6 | BSD-3-Clause |
| opencv-python-headless | 4.12.0.88 | Apache-2.0 (wheel bundles LGPL FFmpeg, GnuTLS, and GPL x264/x265 dylibs, see its LICENSE-3RD-PARTY.txt) |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| platformdirs | 4.13.1 | MIT |
| pooch | 1.9.0 | BSD-3-Clause |
| pycparser | 3.11 | BSD-3-Clause |
| PyYAML | 6.0.3 | MIT |
| regex | 2026.9.29 | Apache-2.0 AND CNRI-Python |
| requests | 2.34.2 | Apache-2.0 |
| scikit-learn | 1.9.1 | BSD-3-Clause |
| scipy | 1.18.1 | BSD-3-Clause |
| setuptools | 84.0.0 | MIT |
| soundfile | 0.14.0 | BSD-3-Clause (wheel bundles libsndfile, LGPL-2.1-or-later) |
| soxr | 1.1.0 | LGPL-2.1-or-later (libsoxr) |
| sympy | 1.14.0 | BSD-3-Clause |
| threadpoolctl | 3.7.0 | BSD-3-Clause |
| tiktoken | 0.14.0 | MIT |
| torch | 2.14.1 | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT |
| tqdm | 4.70.1 | MPL-2.0 AND MIT |
| truststore | 0.10.5 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| urllib3 | 2.8.0 | MIT |

`opencv-python-headless` wheels for macOS include their own FFmpeg (LGPL build), GnuTLS, GMP and Nettle (LGPL), and x264 and x265 (GPL-2.0-or-later) as shared libraries, documented in the wheel's `LICENSE-3RD-PARTY.txt`. They do not include Qt. `soundfile` wheels include libsndfile (`LGPL-2.1-or-later`), and `soxr` includes libsoxr (`LGPL-2.1-or-later`).

### Speech model

- `mlx-community/whisper-large-v3-turbo` on Hugging Face, revision `a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb` (pinned), about 1.6 GB: https://huggingface.co/mlx-community/whisper-large-v3-turbo, an MLX conversion of OpenAI's Whisper large-v3-turbo (https://huggingface.co/openai/whisper-large-v3-turbo).
- Licence: `MIT`, from the upstream OpenAI model and the openai/whisper repository (Copyright (c) 2022 OpenAI). The MLX conversion's model card declares no licence of its own.

### Sound separation add-on (optional)

Installed only when you choose it in Settings, Add-ons, on macOS 26 or newer. Listed in `extensions.json`, each file pinned by SHA-256. It also brings DeepFilterNet's own `deep-filter` program, which precut's voice clean-up uses when it is installed (otherwise voice clean-up uses the RNNoise model above).

| Component | Version | Source | Licence |
| --- | --- | --- | --- |
| demucs-mlx | 1.6.1 | https://github.com/ssmall256/demucs-mlx | MIT (Copyright (c) Meta Platforms, Inc. and affiliates; Copyright (c) 2026 ssmall256) |
| htdemucs weights and config | revision 35ecb1a906ec | https://huggingface.co/ssmall256/demucs-mlx | MIT (Demucs, Meta Platforms, Inc.) |
| mlx, mlx-metal | 0.32.4 | https://github.com/ml-explore/mlx | MIT |
| mlx-audio-io | 1.3.24 | https://github.com/ssmall256/mlx-audio-io | MIT |
| mlx-spectro | 0.9.10 | https://github.com/ssmall256/mlx-spectro | MIT |
| numpy | 2.5.4 | https://numpy.org | BSD-3-Clause |
| packaging | 26.3 | https://github.com/pypa/packaging | Apache-2.0 OR BSD-2-Clause |
| tqdm | 4.70.1 | https://github.com/tqdm/tqdm | MPL-2.0 AND MIT |
| DeepFilterNet (`deep-filter`) | 0.5.6 | https://github.com/Rikorose/DeepFilterNet | MIT OR Apache-2.0 (Copyright (c) 2021 Hendrik Schroeter) |

The add-on writes these notices to `NOTICES.txt` in its folder.

### Services you connect yourself

- ElevenLabs sounds are made on your own ElevenLabs account, under ElevenLabs' terms for your plan.
- Claude Code (Anthropic) or Codex (OpenAI) is installed by its publisher's own installer, under its publisher's terms. precut does not redistribute either.
