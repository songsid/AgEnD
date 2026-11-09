# Model picker proposal — M-2731

These PNGs show the proposed controls in the real AgEnD shell using the published `@songsid/agend@2.3.5-beta.2` build (tarball SHA-1 `d1710c0dda72d835a8b11c56d21fcfb6bda2343f`). The version pill comes from that package, not a text override.
They are design compositions, not evidence of an implemented refresh or a live model probe.

[Survey, behavior and image index](../../design/web-model-picker-m2731.md)

`00` is the current Settings screen. `01`–`07` are proposals. Each has a 1366 × 900 desktop/light and a 390 × 844 phone/dark version, all in zh-TW.
The production sidebar, Settings subnavigation, Agent dialog and chat shell are retained. The capture used the existing isolated `scripts/manual/smoke-fixture` rig, synthetic catalogs and command answers. No live Fleet, CLI, account or tmux operation was performed; all owned listeners were closed.

The capture uses private [Noto Color Emoji](https://github.com/googlefonts/noto-emoji/blob/main/README.md) and [Noto Sans TC](https://github.com/google/fonts/tree/main/ofl/notosanstc) fonts. The fonts are not installed globally or shipped by this design branch. The sample user question is in zh-TW.

The polish keeps full-width selects, uses a bordered refresh button below them, puts chat refresh beside the title, and separates More from model choices. Phone selectors are inside the composer. [Existing copy/layout issues are listed separately](../../design/web-model-picker-m2731-existing-copy.md).
