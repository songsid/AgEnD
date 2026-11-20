# Explicit Claude source selection

This is the first, server-only part of S-202. It offers no new web control; the approved UI and user-look HOLD remain in the following part.

A removed managed credential remains disconnected. Selecting subscription is a separate confirmed local+verified operation with revision CAS, stable id and atomic audit; only that operation permits the normal subscription launch path again. A later managed save restores the managed source with a newer revision. Configured/live profiles still refuse writes; this part does not introduce a restart or interrupt a running CLI.

The additive source migration preserves old tombstones as managed. Old launch references remain stale. Metadata/audit have no credential value. Tests use generated synthetic values, scratch roots and local HTTP only, with no real account, provider/model request or paid call.

Four new controls fail against the merged base: explicit source/id/revision/audit behavior; old tombstone migration; confirmed local+verified HTTP selection and CAS; and fresh launch remaining blocked after removal until explicit subscription selection. With the fix, vault, HTTP and launch files pass 33/33. Source and test TypeScript checks exit 0. The launch file also resets its filesystem fault mocks before each case so a test cannot retain another case's EACCES injection.

Commands: `node node_modules/.bin/tsc`, `node node_modules/.bin/tsc --noEmit -p tsconfig.test.json`, and `node node_modules/vitest/vitest.mjs run tests/claude-credential-vault-m3419.test.ts tests/web-claude-credentials-m3419.test.ts tests/claude-credential-launch-m3419.test.ts`.

Review correction: explicit Subscription now retains its opaque id/revision through the existing guarded launcher instead of returning the legacy sentinel. Ambient key/token/provider variables are cleared, the CLI must report first-party `claude.ai` auth, and missing or conflicting source reports refuse before the real run. The production-backend synthetic control fails on the prior null/legacy mapping because its command contains the synthetic ambient API value. Corrected subscription and untouched-legacy controls pass. No real CLI/provider/browser campaign was repeated.

Rollback: stop managed consumers before downgrading, retain the vault/key and choose an explicit supported source. The added database column is not removed by rollback; older writers using positional inserts are not compatible with it. Do not remove tombstones or rows to restore an ambient source.
