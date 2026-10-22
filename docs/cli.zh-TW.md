# CLI 參考 (CLI Reference)

## 聊天指令（Telegram fleet 選單／Discord slash）

Telegram fleet 選單列出 23 個指令，ClassicBot 選單列出 11 個；Discord 註冊 29 個 slash 名稱。主要指令是 `/web`；`/dashboard` 仍列在選單／slash 上，說明為「已棄用 — 請用 /web」，執行時先印一行提示再跑 `/web`。Telegram 也處理未列入選單的 `/cancel`、`/save`。🔒 代表該範圍的管理員；所屬 fleet／ClassicBot 身分及平台差異請見[指令參考](commands.md)。選單與鎖頭由 `src/command-table.ts` 產生。


| 指令 | 描述 | 選項 / 參數 | 權限 |
|---------|-------------|----------------|------------|
| `/status` | Fleet 表格：Backend、Model、Context、推理強度、花費、執行狀態 | — | 🔒 管理員 |
| `/sysinfo` | 詳細系統診斷（版本、負載、IPC 狀態、各 backend CLI 版本）；Telegram 另可用 `/sys-info`、`/sys_info` | — | 所有人 |
| `/web` (`/dashboard` 別名) | 開啟登入選單，按登入按鈕才會私送一次性登入碼。Discord 私訊失敗可改用僅自己可見的回覆；Telegram 私送被拒時會說明如何先私訊啟動 bot。`/web revoke` 登出所有瀏覽器。`/dashboard` 列為已棄用，會先印提示再做同一件事 | `[revoke]` | 🔒 管理員 |
| `/backend` | 切換 fleet instance 的 backend；ClassicBot 用設定頁或 `classicBot.yaml` | 名稱或選單 | 🔒 管理員 |
| `/visibility` | 跨 instance 訊息顯示方式 | `full\|summary\|hidden`；Telegram 限 General | 🔒 管理員 |
| `/profile` | 在 General 錄製執行中 fleet 的 CPU profile（預設 60 秒，上限 1,800 秒） | `[seconds]` | 🔒 管理員 |
| `/ctx` | 顯示 Agent 的 Context 使用量 | — | 所有人 |
| `/compact` | 壓縮 Agent 的 Context | `[instructions]`——指定摘要重點，僅 Claude Code | 🔒 管理員 |
| `/steer` | 插話到 Agent 正在進行的回合，不等閒置 | `<message>` 必填；`claude-code`／`codex`／`grok`／`muse`，以及以已驗證版本的 TUI 執行的 `kiro-cli`（[說明](commands.md#steer-btw-and-clear-backend-support)） | 所有人 |
| `/btw` | 不中斷目前任務的旁支問題 | `<message>` 必填；僅 `claude-code` | 所有人 |
| `/clear` | 完整重置對話（破壞性——會先問 Confirm/Cancel） | — | 🔒 管理員 |
| `/model` | 切換 backend 模型 | 直接打名稱或用選單選 | 🔒 管理員 |
| `/effort` | 調整 AI 推理強度 | `low\|medium\|high\|xhigh\|max`，不帶參數則彈選單 | 🔒 管理員 |
| `/pause` | 手動暫停閒置的實例 | `[instance]`——在 General 需指名 | 🔒 管理員 |
| `/wake` | 喚醒暫停的實例 | `[instance]`——在 General 需指名 | 🔒 管理員 |
| `/restart` | 在進程內重啟所有實例（不結束進程） | `[full]`／`mode: full` 會重載整個 Fleet 進程與 adapter | 🔒 管理員 |
| `/collab` | 切換 bot／webhook 訊息接收 | — | 🔒 管理員（Telegram ClassicBot 不處理） |
| `/update` | 依已安裝的頻道更新到最新版 | — | 🔒 管理員 |
| `/doctor` | 執行 fleet 健康診斷 | — | 🔒 管理員 |
| `/login` | 遠端 CLI 登入，缺 CLI 時先幫你裝好 | `[backend] [cancel]`；隨時可用 `/login cancel` | 🔒 管理員 |
| `/usage` | 顯示 AI 訂閱用量 | — | 所有人 |
| `/tips` | 在你執行處抽一則使用小提示 | `[mode]`——`on\|off` 開關每日自動推送，`advanced on` 解鎖進階層（皆需管理員） | 抽提示所有人 |

所有其他操作（建立/刪除/啟動實例、委派任務）均由 General 實例透過自然語言處理。

## 服務管理 (Service Management)

```bash
agend start                     # 啟動已安裝的服務；沒有服務時啟動背景 fleet
agend stop                      # 停止 AgEnD 服務
agend restart                   # 透過服務管理器重啟 AgEnD（systemd unit、launchd job，或 detached）
agend restart <name>            # 立即重啟單一實例；fleet 照常運作
agend update                    # 依已安裝的頻道更新（alpha 留在 alpha、beta 留在 beta）並重啟服務
agend update --alpha            # 從 alpha 頻道安裝（下一個次版本的預覽）
agend update --beta             # 從 beta 頻道安裝
agend update --stable           # 從穩定頻道安裝，即使目前是 beta（可能回到較舊的版本）
agend update --version 2.1.9    # 安裝指定版本
agend update --force            # 即使已是最新也強制重裝並重啟
agend reload                    # 熱讀取配置（重新讀取 fleet.yaml，啟動新實例）
```

更新後若新版本的服務起不來（重啟或啟動失敗，或在 macOS 上 launchd 下的 fleet 沒有真正跑起來），更新會回滾：之前的套件、它的 systemd unit 或 launchd plist 與之前的服務都會回來，更新會說明並以 1 結束（#2420）。

為了能回滾，在有服務的主機上，更新會先把已安裝的 AgEnD 複製一份到旁邊的 `<npm prefix>/.agend-rollback/`。這需要 npm prefix 所在磁碟有與已安裝 AgEnD（含內建 Node）相同的可用空間，約 235 MB。空間不足時，更新不會做任何變更，並顯示：

```
✗ Not updating: the installed AgEnD could not be copied aside for a rollback (ENOSPC, No space left on device '…/.agend-rollback/…'). Nothing was changed
```

清出空間後再執行一次即可。更新結束時會移除這份副本；被中斷的更新留下的副本，會由下一次更新移除。無法完成的回滾會刻意保留副本，在訊息中指出位置並在其中放一個 `kept.txt`；不再需要時請自行刪除該目錄。

`agend reload` 會重讀 `fleet.yaml` 並協調實例：新增的啟動、刪除的停掉、改過的套用——fleet 進程本身不重啟。

### 誰停了 fleet

`agend stop`、`agend restart`、`agend update`、`agend fleet stop`（不指定實例時）會影響所有實例，所以每一個在動作**之前**都會在 AgEnD home 的 `restart-audit.log` 寫一行：時間、指令、父行程鏈與各自的指令列、工作目錄、stdin 是否為終端機，以及在 fleet agent session 內執行時的 `AGEND_INSTANCE_NAME`。指定實例的 `fleet stop <name>` / `restart <name>` 也會記錄。fleet 收到隨後的訊號時，會在自己的 log 裡寫出這筆請求，所以即使 `fleet.log` 被重啟覆蓋，也查得到意外重啟的來源。

從 fleet agent 的 session 內執行時（`AGEND_INSTANCE_NAME` 有值，且會被 agent 執行的所有東西繼承——包括被引號包住的參數裡的 `$(...)` 或反引號），這些指令會被拒絕，除非加上 `--yes`；拒絕本身也會記錄。從測試執行器（`VITEST` / `NODE_ENV=test`）執行則一律拒絕；真的要對測試用 fleet 執行的測試可設 `AGEND_ALLOW_TEST_FLEET_CONTROL=1`。fleet 管理員送出的 `/update`、`/restart` 會連同發送者一起記錄。

## Fleet 管理 (Fleet Management)

```bash
agend fleet start               # 啟動所有實例（手動模式）；已安裝服務時改執行 `agend start`
agend fleet start <name>        # 啟動指定實例
agend fleet stop                # 停止所有實例；已安裝服務時改執行 `agend stop`
agend fleet stop <name>         # 停止指定實例
agend fleet restart [<name>]    # 已淘汰，2.4 移除：改執行 `agend restart [<name>]`（--reload 會被忽略）
```

在已安裝 AgEnD 服務的主機上（systemd 使用者或系統 unit，或 launchd job），手動執行 `agend fleet start`、`agend fleet stop` 會改交給 `agend start` / `agend stop` 並提示一行，讓服務管理器繼續管理 fleet：不會在服務旁邊多出一個沒人管的 fleet，也不會出現被 systemd 復原的停止（#2356）。服務管理器自己的 `fleet start`（unit 的 `ExecStart`、launchd job）以及沒有安裝服務的主機（Docker、手動設定）照舊直接啟動。指定實例名稱（`fleet start <name>`、`fleet stop <name>`）的用法不變。`agend stop` 也會停止系統 unit（`agend.service`）。若已安裝的服務在這台主機上無法執行（檔案寫好了但從未啟用，或 launchd 沒有可用的 session），`agend start` 會拒絕在它旁邊啟動 fleet 並說明原因；從你自己的 shell（不是 agent session）執行 `agend fleet start --direct`，就會不經服務直接啟動 fleet。fleet 自己的鎖仍會拒絕同一個 AgEnD home 上的第二個 fleet。

```bash
agend fleet history             # 顯示事件歷史（成本、輪轉、懸掛）
agend fleet history --instance <name> --type <type> --since <date> --limit <n> --json
agend fleet activity            # 顯示活動日誌（協作、工具呼叫、訊息）
agend fleet activity --since 2h --limit 200 --format text
agend fleet activity --format mermaid  # 以 Mermaid 序列圖輸出活動
agend fleet cleanup             # 移除孤兒實例目錄
agend fleet cleanup --dry-run   # 只預覽，不刪除
```

`agend fleet status` 是 `agend ls --resources` 的隱藏別名。`agend fleet logs` 已移除，請用 `agend logs`。

## 實例工具 (Instance Tools)

```bash
agend ls                        # 列出實例（狀態、backend、team、context、活動）
agend ls --json                 # JSON 輸出
agend ls --names-only           # 每行一個名稱（shell 補全用）
agend ls --resources            # 一併回報工作區磁碟、未列名目錄、主機記憶體／swap
agend ls --running              # 只列出執行中的實例
agend ls --team <name>          # 依 team 篩選
agend ls --backend <name>       # 依 backend 篩選
agend ls --display              # 在最後一欄顯示 display name（預設隱藏）
agend attach [name]             # 接入實例的 tmux 視窗（接受真名、display name、列號或子字串）
agend logs                      # 顯示 fleet 日誌（daemon.log；還沒有時改讀 fleet.log）
agend logs -n 100               # 顯示最後 100 行（預設 50）
agend logs -f                   # 追蹤模式（tail -f）
agend logs --instance <name>    # 只看指定實例
agend export-chat               # 把 fleet 活動匯出成 HTML 聊天記錄
agend export-chat --from <date> --to <date> -o <path>
agend profile [seconds]         # 錄製執行中 fleet 的 CPU profile（僅本機操作者；預設 60 秒，上限 1800）
agend delivery show             # 讀取一筆耐久 delivery 狀態（操作者；查詢會寫入本機稽核）
```

`agend status` 是 `agend ls` 的隱藏別名（已送出的更新訊息與 Windows 捷徑仍寫 `agend status`）。

`agend logs` 讀取 `~/.agend/daemon.log` 的 Fleet 執行日誌。服務的 stdout/stderr 留在 `~/.agend/fleet.log`，用來查啟動錯誤和 Node 警告；若服務無法啟動，請查看該檔。`daemon.log` 尚未建立時，`agend logs` 會先讀 `fleet.log`。在互動式終端執行時，結構化日誌也會顯示在 stdout。

## Shell 補全 (Shell Completion)

幫 `agend attach` 與 `agend fleet start|stop|restart` 補實例名，其他位置補子指令名。

```bash
agend completion install        # 建議：自動裝好
agend completion status         # 確認新 shell 裡 <TAB> 真的會動
agend completion bash           # 印出 bash 腳本
agend completion zsh            # 印出 zsh 腳本
```

`completion install` 會偵測你的 shell，做侵入最小且有效的做法：

- **bash**——把靜態檔寫到 `~/.local/share/bash-completion/completions/agend`（root 則寫系統目錄）。不動 rc 檔、重跑冪等、不增加 shell 啟動成本——bash-completion 第一次按 `<TAB>` 才會載入。只有 shell 載入了 **bash-completion** 才讀得到（Ubuntu/Debian 預設有；macOS 的 bash 與最小容器沒有）。`install` 會用真的互動式 bash 檢查，沒載入時會明說：加 `--modify-rc` 改在 `~/.bashrc` 加一行 marker 保護的行（最多加一次），或自行安裝 bash-completion。
- **zsh**——只印出要加的那一行，因為啟用本來就要改 `~/.zshrc`。加 `--modify-rc` 讓它幫你附加上去（最多一次）。Root 安裝改寫 `/usr/share/zsh/site-functions/_agend`，完全不碰 rc。

安裝程式會在 `install.sh` 結尾自動跑（`AGEND_NO_COMPLETION=1` 可跳過；rc 那行要用 `AGEND_MODIFY_RC=1` 授權），`agend quickstart` 也會問。`agend update` 會刷新已安裝的補全檔，讓它跟新版指令一致——但絕不會裝新的東西。還沒安裝前，`agend ls` 結尾會有一行提示指來這裡。裝好後開一個新終端機。

手動做法——在 shell rc 加一行：

```bash
# bash — ~/.bashrc
echo 'eval "$(agend completion bash)"' >> ~/.bashrc

# zsh — ~/.zshrc（需要 compinit，見下）
echo 'eval "$(agend completion zsh)"' >> ~/.zshrc
```

然後重載 shell（`exec $SHELL`），試試 `agend attach age<TAB>`。

zsh 需要先初始化補全系統。若還沒做，`autoload -Uz compinit && compinit` 必須寫在 `~/.zshrc` 的 `eval` 行**上面**。

名稱來自 `agend ls --names-only`，所以補全給的正是 `attach` 吃的實例——包括只存在於 `classicBot.yaml` 的 ClassicBot 實例。每按一次 TAB 就跑一次那個指令（約 90ms）。

## 診斷與驗證 (Diagnostics & Validation)

```bash
agend doctor                    # 主機／安裝診斷（backend、tmux、服務、D-Bus、fleet、IPC、網路）
agend doctor mcp                # 全 fleet MCP 健康檢查（IPC、配置路徑、重複、binary PATH）
agend health                    # 執行中 fleet 的即時健康（HTTP、tmux、IPC）；不能代替 doctor
agend validate                  # 驗證 fleet.yaml 與 classicBot.yaml
agend validate --connections    # 印出 CONNECTIONS=<n>：fleet.yaml 的聊天連線數（給腳本用）
agend backend doctor [backend]  # 檢查後端環境（執行檔、驗證、tmux、TERM）
agend delivery scan-forged-envelopes --instance <name>  # 檢查 kiro instance 的 transcript 裡是否有 fleet 從未投遞過的 peer envelope（--all、--json）
```

## Web 儀表板 (Web Dashboard)

```bash
agend web                       # 印出一次性登入碼並開啟登入頁
agend web --code                # 只印出登入頁和登入碼（不開瀏覽器）
agend view                      # 在瀏覽器開唯讀 View 儀表板
agend web-token rotate          # 讓所有瀏覽器登出，並更換 CLI token
agend setup                     # 引導式設定頁，fleet 還不存在時用
agend setup --reset             # 允許 setup 在完成後再跑一次
agend setup --tunnel            # ……並公開出去，讓手機也能開
```

`agend setup` 在健康 port 上開一個小表單，並印出**兩樣**東西：設定頁網址與設定碼。網址只代表頁面在哪，不是使用許可——隨機路徑只是讓人用猜的猜不到。真正的憑證是打進頁面的設定碼；憑證不進網址，轉發的訊息、shell 歷史、聊天軟體的連結預覽才帶不走完整權限。打錯五次就關頁，錯的碼與重播的 session cookie 共用額度；打錯路徑不算——否則找到主機的人不用找到頁面就能把它關掉。

頁面在完成、15 分鐘到、或閒置 10 分鐘後自己關掉——沒人看著的設定表單就是暴露面。

**Web only (no bot)**（#2233）是 Telegram、Discord 之外的第三個選項：不用 bot token、不用管理員 ID、也沒有要驗證的東西。它只寫入第一個 agent、不建立聊天連線，所以 AgEnD 從網頁儀表板使用（在機器上用 `agend web --code` 取得登入碼），後端 CLI 也在那裡登入（設定 → Agent → 登入）。之後可以在設定加上 Discord 或 Telegram。主機確認（`agend settings confirm <id>`）一樣要做。

`--tunnel` 每次都要你親口確認，沒有旗標或設定可以預先答應；沒有終端的執行直接拒絕，不當作你同意了。手機設定走 Cloudflare 通道，你打進去的 bot token 會經過 Cloudflare 的邊緣——不能接受就回機器上設。

### 儀表板登入與 session

在 General 傳 `/web`，再按 **💻 AgEnD 電腦登入（取碼）**（其他裝置可選臨時公開）。私送內容包含頁面與登入碼；主機上的 `agend web --code` 也可取碼。只有最新的碼有效，五分鐘內限用一次。

- 直接連線的 dashboard session 預設 48 小時，可用 `web.session.local.*` 設定。公開連結 session 最多四小時、閒置 30 分鐘，或連結關閉時結束。
- `/web revoke` 登出所有瀏覽器並撤回未使用的碼；`agend web-token rotate` 另更換 header token。
- 登入碼或 session 授予 web 管理權限，請勿轉傳；session cookie 不是經驗證的平台身分。
- 瀏覽器寫入需 session 的 CSRF 值及符合 Host 的 Origin。腳本用 `X-Agend-Token`；有提供 Origin 時仍須符合 Host。
- Loopback listener 的 `/view` 讀取預設開放；設 `web.view_access: session` 才需登入，個人資料寫入一律需授權。

裝置、公開連結、上傳與預覽請見[網頁指南](web-dashboard.zh-TW.md)；完整憑證規則請見[安全說明](SECURITY.zh-TW.md#dashboard-登入與瀏覽器-session)。

### 套用設定變更

`POST /api/settings/apply` 回傳 job；`GET /api/settings/apply/:jobId` 是權威狀態。每個受影響的 agent 一列：`hot` 表示透過 IPC 直接套用，`restart` 表示須重啟 CLI。

第一次嘗試前產生 `Idempotency-Key`，每次重試都沿用；相同 key 會取得原 job，不會重複套用。舊 `POST /api/settings/reload` 仍發送 SIGHUP，但不回報套用結果。

Job 存在磁碟，fleet 自己重啟後由新行程接手，將重啟時仍在處理的項目標成 `settled_by: "fleet-restart"`，繼續接受 GET 查詢。超過期限會回報 `overdue` 與「仍在重啟（Ns）」訊息。

同時只能有一個 reconcile。SIGHUP 與 Apply 共用名額；套用期間的 signal 合併為一次重播，第二個 Apply 回 `409` 及目前的 `running_job_id`。設定已寫入磁碟，重試不會遺失它。

只有新 fleet 行程才能採用的設定會標成 `restart-required`，而非 `done`：設定有效且已儲存，但尚未生效；後續 Apply 仍會顯示，直到真正重啟。這些包括 channel 綁定、`health_port`、`defaults.locale`，以及建立 subsystem 時只讀一次的 `cost_guard`、`webhooks`、`daily_summary` 和 scheduler 設定。`defaults.backend` 不在其中，agent 自己重啟即可採用。

面板可透過 `POST /api/settings/restart-fleet` 重啟，另有確認、idempotency key，以及持久化的每十分鐘一次、每小時三次上限。啟動前先記錄限制並在聊天公告；公告無法送出就拒絕重啟。

`/ui/events` 的 `apply_progress` SSE 只用來加速更新，沒有 event ID；重連不能要求補發，所以收到後仍應重新查 job。

**連結一直回到「No session」時**，請檢查代理的 HTTPS header：標成 Secure 的 cookie 無法在純 HTTP 儲存。

## 排程 (Schedules)

```bash
agend schedule list             # 列出所有排程
agend schedule list --target <name> --json
agend schedule add              # 從 CLI 新增排程
  --cron <expr>                 # Cron 運算式（必填）
  --target <instance>           # 目標實例（必填）
  --message <text>              # 要注入的訊息（必填）
  --label <text>                # 人看的標籤
  --timezone <tz>               # IANA 時區（預設 Asia/Taipei）
agend schedule update <id>      # 更新排程參數
  --cron --message --target --label --timezone --enabled <bool>
agend schedule delete <id>      # 刪除排程
agend schedule enable <id>      # 啟用排程
agend schedule disable <id>     # 停用排程
agend schedule history <id>     # 顯示排程執行紀錄（--limit <n>）
```

## 樣板部署 (Template Deployments)

樣板部署走 MCP 工具（給 agent 用），不是 CLI 指令：

- `deploy_template`——把 `fleet.yaml` 的樣板部署到目錄
- `teardown_deployment`——停掉並刪除一次部署的所有實例
- `list_deployments`——列出使用中的部署與狀態

樣板定義語法見 [configuration.md](configuration.md#templates)。

## 主題綁定 (Topic Bindings)

```bash
agend topic list                # 列出主題綁定
agend topic bind <name> <tid>   # 把實例綁到主題
agend topic unbind <name>       # 解除實例的主題綁定
```

## 存取控制 (Access Control)

```bash
agend access list <name>        # 列出允許的使用者
agend access remove <name> <uid> # 移除使用者
agend access lock <name>        # 鎖定實例存取（僅限白名單）
agend access unlock <name>      # 解鎖實例存取（開啟配對模式）
agend access pair <name> <uid>  # 產生配對碼
```

`access pair` 只產生碼，不會核准。CLI 沒有確認配對碼的指令，也沒有 `access add`；主人可透過設定的使用者名單授權。保存狀態與 YAML 名單會合併，見[存取設定](configuration.zh-TW.md#channelaccess)。

## 設定與安裝 (Setup & Installation)

```bash
agend quickstart                # CLI 引導式第一次設定：backend、聊天頻道、專案、fleet 服務（建議）
agend setup                     # 瀏覽器第一次設定頁，在 fleet 存在之前
agend init                      # 進階互動精靈（setup-wizard）；第一次設定請用 quickstart 或 setup
agend install                   # 安裝、啟用並啟動系統服務 (launchd/systemd)
agend install --no-activate     # 只寫入/更新 service 檔案
agend uninstall                 # 移除系統服務
agend export [path]             # 匯出配置以用於遷移
agend export --full [path]      # 匯出配置＋所有實例資料
agend import <file>             # 從匯出檔案匯入配置
agend shortcuts                 # WSL：建立或更新 Windows 桌面捷徑
```

**從 WSL 建立 Windows 桌面捷徑（#1853）。** `agend shortcuts` 會在 Windows 桌面建立（或更新）**AgEnD 儀表板**和 **AgEnD 重新啟動**，給安裝時還沒有這兩個捷徑、或平常只用 `agend update` 更新的人使用。它透過 WSL interop，在 Windows PowerShell 裡執行 Windows 安裝程式自己的捷徑程式碼，對象是目前這個 Linux（`WSL_DISTRO_NAME`）和執行它的使用者，並記到 `%LOCALAPPDATA%\AgEnD\install.json`（和安裝程式寫的是同一個檔案）。每個捷徑的第一行會顯示它打開的 Linux 和使用者（「AgEnD（Linux：AgEnD，使用者：root）」）。如果 install.json 已經指向另一個 Linux 或使用者（例如 AgEnD 專用的 Linux 和你原本的 Ubuntu），會先說明並詢問才切換；沒有終端機可以詢問時就不做任何變更。不在 WSL 裡時不做任何變更。interop 關閉時（沒有 `WSLInterop` 的 binfmt 項目，或找不到 `powershell.exe`），它會直接說明，並指出另一個方法：再貼一次 Windows 一行安裝指令，已經裝好 AgEnD 的電腦上它只會問要不要更新捷徑。在還沒有捷徑的 WSL 終端機裡執行 `agend update` 之後，會出現一行提示建議執行 `agend shortcuts`，只出現一次（聊天裡的 `/update` 沒有終端機，所以不會出現）。更新本身絕不會在桌面上建立任何東西。

`agend quickstart` 會從所選伺服器的新訊息或 bot 私訊偵測 Discord 管理員，再請你確認顯示的使用者名稱與 ID。連線後看到提示再發訊息。最多等待 30 秒；如果未偵測到或你不確認，就必須手動輸入使用者 ID（17–20 位數字，開頭不能是 0），格式錯誤會重新詢問。設定 → 設定精靈與新增連線也必須填入有效管理員 ID；網頁表單這次尚未加入 Discord 自動偵測。Telegram 保留訊息偵測，手動網頁設定時也必須填入正整數使用者 ID。既有存取名單不會遷移。

在 Linux 上，systemd unit 使用 `KillMode=mixed`：停止或更新服務時會先停 fleet，再由 fleet 依序結束各個 CLI（#908）。`agend restart`（`agend update` 也會執行它）會替舊的 unit 補上這一行並重新載入 systemd；如果做不到，會拒絕重啟並說明怎麼手動處理。你自己設定的 `KillMode` 不會被更動。

**Fleet 停機期限（#1071）。** Detached `agend restart` 與 AgEnD 的 systemd unit 都會給停機五分鐘。Busy Kiro 的 drain、quit 與 signal grace 各有階段期限，但逐批停止會累加等待；舊的 detached 10 秒與 unit 60 秒上限可能截斷它們。Restart 會將 AgEnD 原本的 `TimeoutStopSec=60` 預設遷移成 `300`，並在停止前核對 systemd 已載入的期限。明確自訂值、重複賦值與 drop-in 覆寫會保留並提示；直接以 service manager 停止／重啟仍依 operator 設定，較短的自訂期限可能截斷停機。`agend restart` 則會拒絕所有已選定、已載入期限讀不到或小於 300 秒的 systemd target，包含自訂值與 drop-in。五分鐘是外部上限，不保證涵蓋任意 fleet 大小或緩慢／卡住的 transport。

Detached restart 使用非同步 polling 與 monotonic deadline。期限到了會重新核對 PID 的啟動 identity 與指令列，再送 SIGKILL，並最多等五秒確認真正退出。Ownership 讀不到或舊 owner 仍活著就拒絕啟動 replacement，避免重複 fleet。若已記錄的啟動 identity 不變，只有指令列變空，可以在 grace 內等待新的退出證據；空指令列不能授權 SIGKILL 或 replacement。launchd 原有的停機／activation 政策不變。

同一次遷移也會替舊的 unit 補上 #1113 的設定：`CoredumpFilter=0` 讓 crash dump 只有幾 KB（WSL 會把所有 crash 交給 WSL 的 crash collector，它不理會 `LimitCORE`；kiro-cli 和 fleet 本身都曾留下約 1GB 和 450MB 的 dump）；`LimitCORE=0` 適用於直接寫 core 檔的系統；`TimeoutStartSec=15min` 取代原本不設上限的啟動逾時；`StartLimitIntervalSec=30min` 搭配 `StartLimitBurst=4`，讓 fleet 在 30 分鐘內失敗 4 次後，systemd 就不再自動重啟。`agend restart` 會先執行 `systemctl reset-failed`，所以不受這個限制影響；直接用 `systemctl --user restart` 則會受限。部分 systemd 版本（包括 249）會忽略 unit 檔裡的 `CoredumpFilter=`，所以在 Linux 上 AgEnD 會自己把 `coredump_filter` 設為 0：fleet 行程在啟動時設，每個它啟動的 CLI 也會設（啟動指令會先在 pane 自己的 shell 裡設好，所以即使 tmux server 不是這個 fleet 起的也有效）。`AGEND_KEEP_COREDUMP_FILTER=1` 會關掉這兩處：行程改用繼承來的 mask（來自 systemd、tmux 或你的 shell），不一定是完整 dump。不論哪種情況 unit 檔都不會被修改；除非你選擇關閉，實際生效的 mask 都是 AgEnD 設的那個。你自己設定的值不會被更動。

**單一行程因記憶體不足被 kill，不再讓整個 fleet 停掉（#2015）。** instance 執行的一切（它的 CLI、tmux、agent 啟動的每個指令）都在這個服務的 cgroup 裡。systemd 預設是 `OOMPolicy=stop`：kernel 因記憶體不足 kill 掉其中任何一個行程，就會停掉整個 unit，所有 instance 都跟著停。現在 unit 設定 `OOMPolicy=continue`，只有被 kill 的那個行程會結束：
- **被 kill 的工具指令**（agent 執行的腳本）只是它的 CLI 看到的一個錯誤。
- **被 kill 的 CLI** 通常走既有崩潰恢復流程。同一個已確認的後端／工作階段連續兩次確認遭記憶體不足終止時，會停止自動重啟（#2035），由 General 與網頁日誌說明原因，並在「需要你」列出崩潰的 Agent。原工作階段與對話紀錄保留；請先釋放記憶體，再手動重啟以重試，或選擇新的工作階段。不會自動建立新工作階段。
- **被 kill 的 fleet 行程**是服務失敗，由 `Restart=on-failure` 重新啟動。

安裝、啟動與重啟也會在重新載入管理器後，回報**實際載入**的 `OOMPolicy`。若管理者的設定令生效值為 `stop`／`kill`，或無法讀取，會如實提醒，不會當作已確認隔離，也不新增重啟拒絕條件。

更新時會重寫 user unit，帶上這一行。`agend restart` 會替舊的 unit 補上，更新時的 refresh 也會替舊式的 system unit（`/etc/systemd/system/agend.service`）補上。unit 自己設定了 `OOMPolicy` 的話會保留原值。systemd 243 以前的版本不認得這個設定，會忽略它，並在 journal 留下警告。macOS 沒有對應的設定：launchd 沒有每個服務各自的 cgroup，kernel（jetsam）只會 kill 那一個行程；如果被 kill 的是 fleet，`KeepAlive` 會重新啟動它。

同一工作階段的 OOM 防護目前僅使用 Claude Code 專屬於 instance 的 statusline 工作階段識別。Codex／Kiro 沒有這個識別，Muse／Grok 依工作目錄挑選的識別不代表 pane 所有權，因此均沿用一般恢復。

OOM 判定採保守原則：Linux 必須取得啟動期間的核心紀錄，且受害者是存活時已觀測的主 CLI PID，位於最初的 PID 命名空間。只有退出碼 137、共用 cgroup 計數器、記憶體壓力或對話大小均不足以判定。工作階段不明、未觀測到的快速退出、無法讀取證據、容器的巢狀 PID 命名空間與 macOS，均沿用一般崩潰恢復。工具或 MCP 子程序不等於主 CLI。不新增因記憶體用量而主動終止程序的功能或統一的指令上限；手動重啟 Agent 或 fleet 會開始新的恢復嘗試。

**fleet 的就緒訊號必須送得到 systemd（#2331）。** unit 是 `Type=notify`：fleet 透過一個短暫的 `systemd-notify` 輔助程式告訴 systemd 它已就緒（`READY=1`），不是由主行程自己送，所以 systemd 只有在 `NotifyAccess=all` 時才會收下。設成 `main`、`exec`，或完全沒寫 `NotifyAccess`（`Type=notify` 的預設就是 `main`）時，systemd 會拒收：`Got notification message from PID …, but reception only permitted for main PID …`。fleet 本身照常執行，但 unit 會一直停在 `activating`，直到 `TimeoutStartSec` 用完，systemd 就把它 kill 掉再重啟——自從 `TimeoutStartSec=15min`（#1113）起就是每 15 分鐘一次。以前逾時是 `0` 的時候，同樣的 unit 只會停在 `activating`，沒有人會發現。
- **unit 檔：**`agend restart` 和更新時的 refresh 會在 `Type=notify` 的 unit（user unit 和舊式的 system unit）裡寫入 `NotifyAccess=all`，取代 `main`、`exec` 或 `none`。AgEnD 自己只有在 0.0.24-beta.5 到 beta.12 用過 `main`。
- **drop-in：**reload 之後，AgEnD 會問 systemd 實際*載入*的值。如果某個 drop-in（除了這個自己的檔案，AgEnD 不寫 drop-in）仍設成別的值，AgEnD 會加上自己的、排在最後的 drop-in `<unit>.d/zz-agend-notify.conf`（`NotifyAccess=all`），再 reload 並重新確認。你的 drop-in 不會被改動，只會被點名；等它不再設定 `NotifyAccess`，AgEnD 的檔案就可以刪掉。如果某個排序更後面的 drop-in 仍然勝出，重啟照常進行，並會印出一行告訴你要改哪個檔案。
- **殘留設定：**install、start、restart 和更新都會點名會影響 fleet 啟動方式的檔案：設定了 `Type`、`NotifyAccess`、`ExecStart`、`TimeoutStartSec`、`WatchdogSec`、`Restart` 或 `EnvironmentFile` 的 drop-in；system unit 執行 fleet 時旁邊多出來的 user unit；使用 AgEnD 舊名稱（`com.ccd.fleet`、`com.claude-channel-daemon`，改名前的原始碼建置）的 unit 或 plist。每次都會點名，直到你自己移除為止；AgEnD 絕不刪除它們。fleet 由 system unit 執行的主機，更新時的 refresh 不再寫入 user unit，所以以前留下的那個只要移除後就不會再出現。
- **`agend doctor`** 會顯示 systemd 實際載入的 unit（有 system unit 執行 fleet 時就看它）（`Type`、`NotifyAccess`、`TimeoutStartSec`）、它來自哪些檔案（unit 檔和每個 drop-in），以及每一項殘留設定。`Type=notify` 卻不是 `NotifyAccess=all` 的 unit 會列為錯誤。
- **第一次更新就會修好：**`agend update` 會執行新版本自己的 refresh 和 restart，所以更新到含此修正的版本時，就會在那一次更新裡修好 unit。

**記憶體壓力下的啟動等待（#2461）。** 啟動佇列因記憶體保護而等待時，會立即向 systemd 延長啟動期限 15 分鐘，並每 30 秒續期，避免把已啟動一半的團隊反覆重啟。仍然等到啟動完成才送出就緒訊號；網頁與 systemd 狀態會顯示正在等待。一般並行限制、故障退避或其他啟動卡住的情況不會續期。事件迴圈監測在 General 啟動前開始，但仍須主迴圈能正常執行。記憶體壓力偏高或嚴重時，整批停止與重啟會每批最多停止五個實例；停止本身不等待記憶體恢復。詳見[記憶體壓力說明](memory-pressure.md)。

**服務用哪個 Node 執行，以及 `agend restart` 何時會拒絕（#1450）。**
- 有 AgEnD 自帶的 Node（或驗證過的 `AGEND_NODE`）時，unit（`ExecStart=`）和 plist（`ProgramArguments`）會先寫那個 Node，接著是套件的 `dist/cli.js`，最後是 `fleet start`。自帶 Node 的路徑只會在 npm 更新 AgEnD 時改變，而 `agend update` 屆時會重寫服務。runtime 的目錄不會出現在任何服務的 PATH 上，各 coding CLI 照舊使用原本的 Node。
- 沒有自帶 Node 的平台（glibc Linux 與 macOS 11 以上的 x64/arm64 以外），服務改為啟動套件的 launcher（`<套件>/launcher/agend fleet start`），由它在每次啟動時從服務的 PATH 找 Node。所以用 nvm 或 Homebrew 升級 Node（會刪掉舊版目錄）也不會讓服務壞掉；Node 太舊時會在啟動時拒絕，原因寫進服務的 log。
- `agend restart` 在停止任何東西之前，會確認服務管理器**已載入**的定義正好是這樣：寫明選定的 Node、這次安裝的 entry、`fleet start`、沒有 `NODE_OPTIONS`/`NODE_PATH`，而且沒有待重新載入的變更。不符合就拒絕，什麼都不停止。
  - 舊格式的定義（把 Node 交給 `#!/usr/bin/env node` 和服務的 PATH 決定）會因此被拒絕；請執行 `agend install` 重寫。
  - `agend restart --force` 是給已自行檢查過服務的管理者用的；`agend update` 從不使用。
  - 使用 system-source runtime 時，nvm/Homebrew 換版可能讓服務的 PATH 找到舊 Node，或完全找不到。Restart 仍會拒絕。在選到預期 Node 的 shell 執行 `agend install --no-activate`、`systemctl --user daemon-reload`，再執行 `agend restart`，可修復 user unit。System unit 則由其管理者更新 `Environment=PATH`，先執行 `systemctl daemon-reload`；`agend install` 只會寫 user service。macOS 使用 `agend install --no-activate`，再以 `agend restart` 執行預定的 launchd 啟用。
- **macOS：** `agend install` 會寫入 `~/Library/LaunchAgents/com.agend.fleet.plist` 並載入 `gui/<uid>`，也就是你登入工作階段的 domain，LaunchAgents 會在登入時載入。
  - 對 launchd 來說，載入 plist 就等於啟動 job。所以 `agend install --no-activate` 只會寫入並驗證新的 plist，並記錄一次「預定的啟用」；已載入的 job 照常執行。
  - 下一次 `agend restart` 會執行這次啟用，只做一次：一次 `bootout`、一次 `bootstrap`。接著 `launchctl print` 必須顯示新的 job 正在執行；若沒有，會重新 bootstrap 先前的 plist 並確認。
  - 只能用 SSH 連線、沒有人登入的 Mac 沒有 `gui/<uid>` domain（`launchctl` 回報錯誤 125）。在那裡 job 只能以 `LimitLoadToSessionType=Background` 載入 `user/<uid>`；`agend install` 不會這樣寫，這種 job 需要你自行管理。

**更新怎麼安裝（#2264）。** `agend update` 和安裝的一行指令都執行目標版本自己的安裝程式：
`npm exec --yes --package @songsid/agend@<版本> -- agend-install`。任何中斷的更新，再執行一次一行指令就能修好。安裝程式會：
- 在動任何東西之前先取得安裝鎖。另一個安裝程式正在執行時，它會停下、不做任何改動（也不碰那次更新的聊天訊息）；一行指令會說明無法取得安裝鎖（安裝程式會印出原因：讓正在進行的安裝完成，或該如何處理留下的東西），並以代碼 75 結束，而不是回報安裝失敗（#2284）。已結束的安裝程式留下的鎖會被移到一旁；讀不懂的鎖在沒有任何程序開著它時也會被移到一旁（較舊的更新程式還在寫它時則保留）。較舊版本的 AgEnD 更新程式看得到安裝程式的鎖，會等它完成。它會一直持有這個鎖直到完成；
- 把 npm 移到旁邊的那份 AgEnD（`@songsid/.agend-…`）在它是唯一完整的一份時放回去，讓 `agend` 恢復可用。只有在主機上沒有 npm 正在安裝、移除或更新套件時才會這麼做；否則不碰 npm 留下的東西，並說明原因。不會刪除任何東西：移到一旁的都放在 `<npm prefix>/.agend-quarantine/`；
- 安裝該版本，並確認 `agend --version` 回報的是它。npm 失敗但前一版仍能執行時，不再做其他事，並如實說明。沒有任何能執行的 `agend` 時，才重新裝回前一版；
- 用新版本的 `agend install --no-activate` 更新服務設定，沿用原本的服務管理方式（系統層的 `/etc/systemd/system/agend.service` 仍是系統層）。接著艦隊正在執行就重新啟動；服務已安裝但停著，就啟動它。手動啟動的艦隊不會被建立服務，只有更新時才會重新啟動它。在 Linux 上，`agend install`、`start`、`restart` 會為使用者開啟 systemd linger，並從任何 shell（包括 WSL 上的 root）找到使用者的 systemd。`status` 和 `stop` 只補上 `XDG_RUNTIME_DIR` 與 bus 位址，不改動主機設定。

`agend update` 只有在目標版本自帶安裝程式時才執行它。目標是較舊的版本（例如用 `agend update --version` 回到這次改動之前的版本），或 npm prefix 需要 sudo 時，沿用下面說明的舊更新流程。在那條流程裡，搬到 nvm 之後只有 2.1 版的系統層副本會被退役。

**更新的啟用結果（#1490）。** 套件驗證通過不代表 fleet 正在執行。確認重啟完成才算成功；未完成的重啟回傳 exit 75（pending），保留更新標記與所有修復備份，不還原或移除套件。重啟失敗回傳 exit 1。Systemd 路徑只有在載入的目標相同、unit bytes 未變、沒有待執行 job、main/control PID 都為零，且確認停止之後，才可還原本次更新的套件與 unit 備份。重新載入並核對舊定義後，才啟動原本正在執行的服務；原本停止的服務維持停止。即使回復成功，仍回報本次更新失敗。Ownership 變更或讀不到、沒有備份、detached owner、自訂而無法追蹤停止的模式或回復未完成，都需要管理者檢查，不能回報回復成功。重試前請以 `systemctl [--user] status <unit>` 檢查選定的服務。這些核對不能讓外部的服務／套件修改變成原子操作；更新期間請勿同時執行其他安裝或服務管理操作。
回復會恢復舊執行檔的政策，不會還原資料目錄。備份來自較舊版本時，請先看[降版相容性限制](downgrade-compatibility.zh-TW.md)。

聊天 `/update` 使用已驗證的安裝執行檔。在 Linux 上，若 fleet 位於服務的 cgroup，
會先把 updater 移到獨立的 user scope，再等待原有的兩秒延遲。單靠 `detached`
無法讓程序活過 systemd 服務停止。Scope 繼承 fleet 的環境與工作目錄；憑證不會放進
命令參數。這需要可連線的同使用者 systemd manager，以及 240 以上的 `systemd-run`。
由系統 manager 執行的 fleet（舊的 `/etc/systemd/system/agend.service`，以 root 執行）
改用系統 manager 的 scope，只有 root 能申請；不是 root 的系統服務 fleet 會拒絕聊天更新（#2274）。
Cgroup 不明、helper 不支援或啟動失敗時，聊天更新會拒絕並提示從主機 shell 執行
`agend update`，不會退回 fleet 的 cgroup。Linux 上不在服務 cgroup 內的 detached
fleet 與 macOS 維持原有啟動路徑。Scope 隔離的是 fleet 停止，無法抵抗主機關機，
或登出時一併停止 user manager。

## 環境變數 (Environment Variables)

| 變數 | 描述 |
|----------|-------------|
| `AGEND_BOT_TOKEN` | Telegram/Discord bot token（或在 fleet.yaml 用 `bot_token_env` 自訂環境變數名） |
| `GROQ_API_KEY` | 語音轉文字的 Groq API key（選填） |
| `AGEND_TMUX_SESSION` | 覆寫 tmux session 名（預設 `agend`） |
| `AGEND_HOME` | 覆寫資料目錄（預設 `~/.agend`） |

## `agend settings`

```bash
agend settings confirm <id>        # 列出來源／請求人／完整遮蔽 diff，再詢問 y/N
agend settings confirm <id> --yes  # 無 TTY 時明確確認剛檢查的 diff
agend settings reject <id>         # 拒絕這台主機上待確認的 Settings 變更
```

在 host 上以 fleet 或 SetupHost 的相同使用者執行。它不會啟動 fleet；確認由私有本機 socket 負責。Agent session（存在 `AGEND_INSTANCE_NAME`）不能使用。套用前會再次核對 id、socket owner generation，以及檢查過的 effect／summary。過期或 stale 請求需重新提出；pending 不會跨重啟保存。

## 遮蔽敏感資料的問題回報

General／協調者的受管理 `bug-report` 技能會先在本機整理回報，於聊天附上遮蔽後的 Markdown 檔，再請你核准確切的標題、內文與檔案，才產生 GitHub 預填連結。也可以直接使用：

```bash
agend bug-report --since 30m --out report.json --description-file problem.txt --steps-file steps.txt
# 檢查 report.json 與 report.json.md，使用收集時印出的 SHA256 核准：
agend bug-report --draft report.json --approve <SHA256>
```

第二個命令只印出 GitHub 新問題的預填連結，不會開啟瀏覽器或提交。請用自己的 GitHub 帳號提交；沒有帳號也能自行保存、分享 `report.json.md`。本功能不含社群頻道、專案 webhook、內建憑證或自動上傳。

預設收集最近 30 分鐘；`--since` 可用正整數 `m`、`h`、`d`，上限 7 天。`daemon.log` 與 `fleet.log` 各只讀取尾端最多 256 KiB、1,500 行，另嘗試最多 5 秒的 systemd 使用者服務日誌查詢。只選擇時間範圍內的記錄；沒有時間戳記的錯誤會標示時間未知，不宣稱發生於該區間。不讀取輪替舊檔，缺漏或無法讀取的來源會註明。環境包含已安裝的 AgEnD、Node／執行環境、作業系統與 WSL／發行版。後端 CLI 版本只讀取既有 `cli-env` 快取的版本、日期及結構化日誌，不啟動 CLI；資料未知、可能過期皆會標示。不匯出對話逐字稿、憑證設定、環境變數全集或模型目錄。

共用遮蔽模組會移除憑證格式、敏感欄位、授權標頭、Cookie 與個人識別資訊。聊天內容、主題／使用者識別碼及任意日誌文字不會匯出；保留已知錯誤代碼、崩潰訊息與遮蔽後的堆疊位置，因此會損失部分細節。只有明確選用 `--keep-identifiers` 才保留郵件、IP／主機名稱、路徑中的使用者名稱；憑證與聊天識別碼仍會遮蔽。請親自檢查：自行填寫的描述若含未知格式的秘密，規則比對無法保證辨識。

兩個新檔的權限皆為 0600，不覆寫既有檔案或符號連結。JSON 審閱快照綁定確切標題、內文、完整 Markdown 與提交方式；修改後須重新核准。預填網址上限為編碼後 7,500 字元；超出時完整回報仍保存在本機，核准的預填內文會請你手動附檔，不會暗中刪除證據。請核對實際附上的檔案。

若你要求使用主機既有的 GitHub CLI 登入，可在收集時加 `--submit`，審閱該提交方式及文字，核准時也加 `--submit`。只有核准後才檢查登入，不會代為登入或儲存 token。超出連結容量的回報須改用連結方式手動附檔。提交逾時或結果不明時，先查 GitHub 再決定是否重試。
