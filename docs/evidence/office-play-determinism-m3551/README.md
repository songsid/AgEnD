# Office drag-and-pat smoke determinism (M-3551)

Dev-only: main has no `scripts/manual/smoke/smoke-office-play-m3293.mts`. This changes smoke code and its sign-in fixture only; Office production code, timeouts, retries and CI partitions are unchanged. The PR remains draft on the beta.19 release-freeze hold until an explicit release lift.

## Observed failure and timing dependence

CI run45183620591, attempt1, UI2 job137723830117 completed the English drag/drop/walk-back checks, then recorded `card: Pat and Feed` false and timed out locating `.oo-card-pat`. The original UI2 artifact14823071175 contains no open card in the failure frame. Attempt2 passed; it is not evidence of a fix.

The old person scan observed the canvas's `hot` class, offset the point by6px, and acted later, sometimes after screenshots. `hot` also covers speech bubbles/dialogue; strolling people move according to `performance.now()`. Thus neither the returned point nor a later click proved that the named person's card had opened. The log does not identify the exact missed pointer event or quantify the original scheduling delay.

## Correction

- Open card phases through the existing accessible `.oo-desk` button, wait for the actual card and verify its instance identity. Reject a missing identity, a wrong card or an already-open card.
- Acquire drag points from a person tooltip matching an actual person button, without the6px offset. Pin only this owned page's animation clock from acquisition through the real pointer-down/touch-start; restore the original property descriptor before drag, long-press or walk-back. A positive animation-frame guard verifies live time before each gesture. No production test hook is added.
- Close a positively present card and wait for it to disappear; remove the ignored click on an already-closed card. Existing real mouse/touch, reduced-motion, Pat/Feed, Tell, no-write and overflow/error checks remain.
- The first loaded series exposed a separate sign-in setup race:23 complete Office samples passed, then sample24 timed out on `#go` before Office. Automatic sign-in could navigate after a short navigation wait expired but before the fallback queried the now-removed button. Retain that failed series; do not count it as30 passes.
- The shared from-defaults sign-in now sets the code, dispatches input and requests form submission in one page turn, as the seeded fixture already does. The product deduplicates in-flight input/submit. Wait for the destination using the existing15s bound; never inspect the old button after navigation. This is a fixture-only change, not a production sign-in change.

## Retained proof

Implementation tested at `6b950447434aa58ba3fbc3d31089335f5645f614`:

- Thirty consecutive fresh Node/browser-process English desktop runs PASS, each requiring exactly19 positive behavioral checks. One Linux CPU shared with two owned busy processes; no retries, stop on first failure. The final series was started from zero after correcting sign-in. All30 raw reports were re-parsed and their hashes and source bindings verified afterward.
- Total process wall time32.835–43.163s includes startup, sign-in, screenshots and teardown. It is not a test-case/hook duration. Standard transform/browser caches were not purged.
- Card/pointer controls9/9 PASS, including wrong/missing identity, bubble-only refusal, exact point and original-clock restoration. These helper components are unchanged since those controls ran.
- Three sign-in controls fail against the previous actual function body and pass against the correction: auto-navigation race, explicit-submit positive and refused navigation without retry. Final sign-in/CSP tests5/5 PASS; final test typecheck exit0. Earlier source typecheck exit0; production TypeScript is unchanged.
- Strict report-parser controls4/4 PASS: missing/invalid/empty/wrong/extra/false reports fail. Stale reports are removed before each sample, and the runner refuses source/HEAD changes or exited contention workers.
- Earlier four-case browser matrix (English desktop, zh-TW desktop, reduced-motion desktop, phone touch) PASS. Office helper/behavior bytes match the final series, but this matrix predates the shared sign-in correction; do not claim a fresh four-case matrix for that correction.

[Thirty-run records](contention-summary.json) and [source/proof hashes and limits](verification.json). Private original failure images, development screenshots and raw reports are represented by hashes only. No new screenshot or visual approval claim.

## Reproduce

```sh
npx vitest run tests/office-smoke-card-m3551.test.ts tests/office-smoke-pointer-m3551.test.ts
npx vitest run tests/smoke-signin-race-m3551.test.ts tests/smoke-wait-no-string-eval-3121.test.ts
npm run typecheck:tests
python3 scripts/manual/test-office-play-contention-m3551_test.py
# Set REPO to this clean committed checkout, PW_DIR to playwright-core and CHROME to Chromium.
python3 scripts/manual/test-office-play-contention-m3551.py --runs 30 --load 2 --out .artifacts/m3551/contention
```

This is a bounded Linux Chromium proof, not arbitrary-load, WebKit, native-device or live-Fleet coverage. The fixture owns its scratch home, listeners and browser; it does not start provider CLIs or touch live panes. The Office owner was consulted; no production hook was needed. Review-checklist ownership/time/evidence rows apply through named identity, bounded clock override with teardown and exact exercised reports; runtime authorization, persisted-state and activation changes are N/A.

Rollback these smoke/fixture helpers and their regressions in a normal follow-up. No runtime, configuration or database rollback is needed.
