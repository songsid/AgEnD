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
- 你的操作算活動；dashboard 自己的背景更新大多不算：備援輪詢和即時串流的定期檢查都不會讓 session 延長，但即時串流每次重新連線會算一次。在 `web.view_access: session` 時，開著的 `/view` 頁面每幾秒就會自動更新，因此會讓 session 一直有效到 12 小時上限。離開時請關閉頁面或登出。
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
- **第一次來？** 在某個裝置上第一次打開 `/ui` 時，會有簡短導覽介紹 instance 清單、檔案、Stop 和「等你回應」標記。側欄最下方的**導覽**可以再看一次。

### 版面
- 對話是置中的一欄。你的訊息是靠右的泡泡；agent 的回覆佔滿整欄，每則都有 **複製**。
- **程式碼區塊**會標出語言，並有 **複製** 與 **換行**（長行改為換行而不是橫向捲動，這個瀏覽器會記住）。超過 30 行的區塊會先收合，按 **展開全部 N 行** 打開。
- 只有在你停在最底部時，畫面才會跟著新訊息捲動。往上捲去看舊訊息時，畫面會留在原處，按 **↓ N 則新訊息** 回到最下面。
- 側欄頂端的 **‹** 可以隱藏側欄（按 ☰ 叫回來），這個選擇會被記住。在手機上側欄是抽屜：按 ☰ 打開，選了東西、點旁邊或按 Esc 就會關上。
- **Theme**（側欄底部）：*System* 跟隨裝置的淺色／深色設定；*Light* 或 *Dark* 則在這個瀏覽器固定使用。
- **在手機上**，螢幕鍵盤出現時頁面會跟著縮小，輸入框會留在鍵盤上方；版面也會避開瀏海與底部的 home bar。

### 鍵盤與螢幕閱讀器
- agent 工作時按 **Esc** 會中止它的回覆，就像在它的終端機按 Esc 一樣。agent 閒置時沒有作用；有表單或選單開著時，Esc 會先關掉它們。
- 側欄的每一列都可以用 **Tab** 移到，再按 **Enter** 或 **空白鍵** 打開。在手機上，抽屜打開時焦點會留在抽屜裡，關上後回到 ☰。
- 訊息不會在到達時被逐則朗讀。螢幕閱讀器只會聽到粗略的事件，每個一次：agent 開始工作、完成、已回覆，或正在等你回應。對話本身是可以瀏覽的紀錄。

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
- 用 **📎**、貼上或拖曳到聊天區都可以附加檔案（拖曳時會顯示放置位置）。每個檔案會以標籤顯示在輸入框上方，附上檔名與大小，按 **✕** 移除。
- 貼上超過 **10,000 個字元**的文字時，會改成文字檔附加，而不是塞進輸入框；按標籤上的 **改為文字** 可以放回輸入框。
- 限制：每則訊息最多 **5 個檔案**，每個 **10 MB**，合計 **25 MB**。
- 類型：**PNG、JPEG、GIF、WebP、PDF 與文字檔**。類型由檔案內容判斷，不看檔名。
- agent 收到檔案的方式跟從 Telegram 收到完全一樣：檔案會放在 instance 工作區的 inbox（`<AGEND_HOME>/workspaces/<instance>/inbox`），並附上一行 `[📷 Image: …]` 或 `[📎 File: …]`。
- agent 在回覆裡附的檔案也會顯示在聊天裡：圖片直接顯示，其他檔案則是下載，絕不會在頁面上開啟。
- 附加了但**30 分鐘內沒送出**的檔案會被刪除。fleet 重啟後，留下的這類檔案也會在啟動時、放滿 30 分鐘後刪除。
- 已送出的檔案會在 inbox 保留 **7 天**，跟從 Telegram 收到的檔案一樣。

