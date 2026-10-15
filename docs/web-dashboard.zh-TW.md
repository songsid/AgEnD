# Web dashboard

English: [web-dashboard.md](web-dashboard.md)

Dashboard 的瀏覽器分頁在聊天、View、設定與登入頁使用銀色 **Ag** 圖示，臨時公開連結也相同。將頁面加入手機主畫面時，可使用同款 apple-touch 圖示。圖示隨套件附上，由 dashboard 本身提供，載入時不需要登入。

AgEnD 的 web dashboard 是 fleet 自己跑的一個小型 web server，上面有三個面板：

| 面板 | 用途 |
|---|---|
| **`/ui`**：網頁 app | 跟 agent 對話（聊天、檔案、中止回覆）、看誰正在工作，管理 instance、task、排程與 team。每個聊天都有自己的網址 `/ui/chat/<name>`；Fleet 在 `/ui/fleet`（`/ui/fleet/schedules`、`…/teams`、`…/org`、`…/cache`、`…/config`）；**等你處理** 在 `/ui/needs` |
| **`/view`** | 以讀取為主的總覽：每個 agent 的即時終端、名單、用量，也可以編輯 agent 的個人檔案與頭像 |
| **`/settings`** | fleet 設定——agent、連線、ClassicBot、預設值、`fleet.yaml`——可以套用並重啟。每個分頁都有自己的網址：`/settings/bots`、`…/classic`、`…/general`、`…/web`、`…/advanced`（`/settings` 是 Agent） |

`/ui`、`/view` 和 `/settings` 是同一個有側欄的 app：instance 清單、**Fleet**、**檢視**、**設定**和 **Session** 選單都在側欄。在裡面切換不會重新載入頁面，上一頁／下一頁也可以用。打開 `/` 會進入 `/ui`，並回到你上次開著的聊天。舊的 `/ui#instance=<name>` 連結仍然有效，登入後也會帶到正確的聊天。

