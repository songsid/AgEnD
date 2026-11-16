M-3223 activation work in progress. Nothing in this checkpoint mounts roleAdmin or enables startup cutover. The full feature/card remains incomplete.

Review notes addressed locally:
- presentation/read retain the real session's fresh requirePerson → directory eligibility path; disabled-directory pins live on #4045.
- malformed/legacy audit actors map to a localized unknown label rather than breaking the entire page; raw actor JSON is not returned.
- role.audit-read events use the ordinary hub_audit table, with no retention exemption. The existing Hub retention timer invokes audit.purge with the current policy (default every 24 hours). A real audit-store test prunes these rows and verifies its checkpoint chain.
- admin overview separately acquires fleets.manage/join.manage operation permits, builds only authorized sections and reasserts proofs after projection. UI cards follow the scoped result; global settings remain hub.admin.

A read-only caller inventory identified an exposure-freeze transaction lacking a retained operation permit. The corrected fault injection targets the actual HTTP audit.append path and advances the owned app clock during exposure.frozen. Old source fails (returns 200); fixed source returns 503 and rolls back frozen_through. Earlier exploratory hooks targeted the wrong audit method and are not counted as proof. The fixed path carries hub.admin through HubCore.atomic before and after effects, and preserves owner checks. No live Hub was touched.

New unmounted helpers:
- Expiry resource effects share the existing local inventory and fresh bounded directory reads. Only group provenance is automatically suspended; manual/code provenance is not revoked by expiry. Automatic events name local-host. A real writer/ledger/audit fixture pins once-only expiry, exact lifecycle suspension, one epoch advance and rewind refusal.
- The allowed-list projection edits only timeless carried groups and preserves independent scoped/timed assignments and per-capability quotas. Its merge is pure and grants nothing.
- The internal allowed-list writer operation is sealed separately from ordinary role writes. Ordinary role requests still cannot edit T1 carriers. The internal path requires hub.admin, rejects own-person permission changes, own-team increases and missing teams, and observes new person targets. Proposed team/person inventories stay bound through commit. It is not exposed by a route yet.

Validation so far (overlapping runs, not additive): activation increment 41/41 across four files; writer/UI 54/54; pure shortcut 4/4; final internal-carrier cases 4/4 with 42 unrelated tests skipped. Source/test typechecks exit 0. All fixtures use owned SQLite/inert directory/loopback HTTP, no vendor CLI, real account, production config or browser. No screenshot claim.

Still required before a gate: complete the role-policy allowed-list HTTP adapter and old shortcut compatibility; production base/full migration plan, startup cutover/reopen, writer/expiry/timer lifecycle; regression matrix over activated and legacy admin callers; remaining role UI clarity/localization; real-Hub before/after desktop/phone light/dark EN/zh-TW PNGs; Hub skill update and exact-head CI/parity approval. Rollback after activation is forward-only roles-off, never restoring a saved policy or floor. Binary downgrade requires its separate schema/backup procedure.
