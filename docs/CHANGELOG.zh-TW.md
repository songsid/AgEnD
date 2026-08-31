# 更新日誌 (Changelog)

本專案的所有顯著變更都將記錄在此檔案中。

格式基於 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [未發佈] (Unreleased)

_目前沒有未發佈的變更。_

## [2.1.4] - 2026-08-25

### 新增 (Added)
- **`/login` 指令** — 直接從 Telegram／Discord 重新登入 CLI 後端，不必再 SSH 進主機。執行前會先檢查現有登入，若仍有效會要求確認，避免誤把還能用的登入洗掉。登入成功後，原本在執行的 instance 會自動重啟以套用新憑證（#611、#613、#614、#617）。
- **`/install-cli` 指令** — 遠端在主機上安裝 CLI 後端，並整合進 quickstart。安裝指令改為各家目前的官方做法：kiro-cli 改用 `curl` 安裝腳本（原為 Homebrew）、codex 改用官方 standalone 安裝程式（原為 npm）（#619–#621、#624）。
- **`/clear` 指令** — 清空 instance 的 context。**限管理員，而且必須先按確認鈕**才會真的執行，單獨下指令不會觸發破壞性動作（#529、#549）。
- **`/steer` 指令 + 工具進度顯示** — `/steer <訊息>` 可以插話進正在跑的那一輪；工作中的泡泡也能列出正在執行的工具。**`tool_progress` 預設為 `off`（需自行開啟）**，避免升級後突然開始把工具活動廣播到聊天室；可設 `standard`（語意標籤）或 `verbose`（加上指令預覽），從 fleet.yaml 或網頁 Settings 下拉選單設定（#560、#563、#577、#616）。
- **`/btw` 指令** — 問一個插題但不打斷目前任務。**僅 Claude Code 支援**；其他後端會明確拒絕，而不是把訊息默默吞掉（#584–#586）。
- **`/tips` 每日提示** — 300 則提示庫（入門／中階／進階各 100 則），以聊天卡片形式偶爾出現，附「知道了／看不懂」按鈕。**預設只顯示入門提示**；標記已讀 60 則後才解鎖進階，或由管理員執行 `/tips advanced on` 立即開啟 —— 不會在未經同意下推進階內容。提示也會依實際使用的後端過濾（#587、#588、#590–#594、#599、#603、#605–#609、#622）。
- **`list_models` MCP 工具** — agent 可以直接查詢後端實際提供哪些模型，不必用猜的。回傳的 `scope` 會區分「該 instance 專屬」與「整個帳號」的清單 —— 這很重要，因為使用自訂 provider 的 instance 可用模型可能完全不同（#573）。
- **Codex 自訂 provider** — `backend_options.codex.provider` 可讓單一 instance 指向替代 provider，`create_instance` 也支援，並附上 General 專用的設定指南（#545、#552、#553）。
- **跨後端 skill 發布** — skill 會以各後端的原生格式發布到全部六個後端，支援依角色分發（General／Worker／Classic），MCP 載荷控制在 2 KB 以內（#554、#555、#557、#558）。
- **fleet.yaml 自動精簡** — 存檔時會移除與 fleet 預設值相同的 instance 欄位，並附一次性遷移。**這是「繼承」而不是「刪除」**：被移除的欄位之後會跟著 `defaults` 走，所以日後改預設值也會一併改到這些 instance。身分與路由欄位（`working_directory`、`topic_id`、`channel_id` 等）一律保持明寫（#569）。
- **完整繁體中文介面** — 325 個語系鍵與型別化的 locale 模組，使用者看得到的文字不再有寫死的英文（#595）。
- **`agend install` 會自動啟用服務** — 安裝後不必再手動下 `systemctl`。`agend uninstall` 移除任何東西前會先要求確認，`agend doctor` 則新增系統診斷（#570、#580）。
- **`agend completion install`** — bash 與 zsh 的 tab 補完（#537）。
- **互動式提示處理** — CLI 停在 sudo／確認提示時，AgEnD 會貼出「確認／取消」按鈕，也可以請 General 協助；按鈕有 nonce 保護並限管理員（#530、#535）。
- **CLI 結束與更新的可見度** — CLI 正常退出時會提供「重啟／忽略」而不是無聲消失；`/update` 則顯示即時進度與已耗時（#533、#534）。
- **OpenCode session 續接** — 改用 CLI JSON 探索加上閒置檢查點，真正能續接；原本的 `--continue` 會劫持全域 session，導致 MCP 與 instructions 遺失（#525、#526、#543、#544）。
- **Antigravity MCP 接線 + 常駐 workspace**（#618）。
- **用量面板只顯示用得到的** — `/usage` 與網頁介面會隱藏這個 fleet 沒有登入的後端（#579）。
- **CI 納入 build 與測試** — 另加 push 時的 gitleaks 掃描與明確的 permissions 區塊（#524）。

### 修正 (Fixed)
- **登入過期會被如實回報** — 過期的 session 會被判定為認證問題，不再誤報成「MCP 已停止」；也不會在只有重新登入才有用的情況下，每次掃描都跳一次「instance 卡住」通知。同時阻止 Codex 啟動時的「Update available!」提示，避免 fleet 重啟後每台 Codex 都停在那裡等按鍵（#602、#614、#615）。
- **Codex SQLite 附屬檔** — WAL／SHM／journal 不再被單獨 symlink 到與資料庫不同的位置（那會把同一個 SQLite 資料庫拆散在兩個 home），啟動時也會自動修復舊的連結（#564）。
- **Pane 狀態判讀準確度** — Kiro 不再把捲軸歷史裡的殘留 spinner 當成「工作中」；Antigravity 的頁尾重繪不再讓狀態一天翻動約 5.2 萬次；Claude Code 的取消鈕與泡泡不再在中途消失；Codex 的 `›` 閒置提示字元現在能被辨識（#551、#572、#576、#601、#610）。
- **取消鈕** — 重啟後的第一則訊息能正確退場；取消時也會清掉待投遞佇列，不會讓已排隊的工作稍後才冒出來（#575、#584）。
- **工具歷程會保留** — 一輪結束時，泡泡會保留工具清單成為唯讀紀錄，只移除按鈕；保留下來的訊息會標示為歷程，而不是繼續顯示「處理中」（#565、#566）。
- **ClassicBot 修正** — adapter 遷移會偵測 ID 網域並自我修復；`set_display_name`／`set_description` 寫入正確的儲存位置；`update_instance_config` 會指向 Classic instance 該用的工具（#550、#568、#598）。
- **媒體投遞** — Discord 回覆引用與轉發訊息中的圖片能正常送達；一般網址自動嵌入不再觸發下載；Telegram 貼圖會正規化；📷 表情不再被當成 context 注入（#532、#536、#588、#589）。
- **Claude Code session 續接** — 含點號或底線的專案路徑能正確編碼；執行期用 `/model` 切換的模型在重啟後仍保留（#538、#539）。
- **排程使用正確身分** — 多 bot 設定下，排程訊息會以正確的 Discord bot 身分發送（#582）。
- **背景 session 恢復後健康檢查會繼續**（#541）。
- **Agent instructions 修正** — 新增 `react` 與 `edit_message` 的呼叫方式說明、區分 CLI subagent 與 `create_instance`、避免使用 AgEnD 的投遞狀態表情。**instructions 類改動需要 fleet 重啟後才生效**，不會立即套用（#559、#562、#626）。
- **文件** — Telegram 與 Discord bot 設定指南（中英文）、2026-08-13 稽核找到的指令／設定缺口、修正過時的 tool_set 數量、螢幕截圖去識別化、Gemini 停用標示（#523、#546、#547、#571、#574）。

## [2.1.3] - 2026-08-07

### 新增 (Added)
- **tmux 3.7b 相容性** — 移除 control client 的 `-r`（唯讀）flag，與 tmux 3.7 新的唯讀強制機制衝突。新增自適應的貼上延遲以因應時序差異（#519、#521）。
- **View UI 大改版** — 每個 instance 顯示 CLI backend 圖示；instance 工具提示支援 i18n；`/usage` 重排為 Claude→Codex→Grok→Kiro→Antigravity（#511–513、#514）。
- **MCP dead proxy reply** — MCP server 無法連線時，daemon 可以把 agent pane 輸出作為回應轉發。**僅 opt-in**（`mcp_proxy_reply: true`），預設 `false`，因為原始 pane 輸出可能含有機密。跨 instance 的 inbound 不會觸發此機制（#515–516）。
- **tmux 滑鼠捲動** — `agend attach` 啟用 mouse mode，往上捲可瀏覽歷史（#508）。
- **Discord 轉發圖片** — 轉發訊息與嵌入中的圖片現在能正常遞送。修正 `discord.js` messageSnapshots API（無 `.message` wrapper）（#505、#518）。

### 修正 (Fixed)
- **Kiro Enter 重試** — 防禦性 Enter 現在每次遞送都會重送，而非只在第一次（#504）。
- **claude-code classic 崩潰** — 修正 tmux window name 與既有 window 衝突時的崩潰（#503）。
- **Codex session symlink** — 遷移舊 session 路徑；CLI 與 daemon 共用的 symlink 現在放在同一處（#507）。
- **ctx% > 100%** — parser 現在讀取真實 title bar 而非比對聊天內容（#509）。
- **Bot @mention 保留** — `@BotName` 保持為 `@BotName (you)` 顯示在 context 中（#510）。
- **TG 指令選單** — 修正指令註冊（#517）。

