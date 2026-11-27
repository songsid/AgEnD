# Repairing request-based reply delivery and completion

M-3896 repairs the beta.27 rehearsal failure behind the enable freeze in #4597.
A real Claude input was delivered, its MCP reply was refused for lacking an armed
destination, its request turn never closed, and Off remained in Draining after a
restart. This is a repair of L, not a new permission model. The production enable
guard remains until the complete sequence below passes review and a fresh rig.

## Causes and preserved rules

C binds an input immediately before paste. `beginRequestContextCall` freezes that
C snapshot and captures its reply route at the first owned hop. The route is armed
later, after submission confirmation and human receipt settlement. A fast tool
call can therefore capture no route even though its own input is being delivered.
The existing pre-arm reply bookkeeping cannot grant routing authority.

Separately, C closes from `TranscriptMonitor`'s `turns` events. Claude uses the
monitor's built-in `_doPoll` reader, which currently emits no such events. The
ordinary reply guard can complete without retiring C. Its idle state or a
successful reply is not proof that the provider turn ended.

The drain controller then projects any remaining F reason as one unnamed `work`
blocker with an inspect action. That hides whether it is an active turn, a tool
call, an unconfirmed human input, or unavailable runtime evidence.

The repair must preserve the original input, actor, audience, incarnation, work
generation and call stamp. No latest-chat lookup, model-supplied destination,
correlation-based parent, timer completion or lifetime-origin permission is added.

## 1. An early reply waits for its own delivery

Stage a bounded pending-delivery record immediately after C binds and before the
paste. Bind it to the exact C token, input ID, wire digest and runtime owner. It
is scheduling state, never proof of delivery and never a reply destination.

A `reply`, `edit_message` or `react` arriving at the first owned hop still captures
its original C snapshot immediately. If its exact input is pending, dispatch may
wait for that input's outcome. No adapter send, policy exception or Fleet forward
runs while it waits. Other tools retain their existing behavior.

Keep the existing delivery-confirmed arm. After the input has its accepted
submission proof, human receipt settlement (where present), and exact
`TurnReplyGuard` arm, release only the matching pending record. Before policy and
again at the send commit point, require the original call, token, owner and
admitted audience to remain current and the route to match that original token.
The call cannot acquire a later turn's route. Arming stays once per submission.

Failure, cancellation, stop, replacement or an expired existing operation budget
refuses the waiter. The budget bounds waiting; it never establishes success.
Uncertain or legacy best-effort output edges do not become positive evidence.
B-mapped expected returns retain their original requesting human audience and
must use the same mechanism, even though they have no direct human receipt.

Submission confirmation polls pane/transcript evidence independently of the MCP
response. A test must hold the early reply and complete confirmation without
returning its tool result, to prevent an accidental cycle.

## 2. Claude emits an owned native terminal boundary

Add a small stateful adapter to the existing Claude transcript reader. Bind it to
the current launch, main session and transcript path using the statusline launch
marker and the existing credential-observation ownership checks.

A genuine main-thread user prompt starts a source turn and supplies its exact
text, native timestamp and provider record identity. Tool-result and meta user
records do not start turns. Additional real inputs received while the provider
turn is open are users of that turn, so a steer cannot leave an earlier artificial
turn open forever.

Track the assistant UUIDs actually observed for that source turn. A complete
native `system` / `turn_duration` record ends it only if its `parentUuid` names an
observed assistant belonging to that turn, with matching launch/session/path and
main-thread identity. Existing log and subagent projections already use this
native boundary. Assistant `stop_reason: end_turn` alone is insufficient because
Stop-hook continuation can follow it. `tool_use`, partial records, copied history,
subagents and a duration with an unknown parent do not end C.

Reset/retract on session or path replacement, offset reset and compaction or
rebaseline. An API error that can be retried is not terminal proof. Unknown end
classification remains conservative; it cannot silently restore positive
coverage after an interruption. Inputs whose full text cannot be read within the
existing bound remain unproved rather than borrowing another prompt's identity.

Tests use recorded Claude fixtures for idle submit, steering, tool results and an
old duration preceding a resent turn. The positive completion must close C even
when reply failed, allowing the next independent input and then Off.

## 3. Draining names the blocker and offers a bounded owner action

Project the actual F blocker families per retained root, including the owning
agent, rather than dropping them behind one blank work card. Keep separate
existing actions for tickets, returns, queued deliveries and recovery pointers.
Do not hide an unavailable registry or an uncertain effect as empty work.

For a current active root, expose the existing verified-owner Stop this work
confirmation and reuse the owned stop/launch-and-IPC retirement path. Recheck the
selected root and blocker image before and after awaits. Stopping A never stops a
replacement owner or clears B's newer recovery pointer. Outstanding tool effects
must settle or reconcile; a timeout is never retirement evidence.

An unconfirmed human receipt requires special care: stopping work must not mark
it delivered, delete its history, invent a response, or replay it. If an explicit
owner abandonment is needed after restart, record a separate image-bound closure
only after the root is fenced against new registrations and every relevant
runtime/call owner is positively retired. That closure means “do not resume this
work,” not “the input was delivered” or “its side effects did not happen.” Other
uncertain deliveries/effects continue to block until reconciled. Its retention
and deletion order must join F/E's existing root transaction.

