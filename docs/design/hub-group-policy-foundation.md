# Hub group permission foundation

This first implementation slice of [#3298](https://github.com/songsid/AgEnD/issues/3298) is an internal library. The reviewed design is [clear](https://github.com/songsid/AgEnD/issues/3298#issuecomment-6700947326). Nothing composes this library, applies its migration to a running Hub, enables group permissions or adds an HTTP route yet. The feature remains experimental and off by default. Ordinary directory sign-in and representative-agent execution are unchanged.

## Policy and directory facts

`group-policy/model.ts` defines `ask_agents`, `publish_agents`, `pair_fleet` and a bounded fleet limit. Direct group permissions combine by union; fleet limits use the maximum, never a sum. Per-person denies win. There is no outside-group person allow, nested-group mode, primary-group inference or sign-in permission. A new pairing allowance starts at one fleet; larger values require explicit admin selection in the later Settings editor.

Rules identify an AD security group by realm and objectGUID. The DN is a label. `HubDirectory.resolvePolicyGroup()` selects a group inside the configured base and rechecks it by binary objectGUID on the same verified connection. Distribution groups, ambiguous results and replacement during selection refuse. `readPolicyGroups()` searches the person's immutable identity with the critical extended-DN control, OID `1.2.840.113556.1.4.529`, Flags=1. Membership GUIDs come from that response; there is no DN-to-GUID join. Renaming a group preserves its identity; reusing the old DN does not inherit permission.

This capability is available only for the AD profile on the domain-controller LDAPS port 636. OpenLDAP/entryUUID and Global Catalog endpoints cannot enable a policy or save groups. They retain ordinary sign-in. The critical control is used only by the new permission lookup, never by the sign-in or eligibility operations.

Missing, empty, malformed, ranged, referred, unsupported or failed membership results are **unknown**. In particular, ldapts normalizes an omitted requested attribute to an empty array, so an empty array cannot establish negative membership. The action refuses without durable suspension. Only complete GUID-bearing results establish absence of a configured group. A successful lookup containing other groups is a complete-negative control. Current ineligibility by immutable person ID is separately represented. No positive result is cached.

## Persistence and audit

`group-policy/store.ts` provides an explicit migration and bound store. The singleton belongs to one Hub, realm and directory generation; missing, corrupt, newer or mismatched state never resets to permissive defaults. `never-enabled` preserves legacy behavior; `enabled` evaluates rules; switching an enabled policy off records `suspended`, with no transition back to `never-enabled`.

Policy changes require a revision compare and swap. Decisions capture caller-owned person/resource data before awaits and recheck current caller, server generation and policy revision after directory work. Work is bounded per person and globally. Unknown results only append diagnostic decision evidence; this slice changes no session, exposure, link or quota state.

Each policy change and group decision appends to the existing hash-chained audit and a same-transaction evidence row. The audit reason binds the evidence bytes by SHA-256. Evidence contains the person, capability, matched group GUIDs, policy revision, directory generation, observation time, resource IDs and request correlation. It contains no password or raw membership list. Required audit must finish synchronously; a throw, thenable or authority loss rolls back and withholds the result. Event retention follows its parent audit row.

## Composition still required

The library does not authenticate administrators, confirm previews, resolve browser-supplied group labels or enforce resource state by itself. Later composition must require the existing eligible Hub admin, resolve/recheck selected security groups, confirm the exact impact preview, and atomically fence revision/revocation and resource changes around a save. It must route all protected actions through the decision and preserve independent local consent and exact owner grants.

The enable preview must name existing grant-holders outside `ask_agents` groups. The configured Hub administrator also needs a matching group for Chat; infrastructure administration is independent. Existing manual exposure revisions are grandfathered exactly as reviewed; new or revised publication requires group permission. Unknown never causes suspension; a complete negative or explicit policy change does, with explicit resume. Welcome, Settings, quick-pairing proof/capacity, notices and owner revoke are later slices, not claims of this library.

Acceptance uses an isolated loopback TLS/LDAP peer, real ldapts BER and SQLite/audit. A test-only connector redirects the requested port 636 to an allocated loopback port; production has no redirect or verification bypass. No real AD, accounts, pilot, vendor API or live fleet is used.
