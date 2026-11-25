# Slice E: request-scoped contact gate

Initial implementation: 615 tests passed, one existing skip, across 50 affected and neighboring files.
Source and test type checking is clean. The new gate's 28 controls use actual
SQLite/outbox stores and synthetic people, with no live Fleet or provider call.
[verification.json](verification.json) records the exact source revision, hashes
and complete command. Source checksums use separate path/digest fields. Two historical generic-key matches were independently verified public-source hashes and are pinned only by exact commit/path/rule/line fingerprints. The initial tests failed before the dormant factory existed.

All 13 guard reversals failed and were restored. [mutations.json](mutations.json)
records exact edits and focused patterns: both in-store scope fences, full image
and retained-request integrity, forbidden origin/inheritance/correlation reads,
post-admission currentness, ticket/delivery retention, retirement proof change,
sweep fairness, guest precedence and wrong-root release. The final 50-file run
was executed after restoring them.

The controls also cover optional grant atomicity and use count, two database
connections, request-bound onward approval, unrelated/forged-root negatives,
legacy-versus-scoped admission, declined-ticket exclusion, bounded/isolated
re-evaluation, once-only outcome rollback, pruning unrelated legacy deliveries,
and all-or-nothing drained-root retirement. Retained Agent origins are unchanged.

The only production surface is an internal factory that refuses unless dispatcher
v1 and the compatibility barrier are active. No production caller invokes it;
existing constructors still default to capability zero. The legacy contact path
is not switched over. No card copy/layout, Hub relay, native receiver, timer or
inline verification is activated here.

Before cutover, F/I must supply the work-lifecycle proof that a root has no live
turn, input, expected continuation, derivative work or native ledger reference.
Retirement also checks terminal state, 30-day retention, reply/recovery references
and the unchanged proof inside one transaction. Ordinary pruning preserves
bound deliveries meanwhile. Pending capacity is deliberately shared (32 per
source, 512 total); scoped sweep/re-evaluation processes at most 64 per tick.

Before activation, revert this dormant integration. After activation, retain the
startup barrier and drain/cancel dependent work before downgrade. Missing proof
never becomes guessed permission or an automatic replay. This is not a sandbox.

To repeat verification, run the command array in verification.json, followed by:

```sh
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
```

Raw execution and mutation logs remain private.

## Implementation review corrections

The current correction run passes 67 tests across the gate, retention and outcome
suites; source/test types are clean. Four controls fail on the earlier head and
pass after correction: terminal retry wording in EN/zh-TW, unread expiry at the
outbox retirement boundary, and the compound legacy-operation expression index.
The index is created only by the capability-gated factory. An additional policy
control pins that already-held operations remain held after promotion, while new
operations use current source-administrator status. This does not replay old work
or create a synthetic human approval.

Declined/expired retries reuse existing localized outcome text that says stop
waiting. The API envelope keeps its existing shape and reports the terminal state;
only pending results say they await approval. No new card or translated string is
introduced. The initial full-suite and 13-reversal results above are retained
initial evidence, not repeated whole-suite claims at this correction revision.
See `reviewCorrectionValidation` for the current command and source binding.
