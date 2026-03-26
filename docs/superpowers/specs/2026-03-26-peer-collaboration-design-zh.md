# 對等式 Agent 協作

## 摘要

讓 CCD 的每個 instance 都能自主發現並與其他 instance 協作。新增一個 General Topic instance 作為自然語言入口。不設特殊的 Dispatcher 角色——所有 instance 都是對等的，都具備協作能力。

## 動機

CCD 現有的跨 instance 通訊（`send_to_instance`、`list_instances`）支援基本的 fire-and-forget 訊息傳遞，但存在三個不足：

1. Instance 無法啟動已停止的其他 instance——目標離線時協作就斷了。
2. `list_instances()` 只回傳名稱——instance 無法判斷誰能幫什麼忙。
3. 不存在 General Topic instance 作為自然語言入口，讓不屬於特定專案的任務能被處理。

本設計以最小變更補齊這些缺口：兩個新 MCP tool、一個增強的 tool、以及一個 General Topic instance 的設定。

## 設計

### 新增 MCP Tool：`start_instance(name)`

允許任何 instance 要求 fleet manager 啟動一個已停止的 instance。

**流程（三跳，符合現有架構）：**
1. Instance A 呼叫 `start_instance("blog")`
2. MCP server 發送 `{ type: "tool_call", tool: "start_instance", args: { name: "blog" }, requestId }` 經 IPC 到 daemon
3. Daemon 的 `handleToolCall()` 將其分類為 fleet 路由工具，發送 `{ type: "fleet_start_instance", name: "blog" }` 到 fleet manager
4. Fleet manager 使用現有啟動邏輯啟動 instance，等待 IPC 連線建立
5. Fleet manager 回應經 IPC → daemon → MCP server → 回到 Claude

**回應：**
```json
{ "success": true }
// 或
{ "success": false, "error": "Instance not found in fleet config" }
```

**邊界情況：**
- Instance 已在運行 → 直接回傳成功
- Instance 不存在於 fleet config → 回傳錯誤
- Instance 啟動失敗 → 超時 60 秒後回傳錯誤

### 新增 MCP Tool：`create_instance(directory, topic_name?)`

允許任何 instance（主要是 General）建立一個新的 instance 並配套 Telegram topic。取代 `/open` 和 `/new`。

**流程（三跳）：**
1. Instance 呼叫 `create_instance({ directory: "~/Documents/Hack/blog" })`
2. MCP server → daemon → fleet manager（與 `start_instance` 相同的路徑）
3. Fleet manager 依序執行以下步驟，失敗時反向回滾：
   a. 驗證目錄是否存在
   b. 從目錄名稱產生 instance 名稱（複用 `topic-commands.ts` 的 `sanitizeInstanceName`）
   c. 建立 Telegram forum topic
   d. 將 instance 註冊到 fleet config（寫入 `fleet.yaml`）
   e. 啟動 instance（tmux + daemon + IPC）
4. 回傳 `{ success: true, name: "blog", topic_id: 1385 }`

**參數：**
- `directory`（必填）：絕對路徑或 `~` 開頭的專案路徑
- `topic_name`（選填）：Telegram topic 名稱，預設為目錄名稱

**失敗回滾：** 步驟按順序排列，前面的步驟容易復原：
- 步驟 c 失敗（建立 topic）→ 無需清理，目錄只是被驗證過
- 步驟 d 失敗（寫入 config）→ 刪除已建立的 Telegram topic
- 步驟 e 失敗（啟動 instance）→ 移除 config 條目，刪除 Telegram topic

模式等同於資料庫 migration——有序步驟搭配反向清理。Fleet manager 已有 instance 生命週期管理，每個回滾步驟都使用現有程式碼。

**邊界情況：**
- 目錄不存在 → 回傳錯誤
- 該目錄已有對應的 instance → 回傳現有 instance 資訊（name、topic_id、status）
- 模糊輸入匹配到多個目錄 → 回傳候選清單，由 Claude 詢問使用者確認

### 增強：`list_instances()`

**現有回應：**
```json
{ "instances": ["blog", "ccd", "research"] }
```

**增強後的回應：**
```json
{
  "instances": [
    {
      "name": "blog",
      "status": "running",
      "working_directory": "~/Documents/Hack/blog"
    },
    {
      "name": "ccd",
      "status": "stopped",
      "working_directory": "~/Documents/Hack/claude-channel-daemon"
    }
  ]
}
```

**新增欄位：**
- `status`：`"running"` | `"stopped"` | `"starting"` | `"rotating"`
- `working_directory`：來自 fleet config 的專案路徑

`working_directory` 已足夠讓 Claude 推斷每個 instance 的用途，不需要額外的 `description` 欄位。

**實作方式：** Fleet manager 已知所有已設定的 instance（來自 fleet config）以及哪些正在運行（來自 `this.daemons`）。合併兩個來源即可產出完整清單。

