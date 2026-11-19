# Group-composition fixture ports (M-3373, S-192)

At base `2550ec2d`, the private rig in
`tests/hub-group-composition.test.ts` calls `freeHubPort()` twice and retries
when the results match. Both sockets are already closed while initialization,
SQLite composition and the real Hub listeners are being prepared.

The new regression wraps the actual server factory's start. Two owned TCP
competitors try to bind the configured member and web addresses before it
starts. On the base both return `bound`, failing the expected `EADDRINUSE`
array. No compiler failure, fabricated error or timing loop supplies the proof.

The fixture now uses the existing `hubComposePorts()` helper. Both OS-assigned
sockets remain bound through initialization and are adopted by the real TLS
listeners. The duplicate-selection loop disappears. The control completes
sign-in and a real trusted HTTPS policy read, then closes the production service
and successfully binds both addresses before fixture reservation cleanup. This
keeps the production-shutdown assertion independent of fixture disposal.

Cleanup is registered before allocation. It attempts inspection DB, production
service, lease and scratch-file disposal in order, surfacing failures; mocks are
restored even when cleanup fails. The production service closes before the
reservation handles, and files are removed afterward.

The complete file passes 21 tests, including existing group editor, held request,
pairing/publication, revocation and captured-control checks. Test TypeScript has
zero diagnostics. Commands and results are in `validation.json`.

The shared lease helper, production code and timeout values are unchanged.
Everything uses disposable TLS, SQLite and inert directory data. No real account,
vendor CLI, model, Fleet, Windows or browser campaign runs. Other M-3373 fixture
families remain separate PRs. Main has no group-composition test, so no twin.
Rollback reverts this test file and evidence only; no product settings,
authentication or Hub data change.