## [2.1.2] - 2026-08-06

### 新增 (Added)
- **`/usage` 指令** — 直接從聊天室查看 AI 訂閱用量。以各平台原生的豐富格式（進度條）顯示 Claude、Codex、Kiro、Antigravity 與 Grok 配額。權限與 `/ctx` 相同（不限管理員）。
- **`get_usage` MCP 工具** — agent 可查詢自己的訂閱用量。CLI 模式下也可用 `agend-agent usage`。
- **`/view` 的 AI 用量面板** — 📊 按鈕顯示所有已設定 backend 的用量面板。以 `web.usage_panel: false` 停用。
- **`/effort` 指令** — 執行期調整 AI 推理 effort（low/medium/high/xhigh/max）。TG 用行內鍵盤、DC 用下拉選單。限管理員。六種 backend 全部支援。Codex effort 等級因模型而異。
- **`get_effort` MCP 工具** — 查詢目前 effort 與策略。`/status` 顯示 effort 欄位。
- **Reactions 作為 context** — DC/TG reactions 存入資料庫，下一輪 context 會包含，不會轉發成訊息。雙向（使用者→agent、bot→使用者）。~~`defaults.reactions_enabled` 控制此功能。~~ **[勘誤 2026-08-13]** 此開關從未實作——`reactions_enabled` 在原始碼中零參照；此功能無條件啟用。將原始敘述視為文件錯誤，而非已移除功能。
- **即時進度行** — agent 工作時，遞送狀態訊息顯示正在執行的工具名稱與已耗時間。可設定：`defaults.progress_min_elapsed`（秒，預設 30）。直接從 pane 讀取 Kiro 的 running tool。
- **Tab 補全** — `agend attach <tab>` 補全 instance 名稱（bash 與 zsh）。
- **Fleet 記憶體報告** — `agend ls` footer 顯示 fleet 總記憶體。
- **MCP 閒置時自動重啟** — MCP server 死掉時，AgEnD 等 instance 閒置後自動重啟（crash-loop guard + restart mutex）。
- **Singleton fleet 啟動** — `fleet.lock` 防止重複的 fleet 進程啟動。
- **Fleet event loop 不阻塞** — 子進程（sdNotify 等）不再阻塞主 event loop。Watchdog ping 改為非同步。
- **General 中的重啟進度** — fleet 啟動的即時進度：版本、instance 數量、暫停清單。
- **啟動時跳過暫停佇列** — 暫停的 instance 不進入啟動佇列（大型 fleet 快約 50 秒）。
- **互動式提示偵測** — 偵測卡住的 sudo/Y-N 提示並通知 General。

### 修正 (Fixed)
- **至少一次訊息遞送** — 跨 instance 與排程訊息最多重試 3 次；最終失敗會讓 agent 看到。
- **取消鈕生命週期** — 4 道安全網（daemon 死亡、重啟、silent reporter、24 小時上限）。修正：spinner、double-observe、post-before-delete 順序、restart mutex、grace retirement。
- **Reply 去重** — 60 秒窗口防止因 rate-limit timeout 造成的重複回覆。
- **General coordinators 永遠保持 warm** — General 與多頻道 generals 不能被 auto-pause。
- **遞送路由** — reply 使用已設定的 adapter；classic instance 經由其綁定的 adapter 路由。
- **pane 寫入序列化** — 所有對 tmux pane 的寫入都序列化，防止交錯。
- **SQLite 強化** — busy timeout、corrupt-tolerant event log、bounded query history。
- **Fleet health 誠實** — `/health` 在任何 instance 降級時回傳 503。`READY=1` 只在所有 general 都 up 後才送出。
- **錯誤隔離** — 單一 instance 崩潰不再拖垮整個 fleet 進程。ClassicBot 錯誤路由到 General。
- **Kiro 登入失敗** — 不再誤報為 rate limit。
- **Dashboard token 持久化** — `/dashboard` URL 在 fleet 重啟後仍然有效。
- **agy busy pattern** — Antigravity 現在有真正的 busy pattern，而非永遠為 true。
- **Grok/Claude/Codex pattern 修正** — 邊界情況的閒置偵測、模型錯誤偵測、年度金鑰讀取。
- **Dead window 清理** — 過時的 tmux window 註冊會自動退場。
- **啟動對話守衛** — 使用者訊息不會被貼進啟動對話。
- **Secret 檔案權限警告** — 憑證檔案無法設為 owner-only 時會警告。

### 變更 (Changed)
- **跨 instance 遞送** — 改為 fire-and-queue（非阻塞），降低呼叫方等待時間。
- **`defaults.effort`** — 新的預設 effort 等級設定欄位。
- **`defaults.progress_min_elapsed`** — 即時進度出現前的秒數（預設 30）。
- **`web.usage_panel`** — 在 `/view` 顯示/隱藏用量面板（預設 `true`）。

## [2.1.1] - 2026-07-29

### 新增 (Added)
- **`/view` 的 AI 用量面板** — 📊 按鈕開啟面板，顯示此機器上已登入 CLI backend 的即時訂閱用量（Claude session/weekly %、Codex windows/credits、Grok weekly pool、Kiro monthly + bonus/gift credits 與 Amazon Q subscription）。新 `GET /api/ai-usage` 端點（5 分鐘快取）；以 `web.usage_panel: false` 停用。Claude/Codex/Grok provider 邏輯取自 ai-usage-board/OpenUsage（MIT，見 `src/usage/LICENSE.md`）；Kiro provider 為原創研究。
- **Kiro TUI effort skill** — TUI 模式下 effort 選擇器的 General-knowledge skill。

### 修正 (Fixed)
- **SIGHUP 啟動窗口** — SIGHUP reload 期間的啟動請求受到保護。
- **Reload reconcile 安全閘** — 偵測到 N→0、空設定或 >50% instance 減少時中止 reconcile。
- **Root 使用者 Codex PATH** — root 執行時 Codex 的 PATH fallback。

## [2.1.0] - 2026-07-27

### 新增 (Added)
- **`/model` 指令** — 從聊天室更換 backend 模型。限管理員。TG 用行內鍵盤選單、DC 用下拉選單。顯示目前模型，即時回饋。
- **啟動時 CLI-env 探測** — 啟動時自動探索可用模型並按 backend 快取。
- **Auto-Pause/Wake** — 閒置 instance 在 `auto_pause_after` 分鐘後暫停（opt-in，預設停用）。收到訊息自動喚醒暫停的 instance。`general` instance 永不暫停。
- **三態執行狀態** — `agend ls`、MCP `list_instances`、`/api/fleet` 顯示 Idle/Working/Stuck。
- **Adapter 啟動隔離** — adapter 平行啟動，獨立重試；單一 adapter 失敗不再阻擋其他。
- **事件驅動 pane 監控** — 使用 tmux control mode `%output` 事件取代 5 秒輪詢；閒置時 CPU 近乎零。
- **自適應啟動併發** — 啟動時讀取 `os.freemem()` 以在低 RAM 機器上限制平行 instance 數量。
- **Warm cap（LRU 驅逐）** — `warm_cap` 設定限制常駐（warm）instance 數量；超出的閒置 instance 自動暫停。
- **Grok Build backend** — 完整支援 Google Grok CLI：crash recovery、context %、quit 鍵（Ctrl+Q）、Web UI、MCP（ASCII-sanitized key）。
- **`/model` MCP 工具** — `update_instance_config`、`update_fleet_defaults` 用於執行期設定更新。
- **Pause/wake MCP 工具** — `pause_instance`、`wake_instance`、`stop_instance`、`get_fleet_status`、`get_instance_logs`、`get_fleet_config`。
- **跨 instance 閒置閘門** — outbound 訊息等目標 instance 閒置後才遞送。
- **一次性排程** — `create_schedule({ at: "ISO-datetime", ... })` 觸發一次後自動刪除。
- **靜默排程** — `create_schedule({ silent: true, ... })` 直接貼到 pane，不發送到聊天室。
- **ClassicBot backend 選擇器** — `/start` 顯示 backend 選單與安裝狀態。
- **Settings 頁面** — fleet.yaml/classicBot.yaml 的結構化 UI，表單↔YAML 雙欄同步。
- **設定驗證器** — `agend validate` CLI + `validate_config` MCP 工具。
- **共用 logger** — 單一 root pino transport + child loggers（省下數百 MB + 執行緒）。
- **暫停時凍結監控** — 暫停的 instance 停止所有 timer/watcher（overhead 近乎零）。
- **Kiro 每 instance UI 模式** — `fleet.yaml` 的 `kiro_ui: legacy | tui | v3`。

### 修正 (Fixed)
- `auto_pause_after` 預設為 0（opt-in，使用者須主動啟用）。
- classic instance 顯示名稱移除 `[C]` 前綴。
- 跨 instance `[from:]` 標頭顯示發送者的 `display_name`。
- Classic instance 出現在 `agend ls`、`/status`、Web View roster。
- Grok：ASCII-sanitize MCP server key（CJK key → 0 tools）。
- 重啟時的 adapter 綁定競爭。
- Kiro lambda prompt 現在被辨識為 ready pattern。
- Stuck 通知只在有待處理 inbound 時才發送。
- `fleet.log` 包含日期戳記。
- Unicode instance 名稱（中文 ClassicBot channel）。
- CLI reply 在重啟後使用持久化的 context。
- agy：遇到未知 model key 時自動 fresh-restart。
- CLI pane 死亡時使閒置狀態失效。

