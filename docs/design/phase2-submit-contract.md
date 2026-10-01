# Phase 2：submit-contract — 可靠的 auto-pause → wake → 投遞

狀態：設計草案 v4（未實作）。base：main `c5b269c4`。
v2 依 sol 複審（cid-1790841023206-uaa7pa，P1-1…P2-3）修訂；v3 再補上 P1-3（lease 的界限）、P1-6（原子 reservation）、P1-5（epoch 傳到發布點）；v4 補齊 resident wake 的名額轉換，以及顯式 wake 對 park 的覆蓋。每段標出對應的 finding。

方向：sol 的減法設計。一次 send 就好，喚醒和投遞都由系統負責。

範圍：只做 Phase 2，也就是可靠喚醒。Phase 1（移除 General uncertain 噪音）依使用者決定不做，uncertain 照舊保留，當作訊號。

**v2 的核心區分**（sol 指出 v1 把這幾件事混在一起）。以下四個條件**各自獨立判定**，任一個都不能拿來推導另一個：
1. queue 裡有 row；
2. 有需要喚醒的工作；
3. lane 已授權給某個 dispatcher；
4. 舊 pane writer 已經停止。

## 0. 要修的事（根因與證據見 cid-1790837458171-wd3jvm）

| # | 現象 | 根因（code） |
|---|------|--------------|
| Bug1 | 對 paused target 送跨 instance 訊息，回 `waking:true`，但 row 停在 queued/attempt 0 | 只有 marker、沒有 daemon 的 target：`claimNext` 需要 `daemons.get(t)?.bootId`（fleet-manager.ts:1020），拿不到就 `continue`（delivery-outbox.ts:834）。唯一的喚醒點在認領**之後**（`deliverWithIdleGate` :2144），所以形成死結。 |
| Bug1' | restart 讓 paused instance 更醒不來 | `doRestartSingleInstance` 走 stop → `startInstance` 時沒帶 `resumePaused`，marker 還在，於是在 :2470 被 skip，變成只剩 marker 的狀態。 |
| Bug2 | 醒了 1–2 秒又被 auto-pause | `lastActivityAt` 用 `readLastInboundAt` 初始化（daemon.ts:1550），而且只有使用者 inbound 會更新它（:5021）。新 daemon 不會走 `markAwake`。 |

## 1. 角色

### 1.1 三個獨立的 owner

| 職責 | owner | 說明 |
|---|---|---|
| **喚醒**（決定和執行） | `WakeCoordinator`（每個 fleet 一個，內部依 target 分開） | 唯一會對 durable work 呼叫 `lifecycle.wake` 的地方。single-flight，帶世代（1.3） |
| **claim、handoff、result**（lane） | **授權給它的那一個 dispatcher**：2b 之前是舊 pump，2c 開始是該 target 的 `TargetQueueWorker` | 明確的 `laneOwner` 授權，不從 flag 或 worker 存在與否推導（P1-4） |
| **寫 pane** | 該 target 當下世代的 daemon | 現狀不變：begin → paste → markEnterStarted → complete，全部有 fence |

### 1.2 喚醒判定看整條 queue，不只看 head（P1-1）
- `needsWake(t)` 成立的條件：target paused（記憶體內 paused 或只剩 marker），**而且它的整條 pending queue 中至少有一筆 wake-eligible 的 row**。
- 醒來之後照樣**從 head 依 `created_seq`** 一筆一筆 drain，不跳號。passive 的 row 會在醒著的期間順便送掉。
- **逐類定義**。現有 kind 全部需要執行，所以全部 wake-eligible：

  | kind | 內容要求的動作 | wake-eligible |
  |---|---|---|
  | `fleet_inbound`（task/query/report/update） | 執行或閱讀 | 是 |
  | `steer` | 補充進當前 turn | 是 |
  | `raw_paste`（schedule） | 執行排程 | 是 |
  | `delivery_outcome_notice` | 要求回報失敗 | 是 |
  | `post_restart_outcome_notice` | 要求找 operator 查狀態 | 是 |
  | `reply_obligation_notice` | 要求續做並 report_result | 是，而且絕不能被永久延後 |

