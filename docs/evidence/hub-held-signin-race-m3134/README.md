# M-3134: web-address HTTP fixture port ownership

Product/test commit: 3939afb10158f0852831792c64959c74f2e2b3a0, based on alpha faefee6924d08d6356f73aaf7a502840dd879a45.

The alpha failure in run43641659702 is setup timing, not a held sign-in mint race. `initialize()` fails at its empty-holds assertion with `EADDRINUSE`, before returning to the test and before its sign-in is started. `freeHubPort()` binds port0, reads the number and closes the socket; the fixture leaves that number unowned through setup, certificate generation and directory work. Another listener or outgoing socket can take it before preflight or the final Hub mount. Runtime apply is serialized. The #3935 run43636493448 actually fails the separate HTTPS-move case at setup commit503; that old assertion records no response body, so its exact reason is unknown. The assertion now includes the body.

The fixture-only port helper keeps the socket bound from selection through mount. The actual TLS server takes the same bound handle through `server.listen(handle)`; there is no close/rebind gap and the HTTPS/LDAPS/SQL/session paths remain real. Only this fixture's unused, still-owned sockets satisfy its network preflight directly. All other endpoints use the production preflight. The two explicit bind-competitor cases release their candidate reservation, then exercise the actual preflight or startup refusal.

Deterministic control: immediately after initial web/member port selection, the held-sign-in test attempts a competing bind. With the previous allocate-and-close implementation, the first port is stolen and the new assertion fails. With the reservation, both attempts get `EADDRINUSE` and the original held-sign-in/post-SQL/session-count assertions then run unchanged. No sleeps or timing thresholds were added.

Validation:
- Fail-first selected test: 1 semantic failure (`stolen` instead of `EADDRINUSE`), 4 skipped.
- Final complete file: 5/5 pass, including both intentional bind-competitor controls and real HTTPS remount.
- `tsc --noEmit -p tsconfig.test.json`: exit0. An initial `findLast` library-target error was replaced with the equivalent compatible filter/pop before the final checks.
- Changelog validator: 498 fragments valid. No release fragment for this test-only fix.
- `origin/main` at666422f5fb88883bfc41d3b4b14c383acde57af7 has no tests/hub-web-address-http-3428.test.ts, so no main twin.

Commands: `GOMAXPROCS=2 nice -n 10 node_modules/.bin/vitest run tests/hub-web-address-http-3428.test.ts -t 'a held old sign-in' --maxWorkers=1` (before); the same command without `-t` (final); `GOMAXPROCS=2 nice -n 10 node_modules/.bin/tsc --noEmit -p tsconfig.test.json`.

Production code, session authority, config and SQL are unchanged. This helper is scoped to this suite and restored after each test. Rollback reverts the fixture changes, restoring the former port allocation gap. No browser, vendor, external directory, new network matrix or mutation campaign was run.
