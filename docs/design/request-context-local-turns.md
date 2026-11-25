# Local request-context input and turn binding (slice C)

This is dormant preparation for [request-scoped contact provenance](request-scoped-contact-provenance.md),
following the [immutable storage slice](request-context-store.md). No production
caller installs the lifecycle port. Production remains OFF; no current contact
gate, receipt authority, Hub window, UI or capability advertisement changes.

## Trusted input, actual write

`RequestContextLocalTurns` accepts only a server-prepared input record selected by
an owned receipt/attempt/job key. The record binds the exact final wire digest and
the expected runtime owner: instance/incarnation, work generation, daemon boot,
spawn generation, launch fence and delivery epoch. Preparation must read the real
admitted input and current ownership; it must refuse terminal/stale inputs. A body,
quoted header, ordinary history reply or correlation string cannot prepare one.
The input resolver is an internal injected port, not a tool, web or IPC setter.
Ingress identity/role classification and its actual publishers remain for the
later integration/cutover; this slice does not infer them from text.

The real Daemon's common final `beforePaste` callback binds after the write lock,
readiness checks and awaits, immediately before paste. It receives the final
wire, including receipt preparation changes. Its digest is the shared raw UTF-8
`deliveryContentDigest`, matching actual delivery/receipt byte hashes, not a JSON
serialization of the string. A verified receipt key takes
precedence over a durable attempt key. Unmapped system input is conservative
recovery, never a fresh owner root. Failed or uncertain paste retains conservative
ownership until an owned boundary; it is not proof that the input was consumed.

Native/composer queued input is explicitly unavailable with this local port:
enqueue is not consumption. The next native/paired slice must supply owned
consumption and await/remote-call fences before such paths can be enabled.

## Mechanical joining and ending

An independent prepared input must have a new root and no parent. It waits while
an active turn owns the pane; it cannot take that turn's D1 release. A permitted
administrator steer needs either the exact active token or explicitly mapped work,
and rechecks the managing role at the final write. Its identity does not replace
the original requester and supplies no human go-ahead.

A registered expected return checks its actual sender against its expected sender.
A human answer must also be from the initiating actor, using platform/id rather
than display name. Peer returns bind the exact instance/incarnation. Mapped
returns, steering and recovery preserve parent root, evidence, actor, ingress and
audiences. Unknown proof versions, multiple parents or authority fields refuse.
Late returns start a new binding; they never revive an ended turn's token.

Snapshots are deeply frozen, randomly tokened and bound to the full runtime owner.
A changed boot/incarnation/work generation/spawn/fence/epoch invalidates the old
snapshot. Stop fences active state. Idle, a timeout, a published answer or a pending
child does not retire it. There is no persistent agent-wide permission switch or
awaiting-children lock.

Automatic local retirement requires a unique server-owned receipt/delivery/input
marker in the wire, plus the transcript ledger matching this write and observing
its actual complete/aborted/error end. Unmarked repeated system text cannot prove
ownership just because it matches an earlier prompt. A mapped reply-recovery job
gets its own boot/job marker only when the dormant lifecycle port is installed;
OFF recovery bytes are unchanged. The ledger starts at
this write, separately from cached historical evidence; a withdrawn or unknown
record does not count as completion. Stale monitors cannot settle a current write.
This is not a claim of generalized owned completion for every CLI: a backend that
does not supply a matched end remains conservative until an explicit cancel or
fresh-runtime boundary. Coverage/actual-consumption proof is required before
cutover; the current Hub idle/window completion is deliberately not used as that
proof. Snapshot capture across native awaits and remote forwarding belongs to the
next slice. No backend or account campaign is performed here.

## Recovery without laundering

The actual reply-recovery queue captures the original logical-turn generation's
snapshot. It rechecks the recovery job before the final write and retains that
parent even if unrelated administrator work happened in between. It does not
look at the latest speaker. Registered resume/board/schedule inputs can use the
same one-parent contract; missing mappings are not classified as owner work.
Outside derivative creation remains governed by the later central gate.

`RequestContextRecoveryStore` retains contexts and one conservative recovery
pointer per instance in the outbox database. Writes require the active slice-A
barrier and a supporting dispatcher. It stores no active token or lease. A restart
never restores active ownership or turns an old Hub turn into a live turn.
Existing-work reconciliation and the input resolver must still prove whether a
new input may enter the pane; a historical pointer is not that proof.

If an unmapped recovery can use the same instance/incarnation/work generation's
last outside scope, it creates a **distinct root**, with unknown actor and
`unproved-recovery` evidence. The old context id is diagnostic only, never a causal
parent or D1 release/grant reference. With no trustworthy scope it refuses that
work. A deliberately new independent owner root clears fallback eligibility;
known recovery jobs still retain their explicit parent. Prior contexts remain
unchanged, and none of this restricts unrelated future roots for life.

Prepared input eligibility and original receipt/Hub authentication must be supplied
by the trusted integration, not by an Agent claiming one of these ids. The durable
pointer does not attest to semantic isolation from old CLI history, raw shell or
untracked scripts. Same-user code/database rewriting remains outside this fence.

## Validation and rollback

[Evidence](../evidence/request-context-turns-s223/README.md) covers the real common
Daemon delivery path with synthetic pane probes, strict input proofs, runtime
fences, expected sender, steering, mapped/unknown recovery and durable pointer
reopen. No CLI, tmux, Fleet service, account, provider or model is started.

While OFF, ordinary startup creates no new recovery schema and rollback is a code
revert without migration. Activated fixtures and later cutover keep the existing
write barrier; a downgrade must use the later controlled drain. No delete/prune or
barrier deactivation path is added, and active ownership is never reconstructed
from historical rows merely to make an old executable run.
