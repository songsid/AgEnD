# 更新日誌 (Changelog)

本專案的所有顯著變更都將記錄在此檔案中。

格式基於 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [未發佈] (Unreleased)

### 安全 (Security)
- **instance 目錄改為 0700（既有的在啟動時一次性修正）。** `<data dir>/instances/<name>` 裡有 `agent.token` 與 IPC socket，
  卻是用行程 umask 建立的 —— 通常是 0775，也就是群組可寫、本機所有使用者都能穿越（裡面的檔案本來就是 0600，開著的是目錄這道門）。
  新建的 instance 目錄一律 0700；啟動時 fleet 會把 `instances` 目錄與其下每個 instance 目錄一次性收成 0700，只記一行 log，
  且不動裡面的任何東西（你放進去的檔案維持原權限）。symlink 與他人擁有的目錄不會被動，並會在警告中點名。
  過去每次啟動 instance 都出現、卻從沒人處理的「IPC socket parent directory is world-accessible」警告，現在只會在仍然開放且
  無法修正的目錄上、每個目錄報一次。**若有其他使用者或服務原本靠群組權限讀取 instance 目錄，請改為明確授權 —— 群組不再有權限。**（#1118）

### 升級注意事項 (Upgrade Notes)
- **[行為變更] `/install-cli` 已移除：`/login` 會先安裝缺少的 CLI，再接著登入（#1131）。** 「讓這個 CLI 能用」只需要一個指令，所以有多個 AgEnD bot 的 guild 每個 bot 只顯示一個入口，也不會再打錯（`/install`、`/login-cli`）。`/login` 的選單會列出 fleet 可以安裝或登入的每個 backend，並標明點下去會做什麼：已安裝的 CLI 直接登入；未安裝的會先安裝（執行官方安裝腳本並確認在 PATH 上），完成後自動接著登入。`/login <backend>` 也一樣；`/login reinstall <backend>`（Discord 上是 `reinstall` 選項）會重新安裝已安裝的 CLI；`/login cancel` 也能停止安裝。`opencode` 與 `muse` 可以安裝，但沒有登入流程；選單不列出 Gemini CLI，但 `/login gemini-cli` 仍可安裝它。Discord 的 slash 指令與 Telegram 選單中的 `/install_cli` 都已移除。在 2.1.10 直接輸入 `/install-cli`（或 `/install_cli`）仍可使用——它會說明指令已併入 `/login`，並執行對應的 `/login`——這個別名會在 2.1.11 移除。
- **[行為變更] 暫停中的 instance 收到其他 instance 傳來的工作時，會自己醒來（#1129）。** `delivery_worker` 的預設值從 `off` 改為 `wake_only`。在 `off` 下，委派給一個跨 fleet 重啟仍保持暫停的 instance 的工作，會一直等到有人執行 `/wake`，而且看不出它卡住了。現在 wake coordinator 會用跟 `/wake` 相同的方式喚醒它：失敗會退避重試、連續三次失敗會通知，並且不會喚醒因登入失敗而暫停的 instance。設了 `warm_cap` 時，為了排隊工作而喚醒最多可超出上限 `warm_overflow`（預設 2）個；上限加超出額度都滿、又沒有閒置的 instance 可以暫停時，對暫停中 instance 的 `/wake` 或訊息會被拒絕，而不是超出上限。明確設定 `delivery_worker: off` 會維持原本的行為。
- **[行為變更] crash dump 只會很小，而且 fleet 一直失敗時 systemd 不再無限重啟（#1113）。** WSL 會把所有 crash 交給 WSL 的 crash collector，它不理會 `LimitCORE`，所以 kiro-cli 和 fleet 本身都在 `%TEMP%\wsl-crashes` 留下約 1GB 和 450MB 的 core dump。現在 systemd unit 設定 `CoredumpFilter=0`，dump 只有幾 KB；這個設定會被 tmux server 以及 fleet 啟動的每個 CLI 繼承。`LimitCORE=0` 適用於直接寫 core 檔的系統。`TimeoutStartSec` 從不設上限改為 15 分鐘。`StartLimitIntervalSec=30min` 和 `StartLimitBurst=4` 讓 fleet 在 30 分鐘內失敗 4 次後，systemd 就不再自動重啟；以前一次啟動要好幾分鐘，原本「10 秒內 5 次」的限制永遠不會觸發，主機記憶體耗盡時就會一直「watchdog 殺掉 → systemd 重啟」。**直接執行 `systemctl --user restart com.agend.fleet` 會計入這個次數；`agend restart` 會先執行 `reset-failed`，不受影響。** `agend restart`（`agend update` 也會執行它）會替舊的 unit 補上這些設定、重新載入 systemd，並確認已載入 `CoredumpFilter=0`，否則拒絕重啟；systemd 246 以前不認得這個設定，只會提出警告。你自己設定的值不會被更動。
- **[行為變更] kiro instance 每次啟動都會鎖定自己的 engine；做不到時會拒絕啟動，而不是換掉 engine（#1109）。** kiro-cli 3.0（2026 年 10 月）會棄用 classic UI，而且可能預設改用 V3 engine；kiro 還會跳出「切換到 3.0」的提示，答案會存成整台機器共用的設定。instance 的對話存在它所屬 engine 的資料庫裡，換 engine 會單向分叉。現在 AgEnD 會以 `--legacy-ui --agent-engine=v1` 啟動 `kiro_ui: legacy`、以 `--tui --agent-engine=v2` 啟動 `kiro_ui: tui`（啟動參數優先於已存的設定）。每個 kiro-cli 能接受哪些值，依版本判斷；比 2.27 更新的版本則讀它自己的 `chat --help`（2.3 的 `--agent-engine` 只接受 `rust|kas`，所以只帶 `--legacy-ui`）。若 kiro-cli 已無法讓 instance 跑在原本的 engine 上，就不會啟動：會發一則說明原因的通知，且不自動重試。執行中的 instance 若 kiro-cli 被就地換掉，會在下次重啟時被擋下。`--help` 裡少了選擇器，絕不會被當成「這是舊版」的證據。「切換到 3.0」和「升級 agent 設定」這兩個啟動提示，會選擇不做任何變更的選項：一次只按一個鍵，而且只在確認游標確實停在該選項時才按；其他狀態（游標無法辨識、停在「Don't ask again」、按了鍵游標卻沒動）都會停下來等人處理，期間暫停傳送訊息。kiro-cli 比 2.21 舊或比 2.27 新時會通知一次，但仍會啟動。
- **[行為變更] 一個壞掉的 MCP server 不會再讓所有 kiro instance 起不來（#1111）。** AgEnD 以前啟動 kiro-cli 時會帶 `--require-mcp-startup`，只要「任何一個」啟用中的 MCP server 啟動失敗，kiro 就會直接結束（exit code 3）——包括你自己在 `~/.kiro/settings/mcp.json` 設定的 server。因此某個第三方 server 在 kiro-cli 2.27 上壞掉時，所有 kiro instance 都無法啟動。現在 kiro 跟 claude、codex 一樣：你自己的 server 失敗只會少掉它自己的工具（kiro 會在 pane 裡顯示 `✗`）。AgEnD 自己的 fleet server 有沒有連上，改由 daemon 檢查，而且適用所有 backend：CLI 啟動 90 秒後 AgEnD 的 MCP server 仍未連上時，instance 會回報它沒有 agend 工具，並在 `mcp_auto_restart`（預設開啟）下等閒置後重啟再試。server 若之後才連上，該回報會被撤回。
- **[行為變更] tunnel 改走 http2 並最多等一分鐘。** cloudflared provider 現在預設傳 `--protocol http2`（QUIC/UDP 7844 在很多公司網路與 VM 被擋，
  cloudflared 否則要花很久才 failover 或根本連不上），就緒檢查改為先經 Cloudflare 公共解析器（1.1.1.1 / 1.0.0.1）、系統解析器當後備；啟動預算由 30 秒
  改為 60 秒。`agend setup --tunnel` 同樣適用。若要沿用 cloudflared 自己的選擇，可設 `web_terminal.tunnel.protocol: quic`（或 `auto`）。
