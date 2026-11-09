# Model picker — alpha twin (M-2731 / #3500)

This is the alpha twin of merged main #3502 (`642f758b`). After the alpha.10 tag/unfreeze, alpha `a32b177d` was plain-merged into the prepared branch at `5b7127985`. The initial acceptance matched all 668 added/removed prepared production lines. R1 below repairs the reviewed cache-ordering and native-home issues and restores the alpha catalog status UI. No release or deployment is implied.

The candidate snapshot is labelled `2.3.5-alpha.10-m2731-sync.1` through its own package metadata. These are real Chromium captures of the production Settings shell, Agent dialog, chat command cards and final confirmation. Private CJK/emoji fonts are used only by the capture process. The adjacent `model-picker-3500-main` directory remains main's earlier evidence; it is not alpha evidence.

## Scope and isolation

The shared smoke fixture owns its loopback listener, preview listener, scratch AgEnD home and browser contexts. It never starts a fleet, CLI, tmux or real Windows Runtime. Local discovery and final save/relaunch are mocked boundaries. Native screenshots use the production HTTP model routes with a synthetic paired-computer RPC. No real account, credentials, model API or live fleet is used.

Opening a picker reads a catalog. Explicit refresh invokes the discovery boundary for the selected backend/account/provider/runtime/computer, retaining the selected model and prior usable options on failure. Native refresh needs the peer's optional `model-catalog-refresh` capability plus its owner's existing account-access consent. Unsupported or offline peers never borrow the coordinator's catalog. Persistent native chat refresh is intercepted by the authorized native HTTP route; native exec chat still refuses CLI control commands.

All confirmations are cancelled: **zero Settings saves and zero Agent restarts**. Native captures change `work` → `personal` on the first computer, then choose `work` on the second; every response must match that computer and account, with zero portable discovery.

## Before / after

Before uses alpha `a32b177d`'s `settings-dialogs.js`, `panel-chat.js` and `chat-store.js` with the same fixture data. Current screenshots use the aligned R2 implementation; unchanged before screenshots remain the alpha baseline.

| Case | Before Settings | After Settings | After Agent dialog | After chat |
|---|---|---|---|---|
| Desktop 1366, light, EN | [PNG](before-desk-light-en-settings.png) | [PNG](after-desk-light-en-settings.png) | [PNG](after-desk-light-en-agent-dialog.png) | [PNG](after-desk-light-en-chat-model.png) |
| Desktop 1366, dark, zh-TW | [PNG](before-desk-dark-zh-TW-settings.png) | [PNG](after-desk-dark-zh-TW-settings.png) | [PNG](after-desk-dark-zh-TW-agent-dialog.png) | [PNG](after-desk-dark-zh-TW-chat-model.png) |
| Phone 390, light, EN | [PNG](before-phone-light-en-settings.png) | [PNG](after-phone-light-en-settings.png) | [PNG](after-phone-light-en-agent-dialog.png) | [PNG](after-phone-light-en-chat-model.png) |
| Phone 390, dark, zh-TW | [PNG](before-phone-dark-zh-TW-settings.png) | [PNG](after-phone-dark-zh-TW-settings.png) | [PNG](after-phone-dark-zh-TW-agent-dialog.png) | [PNG](after-phone-dark-zh-TW-chat-model.png) |

The matching before dialog/chat PNGs are included for each case.

