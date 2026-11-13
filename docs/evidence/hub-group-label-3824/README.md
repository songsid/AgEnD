# Group names on Who may ask rows — M-3066 / #3824

「可以提問的人」原本直接顯示資料庫中的完整 DN。現在群組列、更多動作的名稱和撤銷確認都顯示 `Owners`。既有 DN、GUID、授權版本與到期日不改，也不增加 AD 查詢。EN／繁中、桌面／手機、亮／暗的前後畫面在下表。

The catalog used the recorded `subject_label` DN directly as `subjectName`. Only that display projection changes. The writer, `grantOf()`'s raw `subjectLabel`, immutable group key, grant bytes, permissions, membership evaluator and expiry remain unchanged. Person names are not decoded.

The small presentation decoder reads a leading `CN` value, including escaped delimiters and UTF-8 octets ([RFC 4514 §§2.4–3](https://www.rfc-editor.org/rfc/rfc4514.html#section-2.4)). It is not a DN validator, an identity parser, or a BER decoder. Plain labels and unsupported forms (non-leading CN, BER hexstrings, invalid escapes/UTF-8, empty or decoded control values) retain the recorded label. It does not find a parent CN or resolve a name in AD. Names remain a grant-time snapshot, not a fresh directory-name attestation.

## Validation

| Check | Result |
| --- | --- |
| Actual HTTP/session/SQLite projection regression before the fix | 9 assertion failures, 50 passing controls |
| Four focused suites before and after alpha sync | 114/114 on each run; same cases, not 228 distinct tests |
| Native TypeScript 7 source and test programs | both exit 0 before and after sync |
| Isolated reversals | 4/4 compile and fail assertions: remove projection, omit UTF-8 decoding, accept decoded controls, decode person names |
| Restored targeted tests | 17 pass, 42 deliberately unselected |
| Secret-scan configuration/range guards | 35/35 across two additional suites |
| Changelog check | 454 fragments pass |
| Owned Chromium campaign | baseline 8 cases/46 checks + candidate 8/54; 24 PNGs; zero page errors; both cleanup receipts true |
| Original-image inspection | all 12 current originals + 4 baseline desktop rows clear; 8 other baseline originals have geometry/interaction checks only |

Commands (from the worktree; local Vitest used at most two workers):

```sh
./node_modules/.bin/vitest run --maxWorkers=2 tests/hub-grant-subjects-m3016.test.ts tests/hub-grant-migration-m3016.test.ts tests/hub-grant-recipient-3370.test.ts tests/hub-s3b-flow.test.ts
./node_modules/@typescript/native/bin/tsc --noEmit
./node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.test.json
node scripts/manual/hub-group-label-3824/mutations.mjs
node scripts/changelog-assemble.mjs --check
REPO=<actual-baseline-or-candidate-worktree> OUT=<evidence/before-or-current> MODE=<before-or-current> PW_DIR=<shared-Playwright-install> CHROME=<Chromium-executable> ./node_modules/.bin/tsx scripts/manual/hub-group-label-3824/browser.mts
```

The baseline server really ran `e933d36a9d538405bd66ac8ac3bdeb5ce61136e3`; it was not a response or UI substitution. The candidate captured clean `6d43c3861639437219b614e2807510ccb378ec0e`. Both used actual production Hub HTTP, cookie session, CSRF, SQLite catalog and unchanged UI over owned HTTPS, with inert directory facts and authenticated member publication. The fixture creates a GUID grant, checks the row/menu accessible name and revoke confirmation, cancels every confirmation, and verifies the entire stored grant remains byte-for-byte equal. No live directory, account, Fleet, model, input or deployment was exercised.

No UI, CSS, module import or API key changed. A retained UI receives the same `subjectName` string field; the captured baseline/candidate panel and owner stylesheet inputs are identical. There is no claim of a historical-browser lifecycle run or an exhaustive server suite. Static PNG inspection does not establish authority or accessibility metrics; DOM assertions cover the named row/menu/confirmation and viewport overflow.

The first PR scan found two `generic-api-key` false positives: the SHA-256 of the public `/assets/tokens.css` response in the two receipts. Both match `src/ui/shared/tokens.css`. Served hashes now use `hash → paths` groups; the existing receipts were transformed losslessly, with original/new hashes and exact round-trip checks in `checks/scan-false-positives.json`. The harness changes only that serialization. PNGs, checks, observations and product code are unchanged. Two exact historical commit/path/rule/line fingerprints in `.gitleaksignore` cover the earlier commit; no rule, path, pattern or future finding is excluded. Pinned Gitleaks 8.24.3 checks the complete local history using `-m` (all merge parents) and the current evidence tree without findings. Local Git 2.34.1 cannot run CI's `--diff-merges=remerge`; the first unsupported attempt was a partial scan and is not counted as passing. CI remains the exact remerge-range gate.

The harness's first initialization attempt named the stylesheet's parent directory incorrectly; it stopped before starting a listener/browser. The empty owned scratch was removed and the harness fixed before both accepted campaigns. No failed capture is presented as passing evidence.

## Alpha sync and rollback

Plain merge `aee238bb127abe39e11b2d24bd3e16987d85c7bc` has parents candidate `6d43c386` and alpha `51b9f694` (#3660). All 123 incoming paths are disjoint from the six own paths; all six blobs, including catalog/tests/harness, are identical after the merge. The screenshots remain evidence at the clean pre-sync capture commit, with focused tests and types rerun on the merged composition. See `checks/alpha-sync.json`.

There is no storage migration. Rollback restores the old display projection and therefore the full DN; existing grant authority and data need no conversion. Unsupported DN presentations intentionally keep their original label. Coordinator-only merge and exact-head parity/CI remain required.

## Gallery

Each row links the real before/after full-page PNG. Desktop confirmations name the same group and were cancelled.

| Screen | Before | After | After confirmation |
| --- | --- | --- | --- |
| Desktop EN light | [DN](before/before-desktop-light-en-row.png) | [Owners](current/current-desktop-light-en-row.png) | [Confirm](current/current-desktop-light-en-confirmation.png) |
| Desktop EN dark | [DN](before/before-desktop-dark-en-row.png) | [Owners](current/current-desktop-dark-en-row.png) | [Confirm](current/current-desktop-dark-en-confirmation.png) |
| Desktop 繁中 light | [DN](before/before-desktop-light-zh-TW-row.png) | [Owners](current/current-desktop-light-zh-TW-row.png) | [確認](current/current-desktop-light-zh-TW-confirmation.png) |
| Desktop 繁中 dark | [DN](before/before-desktop-dark-zh-TW-row.png) | [Owners](current/current-desktop-dark-zh-TW-row.png) | [確認](current/current-desktop-dark-zh-TW-confirmation.png) |
| Phone EN light | [DN](before/before-phone-light-en-row.png) | [Owners](current/current-phone-light-en-row.png) | — |
| Phone EN dark | [DN](before/before-phone-dark-en-row.png) | [Owners](current/current-phone-dark-en-row.png) | — |
| Phone 繁中 light | [DN](before/before-phone-light-zh-TW-row.png) | [Owners](current/current-phone-light-zh-TW-row.png) | — |
| Phone 繁中 dark | [DN](before/before-phone-dark-zh-TW-row.png) | [Owners](current/current-phone-dark-zh-TW-row.png) | — |

`before/receipt.json` and `current/receipt.json` bind capture commits, input/served hashes, geometry and cleanup. `checks/` contains the assertion-red baseline, passing runs, native type logs, mutation outcomes and sync receipt. `manifest.json` hashes the packaged evidence and current feature/test/harness inputs, excluding itself.
