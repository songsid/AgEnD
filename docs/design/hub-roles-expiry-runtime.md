# Mount-owned role expiry (S-129 preparation)

`createHubRoleExpiryRuntime` joins the actual resource adapter, SQL role writer, automatic expiry settlement and shared physical directory owner. It schedules the next unsettled assignment deadline, including the self-use projection when roles are off. A scheduler is not an authorization permit: readers must continue to enforce their own assignment deadline and persisted authorization clock while a directory read or settlement is pending.

The factory constructs the worker after its listeners start, only for an already-valid canonical role image. Legacy mounts create no worker or role tables. This slice does not register the role migrations, perform startup cutover, expose role-management endpoints or finish the session/member/stream consumer conversion. The factory evidence uses a private in-construction SQL cutover. It is not a supported cold role mount or a claim of deployed role enforcement.

## Ownership and settlement

One published promise owns settlement through actual directory work and final SQL fences. A policy write signals `changed()` and replans after the current flight; it does not overlap or revive the old decision. An assignment extension creates a different expiry term and does not resume resources already suspended. Unknown facts leave resources unchanged and retry after one second. A warning is emitted once per failure episode. Far-future deadlines are clamped to the platform timer limit, avoiding overflow into a rapid loop.

The existing settlement owns exact policy, inventory, audit, time and transaction checks. This composition advances the real transport authorization version within that same transaction, preserving its independently persisted floor. Refresh happens after commit. If refresh fails, the committed term remains settled; neither the audit nor resource consequence repeats. A writer committed through this internal owner also signals a deadline replan. No HTTP caller is added in this slice.

A lost mount is permanently retired. Fence cancels the timer and closes the writer, settlement and prepared effects synchronously. Close waits for its actual flight; it never releases a shared directory slot by winning a timeout race. The factory registers this close as its newest teardown owner, before directory and database cleanup. Both synchronous fence and ordinary close retire the worker before fencing the shared read owner. A late directory answer cannot commit after retirement.

## Evidence and rollback

See `docs/evidence/hub-roles-expiry-runtime-s129/`. Unit controls use actual SQLite, cutover, clock, audit, transport, resource effects, expiry and admission with fake timers and fictional directory answers. Factory controls use generated fixture certificates and owned loopback listeners. No real AD, account, vendor CLI, native Windows, browser, container, pilot or fleet is exercised. There is no UI/asset change or SKEW/PNG claim.

Before activation this preparation can be reverted without changing a legacy policy. Once later activation writes role state or raises an authorization floor, rollback must remain forward-only. Never restore an older database, policy or floor snapshot.
