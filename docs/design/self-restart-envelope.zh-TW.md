# 自身重啟安全信封（Settings Apply → 重啟 AgEnD 本身）

狀態：**已實作**（fable APPROVE 此信封後開工）。本文件現在是這個功能的設計說明，不再是提案。
第 1 部分（單一 instance 重啟的預報修正）已實作並經 fable APPROVE（`d7694f0a`）。

實作對應：
- §0 集合 → `src/fleet-level-config.ts`，兩側列舉測試在 `tests/fleet-level-config.test.ts`
- §1–§4 → `FleetManager.requestSettingsSelfRestart()` 與 `POST /api/settings/restart-fleet`
- §3 rate-limit → `src/self-restart-limit.ts`
- §5 一致性檢查 → `FleetManager.checkStartupSignatureConsistency()`，在 `finishStartup()` 內、所有啟動期改寫之後

**裁示三已由 fable 拍板：token 作為唯一授權「足夠」。** 這個 token 今天已經授權更嚴重的動作（停光所有 agent、typed-confirm 刪 instance、改所有 backend），一次受限的自身重啟沒有引入新的權限類別；票 0 又把它硬化成 HttpOnly + SameSite=Strict + Origin 檢查的 cookie。

本版相對前一版的改動：§0 集合補齊並改以「建構時讀取、reconcile 不重讀」為判準逐項查證（原集合會漏三項，漏掉比不收窄更糟）；§2 驗證改為**同時驗活狀態**並消耗該列；**§2 的歸因改寫**；§3 rate-limit 補上落盤順序與不可重置要求；§4 補 409 與稽核失敗即拒絕；新增 §5 啟動時的簽章一致性檢查。

外網可達的面板要能讓 AgEnD 重啟自己，這是一個新的攻擊面：一個「重啟」按鈕本身就是一個 DoS 原語。

---

## 0. 觸發條件必須先收窄（裁示一，已定）

目前 `fleetLevelSignature()` = `{channel, 全部 cold defaults}`。cold defaults 包含 `backend`、`model`、`tool_set`、`agent_mode` 等——這些**全部由「重啟 instance」吸收**，process 不需要重啟。實測（第 1 部分修正之後）：改 `defaults.backend` 產生「兩個 agent 重啟」＋「重啟 AgEnD」三列，但前兩列就已經完整套用了這個變更。

直接把這個列接上真重啟，等於**使用者每改一次預設 backend 就被請求重啟整個 fleet，而那次重啟不改變任何結果**：既誤導，也把 DoS 面無謂放大。

**判準（fable 要求，採用）：「建構時讀取、reconcile 完全不重讀」**，不是「感覺像 fleet 層級」。

收窄做錯的方向**比不收窄更糟**：一個 startup-only 欄位若不在集合裡，改了會**既不重啟 instance、也不出 fleet 列＝已儲存、永不生效、沒有任何人提醒**。

### 已逐項查證：屬於集合（startup-only）

| 欄位 | 建構點 | reconcile 重讀？ |
|---|---|---|
| `channel` / `channels` | `createAdapter()` @`fleet-manager.ts:3558` | 否 |
| `defaults.locale` / `timezone` | `setLocale(detectLocale(fleet))` @`:2788` | 否 |
| `defaults.cost_guard` | `new CostGuard(costGuardConfig, …)` @`:2882` | 否 |
| `defaults.webhooks` | `new WebhookEmitter(webhookConfigs, …)` @`:2886` | 否 |
| `defaults.daily_summary` | `new DailySummary(summaryConfig, …)` @`:2905` | 否 |
| `defaults.scheduler` | `new Scheduler(…, schedulerConfig, …)` @`:3028` | 否（reconcile 的 `scheduler.reload()` 重載排程資料，不是這份 config） |
| `health_port` | `startHealthServer(port)` 一次 | 否，**且目前根本不在簽章裡**（既有缺口，一併補） |

中間三項（cost_guard / webhooks / daily_summary）是 fable 指出的漏網，查證屬實：它們現在**在**簽章裡（因為簽章收全部 cold defaults），天真收窄會把它們刷掉。

### 已逐項查證：不屬於集合（執行期讀取）

| 欄位 | 讀取點 |
|---|---|
| `defaults.startup.concurrency` / `stagger_delay_ms` | `SpawnGate` closure 每次 spawn 現讀（`:718`、`:719`） |
| `defaults.max_cross_instance_message_bytes` | 每則訊息現讀 `outbound-handlers.ts:150` |
| `defaults.tips` | 發送時現讀 |
| 其餘 cold defaults（`backend`/`model`/`tool_set`/`agent_mode`/`hang_detector`…） | 由「重啟 instance」吸收，已經有 instance 列 |

### 原本待查的五個鍵：全部不屬於集合（已定案）