- **[行為變更] `/login` 的瀏覽器終端採用同一套 `Host` 規則。** 每次 `/login` 會開一個自己的短命 listener。它只檢查 `Origin` 等於 `Host` — 這一點 DNS rebinding 頁面天生就會滿足 — 而且對任何 `Host` 都回應。現在凡是不是 `localhost`/`127.0.0.1`/`[::1]`、fleet 的 `hostname:`、或 `web.allowed_hosts` 項目（dashboard 已在用的同一個設定）的名稱，任何路徑與 WebSocket upgrade 都一律回相同的 403。**如果你是透過反向代理或區網位址開啟終端連結，請把該名稱加進 `web.allowed_hosts`。** 這個 listener 也可以被告知「再多放行一個精確名稱」，並依該名稱（而非 `X-Forwarded-Proto`）決定 cookie 是否 `Secure`；目前沒有任何功能使用它（這是日後讓登入終端經由 tunnel 對外的前置工作）。
- **[行為變更] dashboard 現在會拒絕 `Host` 不認得的請求。** health/dashboard server 雖然只綁 127.0.0.1，但這擋不住 DNS rebinding：網頁可以把自己的網域解析到 127.0.0.1，再用 script 讀取不需要 cookie 的路由，包含 `/view` 的即時終端畫面（`/api/pane/*`）。這種網頁唯一改不了的是瀏覽器送出的 `Host`，所以所有路由（含 `/health`、`/agent`）現在只有在 `Host` 是 `localhost`、`127.0.0.1`、`[::1]`、fleet 的 `hostname:`，或新增的 `web.allowed_hosts` 列出的名稱時才回應，其餘一律 403（不比對 port）。**如果你是透過反向代理或 port forward、且它呈現的是別的名稱，請把該名稱加進 `web.allowed_hosts`**；每個被拒的名稱第一次出現時，`fleet.log` 會記一行並附上這個提示。CLI、`agend web`、`/dashboard` 與內部呼叫都用 loopback 名稱，不受影響。

### 新增 (Added)
- **`/login` 會標明屬於哪個 fleet。** 同一個 Discord guild 裡每個 AgEnD bot 都會註冊自己的 `/login`，所以 slash 選單列出一模一樣的指令，選單也可能來自你不想操作的那個 fleet。現在指令說明的結尾會帶著 fleet 標籤，backend 選單也會顯示 `🖥 Fleet：<標籤>`。標籤取自 fleet.yaml 的 `fleet_label`，預設為主機名稱（AgEnD home 不是 `~/.agend` 時再加上該目錄名稱）。
- **用手機完成 `kiro-cli` 的 `/login`：選用的公開連結（`web_terminal.tunnel.allow_public`，預設關閉）。** 啟用後，登入確認會在
  **只用本機連結** 旁多一個 **開啟公開連結**；按下就是這次登入的同意。Cloudflare Quick Tunnel 只代理那一次登入的終端；公開連結與存取 token
  以兩則私訊傳給發起人（絕不進頻道）；私訊送不到、tunnel 起不來或中途斷線、取消、逾時、關閉 fleet，都會在下一次登入之前先關掉 tunnel，
  無法確認已停止的 tunnel 會被公告並封鎖後續 tunnel。tunnel 的公開名稱不會寫進 log。需要 `PATH` 上有 `cloudflared`。
  見 `docs/configuration.zh-TW.md`「人不在機器旁完成 /login」。

### 修正 (Fixed)
- **Discord 拒絕 slash 指令註冊時會回報（#1131）。** 以前註冊失敗不會留下任何記錄，而 Discord 拒絕時會保留先前的指令清單，所以新增或變更的指令可能就這樣默默不出現。現在 fleet 會記錄每次註冊的結果（指令數量，或 Discord 的錯誤代碼與訊息），被拒絕時也會在 General 通知一次。
- **按鈕提示不會再無聲失敗（#1133）。** 在 Discord 上，超過五個 backend 的選單根本貼不出來：Discord 一列最多五個按鈕，而它們全放在同一列。現在按鈕會每五個一列排好。無法貼出的選單或確認提示會直接說明，不再回報「已送出選單」或停在「正在啟動…」。無法執行的點擊——提示已逾時、不是你的提示、或你不是 fleet 管理員——現在會私下告訴你原因（Discord 用只有你看得到的訊息，Telegram 用按鈕的回應）。Telegram 改為在 fleet 做出決定後才回應點擊，所以回應失敗不會再讓點擊遺失。結果無法寫回提示時，會改以訊息送出；沒有人處理的點擊會留下記錄。
- **Discord：`/login` 的 backend 按鈕按了會有反應（#1131）。** 原生 slash 指令貼出的選單綁定的是頻道，但 Discord 回報每次按鈕點擊時用的是 guild 加頻道，所以每次點擊都被判定為不相符而被丟掉，按了沒有任何反應。現在按鈕帶的位址和點擊回報的一致。在 bot 主要伺服器以外的頻道（那裡也接受 slash 指令）貼出的選單現在也能點；那類頻道的其他按鈕仍會被忽略，但會留下記錄，不再默默丟掉。slash 回覆也改用 `flags`，取代 discord.js 已棄用的 `ephemeral` 選項，client 改為監聽 `clientReady`。
- **在 systemd 主機上用 `agend update` / `/update` 升到 2.1.10-beta.2 會失敗（「fleet restart failed」），而且舊的 fleet 會繼續執行（#1113 hotfix）。** systemd 249 會默默忽略 unit 檔裡的 `CoredumpFilter=`，所以 beta.2「確認 systemd 已載入 `CoredumpFilter=0`」的檢查會拒絕每一次 `agend restart`。這個檢查已移除（載入值不是 0 時只會提示）。在 Linux 上，fleet 現在會在啟動時把自己的 `/proc/self/coredump_filter` 設成 0，每次啟動 CLI 時也會先在 pane 的 shell 裡設好——所以不論 systemd 版本、即使 tmux server 不是這個 fleet 起的，crash dump 都只有幾 KB。`AGEND_KEEP_COREDUMP_FILTER=1` 可關閉這個行為（行程改用繼承來的 mask，不一定是完整 dump）。另外，`agend update` 遇到比已安裝版本更早啟動的 fleet 時會補做重啟，不再只顯示「已是最新」——但只限依命令列確認確實是 fleet 的行程；`fleet.pid` 若指向其他行程，一律不重啟也不送訊號——所以因 restart 失敗而停在舊版的 fleet 也能跟上。
- **用暫時的 `HOME` 啟動的 fleet 不會再連上真正 fleet 的 tmux server（#1126）。** 只有使用者真實的 `~/.agend`（依帳號資料，而不是 `$HOME`）會使用 tmux 的預設 socket（讀不到帳號資料時，沒有任何 home 算預設）。以前，把 `HOME` 和 `AGEND_HOME` 都指向暫存目錄來啟動 fleet，也會被當成「預設」，因而連上執行中的 `agend` server，它的啟動清理會把真正 fleet 的視窗當成孤兒殺掉。`AGEND_HOME` 未設定、設成你真實的 `~/.agend`，或其他自訂值，行為都不變，各自沿用原本的 socket。
- **dashboard 的回應不會再被 iframe 嵌入、被猜測型別或被快取。** dashboard/health server 的每個回應現在都帶 `X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`（這些頁面有重啟 instance 的按鈕，被嵌入就可能被誘導點擊）、`X-Content-Type-Options: nosniff` 與 `Cache-Control: no-store`（自己設定 Cache-Control 的路由，例如 SSE 與頭像，維持原樣）。

## [2.1.9] - 2026-10-02

### 升級注意事項 (Upgrade Notes)
- **systemd 停止服務時只停 fleet，不再一次停掉所有 CLI（#908）。** systemd 預設的 `KillMode=control-group` 在停止或更新服務時，會同時對 fleet、tmux server 和所有 CLI 送 SIGTERM，fleet 來不及逐一結束它們；在 WSL 上 kiro-cli 每次都會 abort，留下約 1 GB 的 core dump。新的 unit 使用 `KillMode=mixed`，而 `agend restart`（`agend update` 會執行它）會在重啟前替既有的 unit 加上這一行並重新載入 systemd（#1070）。如果這一行寫不進去，或 reload 之後 systemd 載入的仍是其他模式，重啟會被拒絕並說明該怎麼做，不會照舊方式停掉 fleet（#1073）。你自己設定的 `KillMode` 不會被更動。
- **重啟一個 paused 的 instance 現在等於喚醒它（#1075）。** 以前重啟後它仍是 paused，fleet 重啟後也沒有東西會喚醒它。啟動失敗時，它會維持 paused、之後仍能喚醒。
- **新的選用投遞設定 `delivery_worker`（預設 `off`；#1075、#1078、#1079）。** `off` 時所有投遞路徑和以前一樣。`wake_only` 和 `on` 見「新增」。使用這兩種時，`defaults.warm_overflow`（預設 2）是為了替待送工作喚醒 target 時，`warm_cap` 最多可超出的數量。

