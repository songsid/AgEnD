# Third-party notices

AgEnD's own code is under its own licence (see `LICENSE`). This file lists third-party work whose methods or field
mappings parts of AgEnD follow, with their licences.

## tokscale

- **Project:** tokscale, https://github.com/junhoyeo/tokscale
- **Version read:** commit `669fdaeec54502a30468adbfa97789bb7ee2b762` (2026-10-23)
- **Used in:** `src/kiro-usage.ts`. Kiro's usage estimate (#2122 §10) follows the formula and field mapping of
  tokscale's `crates/tokscale-core/src/sessions/kiro.rs`. The TypeScript is AgEnD's own; no tokscale code is
  included, and tokscale is never run or depended on.

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
