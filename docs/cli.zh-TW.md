# CLI 參考 (CLI Reference)

## Telegram 指令 (General 主題)

| 指令 | 描述 |
|---------|-------------|
| `/status` | 顯示 Fleet 表格：Backend、Model、Context、推理強度、花費、執行狀態 |
| `/restart` | 在進程內重啟所有實例（不結束進程） |
| `/upgrade` | 結束進程以套用新代碼（需 launchd/systemd 自動重啟） |
| `/sysinfo` | 顯示詳細的系統診斷資訊（版本、負載、IPC 狀態、各 backend CLI 版本） |

所有其他操作（建立/刪除/啟動實例、委派任務）均由 General 實例透過自然語言處理。

## 服務管理 (Service Management)

這些指令用於管理 AgEnD Daemon 進程。

```bash
agend start                     # 啟動 AgEnD 服務（需先安裝）
agend stop                      # 停止 AgEnD 服務
agend restart                   # 重啟 AgEnD 服務
agend update                    # 依已安裝的頻道更新（alpha 留在 alpha、beta 留在 beta）並重啟服務
agend update --alpha            # 從 alpha 頻道安裝（下一個次版本的預覽）
agend update --beta             # 從 beta 頻道安裝
agend update --stable           # 從穩定頻道安裝，即使目前是 beta（可能回到較舊的版本）
agend update --version 2.1.9    # 安裝指定版本
agend reload                    # 熱讀取配置（重新讀取 fleet.yaml，啟動新實例）
```

### 誰停了 fleet

`agend stop`、`agend restart`、`agend update`、`agend fleet stop`、`agend fleet restart`（不指定實例時）會影響所有實例，所以每一個在動作**之前**都會在 AgEnD home 的 `restart-audit.log` 寫一行：時間、指令、父行程鏈與各自的指令列、工作目錄、stdin 是否為終端機，以及在 fleet agent session 內執行時的 `AGEND_INSTANCE_NAME`。指定實例的 `fleet stop <name>` / `fleet restart <name>` 也會記錄。fleet 收到隨後的訊號時，會在自己的 log 裡寫出這筆請求，所以即使 `fleet.log` 被重啟覆蓋，也查得到意外重啟的來源。

從 fleet agent 的 session 內執行時（`AGEND_INSTANCE_NAME` 有值，且會被 agent 執行的所有東西繼承——包括被引號包住的參數裡的 `$(...)` 或反引號），這些指令會被拒絕，除非加上 `--yes`；拒絕本身也會記錄。從測試執行器（`VITEST` / `NODE_ENV=test`）執行則一律拒絕；真的要對測試用 fleet 執行的測試可設 `AGEND_ALLOW_TEST_FLEET_CONTROL=1`。fleet 管理員送出的 `/update`、`/restart` 會連同發送者一起記錄。

## Fleet 管理 (Fleet Management)

```bash
agend fleet start               # 啟動所有實例（手動模式）
agend fleet stop                # 停止所有實例
agend fleet restart             # 優雅重啟（等待閒置，相同代碼）
agend fleet restart --reload    # 使用新代碼重啟（自殺並等待系統重啟）
agend fleet status              # 顯示實例狀態概覽
agend fleet logs                # 提示改用 agend logs
agend fleet history             # 顯示事件歷史（成本、輪轉、懸掛）
agend fleet activity            # 顯示活動日誌（協作、工具呼叫、訊息）
agend fleet activity --format mermaid # 以 Mermaid 序列圖格式輸出活動
agend fleet cleanup             # 移除孤兒實例目錄
```

`agend logs` 讀取 `~/.agend/daemon.log` 的 Fleet 執行日誌，支援 `-n 100`、
`-f` 和 `--instance <name>`。服務的 stdout/stderr 留在 `~/.agend/fleet.log`，
用來查啟動錯誤和 Node 警告；若服務無法啟動，請查看該檔。
`daemon.log` 尚未建立時，`agend logs` 會先讀 `fleet.log`。
在互動式終端執行時，執行日誌也會顯示在 stdout。

