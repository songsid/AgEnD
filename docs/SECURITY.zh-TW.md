# 安全考量 (Security Considerations)

透過 Telegram 或 Discord 遠端操作 coding agent，等於讓聊天室參與者能要求主機執行動作。AgEnD 的聊天權限、MCP 工具權限與 HTTP 憑證各自保護不同入口；它們不會把 coding CLI 關進沙箱。

以下路徑使用預設資料目錄 `~/.agend`；可透過 `AGEND_HOME` 指定其他目錄。

## 威脅模型

AgEnD 防範的對象：
- 遠端的人；
- 同一台電腦上的其他使用者（其他作業系統帳號）；
- 透過公開連結或 gateway 進來的訪客；
- 網頁訪客（guest）；
- 擁有者瀏覽器裡其他網頁發出的跨站請求（CSRF）。

和 fleet **同一個作業系統使用者**執行的程式，視為擁有者本人（fleet 決議 64a289a0、#3327）。這種程式本來就能讀 `~/.agend/web.token`、修改 `fleet.yaml`、讀取憑證、直接執行各個 CLI，所以只擋住某一條 HTTP 路徑並不會帶來真正的保護。不該擁有擁有者權限的東西，請用另一個作業系統使用者或隔離的容器執行。

在這個模型裡，AgEnD 仍然讓敏感步驟走「真人操作」的路徑，作為縱深防禦，而且不增加點擊：
- **主機的登入碼**：`agend web` 使用的 `/auth/issue-code`，只回應來自這台電腦本身的直接請求：loopback 連線、loopback Host，而且沒有轉送標頭。從別處或透過 proxy 使用 web token，無法產生儀表板 session。印出來的登入碼仍可在任何地方的瀏覽器輸入。
- **配對電腦**：產生配對碼和核准電腦，需要直接連到的儀表板上的管理員 session，包含它的 cookie 與 CSRF 值，也就是頁面上原本的「連接電腦」和「核准電腦」按鈕。只帶 `X-Agend-Token` 標頭的請求會被拒絕。
- **開啟遠端執行環境**：這是需要確認的 Settings 變更，單憑 token 無法提出。
- **純網頁 fleet**：主機操作者就是擁有者（決議 28c2d3a3）。驗證器 App 被重新設定或移除時，會發出通知（Notices），讓擁有者察覺不是自己做的變更。

## 聊天存取與管理權限

獲准進入的使用者可以要求 agent 讀檔、改程式或執行指令，實際可做的動作由後端權限決定。請把這些使用者、他們的帳號，以及獲准進入的 bot，都視為能接觸 agent 工作區與主機的可信對象。

