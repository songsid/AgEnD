# #1235 PR-A: fleet stall attribution

Observation only: scheduling, synchronous/async choices, probe timeouts, SQL,
return values and lifecycle/delivery decisions are unchanged. Async conversion
is deferred to PR-B (#1339). On-demand CPU profiling is PR-A2 (#1338), off by
default with local operator controls and bounded/rotated artifacts.

## Evidence and limits

Read-only inspection of `~/.agend/daemon.log` and `.1` found 30 stall reports on
2026-10-07 (Asia/Taipei log clock), six over 3s, maximum 6556ms. Only 1/30
preceding-30s windows had timestamped start/wake/restart/respawn labels; none
of the six >3s windows did. Correlation is not causation. All historical causes
remain unknown. The existing histogram is checked every 30s: second `:09` is
a reporting phase, not evidence of a per-minute blocking sweep.

| Instrumented caller | Trigger / count | Cost evidence |
| --- | --- | --- |
| Binary `which` / resolver / installed check | Spawn, login/backend choices; up to 3 which per fleet-topic start | Prior #1231 idle ~10ms/call; constructor which has no timeout |
| `npm prefix -g` | Resolver PATH miss; up to 2/start | Prior #1231 idle ~90ms/call; existing 3s child ceiling |
| Kiro version/help and compatibility policy | Cold binary generation, unknown cache expiry, launch | No production per-call measurement; up to 2×5s child ceilings |
| Installer login-shell / lookup | Once per installer completion | No typical measurement; existing 10s ceiling |
| Statusline tick / context/model getters | 10s × watched instances, UI queries | Leader's real 1.4KiB/ext4 measurement ~5µs/read; 40/10s ≈0.02ms loop time/s. **Not a stall cause at normal FS latency** |
| Outbox `listPending` / `claimNext`, event insert/query | Pending-work pump and event logging/reads | Unmeasured, now attributed when >=50ms; SQL and transactions unchanged |
| Codex metadata, Kiro DB poll/status, UI snapshot, Classic reload, skill publication, process identity, authoritative tmux scrape/version | Existing query, poll and lifecycle paths | Partial coverage; future production durations, not assumed historical causes |

## Runtime contract

- `measureSyncWork` uses `performance.now`; spans >=50ms enter a 64-entry ring.
  Return values and thrown exceptions pass through. No per-call log or timer.
- Static caller tags only: no CLI argv, pane, SQL, message, token or credential.
  Nested spans overlap and must not be added together.
- The existing stall WARN appends entries completed in its observation window,
  or `slow sync work: unknown`. It reports correlated work, not a causal stack.
- A timer-free `PerformanceObserver` observes GC, logs pauses >=200ms (kind and
  duration), retains at most 64 and appends overlapping pauses to the same stall
  WARN. Checks drain pending observer records; stop disconnects the observer.
- This cannot identify every unwrapped better-sqlite3 query, large JSON parse,
  long regex scan or other JS/native work. An unknown label is an honest result.
  CPU sampling in #1338 will supplement this coverage; it is not enabled here.

## Verification and rollback

Use fake monotonic clocks, histogram/GC records, child_process and SQLite seams.
The caller tests execute the real resolver/Kiro/install/statusline/outbox/event
methods with stubbed effects. No fleet, live tmux, real CLI or shared DB.
Reverse mutations must typecheck and fail assertions for lost caller/GC evidence.

Revert this PR to remove observation; no schema/config/state migration, recovery
action, network listener, new polling timer or scheduling change is introduced.
