# Company-join listener reservations (M-3369)

At base `d816dc4e`, `tests/support/hub-company-join-rig.ts:73–82`
reserves two distinct loopback ports, then closes both reservations before
initialization and the real Hub listeners start. A different test can claim
an address in that interval. Tag-push CI 44465242477, attempt 1, hit
`EADDRINUSE` in the B1 enrolment-code HTTP test's admin-exclusion case.

The shared fixture now uses `hubComposePorts()` from M-3338. Both
OS-assigned sockets stay bound through initialization and are handed directly
to the real member and web TLS servers. There is no retry, timeout increase,
production-code change or replacement HTTP server.

The existing lease helper now shares one interception across its active
allocators, isolates their leases and restores the original methods after
the last allocator closes. This matters for fixture consumers that do not
call `vi.restoreAllMocks()`, and prevents stacked spies from recursively
calling themselves. Reverse fixture disposal closes the real service before
the leases. Stop/Run continues to close the listening ports.

## Forced collision and cleanup proof

`tests/hub-company-join-ports-m3369.test.ts` wraps the real factory's start.
Immediately before it runs, two owned TCP competitors try to bind its
configured addresses and retain any socket they acquire. On the base fixture,
the competitors acquire the ports and the real start fails with `EADDRINUSE`.
On the fixed fixture, both competitors get `EADDRINUSE`; the real TLS start
succeeds, as do trusted browser HTTPS and member HTTPS requests. After close,
both addresses can be rebound. The other regression creates two consecutive
rigs without a mock reset and checks that the original methods are restored.

The lease-helper regression also holds two independent allocators at once,
closes one twice and verifies that the other still owns both addresses.
Validation commands and results are recorded in `validation.json`.
Raw CI logs, generated keys and disposable Hub state are not committed.

## Neighbor inventory

This shared fixture fixes the same allocation window in its 12 existing
consumers: company-join fixture/HTTP/client/invitation/recovery,
enrolment-code B1 HTTP/B2 session, simplify S1, group search S2,
code-member link A2, pilot trust join and stop-sessions 3512.

Source inspection found independent pick/close/listen patterns in the
following older rigs. They are recorded for follow-up rather than changing
unrelated fixture contracts in this small fix:

- `tests/helpers/hub-preview-rig.ts:26–30` (three released reservations).
- `tests/helpers/hub-rig.ts:15–17`, including the default member port at `:34`.
- `tests/hub-compose.test.ts:67–69` (`initializedHub`, distinctness retries only).
- `tests/hub-group-composition.test.ts:30–31`.
- `tests/hub-quick-pairing-http.test.ts:31–32`.
- `tests/hub-directory-host-notices.test.ts:43`.
- `tests/hub-web-init-http.test.ts:49`.
- `tests/hub-member-address-http-3429.test.ts:83–86` (and later address candidates).
- `tests/hub-attachments-e2e.test.ts:40` and `tests/hub-s3b-flow.test.ts:37`.
- `tests/hub-relocation-network-3429.test.ts:125` (the peer's TLS listener).

Deliberately occupied ports, closed-destination negative cases and simple
servers that bind port 0 directly are not converted.
Main has no `tests/hub-enrolment-code-http-b1.test.ts`; this PR is dev-only.

Rollback reverts these test helpers, regressions and evidence. No product
setting, authentication file or persisted Hub data is changed.

Final local checks: 105 distinct tests pass across 16 files (the two new
company-join cases ran in both batches), with zero skipped cases. Test
TypeScript has zero diagnostics. Removing final interception restoration
makes the overlap/cleanup regression fail at the original-method assertion;
the original helper was restored byte-for-byte afterwards. Full CI remains
a separate gate.
