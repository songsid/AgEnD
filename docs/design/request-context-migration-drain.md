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

Read stored ticket/policy JSON directly on the outbox connection, in one synchronous read transaction with a hard bound of 64 rows per table
(default 32), capped JSON bytes and a stable digest. Only an untruncated initial
page can be complete; subsequent pages are informational and never combine into
a migration plan. Check `total_changes()` before and after callbacks to detect
same-connection writes (including legacy hold/prune); `data_version` alone cannot
see these. Calling either `get()` or `policy()` may persist expiry or normalize
stale policy and is forbidden for this shadow. Return identifiers/status/digests, never message bodies or actor
identity inferred from names. An expired pending row can be classified logically
expired without rewriting its retained state.

- Pending legacy tickets retain their exact id, operation, payload, origin,
  decision revision. No E companion is added. Every unresolved legacy ticket
  is a named cutover blocker, even when inspection itself is complete.
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

F exposes synchronous inspection ports on the existing C/D registries rather than
refreshing a call from the latest context. A stale or disconnected daemon is not
an empty registry. A live launch's written MCP row still retains its context
until a matching positive launch exit, as D's contract states. A detached
lease is not retired. Thus a root used by a persistent launch may remain retained
until relaunch. Fleet proof leases and ledger rows cover late remote calls; remote
relay stamps are NOT an independently queried participant and no network read is
part of drain. A late remote call cannot resolve its retired Fleet proof. No recursive scan of
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
   Each owner advances a monotonic revision on insert, replacement and removal,
   including an insert/remove ABA. Re-reading validates these captured revisions
   without another registry scan; E rechecks durable rows in its transaction. It
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

Keep unresolved legacy holds visible and immutable. The source review found NO
safe end-to-end legacy continuation lane: legacy decide / applyStandingGrant →
Fleet host.admit → outbox.admit produces a context-less delivery; a C-bound target
has no admitted input for it. Calling beforeWrite(null) instead would guess from
the recovery pointer and is forbidden. F guards host.admit for a C-bound daemon
or exec target before creating an outbox row; the store transaction rolls the
decision back and leaves it pending (`request-context-legacy-decision-upgrade-required`).
Unbound targets retain the old path. No unsupported delivery is retried or replayed.

L must see zero pending legacy tickets and zero approved-undelivered/uncertain
operations, decided and consumed under the old engine, explicitly declined, or
expired; otherwise each ticket blocks cutover. Alternatively I/L must implement
an explicit per-ticket legacy-decision input proof: fresh unendorsed root,
unknown initiatingActor (existing reason `legacy-operation`), conservative
restricted ingress unless stored target policy was Free, evidence tied to the
ticket AND delivery ids, no parent and no D1. F does not implement that alternative
or infer anything from retained origins.

The raw shadow reads contact_auth_tickets.ticket_json/request_json,
contact_auth_policies.policy_json and contact_auth_origins.origin_json. It hashes
history only. Scope companions exclude already-scoped tickets from the legacy
inventory. Missing, malformed, oversized or changing data is incomplete.

### Concrete owners and fence sites

- Fleet's original WeakMap still captures exact arrival objects; a separate
  enumerable call-id index retains each call through actual response/handler
  completion. A daemon timeout does not clear the coordinator's pending effect.
- Daemon call maps expose references and revisions; refusal, response and timeout
  paths remove their own entry. C active-turn and recovery-pointer refs are distinct.
- Native grants and actual in-flight calls retain their captured roots, even if
  a grant closes while a call is completing. Exec captured runs plus raw unresolved
  WindowsAgent active ids block; an unknown raw run is never an empty inventory.
- Fleet pane proofs and owned launch ledgers persist until positive exit. Unknown
  launch inventory after restart blocks until the manager reconciles it; no scan
  of arbitrary state files or remote relay is used.
- Fence checks are synchronous at C apply (independent, steer, expected return,
  recovery and queued steer), daemon first-hop begin, pane proof mint, native grant
  and new native call, exec claim, E admission/continued/sweep/reevaluate inside its
  SQLite transaction, and context/recovery persistence. Later expected-return,
  Hub and derivative owners must register the same gate before accepting work.
- All eight families are mandatory. Uninstalled adapters, an owner that used a
  gate without an inventory, an unknown reference or an unreadable participant
  refuses the certificate. No production assembly installs these in F; L must
  exercise the complete assembly, including later work registries, before cutover.

A root's last conservative recovery pointer can remain indefinitely if no later
independent input supersedes it. That is retained GC evidence, not a permission
lock. F never deletes that pointer to make a proof pass. A retired root leaves a
fence tombstone so a late stale input cannot recreate its deleted context; an
explicit fence release is possible only while the root itself remains retained.

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

## 7. Fable design-review dispositions

- Legacy-lane question (a): §5 records the unsupported seam and per-ticket
  blockers; the actual legacy host guard refuses C-bound targets. Explicit
  legacy-decision roots belong to I/L, not an automatic F migration.
- Retirement question (b): §3 and §5 name the actual enumerable owners, Fleet
  index, launch-exit and recovery lifetime, and every synchronous fence site.
  Remote relay stamps are excluded from the local proof. All registries expose
  revisions, and a used gate without a registered reader blocks proof.
- Shadow correction: §2 requires one bounded read transaction, raw columns,
  forbidden get/policy calls and same-connection change detection. Paged results
  are incomplete; a pruned/changed snapshot is never an applicable plan.
- Implementation risk and rollback: no production caller installs the new gates,
  readers or fence service here. Revert this dormant slice before L without data
  migration. After L, §5's barrier-preserving drain order remains mandatory; an
  unknown participant blocks GC and must never become an agent-wide permission
  lock or guessed zero-reference assertion.
