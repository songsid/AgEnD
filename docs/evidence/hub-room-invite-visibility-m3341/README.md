# Room invitation visibility (M-3341 A3)

A manager's agent picker used the grant-filtered catalog, while the invitation service accepted any published exposure ID. A direct request therefore created an invitation and disclosed the agent's name and owner even when search returned nothing.

The invitation now uses the same catalog visibility function, with the invitation effects inside its synchronous permission transaction. Current grant, directory and session proofs enclose the commit. Explicit ID batches refuse as a whole with generic `not-found`; team expansion silently keeps only visible agents. It reports no omitted count or excluded owner, and creates no hidden invitation or owner request. Own published agents still join immediately; other visible agents still require their owner's existing room-only consent.

The approved design is copied from review snapshot `512fce83c` into `docs/design/hub-room-ask-owner-for-agent.md`; only its status paragraph is updated. A3 precedes the owner-request and discovery UI slices. No schema or wire change is included here.

## Verification

The new HTTP/SQLite regression failed before the guard: the hidden ID returned 200 instead of 404 (two controls passed). It now covers seven cases: hidden-ID non-disclosure/no effects, visible-owner consent, own-agent add, mixed explicit-batch rollback, hidden-only team equivalence to an empty team, mixed-team filtering, and grant revocation during an effect before commit.

- `vitest run tests/hub-room-invite-visibility-m3341.test.ts tests/hub-room-consent-track-c.test.ts tests/hub-room-integration-r3.test.ts tests/hub-room-candidates-r3.test.ts tests/hub-s3b-server.test.ts --maxWorkers=2`: 60 pass.
- `vitest run tests/hub-grant-subjects-m3016.test.ts tests/hub-team-grants-track-c.test.ts tests/hub-room-teams-integration-r3.test.ts --maxWorkers=2`: 75 pass.
- `vitest run tests/hub-compose.test.ts --maxWorkers=2`, alone: 142 pass. Its sealed-Hub restart fixture now grants the manager access before inviting, matching the owner-consent fixture. The production source is unchanged by this repair.
- Source and test `tsc --noEmit`: no errors; test types rechecked after the restart fixture update.
- `validation.json` records the narrow negative controls and restoration result.

All people, rooms and IDs in the fixtures are synthetic. These checks use inert directory callbacks and scratch HTTP/SQLite only. Bilingual desktop/phone captures belong to the later UI slices; this PR adds no UI.

Rollback is a code revert; there is no migration or stored-data conversion.
