# Directory administrator API checks

Run from this checkout. Stop any other source writer/checker before running reversals:

```sh
npx vitest run tests/hub-compose.test.ts tests/hub-directory-settings-control.test.ts tests/hub-settings-fleet-m2682.test.ts
npx vitest run tests/fleet-memory-pressure-1113.test.ts tests/update-launch-1490.test.ts tests/public-web-menu-1367.test.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
python3 scripts/manual/hub-directory-admin-api/verify.py
```

The Python runner changes one guard/forwarding site per row and restores each file before the next row and again in `finally`. Optional positional names select individual rows. It requires Vitest JSON assertion failures, not merely a command failure, and records local reports under `.artifacts/hub-directory-admin-api/`.

The real HTTP rig initializes a private scratch Hub with owned CA-verified loopback HTTPS listeners and the real SQLite, writer, Runtime, controller and HubSessions. Only the directory driver and TLS probe are inert. API responses are not intercepted. The full writer/decision/physical-response path runs for ready, forward-restored, unavailable-candidate and proven-stale outcomes. The old-directory reauthentication leg uses a synthetic password and confirms it is never sent to the candidate driver. No public real directory, account, native process, pilot or live fleet is used.

Gate-only HTTP authority/cancellation cases use a contract stub controller. Wiring checks use the FleetManager recorder. Cold borrowing uses an already initialized private DB with a held module import plus an inert mount recorder for the A→Off→A control. That facade expires after the callback; tests never borrow production state.

Required next acceptance: the local D3 AD page loads/edits while AD is down without AD sign-in, and keeps the host start/stop controls reachable. The form, CA-fetch presentation, fleet/D3 edit route, desktop/phone PNGs and retained-UI SKEW remain future acceptance. There is no UI delta in this backend slice. It adds no migration and never permits rewinding a DB, floor or epoch.