- passive 這個類別**保留但目前是空的**。日後新增的 kind 要宣告成 passive，必須同時提供一條不靠喚醒的可見路徑（例如 topic 通知），經 review 後才能加入。
- 喚醒風暴改由 SpawnGate 和常駐上限（1.6）處理，不靠「通知不喚醒」。

### 1.3 喚醒：single-flight，帶世代（P1-5、P2-1）
- `WakeCoordinator.ensureAwake(t)` 對同一個 target 只會有一個 flight，所有喚醒來源都匯到這裡：durable work、顯式 `/wake` 和 `wake_instance`、使用者訊息路徑、`startInstance(resumePaused)`。
  - 在 2b，durable 路徑上 `deliverWithIdleGate` 內嵌的喚醒會**被移除**，因為 pump 不再 claim 尚未醒著的 target（見 §4 2b），所以不會疊出兩套互不知道對方的 retry timer。
- **世代與 transition 順序**（v3，P1-5）：只在 flight 完成時檢查 epoch 是不夠的。現行 `InstanceLifecycle.start` 在 `startOrDispose` 之後就立刻 `daemons.set` 並呼叫 `onDaemonReady`（instance-lifecycle.ts:1313–1315），這發生在外層 wake flight 返回之前，所以晚到的舊 start 有機會先蓋掉 replacement。因此：
  - **每個 target 一條 transition 序列**（`TransitionQueue`，per-target mutex）。start、stop、restart、wake 都排進這條序列，彼此不並行。SpawnGate 對同一個 instance 的 reentrant 分支**不能**拿來當這個互斥。
  - **epoch 一路往下傳到 startup**。`lifecycleEpoch` 在 stop、restart、delete 時同步 +1，作用是讓既有的進行中工作失效。start 會拿到一個 epoch token，daemon 的 start 收到 `isCurrent()`。
  - 以下每一個**共用副作用**發生之前都要同步核對 `isCurrent()`：bind socket（`channel.sock`）、寫 `window-id`、rename tmux window、`daemons.set`、`onDaemonReady`、fleet 端的 IPC 連線。
  - 一旦不是當前世代，就不發布（publish），並用自己的 handle 執行 `abortStartup` 收掉自己 spawn 出來的 CLI。所以舊世代**永遠不可能註冊、覆蓋或清掉 replacement**，不必事後再靠 `stopIfCurrent` 補救。
  - **restart 或 stop 遇到進行中的 wake 或 start**，依序：
    1. 同步把 epoch +1（invalidate）；
    2. 等舊 spawn settle。`trySpawn` 不能從外部取消，所以只能等；它在發布點會看到 stale，自行 dispose；
    3. 然後才開始 replacement（或 stop）。
  - **顯式 wake 遇到 restart**：join 那個 restart transition，結果就是 restart 的結果，不另開 flight。遇到 stop：回「已停止」，不會喚醒。
- **併發**：直接沿用 SpawnGate。wake 走 `trySpawn`，本來就會經過 SpawnGate，所以**不另外新增 WAKE_CONCURRENCY**。
- **重試語意**（只有 coordinator 會排）：
  - 失敗後依 1s→2s→…→60s 退避，退避期間 target 標成 `wakeBackoff`。
  - 每個 target 的退避期間只發一次可見通知：target topic 加 sender topic，內容是「X 喚醒失敗：<原因>，訊息仍在佇列」。
  - 一直失敗下去，最後由既有的 `expireStale` 轉成 failed，原因寫 `target could not be woken`。
  - 喚醒失敗時 **row 不會被 claim，`attempt_no` 也不會增加**；這個保證從 2b 起成立（P2-1）。
- **auth 造成的 pause 不會自動喚醒**：pause marker 會記錄原因 `idle | warm_cap | operator | auth`。
  - `auth` 這一類只發一次通知「X 因登入失效暫停，有 N 筆待送」，等操作者處理。顯式 wake 可以覆蓋。
  - 這樣可以避免「auth 壞了 → 叫醒 → 再次因 auth pause → 又叫醒」的迴圈。
  - `idle`、`warm_cap`、`operator` 三類照現行文件說明（「傳訊息通常會開始喚醒」），會自動喚醒。

