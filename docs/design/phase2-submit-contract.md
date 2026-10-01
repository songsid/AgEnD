# Phase 2：submit-contract — 可靠的 auto-pause → wake → 投遞

狀態：設計草案（未實作）。base：main `c5b269c4`。
方向：sol 的減法設計——**一次 send，系統負責喚醒＋投遞**，收進單一 per-target durable-queue worker。
範圍：只做 Phase 2（可靠喚醒）。Phase 1（移除 General uncertain 噪音）依使用者決定不做，uncertain 照舊保留，當作投遞問題的訊號。

## 0. 要修的三件事（根因與證據見 cid-1790837458171-wd3jvm）

| # | 現象 | 根因（code） |
|---|------|--------------|
| Bug1 | 對 paused target 送跨 instance 訊息，回 `waking:true`，但 row 停在 queued/attempt 0，永遠不送 | 只有 marker、沒有 daemon 的 target，`claimNext` 的 eligibility 需要 `daemons.get(t)?.bootId`（fleet-manager.ts:1020），沒有 bootId 就 `continue`（delivery-outbox.ts:834）。唯一會喚醒的地方在 `deliverWithIdleGate`（:2144），而它在認領**之後**才會跑，於是死結。`waking:true`（outbound-handlers.ts:570）只是一個標籤。 |
| Bug1' | restart 讓 paused instance 更醒不來 | `doRestartSingleInstance` 是 `stopInstance` → `startInstance(name, cfg, topicMode)`，沒帶 `resumePaused`。marker 還在，所以走到 :2470 skip，記憶體內 paused 被降級成只剩 marker。 |
| Bug2 | 醒了 1–2 秒又被 auto-pause | `AutoPauseController.lastActivityAt` 以 `readLastInboundAt` 初始化（daemon.ts:1550），而且只有帶 chat_id 的使用者 inbound 會更新（:5021）。跨 instance 的工作不算 activity，新 daemon 也不會走 `markAwake`。doupo-dev-claude 的 last-inbound 停在 09-24，超過 10000 分鐘門檻，所以一 ready 就被 pause（14:46:42→44、14:48:08→09）。 |

## 1. 角色：`TargetQueueWorker`（每個 target 一個）

### 1.1 單一擁有者
- FleetManager 持有 `Map<targetInstance, TargetQueueWorker>`，在 admission、開機 recovery 或 `listPending` 掃描時 lazy 建立。**一個 target 同時最多一個 worker**，這是 map 的不變式，worker 自己也會檢查 map 裡的是不是自己。
- 某個 target 的 durable row，**只有它的 worker 能 claim**。舊的 `runDeliveryOutboxPump` 縮成「掃描並喚醒 worker」：它不再 claim、也不再 dispatch。過渡期的劃分見 §4。
- **pane 只有 daemon 會寫**（現狀保持）。worker 從不碰 tmux；它只把一筆已 claim 的 row 透過 IPC 交給 daemon，由 daemon 做 begin → paste → Enter → complete 的 fenced 轉換。所以「雙寫 pane」只可能來自同一筆 row 被兩個 dispatcher 各自交一次。§4 用 ownership 劃分加上 SQLite claim 的 fence 堵住這條路。

### 1.2 狀態機（一個 worker 同時只處理一筆 head row）

```
IDLE ──(queue 非空)──► ENSURE_AWAKE ──► WAIT_ACCEPTING ──► CLAIM ──► HANDOFF ──► AWAIT_RESULT ──► IDLE
          ▲                 │ wake 失敗                 │ 不接受           │ before-begin 失敗
          └── retry_wait ◄──┴──────────────────────────┴──────────────────┘
```

1. **ENSURE_AWAKE**：只要 target 有 queue 非空的 row 就進來，依 `kind` 的 wake policy 決定是否喚醒（見 1.4）。
   - 判斷 `lifecycle.isPaused(t)`，記憶體內 paused 和只有 marker 兩種都算。是的話呼叫 `lifecycle.wake(t)`，**透過 single-flight 呼叫**（見 1.3）。
   - 喚醒成功後，`enforceWarmCap(t)` 排除自己，也排除所有有 pending work 的 target。
2. **WAIT_ACCEPTING**：等 daemon 說「可以接收」。worker **不自己判斷 pane**，而是問 daemon 的權威狀態：
   - 已註冊、IPC 已連線、`pauseWakeState==="active"`；
   - 不在 `inputBlockedDialog`、auth 或 rate-limit 的 hold、`InputUnavailableTransient`、storm hold 之中；
   - 跨 instance 的 row 另外還要過現有的 idle gate（`waitForInstanceIdle`，60 秒逾時後照現行邏輯 force）。
