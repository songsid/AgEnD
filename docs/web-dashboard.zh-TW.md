# Web dashboard

English: [web-dashboard.md](web-dashboard.md)

AgEnD 的 web dashboard 是 fleet 自己跑的一個小型 web server，上面有三個面板：

| 面板 | 用途 |
|---|---|
| **`/ui`**：Dashboard | 跟 agent 對話（聊天、檔案、Stop）、看誰正在工作，管理 instance、task、排程與 team |
| **`/view`** | 以讀取為主的總覽：每個 agent 的即時終端、名單、用量，也可以編輯 agent 的個人檔案與頭像 |
| **`/settings`** | fleet 設定，可以套用並重啟 |

三個面板共用同一條導覽列（*Dashboard · View · Settings*）和 **Session** 選單。打開 `/` 會直接進入 dashboard。

server 只聽 **`127.0.0.1`**，port 是 `health_port`（預設 **19280**）。除非你另外開通，否則只有本機連得到，請見[從別的裝置連線](#從別的裝置連線)。

## 登入

dashboard 用**一次性登入碼**登入，絕不使用帶有憑證的連結。

1. 取得登入碼，兩種方式擇一：
   - 在 Telegram 或 Discord 傳 **`/dashboard`**（限 fleet admin）。Discord 的回覆只有你看得到；Telegram 的回覆會貼在 General topic，登入碼很快到期、而且只能用一次。
   - 在主機上執行 **`agend web`**，會印出登入碼並開啟登入頁；`agend web --code` 則只印出來、不開瀏覽器。
2. 打開登入頁，輸入 8 個字元的登入碼（`ABCD-EFGH`，有沒有連字號、大小寫都可以）。

關於登入碼：
- 只能用**一次**，**5 分鐘**後到期；只有最新的那一組有效，重新取得會取代前一組。
- 同一組輸錯 5 次就作廢；跨多組累計輸錯太多次，會暫停登入幾分鐘。還沒發出任何登入碼時，根本沒有東西可以猜。
- 每次登入都會通知 General topic（例如「New web sign-in: Chrome on macOS」），用 `web.notify_login: false` 可以關掉。

舊的 `?token=` 連結或書籤（例如舊版印出的 `/ui?token=…`）**不能**用來登入：它會開到登入頁，網址列裡的 token 也會被清掉。

## Session

- session 是伺服器上的一筆紀錄，不是存在瀏覽器裡的值。登入後最多 **12 小時**、或閒置 **2 小時**就會結束（以先到者為準）；fleet 重啟後仍然有效。
- 只有你的操作才算活動。頁面自己的背景更新（即時串流、輪詢）不會讓 session 延長。
- session 結束時，頁面會提示一次（「登入已結束。重新登入」），而且保留你畫面上正在做的事。
- **Session 選單**（上方列）會顯示：
  - 你目前用哪個瀏覽器登入、這個 session 什麼時候到期；
  - 其他已登入的裝置，每台都可以按 **Sign out**；
  - **全部登出（Sign out everywhere）**。

### 讓所有瀏覽器登出（revoke）

看到不是你做的登入，或有一台不再信任的裝置時，以下任一種方式都可以：

| 在哪裡 | 怎麼做 |
|---|---|
| Telegram | `/dashboard revoke` |
| Discord | `/dashboard` slash 指令，選 **`action: revoke`** |
| 主機上 | `agend web-token rotate`（同時也會輪替 CLI 用的 token；執行中的 fleet 會直接套用，不用重啟） |
| 瀏覽器裡 | Session 選單 →**全部登出** |

如果伺服器存不了這個變更（磁碟有問題），回覆會明確告訴你：大家**目前**都登出了，但重啟後 session 可能會回來，請先修好磁碟再 revoke 一次。

## 聊天（`/ui`）

在左側選一個 instance 就能跟它對話。web 聊天跟它的 Telegram／Discord topic 是**同一個對話**：
- 你在 web 發的訊息，會以 `🌐 web-user: …` 同步到 topic。
- agent 的回覆照常送到 Telegram／Discord，web 也會同時顯示。
- 你可以對話到一半在 web 和手機之間切換。
- **完全沒有聊天平台？** `fleet.yaml` 裡沒有設定 `channel` 或 `channels` 時，只靠 dashboard 就能用：agent 的回覆會送到 web 聊天。

### 輸入
- **Enter** 送出，**Shift+Enter** 換行。送出失敗時，文字會還給你。
- 訊息支援 **Markdown**：標題、**粗體**、*斜體*、~~刪除線~~、`code`、程式碼區塊、清單、引用、分隔線、連結。另外還有：
  - **表格**：`| a | b |`，標題列下面接一列 `|---|---|`，用 `:--` / `--:` / `:-:` 指定對齊。儲存格裡要放直線請寫 `\|`。
  - **巢狀清單**：依縮排決定層級，最多六層。
  - **程式碼上色**：標記為 `js`、`ts`、`json`、`python` 或 `sh` 的程式碼區塊會上色，其他語言照原樣顯示。
  - 連結會在新分頁開啟，而且只有 `http(s)` 和 `mailto` 會變成連結。
  - 不論是你的還是 agent 的訊息，內容都無法產生任何 HTML。
- 重新整理頁面不會清空對話：fleet 會保留每個 instance 最近的訊息。

### 檔案與圖片
- 用 **📎**、貼上或拖曳到聊天區都可以附加檔案。
- 限制：每則訊息最多 **5 個檔案**，每個 **10 MB**，合計 **25 MB**。
- 類型：**PNG、JPEG、GIF、WebP、PDF 與文字檔**。類型由檔案內容判斷，不看檔名。
- agent 收到檔案的方式跟從 Telegram 收到完全一樣：檔案會放在 instance 工作區的 inbox（`<AGEND_HOME>/workspaces/<instance>/inbox`），並附上一行 `[📷 Image: …]` 或 `[📎 File: …]`。
- agent 在回覆裡附的檔案也會顯示在聊天裡：圖片直接顯示，其他檔案則是下載，絕不會在頁面上開啟。
- 附加了但**30 分鐘內沒送出**的檔案會被刪除。這只在 fleet 一直在跑時成立；中途重啟的話，檔案會留在 inbox（[#1273](https://github.com/songsid/AgEnD/issues/1273)）。

### Ticks：訊息送到哪一步了
你送出的每則訊息都會顯示目前進度，跟 Telegram 用 reaction 表示的步驟相同：

| Tick | 意思 |
|---|---|
| ◷ | 排在別的訊息後面等待 |
| ✓ | 已交給 agent |
| ✓✓ | agent 已經收到 |
| ! | 沒送達 |
| ⊘ | 在 agent 收到前被 **Stop** 取消 |

### 「*name* is working…」與 Stop
目前打開的聊天裡的 agent 正在工作時，輸入框上方會出現這一列，以及 **Stop** 按鈕。
- Stop 的效果跟 Telegram 的取消鍵、`/cancel` 一樣：中斷 agent 目前的回覆（送 Esc），並丟掉還在排隊的訊息，它們的 ticks 會變成 ⊘。
- Stop **不會**停掉 instance 程序；要停掉程序，請用 instance 操作列裡的 Stop。

### 回應 fleet 的提示
instance 看起來卡住、自己結束，或停在互動式提示時，Telegram／Discord 上的按鈕也會出現在該 instance 的聊天裡：*Force restart* / *Keep waiting*、*Restart* / *Ignore*、*Confirm* / *Cancel*。
- 它們是**同一個提示**：不論在哪邊，先回答的算數。另一邊的按鈕隨後會顯示結果，提示也會在所有地方同時到期。
- 只有這幾種跟 instance 健康有關的提示會出現在 web 上；`/clear` 的確認、登入、ClassicBot 的核准、tips，以及 `/model`、`/effort` 選單，都會留在原本發出的地方。
- 頁面沒連線時發出的提示，重新連上後會立刻出現；如果期間已經在別處回答了，會顯示為已回答。

## `/view`

`/view` 會列出每個 agent：即時終端畫面、包含狀態與 context 的名單，以及 AI 訂閱用量。

- **讀取 `/view` 預設不用登入**（`web.view_access: open`），連即時終端也一樣，所以任何能連到這個 port 的人都看得到你的 agent。如果機器只有你連得到，這樣沒問題；否則請設定：
  ```yaml
  web:
    view_access: session   # 讀取 /view 也需要已登入的 session
  ```
- **編輯 agent 的個人檔案、頭像或側欄順序，一律需要登入。** 沒登入的人按 Edit 會先被帶去登入，再回到原頁。
- 腳本仍然可以用 `X-Agend-Token` header 寫入。

## 從別的裝置連線

server 只回應 `127.0.0.1`。要從別的裝置使用 dashboard，你需要開一條路，並告訴它別人會用哪個名稱連進來。

1. **選一種連線方式**，越前面越安全：
   - **SSH port forward**：`ssh -L 19280:127.0.0.1:19280 <host>`，然後開 `http://localhost:19280`。fleet 這邊什麼都不用改。
   - **Tailscale**（`tailscale serve`）或其他私有網路。
   - **reverse proxy 或 tunnel**（例如 Cloudflare）。建議用有名稱、有存取控制的 tunnel，而不是公開的 Quick Tunnel。
2. **允許這個名稱。** fleet 不認得的 `Host` 一律回 403，這就是擋住 DNS rebinding 的機制。把你的名稱加進去：
   ```yaml
   web:
     allowed_hosts: [dashboard.example.com]
   ```
3. **不讓陌生人看 `/view`**：設定 `web.view_access: session`，因為 `/view` 會顯示 agent 的終端畫面。
4. **使用 HTTPS。** proxy 送出 `X-Forwarded-Proto: https` 時，session cookie 會帶 `Secure`。
5. **即時更新。** 有些路徑傳不了即時串流（Server-Sent Events），例如 Cloudflare **Quick Tunnel**，或會把回應 buffer 起來的 proxy。dashboard 發現串流靜默 15 秒時，會改成每 5 秒抓一次同樣的更新；不會漏掉、也不會重複，串流恢復後會自動切回來。

不論誰連到這個網址，都還是要用你給的登入碼才能登入，而且每次登入都會通知 General。

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `health_port` | `19280` | dashboard 的 port（只聽 `127.0.0.1`） |
| `web.view_access` | `open` | `session`：讀取 `/view` 也需要登入 |
| `web.allowed_hosts` | — | 額外允許的 `Host` 名稱（經由 proxy、tunnel 或 port forward 連線時） |
| `web.notify_login` | `true` | `false`：不在 General 通知新的登入 |
| `web.usage_panel` | `true` | `false`：在 `/view` 隱藏 AI 用量面板 |

完整設定說明：[configuration.zh-TW.md](configuration.zh-TW.md)；CLI 指令：[cli.zh-TW.md](cli.zh-TW.md)。

## 安全說明

- 任何憑證都不會出現在網址裡：fleet token、登入碼、session 都一樣。
- 已登入的瀏覽器要寫入時，必須同時有 session、每個 session 專屬的 CSRF header，**以及**相符的 `Origin`；光有 cookie 什麼都改不了。用 `X-Agend-Token` header 的腳本不受影響，因為瀏覽器不會自己帶上這個 header。
- 每個面板都帶 Content-Security-Policy：script、樣式、圖片與連線都只限 dashboard 自己的位址。
  - 只會執行頁面自己的 script：每次載入都帶一個新的 nonce，script 不允許 `'unsafe-inline'`，所以被注入到頁面的標記無法執行程式碼。
  - 樣式仍允許 `'unsafe-inline'`，因為面板還有 `style` 屬性。

## 遇到問題時

| 你看到 | 原因與處理方式 |
|---|---|
| 經由 proxy 或 tunnel 打開 dashboard 時出現 **403** | 這個 `Host` 沒有被允許：把它加進 `web.allowed_hosts`。 |
| 登入頁說登入碼錯誤 | 登入碼只能用一次、5 分鐘後到期，而且只有最新的那組有效：請重新取得。 |
| 「登入已結束」 | 閒置 2 小時、登入已滿 12 小時，或有人執行了 revoke：重新登入即可。 |
| dashboard 短暫顯示「disconnected」之後又繼續更新 | 你這條連線傳不了即時串流，已改成每 5 秒輪詢：不需要處理。 |
| `/dashboard` 回覆「disabled」 | 這個 bot 沒有設定任何 fleet admin：把你的使用者加進它的 `allowed_users`。 |
