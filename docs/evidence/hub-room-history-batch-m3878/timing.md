# Group-room history projection: bounded validation

A history page already runs in one synchronous `HubCore.atomic` transaction with
its member, session-epoch and request-currency fences. Projection opened further
atomic units for each row's author, provenance, metadata, attachments and progress.
Each nested unit checked the mounted service again, which reparsed transport,
version-floor and policy state. This multiplied filesystem and validation work by
the number of returned rows.

The fix passes that page's database into projection. All projection SQL stays in
the original transaction; the request permit is checked before and after the
page. Calls outside this page retain their existing atomic units. There is no
cache across requests, await, timer or global authorization snapshot.

## Synthetic measurements

Exploratory single-run measurements, not a latency guarantee. Two synthetic rooms
contain 50 and 70 posts, 8 and 14 members, and eight published shares. The post mix
includes person, agent and system authors. Content references are inert; no user
message content or credentials were copied. A fake directory is used.

The fixture follows `directoryRuntimeRig` in `tests/hub-compose.test.ts`: private
initialized homes, real mounted HTTP service, and real transport/floor readers.
The VM run used Node 22.23.5 on a two-vCPU Xeon Silver 4514Y, with `taskset -c 0,1`.
The current HTTP/room code was loaded with the installed beta.26 runtime's shared
components. Each variant used its own scratch home and closed its listeners.

| Room posts | Page limit | Base CPU ms | Fixed CPU ms | Base transport reads | Fixed transport reads |
| --- | --- | --- | --- | --- | --- |
| 50 | 1 | 92.5 | 72.0 | 90 | 74 |
| 50 | 25 | 298.2 | 63.4 | 474 | 74 |
| 50 | 50 | 461.2 | 75.5 | 934 | 74 |
| 50 | 100 (50 returned) | 450.1 | 59.0 | 940 | 74 |
| 70 | 1 | 46.4 | 40.1 | 90 | 74 |
| 70 | 25 | 222.8 | 43.2 | 474 | 74 |
| 70 | 50 | 336.6 | 51.0 | 874 | 74 |
| 70 | 100 (70 returned) | 558.3 | 64.7 | 1268 | 74 |

Version-floor read counts equal transport read counts in this fixture. A separate
full-source, two-CPU local run with 50 person rows counted 2,185 strict JSON parses
before and 185 after. The VM bundle's shared validation export was not separately
instrumented, so those parse counts are not presented as VM measurements.

The room detail request cost another 133–146 ms CPU before the fix. The browser
opens detail and the default 50-message page together (`hub-room-thread.js`).
This patch targets the message-page multiplier; it does not change detail loading.

## Regression checks

```sh
npx vitest run tests/hub-room-history-batch-m3878.test.ts --maxWorkers=2
```

The bounded-read test installs a real transport read at the fixture's mount
currency seam. A mixed 71-row response must cost no more than the one-row response
plus four reads. With the base service it fails: **639 reads versus at most 47**.
The fixed service passes. The second test revokes the mount during projection and
requires an unavailable response without a messages array.

The neighboring rooms, files, buttons, pins, reactions, purpose, office-style and
agent-history scope tests cover unchanged projection behavior.

## Limits and follow-up

This proves a request-driven CPU hot path, not the cause of every observed
one-second stall or steady background CPU use. No production profiling, inspector,
restart or configuration change was used. Re-measure stalls and steady CPU after
the fix is deployed before attributing residual work to a periodic job. Additional
vCPUs cannot parallelize these synchronous projection calls on Node's main thread.

Risk is confined to projection's transaction reuse. The final request/mount fence
still rejects a revoked response. Rollback is a code revert; no schema or data
migration is involved.
