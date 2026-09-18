# 票 5 spike：pre-fleet setup 宿主的四個問題

狀態：**spike 回報，未實作**。全部結論來自實測，不是推理；每項都附可重跑的方式。

---

## 1. port 交接：可行，但有一個會讓整個 fleet 沒有 dashboard 的坑

### 實測

| 情境 | 結果 |
|---|---|
| A. 宿主無連線時 `close()` → spawn 後繼者 | close **2ms**，後繼者 **65ms** 後 listening，**零 EADDRINUSE** |
| B. 有一條瀏覽器長輪詢連線，宿主直接 `close()` | **close 永遠不完成**（3 秒後仍 pending），後繼者**從未啟動** |
| C. 同 B，但先 `server.closeAllConnections()` | close **2ms**，後繼者 **54ms** 後 listening，零 EADDRINUSE |
| D. 真 AgEnD health server 從 spawn 到能回應 | **~994ms**（tsx 編譯版、零 instance；真 `agend start` 只會更久） |

**B 是預設情境，不是邊角**：wizard 完成時瀏覽器正在輪詢。沒有 `closeAllConnections()` 的話，「完成」會讓 setup 永遠卡住——宿主不退出、`agend start` 永遠不被 spawn。

### 更嚴重的一條：port 沒讓出來時，fleet 會殺掉 `fleet.pid` 裡的任何 pid

`fleet-manager.ts` 的 health server 遇到 EADDRINUSE 會：讀 `fleet.pid` → **`process.kill(oldPid, "SIGTERM")`** → 等 1500ms 重試一次 → 仍失敗就 **整個 fleet 執行期間停用 dashboard**。

實測（受控環境）：放一個無關的 `sleep 300` 到 `fleet.pid`，用一個 dummy server 占住 port，再啟動真 fleet：

```
WARN: Health port in use — attempting takeover
INFO: Killed old fleet process          ← 無關的 process 真的被殺了
ERROR: Health port still in use after takeover — dashboard disabled
```

之後 port 仍由占用者提供服務，**fleet 活著但整個生命週期沒有 dashboard**，瀏覽器輪詢到的是占用者而不是 fleet。這正是 #722/#748 的形狀。

這是**既有行為、不是票 5 引入的**，但票 5 會把「port 被非 fleet 行程占住」從異常變成**常態**。

### 結論／建議

1. 宿主**必須先完全關閉再 spawn**：`closeAllConnections()` → `close()` → 在 `close` callback 裡才 spawn。不能依賴 takeover 收拾。
2. 空窗期就是 `agend start` 的啟動時間（實測最小 ~1s，真實更久），瀏覽器會拿到 connection refused —— 這是正常的，輪詢上限要夠寬（envelope 寫 60s，看起來合理）。
3. **要不要順手硬化 takeover**（只有在目標 pid 的 cmdline 真的是 fleet 時才 SIGTERM）——這會改到既有行為，**我不自己拍，flag 給你與 fable**。我的看法：值得做，而且跟票 5 無關也該做，因為現在任何 stale `fleet.pid` 都能讓 AgEnD 殺掉一個無關行程。

---

## 2. 宿主退出時機

- **完成時**：`closeAllConnections()` → `close()` → callback 裡 spawn `agend start` → `process.exit(0)`。**不等 fleet ready**（宿主已經沒有 port 可以回報進度了），ready 由瀏覽器輪詢正式 server 判斷。
- **TTL／閒置逾時**：同一條路徑，只是不 spawn。實測 B 的結論一樣適用——**逾時退出也必須先 `closeAllConnections()`**，否則一條掛著的長輪詢會讓逾時退出卡住，TTL 形同虛設。
- 兩條路徑共用一個 `shutdown(spawnSuccessor: boolean)`。

## 3. fleet.lock：一個方向夠，另一個方向不夠

實測 `acquireFleetLock`（`fleet-lock.ts`）：