3. **CLAIM**：拿 target **當下**的 `daemon.bootId` 呼叫 `claimNext`，限定只 claim 這個 target 的 head row。沿用現有 fence：`manager_boot_id`、`target_daemon_boot_id`、`attempt_no+1`。
4. **HANDOFF**：送 IPC。daemon 端照現行邏輯 `begin()` → `markEnterStarted()` → `complete()`。
   - IPC 斷線但還沒 begin：`retryBeforeBegin`，用退避重試。
   - 已經是 `submission_started` 卻失聯：標成 `uncertain`，**絕不重送**。
5. **AWAIT_RESULT**：等 row 離開 `delivering`/`submission_started`。沿用 `waitForDurableLaneRelease` 和 lane 告警，結束後才處理下一筆。所以 FIFO 是每個 target 嚴格一次一筆。

### 1.3 單一 wake-flight
- 在 `InstanceLifecycle.wake` 加 `wakeFlights: Map<name, Promise<void>>`。同名的並行 `wake()` **共用同一個 promise**；不論成功或失敗都在 `finally` 刪掉。
- 所有喚醒來源都匯到這裡：worker、顯式 `/wake` 和 `wake_instance`、使用者訊息走的 `deliverToInstance`、`startInstance(resumePaused)`。現在 daemon 內部有 `pauseWakeTransition`，但只有 marker 的那條路（`startPersistedPausedInstance`）沒有 single-flight，兩個來源可能同時 `startInstance`。
- 全域喚醒併發上限 `WAKE_CONCURRENCY`（建議 2，跟 SpawnGate 對齊）。超過上限就排隊，不丟。

### 1.4 wake policy（避免把「不需要醒」的通知變成喚醒風暴）

| row kind | 會喚醒 paused target？ |
|---|---|
| `fleet_inbound` task/query/report、`steer`、`raw_paste`（schedule） | 會 |
| `fleet_inbound` update（純通知） | 會（sender 預期對方看得到）。可以設定成不會，預設會 |
| `delivery_outcome_notice`、`post_restart_outcome_notice` 等系統通知 | **不會**。留在 queue，等 target 下次因為別的原因醒來時一起送（FIFO 不變） |

### 1.5 送出端的回應
`send_to_instance` 等回應中的 `waking:true` 改成 `wake: "triggered" | "not_needed" | "deferred_by_policy"`。為了相容，暫時保留 `waking` 欄位、值相同，下個版本再拿掉。

## 2. 保留與收斂

**全部保留（不改語意）：**
- SQLite admission、`operation_id` 穩定 key、`duplicate` 去重（outbound-handlers.ts:456）。
- 每個 target 的 FIFO：`claimNext` 照 `created_at` 排序，限定 head。
- daemon 端的最後防線：輸入框驗證、ready 和 dialog hold、`InputUnavailableTransient`、送出證明（#745/#757/#759）。
- 世代隔離：begin 時帶 `targetBootId`、`attemptNo`，stale ACK 拒收；`recoverForBoot`、`recoverTargetGeneration`、reconciliation。
- `uncertain` 保守處理：`submission_started` 之後失聯就標 uncertain，絕不重送。
- delivery epoch 取消（使用者 cancel）、storm hold、lane 告警、`expireStale`。
- #856 `delivery_status` 來源核驗；破壞性操作前的核驗規則不變。

**收斂（拿掉的重複機制）：**
- durable 路徑上 `deliverWithIdleGate` 內嵌的喚醒，改為 worker 的 ENSURE_AWAKE 唯一負責。非 durable 的使用者路徑保留呼叫，但改走同一個 single-flight。
- durable 路徑的 `idleGatedDeliveryTails` 和 `ipcWaitTails` 排序，由 worker 的一次一筆 FIFO 取代。非 durable 的使用者訊息照舊用它們。
- pump 的 `activeDurableTargets` 改由 worker map 取代：存在 worker 就代表該 lane 有人擁有。

**本階段不做：** 把使用者訊息也搬進 outbox。它們不經 outbox，只共用 single-flight 喚醒，外加 §3.4 的失敗重試。

## 3. 具體修法