`web`（`usage-api.ts:268` 現讀）、`hostname`（`topic-commands.ts:378` / `login-controller.ts:344` 產生連結時現讀）、`login` 與 `web_terminal`（除型別外無 runtime 讀取點）、`defaults.progress_min_elapsed`（`fleet-manager.ts:8110` 現讀）。

`defaults.scheduler` **不能整塊進集合**：只有 `max_schedules` 與 `default_timezone` 被 Scheduler ctor 捕捉，`retry_count` / `retry_interval_ms` 在每次觸發時現讀（`fleet-manager.ts:5346-5347`）。簽章只收前兩個子鍵。

另外：**沒有 `defaults.timezone` 這個鍵**。`detectLocale()` 只讀 `defaults.locale` 與主機時鐘，可設定的時區在 `defaults.cost_guard` 裡（整塊已收）。

### 集合要有測試（必改一）

**寫一個列舉這個集合的測試**：未來新增 startup-only 欄位時，有一個地方會逼人登記。測試同時斷言「不屬於集合」那幾項確實**不**在集合裡，否則收窄會在無聲中失效。

此變更改變票 2 已 merge 的行為（改 `defaults.backend` 後不再出現 fleet 列），需 fable 複審。

---

## 1. 走哪條路（裁示二，已定）

**沿用既有 `requestFullRestart()`（`fleet-manager.ts:2585`）**，不做 raw process kill。它已經有：拒絕與其他計畫性重啟並行、落盤 marker、等待 idle grace、用 `launchFullRestartHelper()` spawn `agend restart`（會選對 systemd / launchd / detached 交接）。

**障礙**：它需要一個 channel 目標（`adapterId`/`chatId`/`messageId`），因為進度是靠編輯那則聊天訊息跨重啟續播的。面板沒有聊天訊息。

**做法**：面板觸發時先往 General topic 貼一則「Settings 觸發了 AgEnD 重啟」，用那則當進度目標。**這件事會出現在管理員看得到的頻道裡，形成帶外稽核軌跡**——面板被盜用時，重啟不會悄悄發生。

**完全沒設 channel 的部署**：直接拒絕，告訴使用者執行 `agend restart`（這類使用者本來就有 shell）。不為這個 edge case 去動 #722 的 marker 資料形狀。

---

## 2. 二次確認（必改二：要驗活狀態）

**與 Apply 分開，不可被一次 Apply 順手帶過。**

- Apply 完成後，fleet 列停在 `restart-required`（票 2 已有的誠實終態）。
- 該列旁出現「重新啟動 AgEnD」按鈕；按下後跳明確確認對話框，說明會中斷所有 agent。
- 確認後打**另一個端點** `POST /api/settings/restart-fleet`，body 需要：
  1. 自己的 `Idempotency-Key`（與 apply 的鍵不同）；
  2. `job_id` —— 要重啟所回應的那個 apply job；
  3. `confirm: "restart-agend"` 字面值。

**伺服器必須同時驗兩件事**，缺一即 409：

1. `job_id` 指向的 job 真的有一列 `restart-required`；
2. **活狀態仍然成立**：`appliedFleetLevel !== fleetLevelSignature(nextFleetConfig())`。

只驗第 1 條有繞法（fable 找到的）：apply 一次 fleet 變更（列 `restart-required`）、再把設定改回去 apply 第二次，**第一個 job 在 30 分鐘 retention 內仍帶著那列**，此時打 restart-fleet 會在沒有任何待處理變更的情況下重啟。

放行時**把該 job 的 fleet 列轉 `running` 作為消耗**：同一個 `job_id` 不能觸發第二次。（這個轉換本來就是必要的，見 §4。）

### 歸因更正（fable 指出，重要）

**「沒有待處理 fleet-level 變更就什麼都做不了」不是防濫用性質，不是授權控制。** 持有 token 的人可以自己先改一個 fleet-level 欄位（例如 `defaults.locale`）再按重啟，這個前提對他毫無阻力。

它的真正作用是**防誤按、防無意義的重複觸發**——一個 UX 守衛。

**真正壓住 DoS 的是**：§3 的落盤 rate-limit、票 0 的 cookie + Origin gate、以及 §1 的 General 帶外稽核。實作時心力要放在這三項上。

---

## 3. 重啟迴圈 / DoS 防護（必改三）

