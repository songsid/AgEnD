# Slice C: local input and turn evidence

The new flow remains OFF. This slice installs no production lifecycle port or
publisher. See the [design and proof limits](../../design/request-context-local-turns.md).

The three new suites exercise strict prepared-input proofs, full runtime-owner
fences, immutable snapshots, independent-root deferral, current administrator
steering, exact peer/human returns, mapped recovery, unknown distinct-root
fallback and SQLite recovery-pointer reopen. The actual reply-recovery queue
carries the captured logical-turn parent and checks the current job.

The Daemon rig executes the real `deliverMessage` gates on synthetic pane probes;
the final low-level writer is stubbed and invokes its actual final-write callback.
It proves the binding point and final-wire argument, not real CLI consumption.
Separate ledger controls prove idle/cached/withdrawn/unrelated completion cannot
retire the binding, while a matched current turn end can. Native/composer queued
input is refused by this local port until the next slice supplies consumption proof.
No generalized backend-completion or native/provider campaign is claimed.

The recovery-store rig uses the actual DeliveryOutbox/SQLite. A fresh tracker
reads only the retained conservative scope, with no restored token. Unproved
recovery has an unknown actor, a new root and no parent; it cannot borrow the old
request's D1 release. OFF writes refuse and create no recovery records.

Sanitized counts, mutation results and source hashes are in `verification.json`.
Raw logs remain private because neighboring tests can print machine-specific
logger fields. Full suites remain CI's responsibility. No real account, model,
provider, live pane, desktop window or Fleet deployment is used.

```sh
npx vitest run tests/request-context-turns-s223.test.ts \
  tests/request-context-daemon-s223.test.ts tests/request-context-recovery-s223.test.ts
```

The review regression pins A-to-B succession under the same unchanged runtime
owner, through both the tracker and the real daemon accessor. A stale A snapshot
cannot validate or end B. A changed B snapshot with its live token also refuses.
Owner-only and token-only predicates each make both regression tests fail; runtime
source is unchanged by this correction.
