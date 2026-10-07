# #1235 part 1: event-loop blocking inventory

Baseline: `19f88981154ba2ea5a60a92d3e1b0554bd966c23`. This PR covers fleet discovery, Kiro launch probing,
install verification and statusline polling. Discord REST keep-alive is part 2, outside this PR.

## What the historical log establishes

Read-only inspection of `~/.agend/daemon.log` and `.1`, 2026-10-07 (pretty log clock: Asia/Taipei):
30 stalls, six over Discord's 3-second acknowledgement budget. The maximum is 6,556 ms.
`event-loop-watch.ts` samples the histogram every **30 seconds** and resets it: the printed time is the
reporting phase, not the start time of a blocking caller. Eight reports at second `:09` do not identify
a per-minute offender. No historical line contains caller durations, so **all 30 causes remain unknown**.

The table below lists timestamped instance start/wake/restart/respawn labels in the preceding 30 seconds.
The search includes `Starting <name>`, not just `Starting instance`. One of 30 windows has hits (3.3%);
none of the six >3s windows does. This is correlation, not causation: missing labels do not prove that
no spawn happened. The low hit rate does **not** support calling spawn probes the steady-state cause.

| Stall report (local) | max ms | Start/wake/restart/respawn labels in preceding 30s |
| --- | ---: | --- |
| 11:45:58 | 1402 | none logged |
| 15:39:29 | 3441 | none logged |
| 15:39:59 | 3473 | none logged |
| 15:40:29 | 3163 | none logged |
| 15:42:30 | 1021 | none logged |
| 16:14:00 | 1135 | none logged |
| 16:16:00 | 1171 | none logged |
| 16:17:00 | 1511 | none logged |
| 16:18:00 | 2242 | none logged |
| 16:24:05 | 6556 | none logged |
| 16:24:35 | 1672 | none logged |
| 16:30:06 | 1087 | none logged |
| 16:33:36 | 1192 | none logged |
| 16:34:06 | 1393 | none logged |
| 16:51:07 | 3727 | none logged |
| 16:51:37 | 1966 | none logged |
| 16:53:08 | 1163 | none logged |
| 17:12:08 | 1010 | none logged |
| 17:20:09 | 5058 | none logged |
| 17:21:09 | 2004 | none logged |
| 17:22:09 | 1024 | none logged |
| 17:23:09 | 1481 | none logged |
| 17:24:09 | 2296 | none logged |
| 17:27:09 | 1185 | none logged |
| 17:28:09 | 1316 | none logged |
| 17:29:09 | 1874 | none logged |
| 17:37:31 | 1574 | 17:37:04 研一官網-t1544335726169165914; 17:37:08 github-iso-flow-t1544957419560640532; 17:37:13 rd1-sr4-server-t1547091841202130997; 17:37:18 agend-dev-muse-t1552480607068495872; 17:37:22 鬥破開發-opus-t1547168934623445013; 17:37:26 agend-web-claude-t1554485732591276113 |
| 17:40:01 | 1027 | none logged |
| 17:40:31 | 1037 | none logged |
| 20:09:02 | 1056 | none logged |

## Caller, trigger, and cost: do not mix different kinds of evidence

`N` = active statusline watches, `K` = Codex rows, `B` = open UI/SSE clients. The supplied fleet roster was
72 configured / 39 running; this audit did not start a fleet or independently enumerate live panes.

