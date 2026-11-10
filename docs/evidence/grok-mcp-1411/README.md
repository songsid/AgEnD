# Grok MCP isolation (#1411)

The old project `.mcp.json` contained one identity-bearing wrapper entry per instance. Grok's additive project discovery loaded all of them. The offline baseline in `before.json` uses production `GrokBackend.writeConfig/buildCommand` and owned fake Grok/MCP child processes: the single-agent control passes; both same-cwd agents see both identities and tool sets.

The fix keeps one identity-free project shim per managed server. Launch environment selects a private instance directory and a generation binding. The wrapper checks both before exporting its private MCP settings. A private configuration fingerprint prevents a changed or unwritten config from inheriting an old binding. Missing or conflicting bindings print a clear error and expose no AgEnD tools. The manifest is published only after the project transition succeeds. The existing shared `ensureInstanceDir` helper creates or tightens the private directory to 0700. Stopping one agent removes its own generated private state, leaving the shared shim available to peers.

## Upstream source boundary (read-only; no real Grok execution)

Source checked 2026-11-10 UTC:

- [stdio MCP spawn and environment overlay](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-mcp/src/servers.rs#L4771): the child inherits the spawning process environment; configured MCP variables overlay it.
- [leader selection](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/mod.rs#L495): a shared leader can be enabled by configuration or the remote release setting. It would inherit the first caller's environment; later clients do not forward an arbitrary environment map.
- [standalone flag](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/cli.rs#L290): AgEnD launches with `--no-leader` so the agent owns its MCP children. The hidden root flag is also present in [the 2026-08-23 source](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-pager/src/app/cli.rs#L786). This is source evidence, not a claim about the first released version supporting it. An incompatible CLI rejects the flag rather than falling back to a shared leader.

## Migration and limits

Only old generated wrappers at canonical regular paths in this fleet's instance root, with matching entry key, directory/instance export and complete generated shell grammar (including properly quoted multiline values), are migrated. Foreign or ambiguous identity-bearing legacy entries refuse preparation without editing the project. Untouched user JSON members retain their original key/value source bytes; unrelated root bytes are retained. Malformed/duplicate objects, reserved-name conflicts and observed concurrent edits refuse rather than overwrite.

Known limit accepted for this fix: Grok has no supported exclusive primary MCP configuration switch. The identity-free shim therefore remains in the project; user-defined MCP servers remain subject to Grok's normal project discovery. This is identity/config isolation, not an OS security boundary between same-UID agents. Existing Grok processes keep their cached catalog until restarted. Do not run older AgEnD writers alongside the migrated project: they can reintroduce old identity-bearing entries. Rollback requires stopping these agents before downgrading; the older version can recreate its own entries but restores the original same-cwd limitation. No Grok home, credentials or session files move.

The pre-rename byte comparison rejects an observed competing edit; it is not a lock against an uncooperative writer racing after the comparison.

## Reproduce

```sh
node node_modules/vitest/vitest.mjs run tests/grok-mcp-isolation-1411.test.ts tests/owned-children-1450.test.ts tests/backend/grok.test.ts --maxWorkers=2
REPO=$PWD OUT=<owned-output-dir> SOURCE=<source-sha> node --import tsx scripts/manual/grok-mcp-isolation/accept.mts
```

The standalone acceptance can be run inside a private user/network namespace with loopback only. It creates a scratch HOME, one owned Unix socket, fake Grok and fake MCP programs, then removes the socket and scratch directory. It never starts Grok, a vendor CLI, an account or a fleet. No live credentials or pairing state are involved. The unit suite also covers env-less/conflicting/unbound launches, configured shared-leader behavior, single-agent compatibility, user bytes, legacy/CJK migration, cleanup and concurrent-edit refusal. Exact-head acceptance and mutation totals are recorded in the PR comment and `verification.json`.
