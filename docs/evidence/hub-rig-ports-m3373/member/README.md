# Default member fixture listener (M-3373, S-190)

At base `8b488f50`, `tests/helpers/hub-rig.ts:34` calls `freeHubPort()`
for its default member port. That helper closes the socket before identity,
database and server setup. The new regression attempts a real competing bind
during identity setup: on the base it gets `bound`, failing the expected
`EADDRINUSE` assertion before database construction. This is a real address
takeover, not a compile failure or a timing loop.

Only the default selection now owns a `hubListenerPorts()` allocator. The
socket stays bound through setup and is adopted by the real TLS listener.
The fixed regression pairs through actual HTTPS, starts a real WSS member,
completes reconciliation and checks the current link. After fixture close,
the original address can be rebound.

Explicit `memberPort` values remain caller-owned. The exported `freeHubPort()`
and the shared lease helper are unchanged; other allocation families get their
own PRs. No production code, retry or timeout changes are included.

## Lifecycle contracts

- An occupied explicit port is still refused with `EADDRINUSE`; the competitor
  remains listening and the failed fixture's private directory is removed.
- A default rig and an explicitly leased rig can coexist. Closing them leaves
  the external allocator's spare reservation held.
- Fixture cleanup is idempotent. Clients close before the server, then the DB,
  owned reservation and scratch files. Initial failure follows the same cleanup.
  The injected start-failure case checks server close, actual `db.open === false`,
  removed state, restored interception and a successful bind to the released port.
- Closing the real server separately still releases its address before the
  fixture closes, allowing existing same-port replacement and renewed-server tests.
- Existing teardown that restores mocks before fixture cleanup remains supported.

Read-only inventory found 39 direct importing test files, including eight that
supply their own leases. Focused verification covers the new cases, real network
transport, repeated member restore, restore-before-close teardown and two leased
room-member peers. Commands and results are in `validation.json`; other consumers
and the full suite remain CI coverage.

All endpoints, identities, directory data and state are disposable fixtures.
No real account, vendor CLI, model, Fleet or Windows work runs. Main has no
member rig, so there is no twin. M-3373's other families remain open.
Rollback reverts only this test fixture, cases and evidence; no product settings,
authentication files or stored Hub data change.
