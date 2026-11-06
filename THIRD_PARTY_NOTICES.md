# Third-party notices

AgEnD's own code is under its own licence (see `LICENSE`). This file lists third-party work whose methods or field
mappings parts of AgEnD follow, with their licences.

## tokscale

- **Project:** tokscale, https://github.com/junhoyeo/tokscale
- **Version read:** commit `669fdaeec54502a30468adbfa97789bb7ee2b762` (2026-10-23)
- **Used in:**
  - `src/kiro-usage.ts`: Kiro's usage estimate (#2122 §10) follows the formula and field mapping of tokscale's
    `crates/tokscale-core/src/sessions/kiro.rs`.
  - `src/opencode-usage-scan.ts`: OpenCode's field mapping follows `crates/tokscale-core/src/sessions/opencode_schema.rs`.
  - `src/antigravity-usage-scan.ts`: Antigravity's protobuf field numbers follow tokscale's reverse engineering in
    `crates/tokscale-core/src/sessions/antigravity_cli.rs`.
- The TypeScript is AgEnD's own; no tokscale code is included, and tokscale is never run or depended on.

```
MIT License

Copyright (c) 2025 Junho Yeo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## CLI provider marks

The CLI panel and selectors identify each supported CLI by its product mark. All
third-party trademarks, logos and icons belong to their respective owners and are
used only to identify the supported runtimes; no affiliation with or endorsement
by their owners is implied. Each mark is bundled unmodified (complete SVGs byte for
byte, as base64 data images; single-colour marks as their vector paths, drawn in
the text colour), retrieved on 2026-11-02:

| Mark | Source | Terms |
|---|---|---|
| OpenAI (Codex) | https://openai.com/brand/ (the official website's inline Blossom vector) | the owner's brand page |
| Claude (Claude Code) | https://claude.com/icon.svg (original vector path and orange fill) | the owner's website |
| Anthropic | https://www.anthropic.com/ (company mark; Claude Code uses the Claude product mark) | the owner's website |
| Kiro | https://kiro.dev/icon.svg (original complete SVG) | the owner's website |
| Antigravity | https://antigravity.google/press, the press kit's "Icon - Full Color" SVG (`/assets/image/brand/antigravity-icon__full-color.svg`) | the press kit (its page states no further usage terms) |
| Grok | @lobehub/icons 1.102.0, `grok.svg` ("Grok (xAI)") — https://github.com/lobehub/lobe-icons | MIT |
| OpenCode | @lobehub/icons 1.102.0, `opencode.svg` ("opencode", opencode.ai) | MIT |
| Muse (Meta Muse Code) | @lobehub/icons 1.102.0, `muse-color.svg` ("Muse (Meta)", muse.ai) | MIT |

@lobehub/icons (https://github.com/lobehub/lobe-icons) is distributed under the
following licence, which covers the icon set's code and files; the marks
themselves remain their owners' trademarks:

```
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

A generic two-letter tile per provider (AgEnD's own) replaces any mark at once:
`MARK_SWITCH` in `src/ui/provider-marks.js` turns every mark off, or withholds one
provider's. Vector paths and image data are bundled in `src/ui/provider-marks.js`;
no remote image requests are made by the dashboard.

## tokdash

- **Project:** tokdash, https://github.com/JingbiaoMei/tokdash
- **Version read:** commit `f0868fe1` (2026-11-05)
- **Used in:**
  - `src/cache-ledger.ts` (#3066 §2): the output speed follows tokdash's timing rules in
    `src/tokdash/output_speed_readers.py` — Claude Code's `post_first_token` window (a leading thinking block's stamp
    minus `thinkingDurationMs`, to the last block; no stop_reason or an API error is not timed) and Codex's
    `response_window` (first model item's start to last model item's end, minus hosted WebSearch time; over 3000 tok/s
    rejected) — and its aggregation in `src/tokdash/output_speed.py` (Σ tokens ÷ Σ duration, never a mean of rates;
    a duration-weighted p10–p90 from 30 responses).
- The TypeScript is AgEnD's own; no tokdash code is included, and tokdash is never run or depended on.

```
MIT License

Copyright (c) 2026 Jingbiao Mei

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled tmux (`@songsid/agend-tmux-<os>-<cpu>`)

AgEnD runs its own statically built tmux on a private socket (docs/design/bundled-tmux.md). Each platform package is
built from the pinned sources in `scripts/release/tmux-sources.json` (sha256-checked), unmodified, and carries every
component's full licence text in its `LICENSES/` directory:

| Component | Version | Licence | In the build |
|---|---|---|---|
| tmux, https://github.com/tmux/tmux | 3.8 | ISC | the program |
| libevent, https://libevent.org | 2.1.12-stable | BSD-3-Clause | linked statically |
| ncurses, https://invisible-island.net/ncurses/ | 6.5 | X11 (MIT-style) | linked statically; the terminfo subset is compiled from its `misc/terminfo.src` |
| utf8proc, https://github.com/JuliaStrings/utf8proc | 2.12.0 | MIT, and the Unicode License v3 for its data tables | linked statically |
| jemalloc, https://jemalloc.net | 5.3.0 | BSD-2-Clause | linked statically, macOS builds only |
| musl libc, https://musl.libc.org | 1.2.5 (the Alpine build image's, checked at build time) | MIT | linked statically, Linux builds only |
