# Request-context v1 compatibility bridge

Slice A of [request-scoped contact provenance](request-scoped-contact-provenance.md).
This is dormant infrastructure: no caller advertises the new capability or enables
request-scoped dispatch. Existing production `DeliveryOutbox` constructors omit the
new trusted option and remain dispatch capability **0**. No barrier is installed
by opening an ordinary database. No UI, agent tool, config or permission changes.

## Contract and readiness are different

`request-context-protocol.ts` defines the v1 single-parent/root reference, normalized
actor kinds, opaque audience references and exact-operation digest binding. Strict
shape validation rejects extra authority/approval claims and unsupported versions;
it does not authenticate evidence, prove parentage or grant permission. Later
admission must resolve the original receipt/Hub proof and enforce the actual turn.
Transport adapter ids do not become person identities. Unknown Hub recovery may
retain Hub restrictions without pretending to have an authenticated asker.

Recognizing `request-context-v1` is not permission to declare a dispatcher ready.
The bridge's internal constructor option is omitted by every production caller.
Only the complete future dispatcher may explicitly pass capability 1 at controlled
cutover, after the receiving/continuation/peer and downgrade proofs exist. Neither
a web/tool/config field nor a database marker can select that capability.

## Persistent write barrier

A numeric `PRAGMA user_version` is insufficient: previous versions unconditionally
write their own version while opening. A new optional JSON/companion field is also
insufficient because old code ignores it.

Future explicit activation creates `request_context_compatibility` and six
persistent BEFORE INSERT/UPDATE/DELETE guards on `deliveries` and
`delivery_attempts`, in one SQLite transaction. Each guard requires the
connection-local `agend_request_context_dispatch_version()` to return version 1.
A null function result is treated as unsupported.
An unchanged old executable has no such function, so preparing its write fails,
even when an UPDATE matches zero rows. Read-only status queries remain readable.

The new bridge registers capability 0 by default and checks active compatibility
**before** legacy initialization or recovery. That explicit check is essential:
a known capability-0 SQL function is not evaluated for zero matching rows, so a
trigger alone would not reject an empty recovery. Unknown versions, orphan guards,
missing/changed guards or malformed markers refuse opening; no empty replacement
queue or silent repair is made.

OFF means no persistent guard definitions, not a false SQL WHEN condition. SQLite
resolves a missing function before a false condition can skip it. Activation needs
both the trusted capability and its matching connection-local function. It is
idempotent only for an intact active barrier. A failed activation rolls back the
marker and all guards. Prepared legacy statements are invalidated by the schema
change and cannot write through a pre-activation cache.

The production startup helper opens and recovers the outbox before publishing it
and before starting daemons. Old recovery prepares a guarded delivery UPDATE;
its transaction rolls back preceding receipt changes, and startup does not
publish an outbox. Claim and begin/admit paths also mutate guarded tables before
input can be sent. The storage barrier covers those actual old paths rather than
asking old code to understand a new warning.

## Evidence and supported scope

[Retained evidence](../evidence/request-context-barrier-s221/README.md) executes the
original published 2.3.3, 2.4.0-beta.22 and beta.23 outbox modules and startup
recovery helpers under Node 22 with compatible SQLite 13. No launcher, daemon,
backend, account, IPC or network operation is started. The child runtime rejects
process/network APIs and receives only scratch environment variables.

For each version: OFF/queued is a positive dispatch-port stub control; active
queued, claimed/in-flight and empty-delivery cases refuse recovery/admission and
keep delivery/attempt/receipt rows intact. Active cases never publish the startup
outbox or reach the delivery-port stub. This proves the named published targets,
not arbitrary modified executables or every historical release.

The guard is a compatibility fence, not a sandbox or attestation against the host
operator. A process able to edit the database or supply arbitrary trusted code
can remove it. No secret or external authorization is stored in the version
marker. Existing SQL-open error handling treats incompatibility as unavailable,
not evidence that the file is corrupt; it must not quarantine or replace the DB.

## Rollback and later slices

Slice A alone installs no barrier in production, so reverting it preserves the
legacy data format and dispatcher. Once future cutover activates the barrier,
old binaries and this default-off bridge must refuse; do not turn that refusal
into a schema repair or a blank outbox.

A deliberately supporting dispatcher must first drain/cancel dependent versioned
work before a controlled rollback can remove the guard. There is intentionally
no deactivation/reset API in slice A: the work-record/drain contract belongs to
later slices. Before that cutover exists, activation is exercised only in owned
fixtures. Keep the new flow off until slice L; this bridge is not itself a go-ahead
to enable it.
