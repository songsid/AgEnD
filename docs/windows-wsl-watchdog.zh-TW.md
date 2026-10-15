# Windows + WSL 守護進程設定

> 在 Windows 上運行 AgEnD 需要 WSL2（Ubuntu）。`windows/` 目錄中的腳本負責
> 自動保持 fleet 存活、處理 token 更新，並在 bot 停止回應時發出警示。

## 系統架構

```
Windows 11
├── bot-watchdog.ps1          # 守護進程（PowerShell，Windows 層）
│   └── 每 300 秒呼叫 check-bot-status.sh（最多 retry 2 次）
│       ├── ok      → 記錄日誌，繼續
│       ├── warning → 記錄日誌，重置錯誤計數
│       └── error   → 氣球通知 / 重新登入對話框 / 自動重啟
│
├── start-bots.ps1            # 一鍵啟動（透過 WSL 呼叫 agend-start.sh）
├── install-autostart.ps1     # 在工作排程器登錄開機自動啟動任務
│
└── WSL2 (Ubuntu)
    ├── agend-start.sh        # Fleet 啟動腳本
    │   └── 清理 → 釋放 port 19280 → 等待網路 → 啟動 fleet
    │
    ├── check-bot-status.sh   # 狀態探測 — 輸出 JSON
    │   └── 檢查：tmux session、fleet.pid 是否存活、claude 進程數、
    │               日誌錯誤、accessToken 有效期
    │
    ├── refresh-claude-token.sh  # OAuth token 自動更新
    │   └── 啟動時執行；check-bot-status.sh 在 < 30 分鐘時也會呼叫
    │
    └── agend fleet daemon    # Node.js Telegram bot 主進程
        ├── Telegram polling
        ├── Web UI / Health endpoint：port 19280
        ├── Unix socket：channel.sock → 路由到 claude instances
        └── 4 個 claude CLI instances（在 tmux 視窗中）
```

## 前置需求

| 需求 | 說明 |
|---|---|
| Windows 10/11 | 需啟用 WSL2 |
| WSL2 Ubuntu | `wsl --install -d Ubuntu` |
| WSL 內 Node.js ≥ 22.14 | `install.sh` 會自動安裝 |
| 全域安裝 agend | `npm install -g @songsid/agend` |
| claude CLI 已登入 | 在 WSL 內執行 `claude /login` |
| Python 3 | Ubuntu 預裝 |

## 腳本說明

### `agend-start.sh`
在 WSL 內可靠地啟動 fleet。被 `start-bots.ps1` 和守護進程呼叫。

步驟：
1. 日誌輪替（daemon.log > 8,000 行 → 保留最後 5,000 行）
2. 呼叫 `refresh-claude-token.sh` 嘗試更新 token
3. 清除所有殘留的 `agend fleet` / `claude` / tmux 進程
4. 強制釋放 port 19280（使用 `ss -lptn`，不依賴 `fuser`）
5. 等待 Telegram API 可達（最多 60 秒，強制 IPv4）
6. 寫入 `force_ipv4.js` Node.js preload（修復 WSL2 DNS 解析問題）
7. 使用 `NODE_OPTIONS=--require force_ipv4.js` 啟動 fleet
8. 等待最多 40 秒，確認日誌出現 `polling started` 或 `Reconcile complete`

### `check-bot-status.sh`
回傳單行 JSON 物件，每 300 秒由 `bot-watchdog.ps1` 呼叫。

```json
{
  "status": "ok | warning | error",
  "reason": "",
  "fleet_running": 1,
  "claude_count": 4,
  "access_remaining_hours": 7.2,
  "refresh_remaining_days": 13.4
}
```

狀態判斷規則：

| 條件 | 狀態 |
|---|---|
| 所有進程正常，token 有效 | `ok` |
| accessToken < 30 分鐘 → 嘗試 refresh | `warning` |
| fleet PID 不存在或 tmux session 消失 | `error` |
| claude 進程數為 0 | `error` |
| 日誌包含 "Not logged in" | `error`（reason: `logged\|…`） |
| accessToken 已過期 | `error`（reason: `expired\|…`） |

