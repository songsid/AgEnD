# 更新日誌 (Changelog)

本專案的所有顯著變更都將記錄在此檔案中。

格式基於 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [未發佈] (Unreleased)

## [2.2.0] - 2026-10-16

### 升級注意事項 (Upgrade Notes)
- **Kiro 升級恢復（#906、#1624、#1800）。** 恢復對話維持存檔時的 agent；AgEnD 不會自動輸入 /agent swap，也不會在後續啟動重試這項已暫停的切換。沒有身分或啟動紀錄的新 instance，只有在同伴目錄歸屬可確認安全時，才可能接手未認領的最新對話；衝突或歸屬不明會開新對話。對話認領會阻止其他 instance 使用同一 ID。未帶 fleet 標記的舊 steering 檔會保留並警告；請協調共用目錄的所有 fleet 後才手動移除。詳見 Kiro 升級恢復指南。
- **[行為變更] `/view` 不再接受網址或文字框裡的 web token。** 以前儲存個人檔案、頭像與側欄順序，可以用整個 fleet 共用的 `web.token` 以 `?token=` 送出：`/dashboard` 的「View (edit)」連結會把它放進網址列，而 `view.html` 還會把它附加到**每一個** API 請求並存進 `localStorage`。現在寫入需要已登入的 session（與其他面板相同的 CSRF 檢查），或腳本使用 `X-Agend-Token`；`?token=` 不再被當成寫入憑證，token 輸入框已移除，Edit 會把未登入的訪客帶到登入頁再回來。**預設仍可公開讀取 `/view`**（包含即時終端畫面）；新增的 `web.view_access: session` 可要求讀取也要登入。沒有任何程式接受過的唯讀 `view.token` 檔不再寫入，舊檔會在啟動時刪除。
- **[行為變更] 網頁面板改用一次性登入碼登入，dashboard 連結不再帶憑證。** `/dashboard` 以前會把整個 fleet 共用的 `web.token` 貼進 `/view?token=`、`/settings?token=`、`/ui?token=`：它會留在聊天紀錄、瀏覽器歷史與截圖裡，直到執行 `agend web-token rotate` 才失效。現在改給登入頁位址與一組 8 字元登入碼，只能用一次、5 分鐘過期；在登入頁輸入後會建立**伺服器端 session**（不透明的隨機 id，伺服器可以讓它過期、列出、撤銷；不再是 `sha256(web.token)` 那種每台裝置都相同、要到 rotate 才失效的 cookie）。**升級後每個人都要重新登入一次**，舊 cookie 不再被接受。Session 自登入起經過設定的時間、或閒置達設定的時間即結束，以先到者為準（直接連到的 dashboard 預設各 48 小時，可用 `web.session.local.*` 設定；公開連結的 session 為 4 小時、閒置 30 分鐘；見 #1670），fleet 重啟後仍在，頁面上每個寫入動作也都需要每個 session 專屬的 `X-Agend-CSRF` 標頭與相符的 `Origin`。`/dashboard revoke`（Discord：`/dashboard` 選 `action: revoke`）讓所有瀏覽器登出；`agend web --code` 在主機上印出登入碼；`agend web-token rotate` 仍會一次殺掉所有 session。標頭 token（`X-Agend-Token`）維持不變，給 CLI 與腳本使用。**URL 裡的 `?token=` 在 `/ui` 與 `/settings` 上不再是憑證**：舊的 `?token=` 連結或書籤會開到登入頁——在那裡用 `agend web` 或 `/dashboard` 給的一次性登入碼登入一次即可。`agend web` 改為印出登入碼並開啟 `/signin`，不再開 token 連結。新的登入會通知 General topic（`web.notify_login: false` 可關閉）。
- **第一次以 2.2 啟動時，會在 General 介紹網頁聊天一次（#1366）。** 每個聊天平台的 General 會收到一則簡短訊息：網頁聊天
  是什麼、它和 topic 是同一段對話，以及用 `/dashboard` 登入。這會記在 `~/.agend/upgrade-notices.json`，之後不再重複；
  還沒有地方張貼 fleet 通知的平台，等有了之後才會收到。傳送失敗的訊息會在下次啟動時再試。
- **ClassicBot 允許清單空白時，改向 General 申請核准（#1418）。** 原本依賴省略或空白 `allowed_users`、`allowed_groups`、`allowed_guilds` 全開的 fleet，須透過 General 的「允許／允許＋設為管理員／忽略」按鈕核准新啟動，或明確加入授權。ClassicBot 管理員可直接啟動，既有已註冊頻道繼續運作。Telegram 私訊申請現在也有與群組相同的核准按鈕，並向申請者回報結果。「允許＋設為管理員」授予 ClassicBot 管理權限，不是 fleet admin。核准不會自動啟動 Agent，請再次 `/start`（Telegram 群組須由 ClassicBot 管理員使用 `/start@OurBot`）。Discord DM 仍不支援。請在 General 所屬 adapter 設定 fleet admin，以核准申請。
- **AgEnD 執行時需 Node.js ^22.14.0 || ^23.6.0 || >=24**，才能使用 better-sqlite3 v13 的 Node-API 10。支援 bundled runtime 的平台通常不用更新 PATH Node，AgEnD 會使用私有 Node；沒有可用 bundled runtime 時，請先準備合格的系統 Node 再安裝。依來源版本遵循 2.2 升級指南；舊 updater 有先移除舊套件的失敗窗口。
- **`better-sqlite3` 升級至 v13（N-API，`^13.0.3`）。** 原生 SQLite 綁定現在直接在 npm 套件中附帶各平台的預建 N-API 二進位檔案；安裝時不再需要另外從 GitHub 下載，也不需要編譯器。預建檔案在各 Node 版本之間保持 ABI 穩定，因此在 macOS 上安裝時不再需要 Xcode Command Line Tools。
- 敏感 Settings 的 web Apply 現在是提案，不是已完成的寫入（#1423）。本機與公開 session 都需要 General 的 fleet admin，或 host 上的 `agend settings confirm <id>`。Header-token 自動化不能授權敏感修改。請處理 `202 pending_confirmation`，遺失回應時沿用 idempotency key，等待終態結果。拒絕／到期後須重新輸入 secret。Pending 只留在記憶體，重啟後需重提。首次 Setup 須經 host 確認，再明確按 Start；沒有可確認的 chat 路徑就要求 host 確認，絕不自動套用。
- **從 2.1.0–2.1.11 升級，或所在平台沒有自帶的 Node 執行環境時，請用 `npm install -g @songsid/agend@<2.2 版本>`，再執行 `agend install`；不要用 `agend update` 或 `/update`（#1487）。** 從 2.1.12 升級、且主機是 Linux（glibc 2.28 以上）或 macOS 11 以上的 x64 或 arm64 時，2.2.0 成為穩定版後用 `/update` 或 `agend update` 就可以；詳見 [升級到 2.2](upgrade-2.2.zh-TW.md)。
  - 2.1 的更新程式會*先*移除已安裝的 AgEnD，再安裝新版。之後的安裝只要因為任何原因失敗（AgEnD 2.2 拒絕安裝在你的主機，或網路、registry、proxy 出問題），就什麼都不剩，沒有 `agend` 指令。正在跑的 fleet 只能撐到下一次重啟或登入，之後服務就無法啟動。這在真的 Mac 上重現過，launchd 回報 `EX_CONFIG`。
  - 直接用 `npm install -g` 沒有移除這一步；被拒絕時會保留你目前的版本。
  - **如果已經發生了：** 執行 `npm install -g @songsid/agend@2.1.12`（或者等你的主機可以安裝時改裝 2.2 版本），再執行 `agend install`。你的資料目錄沒有被動到。
  - 當安裝是由 2.1 的更新程式啟動時，AgEnD 2.2 的安裝拒絕訊息現在會用白話說明這件事，並附上這些指令。詳見 [升級到 2.2](upgrade-2.2.zh-TW.md)。