### 新增 (Added)
- **跨 instance 訊息能可靠地喚醒 paused 的 instance（選用，`delivery_worker: wake_only`；#1078）。** 以前送給在 fleet 重啟前就 paused 的 instance 的訊息，會停在 attempt 0，直到有人手動喚醒。現在 wake coordinator 會在有待送工作時喚醒 paused 的 target，走的是和操作者 `/wake` 相同的單一喚醒流程；失敗時依退避重試，連續失敗後通知雙方的 topic，並且絕不自動喚醒因登入失敗而暫停的 instance。它也會把醒著的 instance 數維持在 `warm_cap` 加 `warm_overflow` 以內。每個 instance 可以分別設定。
- **每個 instance 的投遞 worker（金絲雀，`delivery_worker: on`；#1079）。** 設為 `on` 的 instance 由一個 worker 擁有它的投遞通道：先以 daemon 自己的判斷等到 CLI 可以接受輸入，再一次一筆地認領、交付、等待結果。只有在沒有任何進行中的訊息時才會轉移擁有權；開始輸入後若連線中斷，下一則訊息也絕不會越過還沒完成的那一則。
- **照片和附件的 persona emoji（#1080、#1082）。** bot 在它存下的照片或檔案上蓋的標記（📸 / 📎，Telegram 上是 👌 / 👍）現在是 `status_emojis` 的兩個新 key：`photo` 和 `attachment`，可在 Settings 或用 `set_persona_emoji` 設定。
- **每個 instance 都能看到伺服器 emoji（#1081、#1083）。** `general` 現在可以列出、預覽並設定自己的標記；`minimal` 可以列出和預覽。ClassicBot instance 的 `list_emojis` 會回傳伺服器 emoji，也能使用 `preview_emojis`；只有 `set_persona_emoji` 會拒絕它，並指向 Settings。
- **`/status` 合併 State 欄並新增 Model 欄（#1052）。** State 欄把 paused、stopped 或 crashed 和執行狀態合在一起；Model 顯示即時模型，與 `/ctx` 回報的相同。IPC 欄已移除，`agend ls` 也改用相同的 State 圖示。
- **`agend delivery scan-forged-envelopes`（#995）。** 掃描 kiro instance 自己的 transcript，找出指名真實 instance 的 fleet 訊息信封，並用持久化的投遞紀錄核對每個 message id，回報 fleet 從未投遞過的那些。讀不到的內容一律以失敗收場（fail closed）。
- **結束 CLI 時會記錄原因與呼叫者（#1030）。** Codex 結束後沒有重新啟動時，現在會回報。

### 修正 (Fixed)
- **Claude Code 第一次啟動不再停在信任對話框或在那裡退出（#1074）。** 它的確認對話框在剛出現的一小段時間內不接受按鍵，所以連續送出 Down、Enter 可能落在「No, exit」。現在信任和略過權限對話框會在確認游標位置後一步一步回答；onboarding 畫面（主題、安全說明、終端設定）會被辨識，不再被誤當成可輸入的提示；登入畫面也會在判斷就緒之前先檢查。
- **被喚醒的 instance 會撐到工作送達（#1075）。** 其他 instance 交付的工作現在算作活動，被喚醒的 instance 也會重新開始計算閒置時間；以前只接委派工作的 instance 每次被喚醒後一秒就又暫停。同一個 instance 的啟動、停止、喚醒和重啟現在一次只執行一個，晚到的啟動不會再蓋掉較新的那一個。
- **grok 會告訴操作者執行 `grok update`（#1066）。** 不再在伺服器拒絕過舊的 CLI 時安靜地失敗。
- **Codex 遠端登入只提供裝置驗證（#1072）。**
- **用 `/install-cli` 安裝的 CLI，`/login` 不必重啟 fleet 就能使用（#1059）。**
- **無法驗證的登入錯誤比對，只在這一輪結束時仍在畫面上才會暫停 instance（#1044）。** muse 超過第一分鐘的回合仍會被判為忙碌（#1045）。
- **注入的訊息信封不再重複只是照抄訊息內容的 `task_summary`（#1037）。**
- **安全性：** 工作目錄路徑不能再注入 shell 指令，身分設定也不能再寫入物件原型（#1061）；persona emoji 工具只會作用在 instance 自己的設定項目上（#1062、#1065）；`list_emojis` 和 `preview_emojis` 會拒絕 `constructor` 之類的繼承名稱（#1083）。

## [2.1.8] - 2026-09-30

### 升級注意事項 (Upgrade Notes)
- **Codex instance 的 app-server 執行期目錄改為私有（#1034）。** 以前每個 instance 的 `CODEX_HOME` 都用連結鏡像 `~/.codex/app-server-daemon` 與 `~/.codex/app-server-control`，所以 Codex 啟動它的 managed daemon 時會失敗（「socket directory path exists and is not a directory」），而且透過連結啟動的 daemon 其實是你自己的那一個、用的是你的設定。升級後第一次啟動只會移除 AgEnD 自己建立的連結（目標完全相符才移除），真正的目錄與你自己建的連結都不動，也絕不碰 `~/.codex`。Session 與 session 資料庫仍然共用。回退版本是安全的：私有目錄會保留，什麼都不刪。

### 新增 (Added)
- **Agent 可以自己挑 persona emoji（#1039）。** 多個 bot 在同一個頻道時，大家在處理過的訊息上都蓋同一個 ✅。`list_emojis` 列出 instance 能用的 emoji：平台接受的標準 emoji，Discord 上再加上 bot 能拿來加反應的伺服器 emoji。`set_persona_emoji` 把自己的 `delivered` 標記（或指定的其他狀態）寫進自己的 `status_emojis` 覆寫，就像 `set_display_name` 設名字。驗證方式和 Settings 相同：Telegram 只能用它的反應集、只能一個 emoji、伺服器 emoji 只能來自 bot 所在的伺服器。內建的 `persona-emoji` skill 教 worker 怎麼挑。ClassicBot instance 沒有 per-instance 標記，工具會直接說明。伺服器 emoji 光看名字和 id 看不出長相，所以 `preview_emojis` 一次最多下載 8 個，每個回傳一個本機圖片路徑，讓 agent 先看過再挑（#1040）。CDN 位址由 fleet 用 bot 可用 emoji 的 id 自己組，不採用 agent 傳入的任何內容，而且只保留小的 PNG。
- **Settings 的 emoji 選擇器列出 bot 能用的每個伺服器（#1021）。** 除了連線本身的伺服器，也列出 bot 所在、且 ClassicBot `allowed_guilds` 允許的其他伺服器，依伺服器分組、主伺服器在前。某個伺服器讀不到時只在該伺服器顯示原因，不影響其他。用其他伺服器的 emoji 加反應，bot 在該頻道需有「使用外部表情符號」權限，選擇器會提示。
- **`/sysinfo` 顯示各 backend CLI 的版本（#1027）**：Claude Code、Codex、Kiro CLI、Grok、Antigravity 與 Muse，資料來自既有的 CLI 環境快取。重新整理期間會繼續顯示舊值，而重新探測在 worker thread 裡執行，慢的 CLI 不會卡住 fleet。