### 變更 (Changed)
- **Grok Build** — 移除實驗標記；現為穩定版。
- **共用 logger** — 取代每 instance 的 worker thread。

## [2.0.11] - 2026-07-08

### 新增 (Added)
- **`/dashboard` 指令** — 限管理員，回傳 View/Settings/WebUI URL。DC：ephemeral reply。TG：spoiler-wrapped token。
- **Settings 網頁（`/settings`）** — 結構化設定編輯器，表單↔YAML 雙欄同步，寫入前驗證。
- **設定驗證器** — `agend validate` CLI + `validate_config` MCP 工具。驗證 channels、instances、backends、access。
- **Web View 增強** — sidebar 拖曳排序（SQLite）、按 tag 群組、`agend view` CLI、開放 GET 存取（無需 token）。
- **Same-channel multi-bot ClassicBot** — composite key routing、owner-wins dedup、自動遷移、restart rebind。
- **Quickstart persona bot** — 「Add persona bot (Discord)」選項，7 步驟流程。
- **Multi-bot token adapter** — 每 channel 可用不同 Discord bot 身分。

### 修正 (Fixed)
- **DC general invalid topic_id** — skip + warn + unbind 而非 crash loop。
- **Channel missing access field** — 預設 open 而非崩潰。
- **Avatar DB path** — 存檔名（非絕對路徑）；avatar 遺失時顯示 placeholder。
- **`/view` ctx%** — 為 0 或 null 時隱藏。
- **Auto-General** — 只有主要 adapter 建立/認領 general。
- **React per-adapter** — `reactMessageStatus` 使用 instance 綁定的 adapter。
- **Warmup false trigger** — 首次執行時跳過、閒置時延後、加上「不要回覆」。

## [2.0.10] - 2026-07-03

### 新增 (Added)
- **Quickstart 自動安裝系統服務** — quickstart 結束時詢問，一步完成設定。

### 修正 (Fixed)
- **Double fleet 競爭條件** — 重啟時若 systemd service 存在，不再 fallback 到 detached spawn。
- **WSL Windows PATH 過濾** — systemd service `Environment=` 過濾 Windows PATH 項目。
- **`IS_SANDBOX=1` for root** — systemd service 加入環境變數以相容 claude-code v2.1+。

### 變更 (Changed)
- **移除 CI GitHub Release 步驟** — leader 手動撰寫 release notes。

## [2.0.9] - 2026-07-02

### 修正 (Fixed)
- **Kiro CLI v3 的 `/ctx` regex** — 符合新 λ prompt 格式（`26% λ !>`）。

## [2.0.8] - 2026-07-02

### 新增 (Added)
- **取消鈕** — 每則 inbound 訊息都有行內 🛑 按鈕。Track-all 設計（per-button Map）、跨 instance cancel via `correlation_id`、5 分鐘閒置 backstop。
- **遞送狀態 UX** — 👀 已收 → ⏳ 處理中 → ✅ 完成（或 ❌ 失敗）。Boolean 遞送結果與 backoff。
- **Discord 內建** — Discord adapter 合併入核心；不需另裝 plugin。
- **Fleet topic 的 `/save`** — kiro-cli 用 `/chat save`、claude-code 用 `/export`。
- **`/cancel` 指令** — 行內按鈕的斜線指令替代方案（TG + DC）。
- **Model pass-through** — 未知 model 名稱傳給 CLI 並顯示警告，而非靜默丟棄。
- **Log rotation** — `fleet.log` + inbox 以 copytruncate 每日輪轉。

### 修正 (Fixed)
- **`--continue` crash loop** — resume 失敗時中斷迴圈 + 停止單一 instance 而非整個 fleet。
- **DC forum thread-aware** — editMessage、deleteMessage、reactions 能在 forum-topic threads 中找到訊息。
- **Health-check null retry** — 宣告崩潰前再次確認 null pane 狀態。
- **TG bare slash ignore** — Classic group 中的裸 `/` 指令不再觸發錯誤。
- **DC adapter error isolation** — Discord 錯誤不再拖垮 fleet 進程。
- **Classic collab image path** — 觸發時 surface 儲存的 image path 為 `image_path`。
- **Cancel button async race** — bounded delete retry、以 correlation_id 退場。

### 變更 (Changed)
- **Fleet stop 效能** — 大量 instance 時停止更快。
- **`/ctx` scrollback** — kiro-cli 有 robust tmux fallback。

## [2.0.5] - 2026-06-24

### 新增 (Added)
- **`agend doctor mcp`** — fleet 級 MCP 健康檢查（IPC 連通性、config 路徑、duplicates、binary PATH）。
- **TG Classic `/ctx`** — classic 模式顯示 context 用量。
- **`/start` 通知 General** — 未授權的 DC guild 與 TG private chat 使用者會觸發 General 通知。
- **Decision 過濾** — instance 只看到 fleet-scope + 同專案的 decisions（不是所有 fleet decisions）。

### 修正 (Fixed)
- **TG Classic @mention 被 auto-collab 破壞** — `/start` 的 auto-collab 現在僅限 Discord；TG classic @mention 恢復正常。
- **TG private chat reply 'thread not found'** — 私人聊天不再錯誤地把 `thread_id` 當 `message_thread_id` 傳送。
- **`/compact` slash 遺失** — 透過 IPC `raw_paste` 統一；使用 `tmux send-keys -l`（literal mode）。
- **DC Fleet `/compact` 被阻擋** — 不再被 classic-only 檢查錯誤阻擋。
- **Hang detector 誤報率降低約 73%** — 只在有待處理 inbound 訊息時才標記。
- **claude-code background session 衝突** — 以 re-entry guard 自動恢復而非 crash loop（#79）。
- **Crash loop 錯誤訊息** — 現在與「rate-limited」區分。
- **Chat-log 時區** — 使用本地時區而非 UTC。
- **install.sh EEXIST** — 清理 suzuke→songsid 套件名稱升級的錯誤。
- **Export 包含 classicBot.yaml** — 先前 `agend export` 漏掉此檔案。
- **從 repo 移除 soul.md + CLAUDE.md** — 意外 commit 的檔案已移除。
- **MCP env decision 過濾** — 只傳遞過濾後的 decisions，而非所有 fleet decisions。

## [2.0.3] - 2026-06-21

### 新增 (Added)
- **統一 `/update`** — TG 與 DC 都 spawn `agend update`（detached）；自動偵測 beta 版本並使用 `--beta` flag。
- **DC Fleet 斜線指令** — `/status`、`/sysinfo`、`/restart`、`/ctx`、`/compact`、`/collab` 現在可用 Discord 斜線指令（與 TG 功能對等）。
- **TG Fleet `/ctx` `/compact` `/collab`** — 註冊到 forum bot 選單；在 General topic 與 instance topic 都能用。
- **TG Classic `/compact`** — 限管理員，用於 compact classic instance context。
- **TG Classic `/ctx`** — classic 模式顯示 context 用量。
- **Fleet `/collab`** — 允許 bot/webhook 訊息進入 fleet topic（TG + DC）。Fleet open mode 繞過 bot 訊息過濾。
- **DC auto-collab on `/start`** — Discord `/start` 自動對新 instance 啟用 collab mode。
- **Instance warmup** — spawn 後自動觸發 context loading（steering + skills）；等 instance 到達 idle 才標記 ready。
- **`agend ls` status indicators** — 即時顯示每個 instance 的 Idle/Busy/Crashed/Stopped。
- **Fleet ready 版本** — 「Fleet ready」啟動通知顯示 AgEnD 版本。
- **🔒 Admin 標記** — 斜線指令描述以 🔒 前綴標示限管理員指令。

### 修正 (Fixed)
- **Health port retry 迴圈** — 以 re-entry guard flag 防止無限健康檢查重試（#44）。
- **`/update` beta 自動偵測** — 目前版本為 beta 時正確 spawn `agend update --beta`。
- **DC `/collab` fleet topic 權限** — fleet topic `/collab` 現在正確需要 `allowed_users` 權限。
- **DC 斜線指令重複** — `compact` 之前註冊兩次導致所有指令靜默失敗；已去重。
- **`/status` 效能** — 移除序列 tmux capture fallback（48+ instance 時太慢）；改用 statusline.json。
- **General topic `/ctx`** — TG General topic（threadId=undefined）現在正確路由到 handleInstanceCommand。

## [2.0.2] - 2026-06-17

