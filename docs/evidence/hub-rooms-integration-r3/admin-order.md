# Administration order integration

Source52de6fd09 plain-merges TrackU1 ea9cc1a9c7f2aec902445570b0bcf18f3168c633 into the prior integration8ec16e975. The single panel-hub conflict removes the old trailing duplicate Rooms placement and moves the existing assistant mount to the marked slot. Its `room-assistant-v1` plus `assistantAdminV1` gate is byte-identical.

The combined order is Let colleagues join → Rooms → Room assistant → Connected fleets → pairing. The existing group-permissions entry still precedes these when applicable. The current rig has no companyJoin service, so its visible order begins with Rooms and manual pairing stays unfolded as previously documented.

33/33 across the existing hub-admin-entry-ui and hub-assistant-admin-ui suites pass with `nice -n10 node_modules/.bin/vitest run tests/hub-admin-entry-ui.test.ts tests/hub-assistant-admin-ui.test.ts --maxWorkers=2`. A scoped source check confirms ordered placements, one Rooms and one Assistant mount, and the retained capability gate. Diff whitespace is clean. This move adds no server/schema change; no new native build or broad campaign was run.

The12 PNGs in revision1 remain bound to their earlier source and are not claimed as captures of this move. The next screenshot refresh will include the pending TrackA account-status copy and TrackU2 Name/Save alignment together. C invitation/Team services and full S142 acceptance remain outstanding.
