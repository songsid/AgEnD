# Slice E: central request contact gate and root release

Design-first checkpoint for S-225, based on release `d4d3299bd`. This implements
one dormant core from the approved [request-scoped design](request-scoped-contact-provenance.md),
not a cutover. Fable reviews the implementation. Every production caller remains
on the existing contact service until the final activation slice.

## Boundary and threat

The old gate reads an Agent's retained origin. One incorrectly classified input
can therefore hold unrelated later work. The new gate reads the immutable,
server-owned request context and exact operation captured by slices B–D. It must
never infer a request, identity, approval or parent from tool arguments, history,
correlation id, the latest speaker or a receiving Agent's retained origin.

The public method is an internal outbox-owned factory for a request-contact gate.
It requires dispatcher v1 and A's active compatibility barrier. Production
constructors still default to capability zero and install no new artifacts.
The gate shares the outbox SQLite connection and its existing ContactAuthStore.
No standalone database, new grant engine, network delivery or direct pane write.

The caller supplies an authenticated context, its exact operation binding and
NewOutboxDelivery; tool args never populate this port. Initial call currentness
and every later operation's policy/role/incarnation checks are separate from a
held decision's lifetime: a person may approve after the originating turn ends.
The gate's synchronous trusted host rechecks current managing-admin/approver and
current operation permissions/generations. D's known stale captured call cannot
be reclassified as a fresh unknown operation. Not-covered calls need a distinct
unendorsed unknown root prepared by the ingress/adapter slice, not the latest
admin root. E does not manufacture that evidence.

## Admission order

1. Require active barrier; validate context, lineage, binding and exact payload
   digest. Freeze/copy the operation before any decision. A retry must match the
   full admission image, including files, forwards, source key, both incarnations,
   verb and source daemon. Generated legacy ticket metadata is not sufficient.
2. Recheck the real operation's current policy and target/source incarnations.
   This check runs before every direct, grant, D1 and manual admission. Hub tool,
   audience, no-authority and side-effect constraints cannot be bypassed by D1.
3. Preserve any prior exact ticket's terminal/pending decision; an expired or
   declined operation never revives because another operation of its root passed.
4. Read a proven same-root release, if any. Otherwise owner/free-room work passes;
   restricted-room/guest/Hub work holds unless a current exact standing grant
   matches. A native person who is currently an admin of the root's source may
   pass the restricted-room check; Hub identity never substitutes for that person.
   Guest/unidentified input cannot claim owner ingress or admin action authority.
5. For a hold, derive the legacy display origin from the context actor only,
   never read/inherit lifetime origins. Known native people can match existing
   platform+user grants; Hub/unknown actors never become native-person grants.
   Persist one ticket and an immutable scoped companion in the same transaction.
   Return the existing held-result contract; projection/UI work belongs to I/J/K.
6. For direct admission, call B's admitWithRequestContext in the same transaction.
   It binds original payload and single-parent context without changing either.
   The result is outbox admission, never target completion.

An owner/root identity alone is not a go-ahead. Trusted ingress and turn admission
remain prerequisites, not something this policy core can reconstruct from a label.
Group Hub relay remains closed until its separately reviewed integration.

## D1 uses the existing committed ticket

The first Continue or matching standing grant releases contact approval for that
one request's mechanically linked onward operations. It does not approve model
actions, carry owner authority, replace identity/audience, or exempt Hub rules.

Use a scoped-operation companion keyed by source+operation and unique source key,
with context/root ids, immutable binding/admission digest, original delivery image
and ticket id. Derive D1 from an approved scoped ticket joined to its actual
B-bound delivery. There is no separate editable endorsement record or second
approval engine. A context id supplied without its stored single-parent lineage
is never a release proof. Unrelated same-person/history roots do not match.

Existing ContactAuthStore decides and consumes grants. Add a server-only scoped
decision hook so its transaction also admits through B and binds the scoped
operation. Scoped tickets refuse the legacy decision/admission path; a generic
legacy callback cannot silently strip the new context. Legacy tickets remain
legacy and are never adopted, grouped or replayed into the new engine.

The transaction contains: current actor/approver and policy/expiry/revision checks,
optional grant creation/use-count decrement, ticket state and audit, scoped
outbox admission, and the ticket-to-root release proof. Failure at any point
rolls back everything; no grant use or root release survives a failed admission.
Exact retries return the original receipt and cannot dispatch twice. Current
permission changes may refuse a new operation even when its root is released.

Pending scoped operations of the same root can be re-evaluated after a committed
release, without another person decision. Re-evaluation is bounded and checks
exact payload/currentness independently for each operation. Terminal, expired,
legacy or unrelated tickets are excluded. It uses the original committed root
approval as the audit reason, not a fabricated new human approval. A failed later
operation does not roll back the first successful approval or replay its send.

## Outcome and retention

Reuse notifyOutcomes and its transactional notice markers, sweep-driven expiry,
existing source-visible request lookup and queued/delivered/unconfirmed outcomes.
Notice admission and its marker commit together on the same database. Notices
are informational and never create context, root release or human authority.
No new timer, notification route or translated card is shipped in E.

A referenced scoped ticket is not removed by the legacy age-pruning query while
its root/work remains retained. Missing/corrupt ticket, companion, digest, context,
root lineage or delivery fails closed; it never yields a guessed release.
Retention/drain at cutover must remove dependent work before dropping its proof.

## Synthetic acceptance controls

- OFF creates no gate companion tables and cannot call the scoped gate.
- Mode controls: owner/free pass, restricted/guest hold, unknown and Hub cannot
  acquire a person grant or owner authority; retained Agent origin is irrelevant.
- Changed bytes/files/verb/key/generation/boot/context/root retries conflict;
  genuine retry uses one ticket and one exact delivery.
- Continue A→B releases proven B→C; same person/new root, forged parent and
  unproved recovery do not borrow it. Labels, actor, audiences and Hub refusals
  remain unchanged. Several pending same-root operations re-evaluate once.
- Current manager/approver removal, expiry, CAS and incarnation change refuse;
  optional grant matching uses both incarnations, live creator and use count.
- Failure after admission/grant/ticket write rolls all of them back; reopen and
  competing database connections preserve once-only admission and grant use.
- Decline/expiry never dispatch or release; a later same-root approval does not
  revive them. Legacy tickets cannot enter the new decision path or vice versa.
- Existing once-only outcome sweep and own-request tests remain green; scoped
  outcome admission failure rolls back its marker and can retry without duplicates.

## Scope and rollback

No new routing, ingress activation, card copy/layout, direct native receiver,
request-turn propagation, derivative side effects or Hub relay is enabled here.
F and later slices supply those integrations; I is the projection/decision seam.
Before cutover revert the dormant core. After activation keep A's startup barrier
and drain/cancel dependent operations before downgrade; never drop metadata or
replay uncertain effects to make an old executable work. This is not a sandbox.
