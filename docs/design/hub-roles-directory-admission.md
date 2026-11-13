# Hub directory admission before role authority integration

This S-129 preparation builds on the canonical consumers in #3795 and issuer
consumers in #3802. It does not activate roles or inject the management authority
into the production factory. Cutover, real resource effects, expiry settlement,
management routes, member leases and disclosure streams still need integration.

## One physical owner

The HTTP core and group-policy store previously owned separate directory-read
counters. Several pairing and administration calls bypassed both. A management
repair proof also cannot depend on constructing an operational policy store
whose strict directory-generation binding is the thing being repaired.

Each mounted Hub now creates one independent admission owner and passes it to
HTTP eligibility and owner lookup, sign-in, policy and grant reads, pairing,
pairing notices, administrative group resolution and preview, and the mounted
directory proof source. The existing limits remain four concurrent reads per
person or normalized login key, and 32 total. Login keys are hashed and use a
separate namespace because an unsigned-in login does not yet prove a person.
The existing sign-in failure throttle remains separate and unchanged.

One slot covers the full callback promise, including the directory driver's
physical close. Cancellation, timeout or mount retirement does not free that
slot early. Fencing refuses new admissions; drain waits for every admitted
callback before the directory client and database close. An admission or a
completed callback supplies no authority: existing callers still fence their
own actor, session, directory, policy, clock, result and effect.

Standalone injected test/service compositions retain a local owner when none is
provided. The production mount passes the same owner everywhere. Existing error
classes are re-exported from their old module, preserving `instanceof` and the
current backpressure/unknown/refusal handling.

## Narrow legacy repair reader

The management-only reader retains exact SQL bytes for the same Hub and realm
when a strict legacy group document is still `never-enabled`, even if its
directory generation differs. It neither rewrites that generation nor creates
or migrates a row. The ordinary canonical reader remains strict.

Enabled or suspended legacy documents, every mismatched role document
(including roles-off or never-enabled), foreign/missing/malformed rows and a
retired mount refuse. Both sides of the SQL read check the captured mount.
This helper is not mounted as an authority in this slice; it prepares the
configured-root repair path for the later management integration.

## Verification and rollback

Tests cover shared four/32 admission, login case and namespace isolation,
physical drain and fencing, unknown/rejected work, exact legacy repair and
strict role refusals. Actual initialized scratch Hub/HTTPS tests cover shared
HTTP/pairing/sign-in admission and teardown order with an inert directory.
Selected guard removals must compile and fail semantic assertions, with exact
source restoration. No real AD, account, Fleet, browser, native OS or pilot
operation is claimed. This server-only change has no new UI or asset imports.

There is no migration, policy write or independent floor change. Reverting this
preparation before role activation restores the previous admission composition;
do not confuse that with permission to roll back an eventually activated role
database or its monotonic authorization state.
