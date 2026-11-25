# Slice F: migration shadow and request-root drain

Design-first checkpoint for S-226, based on `80e9ffcd` (merged E). This slice is
scratch-only and dormant: no live migration, cancellation, origin rewrite,
backup restore, feature activation or new permission switch. Fable reviews it.

The approved parent contract is [request-scoped contact provenance](request-scoped-contact-provenance.md#8-migration-peers-and-rollback).
E's `rootRetired` callback currently refuses by default. F supplies the concrete
proof boundary for that callback; L still owns installing the complete adapters
and enabling anything. I follows this slice and owns the same-card server route.

## 1. Two outputs, neither grants authority

1. A read-only legacy ticket/grant migration shadow: exact stored-row digests,
   classification, and concrete blockers. It must not expire a ticket while
   inspecting it, normalize/write a policy, copy an origin union, create a root,
   group operations by a person/correlation, consume a grant, replay an admission,
   decide a ticket or send a notice.
2. A root-drain fence and proof for explicit retirement. It proves only that a
   particular retained root can no longer acquire work and has no live references.
   It never approves a contact, clears an Agent's permission state or treats a
   later admin message, idle pane, timeout or answer publication as completion.

A missing/unknown participant blocks retirement, not new unrelated requests.
The certificate is process/owner/fence-bound and cannot survive a restart or be
used as a human receipt. A metadata row or timestamp alone is not a certificate.

## 2. Legacy shadow

Read stored ticket/policy JSON directly on the outbox connection, with bounded
paging and a stable digest. Calling `get()` would persist expiry and is forbidden
for this shadow. Return identifiers/status/digests, never message bodies or actor
identity inferred from names. An expired pending row can be classified logically
expired without rewriting its retained state.

- Pending legacy tickets retain their exact id, operation, payload, origin,
  decision revision and existing one-time decision path. No E companion is added.
- Approved/delivered operations retain their original receipt/idempotency. A lost,
  missing or uncertain delivery is reported as unresolved, never resubmitted.
- Declined/expired tickets stay terminal. A matching new grant or a new request's
  D1 release cannot revive them.
- Grants retain their exact person key, transport metadata, source/target,
  incarnations, verbs, expiry, remaining use count, creator and policy revision.
  Evaluate current grant-manager rights and current incarnations separately;
  classify expired/spent/stale/revoked/malformed rows without silently repairing
  or discarding any stored field.
- Origin rows remain history, with count/digest only. They do not populate request
  identity, root lineage, permissions or receiver state.

A shadow result is bound to the exact database snapshot and current runtime/policy
revision. If it changes, re-read; never apply a stale plan. This slice provides no
“apply migration” method. In particular it does not adopt a legacy pending ticket
into E or manufacture a shared root from several old tickets.

## 3. Drain evidence and ownership

The coordinator-owned drain service registers typed evidence readers for every
required source: admitted/queued delivery, scoped held decision, actual input and
turn, local in-flight tool call, native exec grant/run, retained persistent-pane
call/proof ledger, recovery pointer, and expected-return/Hub/derivative work.
Readers run synchronously against the actual owners; they return owned reference
ids and current generation, or explicit unknown/unavailable. Caller text, tool
arguments, a boolean “idle”, correlation ids and the old origin union supply no
references or proof.

F will expose bounded inspection ports on the existing C/D registries rather than
refreshing a call from the latest context. A stale or disconnected daemon is not
an empty registry. A live launch's written MCP row still retains its context
until that launch ledger is retired, as D's contract states. No recursive scan of
an arbitrary state directory is permitted; only registered owned launch files.

Expected-return/Hub/derivative readers not yet installed by their owning slices
must report unavailable. They cannot be replaced by a default empty list. A/L
storage capability and an exact current manager/runtime owner remain mandatory.
Before enabling L, the adapters and their completeness controls must be exercised
through actual paths; F's scratch certificate is not a native-coverage claim.

## 4. Fence, then prove, then retire

1. Under the current coordinator owner, establish an opaque per-root drain epoch.
   It fences new input, continuation registration, native call/grant/proof minting
   and scoped delivery admission for that root. Other roots and read-only status
   work continue. The root remains retained; no data is deleted by fencing it.
2. Existing references finish under their original context or are explicitly
   cancelled through their existing authorized owner. F never presses a key,
   stops a process or pretends an uncertain outcome is terminal. Partial effects
   retain their ids and are not repeated.
3. Snapshot every required participant under the fence. Any live reference,
   missing participant, malformed row, changed owner/generation or incomplete
   inventory means “not drained”, with a concrete reason.
4. Only a complete zero-reference snapshot can mint a synchronous retirement
   proof. It captures the manager owner, fence epoch and participant revisions.
   Re-reading it must validate all of those and all zero-reference results; it
   does not trust its age. Releasing/replacing the fence invalidates the proof.
5. Pass that proof to E's `retireRoot`, which still checks terminal deliveries,
   unread expiry, 30-day terminal retention, pending tickets and reply/recovery
   references inside the SQLite transaction. Its final proof check prevents a
   changed participant from committing partial retirement.

A conservative recovery pointer must not be erased just because a turn ended.
It can still govern an unproved resume. A new verified runtime/conversation or
an independent admin input may supersede it only through C's existing rules.
Otherwise it blocks retirement. Drain is not a blanket “clear origin” escape.

## 5. Cutover and rollback seams

Keep unresolved legacy holds visible and immutable. A new engine cannot route a
legacy operation through an unsupported input adapter by claiming its parent is
known. Untracked executable old work must finish or be explicitly cancelled under
the old engine at a verified input boundary. The cutover assessment must name any
legacy-decision continuation lane that is still needed; missing support holds
that operation for the old compatible path, never guesses a new root or replays
it. I/L must settle that routing before they enable it; F does not reinterpret
old approvals as E root release.

Rollback first fences new scoped admissions and registrations, drains or
explicitly declines/cancels dependent executable work, and preserves notices and
audit. A's startup/storage barrier remains while any new-format work can execute.
No barrier deactivation, live backup, DB restore or downgrade is performed here.

## 6. Synthetic acceptance

- Shadowing before activation creates no new artifacts and leaves ticket,
  grant/use count, policy, origin, outbox and notice bytes unchanged, including
  unread expiry. Corrupt or truncated scans are explicitly incomplete.
- Live/stale/expired/spent/revoked grant controls preserve exact stored contracts;
  unchanged snapshots compare equal and any changed payload/policy/owner conflicts.
- No root creation/admission/union read or replay during shadowing (reversals).
- A drain proof requires all participants and current owner/fence. Active turn,
  queued input, pending/uncertain native run, local call, written retained ledger,
  recovery pointer and expected derivative each independently block it.
- Known C/D registry objects supply the references; no latest-root refresh. Empty
  only counts after a positive owned end/ledger retirement, never idle/timeout.
- New same-root work cannot register under a fence; unrelated work still can.
  Owner/boot change, participant replacement or fence release invalidates a proof.
- Retirement through E rolls back on a changed proof and cannot remove referenced
  context or notices. Default/uninstalled production adapters refuse proof.

No UI or renderer change belongs to F. Public evidence uses synthetic names and
source hashes only. Production stays OFF through this slice.
