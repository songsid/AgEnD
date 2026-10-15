---
title: 設定
description: fleet.yaml 與 classicBot.yaml 參考。
---

AgEnD 在啟動時和 `agend reload` 時讀 `~/.agend/fleet.yaml`（或 `$AGEND_HOME/fleet.yaml`）。大部分設定也能在網頁 dashboard 的 **Settings** 裡改。啟動任何東西之前先驗證：

```bash
agend validate
```

這頁是精簡版。每個欄位和各種邊界情況，請看 GitHub 上的[完整設定參考](https://github.com/songsid/AgEnD/blob/main/docs/configuration.zh-TW.md)。

## fleet.yaml

只有 `instances` 是必填。

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `instances` | object | — | **必填。** 每個 instance 的設定，用名稱當 key |
| `channels` | ChannelConfig[] | — | 平台 adapter，一個 bot 一筆 |
| `channel` | object | — | 單一 channel 的寫法。仍然可用；Settings 儲存時會改存成 `channels` 清單 |
| `defaults` | object | `{}` | 套用到每個 instance |
| `project_roots` | string[] | — | 允許 agent 建立 instance 的目錄 |
| `teams` | object | — | 具名群組，用於定向廣播 |
| `templates` | object | — | 可重複使用的多 instance 部署 |
| `profiles` | object | — | 可重複使用的後端／模型預設組 |
| `health_port` | number | `19280` | 網頁 dashboard 與 health endpoint 的 port，在 `127.0.0.1` 上 |
| `fleet_label` | string | 主機名稱 | 這個 fleet 在 `/login` 裡的名字，讓同一個 Discord server 裡多個 fleet 的 bot 分得出來 |
| `web` | object | — | 網頁 dashboard 選項，見下 |
| `web_terminal` | object | — | `/login` 背後的瀏覽器終端：`enabled`（`true`）、`bind`（`127.0.0.1`）、`ttl_minutes`（1–20，`10`）和 `tunnel.allow_public` |
| `needs_you` | object | — | **「等你處理」**清單，列出所有在等人處理的事：`live_message`（`true`）在 General 維持一則即時訊息；`dm`（`false`）另外私訊該 bot 的管理員 |

### web

最常用的 key。其餘的見[完整參考](https://github.com/songsid/AgEnD/blob/main/docs/configuration.zh-TW.md)。

| Key | 預設 | 作用 |
|---|---|---|
| `web.usage_panel` | `true` | `false` 會隱藏所有訂閱用量顯示，並停用 `/api/ai-usage` |
| `web.log_tab` | `false` | 開啟每個 instance 的 **Log**（紀錄）分頁。Claude Code 和 Codex 會顯示 agent transcript 裡的 prompt、回覆、工具呼叫和錯誤，機密值會遮蔽。其他後端（含 Kiro）只顯示 fleet 事件，並說明原因 |
| `web.allowed_hosts` | — | 透過反向代理或 port forward 連線時，dashboard 額外接受的 `Host` 名稱。其他 `Host` 一律 403 |
| `web.view_access` | `open` | `session` 會讓沒登入的人看不到 `/view` |
| `web.notify_login` | `true` | `false` 就不會在 General 通知每次本機網頁登入 |
| `web.session.local.absolute_hours` / `.idle_hours` | `48` / `48` | 直接連到 dashboard 時，一次登入能維持多久（最多 720）。公開連結的 session 固定 4 小時／閒置 30 分鐘 |
| `web.preview` | `true` | `false` 會關掉網頁聊天裡的 HTML 預覽 |
| `web.public_link.allow_public` | `true` | `false` 會從 `/web` 拿掉臨時公開連結，並關閉已開啟的連結 |
| `web.public_link.ttl_minutes` | `120` | 公開連結的有效時間，1–480 |
| `web.echo_to_channel` | `true` | `false` 就不會把網頁聊天的訊息複製到該 instance 的 Telegram 或 Discord topic |

登入、session 和公開連結，請看[網頁 dashboard 說明](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md)。

### channels

一個 bot 一筆。

| 欄位 | 型別 | 必填 | 預設 | 作用 |
|---|---|---|---|---|
| `type` | string | 是 | — | `telegram` 或 `discord` |
| `mode` | string | 是 | — | 必須是 `topic` |
| `bot_token_env` | string | 是 | — | 存放 token 的環境變數**名稱** |
| `id` | string | 多 channel 時 | 同 type | 唯一識別，例如 `telegram`、`discord` |
| `group_id` | number \| string | 否 | — | Telegram 論壇群組或 Discord server（guild） |
| `access` | AccessConfig | 否 | open，見下 | 誰可以跟它說話 |
| `options` | object | 否 | — | 平台專屬，見下 |
| `telegram_api_root` | string | 否 | `https://api.telegram.org` | 覆寫 Bot API 網址 |
| `mirror_topic_id` | number \| string | 否 | — | 鏡像跨 instance 訊息的 topic |

Token 本身永遠不會寫進檔案。`bot_token_env` 指的是要去 `~/.agend/.env` 讀哪個變數。

#### access

**整個 `access` 區塊不寫，就是所有人都能進來**（`open`）。`agend quickstart` 會寫成 `mode: locked` 加上你的 user ID。你自己寫的 `access` 區塊不會逐欄補上預設值，所以 `mode` 和 `allowed_users` 請自己寫。

| 欄位 | 型別 | 整個區塊不寫時 | 作用 |
|---|---|---|---|
| `mode` | `locked` \| `pairing` \| `open` | `open` | `locked` = 只認白名單。`pairing` = 白名單，加上用 `/pair` 自助註冊。`open` = 所有人 |
| `allowed_users` | (number\|string)[] | `[]` | 允許的 user ID |
| `max_pending_codes` | number | `0` | 同時存在的配對碼上限。用 `pairing` 時請設正數 |
| `code_expiry_minutes` | number | `0` | 配對碼有效時間。用 `pairing` 時請設正數 |

- **儲存的狀態優先於 `fleet.yaml`。** 配對、確認配對碼、或 `agend access lock`/`unlock` 都會把 mode 寫進 `~/.agend/access/access.json`（其他 bot 是 `access-<id>.json`）。從那之後用的是存下來的 mode，存下來的使用者也會併進 `allowed_users`。要移除某人，兩邊都要刪。
- **Fleet 管理員是另一回事。** 管理指令（`/update`、`/login`、`/web`…）要求使用者在該 bot 於 `fleet.yaml` 的 `allowed_users` 裡。`open` 存取或配對都不會讓人變成管理員。

#### options

Discord 吃 `general_channel_id`，也就是 General instance 回話的頻道。

Telegram 吃：
- `topic_probe`：預設 `on-demand`，只有在實際送訊息回報 topic 不存在之後才去檢查。`periodic` 會在每 5 分鐘的掃描時額外探測每個綁定的 topic，做法是在每個 topic 發一則空白訊息再刪掉。
- `sticker_sets`：agent 沒指定時，`list_stickers` 顯示的貼圖組。

兩者都吃 `status_emojis`，也就是 bot 蓋在你訊息上的狀態反應（`received`、`queued`、`processing`、`delivered`、`failed`…）。沒設的 key 沿用內建值。Telegram 只接受它自己的反應清單。**Settings** 裡有挑選器。

### defaults

`instances.<name>` 的每個欄位都能寫在這裡。以下是只能放在 defaults 的：

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `locale` | `en` \| `zh-TW` | 依時區判斷 | 使用者看到的文字語言 |
| `warm_cap` | number | `0`（無限） | 同時執行的 instance 上限。超過時，最久沒動作的 idle instance 會被暫停。General 不會因此被暫停 |
| `delivery_worker` | `off` \| `wake_only` \| `on` | `wake_only` | `wake_only` 會在有其他 instance 的工作排隊時喚醒暫停中的 instance。`off` 永遠不喚醒。`on`（canary）另外給它一個專屬的投遞 worker |
| `warm_overflow` | number | `2` | 為了喚醒有排隊工作的 instance，`warm_cap` 最多可以超出的數量 |
| `max_cross_instance_message_bytes` | number | `12288` | 跨 instance 訊息本文的大小上限。超過會被拒絕，並建議改傳檔案路徑 |
| `reply_overdue_minutes` | number | `15` | 需要回覆的請求沒人回、負責的 instance 又閒著時，通知發問者一次。`0` 關閉這個通知 |
| `reply_obligation_ttl_hours` | number | `24` | 沒回覆的請求幾小時後到期 |
| `retention_days` | number | `30` | 已完成的投遞和 Task Board 已完成任務保留幾天 |
| `progress_min_elapsed` | number | `30` | 即時進度列開始顯示經過時間前的秒數 |
| `startup.concurrency` | number | 依 RAM 與 CPU，`2`–`10` | 同時啟動的 instance 數（自己設時為 `1`–`20`） |
| `startup.stagger_delay_ms` | number | `500` | 兩次 instance 啟動之間的最小間隔，開機、喚醒、重啟都一樣 |
| `cost_guard.daily_limit_usd` | number | `0`（關閉） | 整個 fleet 的每日花費上限 |
| `cost_guard.warn_at_percentage` | number | `80` | 到達上限的幾成時警告 |
| `cost_guard.timezone` | string | 系統時區 | 每日重置依據的 IANA 時區 |
| `hang_detector.enabled` | boolean | `true` | 偵測卡住的 instance |
| `hang_detector.timeout_minutes` | number | `10` | 工作中的 instance 畫面幾分鐘沒變化後通知 |
| `daily_summary.enabled` | boolean | `true` | 每日花費與狀態報告 |
| `daily_summary.hour` / `.minute` | number | `21` / `0` | 當地時間的發送時刻 |
| `tips` | boolean | `true` | General 的每日提示，以及更新後的提示 |
| `scheduler.max_schedules` | number | `100` | 排程上限 |
| `scheduler.default_timezone` | string | `Asia/Taipei` | 沒指定時區的排程用的時區 |
| `scheduler.retry_count` / `.retry_interval_ms` | number | `3` / `30000` | 排程投遞失敗的重試 |
| `webhooks` | WebhookConfig[] | — | 對外通知 |

### instances

```yaml
instances:
  myproject:
    working_directory: /home/you/projects/app
    backend: claude-code
    model: sonnet
    effort: high
```

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `working_directory` | string | 自動建立 | 專案的絕對路徑 |
| `backend` | string | `claude-code` | `claude-code`、`codex`、`opencode`、`kiro-cli`、`antigravity`、`grok`、`muse` |
| `model` | string | — | 覆寫模型；格式依後端而定 |
| `model_failover` | string[] | — | 遇到 rate limit 時依序退回的模型 |
| `effort` | string | — | `low`/`medium`/`high`/`xhigh`/`max`。只要安裝的 CLI 吃這個設定，每次啟動都會帶上，並夾到它接受的範圍；否則沿用 CLI 自己的設定，並在 Log 分頁說明原因。可在聊天用 `/effort` 改 |
| `display_name` | string | — | Agent 顯示的名字 |
| `description` | string | — | 這個 agent 是做什麼的 |
| `tags` | string[] | — | 能力標籤，用於被發現 |
| `topic_id` | number \| string | 自動建立 | Telegram topic 或 Discord thread |
| `channel_id` | string | — | 屬於哪個 channel adapter（bot） |
| `general_topic` | boolean | `false` | 標記為 General 派工者 |
| `tool_set` | string | `worker` | 見 [工具權限組](#工具權限組) |
| `tool_progress` | `off` \| `standard` \| `verbose` | `off` | 頻道裡顯示的工具活動。`verbose` 會加上截斷過的指令預覽 |
| `cross_instance_visibility` | `full` \| `summary` \| `hidden` | `full` | bot 之間的訊息在這個 instance 的 topic 和網頁聊天裡顯示多少。不影響投遞。也可用 `/visibility` |
| `status_emojis` | object | — | 這個 instance 自己的狀態反應，覆蓋 channel 的設定 |
| `auto_pause_after` | number | `0`（關閉） | 閒置幾分鐘後暫停 |
| `backend_options` | object | — | 各後端專屬設定，用後端名稱當 key。見[憑證 profile](#憑證-profile) |
| `terminal.enabled` | boolean | `true` | `false` 會把視窗固定成 80x24 |
| `terminal.columns` / `.rows` | number | `120` / `36` | 終端機大小 |
| `mcp_auto_restart` | boolean | `true` | MCP server 死掉或一直連不上時重啟 instance。`false` 只通知 |
| `mcp_proxy_reply` | boolean | `false` | MCP server 在回合中途死掉時，把畫面最後的文字轉發出去。預設關閉，因為原始畫面文字可能夾帶遮蔽機制漏掉的內容 |
| `reply_completion_guard` | boolean | `true` | 真人發起的回合結束卻沒有回覆時，自動補救（Claude Code、Kiro legacy/TUI、Codex、Muse） |
| `systemPrompt` | string | — | 額外指示，直接寫內容或 `file:路徑`（相對於 `working_directory`） |
| `workflow` | string \| false | `builtin` | `builtin`、`file:路徑`、直接寫內容、或 `false` |
| `pre_task_command` | string | — | 每則使用者訊息前先貼上的指令 |
| `skipPermissions` | boolean | 除非設 `false`，否則為 `true` | 用各後端的旗標跳過 CLI 自己的權限確認。Antigravity 一律帶 `--dangerously-skip-permissions` 啟動，設 `false` 也一樣 |
| `startup_timeout_ms` | number | `25000` | 給 CLI 啟動的時間 |
| `log_level` | string | `info` | `debug`、`info`、`warn`、`error` |
| `lightweight` | boolean | `false` | 跳過非必要子系統 |
| `agent_mode` | `mcp` \| `cli` | `mcp` | `cli` 改用 `agend-agent` 指令取代 MCP |
| `kiro_ui` | `legacy` \| `tui` | `legacy` | Kiro 引擎，每次啟動都會固定（`v3` 在能無人值守執行前會被拒絕） |
| `worktree_source` | string | — | 用 git worktree 時的原始 repo |
| `cost_guard` | CostGuardConfig | — | 單一 instance 的上限，覆寫 fleet 的 |
| `restart_policy.max_retries` | number | `10` | 放棄前的 crash 重啟次數 |
| `restart_policy.backoff` | string | `exponential` | `exponential` 或 `linear` |
| `restart_policy.reset_after` | number | `300` | 活多久之後重試次數歸零（秒） |

`context_guardian.max_age_hours` 和 `context_guardian.grace_period_ms` 現在會被忽略，並出現驗證警告：AgEnD 不再輪替 session，各 CLI 會自己壓縮 context。

### 工具權限組

`tool_set` 決定一個 agent 能做什麼。這是由 fleet 強制執行的，不是靠模型看到哪些工具。它是權限政策，不是隔離：以同一個系統使用者執行的 agent 仍然碰得到彼此的檔案。

| 權限組 | 怎麼拿到 | 是什麼 |
|---|---|---|
| `worker` | 預設 | 跟人和同儕說話、讀 fleet、把工作做完、替自己排程 |
| `coordinator` | `tool_set: coordinator` | worker 再加上經營 fleet 的動詞：建立、刪除、重啟 instance、team、替其他 instance 排程 |
| `full` | `tool_set: full` | 所有工具 |
| `standard` / `minimal` | 手動設定 | 30 個 / 9 個工具 |

`general` 是指派給 General instance 的，不能手動設定：手寫會驗證失敗。

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

`team: true` 會順便用部署出來的 instance 建一個 team。template 裡的 instance 吃 `description`、`backend`、`model`、`model_failover`、`tool_set`、`systemPrompt`、`skipPermissions`、`lightweight`、`workflow`、`tags` 和 `profile`。

部署是 agent 透過 `deploy_template`、`teardown_deployment`、`list_deployments` 這幾個工具做的。沒有對應的 CLI 指令。

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
      events: [cost_warning, hang]
      headers:
        Authorization: "Bearer token"
```

會送出的事件有 `hang`、`mcp_died`、`pty_error`、`pty_recovered`、`cost_warning`、`cost_limit`、`schedule_deferred`、`model_failover` 和 `model_recovered`。`events: ["*"]` 訂閱全部。

## 憑證 profile

CLI 後端把登入資訊放在固定的一個地方，所以每個 instance 共用同一個帳號。**Kiro CLI、Codex 和 Claude Code** 可以用 `credential_profile` 給 instance 一個具名、獨立的登入。其他後端會忽略它，並出現警告。

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

指到同一個 profile 的 instance 共用一個登入。沒有寫 `credential_profile` 的 instance 完全不受影響：啟動指令不會被加東西，也不會幫它建目錄。Profile 放在 `~/.agend/credential-profiles/<backend>/<profile>`。

每個 profile 先登入一次：

| 後端 | 怎麼登入 |
|---|---|
| Claude Code | 在聊天用 `/login claude-code work`（手機也能完成），或在主機上：`CLAUDE_CONFIG_DIR=~/.agend/credential-profiles/claude-code/work claude auth login` |
| Kiro CLI | 在主機上：`XDG_DATA_HOME=~/.agend/credential-profiles/kiro-cli/work kiro-cli login` |
| Codex | 在主機上：`CODEX_HOME=~/.agend/credential-profiles/codex/work codex login` |

要幫既有 agent 換 profile，直接用自然語言跟 General 說，例如「把 research-a 換到個人訂閱」。AgEnD 會改設定並重啟 agent。**換到一個從沒登入過的 profile 會被拒絕**，錯誤訊息會附上登入指令。`credential_profile: null` 會清掉這個 agent 自己的設定，回到 fleet 的預設（通常是共用登入）。換回共用登入永遠不會被拒絕。

換 profile 對對話的影響依後端而定：
- **Claude Code** 會保留對話：AgEnD 在重啟時把 session 複製到新 profile，舊 profile 也保有自己那份。複製不成時，會像 Kiro 一樣開新對話，並說明原因。
- **Kiro** 會開新對話，因為 kiro 把對話和登入放在一起。AgEnD 會把最近的訊息交接給新 session。
- **Codex** 各 profile 共用對話儲存，只有登入不同。

Kiro 只複製登入資訊：kiro 下載的大型執行環境會連回共用的那一份，所以多開一個 profile 只花幾 MB。新的 Kiro profile 沒有 `knowledge_bases` 和 shell 歷史；想要兩邊都有，請手動複製。

`/usage` 和 dashboard 會為每個使用中的 profile 各列一行，例如 `Kiro (work)` 或 `Claude (work)`。各後端共用什麼、各 profile 自己保有什麼，見[完整參考](https://github.com/songsid/AgEnD/blob/main/docs/configuration.zh-TW.md)。

## classicBot.yaml

`~/.agend/classicBot.yaml` 管 ClassicBot 頻道（在任何頻道用 `/start` 掛上一個 agent）。`agend quickstart` 設定 Discord 時會詢問要不要建立；不然就在第一次 `/start` 時建立。改動每 30 秒偵測一次，不用重啟。

### defaults

| 欄位 | 型別 | 預設 | 作用 |
|---|---|---|---|
| `backend` | string | `claude-code` | classic 頻道用的後端 |
| `model` | string | — | classic 頻道用的模型 |
| `context_lines` | number | `5` | 每則訊息前注入的聊天歷史行數。`0` 關閉 |
| `allowed_guilds` | string[] | `[]` | 可以啟動 ClassicBot 的 Discord server |
| `allowed_groups` | string[] | `[]` | 可以用的 Telegram 群組 |
| `allowed_users` | string[] | `[]` | 可以在私人對話使用的 Telegram 使用者 |
| `admin_users` | string[] | `[]` | ClassicBot 管理員，在新頻道啟動時不受名單限制；其他需要管理員的指令見[指令範圍表](https://github.com/songsid/AgEnD/blob/main/docs/command-surface.zh-TW.md) |
| `reply_completion_guard` | boolean | 繼承 | 同 instance 的同名欄位 |

**名單是空的不代表開放。** 不是 ClassicBot 管理員的人在新頻道執行 `/start`，而該 server、群組或私人對話不在名單上時，會在 General 請你核准，附上 **Allow / Allow+admin / Ignore** 按鈕。核准不會直接啟動 agent，請再執行一次 `/start`。管理員不受此限，已經註冊的頻道也照常運作。

在 Telegram 群組裡，即使群組已被允許，也只有 ClassicBot 管理員能啟動 agent。**Allow** 只允許群組；請用 **Allow+admin**，或請管理員執行 `/start`。

在 Telegram 群組裡要指名 bot：`/start@YourBot`（或 `/start@YourBot codex`）。沒有 `@YourBot` 的群組指令會被忽略。

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
| `collab` | boolean | `false` | Discord：把頻道裡每則訊息都留作上下文。觸發回合仍需要 @提及 bot，或用 `/chat`。不要在 Telegram 設定，見下 |
| `pre_task_command` | string | — | 每則訊息前先貼上的指令 |
| `reply_completion_guard` | boolean | 同 defaults | 這個頻道的覆寫 |

在 Telegram 上，檔案裡寫了 `collab: true` 會讓 bot 等待 Discord 式的提及，一般訊息可能就不會有回應。一般的 Telegram `/start` 不會設定它。

後端的決定順序：頻道 → `defaults.backend` → `fleet.yaml` 的 defaults → `claude-code`。

Instance 名稱是 `classic-<頻道名>-<頻道 id 後四碼>`。Discord 的 `/start` 會自動開啟 collab 模式。