### 修正 (Fixed)
- **閒置 footer 缺少 Context 項目的 Codex instance，訊息大約 10 秒就能送達，不再要 70 秒（#1035）。** 訊息送進 instance 之前，fleet 自己的閒置等待現在也接受與下面 instance 端 fallback 相同的嚴格證據，不會先把整整一分鐘等完。
- **閒置 footer 缺少 Context 項目的 codex instance，不再永遠等不到第一則訊息（#1031）。** 重啟後，codex 有時畫出的閒置輸入框沒有 `Context N% left` 狀態項目（曾在恢復的 session 上看到，footer 只剩 `⚠ 2 warnings · f2 to view`）。重啟後的第一則投遞需要認得的 footer，於是等 30 分鐘、以可重試失敗、再等一次：某個 instance 因此卡著一個排隊中的任務七個小時。現在當唯一缺少的是 footer 時，AgEnD 會改用它原本判斷未知畫面閒置時所用的結構證據，而且全部都要成立：輸入框是空的、沒有忙碌列、排隊中的輸入或已知的選單、畫面上沒有恢復 session 的載入、畫面 10 秒內沒有變化、終端已可接受輸入。使用這個判斷時會記一筆警告。
- **Codex instance 的 session 資料庫是私有的時候，也能恢復自己的對話（#1028）。** 如果某個 instance 第一次啟動時 `~/.codex` 裡還沒有 session 資料庫（例如這台機器上第一個執行 Codex 的就是 AgEnD），Codex 會在該 instance 的 home 裡建立一個私有的資料庫並一直使用它。AgEnD 以前只讀共用 home，讀不到，於是每次重啟都退回 `codex resume --last` 或開新對話，並出現「無法讀取」的警告。現在 AgEnD 會讀該 instance 的 Codex 實際使用的資料庫，只有在 instance 沒有資料庫時才改讀共用的那一個。全程唯讀。
- **Codex 啟動時若開了新對話、而這個工作目錄其實有過對話，現在會明說（#1053）。** resume 查不到對話時，AgEnD 會開新對話，而以前什麼都不說 —「從來沒有對話」和「查詢漏掉了」看起來一模一樣，#1028 就是這樣一直沒被發現。現在啟動時會檢查 Codex 自己的 rollout 檔，看這個目錄有沒有做過至少一輪的互動對話；有的話，會通知該 instance 的 topic：這次開了新對話，以及怎麼接回之前那段（`codex resume <id>`）。從來沒有對話的工作目錄則維持安靜。
- **muse instance 不再因為誤判的登入錯誤，在工作途中被暫停並 `/quit`（#1042）。** muse 的登入錯誤 pattern 會命中單獨的 `401`，而 muse 的 diff 畫面會替每一列編號：只要改到任何檔案的第 401 行，就被當成登入過期，暫停等到這一輪結束，AgEnD 便在 agent 來得及 commit 或回報之前送出 `/quit`（畫面上的「Quit when idle」其實是 muse `/quit` 指令的說明文字）。現在這個 pattern 需要 muse 自己的完整登入錯誤句子，而且不能出現在對話列或 diff 列上。
- **kiro 的 transcript 輪詢不再卡住整個 fleet（#1048）。** 每個 kiro instance 每 2 秒輪詢一次 transcript，而每次輪詢都會開啟 kiro 的對話資料庫（用久了的機器上超過 1 GB），並把該工作目錄的每段對話整個讀一遍，只為了知道有沒有變化。13 個 kiro instance 下，每一輪在 fleet 的 event loop 上要阻塞約 100 ms：Discord 的 `/ctx` 趕不上 3 秒期限、View 無法串流畫面、本機請求要等到 16 秒。現在輪詢只保留一個唯讀連線，並且只從索引與紀錄標頭判斷有沒有變化：同一個資料庫上每輪 0.25 ms。
- **Settings ›「重新啟動 AgEnD」現在會顯示重啟中，且不能重複按（#1024）。** 重啟確實發生了，但按鈕仍可再按、面板在 AgEnD 關閉的當下還顯示「已儲存 —— 重新啟動 AgEnD 才會生效」，也沒有任何東西在等它回來 — 所以使用者一直重按。原因是按鈕把手上「已結束」的舊 job 交給了觀察函式，而它的迴圈只在 job 為 "running" 時執行，於是立刻返回並重畫出一顆新的、可按的按鈕。現在按下的瞬間就會停用按鈕並改成「重啟中…」，只詢問一次確認、只送出一個請求，監看伺服器已改成 "running" 的那個 job，顯示「AgEnD 重新啟動中…」與說明，在伺服器連不上的那幾秒持續輪詢，並在 AgEnD 回來後顯示「變更已套用」並重新整理頁面。被拒絕的重啟會把按鈕還給使用者並說明原因。
- **Settings › Agent 的 啟動 / 停止 / 暫停 / 喚醒 現在會顯示執行中（#1024）。** 這些按鈕以前是送出就不管了（停止失敗不會有任何提示，連按兩次就送兩個請求）。現在請求進行中，該 Agent 的按鈕會被停用、被按的那顆顯示「執行中…」，每個 Agent 同一時間只執行一個動作，失敗也會回報。
- **支援 Codex 0.158 與 0.159；0.159 恢復 session 時投遞會再次等它載入完（#1025）。** 重啟後 Codex 會在輸入真正可用前約一秒就畫出輸入框，AgEnD 會在這段期間暫緩投遞。0.159 把標題改成沒有外框的樣式，而這個暫緩判斷依賴外框，因此在 0.159 上重啟後立刻送出的訊息可能落在載入中。現在兩種標題樣式都能辨識，而且這個暫緩也改為依 AgEnD 自己的啟動狀態判斷，不再只看畫面：只在 AgEnD 啟動的是恢復 session 時才生效，一旦看到載入結束，或畫面 30 秒沒有變化，就停止。因此對話內容引用載入畫面時，不會卡住投遞。AgEnD 也改為以關閉 `features.instant_interrupt` 的方式啟動 Codex：0.159 的這個選用設定會讓新輸入直接改寫進行中的回覆，而不是排在後面。0.159 之前的 Codex 會在啟動警告中列出這個設定「已忽略」，其他沒有影響。0.158 對提權指令預設啟用核准提示，只影響開啟核准的 instance（`--full-auto`，即 `skipPermissions: false`）；預設的啟動方式會略過核准，不受影響。
- **Settings › Connections & Bots 的每一列不再斷字或被裁掉（#1022）。** 自 v2.1.7 起，每一列（bot 類型、id、token 環境變數、群組/guild、存取模式、允許的使用者、token 狀態、連線狀態、設定按鈕）是不換行的 flex 列，所有項目被壓縮並在自己的框內換行 — 「存取模式:」與「設定」在字中間斷開、標籤變成兩行 — 尾端的「Connected」還被卡片裁掉。現在每個項目的文字保持單行，列太長時是在項目之間換行，token 狀態 / 連線狀態 / 設定按鈕這一組會一起留在列尾。很長的值（環境變數名稱、使用者 id）會在任意位置斷開，而不是把列撐寬。只改版面（CSS 與標記），資料與設定按鈕的行為沒有變。已用 Chromium 在 9 種寬度（1280–390 px）與兩種語言下檢查。
- **Settings › 狀態 emoji：預覽的每個值現在都標示來源（#1023）。** 有回報說選了「已收到」與「排隊中」之後，👀「跑到」了「處理中」。實際上什麼都沒有移動，也沒有存錯 — 編輯器把每個值綁在它的狀態名稱上，送出的請求只帶有被選的那些 key（`{"received":…,"queued":…}`）。👀 本來就是「已收到」、「處理中」與「進度前綴」三者的內建值，而以前只有非預設值有標籤，所以留在「處理中」底下的 👀 看起來像是被擠過去的。現在內建值也會在「連線」/「Agent」標籤旁顯示「預設」。新增的回歸測試用頁面真正的編輯器程式碼跑過每一組（兩種順序的）兩項選擇，確認每個值都落在、預覽在、並儲存在它自己的狀態名稱下。

## [2.1.7] - 2026-09-30

### 升級注意事項 (Upgrade Notes)
- **[行為變更] Codex instance 改為恢復自己的對話，不再拿到兄弟 worktree 的（#984）。** Codex 0.157 的 `codex resume --last` 會挑整個 git repo 裡最新的 session，所以同一個 repo 的不同 worktree 上的 AgEnD instance 會互搶 session：對方還在跑時卡在「conversation is open in another app」lock 畫面，否則就默默接著跑對方的對話。現在 AgEnD 會以唯讀方式讀 Codex 的 session 資料庫，對「工作目錄完全相符」的最新 session 執行 `codex resume <id>`。對你的影響：
  - session 都在自己目錄下的 instance，恢復的仍是原本那段對話。
  - 同一個 repo 已有其他 Codex instance 時，**新建**的 instance 會從**新對話**開始，不會繼承兄弟的。
  - 如果讀不到 session 資料庫（例如 Codex 改了 schema）：同 repo 有其他 Codex instance 時開新對話；沒有時退回 `codex resume --last`。兩種情況都會在該 instance 的 topic 發通知。舊對話不會被刪，可以用 `codex resume <id>` 手動接回。
  - 不做任何搬移，AgEnD 也不寫入任何 Codex state。這個版本之前已經被搶走的對話（例如從 lock 畫面按 fork 產生的），Codex 記在哪裡就還在哪裡：重啟受影響的 instance 前，請先確認，並在 Codex 裡把錯誤的 fork 封存。
- **投遞狀態 emoji 可以設定，而且過濾改為依「誰加的反應」判斷（#1005）。** 人加的反應不管用哪個 emoji，都不會再被當成狀態標記吞掉；只有 fleet 自己 bot 的標記會被過濾。沒有設定 `status_emojis` 的 fleet 維持內建的那一組。