### 1.4 WAIT_ACCEPTING：權威來源與期限（P2-2）
- 權威來源是 daemon 在**同一個 process** 內的查詢 `acceptingState()`，它回傳 `{ accepting, reason, bootId, observedAt }`。
  - 結果綁定 `bootId`：bootId 不一致就作廢，重新查。
  - 在 claim 前的**同一個同步區段**內再查一次。
  - daemon 的 `begin()` 仍然是最後一道 recheck。
  - 不新造任何 pane detector，最終的 UI 判斷仍然交給 daemon。
- **明確保留**的額外 gate：跨 instance 的 manager idle gate（`waitForInstanceIdle`，60s，逾時後照現行 force）。`steer` 不走這個 gate，`raw_paste` 照現行 `waitForIdle:false`。這屬於「保留」，不屬於「收斂」。
- **claim 之前的阻塞也要可見**：任何 target（不只 paused 的）只要 head 有 wake-eligible row，而且 `accepting=false` 持續超過 5 分鐘，就對**每一段阻塞**發一次通知，附上 reason（例如 dialog、auth hold、rate limit）。
  - 這取代 v1「只看 paused 的 2 分鐘 watchdog」。

### 1.5 lane 的組合不變式（P1-4、P1-2）
v1 寫「任一層單獨足以防重複 paste」，這是錯的。`claimNext` 是對單一 row 的 CAS，並不阻止同一個 target 的兩筆不同 row 同時被 claim；row 經過 retry 之後也能再次被 claim。正確的保證是**以下四條同時成立**：
1. **lane owner**：每個 target 只有一個 `laneOwner`（`"pump"` 或某一個 worker 實例），由 `grantLane` 和 `releaseLane` 管理。
2. **一次一筆**：owner 在一筆 row 還沒釋放 lane（1.5-B）之前，不 claim 下一筆。
3. **attempt/generation fence**：`(deliveryId, targetBootId, attemptNo)` 對不上就拒絕 begin、markEnter、complete（現有）。
4. **不重播未知提交**：`submission_started` 之後絕不重送。

**1.5-A ownership 的轉移**（P1-4）：
- `desiredMode`（flag）和 `grantedOwner`（實際 owner）分開存放。
- 「lane 為空的檢查 → grant → claim」必須在**同一個同步區段**內完成，中間沒有 `await`。SQLite 是同步的，做得到。
- 轉移只在 lane 為空時發生。flag 改變不會搶走正在 drain 的 owner：舊 owner drain 完它已 claim 的 row 之後才 release。
- worker 本身也要防重入：同一個物件只有一個 drain loop promise。

**1.5-B lane 何時釋放：transport 斷了不等於 writer 結束**（P1-2）：
- daemon 和 manager 在同一個 process。IPC socket 斷了，**不代表 daemon 的 async paste 已經停止**。
- 規則：row 進入 `submission_started` 之後，lane 只會因為以下其中一件事而釋放：
  - (a) daemon 回報結果（`complete`）。改成用 in-process port 直接查 daemon，不依賴 socket。
  - (b) 該 daemon 世代確定結束：daemon 已 stop 或 dispose，pane writer 已 drain，`lifecycleEpoch` 已前進。之後走現有的 `markTargetReconciliationPending` 和 reconciliation。
- manager **不再**因為 transport 錯誤就自己把 `submission_started` 標成 `uncertain` 並釋放 lane（現行 dispatchDurableDelivery 的 catch 就是這麼做的）。
  - 改成：標記 `reconciliation_pending`，lane 保持占用，等 (a) 或 (b) 發生。
  - 等太久就走現有的 lane 告警，可見但不釋放。
- `recoverForBoot` 和 `recoverTargetGeneration` 的 reconciliation 語意完全保留。
- uncertain 只表示「這一筆不重送」，**不能**拿來證明 pane 可以接著用。