Unavailable or malformed ownership remains a named blocker with an inspection
path; it does not receive a destructive action that cannot be proven safe. The
actual closure proof and transaction require a separate focused Fable pass before
implementation is considered complete.

## Proof, rollout and rollback

Keep independent commits for reply waiting, native Claude completion, and drain
projection/resolution. Kill mutants removing the wait, original-token comparison,
settlement requirement and final send currency; terminal-parent/session/launch
checks; and action root/revision/retirement checks. Preserve tests for guest A
versus a later guest B, mapped returns, cancellation and stale generations.

Run a fresh private rig: On, immediate human reply, a second independent input,
failed reply with native completion, Off, explicit stop where needed, and restart
while draining. Include a real Claude Code using an inert mock API. No live Fleet,
Hub or provider account is used for this proof. Serialize any heavy rig run.

Only after all proofs and Fable review may the release guard be removed. Any
changed visible drain wording/actions gets captures and the Leader's check before
its user look. Existing approved copy is reused where its consequence is exact.
The optional pre-attempt readiness-list cleanup can wait; it is not a completion
condition for this repair.

Rollback retains or restores #4597's enable freeze. Existing activated work stays
on the capable bridge and keeps all records; an older binary or a guessed legacy
fallback is not a rollback. No closure may weaken another root's policy or
approval. Any new durable closure record must fail closed on an older capable
reader and must never be used as D1 or contact-grant evidence.

## Closure proof accepted at the implementation seam

Extend F's existing `request_context_drain_v1` root fence with bounded, strictly
versioned `resolution_json` and its digest. Do not add a parallel retirement
journal. The owner confirms the exact blocker image; persist the root fence;
stop its exact owners through `stopRequestContextWork` and prove launch, IPC and
native retirement. One root transaction rechecks owner, fence, every F family
and revision, writes abandonment of only the selected uncertain-human receipt
images, then rechecks. Receipts and history stay unchanged. This never proves
delivery, absence of effects, D1, permission, replay or a new admission.

Install a lazy eighth `agend_rc_v1_` guard in that transaction, scoped to writes
of the drain table and a new connection-local capability function. The guard
stays permanently after the first abandonment, including after resolution rows
are collected. Such a home cannot return to a v1-only capable reader: an older
binary is not a rollback. A never-abandoned home retains the seven-artifact v1
shape. A functionless connection can still read and back up the database.
Unknown resolution versions, oversized images, changed digests or guards refuse.

Prove both cases using the published beta.27 reader's own code. Test restart
between stop and write, and between write and fence release, as idempotent
retries of the same confirmed image. Empty runtime families after restart count
only behind the held capable recovery fence; a registration racing the root
fence refuses. All other uncertain effects and deliveries remain blockers.


## Go back preserves a committed Stop

The Leader chose to preserve explicit Stop decisions. The Stop confirmation adds
“Stopping this work also ends Go back for this update.” / 「停止這項工作後，這次更新就不能再退回。」 when an update window is offered. Both the web dialog and native/shared
Settings summary disclose it before the decision; the new line gets a user look.

Every root Stop, including one with no uncertain receipt, writes the same F-row
resolution after positive retirement. An empty receipt list abandons no receipt;
it records only the explicit root stop. Receipt state and history do not change.
Stop holds the existing home update exclusion and SHARED state lease from root
fencing through positive owner retirement and the SQLite COMMIT. Go back holds
the home lock and EXCLUSIVE lease while checking and restoring, so it cannot
restore between Stop's check and write. The updater's existing four-argument
path port continues to use the same database predicate.

`requestContextGoBackAllowed` additionally compares the permanent guard and the
ordered, strictly validated resolution history of the live store and verified
read-only snapshot. Exact equality is required in both directions; there is no
subset or clock fallback. Missing/partial columns, changed guards and malformed
or unknown-version rows refuse. Guard plus a valid empty history on both sides
is equal; different guards or an empty/nonempty mismatch refuse. If collection
removes a retained resolution after an update snapshot, that difference also
conservatively refuses Go back. A later update whose snapshot already contains
the same Stop can remain eligible.

## Earlier unscoped uncertain sends

Reuse the existing delivery acknowledgement; do not add another outcome or
retirement journal. An acknowledged terminal uncertain delivery with no scoped
operation no longer blocks first On. A scoped uncertain delivery keeps blocking,
even when acknowledged. Acknowledgement never proves delivery, changes the
outcome, grants permission or replays input.

Existing acknowledgements also count. Today the platform Needs-you callback
requires a current Fleet administrator and its bound message/adapter/nonce;
the web Needs-you route uses its existing admitted session and continuation
checks, rather than a new per-change owner verification. This change does not
retroactively strengthen that historical evidence. First On still requires the
current verified Settings owner and all readiness checks.

The new Settings action binds the complete delivery row image, including its
source, target, operation, terminal state and finished time, and rechecks the
current owner inside the acknowledgement transaction. A changed row refuses.
A ticket retirement acknowledges exactly its own matching unscoped uncertain
delivery in the same transaction, so one owner decision settles both blockers.