### 新增 (Added)
- **TG Rich Message 接收** — grammy middleware 攔截 Rich Message（Bot API 10.1），擷取文字供 bot-to-bot @mention 通訊。
- **多頻道自動偵測** — 每個 adapter 取得自己的 General instance；unbound generals 以 topic_id 比對認領。
- **`channel_id` 欄位** — 明確綁定 General instance 到特定 adapter。
- **Quickstart live add platform** — fleet 執行中可新增第二個平台（偏好 systemd restart，fallback detached spawn）。
- **`agend stop/start` fallback** — 在無 D-Bus/systemd 的機器上可用（PID kill / direct fleet start）。
- **`/sysinfo` 版本顯示** — 系統資訊表格顯示 AgEnD 版本。
- **`/status` context 百分比** — tmux capture fallback 符合 `agend ls` 行為。
- **Multi-channel skill** — 雙平台設定指南的 General knowledge。
- **Memory 最佳實踐** — steering 規則：Decision（簡短）→ soul.md（完整）→ skill（按需）。
- **Configuration & commands 文件** — fleet.yaml/classicBot.yaml 完整參照 + 所有斜線指令。
- **Reply tool instruction** — 所有 instance 知道 reply tool 後輸出「.」以避免 kiro-cli 錯誤。

### 修正 (Fixed)
- **TG ClassicBot chat-log** — 非 @mention 訊息現在正確記錄（先前因 text clearing 導致空白）。
- **TG ClassicBot bot reply logging** — agent outbound reply 寫入 chat-log。
- **TG ClassicBot error notifications** — classic instance 透過 routing table fallback 收到錯誤通知。
- **Bot-to-bot @mention (TG)** — isBotMessage filter 允許帶 @ourBot mention 的 bot 訊息；Rich Message text 擷取。
- **add platform 時 general 重複** — 認領 unbound generals 而非建立重複。
- **`/restart` admin check** — mode:open 不再允許未授權使用者重啟 fleet。
- **Discord `general_channel_id` required** — quickstart 迴圈直到提供（防止 routing 損壞）。
- **未關閉的 code fence** — CLI paste 前移除，防止 input hang。
- **TG `/chat` 從選單移除** — TG classic 未實作，改用 @mention。

### 變更 (Changed)
- **grammy 1.44.0** — 升級以支援 Bot API 10.1。
- **`assignTopicIds`** — 使用 `channel_id` → channels config type 偵測平台（不再用 name heuristic）。

## [2.0.1] - 2026-06-15

### 新增 (Added)
- **Telegram Rich Messages** — grammy 1.44.0，自動偵測 markdown 表格/code block/標題 → sendRichMessage with fallback。
- **`/update` + `/doctor` 指令** — TG 與 Discord 皆可用（限管理員）。/doctor 執行 backend 診斷。
- **systemd watchdog** — Type=notify、WatchdogSec=60、透過 systemd-notify 指令進行 sd_notify。
- **非阻塞啟動** — generals 先啟動 → READY=1 → 剩餘 instance 在背景啟動。
- **每日更新檢查** — fleet daemon 每 24 小時檢查 npm 新版本，通知 General。
- **Admin reject 通知** — 非 admin 的 /start 或 /stop 觸發 General 通知，含使用者資訊。
- **Workspace 路徑守衛** — create_instance 拒絕危險路徑（`.`、`~`、`/`）。
- **npm link 自動偵測** — `agend update` 偵測並移除過時的 npm link。
- **install.sh link 移除** — readlink fallback 偵測 npm-linked 舊版本。
- **斜線指令前綴** — TG+DC 指令描述中的 [Fleet] / [ClassicBot]。
- **kiro-cli 錯誤偵測** — 「having trouble responding」觸發 rate_limit 通知。
- **`/status` + `/sysinfo` rich tables** — TG Rich Message 的 markdown table 輸出。

### 修正 (Fixed)
- **systemd startup kill** — NotifyAccess=all + TimeoutStartSec=0 支援 50+ instance fleets。
- **Classic group unbound message** — classic group 不再顯示「not bound to an instance」。
- **`agend update` 訊息** — 顯示 `agend start` 而非 `agend fleet start`。
- **Collab empty log** — 跳過 collab chat log 中的空 bot 訊息。
- **`/doctor` 指令路徑** — 使用 `agend backend doctor` 配合 fleet 預設 backend。

### 變更 (Changed)
- **版本跳號** — 從 v0.0.23 跳到 v2.0.0。新版本從 v2.x 開始。
- **PR 流程** — 所有變更經 feature branch → PR → merge。main 分支保護。
- **CI 自動 GitHub Release** — stable tag 自動建立 GitHub Release 並產生 notes。

## [2.0.0] - 2026-06-15

內容與 v0.0.23 相同。版本跳號以建立新的主版本基準。

## [0.0.23] - 2026-06-12

### 新增 (Added)
- **權限矩陣** — `docs/permissions.md` 記錄所有指令 × 平台 × 存取等級。

### 修正 (Fixed)
- **TG classic `botUsername` 在主要 adapter 從未設定** — `isBotMentioned` 永遠為 false。現在在 `started` 事件處理中正確設定 `world.botUsername`，並在 `adapter.start()` 前註冊 listener。
- **TG `/start@other_bot` 觸發所有 bot** — 帶 `@suffix` 指向其他 bot 的指令現在被完全忽略。
- **TG `/start` `/stop` `/raw` admin 鎖定** — group-mode `/start` 與 `/stop` 現在需要 `admin_users`。`@bot /raw` 也需要 admin。
- **`allowed_guilds: {}`（非陣列）破壞存取** — 非陣列值現在視為「允許全部」而非拒絕所有。

## [0.0.22] - 2026-06-12

### 修正 (Fixed)
- **Classic instance 主動回覆** — daemon 不再在無先前 inbound 訊息時阻擋 `reply` tool。Fleet-manager 的 classicBot channelId fallback 現在正確路由 outbound 訊息。

## [0.0.21] - 2026-06-12

### 新增 (Added)
- **Fleet instructions 中的 mention 規則** — 所有 instance 現在知道如何 `<@USER_ID>` mention Discord 使用者/bot 與 `@username` for Telegram。從 inbound 訊息的 `id:` 欄位擷取。

## [0.0.20] - 2026-06-12

### 新增 (Added)
- **inbound 訊息中的使用者 ID** — 格式現在包含 `id:USER_ID` 以支援 mention。agent 可以 `<@ID>` mention Discord 使用者或使用 Telegram mention 語法。

### 修正 (Fixed)
- **Classic instance reply fallback** — classic channel agent 現在在 fleet restart 後也能回覆。`topic_id` 不可用時 fallback 到 `classicBot.yaml` 的 channelId。

## [0.0.19] - 2026-06-11

### 修正 (Fixed)
- **agy model discovery skill** — 澄清 effort 後綴（Medium/High/Low/Thinking）不是 model 名稱的一部分。

## [0.0.18] - 2026-06-11

### 新增 (Added)
- **Model 相容性檢查** — `defaults.model` 只套用到能辨識該 model name pattern 的 backend。不相容的 model 靜默跳過（例如 `claude-opus-4.6` 不會傳給 Codex）。

## [0.0.17] - 2026-06-11

### 新增 (Added)
- **Antigravity CLI backend** — 完整支援 Google `agy` CLI。預設使用 CLI 模式（無 MCP）。非隱藏 workspace `~/agend-workspaces/`、instructions 在 `.agents/agents.md`、trust 提示自動 dismiss。
- **IPC + adapter 自動重連** — IPC 斷線後指數退避重試，之後每 60 秒無限重試。Adapter 致命錯誤（Telegram polling 初始化、Discord gateway）同策略自動重啟。死亡 tmux pane 自動 respawn。
- **Beta 更新頻道** — `agend update --beta` 從 `@beta` npm dist-tag 安裝。CI 偵測 tag 含 `-beta` 時以 `--tag beta` 發布。
- **PSS 記憶體報告** — `agend ls` 使用 PSS 取代 RSS，避免共用頁面重複計算。
- **平行 instance 停止** — 併發數 5 加速關閉，systemd timeout 相應延長。
- **可配置 context_lines** — classicBot.yaml 個別 channel 聊天記錄注入深度，設 0 停用。
- **classicBot.yaml model 支援** — 個別 channel model 覆蓋。
- **Access mode "open"** — 允許所有使用者，無需白名單。
- **Fleet 記憶體總計** — `agend ls` footer 顯示 instance 數量與總記憶體。
- **`agend update` 指令** — 完整生命週期：sudo/nvm 偵測、npm install、service 重啟、健康檢查。
- **GitHub Actions CI/CD** — ci、publish、gitleaks workflows。
- **Workspace git init** — 自動建立的 workspace 執行 `git init`，確保 CLI backend 正確辨識 project root。
- **`/agent` endpoint auth bypass** — POST /agent 使用 instance-level token，跳過 web UI token 驗證。
- **agy `--model` flag** — 傳遞 model 選擇給 antigravity CLI。
- **General-knowledge 重構** — 拆為 `steering/`（永遠載入的核心規則）+ `skills/`（按需載入、YAML frontmatter）。降低 General 預設 context 用量。
- **動態 model 探索** — skill 教 General 執行 CLI 指令（`agy models`、`/model`）而非硬寫 model 清單。

### 修正 (Fixed)
- 安裝腳本：自動偵測 sudo、nvm-aware PATH、native modules 用 build-essential、/usr/local/bin symlink 僅 root 執行。
- Discord：sticker 不再當作 photo attachment；collab 模式 chat log 包含附件檔名。
- Daemon：統一 log rotation；移除過時的 context rotation 參考。
- Update：重啟前先終止舊 fleet process；systemctl restart 前執行 daemon-reload。
- Discord react：`threadId` 而非 `chatId`（guild ID）用於 👀、⏳、✅ reactions。
- `agend update` 重啟：在 `systemctl start` 前加 `reset-failed` 處理 kill 後的 failed state。
- 跨 instance 靜默：允許 agent 沒有補充時保持沉默。
- 預設 `context_lines` 從 10 降為 5。

