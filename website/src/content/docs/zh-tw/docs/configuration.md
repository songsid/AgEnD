---
title: 設定
description: fleet.yaml 與 classicBot.yaml 參考。
---

AgEnD 在啟動時和 `agend reload` 時讀 `~/.agend/fleet.yaml`。啟動任何東西之前先驗證：

```bash
agend validate
```

## fleet.yaml

只有 `instances` 是必填。

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `instances` | object | — | **必填。** 每個 instance 的設定，用名稱當 key |
| `channels` | ChannelConfig[] | — | 平台 adapter。用這個，不要用 `channel` |
| `channel` | object | — | 單一 channel 的寫法。舊版 |
| `defaults` | object | `{}` | 套用到每個 instance |
| `project_roots` | string[] | — | 允許 agent 建立 instance 的目錄 |
| `teams` | object | — | 具名群組，用於定向廣播 |
| `templates` | object | — | 可重複使用的多 instance 部署 |
| `profiles` | object | — | 可重複使用的後端／模型預設組 |
| `health_port` | number | `19280` | HTTP health endpoint |
| `web.usage_panel` | boolean | `true` | `false` 會隱藏訂閱用量面板並停用 `/api/ai-usage` |

### channels

一個平台 adapter 一筆。

| 欄位 | 型別 | 必填 | 預設 | 作用 |
|---|---|---|---|---|
| `type` | string | 是 | — | `telegram` 或 `discord` |
| `mode` | string | 是 | — | 必須是 `topic` |
| `bot_token_env` | string | 是 | — | 存放 token 的環境變數**名稱** |
| `access` | AccessConfig | 是 | — | 誰可以跟它說話 |
| `id` | string | 多 channel 時 | 同 type | 唯一識別，例如 `telegram`、`discord` |
| `group_id` | number \| string | 否 | — | Telegram 論壇群組或 Discord guild |
| `options` | object | 否 | — | 平台專屬，見下 |
| `telegram_api_root` | string | 否 | `https://api.telegram.org` | 覆寫 Bot API 網址 |
| `mirror_topic_id` | number \| string | 否 | — | 鏡像跨 instance 訊息的 topic |

Token 本身永遠不會寫進檔案 — `bot_token_env` 指的是要去讀哪個變數。

#### access

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `mode` | `locked` \| `pairing` \| `open` | `locked` | `locked` = 只認白名單。`pairing` = 用 `/pair` 自助註冊。`open` = 所有人，含 bot |
| `allowed_users` | (number\|string)[] | `[]` | 白名單 user id |
| `max_pending_codes` | number | `3` | 同時存在的配對碼上限 |
| `code_expiry_minutes` | number | `10` | 配對碼有效時間 |

`open` 會讓 bot 訊息直接進到 fleet topic。要開請確定是故意的。

#### options

Discord 吃 `general_channel_id` — General instance 回話的那個頻道。

Telegram 吃 `topic_probe`，預設 `on-demand`：只有在實際送訊息失敗、回報 topic 不存在之後才去檢查。設成 `periodic` 會在每 5 分鐘的掃描時額外探測每個綁定的 topic，做法是在每個 topic 發一則空白訊息再刪掉。

### defaults

`instances.<name>` 的每個欄位都能寫在這裡。以下是只能放在 defaults 的：

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `locale` | `en` \| `zh-TW` | 依時區判斷 | 使用者看到的文字語言 |
| `warm_cap` | number | `0`（無限） | 同時執行的 instance 上限。超過時，最久沒動作的 idle instance 會被自動暫停。General instance 永遠不會被踢 |
| `max_cross_instance_message_bytes` | number | `12288` | 跨 instance 訊息本文的大小上限。超過會被拒絕，並建議改傳檔案路徑 |
| `progress_min_elapsed` | number | `30` | 即時進度列開始顯示經過時間前的秒數 |
| `startup.concurrency` | number | `10` | 同時啟動的 instance 數 |
| `startup.stagger_delay_ms` | number | `500` | 每批啟動之間的間隔 |
| `cost_guard.daily_limit_usd` | number | `0`（關閉） | 整個 fleet 的每日花費上限 |
| `cost_guard.warn_at_percentage` | number | `80` | 到達上限的幾成時警告 |
| `cost_guard.timezone` | string | 系統時區 | 每日重置依據的 IANA 時區 |
| `hang_detector.enabled` | boolean | `true` | 偵測卡住的 instance |
| `hang_detector.timeout_minutes` | number | `15` | 沒有輸出幾分鐘後通知 |
| `daily_summary.enabled` | boolean | `true` | 每日花費與狀態報告 |
| `daily_summary.hour` / `.minute` | number | `21` / `0` | 當地時間的發送時刻 |
| `scheduler.*` | — | — | `max_schedules`、`default_timezone`、`retry_count`、`retry_interval_ms` |
| `webhooks` | WebhookConfig[] | — | 對外通知 |

