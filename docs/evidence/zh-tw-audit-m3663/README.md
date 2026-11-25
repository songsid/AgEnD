# Mechanical zh-TW audit fixes (M-3663)

The audit at snapshot `074e58860` lists fifteen findings: one Japanese character in 瀏覧器, five 占→佔 values and nine half-width parenthesis pairs. The Leader supplied the exact rows inline. Each was rechecked against alpha base `3ed153b1541f020aa027781f905a615b2d3e63df`; all fifteen findings are still present, so none is stale on this tip.

The patch changes only those values: 瀏覽器; the five listed occupancy/cost-share labels; eight `update.progress.*` messages and `progress.trace_title` with full-width parentheses. Characters are typed directly. A source scan finds no remaining 覧 under `src`. Literal commands, placeholders, English text and glossary terms are unchanged. Six existing test files update only expected zh text to match; their lifecycle/error/ownership assertions remain intact.

[Every row's before/after disposition and main presence](audit-dispositions.json), [source/proof bindings](verification.json).

## Checks

Implementation `805ea0863ee53831177ee270ad59bd6ecd5e0b87`, with subsequent evidence-only additions:

- Seven focused suites61/61 PASS: CLI/web locale, zh product terminology and admin wording checks, live/honest update progress and Hub setup UI copy.
- Evaluating the actual old/current catalogs verifies exactly15 zh values differ; all English catalogs, keys and placeholder sequences match. Reversing those value edits reconstructs all four source files byte-for-byte, proving no behavior change.
- No added source line contains a Unicode escape. Changelog, public text and staged secret checks pass. No local typecheck or new browser/visual run is claimed; normal exact-head CI remains required.
- The first focused run exposed five existing assertions that still expected half-width zh parentheses. Only those zh expected strings were corrected; English expectations are unchanged. The final61-case result above is the passing result.

```sh
npx vitest run tests/i18n-cli-2390.test.ts tests/i18n-web-2390.test.ts tests/ui-zh-terms-815bfe4a.test.ts tests/zh-admin-word-2820.test.ts tests/update-live-progress.test.ts tests/update-progress-honest-2476.test.ts tests/hub-web-setup-ui.test.ts
node scripts/changelog-assemble.mjs --check
rg -n '覧' src
```

The last scan is successful when there are zero matches. The copy-only tests use existing inert fixtures; no live Fleet, provider CLI, pane, browser or native-device campaign is added. Review checklist: exact evidence and scope apply; runtime ownership/authorization/deadline/activation rows are unchanged. User-facing skills and glossary changes are N/A for these mechanical corrections.

## Main twin

Main snapshot `22c1977842a45350a0937ee9d184083bd6f74796` contains twelve affected values. It has no `settings-hub-setup-strings.js`, `hub-admin-overview.js` or `progress.trace_title`; those three rows are dev-only, not feature backports. Recheck fresh main after the actual dev merge and carry the twelve present fixes as a standalone twin. The parent delivery is complete only after both required branches and checks are delivered.

Rollback only these zh values and their matching expected-copy literals in a normal follow-up. No runtime, stored configuration, API or database rollback is needed.

## R1 complete expected-copy coverage

Review and exact-head CI identified three more existing test files with old zh expectations. Four lines now use the full-width characters: the tool-history prefix, two restart-progress messages, and healthy update completion. English rows, timing, cleanup, cancellation and message-ownership assertions are unchanged. All four production files and the fifteen audit dispositions remain byte-identical to the reviewed head.

The complete grep set for the affected message text and keys covers eight full suites; all176 tests PASS. This overlaps the earlier61-case result and must not be added to it as unique coverage. The files are restart-progress, update-welcome-quiet-1854, slash-authz, command-gates-by-platform, update-progress-honest-2476, update-live-progress, live-progress-cancel and install-user-manager-3630. The exact original failed-job logs were inspected before correction; their hashes are retained privately. The unrelated Codex audit reached-hello assertion is untouched; its local pass was reported by the reviewer, not rerun by this author. Fresh exact-head CI is still required.