- 要限制 fleet 聊天存取，請明確設定 `access.mode: locked`，並縮小 `allowed_users` 名單。**整段 `access` 省略時，執行時會回退到 open。**
- 已持久化的存取模式優先於 YAML；持久化與 YAML 的使用者名單取聯集。只從 YAML 刪除使用者，不一定會撤銷權限。見[設定參考](configuration.zh-TW.md#channelaccess)。
- Fleet 管理員必須明列在目標 instance 所屬 adapter 的 YAML `allowed_users`（沒有目標時為呼叫來源的 adapter）中。Open 模式或配對核准本身不會授予這個身分。ClassicBot 有自己的管理員與聊天允許名單；見[權限表](permissions.md)。
- 啟用帳號兩步驟驗證並保護 bot token。伺服器會對 AgEnD 操作執行 `tool_set` 限制，但這不限制後端自己的 shell、檔案或網路工具。

## 繞過權限 (`skipPermissions`)

對 Claude Code，**預設會繞過權限提示**：除非明確設定 `skipPermissions: false`，AgEnD 都會傳入 `--dangerously-skip-permissions`。這個旗標會繞過 Claude 的工具權限提示，因此獲准進入的聊天請求可能直接觸發主機動作，不再逐項詢問。

設定 `skipPermissions: false` 可移除這個旗標，改用 Claude Code 自己的權限設定。AgEnD **不會**生成 shell 允許名單或危險指令拒絕名單。請在 CLI 支援的使用者／專案設定中配置限制；若需要主機層級的邊界，請使用作業系統隔離。

每個 instance 的 `claude-settings.json` 都會在啟動時重新生成，內容包含狀態列，以及適用時的繞過權限警告確認。不要把手動修改這個生成檔當成持久的安全政策。

## 工具組與共用主機帳號

`tool_set` 是針對 AgEnD 所辨識 instance 身分的政策防護。MCP、直接 IPC
與 agent HTTP 入口都會拒絕該身分不能使用的操作。它**不是同 uid、具有 shell
能力的 agent 之間的安全邊界**：這類 agent 能讀取另一個 instance 的
`agent.token` 或連上它的 `channel.sock`，冒用其身分與工具權限，包括
coordinator 的權限。`0600` 無法區分檔案擁有者的不同程序；每次 spawn
換 token 也不會改變這件事。請把同帳號 agent 視為互相信任；需要隔離權限時，
必須使用不同 OS 使用者或妥善隔離的容器。

## IPC Socket

Daemon 透過 `~/.agend/instances/<name>/channel.sock` 與 AgEnD MCP bridge 通訊。AgEnD 使用限制性的 umask，並嘗試將 socket 設為 `0600`。私有 instance 目錄以 `0700` 建立，符合條件的既有目錄也會收緊權限。**沒有共享金鑰握手**。這些檔案權限用來區隔 Unix 使用者，無法認證或隔離同 UID 的行程，也無法防範 root。請留意無法限制權限的警告。

## Dashboard 登入與瀏覽器 session

能通過本機 dashboard 授權閘門的憑證有兩種，兩者都不會出現在網址裡：

- **`X-Agend-Token`**：fleet 共用的 bearer token，存於 `~/.agend/web.token`（建立時權限為 `0600`；既有檔案的權限收緊採盡力處理）。CLI 與腳本以 header 送出。fleet 重啟後仍保留。`agend web-token rotate` 會替換它，同時讓所有瀏覽器登出（見下方）。輪換不代表能撤回已獲授權的請求，或關閉所有既有連線。
- **瀏覽器 session**：以**一次性登入碼**登入後取得。fleet 管理員用 `/web` 取得登入碼：General 選單只以私訊送出；Discord 可改用確認送達的 ephemeral 回覆，Telegram 私訊失敗則請管理員先私訊 bot 的 `/start`。在主機上，`agend web` 會用 header token 印出一組。登入碼為 8 個字元，**只能用一次**、**5 分鐘**後失效，而且只有最新的一組有效。這個 fleet 從未授權過任何主機 session 之前（新安裝——以持久化的標記判斷，登出或過期都不會讓它回來），`agend web --code` 在互動式終端機印出的第一組登入碼，改為自第一組發出起 **60 分鐘**有效（#3270）：只能從這台電腦兌換（公開連結、LAN 主機名稱、經轉發的代理一律不行），第一個主機 session 一建立就失效。它只印在要求它的那個終端機上，不會出現在其他地方：不會進管線、轉向、安裝記錄或服務的 journal（`agend web` 會說明 stdout 是不是終端機；沒有說明的呼叫端拿到的是一般的 5 分鐘登入碼），fleet 也絕不會把登入碼寫進 log。WSL 上絕不發放（使用者的 Windows 行程對 fleet 而言就是 loopback，而且讀得到這個 distro 的檔案）。WSL 上，以及第一個小時過後，所有登入碼都是 5 分鐘。`agend web` 以 AgEnD 家目錄裡權限 `0600` 的啟動檔（以 `wx` 建立在 `0700` 目錄中，兩分鐘後刪除）開啟瀏覽器、由它導向 `/signin#code=…`，登入碼不會出現在任何行程的命令列；放進網址的登入碼一律維持 5 分鐘。終端機每次也都會印出乾淨的網址和登入碼，因為以 Snap 或 Flatpak 安裝的瀏覽器讀不到家目錄隱藏資料夾裡的啟動檔：請打開該網址並輸入登入碼。`#` 之後不會送到伺服器；登入頁在發出任何請求前把它從網址列移除，且只在 `localhost`、`127.0.0.1`、`[::1]`、全新導覽、瀏覽器尚無 session 時兌換。輸錯五次會讓該組登入碼作廢（從這台電腦以外輸錯，不會讓 bootstrap 登入碼作廢）；15 分鐘內（跨不同登入碼）累計輸錯 20 次，會暫停所有登入 5 分鐘。沒有發出任何登入碼時，就沒有東西可猜。本機登入會在 General 公告（`web.notify_login`，預設開啟）；公開登入不論此設定，都必須確認通知送達。

網址裡的 `?token=` **不是**憑證，舊連結與書籤也一樣：它會進到登入頁，token 會從網址列移除。

關於 session：

- Cookie 是隨機產生、與 `web.token` 和登入碼都無關的 256-bit id。伺服器的 session 紀錄只保存它的 SHA-256，並寫入 `~/.agend/web-sessions.json`，所以儲存的紀錄或這個檔案都無法拿來冒充 cookie。原始 id 仍會經過行程：建立 session 時（`Set-Cookie`），以及每個帶著 cookie 的請求。最多保留 8 個 session，超過時會丟掉最久沒用的一個。
- 到期由**伺服器**強制執行：預設為登入後 48 小時，或 48 小時沒有使用，以先到者為準（直接連到 dashboard 時可用 `web.session.local.*` 設在 1 到 720 小時之間；公開連結的 session 期限固定；改短的設定也會結束已超過新期限的 session）。使用指的是人的操作：打開頁面、讀取聊天紀錄、任何變更。頁面自己定時發出的讀取會完整檢查授權，但不算使用：dashboard 的即時串流（`GET /ui/events`，重新連線也一樣）與備援輪詢（`GET /ui/poll`），以及在 `web.view_access: session` 時 `/view` 的終端（`GET /api/pane/<instance>`）、名單（`GET /api/profiles`）與用量面板（`GET /api/ai-usage`）。這份清單由伺服器依 method 與路徑固定，請求無法自行宣稱是被動的。所以開著不管的分頁不會讓 session 一直有效（#1373）。Cookie 的 `Max-Age` 只是讓瀏覽器在同一時間忘掉它。Session 在 fleet 重啟後仍有效。
- Cookie 屬性為 `HttpOnly`、`SameSite=Strict`、`Path=/`。本機 listener 的 `X-Forwarded-Proto` 顯示 HTTPS 時，名稱改為 `__Host-agend_session` 並加上 `Secure`；遠端存取請使用 TLS。受管理的公開 cookie 一律 Secure，由 listener 指定的脈絡決定，不依賴 forwarded header。
- **只靠 cookie 授權的寫入**，還必須帶與 `Host` 相同的 `Origin`、瀏覽器有送 `Sec-Fetch-Site` 時其值為 `same-origin`，以及該 session 專屬的 `X-Agend-CSRF` 值。光有 cookie 什麼都改不了。本機 header-token 請求不需 cookie 的 CSRF 與 Fetch-Site 檢查，也可省略 Origin；但有提供 Origin 時，仍必須符合 Host。網頁無法讓瀏覽器自動加上 token header。
- 所有受保護路由都會拒絕 host／port 與 `Host` 不同（或無法解析，例如 `null`）的 `Origin`。沒有 `Origin` 的讀取，只要憑證有效仍可通過。
- **撤銷**：Session 選單可登出單一裝置或所有裝置；`/web revoke` 讓所有瀏覽器登出並作廢尚未使用的登入碼；`agend web-token rotate` 讓所有在舊 token 下建立的 session 在下一次請求時失效，不需重啟。
- **回訪裝置（#1570）**：用 `/web` 私送的登入碼登入時，會另外設定第二個 cookie `agend_device`（https 與公開連結上為 `__Host-agend_device`；`HttpOnly`、`SameSite=Strict`、90 天）。它的值是隨機 128-bit id 加上以 `web.token` 推導金鑰的 HMAC，不含任何聊天或使用者 id。`~/.agend/web-devices.json`（`0600`）只存 id 的 SHA-256、收到那組碼的擁有者與 token epoch。只有這種瀏覽器能在登入頁要求新的登入碼（`POST /auth/request-code`，必須帶 `Origin`）。fleet 會重新確認擁有者仍是該 bot 與 General 的 fleet 管理員，並只以私訊送出（絕不發到群組，也沒有替代管道）；私訊會寫出瀏覽器與來源。限制：每個裝置每分鐘 1 次、每小時 5 次；整個 fleet 每 20 秒 1 次、每小時 20 次（單調時鐘）；輸錯碼的斷路器開啟時一律拒絕。公開連結的要求必須屬於目前開啟中的 exposure，碼只限該 exposure 使用，登入仍需確認公開通知送達。`/web revoke` 會清空登錄，`agend web-token rotate` 會讓所有裝置 cookie 失效（HMAC 金鑰與 epoch 都會改變）。

這是共用的操作員憑證，不是個別使用者帳號或角色系統。`/web` 需要 fleet 管理員，但任何持有登入碼、session 或 header token 的人都能使用；本機 HTTP 操作不會逐次重查聊天允許名單。公開請求還必須確認發碼者的權限／綁定與入口仍有效。登入碼在用掉之前請視同密碼；選單的碼只會私送。

## 臨時公開 gateway 與本機讀取

所屬 adapter 的 General 管理員明確點選後，才開受管理的公開連結，預設兩小時（可設 1–480 分鐘，從同意起固定期限；固定 named tunnel 網域時最多 10080 分鐘或不到期，並可選擇 `auto_open`，在重啟後替上次開啟的管理員重開，但不送出任何登入碼）。只用固定版本／checksum 驗證的 cloudflared，與 `/login` 共用單一 tunnel 名額。獨立 listener 使用程式指定的來源脈絡，不信任 proxy header。只接受當前完整 HTTPS Host 與核准面板路由，不在本機 Host 清單加 wildcard。即使本機讀取開放，公開 `/view` 與用量仍要登入；不暴露 health、agent、發碼、SSE、preview 或舊 restart API。

每種連線方式（直接連線、臨時公開連結、固定的 named tunnel 網址）各自允許什麼，請逐項看[三種連線方式比較](web-dashboard.zh-TW.md#三種連線方式比較)。

公開 cookie 為 Secure `__Host-`，綁定單次入口。 Gateway 拒絕本機 header token、cookie 與碼；公開碼與 session 都綁定單次入口。公開 session 限四小時／閒置 30 分鐘，入口較早關閉也會使其失效。每次公開登入都須在五秒內確認所屬 General 收到 🔐 公開通知，不受 `notify_login` 影響；確認前候選 session 不可用也不持久化。登入碼外洩仍可授予完整 web-admin 權限。Cloudflare 終止 TLS；光轉傳連結不會登入，但會暴露端點供猜碼、耗盡共用 breaker。完整 Origin 與 CSRF 保護瀏覽器寫入；Host 檢查不是身分認證。到期、停用、私送關閉、revoke、owner／binding 失效與 shutdown 都先關存取、撤回公開憑證，再清子行程；無法確認停止時封鎖下一條 tunnel。

**透過管理員固定網域的網頁授權（#2453），需自行開啟，預設關閉。** `web.verified_authority.named_link: true` 讓管理員自己 named tunnel 網域上的 session 也能透過帳號的確認卡授權（#1939 §0.2）。
- **哪些請求算數。** 只有 gateway 鎖定的主機正好是設定的網域時，請求才會標為 named。任何 header 都無法設定或改變這一點。Quick tunnel 的請求由下方的臨時公開連結選項決定。
- **開啟**和其他被擋下的設定變更一樣，且不能透過公開連結提出。自 AGEND-122 起，已登入的管理員可以從任何能連到 dashboard 的地方按「直接套用」確認（見[敏感 Settings 需要第二次確認](#敏感-settings-需要第二次確認)）；擁有者開啟較嚴格的選項時改用驗證器代碼，但要求代碼時不能透過連結確認。從另一台裝置確認時一定會發 Notice，因為開啟連結就是讓網際網路進來的那項變更。「在 AgEnD 電腦上」指 loopback 請求、loopback Host、沒有轉送 header。本機的 port-forward（`ssh -L`、IDE 的連接埠轉送）到達時一模一樣，所以也算這台電腦；能建立它的人本來就有主機，這與威脅模型一致。quick-link 選項規則相同。
- **關閉**立即生效，所有 named-link session 的回執都會視為無（`downgraded: named_link_off`）。再開啟會推進撤銷 epoch，那些回執不會回來。
- **`loopback_only`** 仍然優先。
- **開啟即接受的風險。** Cloudflare 終止 TLS，看得到流量，包括 session cookie。已授權的 named-link session 的 cookie 若被盜，在以下任一情況前都能從任何地方重播：
  - 30 分鐘閒置或 4 小時的公開 session 上限；
  - `max_session_hours`；
  - 通知卡上的「不是我」；
  - `/web revoke`；
  - 關閉選項。
- **named-link session 永遠不能作為自行確認待處理設定變更的授權。**

**透過臨時公開連結的網頁授權（#1939 §0.3），自 #2819 起預設開啟。** `/web` 開出的臨時公開連結（quick tunnel，`*.trycloudflare.com`）上的 session 也能透過帳號的確認卡授權，除非設定 `web.verified_authority.quick_link: false`。預設值本身不會授予任何權限：每個 session 仍須由帳號在私訊中確認。
- **哪些請求算數。** 所有不是 named 的 gateway 請求，只依監聽端判定；任何 header 都無法設定或改變。session 必須屬於目前這次開放，而每個 quick 網址都是新的一次。
- **重新開啟**（從 `false` 改成 `true` 或移除這個鍵）和其他被擋下的設定變更一樣，且不能透過公開連結修改：已登入的管理員可從任何裝置按「直接套用」確認，擁有者開啟較嚴格的選項時則用驗證器代碼，從另一台裝置確認會發 Notice（見[敏感 Settings 需要第二次確認](#敏感-settings-需要第二次確認)）。依目前生效的值判斷（沒設定代表預設的開；`true`／`false` 以外的值視為關）。經臨時連結進來的 session 只有在這個選項開啟時才能確認；固定連結與 `named_link` 也一樣。每次開啟（包括第一次）都會在同一次寫入中移動撤銷世代：到目前為止給出的所有授權都會結束，瀏覽器需要重新確認。從未設定這個鍵的 fleet，更新到 #2819 後第一次啟動時也是如此。
- **關閉**立即生效，所有 quick-link session 的回執都會視為無（`downgraded: quick_link_off`），那些 session 的授權也會被刪除。再開啟會推進撤銷 epoch，那些回執不會回來。
- **`loopback_only`** 仍然優先。
- **開啟期間接受的風險。** quick 網址是網際網路上的公開位址：任何拿到它的人都能到登入頁。屏障和固定網域相同：私下傳給允許帳號的登入碼，以及該帳號對這個 session 的確認。Cloudflare 的 quick tunnel 服務終止 TLS，看得到流量，包括 session cookie；AgEnD 啟動 quick tunnel 時前面沒有任何驗證。已授權的 quick-link session 的 cookie 若被盜，在以下任一情況前都能從任何地方重播：
  - 30 分鐘閒置或 4 小時的公開 session 上限；
  - `max_session_hours`；
  - 通知卡上的「不是我」；
  - `/web revoke`；
  - 按「關閉」或連結到期；
  - 關閉選項。
- **quick-link session 永遠不能作為自行確認待處理設定變更的授權。**

**登入並未保護所有本機 HTTP 讀取。** 任何能連到 listener 並帶允許 `Host` 的人，都能讀取 `/view` 及其 GET API，包括 `/api/pane/<instance>`、個人資料、頭像與排序。Listener 只綁定 `127.0.0.1`，但這仍然包括：
- 本機的其他使用者與程式；
- 反向代理、tailnet 分享或 port 轉送所放行的對象（`web.allowed_hosts`）；
- 在 WSL2 上，Windows 主機。

匿名的 `/view` 讀者看得到每個 instance：它沒有帳號、也沒有範圍限制。登入並不會替 `/view` 加上範圍：在 `web.view_access: open` 時，任何連得到 dashboard 本身連接埠的人（訪客也一樣）都能不登入就讀取。帶著訪客 session 的請求則以該訪客的身分檢查（#2855）：只限它自己的 agent，畫面只給「信任」等級、且在它的限制之內。啟用時的 `/api/ai-usage` 也公開，GET `/health` 不需要 token。Pane 擷取可能包含指令、憑證與其他私人輸出。

設定 `web.view_access: session` 可關閉這些讀取：`/view`、其 GET API 與 `/api/ai-usage` 會和 dashboard 一樣需要 session 或 header token。`/view` 的寫入（個人資料、頭像、排序）一律經過 dashboard 閘門：需要通過上述 cookie 寫入檢查的 session，或 `X-Agend-Token`，絕不接受 `?token=`。

本機 health/dashboard listener 綁定 `127.0.0.1`。所有請求，包括公開讀取與 `/agent`，都必須通過 `Host` 允許名單：`localhost`、`127.0.0.1`、`[::1]`、設定的 `hostname`，以及 `web.allowed_hosts` 中的名稱。缺少、格式錯誤或未列入的 Host 會收到 403。登入終端的 listener 也使用 Host 允許名單。

這項檢查限制瀏覽器的 DNS rebinding，**不是身分認證**：一般 HTTP client 可以自行指定允許的 `Host`。若透過反向代理或 port forward 暴露 listener，請在該邊界保護公開讀取，並只加入確實要服務的主機名稱。`/login` 終端使用每次登入獨立的憑證；它的臨時公開 tunnel 不會代理 dashboard。既有本機 session 不能用於受管理的公開入口，公開 session 也不能用於本機或下一個入口。見[登入設定](configuration.zh-TW.md#人不在機器旁完成-login公開連結)。

## Agent HTTP token

`POST /agent` 不經 dashboard 閘門，必須帶 `X-Agend-Instance-Token`。header 值格式為 `<encodedInstance>:<token>`，其中 `<encodedInstance>` 是 `encodeURIComponent(instanceName)`，`<token>` 是 daemon 每次啟動 CLI 時寫入 `<instanceDir>/agent.token`（權限 `0600`）的 64 字元 hex token。端點會先解碼 instance 名稱，在讀取請求 body **之前**驗證 token（缺少或錯誤的 token 直接回傳 401，不讀取 body），並將 body 限制在 512 KiB 以內（超過回傳 413）。伺服器也會執行該 instance 的 AgEnD 工具權限限制。Web token 不能替代這個 token。與 IPC socket 相同，同 Unix 使用者的行程能讀到憑證，因此這不是互不信任的本機 agent 之間的隔離機制。

## 機密資訊儲存

機器人 token 和 API 金鑰以純文字儲存在 `~/.agend/.env`；`web.token` 與各 instance 的 `agent.token` 也都是純文字憑證。檔案權限限制存取，但不會加密內容。`web-sessions.json` 只存 session id 的雜湊值，裡面沒有任何能讓瀏覽器登入的東西。

最小 `agend export` 會包含存在的 `.env`；完整匯出也可能包含其他憑證檔案。gzip tar 封存檔未加密，指令會提醒安全傳輸。請把匯出與備份當成憑證保護。如果主機是共用的，請考慮使用檔案系統加密。

### 敏感 Settings 需要第二次確認

瀏覽器 session（本機或公開連結）可以提出存取／F／C 名單、憑證、connection 目的地／順序、公開曝光及控制類 instance 設定的變更。伺服器在記憶體中保存一份不可變的請求，最長五分鐘，綁定目前的 session 與設定快照，並顯示完整且有界的 diff；secret 值只顯示金鑰名稱與指紋。一般的模型／顯示變更仍然即時生效，寫入前會檢查快照。AGEND-122（上游 [#3486](https://github.com/songsid/AgEnD/issues/3486)）改變了「誰能確認」，舊規則見下方「改了什麼」。

**誰能確認：依角色，每次請求都重新判斷。** 使用 **網頁 cookie session** 登入的人類 fleet 管理員，可以對等待確認的變更按「直接套用」（`POST /api/settings/pending/<id>/confirm`，或存檔當下直接完成），不論從哪裡連到 dashboard：AgEnD 電腦自己的瀏覽器、直接的區域網路或 tailnet 連線，或公開連結。適用所有種類的變更（secret、存取名單、connection、對外 Hub、開啟連結），聊天型與 web-only fleet 相同。不需要先做任何每個瀏覽器一次的證明：不用 DM 確認（#1939）、不用「General 卡片發得出去」、不用跑到主機。詢問當下和變更執行時都會再檢查即時的 session（登出、過期、被撤銷或管理員身分被移除，變更就變成過期，什麼都不套用）：
- 管理員等級的 cookie session；聊天帳號仍是自己 connection 的管理員，也是變更涉及的每個 connection 的管理員（帳號 id 以平台區分）；
- 擁有者自己的開關仍然有效：網頁授權總開關（`web.verified_authority.enabled`）、**只有這台電腦可以授權**（`loopback_only`：只有 AgEnD 電腦自己的瀏覽器能確認，有沒有代碼都一樣），以及經由臨時或固定連結時該連結的選項（`quick_link`、`named_link`）。web-only fleet 的 session 經由連結時，必須是用驗證器從外面登入的擁有者（#3008）。

**絕不能確認的。** agent 絕不能確認自己的請求，包含被 prompt injection 牽著走的 agent。擋住它的是它沒有真人的瀏覽器 cookie session，不是它的位置：在主機上的 agent 同樣在 loopback。`agend settings confirm` 拒絕 agent 環境，agent token 也不是 session。訪客、唯讀 session、非管理員、header token（CLI 用的）、已配對的 Windows 電腦，都不能確認 Settings。聊天型 fleet 的 General 卡片仍是另一個確認管道；主機上的 `agend settings confirm <id>` 仍是主機與 setup 頁（fleet 尚未存在時）的做法。

**擁有者較嚴格的選項：要求代碼。** `web.verified_authority.remote_confirm_code: true`（設定 → 存取與安全 → **網頁授權** →「從其他裝置確認變更時要驗證器代碼」；預設關閉；需先在**擁有者驗證**設定驗證器，開啟本身不需任何額外確認）。開啟後，不是 AgEnD 電腦自己瀏覽器的 session 不再有「直接套用」，不論它是什麼：區域網路或 tailnet 的 session、經由連結的 session、從外面登入的擁有者：每項變更都用「那一項變更」專屬的驗證器代碼確認（綁定變更的 digest，先檢查 digest 再檢查代碼；每個時間步只能用一次；全 fleet 共用的錯誤次數限制；執行時再檢查，並且是同一個綁定）。聊天帳號在進入時與執行時仍須是變更涉及 connection 的管理員。**只有這台電腦可以授權**連代碼也擋。要求代碼時，開啟連結的變更絕不能透過連結確認。AgEnD 電腦自己的瀏覽器不會被要求輸入。「AgEnD 電腦」指來自 loopback 位址、loopback Host、沒有轉送 header 的請求，所以 `ssh -L`、IDE 的連接埠轉送，以及主機上的任何程序都算主機（與威脅模型一致）。**這個選項不會封住所有路徑：**聊天型 fleet 上，General 的確認卡是另一條確認同一項變更的管道（包括關閉這個選項），不需要代碼；它需要管理員的聊天帳號，是另一個因素。在 AgEnD 電腦以外，關閉這個選項、以及更換或停用驗證器，都要輸入目前的代碼，所以被它限制的 session 無法自己解除限制。若選項已開卻沒有驗證器（檔案遺失），不在 AgEnD 電腦上的頁面無法確認，直到在那裡重新設定：預設為擋住，不會變成放行。聊天型 fleet 的驗證器只用於逐筆代碼；從外面登入及其開關仍只屬於 web-only fleet。

**Notice。** 除了稽核紀錄之外，從另一台裝置（不是 AgEnD 電腦自己的瀏覽器）發生下列情況時一定會發 Notice：(1) 確認開啟公開連結的變更、(2) 確認更改 secret 的變更、(3) 第一次設定驗證器（重新設定或停用本來就有自己的 Notice）、(4) 開啟或關閉代碼選項（關閉是指它被確認時）。web-only fleet 發到 dashboard 的 Notices；聊天型發到 General，否則主要 connection 的通知目標，再否則網頁 Notices（聊天型的 dashboard 之後會顯示）。Notice 帶的是已遮蔽的 diff、誰、結果，絕不含 secret 值。稽核紀錄仍照舊記下誰確認、用什麼方式。

**你接受的風險，白話說明。** 在擁有者開啟較嚴格的選項或**只有這台電腦可以授權**之前，任何持有已登入管理員 session 的人（沒登出的瀏覽器、或它的 session cookie）都能從任何連得到 dashboard 的裝置做任何變更，包括開啟公開連結和更改 secret，不需要第二步。Notice 是讓擁有者知道的方式，不是關卡。登入碼、session 時限和 `/web revoke` 限制這種 session 能活多久。程式與這些說明裡的「LAN」指「直接連線、而且不在 AgEnD 電腦上」：擁有者自己架的 tailnet、反向代理或 funnel 也會這樣到達，即使來自網際網路。它不是「私有區域網路」的意思。

**改了什麼（AGEND-122）。** 以前：等待確認的變更要有帳號對該瀏覽器的一次 DM 確認（#2170）加上發得出去的 General 卡片，或 AgEnD 電腦上主機自己的 session；對外 Hub 變更與開啟連結只有主機自己的 session 能確認；驗證器代碼（#3355）只用於 web-only fleet 的區域網路或 loopback 管理員 session，而且絕不用於開啟連結的變更。現在：所有種類、所有地點用同一條角色規則，所有種類都可以選擇改用代碼，並加上 Notice。臨時連結與固定連結的選項、網頁授權總開關、**只有這台電腦可以授權**都沒變，仍會縮小符合資格的人。本來就不能透過公開連結提出的設定（網頁設定、Hub、runtime 開關）仍在提出之前就被拒絕。


受影響的 connection 無法安全收到提示時，AgEnD 先找另一個 world 的 General，否則要求本機執行 `agend settings confirm <id>`。該命令走獨立、同使用者的 Unix socket（父目錄 0700、socket 0600），拒絕 agent 環境。它先列出權威的來源、請求人及 diff，再接受互動確認或明確的 `--yes`。HTTP／MCP 沒有確認入口。Fleet 尚未存在的 Setup 也需要同樣的 host 確認；pending 回應絕不啟動 fleet。

撤銷、到期、shutdown 或快照變動都會阻止新的 effect。已進入執行的操作會持有資源 lease，直到實際完成及條件式清理；等待 native 工作時可能持續顯示 `applying`。Rollback 只恢復仍屬於該操作的欄位，保留後來的修改。刻意放在最後的 session 撤銷可回傳完成 receipt，但不能授權後續 effect。Pending 請求重啟後消失，需重新提出。這個邊界不防禦以同一 host 使用者執行的其他程序；獨立檔案修改會盡可能被偵測，但不宣稱跨程序原子性。

## CI 供應鏈（#2528）

這個儲存庫使用的 GitHub Actions 都釘在完整 commit SHA，移動 tag 不會改到
CI 或 npm 發布 workflow 實際執行的程式。任何遠端 `uses:` 仍是 tag 時，CI
會讓 merge gate 失敗。Dependabot 每週的 `github-actions` 更新會同時改寫
SHA 與後面的 tag 註解（patch／minor 合併；每個 major 單獨開 PR）。見[CI 覆蓋 — GitHub Actions 釘選](ci.zh-TW.md#github-actions-釘選2528)。

CI 會驗證根目錄與 `website/` 安裝樹的 npm registry 簽章（`npm audit
signatures --json`）。簽章無效會讓 job 失敗；只有缺少簽章時會被報告。見[CI 覆蓋](ci.zh-TW.md#npm-registry-簽章2528)。

進 `main` 與 `release/**` 的 pull request 會跑 GitHub dependency review：
high 或 critical 諮詢，以及不在允許名單的授權，會讓檢查失敗。見[CI 覆蓋](ci.zh-TW.md#pr-的-dependency-review2528)。
