# S3b flow fixture listener reservation

`tests/hub-s3b-flow.test.ts` selected a free member port and closed its
temporary listener before identity/database setup and the real TLS start.
Another listener could claim that address while the flow was preparing.

The fixture now uses the existing `hubListenerPorts()` helper. Its one
OS-assigned socket stays bound until the real member TLS listener adopts
that same socket. The separate web HTTP listener still binds port 0.
Shared helpers, product code, retry policy and all deadlines are unchanged.

The existing whole-flow case now attempts an actual competing TCP bind
immediately before the real member TLS starts. On the base it binds and
the new assertion fails semantically; with the held socket it receives
`EADDRINUSE`. The original pairing, owner confirmation, administrator
approval, catalog, grant, signed question, online admission/begin/release
leases, receipts, answer and provenance assertions remain intact. The
fixture's existing S5 audit/content adapters are unchanged; the member
HTTP/TLS/WSS path remains real local transport.

A physical rebind runs in the original server cleanup after the real TLS
close, before database/lease/scratch disposal. It must bind, so fixture lease
cleanup cannot hide a leaked production listener. Server/web cleanup is
registered before their awaited starts. Reverse cleanup attempts every
owned close, collects errors and restores mocks in an outer `finally`.
Shutdown stays in its original cleanup stage rather than extending the
test body's work.

`validation.json` records the base semantic failure, the passing complete
flow and the test TypeScript result. Only local synthetic HTTP/TLS/WSS was
used: no real account, vendor CLI/model, live Fleet, browser or Windows
operation. No main twin is needed because main has no matching fixture.
Rollback reverts this test file and evidence only, with no product setting
or persisted-data change. S-199 remains separate work under M-3373.
