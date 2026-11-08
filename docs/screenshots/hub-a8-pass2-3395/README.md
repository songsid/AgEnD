# Hub alpha.8 Pass 2 — #3395

Source (all product operations): `7c025c93980738e4f9ffa2a7f5891a8b63c978c5`.

CI [42444268795](https://github.com/songsid/AgEnD/actions/runs/42444268795) completed SUCCESS on that exact SHA before this run began; its complete JSON is retained.

This evidence does not overwrite [the first-pass result](https://github.com/songsid/AgEnD/issues/3395#issuecomment-6716185542) on f61e3608. It tests the delta after #3409/#3410/#3412/#3413/#3407. See the final #3395 delta comment for the result table.

## Scope

Actual sealed HTTPS/WSS Hub, synthetic immutable people and recorded TLS/BER AD peer, production directory driver, real SQLite/audit and full member factories. Browser actions perform policy preview/save, local membership/Connect/confirm, both exact fingerprints, manual administrator approval, publication, grants, actual room question/answer admission/lease/release, Resume and revoke. No policy/grant/approval/credential rows are inserted by the harness.

The FleetManager web fixture is in process, with no daemon, CLI, tmux or real account. Representative input delivery and its model report are simulated callbacks. Multiple independent member homes/factories/credentials share one owned fleet web shell sequentially; this proves protocol and browser behavior, not separate physical PCs. The Runtime created by the real membership switch stays unpaired and is closed at teardown.

All network destinations are owned loopback Hub/fleet listeners; foreign browser requests are blocked. Dummy directory credentials only. No real AD/account/native/Windows/pilot/live fleet or model calls.

Desktop 1366×900 and phone 390×844, EN/zh-TW, light/dark. Empty ask-only and full-capability welcome cover all eight combinations each. Other changed flows sample desktop EN and phone zh-TW. Chromium version and source are in the raw receipt.

## Evidence interpretation

The raw run and initial failures are preserved. This is a bounded story rerun, not a claim that every negative subcase in the original issue was executed.

- An early Accounts-only helper used the stale `.lbar` class expectation from an earlier PR description. Current source implements the same shape in its sheet: actual rows had 0px left borders, 3px square pseudo-elements, and three state colours. The corrected run checks computed appearance. Its `/ui/accounts` inventory is explicitly mocked for colour-state coverage only; it proves no account login/install behavior.
- The first attempt to load that supplemental helper into JavaScript eval retained a TypeScript annotation, causing a SyntaxError before any helper body executed. The corrected script and original log are retained.
- Rapid same-session room reloads (<10s) met the independent `ROOM_POLL_MS` read pace and returned explicit 429/backpressure. They were not directory-startup failures or used as evidence of successful pause guidance. An independent room control retains actual403/no-input/rejoin/Resume/answer checks and captures the exact visible Resume row. Waiting 11s before reload does not guarantee a quiet window because an active background poll can just have occurred; its restored screenshot still contains the 429, and is not evidence of rate-limit absence. A later settled resumed-answer frame has no rate-limit text. Asker denial remains generic; only the administrator gets the exact pause/Resume explanation.
- Initial returning-session capture preceded settled welcome content; a second capture of the same retained session waits for both card headings. Both remain in evidence.
- Known P3 #3416: a local Settings confirmation summary uses fleet English while the page is zh-TW. No new issue is invented for it.

Natural expiry uses the server's real ten-minute deadline, with no injected clock. Policy off/on is deferred until after expiry so it cannot invalidate the offer early. Exact source and elapsed timestamps are retained.

## Reproduction

`driver.mts` is a copy of the owned manual driver. Place it under the source checkout's `scripts/manual/hub-quick-pairing/` (relative imports), use an isolated HOME, a short owned TMPDIR, a private Playwright prefix and Chromium, `REPO`, `ART`, `OUT`, and the supplied fontconfig. It refuses a different source HEAD or missing `CI_GREEN_VERIFIED=1`; independently verify CI rather than trusting that flag. No application is installed or fleet started.

After `PASS2_INITIAL_READY`, copy one phase at a time into `ART/command.mjs`; wait `CONTROL_DONE` before the next. Actual executed command files preserve their order and contents. Touch `ART/stop` for awaited cleanup. Account diagnostics are supplemental and labeled separately. `OLD_REF=f61e3608` provides the retained client/CSS compatibility control.

Final cleanup checks, manifest hashes and conclusion are recorded beside this file after the run finishes. These are QA artifacts only; no product edit, release or deployment.

## Final result

**No new P1/P2 in this bounded rerun.** Seventeen core phases passed 101 explicit checks; two supplemental computed-style Accounts checks passed. 69 PNGs. Zero page errors, observed CSP reports or foreign browser destinations. One stale supplemental helper assertion and its pre-execution TypeScript/eval error are preserved rather than relabeled: raw receipt therefore remains `REVIEW_REQUIRED`; see `summary.json` for the explained story result.

- A8-05/06: 16 fresh welcome pages (8 each), explicit empty guidance, correct ask-only/full capability split, zero ordinary welcome429s. Granted Chat reaches a real room/answer. Existing own fleet/limit guidance retained.
- Membership off→on: actual Connect fields appear in the same document on desktop EN/phone zh-TW; saved setting and production pairing API mounted.
- A8-09: milestone remains current before local proof; mismatch/Stop refuses; real ten-minute natural expiry refuses without credential; reuse shows the new-code instruction and no stale confirmation hint in EN/zh-TW.
- A8-10: active owner/admin notices, same returning offline session's retained notice, exact primary revoke, independent manual control reconnected/Online and Active. Not uninterrupted-socket proof.
- A8-12: real403/no-input for complete negative and restored-but-unresumed; visible exact administrative Resume row, explicit Resume then actual delivered answer. Generic asker denial and room-read pacing limits are disclosed above.
- Quick remaining regressions: UI policy preview/save/reload; publication+grant+answer; other-department/no-grant isolation; none/HELD/Retry; pinned quick/local connected; held answer fenced after revoke; policy Off/On retains pauses/manual authority; retained f61 client/CSS grants no actions. Manual positive without a group allowance preserved. These samples do not add unexecuted person-deny, unknown ordinary eligibility, or every replaced-offer negative.

Owned Node exited0 after awaited close. Independent checks: all14 recorded owned PIDs absent, all5 listeners reusable, both owned Hub/fleet scratch roots absent. No product file changed.
