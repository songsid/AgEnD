# Existing copy and layout — outside M-2731

These are pre-existing issues seen in the model-picker captures. They are listed for a separate decision and are not being corrected by this card.

| Existing wording/layout | Where it appears | Source to inspect |
|---|---|---|
| 「Dashboard 權限」 beside the product’s 「網頁儀表板」 terminology | Settings → Agents → Settings → dashboard permission fields | `src/ui/settings-strings.js`, `settings.dashboardAccess`; `settings-dialogs.js`, `ag-dash-*` |
| Inconsistent `Agent` / `Agents` and English `backend` labels | Existing Settings navigation, field labels and command descriptions | `src/ui/settings-strings.js`, `src/ui/shared/app-i18n.js`, `src/ui/chat-strings.js` |
| Raw `off`, `full`, `summary`, `hidden` values | Agent defaults’ tool-progress and cross-Agent visibility selects, plus corresponding Agent fields | `src/ui/settings-model.js`, `TOOL_PROGRESS` / `VISIBILITY_MODES`; `g-tp` / `g-vis` |
| Cramped 「未驗證」 line | Phone chat, beneath the composer beside authorization/help text | `src/ui/shared/web-authorize.js`, `ComposerAuth`; `src/ui/panel-chat.js`, `.composer-row`; `src/ui/shared/app.css` |

New proposal copy uses 「後端」, including 「選擇後端；下一步選模型與推理強度」. Existing labels elsewhere remain visible in the screenshots so they can be judged separately. Product names such as Agent, Fleet, Claude Code, Sonnet and Codex remain in English.
