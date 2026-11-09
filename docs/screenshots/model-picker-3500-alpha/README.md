# Model picker — alpha preparation (M-2731 / #3500)

This is local preparation for the alpha twin of main #3502 (`642f758b`). It is based on alpha `da70c790`, plain-merged into the feature branch. No PR, publication or release is implied. The alpha.10 freeze remains in force until its tag.

The candidate snapshot is labelled `2.3.5-alpha.10-m2731-prep.0` through its own package metadata. These are real Chromium captures of the production Settings shell, Agent dialog, chat command cards and final confirmation. Private CJK/emoji fonts are used only by the capture process. The adjacent `model-picker-3500-main` directory remains main's earlier evidence; it is not alpha evidence.

## Scope and isolation

The shared smoke fixture owns its loopback listener, preview listener, scratch AgEnD home and browser contexts. It never starts a fleet, CLI, tmux or real Windows Runtime. Local discovery and final save/relaunch are mocked boundaries. Native screenshots use the production HTTP model routes with a synthetic paired-computer RPC. No real account, credentials, model API or live fleet is used.

Opening a picker reads a catalog. Explicit refresh invokes the discovery boundary for the selected backend/account/provider/runtime/computer, retaining the selected model and prior usable options on failure. Native refresh needs the peer's optional `model-catalog-refresh` capability plus its owner's existing account-access consent. Unsupported or offline peers never borrow the coordinator's catalog. Persistent native chat refresh is intercepted by the authorized native HTTP route; native exec chat still refuses CLI control commands.

All confirmations are cancelled: **zero Settings saves and zero Agent restarts**. Native captures change `work` → `personal` on the first computer, then choose `work` on the second; every response must match that computer and account, with zero portable discovery.

## Before / after

Before uses alpha `da70c790`'s `settings-dialogs.js`, `panel-chat.js` and `chat-store.js` with the same fixture data. Current screenshots use the prepared implementation.

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

## Local checks

- 21 focused suites: **439/439**, zero skips; the additional closed Runtime bundle suite passes **8/8** (22 files / 447 unique tests). This includes the structural continuation/CSP checks and the settings catalog's unchanged 30-second TTL/reset regression.
- Both source and test typechecks pass.
- 13/13 isolated mutations caught: selected native profile, API failure, changed credential, Codex provider proof, peer capability, late target, returned account, changed default profile, draft account, UI account/computer cache key, reply bounds, chosen computer, and admission after runtime selection. Restored route/worker controls pass 22/22.
- Fail-first continuation probe: hold runtime selection, revoke admission, release selection returning portable; the prior code starts a portable probe. The fix rechecks admission before that dispatch. Native chat's real HTTP control confirms no portable command or discovery is called.
- Deliberately update the old registry test's exact capability list for the new optional shared capability; protocol remains v1 and no per-CLI flag is invented.
- Changelog assembly: **302 fragments OK**; diff check passes.
- Production Settings style gate: **24/24** on Agent defaults and Agents, desktop EN / phone zh-TW plus the middle-width check.
- Chromium: **42 current + 12 before + 21 cached-shell common checkpoints**, and **12 current + 6 cached-shell native checkpoints**. No page/CSP errors or page overflow; phone controls and latest-pill geometry are asserted.

Cached-shell common runs retain `v2.3.5-alpha.9`'s `app.css` and `settings-catalog.js`; the native runs retain both as well. The feature loads its own stylesheet and uses the old catalog's optional-export fallback.

Reproduce with `scripts/manual/smoke/smoke-3500-model-picker.mts` and `smoke-3500-model-context.mts`, using the shared fixture's `REPO`, `PW_DIR`, `CHROME`, `OUT`, `MATRIX`, `PORT`, `BASELINE` and `SKEW` variables. All ports must be free before boot. The scripts close only their own listeners and browser contexts.

Focused commands (the full suite remains CI’s):

```sh
npx vitest run tests/backend-command-1806.test.ts tests/backend-probe-worker.test.ts tests/codex-refresh-model-catalog.test.ts tests/profile-model-catalogs-2072.test.ts tests/runtime-build-info.test.ts tests/runtime-client-remote.test.ts tests/runtime-coordinator.test.ts tests/runtime-remote-accounts.test.ts tests/settings-model-dropdowns-2072.test.ts tests/web-chat-commands-1269.test.ts tests/web-commands-1269.test.ts tests/web-model-picker-m2731.test.ts tests/web-model-refresh-m2731.test.ts tests/web-model-refresh-route-m2731.test.ts tests/native-model-refresh-api-m2731.test.ts tests/native-model-refresh-m2731.test.ts tests/web-continuation-coverage.test.ts tests/web-app-fences-1408.test.ts tests/web-csp-1300.test.ts tests/i18n-ui-literals-2390.test.ts tests/web-left-bar-2330.test.ts --maxWorkers=2
npx vitest run tests/cli-registry-runtime-bundle.test.ts --maxWorkers=1
npm run typecheck
npm run typecheck:tests
node scripts/changelog-assemble.mjs --check
```

## Limits and rollback

This is production-page and mock-boundary evidence, not native Windows/vendor integration evidence. The alpha twin still needs its post-freeze PR, acceptance on the opened head, parity review and CI. It changes no stored Settings or schema during refresh. Reverting the twin restores the previous model picker; older peers simply lack the optional refresh operation.
