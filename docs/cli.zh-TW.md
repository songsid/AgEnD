# CLI 參考 (CLI Reference)

## 聊天指令 (Telegram 選單 / Discord slash)

Telegram fleet 選單（General 主題與實例主題，`setMyCommands`）列出 19 個指令；Discord 全域註冊 25 個 slash 指令——同樣 19 個再加 `/start`、`/stop`、`/chat`、`/save`、`/load`、`cancel`。`/cancel` 與 `/save` 在 Telegram 用打字的可以執行，但刻意不放進選單。🔒 需 fleet 管理員；各選單的鎖頭由 `src/command-table.ts` 生成，不是手打的。各平台權限細節見 [commands.md](commands.md)。

| 指令 | 描述 | 選項 / 參數 | 權限 |
|---------|-------------|----------------|------------|
| `/status` | Fleet 表格：Backend、Model、Context、推理強度、花費、執行狀態 | — | 🔒 管理員 |
| `/sysinfo` | 詳細系統診斷（版本、負載、IPC 狀態、各 backend CLI 版本）；Telegram 另可用 `/sys-info`、`/sys_info` | — | 所有人 |
| `/dashboard` | 登入網頁儀表板與網頁聊天：登入連結和一次性登入碼（Telegram 上登入碼會 spoiler，Discord 只有你看得到）。儀表板在 `localhost` 時，也會說明怎麼從手機連進來。`/dashboard revoke`（Discord 上是 `action: revoke` 選項）讓所有瀏覽器登出 | `[revoke]` | 🔒 管理員 |
| `/ctx` | 顯示 Agent 的 Context 使用量 | — | 所有人 |
| `/compact` | 壓縮 Agent 的 Context | `[instructions]`——指定摘要重點，僅 Claude Code | fleet 主題所有人 |
| `/steer` | 插話到 Agent 正在進行的回合，不等閒置 | `<message>` 必填；`claude-code`／`codex`／`grok`／`muse`，以及以已驗證版本的 TUI 執行的 `kiro-cli`（[說明](commands.md#steer-btw-and-clear-backend-support)） | 所有人 |
| `/btw` | 不中斷目前任務的旁支問題 | `<message>` 必填；僅 `claude-code` | 所有人 |
| `/clear` | 完整重置對話（破壞性——會先問 Confirm/Cancel） | — | 🔒 管理員 |
| `/model` | 切換 backend 模型 | 直接打名稱或用選單選 | 🔒 管理員 |
| `/effort` | 調整 AI 推理強度 | `low\|medium\|high\|xhigh\|max`，不帶參數則彈選單 | 🔒 管理員 |
| `/pause` | 手動暫停閒置的實例 | `[instance]`——在 General 需指名 | 🔒 管理員 |
| `/wake` | 喚醒暫停的實例 | `[instance]`——在 General 需指名 | 🔒 管理員 |
| `/restart` | 在進程內重啟所有實例（不結束進程） | `[full]`／`mode: full` 會重載整個 Fleet 進程與 adapter | 🔒 管理員 |
| `/collab` | 開關 bot/webhook 訊息接收 | — | fleet 主題所有人（ClassicBot 對話裡不是指令） |
| `/update` | 依已安裝的頻道更新到最新版 | — | 🔒 管理員 |
| `/doctor` | 執行 fleet 健康診斷 | — | 🔒 管理員 |
| `/login` | （beta）遠端 CLI 登入，缺 CLI 時先幫你裝好 | `[backend] [cancel]`；隨時可用 `/login cancel` | 🔒 管理員 |
| `/usage` | 顯示 AI 訂閱用量 | — | 所有人 |
| `/tips` | 在你執行處抽一則使用小提示 | `[mode]`——`on\|off` 開關每日自動推送，`advanced on` 解鎖進階層（皆需管理員） | 抽提示所有人 |

所有其他操作（建立/刪除/啟動實例、委派任務）均由 General 實例透過自然語言處理。

## 服務管理 (Service Management)

```bash
agend start                     # 啟動 AgEnD 服務（需先安裝）
agend stop                      # 停止 AgEnD 服務
agend restart                   # 重啟 AgEnD 服務
agend update                    # 依已安裝的頻道更新（alpha 留在 alpha、beta 留在 beta）並重啟服務
agend update --alpha            # 從 alpha 頻道安裝（下一個次版本的預覽）
agend update --beta             # 從 beta 頻道安裝
agend update --stable           # 從穩定頻道安裝，即使目前是 beta（可能回到較舊的版本）
agend update --version 2.1.9    # 安裝指定版本
agend update --force            # 即使已是最新也強制重裝並重啟
agend reload                    # 熱讀取配置（重新讀取 fleet.yaml，啟動新實例）
```

`agend reload` 會重讀 `fleet.yaml` 並協調實例：新增的啟動、刪除的停掉、改過的套用——fleet 進程本身不重啟。

### 誰停了 fleet

`agend stop`、`agend restart`、`agend update`、`agend fleet stop`、`agend fleet restart`（不指定實例時）會影響所有實例，所以每一個在動作**之前**都會在 AgEnD home 的 `restart-audit.log` 寫一行：時間、指令、父行程鏈與各自的指令列、工作目錄、stdin 是否為終端機，以及在 fleet agent session 內執行時的 `AGEND_INSTANCE_NAME`。指定實例的 `fleet stop <name>` / `fleet restart <name>` 也會記錄。fleet 收到隨後的訊號時，會在自己的 log 裡寫出這筆請求，所以即使 `fleet.log` 被重啟覆蓋，也查得到意外重啟的來源。

從 fleet agent 的 session 內執行時（`AGEND_INSTANCE_NAME` 有值，且會被 agent 執行的所有東西繼承——包括被引號包住的參數裡的 `$(...)` 或反引號），這些指令會被拒絕，除非加上 `--yes`；拒絕本身也會記錄。從測試執行器（`VITEST` / `NODE_ENV=test`）執行則一律拒絕；真的要對測試用 fleet 執行的測試可設 `AGEND_ALLOW_TEST_FLEET_CONTROL=1`。fleet 管理員送出的 `/update`、`/restart` 會連同發送者一起記錄。

## Fleet 管理 (Fleet Management)

```bash
agend fleet start               # 啟動所有實例（手動模式）
agend fleet start <name>        # 啟動指定實例
agend fleet stop                # 停止所有實例
agend fleet stop <name>         # 停止指定實例
agend fleet restart             # 優雅重啟（等閒置，用相同代碼）
agend fleet restart <name>      # 重啟指定實例（立即，不等閒置）
agend fleet restart --reload    # 完整重啟進程以載入新代碼（不能與實例名併用）
agend fleet status              # 顯示實例狀態概覽
agend fleet status --json       # JSON 輸出
agend fleet logs                # 別名——會提示改用 agend logs
agend fleet history             # 顯示事件歷史（成本、輪轉、懸掛）
agend fleet history --instance <name> --type <type> --since <date> --limit <n> --json
agend fleet activity            # 顯示活動日誌（協作、工具呼叫、訊息）
agend fleet activity --since 2h --limit 200 --format text
agend fleet activity --format mermaid  # 以 Mermaid 序列圖輸出活動
agend fleet cleanup             # 移除孤兒實例目錄
agend fleet cleanup --dry-run   # 只預覽，不刪除
```

## 實例工具 (Instance Tools)

```bash
agend ls                        # 列出實例（狀態、backend、team、context、活動）
agend ls --json                 # JSON 輸出
agend ls --names-only           # 每行一個名稱（shell 補全用）
agend attach [name]             # 接入實例的 tmux 視窗（模糊比對、互動選單）
agend logs                      # 顯示 fleet 日誌
agend logs -n 100               # 顯示最後 100 行（預設 50）
agend logs -f                   # 追蹤模式（tail -f）
agend logs --instance <name>    # 只看指定實例
agend export-chat               # 把 fleet 活動匯出成 HTML 聊天記錄
agend export-chat --from <date> --to <date> -o <path>
```

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
agend doctor                    # 執行 fleet 健康診斷
agend doctor mcp                # 全 fleet MCP 健康檢查（IPC、配置路徑、重複、binary PATH）
agend health                    # Fleet 健康檢查——列出問題與診斷
agend validate                  # 驗證 fleet.yaml 與 classicBot.yaml
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

`--tunnel` 每次都要你親口確認，沒有旗標或設定可以預先答應；沒有終端的執行直接拒絕，不當作你同意了。手機設定走 Cloudflare 通道，你打進去的 bot token 會經過 Cloudflare 的邊緣——不能接受就回機器上設。

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
agend schedule trigger <id>     # 只印出作法：CLI 自己無法觸發排程——fleet manager 跑著時請用 Telegram 介面觸發
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

（注意：沒有 `access add`——配對走 `access pair`。）

## 設定與安裝 (Setup & Installation)

```bash
agend quickstart                # 簡化設定（新使用者建議）
agend init                      # 完整互動式設定精靈
agend install                   # 安裝、啟用並啟動系統服務 (launchd/systemd)
agend install --no-activate     # 只寫入/更新 service 檔案
agend uninstall                 # 移除系統服務
agend export [path]             # 匯出配置以用於遷移
agend export --full [path]      # 匯出配置＋所有實例資料
agend import <file>             # 從匯出檔案匯入配置
```

在 Linux 上，systemd unit 使用 `KillMode=mixed`：停止或更新服務時會先停 fleet，再由 fleet 依序結束各個 CLI（#908）。`agend restart`（`agend update` 也會執行它）會替舊的 unit 補上這一行並重新載入 systemd；如果做不到，會拒絕重啟並說明怎麼手動處理。你自己設定的 `KillMode` 不會被更動。

**Fleet 停機期限（#1071）。** Detached `agend restart` 與 AgEnD 的 systemd unit 都會給停機五分鐘。Busy Kiro 的 drain、quit 與 signal grace 各有階段期限，但逐批停止會累加等待；舊的 detached 10 秒與 unit 60 秒上限可能截斷它們。Restart 會將 AgEnD 原本的 `TimeoutStopSec=60` 預設遷移成 `300`，並在停止前核對 systemd 已載入的期限。明確自訂值、重複賦值與 drop-in 覆寫會保留並提示；自訂較短期限仍可能截斷停機。五分鐘是外部上限，不保證涵蓋任意 fleet 大小或緩慢／卡住的 transport。

Detached restart 使用非同步 polling 與 monotonic deadline。期限到了會重新核對 PID 的啟動 identity 與指令列，再送 SIGKILL，並最多等五秒確認真正退出。Ownership 讀不到或舊 owner 仍活著就拒絕啟動 replacement，避免重複 fleet。若已記錄的啟動 identity 不變，只有指令列變空，可以在 grace 內等待新的退出證據；空指令列不能授權 SIGKILL 或 replacement。launchd 原有的停機／activation 政策不變。

同一次遷移也會替舊的 unit 補上 #1113 的設定：`CoredumpFilter=0` 讓 crash dump 只有幾 KB（WSL 會把所有 crash 交給 WSL 的 crash collector，它不理會 `LimitCORE`；kiro-cli 和 fleet 本身都曾留下約 1GB 和 450MB 的 dump）；`LimitCORE=0` 適用於直接寫 core 檔的系統；`TimeoutStartSec=15min` 取代原本不設上限的啟動逾時；`StartLimitIntervalSec=30min` 搭配 `StartLimitBurst=4`，讓 fleet 在 30 分鐘內失敗 4 次後，systemd 就不再自動重啟。`agend restart` 會先執行 `systemctl reset-failed`，所以不受這個限制影響；直接用 `systemctl --user restart` 則會受限。部分 systemd 版本（包括 249）會忽略 unit 檔裡的 `CoredumpFilter=`，所以在 Linux 上 AgEnD 會自己把 `coredump_filter` 設為 0：fleet 行程在啟動時設，每個它啟動的 CLI 也會設（啟動指令會先在 pane 自己的 shell 裡設好，所以即使 tmux server 不是這個 fleet 起的也有效）。`AGEND_KEEP_COREDUMP_FILTER=1` 會關掉這兩處：行程改用繼承來的 mask（來自 systemd、tmux 或你的 shell），不一定是完整 dump。不論哪種情況 unit 檔都不會被修改；除非你選擇關閉，實際生效的 mask 都是 AgEnD 設的那個。你自己設定的值不會被更動。

**服務用哪個 Node 執行，以及 `agend restart` 何時會拒絕（#1450）。**
- 有 AgEnD 自帶的 Node（或驗證過的 `AGEND_NODE`）時，unit（`ExecStart=`）和 plist（`ProgramArguments`）會先寫那個 Node，接著是套件的 `dist/cli.js`，最後是 `fleet start`。自帶 Node 的路徑只會在 npm 更新 AgEnD 時改變，而 `agend update` 屆時會重寫服務。runtime 的目錄不會出現在任何服務的 PATH 上，各 coding CLI 照舊使用原本的 Node。
- 沒有自帶 Node 的平台（glibc Linux 與 macOS 11 以上的 x64/arm64 以外），服務改為啟動套件的 launcher（`<套件>/launcher/agend fleet start`），由它在每次啟動時從服務的 PATH 找 Node。所以用 nvm 或 Homebrew 升級 Node（會刪掉舊版目錄）也不會讓服務壞掉；Node 太舊時會在啟動時拒絕，原因寫進服務的 log。
- `agend restart` 在停止任何東西之前，會確認服務管理器**已載入**的定義正好是這樣：寫明選定的 Node、這次安裝的 entry、`fleet start`、沒有 `NODE_OPTIONS`/`NODE_PATH`，而且沒有待重新載入的變更。不符合就拒絕，什麼都不停止。
  - 舊格式的定義（把 Node 交給 `#!/usr/bin/env node` 和服務的 PATH 決定）會因此被拒絕；請執行 `agend install` 重寫。
  - `agend restart --force` 是給已自行檢查過服務的管理者用的；`agend update` 從不使用。
- **macOS：** `agend install` 會寫入 `~/Library/LaunchAgents/com.agend.fleet.plist` 並載入 `gui/<uid>`，也就是你登入工作階段的 domain，LaunchAgents 會在登入時載入。
  - 對 launchd 來說，載入 plist 就等於啟動 job。所以 `agend install --no-activate` 只會寫入並驗證新的 plist，並記錄一次「預定的啟用」；已載入的 job 照常執行。
  - 下一次 `agend restart` 會執行這次啟用，只做一次：一次 `bootout`、一次 `bootstrap`。接著 `launchctl print` 必須顯示新的 job 正在執行；若沒有，會重新 bootstrap 先前的 plist 並確認。
  - 只能用 SSH 連線、沒有人登入的 Mac 沒有 `gui/<uid>` domain（`launchctl` 回報錯誤 125）。在那裡 job 只能以 `LimitLoadToSessionType=Background` 載入 `user/<uid>`；`agend install` 不會這樣寫，這種 job 需要你自行管理。

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
agend settings reject <id>
```

在 host 上以 fleet 或 SetupHost 的相同使用者執行。它不會啟動 fleet；確認由私有本機 socket 負責。Agent session（存在 `AGEND_INSTANCE_NAME`）不能使用。套用前會再次核對 id、socket owner generation，以及檢查過的 effect／summary。過期或 stale 請求需重新提出；pending 不會跨重啟保存。
