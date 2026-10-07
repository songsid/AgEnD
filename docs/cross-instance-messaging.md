# Cross-Instance Messaging & Peer-to-Peer Collaboration

Instance 之間、以及外部 CLI session 與 daemon instance 之間的通訊機制。每個 instance 都是對等 peer，可以發現其他 instance 並傳訊給它——但不是每個 peer 都能喚醒或建立 instance：能不能 wake/create/start 要看它的工具組（tool profile），見下文。

## MCP Tools

### `list_instances`

列出 fleet 所有的 instance（含狀態和工作目錄），以及連上來的外部 session（`external_sessions`）。輸出有三層（超過預算自動降級）：完整版 → 精簡版（無描述，需 `describe_instance` 看詳情）→ 計數版。篩選用 `{tags, backend, status, name}`。

```
→ list_instances()
← { instances: [
    { name: "blog", status: "running", working_directory: "~/Documents/Hack/blog", backend: "claude-code", ... }
  ],
  external_sessions: [ { name: "external-myproject-1234", type: "session", host: "blog" } ] }
```

### `send_to_instance` — fire-and-queue

訊息交給 fleet 就立即回覆，不等送達。回傳是**受理收據**，不是送達證明：

```
→ send_to_instance({ instance_name: "blog", message: "幫我 review 這個 diff" })
← { sent: true, queued: true, target: "blog", target_state: "running",
    operation_id: "…", delivery_id: "…", delivery_state: "queued",
    correlation_id: "…" }
```

- `sent: true, queued: true` 只代表 fleet 收下了；送達與否查 `delivery_status`（用 `operation_id` 或 `delivery_id`）。
- `queued ≠ delivered`：投遞是背景進行的（見下文 durable outbox）。狀態 `uncertain` 表示 fleet 無法確認到底送達沒——**不要盲目重送**，先查 `delivery_status`。
- 目標已停止會回錯誤並提示用 `start_instance()`（如果你有這個工具——worker 工具組沒有）。

### `delivery_status`

查一則跨 instance 訊息的投遞狀態（queued / delivering / delivered / failed / uncertain）。`uncertain` 時以這裡的答案為準，不要重送。

### `start_instance` / `create_instance` / `restart_instance` / `wake_instance`

喚醒、建立、重啟 instance。只有較大的工具組才有這些動作：`worker` 工具組完全沒有（只能 `reply`、`send_to_instance`、`report_result` 等協作工具）；`general` 有其中一部分（create/start/restart/wake）；`coordinator` 與 `full` 才有全部。權限不足時工具會直接拒絕並說明它是 coordinator 的工具。所以「每個 peer 都能喚醒或建立別人」是錯的——先確認自己的工具組。

## 訊息流程（fire-and-queue）

```
發送方 CLI                        Fleet                        接收方 CLI
     │                              │                                │
     │  send_to_instance            │                                │
     │  (MCP tool call)             │                                │
     │ ───────────────────────────►│  受理 → 寫入 durable outbox     │
     │                              │                                │
     │  { sent: true, queued: true, │  背景按 target lane 投遞        │
     │    operation_id, … }         │  (FIFO；重啟後對帳續投)         │
     │◄───────────────────────────│                                │
     │                              │  daemon pane 注入訊息           │
     │                              │ ──────────────────────────────►│
```

回覆義務：`request_kind: "task"` 或 `"query"` 且 `requires_reply` 的訊息，對方應該用 `report_result`（或實質回覆）結案；`report`/`update` 只是告知，不需回覆。

## Durable outbox

跨 instance 訊息先寫進本機 outbox 再投遞，所以 daemon 重啟不會弄丟已受理的訊息：

- 同一目標保證 FIFO；重啟後未完成的列恢復為 `queued` 續投，投遞中、證據不足的列先對帳（reconciliation），**絕不盲目重播**。
- 每則訊息有 `operation_id`（呼叫端冪等鍵）與 `delivery_id`（fleet 配發）；重送相同 `operation_id` 會被認出是重複（`duplicate: true`），不會投遞兩次。
- `delivery_status` 是唯一的狀態權威；`uncertain` 是誠實的「不知道」，不是失敗。

## Telegram 可見性

跨 instance 訊息的 Telegram topic 通知規則（`src/outbound-handlers.ts`）：

- **Target topic**：`task`/`query` 貼全文；`report`/`update` **靜默**（不貼）；其他只貼 100 字預覽（或 `task_summary`）。General topic 的 instance 永遠跳過（保持 General 乾淨）。
- **Sender topic**：永遠貼完整的送出訊息（讓使用者看到 agent 發了什麼）。
- 通知標籤為 `sender → target`；訊息本體仍經由 daemon pane 投遞，通知只是可見性。

訊息本體的 meta（給 pane 內的 agent 看的 envelope）：`chat_id` 為空字串，`message_id` 形如 `xmsg-…`，`user`/`user_id` 為 `instance:<sender>`，`from_instance` 為發送方機器名（回覆目標以此為準）。

## Session Identity（Env Var Layering）

MCP server 連線時自報 session 名，daemon 據此路由。`AGEND_SOCKET_PATH` 必填，沒設則 MCP server 直接結束。

身份優先順序：

```
AGEND_INSTANCE_NAME → AGEND_SESSION_NAME → external-<basename(cwd)>-<pid>
```

| 優先級 | Env Var | 誰設定 |
|---|---|---|
| 1 | `AGEND_INSTANCE_NAME` | Daemon 經 tmux 環境注入（內部 session） |
| 2 | `AGEND_SESSION_NAME` | `.mcp.json` 的 env（外部 session 自取，可選） |
| 3 | (fallback) | 工作目錄 + PID 自動產生（同目錄多 session 不會撞名） |

Fleet manager 維護 `sessionRegistry: Map<sessionName, instanceName>`；`mcp_ready` 帶來的 session 名不等於 instance 名時，記為外部 session，會出現在 `list_instances` 的 `external_sessions`。MCP server 本身只提供工具（tool-only）； inbound 投遞走 daemon pane，不是 MCP notification。

## Wake coordinator 與 per-target workers

投遞給暫停中 instance 的訊息不會直接喚醒它：`delivery_worker` 預設是 `wake_only`——訊息先排隊，由 wake coordinator 在名額允許時喚醒目標，醒了才投遞。per-target worker 保證同一目標一次只有一個投遞者在推進。`wake_only` 以外的模式（`off`/`on`）是 fleet 配置，不是單則訊息能指定的。

## 重啟

二進制是 `agend`（不是 `ccd`）。開發 daemon 功能改完 code：`npm run build`，再 `agend fleet restart --reload` 載入新代碼（`--reload` 不能與實例名併用；不加則是在進程內等閒置重啟）。

`agend fleet restart`（全 fleet）會等每個 instance idle（各等最多 10 秒），整體最多等 **5 分鐘**，超時就強制重啟、不再無限等。Telegram/Discord 會收到開始與完成通知。