### `refresh-claude-token.sh`
讀取 `~/.claude/.credentials.json`，以存儲的 `refreshToken` 呼叫
`https://claude.ai/api/auth/oauth/token`，就地更新 `accessToken` 與 `expiresAt`。

- 若 `accessToken` 剩餘 > 2 小時則跳過
- 僅在 `refreshToken` 本身過期時才回傳非零（需要手動執行 `/login`）

### `bot-watchdog.ps1`
在背景運行的 PowerShell 進程，帶有 Windows 系統托盤感知迴圈。

行為邏輯：
- 透過 `wsl -d Ubuntu bash -lic "bash …"` 呼叫 `check-bot-status.sh`，最多重試 2 次
- **error**（連續 ≥ 2 次，冷卻 30 分鐘）：
  - `reason` 包含 `logged|expired` → 顯示深色系「重新登入」對話框
  - 其他 → 氣球通知 + 呼叫 `agend-start.sh` 自動重啟
- **warning** → 重置錯誤計數，僅記錄日誌
- 深色系 Windows Forms UI（不需外部相依套件）

### `start-bots.ps1`
輕量啟動器 — 透過 WSL 執行 `agend-start.sh` 並顯示摘要輸出。
適合從檔案總管或開始選單手動啟動。

### `install-autostart.ps1`
在 Windows 工作排程器登錄一個任務，在使用者登入後延遲 30 秒執行 `start-bots.ps1`
（等待 WSL 和網路就緒）。

以一般使用者身份執行一次（不需要管理員）：

```powershell
.\install-autostart.ps1
```

安裝後立即測試：

```powershell
Start-ScheduledTask -TaskName "AgEnD-Bot-Autostart"
```

移除任務：

```powershell
Unregister-ScheduledTask -TaskName "AgEnD-Bot-Autostart" -Confirm:$false
```

## 初次設定

```powershell
# 1. 在 PowerShell 中啟動守護進程
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass `
  -File "C:\路徑\windows\bot-watchdog.ps1"

# 2. 登錄開機自動啟動（選用）
powershell -ExecutionPolicy Bypass -File "C:\路徑\windows\install-autostart.ps1"
```

```bash
# 在 WSL Ubuntu 內 — 首次登入
claude /login
```

## 已知問題與解決方法

| 問題 | 根本原因 | 解法 |
|---|---|---|
| WSL 無回應（check script 無 JSON 輸出） | WSL 從休眠恢復後啟動慢 | 守護進程 retry 2 次，容忍一次漏報 |
| WSL 啟動後 Telegram 無法連線 | WSL2 DNS 解析到 IPv6 | `force_ipv4.js` preload + curl `-4` 旗標 |
| 快速重啟後 port 19280 佔用 | 前一個 node 進程還沒完全退出 | `agend-start.sh` 用 `ss` 找到 PID 再 kill |
| daemon 已崩潰但 FLEET_RUNNING=1 | tmux session 還活著但 PID 消失 | 雙重驗證：tmux + `fleet.pid` kill-0 測試 |
| warning 狀態累積了錯誤計數 | errCount 在 warning 時未歸零 | 已修正：ok 和 warning 都重置計數器 |
| daemon.log 無限成長到 GB | 無輪替邏輯 | 超過 8,000 行時截至 5,000 行 |

## Token 生命週期

```
accessToken   — 約每 8–12 小時過期
refreshToken  — 約每 14 天過期
```

- `refresh-claude-token.sh` 自動處理每日輪替。
- 當 `refreshToken` 過期時，守護進程會顯示「重新登入」對話框，
  在 tmux 視窗中啟動 `claude /login`、開啟瀏覽器，
  並等待你貼上 OAuth code 完成授權。