### 新增 (Added)
- **投遞狀態 emoji 可以依平台、依 agent 設定（#1005）。** 在連線（`channels[].options`）或 instance 上設定 `status_emojis`，就能指定已收到 / 排隊中 / 處理中 / 已送達 / 失敗 的標記與進度前綴，也能用 Discord 伺服器 emoji（`<:name:id>`）。每個值都依該平台接受的方式檢查 — Telegram 只接受它固定的反應集 — 不能用的值會退回預設並記一筆警告。指示裡「不要用這些 emoji 加反應」的清單也跟著實際生效的那一組。Settings 有 emoji 選擇器，即時預覽由 bot 加反應用的同一套程式解析，並列出用 bot token 取得的伺服器自訂 emoji（無法使用的會顯示，但不能選）。
- **要求回覆的請求會一直追蹤到有回覆為止（#926）。** `requires_reply` 的請求會被持久記錄；逾時沒回覆時會提醒負責的 instance、並告知請求方，不會再默默過期。
- **跨 instance 投遞改走持久化的 outbox（#929）。** instance 之間的訊息在送出前會先寫進磁碟上的 outbox，重啟後會對帳，也可以用 `delivery_status` 查詢（包含靜默排程，它們以 raw paste 的形式寫入）。
- **可以用 message id 驗證同伴送來的訊息（#856）。** 每則投遞的訊息都帶有 id 與內容摘要，`delivery_status` 能確認某則訊息是否真的由 fleet 投遞 — 依另一個 instance 的話做破壞性操作前，就該做這個檢查。
- **`/view` 側欄可以篩選**，用量面板也更好讀（#999）。`agend ls` 會並行收集每一列，不再被單一個慢的 instance 卡住（#997）。Shell 自動補全會說明 `bash <TAB>` 何時無法運作、可以自行安裝，並回報狀態（#1003）。

### 修正 (Fixed)
- **Codex 又能恢復真正的 session 了（#1017）。** 為 #984 加上的「工作目錄完全相符」查詢，只接受 `has_user_event = 1` 的 thread，而真實的 Codex 0.157 session 都沒有這個值，所以每次重啟都默默開了新對話。現在只要 thread 裡跑過任何一輪，就視為可恢復；列表資訊是空的時候，改看 Codex 自己的 rollout 判斷。
- **Codex 的 session lock 畫面與 resume 目錄選擇器不再讓投遞默默卡住（#984）。** 「This conversation is open in another app（r retry / f fork）」畫面和「Working directory · resume」選擇器原本都認不出來，啟動時被當成已就緒，訊息會在 idle gate 等滿 30 分鐘後失敗。現在兩者都會被 hold：投遞維持擋住、通知 operator，AgEnD 絕不會替你按 `r`、`f` 或選擇器的任何選項。
- **fleet instance 裡關掉了 Codex 在 rate limit 時的「切換模型」提示（#1008）**（在每個 instance 的設定寫入 `notice.hide_rate_limit_model_nudge`）；萬一還是出現，畫面仍會被 hold，AgEnD 不會替你回答。
- **Codex 的 Context 狀態項目在 status line 的任何位置都認得，並會確認它真的寫進了 status line（#931、#978）**，寫不進去時會警告；標題是模型推理內容的狀態列，在每條就緒判斷路徑上都視為忙碌（#964）；修正無 context 時的就緒判斷與過期的 capacity 基準（#947、#949）。
- **GitHub 憑證不再出現在 worktree 的 remote 裡（#855、#963）。** worktree 的 remote URL 不再內嵌 token，已經內嵌的會收到提醒。
- **用量在取得失敗時也撐得住（#719）：** 暫時性錯誤會顯示上一次成功的數字，而不是把面板清空；取得與啟動探測都有上限並且只跑一份（#720、#724、#725）。
- **反應：** 投遞狀態 emoji 會取代前一個，不再疊加（#868）；狀態只會新增，只有離開 ❌ 時才移除反應（#972）；加反應也算完成回覆（#877）；漏回覆的補救提示改為「加反應或回覆」（#960）。
- **grok 的每週額度畫面會被 hold**，不會被自動回答（#992）；**muse 的閒置判斷改以實際輸入框為準**（#958）；**fleet 重啟進度的編輯會節流**，遇到 Discord 429 會重試（#965）。

## [2.1.6] - 2026-09-26

### 升級注意事項 (Upgrade Notes)
- **[行為變更] Agent 不再預設拿到所有工具（#804）。** 沒有在 `fleet.yaml` 設定 `tool_set` 的 instance，以前會拿到 AgEnD 全部 47 個工具，包括 `create_instance`、`delete_instance`、`deploy_template` 與 `update_fleet_defaults`。沒有人選擇過這件事，只是「沒設定」就代表這樣。現在預設是 `worker`：能和人、和同伴溝通，能讀所有東西，能做事 — 但沒有任何管理 fleet 的動作。

  **你可能需要做的事。** 真的在協調其他 agent 的 instance — team lead、類似 General 的調度者、任何會重啟或建立其他 agent 的 — 需要在 instance（或 `defaults`）上設定 `tool_set: coordinator`。**升級後第一次啟動時，AgEnD 會告訴你是哪些**：它讀取過去三十天的活動，列出真的用過 worker 不再擁有的工具的 instance，以及用了什麼。只是委派工作的 instance 不在清單上，因為 `delegate_task` 仍屬於 worker，它們什麼都不會失去。

  **不會替你改寫任何東西。** 明確寫著 `tool_set: full` 仍然完全照寫的生效，包括 `defaults.tool_set: full` — 這也表示有這一行的 fleet，在你改掉它之前，所有 agent 都還是拿到所有工具。通知會說明這點，而不會去改你的檔案。

  設定檔的層級是 `worker`（預設）⊂ `coordinator`（手動設定）與 `full`；`standard` 與 `minimal` 不變。`general` 仍是一種身分而不是選項：它來自 `general_topic`，手動寫入仍會被拒絕。

  一個要知道的缺口：General 目前無法替你設定 `tool_set` — 它的 `update_instance_config` 工具沒有這個欄位，值會被默默丟掉。請透過 Settings 或直接編輯 `fleet.yaml` 標示 coordinator（#814）。
- **[行為變更] Codex instance 改用較短的 `CODEX_HOME`（#953）。** Codex 0.157 會在 `CODEX_HOME` 底下建立 socket，名稱很長的 instance 會超過 Unix socket 路徑上限。升級後第一次使用時，每個 instance 的 home 會搬到 `~/.agend/cx/<hash>/`；搬移是自動且可重複執行的。
- **Codex 恢復對話改回使用 `codex resume --last`（#933）。** #913 的「每個 instance 明確指定 session」恢復方式已撤回；它為 Codex 0.155/0.156 做的畫面偵測（#914）則保留。
- **`kiro_ui: v3` 會被拒絕**，直到 kiro 的 v3 介面能無人值守運作為止（#850）：在 kiro-cli 2.23.0 上實測，它會停在一個設定遷移對話框，以及一個預設選項為「No, exit」的信任畫面。
- **切換 agent 的訂閱會開始新的對話（#798）** — kiro 把對話存在和登入資訊同一個 `data.sqlite3` 裡，所以不同的 credential profile 就是另一組對話，沒有東西可以恢復。切換後的第一次啟動會直接略過恢復，而新的 session 會收到舊 session 在做什麼的摘要（回覆會帶有 `conversation_carried_over: false` 與 `handover_chars`）。任何必須原樣保留的內容，請在切換前先在頻道裡說清楚。
- **切換到從未登入過的 credential profile 會被拒絕（#798）** — kiro-cli 不會以未登入狀態啟動，而是停在登入提示等待，agent 會一直卡在登入畫面直到啟動時限用完，然後重啟又回到同一個畫面。錯誤訊息會附上替這個 profile 登入的指令。切回預設登入永遠不會被拒絕。
- **health port 被佔用時，不再直接終止 `fleet.pid` 指到的程序（#792）** — 以前接管時會直接對那個 pid 送訊號，而過期或錯誤的紀錄指到的是現在佔用它的任何程序。現在會先檢查目標的命令列，無法確認就不送訊號。`fleet.lock` 也會記錄是 fleet 還是設定頁持有它，兩者會互相拒絕，而不是其中一方搶走另一方的鎖。
- **Dashboard 與 Settings 的連結現在會把 token 換成 session cookie（#786）** — 開啟連結時會兌換一次 `?token=`，設定 `HttpOnly; SameSite=Strict` 的 cookie，再轉到不含 token 的同一頁，讓憑證不會留在網址列、瀏覽紀錄或任何記錄請求 URL 的 log 裡。`X-Agend-Token` 對腳本與 CLI 仍然有效，但網址上的 token 不再能用來寫入。`agend web-token rotate` 會一次撤銷所有已發出的連結與 cookie。
- **需要完整重啟 AgEnD 的變更變少了（#787）** — 以前每個冷的 fleet 預設值（包括 `backend` 與 `model`，agent 自己重啟就能吸收）都會出現「重新啟動 AgEnD」。現在只限於子系統建構時讀一次的設定（channel 綁定、`health_port`、`defaults.locale`、`cost_guard`、`webhooks`、`daily_summary`，以及 scheduler 啟動時擷取的兩個 scheduler 設定）。
- **自我重啟失敗時，需要再套用一次變更（#789）** — 如果重啟無法啟動，該列會標為失敗，job 也會結束，而不是留著等下一次嘗試。再按一次 Apply 取得新的 job，它的 fleet 列就可以重啟。這是「每個 job 只重啟一次」fail-closed 的那一面：啟動失敗的 job 不能繼續當成可重複使用的重啟按鈕。

