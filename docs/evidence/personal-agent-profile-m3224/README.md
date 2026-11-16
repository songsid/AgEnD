# Personal-agent profile and answer foundation

Synthetic Windows-path and protocol fixtures only. No Runtime, Windows process, user login, provider API, live Fleet or browser was started.

```sh
node_modules/.bin/vitest run tests/runtime-personal-profile-m3224.test.ts tests/runtime-personal-answer-m3224.test.ts --maxWorkers=2
```

Result: 2 files, 24 passing. Both TypeScript programs exit 0. Three selected reversals each produced assertion failures and were restored: successful process exit, Claude's final result field, and system-folder exclusion. [Control outcomes](controls.json).

This first layer is deliberately unmounted. The composing worker still needs fresh auth-only staging, final-prompt checking and Windows enforcement validation before it can advertise the personal-agent capability. The Hub host, pairing, question dispatch and user interface follow in separate alpha layers. See the [implementation note](../../design/hub-personal-agent-implementation.md).

Ordinary Runtime previews keep their existing command/output behavior; only the new personal-agent reader excludes it. Rollback is a code revert with no stored-data change.
