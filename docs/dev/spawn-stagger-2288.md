# Startup admission timing (#2288)

The beta.18 and base `426fdd82d` SpawnGate blobs are identical
(`98870f1e5faf8df31f0f0a3300ce0f797396f7ad`).
FleetManager.startInstancesWithConcurrency reserves a
`stage: lifecycle` SpawnGate slot. restartSingleInstance and runStartupRetry
also reserve lifecycle slots. Daemon.trySpawn then enters the same gate for
the physical startup/wake/recovery, retaining its outer instance/workdir slot.

A normal-pressure nested admission had delay 0 but still reset lastStartedAt.
Preparation therefore moved the next outer stagger deadline. A gate timer can
also defer the nested admission until the existing deadline, which the nested
admission then reset again. Fake-time tests with preparation of 500/1700/2000 ms
prove that the next outer admission misses its 2000 ms deadline on old source.

Normal nested admission now leaves that clock alone. A separate physical-start
clock preserves the five-second guard when pressure rises after a healthy
nested spawn. Under pressure the last admission is the maximum of the two
clocks; physicalActive serialization, critical hold/recovery ramp, storm
backoff/jitter/cap 4 and working-directory reservations retain their guards.
Standalone wake/recovery/restart work still updates the ordinary clock.

The completion log `Fleet startup batch completed` records:

- totalInstances: runnable entries in this batch, excluding persisted pauses;
- readyInstances: entries reported up (failed entries may have scheduled retry);
- elapsedSeconds: monotonic time including time queued for this batch;
- peakConcurrentStarts: measured simultaneous lifecycle callbacks, including
  preparation and readiness, rather than configured concurrency or running CLIs.

This batch helper also serves full restart. Separately started General/classic
boot phases are outside its totals. A rejected batch does not claim completion.

Controlled simulation: 40 distinct workdirs, concurrency 6, 2 s preparation and 6 s
physical readiness per instance, normal pressure, no storm or other work:

| Stagger | Old duration / peak | Fixed duration / peak |
| --- | --- | --- |
| 2000 ms | 164 s / 2 | 86 s / 4 |
| 500 ms | 57.5 s / 6 | 57.5 s / 6 |

The 500 ms setting reaches the configured limit in this workload even on old
source; the fix removes the extra spacing when nested admissions would shift
outer deadlines. These are scheduler simulations, not measured host boot times.
Long CLI startup, shared workdirs, pressure, storm and other boot phases can add
time. No host fleet configuration, CLI, tmux or fleet process was touched.

Tests use fake time, real gate/storm scheduling, injected memory samples and an
inert FleetManager batch callback. Rollback is a revert, with no persistent
state or configuration change. Normal startup can now reach configured
concurrency sooner; the existing pressure/storm/workdir limits still apply.
