# Silent schedule delivery outcome (#2287)

At b93db72ce, both reported mechanisms remain. queueRawPaste,
proveDeliveryFromTranscript, lateCodexSubmissionProof and insertFailureNotice
are unchanged from v2.3.0-beta.8. The subsequent Codex backend change is
429/quota classification (#2283), not raw submission proof.

#1663 (3ee4068be, including 37f2ee4d0) intentionally excludes Codex raw text
from rollout proof: getSessionId() returns null, sessions are shared, and the
rollout source picks the newest matching cwd. Another CLI can use that cwd.
#1843/#1850 (148cccdf0/969573fa1) fixed silent reply-guard attribution rather
than this proof path or outbox outcome notices.

The current consumed watch only handles steer/native-queue messages with an
exact delivery marker. A later consumed log must be matched by delivery_id;
it cannot be assumed to confirm the earlier raw paste.

Outcome notices are inserted in the same SQLite transaction as terminal
settlement. Previously every ordinary failed/uncertain row queued a notice to
its source. When a silent schedule's source equals its target, that created a
new turn in the same instance telling it about its own heartbeat.

The common insertion point now skips only a raw_paste with a schedule source
key whose source equals its target. This stops the feedback turn for direct
completion, pre-submit failure, expiry and reconciliation. No failure-notice
reservation is left behind. Terminal state, attempt evidence and the state
event remain; the existing manager observer logs the cause and skips the
operator alert for this same self-silent case. Other sources, ordinary self
messages and non-schedule raw commands retain their notifications.

Silent schedules already stay out of Needs you. No paste/retry, transcript
proof, scheduling cadence, reply guard or delivered-state rule is changed.
This fix is planned for 2.3.0-beta.20.

[Real Codex 0.162.1 fixtures](../../tests/fixtures/silent-codex-2287/SOURCES.md)
record both an initial-frame flush delay and a fully-ready fast turn whose
rollout/history retain the message after its viewport echo disappears.
A real backend/daemon judge over the ready capture returns unproven even
though the selected rollout contains the body. No caller accepts same-cwd raw
text as this pane's proof. This limitation is tracked in
[#2301](https://github.com/songsid/AgEnD/issues/2301), milestone 2.4.

All CLI captures use a capped network-disabled private container, scratch
HOME/CODEX_HOME, an explicit private tmux socket and a loopback mock Responses
API. No test fleet, account, vendor or live tmux/fleet action. Unit tests use
real outbox transactions and inert fleet/daemon boundaries.

Rollback is a revert. No schema, config or persisted-state migration. Existing
historical outcome rows are retained rather than destructively rewritten;
the guard applies to newly generated outcomes. Quiet self-schedules still
need their logs inspected for genuine delivery failures.