### 新增 (Added)
- **工具存取由 fleet 決定，而不是看模型剛好被展示了什麼（#804）。** 進入 AgEnD 工具的每一條路 — MCP 工具清單、直接指名工具的 `tools/call`、直接寫入 instance 的 socket、以及 `POST /agent` — 現在都經過同一張在伺服器端檢查的權限表。以前只有第一條會參考工具清單，所以縮小 instance 的設定檔只省了 token，並沒有真的拒絕任何東西。被拒絕的呼叫會說明 instance 用的是哪個設定檔、以及改做什麼，因為 agent 會把錯誤當成指示來讀。
- **同一個 fleet 現在可以在同一個 backend 上使用多個訂閱（#795–#798）。** instance 帶有 `backend_options.<backend>.credential_profile: <name>`，指定同一個 profile 的 instance 共用一份登入，指定不同 profile 的則各有各的。沒有 profile 的 instance 完全不受影響：啟動參數不會多任何東西、也不會建立任何目錄，所以不使用這個功能的 fleet 不可能受它影響。已在 `kiro-cli` 實作；機制是每個 backend 一筆紀錄（`CREDENTIAL_HOMES`），並不是只為 kiro 設計的。

  profile 放在 `~/.agend/credential-profiles/<backend>/<profile>`，從主機登入一次即可。只有登入資訊會被複製 — kiro 數 GB 的執行環境會用 symlink 連回共用的那一份，所以第二個訂閱只多幾 MB。憑證儲存本身絕不是 symlink，因為 SQLite 會跟著連結開啟目標資料庫，這樣 profile 就又共用了它本來要分開的那份登入。

  General 可以用一般對話建立使用某個訂閱的 agent、或把 agent 在訂閱之間移動，而 `/usage`、`get_usage` 與 dashboard 會**每個訂閱一列**，而不是每個 backend 一列 — `Kiro (work)` 與 `Kiro (personal)` 並排，各自從自己的儲存讀取，絕不相加。已設定但尚未登入的 profile 也會有一列，顯示「已登出」，因為在設定第二個訂閱時，你需要看到的就是這一列。
- **Settings 現在以可追蹤的 job 套用變更（#788）。** `POST /api/settings/apply` 會為每個受影響的 agent 回傳一列，`GET /api/settings/apply/:jobId` 是它的權威來源；job 存在磁碟上，所以會重啟 AgEnD 本身的變更，不會再連答案一起帶走。客戶端在第一次嘗試前就產生冪等鍵，所以回應遺失後的重試會加入原本的 job，而不是把所有東西套用兩次。

  面板可以為只有新程序才能採用的變更重啟 AgEnD 本身（#789），並有自己的確認、自己的冪等鍵，以及寫進磁碟後才會啟動任何東西的頻率限制（每 10 分鐘一次、每小時三次）。重啟會先在聊天頻道公告，無法公告就拒絕，所以面板發起的重啟，絕不會瞞過那些會注意到「不是自己做的」的人。
- **Codex 也可以使用 credential profile（#806）。** Codex 的 profile 只替換 `auth.json`；session、session 資料庫與快取仍然共用，所以切換帳號不必開新對話。`/usage` 會把 `Codex (work)` 與 `Codex (personal)` 分成兩列。
- **支援 Meta Muse Code backend（`backend: muse`，#827）。** 每個 instance 有自己的 MCP 設定（#903），muse 的訂閱用量會從它的回應串流轉到 `/usage`（#894）。
- **Settings 面板改版（#785–#792）。** 改成列 + modal、進階抽屜與全域搜尋；四步驟的引導式 quickstart；有安全接管與鎖定的 fleet 前置設定頁；頁面存取改用 HttpOnly session cookie，並加上 Origin 檢查與 token 輪替。連線可以安全地輪替 bot token（#864）、重新綁定到經過驗證的 guild 或群組（#870），provider API key 儲存前會先驗證（#873）。
- **可以透過 cloudflared tunnel 從手機開啟設定頁（#799–#803）。** 每一次開 tunnel 都要在終端上個別確認 — 沒有任何旗標、環境變數或設定能事先回答 — 警告會說明哪些內容會經過 Cloudflare。沒有 cloudflared 時，指令會直接說明並提供本機替代方案。
- **Discord bot 的狀態列會顯示用量（#866）**，會主動更新、依 adapter 分開、並以精簡格式顯示（#891、#901、#921）。`/model` 有「🔄 重新整理模型」項目（#887）；Claude Code 的用量上限暫停會附上自動恢復時間回報（#820）；`/ctx` 會顯示自動暫停設定與暫停狀態（#952）；daemon 會記錄 CLI 為什麼結束、以及是不是 AgEnD 停掉的（#942）。每個 instance 現在都能管理自己的排程；替別人排程仍限 coordinator（#896）。文件網站改用 Astro Starlight，提供英文與繁體中文（#825、#832）。

### 修正 (Fixed)
- **支援 Codex 0.155、0.156 與 0.157（#914、#953）。** 能辨識它們的畫面版型，啟動時的資料夾信任提示也會安全處理（#919）。
- **Codex 用量上限：** 用量上限選單會自動選「Continue with Luna Reserve」，之後畫面也會保持存活（#945、#940）；第一則投遞會等 reserve 穩定下來（#941）；用量即使在 0% 也會顯示為「Luna Reserve」（#937）；模型容量錯誤會退避並重啟，而不是暫停 instance（#905）。
- **Codex：** 會把 Context 項目注入 key 有加引號的 status line 設定（#931）；喚醒期間不再出現誤報的投遞失敗（#918）。
- **kiro：** 第一則投遞會維持待處理，直到確認送出（#934）；fleet 停止前會先等忙碌中的那一輪結束（#938）；模型無法使用的選擇器會被 hold 並升級通知（#925）。
- **muse：** 閒置判斷不再被 muse 的週期性重繪擋住（#932）；會送出 muse 要求的第二個 Enter（#831）；在視窗仍存在時保留閒置時的用量快照（並標記為過期）（#904）；用量 relay 在復原次數用盡時會直接恢復並通知（#899）。
- **Claude Code 的危險指令對話框會自我修復：** 自動拒絕並通知 agent（#881）。
- **投遞與回覆：** 恢復 session 的等待改以進度衡量，而不是牆上時間（#869）；過晚的取消按鈕會被收回（#784），關機時也會收回已啟用的提示（#840）；被拒絕的附件會告訴 agent 該怎麼送（#885），回覆會回報帶著附件的那些訊息 id（#836）；Discord 截斷時會保留 markdown 程式碼區塊（#838）；tmux `load-buffer` 暫時失敗會重試（#841）。
- **設定與存取：** 狀態檔覆蓋 `fleet.yaml` 的存取設定時會說明（#833）；排程會保留建立時的回覆 adapter（#844），遇到非字串的 target 或 id 會拒絕而不是當掉（#898）；`list_models` 遵守 CLI 環境一小時的新鮮度（#902）；onboarding 會保留安裝結果並找出可登入的 backend（#859）；Kiro Pro 顯示為無限（#892）；Codex 用量來源分開、無法取得的狀態列會隱藏（#875）；所有 logger 共用同一個 pino transport（#845）。

## [2.1.5] - 2026-09-16

