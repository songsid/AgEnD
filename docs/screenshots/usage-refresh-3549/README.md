# Subscription usage refresh status (#3549 / M-2805)

Real dashboard shell and shared UsageBody on isolated scratch HOME/listeners; only the usage API snapshot is synthetic. No live fleet/account/vendor request or private user screenshot.

- Before: main73940db63, 4 cases, age and updating text together.
- After: current4 + cached4 cases, updating label alone; all12 before/current/cached cases restore the same age after a fresh snapshot.
- Chromium156.0.8078.4; desktop1366×900 light and phone340×820 dark, EN/zh-TW. After status is one line; no horizontal overflow, console error or CSP violation.
- Cached: beta.3 app.css and view-strings.js with current UsageBody. A held English strings module still says “Refreshing…”; it is a single label without the age. Current strings say “Updating…”. No new styles, keys, import, or layout dependency.
- Captures precede commit on the recorded base; digest-first PRODUCTION_SHA256SUMS pins both changed source files. SHA256SUMS pins the16 original PNGs.

| Surface | Before | Updating | Idle | Cached |
| --- | --- | --- | --- | --- |
| desk-light-en | [PNG](before-desk-light-en-updating.png) | [PNG](after-desk-light-en-updating.png) | [PNG](after-desk-light-en-idle.png) | [PNG](skew-desk-light-en-updating.png) |
| desk-light-zh-TW | [PNG](before-desk-light-zh-TW-updating.png) | [PNG](after-desk-light-zh-TW-updating.png) | [PNG](after-desk-light-zh-TW-idle.png) | [PNG](skew-desk-light-zh-TW-updating.png) |
| phone-dark-en | [PNG](before-phone-dark-en-updating.png) | [PNG](after-phone-dark-en-updating.png) | [PNG](after-phone-dark-en-idle.png) | [PNG](skew-phone-dark-en-updating.png) |
| phone-dark-zh-TW | [PNG](before-phone-dark-zh-TW-updating.png) | [PNG](after-phone-dark-zh-TW-updating.png) | [PNG](after-phone-dark-zh-TW-idle.png) | [PNG](skew-phone-dark-zh-TW-updating.png) |

Run scripts/manual/smoke/smoke-usage-refresh-m2805.mts with REPO, OUT, PW_DIR, CHROME and an owned CJK FONTCONFIG_FILE. BEFORE=1 uses a detached before checkout with a distinct HP port. The fixture closes owned listeners, contexts and scratch HOME in finally. This tests the server's refreshing snapshot and subsequent idle snapshot, not a real provider refresh.