| Caller on baseline | Trigger and count | Measured cost / ceiling | Change |
| --- | --- | --- | --- |
| `backend/types.ts:resolveBinary`, `instance-lifecycle.ts:checkBinaryInstalled` | Fleet-topic start: up to **3 which** (knowledge, install check, daemon ctor); Classic start: 2 | Prior #1231 idle measurement ~10ms each; ctor which had **no timeout** (not a measured duration) | Remove knowledge ctor; async argv-only which, 2s child timeout; ctor receives resolved path |
| `backend/types.ts:commonBinaryDirs` | PATH miss, up to 2 npm prefix calls per fleet-topic start | Prior #1231 idle ~90ms ×2; existing timeout ceiling 3s each | Async npm; same ordered nvm/common/custom-prefix/executable fallback |
| `backend/kiro.ts:cachedKiroCliCompatibility` | New binary generation / unknown result older than 60s; wake/restart/crash reuse calls buildCommand | No production per-call measurement; up to two CLI children, **5s each ceiling** | Async, generation-keyed single-flight in prepareLaunch; command build cache-only on fleet backends; existing daemon launch fence retained |
| `fleet-manager.ts:locateBinaryOnLoginShell` | Installer completion, once | No typical measurement; **10s ceiling**, not “10s measured” | Async bash -lc, executable-file checks; claim/cancel/shutdown fenced before PATH adoption/sign-in |
| `statusline-watcher.ts:watch` | Every 10s ×N | Private warm 2KiB fixture, 100 rounds: p50 0.0072ms, p95 0.0123ms; ×39 ≈0.28ms nominal | Async reads, four physical reads max, one pending/registration; old stopped/restarted results dropped |
| `codex-metadata.ts:readCodexEffortLevels` (remaining) | Every UI snapshot (10s ×K×B, and API enrichment) | Private warm 5MiB fixture, 30 rounds: p50 10.51ms, p95 12.31ms ×K×B; fixture is near the existing size bound, **not production row size** | Slow-sync attribution tag; unchanged policy/output |
| `transcript-sources.ts:KiroSessionSource.newestDbRow` | Every 2s ×Kiro monitors | Private warm 26.8MB row, 100 rounds: octet_length p50 0.0036ms, p95 0.0054ms | Already header-only (#1048), not a new fix |
| `transcript-sources.ts:readKiroConversationStatus` (remaining) | Forged-envelope inspection; reads history on demand | Private 26.8MB metadata length(TEXT) fixture: p50 16.67ms, p95 21.75ms, 30 rounds; real includeHistory=true also parses history, **not measured here** | Slow-sync tag; no SQLite worker or policy change |
| `topic-commands.ts:scrapePaneContext` (remaining authoritative /ctx) | Explicit bypass-cache request, not the default UI sweep | Prior #1231 idle 2–4ms; existing 2s timeout ceiling | Slow-sync tag; do not claim it is the 60s sweep |

Fixture timings use `performance.now`, synthetic files in a private scratch directory and warm page cache.
No live tmux, backend binary, fleet or shared Kiro database was used. The measured script/results are in
`.artifacts/1235/{measure.mjs,fixture-costs.json,correlate.py,correlation.json}` in the author worktree.
Prior measurements: `docs/design/1231-discord-slash-ack.md:29–45`; these are prior evidence, not a new production benchmark.

### Suspects already off this loop

- The shared 60s tmux control safety sweep calls async `TmuxManager.capturePane`; non-Claude UI context is
  async stale-while-revalidate. Neither is a serial synchronous capture sweep on this baseline.
- Process-tree `ps/pgrep` memory walking is consumed by the separate `agend ls` CLI, not fleet UI memory.
- CLI environment/catalog probes already run in bounded workers (#1159). No additional worker threads here.

## Remaining slow-work attribution

A 64-entry ring records only synchronous stretches >=50ms, tagged with static code-owned caller names and
monotonic duration/end time. No per-call logging, raw pane, command, credential or new timer. The existing
stall WARN appends entries from its observation window, or says unknown. Nested spans are **not additive**.
Tags cover retained binary/Kiro sync compatibility paths, lifecycle process identity, authoritative pane
scrape/tmux version, statusline getters, Codex effort metadata, Kiro transcript/status reads, UI snapshots,
Classic config reload and bundled skill publication. This is bounded partial attribution, not instrumentation
of every fs syscall or SQLite write in the codebase. Slow code outside these tags can still report unknown.

## Safety, limits and rollback

- Discovery is fresh (no cross-profile backend singleton); binary fallback order and validation remain intact.
- Lifecycle epoch is checked after installation discovery and before backend construction/publication. Kiro
  uses the existing Daemon prepareLaunch ownership fence; compatibility is published only at command build.
- Statusline registration identity survives name reuse: unwatch/stop/restart discards pending results before
  cost/rates/notifications/failover. Physical reads remain counted until completion.
- Startup may still wait for the same probe timeout; it no longer freezes ingress while doing so. Async child
  timeout is a kill request, not a guarantee about OS cleanup under host thrash. Small ctor/fs writes, SQLite
  work and JSON parsing remain synchronous. **Do not claim the 30 historical stalls are fixed.**
- Rollback: revert this PR; no config/state migration. It restores blocking discovery/polling, so collect the
  new attribution before judging whether it needs reverting.
