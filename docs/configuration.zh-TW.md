# 設定參考

## Fleet 設定檔

位置：`~/.agend/fleet.yaml`。由 `agend init` 建立或手動編輯。

```yaml
project_roots:
  - ~/Projects

channel:
  type: telegram
  mode: topic
  bot_token_env: AGEND_BOT_TOKEN
  group_id: -1001234567890
  access:
    mode: locked
    allowed_users: [123456789]

defaults:
  backend: claude-code
  tool_set: standard
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: Asia/Taipei
  daily_summary:
    enabled: true
    hour: 21

instances:
  my-project:
    working_directory: ~/Projects/my-app
    description: "後端 API 開發者"
    model: opus

teams:
  frontend:
    members: [my-project, another-instance]
    description: "前端開發團隊"

health_port: 19280
```

---

## 頂層欄位

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `project_roots` | string[] | `[]` | 顯示在 topic 自動綁定瀏覽器中的目錄。同時限制 `create_instance` — 工作目錄必須在設定的 root 下 |
| `channel` | object | — | 單一通訊平台設定；多 bot 請改用 `channels[]` |
| `channels` | ChannelConfig[] | — | 多連線設定陣列。舊的單一 `channel` 會自動轉成一筆連線 |
| `defaults` | object | `{}` | 所有 instance 的預設設定 |
| `instances` | object | `{}` | Instance 定義（key = instance 名稱） |
| `teams` | object | `{}` | 具名 instance 群組，用於精準廣播 |
| `templates` | object | — | 可重複部署的 fleet 模板 |
| `profiles` | object | — | 可供模板引用的 backend/model 預設組合 |
| `health_port` | number | `19280` | HTTP 健康檢查/API 伺服器埠 |
| `fleet_label` | string | 主機名稱 | 這個 fleet 在 `/login` 裡的名稱：附加在 Discord slash 指令說明後面，並顯示在每個 backend 選單下方（`🖥 Fleet：…`）。同一個 guild 裡每個 AgEnD bot 都會註冊自己的 `/login`，而且只控制執行它的那個 fleet——這個標籤用來分辨它們。預設：本機主機名稱；AgEnD home 不是 `~/.agend` 時再加上該目錄名稱 |
| `web` | object | — | `usage_panel: false` 隱藏所有 AI 額度顯示（標題列的 **用量**、右側面板與對話框）並停用 `/api/ai-usage`（預設 `true`）；`log_tab: true` 開啟每個 instance 的 **紀錄** 分頁：從 agent 自己的對話紀錄即時讀出提示、回覆、工具呼叫與結果、錯誤和 fleet 事件，機密值會遮蔽，公開連結也看得到（預設 `false`：關閉時完全不做任何事；也可在 **設定 → 網頁** 開啟，開啟需 fleet admin 確認；支援 claude-code 與 codex——kiro 目前只顯示 fleet 事件並說明原因，直到 AgEnD 能證明 kiro instance 所在的對話）；`allowed_hosts: [name, …]` 加入反向代理或轉送使用的 Host 名稱。內建允許 `localhost`、`127.0.0.1`、`[::1]` 與設定的 `hostname`；其餘 Host 回 403，`/login` 瀏覽器終端也使用此清單；`session.local.absolute_hours`／`session.local.idle_hours` 設定直接連到 dashboard（本機、區網、tailnet）時登入可維持多久——登入後幾小時、未使用幾小時（預設 `48`／`48`；`1 ≤ idle_hours ≤ absolute_hours ≤ 720`，可用小數；公開連結的 4 小時／閒置 30 分鐘固定、不可設定；變更不需重啟即生效，改短也會結束已超過新期限的 session；也可在 **設定 → 網頁** 修改，延長時需 fleet admin 確認）；`web.view_access: session` 讓 `/view` 也必須登入（預設 `open`；儲存個人資料一律需登入）；`web.notify_login: false` 關閉本機登入通知（預設 `true`；公開登入仍須確認通知送達）；`web.preview: false` 關閉 HTML 預覽（預設 `true`，各裝置仍須自行同意執行）；`web.preview_port` 是 loopback 預覽埠（預設 `health_port + 1`，即 19281）；`web.preview_origin` 是代理到預覽 listener 的獨立來源，須與 dashboard 使用不同主機名稱；`web.upload_max_file_mb`／`web.upload_max_total_mb` 設定網頁聊天的上傳上限：單一檔案、以及一則訊息所有檔案合計（整數 MB，1–500；預設 `50`／`100`；單一檔案不會大於整則訊息的上限；透過公開連結時單一檔案最多 95 MB，這是臨時通道的限制；`agend reload` 後下一次上傳就套用）；`themes.agent_edit: false` 拒絕所有 agent 修改自己的網頁主題（預設 `true`：agent 可改自己的，有頻率限制；已存的內容保留，人仍可重設與鎖定）；`appearance` 設定身分卡圖片的上傳限制與每個 agent 的圖片配額：`portrait`／`banner` 各有 `max_width`、`max_height`（px）、`max_kib`，`instance_quota` 有 `files`、`mib`（預設肖像 1024×1536／1536 KiB、橫幅 1600×600／768 KiB、配額 8 個檔案／4 MiB；硬性上下限為肖像 64–2048×64–3072 px、32–4096 KiB，橫幅 64–3200×64–1200 px、32–2048 KiB，配額 2–16 個檔案、1–16 MiB；超出範圍的值會被夾到上下限並發出警告，不會讓 fleet 無法啟動；變更只影響之後的上傳，已存的圖片不會被刪除）；`guests` 是給非管理者的訪客網頁登入（#1920；開啟後，不是 fleet 管理者的人在他本來就能聊天的地方傳 `/web`，就會私下收到一組訪客登入碼，可用於直接連線的 dashboard，以及管理者開啟中的公開連結（訪客透過公開連結登入時，會在開啟連結的管理者的 General 公告）；他只會看到在聊天中本來就能用的 agent，他傳 `/web revoke` 只會登出他自己的訪客 session）：`enabled`（預設 `false`；關閉時所有訪客 session 都會結束）、`chat`（預設 `true`）、`open_instances: { <連線 id>: [instance, …] }`（`open` 連線的訪客只能看到這裡列出的 instance，預設沒有）、`narrow: { "<連線 id>:<使用者 id>": [instance, …] }`（管理者的縮小範圍，只會減少不會增加），以及 `session.absolute_hours`／`session.idle_minutes`（預設 `12`／`120`；1–24 小時、15–720 分鐘；不會長於該入口本身的期限）；`verified_authority` 決定已登入的網頁 session 送出的訊息，何時在送達收據中帶有該帳號的授權（#1939；目前 agent 仍把網頁訊息當成辨識而已）：符合資格的 session（fleet 管理者本人的帳號、直接連線的 dashboard，公開連結與訪客一律不算）由該帳號在 Discord 或 Telegram 上確認授權一次，之後它送出的訊息就是 `web-verified`，直到過期或被撤銷。`enabled`（預設 `false`：伺服器總開關——關閉時所有網頁授權立即視為無，再打開也不會讓之前給的授權恢復）、`loopback_only`（預設 `false`：區網、tailnet 上的瀏覽器也算；`true`：只有這台電腦上的瀏覽器；打開後，之前從區網給的授權視為無，再關掉也不會恢復）與 `max_session_hours`（預設 `48`；1–48：一次授權維持多久；之後的訊息照樣送出，只是不帶授權）。`/web revoke` 也會撤銷到目前為止給出的所有網頁授權，而 AgEnD 停止期間把開關關掉又打開（等於沒有變化）時，要撤銷就得用它 |
| `needs_you` | object | — | **「等你處理」**（#1386）：一份列出所有在等人處理的事的清單——fleet 的提示（沒有回應／已結束／在終端機上等待）、instance 停在權限、危險指令、登入或其他對話框、因需要登入而暫停或已崩潰的 instance，以及 fleet 無法確認或無法送達的傳遞（最近 24 小時）。`needs_you.live_message`（預設 `true`）：每個 bot 在**自己的** General 維持一則即時訊息，只列出它負責的 instance——處理掉就編輯更新，有新的事就重新發一則（最多每分鐘一次）；每一行都連到該提示自己的按鈕或 instance 的討論串，無法確認或送達的傳遞會有**已確認**按鈕，限該 bot 的管理員使用。`needs_you.dm`（預設 `false`）：有新的事時也私訊該 bot 的管理員（終端機等待需持續 5 秒才通知；最多每分鐘一則）。網頁儀表板會顯示所有 bot 的項目。兩個設定都不需重啟即生效。文字與按鈕沒有變化時不再編輯，「已確認」按鈕仍會更新有效期限。編輯失敗時，只有確認訊息或目的地不存在、或失去權限才會重新發送，同樣最多每分鐘一次；網路、速率限制與內容錯誤會保留原訊息的位置。若曾為避免 Telegram 訊息重複而關掉 `live_message`，更新後可將它設回 `true`。 |
| `web_terminal` | object | — | `/login`（登入與安裝）背後的瀏覽器終端：`enabled`（預設 `true`）、`bind`（預設 `127.0.0.1`）、`ttl_minutes`（1–20，預設 10；`enabled` 與 `ttl_minutes` 也可在 **設定 → 網頁** 修改，開啟終端機或增加分鐘數需 fleet admin 確認），以及 `tunnel` —— `/login` 的公開連結，每次登入都會提供，除非設 `allow_public: false`；見下方「人不在機器旁完成 /login」 |