### 1.6 常駐上限與 eviction（P1-3、P1-6）
- **work lease 分成兩段**（v3，P1-3）。lease **只擋** idle auto-pause 和 warm-cap eviction。auth-deferred pause（`allowStuck`）、操作者的 pause/stop，以及其他既有的安全流程**完全不受影響**。
  - **pre-claim lease（有界）**：從 coordinator 喚醒成功、或 owner 開始處理一個醒著的 target 的 head 起算。上限是 `PRECLAIM_LEASE_MS`，等於跨 instance 的 idle gate 60s 加 60s grace，也就是 2 分鐘。下列**任一**事件發生就結束：
    - (a) claim 成功：轉成 submission lease；
    - (b) WAIT_ACCEPTING 看到非暫態的 hold，例如 dialog、auth、rate-limit 或 storm，以 daemon `acceptingState.reason` 為準：釋放 lease，進入 park；
    - (c) 逾時：釋放 lease，進入 park；
    - (d) cancel，例如 delivery epoch cancel、row 過期、target 的 lifecycleEpoch 前進：釋放 lease，不 park。
  - **park**：釋放之後，target 帶著 `{reason, until}` 進入 parked。parked 期間 coordinator **不會**再次喚醒它、也不會再取得 lease，**新 admission 也不例外**。這樣就不會形成「醒 → 被 hold → 被 evict → 馬上又醒」的迴圈。parked 的 target 和一般 instance 一樣可以被 idle eviction。離開 park 只有兩種方式：
    - 對 hold 型的 park，daemon 回報 `accepting` 的上升邊緣，也就是 hold 解除。只有 target 還常駐時才可能發生；
    - park 退避到期。退避時間從 1 分鐘開始，每次 ×2，最長 30 分鐘。只要成功送出一筆，退避就歸零。
  - **park 只擋自動喚醒和新 admission**（v4）。顯式 wake 和 restart（操作者，延續 1.3 的「顯式 wake 可覆蓋 auth pause」）會立刻主動嘗試**一次**。這次嘗試照樣走同一條 `TransitionQueue`、`CapacityLedger` 和 epoch fence，**不會**繞過名額或世代檢查。
    - 嘗試成功就清除 park；
    - 仍然失敗或又遇到 hold，就重新 park，退避**不歸零**。顯式動作不會因此解開自動喚醒的緊密迴圈。
    - claim 前的阻塞告警（1.4）仍然照發，每一段阻塞發一次。
  - **submission lease（不限時）**：從 claim 起，到該 row 依 1.5-B 釋放 lane 為止。**沒有逾時**。lease 的任何計時都**不會**釋放 writer lane 或 reconciliation lane，lane 只依 1.5-B 的規則釋放。
- 只是 queue 裡有 row、但沒有 lease 的 target，包括 parked、在長時間 backoff 中、或日後的 passive-only，**照常可以被 idle eviction**。row 不會遺失。
- **常駐數要有界**：
  - warm cap 是 soft cap。為了 lease 可以暫時超標，但有硬上限：`warm_cap + overflow`，`overflow` 預設 2，可設定。
  - **原子 reservation**（v3，P1-6）：`CapacityLedger` 同步記錄兩樣東西：`resident`（沿用 warm cap 現行對 warm 的定義，也就是醒著、非 general 的 instance）和 `reserved`（已經取得名額、但還沒轉成常駐的 start，key 是 `{target, epoch, token}`）。
    - `ensureAwake` 在**第一個 await 之前**同步呼叫 `tryReserve(t)`：
      - t 已經常駐：不需要名額；
      - `resident + reserved ≥ 硬上限`：不 spawn，進入 `capacity_wait`。等待者依各自最舊 pending row 的 `created_seq` 排序，名額釋放時由最前面的取得；
      - 否則取得一個名額。
    - **成功時把名額轉成 resident，兩條路徑共用同一份 token promotion 契約**（v4）：
      - **cold start**（只剩 marker）：在 1.3 的發布點，也就是通過 `isCurrent()` 之後、與 `daemons.set` 同一個同步區段內完成。
      - **resident wake**（daemon 一直留在 map 裡，走 `Daemon.wake`，**不會**再經過 `daemons.set`）：在通過 epoch fence、`pauseWakeState` 轉成 `active` 的同一個同步區段內完成。
      - 兩條路徑都是「reserved 減一、resident 加一」，用 token 冪等保證只算一次。之後這個 instance 再被 pause 或 stop 時，resident 減一，名額可以給下一個 target 用。
    - **失敗、stale epoch、cancel**：spawn promise **settle 之後**才歸還名額，而且只歸還一次（token 冪等）。spawn 一旦開始，**絕不因逾時提前歸還**，因為 spawn 無法取消。
    - 所有經 coordinator 的喚醒來源都共用這套 admission，包括 durable、使用者訊息路徑、`startInstance(resumePaused)`。
    - **顯式 wake**（操作者）一樣要取得名額。名額滿時先依現行 `enforceWarmCap` 驅逐一個沒有 lease 的 LRU idle instance，**等它真的停掉、resident 減一之後**才 reserve。沒有可驅逐的對象時排進 `capacity_wait`，並回覆操作者「等待名額」。不會繞過硬上限。
  - 到達硬上限時，coordinator **等待**：不喚醒新的 target，row 留在佇列。資源釋放後再繼續。
  - `warm_cap=0`（未啟用）時沒有常駐上限，這是現行行為。只靠 SpawnGate 的 low-memory 檢查。
  - SpawnGate 的 low-memory 分支目前只在 `active>0` 時才生效，所以它不能當作常駐數的硬保證。這點要在文件和設定說明中寫清楚，不在本階段修改 SpawnGate。
