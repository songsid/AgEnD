# 安全考量 (Security Considerations)

透過 Telegram 或 Discord 遠端操作 coding agent，等於讓聊天室參與者能要求主機執行動作。AgEnD 的聊天權限、MCP 工具權限與 HTTP 憑證各自保護不同入口；它們不會把 coding CLI 關進沙箱。

以下路徑使用預設資料目錄 `~/.agend`；可透過 `AGEND_HOME` 指定其他目錄。

## 聊天存取與管理權限

獲准進入的使用者可以要求 agent 讀檔、改程式或執行指令，實際可做的動作由後端權限決定。請把這些使用者、他們的帳號，以及獲准進入的 bot，都視為能接觸 agent 工作區與主機的可信對象。

- 要限制 fleet 聊天存取，請明確設定 `access.mode: locked`，並縮小 `allowed_users` 名單。**整段 `access` 省略時，執行時會回退到 open。**
- 已持久化的存取模式優先於 YAML；持久化與 YAML 的使用者名單取聯集。只從 YAML 刪除使用者，不一定會撤銷權限。見[設定參考](configuration.zh-TW.md#channelaccess)。
- Fleet 管理員必須明列在接收訊息 adapter 的 YAML `allowed_users` 中。Open 模式或配對核准本身不會授予這個身分。ClassicBot 有自己的管理員與聊天允許名單；見[權限表](permissions.md)。
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
- **瀏覽器 session**：以**一次性登入碼**登入後取得。fleet 管理員用 `/dashboard` 取得登入碼：General 選單只以私訊送出；Discord 可改用確認送達的 ephemeral 回覆，Telegram 私訊失敗則請管理員先私訊 bot 的 `/start`。在主機上，`agend web` 會用 header token 印出一組。登入碼為 8 個字元，**只能用一次**、**5 分鐘**後失效，而且只有最新的一組有效。輸錯五次會讓該組登入碼作廢；15 分鐘內（跨不同登入碼）累計輸錯 20 次，會暫停所有登入 5 分鐘。沒有發出任何登入碼時，就沒有東西可猜。本機登入會在 General 公告（`web.notify_login`，預設開啟）；公開登入不論此設定，都必須確認通知送達。

網址裡的 `?token=` **不是**憑證，舊連結與書籤也一樣：它會進到登入頁，token 會從網址列移除。

關於 session：

- Cookie 是隨機產生、與 `web.token` 和登入碼都無關的 256-bit id。伺服器的 session 紀錄只保存它的 SHA-256，並寫入 `~/.agend/web-sessions.json`，所以儲存的紀錄或這個檔案都無法拿來冒充 cookie。原始 id 仍會經過行程：建立 session 時（`Set-Cookie`），以及每個帶著 cookie 的請求。最多保留 8 個 session，超過時會丟掉最久沒用的一個。
- 到期由**伺服器**強制執行：登入後 12 小時，或 2 小時沒有使用，以先到者為準。使用指的是人的操作：打開頁面、讀取聊天紀錄、任何變更。頁面自己定時發出的讀取會完整檢查授權，但不算使用：dashboard 的即時串流（`GET /ui/events`，重新連線也一樣）與備援輪詢（`GET /ui/poll`），以及在 `web.view_access: session` 時 `/view` 的終端（`GET /api/pane/<instance>`）、名單（`GET /api/profiles`）與用量面板（`GET /api/ai-usage`）。這份清單由伺服器依 method 與路徑固定，請求無法自行宣稱是被動的。所以開著不管的分頁不會讓 session 一直有效（#1373）。Cookie 的 `Max-Age` 只是讓瀏覽器在同一時間忘掉它。Session 在 fleet 重啟後仍有效。
- Cookie 屬性為 `HttpOnly`、`SameSite=Strict`、`Path=/`。本機 listener 的 `X-Forwarded-Proto` 顯示 HTTPS 時，名稱改為 `__Host-agend_session` 並加上 `Secure`；遠端存取請使用 TLS。受管理的公開 cookie 一律 Secure，由 listener 指定的脈絡決定，不依賴 forwarded header。
- **只靠 cookie 授權的寫入**，還必須帶與 `Host` 相同的 `Origin`、瀏覽器有送 `Sec-Fetch-Site` 時其值為 `same-origin`，以及該 session 專屬的 `X-Agend-CSRF` 值。光有 cookie 什麼都改不了。本機帶 header token 的請求不需要這些檢查：網頁無法讓瀏覽器自動加上那個 header。
- 所有受保護路由都會拒絕 host／port 與 `Host` 不同（或無法解析，例如 `null`）的 `Origin`。沒有 `Origin` 的讀取，只要憑證有效仍可通過。
- **撤銷**：Session 選單可登出單一裝置或所有裝置；`/dashboard revoke` 讓所有瀏覽器登出並作廢尚未使用的登入碼；`agend web-token rotate` 讓所有在舊 token 下建立的 session 在下一次請求時失效，不需重啟。
- **回訪裝置（#1570）**：用 `/dashboard` 私送的登入碼登入時，會另外設定第二個 cookie `agend_device`（https 與公開連結上為 `__Host-agend_device`；`HttpOnly`、`SameSite=Strict`、90 天）。它的值是隨機 128-bit id 加上以 `web.token` 推導金鑰的 HMAC，不含任何聊天或使用者 id。`~/.agend/web-devices.json`（`0600`）只存 id 的 SHA-256、收到那組碼的擁有者與 token epoch。只有這種瀏覽器能在登入頁要求新的登入碼（`POST /auth/request-code`，必須帶 `Origin`）。fleet 會重新確認擁有者仍是該 bot 與 General 的 fleet 管理員，並只以私訊送出（絕不發到群組，也沒有替代管道）；私訊會寫出瀏覽器與來源。限制：每個裝置每分鐘 1 次、每小時 5 次；整個 fleet 每 20 秒 1 次、每小時 20 次（單調時鐘）；輸錯碼的斷路器開啟時一律拒絕。公開連結的要求必須屬於目前開啟中的 exposure，碼只限該 exposure 使用，登入仍需確認公開通知送達。`/dashboard revoke` 會清空登錄，`agend web-token rotate` 會讓所有裝置 cookie 失效（HMAC 金鑰與 epoch 都會改變）。

這是共用的操作員憑證，不是個別使用者帳號或角色系統。`/dashboard` 需要 fleet 管理員，但任何持有登入碼、session 或 header token 的人都能使用；本機 HTTP 操作不會逐次重查聊天允許名單。公開請求還必須確認發碼者的權限／綁定與入口仍有效。登入碼在用掉之前請視同密碼；選單的碼只會私送。

## 臨時公開 gateway 與本機讀取

所屬 adapter 的 General 管理員明確點選後，才開受管理的公開連結，預設兩小時（可設 1–480 分鐘，從同意起固定期限）。只用固定版本／checksum 驗證的 cloudflared，與 `/login` 共用單一 tunnel 名額。獨立 listener 使用程式指定的來源脈絡，不信任 proxy header。只接受當前完整 HTTPS Host 與核准面板路由，不在本機 Host 清單加 wildcard。即使本機讀取開放，公開 `/view` 與用量仍要登入；不暴露 health、agent、發碼、SSE、preview 或舊 restart API。

公開 cookie 為 Secure `__Host-`，綁定單次入口。 Gateway 拒絕本機 header token、cookie 與碼；公開碼與 session 都綁定單次入口。公開 session 限四小時／閒置 30 分鐘，入口較早關閉也會使其失效。每次公開登入都須在五秒內確認所屬 General 收到 🔐 公開通知，不受 `notify_login` 影響；確認前候選 session 不可用也不持久化。登入碼外洩仍可授予完整 web-admin 權限。Cloudflare 終止 TLS；光轉傳連結不會登入，但會暴露端點供猜碼、耗盡共用 breaker。完整 Origin 與 CSRF 保護瀏覽器寫入；Host 檢查不是身分認證。到期、停用、私送關閉、revoke、owner／binding 失效與 shutdown 都先關存取、撤回公開憑證，再清子行程；無法確認停止時封鎖下一條 tunnel。

**登入並未保護所有本機 HTTP 讀取。** 任何能連到 listener 並帶允許 `Host` 的人，都能讀取 `/view` 及其 GET API，包括 `/api/pane/<instance>`、個人資料、頭像與排序。啟用時的 `/api/ai-usage` 也公開，GET `/health` 不需要 token。Pane 擷取可能包含指令、憑證與其他私人輸出。

設定 `web.view_access: session` 可關閉這些讀取：`/view`、其 GET API 與 `/api/ai-usage` 會和 dashboard 一樣需要 session 或 header token。`/view` 的寫入（個人資料、頭像、排序）一律經過 dashboard 閘門：需要通過上述 cookie 寫入檢查的 session，或 `X-Agend-Token`，絕不接受 `?token=`。

本機 health/dashboard listener 綁定 `127.0.0.1`。所有請求，包括公開讀取與 `/agent`，都必須通過 `Host` 允許名單：`localhost`、`127.0.0.1`、`[::1]`、設定的 `hostname`，以及 `web.allowed_hosts` 中的名稱。缺少、格式錯誤或未列入的 Host 會收到 403。登入終端的 listener 也使用 Host 允許名單。

這項檢查限制瀏覽器的 DNS rebinding，**不是身分認證**：一般 HTTP client 可以自行指定允許的 `Host`。若透過反向代理或 port forward 暴露 listener，請在該邊界保護公開讀取，並只加入確實要服務的主機名稱。`/login` 終端使用每次登入獨立的憑證；它的臨時公開 tunnel 不會代理 dashboard。既有本機 session 不能用於受管理的公開入口，公開 session 也不能用於本機或下一個入口。見[登入設定](configuration.zh-TW.md#人不在機器旁完成-login公開連結)。

## Agent HTTP token

`POST /agent` 不經 dashboard 閘門，必須帶 `X-Agend-Instance-Token`。header 值格式為 `<encodedInstance>:<token>`，其中 `<encodedInstance>` 是 `encodeURIComponent(instanceName)`，`<token>` 是 daemon 每次啟動 CLI 時寫入 `<instanceDir>/agent.token`（權限 `0600`）的 64 字元 hex token。端點會先解碼 instance 名稱，在讀取請求 body **之前**驗證 token（缺少或錯誤的 token 直接回傳 401，不讀取 body），並將 body 限制在 512 KiB 以內（超過回傳 413）。伺服器也會執行該 instance 的 AgEnD 工具權限限制。Web token 不能替代這個 token。與 IPC socket 相同，同 Unix 使用者的行程能讀到憑證，因此這不是互不信任的本機 agent 之間的隔離機制。

## 機密資訊儲存

機器人 token 和 API 金鑰以純文字儲存在 `~/.agend/.env`；`web.token` 與各 instance 的 `agent.token` 也都是純文字憑證。檔案權限限制存取，但不會加密內容。`web-sessions.json` 只存 session id 的雜湊值，裡面沒有任何能讓瀏覽器登入的東西。

最小 `agend export` 會包含存在的 `.env`；完整匯出也可能包含其他憑證檔案。gzip tar 封存檔未加密，指令會提醒安全傳輸。請把匯出與備份當成憑證保護。如果主機是共用的，請考慮使用檔案系統加密。

### 敏感 Settings 需要第二次確認

瀏覽器 session（本機或公開連結）可以提出存取／F／C 名單、憑證、connection 目的地／順序、公開曝光及控制類 instance 設定的變更，不能自行提交。伺服器將不可變的請求留在記憶體最多五分鐘，綁定有效 session 與設定快照。General 顯示完整且有界的 diff 和 Confirm／Reject 按鈕；只有其所屬 adapter 的 fleet admin 能確認。Secret 值只顯示 key 與 fingerprint。一般 model／display 變更仍可直接套用，但寫入前會核對快照。

受影響的 connection 無法安全收到提示時，AgEnD 先找另一個 world 的 General，否則要求本機執行 `agend settings confirm <id>`。該命令走獨立、同使用者的 Unix socket（父目錄 0700、socket 0600），拒絕 agent 環境。它先列出權威的來源、請求人及 diff，再接受互動確認或明確的 `--yes`。HTTP／MCP 沒有確認入口。Fleet 尚未存在的 Setup 也需要同樣的 host 確認；pending 回應絕不啟動 fleet。

撤銷、到期、shutdown 或快照變動都會阻止新的 effect。已進入執行的操作會持有資源 lease，直到實際完成及條件式清理；等待 native 工作時可能持續顯示 `applying`。Rollback 只恢復仍屬於該操作的欄位，保留後來的修改。刻意放在最後的 session 撤銷可回傳完成 receipt，但不能授權後續 effect。Pending 請求重啟後消失，需重新提出。這個邊界不防禦以同一 host 使用者執行的其他程序；獨立檔案修改會盡可能被偵測，但不宣稱跨程序原子性。
