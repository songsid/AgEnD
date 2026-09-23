---
title: 功能
description: Fleet 跑起來之後會做的事。
---

一個 fleet 是一組獨立的 agent session，一個專案一個，全部從同一個 bot 操作。這頁講的是它們在你不在的時候做什麼。

## 一個 bot，多個專案

每個聊天 topic 就是一個 agent，有自己的專案目錄、後端和對話。建立 topic 就啟動 agent，刪掉 topic 就停掉。

送到特定 topic 的訊息直接進那個 agent。送到 **General** topic 的訊息會被讀懂，然後用自然語言路由給該處理的那個 agent：

```
你：把 deploy script 在 staging 機器上弄好
General：→ 交給 infra-agent
```

Instance 跑在 tmux 裡，所以關掉終端機什麼事都不會發生。

## Agent 之間會互相說話

每個 instance 都是對等的。中間沒有派工者 — agent 透過 MCP tools 直接互相發現、喚醒、傳訊。

主要靠三個工具：

- `request_information` — 問另一個 agent 問題並等答案
- `delegate_task` — 把工作交出去，附上完成標準
- `report_result` — 回傳結果，並連回當初那個請求

Agent 也可以 `create_instance`、`start_instance`、`replace_instance` — 但要有 `coordinator` 工具權限組。一般的 worker 可以把工作交給同儕，但不能生出同儕。見[工具權限組](/AgEnD/zh-tw/docs/configuration/#工具權限組)。

`create_instance` 吃 `branch` 參數，會把新 agent 放進自己的 git worktree。

## 沒人顧也活著

**Crash 恢復。** CLI 程序死掉時，daemon 會先把最近的訊息和工具活動做成快照、砍掉整棵 process tree（不留下孤兒 MCP server），然後用 `--resume` 試著把對話接回來。resume 失敗就開新的 session，把快照當成 context 注入進去。

連續 crash 會指數退避，五分鐘內 crash 三次就完全停止重生，而不是一直迴圈。

如果是 tmux server 自己死掉，所有 instance 會同時失去視窗。五分鐘內發生兩次，所有重生會暫停 30 秒，避免整個 fleet 一起衝。

**卡住偵測。** Instance 超過 15 分鐘（可設定）沒有動靜，就會發一則帶兩個按鈕的通知：強制重啟，或繼續等。偵測同時看 transcript 活動和 statusline 的新鮮度，所以跑很久的工具呼叫不會被誤判成卡住。

**換掉 instance。** Session 陷入迴圈或 context 被污染時，`replace_instance` 會原子性地換掉它：收集交接內容、停掉舊的、用同樣的設定和同一個 topic 建新的、把交接內容送過去。

## 花費

設一個每日上限，fleet 會執行它：

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: Asia/Taipei
```

到警告門檻時 topic 裡會收到提醒，到上限時 instance 會被暫停並通知你。隔天會恢復，或你手動重啟。

在 General topic 打 `/status` 看錢花到哪去：

```
🟢 proj-a — ctx 42%, $3.20 today
🟢 proj-b — ctx 67%, $8.50 today
⏸ proj-c — paused (cost limit)

Fleet: $11.70 / $50.00 daily
```

同樣的內容預設每天 21:00 會發一份摘要。

## Rate limit

主要模型被 rate limit 時，下一次 session 重啟就會換到你列的下一個：

```yaml
instances:
  my-project:
    model_failover: [opus, sonnet]
```

切換時會通知你，切回來時也會。

排程觸發在 5 小時 rate limit 用超過 85% 時會自動延後。它們不會消失 — 等額度回來後的下一個 cron tick 就會執行。

## 閒置的 instance

`auto_pause_after` 會在 instance 閒置滿指定分鐘數後暫停它。tmux 視窗保留、CLI 掛起，來訊息時約 30 秒醒來。正在產生回應的 instance 永遠不會被暫停。

`warm_cap` 限制同時常駐的 instance 數量。超過時，**最久沒動作的閒置** instance 會被暫停讓位 — 即使它自己的閒置計時還沒到。General instance 永遠不會被踢。

```yaml
defaults:
  auto_pause_after: 30
  warm_cap: 15
```

## 排程工作

Agent 自己建排程，存在 SQLite 裡，重啟後還在：

```
你：每天早上九點檢查有沒有等 review 的 PR
Agent：→ create_schedule(cron: "0 9 * * *", …)
```

排程觸發時，訊息會像你自己送的一樣抵達。每個 agent 都能替自己排程（heartbeat、提醒、「30 分鐘後回來看」），也能修改或刪除自己替自己建的排程。要替別的 agent 排工作，或修改別人設下的排程，需要 coordinator（`coordinator`、`general` 或 `full`）；`minimal` 則完全沒有排程功能。

在終端機用 [`agend schedule`](/AgEnD/zh-tw/docs/cli/#排程) 管理。

## 從手機操作

**取消按鈕。** 每則訊息都帶一個可以中斷生成的按鈕。Telegram 和 Discord 都有。

**送達狀態。** 👀 已接收 → ⏳ 處理中 → ✅ 完成，或 ❌ 失敗。你看得到訊息走到哪一步。

**權限詢問**會變成按鈕 — 不用打開終端機就能同意或拒絕一次工具呼叫。

**語音訊息**在有設 `GROQ_API_KEY` 時會用 Groq Whisper 轉成文字。

## Discord

Discord 有兩種用法。論壇形式的 topic 跟 Telegram 一樣。或是用 **ClassicBot**，在任何一般文字頻道裡跑 agent：

| 指令 | 作用 |
|---|---|
| `/start` | 在這個頻道開一個 agent |
| `/chat <訊息>` | 跟它說話 |
| `/stop` | 停掉它 |

用 `classicBot.yaml` 的 `allowed_guilds` 限制哪些伺服器能用；空的代表全部允許。改動每 30 秒生效。

## Team 與 template

**Team** 是可以一次對上的具名群組：

```yaml
teams:
  reviewers:
    members: [reviewer-a, reviewer-b]
```

**Template** 一個指令部署多個 instance，每個在自己的 git worktree 裡，還可以順便註冊成一個 team。Agent 用 `deploy_template` 部署、`teardown_deployment` 拆掉。

共用的**任務板**追蹤跨 instance 的多步驟工作，讓一個 agent 看得到另一個做完了什麼。

## 觀察與匯出

**Web 儀表板** — `agend web` 開即時監控，SSE 更新加上聊天介面。`agend view` 是唯讀版。

**Mirror topic** — 把 `mirror_topic_id` 指到某個 topic，跨 instance 的訊息會鏡像過去，你不用待在 agent 的 topic 裡也看得到它們在做什麼。

**HTML 匯出** — `agend export-chat` 把 session 寫成一個獨立檔案。

## 後端

| 後端 | 說明 |
|---|---|
| Claude Code | 整合最完整 |
| OpenAI Codex | 有原生輸入佇列；支援 session resume |
| Kiro CLI | `kiro_ui` 可選 legacy、tui 或 v3 agent |
| Antigravity CLI | 跑在 `agent_mode: cli` |
| Grok Build | |
| Meta Muse Code | Escape 是取消；Ctrl+C 是離開 |
| OpenCode | |
| Gemini CLI | 2026-06-18 起已棄用 |

OpenCode 和 Kiro CLI 不讀 MCP server 的 `instructions` 欄位，所以 fleet context 和 workflow template 不會被注入它們的 system prompt。這是上游的限制。

## 擴充

- **Webhook** — instance 生命週期事件發生時 POST 出去，可帶自訂 header
- **Health endpoint** — 在 `health_port` 上開 HTTP，預設 19280
- **外部 session** — fleet 以外的程序可以透過 IPC 加入，像一般 instance 一樣被傳訊
- **Adapter 外掛** — 不改 AgEnD 就能加新的聊天平台

## 限制

- 只支援 macOS 和 Linux。不支援 Windows，請用 WSL
- 全域 `enabledPlugins` 裡有官方 Telegram 外掛會造成 409 polling 衝突
- 所有後端都是跳過權限確認在跑。把它指向你在乎的東西之前，先讀安全性說明
