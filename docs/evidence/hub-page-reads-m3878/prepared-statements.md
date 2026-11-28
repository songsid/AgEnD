# Hub prepared read statements

This independent follow-up to #4594 is driven by three scratch V8 CPU profiles.
It contains no permission read frame. The profile tables and call paths are in the
M-3878 attached `profile-report.html`; the synthetic fixture and route inventory
are described in [the codec report](timing.md) and [request map](requests.md).

## Profile and chosen scope

The scratch profiler surrounds only three sequential HTTP requests per route,
after fixture setup and browser sign-in. It uses a local inspector Session on
the private scratch process, with no listening inspector port. Native frames
without a name are attributed to their nearest named JavaScript caller; sampled
elapsed time is not exact CPU accounting. Across three reads, native and JS
SQLite preparation accounted for approximately 861 ms for exposures, 1,077 ms for
a 70-post room detail and 281 ms for the room list. `structuredClone` and private
floor-path I/O were the other large costs. Signature verification was not hot.
Those other costs are outside this patch.

Only prepared code for constant, read-only SQL is reused, on the exact owned
`better-sqlite3` handle. All `.get()` and `.all()` calls execute on every invocation
and return new rows. Every transport floor, raw SQL image, clock, mount/session
currentness, strict validation and clone remains. No permission/result cache,
transaction reuse, SQL rewrite, guard frame, or authority lifetime changes.

Hot queries cover the transport row, canonical policy, role clock registry/marker/
expiry/Hub owner, directory settings head, member/web address heads and session
epoch. Cache keys are the entire SQL string. Each connection has at most 64
statements; beyond the bound a query prepares and executes freshly. Failed prepares
are not cached. The helper checks read-only before execution.

The registry is a WeakMap keyed by the DB handle, never by filename. Server and
member teardown explicitly clear their cache before closing. Any later read through
a closed handle clears its entry and throws. Reopening the same path creates an
independent handle and cache. Schema retirement still throws; SQLite re-prepares
the statement if the current schema is recreated. No database files are migrated.

## Matched VM measurements

Same synthetic count fixture (17 people, eight Fleets, nine shares, 50/70-post
rooms, three roles, two assignments and complete group-resource witnesses),
Node 22.23.5, two VM CPUs, `taskset -c 0,1`. Codec-only source f5fa6777e and this
patch ran consecutively, each in a separate process/private scratch Hub home.
Three HTTP-200 samples per route; medians below. These runs have counters but no
CPU profiler. CPU includes GC/background work and is exploratory, not an SLA.

| Route | Before CPU ms | After CPU ms | Before/after prepare calls | Floor reads, unchanged | Transport reads, unchanged |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/hub/v1/exposures` | 1395.0 | 831.2 | 20766/683 | 5378 | 5378 |
| `/hub/v1/rooms/room-70` | 1718.7 | 1038.1 | 28121/896 | 7296 | 7296 |
| `/hub/v1/rooms?v=2&ownerRequests=1` | 413.8 | 250.4 | 6833/262 | 1754 | 1754 |

This removes roughly 97% of repeated preparations and about 40% CPU in these
three matched samples. All three still exceed the 100 ms/request target. It does
not claim that the remaining synchronous clone/path checks are solved. More vCPUs
do not parallelise a single request's synchronous work.

## Verification and rollback

`hub-prepared-reads-m3878.test.ts` bounds transport preparation (the codec-only
store fails that negative), proves changed rows and floors affect the very next
call, result/parameter isolation, two-handle ownership, schema retirement, failed
prepares, write refusal, bounded-capacity fallback, explicit clear and reopening
the same on-disk database. The eight focused suites pass 253 tests. Four independent mutations are killed:
prepare on every call, cache row results, ignore the owning handle, and ignore
explicit teardown clearing. Neighbor suites retain role-clock expiry, policy
currentness, settings decision and mount-revocation controls.

Revert this patch independently of #4594. No persistent state or migration is
introduced; rollback resumes preparing each constant read statement every time.
The separate permission read-frame commit remains held and is not included.
