# S-226: legacy shadow and root-drain evidence

Current R1 source/test commit: `a80c1ce491ba23f0e6ec1264343cbd63e636474d`.
Initial source/test commit: `2112f28ffca9871b4b81cb58ac7db7d4cf2abac2`.
Base: merged E, `80e9ffcd12801a60dbbc9fbb3e9f3a658e880efa`.
[Design and review dispositions](../../design/request-context-migration-drain.md).
Exact commands, digest rows, ten guard-reversal results and limitations are in
[verification.json](verification.json). Logs remain private.

## R1 correction result

All six review items are addressed. Explicitly uncovered rows reference no root;
malformed/unreadable state remains unknown. The fence belongs to the durable Fleet
identity under its current coordinator lease, and resume rotates the epoch after
restart. IPC rows bind instance/boot/response and exact connection; replacement
and disconnect purge them. The shadow can scan 10,000 rows/table within a separate
16 MiB/table byte budget, in one transaction. Offline panes inspect only their
registered local manifest/ledger, with no attachment or endpoint call. The legacy
upgrade refusal is localized, with a separate stable machine code.

The new regressions on reviewed source fail in 13 cases (one passes, 96 filtered
out), across six files. Restoring R1 gives 734 passed / one existing skip across
52 affected files, including dashboard i18n. Test typecheck and build pass. The
JSON records the exact command, base, source binding and finding-by-finding
resolution. Initial evidence below is retained as history, not a repeated claim.

## Initial result

The legacy decision lane produces context-less deliveries that a C-bound target
cannot safely consume. The shadow reports each unresolved ticket as a cutover
blocker. The actual Fleet legacy decision callback refuses C-bound daemon/exec
targets before admission; its transaction leaves the ticket pending. An unbound
legacy target retains its one-time decision lane. No parent is guessed.

Root retirement now has a durable per-root fence and an owner/revision-bound
certificate, backed by actual C/D reference views. Missing inventories and
unknown work refuse it. Pending delivery, held ticket, active turn/call/grant/run,
retained pane proof/ledger and recovery references block collection. Written
ledger rows survive detach; pending native calls survive grant closure. The
certificate is consumed by E inside its existing atomic retirement transaction.
A changed participant rolls the entire retirement back. A retired root leaves
a tombstone so stale input cannot recreate it.

The main affected run passed 708, skipped one existing test, across 51 files.
After the final native-call cleanup adjustment and restoration of all mutants,
142 tests across eight directly affected files passed. Source/test typecheck,
build and changelog checks pass. All ten targeted reversals fail their tests:
missing participant, revision ABA, context/turn/recovery fences, legacy admission,
detach retirement, pane-proof retirement, pending native-call retention and
same-connection snapshot changes. These are isolated in-process/synthetic tests,
not a native CLI or remote-host coverage claim.

## Safety and rollback

Production remains OFF; there is no installed production drain assembly or
migration action. Shadowing writes nothing, including unread expiry, stale policy,
notice and origin bytes. It never calls get/policy or reads an origin as authority.
Only an initial bounded complete snapshot is informationally complete; pagination,
corruption or a changing snapshot is incomplete, never permission to apply a plan.

Before L, revert this dormant slice without data migration. After activation,
keep A's startup barrier and first drain/resolve dependent work as specified in
the design. Never cancel an uncertain effect or erase a recovery pointer to make
GC pass. I/L still own an explicit compatible per-ticket legacy input lane, if
needed, and assembly/validation of every remaining expected-work owner.

No UI/CSS/captures changed. No live fleet, account, provider, native CLI, remote
host, process cancellation, activation, backup, restore or downgrade was used.
