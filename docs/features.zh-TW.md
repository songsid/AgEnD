# 功能 (Features)

## Fleet 模式 — 一個機器人，多個專案

每個 Telegram 論壇主題 (Forum Topic) 都對應一個獨立的 Claude Code session。建立主題、選好專案目錄，Claude 就會開始工作；刪除主題，instance 就會停止。機器撐得住多少專案，就能開多少個。

## 排程任務 (Scheduled tasks)

Claude 可以透過 MCP 工具建立 cron 排程。排程存在 SQLite 裡，daemon 重啟後依然有效。

```
使用者：「每天早上 9 點，檢查有沒有需要審查的 PR」
Claude：→ create_schedule(cron: "0 9 * * *", message: "檢查需要審查的 PR")
```

可用的 MCP 工具：`create_schedule`、`list_schedules`、`update_schedule`、`delete_schedule`

協作 MCP 工具：`list_instances`、`send_to_instance`、`start_instance`、`create_instance`、`delete_instance`

排程可以指定某個 instance，也可以指向建立它的 instance 自己。排程觸發時，daemon 會把訊息推給 Claude，就像使用者親自傳來的一樣。

## 當機復原 (Crash recovery)

AgEnD 會讀取 CLI 的狀態列 (status line) JSON 取得 context 用量（用於儀表板和日誌）。所有 CLI 後端（Claude Code、Codex、OpenCode、Kiro CLI、Antigravity CLI、Grok Build、Meta Muse Code）都內建 auto-compact，自己處理 context 上限，因此 AgEnD 不會因為 context 用量或 session 存在多久而觸發重啟。

CLI 程序當掉時，daemon 的健康檢查會發現 tmux 視窗已經不在，接著：

1. **快照** — 把最近的使用者訊息、工具活動和狀態列資料收集到 `rotation-state.json`
2. **清理程序** — 用 process group 訊號結束整棵程序樹（CLI 加上 MCP server），並依 PID 檔結束任何殘留的 MCP server
3. **嘗試 resume** — 用 `--resume` 恢復完整的對話歷史
4. **退而求其次** — resume 失敗時，開一個全新的 session，並把快照當作 context 注入
5. **退避** — 反覆當機時採指數退避；5 分鐘滑動視窗內當機 3 次以上就暫停重啟

### Fleet 層級的斷路器（storm window）

當 tmux server 本身掛掉或被換掉（而不只是單一視窗），所有 instance 會同時失去視窗。fleet 會把這當成單一事件，也就是一個 **storm window**，而不是 N 次各自獨立的當機：

- **第一次 server 當機就開啟。** 每觀察到一次「存活 → 死亡」的轉變（或 server PID 改變）才算一次死亡，不會因為有幾個 instance 回報就算幾次。
- **退避：** 第一次當機後，instance 的重啟會暫緩 30 秒；第二次暫緩 2 分鐘；第三次起暫緩 10 分鐘。視窗關閉後，fleet 連續平穩 10 分鐘，退避等級才會歸零。
- **投遞也會被擋下：** 退避期間，任何訊息都不會貼進任何 instance；復原期間，傳給受影響 instance 的訊息會等到該 instance 復原後才送。
- **復原：** 退避結束後 instance 會重啟；所有受影響的 instance 都復原、或滿 10 分鐘時，視窗關閉。視窗開啟期間，個別 instance 的事故通知（當機重啟、MCP 掛掉、卡住等）會先壓下，最後合併成一則事件回報。
- **`window_loss`：** server 正常，但 60 秒內有 4 個以上的 instance 失去視窗時，也算一個事件（代表主機或 tmux 層級出了問題）。這種情況不會暫緩啟動，但復原會以 storm 的節奏進行，而且只回報一次。

### 防止 MCP server 成為孤兒程序

CLI 程序結束時，它底下的 MCP server 子程序也該一起結束。這裡有三層保護：

1. **輪詢 ppid**（主要機制）— MCP server 每 5 秒檢查一次 `process.ppid`，一旦被改掛到 PID 1（代表父程序已死）就立刻結束。各平台都適用，也不受 macOS 上 libuv/kqueue 的 bug 影響。
2. **監聽 stdin EOF**（次要機制）— 監聽 stdin 的 `end`/`close`/`error` 事件。在 Linux 上可靠；在 macOS 上，libuv 遇到斷掉的 pipe 會空轉吃 CPU，所以不太可靠。
3. **依 PID 檔結束**（daemon 端）— MCP server 會把自己的 PID 寫進 `channel.mcp.pid`。當機重啟時，daemon 先讀這個檔，對殘留的孤兒送 SIGTERM，再啟動新的 CLI。

## Instance 替換 (Instance replacement)

instance 的 context 被汙染或陷入迴圈時，可以用 `replace_instance` 一次把它換成全新的 instance：

1. 從 daemon 的 ring buffer 收集交接用的 context（最近的訊息、事件、工具活動）
2. 停止舊 instance，保留它的設定
3. 用相同設定建立新 instance，沿用原本的 Telegram topic
4. 透過一般的訊息投遞路徑，把交接 context 送給新 instance

## Instance 暖機 (Instance warmup)

instance 啟動時，daemon 會把剛組好的 fleet 指示，和上次告訴 agent 的版本（記錄在 instance 目錄的 `prev-instructions`）做比對。**只有指示改變時才會暖機**；指示沒變的重啟什麼都不送，每次重啟能省下 agent 10 到 30 秒。

- 第一次啟動（還沒有任何紀錄）：只記錄指示，不送任何東西。
- Claude Code 在 resume 時會自己重讀指示，所以永遠不用通知它。
- 其他後端會收到一行通知，請它重新載入自己的指示檔（`AGENTS.md`、`.kiro/steering/agend-<name>.md`、`.agents/agents.md` 等）。如果沒有訊息在等，這則通知會延到下一則真正的訊息再一起送，免得 agent 平白回一段話；如果已經有投遞在排隊，daemon 會等到閒置，先貼上通知。

不需要任何設定。

## Instance 狀態圖示 (Instance status indicators)

`agend ls`（欄位為 Name、Backend、Status、Team、Src、Ctx、Mem、Activity）和聊天裡的 `/status` 指令，每個 instance 都只顯示一種狀態。這個狀態由 daemon 的執行狀態（idle / working / stuck / paused）和生命週期（running / paused / stopped / crashed）合併而成：

| 狀態 | `agend ls` | `/status` |
|---|---|---|
| 閒置 | 綠色 ● `Idle` | 🟢 |
| 工作中 | 藍色 ● `Working` | 🔵 |
| 卡住 | 紅色 ● `Stuck` | 🔴 |
| 當機 | 紅色 ● `Crashed` | 🔴 |
| 暫停 | 暗黃色 ○ `Paused` | ⏸ |
| 停止 | 灰色 ✗ `Stopped` | ✗ |

連不上 fleet API 時，`agend ls` 會退回依 pane 活動顯示 `Busy` / `Idle`。在 `/status` 裡，還沒有執行狀態快照的執行中 instance 會顯示 🟢 Running。

## Fleet /collab

讓 fleet topic 也能接收 bot 對 bot 的訊息和 webhook 訊息。某個 topic 開啟 `/collab` 後，其他 bot 和 webhook 傳來的訊息都會轉給該 instance，讓多個 bot 能在同一個 Telegram/Discord 頻道裡協作。

fleet 在 `open` 模式下，bot 訊息會自動通過過濾，不需要切換 `/collab`。

## 取消按鈕 (Cancel button)

訊息送到 agent 之後，它的 topic 或頻道裡會出現一個「🛑 Cancel」按鈕，按下去就會中斷目前的生成：

- **Telegram**：inline keyboard 按鈕
- **Discord**：按鈕元件
- **`/cancel` 指令**：效果相同，可以直接打字，也可以用 Discord 斜線指令

取消時送出的是各後端自己的中斷鍵：Kiro CLI 和 Grok Build 是 Ctrl+C，其他後端都是 Escape。agent 回覆時、按鈕被按下時、被更新的按鈕取代時，或 instance 進入閒置時，按鈕就會失效。

跨 instance 訊息和排程觸發也能取消。

這則按鈕訊息同時也是進度泡泡：30 秒後它會顯示 agent 已經工作多久，如果後端有回報，也會顯示它現在正在做什麼。

## 投遞狀態 (Delivery status)

投遞進度會以 reaction 的形式顯示在使用者自己的訊息上，隨著訊息往下走而替換：

| 狀態 | Discord（內建） | Telegram（內建） | 意義 |
|--------|--------------------|---------------------|---------|
| `received` | 👀 | 👀 | fleet 已收到訊息 |
| `queued` | ⏳ | 👀 | 等著交給 CLI（前面還有別的訊息，或 CLI 忙碌中、還在啟動） |
| `processing` | 👀 | 👀 | agent 已拿到訊息 |
| `delivered` | ✅ | 👀 | agent 已開始處理 |
| `failed` | ❌ | 👎 | 投遞失敗（例如視窗已經不在，重試次數也用完了） |

Telegram 只接受一組固定的 reaction，⏳、✅、❌ 都不在其中，所以它的內建值不一樣。

