# Host memory pressure

One fleet sampler reads Linux `/proc/meminfo` and, when available,
`/proc/pressure/memory` every 30 seconds and before spawn admission. PSI
reports the percentage of time tasks stall on memory, rather than how full
swap is ([kernel format and semantics](https://docs.kernel.org/accounting/psi.html)).
The diagnostic-only memory reader does not request PSI; there is no new timer
or subprocess. A missing, unreadable or malformed PSI file falls back to RAM
and never creates a pressure hold by itself. It prefers `MemAvailable` over `MemFree` and distinguishes no swap
from missing swap information. On Linux and other non-macOS platforms, portable
fallback reports free RAM and unknown swap; free RAM alone can slow starts but
cannot impose an indefinite hold because reclaimable cache may account for the
difference. macOS uses only its kernel alarm; see [macOS](#macos).

The gate applies to startup, wake, restart and recovery, including the first
spawn and a daemon's nested acquisition inside a fleet lifecycle operation.
Nested waits retain the outer concurrency/workspace slot without reacquiring
it. Outer fleet reservations are tagged as lifecycle work; actual spawn callbacks
are counted separately so a pressure change after several reservations cannot
start their nested CLIs concurrently. Already running callbacks may finish.
Shutdown rejects queued and nested waiters and clears their retry timer.

| Condition | Action |
| --- | --- |
| Linux PSI `full avg10 >= 20%` | Wait; start no new CLI |
| Linux PSI `some avg60 >= 10%` or `full avg10 >= 5%` | At most one operation at a time, starts at least 5 seconds apart |
| Measured available RAM below `max(300 MiB, 2% of RAM)` on a non-macOS host | Wait; start no new CLI |
| Measured available RAM below `max(2 × critical threshold, 5% of RAM)` **and** swap free at most 5% of a nonzero swap total on a non-macOS host | Wait; start no new CLI |
| RAM below that second threshold on a non-macOS host | At most one operation at a time, starts at least 5 seconds apart |
| Linux PSI unavailable, RAM below 2×that second threshold, and nonzero swap at most 5% free | At most one operation at a time, starts at least 5 seconds apart |
| Other non-macOS host with nonzero swap at most 5% free | Existing slow admission |
| Invalid/unreadable Linux or other non-macOS sample | Same slow admission; never treat unknown as zero RAM |
| macOS kernel alarm `1` | Configured concurrency/stagger; no RAM/swap ratio restrictions |
| macOS kernel alarm `2` | At most one operation at a time, starts at least 5 seconds apart |
| macOS kernel alarm `4` | Wait; start no new CLI |
| Missing/invalid macOS kernel alarm | Normal concurrency/stagger and storm/workspace limits; no memory-pressure restriction or channel notice |
| Healthy Linux RAM and PSI (even with full cold swap), or healthy RAM/swap on other hosts | Configured concurrency/stagger, subject to the existing storm cap |

On Linux and other non-macOS hosts, critical waits retry after 5, 10, 20, 40 and then 60 seconds (maximum), retaining
the original request without running/retrying the spawn operation. A critical
RAM hold cannot end below 1.5 times its RAM threshold. A PSI hold ends when
`full avg10 < 20%`, unless a RAM safety condition still requires it. The
percentages above are initial AgEnD policy thresholds, not kernel-prescribed
limits or a calibrated OOM forecast. After a hold clears, the first
actual resumed admission starts a 30-second slow ramp, even if background
sampling detected recovery before the retry deadline. RAM elevated hysteresis clears at or above 1.2 times the low-RAM threshold.
Each Linux RAM/swap release threshold is armed only by its own actual trigger,
including when PSI fires simultaneously. A PSI-only level never arms a RAM or
swap hold that was not triggered; missing PSI cannot inherit such a hold either.
On Linux, swap release hysteresis applies only when PSI is unavailable and RAM
is below 2×the low threshold; above that RAM boundary, cold swap cannot pin
elevated. Inside it, swap must exceed 10% free to clear that clause. PSI has no
additional release threshold; the existing ramp still applies.
Configured stagger and storm limits remain additional restrictions. Active
CLIs are never killed or cancelled by this policy.

`/health` adds `hostMemory` alongside the distinct fleet process/cgroup `memory`:
level, RAM/swap values, sample timestamp, recovery flag, bounded sample count,
and change per minute in RAM available/swap free over at most 12 samples.
Linux snapshots also identify the trigger and include the measured PSI
averages. Logs identify PSI some/full, low RAM, low RAM plus swap, or the
recovery ramp; swap-free remains diagnostic.
Trend needs at least one minute; missing swap stays null. Health reads use the
cached snapshot and cannot create trend samples. Elevated or critical pressure
marks health degraded, including a verified macOS kernel alarm. Unknown macOS
alarms remain diagnostic and do not degrade health. The systemd watchdog remains
independent of health.

On hosts with actionable pressure, structured warnings include the snapshot/trend on transitions
and at most every 10 minutes in an unchanged state. Full samples are debug logs.

Host memory pressure never posts a chat broadcast on any platform or level,
including recovery. The Fleet dashboard indicator (`host_memory` in the status
frame), `/health` and logs show the pressure. It does not change admission.

When a user action actually reaches a critical admission hold, its original
chat reply says that host memory is low and it will continue after recovery.
This is once per pending action, not a General notice or a repeated retry alert.
Typed commands, slash commands and model/effort or backend selections use their
own reply/progress message. Background starts and recoveries have no chat reply.
The web's start/restart/wake request returns HTTP 202 with `held: true` and a
`message`; the queued operation continues and the usual status updates report
its eventual state. The UI displays that reason instead of claiming completion.

Sampling starts before the first CLI and stops before asynchronous fleet shutdown.
On non-macOS hosts at cold boot, a memory hold can precede adapter/health-listener
startup: the warning is visible in logs, without a channel broadcast. Startup can remain waiting until the host recovers. This is host pressure
protection, not a per-cgroup memory limit or an OOM predictor. It does not change
delivery, auth, systemd restart policy, or core dump handling. Rollback is a code
revert; there is no persisted-state or configuration migration.

## macOS

macOS uses `sysctl kern.memorystatus_vm_pressure_level` as the only pressure
signal: `1` means normal, `2` means elevated, and `4` means critical. Only one
canonical labelled line with one of those values is accepted. Available/free
RAM percentages and swap-free ratios never classify pressure on Darwin. A
16 GB Mac with 2845 MiB estimated available and 274 MiB free of 6 GB swap stays
normal when the kernel reports `1`. Swap files are allocated dynamically, so
that small free share is not evidence of thrashing.

A verified warning slows new starts; critical holds them with the existing
5/10/20/40/60-second retry policy. After critical recovery, the existing
30-second slow ramp applies (including a full ramp from the actual resumed
admission); its duration uses a monotonic clock. The ramp is temporal, with no
RAM/swap hysteresis on macOS. Configured, storm and workspace limits still apply.
Already running agents are unaffected. Logs identify the kernel alarm and keep
byte figures diagnostic. No kernel alarm sends a chat broadcast.

An unreadable, missing or noncanonical alarm is unknown: admission returns to
configured limits, any previous pressure hold/ramp clears, and no pressure
notice or warning is sent. Once per fleet sampler start/stop lifecycle, an info
log records the unknown raw pressure output (bounded to 1024 UTF-16 units, or
null when unreadable). Repeated unknown samples do not repeat that diagnostic. There is no free-% fallback; that would need separate calibration
from a real Mac. Linux's separate PSI/RAM policy is documented above; it cannot affect the
Darwin kernel-only policy.

The kernel command runs only on the existing 30-second fleet sampler, alongside
`/usr/bin/vm_stat` and `/usr/sbin/sysctl vm.swapusage`. Literal argv, `LC_ALL=C`,
a 32 KiB output limit and SIGKILL on timeout apply. The batch has a two-second
monotonic deadline. Admission joins an existing sampler flight or reads its
cached result; it cannot initiate a pressure command. Health is cache-only.
Doctor/status still use the bounded native RAM/swap reader, without starting a
kernel-pressure probe. Construction runs no native commands.

Available RAM is estimated as `(free + speculative + max(inactive, purgeable)) ×
header page size`. Printed vm_stat free excludes speculative; purgeable can
include inactive pages, so adding both would double count. Active, wired and
compressor pages are excluded. This remains a conservative diagnostic estimate,
not Linux MemAvailable. Missing, duplicate, invalid, unsafe or
larger-than-physical-RAM counts remain unknown. Swap uses decimal binary MiB;
a valid zero-sized pool is not exhausted swap and missing data is null. These
byte measurements cannot override a valid kernel alarm, even if vm_stat fails.

Results, including unknown, are cached for 30 seconds and concurrent requests
share one flight. A logical timeout returns unknown even if cleanup is delayed.
The old batch retains its physical reservation until every child closes; another
batch cannot start while cleanup is unconfirmed. Stop cancels the logical flight,
kills children, invalidates cache, and fences late results. Restart retains old
physical reservations. No native subprocess runs synchronously on the fleet loop.

Fixture provenance and the primary Apple source for the 1/2/4 mapping are in
`tests/fixtures/darwin-memory/SOURCES.md`. The kernel fixtures are representative
synthetic outputs; the development host is Linux. **Live macOS validation remains
pending.** This masked sysctl is not a promised stable public API; unavailable
versions keep the unknown policy above.

Rollback is a code revert; there is no state or configuration migration. Reverting
this change returns Darwin to the prior advisory-only policy, preserving the
absence of ratio-based false alerts but disabling kernel-based protection.