### 效能 (Performance)
- 平行 instance 停止（併發 5）。
- 交錯重啟通知。
- Discord `react()` 使用單一 REST PUT 而非 3 次序列 API 呼叫（fetchChannel → fetchMessage → react）。~1s → ~300ms。
- 👀 auto-react 移到 `setTopicIcon`/`archive`/`processAttachments` 之前以獲得即時回饋。

### 棄用 (Deprecated)
- **gemini-cli** — 2026-06-18 sunset。fleet start 時顯示警告。

## [1.24.0] - 2026-04-21

### 新增 (Added)
- **Discord quickstart UX** — plugin 檢查、channel 選擇、options 輸出。

### 修復 (Fixed)
- Instance 目錄被外部刪除時健康檢查迴圈會停止。
- 非數字輸入時 NaN crash；plugin 檢查改用 `npm list -g`。

## [1.23.0] - 2026-04-20

收束 `docs/fix-plan.md` Phase 1–4 安全/可靠性修復計畫。共 36 項修復／重構，分散於 7 個 PR（#33, #38, #39, #40, #41, #42, #43, #44）。

### 安全 (Security)
- **Phase 1 邊界硬化** (PR #33) — 每 instance 獨立 `/agent` token、`/ui/*` 全部 mutation 走 zod 驗證、template 變數消毒、tar entry 驗證、`project_roots` symlink resolve、branch / logPath 防 argument injection、`web.token` 0o600。
- **Telegram apiRoot 白名單** (P3.3, `9a7b16b`) — 防止透過攻擊者控制的 `apiRoot` 外洩 bot token。
- **Webhook HMAC-SHA256 簽章** (P3.1, `e65b97c`) — outbound webhook 簽章；接收端可驗證來源。
- **STT 必須顯式 opt-in** (P3.4, `1fc513e`) — 語音轉文字不再因有 env 就啟用，需 `fleet.yaml` `stt.enabled: true`。
- **`/update` 安全化** (P3.6, `740c202`, `d38a583`) — 空 `allowed_users` 整個拒絕 `/update`；兩段 token 確認（8 hex、60s TTL）；安裝時版本鎖；健康探針失敗自動回滾；supersede 通知。
- **`access-path` 拒絕 instance 名 path traversal** (P4.3, `d5d41b7`) — 白名單 `^[A-Za-z0-9._-]+$`，拒 `..` / `/` / `\` / NUL。
- **`.env` 0o600** (P4.4, `49a4328`) — wizard 寫憑證檔加上嚴格權限 + chmod 兜底。
- **CORS 收緊、支援 Bearer auth** (P3.5, `b180232`) — 拿掉 wildcard CORS；web API 接受 `Authorization: Bearer <token>`。
- **`paths.ts` md5 → sha256** (P4.5, `1f91c3c`) — 消除 FIPS／掃描器告警。custom `AGEND_HOME` 用戶升級後 tmux session/socket 後綴會變一次。

### 修正 (Fixed)
- **Telegram 409 polling 上限** (P3.2, `c67f776`) — retry 上限 30 次，避免無窮 polling。
- **Topic archiver 持久化** (P2.6, `f134a66`, `42d5d1f`) — archived topic 跨重啟保留，atomic write 至 `<dataDir>/archived-topics.json`。
- **IPC 單行上限 10MB → 1MB** (P3.7, `d446384`) — overflow 結構化拒絕,避免 OOM。
- **Tmux pane cache 在 control-mode 重連時清除** (P2.1, `e967bbb`)。
- **TranscriptMonitor 重入鎖** (P2.4, `65be144`) — 防止重疊的 `pollIncrement`。
- **Scheduler 啟動時 catch-up 24h 內漏跑** (P2.3, `01e1e32`, `24d6f8a`)。
- **Cost-guard session rotation 重置 emitted flags** (P2.2, `875a0b2`) — `warnEmitted` / `limitEmitted` 正確重置，rotation 後新 session 不會無聲衝過 daily cap。
- **SSE dead client 驅逐 + socket error 處理** (P2.5, `ae2a810`) — `broadcastSseEvent` 對單一 dead client 寫入失敗不再 break 整個 loop；`req.on("error")` 在 ECONNRESET 清理 client set。
- **拿掉 instance 啟動後多餘的 sleep+reconnect** (P2.7, `872547b`) — `startInstance` await 鏈已保證 IPC 就緒。
- **Cost-guard DST 處理** (P2.8, `3c9ff9f`) — `msUntilMidnight` 改用 `Intl.DateTimeFormat` + 二分搜尋，DST 春令／秋令日不再偏 ±1h。
- **MessageQueue flood-control backoff 重置** (P3.8, `3474c04`) — drop 後 backoff 真正重置，不會卡在 ~30s。

### 變更 (Changed)
- **`fleet-manager.ts` 拆檔** (P4.1, PR #43) — 2842 → 1658 行（-1184）。新增四個模組：
  - `fleet-dashboard-html.ts`（442 行）— dashboard HTML 常數
  - `fleet-instructions.ts`（168 行）— `GENERAL_INSTRUCTIONS` + `ensureGeneralInstructions`
  - `fleet-rpc-handlers.ts`（387 行）— IPC + HTTP CRUD dispatch
  - `fleet-health-server.ts`（326 行）— `startHealthServer` + `getUiStatus` + `extractWebToken`

  皆採 Context-injection：模組宣告 narrow `XxxContext` interface、FleetManager `implements`、外部以 `this` 呼叫純函數。
- **`daemon.handleToolCall` 抽出 helper** (P4.2, `e6a9596`) — 抽出 `dispatchFleetRpc(...)`。`handleToolCall` 182 → ~120 行，daemon.ts 淨 -51 行。
- **`validateTimezone` 單一化** (P4.4, `49a4328`) — `scheduler/scheduler.ts` 移除本地副本，import `config.ts` 的版本。

### 文件 (Docs)
- **`docs/fix-plan.md` Phase 1–4 結案** — 所有 P 項目皆 ✅ 或移至 **Deferred / Future Work**（logger rotation、cost-guard tiebreaker 兩項屬 feature 不屬 fix）。
- **`docs/p4.1-split-plan.md` 歸檔** — 四模組拆檔策略紀錄。
- **`docs/issue-evaluations.md` 新增** — 對 open issue #24（usage-limit notify）、#8（default topic preset）做效益／tradeoff 分析，供未來規劃用。

## [1.22.1] - 2026-04-19

### 修正
- **Discord 附件下載** — `downloadAttachment()` 現在可以正常運作。附件在 `messageCreate` 當下就從 Discord CDN 下載到 `inboxDir`（避開 CDN URL 過期問題），`downloadAttachment()` 改為回傳本地路徑。另外：圖片類附件會被標記為 `photo`（讓 agent 端觸發自動下載）、本地檔名會加上 Discord attachment ID 前綴避免碰撞、同一訊息的多個附件改為並行下載、下載失敗改為 log 而非靜默吞掉，`stop()` 會清理未被消費的暫存檔。關閉 #27。

## [1.22.0] - 2026-04-18

### 新增
- **`agend ls` 顯示 Kiro CLI context 用量** — 使用 Kiro backend 的 instance，清單會額外顯示目前 context window 的使用情形。
- **`agend ls` 顯示系統記憶體用量** — 清單頂端摘要加入主機記憶體壓力資訊，方便 fleet 運維者一眼看出記憶體吃緊的機器。
- **安裝腳本 WSL 偵測** — `install.sh` 偵測到 WSL 環境時會避開 Windows 側的 `node`，解決先前首次安裝因 PATH 誤抓而靜默失敗的問題。

### 變更
- **安裝腳本改用 GitHub Pages 連結** — README 一行安裝改指向 `https://suzuke.github.io/AgEnD/install.sh`（官方 host 版本），不再用 raw GitHub URL。

### 文件
- **一行安裝指令補到 README 與網站首頁** — 先前僅見於 CHANGELOG。
- **README 新增 WSL 安裝說明**。
- **網站 zh-TW hero 調整** — 捨棄商務感的「交付」，改用頁面其他處使用的調度（dispatcher）詞彙。

## [1.21.7] - 2026-04-17

### 變更
- **MCP 工具 schema 統一為 zod** — 所有 outbound 工具現在都在 `src/outbound-schemas.ts` 有對應 zod schema；`src/channel/mcp-tools.ts` 透過 `z.toJSONSchema()` 自動產生 `inputSchema`。移除手寫的 JSON Schema。必填欄位現在拒絕空字串（`minLength: 1`），不再依賴 handler 端的 truthy 檢查。
- **Outbound handler 在入口統一驗證** — `src/outbound-handlers.ts` 的 18 個 handler 先呼叫 `safeParse` 再執行邏輯；先前約 35 處未檢查的 `args.X as string` cast 全部消除。`wrapAsSend` 也接收 schema，`request_information` / `delegate_task` / `report_result` 享有同樣的保證。

## [1.21.6] - 2026-04-17

### 安全
- **Web API 介面強化**（H1、H2、H7）
- **daemon 的認證、路徑安全與資料洩漏修補**（H3、H4、H5、H6）
- **後端命令強化** — `buildCommand()` 加入 model 名稱驗證與 env 值 quoting
- **CLI 輔助函式** — 避免 shell invocation，並從 `ps` 輸出中遮蔽 token
- **Scheduler 強化** — 時區白名單、檔案數量上限、lightweight 模式守衛
- **Kiro MCP wrapper 權限** — `wrapper.sh` 收緊至 `0o700`（僅擁有者）
- **Outbound 錯誤清理** — 回傳給 agent 的工具錯誤先移除 `$HOME` 路徑並截斷至 300 字元

### 修復
- **Discord 過期互動崩潰** — adapter 現在捕捉過期互動錯誤以避免 daemon 崩潰（上游 PR #26）
- **Scheduler 重複觸發** — 原子更新避免兩個 tick 競爭時的重複發動

### 變更
- **Fleet-manager 錯誤可觀測性** — 先前被吞掉的錯誤現在會記錄；adapter 通知提升至較高嚴重度

## [1.21.5] - 2026-04-15

### 新增
- **`send_to_instance` 錯誤狀態警示** — 當目標 instance 被 rate-limited、暫停或處於 crash loop，發送者會在工具回應中收到警告（#24）
- **Codex 週限額偵測** — 偵測「less than N% of your weekly limit」警告並透過 Telegram 通知（action: notify）

### 修復
- **MCP server 透過 ppid 輪詢偵測孤兒** — 主要的孤兒偵測改用 `process.ppid` 輪詢（5 秒間隔）取代 stdin EOF；後者在 macOS 因 libuv/kqueue bug 造成 CPU 空轉而非 `'end'` 事件
- **Fleet 級 tmux server 熔斷器** — 5 分鐘內 2 次以上 tmux server 崩潰會暫停所有 instance 重生 30 秒，防止 thundering herd
- **spawn 失敗時的整棵 process 樹終止** — `killProcessTree()` 對整個 process group（CLI + MCP server）發送 SIGTERM，然後才關閉 tmux window
- **滑動視窗崩潰偵測** — 以 `crashTimestamps` 滑動視窗（5 分鐘內 3 次以上觸發暫停）取代被 backoff > 60s 破壞的 `rapidCrashCount`

## [1.21.4] - 2026-04-14

### 修復
- **崩潰重生時清理孤兒 MCP server** — daemon 讀取 `channel.mcp.pid`，在 spawn 新 CLI 前先清理孤兒 MCP server
- **MCP server 的 stdin EOF 偵測** — 加入 `process.stdin.on('end'/'close'/'error')` 監聽與 PID 檔機制（後於 v1.21.5 被 ppid 輪詢取代）

## [1.21.3] - 2026-04-14

### 修復
- E2E：mock CLI 崩潰應以 exit code 1 結束，而非 0

## [1.21.2] - 2026-04-13

### 修復
- **延遲寫入 prev-instructions 直到 session 建立** — 避免首次 spawn 失敗時 retry 上的變更偵測失敗
- E2E：更新 workflow-template 測試斷言以配合新的標題行為

## [1.21.1] - 2026-04-13

### 修復
- **Kiro CLI 2.0.0 支援** — 更新新版 TUI 的 ready pattern 與啟動對話，修復誤報「找不到」

## [1.21.0] - 2026-04-13

### 新增
- **CLI 模式** — `agent_mode: cli` 設定從 MCP 工具切換為 HTTP 的 agent CLI 端點
- **Agent CLI 端點** — 為 MCP 支援不佳的後端提供 HTTP 替代路徑
- **閒置任務提醒** — 自動對有待辦任務且閒置的 instance 發送提醒

### 修復
- Kiro：啟動時自動關閉 trust-all-tools TUI 確認
- OpenCode：`skipResume` 為 true 時不加上 `--continue`

## [1.20.4] - 2026-04-12

### 新增
- **自動關閉互動式對話** — 後端定義的啟動與執行期對話會自動關閉（trust folders、resume picker、rate limit model 切換）
- **systemPrompt 支援 `file:` 路徑** — 支援逗號分隔的 `file:` 路徑與 YAML 陣列做多檔 prompt 模組化

### 修復
- Claude Code：在啟動對話中加入 session resume prompt
- Instructions：workflow 內容自帶標題時不再出現空的 Development Workflow 標題
- 健康檢查 server 遇到 EADDRINUSE 時關掉舊 process 並重試
- Discord onboarding：10 個 UX 痛點修復
- Kiro：MCP wrapper 中的 env 匯出改為單引號以避免 backtick / dollar 解譯

## [1.20.2] - 2026-04-11

### 新增
- **`agend health`** — 透過 HTTP 端點（`/health`、`/status`）提供 fleet 健康診斷
- **Workflow template 溝通效率規則** — 結構化任務流程、沉默即同意、合併要點

### 修復
- OpenCode `skipResume` 未被遵守 + 重啟通知不一致
- 目錄不是有效的 git worktree 時安全清理

### 變更
- 溝通協定重構 — 以結構化任務流程減少 ack 洗頻

## [1.20.0] - 2026-04-10

### 新增
- **`replace_instance` 工具** — 原子性以新 instance 取代舊 instance，從 daemon 的 ring buffer 收集交接 context
- **ContextGuardian 簡化為純監控** — 移除 max_age 計時器、狀態機與所有重啟觸發器。

### 修復
- 崩潰恢復時若 `--resume` 成功則略過 snapshot 注入
- 刪除 instance 時清理過時的 MCP 項目 + writeConfig

## [1.19.1] - 2026-04-10

### 修復
- **3 個 UX 痛點** — 重啟時重新載入 instructions、單一 instance 重啟時重新載入設定、Web UI 建立 instance 缺欄位

## [1.19.0] - 2026-04-09

### 新增
- **Fleet 範本** — `deploy_template` / `teardown_deployment` / `list_deployments` 支援可重用的 fleet 組態
- **可設定的錯開啟動** — `fleet.yaml` defaults 下的 `startup.concurrency` 與 `startup.stagger_delay_ms`
- **Fleet 狀態與 MCP `list_instances` 的 Backend 欄位**

### 變更
- `agend logs` 整合 — 直接讀取 fleet.log
- `agend fleet status` 與 `agend ls` 合併為單一指令

### 修復
- fleet 啟動時清理孤兒 tmux window
- 避免 fleet stopAll 期間的 quit 命令競爭條件

## [1.18.0] - 2026-04-08

### 新增
- **統一的附加式 system prompt 注入** — 5 種後端全部改用 `--append-system-prompt-file`（Claude Code）、steering 檔（Kiro）或等效機制。Fleet instructions 不再覆蓋內建 prompt。

### 修復
- instance 停止／刪除時一律關閉 tmux window
- OpenCode `opencode.json` 使用 "instructions" 而非 "contextPaths"

## [1.17.5] - 2026-04-08

### 新增
- **崩潰輸出擷取** — 崩潰時擷取 tmux pane 內容供診斷
- **tmux server 崩潰偵測** — 區分 server 級崩潰與單一 window 崩潰

### 修復
- Kiro MCP env 隔離 — 以 wrapper script 取代 process.env 污染
- Kiro MCP transport handshake 失敗 — stdin 競爭條件
- 關閉 tmux window 前透過 quit 指令優雅結束
- 健康檢查以 exit code 區分正常離開（0）與崩潰
- 預先信任 codex 工作區 + 新增 trust 對話 pattern
- `fleet start --instance` 透過 HTTP API 委派給執行中的 daemon

## [1.17.3] - 2026-04-07

### 新增
- **`agend ls` 顯示每個 instance 的記憶體使用量**
- **Channel-aware replies** — inbound meta 帶上 source，並修正格式 passthrough

### 修復
- Codex MCP shell escape + 重啟時注入過時的 snapshot

## [1.17.1] - 2026-04-07

### 新增
- **自訂 AGEND_HOME 的 tmux socket 隔離** — 避免多個 AgEnD 安裝互相衝突

## [1.17.0] - 2026-04-07

### 新增
- **`AGEND_HOME` 環境變數** — 可設定資料目錄（預設：`~/.agend`）

### 修復
- Kiro CLI 重啟崩潰迴圈 — `skipResume` + tmux 清理

## [1.16.2] - 2026-04-07

### 修復
- 崩潰重生的孤兒清理不得阻塞 `spawnClaudeWindow`

## [1.16.1] - 2026-04-07

### 修復
- 避免並行 context 輪轉期間 tmux server 死亡
- P2 code review 改善

## [1.16.0] - 2026-04-07

### 修復
- P0+P1 code review 發現（安全性、錯誤處理、邊界條件）

## [1.15.8] - 2026-04-06

### 修復
- Codex 使用 `resume --last`（依 CWD 範圍，無 SQLite 相依）

## [1.15.6] - 2026-04-06

### 修復
- Kiro resume 改用 boolean `--resume` 旗標

## [1.15.5] - 2026-04-06

### 修復
- 錯誤監控僅掃描最後一個 prompt marker 之後（減少誤判）

## [1.15.3] - 2026-04-06

### 修復
- stop() 清理 + 重啟時 IPC 重連（#14、#12）

## [1.15.1] - 2026-04-06

### 新增
- **自動注入 active decisions** 到 MCP instructions（透過環境變數）
- `/update` topic 指令用於刷新 instance 設定

## [1.15.0] - 2026-04-06

### 新增
- Fleet 事件（輪轉、懸掛、成本警報）的 Webhook 通知
- 用於外部監控的 HTTP 健康檢查端點（`/health`、`/status`）
- 在 Context 輪轉時具有驗證與重試機制的結構化交接範本
- 權限中繼 UX 改進（逾時倒數、持久化的「一律允許」、決定後的回饋）
- 主題圖示自動更新（執行中 / 已停止）+ 閒置封存
- 過濾 Telegram 服務訊息（主題重新命名、置頂等）以節省 token

### 變更
- **Crash recovery 優先嘗試 --resume** — 崩潰重生時先嘗試 `--resume` 恢復完整對話歷史，失敗才 fallback 到全新 session + snapshot 注入

### 修復
- 最小化的 `claude-settings.json` — 允許列表中僅包含 AgEnD MCP 工具，不再覆蓋使用者全域的權限設定

## [1.14.0] - 2026-04-07

### 新增
- **Plugin 系統 + Discord adapter 獨立** — Discord adapter 搬到獨立 `agend-plugin-discord` package；factory.ts 支援 `agend-plugin-{type}` / `agend-adapter-{type}` / 裸名稱慣例；主 package 匯出（`/channel`、`/types`）讓第三方 plugin 可用
- **Web UI Phase 2：完整操控面板** — instance stop/start/restart/delete（name 確認）、建立 instance 表單（directory 可選、backend 自動偵測）、Task board CRUD、排程管理、團隊管理、Fleet 設定編輯器（表單式 + 敏感欄位遮蔽）
- **Web UI 版面：Fleet vs Instance** — Sidebar 加「Fleet」入口顯示 fleet 級 tabs（Tasks、Schedules、Teams、Config）；Instance 只保留 Chat + Detail；跨導航連結
- **Web UI UX 改善** — Toast 通知、載入狀態、Cron 人類可讀描述、加大狀態點、空狀態引導、成本標註、網站一致風格（`#2AABEE` 強調色、Inter + JetBrains Mono 字體）
- **Backend 自動偵測** — `GET /ui/backends` 掃描 PATH；建立 instance 的 dropdown 顯示安裝/未安裝狀態
- **指定 instance 重啟** — `agend fleet restart <instance>` 透過 fleet HTTP API
- **一鍵安裝腳本** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash`
- **project_roots 限制** — `create_instance` 拒絕不在設定 roots 範圍內的目錄

### 修復
- **Web UI 回覆 context** — 首次 web 訊息不再出現「No active chat context」；使用真實 Telegram group_id/topic_id
- **Web↔Telegram 雙向同步** — Web 訊息以 `🌐` 前綴轉發到 Telegram；Telegram 訊息透過 SSE 推送到 Web UI
- **SSE 即時狀態刷新** — 操作按鈕在 stop/start/restart/delete 後即時更新
- **.env 覆蓋** — `.env` 檔案值無條件覆蓋繼承的 shell 環境變數
- **tmux duplicate session race** — `ensureSession()` 處理並行啟動時的競爭條件
- **建立 Instance 表單** — directory 改為可選，topic_name 動態必填

### 變更
- **discord.js 從核心依賴移除** — 僅在安裝 `agend-plugin-discord` 時需要
- **Web API 抽取到 `web-api.ts`** — 縮減 fleet-manager.ts；所有 `/ui/*` 路由集中管理
- **認證統一** — 所有 Web UI 端點（含 restart）都需要 token 認證

## [1.13.0] - 2026-04-06

### 新增
- **Web UI Phase 2：完整操控面板** — 建立/刪除 instance、Task board CRUD（建立、認領、完成）、排程管理（建立、刪除）、團隊管理（成員勾選建立、刪除）、Fleet 設定檢視（唯讀、已清理敏感資訊）
- **Web UI 風格統一** — 對齊網站設計：Telegram 藍 `#2AABEE` 強調色、Inter + JetBrains Mono 字體、深色主題、圓角卡片、Toast 通知、載入狀態
- **一鍵安裝腳本** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash` 一行完成安裝（Node.js via nvm、tmux、agend、後端偵測）
- **project_roots 限制** — `create_instance` 拒絕不在 `project_roots` 範圍內的目錄
- **認證統一** — 所有 Web UI 端點（包含 restart）都需要 token 認證

### 修復
- **Web UI 回覆 context** — 首次從 Web UI 發訊不再出現「No active chat context」錯誤；使用真實 Telegram group_id/topic_id
- **即時狀態刷新** — Instance 操作按鈕在 stop/start/restart/delete 後透過 SSE 即時更新
- **Web↔Telegram 雙向同步** — Web 訊息以 `🌐` 前綴轉發到 Telegram topic；Telegram 訊息透過 SSE 推送到 Web UI

### 文件
- 全面文件盤點：所有文件新增 20+ 遺漏功能
- 網站全面改版為 Spectra 風格深色設計

## [1.12.0] - 2026-04-06

### 新增
- **Web UI 儀表板** — `agend web` 啟動瀏覽器 fleet 監控，SSE 即時更新 + 整合聊天介面，支援 Telegram 雙向同步
- **agend quickstart** — 簡化 4 問題設定精靈，取代 `agend init` 作為推薦的新手入口
- **project_roots 限制** — `create_instance` 驗證工作目錄在設定的 `project_roots` 範圍內
- **HTML 對話匯出** — `agend export-chat` 匯出 fleet 活動為獨立 HTML，支援日期篩選（`--from`、`--to`）
- **Mirror Topic** — `mirror_topic_id` 設定，在專屬 topic 觀察跨 instance 通訊

### 修復
- **平行啟動** — 處理多 instance 同時啟動時的 tmux duplicate session race
- **.env 優先覆蓋** — `.env` 的值正確覆蓋繼承的 shell 環境變數
- **Web UI 聊天同步** — Web UI 與 Telegram 之間的雙向訊息同步

### 文件
- README 大改版：hero section、功能亮點、架構圖、運作原理說明
- Quick Start 改為使用 `agend quickstart`
- 全面文件盤點：features.md、cli.md、configuration.md 更新所有 v1.11.0-v1.12.0 功能

## [1.11.0] - 2026-04-05

### 新增
- **Kiro CLI backend** — 新增 AWS Kiro CLI 支援（`backend: kiro-cli`）。支援 session resume、MCP config、error patterns。模型：auto、claude-sonnet-4.5、claude-haiku-4.5、deepseek-3.2 等
- **內建 workflow 模板** — fleet 協作流程透過 MCP instructions 自動注入。可在 fleet.yaml 的 `workflow` 欄位設定（`"builtin"`、`"file:path"` 或 `false`）
- **Workflow 分層：coordinator vs executor** — General instance 取得完整 coordinator 指南（Choosing Collaborators、Task Sizing、Delegation Principles、Goal & Decision Management）。其他 instance 取得精簡的 executor 版本（Communication Rules、Progress Tracking、Context Protection）
- **`create_instance` 的 systemPrompt 參數** — 建立 instance 時可傳入自訂 system prompt（僅支援 inline 文字）
- **Fleet ready Telegram 通知** — `startAll` 和 `restartInstances` 完成後發送「Fleet ready. N/M instances running.」到 General topic，含失敗 instance 報告
- **E2E 測試框架** — 79+ 測試在 Tart VM 中隔離執行。Mock backend 支援 `pty_output` 指令模擬錯誤。T15 workflow 模板測試、T16 failover cooldown 測試
- **Token overhead 量測** — 測試腳本（`scripts/measure-token-overhead.sh`）與報告。Full profile：+887 tokens（佔 200K context 的 0.44%，$0.003/msg）
- **Codex 用量限制偵測** — 「You've hit your usage limit」error pattern（action: pause）
- **MockBackend error patterns** — `MOCK_RATE_LIMIT` 和 `MOCK_AUTH_ERROR` 供 E2E 測試使用

### 修復
- **Crash recovery snapshot restore** — 在 crash 偵測時寫入 snapshot（不只 context rotation）；以 in-memory `snapshotConsumed` flag 取代 single-consume 刪除，檔案保留供 daemon 重啟恢復
- **Codex session resume** — `CodexBackend.buildCommand()` 現在在 session-id 存在時使用 `codex resume <session-id>`（#11）
- **Rate limit failover 循環** — failover 類型的 PTY error 加入 5 分鐘 cooldown，防止 terminal buffer 殘留文字重複觸發（#10）
- **PTY error monitor hash dedup** — recovery 時記錄 pane hash，同畫面同 error 不重複觸發
- **CLI restart 等待** — bootout/bootstrap 之間的固定 1 秒改為動態 polling（最多 30 秒），修復多 instance 時「Bootstrap failed: Input/output error」
- **CLI attach 互動選單** — fuzzy match 多個結果時顯示編號選單而非報錯
- **CLI logs ANSI 清理** — 增強 `stripAnsi()` 處理 cursor 移動、DEC private modes、carriage returns 等
- **agent 訊息中的 `reply_to_text`** — 用戶回覆的原始訊息內容現在包含在 paste 給 agent 的格式化訊息中
- **General instructions 按 backend 產生** — auto-create 根據 `fleet.defaults.backend` 寫入對應檔案（CLAUDE.md、AGENTS.md、GEMINI.md、.kiro/steering/project.md）
- **General instructions 每次啟動確認** — `ensureGeneralInstructions()` 在每次 `startInstance` 時呼叫，不只 auto-create
- **內建文字英文化** — 所有系統產生的文字從中文改為英文（排程通知、語音訊息標籤、general instructions）
- **General 委派原則** — 改寫為 coordinator 角色：主動委派，以具體條件判斷

### 變更
- Fleet start/restart 通知統一為「Fleet ready. N/M instances running.」格式，送到 General topic
- 移除 `buildDecisionsPrompt()` dead code（v1.9.0 已故意停用）
- 移除 fleet-manager 的 `getActiveDecisionsForProject()`（dead code）

### 文件
- OpenCode MCP instructions 限制（v1.3.10 不讀取 MCP instructions 欄位）
- Kiro CLI MCP instructions 限制（未驗證）
- Token overhead 報告（EN + zh-TW）含可重現的測試腳本

## [1.10.0] - 2026-04-05

_中間版本，改動已包含在 1.11.0。_

## [1.9.1] - 2026-04-03

### 修復
- Health-check 重新啟動時注入 session snapshot — 崩潰/kill 恢復也能還原 context
- Snapshot 貼入時附加「不要回覆」指令，防止模型嘗試 IPC 回覆導致逾時

## [1.9.0] - 2026-04-03

### 破壞性變更
- **System prompt 注入改為 MCP instructions。** Fleet context、自訂 `systemPrompt`、協作規則現在透過 MCP server instructions 注入，不再使用 CLI 的 `--system-prompt` 等 flag。變更原因：
  - Claude Code：`--system-prompt` 傳了檔案路徑而非檔案內容 — fleet prompt **自始至終都沒有正確注入**
  - Gemini CLI：`GEMINI_SYSTEM_MD` 會覆蓋內建 system prompt 並破壞 skills 功能
  - Codex：`.prompt-generated` 是 dead code — 寫入但 CLI 從未讀取
  - OpenCode：`instructions` 陣列被覆蓋而非追加，破壞專案原有的 instructions
- **對現有設定的影響：**
  - `fleet.yaml` 的 `systemPrompt` 欄位保留 — 改由 MCP instructions 注入
  - 不再產生 `.prompt-generated`、`system-prompt.md`、`.opencode-instructions.md` 檔案
  - 各 CLI 的內建 system prompt 不再被覆蓋或修改
  - Active Decisions 不再預載到 system prompt — 改用 `list_decisions` 工具按需查詢
  - Session snapshot（context rotation 接續）改為第一則 inbound 訊息送入（`[system:session-snapshot]`），不再嵌入 system prompt

## [1.8.5] - 2026-04-03

### 修復
- 統一 log 與通知格式為 `sender → receiver: summary` 風格，適用於所有跨 instance 訊息
- Task/query 通知顯示完整訊息內容；report/update 通知僅顯示摘要

## [1.8.4] - 2026-04-03

### 修復
- 跨 instance 通知格式改為 `sender → receiver: summary` 格式
- General Topic instance 不再收到跨 instance 通知貼文
- 降低跨 instance 通知噪音 — 移除發送方 topic 貼文；目標通知優先使用 `task_summary`

## [1.8.3] - 2026-04-03

### 新增
- **Team 支援** — 具名的 instance 群組，用於精準廣播
  - `create_team` — 建立含成員與描述的 team
  - `list_teams` — 列出所有 team 及其成員
  - `update_team` — 新增/移除成員或更新描述
  - `delete_team` — 刪除 team 定義
  - `broadcast` 新增 `team` 參數，可對指定 team 的所有成員廣播
  - `fleet.yaml` 新增 `teams` 區塊，用於持久化 team 定義

## [1.8.2] - 2026-04-03

### 新增
- `fleet.yaml` 中 `working_directory` 現在為選填 — 未指定時自動建立 `~/.agend/workspaces/<name>`
- `create_instance` 的 `directory` 參數現在為選填（省略時自動建立工作空間）

### 修復
- Topic 模式下，Context-bound routing 現在在 IPC 轉發前執行（修正「chat not found」錯誤）
- Telegram：`thread_id=1` 正確視為 General Topic（不傳送 thread 參數）
- Scheduler 在 instance 啟動前完成初始化，確保 fleet 啟動時能正確載入 decisions

## [1.8.1] - 2026-04-03

### 新增
- `reply`、`react`、`edit_message` 改為 context-bound — 不再需要在 tool call 中指定 `chat_id` 和 `thread_id`；daemon 自動從當前對話 context 填入
- PTY 監控的後端錯誤模式偵測 — 偵測到頻率限制、認證錯誤或崩潰時自動通知
- 自動關閉執行時對話框（如 Codex 頻率限制的模型切換提示）
- 模型容錯移轉 — 達到頻率限制時自動切換備用模型（statusline + PTY 偵測）

### 修復
- PTY 錯誤監控處理後發送恢復通知
- 降低錯誤監控誤報；自動從 context 修正無效的 `chat_id`

## [0.3.7] - 2026-03-27

### 新增
- 用於移除實例的 `delete_instance` MCP 工具
- `create_instance --branch` — 用於功能分支隔離的 git worktree 支援
- 外部轉接器外掛載入 — 透過 `npm install agend-adapter-*` 安裝社群轉接器
- 從套件進入點導出頻道類型，供轉接器作者使用
- Discord 轉接器 (MVP) — 連接、發送/接收訊息、按鈕、反應
- 優雅重啟後 Telegram 主題中的每個實例重啟通知

### 修復
- `start_instance`、`create_instance`、`delete_instance` 已加入權限允許列表
- Worktree 實例名稱使用 `topic_name` 而非目錄基底名稱，以避免 Unix socket 路徑溢位（macOS 104 位元組限制）
- 帶有分支的 `create_instance` 不再對基礎 repo 觸發錯誤的 `already_exists`
- `postLaunch` 穩定性檢查替換為 10 秒寬限期
- 重啟通知使用 `fleetConfig.instances` + IPC 推送
- 解決了 Discord 轉接器的 TypeScript 錯誤

## [0.3.6] - 2026-03-27

### 修復
- 防止實例重啟時產生 MCP server 殭屍進程
- 強化 `postLaunch` 自動確認以應對邊緣案例

## [0.3.5] - 2026-03-26

### 新增
- 透過 `create_instance(model: "sonnet")` 進行各實例的模型選擇
- 實例 `description` 欄位，在 `list_instances` 中提供更好的可發現性
- 每 5 分鐘自動從 `sessionRegistry` 清理過期的外部 session
- AgEnD 到陸頁網站（Astro + Tailwind，英文/繁體中文雙語）
- 用於網站部署的 GitHub Actions 工作流
- README 中的安全考量章節

### 變更
- 簡化模型選擇 — 僅可透過 `create_instance` 配置，而非逐條訊息配置
- 使用單一 `query_sessions_response` 進行 session 清理

### 修復
- 安全強化 — 10 項漏洞修復（路徑遍歷、輸入驗證等）
- 向 Telegram 發送完整的跨實例訊息，而非截斷為 200 字元的預覽
- 移除 IPC 秘密驗證 — socket `chmod 0o600` 已足夠且更簡單

## [0.3.4] - 2026-03-26

### 變更
- 移除斜線指令 (`/open`, `/new`, `/meets`, `/debate`, `/collab`) — General 實例透過 `create_instance` / `start_instance` 處理專案管理
- 移除無用程式碼：`sendTextWithKeyboard`、`spawnEphemeralInstance`、會議頻道方法

## [0.3.3] - 2026-03-25

### 修復
- 修正測試斷言中的 `statusline.sh` → `statusline.js`

## [0.3.2] - 2026-03-25

### 新增
- 帶有動態匯入的頻道轉接器工廠，用於未來的多平台支援
- 意圖導向的轉接器方法：`promptUser`、`notifyAlert`、`createTopic`、`topicExists`
- Telegram 權限提示上的「一律允許」按鈕
- `InstanceConfig` 中的每個實例 `cost_guard` 欄位
- `ChannelAdapter` 上的 `topology` 屬性 (`"topics"` | `"channels"` | `"flat"`)

### 變更
- 頻道抽象化階段 A — 從業務邏輯中移除所有 TelegramAdapter 耦合（fleet-manager, daemon, topic-commands 現在使用通用的 ChannelAdapter 介面）
- CLI 版本從 package.json 讀取而非硬編碼值
- 排程子指令現在有 `.description()` 用於幫助文字

### 修復
- statusline 腳本中的 shell 注入 — 將 bash 替換為 Node.js 腳本
- 設定精靈與配置中的時區驗證 (Intl.DateTimeFormat)
- `max_age_hours` 預設值在設定精靈、配置和 README 中統一為 8 小時
- `pino-pretty` 從 devDependencies 移至 dependencies（修復 `npm install -g`）
- 在重啟時清除 `toolStatusLines` 以防止無限增長
- 為 daemon-entry 中的 `--config` `JSON.parse` 加入 try-catch
- 移除無用程式碼 `resetToolStatus()`