- **全域 active 預算**：保留原 pump 的 8 筆 active delivery 上限。改成 lane owner 共用的 `activeDeliveryBudget` 計數器，計算已 claim、尚未釋放的 lane。**處於 IDLE 的 worker 不計入**。

### 1.7 送出端的回應（P2-3）
- receipt 以 `accepted`（durable）加 `delivery_id` 為主。
- `waking` **維持 boolean**，語意明定為「admission 當下 target 是 paused 狀態」，不代表任何承諾。
- 不新增 `wake` 狀態欄位，避免多一個可靠性承諾。
- 實際投遞進度一律用 `delivery_status` 查詢。

## 2. 保留與收斂

**保留（語意不變）**：
- SQLite admission、`operation_id` 穩定 key、`duplicate`；
- 每個 target 依 `created_seq` 的 FIFO，同一 timestamp 的 admission 也保持穩定順序（P2-3）；
- daemon 的最後防線（輸入框、dialog、`InputUnavailableTransient`、送出證明）；
- `(bootId, attemptNo)` fence；
- uncertain 不重送；
- `recoverForBoot`、`recoverTargetGeneration`、reconciliation lane；
- delivery epoch cancel、storm hold、lane 告警、`expireStale`；
- #856 來源核驗；
- 跨 instance 的 manager idle gate；
- SpawnGate。

**收斂**：
- durable 路徑上分散在各處的喚醒，統一收進 `WakeCoordinator`；
- `activeDurableTargets` 改由 `laneOwner` 加 `activeDeliveryBudget` 取代；
- durable 路徑的 `idleGatedDeliveryTails` 改由 owner 的一次一筆取代（2c 起）。

**不在本階段**：使用者訊息不搬進 outbox，只共用 `WakeCoordinator`，以及 §3.4 的失敗重試和可見原因。

## 3. 具體修法

### 3.1 Bug1
- coordinator 對 `listPending()` 中所有 `needsWake(t)` 的 target 呼叫 `ensureAwake`（判定看整條 queue，見 1.2）。只剩 marker 的走 `startPersistedPausedInstance`（現有的 lifecycle.wake 路徑）。
- 開機時，在 `recoverForBoot` 之後掃一次：只剩 marker 而且 `needsWake` 的 target 交給 coordinator，受 SpawnGate 和常駐上限限制。
- 2b 起 pump **只 claim「醒著而且 accepting」的 target**。paused、waking、`wakeBackoff` 的 target 一律不 claim。所以 `attempt_no` 不會因為喚醒失敗而增加。

### 3.2 Bug1'：restart 不降級，失敗也不遺失（P1-5）
`doRestartSingleInstance`：
- 先記下 `wasPaused` 和原本的 pause reason。
- stop 之後清掉 marker，然後 start。
- **start 失敗時**：若 `wasPaused`，就寫回 marker，保留原 reason 和 pausedAt（等同 lifecycle.wake 對只剩 marker 的處理），恢復成可以重試的 paused 意圖，coordinator 會接著依退避重試。不會變成沒有 daemon、沒有 marker、也永遠不會再被喚醒的狀態。
- restart 和 wake 走同一條 `TransitionQueue`，epoch fence 一路傳到 startup 的發布點（1.3）。不論何時都**最多只有一個已發布的 daemon，也就是最多一個有效 writer**。一次合法的 restart 依序產生「舊 spawn 自行 dispose，再加一個新 spawn」是允許的。測試要能區分「同一時間的有效 writer 數」和「歷史 spawn 次數」。
- 建議 restart 一個 paused instance 時視同喚醒：成功之後是 running。

