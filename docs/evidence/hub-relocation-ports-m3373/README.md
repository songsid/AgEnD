# Relocation peer fixture ports (S-199)

The TLS/WSS peer in `tests/hub-relocation-network-3429.test.ts` selected a free port and closed its reservation before listening. A competing bind could take it during that gap.

The fixture now uses the existing held-socket allocator through real TLS adoption. An actual TCP competitor must receive `EADDRINUSE` immediately before adoption. Awaited peer cleanup terminates WebSockets, waits for the real TLS close, and proves the port can be rebound before disposing the lease. Startup errors also dispose the peer and lease; cleanup aggregates errors and restores mocks after the member rigs close.

The intentionally closed destination remains a negative test. All twelve relocation/acknowledgement, link-currentness, deadline, dial-order, fallback, and outage cases remain. No production, shared-helper, retry or timeout changes.

Validation:
- Before the fix: the two pending-peer modes fail semantically (`bound` instead of `EADDRINUSE`); ten unrelated cases filtered.
- Fixed full file: 12/12 pass using local real TLS/WSS and synthetic identities.
- `npx tsc --noEmit -p tsconfig.test.json`: zero diagnostics.
- Main has no corresponding test, so this is dev-only.

No real account, provider CLI, model, Fleet lifecycle, Windows or browser campaign was used. This validates fixture socket ownership and the existing local protocol assertions, not external services. Rollback: revert this fixture/evidence commit; no persistent production data changes.
