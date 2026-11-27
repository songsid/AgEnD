# Hub page reads: codec and projection timings

Base: d6155d13 (includes the separately reviewed history fix #4590). This sibling
retains every currentness, ownership, binding, clock and independent-floor check.
It memoizes only successful decoding of an exact byte string and reuses an already
owned synchronous transaction for SQL-only projections.

The fixture uses 17 synthetic people, eight Fleets, nine exposures (eight published),
two group rooms with 50/70 posts and 8/14 members, two teams/16 memberships,
three roles/two assignments, five grants, 15 direct rooms, and 85 inert-content
direct messages. It includes group-source resource witnesses and complete fake
directory group facts. Per-owner distributions match the measured count shapes:
at most two Fleets and four published shares per owner, one direct room per asker.
All identifiers and message references are synthetic; no user content or credentials
are copied. Fake directory calls do no network I/O.

Measured on a two-vCPU Xeon VM, Node 22.23.5, `taskset -c 0,1`, private scratch Hub
homes. Median of three sequential reads per route; every reported sample is HTTP
200. SSE is measured through its initial notice snapshot, then disconnected.
Counters are inserted in the scratch compilation without replacing function
identities (role-clock currency binds those identities). No production inspector,
profiling attachment, restart or configuration change is used. Timings include
fresh TLS connections, process-level CPU and possible background/GC work; they
are exploratory rather than latency guarantees.

| Request | Base CPU ms | Fixed CPU ms | Base/fixed floor reads | Base/fixed strict parses |
| --- | ---: | ---: | ---: | ---: |
| `/hub/v1/session` | 98.2 | 59.5 | 124/124 | 325/130 |
| `/hub/v1/me/prefs` | 35.7 | 33.9 | 42/42 | 105/42 |
| `/hub/v1/rooms/events?notices=3` | 74.4 | 51.0 | 136/136 | 340/144 |
| `/hub/v1/rooms?v=2&ownerRequests=1` | 822.2 | 512.7 | 1792/1754 | 4711/1849 |
| `/hub/v1/rooms/room-50` | 1912.4 | 1161.9 | 4986/4943 | 13186/5243 |
| `/hub/v1/rooms/room-50/messages?limit=50` | 52.5 | 39.4 | 74/74 | 185/74 |
| `/hub/v1/rooms/room-50/pins` | 29.8 | 12.6 | 64/64 | 160/64 |
| `/hub/v1/rooms/room-70` | 2702.6 | 1043.3 | 7343/7296 | 19440/7746 |
| `/hub/v1/rooms/room-70/messages?limit=50` | 58.6 | 32.7 | 74/74 | 185/74 |
| `/hub/v1/rooms/room-70/pins` | 31.3 | 22.1 | 64/64 | 160/64 |
| `/hub/v1/exposures` | 2056.2 | 1318.4 | 5536/5378 | 14652/5727 |
| `/hub/v1/pairings` | 49.0 | 12.9 | 33/33 | 82/33 |
| `/hub/v1/me/agents` | 51.1 | 44.5 | 120/101 | 295/101 |
| `/hub/v1/me/welcome` | 153.1 | 103.0 | 369/369 | 989/397 |
| `/hub/v1/me/fleets` | 34.4 | 21.6 | 79/79 | 197/79 |
| `/hub/v1/teams` | 206.8 | 137.3 | 510/510 | 1317/538 |
| `/hub/v1/teams/settings` | 179.2 | 117.4 | 474/474 | 1224/500 |
| `/hub/v1/notices?v=3` | 52.4 | 30.4 | 108/108 | 270/116 |
| `/hub/v1/me/intro-notice` | 19.5 | 18.3 | 36/36 | 90/36 |
| `/hub/v1/security-notices/directory?limit=25` | 32.8 | 20.1 | 66/66 | 178/78 |
| `/hub/v1/roles/notices` | 43.1 | 31.2 | 101/101 | 255/105 |
| `/hub/v1/admin/dashboard?range=7d&timeZone=UTC` | 186.1 | 115.9 | 473/441 | 1221/467 |
| `/hub/v1/roles` | 204.1 | 136.5 | 538/538 | 1401/570 |
| `/hub/v1/admin/overview` | 377.3 | 213.2 | 1015/881 | 2611/933 |
| `/hub/v1/admin/company-join` | 143.7 | 92.2 | 370/370 | 958/392 |
| `/hub/v1/admin/enrolment-codes` | 175.8 | 116.9 | 468/468 | 1209/494 |
| `/hub/v1/admin/rooms/creators` | 153.9 | 100.4 | 404/404 | 1046/428 |
| `/hub/v1/admin/rooms` | 154.7 | 98.9 | 404/404 | 1046/428 |
| `/hub/v1/admin/session-limits` | 145.5 | 90.1 | 372/372 | 963/394 |
| `/hub/v1/admin/recommended-version` | 141.4 | 90.6 | 372/372 | 963/394 |
| `/hub/v1/admin/hub` | 152.9 | 99.5 | 406/406 | 1051/430 |

## Approximate page CPU budgets

Sum of the listed request medians, in milliseconds. These include the shared
shell reads once, but exclude conditional cards, mark-read POST and static assets.
These sums are not measured browser wall-clock times.

| Page | Base summed CPU ms | Fixed summed CPU ms |
| --- | ---: | ---: |
| Shared shell / room list | 1416 | 912 |
| Room (70 posts) | 4209 | 2010 |
| My agents | 3726 | 2391 |
| Notifications | 1512 | 981 |
| Admin overview | 1602 | 1028 |
| Roles / People | 1621 | 1048 |
| Connected Fleets (core only) | 1794 | 1125 |

## Safety, tests and limits

The unchanged SQL text is freshly selected on every transport or canonical-reader
call; floor/private-path checks and both reader currentness checks still execute.
Each result gets a fresh nested copy. Changed bytes strictly decode again.
One prior non-secret policy image can remain in the module memo after unmount,
until a different successful decode or test reset; per-reader/store templates
remain until their owners are collected. None is an operation permit.

Projection batches retain the surrounding member/session/permit fences. Standalone
helper callers retain their existing atomic reads. The regression suite bounds
one-item versus eight-item reads for room detail, exposures, My agents, dashboard
and Fleet overview, and refuses an overview revoked during projection. Codec
negatives cover nested mutation, malformed/duplicate keys, exact-byte conflicts,
warm floor failure, foreign ownership/generation and currentness. Seven independent
codec mutants were killed.

**This PR does not meet the ~100 ms target on every route.** Grant-bearing
`/exposures` and the shared room list still perform many permission/floor checks.
The separate synchronous guard-frame work is not included in these numbers or
this change. Failed HTTP samples from earlier incomplete fixture registration
were discarded; they are not performance evidence. A future guard-frame PR must
report its own results against this corrected fixture.

No migration or stored-data change. Roll back by reverting this code independently
of #4590 and any later guard-frame change.
