M-3183 is the beta.4 MCP startup blocker. Since #3919, each tools/list awaited hub_room_status through the starting
Fleet manager. That could take about30s, losing Claude's reply tools or Codex's MCP process before the agent could
answer. The user's settled direction is a static AgEnD connector catalog, including the permitted Hub tools.

The connector now builds its list synchronously from TOOLS, its configured tool profile and the existing dashboard
permission ceiling. It performs no Hub query at list time, no background availability probe and no availability cache.
Hub-state notices no longer emit tools/list_changed. Existing IPC reconnect and dashboard-permission notifications
remain; this change does not alter tool profiles or grant caller authority. Every Hub tool call still uses the current
Fleet/agent/link checks. A missing link returns {ok:false,code:"unavailable",message:"This Fleet isn't connected to a
Hub."}; an obsolete invoking agent gets its specific refusal. The built-in Hub skill and both change fragments match.

Bindings in manifest.json refer to the tested source4661b2f65. Validation is one focused local campaign:

- Restoring the original mcp-server.ts from base16339cb48 produces two semantic failures in the new three-case
  actual-stdio suite: tools/list times out under the900ms test ceiling, and the catalog waits on Hub availability.
  The minimal-profile case passes. Exact original/candidate/restored file hashes are in baseline-binding.json.
  The corrected baseline has no unhandled errors.
- Final38/38 across five files: actual stdio startup, existing Hub MCP/actor controls, dashboard permissions,
  IPC timeouts, and the existing actual MCP→member factory→pinnedWSS→HubHTTP/SQLite/audit retained-return journey.
  Physical agent input, directory and channel reply are inert. No vendor CLI, live Fleet/AD, browser or pane was run
  locally. The existing tests now assert a static menu before/after Hub loss while a cached Hub call still refuses.
- The new startup test deliberately starts one test-owned diagnostic hub_room_status RPC with a reply scheduled35s
  later. It withholds the reply until after tools/list and a normal reply call succeed, then releases it for cleanup;
  it does not spend35s waiting. There is exactly one status request, all from that diagnostic, and none from listing.
  tools/list takes8.8,3.3,2.9ms in this run (all<1s); the worker catalog is63tools and70,100 UTF-8 bytes of result JSON.
  No claim is made about how vendor models put those bytes into context. The no-notification-storm and minimal-profile
  cases are independent actual-stdio controls. All owned children, sockets and delayed timers close with their fixture.
- Both final native TypeScript programs exit0. Commands/results are in final-results.json. No token, permission,
  startup-timeout, database, transport or account setting was widened. Initial exploratory cache code was discarded;
  its test failures are excluded from the final evidence and counts.

```sh
npx --no-install vitest run tests/mcp-tool-list-startup-m3183.test.ts tests/hub-room-post-mcp.test.ts tests/dashboard-permissions.test.ts tests/ipc-timeouts.test.ts tests/hub-room-post-rc-integration-3118.test.ts --maxWorkers=2
npx --no-install tsc --noEmit -p tsconfig.json
npx --no-install tsc --noEmit -p tsconfig.test.json
```

The remaining user-requested release proof is dev-claude2's focused U update+restart leg, packed from the public exact
head. This document does not claim that external rehearsal passed before its delivered receipt arrives. Until then
this PR stays draft; Fable can review the source, but there is no merge/gate readiness. Tool calls on an unpaired Fleet
now visibly refuse rather than disappearing from the menu; the user's static-list direction deliberately requires
that behavior. Rollback reverts these product/test/skill paths and restores the blocking regression; no state cleanup
or migration is involved. Prefer a compatible fix if another startup issue appears.