---


### 臨時公開 dashboard 連結

`web.public_link.allow_public` 預設 `true`（僅提供選項，必須由 General 管理員主動點選）、`ttl_minutes` 預設 `120`（1–480，從同意起固定期限）、`protocol` 預設 `http2`（也接受 `quic`／`auto`）。Settings 修改時不因無關編輯寫入預設值；停用會關現有入口。公開 Host 不持久化，該入口的 `/view` 需登入。預覽改由連結自己的第二條 quick tunnel 提供，在背景啟動、隨連結關閉（`web.preview_on_public_link`，預設 `true`）。私送、session 隔離與風險見 [web dashboard](web-dashboard.zh-TW.md#手機使用臨時公開連結)。

### 同一個 Discord guild 裡有多個 fleet

每個 AgEnD bot 都會註冊自己的 `/login`，而且只控制執行該 bot 的 fleet。Discord 會把它們並排列出，所以每個指令說明的結尾都帶著它的 fleet 標籤（`fleet_label`，預設為主機名稱），每個 backend 選單也會顯示 `🖥 Fleet：<標籤>`。請選標籤是你要操作的那個 fleet 的指令。

### 人不在機器旁完成 /login（公開連結）

預設 `/login` 的終端連結只能在這台機器上用（SSH 轉發、tailscale、你自己的反向代理）。手機連不到時，`kiro-cli` 或 `claude-code` 登入可以透過
Cloudflare Quick Tunnel 開一個臨時的**公開 https 連結**。不需要任何設定：`/login kiro`（或 `/login claude`）的確認會有三個按鈕——
**我了解（外網臨時連結）**、**我了解（內網）**、**取消**；按第一個就是同意，每次登入一次，連結不會保留或重用。Discord 與 Telegram 都一樣。

**cloudflared。** fleet 的 `PATH` 上若已有 `cloudflared` 就直接使用。否則第一次選擇公開連結時，AgEnD 會把 Cloudflare 的官方版本下載到它自己的資料夾（`~/.agend/bin/cloudflared`，不需要 sudo，不安裝到系統），並在聊天室說明。版本在 AgEnD 裡固定，下載後會比對一同固定的 SHA256；不符的檔案會被刪除，什麼都不會執行。已安裝的版本每次使用前都會再檢查一次。**下載來源：** Linux 先從 Cloudflare 自己的套件庫（`pkg.cloudflare.com` 的 `.deb`，由 AgEnD 自行解出執行檔）下載；套件不存在、停滯、太慢或不符時，再改用 GitHub release。macOS 沒有套件，只用 GitHub。兩種來源都比對同一個固定的 SHA256。只有連續 60 秒沒有收到資料才算失敗，整體上限 30 分鐘，所以慢但持續在動的連線會下載完成。AgEnD 只會安裝到、也只信任完全屬於你的資料夾：若 `~/.agend`（或其中的 `bin`）可被其他使用者寫入，或 `bin` 是 symlink，它會拒絕並說明原因。支援 Linux（x86-64、arm64、arm、x86）與 macOS（Intel、Apple silicon）；其他系統請自行安裝 cloudflared。如果取得不到（離線、被阻擋；會使用 `HTTPS_PROXY`），這次登入會說明原因且不開啟任何東西——請改選**我了解（內網）**。

要在這台主機關閉公開連結（不顯示按鈕，也絕不下載）：

```yaml
web_terminal:
  tunnel:
    allow_public: false     # 預設：未設定 —— 會提供，且每次登入都會先詢問
    # provider: cloudflared # 目前唯一的 provider
    # protocol: http2       # http2（預設）| quic | auto
```

- tunnel 只代理**那一次登入的終端**（它自己的 listener），不是 dashboard。光有終端頁面不能做任何事：還需要一次性**存取 token**。
- 公開連結與 token 會**分成兩則私訊**傳給你（Discord/Telegram DM），絕不貼在頻道；頻道只有一行狀態。任何一則私訊送不到（例如你從未與 bot
  開過私聊），就直接關閉這次登入，沒有「改貼在頻道」的後路。
- **失敗即關閉**：tunnel 起不來、中途死掉，或登入以任何方式結束（完成、取消、逾時、fleet 關閉），都會在下一次登入之前先停掉 tunnel。無法確認已停止的
  tunnel 會在聊天裡連同 pid 公告，並在處理之前封鎖後續 tunnel。
- **流量會經過 Cloudflare。** Quick Tunnel 在 Cloudflare 邊緣終止 TLS，所以 Cloudflare 看得到頁面、存取 token，以及終端裡輸入或顯示的一切。同意文字有寫明；若這對某次登入不可接受，請選**我了解（內網）**。
- tunnel 的公開名稱不會寫進 log 或稽核紀錄。把連結當成 token 的另一半：請勿轉傳或加書籤。
- 只有需要終端才能完成的登入可以用——`kiro-cli` 與 `claude-code`（`src/login-flows.ts` 的 `tunnelOk`）。裝置代碼登入（codex、grok）會把網址和代碼貼在聊天室，不需要它。

`protocol`：cloudflared 預設走 QUIC（UDP 7844），很多公司網路與 VM 會擋，之後要花很久才 failover 或根本連不上。所以 AgEnD 預設傳
`--protocol http2`（連到 Cloudflare 邊緣的 TCP 7844 —— 與 QUIC 的 UDP 同一個埠號，擋 UDP 的網路通常仍放行 TCP，但嚴格的防火牆也可能關掉它），除非你設 `quic` 或 `auto`（交給 cloudflared 決定）。`agend setup --tunnel` 同樣使用這個預設。就緒檢查也會先用
Cloudflare 的公共解析器（1.1.1.1 / 1.0.0.1）解析 tunnel 名稱，再以真正的主機名稱當 SNI 連到該位址，失敗才退回系統解析器：全新的
`trycloudflare.com` 名稱透過公司 DNS 轉發器可能要一分鐘才解析得到。為此離開這台機器的只有一筆對 tunnel 隨機主機名稱的 DNS 查詢。啟動最多給一分鐘。

## channel

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `type` | `"telegram"` \| `"discord"` | **必填** | 通訊平台 |
| `mode` | `"topic"` | `"topic"` | 路由模式（topic = 每個 instance 一個 topic） |
| `bot_token_env` | string | **必填** | 存放 bot token 的環境變數名稱 |
| `id` | string | 由平台型別推算 | 多連線模式中可明確命名的 adapter ID |
| `group_id` | number \| string | — | Telegram 群組 ID（負數）或 Discord guild ID；大型 ID 請加引號，避免數值精度損失 |
| `access` | object | 省略整段時為 open fallback | 存取控制（持久化狀態仍可能覆蓋） |
| `mirror_topic_id` | number \| string | — | 鏡像跨 instance 通訊的 Telegram topic ID。所有 `send_to_instance` 訊息都會出現在此 |
| `options` | object | — | 平台特定選項（Discord：`category_name`、`general_channel_id`；Telegram：`topic_probe`，`on-demand`（預設，只在真實投遞回報 topic 不存在時才確認，不做定期送刪訊息）或 `periodic`（每 5 分鐘對每個 topic 送刪一則空白訊息確認存在）；`sticker_sets`（Telegram：agent 沒指定時 `list_stickers` 列出的貼圖包名稱清單，即 `t.me/addstickers/<name>` 的 `<name>`，最多取 10 個）；兩者皆可設 `status_emojis`，見 instance 的 `status_emojis`） |
| `telegram_api_root` | string | `"https://api.telegram.org"` | 自訂 Telegram Bot API URL |

### channel.access

`access` 可省略。**省略整個區塊時，執行時使用 `open` fallback**，不是 `locked`；既有持久化模式仍可能覆蓋它。若要限制聊天存取，請明確設定 `mode: locked` 與 `allowed_users`。

下表的 fallback 值只適用於整段省略時；明確提供的區塊不會逐欄補上這些值。請填寫 `mode`、`allowed_users` 陣列，以及使用 pairing 時的配對限制。

| 欄位 | 型別 | 整段省略時的 fallback | 說明 |
|------|------|----------------------|------|
| `mode` | `"locked"` \| `"pairing"` \| `"open"` | `"open"` | `locked`／`pairing` 僅允許有效名單中的使用者；`pairing` 另可用 `/pair` 申請。`open` 允許所有使用者；bot 另有入口篩選，見[權限表](permissions.md#bot-and-webhook-messages) |
| `allowed_users` | (number\|string)[] | `[]` | 與持久化名單取聯集；ID 以字串比較 |
| `max_pending_codes` | number | `0` | 同時持有配對碼的不同使用者數量上限；pairing 請設定正數 |
| `code_expiry_minutes` | number | `0` | 配對碼有效分鐘數；pairing 請設定正數 |

**持久化狀態與管理權限：**

- 主 adapter 使用 `<dataDir>/access/access.json`；額外 adapter 使用 `access/access-<adapterId>.json`。`dataDir` 預設為 `~/.agend`，可由 `AGEND_HOME` 指定。
- 已儲存的 mode 優先於 YAML。已儲存的使用者與 YAML `allowed_users` 合併、去重；配對核准會加入持久化名單。
- `locked`／`pairing` 下，撤銷使用者必須讓持久化與 YAML 兩份名單都不再授權；只改其中一份可能仍允許存取。`open` 本來就不限制使用者。
- Fleet 管理指令另看**呼叫所經 adapter 的 YAML `access.allowed_users`**。Open 存取或已核准配對本身不授予 fleet admin，YAML 名單空白時沒有人有此權限，這個 bot 的 `/web`、`/update`、`/doctor` 也就關閉（回覆會指出是哪個設定）。沒有 `web.access` 這個設定：`agend validate` 會對它以及 `web` 底下其他不認得的鍵提出警告。這些以及驗證器的其他警告，也會出現在 `agend doctor`，以及 fleet 啟動時的 `daemon.log`。ClassicBot 有獨立的 `defaults.admin_users`；見[權限表](permissions.md)。

---

## defaults

所有 `instances.<name>` 的欄位都可以在這裡設預設值。額外欄位：

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `cost_guard` | object | 停用 | 全 fleet 花費守衛 |
| `hang_detector` | object | 啟用，10 分鐘 | 卡住偵測 |
| `daily_summary` | object | 啟用，21:00 | 每日花費摘要 |
| `scheduler` | object | — | 排程設定 |
| `webhooks` | object[] | `[]` | Webhook 通知 |
| `startup.concurrency` | number | 自動推算，`2`–`10` | 依空閒 RAM 與 CPU 數推算共用 spawn gate 的併發上限；明確設定時範圍為 `1`–`20` |
| `startup.stagger_delay_ms` | number | `500` | startup、wake、recovery、restart 各次 spawn admission 的最小間隔（毫秒），不是每批之間的延遲；範圍 `0`–`30000` |
| `warm_cap` | number | `0`（無上限） | 執行中 instance 的暖機上限；超過時暫停最近最少活動的 idle instance，General 與持有 work lease 的 instance 不被淘汰。與按時間計算的 `auto_pause_after` 互補 |
| `progress_min_elapsed` | number | `30` | 進度行／取消按鈕開始顯示經過時間之前的秒數 |
| `locale` | `"en"` \| `"zh-TW"` | 依時區推算 | 使用者可見介面與通知的語言 |
| `max_cross_instance_message_bytes` | number | `12288` | 跨 instance 訊息內容的 UTF-8 byte 上限。超限時會明確拒絕，並提示精簡內容或改傳檔案路徑。 |
| `reply_overdue_minutes` | number | `15` | 距上次詢問／提醒多少分鐘後，通知寄件者一次：`requires_reply` 請求仍未回答，且負責的 instance 並非 working。`0` 只停用這則閒置逾期通知，不停用對負責者的提醒或 TTL 到期的最後通知 |
| `reply_obligation_ttl_hours` | number | `24` | 開放中的回覆義務距上次詢問多久後到期，必須是有限正數（小時）；提醒不延長期限。到期會記錄 log，若尚未通知過逾期則通知寄件者一次，即使 `reply_overdue_minutes` 是 `0` 也一樣。重啟只發一則提醒，最多列十筆請求及「+N 個其他請求」；回合結束的提醒保留既有寬限及每次詢問一次的規則。 |
| `retention_days` | number | `30` | `delivery-outbox.db` 保留已完成投遞（`delivered`/`failed`）及 Task Board 已完成/已取消任務的天數。`uncertain` 與非終態的 row 永遠不會被清除。fleet 啟動時執行一次，之後每天執行，每次最多刪除 500 筆以免卡住 event loop。被清除的 delivery_id 在 `delivery_status` 工具中會回傳「早於保留期限，已清除」而非「找不到」 |
| `tips` | boolean | `true` | General 每日提示；不受 `daily_summary.enabled` 控制 |

重啟去重另外保存 owner／boot 檢查點（只有識別碼與時間），不跟著通知的保留政策清理。刪除舊的已送達通知，不會讓同一個 boot 重新提醒或重新標記請求。

### defaults.cost_guard

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `daily_limit_usd` | number | `0`（停用） | 每日花費上限。`0` = 不限制 |
| `warn_at_percentage` | number | `80` | 達到上限百分比時警告 |
| `timezone` | string | 系統時區 | IANA 時區（例：`Asia/Taipei`） |

### defaults.hang_detector

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 啟用卡住偵測 |
| `timeout_minutes` | number | `10` | 無輸出多久後發出警告 |

### defaults.daily_summary

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 啟用每日花費摘要 |
| `hour` | number | `21` | 發送時間（0-23） |
| `minute` | number | `0` | 分鐘 |

### defaults.scheduler

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `max_schedules` | number | `100` | 排程數量上限 |
| `default_timezone` | string | `Asia/Taipei` | Cron 排程的預設時區 |
| `retry_count` | number | `3` | 首次投遞失敗後的重試次數 |
| `retry_interval_ms` | number | `30000` | 重試間隔（毫秒） |

### defaults.webhooks[]

| 欄位 | 型別 | 說明 |
|------|------|------|
| `url` | string | Webhook endpoint URL |
| `events` | string[] | 已有事件：`hang`、`mcp_died`、`pty_error`、`pty_recovered`、`cost_warning`、`cost_limit`、`schedule_deferred`、`model_failover`、`model_recovered`；`["*"]` 訂閱全部 |
| `headers` | object | 選用的 HTTP headers |

`instance.started`、`instance.stopped`、`rotation` 與 `crash_loop` 並未送出。範例：

```yaml
defaults:
  webhooks:
    - url: https://example.com/hook
      events: [cost_warning, hang]
      headers:
        Authorization: "Bearer token"
```

### defaults.delivery_worker 與 defaults.warm_overflow（2.1.9）

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `delivery_worker` | `"off"` \| `"wake_only"` \| `"on"` | `"wake_only"` | Phase 2 投遞負責者（#1129 起預設為 `wake_only`）。`wake_only` 會在有跨 instance 工作排隊時喚醒暫停中的目標；`off` 不會：給跨 fleet 重啟仍暫停的 instance 的工作，要等手動 `/wake`；`on`（canary）另外把該目標的投遞 lane 交給專屬 worker。可用 `instances.<name>.delivery_worker` 逐 instance 覆寫 |
| `warm_overflow` | number | `2` | `delivery_worker` 為 `wake_only`（預設）或 `on` 時，為了喚醒有排隊工作的目標，`warm_cap` 最多可以超出的數量。`warm_cap` 為 `0` 時沒有作用 |

---

## teams.\<name\>

具名的 instance 群組，用於精準廣播。可透過 `create_team`、`list_teams`、`update_team`、`delete_team` MCP 工具管理，或直接在 fleet.yaml 中定義。

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `members` | string[] | **必填** | 此 team 的 instance 名稱列表 |
| `description` | string | — | team 用途說明 |

範例：

```yaml
teams:
  backend-squad:
    members: [api-agent, db-agent]
    description: "後端開發團隊"
```

使用 `broadcast(team: "backend-squad", message: "...")` 向所有成員廣播。

> **注意：** 刪除 instance 時，該 instance 會自動從所有 team 中移除。

---

## templates 與 profiles

`templates` 定義可重複部署的 instance 組合；`team: true` 會把部署出的 instance
組成 team。模板 instance 支援 `description`、`backend`、`model`、`model_failover`、
`tool_set`、`systemPrompt`、`skipPermissions`、`lightweight`、`workflow`、`tags`，以及
引用 `profiles` 的 `profile` 欄位。

```yaml
profiles:
  heavy:
    backend: claude-code
    model: opus
  light:
    backend: kiro-cli
    lightweight: true
templates:
  sprint-team:
    description: "開發與審查"
    team: true
    instances:
      dev:
        profile: heavy
      reviewer:
        profile: light
        tool_set: minimal
```

---

## instances.\<name\>

`tool_set` 對已辨識的 instance 身分執行政策防護，不會隔離同 uid、具有 shell 能力的 agent。另一個 agent 能讀它的 `agent.token` 或使用其 IPC socket；見[共用帳號威脅模型](SECURITY.zh-TW.md#工具組與共用主機帳號)。

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `working_directory` | string | 自動 | 專案目錄路徑。省略時自動建立 `~/.agend/workspaces/<name>` |
| `display_name` | string | — | Agent 顯示名稱（例："Kuro"）。用 `set_display_name` 設定 |
| `status_emojis` | object | — | 此 instance 自己的投遞狀態 emoji，逐鍵覆蓋 channel 的 `options.status_emojis`。鍵：`received`、`queued`、`processing`、`delivered`、`failed`、`progress_prefix`、`photo`、`attachment`（ClassicBot 存下圖片／檔案時的貼圖）。解析順序：instance → channel → 內建。Discord 可用伺服器自訂 emoji（`<:name:id>`、`<a:name:id>`、`name:id`）；Telegram 只接受固定反應集合，無效值只警告一次並退回內建值。Settings 可用選擇器編輯（Discord 會列出伺服器自訂 emoji），預覽與 bot 實際 react 的結果一致。連線層級的 `status_emojis` 修改會在 bot 下一次蓋戳記時生效，不需重啟（各 agent 的「避免使用」清單在它下次啟動時更新）。`progress_prefix` 不是反應，而是進度訊息開頭的 emoji |
| `description` | string | — | 角色描述，加入 backend 原生指令中的 `## Role` |
| `tags` | string[] | — | 用於探索 instance 能力的標籤 |
| `topic_id` | number\|string | 自動 | 頻道 topic/thread ID。建立時自動分配 |
| `channel_id` | string | — | 多連線模式中綁定的 adapter ID |
| `general_topic` | boolean | `false` | 標記為 General Topic（接收未路由的訊息） |
| `backend` | string | `"claude-code"` | CLI backend：`claude-code`、`codex`、`opencode`、`kiro-cli`、`antigravity`、`grok`、`muse` |
| `kiro_ui` | `"legacy"` \| `"tui"` | `"legacy"` | 僅供 Kiro 使用的啟動模式。`legacy` 跑在 kiro 的 v1 engine，`tui` 跑在 v2 engine；每次啟動都會明確指定，kiro-cli 的預設值或已存的設定都無法把 instance 換到別的 engine（#1109）。在 Kiro v3 介面能無人值守執行之前，`"v3"` 會被設定驗證拒絕（#849）。 |
| `auto_pause_after` | number | `0`（停用） | 閒置多少分鐘後自動暫停。0 = 不暫停。 |
| `model` | string | — | 模型覆寫；有效名稱與格式依 backend 而定 |
| `model_failover` | string[] | — | 被限速時的備用模型（例：`["opus", "sonnet"]`）。5 分鐘冷卻期，防止同一時間窗口內重複 failover |
| `agent_mode` | `"mcp"` \| `"cli"` | `"mcp"` | 所有 backend（含 Antigravity）的預設通訊模式為 MCP；`"cli"` 改用 `agend-agent` HTTP 指令，不啟動 MCP server |
| `tool_set` | string | `"worker"` | 工具組：`worker`（預設 —— 對話、查詢、做事，沒有管理 fleet 的動詞）、`coordinator`（worker 再加上建立／刪除／重啟 instance、deploy、team、schedule 等）、`full`（全部）、`standard`（30 個）、`minimal`（9 個）。`general` 不可手設：它由 `general_topic` 指派，手寫會驗證失敗。 |
| `tool_progress` | `"off"` \| `"standard"` \| `"verbose"` | `"off"` | 頻道進度泡泡中的工具活動：`standard` 只列語意標籤、不含 shell 參數；`verbose` 加上截短的命令預覽。預設關閉，啟用後會向頻道顯示活動 |
| `effort` | string | — | 預設推理強度（`low`／`medium`／`high`／`xhigh`／`max`，依 backend 限制）。每次啟動（包括接續對話的啟動）都會在 CLI 接受時傳入：`--effort`（claude-code、kiro-cli、antigravity）、`--reasoning-effort`（grok、muse）、`-c model_reasoning_effort`（codex）。claude-code、grok 和 antigravity 需由已安裝版本的 `--help` 列出這個參數；kiro-cli 依版本判斷，codex 則要求模型目錄列出的等級。各 backend 只接受支援的等級；否則 instance 用 CLI 自己的設定啟動，並在紀錄分頁說明原因。antigravity 的模型清單是每個等級各一個模型，所以推理強度會選那個等級的模型（`gemini-3.8-flash-medium` 加 `high` 會以 `gemini-3.8-flash-high` 啟動），`--effort` 不會和 `--model` 一起傳；模型沒有的等級就用設定的模型啟動、不帶推理強度。執行中可用 `/effort` 覆寫 |
| `backend_options` | object | — | 以 backend 名稱為鍵的選項，如 `{ codex: { provider: "glm" } }`；`credential_profile` 見下方帳號隔離章節，`claude-code.prompt_cache_ttl` 見「Claude 提示快取 TTL」 |
| `terminal.enabled` | boolean | `true` | 啟用邏輯終端大小；`false` 固定為相容用的 80×24 |
| `terminal.columns` | number | `120` | 啟用時的寬度；整數 `80`–`300` |
| `terminal.rows` | number | `36` | 啟用時的高度；整數 `24`–`120` |
| `mcp_auto_restart` | boolean | `true` | MCP 死亡或 CLI 啟動後 90 秒仍未連線時重啟並 resume；通常等 idle，但有 30 分鐘強制重啟上限；未解決的 auth 問題會抑制自動重啟。`false` 只通知 |
| `mcp_proxy_reply` | boolean | `false` | 自願啟用：人類回合結束時若 MCP 已死且未送回覆，daemon 將 pane 最後文字轉貼到頻道並標 ⚠️。原始 pane 文字可能洩漏無法完整遮蔽的內容，預設關閉 |
| `reply_completion_guard` | boolean | `true` | 人類回合結束卻未送出回覆時，一次有界的補結論機制；必須有 backend 支援：Claude Code、成功建立的 Kiro legacy/TUI 啟動，以及 Codex 與 Muse（僅限 CLI 自己的紀錄顯示該輪已結束時）；Kiro v3 與其他 backend 不啟用。Classic defaults／個別 channel 也可設定 |
| `systemPrompt` | string | — | 額外指令：內嵌字串或 `file:path`，透過下方列出的 backend 原生指令路徑載入。相對檔案路徑以 instance 的 `working_directory` 解析；多個部分以逗號連接，見 [features](features.zh-TW.md#systemprompt-檔案路徑-systemprompt-file-paths) |
| `workflow` | string \| false | `"builtin"` | 工作流程：`"builtin"`、`"file:path"`、內嵌內容或 `false`。可放在 instance 或 `defaults`，不可放在 fleet.yaml 頂層 |
| `skipPermissions` | boolean | 未設 `false` 時視為 `true` | 依 backend 使用不同 bypass flag，見[安全邊界](SECURITY.zh-TW.md)。OpenCode：其 `--help` 有列 `--auto` 時以 `--auto` 啟動（明確的 `deny` 規則仍然有效）；舊版沒有啟動開關，prompt 由執行期回答「Allow once」 |
| `cross_instance_visibility` | `"full"` \| `"summary"` \| `"hidden"` | `"full"` | Agent 之間（跨 instance）的訊息在此 instance 主題與 web chat 中顯示多少，不論它是發送方還是接收方：`full` 完整訊息（與以往相同）、`summary` 一行、`hidden` 不顯示。在 `defaults` 設定整個 fleet（也可用 `/visibility`），在這裡為單一 instance 覆寫；Settings 兩者都有。立即生效，不需重啟。訊息送達與 Mirror Topic 一律不受影響 —— 見 [features](features.zh-TW.md#agent-之間的訊息顯示-bot-to-bot-message-visibility)。 |
| `lightweight` | boolean | `false` | 跳過 transcript monitor、context guardian 等非必要子系統 |
| `pre_task_command` | string | — | 每次使用者訊息之前貼入的原始命令 |
| `startup_timeout_ms` | number | `25000` | CLI 啟動預算（毫秒） |
| `log_level` | string | `"info"` | `trace`、`debug`、`info`、`warn`、`error` |
| `restart_policy` | object | 見下方 | 崩潰恢復設定 |
| `context_guardian` | object | 見下方 | Context 監控設定 |
| `cost_guard` | object | — | 每 instance 花費守衛（覆蓋預設值） |
| `worktree_source` | string | — | 原始 repo 路徑（使用 branch 參數時自動設定） |

### restart_policy

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `max_retries` | number | `10` | 最大重試次數 |
| `backoff` | `"exponential"` \| `"linear"` | `"exponential"` | 重試策略 |
| `reset_after` | number | `300` | 穩定多少秒後重置重試計數 |
| `health_check_interval_ms` | number | `30000` | 健康檢查間隔（毫秒） |

### context_guardian

Context 監控設定。Guardian 輪詢 CLI 的 statusline 以取得 context 使用量指標（用於儀表板和日誌）。Context 限制由各 CLI 內建的 auto-compact 處理 — AgEnD 不會根據 context 使用量或 session 存留時間觸發重啟。

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `grace_period_ms` | number | — | 已棄用的相容欄位；忽略並在驗證時警告，沒有內建預設值 |
| `max_age_hours` | number | — | 已棄用的相容欄位；忽略並在驗證時警告，沒有內建預設值 |

---

## Fleet context 注入機制

MCP server instructions 提供精簡的身分、回覆與跨 instance 通訊契約。完整的 fleet
指引——角色、workflow、選定的 decisions 與 `systemPrompt`——走各 backend 的原生
指令路徑：

| Backend | 完整指令的載入路徑 |
|---------|-------------------|
| Claude Code | Instance 內的 `fleet-instructions.md`，用附加式 `--append-system-prompt-file` 載入 |
| Codex | 工作目錄 `AGENTS.md` 中由 AgEnD 管理的 marker 區塊 |
| Kiro CLI | instance 自己的 agent `.kiro/agents/agend-<instance>-<fleet>.json` 的 `prompt`；kiro-cli 2.21 以前，以及恢復的對話（切換成 instance 自己 agent 的步驟已暫停，#1800），用 steering 檔 `.kiro/steering/agend-<instance>.md`。恢復時 AgEnD 兩個檔都會寫；本來就以 instance 自己 agent 存檔的對話，讀的是 agent 的 `prompt`，不是 steering 檔 |
| OpenCode | Instance 內的 `fleet-instructions.md`，加入專案 `opencode.json` 的 `instructions` 陣列 |
| Antigravity | 工作目錄 `.agents/AGENTS.md` 中的 marker 區塊 |
| Grok／Muse | 工作目錄 `AGENTS.md` 中的 marker 區塊 |

完整 marker 區塊的正常更新會保留周圍內容；清理缺少 END marker 的破損區塊時，
可能移除 BEGIN 到檔尾。OpenCode 與 Kiro 的完整 fleet context 不依賴
CLI 是否讀取 MCP `instructions`；Codex 的專案文件大小限制仍可能截短大型 `AGENTS.md`。

`workflow` 請放在 `defaults.workflow` 或 `instances.<name>.workflow`，**不是
fleet.yaml 頂層**。預設 `"builtin"`，也可用內嵌內容、`file:path` 或 `false`。
`systemPrompt` 同樣走上述原生路徑：可寫內嵌字串或 `file:path`，並非只透過 MCP 傳入。
`workflow` 與 `systemPrompt` 的相對檔案路徑以 instance 的 `working_directory`
解析（#1314；只在舊的 fleet 目錄位置找得到的檔案目前仍會使用，並發出棄用警告）。

### Active Decisions

Fleet 啟動時預載最多 20 筆 active decisions，每筆內容截到 200 字元；daemon 再篩選
相關條目，指令最多顯示 15 筆摘要、每筆最多 120 字元，並提示用 `list_decisions`
查看其餘條目。這是啟動時的快照，不是即時推播；要看完整、最新或啟動後新增的 decisions，
請呼叫 `list_decisions`。

### Session snapshots

崩潰恢復可寫入 `rotation-state.json`；歷史檔名不代表目前仍依 Context 用量輪替。
之後啟動時，daemon 讀取 snapshot，並嘗試以 `[system:session-snapshot]`
前綴送入作為背景脈絡，不嵌入指令檔。讀取後會標記為本次啟動已消費，並嘗試刪除
檔案，正常情況下不會每次重啟再送。

---

## 密鑰

位置：`~/.agend/.env`

```
AGEND_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # 選用，語音轉文字
```

`~/.agend/.env` 的值優先於繼承的 shell 環境變數。這確保 `.env` 中設定的密鑰不會被 shell profile 中的變數意外覆蓋。

## classicBot.yaml

ClassicBot 模式使用獨立設定檔 `~/.agend/classicBot.yaml`。首次在 Discord 文字頻道使用 `/start` 時自動建立，也可手動編輯。

```yaml
# ClassicBot 設定
# 可用 backends: claude-code, codex, opencode, kiro-cli, antigravity, grok, muse
defaults:
  backend: claude-code          # 所有 classic channel 的預設 backend

channels:
  general-chat:                 # YAML key 可自訂；實際 ID 與名稱由下列欄位指定
    channelId: "1234567890"     # Discord channel ID
    name: "general-chat"       # 推導 instance 名稱時使用
    backend: antigravity        # 可選：覆蓋此 channel 的預設 backend
    createdBy: "123456789012345678"
    createdAt: "2026-04-12T02:00:00Z"
  dev-help:
    channelId: "9876543210"     # 未設定 backend → 使用 defaults.backend
    name: "dev-help"
    createdBy: "123456789012345678"
    createdAt: "2026-04-12T02:10:00Z"
```

### 主要行為

- **Backend 優先順序**：channel `backend` → `defaults.backend` → `fleet.yaml` `defaults.backend` → `claude-code`
- **自動更新**：`/start` 新增 channel，`/stop` 移除 channel
- **重新載入**：每 30 秒偵測變更；backend、model、自動暫停或 profile 等啟動設定改變時，會重啟執行中的 agent；支援的執行期設定則直接套用。
- **Instance 命名**：`classic-<sanitized-channel-name>-<channelId末4碼>`；非主要連線加上經清理的 adapter 後綴。已保存的 `instanceName` 優先，否則由 `name`（未填時為 channel ID）推導，不直接取自任意 YAML key
- **Discord auto-collab**：`/start` 自動開啟 collab；訊息會記錄為脈絡，但觸發回合仍需 @ bot
- **Fleet `/collab`**：逐 instance 的記憶體開關，fleet 重啟後重置；讓 bot／webhook 訊息通過 fleet topic 的 bot 篩選，不取代存取控制
- **`agend ls`**：classic instance 會顯示 `(classic)` 標籤

### 額外欄位

| 欄位 | 類型 | 說明 |
|------|------|------|
| `defaults.model` | string | 所有 classic channel 的預設模型 |
| `defaults.auto_pause_after` | number | 閒置幾分鐘後暫停；`0` 停用，未設時繼承 |
| `defaults.tool_progress` | `off` \| `standard` \| `verbose` | 處理中氣泡的詳細程度，未設時繼承 |
| `defaults.context_lines` | number | 每次訊息前注入的聊天記錄行數（預設 5，設 0 停用） |
| `defaults.allowed_guilds` | string[] | 獲准新啟動 ClassicBot 的 Discord 伺服器 ID（空白／省略會申請核准） |
| `defaults.allowed_groups` | string[] | 獲准存取的 Telegram 群組 ID（空白／省略會申請核准） |
| `defaults.allowed_users` | string[] | 獲准新啟動的 Telegram 私訊使用者 ID（空白／省略會申請核准） |
| `defaults.admin_users` | string[] | Classic 管理者 ID；平台間的指令 gate 不同，見[指令介面矩陣](command-surface.zh-TW.md)。Classic Telegram `/raw` 目前被擋住；Fleet 隱藏 `/raw` 須有 owning bot 的 F |
| `defaults.reply_completion_guard` | boolean | 個別 channel → Classic defaults → fleet defaults → `true`；仍需上述 backend capability |
| `channels.<key>.channelId` | string | 真實 channel／chat ID；未填時使用 YAML key |
| `channels.<key>.name` | string | 顯示名稱；未填時使用 channel ID |
| `channels.<key>.adapterId` | string | 所屬 bot 連線；非主要連線的自動 instance 名稱會加上 adapter 後綴 |
| `channels.<key>.instanceName` | string | 已保存的明確 instance 名稱，優先於自動命名 |
| `channels.<key>.model` | string | 個別 channel 模型覆蓋 |
| `channels.<key>.context_lines` | number | 個別 channel 聊天記錄行數 |
| `channels.<key>.auto_pause_after` | number | 閒置幾分鐘後暫停；`0` 停用，未設時繼承 |
| `channels.<key>.tool_progress` | `off` \| `standard` \| `verbose` | 處理中氣泡的詳細程度，未設時繼承 |
| `channels.<key>.backend_options` | object | 與預設合併的 backend 選項，包括 credential profile |
| `channels.<key>.display_name` / `description` | string | Agent 顯示名稱與說明 |
| `channels.<key>.web_echo` | boolean | 此 ClassicBot 聊天室的 web chat 同步；未設定時依 `web.echo_to_channel`（預設開啟），`false` 讓這個聊天室保持關閉 |
| `channels.<key>.reply_completion_guard` | boolean | 個別 channel 的人類回覆 guard 覆寫 |
| `channels.<key>.collab` | boolean | @mention 觸發的協作模式（預設 `false`） |
| `channels.<key>.pre_task_command` | string | 每次訊息前貼入的原始命令 |

新啟動時，ClassicBot 管理員（`admin_users`）可直接啟動；其他使用者須有明確的伺服器／私訊使用者授權，否則透過 General 的「允許／允許＋設為管理員／忽略」按鈕申請。Telegram 私訊核准加入 `allowed_users`。Telegram 群組仍須由 ClassicBot 管理員啟動；「允許」只授權群組，「允許＋設為管理員」另提升申請者。既有已註冊頻道繼續運作，Discord DM 仍不支援。核准不會自動啟動 Agent，請再次 `/start`（群組用 `/start@OurBot`）。

### 手動管理

可手動編輯 `classicBot.yaml`：
- 變更所有 classic channel 的預設 backend
- 覆蓋特定 channel 的 backend
- 移除 channel（等同 `/stop`）
- 新增 channel（下次 reload 時載入，但需重啟 fleet 才會啟動 instance）

### Telegram ClassicBot 指令

群組內請明確指定 bot：`/start@YourBot codex`，或用 `/start@YourBot` 開啟 backend
選單；名稱是 Telegram bot username，不是 AgEnD instance 名稱。群組中的裸指令
（沒有 `@YourBot`）會忽略；私聊可直接用 `/start`。

每個 bot 連線都有自己的 Classic 註冊與訊息 dedup 範圍，首次註冊前也一樣。
同一 fleet 的多個 bot 收到同一則群組訊息時，其他 bot 拒絕 `/start@YourBot`
不會先吃掉目標 bot 的 copy；同一 bot 的重送仍會去重。群組／使用者白名單及群組
`/start` 的管理員要求並未放寬。

這只適用於 AgEnD 已收到的 update。Telegram privacy mode 影響哪些群組訊息會傳給
bot，見[官方 FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)。
指定 bot 的指令失敗時，先確認目標 adapter 是否收到 update，再查 polling／webhook
錯誤與路由；僅憑另一個 bot 在線不能判定訊息在哪一層消失。

---

## Claude 提示快取 TTL

`backend_options.claude-code.prompt_cache_ttl` 決定 Claude Code 要求 API 保留提示快取多久：`"1h"` 或 `"5m"`。不設定（預設）時由 CLI 自行決定。

```yaml
instances:
  reviewer:
    backend: claude-code
    backend_options:
      claude-code:
        prompt_cache_ttl: "1h"
```

- **如何傳入：** AgEnD 啟動 instance 時，會把 `CLAUDE_CODE_PROMPT_CACHE_TTL` 和 `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` 設成這個值，涵蓋主對話與它的子代理。
- **何時生效：** 在 instance 下次啟動或重新啟動時。
- **費用：** 1 小時的快取寫入比 5 分鐘的貴（基本輸入價的 2 倍對 1.25 倍）。只有在 instance 的閒置空檔原本會讓快取過期時才划算。
  - **Fleet → 快取** 會顯示它的空檔有多常超過 TTL，以及因此多花的費用。
  - 對 5 分鐘快取，也會顯示它實際能撐多久（**實際存活**）。當快取在 5–60 分鐘的空檔中確實會過期時，卡片會建議設定 `"1h"`。
- **計費方式：** 明確設定的值會略過 CLI 自己對訂閱與額外用量的檢查，因此不論帳號的計費方式都會套用。但下列限制仍然適用。
- **限制：**
  - 需要 Claude Code 2.1.242 或更新版本。
  - fleet 環境中若有 `FORCE_PROMPT_CACHING_5M=1`，會蓋過這個設定，維持 5 分鐘。
  - 1 小時快取需要支援它的 API gateway 或雲端供應商。請見 Claude Code 的[提示快取說明](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself)。

## Credential profiles（同一 backend 的多個帳號）

Kiro CLI、Codex 與 Claude Code 支援 `backend_options.<backend>.credential_profile`，選擇與預設
共用登入分開的帳號。其他 backend 尚未實作，設定後會警告此選項被忽略。
名稱必須符合 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`；可放在 instance 或 defaults：

```yaml
instances:
  work-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: work
  personal-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: personal
```

同一有效 profile 共用登入，不同名稱各自隔離。某個 profile 的登入過期時，警示會寫出該 profile、只列出用它的
instance，並附上為它登入的指令。繼承 defaults 後仍無有效 profile 時，
不新增 profile 目錄，也不修改原本的共用登入啟動方式。Profile 位於
`~/.agend/credential-profiles/<backend>/<profile>`，可由多個 instance 共用。

### Kiro

在主機先登入一次：

```bash
XDG_DATA_HOME=~/.agend/credential-profiles/kiro-cli/work kiro-cli login
```

Kiro 的登入／對話資料庫為私有真檔案，不會把資料庫 symlink 回共用登入。
大型 runtime cache（`kas`、`node`、`bun`、`cli-checkouts`）則連回共用副本。
新 profile 除這些 cache 外起初為空；`knowledge_bases`、shell `history` 等資料也屬於
profile，要共用時需自行複製。

用設定更新切換現有 agent：

```
update_instance_config(name: "research-a",
  config: { backend_options: { "kiro-cli": { credential_profile: "personal" } } })
```

啟動選項改變時會重啟 running instance，回覆會說明重啟是否成功；paused／stopped／
crashed instance 不因此啟動，下次啟動才讀取新設定。`credential_profile: null` 清除
instance 覆寫並繼承 fleet 預設；未繼承具名 profile 時才使用共用登入。

`update_instance_config` 將有效 profile 名稱改為另一個具名 profile 時，會檢查是否有
可辨識的已存登入；缺少時拒絕切換並附登入指令。這不驗證 token 是否過期，也不保證
手動編輯 YAML 後的啟動會套用同一檢查。回到共用登入不受具名 profile 的登入檢查限制。

**切換 running Kiro instance 會開新對話。** 它把登入與對話存於同一個 `data.sqlite3`，
換 profile 就換了一整份對話集合。AgEnD 該次啟動會跳過 resume，並嘗試用 daemon
buffer 的近期訊息／活動交接，不搬移 CLI 對話庫。重啟成功後回傳
`conversation_carried_over: false` 與 `handover_chars`；後者只計經 IPC 送出的脈絡長度，
不代表已處理，可能為 0。更新未執行的 instance 時，不做此交接，也不回傳這些欄位。

### Codex

```bash
CODEX_HOME=~/.agend/credential-profiles/codex/work codex login
```

Codex profile **只換 `auth.json` 的來源**。Instance 仍使用自己的 CODEX_HOME 與
私有 `config.toml`；對話與 thread/state/memory 資料庫仍共用，因此切換不刻意開新對話，
兩個帳號可見相同歷史。這與 Kiro 的檔案布局不同。

尚未用第二個付費帳號驗證跨帳號對話能否重新開啟，以及兩個帳號是否確實分開計費；
不要把共用歷史等同於保證跨帳號 resume 成功。

### Claude Code

在聊天室為 profile 登入（fleet admin）：

```
/login claude-code work
```

它會在 `/login claude-code` 用的同一個瀏覽器終端裡，為該 profile 執行 `claude auth login`，
所以用手機也能完成。Discord 上用 `/login` 並選 `backend: claude-code`、`profile: work`。
也可以在主機上登入：

```bash
CLAUDE_CONFIG_DIR=~/.agend/credential-profiles/claude-code/work claude auth login
```

登入成功後，AgEnD 只喚醒或重啟使用該登入的 instance：profile 登入不會動到使用預設登入的
instance，反之亦然。Kiro 與 Codex 的 profile 仍要在主機上登入：`/login kiro-cli work`
會回覆要在主機執行的完整指令。

Claude Code profile 是一個獨立的 `CLAUDE_CONFIG_DIR`。登入、帳號、各專案的信任設定、
`settings.json` 與所有對話（`projects/`、`sessions/`、`history.jsonl`）都屬於該 profile。
你的 `CLAUDE.md`、`agents`、`commands`、`skills`、`output-styles` 與 `plugins` 連回
`~/.claude`（或你自己設定的 `CLAUDE_CONFIG_DIR`），各處相同。新 profile 的 `settings.json`
一開始複製你的設定（permissions、hooks、env、啟用哪些 plugins）；之後就屬於該 profile，
任一邊後來的變更（例如 `/model`）只留在那一邊。

Claude Code 對專案的自動記憶（`projects/<repo>/memory/`）也以同樣方式共用：每次以 profile
啟動時，該 instance 所在 repository（git worktree 以主 checkout 為準）在 profile 裡的記憶
資料夾會連到 `~/.claude` 底下的那一份，所以同一個 repository 的每個 instance 不論用哪個登入，
都共用同一份記憶。只有記憶共用，旁邊的對話仍屬於該 profile。profile 裡已經有筆記的記憶資料夾
絕不會被取代：AgEnD 會保持原樣並記錄警告。

macOS 上 claude 把登入存在鑰匙圈（Keychain），項目名稱依 profile 目錄而定；
兩個 profile 不會共用或覆寫彼此的項目，預設登入也不受影響。

`update_instance_config` 拒絕切換時，請用 `/login claude-code <profile>`，或照回覆中的指令原樣執行：它帶著 AgEnD 啟動時用的完整絕對路徑，
而 macOS 的鑰匙圈項目正是依這個路徑字串命名。

沒有 profile 的 instance 啟動方式與以前完全相同：AgEnD 不設定 `CLAUDE_CONFIG_DIR`
（你自己設的照舊生效），也不建立任何目錄。Fleet 的 `ANTHROPIC_API_KEY` 只傳給「自己的
設定目錄沒有 claude.ai 登入」的 instance——規則與以前相同，只是看的是 profile 的目錄。

**切換 running Claude Code instance 會保留原本的對話**（#1753）。舊 CLI 停下、新 CLI 啟動之間，AgEnD 會把這個
session 的對話紀錄（`projects/<目錄>/<session>.jsonl`）、它的資料夾與檔案歷史複製到新 profile，並把副本設成最新的一份，
讓重啟時的 `--continue` 接上它。
- 舊 profile 保留自己那份，所以切回去會回到同一段對話（含期間新增的部分）。
- 下一次回覆會在快取為空的狀態下重讀整段對話：這一輪會比較慢，並以完整價格計費。
- 回覆會帶 `conversation_carried_over: true`。
- 設定與登入仍各屬各的 profile，兩邊其他對話紀錄維持原狀。專案自動記憶依上文共用；profile 已有非空記憶目錄時會保留。

無法複製時，切換會開新對話，交接方式與 Kiro 相同，回覆的 `carry_failed` 會說明原因。可能的原因有：還沒有 session、
新 profile 已有這段對話的另一個版本、空間不足，或複製失敗。

### 各自的額度

`/usage`、`get_usage` 與 dashboard 依 running／paused instance 的有效 backend／profile
分別顯示。例如有效的 Kiro `work`／`personal` profile 顯示為 `Kiro (work)`、
`Kiro (personal)`；使用共用登入時顯示預設列。僅供 stopped／crashed instance 使用的
來源會被過濾。

Claude Code profile 也有自己的額度列：`Claude (work)` 只讀 `work` profile 自己的登入
（macOS 上是它的鑰匙圈項目），不會讀預設登入。用量 API 無法回應時，各列只會改用自己
instance 的 statusline 寫下的額度。尚未登入的 profile 會顯示「尚未登入」、
`/login claude-code <profile>` 與在主機上登入用的那行指令，不會顯示其他帳號的數字。沒有 Claude profile 的 fleet 仍只有一列 `Claude`，
與以前完全相同。

有效的 Kiro profile 沒有可讀登入資料時仍顯示 signed-out 提示。是否顯示也依 provider
而異：Codex 缺少 OAuth 額度查詢憑證時會省略，包括只有 API key 的 profile。各列不相加；
不同 profile 名稱不保證不同計費帳號。

---

## 資料目錄

`~/.agend/`：

| 路徑 | 用途 |
|------|------|
| `fleet.yaml` | Fleet 設定檔 |
| `classicBot.yaml` | ClassicBot channel 設定（per-channel backend） |
| `.env` | Bot token + API keys |
| `daemon.log` | Fleet daemon 日誌 |
| `fleet.pid` | Fleet manager PID |
| `scheduler.db` | 排程 + 決策 + 任務（SQLite） |
| `events.db` | 事件日誌 + 活動日誌（SQLite） |
| `access/access.json` | 存取控制狀態 |
| `instances/<name>/` | 每個 instance 的運行時資料 |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/statusline.json` | 最新 CLI 狀態 |
| `instances/<name>/rotation-state.json` | 崩潰恢復 snapshot（之後啟動時一次性消費，不依 Context 用量輪替） |

### Web chat 主題同步（2.2 web 線）

fleet-topic instance 預設會將 web chat 訊息同步至自己綁定的 Telegram 或 Discord 主題。可設定 `web.echo_to_channel: false` 關閉，或在 **Settings → 網頁 → 網頁聊天** 切換。同步文字使用 `🌐 web · <名字>: …`（網頁使用者的名字，沒有時是 `web-user`，#1827），附件只顯示檔名，長文字會附上請看 web chat 的提示。這只是顯示副本：bot 自己的訊息不會觸發 Agent 新回合。純 web fleet 不做同步。ClassicBot 聊天室（包括群組頻道）也會同步：`classicBot.yaml` 裡沒有設定 `channels.<key>.web_echo` 的聊天室，依照 `web.echo_to_channel`（因此預設開啟，全 fleet 關閉時也跟著關閉）；設為 `false` 讓該聊天室保持關閉，設為 `true` 則不論全 fleet 的開關都保持開啟（#2054）。同步失敗只記錄日誌，不會使 web 投遞失敗或延遲。每筆副本的排序等待總共最多五秒，包含排隊與 admission；平台請求結束或期限到達後，Agent 回覆就繼續。逾時會丟棄尚未開始的副本並記 warn；已在飛的副本可能晚於回覆出現，其晚到結果另記日誌。不自動重送副本。

同步本文與附件名稱的 mention／command token 改成可見 ASCII 標籤，例如 `[mention: 200]`、`[at: botname]`、`[command: cmd at bot]`。先做相容正規化與 format-character 移除；URL、email local part 與一般路徑斜線保留。Discord 另設定 `allowedMentions: { parse: [] }`；Telegram 傳送不含 mention entities 的純文字。共用 ingress 在作者是該平台已設定的 fleet bot 帳號、且本文以固定 `🌐 web · ` 開頭時丟棄副本，不依賴 echo 開關或 send ACK。同平台只要還有任一已設定 world 的 bot 身分未知，也會在 trigger 判斷前丟棄帶平台 bot 作者旗標的前綴候選並記 debug。這段暫時隔離不影響人類貼上的前綴；身分全部就緒後，非 fleet bot 維持原 admission／collab 規則。不將未知作者當成 fleet bot，也不使用近期 message-ID cache。
