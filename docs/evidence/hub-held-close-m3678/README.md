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
