# Compact/paged agent lists (M3033/S132, Refs #3788)

Only agent tool/CLI replies change. Schedules keep their existing target/authority facade; decisions are projected after project/team/archive/tag filtering; tasks retain existing live/status/assignee/project/parent and write rules. The dashboard's store readers retain their defaults. A new optional board cursor resolves against matching IDs before reading one bounded page, so paging can pass the old50-card store cap; plain tasks page before the old100-row tool cap.

Defaults:20 titles/IDs plus the small status/timing metadata needed to choose a record. `limit`1–100 and `cursor` from `next_cursor` page the current filtered view; follow all pages after startup. Unknown, removed or nonmatching cursors fail with the same error. Keep filters unchanged. Concurrent writes can change membership/order: this is not an immutable snapshot. Detail and pagination are mutually exclusive so options are never silently ignored.

`detail:true` returns full schedule records, complete decision records (single id or all), complete task gets, and legacy task-list rendering/caps. Legacy `full:true` for decisions and `verbose:true` for task lists remain aliases. Full board gets preserve goal, acceptance, comments and version; compact gets give title/status/version and a direct full-read hint. Read detail before taking work or applying a decision. Task writes/mine/projects and web output are unchanged.

The fleet's actual tool responses were captured read-only in private ignored scratch and replayed through the candidate projections. No raw schedule messages, decision titles or task body are committed. The task text and compact metadata are checked to refer to the same actual card. The decision capture already contained titles; the large response came from an unbounded title inventory (and explicit id/full requests can additionally carry bodies). This is not a deployed-candidate claim.

| Actual reply | Before bytes | Candidate first-page bytes | Reduction |
| --- | ---: | ---: | ---: |
| list_schedules |33772|3933|88.4%|
| list_decisions |42097|4667|88.9%|
| task get |1836|326|82.2%|

Repeat with an operator-owned JSON capture (`schedules`, `decisions`, `tasks` metadata, `taskText`):

```
node --import tsx scripts/manual/compact-agent-lists/measure.mts /owned/actual-before.json
```

Fail-first: six new cases fail against the old implementation. Current11 focused files186/186 plus7 real loopback CLI flag checks pass. Six independent reversals (default page bound, decision detail opt-in, schedule detail, board cursor, plain cap-before-page and unknown cursor refusal) each fail assertions and were restored; final exact-head counts are in the PR acceptance. Controls cover full-detail bodies/checklists/comments, visible-only decision lookup, missing/hidden cursor refusal, no ignored detail on writes, preserved status filters, pagination through63board and125plain tasks without duplication, and unchanged store cap. Old full-shape tests explicitly opt into detail without dropping assertions.

No real account, vendor CLI, browser or live fleet mutation. Rollback by reverting; no persistent schema migration. Main first, alpha twin; parity approval and exact-head CI before coordinator-only merge.
