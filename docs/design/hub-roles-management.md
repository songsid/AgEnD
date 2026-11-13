# Hub management and retained issuer consumers

This S-129 slice follows the canonical consumer preparation in #3795. The
accepted phase-one design is `docs/hub-ux-review-m2902` at `9e0006256`.
These consumers accept the operation-owned management authority; the production
factory does not inject it in this slice. Startup cutover, role endpoints,
resource effects, expiry settlement scheduling and stream/member enforcement
remain required before activation.

## Authority at the service boundary

Pairing Create and Approve require `join.manage`; Revoke requires
`fleets.manage`. Owner selection proves `join.manage` before looking up an
unsigned-in person and rechecks before returning that selection. Company-join
configuration, invitation creation and code create/list/revoke consume the same
named permission. The protected company-join GET uses the same proof. Cached
session presentation is not permission. Legacy injected drivers retain only
their existing configured-administrator path.

Each proof belongs to the exact actor/session, canonical policy, transport
authorization epoch, directory method and mount lifetime. Services recheck after
awaits and required audit, and immediately before disclosure or publication.
Audits retain the actual acting person. Code creation/revocation explicitly pass
that person to the code audit callback rather than substitute the configured
root. Group-scope resolution charges the acting person's existing admission
slot; a directory suggestion is never an enrollment allowance.

The transport's final-publication guard snapshots the exact stored SQL bytes.
Parsing a valid row can reorder known keys, so its reserialization is not an
appropriate byte fence. The final proof still reads the previous authorization
image at the raised independent revision; any audit or nested write changing
the captured SQL image refuses. A failed write never rewinds the independent
floor. Revoke checks the old proof inside that staged transaction, then refreshes
after commit; it does not reject its own intentional committed epoch advance.

## First issuance and committed recovery

A separate `requireJoinIssuer` proof accepts only the immutable person recorded
by the server's authenticated approval. It does not invent a browser session or
accept browser-supplied role claims. It freshly checks that person's eligibility
through the same physical directory admission owner and evaluates current
`join.manage`. Canonical bytes, epoch, persistent clock, wall/monotonic lifetime,
assignment deadline, directory identity and operation lifetime remain fenced;
a failed proof stays retired.

Manual and code registration carry the actual approver through required audit
and the owning resource transaction. Pairing Claim obtains its own proof rather
than reuse an admission result. Company first Redeem rechecks after code-use
accounting and after required transport audit, then commits the exact provenance
and delivery receipt. Administrative permission loss cannot turn a pending join
into a new Fleet.

Already committed company Redeem follows the existing exact-receipt path before
requesting any issuer proof. It retains the original owner/session, key/PKCE,
Fleet/credential, provenance, delivery window and current-resource checks.
Issuer loss does not rewrite the approver, manufacture a new credential or
consume another code use. Existing code expiry/revocation recovery follows the
same path. Ordinary owner ineligibility or explicit resource revocation still
refuses. The configured root gains no role-derived self-use permission here.

## Verification boundary and rollback

Tests use actual sessions, resource/transport SQL, required audit and encrypted
company receipts with an inert eligible directory. Existing protected HTTPS
company/code/invitation tests retain their root-only composition. New auxiliary
issuer cases exercise actual service methods; they do not claim a fully mounted
canonical-role factory or a live directory, Fleet, account or browser run.

This is server-only preparation, so no new UI, PNG or user-facing skill applies.
Before activation, reverting it changes no deployed role marker or policy. After
an eventual activated Hub has auxiliary issuer records, do not restore an old
root-only reader or policy snapshot: use forward recovery or a coherent backup.

Review R1 pins the legacy configured-root guard even when an injected
`requireAdmin` accepts another directory person: code create/list/revoke,
company-join configuration and invitation creation all refuse without writes.
The configured root succeeds through each same valid operation. Removing only
that guard compiles and makes all five refusal assertions fail; exact source
restoration passes all 37 selected tests in three files and native test types.
Production bytes are unchanged; see the R1 evidence receipt.