### HTML 預覽
agent 的回覆裡有 ` ```html ` 區塊時，下方會出現一張卡片，可以幫你執行那段 HTML。
- **每台裝置預設都是關閉的，要你自己打開。** 用側欄底部的 **Allow HTML previews on this device**，或卡片的 **⋯** 選單。它只會問一次，並說明這代表什麼；關掉時，所有正在執行的預覽都會停止。
- **每次都要你按下才會執行。** **預覽** 會在卡片下方的框架裡執行，並顯示這段說明：*「Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab.」* 按 **停止** 關閉。一次只會執行一個預覽。
- **下載** 會把 HTML 存成 `reply.html`，絕不會在 dashboard 裡開啟。
- **它能做什麼、不能做什麼。** 預覽在另一個位址的沙箱裡執行，所以無法使用你的登入、讀取你的 session，也無法操作 dashboard。但它**可能**可以把資料傳出去（沒有瀏覽器能擋住所有管道），所以只預覽你信任的 HTML。
- **只有 agent 的回覆**（由 fleet 標記）才會有卡片。來自人的 HTML（web、Telegram 或 Discord）一律只顯示成程式碼。被長度上限截斷的區塊不會有預覽：請 agent 改用 `.html` 檔案傳送。
- **在哪裡能用。** 預覽來自第二個本機 port：`health_port + 1`（19281）。透過 SSH 使用時也要轉送它：`ssh -L 19280:127.0.0.1:19280 -L 19281:127.0.0.1:19281 <host>`。透過 tunnel 或 proxy 時需要設定 `web.preview_origin`（對應到那個 port 的另一個主機名稱），而且 proxy 必須原樣傳遞外部的 `Host`。不符合時，卡片會說明預覽為什麼關閉，只提供程式碼與 **下載**。
- **⋯ → 這台裝置永不預覽 HTML** 會在這個瀏覽器工作階段裡，隱藏所有卡片的 **預覽**。
- **卡住的預覽** 可以按 **停止** 關掉；但它可能繼續佔用該分頁的預覽程序，之後在同一個分頁裡的新預覽可能無法啟動，請在新分頁打開 dashboard。

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
目前打開的聊天裡的 agent 正在工作時，輸入框上方會出現這一列，輸入框的 **送出** 也會變成 **Stop**。開始打字後 **送出** 會回到旁邊：agent 工作時送出的訊息會排隊等下一輪。
- Stop 的效果跟 Telegram 的取消鍵、`/cancel` 一樣：中斷 agent 目前的回覆（送 Esc），並丟掉還在排隊的訊息，它們的 ticks 會變成 ⊘。
- Stop **不會**停掉 instance 程序；要停掉程序，請用 instance 操作列裡的 Stop。
- 這一列會顯示 agent 已經工作多久（從這個頁面看到它開始工作起算）。按下 Stop 後會顯示「正在中止 *name*…」，直到 agent 停下來。
- agent 停在終端機上等待（權限詢問、登入、對話框）時，這一列會顯示「*name* 正在等你回應」，側欄上的 instance 也會出現 **等你回應** 標記。這是從終端畫面判讀的，請當作參考。可以用下方的提示按鈕回應，或到主機上處理。

### 回應 fleet 的提示
instance 看起來卡住、自己結束，或停在互動式提示時，Telegram／Discord 上的按鈕也會出現在該 instance 的聊天裡：*Force restart* / *Keep waiting*、*Restart* / *Ignore*、*Confirm* / *Cancel*。
- 它們是**同一個提示**：不論在哪邊，先回答的算數。另一邊的按鈕隨後會顯示結果，提示也會在所有地方同時到期。
- 只有這幾種跟 instance 健康有關的提示會出現在 web 上；`/clear` 的確認、登入、ClassicBot 的核准、tips，以及 `/model`、`/effort` 選單，都會留在原本發出的地方。
- 頁面沒連線時發出的提示，重新連上後會立刻出現；如果期間已經在別處回答了，會顯示為已回答。
- **沒有聊天平台？** 只用 dashboard 的 fleet，這些提示會直接出現在該 instance 的聊天裡。互動式提示的 *Confirm* 是請 General instance 協助，所以只有 fleet 有 General 時才會出現。

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
| `web.preview` | `true` | `false`：完全不提供 HTML 預覽（卡片只顯示程式碼與下載） |
| `web.preview_port` | `health_port + 1` | 預覽 listener 的 port（只聽 `127.0.0.1`） |
| `web.preview_origin` | — | 透過 tunnel 或 proxy 預覽時，對應到預覽 port 的另一個主機名稱 |

完整設定說明：[configuration.zh-TW.md](configuration.zh-TW.md)；CLI 指令：[cli.zh-TW.md](cli.zh-TW.md)。

## 安全說明

- 任何憑證都不會出現在網址裡：fleet token、登入碼、session 都一樣。
- 已登入的瀏覽器要寫入時，必須同時有 session、每個 session 專屬的 CSRF header，**以及**相符的 `Origin`；光有 cookie 什麼都改不了。用 `X-Agend-Token` header 的腳本不受影響，因為瀏覽器不會自己帶上這個 header。
- 每個面板都帶 Content-Security-Policy：script、樣式、圖片與連線都只限 dashboard 自己的位址。
  - 只會執行頁面自己的 script：每次載入都帶一個新的 nonce，script 不允許 `'unsafe-inline'`，所以被注入到頁面的標記無法執行程式碼。
  - 樣式也一樣：只會套用頁面自己的樣式表（不允許 `'unsafe-inline'`），所以被注入的標記無法加上自己的 inline 樣式（但仍可能套用頁面既有的 class）。

## 遇到問題時

| 你看到 | 原因與處理方式 |
|---|---|
| 經由 proxy 或 tunnel 打開 dashboard 時出現 **403** | 這個 `Host` 沒有被允許：把它加進 `web.allowed_hosts`。 |
| 登入頁說登入碼錯誤 | 登入碼只能用一次、5 分鐘後到期，而且只有最新的那組有效：請重新取得。 |
| 「登入已結束」 | 閒置 2 小時、登入已滿 12 小時，或有人執行了 revoke：重新登入即可。 |
| dashboard 短暫顯示「disconnected」之後又繼續更新 | 你這條連線傳不了即時串流，已改成每 5 秒輪詢：不需要處理。 |
| `/dashboard` 回覆「disabled」 | 這個 bot 沒有設定任何 fleet admin：把你的使用者加進它的 `allowed_users`。 |