| Flow / state | Desktop EN | Phone zh-TW |
|---|---|---|
| Backend | [PNG](after-desk-light-en-backend.png) | [PNG](after-phone-dark-zh-TW-backend.png) |
| Model on chosen backend | [PNG](after-desk-light-en-backend-model.png) | [PNG](after-phone-dark-zh-TW-backend-model.png) |
| Reasoning effort | [PNG](after-desk-light-en-backend-effort.png) | [PNG](after-phone-dark-zh-TW-backend-effort.png) |
| Confirmation and fresh-conversation warning | [PNG](after-desk-light-en-backend-confirm.png) | [PNG](after-phone-dark-zh-TW-backend-confirm.png) |
| More models | [PNG](after-desk-light-en-chat-more.png) | [PNG](after-phone-dark-zh-TW-chat-more.png) |
| Refresh pending | [PNG](after-desk-light-en-refresh-busy.png) | [PNG](after-phone-dark-zh-TW-refresh-busy.png) |
| Refresh failed / Retry | [PNG](after-desk-light-en-refresh-error.png) | [PNG](after-phone-dark-zh-TW-refresh-error.png) |
| Native first computer, work | [PNG](native-desk-light-en-work.png) | [PNG](native-phone-dark-zh-TW-work.png) |
| Native first computer, personal | [PNG](native-desk-light-en-personal.png) | [PNG](native-phone-dark-zh-TW-personal.png) |
| Native second computer, work | [PNG](native-desk-light-en-second-computer.png) | [PNG](native-phone-dark-zh-TW-second-computer.png) |
| Cached CSS/catalog: Settings | [PNG](skew-desk-light-en-settings.png) | [PNG](skew-phone-dark-zh-TW-settings.png) |
| Cached CSS/catalog: chat | [PNG](skew-desk-light-en-chat-model.png) | [PNG](skew-phone-dark-zh-TW-chat-model.png) |
| Cached CSS/catalog: native second computer | [PNG](native-skew-desk-light-en-second-computer.png) | [PNG](native-skew-phone-dark-zh-TW-second-computer.png) |

The phone's latest-message button sits outside the scroller and above the composer: [EN](after-phone-light-en-phone-latest.png), [zh-TW](after-phone-dark-zh-TW-phone-latest.png).

## R2: aligned alpha (current)

The branch plain-merges alpha `ffd4eba028da77ca4709f6e01fdf6b34b080b83d` at `0b10957e8fceb81a1c8f0eada629ea749483bf58`. Git resolved six overlapping files automatically; the sole conflict was the asset map, where both `model-picker.css` and `subagent-row.css` are kept. Every added/removed line of all **27 product source files** matches source-cleared R1 exactly against the respective alpha base. The new subagent hook/route/reader and S-117 glossary changes remain intact.

The missing PR-event runs at R1 were caused by merge conflicts. The same-SHA close/reopen did not repair that; no current GitHub incident is claimed. The superseded R1 manual CI was cancelled. This aligned head needs its own PR-event CI, required scan and exact-head review.

- Both typechecks pass. The combined 41-file run passed **816/817**, with one S-117 test timing out at its existing 20-second limit during concurrent local validation. Its isolated file passes **14/14** in seven seconds, with no test or timeout edits. The closed Runtime bundle passes **5/5**. The six added subagent suites and every earlier CI-consumer regression pass in the combined run. Full-suite acceptance remains CI's.
- Nine guard reversals are caught again on the aligned source; restored affected suites pass **36/36**. Changelog assembly: **304 fragments OK**. Fresh Settings style gate: **24/24**.
- All **81 current/SKEW PNGs** are recaptured from the aligned source and inspected, including selected originals. The 12 before PNGs carry unchanged. No errors, overflow, saves/restarts or native-to-portable discovery. Native account/model geometry and source provenance are asserted. The captured subagent source is empty; no populated subagent-row browser claim is made.
- The private snapshot label is `2.3.5-alpha.10-m2731-sync.1`; all product source includes the final cache retirement and the alpha sync. All 93 hashes are in `SHA256SUMS`.

## R1 review scope (earlier checks)

- Restored the existing loading/error/source states and WSL catalog key, keeping Windows/account/computer bindings. Initial failures and explicit refresh use the shared error/Retry component; Retry now performs POST rediscovery, rather than the old cached GET refresh.
- A slow GET can neither overwrite nor evict a newer refresh; reopening before or after that GET settles keeps the refreshed list. The shared passive TTL remains 30 seconds. The main-line cache correction is carried separately at `4856ee1f1`; its three ordering regressions fail first on main.
- Windows `Claude_Config_Dir` / `Codex_Home` spellings select the same home as their uppercase forms. Codex config checks, child environment and cache reads stay together; conflicting aliases refuse. The inert fixtures use owned synthetic files and mocked vendor/child boundaries.
- Fail-first: all 17 CI failures reproduced locally, plus both late-GET outcomes, reopening while GET remains held, and mixed-case Claude/Codex controls. R1 has **717 unique checks across 35 files**, including the closed Runtime bundle's five checks; both typechecks pass. Nine isolated reversals fail the intended cache, source/loading, home or child-environment assertion; restored controls pass.
- R1 refreshes **81 PNGs** (42 current common, 21 cached-shell common, 12 current native, six cached-shell native). All 12 baseline PNGs carry unchanged. Source notes fit in EN/zh-TW; native phone model and account remain within the dialog body. No page/CSP errors, overflow, saves, restarts or portable-native fallback. The current common/native leg was captured before the final nonvisual passive-flight retirement line; both cached-shell legs include it.
- Fresh Settings style gate: **24/24**. Snapshot version remains the disclosed private alpha.10 label. All 93 PNG hashes are recorded in `SHA256SUMS`; no artifacts substitute for images.

