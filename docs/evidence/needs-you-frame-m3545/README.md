# Needs you desktop page frame — M-3545

The M-3503 Needs you override forced the column's inline margins to zero at every width. It left the 744px content area against the main pane's left edge on wide windows. Shared `.col` normally centers capped columns; Settings and Fleet also center their content within the available page body.

Restore `margin-inline:auto` for the desktop Needs you frame, retaining the existing 768px outer column and section spacing. The existing canonical phone/short-landscape block explicitly retains `margin-inline:0` and the same safe-area gutters. No markup, card actions, permissions or data behavior changes. This follows the shared components/tokens and responsive rules in both `docs/design/ui-style-guide` copies.

## Measured frames

Gaps are between the outer column and its own page body. Settings has an inner navigation column, so its available body differs from Fleet/Needs you.

| View | Needs before left/right | Needs after left/right | Settings left/right | Fleet tasks left/right |
| --- | --- | --- | --- | --- |
| 1366px | 0 / 338px | 169 / 169px | 0 / 0px (fills body) | 0 / 0px (fills body) |
| 1920px | 0 / 892px | 446 / 446px | 120 / 120px | 210 / 210px |
| Phone390px | 0 / 0px | 0 / 0px | not captured | not captured |

Settings uses its existing1200px cap; Fleet tasks1240px; Needs you retains768px (744px content). The phone's full column rect, margins, padding and max-width are identical. Its before/after PNG files are byte-identical. All cases have no horizontal overflow or CSP/page errors. The capture harness asserts desktop centering and exact phone-frame preservation.

## Originals and provenance

There are10 PNG paths /9 distinct images (the phone pair is identical): before1366/1920 Needs you, Settings and Fleet tasks; after1366/1920 Needs you; and before/after390 Needs you. They are the actual app on a scratch FleetManager/task board with generated Example content, desktop dark/zh-TW and touch-emulated phone. No agents or providers are started. All originals were visually inspected for readability/privacy. Static images do not prove interaction, native-device behavior or every locale/theme.

`before.json` and `after.json` bind their source commits and frame measurements. `verification.json` pins source blobs/PNG hashes and main parity. The baseline's harness used the canonical Settings route before the retained capture set. Reproduce with `scripts/manual/smoke/smoke-needs-frame-m3545.mts`, PHASE=before/after and standard REPO/PW_DIR/CHROME/OUT fixture environment. Do not overwrite the retained before set when running after.

Main already uses the centered shared `.col` for Needs you and has no zero-margin override; this is Dev-only. Focused existing suites `web-needs-1408` and `web-needs-contact-suggestions-m3381` pass34/34, including the existing phone suggestion-control spacing check. Changelog/public/Gitleaks checks are part of author verification.

USER LOOK HOLD: retain draft until explicit Leader approval. Rollback restores only the Needs you margin declarations; no migration.
