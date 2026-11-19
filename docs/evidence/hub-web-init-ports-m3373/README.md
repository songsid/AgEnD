# Web initialization HTTP fixture listener reservations

The fixture in `tests/hub-web-init-http.test.ts` previously chose two free
loopback ports, closed the temporary listeners, and retried only to make
the numbers distinct. Another listener could claim either address before
initialization or the first Hub runtime mount.

It now uses the existing `hubListenerPorts()` helper. Both OS-assigned
sockets remain bound through prepare, network checks and commit, and the
real member/web TLS listeners adopt those same sockets at the first mount.
The helper, product code and existing test deadlines are unchanged. The
Fleet HTTP server and fake LDAPS peer already bind port 0 and stay as they
were. Claimed sockets are not rearmed during later off/on or replacement
cycles.

The successful public-route case now tries actual competing TCP binds on
both addresses before prepare and again after commit. Both fail with
`EADDRINUSE`, then real Hub HTTPS, the UI response and initialization audit
checks pass. After closing the actual runtime, both addresses can be bound
again **before** fixture lease disposal, preserving the production teardown
check. On the original allocator, both competitors bind successfully and
the new assertion fails semantically; no retry or timeout is involved.

The deliberate occupied-web-port-at-Save case releases **both** unclaimed
reservations and verifies both addresses are physically free before it
occupies the web address. Commit still executes the actual member/web
preflight, returns the existing network refusal and writes neither identity
nor Hub config. The helper cannot hide that refusal behind its own socket.

Cleanup is registered before allocation. It attempts controller/runtime,
HTTP and directory closure before disposing leases and removing scratch;
errors are collected so a failed close cannot skip later owned resources.
Mock and environment restoration remains in an outer `finally`.

`validation.json` records the base failure and fixed results: the full HTTP
fixture and existing helper regressions pass 32/32, and test TypeScript has
zero diagnostics. The original fixture blob is unchanged between the saved
fail-first base and the current alpha starting point. This proof uses local
HTTP/TLS and synthetic directory fixtures; no real account, vendor CLI,
model, live Fleet, browser or Windows operation was used. Main has no
corresponding HTTP test, so no main twin is needed.

Rollback reverts this test fixture and its evidence. No product settings,
persisted Hub schema, account data, shared helper or timeout is changed.
Other inventoried families remain separate work under M-3373.