### 升級注意事項 (Upgrade Notes)
- **`allowed_users` 為空時，`/restart full` 改為 fail-closed** — 以前 fleet.yaml 裡空的 `allowed_users` 清單會允許任何使用者執行管理操作。這個版本把空清單視為「沒有人被允許」，必須明確填入允許清單。如果你依賴管理指令，升級前請先檢查 fleet.yaml（#726）。
- **多 adapter 的 fleet：回覆上下文需要綁定 adapter** — 在同時執行多個頻道 adapter 的 fleet（例如 Telegram + Discord）裡，如果 `last-chat.json` 是舊版本寫的、沒有 `adapterId` 欄位，重啟後的第一則回覆會以「no adapter bound」失敗，直到有一則收到的訊息重新建立綁定為止。這是刻意的：失敗比把 chat id 送進錯誤平台的 bot 安全。只有單一 adapter 的 fleet 不受影響（#752）。
- **[行為變更] 可讀取畫面的 backend 遇到無法驗證的投遞時改為失敗** — 當無法證明投遞已經離開輸入列（基準確認失敗三次，且沒有偵測到唯一特徵）時，daemon 會回報 ❌，而不是靠輸出訊號去猜 ✅。原則是「寧可失敗也不要猜」— 使用者看得到失敗，也可以重試。這影響 Codex 與 Kiro；Claude Code 與 Antigravity 有可靠的送出訊號，不受影響（#757、#759）。
- **[行為變更] topic 消失會觸發隔離，而不是刪除** — 當 Discord gateway 中斷或 channelDelete 事件讓某個 topic 看起來不見了，daemon 現在會隔離該 instance（撤銷它的路由、保留所有資料），而不是自動刪除 instance 與它的 worktree。破壞性的移除需要透過 dashboard 的確認對話框或 `delete_instance` 工具明確授權。這可以避免 adapter 暫時斷線時的資料遺失（#765、#766、#767）。
- **Classic 的冷欄位仍需要重啟** — 新的 fleet 層級行為開關（`tool_progress`、`reply_completion_guard`）會即時套用到 fleet topic 與已存在的 Classic 頻道。但 ClassicBot 的「冷」欄位 — `backend`、`model`、`effort` 與 `working_directory` — 仍需要重啟 instance（或 `/stop` + `/start`）才會生效；只送 SIGHUP 不會重啟 Classic instance。這和以前的行為一致，也避免在對話途中切換 backend（#775）。

### 新增 (Added)
2.1.4 推出的 `/login` 斜線指令在這個版本有大幅強化。登入現在在有 token 保護的網頁終端裡進行，為所有 backend 提供安全的瀏覽器登入流程。Codex 在無頭環境使用 device-auth 模式。登入成功後，系統會立即回報結果，不必等 instance 重啟，而重啟也會帶著看得見的期限，讓使用者知道 fleet 什麼時候會回來。認證失敗的警告旁邊現在會有一個內嵌的「重新登入」按鈕，operator 點一下就能修好過期的憑證，不必手動輸入指令（#715、#717、#729、#733、#748）。

新的 `/install-cli` 指令讓 operator 可以遠端安裝 CLI backend，而 ClassicBot instance 在 backend 登入後會自動恢復，不再需要手動介入（#733）。

`/ctx` 指令現在會在模型旁顯示設定的推理強度（#738）。`list_instances` MCP 工具改為漸進式揭露：第一次回應顯示精簡的 fleet 摘要，依 backend、狀態與標籤計數，並說明如何深入查詢。查詢參數（`tags`、`backend`、`status`、`name`）可以篩選清單，`describe_instance` 則回傳單一 instance 的完整資訊。有的話會包含 Claude Code 的即時模型（從 statusline 讀取），而 `get_instance_logs` 預設最多 200 行，避免失控地消耗 context（#740）。

網頁 dashboard 現在顯示更豐富的 instance 資訊。詳細頁標題與側欄的滑鼠提示會顯示即時模型（與 `/ctx` 的解析一致）、帶有「(configured)」標記的設定強度、backend，以及有設定時的 instance 顯示名稱。`/ui/instance/:name` 與 `/api/profiles` 端點新增 `model_source`、`effort_source`、`context_pct` 與 `display_name` 欄位，讓外部工具能分辨即時值與設定值（#762、#764、#770）。

`/restart full` 可以從聊天中完整重新載入程序，能感知服務管理並且只跑一份。systemd 交接逾時的結果現在會被正確追蹤，重新載入也會與獨立的更新互相隔開，所以進行中的 `agend update` 不會與它競爭（#726）。

Settings 與 fleet.yaml 現在開放兩個 fleet 層級的行為開關。`tool_progress` 控制工作中的訊息泡泡是否在工具執行時列出它們（預設關閉；設為 `standard` 顯示語意標籤，`verbose` 顯示指令預覽）。`reply_completion_guard` 啟用 #750 的漏回覆保護；預設為 `true`，如果干擾某個特定工作流程，可以依 instance 關閉。兩個開關都依照其他 Classic 設定使用的同一條鏈解析：channel → classicBot 預設 → fleet 預設 → 硬性預設，並可透過 SIGHUP 或 Settings 編輯即時套用，不需要重啟（#775）。

### 修正 (Fixed)
這個版本處理了幾個會讓使用者訊息無聲消失、而且沒有錯誤的情況。

**[P0 資料遺失修正] Discord gateway 中斷可能會毀掉 instance 與 worktree。** adapter 暫時斷線時，topic 清理輪詢與 `channelDelete` 處理器把不見的 topic 誤判為永久刪除，於是自動移除 instance、刪除它的 git worktree 並改寫 fleet.yaml — 即使那個 topic 在 Discord 上其實還在。在找到這個 bug 之前，一位使用者失去了 8 個 instance 與 2 個 worktree。修正是 fail-closed：adapter 的拓撲探測現在回傳三種狀態（存在 / 不見 / 不確定），而「不見」需要 provider 提供正面證據。清理動作使用擁有該 topic 的 adapter、只跑一份的快照，以及世代隔離；大量「不見」的結果會觸發斷路器。自動的 topic 不見與 channelDelete 處理現在只做非破壞性的隔離（撤銷路由、保留一切）。破壞性的 `removeInstance` 與 worktree 刪除需要一個無法偽造的授權 token，只有 dashboard 的確認對話框或 `delete_instance` 能發出（#765、#766、#767）。**這個 bug 也影響 v2.1.4。**

**Codex 在重啟或喚醒後，第一則投遞會卡住。** 重啟或喚醒後，第一則訊息可能被 CLI 的畫面重繪吞掉，daemon 卻回報 ✅。根本原因是 Enter 被重繪吸收了，而 daemon 相信了一個其實並不對應真正送出的輸出訊號。修正是把送出驗證綁定到 backend 的能力：可讀取畫面的 backend 必須正面證明文字已經離開輸入列。新的 `InputUnavailableTransient` 能力處理 Codex 0.154.0 的 `Resuming session…` 暫態期間，這段時間裡 Enter 會被吸收。四道關卡加上世代隔離，確保 CLI 真的準備好接收輸入之前，不會確認任何投遞（#757、#759、#760、#761）。

Kiro 的就緒狀態偵測現在能區分 transcript 殘留與真的卡在輸入列的文字，消除了訊息其實已送出卻回報 ❌ 的誤報（#736）。Kiro CLI 2.14+ 會在提示符前以方括號印出 agent 名稱（例如 `[Agent Name] ❯`）；偵測器現在認得這個格式（#746）。Kiro session 的 token 過期時，CLI 會退回登入畫面。AgEnD 現在以結構（而不只是關鍵字）偵測這個畫面，並在後續探測通過時撤回認證疑慮旗標。誤判這個畫面會壓下 hang 通知並停用 MCP 自動重啟 —**不會**擋住投遞 — 所以這個修正是恢復監控的正確性，而不是解開某條投遞路徑（#746、#747）。

Codex 可能在訊息根本沒送出時回報投遞成功。根本原因是輸入列快照與實際貼上之間的競爭：daemon 在輸入區看到文字，就以為已經送出並回報成功。修正把送出證據綁定到那一次特定的貼上，並明確送出任何卡住的文字，而不是重新貼上。此外，Codex 的更新選擇器佔用畫面時會暫緩投遞，而仍留在輸入列的訊息絕不會被確認為已送達（#745）。

啟動逾時不再放棄 session。以前 instance 啟動太久時，daemon 會放棄並建立新的 session，默默丟掉對話歷史。現在 session 會被保留並改名，以便手動恢復（#737）。