## 後端診斷 (Backend Diagnostics)

```bash
agend backend doctor [backend]  # 檢查後端環境（代碼、驗證、tmux、TERM）
agend backend trust <backend>   # 預先核准工作目錄（避免 CLI 的信任對話框）
agend delivery scan-forged-envelopes --instance <name>  # 檢查 kiro instance 的 transcript 裡是否有 fleet 從未投遞過的 peer envelope（--all、--json）
```

## 排程 (Schedules)

```bash
agend schedule list             # 列出所有排程
agend schedule add              # 新增排程
agend schedule delete <id>      # 刪除排程
agend schedule enable <id>      # 啟用排程
agend schedule disable <id>     # 停用排程
agend schedule history <id>     # 顯示排程執行紀錄
```

## 主題綁定 (Topic Bindings)

```bash
agend topic list                # 列出實例與 Telegram 主題的綁定關係
agend topic bind <name> <tid>   # 手動將實例綁定到特定主題 ID
agend topic unbind <name>       # 解除實例的主題綁定
```

## 存取控制 (Access Control)

```bash
agend access list <name>        # 列出實例允許的使用者
agend access add <name> <uid>   # 新增允許的使用者
agend access remove <name> <uid> # 移除使用者
agend access lock <name>        # 鎖定實例存取（僅限白名單）
agend access unlock <name>      # 解鎖實例存取（開啟配對模式）
```

## 設定與安裝 (Setup & Installation)

```bash
agend init                      # 互動式設定精靈
agend install                   # 安裝、啟用並啟動系統服務 (launchd/systemd)
agend install --no-activate     # 只寫入/更新 service 檔案
agend uninstall                 # 移除系統服務
agend export [path]             # 匯出配置以用於遷移
agend import <file>             # 從匯出檔案匯入配置
```

同一次遷移也會替舊的 unit 補上 #1113 的設定：`CoredumpFilter=0` 讓 crash dump 只有幾 KB（WSL 會把所有 crash 交給 WSL 的 crash collector，它不理會 `LimitCORE`；kiro-cli 和 fleet 本身都曾留下約 1GB 和 450MB 的 dump）；`LimitCORE=0` 適用於直接寫 core 檔的系統；`TimeoutStartSec=15min` 取代原本不設上限的啟動逾時；`StartLimitIntervalSec=30min` 搭配 `StartLimitBurst=4`，讓 fleet 在 30 分鐘內失敗 4 次後，systemd 就不再自動重啟。`agend restart` 會先執行 `systemctl reset-failed`，所以不受這個限制影響；直接用 `systemctl --user restart` 則會受限。部分 systemd 版本（包括 249）會忽略 unit 檔裡的 `CoredumpFilter=`，所以在 Linux 上 AgEnD 會自己把 `coredump_filter` 設為 0：fleet 行程在啟動時設，每個它啟動的 CLI 也會設（啟動指令會先在 pane 自己的 shell 裡設好，所以即使 tmux server 不是這個 fleet 起的也有效）。`AGEND_KEEP_COREDUMP_FILTER=1` 會關掉這兩處：行程改用繼承來的 mask（來自 systemd、tmux 或你的 shell），不一定是完整 dump。不論哪種情況 unit 檔都不會被修改；除非你選擇關閉，實際生效的 mask 都是 AgEnD 設的那個。你自己設定的值不會被更動。

在 Linux 上，systemd unit 使用 `KillMode=mixed`：停止或更新服務時會先停 fleet，再由 fleet 依序結束各個 CLI（#908）。`agend restart`（`agend update` 也會執行它）會替舊的 unit 補上這一行並重新載入 systemd；如果做不到，會拒絕重啟並說明怎麼手動處理。你自己設定的 `KillMode` 不會被更動。
