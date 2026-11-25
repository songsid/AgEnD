# Held Hub question closure

The member offered retry only for untouched questions. Uncertain work could have
only Open chat, with no way to settle it for the asker. This adds an explicit,
verified administrator close on the existing Needs you row and shared confirmation
dialog. The local item clears only after the Hub's exact-message acknowledgement.

All evidence is synthetic and local. The 32 retained real-dashboard PNGs show the
8 desktop/phone, light/dark, EN/zh-TW combinations: before, held, confirmation and
closed. Their exact source and unchanged renderer/recipe bindings are recorded in
`verification.json`; incoming shared CSS is not claimed byte-identical. Five
representatives were individually checked for privacy/readability. Phone tap size,
Cancel/retry, no premature POST/busy wording, one confirmed POST and no overflow
are browser-recipe assertions. Run the recipe with the existing smoke-fixture
REPO/PW_DIR/CHROME/OUT environment; it uses an ephemeral port and scratch HOME.

The dashboard callback is a fixture, not a real Hub connection. Separate tests use
the real scratch Hub HTTP/SQLite/audit paths to prove owner/Fleet/exposure binding,
rollback on audit failure, existing-answer preservation, duplicate close, late
receipt and late-answer refusal. No Hub asker-page screenshot is claimed here.

Initial proof: five base regressions fail, then 144 tests/10 files and both source
and test TypeScript pass. After normal release integration: 150 tests/8 affected
files pass. Final close/authority/representative tests pass 64/3 after adding the
late-answer case; both type checks pass. The stale-link ACK regression fails
before the current-link check and passes afterward. Exact commands:

```sh
npx vitest run tests/hub-held-close-m3678.test.ts tests/hub-held-close-authority-m3678.test.ts tests/hub-needs-retry-m3632.test.ts tests/hub-representative.test.ts tests/hub-direct-posts-m3639.test.ts tests/hub-asker-identity-m3594.test.ts tests/hub-network.test.ts tests/hub-room-asker-identity-m3664.test.ts --maxWorkers=1
npm run typecheck
npm run typecheck:tests
```

Existing strict journal rows are unchanged. A rollback leaves close-pending work
held; it must never be retried as a question merely to dismiss it. Closed Hub
questions remain terminal. No live Fleet, account, vendor, model or CLI was used.


## Finality wording revision

`revised/` contains the requested 16 fresh held/confirmation images at
`9f01404a318acce7f8102bd2257cddfe5783e74d`: eight desktop/phone, light/dark,
EN/zh-TW combinations. English trigger/title/confirm consistently use Close.
Both languages explain the action cannot be undone, the same message cannot be
retried, and the asker may send a new question. Five originals were individually
inspected, including both phone confirmations. All eight recipe cases pass,
including no premature POST/busy state, Cancel/retry, one confirmed POST, success
and no overflow. Only held and confirm screenshots were retaken; earlier
`before/` and `after/` images remain historical, not current copy claims.

The Hub/Fleet/API runtime is byte-identical to `06ed990a1`. The changed UI suite
and an actual Hub HTTP retry-key control pass 26 tests in two suites; test
TypeScript passes. Reusing a closed message's retry key returns that same
cancelled receipt, creates no new message and sends no new question. This verifies
the warning; there is no new runtime reopening restriction in this revision.


## CI correction after visual approval

The FleetManager close-result type uses an inline type reference, preserving the
runtime's dynamic-import boundary. The close tap-target rule now uses the shared
phone query, including landscape phones. The approved desktop/portrait-phone
conditions and every retained PNG blob are unchanged; no capture was rerun.
Both failing CI checks pass. A neighboring Hub hook's fixed 400 ms positive wait
also exposed a cold-import race locally; it now waits on the mock's actual apply
completion for initial and changed configuration. No timeout or retry was added.
The two suites pass 15 tests; source and test TypeScript pass.


## Link parity correction

After the link audit landed on release, its guard caught the missing public-link
route. A plain merge preserves all 83 owned added/removed-line sequences and all
48 PNG blobs. `POST /ui/needs/hub-close` is now routed next to hub-retry, with no
change to its verified managing-admin handler. The audit's settled route list
includes it. Regression calls use actual gateway session/context binding and the
real FleetManager contact-actor consumer with an inert verification provider:
admins succeed over the link and locally; read-only, guest, unverified and
missing-CSRF requests invoke no close callback. Four audit failures precede the
route addition. The final audit passes 5 tests; 45 neighboring contact/retry/role
cases pass. Both TypeScript checks pass. No new browser or live campaign.
