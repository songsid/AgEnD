# Host monitoring history — S-206

This implements bounded persistence for the approved [Host health design](host-monitoring-dashboard.md). The page availability flag remains false until S-207. Alerts, agent footprints, the real one-hour measurement with both options enabled, and final user-approved real-data captures remain later slices. The independent cron watcher is unchanged.

## Ownership and off

The runtime creates only a pure history controller. A cached current-health read or a history request cannot create a worker or open a database. An enabled collector passes numerical snapshots to the controller; persistence starts only after state-volume free space is known and, on WSL, the backing volume is identified. Missing metrics remain gaps. Volume series use opaque identifiers, never paths or native output.

One worker owns `host-monitoring.sqlite`. Source and compiled launches both use an explicit worker entry. SQLite, retention, aggregation and checkpointing run there, away from Fleet's event loop. There is one request in flight and at most two host frames buffered; late samples are dropped instead of building a catch-up queue. Host callbacks drive batches about once a minute, with an initial eligible frame; there is no extra persistence interval. Startup and requests have two-second deadlines. Failure stops further appends, rather than scheduling repeated writes or automatic worker restarts. The existing host cache continues.

Disabling revokes the shared write permission immediately, fences late replies and waits for physical worker exit before cleanup. An Off request during an already-draining retaining shutdown upgrades it to deletion. Re-enable waits for that cleanup. Shutdown retains history only when monitoring is still enabled; an interrupted disable receives one fixed-path cleanup at the next disabled startup. Cleanup unlinks only the database, `-wal`, `-shm`, `-journal`, `.incidents` and `.incidents.tmp`. It never opens SQLite, traverses a directory or follows a symlink target. A failure remains explicit and blocks re-enable. Default-off startup creates no worker, timer or history file. Ordinary core memory monitoring remains independent.

## Physical budget

The total hard ceiling is **64 MiB**, including database indexes, WAL, SHM and reserved incident state. The SQLite page size is 4096 bytes. Before opening, the worker checks only the fixed filenames, private ownership/permissions, regular-file type, link count and sizes. Unsupported/corrupt/foreign stores fail explicitly; they are not copied aside into an unbounded recovery file.

The database receives a `max_page_count` quota calculated so that **the whole database plus one full transaction WAL plus 128 KiB SHM plus 4 MiB incident reserve** fits under 64 MiB. This leaves about 30 MiB for the database itself. Dirty-page spilling is off: a transaction cannot emit an arbitrary stream of repeated page frames. Each transaction begins and ends with a truncate checkpoint. If an existing reader pins the WAL, no second transaction is admitted; a stuck reader cannot cause journal accumulation. Queries are completed/materialized in the same worker, with no long-lived reader or exposed iterator. No temporary database or VACUUM copy is used.

At the 56 MiB soft total, oldest history is pruned and the WAL is released below 48 MiB. Database plus SHM and incident reserve alone are deliberately smaller than 48 MiB. At lower totals, age, the 100,000-row ceiling and free-page headroom also prune oldest rows before growth reaches the database quota. The cap wins over advertised retention windows. This slice reserves budget, not a preallocated incident delivery file; S-208 owns that writer and its preallocation proof. The later incident slice must share the reserved aggregate budget; it cannot independently allocate another 4 MiB temporary copy.

## Retention and queries

Host raw rows retain up to 24 hours at 30-second resolution. Five-minute rollups retain up to 30 days, preserving minimum, maximum, total/count and newest source time. An upsert replaces a raw slot and recomputes its rollup from at most ten raw slots, avoiding retry double-counting. Gaps have null values and zero coverage; an unavailable pressure reading is not a healthy zero. Footprint retention is not implemented here.

`GET /ui/host-history?range=1h&series=cpu.used` accepts only the four ranges `1h`, `24h`, `7d`, `30d`, with one to 24 unique known series. It returns no more than 240 buckets per series. There is no path, SQL, immediate refresh or arbitrary time parameter. It requires an administrator browser session, including the existing gateway administrator session; header tokens, guests and read sessions are refused. The gateway admits only this exact GET. Authorization is checked again before an asynchronous answer is sent. Requests never start collection or persistence; off/paused/not-yet-started history returns an explicit unavailable result with no-store.

## Low-water policy

Below 2 GiB available on **either** state storage or the verified WSL backing volume, recording pauses and the current cache remains in RAM. Unknown backing storage, missing disk data and stale readings cannot authorize writes. Recovery requires both volumes above 4 GiB continuously for ten monotonic minutes; missing data or a boundary reading resets that interval. Wall-clock changes cannot speed recovery. The worker checks the shared write flag when a queued append executes. A transaction already executing cannot be recalled, but no additional append is admitted, and its late reply cannot turn a newer paused state into recording.

## Verification and remaining acceptance

Deterministic scratch tests cover real SQLite quotas, pinned WAL readers, soft/low pruning, retention and rollup extrema/coverage, worker execution, low-water hysteresis, bounded buffers, physical exit and exact cleanup. Actual HTTP listeners and the gateway cover admin access, validation and session revocation during a pending answer. No account, native platform probe, browser or recursive state scan is needed for this slice.

The worker has a 64 MiB V8 old-generation limit and a 1 MiB clean SQLite cache target; dirty pages during a bounded transaction can use additional native memory up to the database quota. These are implementation bounds, **not** an RSS or disk-write measurement. The earlier design's steady-state cost estimates remain unverified. S-209 must measure the complete enabled implementation for one real hour and update the final UI/cost evidence before user approval.

Rollback: persist monitoring false, wait for physical close and exact cleanup, then revert this slice. Leave the explicit false setting, the collector's original off behavior and the cron watcher intact.
