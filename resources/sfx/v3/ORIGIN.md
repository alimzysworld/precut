# v3 sounds

Made for the precut launch video (26 Oct 2026, sidething-launchpad-site `remotion/public/precut/sfx/v3-*.wav`) and copied into precut's sound library (ONB2, 29 Oct).

- Synthesised by Claude: boom, clean, click, keys, land, launch, riser, rush, shutter, slam, subdrop, thud, tick, timestop, turn, whip.
- Processed from precut's own CC0 v2 sounds (src/main/sfx.ts): hit, impact, impact-dark, pop, swish, whoosh.

SFX0 (31 Oct) re-encoded all 22 from 48 kHz stereo WAV to 48 kHz stereo Ogg Vorbis (`scripts/sfx-synth/build-library.mjs`). The 20 offered in the library also had their silent tails trimmed and were levelled by role under a -1 dBTP ceiling; their starts were not touched, so saved edits land where they did. The two retired ones (impact, launch) keep their level. Ids are unchanged.

No third-party audio is in them. They ship with precut under its own terms, with nothing owed by the person who uses them.