1. **必須有待處理的變更 + 活狀態**（§2）——UX 守衛，不是授權控制。
2. **既有的並行拒絕**：`requestFullRestart` 在 `shuttingDown || isUpdateInProgress(dataDir)` 時拒絕；marker TTL 15 分鐘。
3. **落盤的速率限制**：`self-restart.json`，**上限 10 分鐘 1 次、1 小時 3 次**。要求：
   - **必須在 spawn helper 之前寫入並 `fsync` 完成**。順序反了的話，「寫入落地前 process 已被換掉」會讓計數歸零，等於沒有限制；
   - 計數的是**嘗試**，不是成功。失敗的嘗試一樣消耗額度，否則一個穩定失敗的重啟可以無限重試；
   - **記錄在稽核貼文之前**（fable 備註一）。若記錄持續失敗（磁碟唯讀），先貼文的順序會讓持有 token 者每次呼叫都在頻道貼一則「正在重啟」而實際沒重啟 —— 一個無限的頻道騷擾原語。代價是貼文失敗時也消耗一次額度，這個方向對速率限制而言是正確的；
   - **不得有任何 web 路由能清除或修改這個檔**。可清除的速率限制不是速率限制；
   - **檔案損毀／無法解析時視為「已達上限」**（fable 備註二，fail-closed）。把損毀讀成「尚無紀錄」等於讓這個控制在自身狀態存疑時自我解除。復原方式是在主機上刪掉該檔 —— 需要的權限跟直接執行 `agend restart` 相同。**檔案不存在**（從未寫過）仍然是正常的首次執行，不算損毀；
   - 檔案權限 **0600**。
4. **仍在票 0 的 gate 後面**：HttpOnly + SameSite=Strict cookie、Origin 檢查、token。

**權限模型**：網頁端沒有 per-user 身分，token 本身就是管理員憑證。**fable 已拍板：足夠**（見文件開頭）。

---

## 4. 失敗、逾時與併發（必改四）

- **reconcile 進行中拒絕**：`reconcileInFlight` 或 `activeApplyJobId` 非空時，restart-fleet 回 **409**。不能在一次 reconcile 正在停停開開 instance 的當下把 process 拉掉。這與票 2 的單飛語意一致。
- **貼 General 訊息失敗（adapter 不在／送不出去）→ 拒絕重啟**，不做無稽核的重啟。與「marker 寫不進去就拒絕」同一個原則：**不做一個沒有人看得到、也追蹤不到的重啟**。
- **送出時**：fleet 列從 `restart-required` 轉 `running`。票 2 的 `settleAfterRestart` 只收非終態的列，不轉的話新 process 不會把它收尾。
- **成功**：新 process 啟動 → `settleAfterRestart` 標 `done` + `settled_by:"fleet-restart"`。瀏覽器輪詢 GET 自然接上，資料形狀不用改。
- **spawn 失敗／helper 提前退出**：該列 `failed` + 原因，job 結案，沿用既有的 `setUpdateProgressStage("failed")`。使用者要重新 Apply 才會拿到新的可重啟 job —— 這是「一個 job 只能重啟一次」的 fail-closed 代價：一個 launch 失敗的 job 不該留成一顆可重複按的重啟鈕。
- **逾時**：自身重啟的 deadline 拉長到 **300 秒**（含整個 service 重啟），顯示「仍在重啟中（N 秒）」。
- **marker 寫不進去**：拒絕重啟（既有行為）。
- **非阻擋**：`Idempotency-Key` 語意同 apply（重送回原結果，不是第二次重啟）；rate-limit 回 **429 附 `Retry-After`**。

---

## 5. 啟動時的簽章一致性檢查（必改五）

迴圈的終止條件是：重啟後 `finishStartup` 重算 `appliedFleetLevel`，該列消失。

但這依賴「`finishStartup` 用記憶體算出的簽章」等於「plan 用 `loadFleetConfig(configPath)` 算出的簽章」。而 `startAll` 在 `finishStartup`（`:3274`）之前會改寫設定：`slimFleetConfigAtStartup()`（`:2787`，可能 `saveFleetConfig()` @`:6266`）、generals 自動建立後存檔（`:3020`）、`fixedGeneral` 存檔（`:3195`）。

**任何一處讓記憶體與檔案在 channel 或 startup-only defaults 上序列化出不同結果，就是一個自我維持的迴圈**：每次啟動都判定「需要重啟」，rate-limit 只能把它壓成每小時三次的騷擾。

**必改**：`finishStartup` 時**多算一次 `fleetLevelSignature(loadFleetConfig(configPath))` 與記憶體版比對**。不相等就：

- `logger.warn` 並記下差異（實際哪個鍵不同），讓 fleet.log 有東西可查；
- **UI 在這種情況顯示「設定不一致，請先查 fleet.log」，而不是提供重啟按鈕**。

一個永遠不會成功的重啟按鈕比沒有按鈕更糟。

---

## 6. 不做的事

- 不做 raw `process.kill`。
- 不讓 Apply 自動觸發自身重啟（使用者選 B 是「可以觸發」，不是「不問就觸發」）。
- 不在沒有待處理 fleet-level 變更、或簽章不一致時，提供這個端點的任何入口。
