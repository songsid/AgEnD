# Room owner and live-update follow-up

Draft stacked on #3866 at `13bbaf92f46336ecbdafe800b7d0b46663292642`. Do not gate until that parent is merged, followed by a plain alpha sync, resolution review and current-head CI. The coordinator owns merging.

Own product scope is two files: recorded owner metadata in room answer projections and bounded retries for transient read contention on the rooms stream. The two actual HTTP/SQLite regressions are in the existing room suites. No protocol, schema, migration or permission changes.

The integrated UI packet is separate: [76 browser checks and14 original views](https://github.com/songsid/AgEnD/tree/472aac0c60586fe416346d35611e1f31f558abac/docs/evidence/hub-rooms-integration-r3/r5-owner-thread), source `f22af317b`. It uses four owned Fleet fixtures, inert directory/input/reporting and actual HTTP/TLS/WSS/SQLite. It is not full S-142 or a Team-provider acceptance. Lumen's affected-view recheck is pending.

Focused acceptance here: four files,43/43. Native verdicts and exact-head acceptance are recorded in `docs/evidence/hub-room-owner-live/` before the ordinary review request. Parent #3866 and full S-142 remain separate holds.
