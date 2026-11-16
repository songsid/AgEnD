# M-3221 — local owner-app connector acceptance

Tested product source: `25996d78e4bd7b20a1b2f776761f990209fdca10`. Plain alpha sync `bff998a0a62d1c276f1ae4c6f168ebf7d51e9eed` contains incoming `4ca66795`; applying the original own patch to that base yields the exact merged tree. The incoming FleetManager change is only the approved tool-trace title translation. No unchanged-source sync rerun was performed (decision 5afe2996).

**Review repair:** [origin-r2](origin-r2/summary.json) binds `6418735c5` and the distinct unverified `@app` origin. The earlier real-client inputs with `source:web` are historical, not a claim about the repaired delivery. One selected warning control is red before the fix; the scoped six-file run is 89/91, then only the affected 25-case instructions suite is rerun after correcting its compact byte budget. All 91 distinct controls pass across those stages, with source/test TypeScript 0/0. No browser, real model, live Fleet or Windows program is run again. The [changelog-only correction](changelog-r1.json) fixes the first head's two fragment headers.

**CI repair and current base:** [sync-r3](sync-r3.json) records the plain alpha87ca sync, which includes the official lightbox fix263ae3fb and leaves all67 own paths unchanged. [ci-r4](ci-r4/summary.json) binds `0ea17624a`: it refreshes the reviewed instruction hashes, extends the FleetManager CLI test stub and routes product names through the locale layer. All1,728 cases restore the previous hashes when only the reviewed app-warning section is removed; all12 setup-prompt variants remain byte-identical. The four affected suites pass40/40. No connector authority/dispatch change or visual/model rerun is involved; exact-head CI remains required.

## Results

- **Fail first:** the previous per-agent MCP server fails the new exact four-operation catalog assertion (one selected assertion red, four unselected). Its full/admin surface is not the person's connector.
- **New boundary/Settings suites:** 13 tests in three files pass. Real SDK stdio, owned Unix sockets, a scratch FleetManager and SQLite cover no-Fleet static listing, a pending call, unknown/caller/admin fields, private-path refusal, ordinary agent mapping, answer/task reads, stale agent replacement and frozen/unknown retry IDs.
- **Existing controls:** 21 CSS/child-stdio tests pass; 27 distinct MCP startup/dashboard/Hub-hook tests pass. The grouped Hub-hook run had one timing failure before its first asynchronous apply; its unchanged isolated file passes 11/11. Both logs are kept; the earlier grouped 39/40 is not represented as fully green.
- **Types:** source emit (`npx tsc --pretty false`) and the test TypeScript program (`npx tsc --noEmit -p tsconfig.test.json --pretty false`) exit 0.
- **Headless WSL UI:** four bounded cases exercise all three prompt formats, clipboard output, no secret token, layout and tap targets. The shared Settings gate `GATE=ci` passes 114 checks. Eight preferred original PNGs are visually clear. Two phone prompt captures were retaken only to extend capture height at the original 390px width; normal 390×844 layout and end-of-textarea scrolling were checked first. The original incomplete captures remain private and are not the preferred gallery. No Windows program or visible window was launched.
- **Real clients, own accounts:** Claude Code completes all four tools in 8.528s; Codex in 18.711s. Both receive `LARCH-42`, Tuesday at 10:00 and the seeded task title through compiled `agend connect` → private owner port → actual FleetManager chat handoff/reply history + SQLite. The IPC endpoint is an inert fixture agent: this proves real client/MCP/Fleet integration, not a live agent turn or live Fleet. Only authentication was copied to isolated homes; original auth size/mtime remained unchanged. Copies and owned fixture processes were removed in `finally`.

Codex's first real call connected but its `never` approval policy refused MCP tools. The Codex-only retry explicitly authorizes this owned four-tool fixture server with `default_tools_approval_mode="approve"`, as described by the [official MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). It does not bypass global sandboxing or approvals, change the person's profile, or add that authorization to the product's copied prompt. Claude's successful call was not repeated.

The first fixture preflight lacked copied UI assets and stopped before a model call. Local `npm run postbuild` also reports an absent shared `@xterm/headless` dependency. Source emit and the normal UI/plugin/knowledge copy steps supplied this compiled CLI trial; no complete npm package, bundled pane assets or publish result is claimed.

## Commands and bindings

```sh
M3221_ENTRY=src/channel/mcp-server.ts npx vitest run tests/owner-app-connect-m3221.test.ts -t 'fixed person surface' --maxWorkers=2
npx vitest run tests/owner-app-connect-m3221.test.ts tests/owner-app-fleet-m3221.test.ts tests/owner-app-install-m3221.test.ts --maxWorkers=2
npx vitest run tests/ui-css-literals-ratchet.test.ts tests/child-stdio-errors-2374.test.ts --maxWorkers=2
npx vitest run tests/mcp-tool-list-startup-m3183.test.ts tests/dashboard-permissions.test.ts tests/hub-fleet-hooks.test.ts --maxWorkers=2
npx tsc --pretty false
npx tsc --noEmit -p tsconfig.test.json --pretty false
# Owned headless fixture, with REPO/PW_DIR/CHROME/OUT set:
npx tsx scripts/manual/smoke/smoke-connector-m3221.mts
GATE=ci npx tsx scripts/manual/smoke/smoke-settings-ui-gate.mts
```

[Summary](summary.json) contains selected real-client tool/final-answer facts, cleanup and scope limits. [Manifest](manifest.json) binds 24 current own inputs and the public artifacts; raw model events/account/session metadata and disposable auth are excluded. Source/test log stages remain separate from the final exact-head CI required for review.

## Risk and rollback

Same-UID local apps share the operator trust boundary. The app has four operations and no administrative dispatch or verified-human authority. Sends are bounded and never replayed automatically; unknown operation IDs after restart refuse. Replies are the agent's chat stream, not falsely attributed exact turn results. A missing Fleet fails at call time while tools remain static.

Rollback is removing this command/card/listener. No Fleet schema, existing agent roles, personal CLI configuration or history needs migration or deletion. Coordinator alone merges after exact-head review and CI.
