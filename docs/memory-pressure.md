# Host memory pressure

One fleet sampler reads Linux `/proc/meminfo` every 30 seconds and before spawn
admission. It uses `MemAvailable`, rather than `MemFree`, and distinguishes no
swap from missing swap information. Portable fallback reports free RAM and
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
| Invalid/unreadable memory sample | Same slow admission; never treat unknown as zero RAM |
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
