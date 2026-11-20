# Member-address HTTP fixture listener reservations

`tests/hub-member-address-http-3429.test.ts` used pick/close/listen port
selection both for the initial Hub listeners and later member-address
candidates. Distinctness retries did not keep another listener from taking
an address before setup, relocation or recovery mounted the real TLS server.

The fixture now allocates both kinds from the existing `hubListenerPorts()`
helper. The socket stays bound until the actual TLS listener adopts it.
Initial ports are distinct because both reservations remain open; candidate
ports stay reserved through preparation, commit and an interrupted config
save followed by cold recovery. No shared helper, product code, timeout or
retry policy changes.

The existing move case probes actual competing TCP binds on both initial
ports before prepare, and on the relocation candidate before and after its
prepare. The cold-recovery case independently probes its candidate before
and after preparation, then again after the injected config-save failure.
On the base allocator the initial competitors and cold candidate bind,
producing two semantic assertion failures. With held sockets they receive
`EADDRINUSE`; actual setup, relocation, HTTPS, browser-session continuity,
identity checks, SQL notices and cold recovery still pass.

The move case also closes the real runtime and binds all three addresses
(original web/member and the new member) **before** fixture lease disposal.
This keeps teardown observable rather than relying on test cleanup to free
the listeners. Claimed sockets are never rearmed during recovery.

The before/after-SQL competitor case deliberately abandons only its new,
unclaimed candidate at the chosen race point, then actually binds it. Before
SQL, production preflight still refuses with `port_in_use` and retains the
old config; after SQL the saved operation still reports `saved_unavailable`.
The helper does not replace either refusal with an invented error.

Cleanup is registered before allocation and attempts runtime/controller,
HTTP and directory closure before leases and scratch removal, collecting
errors so later owned resources still close. Mock and environment restoration
is in an outer `finally`.

`validation.json` records the two base failures, 7/7 fixed tests across the
full HTTP file and existing helper regressions, and zero test TypeScript
diagnostics. These are local synthetic directory and HTTP/TLS fixtures;
no real account, vendor CLI, model, browser, live Fleet or Windows operation
was used. Main has no matching HTTP fixture, so no main twin is needed.
Rollback reverts this test file and evidence; product settings, stored Hub
data, account files and shared helper behavior are unchanged. S-197 through
S-199 remain separate work under M-3373.
