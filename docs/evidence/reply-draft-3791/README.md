# Same-request final draft recovery

Issue #4507: a final assistant text record is not an adapter-confirmed delivery. The existing guard already injects an automatic recovery turn after its stable-idle checks. A bounded transcript review found genuine short omissions too; answer length is not established as the cause. Synthetic quota messages and mixed human/peer turns must not be presented as clean omission evidence.

## Implementation and limits

Only the main Claude transcript supplies draft records in this change. Preserve at most 16,000 characters of a complete text-only `end_turn` record, with a non-synthetic model, main-chain UUID ancestry, session and guard generation, after the exact input owned by the waiting person. The input is bounded to 64,000 characters. A different input, source reset, compaction, stop fence, completion or cancellation clears the retained draft. Tool/thinking/nonfinal/malformed/oversized/unattributable records leave the generic reminder. The draft is ephemeral; no new draft-body persistence or logging is added.

Recovery quotes the answer as a JSON string explicitly labelled as data. The model still chooses whether and what to send with `reply`. There is no new channel-send path, timer change, retry or extra recovery round. JSON quoting does not make text trustworthy; the agent must review it. Existing failed/uncertain/delivered suppression stays in place. Other backends retain their existing reminder. A transcript observed before paste confirmation can miss draft retention and safely fall back to the generic reminder. This does not remove the recovery turn or guarantee model compliance.

## Verification

- A production-daemon recovery regression fails with an assertion when the draft handoff is removed (the prior generic-only behavior), and passes when restored.
- Six focused suites: 154 passed. Final completion/cancel cleanup delta: two suites, 72 passed (overlapping earlier run).
- Commands: `npx vitest run tests/reply-draft-m3791.test.ts tests/reply-drop-guard.test.ts tests/transcript-monitor-generation-1218.test.ts tests/codex-reply-guard-1510.test.ts tests/kiro-reply-completion-guard.test.ts tests/web-inbound-reply-alpha2.test.ts --maxWorkers=1 --no-file-parallelism`; final delta runs the first two files.
- Synthetic controls cover exact/long/empty/oversize drafts, quoted instruction-like text, peer quoting/mixed input, source/session/generation resets, synthetic/tool/thinking records, history suppression, main ancestry, uncertain/delivered/cancelled actions, one recovery input and no direct channel send.
- Source and test typechecks: zero errors. Changelog validation: 855 fragments pass. Public check: clean.
- No private transcript text is committed. No provider CLI, live delivery, restart, screenshot or model-compliance experiment was performed.

Rollback: revert the draft collector and monitor/daemon integration; the prior generic recovery remains. No transcript or delivery-store migration is involved.


## Constructorless daemon compatibility

The first PR CI exposed two credential-change tests whose partial daemons do not run the constructor. Initialize the draft collector lazily and skip draft observation when such a harness has no reply guard. The expanded local run also exposed three Follow cases with that absent guard; the final corrected run passes all **36 selected suites / 651 tests**. The original assertions and all test files remain unchanged in this correction. Selection: every test file matching `Object.create(Daemon.prototype)` or `Daemon.prototype`, plus the draft controls. Source and test typechecks pass with zero errors. This changes no draft ownership, send path, timer, or recovery budget.
