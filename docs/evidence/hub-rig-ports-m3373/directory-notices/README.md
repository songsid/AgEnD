# Directory host-notice fixture ports (M-3373, S-194)

At base `dd237c02`, `tests/hub-directory-host-notices.test.ts` selects member and
web ports from closed sockets, retrying when their numbers match. The fixture
then initializes a Hub, starts a real runtime, refuses a replacement directory
mount and reads the saved notice through a separate local Fleet HTTP listener.

The regression wraps the actual server factory's first start. Real TCP
competitors attempt both configured TLS addresses before startup. Against the
base port selection both return `bound`, failing the expected `EADDRINUSE`
array (one failure, twelve filtered). The assertion is repeated outside the
runtime's caught mount failure so the reported failure shows the actual socket
results. No fabricated error, compiler failure or timing loop supplies the proof.

The fixture now uses the unchanged `hubComposePorts()` helper to keep both
OS-assigned sockets bound until the real TLS listeners adopt them. The duplicate
selection loop is removed. The original mount, replacement refusal and runtime
close still run; the local Fleet HTTP listener already binds port zero and is
unchanged. Reservations are not rearmed after production shutdown.

Cleanup is registered before port allocation, and attempts runtime, HTTP
listener, sessions, leases and scratch-file cleanup in order. It surfaces
collected failures and restores mocks and environment stubs even after failure.
The new test successfully rebinds both runtime addresses before fixture lease
disposal, then reads the retained notice over real HTTP without starting a cold
Hub runtime or directory. This keeps production teardown proof independent of
fixture disposal.

All thirteen tests pass, preserving authority, held continuation, disconnect,
audit rollback, schema refusal and cold-facade controls. Test TypeScript has zero
diagnostics. Commands and results are in `validation.json`.

Only this fixture and its evidence change; shared helpers, production code and
timeouts are unchanged. No retries are added. Tests use disposable certificates,
SQLite and an inert directory; no live account, vendor CLI, model, Fleet,
Windows or browser campaign runs. Other families remain separate PRs. Main has
no directory host-notice test, so no twin. Rollback reverts test and evidence
only, with no product settings, authentication or data change.
