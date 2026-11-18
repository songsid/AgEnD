# Codex stale process sign-in (#4147 / M-3306)

The pane error was missing from the detector table. Adding it to generic auth errors would still lose the incident: `codex login status` checks the current file, while the already-running process may be unable to reload that login. The generic auth path correctly discards conversation-text matches when its file probe passes (#2795); that behavior is retained.

The new `stale_auth` incident applies only to the exact decorated, possibly wrapped error immediately above the last composer. It blocks the affected process, gives an instance-specific restart notice, and raises Needs you. An idle footer or valid-file withdrawal does not release it. Its ownership ends on a new launch. The owner restarts the agent; sign-in is needed only if Codex then asks. Nothing restarts automatically.

The durable pause reason survives a coordinator restart. Active daemon attention also covers busy agents and General, which cannot pause. The Needs-you card offers Open chat and the restart instructions, without a Connect-account button. The wake coordinator leaves queued work held for the owner; a delivery already admitted is refused before writing and remains retryable when durable. Follow-on MCP-death reports cannot turn this process-specific problem into a shared-account sign-out notice, including after an awaited probe.

## Fixture and scope

The two error lines in `tests/fixtures/codex-stale-auth-4147.pane.txt` are the exact text reported in [#4147](https://github.com/songsid/AgEnD/issues/4147). The surrounding prompt, pasted-count and context chrome are synthetic. No account ID, login, colleague, hostname or private capture is included.

Resumed history is quiet until a new failure. The existing acknowledged-input marker and launch/pane fences distinguish a fresh same-count replacement from old text; absent, old or superseded input proof cannot promote it. Quoted text, an undecorated sentence and an error above a later conversation are negative controls.

Related [#2795](https://github.com/songsid/AgEnD/issues/2795) remains unchanged for ordinary auth errors. [#3292](https://github.com/songsid/AgEnD/issues/3292)'s opted-in idle-profile keep-alive is separate. There is no auth-file watcher or account-wide intervention here.

## Validation

- Fail first: the initial three new tests failed before the implementation; replay controls also failed before the history fence was added.
- Alpha affected set: 302/302 in 13 files. After the final MCP race guard, the three changed core/auth suites passed 31/31, including the two added race cases.
- Source and test typechecks: zero errors.
- Seven focused reversals were caught (controls.json): decoration, persistent process hold, resume history, General attention, post-probe fence, auto-wake refusal and the pre-write hold.
- EN and zh-TW use the actual Needs-you renderer with an inert fetch. Auth runners are stubbed, including a valid-file response; no live Codex/Claude, model turn, sign-in/account switch or pane operation is part of this validation.

Commands for the bounded affected set:

```sh
node_modules/.bin/vitest run tests/codex-stale-auth-4147.test.ts tests/codex-stale-auth-ui-4147.test.ts tests/auth-error-verify.test.ts tests/auth-suspicion-rollback.test.ts tests/auth-pause-reconfirm-1044.test.ts tests/needs-you-derive-1386.test.ts tests/needs-you-fleet-1386.test.ts tests/phase2b-wake-coordinator.test.ts tests/dispatcher-liveness-3647.test.ts tests/delivery-target-warning-2327.test.ts tests/fatal-startup-dialog.test.ts tests/pane-quota-history-3188.test.ts tests/cli-upstream-precheck.test.ts --maxWorkers=2
node_modules/.bin/tsx scripts/manual/cli-upstream-precheck/build-manifest.ts
node_modules/.bin/tsx scripts/manual/cli-upstream-precheck/build-manifest.ts --check
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
```

Full suites belong to CI. This proves the observed pane failure, not silent errors confined to Codex's private logs. A new error wording needs another fixture. Rollback is a code revert with no database migration; the standard pause marker remains and an explicit agent restart clears it.

Main port: 187 passed / 1 native-only skipped across 9 affected files; both source and test typechecks report zero errors. Main retains its existing non-native lifecycle and pause reasons. Alpha alone maps its new pause reason to the Hub’s existing error presence; no Hub protocol changes.