### instances

```yaml
instances:
  myproject:
    working_directory: /home/you/projects/app
    backend: claude-code
    model: sonnet
```

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `working_directory` | string | 自動建立 | 專案的絕對路徑 |
| `backend` | string | `claude-code` | `claude-code`、`codex`、`opencode`、`kiro-cli`、`antigravity`、`grok`、`muse`、`gemini-cli`（已棄用） |
| `model` | string | — | 覆寫模型；格式依後端而定 |
| `model_failover` | string[] | — | 遇到 rate limit 時依序退回的模型 |
| `effort` | string | — | `low`/`medium`/`high`/`xhigh`/`max`，會夾到後端支援的範圍 |
| `display_name` | string | — | Agent 顯示的名字 |
| `description` | string | — | 這個 agent 是做什麼的 |
| `tags` | string[] | — | 能力標籤，用於被發現 |
| `topic_id` | number \| string | 自動建立 | Telegram topic 或 Discord thread |
| `channel_id` | string | — | 屬於哪個 channel adapter |
| `general_topic` | boolean | `false` | 標記為 General 派工者 |
| `tool_set` | string | `worker` | 見 [工具權限組](#工具權限組) |
| `tool_progress` | `off` \| `standard` \| `verbose` | `off` | 頻道裡顯示的工具細節。`verbose` 會加上截斷過的指令預覽 |
| `auto_pause_after` | number | `0`（關閉） | 閒置幾分鐘後暫停 |
| `backend_options` | object | — | 各後端專屬設定，用後端名稱當 key |
| `terminal.enabled` | boolean | `true` | `false` 會把視窗固定成 80x24 |
| `terminal.columns` / `.rows` | number | `120` / `36` | 終端機大小 |
| `mcp_auto_restart` | boolean | `true` | MCP server 死掉時重啟 instance。`false` 只通知 |
| `mcp_proxy_reply` | boolean | `false` | MCP server 在回合中途死掉時，把畫面最後的文字轉發出去。預設關閉，因為原始畫面文字可能夾帶遮蔽機制漏掉的內容 |
| `systemPrompt` | string | — | 自訂 prompt；支援 `file:路徑` |
| `workflow` | string \| false | `builtin` | `builtin`、`file:路徑`、直接寫內容、或 `false` |
| `pre_task_command` | string | — | 每則使用者訊息前先貼上的指令 |
| `skipPermissions` | boolean | — | 跳過 CLI 自己的權限確認 |
| `startup_timeout_ms` | number | `25000` | 給 CLI 啟動的時間 |
| `log_level` | string | `info` | `debug`、`info`、`warn`、`error` |
| `lightweight` | boolean | `false` | 跳過非必要子系統 |
| `agent_mode` | `mcp` \| `cli` | `mcp` | antigravity 用 `cli` |
| `kiro_ui` | `legacy` \| `tui` \| `v3` | `legacy` | Kiro 啟動模式 |
| `worktree_source` | string | — | 用 git worktree 時的原始 repo |
| `cost_guard` | CostGuardConfig | — | 單一 instance 的上限，覆寫 fleet 的 |
| `restart_policy.max_retries` | number | `10` | 放棄前的 crash 重啟次數 |
| `restart_policy.backoff` | string | `exponential` | `exponential` 或 `linear` |
| `restart_policy.reset_after` | number | `300` | 活多久之後重試次數歸零（秒） |
| `context_guardian.max_age_hours` | number | `0`（關閉） | 幾小時後強制輪替 session |
| `context_guardian.grace_period_ms` | number | `600000` | 輪替前的緩衝時間 |

### 工具權限組

`tool_set` 決定一個 agent 能做什麼。這是由 fleet 在伺服器端強制執行的，不是靠模型看到哪些工具。

| 權限組 | 怎麼拿到 | 是什麼 |
|---|---|---|
| `worker` | 預設 | 跟人和同儕說話、讀 fleet、把工作做完 |
| `coordinator` | `tool_set: coordinator` | worker 再加上經營 fleet 的動詞：建立、刪除、重啟 instance、team、排程 |
| `full` | `tool_set: full` | 所有工具 |
| `standard` / `minimal` | 手動設定 | 18 個 / 4 個工具 |

`general` 是指派給 General instance 的，不能手動設定 — 手寫會驗證失敗。

### teams

```yaml
teams:
  reviewers:
    description: Code review team
    members: [reviewer-a, reviewer-b]
```

### templates

一個 template 一次部署多個 instance，每個都在自己的 git worktree 裡。

```yaml
templates:
  sprint-team:
    description: Sprint development team
    team: true
    instances:
      dev:
        backend: claude-code
        model: sonnet
      reviewer:
        backend: kiro-cli
        tool_set: minimal
```

`team: true` 會順便用部署出來的 instance 建一個 team。裡面的 instance 吃的欄位跟 `instances.<name>` 一樣。

部署是 agent 透過 `deploy_template`、`teardown_deployment`、`list_deployments` 這幾個工具做的 — 沒有對應的 CLI 指令。

### profiles

template 裡的 instance 可以用 `profile: <名稱>` 引用的預設組：

```yaml
profiles:
  heavy:
    backend: claude-code
    model: opus
  light:
    backend: kiro-cli
    lightweight: true
```

### webhooks

```yaml
defaults:
  webhooks:
    - url: https://example.com/hook
      events: [instance.started, instance.stopped]
      headers:
        Authorization: "Bearer token"
```

## 憑證 profile

CLI 後端把登入資訊放在固定的一個地方，所以 fleet 裡每個 instance 共用同一個帳號。`credential_profile` 給你那個地方的一份具名副本。

```yaml
instances:
  work-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: work
  personal-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: personal
```

指到同一個 profile 的 instance 共用一個登入。**沒有寫 `credential_profile` 的 instance 完全不受影響** — 啟動指令不會被加東西，也不會幫它建目錄。

先從主機登入一次：

```bash
XDG_DATA_HOME=~/.agend/credential-profiles/kiro-cli/work kiro-cli login
```

Profile 放在 `~/.agend/credential-profiles/<backend>/<profile>`，掛在 fleet 底下而不是某個 instance 底下，所以多個 agent 可以指向同一個訂閱。

被複製的只有登入資訊。kiro 下載的那些好幾 GB 的執行環境會 symlink 回共用的那一份，所以多開一個 profile 只花幾 MB。

**除了那些快取，profile 是空的。** 後端放在登入旁邊的東西 — kiro 的 `knowledge_bases`、shell 歷史 — 屬於 profile，所以 agent 換到新 profile 時這些都不會跟著過去。想要兩邊都有，`knowledge_bases` 請手動複製。

幫既有 agent 換 profile 是改設定加重啟，重啟 AgEnD 會幫你做。直接用自然語言跟 General 說 —「把 research-a 換到個人訂閱」。要換回預設登入，送 `credential_profile: null`。

**換到一個從沒登入過的 profile 會被拒絕**，錯誤訊息會附上登入指令。換**回**預設登入永遠不會被拒絕 — 那是換錯時的退路。

### 換 profile 等於換一段新對話

kiro 把對話和登入放在同一個資料庫裡，所以換一個訂閱就是換一組對話，沒有東西可以 resume。AgEnD 不會硬試：換完之後的第一次啟動直接跳過 resume。

會跟著過去的是**意圖**。AgEnD 從 daemon 拿舊 session 最近的訊息和活動（不是從 CLI 自己的儲存），當成交接內容送進新 session，並說明它來自哪個訂閱、以及對話沒有一起過來。

## classicBot.yaml

`~/.agend/classicBot.yaml` 管 ClassicBot 頻道，第一次 `/start` 時自動建立。改動每 30 秒偵測一次，不用重啟。

### defaults

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `backend` | string | `claude-code` | classic 頻道用的後端 |
| `model` | string | — | classic 頻道用的模型 |
| `context_lines` | number | `50` | 每則訊息前注入的聊天歷史行數。`0` 關閉 |
| `allowed_guilds` | string[] | `[]` | 可以用 ClassicBot 的 Discord 伺服器。空的 = 全部 |
| `allowed_groups` | string[] | `[]` | 可以用的 Telegram 群組 |
| `allowed_users` | string[] | `[]` | 可以互動的使用者 |
| `admin_users` | string[] | `[]` | 可以用 `/start`、`/stop`、`/raw`、`/compact`、`/save`、`/load`、`/collab` 的使用者 |

### channels

```yaml
channels:
  "1234567890":
    name: dev-help
    backend: kiro-cli
```

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `name` | string | — | 顯示名稱 |
| `backend` / `model` | string | 同 defaults | 這個頻道的覆寫 |
| `context_lines` | number | 同 defaults | 這個頻道的覆寫 |
| `collab` | boolean | `false` | 不用 @提及 也會回應 |
| `pre_task_command` | string | — | 每則訊息前先貼上的指令 |

後端的決定順序：頻道 → `defaults.backend` → `fleet.yaml` 的 defaults → `claude-code`。

Instance 名稱是 `classic-<頻道名>-<頻道 id 後四碼>`。Discord 的 `/start` 會自動開啟 collab 模式。
