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

## IPC Socket

Daemon 透過 `~/.agend/instances/<name>/channel.sock` 與 AgEnD MCP bridge 通訊。AgEnD 使用限制性的 umask，並嘗試將 socket 設為 `0600`。私有 instance 目錄以 `0700` 建立，符合條件的既有目錄也會收緊權限。**沒有共享金鑰握手**。這些檔案權限用來區隔 Unix 使用者，無法認證或隔離同 UID 的行程，也無法防範 root。請留意無法限制權限的警告。

## Dashboard token 與瀏覽器 session

Dashboard 使用 fleet 共用的 bearer token，存於 `~/.agend/web.token`，建立時權限為 `0600`，fleet 重啟後仍保留；既有 token 檔的權限收緊採盡力處理。`agend web-token rotate` 會替換它；後續授權檢查會拒絕舊 dashboard 網址、header token 與衍生的 session cookie。輪換不代表能撤回已獲授權的請求，或關閉所有既有連線。

對走 dashboard 授權閘門的路由：

- GET/HEAD 的有效 `?token=` 會換成 `agend_session` cookie，並重新導向不含 token 的網址。寫入請求不能只靠 URL token 授權。
- Cookie 放的是 token 的衍生值，屬性包含 `HttpOnly`、`SameSite=Strict` 與瀏覽器端 12 小時的 `Max-Age`；伺服器不會獨立強制執行 12 小時 cookie 到期。`X-Forwarded-Proto` 顯示 HTTPS 時才加上 `Secure`；遠端存取請使用 TLS。
- 有效 cookie 或 `X-Agend-Token` header 可授權受保護路由。`Origin` 格式無效，或解析後的 host／port 與 `Host` 不同會被拒絕；不比對通訊協定。沒有 `Origin` 的呼叫者若憑證有效仍可通過。這是共用的操作員憑證，不是個別使用者帳號或角色系統。

請把 dashboard 連結與 cookie 當成憑證保護：首次帶 token 的網址仍可能出現在瀏覽器歷史、代理日誌或終端輸出。`/dashboard` 需要 fleet 管理員，但任何取得有效憑證的人都能使用；HTTP 操作不會逐次重查聊天允許名單。

## 公開讀取與 Host 檢查

**Web token 並未保護所有 HTTP 讀取。** 任何能連到 listener 並帶允許 `Host` 的人，都能讀取 `/view` 及其 GET API，包括 `/api/pane/<instance>`、個人資料、頭像與排序。啟用時的 `/api/ai-usage` 也公開，GET `/health` 不需要 token。Pane 擷取可能包含指令、憑證與其他私人輸出。

`/view` 的個人資料／頭像／排序寫入另有 token 檢查：需要以 `X-Agend-Token` 或 `?token=` 傳入 `web.token`，不接受 dashboard cookie。這些路由不經一般 dashboard 閘門及其 Origin 檢查，不能把閘門「URL token 在 GET／HEAD 換 cookie」的規則套到它們。

Health/dashboard listener 綁定 `127.0.0.1`。所有請求，包括公開讀取與 `/agent`，都必須通過 `Host` 允許名單：`localhost`、`127.0.0.1`、`[::1]`、設定的 `hostname`，以及 `web.allowed_hosts` 中的名稱。缺少、格式錯誤或未列入的 Host 會收到 403。登入終端的 listener 也使用 Host 允許名單。

這項檢查限制瀏覽器的 DNS rebinding，**不是身分認證**：一般 HTTP client 可以自行指定允許的 `Host`。若透過反向代理或 port forward 暴露 listener，請在該邊界保護公開讀取，並只加入確實要服務的主機名稱。`/login` 終端使用每次登入獨立的憑證；它的臨時公開 tunnel 不會代理 dashboard。見[登入設定](configuration.zh-TW.md#人不在機器旁完成-login公開連結)。

## Agent HTTP token

`POST /agent` 不經 dashboard 閘門，必須帶 `X-Agend-Instance-Token`，伺服器會與所宣告 instance 的 `agent.token` 比對。Daemon 每次啟動 CLI 都會寫入新的 token，目標權限為 `0600`；限制權限失敗會記錄警告，不一定阻止啟動。伺服器也會執行該 instance 的 AgEnD 工具權限限制。Web token 不能替代這個 token。與 IPC socket 相同，同 Unix 使用者的行程能讀到憑證，因此這不是互不信任的本機 agent 之間的隔離機制。

## 機密資訊儲存

機器人 token 和 API 金鑰以純文字儲存在 `~/.agend/.env`；`web.token` 與各 instance 的 `agent.token` 也都是純文字憑證。檔案權限限制存取，但不會加密內容。

最小 `agend export` 會包含存在的 `.env`；完整匯出也可能包含其他憑證檔案。gzip tar 封存檔未加密，指令會提醒安全傳輸。請把匯出與備份當成憑證保護。如果主機是共用的，請考慮使用檔案系統加密。