server 只聽 **`127.0.0.1`**，port 是 `health_port`（預設 **19280**）。除非你另外開通，否則只有本機連得到，請見[從別的裝置連線](#從別的裝置連線)。

## 登入

dashboard 用**一次性登入碼**登入，絕不使用帶有憑證的連結。

1. 取得登入碼，兩種方式擇一：
   - 在 General 使用 **`/web`**（限 fleet admin；Discord 原生 slash），按 **💻 AgEnD 電腦登入（取碼）**，或選 **🌐 其他裝置登入（臨時公開）**（須允許公開連結）。取碼指示放在最前面，不再列出重複的頁面網址或已關閉連結的倒數。選單不含碼，bot 會私送連結與一次性登入碼，接著再把登入碼單獨傳一則，手機上就能只複製登入碼（點一下即可複製：Telegram 以程式碼格式顯示，Discord 以行內程式碼顯示）。公開連結的期限以 fleet 的時區顯示，並附上 UTC 偏移。
   - Telegram 上，你要先開啟和 bot 的私訊，它才能傳訊息給你。`/web` 私送不到時，點 **開啟私訊**（或對 bot 傳送 `/start web`）並按「開始」，同一個選單會在私訊裡出現：在那裡選擇，登入碼就送到選單下方。私送失敗後 10 分鐘內，bot 本身的「開始」按鈕（單獨的 `/start`）也有同樣效果，限一次。
   - 在主機上執行 **`agend web`**，會印出登入碼並開啟登入頁；`agend web --code` 則只印出來、不開瀏覽器。
2. 打開登入頁，輸入 8 個字元的登入碼（`ABCD-EFGH`，有沒有連字號、大小寫都可以）。

關於登入碼：
- 只能用**一次**，**5 分鐘**後到期；只有最新的那一組有效，重新取得會取代前一組。
- 同一組輸錯 5 次就作廢；跨多組累計輸錯太多次，會暫停登入幾分鐘。還沒發出任何登入碼時，根本沒有東西可以猜。
- 本機登入預設通知 General，可用 `web.notify_login: false` 關閉；公開登入一律需要已確認的公開通知。

**傳一組新的登入碼給我。** 曾用 `/web` 的登入碼登入過的瀏覽器，登入頁會出現這個按鈕，不必回聊天室再要。新的碼只會私訊給收到上一組碼的那個人，絕不會發到群組，而且對方必須仍是 fleet 管理員。私訊會寫出是哪個瀏覽器、經由公開連結還是本機網路要求的。和任何新的碼一樣，它會取代前一組，包括 `/web` 剛送出的那組。每個瀏覽器一分鐘一次、一小時五次（整個 fleet 另有每分鐘幾次的上限）；輸錯碼導致登入暫停期間不能要。`agend web` 給的碼不會讓瀏覽器取得這個按鈕。公開連結上，只有同一條連結仍開著時才有效，登入照常在 General 公告。`/web revoke` 與 `agend web-token rotate` 會讓所有瀏覽器失去這個按鈕。

舊的 `?token=` 連結或書籤（例如舊版印出的 `/ui?token=…`）**不能**用來登入：它會開到登入頁，網址列裡的 token 也會被清掉。

## Session

- session 是伺服器上的一筆紀錄，不是存在瀏覽器裡的值。預設在登入後最多 **48 小時**、或閒置 **48 小時**就會結束（以先到者為準；直接連到 dashboard 時，這兩個值可用 `web.session.local.absolute_hours`／`idle_hours` 設定，最多 720 小時，見[設定](configuration.zh-TW.md)）；本機 session 在 fleet 重啟後仍有效。公開 session 綁定單次入口，四小時／閒置 30 分鐘及入口關閉都會使其失效；不能用於本機或下一個入口，本機 cookie 與 header token 也不能用於公開入口。
- 只有你的操作才算使用：打開頁面或聊天、送出訊息、變更任何東西。頁面自己定時做的事一律不算：即時串流（重新連線也一樣）、備援輪詢，以及 `/view` 的終端、名單與用量更新。所以開著不管的分頁——包括 `web.view_access: session` 時的 `/view`——仍會在閒置期限後結束（本機預設 48 小時、公開 session 30 分鐘）。
- session 結束時，頁面會提示一次（「登入已結束。重新登入」），而且保留你畫面上正在做的事。
- **Session 選單**（在側欄最下方）會顯示：
  - 你目前用哪個瀏覽器登入、這個 session 什麼時候到期；
  - 其他已登入的裝置，每台都可以按 **Sign out**；
  - **全部登出（Sign out everywhere）**。

### 讓所有瀏覽器登出（revoke）

看到不是你做的登入，或有一台不再信任的裝置時，以下任一種方式都可以：

| 在哪裡 | 怎麼做 |
|---|---|
| Telegram | `/web revoke` |
| Discord | `/web` slash 指令，選 **`action: revoke`** |
| 主機上 | `agend web-token rotate`（同時也會輪替 CLI 用的 token；執行中的 fleet 會直接套用，不用重啟） |
| 瀏覽器裡 | Session 選單 →**全部登出** |

如果伺服器存不了這個變更（磁碟有問題），回覆會明確告訴你：大家**目前**都登出了，但重啟後 session 可能會回來，請先修好磁碟再 revoke 一次。

## 聊天（`/ui`）

在左側選一個 instance 就能跟它對話。web 聊天跟它的 Telegram／Discord topic 是**同一個對話**：
- 你在 web 發的訊息，會以 `🌐 <你的名字>: …` 同步到 topic（見下方「agent 看到的是誰」）。
- agent 的回覆照常送到 Telegram／Discord，web 也會同時顯示。
- 你可以對話到一半在 web 和手機之間切換。
- **完全沒有聊天平台？** `fleet.yaml` 裡沒有設定 `channel` 或 `channels` 時，只靠 dashboard 就能用：agent 的回覆會送到 web 聊天。
- **第一次來？** 在某個裝置上第一次打開 `/ui` 時，會有簡短導覽介紹 instance 清單、檔案、Stop 和「等你回應」標記。**設定 → 偏好設定 → 導覽**可以再看一次。

### agent 看到的是誰（#1827）

- **用 `/web` 的驗證碼登入：** 驗證碼是私訊給你的 Discord 或 Telegram 帳號，所以對 agent 來說，這個瀏覽器就是那個帳號。你的網頁訊息會以 `[user:<名字> via web, id:<你在那個平台的使用者 id>]` 送達。在 Discord 或 Telegram 上認得你的 agent，在網頁上也認得你；`via web` 標示你是從網頁發的。
  - **名字：** 預設是你登入時帳號的顯示名稱，也可以在 **設定 → 偏好設定 → 你的名字** 另取一個。名字會跟著你到每一台登入的裝置，包括公開連結；改名不會改變 id。
  - **名字規則：** 1–32 個字，只能用字母、數字、空格、單一表情符號和 `. - _ ' ·`。不能含有「via」這個字，也不能用 AgEnD 保留的名字，或這裡某個 agent、bot 的名字。
- **用其他方式登入**（`agend web` 的驗證碼，或 2.2 以前的工作階段）：和以前一樣是 `web-user`。你仍可以為這些訊息設定名字；用 `/web` 的驗證碼登入一次，這個瀏覽器就會成為你的帳號。
- **這只用來辨認。** 網頁訊息永遠不算是那個平台帳號發出的已驗證訊息：它不帶任何權限，#1756 的人類授權收據也不會把它記成那個帳號。
- **同一個名字也用在：** topic 同步、ClassicBot 房間的紀錄、回覆按鈕的選擇、投票結果、你建立或認領的任務，以及網頁的 `/steer` 和 `/btw`。
- **投票：** 你在網頁投的票，和你在 Discord 或 Telegram 投的是同一張選票。

### 版面
- 對話是置中的一欄。你的訊息是靠右的泡泡；agent 的回覆佔滿整欄，每則都有 **複製**。
- **程式碼區塊**會標出語言，並有 **複製** 與 **換行**（長行改為換行而不是橫向捲動，這個瀏覽器會記住）。超過 30 行的區塊會先收合，按 **展開全部 N 行** 打開。
- **Discord 伺服器表情**以 `<:名稱:id>`（或 `<a:名稱:id>`）寫出時，若屬於 fleet 的 Discord bot 所在的伺服器，會顯示為表情圖片；AgEnD 只取得一次並由 dashboard 提供，頁面不會從 Discord 載入。其他的照原文顯示。
- **提及（mention）**的呈現方式和 Discord 一樣：`<@id>`（或 `<@!id>`）顯示為 **@名稱**，角色 `<@&id>` 顯示為 **@角色名稱**，頻道 `<#id>` 顯示為 **#頻道**，滑鼠停留時顯示 id。名稱來自 AgEnD 已經知道的資訊（fleet 的 bot、傳訊息給它的人、它的 bot 所在的 Discord 伺服器）；不知道名稱時顯示 **@user**（或 @role、#channel）。Telegram 的 **@使用者名稱** 也有相同外觀。程式碼裡的內容不會改動。
- 只有在你停在最底部時，畫面才會跟著新訊息捲動。往上捲去看舊訊息時，畫面會留在原處，按 **↓ N 則新訊息** 回到最下面。
- 側欄頂端的側欄按鈕可以隱藏側欄（按 ☰ 叫回來），這個選擇會被記住。在手機上側欄是抽屜：按 ☰ 打開——或在對話上往右滑——選了東西、點旁邊、往左滑或按 Esc 就會關上。（從螢幕最左邊開始的滑動仍是瀏覽器的「上一頁」；在程式碼、表格、終端畫面或輸入框上的滑動也交給它們自己。）手機下方另有分頁列（聊天、Fleet、檢視、設定），螢幕鍵盤打開時會讓出空間。
- 標題列顯示 instance 的名稱與狀態、**聊天 / View / 詳細資訊** 切換、**字級** 和 **用量**（聊天、View、詳細資訊和 Fleet 上都是這兩個，順序相同）。**字級** 依序是 小 → 中 → 大，這台瀏覽器只有一個設定：在任何頁面選了，每個頁面、重新載入後都是這個字級。**用量** 是 AI 訂閱用量：寬螢幕（1200 px 以上）上是右側常駐的面板，與頁面並列，按 **用量**（或面板的 ✕）可隱藏或顯示，這台裝置會記住；較窄的螢幕上，**用量** 會以對話框開啟。**⋯** 選單裡有 **Instance 詳細資料** 和這個 instance 的操作，而且只列出適用的：已停止的有 **啟動**；執行中的有 **重新啟動** 和 **停止 instance**；**刪除** 放在最後，要輸入名稱確認。
- **主題**與**語言**（**設定 → 偏好設定**；未登入看 `/view` 時，在**登入**旁的 ☀ 按鈕，只套用在那個瀏覽器）：*跟隨系統* 依各裝置的淺色／深色設定；*淺色* 或 *深色* 則固定使用。語言會套用到每個面板。
- **側欄的每個 instance** 以顯示名稱呈現，滑鼠停留時顯示 instance 名稱（兩個 instance 顯示名稱相同時，名稱也會寫在下方）。圖片依序為：在 View 上傳的圖片（**編輯個人資料**）、它自己的 bot 頭像（只有擁有專屬 bot 時才用；共用 fleet bot 的 instance 略過這一步）、persona emoji，或名稱的第一個字。在 Discord 伺服器裡有顏色的 bot 會以該顏色作為外框。圖片上的圓點是它的狀態：閒置、工作中、似乎卡住、已暫停（空心）、已停止、已當掉或等你處理，也會讀給螢幕閱讀器。圖片與伺服器表情由這台電腦上的 AgEnD 取得，由 dashboard 自己提供；頁面不會從 Discord 或 Telegram 載入。篩選可用任一名稱找到 instance。
  - 在 View（**編輯個人資料**）設定的顯示名稱優先於 agent 自己設定的（`set_display_name`）。在 View 清除它後，會再次顯示 agent 自己的名稱（或 instance 名稱）。
- 側欄底部只有一列：**設定**與**登入狀態**。**設定 → 偏好設定**放的是主題、語言、HTML 預覽和導覽。
- **最愛（#1664）。** 為 instance 加上星號，就會釘選在側欄最上方的**最愛**，依加入的順序排列。在電腦上，滑鼠移到某一列或聚焦時會出現 ☆，已加入最愛的列會一直顯示。在手機上，請點清單上方的**編輯**。**編輯**也會顯示 ↑ ↓ 讓你調整最愛的順序。已刪除的 instance 會從清單移除；暫停或停止的仍會保留。最多 50 個。
- **偏好設定在你的所有裝置同步（#1665）。** 主題、語言、側欄的排序、收合的群組、篩選與最愛，以及 HTML 預覽，都存在 AgEnD 主機上，手機和電腦會保持一致。變更會立刻出現在你的其他裝置，或在它們下次載入時出現。每個瀏覽器都留有一份副本，頁面送達時就已套用你的主題，不會閃爍。更新後裝置第一次載入時，會把主機還沒有的設定上傳；之後以主機上的值為準。導覽、文字大小、視圖寬度、側欄顯示或隱藏、面板寬度、程式碼換行與桌面通知，留在各裝置。公開連結可以讀取你的偏好設定，但無法變更。
- **在手機上**，螢幕鍵盤出現時頁面會跟著縮小，輸入框會留在鍵盤上方；版面也會避開瀏海與底部的 home bar。

### 鍵盤與螢幕閱讀器
- agent 工作時按 **Esc** 會中止它的回覆，就像在它的終端機按 Esc 一樣。agent 閒置時沒有作用；有表單或選單開著時，Esc 會先關掉它們。
- 側欄的每一列都是連結：用 **Tab** 移到、按 **Enter** 打開（中鍵或 Ctrl+點擊會在新分頁打開）。在手機上，抽屜打開時頁面其他部分無法操作。
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
- 貼上超過 **4,000 個字元**的文字時，會改成文字檔附加，而不是塞進輸入框；按標籤上的 **改為文字** 可以放回輸入框。
- 限制：每則訊息最多 **5 個檔案**，每個 **10 MB**，合計 **25 MB**。
- 類型：**PNG、JPEG、GIF、WebP、PDF 與文字檔**。類型由檔案內容判斷，不看檔名。
- agent 收到檔案的方式跟從 Telegram 收到完全一樣：檔案會放在 instance 工作區的 inbox（`<AGEND_HOME>/workspaces/<instance>/inbox`），並附上一行 `[📷 Image: …]` 或 `[📎 File: …]`。
- agent 在回覆裡附的檔案也會顯示在聊天裡：圖片直接顯示，其他檔案則是下載，絕不會在頁面上開啟。
- 聊天會為每個回覆檔案另存一份副本（`<AGEND_HOME>/workspaces/<instance>/web-files`），所以 agent 改寫或刪掉原檔、或 fleet 重新啟動後，檔案仍能開啟。符號連結、超過 50 MB 的檔案，以及 AgEnD 狀態資料夾內（inbox/ 以外）的檔案不會顯示。訊息離開聊天紀錄時副本會一併刪除；每個 instance 最多保留 1 GiB 的副本，超過時先刪最舊的。
- 附加了但**30 分鐘內沒送出**的檔案會被刪除。fleet 重啟後，留下的這類檔案也會在啟動時、放滿 30 分鐘後刪除。
- 已送出的檔案會在 inbox 保留 **7 天**，跟從 Telegram 收到的檔案一樣。

### HTML 預覽
agent 的回覆裡有 ` ```html ` 區塊，或附上 `.html`／`.htm` 檔案時，下方會出現一張卡片，可以幫你執行那段 HTML。
- **檔案和區塊用法相同。** 檔案的卡片在回覆的附件下方。只有在你按 **預覽** 或 **在面板中開啟** 時，才會向 fleet 讀取它的 HTML，並在和區塊相同的沙箱框架裡執行；檔案絕不會在 dashboard 自己的位址上開啟。**下載** 就是卡片上方那個檔案本身的連結。fleet 已經沒有的檔案（副本因超過上限被刪除，或是在 AgEnD 開始保留副本之前送出的）會直接說明，請 agent 再傳一次。
- **上限 1 MiB。** 超過 1 MiB（以 UTF-8 計）的區塊或檔案不提供預覽。檔案會先檢查列出的大小才讀取，讀到的位元組數也會再檢查一次。檔案一律以 UTF-8 讀取。
- **預設是關閉的，要你自己打開。** 用 **設定 → 偏好設定** 的 **允許預覽 HTML**，或卡片的 **⋯** 選單。它只會問一次，並說明這代表什麼。這個選擇會套用到你登入的每一台裝置（公開連結永遠不會）；關掉時，所有正在執行的預覽都會停止。
- **每次都要你按下才會執行。** **預覽** 會在卡片下方的框架裡執行，並顯示這段說明：*「Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab.」* 按說明上的 **我知道了** 可以隱藏它，直到你下次登入；預覽外圍的黃色框線一律保留。按 **停止** 關閉。一次只會執行一個預覽。
- **下載** 會把區塊的 HTML 存成 `reply.html`（檔案保留原本的檔名），絕不會在 dashboard 裡開啟。
- **在面板中開啟** 會把區塊放到對話旁邊，空間比較大。在手機上它是全螢幕的頁面，按 **←** 回到對話。
  - 從閒置的卡片開啟時，面板有自己的 **預覽** 要你按。從正在執行的預覽開啟時，同一個按鈕會把那個預覽移到面板裡。
  - 面板的工具列：**頁面**／**程式碼**（原始碼）、**重新載入**、**停止**、**下載**。頂端的 **來自 …** 會顯示這個區塊所在的訊息。
  - 拖曳分隔線可調整寬度，或把焦點移到分隔線上用 ← →、Home、End。這台裝置會記住寬度。
  - 之後的回覆帶來同一個區塊的較新版本時（`<title>` 相同；沒有 title 時則是任何較新的區塊），或同一個檔案的較新版本時（檔名相同），面板會用 **顯示** 提示你。它絕不會自己換掉，新版本也要等你按 **預覽**。
  - 關閉面板（**×**、**←** 或 Esc）或打開別的對話時，面板的預覽會停止。在卡片裡啟動預覽會停止面板的預覽：一次只會執行一個預覽。
  - 沒有「在新分頁開啟」：HTML 只會在沙箱框架裡執行。要拿到別處，請用 **下載**。
- **它能做什麼、不能做什麼。** 預覽在另一個位址的沙箱裡執行，所以無法使用你的登入、讀取你的 session，也無法操作 dashboard。但它**可能**可以把資料傳出去（沒有瀏覽器能擋住所有管道），所以只預覽你信任的 HTML。
- **只有 agent 的回覆**（由 fleet 標記）才會有卡片。來自人的 HTML（web、Telegram 或 Discord）一律只顯示成程式碼，人上傳的 `.html` 檔也只是一般下載連結。被長度上限截斷的區塊不會有預覽：請 agent 改用 `.html` 檔案傳送。agent 也被告知完整頁面優先用檔案，因為長區塊在 Discord 與 Telegram 上會被切開。
- **在哪裡能用。** 預覽來自第二個本機 port：`health_port + 1`（19281）。透過 SSH 使用時也要轉送它：`ssh -L 19280:127.0.0.1:19280 -L 19281:127.0.0.1:19281 <host>`。透過 tunnel 或 proxy 時需要設定 `web.preview_origin`（對應到那個 port 的另一個主機名稱），而且 proxy 必須原樣傳遞外部的 `Host`。不符合時，卡片會說明預覽為什麼關閉，只提供程式碼與 **下載**。
- **在臨時公開連結上（#1723）** 也能預覽，用手機也可以。
  - 公開連結會在背景為預覽另開一條自己的 quick tunnel，時機是連結自己的通道拿到網址之後（連結一定先向 Cloudflare 要，#1767）。連結不等它：自己的通道一好就可以用。
  - 預覽通道還沒好時，卡片會顯示「預覽啟動中…」，好了就照常執行。開不起來時連結照常可用，卡片會說明原因。
  - 預覽通道若連不上（邊緣節點還沒認得它的名稱），會換一個新網址再開一次，期間卡片仍顯示「啟動中」（#1732）。
  - 它隨連結一起關閉。
  - 它的網址是另一個 `trycloudflare.com` 名稱。`trycloudflare.com` 在 Public Suffix List 上，所以框架和儀表板是不同的站點，隔離得比本機預設（同一名稱的另一個 port）更好。
  - 你這台裝置的選擇（**允許 HTML 預覽**）照樣適用，而且無法透過公開連結更改。
  - `web.preview_on_public_link: false` 會關閉這個功能。若已設定 `web.preview_origin`，就改用它，不另開通道。
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
目前打開的聊天裡的 agent 正在工作時，輸入框上方會出現這一列，輸入框裡的 **送出** 也會換成 **中止回覆**。開始打字後 **送出** 會回到旁邊：agent 工作時送出的訊息會排隊等下一輪。
- Stop 的效果跟 Telegram 的取消鍵、`/cancel` 一樣：中斷 agent 目前的回覆（送 Esc），並丟掉還在排隊的訊息，它們的 ticks 會變成 ⊘。
- 中止回覆**不會**停掉 instance 程序；要停掉程序，請用標題列 **⋯** 選單裡的 **停止 instance**。
- 這一列會顯示 agent 已經工作多久（從這個頁面看到它開始工作起算）。按下 Stop 後會顯示「正在中止 *name*…」，直到 agent 停下來。
- agent 停在終端機上等待（權限詢問、登入、對話框）時，這一列會顯示「*name* 正在等你回應」，側欄上的 instance 也會出現 **等你回應** 標記。這是從終端畫面判讀的，請當作參考。可以用下方的提示按鈕回應，或到主機上處理。

### 回應 fleet 的提示
instance 看起來卡住、自己結束，或停在互動式提示時，Telegram／Discord 上的按鈕也會出現在該 instance 的聊天裡：*Force restart* / *Keep waiting*、*Restart* / *Ignore*、*請 General 協助* / *我自己處理*。
- 它們是**同一個提示**：不論在哪邊，先回答的算數。另一邊的按鈕隨後會顯示結果，提示也會在所有地方同時到期。
- 只有這幾種跟 instance 健康有關的提示會出現在 web 上；`/clear` 的確認、登入、ClassicBot 的核准、tips，以及 `/model`、`/effort` 選單，都會留在原本發出的地方。web chat 有自己的 `/clear`、`/model`、`/backend` 與 `/effort`（見下方）。
- 頁面沒連線時發出的提示，重新連上後會立刻出現；如果期間已經在別處回答了，會顯示為已回答。
- **沒有聊天平台？** 只用 dashboard 的 fleet，這些提示會直接出現在該 instance 的聊天裡。互動式提示的 *請 General 協助* 是請 General instance 去看它的終端機，所以只有 fleet 有 General 時才會出現。

### 指令與快速動作
在輸入框開頭打 `/`，會列出這個 instance 自己的聊天指令，和它的 Telegram/Discord topic 接受的指令相同，由相同的處理程式依相同的規則執行。
- **指令清單**：輸入時會即時篩選。↑/↓ 移動，**Tab** 補完，**Enter** 執行，**Esc** 關閉。
- **可用指令**：
  - `/ctx`：context 用量、模型與推理強度。
  - `/compact [指示]`
  - `/clear`：會先確認。
  - `/model [名稱]` 和 `/effort [等級]`：不加參數時會列出可選項目。
  - `/backend [backend] [模型] [推理強度]`：換到另一個 CLI backend，一次選一項（backend、它的模型、它的推理強度），再先確認。只重新啟動一次，並開全新的 session。模型清單和 `/model` 一樣只用快取。
  - `/cancel`
  - `/btw <問題>`
  - `/steer <文字>`
  - `/pause` 和 `/wake`
  - `/save <檔名>`
- **結果顯示的位置**：輸入框上方。
- **不是指令的情況**：其他以 `/` 開頭的內容照舊當成一般訊息送出；輸入框旁有待送檔案時打的指令也一樣。
- **fleet 層級的指令**（`/status`、`/restart`、`/update`、`/login` 等）仍在 General 使用。
- **`/raw`** 不在清單中。透過臨時公開連結時，以 `/raw ` 開頭的訊息會被拒絕，`/save` 也是。
- **快速動作**：
  - 聊天標題列上的模型與推理強度，點了會開啟可選清單。
  - instance 的 context 用到 70% 時，輸入框上方會出現 **壓縮** 和 **清空…**。

## Fleet（`/ui/fleet`）
fleet 共用的工作與總覽，每項一個分頁，各有自己的網址。標題列的 **文件** 會在新分頁開啟專案的文件網站（依 dashboard 的語言）。

**單一 instance 的詳細資訊**（`/ui/fleet/agent/<name>`）是那個 instance 在 Fleet 這一側的頁面：執行環境（backend、模型、effort、花費、context、5 小時和 7 天額度）、最近活動，以及唯讀的設定摘要（顯示名稱、說明、目錄、綁定在哪裡、標籤）。要修改請按 **到設定編輯**。它的 ⋯ 選單可以啟動、重新啟動、停止、暫停或喚醒它，呼叫和確認步驟與聊天頁的 ⋯ 選單及設定相同；刪除 instance 仍在聊天頁的 ⋯ 選單和設定裡。ClassicBot 房間的詳細資訊會顯示它的房間而不是目錄，只提供暫停和喚醒（和設定裡一樣），**到設定編輯** 會開啟它的 ClassicBot 設定。沒有指定連線的 instance 會顯示為綁定在 fleet 的第一個連線，這是它的預設。
- 在 instance 的頁面上，標題列可以在它的 **聊天**、**View** 和 **詳細資訊** 之間切換（手機上是標題列下方的分頁），instance 不變。沒有登入、只讀 View 的人看不到這個切換。
- 開著某個 instance 時，側欄的 **Fleet**（以及手機的 Fleet 分頁）會進到那個 instance 的詳細資訊；沒有開著 instance 時則是 Tasks。在詳細資訊或 Fleet 分頁上，點側欄的 instance 會開它的詳細資訊。
- **Tasks**、**排程**、**Teams**：任務看板、cron 排程和 team。可以在這裡建立、認領和刪除。team 的 **編輯** 可以修改成員和描述（與 `update_team` 工具相同的更新）；team 無法重新命名，請建立新的再刪除舊的。透過公開連結時，team 只能檢視。
- **組織圖**（`/ui/fleet/org`；從任何頁面點側欄最上方（手機上是抽屜最上方）的 **Fleet 概覽** 就能打開）：最上方是 General，下面是 `fleet.yaml` 的各個 team，最後是未加入 team 的 instance。
  - 每個 instance 顯示名稱、它負責的工作、backend 與模型，以及即時狀態（工作中、閒置、等你回應、似乎卡住、已暫停、已停止、已當掉）。
  - 也附上它的 Discord 討論串或 Telegram topic 連結，以及聊天連結。
  - 組織圖唯讀：操作請在 Discord 或聊天裡進行。
- **快取**（`/ui/fleet/cache`）：在 24 小時、7 天或 30 天內，每個 Claude Code 與 Codex instance 的提示快取在兩次請求之間過期的頻率、重寫的成本，以及保溫 ping 是否划算。
  - 資料來自本機的 transcript，不呼叫任何供應商 API；每個 instance 只保存一份小摘要（`cache-ledger.json`）。
  - 成本以單一價目表的牌價計算，並顯示查證日期。
  - transcript 有記錄快取寫入時就採用它；沒有記錄時（部分 Codex session），改以未快取的輸入估算重寫量，數字會標示為估算；快取存活時間只能假定時也會標示為估算。
  - Kiro 與其他 CLI 顯示「不提供」。
- **設定**：fleet 的頻道、存取權限與預設值。

## 等你處理（`/ui/needs`）

所有等你處理的事，來自每個 bot 的世界，集中在一份清單：fleet 的提示（沒有回應、已結束、在終端機上等待）、停在權限、危險指令、登入或其他對話框的 agent、因需要登入而暫停或已崩潰的 agent，以及 fleet 無法確認或無法送達的傳送。這和每個 bot 在 General 的「等你處理」即時訊息是同一份清單（那裡每個 bot 只顯示自己的 agent）。在任何地方處理過的事——Discord、Telegram 或這裡——都會從每份清單消失。

- 側欄的 **等你處理**（手機上是一個分頁）會顯示待處理的數量；瀏覽器分頁的標題會以 `(N)` 開頭。
- 清單依 agent 分組，最舊的在前。提示有它自己的按鈕；傳送有 **確認**；每一項都有 **開啟聊天**。
- **在這台裝置通知我**：分頁在背景時，有新的事等你處理就跳出桌面通知（在終端機上的等待要持續 5 秒才通知）。設定只對這個瀏覽器有效，開啟時會請求權限，而且需要安全的網址：`127.0.0.1`/`localhost` 或 HTTPS 公開連結，區網的一般 HTTP 網址不行。手機上不提供：手機請以 Discord 通知為主（General 裡的新訊息，以及可選的私訊）。

## `/view`

`/view` 會列出每個 agent：即時終端畫面、包含狀態與 context 的名單，以及 AI 訂閱用量。每個 agent 都有自己的網址 `/view/<name>`；只開 `/view` 會回到這個瀏覽器上次看的那一個。

- **檢視開著時，名單就在側欄**（手機上在抽屜裡）：依標籤分組，最下方是篩選框（按 **/** 可直接跳過去），順序可以自己拖曳調整。每列顯示已用的 context 和 backend 的顏色，滑鼠移上去可看其他資訊。
- **標題列**有 **字級**、**用量** 和 **說明**。在 View 上字級依序是 填滿 → 小 → 中 → 大：**填滿** 讓終端畫面符合框的大小，小／中／大則是所有頁面共用的字級。終端畫面在淺色和深色主題下都維持深色。
- **終端下方的卡片**顯示 agent 的名稱、角色和模型；按箭頭可展開完整個人資料。**編輯個人資料** 可修改顯示名稱、角色、描述和頭像。

- **讀取 `/view` 預設不用登入**（`web.view_access: open`），連即時終端也一樣，所以任何能連到這個 port 的人都看得到你的 agent。如果機器只有你連得到，這樣沒問題；否則請設定：
  ```yaml
  web:
    view_access: session   # 讀取 /view 也需要已登入的 session
  ```
- **未登入時，`/view` 只有檢視：** 側欄只有檢視和 **登入**，不會顯示或讀取任何需要登入的內容；**登入後才能編輯** 會帶你去登入頁，再回到原頁。
- **編輯 agent 的個人檔案或頭像一律需要登入。** 名單順序是會同步的偏好設定之一（見上方）；未登入的讀者則只保存在那個瀏覽器。
- 腳本仍然可以用 `X-Agend-Token` header 寫入。

## `/settings`

**Agent**、**連線**、**ClassicBot**、**一般**、**網頁**和**開發者**（以 YAML 或 JSON 呈現整份 `fleet.yaml`）是分頁，各有自己的網址。搜尋框可篩選 agent、連線和 ClassicBot 房間；**設定精靈** 的四個步驟和 `agend quickstart` 相同；它一律新增一個連線，接到新的 agent 或你已有的 agent。

還沒有任何聊天連線（只用網頁）的 fleet，會在聊天頁和設定的 Agent／連線分頁上方顯示一張卡片：**連接聊天應用程式** 會開啟設定精靈，**只用網頁** 會在這個瀏覽器裡隱藏它。

- **變更會先暫存，再一起套用。** 在 agent 或連線的 **設定** 對話框按 **暫存變更** 就會暫存；一般或網頁分頁的 **檢查變更** 也一樣。下方的列會顯示數量和套用的代價（立即生效、重新啟動該 agent，或重新啟動 AgEnD）；**套用變更** 一次套用全部，**捨棄** 則全部丟掉。在分頁之間切換時暫存的變更會保留；帶著暫存變更離開設定時，會先問 **要捨棄 N 項尚未套用的變更嗎？**
- **按下套用後，即使離開也會繼續。** 你可以去聊天或任何地方：寫入、重新載入和進度都會繼續，頂端會有一行顯示進度，回到設定時可以看到細節。前一次套用完成前，不能再套用一次。需要重新啟動 AgEnD 本身時，會提供 **重新啟動 AgEnD**（另有確認）。
- **網頁** 分頁是 dashboard 本身的設定：從這裡登入後可維持多久、閒置多久登出（`web.session.local.*`；留空 = 預設值）、`/login` 開啟的瀏覽器終端機（開或關，以及分鐘數）、web 同步和公開連結選單。放寬存取的變更——延長 session 或閒置時間、重新開啟瀏覽器終端機或增加分鐘數、公開連結——要等 fleet admin 在 General 確認（或用 `agend settings confirm <id>`，見下方「確認敏感變更」）；收緊存取的變更立即套用。其他網頁設定只列出、不能修改：它們決定 dashboard 監聽和公開的內容，請在 `fleet.yaml` 編輯（之後執行 `agend reload`；`web.preview_port` 與 `web.preview_origin` 需要重新啟動）。透過臨時公開連結無法變更這些設定：分頁會說明原因，伺服器也會拒絕。
- **新增 agent** 和側欄的 **+**（新增 instance）是同一個對話框。
- **Bot token 在這裡輸入，不用編輯 `.env`。** **新增連線** 和 **設定精靈** 會用密碼欄位請你貼上 bot 的 token；**驗證** 會向 Telegram 或 Discord 確認這是哪個 bot，並在儲存前顯示（「這是 @your_bot。」）。
  - token 存在這台電腦的 `~/.agend/.env`，名稱由 AgEnD 自動產生（`AGEND_DISCORD_TOKEN`、`AGEND_DISCORD_2_TOKEN`、`AGEND_TELEGRAM_PERSONA1_TOKEN`…）。**進階** 會以唯讀方式顯示，給自行管理 `.env` 的人參考；不需要任何人手動輸入。
  - 兩者一律 **新增** 連線。同一平台的第二個 bot（即使在同一個伺服器）會成為自己的連線（`discord-2`…），絕不會取代既有的連線。要換某條連線的 token，請開它的 **設定** → **進階** → **更換**。
  - 連線會顯示 **已設定 token**（執行中時附上 bot 名稱）或 **缺少 token**，永遠不顯示 token 本身。當 AgEnD 已經在執行其他連線、且 fleet 層級沒有其他變更時，新的連線會在套用後立刻啟動，不需要重新啟動；套用卡片會顯示「正在啟動新連線」。fleet 的第一條連線，或修改既有連線，仍會出現 **重新啟動 AgEnD**。在沒有執行中的連線上更換 token 也會這樣直接啟動它；若是第一條連線，則要等那次重新啟動。
- **需要 fleet 管理員確認的變更**（見[確認敏感變更](#確認敏感變更)）會在任何面板顯示一張卡片：變更內容、剩餘時間，以及 **撤回**。套用會等它；確認後其餘部分繼續，若被拒絕或逾時，之後的變更都不會套用，並重新暫存（bot token 需要重新輸入）。

## 從別的裝置連線

### 手機使用臨時公開連結

管理員在所屬 General 的 `/web` 選 **開啟臨時公開連結**（Discord 原生 slash；Telegram 輸入指令）。按下前不下載、不開入口。bot 私送連結與登入碼；Discord 私訊失敗時改用須確認送達的 ephemeral 回覆。Telegram 請先私訊 bot 的 `/start`。General 絕不貼登入碼。

啟動期間，你按的那個選單會逐步顯示每個階段與經過秒數，最多每 2 秒更新一次（Telegram 為 3 秒）：

1. 檢查 cloudflared；
2. 下載（已下載 / 總共 MB）；
3. 驗證檔案（固定版本與 SHA256）；
4. 啟動 tunnel；
5. 等待公開網址可以連上；
6. 私送連結給你。

只有需要下載 AgEnD 自己的 cloudflared 時才會出現第 1–3 步；第一次之後只會看到第 4–6 步。失敗的那一步會標出原因，再執行一次 `/web` 即可重試。選單上只有這些文字和數字，不會出現連結或登入碼。

使用 AgEnD 固定版本、checksum 驗證的 cloudflared，不採用 PATH 上的任意程式。Linux 先從 pkg.cloudflare.com 下載，失敗或太慢時改用 GitHub，第 ② 步會標出改用的來源；macOS 只用 GitHub。一次只能開一條 tunnel，與公開 `/login` 終端共用名額。期限固定 **兩小時**，含啟動時間；再次取得連結不延長。Settings 可改為 1–480 分鐘或停用選項。私送的關閉按鈕（要按兩下：關閉公開連結，再按確定關閉；按取消會恢復原狀）、新選單、`/web revoke`、到期及 fleet 關閉都會關入口。子行程無法確認停止時封鎖下一條 tunnel，但網頁存取已關閉。

獨立 gateway 只接受當前 tunnel Host 與核准面板路由；`/view` 一律要登入，不暴露 SSE、`/health`、`/agent` 或發碼 API；預覽框架也絕不從它提供（預覽有自己的通道，見 [HTML 預覽](#html-預覽)）。聊天立即輪詢。關閉會撤回該入口的碼與 session，本機 session 另行隔離。Host 只暫時允許，不寫入 `allowed_hosts`。

這是完整 web-admin 權限，含終端、檔案、設定與主機操作。Cloudflare 終止 TLS，能看到流量。不要轉傳連結或碼。公開 session 啟用前，所屬 General 必須在五秒內確認收到 🔐 公開登入通知，即使 `notify_login: false` 也一樣；平台故障可能使登入不可用。公開猜碼也可能耗盡共用登入 breaker。自行設定的 proxy 仍需自己的保護。

### 自行管理連線

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
| `web.notify_login` | `true` | `false`：不在 General 通知新的本機登入；公開登入一律需要通知 |
| `web.usage_panel` | `true` | `false`：完全不顯示 AI 用量——沒有 **用量** 按鈕、面板或對話框，也不提供 `/api/ai-usage` |
| `web.preview` | `true` | `false`：完全不提供 HTML 預覽（卡片只顯示程式碼與下載） |
| `web.preview_port` | `health_port + 1` | 預覽 listener 的 port（只聽 `127.0.0.1`） |
| `web.preview_origin` | — | 透過 tunnel 或 proxy 預覽時，對應到預覽 port 的另一個主機名稱 |
| `web.preview_on_public_link` | `true` | `false`：臨時公開連結不提供預覽（不另開通道） |
| `web.public_link.allow_public` | `true` | 提供需主動選擇的公開選項；停用也關閉現有入口 |
| `web.public_link.ttl_minutes` | `120` | 從同意起固定期限，1–480 分鐘，不延長現有入口 |
| `web.public_link.protocol` | `http2` | cloudflared 的 `http2`、`quic` 或 `auto` |
| `web.echo_to_channel` | `true` | 將 web chat 訊息複製到 instance 自己的 Telegram 或 Discord 主題 |
| `web.session.local.absolute_hours` | `48` | 從 dashboard 本身網址登入後可維持多久，1–720 小時 |
| `web.session.local.idle_hours` | `48` | 閒置多久後登出，1–720 小時，且不超過 `absolute_hours` |
| `web_terminal.enabled` | `true` | `false`：`/login` 會拒絕（沒有瀏覽器終端機） |
| `web_terminal.ttl_minutes` | `10` | `/login` 的瀏覽器終端機開啟多久，1–20 分鐘 |

**設定 → 網頁** 可編輯 `web.echo_to_channel`、`web.public_link.*`、`web.session.local.*` 與 `web_terminal.enabled` / `ttl_minutes`；其他設定（包含 `web.provider_secrets`、`web_terminal.bind`、`web_terminal.tunnel`）只列出、不能在這裡修改。

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
| 「登入已結束」 | 閒置 48 小時或登入已滿 48 小時（預設值），或有人執行了 revoke：重新登入即可。 |
| 更新會晚幾秒才出現，沒有即時串流 | 你這條連線傳不了即時串流（或這是公開連結），頁面改成每 5 秒輪詢：不需要處理，也不會當成問題顯示。 |
| `/web` 回覆「disabled」 | 這個 bot 沒有設定任何 fleet admin：把你的使用者加進它的 `allowed_users`。 |
| 在登入頁，瀏覽器的開發者工具顯示 `/auth/session` 有紅色的 **401** | 這是預期行為：頁面會先檢查你是否已經登入，「沒有」就會回 401。不需要處理。 |

### Windows／WSL：Linux 有回應，Windows 卻連不到 dashboard

如果更新後從 Windows 打不開 dashboard，先關閉 dashboard 分頁，停止重連流量。用明確的 timeout 比較同一個設定中的 port（下例為 19280）：

```sh
# WSL 內
curl --noproxy '*' --max-time 5 -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19280/health
```

```powershell
# Windows
curl.exe --noproxy "*" --max-time 5 -sS -o NUL -w "%{http_code}\n" http://127.0.0.1:19280/health
```

Linux 回 **200**、Windows 回 **000**，表示可能是轉送或連線層的問題；只有空白頁還不能下這個結論。保留結果與 Windows／WSL 版本。反覆重啟 fleet 不一定能修復轉送層。

AgEnD 在停機時結束 SSE response，最多等一秒讓一般 HTTP 工作完成，再關閉其餘自己持有的 socket。新版頁面收到停機提示後等 10–15 秒才重連，之後沿用原本有上限的 backoff。更新前已載入的頁面，重新整理前仍用舊的重連規則。這能減少未結束的 stream 和重連流量，不能保證修復卡住的 Windows relay。Listener 仍在停機尾端才關閉，但 replacement 會先啟動 instances 才綁 HTTP，所以整次中斷可能超過一秒。突然退出時無法送出提示。

若要在不中斷 fleet 的情況下恢復連線，可使用**已經可用、可信任的 WSL SSH 路徑**，繞過 Windows localhost 轉送。例如在 Windows 執行，把 `WSL_SSH_HOST` 換成那個既有的 SSH 目的地：

```powershell
ssh -N -L 127.0.0.1:19281:127.0.0.1:19280 WSL_SSH_HOST
```

打開 `http://127.0.0.1:19281/signin`，用 `/web` 或 `agend web` 取得新的登入碼。替代 port 只綁 Windows loopback，原本的登入、Host 與 same-origin 檢查仍有效。用完關閉 tunnel。已明確核准、仍有效的公開連結也是一個選項。不要為了這個 workaround 把本機 listener 開放到 LAN，或關閉認證。沒有替代路徑時，可繼續使用 chat，請操作者安排維護；這裡沒有保證不中斷工作就能重設 relay 的方法。

預防方面，WSL 內有 `wslinfo --networking-mode` 時，可用它確認目前模式；沒有輸出就視為 **unknown**。Microsoft 的文件說明 NAT 透過 wslrelay 轉送 localhost，而 mirrored 使用不同架構。在支援的 Windows 11 22H2+ 主機，操作者可自行選擇在 `%USERPROFILE%\.wslconfig` 既有的 `[wsl2]` 段落設定 `networkingMode=mirrored`。這會影響所有 WSL2 distributions 與 firewall 行為，要在**預先安排的 WSL 重啟**後才生效，重啟會中斷其中的工作。AgEnD 不改 Windows 設定，也不重啟 WSL。Mirrored 是選項，不是保證修復。

來源：[Microsoft networking](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)、[WSL 設定](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)、[WSL 轉送架構](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/localhost.md)。調查與限制：[#1738](https://github.com/songsid/AgEnD/issues/1738)。

### 確認敏感變更

變更存取／F／C 名單、secret、connection 目的地／順序、公開曝光、控制類 instance 設定，或放寬網頁設定（延長本機 session 或閒置時間、開啟瀏覽器終端機或增加分鐘數）會回傳 `202 pending_confirmation`。請求人可用 `GET /api/settings/pending[/:id]` 列出或輪詢，並用 `DELETE /api/settings/pending/:id` 撤回尚未被認領的請求；其他 session 會得到 404。輪詢屬被動讀取，不延長登入有效期；`remaining_ms` 用來倒數，顯示的時間戳不是授權期限。

Fleet admin 在 General 核對遮蔽 secret 的 diff 後確認。Chat 不可用時執行本機命令 `agend settings confirm <id>`；Reject、到期或 session 撤銷都不套用變更。Apply 重試須沿用相同的 `Idempotency-Key` 與 body，回到同一個請求。終態失敗後應重新檢查並用新 key 提出；secret 必須重新輸入。在網頁 app 中，等待確認的請求會在任何面板顯示成一張卡片，附倒數時間和 **撤回**（見 [`/settings`](#settings)）。

**哪個 bot 的 admin 能確認？** 既有連線的變更需要每個受影響連線的 admin
資格；agent 搬移時包含原、新兩個 owner。共用 token 需要所有使用該環境變數的
連線 admin 資格。Fleet 層級變更與新增連線，需要設定中 primary General 所屬 bot
的 admin；primary bot 沒有 General 時，採第一個設定的 General。混合變更需要
同時滿足兩類權限。提示移到另一個 General，不會把確認權限交給該 bot 的 admin；
套用前會重新檢查 admin 資格。跨平台或目標不明時，必須用 host CLI 確認。
首次 Setup 仍由 host 確認。

首次 Setup 同樣回傳 pending 請求。在 host 確認後，還要明確按 **Start AgEnD**。Pending 回應、舊的成功 commit 或已改動的設定，都不能將 setup listener 交給 fleet。
