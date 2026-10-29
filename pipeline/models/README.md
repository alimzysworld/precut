# Bundled voice cleanup model

`sh.rnnn` is the 297,646 byte somnolent-hogwash model from
[GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models), trained for
speech against recording noise. It runs locally in FFmpeg's `arnndn` filter.
There are no runtime downloads, API calls or paid inference.

- Source revision: `3eee541a283fd3b8f81b85b1748e3b9ccbefa04d`
- [Exact model source](https://github.com/GregorR/rnnoise-models/blob/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/somnolent-hogwash-2018-09-01/sh.rnnn)
- SHA-256: `70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0`
- Downloaded: 2026-10-15. Model bytes are unchanged.
- Training/source information: `sh-info.txt`.

## Licence and attribution

The upstream models project declares the weights and training information
uncopyrightable. Its exact notice is preserved in `UPSTREAM-README.md`.
The associated RNNoise implementation is BSD-3-Clause. Its full, unchanged
licence is included as `LICENSE`, from
[rnnoise-nu COPYING at 26269304e120499485438cd93acf5127c6908c68](https://github.com/GregorR/rnnoise-nu/blob/26269304e120499485438cd93acf5127c6908c68/COPYING).
This distinguishes the model's upstream notice from the implementation's BSD
licence rather than assigning a different licence to the weights.

## Packaging

Keep this directory at `pipeline/models` within Electron `extraResources`.
`src/main/audio.ts` checks `process.resourcesPath/pipeline/models/sh.rnnn` first,
then the development pipeline locations. A missing model is an explicit error.
The packaging owner must include `models/**` in the pipeline resource filter:
the current `.py` and `.swift` allowlist excludes these assets and notices.