### 3.3 Bug2
1. **工作就是活動**：durable row 進入 `complete(delivered)`，或 `raw_paste` 送達、跨 instance `fleet_inbound` 送達時，呼叫 `recordActivity(now)` 並持久化。檔案沿用 `last-inbound-at`，語意擴大為「最後一次活動」。
2. **只在工作期間擋 pause**：work lease 見 1.6。**不是**只要有 pending 就擋全部的 pause（P1-3）。
3. **新 daemon 不繼承舊的時間戳**：`activitySeed` 只有在 fleet 開機的 startAll 時用 `persisted`；wake、restart、`startPersistedPausedInstance`、顯式 start 都用 `now`。

### 3.4 使用者訊息路徑
非 durable 的喚醒失敗時，經由 coordinator 退避重試一次。仍然失敗就在 topic 寫明原因，不只是標 ❌。

## 4. 分段切換計畫

feature flag `defaults.delivery_worker: off | wake_only | on`，可以覆寫到個別 instance（金絲雀用）。flag 只代表 `desiredMode`，實際 owner 依 1.5-A 轉移。

| 段 | 內容 | lane owner | 驗收（每項都是要新寫的測試，不是已經通過的結果） | rollback |
|---|---|---|---|---|
| **2a** | Bug2（3.3）、Bug1'（3.2，含失敗時寫回 marker）、`lifecycleEpoch`、pause reason 寫進 marker。不動 dispatcher | pump | ① 跨 instance 送達後 last-activity 更新；② wake 或 restart 出來的新 daemon 在門檻內不會 pause（重現 14:48:08→09）；③ restart 一個 paused instance 成功 → running、沒有 marker；**start 拋錯 → marker 寫回、之後可以重試**；④ stop 之後才完成的 wake 不會讓 instance 復活；⑤ **在註冊前卡住舊 start，插入 restart 或 stop，再放行 → 舊世代不註冊、不覆蓋 `daemons`、socket、`window-id`，也不清掉 replacement**；任何時刻已發布的 daemon ≤ 1（另外記錄歷史 spawn 次數，不拿它當判準）；⑥ 顯式 wake 遇到 restart 會 join 該 transition | revert（marker 的 reason 欄位是可選的，舊版會忽略） |
| **2b** `wake_only` | 新增 `WakeCoordinator`（1.2、1.3、1.6 的 lease 和常駐上限、1.4 的 claim 前阻塞告警、開機掃描）。pump 只 claim 醒著而且 accepting 的 target；移除 durable 路徑上 `deliverWithIdleGate` 內嵌的喚醒。**worker 物件尚未建立，pump 仍是唯一的 claimer** | pump | ① **只剩 marker** + 跨 instance task → 喚醒一次 → 送達；② **常駐 paused** + task → 喚醒一次 → 送達；③ 兩種情況喚醒失敗 → row 仍是 queued、`attempt_no` 不變、每段退避只通知一次、只有一套 retry timer；④ 只剩 marker + head 是 notice、後面是 task → 只喚醒一次，notice→task 順序不變；⑤ `reply_obligation_notice` 不會被永久延後；⑥ pending + auth-deferred → 仍然可以安全 pause，而且不會自動喚醒；⑦ wake→claim 的空檔中不會 auto-pause；⑧ pending 的 target 遠多於 cap、其中部分被永久 hold → 常駐數 ≤ cap+overflow，row 留存，資源釋放後繼續；⑨ 並行的 wake、restart、顯式 wake 不會產生兩個有效 writer；⑩ **wake 成功後才出現永久 hold → 沒有 claim、pre-claim lease 在 2 分鐘內結束、target 進入 park、可以被 idle eviction、其他 target 能前進；park 期間的新 admission 不會再喚醒它**；⑪ **只剩一個名額、兩個 target 同時 wake、兩個 spawn promise 都卡住 → 只有一個開始；失敗或 stale epoch 清理後名額可重用，不洩漏、不重複計算**；**warm 分支：常駐 paused 的 instance 成功 wake → reserved 歸零、resident 加一且只算一次；之後再 pause 或 stop → 名額可以給下一個 target 用**；⑫ **auth hold 造成 park、之後被 pause，修好登入後顯式 wake → 立刻進入受控嘗試，不必等 30 分鐘；一般的新 admission 仍然不會解除 park** | flag 改 `off`（coordinator 停止排程；pump 的 claim 條件放寬回舊版） |
| **2c** `on`（金絲雀） | `TargetQueueWorker` 經 `grantLane` 取得金絲雀 target 的 lane，負責 claim、handoff、result；1.5-B 的 lane 釋放規則生效 | 金絲雀 = worker；其他 = pump | ① 同一個 target 永遠不會有兩筆 row 同時 in-flight（DB 不變式加並行壓測）；② 等待中切換 flag → 所有權在 drain 完之後才轉移；③ 舊 attempt 的 ACK 不會改到新 attempt；④ **begin 之後卡住 paste promise、斷 IPC、再 enqueue 下一筆 → 下一筆不會越過還沒結束的 writer；恢復之後不會混進舊 composer 的內容**；⑤ busy 或 dialog 時不送；⑥ **begin 之後卡住 paste promise、等 lease 計時到期 → 下一筆仍然不會越過還在進行的 writer**；⑦ 金絲雀跑 1–2 天，**沒有無法解釋的 stall**（合法的長時間 hold 會有可見原因） | flag 改回 `wake_only`。worker drain 完已 claim 的 row 才 release，pump 依 1.5-A 取得 lane。**IPC 斷線留下的 lane 和 pending/auth 的 pause 規則不會因為 flag 回切而被繞過** |
| **2d** | 預設 `on`。一個版本之後刪掉 pump 的 claim/dispatch 和 durable 的 idle-gate tail | worker | 全套 CI，2b 和 2c 的驗收清單再跑一次 | 刪除程式碼之前隨時可以回到 `wake_only` |

