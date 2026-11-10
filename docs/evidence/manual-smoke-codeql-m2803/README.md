# M-2803 — main manual-smoke CodeQL fixes

The scheduled main CodeQL gate reported three open `js/bad-code-sanitization` alerts: #105, #106 and #107. Their manual browser scripts serialized fixture values into executable strings. The three sites now pass a function and its data argument to Playwright `evaluate()`:

- memory header: the process rows enter as `processes`;
- Settings quota card: the long option label enters as `label`;
- web update: the localized Reload label enters as `label`.

The existing assertions, matrices, retained-asset controls, updater stubs and product code are unchanged. This is a main-only fix; there is no alpha twin or alert dismissal. These are fixture inputs; the finding does not establish a remote product exploit.

## Executed smokes

All passing executions used committed source `662c1fd9a88863112da7d82fedebcbe4d1d43ee2`, with clean `src`/`scripts` before and after. Each receipt records the source tree and script/fixture digests. Logs below are the actual console output.

| Script | Exit | Output and scope |
| --- | --- | --- |
| `smoke-2556-memory-header.mts` | 0 | `{"cases":32,...}`; four modes × EN/zh-TW × four widths; original before/after and old CSS/panel assertions |
| `smoke-settings-quota-card-main.mts` | 0 | `ALL PASS`; eight matrix cases, every Settings section with long options, plus two retained-asset controls |
| `smoke-web-update-2738.mts` | 0 | `ALL 52 PASS`; its default four cases covering banner, confirmation/Cancel, stubbed launch, progress, failure/log, reload, Settings, search and chat |

See `memory.log`, `quota.log`, `update.log`, corresponding results and receipts. The update smoke's optional `OLD_CSS` leg was not selected; it is not included in that claim. Changelog validation passed 75/75. No source/test type-check or full unit-suite claim is made for this script-only change; the actual scripts were parsed and executed by Node/tsx and Chromium.

The fixtures started owned loopback web listeners in fresh scratch homes; no fleet or native/model CLI was started. Native/lifecycle commands were denied by the runner, and the update script retained its existing launch and registry-lookup stubs. Nothing installed an update. Two initial setup runs failed before a browser page opened because a long owned `TMPDIR` exceeded Chromium's Unix-socket length. Moving it to a shorter owned workspace directory fixed setup without a source change.

## Manual-script audit

Run from the checkout root:

```sh
node docs/evidence/manual-smoke-codeql-m2803/scan.mjs > .artifacts/manual-evaluate-scan.json
```

The read-only scanner first selects files with `rg`, then follows local aliases, template/concatenated first arguments, `content` objects and simple string-returning helpers. The two forwarding wrappers and nested `eval` uses are explicitly inventoried. `scan.json` records the paths, lines, construction sources, commands and limitations.

The scan covers 144 files / 621 evaluator calls. After these three conversions it records 50 additional direct constructed-source calls across 33 files (49 fixture-data interpolations and one constant-fragment composition), nine constructed expressions forwarded through one wrapper, and four constant-fragment nested-eval calls. Fixed fixture values and numeric interpolation count as structural matches; that is not a claim that every occurrence is unsafe or an open CodeQL finding. Constant source strings, ordinary navigation URLs, HTML fixtures and function callbacks with data arguments are distinguished.

This inventory is a follow-up map, not a repository-wide refactor or a CodeQL replacement. Only the three actual open-alert sites are changed in this stable-blocker patch. At the baseline query, main had exactly those three open CodeQL alerts. The scanner does not prove that no other dynamic-code construction exists.

## Reproduce and finish

Set `REPO` to this checkout, `PW_DIR` to a Playwright-core prefix, `CHROME` to the matching owned Chromium executable, `FONTCONFIG_FILE` to a CJK-capable configuration, `OUT` to a scratch output directory, and `TMPDIR` to a short owned directory. The shared fixture requires both listener ports to be free and proves ownership before opening pages.

```sh
node --import tsx scripts/manual/smoke/smoke-2556-memory-header.mts
OLD_REF=01781750590506c8a0d5c16f3b1a5d9bcae37a4e node --import tsx scripts/manual/smoke/smoke-settings-quota-card-main.mts
node --import tsx scripts/manual/smoke/smoke-web-update-2738.mts
npx vitest run tests/changelog-fragments.test.ts
```

Memory uses its existing pinned before ref; quota's two retained-asset controls used the exact earlier main ref shown above. Product source is baseline main `4c5f45a71f4c31c21c0a3b5370dac5806acec5d8`.

After the coordinator merges, dispatch `codeql.yml` on main at a verified main SHA containing the fix, then read alerts #105–#107. Completion requires their state to be fixed and the main Open alerts gate to pass. Local smokes and PR CI do not close those alerts. No CodeQL dismissal, ignore, configuration exclusion or pre-merge main-upload was used.

Rollback is a revert of these manual-script changes; it leaves product/configuration/data untouched, but can reopen the alerts and block stable again.
