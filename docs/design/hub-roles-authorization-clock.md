# Persisted clock fence before role authority composition

The inactive expiry settlement exposes a clock assertion but also requires a
resource-effect adapter. The upcoming management factory needs a real persisted
clock fence before those effects are mounted. It must not construct a settlement
with dummy effects just to obtain that assertion.

The new read-only clock verifies the current role document's exact Hub, realm
and directory generation, the configured root, the committed cutover marker and
its historical digests, the three registered role schema versions, and the real
transport reader including its independent floor. It refuses time before either
the cutover or any retained settled-expiry time. Audit retention does not remove
those clock floors. Missing or malformed proof refuses without creating rows.

The cutover marker remains historical. Normal role edits, roles-off and a valid
directory-generation rebind do not need to rewrite it or match its original
converted-policy digest with today's policy. Current policy and transport
revisions must still cover the committed migration's minimums. The configured
root remains the same immutable root in this phase; this does not add a root
replacement operation.

The marker schema and existing digest validation are extracted unchanged into
one data-only parser shared with the original cutover. The new clock captures
its mount and transport reader, and rechecks SQL images after its callbacks.
It does not grant permission or replace operation-owned wall/monotonic budgets
and permanent proof retirement. A clock-floor refusal can later recover when
time is correct; an already-retired operation never revives from that recovery.

No production caller is added, no migration is registered, no timer runs, and
no resource-effect, management route, member lease or stream is activated here.
This prepares the next S-129 composition slice. It builds on #3795, #3802 and
#3805 and retains their parent-first/plain-sync/exact-head review requirements.

Tests use actual in-memory SQLite, audit, cutover and transport with an owned
synthetic independent floor. Settled-expiry rows are inserted explicitly to
test persisted reads; that is not an expiry-worker execution claim. A real
management issuer proof consumes the guard and stays retired after a later
floor failure even when a fresh proof can succeed. Existing cutover and expiry
tests retain their separate actual-effect/crash scopes. No directory, account,
browser, Fleet, native OS, pilot or new UI/asset/protocol behavior is claimed.

This slice writes no new state itself. Reverting the preparation before later
activation restores the old module composition; it is not permission to restore
an old role database, independent floor or policy snapshot after activation.
