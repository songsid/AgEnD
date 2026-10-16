# Effect read settlement for one app-owned pool (#1629 B2)

The loader's existing `placements`, `owner` and `resource` methods return promptly when a caller cancels or the ten-second logical deadline fires. Their network/body reservation remains held until physical completion. That prompt return cannot tell a route scheduler when it may start the next metadata read, nor tell the registry that an old resource is physically finished.

Two host-only internal seams expose that lifecycle without adding URLs or authority:

- `placementsSettled(instance, signal)` uses the identical placement URL, epoch, projection, byte/deadline limits and one-metadata capacity.
- `resourceSettled({id, instance | slot}, signal)` uses the identical closed resource scope/projection and three-resource capacity. Cursor still cannot fetch code.

They resolve only after fetch, body/read and its cancellation finish. A late response after abort owns its body too: cancel it rather than drop it unread. Cache one actual body/reader cancellation; a pre-response abort must not cache a no-op that prevents canceling a later response. Cleanup retains the reservation and disposed-loader Window ownership through that cancellation. Cancellation throws/rejections are caught and do not permanently retain a completed operation.

A successful projection is checked again against the original monotonic deadline/currentness after asynchronous cleanup; waiting for cleanup never refreshes an old answer. Cleanup aborts its controller even on success, so actual cancellation is tracked independently from that cleanup abort. HTTP 401/403/409 remains a terminal loader revocation. No response grants session identity, provenance or permissions.

## Integration boundary

The app-owned controller now uses these seams: it keeps one metadata operation while retiring a Chat contribution, then starts the next current contribution after physical settlement; all resources use the same registry/loader capacity. Route/UI cleanup must not await this promise or create a second pool. Never retry a failed authorization using a different scope.

If a broken fetch/read/cancel ignores abort and never settles, a settled promise deliberately remains pending and retains capacity. The UI still uses prompt logical cancellation; the scheduler must not pretend physical work ended. Reload is the existing recovery. No retry, polling, timeout extension or unbounded new request is introduced.

Tests use held fetch, locked-reader and body-cancel promises, including both read/cancel completion orders; late cancellation after a complete successful projection; exact 9999/10000/10001 deadline controls; per-Window exclusion until cleanup; legacy prompt cancellation; scope and revocation controls. This is offline promise/stream evidence, not a new native/browser, real fleet or account claim.

Rollback removes the two unused settled entry points. Reverting the physical-cancellation cleanup also restores its previous capacity behavior, so retain that fix if a later scheduler depends on it. No stored data, migration, API route or CSP changes.
