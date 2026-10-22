# Early dashboard during startup (#2398)

The old listener came after every General, worker and Classic start, adapter setup and completion post. On a large
fleet, the reconnect banner therefore lasted for the entire staggered boot. The listener now binds after env/config,
auth, restored history/roster and scheduler/task-board setup, immediately before the first General.

HTTP availability is separate from readiness. `finishStartup` and `READY=1` remain after the existing startup work;
`/health` continues to return 503 until that boundary. The generated `Type=notify`, `NotifyAccess=all` (the helper
requirement repaired by #2336), watchdog and 15-minute startup timeout are unchanged. Launchd still owns the same
process; no new readiness signal or service-unit setting is introduced.

`startup` in status frames is temporary presentation (`ready`, `total`, `failed`). Instance `startup_phase` is queued
or starting; the process/execution status contracts remain unchanged. The roster includes configured Classic rooms
and excludes persisted pauses. Ownership protects both replacement attempts and replacement boots. SSE/poll carry
the presentation; guest projection carries only the guest's instance phases, never fleet totals or hidden names.

The early dashboard is read-only, apart from authentication. After existing Host/session/guest admission, writes get
503, `code: fleet_starting`, a localized reason and `Retry-After`. This prevents competing starts, config reconcile,
task dispatch and chat wake/delivery during boot. Reads use the initialized stores: Needs you safely starts empty,
the board DB is available, and usage/cache reads retain their existing bounded background behavior. Returning guest
sessions with an uninitialized configured adapter world receive 503 pending without being revoked or receiving data;
the same cookie is checked normally once the world exists. Disabled guests, revoked sessions, removed connections and
initialized denied/narrowed scopes retain their normal rejection. No automatic
resubmission is introduced.

A full process replacement retains a brief unreachable interval while the old process exits and the new process
initializes the listener. Socket activation/handoff would add ownership and platform complexity; this change keeps
the existing reconnect behavior for that interval, then shows live startup progress. Soft restart keeps its server.

Verification uses real ephemeral HTTP and real startup ordering with native child/tmux/provider boundaries inert,
held General/worker/listener promises, startup mutation/auth controls, readiness ordering, guest projection and UI
state transitions. The beta.25 rehearsal must use an isolated container/scratch fleet and mock backend, never the
live host fleet or tmux server. Reverting this change restores the old listener ordering; there is no migration.

## Candidate rehearsal

The pre-merge candidate was rehearsed with the compiled CLI and bundled Node 22.23.4 in a private, network-disabled
`agend-rh-225-bus` container (image `a7fefb5aea2e`). No host mounts, host tmux socket, real backend or provider
were used. The container had a scratch `AGEND_HOME`, a synthetic Claude executable (15-second General readiness,
4-second workers), and a real systemd user service with the unchanged notify directives. Startup used concurrency 2
and stagger 500 ms; the workers reached a measured peak concurrency of 2.

The first successful HTTP observation was before General readiness: the service was still activating, status showed
0/3 with General starting and workers queued, `/health` returned 503, and a chat write returned 503 `fleet_starting`.
After General readiness, status showed 1/3 while workers started. At completion all three were running, the startup
banner data cleared, `/health` returned 200 and systemd changed to active. Loaded properties were `Type=notify`,
`NotifyAccess=all`, `TimeoutStartUSec=15min`. The scratch service was stopped and the container left stopped; no
host service, fleet or backend was touched. This verifies the candidate's ordering, rather than claiming a rehearsal
of a beta.25 release artifact that has not been published yet.

Six independent reversals were caught at semantic assertions: restore the late listener, omit the listener await,
notify READY early, remove startup write admission, accept stale attempt completion, and count a failed start as ready.
After restoring source, all nine new tests passed. Existing spawn-gate/pressure/storm and service-readiness tests
remain unchanged.

The guest review added a persisted-cookie cold-start regression: missing configured worlds yield only 503 pending,
the on-disk session remains valid, and the same cookie succeeds after world initialization. Five negative controls
keep disabled/revoked/removed-connection/denied/narrowed access rejected. The five startup/guest suites pass 49 tests.
Three further independent reversals are caught: omit pending, ignore initialized worlds, and allow pending for removed
connections. The restored boot/HTTP suite passes all 10 tests; fixture setup failures during test construction are
not counted as reversal evidence.
