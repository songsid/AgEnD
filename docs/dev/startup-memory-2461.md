# Startup timeout convergence (#2461)

The incident had an initial watchdog abort under host thrash followed by a
separate feedback loop: critical memory held SpawnGate, startup never reached
READY, and TimeoutStartSec killed every agent every fifteen minutes.

Keep the final READY boundary. A `StartupMemoryDeadline` belongs to each
`startAll` call. Only a real queued startup memory wait renews its deadline;
the gate calls it immediately and a thirty-second timer keeps it renewed.
Each extension grants fifteen minutes, so after recovery an unrelated stuck
await still has a finite budget. Normal startup gets no extension. No unit
timeout, NotifyAccess, pressure threshold, admission concurrency, recovery
ramp, storm jitter or overall stop-budget setting changes.

Notifications use the existing async, fleet-PID checked NOTIFY_SOCKET
capability. Stop/error/completion retire the timer. An old completion checks
the attempt identity before finishStartup/READY; its finally cannot clear a
replacement's timer. Watchdog monitoring starts before General but still
proves main-loop liveness only; it cannot survive an actual kernel wait or
long frozen loop. It is not a cure for unlimited host workload.

Full shutdown and in-process `restartInstances` stop in bounded batches;
elevated/critical pressure caps them at five. Stops never wait for memory.
Linux resamples procfs before every batch, including after the periodic sampler
has stopped and async shutdown cleanup has finished. A stopped macOS probe is
not revived to size a quit batch: full shutdown uses the conservative five;
in-process restart uses its still-running sampler. Existing total stop budgets
remain unchanged.
Single-instance restart already acquires a lifecycle admission before teardown;
starts/wakes/recoveries recheck pressure at physical spawn. Direct stop-only
requests remain available to release memory.

The private rehearsal in `scripts/manual/startup-memory` runs original baseline
dist and candidate against the same controlled pressure input and persistent
systemd249 unit. It verifies an actual loaded short startup deadline, repeated
baseline timeouts, candidate same-PID survival while activating, eventual READY
and a mock sibling reply after release, plus a non-memory-hang timeout control.
It does not induce real memory pressure on the host. Rollback is a normal code
revert with no persisted-data migration.
