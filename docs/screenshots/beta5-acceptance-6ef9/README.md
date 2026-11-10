**Candidate: `6ef9f3f6bdceabedf42e3feaf83c40a8218e3f1e` — beta.5 acceptance, since beta.4 `5d27248a`.**

**7/7 scoped story groups PASS; no new P1/P2 finding in this scope.** Final local campaign: 178/178 focused tests, zero skips; four browser cases / 54 DOM checks; recorded terminal replay and parser observations. Frozen candidate CI is independently verified green, 25/25 checks. Product tracked bytes stayed unchanged.

| ID | Story | Result and actual evidence |
|---|---|---|
| B5-01 | #3580 busy Codex receipt / pending forward | **PASS** — private-tmux replay of recorded frames confirms in **319 ms** while busy, with **0 recovery Enters**. Ten production Daemon/receipt tests plus 46 forwarding tests pass. A pending reference gives explicit guidance: check `delivery_status`, retry the forward after delivery, and do not resend the original; it creates no partial grant. |
| B5-02 | #3568 saved profile/model at wake | **PASS** — 19 lifecycle tests: saved profile, model, both and inherited model reach the next inert Node recorder. Concurrent wakes share replacement; failed replacement and Stop/owner-change controls retain their fences. No model CLI, real credential or live fleet is started. |
| B5-03 | #3589 cold-resume Escape | **PASS** — 12 production Daemon tests with recorded 2.1.322 panes and mock key transport: a dropped Escape is retried at least 1 s later, capped at 3 attempts, including failed ACKs. An answered dialog remaining on screen never qualifies as ready; unknown prompt variants stay held. Timing uses a controlled test clock, not a live vendor run. |
| B5-04 | #3590 file-send versus dangerous command | **PASS** — three recorded plain/two-file/look-alike cards select a held human request with no automatic keys. The recorded dangerous-command card still selects **Down, Enter** (decline), including the transcript-quotation negative control. Eight tests and additional parser observations pass; no command is executed. |
| B5-05 | #3591 Muse third option / 23 tips | **PASS** — recorded 1.4.15 escalated three-option approval stays held with no auto-approval. All **23** catalog tips classify as empty idle composers; a partial tip or extra typed suffix remains a draft. Eighty fixture tests and a separate production-parser observation pass. No Muse CLI/account/model call. |
| B5-06 | #3571 admin terminology | **PASS** — three string/glossary/inventory tests plus real mock-account web journeys on desktop/phone, EN/zh-TW. The visible reason uses **管理員**; 54 checks cover wording, tooltip bounds and Attach/input hit-testing. Four final originals visually inspected. Browser scope is the composer reason; Settings/docs wording is covered by the inventory, not a full Settings tour. |
| B5-07 | #3583 / #3586 / #3595 test-only | **PASS (CI-only)** — exact candidate push run **42833531804** logs all **16** affected suites, including integration: `probe-worker-default` 9 tests, `restart-full` 22 and `claude-cold-resume-startup-1435` 7. This is existing frozen-candidate CI evidence, not a fresh full-suite rerun. |

Evidence: this directory — owned reproduction launcher/harnesses, per-story test results, recorded observations, exact CI excerpts, source-bound receipts, eight PNGs, manifest and cleanup. Only mocks/recorded fixtures, empty HOME/XDG stores and private user/network/PID namespaces; only loopback enabled. No real account, vendor/model, live fleet, AD, updater or service operation.

Harness diagnostics are disclosed in `diagnostics.json`: namespace UID 0 required the documented sandbox flag; a repository-scoped TMPDIR made the inert CommonJS recorder ESM and exceeded Chromium's socket-path limit. A short owned CommonJS scratch fixed both. An early smoke's final guard drain was unreachable; the final harness drains before exit and records fresh cases. Owned catalog-observation parsing errors were corrected. The final combined run passed without any product/test assertion/timeout change; earlier executions are not relabelled.

Visual scope note: on phone, the open tooltip overlays part of the upper control-row labels; Attach/input/Send remain visible and the DOM hit tests pass. This does not establish a new regression. Native phone behavior and a full Settings visual review are not claimed.

Cleanup: final namespace descendants ended, scratch homes/temp directories removed, earlier private tmux/browser fixtures closed, and the exact-owned-prefix residual process check is empty. This acceptance does not authorize the release.

Reproduce with existing dependencies, Chrome/Playwright and verified CJK Fontconfig (no installs):

```sh
REPO=<owned-checkout> OUT=<owned-output> CHROME=<installed-chrome> \
PW_DIR=<directory-with-playwright-core> FONTCONFIG_FILE=<verified-fontconfig> \
python3 docs/screenshots/beta5-acceptance-6ef9/harness/run.py
```

The launcher verifies protected source/tests/scripts against the candidate, uses an owned short scratch directory with a CommonJS boundary, launches each leg in private namespaces, and deletes scratch in `finally`. Its receipts bind the source tree and all three harnesses before execution. Public campaign receipt redacts only absolute local checkout/Node prefixes; raw capture digest remains recorded. Candidate CI excerpts are separately attributed.