現在能偵測 Claude Code 結束一輪卻沒有得到平台確認的回覆。發生時，daemon 會發出中性的狀態訊息（「agent 沒有回覆；重試一次」），並注入一次性的補救提示，要求模型送出它的結論。如果補救的那一輪也沒送出回覆，這一輪會以明確的「未恢復的漏回覆」通知結束，而不是默默遺失。這處理了 #664、#662 與 #649 的根本原因（#750）。

`/model` 指令現在會重新探測過期的 CLI 環境，新發布的模型不必冷啟動就會出現（#721）。`/update` 指令保證最終進度會送達，修正最後狀態訊息遺失的情況（#722）。某個 provider 很慢時，用量面板不再卡住；每個廠商的收集各自有上限（#718）。

修正兩個通知 bug：fleet 層級的通知現在會發到頻道，而不是默默失敗；排程的通知會正確送回它的來源聊天（#732）。暖機重載通知不再叫一個正在恢復重載的 backend 重新載入它的指示（#727）。網頁終端現在發出帶結尾斜線的路徑，讓相對路徑的資源能正確解析（#729）。一個不穩定的網頁終端整合測試已經穩定下來（#742）。

跨頻道世界的訊息路由已經強化。當排程觸發、而它的回覆座標屬於另一個頻道世界時 — 例如在 Telegram 群組建立、目標是 Discord instance 的排程 — 那些座標不再被設為目標 instance 的回覆上下文。以前這會讓 instance 之後每一則頻道回覆都用 Telegram 的 chat id 送到 Discord，連續幾十分鐘產生「Unknown Channel」錯誤，直到有一則真的使用者訊息覆寫掉過期的上下文。此外，Discord adapter 收到明顯屬於其他平台的 chat id（代表 Telegram 群組的負數，或短到不可能是 Discord snowflake 的數字）時，現在會回傳明確的錯誤，而不是含糊的 `10003 Unknown Channel`。在沒有指定世界的多 adapter 設定裡，系統現在會回報路由錯誤，而不是猜第一個可用的 adapter（#752、#753）。

dashboard 與 `/view` 的側欄現在以原始 instance 名稱作為主要標籤，顯示名稱（不同時）作為下方的第二行。以前顯示名稱會完全取代 instance 名稱，失去了用來對照 fleet.yaml 與 log 的穩定識別。兩行各自截斷，而且這只是視覺上的變更 — 排序、點擊目標與 API 內容都不受影響（#774）。

## [2.1.4] - 2026-09-07

### 升級注意事項 (Upgrade Notes)
- **fleet.yaml 自動精簡是「繼承」而非「刪除」** — 從 instance config 移除的欄位現在會跟著 `defaults` 走。日後改預設值也會改到這些 instance。
- **Owner-adapter fail-closed** — 當擁有某 topic 的 adapter 停止服務時，該 topic 的 inbound 存取會 fail-closed（會記 warn log）。以前其他 adapter 可能會接走這則訊息。
- **`/login` 尚未支援 Org SSO** — `/login` 指令是 beta；organization SSO 流程是已知限制。

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
- **ClassicBot Yes/No 按鈕** — 存取請求現在會顯示行內「是／否」按鈕供審核，取代純文字流程（#690）。
- **`/sysinfo` fleet 摘要** — 顯示 instance 數量（running/paused）、fleet 記憶體與系統記憶體。平台感知格式：Telegram 用 markdown 表格、Discord 用純文字。摘要分成多行以適合手機閱讀（#695、#696、#697）。
- **`/install-cli` 後端選單** — 不帶參數的 `/install-cli` 現在顯示後端選單，而非報錯（#687）。
- **跨 instance steer** — `delegate_task` 與 `send_to_instance` 可使用 `steer: true` 在目標 instance 的當前輪次中插入補充訊息（#701）。
- **Antigravity 問卷與模型發現** — 處理問卷提示並解析 TSV 模型清單（#683）。
- **`/sysinfo` 資源區塊** — 新增文件、提示與 GitHub 連結（#679）。
- **Session 管理 skill** — 新 General skill 記錄跨後端 session 管理與 Kiro SQLite 恢復（#684、#685）。
- **用量 i18n** — AI 用量顯示已在地化；zh-TW 時長／綁定／額度重置潤飾（#665、#675）。
- **Codex 容量偵測** — 偵測並回報模型容量錯誤（#666）。
- **跨 instance 訊息大小上限** — 超大訊息（預設 >12KB）會被清楚拒絕，而非被默默截斷（#671）。

### 修正 (Fixed)（續，beta.36–57）
- **ClassicBot 白名單比較** — ID 現在以字串比較，修正 JavaScript 數字精度在大型 Discord snowflake 上的誤判。無法匹配的 ID 會在啟動時通知管理員（#691、#692）。
- **Fleet 錯誤通知** — 無法投遞的 fleet 錯誤不再讓通知佇列靜默十分鐘（#693）。
- **tmux 貼上緩衝區 flake** — 大型貼上與截斷貼上的測試隔離（#694）。
- **Discord code-fence 斷裂** — 跨 instance 預覽與分段發送不再產生懸空的 code fence（#698）。
- **Classic 跨 instance 回覆** — Classic instance 現在可以回覆跨 instance 的工作請求（#699）。
- **Kiro 投遞安全** — 停止向忙碌但安靜的 Kiro pane 貼上、驗證提交、恢復滯留文字。Enter-drop gate 不再有 fail-open 漏洞；空白／無法讀取的 pane 永遠不能證明就緒（#686、#688）。
- **Kiro 啟動韌性** — 多輪強化：處置被拒絕的 daemon、序列化 outage 交接、wake 預算、unattended 啟動的延遲重試、20 分鐘 outage 記憶與正向清除（#689）。
- **tmux storm 韌性** — 協調 tmux storm 期間的恢復；保留投遞與 window crash 分類（#674）。
- **Discord gateway 自癒** — 偵測停滯的 gateway 並觸發重連；保留原生 resume 恢復；公開聚合心跳健康（#673、#676）。
- **Tips 按鈕 Telegram** — 正規化 Telegram 按鈕 context 以正確路由（#682）。
- **用量顯示精簡** — 隱藏未使用的 scoped limit（#681）。
- **Kiro CLI 版本旗標** — 依 CLI 版本決定啟動旗標；記憶化相容性探測（#680）。
- **MCP 替換恢復** — CLI 替換的 MCP server 不再重啟健康的 instance；替換寬限期結束時重新檢查閒置 gate（#663、#668）。
- **網路 family timeout** — 保留較長的網路嘗試覆寫；修正 Telegram 過期 socket 處理（#658、#659、#660）。
- **CLI help 一致性** — help 輸出現在一致且最新（#661）。
- **Claude Code 信任/投遞強化** — 偵測畸形 tool-call 片段並嘗試回覆恢復；偵測模型 fallback 並在 `/ctx` 顯示 statusline 的即時模型；強化 claude.json 更新並偵測 corrupt-config modal；停在致命啟動畫面時阻擋投遞；收緊錯誤 pattern（#648、#650、#651、#652、#653、#654、#655、#656）。
- **Codex 更新提示** — 阻止「Update available!」提示阻擋啟動（#657）。

### 修正 (Fixed)（續，beta.60–63）
- **`agend health` paused 分類** — paused instance 不再被誤報為「Tmux window missing / degraded」。Paused 狀態現在有獨立計數（`N healthy, M issues, K stopped, P paused`），不會讓 fleet 進入 degraded（#704）。
- **Webhook 投遞確定性** — webhook 現在由 per-instance 的 primary adapter 決定性接走，多 adapter 設定不再因搶走 webhook 而遺失（#707）。
- **Inbound 存取由 owner adapter 判定** — 存取檢查由擁有該 topic 的 adapter 執行（在認領前）。**當 owner adapter 停止服務時，該 topic 的 inbound 會 fail-closed**（會記 warn log）。避免訊息被錯誤的 adapter 接受（#710）。
- **Claude resume 對話框 fail-safe** — 重啟時「Resume from summary」對話框永不被投遞訊息，杜絕誤選 resume 造成的靜默 context 丟失（#711）。
- **MCP 假死修正** — 多 MCP 進程（Codex 子 agent／Claude subagent）不再因單槽 PID 追蹤導致假 "MCP died" 報告。改用 IPC 層可達性判定；恢復時清除通知（#712）。
- **`/login` 與 `/install-cli` 標記 beta** — 這些指令在 help 與指令選單中標示為 beta（#713）。

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
