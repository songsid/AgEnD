# Web model refresh and chat choice parity — proposal

繁中摘要：設定頁的模型欄位加入「重新整理模型」，實際重新取得清單，保留已選模型；失敗時保留原清單並就地重試。聊天沿用現有 `/model`、`/backend` 選單，補齊 Discord／Telegram 的重新整理與 Claude「更多模型」。桌面保留標頭入口，手機把入口放在輸入框內的上緣。這是設計提案，尚未修改產品程式；等待使用者看圖確認。

Survey baselines: main `3b2ccfeb0d5b707e9d238c6b1a7fd4b88c0f3b8d`; alpha `7063b614c2439743b04d5d4ff28d225d7c8d07a9`.

## Current surfaces

| Surface | Existing control | Source on main |
|---|---|---|
| Settings → Agent defaults | Default model | `panel-settings.js:1097` |
| Settings → Agents → Settings | Agent model and advanced fallback model | `settings-dialogs.js:305,358` |
| Settings → Chat & connections → ClassicBot room | Room model | `settings-dialogs.js:709` |
| Fleet/sidebar → New Agent | Initial model | `panel-fleet.js:526` |
| Web chat | Model chip; `/model` and `/backend` in Commands; choices above the composer | `panel-chat.js:337,562`, `chat-commands.js:11` |

The five Settings/create fields share `ModelSelect` (`settings-dialogs.js:69`). Alpha adds the same component to native Agent creation/editing, Move, General location, and Windows CLI diagnostics. Diagnostics can supply an inventory directly through `catalogOverride`.

Discord and Telegram offer `/model` plus a picker with Refresh first, current model marked, and Claude’s “More models…” last. `/backend` selects backend → model → effort, when supported → the existing switch confirmation. It applies nothing between choices. Same-backend model changes use the backend’s existing apply/restart/resume behavior; changing backend opens a fresh session and warns before applying. ClassicBot does not support `/backend`.

Web already runs that complete `/backend` sequence through the same handler. Choice IDs carry the accumulated arguments, so its current `run(o.id)` is correct. The missing parity is in discovery and the `/model` menu, not a missing backend state machine.

## Discovery today and the gaps

1. Main’s Settings browser cache lasts 30 seconds. `GET /ui/models` reads the server snapshot; it does not rediscover. There is no refresh button, and an unavailable response becomes an empty catalog.
2. Alpha already has a refresh/loading/error control. Its `refresh=1` bypasses the browser cache, but the server still reads cached model data or native inventory. A fresh HTTP read is not rediscovery.
3. Web `/model` only reads the cached primary list. It lacks Refresh and Claude’s API-catalog “More models…”. Web backend-choice model lists are also cached only.
4. The shared CLI cache refreshes on startup and selected maintenance/sign-in paths; ordinary chat model menus re-probe after one hour. Disk entries expire after 24 hours. Discord/Telegram’s Refresh menu action explicitly asks for bounded rediscovery, including vendor-catalog refresh where supported.
5. Refresh is backend-specific. Codex’s own command may reuse its short-lived vendor cache; Claude aliases are fixed and its full catalog comes from the account API; Muse rereads its on-disk provider catalog. The UI must not promise an unconditional vendor refetch.
6. Preserve the exact context: backend, saved Agent/account/provider, runtime and selected computer. The current generic picker cache is profile-aware only for Claude; the instance-aware `list_models` worker has a separate provider-aware path. Do not label a global catalog as authoritative for a custom provider. Unsupported account-specific discovery must be stated rather than silently borrowing another account’s list.

Source seams: `settings-catalog.js:5,49`; `web-api.ts:1674`; `fleet-manager.ts:16489,16522,20113,20411,20440,20512,20946,21445`; `backend-command.ts:94`.

## Proposed behavior

- **Settings:** the shared model field keeps its full-width select and gets one bordered secondary “重新整理模型” button, with the shared refresh icon, below it. It refreshes the list, without changing the selected value or creating a Settings draft. The existing “Other…” input remains. During refresh, retain the options and selection, disable the refresh action and show inline progress. Failure uses the shared error/retry component and keeps the last usable list.
- **Chat:** keep `/model`, `/backend` and the existing command card. Add a direct backend entry beside the desktop model chip. Use matching “Claude Code ▾” / “Sonnet ▾” labels. On a phone, where header chips are currently hidden, put two touch-sized entries inside the composer’s rounded input area. `/model` offers the same current-model marking, refresh and Claude More action as Discord/Telegram. Refresh is an icon action beside the command-card title; “更多模型…” is a separate ghost action below the model choices, never another model chip. The backend flow gets the same model-refresh action at its model step; it keeps the existing effort step and confirmation. No additional confirmation for refreshing or choosing a same-backend model.
- **Actions are not model names:** Refresh/More must be separate typed actions, never sentinel IDs sent through `applyModel`. An old command card must continue receiving only valid model IDs in its ordinary options.
- **Scope:** an explicit authenticated refresh reuses the bounded worker/single-flight machinery and rechecks the requested target after the await. Opening a picker remains a cheap snapshot read. Changing Agent, backend, account or computer retires an older response.
- **Alpha/native:** preserve its existing stateful picker and native authorization. Native rediscovery uses the already authorized detection path for that selected computer, not coordinator-side CLI probing or a WSL fallback. A surface that cannot authorize detection explains that in place; it does not present a cache reread as fresh discovery.

