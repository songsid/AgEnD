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

本機 CLI/header 憑證是 `~/.agend/web.token`（建立時 `0600`）。瀏覽器用五分鐘、一次性登入碼取得隨機 server-side session；舊 URL token 不能登入。Cookie 為 `HttpOnly`、`SameSite=Strict`，寫入需相符 Origin 與該 session 的 CSRF 值。本機 session 由 server 限制 12 小時／閒置兩小時。Token 輪換使後续請求失效，不能撤銷已授權開始的工作。

General 的 `/dashboard` 選單限管理員且不含憑證；連結與碼私送，Discord 可改用須確認送達的 ephemeral 回覆。Telegram 失敗時請使用者先私訊 bot 的 `/start`。本機腳本可用 `X-Agend-Token`；受管理的公開 gateway 拒絕該 header 以及本機 cookie／碼。公開憑證綁定當前入口，舊入口或未綁定的 gateway session 在更新活動前就拒絕。

## 臨時公開 gateway 與本機讀取

所屬 adapter 的 General 管理員明確點選後，才開受管理的公開連結，預設兩小時（可設 1–480 分鐘，從同意起固定期限）。只用固定版本／checksum 驗證的 cloudflared，與 `/login` 共用單一 tunnel 名額。獨立 listener 使用程式指定的來源脈絡，不信任 proxy header。只接受當前完整 HTTPS Host 與核准面板路由，不在本機 Host 清單加 wildcard。即使本機讀取開放，公開 `/view` 與用量仍要登入；不暴露 health、agent、發碼、SSE、preview 或舊 restart API。

公開 cookie 為 Secure `__Host-`，綁定單次入口。每次公開登入都須在五秒內確認所屬 General 收到 🔐 公開通知，不受 `notify_login` 影響；確認前候選 session 不可用也不持久化。登入碼外洩仍可授予完整 web-admin 權限。Cloudflare 終止 TLS；光轉傳連結不會登入，但會暴露端點供猜碼、耗盡共用 breaker。完整 Origin 與 CSRF 保護瀏覽器寫入；Host 檢查不是身分認證。到期、停用、私送關閉、revoke、owner／binding 失效與 shutdown 都先關存取、撤回公開憑證，再清子行程；無法確認停止時封鎖下一條 tunnel。

本機 `/view` 讀取預設仍開放（`view_access: session` 關閉），終端畫面可能含機密。Profile／頭像／排序寫入需 session 或 header token。本機 listener 的 Host 清單為 localhost、loopback、設定的 hostname 與 `web.allowed_hosts`。自行設定的 proxy 或 port forward 不會自動獲得受管理 gateway 的規則；既有本機 session 不會變成公開憑證。見 [web dashboard](web-dashboard.zh-TW.md#手機使用臨時公開連結)。

## Agent HTTP token

`POST /agent` 不經 dashboard 閘門，必須帶 `X-Agend-Instance-Token`，伺服器會與所宣告 instance 的 `agent.token` 比對。Daemon 每次啟動 CLI 都會寫入新的 token，目標權限為 `0600`；限制權限失敗會記錄警告，不一定阻止啟動。伺服器也會執行該 instance 的 AgEnD 工具權限限制。Web token 不能替代這個 token。與 IPC socket 相同，同 Unix 使用者的行程能讀到憑證，因此這不是互不信任的本機 agent 之間的隔離機制。

## 機密資訊儲存

機器人 token 和 API 金鑰以純文字儲存在 `~/.agend/.env`；`web.token` 與各 instance 的 `agent.token` 也都是純文字憑證。檔案權限限制存取，但不會加密內容。

最小 `agend export` 會包含存在的 `.env`；完整匯出也可能包含其他憑證檔案。gzip tar 封存檔未加密，指令會提醒安全傳輸。請把匯出與備份當成憑證保護。如果主機是共用的，請考慮使用檔案系統加密。
