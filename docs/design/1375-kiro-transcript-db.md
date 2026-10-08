# Kiro transcript polling off the fleet loop (#1375)

Part of #1235; milestone 2.1.13, backport candidate for `release/2.1`.

## Attribution

The production slow-call ring named `kiro.transcriptPollDb` in three stalls:
1,125 ms of 1,136 ms at 09:08; 930 ms of 1,282 ms at 09:19;
and 5,005 ms of 5,029 ms at 12:27 (2026-10-08).
The latter exceeds Discord's three-second slash acknowledgement budget.
These are measurements of the wrapped call, not a diagnosis of every native operation inside it.

At the pre-change main `b02c2752`, the path was:

- `src/daemon.ts:2299`: create the Kiro transcript source at startup.
- `src/transcript-monitor.ts:183`: poll each resident monitor every 2,000 ms.
- `src/transcript-sources.ts:488`: `pollDb` invokes synchronous SQLite and JSON parsing before returning its Promise.
- `src/transcript-sources.ts:459`: history query uses only `conversation_id`, then `ORDER BY updated_at DESC LIMIT 1`.

Kiro's primary key is `(key, conversation_id)`; its other indexes begin with
`key, updated_at` and `updated_at`. The history query therefore scans the table
and builds a temporary ordering B-tree. The selected `value` TEXT is copied to
JavaScript and the entire history is parsed on the fleet loop. The `created_at`
column follows that TEXT in the record, so reading it also walks overflow pages.
The unchanged-row probe already uses `octet_length(value)` and an indexed timestamp;
that cheap path from #1048 is retained.

A readonly backup snapshot contained 581 rows, 1,326,531,605 bytes of TEXT,
and a largest row of 50,489,631 bytes. No index or schema is changed in Kiro's store.
The existing SQLite busy timeout is five seconds: it could account for a
5,005 ms call under contention, but no lock trace proves that was the production cause.
Cold pages, TEXT materialisation, JSON parsing and GC are additional possible contributors.

## Readonly snapshot benchmark

The snapshot was made with SQLite's backup API from a read-only URI, without
writing, checkpointing, renaming, or changing the live store. All probes below
use warm readonly connections on that private copy, SQLite 3.51.3. Five trials
per query/read; timings use `performance.now`. No transcript content or identifiers
are included in the results.

| Probe | Count | Warm measured cost | Interpretation |
| --- | --- | --- | --- |
| Old full history SQL, largest 50.5 MB row | 5 | median 251.50 ms | Table scan and TEXT copy; excludes JSON parse |
| Keyed full history SQL, same row | 5 | median 127.52 ms | Primary-key search; still copies the selected TEXT |
| JSON parse, same row | 1 | 270.14 ms | Cannot be removed by changing the SQL index alone |
| Unchanged metadata probe | 5 | median 0.0062 ms | Not the slow changed-history path |
| Resident polling | one per Kiro source | every 2 s | A changed history pays the full read/parse cost |

The end-to-end comparison uses the **three largest current workspace rows**,
not old larger sessions. Before: the old history SQL plus full JSON parse on the
main thread. After: the actual compiled worker, one warm reader connection per
source; a forced changed signature with an end-of-history cursor. No events are
replayed. A 2 ms main-thread timer measures responsiveness separately from completion.

| Current row | Before median | Worker median | Before maximum timer gap | Worker maximum timer gap |
| --- | ---: | ---: | ---: | ---: |
| 27,097,196 bytes | 224.09 ms | 140.36 ms | 248.03 ms | 3.35 ms |
| 26,858,735 bytes | 273.24 ms | 144.06 ms | 320.45 ms | 3.07 ms |
| 18,732,234 bytes | 195.14 ms | 127.99 ms | 233.55 ms | 3.21 ms |

These warm results show that the measured database/parse work leaves the main
loop. They do not reproduce the production five-second contention or predict
worst-case event-loop latency under host pressure. Snapshot size and modification
time were unchanged after the benchmark. Raw snapshot and records remain private.

## Ownership and deadlines

`KiroSessionSource` sends baseline/read requests to one fleet-wide physical
worker. The worker alone opens readonly SQLite, stats the store, resolves cwd,
reads TEXT and parses histories. Persistent handles/prepared statements remain
warm per source. History and creation queries now include both `key` and
`conversation_id`; no foreign workspace with the same ID can be selected.

Only incremental events and a cursor return to the main thread. The existing
signature, compaction baseline, tool-name matching, conversation-switch and
legacy JSONL fallback behavior are retained. Startup awaits the asynchronous
baseline before arming the transcript monitor; launch epoch, abort and monitor
identity are rechecked afterward. Source close/reset and monitor stop/reset
invalidate pending results, including batches stopped by an event listener.

A monotonic 15-second total budget includes queue and worker startup. There is
at most one pending request per source, coalesced; the worker serialises SQL.
An overdue result cannot commit even if the deadline timer has not run. Timeout
resolves with no DB result and requests worker termination. The physical slot
remains reserved until exit, even if termination rejects; waiting requests have
their own deadlines and cannot create replacement-worker herds. A subsequent
reader resumes from the last accepted cursor. Last-source close disposes the worker.

## Remaining unknowns and limitations

The unattributed 08:49:41 / 08:50:41 / 08:51:41 stalls remain **unknown**. They
are separated by 60 seconds, but each warning reports a 30-second window; the
warning timestamp is not the exact blocking instant. Possible timer paths include
the shared tmux safety sweep and progress bubble, and the 30-second reply-obligation
sweep's unwrapped SQLite. No nearby timestamped log proves which caused them.
A bounded `/profile 180` capture during recurrence is the next attribution step.

This change does not eliminate all sync work, native/GC pauses, or legacy Kiro
JSONL scanning. Worker allocation adds a thread, readonly connections and copied
event payloads. A very large new assistant text can still cost structured-clone
work on the main thread. One shared worker can delay progress under heavy writes;
timeouts or unavailable DB reads can temporarily leave transcript progress absent
or use the existing fallback. Native SQLite termination may finish late. None of
these failures grants permission, changes delivery verdicts, or writes Kiro data.

Rollback: revert this PR; no data/schema migration or settings changes exist.
That restores synchronous polling and its known stall risk.
