M-3179 is the test-only follow-up to M-3171/#3978. Product source is unchanged.

Alpha push run 43687731762 attempt 1 at 16b1a25f fails the startup recovery test with
`listen EADDRINUSE 127.0.0.1:36577`. The retained log does not identify which bind call lost the race.
The old fixture both chooses/closes an initial ephemeral port and closes the Hub before rebinding the same address
for restoration, HTTP refusal and pre-welcome controls. A competing listener can take either unowned window.

The startup fixture now uses Ridge's existing, unchanged `hubListenerPorts` helper from #3945. A new optional
`memberPort` parameter lets `hubRig` use that reserved address; the real Hub TLS server adopts the same bound
socket through Node's `listen(handle)` overload. Other `hubRig` callers retain their previous default allocation.

The same TLS listener remains bound for the entire startup test. The outage handler destroys upgrade attempts;
restoration reinstates the actual Hub upgrade handler. HTTP refusals and pre-welcome WSS controls also use that
listener, with no close/rebind. This models a connection failure before welcome rather than physically stopping
the listening socket. The real member client, reconciliation, SQLite, owner HTTP route and refusal assertions
still execute. The fixture closes its runtime/listener/leases and restores suite-scoped spies after each test.

Deterministic control: try a real competing bind both after initial allocation and during the outage. Each must
receive `EADDRINUSE`. With the old outage fixture, the added guard fails with `stolen` instead; `before.log` has
one semantic failure and ten unselected cases. No sleep or repeated randomized port search is used to hide the race.

Validation bound by `manifest.json` to source 492279387:

- Final startup + existing leased-helper consumer suites: 16/16 across two files (`final.log`). The earlier 16/2
  run overlaps completely and is not added to this count.
- Two isolated reversals: releasing the initial lease, or closing the listener for the outage, each turns the
  competing-bind assertion red (`stolen` instead of `EADDRINUSE`). One selected test and ten unselected each;
  exact candidate source restored and digests retained in `reversals.json`.
- Native test TypeScript program exits 0 (`test-types-result.json`). No product source or source type-check change.

```sh
npx --no-install vitest run tests/hub-member-startup-3171.test.ts tests/hub-web-address-http-3428.test.ts --maxWorkers=2
npx --no-install tsc --noEmit -p tsconfig.test.json
```

Only local owned sockets/files and inert directory/update/agent adapters are used. No live Fleet, browser,
container, vendor CLI, production change or release activation was performed. Changelog/skill/UI screenshots
are N/A for this test-only fix. Rollback reverts the two test files, restoring the port race.
