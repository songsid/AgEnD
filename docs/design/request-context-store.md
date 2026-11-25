# Request-context immutable storage (slice B)

This extends the [compatibility bridge](request-context-compatibility.md) for
[request-scoped contact provenance](request-scoped-contact-provenance.md). It is
internal dormant infrastructure. No production ingress calls the new admission
port; no new permission, turn binding, approval, label or capability is enabled.
All ordinary production outboxes remain dispatcher 0 and create no companion
schema. Later slices must authenticate ingress and prove the current turn before
using these records. A context id or a successful read never establishes authority.

## One transaction, one immutable tree

`DeliveryOutbox.admitWithRequestContext` requires an intact active compatibility
barrier and an explicitly supporting dispatcher. It commits these together in the
existing SQLite outbox transaction:

1. The immutable v1 context, with its canonical JSON digest.
2. The existing delivery and its normal reply/forward bookkeeping.
3. A nullable delivery reference to the required context.
4. The operation companion: source/operation identity, exact source key, context,
   source and target incarnations, actual verb, payload digest and delivery id.

The companion tables and delivery reference column are created lazily inside that
same transaction. An initial failure rolls the schema and records back together.
No second database, prepare/commit protocol or new workflow state is needed.
Observation events are emitted only after the outer admission commits.

Root references have no parent. A descendant must name exactly one existing
parent in the same root. Its actor, ingress, original evidence and source/return
audiences must match that parent; only its own source instance/incarnation changes.
This prevents a child from substituting owner ingress, a convenient identity or a
new audience. A missing parent or multiple parents refuses without creating work.
An unrelated new root does not inherit the agent's earlier context.

Contexts are append-only. Reusing an id requires the identical canonical JSON.
The store validates shape and persisted lineage, not whether the named original
receipt is genuine. That authentication belongs to later server ingress/turn
integration; these internal methods are not accepted web or tool arguments.

## Retry and required metadata

The operation identity is `(source instance, operation id)`. Its source key and
delivery id are unique. A retry returns the original delivery only when context,
incarnations, verb and full admission snapshot match. JSON object key order does
not change the digest; changed bytes, source boot, target/session, correlation or
mode do. The API intentionally does not rebuild volatile envelope values on retry:
callers must retain the original admitted snapshot. Later ingress integration must
resolve retries to that snapshot rather than generating fresh ids or timestamps.

An ordinary admission cannot reuse a scoped operation or source key, and a scoped
admission cannot adopt an earlier legacy delivery. The delivery reference remains
a requirement even if its operation row disappears. Reads verify context/operation
digests, binding and the actual stored delivery payload. Partial schema, missing
required records or a mismatched delivery is unavailable; it never means permission
to retry without context. Historical reads do not revive a turn or a consent lease.

No D1 endorsement or ticket decision is written here. The later gate slice will
reference the existing committed approval on the root in the same transaction.
Neither a stored actor nor a header-like body becomes a human go-ahead.

## Recovery and retention

Before-commit process exit leaves no new context, operation or delivery. After
commit, even if the acknowledgment is lost, retry reads the same delivery once.
A competing SQLite writer causes an ordinary unavailable/locked failure; releasing
the lock permits the same operation to commit once, without a partial context.
No retry timer or blind message resend is added.

Foreign keys retain contexts and deliveries while their operation companions
reference them. There is deliberately no TTL pruning or deletion API here. Later
drain/cutover work must settle dependent operations and define retirement before
removing these references or the compatibility barrier. This does not claim
power-loss durability beyond SQLite's existing WAL/synchronous configuration.

## Verification and rollback

[Retained evidence](../evidence/request-context-store-s222/README.md) covers immutable
roots, exact retries, missing metadata, lineage, transaction failure, competing
connections and actual data-only child-process exits on both sides of commit.
No Fleet service, backend, vendor account, provider or model is started.

While the production flow is OFF, a code revert requires no data migration because
ordinary startup creates none of this schema. Fixture activation, and later real
cutover, intentionally prevent old dispatchers opening the database. An active
downgrade requires the later controlled drain contract, never silent schema repair
or dropping provenance to make old code continue.
