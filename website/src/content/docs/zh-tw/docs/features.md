---
title: 功能
description: Fleet 跑起來之後會做的事。
---

一個 fleet 是一組獨立的 agent session，一個專案一個，全部從同一個 bot 操作 — 也可以從瀏覽器。這頁是精簡版；每一節都連到 repo [`docs/`](https://github.com/songsid/AgEnD/tree/main/docs) 裡的完整說明。

## 一個 bot，多個專案

每個聊天 topic 就是一個 agent，有自己的專案目錄、後端和對話。建立 topic 就啟動 agent，刪掉 topic 就停掉。

送到特定 topic 的訊息直接進那個 agent。送到 **General** topic 的訊息會被讀懂，然後用自然語言路由給該處理的那個 agent：

```
你：把 deploy script 在 staging 機器上弄好
General：→ 交給 infra-agent
```

Instance 跑在 tmux 裡，所以關掉終端機什麼事都不會發生。

## Web 儀表板

Fleet 在 `127.0.0.1` 的 `health_port`（預設 19280）上提供一個儀表板。它是一個有側邊欄的 app：

- **聊天**（`/ui`）— 從瀏覽器跟任何 instance 說話。它和那個 instance 的 Telegram 或 Discord topic 是**同一段對話**：你送出的訊息會在 topic 裡顯示成 `🌐 <你的名字>: …`，agent 的回覆兩邊都看得到。可以傳檔案和圖片、按 **Stop** 停止，還有打勾顯示每則訊息走到哪一步。用 ↩ 或 R 回覆指定訊息；從網頁送出的回覆，在 Discord 和 Telegram 上也會是原生回覆。完全沒有聊天平台的 fleet 也能只靠儀表板運作。
- **Fleet**（`/ui/fleet`）— **任務**看板（專案、主任務與子任務，附留言、依賴關係和歷史紀錄）、排程和 team，一張 General、team 與 instance 加上即時狀態的**組織圖**（組織圖也有**辦公室**檢視，把 fleet 畫成像素風辦公室）、prompt cache 的**快取**分析，以及 fleet 設定。標題列的**文件**會開啟這個網站。
- **搜尋**（Ctrl+K，或 ⌘K）— 搜尋聊天訊息、agent 之間的訊息和任務，依 agent 分組。在聊天裡按 Ctrl+F 只搜那一個 agent。只有登入的管理員能搜尋；從 2.3.1 起索引預設不限天數（`web.search.retention_days` 未設定或 0；上限 30 萬筆；2.3.0 仍保留 90 天）。
- **等你處理**（`/ui/needs`）— 所有 bot 等你處理的事集中在一個清單：權限詢問、卡住通知、登入、無法確認送達的訊息。在任何地方處理掉，每個清單都會消失。開啟 `needs_you.task_board` 後，等你處理的任務看板卡片也會加入這個清單。
- **檢視**（`/view`）— 每個 agent 的即時終端畫面、名單、AI 訂閱用量，以及每個 agent 的個人資料和頭像。
- **紀錄** — 每個 instance 一份：Claude Code 和 Codex 會顯示從 agent 的 transcript 讀出的每則 prompt、回覆和工具呼叫，加上當機、重啟等 fleet 事件；其他後端只顯示 fleet 事件。預設關閉；fleet 管理員在**設定 → 網頁儀表板**（`web.log_tab`）打開。
- **設定**（`/settings`）— agent、連線、ClassicBot、Agent 預設值與儀表板自己的設定，以及整份 `fleet.yaml`，先暫存再一起套用。Bot token 在這裡輸入，存檔前會先向平台確認是哪個 bot。在 **網頁儀表板** 下可以找到 App 圖示（「加入主畫面」時顯示的圖），以及實驗功能 Canvas Worker 特效，兩者都要手動開啟。

冷啟動或完整重啟時，儀表板會在所有 agent 啟動完成前就打開，並顯示每個 agent 的啟動進度。

**登入。** 在 General 送 `/web`（fleet 管理員），或在主機上執行 `agend web`，然後在登入頁輸入一次性代碼。代碼只能用一次、5 分鐘後失效。直接連到儀表板時，session 預設維持 48 小時（可設定）；透過公開連結開的 session 最多 4 小時、閒置 30 分鐘就結束，連結關閉時也會結束。用 `/web` 的代碼登入時，agent 看到的你就是你的 Discord 或 Telegram 帳號 — 只用來認人，不給任何權限。

**從手機連。** `/web` 也能透過 Cloudflare Quick Tunnel 開一個**臨時公開連結**：你選它之前什麼都不會公開，連結和代碼私下傳給你，預設兩小時後關閉（或用 `/web revoke` 關掉）。用自己的網域（具名 Cloudflare tunnel，用 `web.public_link.hostname` 設定）時，網址每次都相同，最長可以開到七天，或直到你關掉為止。拿到它的人可以用你的聊天、終端機、檔案和大部分的儀表板 — 公開連結只擋下少數變更（排程、team、Web 設定、密鑰）— 所以不要轉傳。

完整說明：[web-dashboard.zh-TW.md](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md)。

## Agent 之間會互相說話

每個 instance 都是對等的。Agent 透過允許的 MCP tools 互相發現、傳訊；喚醒等管理操作需要對應工具權限組；General 只負責轉送你送給它的訊息。

主要靠三個工具：

- `request_information` — 問另一個 agent 問題並等答案
- `delegate_task` — 把工作交出去，附上完成標準
- `report_result` — 回傳結果，並連回當初那個請求

`delivery_status` 讓 agent 知道它送出的訊息有沒有送到。共用的**任務看板**（`Fleet → Tasks`）和全 fleet 的**決策**讓多步驟的工作一目了然。卡片被指派、退回、回答或確認時，相關的 agent 會收到通知，而且每個 agent 同時只做一張卡。只有你派出去的卡片需要你確認；agent 派出的卡片，由那個 agent 確認。

建立和替換 instance 需要允許它的工具權限組：`coordinator` 和 `full`（以及 General instance 自己的權限組）可以 `create_instance`、`start_instance`，只有 `coordinator` 和 `full` 能 `replace_instance`。一般的 worker 可以把工作交給同儕，但不能生出同儕。見[工具權限組](/AgEnD/zh-tw/docs/configuration/#工具權限組)。

`create_instance` 吃 `branch` 參數，會把新 agent 放進自己的 git worktree。

## 按鈕、投票與貼圖

- **回覆按鈕。** Agent 的 `reply` 可以帶 1–10 個 `buttons`，在 Telegram、Discord 和 web 聊天都會出現；按下去 agent 會收到 `[button] <標籤>`。一個選擇就代表所有人回答了，之後按鈕會顯示誰選了什麼。按鈕 24 小時後過期，重啟後仍然有效。
- **投票。** `reply` 加上 `buttons` 和 `poll: { seconds, multi?, reveal?, show_voters? }` 就是限時投票（10 秒到 24 小時）。能按按鈕的人都能投一次，也能改票。時間到 — 或 agent 呼叫 `close_poll` — agent 會收到一則 `[poll results]`，裡面有票數和投票者。AgEnD 只負責計票；測驗怎麼算分由 agent 決定。
- **貼圖與代表 emoji。** Agent 可以列出、預覽並傳送 Discord 和 Telegram 的貼圖，也能挑一個代表自己的 emoji 當「完成」的反應。

詳細：[回覆按鈕與投票](https://github.com/songsid/AgEnD/blob/main/docs/features.zh-TW.md#回覆按鈕)。

## 沒人顧也活著

**Crash 恢復。** CLI 程序死掉時，daemon 會先把最近的訊息和工具活動做成快照、砍掉整棵 process tree（不留下孤兒 MCP server），然後用 `--resume` 試著把對話接回來。resume 失敗就開新的 session，把快照當成 context 注入進去。

連續 crash 會指數退避，五分鐘內 crash 三次就完全停止重生，而不是一直迴圈。

如果是 tmux server 自己死掉，所有 instance 會同時失去視窗。Fleet 會把它當成一次事故處理：第一次這種 crash 後重生暫停 30 秒，第二次 2 分鐘，第三次起 10 分鐘；instance 恢復之前不會把任何訊息貼進去。

**卡住偵測。** Instance 在一個回合中途畫面停住 10 分鐘（`hang_detector.timeout_minutes`），就會發一則帶兩個按鈕的通知：**強制重啟**，或**繼續等**。它也會出現在**等你處理**。

**換掉 instance。** Session 陷入迴圈或 context 被污染時，`replace_instance` 會原子性地換掉它：收集交接內容、停掉舊的、用同樣的設定和同一個 topic 建新的、把交接內容送過去。

**升級之後**，每個既有的 instance 在收到下一則訊息前會先收到一則簡短的「新功能」通知，列出跟 agent 有關的變更，讓接續的 session 知道哪些工具已經變了。

## 後端、模型與登入

- `/model` 和 `/effort` 用選單切換 instance 的模型和推理強度。
- `/backend` 把 instance 換到主機上已安裝的另一個 CLI 後端：後端 → 模型 → 推理強度 → 確認。Instance 只重啟一次，而且是新的 session — 對話不會跨後端延續。
- `/login` 不用 SSH 就能登入後端 CLI（沒裝的話先安裝）：Codex 和 Grok 會在聊天裡給 device code，Claude Code 和 Kiro CLI 會開一個一次性的瀏覽器終端機。
- **Credential profile** 讓 instance 有自己的登入 — 也就是第二個訂閱 — 支援 Kiro CLI、Codex 和 Claude Code（`backend_options.<backend>.credential_profile`）。`/usage` 和儀表板每個訂閱各一列。

詳細：[commands.md](https://github.com/songsid/AgEnD/blob/main/docs/commands.md)、[Credential profiles](https://github.com/songsid/AgEnD/blob/main/docs/configuration.zh-TW.md#credential-profiles同一-backend-的多個帳號)。

## 花費

設一個每日上限，fleet 會執行它：

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: Asia/Taipei
```

到警告門檻時 topic 裡會收到提醒。到上限時 instance 會被停下並通知 topic；要繼續就再啟動它。

在 General topic 打 `/status` 看錢花到哪去：

```
| instance | Backend | Model | Context | 推理強度 | 花費 | 執行狀態 |
```

每個 instance 一列。執行狀態欄把暫停、停止、當機和目前在做什麼合併顯示。

同樣的內容預設每天 21:00 會發一份摘要。

## Rate limit

列一個備用模型，主要模型額度快用完時 fleet 會換過去：

```yaml
instances:
  my-project:
    model_failover: [opus, sonnet]
```

5 小時用量到 90% 時，下一次啟動改用備用模型；回到 50% 以下就換回主要模型。兩次都會通知你。

排程觸發在 5 小時 rate limit 用超過 85% 時會自動延後。延後的那次會在額度重置後重試一次 — 不會跑兩次，也不會超過排程的下一次正常執行。

## 閒置的 instance

`auto_pause_after` 會在 instance 閒置滿指定分鐘數後暫停它。tmux 視窗保留、CLI 掛起，來訊息時約 30 秒醒來。正在產生回應的 instance 永遠不會被暫停。

`warm_cap` 限制同時常駐的 instance 數量。超過時，**最久沒動作的閒置** instance 會被暫停讓位 — 即使它自己的閒置計時還沒到。General instance 永遠不會被踢。

```yaml
defaults:
  auto_pause_after: 30
  warm_cap: 15
```

兩個都預設關閉（`0`），要自己設。

## 排程工作

Agent 自己建排程，存在 SQLite 裡，重啟後還在：

```
你：每天早上九點檢查有沒有等 review 的 PR
Agent：→ create_schedule(cron: "0 9 * * *", …)
```

排程觸發時，訊息會像你自己送的一樣抵達。每個 agent 都能替自己排程（heartbeat、提醒、「30 分鐘後回來看」），也能修改或刪除自己替自己建的排程。要替別的 agent 排工作，或修改別人設下的排程，需要 coordinator（`coordinator`、`general` 或 `full`）；`minimal` 則完全沒有排程功能。

在終端機用 [`agend schedule`](/AgEnD/zh-tw/docs/cli/#排程) 管理，或在儀表板的 **Fleet → 排程**。

## 從手機操作

**取消。** 訊息送到 agent 後，topic 或頻道裡會出現一個 🛑 Cancel 按鈕，按下就中斷生成；30 秒後它也會顯示 agent 已經做了多久。`/cancel` 效果一樣。Web 聊天則有 **Stop**。

**插話。** `/steer <訊息>` 直接插進 agent 目前的回合，不用等它做完（Claude Code、Codex、Grok、Muse 與經驗證的 Kiro TUI 版本；不支援的啟動模式會拒絕 `/steer`，請另送一般訊息）；`/btw <訊息>` 問個旁支問題而不打斷它（Claude Code）。

**送達狀態。** 你的訊息上的反應會顯示它走到哪一步。Discord：👀 已接收、⏳ 排隊中、✅ 已送達、❌ 失敗。Telegram 能用的反應比較少，所以送達前都是 👀，失敗是 👎。兩邊都能用 `status_emojis` 自訂。

**權限詢問**會變成按鈕 — 不用打開終端機就能同意或拒絕一次工具呼叫。

**語音訊息**在有設 `GROQ_API_KEY` 時會用 Groq Whisper 轉成文字。

## Discord

Discord 有兩種用法。論壇形式的 topic 跟 Telegram 一樣。或是用 **ClassicBot**，在任何一般文字頻道裡跑 agent：

| 指令 | 作用 |
|---|---|
| `/start` | 在這個頻道開一個 agent |
| `/chat <訊息>` | 跟它說話 |
| `/stop` | 停掉它 |

ClassicBot 管理員可以直接開。其他人要伺服器列在 `classicBot.yaml` 的 `defaults.allowed_guilds` 裡；否則 — 包括清單是空的時候 — 會先請 General 核准。改動每 30 秒生效。

## Team 與 template

**Team** 是可以一次對上的具名群組：

```yaml
teams:
  reviewers:
    members: [reviewer-a, reviewer-b]
```

**Template** 一個指令部署多個 instance，還可以順便註冊成一個 team。給 `branch` 時每個 instance 會有自己的 git worktree。沒給的話，每個角色都會用同一個專案目錄：第二個會被當成重複而拒絕，整個部署會回滾，所以有多個角色的 template 需要 `branch`。Agent 用 `deploy_template` 部署、`teardown_deployment` 拆掉。

## 觀察與匯出

**儀表板** — 見[上面](#web-儀表板)。`agend web` 讓你從主機登入；`agend view` 開啟 `/view`。

**Mirror topic** — 把 `mirror_topic_id` 指到某個 topic，跨 instance 的訊息會鏡像過去，你不用待在 agent 的 topic 裡也看得到它們在做什麼。

**HTML 匯出** — `agend export-chat` 把一段日期範圍（`--from`、`--to`）內的 fleet 活動寫成一個獨立的 HTML 檔。

## 更新

`agend update`（或在聊天裡 `/update`）會安裝你目前頻道上的最新版 — stable、`--beta` 或 `--alpha` — 然後重啟 fleet。見 [Beta 與 Alpha 更新頻道](https://github.com/songsid/AgEnD/blob/main/docs/features.zh-TW.md#beta-與-alpha-更新頻道-beta-and-alpha-update-channels)。

## 後端

| 後端 | 說明 |
|---|---|
| Claude Code | 整合最完整 |
| OpenAI Codex | 有原生輸入佇列；支援 session resume |
| Kiro CLI | `kiro_ui` 可選 legacy 或 tui；v3 尚未支援 |
| Antigravity CLI | 預設 MCP；設 `agent_mode: cli` 可改用 agend-agent 指令 |
| Grok Build | 需要 Grok CLI 1.0.13 以上（`grok update`） |
| Meta Muse Code | Escape 是取消；Ctrl+C 是離開 |
| OpenCode | |

每個後端都會透過自己的管道收到完整的 fleet 指示（system prompt 檔、`AGENTS.md`、它的 agent 設定）；MCP server 的 `instructions` 欄位只帶一份精簡的約定。見 [Fleet context 注入機制](https://github.com/songsid/AgEnD/blob/main/docs/configuration.zh-TW.md#fleet-context-注入機制)。

## 擴充

- **Webhook** — 卡住、MCP 或終端機故障、花費警告與上限、排程延後、模型切換時 POST 到你的網址，可帶自訂 header
- **Health endpoint** — 在 `health_port` 上開 HTTP，預設 19280
- **外部 session** — fleet 以外的程序可登錄 IPC 身分並使用允許的工具；登錄不代表能將訊息投遞進它自己的 CLI 對話
- **Adapter 外掛** — 不改 AgEnD 就能加新的聊天平台

## 限制

- 只支援 macOS 和 Linux。Windows 請用 WSL — [Windows 安裝程式](/AgEnD/zh-tw/install-windows/)會幫你裝好
- 全域 `enabledPlugins` 裡有官方 Telegram 外掛會造成 409 polling 衝突
- Agent 預設跳過權限確認在跑，除非你替 instance 設 `skipPermissions: false` — Antigravity 例外，它一律以 `--dangerously-skip-permissions` 啟動。把它指向你在乎的東西之前，先讀安全性說明