## Initial acceptance checks (superseded counts retained for scope)

- Fresh post-sync focused checks: **453/453**, zero skips, across 23 unique files (22 combined suites / 444 tests, including the five-test closed Runtime bundle suite, plus nine prototype-built FleetManager regression tests). This includes the structural continuation/CSP checks and the settings catalog's unchanged 30-second TTL/reset regression.
- Both source and test typechecks pass.
- Fresh post-sync 13/13 isolated mutations caught: selected native profile, API failure, changed credential, Codex provider proof, peer capability, late target, returned account, changed default profile, draft account, UI account/computer cache key, reply bounds, chosen computer, and admission after runtime selection. Restored route/worker/prototype controls pass 31/31.
- Fail-first continuation probe: hold runtime selection, revoke admission, release selection returning portable; the prior code starts a portable probe. The fix rechecks admission before that dispatch. Native chat's real HTTP control confirms no portable command or discovery is called.
- Deliberately update the old registry test's exact capability list for the new optional shared capability; protocol remains v1 and no per-CLI flag is invented.
- Changelog assembly: **303 fragments OK**; diff check passes.
- Production Settings style gate: **24/24** on Agent defaults and Agents, desktop EN / phone zh-TW plus the middle-width check.
- Chromium: **42 current + 12 before + 21 cached-shell common checkpoints**, and **12 current + 6 cached-shell native checkpoints**. No page/CSP errors or page overflow; phone controls and latest-pill geometry are asserted.

Cached-shell common runs retain `v2.3.5-alpha.10`'s `app.css` and `settings-catalog.js`; the native runs retain both as well. The feature loads its own stylesheet and uses the old catalog's optional-export fallback.

Reproduce with `scripts/manual/smoke/smoke-3500-model-picker.mts` and `smoke-3500-model-context.mts`, using the shared fixture's `REPO`, `PW_DIR`, `CHROME`, `OUT`, `MATRIX`, `PORT`, `BASELINE` and `SKEW` variables. All ports must be free before boot. The scripts close only their own listeners and browser contexts.

Focused commands (the full suite remains CI’s):

```sh
npx vitest run tests/backend-command-1806.test.ts tests/backend-probe-worker.test.ts tests/codex-refresh-model-catalog.test.ts tests/profile-model-catalogs-2072.test.ts tests/runtime-build-info.test.ts tests/runtime-client-remote.test.ts tests/runtime-coordinator.test.ts tests/runtime-remote-accounts.test.ts tests/settings-model-dropdowns-2072.test.ts tests/web-chat-commands-1269.test.ts tests/web-commands-1269.test.ts tests/web-model-picker-m2731.test.ts tests/web-model-refresh-m2731.test.ts tests/web-model-refresh-route-m2731.test.ts tests/native-model-refresh-api-m2731.test.ts tests/native-model-refresh-m2731.test.ts tests/web-continuation-coverage.test.ts tests/web-app-fences-1408.test.ts tests/web-csp-1300.test.ts tests/i18n-ui-literals-2390.test.ts tests/web-left-bar-2330.test.ts tests/fleet-model-proto-1490.test.ts --maxWorkers=2
npx vitest run tests/cli-registry-runtime-bundle.test.ts --maxWorkers=1
npm run typecheck
npm run typecheck:tests
node scripts/changelog-assemble.mjs --check
```

## Limits and rollback

This is production-page and mock-boundary evidence, not native Windows/vendor integration evidence. The alpha twin still needs acceptance on its opened head, current-route review and settled CI before coordinator merge. It changes no stored Settings or schema during refresh. Reverting the twin restores the previous model picker; older peers simply lack the optional refresh operation.