The model-switch execution path is retained. Claude can switch at runtime when supported; other same-backend changes restart and resume through the CLI’s normal behavior. A backend change keeps its existing explicit fresh-session warning and confirmation.

## PNG proposal

These are real-shell browser captures, not standalone page mockups. The existing app, sidebar, Settings subnavigation, dialog, command card and composer are rendered by the published `@songsid/agend@2.3.5-beta.2` package. Its tarball SHA-1 is `d1710c0dda72d835a8b11c56d21fcfb6bda2343f`; the capture asserts the real `v2.3.5-beta.2` version pill. Only the proposed controls/status and synthetic command answers are composed for design review. They prove appearance, not feature implementation or model discovery.

| View | Desktop 1366 × 900, light | Phone 390 × 844, dark |
|---|---|---|
| Current Settings | [PNG](../screenshots/model-picker-m2731/00-current-settings-desk-light-zh-TW.png) | [PNG](../screenshots/model-picker-m2731/00-current-settings-phone-dark-zh-TW.png) |
| Defaults picker | [PNG](../screenshots/model-picker-m2731/01-proposal-defaults-desk-light-zh-TW.png) | [PNG](../screenshots/model-picker-m2731/01-proposal-defaults-phone-dark-zh-TW.png) |
| Agent edit dialog | [PNG](../screenshots/model-picker-m2731/02-proposal-agent-dialog-desk-light-zh-TW.png) | [PNG](../screenshots/model-picker-m2731/02-proposal-agent-dialog-phone-dark-zh-TW.png) |
| Chat backend choice | [PNG](../screenshots/model-picker-m2731/03-proposal-chat-backend-desk-light-zh-TW.png) | [PNG](../screenshots/model-picker-m2731/03-proposal-chat-backend-phone-dark-zh-TW.png) |
| Backend’s model step | [PNG](../screenshots/model-picker-m2731/04-proposal-backend-model-desk-light-zh-TW.png) | [PNG](../screenshots/model-picker-m2731/04-proposal-backend-model-phone-dark-zh-TW.png) |
| Chat model/Refresh/More | [PNG](../screenshots/model-picker-m2731/05-proposal-chat-model-desk-light-zh-TW.png) | [PNG](../screenshots/model-picker-m2731/05-proposal-chat-model-phone-dark-zh-TW.png) |
| Refresh in progress | [PNG](../screenshots/model-picker-m2731/06-proposal-refresh-busy-desk-light-zh-TW.png) | [PNG](../screenshots/model-picker-m2731/06-proposal-refresh-busy-phone-dark-zh-TW.png) |
| Refresh failed, retry | [PNG](../screenshots/model-picker-m2731/07-proposal-refresh-error-desk-light-zh-TW.png) | [PNG](../screenshots/model-picker-m2731/07-proposal-refresh-error-phone-dark-zh-TW.png) |

Both cases use the zh-TW UI locale. The 16 captures have no horizontal page overflow; both contexts report no page errors. New refresh controls and phone entry controls are at least 44px tall. The Retry and command-card icon targets were enlarged to the same size. A private fontconfig loads Noto Sans TC and Noto Color Emoji; the emoji table cell is checked through Chrome’s platform-font inspection. Sample conversation text is zh-TW. Catalogs, availability and command replies are fixtures; native functionality is not exercised. No live Fleet, CLI, account or tmux operation was performed. Owned listeners and browser contexts were closed afterward.

## Existing issues kept separate

[Pre-existing wording and phone authorization-line layout](web-model-picker-m2731-existing-copy.md) are excluded from this card: Dashboard 權限 / 網頁儀表板, Agent / Agents / backend, raw `off` / `full` / `summary` / `hidden`, and the cramped phone 未驗證 line. They remain unchanged.

## Style and acceptance after UI approval

Follow `docs/design/ui-style-guide.md` on the alpha line, applying main’s existing card frame rather than copying alpha’s frame. Reuse `ModelSelect`, `.field-row`, `.btn`, `ErrorState`, `CommandCard`, `.quick-actions` and the shared dialog. Use tokens, EN/zh-TW strings in a feature-owned module, reduced-motion-safe progress, and no spinner replacing a populated list.

The implementation will have fail-first tests for real rediscovery versus cache reads, selection preservation, failed refresh, stale target/account responses, typed actions, backend-step parity, custom-provider scope and native authority. SKEW will cover an old app shell/CSS/shared catalog module with new lazy UI; it must still render usable controls and never interpret Refresh/More as a model. Browser acceptance will cover desktop/phone, EN/zh-TW, light/dark and current/SKEW assets. No SKEW or functional acceptance is claimed for this design-only branch.

Main PR first, then an alpha twin preserving native-specific hooks. Acceptance precedes parity review; the coordinator merges.
