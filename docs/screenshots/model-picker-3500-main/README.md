# Web model picker — main acceptance (#3500 / M-2731)

These are production UI screenshots from an isolated candidate snapshot, packaged locally as `2.3.5-beta.2-m2731.0`. The version comes from the candidate package metadata; the page text is not replaced. Private Noto Sans TC / Noto Color Emoji fonts render the Chinese and emoji. No font is installed globally or included here.

The shared smoke fixture runs the real FleetManager web listener with a scratch AgEnD home. Backend catalogs/availability are synthetic; the bounded CLI-worker boundary and final save/relaunch boundary are mocked. The browser uses the actual Settings fields, chat Send button, command cards and confirmation dialog. It cancels confirmation: refresh/navigation cause **zero saves and zero restarts**. No live Fleet, real model account, CLI, Windows host or tmux is used.

Before captures retain main `3b2ccfeb`'s three UI modules (`settings-dialogs.js`, `panel-chat.js`, `chat-store.js`). Current captures use this change. Cached-shell captures retain `v2.3.5-beta.2`'s `app.css` plus main's older `settings-catalog.js`; the feature's own stylesheet and words load with its lazy module. All original shared-shell imports remain unchanged.

## Before and after

Each cell links to Settings defaults / the Agent dialog / chat model choice, respectively.

| Case | Before | After |
|---|---|---|
| Desktop 1366, light, EN | [Settings](before-desk-light-en-settings.png) · [dialog](before-desk-light-en-agent-dialog.png) · [chat](before-desk-light-en-chat-model.png) | [Settings](after-desk-light-en-settings.png) · [dialog](after-desk-light-en-agent-dialog.png) · [chat](after-desk-light-en-chat-model.png) |
| Desktop 1366, dark, zh-TW | [Settings](before-desk-dark-zh-TW-settings.png) · [dialog](before-desk-dark-zh-TW-agent-dialog.png) · [chat](before-desk-dark-zh-TW-chat-model.png) | [Settings](after-desk-dark-zh-TW-settings.png) · [dialog](after-desk-dark-zh-TW-agent-dialog.png) · [chat](after-desk-dark-zh-TW-chat-model.png) |
| Phone 390, light, EN | [Settings](before-phone-light-en-settings.png) · [dialog](before-phone-light-en-agent-dialog.png) · [chat](before-phone-light-en-chat-model.png) | [Settings](after-phone-light-en-settings.png) · [dialog](after-phone-light-en-agent-dialog.png) · [chat](after-phone-light-en-chat-model.png) |
| Phone 390, dark, zh-TW | [Settings](before-phone-dark-zh-TW-settings.png) · [dialog](before-phone-dark-zh-TW-agent-dialog.png) · [chat](before-phone-dark-zh-TW-chat-model.png) | [Settings](after-phone-dark-zh-TW-settings.png) · [dialog](after-phone-dark-zh-TW-agent-dialog.png) · [chat](after-phone-dark-zh-TW-chat-model.png) |

## Complete flow and failure states

| State | Desktop EN | Phone zh-TW |
|---|---|---|
| Choose backend | [PNG](after-desk-light-en-backend.png) | [PNG](after-phone-dark-zh-TW-backend.png) |
| Model on that backend | [PNG](after-desk-light-en-backend-model.png) | [PNG](after-phone-dark-zh-TW-backend-model.png) |
| Reasoning effort | [PNG](after-desk-light-en-backend-effort.png) | [PNG](after-phone-dark-zh-TW-backend-effort.png) |
| Final confirmation, fresh conversation warning | [PNG](after-desk-light-en-backend-confirm.png) | [PNG](after-phone-dark-zh-TW-backend-confirm.png) |
| More models | [PNG](after-desk-light-en-chat-more.png) | [PNG](after-phone-dark-zh-TW-chat-more.png) |
| Refresh pending, selection retained | [PNG](after-desk-light-en-refresh-busy.png) | [PNG](after-phone-dark-zh-TW-refresh-busy.png) |
| Refresh failed, Retry | [PNG](after-desk-light-en-refresh-error.png) | [PNG](after-phone-dark-zh-TW-refresh-error.png) |
| Cached CSS/catalog: Settings | [PNG](skew-desk-light-en-settings.png) | [PNG](skew-phone-dark-zh-TW-settings.png) |
| Cached CSS/catalog: chat | [PNG](skew-desk-light-en-chat-model.png) | [PNG](skew-phone-dark-zh-TW-chat-model.png) |
| Cached CSS/catalog: confirmation | [PNG](skew-desk-light-en-backend-confirm.png) | [PNG](skew-phone-dark-zh-TW-backend-confirm.png) |

The latest-message button clears the thread and composer: [phone EN](after-phone-light-en-phone-latest.png), [phone zh-TW](after-phone-dark-zh-TW-phone-latest.png).

## Validation scope

- 17 focused suites: 235 tests, zero skips.
- Both source and test typechecks; changelog assembly check.
- 14/14 assertion mutations caught: vendor refresh, post-await binding, Claude account-tier failure, replaced-target generation, physical account lane, hard expiry, Codex fallback and provider proof, typed action wire, retained chat choices, stale UI response, authorization after await, explicit discovery marking and ordinary-probe fallback.
- Real Chromium: eight locale/theme/device cases, 84 current PNG checkpoints and 84 cached-shell checkpoints; chosen-backend refresh goes to Codex while the Agent still runs Claude. Four before cases, 12 checkpoints. No page errors, CSP errors or page overflow. Phone controls meet 44px targets; latest-button geometry is checked.
- Settings style gate: 94 checks pass (CI matrix and middle width).

The shared implementation uses `ModelSelect`, `Icon`, secondary `.btn`, `ErrorState`, the command card and `confirmDialog`, plus token-based styles in a feature-owned stylesheet. There is no new animation. Existing copy cleanup belongs to M-2733 and is unchanged.

Codex's own short catalog TTL still applies. A custom provider/profile that cannot be proved reports unavailable and retains the previous bound list; it never borrows another account. Main has no native Windows control surface; the alpha twin supplies runtime/computer handling separately.

Reproduce with `scripts/manual/smoke/smoke-3500-model-picker.mts`, the shared fixture's `REPO`/`PW_DIR`/`CHROME`/`OUT` variables, and `MATRIX=full`. Set `SKEW` to a directory containing the old `app.css` and `settings-catalog.js`. For before images, set `BEFORE=1 BASELINE=<directory with the three old UI modules>`. The fixture refuses occupied ports, and closes only its own browsers/listeners and scratch home.

R4 retains the pre-existing 30-second passive catalog cache and its `forgetCatalogs()` reset. The new fields reuse that cache rather than keeping an independent snapshot; a successful explicit refresh updates it. A tab holding the older catalog module uses a namespace import and an in-flight-only fallback. Layout and the screenshots above are unchanged.