### 3.1 Bug1：queue 非空就喚醒，只有 marker 的也要喚醒
- pump 不再以「有 bootId」作為門檻去 claim。它只負責：對 `listPending()` 裡每個有 row 的 target，確保有 worker 而且被喚醒。
- worker 的 ENSURE_AWAKE 同時處理記憶體內 paused 和只有 marker 的情況。`lifecycle.wake` 已經會處理只有 marker 的，呼叫 `startPersistedPausedInstance`。
- **開機時**，`recoverForBoot` 之後掃一次 pending：只有 marker、而且 queue 非空的 target，交給 worker 喚醒，受 `WAKE_CONCURRENCY` 限制。目前開機時 :2470 會直接 skip，又沒人接手，這就是 Prism 10:20、doupo-dev-claude 14:47 那兩次的情況。
- **喚醒失敗：**
  - row 維持 `queued`。它沒有被 claim，`attempt_no` 也**不加**；另外記 `wake_attempts` 和 `last_wake_error`，供告警和 `delivery_status` 使用。
  - 退避 1s→2s→…→60s。
  - 連續 3 次失敗就通知 target topic 和 sender topic 一次：「X 喚醒失敗：<原因>，訊息仍在佇列」。
  - 一直失敗的話，到 `DURABLE_DELIVERY_MAX_AGE` 由 `expireStale` 轉成 failed，原因寫 `target could not be woken`。不會靜默。
- **看門狗**：paused target 的 head row 超過 2 分鐘沒被 claim 就告警一次。這條是兜底，正常情況不會觸發。

### 3.2 Bug1'：restart 不降級
在 `doRestartSingleInstance` 開頭記下 `wasPaused = lifecycle.isPaused(name)`，再依情況處理：
- restart 是操作者的顯式動作，所以**視同喚醒**：stop 之後 `clearPausedMarker`，再用一般 start。結果是 running，絕不會只剩 marker。
- 如果產品上希望「restart 之後保持 paused」，就改走 `stop` → `startInstance(..., resumePaused=false)`，並且在 start 之後保留記憶體內的 paused daemon，也就是 daemon 起來但不 spawn CLI。這比較複雜，**不建議**。
- 建議採第一種：restart 等於醒著重啟，也符合使用者「我按 restart 就是要它動」的預期。

### 3.3 Bug2：真的有工作才算活動，有 pending 就不 pause，新 daemon 不繼承舊時間戳
1. **把工作算進 activity**：daemon 在 durable row `complete(delivered)`、`raw_paste` 送達、跨 instance `fleet_inbound` 送達時，都呼叫 `recordActivity(now)` 並持久化。檔名沿用 `last-inbound-at`，語意改成 last-activity，保持相容。使用者 inbound 照舊。
2. **有 pending 就擋 pause**：daemon 拿到一個 port `hasPendingWork(): boolean`，由 FleetManager 提供。只要該 target 有 `queued`/`retry_wait`/`delivering`/`submission_started` 的 row，或者它的 worker 不是 IDLE，就回 true。
   - `pause()` 現在只看 `pasteQueueDepth`，要多看這個。
   - warm cap 的 victim 選擇也排除 `hasPendingWork` 的 instance。
3. **新 daemon 不繼承舊時間戳**：
   - `Daemon` 建構子多一個參數 `activitySeed: "persisted" | "now"`。
   - 只有 **fleet 開機的 startAll** 用 `persisted`，保留「長期閒置的 instance 重開後仍會被 pause」這個既有語意（daemon.ts:241 的註解）。
   - wake、restart、`startPersistedPausedInstance`、顯式 start 一律用 `now`。

### 3.4 使用者訊息路徑（小範圍）
- `deliverToInstance` 非 durable 的路徑喚醒失敗時，同一個 single-flight 退避重試一次。
- 仍失敗就在 topic 寫出明確原因（「喚醒失敗：<原因>」），不要只標 ❌。

## 4. 分段切換計畫

feature flag：`defaults.delivery_worker: off | wake_only | on`，也可以覆寫到個別 instance，方便金絲雀。

