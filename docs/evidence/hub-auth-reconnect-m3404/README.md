# Reconnect authorization completion (M-3404)

Base: `d2b96d13a` (dev). Local, disposable TLS/WSS fixtures only; no accounts or live Fleet.

## Cause

`tests/helpers/hub-rig.ts:86` increments `state.syncs` **before** awaiting the reconciliation exchange and optional gate. The old `tests/hub-network.test.ts:81` treated `syncs === 2` as reconnect completion and immediately called `authorize()`.

`src/hub/client.ts:232-235` sets readiness only after the reconciliation callback resolves. Until then, `authorize()` correctly refuses at `src/hub/client.ts:329`. The failure is a test synchronization race, not a replay or transport authorization defect.

## Forced failure on the base

On the base, apply `forced-base-repro.patch` with `git apply --unidiff-zero`, then run:

```sh
npx vitest run tests/hub-network.test.ts -t 'does not resend an authorization'
```

The patch holds the second reconciliation after its exchange and signals entry. It replaces the polling wait with that entry signal but preserves the old immediate authorization call. Result: **1 failed**, `Hub authorization unavailable`, at `HubMemberClient.authorize` (`client.ts:329`). No delay, retry, or timeout change is involved. Cleanup releases both gates.

## Fix and invariant

The test still holds the second reconciliation and proves authorization is unavailable while `syncs` already equals 2. The Hub sends a harmless control-frame marker after its own readiness callback. The client queues that marker until its reconciliation completes; observing the marker in the client receiver is the completion signal. Only then does the test issue a fresh operation.

The first request's arrival also has an explicit signal. The lost operation remains rejected, the old link is retired, and the Hub receives exactly two authorization requests: the lost original and one fresh operation. The deliberately refused pre-ready request never reaches the Hub.

## Validation

- Forced base repro: fails with the reported error.
- Fixed file: 14/14 pass.
- Twenty consecutive full-file runs: **20/20 green, 14 tests each (280 passes)**. Each invocation ran `node node_modules/vitest/vitest.mjs run tests/hub-network.test.ts`; the loop stops on its first failure.
- `npx tsc --noEmit -p tsconfig.test.json`: exit 0.

Risk and rollback: test and evidence only; no runtime or timeout changes. Revert this commit to restore the former test.
