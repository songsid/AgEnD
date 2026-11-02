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

The CLI panel and selectors use product marks from these official sources,
retrieved on 2026-11-02:

- OpenAI Blossom: https://openai.com/brand/ (official website's inline vector).
- Claude: https://claude.com/icon.svg (original vector path and orange fill).
- Antigravity: https://antigravity.google/favicon.svg (original complete SVG).
- Kiro: https://kiro.dev/icon.svg (original complete SVG).
- Grok: https://apps.apple.com/us/app/grok/id6670324846 (official product app
  icon, linked from https://x.ai/legal/brand-guidelines). The 100 x 100 JPEG
  artwork is retrieved from the listing's `artworkUrl100` field in Apple's
  https://itunes.apple.com/lookup?id=6670324846 response and bundled unchanged.

The compact Anthropic company mark (https://www.anthropic.com/) remains available
separately as `anthropic`; Claude Code uses the `claude` product mark, not the
company mark. Complete SVGs are isolated as data images to preserve their
original colours, masks, and filters without conflicting element ids.
These marks identify the corresponding installed software or its publisher.
Their respective owners retain ownership of these marks; no affiliation or
endorsement is implied. Generic code symbols are used for products without a
verified bundled brand asset.
Vector paths and image data are bundled in `src/ui/provider-marks.js`; no remote image
requests are made by the dashboard.
