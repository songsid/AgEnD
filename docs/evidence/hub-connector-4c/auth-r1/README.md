# Authentication review R1

Six new assertions failed on the reviewed `582a00743cc0179ff821e15955f8cb2137b8d002` source (17 original tests unselected): app-token contexts could call each of four browser-only methods, denial ended only the app used during the denial, and missing-policy wiring permanently ended a live grant.

The browser boundary now rejects `mcp:` sessions and requires an active, person-bound browser session row in this directory epoch. A directory actor alone is insufficient. The four probes cover preview, approve, list and disconnect with a read-only app token; no new consent or disconnect can occur.

The lifecycle rule is explicit: a definitive account/policy denial sweeps every active app for that person in one transaction. The mounted policy writer must call the explicit all-grants hook inside its feature-disable transaction, before any re-enable; a control proves unused apps for different people remain ended. Another control fails the second audit append and proves the entire sweep rolls back. Missing policy wiring reports temporary unavailability and preserves the grant, like a directory outage. Stale in-flight identity checks do not revoke current grants.

Final focused result: **25/25**, source and test TypeScript programs **0/0**, and `git diff --check` passes. Commands are unchanged from the foundation packet. The previous foundation packet is historical at `582a0074`; the new manifest binds current inputs. Its three original reversals were not repeated, and no additional broad/native/browser/real-CLI campaign ran. The service and migration remain unmounted and unregistered.