**錯誤訊息改善：** 當 `send_to_instance` 的目標是已停止的 instance 時，錯誤訊息應改為：`"Instance 'X' is stopped. Use start_instance('X') to start it first."`，取代目前籠統的 "Instance or session not found"。

### General Topic Instance

一個接收 General Topic 訊息的普通 CCD instance。其行為完全由專案目錄的 `CLAUDE.md` 定義：

```markdown
# General Assistant

你是這個 CCD fleet 的通用入口。

## 行為準則

- 簡單任務（搜尋、翻譯、一般問答）：自己處理。
- 屬於特定專案的任務：用 list_instances() 找到對應 agent，需要時用 start_instance() 啟動，再用 send_to_instance() 委派。
- 需要多個 agent 協作的任務：協調各 agent 並行或串行執行，收集結果後彙整。
- 使用者想開新的專案 agent：用 create_instance() 建立。
- 收到其他 instance 委派的任務時，完成後一定要用 send_to_instance() 回報結果。

## 委派原則

只在有具體理由時才委派：
- 任務需要存取特定專案的檔案
- 任務可以從多 agent 平行執行中受益
- 保留自己的 context 更重要，把不相關的工作交出去
- 絕不把任務回委給委派你的 instance

自己能做的，就自己做。
```

**路由機制：** Fleet manager 的 `handleInboundMessage` 目前將 `threadId == null` 視為 General Topic，路由到 `topicCommands.handleGeneralCommand()`。General instance 需要改為接收這些訊息。實作時需調查 Telegram 對 General Topic 的 thread ID 是 `null`、`1` 還是其他值，並據此路由。

**與 slash command 共存：** 現有的 slash command（`/open`、`/new`、`/meets`、`/debate`、`/collab`、`/status`）保持運作。General instance 接收所有 General Topic 訊息。以 `/` 開頭的訊息由現有 command handler 和 General instance 同時處理。隨著 General instance 能力驗證充分後，slash command 可在後續迭代中逐步廢棄。

不需要特殊程式碼、不需要 `role` 欄位、不需要 routing table。Instance 在執行時透過 `list_instances()` 自動發現可用的 agent。

## 不包含在本設計中的項目

- **移除 `/meets`、`/debate`、`/collab`** — 這些指令實作了複雜的邏輯（ephemeral instance、git worktree、角色分配），無法僅靠 `send_to_instance` 複製。它們與 General instance 共存，待協作功能驗證充分後再考慮廢棄。
- **跨 instance 的 request-response 協議** — Agent 使用 `send_to_instance()` 傳送請求和回應。關聯性由 Claude 的語意理解處理，而非技術協議。
- **Dispatcher 角色或 routing table** — 沒有特殊的 instance 類型。General instance 只是一個使用通用 prompt 的普通 instance。
- **fleet.yaml 中的 `description` 欄位** — `working_directory` 已足夠讓 Claude 推斷 instance 的用途。

## 風險

| 風險 | 緩解措施 |
|---|---|
| Agent 委派後忘記回報 | 在每個 instance 的 CLAUDE.md 加入 prompt 規範：「收到其他 instance 的任務後，完成時一定要用 send_to_instance() 回報結果」 |
| General instance 在多 agent 協調期間觸發 context rotation | 保持 General instance 輕量（不做重度 coding）。將 rotation threshold 拉高到 80%。接受進行中的協調可能在 rotation 時遺失——使用者可以重新請求。 |
| `create_instance` 中途失敗（例：topic 已建但 instance 啟動失敗） | 依序回滾：反向復原已完成的步驟。每個回滾步驟使用現有的 fleet manager 程式碼。 |
| 循環委派（A → B → A） | Prompt 規範：「絕不把任務回委給委派你的 instance」 |
| Agent 不必要地委派（自己能做的也丟給別人） | Prompt 指引：「只在無法存取目標專案檔案或需要平行處理時才委派」 |
| 對已停止的 instance 使用 `send_to_instance` 造成困惑 | 改善錯誤訊息，告知 agent 使用 `start_instance()` |

## 實作範圍

| 變更項目 | 複雜度 |
|---|---|
| `start_instance` MCP tool + daemon handler + fleet manager handler | 小 — 遵循現有 fleet 路由工具的模式 |
| `create_instance` MCP tool + daemon handler + fleet manager handler | 中 — topic 建立 + config 寫入 + 啟動 + 回滾 |
| 增強 `list_instances` 回應，加入 status + working_directory | 小 — 合併 fleet config 與運行中 daemon 狀態 |
| 改善 `send_to_instance` 對已停止 instance 的錯誤訊息 | 微小 |
| General Topic instance 在 fleet manager 中的路由 | 小 — 將 General Topic 訊息路由到指定 instance |
| General Topic instance 設定 | 純設定 — working directory + CLAUDE.md |
