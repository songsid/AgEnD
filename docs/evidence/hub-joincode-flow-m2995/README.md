# M-2995: join-code flow fixes

Source after the clean alpha merge: `8231fb5e12d5bcb92e6b48e93f9a85f6e51bc1d0`. Before: `332add21fbbc92e716003f9040330eab807a74d3` (production bytes equal the `53a08bd7` task base). The final evidence commit adds no product delta. Each capture has a digest-first `PRODUCTION_SHA256SUMS`; the held assets also have `CACHED_SHA256SUMS`. All 68 PNGs are bound by [PNG_SHA256SUMS](PNG_SHA256SUMS).

The [manual script](../../../scripts/manual/hub-joincode-flow-m2995/accept.mts) uses real Hub source HTTP/assets/session sign-in, Preact and shared Dialog. Code CRUD, company-join state and queue replies are browser-routed DTO fixtures, not end-to-end real Fleet joins. The HTTPS unit suite separately exercises real sealed Hub/SQLite/owned synthetic LDAPS, signed machine status and authenticated browser routes.

| Capture | EN desktop | 繁中 desktop | EN phone | 繁中 phone |
|---|---|---|---|---|
| Before live limit | [PNG](before/desk-light-en-live-limit.png) | [PNG](before/desk-light-zh-TW-live-limit.png) | [PNG](before/phone-dark-en-live-limit.png) | [PNG](before/phone-dark-zh-TW-live-limit.png) |
| Live limit | [PNG](after/desk-light-en-live-limit.png) | [PNG](after/desk-light-zh-TW-live-limit.png) | [PNG](after/phone-dark-en-live-limit.png) | [PNG](after/phone-dark-zh-TW-live-limit.png) |
| Hourly limit | [PNG](after/desk-light-en-hourly-code-limit.png) | [PNG](after/desk-light-zh-TW-hourly-code-limit.png) | [PNG](after/phone-dark-en-hourly-code-limit.png) | [PNG](after/phone-dark-zh-TW-hourly-code-limit.png) |
| End confirmation | [PNG](after/desk-light-en-end-confirm.png) | [PNG](after/desk-light-zh-TW-end-confirm.png) | [PNG](after/phone-dark-en-end-confirm.png) | [PNG](after/phone-dark-zh-TW-end-confirm.png) |
| End result | [PNG](after/desk-light-en-end-result.png) | [PNG](after/desk-light-zh-TW-end-result.png) | [PNG](after/phone-dark-en-end-result.png) | [PNG](after/phone-dark-zh-TW-end-result.png) |
| Ended-code feedback | [PNG](after/desk-light-en-code-ended.png) | [PNG](after/desk-light-zh-TW-code-ended.png) | [PNG](after/phone-dark-en-code-ended.png) | [PNG](after/phone-dark-zh-TW-code-ended.png) |
| Queue retry 2 | [PNG](after/desk-light-en-queue-second.png) | [PNG](after/desk-light-zh-TW-queue-second.png) | [PNG](after/phone-dark-en-queue-second.png) | [PNG](after/phone-dark-zh-TW-queue-second.png) |

The before directory also contains the old immediate-end result, generic authority warning and generic queue line. Fresh captures contain retry 1 and 2. SKEW contains all final states except retry 2: an old approval hook has no attempt counter and intentionally uses its truthful generic queue line.

## Validation

- Fail-first: 14 semantic failures in four files against the original implementation. A real-shell capture then found the shared client dropping the cap reason; four real-client/UI tests failed before its narrow correction.
- Post-sync: 422/422 tests across 19 related files; both native TypeScript 7.0.2 typechecks pass. Changelog 409 fragments pass before adding this report.
- Eleven isolated reversals all fail intended assertions, then exact restoration and the 422-test run pass. Covers both cap reasons, HTTP/client projection, pending labels, revoke and exhaustion causes, confirmation, success, retry metadata and the sign-in renderer. Recipe: [mutate.py](../../../scripts/manual/hub-joincode-flow-m2995/mutate.py).
- Browser checks: before 45; after 99; SKEW 89. No horizontal overflow, CSP violations or page errors. Cancel/no-confirm performs no revoke; confirm performs one. Generated browser/listener/keys are closed in `finally`.

## Compatibility and limits

New flow strings live in a new module/namespace. SKEW holds the B2 dictionary, approval hook, shell, CSS and tokens. Fresh copy/confirmation stay usable, and an old hook falls back to the generic queue text. Held CSS retains the pre-existing 36px shared close icon; new action buttons remain 44px. Fresh CSS sizes the shared phone close to `--tap`. A held old Hub client retains its historical generic cap error until refreshed.

No durable schema or admission/quota policy changes. `code-ended` is a display projection of the exact ended, unissued, code-backed denial; durable v3 stores its existing `denied` reason. Ordinary authority loss stays `authority`, issued recovery stays unchanged, and older servers can read the record. Rollback is reverting this patch/binary; no data conversion is required. In-flight counts/names are a display snapshot (first three names plus total), not an admission reservation.

No real directory/account, host lifecycle, Mac pilot, native Windows, packaged-runtime or capacity campaign. Existing shell copy and layout outside the four assigned findings remain separate.
