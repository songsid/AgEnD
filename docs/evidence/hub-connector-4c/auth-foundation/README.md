# Connector 4c authentication foundation

This is the first M-3240 slice. The service and migration are exported but not registered or mounted. The Hub serves no new endpoint or feature as a result of this PR.

The compiling initial scaffold refused registration; the first focused test failed there. After implementation, the final suite passes **17/17 in one file** using owned SQLite, the existing Hub browser/session contexts and an inert directory. One control uses the real transactional Hub audit. It checks callback/client/resource/S256 binding, consent narrowing, single-use codes and refresh rotation, exact idle boundary, owner-only disconnect, fresh account/policy denial, policy/epoch/in-flight fences, unavailable-directory recovery and audit rollback.

Commands from this worktree:

```sh
npx vitest run tests/hub-mcp-auth-m3240.test.ts --maxWorkers=2
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
git diff --check
```

Both TypeScript programs exit 0; all 568 existing/new changelog fragments parse. `manifest.json` binds the exact source/test/design inputs. `focused.log` records the final 17-test pass after restoring the source.

Three guard removals were run separately: S256 verifier check, disconnect-owner check, and refresh-scope ceiling. Each fails one selected test by an assertion (16 unselected tests excluded from each reversal count). The exact original source hash is restored; these are runtime-transformed TypeScript reversals, not three separate full-program type checks. No duplicate broad verification campaign was run.

This packet proves the foundation only. OAuth HTTP dispatch, consent pages, remote MCP tools, real Claude Code/Codex and headless screenshots belong to the next slices. It makes no live Hub/AD/Fleet, personal configuration, Windows desktop, packaged-install or deployment claim. Rollback at this stage removes unmounted code; the design records compatible rollback once the migration is eventually registered.
