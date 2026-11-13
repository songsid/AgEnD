# Hub roles: server foundation (M-3010 / S-126)

This is the first server slice of [the accepted roles design](https://github.com/songsid/AgEnD/blob/f9d969f07/docs/design/hub-roles-permissions.md), including the five clarified semantics in A.1–A.5 (decision 24c93422, #3743 item 2).

The new `src/hub/roles/` modules provide a strict document parser, pure decision function and in-memory conversion from the existing group policy. They have no startup, storage, route or UI caller. Existing authorization continues through the group-policy implementation. Shipping these helpers does not activate roles, perform a migration or grant a permission.

## Model and evaluation

- Twelve fixed permissions; three editable role defaults except the immutable built-in administrator. D7 defaults are 8 / 2 / 1 fleets. Delegated ask approval is absent from every default.
- Management permissions require a person subject and Hub scope. Validation follows assignment references too, so a role edit cannot give an already-assigned group management permissions. `hub.admin` is reserved to the built-in administrator.
- `rolesActive` controls team/management assignments independently of the self-use `state` and `everEnabled` latch. Off keeps current self-use grants, limits and denies. It neither restores a snapshot nor removes stored assignments.
- Self-use ignores team scope. Team actions require a target person, fresh target eligibility and, for a group scope, the target's immutable group membership. Distinct scopes are never combined into one grant.
- Root management is virtual and requires the root's eligibility. Root self-use is evaluated from ordinary assignments; conversion creates no such root assignment. The once-only root self-use activation belongs to the later audited writer.
- `never-enabled` returns `legacy`, including for pairing. Existing legacy call sites must keep their current manual-versus-automatic behavior. Unknown facts never justify an authoritative removal. The ordering of legacy/suspended/unknown/person-denied self-use follows today's evaluator.
- Assignment starts/expiry use an injected clock, and overlapping fleet limits combine by MAX. Decisions include matching assignment IDs and earliest matching expiry. Results and their ID arrays are frozen.

`RolePersonFacts` accepts a complete group observation or an eligibility-only observation. Person assignments and root management can use eligibility alone; group assignments and scoped targets require complete membership. If an unobserved relevant group could alter the quota/scope, the decision stays unknown even when another assignment has a known grant. The pure function checks identity, realm, shape and future timestamps. **Its result is not an operation permit.** Live callers must bind observations to their own fresh read interval and capture/recheck policy, session, directory and authorization generations around every await/effect. Owner ask grants remain a separate AND gate.

## Conversion boundary

`convertGroupPolicy` requires an explicit `rolesActive` choice and migration metadata. It preserves realm, generation, revision, state, derived latch, denies, every group rule and that rule's exact 0–8 fleet limit. Full self-use maps to Member; the other seven bitsets, including the empty one, use stable carried-over roles. Assignment IDs and ordering are deterministic. `assignedBy`/`assignedAt` are conversion metadata; no existing Fleet approver or resource provenance is rewritten.

This helper does not provide idempotent SQL cutover, a rollback floor, migration marker, resource suspension, pending-join consequences or audit. Those must commit together in the later activation slice. Existing policy readers still reject this new document shape. Do not write it into the active table until all readers and final synchronous guards are converted together.

## Remaining server slices

1. **S-127:** writer delegation per permission/scope/quota/expiry; no self increase; preview/CAS; atomic audit/notices and root self-use activation.
2. **S-128:** atomic, repeatable cutover with the old snapshot, resource/provenance/pending-join consequences, independent floors and downgrade refusal; forward-only roles off.
3. **S-129:** live operation permits, management route mapping, second-admin directory proof, issuer proof before first issuance, and role loss across leases/notices/SSE. Committed exact redemption remains recoverable.

Team roster/usage and delegated request approval are later phases. No UI or browser assets change here; SKEW, directory wire, container, Windows and live-account evidence are outside this pure slice.
