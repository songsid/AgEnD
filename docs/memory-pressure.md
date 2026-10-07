# Host memory pressure

One fleet sampler reads Linux `/proc/meminfo` every 30 seconds and before spawn
admission. It uses `MemAvailable`, rather than `MemFree`, and distinguishes no
swap from missing swap information. On Linux and other non-macOS platforms, portable fallback reports free RAM and
unknown swap; free RAM alone can slow starts but cannot impose an indefinite
hold because reclaimable Linux cache may account for the difference.

The gate applies to startup, wake, restart and recovery, including the first
spawn and a daemon's nested acquisition inside a fleet lifecycle operation.
Nested waits retain the outer concurrency/workspace slot without reacquiring
it. Outer fleet reservations are tagged as lifecycle work; actual spawn callbacks
are counted separately so a pressure change after several reservations cannot
start their nested CLIs concurrently. Already running callbacks may finish.
Shutdown rejects queued and nested waiters and clears their retry timer.

| Condition | Action |
| --- | --- |
| Available RAM below `max(300 MiB, 2% of RAM)` | Wait; start no new CLI |
| Available RAM below `max(2 × critical threshold, 5% of RAM)` **and** swap free at most 5% of a nonzero swap total | Wait; start no new CLI |
| RAM below that second threshold, or swap free at most 5% | At most one operation at a time, starts at least 5 seconds apart |
| Invalid/unreadable Linux or other non-macOS sample | Same slow admission; never treat unknown as zero RAM |
| Invalid/unreadable macOS sample | Configured concurrency/stagger; debug only, no pressure warning or notification |
| Healthy RAM and swap | Configured concurrency/stagger, subject to the existing storm cap |

Critical waits retry after 5, 10, 20, 40 and then 60 seconds (maximum), retaining
the original request without running/retrying the spawn operation. A critical
hold cannot end below 1.5 times its RAM threshold. After a hold clears, the first
actual resumed admission starts a 30-second slow ramp, even if background
sampling detected recovery before the retry deadline. An elevated state clears
above 1.2 times the low-RAM threshold and, when known, above 10% swap free.
Configured stagger and storm limits remain additional restrictions. Active
CLIs are never killed or cancelled by this policy.

`/health` adds `hostMemory` alongside the distinct fleet process/cgroup `memory`:
level, RAM/swap values, sample timestamp, recovery flag, bounded sample count,
and change per minute in RAM available/swap free over at most 12 samples.
Trend needs at least one minute; missing swap stays null. Health reads use the
cached snapshot and cannot create trend samples. Pressure marks health degraded;
the systemd watchdog remains independent of health.

Structured warnings include the snapshot/trend on transitions and at most every
10 minutes in an unchanged state. Full samples are debug logs. Localized General
notices have a separate 10-minute cooldown independent of changing measurements;
critical escalation can notify immediately. No adapter means the notice cooldown
is unspent. The existing notifier counts dispatch, rather than platform delivery.

Sampling starts before the first CLI and stops before asynchronous fleet shutdown.
At cold boot, a memory hold can precede adapter/health-listener startup: the
warning is visible in logs first; channel notices become available once adapters
start. Startup can remain waiting until the host recovers. This is host pressure
protection, not a per-cgroup memory limit or an OOM predictor. It does not change
delivery, auth, systemd restart policy, or core dump handling. Rollback is a code
revert; there is no persisted-state or configuration migration.

## macOS

**Since #1257, macOS is sampled for the log only.** No memory-pressure channel
notice is sent, spawns are never slowed or held for memory, admission does not
wait for a sample, and fleet health does not report host memory pressure. Linux
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
limit and SIGKILL on timeout. One read has a two-second monotonic deadline;
first/stale spawn admission yields while it runs. Results, including unknown,
are cached for 30 seconds and concurrent requests share one flight. Health
remains cache-only. Doctor/status use the same reader.

Available RAM is estimated as `(free + speculative + max(inactive, purgeable)) ×
header page size`. Printed vm_stat free excludes speculative; purgeable can
include inactive pages, so adding both would double count. Active, wired and
compressor pages are excluded. This is a conservative estimate, not Linux
MemAvailable or the Activity Monitor memory-pressure graph; non-overlapping
reclaimable pages can be underestimated. Missing, duplicate, invalid, unsafe or
larger-than-physical-RAM counts remain unknown. Swap uses sysctl's decimal binary
MiB values; a valid zero-sized pool is not exhausted swap and missing data is
null. Valid RAM still supports RAM-pressure protection if swap cannot be read.

A logical timeout returns unknown even if child cleanup is delayed. The old pair
retains its physical reservation until both close; another pair cannot start
while cleanup is unconfirmed. Stop cancels the logical flight and kills children,
invalidates cache, and fences late results; restarting retains old physical
reservations. No native subprocess runs synchronously on the fleet event loop.

Before #1257 the levels below applied on macOS. When Darwin availability cannot be measured, memory restrictions are removed:
no pressure warning, no notification cooldown consumed, no five-second memory
stagger or concurrency reduction, and no retained critical hold/recovery ramp.
Configured/storm/workspace limits still apply. This deliberate fail-open policy
means a Mac with failed native probes has **no memory-pressure protection** until
measurement succeeds. Linux's existing fallback/unknown policy is unchanged.

Published captures and provenance are in `tests/fixtures/darwin-memory/SOURCES.md`.
Development and regression/mutation checks were on Linux with injected fixtures
and child-process stubs. **Live macOS user validation is pending.**

The fix is split into two commits. If the native probe needs rollback, revert its
second commit while retaining the first commit's Darwin-unknown policy. No state
or config migration is needed; reverting both reintroduces the free-memory false
positive and is not the preferred rollback.