## 5. 風險清單

| 風險 | 防護 |
|---|---|
| 重複提交 | 1.5 的四條同時成立；1.5-B 的 lane 在 writer 真正結束之前不釋放 |
| FIFO 退化或 head 擋住後面 | 喚醒判定看整條 queue（1.2）；依 `created_seq` 不跳號；claim 前阻塞告警（1.4）；claim 後沿用 lane 告警 |
| 舊 ACK 被當成新 attempt | `(bootId, attemptNo)` fence；worker 永遠不重用 attemptNo；regression 測試 |
| busy 或 dialog 被誤放行 | 只看 daemon 的 `acceptingState`，結果綁定 bootId，claim 前同步 recheck；daemon `begin` 是最後一道 |
| 喚醒風暴或 OOM | SpawnGate；常駐硬上限 cap+overflow，加上第一個 await 之前的原子 reservation（`CapacityLedger`）；只有持 lease 的 target 免於 eviction；pre-claim lease 有界，被 hold 時 park；auth 造成的 pause 不會自動喚醒 |
| sender 也離線 | 回覆本身就是一筆送往 sender 的 wake-eligible durable row，走同一套流程 |
| auth 壞掉的 CLI 停不下來 | lease 不擋 auth-deferred pause 和操作者的 pause/stop（1.6） |
| restart 或 wake 競態 | 每個 target 一條 `TransitionQueue`；epoch fence 傳到發布點，每個共用副作用之前都核對；restart 失敗時寫回 marker（3.2） |
| 切換期間狀態不一致 | `desiredMode` 和 `grantedOwner` 分開；只在 lane 為空時轉移；同步的 check-grant-claim |

## 6. 不在範圍內
- Phase 1（uncertain 噪音）；
- 把使用者訊息搬進 outbox；
- SpawnGate 的 low-memory 語意修正（只記錄限制）；
- warm cap 策略本身（只加 lease 和 overflow 上限）。