| 段 | 內容 | 誰寫 pane／誰 claim | 驗收 | rollback |
|---|---|---|---|---|
| **2a** | Bug2（§3.3 三項）、Bug1'（§3.2）、`InstanceLifecycle.wake` single-flight（§1.3）。不動 dispatcher | 舊 pump（不變） | ① 跨 instance 送達後 last-activity 被更新；② 有 pending row 時 `pause()` 不動作；③ wake 或 restart 出來的新 daemon，在門檻內不會 pause（重現 14:48:08→09 的情境要變綠）；④ restart 一個 paused instance 後是 running、而且沒有 marker；⑤ 兩個並行 wake 只會 spawn 一次 | 單純 revert（無 schema 和狀態變更） |
| **2b** `wake_only` | 新增 worker，但**只做 ENSURE_AWAKE**：queue 非空、而且是 paused 或只有 marker，就喚醒，加開機掃描、失敗退避和告警、看門狗。claim 和 dispatch 仍由舊 pump 負責；daemon 有 bootId 之後，pump 自然就能 claim | 舊 pump | ① 只有 marker 的 target 收到跨 instance 訊息 → 自動喚醒 → 送達（**Bug1 的 regression**）；② 開機時只有 marker、queue 非空 → 被喚醒；③ 喚醒失敗 3 次 → 兩邊 topic 各收到一次告警，row 仍 queued，`attempt_no` 不變；④ 系統通知類 row 不會喚醒；⑤ 10 個 target 同時需要喚醒時，同時 spawn ≤ `WAKE_CONCURRENCY` | flag 改 `off`（worker 不建立）。沒有 claim 權，切換時沒有雙寫風險 |
| **2c** `on`（金絲雀） | worker 接手 claim、handoff 和 result；pump 只負責喚醒 worker。**ownership 劃分**：pump 每次 claim 前檢查 `workerOwns(t)`，被 worker 擁有的 target 一律 skip。worker 只在該 target 沒有任何 `delivering`/`submission_started` row 時才取得 ownership（lane 為空才切） | worker（金絲雀 instance）／舊 pump（其他） | ① 同一 target 不會同時出現兩個 `delivering`（DB 不變式測試，加上並行壓測）；② FIFO：3 筆依序送達；③ 舊 attempt 的 ACK 對新 attempt 被拒（stale）；④ `submission_started` 後砍掉 IPC → uncertain，不重送；⑤ busy 或 dialog 時不送；⑥ 金絲雀跑 1–2 天，fleet.log 沒有 `still waiting`、沒有重複送達 | flag 改回 `wake_only`。worker 只在 lane 為空時釋放 ownership；已 claim 的那筆讓它走完（fence 保證不會由另一方重送） |
| **2d** | 預設 `on`，一個版本之後刪掉舊 pump 的 claim 和 dispatch 程式碼，以及 durable 路徑的 idle-gate tail | worker | 全套 CI、2c 的驗收清單再跑一次 | 刪 code 之前隨時可以退回 `wake_only` |

**為什麼不會雙寫 pane：**
1. pane 只有 daemon 會寫。
2. 一筆 row 只能被 claim 一次：SQLite `UPDATE ... WHERE state IN ('queued','retry_wait')` 加上 `changes===1`。
3. 一個 target 只有一個 claimer：worker map 加上 pump 的 `workerOwns` skip，而且只在 lane 為空時才轉移 ownership。
4. daemon 的 begin 有 `(deliveryId, bootId, attemptNo)` fence，重複的會得到 `duplicate`/`stale`。

四層任何一層單獨成立，都已經足以防止重複 paste。

## 5. 風險清單

| 風險 | 怎麼發生 | 防護 |
|---|---|---|
| 重複提交 | 新舊 dispatcher 同時處理同一 target；或 IPC 斷線後重送已經 begun 的 row | §4 的四層防護。`submission_started` 之後只會變 uncertain，不會重送。測試：並行 claim、begin 之後斷 IPC |
| FIFO 退化 | 一筆 head row 卡住，擋住整個 target | 刻意保持嚴格 FIFO、不跳號。head 卡住時有 lane 告警（現有）和看門狗。操作者可以用 delivery_status 或 cancel 處理 |
| 舊 ACK 被當成新 attempt | 舊 daemon 世代或舊 attempt 晚到的 complete | 沿用 `(bootId, attemptNo)` fence，complete 時對不上就拒收（現有）。worker 永遠不重用 attemptNo。加一條 regression：attempt N 的 ACK 在 N+1 開始後才到 → 拒收 |
| busy 或 dialog 被誤放行 | worker 自己判斷「ready」 | worker 不讀 pane，只問 daemon 的權威狀態。daemon 的 begin 仍會在 dialog 或輸入框不可用時 defer，最後一道防線不變 |
| 喚醒風暴 | 開機時大量只有 marker 的 target 都有 pending；系統通知互相喚醒 | `WAKE_CONCURRENCY`、wake policy（系統通知不喚醒）、warm cap（有 pending 的不會被當成 victim。但如果 pending 的 target 數超過 cap，就讓 cap 暫時超標並記 log，**不**為了守 cap 而延遲投遞。這點請使用者確認） |
| sender 也離線 | 回覆或結果寄給一個 paused 的 sender | 回覆本身就是一筆 durable row，寄給 sender 的 worker，依 wake policy 處理：report 會喚醒，系統 outcome notice 不會。不需要特殊處理 |
| 喚醒後又被 pause（Bug2 的變形） | 喚醒到 claim 之間 idle 計時到了 | `hasPendingWork` 擋 pause，新 daemon 用 `activitySeed=now` |
| 切換期的狀態不一致 | flag 在 lane 忙碌時切換 | ownership 只在 lane 為空時轉移；已 claim 的 row 由原 claimer 走完 |

## 6. 不在範圍內
- Phase 1（uncertain 噪音）。
- 把使用者訊息搬進 outbox。
- warm cap 的策略調整（只做「有 pending 的不當 victim」）。
