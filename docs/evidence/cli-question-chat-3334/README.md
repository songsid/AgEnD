# CLI question choices on chat fleets — #3334 / M-2861

Main base: `6ef9f3f6bdceabedf42e3feaf83c40a8218e3f1e`. R1 runs used a modified tree on parent `30bb3780968ed4c7025b768725b812d33dba9644`. `manifest.json` binds the tested source/tests/fixture to their digests, without relabelling these runs as committed-head or browser execution.

`FleetManager.postRemoteCard` used to discard CLI-owned selection cards on chat fleets. The fix uses the existing remote-card path. The legacy `webOnly` marker is retained for existing producers and captured as a current owning-adapter admin requirement for both buttons and text replies. Ordinary agent-question access is retained.

R1 closes the review's disclosure finding:

- For fleet topics, the existing `redactSecrets` masks known credential patterns in the question and options **before** labels are clipped. Stored display titles also keep selected-answer messages masked.
- Raw request identity stays intact: two differently credentialed requests remain distinct even when their displayed text is identical. Masking never mutates the raw card.
- Classic rooms can contain people outside the fleet. CLI dialog cards are therefore offered only on the existing admin dashboard; the room retains its generic parked notice. No private membership is assumed for General. Ordinary Classic agent questions still use the room.
- The web-only control retains its choices, instance binding, supported actions and one-shot answer.

The rig uses mock Telegram/Discord adapters, real FleetManager posting/callbacks, the recorded Claude2.1.318 pane, and the real card reader/answer walk on a scripted pane. It covers owning-adapter and secondary-world admin authority, revocation, callback address/replay, no automatic answer, text refusal, secret masking/outcome masking, changed raw requests and Classic privacy. No backend CLI, model, account, gateway, live fleet or Windows/native acceptance is claimed. No UI module or HTTP contract changed.

## R1 results

- New disclosure regressions fail first: **4/21 red**, with17 passing controls, on the R0 source.
- Restored source: **349/349 tests across13 files**, zero skips, including75 fragment tests and the existing redactor suite. Source and test typechecks pass.
- **12/12 separate compiling guard reversals** are assertion-caught; source restored byte-exact.

| Reversal | Assertion failures /38 |
|---|---:|
| Restore the old chat gate | 19 |
| Drop the captured admin marker | 8 |
| Drop the admin check | 8 |
| Use the primary adapter's admin instead of the owner's | 2 |
| Post the private Classic dialog in the room | 2 |
| Treat ordinary questions as admin-only CLI dialogs | 2 |
| Remove thread / group / message binding (each separately) | 2 each |
| Replace redaction with a compiling identity function | 2 |
| Retain raw option titles for the answer outcome | 2 |
| Present raw option titles before clipping | 2 |

Commands (exact suite list also in `checks.json`):

```sh
npx vitest run tests/cli-question-chat-3334.test.ts tests/web-only-dialogs-2910.test.ts tests/kiro-remote-card-chat-2675.test.ts tests/kiro-remote-card-2675.test.ts tests/web-chat-c4.test.ts tests/nonce-button-shutdown.test.ts tests/admin-gate-754.test.ts tests/needs-you-derive-1386.test.ts tests/needs-you-fleet-1386.test.ts tests/needs-you-web-1386.test.ts tests/claude-file-send-card-2322.test.ts tests/tool-progress.test.ts tests/changelog-fragments.test.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
git diff --check
```

## Historical R0 scope

The original `30bb3780` evidence is retained byte-for-byte as `r0-checks.json` and `r0-manifest.json`:235 related tests,75 fragment tests, nine guard reversals. The fragment test first caught missing front matter, fixed before its passing run. R0 did not cover the disclosure finding; its old Classic bypass reversal is historical, superseded by R1's private-dashboard boundary. It is not counted as an additional R1 result.

Rollback is a revert of the fix, restoring the missing-card behavior. No data format or migration changes.
