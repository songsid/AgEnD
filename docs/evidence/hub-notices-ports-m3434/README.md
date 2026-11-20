# Hub directory notice port lifecycle — M-3434

The initial Hub ports are already reserved through the real TLS listener startup. The flaky regression test later closes those listeners, starts the dashboard on an ephemeral port, then tries to bind the old Hub numbers again. The OS may assign a released number to any new listener, including that dashboard. `EADDRINUSE` at this point says the number has a new owner, not that the original Hub listener leaked. The CI log does not identify the new owner.

The test now observes the original TLS servers' real `listening` and `close` events, and verifies that both original listeners are closed with null addresses before the cold notice request. It keeps the existing competitor checks while the initial leases are held. It never rebinds released addresses. Dashboard startup awaits its existing listen-completion promise instead of polling readiness. Default fixtures use ephemeral/reserved ports; no fixed port, retry or timeout increase is added. No production source changes.

## Input-bound evidence

`inputs.json` identifies each exact test input and the base commit. Its `patches.controlledBase` and `patches.controlledFixed` strings contain complete unified diffs; extract either JSON string to a patch and apply it independently to that base in an isolated worktree:

- Controlled base: force the dashboard to reuse the released member port. The old numerical bind probe fails with `EADDRINUSE` (1 red).
- Controlled fix: the same forced reuse passes when shutdown is checked on the original listener objects (1 green).
- Final committed test: remove the forced-reuse fixture hook. The normal dashboard remains ephemeral, and the test does not care if a released number gets a new owner. The complete notice suite and shared compose-port controls pass **16/16**.
- Repeat proof: **50/50** serial fresh-fixture iterations in one worker/process; zero retries. The temporary repetition overlay was restored byte-for-byte. Each iteration keeps the existing cleanup and fixture-home removal assertions. The 12 unselected test cases are explicitly skipped only in this selected repetition run.
- Full test type check passes with zero diagnostics.

The test is absent from main at the recorded main tip, so this is dev-only and has no main twin. No live account, LDAP service, CLI, tmux or browser is used. Logs replace local checkout paths. Exact-head review/CI and green post-merge CI remain required.

Rollback is a normal revert of this test-only change. No data, configuration or runtime behavior changes.
