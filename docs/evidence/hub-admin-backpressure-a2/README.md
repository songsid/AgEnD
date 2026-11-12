# Hub Administration read backpressure — M-3004 / #3760

At alpha freeze `a11aa634`, the page starts repeated and parallel reads. Each private read independently rechecks directory eligibility. The real cap is four physical checks per person, 32 total. A 429 from company settings has no automatic recovery; failed policy/code refreshes can also erase the checklist's last successful display.

The client now runs one GET at a time and shares simultaneous identical GETs only while pending. There is no successful-response cache. A GET with `429 backpressure` gets at most three additional attempts (500/1000/2000ms, honoring Retry-After up to 2s). Exhaustion returns the failure and leaves a read Retry action. Writes are sent once. A write clears read coalescing; session changes retire queued/backing-off work and fence late replies. A late refusal from a retired session cannot sign out its successor.

Company settings use the shared read transport when present; retained clients use the existing route. The checklist retains known completion only across backpressure; a successful disabled policy clears it, and other failures/session end clear unavailable projections. The code list similarly keeps known rows during a busy refresh. Retained rows are display state: the existing server still reauthorizes every write.

## Validation

- Seven focused suites: **143/143**, workers capped at two. Command: `node node_modules/vitest/vitest.mjs run tests/hub-admin-backpressure-a2.test.ts tests/hub-admin-read-http-a2.test.ts tests/hub-admin-entry-ui.test.ts tests/hub-u2-join-steps-2932.test.ts tests/hub-enrolment-code-ui-b2.test.ts tests/hub-company-join-ui.test.ts tests/hub-ui-s3.test.ts --maxWorkers=2`.
- Actual HubCore + SQLite + cookie HTTP: four held eligibility checks make a fifth admin request return429; the same routes through the client finish with peak1. Directory is inert memory, with no external account/LDAP operation.
- Final fail-first against the original four product blobs: **9 semantic assertion failures**, six unrelated controls deliberately unselected, zero timeouts. The earlier `fail-first.log.gz` has an obsolete abort fixture timeout; `baseline-final-tests.log.gz` replaces that result with a shared held response and an assertion failure.
- Seven isolated guard reversals caught by assertions: serialization, coalescing, retry bound, session retirement, retained checklist completion, queued company read, retained code rows. Exact product restoration verified in `reversals.json`; driver and lossless logs included.
- Source and test native TypeScript checks both exit0. `checks.json` records results; `.log.gz` files preserve raw output without whitespace normalization.

## Browser evidence

`https/receipt.json`: **15 cases, 97 checks, 19 PNGs** at clean `4abbdaf0a278cb52ba7f99f4bd98c5b8d7b3fa07`. Production shell/JS/CSS in one serial Chromium, owned HTTPS listener; API DTOs and read admission are recorded fixtures. EN/zh-TW × light/dark cover normal, one transient429, and exhaustion followed by a real read Retry. Candidate peak read concurrency is1; no write or browser error. Both completed steps and the enabled instructions/code controls are checked. No horizontal overflow.

| Original | What it shows |
| --- | --- |
| [Before](https/before-light-zh-TW.png) | Retained original product blobs reproduce the burst/429 |
| [Normal](https/normal-light-zh-TW-ready.png) | Completed steps and available controls |
| [Transient](https/transient-dark-zh-TW-ready.png) | Recovery without reload |
| [Retry](https/exhausted-light-zh-TW-retry.png) | Known step2 retained; unknown step1 checking, explicit Retry |
| [After Retry](https/exhausted-light-zh-TW-ready.png) | Same page recovered without a write |
| [EN retry](https/exhausted-dark-en-retry.png) | Equivalent EN state |

SKEW controls retain the original company module with the new client (peak2) and retain the original client with new modules (cap32, **compatibility only**, not a claim the old transport fixes admission). There are no new named imports, shared styles, server DTOs, feature/authority marks, or server-policy changes.

`historical-http/` preserves the first clean-source run at4397938fe, 15cases/83checks/19PNGs. Its HTTP origin cannot enable the existing HTTPS-only colleague instructions, so it is superseded for ready-state visual claims. It was not relabeled or rerun in place. The HTTPS harness correction changes no product code.

Each receipt records HEAD/tree, tracked cleanliness, digest-first source/served bindings, exact retained substitutions and cleanup. Browser uses recorded API DTOs; it is not a real AD or packaged-Fleet E2E. No phone/long-duration/multi-tab saturation result is claimed. The separate cookie HTTP test proves the real server pool boundary. The rehearsal owner's installed-package findings remain their own scope.

## Risk and rollback

GETs from this client can wait behind another GET; other tabs and writes still share the original server limits. Exhausted backpressure needs the visible Retry (or the code card's existing polling). Server admission and fresh authority remain unchanged. Roll back this PR to restore the previous client behavior; no migration or configuration change is involved. Coordinator owns merge; leader authorized this alpha.2 freeze exception.