這些 emoji 可以用 `status_emojis` 依頻道或依 instance 自訂（見英文版 [configuration](configuration.md#channeloptionsstatus_emojis-discord-and-telegram)），其中也包括 `photo` 和 `attachment`，也就是 ClassicBot 存下照片或檔案時蓋上的戳記。

### Persona emoji

在有好幾個 bot 的頻道裡，每個 agent 都可以挑一個代表自己的 emoji，讓大家看得出是誰處理了訊息。這由三個 MCP 工具完成，內建的 `persona-emoji` skill 會一步步帶 agent 用它們：

- `list_emojis` — 這個 instance 能用的 emoji：平台的標準 emoji，以及在 Discord 上，它的 bot 能用來按 reaction 的伺服器 emoji。伺服器 emoji 只回傳值（除非加 `with_image_urls`，否則不附圖片網址），並可用 `name`（名稱片段）、`limit`（所有伺服器合計）和 `primary_only` 縮小範圍。在熱鬧的伺服器上，完整清單曾經多達約一萬字元，而 agent 只是想挑一個 emoji。
- `preview_emojis` — 下載最多 8 個伺服器 emoji，各回傳一個本機圖片路徑，讓 agent 先看過再挑。圖片網址由 fleet 依 emoji id 自己組出來，而且只保留小尺寸的 PNG。
- `set_persona_emoji` — 設定這個 instance 自己的 `delivered` 戳記（或它指定的其他狀態），檢查方式和 Settings 相同。

每種工具權限組合 (tool profile) 都能列出和預覽；除了 `minimal` 以外，也都能設定自己的戳記（`general` 從 2.1.9 起可以）。ClassicBot instance 能列出和預覽，但戳記要在 Settings 裡設定。這些工具永遠只會改動呼叫者自己的那一項。

### 貼圖 (Stickers)

agent 可以在 Discord 和 Telegram 傳送貼圖（2.1.12 起）。兩個平台上的工具用法相同，底層則各有各的做法：

- `list_stickers` — 這個 instance 在它說話的地方能傳的貼圖，每張是 `{ id, name, emoji_or_tags, format }`，不附圖片網址。**Discord：** 列出 instance 自己頻道所在伺服器的貼圖；bot 無法傳別的伺服器的貼圖，所以不會列出（Discord 的標準貼圖包也不列）。**Telegram：** 貼圖放在貼圖包裡，任何聊天都能用，所以呼叫時要指定 `set`（`t.me/addstickers/<name>` 裡的 `<name>`），或列出這條連線的 [`options.sticker_sets`](configuration.md#channeloptions-telegram)。可以用 `name` 和 `limit` 縮小範圍。
- `preview_stickers` — 從 `list_stickers` 的結果裡下載最多 8 張貼圖，各回傳一個本機圖片路徑供讀取。只有 `list_stickers` 回傳過的貼圖才能預覽。Discord 的 Lottie 貼圖，或沒有縮圖的 Telegram 動態貼圖，沒有靜態圖可看，會標成 `preview_unavailable`。在 Telegram 上，下載是在 adapter 裡完成的，所以檔案網址裡的 bot token 不會離開 adapter。
- **傳送：** `reply` 接受 `stickers`（最多 3 個，取自 `list_stickers` 的 id），這時 `text` 可以省略。**Discord** 會把貼圖和文字放在同一則訊息（文字很長時放在最後一段）。**Telegram** 先送文字，再一張接一張送貼圖。送出任何東西之前都會先檢查貼圖：在 Discord 上，它必須是回覆目標伺服器裡可用的貼圖，所以別的伺服器的貼圖會直接回錯誤，而不是送出一則悄悄少了貼圖的回覆。貼圖永遠不會寫在文字裡，文字裡的 id 就只是文字。
- 在 CLI 上，`agend-agent stickers [set] [--name …] [--limit …]`、`agend-agent sticker-preview <id…>` 和 `agend-agent reply <text> --sticker <id>` 可以做到同樣的事。

不支援上傳貼圖或建立貼圖包。

## 工具進度（`tool_progress`）

`tool_progress` 會把 agent 的工具活動加進進度泡泡，以這一輪的累積清單呈現：

| 值 | 顯示內容 |
|---|---|
| `off`（預設） | 只有經過時間 |
| `standard` | 語意標籤（例如 `npm test` 顯示為 `🧪 執行測試`），絕不顯示 shell 參數 |
| `verbose` | 同樣的標籤，再加上截短的指令預覽 |

這個功能要自己開啟，因為進度泡泡會把活動廣播到頻道裡；張貼之前會先遮蔽憑證（API key、token、bearer header、`password=` 這類指派等）。進度泡泡失效後，清單會留下來，成為唯讀的工具歷程。可以依 instance、在 `defaults` 裡，或依 ClassicBot 頻道設定。

## 回覆完成守衛（`reply_completion_guard`）

人類傳來的訊息必須透過 `reply`（或 `react`）工具回覆；agent 只印在自己終端機裡的文字，永遠到不了聊天室。在 Claude Code 上，回覆完成守衛會發現「面向人類的這一輪已經結束，卻沒有送出任何回覆」的情況：

- 它會等到 instance 確實處理過這一輪、而且接著閒置滿 60 秒才判斷，所以這一輪中途的停頓不會被誤認為結束。
- 接著它會提醒 agent 一次，請它用 `reply` 或 `react` 送出結論，不必重做一遍。
- 如果 agent 嘗試過回覆但結果不明（可能已經送出、只是逾時），守衛不會重試，所以你不會收到兩次答案；聊天室裡會出現一則簡短通知，說明這則回覆無法確認。

預設開啟（`reply_completion_guard: true`）；要關掉，就依 instance、在 `defaults` 裡，或依 ClassicBot 頻道設為 `false`。其他後端沒有這個功能。

## 點對點 Agent 協作 (Peer-to-peer agent collaboration)

每個 instance 都是平等的對等節點，可以找到、喚醒、建立其他 instance，也能傳訊息給它們。不需要中央調度器，協作是從每個 agent 手上的工具自然形成的。

**核心 MCP 工具：**

- `list_instances` — 找出所有已設定的 instance（執行中或已停止），附上狀態、工作目錄和最後活動時間
- `send_to_instance` — 傳訊息給另一個 instance 或外部 session；支援結構化的 metadata（`request_kind`、`requires_reply`、`correlation_id`、`task_summary`）
- `start_instance` — 喚醒已停止的 instance，好讓你傳訊息給它
- `create_instance` — 建立新 instance 和它的 topic（目錄可省略；省略時自動建立 `~/.agend/workspaces/<name>`）；支援用 `branch` 建立 git worktree 隔離
- `delete_instance` — 移除 instance 和它的 topic
- `replace_instance` — 把 instance 換成全新的（交接 + 刪除 + 建立）
- `describe_instance` — 取得某個 instance 的詳細資訊（描述、模型、最後活動）
- `set_display_name` — 設定顯示名稱，會出現在訊息、活動紀錄與其他 agent 看到的地方
- `set_description` — 設定角色描述，會注入 agent 的系統提示，下次 session 重啟後生效

**高階協作工具**（優先使用這些，而不是直接用 `send_to_instance`）：

- `request_information` — 向另一個 instance 提問並等它回覆（`request_kind=query`、`requires_reply=true`）
- `delegate_task` — 把工作連同成功標準交給另一個 instance（`request_kind=task`、`requires_reply=true`）
- `report_result` — 把結果交回給請求者，並帶回 `correlation_id`，讓回應能對上原本的請求

**Team 工具**（以一群 instance 為對象）：

- `create_team` — 定義一個有名字的 instance 群組
- `list_teams` — 列出所有 team 和成員詳情
- `update_team` — 新增或移除成員，或更新描述
- `delete_team` — 移除 team 定義
- `broadcast(team: "name", ...)` — 傳訊息給某個 team 的所有成員

一個 instance 傳訊息給另一個時，目標的 topic 會出現通知：`sender → receiver: summary`。為了減少雜訊，General Topic instance 不會收到這類通知。

如果你對已停止的 instance 執行 `send_to_instance`，錯誤訊息會提示先用 `start_instance()`，agent 不需要人介入就能自己修正。

### 投遞追蹤（`delivery_status`）

跨 instance 的傳送只要 fleet 一接手就會立刻回傳（`{ sent, queued }`，附上 `operation_id` / `delivery_id`）；之後由 fleet 透過持久化的 outbox 負責投遞。`delivery_status` 可以查出某次投遞進行到哪裡，查詢時要剛好指定 `delivery_id`、`operation_id`、`correlation_id` 或 `message_id` 其中之一（可用 `limit` 分頁，最多 100 筆，搭配 `cursor`）。一筆紀錄會經過 `queued`、`delivering`、`submission_started`、`reconciliation_pending`、`retry_wait`，最後變成 `delivered`、`failed`、`uncertain` 或 `cancelled`。`uncertain` 代表訊息可能已經送達，不要貿然重送。

每筆紀錄也會說明它怎麼被投遞、到了 CLI 之後怎麼了（#1201）：
- `delivery_mode`：`steer`（插進進行中的回合）或 `idle_queue`（作為下一則訊息），與 `send_to_instance` 回報的一致。
- `submission_mode`：最近一次嘗試的寫入方式：`idle_submit`、`steer`、`native_queue_handoff`（交給忙碌中 CLI 自己的佇列）或 `raw_paste`。
- `consumed_at` / `consumed_via`：steer 或交給原生佇列的訊息，早在模型讀到之前就已被 CLI 收進輸入；Claude Code 會在下一個工具結束時或回合結束時才取用。當 CLI 的 transcript（claude-code、codex）顯示這則投遞自己的 marker 被取用，就記下時間，以及它是作為自己的回合（`turn`）還是併入進行中的回合（`mid_turn`）。這也是唯一能把 `uncertain` 變成 `delivered` 的情況；此時尚未寄給寄件者的失敗通知會被撤回。找不到 marker 絕不改變任何紀錄。

instance 只看得到自己送出或收到的紀錄（身分取自它自己的 socket 或 token，絕不取自參數）。用收到的訊息的 `message_id` 去查，就能確認同伴傳來的訊息真的經過 fleet：回傳「Delivery not found」就代表不是。每種工具權限組合都有 `delivery_status`，連 `minimal` 也有。

### `awaiting_input`

`list_instances` 和 `describe_instance` 會回報 `instance_state`。除了執行狀態（`idle`、`working`、`stuck`、`paused`）之外，它也可能是 `awaiting_input`：CLI 正顯示一個在等人處理的提示，例如權限請求、危險指令確認、登入畫面或其他對話框，而且這個觀察是新的（不到 15 秒）、已經確認而不只是懷疑。另外的 `execution_state`、`interaction` 和 `interaction_summary` 欄位帶有細節。它只用於呈現，不會回饋到 fleet 自己的狀態或任何閘門。

### Fleet context 系統提示 (Fleet context system prompt)

啟動時，每個 instance 都會自動收到一段 fleet context 系統提示，告訴它：

- 它自己的身分（`instanceName`）和工作目錄
- 完整的 fleet 工具清單和用法
- 協作規則：怎麼處理 `from_instance` 訊息、什麼時候要帶回 `correlation_id`、範圍意識（絕不假設能直接存取另一個 instance 的 repo 檔案）

所以 instance 從第一則訊息起就知道自己在 fleet 裡的角色，不需要任何手動設定。

## 任務看板 (Task board)

一份全 fleet 共用的任務清單，存在 fleet 的 SQLite 資料庫裡，透過單一個 `task` 工具操作：

- `task(action: "create")` — 建立新任務，帶 `title`，以及選填的 `description`、`priority`（`low` / `normal` / `high` / `urgent`）、`assignee` 和 `depends_on`（任務 ID）。
- `task(action: "claim")` — 把一個 `open` 的任務指派給自己。相依的任務還沒全部 `done` 的話，就不能認領。
- `task(action: "done")` — 把自己認領的任務標成完成，可附上 `result`。只有 `claimed` 的任務能完成。
- `task(action: "update")` — 變更 `status`（`open` / `claimed` / `done` / `blocked` / `cancelled`）、`priority`、`assignee` 或 `result`。
- `task(action: "list")` — 列出所有任務，最緊急的排最前面；可用 `filter_assignee` 和 `filter_status` 縮小範圍。

建立、認領和完成任務都會寫進活動日誌。除了 `minimal` 以外，每種工具權限組合都有 `task`。

## 決策 (Decisions)

決策是比一段對話活得更久的規則和慣例。`post_decision` 用 `title` 和 `content` 記錄一條決策，可選填 `tags`、`ttl_days`（多少天後封存，預設永久保留），以及用 `supersedes` 取代較舊的決策。`scope: "project"`（預設）只讓同一個目錄下工作的 instance 看到；`scope: "fleet"` 則讓所有 instance 看到。`list_decisions` 回傳仍有效的決策（可用 `include_archived`、`tags` 篩選），`update_decision` 則用來修改或封存決策。後者是 coordinator 動詞，因為它會改到別人記下的東西。

有效的決策會在 instance 啟動時注入它的指示。fleet 範圍的決策也必須相關才會注入：沒有綁定專案的全域決策，或來自同一個專案、或其 worktree/checkout 的決策。General instance 會拿到所有 fleet 範圍的決策，因為它負責在專案之間分派工作。

## 檢出其他 repo（`checkout_repo`）

`checkout_repo(source, branch?)` 會把另一個 repository 以 detached git worktree 的形式掛在 instance 自己的目錄下（`<instance dir>/repos/<repo>-<branch>`），並回傳它的 `path`、`branch`、`source` 和簡短的 `commit`。這樣 agent 就能閱讀另一個專案，又不會碰到那個 instance 的工作目錄（它是另一個 worktree；並沒有強制唯讀）。`source` 必須是指向 git repository 的絕對路徑或以 `~` 開頭的路徑（可用 `describe_instance` 查出 repo 的 `working_directory`）；`branch` 預設為 `HEAD`，而且必須是單純的 ref 名稱。`release_repo(path)` 會移除用這個方式建立的 worktree，而且只限 instance 自己 `repos/` 目錄下的。兩者都是 worker 工具。

## General Topic instance

綁定到 Telegram General Topic 的一般 instance。它在 fleet 啟動時自動建立，作為不屬於特定專案的任務的自然語言入口。它的行為完全由它專案裡的 `CLAUDE.md` 決定：

- 簡單任務（網路搜尋、翻譯、一般問題）— 直接處理
- 特定專案的任務 — 用 `list_instances()` 找到對的 agent，必要時先 `start_instance()`，再用 `send_to_instance()` 委派
- 新專案的請求 — 用 `create_instance()` 建立新的 agent

在 General topic 裡用 `/status` 可以看 fleet 概況。其他專案管理工作，都由 General instance 透過自然語言處理。

## 外部 session 支援 (External session support)

只要把 `.mcp.json` 指向某個 instance 的 IPC socket，就能把本機的 Claude Code session 接上 daemon 的頻道工具（reply、send_to_instance 等）：

```json
{
  "mcpServers": {
    "agend": {
      "command": "node",
      "args": ["path/to/dist/channel/mcp-server.js"],
      "env": {
        "AGEND_SOCKET_PATH": "~/.agend/instances/<name>/channel.sock"
      }
    }
  }
}
```

daemon 會用分層的環境變數，自動把外部 session 和內部 session 區隔開：

| Session 類型 | 身分來源 | 範例 |
|---|---|---|
| 內部（daemon 管理） | 透過 tmux 環境的 `AGEND_INSTANCE_NAME` | `ccplugin` |
| 外部（自訂名稱） | `.mcp.json` env 裡的 `AGEND_SESSION_NAME` | `dev` |
| 外部（零設定） | 退回 `external-<basename(cwd)>-<pid>` | `external-myproject-48213` |

內部 session 的 `AGEND_INSTANCE_NAME` 由 daemon 注入 tmux 的 shell 環境。外部 session 沒有這個變數，所以會退回 `AGEND_SESSION_NAME`（有設定的話），否則就用工作目錄加上 MCP server 的 PID 自動產生名稱，同一個專案裡的兩個 session 才不會撞名。因此同一份 `.mcp.json` 在內部和外部 session 會得到不同的身分，不會有設定衝突。

外部 session 會出現在 `list_instances` 裡，也可以當作 `send_to_instance` 的目標。

## 工具權限組合 (Tool profiles)

agent 能做什麼，由每個 instance 的 `tool_set` 決定，而且是由 fleet 強制執行，不是看模型被展示了哪些工具。重要的權限組合有三種：

| 權限組合 | 怎麼取得 | 內容 |
|---|---|---|
| `worker` | **預設** | 和人與同伴對話、讀取 fleet 狀態、完成工作。包括 `reply`、`send_to_instance`、`broadcast`、`report_result`、`request_information`、`delegate_task`、`delivery_status`、`task`、`post_decision`、`checkout_repo` / `release_repo`，以及所有唯讀查詢，其中也有 `list_schedules` 和 `list_deployments`，所以看得到有哪些東西，但不能更改。從 2.1.6 起，它也能建立和修改以自己為目標的排程（#896），還能列出、預覽並設定自己的 persona emoji，以及列出和預覽貼圖。共 38 個工具。 |
| `coordinator` | `tool_set: coordinator` | worker 有的全部，再加上管理 fleet 的動詞：建立／刪除／替換／啟動／停止／重啟／喚醒 instance、部署和拆除模板、team 的增刪改查、建立和修改排程、`update_instance_config`、`update_fleet_defaults`、`update_decision`。 |
| `full` | `tool_set: full` | AgEnD 的所有工具。 |

**`coordinator` 和 `full` 目前是同樣的 54 個工具**，差別在於意義，而不是內容。`coordinator` 表示「這個 agent 負責管理 fleet」，日後若發現某個動詞不屬於這裡，就會把它收窄；`full` 表示「不管怎樣都給它全部」，也是舊版預設值的名字。想讓 agent 擔任協調者，就寫 `coordinator`；為了拿到*更多*而選 `full`，什麼也不會多，反而會錯過之後所有的調整。

`standard`（29 個工具）和 `minimal`（9 個）仍然存在。`minimal` 在 2.1.9 加入了 `list_emojis` 和 `preview_emojis`，在 2.1.12 加入了 `list_stickers` 和 `preview_stickers`。**`general` 是一種身分，不是可以自己挑的權限組合**：它會指派給設定了 `general_topic: true` 的 instance，手動寫上會通不過驗證，因為兩種成為 General 的途徑遲早會互相矛盾。

`delegate_task` 刻意設計成 worker 工具。它不建立任何東西、不刪除任何東西，而且目標必須已經存在，所以一般 agent 可以把工作交給同伴，卻不能自己生出一個同伴。

### 為什麼由 fleet 決定，而不是看工具清單

以前，收窄權限組合的意思是模型看到的工具比較少，但這不等於它無法使用那些工具。要呼叫 fleet 工具有四條路，其中只有一條會參考那份清單：在 `tools/call` 裡直接指名工具照樣有效；寫入 instance 自己的 socket 則完全繞過 MCP server；`POST /agent` 會檢查*是哪個* instance 在呼叫，卻從不檢查它有沒有權限。現在權限在這些路徑匯合的地方判斷，所以權限組合是一道真正的邊界，而不只是建議。

被拒絕的呼叫會說明原因：哪個工具、instance 用的是哪個權限組合，以及兩條出路（回報你需要什麼，或請人把你標成 `coordinator`），因為 agent 會把這段錯誤當成下一步的指示來讀。

### 指定 coordinator

```yaml
instances:
  team-lead:
    working_directory: /home/you/projects/app
    tool_set: coordinator
```

升級後第一次啟動時，AgEnD 會讀取最近三十天的活動，列出實際用過 worker 已拿不到之工具的 instance，以及使用次數。它絕不會修改你的設定：哪些 agent 負責協調，是你怎麼組織 fleet 的決定；明確寫上的 `tool_set: full` 也會原封不動保留。

**目前只能透過 Settings 或直接編輯 `fleet.yaml` 設定**：General 的 `update_instance_config` 還沒有 `tool_set` 欄位，從那裡送出的值會被丟掉。

## 權限系統 (Permission system)

使用 Claude Code 原生的權限轉送 (permission relay)：權限請求會以 inline 按鈕（Allow/Deny）轉到 Telegram。Claude 要使用敏感工具時，daemon 會在 Telegram 上問你，等你回應後才繼續。

權限提示會顯示每 30 秒更新一次的倒數計時。「Always Allow」按鈕可以讓你在目前的 session 裡核准某個工具之後的所有使用。你回應後，決定會直接顯示在訊息裡（「✅ Approved」/「❌ Denied」）。

## 語音轉文字 (Voice transcription)

Telegram 語音訊息會透過 Groq Whisper API 轉成文字再送給 Claude。topic 模式和私訊 (DM) 模式都適用。需要在 `.env` 設定 `GROQ_API_KEY`。

## 動態 instance 管理 (Dynamic instance management)

instance 由 General instance 透過 `create_instance` 建立。這是 coordinator 工具，所以一般 worker 不能建立 instance（見[工具權限組合](#工具權限組合-tool-profiles)）。告訴 General instance 你想做哪個專案，它就會建立 Telegram topic、綁定專案目錄，並自動啟動 Claude。建立時也可以加 `--branch`，產生一個 git worktree 來隔離功能分支。刪除 topic 會自動解除綁定並停止 instance；要連 topic 一起完全移除，請用 `delete_instance`。

## 花費防護 (Cost guard)

無人看管時，避免收到嚇人的帳單。在 `fleet.yaml` 設定每日花費上限：

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: "Asia/Taipei"
```

instance 接近上限時，會在它的 Telegram topic 發出警告；達到上限時，instance 會自動暫停並發出通知。暫停的 instance 會在隔天，或有人手動重啟時恢復。

## Fleet 狀態 (Fleet status)

在 General topic 用 `/status` 看即時概況。它是一張表格，每個 instance 一列：

```
| Instance | Backend | Model | Ctx | Effort | Cost | State |
```

State 欄把暫停、停止或當機和執行狀態合併顯示（見 [Instance 狀態圖示](#instance-狀態圖示-instance-status-indicators)）；Model 是目前實際使用的模型，和 `/ctx` 回報的相同。`/status` 是給 fleet 管理員用的。（IPC 欄已在 2.1.9 移除。）

## 診斷與各 agent 的聊天指令 (Diagnostics and per-agent chat commands)

除了 `/status`，下面這些指令也能在聊天裡使用（Discord 上是斜線指令；Telegram 上，全 fleet 層級的指令在 General topic 回應）。每個指令誰能用，請見英文版 [commands](commands.md)。

- **`/usage`**（所有人）— 這台機器上已登入之 CLI 的 AI 訂閱用量：Claude、Codex、Muse、Grok、Kiro 和 Antigravity。設定了[憑證 profile](#憑證-profile-與第二份訂閱-credential-profiles-and-a-second-subscription) 的後端，每份訂閱各佔一列。agent 可以用 `get_usage` 讀取同樣的資料。
- **`/doctor`**（fleet 管理員）— 健康診斷，分成六個區塊：Prerequisites、Service、Fleet、Channel gateways、MCP IPC 和 Resources，每項檢查的結果是 `ok`、`warn` 或 `error`。
- **`/sysinfo`**（所有人）— fleet 的運行時間和記憶體、instance 數量、系統記憶體，以及每個後端 CLI 的版本。
- **`/model`**（頻道管理員）— 從選單切換 instance 的模型（Telegram 上也可以用 `/model <name>`）。
- **`/effort`**（頻道管理員）— 設定推理強度（`low` / `medium` / `high` / `xhigh` / `max`，會限制在後端接受的範圍內）。Claude Code、Grok、Antigravity 和 Muse 可以在執行中直接更改；Kiro CLI 和 Codex 要重啟 instance 才會生效；OpenCode 沒有推理強度設定。agent 可以用 `get_effort` 讀取。

## 每日摘要 (Daily summary)

每天會在可設定的時間（預設 21:00）把報告發到 General topic：

```
📊 Daily Report — 2026-03-26

proj-a: $8.20, 2 restarts
proj-b: $2.10
proj-c: $0.00 ⚠️ 1 hang

Total: $10.30
```

## 卡住偵測 (Hang detection)

instance 連續 15 分鐘（可設定）沒有任何活動時，daemon 會發出附 inline 按鈕的通知：

- **Force restart** — 停止並重啟 instance
- **Keep waiting** — 關閉這則警示

它採用多重訊號偵測：同時檢查對話紀錄的活動和狀態列是否仍在更新，避免在長時間執行的工具呼叫期間誤報。

## 感知頻率限制的排程 (Rate limit-aware scheduling)

5 小時 API 頻率限制的用量超過 85% 時，排程觸發會自動延後，而不是照常執行，並在 instance 的 topic 發出通知。延後的排程不會遺失，會在頻率限制回到門檻以下後的下一個 cron 時間點執行。

## 模型備援切換 (Model failover)

主要模型碰到頻率限制時，daemon 會在下一次 session 重啟時自動改用備用模型。在 `fleet.yaml` 設定備援順序：

```yaml
instances:
  my-project:
    model_failover: ["opus", "sonnet"]
```

發生切換時，daemon 會在 Telegram 通知你；頻率限制恢復後，會再切回主要模型。

## 平順重啟 (Graceful restart)

`agend fleet restart` 會對 fleet manager 送出 SIGUSR2。它會等所有 instance 都進入閒置（對話紀錄 10 秒沒有活動），再逐一重啟。另有 5 分鐘的逾時，避免被卡住的 instance 拖住。

## Topic 圖示與閒置封存 (Topic icon + idle archive)

執行中的 instance 在 Telegram 上會有圖示標示；instance 停止或當機時，圖示會跟著改變。閒置的 instance 會自動封存，對封存的 topic 傳訊息就會自動重新開啟。

## Daemon 端重啟快照 (Daemon-side restart snapshot)

每次 context 重啟前，daemon 會儲存一份 `rotation-state.json`，內容包括最近的使用者訊息、工具活動、context 用量和狀態列資料。下一個 session 會在系統提示裡收到這份快照，不必靠 Claude 自己寫交接報告也能接續下去。

## 服務訊息過濾 (Service message filter)

Telegram 的系統事件（topic 改名、置頂、成員加入等）會在送到 Claude 之前被濾掉，節省 context 視窗的 token。

## 健康檢查端點 (Health endpoint)

供外部監控工具使用的 HTTP 端點，位於 fleet 的 web server 上：

```
GET /health  → { status, uptime, instances: { configured, running, crashed, paused, stopped },
                 adapters: { total, connected, states, details }, startupComplete,
                 memory, hostMemory, problems: [ ... ] }
GET /status  → { instances: [{ name, status, context_pct, cost }] }
```

`/health` 不需要 token。它的 `status` 有三種：

- `ok` — 所有檢查都通過：至少一個頻道 adapter 已連線、沒有 instance 當機、啟動已完成（在 Linux 上還要沒有主機記憶體壓力）；
- `degraded` — 連得到，但有地方需要看一下（adapter 正在重試、有 instance 當機、啟動尚未完成、記憶體有壓力）；`problems` 會說明是什麼；
- `down` — 有設定 adapter，卻一個都沒連上，所以收不到也回不了任何訊息。

只要不是 `ok`，就回應 **HTTP 503**，一般的 HTTP 監控就能察覺。（以前不論實際狀態如何，都回 200 `ok` 加上已設定的 instance 數量。）

`/status` 需要 web token（`X-Agend-Token` header 或儀表板的 session cookie）。`cost` 是 instance 狀態列裡的 `cost.total_cost_usd`（Claude Code 會寫這個值；其他後端回報 0）。

在 `fleet.yaml` 設定：

```yaml
health_port: 19280  # 頂層設定，預設 19280，綁定 127.0.0.1
```

## Webhook 通知 (Webhook notifications)

把 fleet 事件推送到外部端點（Slack、自訂儀表板等）：

```yaml
defaults:
  webhooks:
    - url: https://hooks.slack.com/...
      events: ["restart", "hang", "cost_warn"]
    - url: https://custom.endpoint/ccd
      events: ["*"]
```

## Discord adapter

把你的 fleet 接上 Discord，取代 Telegram 或與它並用。

### 支援的功能

- **Topic 模式**：每個 instance 對應「AgEnD Agents」分類（可用 `options.category_name` 改名）底下的一個文字頻道，另有一個 General 頻道。
- **ClassicBot**：在任何文字頻道打 `/start`，它就變成 agent 頻道；`/stop` 則移除。`/start` 之後預設開啟 collab 模式，只有 @ 這個 bot 才會觸發 agent。
- **同一個伺服器放多個 bot**：每個 bot 是 `channels[]` 裡獨立的一項；bot 只回應提到自己的訊息，絕不替別的 bot 回答。
- **斜線指令**：共 25 個，包括 `/chat`、`/steer`、`/btw`、`/cancel`、`/ctx`、`/compact`、`/model`、`/effort`、`/dashboard`、`/usage`、`/login`；需要管理員權限的會標上 🔒（這個標記和實際執行權限檢查的是同一張表產生的）。
- **按鈕與選單**：權限核准（Allow / Always / Deny）、後端選單、取消，以及 hang / model / effort 選擇器。
- **Reaction**：對 bot 訊息按的 reaction（包括其他 bot 按的）會轉給 agent；投遞狀態戳記可依 instance 或頻道設定；persona emoji 可以用伺服器 emoji。
- **附件**：圖片、檔案和音訊都會下載；轉傳的訊息會保留圖片；回覆一張圖片時會把那張圖一起帶上。
- **長訊息**會以 2000 字元切分，不會切斷 code fence；斜線指令的長回覆改用 embed。
- **穩定性**：gateway watchdog 會把停滯的連線重新接上，共用的送訊佇列遇到頻率限制會自動退避。

### 設定步驟

Discord 支援已內建在核心套件中，不需要額外安裝。

1. **建立 Discord bot**，前往 [Discord Developer Portal](https://discord.com/developers/applications)：
   - 建立新的 Application → Bot
   - 啟用 **Privileged Gateway Intents**：Presence Intent、Server Members Intent、Message Content Intent
   - 產生邀請網址，scope 選 `bot`，權限選 `Send Messages`、`Read Message History`、`Manage Channels`
   - 把 bot 邀請到你的伺服器

2. **執行 quickstart**（或 9 步驟的 `agend init`；兩者都會問你要用 Telegram 還是 Discord）：
   ```bash
   agend quickstart    # 出現提示時選擇 "Discord"
   ```

3. **或手動設定** `fleet.yaml`：
   ```yaml
   channel:
     type: discord
     mode: topic           # 選填，預設就是 topic
     bot_token_env: AGEND_DISCORD_TOKEN
     group_id: "123456789012345678"   # Discord snowflake ID 要加引號，避免精度遺失
     access:
       mode: locked
       allowed_users:
         - "your_discord_user_id"     # user ID 也要加引號
   ```

4. **設定 bot token**，寫進 `~/.agend/.env`：
   ```
   AGEND_DISCORD_TOKEN=your_bot_token_here
   ```

### 疑難排解

- **訊息內容是空的：** 到 Discord Developer Portal → Bot → Privileged Gateway Intents 啟用 **Message Content Intent**。
- **ID 精度遺失：** YAML 裡的 Discord ID（guild ID、user ID）一律加引號。它們是 64 位元的 snowflake，超出 JavaScript 整數的精度。
- **MCP 導致啟動很慢：** 如果後端 CLI 因為連接 MCP server 而啟動逾時，可以在 `fleet.yaml` 調高逾時：
  ```yaml
  defaults:
    startup_timeout_ms: 60000   # 預設：25000（25 秒）
  ```
- **`registerBotCommands` ETIMEDOUT：** 這不是致命錯誤，bot polling 照樣會啟動。網路不穩時會出現。
- **找不到 `working_directory`：** 從 v1.19 起目錄會自動建立。如果還是看到這個錯誤，請更新到最新版。

## 外部 adapter 外掛系統 (External adapter plugin system)

社群 adapter 可以用 npm 安裝，並自動載入：

```bash
npm install agend-plugin-slack
```

遇到非內建的 `channel.type` 時，daemon 不會掃描 adapter，而是依序嘗試 import `@songsid/agend-plugin-<type>`、`@suzuke/agend-plugin-<type>`、`agend-plugin-<type>`、`agend-adapter-<type>`，最後才是裸名稱 `<type>`（`src/channel/factory.ts`）。頻道相關的型別由套件進入點匯出，供 adapter 作者使用。

## Kiro CLI 後端 (Kiro CLI backend)

支援 AWS Kiro CLI 作為後端（`backend: kiro-cli`）。支援 session 恢復、MCP 設定，以及這些模型：`auto`、`claude-sonnet-4.5`、`claude-haiku-4.5`。在 `fleet.yaml` 的設定方式和其他後端相同。

### 啟動韌性（kiro）

Kiro 的 `--resume` 要先和它的後端來回一趟才會畫出任何東西，所以 `runtime.*.kiro.dev` 變慢或連不上時，以前看起來就像 CLI 死掉了。從 v2.1.4 起，daemon 會：

- 給 kiro 的 **resume** 啟動 60 秒的預算（全新啟動維持預設的 25 秒；較大的 `startup_timeout_ms` 不會被調低）；
- 清除 session 前先**再 resume 一次**，後端慢不再賠上整段對話（最多 2 次 resume 加 1 次全新啟動）；
- 把 kiro 的 `dispatch failure (timeout) … kiro.dev` 輸出認定為**全 fleet 的後端故障**：每次故障只在 General topic 發一則通知，而不是每個 instance 各一則；故障期間 resume 失敗會保留 session、讓這次啟動失敗，而不是改成全新啟動；
- **自動重試啟動失敗的 instance**：在 1、5、15 分鐘後重試（後端仍故障時之後每 15 分鐘一次，最多 6 次），會經過 spawn gate，而且 tmux storm 期間絕不重試。只會發一則彙整的「N instances failed to start」通知，真的放棄時再發一則「gave up」通知。執行 `agend start` / `/restart` 會取代待執行的重試。

resume 預算、resume 重試和故障短路只針對 kiro（屬於後端能力）。延遲的自動啟動重試則適用於**所有**後端和所有無人值守的啟動路徑（fleet 啟動含 General、完整重啟、設定 reconcile）：啟動失敗後就永遠停在 `stopped`，本來就不是 kiro 才有的問題。明確執行的 `agend start` / API 啟動仍會同步回報錯誤。被自動暫停的 kiro instance 喚醒時，也使用同樣的 60 秒 resume 預算。

### 固定 UI 與引擎（`kiro_ui`、`kiro_engine_status`）

`kiro_ui` 決定 kiro instance 的啟動方式：`legacy`（預設）以 kiro 的 legacy UI 搭配 v1 agent 引擎執行（`--legacy-ui --agent-engine=v1`），`tui` 則以它的終端機 UI 搭配 v2 引擎執行（`--tui --agent-engine=v2`）。每次啟動都會明確帶上這兩個旗標，所以 kiro-cli 的預設值或儲存的設定都無法把 instance 換到另一個引擎上，否則它的對話不會跟過去。如果安裝的 kiro-cli 已經跑不了 instance 固定使用的組合，AgEnD 會拒絕啟動並說明原因，而不是讓 kiro 自己挑（#1109）。`kiro_ui: v3` 在 kiro 的 v3 介面能無人值守執行之前，都會被驗證擋下（#849）。

`kiro_engine_status`（除了 `minimal` 以外每種權限組合都有的唯讀工具）會針對每個 kiro instance 和 ClassicBot 頻道，顯示它的 `kiro_ui`、下次啟動會用的引擎旗標（或 kiro-cli 會拒絕的原因）、歷次啟動紀錄（每次變動時的 kiro-cli 和 AgEnD 版本）、它的 V3 session，以及它的憑證 profile。它讀的是 AgEnD 在上次啟動時記錄的內容，自己從不執行 kiro-cli。

## agend quickstart

簡化成 4 個問題的設定精靈，專為新使用者設計。它會自動偵測已安裝的後端、透過 `getUpdates` 輪詢自動找出 Telegram 群組 ID，並產生一份帶有合理預設值的精簡 `fleet.yaml`。它取代 9 步驟的 `agend init`，成為建議的入門方式。

## Web Dashboard

Fleet 會在 `127.0.0.1`（`health_port`，預設 19280）提供網頁儀表板。其中的 `/ui` 就是**網頁聊天**：選一個 instance，就能在瀏覽器裡跟它對話。這和那個 instance 在 Telegram 或 Discord 上的是同一段對話：從網頁送出的訊息會以 `🌐 web-user: …` 出現在 topic，Agent 的回覆兩邊都看得到。可以傳檔案和圖片（📎、貼上或拖進來）、按 Stop，也看得到每則訊息送到哪一步；沒有設定任何聊天平台的 fleet，也能只靠儀表板操作。`/view` 是以檢視為主的總覽，`/settings` 是 fleet 設定。

用一次性登入碼登入：傳 `/dashboard`（fleet 管理員），或在主機上執行 `agend web`。要從手機或其他電腦使用，請看[從別的裝置連線](web-dashboard.zh-TW.md#從別的裝置連線)。完整說明在 [web-dashboard.zh-TW.md](web-dashboard.zh-TW.md)。

## 遠端登入 CLI（`/login`）

`/login [backend]`（fleet 管理員；Telegram 的 General topic 或 Discord）不必 SSH 就能讓後端 CLI 登入；如果 CLI 還沒安裝，會先幫你裝好。不帶參數時，會顯示所有已安裝或可安裝之後端的選單。每次登入都在專屬的暫時 tmux 視窗裡進行（不會動到 instance 的 pane），10 分鐘後逾時，也可以用 `/login cancel` 中止。

- **裝置碼** — `codex` 和 `grok`：網址和代碼會貼在聊天室。
- **瀏覽器終端機** — `claude-code` 和 `kiro-cli`：AgEnD 會開一個一次性的網頁終端機，執行登入指令，你在那裡完成登入（必要時把代碼貼回去）。這個連結預設只在這台機器上有效（可透過 SSH 轉發、tailscale 或你自己的 proxy 連過去）。
- **只安裝** — `opencode` 和 `muse` 在這裡沒有登入流程。`antigravity` 不支援遠端登入，因為 `agy` 沒有獨立的登入指令。

**公開連結。** 如果手機連不到這台機器，`claude-code` 或 `kiro-cli` 的登入可以透過 Cloudflare Quick Tunnel 提供一個暫時的公開 https 連結：確認訊息上有 **I understand (temporary public link)**、**I understand (local network)** 和 **Cancel** 三個按鈕，按下第一個就代表同意，每次登入問一次。`PATH` 上有 `cloudflared` 就用它；沒有的話，AgEnD 會把 Cloudflare 的版本下載到 `~/.agend/bin/`，只下載一次，版本固定，並以隨附的 SHA256 驗證。連結和存取權杖會分成兩則私訊傳給你，絕不貼在頻道裡；登入不論以何種方式結束，tunnel 都會關閉。TLS 在 Cloudflare 端解開，所以 Cloudflare 看得到那個終端機。設定 `web_terminal.tunnel.allow_public: false` 可以在這台主機上關閉這個選項。詳見 [configuration](configuration.zh-TW.md#人不在機器旁完成-login公開連結)。

登入成功後，這個後端執行中的 instance 會重啟，以套用新的憑證。`/install-cli` 是保留下來的打字別名：它仍然有效，會告知指令已經搬家，並以同樣的參數執行 `/login`；它不會出現在任何指令選單裡。

## 憑證 profile 與第二份訂閱 (Credential profiles and a second subscription)

CLI 只會把登入資訊存在一個地方，所以預設情況下，同一個後端的所有 instance 共用一個帳號。`credential_profile` 可以替 instance 指定一份有名字、獨立的登入，支援 **`kiro-cli`** 和 **`codex`**：

```yaml
instances:
  work-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: work
```

profile 存放在 fleet 底下的 `~/.agend/credential-profiles/<backend>/<profile>`，所以好幾個 agent 可以指向同一份訂閱。沒有指定 profile 的 instance 不受影響。只有登入資訊會分開：kiro 龐大的執行期快取會連回共用的那一份，Codex 則只有 `auth.json` 不同。切換 profile 就是改設定再重啟（`update_instance_config` 會兩件事一起做）；切換到從未登入過的 profile 會被拒絕，並附上登入它的指令。在 kiro 上切換會開始新的對話，因為 kiro 把對話和登入資訊存在同一個地方（AgEnD 會把最近的 context 交接過去）；在 Codex 上，對話會保留。

**ClassicBot 頻道（#1220）。** `classicBot.yaml` 裡的頻道也接受同樣的 `backend_options.<backend>.credential_profile`，而且優先於從 fleet defaults 繼承來的 profile（值為空或 `null` 代表用共用的登入）。頻道的 agent 會以這個 profile 啟動，`/usage` 會把它算在那份訂閱的那一列（例如 `Codex (personal)`），`kiro_engine_status` 也會回報它。profile 名稱無法使用時，這個頻道的 agent 會直接不啟動，而不是改用別的登入執行。更改 profile 會重啟該頻道的 agent。

`/usage`、`get_usage` 和儀表板都是每份訂閱各一列，絕不加總。完整說明見英文版 [configuration](configuration.md#credential-profiles-multiple-subscriptions-of-one-backend)。

## 內建工作流程模板 (Built-in workflow template)

fleet 的協作工作流程會透過 MCP instructions 自動注入。由 `fleet.yaml` 的 `workflow` 欄位控制：

- `"builtin"`（預設）— 標準協作工作流程
- `"file:./path.md"` — 從檔案載入自訂工作流程
- `false` — 不注入工作流程

## 工作流程分層：coordinator 與 executor (Workflow layering: coordinator vs executor)

General instance 會收到完整的 coordinator 手冊（挑選協作者、評估任務大小、委派原則、目標與決策管理）。其他 instance 則收到精簡的 executor 工作流程（溝通規則、進度追蹤、保護 context）。這樣 General instance 能扮演聰明的調度者，worker instance 則專心做事。

## 感知當機的快照復原 (Crash-aware snapshot restore)

context 快照現在在偵測到當機時也會寫入，不再只限於 context 輪替。快照檔會保存在磁碟上，搭配記憶體中的「已使用」旗標，所以即使 daemon 重啟也能復原。agent 在意外當機後也能帶著 context 回來，而不只是計畫中的輪替才行。

## 錯誤監控的 hash 去重 (Error monitor hash dedup)

PTY 錯誤監控會在復原時記下 pane 內容的 hash。如果同一個畫面上又出現同樣的錯誤，就會被壓下，避免陷入反覆偵測舊錯誤的迴圈。這消除了終端機上殘留輸出造成的錯誤通知誤報。

## 平行啟動 (Parallel startup)

fleet 的 instance 現在改成平行啟動，而不是一個接一個。其中也處理了許多 instance 同時啟動時，可能發生的 tmux 重複 session 競爭狀況。

## Fleet 就緒通知 (Fleet ready notification)

`fleet start` 或 `fleet restart` 之後，General topic 會收到「Fleet ready. N/M instances running.」訊息。如果有 instance 啟動失敗，會在通知裡列出來。

## create_instance 的 systemPrompt 參數 (create_instance systemPrompt parameter)

agent 建立 instance 時，可以透過 `systemPrompt` 參數傳入自訂的系統提示，支援行內文字。這段提示會透過 MCP instructions，和 fleet context 一起注入。

## create_instance 的 project_roots 限制 (project_roots enforcement on create_instance)

`fleet.yaml` 設定了 `project_roots` 時，`create_instance` 會檢查要求的工作目錄是否位於其中一個根目錄底下。超出範圍的目錄會被拒絕並回傳錯誤。

## reply_to_text 注入 (reply_to_text injection)

使用者在 Telegram 裡回覆先前的訊息時，被引用的文字會包含在送給 agent 的格式化訊息中，讓 agent 知道使用者指的是哪件事。

## delete_instance 自動清理 team (delete_instance team cleanup)

用 `delete_instance` 刪除 instance 時，它會自動從所屬的每個 team 中移除，不必手動整理 team 成員。

## HTML 對話匯出 (HTML Chat Export)

`agend export-chat` 會把 fleet 活動匯出成一個獨立的 HTML 檔。支援用 `--from` 和 `--to` 篩選日期，用 `-o` 指定輸出路徑。匯出的檔案以好讀的聊天格式，收錄所有訊息、工具呼叫和跨 instance 的通訊。

## Agent 之間的訊息顯示 (Bot-to-bot message visibility)

一個 instance 傳訊息給另一個時（`send_to_instance`、`delegate_task`、`report_result` 等），AgEnD 也會把它貼到各 instance 的主題，讓人可以跟著看：發送方主題貼完整訊息；接收方主題在 task 或 query 時貼完整訊息，其他種類貼簡短摘要，report 或 update 則不貼。Fleet 一忙，這些貼文會淹沒與人的對話。`cross_instance_visibility` 決定要貼多少（#1302）：

| 模式 | 各 instance 主題 |
|------|-----------------|
| `full`（預設） | 如上所述，與以往版本相同 |
| `summary` | 同樣的貼文，每則一行：`發送方 → 接收方: ` 加上發送方的任務摘要，或訊息開頭 |
| `hidden` | 不貼 |

每個主題依自己的 instance 而定：`instances.<name>.cross_instance_visibility`，否則 `defaults.cross_instance_visibility`，否則 `full`。Fleet 管理員可用 `/visibility full|summary|hidden`（Telegram General topic 或 Discord）設定 fleet 預設值，並存入 `fleet.yaml`；只打 `/visibility` 會顯示目前設定，以及有自己設定的 instance。Settings 有 fleet 預設值（Defaults）與每個 agent 的覆寫（agent → 進階）。變更立即生效，不需重啟。

只有這些主題貼文會改變。訊息照常送達，[Mirror Topic](#mirror-topic) 仍會收到每一則訊息，General topic 在任何模式下都不會出現這些貼文。

## Mirror Topic

在 `fleet.yaml` 設定 `mirror_topic_id`，指定一個 Telegram topic 用來觀察跨 instance 的通訊。所有 `send_to_instance` 訊息都會即時鏡像到這個 topic。這是 daemon 層級的 hook，完全不改變 agent 的行為，agent 也不知道自己正被觀察。

## Codex session 恢復 (Codex session resume)

每個 Codex instance 恢復的都是**自己的**對話。啟動時，AgEnD 以唯讀方式讀取 Codex 共用的 session 資料庫（`~/.codex/state_5.sqlite`），挑出記錄的工作目錄和 instance 完全相同的最新互動 session，再執行 `codex resume <id>`。AgEnD 不用 `codex resume --last`：從 Codex 0.157 起，它會挑整個 git repository 裡最新的 session，於是同一個 repo 不同 worktree 上的 instance 會互相搶走對方的 session（#984）。

| 情況 | 啟動方式 |
|---|---|
| 這個目錄有 session | `codex resume <id>` |
| 這個目錄沒有 session（例如共用 repo 裡新建的 instance） | 新對話 |
| 讀不到 session 資料庫，且同一個 git repo 裡有其他 Codex instance | 新對話，並在該 instance 的 topic 發通知 |
| 讀不到 session 資料庫，且 repo 裡沒有其他 Codex instance | `codex resume --last`，並發通知 |

AgEnD 從不寫入 Codex 的狀態，也不搬動任何 session 檔；session 和 lock 都留在共用的 `~/.codex`，所以在終端機執行 `codex resume` 仍然看得到每個 instance 的對話。如果 Codex 顯示「This conversation is open in another app」或「Working directory · resume」選擇器，AgEnD 會暫停投遞並通知管理者，而不是替你按鍵。它也會把「You've hit your usage limit」認定為會觸發暫停的錯誤。

**`~/.codex` 在哪裡。** 上面提到的共用 Codex home，在 fleet 的環境有設定 `$CODEX_HOME` 時就是它，否則就是 `~/.codex`。每個 instance 本身則以 `~/.agend/cx/<hash>/` 底下的私有 `CODEX_HOME` 執行：裡面有它自己的 `config.toml`（你的設定，去掉其他 instance 的 AgEnD MCP 項目，再加上它自己的），登入資訊、session 和快取則連回共用的 home。

## Codex 自訂 provider (Codex custom provider)

Codex instance 可以改用你在 Codex 設定裡定義的模型 provider，而不是預設的那個：

```yaml
instances:
  glm-agent:
    backend: codex
    model: <a model the provider serves>
    backend_options:
      codex:
        provider: glm
```

instance 啟動時會帶上 `-c model_provider="glm"`。provider 本身（`[model_providers.glm]`、它的 base URL 和金鑰變數）定義在共用的 Codex `config.toml` 裡，每個 instance 的私有設定會複製過去。名稱只能包含英文字母、數字、`_` 和 `-`。`create_instance` 也接受同樣的 `backend_options.codex.provider`；`list_models` 帶 `instance_name` 時，會透過那個 instance 自己的設定讀取模型清單，因為自訂 provider 提供的模型可能和帳號的不同。

## 頻率限制備援切換冷卻 (Rate limit failover cooldown)

5 分鐘的冷卻期可以避免模型備援切換被反覆觸發。發生切換後，冷卻期間內再出現的頻率限制錯誤都會被壓下，避免終端機緩衝區裡殘留的錯誤文字引發連鎖切換。

## CLI 使用體驗改善 (CLI UX improvements)

- `agend fleet restart <name>` — 只重啟特定 instance，而不是整個 fleet
- `agend attach` — 模糊比對，有多個符合時顯示互動式的編號選單
- `agend logs` — 獨立的日誌檢視器，會去除 ANSI 控制碼，支援 `-n/--lines` 和 `-f/--follow` 選項

## .env 優先覆蓋 (.env priority override)

`~/.agend/.env` 裡的值現在會正確覆蓋從 shell 繼承來的環境變數。這確保了 token 的隔離：`.env` 裡設定的 bot token，會優先於 shell 環境中可能存在的 `AGEND_BOT_TOKEN`。

## 依後端產生 General 指示 (Backend-aware General instructions)

自動建立 General topic instance 時，AgEnD 會依設定的後端寫入對應的指示檔：

- Claude Code → `CLAUDE.md`
- Codex、OpenCode、Grok Build、Meta Muse Code → `AGENTS.md`
- Kiro CLI → `.kiro/steering/project.md`
- Antigravity CLI → `.agents/agents.md`

已經存在的檔案不會被動到。

## 內建文字統一為英文 (Builtin text standardization)

所有系統產生的文字（排程通知、語音訊息標籤、General 指示、fleet 通知）現在都統一為英文，先前有些訊息是中文。只剩一個例外：進度泡泡（`處理中…`、失效後留下的 `🧾 工具歷程`，以及 `tool_progress` 的標籤）仍然寫死為中文。

## AGEND_HOME：可設定的資料目錄 (AGEND_HOME — configurable data directory)

設定 `AGEND_HOME` 環境變數可以更改資料目錄（預設：`~/.agend`），適合同時執行好幾套互相隔離的 AgEnD。每個 AGEND_HOME 都有自己的 tmux socket，彼此不會衝突。

## Fleet 模板 (Fleet templates)

在 `fleet.yaml` 的 `templates` 區塊定義可重複使用的 fleet 設定。部署一個模板，就能一次建立多個 instance 和一個 team：

- `deploy_template` — 建立 instance（各自擁有自己的 git worktree），也可以一併建立 team
- `teardown_deployment` — 停止並刪除某次部署的所有 instance 和 team
- `list_deployments` — 列出目前的部署和其中 instance 的狀態

## 統一以附加方式注入系統提示 (Unified additive system prompt)

fleet 指示以附加的方式注入，不會覆蓋 CLI 內建的系統提示。每個後端都用它原生的機制：

- Claude Code：`--append-system-prompt-file`（檔案是 instance 目錄裡的 `fleet-instructions.md`）
- Kiro CLI：它自己的 steering 檔，`.kiro/steering/agend-<instance>.md`
- Codex、Grok Build、Meta Muse Code：工作目錄裡 `AGENTS.md` 中一段有標記的區塊
- Antigravity CLI：工作目錄裡 `.agents/agents.md` 中一段有標記的區塊
- OpenCode：instance 目錄裡的 `fleet-instructions.md`，加進工作目錄中 `opencode.json` 的 `instructions` 清單

## 自動關閉互動提示 (Auto-dismiss interactive prompts)

後端定義好的啟動與執行期對話框會自動關閉，不需要人介入：

- 信任資料夾的確認
- 恢復 session 的選擇器
- 碰到頻率限制時切換模型的提示（Codex）
- 略過權限的確認

每個後端都在 `getStartupDialogs()` 和 `getRuntimeDialogs()` 裡定義自己的對話框樣式和按鍵序列。

## CLI 模式（`agent_mode`）

給不太支援 MCP 的後端用的替代方案。在 fleet.yaml 設定 `agent_mode: cli`，就會改用以 HTTP 為基礎的 agent CLI 端點，而不是 MCP server。agent CLI 透過命令列的 HTTP 呼叫，提供同樣的 fleet 工具。

## 錯誤狀態警告 (Error state warning)

`send_to_instance`、`delegate_task` 或 `request_information` 的目標 instance 正處於頻率限制、暫停或當機迴圈時，傳送者會在工具回應裡收到警告：

```json
{ "sent": true, "warning": "instance-name is currently in error state..." }
```

訊息仍然會送出；警告只是提醒，讓傳送者自己決定要重試還是往上回報。

## systemPrompt 檔案路徑 (systemPrompt file paths)

fleet.yaml 的 `systemPrompt` 欄位支援 `file:` 前綴，從檔案載入內容：

```yaml
instances:
  my-project:
    systemPrompt: "file:prompts/role.md"
```

相對路徑以 **instance 的 `working_directory`** 為基準（#1314）；`~/` 與絕對路徑照原樣使用。這個目錄只是相對路徑的*起點*，不是邊界：`../` 與符號連結可以離開它，就像絕對路徑可以指向 fleet 使用者讀得到的任何檔案一樣。`~name/`（其他使用者的家目錄）不支援，會發出警告並拒絕，絕不會當成名為 `~name` 的目錄來讀。2.1.13 之前是以 fleet 程序的目前目錄為基準（安裝的服務下是 `~/.agend`，手動執行 `agend fleet start` 時是 shell 所在目錄）。保留一個版本的相容：相對路徑在 working_directory 下找不到檔案、但舊的 fleet 目錄下有時，仍會改用舊檔案，log 會列出兩個路徑，並在該 instance 的主題通知一次。這個退回機制會在 2.2 移除。

可以用逗號串接多個部分（`"file:a.md, file:b.md"`，中間也可以夾行內文字），各部分之間以空行連接。**只有至少一個部分是 `file:` 參照時**才會以逗號切分，所以像 `"You are Kuro, a careful reviewer"` 這樣的行內提示會維持一段。讀不到、超過 256 KiB，或不是一般檔案（例如 FIFO 或裝置，開啟時不會阻塞）的檔案不會貢獻任何內容；log 會列出它的路徑與錯誤（絕不列出內容），設定驗證也會對找不到檔案的參照發出警告。`workflow: "file:…"` 設定也用同樣的方式讀檔。

## 分批錯開啟動 (Staggered startup)

設定平行啟動 instance 時的併發上限：

```yaml
defaults:
  startup:
    concurrency: 3        # 同時啟動的 instance 上限
    stagger_delay_ms: 2000 # 每批之間的間隔
```

在同一批裡，共用同一個工作目錄的 instance 會依序啟動，避免設定檔的競爭狀況。

## Antigravity CLI 後端 (Antigravity CLI backend)

AgEnD 支援 Google 的 Antigravity CLI（`agy`）作為後端。它和其他後端一樣預設使用 MCP；設定 `agent_mode: cli` 就能改用 `agend-agent` 指令進行 fleet 通訊。

```yaml
instances:
  my-agent:
    backend: antigravity
    # agent_mode 預設為 "mcp"；設為 "cli" 可改用 agend-agent 指令
```

### Workspace 處理

agy 1.1.0 以後接受位於隱藏路徑（例如 `~/.agend/workspaces/`）底下的工作目錄，所以 instance 和其他後端一樣，就在設定的工作目錄裡執行（以前轉向 `~/agend-workspaces/<instanceName>/` 的做法已經移除）。fleet 指示會以一段有標記的區塊，寫進該目錄裡的 `.agents/agents.md`。

### 信任提示

agy 的「Do you trust this folder?」提示會在啟動時自動關閉。

## Meta Muse Code 後端 (Meta Muse Code backend)

從 2.1.6 起支援 Meta Muse Code（`muse`）作為後端。

```yaml
instances:
  my-muse:
    backend: muse
```

用 `/login muse` 安裝，或在 shell 執行：`mkdir -p "$HOME/.local/bin" && curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$HOME/.local/bin/muse" && chmod +x "$HOME/.local/bin/muse" && MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"`。launcher 會把執行檔放在自己旁邊，所以要先存成 `~/.local/bin/muse`；如果直接 pipe 給 `bash`，它會下載到目前的目錄。安裝後用 `muse login` 登入，`/login` 目前還不支援 muse 的登入。Muse 採取「併入」而不是排隊：turn 進行中傳來的訊息會被納入這一輪，所以 `/steer` 可以使用（已在 muse 1.3.0 驗證）。`/clear` 會開始新的對話。訂閱用量會從 muse 的回應串流轉送到 `/usage`。

## Grok Build 後端 (Grok Build backend)

AgEnD 支援 xAI 的 Grok Build CLI（`grok`）作為後端。需要 Grok CLI 1.0.13 以上：較舊的版本會被伺服器拒絕（HTTP 426），這時 AgEnD 會提示管理者執行 `grok update`。

```yaml
instances:
  my-grok:
    backend: grok
```

### 認證

Grok 使用 x.ai 的 OAuth device flow。第一次啟動時：
1. TUI 顯示裝置碼（例如 `5M6B-584D`）
2. 使用者在瀏覽器開啟網址並輸入代碼
3. 憑證保存在 `~/.grok/`，重啟後依然有效

在 headless 環境（SSH、Docker）中，必須在另一台機器上手動開啟網址。

### 已知功能

- **感知 Git** — 啟動時顯示分支和 worktree
- **TUI 模式** — 全螢幕的終端機介面（不是單純的提示字元）
- **Context 顯示** — 以 `已用 / 總量` token 呈現（例如 `12K / 500K`）；AgEnD 的 `/ctx` 和 `agend ls` 會把它換算成百分比
- **取消鍵** — Ctrl+C（中斷生成；已對實際的 CLI 驗證）
- **Session 恢復** — `--resume <session-id>`（自動管理：AgEnD 依工作目錄保存 session id）。刻意**不**使用 `--continue`，因為沒有前一個 session 時它會直接結束
- **工具核准** — 除非 `skipPermissions` 設為 false，否則以 `--always-approve` 啟動；另有 runtime 對話框規則作為備援，自動核准提示
- **Session 隔離** — grok 依工作目錄存放 session（`~/.grok/sessions/<編碼後的 cwd>/`），工作目錄不同的 instance 不會讀到彼此的 session

### 斜線指令

| 指令 | 說明 |
|---------|-------------|
| `/dashboard` | 開啟網頁儀表板 |
| `/home` | 回到主畫面 |
| `/resume` | 恢復先前的 session |
| `/rename` | 重新命名目前的 session |
| `/session-info` | 顯示 session 詳情 |
| `/feedback` | 傳送意見回饋 |

### 已知限制

- 登入必須走 device flow，headless 環境需要手動用瀏覽器開啟
- 升級提示不會擋住操作，但會佔用 TUI 的空間
- Context 顯示的是 token 數（例如「12K tokens」）而不是百分比，`agend ls` 的解析器會處理
- `ctrl+q` 會結束程式；AgEnD 取消時用 Ctrl+C，絕不會為了取消而送出 Ctrl+Q

## OpenCode 後端 (OpenCode backend)

OpenCode（`backend: opencode`）的設定方式和其他後端相同。

```yaml
instances:
  my-opencode:
    backend: opencode
    model: provider/model   # 格式同 `opencode models` 列出的
```

- **設定與指示。** OpenCode 會讀取工作目錄裡的 `opencode.json`。AgEnD 會合併進這個檔案，而不是整個取代：它會以自己的鍵（`<server>-<instance>`，好讓多個 instance 共用同一個目錄）加入這個 instance 的 MCP server，並把 instance 目錄裡的 `fleet-instructions.md` 加進 `instructions` 清單。你自己的項目都會保留。
- **權限。** 在 `skipPermissions`（預設）下，如果 OpenCode 的 `--help` 有列出 `--auto`，就會帶這個旗標啟動；你設定裡明確的 `deny` 規則仍然有效。較舊的 OpenCode 不帶任何啟動旗標，它的「Permission required」提示會在執行期以「Allow once」回應。
- **Session 恢復。** 只會恢復 AgEnD 替這個 instance 記錄的 session（`--session <id>`）。絕不使用 OpenCode 的 `--continue`：它是全域的，可能會接到別的目錄的 session。
- **操作。** 取消用 Escape（Ctrl+C 會讓 OpenCode 結束）；`/compact` 和 `/clear` 會直接轉給它。不支援推理強度。`list_models` 會讀取 `opencode models`。
- **登入。** `/login opencode` 會在 CLI 尚未安裝時幫你裝好，但沒有登入流程：請在主機上用 OpenCode 自己登入（AgEnD 會用 `opencode auth list` 檢查結果）。

## 自動暫停與喚醒 (Auto-Pause & Wake)

閒置的 instance 可以自動暫停以節省資源，有訊息進來時再自動喚醒。

### 運作方式

- **自動暫停**：instance 連續 `auto_pause_after` 分鐘沒有活動就會暫停（保留 tmux 視窗，CLI 暫停執行）
- **自動喚醒**：使用者傳訊息給暫停中的 instance 時，它會自動醒來（大約 30 秒恢復）
- **工作中保護**：正在產生回應的 instance 絕不會被暫停

### 設定

```yaml
defaults:
  auto_pause_after: 0    # 0 = 停用（預設）。設成大於 0 的分鐘數即啟用。

instances:
  my-agent:
    auto_pause_after: 30  # 個別 instance 覆寫：閒置 30 分鐘後暫停
```

也可以在 Settings 網頁設定：**Runtime & Resources → auto_pause_after**。

### 手動控制

| 指令 | 平台 | 說明 |
|---------|----------|-------------|
| `/pause` | DC 斜線指令 / TG 指令 | 手動暫停 instance（僅限管理員） |
| `/wake` | DC 斜線指令 / TG 指令 | 手動喚醒暫停中的 instance（僅限管理員） |

### 狀態顯示

- `agend ls` → Status 欄顯示「Paused」，搭配暗黃色的 ○
- `/status` → 暫停的 instance 旁顯示 ⏸ 圖示
- Settings 頁面 → 暫停的 instance 顯示「Wake」按鈕（而不是「Start」）
- MCP `list_instances` → `status: "paused"`

### 行為說明

- 暫停的 instance 不消耗 CPU 或 RAM（CLI 已暫停執行）
- 傳給暫停中 instance 的訊息會觸發自動喚醒，使用者不必手動喚醒
- 跨 instance 訊息（`send_to_instance`）也會觸發自動喚醒
- 排程觸發時，會先喚醒 instance 再投遞
- 喚醒大約需要 30 秒（CLI 要恢復 session 的 context）

### 建議值

| 情境 | 建議值 |
|----------|----------------|
| 個人開發（instance 不多） | `0`（停用）— 保持常駐 |
| 團隊 fleet（10 個以上 instance） | `30`（30 分鐘）— 節省資源 |
| 大型 fleet（在意成本） | `10` — 積極暫停 |
| 必須常駐 | `0` 或不設定 |

## Warm Cap（LRU 淘汰）

整個 fleet 同時**常駐**（tmux 視窗加上 CLI 程序都在執行）的 instance 數量上限，和 `auto_pause_after` 那種針對單一 instance 的閒置計時互不相干。

- 用 `defaults.warm_cap` 設定（數字，預設 `0` 代表不限制）。
- 執行中的 instance 數量超過上限時，**最久沒有活動的閒置 instance** 會被自動暫停（LRU 淘汰），騰出空間。
- `general` instance（以及任何正在工作的 instance）絕不會被淘汰，只有閒置且不是 general 的 instance 才會列入候選。
- 它和 `auto_pause_after` 互補：後者是在*某個 instance 自己*閒置夠久之後才暫停它；`warm_cap` 則是在全 fleet 的常駐數量一超出預算時，立刻暫停*閒置最久*的那個，即使還沒有任何 instance 達到自己的閒置門檻。
- 因淘汰而暫停的 instance，喚醒方式和其他暫停的 instance 一樣，見[自動暫停與喚醒](#自動暫停與喚醒-auto-pause--wake)。

```yaml
defaults:
  warm_cap: 15   # 同時最多 15 個 instance 常駐；超出的閒置 instance 會被淘汰
```

## 喚醒有排隊工作的暫停 instance（`delivery_worker`）

從 2.1.9 起，重啟一個暫停中的 instance 會把它喚醒，而且被喚醒的 instance 會一直保持清醒，直到排隊的工作做完：來自其他 instance 的工作也算活動。同一個 instance 的啟動、停止、喚醒和重啟，一次只會執行一個。

傳給暫停中 instance 的跨 instance 訊息（`send_to_instance`、`delegate_task` 等）會把它喚醒，包括跨越 fleet 重啟仍保持暫停的 instance。這是預設行為（`wake_only`，#1129 起）。設為 `off` 時，傳給跨越 fleet 重啟仍暫停之 instance 的訊息，會一直排隊到有人手動喚醒它（fleet 啟動之後才暫停的 instance，訊息投遞時仍然會被喚醒）。

| 值 | 作用 |
|-------|--------------|
| `wake_only`（預設） | 有排隊工作在等時，喚醒協調器會喚醒暫停中的目標，走的是和 `/wake` 相同的單一喚醒路徑。失敗會退避重試，連續三次失敗會通知雙方的 topic，而且絕不喚醒因登入失敗而暫停的 instance。 |
| `on`（canary） | 和 `wake_only` 相同，另外由一個 worker 負責該目標的投遞通道：等 CLI 可以接受輸入後，一次交付一則訊息。 |
| `off` | 不為排隊工作喚醒：跨越 fleet 重啟仍暫停的 instance，訊息會一直排隊到有人手動 `/wake`（#1129 之前的行為）。 |

設為 `wake_only` 或 `on` 時，`defaults.warm_overflow`（預設 2）是為了喚醒有排隊工作的目標，`warm_cap` 最多可以超出的數量。`warm_cap` 加上超出額度都滿了、又沒有閒置 instance 可以暫停時，對暫停中 instance 的 `/wake` 或訊息會被拒絕，而不是超出上限。

```yaml
defaults:
  delivery_worker: off   # 不為排隊工作喚醒
instances:
  my-agent:
    delivery_worker: on   # 個別 instance 覆寫
```

## IPC 與 adapter 自動重連 (IPC + adapter auto-reconnect)

網路中斷導致 IPC 連線或 Telegram/Discord adapter 斷線時，AgEnD 會自動恢復：

- **IPC 斷線**：以指數退避重試（3 秒、6 秒、12 秒），之後每 60 秒重試一次，永不放棄。每一輪都會檢查 tmux pane 是否還活著，如果已經死了就重啟 instance。
- **Adapter 致命錯誤**：以退避重試（5 秒、10 秒、20 秒），之後每 60 秒重試一次，永不放棄。涵蓋 Telegram polling 初始化失敗和 Discord gateway 斷線。

刻意關閉時（`agend stop` / fleet 重啟），這兩種機制都會停止。為了避免洗版，每重試 10 次只記錄一則 WARN。

## 平行停止 instance (Parallel instance stop)

關閉 fleet 時（`agend fleet stop`、`agend stop`），instance 會分批平行停止，每批的大小隨 fleet 規模調整：少於 10 個 instance 時一次 5 個，10 到 30 個時一次 10 個，超過 30 個時一次 15 個。systemd unit 以 `TimeoutStopSec=60` 限制整個停止流程的時間。

從 2.1.9 起，systemd unit 使用 `KillMode=mixed`：systemd 只對 fleet 送訊號，再由 fleet 依序結束每個 CLI。在此之前，所有 CLI 會在同一瞬間收到 SIGTERM，WSL 上的 kiro-cli 每次都會 abort，寫出約 1 GB 的 core dump（#908）。`agend restart` 會替舊的 unit 補上這一行，見 [CLI 參考](cli.zh-TW.md#設定與安裝-setup--installation)。

## Beta 與 Alpha 更新頻道 (Beta and alpha update channels)

三個 npm dist-tag，各對應一條線：`@latest`（穩定版）、`@beta`（下一個修訂版）和 `@alpha`（下一個次版本的預覽，例如目前是 2.1.x 時的 2.2.0-alpha.N）。用下列指令安裝預覽版：

```bash
agend update            # 留在已安裝的頻道：alpha 從 @alpha、beta 從 @beta、穩定版從 @latest 更新
agend update --alpha    # 從 @alpha npm dist-tag 安裝
agend update --beta     # 從 @beta npm dist-tag 安裝
agend update --stable   # 從 @latest 安裝，即使目前裝的是 beta 或 alpha
```

聊天裡的 `/update` 和 `agend update` 相同：安裝會留在它原本的頻道。會退回較舊版本的更新（例如 alpha 要求 @beta）會被拒絕；要這麼做，請加上 `--stable`、`--version` 或 `--force` 表明意圖。「有新版本」的通知也依循同一個頻道：alpha 安裝只會被告知較新的 alpha 或較新的穩定版，絕不會被告知 beta。

發版就是推送一個 `v*` tag。發布 workflow 嚴格對應：`vX.Y.Z` → `@latest`、`vX.Y.Z-beta.N` → `@beta`、`vX.Y.Z-alpha.N` → `@alpha`。其他任何 tag（`-rc.N`、打錯字）都會在建置任何東西之前讓 job 失敗；比目前 `@latest` 舊的穩定版也會被拒絕。某個次版本轉為穩定版時（2.2.0），也要把 `@alpha` 指向它（`npm dist-tag add @songsid/agend@2.2.0 alpha`）：alpha 安裝不會被告知與自己同版號的穩定版。

## PSS 記憶體報告 (PSS memory reporting)

`agend ls` 以 `/proc/<pid>/smaps_rollup` 的 PSS（Proportional Set Size）而不是 RSS 回報記憶體。這樣能避免在整棵程序樹之間重複計算共用函式庫的分頁，更準確地反映實際的記憶體用量。在非 Linux 系統上會退回使用 RSS。

## 主機記憶體壓力 (Host memory pressure)

一個全 fleet 共用的取樣器每 30 秒讀取一次主機記憶體，每次准許啟動之前（啟動、喚醒、重啟和復原）也會讀取。在 **Linux** 上，它會節流新的 CLI，但絕不碰已在執行的：

- 可用 RAM 低於 `max(300 MiB, RAM 的 2%)`，或低於 `max(前者的 2 倍, RAM 的 5%)` 且 swap 剩不到 5% → **critical**：不啟動任何新的 CLI；請求會等待，並在 5、10、20、40 秒後重試，之後每 60 秒一次；
- RAM 低於第二個門檻，或 swap 剩不到 5% → **elevated**：一次只啟動一個，間隔至少 5 秒（讀不到樣本時也比照處理，絕不當作 RAM 為零）；
- critical 解除後，啟動速度會在 30 秒內慢慢回升。

`/health` 一定會帶 `hostMemory` 區塊（等級、RAM 和 swap、趨勢）；在 Linux 上，記憶體壓力也會讓它標成 degraded，並發出 fleet 通知，冷卻時間 10 分鐘（升級到 critical 會立刻通知）。在 **macOS** 上，從 #1257 起樣本只寫進日誌：不會放慢或擋下任何東西、不發通知，`/health` 也不回報壓力，因為 macOS 的可用記憶體和 swap 數字，在記憶體充裕的機器上也會觸發警示。詳見英文版 [memory-pressure.md](memory-pressure.md)。
