# Host memory pressure

One fleet sampler reads Linux `/proc/meminfo` every 30 seconds and before spawn
admission. It prefers `MemAvailable` over `MemFree` and distinguishes no swap
from missing swap information. On Linux and other non-macOS platforms, portable
fallback reports free RAM and unknown swap; free RAM alone can slow starts but
cannot impose an indefinite hold because reclaimable cache may account for the
difference. macOS samples are advisory only; see [macOS](#macos).

The gate applies to startup, wake, restart and recovery, including the first
spawn and a daemon's nested acquisition inside a fleet lifecycle operation.
Nested waits retain the outer concurrency/workspace slot without reacquiring
it. Outer fleet reservations are tagged as lifecycle work; actual spawn callbacks
are counted separately so a pressure change after several reservations cannot
start their nested CLIs concurrently. Already running callbacks may finish.
Shutdown rejects queued and nested waiters and clears their retry timer.

| Condition | Action |
| --- | --- |
| Measured available RAM below `max(300 MiB, 2% of RAM)` on a non-macOS host | Wait; start no new CLI |
| Measured available RAM below `max(2 × critical threshold, 5% of RAM)` **and** swap free at most 5% of a nonzero swap total on a non-macOS host | Wait; start no new CLI |
| RAM below that second threshold, or swap free at most 5% of a nonzero swap total, on a non-macOS host | At most one operation at a time, starts at least 5 seconds apart |
| Invalid/unreadable Linux or other non-macOS sample | Same slow admission; never treat unknown as zero RAM |
| Any macOS sample, including invalid/unreadable | Normal concurrency/stagger and storm/workspace limits; no memory-pressure admission restriction or channel notice |
| Healthy RAM and swap | Configured concurrency/stagger, subject to the existing storm cap |

Critical waits retry after 5, 10, 20, 40 and then 60 seconds (maximum), retaining
the original request without running/retrying the spawn operation. A critical
hold cannot end below 1.5 times its RAM threshold. After a hold clears, the first
actual resumed admission starts a 30-second slow ramp, even if background
sampling detected recovery before the retry deadline. An elevated state clears
at or above 1.2 times the low-RAM threshold and, when known, above 10% swap free.
Configured stagger and storm limits remain additional restrictions. Active
CLIs are never killed or cancelled by this policy.

`/health` adds `hostMemory` alongside the distinct fleet process/cgroup `memory`:
level, RAM/swap values, sample timestamp, recovery flag, bounded sample count,
and change per minute in RAM available/swap free over at most 12 samples.
Trend needs at least one minute; missing swap stays null. Health reads use the
cached snapshot and cannot create trend samples. Elevated or critical pressure
marks health degraded on non-macOS hosts; macOS still exposes the advisory
snapshot but does not degrade health because of it. The systemd watchdog remains
independent of health.

On non-macOS hosts, structured warnings include the snapshot/trend on transitions
and at most every 10 minutes in an unchanged state. Full samples are debug logs. Localized General
notices have a separate 10-minute cooldown independent of changing measurements;
critical escalation can notify immediately. No adapter means the notice cooldown
is unspent. The existing notifier counts dispatch, rather than platform delivery.

Sampling starts before the first CLI and stops before asynchronous fleet shutdown.
On non-macOS hosts at cold boot, a memory hold can precede adapter/health-listener
startup: the warning is visible in logs first; channel notices become available once adapters
start. Startup can remain waiting until the host recovers. This is host pressure
protection, not a per-cgroup memory limit or an OOM predictor. It does not change
delivery, auth, systemd restart policy, or core dump handling. Rollback is a code
revert; there is no persisted-state or configuration migration.

## macOS

**Since #1258, macOS memory pressure is advisory only.** No memory-pressure channel
notice is sent, and spawn admission neither requests nor waits for a memory
sample. Samples cannot add a memory-pressure stagger, reduce concurrency, impose
a critical hold or start an admission recovery ramp. Configured or automatically
derived concurrency, stagger, storm and workspace limits still apply. `/health`
retains `hostMemory` for diagnostics but does not use it to degrade health. Linux
is unchanged. On macOS the free-memory and swap figures turned out not to be a
pressure signal. Swap files are added on demand, so a nearly full swap is normal.
A 16 GB Mac with 2845 MiB available read as elevated only because 274 MiB of its
swap was free. The samples are still logged (debug every 30 seconds, info when
the computed level changes) for calibration. Using the kernel's own pressure
level (`kern.memorystatus_vm_pressure_level`) as the signal is tracked in #1256.

The reader below still runs; its levels are logged, not acted on.

macOS free pages do not include much of the reclaimable cache. Darwin never uses
`os.freemem()` as available RAM. The async reader runs `/usr/bin/vm_stat` and
`/usr/sbin/sysctl vm.swapusage` with literal argv, `LC_ALL=C`, a 32 KiB output
limit and SIGKILL on timeout. Each read has a two-second monotonic deadline and
serves background sampling or doctor/status, never spawn admission. Results,
including unknown, are cached for 30 seconds and concurrent requests share one flight. Health
remains cache-only. Doctor/status use the same reader.

Available RAM is estimated as `(free + speculative + max(inactive, purgeable)) ×
header page size`. Printed vm_stat free excludes speculative; purgeable can
include inactive pages, so adding both would double count. Active, wired and
compressor pages are excluded. This is a conservative estimate, not Linux
MemAvailable or the Activity Monitor memory-pressure graph; non-overlapping
reclaimable pages can be underestimated. Missing, duplicate, invalid, unsafe or
larger-than-physical-RAM counts remain unknown. Swap uses sysctl's decimal binary
MiB values; a valid zero-sized pool is not exhausted swap and missing data is
null. These measurements are diagnostic even when valid; they provide no
memory-pressure admission protection on macOS.

A logical timeout returns unknown even if child cleanup is delayed. The old pair
retains its physical reservation until both close; another pair cannot start
while cleanup is unconfirmed. Stop cancels the logical flight and kills children,
invalidates cache, and fences late results; restarting retains old physical
reservations. No native subprocess runs synchronously on the fleet event loop.

Unknown Darwin measurements stay unknown rather than falling back to
`os.freemem()`. They change diagnostic output only. Neither successful nor failed
native probes enable a memory-pressure admission policy on macOS. Linux's
existing fallback/unknown policy is unchanged.

Published captures and provenance are in `tests/fixtures/darwin-memory/SOURCES.md`.
Development and regression/mutation checks were on Linux with injected fixtures
and child-process stubs. **Live macOS user validation is pending.**

Rollback is a code revert; there is no state or configuration migration. Reverting
the advisory-only change restores the earlier macOS admission behavior, including
the risk of false pressure alerts and delayed starts from these estimates.
