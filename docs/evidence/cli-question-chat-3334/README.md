# CLI question choices on chat fleets — #3334 / M-2861

Base: main `6ef9f3f6bdceabedf42e3feaf83c40a8218e3f1e`. These local runs used a modified working tree. `manifest.json` records the tested source/test/fixture digests, which can be compared with the PR blobs; no earlier execution is relabelled as a committed-head run.

`FleetManager.postRemoteCard` used to return for CLI-owned selection cards on every chat fleet. The same card already supplied its supported options to a web-only fleet. The fix posts through the existing remote-card path and captures a `requiresAdmin` bit from the card's legacy `webOnly` marker. Both button answers and text replies recheck the owning adapter's current fleet-admin list, before the ordinary conversation/Classic-room allowance. The legacy marker stays compatible with existing card producers. The reader, verified cursor walk and web authority gates retain their behavior.

The regression uses the recorded Claude 2.1.318 permission pane, mock Telegram/Discord adapters, real FleetManager nonce posting/callback dispatch, and the real card reader/answer algorithm over a scripted pane. It checks exact question/options, dashboard mirroring, no automatic answer, current owner-admin authority, a secondary owning adapter, Classic open-room refusal, revocation, once-only answers, exact delivery address, text refusal and a replaced live question. Ordinary question access and web-only answers remain controls.

## Results

- Old chat gate reinstated against the final tests: **15 assertion failures / 34 tests**, with 19 passing controls. All mutations compile.
- Restored related suites: **235/235 tests across 11 files**, zero skips. The additional fragment suite initially caught missing front matter in the new entries; after that metadata-only fix it passes **75/75**. The related source/tests were unchanged by the fragment correction.
- Source and test TypeScript checks pass.
- Nine independent compiling guard reversals are assertion-caught; source restored byte-for-byte afterwards.

| Reversal | Assertion failures / 34 |
|---|---:|
| Restore the web-only chat gate | 15 |
| Drop the captured admin marker | 10 |
| Drop the admin check | 10 |
| Use the primary adapter's admin instead of the owner's | 2 |
| Apply the Classic-room bypass before the admin check | 2 |
| Require admin for ordinary agent questions too | 2 |
| Remove thread binding | 2 |
| Remove group/channel binding | 2 |
| Remove message binding | 2 |

Commands (the exact file list is in `checks.json`):

```sh
npx vitest run tests/cli-question-chat-3334.test.ts tests/web-only-dialogs-2910.test.ts tests/kiro-remote-card-chat-2675.test.ts tests/kiro-remote-card-2675.test.ts tests/web-chat-c4.test.ts tests/nonce-button-shutdown.test.ts tests/admin-gate-754.test.ts tests/needs-you-derive-1386.test.ts tests/needs-you-fleet-1386.test.ts tests/needs-you-web-1386.test.ts tests/claude-file-send-card-2322.test.ts
npx vitest run tests/changelog-fragments.test.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
git diff --check
```

This evidence is mock-adapter/recorded-pane acceptance: no actual Discord/Telegram gateway, backend CLI, model, account or live fleet was used. It does not certify Windows/native behavior. No UI module or HTTP contract changed. The existing web-only control still refuses a wrong instance/unsupported action and consumes an exact answer once.

Rollback is a revert of the fix: no data format or migration changes. It restores the missing-card behavior on chat fleets.
