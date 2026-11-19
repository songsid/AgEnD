# Quick-pairing HTTP fixture ports (M-3373, S-193)

At base `1e57087d`, the private fixture in
`tests/hub-quick-pairing-http.test.ts` obtains two ports from closed sockets and
retries if the numbers match. Both addresses are free during initialization and
composition, before the actual TLS listeners start.

The new regression wraps the real server factory's start. Actual TCP competitors
try to bind the configured member and web ports at that boundary. On base both
return `bound`, failing the expected `EADDRINUSE` results. The failure is a socket
ownership assertion, with no fabricated error or timing loop.

The fixture now uses the unchanged `hubComposePorts()` helper to keep both
OS-assigned sockets bound until the production TLS listeners adopt them. The
duplicate-selection loop is removed. Cleanup is registered before allocation
and attempts inspection DB, production service, leases and scratch files in
order; errors are surfaced and mocks are restored even if cleanup fails.

The positive path signs in over trusted HTTPS, enables group policy, creates and
stops an actual quick-pairing offer. It then closes the production service and
successfully binds both addresses before fixture lease disposal, so the lease
cleanup cannot hide a production-listener leak. The complete file passes all six
tests, preserving the existing CSRF, session, owner, held-admission, sign-out,
policy-off and manual-fallback refusal cases. Test TypeScript has zero diagnostics.
Commands and results are in `validation.json`.

Only this fixture and its evidence change. Shared helpers, production code and
timeout values are unchanged; no retry is added. The test uses disposable TLS,
SQLite and an inert directory. There are no real account, vendor CLI, model,
Fleet, Windows or browser calls. Other fixture families remain separate PRs.
Main has no quick-pairing HTTP test, so no twin is needed. Rollback reverts the
test file and evidence only; no product settings, authentication or data change.
