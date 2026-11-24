# AgEnD Terminology Guide

This guide keeps user-facing text, documentation, and configuration references consistent across English and Traditional Chinese (`zh-TW`).

## Preferred terms

| Concept | Formal English | zh-TW user-facing | zh-TW technical/config prose | Meaning |
|---|---|---|---|---|
| Instance | Instance | Agent | instance | One AgEnD-managed CLI process. Every zh-TW UI string says “Agent” (never 實例); keep `instance` only in config keys, tool and API names, and paths such as `.kiro/steering/agend-<instance>.md`. |
| Backend | Backend | 後端 | `backend` | The CLI or AI service that drives an Agent, such as Claude Code, Codex, or Kiro CLI. |
| Context | Context | 上下文 | Context | The amount and content of the current conversation that the model can retain. |
| Fleet | Fleet | Fleet | Fleet | The collection of instances managed together by AgEnD. |
| Working directory | working directory | 工作目錄 | 工作目錄 | The project directory in which an instance runs. |
| General | General | General | General | The coordinator instance for a Fleet. Treat it as a product role and retain the capitalized name. |
| Working | working | 工作中 | 工作中 | The instance is actively processing work. |
| Idle | idle | 閒置 | 閒置 | The instance is ready and not actively processing work. |
| Stuck | stuck | 卡住 | `stuck` | An internal execution state: the CLI is not ready and its pane has remained unchanged past the stuck timeout. |
| Awaiting input | awaiting input | 等待輸入 | `awaiting_input` | A presentation label for a confirmed, fresh interaction waiting for input; it is not an additional execution state. |
| Admin | admin | 管理員 | 管理員 | A person who administers the Fleet or the Hub (a fleet admin, a Hub admin, this computer's admin). One word everywhere in zh-TW: 管理員, never 管理者. |

## Writing guidance

- In English, use the formal terms in the table. Capitalize product labels and glossary definitions; lowercase ordinary technical prose and literal names where English grammar or a configuration/API name requires it.
- In zh-TW user-facing text, call the thing a user talks to an “Agent”: for example, “你的 Agent 正在工作中”. Use `instance` when referring to an instance name, instance setting, API field, or configuration object.
- Keep `Fleet` and `General` in English in zh-TW text. Since M-3666 (user-approved 2026-11-24) a backend is 後端 and model Context is 上下文.
- Keep literal filenames, commands, and configuration keys unchanged, such as `fleet.yaml`, `working_directory`, `backend`, and `context_guardian`.
- Write 「管理員」 for admin in every zh-TW string, doc and site page (M-2820); do not use 「管理者」.
- Do not alternate between translated and untranslated forms. Avoid「AI 助手」or「實例」for Agent,「AI 引擎」for Backend, and「前後文」「對話空間」for model Context.

## zh-TW UI glossary (M-3666, approved 2026-11-24)

The zh-TW UI uses these words. Keep config keys, slash commands, paths, CLI button labels and quoted protocol strings (for example 「Resume full session as-is」, `Delivery not found`) as they are. `tests/zh-tw-glossary-m3666.test.ts` blocks only the clear errors 管理者, 覧 and 占用 (write 管理員, 覽, 佔用); English terms are not hard-blocked yet.

| English | zh-TW | English | zh-TW |
|---|---|---|---|
| instance | Agent | session | 工作階段 |
| backend | 後端 | tunnel / named / quick tunnel | 通道 / 固定通道 / 臨時通道 |
| credential profile / profile | 帳號設定檔 / 設定檔 | credential | 憑證 |
| topic | 主題 | admin | 管理員 |
| team | 團隊 | Context | 上下文 |
| pane | 窗格 | model | 模型 |
| port | 連接埠 | server | 伺服器 |
| dashboard | 儀表板 | View (the panel) | 「檢視」 |
| Settings | 設定 | Shared agent settings | Agent 共用設定 |
| channel | 頻道 | web chat | 網頁聊天室 |
| task / query | 任務 / 查詢 | pack | 外觀包 |
| Auto-pause | 自動暫停 | Effort | 推理強度 |
| owner | 擁有者 | Notice | 通知 |
| thread | 討論串 | System prompt | 系統提示詞 |
| Status emojis | 狀態表情符號 | adapter | 轉接器 |
| gateway | 閘道 | transcript | 對話紀錄 |
| rate limit | 速率限制 | resume | 恢復 |
| statusline | 狀態列 | legacy | 舊版 |
| manifest | 資訊清單 | crash | 當機 |
| credit | 點數 | malformed | 格式錯誤的 |
| store | 儲存區 | alias | 別名 |
| bytes | 位元組 | checksum | 校驗碼 |
| coding (CLI) | 程式開發 | engine | 引擎 |
| exit code | 結束碼 (#3515) | fallback (model) | 備援模型 |
| flow | 流程 | forward | 轉交 |
| hostname | 主機名稱 | instructions | 指示 |
| manager | 管理程式 | mapping | 對應表 |
| metadata | 中繼資料 | Mirror | 鏡像 |
| persona | 人設 (never 角色: Hub custom roles own 角色) | process | 行程 |
| react | 加上表情反應 | rejection | 未處理的拒絕 |
| runner | 執行程式 | slash (command) | 斜線 |
| snapshot | 快照 | transaction | 交易 |
| turn | 這一輪 | CPU profile | CPU 效能剖析 |

Kept in English: emoji, Issue (GitHub), `workspaces` (in backticks), proxy (decision 815bfe4a forbids 代理), and brand or protocol names such as Cloudflare's connector token and Published application.

## Important distinctions

- A **bot is not an Agent**. A bot is the Telegram or Discord account that carries messages; an Agent is the AgEnD-managed CLI process that handles them.
- **ClassicBot** is a product term. Do not shorten it to “Classic” or use it as a synonym for bot, Agent, or instance.
- Claude Code and OpenCode may use the terms **agent** or **subagent** for their native internal workers. Those are not AgEnD instances. When ambiguity is possible, write “Claude Code subagent”, “OpenCode agent”, or “AgEnD instance”.
- **Working is not running**. A running instance may be either 工作中 or 閒置. “Running” describes process availability; “working” describes current activity.
- A **session** or exported conversation record is not Context. A session is persisted conversation history; Context is what the model can currently retain and use.
- Generic uses of the English word “context” do not always mean model Context. Use capitalized `Context` only for the AgEnD/model concept; translate ordinary meanings according to the sentence.

The internal execution states are `idle`, `working` and `stuck`; `paused` is a
lifecycle status. Status surfaces may present `awaiting_input` when the interaction
is confirmed as `waiting`, is fresh and is not merely suspected. They retain the
underlying `execution_state` and separate `interaction` metadata so callers can
distinguish activity from a prompt waiting for input.

An interaction observation becomes stale after 15 seconds without fresh evidence
and is presented as `unverified`; it no longer projects `awaiting_input`. This
freshness TTL does not clear a runtime dialog's input hold. The hold is tracked
separately from presentation and is updated by pane observations; stale telemetry
does not authorize delivery into a dialog or approve the requested operation.
