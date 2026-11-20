# Web system commands (M-3425)

The real web chat lacked two existing platform commands. Main has both backend handlers, so this is the main-first change; the dev twin follows its actual merge.

The palette and POST /ui/command now accept /sysinfo and /status through the existing command table and guest/public-link checks. Shared collectors produce plain-text report cells, rendered with the existing command card and Usage table. The web status projection contains six columns and no Cost cell; platform text and usage data remain unchanged. The host's web language preference translates the report without mutating the platform locale.

## Proof

- Fail first: both new entry/route cases fail at the base with missing palette and unknown command.
- Final focused report/palette/route/locale suites: 82 passed across four files.
- Related authz/status/context/style suites: 119 passed across nine files.
- Source and test type checks passed.
- Reversals: removing the guest check and including the cost cell both make the matching tests fail.
- Real-app headless Chromium: eight report routes returned 200 over desktop/phone, light/dark, English/zh-TW; every report had no page or horizontal report overflow. Each phone report was scrolled to its end and checked.
- All 20 PNGs use the scratch fixture roster and stub system/CLI snapshots. No Fleet start, model call, sign-in refresh, real account or external request was used.
- Existing full Settings UI gate: one Access-page phone tap-target failure, also reproduced with unchanged main CSS. All other checks passed. This change adds only command-report-scoped CSS; no Access styles or allowance changes.

## Captures

Each locale/theme/device pair has sysinfo/status report and palette PNGs under captures/. Phone pairs also have report-end views. Principal views:
- [Desktop English status](captures/desk-light-en-status.png)
- [Desktop English sysinfo](captures/desk-light-en-sysinfo.png)
- [Desktop zh-TW status](captures/desk-dark-zh-TW-status.png)
- [Phone zh-TW status](captures/phone-dark-zh-TW-status.png)
- [Phone zh-TW sysinfo](captures/phone-dark-zh-TW-sysinfo.png)
- [Phone status end](captures/phone-dark-zh-TW-status-end.png)
- [Phone sysinfo end](captures/phone-dark-zh-TW-sysinfo-end.png)

Static image inspection covered all eight report originals and both zh-TW phone end views. No concrete visual defect or private identifier remained. Remaining palettes and English end views have automated checks only.

## Limits and rollback

Synthetic snapshots prove rendering and route wiring, not real host usage accuracy or provider availability. Sysinfo reads cached CLI versions on the web path and does not initiate a probe. The existing platform send/refresh behavior is unchanged. Visual approval, exact-head review/CI, and both actual merges/post-merge checks are still required.

Rollback is a normal revert of this change; it affects command availability and report rendering, with no stored-data migration.

## CI correction

The first exact-head CI run found one additional old guest-palette assertion in web-guest-chat-1920.test.ts. The shared command table already classifies /sysinfo as anyone-level in that Discord scope, so the advertised list intentionally gains it; /status remains absent for guests. Only that assertion/comment and this evidence changed. The complete guest integration file passes 16/16. Runtime, styles and the captured UI remain byte-identical to the source-cleared head. No source/browser campaign was repeated.

## Current scale adjustment

The current presentation and replacement visual-decision captures are in [the synthetic 80-entry check](scale/README.md). The earlier small-roster captures above remain historical; do not use them to approve the current toolbar/dialog layout.
