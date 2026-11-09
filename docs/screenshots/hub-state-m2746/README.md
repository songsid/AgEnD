# Hub status hints (#3453, #3457, #3458)

These PNGs show the production Settings shell and Hub room at desktop 1366×900 and phone 390×844, in EN/light and zh-TW/dark. The candidate's private package metadata is `2.3.5-alpha.9-m2746.0`; page text and the version pill are not replaced. Chinese/emoji fonts are private to the capture process.

Before uses the five affected UI modules from the immutable `v2.3.5-alpha.9` tag with the same data and actions. After uses this PR. SKEW uses that tag's cached app.css, app-shell.js and app-i18n.js with the upgraded lazy modules. No new CSS classes or shared-shell exports are required.

The isolated FleetManager listener serves the real Settings page and confirmed Run writer. Publication's pending→applied response is scripted, while the real member client, confirmation tracker and UI handle it. The configured host Hub is not started by that FleetManager, so unrelated retention/certificate cards may report unavailable; this is not a Hub lifecycle acceptance run. The already-applied publication card is dismissed with its real close button before capturing Stop.

The separate HTTPS Hub listener runs the real sessions/CSRF, rooms, grants, catalog and SQLite services, with a synthetic directory and controlled group-permit boundary. The browser signs in, opens its own room and sends a question; the real route returns 403, and no question frame is delivered. A new successful room read restores the view after the controlled permit is released. This does not claim a real LDAPS directory, group-policy Resume journey, CLI, native Runtime or account operation. Only owned scratch listeners, certificates, sessions and browsers are used and cleaned up.

## Before → after

Each cell links to the original PNGs.

| Case | Publication | Hub stopped | Room refusal | Access card |
|---|---|---|---|---|
| desk-light-en | [Before](before/desk-light-en-published.png) → [After](after/desk-light-en-published.png) | [Before](before/desk-light-en-stopped.png) → [After](after/desk-light-en-stopped.png) | [Before](before/desk-light-en-refused.png) → [After](after/desk-light-en-refused.png) | [Before](before/desk-light-en-access.png) → [After](after/desk-light-en-access.png) |
| desk-dark-zh-TW | [Before](before/desk-dark-zh-TW-published.png) → [After](after/desk-dark-zh-TW-published.png) | [Before](before/desk-dark-zh-TW-stopped.png) → [After](after/desk-dark-zh-TW-stopped.png) | [Before](before/desk-dark-zh-TW-refused.png) → [After](after/desk-dark-zh-TW-refused.png) | [Before](before/desk-dark-zh-TW-access.png) → [After](after/desk-dark-zh-TW-access.png) |
| phone-light-en | [Before](before/phone-light-en-published.png) → [After](after/phone-light-en-published.png) | [Before](before/phone-light-en-stopped.png) → [After](after/phone-light-en-stopped.png) | [Before](before/phone-light-en-refused.png) → [After](after/phone-light-en-refused.png) | [Before](before/phone-light-en-access.png) → [After](after/phone-light-en-access.png) |
| phone-dark-zh-TW | [Before](before/phone-dark-zh-TW-published.png) → [After](after/phone-dark-zh-TW-published.png) | [Before](before/phone-dark-zh-TW-stopped.png) → [After](after/phone-dark-zh-TW-stopped.png) | [Before](before/phone-dark-zh-TW-refused.png) → [After](after/phone-dark-zh-TW-refused.png) | [Before](before/phone-dark-zh-TW-access.png) → [After](after/phone-dark-zh-TW-access.png) |

Confirmation detail is captured separately while the actual completed card is visible:

- desk-light-en: [Before](before/desk-light-en-confirmation.png) → [After](after/desk-light-en-confirmation.png) · [cached shell](skew/desk-light-en-confirmation.png).
- desk-dark-zh-TW: [Before](before/desk-dark-zh-TW-confirmation.png) → [After](after/desk-dark-zh-TW-confirmation.png) · [cached shell](skew/desk-dark-zh-TW-confirmation.png).
- phone-light-en: [Before](before/phone-light-en-confirmation.png) → [After](after/phone-light-en-confirmation.png) · [cached shell](skew/phone-light-en-confirmation.png).
- phone-dark-zh-TW: [Before](before/phone-dark-zh-TW-confirmation.png) → [After](after/phone-dark-zh-TW-confirmation.png) · [cached shell](skew/phone-dark-zh-TW-confirmation.png).

## Checks

- Fail-first regressions per issue, EN/zh-TW; 179 tests in 9 related suites pass, zero skips.
- Both source and test typechecks; 299 changelog fragments validate.
- Ten assertion reversals caught: publication retirement, exact pending-message identity, neutral switch label, localized confirmation after polling, attached-before-write confirmation, denied access projection, pre-refusal read race, older Hub without a room projection, header status, access-card wording.
- Real Chromium: 20 before, 20 current and 20 cached-shell PNG checkpoints. Questions refused by the Hub produce no member input; drafts survive rechecking. No horizontal overflow or page errors.
- The shared Settings style gate passes 14 scoped Hub checks, including desktop, phone and middle width. It covers frame, alignment, controls and overflow. Existing shared classes are reused: `.tag.warn`, `.hub-banner`, `.btn.btn-sm`, `.note`, `.err`, `PendingChanges`.

Run `scripts/manual/smoke/smoke-hub-state-m2746.mts` with the shared fixture's `REPO`, `OUT`, `PW_DIR`, `CHROME` and `FONTCONFIG_FILE` variables. Set `BEFORE=1` or `SKEW=1` for those legs; `OLD_REF` defaults to `v2.3.5-alpha.9`. `FLEET_PORT` and `HUB_PORT` choose isolated loopback ports; occupied ports fail rather than replacing anything. The candidate snapshot needs src/, tests/helpers/hub-s3b-rig.ts, launcher/, package.json and its dependencies.

No authority, wire schema, database format or lifecycle behavior changes. Rollback is this UI change's revert; the refusal/projection state is only in memory.