- **沒有 bundled Node 的主機與舊 updater（#1488）。** 私有 runtime 涵蓋 Linux glibc 2.28+ 與 macOS 11+ 的 x64／arm64。其他平台缺少私有 runtime 時，需先準備合格的 PATH Node（^22.14.0、^23.6.0 或 >=24），再依 2.2 升級指南手動升級；直接 npm 安裝不會免除 runtime 要求。Alpine／musl 與非 systemd Linux 仍不支援。2.1.12 updater 先 unlink，後續安裝若被拒仍可能沒有 agend 指令。
- **不支援 musl Linux（例如 Alpine）與沒有 systemd 的 Linux 主機。** 在 Node 22.14+ 上 AgEnD 也許還裝得起來，但沒有測試過，也不保證能用。如果還是要在這些環境上跑，[升級指南](upgrade-2.2.zh-TW.md#1-升級前)列了兩個處理方式：從 2.1.x 更新後，刪掉 `~/.config/systemd/user/com.agend.fleet.service` 再執行 `agend start`；以及 `apk add procps`，讓 `agend update` 讀得到行程啟動時間。(#1912)

### 新增 (Added)
- **`delivery_status` 現在會顯示 CLI 真正取用 steer 的時間，而不只是「已收下」（#1201）。** steer，或交給忙碌中 CLI 自己佇列的訊息，早在模型讀到之前就被 CLI 收進輸入；Claude Code 會在下一個工具結束時或回合結束時才取用。AgEnD 現在從投遞開始的位置追蹤 CLI 的 transcript（claude-code、codex）：
  - 這則投遞自己的 marker 出現為「已取用」時，紀錄會加上 `consumed_at` 與 `consumed_via`：`turn` 表示作為自己的回合，`mid_turn` 表示併入進行中的回合。
  - 此時 `uncertain` 的紀錄會變成 `delivered`；尚未寄出的失敗通知會被撤回。
  - 只有完全相符的 marker 才算數，找不到不會改變任何紀錄。
  - 追蹤以有上限的區塊讀取；transcript 不再成長時會越看越少，30 分鐘後結束，並有全 fleet 的數量上限。
  - `delivery_status` 另外顯示 `delivery_mode`（`steer` / `idle_queue`）與 `submission_mode`。
- **Claude Code 在回合中途取用的 steer，重啟後也會算成已取用（#1201）。** Claude Code 把這種情況記成被併入的佇列指令，而不是使用者訊息；重啟對帳以前只把它當成「已排入佇列」，投遞因此停在 `uncertain` 並出現 ⚠️。
- **每個 instance 新增「紀錄」分頁，逐步顯示它在做什麼（#1218）。**
  - 新的「紀錄」分頁位在「檢視」與「詳細資訊」之間。它顯示每一則提示、agent 的回覆（不含思考過程）、每次工具呼叫的參數與結果、錯誤、每個回合在哪裡結束，以及 fleet 事件，例如當機、重新啟動或等待中的提示。
  - 分頁開著時才會從 agent 自己的對話紀錄讀取，有人在看時即時更新。機密值（金鑰、token、密碼、長串隨機字元）會遮蔽，很長的文字會截斷並提供「顯示更多」。
  - 預設關閉（`web.log_tab`），關閉時完全不做任何事。由 fleet admin 在「設定 → 網頁」開啟，這項變更跟其他存取變更一樣需要確認。開啟後，公開連結也看得到。
  - 目前支援 claude-code 與 codex；其他 backend 的分頁只顯示 fleet 事件。kiro 會另外說明原因：要等 AgEnD 能證明 instance 目前所在的對話，才會顯示它自己的步驟，目前還沒有任何 kiro 啟動方式能做到。
- **沒有設定任何聊天平台的 fleet，只靠 web dashboard 也能運作。** 沒有設定 `channel` / `channels` 時，agent 的回覆現在會送到 web 聊天（並告訴 agent 已送出），不再永遠被「Channel adapters are not ready — retry shortly」拒絕。
- **Web 聊天：可以在 dashboard 上回答 fleet 的提示。** instance 看起來卡住、自行結束，或卡在互動式提示時，Telegram 上的按鈕（*強制重啟* / *繼續等待*、*重啟* / *忽略*、*確認* / *取消*）也會出現在該 instance 的 web 聊天中。兩邊是同一個提示，不是複製品：只算一次回答，哪一邊先按就算哪一邊；另一邊的按鈕會收成結果；過期也是兩邊同時。只有這幾種與 instance 健康有關的提示會出現在 web——`/clear` 確認、登入、Classic 群組核准、tips 與 `/model` / `/effort` 選單仍只留在原本發問的地方。從 dashboard 回答需要已登入的 session 與它的 CSRF token、必須指明 instance，而且必須是該提示自己的按鈕之一。
- **Web 聊天：Markdown、多行輸入、重新整理不再清空。** 儀表板聊天的訊息現在會渲染 Markdown（粗體、斜體、`code`、程式碼區塊、清單、引用、連結——只接受 http/https/mailto、在新分頁開啟），
  而訊息內容無法產生任何自己的標記（先跳脫整段文字再套格式）。輸入框可多行（Enter 送出、Shift+Enter 換行），送出失敗會把文字還給你。重新整理不再清空聊天：fleet 會保留每個 instance 最近的訊息
  （`GET /ui/history`，存在記憶體、有上限），SSE 斷線重連時會補送漏掉的訊息。Agent 的長回覆在 web 聊天中不再於 2,000 字截斷（現在 16,000）。
- **Web 聊天：看得到訊息送到哪一步、看得到 agent 正在處理，也能中止它。** 從 web 聊天送出的每則訊息都有送達勾，和 Telegram 訊息上的表情回應是同一套流程：◷ 排在前一則之後、✓ 已交給 agent、✓✓ agent 已收到、! 未送達（每個都有給螢幕閱讀器的標籤，重新整理後仍保留）。目前開著的聊天，其 agent 正在處理時，輸入框上方會顯示「*名稱* 處理中…」與 **中止** 按鈕，作用和 Telegram 的取消按鈕與 `/cancel` 相同：對 CLI 送 Esc，並取消還在排隊的訊息——它們的勾會變成 ⊘。（中止是 `POST /ui/cancel/<instance>`，和 dashboard 其他寫入一樣需要 session 與 CSRF 檢查；它不是 instance 的 Stop，後者會結束整個程序。）Web 訊息的送達回報也不再拿一個從來不是 Telegram 訊息的 id 去 Telegram 上加表情。
- **Web 聊天：可以傳檔案與圖片，也看得到 agent 回傳的檔案。** 輸入框有 📎 按鈕，也可以把檔案貼上或拖進聊天區（每則訊息最多 5 個、每個 10 MB、合計 25 MB；PNG、JPEG、GIF、WebP、PDF 與文字檔）。Agent 收到的方式和 Telegram 完全相同——檔案放在該 instance 工作區的 inbox、一行 `[📷 Image: …]` / `[📎 File: … → …]`，以及 `image_path` / `attachment_path`；agent 在回覆裡附的檔案也會顯示在 web 聊天中（圖片直接顯示，其他是下載連結）。檔案型別由內容判斷，不看檔名或瀏覽器的說法；存檔名由 fleet 決定；而且只能用 fleet 發出的 id 取回檔案（`/ui/file/<id>`），絕不能用路徑。四種圖片以外的檔案一律以下載方式提供，不會在頁面上渲染。附加了但 30 分鐘內沒送出的檔案會被刪除，fleet 中途重啟也一樣：上傳在被訊息帶走前存成 `web-pending-…`，重啟時會掃掉放超過 30 分鐘的（#1273）。已送出的檔案跟 Telegram 的一樣，依 inbox 的 7 天輪替處理。
- **回覆按鈕：agent 可以提供讓人點選的選項（#1266）。**
  - `reply` 接受 `buttons`（最多 10 個，`{ label, value? }`），會出現在網頁聊天、Telegram（inline keyboard）與 Discord（components）。
  - 點擊會以點擊者的訊息送給 agent（`[button] <label>`）。第一個有權限的點擊代表所有人，之後各處都會顯示選了什麼、誰選的。
  - 能在那裡對該 instance 發訊息的人都可以點。按鈕 24 小時後過期，重啟後仍有效，且無法重放。
  - 無法顯示按鈕的地方，選項會附在文字後。
- **網頁聊天：指令與快速動作（#1269）。** 在 instance 的聊天輸入框打 `/`，會列出它自己的聊天指令，和它的 Telegram/Discord topic 接受的指令相同，透過相同的處理程式與指令表（#754/#1148）執行。
  - 可用的指令有 `/ctx`、`/compact`、`/clear`（會先確認）、`/model`、`/effort`（不加參數時列出可選項目）、`/cancel`、`/btw`、`/steer`、`/pause`、`/wake` 和 `/save`。
  - 其他以 `/` 開頭的內容仍照舊當成訊息送出；fleet 層級的指令仍在 General 使用。
  - 快速動作：點聊天標題列上的模型或推理強度，會開啟可選清單；instance 的 context 用到 70% 時，會出現 **壓縮** 和 **清空…**。
  - 透過臨時公開連結時，以 `/raw ` 開頭的訊息會被拒絕，因為它會繞過 `[user:]` 包裝直接進入 CLI；`/save` 在公開連結上也會被拒絕。
- **Web 聊天：表格、巢狀清單、程式碼上色（#1269）。** agent 回覆裡的 Markdown 表格會以表格顯示（標題列、`:--`/`--:`/`:-:` 對齊，儲存格裡的粗體、連結、`code` 照常生效；儲存格內的直線請寫 `\|`）；清單會依縮排巢狀（項目符號與數字可混用，最多六層）；js/ts/json/python/sh 的程式碼區塊會上色。沒有用任何外部函式庫、也不從 CDN 載入：仍是先跳脫再套格式的同一個 renderer，只多了固定的標籤與 class，訊息內容依然無法產生自己的標記。
- **Web 聊天：預覽 agent 的 HTML（#1306）。** agent 回覆裡的 ` ```html ` 區塊下方會出現一張卡片：**預覽** 會在一個由另一個本機 listener（`web.preview_port`，預設 `health_port + 1`）提供的沙箱框架裡執行 HTML，因此它無法使用 dashboard 的登入，也無法操作 dashboard；**停止** 會關閉它；**下載** 會存成 `reply.html`。每台裝置的預覽**預設都是關閉的，要那台裝置自己允許**（在側欄或卡片選單），而且每次都要按下才會執行，並附上說明：預覽可能把資料傳出去，也可能讓分頁變慢或卡住。只有 fleet 標記為 agent 的回覆才會有卡片——來自人的 HTML 一律只顯示成程式碼。透過 tunnel 或 proxy 時需要 `web.preview_origin`（另一個主機名稱），否則卡片會說明預覽為什麼關閉。
- **Web 聊天：以聊天為主的版面，支援淺色與深色（#1307 版面部分）。** 對話是置中的一欄：你的訊息是靠右的泡泡，agent 的回覆佔滿整欄（每則都能複製）；程式碼區塊標出語言、有複製與換行，超過 30 行時先收合；只有停在最底部時畫面才跟著新訊息捲動，不在底部時會出現「↓ N 則新訊息」；agent 工作時輸入框的送出鈕會變成 Stop（開始打字後送出鈕會回來）。側欄可以隱藏（會被記住），在手機上是抽屜。dashboard 會跟隨裝置的淺色／深色設定，也可以在各瀏覽器自選（`/assets/theme.js` 在頁面繪製前就套用），改用系統字型，並且不再有任何行內 `style` 屬性（#1300）。
- **Web 聊天：手機、鍵盤與螢幕閱讀器（#1307 行動版與無障礙部分）。** 在手機上，螢幕鍵盤出現時會縮小頁面而不是蓋住輸入框（`interactive-widget=resizes-content`），版面會避開瀏海與 home bar（safe-area insets），輸入框文字改為 16px，iOS 不會因此放大頁面。agent 工作時按 Esc 會中止回覆（表單或選單開著時、輸入法選字時都不會）。側欄每一列都能用 Tab 移到、用 Enter／空白鍵打開；手機抽屜打開時焦點留在抽屜內，關上後回到 ☰。訊息清單是不會逐則朗讀的紀錄，另有一行 polite 狀態區播報粗略事件（開始工作、完成、已回覆、等你回應）。
- **Web 聊天：agent 的這一輪與附件（#1307 狀態部分）。** 工作列會顯示 agent 已工作多久（從頁面看到它開始起算）；按下 Stop 後顯示「正在中止…」直到 agent 停下；agent 停在終端機上等待（權限詢問、登入、對話框）時會註明，側欄也會出現「等你回應」標記，並說明這是從終端畫面判讀的。把檔案拖到聊天區時會顯示放置位置；每個檔案以標籤顯示檔名與大小；貼上超過 10,000 個字元時會改成文字檔附加（可以再改回文字）。沒有聊天平台的 fleet，卡住、程序自行結束與互動式提示這幾種提示現在會出現在 dashboard 上（之前哪裡都不會出現）；互動式提示只在有 General 可以協助時才會出現。
- **Web chat → ClassicBot 頻道同步（#1320 part B）。** 成功送到 classic instance 的 web 訊息，會同步到該 instance 開了 `web_echo: true` 的 ClassicBot 頻道（預設關、逐 entry）。同步走該頻道自己的 adapter 並關閉 mention，排序與 part A 同一條 before-reply lane，失敗不阻擋 web 投遞。防重入直接沿用 part A 的共用 helper（`neutralizeWebEchoText`、`formatWebChannelEcho`、`isWebChannelEcho`、固定 `WEB_ECHO_PREFIX`）：預覽與附件名稱的 mention 換成可見 ASCII 標籤，ingress 核對 fleet bot 作者加固定前綴。開關在 classicBot.yaml 與 Settings（非 boolean 拒絕、改了重啟該頻道、群組頻道在頁面二次確認）。
- **Web chat → fleet 主題同步（#1320 part A）。** 成功的 web 訊息同步至綁定的 Telegram 或 Discord 主題，排序等待總共最多五秒，之後 Agent 回覆繼續。逾時丟棄尚未開始的副本；已在飛的副本可能晚到，結果另記日誌。`web.echo_to_channel` 預設開啟，可在 Settings 切換，未變更的選項不寫入設定。同步失敗不阻擋 web 投遞；mention／command 改成可見標籤，ingress 核對 fleet bot 作者與固定前綴，避免自己、同 fleet 的其他 bot 或重播副本觸發新回合；同平台任一已設定 bot 身分未知時暫時隔離 bot 前綴候選，人類不受影響。不包含 ClassicBot 或純 web fleet。
- **delivery-outbox.db 與 Task Board 加入保留期限機制（#1335）。** 兩個資料庫以往無限成長：`delivery-outbox.db` 每天累積約 2.5 MB，Task Board 已有 1,099 筆歷史記錄。terminal 投遞（`delivered`/`failed`）與已完成/已取消的任務，若超過 `defaults.retention_days`（預設 30 天），將在 fleet 啟動時清除一次，之後每天清一次。`uncertain` 與非終態的投遞永遠不清除。有尚未關閉的 reply obligation 的投遞會等 obligation 關閉後才清除。還有活著任務在使用的已取消前提條件也會保留。每次最多刪 500 筆並在批次間讓出 event loop。`delivery_status` 查詢一個不存在的 `delivery_id` 時，若該 row 曾被清除，現在會回傳「早於保留期限，已清除」——但只對該投遞的原始寄件方或收件方——而非「找不到」。其他查詢仍可能因紀錄被隱藏、過期或不存在而回傳「Delivery not found」；不能據此認定從未投遞。未篩選的 `task list` 現在上限 100 筆（最近更新優先），並附說明幾筆被省略及如何使用篩選器；有篩選時沒有上限。
- **Task Board 工具現在不再燒 context（#1336）。** 未加篩選器的 `task list` 預設只回傳活躍任務（open/claimed/blocked）——done/cancelled 只有在 `filter_status` 明確列出時才出現。`filter_status` 支援陣列，一次篩多個狀態。清單的每筆資料變成精簡格式（`id`、`title`、`status`、`assignee`、`priority`、`updated_at`）；傳 `verbose: true` 可取得完整欄位，或用新的 `get` 動作查單筆完整記錄。寫入操作（`create`、`update`、`claim`、`done`）回傳小型 ack `{id, status, updated_at}`，不再傳回整個 Task 物件。Task ID 可以縮寫成唯一的 8 位 hex 前綴。`done` 現在也可以直接從 open 狀態使用，不一定要先 claim。
- **選擇性錄製 fleet CPU profile，追查尚未歸因的 event-loop 阻塞（#1338，#1235 的一部分）。** 主機操作者可在冷啟動 `agend fleet start` 時設定 `AGEND_CPU_PROFILE_SECONDS=60`，省略即關閉。行程內以 100 Hz 錄製，最長 30 分鐘後停止（主執行緒能處理期限時），不開 inspector 監聽埠。`AGEND_HOME/profiles` 下的私有檔案每份最多 20 MiB、保留五份；檔案上限不等於 V8 錄製記憶體上限。Agent session 不能透過繼承的環境啟用；未增加聊天、web 或 MCP 觸發入口。
- 可用 `agend profile [秒數]`，或 General 管理員限定的 `/profile`（Discord 原生 slash、Telegram 文字指令）在運行中的 Fleet 錄製有時限的 CPU profile。與既有啟動錄製共用單一 owner，拒絕重複錄製，沿用時限、檔案及關機清理限制。CLI 使用同一使用者的私有 Unix socket，拒絕 agent 環境；不需重啟，也不新增 web/MCP 控制或 inspector port。
- **網頁聊天：在瀏覽器裡跟 Agent 對話（#1366）。** 儀表板的 `/ui` 可以跟任何一個 instance 聊天：在側欄選它，直接打字。
  這和那個 instance 在 Telegram 或 Discord 上的是同一段對話——從網頁送出的訊息會以 `🌐 web-user: …` 出現在 topic，
  Agent 的回覆兩邊都看得到，聊到一半也能在手機和電腦之間切換。傳檔案和圖片、Stop、顯示訊息送到哪一步的勾勾，以及回答
  fleet 的提示，在這裡都能用（見下方各項網頁聊天條目）。用 `/dashboard`（fleet 管理員）或 `agend web` 取得一次性登入碼
  登入。儀表板只聽 `127.0.0.1`；要用手機，請看[從別的裝置連線](web-dashboard.zh-TW.md#從別的裝置連線)。
- **網頁聊天：第一次登入時的簡短導覽（#1366）。** 在某個裝置上第一次打開 `/ui` 時，會有一張小卡片依序介紹五件事——選一個
  instance、它和 Telegram/Discord 是同一段對話、附加檔案、Stop，以及「等你回應」標記——並在頁面上框出對應的位置。按
  知道了、略過或 Esc 後，這個裝置就不再出現；側欄的**導覽**可以再看一次。它不會擋住任何操作，樣式完全來自頁面自己的樣式表
  （沒有 inline style，#1300）。
- General 管理員可從 `/dashboard` 主動開臨時公開 dashboard：私送連結與碼、固定兩小時期限（1–480 分鐘）、固定版 cloudflared、單次入口登入隔離與必要公開登入通知。公開 View 需登入、preview 不暴露，到期／revoke／shutdown 關入口。Cloudflare 終止 TLS；登入授予完整 web-admin，平台故障時拒絕公開登入。
- **「等你處理」：一份列出所有等你處理的事的清單，在 General 即時更新（#1386）。** 每個 bot 在自己的 General 維持一則
  訊息，列出它負責的 instance 正在等什麼：fleet 的提示（沒有回應、已結束、在終端機上等待）、權限／危險指令／登入或其他
  對話框、因需要登入而暫停或已崩潰的 instance，以及 fleet 無法確認或無法送達的傳遞（最近 24 小時）。每一行都連到該提示
  自己的按鈕或 instance 的討論串。不論在哪裡處理掉，訊息都會跟著編輯；有新的事時會重新發一則（因此會通知），最多每分鐘
  一次。傳遞項目有**已確認**按鈕，限該 bot 的管理員使用，並記錄在該筆傳遞上。`needs_you.dm: true` 也會私訊該 bot 的
  管理員。網頁儀表板會透過既有的即時串流收到所有 bot 的同一份清單。`needs_you.live_message: false` 可關閉 General
  的訊息。
- **網頁上的 fleet 組織圖（#1389）。** Fleet → 組織圖：最上方是 General，下面是 `fleet.yaml` 的各個 team 與其成員，最後是未加入 team 的 instance。每個 instance 顯示名稱、它負責的工作、backend 與模型，以及即時狀態（工作中、閒置、等你回應、似乎卡住、已暫停、已停止、已當掉），並附上它的 Discord 討論串或 Telegram topic 連結與聊天連結。組織圖唯讀，操作仍在 Discord 進行。它只讀取 fleet 既有的資料，即時狀態跟著現有的更新串流，不另外輪詢，在手機寬度下也能正常顯示。
- **跑 kiro TUI 的 kiro instance 現在可以在回合中插話（steer）了（#1405）。** `/steer` 與帶 `steer: true` 的 `send_to_instance`，現在能送進工作中的 kiro instance：條件是它用 `kiro_ui: tui` 或 `v3` 啟動，且 kiro-cli 版本已經過 AgEnD 實機驗證：2.27.1（TUI 與 v3）、2.28.0（TUI）。插話會在同一回合的下一個工具邊界被納入。訊息怎麼處理由 kiro 自己的插話模式決定。AgEnD 每次插話前都會從 kiro 的輸入列讀出這個模式，而且從不切換它：只有輸入列顯示 `Type to steer` 時才貼上；輸入框顯示的確實是這次投遞的訊息時才按 Enter；輸入框重新變空後才確認送達。如果顯示的是 `Type to queue`（使用者用 Ctrl+S 選了排隊模式），訊息就照舊在回合結束後送出。legacy UI 與其他版本也是一樣；在這些 instance 上用 `/steer` 會說明為什麼無法使用。
- **網頁 app 的「等你處理」（#1386，#1408 第 4 步）。** `/ui/needs` 列出所有等你處理的事，來自每個 bot 的世界：附自身按鈕的 fleet 提示、停在對話框、暫停或崩潰的 agent，以及附 **確認** 的傳送。這和 General 的即時訊息是同一份清單，在任何地方處理過就會消失。側欄會顯示數量，分頁標題以 `(N)` 開頭，桌面瀏覽器可在分頁位於背景時為新項目跳出通知（每台裝置自行開啟）。
- **Bot Token 步驟新增設定教學連結。** `agend quickstart` 和 `agend init` 設定精靈在要求輸入 Bot Token 時，現在都會顯示 📖 連結前往網站設定教學 —— Telegram：[songsid.github.io/AgEnD/zh-tw/setup-telegram/](https://songsid.github.io/AgEnD/zh-tw/setup-telegram/)，Discord：[songsid.github.io/AgEnD/zh-tw/setup-discord/](https://songsid.github.io/AgEnD/zh-tw/setup-discord/)。語系為 `zh-TW` 時自動使用繁體中文頁面。網址統一定義於 `src/setup-guide.ts`，兩個檔案都從該模組匯入（無循環引用）。
- 新增純資料降版相容性檢查：Node 22 上的新版 store → Node 20 上已發布的 2.1.12 → Node 22 新版 store。報告區分 additive DB 相容性與 web 政策、待核准操作、排程重試、Kiro ownership 保護的退化；不保證可安全 live 降版（#1441，Part C）。
- **Node 相容性檢查（#1441）。** 沒有支援的 bundled runtime 時，preinstall 會拒絕不相容的系統 Node；bundled-runtime 平台可在 npm 本身使用舊 Node 時安裝。略過 lifecycle scripts 不會讓不相容 runtime 變安全：launcher 仍須找到私有 runtime 或明確允許且合格的系統 fallback。舊 updater 若已先 unlink，安裝失敗仍可能沒有已安裝的指令；請見 2.2 升級指南。
- **AgEnD 在 Linux 與 macOS 上自帶 Node 22.23.3（#1450）。** 在 glibc 2.28 以上的 Linux 與 macOS 11 以上（x64、arm64），安裝 AgEnD 會一併安裝它的 runtime 套件 `@songsid/agend-node-<os>-<cpu>`（官方 Node 22.23.3，附 provenance 發佈）。不論 PATH 上是哪個 Node，AgEnD 都用它執行；你自己的 Node 以及使用它的 CLI（codex、claude…）都不受影響。
- **網頁上的提示快取過期分析（#1468）。** Fleet → 快取會針對每個 Claude Code 與 Codex instance，在最近 24 小時、7 天或 30 天內顯示：
  - 請求之間閒置了多久，並以快取時效為準線（Claude Code 為 1 小時；Codex 在 GPT-5.6 以上為 30 分鐘）；
  - 有多少次請求遇到已過期的快取，以及重寫快取的成本；
  - 保溫 ping 是否划算，連之後沒人讀的 ping 也計入；
  - 是否建議保溫，並附上理由。

  ClassicBot 頻道也包含在內。兩個共用工作目錄的 instance 無法從 transcript 分辨，因此兩者都不分析，面板上會註明原因。fleet 總計列會加總以上所有數字。成本以單一價目表的牌價計算，面板上會顯示查證日期。Codex 不記錄快取寫入，其數字會標示為「估算」。Kiro 與其他 CLI 顯示「不提供」。

  此面板唯讀。AgEnD 以有上限的分段方式逐步讀取 transcript，每個 instance 只保存一份小摘要（`cache-ledger.json`），從不呼叫任何供應商 API。
- **網頁聊天：agent 的 HTML 預覽可以在對話旁的面板中開啟。**
  - 預覽卡片上的 **在面板中開啟** 會給它更大的空間：寬螢幕是左右分割、可拖曳分隔線（可用鍵盤調整，寬度記在這台裝置），手機則是全螢幕頁面。
  - 面板有頁面／程式碼、重新載入、停止、下載，以及回到區塊所在訊息的連結。
  - 之後的回覆有同一區塊的較新版本時，面板會提示，而不會自己換掉。
  - 關閉面板或打開別的對話會停止預覽。預覽的隔離方式不變：同樣是預覽位址上的沙箱框架、同樣需要每台裝置各自允許、同樣要按一下才執行。
- **Codex 也有回覆完成守衛了（#1510）。**
  - Codex agent 回覆人類訊息時若只印在終端機、沒有呼叫 `reply`，現在會像 Claude Code 與 Kiro 一樣被提醒一次，請它送出結論。
  - 前提是 Codex 自己的 session 紀錄顯示：裝著你這則訊息的那一輪已經結束，而且之後沒有新的一輪開始。終端機畫面在一輪途中可能看起來閒置，但紀錄只有在一輪真正結束時才會結束它：長時間的工具執行、或併進這一輪的 steer，都會讓它保持未結束。
  - 被中斷的一輪（Esc）或因 provider 錯誤結束的一輪不會提醒；在 instance 跟隨的紀錄裡找不到的一輪也照舊不提醒，例如兩個 Codex instance 共用同一個目錄時。
- **Muse 也有回覆完成守衛了（#1510）。**
  - Muse agent 回覆人類訊息時若只印在終端機、沒有呼叫 `reply`，現在也會像 Claude Code、Kiro 與 Codex 一樣被提醒一次，請它送出結論。
  - 前提是 Muse 自己的 session 紀錄顯示：裝著你這則訊息的那個 run 已經結束，而且之後沒有新的 run 開始。在 run 執行中送來的訊息，會讓 Muse 在第一個 run 結束後再跑一次；兩個 run 之間終端機會短暫顯示閒置，但紀錄會讓第二個 run 一直保持未結束，直到它真的結束。
  - 被取消或失敗的 run 不會提醒；在這個目錄的 Muse 紀錄裡找不到的訊息也照舊不提醒。
- **網頁聊天：agent 附上的 `.html` 檔可以預覽（#1522）。** agent 在回覆中附上的 `.html` 或 `.htm` 檔，現在和 ` ```html ` 區塊一樣有預覽卡片：預覽、在面板中開啟，並沿用同樣的每裝置允許設定與沙箱框架。只有在你點擊時才會讀取檔案，上限 1 MiB。使用者上傳的檔案仍然只是一般下載。agent 也會被告知：完整頁面請優先附 `.html` 檔，而不是貼一大段 ` ```html ` 區塊（Discord 與 Telegram 會把它切開）。
- **設定：在瀏覽器輸入 bot token（#1529）。** 新增連線和設定精靈用密碼欄位接收 bot 的 token，並先向 Telegram 或 Discord 確認（「這是 @your_bot。」）。token 存在這台電腦，名稱自動產生，例如 `AGEND_DISCORD_2_TOKEN`（顯示在「進階」），不需要編輯 `.env`，也不需要自己取變數名稱。連線會顯示「已設定 token」並提供「更換」。
- **設定：在瀏覽器邀請 Discord bot（#1533）。** Discord token 驗證通過後，「新增連線」和設定精靈會顯示「邀請 @your_bot 加入你的伺服器」，邀請只要求 AgEnD 會用到的權限，絕不含系統管理員。邀請後會自動選好 bot 加入的伺服器，並把該伺服器的文字頻道列成清單（#general 優先）。表單也會說明到哪裡開啟 Message Content Intent；Discord 因這個 intent 拒絕的連線，現在會直接說明，而不是只顯示「有問題」。
- **設定：新增連線不必重新啟動 AgEnD（#1539）。** 當 AgEnD 已經在執行某條連線時，從設定新增的連線（新增連線或設定精靈）會在套用後立刻啟動；替沒有在執行的連線更換 token 也會直接啟動它。fleet 的第一條連線，以及修改既有連線，仍需要重新啟動。
- **網頁：只用網頁的 fleet 會顯示首次使用卡片，設定精靈也能接上既有的 agent（#1549）。** 沒有任何 Telegram 或 Discord 連線時，聊天頁和設定 › Agent／連線會顯示一張卡片：**連接聊天應用程式** 會開啟設定精靈，**只用網頁** 會在這個瀏覽器裡隱藏卡片。設定精靈的第一步可以選 **既有的 agent** 或 **新的 agent**。既有的 agent 會保留它的目錄、backend 和設定，只有聊天連線改成新的機器人。新的 agent 也不能再沿用既有 agent 的名稱，把它覆蓋掉。完全沒有 agent 時，聊天頁會提供 **新增 instance**，側欄的新增 instance 按鈕也改成 **+**。開發者分頁的下載按鈕改為 **下載 fleet.yaml**，新增 instance 對話框裡的「Topic 名稱」欄位改為 **名稱**。
- Web dashboard 新增銀色 **Ag** 分頁圖示與 apple-touch 圖示，包含登入頁、View 與臨時公開連結。圖示不需登入即可載入，Host 檢查與既有 Content Security Policy 維持不變（#1557）。
- **網頁：每個 instance 的詳細資訊頁，以及「聊天 / View / 詳細資訊」切換（#1561）。** 每個 instance 現在都有自己的詳細資訊頁，網址是 `/ui/fleet/agent/<name>`。頁面上有它的執行環境和最近活動，以及唯讀的設定摘要：目錄、綁定在哪裡、標籤和說明。按 **到設定編輯** 會開啟那個 agent 的設定。⋯ 選單可以啟動、重新啟動、停止、暫停或喚醒它，確認步驟與以前相同；刪除 instance 仍在聊天頁的 ⋯ 選單和設定裡。在 instance 的頁面上，標題列可以切換它的 **聊天**、**View** 和 **詳細資訊**；手機上則是標題列下方的分頁。開著某個 instance 時，按 **Fleet** 會進到那個 instance 的詳細資訊，不再總是落在 Tasks。在詳細資訊或 Fleet 分頁上，點側欄的 instance 會開它的詳細資訊。
- **網頁：所有頁面共用一個字級，標題列的控制也都一樣（#1563）。** 聊天、View、instance 的詳細資訊和 Fleet 的標題列，現在都有同樣兩個控制，順序也相同：**字級** 和 **用量**。字級有 **小／中／大**，這台瀏覽器只有一個設定：在任何頁面選了，每個頁面都會套用，重新載入後也一樣。View 保留 **剛好填滿**，讓終端畫面符合框的大小。之前在 View 的設定會沿用：舒適變成大，精簡變成小。fleet 關閉用量面板時，**用量** 不會顯示。
- **網頁聊天：AgEnD 重新啟動後，對話還在（#1565）。** 每個 agent 最新的 500 則訊息會保存在這台電腦上，放在該 agent 工作區中的私人檔案（`workspaces/<名稱>/web-chat.json`），艦隊再次啟動時會載回。重新啟動期間一直開著的頁面，每則訊息只會出現一次。這些訊息裡的檔案在重新啟動後仍可開啟——前提是檔案還在 agent 的收件匣裡且沒有變動；否則只顯示檔名並標示為無法取得。按鈕與送達勾勾不會保存。刪除 agent 時會一併刪除這個檔案。
- **`/web` 是 `/dashboard` 的短名稱（#1569）。** 在 Discord 和 Telegram 上的行為完全一樣：同樣只限管理員、沒有設定管理員時同樣回覆「已停用」、同樣的拒絕訊息，也同樣有 `/web revoke`。Discord 把它註冊成獨立的 slash 指令，Telegram 選單把它列在 `/dashboard` 旁邊。
- **登入頁可以幫你要一組新的登入碼（#1570）。** 曾用 `/dashboard` 的碼登入過的瀏覽器會出現「傳一組新的登入碼給我」按鈕，session 過期後不必再回聊天室。新的碼只會私訊給收到上一組碼的人，而且對方必須仍是 fleet 管理員；私訊會寫出是哪個瀏覽器要求的，並提醒可以用 `/dashboard revoke`。每個瀏覽器與整個 fleet 都有頻率限制，登入暫停期間一律拒絕。公開連結上只有在該連結開著時才有效，登入照常公告。`/dashboard revoke` 與 `agend web-token rotate` 會讓所有瀏覽器失去這個按鈕。
- **網頁聊天的附件現在可以直接預覽（#1589）。** 音訊和影片檔（mp4、webm、mov、mp3、m4a、wav、ogg）會在訊息裡用瀏覽器內建的播放控制播放，依檔案 id 分段串流，每段最多 4 MiB。文字檔會顯示成一張卡片，附有「顯示」和「下載」，先顯示前 200 行，再提供「顯示全部 N 行」。Markdown 交給聊天本身會先跳脫的渲染器處理，JSON 會排版並上色，程式碼會上色，CSV 和 TSV 顯示成表格，其他一律當純文字。檔案裡的內容絕對不會被執行，超過 1 MiB 的檔案仍然只能下載。每張卡片的排版最多建立 4,000 個元素（表格儲存格、上色的語彙單元、Markdown 元素），CSV 最多 50 欄，按下「顯示全部」也一樣；超過時改以純文字顯示。頁面只允許從自己的 `/ui/file/` 路徑載入媒體。已經不存在的檔案照舊顯示，不提供預覽。公開連結維持原樣：在那裡附件只能下載，頁面也不允許任何媒體。
- **手機網頁：用滑動開關側欄（#1605）。** 在對話上往右滑會打開側欄，往左滑就關上——效果和按 ☰、點旁邊一樣。從螢幕最左邊開始的滑動留給瀏覽器（在 iPhone 上是「上一頁」）；在程式碼、表格、終端畫面和輸入框上的滑動，以及對話框或圖片檢視器開著時，也一樣不會觸發。上下捲動永遠不會被攔下。另外：**設定 → 這台裝置** 的**導覽**現在會等聊天畫面畫好才開始，結束後游標回到輸入框。
- **網頁：可以設定 dashboard 登入維持多久（#1620）。** 直接連到 dashboard 時（本機、區網或 tailnet），`fleet.yaml` 的 `web.session.local.absolute_hours` 和 `web.session.local.idle_hours` 可設定登入維持多久、以及可閒置多久——1 到 720 小時（預設仍是 12 和 2）。公開連結的登入維持固定的 4 小時／30 分鐘。變更不需重啟即生效；改短時，已超過新期限的 session 也會被登出。
- **網頁：新增「設定 → 網頁」分頁（#1620）。** 可編輯從 dashboard 本身網址登入後可維持多久、閒置多久登出（`web.session.local.*`）、`/login` 開啟的瀏覽器終端機（開或關，以及分鐘數）、web 同步和公開連結選單；web 同步和公開連結從「一般」移到這裡。放寬存取的變更（延長 session 或閒置時間、重新開啟瀏覽器終端機或增加分鐘數）要等 fleet admin 在 General 或用 `agend settings confirm <id>` 確認；收緊存取的變更立即套用。其他網頁設定只列出，請在 `fleet.yaml` 編輯。透過臨時公開連結無法變更任何一項。
- **網頁：session 期限設錯時不會變得更長（#1620）。** 驗證器會拒絕的值，不再一律退回 12 小時的預設值（那可能比設定的還長）：閒置時間超過 session 時長時會縮短成 session 時長，低於 1 小時的值視為 1 小時。
- **網頁：頭像與 Discord 伺服器表情改由 dashboard 自己提供（#1630 第一部分）。** 網頁收到的狀態現在會說明每個 instance 用什麼代表，依序為：在 View 上傳的圖片、它自己的 bot 頭像（只有擁有專屬 bot 時才用；共用 bot 的 instance 略過這一步）、persona emoji，或名稱的第一個字。在 Discord 伺服器裡有自己顏色的 bot，也會以該顏色作為強調色。bot 頭像與 fleet 所在 Discord 伺服器的自訂表情，會在主機上用 bot 自己的 token 取得，存在 `~/.agend/cache/`（每天最多更新一次；更新失敗時保留上一份），只提供給已登入的 session（臨時公開連結也可以讀取，僅限讀取）。頁面不會從 Discord 或 Telegram 載入圖片。側欄會在下一個變更開始顯示它們。
- **網頁聊天：Discord 伺服器表情會顯示為圖片（#1630 第三部分）。** 訊息中的 `<:名稱:id>` 或 `<a:名稱:id>`（Discord 自訂表情的文字形式），若屬於 fleet 的 Discord bot 所在的伺服器，會顯示為表情圖片。圖片由 dashboard 自己提供，頁面不會從 Discord 載入；已知表情清單每個頁面只讀取一次，而且只在訊息中有表情時才讀。其他的照原文顯示。側欄的圖片檢查也更嚴格：只接受 dashboard 圖片路徑下的單一檔案，絕不接受跳出該路徑的位址。
- **網頁：側欄會顯示每個 instance 是誰（#1630 第二部分）。** 每個 instance 以顯示名稱呈現，滑鼠停留時顯示 instance 名稱（兩個顯示名稱相同時會寫在名稱下方）。名稱旁是它的圖片：在 View 上傳的圖片、它自己的 bot 頭像、persona emoji，或名稱的第一個字。在 Discord 伺服器裡有顏色的 bot 會以該顏色作為外框。狀態圓點在圖片上，除了顏色，也會把狀態（閒置、工作中、似乎卡住、已暫停、已停止、已當掉、等你處理）讀給螢幕閱讀器。聊天標題與「等你處理」清單也使用顯示名稱。
- **Agent：升級後，每個 agent 會收到一次「對你而言有什麼新功能」的通知（#1633）。** 在舊版 AgEnD 時開始的 session 可能不知道新的工具參數：Claude Code 會沿用對話中先前載入的工具說明，因此看不到 `reply` 的 `buttons` 或 `stickers`。現在每個既有 instance 會在收到下一則訊息前收到一則簡短通知（不會在 turn 進行中插入，也不會發給沒人傳訊息的 instance），列出與 agent 相關的變更與確切參數名稱，並提醒重新載入看起來較舊的工具說明。每一項每個 instance 只會收到一次，紀錄在重啟後仍保留。新 instance 不會收到，因為它們一開始就是最新的工具。沒有 agent 相關變更的版本不會發送任何通知。
- **網頁：最愛（#1664）。** 為 instance 加上星號，就會釘選在側欄最上方的**最愛**群組，依加入的順序排列。在電腦上，滑鼠移到某一列或聚焦時會出現 ☆，已加入最愛的列會一直顯示。在手機上，請點清單上方的**編輯**。**編輯**也會顯示 ↑ ↓ 讓你調整最愛的順序。最愛屬於會同步的偏好設定（#1665），所以手機和電腦看到的是同一份清單。已刪除的 instance 會從清單移除；暫停或停止的仍會保留。公開連結看得到最愛，但無法變更。最多 50 個。
- **網頁：偏好設定在你的所有裝置同步（#1665）。** 主題、語言、側欄的排序、收合的群組與篩選、以及 HTML 預覽的允許設定，現在都存在主機上，手機和電腦會保持一致。每個瀏覽器都留有一份副本，而且頁面會帶著主機上的主題送出，所以載入時不會閃爍，新裝置也一樣。更新後第一次載入時，裝置會把主機還沒有的設定上傳一次；之後以主機上的值為準。「設定 → **偏好設定**」會列出哪些會同步、哪些留在各裝置（導覽、文字大小、視圖寬度、側欄顯示或隱藏、面板寬度、桌面通知）。公開連結可以讀取這些偏好設定，但無法變更，也永遠無法開啟預覽。
- **Agent 之間的訊息也會出現在 web chat（#1672）。** 一個 instance 傳給另一個的訊息（`send_to_instance`、`delegate_task`、`request_information`、`report_result`）現在會顯示在雙方的 web chat，規則與主題相同，依 `cross_instance_visibility`：`full` 完整訊息、`summary` 一行、`hidden` 不顯示。接收方不顯示 report 與 update，General instance 一律略過。沒有聊天平台的 fleet、或沒有主題的 instance 也會顯示。每則都是淡色、唯讀的狀態列（純文字，絕不當成 agent 的回覆，過長會收合），計入聊天紀錄，重啟後仍在。
- **網頁聊天：提及的顯示方式和 Discord、Telegram 一樣（#1682）。** 使用者提及 `<@id>`（或 `<@!id>`）現在顯示為 **@名稱** 標籤，不再是原始代碼。角色提及 `<@&id>` 與頻道提及 `<#id>` 也以相同方式顯示，分別是 **@角色名稱** 與 **#頻道**，每個標籤在滑鼠停留時都會顯示 id。名稱來自 AgEnD 已經知道的資訊：fleet 自己的 bot（以它所屬 instance 的名稱顯示）、傳過訊息給 fleet 的人，以及它的 bot 所在的 Discord 伺服器。AgEnD 不會為此多送任何 Discord 請求，頁面也只會取得它正在顯示的提及名稱。不知道名稱時顯示 **@user**、**@role** 或 **#channel**，絕不顯示原始代碼。Telegram 的 **@使用者名稱** 也有相同外觀。程式碼片段與程式碼區塊維持原樣。
- **Telegram /web 失敗時提供 bot 私訊連結（#1686）。** 當使用者還沒與 bot 開啟私訊而導致登入碼無法送達時，失敗訊息現在會附上一個「**先開私訊 →**」URL 按鈕，直接深連結到 bot 的私訊，並預填 `/start web`（需要 Telegram 7.7 以上）。按鈕只有在已知 bot 的 username 且格式符合 Telegram 規範（`[A-Za-z0-9_]{5,32}`）時才顯示；未知或格式不符時，退回原本的純文字說明。登入碼不會貼到群組中。Discord 行為不變。

  /web 選單也會多一行含有相同連結的提示，讓使用者在點按鈕之前就知道要先做什麼。

  當你是 fleet 管理員，從私訊傳 `/start web` 時，現在會收到「你現在可以在群組裡使用 /web 了」的確認，而不是試圖啟動一個叫 `web` 的後端。
- **網頁：可以編輯 team（#1689）。** 「Fleet → Teams」的每個 team 現在都有 **編輯**，會打開已填好目前成員和描述的 team 表單；已不在 fleet 裡的成員仍會列出，方便移除。儲存時使用與 agent 的 `update_team` 工具相同的更新：成員必須是這個 fleet 的 instance，只要有一個不是就不會儲存。team 無法重新命名，表單上會說明（請建立新的 team 再刪除舊的）。組織圖下次打開時就會反映變更。`update_team` 現在也可以修改 team 的描述（留空即清除）。`agend-agent team-update <名稱> [新增,…] [移除,…] [描述]` 現在可以正常使用了：它原本把成員清單當成純文字送出，會被 `update_team` 拒絕。儲存失敗時，team 會維持原狀。`update_team` 和 `create_team` 現在只接受 fleet.yaml 確實定義的名稱，`constructor` 或 `__proto__` 不再會被當成 instance 或 team。
- **停在 AgEnD 不認得的提示上的 pane，現在會被發現（#1691）。** CLI 顯示一個沒有已知對話框能解釋的選擇提示（游標停在編號選項上，或 `[y/n]` 問題）、CLI 自己的輸入框不見了，而且 pane 一分鐘沒變時，AgEnD 會：
  - 暫停送訊息給這個 instance；
  - 把它標成等待輸入；
  - 發出一個「需要你處理」項目和一則通知，說明提示在問什麼（例如「Switch model?」）。

  AgEnD 絕不替它按任何鍵。pane 一改變就解除；同一個提示停好幾個小時也只回報一次。agent 回覆裡只是帶了編號清單，不算提示。起因是 claude 新的「Switch model?」對話框（#1690），它曾讓 pane 無聲無息地卡住。
- **Claude Code instance 可以使用不同的 claude.ai 帳號（#1699）。**
  - 設定 `backend_options.claude-code.credential_profile: work`，再用
    `CLAUDE_CONFIG_DIR=~/.agend/credential-profiles/claude-code/work claude auth login` 為這個 profile 登入一次。
  - 每個 profile 有自己的登入、帳號、信任設定與對話，`settings.json` 一開始複製你的設定。你的 `CLAUDE.md`、agents、
    commands、skills、output styles 與 plugins 所有 profile 共用。
  - macOS 上每個 profile 有自己的鑰匙圈項目，不會互相登出。
  - 用 `update_instance_config` 切換 profile 會重啟 instance 並開新對話，同時交接近期工作。切到尚未登入的 profile 會被拒絕，並告訴你要執行的指令。
  - 沒有設定 profile 的 instance 啟動方式與以前完全相同。
- **每個 Claude Code profile 各自的用量（#1699 第 3 部分）。** 使用中的每個 Claude Code credential profile 現在在 `/usage`、`get_usage` 以及 dashboard 的用量側欄與對話框中都有自己的一列（`Claude (work)`、`claude:work`），與預設的 `Claude` 列並列。每一列只讀該 profile 自己的登入（macOS 上是 claude 為該 profile 目錄保存的鑰匙圈項目），不會讀預設登入。用量 API 無法回應時，該列只會改用自己 instance 寫下的額度。尚未登入的 profile 會顯示「尚未登入」、`/login claude-code <profile>`（#1699 第 2 部分）與在主機上登入用的完整指令，不會顯示其他帳號的數字。在此之前，使用 Claude profile 的 instance 完全沒有用量列。沒有 Claude profile 的 fleet 與以前完全相同。
- **在聊天室為 Claude Code profile 登入：`/login claude-code <profile>`（#1699）。**
  - 它會在 `/login claude-code` 用的同一個瀏覽器終端裡，為該 profile 執行 `claude auth login`，所以用手機也能完成。
    Discord 的 `/login` 多了 `profile` 選項。
  - 登入後只喚醒或重啟使用該 profile 的 agent。為預設登入重新登入時，也不再重啟使用其他 profile 的 agent。
  - agent 的 profile 登入過期時，警示會附上為該 profile 登入的按鈕。
  - Kiro 與 Codex 的 profile 仍要在主機上登入；`/login kiro-cli <profile>` 會回覆要執行的指令。
- **臨時公開連結也能看 HTML 預覽了（#1723），用手機也可以。**
  - 連結會在背景為預覽另開一條自己的 quick tunnel，連結不等它。
  - 還沒好時卡片會顯示「預覽啟動中…」；開不起來時連結照常可用，卡片會說明原因。
  - 它隨連結一起關閉。預覽網址和儀表板是不同的站點，框架比在主機上更隔離。
  - 你這台裝置的 **允許 HTML 預覽** 照樣適用。
  - `web.preview_on_public_link: false` 可以關閉；若設定了 `web.preview_origin`，就改用它。
- `send_to_instance`、`delegate_task` 支援明確的 `forwards` 引用，讓下游 agent 用 `delivery_status` 讀取已送達的原始訊息，包括新記錄的使用者授權收據。每次轉交都須由能讀取該列的寄件者授權，只提 ID 不會取得權限。使用者收據分開保存原始身份／adapter／內容與實際格式化投遞內容，缺乏 owner 綁定的正向證據時維持 uncertain。平台回覆 ID 不變；`/raw`、歷史轉交與 Web 未知的平台身份不能證明原生人類授權。協作指引也說明隱藏／過期查詢與 CLI 轉交用法。
- **`/backend`：從聊天把 instance 換到另一個 CLI backend（#1806）。**
  - Discord、Telegram 和 web chat 都能用，權限和 `/model` 完全相同：頻道管理員。
  - 先選 backend（只列這台主機已安裝的 CLI），再選模型（`/model` 的清單，或預設），再選推理強度（`/effort` 的等級；backend 沒有推理強度就跳過），最後確認。`/backend <backend> [模型] [推理強度]` 會直接跳到確認。
  - 確認之前不會有任何變更。確認後，backend、模型和推理強度一次寫入，instance 只**重新啟動一次**，並開**全新的 session**：對話不會跨 backend 延續。正在進行的一輪會被中斷。停止或暫停中的 instance 只儲存、不會啟動。
  - 走的是 `update_instance_config` 的 backend 切換：套用新 backend 自己的選項；若憑證 profile 沒有新 backend 的登入，會被拒絕，並附上登入指令。被拒絕時不會留下只改了一半的設定。
  - 未安裝的 backend，或新 backend 沒有的模型、推理強度，會被拒絕並列出可選項目。選到目前已在用的 backend 不會有變更，並提示改用 `/model` 和 `/effort`。
  - 只適用 fleet instance：ClassicBot agent 的 backend 在 `classicBot.yaml` 或設定頁裡設定，`/backend` 在那裡會說明這點。
- **`close_poll` 可以提前截止投票（#1823）。** agent 可以在截止前關閉自己的一個進行中投票，例如所有人都答完時。效果和到期截止相同：顯示統計，結果只送一次，並註明是提前截止。
- **回覆按鈕可以變成投票（#1823）。** `reply({ buttons, poll: { seconds } })` 會把按鈕變成有時限、Kahoot 式的投票，可用於 Discord、Telegram 與網頁聊天。
  - 能在那裡點按鈕的人都能投票，每人一票，可以改票，自己的選擇只會私下告訴本人。
  - 開放期間只顯示「已有 N 人作答」和剩餘時間；`reveal: "live"` 會即時顯示票數。
  - 截止時按鈕顯示統計。agent 會收到一則 `[poll results]` 訊息，列出各選項的投票者，以及每人在投票開始後幾毫秒作答，讓 agent 自己公布答案和計分。
  - 截止時間和結果在重啟後仍然有效，結果只會送達一次。
- **網頁：Fleet 概覽多了「文件」連結（#1844）。** Fleet 頁的標題列有 **文件**，會在新分頁開啟專案的文件網站——dashboard 是中文時開繁體中文版，否則開英文版。手機上是一個書本圖示。

### 變更 (Changed)
- **README 開頭多了一張圖（#1959）。** 圖裡是網頁儀表板（以示範資料繪製），旁邊是一支呈現同一段對話的手機示意圖，有淺色與深色兩版，跟著你的主題切換。產生這張圖的腳本放在 `docs/assets/readme/src/`，介面改了之後可以重新產生。
- **送給忙碌中 Claude Code instance 的訊息，現在交給 Claude 自己的佇列，不再等目前回合結束（#1169），與 Codex 相同。** 已在真的 Claude Code 2.1.293 TUI 上驗證：
  - Claude 工作中送來的訊息會排進佇列，回合結束後送出；進行中的回合不會被打斷，訊息只送一次。
  - 工具執行中時，Claude 在該工具結束的時候接收訊息。
  - 只有讀得到 Claude 的輸入框時才會交接；AgEnD 認不得的對話框、或讀不到的畫面，一律先等。
  - AgEnD 從 Claude 畫面確認交接：佇列中看得到這則訊息的 id，或貼上前沒有、貼上後才出現的佇列——輸入框顯示「Press up to edit queued messages」，上方緊接「ctrl+x ctrl+s to send now」那一列。回覆裡只是印出這幾個字，不算證據。
  - TUI 吞掉的 Enter 會在回合結束後再補按一次，絕不重貼。
- **AgEnD 現在看得出送給 Claude Code 的訊息是否真的離開了輸入框（#1200）。** 它把 Claude 的輸入框當成兩條框線之間的區域來讀（依 Claude Code 2.1.293 的實際畫面），以前只能看到「Enter 之後 pane 有輸出」。現在：
  - 訊息出現在輸入框外，並且畫面上看得到這則訊息自己的 id，就算送出：閒置時回顯在輸入框上方，忙碌時出現在 spinner 上方的佇列區。一般訊息與送進忙碌回合的 steer 都適用；steer 以前記為 `steer-accepted-marker-on-pane; input-row-unreadable`，現在記為 `positive submission proof`。
  - Enter 之後訊息還留在輸入框（長的貼上會被 Claude 收合成 `[Pasted text #1 +11 lines]`）：再按一次 Enter，絕不重貼。
  - 兩者都無法證明時，投遞維持 👀，不會被當成遺失。
  - Claude 畫面無法顯示結果的 steer，不會再被貼第二次；以前可能因此送出兩次。
- **由許多小步驟累積出來的整個 fleet 卡頓，現在會寫出是哪些步驟，不再只記「slow sync work: unknown」（#1235）。** 以前只有單一步驟花 50 ms 以上，卡頓 log 才會寫出原因；每分鐘對所有 instance 同時做一點事的檢查，加起來卡了一秒卻沒有名字。現在連續執行的短步驟會加總，並附上次數，例如 `daemon.stateEvaluate:safety_sweep=1100ms (20 calls)`。
  - 現在會計時的步驟包括：啟動每個 `tmux` 指令、fleet 每分鐘檢查所有 pane、各 instance 評估自己的 pane、每 30 秒的健康與回覆檢查、投遞佇列、儀表板的狀態更新，以及確認投遞時讀取的對話紀錄。
- **「Event loop stalled」警告現在會在能證明時，說明當時 fleet 是在忙還是在等（#1235）。** 警告會描述該次回報中，每 100 ms 一次的探針看到的最長間隔：它的時間點，以及 event loop 執行緒在其中拿到的 CPU 時間，另附主機的負載平均。執行緒在間隔中一直在跑，代表是 fleet 自己的工作卡住；幾乎沒跑，代表 fleet 在等：主機被其他工作佔滿（例如同一台機器上的大型測試），或卡在緩慢的系統呼叫。數字分辨不出兩者時，警告會直接說分辨不出。`docs/diagnostics.md` 說明如何解讀這則警告。
- **網頁聊天：長段貼上，以及停留在最新訊息（#1269）。**
  - 貼上超過 4,000 個字元的文字時，會改成文字檔附加，不再塞滿輸入框；先前的門檻是 10,000。檔案上的 **改為文字** 一樣可以放回輸入框。
  - 你停在最新訊息時，即使上方的內容事後才繪製完成（例如圖片或預覽卡片），聊天仍會維持在最底部。你往上捲閱讀時，畫面不會被拉走；按 **最新**（或 **N 則新訊息**）即可回到底部。
- **`/dashboard` 和 tips 說明的是現在的儀表板（#1366）。** 斜線選單改為「登入網頁儀表板與網頁聊天」；儀表板在 `localhost`
  時，`/dashboard` 的回覆會補一行說明手機怎麼連進來；關於儀表板連結和 web token 的 tips 改為說明一次性登入碼與讓瀏覽器
  登出；新增四則介紹網頁聊天的入門 tips；Settings 的「更新重點」改列 2.2，有英文與繁中。
- **`/ui` 現在是一個有側欄的 app，外觀也全面更新（#1408 第一步）。**
  - **版面：** 側欄放 instance 清單、Fleet、檢視、設定、主題、語言和 Session 選單。對話置中成一欄，下方是圓角輸入框。字型是隨 AgEnD 附帶的 Inter。手機上側欄是抽屜，下方另有分頁列。
  - **網址：** 每個聊天都有自己的網址（`/ui/chat/<name>`），每個 Fleet 分頁也是（`/ui/fleet/teams`）。在裡面切換不會重新載入頁面，上一頁／下一頁可以用；舊的 `/ui#instance=<name>` 連結仍會開到正確的聊天，登入後也一樣。
  - **操作更清楚：**
    - 輸入框裡的按鈕現在叫 **中止回覆**，只在 agent 工作時出現。
    - instance 本身的操作移到標題列的 **⋯** 選單，而且只列出適用的：已停止時是啟動；執行中時是重新啟動和停止 instance；刪除放在最後。
  - **小修正：**
    - 很長的 instance 名稱不會再被「等你回應」標記擠掉，標記改到第二行。
    - 手機上的程式碼會自動換行。
    - 兩種主題的文字顏色都符合 WCAG AA。
  - `/view` 和 `/settings` 會在接下來的步驟併入同一個 app。
  - 以 Preact 和 htm 製作，直接包含在 AgEnD 裡（固定版本並驗證 checksum，附授權條款）。不從其他網站載入任何東西，頁面的安全政策不變。
- **網頁 app 最後的收尾（#1408 第 5 步）。**
  - 所有「確定嗎？」都改用 app 自己的對話框，按鈕會寫明要做什麼：帶著未套用的變更離開設定、變更存取、重新啟動 AgEnD、刪除 agent、排程或 team、移除連線、改綁連線，以及允許 HTML 預覽。伺服器無法儲存的登出，改在登入頁說明，不再跳出瀏覽器警告框。
  - 登入頁採用 app 的外觀，有淺色與深色。
  - 設定裡的連線在桌面上一行就能放下；手機上細節會放在下一行。
  - 開發者 → 套用並儲存，只會寫入你在 `fleet.yaml` 中改過的部分。
  - 在手機上，導覽會指向 ☰ 來說明 instance 清單。
  - 舊的共用頁面腳本與樣式表（`/assets/shell.js`、`/assets/shell.css`）已移除：每個頁面都是 app 或登入頁。
- **`/settings` 現在是 app 的一部分（#1408，第 3 步）。**
  - 設定和聊天共用同一個側欄、外觀與主題；在兩者之間切換不再重新載入頁面。
  - Agent、連線、ClassicBot、一般和開發者是分頁，各有自己的網址（`/settings/<section>`）。每個 agent 和連線的設定會在對話框中開啟（手機上是底部面板），**新增 agent** 就是側欄的新增 instance。
  - 變更和以前一樣先暫存再一起套用。按下 **套用變更** 後，即使離開設定也會繼續，進度會在任何面板顯示。帶著暫存變更離開設定時會先詢問。
  - 需要 fleet 管理員確認的變更（#1423）會在任何面板顯示一張卡片，列出變更內容、剩餘時間和 **撤回**。需要確認的新增 instance、刪除或 Fleet 設定儲存也一樣。
  - 尚未得知的 agent 模型現在顯示「default (detected when it starts)」，取代「default (not probed yet)」。
- **`/view` 現在是 app 的一部分（#1408 第二步）。**
  - 和 `/ui` 共用側欄、外觀與主題；在聊天和檢視之間切換不再重新載入頁面。
  - 每個 agent 的終端畫面都有自己的網址 `/view/<name>`。
  - 名單移到側欄（手機上在抽屜裡），保留分組、篩選和拖曳排序。標題列有 **字級**、**用量** 和 **說明**，個人資料改在對話框裡編輯。
  - 未登入時（`web.view_access: open`），`/view` 只顯示檢視和 **登入**，不會讀取任何需要登入的內容。
- **instance 等待人工輸入時的提示按鈕，現在直接寫出會做什麼（#1414）。** instance 在終端機等待輸入（權限、密碼、對話框）時，General 的提示原本是「確認」／「取消」，現在改成「請 General 協助」（和以前一樣，請 General 去看它的終端機）與「我自己處理」（交給你自己處理）。提問和結果訊息也一併對齊。文字是共用的，Telegram、Discord 和網頁聊天會一起改變。
- **`agend update` 會先確認新版本能在這台電腦上執行，才動手更新（#1441）。** 它會用之後實際負責安裝的那個 npm 讀取新版本自己的 Node 需求，並判斷新版本實際會用哪個 Node：新版本有為這台電腦附帶 AgEnD 的 Node 時就用它，否則用 PATH 上的 `node`；如果更新是透過 nvm 安裝，則用 nvm 實際選到的那個 Node 22。如果那個 Node 不符合，更新會停下來並顯示「AgEnD 沒有被變更」，說明新版本需要哪個 Node、為什麼用不了附帶的 Node（例如 musl Linux），並請你安裝符合該範圍的 Node。它不會動到系統的 Node。走 nvm 時，這項檢查會在 nvm 選好 Node 之後進行，但仍在 npm 安裝任何東西之前。從聊天室下的 `/update` 也會回報同樣的原因。如果讀不到需求，或需求用了這項檢查看不懂的範圍寫法，更新照舊進行，新版本自己的安裝檢查仍會把關。
- **`agend` 與 `agend-agent` 改由 launcher 啟動，由它決定 AgEnD 用哪個 Node 執行（#1450）。** 這兩個指令是很小的 POSIX `sh` 腳本，所以 PATH 上沒有 `node`（例如沒載入 nvm 的 shell）也能啟動。當版本為此平台釘選了 AgEnD 自帶的 Node（Linux glibc ≥ 2.28 x64/arm64、macOS 11 以上 x64/arm64），安裝時會驗證這個 Node（確切版本、N-API 10、在主執行緒與 worker 各開一次資料庫）並留下紀錄；之後 AgEnD 一律用它執行，不受 PATH 上的 Node 影響。系統的 Node、PATH 與 npm 都維持原樣。
  - 有自帶 Node 的平台上，系統 Node 的版本永遠不會擋下安裝或更新：Node 20、18、16，只要它的 npm 能跑安裝都可以，AgEnD 不會用它執行。只有兩種情況會拒絕安裝，此時 npm 會保留你原本的版本：
    - 此平台沒有自帶 Node（musl Linux、32 位元、其他作業系統、glibc 低於 2.28、macOS 11 以前），而系統 Node 又低於 AgEnD 的需求（`^22.14.0 || ^23.6.0 || >=24`），裝了也無法啟動；
    - 安裝過程中自帶 Node 沒通過驗證。
    npm 8 與 9（Node 16 附的是 npm 8）還會替 better-sqlite3 跑 `node-gyp`（已有預建檔時什麼也不編），所以需要 node-gyp 的條件：Python 3（3.11 以下，或裝了 setuptools）與 `make`（macOS 為 Command Line Tools）。缺少時 npm 會中止安裝並保留原本的版本。npm 10 以上不跑這一步；npm 10 需要 Node 18.17 以上。
  - 自帶的 Node 缺少、不完整，或驗證後被更動，會直接拒絕並印出修復指令；絕不默默改用別的 Node。
  - 安裝時跳過了自帶 Node（`--omit=optional`、`--ignore-scripts`）時，若系統 Node 符合需求就用它，並明確提示。
  - 可用 `AGEND_NODE=/絕對路徑/node` 指定；該 Node 必須符合需求，否則拒絕執行，不會退回其他 Node。
  - AgEnD 自己啟動的程式都用它正在執行的 Node 與它自己的 CLI 檔案，不再從 PATH 找 `node` 或 `agend`：各 CLI 啟動的 MCP server、沒有 service 時的 `agend start` 與 `agend restart`、quickstart 的重新載入、`/doctor`，以及 Antigravity 的狀態列。kiro、grok、muse 產生的 wrapper 中，路徑與參數都加上引號，含空白、`$` 或反引號的路徑會照原樣使用。
  - 不支援原生 Windows：請在 WSL 內執行 AgEnD。
- **服務會寫明 AgEnD 自己的 Node，而 `agend restart` 會拒絕無法證明的服務（#1450）。**
  - systemd unit 與 launchd plist 現在啟動的是 `<AgEnD 的 Node> <套件>/dist/cli.js fleet start`，不再交給 `#!/usr/bin/env node` 和服務的 PATH 決定 Node。
  - 沒有自帶 Node 的平台，服務改為啟動 AgEnD 的 launcher，每次啟動時從服務的 PATH 找 Node，所以用 nvm 或 Homebrew 升級 Node 不會讓服務壞掉。
  - `agend restart` 在停止任何東西之前，會確認 systemd 或 launchd 已載入的定義正好是這樣，且沒有待重新載入的變更；否則拒絕，什麼都不停止。舊的服務請執行 `agend install` 重寫。`--force` 是給管理者用的。
  - macOS：`agend install --no-activate` 不再把新的 plist 留給 launchd 在不確定的時間點載入。它會驗證 plist 並記錄一次預定的啟用，由下一次 `agend restart` 只做一次 `bootout`/`bootstrap`；新的 job 沒有跑起來就回復到先前的 job。AgEnD 使用的 launchd domain（`gui/<uid>`）及原因，請見 `docs/cli.zh-TW.md`。
  - macOS：`agend install` 與更新會等 launchd 把先前的 job 完全卸載後才載入新的 job。launchd 在 `bootout` 完成前就先返回，立刻載入曾因此失敗（錯誤 5）。
- **`agend update` 執行期間獨佔 npm prefix，並用新版本實際會使用的 Node 驗證新版本（#1450）。**
  - npm 執行前，更新會在已安裝的套件旁建立鎖（`<npm prefix>/.agend-install.lock`）。同一個 prefix 上若有第二個 `agend update`（不論來自哪個 fleet）會直接拒絕，不會互相衝突。已中斷的更新留下的鎖會被回收。
  - 鎖存在期間只有該次更新自己的 npm 子程序可以安裝：套件的安裝腳本會拒絕其他安裝到該 prefix 的動作，npm 會把它還原。請一次只執行一個安裝。
  - 自帶 Node 的版本，會用它自己的 Node 驗證：更新會詢問已安裝的版本選了哪個 Node，再用那個 Node 在主執行緒與 worker 各開一次資料庫；執行更新的 Node 不算數。
  - 聊天室的 `/update` 會執行 npm 安裝的那個 `agend`：透過 npm 找到並確認是該套件後，以完整路徑執行。無法確認時，`/update` 會拒絕並提示改從 shell 執行 `agend update`；絕不會改用 PATH 上第一個找到的 `agend`。
- **文件更新：** `docs/features.md` 新增「需要你處理」收件匣（#1386/#1398）和全新網頁應用程式外殼（#1408 步驟 1）的章節。`docs/commands.md` 中 `kiro-cli` `/steer` 支援的說明已正確反映 #1432。README 中的 Node.js 版本需求已反映 #1420（`^22.14.0 || ^23.6.0 || >=24`）。
- **Codex session resume 文件：`$CODEX_HOME` 優先於 `~/.codex`。** `docs/features.zh-TW.md` 中兩處提到 `~/.codex/state_5.sqlite` 和共用 home 的地方，現在改為 `$CODEX_HOME/state_5.sqlite`（預設值：`~/.codex`）和 `$CODEX_HOME`（預設值：`~/.codex`）。程式碼（`src/backend/codex.ts:904`）一直都是用 `process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")`；文件現在與程式碼一致。
- **測試：`ENGINES` 常數必須在 `package.json`、`scripts/preinstall-guard.cjs` 和 `src/node-version-guard.ts` 之間保持同步。** 新測試以 `package.json` 的 engines.node 為唯一真實來源，並斷言：(a) `preinstall-guard.cjs` 的 `ENGINES` 字串與其完全相同，(b) `isNodeCompatible()` 對每個選擇項的最低版本都回傳 true。任何一處有變動而其他處未更新時，測試就會變紅。(#1490 P3)
- **Telegram forum 根層指令固定所屬 bot：** 不帶後綴的指令使用 primary
  連線在該群的 General；primary 沒有同群 General 時，依配置順序選第一個。
  不論 sibling 的接收順序，都使用目標 bot 的管理員名單；目標停止或無法判定
  時不會轉交其他 bot。對特定 bot 下指令請用 `/restart@ThatBot full`、
  `/update@ThatBot` 或該 bot 自己的 General topic。普通訊息與既有 Classic
  指令沿用原路由。 (#1490)
- **開啟臨時公開連結時會逐步顯示進度（#1512）。**
  - 你按的 `/dashboard` 選單會逐步顯示啟動過程，每個階段都附經過秒數：
    1. 檢查 cloudflared；
    2. 下載（已下載 / 總共 MB）；
    3. 驗證檔案（固定版本與 SHA256）；
    4. 啟動 tunnel；
    5. 等待公開網址可以連上；
    6. 私送連結給你。
  - 只有需要下載 AgEnD 自己的 cloudflared 時才會出現第 1–3 步；第一次之後只會看到第 4–6 步。
  - 失敗的那一步會標出原因，例如「檔案與固定的 SHA256 不符」或「還有另一個 tunnel 在執行」。再執行一次 `/dashboard` 即可重試。
  - 選單最多每 2 秒更新一次（Telegram 為 3 秒，會直接編輯 General 裡的選單訊息），且絕不顯示連結或登入碼。
- **網頁 app：每一頁的側欄都是同一份 instance 清單（#1526）。** 聊天、檢視、Fleet、設定與「需要你」現在顯示同一份清單：即時狀態點、檢視原有的標籤分組、收合與拖曳排序，以及在搜尋框旁新增的「狀態」與「CLI」篩選。篩選條件在每一頁都相同，並由這個瀏覽器記住。點一列會開啟你目前所在的視圖（在檢視頁開檢視，其他頁開聊天），切換頁面時清單也不再跳動。在檢視頁替 instance 個人資料設定的別名或說明，現在各處都會顯示，聊天標題也一樣。
- **CLI：persona bot 邀請改用與設定相同的權限組（#1533）。** 新增 bot 實際需要的「管理頻道」、「附加檔案」與「使用外部表情符號」，移除 bot 用不到的「管理訊息」與「使用應用程式命令」（斜線命令由邀請的 applications.commands 範圍授權）。
- **AgEnD 各處都用同一種方式讀取 `~/.agend/.env`（#1545）。** 啟動時、新連線不重啟直接啟動時，以及替新 token 取變數名稱時，都套用相同規則：`export KEY=value` 的寫法、加引號的值、重複的鍵以最後一個為準。因此同一個 token 不會在啟動時和之後讀成不同的值。
- **CLI：設定完成後指向網頁儀表板（#1550）。** `agend quickstart`、`agend setup` 和 `agend init` 結束時會顯示儀表板的網址（`http://localhost:19280/`，或 fleet 設定的 `health_port`），並說明登入方式：執行 `agend web --code`，或傳 `/dashboard` 給你的 bot。quickstart 的步驟改為 1/4 到 4/4。`agend init` 安裝系統服務時現在會一併啟動它；以前它建議的 `systemctl` 服務名稱並不存在。「安裝 Discord plugin」那一行也拿掉了，因為 Discord 已經內建。`npm install` 成功時，最後一行會是「Next: run `agend quickstart`」。README 和網站的快速開始頁面也更正了 Node 版本需求，並加上儀表板的說明。
- **公開連結的 cloudflared 下載在慢速網路上也能完成（#1554）。**
  - 不再固定 5 分鐘就失敗。只有連續 60 秒沒有收到資料才算失敗，整體上限 30 分鐘，所以慢但持續在動的下載會完成。
  - **Linux 現在先從 Cloudflare 自己的套件庫下載**（pkg.cloudflare.com）；套件不存在、停滯、太慢或不符時，再改用 GitHub release。套件的大小也只有一半。
  - 兩種來源都比對同一個固定的 SHA256。套件裡的執行檔由 AgEnD 自行解出，不會安裝任何其他東西。
  - macOS 仍從 GitHub 下載，因為 Cloudflare 沒有提供 macOS 套件。
  - 在 `/dashboard` 上，第 ② 步會標出何時改用 GitHub 以及原因。
- **網頁聊天：圖片直接在頁面裡放大檢視（#1558）。** 以前點聊天裡的圖片會開新的瀏覽器分頁。現在會在聊天上方以深色背景顯示，並縮放到符合畫面。要關閉，按 ✕、點深色區域，或按 Esc。一則訊息有多張圖片時，可以用箭頭或 ← → 鍵切換。**開啟原圖** 仍會在新分頁開啟圖片；按住 Ctrl 點擊或用滑鼠中鍵點擊圖片，也和以前一樣會開新分頁。
- **網頁聊天：HTML 預覽的提醒可以先關掉，直到下次登入（#1568）。** 執行中預覽上方的提醒多了 **我知道了** 按鈕。按下後，這次登入的所有分頁、所有預覽都不再顯示這則提醒；下次登入會再出現。沒有登入工作階段時，只在那個分頁裡隱藏。每個預覽外圍的黃色框線一律保留。預覽仍然預設關閉、要你允許，而且每次都要你按下才會執行。
- **網頁：開著的 dashboard 分頁會安靜地等艦隊重新啟動完（#1580）。** 以前 AgEnD 重新啟動時，每個開著的分頁會同時約每 3 秒重連、每 5 秒輪詢，而且永不停止、隱藏時也照樣——透過 WSL2 的轉送或 tunnel，每個分頁每分鐘就是幾十條連線。現在分頁每次重試會等得更久（約 1、2、4、8、16 秒，之後 30 秒），分頁隱藏時暫停，最多只保留一條連線，關閉分頁時也會一併關掉。頁面會顯示「連不上 AgEnD——可能正在重新啟動」以及下次重試的時間。AgEnD 回來後，期間說過的訊息會出現，而且只出現一次——以前分頁可能會漏掉這些訊息。
- **網頁用量面板（◔）現在會立刻打開（#1585）。** 上一份快照過期時，面板會先直接顯示它，並標示「N 分鐘前更新 · 更新中…」，同時在背景跑這次過期本來就會觸發的那一次更新，幾秒後由新數字取代。以前面板要等所有供應商回應，常常要好幾秒。呼叫供應商的頻率和以前完全一樣。聊天的 `/usage` 指令、`get_usage` 工具和 Discord 狀態仍然會等新的數字。超過 60 分鐘的快照不會這樣顯示。不論快照是否過期，都只會在它當初抓取時的那份艦隊設定下顯示：憑證 profile 或綁定一旦變更，下一次讀取會等它自己的那次抓取，而這次抓取會排在已經在跑的抓取之後，不會同時進行。如果讀不到設定檔的中繼資料，就不顯示任何快取內容；在快取期間內，這種讀取會直接失敗，不會再去呼叫供應商。`/api/ai-usage` 回應會帶 `Cache-Control: no-store`。
- **手機上更容易複製登入碼，連結期限改用你的時區（#1586）。** `/dashboard`（或 `/web`）的登入訊息之後，以及登入頁「傳一組新的登入碼給我」的訊息之後，bot 會再把登入碼單獨傳一則：Telegram 點一下即可複製，Discord 長按 → 複製文字。第一則訊息仍然含有登入碼，所以多傳的那則失敗也不影響。公開連結的期限與選單的狀態列，現在會以 fleet 的時區（`TZ`，否則用系統時區）顯示成 `2026-10-11 01:30 (UTC+8)` 這種格式，不再是 UTC 時間戳。
- **網頁：側欄底部變短，也不再顯示「每 5 秒重新整理」（#1603、#1604）。** 側欄底部從五列變成一列——**設定**與**登入狀態**。這個瀏覽器自己的選擇（主題、語言、允許預覽 HTML、重看導覽）移到 **設定 → 這台裝置**；未登入看 `/view` 時，主題與語言在**登入**旁的 ☀ 按鈕。「即時更新暫停中——每 5 秒重新整理」不再出現：輪詢本來就是正常的更新方式（公開連結一律輪詢），所以不再當成問題顯示。真的連不上 AgEnD 時，仍會顯示「連不上 AgEnD——可能正在重新啟動」。
- **Discord 上單獨重傳登入碼的那則訊息改用行內程式碼（#1606）。** 單獨重傳登入碼的訊息（#1586）在 Discord 上現在顯示為 `` `ABCD-EFGH` ``，手機點一下就能複製，和 Telegram 一樣。那則訊息仍然只有登入碼。
- **關閉公開連結要按兩下（#1610）。** 在手機上，「關閉公開連結」按鈕就在要點一下複製的登入碼正上方，誤觸就會把正要用來登入的連結關掉。現在第一下只會把同一則訊息上的按鈕換成「確定關閉（公開連結的登入都會登出）」／「取消」，訊息內容不變；只有按確定才會關閉，按取消會恢復原本的按鈕。擁有者檢查不變。`/dashboard revoke` 與 `/web revoke` 仍然立即生效。
- **網頁：General 可以顯示自己的 Bot，上傳的圖片也能移除（#1630 後續）。**
  - 主要 Bot 只有一個 instance 在用時（例如 fleet 只把主要 Bot 留給 General），會算是那個 instance 自己的 Bot，顯示 Bot 的頭像和 Discord 顏色外框。多個 instance 或聊天室共用的主要 Bot，照樣顯示但沒有外框。
  - View 的**編輯個人資料**在已上傳圖片時有**移除圖片**。儲存後刪除圖片，改回 Bot 的頭像、persona emoji 或名稱第一個字。
  - 路由是 `DELETE /api/avatar/<instance>`，和上傳一樣需要登入。
- **設定：狀態表情圖片改由 dashboard 自己提供（#1630）。** 狀態表情編輯器的伺服器表情清單與預覽，以前會在瀏覽器中從 Discord 的 CDN 載入，dashboard 的內容政策也因此允許 `cdn.discordapp.com/emojis/`。現在改用 dashboard 自己快取的路徑（與網頁聊天相同），內容政策不再允許任何遠端圖片：開著編輯器時，Discord 不會看到你的位址。不在 fleet bot 所在伺服器的表情會以 `:名稱:` 顯示。agent 的 `list_emojis` 圖片連結不變。
- **網頁登入指引改為建議使用 `/web`（#1655）。** 升級與首次設定訊息也使用 `/web`，包含 `/web revoke`。`/dashboard` 仍是別名，權限與選項相同；指令文件列出兩個名稱。
- **Agent：在 Telegram 上，`format: markdown` 現在就是 markdown；原始 HTML 標籤會以文字顯示（#1658）。** 以 `format: "markdown"` 呼叫 `reply` 時，文字會未經轉換就當作 HTML 送到 Telegram，因此含有 `<` 或 `&` 的文字（`a<b`、`x && y`）會被拒絕、回覆失敗，`**粗體**` 也會原樣顯示。現在會先全部跳脫再從 markdown 轉換：`<`、`&`、`>` 照原樣顯示，**粗體**、*斜體*、~~刪除線~~、`code` 與 http(s) 連結會套用格式。「markdown」模式下的 HTML 標籤從未列入文件，現在會以文字顯示。若 Telegram 仍拒絕該格式，會改以純文字再送一次。含有表格、程式碼區塊或標題的回覆，仍照舊以 Telegram rich message 送出。
- **網頁儀表板預設兩天內都不用重新登入（#1670）。** 直接連到 dashboard（本機、區網、tailnet）登入後，現在可維持 48 小時、閒置 48 小時才會登出，原本是 12 小時／閒置 2 小時。公開連結的 session 仍是 4 小時／閒置 30 分鐘。在 `web.session.local.*` 或 **設定 → 網頁** 自己設定的值仍然優先，範圍仍是 1 到 720 小時。更新前就已登入的 session 仍在登入時給定的期限到期（舊預設是 12 小時，自己設定過的則依當時設定），已經閒置逾時的也不會復活；只有在原本的閒置期限之前有實際操作，閒置時間才會依新的設定延長，而且不會超過原本記錄的期限。只設定較短的 session 時長（例如 `absolute_hours: 24`）仍然有效，閒置時間會跟著它；只有在沒設定 session 時長的情況下把閒置時間設超過 48 小時才會被拒絕。
- **寬螢幕上，AI 用量又回到右側的面板（#1673）。** 在 Chat、View、詳細資訊與 Fleet，1200 px 以上的螢幕會把 AI 訂閱用量顯示在頁面旁的面板，切換頁面時仍保持開啟，如同舊版 `/view`。標題列的 **用量**（或面板的 ✕）可隱藏或顯示它，這台裝置會記住選擇。較窄的螢幕（例如手機）仍使用 **用量** 對話框。面板的內容與更新方式和對話框相同，隱藏時不會讀取，`web.usage_panel` 為 `false` 時不會出現。
- **網頁：可收合的篩選群組（#1700）。** 側欄篩選中的**狀態**和 **CLI** 群組各有一個附箭頭的標題列，點標題列任一處即可展開或收合該群組的勾選框。群組收合時若有勾選項目，標題會顯示目前的選擇，例如「狀態 · idle」或「狀態 · 已選 3 個」。各群組展開與否只記在這台裝置上，不會同步。兩個群組預設為收合。
- **網頁：「在面板中開啟」一次點擊就會執行 HTML 預覽（#1704）。** 在 HTML 卡片上按**在面板中開啟**，現在會開啟面板並直接在面板中開始預覽，不必再按一次**預覽**。如果這台裝置還沒允許預覽，面板會顯示**允許預覽**，允許之後就會立刻開始預覽。無法執行預覽的地方（`web.preview: false` 或公開連結）面板開啟後一樣不會執行任何東西。之後回覆中的較新版本仍然只會提示，頁面載入時也不會自行執行任何預覽。
- 主機記憶體壓力不再發聊天廣播，恢復時也不發；所有平台仍保留啟動放慢／暫停、log、health 與 Fleet 儀表板指標。使用者的操作被延後時，該次操作的回覆會說明原因。
- **網頁：側欄可以拉寬、同時顯示兩個名稱，CLI 標在頭像上（#1722）。**
  - **調整寬度：** 拖曳側欄右緣即可調整寬度（200–480 px），也可以在右緣用方向鍵、Home、End 調整，按兩下或 Enter 恢復預設。寬度只記在這台裝置上；手機仍維持抽屜式側欄。
  - **兩個名稱：** 每一列會顯示暱稱，下方以較小字體顯示實際的 instance 名稱；兩者相同時只顯示一行。在「設定 → **名稱**」可選擇哪一個優先顯示。這是會同步的偏好設定，也套用到聊天標題與「等你處理」。
  - **CLI 標示：** agent 使用的 CLI 改為頭像左上角的一個字母（C Claude Code、X Codex、K Kiro、G Grok、A Antigravity、O OpenCode、M Muse），不再是彩色圓點，螢幕閱讀器也會唸出 CLI 名稱。
  - **☆：** 改放在原本彩色圓點的位置，不會再蓋住名稱。狀態點維持原位。
- **網頁：「Fleet → 排程」更易讀，排程也能編輯了（#1724）。**
  - **每一列：** 顯示標籤（或訊息開頭），接著用文字寫出何時執行（「每週一到五 18:00」、「每 15 分鐘」、「一次 · 2026-10-13 14:00 (UTC+8)」），以及依 fleet 時區顯示的下次執行時間和目標的顯示名稱；原始 cron 改放在提示文字中。
  - **一次性排程：** 會顯示執行時間，先前這個位置是空白的。
  - **已停用的排程：** 一看就知道已停用。
  - **編輯：** 新增的「**編輯**」按鈕會開啟已填好內容的排程表單，可切換「**重複 / 一次**」，儲存時與 `update_schedule` 工具使用相同的驗證。
  - **新增：** 「**新增排程**」現在也能建立一次性排程，從網頁建立排程也恢復正常。
- **Telegram `/web`：不用離開 bot 的私訊就能完成登入（#1742）。**
  - fleet 管理員透過「先開私訊 →」連結（`/start web`）打開 bot 的私訊後，會直接在私訊裡看到 /web 選單。選擇區網或公開連結後，登入碼就送到同一個私訊，不必再回 General。這個選單屬於同一個 General，管理員檢查與在 General 用 `/web` 時相同，按鈕也只對那位管理員、在那個私訊裡有效。
  - `/web` 無法私送時，訊息會一步一步說明：① 開啟私訊（知道 bot 名稱時附按鈕）② 按「開始」③ 在那裡選擇連結。訊息不再叫你傳單獨的 `/start`，那會另外啟動一個 ClassicBot agent。不知道 bot 名稱時，會請你傳送 `/start web`。
  - 收到那則訊息後 10 分鐘內，你在 bot 私訊裡傳的下一個單獨 `/start`（Telegram 的「開始」按鈕）會被當成 `/start web`，只限一次。其他 `/start` 照舊。
  - 訊息上的按鈕無法更新時，結果會改用新訊息貼出，並附上「先開私訊 →」按鈕，不再缺少按鈕。
  - Discord 不變。
- **切換 Claude Code agent 的 credential profile 時會保留原本的對話（#1753）。** 以前切換會開新對話，只給新 session 一段簡短的交接。現在 AgEnD 會在 agent 重啟期間，把這個 session 的對話紀錄、它的資料夾和檔案歷史複製到新 profile，agent 在那裡接續原本的對話。
  - 舊 profile 保留自己的那一份，所以切回去會回到同一段對話。
  - 切換後的第一次回覆會在快取為空的狀態下重讀整段對話，所以會比較慢，並以完整價格計費。
  - 這適用於 `update_instance_config` 和 ClassicBot 頻道。
  - 無法複製時，切換會像以前一樣開新對話並附上交接，回覆的 `carry_failed` 會說明原因。可能的原因有：還沒有 session、新 profile 已有這段對話的另一個版本、磁碟空間不足，或複製失敗。
  - Kiro 仍會開新對話；Codex 本來就不會失去對話。
- **Skill：credential-profiles 已更新，涵蓋 Claude Code profile 用量列（#1753）。** 過時的「Claude Code profile 尚未有獨立用量列」說明已改為正確行為：每個具名的 Claude Code profile 現在都有自己的 `Claude (<profile>)` 列，從該 profile 自己的登入讀取配額；從未登入的 profile 顯示「Not logged in — run `/login claude-code <profile>` to sign in」。「已登出」提醒列現在明確說明僅適用於 Kiro。
- **側欄的 instance 數量改放在篩選標題那一列（#1776）。**
  - 數量（例如 `71 / 71`）以前在「狀態」和「CLI」標題下方獨佔一列，現在放在那一列的最右邊，篩選區少了一列。
  - 展開某個群組或設定篩選時，數量仍留在那一列；側欄很窄時，會先把標題換到下一列，數量不動。數量的內容與以前相同，有篩選時一樣會顯示「顯示中」。
- **Kiro agent 切換通知（#1794，最終行為由 #1800 取代）。** 恢復對話的自動 swap 已暫停，不會嘗試切換或重試，也不發送切換失敗的主題通知；繼續使用存檔時的 agent 與共用檔案。共用 .kiro 讀寫失敗仍需處理，也仍會顯示。
- **CI 不再灌高 `@songsid/agend` 的 npm 下載數（#1819）。** 會安裝已發布 2.1.12 的 job（Node 20 rollback smoke、data-downgrade 檢查、runtime-acceptance 的 hop、Mac GUI rehearsal）只抓一次 tarball，存在 Actions cache，每次安裝前都比對 registry 的 `dist.integrity`，不符就讓 job 失敗。如果 npm 仍然抓了我們的 tarball，安裝步驟也會失敗。
- **網頁聊天會標出是誰在發言（#1827）。** 用 `/web` 的驗證碼登入後，agent 會把你認成收到驗證碼的那個 Discord 或 Telegram 帳號：你的訊息以 `[user:<名字> via web, id:<你在那裡的使用者 id>]` 送達，不再是 `web-user`。這只用來辨認，網頁訊息不帶任何權限。
  - 名字預設是帳號的顯示名稱，也可以在 **設定 → 偏好設定 → 你的名字** 另取一個。名字會跟著你到每一台裝置，也會經過檢查，不能冒充其他平台、使用者、agent 或 bot。
  - 同樣的名字和 id 也用在 topic 同步、ClassicBot 房間紀錄、回覆按鈕和投票（每個帳號一張選票，不論在網頁或平台上投），以及任務。
  - 用 `agend web` 的驗證碼登入：和以前一樣是 `web-user`。
- **網頁：聊天導覽只在你要看時才出現（#1854）。** 第一次開啟時不再在空白頁上跳出五個步驟。**設定 → 偏好設定 → 聊天導覽**會在你上次開的 Agent 聊天上開啟；沒有可開的 Agent 時會顯示「請先選一個 Agent，再開啟聊天導覽。」。頁面上沒有的控制項，導覽會略過。導覽也不再保證網頁訊息一定會出現在 Telegram 或 Discord，是否同步由網頁轉發決定。
- **網頁：第一次進聊天頁更清爽（#1854）。**
  - 還沒選 Agent 的聊天頁只說一件事：「選一個 Agent 開始聊天。」；完全沒有 Agent 時說「先建立一個 Agent，再開始聊天。」並提供「新增 Agent」。
  - 「連接聊天 app」的卡片不再出現在聊天頁，保留在「設定 → Agent／連線」。
  - Agent 的空白聊天顯示「直接在下方輸入任務。」。
  - 輸入框下的提示只留兩個：Enter 送出、Shift+Enter 換行；「/ 叫出指令」和「Esc 中止回覆」放在它的提示框裡。
  - 從沒設定過的瀏覽器，右側用量面板預設隱藏；按「用量」即可打開，之後會記住。
- **網頁：登入頁會說明怎麼拿到登入碼（#1854）。** 以前寫「在 AgEnD bot 傳 /web」，已經傳過的人又被帶回 /web，卻沒說要在那裡按登入按鈕才會產生登入碼。現在改成「沒收到？在 General 傳 /web，再按登入按鈕取碼。」；`agend web --code` 放在收合的「沒有聊天 bot？」裡。登入碼錯誤時會說怎麼取新碼；伺服器無法確認登入時（例如公開連結的通知沒送出），不再說成是登入碼錯誤。
- 聊天 `/update` 失敗時，固定說明與修復指引會使用艦隊語言。下一步和完整日誌位置移到原始診斷前，讓既有 300 字進度紀錄保留可用的指引。更新執行、階段、日誌與重試行為不變；工具原始錯誤可能維持原文。
- **文件網站新增簡短的網頁使用說明，「文件」按鈕改開這一頁（#1854）。**
  - 新頁面（EN 與 zh-TW）：用 `/web` 和按鈕登入、用手機開啟（臨時公開連結代表什麼）、登入期限與登出、`/view` 預設公開，以及 Windows 瀏覽器連不到 WSL 裡的 AgEnD 時要確認什麼。
  - Fleet 總覽的**文件**現在開這份說明，不再開快速開始。
  - 快速開始不再把 bot token 列為必要條件：只有要從 Telegram 或 Discord 聊天才需要；沒有 bot 的 fleet 可以只用網頁儀表板。
- `/web` 先說明要按登入按鈕取得私送的登入碼，並清楚區分 AgEnD 電腦與其他裝置。移除重複頁面網址與已關閉連結的倒數；Telegram 僅在私送被拒時顯示開啟私訊的步驟。保留公開連結的風險揭露及管理員檢查。
- **更新完成訊息與 2.2 歡迎訊息變短了（#1854）。**
  - 正常的更新現在只用一行收尾：`✅ AgEnD 已更新至 v2.2.0；3/3 個 Agent 運行中（42s）。` 暫停或失敗的 Agent、被結束的背景工作和清理警告仍會列在下面。
  - General 裡只出現一次的 2.2 歡迎訊息改成兩行：新增了網頁聊天；管理員在 General 傳 `/web`，再按登入按鈕取碼。
  - 更新完成訊息不再附提示。每日提示和 `/tips` 不變。
- **網頁：Agent 的頭像預設跟它說話用的 Bot 一致（#1867）。** 沒有上傳圖片時，有自己 persona Bot 的 Agent 顯示那個 Bot 的頭像；其他的則顯示它在 Telegram／Discord 說話用的 Bot（通常是 General Bot）的頭像，沒有自己連線的也用 General Bot。Bot 沒設頭像時，仍依序改用 persona emoji、名稱第一個字。彩色外框只給有自己 Bot 的 Agent。
- **`agend doctor` 與 fleet 啟動時會顯示 fleet.yaml 的警告（#1874 後續）。** 以前驗證器的警告只出現在 `agend validate`，手動編輯 fleet.yaml 的人很少會去跑它。例如 AgEnD 會忽略的設定（像 `web.access`），或鎖定的 channel 沒有 `allowed_users`。現在 `agend doctor` 會在 **Fleet** 底下逐條列成 ⚠，fleet 啟動時也會在 `daemon.log` 以 warn 等級各記一次。沒有新增檢查。
- **Web 聊天可以傳任何類型的檔案，跟 Discord、Telegram 一樣。** 壓縮檔、Office 檔、程式、HTML、SVG 等等現在都能附加，限制不變（5 個檔案、每個 10 MB、合計 25 MB）。agent 會在 inbox 收到，跟其他文件一樣。在聊天裡這些檔案一律只能下載（`application/octet-stream`、attachment），絕不會在頁面上顯示或執行。圖片、PDF 與文字檔照舊。(#1900)
- **在網頁儀表板切換聊天會立即顯示（#1908）。** 聊天開啟時先畫出最新的訊息，較舊的訊息隨後補上，不會移動你正在看的位置。回到歷史很長的聊天，現在約 40–50 毫秒就會顯示，原本約要四分之一秒。
- **網頁聊天中，回覆按鈕的點選會顯示為它的標籤（#1919）。** 有人點選按鈕時，他的對話泡泡現在顯示「🔘 <標籤>」，而不是 agent 收到的那一行（`[button] … (value: …)`），也永遠不會顯示 value。即時的情況下，點這個標籤會顯示按鈕所在的訊息。重新載入後仍會保留，在 Discord 或 Telegram 上的點選也以同樣方式顯示。agent 收到的內容不變。
- **網頁聊天可以傳更大的檔案，上限也可以自己設定（#1937）。**
  - **預設：** 每個檔案 50 MB、每則訊息 100 MB（原本是 10 MB 和 25 MB），仍最多 5 個檔案。
  - **設定：** 用 `web.upload_max_file_mb` 和 `web.upload_max_total_mb` 改這兩個大小（整數 MB，1–500）。`agend reload` 後，下一次上傳就套用。
  - **公開連結：** 單一檔案最多 95 MB，這是 Cloudflare 臨時通道單一請求能傳的上限。
  - **記憶體：** 上傳改為邊收邊寫入磁碟，不再整個放在記憶體裡，大檔案下載也一樣。上傳停滯一分鐘或超過 30 分鐘就會中止，並刪掉已收到的部分。

### 修正 (Fixed)
- **安裝途中時鐘被調整時，`/update` 失敗的機會大幅降低。** 只讓正在進行的更新自己的 npm 安裝通過的檢查，原本用掛鐘時間的文字比對更新程序的啟動時間；npm 執行期間只要時鐘被調整（NTP、VM 或 WSL 重新對時），更新程序就可能被當成已經結束而拒絕安裝，聊天裡只看到「npm error code 1」，重試通常就會成功。現在 Linux 上由這個版本寫下的鎖，會用核心記錄的程序啟動時間加上這次開機的識別來認更新程序，時鐘怎麼調都不受影響；macOS、以及較早 2.2 beta 的更新程序寫下的鎖（升級到這個版本的第一次），可容許 2 秒以內的時鐘調整，調整更多時仍可能被拒絕，重試即可。程序檢查在忙碌的主機上也有更多時間。安裝被拒絕時，聊天現在會顯示 AgEnD 自己的原因（「AgEnD cannot be installed here: …」），不再只有 npm 的結束代碼；更新程序本身是這個版本或更新版本的升級才會顯示。(#1947)
- **`update_instance_config` 現在明確拒絕 `tool_set`（權限邊界 #804/#814）。** 在 config patch 中傳入 `tool_set` 會立即回傳明確的錯誤訊息——`"tool_set can only be changed by an administrator via Settings or fleet.yaml (privilege boundary, #804/#814)"`——且不會寫入任何內容。先前此欄位會被靜默忽略。如需將 instance 標記為 coordinator：在 `fleet.yaml` 中加入 `tool_set: coordinator`，或使用網頁 UI 的 **Settings** 面板。
- Kiro 原生 TUI 的 trust-all-tools 確認畫面改為 startup/runtime 共用結構式 selector（#849，A 部分）。AgEnD 從「No, exit」只送一次 Down，重新觀察游標確實位於單次 session 的「Yes, I accept」後才送 Enter。未知布局、游標未移動與「Yes, and don't ask again」保留給人處理；歷史引用不會收到同意按鍵。既有 model-picker hold 與 engine/session 身分鎖定不變。本次不開放 `kiro_ui: v3`；v3 startup/enablement 與後續 steering 驗證等有原生證據及使用者需求再議。

- 每個 consent phase 的單次 claim 跨 startup／runtime 保留，包含按鍵 ACK 不明的情況；stop 與 tmux replacement 會淘汰舊 runtime 按鍵。原生 column-zero TUI composer 會排除被複製的 trust 畫面。
- **Kiro 對話歸屬（#906、#1410；隔離受 #1800 限制）。** 鎖定啟動模式會依 ID 恢復 instance 已認領的對話；新對話使用自己的 agent、指示與 AgEnD MCP server。恢復對話的自動 agent swap 已暫停，仍保留存檔時的 agent 與共用 .kiro 項目，因此共用目錄的恢復中 instance 並非完全隔離。使用者自己的 MCP server 照常載入；缺少 per-instance agent 支援的舊版 CLI 仍使用共用 MCP／steering 設定；不支援的 UI／engine 組合仍拒絕啟動。
- **資料遺失修正：在 Settings 儲存連線，不再毀掉 fleet.yaml 裡舊式 `channel:` 的連線設定（#1056）。**
  - 使用舊的單一 `channel:` 鍵時，在 Settings 儲存連線的狀態 emoji（或存取設定）會刪掉 `channel:` 區塊，只寫出一個只有改動欄位的 `channels[0]`，下次啟動時設定會被拒絕（「type / bot_token_env 必填」）。
  - 現在會把完整的連線寫成 `channels[0]`。在 2.1.x 上，升級前請先把 `channel:` 改寫成 `channels:` 清單（或不要用 Settings 儲存連線）；已經壞掉的檔案需從備份還原或手動重寫。
- **設定存檔不會再寫出無法載入的 fleet.yaml（#1056）。**
  - 每次存檔都會先載入並驗證即將寫入的檔案；會無法載入、或會新增設定錯誤的結果不會寫入，存檔會說明原因（Settings 會顯示錯誤並保留原本的值）。
- **連線的狀態 emoji 不需重啟即可生效（#1056）。**
  - 修改 `channels[].options.status_emojis` 會在 bot 下一次蓋戳記時生效（與 agent 自己的 `status_emojis` 相同），Settings 也標示為「立即生效」。連線的其他設定仍需重啟 AgEnD。
- **`list_emojis` 會自我說明（#1056）。**
  - 新增 `platform_note`，例如說明 Telegram 沒有伺服器 emoji、`standard.reactions` 就是完整清單。
  - 每個狀態附 `kind`，說明 `progress_prefix` 是訊息文字而不是反應；Settings 與 `set_persona_emoji` 也有同樣說明。
- Fleet 重啟給逐批 busy Kiro 停機五分鐘，取代 detached 10 秒與 systemd 60 秒上限（#1071）。Restart 會遷移舊 unit 預設並核對已載入值；自訂期限／drop-in 保留並提示，但 `agend restart` 拒絕所有讀不到或小於 300 秒的已載入期限。Detached 等待改為非同步、monotonic，送訊號前重驗行程 identity，確認退出後才啟動 replacement。讀不到或仍活著的 owner 會拒絕 replacement。這仍是有限外部期限，不保證任意大小 fleet 或卡住的 transport；launchd 政策不變。
- **過期的命令確認（#1148／#754）：**`/clear` 在平台訊息更新等待後、破壞性指令送出前，重驗當下授權、來源／target 與確切 daemon／IPC、cached launch 與 lifecycle generation。Model／effort 選單亦拒絕同一 bot 內已搬移到另一 target 的來源 channel、已變更的 Telegram group，或有歧義的 topic 對應。F／C 角色不變；clear 維持不提供 web prompt。
- **在 Telegram 的 instance topic 下只能在 General 使用的指令，現在會直接說明，不再送到 agent（#1148）。** 論壇群組的指令選單在每個 topic 都一樣，所以 `/status`、`/sysinfo`、`/dashboard`、`/restart`、`/update`、`/profile`、`/doctor`、`/login`、`/usage`、`/visibility` 在 instance topic 也看得到。以前在那裡選了，會被當成一般文字交給 agent：沒有任何動作，也沒有說明。現在會回覆「要在 General topic 使用，請到那裡執行」；在 General 照常運作。
- **Telegram General bot 定址（#1148／#754）：**forum 根層的明列命令 suffix 在 shared dedup 前驗證，即使沒有 message ID 也一樣。錯誤或不明的 receiving username 不會消費 intended bot 的訊息或執行其 General 命令。Bare 命令、Classic／有-thread 行為與精確別名形式不變。
- **AgEnD 不再一次讀完很大的對話紀錄（#1218）。**
  - 以前 agent 在兩次讀取之間寫了很多內容時（長指令的輸出、數 MB 的工具結果、追趕中的 300 MB codex session），AgEnD 會在主迴圈上一次把整段差異讀進記憶體。
  - 現在 claude-code、codex、kiro 與 muse 的 session 檔每次最多讀 1 MiB，每輪讀幾次。
  - 超過 256 KiB 的單行，如果是回合紀錄或回覆，仍會在 16 MiB 以內整行讀取：最終回覆很長的 codex 回合結束、貼上的長提示、很長的 claude 回覆、kiro 的每一筆紀錄。所以不會漏掉回合的結束。
  - 其他長行（例如數 MB 的工具輸出）只看開頭 8 KiB，用來判斷它屬於哪一個工具步驟，所以進度訊息不會漏掉這一步。
- View 與狀態的 context 更新共用各 instance 的 tmux control 讀取路徑，連線正常時不再逐 instance 建立 capture 子程序。停機、respawn、pane 替換或取消後，尚未返回的舊結果不會套用。
- 快取目前使用者已驗證的 OS home，避免 tmux namespace getter 反覆查詢帳號資料庫。讀取失敗仍是 unknown，絕不以 `$HOME` 代替。
- macOS 記憶體保護現在只採 kernel 壓力等級（1／2／4），以警告與 critical 控制啟動 admission，不再因可用／空閒 RAM 或動態配置的 swap 比例誤觸（#1256）。缺值或格式錯誤保持 unknown：不降速、不通知，每個 sampler 生命週期記錄一次有界原始輸出。pressure probe 由既有有界非同步 sampler 執行；admission 與 tool handler 不會另外啟動。Linux policy 不變。比例 fallback 等另有真 Mac 校準資料才處理。
- **網頁聊天的 `/compact` 現在會告訴你何時完成（#1269）。** 以前那張卡片會一直停在「已送出壓縮指令」。
  - 從指令送到代理的那一刻起顯示「壓縮中…」，等代理的對話紀錄寫下壓縮完成後顯示「對話已壓縮」，然後自己消失。適用於 Claude Code 和 Codex。
  - 其他後端（包括 kiro）沒有 AgEnD 能對應到這個 instance 的紀錄，所以會說明無法偵測壓縮何時完成並自己消失，而不是宣稱已完成或一直留著。
  - 10 分鐘內都沒有紀錄時，會說明這件事，不會一直等下去。如果指令沒有送到代理，或代理在這期間停止、重新啟動或換了後端，會說明已無法追蹤這次壓縮。
  - `/clear` 和 `/cancel` 只說明已送出的結果現在會自己消失；拒絕的原因會留著。
- 網站安裝腳本現在會偵測 Muse，不再列出已移除的 Gemini CLI backend。安裝與 quickstart 行為不變。
- **文字指令改走擁有者閘門（#1346）。** 多機器人共用群組時，每個機器人都會收到同一則訊息的副本，過去誰先收到誰就執行 `/cmd`，形同競速。現在會在佔用共用去重 key 之前先判斷話題擁有權：非擁有者的副本直接丟棄、不消耗 key，權限檢查也一律走擁有者那台的 admin 名單（只在別台有 admin 身份的人無法借道授權）。各平台行為：Discord fleet 話題中手打 `/xxx` 永遠不執行——擁有者回一則系統訊息導向 `/` 斜線選單並吃掉訊息，其他機器人保持安靜；Discord ClassicBot 頻道中 `/xxx` 會被所有機器人靜默忽略（也不會轉成 `/chat`）。Telegram fleet 話題中裸 `/cmd` 只由擁有者執行，`/cmd@otherbot` 忽略；Telegram ClassicBot 群組忽略裸 `/cmd`（只有 `/cmd@ourbot` 會跑）；Telegram 私聊不變。詳見 `docs/commands.md`（"Text Commands by Platform"）。
- **Service unit 的 `Environment=PATH=` 不再累積 `node_modules/.bin` 項目（#1348）。** `buildServicePath()` 現在會移除所有包含 `/node_modules/` 路徑段的 PATH 項目（工作目錄的 `.bin` 資料夾及 npm 自己的 `node-gyp-bin` runner），並在保留首次出現順序的前提下去除重複項目。nvm bin 目錄（`agend` 和 `node` 所在之處）會明確保留。這個污染具有自我延續性：每次 `agend install`/`/update` 都會把呼叫端的 PATH（繼承自舊 unit 的 `Environment=PATH=`）直接寫進新的 unit。套用此修正後，下一次 `/update` 會自動用乾淨的 PATH 重寫 unit。
- Codex recovery 不再把 paste 前讀不到的 input／footer pair 當成空 composer（#1359）。以本文辨識的殘留文字必須在 paste 前後都讀得到 input 才可歸屬；structured-input recovery 也會在 retry delay 與 Enter availability wait 都結束後、實際 recovery key 前重新驗證歸屬。未知 input 讓系統通知保持未確認，避免送出舊 draft；新的正面 echo／queue 證據則完成確認而不再補鍵。唯一 delivery ID 與 row-only retries 沿用原行為。隔離原生取證涵蓋關閉 warning viewer／縮小 pane 的競態；warmup 測試改用真實的空 composer fixture。
- 將 Kiro 對話讀取與大型歷史解析移出 Fleet 主執行緒，避免更新進度時卡住 Discord 指令確認。使用共用、有時限的 worker，保留唯讀連線、工作區專屬查詢及舊結果防護；不修改 Kiro 的資料庫。
- **回覆守衛誤報修正（#1377）：即使在回覆已成功投遞的情況下，也不再錯誤觸發「回合結束未收到回覆」的復原流程。**

  `#1241` 閒置確認路徑中有兩個競態條件，導致 kiro 及其他啟用 `replyCompletionGuard` 的後端出現假陽性的回覆遺失警報：

  - **情況一（IPC 回應延遲）：** agent 的 `reply` 工具呼叫已被處理並投遞至頻道，但 `fleet_outbound_response` IPC 訊息在 daemon 已執行 busy→idle 邊緣並啟動 60 秒確認視窗「之後」才抵達。由於 `settleToolAttempt` 沒有路徑通往 `clearReplyGuardConfirm`，計時器仍會觸發並啟動復原流程，即使回覆早已到達使用者。

  - **情況二（跨 instance 的 busy/idle 復活）：** 即使確認視窗已被提前到達的 settle 清除，世代（generation）本身仍維持活躍狀態。同一個 instance 幾分鐘後處理跨 instance 訊息時更新了 `busyObservedAt`，導致舊的（已回答的）人類世代被重新掛上確認視窗，最終觸發復原流程。

  **修正內容：**

  - 將 `replyAttempted` 的判斷移到 `busyObserved` 與確認視窗關卡「之後」（#1241），使傳輸中的回覆（IPC 回應尚未返回）得到與無回覆回合相同的 60 秒延遲，而非在第一個閒置邊緣就被當成「不明」立即回報。

  - 在 `TurnReplyGuard` 新增 `replyAttemptFailed` 旗標，在 `respond(null, error)` 被呼叫時（配接器明確回傳錯誤）設定。確定失敗的回覆仍會立即觸發 `reportReplyDropWithoutRetry`，繞過 `busyObserved` 關卡和確認視窗。

  - `settleToolAttempt` 在確認 `completionAction` 工具（reply/react/edit_message）以目前義務等級成功完成，且回合處於 `awaiting` 階段（非已取消、非復原中）時，現在同時呼叫 `clearReplyGuardConfirm`，取消待執行的確認計時器。`maybeConfirmReplyGuardIdle`（穩定閒置監控路徑）也會在無待確認視窗且 `completionDelivered=true` 時，於下一個監控刻度完成該世代。
- **Claude Code 立刻收下的訊息，不會再被標成「無法確認」並對使用者發出 ⚠️（#1379）。** 按下 Enter 後，Claude
  的輸入框會再顯示一下剛貼上的內容。AgEnD 把這當成「Enter 被吞掉」，並等最多 30 秒讓提示符回來；但 CLI 已經在處理這則訊息，提示符不會出現，回覆也早把訊息擠出畫面，結果明明送達了卻被標成無法確認。
  - 貼上的內容要在 Claude 的輸入框裡停留超過 3 秒，才算 Enter 被吞掉。
  - 能讀到 CLI 自己的對話紀錄（Claude Code、Codex）時，紀錄裡出現這則投遞的 id，就算確認已收下，不論畫面顯示什麼。
  - 「無法確認」的 log 會寫出實際的 CLI，以前不論哪個後端都寫「Codex」。
- **fleet 的頻繁畫面與視窗檢查改用已連線的 tmux control client（#1401，屬於 #1235）。** 錯誤監測、狀態擷取與 pane 健康檢查在正常連線時不再每次啟動子行程。查詢保留新鮮畫面與原有期限，重連時使用有界 fallback，並限制輸出大小、丟棄舊生命週期的結果。畫面寫入和分散執行的安全巡檢排程不變。
- **每 60 秒一次的安全巡檢，不再一次卡住整個 fleet（#1402）。** 以前每個 instance 的畫面檢查都在同一個 tick 開始、各自 spawn 一個 `tmux capture-pane`；實測這個 tick 會讓 fleet 的 event loop 卡住 150–860 ms，主機忙時達 1–2.5 秒，訊息、按鈕和 web UI 每分鐘停頓一次。現在每個 instance 的檢查各有自己的 tick，平均分散在每分鐘的前 30 秒內。
- **網頁：側邊欄的品牌列與每一頁的標題列對齊成同一列（#1408）。**
  - 品牌列（AgEnD、隱藏側邊欄、＋）原本比頁面標題列高 4 px，中線也低 4 px，所以「設定」這類頁面標題看起來比 AgEnD 高。
  - 標題旁的狀態、版本標籤與模型標籤比標題低 1–2 px；標題列的小按鈕和 instance 分頁是 30 px，旁邊的圖示按鈕卻是 36 px。
  - 現在在 Fleet、等你處理、檢視、instance 的四個分頁與設定頁，不論桌面或手機寬度，兩段都是 52 px、同一條中線，標題列的控制項都是 36 px。
  - 手機上 instance 分頁仍在標題下方自成一列。
- Kiro TUI 啟動時的 session 探索不再於 fleet event loop 讀取與解析使用者全部 history（#1417）。單一有界 worker 驗證完整 JSON，依檔案 identity、size、mtime、ctime 快取 metadata（4,096 筆／約 4 MiB）；15 秒總期限包含排隊。Adoption、已持有的精確 resume ID、只依建立證據 take-up 的語意維持，寫入 identity／config 前會重驗 launch admission，已持有的 resume ID 不探索 store。冷掃描仍在 worker 讀完整檔案；worker 失敗／過期沿用既有 unreadable-store 政策。
- **因 5 小時額度延後的排程，現在會在額度重置後補跑一次，不再直接跳過（#1426）。** 以前「延後」等於那一次直接作廢：在 100% 時觸發的每日檢查，那天就沒有執行。
  - **什麼時候跑。** 在 statusline 給的重置時間補跑；不知道重置時間時，每 15 分鐘檢查一次。
  - **同一次，有標示。** 補跑沿用原本那次的 run id，agent 收到的訊息開頭是 `[retry] originally due 21:00 (Asia/Taipei), deferred by the 5h rate limit at 100%`。
  - **絕不跑兩次。** 絕不會在下一次排程的時間點或之後執行，fleet 重啟後也會保留。
  - **`last_status`。** 會顯示 `deferred → delivered (retry)` 或 `deferred → skipped (…)`。
  - **補跑不成時。** 被下一次取代、又被延後，或 5 小時 15 分內都沒有重置，排程所在的聊天會說明並 @ 管理員。
  - **過時的讀數。** 額度視窗已經重置的讀數不再造成延後；閒置 instance 的 statusline 可能在重置後很久還顯示 100%。
- **Claude Code 2.1.295 新增的「Resume this conversation?」提示，現在會自動回應並保留對話（#1434）。** 這個提示可能在 context 很大的 instance 閒置、prompt cache 過期後跳出，也可能在恢復對話時出現。提示開著時，投遞的文字只會進到輸入草稿，Enter 也會被擋下。AgEnD 現在比照舊的 resume 選單處理：只在畫面完全符合時按 Esc（提示本身標示為「resume」），並確認它已關閉。其他形狀一律保留給人處理。AgEnD 絕不會選「Start a new conversation」，那會清空 context。
- **codex instance 用完額度時，又會自動改用 Luna Reserve 繼續，不再停下來等人處理（#1439）。**
  - codex 切到 Luna Reserve 時會跳出選單：上面是伺服器提供的選項（Upgrade、Reset usage、Add Credits……），最後一列是
    「Continue with Luna Reserve」。AgEnD 會按 Escape 回應，也就是改用 Luna Reserve 繼續。
  - 伺服器改了選項、第一項變成「Upgrade」之後，AgEnD 就認不出這個選單，instance 一直停在選單上，直到有人手動按 Escape。
  - 現在改用 codex 自己畫的部分來辨認選單，伺服器在上面放什麼選項都不影響。
- **codex 0.162：AgEnD 仍能認出「這段對話已在另一個 app 開啟」畫面與續接時的工作目錄選單（#1443）。**
  - codex 0.162 在 Linux 上把 Control 鍵寫成 `^c`（macOS 上是 `⌃c`），以前寫的是 `ctrl+c`。
  - AgEnD 是靠這段文字辨認這兩個畫面。在 0.162 上，「在另一個 app 開啟」畫面不再被擋下來等人處理，工作目錄選單也只被當成
    不認得的選單回報。
  - 現在兩種寫法都認得，所有 codex 版本上這兩個畫面都會再擋下來等人處理。
- **`agend update` 不會在新版本裝好之前就先移除 AgEnD（#1446）。**
  - 它會把一般的全域安裝誤認成本機的 `npm link`、先 unlink 再安裝，所以安裝一旦失敗（網路、Node 版本不相容、磁碟滿），
    `agend` 就整個不見了。現在要等 npm 換上新版本，現有的安裝才會被取代。
  - 安裝完成後，會先確認 PATH 上的 `agend` 是新版本，而且能在它實際使用的 Node 上開啟資料庫，確認無誤才會重新啟動。
    在 nvm 的 Node 上執行的安裝，檢查、更新服務設定與重新啟動也都在那個 Node 上進行。
  - `systemctl restart` 失敗時會回報失敗，不再回報成功。更新停止等待時 systemd 仍在重新啟動的話，會回報「仍在進行」，
    不會說已完成。
  - 檢查失敗後再執行一次 `agend update`，不會再把 fleet 重新啟動到那個沒通過檢查的版本上。
  - 只會透過通過檢查的那份安裝重新啟動 fleet，而且服務設定必須啟動的正是那份安裝。服務若仍指向別的安裝，update 會
    說明原因，正在執行的 fleet 不受影響。
- **網頁 app：alpha.2 回歸檢查的版面後續修正。**
  - 在 Settings 中，等待 admin 確認的變更會顯示在頁面裡、緊接在操作下方，不再以卡片蓋住它。其他面板仍在角落顯示卡片。
  - 在手機上：
    - Settings → Developer 的工具列維持一列圖示按鈕；
    - YAML 編輯器改為橫向捲動而不折行，邊緣的陰影提示還有內容；
    - View 中 agent 的設定行會折成兩行，而不是被截斷；
    - Settings 中每一列 agent 的標籤都以相同方式換行；
    - **Needs you** 與 Teams 的按鈕會與上方文字對齊。
  - 文件說明了為什麼登入頁在登入前會記錄一次 401。
- **網頁 app：alpha.2 回歸檢查的修正。**
  - Fleet 清單載入失敗時，會顯示錯誤狀態與 **再試一次**，而不是「還沒有 task」。
  - fleet 沒有 provider 密鑰時，設定頁不再去讀取，每次開設定頁都會出現的 404 也就消失了。
  - 數量為 1 時改用單數，例如「1 task」、「1 connection」、「1 room」。
  - 在手機上：
    - 連線名稱自成一行，不再被擠掉；
    - 設定頁的分頁能完整放進畫面；
    - 設定列與 **等你處理** 裡的按鈕都是足夠大的點按目標；
    - 指令清單的說明會換行，不再被截斷；
    - 空間不夠時，**中止回覆** 只顯示圖示，讓輸入框保留提示文字。
  - 在桌面的聊天中，通知會出現在標題列下方，不再蓋住輸入框的按鈕。
  - 登入提示不會再把 `agend web --code` 斷成兩行。
  - 深色背景上，「工作中」圓點的閃動不會再淡到看不見。
  - 文件已補上 Fleet → 組織圖、Fleet → 快取，以及聊天指令的說明。
- **過大的 agent 請求現在會收到真正的「413 Request body too large」（#1489）。** `POST /agent` 原本就會在讀取內容前拒絕沒有有效 instance token 的請求，也從不暫存超過 512 KiB 的內容。但帶著有效 token、宣告的內容又超過上限的請求，只會看到連線被切斷。現在會在讀取任何內容之前直接回 413。
- 更新會採用實際重啟結果：pending 回傳 exit 75 並保留修復備份；啟用失敗回傳 exit 1，不再回報成功（#1490）。Systemd 啟動失敗時，只有載入／磁碟 ownership 未變且確認服務已停止，才可還原本次更新的套件與 unit 備份；啟動前會核對舊的載入目標，回復成功仍回報本次更新失敗。Unknown／變更的 owner 與 detached 失敗需要管理者檢查。System-source Node 不符時會說明 user unit、system unit 與 launchd 的修復方法，並保留既有 restart 核對。
- **atomic 寫檔現在包含 fsync。** 三個使用 write+rename 但缺少 fsync 的檔案已修正：`fleet.yaml`（`FleetManager` 的儲存路徑）、`web-sessions.json`（`WebSessionStore.persistNow`）和 `update-marker.json`。三者現在都遵循 write → fsync(temp fd) → rename → fsync(dir，盡力而為) 的流程。`src/atomic-write.ts` 新增了共用的 `atomicWriteFileSync` helper，供 update-marker 和 session 路徑使用；`FleetManager` 則以相同流程內聯實作，以保留預寫入驗證步驟。(#1490 P3)
- **偵測後端不再卡住艦隊（#1490）：** `/ui/backends` 每次請求最多會在艦隊的事件迴圈上同步執行七次 `which`，每次逾時 2 秒。現在改成以非同步子行程執行 `which`，必須在 2 秒內回答，逾時的子行程會被終止，那個後端照舊顯示為未安裝。答案沿用 30 秒，同時進來的請求共用同一次查詢。卡住的查詢（例如 PATH 上有失效的網路掛載點）在子行程真正結束前，每個後端最多只佔一個行程，不會每次請求再多開一個。`/login` 仍然每次重新探測，剛裝好的 CLI 立刻看得到。
- Linux 服務內的聊天更新會使用獨立的同使用者 systemd scope，避免 fleet 停止時把 updater 一併清除（#1490）。Cgroup 狀態不明或 scope 啟動不可用時會拒絕並提示從主機 shell 恢復。保留安裝路徑驗證、環境、工作目錄與兩秒延遲；憑證不會放進命令參數。
- **`create_instance`：`tool_set` 和 `skipPermissions` 現在會以權限邊界錯誤拒絕。** 被誘導的 General 可以用 `create_instance` 建立有 `full` 設定檔、免確認的 worker。這兩個欄位現在在 Zod 的 `passthrough()` 把它們轉送給 instance-lifecycle 之前就被拒絕。錯誤訊息與 #804/#814 已有的 `update_instance_config` 拒絕訊息一致。(#1490 P3 #13)
- **`update_instance_config`：`saveFleetConfig` 拋出例外時，記憶體中的 patch 現在會被還原。** 先前，instance config 會先在記憶體中修改再儲存。若儲存失敗，記憶體和磁碟的狀態會不一致。處理器現在會在儲存失敗時還原記憶體狀態。(#1490 P3 #48)
- **只是被鎖住或打不開的歷史檔不會再被丟掉（#1490）：**以前 `events.db` 開啟失敗時，不管原因為何，fleet 都會把它改名為 `events.db.corrupt-<時間>` 並另開一個空檔。現在只有 SQLite 證實不是可用資料庫的檔案（`SQLITE_NOTADB`、`SQLITE_CORRUPT`）才會被移開。若是鎖定超過 5 秒的 busy timeout、SQLite 驅動在這個 Node.js 上載入失敗（為其他版本或架構編譯），或是權限、磁碟問題，檔案都會原封不動：fleet 在重新啟動前不記錄事件，並把原因發到 General topic（驅動問題會附上 `npm rebuild better-sqlite3`）。
- **Kiro transcript 能從單一 worker 卡住後恢復：** 讀取逾時後撤掉舊 worker 的
  讀取權，由替代 worker 沿用來源已接受的游標，不必重啟 fleet。舊回覆與 exit
  事件不會影響替代 worker。舊 worker 在真正退出前仍佔用實體名額，最多兩個；
  若兩個 native call 都卡住，讀取維持 15 秒期限與 legacy fallback，等其中
  一個退出才恢復。Kiro 共用資料庫仍只讀取。 (#1490)
- **Kiro 的工作階段查找不再佔用事件迴圈（#1490）：** Kiro 的資料庫裡還沒有某個 instance 的對話時，它的逐字稿來源會退回去讀 Kiro 的工作階段檔案。原本每 2 秒輪詢一次，每次都同步列出整個工作階段目錄並逐一檢查每個檔案，5,000 個工作階段時每個 instance 每次要 16 到 18 毫秒。現在改成非同步：每次輪詢只檢查目錄本身和最近有活動的工作階段，目錄有變動時才重新列出，每 30 秒才完整掃描一次，同時最多檢查 16 個檔案。
- **`/model`：拒絕含換行或控制字元的模型名稱。** 含有 `\n`、`\r` 或其他控制字元的模型名稱原本會被寫入 `fleet.yaml` 並原樣貼入 CLI session。指令現在會回傳錯誤，不寫入也不貼出。(#1490 P3a)
- **暫停/喚醒處理器：以 own-key 檢查防止繼承的原型鍵匹配 instance。** 使用者提供的 instance 名稱（如 `__proto__`、`constructor`）現在先用 `Object.hasOwn` 確認是否為自有屬性，再進行 instance 查詢，若非自有屬性則正確回傳「找不到 instance」，不會執行 `runPauseWake`。(#1490 P3b)
- **使用者 profile 處理器：在 general_topic 查詢前先執行 own-key 成員檢查。** `handleGeneralProfile` 現在在讀取 `instances[general]` 之前先確認 `Object.hasOwn`，使帶有 `general_topic` 的繼承原型項目無法冒充真實的 General——將以「僅限 General 使用」拒絕。(#1490 P3b)
- Fleet 啟動會區分持久投遞佇列的鎖定、毀損、SQLite 原生驅動不相容與其他開檔失敗，並提供修復提示。AgEnD 不會隔離或重設佇列；啟動及新投遞仍被拒絕，不會丟棄待送訊息或提交證據。初始化／recovery 失敗會關閉其資料庫 owner，不發布未完成 recovery 的 store。 (#1490)
- **Quickstart「新增允許使用者」：支援 `channels:` 陣列形狀的設定檔。** 抽取為可匯出的 `addAllowedUsersToConfig()`。有多個連線時，提示會顯示連線的 `id` 和 `group_id` 以便區分，且不會在檔案中寫入幽靈 `channel:` 鍵。(#1490 P2)
- **Quickstart「覆寫（重新開始）」：備份改為 fail-closed。** 抽取為可匯出的非同步函式 `backupFleetConfig()`（失敗時拋出例外）。若備份無法寫入，覆蓋動作會中止並印出錯誤——使用者不會在以為有備份的情況下遺失唯一的設定。(#1490 P2)
- **排程器：`recordRun` 現在是原子操作。** `INSERT INTO schedule_runs` 和 `UPDATE schedules SET last_status` 已包在同一個 transaction 中。先前若兩個語句之間發生錯誤或崩潰，可能留下孤立的 run 記錄，而排程上的 `last_triggered_at` / `last_status` 未更新。(#1490 P3)
- **補送的 Enter 只會送到原本那個視窗（#1490）：** 投遞的 Enter 沒有送出時，AgEnD 會等提示列回來，再補送一次 Enter。如果等待期間視窗被重建，補送的 Enter 會打到新視窗，後面的確認也會去讀新視窗的畫面。現在這些補送的 Enter 一路到真正送出按鍵之前，都會確認還是原本那個視窗、那次啟動；視窗換了，也不會從新視窗讀取證據。
- **`retireSystemCopy`：nvm 安裝時所有 npm 操作改用 `join(nvmBin, "npm")`。** npm 二進位路徑固定為 `join(plan.nvmBin, "npm")`——與 `inInstallEnv` 透過修改 PATH 後實際呼叫的 npm 相同。此路徑用於 prefix 鎖定、rollback root、install、verification 和 retirement，確保 `outcome.npmPath` 與實際執行的二進位一致。`retireSystemCopy` 接受明確路徑並回傳 `{ ok: boolean }`；呼叫端在失敗時設定 `process.exitCode = 1`。非 nvm 安裝不需要 retirement，也不進行任何查詢。(#1490 P3)
- **`saveCpuProfile`：大型 profile 在 `JSON.stringify` 之前就被拒絕。** 大小估算現在涵蓋每個 node 的所有可變欄位：callFrame URL 與 functionName（使用 `Buffer.byteLength(JSON.stringify(str), 'utf8') - 2` 取得精確的 UTF-8 加跳脫位元組數）、positionTicks 陣列（V8 真實欄位；80 萬筆項目單獨就可能超過 16 MiB）和 children 陣列。估算迴圈在達到上限時提前中止，避免超大 profile 繼續逐 node 計算。(#1490 P3)
- **`CacheService.stop()` 回傳 `Promise<void>`，設定 closing 旗標，並以一次有界 save 完成 flush。** `closing` 旗標立即阻擋新的 `kick()`/`start()` 呼叫。進行中的 pass 迴圈在下一次迭代邊界離開（而非掃完整個 backlog），然後執行一次有界的 `save()` 再設定 `stopped = true`。`FleetManager.doStopAll()` 現在也會 await `cacheService.stop()`。(#1490 P3)
- **`TmuxControlClient`：觀察時間改用單調時鐘。** `observationResetAt`、`inObservationGrace`、`lastOutputAt` 和 `isIdle` 現在全部使用 `this.mono()`（由 `performance.now` 支撐）而非 `Date.now()`。時鐘跳動（NTP、日光節約時間）不再導致 pane 在靜默視窗到期前就被視為閒置，也不再讓 grace 期比預期長。(#1490 P3)
- **`TmuxControlClient.waitUntilIdle`：用戶端停止時改為解析 `false`。** 原本解析 `true`，等於告訴呼叫端 pane 已閒置，可能觸發對已停止用戶端的投遞。(#1490 P3)
- **fleet 查不到的視窗不再被當成閒置（#1490）：**已註冊的視窗連續三次 `tmux list-panes` 失敗後，control client 以前會直接忘掉它，而未知的視窗在重連寬限期過後一律算閒置。訊息因此可能貼進還在生成的 CLI，Enter 等於打斷它。現在這種視窗會被記為「遺失」並回報為忙碌；有人詢問它的狀態時，最多每 5 秒重查一次，查到後重新註冊，並且要觀察到 2 秒沒有輸出才算閒置。重連後 pane 還沒查到的已註冊視窗，也會在查到之前一律視為忙碌。從未註冊的視窗行為不變。
- **tmux 重新連線後的觀察，以及單一次慢讀取（#1490）：** tmux 控制連線重新連上後，一個視窗要等它自己的 pane 被重新找到、並且安靜 2 秒之後，才算閒置。原本 2 秒的寬限是從重新連線那一刻起算，視窗多或 tmux 在高負載下變慢時，最後幾個視窗會立刻被當成閒置，訊息就可能被貼進正在工作的 CLI。單一次控制讀取超過 2 秒時，現在改由一次性的讀取回答，並把那次讀取的回應排掉，不再拆掉整條控制連線、連帶丟失所有 pane 的觀察；只有那次回應 10 秒內都沒有回來，才會重設連線。
- **網頁 app：整個頁面不再捲動（#1509）。** instance 清單很長時，聊天頁會出現兩條捲軸（聊天串一條、整頁一條），標題列也可能被捲出畫面。現在只有各個窗格會捲動。
- **Discord 的 `/dashboard` 會在你按的地方回應（#1512）。**
  - 選單是指令只有你看得到的回覆。按下之後，選單本身會先改成「正在私送…」或「正在開啟公開連結…」，再改成登入資訊送去哪裡：私訊；或在 bot 無法私訊你時，直接貼在原處、只有你看得到。
  - 以前 AgEnD 會到頻道裡找這則私人訊息，但 Discord 永遠找不到（`10008 Unknown Message`）。結果選單一直沒變，再按一次也看不到任何反應，而結果反而公開貼在 General。
  - 逾時或失效的選單現在也會在原處收起。
  - `/dashboard` 一定會回覆。選單顯示不出來時會直接說明，不再讓 Discord 顯示「應用程式沒有回應」。
  - 私訊送不出去時，log 會記下原因（例如 Discord 代碼 50007：使用者不接受伺服器成員的私訊）。
- **網頁 app：純網頁艦隊裡，沒回覆就結束的回合現在會被抓到（#1515）。** 在沒有連 Discord／Telegram 的艦隊中，從網頁聊天送出的訊息從未啟動「回覆完成守衛」，agent 若直接用文字回答，聊天就一片沉默。現在會和平台訊息一樣收到一次提醒。
- **網頁 app：點其他 instance 時，側欄維持原本的捲動位置（#1515）。** 在檢視頁，每點一次 instance 清單就跳回最上面；現在檢視與聊天都只會把目前的 instance 保持在畫面內，清單其他部分不動。
- **網頁 app：狀態 emoji 編輯器裡的 Discord 自訂 emoji 重新顯示（#1520）。** 在「設定 → 連線 → Discord → 狀態 emoji」中，所有伺服器 emoji 都顯示成破圖，原因是頁面的安全政策擋掉了 Discord 的 emoji CDN。現在面板只允許載入 `https://cdn.discordapp.com/emojis/` 底下的圖片，Discord 其他來源仍然擋住。
- **`/usage`：供應商用量端點的 429 不再顯示紅色錯誤。** 查詢端點被限流，不代表使用者的訂閱有問題。若有快取的快照，繼續顯示舊數值（既有行為）；若無快取，顯示中性提示（「暫時查不到用量，不影響你的 agent」），而非警示紅燈。429 回應中的 Retry-After 標頭現在也受到尊重：退避期間的強制重新整理直接回傳快取值，不會重複打供應商端點。
- **公開連結的進度把每個失敗畫在它所屬的步驟上（#1525）。** 通道被佔用（`lease-held`）以前畫在①「檢查 cloudflared」，看起來像 cloudflared 出問題；現在畫在④「啟動 tunnel」，沿用原本「還有另一個 tunnel 在執行」的說明。在自己的⑥開始前就結束的請求（共用啟動完成後失去資格）以前會把成功的⑤標成失敗；現在失敗畫在⑥，⑤維持✅。
- **設定：新增連線絕不會取代既有連線（#1529）。** 設定精靈過去會用 token 變數比對既有連線並覆蓋它，所以在 Telegram 之後新增 Discord bot 時，可能無聲地取代掉 Telegram 連線。現在每條新連線都有自己的 id（`discord`、`discord-2`…）和自己的 token 變數，會佔用別條連線的請求會被拒絕。
- **設定：每條連線顯示自己的狀態（#1537）。** 過去只要 AgEnD 在執行，每條連線都顯示「已連線」，即使它沒有啟動或 token 被拒。現在每一列顯示該連線自己的狀態：已連線 · @your_bot、重新連線中、啟動中、未執行、缺少 token、token 被拒，或開啟 Message Content Intent 的指示。
- **精靈建立的 Discord 連線現在能正確綁定 General 頻道。** `planQuickstart` 原本將 `general_channel_id` 寫在連線頂層（c25045b0 引入的 bug），但 runtime 讀的是 `channel.options.general_channel_id`。精靈現在寫入正確位置。含舊頂層欄位的既有 fleet.yaml 檔案仍透過 `discordGeneralChannelId()` 的 fallback 繼續支援。(#1552)
- **網頁：HTML 預覽的提示改用你的語言，預覽面板也能直接允許預覽（#1556）。** 以前即使頁面是繁體中文，預覽卡片和側邊面板的提示仍是英文，例如「Previews are off on this device…」、無法預覽的原因，以及預覽執行時的提醒橫幅。現在它們會跟著頁面語言顯示。在還沒允許預覽的裝置上，面板會提供 **允許預覽**，確認對話框和卡片選單、側欄的一樣。確認後「預覽」就能按，但仍要你按下才會執行。允許預覽仍是以瀏覽器和網址為單位，在別的網址開啟儀表板時會再問一次。
- **網頁聊天：圖片檢視器關閉時一定會收尾（#1564）。** 以前如果瀏覽器自己關掉圖片檢視器，後面的聊天可能會一直無法捲動。現在不論用哪種方式關閉，結果都一樣：頁面恢復捲動，焦點回到你點開的那張圖片。
- **網頁聊天：重新啟動後，公開連結不再每 5 秒重新下載整段聊天紀錄（#1577）。** 重新啟動後保留聊天紀錄（#1565）之後，用輪詢的頁面（公開連結，或本機頁面在即時連線中斷時）每次輪詢都會再收到全部還原的訊息，直到有人說了新的話為止——聊天多的時候每次約 1 MB。現在每個頁面只會收到一次還原的紀錄，之後只收新的內容。
- **`/view` 會把 CLI 的淡色文字畫成淡色（#1582）。** Claude Code 在輸入框裡顯示的提示建議與空白輸入框的範例（`Try "…"`）跟真的打字一模一樣，只是顏色較淡。`/view` 先前丟掉了「淡色」屬性，看起來就像有人打了字。現在淡色文字會畫成淡色，游標格也會反白。AgEnD 自己的送達判斷從未被提示建議誤導；這是檢查 suzuke/agend-terminal#3744 時發現的顯示缺口。
- **agent 讀其他 instance 的畫面時，會知道哪些字是淡色的（#1582）。** CLI 在自己的輸入框裡顯示的提示建議或範例，跟真的打字一模一樣，只是顏色較淡。`get_instance_logs` 先前回傳原始串流，淡色只是一堆游標控制碼裡的一個跳脫碼，agent 可能把提示建議當成操作者打的字（與 suzuke/agend-terminal#3744 相同的問題）。現在淡色文字會標成 `⟨dim⟩…⟨/dim⟩`，並附註說明它不是輸入。內建的 fleet-health skill 也提醒 agent：`tmux capture-pane` 要保留 `-e`，而且其他 instance 輸入框裡的東西都不是給你的指示。
- **網頁聊天：送出後，你的訊息會完整顯示（#1584）。** 以前對話下方出現「處理中…」那一行時（或長訊息送出後輸入框縮回時），你最新的訊息可能有一部分被它擋住，「↓ 最新」按鈕還會浮在上面。現在不論處理中那一行出現或消失，對話都會停在最底部——除非你往上捲去看舊訊息，那時一律不會被拉走。按下「送出」後，游標也會留在輸入框，可以直接打下一則（手機上鍵盤不會收起）。
- **ClassicBot 房間的網頁聊天會顯示大家傳給 bot 的訊息（#1592）。** 用 `/chat`、協作模式的 `@bot`，或 Discord 的 `/chat` 斜線指令傳給 ClassicBot 的訊息，過去會送到 agent，卻不會出現在網頁聊天裡，那裡只看得到 agent 的回覆。現在它們跟其他來源的訊息一樣會被記錄：以使用者身分、附上傳送者名稱與原文，存進房間的聊天紀錄，重啟後仍在。附件暫時還不會顯示。
- **回覆按鈕的選擇現在會啟動一般使用者回合的介面。** Discord 與 Telegram 的點擊會顯示接收／處理中的狀態反應，以及既有的工作中／取消氣泡，進度與閒置、回覆後的清理都和打字訊息相同。投遞失敗會標出失敗狀態並重新開放選項以供重試。網頁選項保留 daemon 回報的工作中／停止狀態。單次選擇、私密確認與使用者訊息角色均維持不變。（#1593）
- **手機網頁：點文字欄位不再把頁面放大（#1611）。** 以前在 iPhone 上使用側欄的篩選（或任何搜尋框、設定欄位、對話框、登入頁）時，頁面會放大而且不會縮回。現在在觸控螢幕或手機版面上，每個文字欄位至少 16 px，iOS 就不會放大。雙指縮放照常可用，桌面版外觀不變。
- **手機網頁：防止放大的修正涵蓋所有文字欄位，包括之後新增的（#1615）。** 延續 #1611：沿用周圍文字大小（而不是自己設定字級）的文字欄位，在觸控螢幕或手機版面上也至少 16 px，iOS 點到時不會再放大頁面。較大的欄位維持原本大小，桌面版外觀不變。
- **一個 bot 上過期的按鈕，不會再因為另一個 bot 的提示而保留（#1617）。** 自 #1610 起，在已顯示下一步（公開連結的確定／取消）的訊息上點到過期按鈕時，只會回應而不改動訊息。現在這個判斷也要求是同一個 bot，所以兩個 bot 的訊息編號剛好相同時，一個 bot 的進行中提示不會擋住另一個 bot 清掉它過期的按鈕。
- **從啟動紀錄引入前的版本升級時，Kiro 可延續原對話（#1624）。** 首次使用支援 `--agent` 與 `--resume-id` 的
  kiro-cli 2.21+ 啟動時，若 instance 沒有身份或啟動紀錄，只有在沒有其他已設定的 Kiro instance 共用同一實際
  工作目錄、且該對話尚未被認領時，才會認領相同引擎儲存區中最新的對話。Fleet 與 ClassicBot 都計入，包含已停止
  的 instance。無法判定歸屬時會開新對話並通知一次，原對話保持原樣。舊版 Kiro 的啟動行為不變；Kiro 日後升至
  2.21 時，仍可依原本的啟動紀錄認領對話。刻意開新對話或已記錄為 fresh 的身份不會自動重新認領。已在 beta.1
  開新對話的 instance 需手動復原，見 [Kiro 對話復原](kiro-upgrade-recovery.zh-TW.md)。
- **ClassicBot 代理可查證訊息投遞狀態（#1626）。** `delivery_status` 不再因為 `Unrecognized key: "chat_id"`
  而失敗。ClassicBot 的聊天室覆寫只套用到需要頻道位址的工具，其他工具的參數保持原樣。回覆、反應與編輯
  仍送到該 ClassicBot 的聊天室，並保留原本的 Telegram forum 主題。投遞狀態查詢仍嚴格驗證參數。
- **網頁：在 View 上傳圖片，不會再刪到別的 instance 的圖片（#1630 後續）。** 以前上傳時會刪除所有以「名稱加句點」開頭的頭像檔，所以替 `a` 上傳也會刪掉 `a.b` 的圖片；instance 名稱可以含句點（設定的快速設定和手動編輯的 `fleet.yaml` 都允許）。現在只取代這個 instance 個人資料記錄的那個檔案。
- **View：只儲存一個個人資料欄位時，不再清掉其他欄位（#1630）。** 儲存個人資料時，現在只會變更請求中帶的欄位（顯示名稱、角色、說明）。沒帶的欄位維持原樣，空白的欄位則會清除。View 自己的編輯器一律三欄一起送，所以那邊沒有變化；其他只送一個欄位的呼叫端不會再清掉其他欄位。
- **View：清除顯示名稱後會恢復 agent 自己的名稱（#1630）。** 以前在 View 的**編輯個人資料**清除顯示名稱時，會存成空名稱，仍然蓋過 agent 自己設定的名稱（`set_display_name`），結果顯示的是 instance 名稱。現在清除會移除覆寫，再次顯示 agent 自己的名稱（或 instance 名稱）。這次更新前清除過的顯示名稱也會恢復。
- **在沒有可用服務管理器的主機上，手動啟動的 fleet 可以持續更新（#1631）。** 在沒有 user systemd 的 Linux（容器、未啟用 systemd 的 WSL、未開 linger 的 SSH），或沒有 GUI 工作階段的 Mac 上，`agend update` 以前會替原本沒有服務的 fleet 建立 systemd unit 或 launchd plist，之後每次更新都會回滾並顯示「The previous package is back in place」。現在更新只會更新已存在的服務檔。新版本的 `agend install --no-activate` 在能確定是舊版更新器呼叫時也不會寫入任何檔案，因此從 2.2.0-beta.1 更新時同樣不會留下服務檔。手動執行 `agend install` 仍會建立服務，已存在的服務照舊更新。如果先前的更新已在這類主機上留下服務檔，請刪除它（`~/.config/systemd/user/com.agend.fleet.service` 或 `~/Library/LaunchAgents/com.agend.fleet.plist`），再執行一次 `agend update`。
- 修正給 agent 的投遞驗證說明：「Delivery not found」可能是 ACL 隱藏、紀錄保留期限已過，或沒有投遞。Agent 必須先取得對方明確 forward 的可驗證參照才能行動，也不能重送狀態不確定的投遞。既有 instance 升至 2.2.0 時會收到一次更正；投遞查詢與掃描器行為不變。
- **Agent：AgEnD 告訴 agent 的內容再次與實際行為一致（#1634）。** fleet 指示、agent CLI 參考、General 的核心規則、工具說明與十五個內建 skill 都已對照程式碼檢查。現在會說明 `reply` 的按鈕與貼圖、來自網頁聊天的訊息、實際的圖片／檔案／引用標記、遞送狀態（已接受不等於已送達；`uncertain` 不要重送）、`get_fleet_status`（只有數量；個別狀態在 `list_instances`）、`agend fleet restart` 的行為（graceful；要載入新程式碼用 `--reload`）、在 fleet session 中需要 `--yes`、各 backend 如何續接自己的 session、各 backend 分別登入、Codex 與 Muse 的回覆保護、被拒絕的 `kiro_ui: v3`，以及目前的模型列表指令。MCP server 現在回報實際的 AgEnD 版本（原本寫 0.3.0），並在指示中寫出版本，讓 agent 能判斷先前載入的工具說明是否較舊。
- **設定：回覆保護的說明對 Codex 與 Muse 正確了。** 從 2.2 起，回覆保護也適用於 Codex 與 Muse，但設定仍顯示「設定會保留，但不會生效：codex 的 mcp 模式不支援回覆遺失補救」。現在會說明 Claude Code、Codex、Muse 與 Kiro legacy/TUI 的 MCP 模式可用。
- **kiro 被限流或達到每月上限時，現在會通知（#1636）。** kiro 被限流時會印出 `⚠️  Kiro rate limit reached:` 和 `Request quota exceeded. Please wait a moment and try again.`；達到每月上限時會印出 `Monthly request limit reached`（單獨一行，或後面接著額度重置的日期）。這兩種訊息都不帶「Kiro is having trouble responding right now」標頭，也不帶例外名稱，所以 AgEnD 的 kiro 規則都比對不到：這個 instance 不會被標記，也不會有人收到通知。現在兩者都歸為會通知的速率限制，和 kiro 其他的限流訊息一樣處理。同一畫面上如果還有登入過期，仍然會先暫停；只是引用這幾行文字的訊息不會觸發任何動作。上游版本預檢遇到「新」字串可能只是舊字串換了存放順序時，會提醒稽核者；但它仍然算作新字串，由稽核者判斷。
- **被誤判為 `stuck` 的 codex instance 會自己恢復，卡住目標的待送訊息也看得到了（#1641）。** 重新啟動後，續接的 codex 在第一個回合之前，頁尾只有 `⚠ N warnings · f2 to view`，沒有 Context 用量。AgEnD 會把這個畫面判為工作中（這是 #1031 的刻意設計），畫面靜止一段時間後就變成 `stuck`，而且再也出不來：pump 不會把工作交給卡住的目標，排隊的訊息就在第 0 次嘗試停了好幾個小時。現在，只要畫面顯示 CLI 自己的空白輸入框，而且 codex 的 rollout 顯示沒有回合在跑，卡住的 instance 就會回到 idle；沒有 rollout 可查時，同一個輸入框要靜止 10 秒才算。還在跑的回合永遠不算；而且只要 codex 的 rollout 顯示有回合在跑，畫面怎麼看都不會判為 idle，AgEnD 開始追蹤 rollout 之前就已開始的回合也一樣。`delivery_status` 現在會說明排隊中的訊息在等什麼（`waiting_reason`）；常駐的 instance 若有排隊中的訊息因為這類原因等了 30 分鐘，會在它的主題通知一次。
- **已送達的靜默排程不再被回報為「無法確認」，也不會出現在「需要你」（#1647）。** 靜默排程（或其他 raw paste）貼上後，若按下 Enter 後無法立即從畫面確認，AgEnD 會改為尋找它所開始的那一輪：
  - **Claude Code：** 尋找 CLI 自己 transcript 中原始訊息只有一段文字、去掉 Claude 的貼上包裝、正規化空白後與貼上內容相符的紀錄（write checkpoint 之後）。transcript 路徑來自這個 instance 自己的 statusline.json。
  - **Codex：** 不涵蓋——其 rollout 是依工作目錄決定的，無法綁定到這次啟動，因此 Codex 的 raw paste 在畫面無法確認時維持「無法確認」。
  - **kiro：** 以輸入列判斷——貼上文字必須已從輸入列消失，或 kiro 的 busy marker 出現在原處，且 Enter 後有輸出才算確認。

  找到就算已送達；找不到則維持「無法確認」並記錄真正原因，絕不重貼、也不會再按一次 Enter。未確認或失敗的靜默排程現在只會以寫明原因的通知送給 leader，不會列入「需要你」，下一次排程照常執行；人送出的訊息仍和以前一樣會列入「需要你」。紀錄中現在會寫出「送訊息時發生錯誤」背後的原因，`delivery_status` 也會把這類紀錄描述為「無法確認」。
- **CLI 模式的 agent 會被告知它實際可用的指令（#1650）。** `agent_mode: cli` 的 instance 沒有 MCP 工具，但它收到的每則訊息結尾仍寫著「用 reply tool 回覆」或「用 send_to_instance／report_result」。現在這些結尾會寫出 `agend-agent` 指令：回覆使用者用 `agend-agent reply "…"`，回覆其他 instance 用 `agend-agent report <寄件者> "…" <correlation_id>` 或 `agend-agent send <寄件者> "…"`。預設 MCP 模式的 instance 看到的內容完全不變。
- **Agent：Telegram 上以 `format: "markdown"` 呼叫 `edit_message`，不會再因 `<` 或 `&` 而失敗（#1651）。** 自 #1654 起，這類編輯會把文字原樣當作 Telegram HTML 送出，因此像 `a<b` 或 `x & y` 這樣的文字會被拒絕（「can't parse entities」），而以前它們會以純文字送出成功。現在編輯文字會先全部跳脫再從 markdown 轉換：`<`、`&`、`>` 照原樣顯示，**粗體**、*斜體*、~~刪除線~~、`code` 與 http(s) 連結會套用格式。若 Telegram 仍拒絕該格式，會改以純文字重試一次。表格與程式碼區塊在編輯時不會重新呈現。
- **Agent：`edit_message` 會保留訊息格式（#1651）。** `edit_message` 有 `format` 參數卻會忽略它，因此在 Telegram 上，編輯一則以 `format: "markdown"` 送出的訊息，結果會變成純文字。現在編輯的呈現方式與 `reply` 相同：Telegram 會套用 `format: "markdown"`；Discord 本來就一律呈現 Markdown，維持不變。
- **nvm 更新流程：舊 root 副本 sudo 移除失敗不再導致更新失敗（#1660）。** 退役舊系統副本只是清理工作：新版本已安裝、驗證並運行後，被拒絕的 `sudo -n npm uninstall` 只會變成警告，不再 exit 1。聊天室 `/update` 回報成功，待退役結果確定後，再把警告與一字不差、經 shell 引用的手動指令追加到同一則更新訊息（updater 要等重啟返回才會退役，因此完成通知與清理通知是兩段生命週期，以 update receipt 守門）。`sudo -n` 維持非互動——永遠不會要求輸入密碼。真正的安裝或驗證失敗仍照舊失敗。
- **從網頁聊天送出的訊息，現在也會在該 instance 的 Discord/Telegram 主題顯示 🛑 取消／進度泡泡（#1666）。** 以前只有在 Discord 或 Telegram 裡輸入的訊息才會出現；網頁訊息那一輪要等 agent 第一次回覆後才會出現泡泡。泡泡會緊接在網頁訊息的轉貼之後出現，規則和以前一樣：agent 工作時持續更新，agent 閒置時回覆或按下取消就會消失，只有該主題允許的人能按。純網頁 fleet、沒有送達的訊息、關閉網頁轉貼的 fleet，以及 ClassicBot instance 都不會出現泡泡。
- **在聊天、檢視、紀錄、詳細資訊之間切換時，instance 標頭與用量側欄不再跳動（#1673、#1218）。**
  - 紀錄頁原本不顯示用量側欄，所以在寬螢幕上切到紀錄時，頁面和標頭會跳動 320 px。在紀錄頁按 ◔ 還會關掉一個看不見的側欄，回到聊天時它就不見了。
  - 紀錄頁現在和其他分頁一樣顯示側欄。顯示或隱藏仍是這台裝置的設定，在每個分頁都相同。
  - 分頁列和標頭按鈕在每個分頁的大小與位置都相同：字級按鈕的寬度固定為最長名稱（View 的「剛好填滿」縮短為「填滿」），目前分頁的粗體字不再改變分頁列寬度，紀錄頁也保留其他分頁放 ⋯ 或 ⓘ 的空間。
- **View 的字級（Aa）會立即套用（#1674）。** 在 View 頁面切換 剛好填滿／小／中／大 時，新字級原本只出現不到一秒，下一次畫面更新又變回舊字級，要離開頁面再回來才會生效。現在終端機在每次更新與調整大小時都會維持你選的字級。Chat、Details 與 Fleet 本來就會立即改變。
- **網頁：又能找到 Fleet 組織圖了（#1675）。** 開著某個 instance 時，側欄的 **Fleet**（以及手機的 Fleet 分頁）會進到那個 instance 的詳細資料，因此到不了 Fleet 面板和它的**組織圖**。現在從任何頁面點側欄最上方（手機上是抽屜最上方）的 **Fleet 概覽**，就會打開 Fleet 面板的組織圖，Tasks、排程、Teams、快取和設定也都只差一下點擊。`/ui/fleet/org` 照舊可用。
- **不再重複發送主機記憶體聊天通知（#1685，最終行為由 #1712 取代）。** 2.2 在所有平台移除壓力與恢復廣播。啟動放慢／暫緩、日誌、儀表板狀態與 health 降級保留；人手動啟動、重啟或喚醒而被暫緩時會收到原因。
- **在 Claude Code instance 上用 `/model`，不會再卡在 Claude 的「Switch model?」確認畫面（#1690）。**
  - Claude 2.1.296 在對話已用先前的 Model 快取時，會要求確認切換，但先前沒有人回答它，pane 會一直等，訊息也全部卡在後面。
  - **你的切換會自動確認**，但只有在確認畫面寫的正是你要的 Model 時才會。回覆會說明 Claude 的下一則回答會重新讀取完整對話紀錄。
  - **畫面寫的是別的 Model 時**，AgEnD 會回答「否」並告訴你。
  - **不認得的名稱**（例如打錯成 `opsu`）在送出任何指令前就會被拒絕；Claude 本身什麼名稱都接受，還會真的切過去。
  - **確認畫面在時，訊息會先保留。** AgEnD 沒有要求的確認畫面絕不會被自動回答，會先保留並顯示在「需要你處理」。
  - 適用於 Discord、Telegram、網頁與 Model 選單的 `/model`。
- **網頁：建立 team 時不會再覆蓋現有的 team，也不會儲存不存在的成員（#1692）。** dashboard 的 **新增 team** 原本直接寫入 fleet.yaml：給什麼成員名稱就存什麼，遇到同名的 team 也會直接覆蓋，原有的成員和描述就此遺失。現在它與 agent 的 `create_team` 使用相同的流程：
  - 成員必須是這個 fleet 的 instance；
  - 已存在的 team 會被拒絕（「Team already exists」），並維持原狀；
  - 像 `constructor` 這樣的名稱會被拒絕。

  如果 fleet.yaml 儲存失敗，就不會建立 team。
- **限制重啟後的回覆提醒數量**（#1694）：每次重啟只發一則提醒，最多列十筆尚未回答的請求，其餘顯示數量。回覆義務預設在上次詢問的 24 小時後到期（`defaults.reply_obligation_ttl_hours`）；若尚未通知過逾期，會通知寄件者一次。新請求與回合結束的提醒照常運作。回答仍須帶原請求的 correlation ID，一般訊息不會關閉無關的請求。
- **使用 credential profile 的 agent 登入過期時，現在會回報，不再被忽略（#1699）。**
  - AgEnD 暫停任何東西之前會再確認一次登入錯誤。以前確認的是 backend 的預設登入，所以只要預設登入正常，用其他 profile
    的 agent 看起來也正常，它的錯誤會被當成對話內容略過。
  - 現在確認的是 agent 自己的 profile，Claude Code、Kiro 與 Codex 都一樣。
  - 警示會寫出 profile 名稱、只列出用該 profile 的 agent，並附上為該 profile 登入的完整指令。
- **網頁：該關閉拼字檢查的地方確實關閉了（#1700 後續）。** 側欄篩選框、Bot token 欄位、fleet.yaml 編輯器和刪除確認框原本應該關閉拼字檢查，實際上卻是開啟的。在開啟「加強型拼字檢查」的 Chrome 中，token 欄位顯示出來的 bot token 文字可能會被送到 Google 的拼字服務。現在這四處都確實關閉了拼字檢查。
- Linux 在可用 RAM 充足、只有冷頁佔滿 swap 時，不再誤報記憶體壓力或放慢新 agent。PSI 停滯量搭配 RAM 安全門檻決定警告與暫停；PSI 不可用時安全退回 RAM 判定。日誌與儀表板保留實際壓力訊號；#1712 已移除所有記憶體壓力聊天廣播。
- **muse：`skip_permissions: false` 時的批准提示是等人處理的 permission 互動（#1715）。** 開著 approval 時，muse 會停在「Would you like to run the following command?」提示（escalated 兩選項或 `--approval-mode untrusted` 三選項）而沒有任何 dialog 認得它，instance 看起來只是在忙、沒人被問。現在整塊提示都會被認出來——兩種選項、staged 的 `Stage N/M`／`Current argv` 列、1.4.4 的 `›` 游標與缺省的 footer——顯示期間投遞暫停（Enter 會選到預設的允許選項），並以 `awaiting_input` 加一個 permission Needs-you 回報，絕不代答。prod 的 `skip_permissions` 路徑不變（escalation 由 muse 自己拒絕、不跳提示）。
- **muse：背景任務執行中下 `/quit` 不再卡在確認選單，改由 AgEnD 明確處理（#1716）。** 有背景任務時，muse 會以「Local work is still active」確認選單（`1. Exit anyway` / `2. Stay`）回應 `/quit`，過去沒有任何 dialog 能辨識它，stop/restart 只能等超時再靠盲按 Ctrl-C。現在 AgEnD 會整組辨識該選單、選單出現時暫停投遞（避免某次投遞的 Enter 誤選 "Exit anyway"），stop 流程以 Escape 取消選單（絕不代選任何選項）再自行停止行程，沿用 #1217 的路徑。被結束的背景工作會留下記錄並如實回報、絕不靜默：stop 會發到該實例的 topic，Classic /stop 回覆會加註，fleet restart/update 完成訊息會列出受影響的實例（各自限定在當次操作範圍，舊的 stop 不會誤報）。idle 自動暫停則在背景工作執行中順延（見 #1717），不會靜默砍掉使用者的背景工作。
- **muse：背景任務執行中不再擋住 idle 偵測——composer 是空的，實例視為 idle（#1717）。** 背景任務執行時，muse 會在輸入框與狀態列之間畫出 terminals 面板（`main · ↓ to select` / `└ ◆ … running 11s`），過去它讓 idle 證明失敗，整個任務期間實例既非 busy 亦非 idle，idle-edge 動作（投遞、cancel 收尾、readiness gate）全部等待。現在 footer 檢查只接受這種面板形狀——標頭加 `running` 任務列、狀態列仍在最後；真正 busy 的 turn（輸入框上方有 interrupt 提示，含任務執行中新開的 turn）依然判 busy，未知形狀一律 fail closed。因此背景任務算「local work still active」而非 busy：投遞用的 idle 照常通過，idle 自動暫停則在面板顯示 running 時順延而非砍掉任務。
- **網頁聊天：長的狀態行時間恢復成一行（#1726）。** 其他 agent 傳來的訊息（`send_to_instance` 那一行）在長文字旁邊，時間被拆成一個字一行。原因是它和標題的狀態徽章用了同一個 class 名稱，套到了徽章的版面。
- **臨時公開連結的 HTML 預覽通道連不上時，會再開一次（#1732）。** quick tunnel 偶爾無法在啟動的一分鐘內連上；這時預覽通道會在背景換一個新網址再開一次（只重試一次）。期間卡片仍顯示「預覽啟動中…」，連結本身完全不受影響。
- **kiro legacy UI：shell 工具輸出沒有結尾換行時，turn 結束後 instance 不再卡住（#1734）。** kiro 有時會把 `- Completed in …` 直接接在最後一個輸出字元的後面，而不換行。原本的完成偵測器用行首錨點，因此看不到這種情況，導致工具（與 instance）一直顯示為執行中。排隊中或排程的訊息會停擺，約十分鐘後送後確認也會出現「無法確認」的警告。偵測器現在改為比對前面跟著任意空白的 ` - Completed in`，正常換行和同行兩種情況都能偵測到。
- **聊天室的 `/update` 在各種重啟方式下都會顯示「舊的系統安裝沒有移除」提示（#1735）。** 更新把 AgEnD 從 root 擁有的安裝移到 nvm、卻沒能移除舊的那份時，提示和手動移除指令只出現在終端機；只要 fleet 的重啟不會等待（手動啟動的 fleet，或 macOS 的 launchd），聊天室的更新摘要就少了它們。現在兩種情況摘要都會帶上，提示也會寫出舊安裝所在的資料夾。
- **更新後的 fleet 完成啟動時，不會再清掉別的操作的進度記錄（#1735）。** 它只清自己接手的那次更新；在這期間開始的 `/restart full` 或新的 `/update` 會保有自己的記錄。清理提示只在舊安裝的資料夾路徑不含控制字元或不可見字元時才寫出路徑。
- **Telegram：`setMyCommands` 現在會套用 `telegram_api_root`（#1736）。** 即使設定了自訂的 Telegram Bot API 伺服器，Bot 指令選單的註冊一直都打到 `api.telegram.org`。現在 URL 改為與 adapter 使用相同的根路徑。
- Dashboard 停機時會結束 SSE，最多等一秒讓自己持有的 HTTP socket 完成，再強制關閉剩餘連線。新版頁面收到停機提示後延後重連；Windows／WSL 文件補上安全替代連線及操作者自行選擇 mirrored networking 的說明。這能減少連線反覆建立，不宣稱能修復卡住的 WSL relay。
- **Telegram `/web` 會正確說明公開連結失敗的原因（#1742 後續）。** 在 bot 還沒嘗試私訊你之前登入連結就失敗時（例如公開連結無法啟動），訊息現在會說明連結無法啟動，並請你再執行一次 `/web`，不再請你開啟私訊（那樣也沒有用）。開啟私訊的步驟、「先開私訊 →」按鈕，以及 10 分鐘的 `/start` 時間窗，現在只會在實際嘗試私訊卻送不到之後出現。
- **從自訂 `AGEND_HOME` 安裝的 fleet，在服務重啟或更新後仍使用同一個 home（#1743）。** 當 home 不是預設的 `~/.agend` 時，`agend install`（以及更新時的重新產生）現在會把 `AGEND_HOME` 寫進 launchd job 與 systemd 使用者單元。以前服務管理器會讓這種 fleet 改用 `~/.agend` 啟動。預設 home 的服務定義維持不變。
- **用量面板的方案標籤維持一行（#1749）。** 用量側欄和對話框裡，較長的方案名稱（例如「TEAM PREMIUM (6.25X)」）原本會在服務名稱旁折成兩行，現在改為顯示 **TEAM ×6.25**（TEAM ×1.25、MAX ×20 同理）。完整方案名稱會在滑鼠停留時顯示，螢幕閱讀器也會讀出。空間不足時，服務名稱會先以省略號縮短，↑↓ 按鈕也維持在同一行。`/usage` 和 `get_usage` 仍顯示完整方案名稱。
- Telegram 的「等你處理」即時訊息不再每十分鐘重複發送沒有變化的清單。文字與按鈕相同時會略過編輯，Telegram 回覆「訊息未變更」也視為成功，適用於文字與按鈕編輯。只有確認訊息或目的地不存在、或失去權限才會重新發送，仍最多每分鐘一次。若曾為此將 `needs_you.live_message` 關掉，更新後可以重新開啟。
- **fleet 的多個 bot 在同一個 Discord 伺服器時，instance 的通知由它自己的 bot 發出，其他 bot 的貼文也不會再被當成輸入（#1752）。** 以前用量警告（以及因記憶體延後的通知）是由「最先收到使用者訊息的那個 bot」發出，可能是另一個 bot；instance 自己的 bot 接著把那則貼文當成使用者訊息。現在這些通知一律由 instance 自己的 bot 發在它的主題裡；fleet 主題中由本 fleet 任何 bot 發的訊息一律忽略，就算開了 `/collab` 或 open 存取也一樣。`/collab` 與 open 存取仍會放行其他 bot 和 webhook；ClassicBot 房間裡本 fleet 的 bot 仍可用 @mention 互相對話。
- **Claude profile 切換剛好碰上另一次重啟時，對話仍會帶過去（#1753 後續）。** 切換所觸發的重啟如果併入一個已在進行中的重啟（例如 MCP 恢復），以前不會複製對話，回覆也沒有說明。現在只要那次重啟還沒啟動新的 CLI，複製就會在那次重啟裡執行。如果已經啟動，切換的回覆會以 `carry_failed` 說明原因，並照常送出交接內容。
- **Claude profile 切換時，如果 CLI 實際啟動的是另一個登入，就不會再回報對話已帶過去（#1753 後續）。** 如果 profile 切換併入了一個在切換存檔之前就讀取設定的重啟，那次重啟會用舊的登入啟動，但切換仍可能把對話複製到新 profile，並回覆「已帶過去」。現在只有在即將啟動的登入正是切換的目標時才會複製。否則回覆會以 `carry_failed` 說明實際啟動的登入，並照常送出交接內容。如果啟動的是舊的登入，CLI 會直接接續它自己的對話；如果是第三個登入，則重新開始。
- **使用 Claude credential profile 的 instance 保有共用的自動記憶（#1754）。** 具名 profile 有自己的 `projects/`，所以 Claude Code 對該 repository 的記憶在那裡原本是空的，和其他 instance 的記憶分開。現在每次以 profile 啟動時，都會把 profile 裡該 instance 所在 repository 的記憶資料夾連到 `~/.claude`（或你自己設定的 `CLAUDE_CONFIG_DIR`）底下的共用記憶。對應的 key 是 repository 根目錄，git worktree 以主 checkout 為準，和 Claude 自己決定記憶位置的方式一致。對話仍然各 profile 分開。profile 裡已經有筆記的記憶資料夾絕不會被取代：會保持原樣並記錄警告。沒有使用 profile 的 instance 啟動方式完全不變。
- **Cloudflare 拒絕建立臨時公開連結時，現在會直接說明（#1767）。** trycloudflare 限制這台機器建立新的 quick tunnel（HTTP 429）時，步驟會顯示「Cloudflare 正在限制這台機器建立新的臨時連結 — 請過一陣子再試；區網連結仍可使用」，不會在 0 秒時說成逾時。cloudflared 其他提早停止的情況也會照實寫出，daemon.log 會記下原因。HTML 預覽的通道改成在連結自己的通道拿到網址之後才要求，不會再用掉連結需要的那一次。
- **網頁聊天的訊息時間，不是今天的會顯示日期（#1770）。**
  - 今天的訊息照舊只顯示時間；昨天的顯示「昨天 17:38」，更早的顯示「10/11 17:38」，其他年份的顯示「2025/10/11 17:38」。滑鼠移到時間上可看到完整日期與時區。
  - 時間與日期以 fleet 的時區判斷（與聊天紀錄、fleet.log 相同），不是瀏覽器的時區。訊息、狀態行與預覽面板都用同樣的標示；過了午夜標示會自動更新，不會重新載入任何預覽。
- **agent 回覆附加的檔案，在 fleet 重新啟動後仍可在網頁聊天中開啟（#1770）。**
  - 以前回覆附的 .html 或 .png 在更新或重新啟動後，通常會顯示「無法取得」：網頁聊天只保留放在 instance inbox 裡的檔案，但 agent 通常從 /tmp 或自己的工作資料夾傳檔。agent 之後改寫或刪除檔案，或 /tmp 被清掉，也會讓檔案失效。
  - 現在網頁聊天會把每個回覆檔案另存一份到 `workspaces/<instance>/web-files/`，並顯示這份副本。符號連結、超過 50 MB 的檔案，以及 AgEnD 狀態資料夾內（inbox/ 以外）的檔案不會顯示。
  - 訊息離開網頁聊天紀錄時，副本會一併刪除。每個 instance 最多保留 1 GiB，超過時先刪最舊的副本。副本不在時，訊息照舊把檔案標為無法取得。Telegram 與 Discord 不受影響。
- **在網頁聊天送出的短訊息，泡泡會貼合文字寬度（#1773）。**
  - 以前泡泡會撐到上方那一行（你的名稱、時間與送達標記）的寬度，所以像「目前進度」這樣的短訊息，泡泡寬度是文字的兩倍；#1770 加長的時間（「昨天 下午03:58」）讓情況更明顯。
  - 現在泡泡貼合文字並靠右，位在名稱與時間下方。長訊息仍在原本的寬度換行，附件仍在泡泡裡，agent 的回覆外觀不變。
- **跨升級續用的 agent 又能傳 `forwards` 了（#1780）。**
  - 跨 beta.7 升級續用的 Claude Code session 仍看到舊版 `send_to_instance`，沒有 `forwards`。它改把 verification ID 寫進訊息內文，但這不會授權，所以收件者的 `delivery_status` 回「Delivery not found」。
  - Claude Code 會沿用 session 第一次載入時的工具 schema，重新載入也不會更新。AgEnD 伺服器仍接受新參數。
  - 現在執行中的 instance 會收到一次 what's-new 通知：`send_to_instance` 和 `delegate_task` 接受 `forwards`，而內文提到的 ID 不會授權。通知不再建議重新載入工具，而是請 agent 照樣使用新參數。
  - 轉交指引（skill、工具說明與文件）寫明了這種失敗情況。
- **網頁：簡體中文字形現在來自與繁體相同的字型家族（#1781）。** `--font-ui` 字型堆疊只列出繁體中文字型（`PingFang TC`、`Noto Sans TC`、`Microsoft JhengHei`）。订、实、结、论、讲、认、档、还、众、数、验等簡體專用字形各自退回系統提供的字型（通常是 SimSun 宋體或其他設計），使混排句子顯得粗細不一。對應的簡體字型（`PingFang SC`、`Noto Sans SC`、Linux 上常見的 `Noto Sans CJK TC`、`Noto Sans CJK SC`、`Microsoft YaHei`）現在緊接在各繁體字型後面加入堆疊。繁體文字渲染方式與先前相同；不下載任何網路字型。
- **kiro-cli 2.30.0：AgEnD 重新會回答改了措辭的 Classic 提示（#1784）。**
  - 2.30.0 把 kiro 啟動提示裡的「3.0」改成「V3」。AgEnD 因此認不得 legacy（Classic）instance 啟動時遇到的 Classic 停用提示：既不回答也不擋住，instance 收不到訊息，直到有人手動回答。
  - 現在 AgEnD 照舊回答：先從「Switch to V3」往下移一格，再選「Remind me later」，每次按鍵前都確認游標位置。不會改動你的引擎設定。
  - 改了措辭的 V3 提示（「You're using Kiro CLI V2. Switch to V3 today.」）和 agent 設定提示（「still in the V2 format」）也一樣，分別回答「Remind me later」和「Not now」。「Don't ask again」或 AgEnD 讀不懂的游標，仍留給你決定。
- **kiro：2.28.0–2.30.0 啟動不再跳警告；警告文字不再重複「kiro-cli」；「紀錄」分頁顯示純文字而非 JSON（#1785）。** 三個獨立原因：`KIRO_TESTED_MAX` 卡在 2.27.0，儘管 2.28.0、2.29.0（#1576）和 2.30.0（#1785）已經過實機驗證；版本警告把原始 `--version` 輸出（「kiro-cli 2.30.0」）傳進本身已含「kiro-cli {0}」的訊息模板，導致「kiro-cli kiro-cli 2.30.0」；「紀錄」分頁的事件列在 payload 只含 `message` 欄位時，把整個 payload 序列化成 JSON，使「啟動警告」列顯示 `{"message":"…"}` 而非訊息文字。三項已全部修正：最大版本提升至 2.30.0，警告模板改接裸 semver，`detail` 在 `message` 欄位存在時使用其文字。
- **grok 實例在停止、暫停、重啟時都能正常結束（#1792）。**
  - grok 要在一秒內按第二次 Ctrl+Q 才會結束；AgEnD 只送一次，grok 只顯示「再按一次以結束」，每次停止都要等三秒再被強制終止。
  - 現在 AgEnD 會送兩次 Ctrl+Q（間隔 250 毫秒）。這是 grok 1.0.52 稽核時發現的；除此之外，1.0.52 對 AgEnD 沒有影響。
- **muse 的 /model 從本機 provider catalog 讀取新模型（#1796）。** 之前寫死四個 id，新模型（muse-wonder-1.0）重啟加重新整理也不出現。現在 `listModels()` 讀跟 live picker 同一份 `model-catalog/*.json` 快取——只收有列出（`visible`）的，也就是 1.4.7 picker 顯示的那三個（沒有 `-contributor`），保持檔案順序；快取缺失或讀不到時退回同一組可見清單。
- **又能認出 muse 1.4.7 的核准提示和「Local work is still active」退出選單（#1798）。**
  - muse 1.4.7 把這兩個畫面的選取游標改畫成 `⟩`，AgEnD 只認 `›` 和 `❯`。所以在 `skip_permissions: false` 時，核准提示會被當成一般工作，而不是等人回應的提示；退出選單也不會擋下訊息遞送，而遞送時送出的 Enter 會選到「Exit anyway」，結束背景工作。
  - 現在 AgEnD 也認得 `⟩`。這是 muse 1.4.7 稽核時發現的；除此之外，1.4.7 對 AgEnD 沒有影響。
- **kiro：恢復的對話不再切換成 instance 自己的 agent，因為有 instance 切換後失去了 AgEnD 的工具（#1800）。**
  - 自 #906 起，AgEnD 會在恢復的 kiro 對話中輸入 `/agent swap`，把它切換成 instance 自己的 agent。有位使用者的 instance 切換後失去了 AgEnD 的工具：無法 `reply`，改用 subagent 繞過也沒有送出任何訊息。
  - 現已暫停這個切換。恢復的對話維持原本儲存時的 agent，並和 #906 之前一樣，從共用的 `.kiro` 檔案取得 AgEnD 的 server 與指示。
  - 已記錄過切換的 instance 會在下次啟動時拿回這些共用設定項目。重啟後請確認 instance 會呼叫 `reply`；預期這樣能讓工具恢復，但 kiro 本身的工具載入沒有經過實機驗證。
  - 新的對話仍以 instance 自己的 agent 啟動。
- **在沒有 D-Bus user bus 的 Linux 主機上，`agend update` 不再一律回滾（#1804）。**
  - 在沒有安裝 `dbus-user-session` 的主機上，`systemctl --user` 可以用，但 `busctl --user` 連不上。過去在這種主機上每次更新都會回滾，訊息是「systemd does not know com.agend.fleet.service」，即使服務其實已載入且正在執行。
  - 現在連不上 bus 時，更新改經由 systemd 的 private socket 詢問——也就是 `systemctl --user` 在這類主機上使用的同一個連線。它讀到的定義和經由 bus 讀到的完全相同，因此重啟前做的檢查也完全一樣，之後照常透過 systemd 重啟。`agend restart` 也一樣。
  - 仍無法證明的情況照樣回滾，訊息會寫出真正的原因：完全連不到 systemd、systemd 不認得這個 unit、systemd 拒絕了請求，或是 unit 啟動的不是新安裝的版本。回滾訊息也不再在只是讀不到的時候，聲稱還原的 unit 沒有載入。
  - user bus 正常的主機行為不變。
  - **這類主機需要手動一次。** 更新到這個版本時，檢查仍由正在執行的舊版本進行，所以從 2.2.0-beta.9 或更早版本更新會再回滾一次。請自行執行 `npm i -g @songsid/agend@beta` 安裝這個版本，再執行 `agend restart`；重啟會使用新的檢查。之後的更新就會正常進行。
- **agent 切換 instance 的 backend 後，不會再留在舊 backend 的模型上（#1808）。**
  - 以前 `update_instance_config` 給了新的 `backend` 卻沒給 `model` 時，會保留 instance 原本的模型。agent 把 instance 從 claude-code 換到 codex，codex 就會以 `--model opus` 重新啟動，之後每一輪都失敗。
  - 現在切換 backend 時，除非有指定，否則會拿掉 instance 自己的模型和推理強度，新的 backend 用它自己的預設（或繼承的 fleet 預設）。
  - 新 backend 不接受的模型會在寫入任何東西之前被拒絕，並列出它可選的模型。它沒有的推理強度也一樣。
  - 「接受」的判斷和 `/backend` 用的是同一條規則：backend 提供的清單（以及 claude-code 認得的名稱）；還沒有清單時，看它常見的模型名稱格式。
- **`agend attach` 現在接受 `agend ls` 顯示的顯示名稱（#1809）。** `agend ls` 顯示易讀的標籤——例如 `稜鏡 Prism`、`Fable 焚穹` 這類 `display_name`，或 `agend-reviewer-t996543` 這類縮短後的真實名稱——但 `agend attach <name>` 只對真實 instance 名稱做比對，因此把表格裡的標籤複製貼上到 attach 時會失敗。`agend attach` 現在會在模糊比對之前，先把標籤解析回真實名稱。真實名稱永遠優先；`稜鏡`（`稜鏡 Prism` 的一部分）這種部分比對仍需輸入完整標籤。
- **設定好的 `effort` 現在會在啟動時傳給 codex、claude-code、grok 和 antigravity（#1811）。**
  - 以前只有 kiro-cli 和 muse 啟動時會帶上它；其他 backend 只是存起來，啟動時沒有傳：在 codex 上用 `/effort` 會重新啟動 instance 卻什麼都沒變，在 claude-code、grok 和 antigravity 上則只維持到下次重新啟動。
  - 現在每次啟動（包括接續對話的啟動）都會傳入：`-c model_reasoning_effort`（codex）、`--effort`（claude-code、antigravity）、`--reasoning-effort`（grok）。
  - 存好的推理強度絕不會讓啟動失敗。只有在已安裝版本的 `--help` 列出這個參數（antigravity 1.0.x 沒有），且等級是那個 CLI 接受的時才會傳。codex 本身不檢查，所以要是模型目錄列出的等級。否則 instance 用 CLI 自己的設定啟動，並在 daemon.log 和紀錄分頁說明原因（不會發聊天通知）。
  - 已經設定 `effort` 的 instance，下次重新啟動後就會用那個等級執行。執行中的 `/effort` 不變。
- **網頁聊天：Markdown 表格不再貼著捲軸，也不再把單字從中間斷開（#1812）。**
  - `.md` 附件預覽中的表格左右兩側留白相同，捲軸不再貼著表格。
  - 表格儲存格內的單字保持完整：「director」不會再被拆成「directo」/「r」。比訊息寬的表格會在自己的框內左右捲動，而不是擠壓欄寬。
  - 表格儲存格裡較長的檔案路徑會在 `/` 之後換行，不會從檔名中間斷開。
  - 聊天訊息、`.md` 預覽與 CSV 預覽中的表格都一樣。
- **聊天 `/update` 失敗時現在會顯示簡短原因並記錄完整輸出（#1818）。** 以前 updater 失敗只會回報「updater exited 1」，沒有其他資訊。現在：(1) updater 的 stdout 與 stderr 透過檔案描述符（非 pipe）直接寫入 `$AGEND_HOME/update.log`，即使啟動 updater 的 fleet 行程已停止，updater 仍可繼續寫入，避免 SIGPIPE 打斷 `agend restart` 或服務安裝等孫行程；若記錄檔無法開啟則照舊靜默執行；(2) `update.log` 超過約 200 KB 時會保留最後 200 KB，模式強制為 0600（僅擁有者可讀，內容為原始輸出，不遮蔽機密）；(3) 失敗訊息包含只從本次執行輸出提取的簡短原因——若有 `npm error code` 行，顯示該行與下一行；否則取最後一個有意義的 `npm ERR!`/`npm error` 行（略過「A complete log of this run can be found in」結尾行）、最後一行 `✗`，或最後一個非空白行——截短至約 300 字元，並遮蔽機密後才顯示於聊天；(4) 訊息結尾附上「Full log: `<路徑>`」。成功、等待中（exit 75）與中斷的路徑不受影響。
- **更新到 beta.11 以上後，agent 會收到投票與網頁身分的通知（#1823、#1827）。**
  - what's-new 通知只在有新的 agent 項目時才送出，而 beta.7 之後就沒有新增項目。所以 `/update` 到 beta.10 或 beta.11 後，執行中的 agent 什麼也沒收到，可能繼續說舊的 AgEnD 版本，續用的 session 也不知道 `reply` 的 `poll` 和 `close_poll`。
  - 現在執行中的 instance 會收到一次通知：`reply` 接受 `poll`（附確切參數）、結果會以一則 `[poll results]` 訊息送來、`close_poll` 可提前結束投票。也會告知網頁聊天的使用者現在帶著他們的 Discord 或 Telegram 使用者 id，僅供辨識。
- **antigravity：設定的推理強度會傳給 agy，而且用的是對的模型；在 AgEnD 的狀態列下也會回答 agy 的信任提示（#1825）。**
  - agy 把 `--help` 印在 stderr，AgEnD 卻只讀 stdout。所以 #1811 的啟動檢查一直找不到 `--effort`：設定的推理強度永遠被略過，探測也沒有快取到任何等級。現在 stdout 是空的時候兩者都會改讀 stderr。
  - agy 的模型清單是每個等級各一個模型（`gemini-3.8-flash-medium`、`…-high`）。當 `--model` 和 `--effort` 對不上、像 "Gemini 3.8 Flash (High)" 這樣的名稱帶任何 `--effort`、或等級不存在時，agy 會改用別的模型，只在畫面上顯示一行警告。所以現在由推理強度選出那個等級的模型（`gemini-3.8-flash-medium` 加 `high` 會以 `gemini-3.8-flash-high` 啟動），`--effort` 不會和 `--model` 一起傳。模型沒有的等級、或 AgEnD 在 agy 清單裡找不到的模型，就用設定的模型啟動、不帶推理強度。daemon.log 和紀錄分頁會說明實際用了哪個模型。fleet.yaml 不會被修改。只要探測時的那個 agy 執行檔還裝著，agy 的模型清單就算超過探測快取的一天也照樣有效，所以跑了好幾天的 fleet 一樣會選對模型。
  - `/effort` 和 `/backend` 列出的是 instance 實際執行的 agy 模型的等級（`gpt-oss-120b-medium` 只有 `medium`）。
  - 在 AgEnD 的狀態列下，agy 的信任提示又會被回答了：狀態列的 `Context 0% used` 會取代 agy 原本那一列的模型名稱。沒有等級的模型（靠右的 `GPT-OSS 120B (Medium)`）也一樣。以前新的工作區會停在這個提示。
  - agy 1.3.5 本身不需要修改：它的行為和 1.3.4 一樣。現有設定裡的模型名稱，不論是代號還是 "(High)" 這類名稱，都照樣用那個模型啟動。
- **fleet 沒在跑時，`agend update` 不再說「已是最新」；聊天的 `/update` 失敗時，已知的幾種原因會附上修法（#1829）。**
  - 目標版本已經裝好、但沒有 fleet 在跑時，更新會先檢查已安裝的套件，再明說：`AgEnD vX is installed but the fleet is not running — run: agend start`，結束碼為 1。例如重新啟動沒做完，或服務停了。以前它會回報成功。已安裝的套件檢查沒過時，改為提示重新安裝。更新本身絕不會自己啟動 fleet。
  - 聊天的 `/update` 失敗時，下列三種已知原因會在最後附上一行 `Fix:`：
    - 安裝被中斷後 npm 無法改名的目錄（`ENOTEMPTY`）：只列出 npm 指名的那個目錄，而且必須是 AgEnD 自己的。
    - 沒有 user bus 的主機上讀不到 systemd 的啟用檢查：`npm i -g @songsid/agend@<目標版本> && agend restart`。
    - 失敗的安裝把 `agend` 移除了：`npm install -g @songsid/agend@<目標版本>`。
- **install.sh 不再安裝已廢棄的 `@songsid/agend-plugin-discord`（#1831）。** Discord 自 PR #134 起已內建於核心套件。提交 81ce9fcb 引入的迴歸意外地將 `@songsid/agend-plugin-discord` 重新加入安裝指令。此指令碼現在只安裝 `@songsid/agend`，若之前的安裝留下了該外掛程式，則會先印出警告再予以移除。
- 靜默排程寫入前會結束上一輪聊天回覆守衛，避免心跳觸發漏回覆通知或要求回覆的提示；結果不確定的投遞仍不會重送。若先前的人類訊息確實漏回覆、且仍在確認視窗或補救階段，也會在靜默排程寫入時結束守衛，留下 info 日誌供追查，不新增聊天通知。
- **codex instance 的 agent 開了 subagent 之後，回覆完不再一直停在 `working`（#1849）。**
  - AgEnD 原本會跟到 subagent 的 transcript；它和 instance 用同一個工作目錄。
  - 結果把 subagent 的工作當成 instance 自己還沒結束的回合：工作中 emoji 不會清掉，10 分鐘後還跳出卡住警告。
  - 現在只跟 instance 自己的 transcript。codex 開 subagent 後 footer 顯示的 `Main [default]`，本來就判讀為閒置。
- **網頁：設定與「等你處理」的說明改成正確的內容（#1854）。**
  - 沒有設定卡住逾時時，設定頁與卡住通知顯示 10 分鐘（偵測器實際的預設），不再是 15。
  - 設定說明把儀表板自己的設定歸在「網頁」，不是「一般」。
  - 存取提示指向「連線」。
  - 需要 fleet 管理員確認的變更，改說在聊天（General topic）或主機上確認。
  - 公開連結的提示不再說「不公開 preview」：除非 `web.preview_on_public_link` 設為 false，預覽會另開一條臨時通道。
  - 「等你處理」空白時不再保證會出現在 Discord；沒有聊天 app 的 fleet 只會說會出現在這裡。
- `/web` 的本機登入私訊不再顯示「連結期限：本機網路」。本機私訊縮為三行，公開私訊另列出以 fleet 時區顯示的實際到期時間；兩者都保留五分鐘內單次使用的登入碼、獨立登入碼訊息與撤銷提醒。
- **在沒有瀏覽器開啟程式的機器上，`agend web` 和 `agend view` 不再當掉（#1854）。**
  - 在沒有 `xdg-open` 的伺服器或 WSL 上，這兩個指令以前會在印出連結後立刻當掉。
  - 現在只會多印一行說明無法開啟瀏覽器；已印出的登入頁和登入碼照常可用。
- **codex：恢復的閒置 session 不會再整段 hang 期間都顯示「處理中」。** 恢復後的 codex 有時畫出不含 Context 項目的底列。如果它自己的 rollout 沒有進行中的回合，空的輸入框也一直沒變，下一次安全巡檢約一分鐘內就會判為閒置；以前要等 15 分鐘的 stuck 期限，訊息也會排隊等到那時。(#1865)
- **網頁：View 的終端畫面重新貼合視窗（#1869）。**
  - 在填滿（預設）模式下，寬的窗格不再被 12 px 的下限撐到超出視窗；字級不會大於放得下的大小，最小 6 px。
  - 視窗稍微縮小時，字也一定跟著縮小。
  - 在聊天或其他頁面選小／中／大，不再關掉 View 的填滿；只有 View 自己的**字級**按鈕會。
  - 先前因此被關掉填滿的裝置，會恢復一次填滿。
- **macOS：從 Agent 工作階段裡執行更新，不會再讓 fleet 停住。** 在 launchd 上，`agend restart` 和 `agend update` 會先停掉 fleet，再重新啟動。如果指令是在 Agent 的工作階段裡執行，fleet 停下時會連同那個 Agent 一起被結束，第二步就沒有執行：fleet 一直停著，也沒有任何訊息。現在這類指令會改在背景繼續執行，輸出寫到 `~/.agend/service-activation.log`。中斷的更新用 `agend start` 救回之後，`agend restart` 以前每次都會拒絕；現在會重新啟動 launchd 正在執行的那個工作。(#1871)
- **設定：`web.access` 會有警告，「/web 已停用」會說 Fleet 管理員要設在哪裡（#1874）。**
  - 誰能用 `/web`、`/update`、`/doctor`，看的是 Fleet 管理員名單：bot 的 channel 底下的 `access.allowed_users`。沒有 `web.access` 這個設定。
  - `agend validate` 現在會對 `web.access` 提出警告，說明名單實際要設在哪裡；`web` 底下其他不認得的鍵也會警告。以前這些鍵都被默默忽略。
  - 名單空白時，`/web` 與 `/update` 的回覆會指出確切的鍵，例如 `channel.access.allowed_users` 或 `channels[id: main].access.allowed_users`。
- **`/login` 安裝完成後的檢查不再讓整個 fleet 停住（#1877）。** 安裝後，AgEnD 會開一個登入 shell 查新 CLI 的位置。如果登入設定檔在背景啟動了程式，這個檢查可能卡住 10 秒，整個 fleet 也跟著停：收不到訊息、無法投遞、也不送 systemd 看門狗訊號。現在檢查改在背景執行，shell 一結束就收尾。如果 shell 超過時限、輸出過多，或結束後還有程式佔著它的輸出，這次檢查啟動的程式會一併停止。
- **漏送的 systemd 看門狗訊號現在會記錄下來。** 如果 AgEnD 因為 `fleet.pid` 記的是別的行程而沒送，或 `systemd-notify` 執行失敗，fleet 日誌會寫明（每 10 分鐘最多一次）。以前訊號只是默默停掉，systemd 重啟時看不出原因。
- Discord quickstart 現在會從新的伺服器訊息或 bot 私訊偵測帳號，請你確認使用者名稱與 ID。偵測最多 30 秒，手動備用輸入也必填並驗證。網頁設定與新增連線同樣必須填入有效管理員 ID，避免設定完成卻留下空白或格式錯誤的第一個存取名單項目。既有名單不變；網頁 Discord 偵測留待後續處理。
- **Linux：用系統 unit 執行的 root fleet，從 2.1 更新後會真的換成 2.2。** 有 `/etc/systemd/system/agend.service` 的主機，以前會裝好 2.2 卻繼續執行 2.1，因為 `agend restart` 拒絕了 unit 裡舊的啟動指令。現在更新會像處理使用者 unit 一樣，把那個 unit 的 `ExecStart` 指向新安裝，其他每一行都不動。(#1884)
- **用量面板：Antigravity（agy）那列重新顯示 Gemini 額度。** agy 改成以具名群組（「Gemini models」、「Claude and GPT models」）回報額度，各有五小時與每週上限，面板卻只剩 Claude 與其他模型那兩項。現在依群組彙整，顯示 Gemini 與 Claude 與其他模型的 Session 和每週額度；舊的回應格式顯示不變。(#1898)
- **Linux 上的 agy instance 重新拿到 fleet 指令（#1914）。** AgEnD 原本把指令寫到 `.agents/agents.md`，但 agy 讀的是 `.agents/AGENTS.md`；在區分大小寫的檔案系統上它從來沒讀到（macOS 預設不分大小寫，兩個檔名是同一個檔，所以在 Mac 上沒有問題）。
  - 現在改寫到 `.agents/AGENTS.md`。只有舊的 `.agents/agents.md` 時，會改名成新檔名，你自己加的內容都會保留。
  - 如果你已經有自己的 `.agents/AGENTS.md`，會原封不動；只有 AgEnD 自己的區塊會從舊檔移出。改名時絕不覆蓋新檔名上已有的任何東西，包括同一時間剛建立的檔案。
  - 如果 `.agents/AGENTS.md` 是指向不存在檔案的符號連結，AgEnD 會保留它、不寫入指令，並在啟動時告訴你。
- **壓縮不會再清空 agy 的對話（#1915）。** 在 agy 上，AgEnD 的壓縮（網頁聊天的「壓縮」按鈕和 `/compact`）送出的是 `/clear`，會把整段對話清掉，而不是壓縮。
  - 現在改送 agy 自己的 `/compact`，會在原地摘要對話（已在 agy 1.3.6 驗證）。
  - 已知版本低於 1.3.6 的 agy 會被拒絕，什麼都不送出，並提示更新 agy。
- **從網頁對話送給 kiro 的 `/compact` 現在會說明何時結束（#1925）。** 在 kiro 的 classic 介面與 TUI 的 V2 引擎上，卡片會跟著 instance 自己的窗格：顯示**對話已壓縮**，或說明 kiro 沒有壓縮對話，原因是對話太短或壓縮被中止。在 TUI 上，「已壓縮」的意思是 kiro 的「Compacting conversation...」那一行出現後又消失了；除了「太短」之外的失敗分辨不出來。kiro 的 V3 引擎仍然會說明無法偵測壓縮何時完成。
- **kiro 文件不再說 instance 的 agent 不載入 steering（#1925）。** kiro 會替每個 agent 載入 `.kiro/steering`，即使 agent 設成 `resources: []` 也一樣，所以新對話也會讀到目錄裡的 steering 檔案。
- **穩定版推出後，beta 使用者又能收到較新 beta 的通知。** 2.2.0 推出、beta 線是 beta.17 時，beta.16 的安裝完全收不到更新通知：較新的穩定版成了通知的目標，又因為「同一版號線」被略過，連帶 beta.17 也沒有通知。現在 beta 安裝的通知只看 beta 線，beta 使用者會留在 beta 線。已有同版號線穩定版時，alpha 安裝仍會收到較新 alpha 的通知。(#1926)
- 依實作更新英文與繁體中文的 2.2 升級／功能指南、README、指令／設定參考及目前版本重點，釐清網頁私送登入、ClassicBot 准入、私有 Node、投遞證據、記憶體保護、credential profile 與 Kiro 恢復。較早的 2.2 fragment 也改為最終行為；版本 changelog 另由發布流程彙整。
- npm 套件描述與搜尋關鍵字改為列出 Muse，不再宣傳已移除的 Gemini 後端。
- 修正英文／繁體中文網站的設定、安裝與功能頁，使其符合目前 2.2 行為，包括 Discord 管理員偵測、支援主機與網頁私送登入；同步修正 repo 安全及外掛／開發參考，對齊目前 API 與授權檢查。
- 將繁體中文 CLI 參考的 `/web` 別名列恢復為文件文案檢查要求的表格格式。指令名稱、別名與行為不變。
- **CI：改到文件的 PR 現在會跑測試。** 測試會讀 `docs/` 裡的檔案和根目錄的 README，所以只改文件、卻動到測試釘住的那一列的 PR，可能在 test shards 被跳過的情況下合併（#1929 就這樣讓 main 變紅）。現在只有僅改動 `changes/` 片段的 PR 才會跳過測試。(#1932)

### 安全 (Security)
- **補上幾個沒有足夠權限也能操作 instance 的漏洞（#754、#1148）。** 逐一稽核每個頻道上「誰能執行什麼」，找到並修好以下幾項：
  - **⏹ 取消按鈕**：以前任何人點都能中斷 instance；現在只有該 instance 的 bot 允許在這個 topic 發言的人、而且只能按該 instance 自己的按鈕。
  - **Telegram `/raw <文字>`**（直接打進 CLI）：以前 topic 裡能發言的人都能用；現在需要該 topic 所屬 bot 的 fleet 管理員。
  - **Telegram fleet topic 的 `/collab`、`/compact`、`/save`**：以前沒有管理員檢查；現在和 Discord 一樣需要 fleet 管理員。
  - **進階小提示解鎖按鈕**：以前任何人點都會改掉整個 fleet 的設定；現在和 `/tips advanced on` 一樣需要 fleet 管理員。
  - **`/model`、`/effort` 選單**：點選時會再確認你仍是管理員、而且是透過同一個 bot 點的。
  - **從 General 下 `/pause`、`/wake`**：以前能動到別的 bot 的 instance；現在只能動到該 bot 自己的。
  - **需要 fleet 管理員的 slash 指令**（例如 `/update`、`/restart`）：以前能從別的 Discord 伺服器裡的 ClassicBot 頻道執行；現在只能在 fleet 自己的伺服器執行。
- `docs/commands.md` 補充說明：ClassicBot 的 `admin_users` 是所有 bot 共用的一份名單。
- **「誰是 fleet 管理員」在每個平台都由同一條規則決定（#754、#1148）。**
  - 以指令所作用對象的擁有 bot 判斷（該 instance 或 General 所屬的 bot），而不是指令從哪個 bot 進來。在同一個 fleet 裡另一個 bot 擁有的頻道下 Discord slash 指令，現在會被拒絕，請改用那個 bot 的指令。
  - `allowed_users` 為空代表沒有人；對應不到任何已設定頻道的 bot id 也代表沒有人，以前會退回去用第一個頻道的名單。
  - Telegram 的文字指令現在和 Discord slash 指令依同一張指令表判斷，同一個指令在兩個平台需要相同的權限。
  - 在 Telegram ClassicBot 對話中，該 bot 的 fleet 管理員現在也能用 `/pause`、`/wake`、`/compact`、`/save`，和 Discord 一樣；`/stop`、`/raw`、群組 `/start` 仍只限 ClassicBot 管理員。
- **Dashboard 不再依賴 Server-Sent Events。** 即時串流 15 秒沒有任何訊息或一直失敗時，頁面改為每 5 秒用 `GET /ui/poll` 取得相同的狀態與聊天訊息，串流恢復後再切回去。輪詢與串流使用同一個 `<boot>-<id>` 游標，所以兩者交替時不會重複也不會漏訊息，fleet 重啟後也一樣。（Cloudflare Quick Tunnel 不支援 SSE，會緩衝串流的 proxy 看起來就像從不送資料的伺服器。）
- **Dashboard 不再從 Google 載入字型，每個面板都帶 `Content-Security-Policy`**，把 script、樣式、圖片、字型與連線都限制在本站（`connect-src 'self'`），即使頁面上真的跑了不該跑的 script，也無法把讀到的內容送到別的伺服器。
- **三個網頁面板共用同一條導覽列與 Session 選單，`/` 直接開 dashboard。** `/ui`、`/view`、`/settings` 都有相同的「Dashboard · View · Settings」連結與 Session 按鈕：顯示目前以哪個瀏覽器登入、session 何時結束、其他已登入的裝置（各自可登出）以及「全部登出」。只是一支小 script 與樣式表（`/assets/shell.js`、`/assets/shell.css`），不是重寫面板。
- **網頁面板上只會執行頁面自己的 inline script（#1268）。** `script-src` 不再允許 `'unsafe-inline'`：每個面板自己的 script 會帶一個每次回應都不同的 nonce，dashboard 的按鈕也不再使用 `onclick=` 屬性（改由一個 listener 執行 `data-act` 指定、而且在固定清單裡的動作）。被注入到頁面的標記（例如 `onerror=` 或 `<script>`）不會再執行。
- **……也只會套用頁面自己的 inline 樣式（#1300）。** `style-src` 也不再允許 `'unsafe-inline'`：每個面板的 `<style>` 區塊帶著同一個每次回應都不同的 nonce，而且所有面板都不再有 `style="…"` 屬性（dashboard 的已在 #1307 移除，/view 與 /settings 的在這次移除；即時終端的顏色與用量條改用 style 物件設定）。被注入的標記無法加上自己的 inline 樣式（但仍可能套用頁面既有的 class）。web terminal 維持它自己的政策。
- **沒人操作的頁面不再讓網頁 session 一直有效（#1373）。** Session 在閒置達設定時間後結束（預設值見 #1670）；頁面自己定時發出的讀取不再
  算作使用。在 `web.view_access: session` 時，開著的 `/view`（終端每 0.8 秒、名單每 5 秒、用量面板每分鐘）過去會讓
  session 一直有效到 session 的時長上限，dashboard 的即時串流每次被瀏覽器重新連線也會算一次。這些讀取仍會完整檢查授權；只有
  打開頁面、讀取聊天紀錄，以及你做的任何變更才算使用。這份清單固定在伺服器端，頁面無法自行宣稱。
- 敏感 web Settings 變更現在需要所屬 General 的 fleet admin 以綁定 nonce 的按鈕確認；chat 不可用時，須由同使用者的 host 明確確認（#1423）。存取名單、憑證、channel 目的地／順序及控制類設定最多 pending 五分鐘；遮蔽 diff 會列出實際 IDs 與角色。一般設定仍可直接套用。實際 job／啟動延續帶有授權與快照 fence、共用資源 lease 及條件式 rollback。SetupHost 也必須先取得 host consent 才寫入，並在交接前另行確認 finish。
- **POST /agent：instance token 現在在讀取請求 body 之前就先驗證。** 之前端點會先完整讀取 body 再檢查認證，讓任何本機 process 都能用一個大型未認證請求耗盡 daemon 記憶體。現在 `X-Agend-Instance-Token` header 攜帶 `<instance>:<token>`，在呼叫 `readBoundedWebBody` 之前就驗證；缺少或錯誤的 token 直接回傳 401，不碰 body。超過 512 KiB 的 body 回傳 413（與 web API 相同的限制）。`agend-agent` 已更新為傳送新的 header 格式。(#1489)
- 設定頁不再把 fleet.yaml 裡手寫的 inline 憑證讀出來（#1490）：`GET /api/settings/fleet` 與 `/api/settings/fleet/raw` 會把手寫的 `bot_token`（以及任何名為 `token`、`secret`、`password`、`api_key`、`web_token` 的鍵）顯示為 `[configured - redacted]`，表示已設定。依這份讀取結果送出的儲存會帶回這個佔位值，伺服器會保留原本存的值：連線依 id 對應，instance 與 defaults 依路徑對應。只有在憑證類鍵下才會把它當成佔位值，其他欄位裡的同樣文字一律視為一般字串。若佔位值背後沒有已存的憑證，或對應的連線 id 有兩條連線共用，請求會以 400 拒絕，fleet.yaml 不會被改動。
- **Settings 確認依受影響 bot 的權限判定：** chat 確認需要每個既有目標連線的
  admin 資格；按鈕出現在另一個 General，不會讓該 bot 的 admin 取得確認權限。
  Fleet 層級與新增連線維持設定中 primary General 的 admin 授權；混合變更需要
  同時滿足兩者，共用 token 也包含所有使用它的連線。跨平台或目標不明時，
  在 host 執行 `agend settings confirm <id>`。網頁 pending／重試與首次 Setup
  的 host 確認流程仍可使用。 (#1490)
- **Settings 的確認流程不再能透過「立即生效」設定的子欄位繞過（#1490）。**
  - 把敏感欄位放進立即生效設定的物件裡（例如 `persona: { bot_token: … }` 或 `persona: { allowed_users: … }`），原本會跳過管理員確認。
  - 現在這類欄位與其他密鑰或存取變更一樣需要確認；未知欄位會被拒絕。
  - 只有 `status_emojis` 與 `hang_detector` 的已知子欄位仍可不經確認立即生效。
- **在 Settings 儲存連線時只會寫入連線欄位（#1490）。**
  - `PUT /api/settings/fleet/channels` 會拒絕 Settings 不負責的欄位，例如內嵌的 `bot_token`、未知的 option 或未知的 access 欄位。
  - 手動加在 fleet.yaml 裡的欄位仍會原樣保留。
- **網頁登入與設定頁的強化（#1490）：**
  - 在本機自己的 dashboard 上，過期的 `__Host-agend_session` cookie 不會再遮住有效的 `agend_session`：之前一個已結束的安全 session，會讓已登入的瀏覽器看起來像是登出了。寫入動作會以實際登入的那個 session 來檢查。公開連結仍然只接受它自己的 `__Host-` cookie。
  - 頁面在你等待時會輪詢套用進度（包括 token 和綁定的套用），最多 10 分鐘；這種輪詢不再算作活動，所以不會讓閒置的 session 一直延長（#1373）。
  - `agend setup` 的頁面現在會送出 Content-Security-Policy，只允許它自己的 inline script 和 style（每次回應都用新的 nonce），並加上 `X-Frame-Options: DENY`，其他網站無法用 frame 嵌入它。
- **Settings 密鑰端點：公開連結（gateway）session 一律回傳 403。** 六個負責寫入或驗證連線 token/密鑰的端點（`/secrets/:id/verify`、`/secrets/:id/apply`、`/connections/:id/secret/verify`、`/connections/:id/secret/apply`、`/connections/:id/binding/verify`、`/connections/:id/binding/apply`），以及接收原始 bot token 的 quickstart probe 端點，現在在公開連結 session（`surface: "gateway"`）呼叫時回傳 403。本機 dashboard session 不受影響。(#1519)
- **文件：`create_instance` 和 `update_instance_config` 的權限邊界分開描述。** `tool_set` 和 `skipPermissions` 只能透過 Settings 或 `fleet.yaml` 設定。`update_instance_config` 明確拒絕 `tool_set`；`skipPermissions` 不是接受的欄位（Zod 會剝除它）。`create_instance` 明確拒絕這兩個欄位。(#1519)
- **網頁 app：面板的安全政策不會再無聲地少掉 script nonce 或圖片來源（#1527）。** 每個面板送出的政策現在是延伸基礎政策中的完整指令；若缺少其中一條，AgEnD 會拒絕啟動，而不是送出 script 或 Discord emoji 圖片都會被擋下的頁面。
- **網頁：公開連結無法再變更整個 fleet 的側欄排序（#1665）。** 雖然頁面已不再使用 `POST /api/sort-order`，它仍可透過臨時公開連結呼叫。現在它已從公開連結的路由清單移除，處理程式在那裡也會拒絕（403）。讀取排序不受影響。
- **網頁：無法再透過臨時公開連結建立或刪除 team（#1689）。** 與設定不同，`POST /ui/teams` 和 `DELETE /ui/teams/<name>` 原本開放給公開連結的工作階段使用。現在兩者都已從公開連結的路由清單移除，處理程式在那裡也會拒絕（403）。新的 team 編輯也同樣會被拒絕。透過公開連結仍可檢視 team。
- **網頁：公開連結不能再新增、編輯或刪除排程（#1724）。** 排程會以訊息形式傳給 agent，因此與團隊（#1689）相同，公開連結上不提供這些路由，伺服器也會拒絕。公開連結仍可檢視排程清單。

## [2.1.12] - 2026-10-08

### Fixed
- **Fleet 的 stall 警告會列出慢同步 caller 與 GC 停頓（#1235，PR-A）。** 用 monotonic 時間、固定容量
  記錄已包裝呼叫中至少 50ms 的工作，以及同一觀測窗口內至少 200ms 的 GC 停頓。不改排程或投遞行為；
  未觀測到的原因仍標為 unknown。

### 升級注意事項 (Upgrade Notes)
- **[移除] `gemini-cli` backend（#1280）。** 它先前已標為 deprecated，警告上寫的停用日期也已經過了。改用 `backend: antigravity`：同樣是 Google 登入，透過 agy。仍寫著 `gemini-cli` 的設定現在會被拒絕、不會照跑，不論是寫在 instance、fleet 預設值，還是 ClassicBot 的頻道或預設值：
  - **`agend validate`** 與 Settings 會報錯，指出是哪個 instance，並說明請設定 `backend: antigravity`。仍含有它的 fleet.yaml 重新載入會整份被拒絕，並附上這則訊息。
  - **`agend update` 之後**，fleet 照常啟動。只有那個 instance 不會啟動：它的頻道會收到通知，說明原因和該怎麼設定，而且不會自動重試。其他 instance 都正常啟動。AgEnD 絕不會自行換上別的 backend：要讓 instance 改用哪個 CLI、哪個帳號，由你決定。
  - `/login gemini-cli` 與 `agend backend doctor gemini-cli` 也會給同樣的說明，而不是安裝或檢查它。只用來預先信任 Gemini CLI 資料夾的 `agend backend trust` 已移除。

### 新增 (Added)
- **Agent 之間的訊息在主題中顯示多少：full、summary 或 hidden（#1302）。** 跨 instance 的訊息會貼到各 instance 的主題讓人跟著看，Fleet 一忙就會淹沒對話。現在由 `cross_instance_visibility` 決定：`full`（預設，與以往完全相同）、`summary`（同樣的貼文，每則一行：誰傳給誰，加上任務摘要或訊息開頭）或 `hidden`（不貼）。可在 `defaults` 設定整個 fleet、用新的 Fleet 管理員指令 `/visibility full|summary|hidden`（Telegram General topic 與 Discord，存入 `fleet.yaml`），或在 Settings 設定；Settings 另有每個 agent 的覆寫。每個主題依自己的 instance 而定，變更立即生效。訊息送達、Mirror Topic 與 General 在任何模式下都不受影響。
- **新增 alpha 頻道，與 beta、穩定版分開（#1259）。** `vX.Y.Z-alpha.N` tag 現在發布到 npm `@alpha`。以前所有不含 `-beta` 的 tag 都進 `@latest`，第一個 2.2 alpha 會被所有穩定版使用者裝到。發布 workflow 現在嚴格對應：`vX.Y.Z` → `@latest`、`-beta.N` → `@beta`、`-alpha.N` → `@alpha`。其他 tag 會在建置前就失敗，`@latest` 也不會往回移。客戶端的 `agend update`（以及聊天的 `/update`）會讓 alpha 安裝留在 `@alpha`。新增 `agend update --alpha`。「有新版本」通知會告訴 alpha 較新的 alpha 與穩定版，不會提到 beta。beta 與穩定版的行為不變。舊的手動 `scripts/publish.sh` 已移除：發版就是推 tag。
- **額度重置券最快到期的日期，顯示在券那一行（#1232、#1244）。** Codex 的「額度重置券: 2 可用」現在會標出這些券中最早到期的那張——「額度重置券: 2 可用 · 🎫 最近過期：10/22（16d6h 後）」——`/usage`、View 用量面板與 `get_usage` 的文字都有，資料取自 Codex 自己的券清單（該 metric 的 `expiresAt`）。沒有到期日的券不計；全都沒有時，照舊只顯示張數。這是到期、不是重置：沒用掉的券就沒了。（2.1.12-beta.2 在 #1232 加的每個 backend 一行「⏳ 下次重置」是誤解了需求，已移除，`nextResetAt` 也一併拿掉；各 window 仍各自顯示「X 後重置」。）
- **Agent 可以在 Discord 與 Telegram 傳貼圖（#1226）。** 三個工具，兩個平台用法相同：`list_stickers`（每張 `{ id, name, emoji_or_tags, format }`，不附圖片網址）、`preview_stickers`（最多 8 張，下載給 agent 讀圖；沒有靜態圖的動畫貼圖標 `preview_unavailable`），以及 `reply` 新增的 `stickers` 欄位（最多 3 張；有貼圖時 `text` 可省略）。底層依平台各自處理：Discord 只列 instance 自己頻道所在伺服器的貼圖（別的伺服器的傳不出去），並跟文字放在同一則訊息送出；Telegram 列出貼圖包——在呼叫時指定，或用連線設定的 `options.sticker_sets`——先送文字，再依序送每張貼圖。所有貼圖都在送出任何東西之前檢查，傳不出去的會回錯誤，不會變成一則悄悄少了貼圖的回覆。agent CLI 也有：`agend-agent stickers`、`sticker-preview`，以及 `reply … --sticker <id>`。
- **Codex capacity 偵測硬化：不怕 glyph 換、不吃 scrollback（#1215）。** capacity 那行必須是 live transcript item（composer 上方最後一則、之後沒有更新的）——arm 跟 accept 都檢查；引用或 scrollback 只通知使用者、不注入。capacity pattern 不再接受 box-drawing chrome（`│ …` popup／表格列也是 `So`）；quota、rate-limit、auth 共用一個 `CODEX_STATUS_GLYPH` 常數，下次 glyph 再變不會像 #1208 那樣靜默壞掉；occurrence counting 合成同一個。nudge 改說「沒做完才繼續」。pane 仍是 capacity 權威；session-store seam 仍只觀測。
- **被打斷的回合在 CLI 自己沒接手時會跨重啟續接（#1209）。** channel 回合 armed 時 daemon 寫一次性 `in-flight-turn.json`
  marker（含 TurnFingerprint checkpoint）；重啟後還留著的，by construction 就是被打斷的回合。開機＋CLI spawn 後純 gate 只判一次：
  crash-loop 開機保持乾淨（#835）、取消過的不續（cancel 會刪 marker，#1199）、durable outbox 還在處理的投遞留給那條路、seam verdict
  排除雙重驅動——CLI 已 re-engage 或對話已切換就跳過，unknown 在 flush grace 內等一次（之後拒絕），只有 grace 之外確定的 quiet
  才重注一個綁原 correlation 的 bounded continuation（絕不是重貼）。marker 先消費再 gate，第二次開機不會重複；完成路徑經 reply
  guard 清掉它，已投遞的回覆在 idle edge 之前就清，續接訊息自己不再 arm（真正 episode-once）。grace 等待中遇到 cancel、stop、
  pause 或 respawn 會讓 gate 過期、不再注入。沒有 seam reader 的 backend 判 unknown、永遠不續。
- **跨重啟回合判斷的統一偵測訊號 seam（#1209、#1217a、#1210、#1215）。** 新增唯讀觀測層（`src/backend/session-signals.ts`）：
  各 backend 在 CLI 自己的 store 發現工作目錄 session 的 `TurnFingerprint` reader——claude-code（project 內最新 transcript＋最新有
  timestamp 的 tail 條目；tail 本身通常是沒有 timestamp 的 bookkeeping）、codex（唯讀開啟 `state_5.sqlite` 找 exact-cwd thread＋
  rollout tail）、muse（依 cwd 比對 session＋`recorded_at`），以及 backend-agnostic 的 `compareFingerprints` checkpoint 比對，
  回 `reengaged`／`quiet`／`unknown`。只有 TURN 才算：turn-kind filter 讓 bookkeeping 寫入（cost-state tail、token-count frame、
  workspace-branch observation、單純 mtime 變動）不會被當成 re-engagement。daemon 自己的寫入在 mtime 與 tail 兩條路徑都會被排除
 （tail 另加 2 秒 skew，吸收 entry-ts 與 flush-mtime 的先後顛倒）；session id 變了算 reengaged；daemon 寫入後 10 秒 flush grace
  內不回 `quiet`、改回 `unknown`（剛 re-engage、還沒 flush 的 CLI 短暫看起來像 quiet）。`readinessFromStore` 永遠回 `unknown`：
  pane 仍是 idle/busy 權威，既有偵測完全不受影響。kiro-classic schema 覆蓋另排。讀取都是同步 I/O——請在 fleet event loop 之外
  解析 fingerprint，絕不在 tool handler 內呼叫。殘留風險（by design、有界）：比對之後才 flush 的 engagement 由下一次 checkpoint
  比對抓到，本層絕不捏造。
- **ClassicBot 頻道可以跑在第二組訂閱上（#1220）。** `classicBot.yaml` 的頻道現在接受 `backend_options.<backend>.credential_profile`，
  跟 `fleet.yaml` instance 一樣——例如讓 classic codex bot 用 `credential_profile: personal`。該頻道的 agent 會用那個 profile 啟動，
  `get_usage` / `/usage` 把它算在那組訂閱的列（`Codex (personal)`），`kiro_engine_status` 也會顯示。以前這個設定會被靜默丟掉，
  每個 classic 頻道都被算在共用登入上。空值或 `null` 表示共用登入（即使 fleet defaults 有設 profile 也一樣）；AgEnD 無法使用的 profile 名稱
  會讓該頻道的 agent 不啟動，而不是改用其他登入跑。只有 `codex` 與 `kiro-cli` 支援 profile，其他 backend 會提出警告並忽略。
  不論在 `classicBot.yaml` 或它繼承的 fleet defaults 改了 profile（下次輪詢或 reload 時），都會重啟該頻道的 agent——kiro 會開新對話
  （另一組訂閱有另一套對話），跟 fleet instance 相同。

### 變更 (Changed)
- **文件：已發佈的 2.1.10 與 2.1.11 有了自己的 CHANGELOG 段落（#1295）。** 這些條目原本一直留在「未發佈」；現在每一條都歸到第一個包含其新增 commit 的版本 tag 底下，升級注意事項一併搬移，`docs/development.md` 也把切出版本段落列為發版步驟。
- **文件：退役 `wiki/`，`docs/` 成為唯一來源（#1279）。** 仍有用的頁面依目前程式碼改寫後，併入 `docs/development.md`（發佈與 CI、發佈說明寫法）與 `docs/design/` 的四份新文件（頻道投遞、ClassicBot 回覆路由、指令權限、記憶分層）；其餘刪除，保留在 git 歷史。五份已被取代的文件移到 `docs/archive/`，開頭註明由哪份文件取代；`docs/design/` 各份筆記的狀態列也已更新為實際上線的狀況。
- **`list_emojis` 變輕了（#1226）。** 伺服器 emoji 預設不再附圖片網址（要的話設 `with_image_urls`；想看圖用 `preview_emojis`），並可用 `name`、`limit`、`primary_only` 縮小清單——在 emoji 很多的伺服器上，一次呼叫原本要花約 1 萬字的 context，而 agent 只需要一個 emoji。emoji 與貼圖工具的呼叫改用共用的 30 秒時限，不再是固定 10 秒，一次下載多張圖的預覽不會被中途切掉。

### 修正 (Fixed)
- **閒置後的第一個 Discord slash 回應會重用既有連線（#1235）。** discord.js REST 管理器現在使用專屬的 undici agent，keep-alive 60 秒（undici 預設只有 4 秒，所以閒置後的第一個 `deferReply` 都要重新 TLS 握手）。60 秒是伺服器沒有送 Keep-Alive 提示時的閒置 fallback；有提示就依提示。所有 Discord adapter 共用一個 dispatcher、跟著程序走、永不關閉——跟以前的全域 dispatcher 一樣（以前停 adapter 也不關）。只影響這個 adapter 自己的 REST 管理器——全域 dispatcher 不動，proxy 行為也不變（本來就沒有 `HTTPS_PROXY` 處理，之後也沒有）。每次 acknowledgement 也都會在 debug 等級記錄 delivery／REST 的時間拆分，即使沒超過慢速門檻，也能比較 cold 與重用連線的延遲。
- **登出狀態的 agy 與 muse 會被辨識；agy 的推理強度以 binary 為準（#1328）。** 來自 2026-10-07 的 CLI 版本稽核（agy 1.3.1、muse 1.4.3）：登出的 agy 現在會被回報為需要登入（它的畫面「You are currently not signed in. / Select login method:」以前從未被比對到；舊的字樣只會出現在 agy 的 log 檔）。登出的 muse 1.4.3（「Log in with browser / Set an API key」）不再被當成已就緒，選單會被保留、訊息暫停送出，直到有人登入。agy 的推理強度改從它自己的 `--help` 讀取（1.3.1 提供 xhigh 與 max），讀不到時退回 low/medium/high；`--help` 暫時讀不到時，只有同一個 agy 版本才沿用先前的等級，且不超過 24 小時的 CLI env 快取。
- **工作中的 agy 會被看成工作中；它的信任提示只在游標確認時才回答（#1328）。** 來自已登入的 agy 1.3.1：agy 工作中的那一列是點字 spinner、動詞加省略號（`⣯  Generating...`），沒有計時、也沒有 `(esc to cancel)`；AgEnD 的比對從未命中，所以工作中的 agy 一直被看成閒置。現在這一列（以及 agy 顯示在同一位置的思考摘要）會算成忙碌，但只限 agy 自己的位置：最左欄、緊貼在輸入框上方；回覆裡引用這一列不會讓已結束的回合變成忙碌。信任提示（「Do you trust the contents of this project?」／「> Yes, I trust this folder」／「No, exit」）只在游標停在「Yes」時送一次 Enter；游標在其他地方，或送了 Enter 之後提示仍在，就保留給人處理、訊息暫停送出。對話中引用的提示副本不會被回答。
- **相對的 `systemPrompt`／`workflow` `file:` 路徑以 instance 的工作目錄為準（#1314）。** 以前是以 fleet 程序的目前目錄為基準：安裝的服務下是 `~/.agend`，手動執行 `agend fleet start` 時是 shell 所在目錄。所以同一份 fleet.yaml 可能依啟動方式讀到別的檔案或讀不到，而找不到檔案時指令會被悄悄丟掉。現在：`~/` 與絕對路徑照原樣使用，其餘以 instance 的 `working_directory` 為基準。保留一個版本的相容：只在舊位置找得到的檔案仍會使用，並發出列出兩個路徑的警告，且在該 instance 的主題通知一次。找不到、讀不到、超過 256 KiB，或不是一般檔案（FIFO 或裝置，開啟時不會阻塞）的檔案會記錄路徑與錯誤，絕不記錄內容；`~name/`（其他使用者的家目錄）會被拒絕。設定驗證會對找不到檔案的參照發出警告。`systemPrompt` 只有在某個部分是 `file:` 參照時才以逗號切分：像「You are Kuro, a careful reviewer」這樣的行內提示會維持一段（以前會被拆成兩段）。
- **新實例用短的唯一名稱；使用者看到的地方不再有 19 位數字 id（#1301）。** 新實例一律是 `<base>-t<topic 尾 6 碼>`（撞名就加長，最長到完整 id），fleet.yaml、實例目錄、tmux 視窗都一樣；既有實例完全不動、不改名不遷移。重用已被佔用的名稱時，必須證明它屬於同一個 topic（完整 `topic_id` 字串相等，有記錄時再加 adapter/world 比對；完整名與短名、加長名都檢查，rebind 不會開出重複項目）；屬於不同 topic 的名稱絕不覆寫——連完整名都被別的 topic 佔用時，直接拒絕建立並提示換 `topic_name`，所以分配出的名稱永遠是孤兒清理認得的 `-t<數字>` 形狀。只有目錄、沒有設定的碰撞永遠不算同 topic。顯示標籤優先用 `display_name`，否則把 19 碼以上的 `-t<數字>` 字尾縮到剩尾 6 碼——但只在該短標籤全艦唯一時才縮；撞名就把顯示的尾碼加長到可區分為止（舊名、新名、display_name 共用同一個命名空間），通知、Mirror、廣播、`/status`、`agend ls` 表格同尾碼的實例仍可區分。rollback 刪 topic 時走當初建立的那個 adapter/world。agent 用的名稱（`[from:…]`、log、查詢、`list_instances`、`--json`/`--names-only`）維持全名。孤兒偵測兩種格式都認得。
- **更新設定與維運文件（#1278）。** 中英設定文件改為現行的 backend 原生指令檔、啟動時 decisions 快照、帳號 profile 差異、預設值／工具數，以及只監測的 context guardian。修正 macOS 記憶體僅供觀測、診斷、測試／build 隔離、互動狀態術語與卡住處置，並修好中文 CLI 的 templates 連結。純文件，執行行為不變。
- **設定 → Defaults 語言選單：存任何不相關的設定時不再把語言釘死成英文（#1310）。** 語言 `<select>` 沒有「未設定」選項，因此 `defaults.locale` 未設定時，選單會落到第一個選項（en）。存任何設定——哪怕只是改 log_level——都會把 `locale: en` 寫進 fleet.yaml，把 UI 語言釘成英文並關掉時區與語言的自動偵測。現在選單的第一個選項改為明確的**「自動（跟隨系統）」**，對應到「未設定」。只有使用者實際更改的欄位才會送到 API（`changedFields` 對比 baseline）；選擇「自動」時送出 `null`，讓伺服器移除該 key。
- **修正安全、權限與存取文件（#1275）。** 移除不存在的 IPC 共享金鑰握手與 Bash 拒絕名單，說明預設權限 bypass、持久化 access 優先序、分平台的指令管理員要求，以及 dashboard／公開 View／Host／agent token 的實際邊界。純文件，沒有修改執行行為。
- **kiro-cli 2.28.0 的「Classic is being deprecated」提示不再讓 legacy instance 卡在啟動（#1308）。** 2.28.0 在每次 Classic session 開始前都會詢問，即使是用 AgEnD 固定的 `--legacy-ui --agent-engine=v1` 啟動：「Switch to 3.0 and upgrade my agent configs」或「Remind me later」。AgEnD 以前認不得它，instance 就停在那裡。現在會回答「Remind me later」：先從「Switch to 3.0」往下移一格並確認游標真的移到了，只有看到游標停在「Remind me later」才按 Enter；其他情況都留給人處理並回報。絕不選「Switch to 3.0」：它會把 3.0 設成整台機器的預設並在 3.0 重新執行 session，是單向的。kiro 的 7 天暫緩期過後會再問。kiro-cli 2.27.x 沒有這個提示。
- **找 muse session 只讀前面的字、不再整檔讀進來（#1228）。** `MuseBackend.getSessionId` 與偵測 seam 的 `museFingerprint` 現在都走共用的 `readFileHeadSync`（開檔、串流解出前 65536 個字元、關檔），結果與整檔讀相同（算的是解出的字元數、不是 byte，多位元組開頭一樣找得到）。
- **Telegram 的投遞狀態不再覆蓋 agent 主動加的反應（#959）。** 系統會記錄 bot 唯一反應欄位的擁有者，並讓狀態與 agent 反應共用每則訊息的佇列。無法確認擁有者時（包括 adapter 被重建、或 API 回應不明），晚到的狀態就跳過；agent 選了跟舊狀態一樣的 emoji 也會保留。General fallback 投遞亦保留原始 chat/thread 資料，Discord topic 路由不變。
- **修正 `checkout_repo` 與 `get_usage` 工具描述（#1296）。** `checkout_repo` 的描述說「唯讀 worktree」及「接受 instance 名稱或絕對路徑」；實際上 handler（`daemon.ts`）拒絕非路徑的 source，且建立的是 detached HEAD worktree，並非強制唯讀掛載。`get_usage` 的描述只列了 Claude/Codex/Grok/Kiro，漏掉了 Muse 與 Antigravity。兩者已更正。讀取工具描述來決定用法的 agent 會看到錯誤資訊。
- **設定了 `context_guardian.max_age_hours` 或 `grace_period_ms` 時，現在會發出警告（#1296）。** 上下文自動輪換已移除；這兩個欄位保留在 schema 中以維持相容性，但沒有任何效果。設定其中一個現在會觸發驗證警告：「無效果；上下文輪換已移除」。
- **AgEnD 開始監看時剛好寫到一半的工具步驟不再遺失（#1250）。** #1221 讓 AgEnD 只讀到 CLI transcript 的最後一個完整行，但開始讀的位置仍然直接用檔案當下的大小。如果那一刻 CLI 正寫到一半（第一次接上、instance 重啟、投遞的 checkpoint），那筆記錄剩下的部分會被當成無法解析而跳過，它的工具進度也就不會出現。現在 Claude、Codex、Kiro 的這些起始位置都改為最後一個完整行。
- **Kiro 斷線 picker 通知恢復具體文字、interaction IPC 安靜了、死 gate 移除（#1219）。** 一般 `dialog` 種類的對話框（例如 Kiro 模型斷線 picker）通知恢復帶 code-owned 描述——「model unavailable、去選替代模型」——而不是籠統的「等你輸入」；特定種類（permission、login 等）維持分類文字。`publishInteraction` 不再每次觀察都重送沒變的 snapshot（按 phase/kind/reason/episode/stale/suspected 比對，時鐘欄位排除，最終狀態不會丟）。probe 前永遠到不了的 `delivery_idle_gate` 過期檢查刪除；probe 後真正會觸發的那道保留。
- **macOS 不再誤報記憶體警報（#1257）。** 在 Mac 上，AgEnD 不再發「主機記憶體吃緊」通知，也不再因記憶體而放慢或暫停啟動 agent。那裡的可用記憶體與 swap 數字不是記憶體壓力的訊號：macOS 會依需要增加 swap 檔，swap 接近用滿是正常的；一台 16 GB、還有 2.8 GB 可用的 Mac 卻被要求一次只啟動一個 agent。採樣數值仍會寫進 log。改用 macOS 自己的記憶體壓力等級記在 #1256。Linux 不變。
- **`agend-agent reply … --sticker` 與 MCP 的 reply 規則一致（#1254）。** `agent_mode: cli` 的 agent 若帶了此頻道送不出的貼圖（Discord 上別的伺服器的貼圖、或不是 Telegram 貼圖 id 的東西），現在會在送出任何東西之前先檢查，並以該則回覆的錯誤回報。以前是直接交給 adapter。另外，帶貼圖的回覆不再被當成同一段文字（不帶貼圖、仍在送出中）的重複回覆。兩條路徑現在用同一套方式判斷是否重複。
- **補回覆不再因為太早觸發而造成重複回覆（#1241）。** claude-code 上，回覆完成防線以前會在 agent 還在寫第一則回覆時、看到 pane 像閒置就觸發，把一則 `[system:reply-required]` 提示貼進 CLI，agent 之後又回答一次、變成回覆兩次。現在要回合「證明自己真的結束了」才會補救：第一次的閒置邊緣只會啟動 60 秒確認窗（之後又看到工作、有回覆送達、或取消都會解除），要閒置持續超過整個窗口、且一直沒有回覆，才會送出提示。從回合開始後完全沒觀察到工作、就出現的閒置邊緣，會直接按住不理。真的漏回還是會補（#750），最多晚一分鐘——而且補救提示現在會說：如果已經回過了，就什麼都不必做。
- **又看得到 Claude 的 API 重試了（#1239）。** Claude Code 重試失敗的請求時（`✻ 429 … · Retrying in 4s · attempt 4/10`），AgEnD 會發通知，並把這個回合當成仍在進行。從 #1101 起，這只在沒有 status line 的畫面上有效。有 status line 時（AgEnD 一律會設），Claude 不會在 footer 印 `esc to interrupt`，而判斷正是靠這行提示。所以進行中的重試被當成閒置、沒有通知，等很久的重試還可能在回合中途把取消按鈕收掉。現在改看那一列的位置：它在 spinner 的位置，緊貼在輸入框正上方。已結束、被中斷或被引用的那一列仍算歷史，最後的錯誤列（`Request rejected (429)`、重複 529、設定的金鑰無效）照舊認得。另外，工作目錄很長、讓 Claude 自己的 Bash 權限提示第二個選項換成兩行時，現在也會正確停住等人處理。
- **網頁登入頁的登入碼輸入框在 100% 縮放下就看得到（#1242）。** `/login` 開的網頁終端機，會在「Sign-in code」那一列出現之前先決定終端機大小，之後一直沿用：
  終端機最下面幾行（包括 CLI 的 `Paste code here` 提示）延伸到那一列底下並蓋住它。輸入框其實在，但看不到也點不到，要改變縮放、讓終端機重新調整大小才會出現。
  現在終端機自己的區域一有變化就重新調整，也不會畫出自己的區域，所以任何視窗大小下提示和輸入框都看得到。
- **切換 instance 的 backend 後不再啟動不了（#1217）。** session id 現在屬於產生它的 backend（旁邊記一個 `session-id.backend`）。換成另一個 backend 後第一次啟動時，舊 id 會被放到一旁（跟以前一樣是 `session-id.abandoned-<ts>`），新的 CLI 全新開始，而不是被要求去 resume 一段它從沒有過的對話。`update_instance_config` 改了 `backend` 時，執行中的 instance 現在會被重啟並全新開始。以前只會存下設定，舊 CLI 繼續跑，直到其他事情讓它重啟。另外三個讓這種失敗變成永久的缺口也一併補上：
  - 每個 backend 各自指定「session 已經不存在」的字樣，例如 muse 的「retained session not found」；
  - 未經證實的 resume 失敗次數改存在 instance 目錄裡、以 session id 為鍵。每次啟動都會建一個新的 Daemon，所以以前永遠停在「attempt 1/3」，到不了三次後的全新啟動；
  - 認得 Claude 的「Background work is running」退出提示。訊息投遞會等它結束；stop 與 pause 會用 Escape 取消它並停止程序，絕不選它的任何選項。
- **Discord slash 指令：較少出現「應用程式沒有回應」，而且不再靜默（#1231）。** slash 指令現在第一件事就是回應（acknowledge），
  其他讀取都在之後。回應失敗時不執行該指令（你已看到「沒有回應」，重試時若照樣執行會做兩次），並且會告訴你——私下回覆，或發在頻道。
  若同一個 bot 的另一個連線已經回應，這邊就保持安靜。超過 1.5 秒才回應時，log 會記下時間花在哪（送達 vs 回應本身）；fleet 會記錄每次
  1 秒以上的 event loop 卡住；設定驗證會在兩個連線共用同一個 bot token 時警告。調查結果（包括哪些不是原因：presence 更新、單純的訊息量）：
  `docs/design/1231-discord-slash-ack.md`。
- **等候輸入不再隱形（#812）。** `describe_instance`、`list_instances` 與狀態 API 會顯示確認過的 `awaiting_input`、原本的執行狀態及固定互動類別；第二次新 capture 才確認，超過 15 秒明確標成目前無法確認，不解除安全 hold。原生四選項 Claude Bash 權限視窗只保留給人處理，不送任何按鍵。弱終端提示仍只算疑似，不宣稱涵蓋 editor；500ms／15s 是 sandbox 驗過的策略值，尚非實機時序保證。
- **送進閒置 Claude / Grok / Muse instance 的訊息，不再只因為 pane 有輸出就記成 `delivered`（#758）。** 這些 CLI 沒有可讀的輸入列，過去只要 Enter 之後 pane 有任何輸出就算送出——而把 paste 洗掉的重繪也會產生輸出，outbox 因此對一則根本沒到的訊息記下 `delivered`。✅ 不變，但該列現在由 CLI 自己的 transcript 收尾：找到這則投遞的 marker → `delivered`（`transcript-marker`；CLI 只是排進佇列則為 `transcript-marker-queued`）；最後一次讀取成功、整整 10 秒 transcript 仍沒有 marker → `uncertain`（`unverifiable-no-transcript-marker`，會有 ⚠️ 與 `[system:delivery-outcome]`；不會重貼，訊息仍可能送達）；transcript 讀不到、或該 backend 沒有（Grok、Muse、Gemini…）→ 維持今天的 `delivered`，並標示 `output-edge-only; submission-unverifiable`。等待在 pane lock 放開後進行，但 fleet lane 與共用的 pump budget 會被 held 到結算（成功約一秒內收尾；真的掉失的 paste 至多佔 lane 約 10 秒）。steer、native-queue、Codex、Kiro 與 raw paste 不受影響。
- **讀 instance log 不再整檔讀進記憶體（#1206）。** `get_instance_logs` 過去會把 `output.log` 整檔同步讀進來才取尾段，多 MB 的 pipe-pane log 會卡住 event loop、可能撐爆 30 秒 IPC 上限。現在改成從檔尾往回 bounded chunk 讀（最多掃 1 MB、非同步），log 再大 I/O 也不會跟著長。在範圍內的 log 行數照樣精確；超過範圍的只回尾段、行數標 unknown 並附註說明。掃描窗口內完全沒有換行時回尾段並標 partial、不會回空。啟動時 pipe-pane 接不上去，現在會 warn、不再無聲消失。
- **Claude 分段寫入的 transcript 事件不再漏掉（#1221）。** 工具進度與活動紀錄會等該筆資料的結尾換行寫完，才推進讀取位置。跨次 poll 寫完的資料只讀一次，monitor 重啟後也能補讀；已完整換行的最後一筆仍立即顯示。Codex／Kiro 共用的 JSONL reader 使用同一個 byte 邊界，跨次寫入的 UTF-8 文字也保留完整。

## [2.1.11] - 2026-10-05

### 升級注意事項 (Upgrade Notes)
- **[行為變更] Codex「model is at capacity」現在改成叫它「繼續」，不再重啟（#905）。** 舊做法是 30 / 60 / 120 秒後重啟 instance，但重啟後的 Codex 停在空白 prompt，沒有人重送失敗的那一回合——「重試中」的通知承諾了從未發生的事，工作就卡在那裡。現在照舊通知使用者，約一分鐘後 AgEnD 對 agent 說「繼續」（keep going）：它的 context 還在、不用重讀、也不換模型。每次擁擠錯誤只送一次，而且只在畫面自上次起完全沒變時才送：畫面動了、有人在輸入、agent 自己開始做事、有訊息排隊、instance 被停止／暫停／重生或使用者取消，都會取消這次 nudge。計時用 monotonic clock（系統時間被調整不受影響）。nudge 之後又出現擁擠算新的一次。30 分鐘內最多送 3 次 nudge；之後再出現擁擠（第 4 次）才像以前一樣暫停。
- **[行為變更] `agend update` 會讓安裝留在原本的頻道；beta 版不會在沒有要求的情況下被換到穩定線。** 以前不帶旗標的 `agend update` 不管裝的是什麼都會安裝 `@latest`，所以 beta 版可能被裝回較舊的穩定版 —— 而 AgEnD 自己的更新通知還請 beta 使用者執行這個指令。現在它依照已安裝的版本決定：prerelease（`x.y.z-beta.N`，或任何 `x.y.z-<pre>`）從 `@beta` 更新，正式版從 `@latest` 更新。聊天裡的 `/update` 不再自己判斷（它讀的是自己程式旁邊的版本，source checkout 會讀到 `1.22.0`，只有包含「beta」字樣時才加 `--beta`）：現在一律執行 `agend update`，由已安裝的 CLI 決定。會回到較舊版本的更新會被拒絕，除非用 `--stable`、`--version` 或 `--force` 明確要求。新增 `agend update --stable`，可以把 beta 版切換到穩定版。beta 使用者收到「有較新的穩定版」通知時，會提示改用 `--stable`。更新會安裝它檢查過的那個確切版本（例如 `@songsid/agend@2.1.11-beta.3`，而不是中途可能被改指的 `@beta` tag）；`agend update --version <v>` 現在也能用了——以前它會被當成 `agend --version`，只印出版本、什麼都不安裝。
- **[行為變更] OpenCode instance 現在和其他 backend 一樣，啟動時不再跳權限確認。** OpenCode 在讀專案目錄以外的路徑（`Access external directory /tmp`）、讀 `.env`，或遇到你自己 config 設的 `ask` 時會先問；其他 backend 本來就有 skip-permissions 開關，所以 OpenCode instance 去讀 `/tmp/image.jpg` 會一直停在確認畫面等人按。AgEnD 現在啟動 OpenCode 時：該 binary 的 `--help` 有列 `--auto`（OpenCode 1.17 以後）就用它（每個 ask 自動回「once」，**你 config 裡明確的 `deny` 仍然有效**）；沒有的舊版**不加任何啟動開關**——它唯一的形式 `OPENCODE_PERMISSION` env 會蓋掉你自己的 `deny` 規則——改由執行期回答提示。**畫面上的 prompt 一律回「Allow once」**（只按一次 Enter、不留下任何記憶）；以前是按 Right+Enter＝「Allow always」。若已走到「Always allow」確認頁，按 Esc 取消回到 prompt。prompt 在畫面上時，該 pane 不接收投遞、也不會被當成卡住；agent 文字、輸入框草稿或 transcript 只是引用這個畫面，也不會再被送任何鍵。`skipPermissions: false` 可關掉啟動開關（執行期回答仍然啟用）。啟動準備中收到 stop 現在會取消該次啟動。
- **[行為變更] 移除舊的聊天室轉傳式 `/login` 模式（#1139）。** `login.mode: relay` 是 2.1.6 以前的登入方式（AgEnD 在 tmux 視窗裡操作登入 CLI，再把它的選單、授權連結與文字提示透過聊天室轉傳）；自 2.1.5 起 `/login` 預設就在有 token 保護的瀏覽器終端機進行，`/login code` 自 #1137 起也已沒有入口。**fleet.yaml 裡仍設有 `login.mode: relay` 時照常載入**——設定會被忽略，log 裡留一則警告，請移除。`/login` 的其他行為（瀏覽器終端機、device-code、公開連結）與安裝 CLI 都不變。升級前留在聊天室的登入方式選單按鈕，升級後點擊會回應「已過期」。

### 新增 (Added)
- **CLI 對話框不理會 AgEnD 的自動回答時，現在約 15 秒內就會通報，所有 backend 都適用。** AgEnD 回答執行期對話框（權限提示、信任提示、選單）的方式是按它的鍵；若按完鍵後**同一個**對話框（逐字完全相同的請求——OpenCode 由 prompt 區塊辨識請求，所以周圍跳動的狀態列不影響；其他 CLI 比對整個畫面；任何無法解釋的差異都不算證據）仍在畫面上，連續三次，就對該 instance 的 topic 與 fleet 通報一次（「不接受 AgEnD 的自動回答……請手動回答」，若同時保留了投遞會註明）。以前會保留投遞的對話框要等一分鐘才通報，不保留投遞的（kiro trust、muse/grok 工具核准、agy 問卷）則完全不通報、只是每 5 秒重答一次直到永遠。通知只含對話框的固定描述和次數，絕不含 pane 內容，且每個「事件」只發一次（對話框消失後又有新的忽略才會再發）。被回答後又出現的新提示（連續的工具提示，或下一個內容不同的排隊請求）不算卡住，也會重置一分鐘的 parked 計時，而不是沿用舊的。限制：兩個長得完全一樣、前後相接的請求，光看畫面無法區分，會被當成「回答被忽略」；CLI 無法指認請求、畫面又自己在變（例如跳動的計時器）時，兩個方向都不構成證據：這項檢查不通報，而會保留投遞的對話框原有的一分鐘 parked 通報照常計時（只有對話框消失、或 CLI 明確指出是不同請求，才會重設該計時）。通報之後 AgEnD 不會停止回答：同一個請求只會每 30 秒回答一次（原本每 5 秒）——長得像的排隊請求仍會逐一被回答，只是變慢；真的被忽略的對話框則被按得少很多；不同的請求、對話框消失或 instance 重生就恢復正常速度並重新計數。
- **kiro-cli 無法再執行某個 kiro instance 時，General 會收到通知。** 已安裝的 kiro-cli 拒絕照設定執行 kiro instance（#1109）時 —— 不論是啟動時，或 kiro-cli 自我更新後的 respawn —— 每個 General 現在都會以 agent 身分收到 `[system:kiro-incompat]`：哪些 instance 停了、kiro 的原因、它們的對話都還在，並請它載入新的 `kiro-engine-migration` skill。ClassicBot 的 kiro instance 也算在內。這則通知會在 delivery outbox 保存最多 14 天，直到每個 General 收下為止（同一個 kiro-cli 可能也讓 General 停了；一般訊息維持 24 小時），同一種拒絕每天只送一次。給操作者的純文字通知不變。
- **`kiro_engine_status` 工具**（唯讀；worker、standard、general profile 皆可用）：每個 kiro instance（含 ClassicBot）的 `kiro_ui` 與 credential profile、下次啟動會用的 engine 參數或 kiro 拒絕的原因、AgEnD 為它準備過的啟動（每次變更的 kiro-cli 與 AgEnD 版本，取自 engine 帳本），以及它的 V3 session。它不會執行任何程序：只讀取上一次 kiro 啟動時探測到的 kiro-cli 相容資訊，並註明是何時探測的。
- **給 General 的 `kiro-engine-migration` skill：** kiro 不相容代表什麼、停下的 instance 對話完好、該怎麼跟使用者說明，以及絕不能做的事（重啟它來「再試一次」、改 `kiro_ui`、自己執行 kiro-cli、動 `~/.kiro`）。遷移本身目前還不能用，skill 也會如實說明。
- **kiro engine 帳本：之後 V1 → V3 遷移的基線。** 每次啟動 kiro 都會記進 `<data dir>/kiro-engine-ledger.json`（僅擁有者可讀寫）：instance 的工作目錄與 credential profile、kiro-cli 版本、AgEnD 版本、UI 與 AgEnD 鎖定的 engine 參數 —— 保留最近一次啟動，外加每次變更一筆歷史。它放在 instance 目錄之外，所以 `replace_instance` 不會把它清掉。它絕不會擋下啟動：寫不進去就略過。
- **V3 的 kiro instance 只會依 id 接回自己擁有的 V3 session。** kiro 在 V3 上的 `--resume` 會從任何 engine 挑該目錄最新的對話，碰到 classic 對話就每次啟動都轉出一份新的 V3 副本。現在 V3 instance 會先全新開始，下一次啟動才接手那次全新啟動建立的 session —— 而且只在確定時才接手：建立時間晚於全新開始、沒有人擁有（擁有權是 `<data dir>/kiro-v3/` 底下的獨占 claim）、同一目錄也沒有其他 V3 instance 在等著接手自己的 session。之後在仍持有 claim 時依 id 接回那個 session；略過 resume 會放棄它。全新開始會在啟動前先記錄下來，記錄不了就拒絕這次啟動，免得之後又接回已放棄的 session。任何不確定的情況都會再全新開始，所以共用工作目錄的兩個 V3 instance 會各自全新開始。classic 對話只會經由明確的遷移進入 V3。`kiro_ui: v3` 本身在 V3 能無人值守之前仍會被設定驗證拒絕（#849）。

### 修正 (Fixed)
- **取消也會停止補回覆（#1199）。** 取消按鈕與 `/cancel` 現在會在中斷 CLI 前標記目前的人類對話回合，使用者主動停止後不再跳出漏回覆警告，也不會要求 agent 再補一個結論。已在送出的回覆仍正常結算，新訊息仍有自己的回覆防線；取消後才回報失敗的補救或成功的舊 paste 都不會重新啟動該回合。
- **重啟後不再重送已經送達的 Claude Code 訊息（#1205）。** 重啟後 daemon 會到 CLI 的 transcript 找每個進行中投遞的 marker，而且只有出現在 user 條目最開頭的 marker 才算。Claude Code 會把每則貼上的訊息存成 `<pasted_content id="…">` 加上原文，所以 marker 從來不在開頭、也從來找不到：已送達的訊息被當成「transcript 完整、沒有 marker」，舊 CLI 又已不在，於是被重試——同一則訊息送了兩次。現在在 marker 前面只接受 CLI 自己的這個 wrapper（確切格式、僅限 Claude Code），marker 在 wrapper 之後仍必須領頭；任何其他前綴、引用、或其他 backend 的條目仍不算。
- **Codex 0.159.2 與 0.160.0 的「Selected model is at capacity」重新能被偵測（#1208）。** 這兩個版本把該拒絕訊息印成 `■ Selected model is at capacity. Please try a different model.`，但偵測規則是照 `⚠` 寫的，所以容量通知從沒出現、「繼續」提示也沒武裝，回合只是落到一般的「沒回覆」流程。現在行首只要是任一個狀態符號（`■`、`⚠`、`⚠️`…）都算；項目符號、破折號、引用符號、數字仍不行，而且整句仍必須獨佔一行、從第 0 欄開始，所以提到模型容量的一般文字不會觸發。只改偵測——比對成功之後的行為不變。
- **Telegram ClassicBot 的 `/start` 回覆改成請你 @bot 對話（#1196）。** 「Agent 已啟動」與「已有活動中的 Agent」原本以 `/chat` 開頭，那是 Discord 的用法；在 Telegram 上是 @ClassicBot 來對話，回覆現在照實說。Discord 的回覆不變，送到 agent 的內容也不變。
- **送進忙碌中 Claude / Grok / Muse instance 的 steer 現在是 `delivered`，不再是 `uncertain`（#1197）。** 這些 CLI 沒有可讀的輸入列，而證明一般送出的「閒置→忙碌」邊緣在本來就忙碌的 pane 上不可能出現，所以每個 durable steer 都落在 `uncertain`——操作者看到 ⚠️、寄件者收到 `[system:delivery-outcome]`，但 steer 其實已送達（不是 IPC 逾時：`send_to_instance` 立刻回傳，沒有任何東西在等）。現在 steer 只要在成功的 Enter 之後，pane 上出現它自己可信的 `message_id`（次數多於貼上前）、沒有對話框、spawn 與視窗都沒變，就是 `delivered`，證據為 `steer-accepted-marker-on-pane; input-row-unreadable`：已進入進行中回合的輸入，不代表模型已讀（`delivery_status` 本來就顯示 `delivery_mode: steer`）。證據不足仍是 `uncertain`。另外：steer 的橫幅現在放在 delivery marker 之後而不是之前，重啟後可以從 CLI transcript 證明 steer。
- **Codex 長時間執行、畫面沒有新內容的回合，不再被誤判為卡住（#1188）。** 即時狀態列自己的經過時間計數（`• Working (5m 51s • esc to interrupt)`）現在算作存活證明：只要計數自上次檢查後有前進，不論畫面其他部分多久沒變，該回合都維持「工作中」。以前 10 分鐘卡住判斷會把「畫面變了」蓋上最後一次輸出事件的時間——已經是幾分鐘前——於是健康的長回合被標成卡住（hang 通知，接著重啟嘗試，而原本的 process 其實還活著、重啟「逾時」）。計數整個 stuck 逾時都停住的畫面仍會被判為卡住。另外：daemon 的「最後變動」時間不會倒退，卡住 deadline 改依最近的存活跡象，不會立刻重複觸發。
- **#978 閒置逃生閥不再把被引用的「esc to interrupt」當成正在執行（#991）。** 它現在和 daemon 其他地方用同一個精準的即時狀態列比對（任何標題、整行、行首）：真的狀態列仍會擋住，縮排引用或回覆文字中提到則不會。
- **反覆當機後，重新啟動現在會遵循「不要續接」的復原指示（#835）。**
  daemon 先讀取復原指示再清除；尚未讀取就失敗或被取代的啟動會保留它。
  正常啟動仍照原本方式續接對話。
- **帶有原生 `Goal achieved (…)` 狀態的 Codex footer 又能被辨識了（#1190）。** Codex 0.159.2 會在 context 項目和警告之間畫出 Goal 狀態（`Context 32% left    Goal achieved (1h 6m)    ⚠ 1 warning · f2 to view`）；「Context 開頭」的 footer 文法沒有它的位置，於是閒置 composer 證明不了、stranded-input 復原用盡，送給該 instance 的訊息失敗（`Idle footer not recognised` / `retries exhausted`）。現在 context 項目之後、以欄位間距隔開的內容一律視為 footer 的一部分，不論 Codex 叫它什麼、用什麼語言（`Goal achieved (1h 6m)`、`Goal usage: 90 seconds.`、`Goal complete; time used: 90 seconds.`、`Goal 사용량: 45초.`，或尚未出現的新欄位）；Goal 欄位即使只隔一個空格也能辨識——不必再加 `session-id` 狀態項目。你自己設定的 `tui.status_line` 也套用同一條規則（`model · Context 46% left    Goal …`），其 readiness pattern 由同一份文法產生。草稿或對話內容中剛好以「Context 32% left」開頭的行仍不算 footer。
- **muse：取消之後的下一則訊息不再黏到被取消的那則後面（#829）。** 取消 muse 的回合時，muse 會把被中斷的 prompt 放回輸入框，
  而下一則投遞原本會直接貼在它後面，兩則被當成同一則送出，被取消的工作又跑一次。現在 AgEnD 在貼上前會先讀 muse 的輸入框，
  用 muse 自己的刪除鍵一次清一列、每次清完都確認畫面。只清「確實是 AgEnD 最近貼給同一個 CLI process 的內容」——逐字相同、
  換行只出現在 muse 自己折行的位置；只是長得像 AgEnD 訊息不算，看不到內容的 `[Pasted Content N chars]` 一律不清。其他內容一律不動並停止清除；清不乾淨或讀不到畫面也一樣——
  這次投遞失敗、可重試，絕不貼在原有文字後面。清除途中遇到停止、取消或重啟，就不再送任何東西。其他 backend 不會多送任何按鍵。
- **macOS 不會再把低 free RAM 誤判成記憶體壓力。** 改用有界非同步的 `vm_stat`／`sysctl` 估計可回收 RAM 與讀取 swap；首次或快取過期的啟動最多等兩秒，共用 30 秒快取。
  Mac 量不到時顯示 unknown，不警告也不降低啟動速度；Linux 行為不變。估計可能低估可回收 RAM；Mac 探測失敗期間暫無記憶體壓力保護。
  已在 Linux 用真實輸出 fixture 與 stub 測試，待 macOS 使用者 live 驗。需要 rollback 時可只退原生 probe 的第二個 commit，保留 unknown 放行政策。
- **`/login` 瀏覽器終端機不會再因為複製而中斷登入，並提示 code 要貼在哪。** 以前按 Ctrl+C 想複製連結，會送出中斷、結束 `claude auth login`（exit 130），之後的貼上與 Enter 都打在已結束的 session 上。
  現在所有 web 終端機在「有選取文字」時 Ctrl+C 是複製；登入頁在沒有選取時 Ctrl+C（與 Ctrl-C 按鈕）直接停用——取消仍用 Stop；安裝終端機保留 Ctrl+C。CLI 不會回顯你貼上的 code，看起來像沒反應：
  登入頁現在有一個 code 輸入框，一次送出 code 與 Enter 並告訴你已送出（code 不會被記錄）。伺服器拒絕的 code 會結束指令；頁面現在會說「code 被拒（過期、已用過、重複貼上或來自另一次嘗試）」並請你重新 `/login`，而不是只顯示「exited with code 1」。

### 安全 (Security)
- **Discord slash 指令現在遵循同一張指令表（#1148）。** 指令適用於哪些頻道、誰能使用，改由一個地方宣告（`src/command-table.ts`），不再散在兩份複製的 handler 裡；
  選單描述上的 🔒 由這張表產生，標籤不會再和規則不一致。它位於先前加入的授權關卡「後面」，只會收窄關卡放行的範圍。授權級別為：*任何人*、
  *頻道管理員*（fleet 頻道＝fleet admin；ClassicBot 頻道＝fleet admin **或** ClassicBot admin）、*fleet admin*、*ClassicBot admin*。行為變更：
  - ClassicBot 頻道的 **`/stop`** 在 Discord 上現在需要 ClassicBot admin，與 Telegram 一向相同。原本 Discord 上任何人都能用；只是 fleet admin、
    但不是 ClassicBot admin 的人，現在在 Discord 上不能再停止 ClassicBot 頻道（在 Telegram 上本來就不行）。
  - Discord 的 **`/compact`** 需要頻道管理員（原本標了 🔒，但在 Discord 上沒有任何檢查）。Telegram 不受此變更影響：ClassicBot 聊天仍要 ClassicBot admin，
    fleet topic 內則沒有檢查。
  - **`/save`** 需要「該頻道類型」的管理員（原本連 fleet 頻道也要求 ClassicBot admin，導致 fleet admin 被拒、ClassicBot admin 反而能貼進 fleet instance）。
  - ClassicBot 頻道的 **`/pause`、`/wake`、`/collab`** 在 Discord 上現在也接受 fleet admin（原本只收 ClassicBot admin）。Telegram 不變：ClassicBot 的
    `/pause`、`/wake` 仍需 ClassicBot admin。
  - **`/start`** 兩個平台都沒有變，表中也不再寫成「任何人」：Discord 只看 guild allowlist；Telegram 私聊看使用者 allowlist，群組則要群組 allowlist **加上**
    ClassicBot admin。表中把它標為由 handler 自行判斷。
  - 表中新增 Telegram 欄，記錄 Telegram handler 與 Discord 不同的格子，並有測試（`tests/command-gates-by-platform.test.ts`）以真實 Telegram handler 對照。
  - **`/stop` 與 `/dashboard` 現在會顯示 🔒**；`/model`、`/effort`、`/clear` 與各 admin 指令，對原本能用的人沒有變化。
  - 在不適用的地方輸入的指令（例如沒有 agent 的頻道輸入 `/ctx`）會在執行任何東西之前，用一行說明拒絕；已不存在的指令會得到回覆，而不是「應用程式沒有回應」。
  文字輸入的 `/指令`（相對於 slash 指令）由後續變更處理。
- **Discord slash 指令現在要先過授權關卡（#1148）。** AgEnD 的 slash 指令是全域註冊的，所以 bot 所在的每個 guild、每個 DM 看到的選單都一樣，
  描述裡的 🔒 只是標籤。過去 slash 指令會略過保護「同樣文字訊息」的 allowlist，也不看來自哪個 guild 或 DM（只有 `/start` 會看）：
  只要和 bot 同在任一伺服器，就能對 fleet instance 下 `/steer`、`/compact`、`/cancel`，或讀 `/sysinfo`。現在在任何指令執行前：
  **DM 一律拒絕**；來自**其他 guild** 的指令只對已註冊的 ClassicBot 頻道與 `/start`（仍檢查 `allowed_guilds`）有效；在 fleet 頻道裡，呼叫者必須是
  **文字訊息路徑也會理會的人**——該頻道 instance 所屬 adapter 的存取政策（明列的 fleet admin 一律可以）。ClassicBot 頻道維持對所有人開放。
- **`/update`、`/doctor`、`/dashboard` 與 fleet 頻道裡的 `/collab` 現在要求「指令所經 adapter」的 fleet admin，且空的 `allowed_users` 代表沒有人。**
  它們過去讀的是*主要*頻道的清單（`channels[0]`，不是實際使用的 adapter），而且 `/update`、`/doctor`、`/collab` 把空清單當成「所有人」——
  所以沒設清單的 fleet 上，任何能輸入 slash 指令的人都能在主機上執行 `agend update`；但文字版 `/update` 卻把空清單當成「停用」。現在 slash 與文字一致。
  **若你依賴這些指令，請把自己列進該 adapter 的 `access.allowed_users`。**

## [2.1.10] - 2026-10-03

### 升級注意事項 (Upgrade Notes)
- **[行為變更] 一鍵開啟 `/login` 公開連結——AgEnD 會自己取得 cloudflared（#1137）。** kiro-cli 與 claude-code 的登入確認現在不需任何設定就會提供 **我了解（外網臨時連結）**、**我了解（內網）**、**取消**：不必再設定 `web_terminal.tunnel.allow_public`，而 `allow_public: false` 改為這台主機關閉公開連結的開關（不顯示按鈕、不下載任何東西）。按下公開連結按鈕仍是每次登入的同意，同意文字也會警告：在登入結束前，任何拿到連結和 token 的人都能使用這個登入終端。如果 `PATH` 上沒有 `cloudflared`，AgEnD 會把 Cloudflare 官方版本下載到 `~/.agend/bin`（不需要 sudo，不安裝到系統）：固定版本、比對固定的 SHA256，每次使用前再檢查；不符就刪除、什麼都不執行。支援 Linux（x86-64、arm64、arm、x86）與 macOS。取得不到 cloudflared 時不會開啟任何東西，仍可使用內網連結。公開連結的其餘部分不變：連結與 token 分兩則私訊、失敗即關閉、有時間限制、不寫入 log。Discord 與 Telegram 都一樣。
- **[行為變更] `/install-cli` 已移除：`/login` 會先安裝缺少的 CLI，再接著登入（#1131）。** 「讓這個 CLI 能用」只需要一個指令，所以有多個 AgEnD bot 的 guild 每個 bot 只顯示一個入口，也不會再打錯（`/install`、`/login-cli`）。`/login` 的選單會列出 fleet 可以安裝或登入的每個 backend，並標明點下去會做什麼：已安裝的 CLI 直接登入；未安裝的會先安裝（執行官方安裝腳本並確認在 PATH 上），完成後自動接著登入。`/login <backend>` 也一樣；`/login cancel` 也能停止安裝——只有這兩種用法（`/login code` 與短暫存在過的 `reinstall` 都已移除，#1137）。`opencode` 與 `muse` 可以安裝，但沒有登入流程；選單不列出 Gemini CLI，但 `/login gemini-cli` 仍可安裝它。Discord 的 slash 指令與 Telegram 選單中的 `/install_cli` 都已移除。在 2.1.10 直接輸入 `/install-cli`（或 `/install_cli`）仍可使用——它會說明指令已併入 `/login`，並執行 `/login <backend>`——這個別名會在 2.1.11 移除。
- **[行為變更] grok 改為在聊天室給代碼登入；claude-code 也可以使用公開連結（#1137）。** `grok login` 是裝置代碼登入（grok 1.0.46 只會顯示網址和代碼，然後等待），所以 `/login grok` 現在會像 codex 一樣把網址和代碼貼在聊天室，不再開瀏覽器終端。grok 1.0.46 回報的「Signed in as …」也重新能被辨識為登入成功。claude-code 的登入需要把代碼貼回它的終端，所以要從手機完成就得能連到那個終端：公開連結（`web_terminal.tunnel.allow_public`）現在除了 kiro-cli 也提供給 claude-code。
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

### 安全 (Security)
- **instance 目錄改為 0700（既有的在啟動時一次性修正）。** `<data dir>/instances/<name>` 裡有 `agent.token` 與 IPC socket，
  卻是用行程 umask 建立的 —— 通常是 0775，也就是群組可寫、本機所有使用者都能穿越（裡面的檔案本來就是 0600，開著的是目錄這道門）。
  新建的 instance 目錄一律 0700；啟動時 fleet 會把 `instances` 目錄與其下每個 instance 目錄一次性收成 0700，只記一行 log，
  且不動裡面的任何東西（你放進去的檔案維持原權限）。symlink 與他人擁有的目錄不會被動，並會在警告中點名。
  過去每次啟動 instance 都出現、卻從沒人處理的「IPC socket parent directory is world-accessible」警告，現在只會在仍然開放且
  無法修正的目錄上、每個目錄報一次。**若有其他使用者或服務原本靠群組權限讀取 instance 目錄，請改為明確授權 —— 群組不再有權限。**（#1118）

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
