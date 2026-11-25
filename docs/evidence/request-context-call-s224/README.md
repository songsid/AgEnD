# Slice D: originating native call fences

A call from A must not acquire B's request context while a body, relay, staging
or commit waits under the same transport owner. The implementation captures once
and rechecks that original scope. No production rollout hook is installed.

## Results

- Implementation-review corrections: 538 tests pass across the 29 affected/neighbor files, plus 98 tests in the three CI-regression files (636 total across 32 distinct files). Source and test type checking is clean. The separate commands are recorded in verification.json.
- The initial 18 semantic guard reversals are retained from the initial implementation; six additional review-correction reversals fail and are restored at the current source revision. The ten transport/write/commit reversals include exact edits and test patterns in [mutations.json](mutations.json). Earlier immutable-scope, replay, interruption and local-hop controls are retained there too.
- The actual baseline v1 MCP ledger module loads an additive context reference and refuses redispatch. Its source hash/base are in [verification.json](verification.json). This is an old ledger-reader check, not a full old Fleet/IPC launch claim.
- A plain merge preserves all 40 owned ordered +/- patches against their respective bases. The later intentional caller-lease, relay cleanup and portable-module corrections are part of the final source hashes.
- The standalone bundle and reconnect checks initially caught the missing portable validator asset. Adding it to the shared pane asset inventory fixes both; the complete transport run includes the fix.

[verification.json](verification.json) binds source/test hashes, the tested source
revision, command, old-module probe and merge identity. Raw logs stay private.

## Controls and limits

Real loopback HTTP/WS and in-memory stdio exercise all transport legs with fake
PTYs. They cover bilateral support and missing-participant refusals, unsolicited
stamps, capture before a held body, original stdout-receipt attribution, final
write ordering after durable prepare, stale sequence/replay, write-failure
poisoning, staged-input retirement, ordinary queue deferral, permitted steering,
and original-scope delivery/task/channel commit checks.

An interrupted launch accepts later input but its contacts stay not-covered,
with a stable operation id and the shared one-approval reason. Known stale A
cannot become a fresh unknown retry. An older, genuinely unnegotiated host gets
only unknown per-operation scope, never a lookup of the latest admin root. The
central gate/card slices consume this metadata; they are not enabled here.

Review regressions cover dialog versus cancel-key Escape, ACK after turn/proof retirement with wrong-stamp and stale-transport negatives, acknowledged relay-stamp cleanup, manager-driven exact-launch proof retirement, durable exec recovery followed by independent input, and unconfirmed late-result wording. The CI repair changes only constructor-free fixtures; their real permission/quiescence assertions remain intact.

C's fresh owned transcript-end anchor remains a cutover prerequisite. There is no
generic queue-consumption proof, no same-user sandbox claim, and no live Fleet,
Windows host, CLI/provider/account or model experiment. Persistent covered
publication stays OFF; originating per-turn helper identity remains a follow-up.
Before cutover this dormant integration can be reverted. After activation, retain
the compatibility barrier and drain/cancel dependent work before downgrade.

## Repeat the focused verification

```sh
node_modules/.bin/vitest run \
  tests/request-context-call-s224.test.ts \
  tests/request-context-commit-s224.test.ts \
  tests/request-context-pane-s224.test.ts \
  tests/request-context-daemon-s224.test.ts \
  tests/request-context-daemon-s223.test.ts \
  tests/request-context-turns-s223.test.ts \
  tests/native-mcp.test.ts \
  tests/native-mcp-policy-generation.test.ts \
  tests/fleet-windows-runtime.test.ts \
  tests/runtime-pane-mcp-authority-2950.test.ts \
  tests/runtime-pane-mcp-relay-2950.test.ts \
  tests/runtime-pane-host-2950.test.ts \
  tests/runtime-pane-port-2950.test.ts \
  tests/local-pane-relay-2950.test.ts \
  tests/native-pane-manager-2950.test.ts \
  tests/native-pane-mcp-peer-2950.test.ts \
  tests/native-pane-machine-admission-2950.test.ts \
  tests/runtime-client.test.ts \
  tests/runtime-client-remote.test.ts \
  tests/runtime-client-liveness.test.ts \
  tests/runtime-client-worker-stop.test.ts \
  tests/runtime-client-remote-update.test.ts \
  tests/runtime-client-bundle.test.ts \
  tests/runtime-coordinator.test.ts \
  tests/channel/tool-router-reply-files.test.ts \
  tests/channel/tool-router-state-file-refusal.test.ts \
  tests/cli-upstream-precheck.test.ts \
  tests/child-stdio-errors-2374.test.ts \
  tests/local-pane-launcher-2950.test.ts \
  tests/tool-permissions.test.ts \
  tests/general-debug-authority-m2721.test.ts \
  tests/claude-credential-change-m3419.test.ts \
  --maxWorkers=2
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
```
