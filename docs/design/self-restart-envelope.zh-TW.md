# 自身重啟安全信封（Settings Apply → 重啟 AgEnD 本身）

狀態：**待 leader + fable 過目後才實作**。單一 instance 重啟（本票第 1 部分）不在此信封內，已實作。

外網可達的面板要能讓 AgEnD 重啟自己，這是一個新的攻擊面：一個「重啟」按鈕本身就是一個 DoS 原語。以下是打算怎麼把它關進信封裡。

## 0. 前置發現（會影響信封的形狀，請先看這條）

目前 `fleetLevelSignature()` = `{channel, 全部 cold defaults}`。cold defaults 包含 `backend`、`model`、`tool_set`、`agent_mode` 等——這些**全部由「重啟 instance」吸收**，process 不需要重啟。實測（本票第 1 部分的修正之後）：改 `defaults.backend` 會產生「兩個 agent 重啟」＋「重啟 AgEnD」三列，但前兩列就已經完整套用了這個變更。

也就是說，**如果直接把現在這個 `restart-required` 列接上真正的重啟，使用者每改一次預設 backend/model 就會被請求重啟整個 fleet**，而那次重啟不會改變任何結果。這既是誤導，也把 DoS 面無謂地放大。

**提案：先把觸發條件收窄到 process 真的獨佔的東西**，再讓它可觸發重啟。查證後屬於這一類的是：

| 欄位 | 為什麼只有重啟才會生效 |
|---|---|
| `channel` / `channels` | adapter 在 `fleet-manager.ts:3558` 啟動時建立，reconcile 不重建 |
| `defaults.locale` / `timezone` | `setLocale(detectLocale(fleet))` 只在 `fleet-manager.ts:2788` 啟動時呼叫一次 |
| `health_port` | 只在 `startHealthServer()` 讀一次 —— **而且它目前根本不在簽章裡**，改了不會有任何提示 |

其餘 cold defaults 應該只產生 instance 列，不產生 fleet 列。

**這是我要的第一個裁示**：收窄簽章會改變票 2 已 merge 的行為（某些變更不再顯示「需要重啟 AgEnD」）。我認為該收窄，但不自己拍。

## 1. 走哪條路

**沿用既有 `requestFullRestart()`（`fleet-manager.ts:2585`）**，不做 raw process kill。它已經有：拒絕與其他計畫性重啟並行、落盤 marker、等待 idle grace、用 `launchFullRestartHelper()` spawn `agend restart`（會選對 systemd / launchd / detached 交接）。

**一個障礙**：`requestFullRestart` 需要一個 channel 目標（`adapterId` / `chatId` / `messageId`），因為進度訊息是靠編輯那則聊天訊息跨重啟續播的。面板沒有聊天訊息。

**提案**：面板觸發時，先往 General topic 貼一則「Settings 觸發了 AgEnD 重啟」的訊息，用那則當進度目標。附帶好處是**這件事會出現在管理員看得到的頻道裡，形成帶外稽核軌跡**——面板被盜用時，重啟不會悄悄發生。

**沒有任何 channel 的部署**（純本機、沒設 bot）怎麼辦？`persistFullRestartProgress` 需要目標才寫得出 marker。**提案：拒絕，並告訴使用者執行 `agend restart`。** 這類使用者本來就有 shell。**這是我要的第二個裁示**（另一個選項是讓 marker 目標可為空，但那要動 #722 的資料形狀）。

## 2. 二次確認

**與 Apply 分開，不可被一次 Apply 順手帶過。**

- Apply 完成後，fleet 列停在 `restart-required`（票 2 已有的誠實終態）。
- 該列旁出現「重新啟動 AgEnD」按鈕；按下後跳明確確認對話框，說明會中斷所有 agent。
- 確認後打**另一個端點** `POST /api/settings/restart-fleet`，body 需要三樣：
  1. 自己的 `Idempotency-Key`（與 apply 的鍵不同）；
  2. `job_id` —— 要重啟所回應的那個 apply job；
  3. `confirm: "restart-agend"` 字面值。
- **伺服器必須驗證 `job_id` 指向的 job 真的有一列 `restart-required`**，否則 409/400。

最後一條是核心的防濫用性質：**沒有真的待處理的 fleet-level 變更時，這個端點什麼也做不了**。它不是一顆可以隨時按的重啟鈕，而是一個「確認這筆變更」的動作。

## 3. 重啟迴圈 / DoS 防護

四層，前三層在重啟發生之前：

1. **必須有待處理的變更**（第 2 節最後一條）。重啟完成後 `appliedFleetLevel` 在 `finishStartup` 重算，該列消失——這是迴圈的自然終止條件。
2. **既有的並行拒絕**：`requestFullRestart` 在 `shuttingDown || isUpdateInProgress(dataDir)` 時拒絕。marker TTL 15 分鐘。
3. **落盤的速率限制**（新增）：`self-restart.json` 記錄最近幾次面板觸發的自身重啟時間戳。**提案上限：10 分鐘內 1 次、1 小時內 3 次**，超過回 429 並附下次可用時間。必須落盤，因為 process 會死，in-memory 計數器每次重啟都歸零——那等於沒有速率限制。
4. **仍在票 0 的 gate 後面**：HttpOnly cookie + Origin 檢查 + token。

**關於權限**：`/restart full` 在聊天端要 `isFleetAdmin`。網頁端沒有 per-user 身分，**token 本身就是管理員憑證**。這點我認為是既有且一致的模型（Settings 面板本來就能刪 agent、改 backend），但明寫出來讓 fable 判斷。

## 4. 失敗與逾時行為

- 重啟**送出時**，fleet 列從 `restart-required` 轉 `running`（票 2 的 `settleAfterRestart` 只收非終態列，所以這個轉換是必要的，否則新 process 不會把它收尾）。
- **成功**：新 process 啟動 → `settleAfterRestart` 把該列標成 `done` + `settled_by:"fleet-restart"`。瀏覽器輪詢 GET 自然接上，**資料形狀不用改**。
- **spawn 失敗 / helper 提前退出**：該列 `failed` + 原因，並沿用既有的 `setUpdateProgressStage("failed")`。
- **逾時**：票 2 的 wall-clock deadline 照舊，顯示「仍在重啟中（N 秒）」。另建議自身重啟用比 120 秒更長的 deadline（提案 300 秒），因為它包含整個 service 重啟。
- **marker 寫不進去**：拒絕重啟（既有行為），不做「無法追蹤的重啟」。

## 5. 我不打算做的

- 不做 raw `process.kill`。
- 不讓 Apply 自動觸發自身重啟（使用者選 B 指的是「可以觸發」，不是「不問就觸發」）。
- 不在沒有待處理 fleet-level 變更時提供這個端點的任何入口。