| 方向 | 結果 |
|---|---|
| fleet 持有 lock → 宿主嘗試取得 | **丟出 `Fleet is already running`** ✓ 正是需求 3 要的 |
| 宿主持有 lock → `agend fleet start` 嘗試取得 | **直接偷走** ✗ |

原因：lock 只在擁有者的 **command line 符合 `isFleetStartCommandLine`**（`… fleet start`）時才視為有效；宿主的 cmdline 不符合，於是被判定為「pid 被重用的 stale lock」而移除。

**影響**：使用者在 setup 宿主開著時手動 `agend start`，會走進第 1 節那條最壞路徑（偷 lock → 撞 port → 殺 `fleet.pid` → dashboard 停用）。

**選項**（我不自己拍）：
- (a) 讓宿主的 cmdline 也符合該 pattern —— 最省事，但語意上是謊；
- (b) 在 lock record 加一個 `role: "fleet" | "setup-host"`，`acquireFleetLock` 對活著的 setup-host 也拒絕 —— 要動既有檔案格式，但誠實；
- (c) 不動 lock，只靠「宿主退出才 spawn」+ 文件 —— 擋不住使用者手動起 fleet。

我傾向 (b)，而且它剛好也讓第 1 節的 takeover 硬化有判斷依據。

## 4. 靜態隔離：**比 envelope 預期便宜很多**

實測 import 圖（`src/` 內相對 import 的遞移閉包）：

| 入口 | 模組數 | 是否可達 fleet-manager / daemon / instance-lifecycle |
|---|---|---|
| `settings-api.ts` | 12 | **否** |
| `quickstart-api.ts` | 3 | 否 |
| `provider-probe.ts` | 1 | 否 |
| `web-auth.ts` | 1 | 否 |
| `config.ts` | 3 | 否 |

`settings-api.ts` 的完整閉包：`apply-job` `backend/types` `config-validator` `instance-config-impact` `logger` `paths` `pause-marker` `provider-probe` `quickstart-api` `secret-file` `types`。都很小，且沒有 import 期副作用（`logger.ts` 只算路徑，`createLogger()` 要被呼叫才建目錄）。

**原因**：`SettingsApiContext` 是介面，FleetManager 是**注入**進來的，不是 import 進來的。票 4 把 `SelfRestartResult` 從 fleet-manager 移到 apply-job 時也順手切斷了唯一一條型別依賴。

**所以「ConfigVerbs / ProviderProbeVerbs」不需要一層新架構，只需要兩件事**：
1. 把 4 條 quickstart 路由從 `settings-api.ts` 抽成 `handleQuickstartRequest(req,res,url,ctx)`（機械式搬移），context 只要 `{ fleetConfig, dataDir, logger, saveFleetConfig, isBotTokenInUse? }` 五個欄位 —— 這就是 ConfigVerbs+ProviderProbeVerbs 的實際樣貌；
2. 宿主自己提供 `saveFleetConfig`：pre-fleet 沒有既有 YAML 要保留註解，用 `js-yaml` 寫一份新的即可（~20 行）。

**envelope 的 import 圖驗收測試現在就能寫、而且會通過**。估計成本：抽路由 + context + 測試，半天等級，不是重構等級。

---

## 我建議做完整實作前先定的三件事

1. **takeover 硬化**（只殺確認是 fleet 的 pid）—— 改既有行為，要你/fable 點頭。
2. **fleet.lock 加 role**（上面選項 b）—— 改既有檔案格式。
3. 以上兩條若都不做，票 5 仍可實作，但「使用者在宿主開著時手動 `agend start`」這條路徑會是已知的壞路徑，只能靠文件。

## 重跑方式

port 交接與 takeover 實驗腳本在 spike 期間放在 scratchpad（未進 repo）；fleet.lock 的三個案例可用 `acquireFleetLock` 的 `probe` 參數（`pid`/`isProcessAlive`/`readCommandLine`）在單元測試裡完整重現，不需要真的起行程。
